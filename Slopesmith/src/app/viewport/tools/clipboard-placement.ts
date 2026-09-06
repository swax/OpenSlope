import * as THREE from 'three';
import type { QuadMeshDoc, V3 } from '../../../core/doc/types';
import { meshCageEdges } from '../../../core/mesh/topology';
import type { MeshVertexClipboard } from '../../../core/mesh/clipboard';
import { sub } from '../../../core/math/vec';
import { buildMountainPreview } from '../../../core/mesh/tessellation';
import { LOFT_PREVIEW_FILL_COLOR } from '../constants';
import { addCageLines, addCagePoints, clearGlyphGroup } from '../shared/overlays';
import type { Stage } from '../stage';
import { lockedViewAxis, type ViewAxis } from '../camera/view-grid';

export type ClipboardPlacementDeps = {
  meshDoc: () => QuadMeshDoc | null;
  terrain: () => THREE.Mesh;
  reference: () => THREE.Mesh | null;
};

const AXIS_INDEX: Record<ViewAxis, number> = { x: 0, y: 1, z: 2 };

/** Translate a clipboard centroid to a pointer target while retaining depth in a snapped axis view. */
export function clipboardPlacementOffset(point: V3, center: V3, hiddenAxis: ViewAxis | null): V3 {
  const offset = sub(point, center);
  if (hiddenAxis) offset[AXIS_INDEX[hiddenAxis]] = 0;
  return offset;
}

/** One-shot vertex clipboard placement. This layer owns the faithful surface/cage ghost, centroid translation,
 * authored-vs-reference hit policy, free-space construction plane, and hover/click lifecycle; the shell only
 * arbitrates it against other tools. */
export function createClipboardPlacementLayer(stage: Stage, deps: ClipboardPlacementDeps) {
  let clip: MeshVertexClipboard | null = null;
  let center: V3 = [0, 0, 0];
  let translation: V3 | null = null;

  const group = new THREE.Group();
  const fill = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({
      color: LOFT_PREVIEW_FILL_COLOR,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
    }),
  );
  const cage = new THREE.Group();
  fill.renderOrder = 10;
  fill.raycast = () => { /* placement preview is never a pick target */ };
  group.add(fill, cage);
  group.visible = false;
  stage.worldRoot.add(group);

  function clearVisual() {
    translation = null;
    group.visible = false;
    group.position.set(0, 0, 0);
    fill.geometry.dispose();
    fill.geometry = new THREE.BufferGeometry();
    clearGlyphGroup(cage);
  }

  /** Returns true when a usable ghost was armed. */
  function setClip(next: MeshVertexClipboard | null): boolean {
    clip = next;
    clearVisual();
    const source = deps.meshDoc();
    if (!clip?.vertices.length || !source) return false;

    let x = 0, y = 0, z = 0;
    const count = clip.vertices.length / 3;
    for (let i = 0; i < clip.vertices.length; i += 3) {
      x += clip.vertices[i]; y += clip.vertices[i + 1]; z += clip.vertices[i + 2];
    }
    center = [x / count, y / count, z / count];

    const ghostDoc: QuadMeshDoc = {
      ...source,
      vertices: clip.vertices,
      quads: clip.quads,
      freeEdges: clip.freeEdges,
      edgeHandles: clip.edgeHandles,
      quadPaint: clip.quadPaint,
      quadTex: clip.quadTex,
      quadOrient: clip.quadOrient,
      quadTwist: clip.quadTwist,
    };
    const preview = buildMountainPreview(ghostDoc);
    if (preview.positions.length) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(preview.positions, 3));
      geometry.setIndex(new THREE.BufferAttribute(preview.indices, 1));
      fill.geometry = geometry;
    }
    fill.visible = preview.positions.length > 0;
    const edges = meshCageEdges(preview.mesh, preview.edgeHandle);
    addCageLines(cage, edges.interior, LOFT_PREVIEW_FILL_COLOR, 0.95, false, 11);
    addCageLines(cage, edges.boundary, LOFT_PREVIEW_FILL_COLOR, 0.95, false, 11);
    const points = new THREE.BufferGeometry();
    points.setAttribute('position', new THREE.BufferAttribute(new Float32Array(clip.vertices), 3));
    addCagePoints(cage, points, LOFT_PREVIEW_FILL_COLOR, 6, false, 12);
    update();
    return true;
  }

  function placement(): V3 | null {
    if (!clip) return null;
    const offsetTo = (point: V3): V3 => {
      // In an axis view the pointer supplies only the two visible coordinates. Keep the copied geometry's
      // third coordinate verbatim instead of borrowing depth from a terrain hit or the navigation target.
      return clipboardPlacementOffset(stage.snapDataPoint(point), center, lockedViewAxis(stage.camera));
    };
    const terrain = deps.terrain(), reference = deps.reference();
    const targets: THREE.Object3D[] = reference ? [terrain, reference] : [terrain];
    const hit = stage.ray.intersectObjects(targets, false)[0];
    // Keep authored terrain as the surface-placement target. A nearer loaded reference still occludes placement,
    // matching the existing policy; only a genuinely empty ray falls back to the screen-facing focal plane.
    if (hit) {
      if (hit.object !== terrain) return null;
      return offsetTo([hit.point.x, hit.point.y, -hit.point.z]);
    }
    const point = stage.screenPlanePoint();
    if (!point) return null;
    return offsetTo([point.x, point.y, -point.z]);
  }

  function update() {
    translation = placement();
    group.visible = !!translation;
    if (translation) group.position.set(translation[0], translation[1], translation[2]);
  }

  function onHover(event: PointerEvent): boolean {
    if (!clip) return false;
    stage.castAt(event);
    update();
    return true;
  }

  function onCommit() {
    update();
    if (translation) stage.cb.onPasteVertices?.(translation);
  }

  return {
    setClip,
    onHover,
    onCommit,
    refresh: update,
    get active() { return !!clip; },
  };
}

export type ClipboardPlacementLayer = ReturnType<typeof createClipboardPlacementLayer>;
