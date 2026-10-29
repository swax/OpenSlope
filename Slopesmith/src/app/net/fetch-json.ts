import { beginRequestDiagnostic } from './diagnostics';
import { clientFetch } from './client';
import { renderRequest } from '../state/capture-progress';
import { resolveAssetUrl } from './asset-paths';

export type DownloadProgress = { receivedBytes: number; totalBytes?: number };

/** Download without parsing so large prop payloads can arrive while terrain is being built. Fetch exposes
 * decompressed chunks; Content-Length is a usable total only for an uncompressed response. */
export async function fetchText(
  input: RequestInfo | URL,
  onProgress: (progress: DownloadProgress) => void,
): Promise<string> {
  const trace = beginRequestDiagnostic(input);
  const finishRenderRequest = renderRequest(input);
  try {
    const response = await clientFetch(typeof input === 'string' ? resolveAssetUrl(input) : input);
    trace.headers(response);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
    const encoding = response.headers.get('content-encoding');
    const length = Number(response.headers.get('content-length'));
    const totalBytes =
      (!encoding || encoding === 'identity') && Number.isFinite(length) && length > 0 ? length : undefined;
    let receivedBytes = 0;
    onProgress({ receivedBytes, totalBytes });
    const reader = response.body?.getReader();
    const parts: string[] = [];
    if (reader) {
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(decoder.decode(value, { stream: true }));
          receivedBytes += value.byteLength;
          onProgress({ receivedBytes, totalBytes });
        }
        parts.push(decoder.decode());
      } finally {
        reader.releaseLock();
      }
    }
    trace.complete();
    finishRenderRequest();
    return parts.join('');
  } catch (error) {
    trace.fail(error);
    finishRenderRequest(error);
    throw error;
  }
}

/** Fetch and decode JSON, rejecting HTTP failures before callers consume a misleading error payload. */
export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const trace = beginRequestDiagnostic(input, init);
  const finishRenderRequest = renderRequest(input, init);
  try {
    const response = await clientFetch(typeof input === 'string' ? resolveAssetUrl(input) : input, init);
    trace.headers(response);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
    const body = (await response.json()) as T;
    trace.complete();
    finishRenderRequest();
    return body;
  } catch (error) {
    trace.fail(error);
    finishRenderRequest(error);
    throw error;
  }
}

/**
 * POST a route whose arguments ride the query string — with an optional body for the ones that also carry
 * bytes — raising the server's own `{error}` message on refusal.
 *
 * `fetchJson` deliberately rejects on status alone, which is right when a failure is a failure. It is wrong
 * for routes that refuse on PURPOSE and explain why — "no custom texture snow.png" is the entire content of
 * that response, and turning it into "400 Bad Request" throws away the only part the author can act on.
 */
export async function postJson<T>(url: string, body?: BodyInit): Promise<T> {
  const init = { method: 'POST', ...(body === undefined ? {} : { body }) } satisfies RequestInit;
  const trace = beginRequestDiagnostic(url, init);
  try {
    const response = await clientFetch(url, init);
    trace.headers(response);
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON — fall back to the status line below */
    }
    if (!response.ok) {
      const message = (body as { error?: string } | undefined)?.error;
      throw new Error(message || `${response.status} ${response.statusText}`.trim());
    }
    trace.complete();
    return body as T;
  } catch (error) {
    trace.fail(error);
    throw error;
  }
}
