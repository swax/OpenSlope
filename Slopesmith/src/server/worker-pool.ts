import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import type { EditDoc } from '../core/doc/doc-edit';

/**
 * A small pool of worker threads for the CPU-bound half of serving reference data.
 *
 * Making the filesystem asynchronous stops a read from blocking the event loop, but it does nothing for the
 * work that happens after the bytes arrive. Building MERQUER's or ELYSIUM's prop payload — parsing hundreds of
 * mesh OBJs, welding submeshes, base64-encoding the buffers — takes about sixteen seconds on a cold cache, and
 * on the main thread that is sixteen seconds in which no other client's request advances at all. It is the
 * single longest stall the server has.
 *
 * The work is a pure function of the level name and the map library, and its result is JSON, so it moves
 * wholesale onto another thread. The main thread then only waits.
 *
 * Entry points are TypeScript, which a bare worker cannot load, so each worker is started with tsx registered.
 * That is the same loader the dev server and the test scripts already run under.
 */

export interface PropsWorkerTask {
  kind: 'props';
  level: string;
  /** The resolved map library, passed explicitly so a worker never re-derives machine config of its own. */
  mapsRoot: string;
  workspaceRoot: string;
}

/** Canonicalization and storage serialization are pure but CPU-heavy whole-document walks. They use a
 * separate pool so a sixteen-second cold prop build can never postpone room durability. */
export interface DocumentWorkerTask {
  kind: 'document';
  document: EditDoc;
}

/** Read, migrate and canonicalize a stored project away from the socket thread. */
export interface DocumentReadWorkerTask {
  kind: 'document-read';
  file: string;
}

export type WorkerTask = PropsWorkerTask | DocumentWorkerTask | DocumentReadWorkerTask;

interface Pending {
  task: WorkerTask;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** The worker ran normally and the requested operation itself failed (for example, a project was deleted
 * while its queued read was starting). Callers should preserve that failure rather than retrying on-thread. */
export class WorkerTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerTaskError';
  }
}

export interface WorkerPoolSizes {
  parallelism: number;
  reference: number;
  document: number;
}

const positiveInteger = (value: string | undefined): number | null => {
  if (!value || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * Split one host-wide CPU budget between the two independent pools.
 *
 * A document worker remains separate so a long reference build cannot postpone room durability. On hosts
 * with at least three logical CPUs, the two pools together leave one CPU for the event loop; one- and two-CPU
 * hosts necessarily overcommit by one only when reference work and a document snapshot overlap. Explicit
 * limits are clamped to this same budget instead of letting two independently reasonable settings multiply.
 */
export function workerPoolSizes(parallelism = availableParallelism(), env = process.env): WorkerPoolSizes {
  const cpus = Math.max(1, Math.floor(parallelism));
  const budget = Math.max(2, cpus - 1);
  let document = Math.min(2, positiveInteger(env.SLOPESMITH_DOCUMENT_WORKERS) ?? Math.max(1, Math.floor(budget / 3)));
  let reference = Math.min(4, positiveInteger(env.SLOPESMITH_REFERENCE_WORKERS) ?? Math.max(1, budget - document));

  while (reference + document > budget && reference > 1) reference--;
  while (reference + document > budget && document > 1) document--;
  return { parallelism: cpus, reference, document };
}

const WORKER_SIZES = workerPoolSizes();
const REFERENCE_POOL_SIZE = WORKER_SIZES.reference;
const DOCUMENT_POOL_SIZE = WORKER_SIZES.document;

// Source runs through tsx; the production build emits both entry points beside one another.
const TYPESCRIPT_ENTRY = import.meta.url.endsWith('.ts');
const WORKER_ENTRY = new URL(TYPESCRIPT_ENTRY ? './workers/reference-worker.ts' : './reference-worker.js', import.meta.url);
const WORKER_EXEC_ARGV = TYPESCRIPT_ENTRY ? ['--import', 'tsx'] : [];

export interface WorkerPoolSnapshot {
  size: number;
  started: number;
  busy: number;
  idle: number;
  queued: number;
  coalesced: number;
}

class WorkerPool {
  private idle: Worker[] = [];
  private started = 0;
  private queue: Pending[] = [];
  private busy = new Map<Worker, Pending>();

  /** Coalesce identical in-flight tasks: several clients opening the same level must not each build it. */
  private inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly size: number) {}

  snapshot(): WorkerPoolSnapshot {
    return {
      size: this.size,
      started: this.started,
      busy: this.busy.size,
      idle: this.idle.length,
      queued: this.queue.length,
      coalesced: this.inFlight.size,
    };
  }

  run(task: WorkerTask): Promise<unknown> {
    // Document snapshots are never coalesced: two rooms may happen to hold equal JSON while owing two
    // different project revisions. The task itself is already paced per room.
    if (task.kind !== 'props') return this.dispatch(task);
    const key = `${task.kind}:${task.mapsRoot}:${task.level}`;
    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.dispatch(task).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return pending;
  }

  private dispatch(task: WorkerTask): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const job: Pending = { task, resolve, reject };
      const worker = this.idle.pop() ?? this.spawn();
      if (worker) this.assign(worker, job);
      else this.queue.push(job); // pool is at capacity; the next completion takes this one
    });
  }

  /** A worker, or null once the pool is at its size limit. */
  private spawn(): Worker | null {
    if (this.started >= this.size) return null;
    this.started++;
    let worker: Worker;
    try { worker = new Worker(WORKER_ENTRY, { execArgv: WORKER_EXEC_ARGV }); }
    catch (error) {
      this.started--;
      throw error;
    }
    let dead = false;
    worker.on('message', (message: { ok: boolean; value?: unknown; error?: string }) => {
      const job = this.busy.get(worker);
      if (!job) return;
      this.busy.delete(worker);
      if (message.ok) job.resolve(message.value);
      else job.reject(new WorkerTaskError(message.error ?? 'worker task failed'));
      this.release(worker);
    });
    // A worker that dies takes its current job with it; the pool shrinks and respawns on the next task.
    const fail = (error: Error) => {
      if (dead) return; // `error` is normally followed by `exit`; account for one dead worker once.
      dead = true;
      const job = this.busy.get(worker);
      this.busy.delete(worker);
      this.started--;
      this.idle = this.idle.filter(candidate => candidate !== worker);
      job?.reject(error);
      this.drain();
    };
    worker.on('error', fail);
    worker.on('exit', code => {
      if (code !== 0 || this.busy.has(worker)) fail(new Error(`worker exited with code ${code}`));
    });
    worker.unref(); // an idle pool must not hold the process open
    return worker;
  }

  private assign(worker: Worker, job: Pending): void {
    this.busy.set(worker, job);
    // Hold the process open for the duration of the task. Without this the pool's idle `unref` also applies
    // while work is in flight, and a script whose only pending work is a build exits before the result
    // arrives — the task never settles and the caller's await never returns.
    worker.ref();
    try { worker.postMessage(job.task); }
    catch (error) {
      this.busy.delete(worker);
      job.reject(error instanceof Error ? error : new Error(String(error)));
      this.release(worker);
    }
  }

  private release(worker: Worker): void {
    const next = this.queue.shift();
    if (next) { this.assign(worker, next); return; }
    this.idle.push(worker);
    worker.unref();
  }

  /** Hand queued work to whatever capacity exists after a worker was lost. */
  private drain(): void {
    while (this.queue.length) {
      let worker: Worker | null;
      try { worker = this.idle.pop() ?? this.spawn(); }
      catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        for (const job of this.queue.splice(0)) job.reject(failure);
        return;
      }
      if (!worker) return;
      this.assign(worker, this.queue.shift()!);
    }
  }
}

const referencePool = new WorkerPool(REFERENCE_POOL_SIZE);
const documentPool = new WorkerPool(DOCUMENT_POOL_SIZE);

export const runInWorker = (task: WorkerTask): Promise<unknown> =>
  (task.kind === 'props' ? referencePool : documentPool).run(task);

export const workerPoolStats = () => ({
  parallelism: WORKER_SIZES.parallelism,
  reference: referencePool.snapshot(),
  document: documentPool.snapshot(),
});
