import { rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { EditDoc } from '../core/doc/doc-edit';
import {
  ensureDir, listDir, mapLimit, pathExists, readBytesOrNull, readJsonOr, writeFileAtomic,
  writeJsonAtomic, READ_CONCURRENCY,
} from './fs-async';
import { createLogger } from './log';
import { serialize } from './serialize';

const log = createLogger('projects');

/** One whole document set aside, as the History panel lists it. */
export interface ProjectCheckpoint {
  /** The file under `autosaves/`, which is also the name a read or a restore asks for. */
  file: string;
  /** The revision the document held when it was set aside. */
  revision: number;
  takenAt: string;
  bytes: number;
  reason: CheckpointReason;
  /** Kept whatever the schedule says. */
  pinned: boolean;
  /** The members whose work this checkpoint holds. */
  members: string[];
  /** What it was set aside for, in the author's words. */
  note?: string;
  namedBy?: string;
}

/** The ring as a whole: what it holds and what it is allowed to cost. */
export interface CheckpointListing {
  checkpoints: ProjectCheckpoint[];
  budget: {
    bytes: number;
    limit: number;
    /** Set when the budget, rather than the schedule, last decided what went. */
    droppedAt?: string;
    dropped?: number;
  };
}

/** A checkpoint that existed when listed but was thinned before it could be read. */
export class CheckpointGoneError extends Error {
  constructor(public readonly file: string) {
    super(`That checkpoint is no longer on disk: ${file}`);
  }
}

/** When a checkpoint is taken, and how long one is kept. */
export interface CheckpointPolicy {
  /** Wall clock that must pass since the last checkpoint before a save may take another. */
  intervalMs: number;
  /** Document bytes that must have changed in that time for a checkpoint to be worth its disk. */
  changeBytes: number;
  /** Younger than this, every checkpoint is kept. */
  everyMs: number;
  /** Younger than this, one per hour. */
  hourlyMs: number;
  /** Younger than this, one per day. */
  dailyMs: number;
  /** Older than `dailyMs`: one per week, this many of them. */
  weeklyKeep: number;
  /** What one project's whole ring may cost on disk. */
  budgetBytes: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Five minutes and four kilobytes of changed document. */
export const checkpointPolicy: CheckpointPolicy = {
  intervalMs: 5 * MINUTE,
  changeBytes: 4 * 1024,
  everyMs: HOUR,
  hourlyMs: DAY,
  dailyMs: WEEK,
  weeklyKeep: 8,
  budgetBytes: 64 * 1024 * 1024,
};

/** Retune the cadence or the schedule. */
export function configureCheckpoints(patch: Partial<CheckpointPolicy>): CheckpointPolicy {
  return Object.assign(checkpointPolicy, patch);
}

/** Why a checkpoint exists, which is also what decides whether thinning may take it. */
export type CheckpointReason = 'timer' | 'named' | 'restore' | 'revert' | 'bulk' | 'idle';

/** What a checkpoint asks to be, when something forces one or names one. */
export interface CheckpointRequest {
  reason: CheckpointReason;
  note?: string;
  /** Who named it. */
  by?: string;
  /** The members whose work it holds, as the session layer saw them. */
  members?: string[];
}

/** What survives a pruning pass, and why each casualty went. */
export interface RetentionPlan {
  keep: ProjectCheckpoint[];
  /** Dropped by the schedule: a newer checkpoint already stands for that hour, day or week. */
  thinned: ProjectCheckpoint[];
  /** Dropped by the byte budget, oldest unnamed first. */
  overBudget: ProjectCheckpoint[];
  /** What the survivors cost. */
  bytes: number;
}

/** The reasons thinning never touches. */
const PINNED: ReadonlySet<string> = new Set<CheckpointReason>(['named', 'restore', 'revert']);

const CHECKPOINT_PATTERN =
  /^r(\d+)-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z(?:-(timer|named|restore|revert|bulk|idle))?\.slope\.json(\.gz)?$/;

const checkpointDir = (dir: string) => join(dir, 'autosaves');
const documentFile = (dir: string) => join(dir, 'mountain.slope.json');
const ringKey = (dir: string) => `checkpoints:${dir}`;

interface CheckpointNote { note?: string; namedBy?: string; members?: string[] }

interface CheckpointIndex {
  entries?: Record<string, CheckpointNote>;
  /** The last time the byte budget, rather than the schedule, decided what went. */
  budget?: { at: string; dropped: number; bytes: number; limit: number };
}

const indexFile = (dir: string) => join(checkpointDir(dir), 'checkpoints.json');
const readCheckpointIndex = (dir: string) => readJsonOr<CheckpointIndex>(indexFile(dir), {});
const writeCheckpointIndex = (dir: string, index: CheckpointIndex) => writeJsonAtomic(indexFile(dir), index);

const gzipBytes = promisify(gzip);
const gunzipBytes = promisify(gunzip);

async function checkpointFiles(dir: string): Promise<string[]> {
  return (await listDir(checkpointDir(dir))).filter(name => CHECKPOINT_PATTERN.test(name)).sort().reverse();
}

function describeCheckpoint(file: string, bytes: number, note?: CheckpointNote): ProjectCheckpoint {
  const [, revision, date, hour, minute, second, millis, reason] = CHECKPOINT_PATTERN.exec(file)!;
  const why = (reason ?? 'timer') as CheckpointReason;
  return {
    file, revision: Number(revision), takenAt: `${date}T${hour}:${minute}:${second}.${millis}Z`, bytes,
    reason: why, pinned: PINNED.has(why), members: note?.members ?? [],
    ...(note?.note ? { note: note.note } : {}),
    ...(note?.namedBy ? { namedBy: note.namedBy } : {}),
  };
}

function renameForReason(file: string, reason: CheckpointReason): string {
  const [, revision, date, hour, minute, second, millis, , gz] = CHECKPOINT_PATTERN.exec(file)!;
  return `r${revision}-${date}T${hour}-${minute}-${second}-${millis}Z-${reason}.slope.json${gz ?? ''}`;
}

function checkpointName(file: string): string {
  const name = basename(file);
  if (!CHECKPOINT_PATTERN.test(name)) throw new Error(`Unknown checkpoint: ${file}`);
  return name;
}

async function fileSize(file: string): Promise<number> {
  try { return (await stat(file)).size; } catch { return 0; }
}

async function ringEntries(dir: string): Promise<ProjectCheckpoint[]> {
  const files = await checkpointFiles(dir);
  const [sizes, index] = await Promise.all([
    mapLimit(files, READ_CONCURRENCY, file => fileSize(join(checkpointDir(dir), file))),
    readCheckpointIndex(dir),
  ]);
  return files.map((file, at) => describeCheckpoint(file, sizes[at], index.entries?.[file]));
}

/** Decide which checkpoints survive the age schedule and byte budget. */
export function planRetention(checkpoints: readonly ProjectCheckpoint[], now: number,
  policy: CheckpointPolicy = checkpointPolicy): RetentionPlan {
  const ordered = [...checkpoints].sort((a, b) => b.takenAt.localeCompare(a.takenAt));
  const claimed = new Set<string>();
  const keep: ProjectCheckpoint[] = [];
  const thinned: ProjectCheckpoint[] = [];
  let weeks = 0;
  for (const entry of ordered) {
    if (entry.pinned) { keep.push(entry); continue; }
    const at = Date.parse(entry.takenAt);
    const age = now - at;
    const bucket = age < policy.everyMs ? `each:${entry.file}`
      : age < policy.hourlyMs ? `hour:${Math.floor(at / HOUR)}`
        : age < policy.dailyMs ? `day:${Math.floor(at / DAY)}`
          : `week:${Math.floor(at / WEEK)}`;
    const weekly = bucket.startsWith('week:');
    if (claimed.has(bucket) || (weekly && weeks >= policy.weeklyKeep)) { thinned.push(entry); continue; }
    claimed.add(bucket);
    if (weekly) weeks++;
    keep.push(entry);
  }
  const overBudget: ProjectCheckpoint[] = [];
  let bytes = keep.reduce((sum, entry) => sum + entry.bytes, 0);
  for (let at = keep.length - 1; at > 0 && bytes > policy.budgetBytes; at--) {
    if (keep[at].pinned) continue;
    bytes -= keep[at].bytes;
    overBudget.push(keep[at]);
  }
  const dropped = new Set(overBudget.map(entry => entry.file));
  return { keep: keep.filter(entry => !dropped.has(entry.file)), thinned, overBudget, bytes };
}

async function writeCheckpoint(dir: string, revision: number,
  request: CheckpointRequest): Promise<ProjectCheckpoint | null> {
  const bytes = await readBytesOrNull(documentFile(dir));
  if (!bytes) return null;
  await ensureDir(checkpointDir(dir));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `r${String(revision).padStart(6, '0')}-${stamp}-${request.reason}.slope.json.gz`;
  const packed = await gzipBytes(bytes);
  await writeFileAtomic(join(checkpointDir(dir), file), packed);
  const note: CheckpointNote | undefined = request.note || request.by || request.members?.length
    ? {
      ...(request.note ? { note: request.note } : {}),
      ...(request.by ? { namedBy: request.by } : {}),
      ...(request.members?.length ? { members: request.members } : {}),
    }
    : undefined;
  if (note) {
    const index = await readCheckpointIndex(dir);
    await writeCheckpointIndex(dir, { ...index, entries: { ...index.entries, [file]: note } });
  }
  return describeCheckpoint(file, packed.length, note);
}

async function pruneRing(dir: string): Promise<RetentionPlan> {
  const plan = planRetention(await ringEntries(dir), Date.now());
  const dropped = [...plan.thinned, ...plan.overBudget];
  await mapLimit(dropped, READ_CONCURRENCY, entry => rm(join(checkpointDir(dir), entry.file), { force: true }));
  if (plan.overBudget.length) {
    log.warn(`${basename(dir)}: the ${checkpointPolicy.budgetBytes}-byte checkpoint budget was `
      + `reached, so the ${plan.overBudget.length} oldest unnamed checkpoints were dropped`);
  }
  const index = await readCheckpointIndex(dir);
  const survivors = new Set(plan.keep.map(entry => entry.file));
  const entries = Object.fromEntries(Object.entries(index.entries ?? {}).filter(([file]) => survivors.has(file)));
  const budget = plan.overBudget.length
    ? { at: new Date().toISOString(), dropped: plan.overBudget.length, bytes: plan.bytes, limit: checkpointPolicy.budgetBytes }
    : index.budget;
  if (dropped.length || budget !== index.budget) await writeCheckpointIndex(dir, { ...index, entries, budget });
  return plan;
}

interface Cadence { lastAt: number; changed: number }
const cadence = new Map<string, Cadence>();

async function cadenceOf(dir: string): Promise<Cadence> {
  const known = cadence.get(dir);
  if (known) return known;
  const [newest] = await checkpointFiles(dir);
  const seeded = { lastAt: newest ? Date.parse(describeCheckpoint(newest, 0).takenAt) : 0, changed: 0 };
  cadence.set(dir, seeded);
  return seeded;
}

const markCheckpointed = (dir: string, at = Date.now()) => cadence.set(dir, { lastAt: at, changed: 0 });

/** Forget the transient cadence state when its project is deleted. */
export const clearCheckpointCadence = (dir: string): void => { cadence.delete(dir); };

/** The span of the document that differs between two saves. */
export function changedDocumentSpan(before: string, after: string): number {
  const shared = Math.min(before.length, after.length);
  let head = 0;
  while (head < shared && before.charCodeAt(head) === after.charCodeAt(head)) head++;
  let tail = 0;
  while (tail < shared - head
    && before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)) tail++;
  return Math.max(before.length, after.length) - head - tail;
}

/** Set the outgoing document aside when the cadence or a forced request says it should be. */
export async function checkpointOutgoing(dir: string, revision: number, changed: number,
  forced?: CheckpointRequest): Promise<void> {
  const state = await cadenceOf(dir);
  state.changed += changed;
  const now = Date.now();
  const due = !state.lastAt
    || (now - state.lastAt >= checkpointPolicy.intervalMs && state.changed >= checkpointPolicy.changeBytes);
  if (!forced && !due) return;
  await serialize(ringKey(dir), async () => {
    await writeCheckpoint(dir, revision, forced ?? { reason: 'timer' });
    await pruneRing(dir);
  });
  markCheckpointed(dir, now);
}

/** List one project's checkpoint ring. The caller resolves the project id to this trusted directory. */
export async function listProjectCheckpoints(dir: string): Promise<CheckpointListing> {
  const [checkpoints, index] = await Promise.all([ringEntries(dir), readCheckpointIndex(dir)]);
  return {
    checkpoints,
    budget: {
      bytes: checkpoints.reduce((sum, entry) => sum + entry.bytes, 0),
      limit: checkpointPolicy.budgetBytes,
      ...(index.budget ? { droppedAt: index.budget.at, dropped: index.budget.dropped } : {}),
    },
  };
}

async function parseCheckpoint(path: string, bytes: Buffer): Promise<unknown> {
  const text = (path.endsWith('.gz') ? await gunzipBytes(bytes) : bytes).toString('utf8');
  try { return JSON.parse(text) as unknown; }
  catch (error) { throw new Error(`invalid JSON in ${path}: ${String(error instanceof Error ? error.message : error)}`, { cause: error }); }
}

/** Read and normalize one checkpoint from a trusted project directory. */
export async function readProjectCheckpoint(dir: string, file: string,
  normalize: (value: unknown) => EditDoc): Promise<{ checkpoint: ProjectCheckpoint; document: EditDoc }> {
  const name = checkpointName(file);
  const path = join(checkpointDir(dir), name);
  const bytes = await readBytesOrNull(path);
  if (!bytes) throw new CheckpointGoneError(name);
  const document = normalize(await parseCheckpoint(path, bytes));
  const index = await readCheckpointIndex(dir);
  return { checkpoint: describeCheckpoint(name, bytes.length, index.entries?.[name]), document };
}

/** Write and prune an immediate checkpoint. The caller holds the project's own queue. */
export async function checkpointProjectNow(dir: string, revision: number,
  request: CheckpointRequest): Promise<ProjectCheckpoint | null> {
  const written = await serialize(ringKey(dir), async () => {
    const checkpoint = await writeCheckpoint(dir, revision, request);
    await pruneRing(dir);
    return checkpoint;
  });
  markCheckpointed(dir);
  return written;
}

/** Name and pin a checkpoint in one serialized ring update. */
export async function nameProjectCheckpoint(dir: string, file: string, note: string,
  by = ''): Promise<ProjectCheckpoint> {
  const name = checkpointName(file);
  const wanted = note.trim();
  if (!wanted) throw new Error('A named checkpoint needs a note');
  return serialize(ringKey(dir), async () => {
    if (!await pathExists(join(checkpointDir(dir), name))) throw new CheckpointGoneError(name);
    const named = renameForReason(name, 'named');
    if (named !== name) await rename(join(checkpointDir(dir), name), join(checkpointDir(dir), named));
    const index = await readCheckpointIndex(dir);
    const entries = { ...index.entries, [named]: { ...index.entries?.[name], note: wanted, namedBy: by } };
    if (named !== name) delete entries[name];
    await writeCheckpointIndex(dir, { ...index, entries });
    return describeCheckpoint(named, await fileSize(join(checkpointDir(dir), named)), entries[named]);
  });
}
