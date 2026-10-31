import { stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { legacyTrickyMapName, serverMapName } from '../core/reference/map-source';
import type { MapDataSource } from '../shared/map-data';
import * as fs from './fs-async';
import { mapsRoot } from './workspace-config';

export * from './fs-async';

async function directory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
}

/** Resolve the whole bank once. An existing legacy bank remains authoritative, even if a file is missing. */
export async function resolveServerMapName(id: string, root = mapsRoot()): Promise<string> {
  const name = serverMapName(id);
  const fallback = legacyTrickyMapName(name);
  if (!fallback || (await directory(join(root, name)))) return name;
  return (await directory(join(root, fallback))) ? fallback : name;
}

async function referencePath(file: string, root = mapsRoot(), banks = new Map<string, Promise<string>>()) {
  const local = relative(root, file);
  if (!local || isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) return file;
  const [name, ...parts] = local.split(sep);
  if (!legacyTrickyMapName(name)) return file;
  let resolved = banks.get(name);
  if (!resolved) {
    resolved = resolveServerMapName(name, root);
    banks.set(name, resolved);
  }
  return join(root, await resolved, ...parts);
}

// Reference routes also read project-owned files outside Maps; those paths pass through unchanged.
export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  return fs.readJsonOr(await referencePath(file), fallback);
}
export async function readTextOrNull(file: string) {
  return fs.readTextOrNull(await referencePath(file));
}
export async function readBytesOrNull(file: string) {
  return fs.readBytesOrNull(await referencePath(file));
}
export async function listDir(file: string) {
  return fs.listDir(await referencePath(file));
}
export async function listEntries(file: string) {
  return fs.listEntries(await referencePath(file));
}
export async function listSubdirectories(file: string) {
  return fs.listSubdirectories(await referencePath(file));
}
export async function pathExists(file: string) {
  return fs.pathExists(await referencePath(file));
}
export async function isDirectory(file: string) {
  return fs.isDirectory(await referencePath(file));
}
export async function isFile(file: string) {
  return fs.isFile(await referencePath(file));
}

/** Keep logical names in reader payloads while resolving physical folders for all reference reads. */
export function referenceMapData(): MapDataSource {
  const root = mapsRoot();
  const banks = new Map<string, Promise<string>>();
  const path = (file: string) => referencePath(file, root, banks);
  return {
    root,
    async readJsonOr<T>(file: string, fallback: T) {
      return fs.readJsonOr(await path(file), fallback);
    },
    async readTextOrNull(file) {
      return fs.readTextOrNull(await path(file));
    },
    async readBytesOrNull(file) {
      return fs.readBytesOrNull(await path(file));
    },
    async listDir(file) {
      return fs.listDir(await path(file));
    },
    async listEntries(file) {
      return fs.listEntries(await path(file));
    },
    async pathExists(file) {
      return fs.pathExists(await path(file));
    },
  };
}
