import { stat } from 'node:fs/promises';
import { join } from 'node:path';
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
import { safeDataName } from '../core/export/names';
import { referenceMapData, resolveServerMapName } from './reference-map-paths';
import { readAssetManifest } from '../shared/map-asset-manifest';
import type { AssetManifest } from '../core/reference/asset-manifest';
import { assetRequestCovered } from '../core/reference/asset-manifest';
import { readLevelProps } from './routes/props';
const manifests = new Map<string, Promise<AssetManifest>>();
const manifestReads = new Map<string, Promise<AssetManifest>>();

export async function serverMapAssetManifest(name: string): Promise<AssetManifest> {
  const level = await resolveServerMapName(name);
  if (!level || safeDataName(level) !== level) throw new Error('Invalid asset map name.');
  const key = `${mapsRoot()}/${level}`;
  let reading = manifestReads.get(key);
  if (!reading) {
    // A page can request hundreds of assets from one bank at once. Share the freshness scan as well
    // as the manifest build, rather than walking and stat-ing that bank once per waiting texture.
    reading = readServerManifest(level);
    manifestReads.set(key, reading);
    void reading
      .finally(() => {
        if (manifestReads.get(key) === reading) manifestReads.delete(key);
      })
      .catch(() => {});
  }
  return reading;
}

async function readServerManifest(level: string): Promise<AssetManifest> {
  const files = await assetBankFiles(referenceMapData(), level);
  const signature = await serverAssetSignature(level, files);
  const key = `${mapsRoot()}/${level}/${await sha256(new TextEncoder().encode(signature))}`;
  let value = manifests.get(key);
  if (!value) {
    // Retain only the current snapshot of this bank.
    for (const previous of manifests.keys())
      if (previous.startsWith(`${mapsRoot()}/${level}/`)) manifests.delete(previous);
    value = readAssetManifest(referenceMapData(), level, () => readLevelProps(level)).then(manifest => {
      for (const asset of manifest.assets) registerServerAssetVersion(asset.id, level);
      return manifest;
    });
    manifests.set(key, value);
    void value.catch(() => {
      if (manifests.get(key) === value) manifests.delete(key);
    });
  }
  return value;
}

const cache = new Map<string, { signature: string; value: Promise<AssetVersion> }>();
const pending = new Map<string, Promise<AssetVersion>>();
const textureHashes = new Map<string, ReadonlyMap<string, string>>();

export async function serverMapAssetVersion(name: string): Promise<AssetVersion> {
  const level = await resolveServerMapName(name);
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

async function serverAssetSignature(level: string, files: readonly string[]): Promise<string> {
  const io = referenceMapData();
  return JSON.stringify(
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
}

async function readServerVersion(level: string, key: string): Promise<AssetVersion> {
  const io = referenceMapData();
  const files = await assetBankFiles(io, level);
  const signature = await serverAssetSignature(level, files);
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
  if (!expected) return resolveServerMapName(id);
  const known = serverAssetVersionName(id);
  const matches = async (name: string) =>
    expected.kind
      ? (await serverMapAssetManifest(name)).assets.some(asset => asset.id === id)
      : (await serverMapAssetVersion(name)).id === id;
  if (known) {
    try {
      if (await matches(known)) return known;
    } catch {
      /* Check other copies. */
    }
  }
  const candidates = (await listLevelOrigins()).filter(
    map => map.name !== known && mapGame(map) === expected.game && assetMapKey(map.name, map.course) === expected.map,
  );
  for (const map of candidates) {
    try {
      if (await matches(map.name)) {
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
  const version = parseAssetVersion(id);
  const asset =
    version?.kind &&
    (await serverMapAssetManifest(await resolveServerAssetVersion(id))).assets.find(asset => asset.id === id);
  const expected = asset
    ? Object.entries(asset.files).find(([path]) => path.toLowerCase() === `textures/${name}`.toLowerCase())?.[1]
    : textureHashes.get(id)?.get(`textures/${name}`.toLowerCase());
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
      const resource = mount ? mount + (url.pathname === '/' ? '' : url.pathname) : endpoint;
      if (!assetRequestCovered(parseAssetVersion(id)!, resource, url.searchParams))
        throw new AssetVersionUnavailable('This asset identity does not cover the requested resource.');
      // Image requests validate the individual file against the already fingerprinted bank. Walking
      // and stat-ing an entire map for every thumbnail would turn a library into quadratic disk work.
      const known =
        endpoint === '/api/texture' && !parseAssetVersion(id)?.kind && textureHashes.has(id)
          ? serverAssetVersionName(id)
          : undefined;
      url.searchParams.set(parameter, known ?? (await resolveServerAssetVersion(id)));
      url.searchParams.set('assetVersion', id);
    }
  }
  return url.pathname + url.search;
}
