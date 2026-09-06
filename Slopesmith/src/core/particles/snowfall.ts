import type { V3 } from '../doc/types';

/**
 * AMBIENT SNOWFALL — the weather a snowy course rides through.
 *
 * The engine model is [Trailmap: 400-rendering] ("Weather: ambient snowfall"): a dedicated weather
 * subsystem, not authored content — a snowy level's particle tables carry none of it. It keeps a small box of
 * flakes centred on the CAMERA and re-centres it every frame, but the flakes are WORLD-FIXED and recycled in
 * discrete whole-cell steps: a flake holds its world position while the rider approaches and passes it (the
 * ride-through PARALLAX) and only jumps when it leaves a face and wraps to the opposite one (the RECYCLE), so
 * nothing is ever left behind however fast you ride. Each flake falls slowly, spins, and draws as a small,
 * faint, ADDITIVE grain that at its on-screen size reads as a soft translucent dot rather than a discernible
 * flake. This is the port of the VRChat world's realization of it ([Unity: 044-snowfall]).
 *
 * This module is the pure half — the tuning, the deterministic bake, and the motion law itself. It is the
 * SPECIFICATION the vertex shader in `app/viewport/scene/snowfall.ts` implements: every function below has a
 * line-for-line GLSL twin there, and `test/snowfall.test.ts` pins the law on the CPU where it can be measured.
 * Keep the two in step — a change here that is not made there changes nothing on screen, and the reverse
 * silently unpins the test.
 *
 * The whole subsystem is shader-driven, which is why the bake below emits flake DATA rather than geometry: a
 * flake's position is a pure function of time and the camera, so there is no simulation state, no per-frame
 * CPU work, and the runtime cost is one draw call plus the flakes' fill.
 */

/** Everything the field's look and motion is made of. One of these describes the weather completely. */
export interface SnowfallSettings {
  /** How many of the baked field to draw. The bake is a uniform random scatter, so the first `flakes` of it
   *  is itself a uniform scatter — thinning the fall is a draw range, not a per-flake test. */
  flakes: number;
  /** Wrap-box size in metres (x, y, z). A flake leaving one face reappears on the opposite one. */
  box: V3;
  /** Box centre above the eye (m) — more sky than ground, since that is where snow is coming from. */
  lift: number;
  /** Fall speed range (m/s). Per flake, off its baked random. */
  fallMin: number;
  fallMax: number;
  /** Horizontal drift speed cap (m/s), signed per flake and per axis. */
  drift: number;
  /** Flake quad size range (m). */
  sizeMin: number;
  sizeMax: number;
  /** A flake shrinks to nothing between these distances from the eye (m), so one about to pass THROUGH the
   *  camera never becomes an unfocusable full-screen flash — also the worst fill-rate case there is. */
  nearFadeStart: number;
  nearFadeEnd: number;
  /** Flakes shrink to nothing over this fraction of each half-extent, measured from the face inward, so the
   *  wrap teleport always happens while the flake is invisible. Without it, riding fast pops flakes into
   *  existence at the leading face. */
  edgeFade: number;
  /** Peak flake alpha, brightness multiplier, and dot softness. */
  alpha: number;
  boost: number;
  softness: number;
}

/**
 * **The ported field**, and the dial's anchor: the VRChat world's `Snowfield` material values
 * ([Unity: 044-snowfall]) carried over value-for-value, so the two ports are the same weather at the same
 * stop. The test pins them for that reason.
 *
 * The engine's own box is far smaller (half-extent 3.5 m, [Trailmap: 400-snow-parallax]) because a PS2 drew a
 * few tens of flakes — at this flake count a box that tight reads as a snow globe strapped to the camera, so
 * the port opens it out and keeps the wrap law exact.
 */
export const SNOWFALL_PORT: SnowfallSettings = {
  flakes: 600,
  box: [40, 34, 40],
  lift: 5,
  fallMin: 2.2,
  fallMax: 4.0,
  drift: 0.7,
  sizeMin: 0.10,
  sizeMax: 0.30,
  nearFadeStart: 0.25,
  nearFadeEnd: 0.6,
  edgeFade: 0.2,
  alpha: 0.5,
  boost: 0.6,
  softness: 0.55,
};

/**
 * **The whiteout**, the far end of the dial — well past anything the engine ever drew, and deliberately so:
 * its own "Snow fall:" parameter only reached double ([Trailmap: 400-snow]), which is heavier snow rather
 * than a different sort of weather.
 *
 * A blizzard is **more snow and more wind**, and nothing else. The flakes stay exactly the size, shape and
 * brightness they are at the port stop — growing them is the obvious way to fill a screen and the wrong one,
 * because a flake that reads as a snowflake at 3 reads as a paper plate at 10, and the eye notices the size
 * long before it notices the weather. What changes:
 *
 * - **Density.** 167× the flakes in a tenth of the volume. Screen coverage works like optical depth — it goes
 *   as `density × flake area × how far the field reaches` — so packing the same small flakes closer is the
 *   only lever that reaches a real whiteout, and the one that reaches it cheapest. The tighter box is part of
 *   that: a blizzard closes the world in, and there is no point drawing snow 20 m out that you could not see
 *   through 2 m of anyway.
 * - **Wind.** 17× the horizontal drift against twice the fall speed, which puts the flakes on a path about
 *   15° off horizontal — driven past the rider rather than settling around them.
 * - **Alpha**, half a stop, because a blizzard's flakes are wet and dense rather than dry grains. `boost`
 *   does NOT move with it: coverage is what should whiten the view, and turning the flakes' own brightness up
 *   as well stops reading as snow and starts reading as a white filter over the lens.
 *
 * Size, softness, the near and edge fades and the box lift are all held at the ported values — the flakes
 * themselves are the same snow throughout the dial.
 */
export const SNOWFALL_BLIZZARD: SnowfallSettings = {
  flakes: 100000,
  box: [18, 16, 18],
  lift: 5,
  fallMin: 5.0,
  fallMax: 8.0,
  drift: 12.0,
  sizeMin: 0.10,
  sizeMax: 0.30,
  nearFadeStart: 0.25,
  nearFadeEnd: 0.6,
  edgeFade: 0.2,
  alpha: 1.0,
  boost: 0.6,
  softness: 0.55,
};

/** The dial's top. */
export const AMOUNT_MAX = 10;

/** Where on the dial the ported field sits — and the default, so a ride begins in the game's own weather.
 *  Low enough to leave the whole top half of the dial for snow the engine could not draw. */
export const AMOUNT_PORT = 3;

/** The bake's size: the blizzard needs every flake, and every lighter setting is a prefix of it. */
export const MAX_FLAKES = SNOWFALL_BLIZZARD.flakes;

/**
 * How the upper half of the dial eases from the ported field to the blizzard. Ramping it straight is wrong at
 * the bottom: the port stop is 600 flakes and the blizzard is a hundred thousand, so a linear first click
 * multiplies the snow twenty-five fold and the dial has a cliff a step above its own default. Measured
 * through the real renderer (`test/snowfall-webgl.test.ts` reports the mean white each stop reaches), this
 * exponent puts every click from 4 upward within about a factor of two of the one below it, which is what
 * a dial should feel like, and cuts the step off the port stop from ~35x to ~13x. That last one cannot be
 * flattened away, only spread: the game's own snowfall really is far lighter than weather you notice as
 * weather, and the dial has to say both. `b = 1` is untouched either way, so the top of the dial is still
 * exactly {@link SNOWFALL_BLIZZARD}.
 */
const RAMP_CURVE = 1.5;

/** Fixed bake seed: every run bakes the identical field, so a ride is reproducible frame for frame. */
export const BAKE_SEED = 4419;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * The weather at a dial setting, 0 (clear) to `AMOUNT_MAX` (whiteout).
 *
 * Two regimes, meeting exactly at `AMOUNT_PORT`:
 *
 * - **Below the port stop, only the count moves.** Every other value stays the ported tuning and the fall
 *   simply thins, which is what the engine's own amount parameter did to it. A light dusting is the same
 *   snow, and less of it.
 * - **Above it, the whole field ramps** toward the blizzard, on {@link RAMP_CURVE}: more flakes packed into a
 *   tighter box, falling faster and driven harder. Past this stop the dial is no longer reproducing the
 *   engine — nothing in the game reaches here — so it says so rather than pretending the extrapolation is a
 *   port. What it never does is grow the flakes; see {@link SNOWFALL_BLIZZARD}.
 */
export function snowfallAt(amount: number): SnowfallSettings {
  const a = clamp(amount, 0, AMOUNT_MAX);
  const b = Math.max(0, (a - AMOUNT_PORT) / (AMOUNT_MAX - AMOUNT_PORT)) ** RAMP_CURVE;
  const p = SNOWFALL_PORT, z = SNOWFALL_BLIZZARD;
  return {
    // Below the port the count is the ONLY thing the dial touches; above it, it climbs with everything else.
    flakes: Math.round(a < AMOUNT_PORT ? (p.flakes * a) / AMOUNT_PORT : mix(p.flakes, z.flakes, b)),
    box: [mix(p.box[0], z.box[0], b), mix(p.box[1], z.box[1], b), mix(p.box[2], z.box[2], b)],
    lift: mix(p.lift, z.lift, b),
    fallMin: mix(p.fallMin, z.fallMin, b),
    fallMax: mix(p.fallMax, z.fallMax, b),
    drift: mix(p.drift, z.drift, b),
    sizeMin: mix(p.sizeMin, z.sizeMin, b),
    sizeMax: mix(p.sizeMax, z.sizeMax, b),
    nearFadeStart: mix(p.nearFadeStart, z.nearFadeStart, b),
    nearFadeEnd: mix(p.nearFadeEnd, z.nearFadeEnd, b),
    edgeFade: mix(p.edgeFade, z.edgeFade, b),
    alpha: mix(p.alpha, z.alpha, b),
    boost: mix(p.boost, z.boost, b),
    softness: mix(p.softness, z.softness, b),
  };
}

/**
 * Per-flake baked data — one INSTANCE of the shared unit quad each, not four vertices of a soup.
 *
 * At the port stop either layout is a rounding error, but the blizzard is a hundred thousand flakes, and a
 * quad soup pays 168 bytes a flake (four vertices of base + corner + randoms, plus six indices) against 28
 * here. That is ~17 MB of buffer versus ~2.8 MB, uploaded at editor start whether or not anyone ever rides
 * through snow. Instancing also makes the amount an `instanceCount` rather than a draw range, which is the
 * same idea said more directly.
 */
export interface SnowFlakes {
  count: number;
  /** `count * 3` — the flake's base point in the unit box [0,1)³. The shader scales it by the wrap box. */
  base: Float32Array;
  /** `count * 4` — [0,1) randoms: x fall speed, y size, z/w horizontal drift. */
  rnd: Float32Array;
}

/** The corner offsets of the one unit quad every flake instances, in {-0.5,+0.5}² — which doubles as the
 *  fragment's falloff UV. Wound as two triangles by {@link SNOWFLAKE_QUAD_INDICES}. */
export const SNOWFLAKE_QUAD_CORNERS: readonly number[] =
  [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0];

export const SNOWFLAKE_QUAD_INDICES: readonly number[] = [0, 1, 2, 0, 2, 3];

/**
 * A seeded PRNG, because the field must be identical on every run and `Math.random` is not.
 *
 * Mulberry32: 32 bits of state, one multiply-xor round, uniform enough for scattering flakes in a box and
 * short enough to read. It does not reproduce Unity's `System.Random` stream — nothing in JavaScript does —
 * and does not have to: what the two ports share is the LAW, not which particular random field it draws.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Scatter `count` flakes through the unit box with their per-flake randoms. Deterministic in `seed`.
 *
 * Every flake is an independent uniform sample, so **any prefix of the field is itself a uniform scatter** —
 * which is what lets the amount thin the fall by drawing fewer instances instead of testing each flake. Unity
 * hashes each flake in the shader and collapses the rejects to zero size; trimming the draw instead removes
 * the vertex work along with the fill, and is a number the CPU can check rather than a GPU `sin`.
 */
export function bakeSnowFlakes(count = MAX_FLAKES, seed = BAKE_SEED): SnowFlakes {
  const random = mulberry32(seed);
  const base = new Float32Array(count * 3);
  const rnd = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    base[i * 3] = random();
    base[i * 3 + 1] = random();
    base[i * 3 + 2] = random();
    rnd[i * 4] = random();
    rnd[i * 4 + 1] = random();
    rnd[i * 4 + 2] = random();
    rnd[i * 4 + 3] = random();
  }
  return { count, base, rnd };
}

/** GLSL `fract`: `x - floor(x)`, which is in [0,1) for negatives too — the whole wrap depends on that. */
export function fract(x: number): number { return x - Math.floor(x); }

/** The flake's per-flake fall speed, quad size and drift velocity, from its baked randoms. */
export function flakeMotion(rnd: ArrayLike<number>, s: SnowfallSettings, offset = 0):
{ fall: number; size: number; drift: [number, number] } {
  return {
    fall: mix(s.fallMin, s.fallMax, rnd[offset]),
    size: mix(s.sizeMin, s.sizeMax, rnd[offset + 1]),
    drift: [(rnd[offset + 2] * 2 - 1) * s.drift, (rnd[offset + 3] * 2 - 1) * s.drift],
  };
}

/**
 * Where a flake is at time `t`, before the wrap: a pure function of time with no simulation state anywhere.
 * The base point scales by the box, then falls and drifts. Unbounded on purpose — the wrap is what bounds it.
 */
export function flakePath(base: V3, rnd: ArrayLike<number>, t: number, s: SnowfallSettings): V3 {
  const { fall, drift } = flakeMotion(rnd, s);
  return [
    base[0] * s.box[0] + drift[0] * t,
    base[1] * s.box[1] - fall * t,
    base[2] * s.box[2] + drift[1] * t,
  ];
}

/** The wrap box's centre for an eye at `eye`: the eye itself, lifted so more of the box is overhead. */
export function boxCentre(eye: V3, s: SnowfallSettings): V3 {
  return [eye[0], eye[1] + s.lift, eye[2]];
}

/**
 * The engine's cell recycle, as a toroidal wrap: the flake's offset from the box centre, folded per axis into
 * ±half-box. A flake inside the box comes back UNTOUCHED — that is the ride-through parallax, the property
 * that makes you pass snow rather than tow it — and one that has fallen or drifted off a face comes back on
 * the opposite one. It wraps the flake CENTRE only; the quad's corner offset is added afterward, so a quad can
 * never straddle a wrap and tear across the box.
 */
export function wrapOffset(p: V3, centre: V3, s: SnowfallSettings): V3 {
  const axis = (i: number) => (fract((p[i] - centre[i]) / s.box[i] + 0.5) - 0.5) * s.box[i];
  return [axis(0), axis(1), axis(2)];
}

/** The wrapped flake centre in world space. */
export function wrapFlake(p: V3, centre: V3, s: SnowfallSettings): V3 {
  const off = wrapOffset(p, centre, s);
  return [centre[0] + off[0], centre[1] + off[1], centre[2] + off[2]];
}

/**
 * The edge fade, as a size scale in [0,1]: 1 through the middle of the box, smoothly to 0 at every face. The
 * wrap teleport therefore always happens to an invisible flake. Shrinking rather than fading costs no extra
 * interpolator, and an additive dot's light scales with its area, so the shrink already reads as a fade.
 */
export function edgeFadeScale(off: V3, s: SnowfallSettings): number {
  const e = Math.max(Math.abs(off[0]) / (s.box[0] * 0.5),
    Math.abs(off[1]) / (s.box[1] * 0.5), Math.abs(off[2]) / (s.box[2] * 0.5));
  const f = clamp((1 - e) / s.edgeFade, 0, 1);
  return f * f * (3 - 2 * f);   // smoothstep: no kink where a flake enters the band
}

/** The near fade, as a size scale in [0,1]: 0 at the eye, 1 once the flake is far enough to be looked at. */
export function nearFadeScale(distance: number, s: SnowfallSettings): number {
  return clamp((distance - s.nearFadeStart) / Math.max(s.nearFadeEnd - s.nearFadeStart, 0.01), 0, 1);
}
