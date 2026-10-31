import { serverMapName } from '../../core/reference/map-source';
import { join } from 'node:path';
import * as fs from '../fs-async';
import { mapsRoot, workspaceConfig } from '../workspace-config';
import { runInWorker } from '../worker-pool';
import { readPersistentPropsJson, type PersistentPropsJson, type PersistentPropsPayload } from '../props-payload-cache';
import type { PropsPayload } from '../../core/reference/props';
import { safeDataName } from './safe-name';
import * as reader from '../../shared/map-props';

const dataSource = (): reader.MapDataSource => ({ root: mapsRoot(), ...fs });
export {
  meshThrowModelIds,
  rollerInstanceMasses,
  modelObjectRestMatrices,
  materialsWithAlphaOverrides,
  simpleModelRotation,
  hierarchicalModelAnimation,
} from '../../shared/map-props';
export type { ModelSub, ModelGeom, PhysicsBodyMassProps } from '../../shared/map-props';

export const levelsWithProps = (...args: Tail<Parameters<typeof reader.levelsWithProps>>) =>
  reader.levelsWithProps(dataSource(), ...args);
export const readMaterialTables = (...args: Tail<Parameters<typeof reader.readMaterialTables>>) =>
  reader.readMaterialTables(dataSource(), ...args);
export const readModelGeometries = (...args: Tail<Parameters<typeof reader.readModelGeometries>>) =>
  reader.readModelGeometries(dataSource(), ...args);
export const buildLevelPropsUncached = (...args: Tail<Parameters<typeof reader.buildLevelPropsUncached>>) =>
  reader.buildLevelPropsUncached(dataSource(), ...args);
export const readPhysicsBodyMassProps = (...args: Tail<Parameters<typeof reader.readPhysicsBodyMassProps>>) =>
  reader.readPhysicsBodyMassProps(dataSource(), ...args);
export const readPhysicsBodySpheres = (...args: Tail<Parameters<typeof reader.readPhysicsBodySpheres>>) =>
  reader.readPhysicsBodySpheres(dataSource(), ...args);
export const modelLocalBox = (...args: Tail<Parameters<typeof reader.modelLocalBox>>) =>
  reader.modelLocalBox(dataSource(), ...args);
export const createMaterialCombiner = (...args: Tail<Parameters<typeof reader.createMaterialCombiner>>) =>
  reader.createMaterialCombiner(dataSource(), ...args);
export const nativeArtSource = (...args: Tail<Parameters<typeof reader.nativeArtSource>>) =>
  reader.nativeArtSource(dataSource(), ...args);

type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;

/** Persist the expensive extracted OBJ/material/physics bake across dev-server and application restarts. The
 * source metadata fingerprint changes whenever an input changes, while the ordinary response cache still owns
 * in-flight sharing, compression, ETags, and hot-process LRU behavior. */
export function readLevelPropsJsonWithCacheInfo(level: string): Promise<PersistentPropsJson> {
  const lvl = safeDataName(serverMapName(level));
  const levelDir = join(mapsRoot(), lvl);
  // A cold build is tens of seconds of parsing and encoding, so it runs on a worker thread; a cache hit stays
  // here, because reading the finished payload is far cheaper than shipping the request across threads.
  return readPersistentPropsJson(lvl, levelDir, async () => {
    const { workspaceRoot } = workspaceConfig();
    return (await runInWorker({ kind: 'props', level: lvl, mapsRoot: mapsRoot(), workspaceRoot })) as Uint8Array;
  });
}

export async function readLevelPropsWithCacheInfo(level: string): Promise<PersistentPropsPayload> {
  const stored = await readLevelPropsJsonWithCacheInfo(level);
  return {
    payload: JSON.parse(stored.json.toString('utf8')) as PropsPayload,
    cache: stored.cache,
    fingerprint: stored.fingerprint,
  };
}

export async function readLevelProps(level: string): Promise<PropsPayload> {
  return (await readLevelPropsWithCacheInfo(level)).payload;
}
