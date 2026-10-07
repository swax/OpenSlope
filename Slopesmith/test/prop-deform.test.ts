// tier: fast
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PropSub } from '../src/core/reference/props';
import type { ImportedPropRecord } from '../src/core/props/imported';
import {
  bakePropDeformation, cageFolded, cageWeights, createPropCage, decodeDeformSource,
  deformPoint, deformSource, subdivideDeformSource, validatePropCage,
} from '../src/core/props/deform';
import { deformImportedProp, readImportedProp, saveImportedProp, importedPropsPayload } from '../src/server/routes/imported-props';
import { createPropDeformLayer } from '../src/app/viewport/scene/prop-deform';
import type { Stage } from '../src/app/viewport/stage';

const pack = (a: Float32Array | Uint32Array) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
// Two triangles, with a deliberately non-0..1 UV layout: subdividing must preserve the original mapping.
const source: PropSub = { mat: 0, positions: new Float32Array([0, 0, 0, 600, 0, 0, 0, 100, 0, 600, 100, 0]),
  uvs: new Float32Array([0.2, 0.1, 2.2, 0.1, 0.2, 0.8, 2.2, 0.8]), indices: new Uint32Array([0, 1, 2, 1, 3, 2]) };
const record: ImportedPropRecord = { id: 7, name: 'Bridge', tris: 2,
  subs: [{ mat: 0, pos: pack(source.positions), uv: pack(source.uvs), idx: pack(source.indices) }],
  materials: [{ id: 0, tex: 'Custom/bridge.png', alphaMode: 'cutout', frames: ['Custom/bridge.png', 'Custom/bridge2.png'] }],
  defaults: { nativeCollision: { mode: 1, playerCollision: true, playerBounce: true, responseMass: 1e30, bounceAmount: 0.5 } } };
const original = structuredClone(record);
const approx = (a: number, b: number, tolerance = 1e-4) => assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);

for (const axis of [0, 1, 2] as const) {
  const cage = createPropCage([source], axis);
  assert.equal(cage.points.length, 16);
  assert.equal(cageFolded(cage), false, `identity along ${axis}`);
  for (const p of [[0, 0, 0], [300, 50, 0], [600, 100, 0]]) {
    const weights = cageWeights(cage, p);
    approx(weights.reduce((a, b) => a + b), 1);
    deformPoint(cage, weights).forEach((n, i) => approx(n, p[i]));
  }
  const translated = structuredClone(cage);
  translated.points.forEach(p => { p[0] += 123; p[1] -= 45; p[2] += 67; });
  const p = deformPoint(translated, cageWeights(cage, [300, 50, 0]));
  p.forEach((n, i) => approx(n, [423, 5, 67][i]));
}
const cage = createPropCage([source]);
assert.equal(cage.axis, 0);
const divided = subdivideDeformSource([source], cage, 16);
assert.ok(divided[0].indices.length > source.indices.length, 'a low-poly bridge acquires enough stations to bend');
for (let i = 0; i < divided[0].positions.length / 3; i++) {
  approx(divided[0].uvs[i * 2], 0.2 + divided[0].positions[i * 3] / 300);
  approx(divided[0].uvs[i * 2 + 1], 0.1 + divided[0].positions[i * 3 + 1] * 0.007);
}
// No degenerate cap triangles; winding and surface area survive the cuts.
let area = 0;
for (let i = 0; i < divided[0].indices.length; i += 3) {
  const p = [...divided[0].indices.subarray(i, i + 3)].map(id => [...divided[0].positions.subarray(id * 3, id * 3 + 3)]);
  const signed = ((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])) / 2;
  assert.ok(signed > 0); area += signed;
}
approx(area, 60000, 0.01);
const bent = structuredClone(cage);
for (let i = 4; i < 12; i++) bent.points[i][2] += 100;
assert.equal(cageFolded(bent), false);
approx(deformPoint(bent, cageWeights(cage, [300, 50, 0]))[2], 75);
approx(deformPoint(bent, cageWeights(cage, [0, 50, 0]))[2], 0);
approx(deformPoint(bent, cageWeights(cage, [600, 50, 0]))[2], 0);
const bentGeometry = deformSource(divided, bent);
assert.deepEqual(bentGeometry[0].uvs, divided[0].uvs);
assert.deepEqual(bentGeometry[0].indices, divided[0].indices);
assert.ok(Math.max(...Array.from(bentGeometry[0].positions).filter((_, i) => i % 3 === 2)) > 70);

const baked = bakePropDeformation(record, bent, 16);
assert.deepEqual(record, original, 'preview/bake never mutates the source');
assert.deepEqual(baked.materials, record.materials);
assert.deepEqual(baked.defaults, record.defaults);
const withBounds = structuredClone(record);
withBounds.defaults!.nativeCollision!.mode = 2;
assert.equal(bakePropDeformation(withBounds, bent, 16).defaults?.nativeCollision?.mode, 1,
  'future placements of the bent library variant use its baked mesh, not a bounding box');
assert.deepEqual(baked.deformation?.source, record.subs);
const reedit = bakePropDeformation({ ...baked, id: 8 }, cage, 16);
assert.deepEqual(reedit.deformation?.source, record.subs, 'reediting retains one original source, not nested or already-bent meshes');
assert.ok(decodeDeformSource(reedit.subs)[0].positions.every((n, i) => i % 3 !== 2 || n === 0), 'reset after save really straightens');
const folded = structuredClone(cage);
folded.points.forEach(p => { p[0] = 600 - p[0]; });
assert.equal(cageFolded(folded), true);
assert.throws(() => bakePropDeformation(record, folded, 16), /folds/);
assert.throws(() => validatePropCage({ ...cage, points: [[NaN, 0, 0]] }, [source]));
assert.throws(() => validatePropCage({ ...cage, axis: 9 }, [source]));
assert.throws(() => subdivideDeformSource([source], cage, 33));
assert.throws(() => bakePropDeformation({ ...record, animation: { clipFrames: 1, objects: [] } }, cage, 16), /static/);
assert.throws(() => decodeDeformSource([{ ...record.subs[0], idx: pack(new Uint32Array([0, 1, 999])) }]));
const otherMaterial = { ...source, mat: 1, uvs: new Float32Array(source.uvs.map(n => n + 10)) };
const two = subdivideDeformSource([source, otherMaterial], cage, 8);
assert.equal(two[1].mat, 1); assert.ok(two[1].uvs.every(n => n >= 10), 'material and UV seams remain separate');
const splitSource = { ...source, positions: new Float32Array([...source.positions, ...source.positions]),
  uvs: new Float32Array([...source.uvs, ...source.uvs]), indices: new Uint32Array([0, 1, 2, 5, 7, 6]) };
const split = subdivideDeformSource([splitSource], cage, 8)[0];
const sharedCornerCopies = Array.from({ length: split.positions.length / 3 }, (_, i) =>
  Array.from(split.positions.subarray(i * 3, i * 3 + 3))).filter(p => p[0] === 600 && p[1] === 0);
assert.equal(sharedCornerCopies.length, 2, 'coincident source vertices stay split to preserve hard shading edges');

// A rotated, scaled and mirrored placement edits in model space, and preview resources never own the original.
{
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(45);
  camera.position.set(0, 20, 50);
  let attached: THREE.Object3D | null = null;
  const stage = { scene, camera, renderer: { domElement: { clientHeight: 600 } }, gizmo: { dragging: false },
    gizmoKind: null as string | null,
    attachGizmo(object: THREE.Object3D, kind: string) { attached = object; this.gizmoKind = kind; },
    detachGizmo() { attached = null; this.gizmoKind = null; },
  };
  const template = new THREE.Group();
  template.position.set(23, 17, -8); template.rotation.set(0.3, 0.7, -0.2); template.scale.set(-0.02, 0.02, 0.02);
  const originalGeometry = new THREE.BufferGeometry();
  originalGeometry.setAttribute('position', new THREE.BufferAttribute(source.positions, 3));
  const originalMaterial = new THREE.MeshBasicMaterial();
  const mesh = new THREE.Mesh(originalGeometry, originalMaterial);
  // Wireframe mode carries a renderer-only child and cyclic metadata. Opening must not JSON-clone them.
  const wire = new THREE.Mesh(originalGeometry, originalMaterial); wire.userData.propWireframePass = true;
  mesh.add(wire); mesh.userData.propWireframePasses = [wire]; template.add(mesh); scene.add(template);
  scene.updateMatrixWorld(true);
  let sourceDisposed = false, previewDisposed = false;
  originalGeometry.addEventListener('dispose', () => { sourceDisposed = true; });
  originalMaterial.addEventListener('dispose', () => { sourceDisposed = true; });
  const layer = createPropDeformLayer(stage as unknown as Stage, material => {
    const copy = material.clone(); copy.addEventListener('dispose', () => { previewDisposed = true; }); return copy;
  });
  let edited = structuredClone(cage);
  layer.open(cage, template, value => { edited = value; }, () => {});
  layer.geometry(divided);
  layer.dragging(true);
  const delta = new THREE.Vector3(2, 3, 4);
  attached!.position.add(delta);
  layer.changed(); layer.dragging(false);
  for (let i = 0; i < 16; i++) {
    const expected = new THREE.Vector3(...cage.points[i]);
    if (i >= 12) expected.applyMatrix4(mesh.matrixWorld).add(delta).applyMatrix4(mesh.matrixWorld.clone().invert());
    edited.points[i].forEach((n, a) => approx(n, expected.getComponent(a)));
  }
  layer.setMode('corner'); layer.select(5); layer.dragging(true);
  attached!.position.add(delta); layer.changed(); layer.dragging(false);
  assert.notDeepEqual(edited.points[5], cage.points[5], 'one corner can move independently');
  assert.deepEqual(edited.points[4], cage.points[4]);
  layer.close();
  assert.equal(sourceDisposed, false); assert.equal(previewDisposed, true);
  assert.equal(layer.active, false); assert.equal(attached, null);
}

const root = await mkdtemp(join(tmpdir(), 'slopesmith-deform-'));
const priorRoot = process.env.SLOPESMITH_PROJECT_ASSETS_ROOT;
process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = root;
try {
  const saved = await saveImportedProp('bridge', record);
  const before = await readFile(join(root, 'props', saved.file), 'utf8');
  const variant = await deformImportedProp(saved.record.id, { cage: bent, slices: 16 });
  assert.notEqual(variant.id, saved.record.id);
  assert.equal(await readFile(join(root, 'props', saved.file), 'utf8'), before, 'saving a bend cannot change existing placements or undo history');
  const loaded = await readImportedProp(variant.id);
  assert.deepEqual(loaded.deformation?.cage, bent);
  const payload = await importedPropsPayload();
  assert.equal(payload.models.length, 2);
  assert.equal(JSON.stringify(payload).includes('deformation'), false, 'riders receive baked geometry only');
  const restored = await deformImportedProp(variant.id, { cage, slices: 16 });
  const restoredRecord = await readImportedProp(restored.id);
  assert.deepEqual(restoredRecord.deformation?.source, record.subs);
} finally {
  if (priorRoot === undefined) delete process.env.SLOPESMITH_PROJECT_ASSETS_ROOT;
  else process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = priorRoot;
  await rm(root, { recursive: true, force: true });
}
console.log('Prop deformation: geometry, UVs, subdivision, fold checks, immutable revisions and reopen passed.');
