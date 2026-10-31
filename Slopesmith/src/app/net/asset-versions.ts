import { assetMapKey, parseAssetVersion, type AssetVersion } from '../../core/reference/asset-version';
import { type MapSourceChoice } from '../../core/reference/map-game';
import { findMapChoice, mapSourceId, splitMapSource, type MapSource } from '../../core/reference/map-source';

type Transport = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
let transport: Transport = (url, init) => fetch(url, init);
const locations = new Map<string, string>();
const preferences = new Map<string, MapSource>();
const pending = new Map<string, Promise<AssetVersion>>();
const verified = new Map<string, AssetVersion>();
const documentPins = new WeakMap<object, Promise<void>>();
let catalogueCache: Promise<MapSourceChoice[]> | undefined;
const listeners = new Set<() => void>();
const storageKey = 'slopesmith.asset-source-preferences.v1';
let preferencesRead = false;

export function configureAssetTransport(next: Transport): void {
  transport = next;
}
export function clearAssetCatalogue(): void {
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
export async function pinDocumentAssets(document: unknown): Promise<void> {
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
        if (!level || parseAssetVersion(level) || ['Custom', '@models', '@import'].includes(level)) continue;
        let pinned = maps.get(level);
        if (!pinned) {
          pinned = pinAssetMap(level);
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
  if (parseAssetVersion(level) || !level || ['Custom', '@models', '@import'].includes(level)) return level;
  const choice = findMapChoice(await catalogue(), level) ?? { name: level };
  const location = locationId(choice);
  const value = await version(location, true);
  prefer(value.id, splitMapSource(location).source!);
  bind(value.id, location);
  return value.id;
}

export async function fetchVersionedAsset(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(
    input instanceof Request ? input.url : input.toString(),
    globalThis.location?.origin ?? 'http://localhost',
  );
  const parameter = url.pathname === '/api/level' ? 'name' : 'level';
  const id = url.searchParams.get(parameter) ?? '';
  const expected = parseAssetVersion(id);
  if (!expected) return transport(input, init);
  const preferred = assetPreference(id);
  // Catalogue game labels are only hints (older/prop-only banks can lack them). The complete
  // descriptor below still has to match game, map and content before a candidate can supply bytes.
  const maps = (await catalogue()).filter(
    map => assetMapKey(splitMapSource(map.name).name, map.course) === expected.map,
  );
  const candidates = [
    ...new Set(
      [
        locations.get(id),
        ...maps.map(locationId),
        mapSourceId('local', expected.map),
        mapSourceId('server', expected.map),
      ].filter((name): name is string => !!name),
    ),
  ];
  candidates.sort(
    (a, b) => Number(splitMapSource(b).source === preferred) - Number(splitMapSource(a).source === preferred),
  );
  const attempts: { location: string; reason: string }[] = [];
  for (const location of candidates) {
    try {
      if ((await version(location)).id !== id) {
        attempts.push({ location, reason: 'Different asset version' });
        continue;
      }
      const candidate = new URL(url);
      const source = splitMapSource(location).source!;
      candidate.searchParams.set('mapSource', source);
      // The server verifies the version again before opening files. Local readers hold immutable Blob snapshots.
      candidate.searchParams.set(parameter, source === 'server' ? id : splitMapSource(location).name);
      const response = await transport(candidate, init);
      if (!response.ok) {
        attempts.push({ location, reason: `HTTP ${response.status}` });
        verified.delete(location);
        continue;
      }
      bind(id, location);
      return response;
    } catch (error) {
      attempts.push({ location, reason: error instanceof Error ? error.message : String(error) });
      verified.delete(location); /* Try the other location, but only after checking its content fingerprint. */
    }
  }
  return Response.json(
    {
      error: `Matching asset version ${expected.hash.slice(0, 8)} for ${expected.map} is unavailable. Load that version locally or make it available on the server.`,
      attempts,
    },
    { status: 404 },
  );
}
