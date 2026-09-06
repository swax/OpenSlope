import * as THREE from 'three';

/**
 * On-foot locomotion for VR play (docs/048): the rider walking the mountain between rides.
 *
 * This is deliberately NOT the ride model. A boarder is a hand-integrated deck riding a per-surface contact law
 * pinned to retail traces; a walker is a character controller, and in VRChat it is the platform's own — the
 * engine-controlled capsule that [Unity docs/vrchat/017] opens by pointing out ignores friction entirely, which is the
 * whole reason the board exists as a vehicle. So the mountain's surface table has no say here: snow, ice and
 * rock all walk the same, exactly as they do in-world, and everything interesting about a surface is something
 * you only feel once you are on the deck.
 *
 * No DOM, no scene, no WebXR: a position, a velocity and one downward ground query. That keeps it testable
 * headlessly (`test/xr-play.test.ts`) and keeps the session host free to serve the query from whichever
 * mountain is loaded.
 */

/** OpenSlope Unity's authored VRCWorldSettings values (`Map.ApplyPlayerLocomotion`). */
export const PLAYER_RUN_SPEED = 8.13;
export const PLAYER_WALK_SPEED = PLAYER_RUN_SPEED / 2;
export const PLAYER_STRAFE_SPEED = PLAYER_WALK_SPEED;
export const PLAYER_JUMP_IMPULSE = 4.77;
const CROUCH_SPEED_SCALE = 0.55;
export const PLAYER_GRAVITY = 9.81; // m/s²
/** Gentle horizontal air resistance/control response, shared by ordinary airborne motion (including a
 *  board-speed dismount) and directional Superman flight. At zero input it retains `1 - value * dt` each frame. */
export const PLAYER_AIR_RESISTANCE = 0.3;
/** OpenSlope Unity's `PlayerFlight` / `BasisPlayerFlight` Superman tuning. */
export const SUPERMAN_ACCEL = 30;
export const SUPERMAN_MAX_HORIZONTAL_SPEED = 300;
export const SUPERMAN_MAX_VERTICAL_SPEED = 300;
export const SUPERMAN_BACK_THRUST = 0.45;
export const SUPERMAN_MAX_BACK_THRUST_SCALE = 8;
export const SUPERMAN_THROTTLE_RAMP = 4;
/** Directional flight cruises at half thrust/cap; Boost restores the authored full-speed values above. */
export const SUPERMAN_CRUISE_SPEED_SCALE = 0.5;
/** Steeper than this is not floor: you slide off it rather than stroll up it (≈66°). */
const MIN_GROUND_NY = 0.4;
/** How far a step may rise in one move, and how far the walker stays stuck to a surface falling away below. */
const STEP_UP = 0.55, SNAP_DOWN = 0.5;
/** How far short of a struck terrain face the airborne sweep stops, so next frame's chord starts outside it. */
const BARRIER_SKIN = 0.05;
/** Ground probes start this far above the query height so a walker already sunk a little still finds its floor. */
const PROBE_ABOVE = 2, PROBE_BELOW = 200;
/** Horizontal move is resolved in bites no longer than this, so a fast walker cannot step over a thin ridge. */
const MAX_SUBSTEP = 0.25;

export interface WalkGround {
  /** World height of the surface under the query. */
  y: number;
  /** Its outward normal, world space. */
  normal: THREE.Vector3;
  /** The cast's world hit point, where the caster reports one. The airborne chord sweep needs it to place a
   *  hit on a rising or level trajectory, where a height alone cannot recover the crossing. */
  point?: THREE.Vector3;
}

/**
 * The mountain, as a walker needs it: the topmost surface on the vertical line through (x, z), searched from
 * `PROBE_ABOVE` above `fromY` down. Null where the mountain has no surface there at all.
 */
export interface WalkGroundQuery {
  (x: number, z: number, fromY: number): WalkGround | null;
  /** The segment cast behind this height query, when one exists. High-speed airborne landings use it to sweep
   * the actual diagonal frame trajectory instead of relying on a destination-only vertical probe. */
  castSegment?: (from: THREE.Vector3, to: THREE.Vector3) => WalkGround | null;
}

export interface WalkerOpts {
  ground: WalkGroundQuery;
  /**
   * Optional world-prop character collision. The resolver receives a feet-root move and may shorten/slide `to`
   * and remove blocked velocity in place. Terrain remains the height query above; this is the body volume that
   * keeps a walker out of prop walls and ceilings and reports Roller/trigger contacts.
   */
  resolveMove?: (from: THREE.Vector3, to: THREE.Vector3, velocity: THREE.Vector3) => void;
  /** World Y below which the walker has fallen off the mountain and is put back. */
  oobFloorY: number;
  /** Called when that happens; the host decides where "back" is. */
  onFell?: () => void;
}

export interface WalkIntent {
  /** Stick intent in head-relative axes, −1..1 each: `x` to the right, `y` forward. */
  moveX: number;
  moveY: number;
  /** The head's flattened forward, world space. Walk direction is head-relative, as it is in VRChat. */
  forward: THREE.Vector3;
  /** Edge-triggered by the caller: one press, one jump. */
  jump: boolean;
  /** The same jump control's held state. After a second airborne press or Jump + Boost engages Superman flight,
   *  this is upward thrust; `crouch` is downward thrust and the movement axes thrust in their head-relative directions. */
  jumpHeld?: boolean;
  /** Desktop Ctrl crouch. Optional because room-scale WebXR supplies its own physical head height. */
  crouch?: boolean;
  /** Held Boost turns a grounded jump into flight and restores Superman's full acceleration/cap. */
  boost?: boolean;
  /** Optional aimed Boost direction. WebXR supplies the right-controller ray; `null` explicitly means tracking
   *  is unavailable, while omission keeps keyboard/pad flight on the directional controls above. */
  boostDirection?: THREE.Vector3 | null;
  /** A held board supplies the aimed direction as a physical jetpack and may push off directly from the floor. */
  boardJetpack?: boolean;
}

export function createWalker(o: WalkerOpts) {
  /** The walker's world-space FEET. The host offsets the XR rig so the tracked head lands above this point. */
  const pos = new THREE.Vector3();
  const vel = new THREE.Vector3();
  let grounded = false;
  let flightActive = false, flightThrottle = 0, flightBoostApplied = false;
  /** A grounded jump arms exactly one airborne second press. Walking off a ledge is not a first jump. */
  let directionalFlightArmed = false;
  const right = new THREE.Vector3(), wish = new THREE.Vector3(), flat = new THREE.Vector3();
  const move = new THREE.Vector3(), probe = new THREE.Vector3(), flightDirection = new THREE.Vector3();
  const airStart = new THREE.Vector3(), airEnd = new THREE.Vector3();
  const chord = new THREE.Vector3(), face = new THREE.Vector3();
  const resolvedFrom = new THREE.Vector3(), resolvedTo = new THREE.Vector3();

  /**
   * Put the walker down at a world point. Without a carry that is a placement: dropped onto whatever surface is
   * under it, at rest, which is what a gate spawn and a fall recovery both want.
   *
   * WITH a carry it is a rider leaving a board in mid-flight, and then BOTH halves of where they are matter —
   * they keep the board's arc AND the point they left it from, so they fly on out of the jump instead of being
   * set down on the snow beneath it with all that speed still on them. That is the board's own
   * `CarryTrajectoryOnExit` (Unity docs/vrchat/017), which exists because a station passenger has no velocity of
   * their own. The height is only ever raised, never dropped: a dismount point already under the surface is
   * seated on it rather than left buried.
   */
  function placeAt(at: THREE.Vector3, carry?: THREE.Vector3) {
    pos.copy(at);
    const g = o.ground(pos.x, pos.z, pos.y);
    if (g && (!carry || pos.y < g.y)) pos.y = g.y;
    vel.set(0, 0, 0);
    if (carry) vel.copy(carry);
    grounded = !!g && !carry;
    flightActive = false;
    flightThrottle = 0;
    directionalFlightArmed = false;
  }

  /** Where the walker's feet are. Live — the host reads it every frame to seat the rig; treat it as read-only. */
  function position() { return pos; }
  function velocity() { return vel; }
  function isGrounded() { return grounded; }
  function isFlying() { return flightActive; }
  /** True only for a frame where Boost actually multiplied non-zero directional flight thrust. */
  function isFlightBoosting() { return flightBoostApplied; }

  /**
   * Apply real tracked-room displacement without turning it into stick velocity. The same bite/step/slope law
   * as ordinary locomotion keeps a physical step from walking the camera through a virtual wall or off the
   * mountain, while the caller filters tracking-origin discontinuities before they reach here.
   */
  function moveTracked(delta: THREE.Vector3) {
    move.set(delta.x, 0, delta.z);
    const distance = move.length();
    if (distance <= 1e-6) return;
    const bites = Math.max(1, Math.ceil(distance / MAX_SUBSTEP));
    move.divideScalar(bites);
    for (let i = 0; i < bites; i++) if (!tryMove(move)) break;
  }

  /**
   * One frame. Horizontal first, in bites, each bite accepted only if it lands on floor the walker could stand
   * on; then the vertical, which is a ground snap while walking and plain ballistics once airborne.
   */
  function step(dt: number, intent: WalkIntent) {
    flightBoostApplied = false;
    if (dt <= 0) return;
    // A hitch must not teleport a walker through the mountain. The ride integrator clamps its catch-up the same
    // way; here one long frame simply covers less ground than it "should", which is the harmless failure.
    if (dt > 0.1) dt = 0.1;
    // Unity's flight controller uses the tighter bound because one thrust hitch is much more energetic.
    if (flightActive && dt > 0.05) dt = 0.05;

    // ---- what the stick is asking for, in world axes ----
    flat.set(intent.forward.x, 0, intent.forward.z);
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1);
    flat.normalize();
    right.crossVectors(flat, UP).normalize();
    // Unity authors forward run separately from the gentler walk/strafe pace. A full forward stick is the 8.13
    // m/s run used to cross an OpenSlope mountain; sideways/backward retain the precise 4.065 m/s setting. Clamp the
    // resulting ellipse at run speed so a diagonal never outruns straight-ahead travel.
    const forwardSpeed = intent.moveY >= 0 ? PLAYER_RUN_SPEED : PLAYER_WALK_SPEED;
    wish.copy(right).multiplyScalar(intent.moveX * PLAYER_STRAFE_SPEED)
      .addScaledVector(flat, intent.moveY * forwardSpeed);
    if (wish.length() > PLAYER_RUN_SPEED) wish.setLength(PLAYER_RUN_SPEED);
    if (intent.crouch) wish.multiplyScalar(CROUCH_SPEED_SCALE);

    const launched = grounded && intent.jump;
    if (launched) {
      vel.y = PLAYER_JUMP_IMPULSE;
      grounded = false;
      directionalFlightArmed = true;
    }
    // A second Jump edge retains the original double-jump entry. Boost during the armed jump is the alternate
    // chord entry, whether B / Shift was already held at takeoff or was pressed once the jump was airborne.
    // Board-speed dismounts are not armed, so Boost can still add aimed thrust to those without changing modes.
    const directionalFlightStarted = !grounded && directionalFlightArmed
      && ((!launched && intent.jump) || !!intent.boost);
    if (!flightActive && directionalFlightStarted) {
      flightActive = true;
      directionalFlightArmed = false;
    }
    // A board in the hand is the thruster itself. Unlike empty-handed Superman controls it needs no jump chord:
    // pointing the deck up and pressing Boost must be able to lift the player from a standstill.
    const boardJetpackLaunched = grounded && intent.boardJetpack && intent.boost && intent.boostDirection
      && intent.boostDirection.lengthSq() > 1e-6;
    if (boardJetpackLaunched) {
      grounded = false;
      directionalFlightArmed = false;
      // A throttle ramp that begins at zero cannot beat gravity on its first tick, so the ground resolver would
      // weld even an upward-pointed deck straight back to the floor. B is already fully held at this boundary:
      // start the board thruster at full output and let later release/re-presses use the ordinary easing.
      flightThrottle = 1;
    }

    // Grounded, the stick IS the velocity — a walker has no momentum worth modelling, which is exactly the
    // frictionless capsule the board was invented to escape. Airborne, it eases so a jump keeps its arc.
    if (grounded || launched) { vel.x = wish.x; vel.z = wish.z; }
    else if (!flightActive) {
      // A board-speed carry is subject to the same gentle air response as an ordinary jump. Stick input steers
      // toward walking speed instead of replacing the inherited trajectory in one frame; centred input is the
      // requested 0.3/s horizontal resistance.
      const k = Math.min(1, PLAYER_AIR_RESISTANCE * dt);
      vel.x += (wish.x - vel.x) * k;
      vel.z += (wish.z - vel.z) * k;
    }

    // Once double-jump or Jump + Boost enters flight, this owns airborne velocity until touchdown. Boost may
    // also borrow the same full-strength directional thrust during a board dismount without changing modes.
    if (grounded) flightThrottle = 0;

    // Gravity stays on in Superman mode. Apply it before thrust, matching the Unity mode's integration order.
    if (!grounded) vel.y -= PLAYER_GRAVITY * dt;
    const ordinaryAirBoost = !grounded && !flightActive && !!intent.boost;
    const directionalThrustActive = flightActive || ordinaryAirBoost;
    if (!directionalThrustActive) flightThrottle = 0;
    if (directionalThrustActive) {
      // WebXR B follows the right controller ray even with every directional control centred. Other flight uses
      // view-relative controls: forward/back, strafe, jump rises and crouch dives. Normalize either source.
      if (intent.boost && intent.boostDirection !== undefined) {
        if (intent.boostDirection) flightDirection.copy(intent.boostDirection);
        else flightDirection.set(0, 0, 0); // controller tracking was explicitly unavailable
      } else {
        flightDirection.copy(right).multiplyScalar(intent.moveX)
          .addScaledVector(flat, intent.moveY)
          .addScaledVector(UP, Number(!!intent.jumpHeld) - Number(!!intent.crouch));
      }
      const directionalFlightHeld = flightDirection.lengthSq() > 1e-6;
      if (directionalFlightHeld) flightDirection.normalize();
      const thrustHeld = directionalFlightHeld;
      const throttleTarget = thrustHeld ? 1 : 0;
      const throttleStep = SUPERMAN_THROTTLE_RAMP * dt;
      flightThrottle += Math.max(-throttleStep, Math.min(throttleStep, throttleTarget - flightThrottle));
      if (thrustHeld && flightDirection.lengthSq() > 1e-6) {
        flightDirection.normalize();
        const speedScale = intent.boost ? 1 : SUPERMAN_CRUISE_SPEED_SCALE;
        const opposing = -vel.dot(flightDirection);
        const thrustScale = SUPERMAN_BACK_THRUST > 0 && opposing > 0
          ? THREE.MathUtils.clamp(opposing * SUPERMAN_BACK_THRUST, 1, SUPERMAN_MAX_BACK_THRUST_SCALE)
          : 1;
        vel.addScaledVector(flightDirection, SUPERMAN_ACCEL * speedScale * flightThrottle * thrustScale * dt);
        flightBoostApplied = !!intent.boost;
      }
      // Flight applies its gentle resistance here after thrust. An ordinary jump already passed through the
      // same damping coefficient in the non-flight branch above, so do not apply it twice when B borrows thrust.
      if (flightActive) {
        const retained = Math.max(0, 1 - PLAYER_AIR_RESISTANCE * dt);
        vel.x *= retained;
        vel.z *= retained;
      }
      const speedScale = intent.boost ? 1 : SUPERMAN_CRUISE_SPEED_SCALE;
      const horizontalSpeed = Math.hypot(vel.x, vel.z);
      const horizontalCap = SUPERMAN_MAX_HORIZONTAL_SPEED * speedScale;
      if (horizontalSpeed > horizontalCap) {
        const scale = horizontalCap / horizontalSpeed;
        vel.x *= scale; vel.z *= scale;
      }
      const verticalCap = SUPERMAN_MAX_VERTICAL_SPEED * speedScale;
      vel.y = THREE.MathUtils.clamp(vel.y, -verticalCap, verticalCap);
    }

    // ---- horizontal, in bites ----
    // Remember the frame's real airborne origin. Horizontal and vertical resolution remain separate for the
    // ordinary step/slope controller, but a fast landing is swept along this origin -> final-destination chord
    // below so the two phases cannot form an L-shaped tunnel through rising terrain.
    if (!grounded) airStart.copy(pos);
    move.set(vel.x, 0, vel.z).multiplyScalar(dt);
    const distance = move.length();
    if (distance > 1e-6) {
      const bites = Math.min(16, Math.max(1, Math.ceil(distance / MAX_SUBSTEP)));
      move.divideScalar(bites);
      for (let i = 0; i < bites; i++) if (!tryMove(move)) break;
    }

    // ---- vertical ----
    let under = o.ground(pos.x, pos.z, pos.y);
    if (!grounded) {
      resolvedFrom.copy(pos);
      resolvedTo.copy(pos).addScaledVector(UP, vel.y * dt);
      o.resolveMove?.(resolvedFrom, resolvedTo, vel);
      airEnd.copy(resolvedTo);
      let sweptGround: WalkGround | null = null;
      let sweptT = -1;
      let barrier: WalkGround | null = null;
      let barrierT = -1;
      // `downwardGroundQuery` retains its real segment caster, and the sweep runs on EVERY airborne chord —
      // horizontal bites included. One cast covers even a 300 m/s diagonal Superman pass without dozens of tiny
      // BVH probes. A descending hit on standable floor is a landing; any other crossed face — a cliff met at
      // an upward angle, a wall met level at speed, a tunnel roof — is a barrier the flyer stops against.
      // Without the ascending half of this cast, terrain was only ever a floor, and a fast climb passed
      // straight through a cliff face.
      chord.copy(airEnd).sub(airStart);
      const chordLength = chord.length();
      const descending = airEnd.y < airStart.y - 1e-6;
      if (chordLength > 1e-6 && o.ground.castSegment) {
        const swept = o.ground.castSegment(airStart, airEnd);
        // The exact chord parameter comes from the 3D hit point where the caster reports one; a height-only
        // caster retains the descending-chord Y interpolation and cannot name a barrier. A t≈0 hit is the
        // surface just left and must not glue an edge fall.
        const t = !swept ? -1
          : swept.point ? chord.dot(probe.copy(swept.point).sub(airStart)) / (chordLength * chordLength)
            : descending ? (swept.y - airStart.y) / (airEnd.y - airStart.y) : -1;
        if (swept && t > 1e-5 && t <= 1) {
          if (descending && swept.normal.y >= MIN_GROUND_NY) { sweptGround = swept; sweptT = t; }
          else if (swept.point) { barrier = swept; barrierT = t; }
        }
      }
      if (sweptGround) {
        pos.lerpVectors(airStart, airEnd, sweptT);
        pos.y = sweptGround.y;
      } else if (barrier) {
        // Stop a skin short of the face so next frame's chord starts outside it, then slide: the face keeps
        // what runs along it and eats what runs into it. Flight stays active — Superman scrapes the cliff.
        pos.lerpVectors(airStart, airEnd, Math.max(0, barrierT - BARRIER_SKIN / chordLength));
        face.copy(barrier.normal);
        if (face.dot(chord) > 0) face.negate(); // the cast may report either side of a two-sided face
        const into = vel.dot(face);
        if (into < 0) vel.addScaledVector(face, -into);
        // The stop moved the feet off the swept destination; the landing fallback must read its own column.
        under = o.ground(pos.x, pos.z, pos.y);
      } else pos.copy(airEnd);
      // Landing: the first frame the feet reach or pass the floor. Rising through a surface is not a landing —
      // that is a jump under an overhang — so only a descending walker is caught.
      if (sweptGround || (under && vel.y <= 0 && pos.y <= under.y && under.normal.y >= MIN_GROUND_NY)) {
        if (!sweptGround) pos.y = under!.y;
        vel.y = 0;
        grounded = true;
        flightActive = false;
        flightThrottle = 0;
        directionalFlightArmed = false;
      }
    } else if (under && pos.y - under.y <= SNAP_DOWN) {
      pos.y = under.y;      // stay welded to the surface over crests and dips, rather than skipping off them
      vel.y = 0;
    } else {
      grounded = false;     // walked off an edge
      vel.y = 0;
    }

    if (pos.y < o.oobFloorY) o.onFell?.();
  }

  /**
   * Try one horizontal bite. Accepted when the destination has floor within a step of where the feet are;
   * otherwise the bite is projected along the obstruction and tried once more, which is what lets a walker
   * follow a wall or a too-steep bank instead of sticking to it.
   */
  function tryMove(delta: THREE.Vector3): boolean {
    resolvedFrom.copy(pos);
    resolvedTo.copy(pos).add(delta);
    o.resolveMove?.(resolvedFrom, resolvedTo, vel);
    move.copy(resolvedTo).sub(pos);
    if (move.lengthSq() < 1e-12) return false;
    if (accept(move)) return true;
    // Slide: drop the component heading into the blocking face. Its horizontal normal is the best cheap stand-in
    // for the face itself, and where there is none (a sheer miss off the mountain's edge) the bite is refused.
    const blocked = o.ground(pos.x + move.x, pos.z + move.z, pos.y);
    if (!blocked) return false;
    probe.set(blocked.normal.x, 0, blocked.normal.z);
    if (probe.lengthSq() < 1e-6) return false;
    probe.normalize();
    const into = move.dot(probe);
    if (into >= 0) return false;
    probe.multiplyScalar(into);
    return accept(slide.copy(move).sub(probe));
  }

  /** Commit a bite if there is standable floor at the far end, within one step's rise. */
  function accept(delta: THREE.Vector3): boolean {
    const x = pos.x + delta.x, z = pos.z + delta.z;
    const g = o.ground(x, z, pos.y);
    // Nothing under the destination at all: airborne, that is just flying over a gap and is allowed; on foot it
    // is the lip of the world, and the walker keeps its footing rather than stepping into nothing.
    if (!g) { if (grounded) return false; pos.x = x; pos.z = z; return true; }
    if (!grounded) { pos.x = x; pos.z = z; return true; }
    if (g.y - pos.y > STEP_UP) return false;              // a wall, or a step too tall to stroll up
    if (g.normal.y < MIN_GROUND_NY && g.y > pos.y) return false; // a face too steep to gain height on
    pos.x = x;
    pos.z = z;
    return true;
  }

  return { placeAt, step, moveTracked, position, velocity, isGrounded, isFlying, isFlightBoosting };
}

const UP = new THREE.Vector3(0, 1, 0);
const slide = new THREE.Vector3();

export type Walker = ReturnType<typeof createWalker>;

/**
 * Wrap a world-space segment cast as the walker's ground query: a long vertical probe from just above the feet
 * down through the mountain. A downward cast's NEAREST hit is the topmost surface — the roof of a ride-through
 * structure rather than the snow beneath it, which is what standing on it should mean.
 *
 * Kept beside the walker rather than inside it so the host can serve the cast from a reference level's mesh, an
 * authored quilt, or (in a test) a bare triangle, and so the walker itself stays free of three-mesh-bvh.
 */
export function downwardGroundQuery(
  castSegment: (from: THREE.Vector3, to: THREE.Vector3) => WalkGround | null,
): WalkGroundQuery {
  const from = new THREE.Vector3(), to = new THREE.Vector3();
  const query: WalkGroundQuery = (x, z, fromY) => {
    from.set(x, fromY + PROBE_ABOVE, z);
    to.set(x, fromY - PROBE_BELOW, z);
    return castSegment(from, to);
  };
  query.castSegment = castSegment;
  return query;
}
