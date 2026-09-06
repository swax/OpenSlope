import type { V3 } from '../doc/types';
import { hexToRgb } from '../math/color';
import { clamp01 } from '../math/scalar';
import { editorFromRaw } from './terrain';

/**
 * Read-only reference LIGHT RIG: the explicit light sources an extracted level ships in its Lights.json —
 * the sun, sky ambient, and the hundreds of local spot / point lights the artists placed (sign lights on
 * the billboards, tunnel lights, plus the subtractive "negative" lights that pool shadow under objects).
 * This is the light-side companion to terrain.ts (terrain) and props.ts (placed objects): the server
 * (server/routes/levels.ts readLevelLightRig) trims the records off disk, this decodes them into editor space so
 * the viewport can draw each light as a gizmo on the reference terrain.
 *
 * Everything stays in the SAME raw→editor map the terrain + props use (ref-level.editorFromRaw), so the
 * lights sit exactly where the level authored them, on the props they light. sunFromLights (terrain.ts)
 * already reads the ONE directional + ambient to seed the authored sun; this reads the WHOLE rig to show it.
 */

/** SSX light Type → our kind. 0 = directional (sun), 1 = spot, 2 = point, 3 = ambient (sky fill). */
export type LightKind = 'sun' | 'ambient' | 'spot' | 'point';

/** A display grouping derived from the light's name + kind + sign, for colour-coding + the summary counts. */
export type LightCategory = 'sign' | 'sun' | 'tunnel' | 'crowd' | 'neg' | 'spot' | 'point' | 'ambient';

/** One light record trimmed to what the overlay needs, in raw SSX space (cm, Z-up, X-mirrored). */
export interface RawRigLight {
  name: string;
  /** SSX Type: 0 directional, 1 spot, 2 point, 3 ambient. */
  type: number;
  /** HDR RGB — the level's true pre-bake intensity; a subtractive "shadow" light is all-negative. */
  colour: number[];
  /** Unit propagation (from-light) vector. */
  dir: number[];
  /** Source position (cm). */
  pos: number[];
  /** Influence-box corners (cm) — used to size the gizmo's reach. */
  lo: number[];
  hi: number[];
  /** Spot cone half-angle COSINE (SSX UnknownFloat2); 1 for non-spots. */
  cone: number;
  /** Glow-sprite resolution (SSX SpriteRes) — the engine's runtime GLINT gate (`& 0x70`), see lighting/glints. */
  spriteRes?: number;
}

/** The compact JSON the server sends: the level's name + its trimmed light records. */
export interface LightRigPayload { level: string; lights: RawRigLight[]; error?: string; }

/** One decoded light in editor space, ready for the viewport to draw as a gizmo. */
export interface RigLight {
  name: string;
  kind: LightKind;
  category: LightCategory;
  /** Subtractive shadow light (all-negative colour): drawn as a faint marker, not a bright gizmo. */
  negative: boolean;
  /** Source position in editor metres. */
  pos: V3;
  /** From-light propagation direction in editor space (unit). */
  dir: V3;
  /** Display colour "#rrggbb": the light's own normalised hue (positive) or a cool slate (negative). */
  colorHex: string;
  /** Peak HDR channel magnitude (|max channel|) — the light's strength. */
  intensity: number;
  /** Spot cone half-angle cosine (1 = non-spot / no cone). */
  coneCos: number;
  /** How far the gizmo reaches, in editor metres (from the influence box, clamped by the viewport). */
  reach: number;
  /** The light's glow-sprite resolution. `& 0x70` (16/32/64) is the engine's gate for the runtime GLINT this
   *  light draws — the halo/star sparkle on a lamp or a flare (lighting/glints.ts). Absent = 0 = no glint. */
  spriteRes?: number;
}

/** A decoded rig: every light in editor space + a per-category count for the summary line. */
export interface LightRig { level: string; lights: RigLight[]; counts: Record<string, number>; }

const KIND: Record<number, LightKind> = { 0: 'sun', 1: 'spot', 2: 'point', 3: 'ambient' };

/** Map a raw-space DIRECTION through editorFromRaw's linear part (no translation) and renormalise. The
 *  uniform 1/100 scale is positive, so it doesn't flip the direction — only the axis swap/mirror matters. */
function dirEditor(d: number[]): V3 {
  const e: V3 = [-(d[0] ?? 0), d[2] ?? 0, -(d[1] ?? 0)];
  const l = Math.hypot(e[0], e[1], e[2]) || 1;
  return [e[0] / l, e[1] / l, e[2] / l];
}

/** The light's reach in metres: the distance from the source to the farthest corner of its influence box. */
export function reachM(pos: number[], lo: number[], hi: number[]): number {
  let d2 = 0;
  for (const cx of [lo[0], hi[0]]) for (const cy of [lo[1], hi[1]]) for (const cz of [lo[2], hi[2]]) {
    const dx = cx - pos[0], dy = cy - pos[1], dz = cz - pos[2];
    const s = dx * dx + dy * dy + dz * dz;
    if (s > d2) d2 = s;
  }
  return Math.sqrt(d2) / 100;
}

const hex2 = (x: number) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0');

/** Display colour: a subtractive light reads as a cool slate (it removes light); a positive light keeps its
 *  own hue, normalised by its peak channel so intensity doesn't wash the colour out. */
export function colorHex(c: number[], negative: boolean): string {
  if (negative) return '#5b7fa6';
  const peak = Math.max(c[0] || 0, c[1] || 0, c[2] || 0) || 1;
  return '#' + hex2(c[0] / peak) + hex2(c[1] / peak) + hex2(c[2] / peak);
}

/** Bucket a light for colour-coding + the summary: subtractive first (all shadow lights read alike),
 *  then by name (sign / sun / tunnel / crowd), else by kind. */
function categorize(name: string, kind: LightKind, negative: boolean): LightCategory {
  if (kind === 'sun' || kind === 'ambient') return kind;
  if (negative) return 'neg';
  const n = name.toLowerCase();
  if (n.includes('sign')) return 'sign';
  if (n.includes('sun')) return 'sun';
  if (n.includes('tunnel')) return 'tunnel';
  if (n.includes('crowd')) return 'crowd';
  return kind === 'point' ? 'point' : 'spot';
}

/**
 * Bake the light rig's per-vertex additive glow (RGB), accumulated as radiant contribution ≥ 0 — the caller
 * screen-composites it over the sun model (`base + (1−base)·(1−e^(−strength·E))`), so overlapping lights
 * saturate toward full-bright instead of blowing out, and the strength is tunable without re-baking. It's
 * independent of the sun / shadow / AO sliders (only positions, normals + the rig), so it's baked once.
 *
 * Only the POSITIVE local lights contribute (the subtractive "shadow" lights are a bake-time tuning hack the
 * artists used, already carried in the baked lightmap — reconstructing them additively just crushes the
 * terrain to black). The sun, sky ambient AND the broad `Sunlight` fill spots are skipped — those are the
 * global key/fill the study's own sun fit already carries, so adding them would double-count the sun; what's
 * left is the genuinely LOCAL character lights (sign / tunnel / point / crowd) the smooth fit can't express.
 * Each light is a spot cone (or an omni point) with a Lambert `N·L`, a smooth inverse-square falloff
 * concentrated near the source, a saturating intensity weight (so an HDR-hot light doesn't dominate).
 *
 * Note the aim matters: a light only lights what it points at. The reference sign lights aim horizontally at the
 * vertical billboard faces, so they add little to the (near-horizontal) snow — correctly; the point / tunnel
 * / downward lights are what pool on the terrain.
 */
export function bakeRigLighting(positions: Float32Array, normals: Float32Array, rig: LightRig, weightK = 3): Float32Array {
  const n = positions.length / 3;
  const out = new Float32Array(n * 3);
  for (const L of rig.lights) {
    if (L.kind === 'sun' || L.kind === 'ambient' || L.category === 'sun' || L.negative) continue;
    if (!(L.reach > 0)) continue;
    // Some influence boxes span the level (many extend to a shared ceiling), so the box diagonal over-states
    // a light's real range — cap the cull radius and the falloff radius so the glow pools near the source
    // instead of washing the whole mountain.
    const R = Math.min(L.reach, 120);
    const R2 = R * R;
    const d0 = Math.min(Math.max(R * 0.25, 5), 30); // inverse-square falloff radius (concentrates the glow)
    const d0sq = d0 * d0;
    const px = L.pos[0], py = L.pos[1], pz = L.pos[2];
    const dx = L.dir[0], dy = L.dir[1], dz = L.dir[2];
    const isSpot = L.kind === 'spot';
    const coneCos = L.coneCos;
    const w = L.intensity / (L.intensity + weightK); // saturating weight: dim lights dim, HDR-hot lights don't dominate (authored sign lights pass a smaller K so a white I=1 light still registers)
    const [tr, tg, tb] = hexToRgb(L.colorHex);
    for (let i = 0; i < n; i++) {
      const vx = positions[i * 3], vy = positions[i * 3 + 1], vz = positions[i * 3 + 2];
      const ex = px - vx, ey = py - vy, ez = pz - vz;         // surface → light
      const dsq = ex * ex + ey * ey + ez * ez;
      if (dsq > R2 || dsq < 0.25) continue;
      const d = Math.sqrt(dsq);
      const lx = ex / d, ly = ey / d, lz = ez / d;
      const ndl = normals[i * 3] * lx + normals[i * 3 + 1] * ly + normals[i * 3 + 2] * lz;
      if (ndl <= 0) continue;                                  // back-facing to the light
      let coneF = 1;
      if (isSpot) {
        const ca = -(lx * dx + ly * dy + lz * dz);             // cos(angle of light→surface vs the aim)
        if (ca < coneCos) continue;                            // outside the cone
        coneF = (ca - coneCos) / (1 - coneCos + 1e-6);
        coneF *= coneF;                                        // soften the rim
      }
      const g = w * ndl * coneF / (1 + dsq / d0sq);
      out[i * 3] += g * tr; out[i * 3 + 1] += g * tg; out[i * 3 + 2] += g * tb;
    }
  }
  return out;
}

/**
 * Received glow (RGB, ≥ 0) at a single point from the rig's LOCAL lights — the whole-object companion to
 * bakeRigLighting, with NO `N·L` term (a prop has faces every which way, so "is it lit" is what matters, not
 * one surface normal). Used to tint a placed / reference prop so a sign light visibly brightens the billboard
 * it aims at. Same exclusions + falloff as the terrain bake (local lights only; capped inverse-square cone).
 */
export function propRigGlow(pos: V3, rig: LightRig): [number, number, number] {
  let r = 0, g = 0, b = 0;
  const x = pos[0], y = pos[1], z = pos[2];
  for (const L of rig.lights) {
    if (L.kind === 'sun' || L.kind === 'ambient' || L.category === 'sun' || L.negative) continue;
    if (!(L.reach > 0)) continue;
    const R = Math.min(L.reach, 120), R2 = R * R;
    const ex = L.pos[0] - x, ey = L.pos[1] - y, ez = L.pos[2] - z; // point → light
    const dsq = ex * ex + ey * ey + ez * ez;
    if (dsq > R2 || dsq < 0.25) continue;
    const d = Math.sqrt(dsq);
    let coneF = 1;
    if (L.kind === 'spot') {
      const ca = -(ex * L.dir[0] + ey * L.dir[1] + ez * L.dir[2]) / d; // cos(light→point vs the aim)
      if (ca < L.coneCos) continue;
      coneF = (ca - L.coneCos) / (1 - L.coneCos + 1e-6);
      coneF *= coneF;
    }
    const d0 = Math.min(Math.max(R * 0.25, 5), 30);
    // gentler intensity weight than the terrain bake (I/(I+0.5) vs I/(I+3)): the sign lights are authored dim
    // (intensity ≈ 1) yet clearly meant to light their billboard, so don't starve them next to the hot lights.
    const e = (L.intensity / (L.intensity + 0.5)) * coneF / (1 + dsq / (d0 * d0));
    const [tr, tg, tb] = hexToRgb(L.colorHex);
    r += e * tr; g += e * tg; b += e * tb;
  }
  return [r, g, b];
}

/** Decode the server payload into editor-space lights the viewport can draw directly. */
export function decodeLightRig(payload: LightRigPayload): LightRig {
  const lights: RigLight[] = [];
  const counts: Record<string, number> = {};
  for (const r of payload.lights) {
    const kind = KIND[r.type] ?? 'point';
    const c = r.colour ?? [0, 0, 0];
    const peak = Math.max(c[0] || 0, c[1] || 0, c[2] || 0);
    const negative = peak <= 0; // an all-non-positive colour is a subtractive shadow light
    const category = categorize(r.name, kind, negative);
    counts[category] = (counts[category] || 0) + 1;
    lights.push({
      name: r.name,
      kind,
      category,
      negative,
      pos: editorFromRaw(r.pos),
      dir: dirEditor(r.dir),
      colorHex: colorHex(c, negative),
      intensity: Math.abs(peak),
      coneCos: r.cone ?? 1,
      reach: reachM(r.pos, r.lo ?? r.pos, r.hi ?? r.pos),
      spriteRes: r.spriteRes ?? 0,
    });
  }
  return { level: payload.level, lights, counts };
}
