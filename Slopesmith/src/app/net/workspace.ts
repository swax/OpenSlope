/** The editor can use a browser workspace in place of the authenticated API. */
import { mapSourceRequest } from './map-source';
import { clearAssetCatalogue, configureAssetTransport, fetchVersionedAsset } from './asset-versions';
let local = false;
let handler: ((url: URL, init?: RequestInit) => Promise<Response | null>) | null = null;

export const isLocalWorkspace = (): boolean => local;

export function configureWorkspace(localOnly: boolean, request: NonNullable<typeof handler>): void {
  clearAssetCatalogue();
  local = localOnly;
  handler = request;
}

export async function workspaceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (mapSourceRequest(input).version) return fetchVersionedAsset(input, init);
  return rawWorkspaceFetch(input, init);
}

async function rawWorkspaceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, source, explicit } = mapSourceRequest(input);
  const sameOrigin = url.origin === (globalThis.location?.origin ?? url.origin);
  if (sameOrigin && url.pathname.startsWith('/api/') && handler) {
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
