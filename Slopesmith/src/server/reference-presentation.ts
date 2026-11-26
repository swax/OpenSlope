import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './fs-async';

/** Update catalogue metadata in place, preserving the fields written by the original importer. */
export async function writeTrickyModMetadata(directory: string, title: string): Promise<boolean> {
  const path = join(directory, 'Import.json');
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info && !info.isFile()) throw new Error('Import.json must be an ordinary file.');
  const text = info ? await readFile(path, 'utf8') : '{}';
  const metadata: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('Import.json must contain a metadata object.');
  const fields = metadata as Record<string, unknown>;
  if (fields.DisplayName === title && fields.Variant === 'mod') return false;
  await writeJsonAtomic(path, { ...fields, DisplayName: title, Variant: 'mod' });
  return true;
}
