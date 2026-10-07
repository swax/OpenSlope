import type { V3 } from '../doc/types';
import type { PropSub } from '../reference/props';
import type { ImportedPropRecord } from './imported';
import { MAX_IMPORT_TRIS } from './imported';

/** Cubic along one model-local axis, linear across the other two: four rings of four points.
 * All coordinates are raw model-local centimetres, just like the source mesh. */
export interface PropCage {
  axis: 0 | 1 | 2;
  min: V3;
  max: V3;
  points: V3[];
}

export interface PropDeformation {
  version: 1;
  cage: PropCage;
  slices: number;
  /** The undeformed mesh, retained once rather than nesting successive baked revisions. */
  source: ImportedPropRecord['subs'];
}

function unpack<T extends Float32Array | Uint32Array>(text: string,
  ArrayType: { new(buffer: ArrayBuffer): T }): T {
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  if (bytes.length % 4) throw new Error('The prop has an invalid geometry buffer.');
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new ArrayType(bytes.buffer);
}

function pack(data: Float32Array | Uint32Array): string {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function decodeDeformSource(subs: ImportedPropRecord['subs']): PropSub[] {
  let triangles = 0;
  if (!Array.isArray(subs) || !subs.length) throw new Error('This prop has no mesh.');
  return subs.map(sub => {
    const positions = unpack(sub.pos, Float32Array), uvs = unpack(sub.uv, Float32Array);
    const indices = unpack(sub.idx, Uint32Array);
    triangles += indices.length / 3;
    if (!positions.length || positions.length % 3 || indices.length % 3 || uvs.length !== positions.length / 3 * 2
      || !positions.every(Number.isFinite) || !uvs.every(Number.isFinite)
      || !indices.every(i => i < positions.length / 3) || triangles > MAX_IMPORT_TRIS)
      throw new Error('The prop geometry is invalid or exceeds the triangle limit.');
    return { mat: sub.mat, positions, uvs, indices };
  });
}

export function createPropCage(subs: readonly PropSub[], axis?: 0 | 1 | 2): PropCage {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const sub of subs) for (let i = 0; i < sub.positions.length; i++) {
    const a = i % 3;
    min[a] = Math.min(min[a], sub.positions[i]); max[a] = Math.max(max[a], sub.positions[i]);
  }
  const spans = max.map((n, i) => n - min[i]);
  if (!spans.every(Number.isFinite) || Math.max(...spans) < 1e-6) throw new Error('This prop has no usable extent.');
  const long = axis ?? spans.indexOf(Math.max(...spans)) as 0 | 1 | 2;
  // A flat source is still deformable; pad its rest box so binding never divides by zero.
  const pad = Math.max(...spans) * 0.005;
  for (let a = 0; a < 3; a++) if (spans[a] < pad) { min[a] -= pad / 2; max[a] += pad / 2; }
  const points: V3[] = [];
  for (let ring = 0; ring < 4; ring++) for (let j = 0; j < 2; j++) for (let k = 0; k < 2; k++) {
    const p: V3 = [...min];
    p[long] += (max[long] - min[long]) * ring / 3;
    p[(long + 1) % 3] += (max[(long + 1) % 3] - min[(long + 1) % 3]) * j;
    p[(long + 2) % 3] += (max[(long + 2) % 3] - min[(long + 2) % 3]) * k;
    points.push(p);
  }
  return { axis: long, min, max, points };
}

/** This fixed rest binding is reused for every preview, so dragging never deforms the last preview. */
export function cageWeights(cage: PropCage, point: ArrayLike<number>): number[] {
  const coords = [0, 1, 2].map(i => {
    const a = (cage.axis + i) % 3;
    return (point[a] - cage.min[a]) / (cage.max[a] - cage.min[a]);
  });
  const [u, v, w] = coords, q = 1 - u;
  const b = [q * q * q, 3 * u * q * q, 3 * u * u * q, u * u * u];
  return b.flatMap(weight => [weight * (1 - v) * (1 - w), weight * (1 - v) * w,
    weight * v * (1 - w), weight * v * w]);
}

export function deformPoint(cage: PropCage, weights: readonly number[]): V3 {
  const p: V3 = [0, 0, 0];
  cage.points.forEach((control, i) => { for (let a = 0; a < 3; a++) p[a] += control[a] * weights[i]; });
  return p;
}

/** Only the control positions and axis are supplied by the client. The rest bounds come from the source. */
export function validatePropCage(input: unknown, subs: readonly PropSub[]): PropCage {
  const value = input as Partial<PropCage> | null;
  if (!value || ![0, 1, 2].includes(value.axis as number) || !Array.isArray(value.points) || value.points.length !== 16)
    throw new Error('A deformation cage needs four sections of four points.');
  const cage = createPropCage(subs, value.axis);
  const limit = Math.max(...cage.max.map((n, a) => n - cage.min[a])) * 100;
  if (!value.points.every(p => Array.isArray(p) && p.length === 3
    && p.every((n, a) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n - cage.min[a]) <= limit)))
    throw new Error('The cage contains an invalid or excessive displacement.');
  cage.points = value.points.map(p => [...p]);
  return cage;
}

type ClipVertex = { p: V3; uv: [number, number]; seam: number[] };

/** Slice along the cubic axis before deforming. Shared cuts interpolate UVs within each material; no
 * texture seam is welded across different UVs. The source remains untouched. */
export function subdivideDeformSource(subs: readonly PropSub[], cage: PropCage, slices: number): PropSub[] {
  if (!Number.isInteger(slices) || slices < 1 || slices > 32) throw new Error('Choose between 1 and 32 cage slices.');
  const axis = cage.axis, lo = cage.min[axis], step = (cage.max[axis] - lo) / slices;
  let total = 0;
  function clip(poly: ClipVertex[], at: number, above: boolean): ClipVertex[] {
    const out: ClipVertex[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const insideA = above ? a.p[axis] >= at : a.p[axis] <= at;
      const insideB = above ? b.p[axis] >= at : b.p[axis] <= at;
      if (insideA) out.push(a);
      if (insideA !== insideB) {
        const t = (at - a.p[axis]) / (b.p[axis] - a.p[axis]);
        const p = a.p.map((n, j) => n + t * (b.p[j] - n)) as V3;
        p[axis] = at;
        out.push({ p, uv: [a.uv[0] + t * (b.uv[0] - a.uv[0]), a.uv[1] + t * (b.uv[1] - a.uv[1])],
          seam: t === 0 ? a.seam : t === 1 ? b.seam : [...new Set([...a.seam, ...b.seam])].sort((x, y) => x - y) });
      }
    }
    return out;
  }
  return subs.map(sub => {
    if (slices === 1) { total += sub.indices.length / 3; return sub; }
    const positions: number[] = [], uvs: number[] = [], indices: number[] = [], vertices = new Map<string, number>();
    function add(v: ClipVertex): number {
      // Coincident source vertices can deliberately mark a hard edge. Weld cuts only when their source
      // vertex/edge is shared, even if an unrelated face happens to have identical position and UV values.
      const key = `${v.seam.join('/')}:${[...v.p.map(n => n.toFixed(5)), ...v.uv.map(n => n.toFixed(7))].join(',')}`;
      const found = vertices.get(key);
      if (found !== undefined) return found;
      const id = positions.length / 3;
      vertices.set(key, id); positions.push(...v.p); uvs.push(...v.uv);
      return id;
    }
    for (let i = 0; i < sub.indices.length; i += 3) {
      const tri: ClipVertex[] = Array.from(sub.indices.subarray(i, i + 3), id => ({
        p: Array.from(sub.positions.subarray(id * 3, id * 3 + 3)) as V3,
        uv: [sub.uvs[id * 2], sub.uvs[id * 2 + 1]],
        seam: [id],
      }));
      const first = Math.max(0, Math.min(slices - 1, Math.floor((Math.min(...tri.map(v => v.p[axis])) - lo) / step)));
      const last = Math.max(first, Math.min(slices - 1, Math.ceil((Math.max(...tri.map(v => v.p[axis])) - lo) / step) - 1));
      for (let s = first; s <= last; s++) {
        const poly = clip(clip(tri, lo + s * step, true), lo + (s + 1) * step, false);
        for (let j = 1; j + 1 < poly.length; j++) {
          const ids = [add(poly[0]), add(poly[j]), add(poly[j + 1])];
          if (new Set(ids).size !== 3) continue;
          if (++total > MAX_IMPORT_TRIS) throw new Error('The bent prop would exceed 50,000 triangles. Use fewer slices.');
          indices.push(...ids);
        }
      }
    }
    return { mat: sub.mat, positions: new Float32Array(positions), uvs: new Float32Array(uvs), indices: new Uint32Array(indices) };
  });
}

export function bindDeformSource(subs: readonly PropSub[], cage: PropCage): number[][][] {
  return subs.map(sub => Array.from({ length: sub.positions.length / 3 }, (_, i) =>
    cageWeights(cage, sub.positions.subarray(i * 3, i * 3 + 3))));
}

export function deformSource(subs: readonly PropSub[], cage: PropCage, bindings = bindDeformSource(subs, cage)): PropSub[] {
  return subs.map((sub, s) => ({ ...sub,
    positions: new Float32Array(bindings[s].flatMap(weights => deformPoint(cage, weights))), normals: undefined,
  }));
}

/** A coarse Jacobian check rejects collapsed/inverted cells before saving; it is not a general
 * self-intersection solver. Evaluating the volume, rather than only mesh faces, also handles flat props. */
export function cageFolded(cage: PropCage): boolean {
  const a = cage.axis, b = (a + 1) % 3, c = (a + 2) % 3;
  const at = (u: number, v: number, w: number) => {
    const p: V3 = [...cage.min];
    [a, b, c].forEach((axis, i) => { p[axis] += [u, v, w][i] * (cage.max[axis] - cage.min[axis]); });
    return deformPoint(cage, cageWeights(cage, p));
  };
  const rest = (cage.max[a] - cage.min[a]) * (cage.max[b] - cage.min[b]) * (cage.max[c] - cage.min[c]);
  for (let i = 0; i <= 16; i++) for (const v of [0, 0.5, 1]) for (const w of [0, 0.5, 1]) {
    const u = i / 16, h = 0.0001, p = at(u, v, w);
    const d = [at(u + h, v, w), at(u, v + h, w), at(u, v, w + h)]
      .map(q => q.map((n, axis) => (n - p[axis]) / h));
    const det = d[0][0] * (d[1][1] * d[2][2] - d[1][2] * d[2][1])
      - d[0][1] * (d[1][0] * d[2][2] - d[1][2] * d[2][0])
      + d[0][2] * (d[1][0] * d[2][1] - d[1][1] * d[2][0]);
    if (det / rest < 0.0001) return true;
  }
  return false;
}

export function bakePropDeformation(record: ImportedPropRecord, input: unknown, slices: number): Omit<ImportedPropRecord, 'id'> {
  if (record.animation || record.emitters?.length) throw new Error('Cage deformation currently supports static props without emitters.');
  const source = record.deformation?.source ?? record.subs;
  const decoded = decodeDeformSource(source), cage = validatePropCage(input, decoded);
  if (cageFolded(cage)) throw new Error('The cage folds over or collapses. Move its controls apart before applying.');
  const baked = deformSource(subdivideDeformSource(decoded, cage, slices), cage);
  const { id: _id, ...copy } = record;
  return { ...copy, tris: baked.reduce((n, sub) => n + sub.indices.length / 3, 0),
    ...(copy.defaults?.nativeCollision && copy.defaults.nativeCollision.mode !== 0 ? {
      defaults: { ...copy.defaults, nativeCollision: { ...copy.defaults.nativeCollision, mode: 1 } },
    } : {}),
    subs: baked.map(sub => ({ mat: sub.mat, pos: pack(sub.positions), uv: pack(sub.uvs), idx: pack(sub.indices) })),
    deformation: { version: 1, cage, slices, source: structuredClone(source) },
  };
}
