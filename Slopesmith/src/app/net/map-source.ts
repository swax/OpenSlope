import { splitMapSource } from '../../core/reference/map-source';
import { parseAssetVersion } from '../../core/reference/asset-version';
import { assetLocation } from './asset-versions';
import { safeDataName } from '../../core/export/names';

/** Keep source identity in client cache/document keys, and send ordinary folder names over HTTP. */
export function mapSourceRequest(input: RequestInfo | URL) {
  const url = new URL(
    input instanceof Request ? input.url : input.toString(),
    globalThis.location?.origin ?? 'http://localhost',
  );
  const parameter = url.pathname === '/api/level' ? 'name' : 'level';
  const id = url.searchParams.get(parameter) ?? '';
  const api = url.origin === (globalThis.location?.origin ?? url.origin) && url.pathname.startsWith('/api/');
  const selected = api ? splitMapSource(id) : { name: id };
  const source = api ? (selected.source ?? url.searchParams.get('mapSource')) : undefined;
  if (selected.source) {
    url.searchParams.set(parameter, selected.name);
    url.searchParams.set('mapSource', selected.source);
  }
  const version = api ? parseAssetVersion(id) : undefined;
  return { url, source, id, name: selected.name, explicit: !!selected.source || !!version, version };
}

/** Restore the requested identity after a server/local reader returns its physical folder name. */
export function bindMapPayload<T>(input: RequestInfo | URL, body: T): T {
  const request = mapSourceRequest(input);
  if (!request.explicit || !body || typeof body !== 'object') return body;
  const value = body as Record<string, unknown>;
  if (typeof value.level === 'string') value.level = request.id;
  if (request.url.pathname === '/api/level' && typeof value.name === 'string') value.name = request.id;
  if (Array.isArray(value.groups))
    for (const group of value.groups)
      if (group && typeof group === 'object' && 'level' in group) group.level = request.id;
  if (value.tables && typeof value.tables === 'object' && request.version) {
    const tables = value.tables as Record<string, unknown>;
    const location = assetLocation(request.id);
    const physical = location && splitMapSource(location).name;
    if (physical && location) {
      const own =
        Object.entries(tables).find(([key]) => key.toLowerCase() === safeDataName(location).toLowerCase()) ??
        Object.entries(tables).find(([key]) => key.toLowerCase() === safeDataName(physical).toLowerCase());
      if (own) tables[safeDataName(request.id)] = own[1];
    }
  }
  return body;
}
