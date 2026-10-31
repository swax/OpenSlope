import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import * as fs from './fs-async';
import { mapsRoot } from './workspace-config';
import { listLevelOrigins } from './routes/levels';
import { assetBankFiles, readAssetVersion, sha256 } from '../shared/map-asset-version';
import {
  assetMapKey,
  assetVersionsIn,
  parseAssetVersion,
  registerServerAssetVersion,
  serverAssetVersionName,
  type AssetVersion,
} from '../core/reference/asset-version';
import { mapGame } from '../core/reference/map-game';
import { serverMapName } from '../core/reference/map-source';
import { safeDataName } from '../core/export/names';

const cache = new Map<string, { signature: string; value: Promise<AssetVersion> }>();
const pending = new Map<string, Promise<AssetVersion>>();
const textureHashes = new Map<string, ReadonlyMap<string, string>>();

export function serverMapAssetVersion(name: string): Promise<AssetVersion> {
  const level = serverMapName(name);
  if (!level || safeDataName(level) !== level) return Promise.reject(new Error('Invalid asset map name.'));
  const key = join(mapsRoot(), level);
  let value = pending.get(key);
  if (!value) {
    value = readServerVersion(level, key);
    pending.set(key, value);
    void value
      .finally(() => {
        if (pending.get(key) === value) pending.delete(key);
      })
      .catch(() => {});
  }
  return value;
}

async function readServerVersion(level: string, key: string): Promise<AssetVersion> {
  const io = { root: mapsRoot(), ...fs };
  const files = await assetBankFiles(io, level);
  const signature = JSON.stringify(
    await Promise.all(
      [...files, 'Origin.json', 'Import.json'].map(async path => {
        try {
          const value = await stat(join(io.root, level, path), { bigint: true });
          return [path, String(value.size), String(value.mtimeNs), String(value.ctimeNs), String(value.ino)];
        } catch {
          return [path, 'missing'];
        }
      }),
    ),
  );
  const found = cache.get(key);
  if (found?.signature === signature) return found.value;
  const hashes = new Map<string, string>();
  const value = readAssetVersion(io, level, files, (path, hash) => {
    if (path.startsWith('textures/')) hashes.set(path, hash);
  }).then(version => {
    textureHashes.set(version.id, hashes);
    registerServerAssetVersion(version.id, level);
    return version;
  });
  cache.set(key, { signature, value });
  void value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

export class AssetVersionUnavailable extends Error {
  readonly statusCode = 404;
}

export async function resolveServerAssetVersion(id: string): Promise<string> {
  const expected = parseAssetVersion(id);
  if (!expected) return serverMapName(id);
  const known = serverAssetVersionName(id);
  if (known) {
    try {
      if ((await serverMapAssetVersion(known)).id === id) return known;
    } catch {
      /* Check other copies. */
    }
  }
  const candidates = (await listLevelOrigins()).filter(
    map => map.name !== known && mapGame(map) === expected.game && assetMapKey(map.name, map.course) === expected.map,
  );
  for (const map of candidates) {
    try {
      if ((await serverMapAssetVersion(map.name)).id === id) {
        registerServerAssetVersion(id, map.name);
        return map.name;
      }
    } catch {
      /* A missing/broken candidate must not hide another matching copy. */
    }
  }
  throw new AssetVersionUnavailable(
    `Matching asset version ${expected.hash.slice(0, 8)} for ${expected.map} is unavailable on the server.`,
  );
}

/** Immutable image cache entries must contain exactly the bytes from the pinned bank. */
export async function validateVersionedTexture(id: string | null, name: string, bytes: Uint8Array): Promise<void> {
  if (!id) return;
  const expected = textureHashes.get(id)?.get(`textures/${name}`.toLowerCase());
  if (!expected || (await sha256(bytes)) !== expected)
    throw new AssetVersionUnavailable('The requested texture version is unavailable.');
}

export async function prepareServerAssetVersions(document: unknown): Promise<void> {
  await Promise.all(assetVersionsIn(document).map(resolveServerAssetVersion));
}

/** Called after route authorization, so version lookups retain the original endpoint's access policy. */
export async function resolveVersionedApiUrl(path: string, mount?: string): Promise<string> {
  const url = new URL(path, 'http://localhost');
  const endpoint = mount ?? url.pathname;
  url.searchParams.delete('assetVersion'); // Only the verified level below may set the internal cache partition.
  for (const parameter of ['level', ...(endpoint === '/api/level' ? ['name'] : [])]) {
    const id = url.searchParams.get(parameter) ?? '';
    if (parseAssetVersion(id)) {
      // Image requests validate the individual file against the already fingerprinted bank. Walking
      // and stat-ing an entire map for every thumbnail would turn a library into quadratic disk work.
      const known = endpoint === '/api/texture' && textureHashes.has(id) ? serverAssetVersionName(id) : undefined;
      url.searchParams.set(parameter, known ?? (await resolveServerAssetVersion(id)));
      url.searchParams.set('assetVersion', id);
    }
  }
  return url.pathname + url.search;
}
