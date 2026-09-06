import { createLogger } from './log';

/** A shared asset catalogue changed on disk. Bytes keep immutable names; clients only need to refetch lists. */
export interface LibraryChange { scope: 'custom' | 'shared' }

const log = createLogger('library');

const listeners = new Set<(change: LibraryChange) => void>();
const pending = new Set<LibraryChange['scope']>();
let timer: ReturnType<typeof setTimeout> | null = null;

export function onLibraryChanged(listener: (change: LibraryChange) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Coalesce the several filesystem notifications one asset write commonly produces into one catalogue push. */
export function announceLibraryChanged(scope: string): void {
  pending.add(scope.toLowerCase() === 'shared' ? 'shared' : 'custom');
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    for (const held of pending) {
      const change: LibraryChange = { scope: held };
      for (const listener of listeners) {
        try { listener(change); }
        catch (error) { log.error('a change listener failed', { error }); }
      }
    }
    pending.clear();
  }, 50);
  timer.unref?.();
}
