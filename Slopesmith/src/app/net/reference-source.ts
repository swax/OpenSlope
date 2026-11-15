/** A read-only map supplies the same requests whether it lives in Maps or editable storage. */
export interface ReferenceMapSource {
  id: string;
  read(url: URL): Promise<Response>;
  dispose(): void;
}

const sources = new Map<string, ReferenceMapSource>();
const editableId = /^(local|server):@project:/;

function requestedSource(input: RequestInfo | URL): { url: URL; id: string } | null {
  const url = new URL(
    input instanceof Request ? input.url : input.toString(),
    globalThis.location?.origin ?? 'http://localhost',
  );
  if (url.origin !== (globalThis.location?.origin ?? 'http://localhost') || !url.pathname.startsWith('/api/'))
    return null;
  let id = url.searchParams.get(url.pathname === '/api/level' ? 'name' : 'level') ?? '';
  const source = url.searchParams.get('mapSource');
  if (id.startsWith('@project:') && (source === 'local' || source === 'server')) id = `${source}:${id}`;
  return editableId.test(id) ? { url, id } : null;
}

export const isEditableReferenceRequest = (input: RequestInfo | URL): boolean => requestedSource(input) !== null;

export function installReferenceSource(source: ReferenceMapSource): () => void {
  const previous = sources.get(source.id);
  previous?.dispose();
  sources.set(source.id, source);
  return () => {
    if (sources.get(source.id) === source) sources.delete(source.id);
    source.dispose();
  };
}

/** Folder requests continue through the ordinary workspace transport. Editable snapshots never fall through. */
export function readReferenceSource(input: RequestInfo | URL, init?: RequestInit): Promise<Response> | null {
  const selected = requestedSource(input);
  if (!selected) return null;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (method !== 'GET')
    return Promise.resolve(Response.json({ error: 'Reference maps are read-only.' }, { status: 405 }));
  return (
    sources.get(selected.id)?.read(selected.url) ??
    Promise.resolve(Response.json({ error: 'This editable reference is no longer loaded.' }, { status: 404 }))
  );
}
