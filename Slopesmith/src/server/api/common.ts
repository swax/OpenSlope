import type { IncomingMessage, ServerResponse } from 'node:http';
import { announceLibraryChanged } from '../library-events';
import { responseCache, type ResponseCacheControl } from '../response-cache';
import { currentProjectAssetScope } from '../project-assets';
import {
  FAL_GENERATION_HEADER, parseFalGenerationProvenance, type FalGenerationProvenance,
} from '../../core/paint/fal-models';

/** Process-lifecycle actions supplied by the service host. Tests and unsupervised hosts deliberately omit
 * restart, so an HTTP request can never assume that killing this process will bring another one back. */
export interface ApiControls {
  restart?: {
    /** Changes every time startup reconstructs the API service, including an in-process development restart. */
    instance: string;
    /** Claims the one restart slot and schedules it after the HTTP response has had time to flush. */
    request(): boolean;
  };
}

/** One route's handler. Route modules export a record of these keyed by mount path; `app.ts` picks the first
 * mount the request path sits under and hands the handler the remainder of the URL in `req.url`. */
export type ApiHandler = (
  req: IncomingMessage, res: ServerResponse, controls?: ApiControls,
) => void | Promise<void>;

/** What immutable authenticated asset byte routes send. A stored name is immutable, and a deleted one is
 * retired rather than handed to the next upload (docs/038), so the member's own browser can keep it without
 * revalidating. `private` is part of the authorization boundary: a shared proxy must never replay these bytes
 * to a caller whose request did not pass the account guard. */
export const CUSTOM_ASSET_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/** The compatibility policy for an older/unversioned client. It stays fresh for an hour, then revalidates. */
export const UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL = 'private, max-age=3600';

/** A reference URL is immutable only when its `v` parameter equals the content-derived ETag. This check is
 * made after the response cache has the bytes, so an absent, stale or invented revision cannot pin new bytes
 * behind the wrong permanent URL. */
export function referenceAssetCacheControl(expectedRevision?: string) {
  return ((req, etag) => {
    const requested = new URL(req.url ?? '/', 'http://localhost').searchParams.get('v');
    return requested === (expectedRevision ?? etag.slice(1, -1))
      ? CUSTOM_ASSET_CACHE_CONTROL : UNVERSIONED_REFERENCE_ASSET_CACHE_CONTROL;
  }) satisfies ResponseCacheControl;
}

/** Most reference byte URLs use the response bytes' own digest. Derived assets may instead pass a digest of
 * all deterministic source bytes through `referenceAssetCacheControl(revision)`. */
export const REFERENCE_ASSET_CACHE_CONTROL = referenceAssetCacheControl();

export class RequestBodyTooLargeError extends Error {
  readonly statusCode = 413;

  constructor(public readonly maxBytes: number) {
    super(`request exceeds ${Math.round(maxBytes / 1024 / 1024)} MB`);
  }
}

/** Read a request without allowing one connection to grow the process heap without bound. An oversized body
 * keeps draining from the socket, but its retained chunks are released as soon as the limit is crossed. */
export async function readBody(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<Buffer> {
  return await new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      received += chunk.length;
      if (received > maxBytes) {
        settled = true;
        chunks.length = 0;
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks, received));
    });
    req.on('error', error => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(error);
    });
  });
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 32 * 1024 * 1024): Promise<unknown> {
  return JSON.parse((await readBody(req, maxBytes)).toString('utf8'));
}

/** Read the optional provenance snapshot attached when a fal-generated PNG enters a project. A malformed
 * header is refused rather than silently dropping the archive the user was told would be retained. */
export function readFalGenerationHeader(req: IncomingMessage): FalGenerationProvenance | undefined {
  const header = req.headers[FAL_GENERATION_HEADER];
  if (header === undefined) return undefined;
  if (Array.isArray(header) || header.length > 16_000) throw new Error('generation provenance header is invalid');
  let value: unknown;
  try { value = JSON.parse(header); }
  catch { throw new Error('generation provenance header is invalid'); }
  const generation = parseFalGenerationProvenance(value);
  if (!generation) throw new Error('generation provenance header is invalid');
  return generation;
}

export function jsonResponse(res: ServerResponse, status: number, value: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}

const REFERENCE_CATALOG_CACHE_KEYS = new Set([
  'json:levels', 'json:texture-levels', 'json:prop-levels', 'json:skybox',
  // Library-wide answers an export composes against: every level's material table, and which level supplies
  // the native rail/gem art. Both change when any one level does.
  'json:prop-materials', 'json:prop-native-art',
  // The comparison table prices every mountain in one answer, so any one of them changing restates it.
  'json:level-census',
]);

/**
 * Drop every cached census answer — the library table and each mountain's own row alike.
 *
 * Both have to go together. A re-measure that replaced the library answer while `json:level-census:GARI` went
 * on serving the old numbers would leave the comparison dialog and the Reference panel's cost rows disagreeing
 * about the same mountain, which is precisely the state a manual refresh exists to get out of.
 */
export function invalidateCensus(): void {
  responseCache.invalidate(key => {
    const candidate = key.toLowerCase();
    return candidate === 'json:level-census' || candidate.startsWith('json:level-census:');
  });
}

/** Invalidate one extracted/authored level without throwing away expensive responses for unrelated mountains. */
export function invalidateReferenceLevel(level: string): void {
  const name = level.toLowerCase();
  const exact = new Set([
    `json:level:${name}`, `json:level-census:${name}`, `json:effects:${name}`, `json:reference-music:${name}`,
    `json:lightrig:${name}`, `json:textures:${name}`, `json:props:${name}`, `json:groups:${name}`,
    `bytes:skypano:level:${name}`, `bytes:skyground:level:${name}`,
  ]);
  const prefixes = [
    `json:reference-music:${name}:`, `bytes:reference-music-sample:${name}:`,
    `bytes:reference-intro-music:${name}:`,
    `bytes:effect-sound:${name}:`, `bytes:lightmap:${name}:`, `bytes:texture:${name}:`,
    `bytes:particle-texture:${name}:`, `json:physics-body:${name}:`, `bytes:sky-page:${name}:`,
    // Every cached ring, whatever was asked for: an unqualified request resolves to the first level shipping
    // a sky, so a level appearing or leaving can change the answer to a question that never named it.
    'json:sky-ring:',
  ];
  responseCache.invalidate(key => {
    const candidate = key.toLowerCase();
    return REFERENCE_CATALOG_CACHE_KEYS.has(candidate) || exact.has(candidate)
      || prefixes.some(prefix => candidate.startsWith(prefix));
  });
}

/**
 * Invalidate only the authored catalogue of the mountain bound to this request. The event is broadcast so
 * collaborators on that mountain refresh; editors on other mountains harmlessly reload their own scope.
 *
 * The kind prefix has to come off first. `ResponseCache` files an entry under `json:` or `bytes:` plus the
 * key it was given, while `projectAssetCacheKey` produces the key WITHOUT that prefix — so a scope test
 * against the stored key matched nothing, and every import, rename, replace and delete left the previous
 * catalogue in the cache. That failure was invisible in the obvious way and vicious in the real one: the
 * response is `private, no-cache` with an ETag, so the stale entry went on answering 304 to every
 * revalidation and only a server restart could clear it.
 */
export function invalidateProjectLibrary(): void {
  const scope = currentProjectAssetScope().toLowerCase();
  responseCache.invalidate(key => key.toLowerCase().replace(RESPONSE_KIND, '').startsWith(scope));
  announceLibraryChanged('custom');
}

/** The prefix `ResponseCache` files an entry under, which a logical asset key never carries. */
const RESPONSE_KIND = /^(?:json|bytes):/;

/** Server-wide libraries (currently rider avatars) still should not evict cached retail mountains. */
export function invalidateSharedLibrary(scope: string): void {
  const sharedSky = scope.toLowerCase() === 'shared';
  const exact = sharedSky
    ? new Set(['json:skybox'])
    : new Set(['json:characters']);
  const prefixes = sharedSky
    ? ['bytes:skypano:custom:', 'bytes:skyground:custom:']
    : ['bytes:character-model:'];
  responseCache.invalidate(key => {
    const candidate = key.toLowerCase();
    return exact.has(candidate) || prefixes.some(prefix => candidate.startsWith(prefix));
  });
  announceLibraryChanged(scope);
}
