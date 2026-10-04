import { nextRailId, RAIL_STYLE_METAL } from '../../core/rails/rails';
import type { NativeArt } from '../../core/export/provider';
import type { LevelProps } from '../../core/reference/props';
import type { Store } from '../state/store';
import type { Mode, Viewport } from '../viewport/viewport';
import { VIEW_ICON } from '../ui/components/icons';
import { tooltip } from '../ui/components/tooltip';
import { toast } from '../ui/components/toast';
import { fetchJson } from '../net/fetch-json';
import { freeScreen } from '../props/screens';
import type { BoostPadKind } from '../../core/props/boost-pad';
import type { SpecialZoneKind } from '../../core/props/special';
import type { EffectSceneryKind } from '../effects/editor';
import { section as toolSection } from '../effects/editor-widgets';

/**
 * The trick tools (docs/014): rails + gems. Arming a tool drops into Props mode, where clicks place — a rail
 * grows node by node until Enter / Esc finishes it, gems drop one per click or a spaced row per drag; the
 * deletes retire the selection. The native trick art (the gem crystals + each rail material's default skin)
 * resolves off shipped models. Owns the Add rail pipe / Add gem / Add light launchers docked under Prop Library.
 */

export type TrickToolsDeps = {
  store: Store;
  viewport: Viewport;
  gemTool: { height: number; spacing: number; value: number }; // gem placement defaults (float height, drag-row gap, tier)
  propLibToggle: HTMLElement; // the persistent Prop Tools header the Add row docks under
  ensurePropLevel: (level: string) => Promise<LevelProps>;
  toggleTricks: () => void;
  armLight: () => void;
  armBoostPad: (kind: BoostPadKind) => Promise<void>;
  addSpecialZone: (kind: SpecialZoneKind) => void;
  addEffectScenery: (kind: EffectSceneryKind) => void;
  /** Turn the Sources view on: video screens are drawn there, so one added while it is off is invisible. */
  revealScreens: () => void;
  /** Start a blank sheet (docs/071): a textured surface laid along a path. */
  addSheet: () => void;
  setMode: (m: Mode) => void;
  scheduleRebuild: () => void;
  rebuildTools: () => void;
  log: (msg: string) => void;
};

export function createTrickTools(deps: TrickToolsDeps) {
  const { store, viewport, gemTool, propLibToggle, ensurePropLevel, toggleTricks, armLight, revealScreens, addSheet, setMode, scheduleRebuild, rebuildTools, log } = deps;

  /**
   * Resolve the trick layer's native art and hand it to the viewport: each rail material's default tube skin
   * (metal's is the red/white the shipped Mdl_Rail_Metal tubes bind) and the gem models
   * (Gem_TrickMultiplier_YellowX2 / OrangeX3 / RedX5, so placed gems + the Gem tool's ghost render the exact
   * crystals the course ships with). Both come from `/api/props/native-art` — the answer the export bakes
   * from, data derived off shipped models rather than named — so the preview and the shipped tube cannot
   * disagree. Fetched once; tubes / markers re-render when the art lands. A failed fetch clears the memo so
   * a later placement retries.
   */
  let trickArtReady: Promise<void> | null = null;
  function ensureTrickArt(): Promise<void> {
    return (trickArtReady ??= (async () => {
      const art = await fetchJson<NativeArt>('/api/props/native-art');
      viewport.setRailSkins(art.railSkins ?? {}); // a server older than this client answers without them
      if (store.selectedRail !== null) rebuildTools(); // the tube-texture swatch shows the default it now has
      if (!art.gemLevel || !art.gemTiers.length) return;
      await ensurePropLevel(art.gemLevel); // the crystals' geometry registers with the level's payload
      viewport.setGemModels(new Map(art.gemTiers.map(t => [t.tier, { level: art.gemLevel, model: t.model }])));
    })().catch(e => { trickArtReady = null; log(`trick art: ${e}`); }));
  }

  /** A trick tool taking over ends a prop line's draw and selection (docs/070), as it does a held prop's. */
  function leavePropLine() {
    store.lineDrawing = false; viewport.setLineDrawing(false);
    store.selectedLine = null; store.selectedLineNode = null;
  }

  /** Standoff (m) a fresh rail floats above the terrain — a low grind-rail height you then tune per rail. */
  const DEFAULT_RAIL_HEIGHT = 1.5;

  /** Start a new rail and arm the Rails tool (the top-bar 'Rails' button). Disarms any held prop / light, jumps
   *  to Props mode (which hosts the placement clicks), and drops an empty rail as the drawing target — each
   *  click on the mountain then appends a node floated at the rail's height (docs/014). `texture` is a tube tile
   *  to wear from the start — a level's rail pipes picked in the Prop Library (docs/071); the metal default
   *  is left as the default rather than pinned. */
  function armRail(opts: { texture?: string } = {}) {
    if (!store.tricksVisible) toggleTricks(); // must see the trick layer you're adding to
    discardUnfinishedRail();
    const rails = (store.mdoc.rails ??= []);
    store.armedProp = null;
    viewport.setPropArmed(null);
    viewport.setLightArmed(false);
    store.gemArmed = false; viewport.setGemArmed(false); // the Rail tool and the Gem tool are exclusive
    leavePropLine();
    const texture = opts.texture && opts.texture !== viewport.railSkins.metal ? opts.texture : undefined;
    rails.push({ id: nextRailId(rails), kind: 'grind', nodes: [], height: DEFAULT_RAIL_HEIGHT, style: RAIL_STYLE_METAL,
      ...(texture ? { texture } : {}) });
    void ensureTrickArt(); // tubes upgrade to their material's default skin when the shipped art lands
    store.selectedRail = rails.length - 1;
    store.selectedNode = null;
    store.selectedProp = null;
    store.multiSel = [];
    store.selectedLight = null;
    store.selectedGem = null;
    store.trickTool = 'rail';
    store.railDrawing = true;
    viewport.setRailArmed(true);
    if (store.currentMode !== 'props') setMode('props'); else { scheduleRebuild(); rebuildTools(); }
    toast('click the mountain to drop rail points — Enter / Esc to finish', 'info');
  }

  /** Arm the Gem tool (top-bar Gem button / the Tools Gem tab): place gems on the course — click drops one, drag
   *  lays a spaced row. Enters Props mode, disarms the other tools, turns the Tricks layer on so you can see them. */
  function armGem() {
    if (!store.tricksVisible) toggleTricks();
    store.armedProp = null; viewport.setPropArmed(null);
    viewport.setLightArmed(false);
    discardUnfinishedRail();
    store.railDrawing = false; viewport.setRailArmed(false);
    leavePropLine();
    store.selectedRail = null; store.selectedNode = null;
    store.selectedProp = null; store.selectedLight = null;
    store.multiSel = [];
    store.selectedGem = null;
    store.trickTool = 'gem';
    store.gemArmed = true; viewport.setGemArmed(true, { value: gemTool.value, height: gemTool.height });
    void ensureTrickArt(); // the ghost + markers upgrade to the native crystals when the donor geometry lands
    if (store.currentMode !== 'props') setMode('props'); else { scheduleRebuild(); rebuildTools(); }
    toast('click to drop a gem — drag to lay a row', 'info');
  }

  /** Remove the selected gem (Delete key or the Tools button). */
  function deleteSelectedGem() {
    if (store.selectedGem === null || !store.mdoc.gems) return;
    store.mdoc.gems = store.mdoc.gems.filter(gem => gem.id !== store.selectedGem);
    store.selectedGem = null;
    scheduleRebuild();
    rebuildTools();
  }

  /**
   * Drop a rail that is still being drawn and never got its second point, under the same rule Finish and
   * Cancel use.
   *
   * Every way OUT of the rail tool has to apply it, not just the two that say "finish" on them. Arming another
   * tool is one of those ways: it disarms rail drawing, so the empty rail it leaves behind can never be
   * finished or reached again — it is invisible on the mountain (a rail under two points sweeps no tube),
   * exports nothing, and simply accumulates in the document one per abandoned draw.
   */
  function discardUnfinishedRail() {
    if (!store.railDrawing || store.selectedRail === null) return;
    if ((store.mdoc.rails?.[store.selectedRail]?.nodes.length ?? 0) >= 2) return;
    store.mdoc.rails?.splice(store.selectedRail, 1);
    store.selectedRail = null;
    store.selectedNode = null;
  }

  /** Put the trick tools down: nothing held, nothing selected, and the Add buttons unlit. The Tools panel then
   *  falls back to the idle Prop Tools launcher, which is where both tools are entered from. Kept as one
   *  function because "we are out of the trick tools" is four pieces of state that must move together. */
  function leaveTrickTools() {
    store.selectedRail = null;
    store.selectedNode = null;
    store.selectedGem = null;
    store.railDrawing = false; viewport.setRailArmed(false);
    store.gemArmed = false; viewport.setGemArmed(false);
    store.trickTool = null;
  }

  /** The trick panels' Cancel: leave the tool and go back to the prop tools. A rail still being drawn is
   *  discarded on the way out under the same under-two-points rule Finish uses, so cancelling mid-draw leaves
   *  nothing behind — while a rail that is already laid is only deselected, never deleted. */
  function cancelTrickTools() {
    if (store.railDrawing) finishRail();
    leaveTrickTools();
    scheduleRebuild();
    rebuildTools();
  }

  /** Finish laying the current rail: disarm drawing. A rail left with fewer than two nodes is dropped (it
   *  would export nothing and just clutter the scene). */
  function finishRail() {
    store.railDrawing = false;
    viewport.setRailArmed(false);
    if (store.selectedRail !== null && store.mdoc.rails && (store.mdoc.rails[store.selectedRail]?.nodes.length ?? 0) < 2) {
      store.mdoc.rails.splice(store.selectedRail, 1);
      leaveTrickTools(); // the rail it was showing is gone — hand the panel back rather than blanking it
    }
    scheduleRebuild();
    rebuildTools();
  }

  /** Remove the selected rail's active node; if that empties the rail below two nodes, remove the whole rail. */
  function deleteSelectedRailNode() {
    if (store.selectedRail === null || store.selectedNode === null || !store.mdoc.rails?.[store.selectedRail]) return;
    const rail = store.mdoc.rails[store.selectedRail];
    rail.nodes.splice(store.selectedNode, 1);
    store.selectedNode = null;
    if (rail.nodes.length < 2) { store.mdoc.rails.splice(store.selectedRail, 1); leaveTrickTools(); }
    scheduleRebuild();
    rebuildTools();
  }

  /** Remove the whole selected rail (the Tools button). */
  function deleteSelectedRail() {
    if (store.selectedRail === null || !store.mdoc.rails) return;
    store.mdoc.rails.splice(store.selectedRail, 1);
    leaveTrickTools(); // the panel had nothing left to show; the launcher is the honest place to land
    scheduleRebuild();
    rebuildTools();
  }

  /**
   * Drop a FREE-STANDING video screen (docs/051) at what the view is centred on, facing the camera.
   *
   * Unlike the other three launchers this places immediately rather than arming a tool: a screen has no
   * ground-relative drop to preview — it is a rectangle in mid-air that belongs on a wall or a face — so the
   * honest gesture is "put one here, now drag it onto the thing it covers". A screen ON a board is the other
   * route entirely: select the prop and its inspector fits one to the board's own face.
   */
  function addFreeScreen() {
    revealScreens();   // screens live in the Sources view; dropping one into a hidden layer shows nothing
    if (store.currentMode !== 'props') setMode('props');
    const screens = (store.mdoc.screens ??= []);
    const target = viewport.controls.target;
    const camera = viewport.camera.position;
    const placed = freeScreen(screens, [target.x, target.y, -target.z], [camera.x, camera.y, -camera.z]);
    screens.push(placed);
    store.selectedScreen = placed.id ?? null;
    store.selectedProp = null;
    store.selectedGem = null;
    scheduleRebuild();
    rebuildTools();
    toast('Screen added — drag it into place, or size and turn it in Tools.');
  }

  // The special-add tools, docked in the idle Prop Tools launcher under the Prop Library button: Add rail
  // pipe, gems, boost pads, lights, screens and sheets. Each fills its own row in Props mode;
  // the active tool shows pressed (syncAddTrickBtns).
  function propToolBtn(icon: string, text: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sp-btn sp-prop-launcher';
    b.innerHTML = `${icon}<span>${text}</span>`;
    // The shared svg() glyph carries no width/height (the top-bar sizes it via CSS); size it here to match the
    // Prop Library button's icon, else it renders at its huge intrinsic size.
    const glyph = b.querySelector('svg');
    if (glyph) { glyph.setAttribute('width', '13'); glyph.setAttribute('height', '13'); }
    tooltip(b, title);
    b.onclick = onClick;
    return b;
  }
  const addRailBtn = propToolBtn(VIEW_ICON.addRail, 'Add rail pipe',
    'Add rail pipe — lay a grind rail with its own tube: click points on the mountain and the rail splines between them, floated at a height you set. Enter / Esc finishes. Click a rail to edit its points / height / material. Add rail spline in this section lays the grind curve along existing props without building a tube.',
    () => armRail());
  const addGemBtn = propToolBtn(VIEW_ICON.addGem, 'Add gem',
    'Add gem — place gem pickups: click to drop one, drag to lay a spaced row. Tune float height / row spacing / value in Tools.',
    () => armGem());
  const addSpeedBoostBtn = propToolBtn(VIEW_ICON.addSpeedBoost, 'Add speed boost',
    'Place a speed boost pad. Click the mountain to place it; turn and size it like a prop. Starts with a five-second boost, editable in Effects.',
    () => void deps.armBoostPad('speed'));
  const addTrickBoostBtn = propToolBtn(VIEW_ICON.addTrickBoost, 'Add trick boost',
    'Place a trick boost pad. Click the mountain to place it; turn and size it like a prop. Starts with a five-second trick window, editable in Effects.',
    () => void deps.armBoostPad('trick'));
  const addLightBtn = propToolBtn(VIEW_ICON.addLight, 'Add light',
    'Add light — drop a free coloured light on the course, then click the mountain to place it. Tune its colour / brightness / reach (and spot cone) in Tools.',
    () => armLight());
  const addScreenBtn = propToolBtn(VIEW_ICON.addScreen, 'Add screen',
    'Add screen — drop a free-standing video screen where you are looking, facing you, then drag it into place. '
    + 'A screen on a BOARD is better added with that prop selected: its inspector fits one to the board’s own '
    + 'face. Screens export as Billboards.json and play video in Unity / VRChat (docs/051).',
    () => addFreeScreen());
  const addSheetBtn = propToolBtn(VIEW_ICON.addSheet, 'Add sheet',
    'Add sheet — lay one textured surface along a path: a fence standing up, or a river lying flat. Click points on '
    + 'the mountain; neighbouring pieces share their edges exactly, like the shipped fences. Give it a tile in its '
    + 'panel — or pick a shipped sheet in the Prop Library to start from its look.',
    () => addSheet());
  const addTriggerBtn = propToolBtn(VIEW_ICON.addTrigger, 'Add trigger box',
    'Place an invisible, resizable box where you are looking, with an empty collision effect. Opens its effect toolbox to configure what happens when a rider enters.',
    () => deps.addEffectScenery('trigger'));
  const addFogBtn = propToolBtn(VIEW_ICON.addFog, 'Add fog volume',
    'Place a fog bank above where you are looking and open its position, scale and particle-volume settings.',
    () => deps.addEffectScenery('fog'));
  const addMotionPathBtn = propToolBtn(VIEW_ICON.addMotionPath, 'Add motion path',
    'Draw an invisible route for a moving prop. Opens the path editor in Effects; click points, then Enter or Esc to finish.',
    () => deps.addEffectScenery('motion-path'));
  const addRailSplineBtn = propToolBtn(VIEW_ICON.addRailSpline, 'Add rail spline',
    'Draw a grindable curve along existing scenery without building a tube. Opens the spline editor in Effects; click points, then Enter or Esc to finish.',
    () => deps.addEffectScenery('rail-spline'));
  const addTrickRow = document.createElement('div');
  addTrickRow.className = 'sp-prop-launcher-stack';
  const zoneButtons = ([
    ['reset-zone', 'Add reset zone', VIEW_ICON.addReset, 'Add a broad, thin reset volume. Riders touching it return to the course.'],
    ['teleport-entrance', 'Add teleport entrance', VIEW_ICON.addTeleport, 'Add a teleport entrance and its paired destination. Choose or move the destination in its settings.'],
    ['teleport-destination', 'Add teleport destination', VIEW_ICON.addDestination, 'Add an invisible destination marker. Pair entrances with it in their settings.'],
    ['wind-zone', 'Add wind zone', VIEW_ICON.addWind, 'Add an invisible box that pushes riders in a chosen world direction while they are inside.'],
    ['vertical-lift', 'Add vertical lift', VIEW_ICON.addLift, 'Add an air shaft that carries riders up to a target height.'],
  ] as const).map(([kind, label, icon, hint]) => propToolBtn(icon, label, hint, () => deps.addSpecialZone(kind)));
  const timeBonusBtn = propToolBtn(VIEW_ICON.addTime, 'Time bonus (unavailable)',
    'Time bonus authoring is unavailable: the native award format and units are not established.',
    () => toast('Time bonuses are not available yet: their native award format and units still need verification.', 'info'));
  function addSection(label: string, buttons: HTMLButtonElement[]) {
    const section = document.createElement('details');
    section.className = 'sp-prop-launcher-section';
    section.open = true;
    const title = document.createElement('summary');
    title.textContent = label;
    const content = document.createElement('div');
    content.className = 'sp-prop-launcher-items';
    content.append(...buttons);
    section.append(title, content);
    addTrickRow.appendChild(section);
  }
  addSection('Pickups & boosts', [addGemBtn, addSpeedBoostBtn, addTrickBoostBtn, timeBonusBtn]);
  addSection('Paths & rails', [addRailBtn, addRailSplineBtn, addMotionPathBtn]);
  addSection('Scenery & atmosphere', [addSheetBtn, addLightBtn, addScreenBtn, addFogBtn]);
  addSection('Zones & travel', [addTriggerBtn, ...zoneButtons]);
  const specialPropsSection = toolSection('Special effect-backed props');
  specialPropsSection.body.appendChild(addTrickRow);
  propLibToggle.appendChild(specialPropsSection.root);
  /** Reflect the armed special-add tool on the Add rail pipe / gem / light buttons' pressed highlight. */
  function syncAddTrickBtns() {
    addRailBtn.classList.toggle('on', store.trickTool === 'rail');
    addGemBtn.classList.toggle('on', store.trickTool === 'gem');
    const held = store.armedProp?.effect;
    const key = held?.kind === 'template' ? held.template.key : null;
    addSpeedBoostBtn.classList.toggle('on', !!key?.startsWith('boost-pad:speed'));
    addTrickBoostBtn.classList.toggle('on', !!key?.startsWith('boost-pad:trick'));
    addLightBtn.classList.toggle('on', viewport.lightPlacing);
  }

  return {
    ensureTrickArt, armRail, armGem, finishRail, cancelTrickTools, discardUnfinishedRail,
    deleteSelectedRail, deleteSelectedRailNode, deleteSelectedGem,
    syncAddTrickBtns,
  };
}

export type TrickTools = ReturnType<typeof createTrickTools>;
