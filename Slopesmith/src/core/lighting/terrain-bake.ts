import { bakeAO, bakeSunShadow } from './occlusion';
import { bakeRigLighting, type LightRig } from '../reference/lights';
import { SIGN_TERRAIN_WEIGHT_K } from './sign-lights';

/** Bump when the bake algorithms or their sampling settings change; stored results must remain exact. */
export const TERRAIN_BAKE_VERSION = 'terrain-lighting/v1';
export type TerrainBakePart = 'ao' | 'shadow' | 'glow';
export type TerrainBakeResult = Partial<Record<TerrainBakePart, Float32Array>>;
export interface TerrainBakeInput {
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  dir: [number, number, number];
  rig: LightRig | null;
}

/** Shared by the worker and its compatibility fallback, using the editor's existing full-quality bake. */
export function bakeTerrainParts(input: TerrainBakeInput, parts: readonly TerrainBakePart[]): TerrainBakeResult {
  const result: TerrainBakeResult = {};
  for (const part of parts) {
    if (part === 'ao') result.ao = bakeAO(input.positions, input.indices, input.normals, 16, 1024);
    else if (part === 'shadow') result.shadow = bakeSunShadow(input.positions, input.indices, input.dir, 1536);
    else if (input.rig) result.glow = bakeRigLighting(input.positions, input.normals, input.rig, SIGN_TERRAIN_WEIGHT_K);
  }
  return result;
}

export function validTerrainBake(value: unknown, part: TerrainBakePart, vertices: number): value is Float32Array {
  return (
    value instanceof Float32Array &&
    value.length === vertices * (part === 'glow' ? 3 : 1) &&
    value.every(v => Number.isFinite(v) && v >= 0 && (part === 'glow' || v <= 1))
  );
}
