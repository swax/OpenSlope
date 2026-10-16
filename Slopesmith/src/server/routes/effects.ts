import * as fs from '../fs-async';
import { mapsRoot } from '../workspace-config';
import * as reader from '../../shared/map-effects';
const dataSource = (): import('../../shared/map-data').MapDataSource => ({ root: mapsRoot(), ...fs });
export const readReferenceEffects = (...args: Tail<Parameters<typeof reader.readReferenceEffects>>) => reader.readReferenceEffects(dataSource(), ...args);
type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
