import type { EditDoc } from '../../core/doc/doc-edit';
import type { CoursePath, V3 } from '../../core/doc/types';
import { readRegister, type RegisterKey } from '../../core/doc/registers';
import { paramsAt, sampleSpine, spineAt, totalLength, type SpineSample } from '../../core/math/spine';
import { add, cross, mul, norm } from '../../core/math/vec';

/**
 * Intents a register write may arrive as, expanded here into the plain `{ key, value, remove }` changes the
 * register path has always taken (docs/052).
 *
 * Why this exists: every crew that built a real mountain over HTTP wrote a script, and the scripts all did
 * the same four things a person with curl cannot — walk the course spine to turn "station 320, six metres
 * off the line" into an [x, y, z]; ask the ground where to seat it; unroll one lamp into a row of lamps; and
 * compose the eight vertices and six faces of a box for the tenth time. None of that is authoring judgment.
 * It is arithmetic the server already knows how to do, against the document it already holds, so it is done
 * here — and a village becomes a JSON file and one `curl -d @village.json`.
 *
 * The register model is untouched. Exactly as a `rules` selector expands into ordinary quad assignments
 * before landing, an intent expands into ordinary whole-object assignments: still absolute, still
 * last-writer-wins, still relayed key by key. What arrives is a position said in the run's own terms; what
 * lands is a placement with a number in every slot.
 *
 * Four intents, each optional on any change:
 *
 *  - a POSITION in run terms — `pos: { station, lateral, above }` (or `{ knot, along, lateral, above }`)
 *    resolves against the course spine and the terrain, and `yaw: "course+90"` faces the placement across the
 *    run; `pos: [x, null, z]` / `[x, "+1.5", z]` keeps an author's x/z and seats Y on the ground;
 *  - `repeat` — one change becomes `count` (or `every`/`until`) clones stepping along the run, with `{i}` in
 *    the key naming each;
 *  - `from` — the value is copied from a register this map holds, with `value` merged over it, so a variant
 *    is one line rather than the whole object again;
 *  - `shape` on an `o/model` — a box, a gabled house shell, a roof or a panel, generated in the model's own
 *    frame with the winding and tiling the bake expects.
 */

export interface IntentOutcomes {
  /** Positions resolved from an intent form (run-relative, or ground-relative Y). */
  placed: number;
  /** Changes produced by `repeat` — the clones, the original included. */
  repeated: number;
  /** Changes whose value came from another register through `from`. */
  copied: number;
  /** Models whose geometry a `shape` generated. */
  shaped: number;
  /** Run-relative positions with no terrain under them, left at the run's own height instead. */
  unseated: number;
}

export type GroundSampler = (x: number, z: number) => number | null;

// ---- the run as a ruler ------------------------------------------------------------------------------------

/** The course frame at one arc station: where the line is, which way it runs, and how wide the floor is. */
export interface StationFrame {
  station: number;
  pos: V3;
  /** Unit tangent, downhill (start → finish). */
  fwd: V3;
  /** Horizontal unit vector to the rider's RIGHT (fwd × up) — the sign `lateral` and `bank` share. */
  side: V3;
  /** The yaw, degrees, that points a placement's own +Z along `fwd` — so `yaw: "course"` faces downhill. */
  heading: number;
  /** Run floor width here, metres. */
  width: number;
}

export interface CourseRuler {
  /** Arc length of the whole run, metres. */
  length: number;
  /** Each knot's arc station, so "12 m past knot 6" is a number. */
  knotStations: number[];
  at(station: number): StationFrame;
  /** The station of the spine point nearest (x, z) — how a placement given in x/z finds its heading. */
  nearest(x: number, z: number): number;
}

/** Yaw (degrees, [0, 360)) whose `rotateY([0,0,1])` is the horizontal direction of `dir`. */
export function headingOf(dir: V3): number {
  return ((Math.atan2(dir[0], dir[2]) * 180 / Math.PI) % 360 + 360) % 360;
}

/**
 * The same spine every export path samples (`core/doc/course.ts`), read as a ruler. Stations are the arc
 * length the AIP race line and the AI paths are laid out by, so a station named here is a station the game
 * rules distance by.
 */
export function courseRuler(course: CoursePath): CourseRuler {
  if (!Array.isArray(course?.knots) || course.knots.length < 2) {
    throw new Error('This map\'s course has fewer than two knots, so it has no stations to place by.');
  }
  const samples = sampleSpine(course.knots);
  const length = totalLength(samples);
  const knotStations = course.knots.map((_, index) => {
    const found = samples.find(sample => sample.k >= index - 1e-9);
    return found ? found.s : length;
  });
  const frame = (sample: SpineSample): StationFrame => ({
    station: sample.s, pos: sample.pos, fwd: sample.fwd,
    side: norm(cross(sample.fwd, [0, 1, 0])),
    heading: headingOf(sample.fwd),
    width: paramsAt(course.knots, sample.k).width,
  });
  return {
    length, knotStations,
    at: station => frame(spineAt(samples, station)),
    nearest: (x, z) => {
      let best = Infinity, at = 0;
      for (let i = 0; i < samples.length; i++) {
        const d = (samples[i].pos[0] - x) ** 2 + (samples[i].pos[2] - z) ** 2;
        if (d < best) { best = d; at = i; }
      }
      // The nearest sample is a station to within half a sample step — up to a few metres on a long
      // segment — so the point is projected onto the two sampled segments meeting there and the closer
      // projection is the answer, continuous along the line.
      let station = samples[at].s;
      for (const [a, b] of [[at - 1, at], [at, at + 1]]) {
        if (a < 0 || b >= samples.length) continue;
        const ax = samples[a].pos[0], az = samples[a].pos[2];
        const dx = samples[b].pos[0] - ax, dz = samples[b].pos[2] - az;
        const span = dx * dx + dz * dz;
        if (span < 1e-12) continue;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / span));
        const px = ax + dx * t, pz = az + dz * t;
        const d = (px - x) ** 2 + (pz - z) ** 2;
        if (d <= best) { best = d; station = samples[a].s + (samples[b].s - samples[a].s) * t; }
      }
      return station;
    },
  };
}

// ---- what the request needs of the map, built once and only when asked for --------------------------------

class Scene {
  private ruler?: CourseRuler;
  private sampler?: GroundSampler;
  constructor(private readonly document: EditDoc, private readonly makeGround: () => GroundSampler) {}
  get course(): CourseRuler { return this.ruler ??= courseRuler(this.document.course); }
  ground(x: number, z: number): number | null { return (this.sampler ??= this.makeGround())(x, z); }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const finite = (value: unknown, what: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${what} is a number.`);
  return value;
};

const mm = (value: number): number => Math.round(value * 1000) / 1000;

/** The whole-object family a key names, or the key itself for `course`; null for anything an intent cannot
 *  apply to (a vertex, a quad channel, a global). */
function familyOf(key: RegisterKey): string | null {
  if (key === 'course') return 'course';
  if (!key.startsWith('o/')) return null;
  const cut = key.indexOf('/', 2);
  return cut < 0 ? null : key.slice(2, cut);
}

const PLACED: ReadonlySet<string> = new Set(['prop', 'light', 'gem']);

// ---- positions ---------------------------------------------------------------------------------------------

/** A ground-relative Y as it arrives: `null` is the surface itself, "+1.5" / "-0.2" an offset from it. */
const GROUND_OFFSET = /^\s*([+-])\s*(\d+(?:\.\d+)?)\s*$/;

function groundOffset(value: unknown): number | null {
  if (value === null) return 0;
  if (typeof value !== 'string') return null;
  const match = GROUND_OFFSET.exec(value);
  return match ? (match[1] === '-' ? -1 : 1) * Number(match[2]) : null;
}

const asOffset = (metres: number): string => `${metres < 0 ? '-' : '+'}${mm(Math.abs(metres))}`;

interface Resolved { pos: V3; station?: number }

/**
 * One position in any of its forms, to a point.
 *
 * `[x, y, z]` with three numbers is what a document holds and passes through untouched. `[x, null, z]` and
 * `[x, "+1.5", z]` keep the author's x/z and take Y off the terrain; a point with no surface under it is
 * refused rather than dropped to zero, because "on the ground" was the whole of what was asked.
 *
 * `{ station, lateral, above }` is the run's own frame: metres along the line from knot 0, metres to the
 * rider's right (negative = left), metres above the terrain there. `knot` + `along` names the station as
 * "so far past knot N". `y` instead of `above` is absolute. A run-relative point over no terrain keeps the
 * run's own height there and is counted in `unseated` — the line has a height by definition, and a bridge
 * deck or a jump over a gap is a legitimate place to hang something.
 */
function resolvePosition(scene: Scene, held: unknown, outcomes: IntentOutcomes, what: string): Resolved {
  if (Array.isArray(held)) {
    if (held.length !== 3) throw new Error(`${what} is [x, y, z] — three entries.`);
    const x = finite(held[0], `${what}[0] (x)`), z = finite(held[2], `${what}[2] (z)`);
    if (typeof held[1] === 'number') {
      if (!Number.isFinite(held[1])) throw new Error(`${what}[1] (y) is a number.`);
      return { pos: held as V3 };
    }
    const offset = groundOffset(held[1]);
    if (offset === null) {
      throw new Error(`${what}[1] (y) is a number, null for the ground itself, or "+1.5" / "-0.2" for a `
        + 'height above or below it.');
    }
    const ground = scene.ground(x, z);
    if (ground === null) {
      throw new Error(`${what}: there is no terrain under [${x}, ${z}] to seat on — give Y as a number.`);
    }
    outcomes.placed++;
    return { pos: [x, mm(ground + offset), z] };
  }
  if (!isObject(held)) {
    throw new Error(`${what} is [x, y, z], [x, null | "+h", z], or { station | knot, lateral, above }.`);
  }
  const ruler = scene.course;
  let station: number;
  if (held.station !== undefined) {
    station = finite(held.station, `${what}.station`);
    if (held.knot !== undefined) throw new Error(`${what} names a station or a knot, not both.`);
  } else if (held.knot !== undefined) {
    const knot = finite(held.knot, `${what}.knot`);
    if (!Number.isInteger(knot) || knot < 0 || knot >= ruler.knotStations.length) {
      throw new Error(`${what}.knot ${knot} — this run has knots 0 to ${ruler.knotStations.length - 1}.`);
    }
    station = ruler.knotStations[knot] + (held.along === undefined ? 0 : finite(held.along, `${what}.along`));
  } else {
    throw new Error(`${what} names where along the run: { station: <metres from knot 0> } or `
      + '{ knot: <index>, along: <metres past it> }.');
  }
  if (held.along !== undefined && held.knot === undefined) {
    throw new Error(`${what}.along is metres past a knot — pair it with knot, or fold it into station.`);
  }
  // A millimetre of slack at either end: the ruler answers its length rounded to one, and the last
  // station of a run is a place things get put.
  if (station < -0.0015 || station > ruler.length + 0.0015) {
    throw new Error(`${what}: station ${mm(station)} is off the run, which is ${mm(ruler.length)} m long.`);
  }
  const lateral = held.lateral === undefined ? 0 : finite(held.lateral, `${what}.lateral`);
  const frame = ruler.at(station);
  const [x, , z] = add(frame.pos, mul(frame.side, lateral));
  let y: number;
  if (held.y !== undefined) {
    if (held.above !== undefined) throw new Error(`${what} takes above (from the ground) or y (absolute), not both.`);
    y = finite(held.y, `${what}.y`);
  } else {
    const above = held.above === undefined ? 0 : finite(held.above, `${what}.above`);
    const ground = scene.ground(x, z);
    if (ground === null) outcomes.unseated++;
    y = (ground ?? frame.pos[1]) + above;
  }
  outcomes.placed++;
  return { pos: [mm(x), mm(y), mm(z)], station };
}

/** `yaw` as it may arrive on a prop: a number, or "course" with an optional offset in degrees. */
const COURSE_YAW = /^\s*course\s*(?:([+-])\s*(\d+(?:\.\d+)?))?\s*$/;

function courseYaw(value: string): number | null {
  const match = COURSE_YAW.exec(value);
  if (!match) return null;
  return match[1] === undefined ? 0 : (match[1] === '-' ? -1 : 1) * Number(match[2]);
}

function resolveYaw(scene: Scene, held: unknown, at: Resolved, what: string): unknown {
  if (typeof held !== 'string') return held;
  const offset = courseYaw(held);
  if (offset === null) {
    throw new Error(`${what} is degrees, or "course" (facing downhill along the run), "course+90" (facing the `
      + 'rider\'s left), "course-90" (the rider\'s right), "course+180" (uphill).');
  }
  const station = at.station ?? scene.course.nearest(at.pos[0], at.pos[2]);
  return mm(((scene.course.at(station).heading + offset) % 360 + 360) % 360);
}

/** The value with every position (and a prop's course-relative yaw) resolved to numbers. */
function resolvePlacement(scene: Scene, key: RegisterKey, value: unknown, outcomes: IntentOutcomes): unknown {
  const family = familyOf(key);
  if (family === null || !isObject(value)) return value;
  if (PLACED.has(family)) {
    if (value.pos === undefined) return value;
    const at = resolvePosition(scene, value.pos, outcomes, `${key} pos`);
    const yaw = family === 'prop' && value.yaw !== undefined ? resolveYaw(scene, value.yaw, at, `${key} yaw`) : value.yaw;
    return { ...value, pos: at.pos, ...(value.yaw === undefined ? {} : { yaw }) };
  }
  if (family === 'rail' && Array.isArray(value.nodes)) {
    return { ...value, nodes: value.nodes.map((node, i) => resolvePosition(scene, node, outcomes, `${key} nodes[${i}]`).pos) };
  }
  if (family === 'course' && Array.isArray(value.knots)) {
    return {
      ...value,
      knots: value.knots.map((knot, i) => {
        if (!isObject(knot) || knot.pos === undefined) return knot;
        if (!Array.isArray(knot.pos)) {
          throw new Error(`course knots[${i}].pos is [x, y, z] or [x, null | "+h", z] — a knot is what defines `
            + 'the stations, so it cannot be placed by one.');
        }
        return { ...knot, pos: resolvePosition(scene, knot.pos, outcomes, `course knots[${i}].pos`).pos };
      }),
    };
  }
  if (family === 'model' && value.shape !== undefined) {
    outcomes.shaped++;
    return shaped(value);
  }
  return value;
}

// ---- repeat ------------------------------------------------------------------------------------------------

interface RepeatStep { station?: number; lateral?: number; above?: number; x?: number; y?: number; z?: number; yaw?: number }
const STEP_FIELDS: ReadonlySet<string> = new Set(['station', 'lateral', 'above', 'x', 'y', 'z', 'yaw']);

function repeatStep(held: unknown): RepeatStep {
  if (held === undefined) return {};
  if (!isObject(held)) throw new Error('repeat.step is an object of per-clone increments: station, lateral, above, x, y, z, yaw.');
  const step: RepeatStep = {};
  for (const [field, value] of Object.entries(held)) {
    if (!STEP_FIELDS.has(field)) {
      throw new Error(`repeat.step.${field} — a step increments station, lateral, above (a run-relative position), `
        + 'x, y, z (an [x,y,z] position), or yaw.');
    }
    step[field as keyof RepeatStep] = finite(value, `repeat.step.${field}`);
  }
  return step;
}

/** A single [x, y, z] (in any Y form) moved by n steps. */
function shiftedPoint(point: unknown, step: RepeatStep, n: number, what: string): unknown {
  if (!Array.isArray(point) || point.length !== 3) return point;
  if (step.station || step.lateral || step.above) {
    throw new Error(`${what} is [x, y, z], which steps by x/y/z — station/lateral/above step a { station } position.`);
  }
  const dx = (step.x ?? 0) * n, dy = (step.y ?? 0) * n, dz = (step.z ?? 0) * n;
  const x = typeof point[0] === 'number' ? mm(point[0] + dx) : point[0];
  const z = typeof point[2] === 'number' ? mm(point[2] + dz) : point[2];
  let y: unknown = point[1];
  if (typeof y === 'number') y = mm(y + dy);
  else if (dy !== 0) {
    const offset = groundOffset(y);
    if (offset !== null) y = asOffset(offset + dy);
  }
  return [x, y, z];
}

function shiftedPosition(pos: unknown, step: RepeatStep, n: number, what: string): unknown {
  if (Array.isArray(pos)) return shiftedPoint(pos, step, n, what);
  if (!isObject(pos)) return pos;
  if (step.x || step.y || step.z) {
    throw new Error(`${what} is a { station } position, which steps by station/lateral/above — x/y/z step an [x, y, z].`);
  }
  const moved: Record<string, unknown> = { ...pos };
  const ds = (step.station ?? 0) * n;
  if (ds) {
    if (typeof pos.station === 'number') moved.station = mm(pos.station + ds);
    else moved.along = mm((typeof pos.along === 'number' ? pos.along : 0) + ds);
  }
  const dl = (step.lateral ?? 0) * n;
  if (dl) moved.lateral = mm((typeof pos.lateral === 'number' ? pos.lateral : 0) + dl);
  const da = (step.above ?? 0) * n;
  if (da) {
    if (typeof pos.y === 'number') moved.y = mm(pos.y + da);
    else moved.above = mm((typeof pos.above === 'number' ? pos.above : 0) + da);
  }
  return moved;
}

function shiftedYaw(yaw: unknown, step: RepeatStep, n: number): unknown {
  const dyaw = (step.yaw ?? 0) * n;
  if (!dyaw) return yaw;
  if (typeof yaw === 'number') return mm(((yaw + dyaw) % 360 + 360) % 360);
  if (typeof yaw === 'string') {
    const offset = courseYaw(yaw);
    if (offset !== null) return `course${asOffset(offset + dyaw)}`;
  }
  return yaw;
}

/** Clone n of a value: its positions and yaw stepped, `{i}` in its name filled in. */
function shifted(key: RegisterKey, value: unknown, step: RepeatStep, n: number, index: string): unknown {
  if (!isObject(value)) return value;
  const family = familyOf(key);
  const moved: Record<string, unknown> = { ...value };
  if (typeof moved.name === 'string') moved.name = moved.name.split('{i}').join(index);
  if (family !== null && PLACED.has(family) && moved.pos !== undefined) {
    moved.pos = shiftedPosition(moved.pos, step, n, `${key} pos`);
    if (family === 'prop') moved.yaw = shiftedYaw(moved.yaw, step, n);
  } else if (family === 'rail' && Array.isArray(moved.nodes)) {
    moved.nodes = moved.nodes.map((node, i) => shiftedPoint(node, step, n, `${key} nodes[${i}]`));
  }
  return moved;
}

const REPEAT_LIMIT = 1000;

/**
 * How many clones a `repeat` asks for. `count` says it outright; `every` + `until` say it as a spacing along
 * the run — from the value's own station to `until`, one every so many metres, the step's `station` set to
 * match — which is how a row of lamps or a fence is actually thought about.
 */
function repeatCount(scene: Scene, held: Record<string, unknown>, value: unknown, key: RegisterKey, step: RepeatStep): number {
  if (held.count !== undefined) {
    if (held.every !== undefined || held.until !== undefined) {
      throw new Error('repeat takes count, or every + until — not both.');
    }
    const count = finite(held.count, 'repeat.count');
    if (!Number.isInteger(count) || count < 1 || count > REPEAT_LIMIT) {
      throw new Error(`repeat.count is a whole number from 1 to ${REPEAT_LIMIT}.`);
    }
    return count;
  }
  if (held.every === undefined || held.until === undefined) {
    throw new Error('repeat says how many: { count } or { every: <metres>, until: <station> } — see /api/schemas/AssignRegisters.');
  }
  const every = finite(held.every, 'repeat.every');
  if (every <= 0) throw new Error('repeat.every is a spacing in metres, above zero.');
  if (step.station !== undefined && step.station !== every) {
    throw new Error('repeat.every IS the station step — leave step.station out, or use count with a step.');
  }
  const pos = isObject(value) ? value.pos : undefined;
  if (!isObject(pos) || (pos.station === undefined && pos.knot === undefined)) {
    throw new Error(`repeat.every spaces a { station } position along the run — ${key} has none. Use count and `
      + 'a step for an [x, y, z] position.');
  }
  let from: number;
  if (pos.station !== undefined) {
    from = finite(pos.station, `${key} pos.station`);
  } else {
    const knotStation: number | undefined = scene.course.knotStations[finite(pos.knot, `${key} pos.knot`)];
    if (knotStation === undefined) throw new Error(`${key} pos.knot names no knot this run has.`);
    from = knotStation + (pos.along === undefined ? 0 : finite(pos.along, `${key} pos.along`));
  }
  const until = finite(held.until, 'repeat.until');
  if (until < from) throw new Error(`repeat.until (${until}) is before the position's own station (${mm(from)}).`);
  const count = Math.floor((until - from) / every + 1e-6) + 1;
  if (count > REPEAT_LIMIT) throw new Error(`That spacing makes ${count} clones; ${REPEAT_LIMIT} is the most one change may repeat.`);
  step.station = every;
  return count;
}

function repeated(scene: Scene, key: RegisterKey, value: unknown, held: unknown): { key: RegisterKey; value: unknown }[] {
  if (!isObject(held)) throw new Error('repeat is an object: { count, step } or { every, until, step }.');
  if (!key.includes('{i}')) {
    throw new Error(`A repeated key carries "{i}" where each clone's index goes — e.g. ${key.replace(/(\d+)$/, '')}{i}.`);
  }
  const step = repeatStep(held.step);
  const start = held.start === undefined ? 0 : finite(held.start, 'repeat.start');
  if (!Number.isInteger(start) || start < 0) throw new Error('repeat.start is the first index, a whole number from 0.');
  const count = repeatCount(scene, held, value, key, step);
  const clones: { key: RegisterKey; value: unknown }[] = [];
  for (let n = 0; n < count; n++) {
    const index = String(start + n);
    clones.push({ key: key.split('{i}').join(index), value: shifted(key, value, step, n, index) });
  }
  return clones;
}

// ---- from --------------------------------------------------------------------------------------------------

/** The source's value with `value` merged over it — minus the source's `id`, which the key fills back in. */
function copied(document: EditDoc, key: RegisterKey, from: unknown, value: unknown): unknown {
  if (typeof from !== 'string' || !from) throw new Error('`from` is the register key to copy from.');
  if (from === key) {
    throw new Error(`${key} copied onto itself would be a per-field patch, which a register does not offer `
      + '(docs/039): read the object, change it and assign it whole — or copy it to a NEW key with `from`.');
  }
  const source = readRegister(document, from);
  if (source === undefined) throw new Error(`${from} holds nothing to copy — GET …/registers?keys=${from} to check.`);
  if (value === undefined) return isObject(source) ? withoutId(source) : source;
  if (isObject(source) && isObject(value)) return withoutId({ ...source, ...value });
  throw new Error(`\`from\` merges an object over ${from}'s object; the value sent for ${key} is not one.`);
}

function withoutId(value: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...value };
  delete rest.id;
  return rest;
}

// ---- shapes ------------------------------------------------------------------------------------------------

/**
 * Generated model geometry, in the conventions `authoredModelLevelProps` bakes and the crews verified on a
 * built mountain: the model's own frame is Y up with its base at y = 0 and its footprint centred on the
 * origin, anchor [0, 0, 0], so a placement's `pos` is where it stands and `yaw` turns it. A quad is
 * [A, B, C, D] in bilinear corner order — A bottom-left SEEN FROM OUTSIDE, B bottom-right, C top-left, D
 * top-right — with outward normal (B − A) × (C − A); a wedge repeats its apex as C and D. Every quad wears
 * the whole tile, so `segments` is how many times the tile repeats along an edge.
 */
class MeshBuilder {
  readonly vertices: number[] = [];
  readonly quads: number[][] = [];
  private readonly ids = new Map<string, number>();

  private vertex(p: V3): number {
    const r: V3 = [Math.round(p[0] * 1e4) / 1e4 + 0, Math.round(p[1] * 1e4) / 1e4 + 0, Math.round(p[2] * 1e4) / 1e4 + 0];
    const key = r.join(',');
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    const id = this.vertices.length / 3;
    this.vertices.push(r[0], r[1], r[2]);
    this.ids.set(key, id);
    return id;
  }

  quad(a: V3, b: V3, c: V3, d: V3): void { this.quads.push([this.vertex(a), this.vertex(b), this.vertex(c), this.vertex(d)]); }

  /** A triangle: the collapsed corner (apex) takes the tile's top centre. */
  wedge(a: V3, b: V3, apex: V3): void {
    const c = this.vertex(apex);
    this.quads.push([this.vertex(a), this.vertex(b), c, c]);
  }

  /** A panel of n × rows quads from `origin` (bottom-left seen from outside) along `sweep` (the whole bottom
   *  edge) and `rise` (ONE row's height). Outward normal = sweep × rise. */
  strip(origin: V3, sweep: V3, rise: V3, n: number, rows = 1): void {
    const at = (t: number, lift: number): V3 => [
      origin[0] + sweep[0] * t + rise[0] * lift,
      origin[1] + sweep[1] * t + rise[1] * lift,
      origin[2] + sweep[2] * t + rise[2] * lift,
    ];
    for (let r = 0; r < rows; r++) {
      for (let i = 0; i < n; i++) {
        this.quad(at(i / n, r), at((i + 1) / n, r), at(i / n, r + 1), at((i + 1) / n, r + 1));
      }
    }
  }
}

const SEGMENT_LIMIT = 64;
const QUAD_LIMIT = 4096;

function sizeOf(held: unknown, count: number, what: string): number[] {
  if (!Array.isArray(held) || held.length !== count) {
    throw new Error(`${what} is ${count} metres: ${count === 3 ? '[width, height, depth]' : '[width, height] (a roof: [width, depth])'}.`);
  }
  return held.map((part, i) => {
    const value = finite(part, `${what}[${i}]`);
    if (value <= 0) throw new Error(`${what}[${i}] is above zero.`);
    return value;
  });
}

function segmentsOf(held: unknown, count: number, what: string): number[] {
  if (held === undefined) return Array.from({ length: count }, () => 1);
  const list = count === 1 && !Array.isArray(held) ? [held] : held;
  if (!Array.isArray(list) || list.length !== count) {
    throw new Error(`${what} is ${count === 1 ? 'a whole number' : `${count} whole numbers`} of tile repeats, 1 to ${SEGMENT_LIMIT}.`);
  }
  return list.map((part, i) => {
    const value = finite(part, `${what}[${i}]`);
    if (!Number.isInteger(value) || value < 1 || value > SEGMENT_LIMIT) throw new Error(`${what}[${i}] is a whole number from 1 to ${SEGMENT_LIMIT}.`);
    return value;
  });
}

const flag = (held: unknown, fallback: boolean, what: string): boolean => {
  if (held === undefined) return fallback;
  if (typeof held !== 'boolean') throw new Error(`${what} is true or false.`);
  return held;
};

/** A closed box: four sides and a top (a bottom on request), footprint centred, base at y = 0. */
function box(shape: Record<string, unknown>): MeshBuilder {
  const [w, h, d] = sizeOf(shape.size, 3, 'shape.size');
  const [nx, ny, nz] = segmentsOf(shape.segments, 3, 'shape.segments');
  const hx = w / 2, hz = d / 2, rise: V3 = [0, h / ny, 0];
  const mesh = new MeshBuilder();
  mesh.strip([-hx, 0, hz], [w, 0, 0], rise, nx, ny);     // +Z
  mesh.strip([hx, 0, -hz], [-w, 0, 0], rise, nx, ny);    // -Z
  mesh.strip([hx, 0, hz], [0, 0, -d], rise, nz, ny);     // +X
  mesh.strip([-hx, 0, -hz], [0, 0, d], rise, nz, ny);    // -X
  if (flag(shape.top, true, 'shape.top')) mesh.strip([-hx, h, hz], [w, 0, 0], [0, 0, -d / nz], nx, nz);
  if (flag(shape.bottom, false, 'shape.bottom')) mesh.strip([-hx, 0, -hz], [w, 0, 0], [0, 0, d / nz], nx, nz);
  return mesh;
}

/** A gabled shell: four walls to `size[1]`, two gable triangles rising to `ridge` at the ends. The ridge runs
 *  along X, so `size[0]` is the long side and the eaves are the ±Z faces — pair it with `roof`. */
function house(shape: Record<string, unknown>): MeshBuilder {
  const [w, wall, d] = sizeOf(shape.size, 3, 'shape.size');
  const ridge = finite(shape.ridge, 'shape.ridge');
  if (ridge <= wall) throw new Error(`shape.ridge (${ridge}) is the gable apex height — above the wall height ${wall}.`);
  const [long, end] = segmentsOf(shape.segments, 2, 'shape.segments');
  const hw = w / 2, hd = d / 2, rise: V3 = [0, wall, 0];
  const mesh = new MeshBuilder();
  mesh.strip([-hw, 0, hd], [w, 0, 0], rise, long);    // +Z front
  mesh.strip([hw, 0, -hd], [-w, 0, 0], rise, long);   // -Z back
  mesh.strip([hw, 0, hd], [0, 0, -d], rise, end);     // +X end
  mesh.strip([-hw, 0, -hd], [0, 0, d], rise, end);    // -X end
  mesh.wedge([hw, wall, hd], [hw, wall, -hd], [hw, ridge, 0]);     // +X gable
  mesh.wedge([-hw, wall, -hd], [-hw, wall, hd], [-hw, ridge, 0]);  // -X gable
  return mesh;
}

/** Two roof planes over a `size` = [w, d] footprint: eaves at `eave` height along ±Z, `overhang` past the
 *  walls on every side, meeting at `ridge` over the centreline. Ridge along X, like `house`. */
function roof(shape: Record<string, unknown>): MeshBuilder {
  const [w, d] = sizeOf(shape.size, 2, 'shape.size');
  const eave = finite(shape.eave, 'shape.eave');
  const ridge = finite(shape.ridge, 'shape.ridge');
  if (ridge <= eave) throw new Error(`shape.ridge (${ridge}) is above shape.eave (${eave}).`);
  const over = shape.overhang === undefined ? 0.6 : finite(shape.overhang, 'shape.overhang');
  if (over < 0) throw new Error('shape.overhang is metres past the walls, 0 or more.');
  const [segments] = segmentsOf(shape.segments, 1, 'shape.segments');
  const ex = w / 2 + over, ez = d / 2 + over, rise = ridge - eave;
  const mesh = new MeshBuilder();
  mesh.strip([-ex, eave, ez], [2 * ex, 0, 0], [0, rise, -ez], segments);   // +Z plane, rising to the ridge
  mesh.strip([ex, eave, -ez], [-2 * ex, 0, 0], [0, rise, ez], segments);   // -Z plane
  return mesh;
}

/** A flat rectangle standing on its bottom edge, facing +Z (its back too when `double`): a sign, a window
 *  card, a light strip, a banner. */
function panel(shape: Record<string, unknown>): MeshBuilder {
  const [w, h] = sizeOf(shape.size, 2, 'shape.size');
  const [nx, ny] = segmentsOf(shape.segments, 2, 'shape.segments');
  const hw = w / 2, rise: V3 = [0, h / ny, 0];
  const mesh = new MeshBuilder();
  mesh.strip([-hw, 0, 0], [w, 0, 0], rise, nx, ny);
  if (flag(shape.double, false, 'shape.double')) mesh.strip([hw, 0, 0], [-w, 0, 0], rise, nx, ny);
  return mesh;
}

const SHAPES: Record<string, (shape: Record<string, unknown>) => MeshBuilder> = { box, house, roof, panel };

/** The model value with its `shape` turned into vertices and quads, and the `shape` itself gone — a document
 *  holds geometry, not the recipe. */
function shaped(value: Record<string, unknown>): Record<string, unknown> {
  const { shape, ...rest } = value;
  if (!isObject(shape) || typeof shape.kind !== 'string') {
    throw new Error(`shape is { kind: ${Object.keys(SHAPES).map(k => `"${k}"`).join(' | ')}, size, … }.`);
  }
  if (Array.isArray(rest.vertices) && rest.vertices.length) {
    throw new Error('A model takes either `shape` or its own `vertices` / `quads`, not both.');
  }
  const build = SHAPES[shape.kind];
  if (!build) throw new Error(`shape.kind ${JSON.stringify(shape.kind)} — this server shapes ${Object.keys(SHAPES).join(', ')}.`);
  const mesh = build(shape);
  if (mesh.quads.length > QUAD_LIMIT) {
    throw new Error(`That shape is ${mesh.quads.length} quads; ${QUAD_LIMIT} is the most one model may carry. Fewer segments.`);
  }
  return {
    ...rest,
    ...(typeof rest.name === 'string' ? {} : { name: shape.kind }),
    anchor: [0, 0, 0], vertices: mesh.vertices, quads: mesh.quads,
  };
}

// ---- the expansion -----------------------------------------------------------------------------------------

interface PlainChange { key: string; value?: unknown; remove?: boolean }

/**
 * The request body with every intent in its `changes` expanded into the plain changes the register write
 * takes. Anything that is not a well-formed change is passed through untouched, so the register path's own
 * refusal — which names the shape it wanted — is the one the caller reads.
 */
export function expandIntents(document: EditDoc, body: unknown, ground: () => GroundSampler):
  { body: unknown; outcomes: IntentOutcomes } {
  const outcomes: IntentOutcomes = { placed: 0, repeated: 0, copied: 0, shaped: 0, unseated: 0 };
  if (!isObject(body) || !Array.isArray(body.changes)) return { body, outcomes };
  const scene = new Scene(document, ground);
  const expanded: unknown[] = [];
  for (const entry of body.changes) {
    if (!isObject(entry)) { expanded.push(entry); continue; }
    const key = entry.key;
    if (typeof key !== 'string' || !key) { expanded.push(entry); continue; }
    const { value, remove, from, repeat } = entry;
    const clearing = remove === true || (!('value' in entry) && from === undefined);
    let base = value;
    if (from !== undefined && !clearing) {
      base = copied(document, key, from, value);
      outcomes.copied++;
    }
    const clones = repeat === undefined ? [{ key, value: base }] : repeated(scene, key, base, repeat);
    if (repeat !== undefined) outcomes.repeated += clones.length;
    for (const clone of clones) {
      const plain: PlainChange = clearing
        ? { key: clone.key, remove: true }
        : { key: clone.key, value: resolvePlacement(scene, clone.key, clone.value, outcomes) };
      expanded.push(plain);
    }
  }
  return { body: { ...body, changes: expanded }, outcomes };
}
