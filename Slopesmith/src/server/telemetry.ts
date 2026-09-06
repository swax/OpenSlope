import type { IncomingMessage, ServerResponse } from 'node:http';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { createLogger } from './log';
import { liveSessions } from './session/presence';
import { responseCache } from './response-cache';
import { workerPoolStats } from './worker-pool';

const apiLog = createLogger('api');
const telemetryLog = createLogger('telemetry');

interface RequestWindow {
  total: number;
  failed: number;
  aborted: number;
  active: number;
  durations: number[];
}

const window: RequestWindow = { total: 0, failed: 0, aborted: 0, active: 0, durations: [] };

const envMilliseconds = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
};

const percentile = (values: readonly number[], quantile: number): number => {
  if (!values.length) return 0;
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1)];
};

/**
 * Measure the API service itself rather than the development proxy in front of it. Only slow, failed or
 * aborted requests get an individual log line; the ordinary traffic is summarized by the runtime heartbeat.
 */
export function observeApiRequest(req: IncomingMessage, res: ServerResponse): void {
  const method = req.method ?? 'GET';
  // The path alone. A query string can carry a credential — LiveKit signalling arrives as
  // `?access_token=<JWT>` — and a slow-request line is not a place to keep one.
  const url = (req.url ?? '/').split('?')[0];
  const started = performance.now();
  const slowMs = envMilliseconds('SLOPESMITH_SLOW_REQUEST_MS', 1_000);
  window.active++;
  let finished = false;

  const finish = (aborted: boolean) => {
    if (finished) return;
    finished = true;
    const elapsed = performance.now() - started;
    window.active = Math.max(0, window.active - 1);
    window.total++;
    if (res.statusCode >= 500) window.failed++;
    if (aborted) window.aborted++;
    // One minute of timings is ordinarily tiny. Bound a pathological request flood without retaining one
    // object per request indefinitely; aggregate counts remain exact even after the sample is full.
    if (window.durations.length < 10_000) window.durations.push(elapsed);

    if (aborted || res.statusCode >= 500 || (slowMs > 0 && elapsed >= slowMs)) {
      const length = res.getHeader('content-length');
      const bytes = typeof length === 'number' ? length
        : typeof length === 'string' && /^\d+$/.test(length) ? Number(length) : null;
      apiLog.warn(`${method} ${url} -> ${res.statusCode} ${elapsed.toFixed(1)}ms`
        + `${bytes === null ? '' : ` ${bytes}B`}${aborted ? ' aborted' : ''}`);
    }
  };

  res.once('finish', () => finish(false));
  res.once('close', () => { if (!res.writableFinished) finish(true); });
}

export interface ServerTelemetry {
  stop(): void;
}

/**
 * Emit one compact, machine-readable health line per interval. DigitalOcean supplies host CPU/disk graphs;
 * this supplies what the host cannot see: event-loop delay, API latency, cache behavior, workers and sockets.
 *
 * It is the `telemetry heartbeat` log line, with the metrics as its fields — so `SLOPESMITH_LOG_FORMAT=json`
 * hands a collector one flat object a minute rather than JSON quoted inside a string (docs/041).
 */
export function startServerTelemetry(): ServerTelemetry {
  const intervalMs = envMilliseconds('SLOPESMITH_METRICS_INTERVAL_MS', 60_000);
  if (intervalMs === 0) return { stop() {} };

  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  let priorCpu = process.cpuUsage();
  let priorAt = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    const intervalElapsed = now - priorAt;
    const elapsedMicros = Math.max(1, intervalElapsed * 1_000);
    const cpu = process.cpuUsage(priorCpu);
    priorCpu = process.cpuUsage();
    priorAt = now;
    const memory = process.memoryUsage();
    const durations = window.durations.splice(0);
    const requests = {
      total: window.total,
      failed: window.failed,
      aborted: window.aborted,
      active: window.active,
      sampled: durations.length,
      averageMs: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
      p95Ms: percentile(durations, 0.95),
      maxMs: durations.length ? Math.max(...durations) : 0,
    };
    window.total = 0;
    window.failed = 0;
    window.aborted = 0;

    telemetryLog.info('heartbeat', {
      intervalMs: Math.round(intervalElapsed),
      cpuPercent: ((cpu.user + cpu.system) / elapsedMicros) * 100,
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
      },
      eventLoop: {
        p95Ms: delay.percentile(95) / 1e6,
        maxMs: delay.max / 1e6,
      },
      requests,
      sockets: liveSessions().length,
      cache: responseCache.stats(),
      workers: workerPoolStats(),
    });
    delay.reset();
  }, Math.max(5_000, intervalMs));
  timer.unref();

  return {
    stop() {
      clearInterval(timer);
      delay.disable();
    },
  };
}
