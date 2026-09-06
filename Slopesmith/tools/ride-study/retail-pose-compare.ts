import * as THREE from 'three';
import { readFileSync } from 'node:fs';
import { createBoard } from '../../src/app/ride/gear';
import { createRider, type RiderInput } from '../../src/app/ride/rider';
import { ridingStyleOptions } from '../../src/app/ride/stances';
import { RIDE_GROUND_TANGENTIAL_PULL } from '../../src/app/ride/ride-contract.generated';

/**
 * Measure our stances in the frame retail's own rider was measured in, so the two can be read off one table.
 *
 * This is a measuring instrument, not a test: it asserts nothing and fails nothing. It exists because every
 * previous round of stance tuning compared a number in our world axes against an estimate of what retail
 * "looks like", and those are not the same quantity. `rider_telemetry.py rig-study` reports retail joints as
 * metres from the ankle midpoint on the board's own axes; this prints ours the same way.
 *
 * With no argument it prints our numbers beside the retail anchors recorded in [Trailmap: 240-models-mpf],
 * which come from the authored ride clips. Given a `rig-study --json-out` document it prints the live retail
 * pose from that capture instead, which is the stronger comparison: the drawn pose includes whatever the
 * engine layers on top of the clip, and it is what a player actually sees.
 *
 *   `npx tsx tools/ride-study/retail-pose-compare.ts`
 *   `npx tsx tools/ride-study/retail-pose-compare.ts` -- path/to/rig-study.json
 */

/**
 * Measured retail values from [Trailmap: 240-models-mpf], Mac body skeleton, authored regular ride clips.
 * Five summary measurements (joint offsets in metres) taken off those clips for calibration; no clip data,
 * curves, or timing are reproduced here.
 */
const RETAIL_CLIP_ANCHORS = {
  source: 'authored ride clips (240-afl-ride)',
  neutralHips: { toe: -0.042, up: 0.776, front: -0.055 },
  /** Clip midpoints. Heel-side puts the pelvis 38.3 cm heelward, toe-side 26.9 cm toeward. */
  heelHipsToe: -0.383,
  toeHipsToe: 0.269,
};

const neutral: RiderInput = {
  ankleFront: new THREE.Vector3(0, 0, 0.27),
  ankleRear: new THREE.Vector3(0, 0, -0.27),
  deckUp: new THREE.Vector3(0, 1, 0),
  soleUp: new THREE.Vector3(0, 1, 0),
  bank: 0,
  vel: new THREE.Vector3(),
  accel: new THREE.Vector3(),
  grounded: true,
  dt: 1 / 60,
  crouch: 0,
  lean: 0,
};

const boardModel = createBoard();

/** The same carve `rider-pose.test.ts` builds: bindings roll with the deck and the turn's own load is carried. */
function carving(lean: number, bankDeg: number): RiderInput {
  const faceDir = new THREE.Vector3(0, 0, 1), deckUp = new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(deckUp, faceDir).normalize();
  const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, deckUp, faceDir));
  q.premultiply(new THREE.Quaternion().setFromAxisAngle(faceDir, -bankDeg * Math.PI / 180));
  return {
    ...neutral,
    ankleFront: boardModel.ankleFront.clone().applyQuaternion(q),
    ankleRear: boardModel.ankleRear.clone().applyQuaternion(q),
    soleUp: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    bank: bankDeg, lean, vel: new THREE.Vector3(0, 0, 22),
    accel: new THREE.Vector3(RIDE_GROUND_TANGENTIAL_PULL * Math.tan(bankDeg * Math.PI / 180), 0, 0),
  };
}

/**
 * Rebuild the board frame the retail study reports in: origin at the ankle midpoint, +X toe, +Y deck up,
 * +Z toward the front ankle. Reading joints here removes the deck's own roll from the measurement, which is
 * the entire difference between "the body swings" and "the board swings and carries the body".
 */
function boardFrame(input: RiderInput) {
  const front = input.ankleFront, rear = input.ankleRear;
  const origin = front.clone().add(rear).multiplyScalar(0.5);
  const forward = front.clone().sub(rear).normalize();
  const up = input.soleUp.clone().normalize();
  const toe = new THREE.Vector3().crossVectors(up, forward).normalize();
  return (world: THREE.Vector3) => {
    const local = world.clone().sub(origin);
    return { toe: local.dot(toe), up: local.dot(up), front: local.dot(forward) };
  };
}

const JOINTS = ['hips', 'head', 'knee-front', 'knee-rear', 'clavicle-root'] as const;
type Joint = typeof JOINTS[number];
type Frame = Record<Joint, { toe: number; up: number; front: number }>;

function poseIn(styleId: string, input: RiderInput): Frame {
  const rider = createRider(undefined, styleId);
  rider.reset(neutral);
  for (let frame = 0; frame < 180; frame++) rider.pose(input);
  const toLocal = boardFrame(input);
  const out = {} as Frame;
  for (const name of JOINTS) {
    const node = rider.group.getObjectByName(`rider.${name}`);
    if (!node) throw new Error(`missing named rider node ${name}`);
    out[name] = toLocal(node.position);
  }
  return out;
}

/** Included knee → hip → neck angle, in the board frame so it is independent of how far the deck rolled. */
function hipAngle(frame: Frame, knee: Joint): number {
  const v = (a: Frame[Joint], b: Frame[Joint]) =>
    new THREE.Vector3(a.toe - b.toe, a.up - b.up, a.front - b.front);
  return THREE.MathUtils.radToDeg(
    v(frame[knee], frame.hips).angleTo(v(frame['clavicle-root'], frame.hips)));
}

const cm = (value: number) => `${(value * 100).toFixed(1)}`;
const pad = (text: string, width: number) => text.padEnd(width);
const padStart = (text: string, width: number) => text.padStart(width);

/** Retail's live pose from a `rig-study --json-out` document, already in this frame and in metres. */
function retailFromStudy(path: string) {
  const report = JSON.parse(readFileSync(path, 'utf8'));
  const poses = report?.representativePoses;
  if (!poses) throw new Error(`${path} has no representativePoses; re-run rig-study with --json-out`);
  const bins = report.leanBins ?? {};
  const pick = (bin: string) => {
    const joints = poses[bin]?.jointsBoardFrameM;
    if (!joints) return null;
    const named = (options: string[]) => {
      const key = options.find(option => joints[option]);
      return key ? { toe: joints[key][0], up: joints[key][1], front: joints[key][2] } : null;
    };
    return {
      hips: named(['pelvis', 'root', 'hips', 'spine']),
      head: named(['head', 'skull', 'neck']),
      names: Object.keys(joints),
      mirrored: poses[bin]?.toeAxisMirrored === true,
      kneeLeadM: poses[bin]?.kneeLeadM ?? null,
    };
  };
  const banks = report.leanBinBankDeg ?? {};
  return {
    negative: pick('negative'), neutral: pick('neutral'), positive: pick('positive'),
    bins, banks, path,
  };
}

const studyPath = process.argv[2];
const study = studyPath ? retailFromStudy(studyPath) : null;

/**
 * The deck angle each side is compared at. A pose only means anything against another pose at the
 * same bank, and a capture's lean bins sit wherever the player actually held the stick — usually
 * short of the clamp. So when a capture is supplied, our rider is driven to *its* angles rather
 * than to full commitment. Slopesmith and retail share the same 50 deg-per-unit lean scale.
 */
const LEAN_PER_DEGREE = 1 / 50;
function carveAngles(): { heel: number; toe: number; matched: boolean } {
  const heel = study?.banks?.negative?.bankDeg, toe = study?.banks?.positive?.bankDeg;
  if (typeof heel !== 'number' || typeof toe !== 'number') return { heel: -44, toe: 44, matched: false };
  // The bins are named by lean sign; the heel edge is whichever one the hips sat heelward in.
  const heelIsNegative = (study!.negative?.hips?.toe ?? 0) < (study!.positive?.hips?.toe ?? 0);
  return {
    heel: -Math.abs(heelIsNegative ? heel : toe),
    toe: Math.abs(heelIsNegative ? toe : heel),
    matched: true,
  };
}
const angles = carveAngles();
const heelCarve = carving(angles.heel * LEAN_PER_DEGREE, angles.heel);
const toeCarve = carving(angles.toe * LEAN_PER_DEGREE, angles.toe);

console.log('Board-frame rider geometry: metres from the ankle midpoint, +toe / +up / +front.');
console.log('The deck\'s own roll is removed, so lateral travel here is the body moving on the board.\n');

console.log(pad('NEUTRAL', 22) + padStart('hips toe', 10) + padStart('hips up', 10) + padStart('head toe', 10));
console.log(
  pad('retail (clips)', 22)
  + padStart(cm(RETAIL_CLIP_ANCHORS.neutralHips.toe), 10)
  + padStart(cm(RETAIL_CLIP_ANCHORS.neutralHips.up), 10)
  + padStart('-', 10));
if (study?.neutral?.hips) {
  console.log(
    pad('retail (live capture)', 22)
    + padStart(cm(study.neutral.hips.toe), 10)
    + padStart(cm(study.neutral.hips.up), 10)
    + padStart(study.neutral.head ? cm(study.neutral.head.toe) : '-', 10));
}
for (const style of ridingStyleOptions()) {
  const frame = poseIn(style.id, neutral);
  console.log(
    pad(style.label, 22)
    + padStart(cm(frame.hips.toe), 10)
    + padStart(cm(frame.hips.up), 10)
    + padStart(cm(frame.head.toe), 10));
}

console.log(`\nCarves compared at ${angles.heel.toFixed(1)} deg heel / ${angles.toe.toFixed(1)} deg toe`
  + (angles.matched ? " -- the capture's own bins." : ' -- full commitment; no capture supplied.'));
console.log(pad('HEEL -> TOE CARVE', 22)
  + padStart('hips@heel', 10) + padStart('hips@toe', 10)
  + padStart('hips', 9) + padStart('head', 9) + padStart('head/hips', 11)
  + padStart('hips up', 9) + padStart('hip deg', 9) + padStart('hip deg', 9));
console.log(pad('', 22) + padStart('', 10) + padStart('', 10)
  + padStart('travel', 9) + padStart('travel', 9) + padStart('', 11)
  + padStart('in carve', 9) + padStart('heel', 9) + padStart('toe', 9));

const retailClipTravel = RETAIL_CLIP_ANCHORS.toeHipsToe - RETAIL_CLIP_ANCHORS.heelHipsToe;
console.log(pad('retail (clips)', 22)
  + padStart(cm(RETAIL_CLIP_ANCHORS.heelHipsToe), 10)
  + padStart(cm(RETAIL_CLIP_ANCHORS.toeHipsToe), 10)
  + padStart(cm(retailClipTravel), 9)
  + padStart('-', 9) + padStart('-', 11) + padStart('-', 9)
  + padStart('-', 9) + padStart('-', 9));

if (study?.negative?.hips && study?.positive?.hips) {
  // Which lean sign is the heel edge is a property of the capture, so it is read off the
  // pose: the edge whose hips sit heelward *is* the heel turn. Assuming it from the lean
  // sign is how a mirrored comparison passes review looking perfectly reasonable.
  const heelIsNegative = study.negative.hips.toe < study.positive.hips.toe;
  const heelBin = heelIsNegative ? study.negative : study.positive;
  const toeBin = heelIsNegative ? study.positive : study.negative;
  const hips = Math.abs(toeBin.hips!.toe - heelBin.hips!.toe);
  const head = toeBin.head && heelBin.head
    ? Math.abs(toeBin.head.toe - heelBin.head.toe) : null;
  console.log(pad('retail (live capture)', 22)
    + padStart(cm(heelBin.hips!.toe), 10) + padStart(cm(toeBin.hips!.toe), 10)
    + padStart(cm(hips), 9)
    + padStart(head === null ? '-' : cm(head), 9)
    + padStart(head === null ? '-' : (head / hips).toFixed(2), 11)
    + padStart(cm((heelBin.hips!.up + toeBin.hips!.up) / 2), 9));
  console.log(`  lean bins: -=${study.bins.negative} neutral=${study.bins.neutral} `
    + `+=${study.bins.positive} | heel edge = ${heelIsNegative ? 'negative' : 'positive'} lean`
    + ` | toe axis mirrored: ${heelBin.mirrored}`
    + (heelBin.kneeLeadM === null ? '' : ` (knees lead ${cm(heelBin.kneeLeadM)} cm toeward)`));
  if (!toeBin.head) console.log(`  bones seen: ${toeBin.names.join(', ')}`);
}

for (const style of ridingStyleOptions()) {
  const heel = poseIn(style.id, heelCarve);
  const toe = poseIn(style.id, toeCarve);
  const hips = Math.abs(toe.hips.toe - heel.hips.toe);
  const head = Math.abs(toe.head.toe - heel.head.toe);
  console.log(
    pad(style.label, 22)
    + padStart(cm(heel.hips.toe), 10) + padStart(cm(toe.hips.toe), 10)
    + padStart(cm(hips), 9) + padStart(cm(head), 9)
    + padStart((head / hips).toFixed(2), 11)
    + padStart(cm((heel.hips.up + toe.hips.up) / 2), 9)
    + padStart(hipAngle(heel, 'knee-rear').toFixed(0), 9)
    + padStart(hipAngle(toe, 'knee-rear').toFixed(0), 9));
}

if (!study) {
  console.log('\nRetail clip anchors are the authored turn clips at their midpoints. For the drawn pose, pass a');
  console.log('rig-study --json-out document as the first argument.');
}
