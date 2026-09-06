// tier: fast

/**
 * The Blender round trip (docs/046), measured end to end on real container bytes.
 *
 * Two claims carry this feature, and both of them fail PLAUSIBLY — the model still draws, so a broken one
 * survives a look at the viewport:
 *
 *  1. **Orientation.** Portal space is the editor's (metres, Y-up); the stored prop frame is raw SSX (cm,
 *     Z-up, X-mirrored). A mirror reverses winding, and a prop's normals come from its stored winding alone,
 *     so a face that survived the trip pointing the wrong way is ambient-only dark from every view rather
 *     than missing (docs/032). The invariant asserted here is the one `check.py` and `glb-import.test.ts`
 *     assert of an import — a closed model encloses a POSITIVE signed volume — checked on BOTH sides of the
 *     frame change, because the mirror and the index reversal cancel and either one alone would not.
 *  2. **Losslessness.** A cage that goes out to Blender and comes straight back must be the same cage: same
 *     corners, same quads, same corner ORDER (which is what the derived per-quad tile UVs are read off).
 *     A round trip that silently rotates a quad's corners repaints the model.
 *
 * Run: tsx test/blender-bridge.test.ts
 */
import { AUTHORED_MODEL_LEVEL, authoredModelLevelProps } from '../src/core/doc/models';
import {
  authoredModelPortal, cageFromPortal, importedGeometryFromPortal, importedPropPortal, portalGlb,
  readPortalMesh, MAX_PORTAL_TEX_BYTES, PORTAL_VERSION, OS_CAGE_EXTRA, OS_PORTAL_EXTRA, type PortalMesh,
} from '../src/core/blender/portal';
import { decodeGlb } from '../src/core/props/glb-decode';
import { encodeGlb } from '../src/core/props/glb-encode';
import type { AuthoredModel, QuadMeshDoc } from '../src/core/doc/types';
import type { ImportedPropRecord } from '../src/core/props/imported';
import { check, failures } from './check';

const PROJECT = 'test-mountain-uuid';

// ---- a closed model to measure ------------------------------------------------------------------------

/**
 * A unit cube as six quads, every face wound outward under the authored convention (a quad [A,B,C,D] faces
 * `(B−A) × (C−A)`, with D the corner opposite A). Closed and convex, so its signed volume is a clean +1 m³
 * and any face that flips shows up as a deficit rather than as a rounding error.
 */
function cube(anchor: [number, number, number]): AuthoredModel {
  const local: [number, number, number][] = [
    [0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1],   // 0..3  y = 0
    [0, 1, 0], [1, 1, 0], [0, 1, 1], [1, 1, 1],   // 4..7  y = 1
  ];
  const vertices: number[] = [];
  for (const [x, y, z] of local) vertices.push(x + anchor[0], y + anchor[1], z + anchor[2]);
  return {
    id: 'model:0003', name: 'Test cube', anchor, vertices,
    quads: [
      [0, 1, 2, 3],   // −y
      [4, 6, 5, 7],   // +y
      [2, 3, 6, 7],   // +z
      [0, 4, 1, 5],   // −z
      [1, 5, 3, 7],   // +x
      [0, 2, 4, 6],   // −x
    ],
    texture: 'Custom/crate.png',
  };
}

/** Signed volume of a closed triangle soup: (1/6) Σ a · (b × c). Positive when the faces wind outward. */
function volume(triangles: Iterable<readonly [readonly number[], readonly number[], readonly number[]]>): number {
  let total = 0;
  for (const [a, b, c] of triangles) {
    total += a[0] * (b[1] * c[2] - b[2] * c[1])
      + a[1] * (b[2] * c[0] - b[0] * c[2])
      + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return total / 6;
}

/** A portal mesh's faces fanned into triangles of positions — how it would draw. */
function* portalTriangles(mesh: PortalMesh) {
  const at = (index: number) => [mesh.verts[index * 3], mesh.verts[index * 3 + 1], mesh.verts[index * 3 + 2]];
  for (const loop of mesh.faces) {
    for (let i = 1; i + 1 < loop.length; i++) {
      yield [at(loop[0]), at(loop[i]), at(loop[i + 1])] as [number[], number[], number[]];
    }
  }
}

// ---- 1. the encoder writes what the decoder reads ------------------------------------------------------
{
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
  const indices = new Uint32Array([0, 1, 2]);
  const bytes = encodeGlb({
    generator: 'test',
    materials: [{ name: 'tile', baseColorFactor: [0.25, 0.5, 0.75, 1], extras: { note: 'hello' } }],
    meshes: [{ name: 'tri', primitives: [{ positions, uvs, indices, material: 0 }] }],
    nodes: [{ name: 'root', mesh: 0, extras: { [OS_PORTAL_EXTRA]: '{"v":1}' } }],
  });
  const back = decodeGlb(bytes);
  const primitive = back.meshes[0].primitives[0];
  check(bytes.byteLength % 4 === 0, 'a GLB is written 4-byte aligned end to end');
  check([...primitive.positions].every((v, i) => v === positions[i]), 'positions survive encode → decode');
  check([...(primitive.uvs ?? [])].every((v, i) => v === uvs[i]), 'UVs survive encode → decode');
  check([...(primitive.indices ?? [])].join() === [...indices].join(), 'indices survive encode → decode');
  check(back.materials[0].baseColorFactor[1] === 0.5, 'a material keeps its base-colour factor');
  check((back.materials[0].extras as { note?: string })?.note === 'hello', 'material extras come back verbatim');
  check((back.nodes[0].extras as Record<string, string>)?.[OS_PORTAL_EXTRA] === '{"v":1}',
    'the round-trip stamp rides the root node, where Blender keeps it');

  let threw = '';
  try {
    encodeGlb({ meshes: [{ name: 'bad', primitives: [{ positions, indices: new Uint32Array([0, 1, 9]) }] }],
      nodes: [{ name: 'root', mesh: 0 }] });
  } catch (error) { threw = String(error); }
  check(threw.includes('indexes vertex 9'), 'an index past the end of a primitive is refused, not written');
}

// ---- 2. the cage goes out and comes back unchanged ------------------------------------------------------
{
  const model = cube([10, 2, -3]);
  const portal = authoredModelPortal(model, PROJECT);

  check(portal.stamp.kind === 'model' && portal.stamp.id === 3 && portal.stamp.project === PROJECT,
    'the portal is stamped with the model number a placement persists');
  check(portal.cage && portal.uvs === undefined,
    'a cage carries no UV layer — they are derived from the quad corners, not authored');
  check(portal.faces.length === 6 && portal.faces.every(face => face.length === 4),
    'six quads go out AS quads — nothing is triangulated on the way to Blender');
  check(portal.verts[0] === 0 && portal.verts[1] === 0 && portal.verts[2] === 0,
    'vertices go out anchor-local, so the model lands at Blender’s origin');

  const back = cageFromPortal(portal, portal.anchor);
  check(back.vertices.length === model.vertices.length
    && back.vertices.every((v, i) => Math.abs(v - model.vertices[i]) < 1e-12),
    'every corner returns to the world metres it left in');
  check(back.quads.length === model.quads.length
    && back.quads.every((quad, q) => quad.join() === model.quads[q].join()),
    'every quad returns with its corners in the SAME order — the derived tile UVs read off that order');
  check(back.fanned === 0 && back.dropped === 0, 'a clean cage needs no repair on the way back');
}

// ---- 3. orientation survives the frame change, on both sides of it --------------------------------------
{
  const model = cube([0, 0, 0]);
  const portal = authoredModelPortal(model, PROJECT);
  const portalVolume = volume(portalTriangles(portal));
  check(Math.abs(portalVolume - 1) < 1e-9,
    `the cube encloses +1 m³ in portal space (${portalVolume.toFixed(6)}) — faces wind outward`);

  // The same model through the bake every placement actually renders: raw cm, Z-up, X-mirrored.
  const level = authoredModelLevelProps({ models: [model] } as unknown as QuadMeshDoc);
  const sub = level.models[0].subs[0];
  const raw = (corner: number) =>
    [sub.positions[corner * 3], sub.positions[corner * 3 + 1], sub.positions[corner * 3 + 2]];
  const rawTriangles: [number[], number[], number[]][] = [];
  for (let t = 0; t + 2 < sub.indices.length; t += 3) {
    rawTriangles.push([raw(sub.indices[t]), raw(sub.indices[t + 1]), raw(sub.indices[t + 2])]);
  }
  const rawVolume = volume(rawTriangles);
  check(rawVolume > 0,
    `and +${(rawVolume / 1e6).toFixed(6)} m³ in stored raw space — the mirror and the index reversal cancel`);
  check(Math.abs(rawVolume / 1e6 - portalVolume) < 1e-6,
    'the two agree in magnitude, so the portal is the same solid the bake ships');
}

// ---- 4. an imported record round-trips its geometry and its UVs -----------------------------------------
{
  const model = cube([0, 0, 0]);
  const level = authoredModelLevelProps({ models: [model] } as unknown as QuadMeshDoc);
  const sub = level.models[0].subs[0];
  const b64 = (view: ArrayBufferView) =>
    Buffer.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength).toString('base64');
  const record: ImportedPropRecord = {
    id: 7, name: 'Crate', tris: sub.indices.length / 3,
    subs: [{ mat: 0, pos: b64(sub.positions), uv: b64(sub.uvs), idx: b64(sub.indices) }],
    materials: [{ id: 0, tex: 'Custom/crate.png' }],
  };

  const portal = importedPropPortal(record, PROJECT,
    ref => `/api/texture?level=Custom&name=${ref.slice('Custom/'.length)}`);
  check(portal.stamp.kind === 'import' && portal.stamp.id === 7, 'an imported record stamps as its own number');
  check(portal.faces.every(face => face.length === 3), 'it goes out as the triangles it is');
  check(portal.materials[0].texUrl?.includes('crate.png'),
    'each slot carries the URL the add-on fetches its tile from');
  const importedVolume = volume(portalTriangles(portal));
  check(Math.abs(importedVolume - 1) < 1e-4,
    `the record un-mirrors to +1 m³ in portal space (${importedVolume.toFixed(6)})`);

  const geometry = importedGeometryFromPortal(portal, record.materials.length);
  check(geometry.tris === record.tris, `the push-back carries the same ${geometry.tris} triangles`);
  check(geometry.addedMaterials === 0, 'and references no material slot the record does not have');

  // `Buffer.from` hands back a view into a shared pool, so a typed array has to be built over its OWN
  // window — `.buffer` alone is the whole pool and reads somebody else's bytes.
  const unpack = (encoded: string) => {
    const bytes = Buffer.from(encoded, 'base64');
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  };
  const unpackIndices = (encoded: string) => {
    const bytes = Buffer.from(encoded, 'base64');
    return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  };
  const pushed = unpack(geometry.subs[0].pos);
  const original = sub.positions;
  // Vertex ORDER is not preserved — the push-back re-emits per submesh and dedupes — so the comparison that
  // matters is the solid, not the buffer: same volume, same bounding box, same winding sign.
  const rawBack: [number[], number[], number[]][] = [];
  const pushedIdx = unpackIndices(geometry.subs[0].idx);
  const rawAt = (corner: number) => [pushed[corner * 3], pushed[corner * 3 + 1], pushed[corner * 3 + 2]];
  for (let t = 0; t + 2 < pushedIdx.length; t += 3) {
    rawBack.push([rawAt(pushedIdx[t]), rawAt(pushedIdx[t + 1]), rawAt(pushedIdx[t + 2])]);
  }
  check(volume(rawBack) > 0, 'the geometry it writes back still encloses a positive raw volume');
  const extent = (values: Float32Array, axis: number) => {
    let min = Infinity, max = -Infinity;
    for (let i = axis; i < values.length; i += 3) { min = Math.min(min, values[i]); max = Math.max(max, values[i]); }
    return max - min;
  };
  check([0, 1, 2].every(axis => Math.abs(extent(pushed, axis) - extent(original, axis)) < 0.01),
    'and stands in the same 100 cm box it left in — the scale is not re-guessed');

  const pushedUv = unpack(geometry.subs[0].uv);
  check(pushedUv.length === pushed.length / 3 * 2 && [...pushedUv].every(v => v >= -1e-6 && v <= 1 + 1e-6),
    'UVs come home inside the tile, V flipped back to the raw OBJ convention');
}

// ---- 5. the GLB a foreign tool gets is the same model ---------------------------------------------------
{
  const model = cube([0, 0, 0]);
  const portal = authoredModelPortal(model, PROJECT);
  const glb = decodeGlb(portalGlb(portal));
  const primitive = glb.meshes[0].primitives[0];
  const at = (corner: number) => [
    primitive.positions[corner * 3], primitive.positions[corner * 3 + 1], primitive.positions[corner * 3 + 2]];
  const triangles: [number[], number[], number[]][] = [];
  const indices = primitive.indices!;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    triangles.push([at(indices[t]), at(indices[t + 1]), at(indices[t + 2])]);
  }
  check(triangles.length === 12, 'six quads triangulate to twelve triangles for a viewer');
  check(Math.abs(volume(triangles) - 1) < 1e-6,
    `the GLB encloses the same +1 m³ (${volume(triangles).toFixed(6)}) — the fan agrees with the quad winding`);
  const extras = glb.nodes[0].extras as Record<string, string>;
  const stamp = JSON.parse(extras[OS_PORTAL_EXTRA]) as { id: number };
  check(stamp.id === 3, 'and it carries the stamp, so a file opened elsewhere still knows where it goes back');

  // The cage rides beside the triangles with its OWN welded vertex pool: the primitive's corners are unshared
  // (a cage has no per-vertex UVs to share), so a face list indexing them would name the wrong corners.
  const carried = JSON.parse(extras[OS_CAGE_EXTRA]) as { verts: number[]; faces: number[][] };
  check(carried.faces.length === 6 && carried.verts.length === 8 * 3,
    'the quad cage rides beside them, welded, so the GLB is self-describing rather than nearly so');
  check(carried.faces.every((face, f) => face.join() === portal.faces[f].join())
    && carried.verts.every((v, i) => v === portal.verts[i]),
    'and it is the cage that went in, corner for corner');
  check(primitive.uvs !== null && [...primitive.uvs!].every(v => v === 0 || v === 1),
    'a cage’s derived UVs are the full 0–1 tile on every quad (docs/028 — scroll-safe, no inset)');
}

// ---- 6. what comes back from Blender is not trusted ------------------------------------------------------
{
  const refuse = (body: unknown, expect: string, label: string) => {
    let threw = '';
    try { readPortalMesh(body); } catch (error) { threw = String(error); }
    check(threw.includes(expect), label);
  };
  refuse({ verts: [0, 0, 0], faces: [[0, 0, 0]] }, 'no Slopesmith stamp',
    'a push with no stamp is refused rather than aimed at model 0');
  refuse({ stamp: { v: 99, kind: 'model', id: 1, project: PROJECT }, verts: [0, 0, 0], faces: [[0, 1, 2]] },
    `speaks portal v99`, 'a push from a newer add-on is refused with both versions named');
  refuse({ stamp: { v: PORTAL_VERSION, kind: 'model', id: 1, project: PROJECT }, verts: [0, 0], faces: [[0]] },
    'partial vertex', 'a truncated vertex buffer is refused');
  refuse({ stamp: { v: PORTAL_VERSION, kind: 'model', id: 1, project: PROJECT }, verts: [0, 0, 0], faces: [] },
    'no faces', 'an empty face list is refused');

  // An out-of-range corner is dropped rather than refused: one stray index must not cost the whole push.
  const salvaged = cageFromPortal(readPortalMesh({
    stamp: { v: PORTAL_VERSION, kind: 'model', id: 1, name: 'x', project: PROJECT, unit: 'm' },
    verts: [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0],
    faces: [[0, 1, 3, 2], [0, 1, 900], [0, 1, 2, 3, 4]],
    cage: true,
  }), [0, 0, 0]);
  check(salvaged.quads.length === 1 + 3, 'a clean quad lands, an n-gon fans into wedges');
  check(salvaged.fanned === 1 && salvaged.dropped === 1,
    'and the split and the dropped face are both reported rather than swallowed');
  check(salvaged.quads[0].join() === [0, 1, 2, 3].join(),
    'the quad loop maps back to the stored [A, B, C, D] corner order');

  // A slot's edited ART rides home in the material table. It is the one field on the wire that is unbounded
  // by anything else in the payload, so it is bounded by itself — before a buffer is allocated for it.
  const withArt = readPortalMesh({
    stamp: { v: PORTAL_VERSION, kind: 'import', id: 4, name: 'Lamp', project: PROJECT, unit: 'm' },
    verts: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]],
    materials: [{ id: 0, name: 'lamp', tex: 'Custom/lamp.png', png: 'aGVsbG8=' },
      { id: 1, name: 'clay', tex: '' }],
  });
  check(withArt.materials[0].png === 'aGVsbG8=' && withArt.materials[0].tex === 'Custom/lamp.png',
    'a pushed tile arrives beside the ref it is new art FOR — which is what decides replace against fork');
  check(withArt.materials[1].png === undefined && withArt.materials[1].tex === null,
    'and a slot the artist did not touch carries none, so an ordinary push cannot disturb a shared tile');

  let refused = '';
  try {
    readPortalMesh({
      stamp: { v: PORTAL_VERSION, kind: 'import', id: 4, name: 'Lamp', project: PROJECT, unit: 'm' },
      verts: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [[0, 1, 2]],
      materials: [{ id: 0, name: 'huge', tex: null, png: 'A'.repeat(MAX_PORTAL_TEX_BYTES * 2) }],
    });
  } catch (error) { refused = String(error); }
  check(refused.includes("slot 0's tile is larger than"),
    'an oversized tile is refused as a tile, by slot, rather than as a request that is too large');
}

// ---- 7. the level a stamp names is the one the library shows --------------------------------------------
{
  const model = cube([0, 0, 0]);
  const portal = authoredModelPortal(model, PROJECT);
  check(AUTHORED_MODEL_LEVEL === '@models' && portal.stamp.kind === 'model',
    'an authored cage stamps to the @models library the Prop Library lists it under');
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('blender-bridge: all checks passed');
