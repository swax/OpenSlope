import type { NativeCollisionProfile, PlacedProp, V3 } from '../doc/types';
import { buildMeshFromCourse, straightCourse } from '../doc/mountain';
import { surfaceHeightAt } from '../mesh/surface-height';
import {
  addEffectNodeTemplate, addEffectTemplateToProp, createEmptyEffectsDocument, effectNode, timerEmitterFields,
} from '../effects/authoring';
import { nativeArgbFieldsFromRgbaColorStops, type RgbaColor } from '../effects/emitter-colors';
import { NATIVE_COLLISION_MODE, type NativeContactState } from './native';

/** The spec-validation lab for [Trailmap: 130-collision-data] deliberately reuses a body already present
 * in Garibaldi's SSF physics pool. */
export const COLLISION_LAB_TARGET = 'GARI';
export const COLLISION_LAB_NAME = 'COLLISION_LAB';
const CRASH_BAG_MODEL = 19;
const CRASH_BAG_BODY = 7;
const CRASH_BAG_INSTANCE = 149;
// GARI model 19 Meshes/25.obj minimum native Z = -135.01688 cm. Hand placement normally obtains this
// through the loaded prop asset; the synchronous preset records the same seating offset explicitly.
const CRASH_BAG_BASE_OFFSET_M = -1.3501688;

type LabCase = {
  label: string;
  color: RgbaColor;
  profile: NativeCollisionProfile;
};

const profile = (mode: 0 | 1 | 2 | 3, responseMass: number, over: Partial<NativeCollisionProfile> = {}): NativeCollisionProfile => ({
  mode, playerCollision: true, responseMass, playerBounce: true, bounceAmount: 0.2,
  ...(mode === NATIVE_COLLISION_MODE.physicsBodySpheres
    ? { physicsSource: { level: COLLISION_LAB_TARGET, body: CRASH_BAG_BODY, instance: CRASH_BAG_INSTANCE } } : {}),
  ...over,
});

/**
 * Four one-variable rows over the same visible Garibaldi crash bag model:
 *
 *  - triangle proxy: exact-zero / glass 0.2 / finite 5 / huge nonzero;
 *  - instance bounds: the same response values;
 *  - one exact sphere-tree body: 0 / 5 / 20 / huge nonzero;
 *  - gate/bounce controls that should isolate no-shape, PlayerCollision and PlayerBounce behavior.
 *
 * Names are the labels: selecting a bag in Props shows its case without relying on painted signage. Each
 * contactable case owns a distinct collision particle burst; no burst is itself the expected signal for the
 * no-shape and PlayerCollision-off controls.
 */
export const COLLISION_LAB_CASES: readonly (readonly LabCase[])[] = [
  [
    { label: 'M1 response mass=0', color: [1, 0.08, 0.08, 1], profile: profile(1, 0) },
    { label: 'M1 response mass=0.2 glass', color: [1, 0.35, 0.05, 1], profile: profile(1, 0.2) },
    { label: 'M1 response mass=5', color: [1, 0.8, 0.05, 1], profile: profile(1, 5) },
    { label: 'M1 response mass=1e30', color: [1, 0.05, 0.55, 1], profile: profile(1, 1e30) },
  ],
  [
    { label: 'M2 response mass=0', color: [0.05, 0.35, 1, 1], profile: profile(2, 0) },
    { label: 'M2 response mass=0.2', color: [0.05, 0.9, 1, 1], profile: profile(2, 0.2) },
    { label: 'M2 response mass=5', color: [0.35, 0.2, 1, 1], profile: profile(2, 5) },
    { label: 'M2 response mass=1e30', color: [0.82, 0.9, 1, 1], profile: profile(2, 1e30) },
  ],
  [
    { label: 'M3 response mass=0 path-marker value', color: [0.05, 1, 0.2, 1], profile: profile(3, 0) },
    { label: 'M3 response mass=5 crash-bag value', color: [0.55, 1, 0.05, 1], profile: profile(3, 5) },
    { label: 'M3 response mass=20', color: [0.05, 0.8, 0.55, 1], profile: profile(3, 20) },
    { label: 'M3 response mass=1e30', color: [0.9, 1, 0.15, 1], profile: profile(3, 1e30) },
  ],
  [
    { label: 'CONTROL mode0 PC on', color: [0.6, 0.05, 1, 1], profile: profile(0, 1e30) },
    { label: 'CONTROL mode1 PC off', color: [0.9, 0.05, 1, 1], profile: profile(1, 1e30, { playerCollision: false }) },
    { label: 'CONTROL mode2 bounce off', color: [1, 1, 1, 1], profile: profile(2, 1e30, { playerBounce: false }) },
    { label: 'CONTROL mode2 bounce 0.6', color: [1, 0.45, 0.85, 1], profile: profile(2, 1e30, { bounceAmount: 0.6 }) },
  ],
] as const;

/** Seventeenth follow-up control. Its live cyan-marker/pass-through result established that PlayerBounce-off
 * suppresses physical response for mode 1 just as it did for the original matrix's mode-2 control. */
export const COLLISION_LAB_MODE1_BOUNCE_OFF_CASE: LabCase = {
  label: 'FOLLOW-UP M1 bounce off', color: [0.05, 1, 1, 1],
  profile: profile(1, 1e30, { playerBounce: false, bounceAmount: 0.6 }),
};

type OracleCase = LabCase & {
  expectedContact: NativeContactState;
  expectedMarker: boolean;
};

/** A ride-straight-down regression column. Each successive box changes one independent field so a live pass can
 * distinguish shape/contact eligibility from contact-only dispatch, static response admission, the universal
 * minimum eject, and authored restitution. The expected sequence is deliberately encoded beside the fixtures so
 * generator tests cannot silently drift away from the documented result. */
export const COLLISION_LAB_ORACLE_COLUMN: readonly OracleCase[] = [
  {
    label: 'ORACLE 1 no shape — no marker / through', color: [1, 0.08, 0.08, 1],
    profile: profile(0, 1e30), expectedContact: 'none', expectedMarker: false,
  },
  {
    label: 'ORACLE 2 PlayerCollision off — no marker / through', color: [0.05, 0.35, 1, 1],
    profile: profile(1, 1e30, { playerCollision: false }), expectedContact: 'none', expectedMarker: false,
  },
  {
    label: 'ORACLE 3 response mass=0 — orange marker / through', color: [1, 0.35, 0.05, 1],
    profile: profile(1, 0), expectedContact: 'through', expectedMarker: true,
  },
  {
    label: 'ORACLE 4 PlayerBounce off — cyan marker / through', color: [0.05, 1, 1, 1],
    profile: profile(1, 1e30, { playerBounce: false, bounceAmount: 0.6 }),
    expectedContact: 'through', expectedMarker: true,
  },
  {
    label: 'ORACLE 5 bounce=0 — yellow marker / minimum eject', color: [1, 0.9, 0.05, 1],
    profile: profile(1, 1e30, { bounceAmount: 0 }), expectedContact: 'solid', expectedMarker: true,
  },
  {
    label: 'ORACLE 6 bounce=0.6 — magenta marker / strong rebound', color: [1, 0.05, 0.75, 1],
    profile: profile(1, 1e30, { bounceAmount: 0.6 }), expectedContact: 'solid', expectedMarker: true,
  },
] as const;

/** Downhill bounce calibration. Identical shape/mass/marker settings leave only PlayerBounceAmmount varying;
 * the generous gap after each impact lets the rider regain speed and continue through the whole sequence.
 * Native wipeout is not a bounce-only flag: with incoming normal speed s, velocity delta J=max(s*(1+b),s+55.556)
 * crosses the hard-impact threshold 1944.444+833.333*dot(boardUp,normal). A continuous live pass crossed only for
 * b=0.6; its faster impact exceeded threshold while a slower b=1.0 hit remained just below it. */
export const COLLISION_LAB_BOUNCE_COLUMN: readonly LabCase[] = [
  { label: 'BOUNCE 0 — floor only', color: [1, 1, 1, 1], profile: profile(1, 1e30, { bounceAmount: 0 }) },
  { label: 'BOUNCE 0.03 — soft tier', color: [0.05, 0.35, 1, 1], profile: profile(1, 1e30, { bounceAmount: 0.03 }) },
  { label: 'BOUNCE 0.2 — medium tier', color: [0.05, 1, 0.2, 1], profile: profile(1, 1e30, { bounceAmount: 0.2 }) },
  { label: 'BOUNCE 0.5 — common tier', color: [1, 0.8, 0.05, 1], profile: profile(1, 1e30, { bounceAmount: 0.5 }) },
  { label: 'BOUNCE 0.6 — springy tier', color: [1, 0.05, 0.75, 1], profile: profile(1, 1e30, { bounceAmount: 0.6 }) },
  { label: 'BOUNCE 1.0 — elastic stress control', color: [1, 0.08, 0.08, 1], profile: profile(1, 1e30, { bounceAmount: 1 }) },
] as const;

/** Append the lab's high-visibility particle burst to a graph that already exists.
 *
 * Split out from `addCollisionBurst` so a fixture can hang the same proven marker off a graph it did not
 * create — a recipe's own collision graph, say — and read "the graph ran" independently of whether the
 * recipe's other nodes did anything. */
export function addCollisionMarkerNode(doc: ReturnType<typeof createEmptyEffectsDocument>,
  graph: ReturnType<typeof addEffectTemplateToProp>, label: string, color: RgbaColor): void {
  const selection = addEffectNodeTemplate(doc, graph, 'timer-emitter');
  const node = selection ? effectNode(doc, selection) : null;
  const fields = node ? timerEmitterFields(node) : null;
  if (!fields) throw new Error(`Could not create the collision marker for ${label}.`);
  Object.assign(fields, nativeArgbFieldsFromRgbaColorStops([
    color,
    [color[0], color[1], color[2], 0.8],
    [color[0], color[1], color[2], 0.3],
    [color[0], color[1], color[2], 0],
  ]));
  // A diagnostic contact must remain visible long enough to identify while the rider is recovering. The generic
  // emitter starts with zero particle lifetime, which previews safely but produces no native pixels; override the
  // complete visibility-sensitive subset here. A soft additive halo also avoids mistaking the marker for the
  // crash bag's square art while the upward velocity makes the source lane obvious.
  fields.U0 = 72;
  fields.U1 = 2;
  fields.U2 = 0.2;
  fields.U4 = 180;
  fields.U5 = 1.5;
  fields.U6 = 40;
  fields.U7 = 0.4;
  fields.U8 = 0.04;
  fields.U20 = 1200;
  fields.U26 = 700;
  fields.U32 = -300;
  fields.U49 = 4;
  fields.U50 = 0;
  const owner = doc.graphs.find(item => item.id === graph.ownerId);
  if (owner) owner.name = `${label} contact marker`;
}

function addCollisionBurst(doc: ReturnType<typeof createEmptyEffectsDocument>, prop: PlacedProp, color: RgbaColor): void {
  addCollisionMarkerNode(doc, addEffectTemplateToProp(doc, prop.id!, 'collision-trigger'), prop.name, color);
}

/** Build the editable lab document shown by File -> New mountain -> collision lab. */
export function collisionLabMountain(name = COLLISION_LAB_NAME) {
  // A deliberately broad/long test slope gives every family its own readable area. The earlier narrow 220 m
  // quilt forced the oracle column against both the matrix and the out-of-bounds shoulder.
  const course = straightCourse(400, 460, 18);
  const effects = createEmptyEffectsDocument(name);
  const doc = buildMeshFromCourse(course, {
    widthM: 460, roughness: 0, targetPatchM: 20, seed: 130,
  }, { name, baseSurface: 1, effects });
  if (!doc) throw new Error('The collision lab slope could not be generated.');

  // The general mountain generator deliberately paints a fixed 75 m snow corridor and uses powder beyond it,
  // regardless of total width. A collision lab needs a uniform approach surface so lane choice cannot change
  // speed/feel. Expand snow across every safe interior cell while retaining the outer slow and OOB safety rings.
  if (doc.quadPaint) for (const key of Object.keys(doc.quadPaint)) {
    const surface = doc.quadPaint[Number(key)];
    if (surface !== 0 && surface !== 2) doc.quadPaint[Number(key)] = 1;
  }

  const a = course.knots[0].pos, b = course.knots[course.knots.length - 1].pos;
  const dx = b[0] - a[0], dz = b[2] - a[2], horizontal = Math.hypot(dx, dz) || 1;
  const down: V3 = [dx / horizontal, 0, dz / horizontal];
  const side: V3 = [-down[2], 0, down[0]];
  const rowDistances = [280, 470, 660, 850];
  const laneOffsets = [-90, -30, 30, 90];
  const props: PlacedProp[] = [];
  const place = (test: LabCase, downhillDistance: number, laneOffset: number) => {
    const x = a[0] + down[0] * downhillDistance + side[0] * laneOffset;
    const z = a[2] + down[2] * downhillDistance + side[2] * laneOffset;
    const ground = surfaceHeightAt(doc, x, z)
      ?? (a[1] + (b[1] - a[1]) * downhillDistance / horizontal - 1.5);
    const y = ground - CRASH_BAG_BASE_OFFSET_M;
    const ordinal = props.length;
    const prop: PlacedProp = {
      id: `collision-lab:${ordinal.toString().padStart(2, '0')}`,
      level: COLLISION_LAB_TARGET, model: CRASH_BAG_MODEL, name: test.label,
      pos: [x, y, z], yaw: 45, scale: 1,
      nativeCollision: structuredClone(test.profile),
    };
    props.push(prop);
    addCollisionBurst(effects, prop, test.color);
  };
  for (let row = 0; row < COLLISION_LAB_CASES.length; row++) {
    for (let lane = 0; lane < COLLISION_LAB_CASES[row].length; lane++) {
      place(COLLISION_LAB_CASES[row][lane], rowDistances[row], laneOffsets[lane]);
    }
  }
  // Centred below the historical four-by-four matrix so it cannot be mistaken for another matrix cell.
  place(COLLISION_LAB_MODE1_BOUNCE_OFF_CASE, 1100, 0);
  // One isolated lane outside the matrix but well inside the widened rideable snow corridor. Keep the
  // historical 0..16 ids above stable;
  // this regression column is appended as 17..22 even though its first case sits near the top of the course.
  const oracleDistances = [190, 375, 560, 745, 930, 1115];
  for (let i = 0; i < COLLISION_LAB_ORACLE_COLUMN.length; i++)
    place(COLLISION_LAB_ORACLE_COLUMN[i], oracleDistances[i], 135);
  // Dedicated left-hand downhill column: the first box is near spawn and 190 m between impacts provides a long
  // acceleration/recovery segment. Spatial order follows increasing restitution so one run can exercise all six.
  const bounceDistances = [100, 290, 480, 670, 860, 1050];
  for (let i = 0; i < COLLISION_LAB_BOUNCE_COLUMN.length; i++)
    place(COLLISION_LAB_BOUNCE_COLUMN[i], bounceDistances[i], -135);
  doc.props = props;
  return doc;
}
