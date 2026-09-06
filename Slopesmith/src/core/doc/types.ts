import type { SkyTier } from '../sky/ring';
import type { GodRayCourse } from '../lighting/god-rays';
import type { EffectsDocument } from '../effects/document';
import type { ParticleVolume } from '../particles/volumes';
import type { AuthoredEnvironmentBed } from '../audio/environment';
import type { V3 } from '../math/vector-types';

export type { V3 } from '../math/vector-types';

/** Surface paint override for one patch cell, keyed "row,col". */
export type PaintMap = Record<string, number>;

/** Texture paint override for one patch cell, keyed "row,col" -> texture ref "<LEVEL>/<file.png>".
 *  Independent of the SurfaceType paint: SurfaceType drives physics/ride feel, this drives the
 *  patch's TexturePath (appearance). Absent cell -> the SurfaceType's procedural tile. */
export type TexPaintMap = Record<string, string>;

/** One point of a course path: a position the run passes through, plus the ribbon cross-section there.
 *  `pos` places the spine; the four profile fields describe the channel around it — a floor of `width`,
 *  quarter-pipe walls at its edges, a shoulder beyond them, and a bank rolling the whole section. `width`
 *  additionally sizes the exported start gate and bounds the AI field's wander. Nothing derives terrain from
 *  the profile continuously: Course ▸ shape run into terrain presses it into the mesh as a one-shot command
 *  (doc/run-shaping), and the mesh owns the result from there (docs/002, docs/006). */
export interface CourseKnot {
  pos: V3;
  /** Seconds this course-progress station adds to a showoff clock. Absent = an ordinary knot. This is the
   *  authored counterpart of a SOP race-line type-11 event: crossing the station, not touching a prop beside
   *  it, fires the award. A flashing checkpoint sign is therefore optional decoration and remains a prop. */
  checkpointBonus?: number;
  /** Run floor width here, metres. At knot 0 it sets the exported start gate's span. */
  width: number;
  /** Quarter-pipe wall height at each floor edge here, metres (0 = open channel). Its lateral run matches
   *  its height, so a 30 m wall is a 30 m-wide 45° berm. */
  wall: number;
  /** Bank / roll of the cross-section here, degrees. + raises the rider's right. */
  bank: number;
  /** Flat shoulder beyond the wall tops, before the blend back to the surrounding terrain, metres. */
  shoulder: number;
}

/**
 * The run: a LINE through the mountain, not a shape cut into it. It exports as the AIP racing line (which
 * the game bakes into the manifest's Paths.Course, driving respawn + the finish line), sets where the start
 * gate straddles knot 0, and seeds the test ride. The terrain's shape is the net alone, edited corner-wise
 * in Edit / Sculpt — see docs/006-surface-net.md. The profile below is the channel the run WANTS; Course ▸
 * shape run into terrain is what writes it into the net, once, on request.
 *
 * Every mountain has exactly one, because the export needs one: `migrateMountain` collapses a multi-run
 * doc to its first usable run and sweeps a fall line for a doc that carries none. Being the only one, it
 * needs no name — the exported AIPath is labelled by `level.ts`. Branching runs would be several AIP
 * `RaceLines` carrying `DistanceToFinish`, which this model doesn't express.
 */
export interface CoursePath {
  knots: CourseKnot[];
  /** Lateral falloff beyond the profile's outer edge — how many metres the shaping takes to fade back into
   *  the surrounding terrain. Wider reads as a natural bench, narrower as a cut. */
  blend: number;
  /** SurfaceType the shaping paints onto the run's floor cells. */
  surface: number;
  /** Where the field is staged, when it is not the head of the line. Absent (the ordinary case) means the
   *  head, so an untouched run behaves exactly as it always has. */
  start?: CourseAnchor;
  /** Where the race is won, when it is not the tail of the line. Absent means the tail. */
  finish?: CourseAnchor;
}

/**
 * A placed race endpoint. Retail keeps these as their own hard-coded placeholder instances
 * (`Mdl_StageArea_Start_0` / `Mdl_StageArea_Finish_0`) rather than deriving them from the path network,
 * because on a lap course neither one is an end of the line at all — Tokyo Megaplex stages its riders 343 m
 * below the top of its own lap loop. Storing a position lets a Slopesmith run say the same thing.
 *
 * Position only: the HEADING comes from the run at that point, so a dragged marker stays square to the line
 * it sits on and can't be left facing uphill.
 */
export interface CourseAnchor {
  pos: V3;
}

/** A document-wide semantic grouping used to find and edit related authored geometry. Membership lives on
 *  the labelled object (a terrain patch or placed prop) as this stable id, so renaming the display name never
 *  breaks the relationship and one object can belong to several labels. */
export interface LabelDefinition {
  /** Stable document-local identity, e.g. `label:0003`. */
  id: string;
  /** Human-facing name shown in the Edit toolbox. */
  name: string;
  /** Optional UI swatch. Geometry rendering is deliberately unaffected. */
  color?: string;
}

/**
 * Everything a mountain carries that is not its surface: identity, the one run, the base ride feel, and the
 * placed items + sun. All world-space, so the surface representation below can change under it freely.
 */
export interface MountainMeta {
  kind: 'mountain';
  name: string;
  /** The net's nominal corner pitch (detail), metres. Sizes brushes, knot widths and the export's tiling. */
  spacing: number;
  /** The mountain's one run. Guaranteed present past `migrateMountain` — the export needs it. */
  course: CoursePath;
  /** SurfaceType for unpainted cells. */
  baseSurface: number;
  /** Semantic edit groups. Patch membership is in `quadLabels`; placement membership is on each prop. */
  labels?: LabelDefinition[];
  /** Props placed on the mountain, borrowed from extracted levels (absent in docs saved before props). */
  props?: PlacedProp[];
  /** Free-standing authored lights placed by hand — coloured point / spot sources, alongside the sign lights
   *  a billboard drops automatically (absent in docs saved before free lights). */
  lights?: AuthoredLight[];
  /** Grind rails laid down by hand — a chain of points floated above the terrain, splined into a curve
   *  (absent in docs saved before rails). Exported as Splines.json for the board to ride (docs/014). */
  rails?: Rail[];
  /** Gem pickups placed by hand — collectible trick-score multipliers floated above the course, the gem
   *  half of the Tricks layer alongside the rails (absent in docs saved before gems; docs/014). */
  gems?: Gem[];
  /** Authored sun; absent => the project-authored DEFAULT_SUN. Baked into Lightmaps/ on export. */
  sun?: SunLight;
  /** The course's SUN GLARE — the beams that fan across the view when you look toward the sun (docs/049).
   *  A separate setting from `sun`: it has its own direction, because a course can light from overhead and
   *  still glare off the horizon. Absent => no glare, which is what most shipped courses do. Exported as
   *  World.json; an imported level seeds it from the one its disc shipped with. */
  glare?: GodRayCourse;
  /** The backdrop behind the mountain — a shipped level's sky taken whole, or a panorama of your own
   *  (absent => no sky; the viewport keeps its flat background and an ISO repack leaves the target level's
   *  own sky untouched). Exported as Skybox/, packed into `<stem>_sky.ssh` (docs/025). */
  skybox?: SkyboxDoc;
  /** Full-length race music chosen from this mountain's local music library. A string is the source filename; null is an
   *  explicit "no custom music" selection. Undefined preserves the old manually staged Music/track.wav
   *  workflow for documents saved before the Sound panel existed. Export normalizes the source to PCM16. */
  raceMusic?: string | null;
  /** How the selected master is mapped into the donor PathFinder slot. Missing on older saves means the
   * proven retail-graph compatibility mode; new selections default to the sequential linear-loop MVP. */
  raceMusicArrangement?: RaceMusicArrangement;
  /** Environment filler used off-board only when no intro-music stems are available. Null explicitly disables it;
   *  absent documents receive DEFAULT_ENVIRONMENT_BED. Exported as Audio/Environment.json. */
  environmentBed?: AuthoredEnvironmentBed | null;
  /** Mix for the board-ride bed the test ride performs from the shared zboard bank (docs/034).
   *  Absent => DEFAULT_BOARD_SOUND. */
  boardSound?: BoardSoundMix;
  /**
   * Uploaded WAVs claiming the engine's three hit-gated event ids, in claim order: position 0 takes event
   * 16, 1 takes 28, 2 takes 57. At most three, because the engine's interactive-class test is three literal
   * compares and nothing in the level data can extend it [Trailmap: 420-interactive-ambient].
   *
   * A claim is mountain-wide and destructive on the target level: taking event 28 also takes the course-bank
   * slot it resolves to, so every retail prop using that event on that level plays this clip instead. The
   * export refuses rather than warns when the target already places a claimed event.
   */
  hitGatedSounds?: string[];
  /** How many PASSES from the start gate to the finish this mountain is raced over; absent => DEFAULT_LAPS
   *  (one pass, the classic mount-to-finish run). Above one, a finish crossing counts the rider round again on
   *  the same clock instead of ending the run — and the lap-gated boost volume reads that same countdown, so a
   *  finish tube keeps throwing them back up the mountain until the last lap (core/doc/race). */
  laps?: number;
  /** Seconds on the SHOWOFF clock — a trick run counts this down and ends when it reaches zero, and its
   *  checkpoints add to it on the way. Absent means the mountain has never been given one, and it inherits
   *  whatever the disc slot it is packed onto carries; any authored number travels with the map instead
   *  (core/doc/race). */
  showoffSeconds?: number;
  /** Seed for the DERIVED AI opponent lines (core/doc/course `aiPathLines`) — the six gate-anchored paths
   *  AIP.json ships as `AIPaths` + `StartPosList` and the Info-mode overlay draws. Only the seed is stored,
   *  so the lines re-derive with every course edit; "regenerate" re-rolls it. Absent => DEFAULT_AI_SEED. */
  aiSeed?: number;
  /** Portable SSF effect graph. Slopesmith preserves and exports this exact P1 document; Unity and
   *  Snowknife consume the same Effects.json rather than private editor state. */
  effects?: EffectsDocument;
  /** Polygon MODELS authored with the mesh tools (definition/instance split): each is a small flat-evaluated
   *  quad mesh placed as a prop, never part of the terrain net (absent in docs saved before models). */
  models?: AuthoredModel[];
  /** Standalone PBD particle volumes (fog banks): spatial effect objects stored separately from ordinary
   *  model instances and from the SSF graph. Exported as ParticleInstances.json + ParticleModels.json. */
  particleVolumes?: ParticleVolume[];
  /** Video SCREENS — the flat rectangle on a billboard (or anywhere) a runtime can play video over.
   *  Exported as Billboards.json, the same contract `snowknife billboards` writes for an extracted course
   *  (docs/051). Absent in docs saved before screens. */
  screens?: Screen[];
}

/**
 * THE mountain document (version 5): an open terrain authored as an editable bicubic-Bezier CONTROL NET
 * (006), stored as a general quad mesh — a vertex cloud plus explicit quads and optional free edges. Vertices are patch corner
 * control points in full 3D, so the surface can fold into walls and overhangs rather than only a
 * heightfield; `edgeHandles` hold sparse tangent overrides (absent ⇒ Bessel-smooth). Being topology-general
 * it holds 3/5 poles and partial edge loops, which a rectangular lattice cannot.
 *
 * Legacy saves migrate through a rows×cols lattice (`mountain.ts` `GridNet`) and promote here with `meshFromNet`;
 * new mountains loft directly into this topology-general form. It is therefore the only document form the
 * editor, preview, bake and save file ever handle. The net derives into the SAME Bezier quilt the bake consumes
 * (`topology.ts` `quadControlPoints`), so what ships is exactly what the game boards on.
 *
 * Every keyed channel below names its geometry by array INDEX, which is a direct subscript into `vertices` or
 * `quads`. On disk they name it by stable id instead, so a topology edit that renumbers the arrays costs a
 * saved document nothing; `doc/serialize.ts` converts at both ends and is the only place either name is
 * written or read (docs/039).
 */
export interface QuadMeshDoc extends MountainMeta {
  /** The saved-document format marker — the one thing `version` has ever discriminated. */
  version: 5;
  /** Vertex positions, editor metres, xyz flat (float64); vertex INDEX `i` is at `vertices[i*3 .. +2]`. */
  vertices: number[];
  /** Stable vertex identity, index-parallel with `vertices` (docs/039, minted by `core/doc/ids.ts`): the
   *  vertex at index `i` is named `vertexIds[i]` for its whole life, across every renumbering. */
  vertexIds: string[];
  /** Quads as four corner vertex INDICES [A@(0,0), B@(0,1), C@(1,0), D@(1,1)] — the bezier/reference winding. */
  quads: number[][];
  /** Stable quad identity, index-parallel with `quads`. */
  quadIds: string[];
  /** The counter half of the next id this document mints; vertices and quads both draw from it, so no id is
   *  ever handed out twice. */
  nextId: number;
  /** Vertex and quad names this document has retired — geometry it had and no longer has (docs/039). What
   *  arrives addressed to one is discarded quietly, which is what tells a channel written before a delete
   *  from a name nobody ever minted. Absent while nothing has been deleted. */
  tombstones?: string[];
  /** Explicit control-net edges not owned by a quad. They render/select as curved cage edges and can seed lofts. */
  freeEdges?: [number, number][];
  /** Explicit T-mesh boundary nodes. `vertex` belongs to topology on one side while remaining embedded at
   *  parameter `t` of the unsplit bicubic boundary `edge` on the other; the host patch stays four-sided. */
  tJunctions?: EdgeEmbeddedTJunction[];
  /** Sparse crease overrides: directed-edge key `"${from}>${to}"`, both ends vertex INDICES, → handle offset;
   *  absent ⇒ Bessel default. Generalises the grid's `u-/u+/v-/v+` handles (both ends of an edge are distinct
   *  directed keys). The dangerous channel of the lot, because a lost key has no symptom: the edge falls back
   *  to its Bessel default and the terrain quietly changes shape. `doc/serialize.ts` is the only place the key
   *  is written or read, and it names both ends by stable id on disk (docs/039). */
  edgeHandles?: Record<string, V3>;
  /** Per-quad SurfaceType override (quad index → type); a quad absent here takes `baseSurface`. */
  quadPaint?: Record<number, number>;
  /** Per-quad real-tile override (quad index → "LEVEL/NNNN.png"). */
  quadTex?: Record<number, string>;
  /** Per-quad tile orientation (quad index → D4 rot/mirror). */
  quadOrient?: Record<number, { rot: number; mirror: boolean }>;
  /** Protected patches (quad index → true). Locking freezes the complete bicubic patch: its shared corners,
   *  boundary controls and interior controls cannot be moved by sculpt or Edit transforms. Sparse by design;
   *  an absent entry is unlocked. Serialized by stable quad id like the other per-patch channels. */
  quadLocked?: Record<number, true>;
  /** Per-quad interior twist: offsets added to the four interior control points (cp5@A, cp6@B, cp9@C,
   *  cp10@D) AFTER the zero-twist (Ferguson) construction, editor-space metres, order [A,B,C,D]. Absent
   *  (or an absent corner ⇒ zero) leaves the pure ruled interior today's output derives. Sculpts the
   *  sub-cell relief (moguls, saddles) the reference carries in its interior CPs — the fidelity the
   *  boundary handles can't reach (docs/020). Stored per quad so it splits/remaps with the patch. */
  quadTwist?: Record<number, [V3, V3, V3, V3]>;
  /** Semantic label memberships for terrain patches (quad index → label ids). Serialized by stable quad id,
   *  and remapped/inherited by the shared topology-operation contract like paint and texture channels. */
  quadLabels?: Record<number, string[]>;
  /** Evaluation mode of an authored MODEL's materialized edit doc: every edge handle derives as chord/3
   *  and the stored curvature channels (edgeHandles / quadTwist) are ignored, so the bicubic quilt
   *  degree-elevates each flat quad EXACTLY — the surface is the polygons. Never set on a mountain. */
  linearCage?: boolean;
}

export interface EdgeEmbeddedTJunction {
  vertex: number;
  edge: [number, number];
  /** Parameter along the directed `edge`, strictly inside (0,1). */
  t: number;
}

/**
 * A polygon MODEL authored with the mesh tools: a small quad mesh stored WORLD-SPACE at the spot it was
 * built (its workshop location), evaluated FLAT — the cage is always the degenerate linear one, derived,
 * never stored, so the surface is exactly the polygons (`linearCage` on the materialized edit doc). No
 * curvature channels exist on a model by design. `anchor` is the placement reference point: an instance
 * placed at pos P renders vertex v at pose(v − anchor). Placements are ordinary props referencing `id`,
 * so effects, export and the viewport treat a model instance exactly like a borrowed reference prop.
 *
 * The mesh keeps its indices, unlike the mountain's (docs/039). `id` is the model's whole identity: nothing
 * addresses a vertex or a quad inside one, because a model carries no id-keyed channel to address them from
 * — no `edgeHandles`, no per-quad paint or twist, one uniform `texture` — and `modelEditDocFor` /
 * `commitModelEditDoc` re-derive the edit doc's numbering on every session. So the numbering is legitimately
 * ephemeral, the same reasoning that leaves the reference mesh on indices, and stable ids here would be
 * ceremony. It follows that a model is one whole-object register: the unit of concurrency is the record.
 */
export interface AuthoredModel {
  /** Stable "model:NNNN" id — placements (and future channels) join on it, surviving reorder/delete. */
  id: string;
  name: string;
  /** Placement reference point, world metres — set from the first authored geometry. */
  anchor: V3;
  /** Vertex positions, world metres, xyz flat — the same encoding as the mountain net. */
  vertices: number[];
  /** Quads as four corner vertex indices [A, B, C, D] — the bezier/reference winding. */
  quads: number[][];
  /** Protected polygon patches while this model is edited. Models keep index topology, so these keys are the
   *  model's own quad indices and are remapped by the shared mesh-operation contract. */
  quadLocked?: Record<number, true>;
  freeEdges?: [number, number][];
  tJunctions?: EdgeEmbeddedTJunction[];
  /** The model's tile ("LEVEL/NNNN.png", the terrain quadTex convention). Every quad wears the FULL tile
   *  0–1 — continuous under RepeatWrapping, which is what a UV-scroll material requires (docs/008: scroll
   *  can never cross an inset or atlas seam). Absent = untextured clay. Per-quad painting can layer on later. */
  texture?: string;
  /** The D4 the tile is worn at — quarter turns plus a mirror, the same `{ rot, mirror }` shape a painted
   *  terrain quad stores. ONE state for the whole model rather than one per quad, because a tiled prop's
   *  mapping is COMPUTED: turning is how the prop wears its art, and a prop whose quads each carried their
   *  own would be storing a UV layout, which is exactly what makes a prop textured instead
   *  (core/props/kind.ts). Absent = upright and unmirrored, which is every model authored before this. */
  orient?: { rot: number; mirror: boolean };
  /** Render the model through the native alpha pass, using the texture's partial alpha instead of treating
   *  it as an opaque/cutout tile. Kept on the authored material rather than inferred from pixels so export
   *  preserves the same explicit appearance bit the retail material table uses. */
  blend?: boolean;
  /** The tile's flipbook STATE list, in the same ref form, with `frames[0] === texture` — the invariant every
   *  shipped native flipbook material holds. Absent (or under two entries) = a still image. Only the list is
   *  authored here: what plays it, if anything, is an effect attached to a placement, not a property of the
   *  art ([Trailmap: 410-texture-animation]). */
  frames?: string[];
  /** Bake a collider for placements on export (like solid rails); absent = ghost geometry. */
  solid?: boolean;
}

/**
 * A free-standing light the user places on the course (docs/013) — a coloured point or spot, edited by hand
 * (colour / intensity / reach / cone). Stored in editor/data space (m, Y-up) like `corners` + `PlacedProp.pos`,
 * so it moves with undo / persist. On export it becomes a PBD light in `Lights.json` and its glow bakes into
 * the terrain lightmap, the same path the billboard sign lights take.
 */
export interface AuthoredLight {
  /** Stable authoring identity. Everything that names one light — a register, a selection — names this rather
   *  than the light's mutable array index. Migration fills it for documents saved before lights carried one. */
  id?: string;
  /** Point (omni) or spot (a cone along `dir`). */
  kind: 'point' | 'spot';
  /** Position in editor/data space (m, Y-up). */
  pos: V3;
  /** Spot aim (unit, editor space); ignored for a point. Absent => straight down. */
  dir?: V3;
  /** Colour, hex "#rrggbb". */
  color: string;
  /** Peak intensity (HDR; 1 = a plain light, higher for a bright one). */
  intensity: number;
  /** Reach in metres — sizes the falloff and the exported influence box. */
  reach: number;
  /** Spot cone half-angle in degrees (ignored for a point). Absent => 35°. */
  cone?: number;
  /** Optional label for the outliner / tooltip. */
  name?: string;
  /** Glow-sprite resolution class (16 / 32 / 64) making this light draw the game's runtime GLINT — the halo,
   *  core and twinkle star a lamp or flare sparkles with (docs/047). Absent / 0 = no glint. Exported verbatim
   *  as the light record's `SpriteRes`, which is the engine's own gate. */
  glint?: number;
}

/**
 * An authored course spline (docs/014/026): either a grind rail or an invisible motion path. Both are chains
 * of node points floated above the terrain and splined into a smooth curve (the same Catmull-Rom the run spine
 * uses). Nodes are stored in
 * editor/data space (m, Y-up) — the frame `corners` use — with the ground standoff baked into each node's Y,
 * so they move with undo / persist and each node can be dragged to follow a slope. On export the curve becomes
 * a chain of cubic-Bézier segments in `Splines.json`; grind kinds enter the ridable network, while motion kinds
 * remain animation-only effect routes.
 */
export interface Rail {
  /** Purpose of this spline. Absent means `grind` for documents saved before motion-path authoring. */
  kind?: 'grind' | 'motion';
  /** Stable authoring identity. Effects use this instead of the rail's mutable array index when a prop follows
   *  the curve as a spline mover. Migration fills it for documents saved before effect-path authoring. */
  id?: string;
  /** Node points in editor/data space (m, Y-up), floated `height` above the ground they were laid on. */
  nodes: V3[];
  /** Standoff (m) the rail was laid at above the terrain — the placement offset + the Tools height baseline. */
  height: number;
  /** Grind-only SSX SplineStyle: 13 = metal (default), 12 = wood, 5 = ice. Motion paths export style -1. */
  style?: number;
  /** Grind-only: ship the curve OUT of the rail network and let a `Rail on / off` effect put it in
   *  [Trailmap: 140-rail-toggle]. Candidacy has no authored flag of its own on disc — retail's enable-after-event
   *  rails (MESA's fallen trunk) are authored at the non-grind SplineStyle 1 and the toggle is what makes them
   *  findable — so this exports as that style instead of its selected material. The TUBE is unaffected: the rail is drawn,
   *  baked and solid exactly as authored, because the toggle switches catchability and never visibility. */
  startsOff?: boolean;
  /** Grind-only: ship the curve WITHOUT a tube of its own. On disc the grind and its pipe are two unrelated
   *  records that merely share the space — the spline is what the rail query finds, and the tube beside it is
   *  an ordinary prop instance (docs/014) — so a rail can perfectly well be the spline alone, laid over
   *  scenery that already has the shape: a fallen trunk, a handrail model, the lip of a roof. That is how
   *  retail's rails are built, and it is what the Effects-mode **Add rail spline** tool draws. Default off =
   *  the tube is previewed and baked, which is what **Add rail pipe** makes. */
  bare?: boolean;
  /** Solid tube: the baked tube ships as a collidable prop (riders bump it; the grind itself is unaffected —
   *  some reference tubes ship solid). Default off = ghost tube, the reference default configuration. */
  solid?: boolean;
  /** Bake a support post under each node point, from the tube down through the authored standoff into the
   *  ground. Posts are always solid, like the shipped levels' rail supports. */
  supports?: boolean;
  /** Optional label for the outliner / tooltip. */
  name?: string;
}

/**
 * A gem pickup placed on the course (docs/014) — the collectible half of the Tricks layer. Gems are the
 * trick-score multipliers a rider strings together over rails and kickers. Stored in editor/data space
 * (m, Y-up) — the frame `corners` use — with the ground standoff baked into `pos.y`, so a gem moves with
 * undo / persist and can be dragged. On export a gem becomes a collectible instance (the gem model + its
 * SSF pickup marking); the export side is authored separately from placement.
 */
export interface Gem {
  /** Stable authoring identity. Everything that names one gem — a register, a selection — names this rather
   *  than the gem's mutable array index. Migration fills it for documents saved before gems carried one. */
  id?: string;
  /** Position in editor/data space (m, Y-up), floated above the ground it was placed on. */
  pos: V3;
  /** Score-multiplier tier (absent => 1). Higher-value gems are worth more on pickup. */
  value?: number;
}

/**
 * A video SCREEN: the flat rectangle a runtime lays a video over (docs/051).
 *
 * A screen is a rectangle, not geometry. Nothing about it ships in the mountain's mesh — the export writes it
 * to `Billboards.json`, the same contract `snowknife billboards` measures off an extracted course's boards, and
 * a runtime that supports video (Unity/VRChat) builds its own quad flush over it.
 *
 * Two kinds, told apart by `prop`. A screen ATTACHED to a placement is stored in that prop's own frame, so it
 * rides the board when the board is moved, turned or resized — which is what makes "mark this billboard as a
 * screen" hold up through ordinary editing. A FREE-STANDING screen (no `prop`) is stored in editor space and
 * is the author's to place anywhere: a wall, a cliff, the inside of a tunnel.
 */
export interface Screen {
  /** Stable authoring identity — what a register, a selection or an edit in flight names. */
  id?: string;
  /** Author's label; also the exported screen name. Absent => derived from the id. */
  name?: string;
  /** The placement this screen is fitted to (`PlacedProp.id`). Absent => free-standing. A screen whose prop
   *  is deleted is deleted with it, since the board it named is gone. */
  prop?: string;
  /** Centre. Editor metres, in the prop's own frame when `prop` is set, else in world/data space. */
  pos: V3;
  /** Facing, composed exactly as a placement's is (`core/props/pose.ts`, YXZ): `yaw` turns the screen about
   *  up, `pitch` tilts it. Relative to the prop's own rotation for an attached screen. */
  yaw: number;
  pitch?: number;
  /** Screen size in metres (prop scale applies on top for an attached screen, like the geometry it covers). */
  width: number;
  height: number;
}

/**
 * Complete collision profile for an authored placement [Trailmap: 130-collision-data]. New placements receive
 * inferred defaults, but every field remains independently editable and packs unchanged. This is also the exact
 * profile used by the generated collision lab; the lab is a preset/test suite rather than a separate capability.
 *
 * Mode 3 cannot be synthesized from an arbitrary mesh yet. `physicsSource` therefore names a body already
 * present in an extracted level. An ISO export may reuse it only when that level is also the repack target;
 * Slopesmith Test can preview it as soon as the source level's prop payload is loaded.
 */
export interface NativeCollisionProfile {
  /** ObjectProperties.CollsionMode [Trailmap: 130-collision-data]: 0 none, 1 triangle proxy, 2 instance AABB, 3 sphere-tree body. */
  mode: 0 | 1 | 2 | 3;
  /** Exact PlayerCollision gate, independent of visibility and mode. */
  playerCollision: boolean;
  /** Collision response mass (`ObjectProperties.U0` on disc). Exact zero is pass-through; nonzero admits response. */
  responseMass: number;
  /** Exact PlayerBounce flag. */
  playerBounce: boolean;
  /** PlayerBounceAmmount, retained even while the flag is off so A/B tests can toggle only the gate. */
  bounceAmount: number;
  /** Optional native sphere-tree shape/inertia donor [Trailmap: 130-collision-data]. Required for a usable mode-3 lab fixture and for
   *  Roller to move a custom prop in a PS2 ISO. The donor must belong to the repack target level. */
  physicsSource?: { level: string; body: number; instance?: number };
}

/**
 * A prop borrowed from an extracted level and placed on the authored mountain. The model geometry is the
 * source level's `Models[model]` (loaded via /api/props); only the placement is authored here. Stored in
 * editor/data space (metres, Y-up) — the same frame as `corners` — so it moves with undo/persist like the
 * rest of the doc. On export the model's meshes are baked into Props.obj at this pose (docs/012).
 */
export interface PlacedProp {
  /** Stable authoring identity. Migration adds it to older saves so an effect attachment cannot be retargeted
   *  by deleting or reordering a different prop. */
  id?: string;
  /** Semantic document label ids. Membership belongs to this placement, not the borrowed/model definition. */
  labels?: string[];
  /** Source level the model comes from. */
  level: string;
  /** ModelID within that level's Models[]. */
  model: number;
  /** ModelName — for the outliner / tooltip. */
  name: string;
  /** Which native event layer owns this placement. Absent means the common layer shown in every mode;
   *  `showoff` exports through LTG GemIndex (state 2) and is absent in Race and Freeride. This deliberately
   *  does not expose raw LTG state 1: its general-purpose runtime semantics have not been validated. */
  modePresence?: 'showoff';
  /** Position in editor/data space (m, Y-up), the frame `corners` use. */
  pos: V3;
  /** Yaw about vertical, degrees (hand placement seats models upright, then turns them). */
  yaw: number;
  /** Pitch about the placement's own X axis, degrees. Absent = 0. */
  pitch?: number;
  /** Roll about the placement's own Z axis, degrees. Absent = 0.
   *
   *  With `yaw` these compose YXZ — `Ry(yaw) · Rx(pitch) · Rz(roll)`, resolved by core/props/pose.ts, which
   *  every poser reads rather than re-deriving. Both are optional so an upright placement (every placement a
   *  hand drop makes, and every one saved before tilt existed) stores and renders exactly as it always did. */
  roll?: number;
  /** Uniform scale multiplier. */
  scale: number;
  /** Effects-authored invisible trigger volume. The placement position is the box centre; `size` is its
   *  per-axis extent in editor metres. It remains a placed prop so the existing stable-ID attachment join
   *  can compile its collision graph onto the packed native instance. */
  effectTrigger?: { size: V3 };
  /** Exact editable collision profile. Absent only in legacy documents, where the old Solid/effect rules are
   *  inferred until the first collision edit materializes this record. */
  nativeCollision?: NativeCollisionProfile;
  /** Group-def id when this placement is a GROUP (docs/015): `model` is the leader; the sibling member
   *  models and the group's lights DERIVE from the def (mined per level via /api/groups) at render /
   *  export time, so they follow the one placement. Absent = a plain single prop. */
  group?: string;
  /** ADL collision-sound EVENT id (`Sounds.CollisonSound`) played as a positional one-shot when the rider
   *  hits the prop [Trailmap: 420-audio-runtime]. An event id, not a bank slot — resolved through
   *  core/effects/collision-sound.ts against the prop's source-level course bank. Absent = silent. */
  collisionSound?: number;
  /** Authored hit sound: a WAV name in this mountain's local sound library (from /api/sound-upload). Takes precedence over
   *  `collisionSound`. The export allocates it an event id from the reserved pool and the ISO repacker
   *  encodes the WAV into that id's course-bank slot (collision-sound.ts CUSTOM_SOUND_EVENT_POOL). */
  collisionSoundFile?: string;
  /** Looping positional ambience carried by this placement (`Sounds.ExternalSounds`). The value is the same
   *  global sound-event id used by collision sounds; `ambientRadius` is authored in metres. */
  ambientSound?: number;
  /** Uploaded WAV used instead of `ambientSound`. It shares the repacker's reserved event/slot pool with
   *  custom hit sounds and is also staged directly for Unity imports. */
  ambientSoundFile?: string;
  /** Audible radius for the positional ambient loop, metres. Default 80 m when a loop is assigned. Ignored
   *  when `ambientHalfExtents` makes the region an ellipsoid. */
  ambientRadius?: number;
  /** Falloff curve selector 0..5 over normalized distance inside the region; absent = 2 (linear), which is
   *  what the retail crowd emitters use [Trailmap: 420-audio-runtime]. */
  ambientFalloff?: number;
  /** Present = the ambient region is an axis-aligned ELLIPSOID with these half-extents in editor metres,
   *  rather than the `ambientRadius` sphere. Editor axes; the export reorders them to native. */
  ambientHalfExtents?: V3;
  /** Legacy pre-profile Solid preference. New documents materialize `nativeCollision`; this remains readable so
   *  older maps preserve their established inferred result [Trailmap: 130-collision-data, 150-logic]. */
  solid?: boolean;
  /** SELF-LIT: the surface emits rather than receives, so it ships at full texture brightness and the sun
   *  never touches it — sign faces, LCD screens, jumbotrons, lamp heads, lit building facades.
   *
   *  This is retail's own convention, and the data says it is a FLAG rather than a value: a full-bright
   *  instance carries no key at all and an `AmbentLightColour` of exactly 256 — min and max both 256 across
   *  every one of GARI's 112 and MERQUER's 544, with zero spread. On the ×128 law that is an ambient of
   *  exactly 2.0, twice the half-bright constant. 3–12% of a shipped level's props are authored this way
   *  (MERQUER, the night city, is the 12%), so without it an authored billboard face or sign gets shaded
   *  like snow and reads dull beside a retail one in the same scene (docs/032 · lighting). */
  fullBright?: boolean;
  /** Legacy pre-profile restitution. New placements store this as `nativeCollision.bounceAmount`; retained for
   *  older documents and migrated when their collision settings are first edited. */
  bounce?: number;
  /** Rideable SurfaceType for a solid placement ([Trailmap: 120-objects]): riding ON the prop takes that
   *  terrain family's ride feel and board audio (12 wood, 13 metal, … — surface-types.ts). Absent = -1
   *  (object handling — the prop is an obstacle, not a surface). */
  surface?: number;
}

export type RaceMusicMode = 'retail-graph' | 'linear-loop';

export interface RaceMusicArrangement {
  mode: RaceMusicMode;
  /** Written to the selected MUSIC.INF song record; currently descriptive because donor slots retain length. */
  bpm: number;
  /** Seconds from the source start. Playback reaches loopEnd once, then returns here. */
  loopStartSeconds: number;
  /** Zero means source end. */
  loopEndSeconds: number;
}

/** The authored mix over the board-ride bed — the glide and carve loops the test ride performs from the
 *  shared zboard bank, plus its transients (docs/034). Every field is a 0..1 trim; the layer levels are
 *  driven by the ride itself [Trailmap: 420-audio-runtime], so these set the balance, not the loudness curve. */
export interface BoardSoundMix {
  /** Perform the bed at all during a test ride. */
  enabled: boolean;
  /** Master trim over every board layer. */
  volume: number;
  /** The glide layer — the slide, riding speed. */
  glide: number;
  /** The carve layer — the edge bite, riding lean and sideways slip. */
  carve: number;
  /** Board transients from the same bank: the ollie pop, the landing thud, the rail grind. */
  transients: number;
  /** The MAIN-bank game-event cues engine code plays on the gameplay path — gem chime, boost/trick pad, and
   *  the held-boost roar [Trailmap: 390-pickups-and-race]. */
  cues: number;
}

/** The authored directional sun the editor previews and the export bakes into lightmaps (008). */
export interface SunLight {
  /** Viewport preview toggle: shades (or un-shades) the editor's terrain. Export ignores it — the
   *  lighting bake is the export dialog's own setting. */
  on: boolean;
  /** Sun position: elevation above horizon and azimuth, degrees. */
  el: number;
  az: number;
  /** Sky fill (constant floor) and direct-sun strengths. */
  ambient: number;
  sun: number;
  /** How strongly baked cast shadow / ambient occlusion darken (0..1). */
  shadow: number;
  ao: number;
  /** Sun and sky colours, hex "#rrggbb" (sky tints the shadows). Drive the coloured pass. */
  sunTint: string;
  skyTint: string;
  /** Multiplier the LIGHTMAP BAKE applies to the sun term — and ONLY the bake; the exported Lights.json
   *  keeps the raw `sun`. Absent => 1. An HDR sun (the true dynamic-object light — retail records ship
   *  2.47) bakes at the LDR ceiling: a record seed and the sun slider both hold it at 1/max(1, sun), so
   *  above the rail the sun only heats the rider. */
  bakeExposure?: number;
  /** Constant ambient (sky-fill) floor the LIGHTMAP BAKE uses instead of the raw `ambient` — the
   *  lightmap-effective ambient (~0.3, the shadow depth) vs a hot rider-fill `ambient` (~0.68). Absent =>
   *  `ambient` (coupled). Set by a record seed (the study's fit) or the sun panel's "bake ambient" slider;
   *  bake-only, the exported Lights.json keeps the raw `ambient`. */
  bakeAmbient?: number;
}

/** Project-authored default sun: high warm daylight with a cool sky fill, on. Matches the editor.
 *  sun = 1.0 so a fully sun-facing, unshadowed slope bakes to the LDR ceiling: the terrain lightmap stores
 *  A_S (intensity) where 255 = the full-bright base texture, so lit snow must reach it to read WHITE in-engine
 *  (a lower sun caps the brightest slope below full and the terrain renders grey). The slider still dims it. */
export const DEFAULT_SUN: SunLight = {
  on: true, el: 52, az: 210, ambient: 0.28, sun: 1.0, shadow: 0.42, ao: 0.32, sunTint: '#fff2dc', skyTint: '#b8daf2', bakeExposure: 1,
};

/**
 * The authored sky (docs/025). SSX draws its backdrop as an open-topped cylinder of 25 textured panels
 * (core/sky/ring) — so a sky is really just a horizon panorama, and swapping one is swapping its texture
 * bank. Two sources, and the difference matters at pack time:
 *
 *   level   a shipped level's sky, taken whole. The ISO repack lifts that level's `_sky.pbd` + `_sky.ssh`
 *           out of its own archive VERBATIM — no decode, no re-encode, no VRAM change. The ring geometry is
 *           byte-identical on every level that ships one, so any sky drops into any slot.
 *   custom  a panorama you loaded (kept in the mountain's `assets/skies/<name>.png`). It is cut into 25 pages against
 *           the ring named by `ring` and encoded as a fresh `_sky.ssh`; the target's `_sky.pbd` still
 *           supplies the geometry.
 */
export interface SkyboxDoc {
  source:
    | { kind: 'level'; level: string }
    | { kind: 'custom'; name: string };
  /**
   * The level whose ring a CUSTOM sky was composed against: the export copies that ring's meshes + materials
   * into `Skybox/` and slices the panorama on its real azimuth spans, so the seams land on the geometry that
   * draws them. Every shipped ring is the same hand-built, irregular 32-gon, so the choice is normally
   * cosmetic — but it belongs on the document, because it decides which extraction the pages are cut from and
   * therefore whether the same sky exports the same bytes twice. A `level` sky brings its own ring and ignores
   * this. Absent => the export takes the first level that ships one.
   */
  ring?: string;
  /** Legacy preview flag kept for document compatibility. Preview selection is now editor-session state. */
  on: boolean;
  /**
   * Flat colour above the ring, hex "#rrggbb". The editor and Unity render it directly; ISO packing writes it
   * into the target course's executable override entry. Absent => the mean of the panorama's top row.
   */
  topColor?: string;
  /** Texture budget for a CUSTOM sky's 25 pages (ignored by a `map` sky, which ships its own). Absent =>
   *  'standard'. See SKY_TIERS: 'high' is the day courses' resolution but costs ~4× GARI's sky in VRAM and
   *  per-frame upload once re-encoded to 32-bit, which is unproven on hardware. */
  tier?: SkyTier;
}

/** SSX surface types the UI exposes (subset of the spec's 0-18; any int is accepted in paint). */
export const SURFACE_TYPES: Record<number, string> = {
  0: 'reset (OOB)',
  1: 'snow',
  2: 'off-track',
  3: 'powder',
  4: 'slow powder',
  5: 'ice',
  9: 'rock / off track',
  10: 'wall',
  15: 'standard',
  17: 'no collision',
  18: 'show-off ramp',
};

/** The ride feel every painted tile carries by default (snow) — a tile's SurfaceType is never unset. */
export const DEFAULT_SURFACE = 1;

/**
 * Preview tint + exported texture for EVERY surface type the game ships, not only the paintable subset above
 * — the full legend and its board-audio families live in `core/reference/surface-types.ts`
 * [Trailmap: 310-surface-response].
 *
 * Completeness is the contract. `surfaceStyle` falls back to snow, so a missing row does not read as "no idea"
 * but as a confident, wrong "this is snow": MEGAPLE's metal (13) bumper bases and its 102 metal patches wore
 * the snow swatch in the Surface view, which is indistinguishable from stating nothing. Types 6-16 arrive only
 * from extracted levels and from a rideable prop's SurfaceType, and they still have to state themselves.
 *
 * Exported art comes from the six generated ground textures (`core/paint/ground-textures.ts`), so a family
 * with no picture of its own borrows the nearest one.
 */
export const SURFACE_STYLE: Record<number, { color: V3; tex: string }> = {
  0: { color: [0.88, 0.28, 0.30], tex: 'oob.png' },      // reset (OOB) — red
  1: { color: [0.96, 0.97, 0.99], tex: 'snow.png' },     // snow — white anchor
  2: { color: [0.64, 0.66, 0.68], tex: 'offtrack.png' }, // off-track — grey
  3: { color: [0.52, 0.82, 0.55], tex: 'powder.png' },   // powder — green (the main ridable)
  4: { color: [0.93, 0.82, 0.42], tex: 'powder.png' },   // slow powder — amber (warm = sticky)
  5: { color: [0.40, 0.82, 0.95], tex: 'ice.png' },      // ice — cyan (slippery)
  6: { color: [0.26, 0.14, 0.46], tex: 'rock.png' },     // bounce / unskiable — violet (a barrier, like wall)
  7: { color: [0.05, 0.21, 0.34], tex: 'ice.png' },      // ice / water no trail — deep water blue
  8: { color: [0.35, 0.79, 0.58], tex: 'snow.png' },     // glidy snow particles — mint (a snow that runs)
  9: { color: [0.60, 0.44, 0.33], tex: 'rock.png' },     // rock — brown
  10: { color: [0.42, 0.45, 0.53], tex: 'rock.png' },    // wall — steel slate
  11: { color: [0.39, 0.62, 0.67], tex: 'ice.png' },     // ice crunch no trail — pale ice grey
  12: { color: [0.46, 0.19, 0.04], tex: 'rock.png' },    // wood — saturated warm brown against rock's pale tan
  13: { color: [0.21, 0.45, 0.68], tex: 'rock.png' },    // off-track metal — steel blue
  14: { color: [0.60, 0.74, 0.05], tex: 'ice.png' },     // speed / grinding — chartreuse (fast)
  15: { color: [0.86, 0.85, 0.82], tex: 'snow.png' },    // standard — warm grey
  16: { color: [0.67, 0.48, 0.19], tex: 'offtrack.png' },// sand — khaki
  17: { color: [0.86, 0.42, 0.85], tex: 'offtrack.png' },// no collision — magenta
  18: { color: [1.00, 0.55, 0.15], tex: 'rock.png' },    // show-off ramp — orange
  19: { color: [0.38, 0.30, 0.38], tex: 'rock.png' },    // unknown (chute audio) — plum grey
};

/** Snow answers for an out-of-table integer only: paint accepts any int, and so does an extracted level. */
export function surfaceStyle(t: number) {
  return SURFACE_STYLE[t] ?? SURFACE_STYLE[1];
}
