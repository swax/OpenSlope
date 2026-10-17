import { watch, type Dirent, type FSWatcher, type WatchEventType } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { canonicalDir } from './fs-async';

/** What one walk could not watch: a count, and the first reason, for one report rather than one per folder. */
interface Unwatched {
  failed: number;
  error?: Error;
}

const gone = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** Told the path of what changed, relative to the watched root, or null when the platform did not say. */
export type TreeListener = (filename: string | null) => void;

export interface TreeWatchOptions {
  /** Part of the tree could not be watched, so changes inside it go unnoticed until the next restart. */
  onError?: (error: Error) => void;
  /** Whether to use the platform's own recursive watch. Defaults to true only where that is one kernel handle. */
  recursive?: boolean;
  /** The single-directory watch primitive. Tests substitute one that fails the way an exhausted kernel does. */
  watch?: typeof watch;
}

export interface TreeWatch {
  /** Directories holding a watch of their own; 1 under a recursive platform watch. */
  readonly directories: number;
  close(): void;
}

/** Windows (ReadDirectoryChangesW) and macOS (FSEvents) watch a whole tree with one handle. */
const NATIVE_RECURSIVE = process.platform === 'win32' || process.platform === 'darwin';

/**
 * Watch every change beneath `root`, holding one kernel watch per DIRECTORY.
 *
 * Outside Windows and macOS, Node's `recursive: true` is a JavaScript walk that opens an inotify watch on
 * every FILE as well as every directory, and Linux caps watches per user (`max_user_watches`, about 30,000 on
 * a 4-GiB host). A map library is tens of thousands of files, so that walk ran out part-way: the folders it
 * never reached went unwatched, the projects watch opened after it got nothing, and because Node's start
 * swallows the error neither said so. A watch on a directory already reports its children being
 * created, removed, renamed or written, so files need no watch of their own; this walks directories only,
 * which keeps the cost at the directory count — a few hundred for a whole library.
 *
 * A directory that appears is walked when its parent reports it, and every entry found inside is reported as
 * well, since it may have been written before its watch existed. A directory that disappears gives its watches
 * back. A directory that cannot be watched is counted and reported once per walk through `onError` rather than
 * stopping the rest.
 */
export async function watchTree(
  root: string,
  listener: TreeListener,
  options: TreeWatchOptions = {},
): Promise<TreeWatch> {
  // Canonical, because a recursive watch opened on an 8.3 short path aborts the process — see `canonicalDir`.
  // Everything reported is relative to whatever was watched, so the rest works off that path.
  const base = await canonicalDir(root);
  if (options.recursive ?? NATIVE_RECURSIVE) {
    const watcher = watch(base, { recursive: true }, (_event, filename) =>
      listener(filename === null ? null : filename.toString()),
    );
    // Losing the watch costs freshness, never correctness: every response is still ETag-validated.
    watcher.on('error', error => options.onError?.(error));
    let live = true;
    return {
      get directories() {
        return live ? 1 : 0;
      },
      close: () => {
        live = false;
        watcher.close();
      },
    };
  }

  const open = options.watch ?? watch;
  const watchers = new Map<string, FSWatcher>();
  let closed = false;

  const forget = (dir: string): void => {
    for (const [path, watcher] of watchers) {
      if (path === dir || path.startsWith(dir + sep)) {
        watcher.close();
        watchers.delete(path);
      }
    }
  };

  /** Watch `dir` and the directories below it. Returns what could not be watched, for the caller to report. */
  const walk = async (dir: string, announce: boolean): Promise<Unwatched> => {
    if (closed || watchers.has(dir)) return { failed: 0 };
    const result: Unwatched = { failed: 0 };
    const miss = (error: unknown): void => {
      result.failed++;
      result.error ??= error as Error;
    };
    try {
      // Watch before listing: anything created after the watch is reported, anything before it is listed.
      const watcher = open(dir, (event, name) => changed(dir, event, name));
      watcher.on('error', () => {
        watcher.close();
        if (watchers.get(dir) === watcher) watchers.delete(dir);
      });
      watchers.set(dir, watcher);
    } catch (error) {
      if (gone(error)) return { failed: 0 };
      // Still walk it: the directories below may have room for a watch even though this one did not.
      miss(error);
    }
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      // A directory removed while being walked is simply gone, not a hole in the watch.
      if (gone(error)) {
        forget(dir);
        return { failed: 0 };
      }
      if (watchers.has(dir)) miss(error);
      return result;
    }
    if (closed) return { failed: 0 };
    await Promise.all(
      entries.map(async entry => {
        const path = join(dir, entry.name);
        if (announce) listener(relative(base, path));
        if (!entry.isDirectory()) return;
        const below = await walk(path, announce);
        result.failed += below.failed;
        result.error ??= below.error;
      }),
    );
    return result;
  };

  const report = (result: Unwatched): void => {
    if (!result.failed || !result.error) return;
    const cause = result.error as NodeJS.ErrnoException;
    const hint = cause.code === 'ENOSPC' ? '; raise fs.inotify.max_user_watches' : '';
    const count = `${result.failed} ${result.failed === 1 ? 'directory' : 'directories'}`;
    options.onError?.(new Error(`${count} under ${base} could not be watched (${cause.message})${hint}`, { cause }));
  };

  const changed = (dir: string, event: WatchEventType, name: string | null): void => {
    if (closed) return;
    if (name === null) {
      listener(null);
      return;
    }
    const path = join(dir, name);
    listener(relative(base, path));
    // A write or an attribute change cannot add or remove a directory; only a 'rename' can.
    if (event !== 'rename') return;
    // That covers a create, a delete and both halves of a move alike, so ask the disk which this was.
    void lstat(path).then(
      stats => {
        if (stats.isDirectory()) return walk(path, true).then(report);
        if (watchers.has(path)) forget(path);
      },
      () => {
        if (watchers.has(path)) forget(path);
      },
    );
  };

  report(await walk(base, false));
  return {
    get directories() {
      return watchers.size;
    },
    close: () => {
      closed = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}
