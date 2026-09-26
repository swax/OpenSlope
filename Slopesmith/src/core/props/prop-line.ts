import type { PlacedProp, PropLine, V3 } from '../doc/types';
import type { LocalBox } from '../lighting/sign-lights';
import { sampleRail } from '../rails/rails';
import { rotateByPlacement, rotateY, tiltFields, type PropRotation } from './pose';

/**
 * PROP LINES (docs/070): a path laid on the ground that owns a row of placements of one model.
 *
 * Everything here is pure: the layout reads the line, the model's footprint and a ground sampler, and answers
 * with the poses the members stand at. The app turns those into ordinary `PlacedProp`s (`lineMembers`) and
 * swaps them into the document (`replaceLineMembers`), so every consumer of placements handles a fence exactly
 * as it handles a hand-placed prop.
 *
 * The layout rules, in the order they apply:
 *  - The path is the Catmull-Rom curve through the nodes — the same curve a rail uses.
 *  - JOINTS are walked along it a STRAIGHT distance apart, not a distance along the curve. A panel is straight,
 *    so a chord is what it can span: its two ends then land exactly on the curve and a bend opens no gap and
 *    makes no overlap. (Spacing by arc length would overlap panels on every bend, since a chord is shorter.)
 *  - The spacing is nudged so a whole number of steps lands the last joint exactly on the last node. When the
 *    spacing is the model's own length (the default: panels end to end), the members are scaled by the same
 *    few percent so they still meet; an explicit spacing only moves the gaps between them.
 *  - `span` puts one member on each step, centred on it and turned along it; `joint` stands one at every
 *    joint, both ends included, turned along the path there.
 *  - Each member is turned so the model's LONGER horizontal side lies along the line (a fence panel's
 *    length), plus the line's own `turn`. Its box centre goes on the step's midpoint.
 *  - Upright members are seated at the lowest ground under them, so no end floats (the uphill end sinks into
 *    the snow). `rake` tilts each span member along the ground between its two ends instead.
 */

/** A model's extent in its own editor-local frame (metres at scale 1, before any turn): the horizontal box,
 *  and the height of its lowest point above its origin (what hand placement calls the base offset). */
export interface LineFootprint {
  minX: number; maxX: number;
  minZ: number; maxZ: number;
  minY: number;
}

/** Where one member stands, and at what size. */
export interface LinePose extends PropRotation {
  pos: V3;
  scale: number;
}

/** Terrain height under a data-space (x, z), searched near `nearY`, or null off the terrain. */
export type LineGround = (x: number, z: number, nearY: number) => number | null;

/** The closest two members may be asked to stand. Below this a slip of the slider would stamp thousands. */
export const LINE_MIN_SPACING = 0.25;
/** Spacing for a model with no horizontal size to measure (a point, a flat sheet seen edge-on). */
export const LINE_FALLBACK_SPACING = 2;
/** Most members one line lays out; past it the spacing grows instead. Matches the API's repeat limit. */
export const LINE_MAX_MEMBERS = 1000;

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/**
 * A raw model box (cm, Z-up, X-mirrored — the space model geometry is stored in) as the editor-local footprint.
 *
 * `RAW_TO_EDITOR` maps raw (x, y, z) to editor (−x, z, −y) / 100, so the mirrored axes swap their bounds.
 */
export function footprintOfRawBox(box: LocalBox): LineFootprint {
  return {
    minX: -box.max[0] / 100, maxX: -box.min[0] / 100,
    minZ: -box.max[1] / 100, maxZ: -box.min[1] / 100,
    minY: box.min[2] / 100,
  };
}

/**
 * The footprint of a GROUP (docs/015): its members' footprints, each carried by its own offset and turn in the
 * group's frame, boxed together. The lowest point is the lowest member's, as a group's hand drop seats it.
 */
export function groupFootprint(members: readonly { footprint: LineFootprint; relPos: V3; relYaw: number }[]):
  LineFootprint | null {
  let out: LineFootprint | null = null;
  for (const { footprint: f, relPos, relYaw } of members) {
    for (const x of [f.minX, f.maxX]) for (const z of [f.minZ, f.maxZ]) {
      const [cx, , cz] = rotateY([x, 0, z], relYaw);
      const px = cx + relPos[0], pz = cz + relPos[2];
      out ??= { minX: px, maxX: px, minZ: pz, maxZ: pz, minY: f.minY + relPos[1] };
      out.minX = Math.min(out.minX, px); out.maxX = Math.max(out.maxX, px);
      out.minZ = Math.min(out.minZ, pz); out.maxZ = Math.max(out.maxZ, pz);
    }
    if (out) out.minY = Math.min(out.minY, f.minY + relPos[1]);
  }
  return out;
}

/** Which of the model's horizontal axes is its long side — the one laid along the line at turn 0. */
const longAxis = (f: LineFootprint): 'x' | 'z' => f.maxX - f.minX >= f.maxZ - f.minZ ? 'x' : 'z';

/**
 * How far the model reaches along the line at the line's turn and scale: its box projected onto the path.
 * At turn 0 that is the long side; a quarter turn puts the short side along the line instead.
 */
export function lineModelLength(line: Pick<PropLine, 'turn' | 'scale'>, f: LineFootprint): number {
  const lx = f.maxX - f.minX, lz = f.maxZ - f.minZ;
  const long = Math.max(lx, lz), short = Math.min(lx, lz);
  const t = (line.turn ?? 0) * D2R;
  return (Math.abs(Math.cos(t)) * long + Math.abs(Math.sin(t)) * short) * line.scale;
}

/** The spacing the line asks for, before the layout fits a whole number: its own, else the model's length. */
export function lineNominalSpacing(line: Pick<PropLine, 'spacing' | 'turn' | 'scale'>, f: LineFootprint): number {
  if (typeof line.spacing === 'number' && line.spacing > 0) return Math.max(LINE_MIN_SPACING, line.spacing);
  const length = lineModelLength(line, f);
  return length > 0.05 ? Math.max(LINE_MIN_SPACING, length) : LINE_FALLBACK_SPACING;
}

// ---- the walk: joints a straight distance apart along the curve ------------------------------------------

/** How a step is measured: in plan (XZ) for upright members, whose length is horizontal; in space for raked. */
export type Metric = 'plan' | 'space';

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
/** Distance in plan (XZ) for upright members, whose length is horizontal; in space for raked ones. */
const measure = (d: V3, metric: Metric) => metric === 'plan' ? Math.hypot(d[0], d[2]) : Math.hypot(d[0], d[1], d[2]);

interface Walk {
  joints: V3[];
  /** Whole steps taken plus the fraction of one the leftover reaches — the count the fit rounds. */
  progress: number;
}

/** Walk joints `step` apart along the polyline, starting on its first point. */
function walk(points: readonly V3[], step: number, metric: Metric, limit: number): Walk {
  const joints: V3[] = [points[0]];
  let joint = points[0];
  let seg = 0, from = 0; // where the current joint sits: segment index + parameter along it
  while (joints.length <= limit) {
    let next: { at: V3; seg: number; t: number } | null = null;
    for (let i = seg; i < points.length - 1 && !next; i++) {
      const p = points[i], v = sub(points[i + 1], p), w = sub(p, joint);
      if (metric === 'plan') { v[1] = 0; w[1] = 0; }
      // |w + t·v| = step; the forward crossing is the larger root (the joint is inside the circle at `from`)
      const a = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
      if (a < 1e-12) continue;
      const b = 2 * (v[0] * w[0] + v[1] * w[1] + v[2] * w[2]);
      const c = w[0] * w[0] + w[1] * w[1] + w[2] * w[2] - step * step;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b + Math.sqrt(disc)) / (2 * a);
      const start = i === seg ? from : 0;
      if (t >= start - 1e-9 && t <= 1 + 1e-9) {
        const q = points[i + 1], tt = Math.min(1, Math.max(start, t));
        next = { at: [p[0] + (q[0] - p[0]) * tt, p[1] + (q[1] - p[1]) * tt, p[2] + (q[2] - p[2]) * tt], seg: i, t: tt };
      }
    }
    if (!next) break;
    joints.push(next.at);
    joint = next.at; seg = next.seg; from = next.t;
  }
  const leftover = measure(sub(points[points.length - 1], joint), metric) / step;
  return { joints, progress: joints.length - 1 + leftover };
}

/**
 * The joints of a fitted walk: `count` steps whose last joint lands exactly on the path's end, and the step
 * length that does it. The step is found by bisection on the walk's progress, which falls as the step grows.
 */
function fittedJoints(points: readonly V3[], nominal: number, metric: Metric): { joints: V3[]; step: number } {
  const end = points[points.length - 1];
  const first = walk(points, nominal, metric, LINE_MAX_MEMBERS + 1);
  const count = Math.min(LINE_MAX_MEMBERS, Math.max(1, Math.round(first.progress)));
  const off = (step: number) => walk(points, step, metric, count + 1).progress - count;
  // Bracket around the straight-line estimate, widening until the progress straddles the count.
  const estimate = nominal * first.progress / count;
  let lo = estimate * 0.8, hi = estimate * 1.25;
  for (let i = 0; i < 40 && off(lo) < 0; i++) lo *= 0.8;
  for (let i = 0; i < 40 && off(hi) > 0; i++) hi *= 1.25;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (off(mid) > 0) lo = mid; else hi = mid;
  }
  const step = (lo + hi) / 2;
  const joints = walk(points, step, metric, count).joints.slice(0, count + 1);
  if (joints.length < count + 1) joints.push(end);
  joints[count] = end;
  return { joints, step };
}

// ---- poses ---------------------------------------------------------------------------------------------------

/** The yaw that lays the model's long side along a horizontal direction, plus the line's turn. */
function alignedYaw(f: LineFootprint, dx: number, dz: number, turn: number): number {
  const along = longAxis(f) === 'x' ? Math.atan2(-dz, dx) : Math.atan2(dx, dz); // Ry(θ)·x̂ = (cos, 0, −sin)
  return (((along * R2D + turn) % 360) + 360) % 360;
}

/**
 * The tilt that raises a member along a rising step: expressed in the member's own frame, the step leans
 * toward one of its horizontal axes, and a roll (about Z, for X) or a pitch (about X, for Z) lifts that axis
 * by the step's slope. Only one is ever non-zero, so the YXZ composition stays exact.
 */
function rakeTilt(yaw: number, step: V3): { pitch?: number; roll?: number } {
  const [lx, ly, lz] = rotateY(step, -yaw);
  if (Math.abs(lx) >= Math.abs(lz)) return lx === 0 ? {} : { roll: Math.atan(ly / lx) * R2D };
  return { pitch: -Math.atan(ly / lz) * R2D }; // Rx(p) lowers +Z for positive p
}

/** Place the model's bottom-centre on `target`: the origin sits wherever that puts it under this rotation. */
function seated(target: V3, f: LineFootprint, scale: number, rotation: PropRotation): V3 {
  const bottom: V3 = [(f.minX + f.maxX) / 2 * scale, f.minY * scale, (f.minZ + f.maxZ) / 2 * scale];
  const [ox, oy, oz] = rotateByPlacement(bottom, rotation);
  return [target[0] - ox, target[1] - oy, target[2] - oz];
}

/**
 * The joints a line lays out along, and the step between them: walked along its curve a straight distance apart
 * — in plan, or in space for members that tilt along the ground — and fitted so a whole number of steps lands the
 * last joint on the last node. Null for a line under two nodes, or one whose points all coincide. Sheets lay
 * their spans between the same joints (docs/071).
 */
export function lineJoints(nodes: readonly V3[], nominal: number, metric: Metric = 'plan'):
  { joints: V3[]; step: number } | null {
  if (nodes.length < 2) return null;
  const points = sampleRail([...nodes], 24);
  const total = measure(sub(points[points.length - 1], points[0]), metric);
  if (total < 1e-3 && points.every(p => measure(sub(p, points[0]), metric) < 1e-3)) return null;
  return fittedJoints(points, Math.max(LINE_MIN_SPACING, nominal), metric);
}

/**
 * Lay a line out: where each member stands, in order along the path. Empty for a line under two nodes, or one
 * whose ends meet.
 */
export function layoutPropLine(line: PropLine, f: LineFootprint, ground: LineGround): LinePose[] {
  const span = line.place !== 'joint';
  const rake = span && line.rake === true;
  const nominal = lineNominalSpacing(line, f);
  const fitted = lineJoints(line.nodes, nominal, rake ? 'space' : 'plan');
  if (!fitted) return [];
  const { joints, step } = fitted;
  const groundAt = (p: V3) => ground(p[0], p[2], p[1]) ?? p[1];
  const turn = line.turn ?? 0;
  // Butted panels grow or shrink with the fitted step so they still meet; spaced members keep their size.
  const butted = span && !(typeof line.spacing === 'number' && line.spacing > 0) && lineModelLength(line, f) > 0.05;
  const scale = butted ? line.scale * step / nominal : line.scale;
  const poses: LinePose[] = [];

  if (span) {
    const heights = joints.map(groundAt);
    for (let k = 0; k < joints.length - 1; k++) {
      const a = joints[k], b = joints[k + 1];
      const dx = b[0] - a[0], dz = b[2] - a[2];
      if (Math.hypot(dx, dz) < 1e-9) continue;
      const yaw = alignedYaw(f, dx, dz, turn);
      const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const rotation: PropRotation = rake ? { yaw, ...rakeTilt(yaw, [dx, heights[k + 1] - heights[k], dz]) } : { yaw };
      const floor = rake ? (heights[k] + heights[k + 1]) / 2 : Math.min(heights[k], heights[k + 1], groundAt(mid));
      poses.push({ pos: seated([mid[0], floor, mid[2]], f, scale, rotation), ...rotation, scale });
    }
    return poses;
  }

  for (let k = 0; k < joints.length; k++) {
    const before = joints[Math.max(0, k - 1)], after = joints[Math.min(joints.length - 1, k + 1)];
    const dx = after[0] - before[0], dz = after[2] - before[2];
    const yaw = alignedYaw(f, dx, dz, turn);
    const at = joints[k];
    poses.push({ pos: seated([at[0], groundAt(at), at[2]], f, scale, { yaw }), yaw, scale });
  }
  return poses;
}

// ---- members --------------------------------------------------------------------------------------------------

/** A member's id: the line's, and its place along it. Deterministic, so a re-layout that keeps the count keeps
 *  every member's identity — and with it any effect or label attached to one. */
export function lineMemberId(lineId: string, index: number): string {
  return `${lineId}:${index.toString().padStart(3, '0')}`;
}

/** The placements a layout stands for: each a copy of the template at its pose, tagged with the line. */
export function lineMembers(line: PropLine & { id: string }, poses: readonly LinePose[]): PlacedProp[] {
  return poses.map((pose, index) => ({
    id: lineMemberId(line.id, index),
    ...structuredClone(line.template),
    line: line.id,
    pos: pose.pos,
    yaw: pose.yaw,
    ...tiltFields(pose),
    scale: pose.scale,
  }));
}

/**
 * Swap a line's members in `props` for `members`, touching as little as it can: a member whose id survives
 * keeps its slot, new ones go in after the line's last surviving member (or at the end), and the rest are
 * spliced out. Returns the ids that left and the ids that arrived, for the attachments that follow them.
 */
export function replaceLineMembers(props: PlacedProp[], lineId: string, members: readonly PlacedProp[]):
  { removed: string[]; added: string[] } {
  const incoming = new Map(members.map(member => [member.id!, member]));
  const kept = new Set<string>();
  const removed: string[] = [];
  const drop: number[] = [];
  props.forEach((prop, index) => {
    if (prop.line !== lineId) return;
    const next = prop.id ? incoming.get(prop.id) : undefined;
    if (next && !kept.has(next.id!)) { props[index] = next; kept.add(next.id!); }
    else { drop.push(index); if (prop.id) removed.push(prop.id); }
  });
  for (let i = drop.length - 1; i >= 0; i--) props.splice(drop[i], 1);
  let last = -1;
  props.forEach((prop, index) => { if (prop.line === lineId) last = index; });
  const added = members.filter(member => !kept.has(member.id!));
  props.splice(last < 0 ? props.length : last + 1, 0, ...added);
  return { removed, added: added.map(member => member.id!) };
}

/** Every placement a line owns, in document order. */
export function membersOfLine(props: readonly PlacedProp[] | undefined, lineId: string): PlacedProp[] {
  return (props ?? []).filter(prop => prop.line === lineId);
}

// ---- identity ---------------------------------------------------------------------------------------------------

/** The lowest `line:NNNN` the list does not already use. */
export function nextPropLineId(lines: readonly PropLine[]): string {
  const used = new Set(lines.map(line => line.id).filter((id): id is string => !!id));
  for (let i = 0; ; i++) {
    const id = `line:${i.toString().padStart(4, '0')}`;
    if (!used.has(id)) return id;
  }
}

/** Name in place a line saved without an id, or one sharing another's. */
export function ensurePropLineIds(lines: PropLine[] | undefined): void {
  if (!lines) return;
  const used = new Set<string>();
  for (const line of lines) {
    if (typeof line.id === 'string' && line.id && !used.has(line.id)) used.add(line.id);
    else {
      line.id = nextPropLineId([...used].map(id => ({ id } as PropLine)));
      used.add(line.id);
    }
  }
}
