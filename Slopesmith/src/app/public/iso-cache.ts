import {
  canonicalDiscCourse,
  normalizeMapDisplayName,
  registerDiscCourseNames,
} from '../../core/reference/disc-courses';
import { normalizeCourseLayout, registerCourseLayouts, type CourseLayout } from '../../core/reference/course-layout';
import { createIsoImportSessions } from './iso-import-sessions';
import { clearMusicCache } from './iso-music-cache';

export const ISO_CACHE_VERSION = 1;
// Avalanche generation 3 adds source RGB terrain lighting and baked shadows.
export const isoCourseCacheVersion = (course: string): number =>
  /^SSXGBA_/i.test(course)
    ? 2
    : /^AVALANCHE_/i.test(course)
      ? 3
      : /^MADTRIX_/i.test(course)
        ? 8
        : /^SSXOT_.*_NIGHT$/i.test(course)
          ? 8
          : /^(SSX3_|SSXOT_)/i.test(course)
            ? 7
            : /^SSX_/i.test(course)
              ? 3
              : ISO_CACHE_VERSION;
interface CachedFile {
  key: string;
  course: string;
  path: string;
  blob: Blob;
}
interface CachedCourse {
  course: string;
  version: number;
  files: number;
  displayName?: string;
  layout?: CourseLayout;
}
export interface DiscCollisionSounds {
  SourceExecutable: string;
  CollisionEvents: Record<string, { Group: number; Slot: number }>;
}
interface CachedSoundIndex {
  Banks: Record<string, string>;
  ResolverState?: string;
  SourceExecutable?: string;
  CollisionEvents: Record<string, { Group: number; Slot: number; Bank: string; Clip: string }>;
}

function cachedSoundFile(db: IDBDatabase, course: string): Promise<CachedFile | undefined> {
  return new Promise((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').get(`${course}/audio/soundindex.json`);
    request.onsuccess = () => resolve(request.result as CachedFile | undefined);
    request.onerror = () => reject(request.error);
  });
}
/** Only Tricky's executable collision routing can currently repair older caches. */
export const supportsCollisionSoundUpdate = (course: string): boolean =>
  !/^(SSXGBA_|SSX_|SSX3_|SSXOT_|AVALANCHE_|MADTRIX_)/i.test(course);

export async function needsCollisionSoundUpdate(courses: string[]): Promise<boolean> {
  const db = await openIsoCache();
  try {
    for (const course of courses.filter(supportsCollisionSoundUpdate)) {
      const row = await cachedSoundFile(db, course);
      if (row && (JSON.parse(await row.blob.text()) as CachedSoundIndex).ResolverState === 'Deferred') return true;
    }
    return false;
  } finally {
    db.close();
  }
}
/** Older caches already contain the WAVs. Repair only their missing event lookup from the selected ISO. */
export async function updateCachedCollisionSounds(
  db: IDBDatabase,
  courses: string[],
  sounds: DiscCollisionSounds,
): Promise<void> {
  if (!sounds.SourceExecutable) return;
  for (const course of courses.filter(supportsCollisionSoundUpdate)) {
    const row = await cachedSoundFile(db, course);
    if (!row) continue;
    const index = JSON.parse(await row.blob.text()) as CachedSoundIndex;
    if (index.ResolverState !== 'Deferred') continue;
    index.CollisionEvents = {};
    for (const [event, route] of Object.entries(sounds.CollisionEvents)) {
      const bank = index.Banks[String(route.Group)];
      if (bank)
        index.CollisionEvents[event] = {
          ...route,
          Bank: bank,
          Clip: `Audio/SFX/${bank}/${String(route.Slot).padStart(3, '0')}.wav`,
        };
    }
    index.SourceExecutable = sounds.SourceExecutable;
    index.ResolverState = 'Resolved';
    const blob = new Blob([JSON.stringify(index)], { type: 'application/json' });
    await cacheTransaction(db, 'files', 'readwrite', store => store.put({ ...row, blob }));
  }
}

export function openIsoCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('slopesmith-local-disc', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const files = db.createObjectStore('files', { keyPath: 'key' });
      files.createIndex('course', 'course');
      db.createObjectStore('courses', { keyPath: 'course' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Browser storage is unavailable.'));
  });
}
export async function cacheTransaction(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    run(transaction.objectStore(store));
    transaction.oncomplete = () => resolve();
    transaction.onerror = transaction.onabort = () =>
      reject(transaction.error ?? new Error('Browser storage is full or unavailable.'));
  });
}
function getAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}
export async function cachedIsoCourses(): Promise<string[]> {
  const db = await openIsoCache();
  try {
    const rows = (await getAll<CachedCourse>(db, 'courses')).filter(
      row => row.version === isoCourseCacheVersion(row.course),
    );
    registerDiscCourseNames(Object.fromEntries(rows.map(row => [row.course, row.displayName])));
    registerCourseLayouts(Object.fromEntries(rows.map(row => [row.course, row.layout])));
    return rows.map(row => row.course);
  } finally {
    db.close();
  }
}

/** A new scan refreshes catalogue metadata without replacing any imported geometry or media. */
export async function refreshCachedCourseMetadata(
  db: IDBDatabase,
  names: Record<string, string> = {},
  layouts: Record<string, CourseLayout> = {},
): Promise<void> {
  for (const row of await getAll<CachedCourse>(db, 'courses')) {
    const id = canonicalDiscCourse(row.course);
    const displayName = normalizeMapDisplayName(names[id] ?? names[row.course]);
    const layout = normalizeCourseLayout(layouts[id] ?? layouts[row.course]);
    if (!displayName && !layout) continue;
    const file = await new Promise<CachedFile | undefined>((resolve, reject) => {
      const request = db.transaction('files').objectStore('files').get(`${row.course}/import.json`);
      request.onsuccess = () => resolve(request.result as CachedFile | undefined);
      request.onerror = () => reject(request.error);
    });
    let updated: CachedFile | undefined;
    if (file) {
      try {
        const metadata: unknown = JSON.parse(await file.blob.text());
        if (metadata && typeof metadata === 'object' && !Array.isArray(metadata))
          updated = {
            ...file,
            blob: new Blob(
              [
                JSON.stringify({
                  ...metadata,
                  ...(displayName ? { DisplayName: displayName } : {}),
                  ...layout,
                }),
              ],
              { type: 'application/json' },
            ),
          };
      } catch {
        /* Preserve unreadable sidecars; the catalogue row can still be refreshed. */
      }
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['courses', 'files'], 'readwrite');
      tx.objectStore('courses').put({ ...row, ...(displayName ? { displayName } : {}), ...(layout ? { layout } : {}) });
      if (updated) tx.objectStore('files').put(updated);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Course names could not be refreshed.'));
    });
  }
}
export async function readCachedCourse(course: string): Promise<Map<string, Blob>> {
  const db = await openIsoCache();
  try {
    const files = await new Promise<CachedFile[]>((resolve, reject) => {
      const request = db.transaction('files').objectStore('files').index('course').getAll(course);
      request.onsuccess = () => resolve(request.result as CachedFile[]);
      request.onerror = () => reject(request.error);
    });
    const result = new Map(files.map(row => [row.path.toLowerCase(), row.blob]));
    const metadata = result.get('import.json');
    if (metadata) {
      try {
        const imported = JSON.parse(await metadata.text()) as { DisplayName?: unknown };
        registerDiscCourseNames({ [course]: imported.DisplayName });
        registerCourseLayouts({ [course]: imported });
      } catch {
        /* Legacy caches can omit import metadata. */
      }
    }
    return result;
  } finally {
    db.close();
  }
}
/** Optional riding donors need only audio files, never another course's terrain or textures. */
export async function readCachedAudio(course: string): Promise<Map<string, Blob>> {
  const db = await openIsoCache();
  try {
    const files = await new Promise<CachedFile[]>((resolve, reject) => {
      const prefix = `${course}/audio/`;
      const request = db
        .transaction('files')
        .objectStore('files')
        .getAll(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => resolve(request.result as CachedFile[]);
      request.onerror = () => reject(request.error);
    });
    return new Map(files.map(row => [row.path.toLowerCase(), row.blob]));
  } finally {
    db.close();
  }
}
export async function clearIsoCache(): Promise<void> {
  closeIsoImporterSessions();
  const db = await openIsoCache();
  try {
    await cacheTransaction(db, 'courses', 'readwrite', store => store.clear());
    await cacheTransaction(db, 'files', 'readwrite', store => store.clear());
  } finally {
    db.close();
  }
  await clearMusicCache();
}

/** Delete one course's files and completion marker together, preserving every other cached course. */
export async function unloadIsoCourse(course: string): Promise<void> {
  const db = await openIsoCache();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(['files', 'courses'], 'readwrite');
      const files = transaction.objectStore('files');
      transaction.objectStore('courses').delete(course);
      const request = files.index('course').openKeyCursor(IDBKeyRange.only(course));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        files.delete(cursor.primaryKey);
        cursor.continue();
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () =>
        reject(transaction.error ?? new Error('The cached course could not be unloaded.'));
    });
  } finally {
    db.close();
  }
}

/** Discover courses and repair older cached sound lookups without extracting course assets. */
export function scanIso(file: File, signal?: AbortSignal): Promise<string[]> {
  return runImporter(file, 'scan', [], () => {}, signal);
}

/** Worker termination cancels both extraction and persistence. A completion marker is written last. */
export async function importIso(
  file: File,
  courses: string[],
  progress: (message: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  await navigator.storage?.persist?.();
  await runImporter(file, 'extract', courses, progress, signal);
}

let importerSessions: ReturnType<typeof createIsoImportSessions> | undefined;
export function closeIsoImporterSessions(): void {
  importerSessions?.close();
  importerSessions = undefined;
}
if (typeof window !== 'undefined') window.addEventListener('pagehide', closeIsoImporterSessions);
async function runImporter(
  file: File,
  operation: 'scan' | 'extract',
  courses: string[],
  progress: (message: string) => void,
  signal?: AbortSignal,
): Promise<string[]> {
  importerSessions ??= createIsoImportSessions(
    () => new Worker(new URL('./iso-worker.ts', import.meta.url), { type: 'module' }),
  );
  const result = await importerSessions.run(
    { file, operation, courses },
    reply => {
      if (reply.names) registerDiscCourseNames(reply.names);
      if (reply.layouts) registerCourseLayouts(reply.layouts);
      if (reply.type === 'progress') progress(reply.message ?? 'Extracting course…');
    },
    signal,
  );
  return result.courses ?? [];
}
