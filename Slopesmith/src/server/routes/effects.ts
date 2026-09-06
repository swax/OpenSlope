import { join } from 'node:path';
import { readJsonOr } from '../fs-async';
import type { V3 } from '../../core/doc/types';
import {
  type ReferenceEffectInstance,
  type ReferenceEffectsPayload,
} from '../../core/reference/effects';
import { mapsRoot } from '../workspace-config';
import { safeDataName } from './safe-name';
import { particleVolumesFromNative } from '../../core/particles/volumes';
import {
  NATIVE_COLLISION_MODE, nativeContactState, type NativeCollisionMode,
} from '../../core/collision/native';

interface RawInstance {
  InstanceName?: string;
  ModelID?: number;
  Location?: number[];
  Rotation?: number[];
  Scale?: number[];
  EffectSlotIndex?: number;
  LTGState?: number;
  Visable?: boolean;
  IncludeSound?: boolean;
  Sounds?: { CollisonSound?: number } | null;
  PlayerCollision?: boolean;
  PlayerBounce?: boolean;
  CollsionMode?: number;
  CollsionModelPaths?: string[];
  PhysicsIndex?: number;
  U0?: number;
}

interface RawModel {
  ModelName?: string;
}

const vec3 = (raw: number[] | undefined, fallback: V3): V3 => raw && raw.length >= 3
  ? [Number(raw[0]), Number(raw[1]), Number(raw[2])]
  : fallback;

function instanceContact(raw: RawInstance): 'through' | 'solid' {
  const mode = Number.isInteger(raw.CollsionMode)
    ? raw.CollsionMode as NativeCollisionMode : NATIVE_COLLISION_MODE.none;
  const contact = nativeContactState({
    visible: raw.Visable !== false,
    playerCollision: raw.PlayerCollision !== false,
    playerBounce: raw.PlayerBounce !== false,
    mode,
    responseMass: typeof raw.U0 === 'number' ? raw.U0 : 1e30,
    hasTriangleProxy: !!raw.CollsionModelPaths?.length,
    hasPhysicsBody: typeof raw.PhysicsIndex === 'number' && raw.PhysicsIndex >= 0,
  });
  // A `none` row can never dispatch a real contact; treating it as through is the safe audio fallback for an
  // older/incomplete extraction while keeping a non-blocking response if some other contact proxy supplies it.
  return contact === 'solid' ? 'solid' : 'through';
}

/** Read the canonical instance-to-effect-slot join used by the reference Effects viewer/runtime. */
export async function readReferenceEffects(level: string): Promise<ReferenceEffectsPayload> {
  const safe = safeDataName(level);
  const dir = join(mapsRoot(), safe);
  // Effects.json and Instances.json are the two large reads of this route and are independent, so they are
  // fetched together rather than one after the other.
  const [rawDocument, rawInstancesFile] = await Promise.all([
    readJsonOr<unknown>(join(dir, 'Effects.json'), undefined),
    readJsonOr<{ Instances?: RawInstance[] } | null>(join(dir, 'Instances.json'), null),
  ]);
  if (rawDocument === undefined)
    throw new Error(`${safe} has no Effects.json; re-extract or re-export the level`);
  if (!rawInstancesFile)
    throw new Error(`no Instances.json for ${safe}; re-extract or re-export the level`);
  const rawInstances = rawInstancesFile.Instances ?? [];
  const rawModels = (await readJsonOr<{ Models?: RawModel[] }>(join(dir, 'Models.json'), {})).Models ?? [];
  const instances: ReferenceEffectInstance[] = rawInstances.map((raw, index) => ({
    index,
    name: String(raw.InstanceName ?? `Instance ${index}`),
    modelName: String(rawModels[Number(raw.ModelID ?? -1)]?.ModelName ?? raw.InstanceName ?? `Model ${raw.ModelID ?? -1}`),
    model: Number(raw.ModelID ?? -1),
    loc: vec3(raw.Location, [0, 0, 0]),
    rot: raw.Rotation && raw.Rotation.length >= 4
      ? [Number(raw.Rotation[0]), Number(raw.Rotation[1]), Number(raw.Rotation[2]), Number(raw.Rotation[3])]
      : [0, 0, 0, 1],
    scale: vec3(raw.Scale, [1, 1, 1]),
    effectSlotIndex: Number.isInteger(raw.EffectSlotIndex) ? Number(raw.EffectSlotIndex) : -1,
    ltgState: Number.isInteger(raw.LTGState) ? Number(raw.LTGState) : 0,
    visible: raw.Visable !== false,
    // The ADL collision-sound EVENT id (not a bank slot - core/effects/collision-sound.ts resolves it).
    // -1 = the instance ships no sound record; authored-silent ids (e.g. 0) are carried as-is.
    collisionSound: raw.IncludeSound !== false && raw.Sounds && Number.isInteger(raw.Sounds.CollisonSound)
      ? Number(raw.Sounds.CollisonSound) : -1,
    contact: instanceContact(raw),
  }));
  const [particleInstancesFile, particleModelsFile] = await Promise.all([
    readJsonOr<{ Particles?: unknown[] } | null>(join(dir, 'ParticleInstances.json'), null),
    readJsonOr<{ ParticlePrefabs?: unknown[] } | null>(join(dir, 'ParticleModels.json'), null),
  ]);
  // Both files are needed to place a volume; a level shipping only one contributes none.
  const particleVolumes = particleInstancesFile && particleModelsFile
    ? particleVolumesFromNative(particleInstancesFile.Particles ?? [], particleModelsFile.ParticlePrefabs ?? [])
    : [] as ReturnType<typeof particleVolumesFromNative>;

  return {
    level: safe,
    document: rawDocument,
    instances,
    particleVolumes,
  };
}
