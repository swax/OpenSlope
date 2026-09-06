type DiagnosticStatus = 'pending' | 'ok' | 'error';

export interface RequestDiagnostic {
  id: string;
  page: string;
  at: number;
  method: string;
  url: string;
  status: DiagnosticStatus;
  httpStatus?: number;
  serverId?: string;
  cache?: string;
  persistentCache?: string;
  encoding?: string;
  bytes?: number;
  headersMs?: number;
  bodyMs?: number;
  totalMs?: number;
  error?: string;
}

export interface PhaseDiagnostic {
  id: string;
  page: string;
  at: number;
  category: string;
  name: string;
  status: DiagnosticStatus;
  durationMs?: number;
  detail?: string;
  error?: string;
}

export interface StallDiagnostic {
  page: string;
  at: number;
  kind: 'long-task' | 'event-loop-gap';
  durationMs: number;
  startMs: number;
}

export interface DiagnosticSnapshot {
  requests: RequestDiagnostic[];
  phases: PhaseDiagnostic[];
  stalls: StallDiagnostic[];
}

const STORAGE_KEY = 'slopesmith:diagnostics:v1';
const MAX_REQUESTS = 240, MAX_PHASES = 240, MAX_STALLS = 120;
const page = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
let sequence = 0;

const state: DiagnosticSnapshot = { requests: [], phases: [], stalls: [] };

function browserAvailable(): boolean {
  return typeof window !== 'undefined' && typeof sessionStorage !== 'undefined';
}

function loadPrevious() {
  if (!browserAvailable()) return;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const previous = JSON.parse(raw) as Partial<DiagnosticSnapshot>;
    if (Array.isArray(previous.requests)) state.requests.push(...previous.requests.slice(-MAX_REQUESTS));
    if (Array.isArray(previous.phases)) state.phases.push(...previous.phases.slice(-MAX_PHASES));
    if (Array.isArray(previous.stalls)) state.stalls.push(...previous.stalls.slice(-MAX_STALLS));
  } catch { /* A malformed/blocked session store must never affect the editor. */ }
}

function persist() {
  if (!browserAvailable()) return;
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch { /* Diagnostics are best-effort under private browsing/storage limits. */ }
}

function trim<T>(items: T[], max: number) {
  if (items.length > max) items.splice(0, items.length - max);
}

const inputUrl = (input: RequestInfo | URL): string => {
  if (typeof input === 'string') return input;
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return input.toString();
};

const inputMethod = (input: RequestInfo | URL, init?: RequestInit): string =>
  (init?.method ?? (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET')).toUpperCase();

export interface RequestDiagnosticTrace {
  headers(response: Response): void;
  complete(): void;
  fail(error: unknown): void;
}

/** Begin a browser request record before fetch() is called. It remains `pending` in sessionStorage while the
 * request is in flight, so a reload after a hang still says whether dispatch happened and whether headers ever
 * arrived. `headersMs` is queue + server + first-byte time; `bodyMs` is transfer + JSON parsing. */
export function beginRequestDiagnostic(input: RequestInfo | URL, init?: RequestInit): RequestDiagnosticTrace {
  const started = performance.now();
  let headersAt: number | null = null;
  let finished = false;
  const entry: RequestDiagnostic = {
    id: `browser-${page}-${++sequence}`,
    page,
    at: Date.now(),
    method: inputMethod(input, init),
    url: inputUrl(input),
    status: 'pending',
  };
  state.requests.push(entry); trim(state.requests, MAX_REQUESTS); persist();

  const finish = (status: 'ok' | 'error', error?: unknown) => {
    if (finished) return;
    finished = true;
    const ended = performance.now();
    entry.status = status;
    entry.totalMs = ended - started;
    if (headersAt !== null) entry.bodyMs = ended - headersAt;
    if (error !== undefined) entry.error = error instanceof Error ? error.message : String(error);
    persist();
    if ((entry.totalMs ?? 0) >= 1000 || status === 'error') {
      const cache = entry.cache ? ` cache=${entry.cache}` : '';
      console.warn(`[request] ${entry.method} ${entry.url} ${entry.httpStatus ?? status}`
        + ` ${(entry.totalMs ?? 0).toFixed(1)}ms${cache}`, entry);
    }
  };

  return {
    headers(response) {
      if (finished) return;
      headersAt = performance.now();
      entry.headersMs = headersAt - started;
      entry.httpStatus = response.status;
      entry.serverId = response.headers.get('x-slopesmith-request-id') ?? undefined;
      entry.cache = response.headers.get('x-slopesmith-cache') ?? undefined;
      entry.persistentCache = response.headers.get('x-slopesmith-persistent-cache') ?? undefined;
      entry.encoding = response.headers.get('content-encoding') ?? undefined;
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length >= 0) entry.bytes = length;
      persist();
    },
    complete() { finish('ok'); },
    fail(error) { finish('error', error); },
  };
}

export interface PhaseDiagnosticTrace {
  complete(detail?: string): void;
  fail(error: unknown): void;
}

/** Record a named client phase that is not visible to the Network panel: decode, geometry registration,
 * tessellation, GPU-scene construction, or Effects installation. */
export function beginDiagnosticPhase(category: string, name: string, detail?: string): PhaseDiagnosticTrace {
  const started = performance.now();
  let finished = false;
  const entry: PhaseDiagnostic = {
    id: `phase-${page}-${++sequence}`,
    page,
    at: Date.now(),
    category,
    name,
    status: 'pending',
    ...(detail ? { detail } : {}),
  };
  state.phases.push(entry); trim(state.phases, MAX_PHASES); persist();
  const finish = (status: 'ok' | 'error', nextDetail?: string, error?: unknown) => {
    if (finished) return;
    finished = true;
    entry.status = status;
    entry.durationMs = performance.now() - started;
    if (nextDetail) entry.detail = nextDetail;
    if (error !== undefined) entry.error = error instanceof Error ? error.message : String(error);
    persist();
    if ((entry.durationMs ?? 0) >= 500 || status === 'error') {
      console.warn(`[phase] ${category} ${name} ${status} ${(entry.durationMs ?? 0).toFixed(1)}ms`, entry);
    }
  };
  return {
    complete: nextDetail => finish('ok', nextDetail),
    fail: error => finish('error', undefined, error),
  };
}

export function runDiagnosticPhase<T>(category: string, name: string, work: () => T, detail?: string): T {
  const trace = beginDiagnosticPhase(category, name, detail);
  try { const result = work(); trace.complete(); return result; }
  catch (error) { trace.fail(error); throw error; }
}

export async function runDiagnosticPhaseAsync<T>(
  category: string, name: string, work: () => Promise<T>, detail?: string,
): Promise<T> {
  const trace = beginDiagnosticPhase(category, name, detail);
  try { const result = await work(); trace.complete(); return result; }
  catch (error) { trace.fail(error); throw error; }
}

function recordStall(kind: StallDiagnostic['kind'], durationMs: number, startMs: number) {
  const entry: StallDiagnostic = { page, at: Date.now(), kind, durationMs, startMs };
  state.stalls.push(entry); trim(state.stalls, MAX_STALLS); persist();
  if (durationMs >= 1000) console.warn(`[stall] ${kind} ${durationMs.toFixed(1)}ms`, entry);
}

export function diagnosticsSnapshot(): DiagnosticSnapshot {
  return {
    requests: state.requests.map(entry => ({ ...entry })),
    phases: state.phases.map(entry => ({ ...entry })),
    stalls: state.stalls.map(entry => ({ ...entry })),
  };
}

export function clearDiagnostics() {
  state.requests.length = 0; state.phases.length = 0; state.stalls.length = 0;
  persist();
}

function printDiagnostics() {
  console.group('Slopesmith diagnostics');
  console.info('Requests: headersMs = queue/server/first byte; bodyMs = transfer + decode');
  console.table(state.requests.map(entry => ({
    at: new Date(entry.at).toLocaleTimeString(), page: entry.page === page ? 'current' : 'previous',
    method: entry.method, url: entry.url,
    status: entry.httpStatus ?? entry.status, serverId: entry.serverId ?? '', cache: entry.cache ?? '',
    headersMs: entry.headersMs?.toFixed(1) ?? '', bodyMs: entry.bodyMs?.toFixed(1) ?? '',
    totalMs: entry.totalMs?.toFixed(1) ?? '', error: entry.error ?? '',
  })));
  console.info('Client phases');
  console.table(state.phases.map(entry => ({
    at: new Date(entry.at).toLocaleTimeString(), page: entry.page === page ? 'current' : 'previous',
    category: entry.category, name: entry.name,
    status: entry.status, durationMs: entry.durationMs?.toFixed(1) ?? '', detail: entry.detail ?? '',
    error: entry.error ?? '',
  })));
  console.info('Main-thread stalls');
  console.table(state.stalls.map(entry => ({
    at: new Date(entry.at).toLocaleTimeString(), page: entry.page === page ? 'current' : 'previous',
    kind: entry.kind, durationMs: entry.durationMs.toFixed(1),
  })));
  console.groupEnd();
}

export interface SlopesmithDiagnosticsApi {
  snapshot(): DiagnosticSnapshot;
  print(): void;
  clear(): void;
}

declare global {
  interface Window { slopesmithDiagnostics?: SlopesmithDiagnosticsApi; }
}

loadPrevious();

if (typeof window !== 'undefined') {
  window.slopesmithDiagnostics = { snapshot: diagnosticsSnapshot, print: printDiagnostics, clear: clearDiagnostics };
  const supported = typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes?.includes('longtask');
  if (supported) {
    const observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) recordStall('long-task', entry.duration, entry.startTime);
    });
    observer.observe({ entryTypes: ['longtask'] });
  } else if (typeof document !== 'undefined') {
    const interval = 250;
    let last = performance.now();
    window.setInterval(() => {
      const now = performance.now(), gap = now - last;
      if (document.visibilityState === 'visible' && gap >= interval + 500)
        recordStall('event-loop-gap', gap - interval, last);
      last = now;
    }, interval);
  }
}
