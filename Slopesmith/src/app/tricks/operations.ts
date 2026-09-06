import { nextRailId, RAIL_STYLE_METAL } from '../../core/rails/rails';
import type { LevelProps } from '../../core/reference/props';
import type { Store } from '../state/store';
import type { Mode, Viewport } from '../viewport/viewport';
import { VIEW_ICON } from '../ui/components/icons';
import { tooltip } from '../ui/components/tooltip';
import { toast } from '../ui/components/toast';
import { fetchJson } from '../net/fetch-json';
import { freeScreen } from '../props/screens';

/**
 * The trick tools (docs/014): rails + gems. Arming a tool drops into Props mode, where clicks place — a rail
 * grows node by node until Enter / Esc finishes it, gems drop one per click or a spaced row per drag; the
 * deletes retire the selection. The native trick art (the gem crystals + the metal rail skin) resolves off a
 * donor reference level. Owns the Add rail pipe / Add gem / Add light launchers docked under Prop Library.
 */

export type TrickToolsDeps = {
  store: Store;
  viewport: Viewport;
  gemTool: { height: number; spacing: number; value: number }; // gem placement defaults (float height, drag-row gap, tier)
  propLibToggle: HTMLElement; // the persistent Prop Tools header the Add row docks under
  ensurePropLevel: (level: string) => Promise<LevelProps>;
  toggleTricks: () => void;
  armLight: () => void;
  /** Turn the Sources view on: video screens are drawn there, so one added while it is off is invisible. */
  revealScreens: () => void;
  setMode: (m: Mode) => void;
  scheduleRebuild: () => void;
  rebuildTools: () => void;
  log: (msg: string) => void;
};

export function createTrickTools(deps: TrickToolsDeps) {
  const { store, viewport, gemTool, propLibToggle, ensurePropLevel, toggleTricks, armLight, revealScreens, setMode, scheduleRebuild, rebuildTools, log } = deps;

  /**
   * Resolve the trick layer's native art off a donor level and hand it to the viewport: the gem models
   * (Gem_TrickMultiplier_YellowX2 / OrangeX3 / RedX5, so placed gems + the Gem tool's ghost render the exact
   * crystals the course ships with) and the rail skin (the texture the shipped Mdl_Rail_Metal tubes bind —
   * the red/white split — resolved from the models' own material, so metal rails preview in the tube the
   * export bakes). The donor is the first reference level that carries prop tables (data-derived, not named).
   * Fetched once (rides the shared prop-payload cache); markers / tubes re-render when the geometry lands.
   * A failed fetch clears the memo so a later placement retries.
   */
  let trickArtReady: Promise<void> | null = null;
  function ensureTrickArt(): Promise<void> {
    return (trickArtReady ??= (async () => {
      const donor = await firstPropLevel();
      if (!donor) return;
      const lp = await ensurePropLevel(donor);
      const tiers = new Map<number, { level: string; model: number }>();
      for (const [tier, tag] of [[2, 'YellowX2'], [3, 'OrangeX3'], [5, 'RedX5']] as const) {
        const m = lp.models.find(mm => mm.name.startsWith('Gem_TrickMultiplier') && mm.name.includes(tag));
        if (m) tiers.set(tier, { level: donor, model: m.id });
      }
      if (tiers.size) viewport.setGemModels(tiers);
      const rail = lp.models.find(mm => /^Mdl_Rail_Metal/.test(mm.name));
      const railTex = rail?.subs.map(s => lp.materials.get(s.mat)?.tex).find(t => t);
      if (railTex) viewport.setRailSkin({ level: donor, tex: railTex });
    })().catch(e => { trickArtReady = null; log(`trick art: ${e}`); }));
  }

  /** The donor level for native trick art: the first reference level that carries prop tables. */
  async function firstPropLevel(): Promise<string | null> {
    try { return (await fetchJson<{ levels?: string[] }>('/api/props')).levels?.[0] ?? null; }
    catch { return null; }
  }

  /** Standoff (m) a fresh rail floats above the terrain — a low grind-rail height you then tune per rail. */
  const DEFAULT_RAIL_HEIGHT = 1.5;

  /** Start a new rail and arm the Rails tool (the top-bar 'Rails' button). Disarms any held prop / light, jumps
   *  to Props mode (which hosts the placement clicks), and drops an empty rail as the drawing target — each
   *  click on the mountain then appends a node floated at the rail's height (docs/014). */
  function armRail() {
    if (!store.tricksVisible) toggleTricks(); // must see the trick layer you're adding to
    discardUnfinishedRail();
    const rails = (store.mdoc.rails ??= []);
    store.armedProp = null;
    viewport.setPropArmed(null);
    viewport.setLightArmed(false);
    store.gemArmed = false; viewport.setGemArmed(false); // the Rail tool and the Gem tool are exclusive
    rails.push({ id: nextRailId(rails), kind: 'grind', nodes: [], height: DEFAULT_RAIL_HEIGHT, style: RAIL_STYLE_METAL });
    void ensureTrickArt(); // metal tubes upgrade to the native red/white skin when the donor art lands
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
  // pipe, Add gem, Add light and Add screen. Each fills its own row and arms its tool right there in Props mode;
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
    'Add rail pipe — lay a grind rail with its own tube: click points on the mountain and the rail splines between them, floated at a height you set. Enter / Esc finishes. Click a rail to edit its points / height / material. For the grind curve WITHOUT a tube — laid along a prop that already has the shape — use Add rail spline in Effects view.',
    () => armRail());
  const addGemBtn = propToolBtn(VIEW_ICON.addGem, 'Add gem',
    'Add gem — place gem pickups: click to drop one, drag to lay a spaced row. Tune float height / row spacing / value in Tools.',
    () => armGem());
  const addLightBtn = propToolBtn(VIEW_ICON.addLight, 'Add light',
    'Add light — drop a free coloured light on the course, then click the mountain to place it. Tune its colour / brightness / reach (and spot cone) in Tools.',
    () => armLight());
  const addScreenBtn = propToolBtn(VIEW_ICON.addScreen, 'Add screen',
    'Add screen — drop a free-standing video screen where you are looking, facing you, then drag it into place. '
    + 'A screen on a BOARD is better added with that prop selected: its inspector fits one to the board’s own '
    + 'face. Screens export as Billboards.json and play video in Unity / VRChat (docs/051).',
    () => addFreeScreen());
  const addTrickRow = document.createElement('div');
  addTrickRow.className = 'sp-prop-launcher-stack';
  addTrickRow.append(addRailBtn, addGemBtn, addLightBtn, addScreenBtn);
  propLibToggle.appendChild(addTrickRow); // sits directly below the Prop Library button in the same persistent header
  /** Reflect the armed special-add tool on the Add rail pipe / gem / light buttons' pressed highlight. */
  function syncAddTrickBtns() {
    addRailBtn.classList.toggle('on', store.trickTool === 'rail');
    addGemBtn.classList.toggle('on', store.trickTool === 'gem');
    addLightBtn.classList.toggle('on', viewport.lightPlacing);
  }

  return {
    ensureTrickArt, armRail, armGem, finishRail, cancelTrickTools, discardUnfinishedRail,
    deleteSelectedRail, deleteSelectedRailNode, deleteSelectedGem,
    syncAddTrickBtns,
  };
}

export type TrickTools = ReturnType<typeof createTrickTools>;
