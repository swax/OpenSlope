/**
 * glTF 2.0 / GLB → plain arrays, with no parser behind it.
 *
 * The browser reads a dropped model through three.js's `GLTFLoader` (app/props/glb-import.ts), which is the
 * right answer THERE — the loader is already in the bundle for the Play rider models — and the wrong one
 * everywhere else: it wants a `document`, a `canvas` and a `Blob`, so nothing outside a tab can use it. This
 * is the same file format read as data. It takes bytes and returns numbers, so the headless importer
 * (server/props/import-glb.ts) can turn a committed `tools/prop-recipes/props/*.glb` into a placeable model
 * with no browser in the loop, and so the conversion itself stays testable against a real file rather than
 * against a mock of a loader.
 *
 * Scope is deliberate: this reads what BLENDER'S glTF exporter emits, because that is what the recipes run
 * (`_lib.finish` → `export_scene.gltf(export_format='GLB', use_selection=True, export_extras=True)`) and what
 * every generated prop arrives as. Skins, morph targets, cameras, lights, animation samplers, draco and
 * sparse accessors are not read — a prop's motion is DECLARED in `extras` and rebuilt as a native clip
 * (`importedSpinAnimation`), so a glTF animation channel would be a second, silently-diverging source of
 * truth. Anything unsupported throws with a message a toast can show rather than being half-read.
 *
 * `extras` — on nodes and on materials — comes back verbatim, because it is the payload the whole
 * self-describing-GLB design rests on: `importedSpinFromExtras`, `importedEmittersFromExtras`,
 * `importedMaterialScroll` and `importedMaterialFlipbook` are the readers, and they treat it as untrusted
 * input. Nothing is validated here beyond the structure the format itself guarantees.
 */

/** A 4×4 transform in glTF's own COLUMN-major order, which is also three.js's `Matrix4.elements` — so a
 *  matrix read out of a file and one composed here index the same way. */
export type Mat4 = readonly number[];

/** One drawable run: a glTF mesh primitive, its attributes already de-strided into flat arrays. */
export interface GltfPrimitive {
  /** VEC3, `count * 3` floats, in the node's LOCAL space — the world transform is on `GltfNode`. */
  positions: Float32Array;
  /** VEC2, `count * 2` floats, or null when the primitive carries no TEXCOORD_0. */
  uvs: Float32Array | null;
  /** Triangle corners, or null for a non-indexed primitive (which draws `positions` in order). */
  indices: Uint32Array | null;
  /** Index into `DecodedGltf.materials`, or null for the format's default material. */
  material: number | null;
}

export interface GltfMesh {
  name: string;
  primitives: GltfPrimitive[];
}

/** A material reduced to the two things a prop can wear: one base-colour page and one flat colour. */
export interface GltfMaterial {
  name: string;
  /** Index into `DecodedGltf.images`, or null. The `textures[]` indirection is resolved here because its
   *  only other content is a sampler, and a PS2-era prop bank has no per-tile filter or wrap to carry. */
  baseColorImage: number | null;
  /** LINEAR RGBA, defaulted to opaque white exactly as the format does. */
  baseColorFactor: [number, number, number, number];
  /** Explicit glTF render law. Null means the field was omitted (whose format default is OPAQUE). The prop
   * importer keeps omission distinct so existing conventional RGBA pages can retain pixel-auto behavior. */
  alphaMode: 'OPAQUE' | 'MASK' | 'BLEND' | null;
  /** The material's `extras`, verbatim — `importedMaterialScroll` / `importedMaterialFlipbook` read it. */
  extras: unknown;
}

/** A base-colour image: embedded bytes, or a `uri` the CALLER resolves. Reading a sibling file is a
 *  filesystem decision (and a path-traversal one), so it does not belong in a pure decoder. */
export interface GltfImage {
  name: string;
  mimeType: string | null;
  /** The image file's own bytes — from a `bufferView` or a `data:` URI — or null when only `uri` is known. */
  bytes: Uint8Array | null;
  /** The relative or absolute URI the file named, when it did not embed the image. */
  uri: string | null;
}

/** One node of the scene, flattened: its parent, its world matrix, and whatever it declared for itself. */
export interface GltfNode {
  /** Position in `DecodedGltf.nodes`, which is scene traversal order rather than file order. */
  index: number;
  name: string;
  /** Index into `DecodedGltf.nodes`, or -1 for a scene root. Parents always precede their children. */
  parent: number;
  mesh: number | null;
  /** The node's `extras`, verbatim — `importedSpinFromExtras` / `importedEmittersFromExtras` read it. */
  extras: unknown;
  /** The node hierarchy already composed: local × every ancestor, so a caller never walks the chain. */
  world: Mat4;
}

export interface DecodedGltf {
  /**
   * Every node reachable from the file's default scene, in DEPTH-FIRST order with parents first.
   *
   * The order matters twice over: it is the order three.js's `traverse` visits the same file in, so the
   * browser importer and this one number a model's declared spins identically; and parents-first means an
   * ancestor scan can walk `parent` links without any risk of running off the end of the array.
   */
  nodes: GltfNode[];
  meshes: GltfMesh[];
  materials: GltfMaterial[];
  images: GltfImage[];
}

const GLB_MAGIC = 0x46546c67;         // 'glTF'
const GLB_CHUNK_JSON = 0x4e4f534a;    // 'JSON'
const GLB_CHUNK_BIN = 0x004e4942;     // 'BIN\0'
const MODE_TRIANGLES = 4;

/** Components per element, by the accessor `type` string. */
const ACCESSOR_COMPONENTS: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

/** Bytes per component, by `componentType`. 5124 is absent because glTF never assigns it. */
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** The bare shapes this reader touches. Everything is optional because a glTF file may omit any of it, and
 *  every field is re-checked at the point of use — the JSON chunk is untrusted input like `extras` is. */
interface GltfJson {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: {
    name?: string; mesh?: number; children?: number[]; extras?: unknown;
    matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[];
  }[];
  meshes?: { name?: string; primitives?: {
    attributes?: Record<string, number>; indices?: number; material?: number; mode?: number;
  }[] }[];
  materials?: { name?: string; extras?: unknown; alphaMode?: unknown; alphaCutoff?: unknown; pbrMetallicRoughness?: {
    baseColorFactor?: number[]; baseColorTexture?: { index?: number };
  } }[];
  textures?: { source?: number }[];
  images?: { name?: string; mimeType?: string; bufferView?: number; uri?: string }[];
  accessors?: {
    bufferView?: number; byteOffset?: number; componentType?: number; count?: number;
    type?: string; normalized?: boolean; sparse?: unknown;
  }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number; byteStride?: number }[];
  buffers?: { uri?: string; byteLength?: number }[];
}

/** base64 → bytes. `atob` rather than `Buffer`, because core is shared with the browser bundle. */
function base64Bytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** The payload of a `data:` URI, base64 or percent-encoded. */
function dataUriBytes(uri: string): Uint8Array {
  const comma = uri.indexOf(',');
  if (comma < 0) throw new Error('malformed data: URI in the glTF file');
  const body = uri.slice(comma + 1);
  if (/;base64$/i.test(uri.slice(0, comma))) return base64Bytes(body);
  const text = decodeURIComponent(body);
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** Read one component, scaled when the accessor is `normalized`. Integer attributes are otherwise handed
 *  back as the integers they are, which is what a POSITION stored as shorts means. */
function componentReader(view: DataView, componentType: number, normalized: boolean): (at: number) => number {
  switch (componentType) {
    case 5126: return at => view.getFloat32(at, true);
    case 5125: return at => view.getUint32(at, true);
    case 5123: return normalized ? at => view.getUint16(at, true) / 65535 : at => view.getUint16(at, true);
    case 5122: return normalized ? at => Math.max(view.getInt16(at, true) / 32767, -1)
      : at => view.getInt16(at, true);
    case 5121: return normalized ? at => view.getUint8(at) / 255 : at => view.getUint8(at);
    case 5120: return normalized ? at => Math.max(view.getInt8(at) / 127, -1) : at => view.getInt8(at);
    default: throw new Error(`unsupported glTF componentType ${componentType}`);
  }
}

/** Compose TRS into a column-major matrix — the same arrangement three.js's `Matrix4.compose` produces, so
 *  a node built here and one built by the loader agree to the bit. */
function composeMatrix(t: readonly number[], q: readonly number[], s: readonly number[]): Mat4 {
  const [x, y, z, w] = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  return [
    (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
    (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
    (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}

/** `a × b`, applying `b` first — parent × child, the order a hierarchy flattens in. */
export function multiplyMatrix(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16);
  for (let column = 0; column < 4; column++) {
    for (let row = 0; row < 4; row++) {
      out[column * 4 + row] = a[row] * b[column * 4]
        + a[4 + row] * b[column * 4 + 1]
        + a[8 + row] * b[column * 4 + 2]
        + a[12 + row] * b[column * 4 + 3];
    }
  }
  return out;
}

/** A POINT through a matrix, perspective divide included so a projective node transform cannot silently
 *  land somewhere else than three.js's `applyMatrix4` would put it. */
export function transformPoint(m: Mat4, p: readonly [number, number, number]): [number, number, number] {
  const [x, y, z] = p;
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const k = w !== 0 ? 1 / w : 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) * k,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) * k,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) * k,
  ];
}

/** A DIRECTION through a matrix — the upper 3×3 and no translation, returned unit, matching three.js's
 *  `Vector3.transformDirection`. A declared spin axis rides this so it stays local to the node that made it. */
export function transformDirection(m: Mat4, v: readonly [number, number, number]): [number, number, number] {
  const [x, y, z] = v;
  const dx = m[0] * x + m[4] * y + m[8] * z;
  const dy = m[1] * x + m[5] * y + m[9] * z;
  const dz = m[2] * x + m[6] * y + m[10] * z;
  const length = Math.hypot(dx, dy, dz);
  return length > 0 ? [dx / length, dy / length, dz / length] : [0, 0, 0];
}

/** A matrix's translation column — a node's world position. */
export function matrixPosition(m: Mat4): [number, number, number] {
  return [m[12], m[13], m[14]];
}

/**
 * Parse a GLB (or a self-contained .gltf) into plain data.
 *
 * Throws with a message meant for a toast on anything it cannot read, which includes an external `.bin`
 * sidecar: a prop travels as ONE file through this pipeline, and half-reading a model whose geometry lives
 * somewhere else would produce a plausible-looking record with pieces missing.
 */
export function decodeGlb(bytes: Uint8Array): DecodedGltf {
  const { json, bin } = splitContainer(bytes);
  const buffers = readBuffers(json, bin);
  const views = (json.bufferViews ?? []).map(view => {
    const source = buffers[view.buffer ?? 0];
    if (!source) throw new Error(`glTF bufferView names buffer ${view.buffer} which the file does not carry`);
    const offset = view.byteOffset ?? 0;
    const length = view.byteLength ?? Math.max(0, source.byteLength - offset);
    return { bytes: source.subarray(offset, offset + length), stride: view.byteStride ?? 0 };
  });

  /** One accessor de-strided into a flat array of `count * components` numbers. */
  const readAccessor = (index: number): { values: Float64Array; components: number; count: number } => {
    const accessor = (json.accessors ?? [])[index];
    if (!accessor) throw new Error(`glTF accessor ${index} is missing`);
    if (accessor.sparse) throw new Error('sparse glTF accessors are not read — re-export without them');
    const components = ACCESSOR_COMPONENTS[accessor.type ?? ''] ?? 0;
    const width = COMPONENT_BYTES[accessor.componentType ?? 0] ?? 0;
    if (!components) throw new Error(`unsupported glTF accessor type "${accessor.type}"`);
    if (!width) throw new Error(`unsupported glTF componentType ${accessor.componentType}`);
    const count = accessor.count ?? 0;
    const values = new Float64Array(count * components);
    // An accessor with no bufferView reads as zeros — the format says so, and it is how a file declares an
    // attribute it means to fill in with a sparse override (which this reader has already refused).
    if (accessor.bufferView === undefined) return { values, components, count };
    const view = views[accessor.bufferView];
    if (!view) throw new Error(`glTF accessor ${index} names bufferView ${accessor.bufferView}`);
    const data = new DataView(view.bytes.buffer, view.bytes.byteOffset, view.bytes.byteLength);
    const read = componentReader(data, accessor.componentType!, !!accessor.normalized);
    const stride = view.stride || components * width;
    const base = accessor.byteOffset ?? 0;
    if (base + Math.max(0, count - 1) * stride + components * width > view.bytes.byteLength)
      throw new Error(`glTF accessor ${index} reads past the end of its bufferView`);
    for (let element = 0; element < count; element++) {
      const at = base + element * stride;
      for (let c = 0; c < components; c++) values[element * components + c] = read(at + c * width);
    }
    return { values, components, count };
  };

  const meshes: GltfMesh[] = (json.meshes ?? []).map((mesh, meshIndex) => ({
    name: mesh.name ?? `mesh${meshIndex}`,
    primitives: (mesh.primitives ?? []).map(primitive => {
      // Only triangles. A strip or a fan would have to be re-wound to be stored, and this pipeline's whole
      // orientation contract (docs/032) is written about triangles — quietly converting one would put a
      // second winding rule in the code path the volume guard is meant to protect.
      const mode = primitive.mode ?? MODE_TRIANGLES;
      if (mode !== MODE_TRIANGLES)
        throw new Error(`"${mesh.name ?? 'mesh'}" draws glTF mode ${mode} — only triangles (4) import`);
      const positionIndex = primitive.attributes?.POSITION;
      if (positionIndex === undefined) throw new Error(`"${mesh.name ?? 'mesh'}" has no POSITION attribute`);
      const position = readAccessor(positionIndex);
      const uvIndex = primitive.attributes?.TEXCOORD_0;
      const uv = uvIndex === undefined ? null : readAccessor(uvIndex);
      return {
        positions: Float32Array.from(position.values),
        uvs: uv ? Float32Array.from(uv.values) : null,
        indices: primitive.indices === undefined
          ? null : Uint32Array.from(readAccessor(primitive.indices).values),
        material: primitive.material ?? null,
      };
    }),
  }));

  const images: GltfImage[] = (json.images ?? []).map((image, imageIndex) => {
    const embedded = image.bufferView !== undefined ? views[image.bufferView]?.bytes ?? null : null;
    const uri = image.uri ?? null;
    return {
      name: image.name ?? `image${imageIndex}`,
      mimeType: image.mimeType ?? null,
      bytes: embedded ?? (uri?.startsWith('data:') ? dataUriBytes(uri) : null),
      // A `data:` URI has already become bytes, so only a real file reference is worth handing on.
      uri: uri && !uri.startsWith('data:') ? uri : null,
    };
  });

  const textures = json.textures ?? [];
  const materials: GltfMaterial[] = (json.materials ?? []).map((material, materialIndex) => {
    const pbr = material.pbrMetallicRoughness ?? {};
    const texture = pbr.baseColorTexture?.index;
    const source = texture === undefined ? undefined : textures[texture]?.source;
    const factor = pbr.baseColorFactor;
    return {
      name: material.name ?? `material${materialIndex}`,
      baseColorImage: source !== undefined && images[source] ? source : null,
      baseColorFactor: Array.isArray(factor) && factor.length >= 4
        ? [factor[0], factor[1], factor[2], factor[3]] : [1, 1, 1, 1],
      alphaMode: material.alphaMode === 'OPAQUE' || material.alphaMode === 'MASK' || material.alphaMode === 'BLEND'
        ? material.alphaMode : null,
      extras: material.extras,
    };
  });

  return { nodes: flattenNodes(json), meshes, materials, images };
}

/** The GLB container: a 12-byte header then length-prefixed chunks. A file that is plain JSON is accepted
 *  too, so a `.gltf` with embedded buffers reads through the same entry point. */
function splitContainer(bytes: Uint8Array): { json: GltfJson; bin: Uint8Array | null } {
  const text = new TextDecoder();
  if (bytes.byteLength < 12) throw new Error('this file is too short to be a GLB');
  const head = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (head.getUint32(0, true) !== GLB_MAGIC) {
    // Not a container. A .gltf is UTF-8 JSON; anything else fails here with the parse error as the reason.
    try {
      return { json: JSON.parse(text.decode(bytes)) as GltfJson, bin: null };
    } catch {
      throw new Error('this file is not a GLB or a glTF document');
    }
  }
  const version = head.getUint32(4, true);
  if (version !== 2) throw new Error(`GLB version ${version} — this reader speaks glTF 2.0`);
  const total = Math.min(head.getUint32(8, true), bytes.byteLength);
  let json: GltfJson | null = null;
  let bin: Uint8Array | null = null;
  for (let at = 12; at + 8 <= total;) {
    const length = head.getUint32(at, true);
    const type = head.getUint32(at + 4, true);
    const body = bytes.subarray(at + 8, at + 8 + length);
    if (body.byteLength < length) throw new Error('GLB chunk runs past the end of the file');
    if (type === GLB_CHUNK_JSON && !json) json = JSON.parse(text.decode(body)) as GltfJson;
    else if (type === GLB_CHUNK_BIN && !bin) bin = body;
    // Unknown chunk types are skipped by design: the format reserves them for extensions.
    at += 8 + length;
  }
  if (!json) throw new Error('this GLB carries no JSON chunk');
  return { json, bin };
}

/** Every declared buffer as bytes. The BIN chunk answers the one buffer with no `uri`, which is how a GLB
 *  always stores its geometry; a `data:` URI is decoded; a sidecar file is refused. */
function readBuffers(json: GltfJson, bin: Uint8Array | null): (Uint8Array | null)[] {
  return (json.buffers ?? []).map(buffer => {
    if (buffer.uri === undefined) {
      if (!bin) throw new Error('this glTF names its binary chunk but the file does not carry one');
      return bin;
    }
    if (buffer.uri.startsWith('data:')) return dataUriBytes(buffer.uri);
    throw new Error(`"${buffer.uri}" lives beside the model — export a self-contained GLB instead`);
  });
}

/**
 * The default scene's node hierarchy, flattened depth-first with world matrices already composed.
 *
 * A node reached twice would be a cycle or a shared subtree; the format forbids both, and the visited set
 * turns a malformed file into a truncated import rather than an infinite loop.
 */
function flattenNodes(json: GltfJson): GltfNode[] {
  const source = json.nodes ?? [];
  const scene = (json.scenes ?? [])[json.scene ?? 0];
  // A file with no scene still has nodes; treating every node as a root is what a viewer does with one.
  const roots = scene?.nodes ?? source.map((_node, index) => index);
  const out: GltfNode[] = [];
  const visited = new Set<number>();
  const walk = (index: number, parent: number, parentWorld: Mat4): void => {
    const node = source[index];
    if (!node || visited.has(index)) return;
    visited.add(index);
    const local = Array.isArray(node.matrix) && node.matrix.length === 16
      ? node.matrix.slice()
      : composeMatrix(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1]);
    const world = multiplyMatrix(parentWorld, local);
    const here = out.length;
    out.push({
      index: here,
      name: node.name ?? `node${index}`,
      parent,
      mesh: node.mesh ?? null,
      extras: node.extras,
      world,
    });
    for (const child of node.children ?? []) walk(child, here, world);
  };
  const identity: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const root of roots) walk(root, -1, identity);
  return out;
}
