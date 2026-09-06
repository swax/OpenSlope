import { authoredSplineId, splineEffectUses } from '../../../core/effects/authoring';
import {
  isMotionPath, railHasTube, railStyle, RAIL_MATERIAL_OPTIONS,
} from '../../../core/rails/rails';
import { surfaceFor } from '../../ride/physics-math';
import { note, tip } from '../components/gui';
import { toast } from '../components/toast';
import { placementCancelButton, type ToolsContext } from './widgets';

/**
 * The Tricks toolbox (Props mode's rail / gem sub-tools): a selected gem's tier or the gem placement defaults,
 * and a grind rail's height / material / pipe / solid / supports / starts-off controls plus the draw /
 * resume / delete actions. Each ends in the shared cancel back to the launcher both tools are entered from.
 */

/** The gem tiers that actually exist in the game — each is a shipped crystal model + its score multiplier.
 *  The Tools pickers offer exactly these, so the editor preview, the Unity import and the ISO's cloned gem
 *  instance all agree on what a placed gem is (docs/014). */
const GEM_TIERS = { '×2 yellow': 2, '×3 orange': 3, '×5 red': 5 };

/**
 * The Tricks Tools: the controls for whichever trick object is actually in hand.
 *
 * There is no Rail | Gem selector any more. **Add rail pipe** and **Add gem** in the idle Prop Tools launcher
 * are the way into each tool, so a second chooser inside the panel offered a route the author had already taken —
 * and one that could disagree with the thing they had selected. The panel reports the tool it is in instead:
 * a gem selected or the Gem tool held shows the gem controls, and everything else here is a rail's.
 */
export function buildTrickTools(ctx: ToolsContext) {
  const { store } = ctx;
  if (store.selectedGem !== null || store.gemArmed) { buildGemTools(ctx); return; }
  buildRailTools(ctx);
}

/** Tools for the Gem sub-tool: a selected gem's tier + delete, else the placement defaults (float height, the
 *  drag-row spacing, and the tier new gems get). Tiers are the three shipped crystals (×2 yellow / ×3 orange /
 *  ×5 red) — what you pick is what the editor previews, Unity imports and the ISO clones. */
function buildGemTools(ctx: ToolsContext) {
  const { gui, store, viewport, propPreview, gemTool, scheduleRebuild, deleteSelectedGem } = ctx;
  propPreview.hide();
  const gem = store.selectedGem === null ? undefined
    : store.mdoc.gems?.find(entry => entry.id === store.selectedGem);
  if (gem) {
    gem.value ??= 2;
    tip(gui.add(gem, 'value', GEM_TIERS).name('tier').onChange(scheduleRebuild),
      'This gem’s crystal + the trick-score multiplier it awards.');
    gui.add({ del: () => deleteSelectedGem() }, 'del').name('✕ delete gem');
    placementCancelButton(ctx);
    return;
  }
  const rearm = () => { if (store.gemArmed) viewport.setGemArmed(true, { value: gemTool.value, height: gemTool.height }); };
  tip(gui.add(gemTool, 'height', 0, 12, 0.1).name('height (m)').onChange(rearm), 'How high gems float above the ground.');
  tip(gui.add(gemTool, 'spacing', 1, 20, 0.5).name('row spacing (m)'), 'Gap between gems when you drag a row.');
  tip(gui.add(gemTool, 'value', GEM_TIERS).name('tier').onChange(rearm),
    'The crystal new gems drop as — and the trick-score multiplier they award.');
  placementCancelButton(ctx);
}

/** Tools for grind rails: while drawing, a hint + the height / material the next points land at; once a rail
 *  node is selected, its rail's height (re-floats every node) + material + delete-node / delete-rail. Height changes
 *  raise / lower the whole rail so it keeps its shape above the slope (docs/014). */
function buildRailTools(ctx: ToolsContext) {
  const { gui, store, propPreview, scheduleRebuild, rebuildTools,
    deleteSelectedRail, deleteSelectedRailNode, finishRail } = ctx;
  propPreview.hide(); // no prop thumbnail for a rail
  const rail = store.selectedRail !== null ? store.mdoc.rails?.[store.selectedRail] : undefined;
  if (!rail) return; // no rail selected — the Add rail pipe button's tooltip explains laying one
  const motionPath = isMotionPath(rail);
  const tube = railHasTube(rail);
  // height re-floats every node by the delta, so the rail keeps its shape as it moves up / down the slope
  let lastH = rail.height;
  tip(gui.add(rail, 'height', 0, 12, 0.1).name('height (m)').onChange((h: number) => {
    const dy = h - lastH; lastH = h;
    for (const n of rail.nodes) n[1] += dy;
    scheduleRebuild();
  }), motionPath ? 'Ground offset for newly laid path points; moves the complete path vertically.'
    : 'How high the rail floats above the ground — moves every point up / down together.');
  if (!motionPath) {
    // Two controls, because they answer two independent questions. The material is the GRIND SURFACE — the
    // native SplineStyle, which decides how the board sounds and slides (ride/board-audio, ride/physics
    // surfaceFor) — and it means exactly as much on a curve with no pipe as on one with, which is why "wood"
    // and "no pipe" is not the contradiction it looks like: that pair is a log rail. It also tints the pipe
    // when there is one, but the ride feel is the point.
    tip(gui.add(rail, 'style', RAIL_MATERIAL_OPTIONS).name('material')
      .onChange(() => { scheduleRebuild(); rebuildTools(); }),
    'What the board rides: ice is fastest and slipperiest, metal close behind, wood slower and draggy.');
    // The pipe and the grind are separate records on disc (docs/014), so they are separable here: turn this
    // off and the curve ships alone, to be laid along a log, a handrail or a roof edge that is already there.
    const pipe = { pipe: tube };
    tip(gui.add(pipe, 'pipe').name('build pipe').onChange((on: boolean) => {
      rail.bare = on ? undefined : true;
      scheduleRebuild(); rebuildTools();
    }), 'Build this rail its own tube prop. Off: the grind curve ships alone, laid along existing shapes.');
    // The material is not a paint choice: metal, wood and ice are three rows of the ride's own surface table
    // and they ride differently. Read off the contract rather than
    // written down here, so the numbers cannot drift from the table the test ride actually uses.
    const surface = surfaceFor(railStyle(rail));
    note(gui, `Rides surface ${surface.type} “${surface.name}” — settles near ${surface.target.toFixed(1)} m/s, `
      + `drag ${surface.drag.toFixed(2)}.`);
    // lil-gui binds to the property, so materialize the optional flags before offering the checkboxes
    if (tube) {
      rail.solid = rail.solid ?? false;
      rail.supports = rail.supports ?? false;
      tip(gui.add(rail, 'solid').name('solid tube').onChange(() => { scheduleRebuild(); }), // rebuild = persist; the tube looks the same
        'The tube blocks and bumps riders. Off: riders pass through it and only the grind connects.');
      tip(gui.add(rail, 'supports').name('support posts').onChange(() => { scheduleRebuild(); }),
        'A post under each rail point, down to the ground it was laid on. Posts are always solid.');
    }
    rail.startsOff = rail.startsOff ?? false;
    tip(gui.add(rail, 'startsOff').name('starts off').onChange(() => { scheduleRebuild(); }),
      'Ship the rail off until a Rail on / off effect switches it in.',
      'Retail’s fallen trunk works this way — grindable only once the tree is down. '
      + (tube
        ? 'The tube is still drawn and still bumps; the grind just cannot be caught until switched on.'
        : 'Whatever the curve follows is untouched; the grind just cannot be caught until switched on.'));
    // A rail cannot own an effect, so nothing about it says an effect is watching. Deleting or re-laying one
    // that a toggle names breaks that effect silently, and this is the only place the author would find out.
    const uses = store.mdoc.effects ? splineEffectUses(store.mdoc.effects, authoredSplineId(rail)) : [];
    if (uses.length) note(gui, `${uses.length} effect node${uses.length === 1 ? '' : 's'} `
      + `${uses.length === 1 ? 'names' : 'name'} this rail — Effects view lists them on the rail itself.`);
    else if (rail.startsOff) note(gui, 'Nothing switches this rail on, so nobody can grind it. '
      + 'Add a Rail on / off node in Effects view, or untick “starts off”.');
  }
  if (store.railDrawing) {
    gui.add({ done: () => finishRail() }, 'done').name(motionPath ? '✔ finish path' : '✔ finish rail');
  } else {
    gui.add({ more: () => resumeRail(ctx) }, 'more').name('✚ add more points');
    if (store.selectedNode !== null) gui.add({ delN: () => deleteSelectedRailNode() }, 'delN').name('✕ delete this point');
  }
  gui.add({ del: () => deleteSelectedRail() }, 'del').name(motionPath ? '✕ delete path' : '✕ delete rail');
  placementCancelButton(ctx);
}

/** Resume laying points onto the selected rail (the Tools "add more points" button). */
function resumeRail(ctx: ToolsContext) {
  const { store, viewport, scheduleRebuild, rebuildTools } = ctx;
  if (store.selectedRail === null) return;
  store.selectedNode = null;
  store.railDrawing = true;
  viewport.setRailArmed(true);
  scheduleRebuild();
  rebuildTools();
  toast('click the mountain to add more points — Enter / Esc to finish', 'info');
}
