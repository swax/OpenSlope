import type { QuadMeshDoc } from '../doc/types';
import { nameIndex } from '../doc/ids';
import { quadPerimeterEdges, undirectedEdgeKey } from './primitives';

/** Source curves deliberately coincide with their loft. Other geometry still receives diagnostics. */
export function loftControlContact(doc: QuadMeshDoc): (a: number, b: number) => boolean {
  const sources = new Map<string, Set<number>>(),
    outputs = new Map<string, Set<number>>();
  (doc.lofts ?? []).forEach((loft, i) => {
    for (const id of loft.profiles.flat()) {
      const groups = sources.get(id) ?? new Set<number>();
      groups.add(i);
      sources.set(id, groups);
    }
    for (const id of loft.vertices) {
      const groups = outputs.get(id) ?? new Set<number>();
      groups.add(i);
      outputs.set(id, groups);
    }
  });
  (doc.surfaces ?? []).forEach((surface, at) => {
    const i = at + (doc.lofts?.length ?? 0);
    const source = [...surface.controls.flat(), ...surface.inputs];
    for (const id of source) {
      const groups = sources.get(id) ?? new Set<number>();
      groups.add(i);
      sources.set(id, groups);
    }
    // Contacts within the construction cage, its seed sketches and evaluated terrain are intentional.
    for (const id of [...source, ...surface.vertices, ...surface.patches.flatMap(p => p.corners)]) {
      const groups = outputs.get(id) ?? new Set<number>();
      groups.add(i);
      outputs.set(id, groups);
    }
  });
  // Connected construction cages can coincide along a live seam. This exemption contains source controls
  // and sketches only; intersections between the two evaluated terrain sheets still receive diagnostics.
  let group = (doc.lofts?.length ?? 0) + (doc.surfaces?.length ?? 0);
  const generated = new Set(doc.surfaces?.flatMap(s => s.patches.map(p => p.quad))),
    indices = nameIndex(doc.vertexIds);
  for (const surface of doc.surfaces ?? [])
    for (const stitch of surface.stitches ?? []) {
      if ('vertices' in stitch.target) {
        const chain = stitch.target.vertices.map(id => indices.get(id)),
          edges = new Set(
            chain
              .slice(1)
              .flatMap((v, i) => (v === undefined || chain[i] === undefined ? [] : [undirectedEdgeKey(chain[i]!, v)])),
          ),
          hosts = new Set<string>();
        doc.quads.forEach((q, i) => {
          if (generated.has(doc.quadIds[i])) return;
          if (quadPerimeterEdges(q).some(([a, b]) => edges.has(undirectedEdgeKey(a, b))))
            q.forEach(v => hosts.add(doc.vertexIds[v]));
        });
        // A source cubic can pass close to a transverse edge of the terrain it is attached to.
        // It is an editable construction guide, not an additional sheet crossing that host patch.
        for (const id of [...surface.controls.flat(), ...surface.inputs]) {
          const groups = sources.get(id) ?? new Set<number>();
          groups.add(group);
          sources.set(id, groups);
        }
        for (const id of hosts) {
          const groups = outputs.get(id) ?? new Set<number>();
          groups.add(group);
          outputs.set(id, groups);
        }
        group++;
        continue;
      }
      const targetId = stitch.target.surface;
      const target = doc.surfaces?.find(s => s.id === targetId);
      if (!target) continue;
      for (const id of [...surface.controls.flat(), ...surface.inputs, ...target.controls.flat(), ...target.inputs]) {
        const src = sources.get(id) ?? new Set<number>(),
          out = outputs.get(id) ?? new Set<number>();
        src.add(group);
        out.add(group);
        sources.set(id, src);
        outputs.set(id, out);
      }
      group++;
    }
  const pair = (a: string, b: string) => [...(sources.get(a) ?? [])].some(group => outputs.get(b)?.has(group));
  return (a, b) => pair(doc.vertexIds[a], doc.vertexIds[b]) || pair(doc.vertexIds[b], doc.vertexIds[a]);
}
