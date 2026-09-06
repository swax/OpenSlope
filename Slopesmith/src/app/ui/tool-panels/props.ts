import { detail, iconAction, note, tip, warningBanner } from '../components/gui';
import { MODE_ICON } from '../components/icons';
import { toast } from '../components/toast';
import {
  auditionCollisionSound, auditionCustomSound, auditionCustomSoundLoop, auditionExternalSoundLoop,
  collisionSoundMeta, externalSoundMeta, loopAuditionKey, onLoopAuditionChange, stopAudition,
} from '../components/audition';
import {
  customSoundFilepath, customSounds, onCustomSoundsChanged, pickCustomSound,
} from '../components/custom-sounds';
import { openSoundLibrary } from '../../effects/sound-library';
import { AUTHORED_MODEL_LEVEL, modelIdFromNumber } from '../../../core/doc/models';
import { SURFACE_AUTHOR_OPTIONS, surfaceTypeLabel } from '../../../core/reference/surface-types';
import type { NativeCollisionProfile, PlacedProp, Screen, V3 } from '../../../core/doc/types';
import { freeScreen, screenForProp, screensOfProp } from '../../props/screens';
import { screenPose, screenProp } from '../../../core/props/screen';
import {
  externalSoundFalloff,
  externalSoundFalloffLabel,
  externalSoundShape,
  externalSoundSource,
  externalSoundEmitterTypeLabel, isInteractiveAmbientEvent,
  AUTHORED_AMBIENT_DEFAULT_CURVE, AUTHORED_AMBIENT_DEFAULT_M,
  AUTHORED_AMBIENT_MAX_M, AUTHORED_AMBIENT_MIN_M,
  authoredAmbientEvent, HIT_GATED_EVENT_POOL,
} from '../../../core/effects/external-sound';
import {
  authoredEffectBindings, authoredPropHasEffectCircumstance, effectAttachments,
} from '../../../core/effects/authoring';
import { collisionSoundSource } from '../../../core/effects/collision-sound';
import { placementCancelButton, type ToolsContext } from './widgets';
import { addAuthoredLightDetails, addReferenceLightDetails } from '../components/light-details';
import { addPropMaterials } from '../components/prop-materials';
import { NATIVE_COLLISION_MODE } from '../../../core/collision/native';
import {
  projectedNativeModelObjectCount, SSX_TRICKY_MAX_NATIVE_MODEL_OBJECTS,
} from '../../../core/reference/props';
import {
  collisionProfileContactState, collisionProfileFromSourceInstance,
  placedPropCollisionProfile, placedPropContactLabel,
} from '../../../core/props/contact';
import { rotateByPlacement, writePropRotation } from '../../../core/props/pose';
import { describeProp, ownGeometry } from '../../../core/props/kind';
import { openBlenderGuide } from '../../props/blender-bridge';

/**
 * One contact & collision vocabulary for both prop inspectors. The authored panel spends it on editable
 * controls and the reference panel on read-only readouts of the same fields, in the same order under the same
 * names, so a picked retail instance and a placement can be read against each other row for row — which is the
 * whole point of having the extracted level in the editor.
 */
const COLLISION_SHAPE_OPTIONS: Readonly<Record<string, number>> = {
  'none — decorative': NATIVE_COLLISION_MODE.none,
  'mesh proxy': NATIVE_COLLISION_MODE.triangleProxy,
  'model bounds': NATIVE_COLLISION_MODE.boundingBox,
  'physics-body spheres': NATIVE_COLLISION_MODE.physicsBodySpheres,
};

// One-line tips paired with longer info-badge detail (`tip(c, HELP.x, MORE.x)`), so the two inspectors
// stay row-for-row comparable without every row hovering as a paragraph. Validation note kept from the
// original copy: live mode-1 and mode-2 gate-off controls both remained ride-through.
const CONTACT_HELP = {
  shape: 'The contact shape tests run against: mesh proxy, model bounds, or physics-body spheres.',
  contact: 'PlayerCollision gate — off disables rider contact even when a shape is present.',
  bounceGate: 'PlayerBounce gate — off keeps contact effects/sounds but suppresses the physical response.',
  responseMass: 'Collision response mass: exactly 0 is pass-through; any nonzero value admits the response.',
  bounceAmount: 'How springy a flagged hit is (native PlayerBounceAmmount).',
  surface: 'What riding ON a response-enabled prop feels and sounds like.',
  physicsBody: 'PhysicsIndex donor: the mode-3 sphere-tree and inertia record, -1 for none.',
  physicsLevel: 'Extracted level that owns the sphere-tree/inertia record.',
  result: 'The result evaluated from the exact fields above using the shared collision spec. Roller movement is '
    + 'separate from rider response.',
  dynamicMass: 'Scalar mass from the property.roller node in this instance’s collision path.',
} as const;

const CONTACT_MORE = {
  shape: 'The triangle proxy is exact. The model’s own bounding box turns with the placement — chunky, which '
    + 'explains hitting a visually empty corner of the model, though never one out in the open beside it. '
    + 'Physics-body spheres (knockable / animated props) need a body record to have any shape at all.',
  contact: 'An independent gate: effects and sounds are not allowed to silently turn it back on.',
  responseMass: 'The native file calls this ObjectProperties.U0; 1e30 is the conventional effectively-infinite '
    + 'default.',
  bounceAmount: 'Retained independently from its gate. Retail ranges from about 0.03 (soft) to 0.6 (springy); '
    + 'a flagged hit always has at least the specified 2 km/h outward eject.',
  surface: 'Applies that terrain family’s ride physics and carve/glide board audio instead of obstacle '
    + 'handling. Most props carry none — Merqury City rooftops and wood bridges are the retail exceptions.',
  physicsBody: 'Mode 3 needs this body for contact; Roller needs it for native PS2 movement/inertia even with '
    + 'another contact shape. Its presence supplies shape/inertia but does not by itself activate movement.',
  physicsLevel: 'PS2 can reuse it only when this is also the ISO replacement target.',
  dynamicMass: 'A property.roller node activates body movement; the mass is the effect payload’s value, not an '
    + 'instance field.',
} as const;

/** A screen's own facing before its turn and tilt — the axis "nudge out" pushes along. */
const SCREEN_FORWARD: V3 = [0, 0, 1];

/** The authored dropdown's own name for a collision mode, so a retail instance's shape reads as the control
 *  that would author the same thing. */
function collisionShapeName(mode: number): string {
  return Object.keys(COLLISION_SHAPE_OPTIONS).find(name => COLLISION_SHAPE_OPTIONS[name] === mode)
    ?? `mode ${mode}`;
}

/** The shape phrase for the effective-result line: what a contact test would actually run against. */
function effectiveShapeLabel(profile: NativeCollisionProfile): string {
  return profile.mode === NATIVE_COLLISION_MODE.none ? 'no shape'
    : profile.mode === NATIVE_COLLISION_MODE.triangleProxy ? 'mesh proxy'
      : profile.mode === NATIVE_COLLISION_MODE.boundingBox ? 'model bounds'
        : profile.physicsSource ? `sphere body ${profile.physicsSource.body} from ${profile.physicsSource.level}`
          : 'sphere body missing';
}

/** The authored dropdown's name for a surface type. Retail also ships types the authoring list deliberately
 *  does not offer; those keep their full legend entry rather than reading as an unnamed number. */
function surfaceOptionName(surface: number): string {
  return SURFACE_AUTHOR_OPTIONS.find(option => option.type === surface)?.name ?? surfaceTypeLabel(surface);
}

/** Read-only renderings of the values their editable twins hold. A sentinel keeps a short decoding after the
 *  raw value so the two panels still line up on the number itself. */
const gateText = (on: boolean) => on ? 'on' : 'off';
const responseMassText = (mass: number) => mass === 0 ? '0 — pass-through' : String(mass);
const bounceAmountText = (amount: number) => amount === 0 ? '0 — no kickback' : String(amount);
const physicsBodyText = (body: number) => body < 0 ? '-1 — none' : String(body);
const ltgStateText = (state: number) => state === -1 ? '-1 — unlisted'
  : state === 0 ? '0 — common (InstanceIndex)'
    : state === 1 ? '1 — race list (RaceInstanceIndex)'
      : state === 2 ? '2 — Showoff layer (GemIndex)'
        : `${state} — unknown list`;

/**
 * The Props-mode toolboxes for prop placements and free lights: the held / selected prop's controls (turn,
 * size, delete), the box-selected multi-prop set (its list, group delete and clear), the selected light's
 * rig controls, and the preview-card sync (updatePropPreview) that the coordinator also drives from
 * updatePaintUi so the card clears when you leave Props mode.
 *
 * Every section here opens CLOSED. There are a dozen of them now — transform, impact sound, emitters,
 * lighting, contact, materials, across both the authored and reference inspectors — and a selection that
 * unfurls all of them buries the panel and pushes the preview card off screen. `editSection` remembers each
 * one's state by key for the session, so the two or three anybody actually works in stay open once opened,
 * which is the behaviour worth having rather than a fixed guess at which ones matter.
 */
export function createPropTools(ctx: ToolsContext) {
  const {
    gui, store, viewport, persistUi, multiList, propPreview, scheduleRebuild, rebuildTools,
    defOfPlaced, placedBaseOffset, shortPropName, propLevels, groupDefIdx,
    armProp, armGroupById, deselectPropOrLight, lightTool,
    deleteSelectedProp, deleteMultiSelProps, deleteSelectedLight, deleteSelectedScreen, revealScreens,
    modelEdit, editSection, goToEffects,
    library, reloadImportedProps, setAuthoredModelTexture, setAuthoredModelFrames,
  } = ctx;
  const mountainName = store.mdoc.name.trim() || 'Mountain';

  // The uploaded-WAV library is shared with the effects inspector; rebuild when it lands or grows so the
  // dropdowns appear without a reselect.
  onCustomSoundsChanged(() => rebuildTools());
  // Starting or stopping a held loop flips one button between play and stop; the panel is the only thing that
  // renders that state, so it redraws whenever the audition changes — including when some other preview
  // stole the audio and ended the loop from outside this panel.
  onLoopAuditionChange(() => { if (!stoppingDuringBuild) rebuildTools(); });

  /** What the Materials block needs from the editor: the picker to choose tiles with, the catalogue to read
   *  and refetch, and the authored-model fields that are document edits rather than catalogue ones. */
  const materialsHost = {
    library, propLevels, reloadImportedProps, rebuildTools,
    setAuthoredModelTexture, setAuthoredModelFrames,
  };

  /**
   * The counts `describeProp` turns into the selection panel's opening line.
   *
   * A TILED prop is read out of the open document, because its cage is the document — the library catalogue
   * holds a triangulated bake of it, which would report the wrong number and the wrong unit. Everything else
   * is read out of the catalogue, where a shipped level and an imported record already look the same.
   */
  function propFactsOf(prop: PlacedProp) {
    if (prop.level === AUTHORED_MODEL_LEVEL) {
      const model = (store.mdoc.models ?? []).find(m => modelIdFromNumber(prop.model) === m.id);
      return { level: prop.level, quads: model?.quads.length ?? 0, tile: model?.texture ?? null };
    }
    const model = propLevels.get(prop.level)?.models.find(m => m.id === prop.model);
    const subs = model?.subs ?? [];
    return {
      level: prop.level,
      tris: subs.reduce((n, sub) => n + Math.floor(sub.indices.length / 3), 0),
      materials: new Set(subs.map(sub => sub.mat)).size,
      // The level a reference prop was borrowed from. Absent for the author's own two libraries, whose
      // pseudo-level names ("@import") would be noise rather than provenance.
      ...(ownGeometry(prop.level) ? {} : { from: prop.level }),
    };
  }

  /** Standard last action for a prop/light inspector; routed through the same domain clear as Escape. */
  function addDeselect() {
    return tip(gui.add({ deselect: deselectPropOrLight }, 'deselect').name('deselect (Esc)'),
      'Clear the selection and return to the Props launcher — same as Esc.');
  }

  /** One remembered viewport preference, offered beside both editable and read-only collision facts. */
  function addCollisionOverlayToggle(section: Parameters<typeof detail>[0]) {
    const overlay = { show: store.collisionOverlayOn };
    tip(section.add(overlay, 'show').name('show collider').onChange((on: boolean) => {
      store.collisionOverlayOn = on;
      viewport.showSelectedPropCollider(on);
      persistUi();
    }), 'Show the selected prop’s collision shapes in the viewport.',
    'Cyan is the native proxy/box/sphere tree, slate is configured native geometry with Player contact off, '
    + 'and orange is the box/capsule proxy exported to Unity.');
  }

  /** Compact source path shown by every prop-audio detail. Authored clips live under the mountain's
   *  sound folder; native event ids resolve to their extracted level/crowd bank WAV. */
  function soundFilepath(level: string, eventId: number | undefined, customFile?: string): string | null {
    if (customFile) return customSoundFilepath(customFile, mountainName);
    return typeof eventId === 'number' ? collisionSoundSource(level, eventId) : null;
  }

  /** The resolved source, read-only, shown with the fields it describes. An unresolved filepath keeps its
   *  diagnostic fact for assigned-but-unmapped ids rather than disappearing. */
  function addSoundFilepath(target: Parameters<typeof detail>[0], filepath: string | null) {
    if (filepath) {
      tip(detail(target, filepath, 'filepath'), 'Resolved WAV source.',
        `Native paths are relative to Maps/<level>/Audio/SFX; ${mountainName} paths belong to this project.`);
    } else {
      tip(detail(target, 'unresolved', 'filepath'),
        'This sound id does not resolve to an extracted WAV path, so it cannot be auditioned.');
    }
  }

  /** A picked reference instance's sound: read-only, so it keeps the plain filepath-then-Play pairing. There
   *  is nothing to browse or load on an extracted level's own record — it is the reference, not the work. */
  function addSoundPreview(target: Parameters<typeof detail>[0], filepath: string | null,
    play: (() => void) | null, title: string) {
    addSoundFilepath(target, filepath);
    if (filepath && play) tip(target.add({ play }, 'play').name('▶ play sound'), title);
  }

  /**
   * Which prop the panel is currently offering loop controls for, or null when nothing is selected. Loop keys
   * are built from it, so a key can only ever match while its own prop is still the selection.
   */
  let loopOwner: string | null = null;
  /** Set while a rebuild is itself stopping a loop. The stop notifies, and acting on that notification would
   *  re-enter `rebuildTools` mid-build — clearing the GUI under the build that is still filling it. */
  let stoppingDuringBuild = false;

  function syncLoopOwner(): void {
    const next = store.multiSel.length ? null
      : store.selectedProp !== null ? `prop:${store.selectedProp}`
        : store.selectedRefProp
          ? `ref:${store.selectedRefProp.level}:${store.selectedRefProp.sourceIndex ?? store.selectedRefProp.name}`
          : null;
    if (next === loopOwner) return;
    loopOwner = next;
    // Stop before the panel is rebuilt without its button, not after: the sound and the control that stops it
    // appear and disappear together. This build already renders the result, so it needs no notification.
    if (!loopAuditionKey()) return;
    stoppingDuringBuild = true;
    try { stopAudition(); } finally { stoppingDuringBuild = false; }
  }

  /**
   * The play control for a CONTINUING sound: a toggle, because the audition loops until it is stopped.
   *
   * A prop's ambience is not audible in the editor otherwise — the placed bed only runs during Test, so this
   * button is the whole of how an emitter is heard while authoring, and it has to be able to hold the sound
   * long enough to judge the loop seam.
   */
  function addLoopPlay(target: Parameters<typeof detail>[0], key: string, start: () => void, title: string) {
    const playing = loopAuditionKey() === key;
    tip(target.add({ play: () => { if (playing) stopAudition(); else start(); } }, 'play')
      .name(playing ? '■ stop loop' : '▶ play loop'), title);
  }

  /** Every authored sound block closes with the same three actions in the same order — browse, load, play —
   *  so the fields above stay a description of the sound and the ways to change or hear it sit together at
   *  the bottom. Play is omitted rather than shown dead when nothing resolves. */
  function addSoundActions(target: Parameters<typeof detail>[0], actions: {
    browse: () => void; browseName: string; browseTitle: string;
    load: () => void; loadName: string; loadTitle: string;
    play: (() => void) | null; playTitle: string;
    /** Set for a continuing channel: the play action becomes a stoppable loop under this identity. */
    loopKey?: string;
  }) {
    tip(target.add({ browse: actions.browse }, 'browse').name(actions.browseName), actions.browseTitle);
    tip(target.add({ load: actions.load }, 'load').name(actions.loadName), actions.loadTitle);
    if (!actions.play) return;
    if (actions.loopKey) addLoopPlay(target, actions.loopKey, actions.play, actions.playTitle);
    else tip(target.add({ play: actions.play }, 'play').name('▶ play sound'), actions.playTitle);
  }

  /** Upload a WAV through the shared library and assign it to one prop sound channel. */
  async function loadPropSound(prop: PlacedProp, field: 'collisionSoundFile' | 'ambientSoundFile', label: string) {
    const stored = await pickCustomSound();
    if (!stored) return;
    prop[field] = stored;
    scheduleRebuild();
    rebuildTools();
    toast(`${mountainName} ${label} "${stored}" assigned.`, 'ok');
  }

  /** Browse the extracted banks for an event id, hear it, and assign what was picked. The prop stores an
   *  EVENT, so the browser opens in its event mode: the slot an id lands on cannot be reversed back into one
   *  (several ids share a slot), which is why this is not the same pick as a Play sound node's. */
  function browsePropSound(prop: PlacedProp, field: 'collisionSound' | 'ambientSound') {
    const fileField = field === 'collisionSound' ? 'collisionSoundFile' : 'ambientSoundFile';
    void openSoundLibrary({
      mountainName,
      mode: field === 'collisionSound' ? 'collision-events' : 'external-events',
      level: prop.level,
      slot: prop[field],
      file: prop[fileField],
      assign: id => {
        prop[field] = id;
        delete prop[fileField]; // an event replaces the custom clip; a WAV set alongside would win silently
        scheduleRebuild();
        rebuildTools();
      },
      assignFile: file => {
        prop[fileField] = file;
        scheduleRebuild();
        rebuildTools();
      },
    });
  }

  /** Materialize an older map's inferred settings only when the user edits them. Explicit profiles are never
   *  rewritten by effect/sound attachments; those combinations are diagnosed below instead. */
  function editableCollisionProfile(prop: PlacedProp, collisionEffect: boolean, hitSound: boolean): NativeCollisionProfile {
    if (!prop.nativeCollision) {
      prop.nativeCollision = structuredClone(placedPropCollisionProfile(prop, collisionEffect, hitSound));
      delete prop.solid;
      delete prop.bounce;
    }
    return prop.nativeCollision;
  }

  /** Tools content in Props mode: a big preview of the held / selected prop, then its turn / size / delete or
   *  a placement hint. The preview card (propPreview) is a persistent panel child; updatePropPreview syncs it.
   *  A selected GROUP also lists its members — the sibling models and the lights the one placement carries. */
  /**
   * The selected SCREEN's inspector (docs/051): a rectangle, so the whole of it is where it looks, how big it
   * is, and how far it stands off the board it covers. Nothing here draws video — what plays is a runtime
   * concern, and the authoring question is only whether the rectangle is on the right face the right way round.
   */
  function buildScreenTools() {
    propPreview.hide();
    const reference = store.selectedRefScreen;
    if (reference) {
      const screen = reference.screen;
      const section = editSection('props-reference-screen', `${reference.level} screen`);
      detail(section, screen.name, 'screen name');
      if (screen.family) {
        const nativeFamily = screen.family.startsWith('Mdl_') ? screen.family
          : screen.family.startsWith('Jumbotron_') ? `Mdl_${screen.family}`
            : `Mdl_Billboard_${screen.family}`;
        detail(section, nativeFamily, 'billboard family');
      }
      if (screen.instance !== undefined) detail(section, `#${screen.instance}`, 'native prop instance');
      if (screen.page) detail(section, screen.page, 'texture page');
      detail(section, `${screen.width.toFixed(2)} × ${screen.height.toFixed(2)} m`, 'measured size');
      note(section, 'Detected reference overlay — read-only. Sources gives every screen a solid colour-bar '
        + 'coverage card so any uncovered billboard edge remains visible around it.');
      addDeselect();
      return;
    }
    const screens = store.mdoc.screens ?? [];
    const screen = screens.find(entry => entry.id === store.selectedScreen);
    if (!screen) return;
    const host = screenProp(screen, store.mdoc.props);
    const section = editSection('props-screen', host ? 'Screen on a board' : 'Free screen', false);
    detail(section, host ? shortPropName(host.name) : 'free-standing',
      host ? 'attached to' : 'placement');
    if (host) {
      note(section, 'Stored in the board’s own frame — it rides the prop when you move, turn or resize it.',
        'Its size is in the board’s units; the prop’s size multiplier applies on top, exactly as it does to '
        + 'the geometry.');
    } else {
      note(section, 'Stored in world space — drag it with the gizmo.',
        'A screen belongs on something, so most screens are better added with a board selected, which fits '
        + 'one to its face.');
    }

    const named = { name: screen.name ?? '' };
    tip(section.add(named, 'name').name('name').onChange((value: string) => {
      const trimmed = value.trim();
      if (trimmed) screen.name = trimmed; else delete screen.name;
      scheduleRebuild();
    }), 'What this screen is called in the exported Billboards.json — a runtime names its object after it.');
    tip(section.add(screen, 'width', 0.5, 60, 0.1).name('width (m)').onChange(scheduleRebuild),
      'Screen width. A fitted screen already matches its board’s face; widen it only to cover a bezel.');
    tip(section.add(screen, 'height', 0.5, 60, 0.1).name('height (m)').onChange(scheduleRebuild),
      'Screen height.');
    tip(section.add(screen, 'yaw', 0, 360, 1).name('turn (°)').onChange(scheduleRebuild),
      'Turn the screen about vertical. On an attached screen this is relative to the board’s own turn.');
    const tilt = {
      get pitch() { return screen.pitch ?? 0; },
      set pitch(value: number) { if (value) screen.pitch = value; else delete screen.pitch; },
    };
    tip(section.add(tilt, 'pitch', -90, 90, 1).name('tilt (°)').onChange(scheduleRebuild),
      'Tip the screen forward or back — for a board that leans over the course.');
    // Standing the panel off its board is the one adjustment a fitted screen actually needs: too little and
    // it fights the ad face it covers, too much and it floats.
    const nudge = (metres: number) => {
      const pose = screenPose(screen, host);
      const step = host ? metres / (host.scale || 1) : metres;
      const local = host ? rotateByPlacement(SCREEN_FORWARD, { yaw: screen.yaw, pitch: screen.pitch }) : pose.normal;
      screen.pos = [screen.pos[0] + local[0] * step, screen.pos[1] + local[1] * step, screen.pos[2] + local[2] * step];
      scheduleRebuild();
    };
    tip(section.add({ out: () => nudge(0.1) }, 'out').name('nudge out 10 cm'),
      'Push the screen further off the face it covers, along its own normal.');
    tip(section.add({ in: () => nudge(-0.1) }, 'in').name('nudge in 10 cm'),
      'Pull the screen back toward the face it covers.');
    if (host) tip(section.add({ refit: () => refitScreen(screen.id!) }, 'refit').name('↻ refit to board'),
      'Measure the board’s face again and reset this screen to it — the same fit the ＋ button makes.');
    gui.add({ del: () => deleteSelectedScreen() }, 'del').name('✕ delete screen');
    addDeselect();
  }

  /** Fit a screen to the selected board (or drop a free one when nothing is selected) and select it. */
  function addScreen(prop: PlacedProp | undefined) {
    const screens = (store.mdoc.screens ??= []);
    const camera = viewport.camera.position;
    const viewFrom: V3 = [camera.x, camera.y, -camera.z];   // scene → data space
    let made: Screen | null;
    if (prop) {
      made = screenForProp(prop, propLevels, screens, viewFrom);
      if (!made) {
        toast('No flat face to put a screen on — this model has no near-vertical panel. Add a free screen and place it by hand.');
        return;
      }
    } else {
      const target = viewport.controls.target;
      made = freeScreen(screens, [target.x, target.y, -target.z], viewFrom);
    }
    screens.push(made);
    revealScreens();   // screens live in the Sources view; one added into a hidden layer shows nothing
    store.selectedScreen = made.id ?? null;
    store.selectedRefScreen = null;
    store.selectedProp = null;
    scheduleRebuild();
    rebuildTools();
  }

  /** Re-run the fit on an attached screen, keeping its identity and name. */
  function refitScreen(id: string) {
    const screens = store.mdoc.screens ?? [];
    const screen = screens.find(entry => entry.id === id);
    const host = screen ? screenProp(screen, store.mdoc.props) : undefined;
    if (!screen || !host) return;
    const camera = viewport.camera.position;
    const fitted = screenForProp(host, propLevels, screens.filter(entry => entry !== screen),
      [camera.x, camera.y, -camera.z]);
    if (!fitted) { toast('Could not measure a face on this board.'); return; }
    Object.assign(screen, { pos: fitted.pos, yaw: fitted.yaw, width: fitted.width, height: fitted.height });
    if (fitted.pitch) screen.pitch = fitted.pitch; else delete screen.pitch;
    scheduleRebuild();
    rebuildTools();
  }

  /** The screen block on a selected board: what it already carries, and the one click that fits another. */
  function addScreenSection(prop: PlacedProp) {
    const section = editSection('props-authored-screens', 'Video screens', false);
    const attached = screensOfProp(store.mdoc.screens, prop);
    for (const screen of attached) {
      const label = screen.name || screen.id || 'screen';
      tip(section.add({ open: () => { store.selectedScreen = screen.id ?? null; store.selectedRefScreen = null;
        scheduleRebuild(); rebuildTools(); } }, 'open')
        .name(`▸ ${label}`), 'Select this screen to size, turn or delete it.');
    }
    tip(section.add({ add: () => addScreen(prop) }, 'add').name('＋ add screen'),
      'Fit a video screen to this prop’s board.',
      'The same texture-led measurement snowknife makes over a whole course. The rectangle is exported as '
      + 'Billboards.json, and a runtime with video (Unity/VRChat) plays over it.');
    return section;
  }

  function buildPropTools() {
    updatePropPreview();
    if (store.selectedScreen !== null || store.selectedRefScreen !== null) {
      syncLoopOwner(); buildScreenTools(); return;
    }
    // A held loop belongs to the prop whose panel offers its stop button. Re-derive that owner on every
    // rebuild and stop anything left over, so changing selection or deselecting silences it rather than
    // leaving a sound running with no way to reach it.
    syncLoopOwner();
    if (store.multiSel.length) { buildMultiPropTools(); return; }
    const prop = store.selectedProp !== null ? store.mdoc.props?.[store.selectedProp] : undefined;
    if (prop) {
      const def = defOfPlaced(prop);
      const actionRows: HTMLElement[] = [];
      const animation = propLevels.get(prop.level)?.models.find(model => model.id === prop.model)?.animation;
      if (animation) {
        const nativeObjects = projectedNativeModelObjectCount(animation);
        if (nativeObjects > SSX_TRICKY_MAX_NATIVE_MODEL_OBJECTS)
          warningBanner(gui, `PS2 ISO warning: this animated prop packs to ${nativeObjects} native objects; `
            + `SSX Tricky is safe only through ${SSX_TRICKY_MAX_NATIVE_MODEL_OBJECTS} and will freeze. `
            + 'Unity export is unaffected, so the prop remains editable and exportable.');
      }
      // What you have clicked, before anything you can do to it. The panel used to open straight into
      // Transform, which answered "where is it" for something you did not yet know the nature of — and the
      // nature is what decides every action below: whether the mesh tools can touch it, whether reshaping
      // costs you its texture mapping, and what survives a trip through Blender (docs/046).
      if (!def) {
        const about = describeProp(propFactsOf(prop));
        const kindSection = editSection('props-kind', about.label, false);
        detail(kindSection, about.detail);
        note(kindSection, about.note);
      }
      const transformSection = editSection('props-authored-transform', 'Transform', false);
      tip(transformSection.add(prop, 'yaw', 0, 360, 1).name('turn (°)').onChange(scheduleRebuild), 'Spin the prop about vertical.');
      // Tilt: the same two angles the gizmo's red / blue rings drive, typed. They live in the document as
      // optional fields, so the sliders read through a proxy that writes zero back out as "absent" — an
      // upright prop you merely looked at keeps saving exactly as it did before tilt existed.
      const tilt = {
        get pitch() { return prop.pitch ?? 0; },
        set pitch(v: number) { writePropRotation(prop, { yaw: prop.yaw, pitch: v, roll: prop.roll }); },
        get roll() { return prop.roll ?? 0; },
        set roll(v: number) { writePropRotation(prop, { yaw: prop.yaw, pitch: prop.pitch, roll: v }); },
      };
      // Pitch stops at ±90: that is the band a YXZ rotation decomposes back into, so a gizmo drag can always
      // be shown here, and a typed angle never re-normalizes into a different-looking triple behind you.
      tip(transformSection.add(tilt, 'pitch', -90, 90, 1).name('tilt (°)').onChange(scheduleRebuild),
        'Tip the prop forward or back, about its own X axis.');
      tip(transformSection.add(tilt, 'roll', -180, 180, 1).name('roll (°)').onChange(scheduleRebuild),
        'Roll the prop onto its side, about its own Z axis.');
      // scaling is about the origin, which would sink / lift the base — nudge the height so the bottom stays put
      let lastScale = prop.scale;
      tip(transformSection.add(prop, 'scale', 0.1, 5, 0.05).name('size ×').onChange((s: number) => {
        prop.pos[1] += (lastScale - s) * placedBaseOffset(prop);
        lastScale = s;
        scheduleRebuild();
      }), 'Scale the prop up or down — its base stays on the ground.');
      // Authors choose the event-layer meaning, not the LTG integer that happens to encode it. State 2 is
      // validated as the complete retail Showoff object layer (rails, pickups, and support geometry); state 1
      // remains visible only as reference provenance until its general-purpose runtime contract is proven.
      const modeSection = editSection('props-authored-mode-presence', 'Mode presence', false);
      const presence = { mode: prop.modePresence ?? 'all' };
      tip(modeSection.add(presence, 'mode', {
        'all modes': 'all',
        'showoff only': 'showoff',
      }).name('shown in').onChange((mode: string) => {
        if (mode === 'showoff') prop.modePresence = 'showoff'; else delete prop.modePresence;
        scheduleRebuild();
      }), 'All modes uses the ordinary instance layer; Showoff only uses the GemIndex layer (LTG state 2).',
      'A Showoff-only prop and its collider are absent in Race and Freeride. Effects can still apply '
        + 'additional mode-specific hiding.');
      // The retail prop-hit one-shot: an ADL EVENT id (not a bank slot) resolved through the global table to
      // the prop's source-level course bank and played positionally on contact, impact-scaled and debounced
      // [Trailmap: 420-audio-runtime]. -1 = no record (silent). Persisted on the placement; test rides play it.
      const impactSection = editSection('props-authored-impact', 'Impact sound', false);
      const sound = { id: prop.collisionSound ?? -1 };
      const soundCtl = tip(impactSection.add(sound, 'id').step(1).name(`hit sound (${collisionSoundMeta(sound.id, prop.level)})`)
        .onChange((id: number) => {
          const next = Math.max(-1, Math.trunc(id));
          if (next < 0) delete prop.collisionSound; else prop.collisionSound = next;
          soundCtl.name(`hit sound (${collisionSoundMeta(next, prop.level)})`);
          scheduleRebuild();
          rebuildTools();
        }), 'ADL event id played when the rider hits this prop; -1 = silent.',
        'E.g. 6 rock, 31 metal rail, 72 tree trunk. The readout shows the resolved bank slot; ids the '
        + 'resolver leaves unmapped stay silent.');
      // Custom hit sound: an uploaded WAV overriding the event id. The export allocates it a reserved event
      // id and the ISO repacker encodes it into the target course bank (collision-sound.ts pool).
      const uploaded = customSounds();
      if (uploaded.length) {
        const currentFile = prop.collisionSoundFile ?? '';
        tip(impactSection.add({ file: currentFile }, 'file', { '(none)': '', ...Object.fromEntries(uploaded.map(s => [s, s])) })
          .name('custom wav').onChange((file: string) => {
            if (file) prop.collisionSoundFile = file; else delete prop.collisionSoundFile;
            scheduleRebuild();
            rebuildTools();
          }), 'Use an uploaded WAV as the hit sound; repacked ISOs carry it into the level’s bank.');
      }
      const impactPath = prop.collisionSoundFile || typeof prop.collisionSound === 'number'
        ? soundFilepath(prop.level, prop.collisionSound, prop.collisionSoundFile) : null;
      if (prop.collisionSoundFile || typeof prop.collisionSound === 'number') addSoundFilepath(impactSection, impactPath);
      addSoundActions(impactSection, {
        browse: () => browsePropSound(prop, 'collisionSound'),
        browseName: '🔊 browse impact events…',
        browseTitle: 'Browse the ADL impact events by name and hear each before picking one.',
        load: () => void loadPropSound(prop, 'collisionSoundFile', 'hit sound'),
        loadName: '⤒ load custom wav…',
        loadTitle: `Upload a WAV and assign it as the hit sound. Stored with ${mountainName} (PCM16 mono, ≤10 s).`,
        play: impactPath ? () => {
          if (prop.collisionSoundFile) auditionCustomSound(prop.collisionSoundFile);
          else auditionCollisionSound(prop.level, prop.collisionSound ?? -1);
        } : null,
        playTitle: 'Audition the assigned impact sound — the custom WAV if set, else the bank clip.',
      });
      // Per-placement ExternalSounds loop. The same event resolver is used for retail bank sounds; a custom WAV
      // shares the reserved event pool with custom impacts. Radius stays in metres in the document and is converted
      // to SSX centimetres only when stamping the ADL record.
      const emitterSection = editSection('props-authored-emitters', 'Emitters', false);
      const ambient = { id: prop.ambientSound ?? -1 };
      const ambientCtl = tip(emitterSection.add(ambient, 'id').step(1).name(`ambient loop (${externalSoundMeta(ambient.id, prop.level)})`)
        .onChange((id: number) => {
          const next = Math.max(-1, Math.trunc(id));
          if (next < 0) delete prop.ambientSound; else prop.ambientSound = next;
          ambientCtl.name(`ambient loop (${externalSoundMeta(next, prop.level)})`);
          scheduleRebuild();
          rebuildTools();
        }), 'Looping positional ExternalSounds event carried by this prop; -1 = none.',
        '97–99 are the shared crowd loops. A custom ambient WAV takes precedence over the event id.');
      if (uploaded.length) {
        const currentAmbient = prop.ambientSoundFile ?? '';
        tip(emitterSection.add({ file: currentAmbient }, 'file', { '(none)': '', ...Object.fromEntries(uploaded.map(s => [s, s])) })
          .name('ambient custom wav').onChange((file: string) => {
            if (file) prop.ambientSoundFile = file; else delete prop.ambientSoundFile;
            scheduleRebuild();
            rebuildTools();
          }), 'Use an uploaded WAV as this prop’s ambient loop instead of a bank event id.');
      }
      // An uploaded WAV can be hit-gated only by CLAIMING one of the engine's three ids, which also takes over
      // that id's course-bank slot for the whole target level. Offered here, beside the file it applies to,
      // and stored on the mountain so one WAV means the same thing on every prop that uses it.
      if (prop.ambientSoundFile) {
        const claims = store.mdoc.hitGatedSounds ?? [];
        const held = claims.indexOf(prop.ambientSoundFile);
        const gatedState = { gated: held >= 0 };
        tip(emitterSection.add(gatedState, 'gated')
          .name(held >= 0 ? `hit-gated (claims event ${HIT_GATED_EVENT_POOL[held]})` : 'hit-gated')
          .onChange((on: boolean) => {
            const next = [...claims];
            if (on) {
              // Reuse a released slot before growing, so the three stay as compact as they can be without
              // ever moving a claim that is still held.
              let at = next.indexOf('');
              if (at < 0 && next.length < HIT_GATED_EVENT_POOL.length) at = next.push('') - 1;
              if (at < 0) {
                toast(`Only ${HIT_GATED_EVENT_POOL.length} hit-gated loops are possible — the engine tests `
                  + 'exactly three event ids. Release one first.', 'warn');
                rebuildTools();
                return;
              }
              next[at] = prop.ambientSoundFile!;
            } else {
              next[held] = ''; // blank, never splice: positions are the event ids
              while (next.length && next[next.length - 1] === '') next.pop();
            }
            store.mdoc.hitGatedSounds = next.length ? next : undefined;
            scheduleRebuild();
            rebuildTools();
          }),
        'Make this loop HIT-GATED: silent until the rider hits the prop, then sounding for the rest of the run.',
        'Only three are possible in the whole game — the engine tests exactly three event ids — so claiming '
        + 'one takes that id and its course-bank slot over for the entire target level: any retail prop using '
        + 'that event plays this clip instead. Merqury City is the only shipped course that uses them (cars 16, '
        + 'hydrants 28, police 57); everywhere else the slots are unclaimed and this costs nothing.');
      }
      // Assigning 16/28/57 directly does the same thing — engine-fixed on the event id, so it happens whether
      // or not the author meant it. Say so where the id is chosen rather than leaving a prop that ships
      // "silent" and looks broken.
      if (isInteractiveAmbientEvent(
        authoredAmbientEvent(prop.ambientSound, prop.ambientSoundFile, store.mdoc.hitGatedSounds))) {
        tip(detail(emitterSection, 'point · hit-gated', 'ambient trigger'),
          'Interactive ambient class — silent until the rider hits THIS prop, then on for the rest of the run.',
          'The class is events 16 cars / 28 fire hydrants / 57 police cars. Every other event plays on '
          + 'listener proximity alone; membership is fixed in the engine, so the id alone decides it.');
        // A prop nothing can hit can never arm, so this combination ships permanently silent.
        const contact = prop.nativeCollision;
        if (contact && (contact.playerCollision === false || contact.mode === NATIVE_COLLISION_MODE.none))
          note(emitterSection, 'No player contact, so this hit-gated loop can never arm and stays silent. '
            + 'Give the prop a collision shape with Player contact on, or pick a non-gated event.');
      }
      // Shape first: it decides whether the next control is one radius or three half-extents, and an
      // ellipsoid is the reason those two readings can't be collapsed into a single "size" row.
      const ellipsoid = !!prop.ambientHalfExtents;
      const shapeState = { kind: ellipsoid ? 'ellipsoid' : 'sphere' };
      tip(emitterSection.add(shapeState, 'kind', {
        'point · sphere (type 0)': 'sphere',
        'axis-aligned ellipsoid (type 1)': 'ellipsoid',
      }).name('ambient shape').onChange((kind: string) => {
        // Switching seeds the new form from the old one's size, so the region a prop already had does not
        // jump when its shape changes — a sphere becomes the ellipsoid that contains it, and back.
        if (kind === 'ellipsoid') {
          const r = prop.ambientRadius ?? AUTHORED_AMBIENT_DEFAULT_M;
          prop.ambientHalfExtents = [r, r, r];
        } else {
          const [x = AUTHORED_AMBIENT_DEFAULT_M, y = x, z = x] = prop.ambientHalfExtents ?? [];
          prop.ambientRadius = Math.max(x, y, z);
          delete prop.ambientHalfExtents;
        }
        scheduleRebuild();
        rebuildTools();
      }), 'The listener region this loop is heard inside: one radius, or a half-extent per axis.',
      'Sphere is native ExternalSound type 0; ellipsoid is type 1 — how retail covers a long highway or a '
        + 'wide fan of grandstand. Type 2 directional regions stay read-only: their angular gate has no '
        + 'settled meaning yet, so Slopesmith will not author one it cannot reproduce.');
      if (ellipsoid) {
        const extents = prop.ambientHalfExtents ?? [
          AUTHORED_AMBIENT_DEFAULT_M, AUTHORED_AMBIENT_DEFAULT_M, AUTHORED_AMBIENT_DEFAULT_M];
        (['x', 'y', 'z'] as const).forEach((label, axis) => {
          const state = { m: extents[axis] };
          tip(emitterSection.add(state, 'm', AUTHORED_AMBIENT_MIN_M, AUTHORED_AMBIENT_MAX_M, 1)
            .name(`half-extent ${label} (m)`).onChange((m: number) => {
              const next: V3 = [...(prop.ambientHalfExtents ?? extents)] as V3;
              next[axis] = m;
              prop.ambientHalfExtents = next;
              scheduleRebuild();
            }), `Half-extent along editor ${label.toUpperCase()} — prop to region boundary on that axis.`,
            'The export reorders these into the native axis order, so what the cyan outline shows is the '
            + 'volume that ships.');
        });
      } else {
        const ambientRadius = { m: typeof prop.ambientRadius === 'number' ? prop.ambientRadius : AUTHORED_AMBIENT_DEFAULT_M };
        tip(emitterSection.add(ambientRadius, 'm', AUTHORED_AMBIENT_MIN_M, AUTHORED_AMBIENT_MAX_M, 1)
          .name('ambient radius (m)').onChange((m: number) => {
            if (Math.abs(m - AUTHORED_AMBIENT_DEFAULT_M) < 1e-9) delete prop.ambientRadius; else prop.ambientRadius = m;
            scheduleRebuild();
          }), 'Maximum audible distance, previewed as a cyan wire sphere in the viewport.',
          'Retail stores this radius in centimetres; Unity receives metres.');
      }
      const falloffState = { curve: String(prop.ambientFalloff ?? AUTHORED_AMBIENT_DEFAULT_CURVE) };
      tip(emitterSection.add(falloffState, 'curve', Object.fromEntries(
        [0, 1, 2, 3, 4, 5].map(c => [`curve ${c} · ${externalSoundFalloffLabel(c)}`, String(c)]),
      )).name('ambient falloff').onChange((value: string) => {
        const curve = Number(value);
        if (curve === AUTHORED_AMBIENT_DEFAULT_CURVE) delete prop.ambientFalloff; else prop.ambientFalloff = curve;
        scheduleRebuild();
      }), 'How gain falls from full volume at the emitter to silence at the region boundary.',
      'The six exact curves the retail runtime evaluates. Linear (2) is what the confirmed retail crowd '
        + 'emitters use and stays the default.');
      const ambientPath = prop.ambientSoundFile
        ? soundFilepath(prop.level, undefined, prop.ambientSoundFile)
        : typeof prop.ambientSound === 'number' ? externalSoundSource(prop.level, prop.ambientSound) : null;
      if (prop.ambientSoundFile || typeof prop.ambientSound === 'number') addSoundFilepath(emitterSection, ambientPath);
      addSoundActions(emitterSection, {
        browse: () => browsePropSound(prop, 'ambientSound'),
        browseName: '🔊 browse emitter events…',
        browseTitle: 'Browse the ExternalSounds events — River, Snowmachine, the crowd loops — and hear each first.',
        load: () => void loadPropSound(prop, 'ambientSoundFile', 'ambient loop'),
        loadName: '⤒ load ambient wav…',
        loadTitle: 'Upload and assign a custom positional loop. The current upload cap is 10 seconds.',
        play: ambientPath ? () => {
          const key = `${loopOwner ?? ''}:ambient`;
          if (prop.ambientSoundFile) auditionCustomSoundLoop(key, prop.ambientSoundFile);
          else auditionExternalSoundLoop(key, prop.level, prop.ambientSound ?? -1);
        } : null,
        loopKey: `${loopOwner ?? ''}:ambient`,
        playTitle: 'Hold the loop to hear how it carries — it stops when you stop it or deselect the prop. '
          + 'Placed ambience is otherwise silent outside Test.',
      });
      // Self-lit is retail's own per-prop lighting setting, and the only one the shipped data justifies
      // authoring by hand: everything else about a prop's lighting (key magnitude, direction) is derived
      // from the sun and the ground under it. Ungated, because a placed reference sign wants it exactly as
      // much as a custom one — retail ships 3–12% of each level's props this way (docs/032 · lighting).
      const lightingSection = editSection('props-authored-lighting', 'Lighting', false);
      const litState = { self: prop.fullBright === true };
      tip(lightingSection.add(litState, 'self').name('self-lit (ignores sun)').onChange((on: boolean) => {
        if (on) prop.fullBright = true; else delete prop.fullBright;
        scheduleRebuild();
      }), 'Ship this placement full-bright — the sun never shades it.',
      'How retail lights sign faces, LCD screens, jumbotrons and lamp heads. Off = lit by the authored sun '
        + 'like the snow under it.');
      const contactSection = editSection('props-authored-contact', 'Contact & collision', false);
      addCollisionOverlayToggle(contactSection);
      const collisionEffect = authoredPropHasEffectCircumstance(store.mdoc.effects, prop.id, 'collision');
      const rollerEffect = !!store.mdoc.effects && authoredEffectBindings(store.mdoc.effects, [prop])
        .some(binding => binding.circumstance === 'collision'
          && binding.graph.nodes.some(node => node.semanticType === 'property.roller'));
      const hitSound = typeof prop.collisionSound === 'number' || !!prop.collisionSoundFile;
      const profile = placedPropCollisionProfile(prop, collisionEffect, hitSound);
      const donorData = profile.physicsSource ? propLevels.get(profile.physicsSource.level) : undefined;
      const missingLoadedBody = !!profile.physicsSource && !!donorData
        && !donorData.physicsBodies?.has(profile.physicsSource.body);
      const effectiveState = profile.mode === NATIVE_COLLISION_MODE.physicsBodySpheres && missingLoadedBody
        ? 'none' : collisionProfileContactState(profile);
      const effectiveSolid = effectiveState === 'solid';

      // Defaults are materialized on placement, but these remain the independent spec fields recovered from
      // ObjectProperties. Attachments never override them: incompatible effect/sound combinations warn below.
      const editProfile = (change: (value: NativeCollisionProfile) => void) => {
        const value = editableCollisionProfile(prop, collisionEffect, hitSound);
        change(value);
        scheduleRebuild();
        rebuildTools();
      };
      const shape = { mode: profile.mode };
      tip(contactSection.add(shape, 'mode', COLLISION_SHAPE_OPTIONS)
        .name('collision shape').onChange((mode: number) => editProfile(value => { value.mode = Number(mode) as 0 | 1 | 2 | 3; })),
      CONTACT_HELP.shape, `${CONTACT_MORE.shape} An authored mesh proxy is generated from this placement.`);
      const gates = { contact: profile.playerCollision, response: profile.playerBounce };
      tip(contactSection.add(gates, 'contact').name('player contact').onChange((on: boolean) =>
        editProfile(value => { value.playerCollision = on; })), CONTACT_HELP.contact, CONTACT_MORE.contact);
      tip(contactSection.add(gates, 'response').name('player bounce').onChange((on: boolean) =>
        editProfile(value => { value.playerBounce = on; })), CONTACT_HELP.bounceGate);
      const mass = { responseMass: profile.responseMass };
      tip(contactSection.add(mass, 'responseMass').min(0).name('collision response mass').onFinishChange((raw: number) =>
        editProfile(value => { value.responseMass = Number.isFinite(raw) ? Math.max(0, raw) : 0; })),
      CONTACT_HELP.responseMass, CONTACT_MORE.responseMass);
      const bounce = { amount: profile.bounceAmount };
      tip(contactSection.add(bounce, 'amount', 0, 1, 0.01).name('bounce amount').onFinishChange((raw: number) =>
        editProfile(value => { value.bounceAmount = Number.isFinite(raw) ? Math.max(0, raw) : 0; })),
      CONTACT_HELP.bounceAmount, CONTACT_MORE.bounceAmount);
      const surfaceState = { surface: typeof prop.surface === 'number' ? prop.surface : -1 };
      tip(contactSection.add(surfaceState, 'surface', Object.fromEntries(SURFACE_AUTHOR_OPTIONS.map(o => [o.name, o.type])))
        .name('ride surface').onChange((surface: number) => {
          if (surface < 0) delete prop.surface; else prop.surface = Math.trunc(surface);
          scheduleRebuild(); rebuildTools();
        }), CONTACT_HELP.surface, CONTACT_MORE.surface);

      const donor = {
        level: profile.physicsSource?.level ?? prop.level,
        body: profile.physicsSource?.body ?? -1,
      };
      tip(contactSection.add(donor, 'body').step(1).name('physics body index').onFinishChange((raw: number) => {
        const body = Number.isFinite(raw) ? Math.trunc(raw) : -1;
        editProfile(value => {
          if (body < 0) delete value.physicsSource;
          else value.physicsSource = { level: String(donor.level).trim() || prop.level, body };
        });
      }), CONTACT_HELP.physicsBody, CONTACT_MORE.physicsBody);
      tip(contactSection.add(donor, 'level').name('physics source level').onFinishChange((raw: string) => {
        const level = String(raw).trim() || prop.level;
        editProfile(value => {
          if (value.physicsSource) value.physicsSource = { level, body: value.physicsSource.body };
        });
      }), `${CONTACT_HELP.physicsLevel} Set a body index first.`, CONTACT_MORE.physicsLevel);

      tip(detail(contactSection,
        `${placedPropContactLabel(effectiveState)} · ${effectiveShapeLabel(profile)}${rollerEffect ? ' · Roller requested' : ''}`,
        'effective collision result'), CONTACT_HELP.result);

      // Detected conflicts live directly under the effective result so the author never has to infer whether
      // a setting will be ignored. warningBanner is the shared yellow diagnostic presentation.
      if ((collisionEffect || hitSound) && effectiveState === 'none')
        warningBanner(contactSection, 'Collision warning: the attached effect or hit sound cannot fire because the current shape/contact settings produce no eligible contact.');
      if (profile.mode === NATIVE_COLLISION_MODE.physicsBodySpheres && !profile.physicsSource)
        warningBanner(contactSection, 'Collision warning: physics-body spheres are selected without a physics body, so there is no contact shape.');
      if (missingLoadedBody)
        warningBanner(contactSection, `Collision warning: body ${profile.physicsSource!.body} was not found in the loaded ${profile.physicsSource!.level} physics pool.`);
      if (profile.mode === NATIVE_COLLISION_MODE.none && profile.playerCollision)
        warningBanner(contactSection, 'Collision warning: Player contact is enabled, but “none” supplies no shape.');
      if (profile.mode !== NATIVE_COLLISION_MODE.none && !profile.playerCollision)
        warningBanner(contactSection, 'Collision warning: the selected shape is ignored while Player contact is off.');
      if (profile.playerBounce && profile.responseMass === 0)
        warningBanner(contactSection, 'Response warning: PlayerBounce is enabled, but response mass is exactly 0, so contact remains ride-through.');
      if (!profile.playerBounce && profile.responseMass !== 0)
        warningBanner(contactSection, 'Response warning: response mass is stored, but PlayerBounce-off suppresses physical rider response. Contact effects/sounds remain eligible.');
      if (!effectiveSolid && typeof prop.surface === 'number' && prop.surface >= 0)
        warningBanner(contactSection, 'Contact warning: ride surface is ignored because the current settings do not produce a solid response.');
      if (!profile.playerBounce && profile.bounceAmount !== 0)
        warningBanner(contactSection, 'Response warning: bounce amount is stored but ignored while PlayerBounce is off.');
      if (prop.effectTrigger && effectiveSolid)
        warningBanner(contactSection, 'Trigger warning: this effect trigger has a solid response and will physically block or deflect the rider.');
      if (rollerEffect && !profile.physicsSource)
        warningBanner(contactSection, 'PS2 ISO warning: Roller previews and Unity movement work, but this custom ISO prop has no native sphere-tree body/inertia and will remain static in PCSX2.');
      // a group's component list rides the preview card above (propPreview.show with its def)
      const placeAction = tip(gui.add({ place: () => { if (prop.group) void armGroupById(prop.level, prop.group, {
        nativeCollision: structuredClone(profile),
        ...(typeof prop.surface === 'number' ? { surface: prop.surface } : {}),
        ...(prop.modePresence === 'showoff' ? { modePresence: 'showoff' as const } : {}),
      }); else void armProp(prop.level, prop.model, prop.name, {
        nativeCollision: structuredClone(profile),
        ...(typeof prop.surface === 'number' ? { surface: prop.surface } : {}),
        ...(prop.modePresence === 'showoff' ? { modePresence: 'showoff' as const } : {}),
      }); } }, 'place')
        .name(def ? '＋ place group' : '＋ place prop'),
      `Put a copy of this ${def ? 'group' : 'prop'} on the cursor, then move over the terrain and click to place it.`);
      actionRows.push(placeAction.domElement);
      // ⧉ revise prop sits directly under ＋ place prop and means ONE thing whatever is selected: put a v2 of
      // this prop in your library and point this placement at it. What differs is only which library it can
      // land in — a tiled prop forks as a tiled prop, everything else lands textured, keeping its UVs.
      if (prop.level === AUTHORED_MODEL_LEVEL) {
        const editAction = tip(gui.add({ edit: () => modelEdit.enter(modelIdFromNumber(prop.model), store.selectedProp!) }, 'edit').name('✎ edit shape'),
          'Open this prop in Edit mode, AT this placement. Edits change the DEFINITION, so every placement of it updates together.');
        actionRows.push(editAction.domElement);
      }
      // The escape hatch, on the prop itself rather than only in the library's right-click menu — this is
      // where you are standing when a shape turns out to need more than the mesh tools have (docs/046).
      if (ownGeometry(prop.level) && !prop.group) {
        const blender = tip(gui.add({ blender: () => openBlenderGuide({
          kind: prop.level === AUTHORED_MODEL_LEVEL ? 'model' : 'import',
          id: prop.model,
          name: prop.name || `#${prop.model}`,
        }) }, 'blender').name('⬈ edit in Blender…'),
        'Take this prop out to Blender and push it straight back onto itself.',
        'Same number, same name — every placement follows. Opens the six-step guide, with a self-contained '
        + 'GLB as the no-install route.');
        actionRows.push(blender.domElement);
      }
      if (!prop.group) {
        const revise = tip(gui.add({ revise: () => modelEdit.createRevision(store.selectedProp!) }, 'revise')
          .name('⧉ revise prop (v2)'),
        'Copy this prop to your library as “<name> v2” and point THIS placement at it.',
        prop.level === AUTHORED_MODEL_LEVEL
          ? 'Opens its edit session. Other placements keep the original, and effects attached to this '
            + 'placement come with it.'
          : 'The copy keeps its UV layout, its materials and its look, so nothing moves and nothing greys '
            + 'out — effects attached to this placement come with it. Edit the copy in Blender (docs/046).');
        actionRows.push(revise.domElement);
      }
      const hasEffect = !!(prop.id && store.mdoc.effects
        && effectAttachments(store.mdoc.effects).some(a => a.enabled && a.target.id === prop.id));
      if (hasEffect) {
        const effectAction = tip(iconAction(gui.add({ fx: () => goToEffects() }, 'fx').name('go to effect'), MODE_ICON.effects),
          'Open Effects mode with this placement selected as the effect host — its attached graph opens for editing.');
        actionRows.push(effectAction.domElement, addDeselect().domElement);
      }
      const deleteAction = gui.add({ del: () => deleteSelectedProp() }, 'del').name(def ? '✕ delete group' : '✕ delete prop');
      actionRows.push(deleteAction.domElement);
      if (!hasEffect) actionRows.push(addDeselect().domElement);
      // The preview is a persistent sibling above these dynamic rows. Move the actions ahead of every folder,
      // then arrange the inspector groups in the task order used while placing and tuning a prop.
      // What the placement is MADE of, under the controls that place and tune it: the model's own material
      // table, editable where the model is ours.
      const materialSection = editSection('props-authored-materials', 'Materials & textures', false);
      addPropMaterials(materialSection, materialsHost, prop.level, prop.model,
        (store.mdoc.props ?? []).filter(p => p.level === prop.level && p.model === prop.model).length);
      // A screen is an annotation on this board rather than a thing of its own, so it is offered here, beside
      // the prop it covers (docs/051).
      const screenSection = addScreenSection(prop);
      transformSection.domElement.before(...actionRows);
      transformSection.domElement.after(modeSection.domElement, contactSection.domElement, lightingSection.domElement,
        impactSection.domElement, emitterSection.domElement, screenSection.domElement,
        materialSection.domElement);
      return;
    }
    const ref = store.selectedRefProp;
    if (ref) {
      const actionRows: HTMLElement[] = [];
      const sourceProfile = collisionProfileFromSourceInstance(ref.level, ref);
      const sourceDefaults = {
        nativeCollision: sourceProfile,
        ...(typeof ref.surface === 'number' && ref.surface >= 0 ? { surface: ref.surface } : {}),
        ...(ref.ltgState === 2 ? { modePresence: 'showoff' as const } : {}),
      };
      const placeAction = tip(gui.add({ place: () => { void armProp(ref.level, ref.model, ref.name, sourceDefaults); } }, 'place').name('＋ place prop'),
        'Put a copy on the cursor with this instance’s exact collision facts as editable defaults.');
      actionRows.push(placeAction.domElement);
      // Revise reaches a reference prop from HERE as well as from a placement of one. Copying a shipped prop
      // used to mean placing it first, which is backwards: revising IS the copy, so the thing you are looking
      // at is the thing you want a copy of.
      const reviseAction = tip(gui.add({ revise: () => modelEdit.reviseReference(ref.level, ref.model, ref.name) }, 'revise')
        .name('⧉ revise prop (v2)'),
      'Copy this prop to your library as “<name> v2” and arm it.',
      'The copy keeps its UV layout, its materials and its look — nothing greys out — and unlike this '
      + 'read-only source it is yours to rename, retexture, edit in Blender (docs/046) or delete.');
      actionRows.push(reviseAction.domElement);
      const hasEffectNavigation = ref.sourceIndex !== undefined;
      if (hasEffectNavigation) {
        const effectAction = tip(iconAction(gui.add({ fx: () => goToEffects() }, 'fx').name('go to effects'), MODE_ICON.effects),
          'Open Effects mode with this instance selected; if it owns an effect slot, its graph opens.');
        const calledEffectAction = tip(iconAction(gui.add({ calledFx: () => goToEffects({
          sourceIndex: ref.sourceIndex!, called: true,
        }) }, 'calledFx').name('go to called effect'), MODE_ICON.effects),
        'Follow this native prop’s first resolved Run-on-another-prop call and open the effect on the prop that receives it.');
        actionRows.push(effectAction.domElement, calledEffectAction.domElement, addDeselect().domElement);
      }
      const modeSection = editSection('props-reference-mode-presence', 'Mode presence', false);
      tip(detail(modeSection, ref.name, 'instance label'),
        'The label attached to this exact Instances.json placement.',
        'Third-party maps commonly replace the art in an existing numbered model slot. The placement label is '
          + 'shown as the selected object’s name; the original slot label remains below as provenance.');
      tip(detail(modeSection, `#${ref.model} · ${ref.modelName ?? ref.name}`, 'model slot'),
        'The numeric Models.json slot and its raw MAP label.',
        'A custom level can reuse this slot for completely different geometry without changing its old retail '
          + 'label, so Slopesmith does not present this value as the clicked object’s identity.');
      tip(detail(modeSection, ltgStateText(ref.ltgState ?? 0), 'LTG state'),
        'The exact native world-grid list this instance belongs to.',
        'State 2 is the retail Showoff-only object layer: its model and collider are absent in Race and '
          + 'Freeride. State 0 is the common list, but an Effects mode function can still hide a common-list '
          + 'prop. State 1 is reported as provenance only until its behavior is validated.');
      const contactSection = editSection('props-reference-contact', 'Contact & collision', false);
      addCollisionOverlayToggle(contactSection);
      // The picked INSTANCE's own collision record, mirrored row for row against the authored panel's editable
      // controls: same names, same option vocabulary, same effective-result line, read-only because an extracted
      // level is evidence rather than work. `place prop` above copies exactly these values as its defaults.
      // A model-only pick carries no instance and therefore no record to mirror.
      if (ref.contact) {
        const refDetail = (name: string, value: string, help: string, more?: string) =>
          tip(detail(contactSection, value, name), help, more);
        // Retail omits a field only where the record cannot carry one; the profile then holds the contact
        // class's default, which is also what a placement copied from here would start with. Say which it is
        // rather than presenting an inference as a stored value.
        const storedMass = typeof ref.responseMass === 'number' && ref.responseMass >= 0;
        const storedBounce = typeof ref.bounce === 'number' && ref.bounce >= 0;
        const classDefault = ' This instance ships no such record, so the contact class default is shown — and '
          + 'copied by “place prop”.';
        refDetail('collision shape', collisionShapeName(sourceProfile.mode), CONTACT_HELP.shape,
          CONTACT_MORE.shape);
        refDetail('player contact', gateText(sourceProfile.playerCollision), CONTACT_HELP.contact,
          CONTACT_MORE.contact);
        refDetail('player bounce', gateText(sourceProfile.playerBounce), CONTACT_HELP.bounceGate);
        refDetail('collision response mass', responseMassText(sourceProfile.responseMass),
          CONTACT_HELP.responseMass, CONTACT_MORE.responseMass + (storedMass ? '' : classDefault));
        refDetail('bounce amount', bounceAmountText(sourceProfile.bounceAmount),
          CONTACT_HELP.bounceAmount, CONTACT_MORE.bounceAmount + (storedBounce
            ? ' A retail instance reports its EFFECTIVE kickback, so a PlayerBounce-off or contact-only instance '
              + 'reads 0 here whatever the file stores.'
            : classDefault));
        refDetail('ride surface', surfaceOptionName(typeof ref.surface === 'number' ? ref.surface : -1),
          CONTACT_HELP.surface, CONTACT_MORE.surface);
        refDetail('physics body index', physicsBodyText(sourceProfile.physicsSource?.body ?? -1),
          CONTACT_HELP.physicsBody, CONTACT_MORE.physicsBody);
        refDetail('physics source level', sourceProfile.physicsSource?.level ?? ref.level,
          CONTACT_HELP.physicsLevel, CONTACT_MORE.physicsLevel);
        // The instance's own class, not a re-derivation: the extractor knew whether a mode-1 instance actually
        // ships a proxy mesh, which is the one input this read-only view cannot recover on its own.
        const refState = ref.contact === 'ghost' ? 'none' as const
          : ref.contact === 'through' ? 'through' as const : 'solid' as const;
        const roller = typeof ref.dynamicMass === 'number' && ref.dynamicMass >= 0;
        refDetail('effective collision result',
          `${placedPropContactLabel(refState)} · ${effectiveShapeLabel(sourceProfile)}`
          + `${roller ? ' · Roller requested' : ''}`, CONTACT_HELP.result);
        // Dynamic mass has no authored twin: it comes from the level's own Roller effect payload rather than
        // from the instance, so it sits under the result the Roller note appears in.
        if (roller) refDetail('dynamic mass', String(ref.dynamicMass), CONTACT_HELP.dynamicMass,
          CONTACT_MORE.dynamicMass);
      }
      // Every variable-sized ADL emitter field that now has a recovered meaning. The payload remains intact
      // behind this semantic view, so rare/future record types can be inspected without being flattened to a
      // generic radius. The viewport draws the same selected record's listener region in cyan.
      const emitters = ref.externalSounds ?? [];
      if (emitters.length) {
        const emitterSection = editSection('props-reference-emitters', `Emitters (${emitters.length})`, false);
        const metres = (cm: number) => {
          const value = cm / 100;
          return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)} m`;
        };
        for (let i = 0; i < Math.min(emitters.length, 3); i++) {
          const emitter = emitters[i];
          if (isInteractiveAmbientEvent(emitter.sound)) {
            tip(detail(emitterSection, externalSoundEmitterTypeLabel(emitter), 'type'),
              'Interactive ambient class — silent until the rider first hits THIS instance.',
              'The class is events 16 cars / 28 fire hydrants / 57 police cars. After the hit it sounds for '
              + 'the rest of the run; every other emitter plays on proximity alone.');
          } else {
            tip(detail(emitterSection, externalSoundEmitterTypeLabel(emitter), 'type'),
              'The native record type — controls the listener region and voice lifetime.',
              'Types 0–2 are maintained while the listener remains in range; type 3 uses the alternate '
              + 'non-maintained mode.');
          }
          tip(detail(emitterSection, `${emitter.sound} · ${externalSoundMeta(emitter.sound, ref.level)}`, 'event'),
            'Global ADL sound event id.',
            'Events 97–99 use the shared Crowd bank, fixed environmental events a named global bank, and '
            + 'ordinary events the level’s course bank.');
          const [ox, oy, oz] = emitter.offset;
          tip(detail(emitterSection, `${metres(ox)}, ${metres(oy)}, ${metres(oz)}`, 'offset'),
            'World-axis offset from the instance to the sound centre — the cyan overlay marks it when non-zero.');
          const shape = externalSoundShape(emitter);
          if (shape?.kind === 'sphere')
            tip(detail(emitterSection, `${metres(shape.radius)} radius${emitter.type === 2 ? ' + directional gate' : ''}`, 'range'),
              emitter.type === 2
                ? 'Radial boundary of this directional emitter; its cone gate is kept in the payload but not drawn yet.'
                : 'Maximum listener distance — shown as cyan great circles in the viewport.');
          else if (shape?.kind === 'ellipsoid')
            tip(detail(emitterSection, shape.halfExtents.map(metres).join(' × '), 'half-extents'),
              'The oriented listener ellipsoid’s three half-extents, previewed in the viewport.');
          else
            tip(detail(emitterSection, `incomplete ${emitter.params.length}-value payload`, 'range'),
              'Extracted before variable-sized records were preserved — re-extract the level to recover these fields.');
          if (shape?.kind === 'ellipsoid')
            tip(detail(emitterSection, shape.axis.map(v => Number(v).toFixed(3)).join(', '), 'axis'),
              'Recovered orientation axis for the ellipsoid listener region.');
          const curve = externalSoundFalloff(emitter);
          if (curve !== null)
            tip(detail(emitterSection, `curve ${curve} · ${externalSoundFalloffLabel(curve)}`, 'falloff'),
              'Exact native gain curve evaluated over normalized listener distance inside the region.');
          const filepath = externalSoundSource(ref.level, emitter.sound);
          const loopKey = `${loopOwner ?? ''}:emitter:${i}`;
          addSoundFilepath(emitterSection, filepath);
          if (filepath) addLoopPlay(emitterSection, loopKey,
            () => { auditionExternalSoundLoop(loopKey, ref.level, emitter.sound); },
            'Hold the loop to hear how it carries — it stops when you stop it or deselect the prop. '
            + 'A hit-gated emitter stays silent even in Test until the rider hits this instance.');
        }
        if (emitters.length > 3)
          tip(detail(emitterSection, `${emitters.length - 3} more record(s)`, 'emitters'),
            'Only the first three records are expanded, to keep the inspector readable.');
      }
      // The picked INSTANCE's hit sound — instance data (its ADL collision-sound record), not part of any
      // effect script. No record or the native 0=silent sentinel means no row; a present event names the
      // extracted WAV it resolves to.
      const refSound = ref.collisionSound ?? -1;
      if (refSound > 0) {
        const impactSection = editSection('props-reference-impact', 'Impact sound', false);
        const source = collisionSoundSource(ref.level, refSound);
        addSoundPreview(impactSection, source, source ? () => { auditionCollisionSound(ref.level, refSound); } : null,
          `Audition the sound the retail game plays when the rider hits this prop (ADL event ${refSound}).`);
        contactSection.domElement.after(impactSection.domElement);
      }
      // Read-only here for the reason editing stops at reference models: this table came out of an extracted
      // level, which Slopesmith reads and never authors. It is still the place to READ one — comparing a
      // retail flipbook against an authored one is exactly how you check an authored one is right.
      const materialSection = editSection('props-reference-materials', 'Materials & textures', false);
      addPropMaterials(materialSection, materialsHost, ref.level, ref.model, 0);
      if (!hasEffectNavigation) actionRows.push(addDeselect().domElement);
      modeSection.domElement.before(...actionRows);
      modeSection.domElement.after(contactSection.domElement, materialSection.domElement);
    }
  }

  /** Tools for a box-selected SET of props: the list (click a row = identify, its ✕ = drop from the set), the
   *  one gizmo at the set's centre moves them together, and delete removes them all (also the Delete key). */
  function buildMultiPropTools() {
    multiList.show(store.multiSel.map(i => ({ index: i, label: shortPropName(store.mdoc.props?.[i]?.name ?? `prop ${i}`) })));
    gui.add({ del: () => deleteMultiSelProps() }, 'del')
      .name(`✕ delete ${store.multiSel.length} prop${store.multiSel.length === 1 ? '' : 's'}`);
    addDeselect();
  }

  /**
   * The Add light panel: what the NEXT light drops as, set before the click rather than after it.
   *
   * The same shape as the rail and gem tools — the launcher hands over to the tool's own panel, and the tool
   * hands back through cancel. Presetting matters more here than it looks: a light is placed one per arm, so
   * without this every light is dropped as the same warm point bulb and then edited, and a row of six matching
   * lamps is six identical edits.
   */
  function buildLightPlacementTools() {
    propPreview.hide();
    const section = editSection('props-light-placement', 'New light'); // open: it IS the panel, not a detail of one
    tip(section.add(lightTool, 'kind', { point: 'point', spot: 'spot' }).name('type')
      .onChange(() => rebuildTools()), // a spot grows the cone row; a point has no cone to show
      'Point radiates in every direction; spot casts a cone straight down, which you aim after placing.');
    tip(section.addColor(lightTool, 'color').name('colour'), 'The hue new lights drop with.');
    tip(section.add(lightTool, 'intensity', 0, 6, 0.1).name('brightness'),
      'Peak HDR strength. Values above 1 are intentionally brighter than display white.');
    tip(section.add(lightTool, 'reach', 5, 150, 1).name('reach (m)'), 'How far the light carries before it fades out.');
    if (lightTool.kind === 'spot')
      tip(section.add(lightTool, 'cone', 5, 80, 1).name('cone half-angle (°)'),
        'Half-angle of the cone. A new spot points straight down; aim it from its own panel once placed.');
    tip(section.add(lightTool, 'glint', { off: 0, 'small (16)': 16, 'medium (32)': 32, 'large (64)': 64 })
      .name('glint'),
      'Draw the game’s runtime sparkle on the lights you place.',
      'The halo, core and twinkle star a street lamp or course flare carries (docs/047). Exported as the '
      + 'light record’s SpriteRes, the engine’s own gate.');
    note(gui, 'Click the mountain to drop a light. One per click — these settings stay for the next one.');
    placementCancelButton(ctx);
  }

  /**
   * Editable controls for a selected free light, or the complete read-only record for a reference bulb.
   *
   * Both sections open by default, unlike every section in the prop inspector above. That is the same rule
   * rather than an exception to it: a prop stacks six of them and opening them all would be a wall, while a
   * light has exactly one and it IS the panel — collapsed, clicking a light answers with a shut folder and
   * nothing else. Placing one selects it immediately, so that shut folder was the first thing a new light said.
   */
  function buildLightTools() {
    propPreview.hide(); // the prop thumbnail card doesn't apply to a light
    const lights = store.mdoc.lights ?? [];
    const lightIndex = store.selectedLight === null ? -1
      : lights.findIndex(entry => entry.id === store.selectedLight);
    const light = lightIndex < 0 ? undefined : lights[lightIndex];
    if (!light) {
      const reference = store.selectedRefLight;
      if (!reference) return; // no light selected — the Add light button's tooltip explains placing one
      const section = editSection('props-reference-light', `${reference.level} light`);
      addReferenceLightDetails(section, reference.level, reference.light, mountainName);
      addDeselect();
      return;
    }
    const section = editSection('props-authored-light', `${mountainName} light`);
    addAuthoredLightDetails(section, light, lightIndex, mountainName, scheduleRebuild, rebuildTools);
    gui.add({ del: () => deleteSelectedLight() }, 'del').name('✕ delete light');
    addDeselect();
  }

  /** Sync the Prop Tools preview card: the selected placed prop, else the held (armed) prop, else hidden.
   *  Called from buildPropTools (props mode) and updatePaintUi (so it clears when you leave props). */
  function updatePropPreview() {
    if (!inPropSubTool()) { propPreview.hide(); return; } // the card belongs to the prop tools, not light / rail / gem
    const sel = store.selectedProp !== null ? store.mdoc.props?.[store.selectedProp] : undefined;
    // a group placement previews its whole assembly, with the component list under the name (docs/015)
    // Every card for a PLACED prop names which placement it is, the same way the box-selection list already
    // did: the Effects panel identifies a prop by its number, so clicking one has to answer that question too
    // rather than making you open its effect to find out which of twenty identical panes you are holding.
    if (sel) propPreview.show(sel.level, sel.model, shortPropName(sel.name), propLevels.get(sel.level), defOfPlaced(sel),
      sel.id ?? `#${store.selectedProp}`);
    // the armed prop is on the cursor, not in the document — it has no placement identity to show yet
    else if (store.armedProp) propPreview.show(store.armedProp.level, store.armedProp.model, shortPropName(store.armedProp.name), propLevels.get(store.armedProp.level), store.armedProp.group ? groupDefIdx.get(`${store.armedProp.level}:${store.armedProp.group}`) : null);
    // A reference pick's number is its native Instances[] row — the exact value Effects mode labels "Prop
    // number". A model-only pick carries no instance, so it stays nameless there.
    else if (store.selectedRefProp) propPreview.show(store.selectedRefProp.level, store.selectedRefProp.model, shortPropName(store.selectedRefProp.name), propLevels.get(store.selectedRefProp.level), null,
      store.selectedRefProp.sourceIndex === undefined ? null : `prop #${store.selectedRefProp.sourceIndex}`);
    else propPreview.hide(); // idle Props mode is the launcher only; do not reserve space for an empty preview
  }

  /** True when Props mode is showing the PROP tools (buildPropTools) — not the light / rail / gem sub-tools. These
   *  are the states the prop preview card applies to; mirrors the rebuildTools props branch. */
  function inPropSubTool(): boolean {
    return store.currentMode === 'props' && store.selectedLight === null && store.selectedRefLight === null
      && !store.railDrawing && store.selectedRail === null && store.selectedGem === null
      && store.selectedScreen === null && store.selectedRefScreen === null
      && !store.gemArmed && !viewport.lightPlacing; // mirrors the panel routing: a held tool owns the toolbox
  }

  return { buildPropTools, buildLightTools, buildLightPlacementTools, updatePropPreview };
}
