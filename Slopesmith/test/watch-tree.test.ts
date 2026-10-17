// tier: fast

/**
 * The tree watch behind the maps library and the projects folder (src/server/watch-tree.ts).
 *
 * The guarded failure: Node's `recursive: true` on Linux opens an inotify watch per FILE. The production map
 * library is tens of thousands of files against a per-user cap of about 30,000, so the walk ran out part-way,
 * the projects watch opened after it got nothing, and neither said so. The directory walk must hold one watch
 * per directory, still see everything a recursive watch saw — a level renamed in whole, an edit deep inside it,
 * a project manifest's atomic write — and report a directory it could not watch instead of going quiet.
 *
 * Run: `npx tsx test/watch-tree.test.ts`
 */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchTree, type TreeWatch } from '../src/server/watch-tree';
import { check, failures } from './check';

const scratch = mkdtempSync(join(tmpdir(), 'slopesmith-watch-tree-'));
const NATIVE = process.platform === 'win32' || process.platform === 'darwin';

async function until(ready: () => boolean, ms = 5_000): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (ready()) return true;
    await new Promise(next => setTimeout(next, 25));
  }
  return ready();
}

function files(dir: string, count: number): void {
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < count; i++) writeFileSync(join(dir, `${i}.json`), '{}');
}

/** One recorder per watch: every reported path, with separators made comparable. */
function recorder(): { seen: Set<string>; listener: (name: string | null) => void } {
  const seen = new Set<string>();
  return { seen, listener: name => seen.add(name === null ? '<null>' : name.replace(/\\/g, '/')) };
}

async function exercise(recursive: boolean): Promise<void> {
  const mode = recursive ? 'recursive' : 'walk';
  const root = join(scratch, mode, 'maps');
  const outside = join(scratch, mode, 'upload');
  files(join(root, 'GARI', 'Textures'), 40);
  files(join(root, 'GARI'), 20);
  const { seen, listener } = recorder();
  const errors: Error[] = [];
  let tree: TreeWatch | undefined;
  try {
    tree = await watchTree(root, listener, { recursive, onError: error => errors.push(error) });
    const watching = tree;
    check(
      watching.directories === (recursive ? 1 : 3),
      `${mode}: one watch per directory, none per file`,
      `${watching.directories} watches for 3 directories`,
    );

    writeFileSync(join(root, 'GARI', 'Textures', '7.json'), '{"edited":true}');
    check(await until(() => seen.has('GARI/Textures/7.json')), `${mode}: an edit two levels down is reported`);

    // An install script stages a level elsewhere and renames it in whole; its contents predate any watch.
    files(join(outside, 'SSX3_ARA1', 'Lightmaps'), 30);
    renameSync(join(outside, 'SSX3_ARA1'), join(root, 'SSX3_ARA1'));
    check(await until(() => seen.has('SSX3_ARA1')), `${mode}: a level renamed in is reported`);
    if (!recursive) {
      check(
        await until(() => watching.directories === 5),
        'walk: the renamed-in level and its folders are watched',
        `${watching.directories} watches`,
      );
      check(
        await until(() => seen.has('SSX3_ARA1/Lightmaps/12.json')),
        'walk: what the renamed-in level already held is reported too',
      );
    }
    writeFileSync(join(root, 'SSX3_ARA1', 'Lightmaps', 'late.json'), '{}');
    check(
      await until(() => seen.has('SSX3_ARA1/Lightmaps/late.json')),
      `${mode}: an edit inside the renamed-in level is reported`,
    );

    // The projects watch's case: a new folder, then a manifest written as a temporary renamed over the name.
    mkdirSync(join(root, 'project-1'));
    writeFileSync(join(root, 'project-1', 'project.json.tmp'), '{}');
    renameSync(join(root, 'project-1', 'project.json.tmp'), join(root, 'project-1', 'project.json'));
    check(
      await until(() => seen.has('project-1/project.json')),
      `${mode}: an atomic manifest write in a new folder is reported`,
    );

    // Windows refuses to finish removing a directory while a watch on it is open, so this half is POSIX-only.
    if (!recursive && process.platform !== 'win32') {
      rmSync(join(root, 'SSX3_ARA1'), { recursive: true });
      check(
        await until(() => watching.directories === 4),
        'walk: a removed level gives its watches back',
        `${watching.directories} watches`,
      );
    }
    check(errors.length === 0, `${mode}: nothing reported as unwatched`, errors.map(e => e.message).join('; '));
  } finally {
    tree?.close();
  }
  check(tree?.directories === 0, `${mode}: closing releases every watch`);
}

/** A kernel out of watches: the directory it refuses is reported once, and the walk carries on beneath it. */
async function exhausted(): Promise<void> {
  const root = join(scratch, 'exhausted');
  files(join(root, 'BLOCKED', 'Textures'), 5);
  files(join(root, 'OPEN'), 5);
  const limited = ((path: string, ...rest: unknown[]) => {
    if (/[\\/]BLOCKED$/.test(String(path))) {
      throw Object.assign(new Error(`ENOSPC: System limit for number of file watchers reached, watch '${path}'`), {
        code: 'ENOSPC',
      });
    }
    return (watch as (...args: unknown[]) => ReturnType<typeof watch>)(path, ...rest);
  }) as typeof watch;
  const { seen, listener } = recorder();
  const errors: Error[] = [];
  const tree = await watchTree(root, listener, { recursive: false, watch: limited, onError: e => errors.push(e) });
  try {
    check(errors.length === 1, 'exhausted: the refused directory is reported, once', `${errors.length} reports`);
    const message = errors[0]?.message ?? '';
    check(
      /^1 directory under .* could not be watched/.test(message) && message.includes('max_user_watches'),
      'exhausted: the report counts what is unwatched and names the limit to raise',
      message,
    );
    check(
      tree.directories === 3,
      'exhausted: the folders beside and below it are still watched',
      `${tree.directories} watches`,
    );
    writeFileSync(join(root, 'BLOCKED', 'Textures', 'late.json'), '{}');
    check(
      await until(() => seen.has('BLOCKED/Textures/late.json')),
      'exhausted: an edit below the refused directory is still reported',
    );
  } finally {
    tree.close();
  }
}

try {
  await exercise(false);
  if (NATIVE) await exercise(true);
  await exhausted();
} finally {
  rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

if (failures) process.exitCode = 1;
else console.log('WATCH TREE PASS');
