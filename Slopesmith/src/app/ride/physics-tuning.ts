import * as THREE from 'three';
import {
  RIDE_AIR_GRAVITY_FALLING, RIDE_AIR_GRAVITY_RISING, RIDE_AIR_HORIZONTAL_DRAG, RIDE_AIR_LEVEL_RATE,
  RIDE_AIR_TURN_RATE, RIDE_BANK_MAX, RIDE_BOOST_ACCEL, RIDE_BOOST_CAP_DECAY, RIDE_BOOST_LEAN_WINDOW,
  RIDE_BOOST_MAX_SPEED, RIDE_CARVE_BITE, RIDE_CARVE_SLIDE_SCALE, RIDE_CARVE_SLIDE_SLEW,
  RIDE_CARVE_SLIDE_SPEED_GATE, RIDE_CONTACT_FIELD_SLEW, RIDE_CONTACT_REDIRECT,
  RIDE_CONTACT_SEPARATION_SPEED, RIDE_CRUISE_DEFICIT_MAX, RIDE_GRIP_SCALE, RIDE_GROUND_ORIENT_GAIN,
  RIDE_GROUND_ORIENT_RATE_CAP, RIDE_GROUND_TURN_RATE, RIDE_LAUNCH_WORLD_UP_SPEED,
  RIDE_MAX_CATCHUP_TICKS, RIDE_MAX_SPEED, RIDE_ORIENTATION_GRACE,
  RIDE_PROBE_ABOVE, RIDE_PROBE_BELOW, RIDE_PUSHOUT_CAP, RIDE_RIDER_DRIVE, RIDE_RIDER_DRIVE_MIN,
  RIDE_RIDER_DRIVE_SPAN, RIDE_SIMULATION_HZ, RIDE_STEER_STRENGTH,
  RIDE_GROUND_TANGENTIAL_PULL,
} from './ride-contract.generated';
import { clamp } from '../../core/math/scalar';

// ---- tuning ----
// Grouped by PROVENANCE, because that is the thing worth knowing about a constant here. A value is either the
// engine's (cited to the chapter that traces it) or this ride's own, and the second kind is labelled `no spec
// constant` with the gap it stands in for. Nothing is inherited from a sibling implementation's inspector
// defaults: where the spec has a number, the spec's number wins.

/** [Trailmap: 340] two-stage air gravity (rising / falling). Ground contact uses the active surface's A/100. */
export const GRAVITY = RIDE_AIR_GRAVITY_FALLING, GRAVITY_RISING = RIDE_AIR_GRAVITY_RISING;
export const GROUND_TANGENTIAL_PULL = RIDE_GROUND_TANGENTIAL_PULL;
// [Trailmap: 360] the shared speed cap: default tier, top (boost) tier, and the ~2.08 m/s per second it eases
// DOWN at. There is no meter here, so boost selects the top tier directly rather than the meter's 3 thresholds.
export const MAX_SPEED = RIDE_MAX_SPEED, BOOST_MAX_SPEED = RIDE_BOOST_MAX_SPEED, BOOST_CAP_DECAY = RIDE_BOOST_CAP_DECAY;
// [Trailmap: 340] air horizontal damping. Ground motion has no generic drag term: the engine bounds it with the
// speed cap, surface cruise response, lateral carve drag, and explicit brake/boost paths. The Snowdream gold run
// confirms that carried speed keeps building down ordinary snow where the former port-only quadratic drag
// plateaued 3.2 m/s early and consequently held the rider onto convex lips for several extra ticks.
export const AIR_H_DRAG = RIDE_AIR_HORIZONTAL_DRAG;
// [Trailmap: 360] cruise drive: the rider-statistic factor (mid of the traced 0.738–1.015 band) and the cap on
// the deficit it may chase.
export const RIDER_DRIVE = RIDE_RIDER_DRIVE, CRUISE_DEFICIT_MAX = RIDE_CRUISE_DEFICIT_MAX;
/** Contact-plane speed below which the travel heading is unreadable and the board's own heading stands in. */
export const CRUISE_HEADING_FLOOR = 0.5;

/**
 * The cruise drive is where a rider's **speed statistic** enters the engine ([Trailmap: 360]): the factor is not
 * one constant but `0.7381 + stat · 0.2769` over the character's stat byte — a 37 % spread between the slowest
 * and fastest rider on the mountain, and the reason a field of AI opponents does not ride as one block. `stat` is
 * 0–1 (the byte normalized). `RIDER_DRIVE` above is the mid-band value the player rides at.
 */
export const RIDER_DRIVE_MIN = RIDE_RIDER_DRIVE_MIN, RIDER_DRIVE_SPAN = RIDE_RIDER_DRIVE_SPAN;
export function riderDrive(stat: number): number {
  return RIDER_DRIVE_MIN + clamp(stat, 0, 1) * RIDER_DRIVE_SPAN;
}
// [Trailmap: 330] the grounded yaw cap is a flat 6°/tick. [Trailmap: 340] air spin runs 271–670°/s by rider stat;
// 270 is the low-stat end, and this ride only yaws (the engine rotates about a stick-selected axis, all axes alike).
export const GROUND_TURN_RATE = RIDE_GROUND_TURN_RATE, AIR_TURN_RATE = RIDE_AIR_TURN_RATE; // deg/s
// Shared steering shaping. CARVE_BITE has no traced retail formula [open]: 330 gives each surface's carve drag
// but not how that drag becomes a lateral acceleration, so the gold profile records the validated conversion.
export const STEER_STRENGTH = RIDE_STEER_STRENGTH, GRIP_SCALE = RIDE_GRIP_SCALE, CARVE_BITE = RIDE_CARVE_BITE;
export const BANK_MAX = RIDE_BANK_MAX;                  // [Trailmap: 330] roll = lean · 50°
/**
 * VR head steering (docs/048) — `no spec constant`, and deliberately so: the engine has no headset, so the spec
 * traces no gaze reference at all. These three are the SHIPPED VRChat board's authored values
 * (`RideableBoard.headLookDeadzone` / `headLeanFullAngle`, Unity docs/vrchat/017), taken because the point of the
 * WebXR port is that the same mountain steers the same way in both headsets — not because a sibling
 * implementation's inspector outranks the spec. Everything they feed is spec'd: the deadzone and the full-lean
 * angle only shape an intent that then runs the ordinary lean slew, yaw closure and `6°/tick` cap.
 *
 * `HEAD_LOOK_DEADZONE` is the yaw treated as "aligned" — inside it the board stops turning, so a glance at the
 * scenery does not nudge the nose. `HEAD_LEAN_FULL_ANGLE` is the gaze offset from TRAVEL that maps to full lean:
 * measured against travel and never the nose, because the closure parks the nose on the gaze in ~0.1 s and a
 * nose-referenced lean would cancel itself before its banked force could bend the line (on ice that force is the
 * only thing that CAN bend it). `HEAD_STICK_OVERRIDE` is the stick deflection past which the thumb owns the lean.
 */
export const HEAD_LOOK_DEADZONE = 5, HEAD_LEAN_FULL_ANGLE = 30, HEAD_STICK_OVERRIDE = 0.05; // deg, deg, 0..1
/**
 * Headset-tested controller comfort ported from the shipped Unity board. On snow the upright rig receives one
 * quarter of the already-clamped stick yaw; air and rail use full carry. Rail steering shares AIR_TURN_RATE
 * and its trick-boost multiplier on every input path, as the Unity board does (`RideableBoard.Rail`); only
 * WebXR carries that turn into the pinned upright headset seat.
 */
export const XR_GROUND_STICK_VIEW_CARRY = 0.25; // ratio
// Pose easing: the final deck quaternion is measured independently from the contact basis. Across Snowdream's
// first marked lip its angular step grows from 0.05° at 5.8° error to 0.80° at 11.9° error — a cubic response,
// not a constant-speed chase. The gain below reproduces that curve; the old 270°/s rate remains only its safety
// cap for teleports. Neutral-air leveling in the next two gold flights measures 7.6–10.4°/s.
export const TILT_RATE = RIDE_GROUND_ORIENT_RATE_CAP;
export const GROUND_ORIENT_GAIN = RIDE_GROUND_ORIENT_GAIN, AIR_LEVEL_RATE = RIDE_AIR_LEVEL_RATE;
export const ORIENT_GRACE = RIDE_ORIENTATION_GRACE, LAUNCH_LEVEL_SPEED = RIDE_LAUNCH_WORLD_UP_SPEED;
/**
 * [Trailmap: 340] pre-landing alignment: while falling, the air update probes the world along the predicted
 * travel and rebuilds the basis toward the surface it is about to hit, so the deck arrives pre-tilted instead of
 * slapping down crooked and conforming after contact. The engine's rebuild is geometric with no fixed rate; this
 * ride keeps its eased visible basis and closes the remaining error over the time remaining instead — pose reads
 * `landEta` for the rate, and the same clock tells the rider's legs when to reach for the snow.
 */
export const PREALIGN_HORIZON = 0.9;  // s of ballistic lookahead; beyond it neutral air just levels at 9°/s
export const PREALIGN_STEP = 0.15;    // chord length of the bounded march — six casts at most, first find wins
export const PREALIGN_LEAD = 0.10;    // be square this early: "arrives pre-tilted", not "arrives turning"
/** Contact crossed while separating faster than this is a departure, not a landing. The 0.25 m/s tolerance
 *  admits the gold trace's tiny +0.03 m/s transition noise while rejecting the 1.4–11.8 m/s false far-side
 *  touchdowns in the Snowdream comparison run. Shared with pose so a downhill lip is recognized as a launch. */
export const CONTACT_SEPARATION_SPEED = RIDE_CONTACT_SEPARATION_SPEED;
/**
 * The crouch, which is animation and nothing else. It folds at `CROUCH_FOLD` and unfolds at `CROUCH_POP` — the
 * legs *drive* out of an ollie, they do not relax out of one, so the two rates are not the same number.
 *
 * A charged ollie is a coil and a spring, and both are proportional to the charge: the duck follows the meter
 * exactly (`CHARGE_RATE` is slower than `CROUCH_FOLD`, so the fold never lags it), and the launch then drives the
 * legs *past* standing for `POP_TIME`. `POP_MIN` is the drive a bare tap still gets — the spec floors the launch
 * speed of a tap at 6.309 m/s, so a tap has to look like a pop and not a stumble.
 */
export const CROUCH_FOLD = 6, CROUCH_POP = 18, CROUCH_BRAKE = 0.55, CROUCH_AIR = 0.3;
/** Landing preparation, coached rather than traced: a rider spots the landing and extends the legs just before
 *  impact so contact can fold them again — the extension is what gives the knees their absorption travel back. */
export const CROUCH_REACH = 0.05, LAND_REACH_ETA = 0.25;
export const POP_TIME = 0.20, POP_MIN = 0.35;
// [Trailmap: 320] explicitly sanctions this only for the faceted fallback: the engine low-passes nothing because
// terrain contact is analytic. Both authored and extracted-reference rides now carry patch contact and bypass it.
export const NORMAL_SMOOTHING = 0.05;
export const BRAKE_STRENGTH = 18;                       // no spec input: no brake or tuck control is traced [open]
// [Trailmap: 340] the charged launch. The 6.309 m/s floor applies even to a tap; above it the launch is
// charge² · riderCurve · speedFactor, so a faster approach jumps higher — and at mid rider stat the product never
// clears the floor at all, i.e. only a high-stat rider's charge buys anything. Charge-up rate: no spec constant
// [open] (only the 13.33/s release countdown is traced). The coyote window stands in for the spec's control/motion
// decoupling — the engine has no ground check at the launch instant, so a bump-skip can't eat a committed jump.
export const JUMP_MIN = 6.309, JUMP_RIDER_CURVE = 0.8855, JUMP_SPEED_FACTOR_MAX = 8.9987;
export const LAUNCH_FALLBACK_TANGENT = 0.2, LAUNCH_TANGENT_MIX = 1;
export const CHARGE_RATE = 2.5, JUMP_COYOTE_TIME = 0.12, OLLIE_COOLDOWN = 0.35;
// [Trailmap: 360] held-boost ground thrust and the lean window that gates it — boost is a hold-your-line tool,
// and edging past the window wastes it. The spec's further `+ slope·10.5` favorable-slope term is [open] (the
// "slope field" it reads is not defined) and is left out rather than guessed.
export const BOOST_ACCEL = RIDE_BOOST_ACCEL, BOOST_LEAN_WINDOW = RIDE_BOOST_LEAN_WINDOW;
/**
 * Unity parity (RideableBoard.AirTick), intentionally outside the retail contract: held boost in the air is
 * aimed by the rider rather than by the deck. Below the shared cap it is plain thrust; through the final 2 m/s
 * it cross-fades to a magnitude-preserving bend so the cap cannot eat a sideways aim. The same Unity presentation
 * lifts the game's x1.6 trick-boost multiplier onto the rider's air spin and flip inputs.
 */
export const AIR_BOOST_ACCEL = 8, AIR_BOOST_TURN_RATE = 40, AIR_BOOST_CAP_BLEND = 2;
export const AIR_TRICK_BOOST_SPIN_MUL = 1.6;
/**
 * The physics tick. The engine integrates at a fixed 60 Hz and its contact constants are **per tick**, not per
 * second: the pushout adds a length to velocity once a tick, and the contact fields slew a flat 1.6667 units
 * (`CONTACT_SLEW · TICK_H`) a tick. Scaling those by a variable `dt` would make the ride a different game at
 * every frame rate, so `step()` accumulates real time and runs whole ticks. MAX_TICKS bounds the catch-up after
 * a hitch — beyond it the ride runs slow rather than teleporting the board through the terrain.
 */
export const TICK_HZ = RIDE_SIMULATION_HZ, TICK_H = 1 / TICK_HZ, MAX_TICKS = RIDE_MAX_CATCHUP_TICKS;
// [Trailmap: 320] the contact probe: one segment along the CACHED contact normal, from 2 m above the deck
// reference to 1 m below it. Its reach below the deck IS the ground/air band — no velocity threshold decides.
export const PROBE_ABOVE = RIDE_PROBE_ABOVE, PROBE_BELOW = RIDE_PROBE_BELOW;
// [Trailmap: 320] the capped one-sided pushout backstopping the response: at most 10 units (0.1 m) per tick.
export const PUSHOUT_CAP = RIDE_PUSHOUT_CAP;
// PORT divergence, shared with the Unity board (Unity docs/vrchat/020): the pushout cap is a GROUND backstop. On a
// steep face (a wall-ride) the engine's real protection is the type-6/10 wall wipeout this ride doesn't run, and
// a capped pushout loses the penetration race against a wall curving into the path — the deck tunnels out of the
// level. A wall ejects fully instead. WALL_NY mirrors the board's wallNormalMax.
export const WALL_NY = 0.5;
// Seam RECOVERY, ditto (Unity docs/021): a contact-ray miss on a steep face (contactN.y < RECOVER_NY) falls to
// closest-point discovery for at most RECOVER_TICKS_MAX consecutive ticks (0.1 s) instead of reverting to the
// down-probe, which cannot see a wall beside the deck. Flat-ground lips keep reading as air, and the contact
// error still decides grounded — a genuine launch leaves mid-recovery.
export const RECOVER_NY = 0.85, RECOVER_TICKS_MAX = 6;
// [Trailmap: 320] the grounded redirect: the fraction of the velocity's normal component the ground update's
// tail removes each tick before restoring the speed magnitude. Per tick, like the pushout — not per second.
export const GROUND_REDIRECT = RIDE_CONTACT_REDIRECT;
/**
 * The tangential speed below which there is no travel direction for the redirect to rotate into, so the
 * magnitude restore is skipped ([Trailmap: 320] "at a standstill it does nothing").
 *
 * That clause holds only for an EXACTLY normal velocity. The restore's gain on the tangential channel is
 * `spd0/spd1`, which tends to `1/(1 − GROUND_REDIRECT)` = 1.667 per tick as the tangential component tends to
 * zero — unbounded amplification, so a standstill is a repeller rather than an equilibrium. It has a supply to
 * amplify because a deck pinned at its pushout budget manufactures normal velocity for free: the pushout zeroes
 * `vn`, the position integrates with that zeroed velocity so the deck never moves, and the response — saturated
 * at its `2A/100` clamp — refills the normal channel by `accel·dt` before the next tick. The redirect then banks
 * 1.667× of that refill as travel, in whatever direction float noise in the contact normal points. A dead-flat
 * patch has no other tangential input, so noise picks the heading: 3 mm/s of seed becomes 1.4 m/s in ~12 ticks,
 * and if it lands behind the board the cruise drive's alignment gate is shut for the rest of the run.
 *
 * The floor is an absolute speed, not a ratio: a ratio test would also fire on a hard landing (normal velocity
 * legitimately dwarfs tangential there) and that is exactly the case the restore exists to serve. At two orders
 * above the tangential a flat patch's float-level normal tilt can produce at any survivable impact speed, and
 * three below riding speed, it separates the two without touching any landing that has real travel to carry.
 */
export const REDIRECT_TANGENT_FLOOR = 0.05;
/**
 * [Trailmap: 330] the lateral carve slide: the deck — and the ground probe with it — slews toward
 * `−scale·lean·min(1, speed·gate)` metres of OUT-of-the-turn offset along the contact-frame lateral axis
 * (166/167 high-lean retail ice frames put the offset against the centripetal direction; Gari's rider tune
 * byte measured ≈1.0, so the scale carries no extra factor). Probing under the slid deck is not cosmetic:
 * on concave terrain — a banked trail's wall–floor junction — the offset sample reads a DEEPER contact
 * error, the three-zone response climbs toward its 2A clamp, and `response·tanθ` becomes the second-half
 * carve authority. The retail ice ping-pong sustains 13–17 m/s² of lateral bend where the flat-equilibrium
 * response yields 11.6; without the offset probe the sim measurably pins at the latter and cannot hold the
 * ice trail. The speed gate saturates by 1.4 cm/s — full slide at any riding speed, zero at a standstill.
 */
export const CARVE_SLIDE_SCALE = RIDE_CARVE_SLIDE_SCALE, CARVE_SLIDE_SLEW = RIDE_CARVE_SLIDE_SLEW,
  CARVE_SLIDE_SPEED_GATE = RIDE_CARVE_SLIDE_SPEED_GATE;
// [Trailmap: 310] the per-surface contact fields ease in at 1 m/s (100 units/s) rather than snapping, so
// crossing onto powder eases its ~30 cm sink in over a third of a second.
export const CONTACT_SLEW = RIDE_CONTACT_FIELD_SLEW;
/**
 * [Trailmap: 340] touchdown scales the carried velocity by two orientation error angles on a progressive band —
 * square landings keep their speed. Which measured angle is the spec's "first" and which the "second" is
 * [inferred]: the tighter band takes the deck-vs-surface tilt, the looser one the facing-vs-travel yaw.
 * The bands need no gate: on a bump-skip both errors are ≈ 0, so they multiply by 1 and cost nothing.
 */
export const LAND_TILT_FREE = 15, LAND_TILT_MAX = 50, LAND_TILT_SCALE = 0.85;
export const LAND_YAW_FREE = 25, LAND_YAW_MAX = 80, LAND_YAW_SCALE = 0.75;
/**
 * Riding switch (docs/016): the deck is an **axis**, not an arrow, and `st.lead` says which of its two ends is
 * currently leading the travel. Both numbers are this ride's own — the traced heading fields are single-signed
 * and carry no switch bit [open], so the latch that picks the leading end is Slopesmith's, not the engine's.
 *
 * `SWITCH_LATCH_ANGLE` is how far the travel has to swing OFF the ridden end before the other one takes over.
 * Past 90° would chatter on any hard skid; 110° leaves a 40° dead band on each side (a flip lands at 70° from the
 * end it just handed off to and needs another 40° to hand it back), which is hysteresis rather than a filter — no
 * state, no lag, and it cannot oscillate.
 *
 * `SWITCH_LATCH_SPEED` is the travel speed below which there is no leading end to read at all. It is set clear of
 * the 1.4 m/s of backwards creep that flat ground's contact buzz can manufacture out of float noise (the failure
 * `test/flat-ground-ride.test.ts` was written for): a rider who has not chosen to be going backwards must never
 * be handed the switch lead, and with it the cruise drive, by a millimetre-per-second seed.
 */
export const SWITCH_LATCH_ANGLE = 110, SWITCH_LATCH_SPEED = 2.0; // deg, m/s — no spec constant
/**
 * The flip (docs/016): **W / S held in the air** rotate the deck about its lateral axis, forward over the nose or
 * backward over the tail. On the ground those two keys are still the tuck and the brake, neither of which the air
 * update has ever read, so the flip costs no key and no mode.
 *
 * Its **rate is not this ride's own**: [Trailmap: 340] spins yaw, pitch and roll at one rate, so a flip turns at
 * exactly the yaw spin's `AIR_TURN_RATE`. That has a consequence worth knowing rather than tuning away — 270°/s
 * needs 1.33 s for a whole rotation and a flat ollie buys about 1.2 s, so a flip wants a real lip under it. This
 * is the low-stat end of the traced 271–670°/s band; the ride does not yet field the rider stat that widens it.
 *
 * `FLIP_RECOVER_RATE` is the ride's own [no spec constant]: whatever is left of an unfinished rotation rocks back
 * onto the base at touchdown rather than being held or snapped. The rider has already paid for it once in the
 * touchdown tilt band, and leaving them visibly inverted for the two thirds of a second the deck chase would take
 * is a second, cosmetic punishment for the same landing.
 */
export const FLIP_RECOVER_RATE = 720; // deg/s
// Swept rider volume: short rays at the board extremities, torso/shoulders and head stop fast motion crossing
// tunnel walls or ceilings between 60 Hz ticks. Floor-like hits remain the original board contact system's job.
export const RIDER_HEAD_Y = 1.72, RIDER_TORSO_Y = 0.92, RIDER_SHOULDER_R = 0.30;
export const BOARD_COLLISION_Y = 0.14, BOARD_HALF_LENGTH = 0.78, BOARD_HALF_WIDTH = 0.24, RIDER_BARRIER_PAD = 0.08;
// A response-mass-zero floor plate never becomes ground, and a carried board's ordinary barrier samples stay
// BOARD_COLLISION_Y above it while travelling parallel to its face. Probe a narrow band below those nine deck
// samples as a SENSOR only: this catches flush buttons/breakaway panels without making a panel overhead fire.
export const BOARD_SENSOR_BELOW = 0.20;
/**
 * The rider's BODY SPHERE — the single sphere a native mode-2 bounding box is tested against
 * ([Trailmap: 370-probe-volume, 370-probe-modes]). It is not the deck: the engine poses it at the midpoint of
 * two trunk joints, so a box beside the board is answered by the rider's chest and a box the board grazes is
 * answered by nothing. The height mirrors the torso samples above.
 *
 * The radius is MEASURED, not guessed: 0.85 m, read live off a paused session two independent ways — the
 * constructor argument the engine scales by 100, and the world-unit radius it stores on the sphere set. That
 * makes the body sphere large: centred near the pelvis it reaches from just above the deck to well over the
 * rider's head, so it is a coarse ball around the whole person rather than a small chest sphere. Whether the
 * value is per character is still open — the record it comes from is a profile-shaped singleton, and only one
 * rider existed in the snapshot that pinned it.
 *
 * The HEIGHT is still this ride's own. The engine's sphere sits at the midpoint of the two hip joints, but the
 * only live measurement of that is one frame of a falling noclip pose, which is not a standing rider.
 */
export const RIDER_BODY_Y = 0.92, RIDER_BODY_R = 0.85;
/**
 * How far a solid prop pushes a rider back out, as a multiple of the reported penetration
 * ([Trailmap: 370-depenetrate]). The engine resolves a prop contact by depenetration FIRST — position moved
 * along the contact normal by this much — and only then applies the restitution. The tenth over unity is what
 * leaves the rider actually clear of the shape rather than resting exactly on its surface.
 */
export const NATIVE_DEPENETRATION = 1.1;
// [Trailmap: 370-world-interaction] A PlayerBounce response always leaves the prop at least 2 km/h
// (55.556 native cm/s), even when the authored restitution or incoming normal speed is tiny.
export const PROP_BOUNCE_EJECT_FLOOR = 2 / 3.6;
/**
 * Dynamic-prop contact uses the specified normal impulse:
 * `1.3·closing / (rotationalEffectiveMass + propInverseMass + riderMassTerm)`.
 * Scalar inverse mass comes from the activating Roller's dynamic mass, independently of the instance's static
 * response mass. The rider term is small, so a rider retains most of their travel through a bag. A brush is not
 * a shove: below MOVABLE_MIN_IMPACT a body stays standing [Trailmap: 370-impulse, 370-roller].
 */
export const SHOVE_RESTITUTION = 1.3, RIDER_MASS_TERM = 0.01, MOVABLE_MIN_IMPACT = 0.75;
/** Sign that makes D / stick-right turn right in this frame (verified in-browser). */
export const STEER_SIGN = -1;
/**
 * Low-grip steering assist — NOT retail. A port-level rider aid in the same class as `wallCrashSpeed = 0`:
 * the contract keeps carrying the measured retail table, and this sits on top of it.
 *
 * Retail ice is laterally frictionless (carve drag 0.0025 against standard snow's 1.2017), and the measured
 * consequence is not that a skid fails to recover — it is that the skid recovers the WRONG WAY. Centre the
 * input mid-carve on ice and the slip angle reaches zero in 0.75 s, but 77% of that closure is the board
 * YAWING ONTO ITS DRIFT rather than the drift bending back under the board; snow inverts the split, 28/72
 * (`tools/ride-study/ice-slip-sweep.ts 5 drive recover`). The rider is left travelling ~21° off their line,
 * reading zero slip, with nothing able to correct it: lean is centred so there is no tilt force, and slip is
 * zero so the carve drag has nothing to bite. Every number freezes and the line never comes back.
 *
 * That is survivable on a stick, which can hold full counter-lean indefinitely for free. It is not survivable
 * on VR head-steer, where a neck is a position control with ~60° of comfortable range, no detent, and no rest
 * state — which is exactly the report this came from.
 *
 * TWO terms, and neither works alone. Damping the self-centring yaw on its own leaves the rider sliding off
 * the course pointing the right way (worse: it looks correct and is not). Bleeding the uncommanded lateral
 * velocity on its own finds nothing to bleed, because the yaw has already driven it to zero inside 0.75 s.
 * Together the heading holds, the slip survives as an error signal, and the drift bends back under the board.
 *
 * At the tuning below, ice's release splits 36/64 instead of 77/23 — inverted, and near snow's natural 28/72
 * — while the held carve is untouched: the lean sweep still settles on 31.92°/lean against retail's 31.81,
 * every slip row unchanged to two decimals. Standard snow is byte-identical, by construction rather than by
 * measurement, since `iceAssistFor` returns exactly 0 there and both terms drop out.
 */
export const ICE_ASSIST_DRAG_REF = 0.15;
/**
 * Authority ramps in as a surface's own carve drag falls below `ICE_ASSIST_DRAG_REF`, so the assist is
 * selected by the surface table rather than by a hardcoded row: ice (0.0025) → 0.98, ice crunch (0.0) → 1.00,
 * speed (0.03) → 0.80, off-track metal (0.1) → 0.33, and every ordinary rideable surface — standard snow
 * (1.2017), off-track (1.5091), powder (3.0013), the generic row (1.0) — → exactly 0, so both terms evaluate
 * to nothing there and those surfaces run the arithmetic they ran before. No `if (surf === 5)` anywhere.
 */
export function iceAssistFor(carveDrag: number): number {
  return Math.min(1, Math.max(0, (ICE_ASSIST_DRAG_REF - carveDrag) / ICE_ASSIST_DRAG_REF));
}
/**
 * How much of the heading's yaw is withheld while it is UN-COMMITTING — the commanded lead has fallen inside
 * the slip already being carried, and on the same side of it, so the closure is walking the board out onto
 * its own drift. Entering a carve and reversing one both keep full retail authority.
 *
 * The condition is deliberately the yaw's direction rather than "is the input centred": lean slews to zero
 * over ~0.14 s while three quarters of the re-alignment is already done, so a lean-gated damp arrives after
 * the fact (measured 77/23 → 73/27, i.e. nothing). Applied AFTER the 6°/tick clamp, because the re-alignment
 * is cap-limited and scaling the pre-clamp closure fraction would not reach it.
 *
 * High because damping the heading is the cheap half: it adds no artificial grip, it only stops the board
 * reporting zero slip while the rider is still leaving the course. The recovery rate below is the half that
 * does add grip, so it carries as little of the work as it can.
 */
export const ICE_SELF_CENTER_DAMP = 0.97;
/**
 * Rate (1/s) at which lateral velocity is pulled onto the lean's COMMANDED drift rather than onto zero. The
 * commanded value needs no fitted curve and no new surface column: on a near-frictionless surface the settled
 * slip angle IS the heading's own lead angle, `turnLean` — measured at 0.9734 × turnLean with a 0.26° max
 * residual across the whole lean range and every speed. (The 3% deficit is the lateral drag itself, which is
 * why the identity is only this tight where the drag is ~0 — standard snow reads 0.6976 with a 1.78°
 * residual. Fine: the assist is zero there.) So a held lean keeps its full retail drift and only the drift
 * nobody asked for is bled off.
 */
export const ICE_SLIP_RECOVER = 2.5;
/**
 * Assist term 3: lift a low-grip surface's carve TILT toward the 58.3° that 17 of the 20 rows already carry.
 * `θ = tilt°·lean` banks the contact response into the turn, and `response·tanθ` is the entire force bending
 * the velocity — so this is turn AUTHORITY, the thing that decides whether a line fits inside the course.
 *
 * It is the right knob for "more grip on ice" because the two obvious ones are not. The carve drag cannot do
 * it: term 2 pulls the lateral velocity onto the commanded drift, so raising the drag is simply cancelled.
 * And the drift ANGLE cannot be dialled down directly — it is kinematic. Equilibrium is where the yaw closure
 * matches the rate the velocity is already rotating, `(turnLean − slip)·hClose = ω/60`, so a small ω forces
 * slip up against turnLean. Ice's ω is small (48°/s at full lean against snow's 179°/s), which is exactly why
 * its slip sits at 0.97 of turnLean where snow's sits at 0.70. Raising the tilt raises ω — the board turns
 * tighter — and the drift angle barely moves, because on ice `hClose` stays high with the speed. That is the
 * useful shape here: ice keeps its 28° drift LOOK and gets a line that fits the course.
 *
 * 0 is retail. 1 is snow parity. Scaled by the assist, so this reaches ice (45°) and nothing else: rock's
 * 21.34° is a high-drag row and reads assist 0, and every other low-drag row already sits at 58.3°.
 */
export const ICE_TILT_LIFT = 0.5;
/** The carve tilt 17 of the 20 surface rows share; `ICE_TILT_LIFT` interpolates toward it, never past it. */
export const CARVE_TILT_BASE = 58.3;
export function iceCarveTilt(tilt: number, assist: number): number {
  return tilt >= CARVE_TILT_BASE ? tilt : tilt + assist * ICE_TILT_LIFT * (CARVE_TILT_BASE - tilt);
}
/**
 * Rails ([Trailmap: 350]). Grinding is its own motion state: the rider attaches to the authored spline and
 * travels by slewing velocity onto the analytic curve tangent with the speed MAGNITUDE preserved, under a
 * dedicated gentle slope gravity and zero friction. The per-tick velocity update has exactly three
 * speed-affecting terms and no drag: the tangent capture at 30/s, gravity's 9.8 m/s² dotted onto the tangent
 * (about half the falling air gravity), and the held boost's 24.508 m/s² along the travel direction — boost
 * pushes along the rail even uphill. Falling off is a contact-ACCEPTANCE failure (the windows in `grind.ts`),
 * not a balance failure: no balance meter exists.
 */
export const RAIL_TANGENT_SLEW = 30, RAIL_GRAVITY = 9.8, RAIL_BOOST_ACCEL = 24.508;
// [Trailmap: 350] the lateral attachment correction writes position only — never speed — clamped ±2.9015 m a
// tick, which inside the acceptance windows is simply a full re-seat onto the curve.
export const RAIL_ATTACH_CLAMP = 2.9015;
// [Trailmap: 350] rail input yaw-spins the DECK while its travel remains locked to the spline. Slopesmith uses
// the shipped Unity presentation here: held input turns continuously, allowing boardslides, 360s and chained
// rotations instead of stopping at the retail ±80° trick-animation pose.
// Re-lock lockout after a jump off a rail: no spec constant [open]. The acceptance windows are purely
// positional and a fresh pop's first ticks are still inside them — without a lockout the ollie re-locks on the
// next tick and a jump can never leave the rail. Mirrors the Unity board's relock cooldown.
export const RAIL_RELOCK_TIME = 0.35;

/**
 * The RIDERLESS COAST (`board-coast.ts`) — what a board does once the rider steps off it. `no spec constant`,
 * and necessarily so: the engine has no dismount at all, so the spec traces nothing here. The ground values are
 * the shipped VRChat board's authored values (`RideableBoard.coastFriction` / `speedDrag` /
 * `coastStopSpeed` / `coastMaxTime`, Unity docs/vrchat/017), taken for the same reason the VR head-steer constants above are:
 * getting off a board is one behaviour across both places OpenSlope rides, not two.
 *
 * `COAST_FRICTION` is the ground's linear deceleration. Air uses the gentler proportional
 * `COAST_AIR_RESISTANCE`, deliberately below the player's 0.3/s so two objects launched together gradually
 * separate with the loose deck in front.
 * `COAST_MAX_TIME` is a safety countdown, not a feel constant: a board that has flown off the world must not be
 * tracked forever.
 */
export const COAST_FRICTION = 14, COAST_QUADRATIC_DRAG = 0.012;
/** Gravity for equipment after it leaves the rider; independent of the mounted ride's asymmetric 8.5/19 arc. */
export const COAST_GRAVITY = 14;
export const COAST_AIR_RESISTANCE = 0.1;
export const COAST_STOP_SPEED = 1.5, COAST_MAX_TIME = 6;
/** How high above the surface still counts as sliding on it, and where a coasting deck rests above the hit. */
export const COAST_STICK = 0.25, COAST_SEAT = 0.02;
/** Outward speed along the surface normal above which a deck is leaving it, not landing on it. */
export const COAST_SEPARATION_SPEED = 0.25;

/**
 * THE BOARD IN YOUR HAND (`board-grab.ts`) — the VR carry. `no spec constant` for the same reason the coast
 * above has none, and taken from the same place: the shipped VRChat board's `RideableBoard.throwScale` /
 * `throwMaxSpeed` / `THROW_MAX_SPIN`, its pickup's authored `proximity`, and `BoardSummon.handTransferReach`
 * (Unity docs/vrchat/017).
 *
 * Both reaches are measured from the grip point to the deck's own BOX, not to its origin, so taking hold of the
 * nose of a long deck counts. Taking a board off the snow is deliberately the more forgiving of the two — it is
 * an arm's length, not a touch, which is what a headset needs when the deck is lying at your feet and your real
 * floor is somewhere else. Passing it between hands is the tighter one: that hand has to be ON the deck.
 * `THROW_SAMPLE_MIX` is the low-pass on the measured throw — one bad tracking frame must not become the throw.
 */
export const GRAB_REACH = 1.5, HAND_TRANSFER_REACH = 0.35;
/** Wrist to the middle of a closed fist, along the canonical hand frame's finger axis (`+Y`). Where a hand
 *  actually closes, and therefore the point the deck is taken hold of at. */
export const GRAB_HAND_FORWARD = 0.045;
export const THROW_SCALE = 1, THROW_MAX_SPEED = 12, THROW_MAX_SPIN = 720; // m/s, deg/s
export const THROW_SAMPLE_MIX = 0.5;
/**
 * POINTING at a board to get on it — the trigger's half of the split, and a raycast in the shipped world too
 * (`RideableBoard.Interact` is VRChat's own use-ray). How far a pointed deck may be, and how much the aimed
 * outline is padded so a 14 cm-thick board is something a person can point at rather than thread a needle
 * through. The range is deliberately longer than an arm: pointing is what tells a board across the gate apart
 * from the one at your feet, and having to walk into contact first is what the reach above is for.
 */
export const MOUNT_AIM_RANGE = 4, MOUNT_AIM_PAD = 0.1;
/**
 * THE OVER-THE-SHOULDER SUMMON (`BoardSummon`, Unity docs/vrchat/017) — reach behind your head and squeeze, and
 * your board comes to your hand from wherever it lies. Three authored bounds, all measured in a YAW-ONLY head
 * frame: how far BEHIND the head the hand must be, how far from the head it may stray (which is what keeps this
 * an over-the-SHOULDER reach rather than "any time your hand is behind you"), and how far below the head it may
 * fall before it is a hand at the hips rather than one at the shoulder blades.
 */
export const SUMMON_BEHIND = 0.10, SUMMON_RADIUS = 0.55, SUMMON_MIN_HEIGHT = -0.25;

export const D2R = Math.PI / 180;
export const WORLD_UP = new THREE.Vector3(0, 1, 0);
