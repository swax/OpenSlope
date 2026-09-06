import type * as THREE from 'three';
import type { V3 } from '../../core/doc/types';
import type { TexRef } from '../../core/paint/textures';
import type { SlidePlan } from '../../core/mesh/slide';
import type { MeshControlPointId, MeshControlPointTarget } from '../../core/mesh/control-points';
import type { NamedEdge, QuadName, VertexName } from '../state/mesh-names';
import type { EdgeExtrusionPlacement, EdgeExtrusionPlan } from '../../core/mesh/ops';
import type { PlacementEndpoint } from './input/placement-constraint';
import type { EdgeCrossing } from '../../core/mesh/edge-crossings';
import type { CoincidentVertices } from '../../core/mesh/coincident-vertices';
import type { ExternalSoundEmitter } from '../../core/effects/external-sound';
import type { TextureFlipEffect } from '../../core/effects/world-effects';
import type { RigLight } from '../../core/reference/lights';
import type { ReferenceScreenPickDetails } from '../../core/reference/screens';
import type { PropAlphaMode } from '../../core/reference/props';
import type { RideEvent } from '../../core/session/ride-event';

/**
 * One frame of a rigid Rotate / Scale over a corner, edge or cell selection: absolute positions for the
 * moved corners, absolute offsets for the directed boundary handles and interior twists that rotate with
 * them. Everything is named (docs/039) because the drag froze its members before the first frame, and the
 * host writes the values back after — a position captured under one numbering has to land on the same
 * corner under any other.
 */
export interface RigidCornerUpdate {
  vertices: { vertex: VertexName; pos: V3 }[];
  edgeHandles: { from: VertexName; to: VertexName; offset: V3 }[];
  quadTwist: { quad: QuadName; offsets: [V3, V3, V3, V3] }[];
}

/** One absolute rotation frame for the combined Edit marquee. Directly selected control points are kept
 * separate from topology-carried cage values so the host can apply them last and resolve overlaps exactly. */
export interface MixedEditRotationUpdate {
  corners: RigidCornerUpdate;
  controlPoints: MeshControlPointTarget[];
  props: PropRotationUpdate[];
}

/** One placed prop's absolute pose after a rotate drag: its rigidly-carried origin plus the full authored
 *  rotation (core/props/pose). `pitch` / `roll` are always present here — the host drops the zeros when it
 *  writes them back, so an upright prop keeps serializing as it always has. */
export interface PropRotationUpdate {
  index: number;
  pos: V3;
  yaw: number;
  pitch: number;
  roll: number;
}

export type CreateEdgeEndpoint = PlacementEndpoint & {
  /** Authored surface or free edge under the click. Surface contacts are integrated; free-edge contacts warn. */
  edge?: [number, number] | null;
  /** Fraction along `edge`'s authored cubic curve. */
  t?: number;
};

/** One cached material submesh of a placed prop model: its geometry (model-local cm, position + uv) and the
 *  source level + texture files it draws with (null = untextured), so a placement can build a Mesh per tile.
 *  Keyed "<level>:<model>" in the shared propGeom cache the props / gems / reference layers all read. */
export interface PropSubGeom {
  geometry: THREE.BufferGeometry;
  /** Native ModelObjects[] index for full-hierarchy animation clips. */
  object?: number;
  level: string;
  tex: string | null;
  frames: string[];
  crowdFrames: string[];
  /** Source material's alpha-pass flag. Pixel analysis separates cutout from blend/glow. */
  blend?: boolean;
  /** Authored/imported material whose conventional PNG, rather than a native flag word, decides alpha. */
  pixelAlpha?: boolean;
  /** Explicit glTF/author/sidecar verdict, when pixels and native flags are not the final authority. */
  alphaMode?: PropAlphaMode;
  /** Source material's opaque draw-priority flag (bit 17, [Trailmap: 170]); its mask pixels may alpha-test. */
  prio?: boolean;
  /** The submesh is a single-facing sheet, so a blend material draws it without depth write. */
  sheet?: boolean;
  /** Which material this submesh draws, so a graph node scoped to one material can be resolved per
   *  submesh — how a snow gun's plume scrolls while its bodywork does not (docs/032). */
  mat: number;
}

/** The appearance identity of the material submesh a prop click LANDED on — a model can carry several
 *  textures (one submesh each), so this describes exactly the surface under the cursor. Stamped on the
 *  scene meshes (reference-decor / scene/props) and read straight off a raycast hit.
 *  [Trailmap: 170-materials] */
export interface RefPropSurfaceDetails {
  /** Frame-zero texture file in the source level's Textures/, or null (untextured neutral clay). */
  tex: string | null;
  /** Appearance word bit 18: draws in the game's alpha pass (cutout OR blend — the split between those
   *  two is a property of the texture's alpha channel, not a flag). */
  blend: boolean;
  /** Explicit material verdict, when one overrides the native alpha-pass bit and pixel classifier. */
  alphaMode?: PropAlphaMode;
  /** Appearance word bit 17: opaque draw-order priority — the coplanar-decal z-fight tiebreaker
   *  (retail: the LCD scan overlay, the firework cylinder, the finish-line coral). */
  prio: boolean;
  /** Texture-animation frame count (native flipbook or the crowd sequence); 0 = static. */
  frames: number;
  /** Native texture filenames in display order. Present for a flipbook/crowd sequence so Texture Details
   *  can show and inspect every extracted frame rather than reducing the animation to a count. */
  frameFiles?: string[];
  /** Recovered playback law used by the viewport material; Texture Details reuses it for its Play preview. */
  flipbook?: TextureFlipEffect;
  /** The clicked instance carries a UV-scroll effect (the river's flow). */
  scroll: boolean;
}

/** View = read-only navigate + click-to-select (no editing); the rest are the editing modes. */
export type Mode = 'info' | 'edit' | 'paint' | 'sculpt' | 'props' | 'effects' | 'play';
/** Shared world-unit choices for the drafting grid and transform / placement snapping. */
export type SnapStep = 1 | 5 | 10;
/** Rotation snap increment in degrees. */
export type RotationSnapStep = 5 | 15 | 45;
/** Shared transform-gizmo tool. W / E / R select Move / Rotate / Scale. */
export type GizmoMode = 'move' | 'rotate' | 'scale';
/** Transform axes / constraint frame: world axes, slope-local axes, or slope-local axes plus surface sliding. */
export type GizmoFrame = 'world' | 'local' | 'surface';
/** Terrain solid: the real tiles ('textured'), a flat SurfaceType / ride-feel tint ('surface'), or no
 *  solid surface at all ('none' — e.g. wireframe / control-cage only). */
export type ShadeMode = 'textured' | 'surface' | 'none';

/** A serialisable snapshot of the camera framing — enough to restore the exact current view on reload
 *  (see serializeView / applyView). Captures the ACTIVE camera so it's correct in either projection. */
export interface ViewState {
  pos: [number, number, number];    // active camera world position
  target: [number, number, number]; // orbit / look target
  ortho: boolean;                   // orthographic vs perspective projection
  zoom: number;                     // orthographic zoom (1 in perspective)
  orthoHalfH: number;               // orthographic frustum half-height (set when switching to ortho)
}

/**
 * The mesh-selection substrate the viewport reads — the app store IS this object (it satisfies the interface
 * structurally), so each selection has ONE owner instead of a store field plus a viewport mirror. The authored
 * fields are the store's Edit-mode selection; the `ref*` fields are the read-only reference twin, resolved by
 * the viewport's own pick paths. The viewport writes the fields it resolves — a corner pick seats
 * `selectedCorner` before the host callback confirms it, and every reference pick lands here directly — and
 * the host owns every other write, refreshing the viewport's drawn state through the `refresh*` methods after
 * a change. `controlSel` is deliberately absent: the store's `controlSel` is the host's canonical union (a
 * plain vertex region reads as vertex-kind control points there), while the viewport's control-point family is
 * the explicitly seated sub-cage selection — a different set, still fed by `setControlPointSelection`.
 */
export interface MeshSelectionState {
  /** The authored families name their geometry by the document's stable ids (docs/039); the viewport resolves
   *  them onto the live mesh where it draws or picks. The `ref*` families opposite stay indices — that mesh is
   *  rebuilt on every load and never edited. */
  selectedCorner: VertexName | null;
  cellSel: QuadName[];
  edgeSel: NamedEdge[];
  /** Ordinary Edit click families enabled by the toolbox Select group. At least one remains enabled.
   *  `prop` off makes placements click-transparent: picks pass through to the mesh beneath. */
  editPickKinds: { point: boolean; edge: boolean; patch: boolean; prop: boolean };
  hiddenVertices: VertexName[];
  hiddenEdges: NamedEdge[];
  hiddenQuads: QuadName[];
  /** Explicit Edit-only sub-cages pinned from an edge/patch selection. */
  controlCageEdges: NamedEdge[];
  controlCageQuads: QuadName[];
  refVertexSel: number[];
  refVertexAnchor: number | null;
  refControlSel: MeshControlPointId<number>[];
  refEdgeSel: [number, number][];
  refEdgeAnchor: [number, number] | null;
  refCellSel: number[];
  refCellAnchor: number | null;
  refCellLoopSeed: number | null;
  refCellLoopDir: 0 | 1;
  /** Reference-side twins of the transient authored visibility sets. The reference never changes, so its
   *  patch / edge indices remain stable until the next reference load (which clears all three). */
  refHiddenQuads: number[];
  refControlCageEdges: [number, number][];
  refControlCageQuads: number[];
}

/** Every authored component family resolved by one Edit-mode marquee. The pointer layer reports live array
 * indices for mesh topology and placed props; the Edit session immediately converts the mesh members to the
 * document's stable names before retaining them. */
export type EditMarqueeSelection = {
  points: MeshControlPointId[];
  edges: [number, number][];
  patches: number[];
  props: number[];
};

/** The result of sampling a clicked surface: the resolved texture plus where it came from. */
export interface PickResult {
  /** What was hit: the authored mountain, the loaded reference terrain, or a prop model's surface (the
   *  clicked material submesh's texture — models can carry several, one submesh each). */
  source: 'current' | 'reference' | 'prop';
  /** Texture ref ("<LEVEL>/<file.png>") at the hit, or null when the spot carries no painted tile. */
  ref: TexRef | null;
  /** Resolved SurfaceType at the hit (current mountain), or null when unknown (reference / prop). */
  surface: number | null;
  /** Bare slot/file name for feedback ("0028.png"), or '' when there's no texture. */
  name: string;
  /** The tile's D4 orientation at the hit, relative to the patch's own frame — the turn from the green
   *  frame-F to the pink art-F. An authored cell returns its stored orientation exactly; a reference patch
   *  recovers it from the patch's tile-UVs (orientFromPatchUV). Painting the brush reproduces it. */
  rot: number;
  mirror: boolean;
}

/** The instance-level details riding a reference-prop pick (viewport → Props panel), decoded from the
 *  level's Instances.json [Trailmap: 130-collision-data, 420-audio-runtime]. Mirrors the same-named
 *  PropInstance fields (core/reference/props), which satisfy this shape structurally. */
export interface RefPropPickDetails {
  /** Instances.json placement label. This is distinct from the Models.json label and is the safer identity
   *  for third-party maps that repurpose a native model slot without updating the MAP model-name table. */
  name?: string;
  /** Original zero-based Instances.json index — the stable key the effects join uses for this instance. */
  sourceIndex: number;
  /** Native LTG spatial-list state: -1 unlisted, 0 common, 1 race list, 2 Showoff/GemIndex. */
  ltgState: number;
  /** ADL hit-sound event id, -1 when the instance ships none. */
  collisionSound: number;
  /** Exact native PlayerCollision / PlayerBounce gates. */
  playerCollision: boolean;
  playerBounce: boolean;
  /** Specified native rider-response class [Trailmap: 130-collision-data]. */
  contact: 'ghost' | 'through' | 'movable' | 'solid';
  /** Kickback: -1 n/a (ghost), 0 contact-only, else PlayerBounceAmmount on a solid response. */
  bounce: number;
  /** Rideable surface type (ride feel + board-audio family), -1 = none (obstacle handling). */
  surface: number;
  /** Collision shape (CollsionMode): 0 none, 1 triangle proxy mesh, 2 bounding box, 3 physics-body spheres. */
  shape: number;
  /** Collision response mass (native U0): exact zero pass-through, nonzero common response. */
  responseMass: number;
  /** Dynamic scalar mass from the collision Roller payload; -1 when no Roller activates this prop. */
  dynamicMass: number;
  /** Rigid-body record in the level's physics pool (PhysicsIndex), -1 when the instance has none. */
  physicsBody: number;
  /** Native ADL listener-region records (`Sounds.ExternalSounds`), lossless through the type-specific tail. */
  externalSounds: ExternalSoundEmitter[];
}

export interface ViewportCallbacks {
  /** A desktop Test ride changed between board/on-foot or first/third person; redraw its key-mapping sheet. */
  onRideControlContextChange?(): void;
  /** A local human rider started a transient world interaction that peers on this map should also see. */
  onRideEvent?(event: RideEvent): void;
  /** Upper-right orthographic controls: toggle the persisted XYZ reference-grid preference. */
  onToggleViewGrid?(): void;
  /** Upper-right Grid resolution menu: change the persisted drafting-grid spacing. */
  onSetViewGridStep?(step: SnapStep): void;
  /** Upper-right Snap control: toggle global transform and placement snapping. */
  onToggleSnap?(): void;
  /** Upper-right Snap resolution menu: change the persisted translation increment. */
  onSetSnapStep?(step: SnapStep): void;
  /** Upper-right Snap resolution menu: change the persisted rotation increment in degrees. */
  onSetRotationSnapStep?(step: RotationSnapStep): void;
  onSelectKnot(index: number | null): void;
  /** A mesh component or scene object was positively identified under the pointer, but the active view has no
   *  action for it—or its Edit selection family is filtered out. The host acknowledges it without mutation. */
  onClickTargetUnavailable?(target: 'vertex' | 'line' | 'surface' | 'prop' | 'light' | 'rail' | 'gem'
    | 'screen' | 'knot',
    source: 'authored' | 'reference'): void;
  /** Edit mode: an authored prop placement was clicked. Ctrl/Cmd toggles it alongside any selected mesh
   *  families; a plain click keeps the existing select / click-again-to-edit behavior. True = handled. */
  onEditPropPick?(index: number, toggle: boolean): boolean;
  /** Edit mode: a plain click landed on nothing selectable (empty space or the model-session's read-only
   *  mountain backdrop). Ends an unlocked model edit session — the host applies the lock / armed-tool rules. */
  onEditClickAway?(): void;
  /** Info-mode course marquee finished: replace the bulk knot selection with these course indices. */
  onSelectKnots?(indices: number[]): void;
  onMoveKnot(index: number, pos: V3): void;
  /** A start/finish flag was dragged: `pos` is the GROUND point it now marks (the handle's lift removed).
   *  Stores an anchor on the run, which is what takes the endpoint off the line's ends. */
  onMoveAnchor?(which: 'start' | 'finish', pos: V3): void;
  onPaintCell(quad: number): void;
  /** Paint MMB resolved a texture on the terrain, reference, or prop to arm it (see PickResult). */
  onPick(result: PickResult): void;
  /** Sculpt dab at a terrain hit, including its authored quad seed and data-space surface normal. */
  onSculpt(point: V3, quad: number, normal: V3): void;
  /** Start/end a repeated-dab Sculpt stroke; Flatten uses this to capture and release an original plane. */
  onBeginSculpt(point: V3, quad: number, normal: V3): void;
  onEndSculpt(): void;
  /** Whether Sculpt's current operation is the fixed-footprint press/drag Grab brush rather than a live-hit stroke. */
  isGrabBrush(): boolean;
  /** Capture Grab's source positions and connected surface-space footprint on pointer-down. */
  onBeginSculptGrab(point: V3, quad: number): void;
  /** Re-evaluate the captured Grab footprint at this total data-space displacement from pointer-down. */
  onSculptGrab(delta: V3): void;
  /** Release the frozen Grab footprint after pointer-up/cancel. */
  onEndSculptGrab(): void;
  /** A control-net corner was selected (mountain Edit, cage on), or deselected with null. */
  onSelectCorner(index: number | null): void;
  /** A control-net corner was dragged to a new 3D position (flat corner index). */
  onMoveCorner(index: number, pos: V3): void;
  /** A tangent handle nub (dir 'u-'|'u+'|'v-'|'v+') of the selected corner was dragged to a world pos. */
  onMoveHandle(dir: string, pos: V3): void;
  /** A cage tangent handle of a selected cell / edge (Edit, cage on) was dragged to a world pos: it's the
   *  directed-edge handle from vertex `from` toward `to` (an on-edge bicubic control point), so the host
   *  pins that handle to `pos − vertex(from)` via meshSetHandle — the same store edgeHandles the corner
   *  nubs write, reached from the cell / edge control-net study instead. */
  onMoveCageHandle?(from: number, to: number, pos: V3): void;
  /** An INTERIOR twist handle (cp5/6/9/10) of a selected cell (Edit, cage on) was dragged to a world pos:
   *  `quad` + corner slot `corner` (0/1/2/3 = A/B/C/D) name the interior control point, so the host pins the
   *  quad's `quadTwist[corner]` to `pos − zeroTwistPos` (its offset off the Ferguson prediction) — the
   *  sub-cell relief the boundary handles can't reach. */
  onMoveTwist?(quad: number, corner: number, pos: V3): void;
  /** Select any authored bicubic points through the global sub-cage point cloud. Shift adds, Ctrl-click
   *  toggles, Ctrl-drag removes, and a box reports every corner, boundary tangent and interior point it encloses. */
  onSelectControlPoints?(ids: MeshControlPointId[], mode: 'replace' | 'add' | 'remove' | 'toggle'): void;
  /** The centroid gizmo translated the selected authored control points as one exact batch. */
  onMoveControlPoints?(delta: V3): void;
  /** The centroid rotation gizmo placed a mixed authored control-point group at exact absolute targets. */
  onRotateControlPoints?(targets: MeshControlPointTarget[]): void;
  /** The centroid scale gizmo placed a mixed authored control-point group at exact absolute targets. */
  onScaleControlPoints?(targets: MeshControlPointTarget[]): void;
  /** A mesh gizmo drag ended; the host runs one authoritative full rebuild after live patch-local previews. */
  onEditTransformEnd?(): void;
  /** A box-select gesture finished: the flat indices of every corner inside the rectangle. Shift-drag adds,
   *  Ctrl-drag removes, and a plain drag replaces the current corner family. */
  onSelectCorners(indices: number[], mode?: 'replace' | 'add' | 'remove'): void;
  /** Edit-mode box selection resolves every enabled Point / Edge / Patch / Prop family in one atomic result.
   *  Several non-empty families deliberately coexist until the user narrows the chooser to one toolbox. */
  onSelectEditMarquee?(selection: EditMarqueeSelection, mode: 'replace' | 'add' | 'remove'): void;
  /** Shift-click on a control-net corner (Edit, cage on): extend the selection by the rectangular BLOCK of
   *  corners spanned from the anchor (the last plainly / ctrl-clicked corner) to this one ACROSS THE QUAD GRID
   *  (`resolveVertexSelection` 'range' → `meshVertexBlock`) — a straight run when they share a row / column, the
   *  whole patch of corners when diagonal. The host owns the anchor + the grid math and seats the group
   *  (centroid) gizmo. */
  onRangeSelectCorner?(index: number): void;
  /** Ctrl-click on a control-net corner (Edit, cage on): toggle it in / out of the corner selection for a
   *  non-consecutive multi-pick — the point twin of a Ctrl edge toggle (`resolveVertexSelection` 'toggle').
   *  The host owns the set + anchor and seats the group (centroid) gizmo. */
  onToggleCorner?(index: number): void;
  /** Edit mode (cage on): a click landed on a cell's FACE (missed every corner) — select that CELL (by quad id),
   *  the surface counterpart of a corner / edge pick, through the shared `resolveCellSelection`. `mode`: `replace`
   *  (plain click) single-selects it + overlays its control-net study (matching a clicked reference patch);
   *  `toggle` (Ctrl) adds / removes it from the set for a non-consecutive multi-pick; `range` (Shift) unions the
   *  rectangular BLOCK of cells spanned to the anchor across the quad grid. The host owns the set + anchor. */
  onSelectEditCell?(quad: number, mode: 'replace' | 'toggle' | 'range'): void;
  /** Edit mode, double-click on a cell face: select its face LOOP (the strip of cells crossing it). A quad has
   *  two strip directions; a first double-click takes one and re-double-clicking the SAME cell alternates to the
   *  other (row ⇄ column), so a repeat tap flips it — the host owns that toggle. `additive` (shift) unions the
   *  loop into the current cell set (a second direction makes the cross); otherwise it replaces the selection. */
  onSelectCellLoop?(quad: number, additive: boolean): void;
  /** Edit mode (cage on): a click landed near a control-net EDGE (nearer than any corner, nearer than the
   *  face) — select that edge (canonical `[lo,hi]` vertex ids). `mode`: `replace` (plain click) drops any
   *  corner / cell selection and picks just this edge; `toggle` (Ctrl) adds / removes it from the set for
   *  non-consecutive picks; `range` (Shift) selects the run of edges between the anchor and this one ALONG
   *  THEIR SHARED LOOP (ignored off the loop). The host owns the set + anchor and the loop math. */
  onSelectEdge?(edge: [number, number], mode: 'replace' | 'toggle' | 'range'): void;
  /** Edit mode, double-click near an edge: select its whole EDGE-LOOP (`meshEdgeLoop`) — a boundary seed
   *  follows the complete outside/hole perimeter; an interior seed follows its collinear chain. `additive`
   *  (shift) unions the loop into the current edge set; otherwise it replaces the selection. */
  onSelectEdgeLoop?(edge: [number, number], additive: boolean): void;
  /** Extrude the current authored boundary/free-edge selection: append one connected patch per edge at
   * this displacement. A free source edge is consumed; the host selects the translated outer edge(s). */
  onExtrudeEdges?(edges: [number, number][], delta: V3): void;
  /** Bake the currently staged extrusion after its outer edge has been moved / rotated / scaled. */
  onCommitExtrudeEdges?(plan: EdgeExtrusionPlan, placement: EdgeExtrusionPlacement): boolean;
  /** Staged-extrusion mode entered or left; the host refreshes toolbox/help state. */
  onExtrudeStageChange?(active: boolean): void;
  /** An extrusion was attempted on a selection the topology guard cannot extrude (usually an interior edge). */
  onExtrudeEdgesInvalid?(error: string): void;
  /** Edit mode: the read-only REFERENCE control-net selection (its edge / cell pick, viewport-owned) changed —
   *  the host rebuilds the toolbox so its metric read-out re-reads `viewport.refMeasure()`. The reference is
   *  measured through the same core as the authored net, so one read-out serves both. */
  onRefSelectionChange?(): void;
  /** The multi-corner selection's centre gizmo was dragged (Move motion) — move EVERY selected corner by
   *  this data-space delta (the host owns the index set, mirroring onMoveProps). */
  onMoveCorners?(delta: V3): void;
  /** Edit mode: the shared centroid gizmo for a mixed point / edge / patch / prop marquee moved. The host
   *  resolves and de-duplicates every selected mesh target, then carries the selected props by the same delta. */
  onMoveMixedEditSelection?(delta: V3): void;
  /** Edit mode: rotate every authored family in a mixed marquee around its shared frozen centroid. */
  onRotateMixedEditSelection?(update: MixedEditRotationUpdate): void;
  /** The multi-corner / edge / cell selection's centre gizmo was rotated. Every field is an absolute value
   *  from the drag-start snapshot: vertices revolve around the centroid, while effective boundary-handle and
   *  interior-twist vectors take the same rigid rotation so the selected control cage keeps its shape.
   *  The snapshot names what it froze, so a value it reports lands on the geometry it was taken from. */
  onRotateCorners?(update: RigidCornerUpdate): void;
  /** Scale a multi-corner / edge / cell selection about its centroid, including its cage vectors. */
  onScaleCorners?(update: RigidCornerUpdate): void;
  /** The multi-corner selection's centre gizmo was dragged (Slide motion) — the viewport computed each
   *  member's new data-space position from a grid-proportional slide along the frozen surface (every point
   *  advances the same FRACTION of its own cell toward its next vertex, so the group keeps its ratios).
   *  The host just writes these absolute positions (mirrors onMoveCorners but positional, not a delta). */
  onSlideCorners?(updates: { vertex: VertexName; pos: V3 }[]): void;

  // ---- Surface-mode EXACT slide (docs/006): the two in-plane arrows (X = down-mountain, Z = cross-slope) and the
  // XZ tangent pad drag a corner, an edge selection or a cell selection. A slide is a de Casteljau RE-CUT of the
  // control net, not a deformation of it (core/mesh/slide.ts): an arrow preserves the whole surface it re-parameterises,
  // and the pad's 2-D drag lands every moved vertex exactly on it. The viewport owns the gizmo and turns the cursor
  // into the drag's two parameters; the host owns the doc and does the writes. Every frame re-cuts the DRAG-START
  // snapshot, never the previous frame's result, so nothing drifts.

  /** A Surface-mode slide began on a corner / edge / cell selection: snapshot the live doc. Every `onSlideRecut`
   *  frame below re-cuts THAT snapshot. Paired with exactly one `onSlideEnd`. */
  onSlideBegin?(): void;
  /** One frame of the slide: the passes to run against a fresh clone of the frozen snapshot (`applySlidePlan`),
   *  and the weld a release at the far clamp commits. The viewport names the weld because only it knows which
   *  axis is merging — and a merging axis pins the other at zero, so the plan carries the single pass the shipped
   *  1-D slide would have carried. An empty `weld` means a release here merges nothing. */
  onSlideRecut?(plan: SlidePlan): void;
  /** The slide has reached its far end and is held at the clamp: releasing now MERGES (welds) into the
   *  neighbour. Fired only on the transition, so the host can put a hint up and take it down again. */
  onSlideMergePending?(pending: boolean): void;
  /** The slide drag ended. `mergePending` ⇒ commit the weld the last frame was clamped against — on release,
   *  never mid-drag: an id remap would pull the selection, the gizmo and the snapshot out from under the drag. */
  onSlideEnd?(mergePending: boolean): void;
  /** Props mode: the armed prop was dropped where its ghost stood — the SEATED origin (data space, base
   *  already dropped by baseOffset×scale) plus the ghost's pending turn / size. */
  onPlaceProp?(pos: V3, yaw: number, scale: number): void;
  /** Props mode: a placed prop was selected (its doc index), or cleared with null. */
  onSelectProp?(index: number | null): void;
  /** Effects mode: resolve a clicked authored prop's stable-ID attachment. Ctrl/Cmd toggles it in the effect-host
   *  selection; false means show the mode hint. */
  onSelectEffectProp?(index: number, additive: boolean): boolean;
  /** Effects mode: an empty or terrain click clears the current effect/prop/node selection. */
  onClearEffectSelection?(): void;
  /** Props mode: a placed prop was dragged to a new data-space position (its origin). */
  onMoveProp?(index: number, pos: V3): void;
  /** Props mode: a placed prop was turned — the full authored rotation, all three rings. */
  onRotateProp?(index: number, rot: { yaw: number; pitch: number; roll: number }): void;
  /** Props mode: the selected prop was uniformly scaled about its authored origin. */
  onScaleProp?(index: number, pos: V3, scale: number): void;
  /** Effects mode: resize one generated trigger box independently on each authored axis. */
  onResizeEffectTrigger?(index: number, size: V3): void;
  /** Props select mode: a box-select drag finished — the doc indices of every placed prop whose origin
   *  projected inside the rectangle (empty = the drag covered nothing, clearing the set). */
  onSelectProps?(indices: number[]): void;
  /** Props mode: the multi-selection's centre gizmo was dragged — move EVERY selected prop by this
   *  data-space delta (the host owns the index set). */
  onMoveProps?(delta: V3): void;
  /** Props mode: rotate a multi-selection rigidly about its centroid, including each member's own rotation. */
  onRotateProps?(updates: PropRotationUpdate[]): void;
  /** Props mode: uniformly scale a multi-selection about its centroid, including each member's size. */
  onScaleProps?(updates: { index: number; pos: V3; scale: number }[]): void;
  /** Props mode: a middle-click copied a reference-world prop — arm that exact instance's model and inferred
   *  collision profile. `sourceIndex` preserves native sphere-body donors and independent contact gates. */
  onPickReferenceProp?(level: string, model: number, name: string, sourceIndex?: number): void;
  /** Props mode: a middle-click copied a placed prop — arm its model to place more. */
  onPickPlacedProp?(index: number): void;
  /** Props select mode: a reference-world prop was clicked — a READ-ONLY selection (outline + preview card;
   *  no gizmo, the reference can't be edited). All-null clears it. */
  /** `inst` = the picked INSTANCE's decoded contact + audio data — instance data, so it rides the pick
   *  instead of the model identity [Trailmap: 130-collision-data, 420-audio-runtime]. Material-submesh
   *  identity is owned by the separate texture-details / Paint inspection path. */
  onSelectReferenceProp?(level: string | null, model: number | null, name: string | null,
    inst?: RefPropPickDetails): void;
  /** Sources overlay: a recovered reference light bulb was clicked. All-null clears the read-only record. */
  onSelectReferenceLight?(level: string | null, light: RigLight | null): void;
  /** Effects mode: resolve a native prop slot by original Instances.json index. Ctrl/Cmd toggles it in the
   *  reference effect-host selection; false means show the mode hint. */
  onSelectReferenceEffectProp?(sourceIndex: number, additive: boolean): boolean;
  /** Effects mode: select a standalone PBD particle volume. These are fog-bank objects, not prop attachments. */
  onSelectParticleVolume?(source: 'authored' | 'reference', index: number, id?: string): boolean;
  /** Paint select mode: a reference patch was clicked — a READ-ONLY selection carrying its tile, the D4
   *  orientation recovered from the patch UVs, and the patch's own SurfaceType (its ride feel). */
  onSelectRefPatch?(patch: number, ref: TexRef, rot: number, mirror: boolean, surface?: number | null): void;
  /** Paint select mode: a PROP was clicked — inspect the clicked material submesh's texture read-only
   *  (models can carry several textures; the hit resolves to exactly one). `ref` is null when that
   *  surface is untextured; `propName` names the model for feedback ('' when unknown); `surface`
   *  carries the submesh's appearance identity for the readout; `uvEdges` its deduped triangle edges in
   *  UV space ((u1,v1,u2,v2)-packed) for the palette's mapping overlay. */
  onInspectPropTexture?(ref: TexRef | null, propName: string, surface?: RefPropSurfaceDetails | null,
    uvEdges?: Float32Array | null): void;
  /** Paint mode, no brush armed: a click landed on this quad (null = clicked off the terrain) — the host
   *  selects it if painted, else clears the selection. */
  onSelectPaintCell?(quad: number | null): void;
  /** Paint select mode, shift-click while a cell selection is live: add this quad to the painted-cell
   *  multi-selection (the host owns the set). */
  onRangeSelectPaintCell?(quad: number): void;
  /** An armed free light was dropped at this data-space ground point; the host adds height and snaps it. */
  onPlaceLight?(pos: V3): void;
  /** A placed free light was selected (its stable id), or cleared with null. */
  onSelectLight?(id: string | null): void;
  /** A placed free light was dragged to a new data-space position. */
  onMoveLight?(id: string, pos: V3): void;
  /** Rail drawing: a terrain click appends a node at this final height-adjusted, snapped data-space point. */
  onAppendRailNode?(pos: V3): void;
  /** A rail node was selected (its rail + node index), or cleared with null/null. */
  onSelectRailNode?(rail: number | null, node: number | null): void;
  /** A rail node was dragged to a new data-space position. */
  onMoveRailNode?(rail: number, node: number, pos: V3): void;
  /** A shipped level's grind curve was clicked in Effects mode, by its stable `Splines.json` row. */
  onSelectReferenceSpline?(originalIndex: number): void;
  /** Gem tool: a click dropped one gem at this final height-adjusted, snapped data-space point. */
  onPlaceGem?(pos: V3): void;
  /** Gem tool: a drag laid a row between these final height-adjusted, snapped endpoints. */
  onPlaceGemLine?(a: V3, b: V3): void;
  /** A placed gem was selected (its stable id), or cleared with null. */
  onSelectGem?(id: string | null): void;
  /** A placed gem was dragged to a new data-space position. */
  onMoveGem?(id: string, pos: V3): void;
  /** A video screen was selected (its stable id), or cleared with null (docs/051). */
  onSelectScreen?(id: string | null): void;
  /** Sources overlay: a shipped level's detected screen was clicked. It is inspected read-only. */
  onSelectReferenceScreen?(level: string | null, screen: ReferenceScreenPickDetails | null): void;
  /** A video screen was dragged to a new data-space CENTRE. An attached screen's stored pose is in its
   *  board's frame, so the host converts before writing — the viewport reports world, as it does for every
   *  other family. */
  onMoveScreen?(id: string, pos: V3): void;
  /** Effects mode: move the selected timer emitter's local U9/U10/U11 origin through its world-space handle. */
  onMoveEffect?(pos: V3): void;
  /** Create Edge tool: vertices/free space draw ordinary edges; surface-edge hits route a conforming surface cut. */
  onCreateEdgePoint?(endpoint: CreateEdgeEndpoint): void;
  /** Edit diagnostic: select a close non-connected edge pair, or clear it by clicking elsewhere. */
  onSelectEdgeCrossing?(crossing: EdgeCrossing | null): void;
  /** Edit diagnostic: select a pair of distinct vertices occupying the same position, or clear it. */
  onSelectCoincidentVertices?(diagnostic: CoincidentVertices | null): void;
  /** Edit mode, Create Tube: its transient axis endpoints changed, so the host can refresh the generated shell. */
  onCreateTubeAxisChange?(): void;
  /** Edit mode, Create Trail: the transient centre-spline knot sequence changed. */
  onCreateTrailPointsChange?(): void;
  /** The loaded reference was selected by clicking its body in 3D (so the panel can show it). */
  onSelectReference?(): void;
  /** The loaded reference was dragged to a new place (its move-handle drag ended) — persist the offset. */
  onMoveReference?(): void;
  /** Info mode: the terrain body was clicked (no knot / reference under the cursor) — select the Mountain
   *  item in the scene tree. */
  onSelectMountain?(): void;
  /** Test mode: the ride target mountain was clicked (world-space surface hit). What that means is the host's
   *  call, not the viewport's — ordinarily it drops an AI rider there; with "Set custom start" armed it places
   *  the ride start instead, once. */
  onPlayClick?(world: V3): void;
  /** Edit mode, Loop cut surgery (docs/017): a click committed the previewed cut. `quad` + `edge` (two
   *  corner ids) name the hovered rail the strip crossed; `t` is the fraction along it. The host re-plans
   *  against the live doc and applies it (mesh-ops.applyLoopCut), then rebuilds. */
  onLoopCut?(quad: number, edge: [number, number], t: number): void;
  /** Edit mode, Create Patch: three or four perimeter-ordered clicks request a triangle or quad. Each corner
   * either reuses an existing vertex or supplies a new terrain/free-space point. False keeps the tool active. */
  onCreatePatch?(corners:
    | [PlacementEndpoint, PlacementEndpoint, PlacementEndpoint]
    | [PlacementEndpoint, PlacementEndpoint, PlacementEndpoint, PlacementEndpoint]): boolean;
  /** Edit mode, Paste vertices: the clipboard ghost was placed on the AUTHORED mountain. `translation` is the
   *  clipboard vertex-centroid → terrain-hit delta in data space; the host appends and selects the copy. */
  onPasteVertices?(translation: V3): void;
}
