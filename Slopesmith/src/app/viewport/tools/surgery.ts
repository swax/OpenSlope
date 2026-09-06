import * as THREE from 'three';
import { planLoopCut, loopCutGeometry, hoveredEdge, type LoopCutPlan } from '../../../core/mesh/ops';
import type { MeshAdjacency, EdgeHandle } from '../../../core/mesh/topology';
import type { PreviewData } from '../../../core/mesh/tessellation';
import {
  LOOPCUT_LINE_COLOR, LOOPCUT_LINE_WIDTH, LOOPCUT_DOT_PX, LOOPCUT_STOP_PX,
  CAGE_POINT_COLOR, CAGE_BOUNDARY_COLOR, CAGE_EXTRA3_COLOR, LOOP_RENDER_ORDER,
} from '../constants';
import { clearGlyphGroup, glyphLines, addLoopDots } from '../shared/overlays';
import type { Stage } from '../stage';

/** The topology-changing tools of Edit mode (docs/017). Only the loop cut exists today; welds, pole inserts
 *  and rips (017–019) join it here as more `SurgeryTool` values, each a fresh hover-plan-commit trio. */
export type SurgeryTool = 'loopcut';

/** The live mesh-edit substrate a surgery tool reads: the tessellated preview (mesh + faces-per-cell for the
 *  face-index → quad map), the mesh adjacency, and the cached directed-edge handle (overrides + Bessel). The
 *  shell owns these (they drive the cage + terrain too) and hands them in as accessors, null off a mesh doc. */
export interface MeshAccess {
  preview(): PreviewData | null;
  adj(): MeshAdjacency | null;
  edgeHandle(): EdgeHandle | null;
}

/**
 * Topology surgery on the authored quad net (docs/017), as a modal hover gesture: arm a tool, the terrain
 * edge under the cursor previews the operation (a gold cut curve + the vertices it would insert), the wheel
 * slides the cut along its strip, and a click commits by handing the picked rail + fraction back to the host
 * (`onLoopCut`) to re-plan against the live doc and apply. The plan + geometry are pure (`core/mesh/mesh-ops`); this
 * layer owns only the ghost overlay (a group under `stage.worldRoot` in data coords, like the cage) and the
 * armed-tool state. The pointer router calls `onWheel` / `onHover` / `onCommit`, each returning whether it
 * consumed the event so the shell falls through to orbit / zoom / selection when no tool is armed.
 */
export function createSurgeryLayer(stage: Stage, mesh: MeshAccess) {
  const loopCutGroup = new THREE.Group();       // the cut ghost (docs/017), data coords like the cage
  let tool: SurgeryTool | null = null;
  let loopPreview: { quad: number; edge: [number, number] } | null = null; // last picked rail (re-planned on commit)
  let loopPlan: LoopCutPlan | null = null;      // the current previewed cut (re-drawn as the wheel slides t)
  let loopT = 0.5;                              // the cut fraction (0..1) the wheel slides along the strip

  /** Arm / disarm a surgery tool. Arming resets the cut fraction; either way the ghost clears until the next
   *  hover rebuilds it. The corner gizmo / marker / nub drop the gesture needs is the shell's (setSurgeryTool). */
  function setTool(t: SurgeryTool | null) {
    tool = t;
    if (t) loopT = 0.5;
    clearGhost();
  }

  /** Dispose the ghost overlay and forget the previewed cut. */
  function clearGhost() {
    clearGlyphGroup(loopCutGroup);
    loopPreview = null;
    loopPlan = null;
  }

  /** The mesh + adjacency + directed-edge handle the hover reads, or null off a mesh doc. */
  function loopContext(): { mesh: PreviewData['mesh']; adj: MeshAdjacency; edgeHandle: EdgeHandle } | null {
    const eh = mesh.edgeHandle(), pv = mesh.preview(), adj = mesh.adj();
    if (!eh || !pv || !adj) return null;
    return { mesh: pv.mesh, adj, edgeHandle: eh };
  }

  /** Draw the ghost for the planned cut at the current fraction: the cut curve (gold fat line, on the
   *  surface), the inserted-vertex dots (green — what they'll become), and the strip's rim / pole stops. */
  function drawGhost(plan: LoopCutPlan) {
    clearGlyphGroup(loopCutGroup);
    const pv = mesh.preview(), eh = mesh.edgeHandle();
    if (!pv || !eh) return;
    const geom = loopCutGeometry(pv.mesh, eh, plan, loopT);
    const res: [number, number] = [stage.container.clientWidth || 1, stage.container.clientHeight || 1];
    if (geom.line.length) glyphLines(loopCutGroup, geom.line, LOOPCUT_LINE_COLOR, 1, res, LOOPCUT_LINE_WIDTH, LOOP_RENDER_ORDER + 1, false);
    addLoopDots(loopCutGroup, geom.cutPts, CAGE_POINT_COLOR, LOOPCUT_DOT_PX);
    addLoopDots(loopCutGroup, geom.rimPts, CAGE_BOUNDARY_COLOR, LOOPCUT_STOP_PX);  // open ends: rim
    addLoopDots(loopCutGroup, geom.polePts, CAGE_EXTRA3_COLOR, LOOPCUT_STOP_PX);   // stopped at a pole
  }

  /** Re-plan + redraw the cut ghost from the terrain edge under the cursor. Off the terrain (or off a mesh
   *  doc) the ghost clears. Stashes the picked quad + edge so a click can re-plan the identical cut. */
  function updateGhost(e: PointerEvent) {
    const ctx = loopContext(), pv = mesh.preview();
    if (!ctx || !pv || !stage.terrainMesh) { clearGhost(); return; }
    stage.castAt(e);
    const hit = stage.pickSurface(stage.terrainMesh); // re-plans per pointer move — accelerated
    if (!hit || hit.faceIndex == null) { clearGhost(); return; }
    const quad = Math.floor(hit.faceIndex / pv.facesPerCell);
    const edge = hoveredEdge(ctx.mesh, quad, [hit.point.x, hit.point.y, -hit.point.z]); // world hit → data (Z flip)
    loopPreview = { quad, edge };
    loopPlan = planLoopCut(ctx.mesh, ctx.adj, quad, edge);
    drawGhost(loopPlan);
  }

  /** Wheel over a live ghost: slide the cut along its strip (fraction 0..1) and redraw, like the placement
   *  wheel turns a prop. Returns false with no active plan so the shell's wheel falls through to camera zoom. */
  function onWheel(e: WheelEvent): boolean {
    if (tool !== 'loopcut' || !loopPlan) return false;
    loopT = Math.min(0.95, Math.max(0.05, loopT + (e.deltaY < 0 ? 0.05 : -0.05)));
    drawGhost(loopPlan);
    return true;
  }

  /** Pointer hover: preview the cut under the cursor. Returns whether a tool is armed (it owns the hover). */
  function onHover(e: PointerEvent): boolean {
    if (tool !== 'loopcut') return false;
    updateGhost(e);
    return true;
  }

  /** Click: commit the previewed cut — hand the host the picked rail + fraction to re-plan + apply (the doc
   *  rebuild re-plans on the next hover, so the now-stale ghost drops). Returns whether a tool consumed it. */
  function onCommit(): boolean {
    if (tool !== 'loopcut') return false;
    if (loopPreview) {
      stage.cb.onLoopCut?.(loopPreview.quad, loopPreview.edge, loopT);
      clearGhost();
    }
    return true;
  }

  stage.worldRoot.add(loopCutGroup);

  return {
    get tool() { return tool; },
    setTool, clearGhost, onWheel, onHover, onCommit,
  };
}

export type SurgeryLayer = ReturnType<typeof createSurgeryLayer>;
