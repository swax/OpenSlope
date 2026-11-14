import type { QuadMeshDoc, V3 } from '../../doc/types';
import { appendMeshIds } from '../../doc/ids';
import { add, cross, dot, len, mul, norm, sub } from '../../math/vec';
import { quadPerimeterEdges, readVertex } from '../primitives';
import { checkManifold } from './contract';
import { DEFAULT_GRID_PATCH_SIZE_M, gridDivisionsForSize, MAX_GRID_DIVISIONS } from './grid';

export const DEFAULT_BOX_HEIGHT_M = 30;
export type BoxAxis = 'length' | 'width' | 'height';
/** Three perpendicular edge vectors from the same base corner. Snaps position a new, disconnected box. */
export type BoxDraft = { origin: V3 } & Record<BoxAxis, V3>;
/** One fixed coordinate selects a face; two select an edge. Zero is the near boundary, one the far boundary. */
export type BoxBounds = Partial<Record<BoxAxis, 0 | 1>>;
export type BoxPlan = {
  points: V3[];
  quads: [number, number, number, number][];
  dimensions: Record<BoxAxis, number>;
  divisions: Record<BoxAxis, number>;
};
export type BoxPlanResult = { ok: true; plan: BoxPlan } | { ok: false; error: string };

/** Draw the rectangular base as for Grid; height starts perpendicular to it, toward world-up where possible. */
export function boxFromClicks(first: V3, second: V3, third: V3, height = DEFAULT_BOX_HEIGHT_M): BoxDraft {
  const length = sub(second, first),
    along = norm(length),
    reach = sub(third, second),
    width = sub(reach, mul(along, dot(reach, along)));
  let up = norm(cross(width, length));
  if (up[1] < 0) up = mul(up, -1);
  return { origin: [...first], length, width, height: mul(up, height) };
}

export function resizeBox(draft: BoxDraft, axis: BoxAxis, size: number): BoxDraft {
  return Number.isFinite(size) && size > 0 ? { ...draft, [axis]: mul(norm(draft[axis]), size) } : draft;
}

/** Move chosen boundaries along their own axes while keeping opposite boundaries fixed and the box rectangular. */
export function moveBoxBounds(draft: BoxDraft, bounds: BoxBounds, delta: V3): BoxDraft {
  const next: BoxDraft = { ...draft, origin: [...draft.origin] };
  for (const axis of ['length', 'width', 'height'] as BoxAxis[]) {
    const side = bounds[axis];
    if (side === undefined) continue;
    const size = len(draft[axis]),
      direction = norm(draft[axis]);
    const distance = dot(delta, direction);
    const changed = Math.max(0.5, size + (side === 1 ? distance : -distance));
    next[axis] = mul(direction, changed);
    if (side === 0) next.origin = add(next.origin, mul(direction, size - changed));
  }
  return next;
}

/** Six outward-facing patch grids. Integer lattice coordinates weld every rim and corner across faces. */
export function planBox(
  draft: BoxDraft,
  options: { patchSize?: number | null; divisions: Record<BoxAxis, number> } = {
    patchSize: DEFAULT_GRID_PATCH_SIZE_M,
    divisions: { length: 4, width: 4, height: 4 },
  },
): BoxPlanResult {
  const axes: BoxAxis[] = ['length', 'width', 'height'];
  if (![...draft.origin, ...axes.flatMap(axis => draft[axis])].every(Number.isFinite))
    return { ok: false, error: 'Box corners and dimensions must be finite numbers.' };
  const dimensions = { length: len(draft.length), width: len(draft.width), height: len(draft.height) };
  if (axes.some(axis => !Number.isFinite(dimensions[axis])))
    return { ok: false, error: 'Box dimensions must be finite numbers.' };
  if (axes.some(axis => dimensions[axis] < 1e-3))
    return { ok: false, error: 'Give the box a length, width and height greater than zero.' };
  if (
    axes.some((axis, i) => axes.slice(i + 1).some(other => Math.abs(dot(norm(draft[axis]), norm(draft[other]))) > 1e-6))
  )
    return { ok: false, error: 'The three box axes must be perpendicular.' };
  const size = options.patchSize;
  if (size != null && !(Number.isFinite(size) && size > 0))
    return { ok: false, error: 'The patch size must be greater than zero.' };
  const divisions = { ...options.divisions };
  for (const axis of axes) {
    if (size != null) divisions[axis] = gridDivisionsForSize(dimensions[axis], size);
    if (!Number.isInteger(divisions[axis]) || divisions[axis] < 1 || divisions[axis] > MAX_GRID_DIVISIONS)
      return { ok: false, error: `Box divisions must be whole numbers from 1 to ${MAX_GRID_DIVISIONS}.` };
  }
  const { length: l, width: w, height: h } = divisions;
  if (2 * (l * w + l * h + w * h) > 50_000)
    return {
      ok: false,
      error: 'That would create more than 50,000 box patches. Increase patch size or reduce divisions.',
    };
  const points: V3[] = [],
    quads: BoxPlan['quads'] = [],
    ids = new Map<string, number>();
  const vertex = (coords: Record<BoxAxis, number>) => {
    const key = axes.map(axis => coords[axis]).join(':');
    const known = ids.get(key);
    if (known !== undefined) return known;
    const id = points.length;
    let pos = draft.origin;
    for (const axis of axes) pos = add(pos, mul(draft[axis], coords[axis] / divisions[axis]));
    points.push(pos);
    ids.set(key, id);
    return id;
  };
  for (const fixed of axes) {
    const [u, v] = axes.filter(axis => axis !== fixed);
    for (const far of [false, true]) {
      const outward = mul(draft[fixed], far ? 1 : -1);
      const flip = dot(cross(draft[u], draft[v]), outward) < 0;
      const at = (i: number, j: number) =>
        vertex({ length: 0, width: 0, height: 0, [fixed]: far ? divisions[fixed] : 0, [u]: i, [v]: j });
      for (let j = 0; j < divisions[v]; j++)
        for (let i = 0; i < divisions[u]; i++) {
          const a = at(i, j),
            b = at(i + 1, j),
            c = at(i, j + 1),
            d = at(i + 1, j + 1);
          quads.push(flip ? [b, a, d, c] : [a, b, c, d]);
        }
    }
  }
  return { ok: true, plan: { points, quads, dimensions, divisions } };
}

/** Append fresh geometry and linear tangents so the box keeps flat faces and sharp corners after committing. */
export function appendBox(doc: QuadMeshDoc, plan: BoxPlan) {
  const start = doc.vertices.length / 3,
    firstQuad = doc.quads.length,
    vertices = [...doc.vertices, ...plan.points.flat()],
    created = plan.quads.map(quad => quad.map(id => start + id)),
    quads = [...doc.quads, ...created];
  const guard = checkManifold(quads);
  if (!guard.ok) return { ok: false as const, error: guard.error! };
  const edgeHandles = { ...doc.edgeHandles };
  for (const quad of created)
    for (const [a, b] of quadPerimeterEdges(quad)) {
      const handle = mul(sub(readVertex(vertices, b), readVertex(vertices, a)), 1 / 3);
      edgeHandles[`${a}>${b}`] = handle;
      edgeHandles[`${b}>${a}`] = mul(handle, -1);
    }
  return {
    ok: true as const,
    doc: { ...doc, vertices, quads, edgeHandles, ...appendMeshIds(doc, plan.points.length, created.length) },
    quads: created.map((_, i) => firstQuad + i),
  };
}
