/**
 * Servo Scout's two emissive masks, authored as functions of (u, v) rather than as image files.
 *
 * They are greyscale for the same reason Alpine Exo's are: glTF multiplies `emissiveTexture` by the
 * material's `emissiveFactor`, so the mask supplies a light's SHAPE and the palette supplies its colour. One
 * atlas therefore serves an eye, an indicator, a lamp and a readout at four different colours, and a repaint
 * stays a hex digit.
 *
 * These are deliberately this figure's OWN masks rather than a shared import from `alpine-exo-lights.ts`.
 * The two characters want different light shapes — a camera iris with a dark pupil is not a visor band, and a
 * data feed is not a power conduit — and a shared atlas would make every future edit to one figure a question
 * about the other's pinned bytes. The dozen lines of (u, v) helpers below are the whole cost of that.
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

/* ── The optics atlas ──────────────────────────────────────────────────────────────────────────────────
 * A 4 × 4 grid of 16-texel cells. Cell (0, 0) is black and is what `UNLIT` points at; every other cell is
 * one kind of light. Tiles are inset by a texel so linear filtering cannot drag a neighbouring cell's glow
 * across a border — these masks are not mipmapped precisely because that bleed cannot be prevented at the
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
  /** A camera iris: a lit disc with a DARK pupil at its centre. The pupil is the whole point — a uniformly
   *  bright lens reads as a painted dot, and two of those are not a face. */
  iris: cell(1, 0),
  /** A round indicator, brightest at the centre. */
  dot: cell(2, 0),
  /** A lamp: a hot disc inside a dark housing ring. */
  beam: cell(3, 0),
  /** Three readout bars of different brightness. */
  bars: cell(0, 1),
  /** A horizontal lit slot with dark ends — a marker rather than a lamp. */
  slot: cell(1, 1),
} as const;

/** Brightness of the atlas at a cell-local coordinate, both in 0..1. */
function atlasCell(column: number, row: number, u: number, v: number): number {
  const radius = Math.hypot(u - 0.5, v - 0.5) * 2;
  if (column === 1 && row === 0) {
    // Iris: a bright annulus inside a lens that falls off at its rim, with the pupil held down rather than
    // black — a pupil at zero on a 16-texel cell is four dead texels and reads as a hole, not as an eye.
    const lens = smoothstep(0.88, 0.66, radius);
    const pupil = smoothstep(0.16, 0.38, radius);
    return lens * (0.24 + 0.76 * pupil);
  }
  if (column === 2 && row === 0) return smoothstep(1, 0.15, radius);
  if (column === 3 && row === 0) {
    // Hot centre, a dark gap, then a faint rim: a lamp in a housing rather than a glowing ball.
    return smoothstep(0.72, 0.30, radius) + 0.18 * smoothstep(0.74, 0.80, radius) * smoothstep(0.96, 0.88, radius);
  }
  if (column === 0 && row === 1) {
    const bar = Math.floor(v * 3);
    const within = smoothstep(0.10, 0.26, (v * 3) % 1) * smoothstep(0.10, 0.26, 1 - (v * 3) % 1);
    return within * smoothstep(0.06, 0.18, u) * smoothstep(0.06, 0.18, 1 - u) * [1, 0.45, 0.75][bar % 3];
  }
  if (column === 1 && row === 1) {
    const band = smoothstep(0.20, 0.42, v) * smoothstep(0.20, 0.42, 1 - v);
    return band * smoothstep(0.04, 0.20, u) * smoothstep(0.04, 0.20, 1 - u);
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
  return { name: 'optics', width: ATLAS_SIZE, height: ATLAS_SIZE, pixels, wrap: 'clamp' };
}

/* ── The data feed ─────────────────────────────────────────────────────────────────────────────────────
 * The animated one. It repeats along v and is scrolled at runtime (app/ride/character-glow.ts), which is
 * why its sampler wraps rather than clamps.
 *
 * Alpine Exo's conduit is a power channel: one long ramp with a hard drop, reading as a slow surge. This one
 * is a DATA line and is drawn as a short dash on a lit floor, which is a different thing to look at on the
 * same mechanism. One dash per texture height, tiled two or three times over a part instead — two dashes per
 * texture on top of that tiling leaves a dark gap as long as the dash and the line breaks up into rungs.
 *
 * The floor is high on purpose. It keeps the strip a continuously lit channel with a bright packet running
 * along it, so a stationary rider has a glowing spine rather than a row of separate lamps.
 */
export const FEED_WIDTH = 16, FEED_HEIGHT = 64;

export function feedStrip(): EmbeddedTexture {
  const pixels = new Uint8Array(FEED_WIDTH * FEED_HEIGHT);
  for (let y = 0; y < FEED_HEIGHT; y++) {
    for (let x = 0; x < FEED_WIDTH; x++) {
      const u = (x + 0.5) / FEED_WIDTH, v = (y + 0.5) / FEED_HEIGHT;
      // Dark at the strip's edges so it reads as a channel cut into the plate, not as a painted band.
      const across = smoothstep(0.0, 0.30, u) * smoothstep(0.0, 0.30, 1 - u);
      // Asymmetric on purpose: a symmetric packet gives no clue which way it is travelling, and travelling
      // is the whole point. The leading edge is sharp and the trail fades out behind it.
      const dash = smoothstep(0.52, 0.74, v) * smoothstep(1.00, 0.82, v);
      pixels[y * FEED_WIDTH + x] = Math.round(255 * clamp01(across * (0.32 + 0.68 * dash)));
    }
  }
  return { name: 'feed', width: FEED_WIDTH, height: FEED_HEIGHT, pixels, wrap: 'repeat' };
}

/** A feed part's tile: the strip repeated `repeats` times along the solid's length. */
export const feed = (repeats: number): Tile => [0, 0, 1, repeats];
