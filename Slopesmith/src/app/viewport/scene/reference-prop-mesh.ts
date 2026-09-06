import * as THREE from 'three';
import { acceleratedRaycast, MeshBVH, type SerializedBVH } from 'three-mesh-bvh';
import type { PropInstance } from '../../../core/reference/props';
import type { RefPropSurfaceDetails } from '../types';

interface MergedInstanceRange {
  geometry: THREE.BufferGeometry;
  vertexStart: number;
  vertexCount: number;
  indexStart: number;
  indexCount: number;
  matrix: THREE.Matrix4;
}

type BvhGeometry = THREE.BufferGeometry & { boundsTree?: MeshBVH };

/**
 * One physical static mesh used when the browser cannot submit `WEBGL_multi_draw`.
 *
 * Three's BatchedMesh fallback issues one WebGL call per visible heterogeneous slot, which is exactly the CPU
 * bottleneck batching is meant to remove. This mesh instead expands immutable opaque slots into one index buffer
 * per material. It deliberately retains the BatchedMesh-shaped get/setMatrixAt and setColorAt surface so source
 * ids, selection outlines, rig tint, and an unexpected Play mutation still address one original slot.
 */
export class MergedStaticPropMesh extends THREE.Mesh<THREE.BufferGeometry, THREE.Material> {
  readonly isMergedStaticPropMesh = true;
  instanceCount = 0;

  private readonly sources: THREE.BufferGeometry[] = [];
  private readonly ranges: MergedInstanceRange[] = [];
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly normalAttr: THREE.BufferAttribute;
  private readonly storedNormalAttr: THREE.BufferAttribute;
  private readonly uvAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly sliceAttr: THREE.BufferAttribute;
  private readonly indexAttr: THREE.BufferAttribute;
  private vertexCursor = 0;
  private indexCursor = 0;
  private boundsTree: MeshBVH | null = null;

  constructor(maxVertexCount: number, maxIndexCount: number, material: THREE.Material) {
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(new Float32Array(maxVertexCount * 3), 3);
    const normal = new THREE.BufferAttribute(new Float32Array(maxVertexCount * 3), 3);
    const storedNormal = new THREE.BufferAttribute(new Float32Array(maxVertexCount * 3), 3);
    const uv = new THREE.BufferAttribute(new Float32Array(maxVertexCount * 2), 2);
    const color = new THREE.BufferAttribute(new Float32Array(maxVertexCount * 3).fill(1), 3);
    // Which layer of the packed page bank each vertex samples (mesh/texture-array.ts). Carried here for the
    // same reason uv is: a merged batch spans several submeshes, and after the merge nothing else remembers
    // which page any given triangle came from. Zero-filled, so a batch on an ordinary per-page material
    // simply never reads it.
    const slice = new THREE.BufferAttribute(new Uint16Array(maxVertexCount), 1);
    const indices = new THREE.BufferAttribute(new Uint32Array(maxIndexCount), 1);
    geometry.setAttribute('position', position);
    geometry.setAttribute('normal', normal);
    geometry.setAttribute('ps2StoredNormal', storedNormal);
    geometry.setAttribute('uv', uv);
    geometry.setAttribute('color', color);
    geometry.setAttribute('texArraySlice', slice);
    geometry.setIndex(indices);
    geometry.setDrawRange(0, 0);
    super(geometry, material);
    this.positionAttr = position;
    this.normalAttr = normal;
    this.storedNormalAttr = storedNormal;
    this.uvAttr = uv;
    this.colorAttr = color;
    this.sliceAttr = slice;
    this.indexAttr = indices;
  }

  addGeometry(geometry: THREE.BufferGeometry): number {
    this.sources.push(geometry);
    return this.sources.length - 1;
  }

  addInstance(geometryId: number): number {
    const geometry = this.sources[geometryId];
    if (!geometry) throw new Error(`MergedStaticPropMesh: unknown geometry ${geometryId}`);
    const sourcePosition = geometry.getAttribute('position');
    const sourceStoredNormal = geometry.getAttribute('ps2StoredNormal') ?? geometry.getAttribute('normal');
    const sourceUv = geometry.getAttribute('uv');
    const sourceSlice = geometry.getAttribute('texArraySlice');
    const sourceIndex = geometry.getIndex();
    if (!sourcePosition || !sourceIndex) throw new Error('MergedStaticPropMesh: indexed positions required');
    const vertexStart = this.vertexCursor;
    const indexStart = this.indexCursor;
    for (let i = 0; i < sourcePosition.count; i++) {
      if (sourceUv) this.uvAttr.setXY(vertexStart + i, sourceUv.getX(i), sourceUv.getY(i));
      if (sourceSlice) this.sliceAttr.setX(vertexStart + i, sourceSlice.getX(i));
      if (sourceStoredNormal) this.storedNormalAttr.setXYZ(vertexStart + i,
        sourceStoredNormal.getX(i), sourceStoredNormal.getY(i), sourceStoredNormal.getZ(i));
    }
    for (let i = 0; i < sourceIndex.count; i++)
      this.indexAttr.setX(indexStart + i, vertexStart + sourceIndex.getX(i));
    const id = this.ranges.length;
    this.ranges.push({
      geometry,
      vertexStart,
      vertexCount: sourcePosition.count,
      indexStart,
      indexCount: sourceIndex.count,
      matrix: new THREE.Matrix4(),
    });
    this.vertexCursor += sourcePosition.count;
    this.indexCursor += sourceIndex.count;
    this.instanceCount = this.ranges.length;
    this.geometry.setDrawRange(0, this.indexCursor);
    return id;
  }

  getFaceStartAt(instanceId: number): number {
    return (this.ranges[instanceId]?.indexStart ?? 0) / 3;
  }

  getMatrixAt(instanceId: number, target: THREE.Matrix4): THREE.Matrix4 {
    return target.copy(this.ranges[instanceId]?.matrix ?? new THREE.Matrix4());
  }

  setMatrixAt(instanceId: number, matrix: THREE.Matrix4): void {
    const range = this.ranges[instanceId];
    if (!range) return;
    range.matrix.copy(matrix);
    const sourcePosition = range.geometry.getAttribute('position');
    const sourceNormal = range.geometry.getAttribute('normal');
    const point = new THREE.Vector3();
    const direction = new THREE.Vector3();
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    for (let i = 0; i < range.vertexCount; i++) {
      point.fromBufferAttribute(sourcePosition, i).applyMatrix4(matrix);
      this.positionAttr.setXYZ(range.vertexStart + i, point.x, point.y, point.z);
      if (sourceNormal) {
        direction.fromBufferAttribute(sourceNormal, i).applyNormalMatrix(normalMatrix);
        this.normalAttr.setXYZ(range.vertexStart + i, direction.x, direction.y, direction.z);
      }
    }
    this.positionAttr.needsUpdate = true;
    this.normalAttr.needsUpdate = true;
    this.storedNormalAttr.needsUpdate = true;
    this.boundsTree?.refit();
  }

  setColorAt(instanceId: number, value: THREE.Color): void {
    const range = this.ranges[instanceId];
    if (!range) return;
    for (let i = 0; i < range.vertexCount; i++)
      this.colorAttr.setXYZ(range.vertexStart + i, value.r, value.g, value.b);
    this.colorAttr.needsUpdate = true;
  }

  /** Seal uploaded ranges. Progressive construction can defer the expensive BVH to a Web Worker; synchronous
   * callers retain the original immediate-picking contract. */
  finalize(buildBoundsTree = true): void {
    this.positionAttr.needsUpdate = true;
    this.normalAttr.needsUpdate = true;
    this.storedNormalAttr.needsUpdate = true;
    this.uvAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
    this.sliceAttr.needsUpdate = true;
    this.indexAttr.needsUpdate = true;
    this.computeBoundingSphere();
    this.geometry.computeBoundingBox();
    if (buildBoundsTree) {
      this.boundsTree = new MeshBVH(this.geometry, { indirect: true });
      (this.geometry as BvhGeometry).boundsTree = this.boundsTree;
    }
  }

  /** Install a worker-generated tree against this mesh's live geometry. Deserializing is important: the worker
   * builds from copied arrays so rendering never loses its buffers while the tree is in flight. */
  installBoundsTree(serialized: SerializedBVH): void {
    this.boundsTree = MeshBVH.deserialize(serialized, this.geometry, { setIndex: false });
    (this.geometry as BvhGeometry).boundsTree = this.boundsTree;
  }

  computeBoundingSphere(): void {
    this.geometry.computeBoundingSphere();
    this.geometry.computeBoundingBox();
  }

  override raycast(raycaster: THREE.Raycaster, intersects: THREE.Intersection[]): void {
    const first = intersects.length;
    acceleratedRaycast.call(this, raycaster, intersects);
    for (let i = first; i < intersects.length; i++) {
      const faceIndex = intersects[i].faceIndex;
      if (!Number.isInteger(faceIndex)) continue;
      const id = this.instanceAtFace(faceIndex!);
      if (id >= 0) intersects[i].batchId = id;
    }
  }

  private instanceAtFace(faceIndex: number): number {
    const indexOffset = faceIndex * 3;
    let low = 0, high = this.ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const range = this.ranges[mid];
      if (indexOffset < range.indexStart) high = mid - 1;
      else if (indexOffset >= range.indexStart + range.indexCount) low = mid + 1;
      else return mid;
    }
    return -1;
  }

  dispose(): void {
    this.boundsTree = null;
    delete (this.geometry as BvhGeometry).boundsTree;
    this.geometry.dispose();
    this.material.dispose();
  }
}

/** A reference prop draw can be homogeneous instancing, native multi-draw, or a physical merged fallback. */
export type ReferencePropMesh = THREE.InstancedMesh | THREE.BatchedMesh | MergedStaticPropMesh;

/** Per-draw identity kept at the instance id because a BatchedMesh can contain several prop models/submeshes. */
export interface ReferencePropSlot {
  inst: PropInstance;
  level: string;
  model: number;
  name: string;
  bucket: string;
  object: number | null;
  tex: string | null;
  surface: RefPropSurfaceDetails | null;
  geometry: THREE.BufferGeometry;
  /** First triangle in BatchedMesh.geometry; zero for an InstancedMesh's standalone geometry. */
  faceStart: number;
}

export function isReferencePropMesh(object: THREE.Object3D): object is ReferencePropMesh {
  return (object as THREE.InstancedMesh).isInstancedMesh === true
    || (object as THREE.BatchedMesh).isBatchedMesh === true
    || (object as MergedStaticPropMesh).isMergedStaticPropMesh === true;
}

/** Normalize Three's InstancedMesh.instanceId / BatchedMesh.batchId split. */
export function referencePropInstanceId(hit: THREE.Intersection): number | null {
  if ((hit.object as THREE.BatchedMesh).isBatchedMesh
    || (hit.object as MergedStaticPropMesh).isMergedStaticPropMesh)
    return Number.isInteger(hit.batchId) ? hit.batchId! : null;
  return Number.isInteger(hit.instanceId) ? hit.instanceId! : null;
}

export function referencePropSlot(mesh: ReferencePropMesh, instanceId: number): ReferencePropSlot | null {
  const slot = (mesh.userData.propSlots as Array<ReferencePropSlot | undefined> | undefined)?.[instanceId];
  if (slot) return slot;

  // Compatibility for tests and any older callers that construct the former InstancedMesh metadata directly.
  const inst = (mesh.userData.propInsts as PropInstance[] | undefined)?.[instanceId];
  const level = mesh.userData.propLevel;
  const model = mesh.userData.propModel;
  if (!inst || typeof level !== 'string' || !Number.isInteger(model)) return null;
  return {
    inst, level, model: model as number, name: mesh.name,
    bucket: typeof mesh.userData.propBucket === 'string' ? mesh.userData.propBucket : '',
    object: Number.isInteger(mesh.userData.propObject) ? mesh.userData.propObject as number : null,
    tex: typeof mesh.userData.propTex === 'string' ? mesh.userData.propTex : null,
    surface: (mesh.userData.propSurface as RefPropSurfaceDetails | undefined) ?? null,
    geometry: mesh.geometry, faceStart: 0,
  };
}

export function referencePropHitSlot(hit: THREE.Intersection): ReferencePropSlot | null {
  if (!isReferencePropMesh(hit.object)) return null;
  const id = referencePropInstanceId(hit);
  return id === null ? null : referencePropSlot(hit.object, id);
}

export function referencePropGeometry(object: THREE.Object3D, instanceId: number): THREE.BufferGeometry | null {
  if (!isReferencePropMesh(object)) return (object as THREE.Mesh).geometry ?? null;
  return referencePropSlot(object, instanceId)?.geometry ?? object.geometry;
}

export function referencePropHitGeometry(hit: THREE.Intersection): THREE.BufferGeometry | null {
  const id = referencePropInstanceId(hit);
  return id === null ? (hit.object as THREE.Mesh).geometry ?? null : referencePropGeometry(hit.object, id);
}

/** Convert BatchedMesh's combined-buffer face index back to the source submesh's local triangle index. */
export function referencePropHitFaceIndex(hit: THREE.Intersection): number | null {
  if (!Number.isInteger(hit.faceIndex)) return null;
  const slot = referencePropHitSlot(hit);
  return slot ? hit.faceIndex! - slot.faceStart : hit.faceIndex!;
}
