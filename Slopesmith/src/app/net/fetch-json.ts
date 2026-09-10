import { beginRequestDiagnostic } from './diagnostics';
import { clientFetch } from './client';
import { renderRequest } from '../state/capture-progress';

/** Fetch and decode JSON, rejecting HTTP failures before callers consume a misleading error payload. */
export async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const trace = beginRequestDiagnostic(input, init);
  const finishRenderRequest = renderRequest(input, init);
  try {
    const response = await clientFetch(input, init);
    trace.headers(response);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`.trim());
    const body = await response.json() as T;
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
    try { body = JSON.parse(text); } catch { /* not JSON — fall back to the status line below */ }
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
