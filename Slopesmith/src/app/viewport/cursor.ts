import type { Mode } from './types';
import {
  BULB_ICON_BODY, GEM_ICON_BODY, PAINT_ICON_BODY, PROP_BOX_ICON_BODY, RAIL_ICON_BODY,
} from '../ui/components/icons';

// Exact Paint-mode glyph. The bristle tip is the hotspot, so the brush sits above the terrain point that
// receives the texture. A crosshair remains as the browser fallback.
const PAINT_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
  <g fill="#172a3a" stroke="#0b1117" stroke-width="4">${PAINT_ICON_BODY}</g>
  <g fill="none" stroke="#ffd21a" stroke-width="2">${PAINT_ICON_BODY}</g>
</svg>`;

export const PAINT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(PAINT_CURSOR_SVG)}") 13 28, crosshair`;

// Exact Props box glyph with the app's standard add badge. The box's bottom point is the hotspot, so it sits
// just above the terrain point where the translucent model ghost will be committed.
const PROP_PLACEMENT_CURSOR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
  <g transform="scale(0.78)" fill="#172a3a" stroke="#0b1117" stroke-width="4">${PROP_BOX_ICON_BODY}</g>
  <g transform="scale(0.78)" fill="none" stroke="#eaf6ff" stroke-width="2">${PROP_BOX_ICON_BODY}</g>
  <path d="M18 15v6M15 18h6" fill="none" stroke="#0b1117" stroke-width="4"/>
  <path d="M18 15v6M15 18h6" fill="none" stroke="#ffd21a" stroke-width="2"/>
</svg>`;

export const PROP_PLACEMENT_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(PROP_PLACEMENT_CURSOR_SVG)}") 12 21, copy`;

/**
 * The other three placement tools wear the SAME cursor the prop does, differing only in the glyph — the exact
 * body their Add button carries, so the thing you clicked is the thing now riding the pointer. Built from one
 * factory rather than four hand-written SVGs: the dark halo under a bright stroke is what keeps a 24px glyph
 * legible over snow, over a dark rock face, and over the sky, and that has to hold for all of them.
 *
 * The badge marks these as ADD tools, exactly as it does on the buttons. A rail is the one that keeps wearing
 * it through a whole chain of clicks, because every click adds another point rather than finishing.
 */
const placementCursor = (body: string, scale = 0.78) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
  <g transform="scale(${scale})" fill="#172a3a" stroke="#0b1117" stroke-width="4">${body}</g>
  <g transform="scale(${scale})" fill="none" stroke="#eaf6ff" stroke-width="2">${body}</g>
  <path d="M18 15v6M15 18h6" fill="none" stroke="#0b1117" stroke-width="4"/>
  <path d="M18 15v6M15 18h6" fill="none" stroke="#ffd21a" stroke-width="2"/>
</svg>`;
  // Hotspot on the glyph's own bottom-left, the way the box's lower point sits just above where it commits.
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") 6 21, copy`;
};

export const RAIL_PLACEMENT_CURSOR = placementCursor(RAIL_ICON_BODY);
export const GEM_PLACEMENT_CURSOR = placementCursor(GEM_ICON_BODY);
export const LIGHT_PLACEMENT_CURSOR = placementCursor(BULB_ICON_BODY);

/** Which tool, if any, is currently held over the viewport. At most one is ever armed at a time — arming any
 *  of them disarms the others — so this is a choice rather than a set of flags to resolve. */
export type ArmedPlacement = 'prop' | 'rail' | 'gem' | 'light' | null;

const PLACEMENT_CURSOR: Record<Exclude<ArmedPlacement, null>, string> = {
  prop: PROP_PLACEMENT_CURSOR,
  rail: RAIL_PLACEMENT_CURSOR,
  gem: GEM_PLACEMENT_CURSOR,
  light: LIGHT_PLACEMENT_CURSOR,
};

/** Cursor for the viewport's mutually exclusive Paint and Props-mode placement interactions. */
export function viewportCursor(mode: Mode, paintArmed: boolean, armed: ArmedPlacement = null): string {
  if (mode === 'paint') return paintArmed ? PAINT_CURSOR : '';
  if (mode === 'props' && armed) return PLACEMENT_CURSOR[armed];
  // Effects mode draws motion paths with the same click-a-chain-of-points gesture the rail tool uses, so it
  // borrows the rail cursor rather than leaving the one mode that also lays a spline with a bare arrow.
  if (mode === 'effects' && armed === 'rail') return RAIL_PLACEMENT_CURSOR;
  return '';
}
