import type { AuthoredModel, V3 } from '../doc/types';
import { modelNumber, AUTHORED_MODEL_LEVEL } from '../doc/models';
import { IMPORTED_PROP_LEVEL, MAX_IMPORT_TRIS, type ImportedPropRecord } from '../props/imported';
import { encodeGlb, type EncodeImage, type EncodeMaterial } from '../props/glb-encode';

/**
 * The Blender portal: one mesh interchange shape both ends of the round trip speak (docs/046).
 *
 * The escape hatch is "this piece is easier in Blender" — so what travels has to be the piece, not a scene:
 * polygons, their corners, one material table, and a stamp saying which model in which mountain it came out
 * of. Everything else about a prop (its placements, its effect attachments, its number, its name) stays in
 * Slopesmith and is joined back to on the stamp, which is what makes a push-back land ON the model the
 * author edited rather than beside it.
 *
 * ## Why a JSON mesh and not glTF
 *
 * A GLB is what a *foreign* tool should be handed, and `portalGlb` below writes one. But the addon is ours,
 * and driving Blender's own glTF importer/exporter through it would cost three things this format keeps:
 * **quads** (glTF has only triangles, and an authored model IS a quad cage — docs/028), **determinism** (the
 * importer's Y-up→Z-up conversion is applied as a baked object transform whose exact form has changed
 * between Blender releases), and **legibility** (an exporter flag silently off is a whole class of bug that
 * cannot happen when the addon writes the payload itself).
 *
 * ## Space
 *
 * Portal coordinates are glTF's: **metres, Y-up, right-handed**, and ANCHOR-LOCAL, so a model arrives at the
 * origin. That is also the editor's own data space — `authoredModelLevelProps` and `glbToPropDraft` reduce to
 * the same `raw = (−100x, −100z, 100y)` map — so an authored model needs no axis change at all, and an
 * imported prop needs exactly the inverse of the one its import applied. Blender's Z-up is the ADDON's
 * business, converted once at its own edge, because that is the only place the convention is Blender's.
 *
 * ## What round-trips, and what does not
 *
 * Geometry, polygon topology and UVs travel both ways. The material TABLE travels out and is matched back by
 * SLOT: a face landing on a slot the model does not have gets a new untextured one rather than being dropped.
 * An authored model carries no per-face material at all — it wears ONE tile and derives its UVs — so its
 * push-back reads polygons alone.
 *
 * A slot's ART travels too, but only in one direction each way and only when it changed. Out, it goes as a
 * `texUrl` the addon fetches: base64 in a JSON payload would triple every tile on every pull, and the bank
 * already has a byte route. Back, it goes as `png` — the one case where the bytes have to ride WITH the mesh,
 * because a texture edit and the UV edit that motivated it are the same edit and landing half of it would be
 * worse than landing neither. An unchanged slot sends no `png` at all, so an ordinary geometry push costs
 * nothing and never disturbs a tile other props share.
 */

/** Bumped when a field changes meaning. The addon refuses a payload it does not speak rather than guessing. */
export const PORTAL_VERSION = 1;

/** The glTF `extras` key carrying the round-trip stamp, on the file's root node. Blender's importer parks
 *  node extras on the object as custom properties and its exporter writes them back, so the stamp survives a
 *  trip through the plain File → Import path as well as through the addon. */
export const OS_PORTAL_EXTRA = 'OpenSlope_slopesmith';

/**
 * The glTF `extras` key carrying the quad cage beside the triangles: a viewer reads the triangles, a reader
 * that knows about it rebuilds real quads. Both describe the same surface.
 *
 * It carries its OWN vertex pool rather than indexing the primitive's, because the GLB emits corners per face
 * (a cage has no per-vertex UVs to share — they are derived per quad) while the cage is welded. A face list
 * pointing at the unshared pool would name the wrong corners; carrying both is a few kilobytes on a model
 * measured in hundreds of quads, and it makes the file self-describing rather than only nearly so.
 */
export const OS_CAGE_EXTRA = 'OpenSlope_cage';

/** Which library a portal mesh came out of. `model` is an authored quad cage in the open document
 *  (`@models`); `import` is a stored GLB record on disk (`@import`). */
export type PortalKind = 'model' | 'import';

/** Who this mesh is, and where it goes back to. */
export interface PortalStamp {
  v: number;
  kind: PortalKind;
  /** The model NUMBER placements persist — the join that makes a push-back land on the right geometry. */
  id: number;
  name: string;
  /** The mountain it belongs to, so a push aimed at a project that is no longer open is refused instead of
   *  overwriting the same model number in a different mountain. */
  project: string;
  /** Always "m": one portal unit is one metre. Stated rather than assumed, because the single most common
   *  way a model comes back wrong from a DCC is a centimetre scene scale. */
  unit: 'm';
}

export interface PortalMaterial {
  /** The material's slot index — what `faceMaterial` names. Stable across a round trip. */
  id: number;
  name: string;
  /** The tile ref this slot wears ("Custom/lamp.png"), or null for untextured clay. On a PUSH this is what
   *  the addon believes the slot was wearing, which is how the service decides whether new art replaces that
   *  tile or forks a copy of it. */
  tex: string | null;
  /** PULL only: where the addon can fetch that tile's PNG to show it in Blender. Absent for an untextured
   *  slot. A URL rather than the bytes — the bank already serves them, and inlining would triple every tile. */
  texUrl?: string;
  /** PUSH only: this slot's art as a base64 PNG, present only when the artist changed it in Blender. Absent
   *  means "leave the tile alone", which is what every slot on an ordinary geometry push says. */
  png?: string;
}

/**
 * The biggest tile one push may carry, before base64.
 *
 * Far above what is kept — `saveCustomTexture` conforms every stored tile to 512² — so an artist who painted
 * at 4K gets their art shrunk rather than refused. Far below the route's own body limit, so a runaway
 * payload is named as a tile that is too big instead of as a request that is too large.
 */
export const MAX_PORTAL_TEX_BYTES = 12 * 1024 * 1024;

/**
 * One editable piece of geometry, in and out.
 *
 * `faces` are polygon LOOPS, not triangles — that is the whole point of the format. A four-corner loop is a
 * quad, a three-corner loop is a triangle, and anything longer is fanned on the way in (a cage keeps only
 * quads and wedges, so an n-gon the artist made in Blender becomes several of them rather than being refused).
 */
export interface PortalMesh {
  stamp: PortalStamp;
  /** Where the definition sits in the world, editor metres. Carried so a push-back can put the geometry back
   *  in world space; the vertices themselves are relative to it. */
  anchor: V3;
  /** Flat xyz, anchor-local, metres, Y-up. */
  verts: number[];
  /** Per-vertex uv in glTF's convention (V runs top-down). Omitted on a cage, whose UVs are DERIVED from the
   *  quad corners and would be a second, diverging source of truth if they travelled. */
  uvs?: number[];
  /** Polygon loops as vertex indices. */
  faces: number[][];
  /** Per face, an index into `materials`. Omitted when every face wears slot 0. */
  faceMaterial?: number[];
  materials: PortalMaterial[];
  /** True when `faces` IS the authored quad cage: UVs are derived, one tile dresses the whole model, and a
   *  push-back writes the polygons straight back as quads (docs/028). */
  cage: boolean;
}

/** The perimeter loop of an authored quad. `quads` stores [A, B, C, D] with UV corners A(0,0) B(1,0) C(0,1)
 *  D(1,1), so going AROUND the face is A → B → D → C; a wedge (`C === D`) is the triangle A → B → C. */
export function quadLoop(quad: readonly number[]): number[] {
  return quad[2] === quad[3] ? [quad[0], quad[1], quad[2]] : [quad[0], quad[1], quad[3], quad[2]];
}

/** The inverse: a polygon loop back to the stored [A, B, C, D]. A triangle stores as the wedge [A, B, C, C]
 *  the mesh tools already understand. */
export function loopQuad(loop: readonly number[]): [number, number, number, number] {
  return loop.length >= 4
    ? [loop[0], loop[1], loop[3], loop[2]]
    : [loop[0], loop[1], loop[2], loop[2]];
}

/** Fan an arbitrary loop into triangles — how an n-gon reaches a format that has none. */
function fan(loop: readonly number[]): number[][] {
  const out: number[][] = [];
  for (let i = 1; i + 1 < loop.length; i++) out.push([loop[0], loop[i], loop[i + 1]]);
  return out;
}

// ---- authored models (the quad cage) -----------------------------------------------------------------

/**
 * An authored model as a portal mesh: its cage, verbatim.
 *
 * Vertices go out anchor-local so the model lands at Blender's origin instead of a kilometre down the
 * mountain, and quads go out AS quads. Nothing is triangulated, welded or re-derived on the way out, so the
 * mesh the artist sees is the mesh the document holds.
 */
export function authoredModelPortal(model: AuthoredModel, project: string, texUrl?: string): PortalMesh {
  const [ax, ay, az] = model.anchor;
  const verts: number[] = [];
  for (let i = 0; i < model.vertices.length; i += 3) {
    verts.push(model.vertices[i] - ax, model.vertices[i + 1] - ay, model.vertices[i + 2] - az);
  }
  return {
    stamp: { v: PORTAL_VERSION, kind: 'model', id: modelNumber(model.id), name: model.name, project, unit: 'm' },
    anchor: [ax, ay, az],
    verts,
    faces: model.quads.map(quadLoop),
    materials: [{
      id: 0, name: model.texture ?? 'clay', tex: model.texture ?? null,
      ...(texUrl ? { texUrl } : {}),
    }],
    cage: true,
  };
}

/** What a push-back turns into: the two channels a model record stores, ready for `commitModelEditDoc`'s
 *  sibling to write. Returned rather than assigned so the caller owns the document edit (and its undo entry). */
export interface CageUpdate {
  /** World metres, flat xyz — the same encoding `AuthoredModel.vertices` holds. */
  vertices: number[];
  quads: [number, number, number, number][];
  /** Faces the artist made that had to be split to fit the cage (an n-gon fanned into wedges), for the toast. */
  fanned: number;
  /** Loops with fewer than three distinct corners, dropped. A stray Blender edge or loose vertex is not
   *  geometry, and carrying it in would put a degenerate quad into the bake. */
  dropped: number;
}

/**
 * A pushed-back portal mesh as an authored model's cage.
 *
 * Quads and triangles land directly (a triangle is the wedge `[A, B, C, C]` the mesh tools already speak);
 * an n-gon is fanned, because the bicubic/linear cage evaluation is defined on four corners and nothing else.
 * Vertices return to WORLD metres against the anchor they left with, so a model edited in place stays where
 * it was — moving the geometry in Blender moves the model on the mountain, which is what an artist who
 * dragged it there meant.
 */
export function cageFromPortal(mesh: PortalMesh, anchor: V3): CageUpdate {
  const [ax, ay, az] = anchor;
  const vertices: number[] = [];
  for (let i = 0; i + 2 < mesh.verts.length; i += 3) {
    vertices.push(mesh.verts[i] + ax, mesh.verts[i + 1] + ay, mesh.verts[i + 2] + az);
  }
  const count = vertices.length / 3;
  const quads: [number, number, number, number][] = [];
  let fanned = 0, dropped = 0;
  for (const face of mesh.faces) {
    const loop = face.filter(index => Number.isInteger(index) && index >= 0 && index < count);
    if (new Set(loop).size < 3) { dropped++; continue; }
    if (loop.length <= 4) { quads.push(loopQuad(loop)); continue; }
    fanned++;
    for (const triangle of fan(loop)) quads.push(loopQuad(triangle));
  }
  return { vertices, quads, fanned, dropped };
}

// ---- imported props (the triangle record) ------------------------------------------------------------

/** base64 → a typed array over its own copy of the bytes. `atob` rather than `Buffer`, because core is
 *  shared with the browser bundle (`glb-decode.ts` reads the same way). */
function unpack(encoded: string): ArrayBuffer {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

const unpackFloats = (encoded: string): Float32Array => new Float32Array(unpack(encoded));
const unpackIndices = (encoded: string): Uint32Array => new Uint32Array(unpack(encoded));

/** A typed array → base64, the packing `ImportedPropRecord` stores. */
function pack(view: ArrayBufferView): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * A stored imported prop as a portal mesh.
 *
 * This is the exact inverse of what `glbToPropDraft` did on the way in, and it is written that way on
 * purpose: the frame change `raw = (−100x, −100z, 100y)` is a MIRROR, so undoing it has to reverse the
 * triangle winding as well (docs/032). Skipping that would hand Blender a model whose every face points
 * inward — it would still draw, being double-sided, and every normal the artist then worked against would
 * be backwards. The UV V flip is the second, unrelated convention: prop UVs are raw OBJ `vt` with a
 * bottom-left origin, glTF's V runs top-down.
 *
 * Submeshes are concatenated into one vertex pool with a per-face material slot, because Blender's unit of
 * work is an object with material slots, not a bag of primitives.
 */
export function importedPropPortal(record: ImportedPropRecord, project: string,
  texUrl?: (ref: string) => string | undefined): PortalMesh {
  const verts: number[] = [];
  const uvs: number[] = [];
  const faces: number[][] = [];
  const faceMaterial: number[] = [];
  for (const sub of record.subs) {
    const positions = unpackFloats(sub.pos);
    const uv = unpackFloats(sub.uv);
    const indices = unpackIndices(sub.idx);
    const base = verts.length / 3;
    for (let i = 0; i + 2 < positions.length; i += 3) {
      // raw (cm, Z-up, X-mirrored) → portal/glTF (m, Y-up)
      verts.push(-positions[i] / 100, positions[i + 2] / 100, -positions[i + 1] / 100);
    }
    for (let i = 0; i + 1 < uv.length; i += 2) uvs.push(uv[i], 1 - uv[i + 1]);
    for (let t = 0; t + 2 < indices.length; t += 3) {
      // reversed again — the map back out of raw is the same mirror the import applied
      faces.push([base + indices[t], base + indices[t + 2], base + indices[t + 1]]);
      faceMaterial.push(sub.mat);
    }
  }
  return {
    stamp: { v: PORTAL_VERSION, kind: 'import', id: record.id, name: record.name, project, unit: 'm' },
    anchor: [0, 0, 0],
    verts,
    uvs,
    faces,
    faceMaterial,
    materials: record.materials.map(material => {
      const url = material.tex ? texUrl?.(material.tex) : undefined;
      return {
        id: material.id,
        name: material.tex ?? `slot ${material.id}`,
        tex: material.tex ?? null,
        ...(url ? { texUrl: url } : {}),
      };
    }),
    cage: false,
  };
}

/** The geometry half of an imported record — what a push-back rewrites, leaving name, number and emitters
 *  to the caller that knows the catalogue. */
export interface ImportedGeometry {
  tris: number;
  subs: ImportedPropRecord['subs'];
  /** How many material slots the pushed mesh referenced beyond the ones the record already had. */
  addedMaterials: number;
}

/**
 * A pushed-back portal mesh as imported-prop geometry.
 *
 * Faces fan to triangles, positions and winding take the mirror back into raw space, V flips back, and the
 * result re-groups by material slot into the per-material submeshes `PropSub` wants. Vertices are re-emitted
 * per submesh and deduplicated within it, so a model whose faces got redistributed across slots in Blender
 * does not carry every other slot's vertices along with it.
 *
 * Throws past `MAX_IMPORT_TRIS` — the same ceiling the import path enforces, checked here for the same
 * reason: the editor viewport would survive a subdivided-to-death push-back, and the `Props.obj` bake
 * would not.
 */
export function importedGeometryFromPortal(mesh: PortalMesh, slots: number): ImportedGeometry {
  const count = mesh.verts.length / 3;
  const bySlot = new Map<number, { pos: number[]; uv: number[]; idx: number[]; remap: Map<number, number> }>();
  let tris = 0;
  let highest = slots - 1;

  for (const [face, loop] of mesh.faces.entries()) {
    const slot = Math.max(0, Math.trunc(mesh.faceMaterial?.[face] ?? 0));
    highest = Math.max(highest, slot);
    let bucket = bySlot.get(slot);
    if (!bucket) bySlot.set(slot, bucket = { pos: [], uv: [], idx: [], remap: new Map() });
    const emit = (source: number): number => {
      let mapped = bucket!.remap.get(source);
      if (mapped === undefined) {
        mapped = bucket!.pos.length / 3;
        bucket!.remap.set(source, mapped);
        const x = mesh.verts[source * 3], y = mesh.verts[source * 3 + 1], z = mesh.verts[source * 3 + 2];
        bucket!.pos.push(-100 * x, -100 * z, 100 * y);
        const u = mesh.uvs?.[source * 2] ?? 0, v = mesh.uvs?.[source * 2 + 1] ?? 0;
        bucket!.uv.push(u, 1 - v);
      }
      return mapped;
    };
    const valid = loop.filter(index => Number.isInteger(index) && index >= 0 && index < count);
    if (new Set(valid).size < 3) continue;
    for (const [a, b, c] of fan(valid)) {
      if (a === b || b === c || c === a) continue;
      bucket.idx.push(emit(a), emit(c), emit(b));   // the raw frame is a mirror — reverse on the way in
      tris++;
    }
  }

  if (!tris) throw new Error('that mesh has no triangles');
  if (tris > MAX_IMPORT_TRIS) {
    throw new Error(`${tris.toLocaleString()} triangles exceeds the ${MAX_IMPORT_TRIS.toLocaleString()} limit`);
  }
  return {
    tris,
    subs: [...bySlot.entries()].sort((a, b) => a[0] - b[0]).map(([mat, bucket]) => ({
      mat,
      pos: pack(new Float32Array(bucket.pos)),
      uv: pack(new Float32Array(bucket.uv)),
      idx: pack(new Uint32Array(bucket.idx)),
    })),
    addedMaterials: Math.max(0, highest - (slots - 1)),
  };
}

// ---- the GLB a foreign tool gets ---------------------------------------------------------------------

/** UV corners of an authored quad, in glTF's top-down V: A(0,0) B(1,0) C(0,1) D(1,1) as raw prop UVs, so
 *  `v_gltf = 1 − v_prop`. The loop order is the one `quadLoop` produces — A, B, D, C. */
const CAGE_LOOP_UV: readonly (readonly [number, number])[] = [[0, 1], [1, 1], [1, 0], [0, 0]];

/** The wedge's third corner takes the tile's top-centre, matching `authoredModelLevelProps`. */
const CAGE_WEDGE_UV: readonly (readonly [number, number])[] = [[0, 1], [1, 1], [0.5, 0]];

/**
 * A portal mesh as a self-contained GLB — the file for a tool that is not the addon.
 *
 * Corners are emitted PER FACE rather than shared. A cage has no per-vertex UVs to share (they are derived
 * per quad, so one corner belongs to four different tile positions), and unsharing is also what lets a flat
 * normal be written per polygon, which is how the model reads in a viewport that has no idea the surface is
 * meant to be faceted.
 *
 * The quad cage rides along in the mesh's `extras` under `OpenSlope_cage`, and the stamp on the root node's, so a
 * file that goes out through here and comes back through the addon is still lossless — the triangles are for
 * whoever is looking, the cage is for whoever is editing.
 */
export function portalGlb(mesh: PortalMesh, images: EncodeImage[] = [],
  imageOfMaterial: (slot: number) => number | null = () => null): Uint8Array {
  const slots = mesh.materials.length || 1;
  const runs = new Map<number, { positions: number[]; uvs: number[]; normals: number[]; indices: number[] }>();

  for (const [face, loop] of mesh.faces.entries()) {
    if (loop.length < 3) continue;
    const slot = Math.min(slots - 1, Math.max(0, Math.trunc(mesh.faceMaterial?.[face] ?? 0)));
    let run = runs.get(slot);
    if (!run) runs.set(slot, run = { positions: [], uvs: [], normals: [], indices: [] });
    const base = run.positions.length / 3;
    const at = (index: number): V3 =>
      [mesh.verts[index * 3], mesh.verts[index * 3 + 1], mesh.verts[index * 3 + 2]];
    // Flat normal: `∂u × ∂v`, the side the bake winds toward (docs/028). On a cage loop [A, B, D, C] the
    // first and last edges ARE the u and v directions (A→B is +u, A→C is +v), and on a triangle they are the
    // two the fan winds around — so one formula answers both, and it agrees with the fan below by
    // construction rather than by coincidence.
    const [ox, oy, oz] = at(loop[0]);
    const [ux, uy, uz] = at(loop[1]);
    const [vx, vy, vz] = at(loop[loop.length - 1]);
    const e1 = [ux - ox, uy - oy, uz - oz], e2 = [vx - ox, vy - oy, vz - oz];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const length = Math.hypot(nx, ny, nz) || 1;
    const normal = [nx / length, ny / length, nz / length];

    const cageUv = loop.length >= 4 ? CAGE_LOOP_UV : CAGE_WEDGE_UV;
    for (const [corner, index] of loop.entries()) {
      run.positions.push(...at(index));
      run.normals.push(...normal);
      if (mesh.uvs && mesh.uvs.length >= (index + 1) * 2) run.uvs.push(mesh.uvs[index * 2], mesh.uvs[index * 2 + 1]);
      else run.uvs.push(...(cageUv[Math.min(corner, cageUv.length - 1)]));
    }
    for (let i = 1; i + 1 < loop.length; i++) run.indices.push(base, base + i, base + i + 1);
  }

  const used = [...runs.keys()].sort((a, b) => a - b);
  const materials: EncodeMaterial[] = used.map(slot => ({
    name: mesh.materials[slot]?.tex ?? mesh.materials[slot]?.name ?? `slot ${slot}`,
    baseColorImage: imageOfMaterial(slot),
    // Prop art is cut out with alpha far more often than it is blended, and MASK is what the editor's own
    // preview and the PS2 path both do with it.
    alphaMode: 'MASK',
    doubleSided: true,
  }));

  return encodeGlb({
    generator: `Slopesmith Blender portal v${PORTAL_VERSION}`,
    images,
    materials,
    meshes: [{
      name: mesh.stamp.name,
      primitives: used.map((slot, index) => {
        const run = runs.get(slot)!;
        return {
          positions: new Float32Array(run.positions),
          uvs: new Float32Array(run.uvs),
          normals: new Float32Array(run.normals),
          indices: new Uint32Array(run.indices),
          material: index,
        };
      }),
    }],
    nodes: [{
      name: mesh.stamp.name,
      mesh: 0,
      // Both payloads travel as JSON STRINGS on the NODE, not as nested objects on the mesh. Two reasons, and
      // they point the same way: Blender stores a node's extras as ID properties on the OBJECT — which its
      // exporter reliably writes back — and only a string survives that with its structure intact. It is the
      // same convention `OpenSlope_effect` already uses (docs/032).
      extras: {
        [OS_PORTAL_EXTRA]: JSON.stringify(mesh.stamp),
        ...(mesh.cage
          ? { [OS_CAGE_EXTRA]: JSON.stringify({ verts: mesh.verts, faces: mesh.faces, anchor: mesh.anchor }) }
          : {}),
      },
    }],
  });
}

/** The prop-library level a stamp names, so a caller can join a push-back back onto a placement. */
export const portalLevel = (kind: PortalKind): string =>
  kind === 'model' ? AUTHORED_MODEL_LEVEL : IMPORTED_PROP_LEVEL;

/**
 * Read a stamp off untrusted JSON, or null.
 *
 * Everything that arrives from Blender came through a text field a human could have typed in, so this is
 * validation rather than a cast — a push carrying `id: "7"` must not silently become model 0.
 */
export function readPortalStamp(value: unknown): PortalStamp | null {
  const raw = typeof value === 'string' ? safeParse(value) : value;
  const stamp = raw as Partial<PortalStamp> | null;
  if (!stamp || typeof stamp !== 'object') return null;
  if (stamp.kind !== 'model' && stamp.kind !== 'import') return null;
  if (!Number.isInteger(stamp.id) || (stamp.id as number) < 0) return null;
  if (typeof stamp.project !== 'string' || !stamp.project) return null;
  return {
    v: Number.isInteger(stamp.v) ? stamp.v as number : PORTAL_VERSION,
    kind: stamp.kind, id: stamp.id as number,
    name: typeof stamp.name === 'string' ? stamp.name : `model ${stamp.id}`,
    project: stamp.project, unit: 'm',
  };
}

function safeParse(text: string): unknown {
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Read a pushed mesh off untrusted JSON.
 *
 * The addon is trusted no further than the network it arrives over: a face list naming vertex 40 000 of a
 * 12-vertex mesh, a `verts` array of strings, or a payload from a newer portal version all have to fail as a
 * refusal with a reason rather than as geometry with holes in it. Index RANGE is checked by the two
 * consumers above, which know what to do with an out-of-range corner; shape is checked here.
 */
export function readPortalMesh(value: unknown): PortalMesh {
  const body = value as Partial<PortalMesh> | null;
  if (!body || typeof body !== 'object') throw new Error('that push carried no mesh');
  const stamp = readPortalStamp(body.stamp);
  if (!stamp) throw new Error('that push carries no Slopesmith stamp — pull the model again before pushing');
  if (stamp.v > PORTAL_VERSION) {
    throw new Error(`that push speaks portal v${stamp.v}; this Slopesmith speaks v${PORTAL_VERSION}`);
  }
  const numbers = (input: unknown, what: string): number[] => {
    if (!Array.isArray(input)) throw new Error(`that push has no ${what}`);
    return input.map(n => {
      const value = typeof n === 'number' ? n : NaN;
      if (!Number.isFinite(value)) throw new Error(`that push has a non-numeric ${what}`);
      return value;
    });
  };
  const verts = numbers(body.verts, 'vertices');
  if (!verts.length || verts.length % 3) throw new Error('that push has a partial vertex');
  if (!Array.isArray(body.faces) || !body.faces.length) throw new Error('that push has no faces');
  const faces = body.faces.map(face => {
    if (!Array.isArray(face)) throw new Error('that push has a malformed face');
    return face.map(index => Math.trunc(Number(index)));
  });
  const uvs = body.uvs === undefined ? undefined : numbers(body.uvs, 'UVs');
  if (uvs && uvs.length !== (verts.length / 3) * 2) throw new Error('that push has one UV per vertex missing');
  return {
    stamp,
    anchor: Array.isArray(body.anchor) && body.anchor.length === 3
      ? [Number(body.anchor[0]) || 0, Number(body.anchor[1]) || 0, Number(body.anchor[2]) || 0]
      : [0, 0, 0],
    verts,
    ...(uvs ? { uvs } : {}),
    faces,
    ...(Array.isArray(body.faceMaterial)
      ? { faceMaterial: body.faceMaterial.map(slot => Math.max(0, Math.trunc(Number(slot)) || 0)) }
      : {}),
    materials: Array.isArray(body.materials) ? body.materials.map((material, index) => {
      const row = material as Partial<PortalMaterial> | null;
      const png = typeof row?.png === 'string' ? row.png : '';
      // Sized off the base64 LENGTH rather than by decoding: a payload meant to exhaust the heap must be
      // refused before anything allocates a buffer for it.
      if (png.length > Math.ceil(MAX_PORTAL_TEX_BYTES / 3) * 4) {
        throw new Error(`slot ${index}'s tile is larger than the`
          + ` ${Math.round(MAX_PORTAL_TEX_BYTES / 1024 / 1024)} MB a push may carry`);
      }
      return {
        id: Number.isInteger(row?.id) ? row!.id as number : index,
        name: String(row?.name ?? `slot ${index}`),
        tex: typeof row?.tex === 'string' && row.tex ? row.tex : null,
        ...(png ? { png } : {}),
      };
    }) : [],
    cage: body.cage === true,
  };
}
