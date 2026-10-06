/** Versions compiled into each install. Mismatched clients follow read-only (docs/039). */
export const DOCUMENT_VERSION = 3;
/** '3': object-field assignments and topology deltas; older clients receive whole objects and documents.
 *  '4': owned trails (`o/trail/*`, docs/023) with their per-knot sections, and Bézier path handles (docs/014). An
 *  older core refuses a trail's
 *  register — so a server left running from before them would quietly forget every trail — and draws a path
 *  without its handles, which is a different curve: a mixed room follows read-only rather than diverge.
 *  '5': a trail is a network of points and paths (docs/023 · Networks); an older core reads its register as a trail
 *  of knots and branches it no longer has. */
export const CORE_VERSION = '5';
