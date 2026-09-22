import type { QuadMeshDoc, V3 } from '../../core/doc/types';
import type { MeshVertexClipboard } from '../../core/mesh/clipboard';
import type { MeshControlPointId } from '../../core/mesh/control-point-types';
import type { Store } from '../state/store';

/** Rendering/input surface used by the edit workflow. */
export interface EditViewportPort {
  previewMeshEdit(doc: Store['mdoc'], change: {
    vertices?: readonly number[];
    edges?: readonly [number, number][];
    quads?: readonly number[];
  }): boolean;
  clearCornerSelection(): void;
  setControlPointSelection(ids: readonly MeshControlPointId[]): void;
  setCornerGroup(positions: V3[], indices?: number[], showMarks?: boolean): void;
  setRegionMarks(positions: V3[]): void;
  setPlacedPropSelection(selIdx: number | null, multiSel?: number[]): void;
  /** Seat the shared Move / Rotate gizmo at the centroid of a mixed Edit selection. */
  setEditMixedGroup(positions: V3[], indices?: number[]): void;
  /** Clear any selection gizmo when no movable member remains. */
  detachSelectionGizmo(): void;
  narrowReferenceEditSelection(kind: 'point' | 'edge' | 'patch'): void;
  refreshEditCells(): void;
  refreshEditEdges(): void;
  refreshHiddenMesh(): void;
  refreshControlCages(): void;
  setBridgeRails(rails: readonly (readonly number[])[] | null): void;
  setLoftPreview(quads: readonly (readonly number[])[] | null, source?: readonly number[] | QuadMeshDoc | null): void;
  setSurgeryTool(tool: 'loopcut' | 'patch' | 'tube' | 'trail' | null): void;
  setCreatePatchSides(sides: 3 | 4): void;
  setWeldTool(source: readonly number[] | false): void;
  setEdgeWeldTool(edges: readonly [number, number][] | null): void;
  setCreateEdgeTool(on: boolean, start: V3 | null): void;
  setCreateEdgeStart(start: V3 | null): void;
  setCreateEdgePath(points: readonly V3[]): void;
  readonly createTubePoints: readonly V3[];
  readonly createTrailPoints: readonly V3[];
  removeLastCreateTrailPoint(): void;
  setCreateTrailSurfaceLift(value: number): void;
  projectedVerticesInsidePatches(quads: readonly number[]): number[];
  setPasteTool(clip: MeshVertexClipboard | null): void;
  readonly pastePlacing: boolean;
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
