export interface TerrainLightingCache {
  get(key: string): Promise<Float32Array | undefined>;
  put(key: string, values: Float32Array): Promise<void>;
}

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 64;
type Metadata = { key: string; bytes: number; used: number };

/** Optional, bounded derived data. Metadata is separate so eviction never reads every cached light buffer. */
export function createTerrainLightingCache(
  databaseName = 'slopesmith-terrain-lighting',
  maxBytes = MAX_BYTES,
): TerrainLightingCache {
  let opening: Promise<IDBDatabase | undefined> | undefined;
  function open() {
    opening ??= new Promise<IDBDatabase | undefined>(resolve => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(undefined);
        const request = indexedDB.open(databaseName, 1);
        let unavailable = false;
        request.onupgradeneeded = () => {
          request.result.createObjectStore('buffers', { keyPath: 'key' });
          request.result.createObjectStore('metadata', { keyPath: 'key' });
        };
        request.onerror = request.onblocked = () => {
          unavailable = true;
          resolve(undefined);
        };
        request.onsuccess = () => {
          const db = request.result;
          if (unavailable) return db.close();
          db.onversionchange = () => {
            db.close();
            opening = undefined;
          };
          resolve(db);
        };
      } catch {
        resolve(undefined);
      }
    });
    return opening;
  }
  return {
    async get(key) {
      const db = await open();
      if (!db) return;
      return new Promise<Float32Array | undefined>(resolve => {
        try {
          const tx = db.transaction(['buffers', 'metadata'], 'readwrite');
          const request = tx.objectStore('buffers').get(key);
          let values: Float32Array | undefined;
          request.onsuccess = () => {
            if (!(request.result?.values instanceof Float32Array)) return;
            values = request.result.values;
            tx.objectStore('metadata').put({ key, bytes: values!.byteLength, used: Date.now() });
          };
          tx.oncomplete = () => resolve(values);
          tx.onerror = tx.onabort = () => resolve(undefined);
        } catch {
          resolve(undefined);
        }
      });
    },
    async put(key, values) {
      if (values.byteLength > maxBytes) return;
      const db = await open();
      if (!db) return;
      await new Promise<void>(resolve => {
        try {
          const tx = db.transaction(['buffers', 'metadata'], 'readwrite');
          const buffers = tx.objectStore('buffers'),
            metadata = tx.objectStore('metadata');
          const request = metadata.getAll();
          request.onsuccess = () => {
            const rows = (request.result as Metadata[]).filter(row => row.key !== key);
            rows.sort((a, b) => a.used - b.used);
            let bytes = rows.reduce((total, row) => total + row.bytes, values.byteLength);
            while (rows.length && (bytes > maxBytes || rows.length >= MAX_ENTRIES)) {
              const oldest = rows.shift()!;
              bytes -= oldest.bytes;
              buffers.delete(oldest.key);
              metadata.delete(oldest.key);
            }
            buffers.put({ key, values });
            metadata.put({ key, bytes: values.byteLength, used: Date.now() });
          };
          tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
        } catch {
          resolve();
        }
      });
    },
  };
}
