import type { QuadMeshDoc } from '../doc/types';

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
  for (const surface of doc.surfaces ?? [])
    for (const stitch of surface.stitches ?? []) {
      if (!('surface' in stitch.target)) continue;
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
