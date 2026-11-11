import type { QuadMeshDoc } from '../doc/types';
import { nameIndex } from '../doc/ids';
import { subdivisionEdges } from './subdivision-topology';
import { buildQuadMesh, meshAdjacency } from './topology';
import { resolveEdgeSelection, type Edge, type EdgeSelectMode, type MeshNaming } from './selection';

/** Cage wires have no incident terrain faces. Range and loop picks use their stored source faces instead,
 * so the ordinary edge-loop rules follow the cage without entering generated terrain or another object. */
export function subdivisionEdgeSelection(
  doc: QuadMeshDoc,
  current: readonly Edge<string>[],
  anchor: Edge<string> | null,
  edge: Edge<string>,
  mode: EdgeSelectMode,
) {
  if (mode === 'replace' || mode === 'toggle') return null;
  const surface = doc.surfaces?.find(s =>
    subdivisionEdges(s).some(([a, b]) => (a === edge[0] && b === edge[1]) || (a === edge[1] && b === edge[0])),
  );
  if (!surface?.subdivision) return null;
  const controls = surface.controls.flat(),
    local = nameIndex(controls),
    global = nameIndex(doc.vertexIds);
  const naming: MeshNaming<string> = {
    index: id => local.get(id) ?? null,
    name: index => controls[index] ?? null,
    canonical: (a, b) => (a < b ? [a, b] : [b, a]),
  };
  const mesh = buildQuadMesh(
    controls.flatMap(id => {
      const at = global.get(id)! * 3;
      return doc.vertices.slice(at, at + 3);
    }),
    // Subdivision faces are cyclic; the shared mesh queries use row-major [A, B, C, D] quads.
    surface.subdivision.faces.map(([a, b, c, d]) => [a, b, d, c].map(id => local.get(id)!)),
  );
  return resolveEdgeSelection(current, anchor, edge, mode, mesh, meshAdjacency(mesh), naming);
}
