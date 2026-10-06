import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import { pathHandleOffsets } from '../../../core/rails/rails';
import type { Stage } from '../stage';
import type { PathHandleSide, PathOwner, ShownPath } from '../types';

export type { PathHandleSide, PathOwner, ShownPath } from '../types';

const BULB_GEO = new THREE.SphereGeometry(1, 10, 8);
const HANDLE_COLOR = 0xff4fb8; // pink: apart from every node bulb (amber rails, teal lines and trails)

/**
 * The Bézier handles of the selected authored path's selected point (docs/014): a bulb at the end of each of its
 * two handles and a line back to the point — the picture the Edit cage gives a corner's tangents, and like the
 * cage only for the point in hand, so a long path is not a thicket of handles. A handle someone dragged is drawn
 * solid; one still on the automatic curve is faint, so the point shows at a glance whether it was shaped by hand. One path at a time, whichever family it is: rails, motion paths, prop lines and trails share
 * this layer, its pick and its gizmo kind (`'pathhandle'`), and the host routes the drag by the owner.
 */
export function createPathHandlesLayer(stage: Stage) {
  let shown: ShownPath | null = null;
  let selected: { node: number; side: PathHandleSide } | null = null;
  let onSelect: ((owner: PathOwner, node: number, side: PathHandleSide) => void) | null = null;
  const group = new THREE.Group();
  const bulbs: THREE.Mesh[] = [];
  const moveHandle = new THREE.Object3D(); // scene-root gizmo anchor, Z negated by hand like the other nodes
  const setMat = new THREE.MeshBasicMaterial({ color: HANDLE_COLOR, depthTest: false, depthWrite: false });
  const autoMat = new THREE.MeshBasicMaterial({ color: HANDLE_COLOR, depthTest: false, depthWrite: false, transparent: true, opacity: 0.45 });
  const selMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false });
  const lineMat = new THREE.LineBasicMaterial({ color: HANDLE_COLOR, depthTest: false, depthWrite: false, transparent: true, opacity: 0.8 });
  group.renderOrder = 10_001;
  stage.worldRoot.add(group);
  moveHandle.visible = false;
  stage.scene.add(moveHandle);

  const handlePos = (node: number, side: PathHandleSide): V3 | null => {
    if (!shown?.nodes[node]) return null;
    const offset = pathHandleOffsets(shown.nodes, shown.handles)[node][side];
    const p = shown.nodes[node];
    return offset ? [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]] : null;
  };

  function clearDrawn() {
    for (const child of [...group.children]) {
      group.remove(child);
      if (child instanceof THREE.Line) child.geometry.dispose(); // bulbs share BULB_GEO
    }
    bulbs.length = 0;
  }

  function redraw() {
    clearDrawn();
    if (!shown || shown.nodes.length < 2) return;
    const offsets = pathHandleOffsets(shown.nodes, shown.handles);
    const radius = shown.bulbRadius * 0.7;
    const segments: number[] = [];
    shown.nodes.forEach((p, node) => {
      if (node !== shown!.node) return;
      for (const side of ['in', 'out'] as const) {
        const offset = offsets[node][side];
        if (!offset) continue;
        const at: V3 = [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]];
        const isSelected = selected?.node === node && selected.side === side;
        const bulb = new THREE.Mesh(BULB_GEO, isSelected ? selMat : shown!.handles?.[node]?.[side] ? setMat : autoMat);
        bulb.scale.setScalar(isSelected ? radius * 1.4 : radius);
        bulb.position.set(at[0], at[1], at[2]);
        bulb.renderOrder = 10_001;
        bulb.userData.pathHandle = { node, side };
        bulb.raycast = () => { /* scene-wide picks pass the handles by; pickHandle tests them itself */ };
        bulbs.push(bulb);
        group.add(bulb);
        segments.push(p[0], p[1], p[2], at[0], at[1], at[2]);
      }
    });
    if (segments.length) {
      const lines = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat);
      lines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3));
      lines.renderOrder = 10_000;
      lines.raycast = () => { /* the bulbs are what a click lands on */ };
      group.add(lines);
    }
  }

  /** Keep the gizmo on the selected handle, except mid-drag, when it owns its own position. */
  function syncGizmo() {
    const at = selected ? handlePos(selected.node, selected.side) : null;
    if (at) {
      if (stage.gizmoKind === 'pathhandle' && stage.gizmo.dragging) return;
      moveHandle.position.set(at[0], at[1], -at[2]);
      moveHandle.visible = true;
      if (stage.gizmoKind !== 'pathhandle' || stage.gizmo.object !== moveHandle) stage.attachGizmo(moveHandle, 'pathhandle', selected!.node);
    } else {
      selected = null;
      moveHandle.visible = false;
      if (stage.gizmoKind === 'pathhandle') stage.detachGizmo();
    }
  }

  const sameOwner = (a: PathOwner | null | undefined, b: PathOwner | null | undefined) =>
    !!a && !!b && a.family === b.family && a.id === b.id;

  /** Show a path's handles (null hides them), with one of them selected and carrying the gizmo. */
  function setPath(path: ShownPath | null, handle: { node: number; side: PathHandleSide } | null) {
    shown = path && path.nodes.length >= 2 ? path : null;
    selected = shown && handle?.node === shown.node ? handle : null;
    redraw();
    syncGizmo();
  }

  /** A click on a handle bulb (the pointer ray already cast) selects it and seats the gizmo; returns whether one was hit. */
  function pickHandle(): boolean {
    if (!shown || !bulbs.length) return false;
    const hits: THREE.Intersection[] = [];
    for (const bulb of bulbs) THREE.Mesh.prototype.raycast.call(bulb, stage.ray, hits);
    hits.sort((a, b) => a.distance - b.distance);
    const hit = hits[0]?.object.userData.pathHandle as { node: number; side: PathHandleSide } | undefined;
    if (!hit) return false;
    selected = hit;
    redraw();
    syncGizmo();
    onSelect?.(shown.owner, hit.node, hit.side);
    return true;
  }

  return {
    setPath, pickHandle,
    setHost(host: { select: (owner: PathOwner, node: number, side: PathHandleSide) => void }) { onSelect = host.select; },
    /** Whether `owner` is the path shown. */
    shows: (owner: PathOwner | null) => sameOwner(shown?.owner, owner),
    get owner(): PathOwner | null { return shown?.owner ?? null; },
    get selected() { return selected; },
  };
}

export type PathHandlesLayer = ReturnType<typeof createPathHandlesLayer>;
