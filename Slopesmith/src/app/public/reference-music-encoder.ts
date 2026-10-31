/** One worker per upload, bounded to one decoded clip. Termination also cancels synchronous Wasm encoding. */
export function referenceMusicEncoder(signal: AbortSignal) {
  let worker: Worker | undefined;
  let next = 0;
  const pending = new Map<number, { resolve: (blob: Blob) => void; reject: (error: Error) => void }>();
  const close = () => {
    worker?.terminate();
    worker = undefined;
    for (const job of pending.values()) job.reject(new Error('Reference music encoding cancelled.'));
    pending.clear();
  };
  signal.addEventListener('abort', close, { once: true });
  return {
    encode(blob: Blob): Promise<Blob> {
      signal.throwIfAborted();
      if (!worker) {
        worker = new Worker(new URL('./reference-music-worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = ({ data }: MessageEvent<{ id: number; blob?: Blob; error?: string }>) => {
          const job = pending.get(data.id);
          pending.delete(data.id);
          if (data.error || !data.blob) job?.reject(new Error(data.error ?? 'Music encoder returned no data.'));
          else job?.resolve(data.blob);
        };
        worker.onerror = event => {
          for (const job of pending.values()) job.reject(new Error(event.message || 'Music encoder failed.'));
          close();
        };
      }
      return new Promise((resolve, reject) => {
        const id = ++next;
        pending.set(id, { resolve, reject });
        worker!.postMessage({ id, blob });
      });
    },
    close() {
      signal.removeEventListener('abort', close);
      close();
    },
  };
}
