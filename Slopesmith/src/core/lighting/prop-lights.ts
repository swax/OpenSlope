import { hexToRgb } from '../math/color';
import type { SunLight, V3 } from '../doc/types';
import { applyQuat, conjugateQuat, isTilted, placementQuat, type PropRotation } from '../props/pose';

/**
 * PER-INSTANCE prop lighting authored from the Slopesmith sun (docs/032 · lighting).
 *
 * SSX lights static props from data on the INSTANCE, not from the terrain lightmap and not from the PBD
 * light list: each instance carries `AmbentLightColour` (a cool sky fill) plus up to three directional keys
 * (`LightColour1..3` + `LightVector1..3`), and the engine evaluates `ambient + Σ max(0, N·L)·key` per vertex
 * [Unity docs/unity/010-object-lighting]. Retail authored those values offline per prop, which is why a
 * boulder in shade reads dim and cool while an exposed one reads bright and warm — a measured 3–5× spread.
 *
 * Slopesmith samples the terrain bake and authors that ambient/key payload on each canonical instance, so
 * the editor, bundle and repack all evaluate the same mountain lighting.
 *
 * Two constraints keep that payload native-shaped:
 *
 *  - **No N·L.** The engine applies `max(0, N·L)` per vertex from `LightVector1`, so pre-multiplying here
 *    would square the term and flatten every prop. This supplies the light; the hardware shades with it.
 *    That is also why one point sample per prop is the right granularity rather than a compromise — the
 *    per-instance record IS per-instance, and the per-vertex variation comes from the engine.
 *  - **Raw record magnitude.** Instance colours use the raw HDR sun and ambient that `buildLightsJson`
 *    writes. The sampled terrain value attenuates that key; `bakeExposure` affects the LDR terrain map only
 *    (see INSTANCE_LIGHT_SCALE).
 */

/**
 * Light record → the instance record's stored scale. This is RETAIL'S OWN RULE, measured, not a fit:
 *
 *     instance key     = sun record colour     × 128 × cast shadow
 *     instance ambient = ambient record colour × 128 × AO
 *
 * The brightest instance key in a level is EXACTLY its type-0 sun record × 128 — GARI 2.470 → 316.16,
 * ELYSIUM 2.200 → 281.60, MERQUER 0.629 → 80.49, MESA 2.230 → 285.39, all ratio 128.00 to the digit, across
 * sun records spanning 4×. (SNOW's brightest key is a 6858-magnitude lamp rather than the sun, so it does
 * not bound the sun's own scale.) The same 128 is the `AmbentLightColour` alpha every shipped instance
 * carries — the half-bright marker — and it is confirmed live in EE RAM: a GARI fence reads key (311, 282,
 * 257) against 2.47 × 128 = 316.16 and ambient 77 against 0.678 × 128 = 86.8, i.e. 98% and 89% of full,
 * the shadow and AO terms.
 *
 * Both terms take the RAW record value — the one `buildLightsJson` ships — NOT the bake-exposed pair. The
 * terrain lightmap normalises separately (it saturates at its LDR ceiling); props are linear off the record.
 * `bakeExposure` is what decouples them, which is exactly why `applyRecordSun` sets it to 1/sun: a GARI-seeded
 * map authors sun 2.47 with exposure 0.405, so the terrain bake still saturates while props land on 316.
 *
 * `tools/reference-study/ref-lighting.ts` validates this scale against every shipped level. Applying the scale to the
 * bake-exposed sun runs 1.6–2.2× too bright on ambient across all five measured levels.
 */
const INSTANCE_LIGHT_SCALE = 128;

/** The ambient a SELF-LIT instance carries — exactly twice `INSTANCE_LIGHT_SCALE`, i.e. an ambient record of
 *  2.0 on the ×128 law. Measured, not chosen: every full-bright instance in GARI (112) and MERQUER (544)
 *  reads 256 on the nose, min and max alike. See `PlacedProp.fullBright`. */
export const PROP_FULL_BRIGHT_FACTOR = 2;
/** The exact per-instance RGB value retail uses for an unlit/full-bright texture. */
export const PROP_FULL_BRIGHT_RECORD = PROP_FULL_BRIGHT_FACTOR * INSTANCE_LIGHT_SCALE;
const FULL_BRIGHT = PROP_FULL_BRIGHT_RECORD;

/** Three's Lambert BRDF divides irradiance by PI. Feeding PI at the game's full-bright factor therefore
 * produces a numerical light multiplier of 1 before the PS2 gamma-space modulation shader applies it. */
export const PROP_LAMBERT_IRRADIANCE = Math.PI;

/** Map one raw instance-light factor onto Three's Lambert irradiance. The BRDF divides this by PI, so raw
 * factor 2 / instance RGB 256 becomes a light multiplier of exactly 1. A normal authored light stays linear
 * below that reference: default sun 1 + ambient .28 reaches .64 before tint, N.L and ground attenuation. */
export function propPreviewIntensity(rawFactor: number): number {
  return PROP_LAMBERT_IRRADIANCE * Math.max(0, rawFactor) / PROP_FULL_BRIGHT_FACTOR;
}

/** One PS2 output-channel multiplier from the packed INSTANCE values. The GS modulates the stored
 * half-bright texture in byte/sRGB space; 256 is texture-true and the 8-bit vertex colour saturates there.
 * Exported as a diagnostic oracle for the lighting gnomon and regression tests. */
export function propRecordScreenFactor(ambientRecord: number, keyRecord: number, nDotL: number): number {
  const light = Math.max(0, ambientRecord) + Math.max(0, nDotL) * Math.max(0, keyRecord);
  return Math.min(1, light / PROP_FULL_BRIGHT_RECORD);
}

/** One prop's authored instance lighting, in the raw SSX form the PBD instance stores. */
export interface PropInstanceLight {
  /** `AmbentLightColour` RGB — the sky fill, attenuated by how buried the prop is. */
  amb: [number, number, number];
  /** `LightColour1` RGB — the directional key, attenuated by cast shadow. */
  key: [number, number, number];
  /** `LightVector1` — unit TOWARD-light vector in the instance's MODEL-LOCAL raw frame. This is the
   *  inverse placement rotation of the world-space vector, because the engine dots it directly with the
   *  model's stored normals. It is also the negation of the propagation vector `Lights.json` stores. */
  dir: [number, number, number];
}

/**
 * The raw-space TOWARD-light vector for an authored sun — the L the engine dots against a vertex normal.
 *
 * `buildLightsJson` writes the from-light PROPAGATION vector; this is its negation, which is also exactly
 * `toRaw` of the editor-space toward-sun the lightmap bake shades with, so terrain and props agree on where
 * the sun is. Cross-checked against retail: GARI's donor `LightVector1` maps into editor space as
 * (−0.518, 0.831, 0.200), and the Unity port independently derived its prop sun as (−0.48, 0.88, 0).
 */
export function rawSunVector(sun: SunLight): [number, number, number] {
  const e = (sun.el * Math.PI) / 180, a = (sun.az * Math.PI) / 180;
  return [-Math.cos(e) * Math.cos(a), -Math.cos(e) * Math.sin(a), Math.sin(e)];
}

/** Convert the world-space raw sun into one placement's model-local raw frame — the instance's own rotation,
 * inverted, applied in raw space (`rawInstanceQuat`'s frame). For a plain yaw that is the familiar identity:
 * editor yaw maps to the opposite raw-space Z rotation on the instance, so inverting it is a positive
 * editor-yaw turn here. Retail proves the convention directly: rotating GARI's global sun by inverse
 * placement yaw reproduces its stored `LightVector1`, while writing the global vector unchanged rotates the
 * bright face. A tilted placement takes the same inverse about its full axis. */
export function localPropSunVector(sun: SunLight, rot: PropRotation = { yaw: 0 }): [number, number, number] {
  const [x, y, z] = rawSunVector(sun);
  if (!isTilted(rot)) {
    const yaw = (rot.yaw * Math.PI) / 180, c = Math.cos(yaw), s = Math.sin(yaw);
    return [c * x - s * y, s * x + c * y, z];
  }
  const [qx, qy, qz, qw] = placementQuat(rot);
  return applyQuat([x, y, z], conjugateQuat([qx, qz, -qy, qw])) as [number, number, number];
}

/**
 * Author one prop's instance lighting from the sun and the light on the ground beneath it.
 *
 * `groundLight` is the BAKED LIGHTMAP intensity under the prop (`BakedLightmaps.probeLight`), not a
 * cast-shadow query. That distinction is measured, not assumed. Against retail's own shipped instances:
 *
 *   predictor of retail's per-instance key       GARI    MESA
 *   the baked lightmap under the prop            0.615   0.352     <- this
 *   a fresh cast-shadow query at the prop        0.001   0.040
 *   ground N·L                                   0.136  -0.083
 *   N·L × cast shadow                            0.054   0.018
 *
 * and the lightmap relation is monotone across all seven bins on GARI (A_S 0.0–0.4 → key 0.44, rising to
 * A_S ≥0.97 → key 0.86), on 2994 instances. A fresh occlusion query at the prop correlates with what retail
 * shipped at essentially zero, however the query is configured:
 * terrain-only or with 2.4M triangles of prop geometry as occluders, probed at the origin or at the
 * standing point. The prop's lighting is not recomputed from the scene; it is READ from the ground.
 *
 * "A prop standing on lit snow and the snow under it are lit by the same numbers" is structural: the prop
 * reads the snow's own baked value.
 *
 * Caveat worth keeping: ELYSIUM is a counterexample (its instances sit at ~0.90 regardless of the ground,
 * 1053 of them on lightmap A_S < 0.4). This is the rule on daylight/tree levels, not a universal law.
 *
 * The attenuation still mirrors `computeModelColored` term for term — sky fill dimmed by AO, key dimmed by
 * the ground's own light — MINUS the `N·L`, which the prop's own vertex normals supply at draw time.
 * `groundLight` / `ao` are 0..1 (1 = fully lit / open).
 */
export function propInstanceLight(sun: SunLight, groundLight = 1, ao = 1,
                                  fullBright = false, rot: PropRotation = { yaw: 0 }): PropInstanceLight {
  const skyTint = hexToRgb(sun.skyTint), sunTint = hexToRgb(sun.sunTint);
  const dir = localPropSunVector(sun, rot);
  // A self-lit surface: no key at all, and a clamped-white ambient of exactly FULL_BRIGHT. Retail's own
  // convention, and a flag rather than a value — every full-bright instance across five levels carries
  // precisely this pair (see `PlacedProp.fullBright`). Deliberately BEFORE the occlusion terms: a sign face
  // emits, so neither the ground it stands on nor the sky it can see may dim it.
  if (fullBright) {
    return { amb: [FULL_BRIGHT, FULL_BRIGHT, FULL_BRIGHT], key: [0, 0, 0], dir };
  }
  // the RAW record values, not the bake-exposed pair — see INSTANCE_LIGHT_SCALE
  const skyF = sun.ambient * (1 - sun.ao * (1 - ao));
  const sunF = sun.sun * (1 - sun.shadow * (1 - groundLight));
  const chan = (tint: [number, number, number], f: number): [number, number, number] => [
    Math.max(0, tint[0] * f * INSTANCE_LIGHT_SCALE),
    Math.max(0, tint[1] * f * INSTANCE_LIGHT_SCALE),
    Math.max(0, tint[2] * f * INSTANCE_LIGHT_SCALE),
  ];
  return { amb: chan(skyTint, skyF), key: chan(sunTint, sunF), dir };
}

/** Author instance lighting for a run of props, given the terms the lightmap bake resolved at their
 *  positions (`BakedLightmaps.probeLight` / `probeAO`, index-aligned with the probes). */
export function propInstanceLights(sun: SunLight, groundLight: Float32Array, ao: Float32Array,
                                   count: number): PropInstanceLight[] {
  const out: PropInstanceLight[] = [];
  for (let i = 0; i < count; i++) out.push(propInstanceLight(sun, groundLight[i] ?? 1, ao[i] ?? 1));
  return out;
}

/** Round an authored light to the precision the instance record is worth carrying (the values are HDR
 *  floats, but three decimals is far past what an 8-bit-referred light resolves). */
export function roundPropLight(l: PropInstanceLight): PropInstanceLight {
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    amb: [r3(l.amb[0]), r3(l.amb[1]), r3(l.amb[2])],
    key: [r3(l.key[0]), r3(l.key[1]), r3(l.key[2])],
    dir: [r3(l.dir[0]), r3(l.dir[1]), r3(l.dir[2])],
  };
}

/** Editor-space TOWARD-light vector for the viewport's prop preview — the same sun, mapped through
 *  `editorFromRaw`'s linear part so the editor shades props exactly as the export lights them. */
export function editorSunVector(sun: SunLight): V3 {
  const e = (sun.el * Math.PI) / 180, a = (sun.az * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
}
