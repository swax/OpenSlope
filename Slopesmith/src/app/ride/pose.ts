import * as THREE from 'three';
import {
  createBoard, DEFAULT_RIDE_GEAR, DEFAULT_SNOWBOARD_STANCE, type BoardModel, type EquipmentAppearance,
  type RideGear, type SnowboardStance,
} from './gear';
import { createRider, type Rider, type RiderHandTarget } from './rider';
import {
  AIR_LEVEL_RATE, BANK_MAX, CONTACT_SEPARATION_SPEED, CROUCH_AIR, CROUCH_BRAKE, CROUCH_FOLD, CROUCH_POP,
  CROUCH_REACH, D2R, GROUND_ORIENT_GAIN, LAND_REACH_ETA, LAUNCH_LEVEL_SPEED, ORIENT_GRACE, PREALIGN_HORIZON,
  PREALIGN_LEAD, TILT_RATE, WORLD_UP, clamp, moveTowards, projectOnPlane, rotateTowards, type RideState,
} from './physics';
import { GRAVITY } from './physics-tuning';
import type { RideKeys } from './input';

/**
 * The drawn deck and its rider, posed from a `RideState`. One physics state in, one seated-and-banked deck
 * plus a standing rider out — nothing here reads input or terrain, so every rider on the mountain (the player's
 * and each AI opponent's) is drawn by the same code and can only look different if its *physics* differ.
 *
 * The rider is a SIBLING of the deck, not a child: it is posed in world space against the deck's bindings so
 * it can decline to inherit the deck's roll and its bob (`rider.ts` owns how).
 *
 * Which gear is under them is drawn here and nowhere else. The physics below is one deck frame either way —
 * skis ride exactly as a snowboard rides — so this module builds both quaternions a carve needs, the facing
 * basis and the same basis rolled onto its edge, and lets `gear.ts` decide which of them the model takes.
 */

/**
 * How far above the deck seat the somersault's fixed point sits — the tucked rider's centre: the ankle stack
 * plus legs folded into the air tuck put the hips roughly here, and [Trailmap: 340] rotates the BOARDER as one
 * entity, which reads as the body turning about itself with the deck swung around it. Pivoting at the seat
 * instead throws the whole body around the bindings — a somersault orbiting the feet. Visual only: the physics
 * arc is unchanged, it is simply carried by the waist rather than by the bindings.
 */
export const FLIP_PIVOT_RISE = 0.65;

/** A held carve leads the eyes this far around the corner before the board arrives. The neck owns the harder
 * anatomical cap; this is only the comfortable visual lead used to read a turn. */
const HEAD_CARVE_LOOK_AHEAD = 32 * D2R;
const HEAD_AIR_TURN_LOOK_AHEAD = 10 * D2R;
const HEAD_CARVE_BLEND_START = 0.04, HEAD_CARVE_BLEND_FULL = 0.35;

/**
 * Pick the untracked rider's attention direction. A committed grounded edge looks through the turn. As the
 * edge comes home, attention crosses continuously to actual travel; in falling air, `landEta` lets it point at
 * the same ballistic touchdown chord the board-orientation predictor found.
 *
 * `scratch` keeps the per-frame pose allocation-free. It is optional so focused tests can call the law directly.
 */
export function riderLookTarget(
  st: Pick<RideState, 'grounded' | 'lean' | 'landEta'>,
  velocity: THREE.Vector3,
  riddenForward: THREE.Vector3,
  up: THREE.Vector3,
  out = new THREE.Vector3(),
  scratch = new THREE.Vector3(),
  turnDirection = 0,
): THREE.Vector3 {
  // During an airborne yaw the rider turns with their own front. Once that rotation stops, the next branch
  // hands attention to the touchdown chord and the neck ease makes the familiar landing-spot motion. A small
  // lead keeps the head initiating the spin instead of appearing welded to the chest; it is still essentially
  // camera-facing at 180° and comes back onto exact downhill when the turn is released.
  if (!st.grounded && turnDirection !== 0) {
    out.copy(riddenForward).applyAxisAngle(up, Math.sign(turnDirection) * HEAD_AIR_TURN_LOOK_AHEAD);
    if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
    return out.normalize();
  }
  if (!st.grounded && Number.isFinite(st.landEta) && st.landEta > 0) {
    // This is the falling predictor's exact chord: p(t) - p(0), with the same strong falling gravity.
    out.copy(velocity).multiplyScalar(st.landEta);
    out.y -= 0.5 * GRAVITY * st.landEta * st.landEta;
  } else {
    out.copy(velocity);
    if (st.grounded) projectOnPlane(out, up, out);
  }
  if (out.lengthSq() < 1e-6) out.copy(riddenForward);
  if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
  out.normalize();

  if (!st.grounded) return out;
  const carveAmount = clamp((Math.abs(st.lean) - HEAD_CARVE_BLEND_START)
    / (HEAD_CARVE_BLEND_FULL - HEAD_CARVE_BLEND_START), 0, 1);
  const carveBlend = carveAmount * carveAmount * (3 - 2 * carveAmount);
  if (carveBlend <= 0) return out;
  scratch.copy(riddenForward).applyAxisAngle(up, Math.sign(st.lean) * HEAD_CARVE_LOOK_AHEAD).normalize();
  return out.lerp(scratch, carveBlend).normalize();
}

export interface RiderPoseOpts {
  scene: THREE.Object3D;
  /** Topsheet tint, so a field of riders reads apart from the chase camera. Omitted = the stock deck. */
  tint?: number;
  /** Id from the server-wide character library; `procedural` keeps the built-in debug body. */
  riderModel?: string;
  /** Riding style id from `stances.ts` — how the rider stands, independent of what they look like. */
  riderStyle?: string;
  /** What they stand ON (`gear.ts`). Purely visual to the physics, and a whole different body to the rider. */
  gear?: RideGear;
  /** Which foot leads on a snowboard. Ignored by skis, whose feet remain parallel. */
  snowboardStance?: SnowboardStance;
  /** Account-owned top/base art and solid sidewall colour. AI callers omit it and keep the built-in kit. */
  equipmentAppearance?: EquipmentAppearance;
}

/**
 * Advance the visible deck normal. PCSX2's final board matrix does not snap to the fresh contact basis: its
 * per-tick angular response is approximately cubic in orientation error, then neutral air slowly levels it —
 * until a landing is predicted, when the deck turns toward the surface it is about to hit in the time it has
 * left ([Trailmap: 340] pre-landing alignment). Keeping this as a small exported state step makes the
 * gold-derived law headlessly testable.
 */
export function advanceBoardOrientation(st: RideState, dt: number): boolean {
  const grounded = st.grounded;
  // A real lip departure can still have negative WORLD-Y velocity on a downhill course. Its invariant signal is
  // outward speed along the cached takeoff normal; treating only world-up motion as launch keeps orientation
  // grace glued to the lip and pitches the deck toward the far side during the first airborne frames.
  const launching = !grounded && (st.vel.y > LAUNCH_LEVEL_SPEED
    || st.vel.dot(st.contactN) > CONTACT_SEPARATION_SPEED);
  const orientGrounded = grounded || (st.airTime <= ORIENT_GRACE && !launching);
  const targetUp = orientGrounded ? st.contactN : st.airUp;
  const target = targetUp.lengthSq() > 1e-6 ? targetUp : WORLD_UP;
  const error = st.boardUp.angleTo(target);
  // Airborne with a landing ahead, `airUp` is already the upcoming surface's normal; close the remaining error
  // over the time remaining (square PREALIGN_LEAD early), never slower than neutral leveling, capped like the
  // ground chase so a teleport still cannot spin the deck.
  const rate = orientGrounded
    ? Math.min(TILT_RATE * D2R, GROUND_ORIENT_GAIN * error * error * error)
    : st.landEta <= PREALIGN_HORIZON
      ? clamp(error / Math.max(st.landEta - PREALIGN_LEAD, dt || 1 / 60), AIR_LEVEL_RATE * D2R, TILT_RATE * D2R)
      : AIR_LEVEL_RATE * D2R;
  st.boardUp.copy(rotateTowards(st.boardUp, target, rate * dt));
  if (st.boardUp.lengthSq() < 1e-6) st.boardUp.set(0, 1, 0);
  return orientGrounded;
}

export function createRiderPose(o: RiderPoseOpts) {
  let gear: RideGear = o.gear ?? DEFAULT_RIDE_GEAR;
  let snowboardStance: SnowboardStance = o.snowboardStance ?? DEFAULT_SNOWBOARD_STANCE;
  let equipmentAppearance = o.equipmentAppearance;
  let boardModel: BoardModel = createBoard(gear, snowboardStance, equipmentAppearance);
  let riderModel = o.riderModel;
  let riderStyle = o.riderStyle;
  let rider: Rider = createRider(riderModel, riderStyle, gear, snowboardStance);
  const ankleF = new THREE.Vector3(); const ankleR = new THREE.Vector3(); const soleUp = new THREE.Vector3();
  const deckSeat = new THREE.Vector3();
  const deckUpTmp = new THREE.Vector3(); // the flipped deck up handed to the rider; never `st.boardUp` itself
  const flipPivot = new THREE.Vector3();
  const rideForward = new THREE.Vector3(); // the actually leading end, including switch and the visible flip
  const lookForward = new THREE.Vector3(), lookTurnScratch = new THREE.Vector3();
  const riddenHeading = new THREE.Vector3(), previousRiddenHeading = new THREE.Vector3();
  const headingCross = new THREE.Vector3();
  let haveRiddenHeading = false;
  const flatQ = new THREE.Quaternion();  // facing + flip, with no carve roll: the frame a pair of skis takes
  const rolledQ = new THREE.Quaternion();
  const bankQ = new THREE.Quaternion(), flipQ = new THREE.Quaternion();
  // Scratch for `seatBoard`, which runs every frame a loose deck is drawn and must not allocate to do it.
  const seatUp = new THREE.Vector3(), seatFwd = new THREE.Vector3(), seatRight = new THREE.Vector3();
  const seatBasis = new THREE.Matrix4();

  let firstPerson = false;
  let handTargets: { a: RiderHandTarget; b: RiderHandTarget } | null = null;
  let headTarget: { position: THREE.Vector3; quaternion: THREE.Quaternion; exactPosition: true } | null = null;
  let tinted: THREE.MeshLambertMaterial | null = null;

  /** One cloned topsheet across every piece of the gear, so a pair of skis reads as a pair and not as two. */
  function applyTint() {
    if (o.tint === undefined) return;
    boardModel.group.traverse(obj => {
      if (!(obj instanceof THREE.Mesh) || !Array.isArray(obj.material)) return;
      if (!tinted) {
        tinted = (obj.material[1] as THREE.MeshLambertMaterial).clone(); // material slot 1 = the topsheet
        tinted.color.setHex(o.tint!);
      }
      obj.material = [obj.material[0], tinted, ...obj.material.slice(2)];
    });
  }

  /** Put the freshly built gear and body into the scene. Neither may ever answer a ground pick. */
  function addToScene() {
    for (const g of [boardModel.group, rider.group]) {
      g.traverse(obj => { obj.raycast = () => {}; });
      o.scene.add(g);
    }
  }

  applyTint();
  addToScene();

  /**
   * Seat and orient the board, then stand the rider on it. `dt = 0` is a valid first frame: nothing eases.
   * `hold` is the vertical riding intent. On ground/rail a tuck or brake folds the legs; in the air those same
   * holds belong exclusively to forward/back flips, while the ordinary automatic air crouch remains.
   *
   * `rs` is the model's between-ticks render view (position/facing/velocity lerped by the banked tick
   * fraction). Passing it draws the rider where this FRAME's moment falls between 60 Hz ticks — without it a
   * faster display aliases whole-tick jumps into judder. The eased visual state (boardUp, bank, crouch) stays
   * on `st`, already frame-time smooth.
   */
  function update(st: RideState, dt: number, hold: Pick<RideKeys, 'tuck' | 'brake'>,
                  rs?: { pos: THREE.Vector3; fwd: THREE.Vector3; vel: THREE.Vector3; flip: number }) {
    const pos = rs?.pos ?? st.pos, fwd = rs?.fwd ?? st.fwd, vel = rs?.vel ?? st.vel;
    const orientGrounded = advanceBoardOrientation(st, dt);
    // `boardUp` is the visible quaternion basis. The old path computed it, then bypassed it on every grounded
    // render by seating the deck against the unsmoothed contact normal — exactly the nose-down snap in the gold
    // comparison. Both ground and air now draw the basis that was actually advanced above.
    //
    // The FLIP rides on top of that basis rather than replacing it (docs/016). `boardUp` stays the deck's
    // contact-chased up — what the pre-landing alignment is steering and what the touchdown bands are read
    // against — so a rider can somersault without the model losing track of where the snow is.
    const basisUp = st.boardUp;
    const faceDir = projectOnPlane(fwd, basisUp, new THREE.Vector3());
    if (faceDir.lengthSq() > 1e-6) faceDir.normalize(); else faceDir.copy(fwd);
    riddenHeading.copy(faceDir).multiplyScalar(st.lead).normalize();
    let airTurnDirection = 0;
    if (!haveRiddenHeading || !st.riderSeated || dt <= 0) {
      previousRiddenHeading.copy(riddenHeading);
      haveRiddenHeading = true;
    } else {
      const yaw = Math.atan2(
        headingCross.crossVectors(previousRiddenHeading, riddenHeading).dot(basisUp),
        clamp(previousRiddenHeading.dot(riddenHeading), -1, 1),
      );
      airTurnDirection = !st.grounded && Math.abs(yaw) / dt > 8 * D2R ? Math.sign(yaw) : 0;
      previousRiddenHeading.copy(riddenHeading);
    }

    // carve bank (visual only): roll the deck about its forward axis by the lean; level in the air.
    const bankTarget = orientGrounded ? st.lean * BANK_MAX : 0;
    st.bank = moveTowards(st.bank, bankTarget, 360 * dt);

    // seat + orient: local +Z = facing, +Y = deck up, rolled by the bank about the facing (edge INTO the carve).
    // The seat is the physics position raised by the per-surface visual lift along the *smoothed* up, then slid
    // OUT of the carve along the lateral — the same offset the ground probe carries, so the drawn deck stands
    // where the contact is measured (`renderPos = contactPoint + smoothedUp·lift + lateral·slide`, [Trailmap: 320]).
    //
    // `lean`, `bank` and `carveSlide` are all signed in the RIDDEN frame (docs/016), and `right` here is the
    // drawn deck's own — opposite ones on a switch rider. The lead is what converts between them: without it a
    // landed 180 slides the deck into its turns and lifts the outside edge, which is a rider falling over.
    const right = new THREE.Vector3().crossVectors(basisUp, faceDir).normalize();
    const lead = st.lead;
    const seatAt = deckSeat.copy(pos).addScaledVector(st.boardUp, st.lift)
      .addScaledVector(right, st.carveSlide * lead);
    flatQ.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, basisUp, faceDir));
    const q = rolledQ.copy(flatQ).premultiply(bankQ.setFromAxisAngle(faceDir, -st.bank * lead * D2R));
    // Then the flip, about that same lateral: forward over the nose on W, backward over the tail on S. It is
    // signed in the ridden frame like the bank, so a switch rider's W still throws them forward down the hill.
    // The axis is invariant under its own rotation, so `right` remains the flip axis at every angle. It goes on
    // BOTH frames: a somersault turns a pair of skis over exactly as it turns a board over — only the carve
    // roll is the thing skis take one at a time.
    const flipDeg = (rs?.flip ?? st.flip) * lead;
    if (flipDeg !== 0) {
      flipQ.setFromAxisAngle(right, flipDeg * D2R);
      q.premultiply(flipQ);
      flatQ.premultiply(flipQ);
      // Turn the composite about the tucked body's centre, not about the bindings: reseat the deck at
      // `pivot + flipQ·(seat − pivot)`, so the point `FLIP_PIVOT_RISE` up the UNFLIPPED deck up is the
      // rotation's fixed point and rides the ballistic path. Zero and every whole rotation draw exactly the
      // seat the physics placed, and a landed residual's offset dies out continuously as the flip recovers.
      flipPivot.copy(basisUp).multiplyScalar(FLIP_PIVOT_RISE);
      seatAt.add(flipPivot).sub(flipPivot.applyQuaternion(flipQ));
    }
    // One rigid deck takes `q`; a pair of skis takes `flatQ` and gives the roll to each ski (`gear.ts`). Either
    // way the two world ankle seats come back out, which is all the rider is ever told about what is under it.
    boardModel.seat(seatAt, flatQ, q, ankleF, ankleR);
    // The figure turns over WITH the deck, and gets that for free: the rider stands against apparent gravity,
    // which in free fall is ≈ 0, so `rider.ts` builds the body square to the deck it is bolted to and the whole
    // rider goes round. It only needs the up it is standing on to be the flipped one — the ankles and `soleUp`
    // below already come through `q`.
    const deckUp = flipDeg !== 0
      ? deckUpTmp.copy(basisUp).applyAxisAngle(right, flipDeg * D2R) : basisUp;

    // The crouch is pure animation. It coils with the ollie charge — the duck IS the meter — and, on ground/rail,
    // folds for a tuck or a brake. In the air those holds exclusively rotate the rider; they must not keep applying
    // their old grounded posture while doing so. The launch spends its coil: for `POP_TIME` the target goes
    // *negative* and the legs drive out past standing, as hard as the charge that fed them. What follows is the air
    // tuck — until the predicted landing
    // closes inside `LAND_REACH_ETA`, when the legs extend to meet the snow so contact can fold them again (the
    // coached "extend just before impact, absorb on contact"). The arms
    // are not animated at all: they are handed the board's acceleration and left to swing against it.
    st.popTime = Math.max(0, st.popTime - dt);
    const airFold = st.landEta <= LAND_REACH_ETA ? CROUCH_REACH : CROUCH_AIR;
    const fold = st.popTime > 0 ? -st.popDrive
      : Math.max(st.charge, st.grounded && hold.tuck ? 1 : 0,
        st.grounded && hold.brake ? CROUCH_BRAKE : 0, st.grounded ? 0 : airFold);
    const rate = fold > st.crouch ? CROUCH_FOLD : CROUCH_POP;
    st.crouch = moveTowards(st.crouch, clamp(fold, -1, 1), rate * dt);

    rideForward.set(0, 0, 1).applyQuaternion(q).multiplyScalar(lead);
    riderLookTarget(st, vel, rideForward, basisUp, lookForward, lookTurnScratch, airTurnDirection);
    const input = {
      ankleFront: ankleF, ankleRear: ankleR,
      // The rider is built in the deck's own frame (ankles, toe/heel, counter-rotation), so the two carve signals
      // cross into it with the lead exactly as the roll above does.
      deckUp, soleUp: soleUp.copy(WORLD_UP).applyQuaternion(q),
      // Standard mirrors the body across the board: the same physical edge becomes its other anatomical edge.
      // Head gaze does not use that body frame—or the drawn nose. It follows whichever end physics says is
      // leading, so landing a 180 cannot leave the face looking back uphill.
      bank: st.bank * lead * (gear === 'snowboard' && snowboardStance === 'standard' ? -1 : 1),
      rideForward, lookForward,
      vel, accel: st.accel,
      grounded: st.grounded, dt, crouch: st.crouch,
      lean: st.lean * lead * (gear === 'snowboard' && snowboardStance === 'standard' ? -1 : 1),
      handTargets, headTarget,
    };
    if (st.riderSeated) rider.pose(input);
    else { rider.reset(input); st.riderSeated = true; }
  }

  /**
   * Seat the DECK ALONE at a world pose — no rider, no carve roll. `update` above draws a ridden board and the
   * body standing on it as one thing; this draws a board that is nobody's: the riderless coast after someone
   * steps off (`board-coast.ts`), and the deck lying at the gate before anyone gets on. The rider is posed
   * separately by whoever is walking around, so nothing here touches it.
   *
   * The gear gets the same quaternion for both frames because a loose deck carries no lean: a pair of skis
   * lying on the snow is a pair of skis lying flat, not a pair mid-carve.
   */
  function seatBoard(at: THREE.Vector3, deckUp: THREE.Vector3, heading: THREE.Vector3) {
    const basisUp = seatUp.copy(deckUp);
    if (basisUp.lengthSq() < 1e-6) basisUp.copy(WORLD_UP); else basisUp.normalize();
    const faceDir = projectOnPlane(heading, basisUp, seatFwd);
    // A heading square to the deck's own up carries no facing at all; take any world axis that does.
    if (faceDir.lengthSq() < 1e-6) projectOnPlane(SEAT_FALLBACK_FWD, basisUp, faceDir);
    if (faceDir.lengthSq() < 1e-6) projectOnPlane(SEAT_FALLBACK_RIGHT, basisUp, faceDir);
    faceDir.normalize();
    const right = seatRight.crossVectors(basisUp, faceDir).normalize();
    flatQ.setFromRotationMatrix(seatBasis.makeBasis(right, basisUp, faceDir));
    boardModel.seat(at, flatQ, flatQ, ankleF, ankleR);
  }

  /**
   * Show or hide the whole drawn rider — deck and body — in one call. A board that is
   * STOOD DOWN rather than torn down (`TestRide.park`) uses this: the objects stay built and in the scene, so
   * the next mount costs nothing, but nobody is looking at a spare rider standing at the gate meanwhile.
   */
  function setVisible(on: boolean) {
    boardModel.group.visible = on;
    rider.group.visible = on;
  }

  function dispose() {
    removeFromScene();
    boardModel.dispose();
    rider.dispose();
    tinted?.dispose();
  }

  function removeFromScene() {
    o.scene.remove(boardModel.group, rider.group);
  }

  /** Replace only the character visual, retaining the live gear and all physics/animation state. The custom
   * asset may load asynchronously; its procedural fallback occupies the same solved pose in the meantime. */
  function setRiderModel(modelId?: string) {
    riderModel = modelId;
    const previous = rider;
    rider = createRider(riderModel, riderStyle, gear, snowboardStance);
    rider.group.traverse(obj => { obj.raycast = () => {}; });
    o.scene.add(rider.group);
    o.scene.remove(previous.group);
    previous.dispose();
    applyFirstPerson();
  }

  /**
   * Swap the gear under a live rider. Unlike a character swap this rebuilds the BODY as well, because a skier
   * is not a snowboarder wearing something else: the stance table, the feet, and which way a lay-in tips all
   * change with the kit. Nothing about the physics does — the ride keeps its position, speed and edge — but
   * the absorber is unseated so the new body settles onto the deck instead of dragging the old one's momentum
   * sideways across it.
   */
  function setGear(next: RideGear) {
    if (next === gear) return;
    gear = next;
    removeFromScene();
    boardModel.dispose();   // which takes the cloned topsheet with it, so the tint is re-made below
    rider.dispose();
    tinted = null;
    boardModel = createBoard(gear, snowboardStance, equipmentAppearance);
    rider = createRider(riderModel, riderStyle, gear, snowboardStance);
    applyTint();
    addToScene();
    applyFirstPerson();
  }

  /** Mirror a snowboarder's feet/body/bindings without touching the board's physics or ridden direction. */
  function setSnowboardStance(next: SnowboardStance) {
    if (next === snowboardStance) return;
    snowboardStance = next;
    if (gear !== 'snowboard') return; // retained for the next snowboard selection; skis have no lateral stance
    removeFromScene();
    boardModel.dispose();
    rider.dispose();
    tinted = null;
    boardModel = createBoard(gear, snowboardStance, equipmentAppearance);
    rider = createRider(riderModel, riderStyle, gear, snowboardStance);
    applyTint();
    addToScene();
    applyFirstPerson();
  }

  /** Update profile art without rebuilding or moving a live board. */
  function setEquipmentAppearance(next?: EquipmentAppearance) {
    equipmentAppearance = next;
    boardModel.setAppearance(next);
  }

  /**
   * Draw the rider from INSIDE their own head (docs/048 — a VR ride seats the view on the deck, where the body
   * this poses is standing). The body stays: seeing your own board, legs and hands is most of what makes riding
   * in a headset feel like riding, and it is what a VRChat avatar gives you. What has to go is the head, which
   * the eyes are otherwise looking at the inside of.
   */
  function setFirstPerson(on: boolean) {
    if (firstPerson === on) return;
    firstPerson = on;
    applyFirstPerson();
  }

  /** Re-applied after a character swap, because the new body arrives with its head on. */
  function applyFirstPerson() { rider.setFirstPerson(firstPerson); }

  /**
   * Where the rider's hands ARE, when something is tracking them (docs/048): two world points, or null for every
   * ride whose hands the stance decides. Kept on the pose rather than passed through `update` because a headset
   * writes them at a different moment in the frame from the physics that drives everything else here.
   */
  function setHandTargets(a: RiderHandTarget | null, b: RiderHandTarget | null) {
    if (!a || !b) { handTargets = null; return; }
    handTargets ??= {
      a: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
      b: { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() },
    };
    handTargets.a.position.copy(a.position);
    handTargets.a.quaternion.copy(a.quaternion);
    handTargets.a.source = a.source;
    handTargets.a.handedness = a.handedness;
    handTargets.a.curl = a.curl ? { ...a.curl } : undefined;
    handTargets.b.position.copy(b.position);
    handTargets.b.quaternion.copy(b.quaternion);
    handTargets.b.source = b.source;
    handTargets.b.handedness = b.handedness;
    handTargets.b.curl = b.curl ? { ...b.curl } : undefined;
  }

  /** The headset is the local rider's exact eye-bridge viewpoint. It is stored alongside the asynchronously
   * sampled hands so the next rendered pose consumes one coherent tracked body instead of its authored glance. */
  function setHeadTarget(position: THREE.Vector3 | null, quaternion: THREE.Quaternion | null) {
    if (!position || !quaternion) { headTarget = null; return; }
    headTarget ??= {
      position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), exactPosition: true,
    };
    headTarget.position.copy(position);
    headTarget.quaternion.copy(quaternion);
  }

  /** Hand the live rider a different stance set. Nothing is rebuilt, so this costs no state at all — the
   * absorber, the arm sway and the glance carry straight through the change. */
  function setRiderStyle(id: string) {
    riderStyle = id;
    rider.setStyle(id);
  }

  // Every handle below is a getter, because a gear swap replaces the objects behind them mid-run.
  return {
    get board() { return boardModel.group; },
    /** Current gear outline used by both headset and desktop interaction rays. */
    get boardGrabBox() { return boardModel.grabBox; },
    get gear() { return gear; },
    get snowboardStance() { return snowboardStance; },
    get ankleFront() { return boardModel.ankleFront; },
    get ankleRear() { return boardModel.ankleRear; },
    get rider() { return rider; },
    update, seatBoard, setVisible, setRiderModel, setRiderStyle, setGear, setSnowboardStance,
    highlightBoard: (on: boolean) => boardModel.highlight(on),
    setEquipmentAppearance,
    setFirstPerson, setHandTargets,
    setHeadTarget, dispose,
  };
}

const SEAT_FALLBACK_FWD = new THREE.Vector3(0, 0, 1);
const SEAT_FALLBACK_RIGHT = new THREE.Vector3(1, 0, 0);

export type RiderPose = ReturnType<typeof createRiderPose>;
