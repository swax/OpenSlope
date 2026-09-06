import {
  RIDE_CONTRACT_PROFILE,
  RIDE_CONTRACT_SCHEMA,
  RIDE_CONTRACT_VERSION,
} from './ride-contract.generated';

/**
 * Fixed-tick ride telemetry shared by the live TestRide recorder and headless physics diagnostics.
 *
 * The physics model owns the measurements; this module only defines their JSON-safe shape and buffers them.
 * Keeping the capture side ignorant of THREE objects makes every record immutable after emission and lets the
 * scripts consume exactly the same data the browser downloads.
 */

export const RIDE_TELEMETRY_SCHEMA = 'slopesmith-ride-telemetry/v7';

export type RideTelemetryVec3 = [number, number, number];
export type RideTelemetryProbeSource = 'analytic-ray' | 'faceted-ray' | 'recovery' | 'none';

export interface RideTelemetryState {
  position: RideTelemetryVec3;
  velocity: RideTelemetryVec3;
  speed: number;
  /** Physics heading before deck-pitch projection. */
  forward: RideTelemetryVec3;
  /** Visible deck +Z after projection against `boardUp`; bank does not change this axis. */
  deckForward: RideTelemetryVec3;
  /** Which end of the deck leads the travel: +1 regular, −1 switch. `forward` is the nose either way, so this is
   *  the only field that separates a landed 180 from a rider who is simply skidding backwards. */
  lead: number;
  /** Accumulated flip about the deck's lateral axis, degrees, signed forward-over-the-nose. Never folded, so a
   *  run's whole rotation count reads straight off it; grounded it eases to the nearest multiple of 360. */
  flip: number;
  boardUp: RideTelemetryVec3;
  contactNormal: RideTelemetryVec3;
  /** Signed degrees above the world-horizontal plane; downhill/nose-down is negative. */
  trajectoryPitchDeg: number;
  boardPitchDeg: number;
  grounded: boolean;
  forcedAir: boolean;
  railIndex: number;
  airTime: number;
  error: number;
  surfaceType: number;
  speedCap: number;
  /** Smoothed steering lean, signed, ±0.905 at the clamp — recorded so retail lean comparisons need no input inference. */
  lean: number;
  /** Slewed lateral carve slide in metres (out of the turn); the probe base and drawn deck both carry it. */
  carveSlide: number;
  charging: boolean;
  jumpCharge: number;
  jumpGrace: number;
  ollieCooldown: number;
}

export interface RideTelemetryProbe {
  source: RideTelemetryProbeSource;
  found: boolean;
  aim: RideTelemetryVec3;
  point: RideTelemetryVec3;
  normal: RideTelemetryVec3;
  surfaceType: number;
  error: number;
  groundThreshold: number;
  /** Signed velocity along the fresh normal; positive means separating, negative means approaching. */
  normalSpeed: number;
  acceptedGround: boolean;
}

export interface RideTelemetryRedirect {
  normal: RideTelemetryVec3;
  normalVelocity: number;
  speed: number;
  velocityBefore: RideTelemetryVec3;
  velocityAfter: RideTelemetryVec3;
}

export type RideTelemetryEvent =
  | { type: 'takeoff' }
  | { type: 'touchdown' }
  | {
      type: 'launch';
      charge: number;
      direction: RideTelemetryVec3;
      impulse: number;
      velocityBefore: RideTelemetryVec3;
      velocityAfter: RideTelemetryVec3;
    }
  | {
      type: 'barrier-resolved' | 'floor-crossing-deferred';
      distance: number;
      normal: RideTelemetryVec3;
      velocityBefore?: RideTelemetryVec3;
      velocityAfter?: RideTelemetryVec3;
    }
  /**
   * A contact with a native `movable` body and what the rigid-body shove made of it
   * ([Trailmap: 370-world-interaction]). Every term of the traced impulse is reported separately so a bag that
   * fails to fly can be read straight off the capture: `hasBody` false means the instance reached Play with no
   * authored mass properties, which leaves `rotational` at zero and the launch translation-only.
   */
  | {
      type: 'prop-shove';
      key: string;
      /** Whether the instance carried physics-body mass properties into the collision set. */
      hasBody: boolean;
      closingSpeed: number;
      /** n·((I⁻¹(r × n))×r) — zero when the body shipped no tensor. */
      rotational: number;
      /** The solved scalar impulse, and the denominator it came out of. */
      impulse: number;
      denominator: number;
      /** Contact offset from the body's centre of mass; the lever the angular half comes from. */
      offset: RideTelemetryVec3;
      normal: RideTelemetryVec3;
      /** What left the prop, and what the rider paid for it. */
      propLinear: RideTelemetryVec3;
      propAngular: RideTelemetryVec3;
      riderVelocityBefore: RideTelemetryVec3;
      riderVelocityAfter: RideTelemetryVec3;
    };

export interface RideTelemetryTick {
  kind: 'frame';
  frame: number;
  dt: number;
  /** Effective signed steering after choosing the active analog stick or digital-key fallback. */
  input: { steer: number; left: boolean; right: boolean; tuck: boolean; brake: boolean; boost: boolean };
  opening: RideTelemetryState;
  probe?: RideTelemetryProbe;
  redirect?: RideTelemetryRedirect;
  acceleration?: RideTelemetryVec3;
  events: RideTelemetryEvent[];
  closing: RideTelemetryState;
}

export type RideCameraClearance = 'none' | 'line-of-sight' | 'ground' | 'lateral' | 'volume';
export type RideCameraProbeKind =
  | 'origin-unbury' | 'line-of-sight' | 'ground' | 'lateral' | 'filtered-line-of-sight' | 'volume';
export type RideCameraProbeHitSource = 'terrain' | 'obstacle';

/** One exact query made by the render-frame camera clearance pass. Misses retain both endpoints. */
export interface RideCameraProbe {
  kind: RideCameraProbeKind;
  from: RideTelemetryVec3;
  to: RideTelemetryVec3;
  segmentLength: number;
  hit: boolean;
  hitDistance?: number;
  point?: RideTelemetryVec3;
  normal?: RideTelemetryVec3;
  source?: RideCameraProbeHitSource;
  obstacleKey?: string;
  /** Zero-based pass number for the bounded, iterative closest-surface volume guard. */
  iteration?: number;
}

/** JSON-safe render-camera state produced after the frame's interpolated rider pose is known. */
export interface RideCameraState {
  renderDt: number;
  subjectPosition: RideTelemetryVec3;
  candidatePosition: RideTelemetryVec3;
  position: RideTelemetryVec3;
  lookTarget: RideTelemetryVec3;
  forward: RideTelemetryVec3;
  up: RideTelemetryVec3;
  targetHeading: RideTelemetryVec3;
  trajectoryPitchDeg: number;
  targetTrajectoryPitchDeg: number;
  fovYDeg: number;
  nearClipM: number;
  aspect: number;
  boost: boolean;
  clearance: RideCameraClearance;
  correctionDistanceM: number;
  originUnburied: boolean;
  probes: RideCameraProbe[];
}

/** One camera sample per rendered ride frame, associated with the latest completed 60 Hz physics frame. */
export interface RideTelemetryCamera extends RideCameraState {
  kind: 'camera';
  frame: number;
  renderFrame: number;
}

/**
 * One in-flight sample of a SHOVED prop's moved-body simulation, taken by the scene each render frame while the
 * body is awake. The `prop-shove` event records only the launch instant; these records are the flight itself —
 * where the body actually went, how fast it was still moving, what the ground read under it was — so a bag that
 * "goes nowhere" can be diagnosed from a capture instead of from an offline reconstruction of the solver.
 */
export interface RideShovedBodySample {
  key: string;
  /** Seconds since the shove launched this body. */
  age: number;
  /** World centre of mass — the integrated state of the moved-body sim. */
  com: RideTelemetryVec3;
  velocity: RideTelemetryVec3;
  angular: RideTelemetryVec3;
  /** Ground height the sim read under the CoM this frame; null when the scene had no ground answer. */
  groundY: number | null;
  /** Support distance from the CoM to the body's underside (its launch-time ground clearance). */
  radius: number;
  /** True once the activity accumulator has put the body to sleep; the final resting sample. */
  asleep: boolean;
}

export interface RideTelemetryShovedBody extends RideShovedBodySample {
  kind: 'shoved-body';
  frame: number;
  renderFrame: number;
}

export interface RideTelemetryHeader {
  kind: 'header';
  schema: typeof RIDE_TELEMETRY_SCHEMA;
  capturedAtUtc: string;
  label: string;
  simulationHz: 60;
  coordinates: { upAxis: 'Y'; unitsPerMeter: 1 };
  rideContract: {
    schema: typeof RIDE_CONTRACT_SCHEMA;
    version: typeof RIDE_CONTRACT_VERSION;
    profile: typeof RIDE_CONTRACT_PROFILE;
  };
  controls: { startOrSave: 'F8'; marker: 'M'; preRollSeconds: number };
}

export interface RideTelemetryMarker {
  kind: 'marker';
  frame: number;
  index: number;
  note: string;
}

export interface RideTelemetrySummary {
  schema: typeof RIDE_TELEMETRY_SCHEMA;
  label: string;
  frames: number;
  cameraFrames: number;
  firstFrame: number | null;
  lastFrame: number | null;
  markers: number;
  takeoffs: number;
  touchdowns: number;
  launches: number;
  barrierResolutions: number;
  deferredFloorCrossings: number;
  /** Rigid-body shoves of native `movable` props, and how many of those found no authored mass properties —
   *  a non-zero `propShovesWithoutBody` is the reason a crash bag leaves without its solved tumble. */
  propShoves: number;
  propShovesWithoutBody: number;
  /** Flight samples of shoved bodies, and the per-body digest a stuck bag is diagnosed from: where it launched,
   *  where it ended, how far it actually travelled, how high its underside got, and whether it went to sleep. */
  shovedBodySamples: number;
  shovedBodies: Array<{
    key: string;
    samples: number;
    settled: boolean;
    launch: RideTelemetryVec3;
    rest: RideTelemetryVec3;
    travelM: number;
    peakUndersideM: number | null;
  }>;
  takeoffSamples: Array<{
    frame: number;
    speed: number;
    trajectoryPitchDeg: number;
    boardPitchDeg: number;
  }>;
}

export interface RideTelemetryFooter {
  kind: 'footer';
  summary: RideTelemetrySummary;
}

export type RideTelemetryRecord =
  | RideTelemetryHeader | RideTelemetryTick | RideTelemetryCamera | RideTelemetryShovedBody
  | RideTelemetryMarker | RideTelemetryFooter;

export interface RideTelemetryOutput {
  baseName: string;
  jsonl: string;
  summaryJson: string;
  summary: RideTelemetrySummary;
}

export interface RideTelemetryCaptureOpts {
  label: string;
  preRollTicks?: number;
  now?: () => Date;
}

/** In-memory capture with a three-second default pre-roll, so a marker may be pressed after the bad lip. */
export class RideTelemetryCapture {
  private readonly label: string;
  private readonly preRollTicks: number;
  private readonly now: () => Date;
  private readonly preRoll: Array<RideTelemetryTick | RideTelemetryCamera | RideTelemetryShovedBody> = [];
  private records: RideTelemetryRecord[] = [];
  private latestFrame = 0;
  private latestRenderFrame = 0;
  private nextMarker = 1;
  private startedAt: Date | null = null;
  private recording = false;

  constructor(opts: RideTelemetryCaptureOpts) {
    this.label = opts.label;
    this.preRollTicks = Math.max(0, Math.floor(opts.preRollTicks ?? 180));
    this.now = opts.now ?? (() => new Date());
  }

  get active() { return this.recording; }
  get markerCount() { return this.nextMarker - 1; }

  ingest(frame: RideTelemetryTick) {
    this.latestFrame = frame.frame;
    if (this.recording) this.records.push(frame);
    this.pushPreRoll(frame);
  }

  /** Record the actual render camera after its interpolation and terrain-clearance pass. */
  ingestCamera(state: RideCameraState) {
    const sample: RideTelemetryCamera = {
      kind: 'camera', frame: this.latestFrame, renderFrame: ++this.latestRenderFrame, ...state,
    };
    if (this.recording) this.records.push(sample);
    this.pushPreRoll(sample);
  }

  /** Record every awake shoved body's flight sample for this render frame, after the camera sample so both
   *  carry the same frame/renderFrame pair. The scene stops reporting a body once its sleep has been seen, so a
   *  settled bag costs one final record, not sixteen more seconds of them. */
  ingestShovedBodies(samples: readonly RideShovedBodySample[]) {
    for (const sample of samples) {
      const record: RideTelemetryShovedBody = {
        kind: 'shoved-body', frame: this.latestFrame, renderFrame: this.latestRenderFrame, ...sample,
      };
      if (this.recording) this.records.push(record);
      this.pushPreRoll(record);
    }
  }

  /** Begin a capture and prepend the rolling context that led to it. Safe to call when already active. */
  start() {
    if (this.recording) return;
    this.startedAt = this.now();
    this.nextMarker = 1;
    this.records = [this.header(this.startedAt), ...this.preRoll];
    this.recording = true;
  }

  /** Mark the current physics frame. A marker arms recording automatically and retains the pre-roll. */
  mark(note = 'manual'): RideTelemetryMarker {
    if (!this.recording) this.start();
    const marker: RideTelemetryMarker = { kind: 'marker', frame: this.latestFrame, index: this.nextMarker++, note };
    this.records.push(marker);
    return marker;
  }

  /** Finish the current capture. The instance immediately returns to pre-roll standby for another segment. */
  finish(): RideTelemetryOutput | null {
    if (!this.recording || !this.startedAt) return null;
    const summary = summarizeRideTelemetry(this.records, this.label);
    const complete: RideTelemetryRecord[] = [...this.records, { kind: 'footer', summary }];
    const stamp = this.startedAt.toISOString().replace(/[:.]/g, '-');
    const safeLabel = this.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ride';
    const output: RideTelemetryOutput = {
      baseName: `${safeLabel}-${stamp}`,
      jsonl: `${complete.map(record => JSON.stringify(record)).join('\n')}\n`,
      summaryJson: `${JSON.stringify(summary, null, 2)}\n`,
      summary,
    };
    this.recording = false;
    this.records = [];
    this.startedAt = null;
    return output;
  }

  private header(at: Date): RideTelemetryHeader {
    return {
      kind: 'header', schema: RIDE_TELEMETRY_SCHEMA, capturedAtUtc: at.toISOString(), label: this.label,
      simulationHz: 60, coordinates: { upAxis: 'Y', unitsPerMeter: 1 },
      rideContract: {
        schema: RIDE_CONTRACT_SCHEMA, version: RIDE_CONTRACT_VERSION, profile: RIDE_CONTRACT_PROFILE,
      },
      controls: { startOrSave: 'F8', marker: 'M', preRollSeconds: this.preRollTicks / 60 },
    };
  }

  private pushPreRoll(record: RideTelemetryTick | RideTelemetryCamera | RideTelemetryShovedBody) {
    this.preRoll.push(record);
    const firstFrame = this.latestFrame - this.preRollTicks + 1;
    while (this.preRoll.length && this.preRoll[0].frame < firstFrame) this.preRoll.shift();
  }
}

export function summarizeRideTelemetry(records: readonly RideTelemetryRecord[], label: string): RideTelemetrySummary {
  const summary: RideTelemetrySummary = {
    schema: RIDE_TELEMETRY_SCHEMA, label, frames: 0, cameraFrames: 0,
    firstFrame: null, lastFrame: null, markers: 0,
    takeoffs: 0, touchdowns: 0, launches: 0, barrierResolutions: 0, deferredFloorCrossings: 0,
    propShoves: 0, propShovesWithoutBody: 0, shovedBodySamples: 0, shovedBodies: [],
    takeoffSamples: [],
  };
  const shovedDigests = new Map<string, RideTelemetrySummary['shovedBodies'][number]>();
  for (const record of records) {
    if (record.kind === 'marker') { summary.markers++; continue; }
    if (record.kind === 'camera') { summary.cameraFrames++; continue; }
    if (record.kind === 'shoved-body') {
      summary.shovedBodySamples++;
      let digest = shovedDigests.get(record.key);
      if (!digest) {
        digest = { key: record.key, samples: 0, settled: false, launch: record.com, rest: record.com,
          travelM: 0, peakUndersideM: null };
        shovedDigests.set(record.key, digest);
        summary.shovedBodies.push(digest);
      }
      digest.samples++;
      digest.settled = record.asleep;
      digest.rest = record.com;
      const dx = record.com[0] - digest.launch[0], dz = record.com[2] - digest.launch[2];
      digest.travelM = Math.round(Math.hypot(dx, dz) * 100) / 100;
      if (record.groundY !== null) {
        const underside = record.com[1] - record.radius - record.groundY;
        if (digest.peakUndersideM === null || underside > digest.peakUndersideM)
          digest.peakUndersideM = Math.round(underside * 100) / 100;
      }
      continue;
    }
    if (record.kind !== 'frame') continue;
    summary.frames++;
    summary.firstFrame ??= record.frame;
    summary.lastFrame = record.frame;
    for (const event of record.events) {
      if (event.type === 'takeoff') {
        summary.takeoffs++;
        summary.takeoffSamples.push({
          frame: record.frame, speed: record.closing.speed,
          trajectoryPitchDeg: record.closing.trajectoryPitchDeg,
          boardPitchDeg: record.closing.boardPitchDeg,
        });
      }
      else if (event.type === 'touchdown') summary.touchdowns++;
      else if (event.type === 'launch') summary.launches++;
      else if (event.type === 'barrier-resolved') summary.barrierResolutions++;
      else if (event.type === 'floor-crossing-deferred') summary.deferredFloorCrossings++;
      else if (event.type === 'prop-shove') {
        summary.propShoves++;
        if (!event.hasBody) summary.propShovesWithoutBody++;
      }
    }
  }
  return summary;
}

/** Browser-only handoff kept separate from capture so headless tests never need DOM shims. */
export function downloadRideTelemetry(output: RideTelemetryOutput) {
  download(`${output.baseName}.jsonl`, output.jsonl, 'application/x-ndjson');
  download(`${output.baseName}-summary.json`, output.summaryJson, 'application/json');
}

function download(filename: string, body: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 0);
}
