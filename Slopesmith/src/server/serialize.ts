/**
 * Run work one-at-a-time per key.
 *
 * Asynchronous I/O introduces interleaving that synchronous code could not have: between a read and the write
 * derived from it, another request now runs. For a read-modify-write over a shared file that is a lost update
 * — two clients each activating a project, one overwriting the other's entry — and for an export it is two
 * runs writing the same output folder at once.
 *
 * The queue is per key, so unrelated work never waits on unrelated work. It orders operations within one
 * process; it is not a cross-process file lock, which is the right scope because a single Slopesmith server
 * owns its workspace.
 */
const chains = new Map<string, Promise<unknown>>();

export function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  // Chain onto whatever is queued for this key, ignoring its outcome so one failure cannot poison the queue.
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.then(work, work);
  // Keep the map from growing without bound: the last link removes itself once nothing is waiting behind it.
  const tracked = next.catch(() => undefined).then(() => {
    if (chains.get(key) === tracked) chains.delete(key);
  });
  chains.set(key, tracked);
  return next;
}
