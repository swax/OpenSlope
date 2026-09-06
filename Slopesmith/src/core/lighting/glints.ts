import { hexToRgb } from '../math/color';
import type { LightRig, RigLight } from '../reference/lights';

/**
 * LIGHT GLINTS — the game's runtime sparkle on an authored glow light: the halo ring, bright core and
 * many-spiked twinkle star you see on a level's street lamps and its course flares
 * ([Trailmap: 160-lighting-data], the runtime glint section). This is the browser-side port of the Unity
 * realization ([Unity: 045-flares], `LightGlowBuilder` + the `OpenSlope/FlareHalo` shader): the same gate, the
 * same colour law, the same size classes, so a level glints identically in Slopesmith, in Unity and on console.
 *
 * The engine draws these straight from the light table every frame, gated on the light's own glow-sprite
 * resolution being a small class — `spriteRes & 0x70`, i.e. 16 / 32 / 64. A light whose resolution is 256/512
 * (or 0) never glints, which is why most shipped levels sparkle on only a handful of their lights. That gate
 * is the ONE thing that decides whether a light sparkles; it is not a name match and not a light type.
 *
 * This module is the data half — which lights glint, what colour, how big. The drawing half is
 * `app/viewport/scene/glints.ts` (a port of the FlareHalo shader), and the export half is `Lights.json`'s
 * `SpriteRes` field, which is what carries an authored glint out to Snowknife / Unity and the ISO repack.
 */

/** The engine's glint gate: a light glints only when its glow-sprite resolution is a small class. */
export const GLINT_RES_MASK = 0x70;

/** The size classes the gate admits, as offered to an author (0 = the light does not glint). */
export const GLINT_SIZE_CLASSES = [0, 16, 32, 64] as const;

/** A res-32 sparkle is ~1.5 m across on console (Unity `LightGlowSize` 75 SSX units of radius). Other
 *  classes scale by `res / 32`. */
export const GLINT_SPARKLE_M = 1.5;

/**
 * The drawing constants, all ported from the Unity importer's tuned defaults (`ImportConfig.LightGlow*`,
 * documented in [Unity: 045-flares]). They are shared by the viewport shader and kept here so the two
 * halves of the port cannot drift.
 */
export const GLINT_LAW = {
  /** The ONE brightness every glint draws at — the authored colour peak is the light's LIGHTING intensity and
   *  never reaches the sparkle, so a squad-car beacon glints as brightly as a floodlight. */
  alpha: 0.9,
  /** Spike-star strength (the streak cross), and the scale on the engine's screen-x rotation law. */
  streak: 1.2,
  twinkle: 1,
  /** Halo-ring strength. */
  ring: 0.7,
  /** The star + core add this much WHITE on top of the hue — the console's overbright additive saturation. */
  hot: 0.6,
  /** The second, larger same-hue glow: the quad spans `aura` × the sparkle, at this strength. */
  auraScale: 2.5,
  auraAlpha: 0.3,
  /** Aura edge softness (the FlareHalo `_Power`), also the fallback blob's falloff. */
  power: 1.5,
  /** Draw range in metres: alpha holds to D/2, then fades linearly to zero at D. */
  rangeM: 300,
  /** The engine's fixed-pixel core — the SPARKLE never shrinks below this many screen pixels, so a far street
   *  lamp still shows a tiny constant glint. */
  minPixels: 14,
  /** Screen-centre bloom: size × (1 + boost × centredness⁴). */
  centerBoost: 1,
  /** Metres to pull the sprite toward the camera so it sits IN FRONT of the fixture housing its own light
   *  (the res-32 value; class-scaled below). */
  nudgeM: 5,
} as const;

/** One glint, ready to draw: everything the shader needs and nothing about the light it came from. */
export interface Glint {
  name: string;
  /** The light's own position, in editor metres (the sparkle is world-anchored there). */
  pos: readonly [number, number, number];
  /** The engine's glint colour: the record's RGB EUCLIDEAN-normalized (see `glintHue`). */
  hue: readonly [number, number, number];
  /** The glow-sprite resolution class that admitted it (16 / 32 / 64). */
  sizeClass: number;
  /** Diameter of the drawn quad in metres — the sparkle × the aura, since the aura fills the quad. */
  quadM: number;
  /** Metres to pull this glint's sprite toward the camera (the engine's per-class depth pull). */
  nudgeM: number;
}

/** Does this glow-sprite resolution glint? The engine's own gate, and the only thing that decides. */
export function glints(spriteRes: number | undefined): boolean {
  return ((spriteRes ?? 0) & GLINT_RES_MASK) !== 0;
}

/** Normalize an author's choice to a value the gate admits — anything else means "no glint". */
export function glintSizeClass(spriteRes: number | undefined): number {
  const res = (spriteRes ?? 0) & GLINT_RES_MASK;
  return res === 16 || res === 32 || res === 64 ? res : 0;
}

/**
 * The engine's glint colour: the light record's RGB **Euclidean-normalized**. The authored colour PEAK is the
 * light's lighting intensity and never reaches the sparkle (every shipped light carries a glint-brightness
 * scalar of 1.0), so a saturated hue keeps a full-strength channel while a white light sits at 0.577 — dimmer,
 * per the law. Our display hues are already peak-normalized, so the peak divides out either way.
 */
export function glintHue(rgb: readonly number[]): [number, number, number] {
  const r = rgb[0] ?? 0, g = rgb[1] ?? 0, b = rgb[2] ?? 0;
  const length = Math.hypot(r, g, b);
  return length > 1e-4 ? [r / length, g / length, b / length] : [0, 0, 0];
}

/** The engine's per-class camera-ward pull: 3 / 5 / 8 m for res 16 / 32 / 64. */
function nudgeFor(sizeClass: number): number {
  return GLINT_LAW.nudgeM * (sizeClass === 16 ? 0.6 : sizeClass === 64 ? 1.6 : 1);
}

/** Turn one light into its glint, or null when the engine's gate rejects it. A subtractive (negative) light is
 *  rejected too: it would draw an invisible black additive sprite, exactly as the Unity builder skips it. */
export function lightGlint(light: RigLight): Glint | null {
  const sizeClass = glintSizeClass(light.spriteRes);
  if (!sizeClass || light.negative) return null;
  const hue = glintHue(hexToRgb(light.colorHex));
  if (hue[0] + hue[1] + hue[2] <= 0) return null;
  const sparkle = GLINT_SPARKLE_M * (sizeClass / 32);
  return {
    name: light.name,
    pos: light.pos,
    hue,
    sizeClass,
    quadM: sparkle * GLINT_LAW.auraScale,
    nudgeM: nudgeFor(sizeClass),
  };
}

/** Every glint a rig draws. The same function serves the authored rig and a loaded reference's — both arrive
 *  here as a `LightRig` in editor metres, so a course's own glints and a retail level's follow one law. */
export function rigGlints(rig: LightRig | null): Glint[] {
  if (!rig) return [];
  const out: Glint[] = [];
  for (const light of rig.lights) {
    const glint = lightGlint(light);
    if (glint) out.push(glint);
  }
  return out;
}
