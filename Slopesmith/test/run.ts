/**
 * The Slopesmith test runner: a short edit-time tier and the complete discovered gate.
 *
 *   npx tsx test/run.ts --tier fast # short feedback loop used by `npm test`
 *   npx tsx test/run.ts --tier integration # server/browser/heavy checks without the fast tier
 *   npx tsx test/run.ts --tier full # everything a fresh clone can run — this is what CI runs
 *   npx tsx test/run.ts --tier full --local # adds checks needing extracted Maps data on this machine
 *   npx tsx test/run.ts --only ride # substring filter, for iterating on one area
 *   npx tsx test/run.ts --jobs 1    # one at a time, for readable output when something is failing
 *   npx tsx test/run.ts --list      # print what would run and exit
 *
 * The suite is DISCOVERED, not listed. `test/*.test.ts` is the whole set (this runner is `run.ts`, so it
 * is not swept up by its own glob), so a new check joins the
 * gate by existing — there is no second place to remember to append to. That is deliberate: this file
 * replaced ~50 hand-written `test:*` npm scripts of which only five were reachable from `npm test`, which is
 * how four real regressions sat green in the tree (a room snapshot that silently dropped edits, a retopology
 * interface that swallowed the mountain rim, and two fixtures left behind by moves they should have followed).
 *
 * The tier is read off the check too, not off a list here: a file whose first lines carry `// tier: fast` is
 * in the short loop `npm test` runs, and a file with no marker is in the integration tier. So a new check
 * cannot slow the edit-time loop by accident, and there is still nothing in this file to keep in step with the
 * directory. The only names written down below are the few with a constraint the file itself cannot express
 * (needs disc data, must not overlap a sibling, must run alone), and a stale one fails the run rather than
 * silently doing nothing.
 *
 * Checks run CONCURRENTLY, longest-first. Two things make that safe, and both are properties of the checks
 * rather than of this file: anything with state on disk redirects its roots into its own `mkdtemp` through
 * `SLOPESMITH_*_ROOT`, and anything that stands up a service binds `port: 0`. Nothing shares a fixed path or a
 * fixed port, so nothing collides. Keep it that way — a check that writes to a hardcoded location is a check
 * that fails only when the machine is busy, which is the worst kind. The perf claims in `rebuild.test.ts` are
 * ratios against a full rebuild measured in the same process, so they hold under load too; the async waits
 * elsewhere are multi-second deadlines, not budgets.
 *
 * Each check is spawned as `node --import tsx <file>` rather than `npx tsx <file>`. Same resolution, same
 * loader, but `npx` costs an extra ~0.75s of process startup per check — a minute across the suite, spent
 * entirely on resolving a binary that is sitting in `node_modules`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Where the last run's durations are remembered, so this one can start the long poles first. Ignored by git. */
const TIMINGS = join(root, 'temp', 'test-timings.json');
/** What an unseen check is assumed to cost when ordering: about the median, so a new file lands mid-pack. */
const UNKNOWN_MS = 1_500;

/**
 * Checks that read a level this repository does not ship. They need `Maps/` populated by `snowknife` from the
 * user's own disc, so they cannot run on a clean clone and are out of the default gate — `--local` adds them.
 * Everything else builds its own fixtures and runs anywhere; keep it that way, and this list at two.
 */
const NEEDS_LOCAL_DATA = new Set([
  'collision-lab.test.ts',   // grades the collision lab against retail AUTOTEST geometry
  'race-music.test.ts',      // reads a shipped level's extracted music bank
  'sky.test.ts',             // measures every shipped level's sky ring off its own meshes
]);

/**
 * A check declares its own tier. `// tier: fast` in its first lines puts it in the edit-time loop `npm test`
 * runs; no marker means the integration tier. The complete gate stays discovery-based — every `*.test.ts` runs
 * in the full tier whatever its head says — so a new check joins CI merely by existing, and it cannot make
 * `npm test` slower until someone writes the marker, which is the moment to know it is quick, deterministic
 * under load, and independent of a real service, browser, or external tool.
 *
 * The integration tier holds both conventional integration checks and CPU-heavy correctness/performance
 * checks, because both have the same workflow property: valuable in the required gate, too expensive or
 * load-sensitive for every browser-edit iteration.
 */
const TIER_MARKER = /^\/\/\s*tier:\s*(\S+)\s*$/;
/** How far into a file the marker is looked for: its head, beside the file's own description, never its code. */
const MARKER_WINDOW = 20;

/** The tier a check's head declares. A misspelt tier is an error, not a silent demotion to integration. */
function declaredTier(name: string): Exclude<Tier, 'full'> {
  const head = readFileSync(join(here, name), 'utf8').split(/\r?\n/, MARKER_WINDOW);
  for (const line of head) {
    const declared = TIER_MARKER.exec(line)?.[1];
    if (declared === undefined) continue;
    if (declared === 'fast' || declared === 'integration') return declared;
    throw new Error(`test/${name} declares tier "${declared}"; a check is fast or integration`);
  }
  return 'integration';
}

/**
 * Checks assigned the same resource-group name may never run at the same time, regardless of `--jobs`.
 *
 * All three stand up the API service over the accounts store and the on-disk library cache. Run together they
 * fail on cache entries and token rows they did not write; run alone, each passes. That reproduced reliably
 * enough to be mistaken for a property of the machine, and it was cheaper to call it a known flake than to
 * find it — which is exactly the cost of leaving it. They still overlap the REST of the suite, so the gate's
 * wall clock is unchanged: it is pinned by `rebuild.test.ts`, which is longer than these three end to end.
 *
 * Not the same thing as `sessions.test.ts`, which fails on a saturated machine EVEN RUN ALONE. That one is
 * about total load rather than about who else touches its state, and serialising cannot help it.
 */
const EXCLUSIVE_GROUP = new Map([
  ['access-tokens.test.ts', 'shared-service-state'],
  ['blender-routes.test.ts', 'shared-service-state'],
  ['hateoas-api.test.ts', 'shared-service-state'],
  ['library-cache.test.ts', 'shared-service-state'],
  // Each launches a full installed browser and software WebGL device. Sharing the machine rather than starting
  // several SwiftShader processes at once costs no wall time beside the long CPU checks and removes needless load.
  ['particle-blend-webgl.test.ts', 'browser-webgl'],
  ['prop-shader-webgl.test.ts', 'browser-webgl'],
  ['snowfall-webgl.test.ts', 'browser-webgl'],
]);

/**
 * This real-socket check has deadlines wide enough for an ordinary machine but is known to fail when unrelated
 * CPU-heavy checks saturate the event loop. Giving it the worker pool briefly is cheaper than retrying a red
 * gate and does not extend the usual wall clock: the full tier's long rebuild check already runs for longer.
 */
const RUN_ALONE = new Set(['sessions.test.ts']);

/** A check spawned through the TypeScript loader, without paying for an `npx` resolution to find it. */
const tsx = (file: string, ...args: string[]): { command: string; args: string[] } =>
  ({ command: process.execPath, args: ['--import', 'tsx', file, ...args] });

/**
 * Checks that take arguments, so a bare glob run would execute them without asserting anything. They are
 * declared here rather than left to a package.json chain, so this file remains the single answer to "what
 * does the gate run?".
 */
type Tier = 'fast' | 'integration' | 'full';

const WITH_ARGUMENTS: {
  label: string;
  command: string;
  args: string[];
  tier: Exclude<Tier, 'full'>;
  localOnly?: boolean;
}[] = [
  // Bank/file identifiers remain available offline, but live in one reviewed catalog rather than three copies.
  { label: 'external-sound banks (generated views)', command: 'python', tier: 'fast',
    args: ['tools/generate_audio_bank_catalog.py', '--check'] },
  // The ride contract is generated from one source and checked against both Slopesmith and Unity views.
  { label: 'ride-contract (generated views)', command: 'python', tier: 'fast',
    args: ['tools/generate_ride_contract.py', '--unity', '--check'] },
  // jump-trace is a diagnostic first (it prints a trace) and a check second (`assert` turns on the pins).
  // Both jump shapes, faceted and smooth, are contract surface for the ported ride model.
  ...['kicker', 'roller'].flatMap(shape => [
    { label: `jump-trace ${shape}`, tier: 'fast' as const,
      ...tsx('tools/ride-study/jump-trace.ts', shape, 'assert', 'quiet') },
    { label: `jump-trace ${shape} faceted`,
      tier: 'fast' as const,
      ...tsx('tools/ride-study/jump-trace.ts', shape, 'faceted', 'assert', 'quiet') },
  ]),
  // Race a retail level's own AI field and assert the run still completes in budget. Needs MEGAPLE extracted.
  { label: 'ai-course-run MEGAPLE', tier: 'integration', localOnly: true,
    ...tsx('scripts/ai-course-run.ts', 'MEGAPLE', '360', '--assert') },
];

const argv = process.argv.slice(2);
const local = argv.includes('--local');
const listOnly = argv.includes('--list');
const tierAt = argv.indexOf('--tier');
const tierValue = tierAt < 0 ? 'full' : argv[tierAt + 1];
if (!['fast', 'integration', 'full'].includes(tierValue)) {
  throw new Error(`--tier must be fast, integration, or full (received ${tierValue ?? 'nothing'})`);
}
const tier = tierValue as Tier;
const only = argv[argv.indexOf('--only') + 1];
const filter = argv.includes('--only') && only && !only.startsWith('--') ? only : null;
const selectionLabel = filter ? `filter ${JSON.stringify(filter)}` : `${tier} tier`;
const askedJobs = Number(argv[argv.indexOf('--jobs') + 1]);
/**
 * Deliberately well under the core count. The gate's wall clock is pinned by its longest single check
 * (`rebuild.test.ts`, ~50s) rather than by throughput — the rest of the suite is ~165s of work, which six at a
 * time finishes inside that window anyway. So the cores left idle here buy nothing in speed and cost nothing:
 * they are headroom, and headroom is what keeps the checks that wait on sockets and debounce windows off their
 * deadlines. Those waits are seconds wide and hold fine on an unloaded machine; saturate the box and they
 * start to flake (`sessions.test.ts` will fail on a SATURATED MACHINE EVEN RUN ALONE, so this is a property of
 * the checks, not of running them together). Raise `--jobs` if `rebuild` is ever sharded and the floor drops.
 */
const jobs = argv.includes('--jobs') && Number.isFinite(askedJobs) && askedJobs > 0
  ? Math.floor(askedJobs)
  : Math.max(1, Math.min(6, availableParallelism() - 1));

const allDiscovered = readdirSync(here)
  .filter(name => name.endsWith('.test.ts'))
  .sort();
const listedHere = [...NEEDS_LOCAL_DATA, ...EXCLUSIVE_GROUP.keys(), ...RUN_ALONE];
const missingListed = listedHere.filter(name => !allDiscovered.includes(name));
if (missingListed.length) {
  throw new Error(`run.ts names checks that no longer exist: ${missingListed.join(', ')}`);
}
const tierOf = new Map(allDiscovered.map(name => [name, declaredTier(name)] as const));
const inTier = (name: string): boolean => tier === 'full' || tierOf.get(name) === tier;
const discovered = allDiscovered
  .filter(name => local || !NEEDS_LOCAL_DATA.has(name))
  // An explicit area filter is an iteration request and may reach any tier. This keeps
  // `npm test -- --only sync` useful even though the unfiltered `npm test` is the fast tier.
  .filter(name => filter || inTier(name))
  .filter(name => !filter || name.includes(filter))
  .sort();

const extra = filter ? [] : WITH_ARGUMENTS
  .filter(one => tier === 'full' || one.tier === tier)
  .filter(one => local || !one.localOnly);
const skipped = local ? [] : [
  ...[...NEEDS_LOCAL_DATA]
    .filter(name => filter ? name.includes(filter) : inTier(name)),
  ...(filter ? [] : WITH_ARGUMENTS
    .filter(one => one.localOnly && (tier === 'full' || one.tier === tier))
    .map(one => one.label)),
].sort();
const tierOmitted = filter || tier === 'full' ? [] : [
  ...allDiscovered
    .filter(name => !NEEDS_LOCAL_DATA.has(name) && !inTier(name))
    .map(name => `test/${name}`),
  ...WITH_ARGUMENTS
    .filter(one => !one.localOnly && one.tier !== tier)
    .map(one => one.label),
].sort();

interface Job { label: string; command: string; args: string[]; exclusiveGroup?: string; runAlone?: boolean }
const queue: Job[] = [
  ...discovered.map(name => ({
    label: `test/${name}`,
    exclusiveGroup: EXCLUSIVE_GROUP.get(name),
    runAlone: RUN_ALONE.has(name),
    ...tsx(relative(root, join(here, name)).replace(/\\/g, '/')),
  })),
  ...extra.map(one => ({ label: one.label, command: one.command, args: one.args })),
];

if (listOnly) {
  console.log(`${selectionLabel} (${queue.length} checks):`);
  for (const job of queue) console.log(job.label);
  if (skipped.length) console.log(`\nnot run without --local: ${skipped.join(', ')}`);
  if (tierOmitted.length) {
    console.log(`\nnot run in the ${tier} tier (${tierOmitted.length}; use --tier full for the gate):`);
    for (const label of tierOmitted) console.log(label);
  }
  process.exit(0);
}

/** Last run's durations. A miss is not a problem — it only costs a worse starting order this once. */
let known: Record<string, number> = {};
try { known = JSON.parse(readFileSync(TIMINGS, 'utf8')); } catch { /* first run on this machine */ }

// Longest-first. With a 74s pole in the set, starting it last would leave the whole gate waiting on it alone.
queue.sort((a, b) => (known[b.label] ?? UNKNOWN_MS) - (known[a.label] ?? UNKNOWN_MS));

interface Outcome { label: string; ok: boolean; ms: number }
const outcomes: Outcome[] = [];
const started = Date.now();
let next = 0;

/**
 * Run one check to completion, holding its output. Concurrent checks interleave their writes, so a check's
 * output is buffered and printed as one block under its own banner — the same thing a serial run shows, just
 * ordered by when each finished rather than when each started.
 */
function runOne(job: Job): Promise<void> {
  return new Promise(resolve => {
    const at = Date.now();
    const chunks: Buffer[] = [];
    const child = spawn(job.command, job.args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finish = (status: number | null, note?: string): void => {
      const ms = Date.now() - at;
      const ok = status === 0;
      outcomes.push({ label: job.label, ok, ms });
      known[job.label] = ms;
      process.stdout.write(`\n${'='.repeat(78)}\n  ${job.label}  (${(ms / 1000).toFixed(1)}s)\n${'='.repeat(78)}\n`);
      process.stdout.write(Buffer.concat(chunks).toString());
      if (note) process.stdout.write(`\n  ${note}\n`);
      if (!ok) process.stdout.write(`\n  ^ FAILED: ${job.label} (exit ${status})\n`);
      resolve();
    };
    child.on('error', error => finish(null, `could not spawn ${job.command}: ${(error as Error).message}`));
    child.on('close', status => finish(status));
  });
}

/** Mutually-exclusive resource groups currently held by a check. */
const busyGroups = new Set<string>();
let activeJobs = 0;
let aloneBusy = false;

/**
 * Claim the next runnable check, or null when nothing can start right now.
 *
 * Claimed jobs are swapped to the front of the unclaimed region so `next` still advances by one per claim and
 * no job can be taken twice — which is what lets a worker skip a constrained check it may not start yet and come
 * back to it, rather than blocking the whole pool behind it.
 */
function claim(): Job | null {
  if (aloneBusy) return null;
  for (let i = next; i < queue.length; i++) {
    const job = queue[i];
    if (job.runAlone && activeJobs > 0) continue;
    if (job.exclusiveGroup && busyGroups.has(job.exclusiveGroup)) continue;
    queue[i] = queue[next];
    queue[next] = job;
    next++;
    if (job.exclusiveGroup) busyGroups.add(job.exclusiveGroup);
    activeJobs++;
    if (job.runAlone) aloneBusy = true;
    return job;
  }
  return null;
}

async function worker(): Promise<void> {
  for (;;) {
    const job = claim();
    if (!job) {
      if (next >= queue.length) return;
      // Only constrained checks are left and another worker holds the needed slot. Idle rather than spinning;
      // this costs at most one poll interval on a queue that is already seconds wide.
      await new Promise(resolve => { setTimeout(resolve, 25); });
      continue;
    }
    await runOne(job);
    if (job.exclusiveGroup) busyGroups.delete(job.exclusiveGroup);
    activeJobs--;
    if (job.runAlone) aloneBusy = false;
  }
}

await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker));

try {
  mkdirSync(dirname(TIMINGS), { recursive: true });
  writeFileSync(TIMINGS, JSON.stringify(known, null, 2));
} catch { /* the ordering hint is an optimisation; never fail the gate over it */ }

const failed = outcomes.filter(outcome => !outcome.ok);
process.stdout.write(`\n${'='.repeat(78)}\n`);
for (const outcome of [...outcomes].sort((a, b) => b.ms - a.ms).slice(0, 5)) {
  process.stdout.write(`  slowest: ${(outcome.ms / 1000).toFixed(1)}s  ${outcome.label}\n`);
}
if (skipped.length) {
  process.stdout.write(`\n  not run (needs extracted Maps data — use --local): ${skipped.join(', ')}\n`);
}
if (tierOmitted.length) {
  process.stdout.write(`\n  ${tierOmitted.length} checks belong to the other tier; npm run test:full runs the gate\n`);
}
const wall = (Date.now() - started) / 1000;
const work = outcomes.reduce((sum, outcome) => sum + outcome.ms, 0) / 1000;
process.stdout.write(`\n  ${outcomes.length - failed.length}/${outcomes.length} passed`
  + ` in ${wall.toFixed(0)}s (${selectionLabel}; ${jobs} at a time; ${work.toFixed(0)}s of work)\n`);
for (const outcome of failed) process.stdout.write(`  FAILED  ${outcome.label}\n`);
process.stdout.write('\n');
process.exit(failed.length ? 1 : 0);
