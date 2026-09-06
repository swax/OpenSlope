import { buildReferenceMesh, type RawPatch } from '../reference/terrain';
import { computeModelColored } from './lightmap';
import { bakeSunShadow, bakeAO } from './occlusion';
import { groundLightSampler } from './ground-light';
import { bakeRigLighting, type LightRig } from '../reference/lights';
import { SIGN_TERRAIN_WEIGHT_K } from './sign-lights';
import type { SunLight, V3 } from '../doc/types';
import type { Rgba } from '../paint/ground-textures';

/**
 * Bake the authored sun into per-patch lightmap tiles, in the exact original form the bake consumes
 * (210/220): 128x128 pages, alpha = A_S light intensity, RGB = C_S GS colour residual. The Unity terrain
 * shader's _LIGHTMAP_GS path reconstructs lit = (0.5*C_D - C_S)*(A_S*255/128) per channel. With a patch's
 * diffuse base C_D folded in, C_S = C_D·(0.5 - Lc/(A_S*255/128)) (bxtools' `diffC·(1 - lightC/A_S)` form on
 * the half-bright base), and A_S = the peak light channel so C_S never clamps; the shader then reproduces
 * C_D·Lc — texture × light, the in-game look over any base texture, dark rock as well as white snow. With
 * no diffuse the bake uses the white base C_S = 0.5 - Lc/(A_S*255/128). The terrain bake folds these into
 * the welded atlas, so an authored mountain shades in Unity (sun colour where lit, sky colour in shadow)
 * the same way the editor previews; alpha doubles as the grey luminance fallback.
 *
 * Each patch owns an 8x8 sub-rect (EA's lightmap-tile size, matched by original) sampled at an 8-point
 * tessellation, so the engine - which reads a full 8x8 region per patch at its highest LOD - finds the tile
 * fully populated. Lightmap UVs use mode 6 (transpose, matching TerrainBundle.RemapUv), so texel (x, y)
 * within a tile carries the vertex at (u, v) = (y/7, x/7).
 */

const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
const hex2rgb = (h: string): [number, number, number] => {
  const n = parseInt(h.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

// The terrain lightmap tile is 8x8 texels per patch (EA's GDC format, matched by original): the PS2 engine
// samples a full 8x8 region per patch at the highest tessellation LOD, so the tile must fill all 64 texels.
// This is INDEPENDENT of the render tessellation (TerrainBundle RES=4) - the lightmap is always baked at 8x8
// and the render samples it bilinearly. 256 tiles/page (16x16) => a level's patches pack into as many pages
// as needed, exactly like the original's packed lightmap SSH.
const RES = 7;              // lightmap tessellation: 8 samples per patch edge
const SIDE = RES + 1;       // 8 samples / texels per patch axis
const TILE = SIDE;          // 8x8 lightmap texel tile per patch
const MAP = 128;            // lightmap page size (the bake loads 128x128 pages only)
const PER_ROW = Math.floor(MAP / TILE);   // 16 tiles across a page
const PER_MAP = PER_ROW * PER_ROW;        // 256 patches per page

/** Where one patch's lightmap tile lives: which page (LightmapID) + its sub-rect (LightMapPoint). */
export interface PatchLm { id: number; rect: [number, number, number, number]; }
export interface BakedLightmaps {
  /** Page images keyed by filename ("0000.png" .. "000F.png") for Lightmaps/. */
  maps: Record<string, Rgba>;
  /** Per-patch tile placement, index-aligned with the input patches. */
  patchLm: PatchLm[];
  /** Cast-shadow term (0 shadowed .. 1 lit) at each `probes` point, index-aligned. 1 when the sun's shadow
   *  weight is 0 (nothing to resolve), so a caller can always read it. */
  probeShadow: Float32Array;
  /** Sky openness (0 buried .. 1 open) at each `probes` point, index-aligned; 1 when AO is off. */
  probeAO: Float32Array;
  /** The BAKED LIGHTMAP intensity (A_S, 0 dark .. 1 full) of the ground under each `probes` point,
   *  index-aligned. This — not `probeShadow` — is what retail's per-instance prop key tracks; see
   *  `propInstanceLight`. 1 where no terrain sits under the probe. */
  probeLight: Float32Array;
}

/** LDR-neutral ceiling for the baked sun/ambient terms: above ~1 a single texel's peak channel pins A_S at
 *  the rail (255) and the C_S residual collapses, white-ing out the lightmap. The bake clamps to this. */
const BAKE_CEIL = 1;

/**
 * The DIRECTIONAL sun intensity the lightmap bake actually uses: the authored/record sun scaled by
 * bakeExposure, then CLAMPED to the LDR-neutral ceiling so an un-exposed HDR sun (e.g. a stale 2.47 with
 * bakeExposure still 1) can never saturate A_S — it fails safe to a plain LDR bake. The preview lights by
 * the same value (WYSIWYG). level.ts buildLightsJson is independent and keeps the raw HDR sun.sun.
 */
export function effectiveBakeSun(sun: SunLight): number {
  return Math.min(sun.sun * (sun.bakeExposure ?? 1), BAKE_CEIL);
}

/** The constant ambient floor the bake uses: the bake-ambient override (the level's lightmap-effective
 *  ambient) when present, else the authored `ambient`; clamped to the ceiling. Export keeps raw `ambient`. */
export function effectiveBakeAmbient(sun: SunLight): number {
  return Math.min(sun.bakeAmbient ?? sun.ambient, BAKE_CEIL);
}

// ---- lightmap texel encode / GS display decode (shared so a baked-lightmap preview is on one scale) ----

/** The diffuse base C_D (gamma-space RGB 0..1) the engine multiplies the light by at a patch's tile UV.
 *  Folded into the encode so the lightmap reproduces texture × light exactly; default (absent) = white. */
export type DiffuseSampler = (patchIndex: number, tileU: number, tileV: number) => [number, number, number];

/**
 * Encode one baked light Lc (RGB 0..1) over a diffuse base C_D into a lightmap texel [r, g, b, a]:
 * alpha = A_S (the peak light channel), RGB = the C_S = C_D·(0.5 - Lc/(A_S*255/128)) GS residual. This is
 * bxtools' exact `diffC·(1 - lightC/A_S)` form adapted to the Unity decode's half-bright base (the 0.5):
 * the shader's lit = (0.5·C_D - C_S)·(A_S*255/128) then reconstructs C_D·Lc — texture × light. With the
 * default white base (C_D = 1) it collapses to the texture-free C_S = 0.5 - Lc/(A_S*255/128).
 */
export function encodeLightmapTexel(
  lr: number, lg: number, lb: number,
  dr = 1, dg = 1, db = 1,
): [number, number, number, number] {
  const a8 = clamp8(Math.max(lr, lg, lb) * 255);
  if (a8 <= 0) return [0, 0, 0, 0];
  const k = a8 / 128; // = A_S * 255/128
  return [clamp8(dr * (0.5 - lr / k) * 255), clamp8(dg * (0.5 - lg / k) * 255), clamp8(db * (0.5 - lb / k) * 255), a8];
}

/** Decode one lightmap texel back to the DISPLAYED lit colour lit = (0.5·C_D - C_S)·(A_S*255/128) per
 *  channel, clamped — the exact Unity `_LIGHTMAP_GS` reconstruction (the 255/128 ≈ ×2 factor). With the
 *  default white base (C_D = 1) this is the texture-free (0.5 - C_S)·k the reference's baked-lightmap view
 *  uses, so a white-base round-trip stays on the reference's scale; pass C_D to get the in-game texture × light. */
export function decodeLightmapTexel(
  r8: number, g8: number, b8: number, a8: number,
  dr = 1, dg = 1, db = 1,
): [number, number, number] {
  const k = a8 / 128; // = A_S * 255/128
  return [
    Math.min(1, Math.max(0, (0.5 * dr - r8 / 255) * k)),
    Math.min(1, Math.max(0, (0.5 * dg - g8 / 255) * k)),
    Math.min(1, Math.max(0, (0.5 * db - b8 / 255) * k)),
  ];
}

/**
 * Show a per-vertex baked light buffer (the computeModelColored output the export bakes) AS its own baked
 * lightmap: round-trip each vertex through the PNG encode + GS display decode. With `diffuse` (the per-vertex
 * diffuse C_D, interleaved RGB aligned with `colored`), the round-trip folds the texture in exactly as the
 * engine does, so the result is the in-game texture × light with the lightmap's 8-bit quantization and rail
 * clamping visible — what the bake actually produces. Without `diffuse` it is a white-base round-trip
 * (≈ identity, on the reference's scale) — a bake-to-bake brightness comparison.
 */
export function bakedLightmapDisplay(colored: Float32Array, diffuse?: Float32Array): Float32Array {
  const out = new Float32Array(colored.length);
  for (let i = 0; i < colored.length; i += 3) {
    const dr = diffuse ? diffuse[i] : 1, dg = diffuse ? diffuse[i + 1] : 1, db = diffuse ? diffuse[i + 2] : 1;
    const [r8, g8, b8, a8] = encodeLightmapTexel(colored[i], colored[i + 1], colored[i + 2], dr, dg, db);
    const [r, g, b] = decodeLightmapTexel(r8, g8, b8, a8, dr, dg, db);
    out[i] = r; out[i + 1] = g; out[i + 2] = b;
  }
  return out;
}

/**
 * Screen-composite an authored rig's per-vertex glow (E ≥ 0) over the sun-lit colour, in place:
 * `lit = base + (1 − base)·(1 − e^(−E))` per channel, so overlapping sign lights saturate toward full instead
 * of blowing out — the same blend the reference model view (`withRig`) and the terrain preview use, so the
 * baked lightmap matches what the editor shows.
 */
export function compositeRigGlow(colored: Float32Array, glow: Float32Array): void {
  for (let i = 0; i < colored.length; i++) colored[i] = colored[i] + (1 - colored[i]) * (1 - Math.exp(-glow[i]));
}

/** Bake the authored sun (+ cast shadow / AO) for one quilt into lightmap pages + per-patch placement.
 *  Pass `diffuse` to fold each patch's diffuse base C_D into the GS residual (the exact texture × light
 *  encode bxtools writes); omit it for the white-base encode (texture-free, the prior behaviour). Pass `rig`
 *  (the authored sign lights) to fold their glow into the terrain so a billboard's snow pool ships baked.
 *
 *  `probes` are extra editor-space points to resolve the SAME cast-shadow / AO terms at — the placed props,
 *  which need them for their per-instance lighting (docs/032 · lighting). They ride this bake rather than
 *  running their own because the occlusion pass is the expensive part (AO rasterises the terrain once per
 *  sky direction); appending them to the query set costs a few extra lookups instead of a second full bake.
 *  They are appended AFTER the terrain vertices and contribute no triangles, so the terrain's own indices,
 *  normals and per-vertex results are untouched. */
export function bakeLightmaps(patches: RawPatch[], sun: SunLight, diffuse?: DiffuseSampler, rig?: LightRig,
                              probes?: readonly V3[]): BakedLightmaps {
  const mesh = buildReferenceMesh(patches, undefined, RES); // editor-space positions + analytic normals + tile UVs at the 8x8 lightmap tessellation
  const e = (sun.el * Math.PI) / 180, a = (sun.az * Math.PI) / 180;
  const dir: [number, number, number] = [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
  // Probes ride the terrain's own occlusion pass as extra QUERY points. They are kept out of the depth map's
  // PROJECTION (`bakeSunShadow`/`bakeAO` still size it from `mesh.positions` alone) because the map's bounds
  // and cell size derive from the geometry projected into it — letting a far-flung prop widen that would
  // coarsen the map the terrain itself is shaded with. Querying is just a lookup, so this costs a handful of
  // reads rather than a second rasterisation. Probe normals point at the sky: the openness an upright prop sees.
  const vertCount = mesh.positions.length / 3;
  const probeCount = probes?.length ?? 0;
  let qPos = mesh.positions, qNrm = mesh.normals;
  if (probeCount) {
    qPos = new Float32Array((vertCount + probeCount) * 3);
    qNrm = new Float32Array((vertCount + probeCount) * 3);
    qPos.set(mesh.positions); qNrm.set(mesh.normals);
    probes!.forEach((p, i) => {
      const j = (vertCount + i) * 3;
      qPos[j] = p[0]; qPos[j + 1] = p[1]; qPos[j + 2] = p[2];
      qNrm[j + 1] = 1;
    });
  }
  const shadow = sun.shadow > 0 ? bakeSunShadow(mesh.positions, mesh.indices, dir, 1536, qPos) : undefined;
  const ao = sun.ao > 0 ? bakeAO(mesh.positions, mesh.indices, mesh.normals, 16, 1024,
    probeCount ? { positions: qPos, normals: qNrm } : undefined) : undefined;
  // the probes' tail of that shared pass; absent terms read as fully lit / fully open, which is what
  // "the author turned that darkening off" means everywhere else in this model
  const probeSlice = (src: Float32Array | undefined) => {
    const out = new Float32Array(probeCount);
    out.fill(1);
    if (src) for (let i = 0; i < probeCount; i++) out[i] = src[vertCount + i];
    return out;
  };
  const probeShadow = probeSlice(shadow), probeAO = probeSlice(ao);
  // bakeExposure / bakeAmbient scale the DIRECTIONAL sun + ambient floor for the lightmap only (level.ts
  // buildLightsJson keeps the raw record values): a record-seeded HDR sun (~2.47) is the true dynamic-object
  // light, but the terrain bake must reproduce the reference's own, lower lightmap exposure (~0.7) and
  // ambient (~0.3). Both are CLAMPED to a safe LDR ceiling, so a missing/stale exposure degrades to a plain
  // LDR bake + a visible warning rather than a silent white-out.
  const reqSun = sun.sun * (sun.bakeExposure ?? 1);
  const effSun = effectiveBakeSun(sun);
  // The bake intentionally drives the directional sun to the LDR ceiling so a fully-lit slope saturates to
  // white (A_S 255 = full-bright texture) — so reqSun ≈ ceiling is expected, not an error. Only warn when it
  // OVERSHOOTS the ceiling by a real margin (a stale/un-exposed HDR sun, e.g. a raw 2.47 with bakeExposure 1),
  // which means the bake-exposure wasn't applied and the bake would be a flat white-out.
  if (reqSun > BAKE_CEIL + 0.1) {
    console.warn(`light-bake: HDR sun ${sun.sun.toFixed(2)} x bakeExposure ${(sun.bakeExposure ?? 1).toFixed(2)} = ${reqSun.toFixed(2)} exceeds the LDR ceiling ${BAKE_CEIL} — clamping (the bake-exposure wasn't applied; re-run 'use for my map').`);
  }
  const reqAmbient = sun.bakeAmbient ?? sun.ambient;
  if (reqAmbient > BAKE_CEIL) console.warn(`light-bake: bake ambient ${reqAmbient.toFixed(2)} exceeds ${BAKE_CEIL} — clamping to avoid washing out shadows.`);
  const colored = computeModelColored(
    mesh.normals, dir,
    { ambient: effectiveBakeAmbient(sun), sun: effSun, shadow: sun.shadow, ao: sun.ao, sunTint: hex2rgb(sun.sunTint), skyTint: hex2rgb(sun.skyTint) },
    shadow, ao,
  ); // per-vertex RGB = the sun/sky-tinted colour Unity should reproduce (=> encoded into C_S)
  // fold the authored sign lights' glow into the terrain, so a billboard's snow pool bakes into the lightmap
  if (rig && rig.lights.length) compositeRigGlow(colored, bakeRigLighting(mesh.positions, mesh.normals, rig, SIGN_TERRAIN_WEIGHT_K));

  // Sampled AFTER the rig glow so a prop standing in a billboard's pool reads the light that actually ships
  // in the lightmap, not the pre-composite value. The sampler is shared with the editor preview so the two
  // cannot drift (`groundLightSampler`).
  const probeLight = new Float32Array(probeCount);
  probeLight.fill(1);
  if (probeCount && probes) {
    const sampleGround = groundLightSampler(mesh.positions, colored);
    probes.forEach((p, i) => { probeLight[i] = sampleGround(p); });
  }

  const n = patches.length;
  const pages = Math.max(1, Math.ceil(n / PER_MAP));
  const maps: Record<string, Rgba> = {};
  const buffers: Uint8Array[] = [];
  for (let m = 0; m < pages; m++) {
    const data = new Uint8Array(MAP * MAP * 4);
    for (let i = 0; i < MAP * MAP; i++) data[i * 4 + 3] = 255; // neutral fill: RGB 0 (C_S), alpha full (A_S=1)
    buffers.push(data);
    maps[`${m.toString().padStart(4, '0')}.png`] = { w: MAP, h: MAP, data };
  }

  const patchLm: PatchLm[] = [];
  for (let pi = 0; pi < n; pi++) {
    const id = Math.floor(pi / PER_MAP), slot = pi % PER_MAP;
    const bx = (slot % PER_ROW) * TILE, by = Math.floor(slot / PER_ROW) * TILE;
    const data = buffers[id];
    const vBase = pi * SIDE * SIDE;
    for (let iu = 0; iu < SIDE; iu++) {
      for (let iv = 0; iv < SIDE; iv++) {
        const vi = vBase + iu * SIDE + iv, ci = vi * 3;
        // A_S = the peak channel, so every channel's C_S = C_D·(0.5 - Lc/(A_S*255/128)) stays in range and
        // the shader's (0.5*C_D - C_S)*(A_S*255/128) reproduces C_D·Lc (texture × light). The diffuse C_D is
        // sampled at this texel's tile UV; absent => white (C_S = 0.5 - Lc/k). Alpha doubles as the grey
        // luminance fallback (the lightness).
        const cd = diffuse ? diffuse(pi, mesh.uvs[vi * 2], mesh.uvs[vi * 2 + 1]) : undefined;
        const [r, g, b, a8] = cd
          ? encodeLightmapTexel(colored[ci], colored[ci + 1], colored[ci + 2], cd[0], cd[1], cd[2])
          : encodeLightmapTexel(colored[ci], colored[ci + 1], colored[ci + 2]);
        const o = ((by + iu) * MAP + (bx + iv)) * 4; // mode-6 transpose: texel (x=v, y=u) holds vertex (u,v)
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = a8;
      }
    }
    patchLm.push({ id, rect: [bx / MAP, by / MAP, TILE / MAP, TILE / MAP] });
  }
  return { maps, patchLm, probeShadow, probeAO, probeLight };
}
