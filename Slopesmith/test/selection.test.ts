// tier: fast

/**
 * Headless checks that a SELECTION survives the edits that renumber the mountain (docs/039). Run:
 * `npx tsx test/selection.test.ts`
 *
 * The store remembers what is selected, pinned, captured or frozen; a topology op rewrites the arrays that
 * geometry lives in. Every case below therefore has the same shape: hold something, make an unrelated edit
 * that shifts the numbering, and demand the held thing still means the geometry it meant — with the raw
 * index it was picked at shown to have moved, so a regression to index-addressing fails here rather than
 * silently editing the wrong terrain.
 *
 * The Edit session is driven for real: its viewport port is a structural interface, so a set of no-op
 * closures is a complete stand-in and the selection transitions under test are the ones the editor runs.
 */
import { meshFromNet, starterCourse } from '../src/core/doc/mountain';
import { getVertex } from '../src/core/doc/doc-edit';
import { tombstoned } from '../src/core/doc/ids';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import {
  applyMeshDelete, applySurfaceCut, meshContext, planEdgeExtrusion, validateSurfaceCutPath,
} from '../src/core/mesh/ops';
import { setMeshControlPoints, meshControlPoints, controlPointKey } from '../src/core/mesh/control-points';
import {
  INDEX_NAMING, resolveCellSelection, resolveEdgeSelection, resolveVertexSelection,
} from '../src/core/mesh/selection';
import { copyMeshVertices } from '../src/core/mesh/clipboard';
import { liveQuadEdges } from '../src/core/mesh/primitives';
import {
  edgeIndex, quadIndex, quadName, quadNaming, vertexIndex, vertexName, vertexNames, vertexNaming,
} from '../src/app/state/mesh-names';
// Type-only, so importing it here pulls none of the editor's DOM-bound modules in ahead of the shim below.
import type { EditViewportPort } from '../src/app/edit/session';
import { check, failures } from './check';

const near = (a: V3, b: V3, eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const samePoints = (a: readonly V3[], b: readonly V3[]) => a.length === b.length && a.every((p, i) => near(p, b[i]));

// ---- a small promoted lattice; vertex index = row * COLS + col, quad 0 is the (0,0) corner cell -----------
const ROWS = 6, COLS = 5, SPACING = 10;
const corners: number[] = [];
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) corners.push(r * SPACING, 3 * Math.sin(r + c), c * SPACING);
const lattice = meshFromNet({ rows: ROWS, cols: COLS, spacing: SPACING, corners, paint: {} },
  { name: 'SELECTION', course: starterCourse(), baseSurface: 1 });
const freshGrid = (): QuadMeshDoc => structuredClone(lattice);
const CELL_COLS = COLS - 1;

/**
 * The edit that renumbers everything: quad 0's outer corner (vertex 0) belongs to no other patch, so
 * deleting that one cell retires a vertex AND a quad and slides every surviving index down by one. Anything
 * addressed by position before it addresses its neighbour after.
 */
function deleteCornerCell(doc: QuadMeshDoc): QuadMeshDoc {
  const result = applyMeshDelete(doc, { vertices: [], edges: [], quads: [0] });
  if (!result.ok) throw new Error(result.error);
  return result.doc;
}

// ---- the Edit session, driven headlessly -------------------------------------------------------------------
// The toast module reaches its element at import time and the selection paths schedule their viewport
// refresh on the next frame; neither draws anything here, so the smallest possible stand-ins suffice.
const frames: (() => void)[] = [];
const globals = globalThis as unknown as Record<string, unknown>;
globals.document = { getElementById: () => ({ textContent: '', className: '' }) };
globals.window = { setTimeout: () => 0 };
globals.requestAnimationFrame = (fn: () => void) => { frames.push(fn); return frames.length; };
const flushFrames = () => { const queued = frames.splice(0); for (const fn of queued) fn(); };

const { createStore } = await import('../src/app/state/store');
const { createEditSession } = await import('../src/app/edit/session');
const { commitEditMesh } = await import('../src/app/edit/mesh-target');

type Store = ReturnType<typeof createStore>;

function stubViewport(): EditViewportPort & { readonly regionMarks: readonly V3[] } {
  const noop = () => { /* the port is a rendering surface; nothing under test draws */ };
  let regionMarks: V3[] = [];
  return {
    get regionMarks() { return regionMarks; },
    previewMeshEdit: () => false,
    clearCornerSelection: noop,
    setControlPointSelection: noop,
    setCornerGroup: noop,
    setRegionMarks: positions => { regionMarks = positions.map(position => [...position] as V3); },
    setPlacedPropSelection: noop,
    setEditMixedGroup: noop,
    detachSelectionGizmo: noop,
    narrowReferenceEditSelection: noop,
    refreshEditCells: noop,
    refreshEditEdges: noop,
    refreshHiddenMesh: noop,
    refreshControlCages: noop,
    setBridgeRails: noop,
    setLoftPreview: noop,
    setSurgeryTool: noop,
    setCreatePatchSides: noop,
    setWeldTool: noop,
    setEdgeWeldTool: noop,
    setCreateEdgeTool: noop,
    setCreateEdgeStart: noop,
    setCreateEdgePath: noop,
    get createTubePoints() { return [] as readonly V3[]; },
    get createTrailPoints() { return [] as readonly V3[]; },
    removeLastCreateTrailPoint: noop,
    setCreateTrailSurfaceLift: noop,
    projectedVerticesInsidePatches: () => [],
    setPasteTool: noop,
    get pastePlacing() { return false; },
    get edgeExtrusionStaged() { return false; },
    get edgeExtrusionSideFlippable() { return false; },
    beginEdgeExtrusionStage: () => false,
    flipEdgeExtrusionSide: () => false,
    commitEdgeExtrusionStage: noop,
    cancelEdgeExtrusionStage: noop,
    referenceCopyVertexCount: () => 0,
    copyReferenceMeshSelection: () => null,
    setGizmoMode: noop,
    showHandles: noop,
  };
}

function editor(doc = freshGrid()) {
  const store: Store = createStore({ mdoc: doc, currentMode: 'edit', storedUi: { cageOn: true } });
  const viewport = stubViewport();
  // The real viewport owns reference selection clearing; reproduce that one side effect for visibility actions
  // that deliberately clear their source selection after capturing it.
  viewport.clearCornerSelection = () => {
    store.refVertexSel = []; store.refControlSel = []; store.refEdgeSel = []; store.refCellSel = [];
  };
  const noop = () => { /* host effects (rebuild, persist, toolbox) are not what this suite measures */ };
  const session = createEditSession({
    store,
    viewport: () => viewport,
    cageActive: () => true,
    applyCage: noop,
    persistUi: noop,
    scheduleRebuild: noop,
    scheduleCommit: noop,
    rebuildTools: noop,
    updateCmdSheet: noop,
    refreshSelection: noop,
    log: noop,
  });
  return { store, session, viewport };
}

// ---- Create Patches fills multiple selected holes and selects their newly minted stable identities --------
{
  const doc = freshGrid(), holes = [5, 10], edges = holes.flatMap(q => liveQuadEdges(doc.quads[q]));
  doc.quads = doc.quads.filter((_, q) => !holes.includes(q));
  doc.quadIds = doc.quadIds.filter((_, q) => !holes.includes(q));
  const { store, session } = editor(doc), beforeCount = doc.quads.length;
  edges.forEach((edge, i) => session.viewportCallbacks.onSelectEdge?.(edge, i ? 'toggle' : 'replace'));
  session.createPatchesFromEdges();
  flushFrames();
  check(store.mdoc.quads.length === beforeCount + 2 && store.cellSel.length === 2,
    'create patches: both selected holes are filled in one editor command');
  check(store.cellSel.every((name, i) => quadIndex(store.mdoc, name) === beforeCount + i)
    && store.anchorCell === store.cellSel[0] && store.edgeSel.length === 0 && store.anchorEdge === null,
  'create patches: new patches replace the source edges as the live selection');
  check(store.mdoc.vertexIds.join(',') === doc.vertexIds.join(',') && doc.quads.length === beforeCount,
    'create patches: source document and existing vertex identities remain unchanged');
}
{
  const { store, session } = editor();
  liveQuadEdges(store.mdoc.quads[0]).forEach((edge, i) =>
    session.viewportCallbacks.onSelectEdge?.(edge, i ? 'toggle' : 'replace'));
  const before = store.mdoc, selected = store.edgeSel;
  session.createPatchesFromEdges();
  check(store.mdoc === before && store.edgeSel === selected,
    'create patches: already-filled boundaries leave the document and selection untouched');
}

// ---- a single-edge Rip commits through the editor and selects a live boundary lip ------------------------
{
  const { store, session } = editor();
  const vertexCount = store.mdoc.vertices.length / 3;
  session.viewportCallbacks.onSelectEdge?.([1, COLS + 1], 'replace');
  session.ripEdges();
  flushFrames();
  check(store.mdoc.vertices.length / 3 === vertexCount + 1,
    'single-edge rip: the editor duplicates the boundary endpoint');
  const selected = store.edgeSel[0] && edgeIndex(store.mdoc, store.edgeSel[0]);
  const adj = meshContext(store.mdoc).adj;
  check(store.edgeSel.length === 1 && !!selected
    && adj.edgeQuads.get(`${selected[0]},${selected[1]}`)?.length === 1,
    'single-edge rip: the resulting selection names a live boundary lip');
  check(store.anchorEdge === store.edgeSel[0], 'single-edge rip: the selected lip is the new edge anchor');
}

{
  const { store, session } = editor();
  session.viewportCallbacks.onSelectEdge?.([COLS + 1, COLS + 2], 'replace');
  const before = store.mdoc, selected = store.edgeSel;
  session.ripEdges();
  check(store.mdoc === before && store.edgeSel === selected,
    'single-edge rip: an unsupported interior edge preserves the document and selection');
}

// ---- Create Edge across an opening stays a direct free edge, even with a connected route around it --------
for (const reverse of [false, true]) {
  const doc = freshGrid(), hole = CELL_COLS + 1;
  doc.quads.splice(hole, 1); doc.quadIds.splice(hole, 1);
  const before = structuredClone(doc), { store, session } = editor(doc);
  const endpoints = [COLS + 1, COLS * 2 + 2];
  if (reverse) endpoints.reverse();
  session.armCreateEdge();
  for (const vertex of endpoints)
    session.viewportCallbacks.onCreateEdgePoint?.({ vertex, pos: getVertex(store.mdoc, vertex) });
  session.finishCreateEdge();
  flushFrames();
  check(JSON.stringify(store.mdoc.quads) === JSON.stringify(before.quads)
    && JSON.stringify(store.mdoc.vertices) === JSON.stringify(before.vertices)
    && JSON.stringify(store.mdoc.quadIds) === JSON.stringify(before.quadIds),
  'create edge across gap: both click directions leave all existing patches and corners unchanged');
  const selected = store.edgeSel[0] && edgeIndex(store.mdoc, store.edgeSel[0]);
  check(store.mdoc.freeEdges?.length === 1 && store.edgeSel.length === 1
    && selected?.join(',') === [COLS + 1, COLS * 2 + 2].join(','),
  'create edge across gap: the committed selection is exactly the requested direct connection');
}

// ---- path extrusion captures normal edge selections without enabling transforms on the guide -------------
{
  const { store, session, viewport } = editor();
  let seatedSelection = false;
  Object.defineProperties(viewport, {
    edgeExtrusionStaged: { get: () => true },
    edgeExtrusionMode: { get: () => 'path' },
  });
  viewport.setCornerGroup = positions => { if (positions.length) seatedSelection = true; };
  const before = store.mdoc;
  session.viewportCallbacks.onSelectEdge?.([0, 1], 'replace');
  const captured = store.edgeSel.map(edge => [...edge] as typeof edge);
  session.viewportCallbacks.onExtrudeEdgeSelection?.([]);
  check(store.edgeSel.length === 0 && store.anchorEdge === null,
    'path extrusion: entering Path clears the live source selection and its anchor');
  session.viewportCallbacks.onSelectEdge?.([1, COLS + 1], 'replace');
  session.viewportCallbacks.onSelectEdge?.([COLS + 1, COLS * 2 + 1], 'toggle');
  check(store.edgeSel.length === 2 && store.mdoc === before,
    'path extrusion: normal edge picks gather a guide without modifying its geometry');
  check(!seatedSelection, 'path extrusion: choosing the guide does not attach a move gizmo to it');
  session.viewportCallbacks.onExtrudeEdgeSelection?.(captured);
  check(store.edgeSel.length === 1 && store.edgeSel[0][0] === captured[0][0] && store.edgeSel[0][1] === captured[0][1]
    && store.anchorEdge === store.edgeSel[0] && store.mdoc === before,
  'path extrusion: restoring the captured source replaces the guide without changing the document');
}

// ---- reference visibility sets are transient but otherwise mirror authored H / G --------------------------
{
  const { store, session } = editor();
  store.refCellSel = [7, 11];
  check(session.canHideSelection(), 'reference visibility: a reference patch selection enables H');
  session.hideSelectedMesh();
  check(store.refHiddenQuads.join(',') === '7,11',
    'reference visibility: H retains the selected patch ids in the reference hidden set');
  check(!store.refCellSel.length, 'reference visibility: hiding clears the source selection');

  store.refCellSel = [5, 9];
  session.toggleSelectedControlCages();
  check(store.refControlCageQuads.join(',') === '5,9',
    'reference visibility: G pins selected reference patch cages');
  check(!store.refCellSel.length, 'reference visibility: pinning clears the source selection');
  store.refCellSel = [5, 9];
  check(session.selectedControlCagesVisible(),
    'reference visibility: a fully pinned reference selection reads as visible');
  session.toggleSelectedControlCages();
  check(!store.refControlCageQuads.length,
    'reference visibility: G again removes fully pinned reference patch cages');

  store.refEdgeSel = [[2, 8], [8, 9]];
  session.toggleSelectedControlCages();
  check(store.refControlCageEdges.length === 2,
    'reference visibility: edge selections pin their read-only cubic control cages too');
  session.showAllHidden();
  check(!store.refHiddenQuads.length, 'reference visibility: Alt+H reveals every hidden reference patch');
  session.hideSubCages();
  check(!store.refControlCageEdges.length && !store.refControlCageQuads.length,
    'reference visibility: Hide control cages clears both reference pinned families');
}

// ---- 1. a vertex selection survives a delete BELOW it ------------------------------------------------------
{
  const { store, session } = editor();
  const picked = 4 * COLS + 3;                       // well clear of the corner cell about to go
  const before = getVertex(store.mdoc, picked);
  session.viewportCallbacks.onSelectCorner(picked);
  const name = store.selectedCorner;
  check(typeof name === 'string' && name.includes(':'),
    'store: a picked corner is held by its stable id, not its array position');

  commitEditMesh(store, deleteCornerCell(store.mdoc));
  const now = vertexIndex(store.mdoc, name!);
  check(now !== null && now !== picked,
    `vertex selection: the delete renumbered the mountain (${picked} → ${now})`);
  check(now !== null && near(getVertex(store.mdoc, now), before),
    'vertex selection: the held corner is still the same point after a delete below it');
  check(!near(getVertex(store.mdoc, picked), before),
    'vertex selection: its old index now names a different corner — an index-addressed selection would have moved');
}

// ---- 2. a cell selection survives a loop cut ---------------------------------------------------------------
{
  const { store, session } = editor();
  const picked = 3 * CELL_COLS + 2;
  const cornersBefore = store.mdoc.quads[picked].map(v => getVertex(store.mdoc, v));
  session.viewportCallbacks.onSelectEditCell?.(picked, 'replace');
  check(store.cellSel.length === 1 && store.cellSel[0] === store.mdoc.quadIds[picked],
    'store: a picked cell is held by its stable id');
  const held = store.cellSel[0];

  // cut a loop down an unrelated column: every patch it crosses is split, so the surface the selection sits
  // on is rewritten wholesale even where the arrays happen to keep their order
  const cut = store.mdoc.quads[0];
  session.viewportCallbacks.onLoopCut?.(0, [cut[0], cut[1]], 0.5);
  check(store.mdoc.quads.length > lattice.quads.length, 'cell selection: the loop cut added patches');
  const afterCut = quadIndex(store.mdoc, held);
  check(afterCut !== null && samePoints(store.mdoc.quads[afterCut].map(v => getVertex(store.mdoc, v)), cornersBefore),
    'cell selection: the held patch is still the same four corners after a loop cut');

  // …and once something below it is deleted, the numbering itself moves under the same selection
  commitEditMesh(store, deleteCornerCell(store.mdoc));
  const now = quadIndex(store.mdoc, held);
  check(now !== null && now !== picked, `cell selection: the delete renumbered the patches (${picked} → ${now})`);
  check(now !== null && samePoints(store.mdoc.quads[now].map(v => getVertex(store.mdoc, v)), cornersBefore),
    'cell selection: the held patch is STILL the same four corners after the renumbering');
  check(store.cellSel.length === 1 && store.anchorCell === held,
    'cell selection: the selection and its range anchor both survive untouched');
}

// ---- 3. a pinned sub-cage survives a surface cut -----------------------------------------------------------
{
  const { store, session } = editor();
  const pinned = 4 * CELL_COLS + 3;
  const cornersBefore = store.mdoc.quads[pinned].map(v => getVertex(store.mdoc, v));
  session.viewportCallbacks.onSelectEditCell?.(pinned, 'replace');
  session.toggleSelectedControlCages();
  check(store.controlCageQuads.length === 1 && store.controlCageQuads[0] === lattice.quadIds[pinned],
    'store: a pinned patch cage is held by its stable id');
  check(!store.cellSel.length, 'sub-cage: pinning clears the selection it was taken from');

  // an unrelated surface cut across quad 0, from one boundary edge to the one opposite
  const [A, B, C, D] = store.mdoc.quads[0];
  const path = [{ edge: [A, B] as [number, number], t: 0.5 }, { edge: [C, D] as [number, number], t: 0.5 }];
  check(validateSurfaceCutPath(store.mdoc, path).ok, 'sub-cage: the surface cut fixture is a valid route');
  const result = applySurfaceCut(store.mdoc, path);
  check(result.ok, 'sub-cage: the surface cut applied');
  if (result.ok) {
    commitEditMesh(store, result.doc);
    const now = quadIndex(store.mdoc, store.controlCageQuads[0]);
    check(now !== null && samePoints(store.mdoc.quads[now].map(v => getVertex(store.mdoc, v)), cornersBefore),
      'sub-cage: the pinned patch still names the same four corners after a surface cut');
  }
}

// ---- 4. a clipboard copied BEFORE a topology edit pastes the right geometry after it -----------------------
{
  const { store, session } = editor();
  const copied = 3 * CELL_COLS + 1;
  const cornersBefore = store.mdoc.quads[copied].map(v => getVertex(store.mdoc, v));
  session.viewportCallbacks.onSelectEditCell?.(copied, 'replace');
  session.copySelectedVertices();
  check(session.canPasteVertices(), 'clipboard: a selected patch is captured');

  commitEditMesh(store, deleteCornerCell(store.mdoc));   // …and now the world is renumbered underneath it
  const vertexCount = store.mdoc.vertices.length / 3, quadCount = store.mdoc.quads.length;
  session.pasteSelectedVertices();
  session.viewportCallbacks.onPasteVertices?.([0, 0, 0]);
  flushFrames();

  const appended = Array.from({ length: store.mdoc.vertices.length / 3 - vertexCount }, (_, i) => vertexCount + i);
  check(appended.length === 4 && store.mdoc.quads.length === quadCount + 1,
    `clipboard: the paste appended one patch and its four corners (got ${appended.length} points)`);
  check(samePoints(appended.map(v => getVertex(store.mdoc, v)), cornersBefore),
    'clipboard: the pasted geometry is exactly what was copied, despite the edit in between');
  check(store.regionSel.length === 4
    && store.regionSel.every((name, i) => vertexIndex(store.mdoc, name) === appended[i]),
    'clipboard: the paste leaves the new geometry selected by name');

  // The same named selection copies the same geometry after the edit — which is the whole point: the store's
  // selection still designates the patch it designated, so a second copy is not a different patch.
  const doc = store.mdoc, { mesh, edgeHandle } = meshContext(doc);
  const again = copyMeshVertices({
    mesh, edgeHandle, naming: vertexNaming(doc), quadNaming: quadNaming(doc),
    selectedVertices: vertexNames(doc, doc.quads[quadIndex(doc, lattice.quadIds[copied])!]),
    selectedQuads: [lattice.quadIds[copied]],
  });
  check(!!again && again.quads.length === 1
    && samePoints(Array.from({ length: 4 }, (_, i) => [again.vertices[i * 3], again.vertices[i * 3 + 1], again.vertices[i * 3 + 2]] as V3), cornersBefore),
    'clipboard: re-copying through the held names lands on the same patch after the edit');
}

// ---- 5. a frozen extrusion plan still names what it named --------------------------------------------------
{
  const doc = freshGrid();
  const rim: [number, number] = [2, 3];                 // a top-row rim edge, clear of the corner cell
  const planned = planEdgeExtrusion(doc, [rim], null);
  check(planned.ok, 'extrusion: the rim fixture plans');
  if (planned.ok) {
    // The layer freezes the plan and its names together; this is exactly what `planIntact` compares.
    const names = vertexNames(doc, planned.plan.vertices);
    const wanted = planned.plan.vertices.map(v => getVertex(doc, v));
    check(names.length === planned.plan.vertices.length, 'extrusion: every planned point had a name to freeze');

    const after = deleteCornerCell(doc);
    const intact = planned.plan.vertices.every((index, at) => vertexIndex(after, names[at]) === index);
    check(!intact, 'extrusion: the frozen INDICES no longer address the geometry they were planned over');
    check(names.every((name, at) => {
      const now = vertexIndex(after, name);
      return now !== null && near(getVertex(after, now), wanted[at]);
    }), 'extrusion: the frozen NAMES still address exactly the points the plan was built from');
    check(planned.plan.vertices.some((index, at) => !near(getVertex(after, index), wanted[at])),
      'extrusion: replaying the plan on its frozen indices would move different corners — which is what the name check refuses');
  }
}

// ---- 6. a selection naming tombstoned geometry is dropped quietly ------------------------------------------
{
  const { store, session } = editor();
  const doomed = [0, 1, COLS, COLS + 1];                // quad 0's corners
  const kept = 4 * COLS + 3;
  session.viewportCallbacks.onSelectCorners([...doomed, kept], 'replace');
  check(store.regionSel.length === 5, 'tombstones: five corners selected by name');
  const doomedName = vertexName(store.mdoc, 0)!;

  commitEditMesh(store, deleteCornerCell(store.mdoc));
  check(tombstoned(store.mdoc, doomedName), 'tombstones: the deleted corner is retired by name');
  check(store.regionSel.includes(doomedName), 'tombstones: the selection still holds the retired name — nothing rewrote it');
  check(vertexIndex(store.mdoc, doomedName) === null,
    'tombstones: a retired name resolves to nothing rather than to whoever took its index');

  // Everything the editor does with that selection simply works on what is left. Nothing throws, nothing
  // resurrects the deleted corner, and the four survivors are still the four survivors.
  const survivors = store.regionSel.filter(name => vertexIndex(store.mdoc, name) !== null);
  check(survivors.length === 4, `tombstones: four of the five names still resolve (got ${survivors.length})`);
  let raised: unknown = null;
  try {
    session.creaseVertices(store.regionSel);
    session.viewportCallbacks.onMoveCorners?.([0, 0, 0]);
    session.hideSelectedMesh();
  } catch (error) { raised = error; }
  check(raised === null, 'tombstones: acting on a selection that names deleted geometry raises nothing');

  // The same quietness at the core write boundary: a control-point target naming a retired vertex is dropped.
  const before = store.mdoc.vertices.slice();
  const moved = setMeshControlPoints(store.mdoc, [{ id: { kind: 'vertex', vertex: doomedName }, pos: [999, 999, 999] }]);
  check(moved === 0 && store.mdoc.vertices.every((v, i) => v === before[i]),
    'tombstones: a control-point write to a retired name moves nothing and reports nothing moved');

  // A name nobody ever minted behaves the same way here — the document simply does not carry it.
  check(vertexIndex(store.mdoc, 'nowhere:0') === null && !tombstoned(store.mdoc, 'nowhere:0'),
    'tombstones: an unknown name is distinguishable from a retired one');
}

// ---- 7. an Edit marquee holds every enabled family until its count chooser narrows it ----------------------
{
  const { store, session, viewport } = editor();
  store.mdoc.props = [0, 1].map(index => ({
    id: `prop:000${index}`, level: 'DONOR', model: index, name: `prop ${index}`,
    pos: [index * 10, 0, 0] as V3, yaw: 0, scale: 1,
  }));
  const pointIds = [1, 2].map(vertex => ({ kind: 'vertex' as const, vertex: vertexName(store.mdoc, vertex)! }));
  const edges: [number, number][] = [[1, 2], [2, 3]];
  const patches = [1, 2];
  session.viewportCallbacks.onSelectEditMarquee?.({ points: pointIds, edges, patches, props: [0, 1] }, 'replace');

  check(store.controlSel.length === 2 && store.edgeSel.length === 2 && store.cellSel.length === 2 && store.multiSel.length === 2,
    'mixed marquee: points, edges, patches, and props coexist in one atomic selection');
  check(session.mixedEditSelection() && session.transformSelectionActive() && session.rotatableSelection(),
    'mixed marquee: the count chooser also exposes one shared Move / Rotate transform target');
  session.setGizmoMode('rotate');
  check(store.gizmoMode === 'rotate', 'mixed marquee: its shared gizmo can switch to Rotate');
  session.setGizmoMode('scale');
  check(store.gizmoMode === 'rotate', 'mixed marquee: Scale remains unavailable because mixed types have no shared scale contract');
  session.setGizmoMode('move');
  check(store.edgeSel.every(edge => typeof edge[0] === 'string') && store.cellSel.every(cell => typeof cell === 'string'),
    'mixed marquee: mesh indices are converted to stable names before entering the store');

  const overlapVertex = 2;
  const overlapBefore = getVertex(store.mdoc, overlapVertex);
  const propBefore = [...store.mdoc.props[0].pos] as V3;
  const delta: V3 = [3, 4, 5];
  session.viewportCallbacks.onMoveMixedEditSelection?.(delta);
  check(near(getVertex(store.mdoc, overlapVertex), overlapBefore.map((value, axis) => value + delta[axis]) as V3),
    'mixed marquee: a vertex shared by point, edge, and patch families receives the move exactly once');
  check(viewport.regionMarks.length === pointIds.length
    && near(viewport.regionMarks[1] as V3, getVertex(store.mdoc, overlapVertex)),
    'mixed marquee: selected vertex marks follow their live positions during the combined drag');
  check(near(store.mdoc.props[0].pos, propBefore.map((value, axis) => value + delta[axis]) as V3),
    'mixed marquee: the same gizmo delta carries selected props with the mesh');

  const rotateRigidTarget: V3 = [20, 30, 40];
  const rotateDirectTarget: V3 = [21, 31, 41];
  const rotatePropTarget: V3 = [8, 9, 10];
  session.viewportCallbacks.onRotateMixedEditSelection?.({
    corners: {
      vertices: [{ vertex: pointIds[1].vertex, pos: rotateRigidTarget }],
      edgeHandles: [],
      quadTwist: [],
    },
    // A selected point can overlap topology reached through an edge or patch. The direct point target wins,
    // so a combined rotation still applies one absolute result rather than accumulating two transforms.
    controlPoints: [{ id: pointIds[1], pos: rotateDirectTarget }],
    props: [{ index: 0, pos: rotatePropTarget, yaw: 45, pitch: 12, roll: 0 }],
  });
  check(near(getVertex(store.mdoc, overlapVertex), rotateDirectTarget),
    'mixed marquee: overlapping point and topology rotation resolves to the direct point target exactly once');
  check(near(store.mdoc.props[0].pos, rotatePropTarget) && store.mdoc.props[0].yaw === 45
    && store.mdoc.props[0].pitch === 12 && store.mdoc.props[0].roll === undefined,
    'mixed marquee: group rotation updates a prop origin and its full authored rotation, storing no zero tilt');

  const floating = meshControlPoints(store.mdoc).find(point => point.id.kind === 'edge')!;
  const floatingBefore = [...floating.pos] as V3;
  session.viewportCallbacks.onSelectEditMarquee?.({ points: [floating.id], edges: [[1, 2]], patches: [], props: [0] }, 'replace');
  session.viewportCallbacks.onMoveMixedEditSelection?.(delta);
  const floatingAfter = meshControlPoints(store.mdoc).find(point => controlPointKey(point.id) === controlPointKey(floating.id))!.pos;
  check(near(floatingAfter, floatingBefore.map((value, axis) => value + delta[axis]) as V3),
    'mixed marquee: an explicitly selected floating point overlapping moved topology receives the delta once');

  session.viewportCallbacks.onSelectEditMarquee?.({ points: pointIds, edges, patches, props: [0, 1] }, 'replace');
  session.narrowEditSelection('prop');
  check(!store.controlSel.length && !store.edgeSel.length && !store.cellSel.length && store.multiSel.join(',') === '0,1',
    'mixed marquee: choosing Props keeps only the prop set for its type-specific toolbox');
  check(!session.mixedEditSelection(),
    'mixed marquee: a narrowed prop set leaves the chooser state');

  session.viewportCallbacks.onSelectEditMarquee?.({ points: pointIds, edges, patches, props: [0, 1] }, 'replace');
  session.narrowEditSelection('edge');
  check(!store.controlSel.length && store.edgeSel.length === 2 && !store.cellSel.length && !store.multiSel.length,
    'mixed marquee: choosing Edges keeps only the edge set for the existing edge toolbox');

  session.viewportCallbacks.onSelectEditMarquee?.({ points: [], edges: [], patches: [3], props: [] }, 'add');
  check(store.edgeSel.length === 2 && store.cellSel.length === 1 && session.mixedEditSelection(),
    'mixed marquee: Shift-drag adds newly boxed families without replacing the retained set');
  session.viewportCallbacks.onSelectEditMarquee?.({ points: [], edges, patches: [], props: [] }, 'remove');
  check(!store.edgeSel.length && store.cellSel.length === 1 && !session.mixedEditSelection(),
    'mixed marquee: Ctrl-drag removes boxed members and returns to one type when only patches remain');

  session.deselectEdit();
  session.viewportCallbacks.onToggleCorner?.(1);
  session.viewportCallbacks.onSelectEdge?.([1, 2], 'toggle');
  session.viewportCallbacks.onSelectEditCell?.(1, 'toggle');
  session.toggleEditProp(0);
  check(store.controlSel.length === 1 && store.edgeSel.length === 1 && store.cellSel.length === 1
    && store.multiSel.join(',') === '0' && session.mixedEditSelection(),
    'Ctrl-click: point, edge, patch, and prop toggles accumulate across families');

  session.viewportCallbacks.onSelectEdge?.([1, 2], 'toggle');
  check(store.controlSel.length === 1 && !store.edgeSel.length && store.cellSel.length === 1 && store.multiSel.length === 1,
    'Ctrl-click: toggling an edge off preserves the selected point, patch, and prop');
  session.viewportCallbacks.onToggleCorner?.(1);
  check(!store.controlSel.length && store.cellSel.length === 1 && store.multiSel.length === 1 && session.mixedEditSelection(),
    'Ctrl-click: toggling a point off preserves the other selected families and their mixed state');
  session.viewportCallbacks.onSelectControlPoints?.([floating.id], 'toggle');
  check(store.controlSel.length === 1 && store.controlSel[0].kind === 'edge'
    && store.cellSel.length === 1 && store.multiSel.length === 1,
    'Ctrl-click: floating cage points also accumulate beside selected patches and props');
  session.viewportCallbacks.onSelectControlPoints?.([floating.id], 'toggle');
  check(!store.controlSel.length && store.cellSel.length === 1 && store.multiSel.length === 1,
    'Ctrl-click: toggling a floating cage point off leaves the other families intact');
}

// ---- 8. the reference families still work on indices -------------------------------------------------------
{
  // The reference mesh is rebuilt by position-dedup on every load and never edited, so its numbering IS its
  // identity: the shared resolvers take the identity naming and behave exactly as they did (docs/039).
  const doc = freshGrid();
  const { mesh, adj, edgeHandle } = meshContext(doc);
  const topo = mesh.topology;

  const e0: [number, number] = [2 * COLS + 1, 2 * COLS + 2];
  const e1: [number, number] = [2 * COLS + 2, 2 * COLS + 3];
  let edges = resolveEdgeSelection([], null, e0, 'replace', mesh, adj, INDEX_NAMING);
  check(edges.edges.length === 1 && edges.edges[0][0] === e0[0] && edges.edges[0][1] === e0[1],
    'reference: an edge pick stays a pair of indices');
  edges = resolveEdgeSelection(edges.edges, edges.anchor, e1, 'toggle', mesh, adj, INDEX_NAMING);
  check(edges.edges.length === 2, 'reference: ctrl-toggle accumulates index edges');
  const run = resolveEdgeSelection([e0], e0, e1, 'range', mesh, adj, INDEX_NAMING);
  check(run.edges.length === 2, `reference: shift-range walks the loop in indices (2, got ${run.edges.length})`);

  const verts = resolveVertexSelection([2 * COLS + 1], 2 * COLS + 1, 2 * COLS + 3, 'range', adj, INDEX_NAMING);
  check(verts.verts.length === 3 && verts.verts.every(v => Number.isInteger(v)),
    'reference: a vertex range stays a run of indices');

  const cells = resolveCellSelection([1], 1, 3, 'range', INDEX_NAMING, topo);
  check(cells.cells.length === 3 && cells.cells.every(c => Number.isInteger(c)),
    'reference: a cell range stays a strip of indices');

  const clip = copyMeshVertices({ mesh, edgeHandle, naming: INDEX_NAMING, selectedVertices: doc.quads[3], selectedQuads: [3] });
  check(!!clip && clip.quads.length === 1 && clip.vertices.length === 12,
    'reference: the clipboard copies an index-named patch through the identity naming');

  // …while the authored surface reaches the same helpers through its document's ids.
  const named = resolveCellSelection([quadName(doc, 1)!], quadName(doc, 1)!, quadName(doc, 3)!, 'range', quadNaming(doc), topo);
  check(named.cells.length === 3 && named.cells.every(c => typeof c === 'string'),
    'authored: the same cell range returns stable ids');
  check(named.cells.map(c => quadIndex(doc, c)).sort((a, b) => a! - b!).join(',') === cells.cells.sort((a, b) => a - b).join(','),
    'authored + reference: one implementation, the same strip either way');
}

// ---- 9. the named vocabulary itself ------------------------------------------------------------------------
{
  const doc = freshGrid();
  check(vertexName(doc, 0) === doc.vertexIds[0] && quadName(doc, 0) === doc.quadIds[0],
    'names: a live index names the id the document carries there');
  check(vertexIndex(doc, doc.vertexIds[7]) === 7 && quadIndex(doc, doc.quadIds[5]) === 5,
    'names: a name resolves back to its own index');
  const edge = edgeIndex(doc, [doc.vertexIds[3], doc.vertexIds[1]]);
  check(!!edge && edge[0] === 1 && edge[1] === 3, 'names: a named edge resolves to a canonical index pair');
  check(vertexName(doc, doc.vertices.length) === null && quadIndex(doc, 'nowhere:1') === null,
    'names: an address the document does not carry resolves to nothing');

  // Control points are the third named family: what the sub-cage picks, pins and moves.
  const points = meshControlPoints(doc);
  const corner = points.find(cp => cp.id.kind === 'vertex')!;
  check(corner.id.kind === 'vertex' && corner.id.vertex === doc.vertexIds[0],
    'names: a control point names its corner by id');
  const twist = points.find(cp => cp.id.kind === 'twist')!;
  check(twist.id.kind === 'twist' && twist.id.quad === doc.quadIds[0],
    'names: an interior twist point names its patch by id');
  check(controlPointKey(corner.id) === `v:${doc.vertexIds[0]}`,
    'names: the control-point key is built from those ids');
}

// ---- 10. lights and gems: the object families whose selection is an id -------------------------------------
// The same rule one level up from the mesh. A light or a gem is named `light:NNNN` / `gem:NNNN` (`core/doc/ids`),
// and the selection holds that name rather than a slot — so a delete that shifts the list, whoever made it,
// leaves the selection on the object it was on. Both layers are DOM-free by construction (their markers are
// built as data textures, `scene/source-markers.ts`), so the real ones run here against a stand-in stage.
{
  const THREE = await import('three');
  const { createLightsLayer } = await import('../src/app/viewport/scene/lights');
  const { createGemsLayer } = await import('../src/app/viewport/scene/gems');

  const picked: { light: string | null; gem: string | null } = { light: null, gem: null };
  function stubStage() {
    const stage = {
      scene: new THREE.Group(),
      worldRoot: new THREE.Group(),
      gizmoKind: null as string | null,
      gizmo: { dragging: false },
      cb: {
        onSelectLight: (id: string | null) => { picked.light = id; },
        onSelectGem: (id: string | null) => { picked.gem = id; },
      },
      attachGizmo: (_object: unknown, kind: string) => { stage.gizmoKind = kind; },
      detachGizmo: () => { stage.gizmoKind = null; },
    };
    return stage;
  }
  /** Where the layer's move handle sits, back in data space — the scene negates Z. */
  const seatedAt = (handle: { position: { x: number; y: number; z: number } }): V3 =>
    [handle.position.x, handle.position.y, -handle.position.z];

  const lights = [0, 1, 2].map(n => ({
    id: `light:000${n}`, kind: 'point' as const, pos: [n * 10, 5, 0] as V3,
    color: '#ffd9a0', intensity: 2, reach: 30,
  }));
  const lightStage = stubStage();
  const lightLayer = createLightsLayer(lightStage as never);
  const lightHandle = lightStage.scene.children[0];
  lightLayer.setFreeLights(lights, 'light:0001');
  check(lightLayer.selectedLight === 'light:0001' && near(seatedAt(lightHandle), lights[1].pos),
    'lights: the move gizmo seats on the light the selection names');
  lightLayer.setFreeLights(lights.slice(1), 'light:0001');
  check(lightLayer.selectedLight === 'light:0001' && near(seatedAt(lightHandle), lights[1].pos),
    'lights: deleting the light BELOW the selected one leaves the selection on the same light — the index it '
    + 'sits at moved, the selection did not');
  lightLayer.seatLight(1);
  check(picked.light === 'light:0002' && lightLayer.selectedLight === 'light:0002',
    'lights: a pick lands on a slot, and the host is told which light that is by name');
  lightLayer.setFreeLights([lights[0]], 'light:0002');
  check(lightLayer.selectedLight === null && lightStage.gizmoKind === null,
    'lights: deleting the selected light itself drops the selection rather than sliding it onto a neighbour');

  const gems = [0, 1, 2].map(n => ({ id: `gem:000${n}`, pos: [n * 10, 2, 0] as V3, value: 2 }));
  const gemStage = stubStage();
  const gemLayer = createGemsLayer(gemStage as never, {} as never);
  const gemHandle = gemStage.scene.children[0];
  gemLayer.setGems(gems, 'gem:0001');
  check(gemLayer.selectedGem === 'gem:0001' && near(seatedAt(gemHandle), gems[1].pos),
    'gems: the move gizmo seats on the gem the selection names');
  gemLayer.setPlayMode('race');
  check(!gemLayer.gemGroup.visible, 'gems: Race Test setup hides the native Showoff-only pickup layer');
  gemLayer.setPlayMode('showoff');
  check(gemLayer.gemGroup.visible, 'gems: Showoff Test setup reveals its pickup layer');
  gemLayer.setPlayMode('freeride');
  check(!gemLayer.gemGroup.visible, 'gems: Freeride Test setup hides the native Showoff-only pickup layer');
  gemLayer.setPlayMode(null);
  check(gemLayer.gemGroup.visible, 'gems: leaving Test restores the editor Tricks view');
  gemLayer.setGems(gems.slice(1), 'gem:0001');
  check(gemLayer.selectedGem === 'gem:0001' && near(seatedAt(gemHandle), gems[1].pos),
    'gems: and a gem deleted below the selected one moves its index, not the selection');
  gemLayer.seatGem(1);
  check(picked.gem === 'gem:0002' && gemLayer.selectedGem === 'gem:0002',
    'gems: a pick reports the gem it landed on by name too');
}

console.log(failures ? '\nSELECTION: FAIL' : '\nSELECTION: PASS');
process.exit(failures ? 1 : 0);
