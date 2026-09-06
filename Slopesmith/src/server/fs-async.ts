import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Asynchronous filesystem access for the server, in the shapes the routes actually use.
 *
 * Every read here is a single syscall that treats absence as a value rather than an exception, because the
 * pattern these replace — `existsSync(file) ? readFileSync(file) : fallback` — costs two syscalls and races:
 * a file removed between the probe and the read throws from a branch written on the assumption it could not.
 * With several people driving one server, that window is no longer theoretical.
 *
 * `Sync` variants are absent on purpose. A synchronous read blocks the event loop for every connected client,
 * not just the one waiting on it, so a slow spinning disk or a cold Windows filesystem stalls the whole server.
 */

/** Errors that mean "not there", as opposed to a fault the caller should hear about. */
const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** Rethrow anything that is not simple absence, so a permissions fault is never silently read as an empty
 *  library — the failure mode that makes a misconfigured path look like data loss. */
const missingOrThrow = <T>(error: unknown, absent: T): T => {
  if (isMissing(error)) return absent;
  throw error;
};

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch { return false; }
}

export async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

export async function isFile(path: string): Promise<boolean> {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/** File bytes, or null when the file is not there. */
export async function readBytesOrNull(file: string): Promise<Buffer | null> {
  try { return await readFile(file); } catch (error) { return missingOrThrow(error, null); }
}

/** File text, or null when the file is not there. */
export async function readTextOrNull(file: string): Promise<string | null> {
  try { return await readFile(file, 'utf8'); } catch (error) { return missingOrThrow(error, null); }
}

/** Parsed JSON. Throws with the file named on both absence and malformed content, so a failing route says
 *  which file is wrong rather than reporting a bare `Unexpected token`. */
export async function readJson<T>(file: string): Promise<T> {
  const text = await readTextOrNull(file);
  if (text === null) throw new Error(`no such file: ${file}`);
  try { return JSON.parse(text) as T; }
  catch (error) { throw new Error(`invalid JSON in ${file}: ${String(error instanceof Error ? error.message : error)}`, { cause: error }); }
}

/** Parsed JSON, or the fallback when the file is absent *or* unreadable. The many reference readers that
 *  degrade to an empty overlay rather than failing a page load want exactly this. */
export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try {
    const text = await readTextOrNull(file);
    return text === null ? fallback : JSON.parse(text) as T;
  } catch { return fallback; }
}

/** Directory entry names, or an empty list when the directory is absent. */
export async function listDir(dir: string): Promise<string[]> {
  try { return await readdir(dir); } catch (error) { return missingOrThrow(error, [] as string[]); }
}

/** Directory entries with their kind, for callers that filter files from subdirectories without a stat each. */
export async function listEntries(dir: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean }>> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .map(entry => ({ name: entry.name, isFile: entry.isFile(), isDirectory: entry.isDirectory() }));
  } catch (error) { return missingOrThrow(error, []); }
}

/** Subdirectory names only. */
export async function listSubdirectories(dir: string): Promise<string[]> {
  return (await listEntries(dir)).filter(entry => entry.isDirectory).map(entry => entry.name);
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * The canonical on-disk form of a directory, for the callers that hand a path to a recursive `fs.watch`.
 *
 * On Windows a perfectly ordinary path can reach a directory through an 8.3 short component: any folder or
 * account name too long for the old limit has one, and `os.tmpdir()` on a GitHub Actions runner is literally
 * `C:\Users\RUNNER~1\AppData\Local\Temp`. libuv expands the paths a recursive watch reports to their long form
 * and then strips the watched directory off the front to make the name it passes back. Opened on the short
 * form, that prefix no longer matches, and the assert guarding the subtraction
 * (`!_wcsnicmp(filename, dir, dirlen)`, `src\win\fs-event.c`) *aborts the process* — 0xC0000409, which no
 * `'error'` listener gets to see and no `try` can catch. Watching the canonical path keeps the prefix libuv
 * expects, so the event arrives instead of taking the server down with it.
 *
 * Falls back to the path as given when it cannot be resolved: every caller has already established that the
 * directory is there, and a watch is worth attempting even on a path this could not canonicalise.
 */
export async function canonicalDir(dir: string): Promise<string> {
  try { return await realpath(dir); } catch { return dir; }
}

/**
 * Write a file so a reader never observes a partial one: write a uniquely named temporary beside it and
 * rename, which is atomic within a filesystem. The name carries the pid and a UUID rather than a timestamp
 * because two writers in the same millisecond is ordinary once a server has several clients, and a shared
 * temporary name means one writer renaming the other's half-written bytes into place.
 */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  await ensureDir(dirname(file));
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, data);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => { /* the original failure is the one worth reporting */ });
    throw error;
  }
}

export async function writeJsonAtomic(file: string, value: unknown, pretty = true): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, pretty ? 2 : undefined) + (pretty ? '\n' : ''));
}

/** Size and nanosecond timestamps, or null when absent — the inputs to a cache fingerprint. */
export async function fileStamp(file: string): Promise<string | null> {
  try {
    const info = await stat(file, { bigint: true });
    return `${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) { return missingOrThrow(error, null); }
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving result order.
 *
 * Converting a sequential loop of synchronous reads into `Promise.all` over an entire directory replaces one
 * blocking read with thousands of concurrent open file handles, which on a large extracted level exhausts the
 * descriptor limit (EMFILE). Bounded concurrency is what makes the conversion an improvement rather than a
 * different failure.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number,
  worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** The default in-flight cap for bulk reads: high enough to keep the disk busy, low enough to stay far from
 *  the descriptor limit when several clients each run a bulk read at once. */
export const READ_CONCURRENCY = 32;
