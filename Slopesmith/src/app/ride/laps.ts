import * as THREE from 'three';

/**
 * The test ride's LAP COUNTDOWN — the rider-side half of a course's lap count (core/doc/race).
 *
 * The engine keeps one number per rider: how many passes are still to run, COUNTING the one under way. It is
 * seeded to the course's pass count when the run starts, decremented once per crossing, and read in
 * exactly two places — the finish, which only ends the race once the number has reached zero, and the
 * LAP-GATED boost volume, which is skipped outright once it reads zero
 * ([Trailmap: 390-lap-counter, 390-lap-rate, 360-lapboost-gate]). This mirrors that:
 * {@link LapCounter.remaining} is the same number under the same rules — MEGAPLEX seeds 4, the first crossing
 * announces "3 laps to go", and the fourth crossing lands zero. It is also the number a race announces, so
 * the HUD can show it directly.
 *
 * A crossing is counted at whichever STATION the pass actually ends at, and there are two. The finish plane —
 * the level's own anchor wherever it has one ({@link FinishLine}), nowhere near either end of the course line
 * on a lap course — and the LAP-GATED volume's own mouth ({@link LapCounter.enterLapVolume}). The second is
 * MEGAPLEX's load-bearing one: its finish plane sits ~25 m DOWN-course of the tube, so a mid-race rider is
 * lifted before ever reaching it — the engine's own captures read seed-minus-one for riders inside the shaft
 * ([Trailmap: 390-lap-field]) — and only the pass the tube declines to lift rides through to the plane, which
 * is where the run ends. The stations debounce against each other, so a course carrying both in sequence
 * counts one crossing once.
 *
 * Crossing is all the counter does — it does not put the rider back at the top. Neither does the
 * engine: MEGAPLEX sends a rider round again through its finish TUBE, a lap-gated boost volume that lifts them
 * at every crossing but the last, and a course carrying no such volume simply has nothing to
 * send them round with. So a multi-lap mountain authored without one counts its laps honestly and leaves the
 * rider at the bottom, which is what the same course would do on the disc.
 */

/** How far off the finish line a crossing still counts, metres either side of the course line. Generous,
 *  because the finish is a line across a run rather than a gate you must thread — but bounded, so a rider
 *  wandering the mountain well wide of the course cannot trip it. */
const FINISH_HALF_WIDTH = 60;
/** ...and metres above or below it. The plane is a gate at the mountain's surface, not an infinite wall:
 *  MEGAPLEX's tube-end launch carries a rider across the plane's plan position ~500 m overhead on the trip
 *  back up the mountain, and a crossing counted up there is a phantom lap. Generous enough to clear any jump
 *  a finish line could plausibly sit under. */
const FINISH_HALF_HEIGHT = 100;
/** How far past the line the rider must get for the crossing to count, metres. One tick at ride speeds is a
 *  couple of metres, so this only rejects a rider hovering exactly on the plane. */
const FINISH_DEPTH = 0.5;
/** Ticks (60 Hz) after a counted crossing before the OTHER station can count one — two stations a few seconds
 *  apart on the same run of snow are one crossing, not two. Each station re-arms itself positionally on its own
 *  (the plane's side test, the volume's entry latch); this only spans the gap between them. */
const CROSS_DEBOUNCE_TICKS = 180;

export interface LapCounter {
  /** Passes still to run, counting the one under way — retail's own counter, zero only once the run is over.
   *  What the lap-gated volume reads, and the number a crossing announces ("3 laps to go" = 3). */
  readonly remaining: number;
  /** Which pass the rider is on, 1-based, so it reads as "lap 2 of 4" without arithmetic at the call site. */
  readonly lap: number;
  /** Total passes this course is raced over. */
  readonly laps: number;
  /** Whether the finish has been crossed with no laps left — the run is over. */
  readonly finished: boolean;
  /** Feed the rider's world position every tick. True on the tick a finish crossing was counted as a lap. */
  step(pos: THREE.Vector3): boolean;
  /**
   * The rider has entered a LAP-GATED volume: count the crossing at its mouth — the engine's station on
   * MEGAPLEX, whose finish plane is only ever reached by the pass the tube declines to lift
   * ([Trailmap: 390-lap-field, 360-lapboost-gate]). Debounced against the plane, and never the run's end:
   * the crossing that lands zero here leaves `finished` unset for the plane below to take. True when a lap
   * was counted with passes still to announce — the mirror of {@link step}'s contract.
   */
  enterLapVolume(): boolean;
  reset(): void;
}

/**
 * Where the run is decided. Both mountains own an explicit crossing — the authored course's finish anchor
 * (`core/doc/course.finishFrame`) and an extracted level's DTF-zero point (`core/reference/terrain.dtfZeroFrame`)
 * — and on a LAP course neither end of the course line is it: Tokyo Megaplex's recovered line stops 320 m above
 * its own finish, so counting laps off the line's tail counts them at a plane the rider stops crossing once the
 * tube has thrown them past it. The anchor is what the level says; the tail is only the fallback for a line that
 * carries no anchor at all.
 */
export interface FinishLine {
  pos: THREE.Vector3;
  /** The racing direction through the crossing; flattened here, so only its heading matters. */
  fwd: THREE.Vector3;
}

export interface FinishCrossing {
  /** True only on the tick a rider moves forward through the finish plane. */
  step(pos: THREE.Vector3): boolean;
  /** Forget the previous side when a fresh run begins. */
  reset(): void;
}

/**
 * The finish plane without any lap arithmetic. A timed run needs this even on the ordinary one-pass courses
 * whose lap counter is deliberately absent: the first forward crossing is their finish. It re-arms after the
 * rider gets properly behind the line again so a multi-lap session can observe every pass while its separate
 * {@link LapCounter} decides which one is the last.
 */
export function createFinishCrossing(course: readonly THREE.Vector3[] | undefined,
  line?: FinishLine | null): FinishCrossing | null {
  const chosen = chooseFinish(course, line);
  if (!chosen) return null;
  const finish = chosen.pos.clone();
  const forward = chosen.fwd.clone().setY(0);
  if (forward.lengthSq() < 1e-8) return null;
  forward.normalize();
  const side = new THREE.Vector3(-forward.z, 0, forward.x);
  const offset = new THREE.Vector3();
  let before: boolean | null = null;
  return {
    reset() { before = null; },
    step(pos) {
      offset.subVectors(pos, finish);
      const ahead = offset.dot(forward);
      const wasBefore = before;
      if (ahead < -FINISH_DEPTH) before = true;
      else if (ahead > FINISH_DEPTH) before = false;
      return wasBefore === true && ahead > FINISH_DEPTH
        && Math.abs(offset.dot(side)) <= FINISH_HALF_WIDTH
        && Math.abs(offset.y) <= FINISH_HALF_HEIGHT;
    },
  };
}

function chooseFinish(course: readonly THREE.Vector3[] | undefined,
  line?: FinishLine | null): FinishLine | null {
  const tail = course && course.length >= 2
    ? { pos: course[course.length - 1], fwd: course[course.length - 1].clone().sub(course[course.length - 2]) }
    : null;
  return line ?? tail;
}

/**
 * A counter over a course, or null when the ridden world has no usable finish — a mountain with neither an
 * anchor nor a course line cannot say where its finish is, and a single-pass course has no lap to count.
 */
export function createLapCounter(course: readonly THREE.Vector3[] | undefined, laps: number,
  line?: FinishLine | null): LapCounter | null {
  if (laps <= 1) return null;
  const chosen = chooseFinish(course, line);
  if (!chosen) return null;

  // The finish plane: the crossing point, faced by the direction the run arrives from. Taken flat, because a
  // rider crosses a finish line in plan view — a steep final pitch must not tilt the plane under them.
  const finish = chosen.pos.clone();
  const forward = chosen.fwd.clone().setY(0);
  if (forward.lengthSq() < 1e-8) return null;
  forward.normalize();
  const side = new THREE.Vector3(-forward.z, 0, forward.x);
  const offset = new THREE.Vector3();

  let remaining = laps;
  let finished = false;
  /** Ticks since the last counted crossing, wherever it counted — gates the volume station. */
  let sinceAny = CROSS_DEBOUNCE_TICKS;
  /** Ticks since a crossing counted at a VOLUME — gates the plane, whose own re-crossings the side test
   *  already re-arms positionally. */
  let sinceVolume = CROSS_DEBOUNCE_TICKS;
  /** Which side of the plane the rider was on last tick; null until the first sample seats it, so starting past
   *  the line (a mountain whose spawn is below its own finish) cannot read as an immediate crossing. */
  let before: boolean | null = null;

  const counter: LapCounter = {
    get remaining() { return remaining; },
    get lap() { return finished || remaining < 1 ? laps : laps - remaining + 1; },
    get laps() { return laps; },
    get finished() { return finished; },
    reset() {
      remaining = laps; finished = false; before = null;
      sinceAny = CROSS_DEBOUNCE_TICKS; sinceVolume = CROSS_DEBOUNCE_TICKS;
    },
    step(pos) {
      if (sinceAny < CROSS_DEBOUNCE_TICKS) sinceAny++;
      if (sinceVolume < CROSS_DEBOUNCE_TICKS) sinceVolume++;
      offset.subVectors(pos, finish);
      const ahead = offset.dot(forward);
      const wasBefore = before;
      // Re-arm as soon as the rider is properly back behind the line, so one crossing counts once however
      // long they linger past it.
      if (ahead < -FINISH_DEPTH) before = true;
      else if (ahead > FINISH_DEPTH) before = false;
      if (wasBefore !== true || ahead <= FINISH_DEPTH) return false;
      if (Math.abs(offset.dot(side)) > FINISH_HALF_WIDTH) return false;
      if (Math.abs(offset.y) > FINISH_HALF_HEIGHT) return false;
      if (finished) return false;
      // A pass with nothing left to count ENDS here — the tube's mouth landed the counter on zero and declined
      // the lift, and the plane below is where that ride-through finishes ([Trailmap: 390-lap-events]).
      if (remaining === 0) { finished = true; return false; }
      // The tube's mouth counted this same crossing moments ago; the plane is not a second one.
      if (sinceVolume < CROSS_DEBOUNCE_TICKS) return false;
      // Retail's own arithmetic: one decrement per crossing, and the crossing that lands the counter on zero
      // is the finish, not a lap — what it announces is `remaining`, which is why the seed is the pass count.
      remaining--;
      sinceAny = 0;
      if (remaining > 0) return true;
      finished = true;
      return false;
    },
    enterLapVolume() {
      if (finished || remaining <= 0 || sinceAny < CROSS_DEBOUNCE_TICKS) return false;
      remaining--;
      sinceAny = 0;
      sinceVolume = 0;
      return remaining > 0;
    },
  };
  return counter;
}
