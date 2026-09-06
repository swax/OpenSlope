/**
 * The tile-orientation "F" overlay (top-bar F toggle): a chiral pink F drawn on every tile display — the
 * 3D terrain patches (viewport), the Texture Library swatches, the Palette cells and the big preview — at
 * 1/3 of the tile, centred, riding the tile's ART (rotates with a rotated tile, mirrors with a mirrored
 * one). One glyph language everywhere, so orientations are matched by eye: same F direction = same
 * orientation on the ground, in the pad, and in the Library.
 */

/** The overlay pink (matches the viewport's UV_GLYPH_COLOR). */
export const F_COLOR = '#ff7ee6';

/** The F's strokes in art coords (x right, y UP, unit square): stem, top arm, middle arm. */
export const F_STROKES: [number, number, number, number][] = [
  [0.35, 0.2, 0.35, 0.8],
  [0.35, 0.8, 0.68, 0.8],
  [0.35, 0.52, 0.58, 0.52],
];

/** Inline-SVG data URI of the F for DOM overlays (Library swatches / Palette cells): place it in a centred
 *  1/3-inset box INSIDE the tile's transformed element so it inherits the tile's rotation / mirror. */
export const F_SVG_URL = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'><path d='${
    F_STROKES.map(([x0, y0, x1, y1]) => `M${x0} ${1 - y0}L${x1} ${1 - y1}`).join('')
  }' stroke='${F_COLOR}' stroke-width='.12' stroke-linecap='round' fill='none'/></svg>`)}")`;

/** CSS for a DOM F overlay child (append inside the tile's oriented element). */
export const F_OVERLAY_CSS =
  `position:absolute;inset:33.33%;pointer-events:none;background:${F_SVG_URL} center/contain no-repeat;`;

/** Draw the F on a canvas at the CURRENT transform's origin (the tile centre), `size` = tile edge in px.
 *  Call inside the tile's rotate/mirror transform so the F rides the art; art y-up flips to canvas y-down. */
export function drawFGlyph(ctx: CanvasRenderingContext2D, size: number) {
  const s = size / 3;
  ctx.save();
  ctx.strokeStyle = F_COLOR;
  ctx.lineWidth = Math.max(1.5, s * 0.07);
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const [x0, y0, x1, y1] of F_STROKES) {
    ctx.moveTo((x0 - 0.5) * s, -(y0 - 0.5) * s);
    ctx.lineTo((x1 - 0.5) * s, -(y1 - 0.5) * s);
  }
  ctx.stroke();
  ctx.restore();
}
