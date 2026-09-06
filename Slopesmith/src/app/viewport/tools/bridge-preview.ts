import * as THREE from 'three';
import type { V3 } from '../../../core/doc/types';
import { meshEdgeSegments } from '../../../core/mesh/selection';
import type { EdgeHandle } from '../../../core/mesh/topology';
import type { PreviewData } from '../../../core/mesh/tessellation';
import { BRIDGE_RAIL_COLORS, EDIT_EDGE_SEL_WIDTH, LOOP_RENDER_ORDER } from '../constants';
import { clearGlyphGroup, glyphLines } from '../shared/overlays';
import type { Stage } from '../stage';

export type BridgePreviewDeps = {
  preview: () => PreviewData | null;
  edgeHandle: () => EdgeHandle | null;
};

/** Stable-color, directed rail overlays for Bridge Builder. */
export function createBridgePreviewLayer(stage: Stage, deps: BridgePreviewDeps) {
  let rails: readonly (readonly number[])[] = [];
  let active = false;
  const group = new THREE.Group();
  stage.worldRoot.add(group);

  function addLines(values: number[] | Float32Array, color: number, renderOrder: number) {
    glyphLines(group, values, color, 1,
      [stage.container.clientWidth || 1, stage.container.clientHeight || 1],
      EDIT_EDGE_SEL_WIDTH + 0.5, renderOrder, false);
  }

  function rebuild() {
    clearGlyphGroup(group);
    const preview = deps.preview(), edgeHandle = deps.edgeHandle();
    if (!preview || !edgeHandle || !rails.length) return;
    const vertex = (id: number): V3 => [
      preview.mesh.vertices[id * 3], preview.mesh.vertices[id * 3 + 1], preview.mesh.vertices[id * 3 + 2],
    ];
    rails.forEach((rail, index) => {
      if (rail.length < 2 || rail.some(id => id < 0 || id >= preview.mesh.vertexCount)) return;
      const edges: [number, number][] = [];
      for (let i = 0; i < rail.length - 1; i++) edges.push([rail[i], rail[i + 1]]);
      const color = BRIDGE_RAIL_COLORS[index % BRIDGE_RAIL_COLORS.length];
      addLines(meshEdgeSegments(preview.mesh, edgeHandle, edges), color, LOOP_RENDER_ORDER + 2);

      const tip = vertex(rail[rail.length - 1]), previous = vertex(rail[rail.length - 2]);
      let dx = tip[0] - previous[0], dy = tip[1] - previous[1], dz = tip[2] - previous[2];
      const distance = Math.hypot(dx, dy, dz);
      if (distance < 1e-6) return;
      dx /= distance; dy /= distance; dz /= distance;
      const size = Math.min(6, Math.max(1.5, distance * 0.22));
      let sx = -dz, sy = 0, sz = dx, sideLength = Math.hypot(sx, sy, sz);
      if (sideLength < 1e-6) { sx = 1; sy = 0; sz = 0; sideLength = 1; }
      sx = sx / sideLength * size * 0.45; sy = sy / sideLength * size * 0.45; sz = sz / sideLength * size * 0.45;
      const bx = tip[0] - dx * size, by = tip[1] - dy * size, bz = tip[2] - dz * size;
      addLines([
        ...tip, bx + sx, by + sy, bz + sz,
        ...tip, bx - sx, by - sy, bz - sz,
      ], color, LOOP_RENDER_ORDER + 3);
    });
  }

  function setRails(next: readonly (readonly number[])[] | null) {
    active = next !== null;
    rails = next ?? [];
    rebuild();
  }

  return { setRails, rebuild, get active() { return active; } };
}

export type BridgePreviewLayer = ReturnType<typeof createBridgePreviewLayer>;
