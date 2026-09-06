import * as THREE from 'three';
import {
  COAST_AIR_RESISTANCE, COAST_FRICTION, COAST_GRAVITY, COAST_MAX_TIME, COAST_QUADRATIC_DRAG, COAST_SEAT, COAST_SEPARATION_SPEED, COAST_STICK,
  COAST_STOP_SPEED, D2R, TILT_RATE, WORLD_UP,
} from './physics-tuning';
import { projectOnPlane, rotateTowards } from './physics-math';
import type { WalkGround, WalkGroundQuery } from './xr/walk';

/**
 * The RIDERLESS COAST — what the board does once the rider steps off it (`RideableBoard.CoastUpdate`,
 * Unity docs/vrchat/017).
 *
 * Getting off is not putting the board away. A deck jumped off mid-flight is its own object from that instant:
 * it keeps the velocity it had, falls, lands, slides on down the hill and settles flat wherever friction runs
 * out — while the rider flies on separately. The loose equipment inherits the complete dismount velocity, then
 * its stronger 14 m/s² gravity separates it naturally from the rider.
 * Freezing it in mid-air where the rider let go, which is what a session that simply stops stepping the ride
 * model does, is the one outcome that reads as a bug in both places.
 *
 * This is deliberately NOT the ride model. A ridden board is a hand-integrated deck on a per-surface contact
 * law pinned to retail traces, with steering, a rider driving it and a cruise response; a board nobody is on
 * has none of those. So this is gravity, a fixed stick band, friction and a settle — cheap enough to run
 * beside the walker every frame, and small enough to be worth reading in one sitting.
 *
 * No scene, no DOM, no BVH: a position, a velocity, two axes and one downward ground query, exactly like
 * `xr/walk.ts`. That keeps it headlessly testable (`test/board-coast.test.ts`) and lets the desktop session and
 * the WebXR session drive the same coast from whichever mountain each of them has loaded.
 */

export interface BoardCoastOpts {
  /**
   * Topmost surface under a point. The DESKTOP and WebXR hosts both serve this from the walking cast — terrain
   * plus every solid prop — rather than the board's own contact probe: a deck that slid onto a hut roof should
   * settle on the roof, and a coast has no SurfaceType opinion to make it any more selective than that.
   */
  ground: WalkGroundQuery;
  /** World Y below which the deck has left the mountain; it parks rather than being tracked forever. */
  oobFloorY?: number;
  /**
   * That happened — the deck went over an edge and off the world. The host decides where a board a rider can
   * still reach belongs, exactly as the walker's own `onFell` does; without it a bail over a cliff would leave
   * the only board on the mountain parked half a kilometre under it.
   */
  onLost?: () => void;
}

export function createBoardCoast(o: BoardCoastOpts) {
  /** Where the deck is, and how it is lying: physics point, deck up, deck heading. All live — read, never write. */
  const pos = new THREE.Vector3();
  const vel = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const fwd = new THREE.Vector3(0, 0, 1);
  let grounded = false;
  /** True from the moment a rider steps off until something else claims the deck (a remount, a re-park). */
  let launched = false;
  /** False once the deck has parked; `launched` stays true, because a parked deck is still where it stopped. */
  let active = false;
  let time = 0;
  /** Explicit equipment relocation/ownership epoch for the multiplayer follower. Ordinary coast steps retain it. */
  let epoch = 0;
  /** The prior frame already queried the surface at `pos`; reuse it as this frame's `under` and spend only one
   * new world/BVH query at the destination. It is invalid only on a fresh launch. */
  let groundAtPosition: WalkGround | null = null;
  let groundAtPositionValid = false;
  /**
   * This flight is a THROW, still in the air. A thrown object keeps its whole ballistic arc and tumbles with
   * the spin the hand gave it; only the first touch of ground hands it back to the ordinary coast, which
   * slides and parks. A normal dismount below is gently damped and levels out; a throw retains its complete
   * ballistic speed and tumble.
   */
  let thrown = false;
  /** That tumble: a world axis scaled by degrees per second. */
  const spin = new THREE.Vector3();

  const next = new THREE.Vector3(), gravity = new THREE.Vector3();
  const normal = new THREE.Vector3(), hitNormal = new THREE.Vector3();
  const tumble = new THREE.Quaternion(), tumbleAxis = new THREE.Vector3();

  /** Hand the deck the complete dismount velocity. `boardUp` is the ride model's own, so a board dropped on a
   *  bank starts lying on that bank rather than snapping level. */
  function launch(at: THREE.Vector3, velocity: THREE.Vector3, heading: THREE.Vector3, deckUp: THREE.Vector3) {
    pos.copy(at);
    vel.copy(velocity);
    setAxes(deckUp, heading);
    launched = true;
    active = true;
    grounded = false;
    thrown = false;
    spin.set(0, 0, 0);
    time = COAST_MAX_TIME;
    groundAtPosition = null;
    groundAtPositionValid = false;
  }

  /**
   * Let go of a deck that was in a hand (`board-grab.ts`). Same coast, entered as a THROW: it flies its full
   * arc and tumbles the way it was thrown until it first hits something, and only then starts sliding and
   * settling like any other loose board.
   */
  function throwFrom(at: THREE.Vector3, velocity: THREE.Vector3, heading: THREE.Vector3,
                     deckUp: THREE.Vector3, angular: THREE.Vector3) {
    launch(at, velocity, heading, deckUp);
    thrown = true;
    spin.copy(angular);
  }

  /** Put the deck down at rest, laid flat on whatever is under it — the gate park, and a rider taking it back. */
  function park(at: THREE.Vector3, heading: THREE.Vector3) {
    epoch++;
    pos.copy(at);
    vel.set(0, 0, 0);
    const surface = o.ground(pos.x, pos.z, pos.y);
    if (surface) pos.y = surface.y + COAST_SEAT;
    setAxes(surface ? surface.normal : WORLD_UP, heading);
    launched = true;
    active = false;
    thrown = false;
    spin.set(0, 0, 0);
    grounded = !!surface;
    groundAtPosition = surface;
    groundAtPositionValid = true;
    time = 0;
  }

  /** The deck belongs to someone again — a mount, or a hand — so the coast has nothing left to say about it. */
  function stop() {
    epoch++;
    launched = false;
    active = false;
    thrown = false;
    vel.set(0, 0, 0);
    spin.set(0, 0, 0);
    groundAtPosition = null;
    groundAtPositionValid = false;
  }

  /**
   * One frame. Ground contact here is a snap-seat and a stick band, not the ride's contact spring: a deck
   * sliding to rest has no rider to hold it down, so the pull it integrates is the DOWNHILL part of gravity
   * only — the into-surface part is clamped off, or a board dropped on a slope would drive itself into the
   * snow rather than slide off down it. That clamp is safe only because this path is seated; the ridden model
   * must never do it.
   */
  function step(dt: number) {
    if (!active || dt <= 0) return;
    if (dt > 0.05) dt = 0.05; // one hitch must not teleport a loose deck through the mountain
    time -= dt;

    const under = groundAtPositionValid ? groundAtPosition : o.ground(pos.x, pos.z, pos.y);
    const onGround = !!under && pos.y <= under.y + COAST_STICK;
    if (onGround) {
      surfaceNormal(under!.normal);
      if (thrown) endThrow(normal); // the first touch of ground: from here it is an ordinary sliding board
      gravity.set(0, -COAST_GRAVITY, 0);
      const into = gravity.dot(normal);
      if (into < 0) gravity.addScaledVector(normal, -into);
      vel.addScaledVector(gravity, dt);
      // Riderless friction: with nobody driving the surface cruise, a linear decel plus the board's quadratic
      // drag is the whole of what scrubs the deck to a stop.
      const speed = vel.length();
      if (speed > 1e-4) {
        const scrubbed = Math.max(0, speed - (COAST_FRICTION + COAST_QUADRATIC_DRAG * speed * speed) * dt);
        vel.multiplyScalar(scrubbed / speed);
      }
      up.copy(rotateTowards(up, normal, TILT_RATE * D2R * dt));
    } else if (thrown) {
      // A thrown deck is a thrown object: the full ballistic arc, no scrub, turning over the way it was let go
      // of. Both axes take the same rotation, so the deck stays a deck however many times it goes round.
      vel.y -= COAST_GRAVITY * dt;
      const rate = spin.length();
      if (rate > 1) {
        tumble.setFromAxisAngle(tumbleAxis.copy(spin).divideScalar(rate), rate * D2R * dt);
        up.applyQuaternion(tumble);
        fwd.applyQuaternion(tumble);
      }
    } else {
      vel.y -= COAST_GRAVITY * dt;
      // A riderless deck has less horizontal air resistance than its former rider (0.1/s vs 0.3/s),
      // so they leave with the same velocity and the board gradually pulls ahead. Vertical is gravity's alone.
      const retained = Math.max(0, 1 - COAST_AIR_RESISTANCE * dt);
      vel.x *= retained;
      vel.z *= retained;
      up.copy(rotateTowards(up, WORLD_UP, TILT_RATE * D2R * dt)); // level in the air
    }

    // Move, then stick. There is no collide-and-slide here, unlike the ridden path: on the first coast frame
    // the rider who just stepped off is standing exactly where the deck is, and a loose board sliding to a halt
    // does not need to bounce off props to end up somewhere believable.
    next.copy(pos).addScaledVector(vel, dt);
    const at = o.ground(next.x, next.z, next.y);
    let land = false;
    if (at) {
      hitNormal.copy(surfaceNormal(at.normal));
      // Outward along the face is a deck LEAVING it — a lip, or the rise of a bounce — not one arriving on it.
      land = next.y <= at.y + COAST_STICK && vel.dot(hitNormal) <= COAST_SEPARATION_SPEED;
      if (land) {
        next.y = at.y + COAST_SEAT;
        const into = vel.dot(hitNormal);
        if (into < 0) vel.addScaledVector(hitNormal, -into); // absorb the into-surface part on contact
        if (thrown) endThrow(hitNormal);
      }
    }
    pos.copy(next);
    grounded = land;
    groundAtPosition = at;
    groundAtPositionValid = true;

    // Off the mountain entirely. Park it, then hand the host the chance to put it somewhere a rider can walk to.
    if (o.oobFloorY !== undefined && pos.y < o.oobFloorY) { parkHere(null); o.onLost?.(); return; }

    // Settle. A deck resting slow on the ground has arrived. The safety timer must never freeze one in MID-AIR
    // — it would hang there on nothing — so an expiry that catches it airborne drops the horizontal carry and
    // lets gravity finish the job; a hard backstop two seconds later parks and reports a board that never found
    // ground. Reporting at that backstop matters with real gravity, which may not cross a very deep OOB floor
    // before the safety window ends.
    if (land && vel.length() < COAST_STOP_SPEED) parkHere(hitNormal);
    else if (time <= 0) {
      if (land) parkHere(hitNormal);
      else if (time <= -2) { parkHere(null); o.onLost?.(); return; }
      else { vel.x = 0; vel.z = 0; }
    }
  }

  /**
   * Touchdown of a thrown deck: the tumbling flight is over and what is left is an ordinary board that slides
   * and settles. If the tumble arrived TOPSHEET-DOWN, mirror the deck's up through itself so the grounded
   * settle rolls it the short way onto its base — a thrown board lands up.
   */
  function endThrow(restNormal: THREE.Vector3) {
    thrown = false;
    spin.set(0, 0, 0);
    if (up.dot(restNormal) < 0) up.negate();
  }

  /**
   * Stop here and lie flat, keeping the heading. Unlike the Unity board this needs no second cast to lift the
   * deck onto the visible surface: the query above already IS the drawn mesh, so a board parked in a powder
   * bowl is resting on the snow the rider can see rather than under an analytic patch that dips below it.
   */
  function parkHere(restNormal: THREE.Vector3 | null) {
    vel.set(0, 0, 0);
    active = false;
    thrown = false;
    spin.set(0, 0, 0);
    setAxes(restNormal ?? WORLD_UP, fwd);
  }

  /**
   * Seat the two deck axes: `deckUp` normalized, with the heading squared onto it. Deliberately NOT turned
   * upward the way a surface normal is — a deck let go of upside down is upside down, and the tumble is the
   * whole point of a throw.
   */
  function setAxes(deckUp: THREE.Vector3, heading: THREE.Vector3) {
    up.copy(deckUp);
    if (up.lengthSq() < 1e-6) up.copy(WORLD_UP); else up.normalize();
    projectOnPlane(heading, up, fwd);
    if (fwd.lengthSq() > 1e-6) { fwd.normalize(); return; }
    // A heading square to the deck's own up carries no facing at all; take any axis that does.
    projectOnPlane(FORWARD, up, fwd);
    if (fwd.lengthSq() < 1e-6) projectOnPlane(RIGHT, up, fwd);
    fwd.normalize();
  }

  /** `normal`, as a unit up-facing axis. A mirrored terrain facet can report its normal into the mountain. */
  function surfaceNormal(source: THREE.Vector3): THREE.Vector3 {
    normal.copy(source);
    if (normal.lengthSq() < 1e-6) normal.copy(WORLD_UP); else normal.normalize();
    if (normal.y < 0) normal.negate();
    return normal;
  }

  return {
    launch, throwFrom, park, step, stop, pos, vel, up, fwd,
    /** A throw still in flight: ballistic and tumbling, until the first thing it hits. */
    get thrown() { return thrown; },
    /** Still moving: the host keeps drawing the deck from this until it goes false. */
    get active() { return active; },
    /** The coast owns where the deck is — moving or parked. False only before a dismount and after a mount. */
    get launched() { return launched; },
    get grounded() { return grounded; },
    get epoch() { return epoch; },
  };
}

export type BoardCoast = ReturnType<typeof createBoardCoast>;

const FORWARD = new THREE.Vector3(0, 0, 1);
const RIGHT = new THREE.Vector3(1, 0, 0);
