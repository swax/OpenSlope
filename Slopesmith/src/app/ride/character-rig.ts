import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkeleton } from 'three/addons/utils/SkeletonUtils.js';
import { characterModelUrl } from '../net/asset-paths';
import { registerCharacterGlow } from './character-glow';
import { DEFAULT_RIDER_MODEL_ID, PROCEDURAL_RIDER_MODEL_ID } from './rider-models';
import { normalizedCharacterBoneName } from '../../core/characters/contract';

/** World-space landmarks produced by the existing rider IK/pose solver. */
export interface CharacterPose {
  /**
   * How the two feet are laid out under the body, which is also what `front`/`rear` mean everywhere below.
   *
   * `bindings` is a snowboard: the feet are astride the deck, front is its nose and rear its tail, and each
   * boot is yawed by its own binding angle. `forward` is everything else — on foot, and on skis — where the
   * feet are side by side, front is anatomical left and rear anatomical right, and both point along `toe`.
   * Crossing between the two re-reads the imported skeleton's handedness, because the labels changed meaning.
   */
  feet: 'bindings' | 'forward';
  /** Snowboard boot yaw in the pose's own front/rear ankle frame, radians. Standard mirrors and swaps these. */
  bindingFront: number;
  bindingRear: number;
  hips: THREE.Vector3;
  upperBack: THREE.Vector3;
  clavicleRoot: THREE.Vector3;
  headBone: THREE.Vector3;
  head: THREE.Vector3;
  hipFront: THREE.Vector3;
  kneeFront: THREE.Vector3;
  ankleFront: THREE.Vector3;
  hipRear: THREE.Vector3;
  kneeRear: THREE.Vector3;
  ankleRear: THREE.Vector3;
  shoulderFront: THREE.Vector3;
  elbowFront: THREE.Vector3;
  handFront: THREE.Vector3;
  /** Canonical tracked/rest hand frame: fingers and outward palm normal. */
  handFrontFinger: THREE.Vector3;
  handFrontPalm: THREE.Vector3;
  handFrontCurl: CharacterHandCurl | null;
  /** True when the hand is a TRACKED landmark — a controller or an optical wrist the wearer can see. The driver
   * then re-solves that arm from its own shoulder and bone lengths so the hand bone lands exactly there
   * (`poseArm`), instead of copying the solver's bone directions from a shoulder that is not quite its own. */
  handFrontTracked: boolean;
  shoulderRear: THREE.Vector3;
  elbowRear: THREE.Vector3;
  handRear: THREE.Vector3;
  handRearFinger: THREE.Vector3;
  handRearPalm: THREE.Vector3;
  handRearCurl: CharacterHandCurl | null;
  handRearTracked: boolean;
  up: THREE.Vector3;
  toe: THREE.Vector3;
  along: THREE.Vector3;
  headUp: THREE.Vector3;
  headForward: THREE.Vector3;
  /** Actual banked deck normal; feet use this instead of the independently balanced body-up axis. */
  soleUp: THREE.Vector3;
}

export interface CharacterHandCurl {
  thumb: number;
  index: number;
  middle: number;
  ring: number;
  pinky: number;
}

export interface CharacterRigHandle {
  pose(pose: CharacterPose): void;
  /** Convert WebXR's palm-centred controller grip into this avatar's wrist-bone position. */
  gripToWrist(handedness: 'left' | 'right', rotation: THREE.Quaternion, out: THREE.Vector3): THREE.Vector3;
  /** Draw the character from inside its own head (docs/048): collapse the head so the eyes are not inside it. */
  setFirstPerson(on: boolean): void;
  dispose(): void;
}

type DrivenBoneName =
  | 'Hips' | 'Spine' | 'Chest' | 'Neck' | 'Head'
  | 'Pelvis.L' | 'Pelvis.R'
  | 'Clavicle.L' | 'Clavicle.R'
  | 'UpperArm.L' | 'LowerArm.L' | 'Hand.L'
  | 'UpperArm.R' | 'LowerArm.R' | 'Hand.R'
  | 'UpperLeg.L' | 'LowerLeg.L' | 'Foot.L'
  | 'UpperLeg.R' | 'LowerLeg.R' | 'Foot.R';

const OPTIONAL_BONES = new Set<DrivenBoneName>([
  'Spine', 'Neck', 'Pelvis.L', 'Pelvis.R', 'Clavicle.L', 'Clavicle.R',
]);
const DRIVEN_BONES: DrivenBoneName[] = [
  'Hips', 'Spine', 'Chest', 'Neck', 'Head',
  'Pelvis.L', 'Pelvis.R', 'Clavicle.L', 'Clavicle.R',
  'UpperArm.L', 'LowerArm.L', 'Hand.L', 'UpperArm.R', 'LowerArm.R', 'Hand.R',
  'UpperLeg.L', 'LowerLeg.L', 'Foot.L', 'UpperLeg.R', 'LowerLeg.R', 'Foot.R',
];
const HIPS_LENGTH = 0.14;
/** @internal Proximal-to-distal bends, exported so a hand-authored rig can be checked against the angles it
 * will actually be posed with. A full grip closes into the palm without folding the fingertip back through
 * it — and note these do not vary by digit, so a THUMB with three segments folds through 218 degrees. Two is
 * what a hand authored for this driver should give it (docs/030). */
export const FINGER_CURL_ANGLES = [1.15, 1.45, 1.2, 0.9] as const;
/** What the head bone shrinks to in first person (docs/048). Small enough to vanish, non-zero so the bone
 *  matrix stays invertible — a singular one takes the entire skinned body with it on some drivers. */
const HEAD_HIDE_SCALE = 1e-3;

/**
 * How a hand's pronation is shared along the arm, as fractions of the total measured at the wrist.
 *
 * A rider's hands are rarely in the orientation a bind pose left them, and on a board they are rarely near
 * it: between the arm's neutral roll and the tracked palm there is routinely 120 degrees or more of twist.
 * SOMETHING has to absorb that, and whichever joint does it alone is the one that pinches — a forearm given
 * the whole amount leaves the elbow's blended vertices wrapped around their own axis, which is the
 * candy-wrapper collapse every skinned arm is prone to.
 *
 * So it is split three ways: the shoulder takes 0.30, the forearm 0.65 — leaving the elbow the 0.35 between
 * them — and the wrist the remaining 0.35. That is anatomically where it goes, too: pronation is the radius
 * crossing the ulna along the whole forearm, with humeral rotation carrying the rest, not a hinge at either
 * end. Raising `FOREARM` toward 1 moves the twist back onto the elbow; lowering it moves it to the wrist.
 */
const SHOULDER_TWIST_SHARE = 0.30, FOREARM_TWIST_SHARE = 0.65;

interface BoneState {
  bone: THREE.Bone;
  restLocalPosition: THREE.Vector3;
  restWorldScale: THREE.Vector3;
  restWorldRotation: THREE.Quaternion;
}

type HandBoneName = 'Hand.L' | 'Hand.R';
type FingerDigit = keyof CharacterHandCurl;
interface HandFrameState {
  finger: THREE.Vector3;
  palm: THREE.Vector3;
  /** Wrist bone to middle-finger base in the uniformly fitted model. */
  palmLength: number;
}
interface FingerState {
  bone: THREE.Bone;
  restLocalRotation: THREE.Quaternion;
  curlAxis: THREE.Vector3;
  digit: FingerDigit;
  segment: number;
}

const templatePromises = new Map<string, Promise<THREE.Group>>();
const DEFAULT_PALM_LENGTH = 0.10;

/** Imported Mixamo accessory/finger names retain their source prefix while the driven hand is renamed. */
function sourceBoneKey(name: string): string {
  return normalizedCharacterBoneName(name).replace(/^mixamorig\d*/i, '');
}

function loadTemplate(modelId: string): Promise<THREE.Group> | null {
  if (typeof window === 'undefined' || modelId === PROCEDURAL_RIDER_MODEL_ID) return null;
  const url = characterModelUrl(modelId);
  let request = templatePromises.get(url);
  if (!request) {
    // Registered on the TEMPLATE, once, before anything clones it: clones share their materials, so this is
    // also the only place the scroll can be picked up without doing it again per rider.
    request = new GLTFLoader().loadAsync(url).then(gltf => {
      registerCharacterGlow(gltf.scene);
      return gltf.scene;
    });
    templatePromises.set(url, request);
  }
  return request;
}

/**
 * Drive a canonical custom-character skin from the same pose directions used to draw the procedural rider.
 * Hips take the solver's world anchor; every descendant keeps its imported offset from its posed parent and
 * receives only the target orientation. This is rotation retargeting, not a second anatomy fit: broad armor,
 * dresses, shoulder widths and limb thickness retain the proportions established by the uniform import fit.
 */
class DrivenCharacterRig {
  private readonly bones = new Map<DrivenBoneName, BoneState>();
  private readonly handFrames = new Map<HandBoneName, HandFrameState>();
  private readonly fingers: Record<'left' | 'right', FingerState[]> = { left: [], right: [] };
  private readonly restUp: THREE.Vector3;
  /** The import's own upper-arm and forearm lengths, world metres at bind: what a tracked arm is solved with. */
  private readonly armLengths: Record<'L' | 'R', { upper: number; lower: number }>;
  private sideSwap: boolean | null = null;
  private lastFeet: CharacterPose['feet'] | null = null;
  /**
   * First person (docs/048). A character is ONE skinned mesh, so its head cannot be hidden by hiding an object:
   * there is no head object, only head-weighted vertices. Scaling the head BONE to nothing collapses exactly
   * those vertices into the neck, which is the same trick VRChat plays on your own avatar — and it needs no
   * per-model authoring, so an imported Mixamo character works on the day it is dropped in.
   */
  private firstPerson = false;

  constructor(private readonly root: THREE.Group) {
    root.updateMatrixWorld(true);
    this.restUp = new THREE.Vector3(0, 1, 0)
      .applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion())).normalize();
    const importedBones = new Map<string, THREE.Bone>();
    const sourceBones = new Map<string, THREE.Bone>();
    root.traverse(object => {
      if (!(object instanceof THREE.Bone)) return;
      importedBones.set(normalizedCharacterBoneName(object.name), object);
      sourceBones.set(sourceBoneKey(object.name), object);
    });
    for (const name of DRIVEN_BONES) {
      // GLTFLoader removes punctuation that Three's animation paths reserve, so Blender's `UpperArm.L`
      // commonly arrives as `UpperArmL`. Match the authored name first and its normalized form second.
      const object = root.getObjectByName(name) ?? importedBones.get(normalizedCharacterBoneName(name));
      if (!(object instanceof THREE.Bone)) {
        if (OPTIONAL_BONES.has(name)) continue;
        throw new Error(`Character rig is missing bone ${name}`);
      }
      object.matrixAutoUpdate = false;
      const restWorldRotation = object.getWorldQuaternion(new THREE.Quaternion());
      this.bones.set(name, {
        bone: object,
        restLocalPosition: object.position.clone(),
        restWorldScale: object.getWorldScale(new THREE.Vector3()),
        restWorldRotation,
      });
    }
    this.armLengths = { L: this.measureArm('L'), R: this.measureArm('R') };
    this.captureHandFrames(sourceBones);
  }

  private measureArm(side: 'L' | 'R') {
    const at = (name: DrivenBoneName) => this.bones.get(name)!.bone.getWorldPosition(new THREE.Vector3());
    const shoulder = at(`UpperArm.${side}`), elbow = at(`LowerArm.${side}`), hand = at(`Hand.${side}`);
    return { upper: shoulder.distanceTo(elbow), lower: elbow.distanceTo(hand) };
  }

  setFirstPerson(on: boolean) { this.firstPerson = on; }

  pose(p: CharacterPose) {
    this.root.updateWorldMatrix(true, true);
    // Front/rear means nose/tail on a snowboard and anatomical left/right whenever the feet face forward.
    // Re-evaluate the imported skeleton's handedness at that boundary so entering Play — or swapping a board
    // for a pair of skis mid-run — cannot inherit the previous layout's assignment.
    if (this.lastFeet !== p.feet) {
      this.lastFeet = p.feet;
      this.sideSwap = null;
    }

    // Hips is the anatomical bottom-spine segment. Point its authored 14 cm length toward upperBack, then let
    // optional Spine continue from that exact tail. A world-up helper leaves an orphan tail in a crouch; making
    // Spine branch separately from the hips pivot hides the orphan but duplicates the lower-back segment.
    _hipsTail.copy(p.upperBack).sub(p.hips);
    if (_hipsTail.lengthSq() < 1e-8) _hipsTail.copy(p.up); else _hipsTail.normalize();
    _hipsTail.multiplyScalar(HIPS_LENGTH).add(p.hips);
    this.aim('Hips', p.hips, _hipsTail, p.toe);
    // The shoulder line supplies the chest's axial rotation, so a torso turns with the shoulders a stance swings
    // around it rather than facing the board's toe edge whatever they do. Y(spine) × X(side-to-side) gives the
    // chest's local +Z/front axis.
    _chestAxis.copy(p.clavicleRoot).sub(p.upperBack);
    _shoulderSpan.copy(p.shoulderFront).sub(p.shoulderRear);
    _chestForward.crossVectors(_chestAxis, _shoulderSpan);
    if (_chestForward.lengthSq() < 1e-8) _chestForward.copy(p.toe);
    else _chestForward.normalize();
    this.aimOptional('Spine', _hipsTail, p.upperBack, p.toe);
    this.aim('Chest', p.upperBack, p.clavicleRoot, _chestForward);
    this.aimOptional('Neck', p.clavicleRoot, p.headBone, _chestForward);
    // The solver's own gaze, not the board's along axis: it carries the glance and any head stabilisation.
    this.aim('Head', p.headBone, p.head, p.headForward);

    if (this.sideSwap === null) {
      // After the hips take their ride basis, see which way the imported anatomical-left chain actually landed
      // along the board. Mixamo variants and hand-authored rigs do not all share the same handedness. Cache this
      // bind-space answer: using labels alone made the rear-origin limbs reach through the body to front targets.
      this.bones.get('UpperLeg.L')!.bone.getWorldPosition(_sideL);
      this.bones.get('UpperLeg.R')!.bone.getWorldPosition(_sideR);
      this.sideSwap = _sideL.sub(_sideR).dot(p.along) < 0;
    }
    const swap = this.sideSwap;
    const hipL = swap ? p.hipRear : p.hipFront;
    const kneeL = swap ? p.kneeRear : p.kneeFront;
    const ankleL = swap ? p.ankleRear : p.ankleFront;
    const hipR = swap ? p.hipFront : p.hipRear;
    const kneeR = swap ? p.kneeFront : p.kneeRear;
    const ankleR = swap ? p.ankleFront : p.ankleRear;

    this.aimOptional('Pelvis.L', p.hips, hipL, p.up);
    this.aim('UpperLeg.L', hipL, kneeL, p.toe);
    this.aim('LowerLeg.L', kneeL, ankleL, p.toe);
    const bindings = p.feet === 'bindings';
    if (bindings) boardFootAxes(p, _boardToe, _boardAlong);
    if (bindings) footDirection(
      _footDirection, _boardToe, _boardAlong, swap ? p.bindingRear : p.bindingFront,
    );
    else _footDirection.copy(p.toe);
    this.orientFoot('Foot.L', _footDirection, p.soleUp);

    this.aimOptional('Pelvis.R', p.hips, hipR, p.up);
    this.aim('UpperLeg.R', hipR, kneeR, p.toe);
    this.aim('LowerLeg.R', kneeR, ankleR, p.toe);
    if (bindings) footDirection(
      _footDirection, _boardToe, _boardAlong, swap ? p.bindingFront : p.bindingRear,
    );
    else _footDirection.copy(p.toe);
    this.orientFoot('Foot.R', _footDirection, p.soleUp);

    const shoulderL = swap ? p.shoulderRear : p.shoulderFront;
    const elbowL = swap ? p.elbowRear : p.elbowFront;
    const handL = swap ? p.handRear : p.handFront;
    const handFingerL = swap ? p.handRearFinger : p.handFrontFinger;
    const handPalmL = swap ? p.handRearPalm : p.handFrontPalm;
    const shoulderR = swap ? p.shoulderFront : p.shoulderRear;
    const elbowR = swap ? p.elbowFront : p.elbowRear;
    const handR = swap ? p.handFront : p.handRear;
    const handFingerR = swap ? p.handFrontFinger : p.handRearFinger;
    const handPalmR = swap ? p.handFrontPalm : p.handRearPalm;
    this.poseArm('L', p, shoulderL, elbowL, handL, handFingerL, handPalmL,
      swap ? p.handRearTracked : p.handFrontTracked, _handRotationL, _upperRollL, _forearmRollL);
    this.poseArm('R', p, shoulderR, elbowR, handR, handFingerR, handPalmR,
      swap ? p.handFrontTracked : p.handRearTracked, _handRotationR, _upperRollR, _forearmRollR);
    this.poseFingers('left', swap ? p.handRearCurl : p.handFrontCurl);
    this.poseFingers('right', swap ? p.handFrontCurl : p.handRearCurl);

    this.root.updateWorldMatrix(true, true);
  }

  /**
   * One arm. Its shoulder, elbow and hand are the procedural solver's landmarks, and an authored arm simply
   * copies their two bone directions: where its hand then lands is the imported anatomy's business.
   *
   * A TRACKED hand is not. It is a controller, or an optically tracked wrist, and the wearer is looking at both
   * it and the glove that is supposed to be on it — so the glove must land there, and copying directions cannot
   * put it there. The imported shoulder is never exactly the landmark shoulder: the tracked torso is spanned
   * hips-to-skull afresh each frame while the imported spine keeps its bind lengths (3 cm apart on foot, 7 cm in
   * a crouch, measured on the built-ins), and an arm aimed from the wrong root lands its hand wrong by the same
   * amount, differently in every pose, which reads as a glove floating loosely around the controller. So a
   * tracked arm is re-solved from the bone it actually hangs from: the same two-bone solve as the landmark arm,
   * from THIS skeleton's shoulder with THIS skeleton's bone lengths, bent in the landmark's own plane. The
   * lengths stay the import's and only rotations are written — this changes what the bones point at, not what
   * they are. A controller past full extension still straightens the arm toward it, exactly as the landmark
   * solver does, and the hand falls short by the reach it does not have.
   */
  private poseArm(side: 'L' | 'R', p: CharacterPose, shoulder: THREE.Vector3, elbow: THREE.Vector3,
                  hand: THREE.Vector3, finger: THREE.Vector3, palm: THREE.Vector3, tracked: boolean,
                  handRotation: THREE.Quaternion, upperRoll: THREE.Vector3, forearmRoll: THREE.Vector3) {
    const upper = `UpperArm.${side}` as const, lower = `LowerArm.${side}` as const;
    const handBone = `Hand.${side}` as const;
    this.aimOptional(`Clavicle.${side}`, p.clavicleRoot, shoulder, _chestAxis);
    let root = shoulder, mid = elbow;
    if (tracked) {
      root = this.boneHead(upper, _armRoot);
      _armBend.copy(elbow).sub(_armChord.copy(shoulder).add(hand).multiplyScalar(0.5));
      if (_armBend.lengthSq() < 1e-10) _armBend.copy(p.toe);
      const lengths = this.armLengths[side];
      mid = solveArmElbow(root, hand, lengths.upper, lengths.lower, _armBend, _armElbow);
    }
    // The hand resolves first: both arm bones' rolls are derived from where it ends up, so that the twist
    // between here and there can be shared out rather than landing wherever it falls.
    this.handRotation(handBone, finger, palm, handRotation);
    this.armRolls(lower, handBone, handRotation, p.toe, root, mid, hand, upperRoll, forearmRoll);
    this.aim(upper, root, mid, upperRoll);
    this.aim(lower, mid, hand, forearmRoll);
    this.applyWorldRotation(handBone, hand, handRotation);
  }

  /** Where a bone's head sits beneath its already-posed parent: the imported offset, not a solver landmark. */
  private boneHead(name: DrivenBoneName, out: THREE.Vector3): THREE.Vector3 {
    const state = this.bones.get(name)!;
    const parent = state.bone.parent!;
    parent.updateWorldMatrix(true, false);
    return out.copy(state.restLocalPosition).applyMatrix4(parent.matrixWorld);
  }

  private aimOptional(name: DrivenBoneName, head: THREE.Vector3, tail: THREE.Vector3,
                      forward: THREE.Vector3) {
    if (this.bones.has(name)) this.aim(name, head, tail, forward);
  }

  private aim(name: DrivenBoneName, head: THREE.Vector3, tail: THREE.Vector3, forward: THREE.Vector3) {
    const length = _axisY.copy(tail).sub(head).length();
    if (length < 1e-5) return;
    _axisY.divideScalar(length);

    _axisZ.copy(forward).addScaledVector(_axisY, -forward.dot(_axisY));
    if (_axisZ.lengthSq() < 1e-8) {
      _axisZ.set(0, 0, 1).addScaledVector(_axisY, -_axisY.z);
      if (_axisZ.lengthSq() < 1e-8) _axisZ.set(1, 0, 0).addScaledVector(_axisY, -_axisY.x);
    }
    _axisZ.normalize();
    _axisX.crossVectors(_axisY, _axisZ).normalize();
    _axisZ.crossVectors(_axisX, _axisY).normalize();
    _basis.makeBasis(_axisX, _axisY, _axisZ);
    _rotation.setFromRotationMatrix(_basis);

    this.applyWorldRotation(name, head, _rotation);
  }

  /** A hand's bind rotation does not promise that local +Z is its palm. Mixamo fingers retain their authored
   * anatomy, so recover the finger/thumb frame once and rotate that whole frame onto the tracked palm. */
  private captureHandFrames(sourceBones: Map<string, THREE.Bone>) {
    for (const [name, side] of [['Hand.L', 'left'], ['Hand.R', 'right']] as const) {
      const hand = this.bones.get(name)!;
      hand.bone.getWorldPosition(_restHandHead);
      const middle = sourceBones.get(`${side}handmiddle1`);
      const thumb = sourceBones.get(`${side}handthumb1`);
      const finger = middle
        ? middle.getWorldPosition(new THREE.Vector3()).sub(_restHandHead)
        : new THREE.Vector3(0, 1, 0).applyQuaternion(hand.restWorldRotation);
      const palmLength = finger.length() || DEFAULT_PALM_LENGTH;
      finger.normalize();
      const palm = new THREE.Vector3();
      if (thumb) {
        thumb.getWorldPosition(_restThumb).sub(_restHandHead);
        if (side === 'left') palm.crossVectors(finger, _restThumb);
        else palm.crossVectors(_restThumb, finger);
      }
      // The Mixamo normalizer makes hand +Z thumb-up; its mirrored +/-X is therefore the palm when a model has
      // no finger hierarchy. Older/custom mitten rigs use this path; generated diagnostic hands provide digits.
      if (palm.lengthSq() < 1e-8) {
        palm.set(side === 'left' ? 1 : -1, 0, 0).applyQuaternion(hand.restWorldRotation);
      }
      palm.addScaledVector(finger, -palm.dot(finger)).normalize();
      this.handFrames.set(name, { finger, palm, palmLength });
    }

    for (const [key, bone] of sourceBones) {
      const match = /^(left|right)hand(thumb|index|middle|ring|pinky)([1-4])$/.exec(key);
      if (!match) continue;
      const side = match[1] as 'left' | 'right';
      const digit = match[2] as FingerDigit;
      const segment = Number(match[3]);
      const next = sourceBones.get(`${side}hand${digit}${segment + 1}`);
      bone.getWorldPosition(_fingerHead);
      bone.getWorldQuaternion(_fingerWorldRotation);
      if (next) next.getWorldPosition(_fingerDirection).sub(_fingerHead);
      else _fingerDirection.set(0, 1, 0).applyQuaternion(_fingerWorldRotation);
      if (_fingerDirection.lengthSq() < 1e-8) continue;
      _fingerDirection.normalize();
      const palm = this.handFrames.get(side === 'left' ? 'Hand.L' : 'Hand.R')!.palm;
      fingerCurlAxis(_fingerDirection, palm, _fingerCurlAxis);
      if (_fingerCurlAxis.lengthSq() < 1e-8) continue;
      _fingerCurlAxis.normalize().applyQuaternion(_fingerInverse.copy(_fingerWorldRotation).invert());
      bone.matrixAutoUpdate = true;
      this.fingers[side].push({
        bone, digit, segment,
        restLocalRotation: bone.quaternion.clone(), curlAxis: _fingerCurlAxis.clone(),
      });
    }
  }

  private handRotation(name: HandBoneName, finger: THREE.Vector3, palm: THREE.Vector3,
                       out: THREE.Quaternion) {
    const state = this.bones.get(name)!;
    const rest = this.handFrames.get(name)!;
    retargetHandWorldRotation(state.restWorldRotation, rest.finger, rest.palm, finger, palm, out);
  }

  /**
   * Roll references for both arm bones, with the hand's pronation shared between them.
   *
   * `neutral` is the arm's untwisted reference — the same board direction the legs are poled toward — and
   * carrying the hand's whole bind-to-target delta onto the forearm (which is what this used to do) put every
   * degree of the difference across the elbow alone. Measuring that difference as an angle about the forearm
   * makes it something that can be divided: each bone is rolled off `neutral` by its own share, so the
   * shoulder, the elbow and the wrist each carry a third of what one joint used to.
   */
  private armRolls(lower: 'LowerArm.L' | 'LowerArm.R', hand: HandBoneName,
                   handTarget: THREE.Quaternion, neutral: THREE.Vector3,
                   shoulder: THREE.Vector3, elbow: THREE.Vector3, wrist: THREE.Vector3,
                   outUpper: THREE.Vector3, outLower: THREE.Vector3) {
    const lowerRest = this.bones.get(lower)!.restWorldRotation;
    const handRest = this.bones.get(hand)!.restWorldRotation;
    _handDelta.copy(handTarget).multiply(_inverseHandRest.copy(handRest).invert()).normalize();
    // Where the forearm would have to point for the WRIST to carry no twist at all: turned exactly as the
    // hand turned. The whole distance between `neutral` and this is the pronation being shared out.
    _rollAligned.set(0, 0, 1).applyQuaternion(lowerRest).applyQuaternion(_handDelta).normalize();

    _forearmAxis.copy(wrist).sub(elbow);
    _upperAxis.copy(elbow).sub(shoulder);
    if (_forearmAxis.lengthSq() < 1e-8 || _upperAxis.lengthSq() < 1e-8) {
      outUpper.copy(neutral);
      outLower.copy(_rollAligned);
      return;
    }
    _forearmAxis.normalize();
    _upperAxis.normalize();
    // Each bone turns about its OWN axis. With the elbow bent they differ, and rolling the upper arm about
    // the forearm's axis would tip it out of the plane rather than twist it.
    const pronation = axialTwist(_forearmAxis, neutral, _rollAligned);
    outUpper.copy(neutral).applyAxisAngle(_upperAxis, pronation * SHOULDER_TWIST_SHARE);
    outLower.copy(neutral).applyAxisAngle(_forearmAxis, pronation * FOREARM_TWIST_SHARE);
  }

  private poseFingers(side: 'left' | 'right', curl: CharacterHandCurl | null) {
    for (const finger of this.fingers[side]) {
      const amount = THREE.MathUtils.clamp(curl?.[finger.digit] ?? 0, 0, 1);
      const angle = FINGER_CURL_ANGLES[Math.min(finger.segment - 1, FINGER_CURL_ANGLES.length - 1)];
      finger.bone.quaternion.copy(finger.restLocalRotation)
        .multiply(_fingerCurlRotation.setFromAxisAngle(finger.curlAxis, amount * angle));
      finger.bone.updateMatrix();
      finger.bone.matrixWorldNeedsUpdate = true;
    }
  }

  gripToWrist(handedness: 'left' | 'right', rotation: THREE.Quaternion, out: THREE.Vector3) {
    const frame = this.handFrames.get(handedness === 'left' ? 'Hand.L' : 'Hand.R');
    return gripToWristOffset(rotation, frame?.palmLength ?? DEFAULT_PALM_LENGTH, out);
  }

  private orientFoot(name: 'Foot.L' | 'Foot.R', forward: THREE.Vector3, up: THREE.Vector3) {
    const state = this.bones.get(name)!;
    // Move the complete imported foot from its standing upright/facing frame into the board's sole/facing
    // frame. Applying that delta to the bind rotation preserves the authored bone-to-sole angle and local-axis
    // handedness, unlike aiming local +Y horizontally and guessing that local +/-X means sole-up.
    retargetFootWorldRotation(state.restWorldRotation, this.restUp, up, forward, _rotation);
    this.applyWorldRotation(name, _boneHead, _rotation);
  }

  private applyWorldRotation(name: DrivenBoneName, head: THREE.Vector3, rotation: THREE.Quaternion) {
    const state = this.bones.get(name)!;

    const parent = state.bone.parent;
    if (!parent) return;
    parent.updateWorldMatrix(true, false);
    // Only the hips are an absolute solver landmark. Pulling every descendant onto the procedural landmarks
    // pinched wide source rigs inward: cross-leg dress weights collapsed into a sheet and broad armored limbs
    // lost a dimension. Descendants instead keep their bind offset beneath the newly rotated parent.
    if (name === 'Hips') _boneHead.copy(head);
    else _boneHead.copy(state.restLocalPosition).applyMatrix4(parent.matrixWorld);
    // ONE bone may depart from the imported scale, and only to disappear: the first-person head (docs/048).
    // Everything else composes the uniformly fitted import untouched — a per-bone proportion fit at runtime is
    // exactly what `test/mixamo-character.test.ts` exists to prevent, because Mixamo landmark placement varies
    // wildly between otherwise valid avatars. Not scaled to exactly zero: a singular bone matrix yields a NaN
    // skinning normal matrix on some drivers, which loses the WHOLE body rather than just its head.
    if (this.firstPerson && name === 'Head') {
      _world.compose(_boneHead, rotation, _headHidden.copy(state.restWorldScale).multiplyScalar(HEAD_HIDE_SCALE));
    }
    else _world.compose(_boneHead, rotation, state.restWorldScale);
    _local.copy(parent.matrixWorld).invert().multiply(_world);
    state.bone.matrix.copy(_local);
    state.bone.matrixWorldNeedsUpdate = true;
    state.bone.updateMatrixWorld(true);
  }
}

/** @internal Drive a character group directly. `attachCharacterRig` fetches its model, which a headless
 * check cannot; this takes an already-built one so the retargeting itself can be measured. */
export function createCharacterDriver(root: THREE.Group) {
  return new DrivenCharacterRig(root);
}

function footDirection(out: THREE.Vector3, toe: THREE.Vector3, along: THREE.Vector3, angle: number) {
  return out.copy(toe).multiplyScalar(Math.cos(angle)).addScaledVector(along, Math.sin(angle)).normalize();
}

/** Build a right-handed frame whose +Y is sole-up and whose +Z is the foot's direction in that sole plane. */
function footFrame(up: THREE.Vector3, forward: THREE.Vector3, out: THREE.Quaternion) {
  _frameY.copy(up).normalize();
  _frameZ.copy(forward).addScaledVector(_frameY, -forward.dot(_frameY));
  if (_frameZ.lengthSq() < 1e-8) _frameZ.set(0, 0, 1).addScaledVector(_frameY, -_frameY.z);
  if (_frameZ.lengthSq() < 1e-8) _frameZ.set(1, 0, 0).addScaledVector(_frameY, -_frameY.x);
  _frameZ.normalize();
  _frameX.crossVectors(_frameY, _frameZ).normalize();
  _frameZ.crossVectors(_frameX, _frameY).normalize();
  _footBasis.makeBasis(_frameX, _frameY, _frameZ);
  return out.setFromRotationMatrix(_footBasis);
}

/** @internal Exact foot bind-frame retargeting, exported so the invariant can be covered without WebGL. */
export function retargetFootWorldRotation(restWorldRotation: THREE.Quaternion, restUp: THREE.Vector3,
                                          targetUp: THREE.Vector3, targetForward: THREE.Vector3,
                                          out = new THREE.Quaternion()) {
  // A humanoid foot bone runs from ankle toward ToeBase, commonly 25-45 degrees below its actual sole.
  // Hand-authored rigs may additionally mirror either local transverse axis. The delta between these two
  // surrounding sole frames retains both facts because it rotates the complete bind quaternion unchanged.
  _restFootForward.set(0, 1, 0).applyQuaternion(restWorldRotation);
  footFrame(restUp, _restFootForward, _restFootFrame);
  footFrame(targetUp, targetForward, _targetFootFrame);
  return out.copy(_targetFootFrame)
    .multiply(_inverseFootFrame.copy(_restFootFrame).invert())
    .multiply(restWorldRotation);
}

function handFrame(finger: THREE.Vector3, palm: THREE.Vector3, out: THREE.Quaternion) {
  _handFrameY.copy(finger).normalize();
  _handFrameZ.copy(palm).addScaledVector(_handFrameY, -palm.dot(_handFrameY));
  if (_handFrameZ.lengthSq() < 1e-8) _handFrameZ.set(0, 0, 1).addScaledVector(_handFrameY, -_handFrameY.z);
  if (_handFrameZ.lengthSq() < 1e-8) _handFrameZ.set(1, 0, 0).addScaledVector(_handFrameY, -_handFrameY.x);
  _handFrameZ.normalize();
  _handFrameX.crossVectors(_handFrameY, _handFrameZ).normalize();
  _handFrameZ.crossVectors(_handFrameX, _handFrameY).normalize();
  return out.setFromRotationMatrix(_handBasis.makeBasis(_handFrameX, _handFrameY, _handFrameZ));
}

/**
 * @internal Signed rotation about `axis` (unit) taking `from` to `to`, ignoring whatever either does along
 * the axis itself. This is what makes "how twisted is this joint" a number rather than an impression, and it
 * is exported so a check can measure the same thing the driver just divided up.
 */
export function axialTwist(axis: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3): number {
  _twistFrom.copy(from).addScaledVector(axis, -from.dot(axis));
  _twistTo.copy(to).addScaledVector(axis, -to.dot(axis));
  if (_twistFrom.lengthSq() < 1e-10 || _twistTo.lengthSq() < 1e-10) return 0;
  _twistFrom.normalize();
  _twistTo.normalize();
  const angle = Math.acos(THREE.MathUtils.clamp(_twistFrom.dot(_twistTo), -1, 1));
  return _twistCross.crossVectors(_twistFrom, _twistTo).dot(axis) < 0 ? -angle : angle;
}

/**
 * @internal Two-bone solve for a tracked arm: the elbow on the circle the cosine rule allows about the
 * shoulder→hand chord, swung toward `pole`. A hand past full extension straightens the arm toward it. The same
 * solve the landmark rider uses, applied to the imported skeleton's own root and lengths.
 */
export function solveArmElbow(root: THREE.Vector3, tip: THREE.Vector3, upper: number, lower: number,
                              pole: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  const dir = _armDir.copy(tip).sub(root);
  const d = dir.length();
  if (d < 1e-5) dir.set(0, -1, 0); else dir.divideScalar(d);
  const reach = THREE.MathUtils.clamp(d, Math.abs(upper - lower) + 1e-3, upper + lower - 1e-3);
  const cosA = (upper * upper + reach * reach - lower * lower) / (2 * upper * reach);
  const a = Math.acos(THREE.MathUtils.clamp(cosA, -1, 1));
  const perp = _armPerp.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (perp.lengthSq() < 1e-8) perp.set(dir.y, -dir.x, 0);
  perp.normalize();
  return out.copy(root).addScaledVector(dir, upper * Math.cos(a)).addScaledVector(perp, upper * Math.sin(a));
}

/** @internal Positive curl turns an extended digit toward the side its open palm faces. */
export function fingerCurlAxis(finger: THREE.Vector3, palm: THREE.Vector3,
                               out = new THREE.Vector3()): THREE.Vector3 {
  out.crossVectors(finger, palm);
  return out.lengthSq() < 1e-8 ? out.set(1, 0, 0) : out.normalize();
}

/** @internal The controller stays at WebXR's source-of-truth palm origin. Move the wrist behind it by the
 * selected model's palm length and slightly away from the palm face so the shell rests in, not behind, the hand. */
export function gripToWristOffset(rotation: THREE.Quaternion, palmLength = DEFAULT_PALM_LENGTH,
                                  out = new THREE.Vector3()): THREE.Vector3 {
  const along = THREE.MathUtils.clamp(palmLength * 0.55, 0.045, 0.075);
  const clearance = THREE.MathUtils.clamp(palmLength * 0.20, 0.016, 0.026);
  return out.set(0, -along, -clearance).applyQuaternion(rotation);
}

/** @internal Retarget the imported hand's actual anatomical bind frame, not an assumed local axis. This is what
 * keeps a palms-forward T-pose palms-forward and thumb-up on mirrored Mixamo hands. */
export function retargetHandWorldRotation(restWorldRotation: THREE.Quaternion,
                                          restFinger: THREE.Vector3, restPalm: THREE.Vector3,
                                          targetFinger: THREE.Vector3, targetPalm: THREE.Vector3,
                                          out = new THREE.Quaternion()) {
  handFrame(restFinger, restPalm, _restHandFrame);
  handFrame(targetFinger, targetPalm, _targetHandFrame);
  return out.copy(_targetHandFrame)
    .multiply(_inverseHandFrame.copy(_restHandFrame).invert())
    .multiply(restWorldRotation).normalize();
}

/** The bindings live in the board plane, not the body-balance plane. Rebuild its long/toe axes from the two
 * ankle seats plus the actual banked sole normal so a world-upright torso cannot lift the imported toe bones. */
function boardFootAxes(p: CharacterPose, toe: THREE.Vector3, along: THREE.Vector3) {
  along.copy(p.ankleFront).sub(p.ankleRear);
  if (along.lengthSq() < 1e-8) along.copy(p.along); else along.normalize();
  toe.crossVectors(p.soleUp, along);
  if (toe.lengthSq() < 1e-8) toe.copy(p.toe); else toe.normalize();
}

/** Attach the asset asynchronously; the procedural body remains the failure/loading fallback. */
export function attachCharacterRig(owner: THREE.Group, procedural: THREE.Object3D,
                                   modelId = DEFAULT_RIDER_MODEL_ID): CharacterRigHandle {
  let alive = true;
  let model: THREE.Group | null = null;
  let driver: DrivenCharacterRig | null = null;
  let latestPose: CharacterPose | null = null;
  let firstPerson = false;
  owner.userData.riderVisual = 'procedural';

  loadTemplate(modelId)?.then(template => {
    if (!alive) return;
    const clone = cloneSkeleton(template) as THREE.Group;
    clone.name = `rider.model.${modelId}`;
    clone.traverse(object => {
      object.raycast = () => {};
      if (object instanceof THREE.SkinnedMesh) object.frustumCulled = false;
    });
    owner.add(clone);
    let nextDriver: DrivenCharacterRig;
    try {
      clone.updateMatrixWorld(true);
      nextDriver = new DrivenCharacterRig(clone);
    } catch (error) {
      owner.remove(clone);
      throw error;
    }
    if (!alive) { owner.remove(clone); return; }
    model = clone;
    driver = nextDriver;
    driver.setFirstPerson(firstPerson); // a VR ride may have asked for this while the GLB was still in flight
    if (latestPose) driver.pose(latestPose);
    procedural.visible = false;
    owner.userData.riderVisual = modelId;
  }).catch(error => {
    console.warn(`Rider model ${modelId} did not load; keeping the procedural rider.`, error);
  });

  return {
    // Keep the latest solved landmarks even while the GLB is in flight. This seats a model immediately when it
    // finishes loading during a paused ride, where no subsequent animation frame will call pose again.
    pose: pose => { latestPose = pose; driver?.pose(pose); },
    gripToWrist: (handedness, rotation, out) => driver
      ? driver.gripToWrist(handedness, rotation, out)
      : gripToWristOffset(rotation, DEFAULT_PALM_LENGTH, out),
    setFirstPerson: on => {
      firstPerson = on;
      driver?.setFirstPerson(on);
      if (latestPose) driver?.pose(latestPose); // take effect now, not on the next animated frame
    },
    dispose: () => {
      alive = false;
      if (model) owner.remove(model);
      model = null;
      driver = null;
      latestPose = null;
    },
  };
}

const _hipsTail = new THREE.Vector3(), _footDirection = new THREE.Vector3();
const _boardToe = new THREE.Vector3(), _boardAlong = new THREE.Vector3();
const _restFootForward = new THREE.Vector3();
const _frameX = new THREE.Vector3(), _frameY = new THREE.Vector3(), _frameZ = new THREE.Vector3();
const _restFootFrame = new THREE.Quaternion(), _targetFootFrame = new THREE.Quaternion();
const _inverseFootFrame = new THREE.Quaternion();
const _footBasis = new THREE.Matrix4();
const _chestAxis = new THREE.Vector3(), _shoulderSpan = new THREE.Vector3(), _chestForward = new THREE.Vector3();
const _axisX = new THREE.Vector3(), _axisY = new THREE.Vector3(), _axisZ = new THREE.Vector3();
const _rotation = new THREE.Quaternion();
const _basis = new THREE.Matrix4(), _world = new THREE.Matrix4(), _local = new THREE.Matrix4();
const _boneHead = new THREE.Vector3();
const _headHidden = new THREE.Vector3();
const _sideL = new THREE.Vector3(), _sideR = new THREE.Vector3();
const _restHandHead = new THREE.Vector3(), _restThumb = new THREE.Vector3();
const _fingerHead = new THREE.Vector3(), _fingerDirection = new THREE.Vector3(), _fingerCurlAxis = new THREE.Vector3();
const _fingerWorldRotation = new THREE.Quaternion(), _fingerInverse = new THREE.Quaternion();
const _fingerCurlRotation = new THREE.Quaternion();
const _handRotationL = new THREE.Quaternion(), _handRotationR = new THREE.Quaternion();
const _handDelta = new THREE.Quaternion(), _inverseHandRest = new THREE.Quaternion();
const _forearmRollL = new THREE.Vector3(), _forearmRollR = new THREE.Vector3();
const _upperRollL = new THREE.Vector3(), _upperRollR = new THREE.Vector3();
const _rollAligned = new THREE.Vector3(), _forearmAxis = new THREE.Vector3(), _upperAxis = new THREE.Vector3();
const _armRoot = new THREE.Vector3(), _armElbow = new THREE.Vector3(), _armBend = new THREE.Vector3();
const _armChord = new THREE.Vector3(), _armDir = new THREE.Vector3(), _armPerp = new THREE.Vector3();
const _twistFrom = new THREE.Vector3(), _twistTo = new THREE.Vector3(), _twistCross = new THREE.Vector3();
const _handFrameX = new THREE.Vector3(), _handFrameY = new THREE.Vector3(), _handFrameZ = new THREE.Vector3();
const _restHandFrame = new THREE.Quaternion(), _targetHandFrame = new THREE.Quaternion();
const _inverseHandFrame = new THREE.Quaternion(), _handBasis = new THREE.Matrix4();
