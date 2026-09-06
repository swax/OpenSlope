import { beginRequestDiagnostic } from './diagnostics';

/**
 * Asset bytes, kept.
 *
 * The editor's ordinary loaders want pixels and audio buffers, so the bytes behind a `/api/texture` or a
 * `/api/effect-sound` are decoded, uploaded and dropped. An export wants the opposite: a painted tile ships
 * **verbatim**, because what a page must shrink to is a property of the disc being patched, and a decoded
 * canvas re-encoded to PNG is a different file — different palette, different filters, different bytes. So
 * the export asks for bytes here and never touches an `<img>`.
 *
 * The cache is keyed by URL, which is legitimate because a stored asset's name is its identity (docs/038): an
 * upload lands beside a name that is taken rather than over it, so a URL is a permanent address and the bytes
 * behind it are the same bytes tomorrow. Two exports in a session therefore read one copy, and the browser's
 * own HTTP cache covers the first.
 */

const cache = new Map<string, Promise<Uint8Array>>();

/** The bytes at `url`, fetched once. Refusals carry the route's own message — "no custom sound bell.wav" is
 *  the whole content of that response, and it is the part an author can act on. */
export function assetBytes(url: string): Promise<Uint8Array> {
  let pending = cache.get(url);
  if (!pending) {
    pending = fetchBytes(url);
    cache.set(url, pending);
    // A failed read must not become the permanent answer for this address.
    void pending.catch(() => { if (cache.get(url) === pending) cache.delete(url); });
  }
  return pending;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const trace = beginRequestDiagnostic(url);
  try {
    const response = await fetch(url);
    trace.headers(response);
    if (!response.ok) {
      const message = (await response.text().catch(() => '')).trim();
      throw new Error(message || `${response.status} ${response.statusText}`.trim());
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    trace.complete();
    return bytes;
  } catch (error) {
    trace.fail(error);
    throw error;
  }
}

/** Drop everything held. For a session that has finished with an export and would rather have the memory. */
export function forgetAssetBytes(): void {
  cache.clear();
}
