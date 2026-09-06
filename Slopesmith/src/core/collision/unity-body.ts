import type { V3 } from '../doc/types';

/** One level in the native mode-3 occupancy tree. */
export interface PhysicsTreeLevel { U0: number; U1: number; U2: number }

/** A box in native body-local centimetres. */
export interface BodyBox { center: V3; size: V3 }

/** A sphere-swept segment in native body-local centimetres; equal endpoints mean a sphere. */
export interface BodyCapsule { a: V3; b: V3; radius: number }

export interface BodyShape { boxes: BodyBox[]; capsules: BodyCapsule[] }

/**
 * The two Unity-export candidates derived from one native sphere tree. `body` is used for a doorway or sparse
 * occupancy; `tilt` is used for a compact instance whose rotation inflates its world AABB too far. The final
 * instance decision remains separate because it depends on that placement's rotation and scale.
 */
export interface UnityBodyRecipe {
  doorwayOrSparse: boolean;
  bounds: BodyBox;
  body: BodyShape;
  tilt: BodyShape;
}

export interface DecodedPhysicsBody {
  root: V3;
  gridN: number;
  leafRadius: number;
  axisPos: number[];
  /** Max-depth occupied lattice cells, encoded as (x*n + y)*n + z. */
  cells: Set<number>;
  /** Native runtime leaf spheres, packed x/y/z/r. */
  spheres: number[];
}

const DOORWAY_PLAYER_SIZE = 180;
const COMPACT_MIN_FILL = 0.35;
const MAX_AABB_INFLATION = 1.6;
const MIN_HALF = 5;
const ELONGATION_MIN = 1.75;

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const lengthSq = (a: V3) => dot(a, a);
const length = (a: V3) => Math.sqrt(lengthSq(a));
const normalize = (a: V3): V3 => { const n = length(a); return n > 1e-12 ? mul(a, 1 / n) : [0, 0, 0]; };
const keyOf = (n: number, x: number, y: number, z: number) => (x * n + y) * n + z;
const cellOf = (n: number, key: number): V3 => {
  const x = Math.floor(key / (n * n));
  const yz = key - x * n * n;
  return [x, Math.floor(yz / n), yz % n];
};

/** Decode the exact tree once for both the native sphere overlay and the Unity collider recipe. */
export function decodePhysicsBodyTree(root: V3, levels: readonly PhysicsTreeLevel[], masks: readonly number[]): DecodedPhysicsBody | null {
  if (levels.length < 2 || !masks.length) return null;
  const maxDepth = levels.length - 1;
  const gridN = 1 << maxDepth;
  const axisPos = new Array<number>(gridN);
  for (let i = 0; i < gridN; i++) {
    let p = 0;
    for (let depth = 1; depth <= maxDepth; depth++)
      p += ((i >> (maxDepth - depth)) & 1) ? levels[depth].U1 : -levels[depth].U1;
    axisPos[i] = p;
  }
  const cells = new Set<number>();
  const spheres: number[] = [];
  const walk = (depth: number, offset: number, px: number, py: number, pz: number,
    cx: number, cy: number, cz: number) => {
    const mask = offset < masks.length ? masks[offset] : 0;
    if (depth >= maxDepth || mask === 0) {
      spheres.push(cx, cy, cz, levels[depth].U0);
      const span = 1 << (maxDepth - depth);
      for (let x = 0; x < span; x++) for (let y = 0; y < span; y++) for (let z = 0; z < span; z++)
        cells.add(keyOf(gridN, px * span + x, py * span + y, pz * span + z));
      return;
    }
    const stride = levels[depth].U2;
    const step = levels[depth + 1].U1;
    for (let bit = 0; bit < 8; bit++) {
      if (!(mask & (1 << bit))) continue;
      const bx = (bit >> 2) & 1, by = (bit >> 1) & 1, bz = bit & 1;
      walk(depth + 1, offset + (bit + 1) * stride,
        px * 2 + bx, py * 2 + by, pz * 2 + bz,
        cx + (bx ? step : -step), cy + (by ? step : -step), cz + (bz ? step : -step));
    }
  };
  walk(0, 0, 0, 0, 0, root[0], root[1], root[2]);
  return cells.size ? { root, gridN, leafRadius: levels[maxDepth].U0, axisPos, cells, spheres } : null;
}

function cellSpan(body: DecodedPhysicsBody) {
  return body.axisPos.length > 1 ? body.axisPos[1] - body.axisPos[0] : body.leafRadius;
}

function point(body: DecodedPhysicsBody, key: number): V3 {
  const c = cellOf(body.gridN, key);
  return [body.root[0] + body.axisPos[c[0]], body.root[1] + body.axisPos[c[1]], body.root[2] + body.axisPos[c[2]]];
}

function occupiedLimits(body: DecodedPhysicsBody): { lo: V3; hi: V3 } | null {
  if (!body.cells.size) return null;
  const lo: V3 = [body.gridN, body.gridN, body.gridN], hi: V3 = [-1, -1, -1];
  for (const key of body.cells) {
    const c = cellOf(body.gridN, key);
    for (let axis = 0; axis < 3; axis++) {
      lo[axis] = Math.min(lo[axis], c[axis]);
      hi[axis] = Math.max(hi[axis], c[axis]);
    }
  }
  return { lo, hi };
}

function bodyBounds(body: DecodedPhysicsBody): BodyBox {
  const limits = occupiedLimits(body)!;
  const min: V3 = [0, 0, 0], max: V3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    min[axis] = body.root[axis] + body.axisPos[limits.lo[axis]] - body.leafRadius;
    max[axis] = body.root[axis] + body.axisPos[limits.hi[axis]] + body.leafRadius;
  }
  return { center: mul(add(min, max), 0.5), size: sub(max, min) };
}

function fillFraction(body: DecodedPhysicsBody) {
  const limits = occupiedLimits(body);
  if (!limits) return 0;
  const volume = (limits.hi[0] - limits.lo[0] + 1)
    * (limits.hi[1] - limits.lo[1] + 1) * (limits.hi[2] - limits.lo[2] + 1);
  return body.cells.size / volume;
}

function hasDoorway(body: DecodedPhysicsBody, playerSize = DOORWAY_PLAYER_SIZE) {
  const limits = occupiedLimits(body);
  if (!limits) return false;
  const { lo, hi } = limits;
  const span = cellSpan(body);
  // Exact rectangular occupancy queries through a summed-volume table keep the exporter-equivalent doorway
  // search cheap enough to derive for every distinct body when a reference level loads.
  const pn = body.gridN + 1;
  const prefix = new Uint16Array(pn * pn * pn);
  const at = (x: number, y: number, z: number) => (x * pn + y) * pn + z;
  for (let x = 1; x < pn; x++) for (let y = 1; y < pn; y++) for (let z = 1; z < pn; z++) {
    const occupied = body.cells.has(keyOf(body.gridN, x - 1, y - 1, z - 1)) ? 1 : 0;
    prefix[at(x, y, z)] = occupied
      + prefix[at(x - 1, y, z)] + prefix[at(x, y - 1, z)] + prefix[at(x, y, z - 1)]
      - prefix[at(x - 1, y - 1, z)] - prefix[at(x - 1, y, z - 1)] - prefix[at(x, y - 1, z - 1)]
      + prefix[at(x - 1, y - 1, z - 1)];
  }
  const corridorEmpty = (axisA: number, a0: number, a1: number, axisB: number, b0: number, b1: number,
    axisC: number, c0: number, c1: number) => {
    const min: V3 = [0, 0, 0], max: V3 = [0, 0, 0];
    min[axisA] = a0; max[axisA] = a1 + 1;
    min[axisB] = b0; max[axisB] = b1 + 1;
    min[axisC] = c0; max[axisC] = c1 + 1;
    const [x0, y0, z0] = min, [x1, y1, z1] = max;
    const count = prefix[at(x1, y1, z1)] - prefix[at(x0, y1, z1)] - prefix[at(x1, y0, z1)]
      - prefix[at(x1, y1, z0)] + prefix[at(x0, y0, z1)] + prefix[at(x0, y1, z0)]
      + prefix[at(x1, y0, z0)] - prefix[at(x0, y0, z0)];
    return count === 0;
  };
  const solidBothSides = (axis: number, g0: number, g1: number) => lo[axis] < g0 && hi[axis] > g1;
  for (let axisA = 0; axisA < 3; axisA++) {
    const axisB = axisA === 0 ? 1 : 0, axisC = axisA === 2 ? 1 : 2;
    for (let b0 = lo[axisB]; b0 <= hi[axisB]; b0++) for (let b1 = b0; b1 <= hi[axisB]; b1++) {
      if (body.axisPos[b1] - body.axisPos[b0] + span < playerSize) continue;
      for (let c0 = lo[axisC]; c0 <= hi[axisC]; c0++) for (let c1 = c0; c1 <= hi[axisC]; c1++) {
        if (body.axisPos[c1] - body.axisPos[c0] + span < playerSize) continue;
        if (corridorEmpty(axisA, lo[axisA], hi[axisA], axisB, b0, b1, axisC, c0, c1)
          && (solidBothSides(axisB, b0, b1) || solidBothSides(axisC, c0, c1))) return true;
      }
    }
  }
  return false;
}

function nearestAxisIndex(body: DecodedPhysicsBody, value: number) {
  let best = 0, bestDistance = Infinity;
  for (let i = 0; i < body.axisPos.length; i++) {
    const distance = Math.abs(body.axisPos[i] - value);
    if (distance < bestDistance) { bestDistance = distance; best = i; }
  }
  return best;
}

function farthest(points: readonly V3[], from: V3) {
  let best = from, bestDistance = -1;
  for (const p of points) {
    const distance = lengthSq(sub(p, from));
    if (distance > bestDistance) { bestDistance = distance; best = p; }
  }
  return best;
}

function greedyCapsules(body: DecodedPhysicsBody, cap = 24, maxPerpCells = 1.25) {
  const capsules: BodyCapsule[] = [];
  const leftover = new Set<number>();
  const maxPerp = maxPerpCells * cellSpan(body);
  const spill = (points: readonly V3[]) => {
    for (const p of points) {
      const q = sub(p, body.root);
      leftover.add(keyOf(body.gridN, nearestAxisIndex(body, q[0]), nearestAxisIndex(body, q[1]), nearestAxisIndex(body, q[2])));
    }
  };
  const coreCoversEmpty = (centroid: V3, axis: V3, tMin: number, tMax: number, core: number) => {
    for (let x = 0; x < body.gridN; x++) for (let y = 0; y < body.gridN; y++) for (let z = 0; z < body.gridN; z++) {
      if (body.cells.has(keyOf(body.gridN, x, y, z))) continue;
      const p: V3 = [body.root[0] + body.axisPos[x], body.root[1] + body.axisPos[y], body.root[2] + body.axisPos[z]];
      const t = Math.max(tMin, Math.min(tMax, dot(sub(p, centroid), axis)));
      if (length(sub(p, add(centroid, mul(axis, t)))) <= core) return true;
    }
    return false;
  };
  const fitOrSplit = (points: V3[], depth: number) => {
    if (!points.length) return;
    if (capsules.length >= cap) { spill(points); return; }
    if (points.length === 1) { capsules.push({ a: points[0], b: points[0], radius: body.leafRadius }); return; }
    const seed = farthest(points, points[0]);
    let axis = sub(farthest(points, seed), seed);
    if (length(axis) < 1e-3) { capsules.push({ a: points[0], b: points[0], radius: body.leafRadius }); return; }
    axis = normalize(axis);
    let centroid: V3 = [0, 0, 0];
    for (const p of points) centroid = add(centroid, p);
    centroid = mul(centroid, 1 / points.length);
    let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
    for (const p of points) {
      const d = sub(p, centroid);
      xx += d[0] * d[0]; xy += d[0] * d[1]; xz += d[0] * d[2];
      yy += d[1] * d[1]; yz += d[1] * d[2]; zz += d[2] * d[2];
    }
    for (let iter = 0; iter < 24; iter++) {
      const next: V3 = [xx * axis[0] + xy * axis[1] + xz * axis[2],
        xy * axis[0] + yy * axis[1] + yz * axis[2], xz * axis[0] + yz * axis[1] + zz * axis[2]];
      if (length(next) < 1e-6) break;
      axis = normalize(next);
    }
    let tMin = Infinity, tMax = -Infinity, worstPerp = 0;
    for (const p of points) {
      const t = dot(sub(p, centroid), axis);
      tMin = Math.min(tMin, t); tMax = Math.max(tMax, t);
      worstPerp = Math.max(worstPerp, length(sub(p, add(centroid, mul(axis, t)))));
    }
    if (worstPerp <= maxPerp) {
      const radius = worstPerp + body.leafRadius;
      if (tMax - tMin < ELONGATION_MIN * 2 * radius) { spill(points); return; }
      if (!coreCoversEmpty(centroid, axis, tMin, tMax, worstPerp)) {
        capsules.push({ a: add(centroid, mul(axis, tMin)), b: add(centroid, mul(axis, tMax)), radius });
        return;
      }
    }
    if (depth >= 6) { spill(points); return; }
    points.sort((a, b) => dot(sub(a, centroid), axis) - dot(sub(b, centroid), axis));
    const half = Math.floor(points.length / 2);
    fitOrSplit(points.slice(0, half), depth + 1);
    fitOrSplit(points.slice(half), depth + 1);
  };

  const remaining = new Set(body.cells);
  while (remaining.size) {
    const first = remaining.values().next().value as number;
    const queue = [first];
    const component: V3[] = [];
    remaining.delete(first);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const key = queue[cursor], cell = cellOf(body.gridN, key);
      component.push(point(body, key));
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        const x = cell[0] + dx, y = cell[1] + dy, z = cell[2] + dz;
        if (x < 0 || y < 0 || z < 0 || x >= body.gridN || y >= body.gridN || z >= body.gridN) continue;
        const neighbour = keyOf(body.gridN, x, y, z);
        if (remaining.delete(neighbour)) queue.push(neighbour);
      }
    }
    fitOrSplit(component, 0);
  }
  return { capsules, leftover };
}

function greedyBoxes(body: DecodedPhysicsBody, cells: ReadonlySet<number>, cap = 16, minNewCells = 3) {
  const boxes: BodyBox[] = [];
  const covered = new Set<number>();
  const axisValues = (axis: number) => [...new Set([...cells].map(key => cellOf(body.gridN, key)[axis]))].sort((a, b) => a - b);
  const xs = axisValues(0), ys = axisValues(1), zs = axisValues(2);
  if (!xs.length) return boxes;
  const pn = body.gridN + 1;
  const at = (x: number, y: number, z: number) => (x * pn + y) * pn + z;
  const summedVolume = (source: ReadonlySet<number>) => {
    const prefix = new Uint16Array(pn * pn * pn);
    for (let x = 1; x < pn; x++) for (let y = 1; y < pn; y++) for (let z = 1; z < pn; z++) {
      const occupied = source.has(keyOf(body.gridN, x - 1, y - 1, z - 1)) ? 1 : 0;
      prefix[at(x, y, z)] = occupied
        + prefix[at(x - 1, y, z)] + prefix[at(x, y - 1, z)] + prefix[at(x, y, z - 1)]
        - prefix[at(x - 1, y - 1, z)] - prefix[at(x - 1, y, z - 1)] - prefix[at(x, y - 1, z - 1)]
        + prefix[at(x - 1, y - 1, z - 1)];
    }
    return prefix;
  };
  const cellsPrefix = summedVolume(cells);
  const count = (prefix: Uint16Array, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => {
    x1++; y1++; z1++;
    return prefix[at(x1, y1, z1)] - prefix[at(x0, y1, z1)] - prefix[at(x1, y0, z1)]
      - prefix[at(x1, y1, z0)] + prefix[at(x0, y0, z1)] + prefix[at(x0, y1, z0)]
      + prefix[at(x1, y0, z0)] - prefix[at(x0, y0, z0)];
  };
  while (boxes.length < cap) {
    let bestNew = minNewCells - 1;
    let best: [number, number, number, number, number, number] | null = null;
    const coveredPrefix = summedVolume(covered);
    for (const x0 of xs) for (const x1 of xs) {
      if (x1 < x0) continue;
      for (const y0 of ys) for (const y1 of ys) {
        if (y1 < y0) continue;
        for (const z0 of zs) for (const z1 of zs) {
          if (z1 < z0) continue;
          const volume = (x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1);
          if (volume <= bestNew || count(cellsPrefix, x0, x1, y0, y1, z0, z1) !== volume) continue;
          const fresh = volume - count(coveredPrefix, x0, x1, y0, y1, z0, z1);
          if (fresh > bestNew) { bestNew = fresh; best = [x0, x1, y0, y1, z0, z1]; }
        }
      }
    }
    if (!best) break;
    const [x0, x1, y0, y1, z0, z1] = best;
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++)
      covered.add(keyOf(body.gridN, x, y, z));
    const min: V3 = [body.root[0] + body.axisPos[x0] - body.leafRadius,
      body.root[1] + body.axisPos[y0] - body.leafRadius, body.root[2] + body.axisPos[z0] - body.leafRadius];
    const max: V3 = [body.root[0] + body.axisPos[x1] + body.leafRadius,
      body.root[1] + body.axisPos[y1] + body.leafRadius, body.root[2] + body.axisPos[z1] + body.leafRadius];
    boxes.push({ center: mul(add(min, max), 0.5), size: sub(max, min) });
  }
  return boxes;
}

function capsuleRunsPlusBoxes(body: DecodedPhysicsBody): BodyShape {
  const { capsules, leftover } = greedyCapsules(body);
  return { capsules, boxes: leftover.size >= 3 ? greedyBoxes(body, leftover) : [] };
}

/** Build the cached body-level candidates using the same thresholds and decomposition as CollisionBundle. */
export function buildUnityBodyRecipe(body: DecodedPhysicsBody): UnityBodyRecipe {
  const bounds = bodyBounds(body);
  const doorwayOrSparse = hasDoorway(body) || fillFraction(body) < COMPACT_MIN_FILL;
  if (doorwayOrSparse) return {
    doorwayOrSparse, bounds, body: capsuleRunsPlusBoxes(body), tilt: { boxes: [], capsules: [] },
  };
  const { capsules, leftover } = greedyCapsules(body);
  const tilt = capsules.length >= 1 && capsules.length <= 2 && leftover.size < 3
    ? { boxes: [], capsules } : { boxes: [bounds], capsules: [] };
  return { doorwayOrSparse, bounds, body: { boxes: [], capsules: [] }, tilt };
}

function rotateByQuaternion(v: V3, q: readonly number[]): V3 {
  const qx = q[0] ?? 0, qy = q[1] ?? 0, qz = q[2] ?? 0, qw = q[3] ?? 1;
  const ix = qw * v[0] + qy * v[2] - qz * v[1];
  const iy = qw * v[1] + qz * v[0] - qx * v[2];
  const iz = qw * v[2] + qx * v[1] - qy * v[0];
  const iw = -qx * v[0] - qy * v[1] - qz * v[2];
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx];
}

/** Whether this placement selects the cached compact-body OBB/capsule candidate instead of a world AABB. */
export function unityBodyRecipeKind(recipe: UnityBodyRecipe, rotation: readonly number[], scale: readonly number[]): 'body' | 'tilt' | 'bounds' {
  if (recipe.doorwayOrSparse) return 'body';
  const half = mul(recipe.bounds.size, 0.5), center = recipe.bounds.center;
  const min = sub(center, half), max = add(center, half);
  const s: V3 = [scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1];
  const floor = 2 * MIN_HALF;
  const ext: V3 = [Math.max(Math.abs(recipe.bounds.size[0] * s[0]), floor),
    Math.max(Math.abs(recipe.bounds.size[1] * s[1]), floor), Math.max(Math.abs(recipe.bounds.size[2] * s[2]), floor)];
  const amin: V3 = [Infinity, Infinity, Infinity], amax: V3 = [-Infinity, -Infinity, -Infinity];
  for (let corner = 0; corner < 8; corner++) {
    const p: V3 = [(corner & 1 ? max[0] : min[0]) * s[0],
      (corner & 2 ? max[1] : min[1]) * s[1], (corner & 4 ? max[2] : min[2]) * s[2]];
    const rotated = rotateByQuaternion(p, rotation);
    for (let axis = 0; axis < 3; axis++) {
      amin[axis] = Math.min(amin[axis], rotated[axis]);
      amax[axis] = Math.max(amax[axis], rotated[axis]);
    }
  }
  const aext: V3 = [Math.max(amax[0] - amin[0], floor), Math.max(amax[1] - amin[1], floor),
    Math.max(amax[2] - amin[2], floor)];
  const inflation = aext[0] * aext[1] * aext[2] / (ext[0] * ext[1] * ext[2]);
  return inflation > MAX_AABB_INFLATION ? 'tilt' : 'bounds';
}

/** Apply the exporter's baked instance scale (capsule radius conservatively uses the largest axis). */
export function scaleBodyShape(shape: BodyShape, scale: readonly number[]): BodyShape {
  const s: V3 = [scale[0] ?? 1, scale[1] ?? 1, scale[2] ?? 1];
  const radiusScale = Math.max(Math.abs(s[0]), Math.abs(s[1]), Math.abs(s[2]));
  const scaledPoint = (p: V3): V3 => [p[0] * s[0], p[1] * s[1], p[2] * s[2]];
  return {
    boxes: shape.boxes.map(box => ({ center: scaledPoint(box.center),
      size: [Math.abs(box.size[0] * s[0]), Math.abs(box.size[1] * s[1]), Math.abs(box.size[2] * s[2])] })),
    capsules: shape.capsules.map(capsule => ({ a: scaledPoint(capsule.a), b: scaledPoint(capsule.b),
      radius: capsule.radius * radiusScale })),
  };
}
