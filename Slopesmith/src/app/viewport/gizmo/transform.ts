import * as THREE from 'three';
import type { MeshBVH } from 'three-mesh-bvh';
import type { PlacedProp, QuadMeshDoc, V3 } from '../../../core/doc/types';
import { buildQuadMesh, meshAdjacency, meshEdgeHandles, vertexAxes, vertexFrame, type EdgeHandle, type MeshAdjacency } from '../../../core/mesh/topology';
import { planCellSlide } from '../../../core/mesh/slide';
import { mul } from '../../../core/math/vec';
import { controlPointKey, type MeshControlPoint, type MeshControlPointId } from '../../../core/mesh/control-points';
import type { PreviewData } from '../../../core/mesh/tessellation';
import { frozenPos, planSlideRecut, slideDragFrame, slideRail, type SlideExact } from '../../../core/mesh/slide-gesture';
import type { SurfaceRails } from './arcs';
import type { QuadName, VertexName } from '../../state/mesh-names';
import type { GizmoFrame, GizmoMode } from '../types';
import type { Stage } from '../stage';
import { dataToScene, sceneToData, setScenePositionFromData } from '../coordinates';
import { clampEffectTriggerSize, isEffectTriggerProp } from '../../../core/effects/trigger-volume';
import { placementQuat, propRotationFromQuat } from '../../../core/props/pose';

/** Resolve the persisted frame plus the one-drag Shift override into the frame TransformControls should use. */
export function resolveGizmoFrame(frame: GizmoFrame, forceWorld: boolean): GizmoFrame {
  return forceWorld ? 'world' : frame;
}

export type LocalFrame = { tu: THREE.Vector3; tv: THREE.Vector3; n: THREE.Vector3 };

/** A stable slope-free frame for a vertex connected only by free edges. Local X follows the longest chord
 *  through its edge neighbours; local Y stays as close to world-up as that tangent permits. Vertex-id ordering
 *  gives both ends of one free edge the same X direction, so a selected edge's averaged frame cannot cancel. */
export function edgeConnectedFrame(pos: number[], adj: MeshAdjacency, id: number): LocalFrame | null {
  const point = (index: number) => new THREE.Vector3(pos[index * 3], pos[index * 3 + 1], pos[index * 3 + 2]);
  const neighbors = (adj.neighbors[id] ?? []).filter(index => index >= 0 && index * 3 + 2 < pos.length);
  if (!neighbors.length) return null;

  let a = id, b = neighbors[0], best = -1;
  if (neighbors.length > 1) {
    for (let i = 0; i < neighbors.length - 1; i++) for (let j = i + 1; j < neighbors.length; j++) {
      const d = point(neighbors[i]).distanceToSquared(point(neighbors[j]));
      if (d > best) { best = d; a = neighbors[i]; b = neighbors[j]; }
    }
  }
  if (a > b) [a, b] = [b, a];
  const tu = point(b).sub(point(a));
  if (tu.lengthSq() < 1e-10) return null;
  tu.normalize();

  const n = new THREE.Vector3(0, 1, 0).addScaledVector(tu, -tu.y);
  if (n.lengthSq() < 1e-10) {
    const reference = Math.abs(tu.x) <= Math.abs(tu.z)
      ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    n.copy(reference).addScaledVector(tu, -reference.dot(tu));
  }
  n.normalize();
  const tv = new THREE.Vector3().crossVectors(tu, n).normalize();
  return { tu, tv, n };
}

// The Surface-mode slide's frozen drag-start net (`SlideExact`) and pure planner live in core/mesh/slide-gesture.ts —
// pure functions of that net, so a drag frame is reproducible and headlessly testable. The layer seats one at
// pointer-down (seatExactSlide), resolves the dragged anchor into a `SlideDrag` and hands the plan to the host.

/** The live mesh substrate a transform drag reads: the quad net + its topology neighbour-ring, the mesh doc,
 *  the tessellated preview, the cached directed-edge handle (overrides + Bessel), and the frozen-surface BVH
 *  a slide re-projects onto (the host builds it over the current terrain geometry, cloned buffers). The shell
 *  owns all of it and hands it in as closures, null where nothing is loaded. */
export interface TransformMeshAccess {
  net(): { positions: number[]; adj: MeshAdjacency } | null;
  meshDoc(): QuadMeshDoc | null;
  preview(): PreviewData | null;
  edgeHandle(): EdgeHandle | null;
  terrainBVH(): MeshBVH | null;
}

/** The selection families a transform can be seated on — the shell's mutually exclusive edit sets (corner /
 *  region / edge / cell / control points / cage handle) plus the prop selection and the staged-extrusion
 *  gizmo state. Which set holds members tells a cell from a region on the shared 'corners' gizmo. */
export interface TransformSelectionAccess {
  selectedCorner(): number | null;
  cornerGroupIdx(): readonly number[];
  editEdgeSel(): readonly [number, number][];
  editCellSel(): readonly number[];
  controlPointSel(): readonly MeshControlPointId[];
  authoredControlPointByKey(): ReadonlyMap<string, MeshControlPoint>;
  selectedCageHandle(): { vertex: number } | null;
  selectedProp(): number | null;
  multiSelProps(): readonly number[];
  placedProp(index: number): PlacedProp | undefined;
  extrusionStaged(): boolean;
  extrusionFanMode(): boolean;
}

/** The persistent scene-root gizmo anchors (Z negated by hand, so the gizmo never sees a mirrored parent).
 *  The shell creates them and parks them per selection; the layer orients them to the surface frame and
 *  re-parks them mid-slide. `cornerGroupHandleLast` is the group handle's data-space position at the last
 *  gizmo report — the delta baseline the shell's Move reports and the exact slide both keep current. */
export interface TransformAnchors {
  cornerMarker: THREE.Object3D;
  cornerGroupHandle: THREE.Object3D;
  cornerGroupHandleLast: THREE.Vector3;
  cageHandleAnchor: THREE.Object3D;
}

/** Host work a transform triggers: handing a cage-handle gizmo back to the selection centroid before Rotate /
 *  Scale show their handles, waking the staged extrusion's transform handles, and folding rotated / scaled
 *  control-point targets back into the live selection highlight (positions + region marks). */
export interface TransformHostHooks {
  releaseCageHandle(): void;
  enableExtrusionTransform(): void;
  controlPointsMoved(targets: { id: MeshControlPointId; pos: V3 }[]): void;
}

/**
 * The shared gizmo's transform gestures: the World / Local / Surface frame pill + the W / E / R mode switch, and the
 * three drag families they gate — rotation and scale, each evaluating a frozen drag-start snapshot so repeated
 * objectChange events never accumulate drift, and the Surface-mode slide, an exact de Casteljau re-cut of the
 * control net with the frozen-BVH group march as its fallback. The layer drives the one TransformControls on
 * the persistent anchors the shell owns, reads the mesh substrate + the selection families through accessors,
 * and reports authored absolute values through the host callbacks (`stage.cb`); the shell keeps selection
 * seating and the onGizmoChange routing, calling in as the drag lifecycle fires.
 */
export function createTransformLayer(
  stage: Stage, mesh: TransformMeshAccess, sel: TransformSelectionAccess,
  anchors: TransformAnchors, host: TransformHostHooks,
) {
  // Corner-gizmo framing for terrain editing (docs/006), a single World / Local / Surface pill:
  //  • SURFACE (default) re-frames the gizmo to the picked corner's slope (local X = down-mountain, Y =
  //    surface normal, Z = cross-slope, so the XZ pad is the tangent plane) AND slides, restricted to the four
  //    clean handles. Each handle is a different promise:
  //      – the two IN-PLANE ARROWS ('X' / 'Z') on a corner, an edge or a cell selection are an exact de Casteljau
  //        RE-CUT of the control net (`slideExact` / core/mesh/slide.ts): the ridable surface is bit-for-bit what it
  //        was, only re-parameterised, so a slide holds on overhangs and cave roofs where no ray can help.
  //      – the TANGENT PAD ('XZ') on those same three selections is that slide in BOTH axes at once (`slideRecut`
  //        again). It re-parameterises nothing — a moved cell's footprint straddles four parent patches, and four
  //        G1-joined bicubics are not one bicubic — but every vertex it moves lands exactly on the parent surface,
  //        at its quadrant quad's own patch point. No ray, so it holds on the same overhangs the arrows do. Let
  //        either parameter fall back to zero and the full 1-D exactness returns.
  //      – a corner-REGION group drag re-projects onto the shape as it stood at drag-start (frozen `slideBVH`):
  //        four unrelated corners marching across the surface re-cut no curve.
  //      – the UP POST ('Y') is the deliberate off-surface move (along the normal); it takes neither.
  //  • LOCAL keeps that slope-aligned frame but restores all 7 handles and moves freely without a surface slide.
  //  • WORLD is the plain 7-handle world-axis gizmo for free 3D off-surface moves (overhangs, wall faces,
  //    cave roofs). Shift held while dragging forces World for a quick off-surface escape from either local frame.
  // Corners take the full Surface slide contract. Floating cage handles and directly-selected sub-cage points
  // use the same Local / Surface orientation, but remain free control-point moves: they shape the surface and
  // therefore cannot themselves be projected or re-cut along it. Knots, props, gems and the reference stay world.
  let gizmoFrame: GizmoFrame = 'surface'; // host-driven frame pill; Surface alone implies a constrained slide
  let gizmoMode: GizmoMode = 'move'; // W / E / R transform tool; rotate / scale are selection-gated below
  let gizmoShift = false;      // Shift held → force World for this drag (free 3D off-surface)
  type FrozenCorners = {
    members: { vertex: VertexName; pos: THREE.Vector3 }[];
    edgeHandles: { from: VertexName; to: VertexName; offset: THREE.Vector3 }[];
    quadTwist: { quad: QuadName; offsets: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] }[];
  };
  type FrozenControlPoint = { id: MeshControlPointId; pos: THREE.Vector3 };
  type FrozenProp = { index: number; pos: THREE.Vector3; rot: THREE.Quaternion };
  // Rotation always evaluates the drag-start snapshot, so repeated objectChange events never accumulate drift.
  // Scene-root positions carry the editor's Z flip; converting back to authored data negates Z once at the edge.
  let rotationDrag: {
    kind: 'corners'; anchor: THREE.Quaternion; pivot: THREE.Vector3;
    members: { vertex: VertexName; pos: THREE.Vector3 }[];
    edgeHandles: { from: VertexName; to: VertexName; offset: THREE.Vector3 }[];
    quadTwist: { quad: QuadName; offsets: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] }[];
  } | {
    kind: 'controlpoints'; anchor: THREE.Quaternion; pivot: THREE.Vector3;
    members: { id: MeshControlPointId; pos: THREE.Vector3 }[];
  } | {
    kind: 'prop' | 'props'; anchor: THREE.Quaternion; pivot: THREE.Vector3;
    members: FrozenProp[];
  } | {
    kind: 'editmixed'; anchor: THREE.Quaternion; pivot: THREE.Vector3;
    corners: FrozenCorners | null;
    controlPoints: FrozenControlPoint[];
    props: FrozenProp[];
  } | null = null;
  // Scale mirrors rotation's frozen-snapshot contract, but reads the anchor's live scale instead of quaternion.
  let scaleDrag: {
    kind: 'corners'; anchor: THREE.Quaternion; startScale: THREE.Vector3; pivot: THREE.Vector3;
    members: { vertex: VertexName; pos: THREE.Vector3 }[];
    edgeHandles: { from: VertexName; to: VertexName; offset: THREE.Vector3 }[];
    quadTwist: { quad: QuadName; offsets: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3] }[];
  } | {
    kind: 'controlpoints'; anchor: THREE.Quaternion; startScale: THREE.Vector3; pivot: THREE.Vector3;
    members: { id: MeshControlPointId; pos: THREE.Vector3 }[];
  } | {
    kind: 'prop' | 'props'; anchor: THREE.Quaternion; startScale: THREE.Vector3; pivot: THREE.Vector3;
    members: { index: number; pos: THREE.Vector3; scale: number; triggerSize?: V3 }[];
  } | null = null;
  let slideBVH: MeshBVH | null = null; // frozen surface for slide re-projection, built at corner drag-start
  const slideRay = new THREE.Ray();    // reused down-ray for the slide surface probe (regions + a degenerate frame)
  // multi-corner slide: a frozen snapshot of the net + the group's grid frame captured at drag-start, so a
  // group slide moves every member the same FRACTION of its own cell toward its next vertex (ratio-preserving,
  // riding the frozen surface) rather than a rigid world delta.
  let slideGroup: {
    net0: Float32Array; adj: MeshAdjacency;            // frozen net positions + the topology neighbour-ring
    // the members as the frozen net numbers them, each carrying the name the host will write it back under
    members: { vertex: VertexName; index: number }[];
    tu: THREE.Vector3; tv: THREE.Vector3; n: THREE.Vector3; // group averaged surface frame (data space, unit)
    rowStepAvg: number; colStepAvg: number;           // mean neighbour distance over the selection (cell size)
    handle0: THREE.Vector3;                            // the centre handle's data-space position at drag-start
  } | null = null;
  // exact slide (gizmo axis 'X' / 'Z' / 'XZ'): the frozen net the drag re-cuts, and whether the cursor has run
  // past a far end so a release would weld. Seated for a single corner, an edge / edge-loop and a cell selection.
  let slideExact: SlideExact | null = null;
  let slideMergePending = false;

  /** World / Local / Surface pill (docs/006): Local and Surface use the slope frame; Surface additionally
   *  slides along the terrain, while World uses the plain world axes. Host-driven. */
  function setGizmoFrame(frame: GizmoFrame) {
    gizmoFrame = frame;
    applyGizmoFrame();
  }

  /** Switch the shared TransformControls between move / rotate / scale. Unsupported point selections keep
   *  translating even if a stale caller asks for Rotate or Scale; the toolbox gates both to groups / props. */
  function setGizmoMode(mode: GizmoMode) {
    if (stage.gizmo.dragging) return; // never change the transform contract underneath a live pointer gesture
    if (stage.gizmoKind === 'edgeextrusion' && sel.extrusionFanMode()) host.enableExtrusionTransform();
    gizmoMode = mode;
    // A cell / edge control point may currently own the shared gizmo. Rotate / Scale belong to the selected
    // geometry, so hand it back to that geometry's centroid before showing their handles.
    if (mode !== 'move' && sel.cornerGroupIdx().length > 1 && stage.gizmoKind === 'cagehandle') {
      host.releaseCageHandle();
      anchors.cornerGroupHandle.visible = true;
      stage.attachGizmo(anchors.cornerGroupHandle, 'corners', -1);
      return;
    }
    applyGizmoFrame();
  }

  /** Shift tracked by the shell's window listeners: held forces World for this drag (free 3D off-surface),
   *  released (or blur) takes the Surface frame back. Ignored mid-drag by applyGizmoFrame — the frame locks
   *  once a drag starts, restored on drag end. A repeated report of the same state is a no-op. */
  function shiftKey(held: boolean) {
    if (gizmoShift === held) return;
    gizmoShift = held;
    applyGizmoFrame();
  }

  /** Rotation applies to geometry with an extent (two or more movable mesh/control points) and prop poses. */
  function rotationActive(): boolean {
    if (gizmoMode !== 'rotate') return false;
    if (stage.gizmoKind === 'edgeextrusion') return sel.extrusionStaged();
    if (stage.gizmoKind === 'corners') return sel.cornerGroupIdx().length > 1;
    if (stage.gizmoKind === 'controlpoints') return sel.controlPointSel().length > 1;
    if (stage.gizmoKind === 'editmixed') {
      const props = sel.multiSelProps().length + (sel.selectedProp() === null ? 0 : 1);
      return sel.cornerGroupIdx().length + sel.controlPointSel().length + props > 1;
    }
    return (stage.gizmoKind === 'prop' && sel.selectedProp() !== null)
      || (stage.gizmoKind === 'props' && sel.multiSelProps().length > 0);
  }

  /** Scale has the same extent requirement as rotation; a lone point has no size to transform. */
  function scaleActive(): boolean {
    if (gizmoMode !== 'scale') return false;
    if (stage.gizmoKind === 'edgeextrusion') return sel.extrusionStaged();
    if (stage.gizmoKind === 'corners') return sel.cornerGroupIdx().length > 1;
    if (stage.gizmoKind === 'controlpoints') return sel.controlPointSel().length > 1;
    return (stage.gizmoKind === 'prop' && sel.selectedProp() !== null)
      || (stage.gizmoKind === 'props' && sel.multiSelProps().length > 0);
  }

  /** Re-evaluate the corner gizmo's frame from (kind, pill, Shift). Surface orients the gizmo to the slope
   *  and restricts it to the four clean handles (up + tangent pad + two in-plane arrows); World — or Shift —
   *  is the full free gizmo. A no-op while a drag is live — a drag keeps the frame it started with. */
  function applyGizmoFrame() {
    if (stage.gizmo.dragging) return;
    const rotating = rotationActive();
    const scaling = scaleActive();
    stage.gizmo.setMode(rotating ? 'rotate' : scaling ? 'scale' : 'translate');
    stage.gizmo.showX = true; stage.gizmo.showY = true; stage.gizmo.showZ = true;
    if (stage.gizmoKind === 'edgeextrusion' && sel.extrusionFanMode()) {
      stage.gizmoRestrict = false;
      stage.gizmo.setMode('translate');
      stage.gizmo.setSpace('local');
      stage.gizmo.showY = false;
      stage.gizmo.showZ = false;
      return;
    }
    if (stage.gizmoKind === 'cagehandle') {
      // A floating tangent handle only uses the pill's orientation (no slide or restricted handles). Local
      // and Surface align to its FROM vertex's slope; World is axis-aligned. Shift forces World.
      const activeFrame = resolveGizmoFrame(gizmoFrame, gizmoShift);
      const local = activeFrame !== 'world';
      stage.gizmoRestrict = false;
      stage.gizmo.setSpace(local ? 'local' : 'world');
      // A local frame aligns to the handle's corner slope: an edge tangent frames on its FROM vertex, an interior
      // twist point on its own corner vertex (both carried as `vertex`).
      const handle = sel.selectedCageHandle();
      const slopeFrame = local && handle ? cornerFrame(handle.vertex, activeFrame === 'local') : null;
      anchors.cageHandleAnchor.quaternion.copy(slopeFrame ? frameQuat(slopeFrame.tu, slopeFrame.tv, slopeFrame.n) : new THREE.Quaternion());
      return;
    }
    if (stage.gizmoKind === 'controlpoints') {
      // Direct picks from the global sub-cage use the selection centroid rather than the cell/edge handle
      // anchor above. Give them the same frame semantics: World is axis-aligned; Local and Surface average the
      // slope frames owned by the selected points. Surface changes orientation only — these floating points
      // deform the terrain, so they do not participate in the corner family's topology-preserving slide.
      const activeFrame = resolveGizmoFrame(gizmoFrame, gizmoShift);
      const local = activeFrame !== 'world';
      stage.gizmoRestrict = false;
      stage.gizmo.setSpace(local ? 'local' : 'world');
      const slopeFrame = local ? controlPointFrame(activeFrame === 'local') : null;
      anchors.cornerGroupHandle.quaternion.copy(slopeFrame ? frameQuat(slopeFrame.tu, slopeFrame.tv, slopeFrame.n) : new THREE.Quaternion());
      return;
    }
    const isCorner = stage.gizmoKind === 'corner' || stage.gizmoKind === 'corners';
    if (!isCorner) {
      stage.gizmoRestrict = false;
      stage.gizmo.setSpace('world');
      // These remaining anchors carry no authored orientation, so clear any stale local rotation before Scale
      // (always local in TransformControls) reads it.
      if (stage.gizmoKind === 'prop' || stage.gizmoKind === 'props' || stage.gizmoKind === 'editmixed')
        stage.gizmo.object?.quaternion.identity();
      // All three rings show for props: a placement authors a full rotation (yaw / pitch / roll, core/props/pose),
      // so tilting one onto a slope or laying it on its side is an ordinary drag rather than something the
      // document would silently discard. Rings stay WORLD-aligned, which is the frame a turn is judged in.
      //
      // Scale is the one exception, and only for a trigger VOLUME: TransformControls always scales in the
      // object's own frame, and a trigger is the single placement kind whose axes mean something individually
      // (`effectTrigger.size` is authored per-axis about the box centre). Seat the anchor on the placement's
      // rotation so a tilted box's handles still run along its own faces — every other prop resolves one
      // uniform factor, which no orientation can change.
      if (scaling && stage.gizmoKind === 'prop') {
        const index = sel.selectedProp();
        const prop = index === null ? undefined : sel.placedProp(index);
        if (prop && isEffectTriggerProp(prop)) {
          const [x, y, z, w] = placementQuat(prop);
          stage.gizmo.object?.quaternion.set(-x, -y, z, w); // authored → scene frame (worldRoot mirrors Z)
        }
      }
      return;
    }
    const activeFrame = resolveGizmoFrame(gizmoFrame, gizmoShift);
    const local = activeFrame !== 'world';
    const surface = activeFrame === 'surface';
    stage.gizmoRestrict = surface && !rotating && !scaling; // translate-only pruning / curved arrows do not apply to rotate / scale
    stage.gizmo.setSpace(local ? 'local' : 'world');
    if (local) orientGizmoToLocal(activeFrame === 'local');
    else (stage.gizmoKind === 'corners' ? anchors.cornerGroupHandle : anchors.cornerMarker).quaternion.identity();
  }

  /**
   * The rigid-body snapshot a Rotate or a Scale evaluates every frame: the selected corners with their
   * drag-start positions, the directed boundary handles their rotation carries, and the interior twists of
   * the patches they wholly own. Null off the multi-corner family, which has no extent to transform.
   *
   * Everything is captured by NAME (docs/039). A drag reports absolute values back frame after frame, and
   * the host writes them into a document that its own re-cuts may have renumbered in between; an index
   * frozen here would then land on a different corner, which is exactly the silent kind of wrong.
   */
  function freezeCorners(mixed = false): FrozenCorners | null {
    const net = mesh.net(), doc = mesh.meshDoc(), groupIdx = sel.cornerGroupIdx();
    if ((!mixed && stage.gizmoKind !== 'corners') || !net || !doc || groupIdx.length < (mixed ? 1 : 2)) return null;
    const selected = new Set(groupIdx);
    const members = groupIdx.flatMap(index => {
      const vertex = doc.vertexIds[index];
      if (vertex === undefined) return [];
      const j = index * 3, p = net.positions;
      return [{ vertex, pos: new THREE.Vector3(p[j], p[j + 1], -p[j + 2]) }];
    });
    // A directed-edge handle is owned by its FROM vertex: when that vertex rotates, its handle vector rotates
    // with it. Snapshot the EFFECTIVE provider (stored override OR smooth Bessel default), not just sparse
    // overrides. On a connected quilt the default reads an opposite, possibly unselected neighbour; letting it
    // re-derive after the corners move would leave the visible boundary CP behind instead of rotating rigidly.
    const eh = mesh.edgeHandle();
    const edgeHandles = eh ? groupIdx.flatMap(from => (net.adj.neighbors[from] ?? []).flatMap(to => {
      const a = doc.vertexIds[from], b = doc.vertexIds[to];
      return a === undefined || b === undefined ? [] : [{ from: a, to: b, offset: dataToScene(eh(from, to)) }];
    })) : [];
    // Interior twist belongs to the patch, not a lone corner. Carry it only when every corner of that patch
    // participates in this rigid selection (always true for the selected-cell family; also true for a region
    // that covers a whole patch). Partial edge / corner selections continue to deform neighbouring interiors.
    const quadTwist = Object.entries(doc.quadTwist ?? {}).flatMap(([key, offsets]) => {
      const quad = Number(key), corners = doc.quads[quad], name = doc.quadIds[quad];
      if (!corners?.every(index => selected.has(index)) || name === undefined) return [];
      const vectors = offsets.map(v => dataToScene(v)) as
        [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
      return [{ quad: name, offsets: vectors }];
    });
    return { members, edgeHandles, quadTwist };
  }

  function freezeControlPoints(): FrozenControlPoint[] {
    const byKey = sel.authoredControlPointByKey();
    return sel.controlPointSel().flatMap(id => {
      const cp = byKey.get(controlPointKey(id));
      return cp ? [{ id: { ...id } as MeshControlPointId, pos: dataToScene(cp.pos) }] : [];
    });
  }

  /** Freeze each member's drag-start pose. The rotation is carried in SCENE space (the frame the gizmo's own
   *  quaternion lives in), so a drag composes one quaternion product and converts back to authored angles
   *  once, at the edge — see `rotateSelection`. */
  function freezeProps(indices: readonly number[]): FrozenProp[] {
    return [...new Set(indices)].flatMap(index => {
      const prop = sel.placedProp(index);
      return prop ? [{ index, pos: dataToScene(prop.pos), rot: scenePropQuat(prop) }] : [];
    });
  }

  /** A placement's authored rotation as the SCENE-space quaternion the gizmo composes against. worldRoot
   *  mirrors Z, and conjugating a rotation through that reflection negates the axis as well as flipping its
   *  Z component: data axis (x, y, z) reads as scene axis (−x, −y, z). Its own inverse, so the same swizzle
   *  carries a scene rotation back to data. */
  function scenePropQuat(prop: PlacedProp): THREE.Quaternion {
    const [x, y, z, w] = placementQuat(prop);
    return new THREE.Quaternion(-x, -y, z, w);
  }

  /** Freeze the selected members as a rigid body at the instant a rotation gesture begins. */
  function beginRotation() {
    rotationDrag = null;
    const obj = stage.gizmo.object;
    if (!obj) return;
    const anchor = obj.quaternion.clone();
    const pivot = obj.position.clone();
    if (stage.gizmoKind === 'editmixed') {
      const selectedProp = sel.selectedProp();
      const props = freezeProps([...sel.multiSelProps(), ...(selectedProp === null ? [] : [selectedProp])]);
      const corners = freezeCorners(true), controlPoints = freezeControlPoints();
      if (corners || controlPoints.length || props.length)
        rotationDrag = { kind: 'editmixed', anchor, pivot, corners, controlPoints, props };
      return;
    }
    const frozen = freezeCorners();
    if (frozen) { rotationDrag = { kind: 'corners', anchor, pivot, ...frozen }; return; }
    if (stage.gizmoKind === 'controlpoints') {
      const members = freezeControlPoints();
      if (members.length > 1) rotationDrag = { kind: 'controlpoints', anchor, pivot, members };
      return;
    }
    if (stage.gizmoKind !== 'prop' && stage.gizmoKind !== 'props') return;
    const selectedProp = sel.selectedProp();
    const indices = stage.gizmoKind === 'prop'
      ? (selectedProp === null ? [] : [selectedProp])
      : sel.multiSelProps();
    const members = freezeProps(indices);
    if (members.length) rotationDrag = { kind: stage.gizmoKind, anchor, pivot, members };
  }

  /** Apply the current anchor quaternion to the frozen member snapshot and emit authored absolute values. */
  function rotateSelection() {
    const drag = rotationDrag, obj = stage.gizmo.object;
    if (!drag || !obj) return;
    // qNow * inverse(qStart) is the world-space delta for both local-axis (Surface) and world-axis rotation.
    const delta = obj.quaternion.clone().multiply(drag.anchor.clone().invert()).normalize();
    const rotated = (p: THREE.Vector3) => p.clone().sub(drag.pivot).applyQuaternion(delta).add(drag.pivot);
    const rotatedVector = (v: THREE.Vector3): V3 => {
      const p = v.clone().applyQuaternion(delta);
      return sceneToData(p);
    };
    const cornerUpdate = (corners: FrozenCorners) => ({
      vertices: corners.members.map(member => {
        const p = rotated(member.pos);
        return { vertex: member.vertex, pos: sceneToData(p) };
      }),
      edgeHandles: corners.edgeHandles.map(handle => ({
        from: handle.from, to: handle.to, offset: rotatedVector(handle.offset),
      })),
      quadTwist: corners.quadTwist.map(twist => ({
        quad: twist.quad,
        offsets: twist.offsets.map(rotatedVector) as [V3, V3, V3, V3],
      })),
    });
    if (drag.kind === 'corners') {
      stage.cb.onRotateCorners?.(cornerUpdate(drag));
      return;
    }
    if (drag.kind === 'controlpoints') {
      const targets = drag.members.map(member => {
        const p = rotated(member.pos);
        return { id: member.id, pos: sceneToData(p) };
      });
      stage.cb.onRotateControlPoints?.(targets);
      host.controlPointsMoved(targets);
      return;
    }
    // Props author a full rotation, so a drag composes the scene-space delta onto the frozen scene-space pose
    // and reads the authored angles back off the product — the same quaternion the positions rode, rather
    // than a separate yaw formula that could disagree with them. `scenePropQuat`'s swizzle is its own
    // inverse, so it carries the result back to data space.
    const authoredRotation = (start: THREE.Quaternion) => {
      const q = delta.clone().multiply(start).normalize();
      return propRotationFromQuat([-q.x, -q.y, q.z, q.w]);
    };
    const propUpdates = (members: FrozenProp[]) => members.map(member => {
      const p = rotated(member.pos);
      return { index: member.index, pos: sceneToData(p), ...authoredRotation(member.rot) };
    });
    if (drag.kind === 'editmixed') {
      const controlPoints = drag.controlPoints.map(member => {
        const p = rotated(member.pos);
        return { id: member.id, pos: sceneToData(p) };
      });
      stage.cb.onRotateMixedEditSelection?.({
        corners: drag.corners ? cornerUpdate(drag.corners) : { vertices: [], edgeHandles: [], quadTwist: [] },
        controlPoints,
        props: propUpdates(drag.props),
      });
      host.controlPointsMoved(controlPoints);
      return;
    }
    const updates = propUpdates(drag.members);
    if (drag.kind === 'prop') {
      const u = updates[0];
      if (u) stage.cb.onRotateProp?.(u.index, { yaw: u.yaw, pitch: u.pitch, roll: u.roll });
    } else stage.cb.onRotateProps?.(updates);
  }

  /** Finish a rotation and return the invisible anchor to its canonical frame for the next gesture. */
  function endRotation() {
    rotationDrag = null;
    if (stage.gizmoKind === 'prop' || stage.gizmoKind === 'props' || stage.gizmoKind === 'controlpoints'
      || stage.gizmoKind === 'editmixed') stage.gizmo.object?.quaternion.identity();
    applyGizmoFrame();
  }

  /** Freeze the selected members at the instant a scale gesture begins. */
  function beginScale() {
    scaleDrag = null;
    const obj = stage.gizmo.object;
    if (!obj) return;
    const anchor = obj.quaternion.clone(), startScale = obj.scale.clone(), pivot = obj.position.clone();
    const frozen = freezeCorners();
    if (frozen) { scaleDrag = { kind: 'corners', anchor, startScale, pivot, ...frozen }; return; }
    if (stage.gizmoKind === 'controlpoints') {
      const byKey = sel.authoredControlPointByKey();
      const members = sel.controlPointSel().flatMap(id => {
        const cp = byKey.get(controlPointKey(id));
        return cp ? [{ id: { ...id } as MeshControlPointId, pos: dataToScene(cp.pos) }] : [];
      });
      if (members.length > 1) scaleDrag = { kind: 'controlpoints', anchor, startScale, pivot, members };
      return;
    }
    if (stage.gizmoKind !== 'prop' && stage.gizmoKind !== 'props') return;
    const selectedProp = sel.selectedProp();
    const indices = stage.gizmoKind === 'prop'
      ? (selectedProp === null ? [] : [selectedProp])
      : sel.multiSelProps();
    const members = indices.flatMap(index => {
      const p = sel.placedProp(index);
      return p ? [{ index, pos: dataToScene(p.pos), scale: p.scale,
        ...(isEffectTriggerProp(p) ? { triggerSize: clampEffectTriggerSize(p.effectTrigger.size) } : {}) }] : [];
    });
    if (members.length) scaleDrag = { kind: stage.gizmoKind, anchor, startScale, pivot, members };
  }

  /** Apply the live scale relative to the frozen drag-start snapshot and emit authored absolute values. */
  function scaleSelection() {
    const drag = scaleDrag, obj = stage.gizmo.object;
    if (!drag || !obj) return;
    const factors = obj.scale.clone().divide(drag.startScale);
    // A generated trigger box is the one placed-prop kind with independent authored dimensions. Its origin
    // is the box centre, so per-axis Scale changes only the extents and the volume stays centred in place.
    if (drag.kind === 'prop' && drag.members[0]?.triggerSize) {
      const size = drag.members[0].triggerSize;
      stage.cb.onResizeEffectTrigger?.(drag.members[0].index, clampEffectTriggerSize([
        size[0] * factors.x, size[1] * factors.y, size[2] * factors.z,
      ]));
      return;
    }
    // Props have one authored scale value. Any axis handle therefore behaves as a uniform size handle; the
    // component that moved farthest from 1 is the TransformControls handle the pointer is driving.
    if (drag.kind === 'prop' || drag.kind === 'props') {
      const factor = Math.max(0.01, [factors.x, factors.y, factors.z]
        .reduce((best, value) => Math.abs(value - 1) > Math.abs(best - 1) ? value : best, factors.x));
      const scaled = (p: THREE.Vector3) => p.clone().sub(drag.pivot).multiplyScalar(factor).add(drag.pivot);
      const updates = drag.members.map(m => {
        const p = scaled(m.pos);
        return { index: m.index, pos: sceneToData(p), scale: m.scale * factor };
      });
      if (drag.kind === 'prop') {
        const u = updates[0];
        if (u) stage.cb.onScaleProp?.(u.index, u.pos, u.scale);
      } else stage.cb.onScaleProps?.(updates);
      return;
    }
    // TransformControls scale is local to the anchor. Move into that frame, apply the per-axis factors, then
    // return to scene space; World has an identity anchor, while Local / Surface carry the slope frame.
    const inv = drag.anchor.clone().invert();
    const scaledVector = (v: THREE.Vector3) => v.clone().applyQuaternion(inv).multiply(factors).applyQuaternion(drag.anchor);
    const scaledPoint = (p: THREE.Vector3) => scaledVector(p.clone().sub(drag.pivot)).add(drag.pivot);
    const authoredVector = (v: THREE.Vector3): V3 => {
      const p = scaledVector(v);
      return sceneToData(p);
    };
    if (drag.kind === 'corners') {
      stage.cb.onScaleCorners?.({
        vertices: drag.members.map(m => {
          const p = scaledPoint(m.pos);
          return { vertex: m.vertex, pos: sceneToData(p) };
        }),
        edgeHandles: drag.edgeHandles.map(h => ({ from: h.from, to: h.to, offset: authoredVector(h.offset) })),
        quadTwist: drag.quadTwist.map(t => ({
          quad: t.quad,
          offsets: t.offsets.map(authoredVector) as [V3, V3, V3, V3],
        })),
      });
      return;
    }
    if (drag.kind !== 'controlpoints') return;
    const targets = drag.members.map(member => {
      const p = scaledPoint(member.pos);
      return { id: member.id, pos: sceneToData(p) };
    });
    stage.cb.onScaleControlPoints?.(targets);
    host.controlPointsMoved(targets);
  }

  /** Finish scaling and restore the invisible anchor to unit scale for its next gesture. */
  function endScale() {
    scaleDrag = null;
    stage.gizmo.object?.scale.setScalar(1);
    applyGizmoFrame();
  }

  /**
   * Surface mode slides. An in-plane ARROW ('X' = down-mountain, 'Z' = cross-slope) or the 'XZ' tangent pad, on a
   * single corner, on an edge / edge-loop selection or on a cell selection, is an exact de Casteljau re-cut: it
   * freezes the control NET (seatExactSlide) and needs no surface probe at all. What falls through freezes the
   * current terrain surface into a BVH instead, so the drag re-projects onto the shape as it was before the drag
   * rather than the surface it is deforming: a corner-REGION group slide (four unrelated corners marching across the
   * surface re-parameterise nothing), which also freezes the net + grid frame (captureSlideGroup) for its
   * ratio-preserving march, and a corner whose surface frame is degenerate (a pinched net names no axes). The 'Y' up
   * post is the deliberate off-surface move and takes neither. Cleared on drag end.
   */
  function beginSlide() {
    slideBVH = null;
    slideGroup = null;
    slideExact = null;
    slideMergePending = false;
    if (resolveGizmoFrame(gizmoFrame, gizmoShift) !== 'surface') return;
    if (stage.gizmoKind !== 'corner' && stage.gizmoKind !== 'corners') return;
    seatExactSlide();
    if (slideExact) return; // the slide re-cuts the net exactly; no surface probe can be more faithful
    slideBVH = mesh.terrainBVH();
    if (slideBVH && stage.gizmoKind === 'corners') captureSlideGroup();
  }

  /** Drag over: drop both freezes, take the merge hint down, and hand any pending weld to the host — on RELEASE,
   *  because a mid-drag id remap would pull the selection, the gizmo and the frozen snapshot out from under the
   *  gesture. Then re-orient the gizmo for the next drag. */
  function endSlide() {
    const exact = !!slideExact;
    const merge = slideMergePending;
    slideBVH = null;
    slideGroup = null;
    slideExact = null;
    setSlideMergePending(false);
    if (exact) stage.cb.onSlideEnd?.(merge);
    applyGizmoFrame();
  }

  /**
   * Freeze the parent net a Surface-mode slide re-cuts (see SlideExact) and tell the host to snapshot its doc to
   * match. Seats for the three selections a slide is defined on: a single corner sliding along its own edges, an
   * edge / edge-loop sliding across the quads it borders, and a cell selection carrying BOTH of its boundaries
   * forward (planCellSlide). A corner REGION is none of those — it moves four unrelated corners at once, a march
   * along the surface that re-cuts no curve — so it falls through to the frozen-BVH group slide. The three edit
   * sets are mutually exclusive (main.ts's selection families), so the 'corners' gizmo tells a cell from a region
   * by which of them the viewport is holding: `editEdgeSel` is an edge, `editCellSel` a cell, neither a region.
   *
   * `gizmo.axis` is current here: TransformControls' pointerdown runs its hover pass before it flips `dragging`,
   * whose setter is what dispatches the event that lands us in beginSlide. It knows WHICH handle, not yet which way
   * along it — so a seat may only test what holds for both signs.
   */
  function seatExactSlide() {
    const ax = stage.gizmo.axis;
    if (ax !== 'X' && ax !== 'Z' && ax !== 'XZ') return;
    const s = buildSlideExact(true);
    if (!s) return;
    // A cell selection that can plan NOTHING on any axis the handle can drive — every member a wedge, whose
    // collapsed row has no opposite boundary to cut across — seats no exact slide, so the drag falls to the frozen
    // BVH instead of standing dead. The axis tangent stands in for the drag: neither wedge-ness nor a degenerate
    // `dir` turns on the sign pointer-down does not know yet. The pad seats if EITHER axis plans; a rim cell plans
    // fine (`blocked`) and clamps, exactly as a rim edge does.
    if (s.cells.length) {
      const plans = (dir: V3) => !!planCellSlide(s.mesh, s.adj, s.cells, dir, id => frozenPos(s, id));
      if (!(ax === 'X' ? plans(s.tu) : ax === 'Z' ? plans(s.padV) : plans(s.tu) || plans(s.padV))) return;
    }
    slideExact = s;
    stage.cb.onSlideBegin?.();
  }

  /**
   * The `SlideExact` for whatever the gizmo is seated on — a single corner, an edge / edge loop, or a cell selection
   * — or null off those three families (a corner REGION re-parameterises nothing) and off a pinched net, whose
   * degenerate frame names no axes at all.
   *
   * `freeze` COPIES the net, because a drag's re-cut is only exact against the one it opened on and the host installs
   * a fresh doc every frame (`quads` never changes under a slide, so it rides along by reference). Unfrozen, the same
   * record is a read-only view over the live net, which is what the arrow rails are drawn from between drags — cheap,
   * because the mesh, its adjacency and its edge handles are all already cached from the last rebuild.
   */
  function buildSlideExact(freeze: boolean): SlideExact | null {
    const doc = mesh.meshDoc(), pv = mesh.preview(), net = mesh.net();
    if (!doc || !pv || !net) return null;
    const group = stage.gizmoKind === 'corners';
    const corner = stage.gizmoKind === 'corner' ? sel.selectedCorner() : null;
    const edges = group ? sel.editEdgeSel() : [];
    const cells = group && !edges.length ? sel.editCellSel() : [];
    if (corner === null && !edges.length && !cells.length) return null;
    const frame = corner !== null ? cornerFrame(corner) : regionFrame();
    if (!frame) return null; // a pinched net has no surface axes: nothing tells the handles apart
    const anchor = corner !== null ? anchors.cornerMarker : anchors.cornerGroupHandle;
    const quadMesh = freeze ? buildQuadMesh(doc.vertices.slice(), doc.quads, doc.freeEdges) : pv.mesh;
    const eh = freeze ? meshEdgeHandles(quadMesh, doc.edgeHandles ? { ...doc.edgeHandles } : undefined) : mesh.edgeHandle();
    if (!eh) return null;
    // the gizmo's Z arrow: `frameQuat` builds local Z as X × Y, which in data space is `n × tu` — orthonormal to
    // `tu`, and generally NOT the frame's own `tv` (see SlideExact). A pad drag decomposes in (tu, padV).
    const padV = new THREE.Vector3().crossVectors(frame.n, frame.tu);
    return {
      mesh: quadMesh,
      eh,
      adj: freeze ? meshAdjacency(quadMesh) : net.adj,
      twist: freeze && doc.quadTwist ? structuredClone(doc.quadTwist) : doc.quadTwist,
      anchor0: sceneToData(anchor.position),
      tu: [frame.tu.x, frame.tu.y, frame.tu.z],
      tv: [frame.tv.x, frame.tv.y, frame.tv.z],
      padV: [padV.x, padV.y, padV.z],
      vertex: corner ?? -1,
      edges: edges.map(e => [e[0], e[1]] as [number, number]),
      cells: cells.slice(),
    };
  }

  /**
   * The four curves the Surface-mode arrows draw (gizmo/arcs.ts), asked for once per frame by the gizmo's own
   * `updateMatrixWorld` wrapper. Each is the rail a pure-axis drag down that arrow reads its parameter off — the
   * anchor's own path — so the arrow ends on the vertex the drag clamps and merges at, and bends with the slope in
   * between. Mid-drag they come off the FROZEN net, whose axes the handle's quaternion was built from and is still
   * holding; between drags off the live one. Null takes the stock straight arrows back: World mode, a knot, a corner
   * region, or an anchor with no rail in any direction at all.
   */
  function arcRails(): SurfaceRails | null {
    if (!stage.gizmoRestrict) return null;
    // Always the LIVE net, even mid-drag — NOT the frozen `slideExact`. A drag re-cuts the doc every frame and the
    // host re-installs it, so a fresh seat reads the corner where it now IS and the rails toward the neighbours it now
    // has: the arrow you pull re-originates on the sliding corner and shrinks onto the vertex it will merge with, and
    // the cross arrow swings to the surface direction from the new spot. The frozen net governs the geometry of the
    // re-cut; the live net is the honest picture of the arrows.
    const s = buildSlideExact(false);
    if (!s) return null;
    const rails: SurfaceRails = {
      anchor: s.anchor0,
      xPlus: slideRail(s, s.tu), xMinus: slideRail(s, mul(s.tu, -1)),
      zPlus: slideRail(s, s.padV), zMinus: slideRail(s, mul(s.padV, -1)),
    };
    return rails.xPlus || rails.xMinus || rails.zPlus || rails.zMinus ? rails : null;
  }

  /** Raise / lower the merge hint exactly on its transitions, so a drag held at the clamp doesn't re-announce it
   *  sixty times a second. */
  function setSlideMergePending(pending: boolean) {
    if (pending === slideMergePending) return;
    slideMergePending = pending;
    stage.cb.onSlideMergePending?.(pending);
  }

  /**
   * One frame of an EXACT slide: resolve the dragged anchor into the pad's two coordinates against the frozen net
   * (slideDragFrame), hand the re-cut plan to the host (planSlideRecut), and park the anchor where the geometry
   * landed so the gizmo tracks it (safe: TransformControls recomputes the position from its own drag-start each
   * move, so nothing accumulates — the same trick `slideProject` plays). Returns true when it owned the frame,
   * keeping the vertical-ray re-projection and the plain corner move out of the way — including when the drag has
   * nowhere to go, because a seated slide is the whole story for that gesture.
   */
  function slideRecut(obj: THREE.Object3D): boolean {
    const s = slideExact;
    const ax = stage.gizmo.axis;
    if (!s || (ax !== 'X' && ax !== 'Z' && ax !== 'XZ')) return false;
    const p = sceneToData(obj.position);
    const g = slideDragFrame(s, ax, p);
    if (!g) return true;
    const cut = planSlideRecut(s, g);
    if (!cut) return true;
    stage.cb.onSlideRecut?.(cut.plan);
    setScenePositionFromData(obj.position, cut.pos);
    if (obj === anchors.cornerGroupHandle) anchors.cornerGroupHandleLast.set(cut.pos[0], cut.pos[1], cut.pos[2]); // keep the Move baseline on the handle
    setSlideMergePending(cut.merge);
    return true;
  }

  /** Freeze the net + the group's grid frame + mean cell size for a multi-corner Slide, so slideGroupUpdate
   *  can express the drag as a uniform grid FRACTION (each member advances that fraction of its own cell). */
  function captureSlideGroup() {
    slideGroup = null;
    const net = mesh.net(), doc = mesh.meshDoc(), groupIdx = sel.cornerGroupIdx();
    if (!net || !doc || !groupIdx.length) return;
    const frame = regionFrame();
    if (!frame) return;
    // The frozen net is what the march reads; the names are what the host writes the result back under, so a
    // re-cut between two frames of the same drag cannot land a member's new position on its neighbour.
    const members = groupIdx.flatMap(index => {
      const vertex = doc.vertexIds[index];
      return vertex === undefined ? [] : [{ vertex, index }];
    });
    if (!members.length) return;
    const { positions, adj } = net;
    const net0 = Float32Array.from(positions);
    const dist = (i: number, j: number) => Math.hypot(net0[i * 3] - net0[j * 3], net0[i * 3 + 1] - net0[j * 3 + 1], net0[i * 3 + 2] - net0[j * 3 + 2]);
    let rs = 0, rn = 0, cs = 0, cn = 0; // mean neighbour distance (cell size) over the selection, per surface axis
    for (const idx of groupIdx) {
      const { u, v } = vertexAxes(adj, idx);
      const un = u[1] >= 0 ? u[1] : u[0], vn = v[1] >= 0 ? v[1] : v[0]; // a neighbour along each axis (either side)
      if (un >= 0) { rs += dist(idx, un); rn++; }
      if (vn >= 0) { cs += dist(idx, vn); cn++; }
    }
    const h = anchors.cornerGroupHandle.position;
    slideGroup = {
      net0, adj, members,
      tu: frame.tu.clone(), tv: frame.tv.clone(), n: frame.n.clone(),
      rowStepAvg: rn ? rs / rn : 1, colStepAvg: cn ? cs / cn : 1,
      handle0: new THREE.Vector3(h.x, h.y, -h.z), // scene → data
    };
  }

  /** Slide, the fallback: re-project a dragged corner onto the frozen surface — replace its Y with the surface height
   *  at its current (x, z). Skipped for the up (Y) handle, which is the deliberate off-surface move. `slideRecut` owns
   *  every corner whose net can be re-cut, arrows and tangent pad alike, so what reaches here is a corner the exact
   *  slide refused: a DEGENERATE surface frame (a pinched net names no axes, so nothing tells the handles apart) or a
   *  legacy grid document with no quad mesh to freeze. The ray is wrong on an overhang, and it is all a corner with no
   *  axes has. A corner REGION never reaches here either — it re-parameterises nothing, and four unrelated corners
   *  marching across the surface are `slideGroupUpdate`'s business. Works in the terrain's local/data frame (worldRoot
   *  only flips Z, so a vertical ray + Y read need no transform). */
  function slideProject(obj: THREE.Object3D) {
    if (!slideBVH || stage.gizmoKind !== 'corner' || !stage.gizmo.axis || stage.gizmo.axis === 'Y') return;
    slideRay.origin.set(obj.position.x, 1e5, -obj.position.z); // scene → data: negate Z
    slideRay.direction.set(0, -1, 0);
    const hit = slideBVH.raycastFirst(slideRay, THREE.DoubleSide, 0, 2e5);
    if (hit) obj.position.y = hit.point.y; // data Y == scene Y
  }

  /** Multi-corner Slide: turn the centre handle's drag into a uniform grid FRACTION and move every member
   *  that fraction of ITS OWN cell toward its next vertex — so a band slid "half a cell down-mountain" keeps
   *  its ratios on a non-uniform net — then ride the frozen surface. The handle's normal component lifts the
   *  whole group off the surface (the deliberate move); tangential components slide + re-project. `p` is the
   *  handle's current data-space position. */
  function slideGroupUpdate(p: V3) {
    const g = slideGroup!;
    const dx = p[0] - g.handle0.x, dy = p[1] - g.handle0.y, dz = p[2] - g.handle0.z; // handle displacement (data)
    const fu = (dx * g.tu.x + dy * g.tu.y + dz * g.tu.z) / g.rowStepAvg; // fraction of a cell down-mountain (u)
    const fv = (dx * g.tv.x + dy * g.tv.y + dz * g.tv.z) / g.colStepAvg; // fraction of a cell cross-slope (v)
    const fn = dx * g.n.x + dy * g.n.y + dz * g.n.z;                     // normal lift (world units, off-surface)
    const { net0, adj } = g;
    const updates: { vertex: VertexName; pos: V3 }[] = [];
    for (const { vertex, index: idx } of g.members) {
      const b = idx * 3;
      // step toward the neighbour along each surface axis (either side at the net edge), then ORIENT it to
      // the gizmo's red (u=tu) / blue (v=tv) arrow so the drag never runs backwards on a flipped axis.
      const { u, v } = vertexAxes(adj, idx);
      const rowJ = (u[1] >= 0 ? u[1] : u[0] >= 0 ? u[0] : idx) * 3;
      const colJ = (v[1] >= 0 ? v[1] : v[0] >= 0 ? v[0] : idx) * 3;
      const rvy = net0[rowJ + 1] - net0[b + 1], cvy = net0[colJ + 1] - net0[b + 1];
      let rvx = net0[rowJ] - net0[b], rvz = net0[rowJ + 2] - net0[b + 2];
      let cvx = net0[colJ] - net0[b], cvz = net0[colJ + 2] - net0[b + 2];
      if (rvx * g.tu.x + rvy * g.tu.y + rvz * g.tu.z < 0) { rvx = -rvx; rvz = -rvz; }
      if (cvx * g.tv.x + cvy * g.tv.y + cvz * g.tv.z < 0) { cvx = -cvx; cvz = -cvz; }
      const nx = net0[b] + fu * rvx + fv * cvx;
      const nz = net0[b + 2] + fu * rvz + fv * cvz;
      let ny = net0[b + 1];
      if (slideBVH) { // ride the frozen surface at the slid (x, z)
        slideRay.origin.set(nx, 1e5, nz);
        slideRay.direction.set(0, -1, 0);
        const hit = slideBVH.raycastFirst(slideRay, THREE.DoubleSide, 0, 2e5);
        if (hit) ny = hit.point.y;
      }
      updates.push({ vertex, pos: [nx + fn * g.n.x, ny + fn * g.n.y, nz + fn * g.n.z] }); // + normal lift
    }
    stage.cb.onSlideCorners?.(updates);
  }

  /** Seat the best local frame on the active corner anchor. Surface topology uses its tangent frame; Local
   *  may fall back to an edge-connected frame when the selection has no surface. */
  function orientGizmoToLocal(edgeFallback = false) {
    const corner = sel.selectedCorner();
    const frame = stage.gizmoKind === 'corners' ? regionFrame(edgeFallback)
      : corner !== null ? cornerFrame(corner, edgeFallback) : null;
    const anchor = stage.gizmoKind === 'corners' ? anchors.cornerGroupHandle : anchors.cornerMarker;
    if (frame) anchor.quaternion.copy(frameQuat(frame.tu, frame.tv, frame.n));
    else anchor.quaternion.identity();
  }

  /** The surface directions at corner `index` (the two axis tangents + skyward normal from the topology
   *  neighbour-ring — vertexFrame; on a grid this is the same central-difference frame as before), in DATA
   *  space; null if any is degenerate. */
  function cornerFrame(index: number, edgeFallback = false): LocalFrame | null {
    const net = mesh.net();
    if (!net) return null;
    const f = vertexFrame(net.positions, net.adj, index);
    const tu = new THREE.Vector3(f.tu[0], f.tu[1], f.tu[2]);
    const tv = new THREE.Vector3(f.tv[0], f.tv[1], f.tv[2]);
    const n = new THREE.Vector3(f.n[0], f.n[1], f.n[2]);
    if (tu.lengthSq() < 1e-10 || tv.lengthSq() < 1e-10 || n.lengthSq() < 1e-10)
      return edgeFallback ? edgeConnectedFrame(net.positions, net.adj, index) : null;
    return { tu: tu.normalize(), tv: tv.normalize(), n }; // n already unit from vertexFrame
  }

  /** The averaged surface frame over the multi-corner selection (its centroid gizmo), from the members' own
   *  frames; null if empty / degenerate (opposing normals cancel), which falls the gizmo back to world. */
  function regionFrame(edgeFallback = false): LocalFrame | null {
    return averagedCornerFrame(sel.cornerGroupIdx(), edgeFallback);
  }

  /** The averaged owner-corner frame of directly-selected sub-cage points. Boundary handles use their FROM
   *  vertex; patch interiors use their corresponding patch corner (both recorded as anchorVertex). */
  function controlPointFrame(edgeFallback = false): LocalFrame | null {
    const byKey = sel.authoredControlPointByKey();
    const anchors = sel.controlPointSel().flatMap(id => {
      const cp = byKey.get(controlPointKey(id));
      return cp ? [cp.anchorVertex] : [];
    });
    return averagedCornerFrame(anchors, edgeFallback);
  }

  /** Average any set of owner corners into one stable tangent frame for a centroid gizmo. */
  function averagedCornerFrame(indices: readonly number[], edgeFallback = false): LocalFrame | null {
    const sumN = new THREE.Vector3(), sumU = new THREE.Vector3();
    let cnt = 0;
    for (const idx of indices) {
      const f = cornerFrame(idx, edgeFallback);
      if (!f) continue;
      sumN.add(f.n); sumU.add(f.tu); cnt++;
    }
    if (!cnt || sumN.lengthSq() < 1e-8) return null;
    const n = sumN.normalize();
    const tu = sumU.addScaledVector(n, -sumU.dot(n)); // mean down-mountain projected into the mean tangent plane
    if (tu.lengthSq() < 1e-8) return null;
    tu.normalize();
    return { tu, tv: new THREE.Vector3().crossVectors(n, tu), n };
  }

  /** Build the scene-root (Z-negated) quaternion for a data-space surface frame: local Y = normal (up post),
   *  X = the down-mountain tangent projected into the tangent plane, Z = X × Y (right-handed cross-slope), so
   *  the gizmo's XZ plane is the tangent pad. Orthonormal + right-handed by construction (a valid rotation). */
  function frameQuat(tu: THREE.Vector3, tv: THREE.Vector3, n: THREE.Vector3): THREE.Quaternion {
    const flipZ = (v: THREE.Vector3) => new THREE.Vector3(v.x, v.y, -v.z); // data dir → flipped scene-root dir
    const yAxis = flipZ(n).normalize();
    let xAxis = flipZ(tu); xAxis.addScaledVector(yAxis, -xAxis.dot(yAxis)); // project off the normal → in-plane
    if (xAxis.lengthSq() < 1e-8) { // down-mountain ~parallel to the normal — use the cross-slope dir instead
      xAxis = flipZ(tv); xAxis.addScaledVector(yAxis, -xAxis.dot(yAxis));
    }
    xAxis.normalize();
    const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
    return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
  }

  // the Surface arrows bend along the rails the slide runs down, asked for once per frame by the gizmo's own
  // update wrapper; the layer answers off the live selection + net through its accessors.
  stage.surfaceRails = () => arcRails();

  return {
    /** The active W / E / R transform tool; rotate / scale are selection-gated (rotationActive / scaleActive). */
    get mode() { return gizmoMode; },
    /** A frozen-net group slide is live (a corner-REGION drag): its updates belong to slideGroupUpdate. */
    get groupSliding() { return slideGroup !== null; },
    setGizmoFrame, setGizmoMode, shiftKey, applyGizmoFrame,
    rotationActive, scaleActive,
    beginRotation, rotateSelection, endRotation,
    beginScale, scaleSelection, endScale,
    beginSlide, endSlide, slideRecut, slideProject, slideGroupUpdate,
  };
}

export type TransformLayer = ReturnType<typeof createTransformLayer>;
