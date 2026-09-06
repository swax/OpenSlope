import type { NativeCollisionProfile, PlacedProp, QuadMeshDoc } from '../../../core/doc/types';
import type {
  BrushDir,
  BrushFalloff,
  BrushOp,
  FlattenMode,
  FlattenPlaneBehavior,
} from '../../../core/doc/mountain';
import type { GroupDef } from '../../../core/reference/groups';
import type { LevelProps } from '../../../core/reference/props';
import type { EffectsEditor } from '../../effects/editor';
import type { EditSession } from '../../edit/session';
import type { Palette } from '../../paint/palette';
import type { TextureLibrary } from '../../paint/library';
import type { PropLibrary } from '../../props/library';
import type { PropPreview } from '../../props/preview';
import type { Play } from '../../ride/play';
import type { Store } from '../../state/store';
import type { Viewport } from '../../viewport/viewport';

export type ToolsPanelDeps = {
  store: Store;
  viewport: Viewport;
  edit: Pick<EditSession,
    | 'deselectEdit' | 'copySelectedVertices' | 'cutSelectedVertices' | 'copySelectionVertexCount'
    | 'hideSelectedMesh' | 'showAllHidden' | 'hiddenMeshCount'
    | 'toggleSelectedControlCages' | 'selectedControlCagesVisible' | 'hideSubCages' | 'controlCageCount' | 'canEditCurvature'
    | 'selectedPatchLockState' | 'toggleSelectedPatchLocks'
    | 'labelsAvailable' | 'labelRows' | 'selectedLabelTargets' | 'selectedLabelState' | 'setSelectedLabel'
    | 'createLabel' | 'renameLabel' | 'deleteLabel' | 'selectLabel'
    | 'narrowEditSelection' | 'rotatableSelection' | 'setGizmoMode'
    | 'selectConnected' | 'selectOverlappingVertices'
    | 'deleteSelectedMesh' | 'dissolveSelectedMesh' | 'flipSelectedMesh' | 'meshDeleteTargetCount' | 'canDeleteMeshSelection'
    | 'pasteSelectedVertices' | 'canPasteVertices' | 'cancelPastePlacement'
    | 'ripEdges' | 'insertCellEdge' | 'resetCellShape' | 'creaseVertices' | 'smoothVertices'
    | 'startBridge' | 'addBridgeRail' | 'reverseBridgeRail' | 'removeBridgeRail' | 'moveBridgeRail'
    | 'completeBridge' | 'cancelBridge' | 'bridgeCandidate' | 'armCreateEdge' | 'armCreatePatch' | 'finishCreatePatch' | 'finishCreateEdge'
    | 'armCreateTube' | 'previewCreateTube' | 'finishCreateTube' | 'cancelCreateTube'
    | 'armCreateTrail' | 'previewCreateTrail' | 'undoCreateTrailPoint' | 'finishCreateTrail' | 'cancelCreateTrail'
    | 'beginEdgeExtrusion' | 'flipEdgeExtrusionSide' | 'commitEdgeExtrusion' | 'cancelEdgeExtrusion'
    | 'beginPointWeld' | 'cancelPointWeld' | 'commitPointWeld' | 'commitPointWeldTogether'
    | 'beginEdgeWeld' | 'cancelEdgeWeld' | 'commitEdgeWeld'
    | 'weldSelectedEdgeCrossing' | 'weldSelectedCoincidentVertices'>;
  // shared widgets (created by the host, mounted into / driven from this panel)
  palette: Palette;
  propPreview: PropPreview;
  propLib: PropLibrary;
  library: TextureLibrary;
  propLibToggle: HTMLElement;
  // mutable tool config, shared with the host's arm / apply code
  brush: { op: BrushOp; dir: BrushDir; falloff: BrushFalloff; flattenMode: FlattenMode;
    flattenPlaneBehavior: FlattenPlaneBehavior; radius: number; strength: number;
    smoothAmount: number; flattenAmount: number; pushAmount: number };
  gemTool: { height: number; spacing: number; value: number };
  // the Info-mode Scene block (owned by the scene panel) shown in place of the Tools gui
  showScene: (visible: boolean) => void;
  /** Whether Users mode holds the dock (docs/038). It is a mode like any other as far as this panel is
   *  concerned — it owns the right dock while it is on — but it is about the server rather than the map, so
   *  it lives beside the numbered row and its panel is the users module's own. */
  usersActive: () => boolean;
  // top-bar pills this panel keeps in sync
  refreshShowFilters: () => void;   // the Props / Tricks show pills
  syncAddTrickBtns: () => void;     // the Add rail / gem / light pressed highlight
  // shared editor ops + reads
  persistUi: () => void;
  cageActive: () => boolean;
  scheduleRebuild: () => void;
  clearPaintSel: () => void;
  syncPropLibBtn: () => void;
  syncDockTabs: () => void;        // the bottom-edge pull-up tabs for the two hidden libraries
  getRefLevel: () => string;
  propLevels: Map<string, LevelProps>;
  groupDefIdx: Map<string, GroupDef>;
  /** Refetch the imported catalogue and re-render placements against it — what an edit to an imported
   *  model's own record (its materials) needs before the viewport can show the change. */
  reloadImportedProps: () => Promise<unknown>;
  /** Set an authored model's single uniform tile. A document edit, unlike the catalogue-level material
   *  table an imported model carries. */
  setAuthoredModelTexture: (model: number, ref: string) => void;
  /** Set an authored model's flipbook state list, headed by that tile. */
  setAuthoredModelFrames: (model: number, frames: readonly string[]) => void;
  // multi-select list callbacks
  identifyMultiProp: (index: number) => void;
  removeFromMultiSel: (index: number) => void;
  // prop helpers
  defOfPlaced: (pp: PlacedProp) => GroupDef | null;
  placedBaseOffset: (pp: { level: string; model: number; group?: string }) => number;
  shortPropName: (n: string) => string;
  propBaseOffset: (level: string, model: number) => number;
  // arm
  armProp: (level: string, model: number, name: string,
    contact?: { nativeCollision?: NativeCollisionProfile; sourceIndex?: number;
      solid?: boolean; bounce?: number; surface?: number; modePresence?: 'showoff' }) => Promise<void>;
  armGroupById: (level: string, id: string,
    contact?: { nativeCollision?: NativeCollisionProfile; solid?: boolean; bounce?: number; surface?: number;
      modePresence?: 'showoff' }) => Promise<void>;
  deselectPropOrLight: () => void;
  /** Leave the rail / gem / light placement tools for the idle Prop Tools launcher they were entered from. */
  cancelPlacement: () => void;
  /** Free-light placement defaults — what the next hand-placed light drops as (main.ts owns the object). */
  lightTool: { kind: 'point' | 'spot'; color: string; intensity: number; reach: number; cone: number; glint: number };
  // play controller (built after this panel — reached lazily so buildPlayTools can wire its buttons)
  getPlay: () => Play;
  // model editing (Edit mode): create / enter / leave / revise the authored polygon model session (main.ts owns it)
  modelEdit: {
    create: () => void;
    /** Open a model's edit session; with `atIndex` the definition rebases onto that placement first. */
    enter: (id: string, atIndex?: number) => void;
    exit: () => void;
    rename: (name: string) => void;
    setTexture: (ref: string) => void;
    /** Raise the Texture Library in pick mode to choose the edited model's tile off its art. */
    pickTexture: () => void;
    activeName: () => string | null;
    activeTexture: () => string | null;
    /** The D4 the session's model wears its tile at; the identity state for a model that has never turned. */
    activeOrient: () => { rot: number; mirror: boolean };
    /** Quads in the session's model — the count the banner states the prop's size with. */
    activeQuads: () => number;
    /** Turn the tile a quarter (dir −1 = CW on screen) or mirror it, as Paint's ← / → do for a brush or a
     *  painted cell. False when the model is untextured clay, so the key stays unhandled. */
    turnTexture: (dir: 1 | -1, flip: boolean) => boolean;
    /** Fork the placement's source into a `<name> v2` model, swap the placement over, enter its session. */
    createRevision: (index: number) => void;
    /** Copy a picked REFERENCE instance into this mountain's library as `<name> v2` and arm it. Nothing is
     *  placed yet in this case, so there is no placement to repoint — the copy goes on the cursor instead. */
    reviseReference: (level: string, model: number, name: string) => void;
    /** Whether the session's model has any geometry to hand over — false hides the button rather than
     *  offering an escape hatch out of an empty model. */
    canSendToBlender: () => boolean;
    /** Hand the edited model's cage to Blender (docs/046) — the escape hatch offered at the moment the mesh
     *  tools run out, rather than only from the prop library. */
    sendToBlender: () => void;
  };
  retopology: {
    isWritable: () => boolean;
    apply: (document: QuadMeshDoc) => Promise<void>;
  };
  // delete ops
  deleteSelectedProp: () => void;
  deleteMultiSelProps: () => void;
  deleteSelectedLight: () => void;
  deleteSelectedScreen: () => void;
  /** Turn the Sources view on: video screens are drawn there, so one added while it is off is invisible. */
  revealScreens: () => void;
  deleteSelectedGem: () => void;
  deleteSelectedRail: () => void;
  deleteSelectedRailNode: () => void;
  finishRail: () => void;
  effects: EffectsEditor;
  /** Jump to Effects mode; the mode switch carries the current Props selection to its effect host. A native
   * reference caller can ask to follow its first resolved Run edge directly to the receiving prop/effect. */
  goToEffects: (target?: { sourceIndex: number; called: true }) => void;
};
