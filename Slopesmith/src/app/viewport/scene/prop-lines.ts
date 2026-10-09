import * as THREE from 'three';
import type { PropLine, V3 } from '../../../core/doc/types';
import { sampleRail } from '../../../core/rails/rails';
import type { Stage } from '../stage';

const NODE_GEO = new THREE.SphereGeometry(0.6, 10, 8); // shared node pick bulb, the size a rail's is
/** How far the path guide floats over the nodes it joins, so it reads above snow the curve dips into. */
const GUIDE_LIFT = 0.3;

/**
 * Prop lines in the viewport (docs/070). The members are ordinary placements the props layer draws; this layer
 * draws only what is ABOUT a line — and only for the selected one, so an idle mountain shows fences, not
 * wiring: the path through its nodes, a pick bulb per node, the translate gizmo on the selected node, and, while
 * a line is being drawn, a rubber band from its last node to the cursor. Built under `stage.worldRoot` in data
 * coords, like the rail guides these mirror. The shell's input dispatch drives it and owns the cross-selection
 * exclusion (a line node and a prop / light / rail node cannot both be selected).
 */
export function createPropLinesLayer(stage: Stage) {
  const group = new THREE.Group();
  let lines: readonly PropLine[] = [];
  let selectedLine: string | null = null;
  let selectedNode: number | null = null;
  let drawing = false;                          // the line tool is drawing: a props-mode ground click adds a node
  const moveHandle = new THREE.Object3D();      // scene-root gizmo anchor for the selected node
  // Teal, apart from the rail palette (amber bulbs, red/white/blue guides) and the course's green: a line is
  // neither a grind nor the run. depthTest off, like a motion path, because the path is often inside the
  // fence it lays out and the point is to see where it runs.
  const guideMat = new THREE.LineBasicMaterial({ color: 0x4fd8c4, transparent: true, opacity: 0.95, depthTest: false });
  const bandMat = new THREE.LineDashedMaterial({ color: 0x4fd8c4, dashSize: 0.8, gapSize: 0.6, depthTest: false });
  const nodeMat = new THREE.MeshBasicMaterial({ color: 0x4fd8c4, depthTest: false });
  const nodeSelMat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
  const band = new THREE.Line(new THREE.BufferGeometry(), bandMat);
  band.visible = false;
  band.renderOrder = 91;
  band.raycast = () => { /* a preview of the next click, never a pick target */ };

  const lineAt = (id: string | null) => id === null ? undefined : lines.find(line => line.id === id);

  /** Arm / disarm drawing: while armed, a props-mode ground click appends a node to the selected line. */
  function setDrawing(on: boolean) {
    drawing = on;
    if (!on) band.visible = false;
  }

  /** Take down the drawn guide + bulbs (the rubber band is kept; it is shown and hidden on its own). */
  function clearDrawn() {
    for (const child of [...group.children]) {
      if (child === band) continue;
      group.remove(child);
      child.traverse(n => { if (n instanceof THREE.Line) n.geometry.dispose(); }); // bulbs share NODE_GEO
    }
  }

  /** Rebuild the selected line's guide + bulbs from the doc, and keep the selected node's gizmo in sync. */
  function setLines(next: readonly PropLine[], selLine: string | null, selNode: number | null) {
    clearDrawn();
    lines = next;
    selectedLine = selLine;
    selectedNode = selNode;
    const line = lineAt(selLine);
    if (line) group.add(buildLineObject(line, selNode));
    const node = line && selNode !== null ? line.nodes[selNode] : undefined;
    if (node) {
      if (!(stage.gizmoKind === 'linenode' && stage.gizmo.dragging)) {
        placeHandle(node);
        moveHandle.visible = true;
        if (stage.gizmoKind !== 'linenode') stage.attachGizmo(moveHandle, 'linenode', selNode!);
        else stage.reframeGizmo(); // a Surface frame re-reads the slope the point now stands on
      }
    } else if (stage.gizmoKind === 'linenode') {
      moveHandle.visible = false;
      stage.detachGizmo();
    }
    if (!line) band.visible = false;
  }

  /** One line's markers: the curve through its nodes and a pick bulb per node (the selected one white + larger). */
  function buildLineObject(line: PropLine, selNode: number | null): THREE.Group {
    const g = new THREE.Group();
    const sampled = sampleRail(line.nodes, 24, line.handles);
    if (sampled.length >= 2) {
      const guide = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(sampled.map(p => new THREE.Vector3(p[0], p[1] + GUIDE_LIFT, p[2]))),
        guideMat);
      guide.renderOrder = 90;
      guide.raycast = () => { /* the bulbs and the members are what a click lands on */ };
      g.add(guide);
    }
    line.nodes.forEach((p, n) => {
      const bulb = new THREE.Mesh(NODE_GEO, n === selNode ? nodeSelMat : nodeMat);
      bulb.scale.setScalar(n === selNode ? 1.7 : 1);
      bulb.position.set(p[0], p[1] + GUIDE_LIFT, p[2]);
      bulb.renderOrder = 91;
      bulb.userData.lineId = line.id;
      bulb.userData.lineNode = n; // a raycast hit resolves the exact node off the bulb
      g.add(bulb);
    });
    return g;
  }

  /**
   * While drawing: a dashed band from the line's last node to the ground under the cursor, so the next click's
   * segment is visible before it is made. Null (off the terrain, or not drawing) hides it.
   */
  function updateBand(point: V3 | null) {
    const last = lineAt(selectedLine)?.nodes.at(-1);
    if (!drawing || !point || !last) { band.visible = false; return; }
    band.geometry.setFromPoints([
      new THREE.Vector3(last[0], last[1] + GUIDE_LIFT, last[2]),
      new THREE.Vector3(point[0], point[1] + GUIDE_LIFT, point[2]),
    ]);
    band.computeLineDistances();
    band.visible = true;
  }

  /** Select line `id` node `n` (or the line alone): seat the gizmo on the node and tell the host. */
  function seatNode(id: string, n: number | null) {
    selectedLine = id;
    selectedNode = n;
    const node = n === null ? undefined : lineAt(id)?.nodes[n];
    if (node) {
      placeHandle(node);
      moveHandle.visible = true;
      stage.attachGizmo(moveHandle, 'linenode', n!);
    } else {
      moveHandle.visible = false;
      if (stage.gizmoKind === 'linenode') stage.detachGizmo();
    }
    stage.cb.onSelectLineNode?.(id, n);
  }

  /** Seat the scene-root gizmo handle on a node (data pos, Z negated onto the flipped scene). */
  function placeHandle(p: V3) { moveHandle.position.set(p[0], p[1], -p[2]); }

  /** Drop any line selection: its guide and bulbs go, and the gizmo is released if it was on a node. */
  function clearSelection() {
    if (selectedLine === null && stage.gizmoKind !== 'linenode') return;
    selectedLine = null;
    selectedNode = null;
    clearDrawn();
    moveHandle.visible = false;
    band.visible = false;
    if (stage.gizmoKind === 'linenode') stage.detachGizmo();
  }

  group.add(band);
  stage.worldRoot.add(group); // data coordinates, like the rails
  moveHandle.visible = false;
  stage.scene.add(moveHandle); // scene-root anchor, Z negated by hand like the other nodes

  return {
    get group() { return group; },
    get lines() { return lines; },
    get selectedLine() { return selectedLine; },
    get selectedNode() { return selectedNode; },
    get drawing() { return drawing; },
    setDrawing, setLines, updateBand, seatNode, clearSelection,
  };
}

export type PropLinesLayer = ReturnType<typeof createPropLinesLayer>;
