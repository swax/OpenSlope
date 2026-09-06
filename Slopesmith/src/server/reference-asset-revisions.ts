import { contentRevision } from './response-cache';

/**
 * Content revisions needed before the browser asks for the bytes themselves.
 *
 * Metadata routes publish these digests into texture/sky URLs. The real byte response independently derives
 * its ETag and grants `immutable` only when the two agree, so this cache is a performance aid rather than a
 * trust boundary. The maps watcher clears it whenever extracted input changes.
 */
const revisions = new Map<string, Promise<string>>();

export function referenceAssetRevision(key: string, read: () => Promise<Buffer>): Promise<string> {
  let pending = revisions.get(key);
  if (!pending) {
    pending = read().then(contentRevision);
    revisions.set(key, pending);
    void pending.catch(() => { if (revisions.get(key) === pending) revisions.delete(key); });
  }
  return pending;
}

export function clearReferenceAssetRevisions(): void {
  revisions.clear();
}
