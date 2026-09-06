import type { V3 } from '../../doc/types';
import { toRaw } from '../../export/level';
import type { RawPatch } from '../../reference/terrain';
import type { PolygonMesh } from './obj';

/** Patches.json record used by the diagnostic reference-map exporter. */
export interface RetopologyReferencePatch extends RawPatch {
  PatchName: string;
  TrickOnlyPatch: boolean;
}

const TILE_UV = [[0.008, -0.008], [0.992, -0.008], [0.008, -0.992], [0.992, -0.992]];

const addWeighted = (a: V3, b: V3, c: V3, d: V3, u: number, v: number): V3 => {
  const wa = (1 - u) * (1 - v), wb = (1 - u) * v, wc = u * (1 - v), wd = u * v;
  return [
    a[0] * wa + b[0] * wb + c[0] * wc + d[0] * wd,
    a[1] * wa + b[1] * wb + c[1] * wc + d[1] * wd,
    a[2] * wa + b[2] * wb + c[2] * wc + d[2] * wd,
  ];
};

/**
 * Degree-elevate one perimeter-ordered polygon [A,B,D,C] into SlopeSmith's row-major bicubic patch net.
 * A triangle is represented by collapsing D onto C; n-gons cannot be represented by one SSX patch.
 */
export function polygonPatchPoints(mesh: PolygonMesh, face: number[]): number[][] {
  if (face.length !== 3 && face.length !== 4) {
    throw new Error(`SSX reference patches require triangles or quads; received a ${face.length}-gon`);
  }
  const a = mesh.vertices[face[0]], b = mesh.vertices[face[1]];
  const d = mesh.vertices[face[2]], c = mesh.vertices[face[face.length === 4 ? 3 : 2]];
  if (!a || !b || !c || !d) throw new Error('Candidate face references a missing vertex');
  const points: number[][] = [];
  for (let row = 0; row < 4; row++) for (let column = 0; column < 4; column++) {
    points.push(toRaw(addWeighted(a, b, c, d, row / 3, column / 3)));
  }
  return points;
}

/** Preserve an original patch's exact geometry/paint while dropping stale lightmap atlas coordinates. */
export function protectedReferencePatch(source: RawPatch, name: string): RetopologyReferencePatch {
  return {
    PatchName: name,
    Points: source.Points.map(point => [...point]),
    SurfaceType: source.SurfaceType,
    ...(source.TexturePath ? { TexturePath: source.TexturePath } : {}),
    ...(source.UVPoints ? { UVPoints: source.UVPoints.map(point => [...point]) } : {}),
    TrickOnlyPatch: false,
  };
}

/** Convert candidate polygons without fitting or smoothing, so the reference view exposes the true result. */
export function candidateReferencePatches(
  mesh: PolygonMesh,
  candidateId: string,
  surfaceType = 1,
): RetopologyReferencePatch[] {
  return mesh.faces.map((face, index) => ({
    PatchName: `Retopo_${candidateId}_${index}`,
    Points: polygonPatchPoints(mesh, face),
    SurfaceType: surfaceType,
    TexturePath: 'snow.png',
    UVPoints: TILE_UV.map(point => [...point]),
    TrickOnlyPatch: false,
  }));
}
