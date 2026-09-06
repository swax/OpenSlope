/** Concurrent-client guarantees for the project service: per-client active project, no lost update between
 * two simultaneous saves, and a serialized read-modify-write of the session file.
 * Run: `npx tsx test/project-concurrency.test.ts` */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { defaultMountain } from '../src/core/doc/mountain';
import { globalRegister } from '../src/core/doc/registers';
import {
  ProjectConflictError, activateProject, createProject, currentProject, deleteProject, listProjects,
  openProject, saveProject, watchProjectWrites,
} from '../src/server/projects';
import { assign, configureRooms, joinRoom, takeSnapshot } from '../src/server/session/room';
import { ensureWorkspace, forgetWorkspaceConfig } from '../src/server/workspace-config';
import { serialize } from '../src/server/serialize';
import { check, failures } from './check';

const execFileAsync = promisify(execFile);
const seedOf = (doc: unknown): unknown => (doc as { aiSeed?: unknown }).aiSeed;

const root = mkdtempSync(join(tmpdir(), 'slopesmith-concurrency-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();

try {
  await ensureWorkspace();

  // Two editors, two projects.
  const alpha = await createProject({ ...defaultMountain(), name: 'Alpha' }, 'tab-a');
  const beta = await createProject({ ...defaultMountain(), name: 'Beta' }, 'tab-b');

  check((await currentProject('tab-a'))?.project.id === alpha.project.id,
    'each client keeps its own active project');
  check((await currentProject('tab-b'))?.project.id === beta.project.id,
    "a second client's project does not displace the first");

  // The bug this guards: one global activeProjectId meant the later opener silently reassigned the earlier.
  await activateProject(beta.project.id, 'tab-b');
  check((await currentProject('tab-a'))?.project.id === alpha.project.id,
    'activating in one client leaves the other client pointed at its own project');

  // Simultaneous activation from many clients must not lose entries to a read-modify-write race.
  const ids = Array.from({ length: 12 }, (_, i) => `tab-${i}`);
  await Promise.all(ids.map(id => activateProject(i(id) % 2 ? alpha.project.id : beta.project.id, id)));
  const resolved = await Promise.all(ids.map(id => currentProject(id)));
  check(resolved.every(snapshot => snapshot !== null),
    'concurrent activations all survive in the session file');

  // Two saves of the same project from the same base revision: exactly one wins, the other sees a conflict.
  const doc = structuredClone(alpha.document);
  const first = { ...doc, name: 'Alpha One' };
  const second = { ...doc, name: 'Alpha Two' };
  const base = alpha.project.revision;
  const outcomes = await Promise.allSettled([
    saveProject(alpha.project.id, base, first),
    saveProject(alpha.project.id, base, second),
  ]);
  const fulfilled = outcomes.filter(o => o.status === 'fulfilled');
  const conflicted = outcomes.filter(o => o.status === 'rejected' && o.reason instanceof ProjectConflictError);
  check(fulfilled.length === 1 && conflicted.length === 1,
    'two concurrent saves from one base revision: one commits, one is refused as a conflict');

  const after = await currentProject('tab-a');
  check(after?.project.revision === base + 1,
    'the revision advances exactly once, so neither edit is silently overwritten');

  // Deleting a map and renaming it take the same two queues — the projects library's name lock, because both
  // free a name, and the project's own, because both touch its folder. Both take the library FIRST. Taking
  // them in opposite orders would not be a race but a deadlock: the delete holding the library while it waits
  // for the project, the rename holding the project while it waits for the library, and neither ever moving.
  // So this is asserted against a clock — a regression here hangs rather than fails.
  const doomed = await createProject({ ...defaultMountain(), name: 'Doomed' }, 'tab-x');
  const racing = Promise.allSettled([
    deleteProject(doomed.project.id),
    saveProject(doomed.project.id, doomed.project.revision, { ...doomed.document, name: 'Doomed Renamed' }),
  ]);
  let clock: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    racing.then(() => 'settled'),
    new Promise<string>(done => { clock = setTimeout(() => done('deadlocked'), 5_000); }),
  ]);
  clearTimeout(clock);
  check(outcome === 'settled', 'a delete racing a rename of the same map settles rather than deadlocking');
  check(!(await listProjects()).some(project => project.id === doomed.project.id),
    'and the map is gone whichever of the two went first');

  // ---- a write from ANOTHER PROCESS, while a room holds the map open --------------------------------------
  //
  // The bug this guards cost a finished build. `announceWrite` is an in-process event, so a headless recipe
  // saving the project reaches the file and no listener; the room went on holding its older document and its
  // next snapshot wrote that over the recipe's work under a higher revision. Two independent defences, one
  // test each: the snapshot carries the revision the room last saw, and the file is watched.

  // The room's own cadence is a timer, so it is taken out of the picture: every snapshot below is one this
  // test asked for, and none of it depends on which of two clocks won.
  const cadence = configureRooms({ snapshotIdleMs: 60_000, snapshotChanges: Number.MAX_SAFE_INTEGER });
  try {
    // 1 · the snapshot cannot overwrite what it has not seen, watch or no watch.
    const held = await createProject({ ...defaultMountain(), name: 'Held' }, 'tab-h');
    const room = await joinRoom(held.project.id);
    assign(room, [[globalRegister('aiSeed'), 4242]]);         // something for the snapshot to be about
    const outsideRevision = await saveOutside(held.project.id, 777);
    check(outsideRevision > room.wrote, 'another process advanced the project past what the room had seen');
    await takeSnapshot(room);
    const afterSnapshot = await openProject(held.project.id);
    check(seedOf(afterSnapshot.document) === 777,
      "a room snapshot does not overwrite another process's newer write");
    check(seedOf(room.doc) === 777 && room.wrote === afterSnapshot.project.revision,
      'the room adopts what landed instead, and knows the revision it is now on');

    // 2 · and the watch tells it promptly, without waiting for a snapshot that may never come.
    const stopWatching = await watchProjectWrites();
    try {
      const watched = await createProject({ ...defaultMountain(), name: 'Watched' }, 'tab-w');
      const watchedRoom = await joinRoom(watched.project.id);
      await saveOutside(watched.project.id, 999);
      check(await until(() => seedOf(watchedRoom.doc) === 999, 5_000),
        'the projects watch turns an out-of-process write into the revision event rooms handle');
    } finally {
      stopWatching();
    }
  } finally {
    configureRooms(cadence);
  }

  // The queue orders work per key and keeps unrelated keys independent.
  const order: number[] = [];
  const slow = (n: number, ms: number) => serialize('k', async () => {
    await new Promise(r => setTimeout(r, ms));
    order.push(n);
  });
  await Promise.all([slow(1, 30), slow(2, 1), slow(3, 1)]);
  check(order.join(',') === '1,2,3', 'serialize runs same-key work in submission order');

  let failedRan = false;
  await serialize('k2', async () => { throw new Error('boom'); }).catch(() => undefined);
  await serialize('k2', async () => { failedRan = true; });
  check(failedRan, 'a failed task does not poison its queue');
} finally {
  delete process.env.SLOPESMITH_WORKSPACE_ROOT;
  delete process.env.SLOPESMITH_MAPS_ROOT;
  rmSync(root, { recursive: true, force: true });
}

function i(id: string): number { return Number(id.split('-')[1]); }

/**
 * Save a project from a SEPARATE PROCESS, which is the whole point: an in-process save announces itself and
 * every room hears it, so nothing about the hazard would be reproduced by calling `saveProject` here.
 */
async function saveOutside(id: string, aiSeed: number): Promise<number> {
  const appRoot = fileURLToPath(new URL('..', import.meta.url));
  const module = pathToFileURL(join(appRoot, 'src', 'server', 'projects.ts')).href;
  const file = join(root, `outside-${id}.mjs`);
  // `aiSeed` rather than the name: a map's name never overwrites another map's, so renaming would drag the
  // free-name machinery into a test about revisions.
  writeFileSync(file, `
    const { openProject, saveProject } = await import(${JSON.stringify(module)});
    const snapshot = await openProject(${JSON.stringify(id)});
    const saved = await saveProject(${JSON.stringify(id)}, snapshot.project.revision,
      { ...snapshot.document, aiSeed: ${aiSeed} });
    process.stdout.write(String(saved.project.revision));
  `);
  const { stdout } = await execFileAsync(process.execPath, ['--import', 'tsx', file], {
    cwd: appRoot,
    env: { ...process.env, SLOPESMITH_WORKSPACE_ROOT: root, SLOPESMITH_MAPS_ROOT: root },
  });
  return Number(stdout.trim());
}


/** Poll a condition the way a watch makes one true: eventually, and not on any schedule this test sets. */
async function until(ready: () => boolean, ms: number): Promise<boolean> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) {
    if (ready()) return true;
    await new Promise(next => setTimeout(next, 50));
  }
  return ready();
}

if (failures) process.exitCode = 1;
else console.log('PROJECT CONCURRENCY PASS');
