import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { mapLimit } from '../shared/map-data';
import type { ReferenceFile } from '../shared/reference-transfer';

/** A stat signature is only an acceleration hint. Reused staging bytes are always hashed again. */
const hashes = new Map<string, { signature: string; hash: string }>();
const MAX_HASHES = 100_000;
const key = (file: ReferenceFile) => `${file.size}:${file.sha256}`;
const signature = (entry: Awaited<ReturnType<typeof fileStat>>) =>
  `${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}:${entry.ino}`;
const fileStat = (path: string) => lstat(path, { bigint: true });

async function digest(path: string, size: number, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = createReadStream(path);
  for await (const chunk of stream) {
    signal?.throwIfAborted();
    bytes += chunk.length;
    if (bytes > size) {
      stream.destroy();
      throw new Error('Reference reuse source changed size.');
    }
    hash.update(chunk);
  }
  if (bytes !== size) throw new Error('Reference reuse source changed size.');
  return hash.digest('hex');
}

function remember(path: string, stamp: string, hash: string) {
  hashes.delete(path);
  hashes.set(path, { signature: stamp, hash });
  while (hashes.size > MAX_HASHES) hashes.delete(hashes.keys().next().value!);
}

export async function referenceReuseDigest(path: string, size: number, signal?: AbortSignal) {
  const entry = await fileStat(path);
  if (!entry.isFile() || Number(entry.size) !== size) throw new Error('Reference reuse source changed.');
  const stamp = signature(entry),
    cached = hashes.get(path);
  if (cached?.signature === stamp) return cached.hash;
  const hash = await digest(path, size, signal);
  if (signature(await fileStat(path)) !== stamp) throw new Error('Reference reuse source changed.');
  remember(path, stamp, hash);
  return hash;
}

/** Seed the index from hashes we just validated, without re-reading newly installed courses. */
export async function rememberReferenceFiles(root: string, course: string, files: readonly ReferenceFile[]) {
  await mapLimit([...files], 8, async file => {
    const path = join(root, course, file.path);
    try {
      const entry = await fileStat(path);
      if (entry.isFile() && Number(entry.size) === file.size) remember(path, signature(entry), file.sha256);
    } catch {
      /* Another administrator may already have removed the course. */
    }
  });
}

/** Ordinary library files only: hidden staging/cache trees and links are never donors. */
async function libraryFiles(root: string, course: string, signal?: AbortSignal): Promise<string[]> {
  const paths: string[] = [],
    directories = [root];
  while (directories.length) {
    signal?.throwIfAborted();
    const batch = directories.splice(0, 8);
    await mapLimit(batch, 8, async directory => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        return;
      } // A course can be removed while another admin is negotiating an upload.
      entries.sort(
        (a, b) => Number(b.name.startsWith(course.split('_')[0])) - Number(a.name.startsWith(course.split('_')[0])),
      );
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) directories.push(path);
        else if (entry.isFile()) paths.push(path);
      }
    });
  }
  return paths;
}

export interface ReferenceReuse {
  missing: number[];
  aliases: Array<{ path: string; source: string }>;
  reusedFiles: number;
  reusedBytes: number;
}

export async function reuseReferenceFiles(
  root: string,
  staging: string,
  course: string,
  files: readonly ReferenceFile[],
  signal?: AbortSignal,
): Promise<ReferenceReuse> {
  const missing = new Set<number>();
  const representatives = new Map<string, number>();
  const wanted = new Map<string, number>();
  const aliases: ReferenceReuse['aliases'] = [];
  for (const [index, file] of files.entries()) {
    if (!file.size) {
      missing.add(index);
      continue;
    } // Empty files need no transmitted bytes.
    const fingerprint = key(file),
      first = representatives.get(fingerprint);
    if (first !== undefined) aliases.push({ path: file.path, source: files[first].path });
    else {
      representatives.set(fingerprint, index);
      wanted.set(fingerprint, index);
      missing.add(index);
    }
  }
  const wantedSizes = new Map<number, number>();
  for (const index of wanted.values())
    wantedSizes.set(files[index].size, (wantedSizes.get(files[index].size) ?? 0) + 1);
  const candidates = await libraryFiles(root, course, signal);
  // Known hashes come first. This makes a second course mostly copies rather than repeated reads of its banks.
  candidates.sort((a, b) => Number(hashes.has(b)) - Number(hashes.has(a)));
  let failure: unknown;
  await mapLimit(candidates, 4, async source => {
    if (!wanted.size || signal?.aborted || failure) return;
    let destination: string | undefined;
    let reserved: { fingerprint: string; index: number } | undefined;
    try {
      const entry = await fileStat(source),
        size = Number(entry.size);
      if (!entry.isFile() || !wantedSizes.get(size)) return;
      const stamp = signature(entry),
        cached = hashes.get(source);
      const hash = cached?.signature === stamp ? cached.hash : await digest(source, size, signal);
      if (signature(await fileStat(source)) !== stamp) return;
      remember(source, stamp, hash);
      const fingerprint = `${size}:${hash}`,
        index = wanted.get(fingerprint);
      if (index === undefined) return;
      // Reserve the representative across asynchronous copies; another matching donor cannot claim its path.
      wanted.delete(fingerprint);
      wantedSizes.set(size, wantedSizes.get(size)! - 1);
      reserved = { fingerprint, index };
      destination = join(staging, files[index].path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination, constants.COPYFILE_EXCL);
      if ((await digest(destination, size, signal)) !== files[index].sha256)
        throw new Error('Reference donor changed.');
      missing.delete(index);
      reserved = undefined;
    } catch {
      hashes.delete(source);
      if (destination) {
        try {
          await rm(destination, { force: true });
        } catch (error) {
          failure ??= error;
        }
      }
      if (reserved) {
        wanted.set(reserved.fingerprint, reserved.index);
        const size = files[reserved.index].size;
        wantedSizes.set(size, (wantedSizes.get(size) ?? 0) + 1);
      }
      // Stale, deleted, unreadable or changed donors fall back to requesting the client's own bytes.
    }
  });
  if (failure) throw failure; // Settle in-flight copies before the caller removes the staging directory.
  signal?.throwIfAborted();
  const selected = [...missing].sort((a, b) => a - b);
  return {
    missing: selected,
    aliases,
    reusedFiles: files.length - selected.length,
    reusedBytes:
      files.reduce((sum, file) => sum + file.size, 0) - selected.reduce((sum, index) => sum + files[index].size, 0),
  };
}

export async function materializeReferenceAliases(staging: string, aliases: ReferenceReuse['aliases']) {
  // Independent copies keep each installed course usable after its donor is edited or removed.
  for (const alias of aliases) {
    const destination = join(staging, alias.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(staging, alias.source), destination, constants.COPYFILE_EXCL);
  }
}
