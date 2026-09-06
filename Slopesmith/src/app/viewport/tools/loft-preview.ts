import * as THREE from 'three';
import type { QuadMeshDoc } from '../../../core/doc/types';
import { meshFromDoc, quadControlPoints } from '../../../core/mesh/topology';
import { patchPoint } from '../../../core/math/bezier';
import type { PreviewData } from '../../../core/mesh/tessellation';
import { PREVIEW_RES } from '../../../core/mesh/tessellation';
import { LOFT_PREVIEW_FILL_COLOR, LOFT_PREVIEW_FILL_OPACITY } from '../constants';
import { tintBackfaces } from '../mesh/backface-tint';
import type { Stage } from '../stage';

/** Teal, non-pickable preview shared by Bridge and Create Patch. It owns the prospective topology and its
 * BufferGeometry; the viewport shell only decides when a tool supplies or temporarily hides that preview. */
export function createLoftPreviewLayer(stage: Stage, getPreview: () => PreviewData | null) {
  let quads: readonly (readonly number[])[] = [];
  let vertices: readonly number[] | null = null;
  let doc: QuadMeshDoc | null = null;
  let quadIds: number[] = [];

  // Back faces tint magenta like the terrain's (backface-tint.ts): the ghost is wound exactly as the commit
  // will be, so a tube shows its dead exterior before it exists.
  const material = tintBackfaces(new THREE.MeshBasicMaterial({
    color: LOFT_PREVIEW_FILL_COLOR,
    transparent: true,
    opacity: LOFT_PREVIEW_FILL_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  }));
  const fill = new THREE.Mesh(new THREE.BufferGeometry(), material);
  fill.renderOrder = 9;
  fill.visible = false;
  fill.raycast = () => { /* action preview, never a pick target */ };
  stage.worldRoot.add(fill);

  function replaceGeometry(positions: number[], indices: number[]) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
    geometry.setIndex(indices);
    fill.geometry.dispose();
    fill.geometry = geometry;
    fill.visible = true;
  }

  function setPreview(next: readonly (readonly number[])[] | null, source?: readonly number[] | QuadMeshDoc | null) {
    quads = next ?? [];
    doc = next && source && !Array.isArray(source) ? source as QuadMeshDoc : null;
    vertices = next && source && Array.isArray(source) ? source : null;
    quadIds = doc ? quads.map(quad => doc!.quads.indexOf(quad as number[])) : [];
    rebuild();
  }

  function rebuild() {
    const preview = getPreview();
    if (!preview || !quads.length) { fill.visible = false; return; }

    if (doc) {
      const { mesh, edgeHandle } = meshFromDoc(doc);
      const side = PREVIEW_RES + 1;
      const positions: number[] = [], indices: number[] = [];
      for (const quadId of quadIds) {
        if (quadId < 0 || quadId >= mesh.quadCount) continue;
        const controls = quadControlPoints(mesh, edgeHandle, quadId, doc.quadTwist?.[quadId] ?? null);
        const base = positions.length / 3;
        for (let u = 0; u < side; u++) for (let v = 0; v < side; v++)
          positions.push(...patchPoint(controls, u / PREVIEW_RES, v / PREVIEW_RES));
        for (let u = 0; u < PREVIEW_RES; u++) for (let v = 0; v < PREVIEW_RES; v++) {
          const a = base + u * side + v, b = a + 1, c = a + side, d = c + 1;
          indices.push(a, d, c, a, b, d);
        }
      }
      if (!positions.length) { fill.visible = false; return; }
      replaceGeometry(positions, indices);
      return;
    }

    const source = vertices ?? preview.mesh.vertices, count = source.length / 3;
    const positions: number[] = [], indices: number[] = [];
    for (const quad of quads) {
      if (quad.length !== 4 || quad.some(id => id < 0 || id >= count)) continue;
      const base = positions.length / 3;
      for (const id of quad) positions.push(source[id * 3], source[id * 3 + 1], source[id * 3 + 2]);
      indices.push(base, base + 3, base + 2, base, base + 1, base + 3);
    }
    if (!positions.length) { fill.visible = false; return; }
    replaceGeometry(positions, indices);
  }

  return {
    setPreview,
    rebuild,
    hide() { fill.visible = false; },
  };
}

export type LoftPreviewLayer = ReturnType<typeof createLoftPreviewLayer>;
