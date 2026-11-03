import {
  TERRAIN_BAKE_VERSION,
  bakeTerrainParts,
  validTerrainBake,
  type TerrainBakeInput,
  type TerrainBakePart,
  type TerrainBakeResult,
} from '../../../core/lighting/terrain-bake';
import { canonicalAssetJson, sha256 } from '../../../core/reference/asset-hash';
import { beginDiagnosticPhase } from '../../net/diagnostics';
import { createTerrainLightingCache, type TerrainLightingCache } from './lighting-cache';

type BakeWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;
export interface TerrainBakeRequest {
  input: TerrainBakeInput;
  parts: TerrainBakePart[];
}
export type TerrainBakeResponse = { result: TerrainBakeResult } | { error: string };

/** Hash binary mesh inputs instead of serializing the tessellated mesh into a large JSON string. */
export async function terrainLightingKeys(input: TerrainBakeInput): Promise<Record<TerrainBakePart, string>> {
  const memo = new Map<ArrayBufferView, Promise<string>>();
  const hash = (values: ArrayBufferView) => {
    let result = memo.get(values);
    if (!result) {
      result = sha256(new Uint8Array(values.buffer, values.byteOffset, values.byteLength));
      memo.set(values, result);
    }
    return result;
  };
  const hashes = await Promise.all([input.positions, input.normals, input.indices].map(hash));
  const geometry = hashes.join(':');
  const blockers = await Promise.all(
    (input.occluders ?? []).map(async mesh => [
      await hash(mesh.positions),
      await hash(mesh.indices),
      mesh.matrix ?? null,
      mesh.mask && mesh.uvs
        ? [await hash(mesh.uvs), await hash(mesh.mask.alpha), mesh.mask.width, mesh.mask.height, mesh.mask.cutoff]
        : null,
    ]),
  );
  const blockerHash = await sha256(new TextEncoder().encode(canonicalAssetJson(blockers)));
  const rig = input.rig?.lights.map(light => [
    light.kind,
    light.category,
    light.negative,
    light.pos,
    light.dir,
    light.colorHex,
    light.intensity,
    light.coneCos,
    light.reach,
  ]);
  const rigHash = await sha256(new TextEncoder().encode(canonicalAssetJson(rig ?? null)));
  return {
    ao: `${TERRAIN_BAKE_VERSION}:ao:${geometry}:${blockerHash}`,
    shadow: `${TERRAIN_BAKE_VERSION}:shadow:${geometry}:${blockerHash}:${input.dir.join(',')}`,
    glow: `${TERRAIN_BAKE_VERSION}:glow:${geometry}:${rigHash}`,
  };
}

export function createTerrainLightingClient(
  deps: {
    cache?: TerrainLightingCache;
    createWorker?: () => BakeWorker;
    fallback?: typeof bakeTerrainParts;
  } = {},
) {
  const cache = deps.cache ?? createTerrainLightingCache();
  const fallback = deps.fallback ?? bakeTerrainParts;
  async function compute(
    input: TerrainBakeInput,
    parts: TerrainBakePart[],
    signal?: AbortSignal,
  ): Promise<TerrainBakeResult> {
    signal?.throwIfAborted();
    try {
      return await new Promise<TerrainBakeResult>((resolve, reject) => {
        let worker: BakeWorker;
        try {
          worker =
            deps.createWorker?.() ?? new Worker(new URL('./lighting-worker.ts', import.meta.url), { type: 'module' });
        } catch (error) {
          reject(error);
          return;
        }
        let settled = false;
        const finish = (result?: TerrainBakeResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          worker.terminate();
          if (result) resolve(result);
          else reject(signal?.aborted ? signal.reason : new Error('Terrain lighting worker unavailable'));
        };
        const abort = () => finish();
        const timer = setTimeout(() => finish(), 30_000);
        signal?.addEventListener('abort', abort, { once: true });
        worker.onmessage = event => {
          const message = event.data as TerrainBakeResponse;
          if (!message || typeof message !== 'object') return finish();
          const result = 'result' in message ? message.result : undefined;
          finish(
            result && parts.every(part => validTerrainBake(result[part], part, input.positions.length / 3))
              ? result
              : undefined,
          );
        };
        worker.onerror = worker.onmessageerror = () => finish();
        try {
          // Clone instead of detaching: a failed worker must leave the exact inputs available for fallback.
          worker.postMessage({ input, parts } satisfies TerrainBakeRequest);
        } catch {
          finish();
        }
      });
    } catch {
      signal?.throwIfAborted();
      return fallback(input, parts);
    }
  }
  return {
    async prepare(
      source: TerrainBakeInput,
      parts: TerrainBakePart[],
      signal?: AbortSignal,
    ): Promise<TerrainBakeResult> {
      signal?.throwIfAborted();
      if (!parts.length) return {};
      // Editing can continue while storage/the worker runs. Hash and bake the same immutable snapshot.
      // Structured cloning preserves shared model buffers across many instances of the same prop.
      const input: TerrainBakeInput = structuredClone(source);
      const trace = beginDiagnosticPhase('lighting', 'terrain:prepare', `${input.positions.length / 3} vertices`);
      try {
        const keys = await terrainLightingKeys(input).catch(() => undefined);
        signal?.throwIfAborted();
        if (!keys) {
          const result = await compute(input, parts, signal);
          trace.complete('computed without persistent cache');
          return result;
        }
        const result: TerrainBakeResult = {};
        await Promise.all(
          parts.map(async part => {
            const cached = await cache.get(keys[part]).catch(() => undefined);
            if (validTerrainBake(cached, part, input.positions.length / 3)) result[part] = cached;
          }),
        );
        signal?.throwIfAborted();
        const missing = parts.filter(part => !result[part]);
        if (missing.length) {
          const computed = await compute(input, missing, signal);
          signal?.throwIfAborted();
          for (const part of missing) {
            const values = computed[part];
            if (!validTerrainBake(values, part, input.positions.length / 3))
              throw new Error(`Invalid ${part} lighting bake`);
            result[part] = values;
          }
          await Promise.all(missing.map(part => cache.put(keys[part], result[part]!).catch(() => {})));
        }
        trace.complete(parts.map(part => `${part}=${missing.includes(part) ? 'computed' : 'cached'}`).join(' '));
        return result;
      } catch (error) {
        if (signal?.aborted) trace.complete('superseded');
        else trace.fail(error);
        throw error;
      }
    },
  };
}
