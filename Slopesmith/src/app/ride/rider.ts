import * as THREE from 'three';
import { clamp } from '../../core/math/scalar';
import {
  RIDE_AIR_GRAVITY_FALLING, RIDE_AIR_GRAVITY_RISING, RIDE_GROUND_TANGENTIAL_PULL,
} from './ride-contract.generated';
import { attachCharacterRig, type CharacterHandCurl, type CharacterPose } from './character-rig';
import {
  BINDING_ANGLE_FRONT, BINDING_ANGLE_REAR, DEFAULT_RIDE_GEAR, DEFAULT_SNOWBOARD_STANCE,
  type RideGear, type SnowboardStance,
} from './gear';
import { DEFAULT_RIDER_MODEL_ID } from './rider-models';
import {
  blendStance, crossStance, DEFAULT_RIDING_STYLE, ridingStyle, type RidingStyle, type Stance,
} from './stances';

/**
 * The ridden body: a stick figure standing on whatever `gear.ts` put under it.
 *
 * The rider's whole job is the one thing a snowboarder actually does. The deck still moves under him — landing
 * transients, the pushout's steps, facet chatter on a reference mesh — and a rigid rider bolted to it jolts with
 * every one. Here the bindings are rigid and the *hips* are not: they carry the board's velocity **along the
 * surface** exactly, so steady travel costs no lag, and decline to carry its motion along the spine, which is
 * the deck's jolt. The legs make up the difference. The knees eat it, absorb a landing, coil for an ollie and
 * drive out of it, and the head glides.
 *
 * The arms do the opposite. Carrying no load, they take the board's acceleration straight — hanging on the
 * pseudo-force `−a` and sprung back toward where the rider keeps them (`ARM_GAIN`).
 *
 * How he *stands* — neutral, on either edge, coiled — is a **stance**, and a named set of four is a **riding
 * style**; both live in `stances.ts`, which is the tuning surface for the figure. This module blends them and
 * evaluates the result into a body. There is no captured pose anywhere below and nothing to import: a carve is
 * generated from what a carving snowboarder does. A style can be handed over at any moment, mid-run, and the
 * body crosses to it without being rebuilt — the absorber, the arm sway and the glance all carry straight
 * through.
 *
 * **Gear turns the body ninety degrees, and nothing else.** A snowboarder stands ACROSS their deck: the ankle
 * line the caller hands over is the board's nose axis, so the hips and shoulders span the board and the chest
 * faces the toe edge. A skier stands along their skis: the same ankle line is now the rider's own lateral, so
 * the hips and shoulders span the BODY and the chest faces down the fall line. Every axis the solver derives —
 * `toe`, `along`, the arm frame — falls out of the ankle line the same way in both cases and comes out right,
 * because the whole triad turns with the feet. What does not fall out is which way a lay-in tips: a
 * snowboarder inclines toward an edge, about the deck's long axis, and a skier inclines left or right, about
 * the direction of travel. That single axis, plus a handful of places that had the deck's nose hard-coded, is
 * the entire difference below.
 *
 * Everything is posed in WORLD space against the deck's transform, and the body is **never banked with the
 * deck**: the deck rolls to its full edge angle while the rider leans by much less, off the surface they are
 * riding. The gap between the two is the carve. The caller hands over that surface, the bank and the ankles,
 * and this module decides which response applies.
 */

const D2R = Math.PI / 180;
const UNIT_Y = new THREE.Vector3(0, 1, 0);   // the bone geometry's own axis
const WORLD_UP = new THREE.Vector3(0, 1, 0); // gravity's, which the spine argues with

// ---- the rider ----
/**
 * Proportions. The figure is a 1.70 m rider, and every segment is that stature times its standard
 * anthropometric fraction (Winter, *Biomechanics and Motor Control of Human Movement*): thigh 0.245, shank
 * 0.246, upper arm 0.186, forearm 0.146. Femur and tibia come out within 2 mm of each other, which is what a
 * human actually is — the leg is not two unequal sticks, and making it one keeps the knee reading as a knee
 * through a deep coil.
 *
 * He measures 1.70 m from the snow to the top of his helmet as he rides, too, which is what the 155 cm board
 * under him is sized for. That is not the same 1.70 — bent knees give away about 11 cm and the board, binding
 * and boot under the ankle hand back 14 — and the stylised 27 cm helmet covers the rest.
 */
const RIDER_H = 1.70;
const THIGH = 0.245 * RIDER_H, SHIN = 0.246 * RIDER_H;         // 41.7 / 41.8 cm
const UPPER_ARM = 0.186 * RIDER_H, FOREARM = 0.146 * RIDER_H;  // 31.6 / 24.8 cm
const REACH = (THIGH + SHIN) * 0.998;      // a hip may never be pulled past it; the knee straightens instead
/**
 * The trunk, walked as the chain it is rather than one cylinder. `hips` is the sacral pivot — the animation
 * root, which sits above the femur sockets, not between them. From there the spine runs lumbar then thoracic
 * to the clavicle root at the base of the neck; the shoulder-joint line hangs just below that, and the neck
 * carries on to the skull base. Standing, hip pivot to neck base is 0.491 m on these fractions; a rider is
 * folded forward over the board, so the chain below spends 88% of it.
 */
const PELVIS_RISE = 0.051 * RIDER_H;       // sacral pivot above the femoral heads
const LUMBAR = 0.192, THORACIC = 0.242;    // hips → upper back → clavicle root
const SHOULDER_DROP = 0.075;               // clavicle root down the spine to the shoulder line
const NECK_LEN = 0.075;                    // clavicle root to the skull base
const HEAD_BONE_TO_HELMET = 0.105;         // skull base to the centre of the helmet
/** The avatar viewpoint is the bridge between its eyes, not the centre of its helmet. These are the procedural
 * face's authored eye-midpoint offsets; imported characters are uniformly fitted to this same solved body. */
const VIEW_FROM_HEAD_UP = 0.025, VIEW_FROM_HEAD_FORWARD = 0.124;

/** The modeled eye bridge used by a desktop first-person camera. The solved `head` landmark is the helmet
 * centre; keeping this conversion beside the inverse XR conversion at the bottom prevents the two views from
 * quietly drifting to different parts of an imported face. */
export function riderViewpoint(pose: Pick<CharacterPose, 'head' | 'headUp' | 'headForward'>,
                               out = new THREE.Vector3(), forward = pose.headForward): THREE.Vector3 {
  return out.copy(pose.head)
    .addScaledVector(pose.headUp, VIEW_FROM_HEAD_UP)
    .addScaledVector(forward, VIEW_FROM_HEAD_FORWARD);
}
/** How much an exact tracked head translates the pelvis. Feet remain on the bindings; the rest becomes torso
 * lean and stretch. This makes a physical crouch bend the legs without dragging both boots across the deck. */
const TRACKED_HIP_FOLLOW = 0.65;
const HIP_HALF = 0.11, SHOULDER_HALF = 0.165;
// A snowboard's bindings turn the pelvis with them: +15° front and −3° rear average 6° of open stance, and
// over a 22 cm socket span that carries the front hip this far toward the toe edge and the rear hip the same
// way back. Ski bindings have no such angle — both boots point where the skis do — so a skier's pelvis is
// square and this is zero (`gearSocketSkew`).
const SOCKET_SKEW = HIP_HALF * Math.sin(((BINDING_ANGLE_FRONT + BINDING_ANGLE_REAR) / 2) * D2R);
const gearSocketSkew = (gear: RideGear, stance: SnowboardStance) =>
  gear === 'skis' ? 0 : stance === 'standard' ? -SOCKET_SKEW : SOCKET_SKEW;
// A pop drives the hips this far above their standing height — stopping just inside REACH, so the legs come
// out nearly straight and the knee still never locks.
const POP_RISE = 0.105;
// The lean at which the rider is fully committed to an edge. Physics clamps its own steering short of 1, so
// the carve stance arrives before the input does and a hard turn holds a settled shape rather than a rising one.
const CARVE_FULL_LEAN = 0.85;
// How much of the coil a fully committed edge takes away. The legs are already spent holding the board over.
const CARVE_COIL_LIMIT = 0.55;

// How long a change of riding style takes to reach the body. Slower than an edge change: this is the rider
// settling into a different way of standing, not reacting to the mountain.
const STYLE_HALF_LIFE = 0.25;
// A rider keeps their eyes near the horizon instead of carrying the board's full edge angle into the neck.
// Grounded riding rejects most deck roll; in the air the head follows the body more closely.
const HEAD_UPRIGHT_GROUND = 0.8, HEAD_UPRIGHT_AIR = 0.35;
// The procedural gaze is a neck turn, not an independently swivelling camera. These are deliberately inside
// the anatomical extremes: a helmeted rider can comfortably check about 65° either side, look farther down at
// a landing than up into the sky, and reaches either target with a quick but visible ease instead of a snap.
// The solver-frame stop is half a degree inside the visible 65° envelope; spine/head-up are intentionally not
// identical under a landing lean, and that reserve keeps the rendered chest→face angle inside the promise.
const HEAD_LOOK_YAW_LIMIT = 64.5 * D2R;
const HEAD_LOOK_UP_LIMIT = 30 * D2R, HEAD_LOOK_DOWN_LIMIT = 45 * D2R;
const HEAD_LOOK_HALF_LIFE = 0.11, HEAD_LOOK_MAX_SPEED = 240 * D2R;
// A look farther around than the neck can comfortably carry recruits the upper torso. Snowboarders already
// stand across their travel, so this is the ordinary open-shouldered landing posture, not a special switch pose.
const HEAD_TORSO_SHARE_YAW = 55 * D2R, HEAD_TORSO_YAW_LIMIT = 45 * D2R;
const HEAD_TORSO_HALF_LIFE = 0.14, HEAD_TORSO_MAX_SPEED = 180 * D2R;
// The glance. Nobody stares down the nose for a whole run: once in a while on a calm stretch the head turns
// to check the mountain, holds a beat, and comes back down-course. Every property of one is a
// fresh draw — the wait is memoryless (a capped exponential: usually a few seconds, sometimes a quick
// double-take, occasionally a long quiet spell, never metronomic) and the side, size and hold are uniform.
// It is pure presentation, gated on actually travelling — a parked rider, and with it every headless fixture,
// never glances. Anything that reclaims the eyes (a committed edge, a tuck or a pop, leaving the snow)
// interrupts one early.
const GLANCE_WAIT_MEAN = 6;                       // seconds of calm riding between glances, on average
const GLANCE_WAIT_CAP = 20;                       // bounds the quiet spells, and gives the test a worst case
const GLANCE_YAW_MIN = 15 * D2R, GLANCE_YAW_MAX = 65 * D2R; // the look's size; its side is a coin flip
const GLANCE_HOLD_MIN = 0.35, GLANCE_HOLD_MAX = 1.4; // seconds spent on the target before easing back
const GLANCE_TURN = 0.09, GLANCE_YIELD = 0.045;   // half-lives: the look itself / the interrupted snap back
const GLANCE_SPEED = 4;                           // m/s of travel below which there is nothing worth checking
const GLANCE_LEAN_MAX = 0.45, GLANCE_CROUCH_MAX = 0.6;
/**
 * How the rider stands on an edged board.
 *
 * The reference the body argues with is **apparent** gravity — the pull minus the board's own acceleration, the
 * direction a plumb bob riding along would hang. Traversing at steady speed nothing accelerates, apparent
 * gravity IS gravity, and the rider stands upright off the tilted deck. Accelerating down the fall line the
 * rider is already partly falling, what remains of the pull points out of the slope, and square to the deck IS
 * balanced. A carve's v²/r tilts the pull into the turn so the lean is supported; a brake or a boost leans the
 * body back or forward against the same term. Free fall has no apparent weight (`weight` → 0 kills the blend),
 * so an off-axis flight stays compactly square to the deck. The acceleration is taken through `BALANCE_LEAD` of
 * smoothing — a body re-stacks in a quarter second, so a landing spike firms the stance, never snaps it.
 *
 * But the *whole body* cannot follow that reference, because the feet are strapped down: ankles, knees and hips
 * are a triangle built on the deck, and legs cannot pivot fore/aft on bound feet. So the argument is split at
 * the waist. The hips take only `RIDER_UPRIGHT_HIPS` of the apparent tilt — they ride the terrain, which keeps
 * the legs quiet through carve flurries — while the chest target takes `RIDER_UPRIGHT_CHEST`, so the uprighting
 * is a fold at the waist, not a swing of the column. Fore/aft the same lean arrives the only way anatomy has:
 * `HIP_SHIFT` slides the hips along the board with the apparent tilt, which through the leg IK *is* the front
 * or back knee bending deeper — lean back and the rear knee folds, lean forward and the front one does.
 *
 * This is the response to what the *terrain and the physics* are doing, and it runs underneath every stance.
 * The stance's own `angulation` then folds the spine on top of it, so a carve's authored shape and the body's
 * balance argument compose instead of one overriding the other.
 */
const RIDER_UPRIGHT_HIPS = 0.2, RIDER_UPRIGHT_CHEST = 0.65;
const BALANCE_LEAD = 0.25, HIP_SHIFT = 0.12;
// Anatomy's stop on the argument: a torso cannot fold further than this off the legs' own axis, however hard
// contact acceleration can swing the apparent direction on an ordinary carve.
const BALANCE_TILT_MAX = 45 * D2R;
/**
 * Limb dimensions, in metres of *rider* — not of stick. A jacket, snow pants, a helmet and gloves are all worn
 * rather than modelled: a jacketed torso is 23 cm across, a helmeted head 27, a mitt 13. The leg does **not**
 * taper, because snow pants do not: they are the same shell as the jacket, and a 20 cm leg is what that shell
 * makes of a calf.
 */
const LEG_R = 0.10, PELVIS_R = 0.115;
const LOWER_TORSO_R = 0.105, UPPER_TORSO_R = 0.125, CLAVICLE_R = 0.065;
const NECK_R = 0.07, HEAD_R = 0.135;
const UPPER_ARM_R = 0.058, FOREARM_R = 0.048, HAND_R = 0.065;
const HIP_JOINT_R = 0.112, KNEE_R = 0.102, SHOULDER_R = 0.085, ELBOW_R = 0.06;
/**
 * The absorber, and the reason the figure is here at all.
 *
 * The hips carry the deck's velocity **along the surface** exactly, so 27 m/s of travel costs them no lag at
 * all; what they do *not* carry, while the board is on the ground, is its motion along the spine — that is the
 * entire budget of a rider's legs. The offset it opens up decays at `ABSORB_NORMAL`, slow enough that the
 * contact's few-Hz transients — pushout steps, facet chatter on a reference mesh — reach the head at a fifth of
 * their amplitude, fast enough that a real terrain roll (a rad/s, not tens) passes straight through. Sideways drift is pulled back in at `ABSORB_TANGENT`, so
 * the rider never slides off the board.
 *
 * Airborne there is no contact force and nothing to absorb: the rider falls on the board's own parabola, so the
 * hips carry the *whole* velocity and never float off the deck. What survives touchdown is the rider's momentum —
 * the pushout stops the deck in one tick, the hips do not, and `ABSORB_LAND` is how long they go on carrying the
 * speed they arrived with. That is the knee compression, and it grades: a 2 m/s bump-skip bends them 2 cm, the
 * 6.3 m/s ollie floor 7 cm, and past ~11 m/s they bottom out on `HIP_LEASH`. Its displacement is integrated
 * analytically because at 15 ms the decay is barely a frame long — a per-frame multiply would make the frame
 * rate part of the landing.
 *
 * The crouch is applied *after* the absorber, never through it — an ollie pop has to be instant.
 */
const ABSORB_NORMAL = 0.20, ABSORB_TANGENT = 0.05, ABSORB_LAND = 0.015, HIP_LEASH = 0.12;
// Stances take time to cross. A 140 ms half-life reaches 90% in 0.47 s: about as long as a rider takes to move
// from one edge to the other, and slow enough that the long arm arcs cannot whip on a reversal.
const TURN_POSE_HALF_LIFE = 0.14;
/**
 * The arms, which are the one part of the rider carrying no load — so they are the part that simply obeys the
 * board. A mass hanging in the deck's accelerating frame feels the pseudo-force `−a`, and that single term is
 * every case at once: standing still `a` is zero and the arms hang; in the air `a` **is** gravity, so `−a` points
 * a full g upward and they float; a landing spikes `a` upward and drives the hands down; a carve accelerates into
 * the turn and throws them out of it; a boost pushes them back and a brake swings them forward. Nothing here
 * tests for a jump or a landing.
 *
 * `ARM_GAIN` is the share of that force the hands take rather than the shoulders. `ARM_LEAD` is the shoulder
 * declining to be a rigid link: it hands a shove to the hand over about a tenth of a second, which is also what
 * keeps the contact's few-Hz transients from reaching the gloves. The spring under it (`ARM_FREQ`, `ARM_DAMP`)
 * is the rider putting the arms back where he keeps them, and `ARM_TRAVEL` is the shoulder's stop — a landing
 * hard enough to reach it stops there and does not bounce off it.
 */
const ARM_GAIN = 0.27, ARM_LEAD = 0.09, ARM_FREQ = 1.35, ARM_DAMP = 0.7, ARM_TRAVEL = 0.15;
const ARM_STEP_MAX = 1 / 30;               // the sway is a spring, not a filter: a hitched frame must not blow it up
const ARM_REACH = (UPPER_ARM + FOREARM) * 0.998;
// TRACKED ARMS (VR). The elbow pole in the WEARER's frame — down the spine, a little behind, a little out — and
// how far out in front both hands must be held before they, rather than the gaze, say where the chest points.
// A controller→arm assignment holds until the other pairing is shorter by this much (m², both arms summed).
const TRACKED_ELBOW_BACK = 0.45, TRACKED_ELBOW_OUT = 0.35;
const WEARER_HANDS_REACH = 0.30;
const HAND_ASSIGN_HYSTERESIS = 0.04;
// On-foot presentation is deliberately independent of the selected snowboard stance. These are ordinary
// relaxed-human dimensions: feet below the hips, a modest stride, toes facing travel and arms counter-swinging.
const WALK_STANCE_HALF = 0.105, WALK_HIP_HEIGHT = 0.81;
const WALK_STRIDE = 0.22, WALK_LIFT = 0.085, WALK_BOB = 0.018, WALK_ARM_SWING = 0.17;
const WALK_TURN_STEP = 0.13;
const WALK_GAIT_DROP = 0.08, WALK_CROUCH_DROP = 0.26, WALK_CROUCH_LEAN = 0.08;

/** A tracked hand origin in world space. Its canonical local +Y points toward the fingers and local +Z points
 * out of the palm. Optical tracking supplies a wrist; controller tracking supplies WebXR's palm-centred grip. */
export interface RiderHandTarget {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  source?: 'hand' | 'grip';
  handedness?: 'left' | 'right';
  /** Controller-driven digit curls. Optical hand tracking currently leaves the bind/open pose intact. */
  curl?: CharacterHandCurl;
}

export interface RiderInput {
  /** Ankle joints in world space, rigid on the board. */
  ankleFront: THREE.Vector3;
  ankleRear: THREE.Vector3;
  /** The surface the deck sits on (unit, world). Both the stance and the axis the deck bobs along. */
  deckUp: THREE.Vector3;
  /** The visible board's top normal after its carve bank has been applied. */
  soleUp: THREE.Vector3;
  /** The deck's carve roll in degrees, signed as the drawn board takes it. */
  bank: number;
  /** The board's world velocity — fed forward so travel costs the hips no lag. */
  vel: THREE.Vector3;
  /** The board's world acceleration (m/s²) — every one of it the arms swing against. */
  accel: THREE.Vector3;
  /** The end of the board currently travelling downhill, including switch and visible flip orientation. The
   *  body stance may face either side of a snowboard; this is the independent direction the face looks. */
  rideForward?: THREE.Vector3;
  /** Where the untracked rider would like to look in world space. Pose supplies the carve-ahead or predicted
   *  landing direction; the neck solver eases toward it and applies its own anatomical yaw/pitch limits. */
  lookForward?: THREE.Vector3;
  /** In the air the legs have nothing to absorb; on the ground they have everything. */
  grounded: boolean;
  dt: number;
  /** −1 = legs driving through a pop, 0 = standing tall, 1 = fully coiled. */
  crouch: number;
  /** The carve lean, −1..1: picks the edge and how far the stance is committed to it. Negative is the heel
   *  edge, positive the toes, and `CARVE_FULL_LEAN` is where the stance arrives in full. */
  lean: number;
  /** Standard on-foot stance and gait. `facing` is the body's world-space forward axis; `phase` is radians and
   * `weight` blends continuously from a neutral stand to a full walk cycle. Superman flight holds the legs in
   * that neutral stance regardless of airspeed; tracked hands and the rest of the upper body remain live. */
  locomotion?: {
    phase: number; weight: number; facing: THREE.Vector3; turn?: number; flying?: boolean;
  } | null;
  /**
   * TRACKED HANDS (docs/048), world space, or absent — which is every ride but a VR one.
   *
   * With them, the stance stops deciding where the hands are and the rider's own arms go where the wearer's are:
   * the two positions replace the rest+sway targets and are hard constraints for the same two-bone IK that
   * already followed the gloves. If animation puts a shoulder beyond reach, the shoulder girdle yields toward
   * the tracked wrist; the physical hand never leaves its controller. Which controller is the LEAD arm is not
   * assumed — a rider stands sideways and may be regular, goofy or switch — so each is assigned to the shoulder
   * it is actually nearer, and that pairing is then HELD until the other one is clearly shorter: two hands
   * brought together in front of the chest are equidistant from both shoulders and would otherwise flap
   * between the arms frame by frame.
   */
  handTargets?: { a: RiderHandTarget; b: RiderHandTarget } | null;
  /** Held desktop pointing gestures. `target` is the exact pressed world point when one was hit; old peers can
   * still supply only the captured ray direction. One entry per anatomical hand allows a two-button chord. */
  pointTargets?: readonly {
    hand: 'left' | 'right'; direction: THREE.Vector3; target?: THREE.Vector3; weight: number;
  }[] | null;
  /** Tracked/camera head in world space. With `exactPosition`, position is the VR viewpoint between the eyes,
   * not the helmet centre, and the whole upper body is the wearer's: the torso is rebuilt beneath the skull and
   * the shoulder line is built across where the WEARER faces (gaze plus held-out hands, `resolveWearerFacing`)
   * rather than across the deck. Without it only quaternion is used. Absent keeps the authored riding glance. */
  headTarget?: { position: THREE.Vector3; quaternion: THREE.Quaternion; exactPosition?: boolean } | null;
}

export interface Rider {
  group: THREE.Group;
  pose(i: RiderInput): void;
  /** Snap the absorber onto the pose — a respawn must not drag the hips across the mountain. */
  reset(i: RiderInput): void;
  /** Hand the rider a different way of standing, live. The body crosses to it over `STYLE_HALF_LIFE`; nothing
   *  is rebuilt, so the absorber, the arm sway and the glance keep the state they are in. */
  setStyle(id: string): void;
  /** Draw this body from inside its own head (docs/048) — everything but the head, which the eyes are in. */
  setFirstPerson(on: boolean): void;
  /** @internal The live solved landmarks a skinned character is driven from. Exposed so a check can drive a
   *  real rig with a real stance instead of a hand-built pose, which is the only way to measure what the
   *  retargeting actually does to a joint. */
  readonly solved: CharacterPose;
  dispose(): void;
}

/** Pull `p` back onto the sphere of radius `r` about `c`. Used where the endpoint is presentation-owned. */
function reachTo(p: THREE.Vector3, c: THREE.Vector3, r: number) {
  const d = _k1.copy(p).sub(c);
  if (d.lengthSq() > r * r) p.copy(c).add(d.setLength(r));
}

/**
 * Keep an arm anatomical without moving an externally tracked wrist. A controller/optical wrist is a physical
 * fact, so when the animated torso leaves it outside the avatar's reach the shoulder girdle gives toward the
 * wrist. Pulling the wrist toward the animation instead is the conspicuous VR failure: a glove floating away
 * from the controller precisely when a carve, crouch, or landing moves the body most.
 */
function resolveArmReach(shoulder: THREE.Vector3, hand: THREE.Vector3,
                         tracked: RiderHandTarget | null) {
  if (!tracked) { reachTo(hand, shoulder, ARM_REACH); return; }
  const wristToShoulder = _k1.copy(shoulder).sub(hand);
  if (wristToShoulder.lengthSq() > ARM_REACH * ARM_REACH) {
    shoulder.copy(hand).add(wristToShoulder.setLength(ARM_REACH));
  }
}

/**
 * Two-bone IK, serving both a leg and an arm. Given the `root` and the `tip`, place the middle joint on the
 * circle the cosine rule allows, swung toward `pole`: the toe edge for a knee, so it bends over the toes like a
 * rider's does, and the arm's own resting elbow for an elbow, so a swaying hand does not spin it about the arm.
 */
function solveJoint(root: THREE.Vector3, tip: THREE.Vector3, upper: number, lower: number,
                    pole: THREE.Vector3, out: THREE.Vector3) {
  const dir = _k1.copy(tip).sub(root);
  const d = dir.length();
  if (d < 1e-5) dir.set(0, -1, 0); else dir.divideScalar(d);
  const reach = clamp(d, Math.abs(upper - lower) + 1e-3, upper + lower - 1e-3);
  const cosA = (upper * upper + reach * reach - lower * lower) / (2 * upper * reach);
  const a = Math.acos(clamp(cosA, -1, 1));
  const perp = _k2.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (perp.lengthSq() < 1e-8) perp.set(dir.y, -dir.x, 0);
  perp.normalize();
  out.copy(root).addScaledVector(dir, upper * Math.cos(a)).addScaledVector(perp, upper * Math.sin(a));
}

/**
 * One arm bone's rest direction, in the torso's own frame: `drop` degrees off hanging straight down the spine,
 * swung `swing` degrees around from noseward (90° is over the toe edge). This is how a rider describes where
 * they keep their hands, and it is the only thing that places the arms below.
 */
function armDir(out: THREE.Vector3, drop: number, swing: number,
                spine: THREE.Vector3, along: THREE.Vector3, toeward: THREE.Vector3) {
  const d = drop * D2R, s = swing * D2R, lateral = Math.sin(d);
  return out.set(0, 0, 0).addScaledVector(spine, -Math.cos(d))
    .addScaledVector(along, lateral * Math.cos(s))
    .addScaledVector(toeward, lateral * Math.sin(s)).normalize();
}

/**
 * Where a TRACKED arm's elbow points, in the wearer's own frame: down the spine, a little behind, a little out
 * (`side` = +1 for the front arm, −1 for the rear, `outward` being the shoulder line toward the front arm).
 * One pole serves every hold because the two-bone solve projects it off the shoulder→hand chord: a hand hanging
 * at the side loses the downward part and the elbow sits back and out; a controller held out in front loses
 * the backward part and the elbow hangs beneath the arm; a hand raised overhead keeps back and out. The
 * authored poles cannot do this — on foot the rest pole points straight BEHIND, which is antiparallel to a
 * controller held out in front, where the solve has no side to pick and the elbow snaps between the two; on
 * the board the rest poles live in the deck's frame, which a tracked torso no longer shares.
 */
function trackedElbowPole(out: THREE.Vector3, spine: THREE.Vector3, facing: THREE.Vector3,
                          outward: THREE.Vector3, side: 1 | -1) {
  return out.copy(spine).multiplyScalar(-1).addScaledVector(facing, -TRACKED_ELBOW_BACK)
    .addScaledVector(outward, side * TRACKED_ELBOW_OUT);
}

export function createRider(modelId = DEFAULT_RIDER_MODEL_ID, styleId: string = DEFAULT_RIDING_STYLE,
                            gear: RideGear = DEFAULT_RIDE_GEAR,
                            snowboardStance: SnowboardStance = DEFAULT_SNOWBOARD_STANCE): Rider {
  const skis = gear === 'skis';
  const socketSkew = gearSocketSkew(gear, snowboardStance);
  const group = new THREE.Group();
  const procedural = new THREE.Group();
  procedural.name = 'rider.procedural';
  group.add(procedural);
  // Unit shells span y ∈ [0,1]. Limbs use a constant cylinder; the two jacket sections taper from waist to
  // chest so the visible body follows the recovered back chain instead of reading as another stick bone.
  const boneGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true).translate(0, 0.5, 0);
  const lowerTorsoGeo = new THREE.CylinderGeometry(1.14, 1, 1, 10, 1, false).translate(0, 0.5, 0);
  const upperTorsoGeo = new THREE.CylinderGeometry(1.20, 0.96, 1, 10, 1, false).translate(0, 0.5, 0);
  const jointGeo = new THREE.SphereGeometry(1, 10, 8);
  const faceGeo = new THREE.SphereGeometry(1, 8, 6);
  const mouthGeo = new THREE.BoxGeometry(1, 1, 1);
  const headphoneBandGeo = new THREE.TorusGeometry(0.145, 0.012, 6, 24, Math.PI);
  const jacket = new THREE.MeshLambertMaterial({ color: 0x2b5c3b });
  const pants = new THREE.MeshLambertMaterial({ color: 0x6b4b30 });
  const helmet = new THREE.MeshLambertMaterial({ color: 0x3c4149 });
  const gloves = new THREE.MeshLambertMaterial({ color: 0x22262e });
  const eyeWhite = new THREE.MeshLambertMaterial({ color: 0xf4f7f7 });
  const headphone = new THREE.MeshLambertMaterial({ color: 0xf0a23a });

  const bone = (mat: THREE.Material, geo = boneGeo) => { const m = new THREE.Mesh(geo, mat); procedural.add(m); return m; };
  const joint = (mat: THREE.Material, r: number) => {
    const m = new THREE.Mesh(jointGeo, mat); m.scale.setScalar(r); procedural.add(m); return m;
  };
  const landmark = () => { const node = new THREE.Object3D(); procedural.add(node); return node; };

  const thighF = bone(pants), thighR = bone(pants), shinF = bone(pants), shinR = bone(pants);
  const pelvis = bone(pants), lowerTorso = bone(jacket, lowerTorsoGeo), upperTorso = bone(jacket, upperTorsoGeo);
  const clavicleF = bone(jacket), clavicleR = bone(jacket);
  const neck = bone(jacket);
  const upperF = bone(jacket), foreF = bone(jacket), upperR = bone(jacket), foreR = bone(jacket);
  const hipJF = joint(pants, HIP_JOINT_R), hipJR = joint(pants, HIP_JOINT_R);
  const kneeF = joint(pants, KNEE_R), kneeR = joint(pants, KNEE_R);
  const shJF = joint(jacket, SHOULDER_R), shJR = joint(jacket, SHOULDER_R);
  const elbF = joint(jacket, ELBOW_R), elbR = joint(jacket, ELBOW_R);
  const gloveF = joint(gloves, HAND_R), gloveR = joint(gloves, HAND_R);
  // A flattened palm makes wrist roll visible on the procedural fallback too. Local +Y follows the fingers;
  // local +Z is the palm normal, the same canonical frame handed to imported character bones below.
  gloveF.scale.set(HAND_R * 0.78, HAND_R * 1.48, HAND_R * 0.46);
  gloveR.scale.copy(gloveF.scale);
  // The head is a real oriented frame rather than an unmarked sphere. Local +Y is head-up and +Z is gaze, so
  // the face and headphones make unwanted roll/yaw immediately visible while tuning the ride pose.
  const head = new THREE.Group(); procedural.add(head);
  const helmetShell = new THREE.Mesh(jointGeo, helmet); helmetShell.scale.setScalar(HEAD_R); head.add(helmetShell);
  const eyeL = new THREE.Mesh(faceGeo, eyeWhite), eyeR = new THREE.Mesh(faceGeo, eyeWhite);
  const pupilL = new THREE.Mesh(faceGeo, gloves), pupilR = new THREE.Mesh(faceGeo, gloves);
  eyeL.position.set(-0.045, 0.025, 0.124); eyeR.position.set(0.045, 0.025, 0.124);
  eyeL.scale.set(0.021, 0.017, 0.010); eyeR.scale.copy(eyeL.scale);
  pupilL.position.set(-0.045, 0.025, 0.134); pupilR.position.set(0.045, 0.025, 0.134);
  pupilL.scale.set(0.009, 0.010, 0.006); pupilR.scale.copy(pupilL.scale);
  const mouth = new THREE.Mesh(mouthGeo, gloves);
  mouth.position.set(0, -0.045, 0.128); mouth.scale.set(0.057, 0.010, 0.009);
  const headphoneL = new THREE.Mesh(faceGeo, headphone), headphoneR = new THREE.Mesh(faceGeo, headphone);
  headphoneL.position.set(-0.145, 0, 0); headphoneR.position.set(0.145, 0, 0);
  headphoneL.scale.set(0.025, 0.043, 0.021); headphoneR.scale.copy(headphoneL.scale);
  const headphoneBand = new THREE.Mesh(headphoneBandGeo, headphone);
  head.add(eyeL, eyeR, pupilL, pupilR, mouth, headphoneL, headphoneR, headphoneBand);
  const hipsRootJ = landmark(), upperBackJ = landmark(), clavicleRootJ = landmark(), headBoneJ = landmark();

  // Stable names make a live pose inspectable without relying on child order.
  for (const [node, name] of [
    [thighF, 'thigh-front'], [thighR, 'thigh-rear'], [shinF, 'shin-front'], [shinR, 'shin-rear'],
    [pelvis, 'pelvis'], [lowerTorso, 'torso-lower'], [upperTorso, 'torso-upper'],
    [clavicleF, 'clavicle-front'], [clavicleR, 'clavicle-rear'], [neck, 'neck'],
    [upperF, 'upper-arm-front'], [foreF, 'forearm-front'], [upperR, 'upper-arm-rear'], [foreR, 'forearm-rear'],
    [hipJF, 'hip-front'], [hipJR, 'hip-rear'], [kneeF, 'knee-front'], [kneeR, 'knee-rear'],
    [shJF, 'shoulder-front'], [shJR, 'shoulder-rear'], [elbF, 'elbow-front'], [elbR, 'elbow-rear'],
    [gloveF, 'hand-front'], [gloveR, 'hand-rear'], [head, 'head'], [helmetShell, 'helmet'],
    [eyeL, 'eye-left'], [eyeR, 'eye-right'], [pupilL, 'pupil-left'], [pupilR, 'pupil-right'], [mouth, 'mouth'],
    [headphoneL, 'headphone-left'], [headphoneR, 'headphone-right'], [headphoneBand, 'headphone-band'],
    [hipsRootJ, 'hips'], [upperBackJ, 'upper-back'], [clavicleRootJ, 'clavicle-root'], [headBoneJ, 'head-bone'],
  ] as const) node.name = `rider.${name}`;

  const anchor = new THREE.Vector3();  // the absorbed ankle-line midpoint: the deck, with its buzz taken out
  const balanceAccel = new THREE.Vector3(); // the smoothed board acceleration the body re-stacks against
  const hipPos = new THREE.Vector3();
  const sway = new THREE.Vector3();    // world offset of both hands from where the rider keeps them
  const swayVel = new THREE.Vector3();
  const drive = new THREE.Vector3();   // the pseudo-force, as the shoulder passes it on: lagged, never instant
  const headBasis = new THREE.Matrix4();
  const handBasis = new THREE.Matrix4(), handAcross = new THREE.Vector3();
  const handFrontFinger = new THREE.Vector3(), handFrontPalm = new THREE.Vector3();
  const handRearFinger = new THREE.Vector3(), handRearPalm = new THREE.Vector3();
  const ankleFront = new THREE.Vector3(), ankleRear = new THREE.Vector3();
  let carriedVN = 0;                   // the normal speed the hips are still carrying: the landing's momentum
  let seated = false;
  let poseLean = 0, poseBank = 0;      // stance response; physics and the deck remain immediate
  // The live blend and, while a style change is crossing, the stance being left behind. Both are rewritten in
  // place every frame. `styleCross` reaches 1 once the body has arrived and the outgoing style stops being read.
  let style: RidingStyle = ridingStyle(styleId, gear);
  let outgoingStyle: RidingStyle = style;
  let styleCross = 1;
  const stance: Stance = { ...style.neutral };
  const outgoing: Stance = { ...style.neutral };
  // The occasional look around: eased amount, its signed yaw, time left on target, time until the next may
  // begin. Each rider draws its own waits, so a field of riders checks the mountain out of step.
  const drawGlanceWait = () =>
    Math.min(-GLANCE_WAIT_MEAN * Math.log(1 - Math.random()), GLANCE_WAIT_CAP);
  let glance = 0, glanceYaw = 0, glanceHold = 0, glanceWait = drawGlanceWait();
  let lookYaw = 0, lookPitch = 0, torsoLookYaw = 0;
  // TRACKED UPPER BODY (VR): the wearer's facing, remembered so a gaze pitched straight down keeps last frame's
  // torso instead of spinning it, and the controller→arm pairing, held with hysteresis (`assignTrackedWrists`).
  const wearerFacing = new THREE.Vector3();
  let haveWearerFacing = false;
  let trackedAssigned = false, trackedCrossed = false;

  // These are the same solved landmarks that place the procedural body below. Keeping one shared pose object
  // lets the skinned rider follow the existing solver without allocating on every animation frame.
  const characterPose: CharacterPose = {
    feet: skis ? 'forward' : 'bindings',
    bindingFront: (snowboardStance === 'standard' ? -BINDING_ANGLE_REAR : BINDING_ANGLE_FRONT) * D2R,
    bindingRear: (snowboardStance === 'standard' ? -BINDING_ANGLE_FRONT : BINDING_ANGLE_REAR) * D2R,
    hips: hipPos, upperBack: _j11, clavicleRoot: _j12, headBone: _j13, head: _j7,
    hipFront: _j2, kneeFront: _n1, ankleFront,
    hipRear: _j8, kneeRear: _n2, ankleRear,
    shoulderFront: _j5, elbowFront: _a1, handFront: _a2,
    shoulderRear: _j6, elbowRear: _a3, handRear: _a4,
    handFrontFinger, handFrontPalm, handRearFinger, handRearPalm,
    handFrontCurl: null, handRearCurl: null,
    handFrontTracked: false, handRearTracked: false,
    up: _f4, toe: _f5, along: _f6, headUp: _h1, headForward: _h2, soleUp: _f15,
  };
  const character = attachCharacterRig(group, procedural, modelId);
  const trackedWristA = new THREE.Vector3(), trackedWristB = new THREE.Vector3();
  const gripOffsetA = new THREE.Vector3(), gripOffsetB = new THREE.Vector3();

  /** Optical hand tracking already gives a wrist. A controller gives the source-of-truth grip in the palm, so
   * seat this avatar's wrist behind it only after calibration has established the anatomical hand frame. */
  function trackedWrist(target: RiderHandTarget, out: THREE.Vector3, offset: THREE.Vector3) {
    out.copy(target.position);
    if (target.source === 'grip' && target.handedness) {
      out.add(character.gripToWrist(target.handedness, target.quaternion, offset));
    }
    return out;
  }

  /**
   * Where the WEARER's chest points, for an exactly tracked upper body — the axis the shoulder line is built
   * across, on the board and on foot alike. Unit, in the plane square to `up`.
   *
   * The deck is the wrong reference on a board. The VR seat is pinned for comfort: on snow it carries a quarter
   * of a stick turn and none of the gaze steer (`XR_GROUND_STICK_VIEW_CARRY`), so the board routinely swings
   * 60–120° under a wearer whose body has not turned at all. Shoulders built across that deck sweep away from
   * the controllers through every carve, and past 90° each hand is nearer the OTHER shoulder, at which point
   * the two arms swap controllers — a jump of the whole distance between the hands, on every turn.
   *
   * The `baseline` is where the wearer's body is known to face: on foot the gait's facing, which already IS the
   * headset's yaw and also owns the hips and legs, so the torso cannot twist against them; on the board there
   * is no such thing and the headset's horizontal gaze stands in (null). Hands held out in front then pull the
   * chest round toward them by how far out they are, measured from the headset itself — the one tracked point
   * that is certainly the wearer's centre — so someone looking over their shoulder in a carve keeps their chest
   * behind their hands, which is what a torso does. Hands hanging or raised overhead project to nothing
   * horizontal and leave the baseline alone; a gaze pitched straight down with no hands out keeps the previous
   * frame's facing rather than spinning the torso on numerical noise.
   */
  function resolveWearerFacing(out: THREE.Vector3, i: RiderInput, up: THREE.Vector3,
                               baseline: THREE.Vector3 | null, fallback: THREE.Vector3): THREE.Vector3 {
    const head = i.headTarget!;
    if (baseline) out.copy(baseline); else out.set(0, 0, -1).applyQuaternion(head.quaternion);
    out.addScaledVector(up, -out.dot(up));
    if (out.lengthSq() > 1e-6) out.normalize(); else out.set(0, 0, 0);
    if (i.handTargets) {
      const held = _w1.copy(trackedWristA).add(trackedWristB).multiplyScalar(0.5).sub(head.position);
      held.addScaledVector(up, -held.dot(up));
      const reach = held.length();
      if (reach > 1e-4) out.addScaledVector(held, clamp(reach / WEARER_HANDS_REACH, 0, 1) / reach);
    }
    if (out.lengthSq() < 1e-6) out.copy(haveWearerFacing ? wearerFacing : fallback);
    out.addScaledVector(up, -out.dot(up));
    if (out.lengthSq() < 1e-8) out.copy(fallback).addScaledVector(up, -fallback.dot(up));
    if (out.lengthSq() < 1e-8) out.set(0, 0, 1);
    out.normalize();
    wearerFacing.copy(out);
    haveWearerFacing = true;
    return out;
  }

  /**
   * Which tracked wrist each arm takes: true when `b` goes to the FRONT arm. First decided by which pairing is
   * shorter, then held until the other pairing is shorter by `HAND_ASSIGN_HYSTERESIS`, so two hands brought
   * together — equidistant from both shoulders, and jittering — cannot flap the arms between controllers. A
   * wearer who really crosses their hands still crosses the arms: that pairing is shorter by far more.
   */
  function assignTrackedWrists(shF: THREE.Vector3, shR: THREE.Vector3): boolean {
    const straight = trackedWristA.distanceToSquared(shF) + trackedWristB.distanceToSquared(shR);
    const crossed = trackedWristB.distanceToSquared(shF) + trackedWristA.distanceToSquared(shR);
    if (!trackedAssigned) { trackedCrossed = crossed < straight; trackedAssigned = true; }
    else if (trackedCrossed ? straight < crossed - HAND_ASSIGN_HYSTERESIS
      : crossed < straight - HAND_ASSIGN_HYSTERESIS) trackedCrossed = !trackedCrossed;
    return trackedCrossed;
  }

  /** Point a bone from `a` to `b` with radius `r`. */
  const link = (m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, r: number) => {
    const d = _b1.copy(b).sub(a);
    const len = d.length() || 1e-5;
    m.position.copy(a);
    m.quaternion.setFromUnitVectors(UNIT_Y, d.divideScalar(len));
    m.scale.set(r, len, r);
  };

  /** Draw the already-solved landmarks through both the procedural body and an optional imported character. */
  function drawSolved() {
    const p = characterPose;
    link(thighF, p.hipFront, p.kneeFront, LEG_R); link(shinF, p.kneeFront, p.ankleFront, LEG_R);
    link(thighR, p.hipRear, p.kneeRear, LEG_R); link(shinR, p.kneeRear, p.ankleRear, LEG_R);
    link(pelvis, p.hipRear, p.hipFront, PELVIS_R);
    link(lowerTorso, p.hips, p.upperBack, LOWER_TORSO_R);
    link(upperTorso, p.upperBack, p.clavicleRoot, UPPER_TORSO_R);
    link(clavicleF, p.clavicleRoot, p.shoulderFront, CLAVICLE_R);
    link(clavicleR, p.clavicleRoot, p.shoulderRear, CLAVICLE_R);
    link(neck, p.clavicleRoot, p.head, NECK_R);
    link(upperF, p.shoulderFront, p.elbowFront, UPPER_ARM_R);
    link(foreF, p.elbowFront, p.handFront, FOREARM_R);
    link(upperR, p.shoulderRear, p.elbowRear, UPPER_ARM_R);
    link(foreR, p.elbowRear, p.handRear, FOREARM_R);
    hipJF.position.copy(p.hipFront); hipJR.position.copy(p.hipRear);
    kneeF.position.copy(p.kneeFront); kneeR.position.copy(p.kneeRear);
    shJF.position.copy(p.shoulderFront); shJR.position.copy(p.shoulderRear);
    elbF.position.copy(p.elbowFront); elbR.position.copy(p.elbowRear);
    gloveF.position.copy(p.handFront); gloveR.position.copy(p.handRear);
    orientHandMesh(gloveF, p.handFrontFinger, p.handFrontPalm);
    orientHandMesh(gloveR, p.handRearFinger, p.handRearPalm);
    head.position.copy(p.head);
    const headRight = _h3.crossVectors(p.headUp, p.headForward);
    if (headRight.lengthSq() < 1e-8) headRight.set(1, 0, 0); else headRight.normalize();
    head.quaternion.setFromRotationMatrix(headBasis.makeBasis(headRight, p.headUp, p.headForward));
    hipsRootJ.position.copy(p.hips); upperBackJ.position.copy(p.upperBack);
    clavicleRootJ.position.copy(p.clavicleRoot); headBoneJ.position.copy(p.headBone);
    character.pose(p);
  }

  /** Orient a procedural palm in the same +Y fingers / +Z palm frame the skinned hand bones receive. */
  function orientHandMesh(mesh: THREE.Object3D, fingers: THREE.Vector3, palm: THREE.Vector3) {
    handAcross.crossVectors(fingers, palm);
    if (handAcross.lengthSq() < 1e-8) handAcross.set(1, 0, 0); else handAcross.normalize();
    palm.crossVectors(handAcross, fingers).normalize();
    mesh.quaternion.setFromRotationMatrix(handBasis.makeBasis(handAcross, fingers, palm));
  }

  /**
   * Resolve a hand frame after the arm IK has clamped its position. A tracked wrist owns its orientation; an
   * authored/resting hand continues the forearm and takes the roll below.
   *
   * `palm` is the direction the palm FACES, and a resting one faces DOWN. It used to be handed the body's up
   * axis, which is the same vector pointing the wrong way: it put every character's palms skyward, riding and
   * walking alike, which is a pose nobody adopts.
   *
   * Down alone is not enough, because for a hanging arm "down" runs along the forearm and cannot be a palm
   * normal at all — projected out just below, it would leave the degenerate fallback to pick a world axis. So
   * the reference also leans toward the body's midline, and the two cases fall out of the one expression: an
   * arm held out keeps the downward part and rests palm-down, while an arm hanging at the side loses it and
   * keeps the medial part, ending with its palm toward the thigh. Which is what a relaxed arm does.
   */
  function resolveHandFrame(fingers: THREE.Vector3, palm: THREE.Vector3,
                            elbow: THREE.Vector3, hand: THREE.Vector3,
                            tracked: RiderHandTarget | null, bodyUp: THREE.Vector3,
                            midline: THREE.Vector3) {
    if (tracked) {
      fingers.set(0, 1, 0).applyQuaternion(tracked.quaternion);
      palm.set(0, 0, 1).applyQuaternion(tracked.quaternion);
    } else {
      fingers.copy(hand).sub(elbow);
      _palmIn.copy(midline).sub(hand);
      _palmIn.addScaledVector(bodyUp, -_palmIn.dot(bodyUp)); // horizontal, from this hand toward the spine
      if (_palmIn.lengthSq() < 1e-8) _palmIn.set(0, 0, 0); else _palmIn.normalize();
      palm.copy(bodyUp).multiplyScalar(-1).addScaledVector(_palmIn, PALM_MEDIAL);
    }
    if (fingers.lengthSq() < 1e-8) fingers.set(0, -1, 0); else fingers.normalize();
    palm.addScaledVector(fingers, -palm.dot(fingers));
    if (palm.lengthSq() < 1e-8) {
      palm.set(0, 1, 0).addScaledVector(fingers, -fingers.y);
      if (palm.lengthSq() < 1e-8) palm.set(0, 0, 1).addScaledVector(fingers, -fingers.z);
    }
    palm.normalize();
  }

  /** A normal biped stance. The ride solver's front/rear bindings become anatomical left/right here, with the
   * body-facing axis supplied independently so the feet can stand side-by-side instead of astride a board. */
  function placeOnFoot(i: RiderInput) {
    const gait = i.locomotion!;
    seated = false; // the next mounted frame is a fresh board seat, with no stale absorber momentum
    characterPose.feet = 'forward';

    const up = _f4.copy(WORLD_UP);
    const facing = _f5.copy(gait.facing).addScaledVector(up, -gait.facing.dot(up));
    if (facing.lengthSq() < 1e-8) facing.set(0, 0, 1); else facing.normalize();
    // `side` points to the character's anatomical left. Up × shoulder-span then produces +facing for the
    // imported chest, matching the procedural face's +Z convention.
    const side = _f6.crossVectors(facing, up).normalize();
    const base = _f7.copy(i.ankleFront).add(i.ankleRear).multiplyScalar(0.5);
    const travel = _f10.copy(i.vel).addScaledVector(up, -i.vel.dot(up));
    if (travel.lengthSq() < 1e-6) travel.copy(facing); else travel.normalize();
    // Flight velocity is not walking velocity. A Superman pass can cross the mountain at hundreds of metres
    // per second, but its feet stay in the neutral on-foot stance instead of running against the air.
    const weight = gait.flying ? 0 : clamp(gait.weight, 0, 1);
    const turn = gait.flying ? 0 : clamp(gait.turn ?? 0, -1, 1);
    const legWeight = Math.max(weight, Math.abs(turn));
    const crouch = clamp(i.crouch, 0, 1);
    // Translation strides along travel; a planted turn uses the same alternating foot pattern at a shorter
    // reach, signed so left and right turns lead with opposite feet. Arms deliberately key off `weight` below,
    // not this turn wave, so a turn-in-place remains a lower-body adjustment rather than a walking mime.
    const wave = Math.sin(gait.phase) * (weight > 0.01 ? weight : turn);
    const stride = wave * (weight > 0.01 ? WALK_STRIDE : WALK_TURN_STEP);
    const bob = -Math.cos(gait.phase * 2) * WALK_BOB * legWeight;

    ankleFront.copy(base).addScaledVector(side, WALK_STANCE_HALF)
      .addScaledVector(travel, stride).addScaledVector(up, WALK_LIFT * Math.max(0, wave));
    ankleRear.copy(base).addScaledVector(side, -WALK_STANCE_HALF)
      .addScaledVector(travel, -stride).addScaledVector(up, WALK_LIFT * Math.max(0, -wave));

    // At rest the legs are almost extended; entering the gait lowers the pelvis before the stride separates the
    // feet, giving both knees room to flex. Ctrl crouch layers beneath that instead of replacing the walk bend.
    const hipHeight = WALK_HIP_HEIGHT + bob - WALK_GAIT_DROP * legWeight - WALK_CROUCH_DROP * crouch;
    const hipCenter = _j1.copy(base).addScaledVector(up, hipHeight)
      .addScaledVector(facing, WALK_CROUCH_LEAN * crouch * 0.35);
    const hipF = _j2.copy(hipCenter).addScaledVector(side, HIP_HALF);
    const hipR = _j8.copy(hipCenter).addScaledVector(side, -HIP_HALF);
    hipPos.copy(hipCenter).addScaledVector(up, PELVIS_RISE);
    const upperBack = _j11.copy(hipPos).addScaledVector(up, LUMBAR)
      .addScaledVector(facing, WALK_CROUCH_LEAN * crouch * 0.4);
    const clavicleRoot = _j12.copy(hipPos).addScaledVector(up, LUMBAR + THORACIC)
      .addScaledVector(facing, WALK_CROUCH_LEAN * crouch);
    const chest = _j3.copy(clavicleRoot).addScaledVector(up, -SHOULDER_DROP);
    // The shoulder line. The gait's facing (the headset's yaw) is its baseline; with an exactly tracked body
    // the held-out hands pull the chest round toward them as well, exactly as they do on the board.
    const tracked = i.handTargets;
    if (tracked) {
      trackedWrist(tracked.a, trackedWristA, gripOffsetA);
      trackedWrist(tracked.b, trackedWristB, gripOffsetB);
    }
    const chestFacing = i.headTarget?.exactPosition === true
      ? resolveWearerFacing(_w2, i, up, facing, facing) : _w2.copy(facing);
    const shoulderSide = _w3.crossVectors(chestFacing, up).normalize();
    const shF = _j5.copy(chest).addScaledVector(shoulderSide, SHOULDER_HALF);
    const shR = _j6.copy(chest).addScaledVector(shoulderSide, -SHOULDER_HALF);

    const headAxis = _h1.copy(up);
    const headBoneP = _j13.copy(clavicleRoot).addScaledVector(up, NECK_LEN);
    const headP = _j7.copy(headBoneP).addScaledVector(up, HEAD_BONE_TO_HELMET);
    const headForward = _h2.copy(facing);
    if (i.headTarget) {
      headAxis.set(0, 1, 0).applyQuaternion(i.headTarget.quaternion).normalize();
      headForward.set(0, 0, -1).applyQuaternion(i.headTarget.quaternion).normalize();
      // Desktop camera position is an eye-height proxy; keep the standard anatomy and use only its look. A
      // tracked XR view is a real body landmark, so the avatar's eye bridge retains its exact 6-DoF position.
      if (i.headTarget.exactPosition) {
        _t2.copy(headP); // authored head centre, before the exact tracked viewpoint replaces it
        headAtView(headP, i.headTarget.position, headAxis, headForward);
        headBoneP.copy(headP).addScaledVector(headAxis, -HEAD_BONE_TO_HELMET);

        // A remote VR walker has the same three tracked points as the local board rider. Carry most of the head
        // translation into its pelvis, keep both feet within reach, and span the visible torso to the skull.
        _t1.copy(headP).sub(_t2);
        hipF.addScaledVector(_t1, TRACKED_HIP_FOLLOW);
        hipR.addScaledVector(_t1, TRACKED_HIP_FOLLOW);
        reachTo(hipF, ankleFront, REACH);
        reachTo(hipR, ankleRear, REACH);
        hipPos.copy(hipF).add(hipR).multiplyScalar(0.5).addScaledVector(up, PELVIS_RISE);
        _t1.copy(headBoneP).sub(hipPos);
        const trackedTorsoLength = _t1.length();
        if (trackedTorsoLength > 1e-5) _t2.copy(_t1).divideScalar(trackedTorsoLength);
        else _t2.copy(up);
        const torsoSegments = LUMBAR + THORACIC + NECK_LEN;
        upperBack.copy(hipPos).addScaledVector(_t2, trackedTorsoLength * LUMBAR / torsoSegments);
        clavicleRoot.copy(hipPos).addScaledVector(
          _t2, trackedTorsoLength * (LUMBAR + THORACIC) / torsoSegments,
        );
        chest.copy(clavicleRoot).addScaledVector(_t2, -SHOULDER_DROP);
        shF.copy(chest).addScaledVector(shoulderSide, SHOULDER_HALF);
        shR.copy(chest).addScaledVector(shoulderSide, -SHOULDER_HALF);
      } else headP.copy(headBoneP).addScaledVector(headAxis, HEAD_BONE_TO_HELMET);
    }

    solveJoint(hipF, ankleFront, THIGH, SHIN, facing, _n1);
    solveJoint(hipR, ankleRear, THIGH, SHIN, facing, _n2);

    const armWave = WALK_ARM_SWING * wave;
    const handDrop = THREE.MathUtils.lerp(0.50, 0.44, weight);
    const handOut = THREE.MathUtils.lerp(0.015, 0.035, weight);
    const handF = _a2.copy(shF).addScaledVector(shoulderSide, handOut).addScaledVector(up, -handDrop)
      .addScaledVector(travel, -armWave);
    const handR = _a4.copy(shR).addScaledVector(shoulderSide, -handOut).addScaledVector(up, -handDrop)
      .addScaledVector(travel, armWave);
    for (const pointing of i.pointTargets ?? []) {
      if (pointing.weight <= 0) continue;
      // Front/rear is the chest-basis span here: front is anatomical right and rear anatomical left. Keep the
      // wire gesture anatomical so the left button drives the person's left arm for every rendered avatar.
      const shoulder = pointing.hand === 'left' ? shR : shF;
      const hand = pointing.hand === 'left' ? handR : handF;
      const direction = pointing.target
        ? _d1.copy(pointing.target).sub(shoulder)
        : _d1.copy(pointing.direction);
      if (direction.lengthSq() > 1e-8) {
        direction.normalize();
        _p1.copy(shoulder).addScaledVector(direction, ARM_REACH * 0.97);
        hand.lerp(_p1, clamp(pointing.weight, 0, 1));
      }
    }
    let trackedF: RiderHandTarget | null = null, trackedR: RiderHandTarget | null = null;
    if (tracked) {
      const crossed = assignTrackedWrists(shF, shR);
      trackedF = crossed ? tracked.b : tracked.a;
      trackedR = crossed ? tracked.a : tracked.b;
      handF.copy(crossed ? trackedWristB : trackedWristA);
      handR.copy(crossed ? trackedWristA : trackedWristB);
    }
    resolveArmReach(shF, handF, trackedF); resolveArmReach(shR, handR, trackedR);
    // A relaxed elbow hangs a little behind and outside the shoulder/hand chord. A forward pole gives the
    // unmistakable elbows-out-in-front silhouette, especially when both arms are near vertical at idle. A
    // tracked arm takes the wearer-frame pole instead (`trackedElbowPole`): this one is antiparallel to a
    // controller held out in front, which is the elbow snapping from side to side.
    if (trackedF) trackedElbowPole(_e1, up, chestFacing, shoulderSide, 1);
    else _e1.copy(facing).negate().addScaledVector(side, 0.28);
    if (trackedR) trackedElbowPole(_e2, up, chestFacing, shoulderSide, -1);
    else _e2.copy(facing).negate().addScaledVector(side, -0.28);
    solveJoint(shF, handF, UPPER_ARM, FOREARM, _e1, _a1);
    solveJoint(shR, handR, UPPER_ARM, FOREARM, _e2, _a3);
    resolveHandFrame(handFrontFinger, handFrontPalm, _a1, handF, trackedF, headAxis, clavicleRoot);
    resolveHandFrame(handRearFinger, handRearPalm, _a3, handR, trackedR, headAxis, clavicleRoot);
    characterPose.handFrontCurl = trackedF?.curl ?? null;
    characterPose.handRearCurl = trackedR?.curl ?? null;
    characterPose.handFrontTracked = trackedF !== null;
    characterPose.handRearTracked = trackedR !== null;

    _f15.copy(up);
    drawSolved();
  }

  function place(i: RiderInput) {
    if (i.locomotion) { placeOnFoot(i); return; }
    characterPose.feet = skis ? 'forward' : 'bindings';
    const fresh = !seated;
    // Axes. `ankleAxis` is the line through the two boots — the deck's own long axis on a snowboard, the
    // rider's own lateral on skis. The ankles give it exactly, and every other axis below is derived from it,
    // so the whole body turns with the feet without a second construction.
    const bob = _f1.copy(i.deckUp);
    if (bob.lengthSq() < 1e-8) bob.set(0, 1, 0); else bob.normalize();
    const ankleAxis = _f2.copy(i.ankleFront).sub(i.ankleRear);
    if (ankleAxis.lengthSq() < 1e-8) ankleAxis.set(0, 0, 1); else ankleAxis.normalize();

    // Physics can reverse its requested edge immediately; a body cannot.  Filter only the presentation targets,
    // leaving the actual deck, contact, acceleration and rider state untouched.
    const targetLean = clamp(i.lean, -1, 1);
    const turnAlpha = fresh ? 1 : 1 - Math.pow(2, -Math.max(0, i.dt) / TURN_POSE_HALF_LIFE);
    poseLean += (targetLean - poseLean) * turnAlpha;
    poseBank += (i.bank - poseBank) * turnAlpha;

    // Where a rider *stands*: against APPARENT gravity — the pull of the moment's own physics, minus the board's
    // acceleration. Steady traverse → upright off the tilted deck; accelerating down the fall line → already
    // falling, square to the deck IS balanced; a carve's v²/r → the lean-in is supported; free fall → no weight,
    // no argument, square to the deck. The pull must be the state's own (this world's grounded pull is not its
    // airborne one), and `weight` squares away the noise a near-zero apparent force would otherwise normalize up.
    // The argument is split at the waist: the strapped-down leg triangle rides the terrain (`stacked`, hips)
    // and the torso does the uprighting, which is the first of the two things the spine leaves that axis for.
    if (fresh) balanceAccel.set(0, 0, 0);
    else balanceAccel.lerp(i.accel, i.dt / (BALANCE_LEAD + i.dt));
    const pull = i.grounded ? RIDE_GROUND_TANGENTIAL_PULL
      : i.vel.y > 0 ? RIDE_AIR_GRAVITY_RISING : RIDE_AIR_GRAVITY_FALLING;
    const apparent = _f10.copy(balanceAccel);
    apparent.y += pull;
    const weight = clamp(apparent.length() / pull, 0, 1);
    if (apparent.lengthSq() > 1e-8) apparent.normalize(); else apparent.copy(bob);
    const sway2 = weight * weight;
    const stacked = _f3.copy(bob).lerp(apparent, RIDER_UPRIGHT_HIPS * sway2);
    if (stacked.lengthSq() < 1e-8) stacked.copy(WORLD_UP); else stacked.normalize();
    // The stance: which edge, how committed to it, and how deeply coiled. Resolved once, here, and the entire
    // body below is built from it — there is no second path and no joint table. The coil is laid on top of
    // whichever edge is under him.
    const c = clamp(i.crouch, -1, 1);
    const turnWeight = i.grounded ? clamp(Math.abs(poseLean) / CARVE_FULL_LEAN, 0, 1) : 0;
    // A committed edge has most of the coil already spent: the legs are extended out to the side holding the
    // board over, so there is far less left to fold them into — a rider has to come off the edge before they can
    // really load up. It is also what keeps a coiled carve's trailing knee out of the snow, which on the arcade
    // stances it otherwise goes straight through. The pop is not limited: standing up is always available.
    const fold = Math.max(0, c) * (1 - CARVE_COIL_LIMIT * turnWeight);
    const edge = poseLean < 0;
    blendStance(stance, style.neutral, edge ? style.heel : style.toe, turnWeight, style.crouch, fold);
    // A change of style crosses the *whole evaluated stance*, both sides read at this frame's own edge and coil —
    // so what eases across is the difference between two ways of standing and nothing else. A reset arrives.
    if (styleCross < 1) {
      styleCross = fresh ? 1
        : styleCross + (1 - styleCross) * (1 - Math.pow(2, -Math.max(0, i.dt) / STYLE_HALF_LIFE));
      if (styleCross > 0.999) { styleCross = 1; outgoingStyle = style; } else {
        blendStance(outgoing, outgoingStyle.neutral, edge ? outgoingStyle.heel : outgoingStyle.toe,
          turnWeight, outgoingStyle.crouch, fold);
        crossStance(stance, outgoing, stance, styleCross);
      }
    }
    stance.hipHeight += Math.max(0, -c) * POP_RISE;   // negative crouch is the pop: drive out past standing

    /**
     * The legs, and the single most important thing about how a carve reads.
     *
     * The body does **not** inherit the deck's visual bank. The board rolls to `lean · 50°`; the rider leans by
     * `inclination` off the *surface* they are riding, which is a much smaller angle. That is the difference
     * between a carve where the board is the thing that visibly moves — the rider committed and quiet on top of
     * it — and one where a whole body swings 50° left and right with the deck, which reads as the rider being
     * flopped about by their own board.
     *
     * The feet are still bolted to the rolled bindings, so the legs span from a banked board up to a body that
     * is not banked with it. That span *is* the carve's posture: it is what bends the knee out over the edge and
     * closes the hip into the sitting shape a carving snowboarder actually holds, without any of it being
     * dialled in by hand.
     *
     * **The one axis gear changes.** A snowboarder tips toward an edge — sideways to their own body, and about
     * the DECK's long axis, which is the line through their two boots. A skier tips left or right, which is
     * also sideways to their body, but their boots are side by side so that same tip is about the direction of
     * TRAVEL instead. `travel` below is that axis, taken before the lay-in so the rotation leaves it fixed;
     * everything after it is written once and comes out right for both.
     */
    const travel = _f13.crossVectors(stacked, ankleAxis);
    if (travel.lengthSq() < 1e-8) travel.set(1, 0, 0); else travel.normalize();
    const hipAxis = _f4.copy(stacked);
    hipAxis.applyAxisAngle(skis ? travel : ankleAxis, -stance.inclination * D2R);
    // `toe` is where the chest looks and the knees track: the toe edge across a snowboard, the fall line down a
    // pair of skis. `along` is the line the hips and shoulders span: the deck on a snowboard, the body on skis.
    // Both fall out of the same cross products either way — the triad simply turns with the feet.
    const toe = _f5.crossVectors(hipAxis, ankleAxis);
    if (toe.lengthSq() < 1e-8) toe.set(1, 0, 0); else toe.normalize();
    const along = _f6.crossVectors(toe, hipAxis).normalize();
    // The spine leaves the hip axis twice over: first the body's own argument with apparent gravity (the neutral
    // and airborne response, stopped at `BALANCE_TILT_MAX`, which is as far as a torso folds off its legs), then
    // the stance's `angulation` — the deliberate waist fold that puts the shoulders back over the board. That
    // fold is always about the shoulder line, which on a snowboard IS the boot line (they differ only by the
    // lay-in's own tilt) and on skis is `along`.
    const gap = hipAxis.angleTo(apparent);
    const swing = Math.min(gap * RIDER_UPRIGHT_CHEST * clamp(stance.chestBalance, 0, 1) * sway2,
      BALANCE_TILT_MAX);
    const spineDir = _f11.copy(hipAxis);
    if (swing > 1e-4) {
      const hinge = _f12.crossVectors(hipAxis, apparent);
      if (hinge.lengthSq() > 1e-10) spineDir.applyAxisAngle(hinge.normalize(), swing);
    }
    spineDir.applyAxisAngle(skis ? along : ankleAxis, -stance.angulation * D2R);
    // The second fold, on the other axis, signed like the lay-in so an opposite sign counters it. It is what a
    // skier's carve is made of — legs right into the turn, upper body back out over the outside ski — and what
    // keeps a committed edge from simply laying the whole rider down. A snowboarder's counter is `angulation`
    // above, because standing across the deck already puts their forward fold on that axis, so theirs is zero.
    if (stance.crossFold !== 0) spineDir.applyAxisAngle(toe, -stance.crossFold * D2R);
    // Imported boot/toe bones use the exact rendered-board normal supplied by pose.ts. Do not reconstruct this
    // from the signed bank here: even a sign disagreement is twice the carve angle relative to the visible deck.
    _f15.copy(i.soleUp);

    // The absorber. Carry the deck's travel; carry its normal speed only in the air, and only as momentum after.
    const deck = _f7.copy(i.ankleFront).add(i.ankleRear).multiplyScalar(0.5);
    if (!seated) { anchor.copy(deck); carriedVN = 0; seated = true; }
    else {
      const vn = i.vel.dot(bob);
      let carried = vn * i.dt;                                    // airborne: carry the fall, whole
      if (i.grounded) {
        const decay = Math.exp(-i.dt / ABSORB_LAND);
        carried = carriedVN * ABSORB_LAND * (1 - decay);          // ∫ vₙ·e^(−t/ABSORB_LAND) dt across the frame
        carriedVN *= decay;
      } else carriedVN = vn;
      anchor.addScaledVector(i.vel, i.dt).addScaledVector(bob, carried - vn * i.dt);
      const d = _f8.copy(anchor).sub(deck);
      const n = _f9.copy(bob).multiplyScalar(d.dot(bob));               // along the normal: the knees
      d.sub(n).multiplyScalar(Math.exp(-i.dt / ABSORB_TANGENT));        // sideways drift: pulled back in
      n.multiplyScalar(Math.exp(-i.dt / ABSORB_NORMAL));
      anchor.copy(deck).add(d).add(n);
      const leash = _f8.copy(anchor).sub(deck);
      if (leash.lengthSq() > HIP_LEASH * HIP_LEASH) anchor.copy(deck).add(leash.setLength(HIP_LEASH));
    }

    // The arms' sway: a hanging mass in the deck's frame, driven by the pseudo-force −a and sprung back to rest.
    const h = Math.min(i.dt, ARM_STEP_MAX);
    if (fresh) { sway.set(0, 0, 0); swayVel.set(0, 0, 0); drive.set(0, 0, 0); }
    else if (h > 0) {
      drive.lerp(_s1.copy(i.accel).multiplyScalar(-ARM_GAIN), h / (ARM_LEAD + h));
      const w = 2 * Math.PI * ARM_FREQ;
      _s2.copy(drive).addScaledVector(sway, -w * w).addScaledVector(swayVel, -2 * ARM_DAMP * w);
      swayVel.addScaledVector(_s2, h);
      sway.addScaledVector(swayVel, h);
      const out = sway.length();
      if (out > ARM_TRAVEL) {                      // the shoulder's stop: the hand arrives at it and stays
        sway.multiplyScalar(ARM_TRAVEL / out);
        const escaping = swayVel.dot(sway) / (ARM_TRAVEL * ARM_TRAVEL);
        if (escaping > 0) swayVel.addScaledVector(sway, -escaping);
      }
    }

    // The legs, from the ground up. `hipHeight` is the socket height — what the knee bend is *made of* — and the
    // stance rides the sockets across the deck and along the board from there. The crouch is applied outside the
    // absorber, so a pop is instant. Fore and aft, apparent lean arrives the only way strapped feet allow: the
    // hips slide, and the IK turns that into one knee or the other folding deeper. Which axis is fore/aft is the
    // rider's, not the deck's — the board's long axis under a snowboarder standing across it, the travel axis
    // under a skier standing along their skis — so a braking skier sits back rather than sliding sideways.
    const foreAxis = skis ? toe : along;
    const hipCenter = _j1.copy(anchor).addScaledVector(hipAxis, stance.hipHeight)
      .addScaledVector(along, stance.hipFore).addScaledVector(toe, stance.hipCross)
      .addScaledVector(foreAxis, HIP_SHIFT * sway2 * apparent.dot(foreAxis));
    const hipF = _j2.copy(hipCenter).addScaledVector(along, HIP_HALF).addScaledVector(toe, socketSkew);
    const hipR = _j8.copy(hipCenter).addScaledVector(along, -HIP_HALF).addScaledVector(toe, -socketSkew);
    reachTo(hipF, i.ankleFront, REACH); reachTo(hipR, i.ankleRear, REACH);
    // `hips` is the sacral pivot — the animation root, which rides above the sockets rather than between them.
    // If reach shortened either leg it moves with them, so the root never floats off its own pelvis.
    hipPos.copy(hipF).add(hipR).multiplyScalar(0.5).addScaledVector(hipAxis, PELVIS_RISE);

    // The back, walked as a chain along the folded spine. The chest carry arrives progressively — a share of it
    // at the upper back and all of it at the neck — so the trunk curls rather than hinging in one place. The
    // shoulder line then hangs off the neck base, which is what stops the jacket and the arms disagreeing.
    const carry = _c1.copy(toe).multiplyScalar(stance.chestCross).addScaledVector(along, stance.chestFore);
    const upperBack = _j11.copy(hipPos).addScaledVector(spineDir, LUMBAR)
      .addScaledVector(carry, LUMBAR / (LUMBAR + THORACIC));
    const clavicleRoot = _j12.copy(hipPos).addScaledVector(spineDir, LUMBAR + THORACIC).add(carry);
    const chest = _j3.copy(clavicleRoot).addScaledVector(spineDir, -SHOULDER_DROP);
    // A tracked XR rider does not stand across the deck the way the authored one does: their shoulders go across
    // where THEY face — gaze and held-out hands (`resolveWearerFacing`) — so the chest, clavicles and arm sockets
    // agree with the controllers whatever the board is doing underneath. It must not be the deck: the pinned VR
    // seat lets the board swing most of a carve under a wearer who has not turned, and shoulders welded to it
    // sweep away from the controllers and, past 90°, hand the two controllers to the wrong arms. The ordinary
    // authored rider retains its sideways snowboard counter-rotation. Head tracking stays independent throughout.
    const trackedUpperBody = i.headTarget?.exactPosition === true;
    const tracked = i.handTargets;
    if (tracked) {
      trackedWrist(tracked.a, trackedWristA, gripOffsetA);
      trackedWrist(tracked.b, trackedWristB, gripOffsetB);
    }
    const gaze = i.rideForward && i.rideForward.lengthSq() > 1e-8
      ? i.rideForward : skis ? toe : ankleAxis;
    const wearerFwd = trackedUpperBody ? resolveWearerFacing(_w2, i, spineDir, null, gaze) : null;
    const spread = _j4;
    if (wearerFwd) spread.crossVectors(wearerFwd, spineDir).normalize();
    else {
      spread.copy(along).applyAxisAngle(spineDir, stance.counterRotation * D2R)
        .addScaledVector(spineDir, stance.shoulderSlope).normalize();
    }
    const attention = _h5.copy(i.lookForward && i.lookForward.lengthSq() > 1e-8 ? i.lookForward : gaze).normalize();
    // The neck's range is anatomical, so its zero comes from the VISIBLE CHEST, not from the board. When the
    // target lies farther around than a comfortable neck-only look, open the shoulders toward it and leave the
    // remainder to the head. This is essential on a switch landing: ridden-forward can be the deck's tail while
    // the torso is still sideways to it, and measuring from that tail made a numeric 70° look visibly exceed 90°.
    const chestForward = _h7.crossVectors(spineDir, spread);
    if (chestForward.lengthSq() < 1e-8) chestForward.copy(toe); else chestForward.normalize();
    const attentionFlat = _h8.copy(attention).addScaledVector(spineDir, -attention.dot(spineDir));
    // A vertical target has no useful torso azimuth. Keep the current shoulder opening while looking down/up;
    // unwinding it toward an arbitrary zero would add a body yaw to what should be a pure head pitch.
    let targetTorsoYaw = i.headTarget ? 0 : torsoLookYaw;
    if (!i.headTarget && Math.abs(attention.dot(spineDir)) <= 0.95 && attentionFlat.lengthSq() > 1e-8) {
      attentionFlat.normalize();
      const attentionFromChest = Math.atan2(
        _h9.crossVectors(chestForward, attentionFlat).dot(spineDir),
        clamp(chestForward.dot(attentionFlat), -1, 1),
      );
      targetTorsoYaw = Math.sign(attentionFromChest)
        * Math.min(HEAD_TORSO_YAW_LIMIT, Math.max(0, Math.abs(attentionFromChest) - HEAD_TORSO_SHARE_YAW));
    }
    if (fresh) torsoLookYaw = targetTorsoYaw;
    else {
      const torsoAlpha = 1 - Math.pow(2, -Math.max(0, i.dt) / HEAD_TORSO_HALF_LIFE);
      const maxTorsoStep = HEAD_TORSO_MAX_SPEED * Math.max(0, i.dt);
      torsoLookYaw += clamp((targetTorsoYaw - torsoLookYaw) * torsoAlpha, -maxTorsoStep, maxTorsoStep);
    }
    if (Math.abs(torsoLookYaw) > 1e-5) spread.applyAxisAngle(spineDir, torsoLookYaw).normalize();
    chestForward.crossVectors(spineDir, spread);
    if (chestForward.lengthSq() < 1e-8) chestForward.copy(toe); else chestForward.normalize();
    const shF = _j5.copy(chest).addScaledVector(spread, SHOULDER_HALF);
    const shR = _j6.copy(chest).addScaledVector(spread, -SHOULDER_HALF);
    const armUp = _c4.crossVectors(spineDir, ankleAxis).normalize();   // the toe side, in the torso's own frame
    // The neck continues the same chain: the skull base sits a neck's length above the clavicle root, so the
    // head is attached to the body rather than rebuilt beside it.
    const headBoneP = _j13.copy(clavicleRoot).addScaledVector(spineDir, NECK_LEN);
    // The head rides on the body's own line rather than the deck's, and keeps some of the lean rather than all
    // of it — a rider's eyes stay near the horizon. The visible chest is the neck's neutral; `lookForward` is
    // where attention wants to go (through a carve or toward a landing). Measuring the stop in this anatomical
    // frame is what prevents a standard/goofy mirror or switch landing twisting the face through the jacket.
    const headAxis = _h1.copy(spineDir).lerp(WORLD_UP, i.grounded ? HEAD_UPRIGHT_GROUND : HEAD_UPRIGHT_AIR);
    if (headAxis.lengthSq() < 1e-8) headAxis.copy(WORLD_UP); else headAxis.normalize();
    const neckUp = _h4.copy(headAxis);
    const headForward = _h2.copy(chestForward).addScaledVector(neckUp, -chestForward.dot(neckUp));
    if (headForward.lengthSq() < 1e-8) headForward.copy(gaze); else headForward.normalize();
    const neckRight = _h3.crossVectors(neckUp, headForward);
    if (neckRight.lengthSq() < 1e-8) neckRight.copy(toe); else neckRight.normalize();
    // The glance (constants above): a yaw about the head's own up axis, so it rides every pose the body is
    // already in. Waiting time passes only while the ride is calm and the last look has fully returned, so a
    // flurry of carves defers the next one rather than banking several.
    if (fresh) { glance = 0; glanceHold = 0; glanceWait = drawGlanceWait(); }
    const calm = i.grounded && Math.abs(poseLean) < GLANCE_LEAN_MAX && Math.abs(c) < GLANCE_CROUCH_MAX
      && i.vel.lengthSq() > GLANCE_SPEED * GLANCE_SPEED;
    if (glanceHold > 0) {
      if (!calm) glanceHold = 0;
      else if (glance > 0.9) glanceHold -= i.dt;
    } else if (calm && glance < 1e-3) {
      glanceWait -= i.dt;
      if (glanceWait <= 0) {
        glanceWait = drawGlanceWait();
        glanceYaw = (Math.random() < 0.5 ? -1 : 1)
          * (GLANCE_YAW_MIN + Math.random() * (GLANCE_YAW_MAX - GLANCE_YAW_MIN));
        glanceHold = GLANCE_HOLD_MIN + Math.random() * (GLANCE_HOLD_MAX - GLANCE_HOLD_MIN);
      }
    }
    const glanceHalf = glanceHold > 0 || calm ? GLANCE_TURN : GLANCE_YIELD;
    glance += ((glanceHold > 0 ? 1 : 0) - glance) * (1 - Math.pow(2, -Math.max(0, i.dt) / glanceHalf));
    // Resolve the attention target in the neutral neck frame, then layer the stance's authored turn glance and
    // the occasional calm look around on its yaw. Pitch is allowed now too: the falling pose can look at the
    // actual touchdown chord instead of staring horizontally over it.
    const ahead = attention.dot(headForward), across = attention.dot(neckRight), above = attention.dot(neckUp);
    // Very nearly vertical has no meaningful azimuth. Holding the last/neutral yaw there avoids numerical noise
    // choosing an arbitrary behind-the-back side while the rider looks down over a steep drop.
    const attentionYaw = Math.abs(above) > 0.95 ? lookYaw : Math.atan2(across, ahead);
    let targetYaw = attentionYaw + stance.headYaw * D2R + glanceYaw * glance;
    let targetPitch = Math.atan2(above, Math.hypot(ahead, across));
    targetYaw = clamp(targetYaw, -HEAD_LOOK_YAW_LIMIT, HEAD_LOOK_YAW_LIMIT);
    targetPitch = clamp(targetPitch, -HEAD_LOOK_DOWN_LIMIT, HEAD_LOOK_UP_LIMIT);
    if (fresh) { lookYaw = targetYaw; lookPitch = targetPitch; }
    else {
      const lookAlpha = 1 - Math.pow(2, -Math.max(0, i.dt) / HEAD_LOOK_HALF_LIFE);
      const maxLookStep = HEAD_LOOK_MAX_SPEED * Math.max(0, i.dt);
      lookYaw += clamp((targetYaw - lookYaw) * lookAlpha, -maxLookStep, maxLookStep);
      lookPitch += clamp((targetPitch - lookPitch) * lookAlpha, -maxLookStep, maxLookStep);
    }
    // Yaw the horizontal neck frame, then pitch both forward and up around that yawed right axis. Keeping the
    // pair orthogonal matters to imported rigs: feeding makeBasis a pitched forward with the old up would shear
    // the head matrix before it ever reached a bone.
    const horizontalLook = _h6.copy(headForward).multiplyScalar(Math.cos(lookYaw))
      .addScaledVector(neckRight, Math.sin(lookYaw)).normalize();
    headForward.copy(horizontalLook).multiplyScalar(Math.cos(lookPitch))
      .addScaledVector(neckUp, Math.sin(lookPitch)).normalize();
    headAxis.copy(neckUp).multiplyScalar(Math.cos(lookPitch))
      .addScaledVector(horizontalLook, -Math.sin(lookPitch)).normalize();
    const headP = _j7.copy(headBoneP).addScaledVector(headAxis, HEAD_BONE_TO_HELMET);
    if (i.headTarget) {
      // An XR viewer looks down local −Z while the rider model's face is local +Z. Resolve that actual gaze into
      // the solver's head basis; the imported rig receives the same headUp/headForward pair as the procedural one.
      headAxis.set(0, 1, 0).applyQuaternion(i.headTarget.quaternion).normalize();
      headForward.set(0, 0, -1).applyQuaternion(i.headTarget.quaternion).normalize();
      if (i.headTarget.exactPosition) {
        // The headset is not merely a head decoration: it is the top landmark of the local body. Let the pelvis
        // follow most of its translation (bounded by both leg reaches), then rebuild the visible torso between
        // that pelvis and the skull. A lean therefore leans the jacket and shoulders; a physical crouch lowers
        // the hips and bends the knees. The remaining motion lives in the spine instead of in an invisible,
        // stretched neck while the rest of the rider stays frozen in the authored stance.
        headAtView(_t2, i.headTarget.position, headAxis, headForward);
        _t1.copy(_t2).sub(headP);
        hipF.addScaledVector(_t1, TRACKED_HIP_FOLLOW);
        hipR.addScaledVector(_t1, TRACKED_HIP_FOLLOW);
        reachTo(hipF, i.ankleFront, REACH);
        reachTo(hipR, i.ankleRear, REACH);
        hipPos.copy(hipF).add(hipR).multiplyScalar(0.5).addScaledVector(hipAxis, PELVIS_RISE);

        headP.copy(_t2);
        headBoneP.copy(headP).addScaledVector(headAxis, -HEAD_BONE_TO_HELMET);
        _t1.copy(headBoneP).sub(hipPos);
        const trackedTorsoLength = _t1.length();
        if (trackedTorsoLength > 1e-5) spineDir.copy(_t1).divideScalar(trackedTorsoLength);
        const torsoSegments = LUMBAR + THORACIC + NECK_LEN;
        upperBack.copy(hipPos).addScaledVector(spineDir, trackedTorsoLength * LUMBAR / torsoSegments);
        clavicleRoot.copy(hipPos).addScaledVector(
          spineDir, trackedTorsoLength * (LUMBAR + THORACIC) / torsoSegments,
        );
        chest.copy(clavicleRoot).addScaledVector(spineDir, -SHOULDER_DROP);
        // The spine was just rebuilt up to the tracked skull; keep the wearer's shoulder line square to it.
        spread.crossVectors(wearerFwd!, spineDir);
        if (spread.lengthSq() < 1e-8) spread.crossVectors(gaze, spineDir);
        if (spread.lengthSq() < 1e-8) spread.copy(along);
        spread.normalize();
        shF.copy(chest).addScaledVector(spread, SHOULDER_HALF);
        shR.copy(chest).addScaledVector(spread, -SHOULDER_HALF);
        armUp.crossVectors(spineDir, ankleAxis);
        if (armUp.lengthSq() < 1e-8) armUp.copy(toe); else armUp.normalize();
      }
    }
    // The knees bend over the toes — that is the pole — canted along the hip line by as much as the stance
    // drives them. A snowboarder's toe-side carve pushes them forward into the boot tongue and a heel-side one
    // leaves them quiet; a skier's both drive the same way, into the turn.
    const kneePoleF = _p1.copy(toe).addScaledVector(along, stance.kneeTrackFront).normalize();
    solveJoint(hipF, i.ankleFront, THIGH, SHIN, kneePoleF, _n1);
    const kneePoleR = _p1.copy(toe).addScaledVector(along, stance.kneeTrackRear).normalize();
    solveJoint(hipR, i.ankleRear, THIGH, SHIN, kneePoleR, _n2);

    // Where the rider *keeps* his arms: four bone directions in the torso's own frame, so the whole of both arms
    // is four pairs of angles and nothing else. The lead arm reaches down the board and its forearm levels off,
    // pointing where he is going; the trailing one hangs and comes across the body. Neither reaches behind the
    // back — a shoulder does not open that far, and it is the trailing arm the chase camera looks straight at.
    //
    // Then the board's acceleration moves the hands off those rest points, and the elbows are *solved* to the
    // hands rather than aimed: the arm bends to follow its own glove, and neither bone stretches to do it.
    const restF = _e1.copy(shF).addScaledVector(
      armDir(_d1, stance.leadUpperDrop, stance.leadUpperSwing, spineDir, along, armUp), UPPER_ARM,
    );
    const handF = _a2.copy(restF).addScaledVector(
      armDir(_d1, stance.leadForeDrop, stance.leadForeSwing, spineDir, along, armUp), FOREARM,
    ).add(sway);
    const restR = _e2.copy(shR).addScaledVector(
      armDir(_d1, stance.trailUpperDrop, stance.trailUpperSwing, spineDir, along, armUp), UPPER_ARM,
    );
    const handR = _a4.copy(restR).addScaledVector(
      armDir(_d1, stance.trailForeDrop, stance.trailForeSwing, spineDir, along, armUp), FOREARM,
    ).add(sway);
    // Tracked hands win over the stance's own (docs/048). Assigned by which shoulder each is nearer rather than
    // by handedness — the rider stands sideways, and regular / goofy / switch each put a different hand forward,
    // so the wearer's left is the LEAD arm on half the runs and the trailing one on the other half — and then
    // held (`assignTrackedWrists`). The elbows of a tracked arm are poled in the WEARER's frame: the rest points
    // above are built in the deck's frame, which the tracked torso no longer shares, so as a pole they swing the
    // elbows round with every turn of the board.
    let trackedF: RiderHandTarget | null = null, trackedR: RiderHandTarget | null = null;
    if (tracked) {
      const crossed = assignTrackedWrists(shF, shR);
      trackedF = crossed ? tracked.b : tracked.a;
      trackedR = crossed ? tracked.a : tracked.b;
      handF.copy(crossed ? trackedWristB : trackedWristA);
      handR.copy(crossed ? trackedWristA : trackedWristB);
    }
    resolveArmReach(shF, handF, trackedF); resolveArmReach(shR, handR, trackedR);
    const elbowF = _a1, elbowR = _a3;
    const poleFacing = wearerFwd ?? chestForward;
    if (trackedF) trackedElbowPole(_p1, spineDir, poleFacing, spread, 1); else _p1.copy(restF).sub(shF);
    solveJoint(shF, handF, UPPER_ARM, FOREARM, _p1, elbowF);
    if (trackedR) trackedElbowPole(_p1, spineDir, poleFacing, spread, -1); else _p1.copy(restR).sub(shR);
    solveJoint(shR, handR, UPPER_ARM, FOREARM, _p1, elbowR);
    resolveHandFrame(handFrontFinger, handFrontPalm, elbowF, handF, trackedF, headAxis, clavicleRoot);
    resolveHandFrame(handRearFinger, handRearPalm, elbowR, handR, trackedR, headAxis, clavicleRoot);
    characterPose.handFrontCurl = trackedF?.curl ?? null;
    characterPose.handRearCurl = trackedR?.curl ?? null;
    characterPose.handFrontTracked = trackedF !== null;
    characterPose.handRearTracked = trackedR !== null;

    ankleFront.copy(i.ankleFront); ankleRear.copy(i.ankleRear);
    drawSolved();
  }

  return {
    group,
    pose: place,
    solved: characterPose,
    reset: (i) => { seated = false; haveWearerFacing = false; trackedAssigned = false; place(i); },
    setStyle: (id) => {
      const next = ridingStyle(id, gear);
      if (next === style) return;
      // Cross from wherever the body is now. Re-aiming mid-cross keeps the outgoing side fixed, so a second
      // change before the first has landed still starts from a stance the body was actually in.
      if (styleCross >= 1) outgoingStyle = style;
      style = next;
      styleCross = 0;
    },
    // First person (docs/048). Both bodies need it and they need different things: the procedural head is a real
    // object that can simply be hidden, while a skinned character has no head object at all — only head-weighted
    // vertices — so the rig collapses its head bone instead.
    setFirstPerson: (on) => {
      head.visible = !on;
      character.setFirstPerson(on);
    },
    dispose: () => { character.dispose(); disposeTree(procedural); },
  };
}

function disposeTree(root: THREE.Object3D) {
  const geos = new Set<THREE.BufferGeometry>(), mats = new Set<THREE.Material>();
  root.traverse(o => {
    if (!(o instanceof THREE.Mesh)) return;
    geos.add(o.geometry);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) mats.add(m);
  });
  geos.forEach(g => g.dispose());
  mats.forEach(m => m.dispose());
}

// scratch — the pose runs every frame and allocates nothing
const _k1 = new THREE.Vector3(), _k2 = new THREE.Vector3();
const _b1 = new THREE.Vector3();
const _f1 = new THREE.Vector3(), _f2 = new THREE.Vector3(), _f3 = new THREE.Vector3(), _f4 = new THREE.Vector3();
const _f5 = new THREE.Vector3(), _f6 = new THREE.Vector3(), _f7 = new THREE.Vector3(), _f8 = new THREE.Vector3();
const _f9 = new THREE.Vector3(), _f10 = new THREE.Vector3(), _f11 = new THREE.Vector3();
const _f12 = new THREE.Vector3(), _f13 = new THREE.Vector3(), _f15 = new THREE.Vector3();
const _c1 = new THREE.Vector3(), _c4 = new THREE.Vector3();
const _j1 = new THREE.Vector3(), _j2 = new THREE.Vector3(), _j3 = new THREE.Vector3(), _j4 = new THREE.Vector3();
const _j5 = new THREE.Vector3(), _j6 = new THREE.Vector3(), _j7 = new THREE.Vector3(), _j8 = new THREE.Vector3();
const _j11 = new THREE.Vector3(), _j12 = new THREE.Vector3(), _j13 = new THREE.Vector3();
const _palmIn = new THREE.Vector3();
/** How strongly a resting palm turns toward the body's midline. Enough to decide a hanging arm's roll, small
 *  enough that an arm held out still rests palm-down rather than rolled inward. */
const PALM_MEDIAL = 0.5;
const _n1 = new THREE.Vector3(), _n2 = new THREE.Vector3();
const _p1 = new THREE.Vector3(), _d1 = new THREE.Vector3();
const _a1 = new THREE.Vector3(), _a2 = new THREE.Vector3(), _a3 = new THREE.Vector3(), _a4 = new THREE.Vector3();
const _e1 = new THREE.Vector3(), _e2 = new THREE.Vector3();
const _s1 = new THREE.Vector3(), _s2 = new THREE.Vector3();
const _h1 = new THREE.Vector3(), _h2 = new THREE.Vector3(), _h3 = new THREE.Vector3();
const _h4 = new THREE.Vector3(), _h5 = new THREE.Vector3(), _h6 = new THREE.Vector3();
const _h7 = new THREE.Vector3(), _h8 = new THREE.Vector3(), _h9 = new THREE.Vector3();
const _t1 = new THREE.Vector3(), _t2 = new THREE.Vector3();
const _w1 = new THREE.Vector3(), _w2 = new THREE.Vector3(), _w3 = new THREE.Vector3();

/** Back the avatar's helmet centre out of the exact view point between its eyes. The camera itself never moves:
 * this moves the modeled skull behind the HMD, matching the view-position + local-head-chop split used in VR. */
function headAtView(out: THREE.Vector3, view: THREE.Vector3, up: THREE.Vector3,
                    forward: THREE.Vector3): THREE.Vector3 {
  return out.copy(view)
    .addScaledVector(up, -VIEW_FROM_HEAD_UP)
    .addScaledVector(forward, -VIEW_FROM_HEAD_FORWARD);
}
