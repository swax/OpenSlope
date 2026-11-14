import type { QuadMeshDoc, V3 } from '../doc/types';
import { nameIndex } from '../doc/ids';
import { writeVertex } from './primitives';
import { rebuildSubdivision, subdivisionSource } from './subdivision-object';

export type BendAxis = 0 | 1 | 2;
export type BendSettings = {
  axis: BendAxis;
  direction: BendAxis;
  angle: number;
  anchor: 'start' | 'centre' | 'end';
};

function bounds(points: readonly V3[]) {
  if (!points.length || points.some(p => p.some(n => !Number.isFinite(n))))
    throw new Error('Bend needs finite cage points.');
  const min: V3 = [Infinity, Infinity, Infinity],
    max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const point of points)
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], point[axis]);
      max[axis] = Math.max(max[axis], point[axis]);
    }
  return { min, max, spans: max.map((value, axis) => value - min[axis]) };
}

export function defaultBendSettings(points: readonly V3[]): BendSettings {
  const { spans } = bounds(points);
  const axis = spans.indexOf(Math.max(...spans)) as BendAxis;
  return { axis, direction: axis === 1 ? 0 : 1, angle: 0, anchor: 'start' };
}

/** Circular bend from a frozen source. Cross-sections rotate with the arc; its neutral line keeps its length. */
export function bendPoints(points: readonly V3[], settings: BendSettings) {
  const { axis, direction, angle, anchor } = settings;
  if (![0, 1, 2].includes(axis) || ![0, 1, 2].includes(direction) || axis === direction)
    throw new Error('Choose different length and bend-direction axes.');
  if (!Number.isFinite(angle) || Math.abs(angle) > 180) throw new Error('Choose a bend angle between −180° and 180°.');
  if (!['start', 'centre', 'end'].includes(anchor)) throw new Error('Choose a start, centre or end anchor.');
  const { min, max, spans } = bounds(points);
  const length = spans[axis];
  if (!(length > 1e-6 && Number.isFinite(length))) throw new Error('The cage needs length along the chosen axis.');
  const radians = (angle * Math.PI) / 180;
  const curvature = radians / length;
  const radiusM = angle === 0 ? null : 1 / Math.abs(curvature);
  if (radiusM !== null && spans[direction] * 0.5 >= radiusM * (1 - 1e-6))
    throw new Error('This bend is tighter than the box thickness. Reduce the angle or bend along a longer axis.');
  const stations = [...new Set(points.map(p => p[axis]))].sort((a, b) => a - b);
  if (stations.some((station, i) => i > 0 && Math.abs(curvature * (station - stations[i - 1])) > Math.PI / 2 + 1e-6))
    throw new Error(
      'The cage needs more divisions along its length for this angle. Create the box with more length divisions before making its SubD cage.',
    );
  const origin = min[axis] + length * (anchor === 'start' ? 0 : anchor === 'end' ? 1 : 0.5);
  const middle = (min[direction] + max[direction]) * 0.5;
  const bent = points.map((point): V3 => {
    if (angle === 0) return [...point];
    const s = point[axis] - origin,
      t = point[direction] - middle,
      theta = curvature * s;
    // sinc and (1−cos θ)/θ keep very small bends continuous with the straight cage.
    const sinc = Math.abs(theta) < 1e-4 ? 1 - (theta * theta) / 6 : Math.sin(theta) / theta;
    const cosc = theta === 0 ? 0 : (2 * Math.sin(theta * 0.5) ** 2) / theta;
    const out: V3 = [...point];
    out[axis] = origin + s * sinc - t * Math.sin(theta);
    out[direction] = middle + s * cosc + t * Math.cos(theta);
    return out;
  });
  return { points: bent, radiusM, length };
}

/** Bend only the source cage and regenerate its terrain, retaining topology, sharp marks and stable IDs. */
export function bendSubdivisionCage(doc: QuadMeshDoc, id: string, settings: BendSettings) {
  const surface = doc.surfaces?.find(s => s.id === id);
  if (!surface?.subdivision) throw new Error('Select a live subdivision cage to bend.');
  const source = subdivisionSource(doc, surface);
  const bent = bendPoints(source.points, settings);
  if (settings.angle === 0) return { doc, surface, radiusM: bent.radiusM, length: bent.length };
  const index = nameIndex(doc.vertexIds);
  const out = { ...doc, vertices: doc.vertices.slice() };
  surface.controls.flat().forEach((name, i) => writeVertex(out.vertices, index.get(name)!, bent.points[i]));
  return { ...rebuildSubdivision(out, surface), radiusM: bent.radiusM, length: bent.length };
}
