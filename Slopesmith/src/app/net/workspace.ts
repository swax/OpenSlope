/** The editor can use a browser workspace in place of the authenticated API. */
import { mapSourceRequest } from './map-source';
import {
  clearAssetCatalogue,
  configureAssetTransport,
  fetchVersionedAsset,
  reportImportedAssetReplacements,
  resolvePropCrowdFrames,
} from './asset-versions';
import { fetchRuntimeAssetReplacement } from './asset-replacements';
import { createAssetResolver } from '../../shared/asset-resolver';
import {
  browserAssetCache,
  referenceAssetCacheKey,
  referenceAssetRequest,
  validateReferenceAssetResponse,
} from './asset-cache';
import { currentAccount } from './account';
let local = false;
let handler: ((url: URL, init?: RequestInit) => Promise<Response | null>) | null = null;
let generation = 0;
export const assetWorkspaceGeneration = () => generation;
function createWorkspaceAssets(cacheScope?: string) {
  return createAssetResolver({
    local: async () => null,
    remote: (input, init) =>
      mapSourceRequest(input).version ? fetchVersionedAsset(input, init) : rawWorkspaceFetch(input, init),
    key: referenceAssetCacheKey,
    validate: validateReferenceAssetResponse,
    cache: browserAssetCache(async () => {
      if (cacheScope) return cacheScope;
      const account = await currentAccount();
      return 'user' in account
        ? `member:${account.user.id}`
        : account.accounts === 'open' && !account.offline
          ? 'open-server'
          : 'device';
    }),
  });
}
let assets = createWorkspaceAssets();

export const isLocalWorkspace = (): boolean => local;

export function configureWorkspace(localOnly: boolean, request: NonNullable<typeof handler>, scope?: string): void {
  reportImportedAssetReplacements([]);
  clearAssetCatalogue();
  assets.clear();
  generation++;
  assets = createWorkspaceAssets(scope);
  local = localOnly;
  handler = request;
}

export async function workspaceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const replacement = await fetchRuntimeAssetReplacement(
    input,
    init,
    (request, options) => assets.fetch(request, options),
    resolvePropCrowdFrames,
  );
  if (replacement) return replacement;
  return exactWorkspaceFetch(input, init);
}

/** Identity checks/migrations must observe saved bytes, even while the renderer uses a compatible view. */
export async function exactWorkspaceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (referenceAssetRequest(input)) return assets.fetch(input, init);
  if (mapSourceRequest(input).version) return fetchVersionedAsset(input, init);
  return rawWorkspaceFetch(input, init);
}

async function rawWorkspaceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, source, explicit } = mapSourceRequest(input);
  const sameOrigin = url.origin === (globalThis.location?.origin ?? url.origin);
  if (sameOrigin && url.pathname.startsWith('/api/') && handler) {
    if (referenceAssetRequest(input) && !source && url.searchParams.get('level')) {
      const candidate = new URL(url);
      candidate.searchParams.set('mapSource', 'local');
      const localResponse = await handler(candidate, init);
      if (
        localResponse &&
        localResponse.status !== 404 &&
        (!localResponse.ok || (await validateReferenceAssetResponse(input, localResponse)))
      )
        return localResponse;
      candidate.searchParams.set('mapSource', 'server');
      const remoteResponse = await handler(candidate, init);
      if (local && localResponse?.status === 404 && (!remoteResponse || remoteResponse.status === 403))
        return localResponse;
      if (local && !remoteResponse)
        return Response.json({ error: 'Server assets are unavailable in this workspace.' }, { status: 403 });
      return remoteResponse ?? fetch(candidate, init);
    }
    const response = await handler(url, init);
    if (response) return response;
    if (local)
      return Response.json({ error: 'This feature requires a server workspace. Sign in to use it.' }, { status: 403 });
  }
  if (source === 'local' && sameOrigin && url.pathname.startsWith('/api/'))
    return Response.json({ error: 'This local map is not available on this device.' }, { status: 404 });
  return fetch(explicit ? (input instanceof Request ? new Request(url, input) : url) : input, init);
}

configureAssetTransport(rawWorkspaceFetch);
