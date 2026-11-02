/** One byte transport for preview, playback and export. Only immutable identities survive a request. */
export interface AssetCache {
  get(key: string): Promise<Response | undefined>;
  put(key: string, response: Response, bytes: number): Promise<void>;
}

export interface AssetResolverOptions {
  local(input: RequestInfo | URL, init?: RequestInit): Promise<Response | null>;
  remote(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  cache?: AssetCache;
  key(input: RequestInfo | URL): string | undefined;
  maxBytes?: number;
  validate?(input: RequestInfo | URL, response: Response): Promise<boolean>;
}

export function createAssetResolver(options: AssetResolverOptions) {
  const memory = new Map<string, { bytes: ArrayBuffer; headers: Headers; status: number }>();
  const pending = new Map<string, Promise<Response>>();
  let size = 0;
  let generation = 0;
  const limit = options.maxBytes ?? 64 * 1024 * 1024;
  const valid = (input: RequestInfo | URL, response: Response) =>
    options.validate?.(input, response) ?? Promise.resolve(true);
  async function read(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const response = await options.local(input, init);
    // Local absence permits fallback. Authorization refusals and other errors keep their meaning.
    if (response && response.status !== 404 && (!response.ok || (await valid(input, response)))) return response;
    const remote = await options.remote(input, init);
    return !remote.ok || (await valid(input, remote))
      ? remote
      : Response.json({ error: 'Asset bytes do not match their content revision.' }, { status: 404 });
  }
  async function load(key: string, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const requestedGeneration = generation;
    const hit = memory.get(key);
    if (hit) {
      memory.delete(key);
      memory.set(key, hit);
      return new Response(hit.bytes.slice(0), { headers: hit.headers, status: hit.status });
    }
    const cached = await options.cache?.get(key).catch(() => undefined);
    const cacheValid = cached?.ok && (await valid(input, cached));
    const response = cacheValid ? cached : await read(input, init);
    if (response.status !== 200) return response;
    const bytes = await response.clone().arrayBuffer();
    if (requestedGeneration === generation && bytes.byteLength <= limit) {
      while ((size + bytes.byteLength > limit || memory.size >= 4096) && memory.size) {
        const oldest = memory.keys().next().value!;
        size -= memory.get(oldest)!.bytes.byteLength;
        memory.delete(oldest);
      }
      memory.set(key, { bytes, headers: new Headers(response.headers), status: response.status });
      size += bytes.byteLength;
    }
    if (!cacheValid) await options.cache?.put(key, response.clone(), bytes.byteLength).catch(() => {});
    return response;
  }
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const key =
        method.toUpperCase() === 'GET' &&
        !init?.signal &&
        !(input instanceof Request) &&
        !headers.has('range') &&
        !headers.has('authorization') &&
        !['reload', 'no-store', 'no-cache'].includes(init?.cache ?? '')
          ? options.key(input)
          : undefined;
      if (!key) return read(input, init);
      let value = pending.get(key);
      if (!value) {
        value = load(key, input, init);
        pending.set(key, value);
        const active = value;
        void value
          .finally(() => {
            if (pending.get(key) === active) pending.delete(key);
          })
          .catch(() => {});
      }
      return (await value).clone();
    },
    clear() {
      generation++;
      memory.clear();
      pending.clear();
      size = 0;
    },
  };
}
