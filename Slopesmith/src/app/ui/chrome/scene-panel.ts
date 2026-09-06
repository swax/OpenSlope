import GUI from 'lil-gui';
import type { CourseKnot, CoursePath, V3 } from '../../../core/doc/types';
import type { EditDoc } from '../../../core/doc/doc-edit';
import { seatRunOnTerrain } from '../../../core/doc/course';
import { clampKnotProfile, KNOT_LIMITS, profileWarnings, shapeRunIntoTerrain } from '../../../core/doc/run-shaping';
import {
  DEFAULT_LAPS, DEFAULT_SHOWOFF_SECONDS, MAX_CHECKPOINT_BONUS_SECONDS, MAX_LAPS, MAX_SHOWOFF_SECONDS,
  normalizeCheckpointBonus, normalizeLaps, normalizeShowoffSeconds,
} from '../../../core/doc/race';
import { clearGui, detail, note, tip, warningBanner } from '../components/gui';
import { tooltip } from '../components/tooltip';
import { toast } from '../components/toast';
import {
  auditionBoardSound, auditionCustomMusic, auditionEnvironmentBed, boardSoundAuditionActive, boardSoundAuditionPlaying,
  onBoardSoundAuditionChange, stopAudition,
} from '../components/audition';
import { normalizeRaceMusicArrangement } from '../../../core/music/arrangement';
import { BOARD_AUDIO_GROUPS, boardAudioGroup, boardGlideSlot, normalizeBoardSound } from '../../../core/audio/board-sound';
import { DEFAULT_ENVIRONMENT_BED, normalizeEnvironmentBed } from '../../../core/audio/environment';
import {
  leavesSceneSound, sceneBackTarget, sceneBoundsVisibility, sceneFolderVisibility, type SceneSel,
} from './scene-navigation';
import { MODE_ICON } from '../components/icons';
import { fetchJson } from '../../net/fetch-json';
export type { SceneSel } from './scene-navigation';

/**
 * The Scene-mode toolbox (right dock): a small category launcher above one focused comparison at a time.
 * Reference is the landing view; Lighting, God Rays, Sound, Skybox and Course put the authored mountain first and
 * the loaded Reference directly beneath it. Escape returns from any focused category to Reference, mirroring the
 * way a selected Edit detail returns to its launcher.
 * rebuildTools swaps this whole block in/out per mode, so there's one panel and no per-mode gating here.
 *
 * A mountain has exactly one run, and it can't be added or removed — the export rides it (CoursePath). It's a
 * LINE through the mountain, never a shape cut into it: it exports as the AIP path, straddles the start gate
 * at knot 0, and seeds the test ride. The net is shaped in Edit / Sculpt — and by *shape run into terrain*,
 * which presses the selected knots' floor / wall / bank / shoulder profile into the mesh once, on request
 * (core/doc/run-shaping). That is a command, not a modifier: the mesh owns the result afterwards.
 *
 * The panel owns its own view state (which category is selected and whether the launcher is folded) and the
 * paired detail folders. The sun / reference / sky subsystems fill their existing
 * folder handles, so this panel only decides which Mountain + Reference pair is visible. The document
 * selection (the `selected` knot) lives in the host store and is read / written through the injected getter
 * + setter.
 */

export type ScenePanelDeps = {
  getDoc: () => EditDoc;
  getSelected: () => number | null;      // the selected knot on the run
  setSelected: (i: number | null) => void;
  getSelectedKnots: () => number[];      // Info marquee selection for bulk course-point deletion
  setSelectedKnots: (indices: number[]) => void;
  scheduleRebuild: () => void;
  surfaceOptions: Record<string, number>; // "<num> <label>" -> surface id, for the base ride-feel dropdown
  isSceneActive: () => boolean;            // Scene's panel is the active editor mode (not merely retaining state)
  onSelectionChange: () => void;           // synchronize category-scoped viewport previews
  showOwnBox: (on: boolean) => void;      // frame the authored mountain on Scene's Reference landing view
  showRefBox: (on: boolean) => void;      // frame the reference on Scene's Reference landing view
  hasReference: () => boolean;            // a reference level is loaded (its lighting study exists)
  getReferenceName: () => string;         // loaded comparison level name; empty before one is chosen
  getCourseVisible: () => boolean;        // shared authored Course + reference SOP/AIP visibility
  setCourseVisible: (on: boolean) => void;
  getNormalsVisible: () => boolean;       // pink back-face tint that exposes the surface-normal direction
  setNormalsVisible: (on: boolean) => void;
  getAiPathsVisible: () => boolean;       // shared authored AI lines + reference AIP-network visibility
  setAiPathsVisible: (on: boolean) => void;
  genTerrainDialog: () => void;           // open the generate-terrain-from-run dialog (owned by ui/dialogs)
};

export function createScenePanel(deps: ScenePanelDeps) {
  const { getDoc, getSelected, setSelected, getSelectedKnots, setSelectedKnots,
    scheduleRebuild, surfaceOptions, isSceneActive, onSelectionChange, showOwnBox, showRefBox,
    hasReference, getReferenceName, getCourseVisible, setCourseVisible, getNormalsVisible, setNormalsVisible,
    getAiPathsVisible, setAiPathsVisible, genTerrainDialog } = deps;

  let sceneSel: SceneSel = 'info';
  let sceneCollapsed = false; // the whole Scene content (tree + details) folds away from the SCENE header

  const coursePath = (): CoursePath => getDoc().course;
  const mountainName = (): string => getDoc().name.trim() || 'Mountain';
  const referenceName = (): string => getReferenceName().trim() || 'Reference';
  const referenceHeader = (): string => {
    const name = getReferenceName().trim();
    return name ? `Reference: ${name}` : 'Reference';
  };

  const sceneHost = document.createElement('div'); // the Scene-mode toolbox: category launcher + paired detail gui
  // Match every other tool panel: size to the launcher + current detail, but shrink within the dock and let the
  // detail GUI scroll when a genuinely tall category (Lighting / Skybox) reaches the viewport bottom.
  sceneHost.style.cssText = 'display:none; flex-direction:column; min-height:0; max-height:100%; flex:0 1 auto;';
  document.getElementById('dock-right')!.appendChild(sceneHost); // appended before rightGui (created later) — order is moot, one shows at a time
  const outliner = document.createElement('div');
  outliner.className = 'sp-outliner';
  sceneHost.appendChild(outliner);
  // Title is blank: the root bar is just a slim break between the tree and the details (not a collapse
  // control - the whole panel collapses from the SCENE header, and the sub-folders are labels, not toggles).
  const sceneGui = new GUI({ autoPlace: false, title: '' });
  sceneGui.domElement.classList.add('sp-scene-gui'); // scopes the label-only-folders / blank-title styling to this gui
  sceneHost.appendChild(sceneGui.domElement);
  // The landing category is only the reference picker. Every study category is an adjacent comparison:
  // Authored mountain first, reference second (with a selected-knot subpanel inside the authored Course side).
  const refFolder = sceneGui.addFolder('Reference');         // landing view: read-only comparison picker
  const sunFolder = sceneGui.addFolder(mountainName());      // Lighting: authored sun
  const lightFolder = sceneGui.addFolder(referenceHeader());// Lighting: recovered reference study
  const godRayFolder = sceneGui.addFolder(mountainName());   // God Rays: authored World.json controls
  const refGodRayFolder = sceneGui.addFolder(referenceHeader());// God Rays: loaded World.json readout
  const soundFolder = sceneGui.addFolder(mountainName());    // Sound: authored race music
  const refSoundFolder = sceneGui.addFolder(referenceHeader());// Sound: shared rider cue + reference PathFinder study
  const skyPreviewFolder = sceneGui.addFolder('Preview');    // Skybox: shared world + presentation-effect preview
  const skyFolder = sceneGui.addFolder(mountainName());      // Skybox: authored backdrop
  const refSkyFolder = sceneGui.addFolder(referenceHeader());// Skybox: loaded level's backdrop
  const courseFolder = sceneGui.addFolder(mountainName());   // Course: authored run + shared overlays
  const selFolder = sceneGui.addFolder('Selected knot');     // Course: selected authored course point(s)
  const refCourseFolder = sceneGui.addFolder(referenceHeader());// Course: recovered line + borrow action
  for (const folder of [refFolder, sunFolder, lightFolder, godRayFolder, refGodRayFolder, soundFolder,
    refSoundFolder, skyPreviewFolder, skyFolder, refSkyFolder, courseFolder, selFolder, refCourseFolder])
    folder.domElement.classList.add('sp-scene-card');
  for (const folder of [refFolder, lightFolder, refGodRayFolder, refSoundFolder, refSkyFolder, refCourseFolder])
    folder.domElement.classList.add('sp-scene-reference');

  const categories: Array<{ value: SceneSel; label: string | (() => string); icon: string; title: string | (() => string) }> = [
    { value: 'info', label: 'Reference', icon: '◇', title: () => `Choose a read-only mountain to compare with ${mountainName()}.` },
    { value: 'lighting', label: 'Lighting', icon: '☀', title: () => `${mountainName()} sun controls followed by the ${referenceName()} lighting study.` },
    { value: 'godrays', label: 'God Rays', icon: '✺', title: () => `${mountainName()} god-ray settings followed by ${referenceName()}’s extracted settings.` },
    { value: 'sound', label: 'Sound', icon: '♫', title: () => `${mountainName()} race music followed by shared rider audio and the ${referenceName()} music graph.` },
    { value: 'skybox', label: 'Skybox', icon: '▣', title: () => `${mountainName()} skybox followed by the ${referenceName()} skybox.` },
    { value: 'course', label: 'Course', icon: '⌁', title: () => `${mountainName()} run controls followed by the recovered ${referenceName()} course.` },
  ];

  /** Rebuild the collapsible Scene header and its small category launcher. */
  function rebuildOutliner() {
    outliner.replaceChildren();
    const hdr = document.createElement('button');
    hdr.className = 'sp-out-hdr';
    const caret = document.createElement('span'); caret.className = 'sp-out-caret'; caret.textContent = sceneCollapsed ? '▸' : '▾';
    const modeIcon = document.createElement('span'); modeIcon.className = 'sp-mode-title-icon';
    modeIcon.setAttribute('aria-hidden', 'true'); modeIcon.innerHTML = MODE_ICON.info;
    const lbl = document.createElement('span'); lbl.textContent = 'Scene Mode';
    hdr.append(caret, modeIcon, lbl);
    hdr.onclick = () => {
      sceneCollapsed = !sceneCollapsed;
      if (sceneCollapsed && sceneSel === 'sound') stopAudition();
      applySceneCollapse();
    };
    outliner.appendChild(hdr);

    const list = document.createElement('div');
    list.className = 'sp-scene-categories';
    for (const category of categories) {
      const row = document.createElement('button');
      row.className = `sp-out-row${sceneSel === category.value ? ' on' : ''}`;
      row.setAttribute('aria-pressed', String(sceneSel === category.value));
      const icon = document.createElement('span'); icon.className = 'sp-out-ico'; icon.textContent = category.icon;
      const label = document.createElement('span');
      label.textContent = typeof category.label === 'function' ? category.label() : category.label;
      row.append(icon, label);
      tooltip(row, category.title);
      row.onclick = () => selectScene(category.value);
      list.appendChild(row);
    }
    outliner.appendChild(list);

    applySceneCollapse();
  }

  /** Fold the launcher + details away from the SCENE header, leaving just it. */
  function applySceneCollapse() {
    sceneGui.domElement.style.display = sceneCollapsed ? 'none' : '';
    const list = outliner.querySelector<HTMLElement>('.sp-scene-categories');
    if (list) list.style.display = sceneCollapsed ? 'none' : '';
    const caret = outliner.querySelector<HTMLElement>('.sp-out-caret');
    if (caret) caret.textContent = sceneCollapsed ? '▸' : '▾';
  }

  /** Show the reference picker, or the Mountain + Reference pair belonging to a study category. */
  function applySceneSelection() {
    for (const folder of [lightFolder, refGodRayFolder, refSoundFolder, refSkyFolder, refCourseFolder])
      folder.title(referenceHeader());
    const visible = sceneFolderVisibility(sceneSel, getSelected() !== null || getSelectedKnots().length > 0);
    refFolder.show(visible.info);
    sunFolder.show(visible.lighting);
    lightFolder.show(visible.lighting);
    godRayFolder.show(visible.godrays);
    refGodRayFolder.show(visible.godrays);
    soundFolder.show(visible.sound);
    refSoundFolder.show(visible.sound);
    // Preview target/layers are shared presentation state. Showing the same card in both categories makes a
    // glare comparison immediately visible without duplicating controls that could drift out of sync.
    skyPreviewFolder.show(visible.skybox || visible.godrays);
    skyFolder.show(visible.skybox);
    refSkyFolder.show(visible.skybox);
    courseFolder.show(visible.course);
    selFolder.show(visible.selection);
    refCourseFolder.show(visible.course);

    // A comparison category retains its Reference half even before a level is loaded. The empty card tells
    // the user where to establish that context instead of making the lower half mysteriously disappear.
    if (!hasReference()) {
      const empty = (folder: GUI, text: string) => {
        if (!folder.controllers.length && !folder.folders.length && folder.$children.childElementCount === 0) note(folder, text);
      };
      empty(lightFolder, 'Load a mountain in Reference to compare its lighting.');
      empty(refGodRayFolder, 'Load a mountain in Reference to compare its god-ray settings.');
      empty(refSoundFolder, 'Shared rider audio appears here; load a mountain in Reference to inspect its music.');
      empty(refSkyFolder, 'Load a mountain in Reference to inspect its skybox.');
    }

    const bounds = sceneBoundsVisibility(sceneSel, isSceneActive());
    showOwnBox(bounds.mountain);
    showRefBox(bounds.reference);
    onSelectionChange();
    rebuildOutliner();
  }

  /** Select a category; the Reference landing view frames both positionable worlds. */
  function selectScene(kind: SceneSel) {
    if (leavesSceneSound(sceneSel, kind)) stopAudition();
    sceneSel = kind;
    applySceneSelection(); // swap which detail folders are visible
  }

  /** Swap the whole Scene toolbox in or out with editor modes. A Sound preview belongs to the visible panel,
   *  so hiding Scene also tears down whichever shared audition that panel started. */
  function setSceneVisible(visible: boolean) {
    if (!visible && leavesSceneSound(sceneSel, null)) stopAudition();
    sceneHost.style.display = visible ? 'flex' : 'none';
  }

  /** Escape from a focused category returns to the default Reference launcher/detail. */
  function backToInfo(): boolean {
    const target = sceneBackTarget(sceneSel);
    if (!target) return false;
    selectScene(target);
    return true;
  }

  /** Rebuild every Scene detail folder + header (after New / Load / undo / course add-remove). */
  function rebuildScene() {
    for (const folder of [sunFolder, godRayFolder, soundFolder, skyFolder, courseFolder]) folder.title(mountainName());
    void buildSoundDetail();
    buildCourseDetail();
    rebuildOutliner();
  }

  let soundRequest = 0;
  let unsubscribeBoardAudition = () => {};

  /** Mountain Sound panel: choose one author-owned source plus the small arrangement contract that controls
   * how Snowknife maps it into the target course's donor PathFinder slot. */
  async function buildSoundDetail() {
    const request = ++soundRequest;
    unsubscribeBoardAudition();
    unsubscribeBoardAudition = () => {};
    if (boardSoundAuditionActive()) stopAudition();
    clearGui(soundFolder);
    soundFolder.title(mountainName());
    soundFolder.open(); // outer Scene card is a label; only its Sound subsections start collapsed
    note(soundFolder, 'Loading this mountain’s music…');
    try {
      const body = await fetchJson<{ tracks?: string[]; error?: string }>('/api/custom-music');
      if (body.error) throw new Error(body.error);
      if (request !== soundRequest) return;
      renderSoundDetail(body.tracks ?? []);
    } catch (e) {
      if (request !== soundRequest) return;
      clearGui(soundFolder);
      note(soundFolder, `Music library unavailable: ${e instanceof Error ? e.message : e}`);
      soundFolder.add({ refresh: () => void buildSoundDetail() }, 'refresh').name('↻ retry');
    }
  }

  function renderSoundDetail(tracks: string[]) {
    clearGui(soundFolder);
    const doc = getDoc();
    const environment = soundFolder.addFolder('Environment filler');
    const selectedEnvironment = normalizeEnvironmentBed(doc.environmentBed);
    const environmentState = {
      enabled: selectedEnvironment !== null,
      bank: selectedEnvironment?.bank ?? DEFAULT_ENVIRONMENT_BED.bank,
      volume: selectedEnvironment?.volume ?? DEFAULT_ENVIRONMENT_BED.volume,
    };
    const commitEnvironment = () => {
      stopAudition();
      getDoc().environmentBed = environmentState.enabled
        ? normalizeEnvironmentBed({ bank: environmentState.bank, volume: environmentState.volume })
        : null;
      scheduleRebuild();
    };
    tip(environment.add(environmentState, 'enabled').name('environment bed').onChange(commitEnvironment),
      'Use a quiet shared environment loop whenever the rider is off-board.');
    tip(environment.add(environmentState, 'bank', { 'Wind 1': 'Wind1', 'Wind 2': 'Wind2' })
      .name('source').onChange(commitEnvironment),
    'Which shared wind bank the bed plays.',
    'The selected AUDIO.BIG bank is written explicitly to Audio/Environment.json; neither consumer guesses '
    + 'from event 116/117.');
    tip(environment.add(environmentState, 'volume', 0, 1, 0.01).name('volume').onChange(commitEnvironment),
      'Map-authored gain for the off-board filler.');
    environment.add({ preview: () => auditionEnvironmentBed('authored-environment', environmentState.bank, 0,
      environmentState.volume) }, 'preview').name('▶ preview environment');
    environment.add({ stop: stopAudition }, 'stop').name('■ stop preview');
    note(environment, 'Fades out as race music fades in when the rider mounts.',
      'Export stages the selected loop and its Audio/Environment.json declaration.');
    environment.close();
    const intro = soundFolder.addFolder('Intro / ambient music');
    detail(intro, 'target course stems', 'source');
    note(intro, 'Owned by the target course chosen at pack time — not authored here.',
      'Load that course as Reference to inspect and preview its actual stems.');
    intro.close();
    const current = typeof doc.raceMusic === 'string' ? doc.raceMusic : '';
    const options: Record<string, string> = { '(none — target music)': '' };
    for (const track of tracks) options[track] = track;
    if (current && !tracks.includes(current)) options[`⚠ missing — ${current}`] = current;
    const arrangement = normalizeRaceMusicArrangement(doc.raceMusicArrangement,
      current ? 'retail-graph' : 'linear-loop');
    const state = { track: current, mode: arrangement.mode, bpm: arrangement.bpm,
      loopStart: arrangement.loopStartSeconds, loopEnd: arrangement.loopEndSeconds };
    const commitArrangement = () => {
      getDoc().raceMusicArrangement = normalizeRaceMusicArrangement({
        mode: state.mode, bpm: state.bpm, loopStartSeconds: state.loopStart, loopEndSeconds: state.loopEnd,
      }, 'linear-loop');
      scheduleRebuild();
    };
    tip(soundFolder.add(state, 'track', options).name('race music'),
      `Choose a source stored with ${mountainName()}; None keeps the target course’s retail music.`,
      'Export converts it to PCM16 WAV; ISO repack installs it into the selected target course.')
      .onChange((track: string) => {
        stopAudition();
        getDoc().raceMusic = track || null;
        if (track && !getDoc().raceMusicArrangement) commitArrangement();
        scheduleRebuild();
      });
    tip(soundFolder.add(state, 'mode', {
      'linear loop (MVP)': 'linear-loop',
      'retail adaptive graph': 'retail-graph',
    }).name('arrangement').onChange(() => { commitArrangement(); syncMode(); }),
    'Linear loop rewires the donor graph into sample order so the source plays continuously. Retail adaptive keeps the original branches and event jumps.');
    const bpmCtl = tip(soundFolder.add(state, 'bpm', 40, 300, 0.1).name('BPM').onChange(commitArrangement),
      'Song BPM written to MUSIC.INF — metadata only, not a bar slicer.');
    const loopStartCtl = tip(soundFolder.add(state, 'loopStart', 0, 3600, 0.1).name('loop start s').onChange(commitArrangement),
      'The source plays from its beginning once; after reaching loop end it returns to this time.');
    const loopEndCtl = tip(soundFolder.add(state, 'loopEnd', 0, 3600, 0.1).name('loop end s').onChange(commitArrangement),
      'Zero means the end of the source file. A positive value must be later than loop start.');
    function syncMode() {
      const linear = state.mode === 'linear-loop';
      bpmCtl.show(linear); loopStartCtl.show(linear); loopEndCtl.show(linear);
    }
    syncMode();
    soundFolder.add({ add: () => {
      const picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = '.wav,.mp3,.flac,.ogg,.m4a,.aac,audio/*';
      picker.onchange = () => void (async () => {
        const file = picker.files?.[0];
        if (!file) return;
        try {
          const saved = await fetchJson<{ name: string }>(
            `/api/custom-music?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
          getDoc().raceMusic = saved.name;
          getDoc().raceMusicArrangement ??= normalizeRaceMusicArrangement(undefined, 'linear-loop');
          scheduleRebuild();
          toast(`${mountainName()} music "${saved.name}" added.`, 'ok');
          await buildSoundDetail();
        } catch (error) {
          toast(`Music upload failed: ${error instanceof Error ? error.message : error}`, 'err');
        }
      })();
      picker.click();
    } }, 'add').name('⤒ add track…');
    note(soundFolder, tracks.length
      ? 'Linear loop plays the short donor streams in source order; retail adaptive preserves its original jumps.'
      : `Add a WAV, MP3, FLAC, OGG, M4A, or AAC to ${mountainName()}, then refresh.`);
    soundFolder.add({ preview: () => {
      const track = getDoc().raceMusic;
      if (!track) { toast('Choose a music track first.', 'warn'); return; }
      auditionCustomMusic(track);
    } }, 'preview').name('▶ preview source');
    soundFolder.add({ stop: stopAudition }, 'stop').name('■ stop preview');
    soundFolder.add({ refresh: () => void buildSoundDetail() }, 'refresh').name('↻ refresh library');
    renderBoardSoundDetail(soundRequest);
  }

  /** The board bed the test ride performs (docs/034): the mix over the shared zboard loops. The layer levels
   *  are performed by the ride itself from the surface and the ride signals [Trailmap: 420-audio-runtime], so
   *  what is authored here is the balance between them, not their loudness curve. */
  function renderBoardSoundDetail(request: number) {
    const board = soundFolder.addFolder('Board sound');
    const doc = getDoc();
    const mix = normalizeBoardSound(doc.boardSound);
    const commit = () => { getDoc().boardSound = { ...mix }; scheduleRebuild(); };
    tip(board.add(mix, 'enabled').name('board sound').onChange(commit),
      'Play the glide, carve, grind, and jump sounds while test riding.',
      'They come from the game’s own shared board bank, so your mountain sounds like the game.');
    tip(board.add(mix, 'volume', 0, 1, 0.01).name('volume').onChange(commit),
      'Master level for every board layer.');
    tip(board.add(mix, 'glide', 0, 1, 0.01).name('glide').onChange(commit),
      'The slide under the board — opens with speed, and its clip follows the surface.');
    tip(board.add(mix, 'carve', 0, 1, 0.01).name('carve').onChange(commit),
      'The edge bite — follows lean and sideways travel.');
    tip(board.add(mix, 'transients', 0, 1, 0.01).name('transients').onChange(commit),
      'Ollie pop, landing thud, and the rail grind — the board’s own one-shots.');
    // The game plays cue sounds from code on the pickup itself, not from a sound in the effect graph.
    tip(board.add(mix, 'cues', 0, 1, 0.01).name('cues').onChange(commit),
      'Gem chime, boost and trick pads, and the held-boost roar.');
    const preview = { surface: doc.baseSurface };
    let surfaceGroups: number[] | null = null;
    let routingLoaded = false;
    const routingNote = note(board, 'Loading surface-audio routing…');
    const updateRoutingNote = () => {
      if (!routingLoaded) { routingNote.textContent = 'Loading surface-audio routing…'; return; }
      const group = boardAudioGroup(preview.surface, surfaceGroups);
      const slot = boardGlideSlot(group);
      routingNote.textContent = surfaceGroups
        ? `Selected surface uses the ${BOARD_AUDIO_GROUPS[group]} glide loop (slot ${String(slot).padStart(3, '0')}).`
        : `No BoardSoundIndex.json extracted yet — the selected surface uses the neutral PACK fallback (slot 004).`;
    };
    let syncAuditionControl = () => {};
    tip(board.add(preview, 'surface', surfaceOptions).name('surface type').onChange(() => {
      if (boardSoundAuditionActive()) stopAudition();
      updateRoutingNote();
      syncAuditionControl();
    }),
      'Which surface’s glide loop to preview — audition-only, changes nothing.');
    const auditionControl = board.add({ audition: () => {
      if (!routingLoaded) { toast('Surface-audio routing is still loading.', 'warn'); return; }
      const slot = boardGlideSlot(boardAudioGroup(preview.surface, surfaceGroups));
      if (boardSoundAuditionPlaying(slot)) stopAudition();
      else auditionBoardSound(slot);
    } }, 'audition');
    syncAuditionControl = () => {
      const slot = boardGlideSlot(boardAudioGroup(preview.surface, surfaceGroups));
      auditionControl.name(boardSoundAuditionPlaying(slot) ? '■ stop sound' : '▶ hear surface');
    };
    unsubscribeBoardAudition = onBoardSoundAuditionChange(syncAuditionControl);
    syncAuditionControl();
    // The bank and its routing both come off disk, so describe only what this machine actually extracted.
    void fetch('/api/board-audio')
      .then(response => response.json() as Promise<{ board?: string | null; surfaceGroups?: number[] | null }>)
      .then(body => {
        if (request !== soundRequest) return;
        surfaceGroups = Array.isArray(body.surfaceGroups) ? body.surfaceGroups : null;
        routingLoaded = true;
        updateRoutingNote();
        if (!body.board) note(board, 'No zboard bank extracted yet — a test ride stays silent until one is.');
      })
      .catch(() => {
        if (request !== soundRequest) return;
        routingLoaded = true;
        updateRoutingNote();
      });
    board.close();
  }

  /** Mountain's Course panel. There is exactly one run, it can't be removed and it needs no name —
   *  the export rides it. The run is a LINE, not a terrain op: it becomes the exported AIP path, sets where
   *  the start gate straddles it, and seeds the test ride. The net is shaped in Edit / Sculpt. */
  function buildCourseDetail() {
    clearGui(courseFolder);
    courseFolder.title(mountainName());
    tip(courseFolder.add(getDoc(), 'baseSurface', surfaceOptions).name('base ride feel'),
      'Physics of every cell with no painted tile on it.').onChange(scheduleRebuild);
    // Stored only above the single-pass default, so an ordinary mountain's document says nothing about laps.
    const race = {
      laps: getDoc().laps ?? DEFAULT_LAPS,
      showoff: getDoc().showoffSeconds ?? DEFAULT_SHOWOFF_SECONDS,
    };
    tip(courseFolder.add(race, 'laps', 1, MAX_LAPS, 1).name('laps')
      .onChange((laps: number) => { getDoc().laps = normalizeLaps(laps); scheduleRebuild(); }),
      'Passes from the start gate to the finish that make a race.',
      '1 is the classic single run; above 1 a finish crossing sends you round again on the same clock. '
      + 'A lap-gated boost volume reads the same countdown — how MEGAPLEX’s finish tube throws a rider back '
      + 'up the mountain on every lap but the last. Travels to the game through the export.');
    tip(courseFolder.add(race, 'showoff', 0, MAX_SHOWOFF_SECONDS, 5).name('showoff clock (s)')
      .onChange((seconds: number) => {
        getDoc().showoffSeconds = normalizeShowoffSeconds(seconds); scheduleRebuild();
      }),
      'Seconds a showoff run starts with; checkpoints add time. 0 = no clock.',
      'A trick run is a countdown, not a stopwatch: the game seeds this many seconds and ends the run at '
      + 'zero. Retail seeds it per course from its executable (Garibaldi 120, most courses 90, Alaska 135), '
      + 'so an untouched mountain inherits whatever disc slot it is packed onto; set it and your number '
      + 'travels with the map instead.');
    const view = {
      get course() { return getCourseVisible(); },
      set course(on: boolean) { setCourseVisible(on); },
      get ai() { return getAiPathsVisible(); },
      set ai(on: boolean) { setAiPathsVisible(on); },
      get normals() { return getNormalsVisible(); },
      set normals(on: boolean) { setNormalsVisible(on); },
    };
    tip(courseFolder.add(view, 'course').name('show course').listen(),
      'Show the authored Course guide and the loaded reference mountain’s SOP/AIP path.');
    tip(courseFolder.add(view, 'ai').name('show AI paths').listen(),
      'Show the six AI lines your mountain exports (amber) and the loaded reference’s AI network (amber and violet).');
    tip(courseFolder.add(view, 'normals').name('show normals').listen(),
      'Show surface-normal direction by tinting each surface’s back, non-ridable side pink.');
    tip(courseFolder.add({ gen: genTerrainDialog }, 'gen').name('▼ generate terrain from run'),
      'Generate fresh terrain around the run. Replaces the terrain.',
      'Builds perpendicular random-height edges at course knots, bridges to the target patch size, smooths '
      + 'once, then seats the run.');
    tip(courseFolder.add({ seat: seatRun }, 'seat').name('⇩ seat run on terrain'),
      'Drop each course knot onto the current terrain surface.',
      'Sculpting moves the terrain, never the run — and the game spawns the field AT the exported gate '
      + 'heights, so a drifted line starts the race that far off the snow. Seating re-lands the gates, '
      + 'respawn path, race line and AI lines together.');
    tip(courseFolder.add(coursePath(), 'blend', 0, 200, 5).name('run blend (m)').onChange(scheduleRebuild),
      'How far past the shoulder the shaping fades back into the hill.',
      'Wide reads as a natural bench, narrow as a cut into the slope. Costs nothing until you shape.');
    tip(courseFolder.add({ shape: shapeRun }, 'shape').name('⌒ shape run into terrain'),
      'Press the run’s cross-section into the terrain and paint the floor strip.',
      'The opposite of seating: seating moves the LINE onto the hill, shaping moves the HILL onto the line. '
      + 'It writes heights once and the mesh owns them — sculpt freely afterwards and press again when you '
      + 'want the channel back. Locked patches are left alone.');
    tip(courseFolder.add({ reset: resetRaceEnds }, 'reset').name('⟲ reset start / finish to the run’s ends'),
      'Return the START and FINISH flags to the run’s own ends.',
      'Drag either flag in the viewport to place it somewhere else — how a lap course puts its grid partway '
      + 'down the loop and its finish before the tube, the way MEGAPLEX does.');
    tip(courseFolder.add({ ai: regenAiPaths }, 'ai').name('⟲ regenerate AI paths'),
      'Deal a new random hand of the six exported AI opponent lines.',
      'They re-derive on their own whenever the run changes; this only re-rolls the wander.');
  }

  /** Press the run's authored cross-section into the mesh (core/doc/run-shaping), then rebuild. A one-shot
   *  command: what it writes is ordinary terrain afterwards, and undo puts the old heights back. */
  function shapeRun() {
    const done = shapeRunIntoTerrain(getDoc());
    if (!done.moved && !done.painted) {
      toast(done.held
        ? `Every patch the run reaches is locked (${done.held} points held).`
        : 'The run reaches no terrain to shape — seat it on the mountain first.', 'warn', 5000);
      return;
    }
    toast(`Run shaped into the terrain — ${done.moved} points moved (largest ${done.maxAdjust.toFixed(1)} m)`
      + `${done.painted ? `, ${done.painted} floor patches painted` : ''}`
      + `${done.held ? `, ${done.held} held by locked patches` : ''}.`, 'ok', 5000);
    scheduleRebuild();
  }

  /** Drop the run's knots onto the terrain surface (core/doc/course seatRunOnTerrain), then rebuild —
   *  the markers, gates and AI lines all re-derive from the seated line. */
  function seatRun() {
    const moved = seatRunOnTerrain(getDoc());
    toast(moved > 0.05 ? `run seated on terrain — largest knot moved ${moved.toFixed(1)} m` : 'run already on the terrain', 'ok');
    refreshSelection();
    scheduleRebuild();
  }

  /** Forget both placed race endpoints, so start and finish derive from the run's own ends again. */
  function resetRaceEnds() {
    const course = getDoc().course;
    const had = !!course.start || !!course.finish;
    delete course.start;
    delete course.finish;
    toast(had ? 'start and finish back on the run’s ends' : 'start and finish were already the run’s ends', 'ok');
    refreshSelection();
    scheduleRebuild();
  }

  /** Re-roll the derived AI lines' seed (they re-derive from the run either way — this just re-deals the
   *  wander) and reveal the overlay so the new hand shows immediately. */
  function regenAiPaths() {
    getDoc().aiSeed = (Math.random() * 0x7fffffff) | 0;
    if (!getAiPathsVisible()) setAiPathsVisible(true);
    scheduleRebuild();
  }

  /** Rebuild the Selection inspector for the currently selected run knot. */
  function refreshSelection() {
    clearGui(selFolder);
    const sel = getSelected();
    const many = getSelectedKnots();
    selFolder.show(sceneSel === 'course' && (sel !== null || many.length > 0));
    selFolder.title(many.length ? `${many.length} selected points` : sel === null ? 'Selected knot' : `Knot ${sel}`);
    if (many.length) {
      note(selFolder, 'A profile edit writes every selected point; Delete removes the set.');
      addProfileControls(many);
      selFolder.add({ del: deleteKnot }, 'del').name(`x delete ${many.length} points`);
      return;
    }
    if (sel === null) { note(selFolder, 'Click a course point to edit it, or drag a box around several.'); return; }
    note(selFolder, 'Drag the selected point with the 3D move gizmo.');
    addProfileControls([sel]);
    selFolder.add({ add: addKnotAfter }, 'add').name('+ add point after');
    selFolder.add({ del: deleteKnot }, 'del').name('x delete point');
  }

  /**
   * The channel these knots ask the terrain for: a floor of some width, quarter-pipe walls at its edges, a
   * shoulder past them, and a bank rolling the section. Editing them changes NOTHING on its own — the run is
   * a line, and Course ▸ shape run into terrain is what presses the profile into the mesh. `width` is the
   * exception and always has been: it spans the start gate and bounds where the AI field may wander.
   *
   * The width slider's top end follows the value it finds, so a 400 m generated corridor is draggable at a
   * useful resolution without capping a run that was authored wider by hand.
   */
  function addProfileControls(indices: number[]) {
    const knots = coursePath().knots;
    const first = knots[indices[0]];
    if (!first) return;
    const state = { width: first.width, wall: first.wall, bank: first.bank, shoulder: first.shoulder };
    const write = (field: keyof typeof state) => (value: number) => {
      for (const i of indices) {
        const knot: CourseKnot | undefined = knots[i];
        if (knot) clampKnotProfile(Object.assign(knot, { [field]: value }));
      }
      scheduleRebuild();
    };
    // The warnings below are read off the numbers, so they are rebuilt when a drag ENDS rather than during
    // it — swapping the folder out from under a slider the pointer still owns would cancel the gesture.
    const live = (field: keyof typeof state, control: ReturnType<GUI['add']>) =>
      control.onChange(write(field)).onFinishChange(() => refreshSelection());
    const widthMax = Math.max(600, Math.ceil(state.width / 50) * 50);
    tip(live('width', selFolder.add(state, 'width', KNOT_LIMITS.width.min, widthMax, KNOT_LIMITS.width.step)
      .name('floor width (m)')),
      'Flat floor across the run here.',
      'Retail race channels run nearer 80–150 m; a chute reads at 60 and a plaza at 250. It also spans the '
      + 'exported start gate at the first point, and bounds the AI field to half of it — a narrow run keeps '
      + 'opponents on the snow as well as you.');
    tip(live('wall', selFolder.add(state, 'wall', KNOT_LIMITS.wall.min, KNOT_LIMITS.wall.max, KNOT_LIMITS.wall.step)
      .name('wall (m)')),
      'Quarter-pipe wall rising at each floor edge.',
      'Its lateral run matches its height, so 30 m is a 30 m-wide 45° berm you can carry speed round — and 0 '
      + 'is an open channel that just spills into the hill.');
    tip(live('bank', selFolder.add(state, 'bank', KNOT_LIMITS.bank.min, KNOT_LIMITS.bank.max, KNOT_LIMITS.bank.step)
      .name('bank (°)')),
      'Roll of the whole section about the line; positive raises the rider’s right.',
      'A left-hand bend wants a positive bank to hold the field in it. Walls roll with it, so a bank steep '
      + 'enough tips the downhill wall below the floor and the turn stops containing anything; the panel says '
      + 'so when it happens.');
    tip(live('shoulder', selFolder.add(state, 'shoulder', KNOT_LIMITS.shoulder.min, KNOT_LIMITS.shoulder.max,
      KNOT_LIMITS.shoulder.step).name('shoulder (m)')),
      'Near-flat lip carried beyond the wall tops before the blend takes over.',
      'The landing you get for overshooting a wall rather than the fall you get without one.');
    const checkpoint = { bonus: first.checkpointBonus ?? 0 };
    tip(selFolder.add(checkpoint, 'bonus', 0, MAX_CHECKPOINT_BONUS_SECONDS, 5).name('checkpoint bonus (s)')
      .onChange((value: number) => {
        const bonus = normalizeCheckpointBonus(value);
        for (const i of indices) {
          const knot = knots[i];
          if (!knot) continue;
          if (bonus === undefined) delete knot.checkpointBonus;
          else knot.checkpointBonus = bonus;
        }
        scheduleRebuild();
      }).onFinishChange(() => refreshSelection()),
      'Time awarded when the rider crosses this course-progress station; 0 makes it an ordinary knot.',
      'This exports as a type-11 event on the AIP/SOP race line and the SOP value is the number of seconds. '
      + 'It is not a collision volume and is not attached to a checkpoint sign: place or animate a sign beside '
      + 'the course separately if you want the retail visual. Add a course point first when the checkpoint belongs '
      + 'between the existing points.');
    // Amber, not a red failure: a spilled bank is a design fault the shaping will carry out faithfully.
    for (const warning of profileWarnings(first)) warningBanner(selFolder, warning);
  }

  function addKnotAfter() {
    const sel = getSelected();
    if (sel === null) return;
    const i = sel;
    const line = coursePath();
    const a = line.knots[i];
    const b = line.knots[i + 1];
    const pos: V3 = b
      ? [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2, (a.pos[2] + b.pos[2]) / 2]
      : [a.pos[0] + 80, a.pos[1] - 10, a.pos[2]]; // extend downhill (+X)
    const inserted: CourseKnot = { ...a, pos: [...pos] as V3 };
    // Profile values interpolate naturally into a new point; a checkpoint is a discrete station and must not
    // silently duplicate when an author inserts a point after it.
    delete inserted.checkpointBonus;
    line.knots.splice(i + 1, 0, inserted);
    setSelectedKnots([]);
    setSelected(i + 1);
    refreshSelection();
    scheduleRebuild();
  }

  function deleteKnot() {
    const sel = getSelected();
    const selected = getSelectedKnots();
    const requested = selected.length ? selected : sel === null ? [] : [sel];
    if (!requested.length) return;
    const line = coursePath();
    const limit = Math.max(0, line.knots.length - 2); // a spine and export both require two points
    const targets = [...new Set(requested)]
      .filter(i => i >= 0 && i < line.knots.length)
      .sort((a, b) => a - b)
      .slice(0, limit);
    if (!targets.length) { toast('A course needs at least two points.', 'warn'); return; }
    for (const i of [...targets].sort((a, b) => b - a)) line.knots.splice(i, 1);
    setSelectedKnots([]);
    setSelected(null);
    refreshSelection();
    scheduleRebuild();
    const kept = requested.length - targets.length;
    toast(`Deleted ${targets.length} course point${targets.length === 1 ? '' : 's'}${kept ? '; kept two required points' : ''}.`, 'ok');
  }

  return {
    sceneHost, sunFolder, godRayFolder, refGodRayFolder, skyPreviewFolder, skyFolder, refFolder, lightFolder,
    refSoundFolder, refSkyFolder, refCourseFolder,
    getSceneSel: () => sceneSel,
    setSceneSel: (s: SceneSel) => {
      if (leavesSceneSound(sceneSel, s)) stopAudition();
      sceneSel = s;
    }, // host resets state, then rebuilds the panel itself
    setSceneVisible,
    rebuildScene, rebuildOutliner, selectScene, backToInfo, applySceneSelection, refreshSelection, deleteKnot,
  };
}

export type ScenePanel = ReturnType<typeof createScenePanel>;
