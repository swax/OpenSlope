import type { ProjectBundle } from '../../core/project/transfer';
import { createMountainArchive, readMountainArchive } from './archive';

/** One complete editable snapshot. createWritable commits it only when close succeeds. */
export const MOUNTAIN_FOLDER_FILE = 'mountain.slopesmith.zip';
export type MountainDirectory = FileSystemDirectoryHandle & {
  queryPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>;
};

export const canSaveMountainFolder = () => typeof window !== 'undefined' && !!window.showDirectoryPicker;

/** Call from the click itself, before composing the mountain or looking up browser storage. */
export async function pickMountainFolder(): Promise<MountainDirectory | null> {
  if (!window.showDirectoryPicker)
    throw new Error('Folder autosave is unavailable in this browser. Use Export mountain for a ZIP backup.');
  try {
    return await window.showDirectoryPicker({ id: 'slopesmith-mountain', mode: 'readwrite' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

export async function folderPermission(handle: MountainDirectory, ask = false): Promise<boolean> {
  const permission = await handle.queryPermission?.({ mode: 'readwrite' });
  if (permission === undefined || permission === 'granted') return true;
  return ask && (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted';
}

export async function mountainFolderFile(handle: MountainDirectory): Promise<File | null> {
  try {
    return await (await handle.getFileHandle(MOUNTAIN_FOLDER_FILE)).getFile();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return null;
    throw error;
  }
}

export async function mountainFileHash(file: Blob): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function readMountainFolder(handle: MountainDirectory) {
  const file = await mountainFolderFile(handle);
  if (!file) throw new Error(`Choose a folder containing ${MOUNTAIN_FOLDER_FILE}.`);
  return { bundle: await readMountainArchive(file), hash: await mountainFileHash(file) };
}

/** Preserve the previous snapshot on a failed write, and refuse to overwrite an externally changed file. */
export async function writeMountainFolder(
  handle: MountainDirectory,
  bundle: ProjectBundle,
  expectedHash: string | null,
): Promise<string> {
  const file = await mountainFolderFile(handle);
  const currentHash = file && (file.size || expectedHash) ? await mountainFileHash(file) : null;
  if (currentHash !== expectedHash)
    throw new Error(
      'The folder copy changed in another editor. Open the mountain folder again to load its latest copy.',
    );
  const archive = createMountainArchive(bundle);
  const hash = await mountainFileHash(archive.blob);
  const output = await (await handle.getFileHandle(MOUNTAIN_FOLDER_FILE, { create: true })).createWritable();
  try {
    await output.write(archive.blob);
    await output.close();
  } catch (error) {
    await output.abort().catch(() => {});
    throw error;
  }
  return hash;
}
