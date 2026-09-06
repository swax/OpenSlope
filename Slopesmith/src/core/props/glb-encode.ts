/**
 * Plain arrays → glTF 2.0 / GLB, with no exporter behind it.
 *
 * The exact mirror of `glb-decode.ts`, and it exists for the same reason: three.js's `GLTFExporter` wants a
 * `document`, a `Blob` and a `FileReader`, so nothing outside a tab can use it without the shim
 * `routes/mixamo-character.ts` carries. This takes numbers and returns bytes, so the Blender bridge
 * (docs/046) can hand a model OUT of the server with no browser in the loop, and so the encoding itself
 * stays testable — `decodeGlb(encodeGlb(x))` is an assertion the suite can make about real container bytes
 * rather than about a mock of an exporter.
 *
 * Scope is the decoder's scope, read backwards: triangles, one base-colour page per material, embedded
 * images, a flat-or-nested node hierarchy, and `extras` on scenes, nodes, meshes and materials. No skins, no
 * morph targets, no animation samplers — a prop's motion is DECLARED in `extras` and rebuilt as a native clip
 * (`importedSpinAnimation`), and writing a glTF animation channel would put a second source of truth in the
 * file the importer would then have to choose between.
 *
 * What comes out is a single-buffer GLB: one BIN chunk holding every accessor and every image, which is the
 * only arrangement `decodeGlb` reads back (it refuses a `.bin` sidecar on purpose) and the one Blender's
 * importer is happiest with.
 */

/** One drawable run. Positions are in the owning node's LOCAL space, exactly as the decoder returns them. */
export interface EncodePrimitive {
  /** VEC3, `count * 3` floats. */
  positions: Float32Array;
  /** VEC2, `count * 2` floats, or null/omitted for a primitive with no TEXCOORD_0. */
  uvs?: Float32Array | null;
  /** VEC3, `count * 3` floats. Optional: glTF lets a reader derive flat normals, and the prop pipeline
   *  derives its own from the winding anyway — but Blender shades a file with normals the way it will look. */
  normals?: Float32Array | null;
  /** Triangle corners. Required: an unindexed primitive would defeat the vertex sharing a cage depends on. */
  indices: Uint32Array;
  /** Index into `EncodeScene.materials`, or null/omitted for the format's default material. */
  material?: number | null;
}

export interface EncodeMesh {
  name: string;
  primitives: EncodePrimitive[];
  extras?: unknown;
}

/** A material reduced to what a prop can wear, plus the alpha and side flags Blender needs to draw a
 *  cut-out sheet the way the game does. */
export interface EncodeMaterial {
  name: string;
  /** Index into `EncodeScene.images`, or null for a flat-colour material. */
  baseColorImage?: number | null;
  /** LINEAR RGBA. Defaults to opaque white, as the format does. */
  baseColorFactor?: readonly [number, number, number, number];
  /** Prop sheets are lit once and shown from both sides (docs/028), so the default is double-sided —
   *  a single-sided Blender material would hide half a fence the game draws. */
  doubleSided?: boolean;
  alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  extras?: unknown;
}

export interface EncodeImage {
  name: string;
  /** `image/png` or `image/jpeg` — the two the format allows embedded. */
  mimeType: string;
  bytes: Uint8Array;
}

export interface EncodeNode {
  name: string;
  /** Index into `EncodeScene.meshes`, or null for a pure transform / marker node. */
  mesh?: number | null;
  /** Indices into `EncodeScene.nodes`. A node listed as somebody's child is not also a scene root. */
  children?: readonly number[];
  translation?: readonly [number, number, number];
  /** XYZW, the order glTF stores a quaternion in. */
  rotation?: readonly [number, number, number, number];
  scale?: readonly [number, number, number];
  extras?: unknown;
}

export interface EncodeScene {
  nodes: EncodeNode[];
  meshes?: EncodeMesh[];
  materials?: EncodeMaterial[];
  images?: EncodeImage[];
  /** Scene-level `extras`. Blender's importer drops these, which is why the bridge's stamp rides a NODE
   *  instead — but the field is here because the format has it and the decoder reads it back. */
  extras?: unknown;
  /** Written into `asset.generator`, so a file's provenance is legible in any glTF inspector. */
  generator?: string;
}

const GLB_MAGIC = 0x46546c67;         // 'glTF'
const GLB_VERSION = 2;
const GLB_CHUNK_JSON = 0x4e4f534a;    // 'JSON'
const GLB_CHUNK_BIN = 0x004e4942;     // 'BIN\0'
const MODE_TRIANGLES = 4;

const COMPONENT_FLOAT = 5126;
const COMPONENT_UINT = 5125;

/** glTF's `bufferView.target` values. Set on geometry views (and NOT on image views, which the spec
 *  forbids a target on) so a loader can bind them without inspecting every accessor first. */
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

/** Round up to the next multiple of four — the alignment glTF requires of every chunk and of every
 *  bufferView an accessor reads through. */
const align4 = (n: number): number => (n + 3) & ~3;

interface JsonAccessor {
  bufferView: number;
  componentType: number;
  count: number;
  type: string;
  min?: number[];
  max?: number[];
}

interface JsonBufferView {
  buffer: 0;
  byteOffset: number;
  byteLength: number;
  target?: number;
}

/**
 * Collects typed arrays and image blobs into one BIN chunk, handing back the bufferView index for each.
 *
 * Every view starts 4-byte aligned. That is stricter than the format demands of an image, and exactly what
 * it demands of a float or uint accessor — doing it uniformly means a PNG landing between two accessors can
 * never push the next one off its component boundary, which is the one alignment bug in this file's shape
 * that reads as corrupt geometry rather than as an error.
 */
class BinaryChunk {
  private readonly parts: Uint8Array[] = [];
  private length = 0;
  readonly views: JsonBufferView[] = [];

  /** Append bytes as a new bufferView, returning its index. */
  add(bytes: Uint8Array, target?: number): number {
    const pad = align4(this.length) - this.length;
    if (pad) { this.parts.push(new Uint8Array(pad)); this.length += pad; }
    const byteOffset = this.length;
    this.parts.push(bytes);
    this.length += bytes.byteLength;
    this.views.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    return this.views.length - 1;
  }

  /** The chunk, padded with zeros to the 4-byte boundary the container requires. */
  bytes(): Uint8Array {
    const total = align4(this.length);
    const out = new Uint8Array(total);
    let at = 0;
    for (const part of this.parts) { out.set(part, at); at += part.byteLength; }
    return out;
  }
}

/** A typed array's bytes, whatever its element width — the view is over the same memory, not a copy. */
const rawBytes = (view: ArrayBufferView): Uint8Array =>
  new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

/** Per-component min/max over a de-strided attribute. glTF REQUIRES these on POSITION (a viewer frames the
 *  model from them), and a file missing them is rejected by the reference validator. */
function bounds(values: Float32Array, components: number): { min: number[]; max: number[] } {
  const min = new Array<number>(components).fill(Infinity);
  const max = new Array<number>(components).fill(-Infinity);
  for (let at = 0; at + components <= values.length; at += components) {
    for (let c = 0; c < components; c++) {
      const value = values[at + c];
      if (value < min[c]) min[c] = value;
      if (value > max[c]) max[c] = value;
    }
  }
  // An empty attribute has no extent. Zeros keep the file valid rather than writing Infinity into JSON,
  // where it would serialise as `null` and fail every validator that reads it back.
  for (let c = 0; c < components; c++) {
    if (!Number.isFinite(min[c])) { min[c] = 0; max[c] = 0; }
  }
  return { min, max };
}

/**
 * Pack a scene into GLB bytes.
 *
 * Throws on the two shapes that would produce a file `decodeGlb` reads as something other than what was
 * meant: a primitive with no positions, and an index that names a vertex the primitive does not carry.
 * Both are cheap to check here and expensive to diagnose from the other end of a Blender round trip.
 */
export function encodeGlb(scene: EncodeScene): Uint8Array {
  const bin = new BinaryChunk();
  const accessors: JsonAccessor[] = [];

  /** A float attribute (VEC2/VEC3) as an accessor, with the bounds POSITION needs. */
  const floatAccessor = (values: Float32Array, components: number): number => {
    const bufferView = bin.add(rawBytes(values), TARGET_ARRAY_BUFFER);
    const { min, max } = bounds(values, components);
    accessors.push({
      bufferView, componentType: COMPONENT_FLOAT, count: values.length / components,
      type: components === 2 ? 'VEC2' : 'VEC3', min, max,
    });
    return accessors.length - 1;
  };

  const indexAccessor = (values: Uint32Array): number => {
    const bufferView = bin.add(rawBytes(values), TARGET_ELEMENT_ARRAY_BUFFER);
    accessors.push({ bufferView, componentType: COMPONENT_UINT, count: values.length, type: 'SCALAR' });
    return accessors.length - 1;
  };

  const images = (scene.images ?? []).map(image => ({
    name: image.name,
    mimeType: image.mimeType,
    // No target: the spec forbids one on an image's bufferView.
    bufferView: bin.add(image.bytes),
  }));

  // One texture per image, one sampler for all of them. The indirection carries nothing a PS2-era prop bank
  // can express (no per-tile filter or wrap), so it is written flat rather than deduplicated.
  const textures = images.map((_image, index) => ({ source: index, sampler: 0 }));

  const materials = (scene.materials ?? []).map(material => {
    const image = material.baseColorImage ?? null;
    return {
      name: material.name,
      pbrMetallicRoughness: {
        baseColorFactor: [...(material.baseColorFactor ?? [1, 1, 1, 1])],
        ...(image !== null && textures[image] ? { baseColorTexture: { index: image } } : {}),
        // Prop art is unlit in the game and lit per-vertex in the editor; a metallic default would make
        // every model read as chrome the moment it lands in Blender's viewport.
        metallicFactor: 0,
        roughnessFactor: 1,
      },
      doubleSided: material.doubleSided ?? true,
      ...(material.alphaMode && material.alphaMode !== 'OPAQUE' ? { alphaMode: material.alphaMode } : {}),
      ...(material.extras !== undefined ? { extras: material.extras } : {}),
    };
  });

  const meshes = (scene.meshes ?? []).map(mesh => ({
    name: mesh.name,
    primitives: mesh.primitives.map(primitive => {
      const count = primitive.positions.length / 3;
      if (!count) throw new Error(`"${mesh.name}" has a primitive with no positions`);
      if (primitive.uvs && primitive.uvs.length / 2 !== count)
        throw new Error(`"${mesh.name}" has ${count} positions but ${primitive.uvs.length / 2} UVs`);
      if (primitive.normals && primitive.normals.length / 3 !== count)
        throw new Error(`"${mesh.name}" has ${count} positions but ${primitive.normals.length / 3} normals`);
      for (const corner of primitive.indices) {
        if (corner >= count) throw new Error(`"${mesh.name}" indexes vertex ${corner} of ${count}`);
      }
      return {
        attributes: {
          POSITION: floatAccessor(primitive.positions, 3),
          ...(primitive.uvs ? { TEXCOORD_0: floatAccessor(primitive.uvs, 2) } : {}),
          ...(primitive.normals ? { NORMAL: floatAccessor(primitive.normals, 3) } : {}),
        },
        indices: indexAccessor(primitive.indices),
        mode: MODE_TRIANGLES,
        ...(primitive.material !== undefined && primitive.material !== null
          ? { material: primitive.material } : {}),
      };
    }),
    ...(mesh.extras !== undefined ? { extras: mesh.extras } : {}),
  }));

  const claimed = new Set<number>();
  for (const node of scene.nodes) for (const child of node.children ?? []) claimed.add(child);
  const roots = scene.nodes.map((_node, index) => index).filter(index => !claimed.has(index));

  const json = {
    asset: { version: '2.0', generator: scene.generator ?? 'Slopesmith' },
    scene: 0,
    scenes: [{ nodes: roots, ...(scene.extras !== undefined ? { extras: scene.extras } : {}) }],
    nodes: scene.nodes.map(node => ({
      name: node.name,
      ...(node.mesh !== undefined && node.mesh !== null ? { mesh: node.mesh } : {}),
      ...(node.children?.length ? { children: [...node.children] } : {}),
      ...(node.translation ? { translation: [...node.translation] } : {}),
      ...(node.rotation ? { rotation: [...node.rotation] } : {}),
      ...(node.scale ? { scale: [...node.scale] } : {}),
      ...(node.extras !== undefined ? { extras: node.extras } : {}),
    })),
    ...(meshes.length ? { meshes } : {}),
    ...(materials.length ? { materials } : {}),
    ...(textures.length ? { textures, samplers: [{}] } : {}),
    ...(images.length ? { images } : {}),
    ...(accessors.length ? { accessors } : {}),
    ...(bin.views.length ? { bufferViews: bin.views } : {}),
    buffers: [{ byteLength: 0 }],
  };

  const binary = bin.bytes();
  json.buffers[0].byteLength = binary.byteLength;

  // Serialise LAST: `buffers[0].byteLength` is only known once every view is placed, and a JSON chunk is
  // padded with SPACES rather than zeros so it stays parseable text at any alignment.
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const jsonChunk = new Uint8Array(align4(encoded.byteLength)).fill(0x20);
  jsonChunk.set(encoded);

  const total = 12 + 8 + jsonChunk.byteLength + (binary.byteLength ? 8 + binary.byteLength : 0);
  const out = new Uint8Array(total);
  const head = new DataView(out.buffer);
  head.setUint32(0, GLB_MAGIC, true);
  head.setUint32(4, GLB_VERSION, true);
  head.setUint32(8, total, true);
  head.setUint32(12, jsonChunk.byteLength, true);
  head.setUint32(16, GLB_CHUNK_JSON, true);
  out.set(jsonChunk, 20);
  if (binary.byteLength) {
    const at = 20 + jsonChunk.byteLength;
    head.setUint32(at, binary.byteLength, true);
    head.setUint32(at + 4, GLB_CHUNK_BIN, true);
    out.set(binary, at + 8);
  }
  return out;
}
