import * as fs from '../fs-async';
import { mapsRoot } from '../workspace-config';
import * as reader from '../../shared/map-levels';
const dataSource = (): import('../../shared/map-data').MapDataSource => ({ root: mapsRoot(), ...fs });
export const listLevels = (...args: Tail<Parameters<typeof reader.listLevels>>) =>
  reader.listLevels(dataSource(), ...args);
export const readLevelOrigin = (...args: Tail<Parameters<typeof reader.readLevelOrigin>>) =>
  reader.readLevelOrigin(dataSource(), ...args);
export const listLevelOrigins = (...args: Tail<Parameters<typeof reader.listLevelOrigins>>) =>
  reader.listLevelOrigins(dataSource(), ...args);
export const readLevelPatches = (...args: Tail<Parameters<typeof reader.readLevelPatches>>) =>
  reader.readLevelPatches(dataSource(), ...args);
export const readLevelCourse = (...args: Tail<Parameters<typeof reader.readLevelCourse>>) =>
  reader.readLevelCourse(dataSource(), ...args);
export const readLevelLaps = (...args: Tail<Parameters<typeof reader.readLevelLaps>>) =>
  reader.readLevelLaps(dataSource(), ...args);
export const readLevelShowoffSeconds = (...args: Tail<Parameters<typeof reader.readLevelShowoffSeconds>>) =>
  reader.readLevelShowoffSeconds(dataSource(), ...args);
export const readLevelAiPaths = (...args: Tail<Parameters<typeof reader.readLevelAiPaths>>) =>
  reader.readLevelAiPaths(dataSource(), ...args);
export const readLevelLights = (...args: Tail<Parameters<typeof reader.readLevelLights>>) =>
  reader.readLevelLights(dataSource(), ...args);
export const readLevelBillboards = (...args: Tail<Parameters<typeof reader.readLevelBillboards>>) =>
  reader.readLevelBillboards(dataSource(), ...args);
export const readLevelWorld = (...args: Tail<Parameters<typeof reader.readLevelWorld>>) =>
  reader.readLevelWorld(dataSource(), ...args);
export const readLevelLightRig = (...args: Tail<Parameters<typeof reader.readLevelLightRig>>) =>
  reader.readLevelLightRig(dataSource(), ...args);
export { levelSplinesFromNative } from '../../shared/map-levels';
export const readLevelSplines = (...args: Tail<Parameters<typeof reader.readLevelSplines>>) =>
  reader.readLevelSplines(dataSource(), ...args);
export const readLightmapPng = async (...args: Tail<Parameters<typeof reader.readLightmapPng>>) =>
  Buffer.from(await reader.readLightmapPng(dataSource(), ...args));
export type { LevelCourse } from '../../shared/map-levels';
type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
