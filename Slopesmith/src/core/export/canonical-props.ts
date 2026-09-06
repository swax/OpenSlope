import type { EffectsDocument, EffectGraph } from '../effects/document';
import { effectAttachments } from '../effects/authoring';
import { authoredAmbientRecord } from '../effects/external-sound';
import type { V3 } from '../doc/types';
import type {
  BakedGroups, BakedPropClip, BakedPropClipObject, BakedPropClips, BakedPropGroup, BakedPropPose,
  BakedPropSubmesh,
} from './props';

export interface NativeCollisionExport {
  mode: number;
  playerCollision: boolean;
  responseMass: number;
  playerBounce: boolean;
  bounceAmount: number;
  physicsSource?: { level: string; body: number; instance?: number };
  transform: { location: number[]; rotation: number[]; scale: number[] };
}

export interface CanonicalPropMetadata {
  bakedGroups: BakedGroups;
  propClips: BakedPropClips;
  propPoses: Record<string, BakedPropPose>;
  collisionSounds: Record<string, number>;
  collisionSoundClips: Record<string, string>;
  /** Authored ambience per prop. `radius`/`halfExtents` are EDITOR metres; the native record's units and axis
   *  order come from `authoredAmbientRecord`, so this metadata stays in the space it was authored in. */
  ambientSounds: Record<string, {
    event: number; radius: number; falloff?: number; halfExtents?: V3; clip?: string;
  }>;
  propBounce: Record<string, number>;
  propSurfaces: Record<string, number>;
  /** Placement ids authored onto the validated native Showoff-only LTG layer. */
  propModePresence: Record<string, 'showoff'>;
  nativeCollisions: Record<string, NativeCollisionExport>;
  propLighting: Record<string, { amb: number[]; key: number[]; dir: number[] }>;
  effects?: EffectsDocument | null;
}

export interface CanonicalPropFiles {
  text: Record<string, string>;
  instances: number;
  models: number;
  meshes: number;
  collisionMeshes: number;
  animatedModels: number;
  effectBindings: number;
  posedInstances: number;
  warnings: string[];
}

interface NativeFrame {
  location: number[];
  rotation: number[];
  scale: number[];
}

interface Wiring {
  slotIndex: number;
  uvScroll: boolean;
  collision: boolean;
  splineMover: boolean;
  roller: boolean;
}

interface RestFrame {
  t: number[];
  q: number[];
  s: number;
}

interface NativeModelObject {
  ObjectName: string;
  ParentID: number;
  Flags: number;
  Animation: Record<string, unknown> | null;
  MeshData: { MeshPath: string; MaterialID: number }[];
  Position: number[] | null;
  Rotation: number[] | null;
  Scale: number[] | null;
  IncludeAnimation: boolean;
  IncludeMatrix: boolean;
}

interface PackedClip {
  objects: NativeModelObject[];
  rest: RestFrame[];
  packedOf: number[];
  moving: number;
}

const cleanName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_') || 'Prop';

/** SSX's bxStringHash for canonical Instances.json names. The sign bit is cleared exactly like the extracted
 * JSON representation. */
function instanceHash(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 4) + name.charCodeAt(i)) >>> 0;
    const high = hash & 0xf0000000;
    if (high) hash = (hash ^ (high >>> 23)) >>> 0;
    hash = (hash & ~high) >>> 0;
  }
  return hash & 0x7fffffff;
}

function joined<T>(groups: BakedGroups, values: Record<string, T>): Map<string, T> {
  const out = new Map<string, T>();
  for (const [id, value] of Object.entries(values))
    for (const name of groups[id] ?? []) if (!out.has(cleanName(name))) out.set(cleanName(name), value);
  return out;
}

const graphHas = (graph: EffectGraph, predicate: (node: EffectGraph['nodes'][number]) => boolean): boolean =>
  graph.nodes.some(predicate);

function canonicalWirings(document: EffectsDocument | null | undefined,
                          groups: BakedGroups): Map<string, Wiring> {
  const result = new Map<string, Wiring>();
  if (!document) return result;
  const graphById = new Map(document.graphs.map(graph => [graph.id, graph]));
  const slotById = new Map(document.slots.map((slot, index) => [slot.id, { slot, index }]));
  for (const attachment of effectAttachments(document)) {
    if (!attachment.enabled) continue;
    const matched = slotById.get(attachment.slot);
    if (!matched) continue;
    const wiring: Wiring = { slotIndex: matched.index, uvScroll: false, collision: false,
      splineMover: false, roller: false };
    for (const [circumstance, graphId] of Object.entries(matched.slot.circumstances)) {
      const graph = graphId ? graphById.get(graphId) : null;
      if (!graph) continue;
      if (circumstance === 'collision') wiring.collision = true;
      wiring.uvScroll ||= graphHas(graph, node => node.mainType === 0
        && [10, 19].includes(Number((node.payload.type0 as Record<string, unknown> | undefined)?.SubType)));
      wiring.splineMover ||= graphHas(graph, node => node.mainType === 2
        && Number((node.payload.type2 as Record<string, unknown> | undefined)?.SubType) === 1
        && typeof (node.payload.type2 as Record<string, unknown> | undefined)?.SplineAnimation === 'object');
      wiring.roller ||= graphHas(graph, node => node.mainType === 0
        && Number((node.payload.type0 as Record<string, unknown> | undefined)?.SubType) === 0
        && typeof (node.payload.type0 as Record<string, unknown> | undefined)?.type0Sub0 === 'object');
    }
    for (const name of groups[attachment.target.id] ?? [])
      if (!result.has(cleanName(name))) result.set(cleanName(name), wiring);
  }
  return result;
}

const newModelObject = (index: number, parent: number): NativeModelObject => ({
  ObjectName: `Model Object ${index}`,
  ParentID: parent,
  Flags: 0,
  Animation: null,
  MeshData: [],
  Position: null,
  Rotation: null,
  Scale: null,
  IncludeAnimation: false,
  IncludeMatrix: false,
});

function setMatrix(entry: NativeModelObject, position: number[], rotation: number[], scale: number[]): void {
  entry.Position = [...position];
  entry.Rotation = [...rotation];
  entry.Scale = [...scale];
  entry.IncludeMatrix = true;
}

function setAnimation(entry: NativeModelObject, source: BakedPropClipObject, scale: number): void {
  entry.Flags = 1;
  entry.IncludeAnimation = true;
  let action = 0;
  const entries: { AnimationMaths: Record<string, number>[] }[] = [];
  for (let channel = 0; channel < 6; channel++) {
    const curve = source.channels?.[channel];
    if (!curve?.length) continue;
    action |= 1 << channel;
    const k = channel < 3 ? scale : 1;
    entries.push({ AnimationMaths: curve.map(segment => ({
      Value1: segment[0] * k, Value2: segment[1] * k,
      Value3: segment[2] * k, Value4: segment[3] * k,
      Value5: segment[4], Value6: segment[5],
    })) });
  }
  const basePosition = source.basePosition ?? source.restPosition;
  const baseEuler = source.baseEuler ?? [0, 0, 0];
  const radians = Math.PI / 180;
  entry.Animation = {
    U1: basePosition[0] * scale, U2: basePosition[1] * scale, U3: basePosition[2] * scale,
    U4: baseEuler[0] * radians, U5: baseEuler[1] * radians, U6: baseEuler[2] * radians,
    AnimationAction: action,
    AnimationEntries: entries,
  };
}

const length3 = (v: number[]): number => Math.hypot(v[0], v[1], v[2]);

function quatRotate(v: number[], q: number[]): number[] {
  const tx = 2 * (q[1] * v[2] - q[2] * v[1]);
  const ty = 2 * (q[2] * v[0] - q[0] * v[2]);
  const tz = 2 * (q[0] * v[1] - q[1] * v[0]);
  return [
    v[0] + q[3] * tx + q[1] * tz - q[2] * ty,
    v[1] + q[3] * ty + q[2] * tx - q[0] * tz,
    v[2] + q[3] * tz + q[0] * ty - q[1] * tx,
  ];
}

const quatMul = (a: number[], b: number[]): number[] => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];

/** Unit quaternion from an orthonormal basis stored as basis[column][row]. */
function quatFromBasis(m: number[][]): number[] {
  const m11 = m[0][0], m12 = m[1][0], m13 = m[2][0];
  const m21 = m[0][1], m22 = m[1][1], m23 = m[2][1];
  const m31 = m[0][2], m32 = m[1][2], m33 = m[2][2];
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s];
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s];
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s];
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}

function normalizedQuat(q: number[]): number[] {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 1e-12 ? q.map(value => value / n) : [0, 0, 0, 1];
}

/** World raw point -> instance-local point. */
function localPoint(point: number[], frame: NativeFrame | null): number[] {
  if (!frame) return [...point];
  const q = normalizedQuat(frame.rotation);
  const inverse = [-q[0], -q[1], -q[2], q[3]];
  const rotated = quatRotate([
    point[0] - frame.location[0], point[1] - frame.location[1], point[2] - frame.location[2],
  ], inverse);
  return rotated.map((value, index) => value / frame.scale[index]);
}

function objectPoint(point: number[], rest: RestFrame | null): number[] {
  if (!rest) return point;
  const moved = quatRotate(point.map((value, index) => value - rest.t[index]),
    [-rest.q[0], -rest.q[1], -rest.q[2], rest.q[3]]);
  const scale = Math.abs(rest.s) > 1e-12 ? rest.s : 1;
  return moved.map(value => value / scale);
}

function composeRest(parent: RestFrame, position: number[], rotation: number[], scale: number[]): RestFrame {
  const moved = quatRotate(position.map(value => value * parent.s), parent.q);
  return {
    t: parent.t.map((value, index) => value + moved[index]),
    q: quatMul(parent.q, rotation),
    s: parent.s * (scale[0] + scale[1] + scale[2]) / 3,
  };
}

const identitySrt = (position: number[], rotation: number[], scale: number[]): boolean =>
  position.every(value => Math.abs(value) < 1e-9)
  && Math.abs(Math.abs(rotation[3]) - 1) < 1e-9
  && scale.every(value => Math.abs(value - 1) < 1e-9);

function packClip(clip: BakedPropClip, frame: NativeFrame | null): PackedClip | null {
  const origin = clip.pose.origin;
  const frameT = localPoint(origin, frame);
  const basis: number[][] = [];
  const lengths: number[] = [];
  for (let axisIndex = 0; axisIndex < 3; axisIndex++) {
    const axis = [0, 0, 0]; axis[axisIndex] = clip.pose.scale;
    const tip = quatRotate(axis, clip.pose.rotation);
    const localized = localPoint(origin.map((value, index) => value + tip[index]), frame);
    const column = localized.map((value, index) => value - frameT[index]);
    basis.push(column);
    lengths.push(length3(column));
  }
  const frameScale = lengths[0];
  if (!(frameScale > 1e-9)) return null;
  for (let i = 0; i < 3; i++) if (lengths[i] > 1e-9)
    basis[i] = basis[i].map(value => value / lengths[i]);
  const frameQ = quatFromBasis(basis);
  const packed: PackedClip = { objects: [], rest: [], packedOf: new Array(clip.objects.length), moving: 0 };
  for (let k = 0; k < clip.objects.length; k++) {
    const source = clip.objects[k];
    if (k === 0) {
      packed.packedOf[0] = 0;
      packed.objects.push(newModelObject(0, -1));
      packed.rest.push({ t: [0, 0, 0], q: [0, 0, 0, 1], s: 1 });
      continue;
    }
    let parent = source.parent <= 0 ? 0 : packed.packedOf[source.parent];
    let position = source.restPosition.map(value => value * frameScale);
    let rotation = [...source.restRotation];
    const animated = source.channels?.some(curve => !!curve?.length) ?? false;
    if (source.parent <= 0) {
      // An animated object cannot carry a rest rotation of its own: the native player replaces that pose
      // with the channel tuple.  Only insert a parent mount when there is an actual frame to preserve.
      // Besides saving table space, this keeps a flat animated model from spending one native object on an
      // identity mount for every moving child (the object-count/depth canaries exercise this boundary).
      if (animated && !identitySrt(frameT, frameQ, [1, 1, 1])) {
        const mount = newModelObject(packed.objects.length, parent);
        setMatrix(mount, frameT, frameQ, [1, 1, 1]);
        packed.rest.push(composeRest(packed.rest[parent], frameT, frameQ, [1, 1, 1]));
        parent = packed.objects.length;
        packed.objects.push(mount);
      } else {
        const moved = quatRotate(position, frameQ);
        position = frameT.map((value, index) => value + moved[index]);
        rotation = quatMul(frameQ, rotation);
      }
    }
    const entry = newModelObject(packed.objects.length, parent);
    if (!identitySrt(position, rotation, source.restScale))
      setMatrix(entry, position, rotation, source.restScale);
    if (animated) { setAnimation(entry, source, frameScale); packed.moving++; }
    packed.packedOf[k] = packed.objects.length;
    packed.rest.push(composeRest(packed.rest[parent], position, rotation, source.restScale));
    packed.objects.push(entry);
  }
  return packed;
}

const fixed = (value: number, places: number): string => (Number.isFinite(value) ? value : 0).toFixed(places);

function renderMesh(sub: BakedPropSubmesh, frame: NativeFrame | null, rest: RestFrame | null): string {
  const point = (index: number): number[] => objectPoint(localPoint([
    sub.positions[index * 3], sub.positions[index * 3 + 1], sub.positions[index * 3 + 2],
  ], frame), rest);
  const used: number[] = [];
  const localIndex = new Map<number, number>();
  const normals = new Map<number, number[]>();
  for (let k = 0; k + 2 < sub.indices.length; k += 3) {
    const ids = [sub.indices[k], sub.indices[k + 1], sub.indices[k + 2]];
    const [a, b, c] = ids.map(point);
    const u = b.map((value, index) => value - a[index]);
    const v = c.map((value, index) => value - a[index]);
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const id of ids) {
      if (!localIndex.has(id)) { localIndex.set(id, used.length + 1); used.push(id); }
      const prior = normals.get(id) ?? [0, 0, 0];
      normals.set(id, prior.map((value, index) => value + normal[index]));
    }
  }
  const lines = ['# SlopeSmith canonical prop mesh'];
  for (const id of used) lines.push(`v ${point(id).map(value => fixed(value, 3)).join(' ')}`);
  const hasUvs = sub.uvs.length >= sub.positions.length / 3 * 2;
  for (const id of used) lines.push(hasUvs
    ? `vt ${fixed(sub.uvs[id * 2], 6)} ${fixed(sub.uvs[id * 2 + 1], 6)}`
    : 'vt 0.500000 0.500000');
  for (const id of used) {
    let normal = normals.get(id) ?? [0, 0, 1];
    const n = length3(normal);
    normal = n > 1e-9 ? normal.map(value => value / n) : [0, 0, 1];
    lines.push(`vn ${normal.map(value => fixed(value, 4)).join(' ')}`);
  }
  for (let k = 0; k + 2 < sub.indices.length; k += 3) {
    const ids = [sub.indices[k], sub.indices[k + 1], sub.indices[k + 2]];
    lines.push(`f ${ids.map(id => `${localIndex.get(id)}/${localIndex.get(id)}/${localIndex.get(id)}`).join(' ')}`);
  }
  return lines.join('\n') + '\n';
}

/** World-space Props.obj is a projection of the same structured groups as Models/Instances.
 * `inst<n>_...` is the native join that binds each object to Instances[n]. */
function renderWorldProps(groups: readonly BakedPropGroup[]): string {
  const lines = ['# SlopeSmith canonical world-space prop preview'];
  let vertexBase = 0, uvBase = 0;
  groups.forEach((group, groupIndex) => {
    lines.push(`o inst${groupIndex}_${group.name}`);
    for (const sub of group.subs) {
      lines.push(`usemtl ${sub.material}`);
      for (let k = 0; k < sub.positions.length; k += 3)
        lines.push(`v ${fixed(sub.positions[k], 3)} ${fixed(sub.positions[k + 1], 3)} ${fixed(sub.positions[k + 2], 3)}`);
      const hasUvs = sub.uvs.length >= sub.positions.length / 3 * 2;
      if (hasUvs)
        for (let k = 0; k < sub.uvs.length; k += 2)
          lines.push(`vt ${fixed(sub.uvs[k], 6)} ${fixed(sub.uvs[k + 1], 6)}`);
      for (let k = 0; k + 2 < sub.indices.length; k += 3) {
        const face = [sub.indices[k], sub.indices[k + 1], sub.indices[k + 2]].map(index => {
          const vertex = vertexBase + index + 1;
          return hasUvs ? `${vertex}/${uvBase + index + 1}` : String(vertex);
        });
        lines.push(`f ${face.join(' ')}`);
      }
      vertexBase += sub.positions.length / 3;
      if (hasUvs) uvBase += sub.uvs.length / 2;
    }
  });
  return lines.join('\n') + '\n';
}

/**
 * A triangle proxy ships at WORLD SIZE — localized against the instance's rotation and pivot like the render
 * mesh, but with the placement's scale left baked into the geometry instead of divided out onto the instance.
 *
 * The instance `Scale` reaches the renderer and not this: a 6x-scaled prop drew at 6x while its contact volume
 * stayed the authored 1x pad at the pivot, so a rider crossing the art missed the proxy entirely and neither
 * the collision effect nor the prop's hit sound fired. Retail never exercises the other reading — across eight
 * shipped levels, all 10,126 mode-1 proxies sit on an unscaled instance — so a proxy that already matches its
 * art is the only shape with evidence behind it. Unscaled placements divide by one and are unchanged.
 */
function collisionMesh(group: BakedPropGroup, frame: NativeFrame | null): string {
  const lines = ['# SlopeSmith canonical triangle collision proxy'];
  const indexes = new Map<string, number>();
  const unscaled: NativeFrame | null = frame ? { ...frame, scale: [1, 1, 1] } : null;
  const local = (sub: BakedPropSubmesh, index: number) => localPoint([
    sub.positions[index * 3], sub.positions[index * 3 + 1], sub.positions[index * 3 + 2],
  ], unscaled);
  group.subs.forEach((sub, subIndex) => {
    for (const index of sub.indices) {
      const key = `${subIndex}:${index}`;
      if (indexes.has(key)) continue;
      indexes.set(key, indexes.size + 1);
      lines.push(`v ${local(sub, index).map(value => fixed(value, 3)).join(' ')}`);
    }
  });
  group.subs.forEach((sub, subIndex) => {
    for (let k = 0; k + 2 < sub.indices.length; k += 3)
      lines.push(`f ${[sub.indices[k], sub.indices[k + 1], sub.indices[k + 2]]
        .map(index => indexes.get(`${subIndex}:${index}`)).join(' ')}`);
  });
  return lines.join('\n') + '\n';
}

const wantsCollision = (name: string): boolean =>
  ['Prop_', 'RailSolid_', 'RailSupport_', 'ModelSolid_', 'ImportSolid_'].some(prefix => name.startsWith(prefix));

/** Serialize SlopeSmith's structured prop bake into the native-shaped tables an ISO extraction writes.
 * Models.json, Instances.json and Meshes/ are the semantic contract; Props.obj is its world-space view. */
export function buildCanonicalProps(sourceGroups: readonly BakedPropGroup[],
                                    metadata: CanonicalPropMetadata): CanonicalPropFiles {
  const groups = sourceGroups.filter(group => group.subs.some(sub => sub.indices.length >= 3))
    .map(group => ({ ...group, name: cleanName(group.name) }));
  const poses = joined(metadata.bakedGroups, metadata.propPoses);
  const clips = joined(metadata.bakedGroups, metadata.propClips);
  const hitSounds = joined(metadata.bakedGroups, metadata.collisionSounds);
  const collisionClips = joined(metadata.bakedGroups, metadata.collisionSoundClips);
  const ambientSounds = joined(metadata.bakedGroups, metadata.ambientSounds);
  const bounce = joined(metadata.bakedGroups, metadata.propBounce);
  const surfaces = joined(metadata.bakedGroups, metadata.propSurfaces);
  const modePresence = joined(metadata.bakedGroups, metadata.propModePresence);
  const collisions = joined(metadata.bakedGroups, metadata.nativeCollisions);
  const lighting = joined(metadata.bakedGroups, metadata.propLighting);
  const wirings = canonicalWirings(metadata.effects, metadata.bakedGroups);
  const files: Record<string, string> = {};
  const models: Record<string, unknown>[] = [];
  const instances: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  const collisionWorld = ['# SSX real collision proxies baked to world space from canonical SlopeSmith instances'];
  let meshes = 0, collisionMeshes = 0, animatedModels = 0, effectBindings = 0, posedInstances = 0;

  groups.forEach((group, groupIndex) => {
    const wiring = wirings.get(group.name);
    if (wiring) effectBindings++;
    const splineMover = wiring?.splineMover === true && wiring.roller !== true;
    const pose = poses.get(group.name);
    const authoredFrame: NativeFrame | null = pose ? {
      location: [...pose.origin], rotation: [...pose.rotation], scale: [pose.scale, pose.scale, pose.scale],
    } : null;
    if (authoredFrame) posedInstances++;
    // Native spline nodes own their host's world rotation and never apply the source instance's Rotation or
    // Scale. Keep only the pivot on that instance and localize against a translation-only frame, leaving the
    // authored lead orientation and size baked into its model. Unity's diverted world mesh retains that basis
    // and the mover manifest carries an identity rotation.
    // A group with no authored placement may still declare its own pivot (the staging markers). Translation
    // only: the instance carries the point, the mesh localizes against it.
    const ownFrame: NativeFrame | null = group.origin
      ? { location: [...group.origin], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } : null;
    const frame: NativeFrame | null = authoredFrame && splineMover ? {
      location: authoredFrame.location, rotation: [0, 0, 0, 1], scale: [1, 1, 1],
    } : authoredFrame ?? ownFrame;
    const clip = clips.get(group.name);
    const packed = clip ? packClip(clip, frame) : null;
    if (packed) {
      animatedModels++;
      if (packed.objects.length > 27)
        warnings.push(`${group.name} packs ${packed.objects.length} native ModelObjects; SSX Tricky's safe maximum is 27.`);
    }
    const objectCount = packed?.objects.length ?? 1;
    const objects = packed?.objects ?? [newModelObject(0, -1)];
    group.subs.forEach((sub, subIndex) => {
      const owner = packed && sub.object >= 0 && sub.object < packed.packedOf.length
        ? packed.packedOf[sub.object] : 0;
      const meshName = `prop_${String(groupIndex).padStart(4, '0')}_${String(subIndex).padStart(2, '0')}.obj`;
      files[`Meshes/${meshName}`] = renderMesh(sub, frame, packed?.rest[owner] ?? null);
      objects[owner].MeshData.push({ MeshPath: meshName, MaterialID: sub.slot });
      meshes++;
    });
    // A malformed clip tag can only fall back to object zero; keep all object entries so the animation table
    // remains byte-shaped even when an authored moving object owns no visible geometry.
    while (objects.length < objectCount) objects.push(newModelObject(objects.length, -1));
    models.push({ ModelName: group.name, Unknown3: 0, AnimTime: packed ? clip!.clipFrames : 0,
      ModelObjects: objects });

    const native = collisions.get(group.name);
    let solid = wantsCollision(group.name) && !splineMover;
    const hasHitSound = hitSounds.has(group.name);
    let hasCollisionProxy = solid || (!solid && !splineMover && (wiring?.collision === true || hasHitSound));
    if (native) {
      solid = native.playerCollision && native.playerBounce && native.responseMass !== 0;
      hasCollisionProxy = native.playerCollision && native.mode === 1;
    }
    const collisionPaths: string[] = [];
    if (hasCollisionProxy) {
      const collisionName = `prop_${String(groupIndex).padStart(4, '0')}.obj`;
      files[`Collision/${collisionName}`] = collisionMesh(group, frame);
      collisionPaths.push(collisionName);
      collisionMeshes++;
      const vertexBase = collisionWorld.filter(line => line.startsWith('v ')).length;
      collisionWorld.push(`o inst${groupIndex}_${group.name}`);
      const keys = new Map<string, number>();
      group.subs.forEach((sub, subIndex) => {
        for (const index of sub.indices) {
          const key = `${subIndex}:${index}`;
          if (keys.has(key)) continue;
          keys.set(key, keys.size + 1);
          collisionWorld.push(`v ${fixed(sub.positions[index * 3], 3)} ${fixed(sub.positions[index * 3 + 1], 3)} ${fixed(sub.positions[index * 3 + 2], 3)}`);
        }
      });
      group.subs.forEach((sub, subIndex) => {
        for (let k = 0; k + 2 < sub.indices.length; k += 3)
          collisionWorld.push(`f ${[sub.indices[k], sub.indices[k + 1], sub.indices[k + 2]]
            .map(index => vertexBase + (keys.get(`${subIndex}:${index}`) ?? 0)).join(' ')}`);
      });
    }

    const light = lighting.get(group.name);
    const ambience = ambientSounds.get(group.name);
    // The native tail is derived, never hand-written: `authoredAmbientRecord` owns which U-slot each authored
    // number lands in, so a type-0 sphere and a type-1 ellipsoid cannot disagree with what the editor drew.
    const ambienceTail = ambience ? authoredAmbientRecord(ambience) : null;
    const externalSounds = ambience && ambienceTail ? [{
      U0: ambience.halfExtents ? 1 : 0, SoundIndex: ambience.event, U2: 0, U3: 0, U4: 0,
      U5: ambienceTail[0] ?? 0, U6: ambienceTail[1] ?? 0, U7: ambienceTail[2] ?? 0,
      U8: ambienceTail[3] ?? 0, U9: ambienceTail[4] ?? 0, U10: ambienceTail[5] ?? 0,
      U11: ambienceTail[6] ?? 0,
      SoundClip: ambience.clip ?? null,
    }] : [];
    instances.push({
      InstanceName: group.name,
      Location: frame?.location ?? [0, 0, 0],
      Rotation: frame?.rotation ?? [0, 0, 0, 1],
      Scale: frame?.scale ?? [1, 1, 1],
      LightVector1: [...(light?.dir ?? [0, 0, 0]), 0],
      LightVector2: [0, 0, 0, 0], LightVector3: [0, 0, 0, 0], AmbentLightVector: [0, 0, 0, 0],
      LightColour1: [...(light?.key ?? [0, 0, 0]), 0],
      LightColour2: [0, 0, 0, 0], LightColour3: [0, 0, 0, 0],
      AmbentLightColour: [...(light?.amb ?? [256, 256, 256]), 128],
      ModelID: groupIndex, PrevInstance: -1, NextInstance: -1,
      UnknownInt26: 0, UnknownInt27: 0, UnknownInt28: 0,
      UnknownInt30: 0, UnknownInt31: 0, UnknownInt32: 0,
      // The editor exposes the semantic layer, not this integer. GemIndex/state 2 is retail's complete
      // Showoff-only object set; the ordinary common list remains 0.
      LTGState: modePresence.get(group.name) === 'showoff' ? 2 : 0,
      Hash: instanceHash(group.name), IncludeSound: true,
      Sounds: { CollisonSound: hitSounds.get(group.name) ?? 0, ExternalSounds: externalSounds },
      SoundClip: collisionClips.get(group.name) ?? null,
      ExactCollisionProfile: !!native,
      U0: native?.responseMass ?? (solid ? 1e30 : 0),
      PlayerBounceAmmount: native?.bounceAmount ?? (bounce.has(group.name)
        ? Math.max(0, bounce.get(group.name)!) : solid ? 0.5 : 0),
      U2: 0,
      Visable: !splineMover && !group.name.startsWith('EffectTrigger_'),
      PlayerCollision: native?.playerCollision ?? hasCollisionProxy,
      PlayerBounce: native?.playerBounce ?? solid,
      Unknown241: false,
      UVScroll: wiring?.uvScroll ?? false,
      SurfaceType: solid && surfaces.has(group.name) ? surfaces.get(group.name) : -1,
      CollsionMode: native?.mode ?? (hasCollisionProxy ? 1 : 0),
      CollsionModelPaths: collisionPaths,
      EffectSlotIndex: wiring?.slotIndex ?? -1,
      PhysicsIndex: native?.physicsSource && native.physicsSource.body >= 0 ? native.physicsSource.body : -1,
      U8: 0,
    });
  });

  files['Models.json'] = JSON.stringify({ Models: models }, null, 2) + '\n';
  files['Instances.json'] = JSON.stringify({ Instances: instances }, null, 2) + '\n';
  files['Props.obj'] = renderWorldProps(groups);
  files['PropsCollision.obj'] = collisionWorld.join('\n') + '\n';
  return { text: files, instances: instances.length, models: models.length, meshes, collisionMeshes,
    animatedModels, effectBindings, posedInstances, warnings };
}
