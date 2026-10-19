import { cacheTransaction, ISO_CACHE_VERSION, openIsoCache, updateCachedCollisionSounds, type DiscCollisionSounds } from './iso-cache';

interface Importer {
  isoFile: File;
  ccall(name: string, result: string, types: string[], args: string[]): string;
  FS: {
    readdir(path: string): string[];
    stat(path: string): { mode: number };
    isDir(mode: number): boolean;
    readFile(path: string): Uint8Array<ArrayBuffer>;
    unlink(path: string): void;
    rmdir(path: string): void;
  };
}
const mime = (name: string) => /\.png$/i.test(name) ? 'image/png' : /\.wav$/i.test(name) ? 'audio/wav'
  : /\.json$/i.test(name) ? 'application/json' : 'application/octet-stream';

self.onmessage = async (event: MessageEvent<{ file: File; courses: string[]; operation: 'scan' | 'extract' }>) => {
  let db: IDBDatabase | undefined;
  try {
    const { file, courses, operation } = event.data;
    // This static runtime is built from Native/src/browser_import.cpp; disc bytes stay inside this worker.
    const assetUrl = (name: string) => new URL(`/iso-importer/${name}?v=5`, self.location.origin).href;
    const runtimeUrl = assetUrl('openslope_browser_import.js');
    const runtime = await import(/* @vite-ignore */ runtimeUrl) as { default: (options: { locateFile: (name: string) => string }) => Promise<Importer> };
    const module = await runtime.default({ locateFile: assetUrl });
    module.isoFile = file;
    const available = JSON.parse(module.ccall('browser_courses', 'string', [], [])) as { courses?: string[]; error?: string };
    if (available.error) throw new Error(available.error);
    if (!available.courses?.length) throw new Error('No supported SSX, SSX Tricky or SSX 3 PS2 maps were found.');
    if (operation === 'scan') {
      if (available.courses.some(course => !course.startsWith('SSX_') && !course.startsWith('SSX3_'))) {
        const sounds = JSON.parse(module.ccall('browser_collision_sounds', 'string', [], [])) as DiscCollisionSounds & { error?: string };
        if (sounds.error) throw new Error(sounds.error);
        db = await openIsoCache();
        await updateCachedCollisionSounds(db, available.courses, sounds);
      }
      self.postMessage({ type: 'done', courses: available.courses });
      return;
    }
    for (const course of courses) {
      if (!available.courses?.includes(course)) throw new Error(`This ISO does not contain ${course}. Choose the matching game disc.`);
    }
    db = await openIsoCache();
    for (const course of courses) {
      const result = JSON.parse(module.ccall('browser_extract', 'string', ['string'], [course])) as { error?: string };
      if (result.error) throw new Error(result.error);
      await cacheTransaction(db, 'courses', 'readwrite', store => store.delete(course));
      let files = 0;
      const saveDirectory = async (directory: string): Promise<void> => {
        for (const name of module.FS.readdir(directory).filter(name => name !== '.' && name !== '..')) {
          const path = `${directory}/${name}`;
          if (module.FS.isDir(module.FS.stat(path).mode)) { await saveDirectory(path); module.FS.rmdir(path); }
          else {
            const relative = path.slice('/course/'.length);
            const blob = new Blob([module.FS.readFile(path)], { type: mime(path) });
            await cacheTransaction(db!, 'files', 'readwrite', store => store.put({
              key: `${course}/${relative.toLowerCase()}`, course, path: relative, blob,
            }));
            module.FS.unlink(path);
            files++;
          }
        }
      };
      self.postMessage({ type: 'progress', message: `Saving ${course} in this browser…` });
      await saveDirectory('/course');
      await cacheTransaction(db, 'courses', 'readwrite', store => store.put({ course, version: ISO_CACHE_VERSION, files }));
    }
    self.postMessage({ type: 'done' });
  } catch (error) { self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) }); }
  finally { db?.close(); }
};
