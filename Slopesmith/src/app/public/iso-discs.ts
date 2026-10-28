export const ISO_GAMES = [
  { id: 'tricky', name: 'SSX Tricky', support: 'Full support' },
  { id: 'ssx', name: 'SSX', support: 'Partial support' },
  { id: 'ssx3', name: 'SSX 3', support: 'Preliminary support' },
  { id: 'ontour', name: 'SSX On Tour', support: 'Preliminary support' },
  { id: 'avalanche', name: '1080° Avalanche', support: '25 course layouts · Preliminary support' },
  { id: 'madtrix', name: 'Jonny Moseley Mad Trix', support: '11 courses · Preliminary support' },
] as const;

export type IsoGame = (typeof ISO_GAMES)[number]['id'];
export interface SavedIsoDisc {
  game: IsoGame;
  file: File;
  courses: string[];
}

export function isoGameForCourse(course: string): IsoGame {
  if (/^MADTRIX_/i.test(course)) return 'madtrix';
  if (/^AVALANCHE_/i.test(course)) return 'avalanche';
  if (/^SSX_/i.test(course)) return 'ssx';
  if (/^SSX3_/i.test(course)) return 'ssx3';
  if (/^SSXOT_/i.test(course)) return 'ontour';
  return 'tricky';
}

/** Disc blobs stay in their own store so restoring a source never changes the extracted-map cache. */
function openDiscs(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('slopesmith-local-isos', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('discs', { keyPath: 'game' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Browser storage is unavailable.'));
  });
}

export async function savedIsoDiscs(): Promise<SavedIsoDisc[]> {
  const db = await openDiscs();
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('discs').objectStore('discs').getAll();
      request.onsuccess = () => resolve(request.result as SavedIsoDisc[]);
      request.onerror = () => reject(request.error);
    });
  } finally { db.close(); }
}

async function writeDiscs(run: (store: IDBObjectStore) => void, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const db = await openDiscs();
  try {
    signal?.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('discs', 'readwrite');
      const abort = () => transaction.abort();
      const finish = () => signal?.removeEventListener('abort', abort);
      signal?.addEventListener('abort', abort, { once: true });
      transaction.oncomplete = () => { finish(); resolve(); };
      transaction.onerror = transaction.onabort = () => {
        finish();
        reject(signal?.aborted ? signal.reason : transaction.error ?? new Error('The ISO could not be saved in this browser.'));
      };
      try { run(transaction.objectStore('discs')); }
      catch (error) { transaction.abort(); finish(); reject(error); }
    });
  } finally { db.close(); }
}

export async function saveIsoDisc(disc: SavedIsoDisc, signal?: AbortSignal): Promise<void> {
  await writeDiscs(store => store.put(disc), signal);
  void navigator.storage?.persist?.().catch(() => {});
}

export const clearSavedIsoDiscs = (): Promise<void> => writeDiscs(store => store.clear());
