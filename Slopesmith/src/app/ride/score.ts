import { ORIENT_GRACE } from './physics-tuning';
import type { RideTelemetryState, RideTelemetryTick, RideTelemetryVec3 } from './telemetry';

/**
 * Unity's run-score constants (`RideableBoard.Score.cs`). Keeping the arithmetic in one small, physics-free
 * module makes the browser and headset views consumers of the same score instead of each approximating tricks
 * from render frames.
 */
export const RIDE_SCORE_STYLE_CONSTANT = 6786.9;
export const RIDE_SCORE_SPIN_PER_360 = 0.25;
export const RIDE_SCORE_BIG_AIR_SECONDS = 4;
export const RIDE_SCORE_BIG_AIR_PER_SECOND = 1000;
export const RIDE_SCORE_GRIND_STYLE_PER_SECOND = 0.15;
export const RIDE_SCORE_GRAB_TIER_SECONDS = 0.5;
export const RIDE_SCORE_GRAB_BEGIN_STYLE = 0.0425;
export const RIDE_SCORE_GRAB_STYLE_PER_SECOND = 0.045;
/** Unity only wipes the open trick once the unfinished deck tilt reaches `landAlignBad`. */
export const RIDE_SCORE_BAD_LANDING_DEGREES = 90;
/** Unity's decoded run-scoped boost/Tricky meter tuning. */
export const RIDE_BOOST_METER_START = 0.25;
export const RIDE_BOOST_FILL_PER_BASE_POINT = 0.0001;
export const RIDE_BOOST_DRAIN_PER_SECOND = 0.045;
export const RIDE_BOOST_CRASH_PENALTY = 0.1;
export const RIDE_BOOST_METER_SEGMENTS = 15;

export type RideScoreGrabHand = 'left' | 'right';
export type RideScoreBailReason = 'sloppy-landing' | 'out-of-bounds';

export interface RideScoreSnapshot {
  /** Banked run score plus the live, not-yet-landed trick preview. */
  score: number;
  banked: number;
  trickPoints: number;
  trickActive: boolean;
  multiplier: number;
  rotations: number;
  airSeconds: number;
  grindSeconds: number;
  grabSeconds: number;
  grinding: boolean;
  grabbing: boolean;
  grabHand: RideScoreGrabHand | null;
  /** The most recently banked or wiped trick. `-1` means this run has not resolved one yet. */
  lastTrickPoints: number;
  lastBailed: boolean;
  lastBailReason: RideScoreBailReason | null;
  /** Monotonic within a run, so presentation can hold equal-valued consecutive trick results independently. */
  resolution: number;
  /** Run-scoped boost energy. Outside an active scored run boost is unlimited and this value is presentation only. */
  boostMeter: number;
}

export interface RideTrickDisplay {
  state: 'live' | 'landed' | 'bailed';
  kind: 'rotation' | 'grind' | 'grab' | 'result';
  points: number;
  /** Unity's rotation equation, grind timer, grab timer, or bail reason. */
  detail: string | null;
}

/**
 * The run scorer ported from Unity's `RideableBoard.Score.cs`.
 *
 * Mounted motion arrives as fixed 60 Hz telemetry, so rotations and rail time are independent of display rate.
 * Off-board deck grabs arrive from the locomotion host because, by definition, the board physics is then parked.
 */
export function createRideScorer() {
  let active = false;
  let banked = 0;
  let frozenScore = 0;
  let comboActive = false;
  let spinDegrees = 0;
  let flipDegrees = 0;
  let airSeconds = 0;
  let grindStyle = 0;
  let grindSeconds = 0;
  let grabStyle = 0;
  let grabSeconds = 0;
  let grabHeldPrevious = false;
  let grabHand: RideScoreGrabHand | null = null;
  let multiplier = 1;
  let grinding = false;
  let grabbing = false;
  let lastTrickPoints = -1;
  let lastBailed = false;
  let lastBailReason: RideScoreBailReason | null = null;
  let resolution = 0;
  let boostMeter = 0;

  const preview = () => {
    const rotations = (spinDegrees + flipDegrees) / 360;
    const style = rotations * RIDE_SCORE_SPIN_PER_360 + grindStyle + grabStyle;
    const raw = style * multiplier * RIDE_SCORE_STYLE_CONSTANT;
    let points = raw > 0 ? unityRound(raw / 10) * 10 : 0;
    if (airSeconds >= RIDE_SCORE_BIG_AIR_SECONDS)
      points += unityRound((airSeconds - 3) * RIDE_SCORE_BIG_AIR_PER_SECOND);
    points += grabTierPoints(grabSeconds);
    return points;
  };

  const currentScore = () => active ? banked + preview() : frozenScore;

  /** BASE style points: no gem, big-air, or flat grab ladder. This is exactly what Unity feeds to the meter. */
  const meterBasePoints = () => {
    const rotations = (spinDegrees + flipDegrees) / 360;
    const style = rotations * RIDE_SCORE_SPIN_PER_360 + grindStyle + grabStyle;
    const raw = style * RIDE_SCORE_STYLE_CONSTANT;
    return raw > 0 ? unityRound(raw / 10) * 10 : 0;
  };

  function clearCombo(resetMultiplier = true) {
    comboActive = false;
    spinDegrees = 0;
    flipDegrees = 0;
    airSeconds = 0;
    grindStyle = 0;
    grindSeconds = 0;
    grabStyle = 0;
    grabSeconds = 0;
    grabHeldPrevious = false;
    grabHand = null;
    grinding = false;
    grabbing = false;
    if (resetMultiplier) multiplier = 1;
  }

  function start() {
    active = true;
    banked = 0;
    frozenScore = 0;
    lastTrickPoints = -1;
    lastBailed = false;
    lastBailReason = null;
    resolution = 0;
    boostMeter = RIDE_BOOST_METER_START;
    clearCombo();
  }

  function abandon() {
    active = false;
    banked = 0;
    frozenScore = 0;
    lastTrickPoints = -1;
    lastBailed = false;
    lastBailReason = null;
    resolution = 0;
    boostMeter = 0;
    clearCombo();
  }

  /** Freeze banked points plus the current preview, as Unity's finish line does before ending the run. */
  function finish(): number {
    if (active) frozenScore = banked + preview();
    active = false;
    grinding = false;
    grabbing = false;
    return frozenScore;
  }

  /** An OOB/reset loses only the open combo and its gem; points already landed remain in the run. */
  function bail() {
    if (!active) return;
    if (comboActive || spinDegrees > 0 || flipDegrees > 0 || grindSeconds > 0 || grabSeconds > 0) {
      lastTrickPoints = preview();
      lastBailed = true;
      lastBailReason = 'out-of-bounds';
      resolution++;
    }
    boostMeter = Math.max(0, boostMeter - RIDE_BOOST_CRASH_PENALTY);
    clearCombo();
  }

  function bankLanding(badLanding: boolean) {
    const realTrick = airSeconds > ORIENT_GRACE || grindSeconds > 0 || grabSeconds > 0;
    if (realTrick) {
      const points = preview();
      const basePoints = meterBasePoints();
      lastTrickPoints = points;
      lastBailed = badLanding;
      lastBailReason = badLanding ? 'sloppy-landing' : null;
      resolution++;
      if (!badLanding) {
        banked += points;
        boostMeter = Math.min(1, boostMeter + basePoints * RIDE_BOOST_FILL_PER_BASE_POINT);
      }
      clearCombo();
      return;
    }
    // A sub-grace bump is not a committed trick. Drop its tiny rotations but preserve a collected gem for the
    // first real trick, exactly like Unity's bump-skip branch.
    comboActive = false;
    spinDegrees = 0;
    flipDegrees = 0;
    airSeconds = 0;
    grinding = false;
    grabbing = false;
    grabHeldPrevious = false;
  }

  function addRotation(opening: RideTelemetryState, closing: RideTelemetryState) {
    spinDegrees += vectorAngleDegrees(opening.forward, closing.forward);
    flipDegrees += Math.abs(closing.flip - opening.flip);
  }

  /** Consume one completed fixed physics tick. */
  function ingest(tick: RideTelemetryTick) {
    if (!active) return;
    const opening = tick.opening, closing = tick.closing;
    const launched = tick.events.some(event => event.type === 'launch');
    const onRail = closing.railIndex >= 0;
    const inAir = !closing.grounded && !onRail;

    // A rail ollie launches in the shared tick tail, after a complete grind frame. Treat that one as rail work;
    // a natural rail-end transition instead executes airTick immediately and belongs to the air branch below.
    if (onRail || (opening.railIndex >= 0 && launched)) {
      addRotation(opening, closing);
      comboActive = true;
      airSeconds = 0;
      grindSeconds += tick.dt;
      grindStyle += RIDE_SCORE_GRIND_STYLE_PER_SECOND * tick.dt;
      grinding = onRail;
      grabbing = false;
      grabHeldPrevious = false;
      return;
    }

    if (inAir) {
      // A ground ollie is launched after the ground integrator and performs no air rotation on that tick. Every
      // other transition into air already ran airTick and therefore contributes its measured facing/flip delta.
      if (!(opening.grounded && launched)) addRotation(opening, closing);
      if (!comboActive) { comboActive = true; airSeconds = 0; }
      else airSeconds += tick.dt;
      grinding = false;
      grabbing = false;
      grabHeldPrevious = false;
      return;
    }

    grinding = false;
    grabbing = false;
    grabHeldPrevious = false;
    if (!comboActive) return;
    const touchdown = tick.events.some(event => event.type === 'touchdown');
    const badLanding = touchdown && landingTiltDegrees(opening, closing) >= RIDE_SCORE_BAD_LANDING_DEGREES;
    bankLanding(badLanding);
  }

  /**
   * Continue the open trick while the rider is airborne without the board. Unity does not add this interval to
   * big-air time, but a held deck earns the named-trick begin bump, held style, and flat half-second ladder.
   */
  function stepOffBoard(dt: number, hand: RideScoreGrabHand | null) {
    if (!active || dt <= 0) return;
    comboActive = true;
    grinding = false;
    grabbing = hand !== null;
    if (!hand) { grabHeldPrevious = false; return; }
    if (!grabHeldPrevious) grabStyle += RIDE_SCORE_GRAB_BEGIN_STYLE;
    grabHeldPrevious = true;
    grabSeconds += dt;
    grabStyle += RIDE_SCORE_GRAB_STYLE_PER_SECOND * dt;
    grabHand = hand;
  }

  /** Gems are max-not-stack; the session owns the Showoff-only mode gate before calling this. */
  function applyMultiplier(value: number) {
    if (active && Number.isFinite(value) && value > multiplier) multiplier = value;
  }

  /** Drain only for the rider's held boost input. Course pads remain free and never call this path. */
  function stepBoost(dt: number, held: boolean) {
    if (!active || !held || dt <= 0 || boostMeter <= 0) return;
    boostMeter = Math.max(0, boostMeter - RIDE_BOOST_DRAIN_PER_SECOND * dt);
  }

  function snapshot(): RideScoreSnapshot {
    const trickPoints = active ? preview() : Math.max(0, frozenScore - banked);
    return {
      score: currentScore(), banked, trickPoints,
      trickActive: active && comboActive,
      multiplier,
      rotations: (spinDegrees + flipDegrees) / 360,
      airSeconds, grindSeconds, grabSeconds,
      grinding, grabbing, grabHand,
      lastTrickPoints, lastBailed, lastBailReason, resolution,
      boostMeter,
    };
  }

  return {
    start, abandon, finish, bail, ingest, stepOffBoard, applyMultiplier, stepBoost, snapshot,
    get active() { return active; },
    get score() { return currentScore(); },
    get currentMultiplier() { return multiplier; },
    get boostMeter() { return boostMeter; },
    /** A scored run requires charge; outside one, Unity leaves held boost unlimited. */
    get hasBoost() { return !active || boostMeter > 0; },
  };
}

export type RideScorer = ReturnType<typeof createRideScorer>;

/** Unity's `Mathf.RoundToInt`: nearest integer with .5 ties rounded to the even neighbour. */
function unityRound(value: number): number {
  const lower = Math.floor(value), fraction = value - lower;
  if (fraction < 0.5) return lower;
  if (fraction > 0.5) return lower + 1;
  return lower % 2 === 0 ? lower : lower + 1;
}

/** The Unity run HUD exposes the meter as fifteen whole dots, never a partially sliced dot. */
export function boostMeterSegments(value: number): number {
  const meter = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  return Math.min(RIDE_BOOST_METER_SEGMENTS,
    Math.floor(meter * RIDE_BOOST_METER_SEGMENTS + 0.001));
}

/** Build Unity's itemized live trick or its briefly held resolution; the host decides whether that hold is live. */
export function rideTrickDisplay(score: RideScoreSnapshot, showResolved: boolean): RideTrickDisplay | null {
  if (score.grinding) {
    return {
      state: 'live', kind: 'grind', points: score.trickPoints, detail: `grind  ${score.grindSeconds.toFixed(1)}s`,
    };
  }
  if (score.grabbing) {
    return {
      state: 'live', kind: 'grab', points: score.trickPoints,
      detail: `${score.grabHand ?? 'deck'} grab  ${score.grabSeconds.toFixed(1)}s`,
    };
  }
  if (score.trickActive && score.trickPoints > 0) {
    return {
      state: 'live', kind: 'rotation', points: score.trickPoints,
      detail: `${score.rotations.toFixed(2)} × ${RIDE_SCORE_SPIN_PER_360.toFixed(2)} × ${score.multiplier}`
        + ` × ${Math.round(RIDE_SCORE_STYLE_CONSTANT)}`,
    };
  }
  if (showResolved && score.lastTrickPoints > 0) {
    return {
      state: score.lastBailed ? 'bailed' : 'landed', kind: 'result', points: score.lastTrickPoints,
      detail: score.lastBailed
        ? score.lastBailReason === 'out-of-bounds' ? 'out of bounds' : 'sloppy landing'
        : null,
    };
  }
  return null;
}

function grabTierPoints(seconds: number): number {
  if (seconds <= 0) return 0;
  const tier = Math.floor(seconds / RIDE_SCORE_GRAB_TIER_SECONDS);
  return tier >= 5 ? 16000 : tier === 4 ? 12000 : tier === 3 ? 8000 : tier === 2 ? 4000 : 0;
}

function vectorAngleDegrees(a: RideTelemetryVec3, b: RideTelemetryVec3): number {
  const al = Math.hypot(a[0], a[1], a[2]), bl = Math.hypot(b[0], b[1], b[2]);
  if (al <= 1e-9 || bl <= 1e-9) return 0;
  const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (al * bl);
  return Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
}

function landingTiltDegrees(opening: RideTelemetryState, closing: RideTelemetryState): number {
  const deckTilt = vectorAngleDegrees(opening.boardUp, closing.contactNormal);
  const flip = ((opening.flip + 180) % 360 + 360) % 360 - 180;
  return Math.max(deckTilt, Math.abs(flip));
}
