import { parseAssetVersion, type AssetVersion } from '../../core/reference/asset-version';
import { type MapSourceChoice } from '../../core/reference/map-game';
import { createAssetReader } from './asset-reader';
import type { ReferenceAssetKind } from '../../core/reference/asset-manifest';
import type { PropsPayload } from '../../core/reference/props';
import { findMapChoice, mapSourceId, splitMapSource, type MapSource } from '../../core/reference/map-source';
import { makeTexRef, parseTexRef } from '../../core/paint/textures';

type Transport = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let transport: Transport = (url, init) => fetch(url, init);
let reader = createAssetReader(transport, bind);
const locations = new Map<string, string>();
const preferences = new Map<string, MapSource>();
const pending = new Map<string, Promise<AssetVersion>>();
const verified = new Map<string, AssetVersion>();
const documentPins = new WeakMap<object, Promise<void>>();
let catalogueCache: Promise<MapSourceChoice[]> | undefined;
const listeners = new Set<() => void>();
const storageKey = 'slopesmith.asset-source-preferences.v1';
let preferencesRead = false;
const projectAssetLevel = (level: string): boolean => {
  const name = splitMapSource(level).name;
  return name === 'Custom' || name.startsWith('@');
};

export function configureAssetTransport(next: Transport): void {
  transport = next;
  reader = createAssetReader(next, bind);
}
export function clearAssetCatalogue(): void {
  reader.clear();
  catalogueCache = undefined;
  verified.clear();
}
export function assetLocation(id: string): string | undefined {
  return locations.get(id);
}
export function watchAssetLocations(changed: () => void): () => void {
  listeners.add(changed);
  return () => listeners.delete(changed);
}

export function assetPreference(id: string): MapSource {
  if (!preferencesRead) {
    preferencesRead = true;
    try {
      const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Record<string, unknown>;
      for (const [key, value] of Object.entries(stored))
        if (value === 'local' || value === 'server') preferences.set(key, value);
    } catch {
      /* Storage is optional; identity is saved in the document itself. */
    }
  }
  return preferences.get(id) ?? 'local';
}

function bind(id: string, location: string): void {
  if (locations.get(id) === location) return;
  locations.set(id, location);
  for (const changed of listeners) changed();
}

function prefer(id: string, source: MapSource): void {
  assetPreference(id);
  if (preferences.get(id) === source) return;
  preferences.set(id, source);
  for (const changed of listeners) changed();
  try {
    localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(preferences)));
  } catch {
    /* optional */
  }
}

/** Upgrade legacy pointers only while their original source can still be fingerprinted. */
export async function pinDocumentAssets(document: unknown, defaultSource?: MapSource): Promise<void> {
  if (!document || typeof document !== 'object') return;
  const previous = documentPins.get(document);
  if (previous) return previous;
  const changes: Promise<void>[] = [];
  const maps = new Map<string, Promise<string>>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if (ArrayBuffer.isView(value) || (Array.isArray(value) && typeof value[0] === 'number')) return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string') {
        if (child.length > 2048) continue;
        const slash = child.indexOf('/');
        const texture = slash > 0 && /\.(png|webp|jpg|jpeg)$/i.test(child);
        const prop = key === 'level' && ('model' in value || 'body' in value);
        const level = texture ? child.slice(0, slash) : prop ? child : '';
        if (!level || parseAssetVersion(level) || projectAssetLevel(level)) continue;
        let pinned = maps.get(level);
        if (!pinned) {
          const source = splitMapSource(level).source;
          pinned = pinAssetMap(!source && defaultSource ? mapSourceId(defaultSource, level) : level);
          maps.set(level, pinned);
        }
        changes.push(
          pinned
            .then(id => {
              (value as Record<string, unknown>)[key] = texture ? id + child.slice(slash) : id;
            })
            .catch(() => {}),
        );
      } else visit(child);
    }
  };
  visit(document);
  const result = Promise.all(changes).then(() => {});
  documentPins.set(document, result);
  await result;
}

async function catalogue(): Promise<MapSourceChoice[]> {
  catalogueCache ??= readCatalogue().catch(() => {
    catalogueCache = undefined;
    return [];
  });
  return catalogueCache;
}
async function readCatalogue(): Promise<MapSourceChoice[]> {
  const response = await transport('/api/levels');
  if (!response.ok) return [];
  const value = (await response.json()) as { levels?: string[]; maps?: MapSourceChoice[] };
  return (value.levels ?? []).map(name => value.maps?.find(map => map.name === name) ?? { name });
}

function locationId(map: MapSourceChoice): string {
  return mapSourceId(map.source ?? splitMapSource(map.name).source ?? 'server', map.name);
}

async function version(location: string, fresh = false): Promise<AssetVersion> {
  if (!fresh && verified.has(location)) return verified.get(location)!;
  let promise = pending.get(location);
  if (!promise) {
    promise = (async () => {
      const response = await transport(`/api/map-asset-version?level=${encodeURIComponent(location)}`);
      if (!response.ok) throw new Error('The selected map assets are unavailable.');
      const value = (await response.json()) as AssetVersion;
      if (!parseAssetVersion(value.id)) throw new Error('The map returned an invalid asset version.');
      verified.set(location, value);
      return value;
    })();
    pending.set(location, promise);
    void promise.finally(() => pending.delete(location)).catch(() => {});
  }
  return promise;
}

/** Called before a library exposes selectable assets, so drag/drop also carries a stable version. */
export async function pinAssetMap(level: string): Promise<string> {
  if (parseAssetVersion(level) || !level || projectAssetLevel(level)) return level;
  const choice = findMapChoice(await catalogue(), level) ?? { name: level };
  const location = locationId(choice);
  const value = await version(location, true);
  prefer(value.id, splitMapSource(location).source!);
  bind(value.id, location);
  return value.id;
}

/** Per-asset identities for new picks. Project-owned assets keep their live project references. */
export async function pinReferenceAssets(level: string, kind: ReferenceAssetKind, keys: readonly string[]) {
  if (projectAssetLevel(level)) return new Map(keys.map(key => [key, level]));
  return reader.pinAssets(await pinAssetMap(level), kind, keys);
}

export async function pinReferenceAsset(level: string, kind: ReferenceAssetKind, key: string): Promise<string> {
  return (await pinReferenceAssets(level, kind, [key])).get(key)!;
}

/** Library shortcuts that copy a tile without opening the Texture Library still pin the selected art. */
export async function pinTextureReference(ref: string): Promise<string> {
  const { level, name } = parseTexRef(ref);
  const asset = parseAssetVersion(level);
  const bank = asset?.kind && asset.kind !== 'texture' ? await reader.libraryBank(level) : level;
  return makeTexRef(await pinReferenceAsset(bank, 'texture', name), name);
}

export const referenceLibraryBank = (level: string) => reader.libraryBank(level);

export function fetchVersionedAsset(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return reader.fetch(input, init);
}

/** Also runs on persisted payloads from earlier builds, which still carry bare crowd filenames. */
export async function resolvePropCrowdFrames(payload: PropsPayload): Promise<PropsPayload> {
  if (parseAssetVersion(payload.level)?.kind === 'prop' && payload.crowdFrames?.length)
    payload.crowdFrames = await reader.crowdFrames(payload.level, payload.crowdFrames);
  return payload;
}

export const availableAssetMaps = () => reader.maps();
export const readAssetManifestAt = (location: string) => reader.manifest(location);
export const readAssetBankAt = (location: string) => reader.version(location);
