/**
 * Public surface of the topology-surgery ops (docs/017): pure `QuadMeshDoc → QuadMeshDoc` rewrites that
 * CREATE and DESTROY vertices / quads, the operations the move / paint / crease tools can't express. The ops
 * live as family modules under ./ops — op-contract.ts holds the shared plumbing every op routes through
 * (`remapIds` compaction, the manifold guard), cut-primitives.ts the split moves the cut family composes,
 * edge-chains.ts the selection→path ordering, and each remaining module one operation family. This barrel
 * re-exports the names the app, viewport, and sibling core modules consume; op-internal helpers are imported
 * directly from their ops/ module instead.
 */
export { ekey, checkManifold, remapIds, locateVertex, meshContext, type RewriteIdentity } from './contract';
export { orderEdgeChain } from './edge-chains';
export {
  DEFAULT_STANDALONE_PATCH_SIZE_M, standalonePatchCorners, appendStandalonePatch,
  appendTube, appendPatchFromCorners, appendFreeEdge, type PatchCorners, type FreeEdgeContact,
} from './append';
export { validateSurfaceCutPath, routeSurfaceCutPath, applySurfaceCut, type SurfaceCutPoint } from './surface-cut';
export {
  applyEdgeCrossingWeld, autoWeldCreatedEdgeCrossings, AUTO_WELD_CROSSING_TOLERANCE_M,
  type EdgeCrossingWeldResult,
} from './edge-crossing-weld';
export {
  planEdgeExtrusion, planPatchExtrusion, translatedEdgeExtrusionPlacement, tangentEdgeExtrusionPlacement,
  edgeExtrusionSegmentCount, edgeExtrusionPreviewDoc, edgeExtrusionPlacementPreviewDoc,
  applyEdgeExtrusion, applyPatchExtrusion, applyPlannedEdgeExtrusion,
  type EdgeExtrusionPlan, type EdgeExtrusionPlacement,
} from './edge-extrusion';
export { planLoopCut, loopCutGeometry, hoveredEdge, applyLoopCut, type LoopCutPlan } from './loop-cut';
export { applyEdgeRip } from './edge-rip';
export { applyCellEdgeInsert } from './cell-edge-insert';
export { meshDeleteTargets, applyMeshDelete, type MeshDeleteSelection } from './delete';
export { applyMeshDissolve } from './dissolve';
export { applyMeshFlip, type MeshFlipResult } from './flip';
export { applyVertexWeld, applyVertexWeldTogether, applyEdgeWeldSets, applyEdgeWeld } from './weld';
export {
  boundaryEdgeLoopVertices, applyEdgeLoopWeld, type BoundaryEdgeLoop, type EdgeLoopWeldResult,
} from './edge-loop-weld';
