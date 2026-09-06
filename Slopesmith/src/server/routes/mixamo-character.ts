import { writeFile } from 'node:fs/promises';
import { ensureDir, pathExists } from '../fs-async';
import { join } from 'node:path';
import {
  Box3, Bone, Group, LoadingManager, Matrix4, Quaternion, Skeleton, SkinnedMesh, Vector3,
  type Material,
} from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { Canvas, Image, ImageData, createCanvas } from '@napi-rs/canvas';
import { safeDataName, storeUnderFreeName } from './safe-name';
import {
  MIXAMO_TO_SLOPESMITH, REQUIRED_CHARACTER_BONES,
  type CanonicalCharacterBone, type MixamoBone,
} from '../../core/characters/contract';
import { characterLibraryDir } from './characters';

/** Mixamo's FBX files use centimetres and are commonly 2-60 MB with their textures embedded. */
export const MAX_CHARACTER_FBX_BYTES = 96 * 1024 * 1024;
/** Standing bind-pose height used to make every imported skin a consistent Slopesmith boarder. */
export const IMPORTED_CHARACTER_HEIGHT_METRES = 1.75;
/** Decode and model budgets share the upload boundary: compressed FBX size alone does not bound their heap cost. */
export const MAX_CHARACTER_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_CHARACTER_IMAGE_PIXELS = 4096 * 4096;
export const MAX_CHARACTER_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;
export const MAX_CHARACTER_TOTAL_IMAGE_PIXELS = 32 * 1024 * 1024;
export const MAX_CHARACTER_IMAGES = 16;
export const MAX_CHARACTER_MESHES = 64;
export const MAX_CHARACTER_BONES = 512;
export const MAX_CHARACTER_VERTICES = 2_000_000;
export const MAX_CHARACTER_TRIANGLES = 4_000_000;
export const MAX_CHARACTER_GLB_BYTES = 128 * 1024 * 1024;

/** The Mixamo joint at the authored tail of each driven bone. */
const TAIL_JOINT: Record<CanonicalCharacterBone, string> = {
  Hips: 'Spine',
  Spine: 'Spine1',
  Chest: 'Spine2',
  ChestUpper: 'Neck',
  Neck: 'Head',
  Head: 'HeadTopEnd',
  'Clavicle.L': 'LeftArm',
  'UpperArm.L': 'LeftForeArm',
  'LowerArm.L': 'LeftHand',
  'Hand.L': 'LeftHandMiddle1',
  'Clavicle.R': 'RightArm',
  'UpperArm.R': 'RightForeArm',
  'LowerArm.R': 'RightHand',
  'Hand.R': 'RightHandMiddle1',
  'UpperLeg.L': 'LeftLeg',
  'LowerLeg.L': 'LeftFoot',
  'Foot.L': 'LeftToeBase',
  'UpperLeg.R': 'RightLeg',
  'LowerLeg.R': 'RightFoot',
  'Foot.R': 'RightToeBase',
};

export interface MixamoCharacterReport {
  source: string;
  file: string;
  meshes: number;
  bones: number;
  vertices: number;
  triangles: number;
  textures: number;
  unweightedVertices: number;
  sourceHeightMetres: number;
  heightMetres: number;
  outputBytes: number;
  warnings: string[];
}

export interface ConvertedMixamoCharacter {
  glb: Buffer;
  report: MixamoCharacterReport;
}

/** FBXLoader removes punctuation before it creates Bone objects. Prefix digits vary across Mixamo exports. */
export function mixamoBoneKey(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').replace(/^mixamorig\d*/i, '');
}

function characterStem(sourceName: string): string {
  const words = sourceName.replace(/\.fbx$/i, '').trim().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const safe = safeDataName(words) || 'mixamo-character';
  return /-rigged$/i.test(safe) ? safe : `${safe}-rigged`;
}

interface ImageBoundary {
  blobs: Map<string, Blob>;
  imageBytes: number;
  imagePixels: number;
  images: number;
}

/** FBX parsing is serialized below, so the browser-shaped global image bridge always has one explicit owner. */
let activeImageBoundary: ImageBoundary | null = null;

function imageDimensions(bytes: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === 'image/png' && bytes.length >= 24
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const frames = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    for (let at = 2; at + 8 < bytes.length;) {
      if (bytes[at] !== 0xff) { at++; continue; }
      const marker = bytes[at + 1];
      at += 2;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (at + 2 > bytes.length) break;
      const length = bytes.readUInt16BE(at);
      if (length < 2 || at + length > bytes.length) break;
      if (frames.has(marker) && length >= 7) {
        return { width: bytes.readUInt16BE(at + 5), height: bytes.readUInt16BE(at + 3) };
      }
      at += length;
    }
    return null;
  }
  if (mime === 'image/webp' && bytes.length >= 30
    && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    }
    if (kind === 'VP8L' && bytes[20] === 0x2f) {
      return {
        width: 1 + ((bytes[21] | bytes[22] << 8) & 0x3fff),
        height: 1 + ((bytes[22] >> 6 | bytes[23] << 2 | bytes[24] << 10) & 0x3fff),
      };
    }
    if (kind === 'VP8 ') {
      const signature = bytes.indexOf(Buffer.from([0x9d, 0x01, 0x2a]), 20);
      if (signature >= 0 && signature + 7 <= bytes.length) {
        return {
          width: bytes.readUInt16LE(signature + 3) & 0x3fff,
          height: bytes.readUInt16LE(signature + 5) & 0x3fff,
        };
      }
    }
    return null;
  }
  if (mime === 'image/bmp' && bytes.length >= 26 && bytes.toString('ascii', 0, 2) === 'BM') {
    return { width: Math.abs(bytes.readInt32LE(18)), height: Math.abs(bytes.readInt32LE(22)) };
  }
  if (mime === 'image/tga' && bytes.length >= 18) {
    return { width: bytes.readUInt16LE(12), height: bytes.readUInt16LE(14) };
  }
  if (mime === 'image/tiff' && bytes.length >= 16) {
    const little = bytes.toString('ascii', 0, 2) === 'II';
    if (!little && bytes.toString('ascii', 0, 2) !== 'MM') return null;
    const u16 = (at: number) => little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at);
    const u32 = (at: number) => little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at);
    if (u16(2) !== 42) return null;
    const directory = u32(4);
    if (directory + 2 > bytes.length) return null;
    const entries = u16(directory);
    if (entries > 4096) return null;
    let width = 0, height = 0;
    for (let index = 0; index < entries; index++) {
      const at = directory + 2 + index * 12;
      if (at + 12 > bytes.length) break;
      const tag = u16(at), type = u16(at + 2), count = u32(at + 4);
      if ((tag !== 256 && tag !== 257) || count !== 1 || (type !== 3 && type !== 4)) continue;
      const value = type === 3 ? u16(at + 8) : u32(at + 8);
      if (tag === 256) width = value; else height = value;
    }
    return width && height ? { width, height } : null;
  }
  return null;
}

function claimEmbeddedImage(boundary: ImageBoundary, bytes: Buffer, rawMime: string): Buffer {
  const mime = rawMime.toLowerCase().split(';')[0];
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/bmp', 'image/tga', 'image/tiff'].includes(mime))
    throw new Error(`embedded FBX image type ${mime || '(missing)'} is not supported`);
  if (!bytes.length || bytes.length > MAX_CHARACTER_IMAGE_BYTES)
    throw new Error('an embedded FBX image exceeds the 16 MB decode limit');
  const dimensions = imageDimensions(bytes, mime);
  if (!dimensions?.width || !dimensions.height) throw new Error(`embedded FBX ${mime} dimensions are invalid`);
  const pixels = dimensions.width * dimensions.height;
  if (!Number.isSafeInteger(pixels) || pixels > MAX_CHARACTER_IMAGE_PIXELS)
    throw new Error('an embedded FBX image exceeds the 4096×4096 decode limit');
  boundary.images++;
  boundary.imageBytes += bytes.length;
  boundary.imagePixels += pixels;
  if (boundary.images > MAX_CHARACTER_IMAGES || boundary.imageBytes > MAX_CHARACTER_TOTAL_IMAGE_BYTES
    || boundary.imagePixels > MAX_CHARACTER_TOTAL_IMAGE_PIXELS) {
    throw new Error('embedded FBX images exceed the character import budget');
  }
  return bytes;
}

function dataImage(value: string): { bytes: Buffer; mime: string } {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(value);
  if (!match) throw new Error('FBX embedded image data must be a base64 image');
  const encoded = match[2].replace(/[\r\n]/g, '');
  if (encoded.length > Math.ceil(MAX_CHARACTER_IMAGE_BYTES / 3) * 4 + 4)
    throw new Error('an embedded FBX image exceeds the 16 MB decode limit');
  return { mime: match[1], bytes: Buffer.from(encoded, 'base64') };
}

/* Three's loaders are browser-first. @napi-rs/canvas supplies the image/canvas pieces in Node, while this
 * tiny FileReader bridge supplies the Blob reads used by GLTFExporter. This is conversion support, not a
 * renderer: there is no browser, WebGL context, Blender process, or visible window on the server. */
function installNodeImageBridge() {
  const globals = globalThis as unknown as Record<string, unknown>;
  const imagePrototype = Image.prototype as typeof Image.prototype & Record<string | symbol, unknown>;
  const marker = Symbol.for('slopesmith.node-image-bridge');
  if (!imagePrototype[marker]) {
    const source = Object.getOwnPropertyDescriptor(Image.prototype, 'src');
    if (!source?.set) throw new Error('Node image decoder does not expose an image source setter');
    Object.defineProperty(Image.prototype, 'src', {
      configurable: true,
      get: source.get,
      set(this: Image & { onerror?: (error: unknown) => void }, value: unknown) {
        const boundary = activeImageBoundary;
        if (boundary && typeof value === 'string' && value.startsWith('data:')) {
          try {
            const image = dataImage(value);
            source.set!.call(this, claimEmbeddedImage(boundary, image.bytes, image.mime));
          } catch (error) { queueMicrotask(() => this.onerror?.(error)); }
          return;
        }
        if (boundary && typeof value === 'string' && value.startsWith('blob:')) {
          const blob = boundary.blobs.get(value);
          if (blob) {
            if (!blob.size || blob.size > MAX_CHARACTER_IMAGE_BYTES) {
              boundary.blobs.delete(value);
              URL.revokeObjectURL(value);
              queueMicrotask(() => this.onerror?.(new Error('an embedded FBX image exceeds the 16 MB decode limit')));
              return;
            }
            void blob.arrayBuffer()
              .then(bytes => claimEmbeddedImage(boundary, Buffer.from(bytes), blob.type))
              .then(bytes => source.set!.call(this, bytes))
              .catch(error => this.onerror?.(error))
              .finally(() => {
                boundary.blobs.delete(value);
                URL.revokeObjectURL(value);
              });
            return;
          }
        }
        // This is the security boundary: never hand a pathname, network URL, foreign Blob URL, Buffer or
        // browser-shaped object to the native decoder. @napi-rs/canvas treats strings as server filenames.
        queueMicrotask(() => this.onerror?.(new Error('external FBX texture references are not allowed')));
      },
    });
    imagePrototype.addEventListener = function(this: Record<string, unknown>, type: string, listener: unknown) {
      this[`on${type}`] = listener;
    };
    imagePrototype.removeEventListener = function(this: Record<string, unknown>, type: string, listener: unknown) {
      if (this[`on${type}`] === listener) this[`on${type}`] = null;
    };
    imagePrototype[marker] = true;
  }

  class NodeFileReader {
    result: string | ArrayBuffer | null = null;
    onloadend: (() => void) | null = null;

    readAsArrayBuffer(blob: Blob) {
      void blob.arrayBuffer().then(result => {
        this.result = result;
        this.onloadend?.();
      });
    }

    readAsDataURL(blob: Blob) {
      void blob.arrayBuffer().then(result => {
        this.result = `data:${blob.type};base64,${Buffer.from(result).toString('base64')}`;
        this.onloadend?.();
      });
    }
  }

  globals.window = globalThis;
  globals.document = {
    createElementNS: (_namespace: string, name: string) => name === 'img' ? new Image() : createCanvas(1, 1),
    createElement: (name: string) => name === 'canvas' ? createCanvas(1, 1) : new Image(),
  };
  globals.HTMLImageElement = Image;
  globals.HTMLCanvasElement = Canvas;
  globals.ImageData = ImageData;
  globals.FileReader = NodeFileReader;
}

/** FBXLoader has module-level parser state, so keep imports serialized even when two clients upload together. */
let conversionQueue: Promise<void> = Promise.resolve();

function serialized<T>(work: () => Promise<T>): Promise<T> {
  const result = conversionQueue.then(work, work);
  conversionQueue = result.then(() => undefined, () => undefined);
  return result;
}

async function parseFbx(bytes: Buffer, warnings: string[]): Promise<Group> {
  installNodeImageBridge();
  const boundary: ImageBoundary = { blobs: new Map(), imageBytes: 0, imagePixels: 0, images: 0 };
  const createObjectURL = URL.createObjectURL.bind(URL);
  const revokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = object => {
    const url = createObjectURL(object);
    if (object instanceof Blob) boundary.blobs.set(url, object);
    return url;
  };
  URL.revokeObjectURL = url => {
    boundary.blobs.delete(url);
    revokeObjectURL(url);
  };
  activeImageBoundary = boundary;
  const manager = new LoadingManager();
  let pending = 0;
  let parsed = false;
  let settle: (() => void) | undefined;
  const loaded = new Promise<void>(resolve => { settle = resolve; });
  const itemStart = manager.itemStart.bind(manager);
  const itemEnd = manager.itemEnd.bind(manager);
  const itemError = manager.itemError.bind(manager);
  manager.itemStart = url => { pending++; itemStart(url); };
  manager.itemEnd = url => {
    itemEnd(url);
    pending--;
    if (parsed && pending === 0) settle?.();
  };
  manager.itemError = url => {
    warnings.push(`Texture could not be read: ${url}`);
    itemError(url);
  };

  try {
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const originalWarn = console.warn;
    let group: Group;
    try {
      console.warn = (...args: unknown[]) => {
        const message = args.map(String).join(' ');
        if (/more than 4 skinning weights/i.test(message)) {
          if (!warnings.some(warning => /four skin influences/i.test(warning)))
            warnings.push('Some vertices had more than four skin influences; the weakest weights were pruned');
        }
        originalWarn(...args);
      };
      group = new FBXLoader(manager).parse(data, '');
    } finally {
      console.warn = originalWarn;
    }
    parsed = true;
    if (pending === 0) settle?.();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        loaded,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timed out decoding FBX textures')), 30_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    return group;
  } finally {
    activeImageBoundary = null;
    URL.createObjectURL = createObjectURL;
    URL.revokeObjectURL = revokeObjectURL;
    for (const url of boundary.blobs.keys()) revokeObjectURL(url);
    boundary.blobs.clear();
  }
}

function materialList(material: Material | Material[]): Material[] {
  return Array.isArray(material) ? material : [material];
}

/** An external image cannot be recovered from a one-file upload. Remove only that broken texture slot so the
 * model still imports with its authored material colour, and tell the user to export embedded media instead. */
function removeUnreadableTextures(group: Group, warnings: string[]) {
  const warned = new Set<string>();
  group.traverse(object => {
    if (!(object instanceof SkinnedMesh)) return;
    for (const material of materialList(object.material)) {
      const fields = material as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(fields)) {
        if (!value || typeof value !== 'object' || !(value as { isTexture?: boolean }).isTexture) continue;
        const texture = value as { image?: { width?: number; height?: number } };
        if (texture.image?.width && texture.image?.height) continue;
        fields[key] = null;
        const label = `${material.name || 'material'} ${key}`;
        if (!warned.has(label)) {
          warned.add(label);
          warnings.push(`${label} was omitted because its image was not embedded in the FBX`);
        }
      }
    }
  });
}

function collectSkinnedMeshes(group: Group): SkinnedMesh[] {
  const meshes: SkinnedMesh[] = [];
  group.traverse(object => { if (object instanceof SkinnedMesh) meshes.push(object); });
  return meshes;
}

/** Three's FBXLoader clones and nests a complete skeleton for every separately skinned armor/accessory mesh.
 * Rebind every part by source bone name to the largest mesh's skeleton, then remove those redundant clones. */
function mergeSkeletonCopies(group: Group, meshes: SkinnedMesh[]): Bone[] {
  // The final FBX deformer normally owns the coherent parent/child hierarchy. Earlier clones can misleadingly
  // have more split vertices (Paladin's accessory-named part does), so choose by internal parent links first.
  const skeletonScore = (mesh: SkinnedMesh) => {
    const set = new Set(mesh.skeleton.bones);
    return mesh.skeleton.bones.reduce((score, bone) => score + (set.has(bone.parent as Bone) ? 1 : 0), 0);
  };
  const mainMesh = meshes.reduce((best, mesh) => {
    const score = skeletonScore(mesh), bestScore = skeletonScore(best);
    if (score !== bestScore) return score > bestScore ? mesh : best;
    return (mesh.geometry.getAttribute('position')?.count ?? 0) > (best.geometry.getAttribute('position')?.count ?? 0)
      ? mesh : best;
  });
  const mainBones = mainMesh.skeleton.bones;
  const mainSet = new Set(mainBones);
  const mainByKey = new Map<string, Bone>();
  for (const bone of mainBones) {
    const key = mixamoBoneKey(bone.name).toLowerCase();
    if (mainByKey.has(key)) throw new Error(`Mixamo skeleton has duplicate bone ${bone.name}`);
    mainByKey.set(key, bone);
  }

  for (const mesh of meshes) {
    const mapped = mesh.skeleton.bones.map(bone => mainByKey.get(mixamoBoneKey(bone.name).toLowerCase()));
    const missing = mapped.findIndex(bone => !bone);
    if (missing >= 0) throw new Error(`Mesh ${mesh.name} uses bone ${mesh.skeleton.bones[missing].name} absent from the main skeleton`);
    mesh.skeleton = new Skeleton(mapped as Bone[], mesh.skeleton.boneInverses.map(inverse => inverse.clone()));
  }

  group.updateMatrixWorld(true);
  for (const root of mainBones.filter(bone => !mainSet.has(bone.parent as Bone))) group.attach(root);

  const extras: Bone[] = [];
  group.traverse(object => { if (object instanceof Bone && !mainSet.has(object)) extras.push(object); });
  const extraSet = new Set(extras);
  for (const root of extras.filter(bone => !extraSet.has(bone.parent as Bone))) root.removeFromParent();
  group.updateMatrixWorld(true);
  return mainBones;
}

function positionOf(matrix: Matrix4): Vector3 {
  return new Vector3().setFromMatrixPosition(matrix);
}

function meshBounds(meshes: SkinnedMesh[]): Box3 {
  const bounds = new Box3().makeEmpty();
  for (const mesh of meshes) {
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (mesh.geometry.boundingBox) bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
  }
  return bounds;
}

/** Bake both FBX units and a uniform standing-height fit into local vertices/translations. Keeping a 0.01 on
 * the exported root looks correct before posing, but GLTFLoader puts the inverse root scale in bindMatrixInverse;
 * Slopesmith's world-space bone driver then cancels it and the skin becomes 100x too large. A true metre-scale
 * bind scene (root scale 1, metre vertices, metre joint offsets) has no hidden scale for skinning to cancel. */
function bakeCharacterScale(group: Group, meshes: SkinnedMesh[], warnings: string[]): number {
  group.updateMatrixWorld(true);
  const rawHeight = meshBounds(meshes).getSize(new Vector3()).y;
  if (!Number.isFinite(rawHeight) || rawHeight <= 1e-6) throw new Error('Character has invalid source bounds');

  const unitScaleFactor = Number(group.userData.unitScaleFactor);
  const metresPerUnit = Number.isFinite(unitScaleFactor) && unitScaleFactor > 0 ? unitScaleFactor / 100 : 0.01;
  if (!Number.isFinite(unitScaleFactor)) warnings.push('FBX unit metadata was missing; Mixamo centimetres were assumed');
  const sourceHeightMetres = rawHeight * metresPerUnit;
  const scale = IMPORTED_CHARACTER_HEIGHT_METRES / rawHeight;

  const geometries = new Set(meshes.map(mesh => mesh.geometry));
  const scaleMatrix = new Matrix4().makeScale(scale, scale, scale);
  for (const geometry of geometries) {
    geometry.getAttribute('position')?.applyMatrix4(scaleMatrix);
    for (const attribute of geometry.morphAttributes.position ?? []) attribute.applyMatrix4(scaleMatrix);
    geometry.boundingBox = null;
    geometry.boundingSphere = null;
  }
  group.traverse(object => {
    object.position.multiplyScalar(scale);
    object.updateMatrix();
  });
  group.updateMatrixWorld(true);
  return sourceHeightMetres;
}

function basisAt(head: Vector3, tail: Vector3, rollToward: Vector3, scale: Vector3): Matrix4 {
  const axisY = tail.clone().sub(head);
  if (axisY.lengthSq() < 1e-10) throw new Error('Mixamo skeleton contains a zero-length driven bone');
  axisY.normalize();
  const axisZ = rollToward.clone().addScaledVector(axisY, -rollToward.dot(axisY));
  if (axisZ.lengthSq() < 1e-10) axisZ.set(0, 0, 1).addScaledVector(axisY, -axisY.z);
  if (axisZ.lengthSq() < 1e-10) axisZ.set(1, 0, 0).addScaledVector(axisY, -axisY.x);
  axisZ.normalize();
  const axisX = new Vector3().crossVectors(axisY, axisZ).normalize();
  axisZ.crossVectors(axisX, axisY).normalize();
  const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(axisX, axisY, axisZ));
  return new Matrix4().compose(head, rotation, scale);
}

/** Normalize only the bones Slopesmith drives. Every finger/accessory keeps its original bind-world matrix;
 * its local transform is recomputed beneath the normalized parent, so it follows poses without rest-pose drift. */
function normalizeDrivenBones(group: Group, bones: Bone[], warnings: string[]): Map<CanonicalCharacterBone, Bone> {
  const byMixamo = new Map<string, Bone>();
  for (const bone of bones) byMixamo.set(mixamoBoneKey(bone.name).toLowerCase(), bone);

  const canonical = new Map<CanonicalCharacterBone, Bone>();
  for (const [mixamo, name] of Object.entries(MIXAMO_TO_SLOPESMITH) as [MixamoBone, CanonicalCharacterBone][]) {
    const bone = byMixamo.get(mixamo.toLowerCase());
    if (bone) canonical.set(name, bone);
  }
  const missing = REQUIRED_CHARACTER_BONES.filter(name => !canonical.has(name));
  if (missing.length) throw new Error(`This is not a supported Mixamo humanoid; missing ${missing.join(', ')}`);

  const originalWorld = new Map<Bone, Matrix4>();
  for (const bone of bones) originalWorld.set(bone, bone.matrixWorld.clone());
  const desiredWorld = new Map(originalWorld);
  const at = (bone: Bone) => positionOf(originalWorld.get(bone)!);
  const sourceAt = (name: string) => {
    const bone = byMixamo.get(name.toLowerCase());
    return bone ? at(bone) : null;
  };

  const up = new Vector3(0, 1, 0);
  const forward = new Vector3();
  for (const side of ['Left', 'Right']) {
    const foot = sourceAt(`${side}Foot`), toe = sourceAt(`${side}ToeBase`);
    if (foot && toe) forward.add(toe.clone().sub(foot).setY(0));
  }
  if (forward.lengthSq() < 1e-8) {
    forward.set(0, 0, 1);
    warnings.push('Could not infer the character facing direction from its toes; +Z was assumed');
  } else forward.normalize();

  for (const [name, bone] of canonical) {
    if (name === 'ChestUpper') continue; // follows Chest and bridges into the separately driven neck/clavicles
    const head = at(bone);
    let tail = sourceAt(TAIL_JOINT[name]);
    // Some animation-only Mixamo downloads omit the head leaf. Extend the neck-to-head direction rather than
    // rejecting an otherwise standard 65-bone humanoid; the endpoint is still useful for normalizing its axis.
    if (!tail && name === 'Head') {
      const neck = sourceAt('Neck');
      if (neck) {
        tail = head.clone().add(head.clone().sub(neck));
        warnings.push('HeadTop_End was absent; head length was inferred from the neck segment');
      }
    }
    if (!tail) throw new Error(`Mixamo skeleton is missing ${TAIL_JOINT[name]}, needed to size ${name}`);
    const sourceLength = head.distanceTo(tail);
    if (sourceLength < 1e-5) throw new Error(`Mixamo bone ${name} has zero authored length`);
    const originalScale = new Vector3();
    originalWorld.get(bone)!.decompose(new Vector3(), new Quaternion(), originalScale);
    originalScale.set(Math.abs(originalScale.x), Math.abs(originalScale.y), Math.abs(originalScale.z));
    let roll = forward;
    if (name === 'Hand.L' || name === 'Hand.R') roll = up;
    else if (name === 'Foot.L') roll = new Vector3().crossVectors(up, tail.clone().sub(head)).normalize();
    else if (name === 'Foot.R') roll = new Vector3().crossVectors(tail.clone().sub(head), up).normalize();
    desiredWorld.set(bone, basisAt(head, tail, roll, originalScale));
    bone.userData.slopesmith_length_m = sourceLength;
  }

  const groupWorld = group.matrixWorld.clone();
  for (const bone of bones) {
    const parentWorld = bone.parent instanceof Bone ? desiredWorld.get(bone.parent)! : groupWorld;
    const local = parentWorld.clone().invert().multiply(desiredWorld.get(bone)!);
    local.decompose(bone.position, bone.quaternion, bone.scale);
    bone.updateMatrix();
  }
  for (const [mixamo, name] of Object.entries(MIXAMO_TO_SLOPESMITH) as [MixamoBone, CanonicalCharacterBone][]) {
    const bone = byMixamo.get(mixamo.toLowerCase());
    if (bone) bone.name = name;
  }
  group.updateMatrixWorld(true);
  return canonical;
}

function countTextures(group: Group): number {
  const textures = new Set<unknown>();
  group.traverse(object => {
    if (!(object instanceof SkinnedMesh)) return;
    for (const material of materialList(object.material)) {
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value && typeof value === 'object' && (value as { isTexture?: boolean }).isTexture) textures.add(value);
      }
    }
  });
  return textures.size;
}

function validatePreparedGroup(group: Group, meshes: SkinnedMesh[], bones: Bone[]) {
  if (meshes.length > MAX_CHARACTER_MESHES) throw new Error(`FBX has more than ${MAX_CHARACTER_MESHES} skinned meshes`);
  if (bones.length > MAX_CHARACTER_BONES) throw new Error(`FBX has more than ${MAX_CHARACTER_BONES} bones`);
  let vertices = 0, triangles = 0, unweightedVertices = 0;
  for (const mesh of meshes) {
    const position = mesh.geometry.getAttribute('position');
    const weights = mesh.geometry.getAttribute('skinWeight');
    if (!position || !weights || weights.itemSize !== 4) throw new Error(`Mesh ${mesh.name} has no four-slot skin weights`);
    vertices += position.count;
    triangles += mesh.geometry.index ? mesh.geometry.index.count / 3 : position.count / 3;
    if (vertices > MAX_CHARACTER_VERTICES || triangles > MAX_CHARACTER_TRIANGLES)
      throw new Error('FBX geometry exceeds the character import budget');
    for (let vertex = 0; vertex < weights.count; vertex++) {
      let total = 0;
      for (let item = 0; item < 4; item++) total += weights.getComponent(vertex, item);
      if (total < 1e-6) unweightedVertices++;
    }
  }
  if (unweightedVertices) throw new Error(`${unweightedVertices} visible vertices have no skin weights`);
  const bounds = meshBounds(meshes);
  const heightMetres = bounds.max.y - bounds.min.y;
  if (!Number.isFinite(heightMetres) || heightMetres <= 0) throw new Error('Character has invalid bounds');
  return { vertices, triangles: Math.round(triangles), unweightedVertices, heightMetres, bones: bones.length };
}

function glbJson(glb: Buffer): { nodes?: { name?: string }[]; meshes?: unknown[]; skins?: unknown[] } {
  if (glb.length < 20 || glb.toString('ascii', 0, 4) !== 'glTF' || glb.readUInt32LE(4) !== 2)
    throw new Error('Character conversion did not produce a glTF 2.0 binary');
  const jsonLength = glb.readUInt32LE(12);
  if (20 + jsonLength > glb.length) throw new Error('Character GLB has a truncated JSON chunk');
  return JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8').trim());
}

async function convertMixamoFbxInner(bytes: Buffer, sourceName: string): Promise<ConvertedMixamoCharacter> {
  if (!bytes.length) throw new Error('FBX upload is empty');
  if (bytes.length > MAX_CHARACTER_FBX_BYTES) throw new Error('FBX is larger than the 96 MB import limit');
  const warnings: string[] = [];
  const group = await parseFbx(bytes, warnings);
  const meshes = collectSkinnedMeshes(group);
  if (!meshes.length) throw new Error('FBX contains no skinned meshes');
  if (meshes.length > MAX_CHARACTER_MESHES) throw new Error(`FBX has more than ${MAX_CHARACTER_MESHES} skinned meshes`);
  removeUnreadableTextures(group, warnings);
  if (countTextures(group) > MAX_CHARACTER_IMAGES) throw new Error(`FBX has more than ${MAX_CHARACTER_IMAGES} textures`);
  const bones = mergeSkeletonCopies(group, meshes);
  const sourceHeightMetres = bakeCharacterScale(group, meshes, warnings);
  normalizeDrivenBones(group, bones, warnings);
  for (const mesh of meshes) mesh.skeleton.calculateInverses();
  group.animations = [];
  group.name = `${characterStem(sourceName)}-mixamo`;
  group.userData = {
    rig_profile: 'slopesmith-character-mixamo-v1',
    source_asset: sourceName,
    slopesmith_stance: 'regular (anatomical L = front)',
  };
  group.updateMatrixWorld(true);

  const counts = validatePreparedGroup(group, meshes, bones);
  if (counts.heightMetres < 0.5 || counts.heightMetres > 4)
    warnings.push(`Character is ${counts.heightMetres.toFixed(2)} m tall; check the FBX export units`);

  const exported = await new GLTFExporter().parseAsync(group, { binary: true, animations: [], onlyVisible: true });
  if (!(exported instanceof ArrayBuffer)) throw new Error('Character exporter returned JSON instead of a binary GLB');
  const glb = Buffer.from(exported);
  if (glb.length > MAX_CHARACTER_GLB_BYTES) throw new Error('converted GLB exceeds the 128 MB character limit');
  const json = glbJson(glb);
  const names = new Set((json.nodes ?? []).map(node => node.name));
  const missing = REQUIRED_CHARACTER_BONES.filter(name => !names.has(name));
  if (missing.length || !(json.meshes?.length) || !(json.skins?.length))
    throw new Error(`Converted GLB failed validation${missing.length ? `; missing ${missing.join(', ')}` : ''}`);

  const file = `${characterStem(sourceName)}.glb`;
  return {
    glb,
    report: {
      source: sourceName,
      file,
      meshes: meshes.length,
      bones: counts.bones,
      vertices: counts.vertices,
      triangles: counts.triangles,
      textures: countTextures(group),
      unweightedVertices: counts.unweightedVertices,
      sourceHeightMetres: Math.round(sourceHeightMetres * 1000) / 1000,
      heightMetres: Math.round(counts.heightMetres * 1000) / 1000,
      outputBytes: glb.length,
      warnings,
    },
  };
}

export function convertMixamoFbx(bytes: Buffer, sourceName: string): Promise<ConvertedMixamoCharacter> {
  return serialized(() => convertMixamoFbxInner(bytes, sourceName));
}

/** Convert completely before touching the catalogue. A rejected FBX therefore leaves no partial character.
 *  An import whose name is taken lands beside the original as `name_2.glb` (docs/038); the report names the
 *  file it landed in, which is what the Rider model picker selects. */
export async function saveMixamoCharacter(sourceName: string, bytes: Buffer): Promise<MixamoCharacterReport> {
  const converted = await convertMixamoFbx(bytes, sourceName);
  const charactersDir = await characterLibraryDir();
  const { name: stem } = await storeUnderFreeName({
    library: charactersDir,
    name: converted.report.file.replace(/\.glb$/i, ''),
    fallback: 'character',
    taken: candidate => pathExists(join(charactersDir, `${candidate}.glb`)),
    write: async stored => {
      await ensureDir(charactersDir);
      await writeFile(join(charactersDir, `${stored}.glb`), converted.glb);
    },
  });
  return { ...converted.report, file: `${stem}.glb` };
}
