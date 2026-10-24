import type { QuadMeshDoc } from '../doc/types';
import { nameIndex } from '../doc/ids';
import { patchDependency } from './incremental';
import { refreshSurfaces } from './surface-object';
import {
  buildMountainPreview,
  preparePreviewPatches,
  refreshPreviewPatches,
  type PreparedPatches,
  type PreviewData,
} from './tessellation';

export type MeshPreviewChange = {
  vertices?: readonly number[];
  edges?: readonly [number, number][];
  quads?: readonly number[];
};
export type SurfacePreviewInputs = Pick<QuadMeshDoc, 'vertices' | 'edgeHandles' | 'quadTwist'>;
export type SurfacePreviewGeometry = SurfacePreviewInputs & Pick<QuadMeshDoc, 'surfaces'>;
export type SurfacePreviewRequest = {
  epoch: number;
  initial?: QuadMeshDoc;
  inputs: SurfacePreviewInputs;
  change: MeshPreviewChange;
};
export type SurfacePreviewResponse = { epoch: number } & (
  | { kind: 'ready'; geometry: SurfacePreviewGeometry; changed: string[]; patches: PreparedPatches }
  | { kind: 'fallback'; error?: string }
);

/** One worker retains the fitted source objects, adjacency and raw seam normals between samples. */
export function createSurfacePreviewEvaluator() {
  let doc: QuadMeshDoc | undefined, preview: PreviewData | undefined;
  return (request: SurfacePreviewRequest): SurfacePreviewResponse => {
    if (request.initial) {
      doc = request.initial;
      preview = buildMountainPreview(doc);
    }
    if (!doc || !preview) return { epoch: request.epoch, kind: 'fallback' };
    const before = { ...doc, ...request.inputs },
      next = refreshSurfaces(before, { interactive: true });
    if (next.quads !== before.quads || next.vertexIds !== before.vertexIds)
      return { epoch: request.epoch, kind: 'fallback' };
    const changed = (next.surfaces ?? []).filter(s => !before.surfaces?.includes(s)),
      vertices = nameIndex(next.vertexIds),
      quads = nameIndex(next.quadIds),
      dirty = patchDependency(preview.mesh, preview.adjacency).of({
        ...request.change,
        vertices: [
          ...(request.change.vertices ?? []),
          ...changed.flatMap(s => s.vertices.map(id => vertices.get(id)!)),
        ],
      });
    changed.forEach(s => s.patches.forEach(p => dirty.add(quads.get(p.quad)!)));
    refreshPreviewPatches(next, preview, dirty, dirty);
    doc = next;
    return {
      epoch: request.epoch,
      kind: 'ready',
      changed: changed.map(s => s.id),
      geometry: {
        vertices: next.vertices,
        edgeHandles: next.edgeHandles,
        quadTwist: next.quadTwist,
        surfaces: next.surfaces,
      },
      patches: preparePreviewPatches(preview, dirty),
    };
  };
}

const same = (a: unknown, b: unknown): boolean =>
  a === b || (Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((n, i) => same(n, b[i])));

function overlayMap<T>(
  base: Record<string, T> | undefined,
  live: Record<string, T> | undefined,
  evaluated: Record<string, T> | undefined,
) {
  const out = { ...evaluated };
  for (const key of new Set([...Object.keys(base ?? {}), ...Object.keys(live ?? {})])) {
    if (same(base?.[key], live?.[key])) continue;
    if (live?.[key] === undefined) delete out[key];
    else out[key] = live[key];
  }
  return Object.keys(out).length ? out : undefined;
}

/** A completed sample can be displayed even while the hand has moved on. Carry its generated geometry,
 * but overlay authoring writes made since dispatch so an older sample never pulls the controls backward. */
export function mergeSurfacePreview(
  live: QuadMeshDoc,
  baseline: SurfacePreviewInputs,
  result: SurfacePreviewGeometry,
  changed: readonly string[],
): QuadMeshDoc {
  const vertices = result.vertices.slice();
  for (let i = 0; i < vertices.length; i++)
    if (live.vertices[i] !== baseline.vertices[i]) vertices[i] = live.vertices[i];
  return {
    ...live,
    vertices,
    edgeHandles: overlayMap(baseline.edgeHandles, live.edgeHandles, result.edgeHandles),
    quadTwist: overlayMap(baseline.quadTwist, live.quadTwist, result.quadTwist),
    surfaces: result.surfaces?.map(s =>
      changed.includes(s.id) ? s : (live.surfaces?.find(previous => previous.id === s.id) ?? s),
    ),
  };
}
