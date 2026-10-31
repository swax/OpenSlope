export interface MusicManifest {
  Version: number;
  Key: string;
  Bytes: number;
  Files: { Path: string; Bytes: number; Hash: string }[];
}
export interface MusicFile {
  path: string;
  blob: Blob;
}
interface Entry {
  key: string;
  generation: string;
  manifest: MusicManifest;
  touched: number;
}
const LIMIT = 2 * 1024 ** 3;
const databaseName = 'slopesmith-import-music';
const hex = (value: string) => /^[a-f0-9]{64}$/.test(value);
export const safeMusicPath = (path: string): boolean =>
  typeof path === 'string' &&
  !!path &&
  !path.includes('\\') &&
  !path.includes('\0') &&
  path.split('/').every(part => !!part && part !== '.' && part !== '..' && !part.includes(':'));

function valid(manifest: MusicManifest): boolean {
  return (
    manifest?.Version === 1 &&
    hex(manifest.Key) &&
    Number.isSafeInteger(manifest.Bytes) &&
    manifest.Bytes > 0 &&
    manifest.Bytes <= 512 * 1024 ** 2 &&
    Array.isArray(manifest.Files) &&
    manifest.Files.length > 0 &&
    manifest.Files.length <= 4096 &&
    new Set(manifest.Files.map(file => file.Path)).size === manifest.Files.length &&
    manifest.Files.every(
      file =>
        safeMusicPath(file.Path) &&
        hex(file.Hash) &&
        Number.isSafeInteger(file.Bytes) &&
        file.Bytes >= 0 &&
        file.Bytes <= 64 * 1024 ** 2,
    ) &&
    manifest.Files.reduce((total, file) => total + file.Bytes, 0) === manifest.Bytes
  );
}
const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
const commit = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? new Error('Music cache write failed.'));
  });
function removeGeneration(store: IDBObjectStore, generation: string) {
  const rows = store.index('generation').openKeyCursor(generation);
  rows.onsuccess = () => {
    const row = rows.result;
    if (row) {
      store.delete(row.primaryKey);
      row.continue();
    }
  };
}
export async function openMusicCache() {
  const opening = indexedDB.open(databaseName, 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore('entries', { keyPath: 'key' });
    db.createObjectStore('pending', { keyPath: 'generation' });
    db.createObjectStore('files', { keyPath: 'key' }).createIndex('generation', 'generation');
  };
  const db = await request(opening);
  db.onversionchange = () => db.close();
  const prune = async (needed: number, keep: string) => {
    const read = db.transaction(['entries', 'pending'], 'readonly');
    const [entries, pending] = await Promise.all([
      request(read.objectStore('entries').getAll()) as Promise<Entry[]>,
      request(read.objectStore('pending').getAll()) as Promise<{ generation: string; started: number }[]>,
    ]);
    let total = entries.reduce((sum, entry) => sum + entry.manifest.Bytes, 0);
    const remove: Entry[] = [];
    for (const entry of entries.sort((a, b) => a.touched - b.touched)) {
      if (total + needed <= LIMIT && entries.length - remove.length < 128) break;
      if (entry.key !== keep) {
        remove.push(entry);
        total -= entry.manifest.Bytes;
      }
    }
    const expired = pending.filter(entry => entry.started < Date.now() - 3600_000);
    if (!remove.length && !expired.length) return;
    const tx = db.transaction(['entries', 'files', 'pending'], 'readwrite');
    const finished = commit(tx);
    for (const entry of remove) {
      const query = tx.objectStore('entries').get(entry.key);
      query.onsuccess = () => {
        if (query.result?.generation === entry.generation) {
          tx.objectStore('entries').delete(entry.key);
          removeGeneration(tx.objectStore('files'), entry.generation);
        }
      };
    }
    for (const entry of expired) {
      tx.objectStore('pending').delete(entry.generation);
      removeGeneration(tx.objectStore('files'), entry.generation);
    }
    await finished;
  };
  return {
    async load(key: string): Promise<{ manifest: MusicManifest; files: MusicFile[] } | undefined> {
      if (!hex(key)) return;
      const tx = db.transaction(['entries', 'files'], 'readonly');
      const entry = (await request(tx.objectStore('entries').get(key))) as Entry | undefined;
      if (!entry || !valid(entry.manifest) || entry.manifest.Key !== key) return;
      const rows = (await request(tx.objectStore('files').index('generation').getAll(entry.generation))) as MusicFile[];
      const files = new Map(rows.map(row => [row.path, row.blob]));
      if (
        rows.length !== entry.manifest.Files.length ||
        entry.manifest.Files.some(file => files.get(file.Path)?.size !== file.Bytes)
      )
        return;
      const touch = db.transaction('entries', 'readwrite');
      // Re-read before touching so another tab's newer publication cannot be replaced.
      const query = touch.objectStore('entries').get(key);
      query.onsuccess = () => {
        if (query.result?.generation === entry.generation)
          touch.objectStore('entries').put({ ...entry, touched: Date.now() });
      };
      return { manifest: entry.manifest, files: rows };
    },
    async save(manifest: MusicManifest, files: MusicFile[]) {
      if (!valid(manifest) || files.length !== manifest.Files.length) return;
      const byPath = new Map(files.map(file => [file.path, file.blob]));
      if (manifest.Files.some(file => byPath.get(file.Path)?.size !== file.Bytes)) return;
      await prune(manifest.Bytes, manifest.Key);
      const generation = crypto.randomUUID();
      const start = db.transaction('pending', 'readwrite');
      const started = commit(start);
      start.objectStore('pending').put({ generation, started: Date.now() });
      await started;
      try {
        let batch: MusicFile[] = [],
          bytes = 0;
        const flush = async () => {
          if (!batch.length) return;
          const tx = db.transaction('files', 'readwrite'),
            finished = commit(tx);
          for (const file of batch)
            tx.objectStore('files').put({ ...file, key: `${generation}/${file.path}`, generation });
          await finished;
          batch = [];
          bytes = 0;
        };
        for (const file of files) {
          batch.push(file);
          bytes += file.blob.size;
          if (batch.length >= 64 || bytes >= 8 * 1024 ** 2) await flush();
        }
        await flush();
        const tx = db.transaction(['entries', 'files', 'pending'], 'readwrite'),
          finished = commit(tx);
        const store = tx.objectStore('entries'),
          old = store.get(manifest.Key);
        old.onsuccess = () => {
          if (old.result) removeGeneration(tx.objectStore('files'), old.result.generation);
        };
        store.put({ key: manifest.Key, generation, manifest, touched: Date.now() } satisfies Entry);
        tx.objectStore('pending').delete(generation);
        await finished;
      } catch (error) {
        const tx = db.transaction(['files', 'pending'], 'readwrite'),
          finished = commit(tx);
        removeGeneration(tx.objectStore('files'), generation);
        tx.objectStore('pending').delete(generation);
        await finished.catch(() => {});
        throw error;
      }
    },
    close: () => db.close(),
  };
}
export async function clearMusicCache(): Promise<void> {
  const opening = indexedDB.open(databaseName, 1);
  opening.onupgradeneeded = () => {
    opening.transaction!.abort();
  };
  let db: IDBDatabase;
  try {
    db = await request(opening);
  } catch {
    return;
  }
  try {
    const tx = db.transaction(['entries', 'files', 'pending'], 'readwrite'),
      finished = commit(tx);
    for (const name of ['entries', 'files', 'pending']) tx.objectStore(name).clear();
    await finished;
  } finally {
    db.close();
  }
}
