import assert from 'node:assert/strict';
import {
  createRidePerf, estimatedRidePacingMs, measuredRideCpuMs, recordRideFrameTimings, smoothRideMs,
  unmeasuredRideFrameMs,
} from '../src/app/ride/perf';

const perf = createRidePerf();
recordRideFrameTimings(perf, {
  frameMs: 20, xrBeginMs: 2, walkCollisionMs: 1.25, walkGroundCasts: 3, walkSweeps: 1,
  walkTriangleTests: 17, walkLiveRefits: 1, worldMs: 1, rideMs: 3, effectsMs: 2, sceneMs: 1.5,
  xrEndMs: 1, renderPrepMs: 0.5, renderSubmitMs: 2, renderMs: 2.5, postFrameMs: 0.25, aiMs: 1,
  gpuMs: 12, gpuTimerState: 'ok',
  drawCalls: 1234, renderTriangles: 345678, renderLines: 12, renderPoints: 34,
  renderOpaqueItems: 100, renderTransparentItems: 20, renderTransmissiveItems: 3, multiDraw: false,
  renderTransparentRefBatches: 12, renderTransparentRefIsolated: 3,
  renderTransparentAuthoredProps: 2, renderTransparentOther: 3, renderTransparentOtherSources: 'riders 3',
  geometries: 567, textures: 89, programs: 23,
  propBatchDraws: 20, propBatchSlots: 800, propIsolatedDraws: 30, propIsolatedSlots: 40,
  authoredPropDraws: 12, propIsolation: 'model-animation 30',
});
assert.equal(perf.fps, 50);
assert.equal(measuredRideCpuMs(perf), 13.25);
assert.equal(unmeasuredRideFrameMs(perf), 6.75);
assert.equal(perf.gpuMs, 12);
assert.equal(estimatedRidePacingMs(perf), 6.75, 'CPU and GPU overlap; pacing subtracts the slower path, not both');
assert.equal(perf.aiMs, 1, 'AI is recorded as ride drill-down, not an extra broad CPU phase');
assert.deepEqual(
  [perf.walkCollisionMs, perf.walkGroundCasts, perf.walkSweeps, perf.walkTriangleTests, perf.walkLiveRefits],
  [1.25, 3, 1, 17, 1],
  'walking collision is visible as an XR/ride drill-down without inflating broad CPU time',
);
assert.deepEqual(
  [perf.drawCalls, perf.renderTriangles, perf.renderLines, perf.renderPoints], [1234, 345678, 12, 34],
  'renderer workload counters retain the exact completed-frame snapshot',
);
assert.deepEqual([perf.renderPrepMs, perf.renderSubmitMs], [0.5, 2],
  'render preparation and Three.js submission remain visible as drill-downs inside render CPU');
assert.deepEqual([perf.renderOpaqueItems, perf.renderTransparentItems, perf.renderTransmissiveItems], [100, 20, 3],
  'logical render-list composition is retained without stereo multiplication');
assert.deepEqual([
  perf.renderTransparentRefBatches, perf.renderTransparentRefIsolated,
  perf.renderTransparentAuthoredProps, perf.renderTransparentOther,
], [12, 3, 2, 3], 'transparent entries retain their actionable source split');
assert.equal(perf.renderTransparentOtherSources, 'riders 3');
assert.deepEqual([perf.geometries, perf.textures, perf.programs], [567, 89, 23]);

recordRideFrameTimings(perf, {
  frameMs: 10, xrBeginMs: 0, walkCollisionMs: 0, walkGroundCasts: 0, walkSweeps: 0,
  walkTriangleTests: 0, walkLiveRefits: 0, worldMs: 0, rideMs: 1, effectsMs: 0, sceneMs: 0.5,
  xrEndMs: 0, renderPrepMs: 0, renderSubmitMs: 1.5, renderMs: 1.5, postFrameMs: 0, aiMs: 0,
  gpuMs: null, gpuTimerState: 'ok',
  drawCalls: 100, renderTriangles: 200, renderLines: 0, renderPoints: 0,
  renderOpaqueItems: 0, renderTransparentItems: 0, renderTransmissiveItems: 0, multiDraw: true,
  renderTransparentRefBatches: 0, renderTransparentRefIsolated: 0,
  renderTransparentAuthoredProps: 0, renderTransparentOther: 0, renderTransparentOtherSources: '',
  geometries: 50, textures: Number.NaN, programs: -1,
  propBatchDraws: 2, propBatchSlots: 80, propIsolatedDraws: 3, propIsolatedSlots: 4,
  authoredPropDraws: 1, propIsolation: 'effect-host 3',
});
assert.equal(perf.frameMs, 19, 'frame intervals use the shared 90/10 smoothing law');
assert.ok(Math.abs(perf.fps - 1000 / 19) < 1e-9);
assert.ok(Math.abs(perf.rideMs - 2.8) < 1e-9);
assert.equal(perf.aiMs, 0.9);
assert.deepEqual([perf.drawCalls, perf.renderTriangles, perf.geometries], [100, 200, 50]);
assert.deepEqual([perf.textures, perf.programs], [0, 0], 'invalid workload counters cannot poison the HUD');
assert.equal(smoothRideMs(0, Number.NaN), 0, 'invalid browser samples cannot poison the HUD');

perf.frameMs = 2;
assert.equal(unmeasuredRideFrameMs(perf), 0, 'timer noise cannot display a negative non-CPU value');

recordRideFrameTimings(perf, {
  frameMs: 10, xrBeginMs: 0, walkCollisionMs: 0, walkGroundCasts: 0, walkSweeps: 0,
  walkTriangleTests: 0, walkLiveRefits: 0, worldMs: 0, rideMs: 0, effectsMs: 0, sceneMs: 0,
  xrEndMs: 0, renderPrepMs: 0, renderSubmitMs: 1, renderMs: 1, postFrameMs: 0, aiMs: 0,
  gpuMs: null, gpuTimerState: 'disjoint', drawCalls: 0, renderTriangles: 0, renderLines: 0,
  renderPoints: 0, renderOpaqueItems: 0, renderTransparentItems: 0, renderTransmissiveItems: 0,
  renderTransparentRefBatches: 0, renderTransparentRefIsolated: 0,
  renderTransparentAuthoredProps: 0, renderTransparentOther: 0, renderTransparentOtherSources: '',
  multiDraw: false, geometries: 0, textures: 0, programs: 0, propBatchDraws: 0,
  propBatchSlots: 0, propIsolatedDraws: 0, propIsolatedSlots: 0, authoredPropDraws: 0, propIsolation: '',
});
assert.equal(perf.gpuMs, null, 'a GPU clock discontinuity retires the now-untrustworthy prior result');
assert.equal(estimatedRidePacingMs(perf), null, 'pacing is not invented without a valid GPU timer');

console.log('RIDE PERF: PASS');
