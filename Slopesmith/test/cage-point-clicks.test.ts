// tier: fast

import * as THREE from 'three';
import { createPointerRouter } from '../src/app/viewport/input/pointer-router';
import type { MeshControlPointId } from '../src/core/mesh/control-points';
import { check, failures } from './check';

/**
 * How Edit's clicks reach the points of a pinned control cage. Ctrl-click toggles a point and Shift-click ranges
 * to it; the gizmo of the selected point is drawn over its neighbours, so a Ctrl press there has to reach the
 * point rather than start a drag — while a plain press on the gizmo still drags.
 */

const handlers = new Map<string, ((event: PointerEvent) => void)[]>();
const dom = {
  style: {}, setPointerCapture() {}, releasePointerCapture() {},
  addEventListener(type: string, handler: (event: PointerEvent) => void) { handlers.set(type, [...handlers.get(type) ?? [], handler]); },
};
const sent: { ids: MeshControlPointId[]; mode: string }[] = [];
const cornerCalls: string[] = [];
const stage = {
  scene: new THREE.Scene(), worldRoot: new THREE.Group(),
  renderer: { domElement: dom }, controls: { enabled: true }, container: { ...dom, clientWidth: 800, clientHeight: 600 },
  marqueeEl: { style: {} }, gizmo: { enabled: true, axis: null as string | null, object: null, dragging: false },
  castAt() {}, attachGizmo() {}, detachGizmo() {},
  cb: {
    onSelectKnot() {}, onSelectCorner() {}, onSelectEdgeCrossing() {}, onSelectCoincidentVertices() {},
    onSelectControlPoints(ids: MeshControlPointId[], mode: string) { sent.push({ ids, mode }); },
    onToggleCorner(i: number) { cornerCalls.push(`toggle ${i}`); },
    onRangeSelectCorner(i: number) { cornerCalls.push(`range ${i}`); },
  },
};
let point: MeshControlPointId | null = null, corner: number | null = null;
const cage = { cage: true, subCage: true, visibleNubs: () => [] };
const layers = {
  edgeExtrusion: { active: false, dragging: false, staged: false }, rideCtl: { riding: false },
  cameraCtl: { activePointers: new Set(), touchPts: new Map(), orbiting: false, flying: false },
  picking: {
    vertexSourceAtPointer: () => 'authored', pickSubCagePoint: () => point, pickReferenceSubCagePoint: () => null,
    pickCorner: () => corner, pickFreeEdgeAt: () => null,
  },
  selection: {
    clearRefLoops() {}, placeCornerMarker() {}, referenceMeshSelectionActive: () => false,
    authoredMeshSelectionActive: () => false, cageHandleMeshes: [], controlPointSel: [] as MeshControlPointId[],
  },
  cage, transforms: { mode: 'move' },
  clipboardPlacement: { active: false }, surgery: { tool: null, onCommit: () => false },
  tubeTool: { active: false }, trailTool: { active: false, pickKnot: () => false }, pathHandles: { pickHandle: () => false }, patchTool: { active: false }, weldTool: { active: false },
  createEdge: { armed: false, pickCoincidentVertices: () => null, pickEdgeCrossing: () => null },
  gems: { gemLine: null },
} as unknown as Parameters<typeof createPointerRouter>[2];
const access = {
  mode: () => 'edit', isMountain: () => true, reference: () => null, refData: () => null, preview: () => null,
  pickAnchor: () => undefined, pickKnot: () => undefined,
  meshDoc: () => ({ vertexIds: ['v:a', 'v:b', 'v:c'] }),
};
const router = createPointerRouter(stage as unknown as Parameters<typeof createPointerRouter>[0],
  { editPickKinds: { point: true, edge: true, patch: true, prop: false }, edgeSel: [], cellSel: [] } as unknown as Parameters<typeof createPointerRouter>[1],
  layers, access as unknown as Parameters<typeof createPointerRouter>[3], { selectReference() {}, clearRefSelection() {} });

function click(mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}, types = ['pointerdown', 'pointerup']) {
  for (const type of types) {
    const event = { type, button: 0, pointerId: 1, pointerType: 'mouse', clientX: 400, clientY: 300,
      ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...mods, target: dom,
      preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} } as unknown as PointerEvent;
    for (const handler of handlers.get(type) ?? []) handler(event);
  }
}

const tangent: MeshControlPointId = { kind: 'edge', from: 'v:a', to: 'v:b' };

// No gizmo under the cursor: a plain click selects, Ctrl toggles, Shift ranges.
point = tangent;
click();
click({ ctrlKey: true });
click({ shiftKey: true });
check(sent.map(s => s.mode).join() === 'replace,toggle,range' && sent.every(s => s.ids[0] === tangent),
  'cage point: plain click replaces, Ctrl-click toggles, Shift-click ranges', sent.map(s => s.mode).join());

// The selected point's gizmo is hovered over the neighbour. A plain press is the gizmo's drag…
sent.length = 0;
stage.gizmo.axis = 'X';
click();
check(!sent.length && stage.gizmo.enabled, 'gizmo hovered: a plain press is left to the gizmo');
// …but a Ctrl press over a point passes the gizmo by, toggles the point, and gives the gizmo back.
const down = { type: 'pointerdown', button: 0, pointerId: 1, pointerType: 'mouse', clientX: 400, clientY: 300,
  ctrlKey: true, shiftKey: false, metaKey: false, altKey: false, target: dom,
  preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} } as unknown as PointerEvent;
for (const handler of handlers.get('pointerdown') ?? []) handler(down);
check(!stage.gizmo.enabled, 'gizmo hovered: a Ctrl press over a cage point disables the gizmo before its own listener sees it');
for (const handler of handlers.get('pointerup') ?? []) handler({ ...down, type: 'pointerup' } as PointerEvent);
check(sent.length === 1 && sent[0].mode === 'toggle', 'gizmo hovered: and the release toggles the point under it');
await new Promise(resolve => setTimeout(resolve, 0));
check(stage.gizmo.enabled, 'gizmo hovered: the gizmo is back once the press has been dispatched');
// A Ctrl press on the gizmo with no point beneath it stays the gizmo's.
sent.length = 0;
point = null;
click({ ctrlKey: true });
check(!sent.length && stage.gizmo.enabled, 'gizmo hovered: a Ctrl press on bare gizmo is still the gizmo\'s');
stage.gizmo.axis = null;

// Corners: with a control cage pinned a Shift-click ranges over the lattice (the host falls back to the corner
// block); with none pinned it stays the corner range, and Ctrl stays the corner toggle.
sent.length = 0;
corner = 1;
click({ shiftKey: true });
check(sent.length === 1 && sent[0].mode === 'range' && sent[0].ids[0].kind === 'vertex'
  && (sent[0].ids[0] as { vertex: string }).vertex === 'v:b' && !cornerCalls.length,
'corner: with a cage pinned, Shift-click ranges by name over the control lattice');
cage.subCage = false;
click({ shiftKey: true });
click({ ctrlKey: true });
check(cornerCalls.join() === 'range 1,toggle 1' && sent.length === 1,
  'corner: with no cage pinned, Shift and Ctrl keep the corner range and toggle', cornerCalls.join());

// Create Edge: in a busy map a corner is nearly always under the cursor. The first point sticks to it (a click
// has no other depth); later points stay free at the chain depth unless Ctrl is held — or a provisional surface
// cut is under way, which only an edge or a point can continue.
const created: { vertex: number | null }[] = [];
const ghosts: boolean[] = [];
Object.assign(stage, { pickSurface: () => null, screenPlanePoint: () => new THREE.Vector3(5, 6, 7) });
Object.assign(stage.cb, { onCreateEdgePoint: (endpoint: { vertex: number | null }) => created.push(endpoint) });
Object.assign(layers.picking, { cornerPos: () => [1, 2, 3], pickAnyEdgeAt: () => null });
Object.assign(access, { snapPoint: (p: number[]) => p, terrain: () => null, net: () => null, createEdgePreviewChanged() {} });
for (const tool of ['clipboardPlacement', 'patchTool', 'tubeTool', 'trailTool', 'weldTool', 'surgery'] as const) {
  Object.assign(layers[tool], { onHover: () => false });
}
const edgeLayer = Object.assign(layers.createEdge, {
  armed: true, start: null as number[] | null, cutting: false,
  showGhost: (_pos: unknown, snapped: boolean) => ghosts.push(snapped),
});
corner = 2;
click();
edgeLayer.start = [0, 0, 0];
click();
click({ ctrlKey: true });
edgeLayer.cutting = true;
click();
edgeLayer.cutting = false;
check(created.map(e => e.vertex ?? 'free').join() === '2,free,2,2',
  'create edge: the first point sticks, a later one only under Ctrl or mid surface cut',
  created.map(e => e.vertex ?? 'free').join());
// The ghost follows the key itself: pressing Ctrl over a corner snaps it without moving the mouse.
click({}, ['pointermove']);
router.refreshCreateEdgeGhost(false, true);
router.refreshCreateEdgeGhost(false, false);
check(ghosts.join() === 'false,true,false', 'create edge: the hover ghost re-seats on a Ctrl press and release', ghosts.join());

if (failures) process.exitCode = 1;
