import { note, tip } from '../components/gui';
import { segmented } from '../components/controls';
import { MAX_AI_RIDERS, MAX_VR_RENDER_SCALE, MIN_VR_RENDER_SCALE } from '../../state/store';
import { DRAW_DISTANCE_METRES, type DrawDistance } from '../../viewport/scene/range-cull';
import { AMOUNT_MAX, AMOUNT_PORT } from '../../../core/particles/snowfall';
import {
  DEFAULT_RIDER_MODEL_ID, ensureRiderModelCatalog, refreshRiderModelCatalog,
  riderModelCatalogSettled, riderModelOptions,
} from '../../ride/rider-models';
import {
  rideGearOptions, snowboardStanceOptions, type RideGear, type SnowboardStance,
} from '../../ride/gear';
import { ridingStyleOptions } from '../../ride/stances';
import { xrSupported } from '../../ride/xr/session';
import { XR_RENDER_SCALE_STEP, xrEyeBufferNote, xrScaleMayBeCapped } from '../../ride/xr/config';
import type { RaceMode } from '../../../core/doc/race';
import { toast } from '../components/toast';
import type { ToolsContext } from './widgets';
import { preferImmersivePlay, primaryPointerIsCoarse } from '../../ride/input-modality';

let characterImporting = false;
/** Whether this browser can present to a headset (docs/048): undefined until asked, then fixed for the tab. */
let xrAvailable: boolean | undefined;
let xrAsking = false;

/** Ask once, and rebuild the panel when the answer lands so its disabled launch state/options update in place. */
function resolveXrAvailable(then: () => void) {
  if (xrAsking) return;
  xrAsking = true;
  void xrSupported().then(supported => { xrAvailable = supported; then(); });
}

/**
 * The Test-mode toolbox (stored as `play`; docs/016): ride target/event/gear, Play / Watch / Stop, Position
 * (start/player navigation), avatar, conditional VR options, then ordinary Options, wired to the host's play controller.
 *
 * The panel's shape follows what a click means here. A slope click drops an AI rider and lets it go — that is
 * the everyday gesture, so it needs no button at all — while moving the ride start is rare enough to be an
 * explicitly armed one-shot down in its own section.
 */

/** Tools content in Test mode (docs/016): pick the mountain, event and gear; launch Play/VR/Watch; reset or
 *  place the start and jump to a live player in Position; choose the avatar; then tune VR and ordinary Options.
 *  What a reference ride draws follows
 *  the top-bar Props / Tricks filters (Props off = bare terrain, much faster). */
export function buildPlayTools(ctx: ToolsContext) {
  const { gui, store, viewport, propPreview, editSection, getPlay, getRefLevel, persistUi, rebuildTools } = ctx;
  const play = getPlay();
  const mountainName = store.mdoc.name.trim() || 'Mountain';
  const referenceName = getRefLevel().trim() || 'Reference';
  /**
   * Hand the keyboard back to the ride after using a control.
   *
   * The ride's key handler deliberately ignores events aimed at an `input`/`select` so that typing in a field
   * cannot also steer the rider. A lil-gui control keeps DOM focus once it has been used, so a dropdown or
   * checkbox touched mid-run goes on swallowing every key after it — steering silently dies for the rest of the
   * run. The controls below that call `rebuildTools()` escape this by accident, because the rebuild destroys the
   * focused element; the ones that don't have to say so.
   *
   * Only while a ride is actually running: in Play setup the panel *is* the thing being used, and pulling focus
   * off a control the moment it changes would break keyboard navigation for no gain.
   */
  const releaseKeyboard = () => {
    if (!viewport.riding && !viewport.watching) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.matches('input, select, textarea')) active.blur();
  };
  propPreview.hide();
  const canRef = viewport.canRideReference;
  if (!canRef && store.playTarget === 'reference') play.enterPlaySetup('authored', false);
  // Keep the ride target as an ordinary segmented button group rather than a tab strip or dropdown. Reference
  // stays in the pair when unavailable so the layout remains stable and its disabled state explains the option.
  const targetButtons = segmented<'authored' | 'reference'>(
    [
      { value: 'authored', label: mountainName, title: `Ride ${mountainName}, the mountain you’re building.` },
      { value: 'reference', label: 'Reference', title: () => canRef
        ? `Ride the loaded reference world — ${referenceName}.`
        : 'Load a reference level in Scene ▸ Reference to ride it.' },
    ],
    () => store.playTarget,
    target => play.enterPlaySetup(target),
  );
  targetButtons.setEnabled('reference', canRef);
  targetButtons.el.setAttribute('role', 'group');
  targetButtons.el.setAttribute('aria-label', 'Mountain to ride');
  const targetButtonRow = document.createElement('div');
  targetButtonRow.className = 'sp-gui-custom sp-play-target';
  targetButtonRow.appendChild(targetButtons.el);
  gui.$children.appendChild(targetButtonRow);

  // WHICH EVENT the run is, in the same shape as the target above it: where you ride, then what you are riding.
  // All three are the game's own modes (core/doc/race). The engine keeps ONE clock field and only showoff
  // reverses it; the same selection also previews the level's RaceMode / ShowoffMode / FreerideMode effects.
  const modeButtons = segmented<RaceMode>(
    [
      { value: 'freeride', label: 'Free ride',
        title: 'No event: no clock, nothing to run out. The default.' },
      { value: 'race', label: 'Race', title: 'Run the clock up from zero, the way a race times a descent.' },
      { value: 'showoff', label: 'Showoff', title: () =>
        `Count the clock down from the showoff seconds${store.playTarget === 'reference'
          ? '' : ` (Scene ▸ ${mountainName})`}; the run ends at zero.` },
    ],
    () => store.playRaceMode,
    mode => {
      store.playRaceMode = mode;
      viewport.raceMode = mode;
      persistUi();
      rebuildTools();   // the title above reads the live target, and a rebuild drops keyboard focus for the ride
    },
  );
  // A run latches its clock, rail set and effect world at launch. Mode changes are live in Test setup, but not
  // halfway through a ride/watch: that would produce a race clock over a show-off rail cache (or vice versa).
  const modeUnlocked = !viewport.riding && !viewport.watching && !viewport.xrPlaying;
  modeButtons.setEnabled('freeride', modeUnlocked);
  modeButtons.setEnabled('race', modeUnlocked);
  modeButtons.setEnabled('showoff', modeUnlocked);
  modeButtons.el.setAttribute('role', 'group');
  modeButtons.el.setAttribute('aria-label', 'Event to ride');
  const modeButtonRow = document.createElement('div');
  modeButtonRow.className = 'sp-gui-custom sp-play-target';
  modeButtonRow.appendChild(modeButtons.el);
  gui.$children.appendChild(modeButtonRow);

  // WHAT THEY STAND ON. A segmented pair rather than a dropdown, like the two rows at the top of the panel:
  // there are two, they are the same kind of thing, and which one is selected should be readable without
  // opening anything. Applied live to a running ride, which is the point — the same line at the same speed on
  // the other kit is the comparison worth having, and it is one click away rather than a restart. The deck is
  // drawn, not simulated, so ski physics is identical to the snowboard's: switching kit compares how a run
  // LOOKS, never how it rides.
  const gearButtons = segmented<RideGear>(
    rideGearOptions().map(option => ({
      value: option.id,
      label: option.label,
      title: option.id === 'skis'
        ? 'Ride skis. Identical physics to the snowboard — only the look differs.'
        : 'Ride a snowboard.',
    })),
    () => store.playRideGear,
    gear => {
      store.playRideGear = gear;
      viewport.rideGear = gear;
      persistUi();
      rebuildTools();   // the row reads the live selection, and a rebuild drops keyboard focus for the ride
    },
  );
  gearButtons.el.setAttribute('role', 'group');
  gearButtons.el.setAttribute('aria-label', 'Ride gear');
  const gearButtonRow = document.createElement('div');
  gearButtonRow.className = 'sp-gui-custom sp-play-target';
  gearButtonRow.appendChild(gearButtons.el);
  gui.$children.appendChild(gearButtonRow);

  // A snowboard adds one orthogonal choice directly under the kit: which anatomical foot owns the noseward
  // binding. Goofy is Slopesmith's original left-facing body; standard mirrors the body/bindings to face right.
  // Skis have parallel feet, so showing this row there would imply a choice that does nothing.
  if (store.playRideGear === 'snowboard') {
    const stanceButtons = segmented<SnowboardStance>(
      snowboardStanceOptions().map(option => ({
        value: option.id, label: option.label,
        title: option.id === 'standard'
          ? 'Left foot forward — the body faces right.'
          : 'Right foot forward — the body faces left.',
      })),
      () => store.playSnowboardStance,
      stance => {
        store.playSnowboardStance = stance;
        viewport.snowboardStance = stance;
        persistUi();
        rebuildTools();
      },
    );
    stanceButtons.el.setAttribute('role', 'group');
    stanceButtons.el.setAttribute('aria-label', 'Snowboard stance');
    const stanceButtonRow = document.createElement('div');
    stanceButtonRow.className = 'sp-gui-custom sp-play-target';
    stanceButtonRow.appendChild(stanceButtons.el);
    gui.$children.appendChild(stanceButtonRow);
  }

  // WHAT TO DO. Keep the launch controls directly under the gear choice: pick the mountain/event/kit, then go.
  // Avatar and tuning controls follow below, so the primary action never gets buried underneath configuration.
  if (play.launching) {
    const label = play.launching === 'play' ? 'Preparing reference ride…' : 'Preparing reference AI…';
    note(gui, `${label} Effects are loading; leaving Play cancels the launch.`);
    gui.add({ waiting: () => {} }, 'waiting').name('… Loading effects').disable();
  }
  else if (viewport.riding) {
    const pauseLabel = viewport.ridePaused ? '▶ Resume (P)' : '⏸ Pause (P)';
    gui.add({ pause: () => { viewport.toggleRidePause(); rebuildTools(); } }, 'pause').name(pauseLabel);
    gui.add({ stop: () => play.exitRide() }, 'stop').name('■ Stop');
    // The full control map rides the help sheet at the bottom of the screen; the note keeps only the
    // controls that unstick someone (a captured cursor, the person toggle, pause).
    note(gui, 'Esc releases the cursor · V first/third person · P pause',
      'First person captures the cursor: Esc releases it and an empty viewport click recaptures it. '
      + 'In third person, hold RMB away from a highlighted target to look. E gets off/recalls the board; '
      + 'on foot, WASD walks, Ctrl crouches, LMB rides a highlighted board and RMB grabs it.');
  }
  else if (viewport.watching) gui.add({ stop: () => play.stopWatch() }, 'stop').name('■ Stop watching (Esc)');
  else if (viewport.xrPlaying) {
    note(gui, 'In VR — left Y shows/hides the wrist menu. Trigger mounts/dismounts; right-stick click or desk V toggles first/third person.');
    gui.add({ stop: () => play.stopVr() }, 'stop').name('■ Leave VR (Esc)');
  }
  else {
    const playLabel = `▶ Play ${store.playTarget === 'reference' ? referenceName : mountainName}`;
    // The headset check is one async call per panel build, and the panel rebuilds often, so the answer is cached
    // for the tab (it cannot change without a page reload). The launch row stays put while that answer lands;
    // disabled grey is the visible answer on a machine with no immersive runtime.
    if (xrAvailable === undefined) void resolveXrAvailable(() => { if (store.currentMode === 'play') rebuildTools(); });
    const coarsePointer = primaryPointerIsCoarse();
    const addScreenLaunch = (headsetPanel = false) => {
      // Quest Touch controllers are XR input sources, not navigator gamepads. The explicit false prevents a
      // controller ray that happens to report a touch-like event from enabling the direct-multitouch diagram.
      const launch = gui.add({ play: () => play.startPlay(!headsetPanel) }, 'play')
        .name(headsetPanel ? '▶ Play on screen' : playLabel);
      if (headsetPanel) {
        tip(launch, 'Ride in the browser panel with a Bluetooth gamepad or physical keyboard.',
          'Quest Touch controllers are available only inside Play in VR. Flat Play keeps its Stop controls visible '
          + 'and does not show the phone thumb controls.');
      } else {
        // The key-by-key control map lives on the help sheet at the bottom of the screen while riding.
        tip(launch, 'Drop the board at the start and ride it yourself.',
          'Controls are on the help sheet at the bottom of the screen. First person captures the cursor — Esc '
          + 'releases it. Starting a ride clears any AI riders you dropped by hand.');
      }
    };
    const addVrLaunch = () => {
      const launch = gui.add({ vr: () => void play.startVr() }, 'vr').name('🥽 Play in VR');
      if (xrAvailable !== true) launch.disable();
      if (xrAvailable === true) {
        tip(launch, 'Put the headset on and ride, arriving on foot beside the board.',
          'Left stick walks, right stick turns, and either trigger mounts/dismounts. Riding: left stick carves and '
          + 'tucks; right A jumps and right B boosts. Left X respawns along the course, left Y shows/hides the '
          + 'wrist menu, and right-stick click toggles first/third person. Esc or the headset menu ends the session.');
      } else {
        tip(launch, xrAvailable === false
          ? 'VR is unavailable in this tab — connect a WebXR headset runtime and reload.'
          : 'Checking this browser for an immersive WebXR headset runtime…');
      }
    };
    if (coarsePointer && xrAvailable === undefined) {
      // Do not leave a brief ordinary-Play trap clickable while the one headset capability query is in flight.
      gui.add({ checking: () => {} }, 'checking').name('… Checking headset').disable();
    } else if (preferImmersivePlay(xrAvailable, coarsePointer)) {
      addVrLaunch();       // standalone/headset browser: native controller path is the primary action
      addScreenLaunch(true);
    } else {
      addScreenLaunch();   // desktop/phone: preserve the ordinary flat-Play-first flow
      addVrLaunch();
    }
    const watch = gui.add({ watch: () => play.startWatch() }, 'watch').name('👁 Watch the AI');
    if (store.playAiMax === 0) watch.disable();
    if (store.playAiMax === 0) {
      tip(watch, 'AI riders are set to zero — raise Options ▸ AI riders to enable the watch field.');
    } else {
      tip(watch, 'Watch the AI field work the course; the camera stays yours.',
        'No start point needed — riders field on their own AI paths. Orbit, pan, and zoom as usual.');
    }
    const out = viewport.aiRiderCount;
    note(gui, store.playAiMax === 0
      ? 'AI riders are off — raise Options ▸ AI riders to enable slope drops and Watch'
      : out
      ? `${out} AI rider${out > 1 ? 's' : ''} out — click the slope to drop another`
      : 'click the slope to drop an AI rider and watch it go');
  }

  // The start point is the rarer job of the two things a slope click could mean, so it is armed deliberately —
  // one click, then the click goes back to dropping riders.
  const position = editSection('play-start', 'Position');
  const spawn = play.currentPlaySpawn();
  const startCoords = spawn
    ? ` Current start: X ${spawn[0].toFixed(1)}, Y ${spawn[1].toFixed(1)}, Z ${spawn[2].toFixed(1)}.`
    : '';
  // The default start is a slot on the reference level's own start row, or a few metres down the run.
  tip(position.add({ reset: () => { const d = play.defaultPlaySpawn(); if (d) play.setPlaySpawn(d.pos, true); } }, 'reset').name('⟲ Reset start'),
    `Put the start back where the course begins.${startCoords}`);
  if (store.placingStart) {
    note(position, 'click the slope, or a prop standing on it, to place the start');
    position.add({ cancel: () => play.cancelStartPlacement() }, 'cancel').name('✕ Cancel (Esc)');
  } else {
    tip(position.add({ set: () => play.armStartPlacement() }, 'set').name('⊕ Set custom start'),
      'Arm one click to move the start — terrain, or a prop standing on it.',
      'A run can start on a roof or a ramp. After that one click, slope clicks go back to dropping AI riders.');
  }

  // Multiplayer poses are live scene state, not project data. Keep this chooser inside Position and omit it
  // entirely when this map has nobody else to visit. Session ids distinguish two active tabs for one account.
  const activePlayers = viewport.activeMapPlayers();
  if (activePlayers.length) {
    const totals = new Map<string, number>();
    const seen = new Map<string, number>();
    for (const player of activePlayers) totals.set(player.username, (totals.get(player.username) ?? 0) + 1);
    const playerOptions: Record<string, string> = { 'Choose…': '' };
    for (const player of activePlayers) {
      const ordinal = (seen.get(player.username) ?? 0) + 1;
      seen.set(player.username, ordinal);
      const label = (totals.get(player.username) ?? 0) > 1
        ? `${player.username} (${ordinal})`
        : player.username;
      playerOptions[label] = player.sessionId;
    }
    const choice = { player: '' };
    const goTo = position.add(choice, 'player', playerOptions).name('Go to player');
    goTo.onChange((sessionId: string) => {
      if (!sessionId) return;
      const moved = viewport.goToMapPlayer(sessionId);
      choice.player = '';
      goTo.updateDisplay();
      releaseKeyboard();
      if (!moved) toast('That player is no longer available.', 'info');
    });
    if (viewport.xrPlaying) goTo.disable();
    tip(goTo,
      viewport.xrPlaying
        ? 'Leave VR before moving to another player.'
        : viewport.riding
          ? 'Teleport about 3 m behind this player and keep riding.'
          : 'Move the camera to a wide view ahead of this player, looking back toward them and the mountain.');
  }

  const avatar = editSection('play-avatar', 'Avatar', true);
  // The disk catalog is deliberately async: entering Play never waits on filesystem IO. Rebuild once when the
  // list arrives, then the ordinary lil-gui dropdown owns the persisted selection.
  if (!riderModelCatalogSettled()) {
    void ensureRiderModelCatalog().then(() => { if (store.currentMode === 'play') rebuildTools(); });
    avatar.add({ rider: 'Loading…' }, 'rider').name('Rider model').disable();
  } else {
    const models = riderModelOptions();
    const byLabel: Record<string, string> = {};
    for (const model of models) {
      let label = model.label;
      if (Object.hasOwn(byLabel, label)) label = `${label} (${model.id})`;
      byLabel[label] = model.id;
    }
    if (!models.some(model => model.id === store.playRiderModel)) {
      store.playRiderModel = DEFAULT_RIDER_MODEL_ID;
      viewport.riderModel = store.playRiderModel;
      persistUi();
    }
    tip(avatar.add({ model: store.playRiderModel }, 'model', byLabel).name('Rider model')
      .onChange((model: string) => {
        store.playRiderModel = model;
        viewport.riderModel = model;
        persistUi();
        if (store.currentMode === 'play') rebuildTools();
      }),
    'The character every rider uses; changing it swaps live riders at once.');
  }
  // The stance catalogue is built in, so unlike the character list it needs no disk round-trip and is always
  // offered — the procedural body and an imported character are both posed by it.
  const styles: Record<string, string> = {};
  for (const style of ridingStyleOptions()) styles[style.label] = style.id;
  tip(avatar.add({ style: store.playRiderStyle }, 'style', styles).name('Riding style')
    .onChange((style: string) => {
      store.playRiderStyle = style;
      viewport.riderStyle = style;
      persistUi();
      releaseKeyboard();
    }),
  'How the rider stands and carves.',
  'Hip height, incline and angulation into a carve, counter-rotation, and hand carriage. Changing it '
  + 'restances live riders mid-run without interrupting the ride.');
  const importMixamo = () => {
    if (characterImporting) { toast('A character import is already running.', 'warn'); return; }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.fbx,application/octet-stream';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!/\.fbx$/i.test(file.name)) { toast('Choose a Mixamo .fbx file.', 'err'); return; }
      characterImporting = true;
      toast(`Importing ${file.name}…`, 'info', 6000);
      try {
        const response = await fetch(`/api/character-import?name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: file,
        });
        const result = await response.json() as {
          file?: string; meshes?: number; bones?: number; heightMetres?: number;
          warnings?: string[]; error?: string;
        };
        if (!response.ok || !result.file) throw new Error(result.error ?? `HTTP ${response.status}`);
        // `file` is the GLB the import landed in — an import whose name is taken stores beside it as
        // <name>_2.glb (docs/038), so the rider selected below is the one that was just added
        const models = await refreshRiderModelCatalog();
        if (!models.some(model => model.id === result.file)) throw new Error('saved GLB did not appear in the character catalog');
        store.playRiderModel = result.file;
        viewport.riderModel = result.file;
        persistUi();
        const warning = result.warnings?.[0];
        toast(`Imported ${file.name} — ${result.meshes ?? 0} mesh${result.meshes === 1 ? '' : 'es'}, `
          + `${result.bones ?? 0} bones${result.heightMetres ? ` · ${result.heightMetres.toFixed(2)} m` : ''}`
          + `${warning ? ` · warning: ${warning}` : ''}`, warning ? 'warn' : 'ok', 7000);
        if (store.currentMode === 'play') rebuildTools();
      } catch (error) {
        toast(`Character import failed: ${error instanceof Error ? error.message : error}`, 'err', 8000);
      } finally {
        characterImporting = false;
      }
    };
    input.click();
  };
  tip(avatar.add({ importMixamo }, 'importMixamo').name('▲ Import Mixamo FBX…'),
    'Upload a Mixamo FBX to the server-wide rider library.',
    'The server maps its skeleton, embeds its textures, and converts it to GLB — Blender is not used. '
    + 'Compatible .glb files can also be added under workspace/library/characters.');

  // WebXR fixes its framebuffer and layer path at session start. Keep those XR-only settings — plus the
  // profiler's remembered initial state — above ordinary ride Options, and hide them once a session is underway.
  if (!play.launching && !viewport.riding && !viewport.watching && !viewport.xrPlaying && xrAvailable) {
    const vrOptions = editSection('play-vr-options', 'VR options', true);
    // Pixels go as the SQUARE of this, so it is both the biggest lever on a fill-bound headset and the fastest
    // way to find out whether you are on that bound at all: halve it, and if measured GPU time on the wrist
    // panel halves with it the frame is fill-bound. WebXR fixes the buffer size when the session starts, so this is
    // read at launch and cannot move mid-run. The wrist profiler reports what the runtime actually allocated.
    const updateResolutionNote = (scale: number) => {
      resolutionNote.textContent = xrEyeBufferNote(store.playVrEyeBuffer, scale);
      resolutionNote.classList.toggle('sp-vr-resolution-capped', xrScaleMayBeCapped(store.playVrEyeBuffer, scale));
    };
    tip(vrOptions.add({ scale: store.playVrRenderScale }, 'scale',
      MIN_VR_RENDER_SCALE, MAX_VR_RENDER_SCALE, XR_RENDER_SCALE_STEP).name('VR render scale')
      .onChange((v: number) => {
        store.playVrRenderScale = v;
        updateResolutionNote(v);
      })
      .onFinishChange(() => { persistUi(); rebuildTools(); }),
    'Eye-buffer resolution for the next VR session (0.5×–3×).',
    'Pixel count goes as the square — 0.7 is half the fill cost. Lowering it is the first thing to try when '
    + 'measured GPU time is eating your frame. Applied at session start; browsers may cap extreme requests.');
    const resolutionNote = note(vrOptions, xrEyeBufferNote(store.playVrEyeBuffer, store.playVrRenderScale));
    updateResolutionNote(store.playVrRenderScale);
    tip(vrOptions.add(store, 'playVrLayerMode', {
      'WebGL layer (forced)': 'webgl',
      'Projection layer': 'projection',
    }).name('VR layer path').onFinishChange(() => { persistUi(); rebuildTools(); }),
    'Render path for the next VR session.',
    'WebGL forces Three onto XRWebGLLayer; Projection keeps its XRProjectionLayer path. Tuning ▸ MSAA controls '
    + 'antialiasing on either. The wrist panel reports requested → effective, so a runtime refusal is visible.');
    tip(vrOptions.add(store, 'playVrStatsOn').name('VR performance stats')
      .onFinishChange(() => { persistUi(); rebuildTools(); }),
    'Start the next VR session with the performance readout on.',
    'The wrist menu can switch it live and remembers that state here. Off keeps the compact speed readout but '
    + 'skips the diagnostic canvas upload and GPU timer queries.');
  }

  // Everything below changes how a test is presented or instrumented rather than launching one. Keep those
  // secondary controls together, so the everyday target → gear → Play path stays short.
  const options = editSection('play-options', 'Options', true);
  const gameVolume = { percent: Math.round(store.playGameVolume * 100) };
  tip(options.add(gameVolume, 'percent', 0, 100, 1).name('Game volume')
    .onChange((percent: number) => {
      store.playGameVolume = percent / 100;
      viewport.setRideGameVolume(store.playGameVolume);
    })
    .onFinishChange(() => { persistUi(); releaseKeyboard(); }),
  'Master level for all gameplay sound; zero mutes the game. Scene Sound previews stay audible.');
  tip(options.add({ music: store.playMusicOn }, 'music').name('Music')
    .onChange((v: boolean) => {
      store.playMusicOn = v; viewport.setRideMusic(v); persistUi(); releaseKeyboard();
    }),
  'Play the map’s environment bed off-board and its race track mounted. Applies live.');
  // One count owns both the old enable switch and cap. Zero is a real live cap: it retires the current field and
  // prevents slope-click drops; raising it again enables the next field without a second contradictory control.
  const aiRiders = { count: store.playAiMax };
  tip(options.add(aiRiders, 'count', 0, MAX_AI_RIDERS, 1).name('AI riders')
    .onChange((v: number) => {
      store.playAiMax = Math.max(0, Math.min(MAX_AI_RIDERS, Math.round(v)));
      viewport.aiRiderMax = store.playAiMax;
    })
    .onFinishChange(() => { persistUi(); rebuildTools(); }),
    'How many AI riders may be out at once; zero turns them off.',
    'Lowering a live field retires its oldest riders immediately. Slope clicks past the cap recycle the '
    + 'longest-out rider instead of piling up boards the frame rate has to carry.');

  // The weather dial (docs/050). Defaults to the game's own snowfall rather than to clear: the engine decides
  // its own with a per-course weather roll the level data does not carry, so there is nothing to read off a
  // mountain — and a snowboarding course is the case the effect was built for. Applied live as the slider
  // moves, so the weather can be dialled while riding through it; persisted on release, like AI riders.
  tip(options.add({ snow: store.playSnowAmount }, 'snow', 0, AMOUNT_MAX, 1).name('Snow')
    .onChange((v: number) => { store.playSnowAmount = v; viewport.setRideSnow(v); })
    .onFinishChange(() => { persistUi(); releaseKeyboard(); }),
  `Snowfall on a ride — 0 clear, ${AMOUNT_PORT} the game's own (default), ${AMOUNT_MAX} a blizzard.`,
  `Below ${AMOUNT_PORT} the fall thins the way the engine's own parameter thinned it; above it the weather `
  + 'changes — more, larger flakes driven nearly sideways. Flakes are world-fixed, so you ride through them '
  + 'with full parallax. One draw call, so only the top of the dial costs a run anything. Riding only — the '
  + 'editor view stays clear.');

  tip(options.add({ countdown: store.playCountdownOn }, 'countdown').name('Race countdown')
    .onChange((v: boolean) => { store.playCountdownOn = v; persistUi(); releaseKeyboard(); }),
    'Run the reference course’s READY · 3 · 2 · 1 · GO on the next Play.',
    'Leave off for immediate test runs. Authored mountains and references without a proven countdown always '
    + 'start immediately.');

  // Last by design: these are performance/diagnostic levers rather than the content of the next run.
  const tuning = editSection('play-tuning', 'Tuning', true);
  tip(tuning.add({ antialias: store.playSmoothCutoutsOn }, 'antialias').name('MSAA + smooth cutouts')
    .onChange((v: boolean) => {
      store.playSmoothCutoutsOn = v;
      persistUi();
      // The default framebuffer's sample count is immutable. The same preference is also passed to the next
      // WebXR layer, so one switch owns editor, browser Play, and headset rendering.
      location.reload();
    }),
    'Antialias geometry and cutout edges. Changing this reloads Slopesmith.',
    'MSAA for ordinary geometry, Unity-style alpha-to-coverage for depth-writing cutouts — in the editor, '
    + 'browser Play, and the next VR session. Off uses the faster grainy alpha hash. The reload is because '
    + 'WebGL fixes the framebuffer’s sample count at startup.');
  tip(tuning.add({ boardFx: store.playBoardFxOn }, 'boardFx').name('Board FX')
    .onChange((v: boolean) => {
      store.playBoardFxOn = v; viewport.setRideBoardFx(v); persistUi(); releaseKeyboard();
    }),
    'Draw your board’s wake, spray, and landing puffs. Your ride only — AI riders never get these.');

  // How far the ride draws. A labelled choice rather than a segmented row because "Near / Medium / Far" says
  // nothing on its own — the metres are the setting. Applied live for direct frame-time comparisons.
  const distanceLabels: Record<string, DrawDistance> = {
    [`Near · ${DRAW_DISTANCE_METRES.near} m`]: 'near',
    [`Medium · ${DRAW_DISTANCE_METRES.medium} m`]: 'medium',
    [`Far · ${DRAW_DISTANCE_METRES.far} m`]: 'far',
  };
  tip(tuning.add({ distance: store.playDrawDistance }, 'distance', distanceLabels).name('Draw distance')
    .onChange((tier: DrawDistance) => {
      store.playDrawDistance = tier;
      viewport.setRideDrawDistance(tier);
      persistUi();
      releaseKeyboard();
    }),
  'How far a ride draws; applied live, riding only.',
  'The haze closes in from 300 m so the bound reads as weather rather than a cut. Medium (the default) is the '
  + 'range the VRChat world uses on Quest and costs a typical desktop ride nothing. Far is for a view a longer '
  + 'draw actually reaches, Near for a course that still stutters.');
  tip(tuning.add({ paths: store.playAiPathsOn }, 'paths').name('Show AI paths')
    .onChange((v: boolean) => {
      store.playAiPathsOn = v; viewport.playAiPathsGuide = v; persistUi(); releaseKeyboard();
    }),
    'Draw the AI lines while in Play — riders against their lines tells a bad line from a bad rider.');
  tip(tuning.add({ colliders: store.playCollidersOn }, 'colliders').name('Show colliders')
    .onChange((v: boolean) => {
      store.playCollidersOn = v; viewport.setRideColliders(v); persistUi(); releaseKeyboard();
    }),
    // Why this overlay answers "why did that hit / why didn't it": a bounding box is the box around a prop's
    // MODEL, so a tilted flat panel gets a slab of collidable air metres thick where the art has no thickness
    // at all, and authored courses thread grind lines through the result ([Trailmap: 370]).
    'Draw what the ride collides with, and what it collides as.',
    'Blue/violet: nearby props’ native collision shapes (proxy mesh, bounding box, leaf spheres) — violet ones '
    + 'report a contact but never change your motion. Orange: the board footprint and body sample marks; red: '
    + 'the body sphere, the only part of you a bounding box can touch. Applies live and follows you.');
  tip(tuning.add({ telemetry: store.playTelemetryOn }, 'telemetry').name('Collect telemetry')
    .onChange((v: boolean) => { store.playTelemetryOn = v; persistUi(); releaseKeyboard(); }),
    'Record every physics tick next Play; the trace downloads when the ride stops.',
    'Leave off for ordinary rides — M still captures a marked problem with three seconds of pre-roll.');

}
