import type { V3 } from '../math/vector-types';

/** Native quaternion order used by ParticleInstances.json. Kept native so copied reference volumes repack
 * without a lossy Euler conversion; the editor currently translates volumes but does not rotate them. */
export type ParticleQuaternion = [number, number, number, number];

/** One native puff record. Position/radius remain in model-local SSX centimetres. The field exported as
 * `Rotation` is a near-uniform per-puff scale in every shipped fog model, so it is named honestly here. */
export interface ParticlePuff {
  position: V3;
  scale: V3;
  radius: number;
}

/** A particle model can contain more than one object header even though the shipped fog corpus uses one. */
export interface ParticleVolumeObject {
  boundsMin: V3;
  boundsMax: V3;
  objectU1: number;
  puffs: ParticlePuff[];
}

/** Standalone PBD particle volume. `pos` is the one editor-space field (metres/Y-up), like props and gems;
 * rotation, object geometry, and bounds offsets retain their native raw-space representation for ISO export. */
export interface ParticleVolume {
  id: string;
  name: string;
  pos: V3;
  nativeRotation: ParticleQuaternion;
  scale: V3;
  /** Raw-space world AABB relative to the instance Location. Translation can change without invalidating it. */
  boundsOffsetMin: V3;
  boundsOffsetMax: V3;
  objects: ParticleVolumeObject[];
  unknownInts: [number, number, number, number, number];
  /**
   * The level this volume was copied from — its sprite donor. Fog draws from the level-independent
   * PARTICLE.SSH art, which every extraction carries a copy of, so the donor only decides WHICH extracted
   * copy an export stages into `Textures/Particles/`. Recorded here, the way a painted tile records its
   * source level, so a fresh export stages the same bytes the volume was authored against. Absent (an
   * authored-from-scratch cloud) => the first extracted copy in the library.
   */
  donor?: string;
}

interface RawParticleInstance {
  ParticleName?: unknown;
  Location?: unknown;
  Rotation?: unknown;
  Scale?: unknown;
  LowestXYZ?: unknown;
  HighestXYZ?: unknown;
  UnknownInt8?: unknown;
  UnknownInt9?: unknown;
  UnknownInt10?: unknown;
  UnknownInt11?: unknown;
  UnknownInt12?: unknown;
  ParticleModelIndex?: unknown;
}

interface RawParticleFrame { Position?: unknown; Rotation?: unknown; Unknown?: unknown }
interface RawParticleObject { LowestXYZ?: unknown; HighestXYZ?: unknown; U1?: unknown; AnimationFrames?: unknown }
interface RawParticleHeader { ParticleObject?: unknown }
interface RawParticleModel { ParticleObjectHeaders?: unknown }

const finite = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const integer = (value: unknown, fallback = 0): number => Number.isInteger(value) ? Number(value) : fallback;

const vec3 = (value: unknown, fallback: V3): V3 => Array.isArray(value) && value.length >= 3
  ? [finite(value[0], fallback[0]), finite(value[1], fallback[1]), finite(value[2], fallback[2])]
  : [...fallback];

const quat = (value: unknown): ParticleQuaternion => Array.isArray(value) && value.length >= 4
  ? [finite(value[0]), finite(value[1]), finite(value[2]), finite(value[3], 1)]
  : [0, 0, 0, 1];

/** Raw SSX cm/Z-up/mirrored-X -> Slopesmith metres/Y-up. Kept local to avoid a particles->terrain dependency. */
export const particleEditorFromRaw = (p: V3): V3 => [-p[0] / 100, p[2] / 100, -p[1] / 100];
export const particleRawFromEditor = (p: V3): V3 => [-100 * p[0], -100 * p[2], 100 * p[1]];

function puff(raw: RawParticleFrame): ParticlePuff {
  return {
    position: vec3(raw.Position, [0, 0, 0]),
    scale: vec3(raw.Rotation, [1, 1, 1]),
    radius: Math.max(1, finite(raw.Unknown, 1)),
  };
}

function volumeObject(raw: RawParticleObject): ParticleVolumeObject {
  const frames = Array.isArray(raw.AnimationFrames) ? raw.AnimationFrames : [];
  return {
    boundsMin: vec3(raw.LowestXYZ, [0, 0, 0]),
    boundsMax: vec3(raw.HighestXYZ, [0, 0, 0]),
    objectU1: integer(raw.U1, 2914832),
    puffs: frames.map(item => puff((item ?? {}) as RawParticleFrame)),
  };
}

/** Join the native instance/model tables through the recovered +0x40 `ParticleModelIndex` reference. */
export function particleVolumesFromNative(instancesInput: unknown, modelsInput: unknown): ParticleVolume[] {
  const instances = Array.isArray(instancesInput) ? instancesInput as RawParticleInstance[] : [];
  const models = Array.isArray(modelsInput) ? modelsInput as RawParticleModel[] : [];
  return instances.map((raw, index) => {
    const name = String(raw.ParticleName ?? `Fog_Volume_${index}`);
    const model = models[integer(raw.ParticleModelIndex, -1)];
    const headers = model && Array.isArray(model.ParticleObjectHeaders)
      ? model.ParticleObjectHeaders as RawParticleHeader[] : [];
    const loc = vec3(raw.Location, [0, 0, 0]);
    const min = vec3(raw.LowestXYZ, loc), max = vec3(raw.HighestXYZ, loc);
    return {
      id: `particle-volume:${index}`,
      name,
      pos: particleEditorFromRaw(loc),
      nativeRotation: quat(raw.Rotation),
      scale: vec3(raw.Scale, [1, 1, 1]),
      boundsOffsetMin: [min[0] - loc[0], min[1] - loc[1], min[2] - loc[2]] as V3,
      boundsOffsetMax: [max[0] - loc[0], max[1] - loc[1], max[2] - loc[2]] as V3,
      objects: headers.map(header => volumeObject((header.ParticleObject ?? {}) as RawParticleObject)),
      unknownInts: [integer(raw.UnknownInt8), integer(raw.UnknownInt9), integer(raw.UnknownInt10),
        integer(raw.UnknownInt11), integer(raw.UnknownInt12)] as [number, number, number, number, number],
    };
  }).filter(volume => volume.objects.some(object => object.puffs.length));
}

function rotate(v: V3, q: ParticleQuaternion): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx)];
}

function derivedObjectBounds(puffs: readonly ParticlePuff[]): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const item of puffs) {
    const r = item.radius * Math.max(Math.abs(item.scale[0]), Math.abs(item.scale[1]), Math.abs(item.scale[2]));
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], item.position[axis] - r);
      max[axis] = Math.max(max[axis], item.position[axis] + r);
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

function derivedInstanceOffsets(volume: ParticleVolume): { min: V3; max: V3 } {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  const volumeRadiusScale = Math.max(Math.abs(volume.scale[0]), Math.abs(volume.scale[1]), Math.abs(volume.scale[2]));
  for (const object of volume.objects) for (const item of object.puffs) {
    const local: V3 = [item.position[0] * volume.scale[0], item.position[1] * volume.scale[1], item.position[2] * volume.scale[2]];
    const center = rotate(local, volume.nativeRotation);
    const r = item.radius * Math.max(Math.abs(item.scale[0]), Math.abs(item.scale[1]), Math.abs(item.scale[2])) * volumeRadiusScale;
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], center[axis] - r);
      max[axis] = Math.max(max[axis], center[axis] + r);
    }
  }
  return Number.isFinite(min[0]) ? { min, max } : { min: [0, 0, 0], max: [0, 0, 0] };
}

export interface NativeParticleFiles { instances: { Particles: object[] }; models: { ParticlePrefabs: object[] } }

/** Emit the exact JSON pair consumed by SSX-Library's PBD writer and Snowknife's Unity bundle adapter. */
export function particleVolumesToNative(volumes: readonly ParticleVolume[]): NativeParticleFiles {
  const particles: object[] = [], prefabs: object[] = [];
  volumes.forEach((volume, index) => {
    const loc = particleRawFromEditor(volume.pos);
    const derived = derivedInstanceOffsets(volume);
    const offsetMin = volume.boundsOffsetMin.every(Number.isFinite) ? volume.boundsOffsetMin : derived.min;
    const offsetMax = volume.boundsOffsetMax.every(Number.isFinite) ? volume.boundsOffsetMax : derived.max;
    particles.push({
      ParticleName: volume.name,
      Location: loc,
      Rotation: volume.nativeRotation,
      Scale: volume.scale,
      ParticleModelIndex: index,
      LowestXYZ: [loc[0] + offsetMin[0], loc[1] + offsetMin[1], loc[2] + offsetMin[2]],
      HighestXYZ: [loc[0] + offsetMax[0], loc[1] + offsetMax[1], loc[2] + offsetMax[2]],
      UnknownInt8: volume.unknownInts[0], UnknownInt9: volume.unknownInts[1],
      UnknownInt10: volume.unknownInts[2], UnknownInt11: volume.unknownInts[3],
      UnknownInt12: volume.unknownInts[4],
    });
    prefabs.push({
      ParticleModelName: volume.name,
      ParticleObjectHeaders: volume.objects.map(object => {
        const derivedBounds = derivedObjectBounds(object.puffs);
        return { ParticleObject: {
          LowestXYZ: object.boundsMin.every(Number.isFinite) ? object.boundsMin : derivedBounds.min,
          HighestXYZ: object.boundsMax.every(Number.isFinite) ? object.boundsMax : derivedBounds.max,
          U1: object.objectU1,
          AnimationFrames: object.puffs.map(item => ({
            Position: item.position, Rotation: item.scale, Unknown: item.radius,
          })),
        } };
      }),
    });
  });
  return { instances: { Particles: particles }, models: { ParticlePrefabs: prefabs } };
}

export function nextParticleVolumeId(volumes: readonly ParticleVolume[]): string {
  const used = new Set(volumes.map(volume => volume.id));
  for (let n = 1; ; n++) { const id = `fog-volume-${n}`; if (!used.has(id)) return id; }
}

export function uniqueParticleVolumeName(volumes: readonly ParticleVolume[], base = 'Fog_Volume'): string {
  const used = new Set(volumes.map(volume => volume.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) { const name = `${base}_${n}`; if (!used.has(name.toLowerCase())) return name; }
}

/** The extracted particle bank an export stages `fog0.png` from: the first donor the placed volumes name.
 *  Empty when nothing names one, which takes the first extracted copy in the library. */
export function particleDonorLevel(volumes: readonly ParticleVolume[] | undefined): string {
  return volumes?.find(volume => volume.donor)?.donor ?? '';
}

export function cloneParticleVolume(source: ParticleVolume, volumes: readonly ParticleVolume[]): ParticleVolume {
  const copy = JSON.parse(JSON.stringify(source)) as ParticleVolume;
  copy.id = nextParticleVolumeId(volumes);
  copy.name = uniqueParticleVolumeName(volumes, source.name);
  return copy;
}

/** Native-shaped starter cloud: nine overlapping puffs covering a roughly 40 m wide soft volume. */
export function createFogVolume(pos: V3, volumes: readonly ParticleVolume[] = []): ParticleVolume {
  const centers: V3[] = [
    [0, 0, 0], [-1200, 200, -700], [1200, -100, 600], [0, 550, 1300], [400, -350, -1400],
    [-1800, 350, 900], [1750, 250, -800], [-650, 800, -1700], [850, 700, 1750],
  ];
  const puffs: ParticlePuff[] = centers.map((position, index) => ({
    position, scale: [1, 1, 1], radius: index === 0 ? 1500 : 1200,
  }));
  const bounds = derivedObjectBounds(puffs);
  const volume: ParticleVolume = {
    id: nextParticleVolumeId(volumes),
    name: uniqueParticleVolumeName(volumes),
    pos: [...pos], nativeRotation: [0, 0, 0, 1], scale: [1, 1, 1],
    boundsOffsetMin: [...bounds.min], boundsOffsetMax: [...bounds.max],
    objects: [{ boundsMin: bounds.min, boundsMax: bounds.max, objectU1: 2914832, puffs }],
    unknownInts: [0, 0, 0, 0, 0],
  };
  return volume;
}

/** Defensive migration for saved mountain documents. Malformed records are dropped rather than reaching the
 * renderer/exporter; IDs and names are repaired deterministically. */
export function normalizeParticleVolumes(input: unknown): ParticleVolume[] {
  if (!Array.isArray(input)) return [];
  const out: ParticleVolume[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const value = raw as Partial<ParticleVolume>;
    const objects = Array.isArray(value.objects) ? value.objects.map(object => {
      const item = (object ?? {}) as Partial<ParticleVolumeObject>;
      const puffs = Array.isArray(item.puffs) ? item.puffs.map(frame => {
        const p = (frame ?? {}) as Partial<ParticlePuff>;
        return { position: vec3(p.position, [0, 0, 0]), scale: vec3(p.scale, [1, 1, 1]),
          radius: Math.max(1, finite(p.radius, 1)) };
      }) : [];
      const derived = derivedObjectBounds(puffs);
      return { boundsMin: vec3(item.boundsMin, derived.min), boundsMax: vec3(item.boundsMax, derived.max),
        objectU1: integer(item.objectU1, 2914832), puffs };
    }).filter(object => object.puffs.length) : [];
    if (!objects.length) continue;
    const candidate: ParticleVolume = {
      id: typeof value.id === 'string' && value.id ? value.id : nextParticleVolumeId(out),
      name: typeof value.name === 'string' && value.name ? value.name : uniqueParticleVolumeName(out),
      pos: vec3(value.pos, [0, 0, 0]), nativeRotation: quat(value.nativeRotation),
      scale: vec3(value.scale, [1, 1, 1]),
      boundsOffsetMin: vec3(value.boundsOffsetMin, [NaN, NaN, NaN]),
      boundsOffsetMax: vec3(value.boundsOffsetMax, [NaN, NaN, NaN]),
      objects,
      unknownInts: Array.isArray(value.unknownInts) && value.unknownInts.length >= 5
        ? [integer(value.unknownInts[0]), integer(value.unknownInts[1]), integer(value.unknownInts[2]),
          integer(value.unknownInts[3]), integer(value.unknownInts[4])] : [0, 0, 0, 0, 0],
      ...(typeof value.donor === 'string' && value.donor ? { donor: value.donor } : {}),
    };
    if (out.some(volume => volume.id === candidate.id)) candidate.id = nextParticleVolumeId(out);
    if (out.some(volume => volume.name.toLowerCase() === candidate.name.toLowerCase()))
      candidate.name = uniqueParticleVolumeName(out, candidate.name);
    const derived = derivedInstanceOffsets(candidate);
    if (!candidate.boundsOffsetMin.every(Number.isFinite)) candidate.boundsOffsetMin = derived.min;
    if (!candidate.boundsOffsetMax.every(Number.isFinite)) candidate.boundsOffsetMax = derived.max;
    out.push(candidate);
  }
  return out;
}
