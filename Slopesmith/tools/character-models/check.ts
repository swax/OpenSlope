#!/usr/bin/env -S npx tsx
/** Validate a binary glTF against the character contract used by Slopesmith's runtime driver. */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Matrix4, Quaternion, Vector3 } from 'three';
import {
  REQUIRED_CHARACTER_BONES, normalizedCharacterBoneName,
} from '../../src/core/characters/contract';

interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

interface GltfPrimitive {
  attributes?: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
}

interface GltfDocument {
  asset?: { version?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { name?: string; primitives?: GltfPrimitive[] }[];
  skins?: { joints?: number[]; skeleton?: number; inverseBindMatrices?: number }[];
  materials?: { name?: string }[];
  images?: { name?: string; uri?: string; bufferView?: number; mimeType?: string }[];
  animations?: { name?: string }[];
  accessors?: {
    bufferView?: number;
    byteOffset?: number;
    componentType?: number;
    count?: number;
    type?: string;
    normalized?: boolean;
    sparse?: unknown;
  }[];
  bufferViews?: { buffer?: number; byteOffset?: number; byteLength?: number; byteStride?: number }[];
  buffers?: { uri?: string; byteLength?: number }[];
  cameras?: unknown[];
}

export interface CharacterCheckReport {
  source: string;
  valid: boolean;
  errors: string[];
  warnings: string[];
  bytes: number;
  nodes: number;
  bones: number;
  meshNodes: number;
  skinnedMeshes: number;
  vertices: number;
  triangles: number;
  materials: number;
  images: number;
  embeddedImages: number;
  externalImages: string[];
  animations: number;
  unweightedVertices: number;
  maxInfluencesPerVertex: number;
  maxWeightSumError: number;
  boundsMin: [number, number, number] | null;
  boundsMax: [number, number, number] | null;
  heightMetres: number | null;
}

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const COMPONENTS: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};
const COMPONENT_BYTES: Record<number, number> = {
  5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4,
};

function splitGlb(bytes: Uint8Array): { json: GltfDocument; bin: Uint8Array } {
  if (bytes.byteLength < 20) throw new Error('file is too short to be a GLB');
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (header.getUint32(0, true) !== GLB_MAGIC) throw new Error('file is not binary glTF (GLB)');
  if (header.getUint32(4, true) !== 2) throw new Error(`unsupported glTF version ${header.getUint32(4, true)}`);
  const declaredLength = header.getUint32(8, true);
  if (declaredLength !== bytes.byteLength) {
    throw new Error(`GLB header declares ${declaredLength} bytes, file has ${bytes.byteLength}`);
  }

  let json: GltfDocument | null = null;
  let bin = new Uint8Array();
  for (let offset = 12; offset < bytes.byteLength;) {
    if (offset + 8 > bytes.byteLength) throw new Error('truncated GLB chunk header');
    const length = header.getUint32(offset, true);
    const type = header.getUint32(offset + 4, true);
    const start = offset + 8, end = start + length;
    if (end > bytes.byteLength) throw new Error('truncated GLB chunk body');
    if (type === JSON_CHUNK) {
      if (json) throw new Error('GLB contains more than one JSON chunk');
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(start, end)).trim()) as GltfDocument;
    } else if (type === BIN_CHUNK) {
      if (bin.byteLength) throw new Error('GLB contains more than one binary chunk');
      bin = new Uint8Array(bytes.subarray(start, end));
    }
    offset = end;
  }
  if (!json) throw new Error('GLB has no JSON chunk');
  if (json.asset?.version !== '2.0') throw new Error(`JSON asset version is ${json.asset?.version ?? 'missing'}, not 2.0`);
  if ((json.buffers?.length ?? 0) > 1 || json.buffers?.[0]?.uri) {
    throw new Error('character GLB must carry its geometry in the single embedded binary buffer');
  }
  return { json, bin };
}

interface AccessorData {
  values: Float64Array;
  components: number;
  count: number;
}

function readAccessor(json: GltfDocument, bin: Uint8Array, index: number): AccessorData {
  const accessor = json.accessors?.[index];
  if (!accessor) throw new Error(`accessor ${index} is missing`);
  if (accessor.sparse) throw new Error(`accessor ${index} is sparse; re-export the character without sparse data`);
  const components = COMPONENTS[accessor.type ?? ''] ?? 0;
  const componentBytes = COMPONENT_BYTES[accessor.componentType ?? 0] ?? 0;
  if (!components || !componentBytes) {
    throw new Error(`accessor ${index} has unsupported ${accessor.type}/${accessor.componentType}`);
  }
  const count = accessor.count ?? 0;
  const values = new Float64Array(count * components);
  if (accessor.bufferView === undefined) return { values, components, count };
  const bufferView = json.bufferViews?.[accessor.bufferView];
  if (!bufferView) throw new Error(`accessor ${index} names missing bufferView ${accessor.bufferView}`);
  if ((bufferView.buffer ?? 0) !== 0) throw new Error(`bufferView ${accessor.bufferView} is not in the GLB buffer`);
  const stride = bufferView.byteStride ?? components * componentBytes;
  if (stride < components * componentBytes) throw new Error(`accessor ${index} has an invalid byte stride`);
  const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const last = start + Math.max(0, count - 1) * stride + components * componentBytes;
  if (last > bin.byteLength) throw new Error(`accessor ${index} runs past the GLB binary chunk`);
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  const normalized = accessor.normalized === true;
  const read = (at: number): number => {
    switch (accessor.componentType) {
      case 5126: return view.getFloat32(at, true);
      case 5125: return view.getUint32(at, true);
      case 5123: return normalized ? view.getUint16(at, true) / 65535 : view.getUint16(at, true);
      case 5122: return normalized ? Math.max(-1, view.getInt16(at, true) / 32767) : view.getInt16(at, true);
      case 5121: return normalized ? view.getUint8(at) / 255 : view.getUint8(at);
      case 5120: return normalized ? Math.max(-1, view.getInt8(at) / 127) : view.getInt8(at);
      default: throw new Error(`unsupported accessor component type ${accessor.componentType}`);
    }
  };
  for (let row = 0; row < count; row++) {
    for (let component = 0; component < components; component++) {
      values[row * components + component] = read(start + row * stride + component * componentBytes);
    }
  }
  return { values, components, count };
}

function localMatrix(node: GltfNode): Matrix4 {
  if (node.matrix) {
    if (node.matrix.length !== 16) throw new Error('node matrix does not have 16 components');
    return new Matrix4().fromArray(node.matrix);
  }
  const t = node.translation ?? [0, 0, 0];
  const r = node.rotation ?? [0, 0, 0, 1];
  const s = node.scale ?? [1, 1, 1];
  if (t.length !== 3 || r.length !== 4 || s.length !== 3) throw new Error('node has malformed TRS data');
  return new Matrix4().compose(
    new Vector3(t[0], t[1], t[2]),
    new Quaternion(r[0], r[1], r[2], r[3]),
    new Vector3(s[0], s[1], s[2]),
  );
}

function rounded(v: Vector3): [number, number, number] {
  return [v.x, v.y, v.z].map(value => Number(value.toFixed(6))) as [number, number, number];
}

/** Inspect a self-contained GLB without invoking Blender or a browser image decoder. */
export function checkCharacterGlb(bytes: Uint8Array, source = '<memory>'): CharacterCheckReport {
  const errors: string[] = [], warnings: string[] = [];
  const report: CharacterCheckReport = {
    source, valid: false, errors, warnings, bytes: bytes.byteLength,
    nodes: 0, bones: 0, meshNodes: 0, skinnedMeshes: 0, vertices: 0, triangles: 0,
    materials: 0, images: 0, embeddedImages: 0, externalImages: [], animations: 0,
    unweightedVertices: 0, maxInfluencesPerVertex: 0, maxWeightSumError: 0,
    boundsMin: null, boundsMax: null, heightMetres: null,
  };

  try {
    const { json, bin } = splitGlb(bytes);
    const nodes = json.nodes ?? [];
    const meshes = json.meshes ?? [];
    const scene = json.scenes?.[json.scene ?? 0];
    if (!scene) throw new Error(`default scene ${json.scene ?? 0} is missing`);
    const parents = new Int32Array(nodes.length).fill(-1);
    for (let parent = 0; parent < nodes.length; parent++) {
      for (const child of nodes[parent].children ?? []) {
        if (!nodes[child]) throw new Error(`node ${parent} names missing child ${child}`);
        if (parents[child] !== -1) throw new Error(`node ${child} has more than one parent`);
        parents[child] = parent;
      }
    }

    const reachable = new Set<number>();
    const visiting = new Set<number>();
    const visit = (index: number) => {
      if (!nodes[index]) throw new Error(`scene names missing root node ${index}`);
      if (visiting.has(index)) throw new Error(`node hierarchy contains a cycle at ${index}`);
      if (reachable.has(index)) return;
      visiting.add(index);
      reachable.add(index);
      for (const child of nodes[index].children ?? []) visit(child);
      visiting.delete(index);
    };
    for (const root of scene.nodes ?? []) visit(root);
    if (!reachable.size) errors.push('default scene contains no nodes');
    report.nodes = reachable.size;

    const worlds = new Map<number, Matrix4>();
    const worldOf = (index: number): Matrix4 => {
      const cached = worlds.get(index);
      if (cached) return cached;
      const local = localMatrix(nodes[index]);
      const parent = parents[index];
      const world = parent >= 0 ? worldOf(parent).clone().multiply(local) : local;
      worlds.set(index, world);
      return world;
    };
    for (const index of reachable) worldOf(index);

    const named = new Map<string, number[]>();
    for (const index of reachable) {
      const name = nodes[index].name;
      if (!name) continue;
      const key = normalizedCharacterBoneName(name);
      const found = named.get(key) ?? [];
      found.push(index);
      named.set(key, found);
    }
    const canonical = new Map<string, number>();
    for (const name of REQUIRED_CHARACTER_BONES) {
      const matches = named.get(normalizedCharacterBoneName(name)) ?? [];
      if (!matches.length) errors.push(`missing required bone ${name}`);
      else {
        canonical.set(name, matches[0]);
        if (matches.length > 1) errors.push(`required bone ${name} appears ${matches.length} times`);
      }
    }
    report.bones = new Set((json.skins ?? []).flatMap(skin => skin.joints ?? []).filter(index => reachable.has(index))).size;

    const mustDescend: [string, string][] = [
      ['Chest', 'Hips'], ['Head', 'Chest'],
      ['UpperArm.L', 'Chest'], ['LowerArm.L', 'UpperArm.L'], ['Hand.L', 'LowerArm.L'],
      ['UpperArm.R', 'Chest'], ['LowerArm.R', 'UpperArm.R'], ['Hand.R', 'LowerArm.R'],
      ['UpperLeg.L', 'Hips'], ['LowerLeg.L', 'UpperLeg.L'], ['Foot.L', 'LowerLeg.L'],
      ['UpperLeg.R', 'Hips'], ['LowerLeg.R', 'UpperLeg.R'], ['Foot.R', 'LowerLeg.R'],
    ];
    const isDescendant = (child: number, ancestor: number) => {
      for (let at = parents[child]; at >= 0; at = parents[at]) if (at === ancestor) return true;
      return false;
    };
    for (const [childName, ancestorName] of mustDescend) {
      const child = canonical.get(childName), ancestor = canonical.get(ancestorName);
      if (child !== undefined && ancestor !== undefined && !isDescendant(child, ancestor)) {
        errors.push(`${childName} is not a descendant of ${ancestorName}`);
      }
    }

    const meshNodes = [...reachable].filter(index => nodes[index].mesh !== undefined);
    const skinnedNodes = meshNodes.filter(index => nodes[index].skin !== undefined);
    report.meshNodes = meshNodes.length;
    report.skinnedMeshes = skinnedNodes.length;
    if (!skinnedNodes.length) errors.push('default scene contains no skinned mesh');

    const skinJoints = new Set<number>();
    for (const index of skinnedNodes) {
      const skinIndex = nodes[index].skin!;
      const skin = json.skins?.[skinIndex];
      if (!skin) errors.push(`mesh node ${nodes[index].name ?? index} names missing skin ${skinIndex}`);
      else for (const joint of skin.joints ?? []) skinJoints.add(joint);
    }
    for (const [name, index] of canonical) {
      if (!skinJoints.has(index)) errors.push(`required bone ${name} is not used by a character skin`);
    }

    const skinTransforms = new Map<number, Matrix4[]>();
    const transformsForSkin = (skinIndex: number) => {
      const cached = skinTransforms.get(skinIndex);
      if (cached) return cached;
      const skin = json.skins?.[skinIndex];
      if (!skin) return [];
      const joints = skin.joints ?? [];
      const inverseBinds = skin.inverseBindMatrices === undefined
        ? null : readAccessor(json, bin, skin.inverseBindMatrices);
      if (inverseBinds && (inverseBinds.components !== 16 || inverseBinds.count !== joints.length)) {
        throw new Error(`skin ${skinIndex} inverse-bind accessor does not match its ${joints.length} joints`);
      }
      const transforms = joints.map((joint, slot) => {
        if (!nodes[joint]) throw new Error(`skin ${skinIndex} names missing joint node ${joint}`);
        const inverse = inverseBinds
          ? new Matrix4().fromArray(Array.from(inverseBinds.values.subarray(slot * 16, slot * 16 + 16)))
          : new Matrix4();
        return worldOf(joint).clone().multiply(inverse);
      });
      skinTransforms.set(skinIndex, transforms);
      return transforms;
    };

    const minimum = new Vector3(Infinity, Infinity, Infinity);
    const maximum = new Vector3(-Infinity, -Infinity, -Infinity);
    const point = new Vector3(), sourcePoint = new Vector3(), influenced = new Vector3();
    const measuredMeshNodes = new Set<number>();
    for (const nodeIndex of meshNodes) {
      const node = nodes[nodeIndex];
      const mesh = meshes[node.mesh!];
      if (!mesh) {
        errors.push(`node ${node.name ?? nodeIndex} names missing mesh ${node.mesh}`);
        continue;
      }
      measuredMeshNodes.add(nodeIndex);
      const skinned = node.skin !== undefined;
      for (const primitive of mesh.primitives ?? []) {
        const positionIndex = primitive.attributes?.POSITION;
        if (positionIndex === undefined) {
          errors.push(`mesh ${mesh.name ?? node.mesh} has a primitive without POSITION`);
          continue;
        }
        const positions = readAccessor(json, bin, positionIndex);
        if (positions.components !== 3) throw new Error(`POSITION accessor ${positionIndex} is not VEC3`);
        report.vertices += positions.count;
        const corners = primitive.indices === undefined ? positions.count : readAccessor(json, bin, primitive.indices).count;
        if ((primitive.mode ?? 4) === 4) report.triangles += Math.floor(corners / 3);
        else warnings.push(`mesh ${mesh.name ?? node.mesh} uses non-triangle primitive mode ${primitive.mode}`);

        if (!skinned) {
          for (let vertex = 0; vertex < positions.count; vertex++) {
            point.set(
              positions.values[vertex * 3], positions.values[vertex * 3 + 1], positions.values[vertex * 3 + 2],
            ).applyMatrix4(worldOf(nodeIndex));
            minimum.min(point); maximum.max(point);
          }
          continue;
        }
        const skinSets: { joints: AccessorData; weights: AccessorData }[] = [];
        for (let set = 0; ; set++) {
          const jointIndex = primitive.attributes?.[`JOINTS_${set}`];
          const weightIndex = primitive.attributes?.[`WEIGHTS_${set}`];
          if (jointIndex === undefined && weightIndex === undefined) break;
          if (jointIndex === undefined || weightIndex === undefined) {
            errors.push(`mesh ${mesh.name ?? node.mesh} has an incomplete JOINTS_${set}/WEIGHTS_${set} pair`);
            break;
          }
          const joints = readAccessor(json, bin, jointIndex);
          const weights = readAccessor(json, bin, weightIndex);
          if (joints.count !== positions.count || weights.count !== positions.count
              || joints.components !== weights.components) {
            errors.push(`mesh ${mesh.name ?? node.mesh} has mismatched skin accessors`);
            break;
          }
          skinSets.push({ joints, weights });
        }
        if (!skinSets.length) {
          errors.push(`skinned mesh ${mesh.name ?? node.mesh} has no joint weights`);
          report.unweightedVertices += positions.count;
          continue;
        }
        const transforms = transformsForSkin(node.skin!);
        for (let vertex = 0; vertex < positions.count; vertex++) {
          let influences = 0, sum = 0;
          point.set(0, 0, 0);
          sourcePoint.set(
            positions.values[vertex * 3], positions.values[vertex * 3 + 1], positions.values[vertex * 3 + 2],
          );
          for (const { joints, weights } of skinSets) {
            for (let component = 0; component < weights.components; component++) {
              const weight = weights.values[vertex * weights.components + component];
              if (weight > 1e-7) {
                influences++;
                const joint = Math.round(joints.values[vertex * joints.components + component]);
                const transform = transforms[joint];
                if (!transform) throw new Error(`skin ${node.skin} weight names missing joint slot ${joint}`);
                point.add(influenced.copy(sourcePoint).applyMatrix4(transform).multiplyScalar(weight));
              }
              sum += weight;
            }
          }
          if (!influences) {
            report.unweightedVertices++;
            point.copy(sourcePoint).applyMatrix4(worldOf(nodeIndex));
          } else {
            report.maxWeightSumError = Math.max(report.maxWeightSumError, Math.abs(sum - 1));
          }
          report.maxInfluencesPerVertex = Math.max(report.maxInfluencesPerVertex, influences);
          minimum.min(point); maximum.max(point);
        }
      }
    }
    if (report.unweightedVertices) errors.push(`${report.unweightedVertices} skinned vertices have no weight`);
    if (report.maxInfluencesPerVertex > 4) {
      errors.push(`vertices use up to ${report.maxInfluencesPerVertex} influences; the contract allows four`);
    }
    if (report.maxWeightSumError > 0.01) {
      warnings.push(`largest vertex-weight sum error is ${report.maxWeightSumError.toFixed(4)}`);
    }
    if (measuredMeshNodes.size && Number.isFinite(minimum.x)) {
      report.boundsMin = rounded(minimum);
      report.boundsMax = rounded(maximum);
      report.heightMetres = Number((maximum.y - minimum.y).toFixed(6));
      if (report.heightMetres < 1 || report.heightMetres > 2.5) {
        warnings.push(`standing bounds are ${report.heightMetres.toFixed(3)} m high; check units and scale`);
      }
    }

    report.materials = json.materials?.length ?? 0;
    report.images = json.images?.length ?? 0;
    report.externalImages = (json.images ?? [])
      .filter(image => image.uri && !image.uri.startsWith('data:'))
      .map(image => image.uri!);
    report.embeddedImages = report.images - report.externalImages.length;
    if (report.externalImages.length) {
      errors.push(`external images are not character-library assets: ${report.externalImages.join(', ')}`);
    }
    report.animations = json.animations?.length ?? 0;
    if (report.animations) warnings.push(`${report.animations} animation clip(s) will not be used by Slopesmith`);
    if (json.cameras?.length) warnings.push(`${json.cameras.length} camera(s) are unnecessary in a character GLB`);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  report.maxWeightSumError = Number(report.maxWeightSumError.toFixed(6));
  report.valid = errors.length === 0;
  return report;
}

function printReport(report: CharacterCheckReport) {
  console.log(`${report.valid ? 'PASS' : 'FAIL'} ${report.source}`);
  console.log(`  ${report.skinnedMeshes} skinned mesh(es), ${report.vertices.toLocaleString()} vertices, `
    + `${report.triangles.toLocaleString()} triangles, ${report.bones} skin bones`);
  console.log(`  influences ${report.maxInfluencesPerVertex} max, ${report.unweightedVertices} unweighted; `
    + `${report.embeddedImages} embedded image(s); height ${report.heightMetres?.toFixed(3) ?? '?'} m`);
  for (const warning of report.warnings) console.log(`  warning: ${warning}`);
  for (const error of report.errors) console.log(`  error: ${error}`);
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const paths = args.filter(arg => arg !== '--json');
  if (!paths.length) {
    throw new Error('usage: npx tsx tools/character-models/check.ts [--json] MODEL.glb [...]');
  }
  const reports: CharacterCheckReport[] = [];
  for (const value of paths) {
    const path = resolve(value);
    try {
      reports.push(checkCharacterGlb(await readFile(path), path));
    } catch (error) {
      reports.push({
        source: path, valid: false, errors: [error instanceof Error ? error.message : String(error)], warnings: [],
        bytes: 0, nodes: 0, bones: 0, meshNodes: 0, skinnedMeshes: 0, vertices: 0, triangles: 0,
        materials: 0, images: 0, embeddedImages: 0, externalImages: [], animations: 0,
        unweightedVertices: 0, maxInfluencesPerVertex: 0, maxWeightSumError: 0,
        boundsMin: null, boundsMax: null, heightMetres: null,
      });
    }
  }
  if (json) console.log(JSON.stringify(reports, null, 2));
  else reports.forEach(printReport);
  if (reports.some(report => !report.valid)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
}
