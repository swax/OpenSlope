import { bilinear, type Raster } from './contour-raster';
import type { Builder } from './contour-knit';

/** Contour flow post-passes over an assembled sheet: parity-triangle cancellation, pinch-vertex
 *  splitting, and the guarded Laplacian relaxation. See ./contour.ts. */

// ---- parity triangles ------------------------------------------------------------------------------------

/**
 * Cancel the join's parity triangles against each other. Two triangles connected through the quad sheet
 * annihilate: a triangle and its neighbouring quad form a pentagon that re-splits with the triangle one
 * face further along, and two edge-adjacent triangles merge into one quad. This is the constructive
 * equivalent of the global parity routing a BiMDF quantization performs.
 */
export function cancelParityTriangles(builder: Builder, notes: string[]): void {
  const triangles = builder.faces
    .map((face, index) => (face.length === 3 ? index : -1))
    .filter(index => index >= 0);
  if (!triangles.length) return;
  const toWedge = (slot: number): void => {
    const [a, b, c] = builder.faces[slot];
    builder.faces[slot] = [a, b, c, c];
  };
  if (triangles.length % 2) {
    // an odd triangle has no partner anywhere; it stays as one collapsed wedge
    toWedge(triangles.pop()!);
    notes.push('one parity triangle kept as a collapsed wedge');
  }
  const centroid = (slot: number): [number, number] => {
    let x = 0, z = 0;
    for (const id of builder.faces[slot]) { x += builder.vertices[id][0]; z += builder.vertices[id][2]; }
    return [x / builder.faces[slot].length, z / builder.faces[slot].length];
  };
  const remaining = new Set(triangles);
  const pairs: [number, number][] = [];
  while (remaining.size) {
    const [first] = remaining;
    remaining.delete(first);
    const [fx, fz] = centroid(first);
    let best = -1, bestDistance = Infinity;
    for (const other of remaining) {
      const [ox, oz] = centroid(other);
      const d = Math.hypot(fx - ox, fz - oz);
      if (d < bestDistance) { bestDistance = d; best = other; }
    }
    remaining.delete(best);
    pairs.push([first, best]);
  }

  const edgeKeyOf = (a: number, b: number): string => a < b ? `${a},${b}` : `${b},${a}`;
  const adjacency = (): Map<string, number[]> => {
    const map = new Map<string, number[]>();
    for (let slot = 0; slot < builder.faces.length; slot++) {
      const face = builder.faces[slot];
      for (let i = 0; i < face.length; i++) {
        const key = edgeKeyOf(face[i], face[(i + 1) % face.length]);
        const list = map.get(key);
        if (list) list.push(slot); else map.set(key, [slot]);
      }
    }
    return map;
  };
  const sharedEdge = (a: number[], b: number[]): [number, number] | null => {
    for (let i = 0; i < a.length; i++) {
      const u = a[i], v = a[(i + 1) % a.length];
      for (let j = 0; j < b.length; j++) {
        if (b[j] === v && b[(j + 1) % b.length] === u) return [u, v];
      }
    }
    // a geometrically folded neighbour auto-oriented against the sheet still shares the edge — return
    // it as seen from `a`, and let the caller view `b` reversed
    for (let i = 0; i < a.length; i++) {
      const u = a[i], v = a[(i + 1) % a.length];
      for (let j = 0; j < b.length; j++) {
        if (b[j] === u && b[(j + 1) % b.length] === v) return [u, v];
      }
    }
    return null;
  };
  const facingView = (face: number[], u: number, v: number): number[] => {
    for (let j = 0; j < face.length; j++) {
      if (face[j] === v && face[(j + 1) % face.length] === u) return face;
    }
    return [...face].reverse();
  };
  const rotate = (face: number[], to: number): number[] => {
    const at = face.indexOf(to);
    return [...face.slice(at), ...face.slice(0, at)];
  };

  for (const [startSlot, targetSlot] of pairs) {
    let slot = startSlot;
    try {
    for (let guard = 0; ; guard++) {
      if (guard > 800) throw new Error('parity triangle failed to reach its partner');
      const direct = sharedEdge(builder.faces[slot], builder.faces[targetSlot]);
      if (direct) {
        // merge the two triangles across their shared edge into one quad: this triangle holds u->v and
        // its partner (viewed facing it) v->u, so the union's perimeter is [v, t, u, partner's third]
        const [u, v] = direct;
        const t = builder.faces[slot].find(id => id !== u && id !== v)!;
        const partnerThird = builder.faces[targetSlot].find(id => id !== u && id !== v)!;
        builder.faces[slot] = [v, t, u, partnerThird];
        builder.faces[targetSlot] = [];
        break;
      }
      // step the triangle one quad toward its partner
      const edges = adjacency();
      const distanceTo = centroid(targetSlot);
      const previous = new Map<number, number>();
      const queue = [slot];
      previous.set(slot, -1);
      let found = -1;
      while (queue.length && found < 0) {
        const at = queue.shift()!;
        const face = builder.faces[at];
        const neighbors: { slot: number; d: number }[] = [];
        for (let i = 0; i < face.length; i++) {
          for (const next of edges.get(edgeKeyOf(face[i], face[(i + 1) % face.length])) ?? []) {
            if (previous.has(next) || next === at) continue;
            if (builder.faces[next].length !== 4) continue;
            const [cx, cz] = centroid(next);
            neighbors.push({ slot: next, d: Math.hypot(cx - distanceTo[0], cz - distanceTo[1]) });
          }
        }
        neighbors.sort((a, b) => a.d - b.d);
        for (const neighbor of neighbors) {
          previous.set(neighbor.slot, at);
          if (sharedEdge(builder.faces[neighbor.slot], builder.faces[targetSlot])
            || sharedEdge(builder.faces[targetSlot], builder.faces[neighbor.slot])) { found = neighbor.slot; break; }
          queue.push(neighbor.slot);
        }
      }
      if (found < 0) throw new Error('parity triangles are in disconnected sheets');
      // walk back to the first step out of the current triangle
      let step = found;
      while (previous.get(step)! !== slot) step = previous.get(step)!;
      const tri = builder.faces[slot], quad = builder.faces[step];
      const shared = sharedEdge(tri, quad);
      if (!shared) throw new Error('parity triangle lost adjacency mid-push');
      // the triangle holds the directed edge u->v; view the quad facing it (v->u, reversing a folded
      // neighbour if needed) so rotated to start at u it reads [u, x, y, v] along its far side
      const [u, v] = shared;
      const t = tri.find(id => id !== u && id !== v)!;
      const rotatedQuad = rotate(facingView(quad, u, v), u);
      if (rotatedQuad[3] !== v) throw new Error('parity push found an inconsistent quad orientation');
      const pentagon = [t, u, rotatedQuad[1], rotatedQuad[2], v];
      const nextFace = step === found ? targetSlot : (() => {
        let ahead = found;
        while (previous.get(ahead)! !== step) ahead = previous.get(ahead)!;
        return ahead;
      })();
      const e2 = sharedEdge(builder.faces[step], builder.faces[nextFace])
        ?? sharedEdge(builder.faces[nextFace], builder.faces[step]);
      const splits: [number[], number[]][] = [
        [[1, 2, 3], [3, 4, 0, 1]], [[2, 3, 4], [4, 0, 1, 2]], [[0, 1, 2], [2, 3, 4, 0]],
        [[3, 4, 0], [0, 1, 2, 3]], [[4, 0, 1], [1, 2, 3, 4]],
      ];
      const containsE2 = (indices: number[]): boolean => {
        if (!e2) return true;
        for (let i = 0; i < indices.length; i++) {
          const a = pentagon[indices[i]], b = pentagon[indices[(i + 1) % indices.length]];
          if ((a === e2[0] && b === e2[1]) || (a === e2[1] && b === e2[0])) return true;
        }
        return false;
      };
      const chosen = splits.find(([triPart]) => containsE2(triPart)) ?? splits[0];
      builder.faces[slot] = chosen[1].map(index => pentagon[index]);
      builder.faces[step] = chosen[0].map(index => pentagon[index]);
      slot = step;
    }
    } catch (error) {
      // a pair that cannot meet (separate sheet components — a stand's ring against the main sheet's)
      // settles as two collapsed wedges instead
      if (builder.faces[slot]?.length === 3) toWedge(slot);
      if (builder.faces[targetSlot]?.length === 3) toWedge(targetSlot);
      notes.push(`a parity triangle pair settled as wedges (${(error as Error).message})`);
    }
  }
  builder.compact();
  notes.push(`${pairs.length} parity triangle pair(s) cancelled through the sheet`);
}

/**
 * Split every pinch vertex — one carrying more than two boundary edges — into one copy per boundary fan,
 * so the boundary walk stays manifold. The copies start coincident and separate during relaxation once
 * the join ring turns them interior.
 */
export function splitPinches(builder: Builder, notes: string[]): void {
  let split = 0;
  for (let guard = 0; guard < 8; guard++) {
    const edgeUse = new Map<string, number>();
    const keyOf = (a: number, b: number): string => a < b ? `${a},${b}` : `${b},${a}`;
    for (const face of builder.faces) for (let i = 0; i < face.length; i++) {
      const key = keyOf(face[i], face[(i + 1) % face.length]);
      edgeUse.set(key, (edgeUse.get(key) ?? 0) + 1);
    }
    const boundaryDegree = new Map<number, number>();
    for (const [key, count] of edgeUse) {
      if (count !== 1) continue;
      for (const id of key.split(',').map(Number)) {
        boundaryDegree.set(id, (boundaryDegree.get(id) ?? 0) + 1);
      }
    }
    const pinched = [...boundaryDegree].filter(([, degree]) => degree > 2).map(([id]) => id);
    if (!pinched.length) break;
    for (const vertex of pinched) {
      const incident = builder.faces
        .map((face, slot) => ({ face, slot }))
        .filter(({ face }) => face.includes(vertex));
      // fans: faces joined through interior edges at the vertex
      const parent = incident.map((_face, index) => index);
      const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a])));
      const byEdge = new Map<string, number[]>();
      incident.forEach(({ face }, index) => {
        for (const other of face) {
          if (other === vertex) continue;
          const key = keyOf(vertex, other);
          if ((edgeUse.get(key) ?? 0) === 2) {
            const list = byEdge.get(key);
            if (list) list.push(index); else byEdge.set(key, [index]);
          }
        }
      });
      for (const list of byEdge.values()) {
        if (list.length === 2) parent[find(list[0])] = find(list[1]);
      }
      const fans = new Map<number, number[]>();
      incident.forEach((_face, index) => {
        const root = find(index);
        const list = fans.get(root);
        if (list) list.push(index); else fans.set(root, [index]);
      });
      let first = true;
      for (const fan of fans.values()) {
        if (first) { first = false; continue; }
        const p = builder.vertices[vertex];
        const copy = builder.addVertex(p[0], p[1], p[2]);
        for (const index of fan) {
          const face = builder.faces[incident[index].slot];
          for (let i = 0; i < face.length; i++) if (face[i] === vertex) face[i] = copy;
        }
        split++;
      }
    }
  }
  if (split) notes.push(`${split} pinch vertex/vertices split into separate boundary fans`);
}

// ---- relaxation ------------------------------------------------------------------------------------------

/** Even out interior vertices with guarded Laplacian passes; boundary (target rim) vertices never move.
 *  Every repair move is bounded to local scale — an unbounded average or reflection near an already
 *  degenerate quad teleports vertices across the map. */
export function relaxInterior(
  builder: Builder, raster: Raster, fixed: Set<number>, iterations: number,
): number {
  const reach = raster.step * 8;
  const neighbors = new Map<number, Set<number>>();
  const vertexFaces = new Map<number, number[]>();
  builder.faces.forEach((face, slot) => {
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length];
      (neighbors.get(a) ?? neighbors.set(a, new Set()).get(a)!).add(b);
      (neighbors.get(b) ?? neighbors.set(b, new Set()).get(b)!).add(a);
      const list = vertexFaces.get(a);
      if (list) { if (!list.includes(slot)) list.push(slot); } else vertexFaces.set(a, [slot]);
    }
  });
  const shoelace = (face: number[]): number => {
    let area = 0;
    for (let i = 0; i < face.length; i++) {
      const p = builder.vertices[face[i]], q = builder.vertices[face[(i + 1) % face.length]];
      area += p[0] * q[2] - q[0] * p[2];
    }
    return area;
  };
  const moved = new Set<number>();
  // fold repair first: a knit against jagged composites can emit locally folded quads, and downstream
  // relaxation would otherwise drag them blindly (with no idea where the locked features are)
  for (let round = 0; round < 40; round++) {
    const foldedVertices = new Set<number>();
    builder.faces.forEach(face => {
      if (shoelace(face) >= 0) for (const id of face) if (!fixed.has(id)) foldedVertices.add(id);
    });
    if (!foldedVertices.size) break;
    for (const vertex of foldedVertices) {
      const around = neighbors.get(vertex);
      if (!around || around.size < 2) continue;
      let x = 0, z = 0;
      for (const other of around) { x += builder.vertices[other][0]; z += builder.vertices[other][2]; }
      x /= around.size; z /= around.size;
      const point = builder.vertices[vertex];
      if (Math.hypot(x - point[0], z - point[2]) > reach) continue;
      const previousClearance = bilinear(raster, raster.clearance, point[0], point[2]);
      const nextClearance = bilinear(raster, raster.clearance, x, z);
      if (!(nextClearance >= Math.min(previousClearance, raster.step))) continue;
      point[0] = x; point[2] = z;
      const y = bilinear(raster, raster.height, x, z);
      if (!Number.isNaN(y)) point[1] = y;
      moved.add(vertex);
    }
  }
  // a bowtie that Laplacian rounds cannot open point-reflects its twisted vertex through the midpoint of
  // its two perimeter neighbours (the trail flow sheet's untangler), guarded so neighbours stay open
  for (let round = 0; round < 3; round++) {
    let repaired = 0;
    for (const face of builder.faces) {
      if (shoelace(face) < 0) continue;
      for (let corner = 0; corner < face.length; corner++) {
        const vertex = face[corner];
        if (fixed.has(vertex)) continue;
        const previous = builder.vertices[face[(corner - 1 + face.length) % face.length]];
        const next = builder.vertices[face[(corner + 1) % face.length]];
        const point = builder.vertices[vertex];
        const incident = vertexFaces.get(vertex) ?? [];
        const wasFolded = incident.map(slot => shoelace(builder.faces[slot]) >= 0);
        const keepX = point[0], keepZ = point[2], keepY = point[1];
        const reflectedX = previous[0] + next[0] - point[0];
        const reflectedZ = previous[2] + next[2] - point[2];
        if (Math.hypot(reflectedX - keepX, reflectedZ - keepZ) > reach) continue;
        point[0] = reflectedX;
        point[2] = reflectedZ;
        const clearanceOk = bilinear(raster, raster.clearance, point[0], point[2])
          >= Math.min(bilinear(raster, raster.clearance, keepX, keepZ), raster.step);
        // the reflection must open THIS face and break no face that was healthy before
        const healthy = clearanceOk && shoelace(face) < 0
          && incident.every((slot, at) => wasFolded[at] || shoelace(builder.faces[slot]) < 0);
        if (!healthy) { point[0] = keepX; point[2] = keepZ; point[1] = keepY; continue; }
        const y = bilinear(raster, raster.height, point[0], point[2]);
        if (!Number.isNaN(y)) point[1] = y;
        moved.add(vertex);
        repaired++;
        break;
      }
    }
    if (!repaired) break;
  }
  for (let pass = 0; pass < iterations; pass++) {
    for (const [vertex, around] of neighbors) {
      if (fixed.has(vertex) || around.size < 3) continue;
      let x = 0, z = 0;
      for (const other of around) { x += builder.vertices[other][0]; z += builder.vertices[other][2]; }
      x /= around.size; z /= around.size;
      const point = builder.vertices[vertex];
      const nextX = point[0] + (x - point[0]) * .5, nextZ = point[2] + (z - point[2]) * .5;
      // a move may not fold a face and may not step onto less-covered ground than the vertex already
      // stands on — the second guard keeps the moat's ring vertices from drifting over a locked hole
      const previousX = point[0], previousZ = point[2];
      const previousClearance = bilinear(raster, raster.clearance, previousX, previousZ);
      const nextClearance = bilinear(raster, raster.clearance, nextX, nextZ);
      if (!(nextClearance >= Math.min(previousClearance, raster.step))) continue;
      point[0] = nextX; point[2] = nextZ;
      const folds = (vertexFaces.get(vertex) ?? []).some(slot => shoelace(builder.faces[slot]) >= 0);
      if (folds) { point[0] = previousX; point[2] = previousZ; continue; }
      const y = bilinear(raster, raster.height, nextX, nextZ);
      if (!Number.isNaN(y)) point[1] = y;
      moved.add(vertex);
    }
  }
  return moved.size;
}
