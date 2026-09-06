/** One point after the caller has projected it into a common 2-D view plane. */
export interface ProjectedPoint {
  id: number;
  x: number;
  y: number;
}

export type ProjectedTriangle = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];

/** One polygon after projection into the same 2-D plane as a triangle mask. */
export interface ProjectedPolygon {
  id: number;
  points: readonly (readonly [number, number])[];
}

const cross = (a: readonly [number, number], b: readonly [number, number], p: readonly [number, number]) =>
  (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);

const strictlyInTriangle = (point: readonly [number, number], triangle: ProjectedTriangle, epsilon: number): boolean => {
  const a = cross(triangle[0], triangle[1], point);
  const b = cross(triangle[1], triangle[2], point);
  const c = cross(triangle[2], triangle[0], point);
  return (a > epsilon && b > epsilon && c > epsilon) || (a < -epsilon && b < -epsilon && c < -epsilon);
};

const onSegment = (point: readonly [number, number], a: readonly [number, number],
  b: readonly [number, number], epsilon: number): boolean => Math.abs(cross(a, b, point)) <= epsilon
    && point[0] >= Math.min(a[0], b[0]) - epsilon && point[0] <= Math.max(a[0], b[0]) + epsilon
    && point[1] >= Math.min(a[1], b[1]) - epsilon && point[1] <= Math.max(a[1], b[1]) + epsilon;

export const pointStrictlyInProjectedPolygon = (point: readonly [number, number],
  polygon: readonly (readonly [number, number])[], epsilon = 1e-10): boolean => {
  let inside = false;
  for (let i = 0, previous = polygon.length - 1; i < polygon.length; previous = i++) {
    const a = polygon[previous], b = polygon[i];
    if (onSegment(point, a, b, epsilon)) return false;
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
};

export const projectedSegmentsProperlyCross = (a: readonly [number, number], b: readonly [number, number],
  c: readonly [number, number], d: readonly [number, number], epsilon = 1e-10): boolean => {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return ((abC > epsilon && abD < -epsilon) || (abC < -epsilon && abD > epsilon))
    && ((cdA > epsilon && cdB < -epsilon) || (cdA < -epsilon && cdB > epsilon));
};

function positiveAreaIntersection(polygon: readonly (readonly [number, number])[], triangle: ProjectedTriangle): boolean {
  const epsilon = 1e-10;
  if (polygon.some(point => strictlyInTriangle(point, triangle, epsilon))
    || triangle.some(point => pointStrictlyInProjectedPolygon(point, polygon, epsilon))) return true;
  const polygonCenter = polygon.reduce<[number, number]>((sum, point) =>
    [sum[0] + point[0] / polygon.length, sum[1] + point[1] / polygon.length], [0, 0]);
  const triangleCenter: [number, number] = [
    (triangle[0][0] + triangle[1][0] + triangle[2][0]) / 3,
    (triangle[0][1] + triangle[1][1] + triangle[2][1]) / 3,
  ];
  if (strictlyInTriangle(polygonCenter, triangle, epsilon)
    || pointStrictlyInProjectedPolygon(triangleCenter, polygon, epsilon)) return true;
  for (let p = 0; p < polygon.length; p++) for (let t = 0; t < 3; t++) {
    if (projectedSegmentsProperlyCross(polygon[p], polygon[(p + 1) % polygon.length],
      triangle[t], triangle[(t + 1) % 3], epsilon)) return true;
  }
  return false;
}

/** Select projected polygons that overlap a triangle mask by positive area. Merely touching the mask at a
 * point or along a shared boundary is deliberately excluded, which lets topology cutters remove crossing
 * faces without peeling off an additional ring of already-conforming neighbors. */
export function polygonsIntersectProjectedTriangles(
  inputPolygons: readonly ProjectedPolygon[],
  inputTriangles: readonly ProjectedTriangle[],
): number[] {
  const polygons = inputPolygons.filter(polygon => polygon.points.length >= 3
    && polygon.points.every(point => point.every(Number.isFinite)));
  const triangles = inputTriangles.filter(triangle => triangle.every(point => point.every(Number.isFinite))
    && Math.abs(cross(triangle[0], triangle[1], triangle[2])) > 1e-12);
  if (!polygons.length || !triangles.length) return [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const triangle of triangles) for (const [x, y] of triangle) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const width = maxX - minX, height = maxY - minY;
  if (!(width > 0) || !(height > 0)) return [];
  const gridSize = Math.max(8, Math.min(96, Math.ceil(Math.sqrt(triangles.length))));
  const cellX = (x: number) => Math.max(0, Math.min(gridSize - 1, Math.floor((x - minX) / width * gridSize)));
  const cellY = (y: number) => Math.max(0, Math.min(gridSize - 1, Math.floor((y - minY) / height * gridSize)));
  const bins = new Map<number, number[]>();
  triangles.forEach((triangle, index) => {
    const xs = triangle.map(point => point[0]), ys = triangle.map(point => point[1]);
    for (let y = cellY(Math.min(...ys)); y <= cellY(Math.max(...ys)); y++)
      for (let x = cellX(Math.min(...xs)); x <= cellX(Math.max(...xs)); x++) {
        const key = y * gridSize + x, bin = bins.get(key);
        if (bin) bin.push(index); else bins.set(key, [index]);
      }
  });

  const selected: number[] = [];
  for (const polygon of polygons) {
    const xs = polygon.points.map(point => point[0]), ys = polygon.points.map(point => point[1]);
    const x0 = Math.max(minX, Math.min(...xs)), x1 = Math.min(maxX, Math.max(...xs));
    const y0 = Math.max(minY, Math.min(...ys)), y1 = Math.min(maxY, Math.max(...ys));
    if (x0 > x1 || y0 > y1) continue;
    const candidates = new Set<number>();
    for (let y = cellY(y0); y <= cellY(y1); y++) for (let x = cellX(x0); x <= cellX(x1); x++)
      for (const triangle of bins.get(y * gridSize + x) ?? []) candidates.add(triangle);
    if ([...candidates].some(index => positiveAreaIntersection(polygon.points, triangles[index]))) selected.push(polygon.id);
  }
  return selected;
}

/** Pure projected-mask query used by viewport-relative mesh selection. Triangles are binned before points are
 * tested, keeping a long tessellated trail from becoming points × every patch triangle. Boundary hits count. */
export function pointsInProjectedTriangles(
  points: readonly ProjectedPoint[],
  inputTriangles: readonly ProjectedTriangle[],
): number[] {
  const triangles = inputTriangles.filter(triangle => triangle.every(point => point.every(Number.isFinite))
    && Math.abs(cross(triangle[0], triangle[1], triangle[2])) > 1e-12);
  if (!points.length || !triangles.length) return [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const triangle of triangles) for (const [x, y] of triangle) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  const width = maxX - minX, height = maxY - minY;
  if (!(width > 0) || !(height > 0)) return [];

  const gridSize = Math.max(8, Math.min(96, Math.ceil(Math.sqrt(triangles.length))));
  const cellX = (x: number) => Math.max(0, Math.min(gridSize - 1, Math.floor((x - minX) / width * gridSize)));
  const cellY = (y: number) => Math.max(0, Math.min(gridSize - 1, Math.floor((y - minY) / height * gridSize)));
  const bins = new Map<number, number[]>();
  triangles.forEach((triangle, index) => {
    const xs = triangle.map(point => point[0]), ys = triangle.map(point => point[1]);
    const x0 = cellX(Math.min(...xs)), x1 = cellX(Math.max(...xs));
    const y0 = cellY(Math.min(...ys)), y1 = cellY(Math.max(...ys));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const key = y * gridSize + x, bin = bins.get(key);
      if (bin) bin.push(index); else bins.set(key, [index]);
    }
  });

  const selected: number[] = [];
  const epsilon = 1e-10;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
      || point.x < minX - epsilon || point.x > maxX + epsilon
      || point.y < minY - epsilon || point.y > maxY + epsilon) continue;
    const candidates = bins.get(cellY(point.y) * gridSize + cellX(point.x)) ?? [];
    const p: [number, number] = [point.x, point.y];
    const inside = candidates.some(index => {
      const triangle = triangles[index];
      const a = cross(triangle[0], triangle[1], p);
      const b = cross(triangle[1], triangle[2], p);
      const c = cross(triangle[2], triangle[0], p);
      return !((a < -epsilon || b < -epsilon || c < -epsilon)
        && (a > epsilon || b > epsilon || c > epsilon));
    });
    if (inside) selected.push(point.id);
  }
  return selected;
}
