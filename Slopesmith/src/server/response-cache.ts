import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { createLogger } from './log';

// zlib's callback forms hand the work to libuv's thread pool; the `…Sync` twins run it on the event loop.
// A props payload is megabytes, so compressing one synchronously stalls every other client for its duration.
const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);
const log = createLogger('response-cache');

type CachedResponse = {
  raw: Buffer;
  gzip?: Buffer | null;
  brotli?: Buffer | null;
  encodingJobs: Map<Encoding, Promise<Buffer | null>>;
  etag: string;
  contentType: string;
  cacheControl: ResponseCacheControl;
};

type Producer<T> = () => T | Promise<T>;
type Encoding = 'gzip' | 'br';

/** A fixed policy, or one resolved after the content-derived ETag exists. The latter lets a `?v=<digest>`
 * request become immutable only when its URL really names the bytes being returned. */
export type ResponseCacheControl = string | ((req: IncomingMessage, etag: string) => string);

/** The URL-safe content identity used by both response ETags and versioned client asset URLs. */
export function contentRevision(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64url');
}

export interface ResponseCacheStats {
  entries: number;
  bytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  gzipBuilds: number;
  brotliBuilds: number;
}

/** Generated API responses are expensive (notably props OBJ parsing and stitched sky panoramas). Cache the
 * in-flight build, serialized bytes, requested compressed variants, and ETag together. The service's maps watch
 * (`api/maps-watch.ts`) clears the affected entries when Maps changes, so a validator always names the current
 * extracted revision. */
export class ResponseCache {
  private entries = new Map<string, Promise<CachedResponse>>();
  private sizes = new Map<string, number>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private gzipBuilds = 0;
  private brotliBuilds = 0;

  constructor(private readonly maxBytes = 256 * 1024 * 1024) {}

  clear() { this.entries.clear(); this.sizes.clear(); this.totalBytes = 0; }

  stats(): ResponseCacheStats {
    return {
      entries: this.entries.size,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      gzipBuilds: this.gzipBuilds,
      brotliBuilds: this.brotliBuilds,
    };
  }

  /** Drop only generated responses derived from a changed source. In-flight producers are safely detached:
   * their size callback already checks that the same promise is still installed before accounting its bytes. */
  invalidate(predicate: (key: string) => boolean): number {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (!predicate(key)) continue;
      this.entries.delete(key);
      const bytes = this.sizes.get(key);
      if (bytes !== undefined) this.totalBytes -= bytes;
      this.sizes.delete(key);
      removed++;
    }
    return removed;
  }

  async json(req: IncomingMessage, res: ServerResponse, key: string, producer: Producer<unknown>) {
    return this.respond(req, res, `json:${key}`, 'application/json; charset=utf-8', 'private, no-cache', true,
      async () => Buffer.from(JSON.stringify(await producer())));
  }

  /** A producer that has already serialized JSON — notably a worker-built props payload. */
  async jsonBytes(req: IncomingMessage, res: ServerResponse, key: string, producer: Producer<Buffer>) {
    return this.respond(req, res, `json:${key}`, 'application/json; charset=utf-8', 'private, no-cache', true,
      producer);
  }

  async bytes(req: IncomingMessage, res: ServerResponse, key: string, contentType: string,
    cacheControl: ResponseCacheControl, producer: Producer<Buffer>) {
    return this.respond(req, res, `bytes:${key}`, contentType, cacheControl, false, producer);
  }

  private async respond(req: IncomingMessage, res: ServerResponse, key: string, contentType: string,
    cacheControl: ResponseCacheControl, compress: boolean, producer: Producer<Buffer>) {
    const hit = this.entries.has(key);
    if (hit) this.hits++; else this.misses++;
    let pending = this.entries.get(key);
    if (!pending) {
      const created = (async (): Promise<CachedResponse> => {
        const raw = await producer();
        return {
          raw,
          encodingJobs: new Map(),
          etag: `"${contentRevision(raw)}"`,
          contentType,
          cacheControl,
        };
      })();
      pending = created;
      this.entries.set(key, created);
      void created.then(cached => this.recordSize(key, created, cached)).catch(() => {
        if (this.entries.get(key) === created) this.entries.delete(key);
      });
    } else {
      // Map insertion order is the LRU order. Refresh a hit without disturbing its shared promise.
      this.entries.delete(key);
      this.entries.set(key, pending);
    }
    const cached = await pending;
    res.setHeader('etag', cached.etag);
    res.setHeader('cache-control', typeof cached.cacheControl === 'string'
      ? cached.cacheControl : cached.cacheControl(req, cached.etag));
    res.setHeader('x-slopesmith-cache', hit ? 'hit' : 'miss');
    if (compress) res.setHeader('vary', 'Accept-Encoding');
    if (etagMatches(req.headers['if-none-match'], cached.etag)) {
      res.statusCode = 304;
      res.end();
      return;
    }
    const accepted = String(req.headers['accept-encoding'] ?? '');
    const wanted = compress && cached.raw.length >= 1024 ? preferredEncoding(accepted) : null;
    const encoded = wanted ? await this.encoded(key, pending, cached, wanted) : null;
    const body = encoded ?? cached.raw;
    const encoding = encoded ? wanted : null;
    res.setHeader('content-type', cached.contentType);
    res.setHeader('content-length', String(body.length));
    if (encoding) res.setHeader('content-encoding', encoding);
    if (req.method === 'HEAD') res.end(); else res.end(body);
  }

  /** Build only the representation this request can use. Concurrent requests share the same compression. */
  private encoded(key: string, owner: Promise<CachedResponse>, cached: CachedResponse,
    encoding: Encoding): Promise<Buffer | null> {
    const finished = encoding === 'br' ? cached.brotli : cached.gzip;
    if (finished !== undefined) return Promise.resolve(finished);
    const running = cached.encodingJobs.get(encoding);
    if (running) return running;

    if (encoding === 'br') this.brotliBuilds++; else this.gzipBuilds++;
    const created = (encoding === 'br'
      ? brotliAsync(cached.raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
      : gzipAsync(cached.raw, { level: 4 }))
      .catch(error => {
        log.warn(`${encoding} compression failed for ${key}`, { error });
        return null;
      })
      .then(value => {
        if (encoding === 'br') cached.brotli = value; else cached.gzip = value;
        cached.encodingJobs.delete(encoding);
        if (value) this.recordSize(key, owner, cached);
        return value;
      });
    cached.encodingJobs.set(encoding, created);
    return created;
  }

  private recordSize(key: string, pending: Promise<CachedResponse>, cached: CachedResponse) {
    if (this.entries.get(key) !== pending) return; // cleared or evicted while the producer was running
    const bytes = cached.raw.length + (cached.gzip?.length ?? 0) + (cached.brotli?.length ?? 0);
    this.totalBytes += bytes - (this.sizes.get(key) ?? 0);
    this.sizes.set(key, bytes);
    // Never evict the response currently being served. A single oversized response may temporarily exceed
    // the budget; the next completed entry can evict it once it is no longer the protected key.
    for (const candidate of this.entries.keys()) {
      if (this.totalBytes <= this.maxBytes) break;
      if (candidate === key) continue;
      const size = this.sizes.get(candidate);
      if (size == null) continue; // keep sharing an in-flight producer
      this.entries.delete(candidate);
      this.sizes.delete(candidate);
      this.totalBytes -= size;
      this.evictions++;
    }
  }
}

function preferredEncoding(header: string): Encoding | null {
  const br = encodingQuality(header, 'br'), gzip = encodingQuality(header, 'gzip');
  if (br > 0 && br >= gzip) return 'br';
  if (gzip > 0) return 'gzip';
  return null;
}

function encodingQuality(header: string, encoding: string): number {
  let wildcard = -1;
  for (const item of header.split(',')) {
    const [rawName, ...params] = item.trim().toLowerCase().split(';');
    const name = rawName.trim();
    const qText = params.map(value => value.trim()).find(value => value.startsWith('q='))?.slice(2);
    const quality = qText == null ? 1 : Math.max(0, Math.min(1, Number(qText) || 0));
    if (name === encoding) return quality;
    if (name === '*') wildcard = quality;
  }
  return wildcard < 0 ? 0 : wildcard;
}

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const target = etag.replace(/^W\//, '');
  return (Array.isArray(header) ? header.join(',') : header)
    .split(',')
    .some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === target);
}

export const responseCache = new ResponseCache();
