import { referenceMapData as dataSource } from '../reference-map-paths';
import * as reader from '../../shared/map-effects';
export const readReferenceEffects = (...args: Tail<Parameters<typeof reader.readReferenceEffects>>) =>
  reader.readReferenceEffects(dataSource(), ...args);
type Tail<T extends unknown[]> = T extends [unknown, ...infer R] ? R : never;
