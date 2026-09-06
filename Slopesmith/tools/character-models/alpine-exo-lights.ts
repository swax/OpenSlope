/**
 * Alpine Exo's two emissive masks, authored as functions of (u, v) rather than as image files.
 *
 * They are greyscale: glTF multiplies `emissiveTexture` by the material's `emissiveFactor`, so the mask
 * supplies a light's SHAPE and the palette supplies its colour. Two materials can therefore share one atlas
 * and glow different colours, and a repaint stays a hex digit — the same property the flat-colour palette
 * has, kept rather than traded away for textures.
 *
 * Both are small enough to embed uncompressed (see `embed-texture.ts`), which is what lets them be byte-for-
 * byte reproducible on any machine. A mask is a few kilobytes; the determinism is worth far more.
 *
 * v = 0 is the START of a solid's stack — a bone's head, a box face's bottom edge — so a pattern authored
 * toward increasing v runs from a limb's root toward its tip.
 */

import type { EmbeddedTexture, Tile } from './figure';

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
/** Hermite fade, so a light's edge is a falloff rather than a staircase at this resolution. */
const smoothstep = (edge0: number, edge1: number, value: number) => {
  const t = clamp01((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/* ── The light atlas ───────────────────────────────────────────────────────────────────────────────────
 * A 4 × 4 grid of 16-texel cells. Cell (0, 0) is black and is what `UNLIT` points at; every other cell is
 * one kind of light. Tiles are inset by a texel so linear filtering cannot drag a neighbouring cell's glow
 * across a border — the masks are not mipmapped precisely because that bleed cannot be prevented at the
 * lower levels, and an unlit plate picking up its neighbour's light would haze the whole figure at distance.
 */
export const ATLAS_SIZE = 64;
const CELLS = 4;
const CELL = ATLAS_SIZE / CELLS;

/** The window of the atlas a part samples, one texel inside cell (column, row). */
export function cell(column: number, row: number): Tile {
  const inset = 1 / ATLAS_SIZE;
  return [
    column / CELLS + inset, row / CELLS + inset,
    (column + 1) / CELLS - inset, (row + 1) / CELLS - inset,
  ];
}

export const LIGHT_CELL = {
  /** A visor: a hot horizontal core fading to nothing at the top and bottom of the lens. */
  visor: cell(1, 0),
  /** A round indicator, brightest at the centre. */
  dot: cell(2, 0),
  /** A lamp: a hot disc inside a dark housing ring. */
  lamp: cell(3, 0),
  /** Three readout bars of different brightness. */
  bars: cell(0, 1),
} as const;

/** Brightness of the atlas at a cell-local coordinate, both in 0..1. */
function atlasCell(column: number, row: number, u: number, v: number): number {
  if (column === 1 && row === 0) {
    // Visor: bright band across the middle, with the outboard end (u → 1) hotter so the lens reads as lit
    // from one side rather than as a uniform slab.
    const band = smoothstep(0.06, 0.34, v) * smoothstep(0.06, 0.34, 1 - v);
    return band * (0.62 + 0.38 * u);
  }
  if (column === 2 && row === 0) {
    const radius = Math.hypot(u - 0.5, v - 0.5) * 2;
    return smoothstep(1, 0.15, radius);
  }
  if (column === 3 && row === 0) {
    const radius = Math.hypot(u - 0.5, v - 0.5) * 2;
    // Hot centre, a dark gap, then a faint rim: a lamp in a housing rather than a glowing ball.
    return smoothstep(0.72, 0.30, radius) + 0.18 * smoothstep(0.74, 0.80, radius) * smoothstep(0.96, 0.88, radius);
  }
  if (column === 0 && row === 1) {
    const bar = Math.floor(v * 3);
    const within = smoothstep(0.10, 0.26, (v * 3) % 1) * smoothstep(0.10, 0.26, 1 - (v * 3) % 1);
    return within * smoothstep(0.06, 0.18, u) * smoothstep(0.06, 0.18, 1 - u) * [1, 0.45, 0.75][bar % 3];
  }
  return 0;
}

export function lightAtlas(): EmbeddedTexture {
  const pixels = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE);
  for (let y = 0; y < ATLAS_SIZE; y++) {
    for (let x = 0; x < ATLAS_SIZE; x++) {
      const column = Math.floor(x / CELL), row = Math.floor(y / CELL);
      const u = ((x % CELL) + 0.5) / CELL, v = ((y % CELL) + 0.5) / CELL;
      pixels[y * ATLAS_SIZE + x] = Math.round(255 * clamp01(atlasCell(column, row, u, v)));
    }
  }
  return { name: 'lights', width: ATLAS_SIZE, height: ATLAS_SIZE, pixels, wrap: 'clamp' };
}

/* ── The conduit strip ─────────────────────────────────────────────────────────────────────────────────
 * The animated one. It repeats along v and is scrolled at runtime (app/ride/character-glow.ts), which is
 * why its sampler wraps rather than clamps.
 *
 * One pulse per texture height, tiled two or three times over a part instead. Two pulses per texture on top
 * of that tiling made a conduit read as a ladder of separate blocks rather than as a channel: the dark gap
 * between pulses was as long as the pulse itself and there was nothing left to join them up.
 *
 * The wave is a ramp with a hard drop rather than a symmetric blob, because a symmetric pulse gives no clue
 * which way it is travelling — and travelling is the whole point.
 */
export const CONDUIT_WIDTH = 16, CONDUIT_HEIGHT = 64;
const PULSES = 1;

export function conduitStrip(): EmbeddedTexture {
  const pixels = new Uint8Array(CONDUIT_WIDTH * CONDUIT_HEIGHT);
  for (let y = 0; y < CONDUIT_HEIGHT; y++) {
    for (let x = 0; x < CONDUIT_WIDTH; x++) {
      const u = (x + 0.5) / CONDUIT_WIDTH, v = (y + 0.5) / CONDUIT_HEIGHT;
      // Dark at the strip's edges so it reads as a channel cut into the plate, not as a painted band.
      const across = smoothstep(0.0, 0.30, u) * smoothstep(0.0, 0.30, 1 - u);
      const phase = (v * PULSES) % 1;
      const pulse = phase ** 1.6;
      // The floor is the point, and it is high: the conduit stays a continuously lit channel with a bright
      // wave running along it, so a stationary rider has a glowing spine rather than a row of separate
      // lamps. Drop this toward zero and the strip breaks back up into rungs.
      pixels[y * CONDUIT_WIDTH + x] = Math.round(255 * clamp01(across * (0.34 + 0.66 * pulse)));
    }
  }
  return { name: 'conduit', width: CONDUIT_WIDTH, height: CONDUIT_HEIGHT, pixels, wrap: 'repeat' };
}

/** A conduit part's tile: the strip repeated `repeats` times along the solid's length. */
export const conduit = (repeats: number): Tile => [0, 0, 1, repeats];
