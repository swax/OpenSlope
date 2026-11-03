/** One trailing update per edit burst. Canceling also interrupts an already-running worker. */
export function createLightingScheduler(
  update: (signal: AbortSignal) => Promise<void>,
  delayMs = 250,
  onError: (error: unknown) => void = error => console.warn('Terrain lighting update failed', error),
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  function cancel() {
    clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  }
  return {
    cancel,
    get pending() {
      return timer !== undefined || controller !== undefined;
    },
    schedule() {
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        const job = (controller = new AbortController());
        void update(job.signal)
          .catch(error => {
            if (!job.signal.aborted) onError(error);
          })
          .finally(() => {
            if (controller === job) controller = undefined;
          });
      }, delayMs);
    },
  };
}
