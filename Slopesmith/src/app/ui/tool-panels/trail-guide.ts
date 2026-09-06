import { steps } from '../components/gui';
import type { ToolsContext } from './widgets';

/**
 * The recipe for the part no single tool owns: a committed trail is its own ribbon lying ON the mountain,
 * and making it part of the mountain is a sequence across four others (overlap select, lock, Weld Loops,
 * retopology). The order is the content — locking before the seam is what carries the measured trail surface
 * through the rebuild intact — so it reads as a numbered list rather than prose.
 *
 * Shown at the bottom of both panels the sequence runs between: Create Trail, where it is the answer to "the
 * trail is floating on the terrain, now what", and Retopology, which is its last step and where the lock in
 * step 4 is the precondition that panel's warning banner is already asking for. One list, two call sites, so
 * the two panels cannot drift into describing the same workflow differently. Collapsed by default in both:
 * it is wanted once per trail, not on every pass through the panel.
 */
export function buildTrailIntegrationGuide(editSection: ToolsContext['editSection']) {
  const guide = editSection('trail-integration', 'Guide · Integrate Trail With Terrain', false);
  steps(guide, [
    ['create the trail', 'lay the centre spline over the terrain and press Enter. The new patches rest '
      + 'on top of the mountain, sharing no vertices with it, and stay selected.'],
    ['look straight down', 'click the nav gizmo’s Y axis, and the projection button under it for an '
      + 'orthographic view. The next step masks by what the CURRENT view sees, so a parallel plan view '
      + 'selects the trail’s true footprint.'],
    ['select overlapping vertices → Delete', 'with the trail patches still selected, this swaps the '
      + 'selection for every mountain corner under them. Delete removes the mountain patches beneath, '
      + 'leaving a trail-shaped hole.'],
    ['lock patches', 'click one trail patch and press Ctrl+A to grow the selection through the now-'
      + 'separate ribbon, then Lock under Visibility. Locked surfaces stay exact through the seam and '
      + 'the rebuild below.'],
    ['weld edges (M)', 'double-click a border edge to take its whole loop, press M to capture it, '
      + 'double-click the facing loop across the hole, then Enter. Weld Loops fills the gap with a '
      + 'connected patch seam without moving either loop, even where the two densities differ.'],
    ['retopologize', 'rebuild the mountain so its quads flow into the new seam. The locked trail comes '
      + 'through untouched and joins as one connected surface.'],
  ]);
}
