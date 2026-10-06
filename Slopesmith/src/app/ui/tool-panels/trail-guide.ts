import { steps } from '../components/gui';
import type { ToolsContext } from './widgets';

/**
 * The recipe for the part no single tool owns: a trail is its own ribbon lying ON the mountain, and making it part
 * of the mountain is a sequence across three others (overlap select, Weld Loops, retopology). The order is the
 * content, so it reads as a numbered list rather than prose. The trail's patches are locked from the moment it
 * cuts them (docs/023), which is what carries the measured trail surface through the seam and the rebuild intact.
 *
 * Shown at the bottom of both panels the sequence runs between: the trail's own, where it is the answer to "the
 * trail is floating on the terrain, now what", and Retopology, which is its last step. One list, two call sites,
 * so the two panels cannot drift into describing the same workflow differently. Collapsed by default in both:
 * it is wanted once per trail, not on every pass through the panel.
 */
export function buildTrailIntegrationGuide(editSection: ToolsContext['editSection']) {
  const guide = editSection('trail-integration', 'Guide · Integrate Trail With Terrain', false);
  steps(guide, [
    ['create the trail', 'lay the centre spline over the terrain and press Enter. The new patches rest '
      + 'on top of the mountain, sharing no vertices with it, already locked, and the trail stays selected.'],
    ['look straight down', 'click the nav gizmo’s Y axis, and the projection button under it for an '
      + 'orthographic view. The next step masks by what the CURRENT view sees, so a parallel plan view '
      + 'selects the trail’s true footprint.'],
    ['select overlapping vertices → Delete', 'with the trail selected, this swaps the selection for '
      + 'every mountain corner under it. Delete removes the mountain patches beneath, leaving a '
      + 'trail-shaped hole.'],
    ['weld edges (M)', 'double-click a border edge to take its whole loop, press M to capture it, '
      + 'double-click the facing loop across the hole, then Enter. Weld Loops fills the gap with a '
      + 'connected patch seam without moving either loop, even where the two densities differ.'],
    ['retopologize', 'rebuild the mountain so its quads flow into the new seam. The locked trail comes '
      + 'through untouched and joins as one connected surface.'],
    ['reshape it any time', 'click a trail patch and drag its knots. The patches joined to its rims '
      + 'stretch to follow; while any are, the trail keeps its patch count.'],
  ]);
}
