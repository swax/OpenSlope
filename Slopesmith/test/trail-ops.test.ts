// tier: fast

import type { AuthoredTrail, QuadMeshDoc, V3 } from '../src/core/doc/types';
import { nameIndex } from '../src/core/doc/ids';
import { quadIsLocked } from '../src/core/mesh/locks';
import { cutTrail, pathKnots, resolveTrail, trailPathQuads } from '../src/core/mesh/trail-object';
import { railBezierSegments } from '../src/core/rails/rails';
import type { TrailShape, TrailTransform } from '../src/app/viewport/tools/create-trail';
import { check, failures } from './check';

/**
 * Owned trails' app half (docs/023): drawing a path point by point, picking a point up mid-draw, a point drag cut
 * from its base document, paths selected by their patches, and the edits after — add points, a new path from any
 * point, joining by landing on a point, settings per path and per point, dissolve, delete. The cut itself is pinned
 * by trail-object.test.ts; this drives `createTrailTools` over a real document with the viewport faked down to what
 * the tool calls on it.
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
  surgeryTool: null as string | null, trailPoint: null as { trail: string; point: number } | null, cageOn: true,
  selectedCorner: null, selected: null, createPatchQuads: [], weldTool: null, weldSource: [], weldEdgeSource: [],
  pathHandle: null,
  trailWidth: 13, trailCenterBias: 0.5, trailDishPercent: 10.5, trailPatchLength: 22.5, trailMaxTurnDegrees: 52,
  trailBankGain: 15, trailMaxBankDegrees: 20, trailTilePair: 'MESA/Trail 1' as string | null,
  trailLeftTurnPair: 'MESA/Left Turn 1' as string | null, trailRightTurnPair: 'MESA/Right Turn 1' as string | null, trailTurnRadius: 80, trailSurfaceLift: 0.25,
};
let shown: { knots: readonly V3[]; knot: number | null; pivot: V3 | null; shape?: TrailShape } = { knots: [], knot: null, pivot: null };
let surgery: string | null = null;
let ghost: readonly (readonly number[])[] | null = null;
const ghostNow = () => ghost; // read through a call: the fake sets it behind TypeScript's narrowing
const pickedNow = () => store.trailPoint; // the tools set it behind TypeScript's narrowing too
const viewport = {
  setTrailKnots(knots: readonly V3[], knot: number | null, pivot: V3 | null = null, shape?: TrailShape) {
    shown = { knots: knots.map(k => [...k] as V3), knot, pivot, shape };
  },
  setLoftPreview(quads: readonly (readonly number[])[] | null) { ghost = quads; },
  setSurgeryTool(tool: string | null) { surgery = tool; if (tool !== 'trail') ghost = null; },
  setWeldTool() {}, setCreateTrailSurfaceLift() {}, refreshEditCells() {},
};
const tools = createTrailTools({
  store, viewport: () => viewport, applyCage() {}, persistUi() {}, scheduleRebuild() {}, rebuildTools() {},
  updateCmdSheet() {}, exitRegion() { store.cellSel = []; }, seatMoveGizmo() {}, resetGizmoMode() {},
} as unknown as Parameters<typeof createTrailTools>[0]);

const trail = () => store.mdoc.trails?.[0];
const byId = (id: string) => store.mdoc.trails!.find(other => other.id === id)!;
const quadAt = (id: string) => nameIndex(store.mdoc.quadIds).get(id)!;
/** A path's knots as `x,y,z` strings. */
const knotsOf = (of: AuthoredTrail, path = 0) => of.paths[path].points.map(point => of.points[point].join());
/** Select paths of a trail by their patches, as a click (or Ctrl-clicks) would. */
const selectPaths = (of: AuthoredTrail, ...paths: number[]) => {
  const lists = trailPathQuads(store.mdoc, of)!;
  store.cellSel = paths.flatMap(path => lists[path]);
  store.anchorCell = store.cellSel[0] ?? null;
  store.trailPoint = null;
  tools.syncTrailView();
};
/** Pick a point of a trail, and its place in the viewport's list. */
const pick = (of: AuthoredTrail, point: number) => {
  store.trailPoint = { trail: of.id, point };
  tools.syncTrailView();
  return shown.knots.findIndex(knot => knot.join() === of.points[point].join());
};
const shift = (d: V3): TrailTransform => ({ point: p => [p[0] + d[0], p[1] + d[1], p[2] + d[2]], vector: v => [v[0], v[1], v[2]] });
const draw = (...knots: V3[]) => {
  tools.armCreateTrail();
  for (const knot of knots) tools.appendKnot(knot);
  tools.finishCreateTrail();
  return store.mdoc.trails!.at(-1)!.id;
};

// ---- drawing: a draft until its second point, then the real ribbon ----------------------------------------------
tools.armCreateTrail();
check(store.surgeryTool === 'trail' && surgery === 'trail' && tools.selectedTrail()?.points.length === 0,
  'arm: the tool draws a fresh trail');
tools.appendKnot([0, 0, 0]);
check(!store.mdoc.trails?.length && shown.knots.length === 1, 'draw: one point is shown but kept out of the document');
tools.appendKnot([0, 0, 100]);
check(store.mdoc.trails?.length === 1 && trail()!.quads.length === 10 && trail()!.paths.length === 1,
  'draw: the second point puts the trail, its path and its ten patches in the document');
check(store.cellSel.join() === trail()!.quads.join() && trail()!.quads.every(id => quadIsLocked(store.mdoc, quadAt(id))),
  'draw: its locked patches are the selection while it is drawn');

// ---- a point picked up mid-draw: each frame is one cut of the drag's base document ------------------------------
{
  tools.selectKnot(0);
  check(shown.knot === 0 && store.trailPoint?.point === 0, 'pick: the clicked point carries the gizmo');
  check(!!shown.shape?.snaps?.some(p => p.join() === '0,0,0') && !shown.shape?.dragSnaps?.some(p => p.join() === '0,0,0'),
    'pick: the next point drawn may land on the picked one, but the picked one dragged never lands on itself');
  const base = store.mdoc, before = trail()!;
  tools.knotDrag(true);
  tools.moveKnot(0, [30, 0, -60]); // long enough to add spans …
  runFrames();
  tools.moveKnot(0, [10, 0, 0]);   // … then back, and shorter again
  runFrames();
  tools.knotDrag(false);
  const once = cutTrail(base, { ...before, points: [[10, 0, 0], [0, 0, 100]] });
  check(once.ok && store.mdoc.nextId === once.doc.nextId
    && (store.mdoc.tombstones ?? []).join() === (once.doc.tombstones ?? []).join(),
  'drag: the result is one cut of the base, not a pile of every frame\'s ids');
  check(trail()!.points[0].join() === '10,0,0' && shown.knots[0].join() === '10,0,0', 'drag: the point lands where it was dropped');
}

// ---- finishing, and finding it again by its patches ----------------------------------------------------------------
tools.appendKnot([0, 0, 200]);
store.trailPoint = null;
tools.finishCreateTrail();
check(store.surgeryTool === null && surgery === null && tools.selectedTrail()?.id === trail()!.id,
  'finish: drawing stops and the path stays selected');
store.cellSel = [];
check(tools.selectedTrail() === null, 'select: any other selection is not the trail');
tools.syncTrailView();
check(shown.knots.length === 0, 'select: its points hide with it');
const somePatch = quadAt(trail()!.quads[3]);
check(tools.trailAtQuad(somePatch)?.id === trail()!.id && tools.pathCellsAt(somePatch)?.join() === trail()!.quads.join(),
  'select: a patch names the trail that owns it, and its path');
check(tools.withWholePaths([trail()!.quads[3]]).length === trail()!.quads.length, 'select: a box takes the whole path');
store.cellSel = [...trail()!.quads];
check(tools.selectedTrail()?.id === trail()!.id && tools.trailStatus()?.points === 3, 'select: its own patches are the path');

// ---- editing a finished path ---------------------------------------------------------------------------------------
check(tools.resumeEnds().join() === 'start,end', 'add points: with no point picked, either end can grow');
tools.resumeTrail('end');
check(store.surgeryTool === 'trail' && shown.shape?.draw?.end === 'end', 'add points: drawing resumes on the end of the selected path');
tools.appendKnot([0, 0, 300]);
tools.finishCreateTrail();
check(trail()!.points.length === 4 && knotsOf(trail()!).at(-1) === '0,0,300', 'add points: the point goes on the end');

// ---- add points from the picked end: the first point draws onto the start, a middle point offers neither -------
{
  selectPaths(trail()!, 0);
  pick(trail()!, 1);
  check(tools.resumeEnds().length === 0 && tools.selectedPointRole()?.arms === 2 && !tools.selectedPointRole()?.free,
    'add points: a middle point has no end to draw from');
  tools.resumeTrail('end');
  check(store.surgeryTool === null, 'add points: … so nothing resumes');
  pick(trail()!, 3);
  check(tools.resumeEnds().join() === 'end' && tools.selectedPointRole()?.free === true, 'add points: the last point, a free end, draws onto the end only');
  pick(trail()!, 0);
  check(tools.resumeEnds().join() === 'start', 'add points: the first point draws onto the start only');
  const before = trail()!;
  const withHandle: AuthoredTrail = { ...before, paths: [{ ...before.paths[0], handles: [{ out: [1, 0, 2] }] }], pointSettings: [{ widthM: 20 }] };
  store.mdoc = { ...store.mdoc, trails: [withHandle] };
  tools.resumeTrail('start');
  check(store.surgeryTool === 'trail' && shown.shape?.draw?.end === 'start', 'add points: drawing resumes on the start');
  tools.appendKnot([0, 0, -100]);
  const grown = trail()!;
  check(knotsOf(grown).length === 5 && knotsOf(grown)[0] === '0,0,-100' && knotsOf(grown)[1] === before.points[0].join(),
    'add points: the new point goes ahead of the first');
  check(grown.paths[0].handles?.[0] === null && grown.paths[0].handles?.[1]?.out?.join() === '1,0,2' && grown.pointSettings?.[0]?.widthM === 20,
    'add points: every point keeps its own handles and values');
  tools.undoCreateTrailPoint();
  check(knotsOf(trail()!).length === 4 && knotsOf(trail()!)[0] === before.points[0].join() && trail()!.points.length === 4
    && trail()!.paths[0].handles?.[0]?.out?.join() === '1,0,2' && trail()!.pointSettings?.[0]?.widthM === 20,
  'add points: Backspace takes the newest point back off the start');
  tools.finishCreateTrail();
  store.mdoc = { ...store.mdoc, trails: [{ ...trail()!, paths: [{ ...trail()!.paths[0], handles: undefined }], pointSettings: undefined }] };
  selectPaths(trail()!, 0);
}
pick(trail()!, 1);
tools.deleteSelectedTrailKnot();
check(knotsOf(trail()!).length === 3 && knotsOf(trail()!)[1] === '0,0,200', 'delete point: the picked point goes');
selectPaths(trail()!, 0);
tools.setTrailSetting('widthM', 20);
check(trail()!.paths[0].settings.widthM === 20 && store.trailWidth === 20, 'setting: the path re-cuts and the next path starts there');
{
  const owned = resolveTrail(store.mdoc, trail()!)!;
  const [l, , r] = owned.vertices;
  // Width is measured in plan: a bank lifts one rim, which lengthens the 3-D chord but not the plan width.
  const span = Math.hypot(...[0, 2].map(k => store.mdoc.vertices[l * 3 + k] - store.mdoc.vertices[r * 3 + k]) as [number, number]);
  check(Math.abs(span - 20) < 1e-6, 'setting: the new width is cut', `${span}`);
}
// Tile pairs are settings like the rest: a path wears a pair by name, of the built-in ones or the mountain's own.
{
  const tiles = () => [...new Set(resolveTrail(store.mdoc, trail()!)!.quads.map(quad => store.mdoc.quadTex?.[quad] ?? ''))].sort().join();
  check(tiles() === 'MESA/0044.png,MESA/0045.png', 'tiles: a new path wears Mesa’s first pair, and only it — no pair after pair', tiles());
  tools.setTrailSetting('trailTiles', 'MESA/Trail 2');
  check(tiles() === 'MESA/0046.png,MESA/0047.png' && store.trailTilePair === 'MESA/Trail 2',
    'tiles: another pair re-cuts it in that pair, and the next path starts with it', tiles());
  check(tools.addTrailTilePair('trail', 'A/1.png', 'B/2.png') === null && !store.mdoc.trailTilePairs,
    'own pairs: two tiles of two maps make no pair');
  const own = tools.addTrailTilePair('trail', 'A/1.png', 'A/2.png');
  const next = tools.addTrailTilePair('trail', 'A/3.png', 'A/4.png');
  check(own === 'A/Trail 1' && next === 'A/Trail 2' && store.mdoc.trailTilePairs?.length === 2,
    'own pairs: named next among their map’s', `${own} ${next}`);
  tools.setTrailSetting('trailTiles', own);
  check(tiles() === 'A/1.png,A/2.png', 'own pairs: a path wears one of the mountain’s own', tiles());
  tools.editTrailTilePair(own!, { right: 'A/5.png' });
  check(tiles() === 'A/1.png,A/5.png', 'own pairs: changing one re-cuts the paths wearing it', tiles());
  check(!tools.editTrailTilePair(own!, { right: 'B/5.png' }) && tiles() === 'A/1.png,A/5.png',
    'own pairs: a half from another map is refused');
  tools.deleteTrailTilePair(own!);
  check(tiles() === '' && trail()!.paths[0].settings.trailTiles === null && store.trailTilePair === null
    && store.mdoc.trailTilePairs?.map(pair => pair.name).join() === 'Trail 2',
  'own pairs: deleting one leaves the paths wearing it plain, its tiles taken back', tiles());
  tools.deleteTrailTilePair(next!);
  check(!store.mdoc.trailTilePairs, 'own pairs: the last one gone, the document holds none');
  tools.setTrailSetting('trailTiles', 'MESA/Trail 1');
}

// ---- the selected paths move as a unit ---------------------------------------------------------------------------
{
  selectPaths(trail()!, 0);
  const ribbon = resolveTrail(store.mdoc, trail()!)!.vertices;
  const centre = [0, 1, 2].map(k => ribbon.reduce((sum, v) => sum + store.mdoc.vertices[v * 3 + k], 0) / ribbon.length);
  check(shown.knot === null && !!shown.pivot && shown.pivot.every((c, k) => Math.abs(c - centre[k]) < 1e-9),
    'whole: with no point picked the gizmo sits on the path, at its patches’ centre', JSON.stringify(shown.pivot));
  const base = store.mdoc, before = trail()!;
  tools.knotDrag(true);
  tools.transformTrail(shift([40, 5, -10]));
  runFrames();
  tools.transformTrail(shift([50, 0, 0]));
  runFrames();
  tools.knotDrag(false);
  const once = cutTrail(base, { ...before, points: before.points.map(([x, y, z]) => [x + 50, y, z] as V3) });
  const moved = trail()!;
  check(moved.points.every((k, i) => k[0] === before.points[i][0] + 50 && k[2] === before.points[i][2]),
    'whole: every point moves by the drag');
  check(once.ok && moved.vertices.join() === once.trail.vertices.join() && store.mdoc.vertices.join() === once.doc.vertices.join(),
    'whole: what lands is one cut of the drag’s base, its patches carried with it');
  check(moved.quads.every(id => quadIsLocked(store.mdoc, quadAt(id))) && store.cellSel.join() === moved.quads.join(),
    'whole: its patches stay locked and selected');
  pick(trail()!, 0);
  check(shown.knot === 0 && shown.pivot === null, 'whole: a picked point takes the gizmo back');
  store.trailPoint = null;
}

// ---- a new path from any point: a fork, laid with a ghost before each click (docs/023 · Networks) -----------------
{
  selectPaths(trail()!, 0);
  pick(trail()!, 1);
  tools.armPathFrom();
  check(store.surgeryTool === 'trail' && tools.drawingFrom() === 1 && shown.shape?.draw?.path === null && shown.knots.length === 1,
    'fork: drawing a new path starts from the point, its guide from there');
  const from = trail()!.points[1];
  tools.previewHover([from[0] + 90, from[1], from[2] + 40]);
  runFrames();
  check(!!ghostNow()?.length && trail()!.paths.length === 1, 'fork: the hover ghosts the path and its junction before anything is laid', `${ghostNow()?.length}`);
  tools.appendKnot([from[0] + 90, from[1], from[2] + 40]);
  check(trail()!.paths.length === 2 && trail()!.paths[1].points[0] === 1 && trail()!.network?.junctionArms.join() === '3',
    'fork: the first click lays the new path and its junction');
  tools.appendKnot([from[0] + 170, from[1], from[2] + 70]);
  check(trail()!.paths[1].points.length === 3 && shown.knots.length === 3, 'fork: further clicks extend it');
  tools.undoCreateTrailPoint();
  check(trail()!.paths[1].points.length === 2, 'fork: Backspace takes its newest point back');
  tools.appendKnot([from[0] + 170, from[1], from[2] + 70]);
  tools.finishCreateTrail();
  const lists = trailPathQuads(store.mdoc, trail()!)!;
  check(surgery === null && ghostNow() === null && store.cellSel.join() === lists[1].join(),
    'fork: finishing keeps the new path selected — the path, not the network');
  check(tools.trailStatus()?.paths === 1 && tools.trailStatus()?.networkPaths === 2 && tools.trailStatus()?.junctions === 1,
    'fork: one of two paths selected, one junction');

  // A click selects a path; a double-click (or Ctrl+A) the whole network; a box whole paths.
  const fromPath0 = quadAt(lists[0][0]), fromPath1 = quadAt(lists[1][0]);
  check(tools.pathCellsAt(fromPath0)?.join() === lists[0].join() && tools.pathCellsAt(fromPath1)?.join() === lists[1].join(),
    'select: a click on either path’s patch selects that path');
  check(tools.networkCellsAt(fromPath1)?.length === trail()!.quads.length, 'select: a double-click selects the whole network');
  check(tools.withWholePaths([lists[1][2]]).sort().join() === [...lists[1]].sort().join(), 'select: a box takes whole paths');
  selectPaths(trail()!, 1);
  check(tools.selectWholeNetwork() && store.cellSel.length === trail()!.quads.length && tools.trailStatus()?.paths === 2,
    'select: Ctrl+A grows a path to its network');
  check(tools.trailSelection()[0].paths.join() === '0,1', 'select: … both paths');

  // Each path has its own settings: a change applies to the selected paths only.
  selectPaths(trail()!, 1);
  tools.setTrailSetting('widthM', 9);
  check(trail()!.paths[1].settings.widthM === 9 && trail()!.paths[0].settings.widthM === 20,
    'own settings: the selected path takes the change, the other keeps its own');
  check(store.cellSel.join() === trailPathQuads(store.mdoc, trail()!)![1].join(), 'own settings: … and stays selected through the re-cut');
  tools.selectWholeNetwork();
  tools.setTrailSetting('dishPercent', 6);
  check(trail()!.paths.every(path => path.settings.dishPercent === 6), 'own settings: with both selected, both take it');

  // A path's points pick and move; the point it shares moves the other path with it.
  selectPaths(trail()!, 1);
  check(shown.knots.length === 3 && shown.shape?.paths.length === 1, 'fork: a selected path shows its own points');
  const tip = trail()!.paths[1].points[2];
  const at = pick(trail()!, tip);
  const tipAt = trail()!.points[tip];
  tools.moveKnot(at, [tipAt[0] + 5, tipAt[1], tipAt[2]]);
  check(trail()!.points[tip][0] === tipAt[0] + 5, 'fork: its point moves and the trail re-cuts');
  selectPaths(trail()!, 1);
  const shared = trail()!.points[1];
  tools.transformTrail(shift([0, 0, 10]));
  check(trail()!.points[1][2] === shared[2] + 10 && trail()!.points[0][2] === 0,
    'whole: moving one path takes the point it shares — and the other path’s knot there — but nothing else of it');

  // The shared point's own section is the junction's: one value for both paths.
  selectPaths(trail()!, 0);
  pick(trail()!, 1);
  check(tools.selectedPointRole()?.arms === 3 && tools.selectedTrailKnot()?.cut?.widthM === 20,
    'point: a junction point reads the width the focus path cuts it with');
  tools.setTrailKnotSetting('widthM', 30);
  check(trail()!.pointSettings?.[1]?.widthM === 30 && tools.selectedTrailKnot()?.cut?.widthM === 30, 'point: its own width is cut at it');
  tools.setTrailKnotSetting('bankDegrees', 5);
  check(tools.selectedTrailKnot()?.cut?.bankDegrees === 5, 'point: … and its fixed bank');
  tools.setTrailKnotSetting('bankDegrees', undefined);
  check(trail()!.pointSettings?.[1]?.bankDegrees === undefined && trail()!.pointSettings?.[1]?.widthM === 30,
    'point: clearing one value leaves the others');
  tools.resetTrailKnotSettings();
  check(trail()!.pointSettings === undefined && tools.selectedTrailKnot()?.cut?.widthM === 20, 'point: following its paths again drops the values');

  // Deleting the junction point takes it out of both paths: the first runs straight past, the second loses its end.
  const second = trail()!.paths[1].points.length;
  tools.deleteSelectedTrailKnot();
  check(trail()!.paths.length === 2 && trail()!.paths[1].points.length === second - 1 && !trail()!.network?.junctionArms.length,
    'delete point: the junction point goes from both paths, and the junction with it');
  selectPaths(trail()!, 1);
  tools.deleteSelectedTrail();
  check(trail()!.paths.length === 1 && trail()!.points.length === 2, 'delete path: the selected path goes, with the points only it had');
}

selectPaths(trail()!, 0);
const patches = trail()!.quads.length;
tools.dissolveSelectedTrail();
check(!store.mdoc.trails?.length && store.mdoc.quads.length === patches && store.cellSel.length === patches,
  'dissolve: the paths go, the patches stay selected as mesh');

draw([100, 0, 0], [100, 0, 80]);
tools.deleteSelectedTrail();
check(!store.mdoc.trails?.length && store.mdoc.quads.length === patches, 'delete: a path goes with its own patches only');

tools.armCreateTrail();
tools.appendKnot([200, 0, 0]);
tools.finishCreateTrail();
check(!store.mdoc.trails?.length && store.surgeryTool === null, 'finish: a one-point trail is dropped');

// ---- joining: a point laid or dropped on any point becomes it (docs/023 · Networks) --------------------------------
{
  const a = draw([1000, 0, 0], [1000, 0, 100], [1000, 0, 200]);
  const count = store.mdoc.trails!.length;

  // A new trail snaps to the other's points, ghosts the join, and laid on its free end runs on as one path.
  tools.armCreateTrail();
  check(shown.shape?.snaps?.length === 3, 'join: a trail being drawn can snap to the other trail\'s points');
  tools.appendKnot([1100, 0, 300]);
  tools.previewHover([1000, 0, 200]);
  runFrames();
  check(!!ghostNow()?.length, 'join: the ghost shows the two joined');
  tools.appendKnot([1000, 0, 200]);
  check(store.mdoc.trails!.length === count && byId(a).paths.length === 1 && knotsOf(byId(a)).join(' ') === '1000,0,0 1000,0,100 1000,0,200 1100,0,300'
    && store.surgeryTool === null && tools.selectedTrail()?.id === a,
  'join: laid on the other\'s free end, cut alike, the two run on as one path and the drawing ends', knotsOf(byId(a)).join(' '));

  // A new trail's first point on a middle point draws a new path from it.
  tools.armCreateTrail();
  tools.appendKnot([1000, 0, 100]);
  check(store.surgeryTool === 'trail' && tools.drawingFrom() === 1 && tools.selectedTrail()?.id === a,
    'join: a first point on a middle point draws a new path from it instead');
  tools.appendKnot([1090, 0, 140]);
  tools.finishCreateTrail();
  check(byId(a).paths.length === 2 && byId(a).paths[1].points[0] === 1 && store.mdoc.trails!.length === count, 'join: … a fork of that trail');

  // A new trail's first point on a free end goes on drawing that path.
  tools.armCreateTrail();
  tools.appendKnot([1100, 0, 300]);
  check(tools.drawingFrom() === null && tools.trailDrawAnchor()?.join() === '1100,0,300', 'join: a first point on a free end grows that path');
  tools.appendKnot([1150, 0, 380]);
  tools.finishCreateTrail();
  check(knotsOf(byId(a)).at(-1) === '1150,0,380' && byId(a).paths.length === 2, 'join: … by a point on its end');

  // A free end dragged onto the other's first point joins the two there.
  const d = draw([900, 0, -150], [980, 0, -60]);
  selectPaths(byId(d), 0);
  const end = pick(byId(d), 1);
  check(!!shown.shape?.dragSnaps?.some(p => p.join() === '1000,0,0') && !shown.shape?.snaps?.length,
    'join: a picked point snaps to the other trail\'s points; nothing being drawn, no next point snaps');
  tools.knotDrag(true);
  tools.moveKnot(end, [990, 0, -20]);
  runFrames();
  check(!ghostNow(), 'join: a point dragged over no other point ghosts nothing');
  tools.moveKnot(end, [1000, 0, 0]);
  runFrames();
  const merging = ghostNow()?.length ?? 0;
  const own = byId(a).quads.length + byId(d).quads.length;
  check(merging > 0 && merging < own, 'join: on the other’s point, the drag ghosts the merge — the patches it reshapes, not every one',
    `${merging} of ${own}`);
  tools.knotDrag(false);
  check(!ghostNow(), 'join: the drop clears the ghost');
  check(!store.mdoc.trails!.some(other => other.id === d) && knotsOf(byId(a))[0] === '900,0,-150' && byId(a).paths.length === 2
    && store.mdoc.quads.every(corners => corners.length === 4),
  'join: an end dropped on the other\'s end joins them into one path, its old patches gone', knotsOf(byId(a)).join(' '));
  const picked = pickedNow();
  check(picked?.trail === a && byId(a).points[picked.point].join() === '1000,0,0', 'join: the point it became stays picked');

  // A middle point snaps too, but not onto itself or the points beside it.
  selectPaths(byId(a), 0);
  pick(byId(a), byId(a).paths[0].points[2]);
  const snaps = shown.shape?.dragSnaps?.map(p => p.join()) ?? [];
  check(snaps.length > 0 && !snaps.includes('1000,0,0') && !snaps.includes('1000,0,100') && !snaps.includes('1000,0,200'),
    'join: a picked middle point snaps to any point but its own and its neighbours', snaps.join(' '));
  store.trailPoint = null;
}

// ---- a path back onto its own trail: a bypass, a loop; one dragged across another: a crossing --------------------
{
  const t = draw([2000, 0, 0], [2000, 0, 120], [2000, 0, 240], [2000, 0, 360], [2000, 0, 480]);
  selectPaths(byId(t), 0);
  pick(byId(t), 1);
  tools.armPathFrom();
  tools.appendKnot([2070, 0, 180]);
  tools.appendKnot([2080, 0, 240]);
  tools.appendKnot([2070, 0, 300]);
  const snaps = shown.shape?.snaps?.map(p => p.join()) ?? [];
  check(snaps.includes('2000,0,360') && snaps.includes('2000,0,120') && !snaps.includes('2070,0,300'),
    'bypass: drawing, every point snaps but the one it grows from');
  tools.previewHover([2000, 0, 360]);
  runFrames();
  check(!!ghostNow()?.length, 'bypass: the ghost shows it rejoining');
  tools.appendKnot([2000, 0, 360]);
  check(byId(t).paths[1].points.at(-1) === 3 && byId(t).network?.junctionArms.join() === '3,3' && store.surgeryTool === null,
    'bypass: laid on a point of its own trail, the path ends there — a junction at each end — and the drawing ends');

  const ring = draw([2500, 0, 0], [2650, 0, 100], [2500, 0, 250], [2350, 0, 100]);
  selectPaths(byId(ring), 0);
  tools.resumeTrail('end');
  tools.appendKnot([2500, 0, 0]);
  check(byId(ring).paths.length === 1 && byId(ring).paths[0].points.join() === '0,1,2,3,0' && byId(ring).network?.junctionArms.join() === '2',
    'loop: a path laid back onto its own first point closes into a loop');

  const w = draw([4000, 0, 0], [4000, 0, 150], [4000, 0, 300]);
  const x = draw([3850, 0, 160], [3990, 0, 160], [4150, 0, 160]);
  selectPaths(byId(x), 0);
  const middle = pick(byId(x), 1);
  tools.knotDrag(true);
  tools.moveKnot(middle, [4000, 0, 150]);
  runFrames();
  tools.knotDrag(false);
  check(!store.mdoc.trails!.some(other => other.id === x) && byId(w).paths.length === 2 && byId(w).network?.junctionArms.join() === '4',
    'crossing: a middle point dropped on another trail’s middle point crosses the two there — one network, four arms',
    JSON.stringify(byId(w).network));
  store.trailPoint = null;

  // ---- disconnecting a point: each side ends at a point of its own, and comes apart ------------------------------
  const s = draw([5000, 0, 0], [5000, 0, 120], [5060, 0, 220]);
  selectPaths(byId(s), 0);
  pick(byId(s), 1);
  const curve = (of: AuthoredTrail, path: number) => railBezierSegments(pathKnots(of, of.paths[path]), of.paths[path].handles);
  const whole = curve(byId(s), 0);
  const count = store.mdoc.trails!.length;
  tools.disconnectSelectedPoint();
  const other = store.mdoc.trails!.at(-1)!;
  check(store.mdoc.trails!.length === count + 1 && knotsOf(byId(s)).join(' ') === '5000,0,0 5000,0,120'
    && knotsOf(other).join(' ') === '5000,0,120 5060,0,220' && !byId(s).network && !other.network,
  'disconnect: mid-path, the two sides come apart — a trail each, nothing joining them', knotsOf(other).join(' '));
  const picked = pickedNow();
  check(tools.trailSelection().length === 2 && picked?.trail === s && byId(s).points[picked.point].join() === '5000,0,120',
    'disconnect: both sides stay selected, and the clicked path’s side keeps the point picked');
  const sides = [...curve(byId(s), 0), ...curve(other, 0)];
  check(sides.length === whole.length && sides.every((seg, i) => seg.every((p, k) => p.every((v, c) => Math.abs(v - whole[i][k][c]) < 1e-9))),
    'disconnect: the sides keep the curve the path had');
  tools.knotDrag(true);
  tools.moveKnot(shown.knot!, [4985, 0, 120]);
  runFrames();
  tools.knotDrag(false);
  check(knotsOf(byId(s)).at(-1) === '4985,0,120' && knotsOf(byId(other.id))[0] === '5000,0,120' && store.mdoc.trails!.length === count + 1,
    'disconnect: dragged away, the point takes only its own side');

  const f = draw([5300, 0, 0], [5300, 0, 150], [5300, 0, 300]);
  selectPaths(byId(f), 0);
  pick(byId(f), 1);
  tools.armPathFrom();
  tools.appendKnot([5400, 0, 220]);
  tools.finishCreateTrail();
  selectPaths(byId(f), 0);
  pick(byId(f), 1);
  const forked = store.mdoc.trails!.length;
  tools.disconnectSelectedPoint();
  check(store.mdoc.trails!.length === forked + 2
    && [byId(f), ...store.mdoc.trails!.slice(-2)].every(part => part.paths.length === 1 && !part.network),
  'disconnect: at a fork, three sides — three trails, no junction');

  selectPaths(byId(w), 0);
  pick(byId(w), 1);
  const crossed = store.mdoc.trails!.length;
  tools.disconnectSelectedPoint();
  check(store.mdoc.trails!.length === crossed + 3 && !byId(w).network, 'disconnect: at a crossing, four');

  selectPaths(byId(ring), 0);
  pick(byId(ring), 2);
  tools.disconnectSelectedPoint();
  check(byId(ring).paths.length === 1 && knotsOf(byId(ring)).join(' ') === '2500,0,250 2350,0,100 2500,0,0 2650,0,100 2500,0,250'
    && !byId(ring).network, 'disconnect: a loop broken at a point opens there, still one path', knotsOf(byId(ring)).join(' '));
  store.trailPoint = null;
}

// ---- split: a path cut in two at a point, still joined, so each piece can be set on its own ------------------------
{
  const s = draw([6000, 0, 0], [6000, 0, 150], [6000, 0, 300]);
  selectPaths(byId(s), 0);
  pick(byId(s), 0);
  check(tools.selectedPointRole()?.through === 0, 'split: a path’s end has nothing to split');
  pick(byId(s), 1);
  check(tools.selectedPointRole()?.through === 1, 'split: a path runs through its middle point');
  const count = store.mdoc.trails!.length;
  tools.splitSelectedPoint();
  const split = byId(s);
  check(store.mdoc.trails!.length === count && split.points.length === 3 && split.paths.map(path => path.points.join()).join(' ') === '0,1 1,2'
    && split.network?.junctionArms.join() === '2', 'split: two paths meeting at the point, in a joint — nothing comes apart');
  check(tools.trailSelection().find(pick => pick.trail.id === s)?.paths.join() === '0,1' && pickedNow()?.point === 1,
    'split: both pieces stay selected, and the point stays picked');
  selectPaths(byId(s), 1);
  tools.setTrailSetting('trailTiles', 'MESA/Trail 2');
  const lists = trailPathQuads(store.mdoc, byId(s))!;
  const worn = (path: number) => [...new Set(lists[path].map(id => store.mdoc.quadTex?.[quadAt(id)] ?? ''))].sort().join();
  check(worn(0) === 'MESA/0044.png,MESA/0045.png' && worn(1) === 'MESA/0046.png,MESA/0047.png',
    'split: each piece wears its own pair, joint patches too', `${worn(0)} / ${worn(1)}`);
  tools.setTrailSetting('trailTiles', 'MESA/Trail 1');
  store.trailPoint = null;
}

if (failures) process.exitCode = 1;
