// tier: fast

import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { nameIndex } from '../src/core/doc/ids';
import { quadIsLocked } from '../src/core/mesh/locks';
import { cutTrail, resolveTrail } from '../src/core/mesh/trail-object';
import { check, failures } from './check';

/**
 * Owned trails' app half (docs/023): drawing a trail knot by knot, picking a knot up mid-draw, a knot drag cut
 * from its base document, the trail selected by its patches, and the edits after — add points, delete a knot,
 * settings, dissolve, delete. The cut itself is pinned by trail-object.test.ts; this drives `createTrailTools` over
 * a real document with the viewport faked down to what the tool calls on it.
 */

// The tools share the browser toast helper; give it the one DOM node it captures before importing them.
Object.defineProperty(globalThis, 'document', {
  configurable: true, value: { getElementById: () => ({ textContent: '', className: '' }) },
});
Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout: () => 0 } });
const frames: (() => void)[] = [];
Object.assign(globalThis, {
  requestAnimationFrame: (run: () => void) => { frames.push(run); return frames.length; },
  cancelAnimationFrame: () => { frames.length = 0; },
});
const runFrames = () => { while (frames.length) frames.shift()!(); };
const { createTrailTools } = await import('../src/app/edit/trails');

const doc: QuadMeshDoc = {
  kind: 'mountain', version: 5, name: 'TRAIL OPS', spacing: 30,
  course: { knots: [], blend: 30, surface: 1 }, baseSurface: 1,
  vertices: [], vertexIds: [], quads: [], quadIds: [], nextId: 0,
};
const store = {
  mdoc: doc, modelEditId: null, modelEditDoc: null, currentMode: 'edit',
  cellSel: [] as string[], anchorCell: null as string | null,
  surgeryTool: null as string | null, trailKnot: null as number | null, cageOn: true,
  selectedCorner: null, selected: null, createPatchQuads: [], weldTool: null, weldSource: [], weldEdgeSource: [],
  trailWidth: 13, trailCenterBias: 0.5, trailDishPercent: 10.5, trailPatchLength: 22.5, trailMaxTurnDegrees: 52,
  trailBankGain: 15, trailMaxBankDegrees: 20, trailMesaTextures: true, trailSurfaceLift: 0.25,
};
let shown: { knots: readonly V3[]; knot: number | null; pivot: V3 | null } = { knots: [], knot: null, pivot: null };
let surgery: string | null = null;
let drawEnd: 'start' | 'end' = 'end';
const shownEnd = () => drawEnd; // read through a call: the fake sets it behind TypeScript's narrowing
const viewport = {
  setTrailDrawEnd(end: 'start' | 'end') { drawEnd = end; },
  setTrailKnots(knots: readonly V3[], knot: number | null, _handles?: unknown, pivot: V3 | null = null) {
    shown = { knots: knots.map(k => [...k] as V3), knot, pivot };
  },
  setSurgeryTool(tool: string | null) { surgery = tool; },
  setWeldTool() {}, setCreateTrailSurfaceLift() {}, refreshEditCells() {},
};
const tools = createTrailTools({
  store, viewport: () => viewport, applyCage() {}, persistUi() {}, scheduleRebuild() {}, rebuildTools() {},
  updateCmdSheet() {}, exitRegion() { store.cellSel = []; }, seatMoveGizmo() {}, resetGizmoMode() {},
} as unknown as Parameters<typeof createTrailTools>[0]);

const trail = () => store.mdoc.trails?.[0];
const quadAt = (id: string) => nameIndex(store.mdoc.quadIds).get(id)!;

// ---- drawing: a draft until its second knot, then the real ribbon ------------------------------------------------
tools.armCreateTrail();
check(store.surgeryTool === 'trail' && surgery === 'trail' && tools.selectedTrail()?.knots.length === 0,
  'arm: the tool draws a fresh trail');
tools.appendKnot([0, 0, 0]);
check(!store.mdoc.trails?.length && shown.knots.length === 1, 'draw: one knot is shown but kept out of the document');
tools.appendKnot([0, 0, 100]);
check(store.mdoc.trails?.length === 1 && trail()!.quads.length === 10,
  'draw: the second knot puts the trail and its ten patches in the document');
check(store.cellSel.join() === trail()!.quads.join() && trail()!.quads.every(id => quadIsLocked(store.mdoc, quadAt(id))),
  'draw: its locked patches are the selection while it is drawn');

// ---- a knot picked up mid-draw: each frame is one cut of the drag's base document ------------------------------
{
  tools.selectKnot(0);
  check(shown.knot === 0, 'pick: the clicked knot carries the gizmo');
  const base = store.mdoc, before = trail()!;
  tools.knotDrag(true);
  tools.moveKnot(0, [30, 0, -60]); // long enough to add spans …
  runFrames();
  tools.moveKnot(0, [10, 0, 0]);   // … then back, and shorter again
  runFrames();
  tools.knotDrag(false);
  const once = cutTrail(base, { ...before, knots: [[10, 0, 0], [0, 0, 100]] });
  check(once.ok && store.mdoc.nextId === once.doc.nextId
    && (store.mdoc.tombstones ?? []).join() === (once.doc.tombstones ?? []).join(),
  'drag: the result is one cut of the base, not a pile of every frame\'s ids');
  check(trail()!.knots[0].join() === '10,0,0' && shown.knots[0].join() === '10,0,0', 'drag: the knot lands where it was dropped');
}

// ---- finishing, and finding it again by its patches ----------------------------------------------------------------
tools.appendKnot([0, 0, 200]);
store.trailKnot = null;
tools.finishCreateTrail();
check(store.surgeryTool === null && surgery === null && tools.selectedTrail()?.id === trail()!.id,
  'finish: drawing stops and the trail stays selected');
store.cellSel = [];
check(tools.selectedTrail() === null, 'select: any other selection is not the trail');
tools.syncTrailView();
check(shown.knots.length === 0, 'select: its knots hide with it');
const somePatch = quadAt(trail()!.quads[3]);
check(tools.trailAtQuad(somePatch)?.id === trail()!.id, 'select: a patch names the trail that owns it');
check(tools.withWholeTrails([trail()!.quads[3]]).length === trail()!.quads.length, 'select: a box takes the whole trail');
store.cellSel = [...trail()!.quads];
check(tools.selectedTrail()?.id === trail()!.id && tools.trailStatus()?.knots === 3, 'select: its own patches are the trail');

// ---- editing a finished trail ----------------------------------------------------------------------------------------
check(tools.resumeEnds().join() === 'start,end', 'add points: with no knot picked, either end can grow');
tools.resumeTrail('end');
check(store.surgeryTool === 'trail' && shownEnd() === 'end', 'add points: drawing resumes on the end of the selected trail');
tools.appendKnot([0, 0, 300]);
tools.finishCreateTrail();
check(trail()!.knots.length === 4, 'add points: the knot goes on the end');

// ---- add points from the picked end: the first knot draws onto the start, a middle knot offers nothing ----------
{
  store.cellSel = [...trail()!.quads];
  store.trailKnot = 1;
  check(tools.resumeEnds().length === 0, 'add points: a middle knot has no end to draw from');
  tools.resumeTrail('end');
  check(store.surgeryTool === null, 'add points: … so nothing resumes');
  store.trailKnot = 3;
  check(tools.resumeEnds().join() === 'end', 'add points: the last knot draws onto the end only');
  store.trailKnot = 0;
  check(tools.resumeEnds().join() === 'start', 'add points: the first knot draws onto the start only');
  const before = trail()!;
  const withHandle = { ...before, handles: [{ out: [1, 0, 2] as V3 }], knotSettings: [{ widthM: 20 }] };
  store.mdoc = { ...store.mdoc, trails: [withHandle] };
  tools.resumeTrail('start');
  check(store.surgeryTool === 'trail' && shownEnd() === 'start' && tools.trailDrawEnd() === 'start',
    'add points: drawing resumes on the start');
  tools.appendKnot([0, 0, -100]);
  const grown = trail()!;
  check(grown.knots.length === 5 && grown.knots[0].join() === '0,0,-100' && grown.knots[1].join() === before.knots[0].join(),
    'add points: the new knot goes ahead of the first');
  check(grown.handles?.[0] === null && grown.handles?.[1]?.out?.join() === '1,0,2' && grown.knotSettings?.[1]?.widthM === 20,
    'add points: every knot keeps its own handles and values as the list shifts');
  tools.undoCreateTrailPoint();
  check(trail()!.knots.length === 4 && trail()!.knots[0].join() === before.knots[0].join()
    && trail()!.handles?.[0]?.out?.join() === '1,0,2' && trail()!.knotSettings?.[0]?.widthM === 20,
  'add points: Backspace takes the newest knot back off the start');
  tools.finishCreateTrail();
  check(shownEnd() === 'end' && tools.trailDrawEnd() === 'end', 'add points: finishing puts the next drawing back on the end');
  store.mdoc = { ...store.mdoc, trails: [{ ...trail()!, handles: undefined, knotSettings: undefined }] };
  store.cellSel = [...trail()!.quads];
  store.trailKnot = null;
}
store.trailKnot = 1;
tools.deleteSelectedTrailKnot();
check(trail()!.knots.length === 3 && trail()!.knots[1].join() === '0,0,200', 'delete knot: the selected knot goes');
tools.setTrailSetting('widthM', 20);
check(trail()!.settings.widthM === 20 && store.trailWidth === 20, 'setting: the trail re-cuts and the next trail starts there');
{
  const owned = resolveTrail(store.mdoc, trail()!)!;
  const [l, , r] = owned.vertices;
  // Width is measured in plan: a bank lifts one rim, which lengthens the 3-D chord but not the plan width.
  const span = Math.hypot(...[0, 2].map(k => store.mdoc.vertices[l * 3 + k] - store.mdoc.vertices[r * 3 + k]) as [number, number]);
  check(Math.abs(span - 20) < 1e-6, 'setting: the new width is cut', `${span}`);
}

// ---- the whole trail moves as a unit ---------------------------------------------------------------------------------
{
  store.trailKnot = null;
  store.cellSel = [...trail()!.quads];
  tools.syncTrailView();
  const ribbon = resolveTrail(store.mdoc, trail()!)!.vertices;
  const centre = [0, 1, 2].map(k => ribbon.reduce((sum, v) => sum + store.mdoc.vertices[v * 3 + k], 0) / ribbon.length);
  check(shown.knot === null && !!shown.pivot && shown.pivot.every((c, k) => Math.abs(c - centre[k]) < 1e-9),
    'whole trail: with no knot picked the gizmo sits on the trail, at its ribbon’s centre', JSON.stringify(shown.pivot));
  const base = store.mdoc, before = trail()!;
  tools.knotDrag(true);
  tools.transformTrail(before.knots.map(([x, y, z]) => [x + 40, y + 5, z - 10] as V3), []);
  runFrames();
  tools.transformTrail(before.knots.map(([x, y, z]) => [x + 50, y, z] as V3), []);
  runFrames();
  tools.knotDrag(false);
  const once = cutTrail(base, { ...before, knots: before.knots.map(([x, y, z]) => [x + 50, y, z] as V3) });
  const moved = trail()!;
  check(moved.knots.every((k, i) => k[0] === before.knots[i][0] + 50 && k[2] === before.knots[i][2]),
    'whole trail: every knot moves by the drag');
  check(once.ok && moved.vertices.join() === once.trail.vertices.join() && store.mdoc.vertices.join() === once.doc.vertices.join(),
    'whole trail: what lands is one cut of the drag’s base, its patches carried with it');
  check(moved.quads.every(id => quadIsLocked(store.mdoc, quadAt(id))) && store.cellSel.join() === moved.quads.join(),
    'whole trail: its patches stay locked and selected');
  store.trailKnot = 0;
  tools.syncTrailView();
  check(shown.knot === 0 && shown.pivot === null, 'whole trail: a picked knot takes the gizmo back');
  store.trailKnot = null;
}

// ---- a knot's own section (docs/023 · Per-knot section) ------------------------------------------------------------
{
  store.trailKnot = 1;
  check(tools.selectedTrailKnot()?.cut?.widthM === 20 && !Object.keys(tools.selectedTrailKnot()!.own).length,
    'point: a knot with nothing of its own reads the width the trail cuts it with');
  tools.setTrailKnotSetting('widthM', 30);
  tools.setTrailKnotSetting('bankDegrees', 5);
  check(trail()!.knotSettings?.[1]?.widthM === 30 && tools.selectedTrailKnot()?.cut?.widthM === 30
    && tools.selectedTrailKnot()?.cut?.bankDegrees === 5, 'point: its own width and fixed bank are cut at it');
  tools.setTrailKnotSetting('bankDegrees', undefined);
  check(trail()!.knotSettings?.[1]?.bankDegrees === undefined && trail()!.knotSettings?.[1]?.widthM === 30,
    'point: clearing one value leaves the others');
  store.trailKnot = 0;
  tools.deleteSelectedTrailKnot();
  check(trail()!.knots.length === 2 && trail()!.knotSettings?.[0]?.widthM === 30,
    'delete knot: every later knot keeps its own values');
  store.trailKnot = 0;
  tools.resetTrailKnotSettings();
  check(trail()!.knotSettings === undefined && tools.selectedTrailKnot()?.cut?.widthM === 20,
    'point: following the trail again drops the knot values');
  store.trailKnot = null;
}

const patches = trail()!.quads.length;
tools.dissolveSelectedTrail();
check(!store.mdoc.trails?.length && store.mdoc.quads.length === patches && store.cellSel.length === patches,
  'dissolve: the spline goes, the patches stay selected as mesh');

tools.armCreateTrail();
tools.appendKnot([100, 0, 0]);
tools.appendKnot([100, 0, 80]);
tools.finishCreateTrail();
tools.deleteSelectedTrail();
check(!store.mdoc.trails?.length && store.mdoc.quads.length === patches, 'delete: a trail goes with its own patches only');

tools.armCreateTrail();
tools.appendKnot([200, 0, 0]);
tools.finishCreateTrail();
check(!store.mdoc.trails?.length && store.surgeryTool === null, 'finish: a one-knot trail is dropped');

if (failures) process.exitCode = 1;
