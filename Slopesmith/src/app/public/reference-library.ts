import type { ServerReference } from '../../shared/reference-transfer';
import { createReferenceUploadQueue } from './reference-upload-queue';
import { listServerReferences, uploadReference } from './reference-upload';

/** Shared reference state and one upload queue across the catalogue and embedded game importer. */
export function createReferenceLibrary() {
  let maps: ServerReference[] = [];
  let ready = false;
  let refreshing: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const refresh = (): Promise<void> => {
    refreshing ??= listServerReferences()
      .then(result => {
        maps = result.maps;
        ready = true;
        notify();
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };
  const uploads = createReferenceUploadQueue(async (course, music, signal, progress) => {
    try {
      const result = await uploadReference(course, music, signal, progress);
      maps = [...maps.filter(map => map.name !== result.name), result];
      return result;
    } finally {
      // Reconcile accepted requests whose response was lost, including cancellation races.
      await refresh().catch(() => {});
    }
  }, notify);
  return {
    get maps() {
      return maps;
    },
    get ready() {
      return ready;
    },
    uploads,
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
      uploads.dispose();
    },
  };
}

export type ReferenceLibrary = ReturnType<typeof createReferenceLibrary>;
