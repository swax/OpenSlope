// tier: fast
/**
 * Headless checks for a path point's local frame (core/mesh/path-frame.ts): the level frame, its roll, the
 * direction convention the gizmo and path extrusion share, and extrusion banking with a rolled point.
 * Run: `npx tsx test/path-frame.test.ts`
 */
import assert from 'node:assert/strict';
import { meshFromNet, starterCourse } from '../src/core/doc/mountain';
import { seedMeshIds } from '../src/core/doc/ids';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { add, cross, dot, len, norm, rotateAroundAxis, sub } from '../src/core/math/vec';
import { applyPlannedEdgeExtrusion, edgeChainExtrusionPlacement, planEdgeExtrusion } from '../src/core/mesh/ops';
import {
  edgePathFrame, fromPathFrame, isFreePoint, levelPathFrame, pathRollOf, rolledPathFrame, toPathFrame, vertexRollOf,
} from '../src/core/mesh/path-frame';
import { buildQuadMesh, meshAdjacency, meshFromDoc } from '../src/core/mesh/topology';

const close = (a: number, b: number, what: string, eps = 1e-9) => assert(Math.abs(a - b) < eps, `${what}: ${a} vs ${b}`);

// Level frame: orthonormal, right-handed, z horizontal; a vertical tangent falls back to the given up.
for (const tangent of [[1, 0, 0], [3, 2, -1], [0, 1, 0.001], [-2, -5, 4]] as V3[]) {
  const f = levelPathFrame(tangent)!;
  close(dot(f.x, f.y), 0, 'x ⟂ y'); close(dot(f.x, f.z), 0, 'x ⟂ z'); close(dot(f.y, f.z), 0, 'y ⟂ z');
  close(len(sub(cross(f.x, f.y), f.z)), 0, 'right-handed');
  close(f.z[1], 0, 'z is level');
  assert(f.y[1] > 0, 'y leans up');
}
close(len(sub(levelPathFrame([0, 1, 0], [0, 0, 1])!.y, [0, 0, 1])), 0, 'a vertical path keeps the previous up');

// Roll: rolledPathFrame and pathRollOf are inverses, and a rotation of the whole frame reads back as the roll
// left once its X is carried by the handles (what the gizmo writes on Rotate).
for (const roll of [0, 0.3, -1.2, 2.9]) {
  const tangent: V3 = [2, 1, -3], rolled = rolledPathFrame(levelPathFrame(tangent)!, roll);
  close(pathRollOf(tangent, rolled.y), roll, 'roll round-trips');
  for (const [axis, angle] of [[[0, 1, 0], 0.7], [norm([1, 2, 3]), -1.1], [rolled.x, 0.4]] as [V3, number][]) {
    const x = rotateAroundAxis(rolled.x, axis, angle), y = rotateAroundAxis(rolled.y, axis, angle);
    const back = rolledPathFrame(levelPathFrame(x)!, pathRollOf(x, y));
    close(len(sub(back.y, y)), 0, 'a rotated frame is its new tangent plus a roll');
  }
}

// A free point has edges and no patch on any of them.
{
  const m = buildQuadMesh([0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10, 20, 0, 10, 30, 0, 10], [[0, 1, 2, 3]], [[3, 4], [4, 5]]);
  const adj = meshAdjacency(m);
  assert(!isFreePoint(adj, 3), 'a patch corner is not free, even with a free edge');
  assert(isFreePoint(adj, 4) && isFreePoint(adj, 5), 'free-edge points are free');
}

// Banking: a rolled guide point tilts the extruded profile there, and the profile lies along the Z the gizmo
// shows for that point — whichever way the stable ids run along the chain.
const helix = (k: number): V3 => [20 * Math.sin(k * 0.4), 2 * k, 5 + 20 * (1 - Math.cos(k * 0.4))];
const rolls: Record<number, number> = { 4: 0.5, 7: -0.8, 13: 1.1 };
for (const reversed of [false, true]) {
  const doc: QuadMeshDoc = meshFromNet({ rows: 2, cols: 2, spacing: 10,
    corners: [0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10], paint: {} },
  { name: 'ROLL', course: starterCourse(), baseSurface: 1 });
  doc.quads = [];
  doc.vertices = [0, 0, -5, 0, 0, 5, ...Array.from({ length: 12 }, (_, k) => helix(k + 1)).flat()];
  doc.freeEdges = [[0, 1], ...Array.from({ length: 12 }, (_, k) => [k + 1, k + 2] as [number, number])];
  doc.edgeHandles = { '1>2': [2.5, 0, 0] }; // the path leaves the source level, heading +x
  Object.assign(doc, seedMeshIds(0, doc.vertices.length / 3, 0));
  if (reversed) doc.vertexIds.reverse();
  doc.vertexRoll = Object.fromEntries(Object.entries(rolls).map(([vertex, roll]) => [doc.vertexIds[Number(vertex)], roll]));

  const p = planEdgeExtrusion(doc, [[0, 1]]);
  assert(p.ok, p.ok ? '' : p.error);
  const swept = edgeChainExtrusionPlacement(doc, p.plan, doc.freeEdges.slice(1));
  assert(swept.ok, swept.ok ? '' : swept.error);
  const { mesh, edgeHandle } = meshFromDoc(doc), adj = meshAdjacency(mesh);
  swept.placement.stations!.forEach((ring, s) => {
    const vertex = s + 2, what = `${reversed ? 'reversed ids' : 'ids'} station ${s}`;
    const across = sub(ring.vertices[1], ring.vertices[0]);
    const shown = edgePathFrame(doc.vertices, adj, vertex, { handle: edgeHandle, roll: vertexRollOf(doc, vertex), ids: doc.vertexIds })!;
    close(dot(across, shown.x), 0, `${what}: the profile crosses the path`, 1e-6);
    close(dot(across, shown.y), 0, `${what}: the profile lies along the point's Z`, 1e-6);
    // Rolled, Z picks up -sin(roll) of the level Y, which leans off vertical by the path's climb.
    const levelUp = levelPathFrame(shown.x)!.y[1];
    close(Math.abs(across[1]), 10 * Math.abs(Math.sin(rolls[vertex] ?? 0)) * levelUp, `${what}: the roll banks it`, 1e-6);
  });
}

// A U swept round a quarter circle keeps its shape between stations too: every track (not only the guide) follows
// the swept surface — guide curve plus the profile carried in the turning frame — so the inside legs shorten with
// the bend, and the end segments follow the guide's own uneven bend. Rolled unevenly (twisting, then barely, then
// untwisting — GARI_DEUX's pattern), every track still runs through each ring without a kink.
for (const rolled of [false, true]) {
  const segments = 4, R = 30;
  const doc: QuadMeshDoc = meshFromNet({ rows: 2, cols: 2, spacing: 10,
    corners: [0, 0, 0, 10, 0, 0, 0, 0, 10, 10, 0, 10], paint: {} },
  { name: 'U', course: starterCourse(), baseSurface: 1 });
  doc.quads = [];
  const U: V3[] = [[0, 8, -6], [0, 0, -6], [0, 0, 0], [0, 0, 6], [0, 8, 6]];
  const arc = (k: number): V3 => [R * Math.sin(k * Math.PI / 2 / segments), 0, R - R * Math.cos(k * Math.PI / 2 / segments)];
  doc.vertices = [...U.flat(), ...Array.from({ length: segments }, (_, k) => arc(k + 1)).flat()];
  doc.freeEdges = [[0, 1], [1, 2], [2, 3], [3, 4], [2, 5], ...Array.from({ length: segments - 1 }, (_, k) => [k + 5, k + 6] as [number, number])];
  Object.assign(doc, seedMeshIds(0, doc.vertices.length / 3, 0));
  if (rolled) doc.vertexRoll = { [doc.vertexIds[6]]: -0.5, [doc.vertexIds[7]]: -0.54 };
  const p = planEdgeExtrusion(doc, [[0, 1], [1, 2], [2, 3], [3, 4]]);
  assert(p.ok, p.ok ? '' : p.error);
  const placed = edgeChainExtrusionPlacement(doc, p.plan, doc.freeEdges.slice(4));
  assert(placed.ok, placed.ok ? '' : placed.error);
  const out = applyPlannedEdgeExtrusion(doc, p.plan, placed.placement);
  assert(out.ok, out.ok ? '' : out.error);
  const { edgeHandle } = meshFromDoc(out.doc);
  const at = (v: number): V3 => [out.doc.vertices[v * 3], out.doc.vertices[v * 3 + 1], out.doc.vertices[v * 3 + 2]];
  const curve = (a: number, b: number, t: number, derivative = false): V3 => {
    const p0 = at(a), c1 = add(p0, edgeHandle(a, b)), p1 = at(b), c2 = add(p1, edgeHandle(b, a)), s = 1 - t;
    return [0, 1, 2].map(i => derivative
      ? 3 * s * s * (c1[i] - p0[i]) + 6 * s * t * (c2[i] - c1[i]) + 3 * t * t * (p1[i] - c2[i])
      : s * s * s * p0[i] + 3 * s * s * t * c1[i] + 3 * s * t * t * c2[i] + t * t * t * p1[i]) as V3;
  };
  const vertexAt = (pos: V3) => Array.from({ length: out.doc.vertices.length / 3 }, (_, v) => v).find(v => len(sub(at(v), pos)) < 1e-9)!;
  const guide = [2, ...Array.from({ length: segments }, (_, k) => k + 5)];
  const start = levelPathFrame(edgeHandle(2, 5))!;
  for (const u of [0, 1, 3, 4]) {
    const local = toPathFrame(start, sub(U[u], U[2]));
    const track = [u, ...placed.placement.stations!.map(station => vertexAt(station.vertices[u]))];
    for (let i = 1; i < segments; i++) {
      const bend = Math.acos(Math.min(1, -dot(norm(edgeHandle(track[i], track[i - 1])), norm(edgeHandle(track[i], track[i + 1])))));
      assert(bend < 1e-6, `${rolled ? 'rolled ' : ''}U[${u}] kinks ${(bend * 180 / Math.PI).toFixed(1)}° at ring ${i}`);
    }
    if (rolled) continue;
    for (let i = 1; i <= segments; i++) {
      const a = track[i - 1], b = track[i];
      for (const t of [0.25, 0.5, 0.75]) {
        const ideal = add(curve(guide[i - 1], guide[i], t), fromPathFrame(levelPathFrame(curve(guide[i - 1], guide[i], t, true))!, local));
        const off = len(sub(curve(a, b, t), ideal));
        // Bounded by the guide itself: its curvature jumps at each point, and the tracks take one turn rate there.
        assert(off < 0.2, `U[${u}] segment ${i} at ${t} strays ${off.toFixed(3)} m from the swept surface`);
      }
    }
  }
}

console.log('PATH FRAME: PASS');
