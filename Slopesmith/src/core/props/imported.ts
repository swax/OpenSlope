/**
 * IMPORTED props — glTF/GLB models loaded into the editor, the third way geometry becomes a placeable prop
 * beside the models borrowed from an extracted level (docs/012) and the quad cages authored with the mesh
 * tools (docs/028).
 *
 * The whole design rests on one observation: `PropSub` ALREADY is "per-material submesh with real UVs and
 * indexed triangles", which is exactly what a glTF primitive unpacks into. So an imported model decodes into
 * the same `LevelProps` an extracted level does — raw cm, Z-up, X-mirrored, model-local — and the library
 * grid, thumbnails, arming ghost, seating offsets, selection outlines and instance rendering all run through
 * the existing prop pipeline with no new rendering path. The server even answers in `PropsPayload`, so the
 * client reuses `decodeProps` verbatim.
 *
 * Textures ride the SAME mountain-local `assets/textures/` bank the Texture Library's authored entry writes (docs/005):
 * import extracts each material's base-colour image, POSTs it through the existing texture-upload route, and
 * references it as "Custom/<name>.png" — the "LEVEL/file.png" form prop-assets.ts already resolves to a
 * cross-level fetch. No new texture serving route, and a GLB's art shows up in the paint palette like any
 * other custom tile.
 *
 * Why a level of its own rather than folding into '@models': an AuthoredModel is a quad cage wearing ONE
 * uniform tile, so a multi-material triangle mesh cannot round-trip through it (`reviseModelFromProp` says
 * as much — "UVs/materials do NOT carry"). Keeping the level string distinct also lets the export and its
 * preflight tell "quad cage I can bake" from "arbitrary triangle soup I cannot" by level alone.
 *
 * See docs/032-imported-props.md.
 */

import type { UvScrollEffect } from '../effects/world-effects';
import type { PropAlphaMode, PropModelAnimation, PropModelAnimationObject, PropModelCurve } from '../reference/props';
import type { FalGenerationProvenance } from '../paint/fal-models';

/** The synthetic prop-library "level" imported models live under. A placement of one is an ordinary
 *  `PlacedProp` carrying this level and the model's assigned number, so selection, gizmos, multi-select,
 *  undo and `.slope` persistence all treat it exactly like a borrowed reference prop. */
export const IMPORTED_PROP_LEVEL = '@import';

/**
 * Read one glTF `extras` key, falling back to its pre-rename spelling.
 *
 * The keys below were `SWX_*` before the OpenSlope rename, and a GLB is a file on someone's disk — assets
 * exported by the older `_lib.py` still carry the old key. Reads accept either; only the current key is
 * ever written, so a re-export quietly migrates a model.
 */
function readExtra(extras: unknown, key: string, legacyKey: string): unknown {
  const bag = extras as Record<string, unknown> | null | undefined;
  const value = bag?.[key];
  return value === undefined || value === null ? bag?.[legacyKey] : value;
}

/**
 * Triangle ceiling for a single imported model — import refuses anything denser rather than letting it into
 * the document.
 *
 * Grounded in the retail census from docs/028: all 648 GARI models together are ~225k triangles, so a shipped
 * prop averages ~350. This cap is ~140× that average — generous enough for modern GLB content that was never
 * authored to a PS2 budget, while still refusing the 200k-triangle scans that could never become a prop. The
 * editor viewport would survive those; the eventual `Props.obj` bake would not.
 */
export const MAX_IMPORT_TRIS = 50_000;

/**
 * The glTF material `extras` key a model uses to declare its own material motion.
 *
 * glTF carries `extras` — free-form JSON — on almost every object it defines, and three.js hands a
 * material's straight back as `userData`. That makes a GLB self-describing: a snow gun's plume says it
 * scrolls, and the effect arrives WITH the model instead of having to be re-authored against every
 * placement in the Effects editor. `tools/prop-recipes/_lib.py` writes it (`surface(scroll=...)`), and
 * Blender only emits it at all when the exporter runs with `export_extras=True`.
 */
export const OS_EFFECT_EXTRA = 'OpenSlope_effect';
/** Pre-rename spelling of {@link OS_EFFECT_EXTRA}, still present in older GLBs. */
const LEGACY_EFFECT_EXTRA = 'SWX_effect';

/** Rates above this are refused outright. At 60 ticks/s that is still 30 UV lengths a second — far past
 *  anything a viewer could read as motion rather than noise. */
const MAX_SCROLL_PER_TICK = 0.5;

/** The most frames one imported material may declare. The widest thing the engine drives is the 16-cell
 *  crowd bank; every authored flipbook in the shipped levels is between two and five. */
export const MAX_IMPORT_FLIPBOOK_FRAMES = 16;

/** The glTF node `extras` key carrying a model's own particle emitters. */
export const OS_EMITTERS_EXTRA = 'OpenSlope_emitters';
/** Pre-rename spelling of {@link OS_EMITTERS_EXTRA}, still present in older GLBs. */
const LEGACY_EMITTERS_EXTRA = 'SWX_emitters';

/** Per model. A prop with more emitters than this is refused rather than allowed to schedule unbounded
 *  particle work off the back of a file nobody vetted. */
export const MAX_IMPORT_EMITTERS = 8;

/** Native field count of a `type2Sub0` timer-emitter payload: U0…U50. */
const EMITTER_FIELD_COUNT = 51;

/**
 * One emitter a model declared for itself.
 *
 * `fields` is SSX's OWN `type2Sub0` payload — the same bag `Effects.json` stores and
 * `timerEmitterPreviewLaw` decodes — so an emitter declared in a GLB and one authored in the Effects
 * editor are the same record, and the runtime that plays one plays the other. `U9…U11` is the spawn
 * point in model-local raw cm; the importer writes it from the file's `at`, because only the importer
 * knows the bounding-box shift it applies to the geometry.
 */
export interface ImportedEmitter {
  fields: Record<string, number>;
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * A point in glTF world space (metres, Y-up) to the model-local raw cm a record stores — the SAME map
 * the importer applies to every vertex, re-centring included.
 *
 * Extracted from the importer so it can be tested against the vertex path directly. A spawn point that
 * takes a slightly different route lands a metre off the muzzle, which reads as a physics bug rather
 * than an import one and is the sort of thing that survives review.
 */
export function rawFromGltfPoint(p: readonly [number, number, number],
  centreX: number, centreY: number): [number, number, number] {
  return [-100 * p[0] - centreX, -100 * p[2] - centreY, 100 * p[1]];
}

/**
 * A DIRECTION in glTF world space to the same model-local raw frame, returned unit.
 *
 * The point map without the translation or the centimetres — a spin axis has no origin, so putting one
 * through `rawFromGltfPoint` would bend it by the model's own re-centring. The frame change is a mirror,
 * which reverses the sense of a rotation about the axis it returns; the declared rate carries whichever
 * direction the author wanted and is simply flipped if it comes out wrong.
 */
export function rawFromGltfDirection(v: readonly [number, number, number]): [number, number, number] {
  const x = -v[0], y = -v[2], z = v[1];
  const length = Math.hypot(x, y, z);
  return length > 0 ? [x / length, y / length, z / length] : [0, 0, 1];
}

/**
 * Recover the emitters a GLB declared, WITHOUT their spawn point — `at` is returned alongside so the
 * caller can put it through the same frame change and re-centring the vertices get.
 *
 * As with the scroll, this is untrusted: every field is checked, the count is bounded, and a payload
 * missing the fields the runtime reads is dropped rather than handed on half-formed.
 */
export function importedEmittersFromExtras(extras: unknown):
{ at: [number, number, number]; emitter: ImportedEmitter }[] {
  const raw = readExtra(extras, OS_EMITTERS_EXTRA, LEGACY_EMITTERS_EXTRA);
  if (raw === undefined || raw === null) return [];
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return []; }
  }
  if (!Array.isArray(parsed)) return [];
  const out: { at: [number, number, number]; emitter: ImportedEmitter }[] = [];
  for (const item of parsed.slice(0, MAX_IMPORT_EMITTERS)) {
    const at = (item as { at?: unknown })?.at;
    const source = (item as { fields?: unknown })?.fields;
    if (!Array.isArray(at) || at.length !== 3 || !source || typeof source !== 'object') continue;
    const position = at.map(v => finite(v));
    if (position.some(v => v === null)) continue;
    const fields: Record<string, number> = {};
    let bad = false;
    for (let i = 0; i < EMITTER_FIELD_COUNT; i++) {
      const value = finite((source as Record<string, unknown>)[`U${i}`]);
      // A missing field is a zero — that is what the native reader does — but a present-and-unusable
      // one means the payload was not written by anything that understood the format.
      if (value === null && (source as Record<string, unknown>)[`U${i}`] !== undefined) { bad = true; break; }
      fields[`U${i}`] = value ?? 0;
    }
    if (bad) continue;
    if (!(fields.U0 >= 1)) continue;                       // no particles: nothing to schedule
    fields.U0 = Math.min(512, Math.round(fields.U0));      // bound the per-emitter particle budget
    out.push({ at: position as [number, number, number], emitter: { fields } });
  }
  return out;
}

/**
 * The glTF node `extras` key a node uses to declare that its geometry SPINS.
 *
 * The same self-describing trick as the scroll and the emitters, applied to the one kind of motion a
 * prop's GEOMETRY can have: a snow gun's fan turns inside its barrel while the machine around it stays
 * bolted down. Declaring it on the NODE rather than the material is what makes that split possible —
 * a material is a surface, and this moves a set of vertices.
 */
export const OS_ANIM_EXTRA = 'OpenSlope_animation';
/** Pre-rename spelling of {@link OS_ANIM_EXTRA}, still present in older GLBs. */
const LEGACY_ANIM_EXTRA = 'SWX_animation';

/** Past this the blades are a strobe rather than a rotation, and at 30 fps the clip would be a single
 *  frame long. Retail's own snow blower head runs 2 rev/s. */
const MAX_SPIN_REVS_PER_SECOND = 20;

/** Per model. Each declared rotation costs two `ModelObjects` entries and a clip channel; four declarations
 *  plus the static root pack to 9, safely below the measured PAL animated-model ceiling of 27 total entries. */
export const MAX_IMPORT_SPINS = 4;

/** One node's declared rotation. A spin turns continuously; a swing traces a smooth pendulum cycle.
 *  `axis` is in the file's own glTF frame (metres, Y-up) and need not be unit. */
export type ImportedSpin = {
  axis: [number, number, number];
  revsPerSecond: number;
  amplitudeDegrees?: undefined;
  periodSeconds?: undefined;
} | {
  axis: [number, number, number];
  revsPerSecond?: undefined;
  amplitudeDegrees: number;
  periodSeconds: number;
};

/** Keep authored pendulums plausible and their native clips compact. */
const MAX_SWING_DEGREES = 89;
const MAX_SWING_PERIOD_SECONDS = 30;

/**
 * Recover a node's declared spin or swing, or null.
 *
 * Untrusted like the rest of `extras`: a zero-length axis, a non-finite rate and a rate past
 * `MAX_SPIN_REVS_PER_SECOND` are all refused rather than handed to the clip builder, because each one
 * produces a clip that either divides by zero or animates nothing.
 */
export function importedSpinFromExtras(extras: unknown): ImportedSpin | null {
  const raw = readExtra(extras, OS_ANIM_EXTRA, LEGACY_ANIM_EXTRA);
  if (raw === undefined || raw === null) return null;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return null; }
  }
  const declaration = parsed as { spin?: Record<string, unknown>; swing?: Record<string, unknown> } | null;
  const spin = declaration?.spin;
  const swing = declaration?.swing;
  const motion = spin && typeof spin === 'object' ? spin : swing && typeof swing === 'object' ? swing : null;
  if (!motion) return null;
  const axis = motion.axis;
  if (!Array.isArray(axis) || axis.length !== 3) return null;
  const parts = axis.map(v => finite(v));
  if (parts.some(v => v === null)) return null;
  const [x, y, z] = parts as number[];
  if (!(Math.hypot(x, y, z) > 1e-6)) return null;                  // no axis: nothing to turn about
  if (motion === spin) {
    const revsPerSecond = finite(spin.revsPerSecond);
    if (revsPerSecond === null || revsPerSecond === 0) return null;   // declared, but stationary
    if (Math.abs(revsPerSecond) > MAX_SPIN_REVS_PER_SECOND) return null;
    return { axis: [x, y, z], revsPerSecond };
  }
  const amplitudeDegrees = finite(swing!.amplitudeDegrees);
  const periodSeconds = finite(swing!.periodSeconds);
  if (amplitudeDegrees === null || !(Math.abs(amplitudeDegrees) > 0)
    || Math.abs(amplitudeDegrees) > MAX_SWING_DEGREES) return null;
  if (periodSeconds === null || !(periodSeconds > 0) || periodSeconds > MAX_SWING_PERIOD_SECONDS) return null;
  return { axis: [x, y, z], amplitudeDegrees, periodSeconds };
}

/** Shortest-arc unit quaternion (x, y, z, w) taking +Y onto the unit vector `axis`. */
function quaternionFromUnitY(axis: readonly [number, number, number]): [number, number, number, number] {
  const [ax, ay, az] = axis;
  if (ay > 0.999999) return [0, 0, 0, 1];
  if (ay < -0.999999) return [0, 0, 1, 0];    // 180°, about any perpendicular — Z will do
  // cross((0,1,0), axis) = (az, 0, -ax)
  const s = Math.sqrt((1 + ay) * 2);
  return [az / s, 0, -ax / s, s / 2];
}

function quaternionConjugate(q: readonly [number, number, number, number]): [number, number, number, number] {
  return [-q[0], -q[1], -q[2], q[3]];
}

/** Hamilton product, applying `b` first and then `a`. */
function quaternionMultiply(a: readonly [number, number, number, number],
  b: readonly [number, number, number, number]): [number, number, number, number] {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

function rotateByQuaternion(v: readonly [number, number, number],
  q: readonly [number, number, number, number]): [number, number, number] {
  const p: [number, number, number, number] = [v[0], v[1], v[2], 0];
  const turned = quaternionMultiply(quaternionMultiply(q, p), quaternionConjugate(q));
  return [turned[0], turned[1], turned[2]];
}

/** One absolute-time cubic Hermite segment in the native [a,b,c,d,start,end] representation. */
function hermiteSegment(start: number, end: number, from: number, to: number,
  fromSlope: number, toSlope: number): PropModelCurve[number] {
  const h = end - start;
  const localA = (2 * from - 2 * to + h * (fromSlope + toSlope)) / (h ** 3);
  const localB = (-3 * from + 3 * to - h * (2 * fromSlope + toSlope)) / (h ** 2);
  return [
    localA,
    localB - 3 * localA * start,
    fromSlope - 2 * localB * start + 3 * localA * start * start,
    from - fromSlope * start + localB * start * start - localA * start * start * start,
    start,
    end,
  ];
}

/** Four Hermite quarters per cycle closely reproduce a sine while closing at zero with matching velocity. */
function swingCurve(amplitude: number, cycles: number, seconds: number): PropModelCurve {
  const curve: PropModelCurve = [];
  const period = seconds / cycles;
  const slope = amplitude * 2 * Math.PI / period;
  const values = [0, amplitude, 0, -amplitude, 0];
  const slopes = [slope, 0, -slope, 0, slope];
  for (let cycle = 0; cycle < cycles; cycle++) {
    const cycleStart = cycle * period;
    for (let quarter = 0; quarter < 4; quarter++) {
      const start = cycleStart + quarter * period / 4;
      const end = cycleStart + (quarter + 1) * period / 4;
      curve.push(hermiteSegment(start, end, values[quarter], values[quarter + 1],
        slopes[quarter], slopes[quarter + 1]));
    }
  }
  return curve;
}

/**
 * Turn declared spins and swings into the object-hierarchy clip the prop renderer already plays — the same
 * `PropModelAnimation` shape recovered from an extracted level's `ModelObjects`, which is how retail's
 * own snow blower turns its head (SNOW model 35: object 1 parented to object 0, one rotation channel).
 *
 * Each spin becomes a PAIR of objects rather than one, and the pair is the whole trick. An animated
 * object's pose is built from `baseEuler` plus whichever channels carry curves, with its `restRotation`
 * taking no part — the PS2 engine composes it that way and the renderer follows — so an object that both
 * TILTS and TURNS would have to express its tilt as an Euler triple, and the animated component would then
 * be one factor of that triple rather than a turn about the tilted axis. That is why every retail spin is
 * about a plain model cardinal axis. Splitting dodges the question entirely: an unanimated MOUNT carries the
 * tilt as an exact quaternion, and its animated child turns about a plain local Y with a zero base. The
 * delta applied is a conjugation, so the result is a rotation about `axis` through `pivot` whatever the
 * Euler order turns out to be.
 *
 * `pivot` and `axis` are in MODEL-LOCAL RAW cm (axis unit) — the caller converts, because only it knows
 * the re-centring the vertices took.
 *
 * `parent`, when present, is another spin's ordinal earlier in the array. Its TURNING child owns this
 * spin's mount, so a car can orbit with a platform and still turn about its own axle. Pivots and axes stay
 * model-local in the declaration; this builder derives the child mount's parent-local rest transform.
 * Requiring parents to precede children matches glTF traversal order and rules cycles out structurally.
 *
 * One clip serves every declared rotation. The slowest motion sets the window and every faster motion is
 * snapped to a whole number of turns/cycles within it; a fractional cycle would jump at the loop wrap.
 */
export function importedSpinAnimation(
  spins: readonly ({ pivot: readonly [number, number, number]; axis: readonly [number, number, number];
    parent?: number } & ({ revsPerSecond: number; amplitudeDegrees?: undefined; periodSeconds?: undefined }
      | { revsPerSecond?: undefined; amplitudeDegrees: number; periodSeconds: number }))[],
): { animation: PropModelAnimation; objectOf: number[] } | null {
  if (!spins.length) return null;
  if (spins.some((spin, i) => spin.parent !== undefined
    && (!Number.isInteger(spin.parent) || spin.parent < 0 || spin.parent >= i))) return null;
  if (spins.some(spin => spin.revsPerSecond !== undefined
    ? !Number.isFinite(spin.revsPerSecond) || spin.revsPerSecond === 0
    : !Number.isFinite(spin.amplitudeDegrees) || spin.amplitudeDegrees === 0
      || !Number.isFinite(spin.periodSeconds) || !(spin.periodSeconds > 0))) return null;
  // The slowest motion sets the window, so every faster one still completes whole cycles in it.
  const nominalPeriods = spins.map(s => s.revsPerSecond !== undefined
    ? 1 / Math.abs(s.revsPerSecond) : s.periodSeconds);
  const clipFrames = Math.max(1, Math.round(30 * Math.max(...nominalPeriods)));
  const seconds = clipFrames / 30;
  const objects: PropModelAnimationObject[] = [
    { parent: -1, restPosition: [0, 0, 0], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1] },
  ];
  const objectOf: number[] = [];
  const worldPivots: [number, number, number][] = [];
  const worldRotations: [number, number, number, number][] = [];
  for (const spin of spins) {
    const axisLength = Math.hypot(...spin.axis);
    if (!(axisLength > 1e-6)) return null;
    const axis = spin.axis.map(v => v / axisLength) as [number, number, number];
    const worldRotation = quaternionFromUnitY(axis);
    const parentSpin = spin.parent;
    let parentObject = 0;
    let restPosition: [number, number, number] = [spin.pivot[0], spin.pivot[1], spin.pivot[2]];
    let restRotation = worldRotation;
    if (parentSpin !== undefined) {
      parentObject = objectOf[parentSpin];
      const inverseParent = quaternionConjugate(worldRotations[parentSpin]);
      const parentPivot = worldPivots[parentSpin];
      restPosition = rotateByQuaternion([
        spin.pivot[0] - parentPivot[0], spin.pivot[1] - parentPivot[1], spin.pivot[2] - parentPivot[2],
      ], inverseParent);
      restRotation = quaternionMultiply(inverseParent, worldRotation);
    }
    const mount = objects.length;
    objects.push({
      parent: parentObject,
      restPosition,
      restRotation,
      restScale: [1, 1, 1],
    });
    const cycles = Math.max(1, Math.round(seconds / (spin.revsPerSecond !== undefined
      ? 1 / Math.abs(spin.revsPerSecond) : spin.periodSeconds)));
    const rotation: PropModelCurve = spin.revsPerSecond !== undefined
      ? [[0, 0, 360 * cycles * Math.sign(spin.revsPerSecond) / seconds, 0, 0, seconds]]
      : swingCurve(spin.amplitudeDegrees, cycles, seconds);
    objects.push({
      parent: mount,
      restPosition: [0, 0, 0], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1],
      basePosition: [0, 0, 0], baseEuler: [0, 0, 0],
      // [a, b, c, d, startSeconds, endSeconds] by Horner: linear for spins, cubic for pendulums.
      channels: [null, null, null, null, rotation, null],
    });
    objectOf.push(objects.length - 1);
    worldPivots.push([spin.pivot[0], spin.pivot[1], spin.pivot[2]]);
    worldRotations.push(worldRotation);
  }
  return { animation: { clipFrames, objects }, objectOf };
}

/**
 * Recover a UV scroll from one material's `extras`, or null.
 *
 * Everything here is UNTRUSTED: `extras` is whatever was in a file a user dropped on the library, so
 * each field is checked rather than cast. `uLength`/`vLength` are accepted as legacy spellings for the
 * formerly misidentified U3/U4 fields; native behavior proves they are active/pause durations.
 */
export function importedMaterialScroll(extras: unknown): UvScrollEffect | null {
  const raw = readExtra(extras, OS_EFFECT_EXTRA, LEGACY_EFFECT_EXTRA);
  if (raw === undefined || raw === null) return null;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    // Blender writes custom properties as strings; a malformed one must not take the import down.
    try { parsed = JSON.parse(raw); } catch { return null; }
  }
  const scroll = (parsed as { uvScroll?: Record<string, unknown> } | null)?.uvScroll;
  if (!scroll || typeof scroll !== 'object') return null;
  const uPerTick = finite(scroll.uPerTick) ?? 0;
  const vPerTick = finite(scroll.vPerTick) ?? 0;
  const activeDuration = finite(scroll.activeDuration) ?? finite(scroll.uLength) ?? 1;
  const pauseDuration = finite(scroll.pauseDuration) ?? finite(scroll.vLength) ?? 0;
  const lifetime = finite(scroll.lifetime) ?? 0;
  if (!(activeDuration > 0) || pauseDuration < 0 || lifetime < 0) return null;
  if (uPerTick === 0 && vPerTick === 0) return null;              // declared, but stationary
  if (Math.abs(uPerTick) > MAX_SCROLL_PER_TICK || Math.abs(vPerTick) > MAX_SCROLL_PER_TICK) return null;
  return { mode: finite(scroll.mode) ?? 0, uPerTick, vPerTick, activeDuration, pauseDuration, lifetime };
}

/**
 * How many flipbook frames one material's `extras` declares, or null for an ordinary single-image material.
 *
 * A flipbook material's page is a vertical FILMSTRIP: N frames of one identical layout stacked top to
 * bottom, so UVs authored against a single frame address every frame and the importer can cut the page into
 * N bank tiles with no UV remapping. That is also how flipbook art really works — the frames of a warning
 * sign or a button differ in paint, not in layout.
 *
 * Only the count is declared, never a rate. A frame list is a STATE list; what plays it — if anything — is
 * an SSF effect the level authors against the placement ([Trailmap: 410-texture-animation]), which is why a
 * two-frame button rests instead of strobing. Untrusted like every other `extras` field.
 */
export function importedMaterialFlipbook(extras: unknown): number | null {
  const raw = readExtra(extras, OS_EFFECT_EXTRA, LEGACY_EFFECT_EXTRA);
  if (raw === undefined || raw === null) return null;
  let parsed: unknown = raw;
  if (typeof raw === 'string') {
    try { parsed = JSON.parse(raw); } catch { return null; }
  }
  const flipbook = (parsed as { flipbook?: Record<string, unknown> } | null)?.flipbook;
  if (!flipbook || typeof flipbook !== 'object') return null;
  const frames = finite(flipbook.frames);
  if (frames === null || !Number.isInteger(frames)) return null;
  return frames >= 2 && frames <= MAX_IMPORT_FLIPBOOK_FRAMES ? frames : null;
}

/** How one imported model is stored on disk (`assets/props/<stem>.json` inside its mountain). Geometry is base64 Float32 /
 *  Uint32 in the same packing `PropsPayload` uses on the wire, so serving is a remap rather than a re-encode.
 *  Material ids are LOCAL to the file (0…n-1); the server rebases them when it assembles the level payload,
 *  so importing a new model can never renumber an existing one's materials. */
export interface ImportedPropRecord {
  /** Assigned once at import and never reused — placements store this number. */
  id: number;
  /** Display name shown in the library grid (derived from the GLB file name). */
  name: string;
  /** Triangle count at import, kept so the catalogue can be listed without decoding geometry. */
  tris: number;
  /** `object` is the `animation.objects[]` index this submesh's vertices belong to, present only on a
   *  model that declared a spin. The vertices stay baked in that object's REST pose exactly as an
   *  extracted level's do, so the renderer's animated-world × inverse-rest delta applies unchanged. */
  subs: { mat: number; pos: string; uv: string; idx: string; object?: number }[];
  /** Local material index → its texture ref, in the "Custom/<name>.png" cross-level form (null = untextured,
   *  which renders as the neutral clay every prop pipeline consumer already falls back to). `scroll` is the
   *  material motion the GLB declared for itself in `extras` (see `importedMaterialScroll`); it is per
   *  MATERIAL rather than per model because that is the only way a prop can have one surface move and
   *  another stay put — a snow gun's plume scrolls while its bodywork does not. `frames` is the material's
   *  flipbook state list in the same cross-level ref form, `frames[0] === tex`; the importer cut it out of
   *  the filmstrip page the GLB declared (see `importedMaterialFlipbook`). */
  materials: { id: number; tex: string | null; scroll?: UvScrollEffect; frames?: string[];
    /** Draw through the native alpha-blend pass instead of treating partial alpha as a cutout mask. */
    blend?: boolean;
    /** Explicit glTF/author verdict. MASK becomes cutout and BLEND becomes blend; absent keeps pixel auto. */
    alphaMode?: PropAlphaMode }[];
  /** Particle emitters the model declared for itself, spawn points already in model-local raw cm. A
   *  placement of this model auto-attaches them as an effect graph (docs/032 · particles). */
  emitters?: ImportedEmitter[];
  /** The object-hierarchy clip built from the file's declared spins, in the same shape an extracted
   *  level's `ModelObjects` decode to — so the prop renderer plays an imported clip and a borrowed one
   *  through one path. A placement auto-attaches the Model clip effect that runs it. */
  animation?: PropModelAnimation;
  /** fal endpoint/terms snapshot retained when this model came from Generate prop. No prompt or API key. */
  generation?: FalGenerationProvenance;
}

/** Display name for an imported model, from its GLB file name: "old_lamp_post.glb" → "old lamp post". */
export function importedPropName(file: string): string {
  const stem = file.replace(/\.(glb|gltf)$/i, '').replace(/[-_]+/g, ' ').trim();
  return stem || file;
}

/**
 * Uniformly rescale a converted draft so its longest side is `meters`. A hand-authored GLB is imported at
 * its authored scale on purpose (glb-import.ts), but a GENERATED mesh arrives normalized to roughly a unit
 * box — its scale means nothing — so the Generate prop dialog asks for a real size instead. Structural on
 * purpose: only the fields the maths touches, so it stays testable without pulling in the glTF loader.
 */
export function scaleDraftTo(
  draft: { size: [number, number, number]; subs: { positions: Float32Array }[];
    emitters?: ImportedEmitter[] }, meters: number,
): void {
  const longest = Math.max(...draft.size);
  if (!(longest > 0) || !(meters > 0)) return;
  const k = meters / longest;
  for (const sub of draft.subs) {
    for (let i = 0; i < sub.positions.length; i++) sub.positions[i] *= k;
  }
  // The spawn point scales with the model or it stops being at the muzzle, and the particles scale so a
  // gun at twice the size does not throw the same flecks. Velocity and gravity are deliberately left
  // alone: they are physics, and a bigger snow gun still throws snow at the speed snow leaves a barrel.
  for (const emitter of draft.emitters ?? []) {
    for (const key of ['U9', 'U10', 'U11', 'U4', 'U6']) emitter.fields[key] *= k;
  }
  draft.size = [draft.size[0] * k, draft.size[1] * k, draft.size[2] * k];
}
