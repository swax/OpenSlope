/** Stable identity for this browser tab. It scopes both project revisions and project-owned asset requests. */
const CLIENT_ID_KEY = 'slopesmith.clientId';

export const clientId = (() => {
  const fresh = () => `tab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  try {
    const stored = sessionStorage.getItem(CLIENT_ID_KEY);
    if (stored) return stored;
    const minted = fresh();
    sessionStorage.setItem(CLIENT_ID_KEY, minted);
    return minted;
  } catch { return fresh(); }
})();

let activeProjectId = '';

/** Project sync calls this before rendering a snapshot, making immutable asset URLs project-specific too. */
export function setClientProjectId(id: string | null | undefined): void {
  activeProjectId = id?.trim() ?? '';
}

/** Fetch an API resource as this tab. JSON and upload requests can carry the identity as a header. */
export function clientFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('x-slopesmith-client', clientId);
  return fetch(input, { ...init, headers });
}

/**
 * Image/audio/model loaders cannot attach headers, so an authored asset names its mountain in the URL. Once
 * a project is active, its durable id is sufficient and gives every tab the same browser-cache key. The
 * temporary client id is only the bootstrap fallback before project sync has supplied that id.
 */
export function clientAssetUrl(url: string): string {
  const hashAt = url.indexOf('#');
  const base = hashAt < 0 ? url : url.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const scope = activeProjectId
    ? `project=${encodeURIComponent(activeProjectId)}`
    : `client=${encodeURIComponent(clientId)}`;
  return `${base}${base.includes('?') ? '&' : '?'}${scope}${hash}`;
}
