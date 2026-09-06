import { rmSync } from 'node:fs';

/**
 * Real-HTTP checks should fail instead of waiting forever if a route or teardown regression leaves the
 * service unable to answer. Thirty seconds is intentionally much wider than the normal request time, even
 * when the concurrent gate is busy.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Every test request opens its own connection, and none is pooled for the next one.
 *
 * These checks stand the service up IN THEIR OWN PROCESS, so a check that pauses between two requests pauses
 * the server too — and the pauses are real: building a `collisionLabMountain` fixture blocks the event loop
 * for seconds, and longer on a machine running six checks at once. Node's `server.keepAliveTimeout` is 5s, so
 * a fixture that takes longer than that leaves an idle socket the server is entitled to close. When the loop
 * resumes, `fetch` dispatches onto that socket before the overdue timer has run, the server closes it under
 * the request, and the check dies on `ECONNRESET` — as an uncaught rejection out of a top-level `await`, so it
 * takes the whole file's remaining checks with it and reports nothing about what it was testing.
 *
 * Tuning the client's own idle timeout cannot fix that: the request is dispatched in the tick the block ends,
 * before ANY timer fires, so the client cannot notice its socket went stale. Not keeping the socket is what
 * removes the race rather than narrowing it. A fresh loopback connection per request costs microseconds, and
 * these three checks make a few hundred between them.
 */
export const fetchForTest = (
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1] = {},
): ReturnType<typeof fetch> => {
  const headers = new Headers(init?.headers);
  headers.set('connection', 'close');
  return fetch(input, {
    ...init,
    headers,
    signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
};

/** Fail fixture setup at the request that broke, with the server's own explanation. */
export async function expectOk(
  pending: Response | Promise<Response>,
  label: string,
): Promise<Response> {
  const response = await pending;
  if (response.ok) return response;
  const body = await response.text();
  throw new Error(`${label}: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 500)}` : ''}`);
}

/**
 * Windows can retain a just-closed file-watcher handle for a few milliseconds. A bounded retry keeps that
 * OS bookkeeping race from turning an otherwise-passing integration check red.
 */
export const removeTestTree = (path: string): void => rmSync(path, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});
