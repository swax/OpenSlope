import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import {
  referenceMusicEncoding,
  REFERENCE_MUSIC_INDEX,
  type EncodedReferenceMusic,
} from '../shared/reference-music-encoding';
import { mapsRoot } from './workspace-config';
import { referenceReuseDigest } from './reference-file-reuse';

/** Only completed, ordinary library folders can supply a pre-encoding hit. Upload negotiation hashes/copies it again. */
export async function reusableReferenceMusic(input: unknown, signal?: AbortSignal) {
  const hashes = (input as { hashes?: unknown })?.hashes;
  if (
    !Array.isArray(hashes) ||
    hashes.length > 30_000 ||
    hashes.some(hash => typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
  )
    throw new Error('Invalid reference music lookup.');
  const wanted = new Set<string>(hashes);
  const found = new Map<string, EncodedReferenceMusic>();
  const root = await realpath(mapsRoot());
  for (const entry of await readdir(root, { withFileTypes: true })) {
    signal?.throwIfAborted();
    if (!wanted.size) break;
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const course = join(root, entry.name);
    let files: EncodedReferenceMusic[];
    try {
      const index = join(course, REFERENCE_MUSIC_INDEX);
      if (!(await realpath(index)).startsWith(course + sep) || (await lstat(index)).size > 8 * 1024 ** 2) continue;
      files = referenceMusicEncoding(JSON.parse(await readFile(index, 'utf8'))).files;
    } catch {
      continue;
    }
    for (const file of files) {
      signal?.throwIfAborted();
      if (!wanted.has(file.sourceSha256)) continue;
      try {
        const path = join(course, file.path);
        if (!(await realpath(path)).startsWith(course + sep)) continue;
        const stat = await lstat(path);
        if (!stat.isFile() || stat.size !== file.size) continue;
        if ((await referenceReuseDigest(path, file.size, signal)) !== file.sha256) continue;
        found.set(file.sourceSha256, file);
        wanted.delete(file.sourceSha256);
      } catch {
        /* A reference can be removed during a lookup. */
      }
    }
  }
  return { files: [...found.values()] };
}
