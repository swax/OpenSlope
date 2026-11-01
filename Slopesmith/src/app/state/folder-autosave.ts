import type { ProjectBundle } from '../../core/project/transfer';
import {
  folderPermission,
  mountainBundleHash,
  mountainFolderFile,
  readMountainFolder,
  writeMountainFolder,
  type MountainDirectory,
} from '../mountain/folder';

interface FolderBinding {
  projectId: string;
  handle: MountainDirectory;
  hash: string | null;
  savedAt?: string;
  browserHash?: string;
}
export interface FolderSaveStatus {
  state: 'none' | 'saving' | 'saved' | 'permission' | 'error';
  folder?: string;
  savedAt?: string;
  detail?: string;
}
interface Entry {
  binding: FolderBinding | null;
  status: FolderSaveStatus;
  pending?: ProjectBundle;
  running?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  stopped?: boolean;
}
const entries = new Map<string, Entry>();
const listeners = new Set<(id: string, status: FolderSaveStatus) => void>();
const loading = new Map<string, Promise<Entry>>();
const queued = new Set<Promise<void>>();
const NONE: FolderSaveStatus = { state: 'none' };

async function bindings<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('slopesmith-mountain-folders', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('handles', { keyPath: 'projectId' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('handles', mode);
      const request = action(tx.objectStore('handles'));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

function notify(id: string, entry: Entry, state: FolderSaveStatus['state'], detail?: string) {
  entry.status = { state, folder: entry.binding?.handle.name, savedAt: entry.binding?.savedAt, detail };
  for (const listener of listeners) listener(id, entry.status);
}

async function entryFor(id: string): Promise<Entry> {
  const known = entries.get(id);
  if (known) return known;
  let pending = loading.get(id);
  if (!pending) {
    pending = bindings<FolderBinding | undefined>('readonly', store => store.get(id))
      .then(binding => {
        const entry: Entry = { binding: binding ?? null, status: NONE };
        entries.set(id, entry);
        if (binding) notify(id, entry, 'permission', 'Checking folder access…');
        return entry;
      })
      .finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

export const mountainFolderStatus = (id: string): FolderSaveStatus => entries.get(id)?.status ?? NONE;
export function onMountainFolderStatus(listener: (id: string, status: FolderSaveStatus) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The bundle is captured after the browser save, so switching projects cannot redirect a pending write. */
export function queueMountainFolderSave(id: string, bundle: ProjectBundle): Promise<void> {
  const queue = async () => {
    const entry = await entryFor(id);
    if (!entry.binding || entry.stopped) return;
    entry.pending = bundle;
    if (entry.status.state === 'error') return;
    if (!(await folderPermission(entry.binding.handle))) {
      notify(id, entry, 'permission', 'Folder autosave is paused. Resume it to allow access.');
      return;
    }
    const unchanged = entry.binding.browserHash === (await mountainBundleHash(bundle));
    if (entry.pending !== bundle) return;
    if (unchanged && !entry.running) {
      entry.pending = undefined;
      notify(id, entry, 'saved');
      return;
    }
    notify(id, entry, 'saving');
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      void flushEntry(id, entry);
    }, 1000);
  };
  const pending = queue()
    .catch(error => {
      const entry = entries.get(id);
      if (entry?.binding) notify(id, entry, 'error', error instanceof Error ? error.message : String(error));
      else console.warn('Folder autosave preferences could not be read.', error);
    })
    .finally(() => queued.delete(pending));
  queued.add(pending);
  return pending;
}

async function flushEntry(id: string, entry: Entry): Promise<void> {
  clearTimeout(entry.timer);
  if (entry.running) {
    await entry.running;
    return flushEntry(id, entry);
  }
  if (
    !entry.binding ||
    !entry.pending ||
    entry.stopped ||
    entry.status.state === 'permission' ||
    entry.status.state === 'error'
  )
    return;
  const binding = entry.binding;
  const bundle = entry.pending;
  entry.pending = undefined;
  const save = async () => {
    if (!(await folderPermission(binding.handle))) {
      entry.pending ??= bundle;
      notify(id, entry, 'permission', 'Folder autosave is paused. Resume it to allow access.');
      return;
    }
    const registered = await bindings<FolderBinding | undefined>('readonly', store => store.get(id));
    if (!registered || !(await registered.handle.isSameEntry(binding.handle)))
      throw new Error('Folder autosave was disconnected in another tab.');
    binding.hash = await writeMountainFolder(binding.handle, bundle, binding.hash);
    binding.savedAt = bundle.takenAt;
    binding.browserHash = await mountainBundleHash(bundle);
    await bindings('readwrite', store => store.put(binding));
    notify(id, entry, entry.pending ? 'saving' : 'saved');
  };
  entry.running = (async () => {
    if (navigator.locks) await navigator.locks.request(`slopesmith-folder:${id}`, save);
    else await save();
  })()
    .catch(error => {
      entry.pending ??= bundle;
      notify(id, entry, 'error', error instanceof Error ? error.message : String(error));
    })
    .finally(() => {
      entry.running = undefined;
    });
  await entry.running;
  if (entry.pending && entry.status.state === 'saving') await flushEntry(id, entry);
}

export async function flushMountainFolders(): Promise<void> {
  // Include queues still looking up their saved handle.
  await Promise.all([...queued]);
  await Promise.all([...entries].map(([id, entry]) => flushEntry(id, entry)));
}
export const hasPendingMountainFolderSaves = () =>
  [...entries.values()].some(entry => (!!entry.pending && entry.status.state === 'saving') || !!entry.running);

export async function connectMountainFolder(
  id: string,
  handle: MountainDirectory,
  bundle: ProjectBundle,
  existingHash: string | null = null,
) {
  const entry = await entryFor(id);
  if (entry.binding) await flushEntry(id, entry);
  const file = await mountainFolderFile(handle);
  if (file && existingHash === null)
    throw new Error(
      'This folder already contains a mountain. Use Open mountain folder to open it, or choose another folder.',
    );
  const all = await bindings<FolderBinding[]>('readonly', store => store.getAll());
  for (const other of all) {
    if (other.projectId !== id && (await other.handle.isSameEntry(handle)))
      await disconnectMountainFolder(other.projectId);
  }
  const binding: FolderBinding = { projectId: id, handle, hash: existingHash };
  await bindings('readwrite', store => store.put(binding));
  entry.binding = binding;
  entry.stopped = false;
  entry.pending = bundle;
  notify(id, entry, 'saving');
  await flushEntry(id, entry);
  if (entry.status.state === 'error' || entry.status.state === 'permission') throw new Error(entry.status.detail);
}

/** Resuming needs a user click; background autosave never opens a permission prompt. */
export async function resumeMountainFolder(id: string): Promise<void> {
  const entry = entries.get(id);
  if (!entry?.binding) return;
  if (!(await folderPermission(entry.binding.handle, true))) {
    notify(id, entry, 'permission', 'Folder access was not allowed. Your browser copy is still available.');
    return;
  }
  notify(id, entry, entry.pending ? 'saving' : 'saved');
  await flushEntry(id, entry);
}

/** Forget only the browser connection. The independent folder copy is deliberately kept on disk. */
export async function disconnectMountainFolder(id: string) {
  const entry = await entryFor(id);
  entry.stopped = true;
  clearTimeout(entry.timer);
  entry.pending = undefined;
  await entry.running;
  await bindings('readwrite', store => store.delete(id));
  entry.binding = null;
  notify(id, entry, 'none');
}

export async function projectForMountainFolder(handle: MountainDirectory): Promise<string | null> {
  const all = await bindings<FolderBinding[]>('readonly', store => store.getAll());
  for (const binding of all) if (await binding.handle.isSameEntry(handle)) return binding.projectId;
  return null;
}

/** Listing linked folders never requests permission or reads their map files. */
export async function listMountainFolders(): Promise<Map<string, string>> {
  const all = await bindings<FolderBinding[]>('readonly', store => store.getAll());
  return new Map(all.map(binding => [binding.projectId, binding.handle.name]));
}

/** Ask near the click, before loading potentially large browser projects can consume user activation. */
export async function requestMountainFolderAccess(id: string): Promise<void> {
  const entry = await entryFor(id);
  if (!entry.binding || (await folderPermission(entry.binding.handle, true))) return;
  const detail = 'Folder access was not allowed. Your browser copy is still available.';
  notify(id, entry, 'permission', detail);
  throw new Error(detail);
}

/** Remember an existing disk copy without rewriting it or starting editor autosave. */
export async function linkMountainFolder(id: string, handle: MountainDirectory, bundle: ProjectBundle, hash: string) {
  const entry = await entryFor(id);
  clearTimeout(entry.timer);
  await entry.running;
  const all = await bindings<FolderBinding[]>('readonly', store => store.getAll());
  for (const other of all) {
    if (other.projectId !== id && (await other.handle.isSameEntry(handle)))
      await disconnectMountainFolder(other.projectId);
  }
  const binding: FolderBinding = {
    projectId: id,
    handle,
    hash,
    savedAt: bundle.takenAt,
    browserHash: await mountainBundleHash(bundle),
  };
  await bindings('readwrite', store => store.put(binding));
  entry.binding = binding;
  entry.pending = undefined;
  entry.stopped = false;
  notify(id, entry, 'saved');
}

/** Check disk before activating a browser replica. An unchanged folder leaves browser recovery intact. */
export async function readLinkedMountainFolder(id: string, current: ProjectBundle, ask = false) {
  const entry = await entryFor(id);
  if (!entry.binding) return null;
  await flushEntry(id, entry);
  const binding = entry.binding;
  try {
    if (!(await folderPermission(binding.handle, ask))) {
      const detail = 'Folder autosave is paused. Resume it to allow access.';
      notify(id, entry, 'permission', detail);
      if (ask) throw new Error('Folder access was not allowed. Your browser copy is still available.');
      return null;
    }
    const source = await readMountainFolder(binding.handle);
    if (source.hash === binding.hash) {
      notify(id, entry, 'saved');
      return null;
    }
    // Older links have no content baseline. Keep a recovery copy rather than relying on timestamps.
    const browserChanged = !binding.browserHash || binding.browserHash !== (await mountainBundleHash(current));
    return { ...source, browserChanged };
  } catch (error) {
    if (entry.status.state !== 'permission')
      notify(id, entry, 'error', error instanceof Error ? error.message : String(error));
    throw error;
  }
}

/** Advance the disk baseline only after its complete bundle has been stored in the browser. */
export async function acceptMountainFolderSnapshot(id: string, bundle: ProjectBundle, hash: string, backup?: string) {
  const entry = await entryFor(id);
  if (!entry.binding) throw new Error('The folder connection was removed. Link the folder again.');
  clearTimeout(entry.timer);
  entry.pending = undefined;
  entry.binding.hash = hash;
  entry.binding.browserHash = await mountainBundleHash(bundle);
  entry.binding.savedAt = bundle.takenAt;
  await bindings('readwrite', store => store.put(entry.binding!));
  notify(id, entry, 'saved', backup ? `Folder changes loaded. Browser edits were kept in ${backup}.` : undefined);
}
