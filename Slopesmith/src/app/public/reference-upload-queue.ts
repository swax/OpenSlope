import { canonicalDiscCourse } from '../../core/reference/disc-courses';

export interface ReferenceUploadState {
  phase: 'queued' | 'uploading' | 'complete' | 'error';
  message: string;
  music: boolean;
}
type Upload = (
  course: string,
  music: boolean,
  signal: AbortSignal,
  progress: (message: string) => void,
) => Promise<{ reusedFiles?: number }>;
const key = (course: string) => canonicalDiscCourse(course.toUpperCase());

/** Serial uploads, with independent music choices, cancellation and retry after an individual failure. */
export function createReferenceUploadQueue(upload: Upload, changed: () => void) {
  const states = new Map<string, ReferenceUploadState>();
  const waiting: Array<{ course: string; music: boolean }> = [];
  let active: { course: string; abort: AbortController } | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  const notify = () => {
    if (!disposed) changed();
  };
  async function drain() {
    while (!disposed && waiting.length) {
      const job = waiting.shift()!,
        id = key(job.course),
        abort = new AbortController();
      active = { course: job.course, abort };
      states.set(id, { phase: 'uploading', message: 'Preparing reference files…', music: job.music });
      notify();
      try {
        const result = await upload(job.course, job.music, abort.signal, message => {
          if (disposed || abort.signal.aborted) return;
          states.set(id, { phase: 'uploading', message, music: job.music });
          notify();
        });
        if (!disposed)
          states.set(id, {
            phase: 'complete',
            music: job.music,
            message: `Server reference uploaded.${result.reusedFiles ? ` ${result.reusedFiles} files reused.` : ''}`,
          });
      } catch (error) {
        if (abort.signal.aborted) states.delete(id);
        else if (!disposed)
          states.set(id, {
            phase: 'error',
            message: error instanceof Error ? error.message : String(error),
            music: job.music,
          });
      } finally {
        active = null;
        notify();
      }
    }
  }
  return {
    get busy() {
      return !!active || !!waiting.length;
    },
    state(course: string) {
      return states.get(key(course));
    },
    add(course: string, music: boolean): Promise<void> {
      if (disposed) return Promise.resolve();
      const phase = states.get(key(course))?.phase;
      if (phase !== 'queued' && phase !== 'uploading') {
        states.set(key(course), { phase: 'queued', message: 'Queued for reference upload.', music });
        waiting.push({ course, music });
        notify();
      }
      running ??= drain().finally(() => {
        running = null;
      });
      return running;
    },
    cancel(course: string) {
      if (active && key(active.course) === key(course)) active.abort.abort();
      else {
        const index = waiting.findIndex(job => key(job.course) === key(course));
        if (index >= 0) waiting.splice(index, 1);
        states.delete(key(course));
        notify();
      }
    },
    clear(course: string) {
      const phase = states.get(key(course))?.phase;
      if (phase !== 'queued' && phase !== 'uploading') states.delete(key(course));
    },
    dispose() {
      disposed = true;
      waiting.length = 0;
      states.clear();
      active?.abort.abort();
    },
  };
}
