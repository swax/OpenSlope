import type { GpuTimerState } from '../ride/perf';

/** The WebGL2 timer-query extension is not included in TypeScript's DOM declarations. */
interface DisjointTimerQueryWebGl2 {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

export interface GpuTimerReading {
  /** A newly completed result. Null while the asynchronous query is still in flight. */
  gpuMs: number | null;
  state: GpuTimerState;
}

export interface GpuFrameTimer {
  /** Poll old results and, when possible, begin timing the render that follows. */
  beginFrame(): GpuTimerReading;
  /** End the query begun by `beginFrame`; harmless when no query could be started. */
  endFrame(): void;
  /** Discard old-session queries while retaining extension capability for a later session. */
  reset(): void;
  dispose(): void;
}

/**
 * Results commonly trail submission by several frames. Keep enough ended queries in flight to avoid a stall,
 * but stop issuing more if a driver falls behind: profiling must never become an unbounded GPU-work queue.
 */
const MAX_PENDING_QUERIES = 12;

/**
 * Non-blocking elapsed GPU time around one complete Three render. No `gl.finish()`, no same-frame result read:
 * both would serialize the CPU and GPU and change the frame this is intended to measure.
 */
export function createGpuFrameTimer(gl: WebGL2RenderingContext): GpuFrameTimer {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as DisjointTimerQueryWebGl2 | null;
  if (!ext) return unsupportedTimer();

  let active: WebGLQuery | null = null;
  const pending: WebGLQuery[] = [];
  let state: GpuTimerState = 'pending';
  let hasValidResult = false;

  function discardPending() {
    for (const query of pending) gl.deleteQuery(query);
    pending.length = 0;
  }

  /** Return only a NEW result; the shared profiler owns smoothing and retention of the last valid value. */
  function poll(): GpuTimerReading {
    if (gl.getParameter(ext!.GPU_DISJOINT_EXT) === true) {
      discardPending();
      hasValidResult = false;
      state = 'disjoint';
      return { gpuMs: null, state };
    }

    let newestMs: number | null = null;
    // Query completion is ordered. Consume every ready result so the number returned is the freshest one.
    while (pending.length > 0
      && gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE) === true) {
      const query = pending.shift()!;
      const nanoseconds = Number(gl.getQueryParameter(query, gl.QUERY_RESULT));
      gl.deleteQuery(query);
      if (Number.isFinite(nanoseconds) && nanoseconds >= 0) newestMs = nanoseconds / 1e6;
    }
    if (newestMs !== null) {
      hasValidResult = true;
      state = 'ok';
      return { gpuMs: newestMs, state };
    }
    state = hasValidResult ? 'ok' : 'pending';
    return { gpuMs: null, state };
  }

  function beginFrame(): GpuTimerReading {
    const reading = poll();
    // A disjoint event invalidates the outstanding interval. Wait for the flag to clear before measuring again.
    if (reading.state === 'disjoint' || pending.length >= MAX_PENDING_QUERIES) return reading;
    // Do not collide with a timer query installed by browser instrumentation or another renderer component.
    if (gl.getQuery(ext!.TIME_ELAPSED_EXT, gl.CURRENT_QUERY)) return reading;
    const query = gl.createQuery();
    if (!query) return reading;
    gl.beginQuery(ext!.TIME_ELAPSED_EXT, query);
    active = query;
    return reading;
  }

  function endFrame() {
    if (!active) return;
    gl.endQuery(ext!.TIME_ELAPSED_EXT);
    pending.push(active);
    active = null;
  }

  function reset() {
    if (active) {
      gl.endQuery(ext!.TIME_ELAPSED_EXT);
      gl.deleteQuery(active);
      active = null;
    }
    discardPending();
    hasValidResult = false;
    state = 'pending';
  }

  return { beginFrame, endFrame, reset, dispose: reset };
}

function unsupportedTimer(): GpuFrameTimer {
  const reading: GpuTimerReading = { gpuMs: null, state: 'unsupported' };
  return { beginFrame: () => reading, endFrame: () => {}, reset: () => {}, dispose: () => {} };
}
