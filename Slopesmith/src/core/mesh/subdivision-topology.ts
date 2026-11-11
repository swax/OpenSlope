import type { QuadMeshDoc, SurfaceObject } from '../doc/types';

export const SUBDIVISION_BAKE_REASON = 'Bake the subdivision cage before stitching or changing its topology.';
const key = (a: string, b: string) => [a, b].sort().join('>');

export function subdivisionEdges(surface: SurfaceObject): [string, string][] {
  const edges = new Map<string, [string, string]>();
  for (const face of surface.subdivision?.faces ?? [])
    face.forEach((a, i) => {
      const b = face[(i + 1) % 4];
      edges.set(key(a, b), [a, b]);
    });
  return [...edges.values()];
}

/** A live cage keeps its original wire topology and cannot acquire attached terrain or extra edges. */
export function assertSubdivisionTopology(doc: QuadMeshDoc) {
  if (!doc.surfaces?.some(s => s.subdivision)) return;
  const ids = new Set(doc.vertexIds);
  const wires = new Set((doc.freeEdges ?? []).map(([a, b]) => key(doc.vertexIds[a], doc.vertexIds[b])));
  for (const s of doc.surfaces ?? []) {
    if (!s.subdivision) continue;
    const controls = new Set(s.controls.flat()),
      edges = new Set(subdivisionEdges(s).map(([a, b]) => key(a, b)));
    if (
      s.stitches?.length ||
      doc.quads.some(q => q.some(v => controls.has(doc.vertexIds[v]))) ||
      [...controls].some(id => !ids.has(id)) ||
      [...edges].some(e => !wires.has(e)) ||
      (doc.freeEdges ?? []).some(
        ([a, b]) =>
          (controls.has(doc.vertexIds[a]) || controls.has(doc.vertexIds[b])) &&
          !edges.has(key(doc.vertexIds[a], doc.vertexIds[b])),
      )
    )
      throw new Error(SUBDIVISION_BAKE_REASON);
  }
}
