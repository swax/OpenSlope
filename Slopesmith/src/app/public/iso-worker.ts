import {
  cacheTransaction,
  isoCourseCacheVersion,
  openIsoCache,
  supportsCollisionSoundUpdate,
  unloadIsoCourse,
  updateCachedCollisionSounds,
  type DiscCollisionSounds,
} from './iso-cache';
import { normalizeCourseLayout, type CourseLayout } from '../../core/reference/course-layout';
import { discContainsCourse } from '../../core/reference/disc-courses';
import { openMusicCache, safeMusicPath, type MusicFile, type MusicManifest } from './iso-music-cache';

interface Importer {
  isoFile: File;
  ccall(name: string, result: string, types: string[], args: string[]): string;
  FS: {
    readdir(path: string): string[];
    stat(path: string): { mode: number };
    isDir(mode: number): boolean;
    readFile(path: string): Uint8Array<ArrayBuffer>;
    writeFile(path: string, bytes: Uint8Array, options?: { canOwn: boolean }): void;
    mkdirTree(path: string): void;
    unlink(path: string): void;
    rmdir(path: string): void;
  };
}
interface MusicEntry {
  Key: string;
  Destination: string;
  Manifest: MusicManifest;
  Hit: boolean;
}
interface CachedFile {
  key: string;
  course: string;
  path: string;
  blob: Blob;
}
interface Available {
  courses: string[];
  names?: Record<string, string>;
  layouts?: Record<string, CourseLayout>;
  error?: string;
}
const mime = (name: string) =>
  /\.png$/i.test(name)
    ? 'image/png'
    : /\.wav$/i.test(name)
      ? 'audio/wav'
      : /\.json$/i.test(name)
        ? 'application/json'
        : 'application/octet-stream';
let module: Importer | undefined;
let available: Available | undefined;
let musicCache: Awaited<ReturnType<typeof openMusicCache>> | undefined;
let musicUnavailable = false;

function removeTree(runtime: Importer, path: string) {
  let names: string[];
  try {
    names = runtime.FS.readdir(path);
  } catch {
    return;
  }
  for (const name of names.filter(name => name !== '.' && name !== '..')) {
    const child = `${path}/${name}`;
    if (runtime.FS.isDir(runtime.FS.stat(child).mode)) removeTree(runtime, child);
    else runtime.FS.unlink(child);
  }
  runtime.FS.rmdir(path);
}

async function handle({ data }: MessageEvent<{ file: File; courses: string[]; operation: 'scan' | 'extract' }>) {
  let db: IDBDatabase | undefined;
  try {
    const { file, courses, operation } = data;
    if (!module) {
      const assetUrl = (name: string) => new URL(`/iso-importer/${name}?v=32`, self.location.origin).href;
      const runtime = (await import(/* @vite-ignore */ assetUrl('openslope_browser_import.js'))) as {
        default(options: { locateFile: (name: string) => string }): Promise<Importer>;
      };
      module = await runtime.default({ locateFile: assetUrl });
      module.isoFile = file;
    }
    const runtime = module;
    if (!available) {
      const scanned = JSON.parse(runtime.ccall('browser_courses', 'string', [], [])) as Available;
      if (scanned.error) throw new Error(scanned.error);
      if (!scanned.courses?.length)
        throw new Error('No supported SSX, 1080° Avalanche or Mad Trix courses were found.');
      available = scanned;
    }
    if (operation === 'scan') {
      if (available.courses.some(supportsCollisionSoundUpdate)) {
        const sounds = JSON.parse(
          runtime.ccall('browser_collision_sounds', 'string', [], []),
        ) as DiscCollisionSounds & { error?: string };
        if (sounds.error) throw new Error(sounds.error);
        db = await openIsoCache();
        await updateCachedCollisionSounds(
          db,
          available.courses.flatMap(id => (id.startsWith('TRICKY_') ? [id, id.slice(7)] : [id])),
          sounds,
        );
      }
      self.postMessage({
        type: 'done',
        ...available,
        stats: JSON.parse(runtime.ccall('browser_import_stats', 'string', [], [])),
      });
      return;
    }
    for (const course of courses)
      if (!discContainsCourse(available.courses, course))
        throw new Error(`This ISO does not contain ${course}. Choose the matching game disc.`);
    db = await openIsoCache();
    if (!musicCache && !musicUnavailable) {
      try {
        musicCache = await openMusicCache();
      } catch {
        musicUnavailable = true;
      }
    }
    for (const course of courses) {
      self.postMessage({ type: 'progress', message: 'Preparing shared music…' });
      removeTree(runtime, '/music-cache');
      const plan = JSON.parse(runtime.ccall('browser_music_plan', 'string', ['string'], [course])) as {
        Key: string;
      }[] & { error?: string };
      if (plan.error) throw new Error(plan.error);
      const restored = new Map<string, Map<string, Blob>>();
      for (const { Key: key } of plan) {
        if (restored.has(key) || !musicCache) continue;
        try {
          const entry = await musicCache.load(key);
          if (!entry) continue;
          for (const file of entry.files) {
            if (!safeMusicPath(file.path)) throw new Error('Invalid cached music path');
            const path = `/music-cache/${key}/files/${file.path}`;
            runtime.FS.mkdirTree(path.slice(0, path.lastIndexOf('/')));
            runtime.FS.writeFile(path, new Uint8Array(await file.blob.arrayBuffer()), { canOwn: true });
          }
          runtime.FS.writeFile(
            `/music-cache/${key}/manifest.json`,
            new TextEncoder().encode(JSON.stringify(entry.manifest)),
          );
          restored.set(key, new Map(entry.files.map(file => [file.path, file.blob])));
        } catch {
          removeTree(runtime, `/music-cache/${key}`);
        }
      }
      const result = JSON.parse(runtime.ccall('browser_extract', 'string', ['string'], [course])) as { error?: string };
      if (result.error) throw new Error(result.error);
      const entries = JSON.parse(runtime.ccall('browser_music_entries', 'string', [], [])) as MusicEntry[];
      const byDirectory = new Map(entries.map(entry => [entry.Destination, entry]));
      const metadata = JSON.parse(new TextDecoder().decode(runtime.FS.readFile('/course/Import.json'))) as {
        DisplayName?: string;
      };
      await unloadIsoCourse(course);
      let files = 0,
        batchBytes = 0,
        batches = 0;
      let batch: { row: CachedFile; path: string }[] = [];
      const flush = async () => {
        if (!batch.length) return;
        await cacheTransaction(db!, 'files', 'readwrite', store => {
          for (const { row } of batch) store.put(row);
        });
        for (const { path } of batch) runtime.FS.unlink(path);
        batch = [];
        batchBytes = 0;
        ++batches;
      };
      const saveDirectory = async (directory: string, music?: { entry: MusicEntry; files: MusicFile[] }) => {
        const entry = byDirectory.get(directory);
        if (entry) music = { entry, files: [] };
        for (const name of runtime.FS.readdir(directory).filter(name => name !== '.' && name !== '..')) {
          const path = `${directory}/${name}`;
          if (runtime.FS.isDir(runtime.FS.stat(path).mode)) {
            await saveDirectory(path, music);
            runtime.FS.rmdir(path);
          } else {
            const relative = path.slice('/course/'.length);
            const musicPath = music ? path.slice(music.entry.Destination.length + 1) : '';
            const existing = music?.entry.Hit ? restored.get(music.entry.Key)?.get(musicPath) : undefined;
            const blob = existing ?? new Blob([runtime.FS.readFile(path)], { type: mime(path) });
            if (music && !music.entry.Hit) music.files.push({ path: musicPath, blob });
            batch.push({ row: { key: `${course}/${relative.toLowerCase()}`, course, path: relative, blob }, path });
            batchBytes += blob.size;
            ++files;
            if (batch.length >= 64 || batchBytes >= 8 * 1024 ** 2) await flush();
          }
        }
        await flush();
        if (entry && !entry.Hit && musicCache) {
          try {
            await musicCache.save(entry.Manifest, music!.files);
          } catch {
            /* Optional acceleration; the map is already saved. */
          }
        }
      };
      self.postMessage({ type: 'progress', message: `Saving ${course} in this browser…` });
      await saveDirectory('/course');
      await cacheTransaction(db, 'courses', 'readwrite', store =>
        store.put({
          course,
          version: isoCourseCacheVersion(course),
          files,
          displayName: metadata.DisplayName,
          layout: normalizeCourseLayout(metadata),
        }),
      );
      self.postMessage({ type: 'progress', message: `${course} saved.`, files, batches });
    }
    self.postMessage({
      type: 'done',
      names: available.names,
      layouts: available.layouts,
      stats: JSON.parse(runtime.ccall('browser_import_stats', 'string', [], [])),
    });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    db?.close();
  }
}
let serial = Promise.resolve();
self.onmessage = (event: MessageEvent<{ file: File; courses: string[]; operation: 'scan' | 'extract' }>) => {
  serial = serial.then(() => handle(event));
};
