import type { QuadMeshDoc, V3 } from '../doc/types';
import { nameIndex } from '../doc/ids';
import { add, mul, sub } from '../math/vec';
import { edgeIsLocked } from './locks';
import { readVertex } from './primitives';

/** Smooth along each ordered guide, including at U/V crossings where mesh adjacency has no unique opposite.
 * Shared knot-parameter derivatives make both sides of an internal point agree, even with unequal spans. */
export function smoothSurfaceGuideVertices(doc: QuadMeshDoc, vertices: readonly number[], lockedEdges: Set<string>) {
  if (!vertices.length || !doc.surfaces?.some(surface => surface.guides)) return;
  const selected = new Set(vertices.map(i => doc.vertexIds[i])),
    ids = nameIndex(doc.vertexIds);
  for (const surface of doc.surfaces ?? []) {
    if (!surface.guides) continue;
    surface.controls.forEach((path, curve) => {
      if (!path.some(id => selected.has(id))) return;
      const knots = surface.guides![curve]?.knots,
        indices = path.map(id => ids.get(id));
      if (
        !knots ||
        knots.length !== path.length ||
        path.length < 2 ||
        indices.some(i => i === undefined) ||
        knots.some((t, i) => !Number.isFinite(t) || (i > 0 && t <= knots[i - 1]))
      )
        return;
      const positions = indices.map(i => readVertex(doc.vertices, i!));
      path.forEach((id, i) => {
        if (!selected.has(id)) return;
        const before = Math.max(0, i - 1),
          after = Math.min(path.length - 1, i + 1),
          left = knots[i] - knots[before],
          right = knots[after] - knots[i];
        let tangent: V3;
        if (before === i) tangent = mul(sub(positions[after], positions[i]), 1 / right);
        else if (after === i) tangent = mul(sub(positions[i], positions[before]), 1 / left);
        else
          tangent = mul(
            add(
              mul(sub(positions[i], positions[before]), right / left),
              mul(sub(positions[after], positions[i]), left / right),
            ),
            1 / (left + right),
          );
        for (const neighbor of [i - 1, i + 1]) {
          if (
            neighbor < 0 ||
            neighbor >= path.length ||
            edgeIsLocked(doc, indices[i]!, indices[neighbor]!, lockedEdges)
          )
            continue;
          (doc.edgeHandles ??= {})[`${indices[i]}>${indices[neighbor]}`] = mul(
            tangent,
            (knots[neighbor] - knots[i]) / 3,
          );
        }
      });
    });
  }
}
