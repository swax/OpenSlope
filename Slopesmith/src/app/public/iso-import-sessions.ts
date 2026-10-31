import type { CourseLayout } from '../../core/reference/course-layout';

export interface ImportReply {
  type: 'progress' | 'done' | 'error';
  message?: string;
  courses?: string[];
  names?: Record<string, string>;
  layouts?: Record<string, CourseLayout>;
  stats?: Record<string, number>;
}
interface ImportRequest {
  file: File;
  operation: 'scan' | 'extract';
  courses: string[];
}
export interface ImportWorker {
  onmessage: ((event: MessageEvent<ImportReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: ImportRequest): void;
  terminate(): void;
}

/** One active import, retaining at most two disc workers between requests. */
export function createIsoImportSessions(createWorker: () => ImportWorker) {
  interface Job {
    request: ImportRequest;
    receive: (reply: ImportReply) => void;
    resolve: (reply: ImportReply) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    abort: () => void;
  }
  const workers = new Map<File, ImportWorker>();
  const jobs: Job[] = [];
  let active: { job: Job; worker: ImportWorker } | undefined;
  const cancelled = () => new DOMException('ISO import cancelled.', 'AbortError');
  const finish = (error?: Error, reply?: ImportReply) => {
    if (!active) return;
    const { job, worker } = active;
    active = undefined;
    worker.onmessage = null;
    worker.onerror = null;
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error);
    else job.resolve(reply!);
    queueMicrotask(next);
  };
  function next() {
    if (active || !jobs.length) return;
    const job = jobs.shift()!;
    const file = job.request.file;
    let worker = workers.get(file);
    if (!worker) {
      while (workers.size >= 2) {
        const [oldFile, oldWorker] = workers.entries().next().value!;
        oldWorker.terminate();
        workers.delete(oldFile);
      }
      try {
        worker = createWorker();
        workers.set(file, worker);
      } catch (error) {
        job.signal?.removeEventListener('abort', job.abort);
        job.reject(error as Error);
        queueMicrotask(next);
        return;
      }
    } else {
      workers.delete(file);
      workers.set(file, worker);
    }
    active = { job, worker };
    worker.onmessage = ({ data }) => {
      job.receive(data);
      if (data.type === 'done') finish(undefined, data);
      else if (data.type === 'error') finish(new Error(data.message ?? 'ISO import failed.'));
    };
    worker.onerror = event => {
      worker.terminate();
      workers.delete(file);
      finish(new Error(event.message || 'The local ISO importer could not start.'));
    };
    try {
      worker.postMessage(job.request);
    } catch (error) {
      worker.terminate();
      workers.delete(file);
      finish(error as Error);
    }
  }
  return {
    run(request: ImportRequest, receive: (reply: ImportReply) => void, signal?: AbortSignal): Promise<ImportReply> {
      if (signal?.aborted) return Promise.reject(cancelled());
      return new Promise((resolve, reject) => {
        const job: Job = {
          request,
          receive,
          resolve,
          reject,
          signal,
          abort: () => {
            if (active?.job === job) {
              active.worker.terminate();
              workers.delete(request.file);
              finish(cancelled());
            } else {
              const index = jobs.indexOf(job);
              if (index >= 0) jobs.splice(index, 1);
              signal?.removeEventListener('abort', job.abort);
              reject(cancelled());
            }
          },
        };
        signal?.addEventListener('abort', job.abort, { once: true });
        jobs.push(job);
        next();
      });
    },
    close() {
      for (const worker of workers.values()) worker.terminate();
      workers.clear();
      for (const job of jobs.splice(0)) {
        job.signal?.removeEventListener('abort', job.abort);
        job.reject(cancelled());
      }
      finish(cancelled());
    },
  };
}
