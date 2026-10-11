// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { PlacedProp } from '../src/core/doc/types';
import type { PropSub } from '../src/core/reference/props';
import { IMPORTED_PROP_LEVEL, type ImportedPropRecord } from '../src/core/props/imported';
import type { Store } from '../src/app/state/store';
import type { Stage } from '../src/app/viewport/stage';
import type { Viewport } from '../src/app/viewport/viewport';
import { confirmUnloadWithUnsavedWork, holdUnsavedWork, unsavedWork } from '../src/app/state/unsaved-work';

/**
 * A cage-deform draft (docs/032) outlives the editor closing around it: leaving Props or selecting something else
 * parks a changed draft and Props resumes it, a moved placement re-seats it, and every changed draft is mirrored
 * per library record so one that did end — Escape, a deleted placement, a reload — comes back on the next deform.
 */

// The ops share the browser toast helper and localStorage; give them both before importing.
const toasts: string[] = [];
const toastEl = { set textContent(text: string) { toasts.push(text); }, className: '' };
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: () => toastEl } });
Object.defineProperty(globalThis, 'window', { configurable: true,
  value: { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0 } });
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
} });
const { createPropDeformOps, DEFORM_DRAFTS_KEY } = await import('../src/app/props/deform');
const { createPropDeformLayer } = await import('../src/app/viewport/scene/prop-deform');

const pack = (a: Float32Array | Uint32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const source: PropSub = { mat: 0, positions: new Float32Array([0, 0, 0, 600, 0, 0, 0, 100, 0, 600, 100, 0]),
  uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), indices: new Uint32Array([0, 1, 2, 1, 3, 2]) };
const recordFor = (id: number): ImportedPropRecord => ({ id, name: id === 7 ? 'Bridge' : `Bridge v${id}`, tris: 2,
  subs: [{ mat: 0, pos: pack(source.positions), uv: pack(source.uvs), idx: pack(source.indices) }],
  materials: [{ id: 0, tex: 'Custom/bridge.png' }] });
const posts: string[] = [];
Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (input: string, init?: RequestInit) => {
  const url = new URL(input, 'http://editor');
  if (url.pathname === '/api/custom-prop-record') return Response.json(recordFor(Number(url.searchParams.get('id'))));
  if (url.pathname === '/api/custom-prop-deform') { posts.push(String(init?.body)); return Response.json({ id: 9, name: 'Bridge v9' }); }
  return new Response('missing', { status: 404 });
} });

// One placement, its built mesh (absent while the editor hides it, as the real renderer skips hidden ones), and a
// stage whose gizmo the cage layer seats on.
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45);
camera.position.set(0, 20, 50);
let attached: THREE.Object3D | null = null;
const stage = { scene, camera, renderer: { domElement: { clientHeight: 600 } }, gizmo: { dragging: false, enabled: true },
  gizmoKind: null as string | null,
  attachGizmo(object: THREE.Object3D, kind: string) { attached = object; this.gizmoKind = kind; },
  detachGizmo() { attached = null; this.gizmoKind = null; } };
const geometry = new THREE.BufferGeometry();
geometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
const template = new THREE.Group();
template.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial()));
scene.add(template); scene.updateMatrixWorld(true);
const layer = createPropDeformLayer(stage as unknown as Stage, material => material.clone());
const meshes: (THREE.Object3D | undefined)[] = [];
const viewport = { propDeform: layer, stage, props: { placedPropMeshes: meshes }, focusProp: () => true, setGizmoMode() {} };

const placement = (extra: Partial<PlacedProp> = {}): PlacedProp =>
  ({ id: 'prop:0001', level: IMPORTED_PROP_LEVEL, model: 7, name: 'Bridge', pos: [0, 0, 0], yaw: 0, scale: 1, ...extra });
const store = { mdoc: { props: [placement()] }, currentMode: 'props', selectedProp: 0 as number | null,
  gizmoMode: 'move', propLibWanted: false } as unknown as Store;
let project = 'project-a', commits = 0;
const ops = createPropDeformOps({ store, viewport: viewport as unknown as Viewport, projectId: () => project,
  isWritable: () => true, ensureModels: async () => {}, reloadModels: async () => {},
  commit: () => { commits++; }, rebuild: () => {}, tools: () => {} });
holdUnsavedWork(() => ops.unsaved);

/** One render: placed meshes for whatever is not hidden, then the details pass that syncs the deform session. */
function render() {
  meshes.length = 0;
  (store.mdoc.props ?? []).forEach((_, i) => { if (ops.hiddenIndex() !== i) meshes[i] = template; });
  ops.sync();
}
/** Drag the selected cage section by one step, as the gizmo would. */
function drag() {
  layer.dragging(true);
  attached!.position.add(new THREE.Vector3(0, 0, 50));
  layer.changed(); layer.dragging(false);
}
const stored = () => JSON.parse(storage.get(DEFORM_DRAFTS_KEY) ?? '[]') as { project: string; record: number; draft: { slices: number } }[];
const lastToast = () => toasts.at(-1) ?? '';

render();
await ops.start(0);
render();
assert.ok(ops.active && layer.active && ops.hiddenIndex() === 0, 'deform opens on the selected placement');
assert.equal(ops.unsaved, null, 'an untouched cage holds nothing a reload would lose');
assert.deepEqual(stored(), [], 'and stores nothing');

drag();
ops.setMode('corner'); ops.select(5);
assert.ok(ops.state?.canUndo);
assert.equal(stored().length, 1, 'a finished drag mirrors the draft to storage');
assert.equal(stored()[0].record, 7);
assert.match(ops.unsaved ?? '', /Bridge/);
const unload = { prevented: false, returnValue: 'unset', preventDefault() { this.prevented = true; } };
confirmUnloadWithUnsavedWork(unload as unknown as BeforeUnloadEvent);
assert.ok(unload.prevented && unload.returnValue === '', 'the unload guard asks before dropping the draft');
const draftJson = JSON.stringify(ops.state);

// Leaving Props parks the draft (setMode calls leave before switching); returning resumes it with its history
// and picked handle.
ops.leave();
assert.ok(!ops.active && ops.parked && !layer.active, 'leaving Props parks the draft');
store.currentMode = 'edit';
render();
assert.ok(ops.parked, 'and the render in the new mode keeps it parked');
assert.equal(ops.hiddenIndex(), null, 'the placement shows again while parked');
assert.match(lastToast(), /Kept the cage draft for Bridge/);
assert.ok(ops.unsaved, 'a parked draft still counts as unsaved work');
store.currentMode = 'props';
meshes[0] = new THREE.Group(); // a placement whose geometry has not loaded yet: nothing to open around
ops.sync();
assert.ok(ops.parked && !layer.active, 'a resume with no mesh to open around waits, parked, for a later render');
render();
assert.ok(ops.active && layer.active, 'Props showing the placement again resumes the editor');
assert.equal(JSON.stringify(ops.state), draftJson, 'with its draft, undo history and picked corner intact');

// Selecting something else parks it too; the selection coming back resumes it.
store.selectedProp = null; render();
assert.ok(ops.parked);
store.selectedProp = 0; render();
assert.ok(ops.active);

// A remote install replaces the document objects: the session follows the placement by id.
const before = toasts.length;
store.mdoc = structuredClone(store.mdoc);
render();
assert.ok(ops.active && ops.hiddenIndex() === 0, 'a replaced document keeps the session');
// A collaborator moving the placement re-seats the editor around its new pose, quietly.
store.mdoc.props![0].pos = [5, 0, 0];
render();
assert.ok(ops.parked, 'a moved placement closes the stale preview first');
render();
assert.ok(ops.active && JSON.stringify(ops.state) === draftJson, 'and the next render resumes around the new pose');
assert.equal(toasts.length, before, 'without telling the author anything');
// Indices shift: another placement inserted before it.
store.mdoc.props!.unshift(placement({ id: 'prop:0000', model: 3 }));
store.selectedProp = 1;
render();
assert.ok(ops.active && ops.hiddenIndex() === 1, 'the session follows its placement to its new index');

// Escape closes the editor; the stored draft comes back by itself on the next deform of that record.
ops.close();
assert.ok(!ops.active && !ops.parked && !layer.active);
assert.equal(ops.unsaved, null);
assert.match(lastToast(), /Closed the cage draft for Bridge/);
assert.ok(ops.hasStoredDraft(7) && !ops.hasStoredDraft(3));
render();
await ops.start(1);
render();
assert.ok(ops.active && ops.state?.canUndo && ops.unsaved, 'deforming the record again restores its stored draft');
assert.match(lastToast(), /Restored the unapplied cage draft for Bridge/);
ops.undo();
assert.ok(!ops.state?.canUndo && ops.unsaved === null, 'one undo returns to the record’s own cage');
assert.equal(ops.hasStoredDraft(7), false, 'which leaves nothing to restore');
ops.redo();
assert.ok(ops.hasStoredDraft(7), 'and redo keeps it again');

// A clean session that leaves simply ends; nothing is parked.
ops.undo();
store.currentMode = 'edit'; render();
assert.ok(!ops.active && !ops.parked, 'an unchanged draft is not parked');
store.currentMode = 'props'; render();
assert.ok(!ops.active);

// Discard throws a draft away for good.
await ops.start(1); render();
assert.ok(ops.active && !ops.state?.changed && !ops.state?.canUndo, 'nothing stored, nothing restored');
drag();
assert.ok(ops.state?.changed && ops.hasStoredDraft(7));
ops.discard();
assert.ok(!ops.active && !ops.hasStoredDraft(7), 'discard ends the session and forgets the stored draft');
assert.match(lastToast(), /Discarded the cage draft for Bridge/);
render();

// A stored draft that no longer fits the record is dropped, rather than refused on every open.
storage.set(DEFORM_DRAFTS_KEY, JSON.stringify([{ project, record: 7, draft: { cage: { axis: 0, points: [[0, 0, 0]] }, slices: 16 } }]));
render(); await ops.start(1); render();
assert.ok(ops.active && !ops.state?.changed, 'an unfitting draft opens on the record’s own cage');
assert.equal(ops.hasStoredDraft(7), false);
assert.match(lastToast(), /Dropped an older cage draft for Bridge/);
ops.close(); render();

// A parked draft whose placement is deleted, or whose project closes, ends; storage keeps it.
await ops.start(1); render(); drag();
store.currentMode = 'edit'; render();
assert.ok(ops.parked);
store.mdoc.props!.splice(1, 1); render();
assert.ok(!ops.parked && !ops.active, 'a deleted placement ends the parked draft');
assert.match(lastToast(), /placement changed.*bring it back/);
store.mdoc.props!.push(placement({ id: 'prop:0002' }));
store.currentMode = 'props'; store.selectedProp = 1; render();
await ops.start(1); render();
assert.ok(ops.state?.changed, 'the deleted placement’s draft restores onto another placement of its record');
drag();
store.currentMode = 'edit'; render();
project = 'project-b'; render();
assert.ok(!ops.parked, 'a project switch ends it too');
assert.equal(ops.hasStoredDraft(7), false, 'stored drafts are per project');
project = 'project-a';
assert.ok(ops.hasStoredDraft(7));

// Apply lands even when Props was left while it saved, and clears the stored draft.
store.currentMode = 'props'; render();
await ops.start(1); render(); drag();
const saving = ops.apply();
store.currentMode = 'edit'; render();
assert.ok(ops.parked, 'leaving mid-save parks rather than ends');
await saving;
assert.equal(store.mdoc.props![1].model, 9, 'the save still repoints this placement');
assert.equal(store.mdoc.props![0].model, 3, 'and only this one');
assert.equal(posts.length, 1);
assert.ok(!ops.active && !ops.parked && ops.unsaved === null && commits === 2);
assert.equal(ops.hasStoredDraft(7), false, 'an applied draft is no longer offered');
assert.match(lastToast(), /Saved Bridge v9/);

assert.deepEqual(unsavedWork(), []);
const release = holdUnsavedWork(() => 'a test draft');
assert.deepEqual(unsavedWork(), ['a test draft']);
release();
const calm = { prevented: false, preventDefault() { this.prevented = true; } };
confirmUnloadWithUnsavedWork(calm as unknown as BeforeUnloadEvent);
assert.equal(calm.prevented, false, 'nothing held, nothing asked');
console.log('Prop deform drafts: park, resume, re-seat, auto-restore, discard, apply after leaving, and the unload guard passed.');
