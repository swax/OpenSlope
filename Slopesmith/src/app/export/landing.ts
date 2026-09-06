import type { ExportFolder } from '../../core/export/files';
import { zipStoreOnly } from './zip';

/**
 * Where an export lands.
 *
 * Two destinations, one interface. On a browser with the File System Access API the author picks their `Maps/`
 * folder ONCE — the handle is kept in IndexedDB, which is the only store that can hold one — and every later
 * export writes `Maps/<NAME>/` straight into it, beside the extracted reference levels. Everywhere else the
 * folder comes down as a store-only ZIP the author unpacks themselves.
 *
 * The ZIP is not a lesser export: it is the same composed folder, file for file. What it cannot do is CLEAR —
 * a fresh archive has nothing in it to retire — so the `remove` list is only meaningful for the directory
 * writer, where a re-export of a sky with fewer pages must not leave the old ones behind.
 *
 * Firefox and Safari have no File System Access API and so take the ZIP path. That is a browser fact rather
 * than a preference, and the export dialog says so rather than quietly downloading.
 */

export interface ExportTarget {
  kind: 'directory' | 'download';
  /** The folder this export lands as — resolved before composition, because the disc recipe's commands and
   *  the race-music probe are both written against it. */
  folderName: string;
  /** How the destination is named in the toast and the export log. */
  label: string;
  /** Whether the destination already holds this path, relative to the export folder. */
  existingFile(path: string): Promise<boolean>;
  /** Land the composed folder; answers the line the log ends on. */
  land(folder: ExportFolder): Promise<string>;
}

/** Whether this browser can write a folder the author picks, rather than downloading one. */
export const canPickDirectory = (): boolean => typeof window !== 'undefined' && !!window.showDirectoryPicker;

// ---- the picked directory ------------------------------------------------------------------------------

const DB_NAME = 'slopesmith-export';
const STORE = 'handles';
const MAPS_KEY = 'maps-directory';

/** A handle is a live object rather than a string, so localStorage cannot hold it and IndexedDB is the store
 *  the platform actually offers for one. */
function openHandleStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('could not open the export handle store'));
  });
}

async function readHandle(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openHandleStore();
    try {
      return await new Promise<FileSystemDirectoryHandle | null>((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(MAPS_KEY);
        request.onsuccess = () => resolve((request.result as FileSystemDirectoryHandle | undefined) ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
  } catch { return null; /* private browsing, a blocked store: the author picks again */ }
}

async function writeHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  try {
    const db = await openHandleStore();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite');
        transaction.objectStore(STORE).put(handle, MAPS_KEY);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
  } catch { /* not remembering it costs one more pick, never the export */ }
}

/** Permission on a stored handle is not permanent: the browser drops it between sessions, and asking again
 *  needs the gesture that started the export. */
type PermissionHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
};

async function writable(handle: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
  const permissioned = handle as PermissionHandle;
  const state = await permissioned.queryPermission?.({ mode: 'readwrite' });
  if (state === 'granted' || state === undefined) return true;
  if (!ask) return false;
  return await permissioned.requestPermission?.({ mode: 'readwrite' }) === 'granted';
}

/** The remembered `Maps/` folder, if one was picked and is still writable. Called from the export's own click,
 *  so re-granting a lapsed permission can prompt. */
export async function rememberedMapsDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await readHandle();
  if (!handle) return null;
  return await writable(handle, true) ? handle : null;
}

/** Ask for the `Maps/` folder and remember it. Null when the author dismissed the picker. */
export async function pickMapsDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!window.showDirectoryPicker) return null;
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await window.showDirectoryPicker({ id: 'slopesmith-maps', mode: 'readwrite' });
  } catch { return null; /* the picker was dismissed */ }
  if (!await writable(handle, true)) return null;
  await writeHandle(handle);
  return handle;
}

/** Forget the picked folder, so the next export asks again. */
export async function forgetMapsDirectory(): Promise<void> {
  try {
    const db = await openHandleStore();
    try { db.transaction(STORE, 'readwrite').objectStore(STORE).delete(MAPS_KEY); }
    finally { db.close(); }
  } catch { /* nothing to forget */ }
}

export function directoryTarget(root: FileSystemDirectoryHandle, folderName: string): ExportTarget {
  /** Walk the directories leading to `parts`, from THIS EXPORT'S folder down — never from the picked root,
   *  which holds the whole library. Null as soon as one of them does not exist. */
  const descend = async (parts: string[]): Promise<FileSystemDirectoryHandle | null> => {
    let at: FileSystemDirectoryHandle;
    try { at = await root.getDirectoryHandle(folderName); } catch { return null; }
    for (const part of parts) {
      try { at = await at.getDirectoryHandle(part); }
      catch { return null; }
    }
    return at;
  };

  return {
    kind: 'directory',
    folderName,
    label: `${root.name}/${folderName}`,

    async existingFile(path) {
      const parts = path.split('/');
      const dir = await descend(parts.slice(0, -1));
      if (!dir) return false;
      try { await dir.getFileHandle(parts[parts.length - 1]); return true; }
      catch { return false; }
    },

    async land(folder) {
      const target = await root.getDirectoryHandle(folderName, { create: true });
      // Clear first: an export is a complete snapshot of the subtrees it owns, so a retired sky page or a
      // cleared music track cannot survive from a previous run.
      for (const path of folder.remove) {
        const parts = path.split('/');
        let at: FileSystemDirectoryHandle = target;
        let reached = true;
        for (const part of parts.slice(0, -1)) {
          try { at = await at.getDirectoryHandle(part); } catch { reached = false; break; }
        }
        if (!reached) continue;
        try { await at.removeEntry(parts[parts.length - 1], { recursive: true }); }
        catch { /* nothing there to retire */ }
      }
      const made = new Map<string, FileSystemDirectoryHandle>([['', target]]);
      const ensure = async (parts: string[]): Promise<FileSystemDirectoryHandle> => {
        const key = parts.join('/');
        const hit = made.get(key);
        if (hit) return hit;
        const parent = await ensure(parts.slice(0, -1));
        const dir = await parent.getDirectoryHandle(parts[parts.length - 1], { create: true });
        made.set(key, dir);
        return dir;
      };
      await ensure(['Textures']);   // every export carries one, painted or not
      for (const file of folder.files) {
        const parts = file.path.split('/');
        const dir = await ensure(parts.slice(0, -1));
        const handle = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const stream = await handle.createWritable();
        await stream.write(file.bytes as BufferSource);
        await stream.close();
      }
      return `wrote ${folder.files.length} file(s) into ${root.name}/${folderName}/`;
    },
  };
}

// ---- the download --------------------------------------------------------------------------------------

export function downloadTarget(folderName: string): ExportTarget {
  return {
    kind: 'download',
    folderName,
    label: `${folderName}.zip`,
    // A fresh archive holds whatever this export puts in it, so there is never a track already staged there.
    existingFile: async () => false,

    async land(folder) {
      const blob = zipStoreOnly(folderName, folder.files);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${folderName}.zip`;
      // In the document, and revoked a turn later: this is the browser without the directory API, and a map
      // folder is tens of megabytes — the shape a same-tick revoke is most likely to cut short.
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return `downloaded ${folderName}.zip — ${folder.files.length} file(s), `
        + `${(blob.size / 1048576).toFixed(1)} MB — unpack it into your Maps folder`;
    },
  };
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: {
      id?: string;
      mode?: 'read' | 'readwrite';
      startIn?: FileSystemHandle | string;
    }) => Promise<FileSystemDirectoryHandle>;
  }
}
