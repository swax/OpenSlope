export type LoadStatusUpdate = {
  title?: string;
  label?: string;
  detail?: string;
  progress?: number;
};

/**
 * One full-screen, determinate loading surface shared by editor boot, document replacement and reference loads.
 * A monotonically increasing token prevents an older async load from hiding or rewriting a newer one.
 */
export function createLoadStatus() {
  const root = document.getElementById('load-status')! as HTMLDivElement;
  const title = document.getElementById('load-title')! as HTMLDivElement;
  const label = document.getElementById('load-label')! as HTMLDivElement;
  const detail = document.getElementById('load-detail')! as HTMLDivElement;
  const bar = document.getElementById('load-progress')! as HTMLDivElement;
  const fill = document.getElementById('load-progress-fill')! as HTMLDivElement;
  let current = 0;

  function apply(update: LoadStatusUpdate) {
    if (update.title !== undefined) title.textContent = update.title;
    if (update.label !== undefined) label.textContent = update.label;
    if (update.detail !== undefined) detail.textContent = update.detail;
    if (update.progress !== undefined) {
      const progress = Math.max(0, Math.min(100, update.progress));
      fill.style.width = `${progress}%`;
      bar.setAttribute('aria-valuenow', String(Math.round(progress)));
    }
  }

  function begin(update: LoadStatusUpdate): number {
    const token = ++current;
    root.classList.remove('error');
    root.classList.add('show');
    root.setAttribute('aria-busy', 'true');
    apply({ progress: 0, detail: '', ...update });
    return token;
  }

  function update(token: number, next: LoadStatusUpdate) {
    if (token === current) apply(next);
  }

  /** Let the browser present the status written immediately before a long synchronous phase. */
  function afterPaint(): Promise<void> {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  }

  /** End the current task after showing a readable 100% state for a brief beat. */
  async function finish(token: number, next: LoadStatusUpdate = {}) {
    if (token !== current) return;
    apply({ progress: 100, label: 'Ready', ...next });
    await afterPaint();
    await new Promise(resolve => setTimeout(resolve, 120));
    if (token !== current) return;
    root.classList.remove('show');
    root.setAttribute('aria-busy', 'false');
  }

  async function fail(token: number, message: string) {
    if (token !== current) return;
    root.classList.add('error');
    apply({ label: 'Could not finish loading', detail: message });
    await afterPaint();
    await new Promise(resolve => setTimeout(resolve, 900));
    if (token !== current) return;
    root.classList.remove('show', 'error');
    root.setAttribute('aria-busy', 'false');
  }

  function cancel(token: number) {
    if (token !== current) return;
    root.classList.remove('show', 'error');
    root.setAttribute('aria-busy', 'false');
  }

  /** End the current JS task so a due rendering opportunity can paint incremental patch progress. */
  const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));

  return { begin, update, finish, fail, cancel, afterPaint, yieldToBrowser, isBusy: () => root.getAttribute('aria-busy') === 'true' };
}

export type LoadStatus = ReturnType<typeof createLoadStatus>;
