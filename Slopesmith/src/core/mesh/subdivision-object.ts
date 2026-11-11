import type { QuadMeshDoc, SurfaceObject, V3 } from '../doc/types';
import { appendMeshIds, nameIndex } from '../doc/ids';
import { subdivisionPatches, validateSubdivisionMesh, type SubdivisionMesh } from '../math/subdivision';
import { finishMeshRewrite } from './ops/contract';
import { readVertex } from './primitives';
import { meshFromDoc, quadControlPoints } from './topology';
import { writeCages } from './loft-surface';
import { assertSubdivisionTopology, subdivisionEdges, SUBDIVISION_BAKE_REASON } from './subdivision-topology';

const key = (a: string, b: string) => [a, b].sort().join('>');

export function subdivisionSource(doc: QuadMeshDoc, surface: SurfaceObject): SubdivisionMesh {
  const ids = nameIndex(doc.vertexIds),
    controls = surface.controls.flat(),
    local = nameIndex(controls);
  return {
    points: controls.map(id => {
      const at = ids.get(id);
      if (at === undefined) throw new Error('A cage point was removed. Undo that edit or bake the cage.');
      return readVertex(doc.vertices, at);
    }),
    faces: surface.subdivision!.faces.map(f => f.map(id => local.get(id) ?? -1)),
    creases: surface.subdivision!.creases.map(([a, b]) => [local.get(a) ?? -1, local.get(b) ?? -1]),
    corners: surface.subdivision!.corners?.map(id => local.get(id) ?? -1),
  };
}

export function rebuildSubdivision(doc: QuadMeshDoc, surface: SurfaceObject) {
  const source = subdivisionSource(doc, surface);
  assertSubdivisionTopology({ ...doc, surfaces: [...(doc.surfaces ?? []).filter(s => s.id !== surface.id), surface] });
  const generated = subdivisionPatches(source, surface.subdivision!.level);
  const qIndex = nameIndex(doc.quadIds),
    vIndex = nameIndex(doc.vertexIds);
  const ownQuads = new Set(surface.patches.map(p => p.quad)),
    owned = new Set(surface.vertices);
  for (const p of surface.patches) {
    const q = qIndex.get(p.quad);
    if (q === undefined || doc.quads[q].some((v, i) => doc.vertexIds[v] !== p.corners[i]))
      throw new Error('Generated cage terrain changed. Undo the edit or bake the cage.');
  }
  if (
    doc.quads.some((q, i) => !ownQuads.has(doc.quadIds[i]) && q.some(v => owned.has(doc.vertexIds[v]))) ||
    doc.freeEdges?.some(e => e.some(v => owned.has(doc.vertexIds[v])))
  )
    throw new Error(SUBDIVISION_BAKE_REASON);
  const sameLayout =
    surface.vertices.length === generated.points.length &&
    surface.patches.length === generated.faces.length &&
    surface.patches.every((p, i) => p.key === generated.keys[i]);
  let out: QuadMeshDoc, vertices: number[], cells: number[];
  if (sameLayout) {
    out = {
      ...doc,
      vertices: doc.vertices.slice(),
      edgeHandles: { ...doc.edgeHandles },
      quadTwist: { ...doc.quadTwist },
      quadLocked: { ...doc.quadLocked },
    };
    vertices = surface.vertices.map(id => vIndex.get(id)!);
    cells = surface.patches.map(p => qIndex.get(p.quad)!);
  } else {
    const kept = finishMeshRewrite(doc, {
      ...doc,
      quads: doc.quads.map((q, i) => (ownQuads.has(doc.quadIds[i]) ? null : q)),
      keepVertices: doc.vertexIds.flatMap((id, i) => (owned.has(id) ? [] : [i])),
    }).doc;
    const start = kept.vertexIds.length,
      first = kept.quadIds.length;
    vertices = generated.points.map((_, i) => start + i);
    cells = generated.faces.map((_, i) => first + i);
    out = {
      ...kept,
      ...appendMeshIds(kept, generated.points.length, generated.faces.length),
      vertices: [...kept.vertices, ...generated.points.flat()],
      quads: [...kept.quads, ...generated.faces.map(f => f.map(v => vertices[v]))],
      edgeHandles: { ...kept.edgeHandles },
      quadTwist: { ...kept.quadTwist },
      quadLocked: { ...kept.quadLocked },
    };
    generated.keys.forEach((k, i) => {
      const old = surface.patches.find(p => p.key === k || k.startsWith(p.key + '/') || p.key?.startsWith(k + '/'));
      const at = old && qIndex.get(old.quad);
      if (at === undefined) return;
      if (doc.quadPaint?.[at] !== undefined) (out.quadPaint ??= {})[cells[i]] = doc.quadPaint[at];
      if (doc.quadTex?.[at] !== undefined) (out.quadTex ??= {})[cells[i]] = doc.quadTex[at];
      if (doc.quadOrient?.[at] !== undefined) (out.quadOrient ??= {})[cells[i]] = structuredClone(doc.quadOrient[at]);
      if (doc.quadLabels?.[at] !== undefined) (out.quadLabels ??= {})[cells[i]] = [...doc.quadLabels[at]];
    });
  }
  generated.points.forEach((p, i) => out.vertices.splice(vertices[i] * 3, 3, ...p));
  const patches = generated.controls.map(controls => ({
    domain: [0, 1, 0, 1] as [number, number, number, number],
    controls,
  }));
  writeCages(out, patches, cells);
  cells.forEach(q => {
    out.quadLocked![q] = true;
  });
  const next: SurfaceObject = {
    ...surface,
    vertices: vertices.map(v => out.vertexIds[v]),
    patches: patches.map((p, i) => ({
      quad: out.quadIds[cells[i]],
      corners: out.quads[cells[i]].map(v => out.vertexIds[v]),
      domain: p.domain,
      base: p.controls,
      key: generated.keys[i],
    })),
    evaluated: {
      points: [source.points],
      patchSizeM: surface.patchSizeM,
      subdivision: JSON.stringify(surface.subdivision),
    },
  };
  delete next.error;
  out.surfaces = doc.surfaces?.some(s => s.id === next.id)
    ? out.surfaces!.map(s => (s.id === next.id ? next : s))
    : [...(out.surfaces ?? []), next];
  // Straight cage links have no independent Bézier handles.
  const index = nameIndex(out.vertexIds);
  for (const [a, b] of subdivisionEdges(next)) {
    const A = index.get(a)!,
      B = index.get(b)!,
      p = readVertex(out.vertices, A),
      q = readVertex(out.vertices, B);
    out.edgeHandles![`${A}>${B}`] = p.map((v, d) => (q[d] - v) / 3) as V3;
    out.edgeHandles![`${B}>${A}`] = p.map((v, d) => (v - q[d]) / 3) as V3;
  }
  return { doc: out, surface: next };
}

export function createSubdivisionCage(doc: QuadMeshDoc, selection: readonly number[], level = 1) {
  const cells = [...new Set(selection)];
  if (!cells.length || cells.some(q => !doc.quads[q] || doc.quadLocked?.[q]))
    throw new Error('Select unlocked quad faces to create a subdivision cage.');
  const original = [...new Set(cells.flatMap(q => doc.quads[q]))],
    local = new Map(original.map((v, i) => [v, i]));
  const points = original.map(v => readVertex(doc.vertices, v));
  const faces = cells.map(q => {
    const [a, b, c, d] = doc.quads[q];
    return [a, b, d, c].map(v => local.get(v)!);
  });
  validateSubdivisionMesh({ points, faces, creases: [] });
  const start = doc.vertexIds.length,
    out: QuadMeshDoc = {
      ...doc,
      ...appendMeshIds(doc, points.length, 0),
      vertices: [...doc.vertices, ...points.flat()],
      freeEdges: [...(doc.freeEdges ?? [])],
    };
  const names = points.map((_, i) => out.vertexIds[start + i]);
  let n = 1;
  while (doc.surfaces?.some(s => s.id === `surface:${n}`)) n++;
  const { mesh, edgeHandle } = meshFromDoc(doc);
  const surface: SurfaceObject = {
    id: `surface:${n}`,
    name: `Subdivision cage ${n}`,
    origin: 'legacy',
    controls: [names],
    subdivision: { faces: faces.map(f => f.map(v => names[v])), creases: [], level },
    knotsU: [],
    knotsV: [],
    patchSizeM: 15,
    inputs: original.map(v => doc.vertexIds[v]),
    vertices: [],
    patches: cells.map((q, i) => ({
      quad: doc.quadIds[q],
      corners: doc.quads[q].map(v => doc.vertexIds[v]),
      domain: [0, 1, 0, 1],
      base: quadControlPoints(mesh, edgeHandle, q, doc.quadTwist?.[q]),
      key: `${i}`,
    })),
    evaluated: { points: [points], patchSizeM: 15 },
  };
  const ids = nameIndex(out.vertexIds);
  out.freeEdges!.push(...subdivisionEdges(surface).map(([a, b]) => [ids.get(a)!, ids.get(b)!] as [number, number]));
  return rebuildSubdivision(out, surface);
}

/** Edge selection marks creases; point selection marks independently pinned corners. */
export function creaseSubdivisionSelection(
  doc: QuadMeshDoc,
  selected: readonly string[],
  edges: readonly (readonly string[])[],
  sharp: boolean,
): QuadMeshDoc | null {
  const vertices = new Set(selected),
    selectedEdges = new Set(edges.map(([a, b]) => key(a, b)));
  let changed = false;
  const surfaces = doc.surfaces?.map(s => {
    if (!s.subdivision) return s;
    if (!selectedEdges.size) {
      const targets = s.controls.flat().filter(id => vertices.has(id));
      if (!targets.length) return s;
      const corners = new Set(s.subdivision.corners);
      for (const id of targets) {
        if (sharp) corners.add(id);
        else corners.delete(id);
      }
      const subdivision = { ...s.subdivision };
      if (corners.size) subdivision.corners = [...corners];
      else delete subdivision.corners;
      changed = true;
      return { ...s, subdivision };
    }
    const targets = subdivisionEdges(s).filter(([a, b]) => selectedEdges.has(key(a, b)));
    if (!targets.length) return s;
    changed = true;
    const creases = new Map(s.subdivision.creases.map(e => [key(...e), e]));
    for (const edge of targets) {
      if (sharp) creases.set(key(...edge), edge);
      else creases.delete(key(...edge));
    }
    return { ...s, subdivision: { ...s.subdivision, creases: [...creases.values()] } };
  });
  return changed ? { ...doc, surfaces } : null;
}
