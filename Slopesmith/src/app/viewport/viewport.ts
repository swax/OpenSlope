import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { MeshBVH } from 'three-mesh-bvh';
import { type QuadMeshDoc, type PlacedProp, type AuthoredLight, type Rail, type Gem, type Screen, type V3 } from '../../core/doc/types';
import { meshAdjacency, meshCageEdges, meshFromDoc, quadControlPoints, docEdgeHandles, INTERIOR_CP, type MeshAdjacency, type EdgeHandle } from '../../core/mesh/topology';
import { meshEdgeSegments } from '../../core/mesh/selection';
import { findTJunctions } from '../../core/mesh/t-junctions';
import { findEdgeCrossings } from '../../core/mesh/edge-crossings';
import { findCoincidentVertices } from '../../core/mesh/coincident-vertices';
import { ekey } from '../../core/mesh/ops';
import type { SelectionMeasure } from '../../core/mesh/measure';
import { docPositions, type EditDoc } from '../../core/doc/doc-edit';
import type { MeshVertexClipboard } from '../../core/mesh/clipboard';
import type { MeshControlPoint, MeshControlPointId } from '../../core/mesh/control-points';
import { DEFAULT_XR_RENDER_SCALE, type XrEyeBufferMeasurement, type XrLayerMode } from '../ride/xr/config';
import type { EquipmentAppearance, RideGear, SnowboardStance } from '../ride/gear';
import { stepCharacterGlow } from '../ride/character-glow';
import { edgeIndices, quadIndices, vertexIndex } from '../state/mesh-names';
import {
  buildMountainPreview, buildMountainPreviewProgressive, previewMatchesTopology, previewMismatch,
  refreshPreviewPatches, PATCH_VERTS, type PreviewData,
} from '../../core/mesh/tessellation';
import { patchDependency, patchVertexSpans, type NetChange } from '../../core/mesh/incremental';
import { aiLineRatings, aiPathLines, courseCenters, DEFAULT_AI_SEED, finishFrame } from '../../core/doc/course';
import { DEFAULT_LAPS, DEFAULT_RACE_MODE, DEFAULT_SHOWOFF_SECONDS, type RaceMode } from '../../core/doc/race';
import { normalizeBoardSound } from '../../core/audio/board-sound';
import { normalizeRaceMusicArrangement } from '../../core/music/arrangement';
import { preloadBoardAudio } from '../ride/board-audio';
import {
  preloadAuthoredRideMusic, preloadReferenceRideMusic, rideMusicPlaybackEnabled,
} from '../audio/ride-music';
import { setGameAudioVolume } from '../audio/runtime';
import { sampleSpine } from '../../core/math/spine';
import type { TexRef } from '../../core/paint/textures';
import type { ReferenceMesh, RefAiPath, RefCourseAnchors, RefSplineRaw } from '../../core/reference/terrain';
import type { LevelProps, PropModelClip } from '../../core/reference/props';
import type { AmbientSoundSource } from './scene/ambient-sound';
import { normalizeEnvironmentBed } from '../../core/audio/environment';
import { authoredOwnerKey, referenceOwnerKey } from './scene/prop-sound';
import {
  authoredAmbientEvent, authoredAmbientRecord, AUTHORED_AMBIENT_DEFAULT_M,
} from '../../core/effects/external-sound';
import type { LightRig } from '../../core/reference/lights';
import type { PlacedLight } from '../../core/lighting/sign-lights';
import { propPreviewIntensity } from '../../core/lighting/prop-lights';
import { lightToWorkingSpace } from '../../core/lighting/color-space';
import type { GroupDef } from '../../core/reference/groups';
import {
  referenceEffectInstanceIndices, referenceSplineOriginalIndex, type ReferenceEffectsData,
} from '../../core/reference/effects';
import type { EffectNode, EffectsDocument } from '../../core/effects/document';
import { authoredMotionPathIdFromSpline } from '../../core/effects/authoring';
import { nativeSplineFields, railBezierSegments } from '../../core/rails/rails';
import type { ParticleVolume } from '../../core/particles/volumes';
import { runDiagnosticPhase, runDiagnosticPhaseAsync } from '../net/diagnostics';
import type { SharedCameraView } from '../../core/session/screen-share';
import { nearestSkyWorld, type SkyPreviewTarget } from '../sky/preview';

import { type GizmoFrame, type GizmoMode, type MeshSelectionState, type Mode, type RotationSnapStep, type ShadeMode, type SnapStep, type ViewState, type PickResult, type ViewportCallbacks } from './types';
export type { GizmoFrame, GizmoMode, MeshSelectionState, Mode, RotationSnapStep, ShadeMode, SnapStep, ViewState, PickResult, ViewportCallbacks, MeshControlPointId };
import { TOUCH_NONE, REF_LOAD_OFFSET_X, CAGE_EDGE_SEG, CAGE_INTERIOR_COLOR, CAGE_BOUNDARY_COLOR, LOOP_RENDER_ORDER, LIVE_EDIT_FILL_COLOR, LIVE_EDIT_FILL_OPACITY, CTRL_CAGE_COLOR, SURFACE_POLY_OFFSET } from './constants';
import { Stage, type GizmoKind } from './stage';
import { createRailsLayer, type RailsLayer } from './scene/rails';
import { createCourseMarkersLayer, ANCHOR_HANDLE_LIFT, type CourseMarkersLayer } from './scene/course-markers';
import { createPeersLayer, type PeerMarks, type PeersLayer } from './scene/peers';
import {
  createRemotePlayersLayer, type ActiveMapPlayer, type RemotePlayersLayer,
} from './scene/remote-players';
import { createAiPathsLayer, type AiPathsLayer } from './scene/ai-paths';
import { createEdgeLayer, type CreateEdgeLayer } from './tools/create-edge';
import { createGemsLayer, type GemsLayer } from './scene/gems';
import { createScreensLayer, type ScreenDraw, type ScreensLayer } from './scene/screens';
import { createLightsLayer, type LightsLayer } from './scene/lights';
import { createGlintLayer, type GlintLayer } from './scene/glints';
import { createGodRayLayer, type GodRayLayer } from './scene/god-rays';
import { sceneDirFromGlareAzEl, type GodRayCourse } from '../../core/lighting/god-rays';
import { createSky, type SkyLayer, type SkyView } from './scene/sky';
import { createSnowfallLayer, type SnowfallLayer } from './scene/snowfall';
import {
  createRangeCull, DEFAULT_DRAW_DISTANCE, drawDistanceMetres, type DrawDistance, type RangeCull,
} from './scene/range-cull';
import { createPropAssets } from './scene/prop-assets';
import { setCutoutAlphaToCoverage } from '../props/texture-alpha';
import { createPropsLayer, type PropsLayer } from './scene/props';
import { createSurgeryLayer, type SurgeryLayer } from './tools/surgery';
import { createCageLayer, type CageLayer } from './mesh/cage';
import { createMeshPicking, type MeshPicking } from './input/mesh-picking';
import { createScenePicking, type ScenePicking } from './input/scene-picking';
import { createSelectionLayer, type SelectionLayer } from './mesh/selection';
import { createPaintLayer, type PaintLayer } from './mesh/paint';
import { createCameraController, type CameraController } from './camera/controller';
import { createRideLayer, type RideLayer } from './scene/ride';
import { createTileMaterials, type TileArrayBank, type TileMaterials } from './mesh/tile-materials';
import {
  buildPatchSliceAttribute, buildReferenceBatchLayout, mergeReferenceBatchGroups, type ReferenceBatchChunk,
} from './mesh/reference-batching';
import { createTerrainLayer, type TerrainLayer, type TerrainLightOptions } from './mesh/terrain';
import { rideTree, type TreeGeometry } from './mesh/surface-trees';
import { clearGlyphGroup, addCageLines } from './shared/overlays';
import { createLegends, type Legends } from './shared/legends';
import { createReferenceDecor, type ReferenceDecor } from './scene/reference-decor';
import {
  createReferenceEffectsLayer, type ReferenceEffectsLayer, type ReferenceSplineMotionInfo,
  type SplineMotionCommand,
} from './scene/reference-effects';
import { createParticleVolumesLayer, type ParticleVolumesLayer } from './scene/particle-volumes';
import { createTransformLayer, type TransformLayer } from './gizmo/transform';
import { createViewGridLayer, type ViewGridLayer } from './camera/view-grid';
import { createLoftPreviewLayer, type LoftPreviewLayer } from './tools/loft-preview';
import { createClipboardPlacementLayer, type ClipboardPlacementLayer } from './tools/clipboard-placement';
import { createEdgeExtrusionLayer, type EdgeExtrusionLayer } from './tools/edge-extrusion';
import { createWeldToolLayer, type WeldToolLayer } from './tools/weld';
import { createGizmoReadout, type GizmoReadout } from './gizmo/readout';
import { createBridgePreviewLayer, type BridgePreviewLayer } from './tools/bridge-preview';
import { createPatchToolLayer, type PatchToolLayer } from './tools/create-patch';
import { createTubeToolLayer, type TubeToolLayer } from './tools/create-tube';
import { createTrailToolLayer, type TrailToolLayer } from './tools/create-trail';
import { createPointerRouter, type PointerRouter } from './input/pointer-router';
import { setBackfaceTintVisible, tintBackfaces } from './mesh/backface-tint';
import { setPropShadeSun } from './scene/prop-shade';
import { viewportCursor, type ArmedPlacement } from './cursor';
import type { LocalPlayerPose, PlayerPose, PlayerTransform, PlayerVec3 } from '../../core/session/player-pose';
import { createPlayerPosePublisher } from '../net/player-publisher';
import { createGpuFrameTimer, type GpuFrameTimer } from './gpu-timer';
import {
  createVideoBillboard, type VideoBillboard, type VideoPlaybackResult,
} from './scene/video-billboard';
import type { RideEvent } from '../../core/session/ride-event';
import { updateVisibleWorldMatrices } from './scene/visible-matrices';

/** Total intensity of the presentation-only studio rig, calibrated so a well-lit face reads ≈ 1.0× its
 * texture. The authored PS2 rig does not use this exposure; propPreviewIntensity maps record 256 through
 * Three's PI-divided Lambert term and the prop shader performs the game's byte/sRGB-space modulation. */
const STUDIO_TOTAL = 3.7;

/** Stable scene-layer label for the low-frequency transparent census. Prefer semantic ownership over a GLTF
 * child mesh name so a field of riders reads as one cause rather than dozens of one-off primitives. */
function transparentOwner(object: THREE.Object3D): string {
  let nearestName = object.name || object.type;
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (current.userData.riderVisual !== undefined || current.name.startsWith('rider.')) return 'riders';
    if (current.userData.railIndex !== undefined) return 'authored rails';
    if (current.userData.propWireframePass) return 'prop wire passes';
    if (current.userData.particleVolumeSource !== undefined) return 'ambient particles';
    if (current.userData.screenPanel || current.userData.screenInspection) return 'screens';
    if (current.userData.sourceKind || current.userData.sourceSelectionPass) return 'source markers';
    if (current.name === 'PlayerBoardFx' || current.name.startsWith('PlayerBoard')) return 'board FX';
    if (current.name === 'World effects preview') return 'world effects';
    if (current.name.startsWith('xr-')) return 'XR controls/HUD';
    if (current !== object && current.name) nearestName = current.name;
  }
  return nearestName;
}

/** The 3D scene: terrain quilt preview, spine + knot handles, drag editing and surface painting. */
export class Viewport {
  /** The shared 3D substrate (renderer / scene / cameras / controls / the two chirality roots / the one
   *  translate gizmo / raycaster / pivot + marquee overlays — see stage.ts). Layer state still lives on this
   *  class; Step 3 moves each cluster out to a controller that holds the same `stage`. The accessors below let
   *  the existing method bodies keep reading `this.<field>` while the storage lives on `stage`. */
  readonly stage: Stage;
  /** Asynchronous elapsed-GPU queries for Play renders; never blocks the animation loop for a result. */
  private readonly gpuTimer: GpuFrameTimer;
  private profilingGpu = false;
  /** Work after the render timer closes is reported on the next sample, avoiding a self-timing recursion. */
  private postFrameMs = 0;
  /** Transparent `other` ownership is diagnostic text, sampled at HUD cadence instead of allocated every frame. */
  private transparentOtherCensusAt = 0;
  private transparentOtherSources = '';
  private readonly transparentOtherCounts = new Map<string, number>();
  /** The mesh-selection substrate (the app store, structurally — see MeshSelectionState in types.ts): the ONE
   *  owner of the authored corner / cell / edge / hidden selections and the reference vertex / edge / patch
   *  picks. The viewport reads it to draw and writes only the fields its own pick paths resolve. */
  readonly sel: MeshSelectionState;
  /** Layer controllers (each owns its scene objects + data; the shell routes input + selection to them). */
  readonly viewGridLayer: ViewGridLayer; // optional XYZ world-coordinate reference grid (view-only)
  private viewGridOn = false;            // remembered preference; effectively visible only in orthographic view
  private viewGridStepValue: SnapStep = 5;
  private snapOn = false;                 // global move + placement grid snap
  private snapStepValue: SnapStep = 5;
  private rotationSnapStepValue: RotationSnapStep = 15;
  readonly assets = createPropAssets(); // shared prop-model geometry / group-def / outline caches (props + gems + reference)
  readonly rails: RailsLayer;
  readonly createEdge: CreateEdgeLayer;
  private createEdgePreviewListener: (() => void) | null = null;
  readonly gems: GemsLayer;
  readonly screens: ScreensLayer;   // video screens (docs/051): authored rectangles + the reference's own
  readonly lights: LightsLayer;
  readonly glints: GlintLayer; // the runtime sparkle a glow light draws — authored and reference (docs/047)
  readonly godRays: GodRayLayer; // the sun's celestial glare fan, off unless a course authors one (docs/049)
  readonly sky: SkyLayer; // the camera-centred backdrop cylinder (docs/025)
  readonly snowfall: SnowfallLayer; // the ambient falling snow a ride is taken through (docs/050)
  readonly props: PropsLayer;
  readonly surgery: SurgeryLayer; // topology surgery (docs/017): the loop cut + future cuts / welds / rips
  readonly cageLayer: CageLayer; // the control-net cage: authored wires + sub-cage lattices, handle nubs, reference cage
  readonly picking: MeshPicking; // screen-space pick helpers: vertex > edge > face, authored + reference alike
  readonly scenePicking: ScenePicking; // nearest visible prop/light/rail/gem/knot/surface + decoded stable identity
  readonly paint: PaintLayer; // texture-paint visuals: the brush drape ghost, the amber paint selections, the tile-orientation F overlays
  readonly selection: SelectionLayer; // mesh-selection machinery: cell / edge highlights, cage handles, markers, hidden-set caches, reference picks, marquee resolution
  readonly loftPreview: LoftPreviewLayer;
  readonly clipboardPlacement: ClipboardPlacementLayer;
  readonly edgeExtrusion: EdgeExtrusionLayer;
  readonly weldTool: WeldToolLayer;
  readonly gizmoReadout: GizmoReadout;
  readonly bridgePreview: BridgePreviewLayer;
  readonly patchTool: PatchToolLayer;
  readonly tubeTool: TubeToolLayer;
  private createTubePreviewListener: (() => void) | null = null;
  readonly trailTool: TrailToolLayer;
  private createTrailPreviewListener: (() => void) | null = null;
  readonly cameraCtl: CameraController; // navigation (fly/orbit/twist/zoom/projection/view); `camera` is the THREE cam
  readonly rideCtl: RideLayer; // test ride (docs/016) + Play setup; owns the camera + input while riding
  readonly remotePlayers: RemotePlayersLayer; // camera/rider avatars for every other session on this mountain
  readonly referenceEffects: ReferenceEffectsLayer; // shared particles + read-only graph preview + Play triggers
  readonly particleVolumes: ParticleVolumesLayer; // standalone PBD fog banks (not SSF emitter graphs)
  get renderer() { return this.stage.renderer; }
  get scene() { return this.stage.scene; }
  get camera() { return this.stage.camera; }
  set camera(c: THREE.PerspectiveCamera | THREE.OrthographicCamera) { this.stage.camera = c; }
  get controls() { return this.stage.controls; }
  private get perspCam() { return this.stage.perspCam; }
  private get orthoCam() { return this.stage.orthoCam; }
  private set orthoCam(c: THREE.OrthographicCamera | null) { this.stage.orthoCam = c; }
  private get isOrtho() { return this.stage.isOrtho; }
  private set isOrtho(v: boolean) { this.stage.isOrtho = v; }
  private get orthoHalfH() { return this.stage.orthoHalfH; }
  private set orthoHalfH(v: number) { this.stage.orthoHalfH = v; }
  private get authoredFar() { return this.stage.authoredFar; }
  private set authoredFar(v: number) { this.stage.authoredFar = v; }
  private get gizmo() { return this.stage.gizmo; }
  private get gizmoKind() { return this.stage.gizmoKind; }
  private set gizmoKind(v: GizmoKind | null) { this.stage.gizmoKind = v; }
  private get gizmoKnot() { return this.stage.gizmoKnot; }
  private set gizmoKnot(v: number) { this.stage.gizmoKnot = v; }
  /** Which start/finish flag the gizmo currently holds, read off the handle itself rather than tracked
   *  alongside — there are exactly two and they are never ambiguous. */
  private get gizmoAnchor(): 'start' | 'finish' | null {
    const which = this.gizmo.object?.userData.anchor;
    return which === 'start' || which === 'finish' ? which : null;
  }
  private get gizmoDir() { return this.stage.gizmoDir; }
  private set gizmoDir(v: string) { this.stage.gizmoDir = v; }
  private get worldRoot() { return this.stage.worldRoot; }
  private get refRoot() { return this.stage.refRoot; }
  private get ray() { return this.stage.ray; }
  private get container() { return this.stage.container; }
  private get cb() { return this.stage.cb; }
  // The gizmo's transform gestures — the World / Local / Surface frame pill, the W / E / R mode switch, and the
  // frozen-snapshot rotate / scale / slide drags — live in TransformLayer (this.transforms); the shell keeps
  // selection seating + the onGizmoChange routing.
  readonly transforms: TransformLayer;
  // the pointer / wheel input dispatch — the gesture state machine (deferred clicks, the box-select marquee,
  // paint / sculpt strokes + the brush ring, the gem row drag) and the per-mode routing into the layers
  // above — lives in PointerRouter (this.router); the shell keeps the window key / blur listeners.
  readonly router: PointerRouter;
  private _mode: Mode = 'edit';
  private lightingVisible = true;
  // Source solids temporarily removed behind an extrusion ghost. This is view-only and deliberately separate
  // from the document-backed Hide command, so commit/cancel can restore the authored terrain unchanged.
  private extrusionPreviewHiddenQuads = new Set<number>();

  // Test ride (docs/016) + Play setup live in RideLayer (this.rideCtl): while a ride runs it owns the camera +
  // input, so the render loop steps it and the pointer / wheel / key dispatch bail while `rideCtl.riding`.

  // camera navigation (fly/orbit/twist/zoom/projection/view) + the upper-right nav gizmo live in
  // CameraController (this.cameraCtl); the shell keeps the render loop, the router the pointer dispatch that drives it.
  private timer = new THREE.Timer();
  /** The camera's WORLD eye, resolved once a frame. Identical to `camera.position` for every editor view; a VR
   *  ride parents the camera to its headset rig, where the local position is the wearer's own head offset. */
  private eyeWorld = new THREE.Vector3();
  private readonly playerPublisher = createPlayerPosePublisher();
  private readonly editorPlayerPosition = new THREE.Vector3();
  private editorPlayerAt = 0;

  // the authored terrain solid — the preview mesh build, per-cell tile material split and Stage-D sun
  // lighting — lives in TerrainLayer (this.terrainLayer); the shell keeps the shade-mode pill, the
  // hidden-quad index filter and the reference terrain's own material paths. These accessors let the
  // existing method bodies keep reading `this.terrain` / `this.preview` while the storage lives on the layer.
  readonly terrainLayer: TerrainLayer;
  private get terrain() { return this.terrainLayer.terrain; }
  private get preview() { return this.terrainLayer.preview; }
  // Model editing: while a model is the edit substrate, the MOUNTAIN renders through this secondary terrain
  // layer — the same tiles / tint / sun treatment as the primary, so a session changes nothing about how the
  // surrounding world reads (Hide covers decluttering). Placement tools (create patch / tube endpoints)
  // raycast it so the model is built against the terrain. It is never a surface-pick or mesh-pick target —
  // cells/edges/points still resolve on the substrate.
  private contextLayer: TerrainLayer | null = null;
  private contextWireGroup: THREE.Group | null = null; // the backdrop's cage-style wires for wireframe view
  private modelContextOn = false;
  private terrainLightOpts: TerrainLightOptions | null = null; // replayed into the context layer on session enter
  private terrainBakedOn = false;
  private get placementSurface() { return this.modelContextOn && this.contextLayer ? this.contextLayer.terrain : this.terrain; }
  /** Loaded real tiles + the lit / unlit materials that wrap them, keyed by texture ref, kept across rebuilds
   *  (TileMaterials, shared by the authored terrain, the reference terrain and the paint ghost). */
  readonly tiles: TileMaterials;
  private shading: ShadeMode = 'textured'; // terrain colour source: real tiles vs SurfaceType tint
  private spineLine: THREE.Line;
  private knotGroup = new THREE.Group();
  private knotMeshes: THREE.Mesh[] = [];
  // The course guide (the run's spine line + its knot handles) belongs to Info, the mode that owns the scene
  // tree the run is edited from — so it draws there and nowhere else (see the `mode` setter). Hidden, its
  // knots are unpickable too (pickKnot), so a click passes through to the corner / cell under them.
  private courseVisible = false;
  private courseGuideOn = true; // persisted Info preference; effective visibility is also gated by mode
  // start/finish preview (scene/course-markers): the shipped gate + six route starts and the DTF-0
  // checkered line, drawn from the same core/doc/course functions the export writes — part of the course guide
  private courseMarkers: CourseMarkersLayer;
  /** Everybody else's cursors, selections and drags, in their own colours (docs/039). */
  private peers: PeersLayer;
  // the derived AI opponent lines (scene/ai-paths — what AIP.json ships) + the reference's own AIP network,
  // shown together on the "Show AI paths" toggle (its own preference, separate from the course guide)
  private aiPathsLayer: AiPathsLayer;
  private aiPathsOn = false;     // persisted Info preference; effective visibility is also gated by mode
  private playAiPathsOn = false; // ...and Play's own, which is a separate preference (see applyAiPathsVisibility)
  private normalsOn = true; // persisted pink back-face tint that exposes each surface's normal direction
  // the texture-paint viewport visuals — the brush drape ghost, the amber painted-cell / reference-patch
  // selection outlines, and the pink/green tile-orientation F overlays — live in PaintLayer (this.paint);
  // the paint pointer routing (LMB inspect/paint, RMB tile rotate, MMB sample + arm) lives in PointerRouter.
  private isMountain = false;
  private netSpacing = 30;
  // the last mountain as a general quad net: a LIVE ref to the doc's vertex positions (corners / vertices)
  // + the topology neighbour-ring (MeshAdjacency), so the Edit gizmo's surface frame + ratio-slide + the
  // corner pick work on any topology (grid or poled mesh) through vertexFrame / vertexAxes.
  private net: { positions: number[]; adj: MeshAdjacency } | null = null;
  // The live v4 mesh doc + its cached directed-edge handle (overrides + Bessel) — shared by the CURVED cage
  // (meshCageEdges draws the true bicubic boundary curves, like the reference) and loop-cut surgery. The
  // handle is rebuilt once per doc change (setMountain nulls it), not per hover / per cage rebuild.
  private meshDoc: QuadMeshDoc | null = null;
  private meshEdgeHandle: EdgeHandle | null = null;
  private legends!: Legends; // the two lower-left colour keys (cage colours / SurfaceType tints), one per shade view
  private selected: number | null = null;
  private selectedKnots = new Set<number>();
  // Picking / ride physics keep the original patch-major index so faceIndex -> patch remains exact. Textured
  // rendering uses a second index over the same vertex attributes, sorted into a spatial grid of chunks and
  // by tile within each: one draw range per (cell, tile) instead of one range every time neighbouring patches
  // alternate materials, and — because a chunk carries its own tight bounds — off-screen cells cull for free.
  private reference: THREE.Mesh | null = null;
  private referenceBatch: THREE.Group | null = null;
  private readonly rangeCull: RangeCull;
  private rideDrawDistance: DrawDistance = DEFAULT_DRAW_DISTANCE;
  /** Test's checkbox remains the user's preference while Jukebox playback temporarily wins the music mix. */
  private rideMusicChecked = true;
  private jukeboxPlaying = false;
  private referenceBatchRefs: TexRef[] = [];
  private referenceBatchChunks: ReferenceBatchChunk[] = [];
  private referenceBatchPatchSlots: Uint32Array | null = null;
  private referenceBatchIndexSource: Uint32Array | null = null;
  private referenceBatchPatchStarts: Uint32Array | null = null;
  /** Set once the packed tile bank lands and every chunk carries its slice attribute — the flag that lets
   *  `applyReferenceMaterial` draw a whole cell through one array material. */
  private referenceBatchSliced = false;
  // the two scene rigs for LIT geometry — the texture-true studio pair, and the authored-sun pair that
  // replaces it while the sun is on (setPropLight); exactly one is visible at a time
  private studioHemi!: THREE.HemisphereLight;
  private studioSun!: THREE.DirectionalLight;
  private propFill!: THREE.AmbientLight;
  private propKey!: THREE.DirectionalLight;
  // The reference's flat Surface view must keep the same normal-direction warning as its textured tiles and
  // the authored terrain. This material is also the fallback while reference tile pages are still loading.
  private referenceMat = tintBackfaces(new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide, ...SURFACE_POLY_OFFSET,
  }));
  private referencePickMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  // Lighting study: an UNLIT material so per-vertex colours (baked lightmap / recovered model / residual)
  // show as-is instead of being re-lit by the scene. While on, it takes over the reference solid.
  private refLightMat = tintBackfaces(new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, ...SURFACE_POLY_OFFSET,
  }));
  private refLightingOn = false;
  private refLightColors: Float32Array | null = null; // last lighting buffer for the reference, already in the working space (pre tint composite)
  // Authored-terrain SSX sun lighting (Stage D) lives in TerrainLayer (this.terrainLayer) with the mesh
  // it lights: an unlit material + cached occlusion bakes, so editing re-lights live.
  // the loaded reference obeys the same view modes as the authored terrain (wireframe / cage / shading)
  private refData: ReferenceMesh | null = null;
  private refSplines: RefSplineRaw[] | null = null; // native spline table with stable raw indices; Ride filters grind styles
  private refEffectsData: ReferenceEffectsData | null = null; // resource ids join authored effect paths to refSplines
  private refCourse: V3[] | null = null; // recovered SOP/AIP racing line (native editor frame), for the guide
  private refAnchors: RefCourseAnchors | null = null; // its own start / finish / podium — where a ride begins
  private refLaps = DEFAULT_LAPS;        // passes the loaded reference level is raced over (core/doc/race)
  private refShowoffSeconds = DEFAULT_SHOWOFF_SECONDS; // …and the clock its showoff event starts with
  /** Which event a Play launches (core/doc/race). Owned here rather than on the document because the same
   *  mountain hosts both: it is a setting of the test bench, pushed by the Play panel and persisted with it. */
  private _raceMode: RaceMode = DEFAULT_RACE_MODE;
  get raceMode(): RaceMode { return this._raceMode; }
  set raceMode(mode: RaceMode) {
    this._raceMode = mode;
    // Test setup is already a live preview of the selected mountain. Changing the event there must dispatch
    // its named mode function immediately; otherwise entering Test on Free ride and then clicking Race only
    // changes the NEXT run's clock while the visible props remain in the old mode. A running ride/watch keeps
    // its latched clock and rail set, so the Play panel disables this switch until that run ends.
    if (this._mode === 'play' && !this.rideCtl.riding && !this.rideCtl.watching && !this.rideCtl.xrPresenting) {
      this.gems.setPlayMode(mode);
      this.referenceEffects.beginPlay(this.rideCtl.playTarget, mode);
    }
  }
  private refAiPaths: RefAiPath[] | null = null; // the loaded level's AI-path network (editor frame), for the overlay + the ride's AI field
  private refLevel = '';
  // the reference vertex / edge / patch SELECTIONS live on the shared substrate (this.sel.ref*); only the
  // derived cache stays here: the control-point list a loaded reference exposes.
  private referenceControlPoints: MeshControlPoint<number>[] = [];
  // the loaded reference world's DECORATIONS — its scenery props + rail/gem trick models, its Lights.json study
  // overlay, the per-instance rig tint, and the read-only outline on a clicked reference prop — all under
  // refRoot, live in ReferenceDecor (this.refDecor). The shell keeps the reference TERRAIN view; the router's
  // selection orchestration (selectReferenceProp) clears the other selections, then seats the outline via the decor.
  readonly refDecor: ReferenceDecor;
  // Shared prop-model asset caches (geometry / group defs / boxes / outline edges + material) live in
  // PropAssets (this.assets); the props, gems and reference layers all read them.

  // authored placed props (Props mode) live in PropsLayer (this.props); the prop input dispatch
  // (pickOrPlaceProp / the MMB prop-copy / the wheel-turn) + the read-only reference-prop selection live in PointerRouter.
  // AUTHORED + free local lights (docs/013) live in LightsLayer (this.lights). The cached per-vertex TERRAIN
  // glow the rig folds into the preview lives in TerrainLayer (invalidated on a rig change via lights.relight,
  // or a terrain edit); the shell keeps the billboard-tint material clones the prop rebuild makes from
  // lights.signTint.
  // authored grind rails (docs/014) live in RailsLayer (this.rails); the router keeps the selection
  // orchestration + input dispatch.
  // gem pickups (docs/014) live in GemsLayer (this.gems); the router keeps the gem-tool pointer handling.
  private refBox: THREE.Box3Helper | null = null; // wireframe AABB drawn around a loaded reference
  private refBoxVisible = false;                   // shown only while the Reference item is selected (set by the panel)
  private ownBox: THREE.Box3Helper | null = null; // wireframe AABB drawn around the authored mountain
  private ownBoxVisible = true;                    // shown only while the Mountain item is selected (set by the panel)
  private ownBounds: THREE.Box3 | null = null;     // authored data-space bounds, transformed only for proximity checks
  private refBounds: THREE.Box3 | null = null;     // reference-native bounds; refRoot supplies its live placement
  private nearestMountain: SkyPreviewTarget = 'authored';
  private nearestMountainListener: ((world: SkyPreviewTarget) => void) | null = null;
  private readonly nearestOwnWorldBounds = new THREE.Box3();
  private readonly nearestRefWorldBounds = new THREE.Box3();
  private readonly nearestOwnCenter = new THREE.Vector3();
  private readonly nearestRefCenter = new THREE.Vector3();
  private readonly videoBillboard: VideoBillboard; // view-only shared Jukebox decoder and VideoTexture
  private refCenter: V3 | null = null;            // native editor-space centre of the loaded reference (camera target)
  // A draggable centre handle (scene-root, Z negated by hand like the knots / corner marker so the gizmo
  // never sees worldRoot's negative-scale Z) that translates the WHOLE reference (mesh + cage + box) by
  // driving refRoot.position. Shown only while the reference is selected.
  private refMoveHandle!: THREE.Mesh;
  /** Effects-mode timer-emitter origin. Like knots/reference handles it lives at scene root with Z negated,
   *  so the shared TransformControls never inherits worldRoot's mirrored scale. */
  private effectHandle!: THREE.Mesh;
  private refSelected = false;

  private paintCursorArmed = false; // active tile brush: LMB paints instead of selecting/inspecting
  // Which placement tool is held, for the cursor glyph. One field rather than four booleans because arming
  // any of them disarms the others — the viewport can only ever be holding one thing.
  private armedPlacement: ArmedPlacement = null;
  // During a stable-topology gizmo drag, the dirty dependency neighborhood gets a faint cool fill and its
  // exact current cubic cage edges. The expensive mountain-wide cage wires wait for pointer-up.
  private liveEditPreviewGroup = new THREE.Group();
  private liveEditCageGroup = new THREE.Group();
  private liveEditFillMat = new THREE.MeshBasicMaterial({ color: LIVE_EDIT_FILL_COLOR, transparent: true,
    opacity: LIVE_EDIT_FILL_OPACITY, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true,
    polygonOffsetFactor: -5, polygonOffsetUnits: -5 });
  private liveEditFill = new THREE.Mesh(new THREE.BufferGeometry(), this.liveEditFillMat);
  /**
   * Check every incremental patch write against a full rebuild of the same document, and throw on any
   * disagreement (docs/039, stage 6).
   *
   * A stale patch is silent: nothing raises, the terrain simply renders differently for two people looking at
   * the same mountain. So the equivalence is checkable at runtime as well as in the suite — turn it on with
   * `?verifyRebuild=1` and the editor rebuilds the mountain twice per change and compares the buffers, which
   * is far too slow to live with and exactly what you want while hunting one.
   */
  verifyRebuilds = false;
  /** Sculpt brush footprint radius (world units); the router's ring overlay tracks it live. */
  get brushRadius() { return this.router.brushRadius; }
  set brushRadius(v: number) { this.router.brushRadius = v; }

  /**
   * Where this tab's pointer meets the nearest authored or reference mountain — the cursor its active
   * screen-share observers see (docs/039).
   *
   * Resolved on demand rather than tracked on every move: screen sharing wants it a dozen times a second, not
   * three hundred, and outside Sculpt and Paint the router casts no terrain ray at all. Both surfaces' cached
   * pick trees answer it cheaply. Null while the pointer is off the canvas or both mountains.
   */
  pointerOnMountain(): V3 | null {
    const at = this.router.pointerAt;
    if (!at) return null;
    // The raycaster is shared and this asks on a timer rather than from inside a gesture, so the standing
    // cast is put back exactly as it was found: a placement ghost re-seated by a snap change reads it
    // between pointer moves.
    const { ray, pointer } = this.stage;
    const origin = ray.ray.origin.clone(), direction = ray.ray.direction.clone();
    const near = ray.near, far = ray.far, screen = pointer.clone();
    this.stage.castAt(at);
    const authoredHit = this.stage.pickSurface(this.terrain);
    const referenceHit = this.stage.pickSurface(this.reference);
    const hit = authoredHit && referenceHit
      ? (authoredHit.distance <= referenceHit.distance ? authoredHit : referenceHit)
      : authoredHit ?? referenceHit;
    ray.ray.origin.copy(origin);
    ray.ray.direction.copy(direction);
    ray.near = near;
    ray.far = far;
    pointer.copy(screen);
    if (!hit) return null;
    // Both terrain meshes ultimately parent under worldRoot (the reference through its movable refRoot), and
    // the peer cursor lives there too. Converting the chosen world hit into that common frame preserves the
    // reference offset while retaining the authored terrain's existing coordinates.
    const local = this.stage.worldRoot.worldToLocal(hit.point);
    return [local.x, local.y, local.z];
  }

  constructor(container: HTMLElement, cb: ViewportCallbacks, sel: MeshSelectionState, smoothCutouts = false) {
    this.sel = sel;
    this.stage = new Stage(container, cb, smoothCutouts);
    // A browser may decline the requested default-framebuffer MSAA. Retain alpha hash in that case instead of
    // selecting alpha-to-coverage with only one sample, which would turn partial panes into hard cutouts.
    const defaultMsaa = this.renderer.getContext().getContextAttributes()?.antialias === true;
    setCutoutAlphaToCoverage(smoothCutouts && defaultMsaa);
    // Three r170 creates WebGL2 exclusively. Its public context type retains WebGL1 for historical versions.
    this.gpuTimer = createGpuFrameTimer(this.renderer.getContext() as WebGL2RenderingContext);
    this.videoBillboard = createVideoBillboard(this.stage, texture => this.screens.setVideoTexture(texture));
    this.stage.snapDataPoint = point => this.snapPoint(point);
    this.gizmoReadout = createGizmoReadout(this.stage);
    this.viewGridLayer = createViewGridLayer(this.stage);
    // pickable surfaces for pivot / focus raycasts (terrain always; the reference when one is loaded)
    this.stage.pickTargets = () => this.reference ? [this.terrain, this.reference] : [this.terrain];
    // seating any node re-frames a corner gizmo to the slope and drops the reference selection (any non-ref kind)
    this.stage.afterGizmoAttach = kind => {
      if (kind !== 'reference') { this.refSelected = false; this.refMoveHandle.visible = false; }
      this.transforms.applyGizmoFrame(); // corner / corners → the surface frame + restricted handles; every other kind → world
    };
    // A Move drag freezes the slide surface. Rotate / Scale freeze member values around the shared anchor.
    // Release drops that snapshot and re-orients the next gizmo from the resulting geometry.
    this.stage.onGizmoDrag = dragging => {
      if (this.gizmoKind === 'edgeextrusion') {
        if (dragging) this.gizmoReadout.begin(this.transforms.mode);
        else this.gizmoReadout.end();
        return;
      }
      const meshTransform = this.gizmoKind === 'corner' || this.gizmoKind === 'corners' || this.gizmoKind === 'editmixed'
        || this.gizmoKind === 'controlpoints' || this.gizmoKind === 'handle' || this.gizmoKind === 'cagehandle';
      if (dragging) {
        const mode = this.transforms.rotationActive() ? 'rotate' : this.transforms.scaleActive() ? 'scale' : 'move';
        this.gizmoReadout.begin(mode);
        if (mode === 'rotate') this.transforms.beginRotation();
        else if (mode === 'scale') this.transforms.beginScale();
        else this.transforms.beginSlide();
      } else {
        if (this.transforms.rotationActive()) this.transforms.endRotation();
        else if (this.transforms.scaleActive()) this.transforms.endScale();
        else this.transforms.endSlide();
        this.gizmoReadout.end();
        if (meshTransform) {
          this.clearLiveEditPreview(); // release the temporary tint immediately; full cage rebuild follows
          this.cb.onEditTransformEnd?.();
        }
      }
    };
    this.stage.onGizmoChange = () => this.onGizmoChange();

    this.rails = createRailsLayer(this.stage, this.assets); // grind rails (docs/014); adds its own groups to the stage
    this.courseMarkers = createCourseMarkersLayer(this.stage); // start gate / spawn points / finish line (course guide)
    this.peers = createPeersLayer(this.stage); // everybody else, in their own colours (docs/039)
    this.remotePlayers = createRemotePlayersLayer(this.stage);
    this.aiPathsLayer = createAiPathsLayer(this.stage); // the derived AI opponent lines (Info "Show AI paths")
    this.createEdge = createEdgeLayer(this.stage);
    this.gems = createGemsLayer(this.stage, this.assets); // gem pickups (docs/014)
    this.screens = createScreensLayer(this.stage);        // video screens (docs/051)
    this.lights = createLightsLayer(this.stage); // authored + free local lights (docs/013)
    this.glints = createGlintLayer(this.stage); // the sparkle those lights (and a reference's) draw (docs/047)
    this.godRays = createGodRayLayer(this.stage); // the sun's beams, rebuilt per frame in screen space (docs/049)
    // …and the terrain the glare's sight lines test against, so the beams fade when a rock face takes the
    // sun. Both meshes: whichever of the authored mountain or the loaded reference is standing.
    this.godRays.setOccluders(() => [this.reference, this.terrain]);
    // The backdrop may finish decoding after a ride has already armed its range fog. Keep the callback live
    // before RangeCull exists, then connect it once both layers have been constructed.
    let refreshRangeFog = () => {};
    this.sky = createSky(this.stage, () => refreshRangeFog()); // camera-centred backdrop cylinder (docs/025)
    this.snowfall = createSnowfallLayer(this.stage); // the weather field, wrapped around the eye in its own vertex shader (docs/050)
    // a rig / visibility change re-folds the authored glow into the terrain preview (invalidating its cache on a rig change)
    this.lights.relight = rigChanged => {
      if (rigChanged) this.terrainLayer.invalidateRigGlow();
      if (this.terrainLayer.terrainLit) this.terrainLayer.applyTerrainLight();
      if (this.modelContextOn && this.contextLayer) {
        if (rigChanged) this.contextLayer.invalidateRigGlow();
        if (this.contextLayer.terrainLit) this.contextLayer.applyTerrainLight();
      }
    };
    this.props = createPropsLayer(this.stage, this.assets, this.lights); // authored placed props (Props mode)
    // topology surgery (docs/017): reads the live mesh substrate the shell owns (preview / adjacency / cached
    // edge handle) through accessors; its ghost overlay parents under stage.worldRoot like the cage.
    this.surgery = createSurgeryLayer(this.stage, {
      preview: () => this.preview,
      adj: () => this.net?.adj ?? null,
      edgeHandle: () => this.meshHandle(),
    });
    this.loftPreview = createLoftPreviewLayer(this.stage, () => this.preview);
    this.patchTool = createPatchToolLayer(this.stage, () => this.placementSurface, this.loftPreview, () => {
      const vertex = this.picking.pickCorner();
      const pos = vertex !== null ? this.picking.cornerPos(vertex) : null;
      return pos ? { vertex, pos } : null;
    });
    this.tubeTool = createTubeToolLayer(this.stage, () => this.placementSurface, () => {
      const vertex = this.picking.pickCorner();
      const pos = vertex !== null ? this.picking.cornerPos(vertex) : null;
      return pos ? { vertex, pos } : null;
    });
    this.tubeTool.setListener(() => {
      this.cb.onCreateTubeAxisChange?.();
      this.createTubePreviewListener?.();
    });
    this.trailTool = createTrailToolLayer(this.stage, () => this.placementSurface, () => {
      const vertex = this.picking.pickCorner();
      const pos = vertex !== null ? this.picking.cornerPos(vertex) : null;
      return pos ? { vertex, pos } : null;
    });
    this.trailTool.setListener(pointsChanged => {
      if (pointsChanged) this.cb.onCreateTrailPointsChange?.();
      this.createTrailPreviewListener?.();
    });
    this.bridgePreview = createBridgePreviewLayer(this.stage, {
      preview: () => this.preview,
      edgeHandle: () => this.meshHandle(),
    });
    this.clipboardPlacement = createClipboardPlacementLayer(this.stage, {
      meshDoc: () => this.meshDoc,
      terrain: () => this.terrain,
      reference: () => this.reference,
    });
    this.edgeExtrusion = createEdgeExtrusionLayer(this.stage, {
      canBegin: () => {
        const onSelectionGizmo = (this.gizmoKind === 'corners' || this.gizmoKind === 'cagehandle') && !!this.gizmo.axis;
        return this._mode === 'edit' && this.isMountain && this.cageLayer.cage && !!this.meshDoc && this.sel.edgeSel.length > 0
          && !this.clipboardPlacement.active && !this.patchTool.active && !this.tubeTool.active && !this.trailTool.active && !this.surgery.tool && !this.weldTool.active
          && !this.bridgePreview.active && !this.createEdge.armed && (onSelectionGizmo || this.picking.selectedEdgeAtPointer());
      },
      selectedEdges: () => this.sel.edgeSel,
      selectedQuads: () => this.sel.cellSel,
      meshDoc: () => this.meshDoc,
      cornerPos: vertex => this.picking.cornerPos(vertex),
      snap: () => ({ enabled: this.snapOn, step: this.snapStepValue }),
      hideOtherPreview: () => this.loftPreview.hide(),
      restoreOtherPreview: () => this.loftPreview.rebuild(),
      suppressSourceQuads: quads => this.setExtrusionPreviewHiddenQuads(quads),
    });
    this.weldTool = createWeldToolLayer(this.stage, {
      terrain: () => this.terrain,
      pickCorner: () => this.picking.pickCorner(),
      cornerPos: vertex => this.picking.cornerPos(vertex),
    });
    this.cameraCtl = createCameraController(this.stage, {
      active: () => this.viewGridOn,
      toggle: () => this.cb.onToggleViewGrid?.(),
      step: () => this.viewGridStepValue,
      setStep: step => this.cb.onSetViewGridStep?.(step),
      projectionChanged: () => this.applyViewGrid(),
    }, {
      active: () => this.snapOn,
      toggle: () => this.cb.onToggleSnap?.(),
      step: () => this.snapStepValue,
      setStep: step => this.cb.onSetSnapStep?.(step),
      rotationStep: () => this.rotationSnapStepValue,
      setRotationStep: step => this.cb.onSetRotationSnapStep?.(step),
    }); // navigation + the upper-right nav gizmo / projection + ortho-grid controls
    // test ride + Play setup: reads the terrain / reference / preview the shell still holds through getters.
    // RideLayer hides the non-target worldRoot branch only while the board is actually running.
    this.rideCtl = createRideLayer(this.stage, {
      getTerrain: () => this.terrain,
      getReference: () => this.reference,
      getRefData: () => this.refData,
      getRefLevel: () => this.refLevel,
      getMountainName: () => this.meshDoc?.name ?? '',
      getPreview: () => this.preview,
      getRails: () => this.rails.rails,
      getRefSplines: () => this.refSplines,
      getRefCourse: () => this.refCourse,
      getCourseCheckpoints: () => (this.meshDoc?.course.knots ?? [])
        .filter(knot => (knot.checkpointBonus ?? 0) > 0)
        .map(knot => ({ pos: knot.pos, bonusSeconds: knot.checkpointBonus! })),
      getRefCheckpoints: () => this.refAnchors?.checkpoints ?? [],
      getRefStart: () => this.refAnchors?.start ?? null,
      getAiLines: () => {
        const d = this.meshDoc;
        return d && d.course.knots.length >= 2 ? aiPathLines(d.course, d.aiSeed ?? DEFAULT_AI_SEED) : [];
      },
      getAiRatings: () => {
        const d = this.meshDoc;
        return d && d.course.knots.length >= 2 ? aiLineRatings(d.course, d.aiSeed ?? DEFAULT_AI_SEED) : [];
      },
      getCourseLine: () => {
        const d = this.meshDoc;
        return d && d.course.knots.length >= 2 ? courseCenters(d.course) : [];
      },
      getCourseFinish: () => {
        const d = this.meshDoc;
        if (!d || d.course.knots.length < 2) return null;
        const frame = finishFrame(d.course);
        return { pos: frame.pos, fwd: frame.fwd };
      },
      getRefFinish: () => (this.refAnchors?.finish && this.refAnchors.finishFwd
        ? { pos: this.refAnchors.finish, fwd: this.refAnchors.finishFwd } : null),
      getRefAiPaths: () => this.refAiPaths,
      getBoardSound: () => normalizeBoardSound(this.meshDoc?.boardSound),
      getRaceMusic: () => this.meshDoc?.raceMusic ?? null,
      getRaceMusicArrangement: () => normalizeRaceMusicArrangement(this.meshDoc?.raceMusicArrangement,
        this.meshDoc?.raceMusic ? 'linear-loop' : 'retail-graph'),
      getEnvironmentBed: () => normalizeEnvironmentBed(this.meshDoc?.environmentBed),
      getLaps: () => this.meshDoc?.laps ?? DEFAULT_LAPS,
      getRefLaps: () => this.refLaps,
      getRaceMode: () => this.raceMode,
      getModeDisabledRails: (target, mode) => this.referenceEffects.modeDisabledRails(target, mode),
      getShowoffSeconds: () => this.meshDoc?.showoffSeconds ?? DEFAULT_SHOWOFF_SECONDS,
      getRefShowoffSeconds: () => this.refShowoffSeconds,
      getAuthoredPropColliders: () => this.props.rideColliders(),
      getReferencePropColliders: () => this.refDecor.rideColliders(),
      onPropCollision: (hit, subject) =>
        this.referenceEffects.propCollision(hit.object, hit.point, hit.normal, hit.impactSpeed, hit.shove, subject),
      getBoostVolumeSpecs: () => this.referenceEffects.boostVolumeSpecs(),
      getResetVolumeKeys: () => this.referenceEffects.resetVolumeKeys(),
      getCrackedSurfaceSpecs: () => this.referenceEffects.crackedSurfaceSpecs(),
      onCrackedChange: (key, cracked, subject) => this.referenceEffects.onCrackedChange(key, cracked, subject),
      onCrackedBreak: (key, subject) => this.referenceEffects.onCrackedBreak(key, subject),
      shovedBodySamples: () => this.referenceEffects.shovedBodySamples(),
    });
    // a tile that finishes downloading re-folds into the terrain + reference draw groups (and, if a brush
    // ghost is waiting on it, trades its amber fallback for the art right away)
    this.tiles = createTileMaterials(() => {
      this.terrainLayer.applyMaterials();
      if (this.modelContextOn) this.contextLayer?.applyMaterials(); // the session backdrop wears tiles too
      this.applyReferenceMaterial();
      this.paint.redrapeGhost();
    });

    // Scene rig for the LIT (Lambert) materials — props, tiles with the sun off, rails / gems. SSX art is
    // baked-lit (the game draws it at full texture brightness), so the rig is sized for texture-true reads:
    // three's physical lighting divides irradiance by π in the Lambert BRDF, and these intensities put a
    // well-lit face at ≈ 1.0× its texture, sides ≈ 0.6–0.8×, undersides ≈ 0.35× (form without dimming).
    // The ThumbRenderer (library / preview card) carries the same rig so previews match the viewport.
    this.studioHemi = new THREE.HemisphereLight(0xe8f1ff, 0x666e78, STUDIO_TOTAL - 1.1);
    this.studioSun = new THREE.DirectionalLight(0xfff3e0, 1.1);
    this.studioSun.position.set(-180, 260, -120);
    // ...and the IN-GAME rig it swaps to with the sun on (docs/032 · lighting): props ship per-instance
    // `ambient + max(0, N·L)·key` authored from this same sun, so previewing them under the studio fill —
    // which deliberately floods the shaded side — hides the contrast they actually render with. Off by
    // default; `setPropLight` turns them on together.
    this.propFill = new THREE.AmbientLight(0xffffff, 0);
    this.propKey = new THREE.DirectionalLight(0xffffff, 0);
    this.propFill.visible = this.propKey.visible = false;
    this.scene.add(this.studioHemi, this.studioSun, this.propFill, this.propKey);

    // the authored terrain solid (preview mesh build + tile-material split + Stage-D sun lighting) lives in
    // TerrainLayer (this.terrainLayer): it owns the terrain mesh / materials / lighting caches and reads the
    // shade mode + light rig through accessors; on each geometry rebuild the shell re-targets every dependent
    // overlay through the hook below.
    this.terrainLayer = createTerrainLayer(this.stage, this.tiles, {
      shading: () => this.shading,
      rigData: () => this.lights.authoredRigData,
      rigVisible: () => this.lights.authoredLightsVisible,
    }, {
      onGeometryRebuilt: g => {
        this.cageLayer.setDepthMaskGeometry(g); // share the rebuilt geometry so cage-view occlusion tracks edits
        this.applyHiddenTerrainIndex();
        this.paint.rebuildAuthoredF();   // the F overlay tracks paints / sculpting (no-op while toggled off)
        this.paint.rebuildPaintSel();    // the selected-cell outline hugs the (possibly re-shaped) surface
        this.selection.rebuildEditCellSel(); // the Edit cell shading follows a group move / slide too
        this.selection.rebuildEditEdgeSel(); // the selected-edge highlight rides the reshaped surface too
        this.bridgePreview.rebuild();    // builder rails + direction arrows ride the reshaped surface too
        this.loftPreview.rebuild();       // the loft ghost tracks the rails' corners as the surface reshapes
        this.paint.invalidateGhostCell(); // the ghost's cached cell geometry is stale; the next hover rebuilds it
      },
    });

    // the control-net cage (authored curved wires + explicitly pinned sub-cages + the reference cage) lives in
    // CageLayer (this.cageLayer); the shell keeps selection + gizmo orchestration and visibility state.
    this.cageLayer = createCageLayer(this.stage, {
      preview: () => this.preview,
      net: () => this.net,
      meshDoc: () => this.meshDoc,
      edgeHandle: () => this.meshHandle(),
      refData: () => this.refData,
      referenceControlPoints: () => this.referenceControlPoints,
      editMode: () => this._mode === 'edit',
      controlCageEdges: () => this.sel.controlCageEdges,
      controlCageQuads: () => this.sel.controlCageQuads,
      refControlCageEdges: () => this.sel.refControlCageEdges,
      refControlCageQuads: () => this.sel.refControlCageQuads,
      wiresOnly: () => this.shading === 'none',
      vertexHidden: vertex => this.selection.vertexHidden(vertex),
      edgeHidden: (a, b) => this.selection.edgeHidden(a, b),
      controlPointHidden: id => this.selection.controlPointHidden(id),
      refVertexHidden: vertex => this.selection.refVertexHidden(vertex),
      refEdgeHidden: (a, b) => this.selection.refEdgeHidden(a, b),
      refControlPointHidden: id => this.selection.refControlPointHidden(id),
      hiddenPolesActive: () => this._mode === 'edit' && (this.selection.hiddenVertices.size > 0 || this.selection.hiddenQuads.size > 0),
    }, {
      clearLiveEditPreview: () => this.clearLiveEditPreview(false),
    });
    // the screen-space mesh pick helpers (vertex > edge > face, authored + reference alike) read the same live
    // substrate through accessors; the pointer routing that calls them lives in PointerRouter (this.router).
    this.picking = createMeshPicking(this.stage, {
      net: () => this.net,
      preview: () => this.preview,
      meshHandle: () => this.meshHandle(),
      terrain: () => this.terrain,
      reference: () => this.reference,
      refData: () => this.refData,
      referenceControlPoints: () => this.referenceControlPoints,
      selectedEdges: () => this.selectedEdgeIndices(),
      vertexHidden: vertex => this.selection.vertexHidden(vertex),
      edgeHidden: (a, b) => this.selection.edgeHidden(a, b),
      quadHidden: quad => this.selection.quadHidden(quad),
      controlPointHidden: id => this.selection.controlPointHidden(id),
      authoredControlPointVisible: id => this.cageLayer.authoredControlPointVisible(id),
      referenceControlPointVisible: id => this.cageLayer.referenceControlPointVisible(id),
      cage: () => this.cageLayer.cage,
      subCage: () => this.cageLayer.subCage,
      referenceSubCage: () => this.cageLayer.referenceSubCage,
      authoredControlPoints: () => this.cageLayer.authoredControlPoints,
    });
    // depth-only mask sharing the terrain geometry; shown only in cage-only view so hidden wires dim
    this.cageLayer.setDepthMaskGeometry(this.terrain.geometry);

    // the texture-paint visuals (brush drape ghost / amber cell + patch outlines / the F overlays): reads the
    // painted substrate (preview / terrain / reference / tile cache) through accessors; its groups mount
    // under worldRoot / refRoot like the cage's.
    this.paint = createPaintLayer(this.stage, {
      preview: () => this.preview,
      terrain: () => this.terrain,
      reference: () => this.reference,
      refData: () => this.refData,
      refLevel: () => this.refLevel,
      ensureTile: ref => this.tiles.ensure(ref),
      quadHidden: quad => this.selection.quadHidden(quad),
      cageOn: () => this.cageLayer.cage,
    });
    // reference decorations (props / tricks / light+sound sources / prop outline) mount under refRoot
    this.refDecor = createReferenceDecor(this.stage, this.assets);
    // The ride's distance bound (docs/016). Off while authoring — an editor view wants the whole mountain —
    // and armed by the frame loop for the duration of a ride, at the range that ride is being taken at.
    this.rangeCull = createRangeCull({
      scene: this.scene,
      chunks: () => this.referenceChunks(),
      propMeshes: () => this.refDecor.propDrawMeshes,
      fogColor: () => this.sky.horizonColor(),
    });
    refreshRangeFog = () => this.rangeCull.refreshFogColor();
    this.referenceEffects = createReferenceEffectsLayer(this.stage, {
      applyRideEffect: (action, subject) => this.rideCtl.applyEffect(action, subject),
      onRideEvent: event => this.stage.cb.onRideEvent?.(event),
      setReferenceInstanceVisible: (index, visible) => this.refDecor.setRuntimeInstanceVisible(index, visible),
      setReferenceInstanceWorldMatrix: (index, matrix) => this.refDecor.setRuntimeInstanceWorldMatrix(index, matrix),
      setReferenceInstanceWorldCopies: (index, matrices) =>
        this.refDecor.setRuntimeInstanceWorldCopies(index, matrices),
      referenceInstancePieceIds: index => this.refDecor.runtimeInstancePieceIds(index),
      setReferenceInstancePieceMotions: (index, motions) =>
        this.refDecor.setRuntimeInstancePieceMotions(index, motions),
      authoredPropPieceIds: id => this.props.runtimePropPieceIds(id),
      setAuthoredPropPieceMotions: (id, motions) =>
        this.props.setRuntimePropPieceMotions(id, motions),
      setAuthoredPropVisible: (id, visible) => this.props.setRuntimePropVisible(id, visible),
      setAuthoredPropWorldMatrix: (id, matrix) => this.props.setRuntimePropWorldMatrix(id, matrix),
      retireRideObject: object => this.rideCtl.retireObstacle(object),
      restoreRideObject: object => this.rideCtl.restoreObstacle(object),
      resetObjectEffects: object => {
        if (object.kind === 'reference') this.refDecor.resetRuntimeInstanceEffects(object.index);
        else this.props.resetRuntimePropEffects(object.id);
      },
      resetSceneRuntime: () => {
        this.refDecor.resetRuntimeInstances();
        this.refDecor.resetRuntimePropertyControls();
        this.props.resetRuntimeProps();
        this.refDecor.clearAnimObjectPreviews();
        this.props.clearAnimObjectPreviews();
        this.props.clearRuntimeAnimObjects();
        this.assets.propTex.clearMaterialEffectPreviews();
      },
      controlProperty: (object, command, value) => object.kind === 'reference'
        ? this.refDecor.controlRuntimeInstanceProperty(object.index, command, value)
        : this.props.controlRuntimePropProperty(object.id, command, value),
      hasPulseProperty: object => object.kind === 'reference'
        ? this.refDecor.instanceHasPulseProperty(object.index)
        : this.props.propHasPulseProperty(object.id),
      hasTriggerableCombo: object => object.kind === 'reference'
        ? this.refDecor.instanceHasTriggerableCombo(object.index)
        : this.props.propHasTriggerableCombo(object.id),
      previewAnimObject: (object, effect, autoReturnDelay) => object.kind === 'reference'
        ? this.refDecor.previewAnimObject(object.index, effect, autoReturnDelay)
        : this.props.previewAnimObject(object.id, effect, autoReturnDelay),
      previewMaterialEffect: object => object.kind === 'reference'
        ? this.refDecor.previewMaterialEffect(object.index)
        : this.props.previewMaterialEffect(object.id),
      // One shared material cache holds both mountains' animated materials, so a single clear covers them.
      clearMaterialEffectPreviews: () => this.assets.propTex.clearMaterialEffectPreviews(),
      startAnimObject: (object, effect) => object.kind === 'authored'
        && this.props.startRuntimeAnimObject(object.id, effect),
      clearAnimObjectPreviews: () => {
        const reference = this.refDecor.clearAnimObjectPreviews();
        return this.props.clearAnimObjectPreviews() || reference;
      },
      groundAt: (object, position) => this.effectGroundAt(object.kind, position),
      objectRadius: object => (object.kind === 'reference'
        ? this.refDecor.propWorldSphere(object.index)
        : this.props.propWorldSphere(object.id))?.radius ?? null,
      objectSphere: object => (object.kind === 'reference'
        ? this.refDecor.propWorldSphere(object.index)
        : this.props.propWorldSphere(object.id)) ?? null,
      referenceEmitterMuzzle: index => this.refDecor.runtimeEmitterMuzzle(index),
      resolveSpline: (object, stableId) => {
        if (object.kind === 'reference') {
          const originalIndex = referenceSplineOriginalIndex(this.refEffectsData?.document, stableId);
          const spline = this.refSplines?.find(candidate => candidate.originalIndex === originalIndex);
          return spline ? { ...spline, space: 'raw' as const } : null;
        }
        const pathId = authoredMotionPathIdFromSpline(stableId);
        const complete = this.rails.rails.filter(rail => rail.nodes.length >= 2);
        const originalIndex = complete.findIndex(rail => rail.id === pathId);
        const rail = complete[originalIndex];
        return rail ? {
          originalIndex, style: nativeSplineFields(rail).style,
          segments: railBezierSegments(rail.nodes).map(segment => segment.map(point => [...point])),
          space: 'editor' as const,
        } : null;
      },
    });
    this.particleVolumes = createParticleVolumesLayer(this.stage);
    // Scene entities share one typed nearest-hit resolver. Mode-specific action/precedence stays in PointerRouter;
    // screen-space topology and placement remain in MeshPicking and the individual tools.
    this.scenePicking = createScenePicking(this.stage, {
      authoredPropRoots: () => [this.props.placedPropGroup],
      referencePropRoots: scope => scope === 'effects'
        ? this.refDecor.effectPropGroups : this.refDecor.propPickGroups,
      authoredParticleRoots: () => [this.particleVolumes.authoredBounds],
      referenceParticleRoots: () => [this.particleVolumes.referenceBounds],
      lightRoots: () => [this.lights.freeLightGroup],
      sourceRoots: () => [this.lights.authoredLightsGroup, ...this.refDecor.sourcePickGroups],
      railRoots: () => [this.rails.railGroup],
      referenceRailRoots: () => [this.refDecor.railSplineGroup],
      gemRoots: () => [this.gems.gemGroup],
      screenRoots: () => [this.screens.group, this.screens.referenceGroup],
      knotTargets: () => this.courseVisible ? this.knotMeshes : [],
      surfaceTargets: () => this.reference
        ? [{ source: 'authored' as const, object: this.terrain }, { source: 'reference' as const, object: this.reference }]
        : [{ source: 'authored' as const, object: this.terrain }],
    });

    // course-guide colors: the run is its own "route" family — GREEN, kin to the start markers it leads
    // from and clear of the warm amber/orange accents (prop outline, rail bulbs, selection orange) —
    // with a value hierarchy: bright knot handles (grabbable) > deeper line > dim beads
    // (scene/course-markers' exported-point beads carry the same hue, dimmed)
    this.spineLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0x39b54a }),
    );
    // spine + knots live at scene root (Z negated by hand) so the gizmo on a knot has no mirrored parent.
    this.scene.add(this.spineLine, this.knotGroup);
    this.applyCourseGuideVisibility();
    this.applyAiPathsVisibility();

    // the mesh-selection machinery (cell / edge highlights + control-net studies, cage-handle spheres, the
    // corner marker / region dots / centroid group handles, hidden-set caches, the reference vertex / edge /
    // patch picks and the marquee resolution): reads the live mesh substrate through accessors and owns its
    // scene objects; the router keeps the pointer routing, the shell the gizmo seating that call in.
    this.selection = createSelectionLayer(this.stage, this.sel, this.cageLayer, {
      net: () => this.net,
      meshDoc: () => this.meshDoc,
      preview: () => this.preview,
      meshHandle: () => this.meshHandle(),
      terrain: () => this.terrain,
      reference: () => this.reference,
      refData: () => this.refData,
      refLevel: () => this.refLevel,
      referenceControlPoints: () => this.referenceControlPoints,
      editMode: () => this._mode === 'edit',
      shading: () => this.shading,
      netSpacing: () => this.netSpacing,
      bridgeActive: () => this.bridgePreview.active,
      geometryBVH: geo => this.buildGeometryBVH(geo),
    }, {
      clearRefSelection: () => this.clearRefSelection(),
      applyGizmoFrame: () => this.transforms.applyGizmoFrame(),
    });

    this.liveEditFill.renderOrder = 9; // like the selection layer's cell fills: above the terrain, below the cage wires
    this.liveEditFill.visible = false;
    this.liveEditFill.raycast = () => { /* a pure highlight, never a pick target */ };
    this.liveEditPreviewGroup.add(this.liveEditFill, this.liveEditCageGroup);
    this.worldRoot.add(this.liveEditPreviewGroup); // drag-local dependency fill + current cage lines

    // reference move handle: a green sphere at the loaded reference's centre; click the reference to select
    // it, then drag this (via the translate gizmo) to slide the whole reference around. Lives at scene root
    // with Z negated by hand so the gizmo has no mirrored parent (see the refMoveHandle field comment).
    this.refMoveHandle = new THREE.Mesh(
      new THREE.SphereGeometry(1, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0x55e08a, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    this.refMoveHandle.renderOrder = 12;
    this.refMoveHandle.visible = false;
    this.scene.add(this.refMoveHandle);

    this.effectHandle = new THREE.Mesh(
      new THREE.SphereGeometry(1.35, 18, 12),
      new THREE.MeshBasicMaterial({ color: 0xc084fc, depthTest: false, transparent: true, opacity: 0.95 }),
    );
    this.effectHandle.renderOrder = 13;
    this.effectHandle.visible = false;
    this.scene.add(this.effectHandle);

    // the gizmo's transform gestures (World/Local/Surface frame, W/E/R mode, frozen rotate / scale /
    // slide drags): reads the mesh substrate + the shell's selection families through accessors and drives the
    // shared gizmo on the persistent anchors above; the shell keeps selection seating + onGizmoChange routing.
    this.transforms = createTransformLayer(this.stage, {
      net: () => this.net,
      meshDoc: () => this.meshDoc,
      preview: () => this.preview,
      edgeHandle: () => this.meshHandle(),
      terrainBVH: () => this.buildTerrainBVH(),
    }, {
      selectedCorner: () => this.selectedCornerIndex(),
      cornerGroupIdx: () => this.selection.cornerGroupIdx,
      editEdgeSel: () => this.selectedEdgeIndices(),
      editCellSel: () => this.selectedCellIndices(),
      controlPointSel: () => this.selection.controlPointSel,
      authoredControlPointByKey: () => this.cageLayer.authoredControlPointByKey,
      selectedCageHandle: () => this.selection.selectedCageHandle,
      selectedProp: () => this.props.selectedProp,
      multiSelProps: () => this.props.multiSelProps,
      placedProp: index => this.props.lastPlacedProps[index],
      extrusionStaged: () => this.edgeExtrusion.staged,
      extrusionFanMode: () => this.edgeExtrusion.fanMode,
    }, {
      cornerMarker: this.selection.cornerMarker,
      cornerGroupHandle: this.selection.cornerGroupHandle,
      cornerGroupHandleLast: this.selection.cornerGroupHandleLast,
      cageHandleAnchor: this.selection.cageHandleAnchor,
    }, {
      releaseCageHandle: () => this.selection.releaseCageHandle(),
      enableExtrusionTransform: () => this.edgeExtrusion.enableTransform(),
      controlPointsMoved: targets => this.selection.controlPointsMoved(targets),
    });

    this.legends = createLegends(this.container); // lower-left colour keys (cage / surface), each shown only in its shade view

    // the pointer / wheel input dispatch: wires its own DOM listeners on the canvas + container at
    // construction, routes every gesture through the layers above, and reaches back into the host only
    // for the narrow state + whole-reference selection it can't own (RouterAccess / RouterHostHooks).
    this.router = createPointerRouter(this.stage, this.sel, {
      selection: this.selection, picking: this.picking, scenePicking: this.scenePicking,
      cage: this.cageLayer, transforms: this.transforms,
      cameraCtl: this.cameraCtl, rideCtl: this.rideCtl, surgery: this.surgery, patchTool: this.patchTool,
      tubeTool: this.tubeTool, trailTool: this.trailTool, weldTool: this.weldTool, clipboardPlacement: this.clipboardPlacement,
      edgeExtrusion: this.edgeExtrusion, createEdge: this.createEdge, bridgePreview: this.bridgePreview,
      gems: this.gems, screens: this.screens, props: this.props, lights: this.lights, rails: this.rails,
      refDecor: this.refDecor,
      paint: this.paint,
    }, {
      mode: () => this._mode,
      isMountain: () => this.isMountain,
      terrain: () => this.terrain,
      reference: () => this.reference,
      refData: () => this.refData,
      refLevel: () => this.refLevel,
      preview: () => this.preview,
      net: () => this.net,
      meshDoc: () => this.meshDoc,
      netSpacing: () => this.netSpacing,
      refSelected: () => this.refSelected,
      snapPoint: point => this.snapPoint(point),
      pickKnot: () => this.pickKnot(),
      pickAnchor: () => this.pickAnchor(),
      courseKnots: () => this.courseVisible ? this.knotMeshes : [],
      createEdgePreviewChanged: () => this.createEdgePreviewListener?.(),
    }, {
      selectReference: () => this.selectReference(),
      clearRefSelection: () => this.clearRefSelection(),
    });

    window.addEventListener('keydown', e => {
      // A belongs to Add Rail while Bridge Builder is active; don't also begin a camera strafe.
      if (this.bridgePreview.active && e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey && !e.altKey) return;
      this.cameraCtl.flyKey(e, true);
    });
    window.addEventListener('keyup', e => this.cameraCtl.flyKey(e, false));
    // Shift re-frames a corner gizmo to World for a deliberate free 3D off-surface move (overhangs / wall
    // faces / cave roofs). Tracked here separately from flyKey (which only reads Shift while flying); ignored
    // mid-drag (the frame locks once a drag starts, restored on drag end) and cleared on blur so a Shift
    // released outside the window can't stick.
    window.addEventListener('keydown', e => { if (e.key === 'Shift') this.transforms.shiftKey(true); });
    window.addEventListener('keyup', e => { if (e.key === 'Shift') this.transforms.shiftKey(false); });
    window.addEventListener('blur', () => {
      this.transforms.shiftKey(false);
      this.router.cancelSelectionDrag();
    });
    // Escape during an extrusion gesture cancels the pending topology action before the host's normal Escape handler can
    // deselect the edges underneath it. Pointer-cancel and mode changes use the same cleanup path below.
    window.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || !this.edgeExtrusion.active) return;
      e.preventDefault(); e.stopImmediatePropagation();
      this.edgeExtrusion.cancel();
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();

    // The loop is `setAnimationLoop` rather than a bare rAF precisely so a WebXR session can take it over: while
    // one is presenting, three drives it off `XRSession.requestAnimationFrame` and hands the frame in as the
    // second argument. That frame is the only place the headset's own pose can be read BEFORE the render that
    // consumes it, which is why it is threaded down to the ride rather than fetched back out of the renderer.
    this.renderer.setAnimationLoop((time, frame) => {
      this.timer.update(time);
      const dt = this.timer.getDelta();
      // makeXRCompatible can invalidate handles before Chrome delivers webglcontextlost. Keep simulation's
      // clock current, but submit no rendering (including the navigation gizmo) during that transition.
      if (this.stage.xrContextPreparing || this.renderer.getContext().isContextLost()) return;
      // The headset reads first: on foot it IS the frame's simulation, and riding it is the controller input and
      // the gaze the physics below is about to steer on.
      let phaseStarted = performance.now();
      this.rideCtl.beginXrFrame(frame, dt);
      const xrBeginMs = performance.now() - phaseStarted;
      phaseStarted = performance.now();
      this.assets.propTex.stepWorldEffects(dt); // recovered water / boost / LCD UV motion
      this.refDecor.stepWorldEffects(dt); // persistent AnimObject model clips (including native gems)
      this.props.stepWorldEffects(dt); // authored placements using their borrowed model's embedded clip
      this.gems.stepWorldEffects(dt); // authored gems clone the native tier template + animation law on export
      stepCharacterGlow(dt); // rider models that declare a scrolling emissive mask (docs/030)
      const worldMs = performance.now() - phaseStarted;
      phaseStarted = performance.now();
      if (this.cameraCtl.viewHelper.animating) this.cameraCtl.viewHelper.update(dt); // animate a snap-to-axis
      const eye = this.camera.getWorldPosition(this.eyeWorld); // world: a VR ride hangs the camera off its rig
      this.glints.sync(); // light glints carry no time term; only the pixel floor needs the live buffer size
      // The weather rides the same eye the backdrop does, and only while a run is on: snow belongs to the
      // world being ridden, not to the editor view that shapes it. Two uniform writes; the field itself is
      // entirely in its vertex shader.
      this.snowfall.sync(eye, dt, this.rideCtl.riding || this.rideCtl.xrPresenting);
      let sceneMs = performance.now() - phaseStarted;
      phaseStarted = performance.now();
      this.rideCtl.step(dt); // the test ride, or an AI field (spectated, or dropped by hand in Play setup)
      this.remotePlayers.step(dt); // dead-reckoned remote cameras/riders, independent of local Edit/Play state
      const rideMs = performance.now() - phaseStarted;
      // Pause freezes the Play runtime's clocks and trigger graphs along with rider/AI physics. Editor-world
      // material animation remains live, as does the ride camera, so the held scene is still inspectable.
      phaseStarted = performance.now();
      this.referenceEffects.step(this.rideCtl.paused ? 0 : dt, eye, this.rideCtl.riderPosition,
        this.rideCtl.riding || this.rideCtl.xrPresenting ? this.rideCtl.playTarget : null,
        this.rideCtl.riderVelocity,
        this.rideCtl.riderCanTrigger);
      const effectsMs = performance.now() - phaseStarted;
      // A ride drives the camera itself, so the editor's stands down. Spectating does not: the whole point of it
      // is that you keep orbiting the mountain while the field races it.
      phaseStarted = performance.now();
      // A ride drives the camera, and so does a headset — while one is presenting the editor's navigation stands
      // down even between rides, because on foot the rig IS the view.
      if (!this.rideCtl.riding && !this.rideCtl.xrPresenting) {
        if (this.cameraCtl.flying) this.cameraCtl.flyMove(dt); // Alt+RMB fly drives the camera directly; skip OrbitControls
        else if (!this.cameraCtl.orbiting) this.controls.update(); // custom orbit also drives the camera directly
      }
      this.applyViewGrid(); // ortho axis overlay follows the live camera target; free-angle views hide it
      this.cageLayer.scaleHandleNubs(); // keep the tangent nubs screen-constant as the camera moves
      this.selection.scaleEditMarkers(); // ...and the corner marker + cage handle spheres
      this.weldTool.scaleMarker();
      sceneMs += performance.now() - phaseStarted;
      // Last before submission: seat the headset rig on whatever the rider is standing on this frame — the board
      // the physics above has just moved, or their own feet — so the view and the world agree.
      phaseStarted = performance.now();
      this.rideCtl.endXrFrame();
      const xrEndMs = performance.now() - phaseStarted;
      phaseStarted = performance.now();
      // This must follow the ride camera and XR rig seat: desktop rebuilds its screen-corner fan from the final
      // camera, while WebXR resolves the current raw eye poses through that freshly moved rig parent.
      this.godRays.sync();
      this.camera.getWorldPosition(this.eyeWorld);
      this.sky.follow(this.eyeWorld); // camera-centred, and resolved after the final ride/XR camera seat
      this.syncNearestMountain(this.eyeWorld);
      this.refDecor.sortTransparentProps(this.eyeWorld); // back-to-front, as the game's alpha pass
      // The ride's distance bound, asserted from the same eye the alpha sort just used, at whichever tier
      // Test mode is set to. Only while riding: an editor view wants the whole mountain, and turning the
      // gate off re-shows every cell and slot it had dropped.
      const riding = this.rideCtl.riding || this.rideCtl.xrPresenting;
      this.rangeCull.setRange(riding ? drawDistanceMetres(this.rideDrawDistance) : null);
      this.rangeCull.update(this.eyeWorld);
      // Play mode is the in-world presentation boundary, including its setup/spectator views. Everywhere
      // else the same decoder belongs in Users → Jukebox rather than on the mountain's screens.
      this.videoBillboard.update(this.camera, this._mode === 'play' || riding);
      const profileGpu = this.rideCtl.perfDiagnostics;
      if (!profileGpu && this.profilingGpu) this.gpuTimer.reset();
      this.profilingGpu = profileGpu;
      const gpuTiming = profileGpu
        ? this.gpuTimer.beginFrame()
        : { gpuMs: null, state: 'pending' as const };
      const renderPrepMs = performance.now() - phaseStarted;
      phaseStarted = performance.now();
      // Three's stock scene update walks invisible descendants before its render-list traversal gets the chance
      // to prune them. Play retains a large editor hierarchy behind hidden roots, so mirror projectObject's
      // visibility early-out here and suppress only the redundant stock update for this render.
      const matrixWorldAutoUpdate = this.scene.matrixWorldAutoUpdate;
      if (riding && matrixWorldAutoUpdate) {
        updateVisibleWorldMatrices(this.scene);
        this.scene.matrixWorldAutoUpdate = false;
      }
      try {
        // One call covers the complete stereo submission in WebXR, so this query includes both eye renders.
        this.renderer.render(this.scene, this.camera);
        this.renderFrame++;
      } finally {
        this.scene.matrixWorldAutoUpdate = matrixWorldAutoUpdate;
        if (profileGpu) this.gpuTimer.endFrame();
      }
      const renderSubmitMs = performance.now() - phaseStarted;
      const renderMs = renderPrepMs + renderSubmitMs;
      const postFrameStarted = performance.now();
      const renderInfo = this.renderer.info;
      // Three builds one logical render list, then submits it once per XR ArrayCamera view. These counts explain
      // scene traversal/sort pressure without the stereo multiplication present in renderer.info.render.calls.
      const renderList = this.renderer.renderLists.get(this.scene, 0);
      let transparentRefBatches = 0, transparentRefIsolated = 0;
      let transparentAuthoredProps = 0, transparentOther = 0;
      for (const item of renderList.transparent) {
        const object = item.object;
        const refKind = object.userData.propBatchKind;
        if (typeof refKind === 'string') {
          if (refKind.startsWith('static-')) transparentRefBatches++;
          else transparentRefIsolated++;
        } else if (object.userData.propIndex !== undefined) transparentAuthoredProps++;
        else transparentOther++;
      }
      const censusNow = performance.now();
      if (profileGpu && censusNow >= this.transparentOtherCensusAt) {
        this.transparentOtherCensusAt = censusNow + 500;
        this.transparentOtherCounts.clear();
        for (const item of renderList.transparent) {
          const object = item.object;
          if (typeof object.userData.propBatchKind === 'string' || object.userData.propIndex !== undefined) continue;
          const owner = transparentOwner(object);
          this.transparentOtherCounts.set(owner, (this.transparentOtherCounts.get(owner) ?? 0) + 1);
        }
        this.transparentOtherSources = [...this.transparentOtherCounts]
          .sort((a, b) => b[1] - a[1]).slice(0, 3)
          .map(([owner, count]) => `${owner} ${count}`).join(' · ');
      }
      const referencePropStats = this.refDecor.renderStats();
      const authoredPropStats = this.props.renderStats();
      // Report after submission. The HUD therefore shows the previous complete frame instead of perturbing the
      // frame it is trying to describe; `renderMs` is CPU traversal/submission, not an asynchronous GPU timer.
      this.rideCtl.recordFramePerf({
        frameMs: dt * 1000, xrBeginMs, worldMs, rideMs, effectsMs, sceneMs, xrEndMs,
        renderPrepMs, renderSubmitMs, renderMs, postFrameMs: this.postFrameMs,
        gpuMs: gpuTiming.gpuMs, gpuTimerState: gpuTiming.state,
        drawCalls: renderInfo.render.calls,
        renderTriangles: renderInfo.render.triangles,
        renderLines: renderInfo.render.lines,
        renderPoints: renderInfo.render.points,
        renderOpaqueItems: renderList.opaque.length,
        renderTransparentItems: renderList.transparent.length,
        renderTransmissiveItems: renderList.transmissive.length,
        renderTransparentRefBatches: transparentRefBatches,
        renderTransparentRefIsolated: transparentRefIsolated,
        renderTransparentAuthoredProps: transparentAuthoredProps,
        renderTransparentOther: transparentOther,
        renderTransparentOtherSources: this.transparentOtherSources,
        geometries: renderInfo.memory.geometries,
        textures: renderInfo.memory.textures,
        programs: renderInfo.programs?.length ?? 0,
        multiDraw: this.renderer.extensions.has('WEBGL_multi_draw'),
        propBatchDraws: referencePropStats.batchDraws,
        propBatchSlots: referencePropStats.batchSlots,
        propIsolatedDraws: referencePropStats.isolatedDraws,
        propIsolatedSlots: referencePropStats.isolatedSlots,
        authoredPropDraws: authoredPropStats.draws,
        propIsolation: referencePropStats.isolation,
      });
      // The ride camera cannot use the corner nav gizmo. Skipping its second WebGL render also avoids
      // ViewHelper's per-frame offsetWidth read, which otherwise forces layout after the ride HUD updates.
      if (!this.rideCtl.riding && !this.rideCtl.xrPresenting) {
        this.cameraCtl.viewHelper.render(this.cameraCtl.gizmoRenderer);
      }
      this.postFrameMs = performance.now() - postFrameStarted;
    });
  }

  // ---- test ride (docs/016) + Play setup: mechanics in RideLayer (this.rideCtl) ----

  get riding() { return this.rideCtl.riding; }
  get rideWalking() { return this.rideCtl.walking; }
  get rideFirstPerson() { return this.rideCtl.firstPerson; }
  get xrPresenting() { return this.rideCtl.xrPresenting; }
  get ridePaused() { return this.rideCtl.paused; }
  /** Spectating: the AI field is racing with no board out there, and the editor still owns the camera + input. */
  get watching() { return this.rideCtl.watching; }
  get canRideReference() { return this.rideCtl.canRideReference; }
  /** The reference level's default ride start: a slot on its start row, facing down that slot's own path. */
  referenceSpawn(): { pos: V3; heading: V3 | null } | null { return this.rideCtl.referenceSpawn(); }
  setPlayActive(on: boolean, target: 'authored' | 'reference') {
    this.rideCtl.setPlayActive(on, target);
    // Both boundaries put the world back, whoever disturbed it. The effects step loop resets when a player's
    // ride ends; an AI field fires the same graphs with nobody riding, and that state must not follow the
    // author into Edit as knocked-over props, opened doors, or a button left lit — nor into the next run,
    // which is why entering Test resets as well as leaving it.
    this.gems.setPlayMode(on ? this.raceMode : null);
    if (on) { preloadBoardAudio(); this.preloadRideMusic(target); this.referenceEffects.beginPlay(target, this.raceMode); }
    else this.referenceEffects.endPlay();
    this.applyAiPathsVisibility(); // Play's overlay follows the ride target, which this may just have changed
  }
  showRideSpawn(world: V3 | null) { this.rideCtl.showRideSpawn(world); }
  startRide(target: 'authored' | 'reference', spawn: V3, heading: V3 | null, onExit: () => void,
    ai = false, countdown = false, telemetry = false, touchControls = true) {
    // A run of its own, and Play setup before it may have dropped a field that already knocked props over and
    // part-marked counters. Start from the authored mountain rather than from wherever setup left it.
    preloadBoardAudio();
    this.preloadRideMusic(target);
    this.referenceEffects.beginPlay(target, this.raceMode);
    this.rideCtl.startRide(target, spawn, heading, onExit, ai,
      target === 'reference' && countdown ? this.referenceEffects.raceCountdown() : null, telemetry, touchControls);
  }
  stopRide() {
    this.rideCtl.stopRide();
    if (this._mode === 'play') this.referenceEffects.beginPlay(this.rideCtl.playTarget, this.raceMode);
  }
  /** Local player's carved wake + snow-contact particles. AI fields intentionally have no equivalent setter. */
  setRideBoardFx(on: boolean) { this.rideCtl.setBoardFxEnabled(on); }
  /** Test audio master for the off-board environment bed and on-board race track. */
  setRideMusic(on: boolean) {
    this.rideMusicChecked = on;
    this.applyRideMusicPlayback();
  }
  private applyRideMusicPlayback() {
    this.rideCtl.setMusicEnabled(rideMusicPlaybackEnabled(this.rideMusicChecked, this.jukeboxPlaying));
  }
  /** Complete gameplay mix; Scene Sound auditions deliberately bypass this master. */
  setRideGameVolume(volume: number) { setGameAudioVolume(volume); }
  /** A headset session is up: the rider is in VR, on foot on the mountain or on the board (docs/048). */
  get xrPlaying() { return this.rideCtl.xrPresenting; }
  /** Current owner-authoritative player sample. Outside Play, the avatar's head is the editor camera and its
   * feet sit a normal eye-height below it; inside Play the walker/board (and WebXR tracking) take over. */
  playerPose(avatar: string, serverNow: number): PlayerPose {
    const source = this.rideCtl.playerPose ?? this.editorPlayerPose(serverNow);
    return this.playerPublisher.sample(source, avatar, serverNow);
  }

  private editorPlayerPose(now: number): LocalPlayerPose {
    const headP = this.camera.getWorldPosition(new THREE.Vector3());
    const headQ = this.camera.getWorldQuaternion(new THREE.Quaternion());
    const bodyP = headP.clone(); bodyP.y -= 1.65;
    const dt = (now - this.editorPlayerAt) / 1000;
    const velocity = new THREE.Vector3();
    if (this.editorPlayerAt && dt > 0 && dt < 0.5) velocity.copy(bodyP).sub(this.editorPlayerPosition).divideScalar(dt);
    this.editorPlayerPosition.copy(bodyP);
    this.editorPlayerAt = now;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(headQ).setY(0);
    if (forward.lengthSq() < 1e-8) forward.set(0, 0, -1); else forward.normalize();
    const bodyQ = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(0, 1, 0), Math.atan2(forward.x, forward.z),
    );
    return {
      mode: 'edit', vr: false,
      body: playerTransform(bodyP, bodyQ), velocity: playerVector(velocity),
      head: playerTransform(headP, headQ),
    };
  }
  /**
   * Enter VR on `target`, standing at `spawn` with the board parked there (docs/048). MUST be awaited straight
   * out of a click: `requestSession` is gated on user activation, and anything awaited first spends it. False
   * when the headset refuses, which leaves the editor exactly as it was.
   */
  startXrPlay(target: 'authored' | 'reference', spawn: V3, heading: V3 | null, onExit: () => void,
    ai = false, telemetry = false, renderScale = DEFAULT_XR_RENDER_SCALE, layerMode: XrLayerMode = 'webgl',
    antialias = false, showStats = true, onStatsChanged?: (enabled: boolean) => void,
    onEyeBufferMeasured?: (measurement: XrEyeBufferMeasurement) => XrEyeBufferMeasurement | void): Promise<boolean> {
    preloadBoardAudio(); // starts work synchronously but awaits nothing, preserving the WebXR user gesture
    this.preloadRideMusic(target);
    this.referenceEffects.beginPlay(target, this.raceMode); // same fresh-world boundary an ordinary run gets
    return this.rideCtl.startXrPlay(target, spawn, heading, onExit, ai, telemetry, renderScale, layerMode,
      antialias, showStats, onStatsChanged, onEyeBufferMeasured);
  }
  stopXrPlay() {
    this.rideCtl.stopXrPlay();
    if (this._mode === 'play') this.referenceEffects.beginPlay(this.rideCtl.playTarget, this.raceMode);
  }

  private preloadRideMusic(target: 'authored' | 'reference') {
    if (target === 'reference') preloadReferenceRideMusic(this.refLevel);
    else preloadAuthoredRideMusic(this.meshDoc?.raceMusic, normalizeEnvironmentBed(this.meshDoc?.environmentBed));
  }
  toggleRidePause() { this.rideCtl.togglePause(); }
  /** False when the target mountain has no AI network to field ([Trailmap: 395]). */
  startWatch(target: 'authored' | 'reference'): boolean {
    // A spectated field is a run like any other, and the only kind with no rider whose arrival or departure
    // the step loop could reset around — so both of its boundaries have to say so here.
    this.referenceEffects.beginPlay(target, this.raceMode);
    return this.rideCtl.startWatch(target);
  }
  stopWatch() {
    this.rideCtl.stopWatch();
    if (this._mode === 'play') this.referenceEffects.beginPlay(this.rideCtl.playTarget, this.raceMode);
    else this.referenceEffects.endPlay();
  }

  /** Apply one peer's live world interaction to the matching local Play runtime. */
  applyRideEvent(event: RideEvent): boolean { return this.referenceEffects.applyRideEvent(event); }

  // ---- read-only reference effects: inspector selection, manual preview, and Play trigger runtime ----

  private readonly effectGroundRay = new THREE.Ray();
  private readonly effectGroundToLocal = new THREE.Matrix4();

  /** Lightweight terrain contact for visual Roller/mesh-throw bodies. Rider collision remains owned by the
   * fixed-tick ride model; these bodies only need a floor on which to bounce and settle. The ray runs through
   * the ride's cached BVH (physics.ts `rideBVH`) — a plain Raycaster walk is linear over every triangle of
   * the mountain, tens of ms per body per frame on a full reference. */
  private effectGroundAt(kind: 'authored' | 'reference', position: THREE.Vector3): THREE.Vector3 | null {
    const mesh = kind === 'reference' ? this.reference : this.terrain;
    if (!mesh) return null;
    // The same tree the ride probes against (mesh/surface-trees.ts), cached on the geometry, so whichever of
    // ride / effects asks first pays the build once.
    const bvh = rideTree(mesh.geometry as TreeGeometry);
    if (!bvh) return null;
    mesh.updateWorldMatrix(true, false);
    const ray = this.effectGroundRay;
    ray.origin.copy(position); ray.origin.y += 80;
    ray.direction.set(0, -1, 0);
    ray.applyMatrix4(this.effectGroundToLocal.copy(mesh.matrixWorld).invert());
    const hit = bvh.raycastFirst(ray, THREE.DoubleSide, 0, 240);
    return hit ? hit.point.applyMatrix4(mesh.matrixWorld) : null;
  }

  setReferenceEffects(data: ReferenceEffectsData | null) {
    const level = data?.level ?? 'cleared';
    runDiagnosticPhase('effects', `${level}:install-data`, () => {
      this.refEffectsData = data;
      this.referenceEffects.setData(data);
      this.particleVolumes.setReference(data?.particleVolumes ?? []);
      this.refDecor.setEffectsData(data); // material effects share the same native instance -> slot -> graph join
    }, data ? `${data.instances.length} instances · ${data.document.graphs.length} graphs` : undefined);
    void runDiagnosticPhaseAsync('effects', `${level}:prop-repartition`, () =>
      this.refDecor.setEffectPropIndicesProgressive(
        data ? referenceEffectInstanceIndices(data) : [],
        () => new Promise<void>(resolve => setTimeout(resolve, 0)),
      ));
  }
  showReferenceEffectInspector(on: boolean) {
    this.referenceEffects.setInspecting(on);
    this.refDecor.showEffectProps(on);
    this.particleVolumes.setInspecting(on);
  }
  showAuthoredEffectProps(on: boolean, propIds: Iterable<string>, selectedPropIds: Iterable<string> = []) {
    this.props.showEffectProps(on, propIds, selectedPropIds);
  }
  /** Select effect hosts independently from the one instance marker used by a drilled-in cross-instance node.
   * Multi-selection outlines every contributing source in gold while the marker may remain on their target. */
  selectReferenceEffectInstances(sourceIndices: Iterable<number>, markerIndex?: number | null) {
    const indices = [...sourceIndices];
    this.referenceEffects.selectInstance(markerIndex === undefined ? indices[0] ?? null : markerIndex);
    if (!indices.length) this.refDecor.clearEffectPropHighlight();
    else this.refDecor.highlightEffectPropSourceIndices(indices); // no-op for animated/effect-only hosts without mesh
  }
  previewReferenceEffect(sourceIndex: number, graphId: string, loop = false): boolean {
    return this.referenceEffects.preview(sourceIndex, graphId, loop);
  }
  previewReferenceEffects(sourceIndex: number, graphIds: readonly string[],
    loopGraphIds: readonly string[] = []): boolean {
    return this.referenceEffects.previewGraphs(sourceIndex, graphIds, loopGraphIds);
  }
  previewAuthoredEffect(propId: string, graphId: string, loop = false): boolean {
    return this.referenceEffects.previewAuthored(propId, graphId, loop);
  }
  previewReferenceTimerNode(sourceIndex: number, node: EffectNode, continuous = false): boolean {
    return this.referenceEffects.previewReferenceTimerNode(sourceIndex, node, continuous);
  }
  previewAuthoredTimerNode(propId: string, node: EffectNode, continuous = false): boolean {
    return this.referenceEffects.previewAuthoredTimerNode(propId, node, continuous);
  }
  stopReferenceEffectPreview(): boolean { return this.referenceEffects.stopPreview(); }
  isReferenceEffectPreviewing(sourceIndex: number, graphId: string): boolean {
    return this.referenceEffects.isPreviewing(sourceIndex, graphId);
  }
  /** Live Counter state during Play, or null when Play has not installed one on this prop. */
  referencePlayCounter(sourceIndex: number): { remaining: number; marked: number[] } | null {
    return this.referenceEffects.referencePlayCounter(sourceIndex);
  }
  authoredPlayCounter(propId: string): { remaining: number; marked: number[] } | null {
    return this.referenceEffects.authoredPlayCounter(propId);
  }
  isEffectPlayRunning(): boolean { return this.referenceEffects.isPlaying(); }
  /** Recovered model-clip data and read-only timeline controls for the Reference effects inspector. */
  referenceAnimObjectClip(sourceIndex: number): PropModelClip | null {
    return this.refDecor.referenceAnimObjectClip(sourceIndex);
  }
  authoredAnimObjectClip(propId: string): PropModelClip | null {
    return this.props.propAnimObjectClip(propId);
  }
  /** Hold an authored placement's clip at one frame for the inspector timeline; null releases it. */
  setAuthoredAnimObjectScrubFrame(propId: string, frame: number | null): boolean {
    return this.props.setPropAnimObjectScrubFrame(propId, frame);
  }
  setReferenceAnimObjectScrubFrame(sourceIndex: number, frame: number | null): boolean {
    return this.refDecor.setAnimObjectScrubFrame(sourceIndex, frame);
  }
  showReferenceAnimObjectPath(sourceIndex: number | null): boolean {
    return this.refDecor.showAnimObjectPath(sourceIndex);
  }
  /** Recovered world-space spline and read-only distance controls for the Reference effects inspector. */
  referenceSplineMotionInfo(sourceIndex: number, command: SplineMotionCommand): ReferenceSplineMotionInfo | null {
    return this.referenceEffects.showSplineInspector(sourceIndex, command);
  }
  setReferenceSplineMotionDistance(sourceIndex: number, command: SplineMotionCommand,
    distance: number | null): boolean {
    return this.referenceEffects.setSplineInspectorDistance(sourceIndex, command, distance);
  }
  hideReferenceSplineMotion(): boolean { return this.referenceEffects.hideSplineInspector(); }
  /** Select a native reference instance as the Props-mode read-only pick (Effects mode's "Go to prop"). */
  selectReferencePropBySource(sourceIndex: number): boolean {
    return this.refDecor.selectInstanceBySource(sourceIndex);
  }
  focusReferenceEffect(sourceIndex: number): boolean {
    const sphere = this.refDecor.propWorldSphere(sourceIndex);
    if (sphere) {
      this.cameraCtl.frameSphere(sphere.center, Math.max(2, sphere.radius * 1.2));
      return true;
    }
    const world = this.referenceEffects.instanceWorldPosition(sourceIndex);
    if (!world) return false;
    this.cameraCtl.frameSphere(world, 12);
    return true;
  }
  selectAuthoredParticleVolume(id: string | null) { this.particleVolumes.selectAuthored(id); }
  selectReferenceParticleVolume(index: number | null) { this.particleVolumes.selectReference(index); }
  focusParticleVolume(source: 'authored' | 'reference', key: string | number): boolean {
    const sphere = this.particleVolumes.focus(source, key);
    if (!sphere) return false;
    this.cameraCtl.frameSphere(sphere.center, Math.max(2, sphere.radius * 1.2));
    return true;
  }
  /** Play setup: drop one AI rider on the clicked spot and let it ride. False when the target mountain has no AI
   *  network for it to follow. */
  dropAiRider(world: V3): boolean { return this.rideCtl.dropAiRider(world); }
  /** How many AI riders are out on the mountain right now. */
  get aiRiderCount() { return this.rideCtl.aiRiderCount; }
  /** The field's size cap — the next Play fields at most this many, and a live field re-caps at once. */
  set aiRiderMax(n: number) { this.rideCtl.setAiMax(n); }
  /** Character-library id used by the next player and AI riders. */
  set riderModel(id: string) { this.rideCtl.setRiderModel(id); }
  set riderStyle(id: string) { this.rideCtl.setRiderStyle(id); }
  /** Snowboard or skis, for the player and the whole AI field — applied live to a running ride. */
  set rideGear(gear: RideGear) { this.rideCtl.setRideGear(gear); }
  /** Standard or goofy snowboard footing, retained while skis are selected and applied live. */
  set snowboardStance(stance: SnowboardStance) { this.rideCtl.setSnowboardStance(stance); }
  /** Account-owned art is local-player-only; AI and course props retain their authored presentation. */
  set equipmentAppearance(appearance: EquipmentAppearance | undefined) {
    this.rideCtl.setEquipmentAppearance(appearance);
  }

  get refLevelName() { return this.refLevel; }

  /** Convert an editor/data-space point to WORLD space (through the game-chirality flip). */
  dataToWorld(p: V3): V3 {
    this.worldRoot.updateWorldMatrix(true, false);
    const w = new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(this.worldRoot.matrixWorld);
    return [w.x, w.y, w.z];
  }

  /** Swap the active camera between perspective and orthographic, preserving the framing + target. */
  setProjection(ortho: boolean) { this.cameraCtl.setProjection(ortho); }
  /** Snapshot the camera framing so a reload can restore the exact current view. */
  serializeView(): ViewState { return this.cameraCtl.serializeView(); }
  /** Snapshot the rendered view for observers. A running Test owns the camera independently of editor orbit. */
  serializeSharedView(): SharedCameraView {
    return this.cameraCtl.serializeSharedView(this.rideCtl.riding || this.rideCtl.xrPresenting);
  }
  /** Restore a view captured by serializeView. */
  applyView(v: ViewState) { this.cameraCtl.applyView(v); }
  /** Follow a live shared view without rebuilding the camera/navigation gizmo on every sample. */
  followView(v: SharedCameraView) { this.cameraCtl.followView(v); }

  /** Terrain centre in editor coordinates, including a moved reference's placement offset. */
  cameraMountainCentre(which: 'authored' | 'reference'): V3 | null {
    const bounds = which === 'authored' ? this.ownBounds : this.refBounds;
    if (!bounds || bounds.isEmpty()) return null;
    const point = bounds.getCenter(new THREE.Vector3());
    if (which === 'reference') point.add(this.refRoot.position);
    return [point.x, point.y, point.z];
  }

  frameCamera(doc: EditDoc, label?: string, az = 45, el = 35) {
    const matched = label === undefined ? [] : (doc.labels ?? []).filter(item => item.id === label || item.name === label);
    if (label !== undefined && matched.length !== 1) throw new Error(matched.length ? `Label name is ambiguous: ${label}. Use its id.` : `No label named ${label}.`);
    const labelId = matched[0]?.id;
    const box = new THREE.Box3();
    const { mesh, edgeHandle } = meshFromDoc(doc);
    for (let q = 0; q < doc.quads.length; q++) {
      if (labelId && !doc.quadLabels?.[q]?.includes(labelId)) continue;
      for (const p of quadControlPoints(mesh, edgeHandle, q, doc.quadTwist?.[q]))
        box.expandByPoint(new THREE.Vector3(...this.dataToWorld(p)));
    }
    for (const prop of doc.props ?? []) {
      if (labelId && !prop.labels?.includes(labelId)) continue;
      const sphere = prop.id ? this.props.propWorldSphere(prop.id) : null;
      if (sphere) box.union(new THREE.Box3().setFromCenterAndSize(sphere.center, new THREE.Vector3().setScalar(2 * sphere.radius)));
      else box.expandByPoint(new THREE.Vector3(...this.dataToWorld(prop.pos)));
    }
    if (box.isEmpty()) throw new Error(label ? `Label ${label} has no terrain or props to frame.` : 'The mountain has no terrain or props to frame.');
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const a = az * Math.PI / 180, e = el * Math.PI / 180;
    const direction = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
    this.cameraCtl.lookFrom(sphere.center.clone().addScaledVector(direction, Math.max(10, sphere.radius * 3)), sphere.center);
    const aspect = this.container.clientWidth / Math.max(1, this.container.clientHeight);
    this.cameraCtl.frameSphere(sphere.center, sphere.radius * (this.isOrtho ? Math.max(1, 1 / aspect) : 1));
  }

  renderFrame = 0;
  captureSize: [number, number] | null = null;
  private capturePixelRatio = 1;
  setCaptureSize(size: [number, number] | null) {
    if (!size && !this.captureSize) return;
    if (size && !this.captureSize) this.capturePixelRatio = this.renderer.getPixelRatio();
    this.captureSize = size;
    this.container.classList.toggle('sp-capture-sized', !!size);
    if (size) this.container.style.setProperty('--capture-aspect', String(size[0] / size[1]));
    else this.renderer.setPixelRatio(this.capturePixelRatio || Math.min(window.devicePixelRatio, 2));
    this.resize();
  }

  /** Capture the prepared view without waiting for a background tab's suspended animation or encoder callbacks. */
  captureScreenshot(): Promise<Blob> {
    if (this.renderer.xr.isPresenting) return Promise.reject(new Error('Leave VR to capture the desktop viewport.'));
    try {
      this.renderer.render(this.scene, this.camera);
      this.renderFrame++;
      // Encode before WebGL discards the back buffer. Capture dimensions are bounded by setCaptureSize.
      const encoded = this.renderer.domElement.toDataURL('image/png').split(',')[1];
      if (!encoded) throw new Error('The browser could not encode the screenshot.');
      const binary = atob(encoded), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return Promise.resolve(new Blob([bytes], { type: 'image/png' }));
    } catch (error) { return Promise.reject(error); }
  }

  /** Terrain solid: 'textured' = real tiles, 'surface' = SurfaceType tint, 'none' = no solid drawn. */
  get shadeMode(): ShadeMode { return this.shading; }
  set shadeMode(m: ShadeMode) {
    if (m === this.shading) return;
    this.shading = m;
    this.legends.setShadeMode(m); // each colour key rides its own shade view: cage → Wireframe (none), surface tints → Surface
    // the lit colour buffer differs per mode (surface = tint x light, else pure light), so recompute it
    if (this.terrainLayer.terrainLit) this.terrainLayer.applyTerrainLight(); else this.terrainLayer.applyMaterials();
    if (this.modelContextOn && this.contextLayer) {
      if (this.contextLayer.terrainLit) this.contextLayer.applyTerrainLight(); else this.contextLayer.applyMaterials();
    }
    if (this.contextWireGroup) this.contextWireGroup.visible = m === 'none'; // the backdrop's wireframe stand-in
    this.cageLayer.rebuildCage();    // the cage only occludes against a solid surface, so its depth test follows
    this.applyReferenceLightColors();
    // props follow the shade view like the two terrains: textured / neutral solid / triangle wires — and so do
    // the authored rail tubes + posts, which are props by the time they bake (docs/014)
    this.props.setShadeMode(m);
    this.refDecor.setShadeMode(m);
    this.rails.setShadeMode(m);
  }

  /** Remember the XYZ-grid toggle; the actual view aid is constrained to orthographic projection. */
  get viewGrid(): boolean { return this.viewGridOn; }
  set viewGrid(on: boolean) {
    this.viewGridOn = on;
    this.applyViewGrid();
    this.cameraCtl.refreshGridBtn();
  }

  get viewGridStep(): SnapStep { return this.viewGridStepValue; }
  set viewGridStep(step: SnapStep) {
    this.viewGridStepValue = step;
    this.viewGridLayer.setStep(step);
    this.applyViewGrid();
    this.cameraCtl.refreshGridBtn();
  }

  /** Global world-grid snapping. TransformControls handles move axes; placement paths use snapPoint below.
   *  Rotate remains governed by its separate angular increment. */
  get snapEnabled(): boolean { return this.snapOn; }
  set snapEnabled(on: boolean) {
    this.snapOn = on;
    this.applyTransformSnap();
    this.refreshPlacementSnap();
    this.cameraCtl.refreshSnapBtn();
  }

  get snapStep(): SnapStep { return this.snapStepValue; }
  set snapStep(step: SnapStep) {
    this.snapStepValue = step;
    this.applyTransformSnap();
    this.refreshPlacementSnap();
    this.cameraCtl.refreshSnapBtn();
  }

  get rotationSnapStep(): RotationSnapStep { return this.rotationSnapStepValue; }
  set rotationSnapStep(step: RotationSnapStep) {
    this.rotationSnapStepValue = step;
    this.applyTransformSnap();
    this.cameraCtl.refreshSnapBtn();
  }

  private applyTransformSnap() {
    this.gizmo.setTranslationSnap(this.snapOn ? this.snapStepValue : null);
    this.gizmo.setRotationSnap(this.snapOn ? THREE.MathUtils.degToRad(this.rotationSnapStepValue) : null);
  }

  /** Quantize an authored-space point to the same absolute world grid used by move gizmos. */
  snapPoint(point: V3): V3 {
    if (!this.snapOn) return [...point] as V3;
    const step = this.snapStepValue;
    const snap = (value: number) => Math.round(value / step) * step || 0;
    return [snap(point[0]), snap(point[1]), snap(point[2])];
  }

  /** Re-seat active ghosts immediately when Snap or its increment changes, even before the pointer moves. */
  private refreshPlacementSnap() {
    if (this.createEdge?.armed) {
      const endpoint = this.router.createEdgePlacement();
      this.createEdge.showGhost(endpoint?.pos ?? null, endpoint?.vertex != null || endpoint?.edge != null);
      this.createEdgePreviewListener?.();
    }
    if (this.patchTool?.active) this.patchTool.refresh();
    if (this.tubeTool?.active) this.tubeTool.refresh();
    if (this.trailTool?.active) this.trailTool.refresh();
    if (this.clipboardPlacement?.active) this.clipboardPlacement.refresh();
    if (this.props?.propArm) this.props.seatPropGhost();
    if (this.gems?.gemArmed && !this.gems.gemLine) this.gems.updateGemGhost();
  }

  private applyViewGrid() { this.viewGridLayer.update(this.camera, this.controls.target, this.isOrtho, this.viewGridOn); }

  get mode(): Mode {
    return this._mode;
  }

  /** In paint/sculpt a single finger should paint, not move the camera (two fingers still pinch-zoom /
   *  pan); in edit a single finger orbits. Mouse paint disables controls per stroke instead. */
  set mode(m: Mode) {
    if (m !== 'edit' && this.edgeExtrusion.active) this.edgeExtrusion.cancel();
    this._mode = m;
    this.syncPlayLightingVisibility();
    this.createEdge.setDiagnosticsVisible(m === 'edit');
    if (m === 'edit') this.refreshTJunctionDiagnostics();
    // Hidden mesh components are an Edit-only view. Other modes (especially Play) must always receive the
    // complete rendered/collision surface; returning to Edit reapplies the retained visibility filter.
    this.applyHiddenTerrainIndex();
    this.applyHiddenReferenceIndex();
    this.cageLayer.rebuildCage();
    this.cageLayer.rebuildRefCage();
    this.paint.rebuildAuthoredF();
    this.updateTouch();
    if (m !== 'props') {
      this.props.clearSelection(); this.refDecor.clearPropSelection(); this.refDecor.clearSourceSelection();
      this.lights.clearSelection(); this.lights.clearRigSource(); this.rails.clearSelection(); this.gems.clearSelection();
      this.screens.clearSelection();
    }
    if (m !== 'paint') this.refDecor.clearSurfaceInspection(); // the inspected-submesh marker is Paint's
    // terrain editing (corners / handles / knots / loop trace) is Edit's; keep a reference-move gizmo alive
    // through an edit->info switch, since the whole-reference move lives in Info.
    if (m !== 'edit') {
      if (this.gizmoKind !== 'reference' && !(m === 'effects' && this.gizmoKind === 'effect')) this.detachGizmo();
      this.selection.placeCornerMarker(null); this.showHandles(null, []); this.selection.clearCageHandle(); this.selection.clearRefLoops();
    }
    if (m !== 'effects') { this.effectHandle.visible = false; if (this.gizmoKind === 'effect') this.detachGizmo(); }
    if (m !== 'edit' && (this.surgery.tool || this.patchTool.active || this.tubeTool.active || this.trailTool.active)) this.setSurgeryTool(null); // surgery is Edit-only
    if (m !== 'edit' && this.clipboardPlacement.active) this.setPasteTool(null); // clipboard placement is Edit-only too
    if (m !== 'edit' && this.weldTool.active) this.setWeldTool(false); // the target-weld gesture is Edit-only too
    if (m !== 'info') this.clearRefSelection(); // the whole-reference move handle is Info's
    this.applyCourseGuideVisibility();          // Info may show both authored + reference course paths
    this.applyAiPathsVisibility();              // …and the AI-path overlay is mode-gated: Info's toggle, or Play's

    // ghosts only make sense in their own mode (the host re-arms them on re-entry)
    if (m !== 'props' && this.props.propGhost) this.props.propGhost.visible = false;
    if (m !== 'paint' && this.paint.paintGhost) this.paint.paintGhost.visible = false;
    this.syncCursor();
  }

  /** Single-finger touch is always driven by our own pointer handlers — a ray-cast orbit in Info /
   *  Edit, or paint / sculpt / rubber-band otherwise — so OrbitControls' one-finger slot stays disabled
   *  (it keeps only the two-finger pinch-zoom / pan). */
  private updateTouch() {
    this.controls.touches.ONE = TOUCH_NONE;
  }

  /** Host-facing facade; the paint layer owns the armed brush and its translucent drape ghost. */
  setPaintBrush(b: { ref: TexRef; rot: number; mirror: boolean } | null) {
    this.paint.setPaintBrush(b);
    this.paintCursorArmed = !!b;
    this.syncCursor();
  }

  /** Paint LMB has two meanings: an armed brush paints; otherwise it only inspects/selects. */
  private syncCursor() {
    this.renderer.domElement.style.cursor = viewportCursor(this._mode, this.paintCursorArmed, this.armedPlacement);
  }

  /**
   * Record which placement tool the pointer is now holding, and repaint the cursor.
   *
   * Disarming is deliberately not symmetric with arming: the four setters all run on the way OUT of a tool as
   * well as into one, so a `null` from the tool that is not the one currently held (arming a gem disarms the
   * rail, which calls setRailArmed(false) after setGemArmed(true)) must not wipe the glyph that was just set.
   */
  private setArmedPlacement(next: ArmedPlacement) {
    if (next === null && this.armedPlacement !== null && !this.placementStillArmed(this.armedPlacement)) {
      this.armedPlacement = null;
    } else if (next !== null) this.armedPlacement = next;
    this.syncCursor();
  }

  /** Ask the owning layer whether its tool is still held, so a stale disarm cannot clear a live cursor. */
  private placementStillArmed(kind: Exclude<ArmedPlacement, null>): boolean {
    return kind === 'prop' ? !!this.props.propArm
      : kind === 'rail' ? this.rails.railArmed
        : kind === 'gem' ? this.gems.gemArmed
          : this.lights.lightPlacing;
  }

  /** Host-facing facade; the paint layer owns the amber painted-cell outline. */
  setSelectedPaintCell(quad: number | null) { this.paint.setSelectedPaintCell(quad); }

  /** Host-facing facade; the paint layer owns the painted-cell multi-selection outlines. */
  setSelectedPaintCells(quads: number[]) { this.paint.setSelectedPaintCells(quads); }

  /** Host-facing facade; the paint layer owns the read-only reference-patch outline. */
  setSelectedRefPatch(index: number | null) { this.paint.setSelectedRefPatch(index); }

  /** Drop the paint-mode inspected-prop-submesh outline (the amber marker a prop texture inspect seats). */
  clearInspectedPropSurface() { this.refDecor.clearSurfaceInspection(); }

  /** Re-apply the transient component visibility filter from the substrate (sel.hidden*). Keeping the original
   * index-buffer length means Three's faceIndex still maps to `quad * facesPerCell`; hidden patches become
   * degenerate triangles, so they neither draw nor raycast while every visible patch keeps its stable id. */
  refreshHiddenMesh() {
    this.selection.refreshHiddenSets();
    this.selection.refreshReferenceHiddenSets();
    this.applyHiddenTerrainIndex();
    this.applyHiddenReferenceIndex();
    this.cageLayer.rebuildCage();
    this.cageLayer.rebuildRefCage();
    this.paint.rebuildAuthoredF();
    this.paint.invalidateGhostCell();
  }

  private applyHiddenTerrainIndex() {
    const pv = this.preview;
    if (!pv || !this.terrain.geometry) return;
    const indices = new Uint32Array(pv.indices);
    if (this._mode === 'edit' && (this.selection.hiddenQuads.size || this.selection.hiddenVertices.size
      || this.selection.hiddenEdges.size || this.extrusionPreviewHiddenQuads.size)) {
      const stride = pv.facesPerCell * 3;
      for (let quad = 0; quad < pv.mesh.quadCount; quad++) {
        if (!this.selection.quadHidden(quad) && !this.extrusionPreviewHiddenQuads.has(quad)) continue;
        const start = quad * stride;
        if (start < 0 || start + stride > indices.length) continue;
        const collapsed = indices[start];
        indices.fill(collapsed, start, start + stride);
      }
    }
    this.terrain.geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  }

  /** Reference twin of applyHiddenTerrainIndex. The immutable patch-major index remains the source for the
   *  pick mesh, while the chunk renderer uses its retained patch→range map into the spatially reordered index.
   *  Collapsing each hidden range to one vertex preserves every buffer/group length and therefore every stable
   *  face/patch and chunk/material mapping. Outside Edit the complete reference is restored. */
  private applyHiddenReferenceIndex() {
    const data = this.refData, reference = this.reference;
    if (!data || !reference) return;
    const stride = data.facesPerPatch * 3;
    const picking = new Uint32Array(data.indices);
    const source = this.referenceBatchIndexSource;
    const starts = this.referenceBatchPatchStarts;
    const rendered = source ? new Uint32Array(source) : null;
    if (this._mode === 'edit') for (const patch of this.sel.refHiddenQuads) {
      const from = patch * stride;
      if (from < 0 || from + stride > picking.length) continue;
      picking.fill(picking[from], from, from + stride);
      const renderFrom = starts?.[patch];
      if (rendered && renderFrom !== undefined && renderFrom + stride <= rendered.length)
        rendered.fill(rendered[renderFrom], renderFrom, renderFrom + stride);
    }
    reference.geometry.setIndex(new THREE.BufferAttribute(picking, 1));
    if (rendered) {
      const index = new THREE.BufferAttribute(rendered, 1);
      for (const chunk of this.referenceChunks()) chunk.geometry.setIndex(index);
    }
  }

  private setExtrusionPreviewHiddenQuads(quads: readonly number[]) {
    const next = new Set(quads);
    if (next.size === this.extrusionPreviewHiddenQuads.size
      && [...next].every(quad => this.extrusionPreviewHiddenQuads.has(quad))) return;
    this.extrusionPreviewHiddenQuads = next;
    this.applyHiddenTerrainIndex();
  }

  /** Redraw the Edit-mode cell selection from the substrate (sel.cellSel) — every selected cell shades yellow,
   *  the same strength (a plain click shades one, Ctrl / Shift a set, a double-click a whole face-loop strip).
   *  A single selected cell also overlays its 16-point control-net study, like a clicked reference patch.
   *  The host calls this after changing sel.cellSel; an empty set clears the shading. */
  refreshEditCells() { this.selection.refreshEditCells(); }

  /** Redraw the selected-edge highlight from the substrate (sel.edgeSel, canonical `[lo,hi]` vertex-id pairs).
   *  The edge analogue of refreshEditCells; an empty set clears it. */
  refreshEditEdges() { this.selection.refreshEditEdges(); }

  /** Host-facing facade; the layer owns rail colors, arrows, and overlay geometry. */
  setBridgeRails(rails: readonly (readonly number[])[] | null) {
    this.bridgePreview.setRails(rails);
    if (this.bridgePreview.active) { this.selection.clearCageHandle(); this.detachGizmo(); }
    this.selection.rebuildEditEdgeSel();
  }

  /** Host-facing facade; the layer owns preview state and BufferGeometry lifecycle. */
  setLoftPreview(quads: readonly (readonly number[])[] | null, source?: readonly number[] | QuadMeshDoc | null) {
    this.loftPreview.setPreview(quads, source);
  }

  /** Highlight a set of box-selected corners (orange), or clear with an empty list. */
  setRegionMarks(positions: V3[]) { this.selection.setRegionMarks(positions); }

  /** Who else is on this mountain and what they are touching (docs/039). Awareness is what makes free-for-all
   *  editing work in practice, so it is drawn on the terrain rather than listed in a panel. */
  setPeers(peers: readonly PeerMarks[], serverNow = Date.now(), hiddenPlayerSessions?: ReadonlySet<string>) {
    this.peers.setPeers(peers);
    this.remotePlayers.setPeers(
      hiddenPlayerSessions?.size
        ? peers.filter(peer => !hiddenPlayerSessions.has(peer.sessionId))
        : peers,
      serverNow,
    );
  }
  /** Active remote avatars on this map. The Test Position section uses session ids so two tabs belonging to
   * the same account remain two distinct players. */
  activeMapPlayers(): readonly ActiveMapPlayer[] { return this.remotePlayers.players(); }
  /** Test ▸ Position: frame the selected player from a wide downhill vantage while in setup/watch, or join
   * three metres behind them when this browser is already in desktop Play. */
  goToMapPlayer(sessionId: string): boolean {
    const target = this.remotePlayers.navigationTarget(sessionId);
    if (!target || this.rideCtl.xrPresenting) return false;
    if (this.rideCtl.riding) return this.rideCtl.teleportPlayer(target.join, target.heading);
    this.cameraCtl.lookFrom(target.eye, target.focus);
    return true;
  }
  /** Move the editor view four metres in front of one live peer (the server-wide Users action). */
  goToPlayer(userId: string): boolean {
    if (this.rideCtl.riding || this.rideCtl.xrPresenting) return false;
    const view = this.remotePlayers.frontView(userId);
    if (!view) return false;
    this.cameraCtl.lookFrom(view.eye, view.target);
    return true;
  }
  /** Show a short-lived bubble over the live avatar that authored a new chat line. */
  showPlayerChat(userId: string, text: string): void { this.remotePlayers.showChat(userId, text); }
  showPeers(on: boolean) { this.peers.setVisible(on); }

  /** Rebuild all scene content from a mountain document; knot handles are its run. */
  setMountain(doc: EditDoc, selected: number | null, selectedKnots: readonly number[] = []) {
    this.beginMountain(doc);
    this.installMountainPreview(doc, buildMountainPreview(doc), selected, selectedKnots);
  }

  /** Load-only rebuild: tessellate in batches so the shell can paint real patch progress. */
  async setMountainProgressive(
    doc: EditDoc,
    selected: number | null,
    selectedKnots: readonly number[],
    onProgress: (completedPatches: number, totalPatches: number) => void,
    yieldControl: () => Promise<void>,
  ) {
    this.beginMountain(doc);
    const preview = await buildMountainPreviewProgressive(doc, { onProgress, yieldControl });
    // Give the final 100%-of-tessellation update a rendering opportunity before secondary overlays are built.
    await yieldControl();
    this.installMountainPreview(doc, preview, selected, selectedKnots);
  }

  private beginMountain(doc: EditDoc) {
    this.clearLiveEditPreview(false);
    this.isMountain = true;
    this.netSpacing = doc.spacing;
    this.meshMoved = false; // a full rebuild re-bakes and re-diagnoses; there is nothing left to settle
  }

  /** Install either the synchronous edit preview or the progressively tessellated load preview. */
  private installMountainPreview(
    doc: EditDoc,
    preview: PreviewData,
    selected: number | null,
    selectedKnots: readonly number[],
  ) {
    // the quad net drives the Edit gizmo (frame / slide) + corner pick on any topology: a LIVE ref to the
    // doc's positions (so a drag updates it) + the mesh's neighbour-ring, which the quilt already built.
    this.net = { positions: docPositions(doc), adj: preview.adjacency };
    // Install the new mesh substrate BEFORE applyPreview invokes its dependent-overlay rebuild hook, so the
    // hook sees one consistent generation (previewMeshEdit keeps the same order). A topology edit can select
    // vertex ids beyond the old vertex count; the stale cached handle closure indexes its old neighbour array
    // with them and throws, unwinding out of applyPreview before the new free edge / cut ever reaches the cage.
    this.meshDoc = doc;
    this.meshEdgeHandle = null;
    this.terrainLayer.applyPreview(preview);
    this.updateOwnBox(doc);
    // the curved cage + loop-cut surgery read the live mesh doc; its ids changed, so discard any stale ghost
    // (the next hover re-plans it against the newly installed substrate).
    if (this.surgery.tool) this.surgery.clearGhost();
    if (this.cageLayer.cage) this.cageLayer.rebuildCage();
    this.refreshMountainOverlays(doc, selected, selectedKnots);
    if (this._mode === 'edit') this.refreshTJunctionDiagnostics();
  }

  /**
   * The parts of a mountain rebuild that do NOT read the quilt: the run and its markers, the AI lines, the
   * awareness marks, and the selection glyphs seated on corners.
   *
   * They are driven by the course, by ids and by the current selection rather than by patch geometry, so a
   * change that leaves the terrain alone still has to run them — moving a knot or picking a different corner
   * is not a reason to re-tessellate a mountain, and not running them would be a selection that never moves.
   */
  refreshMountainOverlays(doc: EditDoc, selected: number | null, selectedKnots: readonly number[]) {
    // bigger handles: a mountain is viewed from much further away than a course
    this.syncKnots(doc.course.knots.map(k => k.pos), selected, selectedKnots, 5);
    this.courseMarkers.setCourse(doc.course.knots.length >= 2 ? doc.course : null);
    this.aiPathsLayer.setCourse(doc.course.knots.length >= 2 ? doc.course : null, doc.aiSeed ?? DEFAULT_AI_SEED);
    // Peer marks are id-named, so re-resolving them here is what carries somebody else's selection across a
    // topology edit rather than leaving it where the indices used to be.
    this.peers.setDocument(doc);
    if (this.selection.controlPointSel.length) this.selection.refreshControlPointSelection();
    // keep the corner handle on its corner across rebuilds (drag, re-seat, undo)
    this.selection.placeCornerMarker(this.selectedCornerIndex());
  }

  /** Model editing: show/refresh the mountain as a full-fidelity, placement-pickable context surface while
   *  the edit substrate is a model's mesh — the same tiles / tint / sun treatment as the primary terrain
   *  layer, so a session changes nothing about how the surrounding world reads. Rebuilt from the mountain
   *  doc (not the live terrain layer) so the ordering against setMountain doesn't matter; off parks the
   *  lazily-created layer empty. */
  setModelEditContext(on: boolean, mountainDoc?: EditDoc) {
    this.modelContextOn = !!(on && mountainDoc);
    if (this.contextWireGroup) { // rebuilt below when the session is (re-)entered
      this.stage.worldRoot.remove(this.contextWireGroup);
      clearGlyphGroup(this.contextWireGroup);
      this.contextWireGroup = null;
    }
    if (!this.modelContextOn) { this.contextLayer?.release(); return; }
    this.contextLayer ??= createTerrainLayer(this.stage, this.tiles, {
      shading: () => this.shading,
      rigData: () => this.lights.authoredRigData,
      rigVisible: () => this.lights.authoredLightsVisible,
    }, { onGeometryRebuilt: () => { /* no dependent overlays: the cage/selection stack reads the substrate */ } },
    { pickTarget: false });
    this.contextLayer.applyPreview(buildMountainPreview(mountainDoc!));
    this.contextLayer.setTerrainLight(this.terrainLightOpts); // match the primary layer's sun state
    this.contextLayer.setTerrainBakedView(this.terrainBakedOn);
    // Wireframe view hides every solid, and the backdrop has no cage layer of its own — so the mountain
    // would vanish. Give it read-only cage-style wires (the same curved quad-net look it has outside the
    // session), shown only in 'none' shading.
    const { mesh, edgeHandle } = meshFromDoc(mountainDoc!);
    const { interior, boundary } = meshCageEdges(mesh, edgeHandle, meshAdjacency(mesh), CAGE_EDGE_SEG);
    const wires = new THREE.Group();
    addCageLines(wires, interior, CAGE_INTERIOR_COLOR, 0.75, false);
    addCageLines(wires, boundary, CAGE_BOUNDARY_COLOR, 0.9, false);
    wires.visible = this.shading === 'none';
    this.stage.worldRoot.add(wires);
    this.contextWireGroup = wires;
  }

  /** Refresh constant-screen-size markers for unresolved T contacts, edge crossings, and coincident vertices. */
  private refreshTJunctionDiagnostics() {
    const doc = this.meshDoc;
    if (!doc) {
      this.createEdge.setTJunctions([]); this.createEdge.setEdgeCrossings([]); this.createEdge.setCoincidentVertices([]); return;
    }
    const byVertex = new Map<number, V3>();
    for (const junction of findTJunctions(doc)) byVertex.set(junction.vertex, junction.point);
    this.createEdge.setTJunctions([...byVertex.values()]);
    this.createEdge.setEdgeCrossings(findEdgeCrossings(doc));
    this.createEdge.setCoincidentVertices(findCoincidentVertices(doc));
  }

  /** Low-latency geometry preview during a stable-topology gizmo drag. Only the patch neighborhood whose
   * control cage can depend on the changed vertices/handles/interiors is retessellated. The global cage is not
   * rebuilt: its retained dirty wire ranges plus visible Subcage dots/lattice ranges update in place, without
   * re-enumerating the mountain-wide control-point set; secondary systems wait for pointer-up. */
  previewMeshEdit(doc: EditDoc, change: {
    vertices?: readonly number[];
    edges?: readonly [number, number][];
    quads?: readonly number[];
  }): boolean {
    const dirty = this.dirtyPatches(doc, change);
    if (!dirty?.size) return false;
    if (!this.writePatches(doc, dirty, change)) return false;
    this.rebuildLiveEditPreview(dirty);
    return true;
  }

  /**
   * Apply a change that leaves the mesh's topology alone (docs/039, stage 6).
   *
   * This is the rebuild path a remote assignment takes. Where `setMountain` re-tessellates every patch and
   * re-bakes the mountain's occlusion, this re-emits only the patches the change's dependency radius reaches
   * and leaves the bakes standing until the mountain settles — which is what makes several people editing at
   * once cost what one person editing costs. It reports false when the change is not one it can carry
   * (a topology edit, or a preview that is not there yet), and the caller falls back to `setMountain`.
   *
   * The live-drag highlight is deliberately NOT drawn here: a remote change is somebody else's, and the
   * dependency fill belongs to the hand that is doing the dragging.
   */
  updateMountain(doc: EditDoc, change: Pick<NetChange, 'vertices' | 'edges' | 'quads'>): boolean {
    const dirty = this.dirtyPatches(doc, change);
    if (!dirty) return false;
    if (!dirty.size) return true; // nothing the quilt draws moved; the caller has already been told the truth
    if (!this.writePatches(doc, dirty, change)) return false;
    this.clearLiveEditPreview(false);
    this.updateOwnBox(doc);
    return true;
  }

  /** Set by every incremental update that MOVED geometry, cleared by the settle pass that catches up on it. */
  private meshMoved = false;

  /** Whether anything has been left for `settleMountain`: an occlusion bake running behind incremental
   *  updates, or whole-mesh diagnostics that have not seen the corners as they now stand. */
  get mountainSettlePending() { return this.meshMoved || this.terrainLayer.lightingStale; }

  /**
   * Bring the deferred half of a rebuild up to date, once nothing has moved for a while.
   *
   * Cast shadow and ambient occlusion are whole-mountain queries and the mesh diagnostics are whole-mesh
   * scans; neither can follow a stream of small changes, and both are wrong to run per change. They run here
   * instead, at rest. Reports whether it had anything to do.
   */
  settleMountain(): boolean {
    if (!this.mountainSettlePending) return false;
    const relit = this.terrainLayer.settleLighting();
    if (this.meshMoved && this._mode === 'edit') this.refreshTJunctionDiagnostics();
    this.meshMoved = false;
    return relit;
  }

  /** The patches a stable-topology change can move, or null when only a full rebuild is correct. */
  private dirtyPatches(doc: EditDoc, change: {
    vertices?: readonly number[]; edges?: readonly [number, number][]; quads?: readonly number[];
  }): Set<number> | null {
    const pv = this.preview;
    if (!pv || !previewMatchesTopology(doc, pv)) return null;
    return patchDependency(pv.mesh, pv.adjacency).of(change);
  }

  /** Re-emit the named patches into the live quilt and tell every layer bound to it. */
  private writePatches(doc: EditDoc, dirty: ReadonlySet<number>, change: {
    vertices?: readonly number[]; edges?: readonly [number, number][]; quads?: readonly number[];
  }): boolean {
    const pv = this.preview;
    if (!pv) return false;
    const geometry = !!(change.vertices?.length || change.edges?.length);
    this.meshDoc = doc;
    this.net!.positions = doc.vertices;
    if (!refreshPreviewPatches(doc, pv, dirty)) return false;
    this.meshEdgeHandle = pv.edgeHandle;
    if (this.verifyRebuilds) {
      const mismatch = previewMismatch(doc, pv);
      if (mismatch) throw new Error(`incremental rebuild disagrees with a full one — ${mismatch}`);
    }
    if (this.cageLayer.subCage) this.cageLayer.updateAuthoredControlPointCache(dirty);
    this.terrainLayer.updatePatches(dirty, patchVertexSpans(dirty, PATCH_VERTS),
      { geometry, materials: !!change.quads?.length });
    this.meshMoved ||= geometry;
    this.cageLayer.streamCornerDots(doc.vertices);
    this.refreshCageEdges(dirty);
    // The F overlay and the paint ghost are drawn ON the quilt lattice, so they follow the patches that moved.
    // Both are no-ops unless their toggle is on, which is why they can be run unconditionally here.
    this.paint.rebuildAuthoredF();
    this.paint.invalidateGhostCell();
    this.selection.rebuildEditCellSel();
    this.selection.rebuildEditEdgeSel();
    if (this.selection.controlPointSel.length) this.selection.refreshControlPointSelection();
    this.selection.placeCornerMarker(this.selectedCornerIndex());
    return true;
  }

  /** Draw the current dirty dependency neighborhood. Its global cage-edge buffer ranges are rewritten in
   * place, leaving every unrelated map edge visible; the cool fill makes the dependency footprint explicit. */
  private rebuildLiveEditPreview(quads: ReadonlySet<number>) {
    const pv = this.preview;
    if (!pv || !quads.size) { this.liveEditFill.visible = false; clearGlyphGroup(this.liveEditCageGroup); return; }
    this.selection.setCellFill(this.liveEditFill, pv.positions, pv.facesPerCell, quads);
  }

  /** Rewrite the named patches' cage curves in the retained global wire buffers, leaving every unrelated map
   * edge exactly where it is. A curve with no retained range (a stale or not-yet-built cage) falls back to a
   * local line so the feedback is never simply missing. */
  private refreshCageEdges(quads: ReadonlySet<number>) {
    const pv = this.preview;
    clearGlyphGroup(this.liveEditCageGroup);
    if (!pv || !quads.size) return;
    const edgeMap = new Map<string, [number, number]>();
    for (const quad of quads) {
      const q = pv.mesh.quads[quad];
      if (!q) continue;
      const [A, B, C, D] = q;
      for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as [number, number][]) {
        if (a === b) continue;
        edgeMap.set(ekey(a, b), a < b ? [a, b] : [b, a]);
      }
    }
    const missing: [number, number][] = [], touched = new Set<THREE.BufferAttribute>();
    for (const edge of edgeMap.values()) {
      const range = this.cageLayer.edgeRange(ekey(edge[0], edge[1]));
      if (!range) { missing.push(edge); continue; }
      const attr = range.geometry.getAttribute('position') as THREE.BufferAttribute;
      const segs = meshEdgeSegments(pv.mesh, pv.edgeHandle, [range.edge], CAGE_EDGE_SEG);
      (attr.array as Float32Array).set(segs, range.floatOffset);
      touched.add(attr);
    }
    for (const attr of touched) attr.needsUpdate = true;
    if (missing.length) {
      const segs = meshEdgeSegments(pv.mesh, pv.edgeHandle, missing, CAGE_EDGE_SEG);
      if (segs.length) addCageLines(this.liveEditCageGroup, segs, CTRL_CAGE_COLOR, 0.98, false, LOOP_RENDER_ORDER + 2);
    }
  }

  private clearLiveEditPreview(restoreGlobalCage = true) {
    this.liveEditFill.visible = false;
    clearGlyphGroup(this.liveEditCageGroup);
    if (restoreGlobalCage) this.cageLayer.showAllWires();
  }

  /** Box the authored mountain with a wireframe AABB (warm, vs the reference's cool box) so its extent
   *  reads at a glance and matches the boxed reference. Rebuilt from the corner bounds each rebuild. */
  private updateOwnBox(doc: EditDoc) {
    if (this.ownBox) {
      this.worldRoot.remove(this.ownBox);
      this.ownBox.geometry.dispose();
      (this.ownBox.material as THREE.Material).dispose();
      this.ownBox = null;
    }
    const C = docPositions(doc);
    if (C.length < 3) { this.ownBounds = null; this.videoBillboard.setMountainBounds(null); return; }
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (let i = 0; i + 2 < C.length; i += 3) {
      min.x = Math.min(min.x, C[i]); max.x = Math.max(max.x, C[i]);
      min.y = Math.min(min.y, C[i + 1]); max.y = Math.max(max.y, C[i + 1]);
      min.z = Math.min(min.z, C[i + 2]); max.z = Math.max(max.z, C[i + 2]);
    }
    const bounds = new THREE.Box3(min, max);
    this.ownBounds = bounds;
    this.ownBox = new THREE.Box3Helper(bounds, new THREE.Color(0xc28a3a));
    this.ownBox.visible = this.ownBoxVisible; // honour the panel's show state across rebuilds
    this.worldRoot.add(this.ownBox);
    this.videoBillboard.setMountainBounds(bounds);
  }

  /** Browser-local Users → Jukebox controls for the view-only video surface. */
  playJukeboxVideo(sourceUrl: string, startAtSeconds = 0): Promise<VideoPlaybackResult | null> {
    return this.videoBillboard.play(sourceUrl, startAtSeconds);
  }

  stopJukeboxVideo(): void {
    this.videoBillboard.stop();
    this.jukeboxPlaying = false;
    this.applyRideMusicPlayback();
  }

  seekJukeboxVideo(positionSeconds: number): void {
    this.videoBillboard.seek(positionSeconds);
  }

  setJukeboxVideoPlaying(playing: boolean): void {
    // On start, silence Test music before asking browser media to play. On stop, pause media before restoring it.
    if (playing) {
      this.jukeboxPlaying = true;
      this.applyRideMusicPlayback();
    }
    this.videoBillboard.setPlaying(playing);
    if (!playing) {
      this.jukeboxPlaying = false;
      this.applyRideMusicPlayback();
    }
  }

  setJukeboxVideoMuted(muted: boolean): void {
    this.videoBillboard.setMuted(muted);
  }

  jukeboxVideoMuted(): boolean {
    return this.videoBillboard.muted();
  }

  setJukeboxVideoVolume(volume: number): void {
    this.videoBillboard.setVolume(volume);
  }

  jukeboxVideoVolume(): number {
    return this.videoBillboard.volume();
  }

  jukeboxVideoTime(): { current: number; duration: number } {
    return { current: this.videoBillboard.currentTime(), duration: this.videoBillboard.duration() };
  }

  mountJukeboxPreview(host: HTMLElement | null): void {
    this.videoBillboard.mountPreview(host);
  }

  onJukeboxVideoEnded(listener: (() => void) | null): void {
    this.videoBillboard.onEnded(listener);
  }

  /** Show / hide the authored mountain's bounding box (paired with the reference on Scene ▸ Reference). */
  showOwnBox(on: boolean) {
    this.ownBoxVisible = on;
    if (this.ownBox) this.ownBox.visible = on;
  }

  /** Show / hide the run's guide line + knot handles (Info mode draws them). Hiding drops the gizmo off a
   *  selected knot — it would otherwise hover over a handle that isn't drawn. */
  get courseGuide(): boolean { return this.courseGuideOn; }
  set courseGuide(on: boolean) {
    this.courseGuideOn = on;
    this.applyCourseGuideVisibility();
  }

  private applyCourseGuideVisibility() { this.showCourse(this._mode === 'info' && this.courseGuideOn); }

  get normalsGuide(): boolean { return this.normalsOn; }
  set normalsGuide(on: boolean) {
    this.normalsOn = on;
    setBackfaceTintVisible(on);
  }

  /** Show / hide the AI-path overlay (Info): the authored derived opponent lines AND the loaded reference's
   *  own AIP network — one toggle, like the course guide it sits beside. */
  get aiPathsGuide(): boolean { return this.aiPathsOn; }
  set aiPathsGuide(on: boolean) {
    this.aiPathsOn = on;
    this.applyAiPathsVisibility();
  }

  /** The same overlay in Play, on its OWN toggle — you want the lines up while watching riders work them far
   *  more often than while shaping the run, and neither mode should switch the other's clutter on. */
  get playAiPathsGuide(): boolean { return this.playAiPathsOn; }
  set playAiPathsGuide(on: boolean) {
    this.playAiPathsOn = on;
    this.applyAiPathsVisibility();
  }

  /** Info shows both mountains' lines (it is a study view). Play shows only the one being ridden: the other
   *  mountain is hidden the moment a ride starts, and its lines hanging in the air would be nothing but a lie. */
  private applyAiPathsVisibility() {
    const info = this._mode === 'info' && this.aiPathsOn;
    const play = this._mode === 'play' && this.playAiPathsOn;
    this.aiPathsLayer.setVisible(info || (play && this.rideCtl.playTarget === 'authored'));
    this.refDecor.showAiPaths(info || (play && this.rideCtl.playTarget === 'reference'));
  }

  private showCourse(on: boolean) {
    this.courseVisible = on;
    this.spineLine.visible = on;
    this.knotGroup.visible = on;
    this.courseMarkers.setVisible(on);
    this.refDecor.showCourse(on); // the reference's recovered course line is part of the same guide
    if (!on && this.gizmoKind === 'knot') this.detachGizmo();
  }

  /** Show / hide the loaded reference's bounding box (paired with the mountain on Scene ▸ Reference). */
  showRefBox(on: boolean) {
    this.refBoxVisible = on;
    if (this.refBox) this.refBox.visible = on;
  }

  /** Drop any control-net corner selection (Escape, editor switch). */
  clearCornerSelection() { this.selection.clearCornerSelection(); }

  /** Host-owned selection of arbitrary authored control points. The viewport resolves their exact current
   * positions from the same list that draws the global dots, marks every member, and seats one centroid gizmo
   * on the unlocked subset. World is axis-aligned; Local / Surface align to the points' owner-corner slopes.
   * Point groups still move freely because Surface slide is a corner/topology tool. */
  setControlPointSelection(ids: readonly MeshControlPointId[]) { this.selection.setControlPointSelection(ids); }

  /** Remove the current selection gizmo. */
  detachSelectionGizmo() { this.stage.detachGizmo(); }

  /** Seat one World-space Move / Rotate gizmo on a mixed Edit marquee's movable mesh/prop union. */
  setEditMixedGroup(positions: V3[], indices: number[] = []) { this.selection.setEditMixedGroup(positions, indices); }

  /** Retain one family from a mixed read-only reference marquee. */
  narrowReferenceEditSelection(kind: 'point' | 'edge' | 'patch') {
    this.selection.narrowReferenceEditSelection(kind);
  }

  /** Authored corners whose current-view projection lies inside the selected curved patch silhouettes. */
  projectedVerticesInsidePatches(quads: readonly number[]): number[] {
    return this.selection.projectedVerticesInsidePatches(quads);
  }

  /** Seat the group move gizmo on a VERTEX SET — a multi-corner selection (shift-range / box-select), or the
   *  vertices an edge / cell selection spans: park the translate gizmo at the set's centroid so a drag moves
   *  them all together (onMoveCorners / onSlideCorners). `showMarks` also marks each member with the orange
   *  region dots; that's the corner family's own marker, so an edge (its yellow highlight) and a cell (its
   *  shading) pass false and seat the gizmo alone — their own family already cleared the dots on the way in.
   *  Empty clears it. Won't yank the handle mid-drag — the gizmo owns its position then. */
  setCornerGroup(positions: V3[], indices: number[] = [], showMarks = true) { this.selection.setCornerGroup(positions, indices, showMarks); }

  /** Point the translate gizmo at a node mesh (corner marker, course knot, or tangent-handle nub).
   *  The mesh is persistent, so the gizmo rides it through rebuilds automatically - only re-seat it
   *  on an explicit click (selecting a different node) or when knot meshes are recreated. */
  private attachGizmo(obj: THREE.Object3D, kind: GizmoKind, idx: number, dir = '') {
    this.stage.attachGizmo(obj, kind, idx, dir); // side-effects (drop ref selection + re-frame) via stage.afterGizmoAttach
  }

  /** Hide the translate gizmo (nothing selected, or paint/sculpt mode). */
  private detachGizmo() { this.stage.detachGizmo(); }

  /** Host-facing facade; the transform layer owns World / Local / Surface framing and Surface's slide. */
  setGizmoFrame(frame: GizmoFrame) { this.transforms.setGizmoFrame(frame); }

  /** Host-facing facade; the transform layer gates rotate / scale to selections with extent. */
  setGizmoMode(mode: GizmoMode) { this.transforms.setGizmoMode(mode); }

  /** Show and seat the Effects-mode local-origin handle, or remove it when the selection is not spatial. */
  setEffectHandle(pos: V3 | null) {
    if (!pos || this._mode !== 'effects') {
      this.effectHandle.visible = false;
      if (this.gizmoKind === 'effect') this.detachGizmo();
      return;
    }
    this.effectHandle.position.set(pos[0], pos[1], -pos[2]);
    this.effectHandle.visible = true;
    this.attachGizmo(this.effectHandle, 'effect', 0);
  }

  /** Build a MeshBVH over a groupless twin of the CURRENT terrain geometry (CLONED buffers, so a live rebuild
   *  won't disturb it; the twin's own index reorder is harmless since nothing else reads it). Shared by the
   *  slide freeze and the box-select occlusion test. Null when the terrain has no geometry yet. */
  private buildTerrainBVH(): MeshBVH | null {
    return this.buildGeometryBVH(this.terrain.geometry);
  }

  /** Clone a render geometry into an isolated BVH; shared by authored/reference marquee occlusion and slides. */
  private buildGeometryBVH(geo: THREE.BufferGeometry): MeshBVH | null {
    const pos = geo.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return null;
    const twin = new THREE.BufferGeometry();
    twin.setAttribute('position', pos.clone());
    const idx = geo.getIndex();
    if (idx) twin.setIndex(idx.clone());
    return new MeshBVH(twin);
  }

  /** A gizmo drag moved its target: forward the new world position through the matching callback. */
  private onGizmoChange() {
    const obj = this.gizmo.object;
    if (!obj) return;
    if (this.gizmoKind === 'edgeextrusion') { this.edgeExtrusion.onGizmoChange(); this.gizmoReadout.update(); return; }
    if (this.transforms.rotationActive()) { this.transforms.rotateSelection(); this.gizmoReadout.update(); return; }
    if (this.transforms.scaleActive()) { this.transforms.scaleSelection(); this.gizmoReadout.update(); return; }
    if (this.transforms.slideRecut(obj)) { this.gizmoReadout.update(); return; } // Slide, arrow or tangent pad: an exact de Casteljau re-cut owns the frame
    this.transforms.slideProject(obj); // Slide: snap a corner with no axes back onto the frozen surface before reporting
    this.gizmoReadout.update();
    const p: V3 = [obj.position.x, obj.position.y, -obj.position.z]; // gizmo drags in the flipped scene-root frame -> negate Z back to data
    const corner = this.selectedCornerIndex();
    if (this.gizmoKind === 'corner' && corner !== null) this.cb.onMoveCorner(corner, p);
    else if (this.gizmoKind === 'corners') {
      if (this.transforms.groupSliding) this.transforms.slideGroupUpdate(p); // Slide: ratio-preserving grid slide on the frozen surface
      else {
        // Move: the centre handle drives the whole set rigidly — report how far it moved since the last report
        const d: V3 = [p[0] - this.selection.cornerGroupHandleLast.x, p[1] - this.selection.cornerGroupHandleLast.y, p[2] - this.selection.cornerGroupHandleLast.z];
        this.selection.cornerGroupHandleLast.set(p[0], p[1], p[2]);
        if (d[0] || d[1] || d[2]) this.cb.onMoveCorners?.(d);
      }
    }
    else if (this.gizmoKind === 'controlpoints') {
      const d: V3 = [p[0] - this.selection.cornerGroupHandleLast.x, p[1] - this.selection.cornerGroupHandleLast.y, p[2] - this.selection.cornerGroupHandleLast.z];
      this.selection.cornerGroupHandleLast.set(p[0], p[1], p[2]);
      if (d[0] || d[1] || d[2]) {
        this.cb.onMoveControlPoints?.(d);
        this.selection.shiftControlPointMarks(d);
      }
    }
    else if (this.gizmoKind === 'editmixed') {
      const d: V3 = [p[0] - this.selection.cornerGroupHandleLast.x, p[1] - this.selection.cornerGroupHandleLast.y, p[2] - this.selection.cornerGroupHandleLast.z];
      this.selection.cornerGroupHandleLast.set(p[0], p[1], p[2]);
      if (d[0] || d[1] || d[2]) this.cb.onMoveMixedEditSelection?.(d);
    }
    else if (this.gizmoKind === 'knot') this.cb.onMoveKnot(this.gizmoKnot, p);
    else if (this.gizmoKind === 'anchor' && this.gizmoAnchor)
      this.cb.onMoveAnchor?.(this.gizmoAnchor, [p[0], p[1] - ANCHOR_HANDLE_LIFT, p[2]]); // the flag floats; the anchor is the ground point
    else if (this.gizmoKind === 'prop' && this.props.selectedProp !== null) this.cb.onMoveProp?.(this.props.selectedProp, p);
    else if (this.gizmoKind === 'props' && this.props.multiSelProps.length) {
      // the centre handle drives the whole set: report how far it moved since the last report (data space)
      const d: V3 = [p[0] - this.props.multiHandleLast.x, p[1] - this.props.multiHandleLast.y, p[2] - this.props.multiHandleLast.z];
      this.props.multiHandleLast.set(p[0], p[1], p[2]);
      if (d[0] || d[1] || d[2]) this.cb.onMoveProps?.(d);
    }
    else if (this.gizmoKind === 'light' && this.lights.selectedLight !== null) this.cb.onMoveLight?.(this.lights.selectedLight, p);
    else if (this.gizmoKind === 'railnode' && this.rails.selectedRail !== null && this.rails.selectedNode !== null) this.cb.onMoveRailNode?.(this.rails.selectedRail, this.rails.selectedNode, p);
    else if (this.gizmoKind === 'gem' && this.gems.selectedGem !== null) this.cb.onMoveGem?.(this.gems.selectedGem, p);
    else if (this.gizmoKind === 'screen' && this.screens.selectedScreen !== null) this.cb.onMoveScreen?.(this.screens.selectedScreen, p);
    else if (this.gizmoKind === 'effect') this.cb.onMoveEffect?.(p);
    else if (this.gizmoKind === 'handle') { this.cageLayer.rebuildHandleLines(); this.cb.onMoveHandle(this.gizmoDir, p); }
    else if (this.gizmoKind === 'cagehandle' && this.selection.selectedCageHandle) {
      const h = this.selection.selectedCageHandle;
      if (h.kind === 'edge') this.cb.onMoveCageHandle?.(h.from, h.to, p); // pin the directed-edge tangent (edgeHandles)
      else this.cb.onMoveTwist?.(h.quad, h.corner, p);                     // pull the interior CP off zero-twist (quadTwist)
    }
    else if (this.gizmoKind === 'reference' && this.refCenter) {
      // the handle is dragged in the flipped scene-root frame; back out the native centre to get refRoot's
      // offset. refRoot rides under worldRoot's -Z, so its local Z is the negated world Z (hence -obj.z).
      this.refRoot.position.set(obj.position.x - this.refCenter[0], obj.position.y - this.refCenter[1], -obj.position.z - this.refCenter[2]);
    }
  }

  /** Position + size the reference move handle on the reference's current centre (native centre + the live
   *  refRoot offset, Z negated onto the flipped scene). Leaves visibility unchanged. */
  private placeRefHandle() {
    if (!this.refCenter) return;
    const o = this.refRoot.position;
    this.refMoveHandle.position.set(o.x + this.refCenter[0], o.y + this.refCenter[1], -(o.z + this.refCenter[2]));
    const span = this.refData ? Math.max(this.refData.max[0] - this.refData.min[0], this.refData.max[2] - this.refData.min[2]) : 400;
    this.refMoveHandle.scale.setScalar(Math.max(8, span * 0.02));
  }

  /** Select the loaded reference (Info mode): reveal its centre move handle and seat the translate gizmo
   *  on it so the whole reference (mesh + cage + box) can be dragged around. */
  private selectReference() {
    if (!this.reference || !this.refCenter) return;
    this.cb.onSelectKnot(null);
    this.selection.placeCornerMarker(null);
    this.cb.onSelectCorner(null);
    this.refSelected = true;
    this.placeRefHandle();
    this.refMoveHandle.visible = true;
    this.attachGizmo(this.refMoveHandle, 'reference', 0);
    this.cb.onSelectReference?.(); // let the panel switch to the reference item
  }

  /** Drop any reference selection: hide the move handle and release the gizmo if it was on it. */
  private clearRefSelection() {
    if (!this.refSelected) return;
    this.refSelected = false;
    this.refMoveHandle.visible = false;
    if (this.gizmoKind === 'reference') this.detachGizmo();
  }

  /** Host-facing facade; the cage layer owns the persistent nub pool + connector lines. */
  showHandles(corner: V3 | null, nubs: { dir: string; pos: V3 }[]) { this.cageLayer.showHandles(corner, nubs); }

  /** Toggle the pink tile-orientation F overlay on the 3D terrain (authored painted cells + reference
   *  patches). Independent of the cage; the 2D panels (Library / preview / pad) draw their own Fs. */
  set tileF(on: boolean) { this.paint.setTileF(on); }

  /** The F toggle's prop half: green facing arrows on the selected prop — a placed one (authored model or
   *  retail placement) and the reference map's read-only instance selection alike (facing-arrows.ts). */
  set propFacingArrows(on: boolean) { this.props.setNormalArrows(on); this.refDecor.setNormalArrows(on); }

  /** Selection-local collision geometry in Props mode, shared by authored and reference prop inspectors. */
  showSelectedPropCollider(on: boolean) {
    this.props.setCollisionOverlayVisible(on);
    this.refDecor.setCollisionOverlayVisible(on);
  }

  /** Toggle the control-net cage (corner lattice) - shows the bicubic-Bezier net you're shaping. */
  set cage(on: boolean) {
    this.cageLayer.setCage(on);
    this.paint.applyCageView(); // green frame Fs (built only while the F overlay is on) ride the cage
    this.applyReferenceView(); // show / hide the reference's control points too
  }

  /** Rebuild the exact edge / patch sub-cages pinned by the Edit visibility actions. */
  refreshControlCages() {
    if (!this.cageLayer.subCage) {
      if (this.gizmoKind === 'handle') this.detachGizmo();
      this.selection.clearCageHandle();
    }
    this.cageLayer.rebuildCage();
    this.cageLayer.rebuildRefCage();
    this.selection.rebuildEditCellSel();
    this.selection.rebuildEditEdgeSel();
    this.selection.rebuildControlPointCages();
    this.selection.rebuildReferenceControlPointCages();
  }

  // ---- topology surgery (docs/017): the armed tool + ghost overlay live in SurgeryLayer (this.surgery) ----

  /** Arm/disarm the mutually-exclusive loop-cut, create-patch, create-tube, or create-trail tool. */
  setSurgeryTool(tool: 'loopcut' | 'patch' | 'tube' | 'trail' | null) {
    const leavingGeneratedPreview = (this.tubeTool.active && tool !== 'tube')
      || (this.trailTool.active && tool !== 'trail');
    this.surgery.setTool(tool === 'loopcut' ? 'loopcut' : null);
    this.patchTool.setActive(tool === 'patch');
    this.tubeTool.setActive(tool === 'tube');
    this.trailTool.setActive(tool === 'trail');
    if (leavingGeneratedPreview) this.setLoftPreview(null);
    if (tool) { this.detachGizmo(); this.selection.placeCornerMarker(null); this.showHandles(null, []); }
  }

  setCreatePatchSides(sides: 3 | 4) { this.patchTool.setSides(sides); }

  get createTubePoints(): readonly V3[] { return this.tubeTool.points; }
  get createTubePreviewPoint(): V3 | null { return this.tubeTool.hover; }
  setCreateTubePreviewListener(listener: (() => void) | null) { this.createTubePreviewListener = listener; listener?.(); }

  get createTrailPoints(): readonly V3[] { return this.trailTool.points; }
  get createTrailPreviewPoint(): V3 | null { return this.trailTool.hover; }
  removeLastCreateTrailPoint() { this.trailTool.removeLast(); }
  setCreateTrailSurfaceLift(value: number) { this.trailTool.setSurfaceLift(value); }
  setCreateTrailPreviewListener(listener: (() => void) | null) { this.createTrailPreviewListener = listener; listener?.(); }

  /** Host-facing facade; the placement layer owns the ghost and hit policy. */
  setPasteTool(clip: MeshVertexClipboard | null) {
    if (!this.clipboardPlacement.setClip(clip)) return;
    this.detachGizmo();
    this.selection.placeCornerMarker(null);
    this.showHandles(null, []);
  }

  get pastePlacing(): boolean { return this.clipboardPlacement.active; }

  // ---- selected-edge extrusion --------------------------------------------------------------------------

  get edgeExtrusionStaged(): boolean { return this.edgeExtrusion.staged; }
  get edgeExtrusionFanMode(): boolean { return this.edgeExtrusion.fanMode; }
  get edgeExtrusionSideFlippable(): boolean { return this.edgeExtrusion.sideFlippable; }
  get edgeExtrusionSegments(): number { return this.edgeExtrusion.segments; }
  beginEdgeExtrusionStage(): boolean { return this.edgeExtrusion.beginStage(); }
  flipEdgeExtrusionSide(): boolean { return this.edgeExtrusion.flipSide(); }
  commitEdgeExtrusionStage() { this.edgeExtrusion.commitStage(); }
  cancelEdgeExtrusionStage() { this.edgeExtrusion.cancel(); }

  // ---- target-weld gesture (docs/023 S4): a two-click modal pick that fuses two control-net corners ----------

  /** Host-facing facade; the weld layer owns the two-click gesture and feedback. */
  setWeldTool(source: readonly number[] | false) {
    this.weldTool.setActive(source);
    if (source !== false) { this.detachGizmo(); this.selection.placeCornerMarker(null); this.showHandles(null, []); }
  }

  /** Display captured edge-weld sources while normal edge selection gathers the targets. */
  setEdgeWeldTool(edges: readonly [number, number][] | null) {
    this.weldTool.setEdgeActive(edges);
    if (edges?.length) { this.detachGizmo(); this.selection.placeCornerMarker(null); this.showHandles(null, []); }
  }

  /** The directed-edge handle for the live mesh doc (overrides + Bessel, or a model's flat linear cage),
   *  lazily built + cached so the curved cage and the surgery hover share one derive per doc change. */
  private meshHandle(): EdgeHandle | null {
    if (!this.preview || !this.meshDoc) return null;
    if (!this.meshEdgeHandle) this.meshEdgeHandle = docEdgeHandles(this.preview.mesh, this.meshDoc);
    return this.meshEdgeHandle;
  }

  /**
   * Stage D: light the AUTHORED terrain with a directional SSX sun (sun + sky colour) + baked cast-shadow
   * / AO, drawn UNLIT so the colour is the lighting - so shadows take the sky colour (blue / pink). Pass
   * null to restore the normal textured / tint shading. Occlusion bakes are cached (AO by geometry,
   * shadow by geometry + direction) so dragging the strength / colour controls doesn't re-bake.
   */
  setTerrainLight(opts: { dir: [number, number, number]; ambient: number; sun: number; shadow: number; ao: number; sunTint: [number, number, number]; skyTint: [number, number, number] } | null) {
    this.terrainLightOpts = opts;
    this.terrainLayer.setTerrainLight(opts);
    if (this.modelContextOn) this.contextLayer?.setTerrainLight(opts); // the session backdrop stays in step
    // Props read their key off this terrain's light, so it has to follow it — both when a sun slider moves
    // (the ground darkens under a prop that never moved) and because `setPropLight` runs BEFORE this on the
    // first application, when there is no lit terrain to sample yet. Re-picking cached bucket materials is
    // cheap enough to sit on the slider path (docs/032 · lighting).
    this.props.relightGround();
    // …and point the sun's glare, when a course has one. `dir` is the toward-light vector in DATA space and
    // the glare draws at scene root, so Z flips — the same convention `setPropLight` documents for propKey.
    if (opts) this.godRays.setSunDirection(new THREE.Vector3(opts.dir[0], opts.dir[1], -opts.dir[2]));
  }

  /**
   * The sun's GOD-RAYS: the beams that fan across the view when you look toward the sun
   * ([Trailmap: 400-rendering], the celestial-glare section; docs/049). A course opts into this — most
   * ship without one — so the settings arrive from the map rather than from any table here. Null = off.
   */
  setGodRays(course: GodRayCourse | null) {
    this.godRays.setCourse(course);
    if (course) this.godRays.setSunDirection(new THREE.Vector3(...sceneDirFromGlareAzEl(course.az, course.el)));
  }

  /** Lighting is one top-level preview. In Play it also gates the course's celestial glare; the Skybox view
   *  owns the backdrop independently. Retain the input so a mode change can re-apply it. */
  setPlayLightingVisibility(on: boolean) {
    this.lightingVisible = on;
    this.syncPlayLightingVisibility();
  }

  private syncPlayLightingVisibility() {
    this.godRays.setEnabled(this._mode !== 'play' || this.lightingVisible);
  }

  /**
   * Light PROPS (and the other Lambert scene geometry) with the authored sun, the way the export now ships
   * them: each placed prop carries per-instance `ambient + max(0, N·L)·key` authored from this sun
   * (docs/032 · lighting), so the editor can show the real lit-to-shade contrast instead of the flat studio
   * fill. Pass null to restore the studio rig — the texture-true read for judging art.
   *
   * Takes the RAW `sun` / `ambient`, not the lightmap's bake-exposed pair: prop instance lighting keeps the
   * raw authored values (like `buildLightsJson`), so previewing the baked pair would show a contrast the
   * props do not ship with.
   *
   * Brightness is absolute against the measured self-lit reference: raw factor 2 (instance ambient 256) is
   * texture-true, while a default 1.0 sun + 0.28 ambient reaches 64% before tint/ground attenuation. This is
   * intentionally allowed to look darker than the studio rig because that is the exposure the ISO ships.
   */
  /** The open project changed. Logical authored refs may repeat in the next mountain, so discard their
   * decoded GPU state before rebuilding the new document. */
  invalidateProjectAssets(): void {
    this.tiles.invalidateProjectAssets();
    this.assets.propTex.invalidateProjectAssets();
  }

  setPropLight(opts: { dir: [number, number, number]; ambient: number; sun: number;
                       sunTint: [number, number, number]; skyTint: [number, number, number] } | null) {
    const on = !!opts && opts.ambient + opts.sun > 1e-4;
    this.studioHemi.visible = this.studioSun.visible = !on;
    this.propFill.visible = this.propKey.visible = on;
    // …and point the Surface view's darkness reading at the same sun (scene/prop-shade.ts). Same toggle for
    // the same reason as the two below: with the sun on you are asking what ships, and what ships dark is a
    // fact about the sun. The studio rig is a viewing light, so with it up there is nothing to state.
    setPropShadeSun(on && opts ? opts.dir : null);
    // …and shade by the normals as STORED, the way the hardware does. Driven from here rather than wired
    // separately so the two can never disagree: with the sun on you are asking what ships, and a mesh wound
    // inside-out has to read ambient-only here exactly as it will in game. With it off, the studio rig's
    // back-face flip comes back — that is the texture-true read for judging art (docs/032 · lighting).
    this.assets.propTex.setPs2Normals(on);
    // …and read each prop's key off the ground it stands on, the way the export bakes it (docs/032 ·
    // lighting). Driven from the same toggle for the same reason: with the sun on you are asking what ships,
    // and what ships is per-prop. A rebuild is only requested when the source actually changes, since this
    // runs on every sun-slider drag.
    this.props.setGroundLightSource(on ? p => this.terrainLayer.groundLightAt(p) : null);
    if (!on || !opts) return;
    this.propFill.color.setRGB(...opts.skyTint);
    this.propFill.intensity = propPreviewIntensity(opts.ambient);
    this.propKey.color.setRGB(...opts.sunTint);
    this.propKey.intensity = propPreviewIntensity(opts.sun);
    // three aims a directional light FROM its position toward its target (the origin), and `dir` is the
    // toward-light vector, so the position IS the direction — scaled out past the world so it stays parallel.
    //
    // Z is NEGATED because this light lives at scene root while every prop it lights hangs under worldRoot,
    // which flips Z to show the game's handedness. Without the flip the sun arrives from the opposite side
    // and the editor contradicts what ships. (The terrain never needed this: its lighting is per-vertex
    // colour computed in JS against data-space normals, not a real light in the scene graph.) This mirrors
    // the "Z negated by hand" convention stage.ts uses for the interactive meshes it keeps at scene root.
    this.propKey.position.set(opts.dir[0] * 1e4, opts.dir[1] * 1e4, -opts.dir[2] * 1e4);
  }

  /** Hang a sky behind the world: the horizon panorama + its ground disc, drawn on a cylinder centred on the
   *  camera. Pass null to fall back to the flat background colour (docs/025). With no `topColor` the fill over
   *  the ring's open top is derived from the panorama and reported back through `onTopDerived`. */
  setSky(view: SkyView | null, onTopDerived?: (hex: string) => void) { this.sky.setSky(view, onTopDerived); }
  /** Re-colour the fill over the ring's open top without reloading the sky — the colour picker drags through here. */
  setSkyTopColor(hex: string | null) { this.sky.setTopColor(hex); }
  showSky(on: boolean) { this.sky.setVisible(on); }

  /** The mountain whose world-space bounds are nearest the camera. Consumers keep the current answer through
   *  a proportional dead band, so orbiting near the midpoint cannot flicker a full-screen sky backdrop. */
  get nearestMountainWorld(): SkyPreviewTarget { return this.nearestMountain; }

  onNearestMountainWorldChange(listener: ((world: SkyPreviewTarget) => void) | null) {
    this.nearestMountainListener = listener;
  }

  private syncNearestMountain(eye: THREE.Vector3) {
    let ownDistance: number | null = null;
    let refDistance: number | null = null;
    let separation = REF_LOAD_OFFSET_X;

    if (this.ownBounds) {
      this.worldRoot.updateWorldMatrix(true, false);
      this.nearestOwnWorldBounds.copy(this.ownBounds).applyMatrix4(this.worldRoot.matrixWorld);
      ownDistance = this.nearestOwnWorldBounds.distanceToPoint(eye);
    }
    if (this.refBounds) {
      this.refRoot.updateWorldMatrix(true, false);
      this.nearestRefWorldBounds.copy(this.refBounds).applyMatrix4(this.refRoot.matrixWorld);
      refDistance = this.nearestRefWorldBounds.distanceToPoint(eye);
    }
    if (ownDistance !== null && refDistance !== null) {
      this.nearestOwnWorldBounds.getCenter(this.nearestOwnCenter);
      this.nearestRefWorldBounds.getCenter(this.nearestRefCenter);
      separation = this.nearestOwnCenter.distanceTo(this.nearestRefCenter);
    }
    const hysteresis = Math.min(100, Math.max(10, separation * 0.04));
    const next = nearestSkyWorld(ownDistance, refDistance, this.nearestMountain, hysteresis);
    if (next === this.nearestMountain) return;
    this.nearestMountain = next;
    this.nearestMountainListener?.(next);
  }

  /** Toggle the baked (in-game) view: ON runs the LIGHT through the lightmap encode + GS decode (the bake's
   *  8-bit quantization + rail clamp) and rides it under the full-resolution tile (texture × baked-light) —
   *  the in-game terrain look. Because the bake is faithful, it reads ≈ the live model in textured mode (the
   *  match is WYSIWYG); the lightmap's quantization / highlight clamp is what differs. OFF is the live smooth
   *  sun model (the default). */
  setTerrainBakedView(on: boolean) {
    this.terrainBakedOn = on;
    this.terrainLayer.setTerrainBakedView(on);
    if (this.modelContextOn) this.contextLayer?.setTerrainBakedView(on);
  }

  /** The course knot under the cursor, if the course is drawn — a hidden guide has nothing to grab, so its
   *  knots don't intercept the click (the raycaster tests the meshes directly, past the hidden group). */
  private pickKnot() {
    return this.courseVisible ? this.ray.intersectObjects(this.knotMeshes, false)[0] : undefined;
  }

  /** The start/finish flag under the cursor. Tested BEFORE knots: the start flag floats above knot 0 by
   *  default, so at ground level they would fight over the same click. */
  private pickAnchor() {
    return this.courseVisible ? this.ray.intersectObjects(this.courseMarkers.handles(), false)[0] : undefined;
  }

  private syncKnots(positions: V3[], selected: number | null, selectedKnots: readonly number[], radius: number) {
    this.selected = selected;
    this.selectedKnots = new Set(selectedKnots);
    // spine + knots are scene-root (no mirrored parent), so negate Z by hand to land on the flipped terrain
    const fp = positions.map(p => [p[0], p[1], -p[2]] as V3);
    // the line follows the Catmull-Rom course curve (the exact path the bake sweeps), sampled densely,
    // instead of straight chords through the knots; the knot spheres below still sit on the raw knots.
    const curve = positions.length >= 2 ? sampleSpine(positions.map(pos => ({ pos }))).map(s => s.pos) : positions;
    const cp = curve.map(p => new THREE.Vector3(p[0], p[1], -p[2]));
    const sg = new THREE.BufferGeometry().setFromPoints(cp);
    this.spineLine.geometry.dispose();
    this.spineLine.geometry = sg;

    while (this.knotMeshes.length > positions.length) {
      const m = this.knotMeshes.pop()!;
      this.knotGroup.remove(m);
      (m.material as THREE.Material).dispose();
    }
    while (this.knotMeshes.length < positions.length) {
      const m = new THREE.Mesh(
        new THREE.SphereGeometry(1, 16, 12),
        new THREE.MeshBasicMaterial({ color: 0x71e858 }),
      );
      m.userData.knot = this.knotMeshes.length;
      this.knotMeshes.push(m);
      this.knotGroup.add(m);
    }
    fp.forEach((p, i) => {
      const m = this.knotMeshes[i];
      m.position.set(...p);
      m.scale.setScalar(radius);
      (m.material as THREE.MeshBasicMaterial).color.set(
        i === this.selected ? 0xff4d4d : this.selectedKnots.has(i) ? 0xffa43a : 0x71e858,
      );
    });
    // keep the translate gizmo on the selected knot across rebuilds (a removed knot drops it)
    if (this.gizmoKind === 'knot') {
      if (this.selected !== null && this.knotMeshes[this.selected]) this.attachGizmo(this.knotMeshes[this.selected], 'knot', this.selected);
      else this.detachGizmo();
    }
  }


  /** Frame the whole mountain isometrically from the retail course-profile side. */
  focusMountain(doc: EditDoc) {
    const C = docPositions(doc);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i + 2 < C.length; i += 3) {
      minX = Math.min(minX, C[i]); maxX = Math.max(maxX, C[i]);
      minY = Math.min(minY, C[i + 1]); maxY = Math.max(maxY, C[i + 1]);
      minZ = Math.min(minZ, C[i + 2]); maxZ = Math.max(maxZ, C[i + 2]);
    }
    if (!isFinite(minX)) { minX = 0; minZ = 0; minY = maxY = maxX = maxZ = 0; } // an empty net: frame the origin
    const center = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, -(minZ + maxZ) / 2); // data bounds -> flipped world target
    const radius = 0.5 * Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) || 100;
    // Widen the far plane to the mountain's span so a kilometre-scale map stays whole when zoomed out
    // (it isn't framed by `radius` alone - the user pulls back further). Matches the reference path.
    const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 200;
    this.authoredFar = Math.max(4000, span * 5);
    if (!this.reference) { // a loaded reference owns the far plane (its own, larger span); don't shrink it
      this.perspCam.far = this.authoredFar;
      if (this.orthoCam) this.orthoCam.far = this.authoredFar;
      this.camera.updateProjectionMatrix();
    }
    // Classic isometric elevation, from the Z side that keeps the retail course profile readable: after
    // worldRoot reflects authored Z, max-X,max-Z starts upper-right and min-X,min-Z finishes lower-left.
    const viewDir = new THREE.Vector3(1, -1, -1).normalize();
    const aspect = (this.container.clientWidth || 1) / (this.container.clientHeight || 1);
    if (this.isOrtho && this.orthoCam) {
      this.orthoCam.position.copy(center).addScaledVector(viewDir, -radius * 3);
      this.orthoCam.zoom = this.orthoHalfH / (radius * 1.15);
      this.orthoCam.updateProjectionMatrix();
    } else {
      const halfFov = (this.perspCam.fov * Math.PI) / 360; // vertical half-fov in radians
      const fit = Math.tan(halfFov) * Math.min(1, aspect); // tangent of the tighter (limiting) axis
      this.camera.position.copy(center).addScaledVector(viewDir, -(radius * 1.15) / Math.max(1e-3, fit));
    }
    this.controls.target.copy(center);
    this.camera.lookAt(center);
  }

  /**
   * Show a read-only reference quilt (an extracted level's terrain), or clear it with `null`. `map`
   * names the source so the textured view can fetch its tiles. The geometry is kept in its NATIVE editor
   * coordinates (the round-trip frame - see the refRoot comment) and the camera / far-plane are widened to
   * frame it; clearing restores the course view. The reference then obeys the same view modes as the
   * authored terrain (wireframe overlay, control points, surface-type / textured / none shading).
   */
  /** Hand over the loaded level's stable native spline table. Ride selects grind styles while effect animation
   *  resolves original table indices from the same payload, and Effects mode draws the grind rows as the
   *  level's rail network. Called right after setReference, which clears it. */
  setReferenceSplines(splines: RefSplineRaw[] | null) {
    this.refSplines = splines;
    this.refDecor.setRailSplines(splines);
  }

  setReference(data: ReferenceMesh | null, level = '', frame = true) {
    this.clearRefSelection(); // the old reference (if any) is going away; drop its move handle / gizmo
    this.selection.clearRefLoops();     // …its edge selection + cell shading
    this.paint.setSelectedRefPatch(null); // …and any read-only patch selection on it
    if (this.reference) {
      this.refRoot.remove(this.reference);
      this.reference.geometry.dispose();
      this.reference = null;
    }
    if (this.referenceBatch) {
      this.refRoot.remove(this.referenceBatch);
      for (const chunk of this.referenceChunks()) chunk.geometry.dispose();
      this.referenceBatch = null;
    }
    this.referenceBatchRefs = [];
    this.referenceBatchChunks = [];
    this.referenceBatchPatchSlots = null;
    this.referenceBatchIndexSource = null;
    this.referenceBatchPatchStarts = null;
    this.referenceBatchSliced = false;
    this.tiles.disposeBank(); // the packed pages belong to the level being replaced
    this.cageLayer.dropRefDepthMask(); // shares the reference geometry (disposed just above), so only drop the mesh
    if (this.refBox) {
      this.refRoot.remove(this.refBox);
      this.refBox.geometry.dispose();
      (this.refBox.material as THREE.Material).dispose();
      this.refBox = null;
    }
    this.cageLayer.clearRefCage();
    this.setReferenceProps(null); // a new / cleared reference drops the old level's props (scenery + rail/gem models)
    this.setReferenceEffects(null); // ...and its resource-id joins before the next Effects.json arrives
    this.setReferenceLights(null); // …and its light rig
    this.setReferenceScreens([]); // …and its detected video-screen catalog
    this.setReferenceGlints(null); // …and the sparkle that rig's lamps / flares were drawing
    this.refDecor.setCourse(null); // …and its recovered course line (the session pushes the new level's)
    this.refCourse = null;
    this.refLaps = DEFAULT_LAPS;   // …and its lap count, likewise re-pushed by the session
    this.refShowoffSeconds = DEFAULT_SHOWOFF_SECONDS; // …and its showoff clock
    this.refDecor.setAiPaths(null); // …and its AI-path network (likewise re-pushed by the session)
    this.refAiPaths = null;
    this.refDecor.setPropRigLighting(null, 0); // …and the prop tint (rebuilt when the new level's rig loads)
    this.refData = data;
    this.sel.refHiddenQuads = [];
    this.sel.refControlCageEdges = [];
    this.sel.refControlCageQuads = [];
    this.selection.refreshReferenceHiddenSets();
    this.setReferenceSplines(null); // per-level; the loader hands the new level's table in right after
    this.referenceControlPoints = data ? this.referenceControlPointList(data) : [];
    this.sel.refControlSel = [];
    this.refLevel = level;
    this.selection.resetReferenceCache(); // the reference QuadMesh changed — its cached adjacency is stale
    this.selection.clearRefEdges();       // ...and any edge selection into the old reference
    this.paint.rebuildRefF(); // the F overlay follows the reference: cleared on unload, rebuilt for the new data
    this.refLightingOn = false; // a freshly loaded reference starts on its normal shading
    this.refLightColors = null;
    if (!data) {
      this.cageLayer.hideRefCage();
      this.refRoot.position.set(0, 0, 0); // drop the comparison offset
      this.refBounds = null;
      this.refCenter = null;
      this.camera.far = this.authoredFar; // restore the far plane sized to the authored mountain
      this.camera.updateProjectionMatrix();
      return;
    }
    const cx = (data.min[0] + data.max[0]) / 2;
    const cy = (data.min[1] + data.max[1]) / 2;
    const cz = (data.min[2] + data.max[2]) / 2;
    // keep the geometry in NATIVE editor coordinates; refRoot flips Z about cz below to show game chirality
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(data.colors, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(data.indices, 1));
    this.reference = new THREE.Mesh(g, this.referenceMat);
    this.refRoot.add(this.reference);

    // Render-only texture batching. Its attributes intentionally share the picking mesh's immutable buffers;
    // only the index differs. Texture slots are stable before images load, so each async tile completion swaps
    // materials without rebuilding/copying this multi-megabyte index again.
    const batch = buildReferenceBatchLayout(data.indices, data.positions, data.patchTex, data.facesPerPatch, level);
    // One mesh per grid cell, all sharing this single index buffer (and the picking mesh's attributes), so the
    // whole quilt is still ONE upload of each buffer: a chunk is a cheap descriptor over shared memory that
    // draws only the groups it owns. Splitting it is what makes the quilt cullable at all — see the builder.
    const index = new THREE.BufferAttribute(batch.indices, 1);
    const chunks = new THREE.Group();
    chunks.name = 'reference-terrain-chunks';
    for (const chunk of batch.chunks) {
      const bg = new THREE.BufferGeometry();
      for (const name of ['position', 'normal', 'color', 'uv']) bg.setAttribute(name, g.getAttribute(name));
      bg.setIndex(index);
      // Groups are (re)written by applyReferenceMaterial, which knows which slots the packed bank covers and
      // can therefore merge a whole cell's neighbouring ranges into one draw. Chunk order matches batch.chunks.
      // Seat the cell's own bounds explicitly. Left to compute them, each chunk would measure the SHARED
      // position attribute — the whole map — claim the whole map, and cull exactly nothing.
      bg.boundingBox = new THREE.Box3(
        new THREE.Vector3(chunk.min[0], chunk.min[1], chunk.min[2]),
        new THREE.Vector3(chunk.max[0], chunk.max[1], chunk.max[2]),
      );
      bg.boundingSphere = bg.boundingBox.getBoundingSphere(new THREE.Sphere());
      chunks.add(new THREE.Mesh(bg, this.referenceMat));
    }
    this.referenceBatchRefs = batch.textureRefs;
    this.referenceBatchChunks = batch.chunks;
    this.referenceBatchPatchSlots = batch.patchSlots;
    this.referenceBatchIndexSource = batch.indices;
    this.referenceBatchPatchStarts = batch.patchStarts;
    this.referenceBatchSliced = false;
    this.referenceBatch = chunks;
    this.refRoot.add(chunks);
    this.applyHiddenReferenceIndex();
    this.cageLayer.setRefDepthMask(g); // invisible depth stand-in for cage-only view
    this.cageLayer.buildRefCage(data);

    const refX = data.max[0] - data.min[0];
    this.refCenter = [cx, cy, cz];                         // native centre (camera target)
    // load the reference a fixed shift up the +X (red) axis, clear of the authored mountain; drag its
    // centre handle (Info mode) to move it anywhere else — including back onto its native coordinates.
    this.refRoot.position.set(REF_LOAD_OFFSET_X, 0, 0);
    this.placeRefHandle();                                 // ready the (hidden) centre move handle on the new reference

    // Box the reference at its native extent so it reads at a glance (shown only while it's the selected item),
    // and retain the same bounds for the camera-nearest Skybox handoff.
    this.refBounds = new THREE.Box3(
      new THREE.Vector3(data.min[0], data.min[1], data.min[2]),
      new THREE.Vector3(data.max[0], data.max[1], data.max[2]),
    );
    this.refBox = new THREE.Box3Helper(
      this.refBounds,
      new THREE.Color(0x3a6ea5));
    this.refBox.visible = this.refBoxVisible; // honour the panel's selection state across reloads
    this.refRoot.add(this.refBox);

    const span = Math.max(refX, data.max[1] - data.min[1], data.max[2] - data.min[2]) || 200;
    this.camera.far = Math.max(this.authoredFar, span * 5); // widen the clip plane to the reference span either way
    this.camera.updateProjectionMatrix();
    if (frame) { // frame the reference's box where it loaded (worldRoot flips Z, so the world target is at -cz)
      const target = new THREE.Vector3(cx + REF_LOAD_OFFSET_X, cy, -cz);
      this.controls.target.copy(target);
      this.camera.position.set(target.x + span * 0.6, target.y + span * 0.55, target.z - span * 0.6);
      this.camera.lookAt(target);
    }

    this.applyReferenceMaterial();
    this.applyReferenceView();
  }

  /** The authored corner / edge / cell selections resolved onto the live document (docs/039). The substrate
   *  names its geometry so a selection survives a topology edit; the layers that draw, pick and freeze it all
   *  want indices, and this is where the two meet. */
  private selectedCornerIndex(): number | null {
    return this.meshDoc && this.sel.selectedCorner !== null ? vertexIndex(this.meshDoc, this.sel.selectedCorner) : null;
  }

  private selectedEdgeIndices(): [number, number][] {
    return this.meshDoc ? edgeIndices(this.meshDoc, this.sel.edgeSel) : [];
  }

  private selectedCellIndices(): number[] {
    return this.meshDoc ? quadIndices(this.meshDoc, this.sel.cellSel) : [];
  }

  /** Build the read-only twin of core/meshControlPoints from the reference's recovered exact primitives. */
  private referenceControlPointList(data: ReferenceMesh): MeshControlPoint<number>[] {
    const out: MeshControlPoint<number>[] = [];
    for (let vertex = 0; vertex < data.cornerPts.length / 3; vertex++) {
      const i = vertex * 3;
      out.push({ id: { kind: 'vertex', vertex }, pos: [data.cornerPts[i], data.cornerPts[i + 1], data.cornerPts[i + 2]], anchorVertex: vertex });
    }
    const seen = new Set<string>();
    for (const [A, B, C, D] of data.mesh.quads) for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as [number, number][]) {
      if (a === b) continue;
      for (const [from, to] of [[a, b], [b, a]] as [number, number][]) {
        const key = `${from}>${to}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const i = from * 3, h = data.edgeHandle(from, to);
        out.push({ id: { kind: 'edge', from, to }, pos: [data.cornerPts[i] + h[0], data.cornerPts[i + 1] + h[1], data.cornerPts[i + 2] + h[2]], anchorVertex: from });
      }
    }
    for (let quad = 0; quad < data.mesh.quads.length; quad++) for (let corner = 0 as 0 | 1 | 2 | 3; corner < 4; corner = (corner + 1) as 0 | 1 | 2 | 3) {
      out.push({ id: { kind: 'twist', quad, corner }, pos: data.patchControls[quad][INTERIOR_CP[corner]] as V3, anchorVertex: data.mesh.quads[quad][corner] });
    }
    return out;
  }

  // reference decorations (props / trick models / rig tint) live in ReferenceDecor (this.refDecor)
  setReferenceProps(props: LevelProps | null) {
    this.refDecor.setProps(props);
    this.applyReferencePropAudio(props);
    // Effects and the multi-megabyte prop payload load independently. If Effects won the race, the prop rebuild
    // has just replaced its runtime matrices; reassert the already-selected setup mode on those fresh draws.
    if (props && this._mode === 'play' && this.rideCtl.playTarget === 'reference'
      && !this.rideCtl.riding && !this.rideCtl.watching && !this.rideCtl.xrPresenting)
      this.referenceEffects.beginPlay('reference', this.raceMode);
  }
  async setReferencePropsProgressive(props: LevelProps | null, yieldControl: () => Promise<void>) {
    const level = props?.level ?? 'cleared';
    this.applyReferencePropAudio(props);
    await runDiagnosticPhaseAsync('props', `${level}:scene-build`,
      () => this.refDecor.setPropsProgressive(props, yieldControl),
      props ? `${props.models.length} models · ${props.instances.length} instances` : undefined);
    if (props && this._mode === 'play' && this.rideCtl.playTarget === 'reference'
      && !this.rideCtl.riding && !this.rideCtl.watching && !this.rideCtl.xrPresenting)
      this.referenceEffects.beginPlay('reference', this.raceMode);
  }

  /**
   * Hand the effects runtime the level's prop-owned audio — collision one-shots and the placed ambience from
   * `Sounds.ExternalSounds`. Both live on prop instances rather than in the effects document, so they are pushed
   * from this payload instead of setReferenceEffects. Ambient event 0 is the native silent sentinel and is
   * dropped for the same reason the sound-source markers drop it.
   */
  private applyReferencePropAudio(props: LevelProps | null) {
    // Collision one-shots and collider geometry share this payload and sourceIndex. Register them together so
    // a late/missing Effects.json cannot turn a physical prop silent while the independently loaded ambience
    // continues to play.
    this.referenceEffects.setReferencePropSounds(props?.level ?? '', props?.instances ?? []);
    const sources: AmbientSoundSource[] = [];
    for (const inst of props?.instances ?? [])
      inst.externalSounds.forEach((emitter, slot) => {
        if (emitter.sound === 0) return;
        sources.push({
          key: `${inst.sourceIndex}:${slot}`,
          emitter,
          owner: referenceOwnerKey(inst.sourceIndex),
          center: [
            inst.loc[0] + emitter.offset[0],
            inst.loc[1] + emitter.offset[1],
            inst.loc[2] + emitter.offset[2],
          ],
        });
      });
    this.refAmbience = sources;
    this.ambienceLevel = props?.level ?? '';
    this.pushPlacedAmbience();
  }

  /**
   * The AUTHORED half of the same bed. A placement's ambience is the same kind of thing a reference
   * instance's is — it exports to the identical `Sounds.ExternalSounds` record — so it belongs in the field
   * rather than in a preview of its own. Measured in raw centimetres like every other voice, which is why
   * the region comes through `authoredAmbientRecord`: editor `(x, y, z)` is native `(x, z, y)`, and the bed
   * would otherwise hear an ellipsoid on the wrong axes from the one the viewport outlines.
   *
   * Carrying the prop's own `level` matters because a placement keeps the bank of the level its model came
   * from, which need not be the reference level currently loaded — or any level at all on an authored-only
   * mountain, where an uploaded WAV supplies the clip directly.
   */
  private applyAuthoredAmbience(props: readonly PlacedProp[]) {
    const sources: AmbientSoundSource[] = [];
    const claims = this.meshDoc?.hitGatedSounds;
    for (const prop of props) {
      // A claimed WAV carries the gated event it took over, so the bed gates it through the ordinary id test
      // rather than needing a second notion of "gated" threaded down here.
      const event = authoredAmbientEvent(prop.ambientSound, prop.ambientSoundFile, claims);
      if (!prop.id || (event < 0 && !prop.ambientSoundFile)) continue;
      sources.push({
        key: `authored:${prop.id}`,
        emitter: {
          type: prop.ambientHalfExtents ? 1 : 0,
          sound: event,
          offset: [0, 0, 0],
          params: authoredAmbientRecord({
            event,
            radius: prop.ambientRadius ?? AUTHORED_AMBIENT_DEFAULT_M,
            falloff: prop.ambientFalloff,
            halfExtents: prop.ambientHalfExtents,
          }),
        },
        owner: authoredOwnerKey(prop.id),
        // Handed over in EDITOR metres. The bed converts it into the frame the listener is measured in,
        // which is the reference holder's — and that holder carries a comparison offset this does not.
        center: prop.pos,
        space: 'editor',
        level: prop.level,
        ...(prop.ambientSoundFile ? { file: prop.ambientSoundFile } : {}),
      });
    }
    this.authoredAmbience = sources;
    this.pushPlacedAmbience();
  }

  /** Reference and authored ambience arrive from different payloads at different times; the bed takes one
   *  list, so both are held and re-pushed together rather than each clobbering the other. */
  private pushPlacedAmbience() {
    this.referenceEffects.setPlacedAmbience(this.ambienceLevel,
      [...this.refAmbience, ...this.authoredAmbience]);
  }
  /** The two halves of the placed-ambience bed, held so either can be replaced without dropping the other. */
  private refAmbience: AmbientSoundSource[] = [];
  private authoredAmbience: AmbientSoundSource[] = [];
  private ambienceLevel = '';
  /** What the placed-ambience bed is sounding right now, loudest first. */
  placedAmbienceVoices() { return this.referenceEffects.placedAmbienceVoices(); }
  setPropRigLighting(rig: LightRig | null, strength: number) { this.refDecor.setPropRigLighting(rig, strength); }
  showReferenceProps(on: boolean) { this.refDecor.showProps(on); }
  showReferenceTricks(on: boolean) { this.refDecor.showTricks(on); }
  hasReferenceProps(): boolean { return this.refDecor.hasProps(); }

  // ---- reference LIGHT + SOUND SOURCES: mechanics in ReferenceDecor (this.refDecor) ----

  setReferenceLights(rig: LightRig | null) { this.refDecor.setLights(rig); }
  /** The loaded reference's own glints — its lamps and flares, gated by the engine's own `SpriteRes & 0x70`
   *  (docs/047). Separate from `setReferenceLights` because the sparkle is the light's OUTPUT: it shows with
   *  effective Local lights whether or not the Sources bulbs have ever been asked for. */
  setReferenceGlints(rig: LightRig | null) { this.glints.setReference(rig); }
  /** The loaded reference's recovered main course line (editor-space points), drawn over its terrain in
   *  the authored guide's style (line + path-point beads, no knot handles); shows with the Info-mode
   *  course guide. `anchors` marks where the level's race really starts and ends — neither of which is an
   *  end of this line. `null` clears it. */
  setReferenceCourse(points: V3[] | null, anchors?: RefCourseAnchors | null) {
    this.refCourse = points;
    this.refAnchors = anchors ?? null;
    this.refDecor.setCourse(points, anchors);
  }
  /** How many passes the loaded reference level is raced over — what a reference Play counts down, and what
   *  gates its lap-gated boost volumes (core/doc/race). */
  setReferenceLaps(laps: number) { this.refLaps = laps; }
  setReferenceShowoffSeconds(seconds: number) { this.refShowoffSeconds = seconds; }
  /** The loaded reference's AI-path network (editor-space, off its AIP.json): drawn over its terrain on the
   *  Info "Show AI paths" toggle — gate paths amber, the rest violet — and kept for the test ride's AI field.
   *  `null` clears it. */
  setReferenceAiPaths(paths: RefAiPath[] | null) {
    this.refAiPaths = paths;
    this.refDecor.setAiPaths(paths);
  }
  showReferenceLights(on: boolean) { this.refDecor.showLights(on); }
  hasReferenceLights(): boolean { return this.refDecor.hasLights(); }
  clearRefPropSelection() { this.refDecor.clearPropSelection(); }

  // ---- authored + free local lights (docs/013): mechanics in LightsLayer (this.lights) ----

  setAuthoredLights(lights: PlacedLight[]) {
    this.lights.setAuthoredLights(lights);
    this.glints.setAuthored(this.lights.authoredRigData); // a light given a glint class sparkles at once (docs/047)
  }
  /** Local lights is the LIGHT a source casts, and a glint is exactly that — the sparkle the engine draws
   *  straight from the light table — so it rides Lighting rather than the Sources rigging view (docs/047). */
  showAuthoredLights(on: boolean) {
    this.lights.showAuthoredLights(on);
    this.glints.show(on);
  }
  showAuthoredLightRig(on: boolean) { this.lights.showAuthoredLightRig(on); }
  hasAuthoredLights(): boolean { return this.lights.hasAuthoredLights(); }
  setLightArmed(on: boolean) {
    if (on) this.refDecor.clearSourceSelection();
    this.lights.setArmed(on);
    this.setArmedPlacement(on ? 'light' : null);
  }
  get lightPlacing(): boolean { return this.lights.lightPlacing; }
  setFreeLights(lights: AuthoredLight[], selectedId: string | null) { this.lights.setFreeLights(lights, selectedId); }

  // ---- authored grind rails (docs/014): mechanics in RailsLayer (this.rails); shell keeps selection ----

  setRailArmed(on: boolean) { this.rails.setArmed(on); this.setArmedPlacement(on ? 'rail' : null); }
  setRails(rails: Rail[], selRail: number | null, selNode: number | null) { this.rails.setRails(rails, selRail, selNode); }
  setRailSkin(skin: { level: string; tex: string }) { this.rails.setSkin(skin); }
  /** Purple, non-grind spline guides belong to Effects mode rather than the Tricks visibility filter. */
  showEffectMotionPaths(on: boolean) { this.rails.setMotionPathsVisible(on); }
  /** Draw every grind rail's surface-coloured centreline while Effects mode is up — the curves its nodes bind to. Both
   *  worlds answer: the mountain's own rails, and the loaded reference's shipped `Splines.json` grind rows,
   *  which are the only place that level's rails exist (its tubes are unjoined prop instances, docs/014). */
  showEffectRails(on: boolean) {
    this.rails.setEffectRails(on);
    this.refDecor.showRailSplines(on);
    if (!on) this.refDecor.selectRailSpline(null);
  }
  /** Brighten the shipped grind curve the Effects panel is inspecting; null clears the highlight. */
  selectReferenceRailSpline(originalIndex: number | null) { this.refDecor.selectRailSpline(originalIndex); }
  /** One reference spline's native row — its style, and its raw controls for measuring what sits along it. */
  referenceSplineRow(originalIndex: number): RefSplineRaw | null {
    return this.refSplines?.find(candidate => candidate.originalIndex === originalIndex) ?? null;
  }

  // ---- mesh-native Create Edge ------------------------------------------------------------------

  setCreateEdgeTool(on: boolean, start: V3 | null) { this.createEdge.setArmed(on, start); this.createEdgePreviewListener?.(); }
  setCreateEdgeStart(start: V3 | null) { this.createEdge.setStart(start); this.createEdgePreviewListener?.(); }
  setCreateEdgePath(points: readonly V3[]) { this.createEdge.setPath(points); this.createEdgePreviewListener?.(); }
  /** Live free-edge endpoint preview, consumed by the toolbox length summary. */
  get createEdgePreviewPoint(): V3 | null { return this.createEdge.hover; }
  setCreateEdgePreviewListener(listener: (() => void) | null) { this.createEdgePreviewListener = listener; listener?.(); }
  get createPatchPoints(): readonly V3[] { return this.patchTool.points.map(point => point.pos); }
  get createPatchPreviewPoint(): V3 | null { return this.patchTool.hover?.pos ?? null; }
  setCreatePatchPreviewListener(listener: (() => void) | null) { this.patchTool.setPreviewListener(listener); }

  // ---- gem pickups (docs/014) -------------------------------------------------------------------

  setGemArmed(on: boolean, opts?: { value: number; height: number }) {
    this.gems.setArmed(on, opts);
    this.setArmedPlacement(on ? 'gem' : null);
  }
  setGemModels(models: Map<number, { level: string; model: number }>) { this.gems.setModels(models); }

  /** Show / hide the whole Tricks layer (rails + gems) as a unit — the top-bar Tricks view filter. */
  showTricks(on: boolean) {
    this.rails.setVisible(on);
    this.gems.setVisible(on);
  }

  setGems(gems: Gem[], selectedId: string | null) { this.gems.setGems(gems, selectedId); }

  // ---- video screens (docs/051) -----------------------------------------------------------------

  /** The document's screens, resolved against its placements — an attached screen is stored in its board's
   *  own frame, so the props have to come along. */
  setScreens(screens: Screen[], props: PlacedProp[] | undefined, selectedId: string | null) {
    this.screens.setScreens(screens, props, selectedId);
  }

  /** The loaded reference course's own measured screens (its `Billboards.json`), drawn read-only. */
  setReferenceScreens(draws: readonly ScreenDraw[]) { this.screens.setReference(draws); }
  clearScreenSelection() { this.screens.clearSelection(); }

  /** Show / hide screen authoring rigging under Sources. Active Jukebox video remains independently visible. */
  showScreens(on: boolean) { this.screens.setVisible(on); }

  // ---- authored placed props (Props mode): asset caches in PropAssets (this.assets) --------------------

  registerPropModels(props: LevelProps) { this.assets.registerPropModels(props); }
  /** Replace-register a live pseudo-level — authored models or imported props (see PropAssets.syncLiveModels). */
  syncLiveModels(props: LevelProps) { this.assets.syncLiveModels(props); }
  hasPropGeom(level: string, model: number): boolean { return this.assets.hasPropGeom(level, model); }

  /**
   * Arm placement mode with a model (or put it down with null). While armed, a translucent ghost of the
   * model rides the cursor over the terrain — seated by `baseOffset`×scale like the real drop — and a click
   * commits it at the ghost's exact pose (onPlaceProp). The turn starts random (an unscrolled scatter doesn't
   * look stamped) and re-rolls per drop until the wheel takes manual control; the size persists across drops.
   */
  setPropArmed(arm: { level: string; model: number; baseOffset: number; group?: string } | null) {
    if (arm) this.refDecor.clearPropSelection(); // holding a prop leaves the read-only reference selection behind
    this.props.setArmed(arm);
    this.setArmedPlacement(arm ? 'prop' : null);
  }

  /** Show / hide the authored placed props (the global props toggle drives this alongside the reference props). */
  setPlacedPropsVisible(on: boolean) { this.props.setVisible(on); }

  /** Animate/deanimate always-on material/model effects and nearby persistent emitters. */
  showWorldEffects(on: boolean) {
    this.assets.propTex.setWorldEffectsEnabled(on);
    this.refDecor.setWorldEffectsEnabled(on);
    this.props.setWorldEffectsEnabled(on);
    this.gems.setWorldEffectsEnabled(on);
    this.referenceEffects.setWorldEffectsEnabled(on);
    this.particleVolumes.setWorldEffectsEnabled(on);
  }

  /** Register a level's mined group defs so placements referencing them can resolve their members. */
  registerGroupDefs(level: string, defs: GroupDef[]) { this.assets.registerGroupDefs(level, defs); }

  setPlacedProps(props: PlacedProp[], selIdx: number | null, multiSel: number[] = [], effects?: EffectsDocument | null,
    hiddenIndices?: ReadonlySet<number>) {
    this.props.setHitGatedSounds(this.meshDoc?.hitGatedSounds);
    this.props.setPlacedProps(props, selIdx, multiSel, effects, hiddenIndices);
    this.referenceEffects.setAuthoredData(props, effects);
    this.applyAuthoredAmbience(props);
  }
  /** Update only the amber outline, facing arrows, emitter range, and transform handle. Selection is not a
   * document edit, so callers use this instead of rebuilding terrain and every placed-prop mesh. */
  setPlacedPropSelection(selIdx: number | null, multiSel: number[] = []) {
    this.props.setSelection(selIdx, multiSel);
  }
  setParticleVolumes(volumes: readonly ParticleVolume[]) { this.particleVolumes.setAuthored(volumes); }

  /** Identify flash: box placed prop `index` in white for a moment, so a click in the multi-selection list
   *  points out which placement in 3D it is. */
  flashProp(index: number) { this.props.flashProp(index); }

  /** Frame one authored placed prop while keeping the current camera angle. Lists use this for their
   *  double-click shortcut; it does not change the active edit/effect selection. */
  focusProp(index: number): boolean {
    const object = this.props.placedPropMeshes[index];
    if (!object) return false;
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return false;
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.cameraCtl.frameSphere(sphere.center, Math.max(2, sphere.radius * 1.2));
    return true;
  }

  /** The reference's current offset from its native position (refRoot.position: REF_LOAD_OFFSET_X on load,
   *  or wherever its centre handle was dragged). Persisted so a reload restores the placement. */
  referenceOffset(): V3 { const p = this.refRoot.position; return [p.x, p.y, p.z]; }

  /** Restore a saved reference offset — a plain refRoot translation (overrides the load default). */
  setReferenceOffset(offset: V3) {
    if (!this.reference || !this.refCenter) return;
    this.refRoot.position.set(offset[0], offset[1], offset[2]);
    this.placeRefHandle(); // keep the (hidden) move handle on the reference's new centre
  }

  /** Number of reference corner vertices selected directly through the control-point picker. */
  referenceVertexSelectionCount(): number { return this.selection.referenceVertexSelectionCount(); }
  referenceControlPointSelectionCount(): number { return this.selection.referenceControlPointSelectionCount(); }
  /** Selected reference vertices and their ordinary topological valence (unique incident control-net edges). */
  referenceSelectedVertexInfo(): { vertex: number; valence: number }[] { return this.selection.referenceSelectedVertexInfo(); }

  /** Number of reference vertices Copy would capture from the active point, edge, or surface selection. */
  referenceCopyVertexCount(): number { return this.selection.referenceCopyVertexCount(); }

  /**
   * Capture the active reference point, edge, or surface selection through the same topology-neutral clipboard
   * core as authored geometry. The live reference translation is folded into positions; exact stored patch
   * controls recover handles + interior twist, while metadata follows every enclosed patch.
   */
  copyReferenceMeshSelection(): MeshVertexClipboard | null { return this.selection.copyReferenceMeshSelection(); }

  /**
   * The metrics of the current read-only REFERENCE control-net selection (an edge's curved length, or a cell's
   * size · drop · area), or null when nothing reference-side is picked. Measured through the SAME core as the
   * authored net (core/mesh/measure.ts) off the reference's own QuadMesh + faithful edge curves + true stored control
   * points, so the tools panel renders the identical read-out — one measurement, both surfaces.
   */
  refMeasure(): SelectionMeasure | null { return this.selection.refMeasure(); }
  authoredMeasure(): SelectionMeasure | null { return this.selection.authoredMeasure(); }

  /** Choose the reference's solid material for the current shading: textured tile groups, or tint. */
  private applyReferenceMaterial() {
    const d = this.refData;
    if (!d || !this.reference) return;
    const lit = this.refLightingOn; // a lighting view rides the colour attribute -> tiles draw unlit x it
    const g = this.reference.geometry;
    g.clearGroups();
    if (this.shading !== 'textured') {
      this.reference.material = lit ? this.refLightMat : this.referenceMat;
      return;
    }
    // The original mesh remains raycastable but submits no render item. Each stable batch slot falls back to
    // the surface/light tint until its image arrives, then swaps to the real tile without touching the index.
    this.referencePickMat.visible = false;
    this.reference.material = this.referencePickMat;
    if (!this.referenceBatch) return;
    const fallback = lit ? this.refLightMat : this.referenceMat;
    const mats: THREE.Material[] = [fallback];
    for (const ref of this.referenceBatchRefs) {
      const tex = this.tiles.ensure(ref);
      mats.push(tex ? (lit ? this.tiles.materialLit(ref, tex) : this.tiles.material(ref, tex)) : fallback);
    }
    // Once every page has settled they pack into one array texture per bank, and a slot that made the bank
    // draws through that instead of its own material (mesh/texture-array.ts). Those materials go on the END
    // of the table so the per-slot indices above stay exactly where the chunk groups expect them.
    const bank = this.tiles.ensureBank(this.refLevel, this.referenceBatchRefs);
    const arrayBase = mats.length;
    if (bank) {
      mats.push(...(lit ? bank.materialsLit : bank.materials));
      if (!this.referenceBatchSliced) this.applyReferenceSlices(bank);
    }
    // Slot -> material index. A tile in the bank resolves to its array; anything else (still loading, 404,
    // untextured, or a page too large for the bank's canonical size) keeps the per-slot entry it always had.
    const materialOf = (slot: number): number => {
      if (!slot) return 0;
      const ref = this.referenceBatchRefs[slot - 1];
      const packed = this.referenceBatchSliced ? bank?.slot(ref) : undefined;
      const materialIndex = packed ? bank?.materialIndex(ref) : undefined;
      return materialIndex === undefined ? slot : arrayBase + materialIndex;
    };
    // Rewrite each cell's draw ranges through the merge above: a cell whose tiles all made the bank becomes
    // exactly one draw, which is the entire point of packing them.
    const chunks = this.referenceChunks();
    for (let i = 0; i < chunks.length; i++) {
      const geometry = chunks[i].geometry;
      geometry.clearGroups();
      for (const group of mergeReferenceBatchGroups(this.referenceBatchChunks[i]?.groups ?? [], materialOf))
        geometry.addGroup(group.start, group.count, group.materialIndex);
      chunks[i].material = mats;
    }
  }

  /** Give every chunk the per-vertex array-slice attribute the bank's materials sample through. One shared
   *  buffer across the grid, exactly as position / normal / colour / uv already are. */
  private applyReferenceSlices(bank: TileArrayBank) {
    const data = this.refData;
    const slots = this.referenceBatchPatchSlots;
    if (!data || !slots) return;
    const slices = buildPatchSliceAttribute(
      data.indices, slots, data.facesPerPatch, data.positions.length / 3,
      slot => (slot ? bank.slot(this.referenceBatchRefs[slot - 1])?.slice ?? 0 : 0),
    );
    const attribute = new THREE.BufferAttribute(slices, 1);
    for (const chunk of this.referenceChunks()) chunk.geometry.setAttribute('texArraySlice', attribute);
    this.referenceBatchSliced = true;
  }

  /** The reference quilt's per-cell draw meshes (see `setReference`); empty when no reference is loaded. */
  private referenceChunks(): THREE.Mesh[] {
    return (this.referenceBatch?.children ?? []) as THREE.Mesh[];
  }

  /** What the ride's range gate is currently dropping, for the Play profiler and the agent layer. */
  rangeCullStats() { return this.rangeCull.stats(); }

  /** The draw-distance tier a ride is taken at (Test ▸ Draw distance). Applies to the run in progress, so
   *  the tier can be compared by eye mid-ride rather than only between rides. */
  setRideDrawDistance(tier: DrawDistance) { this.rideDrawDistance = tier; }

  /** How much snow a ride is taken through, 0 (clear) to 10 (whiteout) — Test ▸ Snow. Applies live: the field
   *  is stateless, so the dial thickens the weather around the rider without restarting anything. */
  setRideSnow(amount: number) { this.snowfall.setAmount(amount); }

  /** Test ▸ Show colliders: the world's native collision shapes near the rider, plus the rider's own probe
   *  volume ([Trailmap: 370-probe-volume]). Applies live, and is the only view of either — a prop's collider is
   *  nothing like its art and the rider's is nothing like the board. */
  setRideColliders(on: boolean) { this.rideCtl.setCollidersVisible(on); }

  /**
   * Lighting study: drive the reference solid from a per-vertex colour buffer (baked-lightmap intensity,
   * the recovered sun model, or the residual heatmap), drawn UNLIT so the colours are the data itself.
   * Pass `null` to restore the level's normal shading. Length must match the reference vertex count.
   */
  setReferenceLighting(colors: Float32Array | null) {
    if (!this.reference || !this.refData) return;
    // The caller's buffer is display-domain — the lightmap decode and the recovered model both are — so it
    // crosses into three's linear working space here, once per lighting change rather than per shade-mode
    // toggle (core/lighting/color-space). Study code keeps the display copy it fit and reports against.
    const light = colors && colors.length === this.refData.positions.length ? colors : null;
    this.refLightColors = light && lightToWorkingSpace(light);
    this.applyReferenceLightColors();
  }

  /** Compose the reference's colour attribute from the stored lighting buffer: surface view multiplies the
   *  ride-feel tint by the lighting (tint x light), textured/none let the lighting ride alone; no lighting
   *  buffer restores the level's normal surface tint. Re-runnable when the shade mode changes. Both terms are
   *  in the linear working space here — the tint always was (`SURFACE_STYLE`), the light since it crossed in
   *  `setReferenceLighting` — so the composite is one space throughout. */
  private applyReferenceLightColors() {
    if (!this.reference || !this.refData) return;
    const g = this.reference.geometry;
    const light = this.refLightColors;
    if (light) {
      this.refLightingOn = true;
      let out = light;
      if (this.shading === 'surface') { // ride-feel tint x lighting, parallel to the textured tile x lighting
        const tint = this.refData.colors;
        out = new Float32Array(light.length);
        for (let i = 0; i < light.length; i++) out[i] = light[i] * tint[i];
      }
      const color = new THREE.BufferAttribute(out, 3);
      g.setAttribute('color', color); // lighting rides the colour attribute
      // every chunk shares the one live colour buffer, exactly as they share position/normal/uv
      for (const chunk of this.referenceChunks()) chunk.geometry.setAttribute('color', color);
      color.needsUpdate = true;
    } else {
      this.refLightingOn = false;
      const color = new THREE.BufferAttribute(this.refData.colors, 3);
      g.setAttribute('color', color); // restore the surface tint
      for (const chunk of this.referenceChunks()) chunk.geometry.setAttribute('color', color);
    }
    this.applyReferenceMaterial(); // textured -> tiles x light; surface -> tint x light; none -> grey light
    this.applyReferenceView();
  }

  /** Apply the current view-mode visibilities to the reference (solid / control points). */
  private applyReferenceView() {
    const has = !!this.refData, cage = this.cageLayer.cage;
    // cage-only view draws no solid reference either, lit or not (the control points carry the shape there)
    if (this.reference) this.reference.visible = has && this.shading !== 'none';
    if (this.referenceBatch) this.referenceBatch.visible = has && this.shading === 'textured';
    this.cageLayer.applyRefView(); // the reference cage + its depth mask (rebuilt when occlusion changes)
    this.selection.applyRefView(has, cage); // the reference selection overlays ride the cage toggle too
    this.paint.applyRefView(); // green frame Fs ride the reference cage
  }

  private resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    // While a headset is presenting, the drawing buffer belongs to the device: `setSize` refuses it and warns,
    // and the panel collapsing behind the wearer would otherwise fire the observer repeatedly.
    if (!this.renderer.xr.isPresenting) {
      if (this.captureSize) {
        this.renderer.setDrawingBufferSize(this.captureSize[0], this.captureSize[1], 1);
        this.renderer.domElement.style.width = '100%'; this.renderer.domElement.style.height = '100%';
      } else this.renderer.setSize(w, h);
    }
    // fat-line materials (the F overlay + selection outlines) rasterise in pixels, so they need the live
    // canvas resolution
    for (const grp of [...this.paint.fatLineGroups, ...this.selection.fatLineGroups])
      grp.traverse(o => { const m = (o as LineSegments2).material; if (m instanceof LineMaterial) m.resolution.set(w, h); });
    this.assets.propOutlineMat.resolution.set(w, h);
    this.assets.effectOutlineMat.resolution.set(w, h);
    this.refDecor.selectionOutlineMat.resolution.set(w, h);
    for (const mat of this.rails.guideMaterials) mat.resolution.set(w, h);    // the surface-coloured grind curves
    for (const mat of this.refDecor.railSplineMaterials) mat.resolution.set(w, h); // …and the reference's own
    for (const mat of this.referenceEffects.boostArrowMaterials) mat.resolution.set(w, h);
    const aspect = w / h;
    // keep both cameras valid so the projection toggle never sees a stale aspect
    this.perspCam.aspect = aspect;
    this.perspCam.updateProjectionMatrix();
    if (this.orthoCam) {
      this.orthoCam.left = -this.orthoHalfH * aspect;
      this.orthoCam.right = this.orthoHalfH * aspect;
      this.orthoCam.top = this.orthoHalfH;
      this.orthoCam.bottom = -this.orthoHalfH;
      this.orthoCam.updateProjectionMatrix();
    }
  }

}

const playerVector = (v: THREE.Vector3): PlayerVec3 => [v.x, v.y, v.z];
const playerTransform = (p: THREE.Vector3, q: THREE.Quaternion): PlayerTransform =>
  ({ p: playerVector(p), q: [q.x, q.y, q.z, q.w] });
