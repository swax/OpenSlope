import * as THREE from 'three';

/** OrbitControls touch-slot value that maps to "no camera action" (hits its switch default). */
export const TOUCH_NONE = -1 as unknown as THREE.TOUCH;
/** Radians of two-finger twist before the yaw engages — hysteresis so plain pans / pinches don't wobble. */
export const TWIST_ENGAGE = 0.09;
/** Mouse-button slot value that disables an OrbitControls action (no MOUSE enum matches -1). */
export const MOUSE_NONE = -1 as unknown as THREE.MOUSE;
export const WORLD_UP = new THREE.Vector3(0, 1, 0);
/** A loaded reference starts shifted this far up the +X (red) axis, clear of the authored mountain;
 *  drag its centre handle in Info mode to put it anywhere else (the offset persists per session). */
export const REF_LOAD_OFFSET_X = 2000;

/** Raw SSX space (cm, Z-up, X-mirrored) → native editor space (m, Y-up), as a matrix: the same map
 *  ref-level.editorFromRaw applies to the terrain's control points — editorFromRaw(x,y,z) = (-x/100, z/100,
 *  -y/100). Reference props build their instance matrices through this, so they land in the SAME native
 *  editor frame as the reference terrain; refRoot (under worldRoot) then supplies the game-chirality Z flip
 *  for both. Row-major, so it reads like the formula. */
export const RAW_TO_EDITOR = new THREE.Matrix4().set(
  -0.01, 0, 0, 0,
  0, 0, 0.01, 0,
  0, -0.01, 0, 0,
  0, 0, 0, 1,
);

/** A gem Value's model tier — the SAME bucketing the ISO packer uses to pick a shipped gem to clone
 *  (snowknife repack: ≤2 → yellow ×2, ≤4 → orange ×3, else red ×5), so the marker previews the exact
 *  crystal the course ships with. */
export const gemTier = (value: number): number => (value <= 2 ? 2 : value <= 4 ? 3 : 5);

/** Which reference prop models are the TRICK layer rather than scenery: the extractor names grind rails and
 *  their hardware `…Rail…` (Mdl_Rail_Metal, Mdl_Rails, Mdl_RoofRail, Mdl_RailSupport, …) and gem pickups
 *  `…Gem…` (Gem_TrickMultiplier, Gem_RailShowOff, …). setReferenceProps routes matches to the Tricks-gated
 *  group; everything else (trees, boulders, banners, fences, buildings) stays under the Props toggle. */
export const REF_TRICK_MODEL_RE = /rail|gem/i;

/** Tangent-handle directions, fixed order (the four nubs revealed on a selected corner). */
export const HANDLE_DIRS = ['u-', 'u+', 'v-', 'v+'] as const;

/** The control-net's outer rim (edges not shared by two cells) draws in this warm colour so the mesh
 *  boundary reads distinctly against the cool interior net; used for both the authored and reference cages. */
export const CAGE_BOUNDARY_COLOR = 0xff9d3c;
/** Reference-quilt TEARS - every interior border edge that isn't the outer rim (a hole or an unstitched slit)
 *  - draw in this yellow, distinct from the true rim. The depth dither then tells watertight from exposed:
 *  a tear tucked behind surface draws dim, an exposed one bright. */
export const CAGE_TEAR_COLOR = 0xffe000;
/** The plain interior grid lines (the quilt's shared seams) - a bright blue so the normal net reads clearly. */
export const CAGE_INTERIOR_COLOR = 0x74acd6;
/** Protected authored patch edges in the wires-only view. */
export const CAGE_LOCKED_COLOR = 0xff3b30;
/** Extraordinary control-net poles: vertices whose interior-seam valence is not the regular 4. Blue marks
 *  valence 3 and purple marks valence 5; both match the normal green vertex dots' saturation + lightness so
 *  topology changes hue without changing visual weight. Authored/reference cages and the legend reuse them. */
export const CAGE_EXTRA3_COLOR = 0x6ea0e7;
export const CAGE_EXTRA5_COLOR = 0xb56ee7;
/** The control-point cloud colour (both cages). */
export const CAGE_POINT_COLOR = 0x6ee7a8;
/** Shared render order for the Edit-mode selection + surgery overlays (edge selection, cell control-net,
 *  loop-cut ghost): they draw BELOW the cage's points / pole dots (11 / 12) so the vertices stay on top;
 *  the fat edge / cut wires bump to +1 to sit just above the net wires. */
export const LOOP_RENDER_ORDER = 10;
/** Loop-cut surgery ghost (docs/017): the previewed cut CURVE draws gold (the same warm highlight as the
 *  cell shade), a shade wider than the loop-highlight wires so the pending cut reads as an ACTION not a
 *  selection; the inserted-vertex dots are the ordinary green corner colour (that's what they'll become),
 *  and the strip's stop markers reuse the cage's rim / pole colours so a cut's ends read at a glance. */
export const LOOPCUT_LINE_COLOR = 0xffd21a;
export const LOOPCUT_LINE_WIDTH = 2.5;
export const LOOPCUT_DOT_PX = 7;   // inserted-vertex dots along the cut
export const LOOPCUT_STOP_PX = 11; // rim / pole stop markers at the strip's ends
/** The Edit-mode cell selection SHADES its faces yellow (leaving the cell's edges for a separate edge
 *  selection): every selected cell at the same strength — a plain click shades one, Ctrl / Shift build a set,
 *  a double-click fills a whole face-loop strip. */
export const EDIT_CELL_FILL_COLOR = 0xffd21a;
export const EDIT_CELL_FILL_OPACITY = 0.5;       // selected cell(s), one shade for all
/** Temporary local-deformation preview while a mesh gizmo is moving. A cool, faint wash distinguishes the
 * dependency neighborhood from the persistent yellow selection; it disappears on pointer-up. */
export const LIVE_EDIT_FILL_COLOR = 0x55c8ff;
export const LIVE_EDIT_FILL_OPACITY = 0.13;
/** The loft dry-run GHOST (docs/023 S1): the quad chart a Loft would append, shaded as flat quads over the picked
 *  rails' EXISTING corners while the edge selection parses into 2+ rails. A prospective ACTION, so a distinct teal
 *  (not the yellow of a live cell selection) at a lighter strength than a selection shade — it reads as the surface
 *  the commit brings, sharing the cell-shading render path (worldRoot, renderOrder 9, never a pick target). */
export const LOFT_PREVIEW_FILL_COLOR = 0x2fd6c3;
export const LOFT_PREVIEW_FILL_OPACITY = 0.42;
/** Bridge Builder rails cycle through these colors; the current, not-yet-added candidate remains selection yellow. */
export const BRIDGE_RAIL_COLORS = [0x45b8ff, 0xff70c8, 0x8ee35b, 0xff9f43, 0xb78cff, 0x4de0c1] as const;
/** Target-weld gesture (docs/023 S4): the picked FROM vertex (the one that DISAPPEARS) is marked with a dot in a
 *  warning orange, and a faint aim line runs from it to the cursor while the INTO survivor is picked — reading as a
 *  pending ACTION, distinct from the yellow of a live selection. */
export const WELD_FROM_COLOR = 0xff8a3c;
export const WELD_AIM_COLOR = 0xff8a3c;
export const WELD_FROM_PX = 7; // the FROM-vertex marker dot radius, px (screen-constant, over the gizmo)
/** The Edit-mode EDGE selection (Edit, cage on): click an edge to select it, shift to accumulate, double-click
 *  for the whole edge-loop. Selected edges re-draw as a fat line in this yellow — the shared "selected geometry"
 *  colour (the cell shade is the same yellow; edge + cell selections are mutually exclusive, so they never clash),
 *  against the pink control CAGE. Drawn always-on-top (above the cage wires) so it stays visible over the surface. */
export const EDIT_EDGE_SEL_COLOR = 0xffd21a;
export const EDIT_EDGE_SEL_WIDTH = 2.75;         // a shade wider than the loop-highlight wires (1.75)
export const EDGE_PICK_PX = 14;                  // generous screen-space edge band; corners still win first
/** The selected cell's control-point STUDY overlay (Edit, cage on), two distinct things so the relationship
 *  reads: the patch's own SURFACE as an iso-parameter grid (soft blue) — the two internal iso-curves per axis
 *  (u,v = 1/3, 2/3) that lie ON the terrain — and the CONTROL cage in pink (the same pink as the tangent-handle
 *  nubs a selected corner shows). Only the four corners land on the surface; the twelve handles float off it,
 *  pulling the surface toward them without ever touching — drawn as circles, the prospective pull targets. */
export const CTRL_NET_COLOR = 0x6e82b0;   // the on-surface iso-grid (the real surface the cell produces) — a soft, low-saturation slate blue, the cool controlled-surface against the warm cage
export const CTRL_CAGE_COLOR = 0xff5cc8;  // the control CAGE (lattice + handle circles + corner dots): pink, matching the tangent-handle nubs a selected corner shows — the controlling cage against the cool iso-grid
export const CTRL_NET_LINE_WIDTH = 1.0;   // the iso-grid, fat-line px (thin — a subtle surface grid)
export const CTRL_NET_PT_PX = 4;          // each on-surface CORNER control-point dot, px
export const CTRL_HANDLE_PX = 7;          // each floating HANDLE control point, drawn as a circle (a prospective pull target), px
export const CTRL_NET_SEG = 12;           // straight sub-segments per iso-curve (tessellation smoothness)
export const CTRL_ANCHOR_COLOR = 0xff8c42; // warm pull-lines: each handle -> the surface spot it tugs hardest (its max-Bernstein u,v)
export const CTRL_SEL_COLOR = 0xffd21a;   // a SELECTED control point — a picked cage handle or the corner marker: the shared selection yellow (matches the edge / cell selection), so a grabbed point pops off the pink cage
export const CTRL_CORNER_SEL_PX = 6;      // the selected-corner marker dot radius, px (screen-constant, over the gizmo)
/** Tangent-handle nub radius, px — held constant on screen each frame (a world-scaled ball ballooned
 *  over the gizmo arrows up close, and the arrows are what's usually being pulled). */
export const HANDLE_NUB_PX = 5;
/** The tile-orientation F overlay (top-bar "F" toggle): a chiral pink "F" drawn on each textured patch in
 *  the TILE's art space, so the F sits exactly how the art sits on the surface — a rotated tile shows a
 *  rotated F, a mirrored patch a mirror-image F. The Library / preview / pad draw the same F on their
 *  tiles, so orientations are matched by eye across all of them. Same pink as `--f-overlay` in the panels. */
export const UV_GLYPH_COLOR = 0xff7ee6;
/** With the F overlay AND the control cage both on, every patch also draws a green frame F straight in
 *  its OWN u/v square (where a rot-0 tile would sit), tucked into the patch's real (0,0) corner — so the
 *  cage view shows the patch frames next to the art Fs: pink parallel to green = 0°, green flipping
 *  between neighbours = the cage frames themselves disagree (common in original data). */
export const FRAME_GLYPH_COLOR = 0x3fd968;
/** F-overlay stroke width, px (fat lines — LineBasicMaterial is stuck at 1px). */
export const F_LINE_WIDTH = 2.5;
/** The F's strokes in tile-art coords (x right, y up, unit square): stem, top arm, middle arm. Stored tex
 *  x is art-right and tex y is art-DOWN (the terrain samples with flipY=false to match the bake), so the
 *  glyph mapper negates the y term. */
export const UV_GLYPH_STROKES: [number, number, number, number][] = [
  [0.35, 0.2, 0.35, 0.8],
  [0.35, 0.8, 0.68, 0.8],
  [0.35, 0.52, 0.58, 0.52],
];
/** Straight sub-segments per cubic cage-wire edge — the fixed stride shared by the global cage build and
 *  the live-edit preview's in-place curve rewrites. */
export const CAGE_EDGE_SEG = 6;
/** Opacity multiplier for cage segments HIDDEN behind the solid surface (drawn dim so visible edges pop). */
export const CAGE_OCCLUDED_DIM = 0.2;
/** Effects host wires sit above ordinary prop wires, but below the amber selected-host treatment. */
export const EFFECT_PROP_OVERLAY_RENDER_ORDER = 90;
/** Depth bias pushing every occluder surface (and the cage-view depth mask) slightly back, so cage wires that
 *  lie ON the surface - and the small dips where the curved edges cut just under the tessellation - read as in
 *  front (bright / visible) instead of z-fighting; only genuinely far-behind wires stay occluded / dimmed. */
export const SURFACE_POLY_OFFSET = { polygonOffset: true, polygonOffsetFactor: 3, polygonOffsetUnits: 6 };

/** The most a sign light brightens the billboard it aims at / a prop the reference rig lights: a saturating
 *  multiply of the tile, `1 + MAX·(1 − e^(−strength·glow))` per channel (bounded to ≤ 1 + MAX×). Shared by the
 *  authored sign-light tint (lights) and the reference prop-rig tint (reference). */
export const PROP_RIG_MAX_BOOST = 2.0;
/** The tint strength for an authored sign light on its billboard. */
export const SIGN_TINT_STRENGTH = 1;

/** Projection-toggle glyphs, drawn to show the CURRENT projection (swapped on toggle): perspective = three
 *  lines converging to a vanishing point, orthographic = three parallel lines (rays that never converge). */
export const svgGlyph = (body: string) =>
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
export const PERSP_ICON = svgGlyph('<path d="M4 6 20 12M4 12H20M4 18 20 12"/>');   // three lines converging to a point
export const ORTHO_ICON = svgGlyph('<path d="M4 7H20M4 12H20M4 17H20"/>');          // three parallel lines
