/** Versions compiled into each install. Mismatched clients follow read-only (docs/039). */
export const DOCUMENT_VERSION = 3;
/** '3': object-field assignments and topology deltas; older clients receive whole objects and documents.
 *  '4': owned trails (`o/trail/*`, docs/023) with their per-knot sections, and Bézier path handles (docs/014). An
 *  older core refuses a trail's
 *  register — so a server left running from before them would quietly forget every trail — and draws a path
 *  without its handles, which is a different curve: a mixed room follows read-only rather than diverge.
 *  '5': a trail is a network of points and paths (docs/023 · Networks); an older core reads its register as a trail
 *  of knots and branches it no longer has.
 *  '6': a trail path some lanes wide, its capped ends, and trail tile SETS (`trailTileSets`, docs/023 · Lanes, Caps,
 *  Textures); an older core finds a trail of other than two lanes broken, cuts a capped one without its caps, and
 *  dresses no path in the mountain's own sets.
 *  '7': a trail tile set is a whole 4×3 — its cap, trail and turn rows — and a path wears one (docs/023 · Textures); a
 *  '6' core reads a set as one row of one kind and looks for a path's turn and cap sets apart.
 *  '8': a set's tile can be turned of its own (`TrailTileRow.turns`), and a cap or turn row's middle set plain; a '7'
 *  core lays such a tile at its row's turn and its plain middle as the trail row's.
 *  '9': the built-in trail tile sets are the ones laid in the set builder, a new path wears `GARI/Trail 3`, and the
 *  sets they replaced are worn as their successors; an '8' core finds none of the new ones by name.
 *  '10': the built-in sets are each map's `Preset N`, the names before them worn as them, and a mountain's own set laid
 *  exactly as one gives way to it on load; a '9' core finds none of them by name. */
export const CORE_VERSION = '10';
