/** The editor can use a browser workspace in place of the authenticated API. */
let local = false;
let handler: ((url: URL, init?: RequestInit) => Promise<Response | null>) | null = null;

export const isLocalWorkspace = (): boolean => local;

export function configureWorkspace(localOnly: boolean, request: NonNullable<typeof handler>): void {
  local = localOnly;
  handler = request;
}

export async function workspaceFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!handler) return fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : input.toString(), location.origin);
  if (url.origin === location.origin && url.pathname.startsWith('/api/') && handler) {
    const response = await handler(url, init);
    if (response) return response;
    if (local)
      return Response.json({ error: 'This feature requires a server workspace. Sign in to use it.' }, { status: 403 });
  }
  return fetch(input, init);
}
