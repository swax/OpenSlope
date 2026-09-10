/** Actual in-flight render work, independent of the bounded diagnostics history. */
export class CaptureProgress {
  private next = 0;
  private pending = new Map<number, string>();
  private failures = new Map<string, string>();
  generation = 0;
  begin(label: string) {
    const id = ++this.next;
    this.pending.set(id, label); this.failures.delete(label); this.generation++;
    let ended = false;
    return (error?: unknown) => {
      if (ended) return;
      ended = true; this.pending.delete(id); this.generation++;
      if (error !== undefined) this.failures.set(label, error instanceof Error ? error.message : String(error));
    };
  }
  snapshot() {
    return { generation: this.generation, pending: [...this.pending.values()],
      errors: [...this.failures].map(([asset, message]) => ({ asset, message })) };
  }
}
export const captureProgress = new CaptureProgress();
export function renderRequest(input: RequestInfo | URL, init?: RequestInit) {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const path = new URL(url, 'http://slopesmith.local').pathname;
  return (!init?.method || init.method === 'GET') && /^\/api\/(?:level|props|custom-props|groups|effects|skybox|lightrig)(?:\/|$)/.test(path)
    ? captureProgress.begin(url) : (_error?: unknown) => {};
}
