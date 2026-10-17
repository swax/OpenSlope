export interface IsoLoadState {
  phase: 'queued' | 'loading' | 'error';
  message: string;
}

type ImportMap = (file: File, slot: string, progress: (text: string) => void, signal: AbortSignal) => Promise<void>;

/** Each extraction owns its worker and cache writes until it settles, including after cancellation. */
export function createIsoLoadQueue(importMap: ImportMap, changed: () => void) {
  const states = new Map<string, IsoLoadState>();
  const waiting: { file: File; slot: string }[] = [];
  let active: { slot: string; abort: AbortController } | null = null;
  let running: Promise<void> | null = null;
  let disposed = false;
  const notify = () => { if (!disposed) changed(); };

  async function drain() {
    while (!disposed && waiting.length) {
      const job = waiting.shift()!;
      const abort = new AbortController();
      active = { slot: job.slot, abort };
      states.set(job.slot, { phase: 'loading', message: 'Loading…' }); notify();
      try {
        await importMap(job.file, job.slot, message => {
          if (abort.signal.aborted || disposed) return;
          states.set(job.slot, { phase: 'loading', message }); notify();
        }, abort.signal);
        states.delete(job.slot);
      } catch (error) {
        if (abort.signal.aborted) states.delete(job.slot);
        else states.set(job.slot, { phase: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally { active = null; notify(); }
    }
  }

  return {
    get busy() { return !!active || !!waiting.length; },
    state(slot: string) { return states.get(slot); },
    add(file: File, slots: readonly string[]): Promise<void> {
      if (disposed) return Promise.resolve();
      for (const slot of slots) {
        const phase = states.get(slot)?.phase;
        if (phase === 'queued' || phase === 'loading') continue;
        states.set(slot, { phase: 'queued', message: 'Queued' }); waiting.push({ file, slot });
      }
      notify();
      running ??= drain().finally(() => { running = null; });
      return running;
    },
    cancel(slot: string) {
      if (active?.slot === slot) active.abort.abort();
      else {
        const index = waiting.findIndex(job => job.slot === slot);
        if (index >= 0) waiting.splice(index, 1);
        states.delete(slot); notify();
      }
    },
    dispose() {
      disposed = true; waiting.length = 0; states.clear(); active?.abort.abort();
    },
  };
}
