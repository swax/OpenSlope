export type GpuTimerState = 'unsupported' | 'pending' | 'ok' | 'disjoint';

/** One raw viewport-frame sample. Broad phases are mutually exclusive; `aiMs` is a drill-down inside `rideMs`. */
export interface RideFrameTimingSample {
  frameMs: number;
  /** Headset input, on-foot locomotion/collision, and pre-world XR actions. */
  xrBeginMs: number;
  /** Drill-down inside XR begin / desktop ride time; never add to the broad CPU phases a second time. */
  walkCollisionMs: number;
  walkGroundCasts: number;
  walkSweeps: number;
  walkTriangleTests: number;
  walkLiveRefits: number;
  worldMs: number;
  rideMs: number;
  effectsMs: number;
  sceneMs: number;
  /** Post-world rig seating, tracked-hand/avatar posing, and headset HUD work. */
  xrEndMs: number;
  /** Drill-down inside renderMs: visibility/range prep and GPU-query setup before Three.js submission. */
  renderPrepMs: number;
  /** Drill-down inside renderMs: Three.js traversal, culling, sorting, state changes and WebGL submission. */
  renderSubmitMs: number;
  renderMs: number;
  /** Previous frame's work after render timing closed: workload census, profiler recording, and mirror gizmo. */
  postFrameMs: number;
  /** Newly completed asynchronous GPU query, not necessarily the render submitted by this same JS frame. */
  gpuMs: number | null;
  gpuTimerState: GpuTimerState;
  aiMs: number;
  drawCalls: number;
  renderTriangles: number;
  renderLines: number;
  renderPoints: number;
  /** Logical per-view render-list entries; unlike drawCalls these are not multiplied by stereo views. */
  renderOpaqueItems: number;
  renderTransparentItems: number;
  renderTransmissiveItems: number;
  /** Transparent render-list entries split by source; together these equal renderTransparentItems. */
  renderTransparentRefBatches: number;
  renderTransparentRefIsolated: number;
  renderTransparentAuthoredProps: number;
  renderTransparentOther: number;
  /** Cached, low-frequency top owners inside the otherwise-unclassified transparent bucket. */
  renderTransparentOtherSources: string;
  geometries: number;
  textures: number;
  programs: number;
  multiDraw: boolean;
  propBatchDraws: number;
  propBatchSlots: number;
  propIsolatedDraws: number;
  propIsolatedSlots: number;
  authoredPropDraws: number;
  propIsolation: string;
}

/** Live Play profiler state. Public values are exponential moving averages; `*Accum`/`*T0` are frame scratch. */
export interface RidePerf {
  fps: number;
  frameMs: number;
  xrBeginMs: number;
  walkCollisionMs: number;
  walkGroundCasts: number;
  walkSweeps: number;
  walkTriangleTests: number;
  walkLiveRefits: number;
  worldMs: number;
  rideMs: number;
  effectsMs: number;
  sceneMs: number;
  xrEndMs: number;
  renderPrepMs: number;
  renderSubmitMs: number;
  renderMs: number;
  postFrameMs: number;
  /** Smoothed latest valid elapsed-GPU result, or null until/unless the extension produces one. */
  gpuMs: number | null;
  gpuTimerState: GpuTimerState;
  aiMs: number;
  physicsMs: number;
  castMs: number;
  poseMs: number;
  cameraMs: number;
  telemetryMs: number;
  hudMs: number;
  drawCalls: number;
  renderTriangles: number;
  renderLines: number;
  renderPoints: number;
  renderOpaqueItems: number;
  renderTransparentItems: number;
  renderTransmissiveItems: number;
  renderTransparentRefBatches: number;
  renderTransparentRefIsolated: number;
  renderTransparentAuthoredProps: number;
  renderTransparentOther: number;
  renderTransparentOtherSources: string;
  geometries: number;
  textures: number;
  programs: number;
  multiDraw: boolean;
  propBatchDraws: number;
  propBatchSlots: number;
  propIsolatedDraws: number;
  propIsolatedSlots: number;
  authoredPropDraws: number;
  propIsolation: string;
  castAccum: number;
  stepT0: number;
  rideTris: number;
}

export function createRidePerf(): RidePerf {
  return {
    fps: 0, frameMs: 0,
    xrBeginMs: 0, walkCollisionMs: 0, walkGroundCasts: 0, walkSweeps: 0,
    walkTriangleTests: 0, walkLiveRefits: 0,
    worldMs: 0, rideMs: 0, effectsMs: 0, sceneMs: 0, xrEndMs: 0,
    renderPrepMs: 0, renderSubmitMs: 0, renderMs: 0, postFrameMs: 0, gpuMs: null,
    gpuTimerState: 'pending', aiMs: 0,
    physicsMs: 0, castMs: 0, poseMs: 0, cameraMs: 0, telemetryMs: 0, hudMs: 0,
    drawCalls: 0, renderTriangles: 0, renderLines: 0, renderPoints: 0,
    renderOpaqueItems: 0, renderTransparentItems: 0, renderTransmissiveItems: 0,
    renderTransparentRefBatches: 0, renderTransparentRefIsolated: 0,
    renderTransparentAuthoredProps: 0, renderTransparentOther: 0, renderTransparentOtherSources: '',
    geometries: 0, textures: 0, programs: 0, multiDraw: false,
    propBatchDraws: 0, propBatchSlots: 0, propIsolatedDraws: 0, propIsolatedSlots: 0,
    authoredPropDraws: 0, propIsolation: '',
    castAccum: 0, stepT0: 0, rideTris: 0,
  };
}

/** Smooth noisy per-frame timers without hiding a sustained regression. The first real sample seats immediately. */
export function smoothRideMs(previous: number, sample: number): number {
  const value = Number.isFinite(sample) ? Math.max(0, sample) : 0;
  return previous > 0 ? previous * 0.9 + value * 0.1 : value;
}

export function recordRideFrameTimings(perf: RidePerf, sample: RideFrameTimingSample): void {
  perf.frameMs = smoothRideMs(perf.frameMs, sample.frameMs);
  perf.fps = perf.frameMs > 0 ? 1000 / perf.frameMs : 0;
  perf.xrBeginMs = smoothRideMs(perf.xrBeginMs, sample.xrBeginMs);
  perf.walkCollisionMs = smoothRideMs(perf.walkCollisionMs, sample.walkCollisionMs);
  perf.walkGroundCasts = safeCount(sample.walkGroundCasts);
  perf.walkSweeps = safeCount(sample.walkSweeps);
  perf.walkTriangleTests = safeCount(sample.walkTriangleTests);
  perf.walkLiveRefits = safeCount(sample.walkLiveRefits);
  perf.worldMs = smoothRideMs(perf.worldMs, sample.worldMs);
  perf.rideMs = smoothRideMs(perf.rideMs, sample.rideMs);
  perf.effectsMs = smoothRideMs(perf.effectsMs, sample.effectsMs);
  perf.sceneMs = smoothRideMs(perf.sceneMs, sample.sceneMs);
  perf.xrEndMs = smoothRideMs(perf.xrEndMs, sample.xrEndMs);
  perf.renderPrepMs = smoothRideMs(perf.renderPrepMs, sample.renderPrepMs);
  perf.renderSubmitMs = smoothRideMs(perf.renderSubmitMs, sample.renderSubmitMs);
  perf.renderMs = smoothRideMs(perf.renderMs, sample.renderMs);
  perf.postFrameMs = smoothRideMs(perf.postFrameMs, sample.postFrameMs);
  perf.gpuTimerState = sample.gpuTimerState;
  if (sample.gpuMs !== null && Number.isFinite(sample.gpuMs) && sample.gpuMs >= 0) {
    perf.gpuMs = smoothRideMs(perf.gpuMs ?? 0, sample.gpuMs);
  } else if (sample.gpuTimerState === 'unsupported' || sample.gpuTimerState === 'disjoint') {
    perf.gpuMs = null;
  }
  perf.aiMs = smoothRideMs(perf.aiMs, sample.aiMs);
  // Workload counters are exact post-render snapshots, not durations. Keeping them integral makes a Props-filter
  // comparison immediately legible and avoids reporting fictional fractional draw calls after a visibility flip.
  perf.drawCalls = safeCount(sample.drawCalls);
  perf.renderTriangles = safeCount(sample.renderTriangles);
  perf.renderLines = safeCount(sample.renderLines);
  perf.renderPoints = safeCount(sample.renderPoints);
  perf.renderOpaqueItems = safeCount(sample.renderOpaqueItems);
  perf.renderTransparentItems = safeCount(sample.renderTransparentItems);
  perf.renderTransmissiveItems = safeCount(sample.renderTransmissiveItems);
  perf.renderTransparentRefBatches = safeCount(sample.renderTransparentRefBatches);
  perf.renderTransparentRefIsolated = safeCount(sample.renderTransparentRefIsolated);
  perf.renderTransparentAuthoredProps = safeCount(sample.renderTransparentAuthoredProps);
  perf.renderTransparentOther = safeCount(sample.renderTransparentOther);
  perf.renderTransparentOtherSources = sample.renderTransparentOtherSources;
  perf.geometries = safeCount(sample.geometries);
  perf.textures = safeCount(sample.textures);
  perf.programs = safeCount(sample.programs);
  perf.multiDraw = sample.multiDraw;
  perf.propBatchDraws = safeCount(sample.propBatchDraws);
  perf.propBatchSlots = safeCount(sample.propBatchSlots);
  perf.propIsolatedDraws = safeCount(sample.propIsolatedDraws);
  perf.propIsolatedSlots = safeCount(sample.propIsolatedSlots);
  perf.authoredPropDraws = safeCount(sample.authoredPropDraws);
  perf.propIsolation = sample.propIsolation;
}

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/** Mutually-exclusive CPU phases only. Ride drill-down values must not be added here a second time. */
export function measuredRideCpuMs(perf: Readonly<RidePerf>): number {
  return perf.xrBeginMs + perf.worldMs + perf.rideMs + perf.effectsMs + perf.sceneMs
    + perf.xrEndMs + perf.renderMs + perf.postFrameMs;
}

/** Time not observed on the JS thread: normally vsync/idle plus GPU work, but also browser/OS scheduling. */
export function unmeasuredRideFrameMs(perf: Readonly<RidePerf>): number {
  return Math.max(0, perf.frameMs - measuredRideCpuMs(perf));
}

/**
 * Approximate time outside the app's critical CPU/GPU path. CPU submission and GPU execution overlap, so they
 * must not be added and subtracted from the frame interval. The remainder after the slower side is useful for
 * spotting compositor/vsync/runtime pacing, but it is explicitly an estimate rather than a measured phase.
 */
export function estimatedRidePacingMs(perf: Readonly<RidePerf>): number | null {
  if (perf.gpuTimerState !== 'ok' || perf.gpuMs === null) return null;
  return Math.max(0, perf.frameMs - Math.max(measuredRideCpuMs(perf), perf.gpuMs));
}
