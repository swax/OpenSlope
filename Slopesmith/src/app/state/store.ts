import type { NativeCollisionProfile, V3 } from '../../core/doc/types';
import type { EditDoc } from '../../core/doc/doc-edit';
import type { Brush } from '../../core/paint/textures';
import type { GizmoFrame, GizmoMode, Mode, RotationSnapStep, SnapStep } from '../viewport/viewport';
import type { StoredUi } from './storage';
import type { MeshControlPointId } from '../../core/mesh/control-points';
import type {
  NamedCoincidentVertices, NamedEdge, NamedEdgeCrossing, NamedSurfaceCutPoint, QuadName, VertexName,
} from './mesh-names';
import type { ExternalSoundEmitter } from '../../core/effects/external-sound';
import type { RigLight } from '../../core/reference/lights';
import type { ReferenceScreenPickDetails } from '../../core/reference/screens';
import {
  DEFAULT_RIDE_GEAR, DEFAULT_SNOWBOARD_STANCE, isRideGear, isSnowboardStance,
  type RideGear, type SnowboardStance,
} from '../ride/gear';
import { DEFAULT_RIDER_MODEL_ID, PROCEDURAL_RIDER_MODEL_ID } from '../ride/rider-models';
import { builtinCharacter } from '../../core/characters/builtins';
import { DEFAULT_RIDING_STYLE, ridingStyleOptions } from '../ride/stances';
import { normalizeRaceMode, type RaceMode } from '../../core/doc/race';
import {
  DEFAULT_DRAW_DISTANCE, DRAW_DISTANCE_METRES, type DrawDistance,
} from '../viewport/scene/range-cull';
import {
  DEFAULT_XR_LAYER_MODE, DEFAULT_XR_RENDER_SCALE, type XrEyeBufferMeasurement, type XrLayerMode,
} from '../ride/xr/config';
import { AMOUNT_MAX, AMOUNT_PORT } from '../../core/particles/snowfall';

/**
 * The editor's shared mutable state — the single source of truth the whole app reads and writes: the active
 * document, which run / knot / corner / prop / light / rail / gem / cell is selected, which tool is armed,
 * the current mode + play target, and the persisted view toggles. It's a plain mutable record (like the
 * viewport's Stage), not an event source: mutating a field is just an assignment; the modules that care call
 * their own rebuild afterwards. Panels + subsystems take the store directly and read `store.selectedProp`
 * rather than threading a getter per field.
 *
 * A "cell" is a grid patch address (row/col); a picked reference prop / armed library prop carry the level +
 * model that identify their art. Selection indices point into the matching `mdoc` array (props / lights /
 * rails / gems); `selected` indexes the knots of the mountain's one run.
 *
 * Everything the store remembers about the AUTHORED mesh names its geometry by the document's stable vertex
 * and quad ids (docs/039, `mesh-names.ts`) rather than by array position, because a topology edit renumbers
 * those arrays and a selection, a pinned sub-cage or a frozen drag plan has to mean the same terrain
 * afterwards. Indices are resolved where the state is derived into something that renders or computes. The
 * `ref*` families opposite are the deliberate exception: the reference mesh is rebuilt by position-dedup on
 * every load and never edited, so its numbering IS its identity and ids there would be ceremony.
 */

type RefPropRef = { level: string; model: number; name: string;
  /** Raw Models.json label. Kept as provenance because custom maps often reuse this numbered slot for new art. */
  modelName?: string;
  /** the picked instance's original Instances.json index — the effects join key (absent for model-only picks) */
  sourceIndex?: number;
  /** native LTG spatial-list membership (-1 unlisted, 0 common, 1 race list, 2 Showoff/GemIndex) */
  ltgState?: number;
  /** the picked instance's ADL hit-sound event id, -1 when it ships none (instance data, not model data) */
  collisionSound?: number;
  /** exact native contact/bounce gates */
  playerCollision?: boolean;
  playerBounce?: boolean;
  /** the picked instance's contact class: solid / movable (shove) / ride-through touch / ghost */
  contact?: 'ghost' | 'through' | 'movable' | 'solid';
  /** kickback: -1 n/a, 0 contact-only, else PlayerBounceAmmount on a solid response */
  bounce?: number;
  /** rideable SurfaceType (ride feel + board-audio family), -1 = none (obstacle handling) */
  surface?: number;
  /** collision shape (CollsionMode): 0 none, 1 mesh proxy, 2 bounding box, 3 physics-body spheres */
  shape?: number;
  /** collision response mass (native U0): exact zero pass-through, nonzero common response; -1 n/a */
  responseMass?: number;
  /** collision Roller payload scalar mass; -1 when movement is not activated */
  dynamicMass?: number;
  /** physics-pool rigid-body record (PhysicsIndex), -1 = none (static — the sim has nothing to shove) */
  physicsBody?: number;
  /** Native ADL listener-region records, including type/offset/range/curve payload. */
  externalSounds?: ExternalSoundEmitter[] };
type RefLightRef = { level: string; light: RigLight };
type RefScreenRef = { level: string; screen: ReferenceScreenPickDetails };
type ArmedProp = { level: string; model: number; name: string; group?: string;
  /** Complete inferred/explicit profile copied onto every stamped placement. */
  nativeCollision: NativeCollisionProfile; surface?: number;
  /** Semantic authoring setting; absent means the ordinary all-modes layer. */
  modePresence?: 'showoff' };

export type Store = {
  mdoc: EditDoc;                     // the active document — a quad mesh; the generators' lattice is promoted before it lands here
  selected: number | null;           // selected knot on the mountain's run
  selectedKnots: number[];           // Info-mode box-selected course knots (bulk delete; single picks use selected)

  currentMode: Mode;
  // Test mode (stored as `play`; docs/016): which mountain to ride and the world-space start point per target.
  playTarget: 'authored' | 'reference';
  playRiderModel: string;                // built-in/server-library character id, or the procedural debug body
  playRiderStyle: string;                // riding-style id from ride/stances.ts — how the rider stands
  playRideGear: RideGear;                // what they stand ON (ride/gear.ts): a snowboard, or a pair of skis
  playSnowboardStance: SnowboardStance;  // right-foot-forward goofy (original) or mirrored standard footing
  playSpawnAuthored: V3 | null;      // default = course top
  playSpawnRef: V3 | null;           // default = recovered reference course top (terrain centre fallback)
  playRaceMode: RaceMode;            // which event the next ride is: free ride (no clock), race (up), showoff (down)
  playAiPathsOn: boolean;            // AI-path overlay in Play — its own toggle, separate from Info's; default off
  playAiMax: number;                 // 0 = off; otherwise field cap, recycling the oldest when full
  playCountdownOn: boolean;          // run a reference's recovered race-start lifecycle; default off for fast iteration
  playSnowAmount: number;            // how much snow a ride is taken through (docs/050): 0 clear .. 10 whiteout
  playMusicOn: boolean;              // environment off-board + race track on-board; persisted, default on
  playGameVolume: number;            // complete gameplay mix, normalized 0..1; zero is a live master mute
  playTelemetryOn: boolean;          // automatically capture the whole next ride; manual M/F8 capture remains available
  /** Local-player carved wake and snow-contact particles; AI riders deliberately never render board FX. */
  playBoardFxOn: boolean;
  /** Draw the ride's collision shapes and the rider's own probe volume (docs/016); default off. It is a
   *  diagnostic, not a view setting: prop colliders are nothing like the art and the rider is not the board. */
  playCollidersOn: boolean;
  /** Use MSAA plus alpha-to-coverage instead of stable alpha hash for depth-writing cutouts. This one preference
   *  configures the ordinary WebGL framebuffer at app boot and the independently-created WebXR layer. */
  playSmoothCutoutsOn: boolean;
  /** VR eye-buffer scale (docs/048). Pixels go as the SQUARE of this, so it is the biggest single lever on a
   *  fill-bound headset — and, run down and back up, the fastest way to find out whether you are fill-bound at
   *  all. Applied when the session starts: WebXR fixes the buffer size at that moment. */
  playVrRenderScale: number;
  /** Last real per-eye viewport returned by this browser/headset, retained so setup can show what 1x means.
   *  Null until this browser has completed at least one immersive frame. */
  playVrEyeBuffer: XrEyeBufferMeasurement | null;
  /** Which Three/WebXR render path the next headset session must use. The effective path is measured in-headset. */
  playVrLayerMode: XrLayerMode;
  /** Initial in-headset performance-diagnostics state; the live wrist toggle persists its changes here. */
  playVrStatsOn: boolean;
  /** How far a ride draws (viewport/scene/range-cull). Cells and prop slots past it stop drawing and the
   *  haze closes over everything past 300 m, the way the engine bounded its own camera range. */
  playDrawDistance: DrawDistance;
  placingStart: boolean;             // transient: the armed ONE-shot — the next slope click moves the ride start

  // Persisted view toggles (see persistUi / StoredUi).
  cageOn: boolean;                   // control-net cage visibility (mountain)
  viewGridOn: boolean;               // XYZ world-coordinate reference grid; default off
  viewGridStep: SnapStep;            // visible orthographic drafting-grid spacing
  snapOn: boolean;                   // global world-grid snapping for move gizmos and placement tools
  snapStep: SnapStep;                // position / placement snap increment in metres
  rotationSnapStep: RotationSnapStep; // rotation snap increment in degrees
  fOverlayOn: boolean;               // the tile-orientation F overlay (3D + Library + Palette)
  courseGuideOn: boolean;            // authored Course + reference SOP/AIP path in Info; default on
  normalsOn: boolean;                // pink back-face tint that exposes the surface-normal direction; default on
  aiPathsOn: boolean;                // AI-path overlay in Info (derived opponent lines + reference AIP network); default off
  gizmoFrame: GizmoFrame;            // World axes, slope-local axes, or slope-local axes + surface sliding
  gizmoMode: GizmoMode;              // transient transform tool; every new selection returns to Move
  // Transient ordinary Edit-pick filters. All begin enabled; the top-of-toolbox Select group lets the user
  // temporarily limit point / edge / patch / prop clicks without hiding geometry or changing the current
  // selection (prop off = clicks pass through placements to the mesh beneath).
  editPickKinds: { point: boolean; edge: boolean; patch: boolean; prop: boolean };

  // Model editing (Edit): the authored polygon model whose mesh the edit stack currently targets.
  modelEditId: string | null;        // mdoc.models id being edited (null = the mountain terrain)
  modelEditDoc: EditDoc | null;      // its materialized linearCage substrate (shares the model's arrays)
  modelEditLocked: boolean;          // pinned session: clicks off the model stay in it (✔ done editing leaves)
  modelEditPlacementId: string | null; // the placement the session opened AT (rebased home) — only it hides

  // Topology surgery (Edit): which modal topology tool is armed (null = ordinary corner/cell editing).
  surgeryTool: 'loopcut' | 'patch' | 'tube' | 'trail' | null;
  createPatchQuads: QuadName[];      // patches committed during the current repeating Create Patch session
  createPatchSides: 3 | 4;           // Create Patch shape: wedge triangle or ordinary quad
  tubeWidth: number;                 // Create Tube elliptical width diameter, metres
  tubeHeight: number;                // Create Tube elliptical height diameter, metres
  tubeSectionLength: number;         // target quad length along the tube axis, metres
  tubeRingEdges: number;             // number of patch edges around each cross-section ring
  trailWidth: number;                // Create Trail rim-to-rim width, metres
  trailCenterBias: number;           // centre seam across the width: 0.5 = equal left/right lanes
  trailDishPercent: number;          // centre seam depth as a percentage of trail width
  trailPatchLength: number;          // ordinary target patch length along the centre spline, metres
  trailMaxTurnDegrees: number;       // adaptive turn cap per patch span
  trailBankGain: number;             // curvature-to-bank response distance, metres
  trailMaxBankDegrees: number;       // absolute auto-bank clamp
  trailSurfaceLift: number;          // vertical lift for knots clicked on an existing surface, metres
  trailMesaTextures: boolean;        // apply the measured Mesa matched-half/tight-turn texture preset
  // Target-weld gesture (Edit): point weld captures a selected source set, then either merges that set to
  // itself or uses normal selection for an equal-size target set; edge weld gathers a separate target set.
  weldTool: 'weld' | 'edge-weld' | null;
  weldSource: VertexName[];          // point-weld source set captured when Weld is armed; targets use normal selection
  weldEdgeSource: NamedEdge[];       // edge-weld source set; ordinary edge selection gathers equal-size targets

  // Terrain-corner selection (Edit).
  selectedCorner: VertexName | null; // single active terrain corner (handles / drag)
  anchorCorner: VertexName | null;   // range anchor: the last plainly-clicked corner a shift-click extends from
  regionSel: VertexName[];           // multi-corner selection (shift-range or box-select): bulk crease / smooth + group move
  controlSel: MeshControlPointId[];   // multi-point sub-cage selection: corners + boundary tangents + patch interiors
  cellSel: QuadName[];               // Edit-mode cell selection (shade + control-net study, like a clicked reference patch)
  anchorCell: QuadName | null;       // the plain-clicked cell a later shift-click extends from
  cellLoopSeed: QuadName | null;     // the last cell double-clicked for a face-loop select — a repeat double-click on it alternates the strip direction
  cellLoopDir: 0 | 1;                // which of the two strip directions that face-loop showed (the toggle a repeat double-click flips)
  edgeSel: NamedEdge[];              // Edit-mode edge selection = canonical vertex-name pairs (plain / ctrl-toggle / shift-range / double-click loop)
  anchorEdge: NamedEdge | null;      // the last plain / ctrl-clicked edge a shift-range extends from, along their shared loop
  selectedEdgeCrossing: NamedEdgeCrossing | null; // clicked red/amber non-connected edge-pair diagnostic
  selectedCoincidentVertices: NamedCoincidentVertices | null; // clicked unwelded pair at effectively the same position
  bridgeRails: VertexName[][] | null; // Bridge Builder: ordered, directed vertex runs already added; edgeSel is its not-yet-added candidate
  bridgePatchM: number;              // Bridge Builder target size; large gaps gain intermediate rails
  bridgeCurve: number;               // Bridge Builder connection curvature: 0 straight, 1 smooth, 2 exaggerated
  // Transient Edit visibility filters. These are deliberately not document/history data: H hides the current
  // component selection for decluttering, while Alt+H reveals everything. The control-cage action toggles the
  // exact selected patch/edge cages; "Hide sub-cages" clears the whole pinned set. Topology clears both families.
  hiddenVertices: VertexName[];
  hiddenEdges: NamedEdge[];
  hiddenQuads: QuadName[];
  controlCageEdges: NamedEdge[];
  controlCageQuads: QuadName[];

  // Read-only REFERENCE mesh selection (Edit, cage on) — the loaded reference's vertex / edge / patch picks,
  // the exact twin of the authored families above. The viewport's pick paths resolve and write these directly
  // (the store is the one owner both sides read — see MeshSelectionState). These stay INDICES into the
  // reference QuadMesh: it is rebuilt by position-dedup on every load and never edited (docs/039).
  refVertexSel: number[];
  refVertexAnchor: number | null;    // last plain/Ctrl reference vertex; Shift extends from it
  refControlSel: MeshControlPointId<number>[]; // reference sub-cage picks: corners + boundary tangents + patch interiors
  refEdgeSel: [number, number][];
  refEdgeAnchor: [number, number] | null; // the reference edge a shift-range extends from
  refCellSel: number[];              // selected reference patches
  refCellAnchor: number | null;      // the reference patch a shift-range extends from
  refCellLoopSeed: number | null;    // last patch double-clicked (drives the loop-direction toggle)
  refCellLoopDir: 0 | 1;             // which strip direction that face-loop showed
  // Reference-side transient visibility. Like the authored sets above these are editor state, not document
  // data; numeric ids are stable for the lifetime of one immutable reference mesh and clear on reload.
  refHiddenQuads: number[];
  refControlCageEdges: [number, number][];
  refControlCageQuads: number[];

  // Paint selection.
  paintBrush: Brush | null;          // active texture brush (tile w/ ride feel + orientation); null = select mode
  selectedPaintCell: QuadName | null; // paint select mode: the picked painted cell (the range anchor)
  paintMultiSel: QuadName[];         // paint select mode: added painted cells (Delete clears them all)
  selectedRefPatch: number | null;   // paint select mode: a picked REFERENCE patch (read-only inspect)

  // Prop / light / rail / gem selection + arm state (Props).
  selectedRefProp: RefPropRef | null; // props select: a picked REFERENCE prop (read-only)
  selectedRefLight: RefLightRef | null; // Sources: a picked reference bulb and its recovered read-only record
  selectedRefScreen: RefScreenRef | null; // Sources: a picked detected screen and its billboard identity
  armedProp: ArmedProp | null;        // prop (or group def, docs/015) picked from the library, ready to place
  selectedProp: number | null;        // index into mdoc.props of the selected placed prop
  multiSel: number[];                 // box-selected placed props (doc indices) — moved / deleted as a set
  selectedLight: string | null;       // id (`light:NNNN`) of the selected free light, not its array index —
                                      // deleting one below it must not move the selection onto another
  selectedRail: number | null;        // index into mdoc.rails of the rail being edited (its nodes show)
  selectedNode: number | null;        // node within selectedRail carrying the move gizmo
  railDrawing: boolean;               // the Rails tool is laying a rail: ground clicks append nodes
  selectedGem: string | null;         // id (`gem:NNNN`) of the selected gem, for the same reason
  selectedScreen: string | null;      // id (`screen:NNNN`) of the selected video screen (docs/051)
  gemArmed: boolean;                  // the Gem tool is active: click drops a gem, drag lays a row
  trickTool: 'rail' | 'gem' | null;   // which trick sub-tool is active (null = not authoring tricks)

  // Mesh-native Create Edge tool. The first click is transient; later clicks commit free edges and continue.
  createEdgeTool: boolean;
  createEdgeStart: { vertex: VertexName | null; pos: V3; edge?: NamedEdge; t?: number } | null;
  createEdgeChain: NamedEdge[];
  /** Provisional surface route. It is committed atomically only after reaching a rim edge or vertex. */
  createEdgeSurfacePath: NamedSurfaceCutPoint[];
  createEdgeSurfacePositions: V3[];

  // Layer-visibility filters (top bar).
  tricksVisible: boolean;             // the Tricks view filter — rails + gems shown as a unit; default on
  propsVisible: boolean;              // global props on/off — placed + reference props; default on
  collisionOverlayOn: boolean;        // selected prop's exact collision shape; default on
  worldEffectsVisible: boolean;       // animate always-on material/model effects + nearby persistent emitters; default off
  lightRigVisible: boolean;           // Sources overlay (legacy persistence name); off by default
  propLightsVisible: boolean;         // local-light contribution inside the master Lighting preview; default on
  skyboxVisible: boolean;             // global backdrop view; nearest mountain wins outside an explicit preview
  libraryWanted: boolean;             // Texture Library open intent — restored on entering Paint; default closed
  propLibWanted: boolean;             // Prop Library open intent — restored on entering Props; default closed
};

/** Six riders is a start gate's worth and preserves an enabled legacy setting; fresh settings use zero (off).
 *  The ceiling is a frame-rate one: every AI rider is a whole physics board on the player's terrain. */
export const DEFAULT_AI_RIDERS = 6, MAX_AI_RIDERS = 16;
/** VR eye-buffer scale bounds (docs/048). Below the floor the world stops being readable at distance; the 3×
 *  ceiling permits extreme supersampling experiments when a runtime/GPU has room. WebXR may clamp the request. */
export const MIN_VR_RENDER_SCALE = 0.5, MAX_VR_RENDER_SCALE = 3;

/** Build the store from the migrated document + boot mode + the last session's persisted view toggles. */
export function createStore(init: { mdoc: EditDoc; currentMode: Mode; storedUi: Partial<StoredUi> }): Store {
  const ui = init.storedUi;
  const step = (v: unknown): SnapStep => v === 1 || v === 10 ? v : 5;
  const rotationStep = (v: unknown): RotationSnapStep => v === 5 || v === 45 ? v : 15;
  const riderCap = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(MAX_AI_RIDERS, Math.max(0, Math.round(v))) : 0;
  // Before AI count absorbed the on/off switch, the saved max remained 6 even while `playAi` was false.
  // Honour that old boolean once; newly saved state omits it and persists zero directly.
  const aiRiders = ui.playAi === true ? Math.max(1, riderCap(ui.playAiMax) || DEFAULT_AI_RIDERS)
    : ui.playAi === false ? 0 : riderCap(ui.playAiMax);
  const vrRenderScale = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v)
      ? Math.min(MAX_VR_RENDER_SCALE, Math.max(MIN_VR_RENDER_SCALE, v)) : DEFAULT_XR_RENDER_SCALE;
  const vrEyeBuffer = (v: unknown): XrEyeBufferMeasurement | null => {
    if (!v || typeof v !== 'object') return null;
    const sample = v as Partial<XrEyeBufferMeasurement>;
    return Number.isFinite(sample.eyeWidth) && Number(sample.eyeWidth) > 0
      && Number.isFinite(sample.eyeHeight) && Number(sample.eyeHeight) > 0
      && Number.isFinite(sample.views) && Number(sample.views) > 0
      && Number.isFinite(sample.renderScale) && Number(sample.renderScale) > 0
      ? {
          eyeWidth: Math.round(Number(sample.eyeWidth)), eyeHeight: Math.round(Number(sample.eyeHeight)),
          views: Math.round(Number(sample.views)), renderScale: vrRenderScale(sample.renderScale),
          requestedScale: Number.isFinite(sample.requestedScale)
            ? vrRenderScale(sample.requestedScale) : vrRenderScale(sample.renderScale),
          nativeRenderScale: Number.isFinite(sample.nativeRenderScale) && Number(sample.nativeRenderScale) > 0
            ? vrRenderScale(sample.nativeRenderScale) : null,
          // Measurements written before nativeRenderScale existed conflated the native factor with a hard cap.
          // Drop that old hint rather than perpetuating the misleading 1x warning after this migration.
          maxRenderScale: 'nativeRenderScale' in sample
            && Number.isFinite(sample.maxRenderScale) && Number(sample.maxRenderScale) > 0
            ? vrRenderScale(sample.maxRenderScale) : null,
        }
      : null;
  };
  const savedVrEyeBuffer = vrEyeBuffer(ui.playVrEyeBuffer);
  const savedVrRenderScale = vrRenderScale(ui.playVrRenderScale);
  // Any built-in, the procedural body, or a library file name. A browser that stored a built-in Slopesmith
  // no longer ships falls back to the default rather than asking for a model that is not in the build.
  const riderModel = (v: unknown): string => {
    if (typeof v !== 'string') return DEFAULT_RIDER_MODEL_ID;
    const builtIn = builtinCharacter(v);
    if (builtIn) return builtIn.id; // canonicalizes ids saved before a built-in was renamed
    return v === PROCEDURAL_RIDER_MODEL_ID || /^[^/\\]+\.glb$/i.test(v) ? v : DEFAULT_RIDER_MODEL_ID;
  };
  // The snow dial (docs/050). It was a checkbox before it was a dial, so a browser that stored one is read
  // back as the two settings it meant rather than reset to the default — an author who had turned the weather
  // off stays turned off.
  const snowAmount = (v: unknown): number => {
    if (v === false) return 0;
    if (v === true || typeof v !== 'number' || !Number.isFinite(v)) return AMOUNT_PORT;
    return Math.min(AMOUNT_MAX, Math.max(0, Math.round(v)));
  };
  const drawDistance = (v: unknown): DrawDistance =>
    typeof v === 'string' && v in DRAW_DISTANCE_METRES ? v as DrawDistance : DEFAULT_DRAW_DISTANCE;
  // A style renamed out of the catalogue — or a hand-edited localStorage — falls back rather than posing nothing.
  const ridingStyleId = (v: unknown): string =>
    typeof v === 'string' && ridingStyleOptions().some(s => s.id === v) ? v : DEFAULT_RIDING_STYLE;
  return {
    mdoc: init.mdoc,
    selected: null,
    selectedKnots: [],
    currentMode: init.currentMode,
    playTarget: ui.playTarget === 'reference' ? 'reference' : 'authored',
    playRiderModel: riderModel(ui.playRiderModel),
    playRiderStyle: ridingStyleId(ui.playRiderStyle),
    playRideGear: isRideGear(ui.playRideGear) ? ui.playRideGear : DEFAULT_RIDE_GEAR,
    playSnowboardStance: isSnowboardStance(ui.playSnowboardStance)
      ? ui.playSnowboardStance : DEFAULT_SNOWBOARD_STANCE,
    playSpawnAuthored: null,
    playSpawnRef: null,
    playRaceMode: normalizeRaceMode(ui.playRaceMode),
    playAiPathsOn: ui.playAiPaths === true,
    playAiMax: aiRiders,
    playCountdownOn: ui.playCountdown === true,
    playSnowAmount: snowAmount(ui.playSnow),
    playMusicOn: ui.playMusic !== false,
    playGameVolume: typeof ui.playGameVolume === 'number' && Number.isFinite(ui.playGameVolume)
      ? Math.min(1, Math.max(0, ui.playGameVolume)) : 1,
    playTelemetryOn: ui.playTelemetry === true,
    playBoardFxOn: ui.playBoardFx !== false,
    playCollidersOn: ui.playColliders === true,
    playSmoothCutoutsOn: ui.playSmoothCutouts !== false,
    playVrRenderScale: savedVrRenderScale,
    playVrEyeBuffer: savedVrEyeBuffer,
    playVrLayerMode: ui.playVrLayerMode === 'projection' ? 'projection' : DEFAULT_XR_LAYER_MODE,
    playVrStatsOn: ui.playVrStats !== false,
    playDrawDistance: drawDistance(ui.playDrawDistance),
    placingStart: false,
    cageOn: ui.cageOn === true,
    viewGridOn: ui.viewGrid === true,
    viewGridStep: step(ui.viewGridStep),
    snapOn: ui.snapOn === true,
    snapStep: step(ui.snapStep),
    rotationSnapStep: rotationStep(ui.rotationSnapStep),
    fOverlayOn: ui.fOverlay === true,
    courseGuideOn: ui.courseGuide !== false,
    normalsOn: ui.normals !== false,
    aiPathsOn: ui.aiPaths === true,
    gizmoFrame: ui.gizmoFrame === 'world' || ui.gizmoFrame === 'local' ? ui.gizmoFrame : 'surface',
    gizmoMode: 'move',
    editPickKinds: { point: true, edge: true, patch: true, prop: true },
    modelEditId: null,
    modelEditDoc: null,
    modelEditLocked: false,
    modelEditPlacementId: null,
    surgeryTool: null,
    createPatchQuads: [],
    createPatchSides: 4,
    tubeWidth: 20,
    tubeHeight: 20,
    tubeSectionLength: 10,
    tubeRingEdges: 4,
    trailWidth: 13,
    trailCenterBias: 0.5,
    trailDishPercent: 10.5,
    trailPatchLength: 22.5,
    trailMaxTurnDegrees: 52,
    trailBankGain: 15,
    trailMaxBankDegrees: 20,
    trailSurfaceLift: 0.25,
    trailMesaTextures: true,
    weldTool: null,
    weldSource: [],
    weldEdgeSource: [],
    selectedCorner: null,
    anchorCorner: null,
    regionSel: [],
    controlSel: [],
    cellSel: [],
    anchorCell: null,
    cellLoopSeed: null,
    cellLoopDir: 0,
    edgeSel: [],
    anchorEdge: null,
    selectedEdgeCrossing: null,
    selectedCoincidentVertices: null,
    bridgeRails: null,
    bridgePatchM: 50,
    bridgeCurve: 1,
    hiddenVertices: [],
    hiddenEdges: [],
    hiddenQuads: [],
    controlCageEdges: [],
    controlCageQuads: [],
    refVertexSel: [],
    refVertexAnchor: null,
    refControlSel: [],
    refEdgeSel: [],
    refEdgeAnchor: null,
    refCellSel: [],
    refCellAnchor: null,
    refCellLoopSeed: null,
    refCellLoopDir: 0,
    refHiddenQuads: [],
    refControlCageEdges: [],
    refControlCageQuads: [],
    paintBrush: null,
    selectedPaintCell: null,
    paintMultiSel: [],
    selectedRefPatch: null,
    selectedRefProp: null,
    selectedRefLight: null,
    selectedRefScreen: null,
    armedProp: null,
    selectedProp: null,
    multiSel: [],
    selectedLight: null,
    selectedRail: null,
    selectedNode: null,
    railDrawing: false,
    selectedGem: null,
    selectedScreen: null,
    gemArmed: false,
    trickTool: null,
    createEdgeTool: false,
    createEdgeStart: null,
    createEdgeChain: [],
    createEdgeSurfacePath: [],
    createEdgeSurfacePositions: [],
    tricksVisible: ui.tricks !== false,
    propsVisible: ui.propsVisible !== false,
    collisionOverlayOn: ui.collisionOverlay !== false,
    worldEffectsVisible: ui.worldEffects === true,
    lightRigVisible: ui.lightRig === true,
    propLightsVisible: ui.propLights !== false,
    skyboxVisible: ui.skybox !== false,
    libraryWanted: ui.textureLib === true,
    propLibWanted: ui.propLib === true,
  };
}
