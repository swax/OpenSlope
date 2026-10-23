import type { QuadMeshDoc, V3 } from '../../core/doc/types';
import type { MeshVertexClipboard } from '../../core/mesh/clipboard';
import type { MeshControlPointId } from '../../core/mesh/control-point-types';
import type { Store } from '../state/store';
import type { TrailShape, TrailTransform } from '../viewport/tools/create-trail';
import type { CellSpeedTint } from '../viewport/types';
import type { PlacementEndpoint } from '../viewport/input/placement-constraint';
import type { GridCorners } from '../../core/mesh/ops/grid';
import type { SurfaceGuidePlacement } from '../viewport/tools/surface-guide';
import type { Patch } from '../../core/mesh/loft-surface';

export type { CellSpeedTint, TrailShape, TrailTransform };

/** Rendering/input surface used by the edit workflow. */
export interface EditViewportPort {
  previewMeshEdit(
    doc: Store['mdoc'],
    change: {
      vertices?: readonly number[];
      edges?: readonly [number, number][];
      quads?: readonly number[];
    },
  ): boolean;
  clearCornerSelection(): void;
  setControlPointSelection(ids: readonly MeshControlPointId[]): void;
  /** Whether the cage currently shows this handle / interior (a pinned control cage, not hidden). Optional on
   *  test doubles, which show every point. */
  controlPointVisible?(id: MeshControlPointId): boolean;
  setCornerGroup(positions: V3[], indices?: number[], showMarks?: boolean): void;
  setRegionMarks(positions: V3[]): void;
  setPlacedPropSelection(selIdx: number | null, multiSel?: number[]): void;
  /** Seat the shared Move / Rotate gizmo at the centroid of a mixed Edit selection. */
  setEditMixedGroup(positions: V3[], indices?: number[]): void;
  /** Clear any selection gizmo when no movable member remains. */
  detachSelectionGizmo(): void;
  narrowReferenceEditSelection(kind: 'point' | 'edge' | 'patch'): void;
  refreshEditCells(): void;
  /** Shade selected trail patches by the ride predicted over them (docs/023 · Predicted speed); null: plain yellow.
   *  Optional on test doubles, which draw nothing. */
  setEditCellSpeedTint?(tint: CellSpeedTint | null): void;
  refreshEditEdges(): void;
  refreshHiddenMesh(): void;
  refreshControlCages(): void;
  setBridgeRails(rails: readonly (readonly number[])[] | null): void;
  setLoftPreview(quads: readonly (readonly number[])[] | null, source?: readonly number[] | QuadMeshDoc | null): void;
  setSurfaceGuidePlacement?(placement: SurfaceGuidePlacement | null): void;
  setSurgeryTool(tool: 'loopcut' | 'patch' | 'tube' | 'grid' | 'trail' | 'surface' | null): void;
  readonly createSurfacePoints?: readonly PlacementEndpoint[];
  readonly createSurfaceHover?: PlacementEndpoint | null;
  readonly createSurfaceClosing?: boolean;
  readonly createSurfaceClosed?: boolean;
  readonly createSurfaceSelectedPoint?: number | null;
  undoCreateSurfacePoint?(): void;
  setCreateSurfaceCharts?(charts: readonly Patch[] | null): void;
  setCreatePatchSides(sides: 3 | 4): void;
  setWeldTool(source: readonly number[] | false): void;
  setEdgeWeldTool(edges: readonly [number, number][] | null): void;
  setCreateEdgeTool(on: boolean, start: V3 | null): void;
  setCreateEdgeStart(start: V3 | null): void;
  setCreateEdgePath(points: readonly V3[]): void;
  readonly createTubePoints: readonly V3[];
  /** Create Grid's placed clicks, its draft's four corners once the third is down, the cursor's candidate for the
   *  next click, and the camera it is drawn from. */
  readonly createGridPoints: readonly PlacementEndpoint[];
  readonly createGridCorners: GridCorners | null;
  /** Whether the gizmo holds a whole Create Grid draft — a selection Move, Rotate and Scale all apply to. */
  readonly createGridWholeSelected: boolean;
  setCreateGridCorners(corners: GridCorners): void;
  readonly createGridHover: PlacementEndpoint | null;
  readonly createGridEye: V3;
  setCreateGridLattice(plan: { points: readonly V3[]; columns: number; rows: number } | null): void;
  /** Show a trail's points (none hides them), `knot` carrying the move gizmo — or, with a `pivot`, the selected
   *  paths carrying it — and the paths through them (docs/023). */
  setTrailKnots(knots: readonly V3[], knot: number | null, pivot?: V3 | null, shape?: TrailShape): void;
  setCreateTrailSurfaceLift(value: number): void;
  projectedVerticesInsidePatches(quads: readonly number[]): number[];
  setPasteTool(clip: MeshVertexClipboard | null, propOrigins?: readonly V3[]): void;
  readonly pastePlacing: boolean;
  /** Alt held on the live pointer: a drag moves only what it grabbed (creases allowed) instead of staying smooth. */
  readonly independentDrag?: boolean;
  readonly edgeExtrusionStaged: boolean;
  readonly edgeExtrusionMode?: 'pull' | 'path';
  readonly edgeExtrusionSideFlippable: boolean;
  beginEdgeExtrusionStage(): boolean;
  flipEdgeExtrusionSide(): boolean;
  commitEdgeExtrusionStage(): void;
  cancelEdgeExtrusionStage(): void;
  referenceCopyVertexCount(): number;
  copyReferenceMeshSelection(): MeshVertexClipboard | null;
  /** Optional on test doubles; the concrete viewport supplies both for portable reference-copy text. */
  readonly refLevelName?: string;
  referenceOffset?(): V3;
  setGizmoMode(mode: 'move' | 'rotate' | 'scale'): void;
  showHandles(corner: V3 | null, nubs: { dir: string; pos: V3 }[]): void;
}
