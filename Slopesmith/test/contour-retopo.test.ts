/**
 * Contour-flow retopology: the candidate generator on synthetic terrain, and the whole job pipeline
 * (generation, direct conforming join, surface fit, validation gates) on a bicubic mountain document.
 * Run: `npx tsx test/contour-retopo.test.ts`
 */
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import type { InterfaceCurve } from '../src/core/mesh/retopology/benchmark';
import type { PolygonMesh } from '../src/core/mesh/retopology/obj';
import { buildContourCandidate } from '../src/core/mesh/retopology/contour';
import { boundaryLoops } from '../src/core/mesh/retopology/prescribe';
import {
  createRetopologyJob, retopologyCapabilities, retopologyJobResult, retopologyJobStatus,
} from '../src/server/retopology/jobs';
import { check, failures, recordFailure } from './check';

// ---- synthetic candidate fixtures ------------------------------------------------------------------------

const SIZE = 600, SPACING = 25;
const N = SIZE / SPACING;

type HeightFn = (x: number, z: number) => number;

/** Triangulated heightfield with locked quads removed, plus the interface curves along the locked rims. */
function makeInput(heightAt: HeightFn, lockedQuad: (qx: number, qz: number) => boolean) {
  const vertexAt = new Map<string, number>();
  const vertices: V3[] = [];
  const vid = (ix: number, iz: number): number => {
    const key = `${ix},${iz}`;
    let found = vertexAt.get(key);
    if (found === undefined) {
      found = vertices.length;
      const x = ix * SPACING, z = iz * SPACING;
      vertices.push([x, heightAt(x, z), z]);
      vertexAt.set(key, found);
    }
    return found;
  };
  const faces: number[][] = [];
  const lockedEdges: [number, number][] = [];
  for (let qz = 0; qz < N; qz++) for (let qx = 0; qx < N; qx++) {
    if (lockedQuad(qx, qz)) continue;
    const a = vid(qx, qz), b = vid(qx, qz + 1), c = vid(qx + 1, qz), d = vid(qx + 1, qz + 1);
    faces.push([a, d, c], [a, b, d]);
    const neighbours: [number, number, [number, number]][] = [
      [qx - 1, qz, [a, b]], [qx + 1, qz, [c, d]], [qx, qz - 1, [a, c]], [qx, qz + 1, [b, d]],
    ];
    for (const [nx, nz, edge] of neighbours) {
      if (nx >= 0 && nx < N && nz >= 0 && nz < N && lockedQuad(nx, nz)) lockedEdges.push(edge);
    }
  }
  const proxy: PolygonMesh = { vertices, faces };
  const interfaceCurves: InterfaceCurve[] = lockedEdges.map(([a, b], index) => {
    const pa = vertices[a], pb = vertices[b];
    const samples: V3[] = Array.from({ length: 9 }, (_ignored, i) => {
      const t = i / 8;
      return [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t] as V3;
    });
    return { edgeVertexIds: [`v${a}_${index}`, `v${b}_${index}`], samples };
  });
  return { surface: proxy, boundaryProxy: proxy, interfaceCurves };
}

function checkCandidate(
  name: string,
  heightAt: HeightFn,
  lockedQuad: (qx: number, qz: number) => boolean,
  lockedRect: [number, number, number, number],
): void {
  const input = makeInput(heightAt, lockedQuad);
  try {
    const result = buildContourCandidate({ ...input, targetPatchSizeM: SPACING });
    const { mesh } = result;
    check(!result.notes.some(note => note.startsWith('JOIN FAILURE')), `${name}: no join failures`);
    check(mesh.faces.every(face => face.length === 4 && new Set(face).size === 4), `${name}: all quads`);
    const folded = mesh.faces.filter(face => {
      let area = 0;
      for (let i = 0; i < 4; i++) {
        const p = mesh.vertices[face[i]], q = mesh.vertices[face[(i + 1) % 4]];
        area += p[0] * q[2] - q[0] * p[2];
      }
      return area >= 0;
    });
    // a handful of shallow bowties near join bays is acceptable at candidate level: integration's own
    // guarded relaxation opens them, and its inverted-patch gate (checked by the pipeline test) is zero
    check(folded.length <= 8, `${name}: at most a few shallow folds (${folded.length})`);
    const candidateLoops = boundaryLoops(mesh);
    check(candidateLoops.length === boundaryLoops(input.boundaryProxy).length,
      `${name}: boundary loop count matches the region`);
    // conforming: every authored rim corner appears among the candidate's boundary vertices
    const boundaryPositions = new Set(candidateLoops.flat()
      .map(v => mesh.vertices[v].map(value => value.toFixed(2)).join(',')));
    check(input.interfaceCurves.every(curve =>
      boundaryPositions.has(curve.samples[0].map(value => value.toFixed(2)).join(','))),
    `${name}: locked rim corners all on the candidate boundary`);
    const [x0, z0, x1, z1] = lockedRect;
    const paved = mesh.faces.filter(face => {
      let cx = 0, cz = 0;
      for (const v of face) { cx += mesh.vertices[v][0]; cz += mesh.vertices[v][2]; }
      cx /= face.length; cz /= face.length;
      return cx > x0 + 6 && cx < x1 - 6 && cz > z0 + 6 && cz < z1 - 6;
    });
    check(paved.length === 0, `${name}: no quads paved over the locked hole`);
  } catch (error) {
    recordFailure();
    console.log(`FAIL  ${name}: ${(error as Error).message}`);
  }
}

checkCandidate('cone',
  (x, z) => Math.max(0, 180 - 0.5 * Math.hypot(x - 300, z - 300)),
  (qx, qz) => qx >= 4 && qx <= 7 && qz >= 10 && qz <= 12,
  [100, 250, 200, 325]);

checkCandidate('saddle',
  (x, z) => Math.max(
    Math.max(0, 170 - 0.55 * Math.hypot(x - 180, z - 300)),
    Math.max(0, 190 - 0.55 * Math.hypot(x - 430, z - 300))),
  (qx, qz) => qx >= 6 && qx <= 8 && qz >= 6 && qz <= 8,
  [150, 150, 225, 225]);

checkCandidate('pit',
  (x, z) => 0.3 * x + 0.1 * z + Math.min(0, -60 + 0.5 * Math.hypot(x - 400, z - 400)),
  (qx, qz) => qx >= 5 && qx <= 6 && qz >= 13 && qz <= 14,
  [125, 325, 175, 375]);

// ---- the whole job pipeline ------------------------------------------------------------------------------

const capabilities = retopologyCapabilities();
check(capabilities.strategies.some(entry => entry.id === 'contour-flow' && entry.available
  && entry.scopes.join() === 'whole-unlocked'),
'capabilities offer the contour-flow strategy for whole-mountain scope without a native install');
check(capabilities.available, 'a server without QuadWild still reports retopology available');

/** A bicubic mountain document: a cone heightfield over a grid, with one locked block mid-slope. */
function mountainDoc(): QuadMeshDoc {
  const side = 16, spacing = 30;
  const vertices: number[] = [];
  for (let row = 0; row <= side; row++) for (let col = 0; col <= side; col++) {
    const x = col * spacing, z = row * spacing;
    vertices.push(x, Math.max(0, 200 - 0.5 * Math.hypot(x - 240, z - 240)), z);
  }
  const quads: number[][] = [];
  const quadLocked: Record<number, true> = {};
  for (let row = 0; row < side; row++) for (let col = 0; col < side; col++) {
    const A = row * (side + 1) + col, B = A + 1, C = A + side + 1, D = C + 1;
    // doc quads are [A, B, C, D] with B along +X and C along +Z of A. The locked block stands the
    // supported distance off every other rim (production trail generators guarantee 2.5 patches);
    // strips narrower than that are the documented narrow-neck limitation of both strategies.
    quads.push([A, B, C, D]);
    if (col >= 5 && col <= 8 && row >= 9 && row <= 11) quadLocked[quads.length - 1] = true;
  }
  // a real locked feature's rim edges carry chord creases (the trail sheet straightens its seams so a
  // rendered bow cannot cross a neighbour); an uncreased Bessel rim on a cone would bulge outward at the
  // block's corners and overlap any conforming neighbour
  const edgeHandles: Record<string, [number, number, number]> = {};
  const lockedSet = new Set(Object.keys(quadLocked).map(Number));
  const edgeCount = new Map<string, number>();
  quads.forEach((quad, index) => {
    if (!lockedSet.has(index)) return;
    const [A, B, C, D] = quad;
    for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as const) {
      edgeCount.set(a < b ? `${a},${b}` : `${b},${a}`, 1);
    }
  });
  quads.forEach((quad, index) => {
    if (lockedSet.has(index)) return;
    const [A, B, C, D] = quad;
    for (const [a, b] of [[A, B], [B, D], [D, C], [C, A]] as const) {
      if (!edgeCount.has(a < b ? `${a},${b}` : `${b},${a}`)) continue;
      const dx = vertices[b * 3] - vertices[a * 3];
      const dy = vertices[b * 3 + 1] - vertices[a * 3 + 1];
      const dz = vertices[b * 3 + 2] - vertices[a * 3 + 2];
      edgeHandles[`${a}>${b}`] = [dx / 3, dy / 3, dz / 3];
      edgeHandles[`${b}>${a}`] = [-dx / 3, -dy / 3, -dz / 3];
    }
  });
  return {
    kind: 'mountain', version: 5, name: 'CONTOUR FIXTURE', spacing,
    course: { knots: [], blend: 1, surface: 1 }, baseSurface: 1,
    vertices,
    vertexIds: Array.from({ length: (side + 1) ** 2 }, (_ignored, i) => `v:${i}`),
    quads,
    quadIds: Array.from({ length: side * side }, (_ignored, i) => `q:${i}`),
    nextId: (side + 1) ** 2 + side * side,
    quadLocked,
    edgeHandles,
  };
}

const doc = mountainDoc();
const job = createRetopologyJob(doc, {
  scope: 'whole-unlocked',
  strategy: 'contour-flow',
  targetPatchSizeM: 30,
  preserveSurfacePaint: true,
});
for (;;) {
  const status = retopologyJobStatus(job.id);
  if (!status) throw new Error('the contour job vanished');
  if (status.phase === 'complete' || status.phase === 'failed' || status.phase === 'cancelled') {
    check(status.phase === 'complete', `pipeline: job completes (${status.phase}${status.error ? `: ${status.error}` : ''})`);
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 200));
}
const result = retopologyJobResult(job.id);
if (result) {
  const { summary } = result;
  check(summary.connectedComponents === 1, 'pipeline: one connected mountain');
  check(summary.tJunctions === 0, 'pipeline: the conforming join leaves no T-junctions');
  check(summary.invertedPatches === 0, 'pipeline: no inverted patches');
  check(summary.lockedPatches === Object.keys(doc.quadLocked ?? {}).length
    && summary.protectedPatches === summary.lockedPatches,
  'pipeline: every locked patch survives exactly');
  check(summary.generatedPatches > 100, `pipeline: a real generated cage (${summary.generatedPatches} patches)`);
  check((summary.surfaceDeviationM.symmetricMax ?? Infinity) < 25,
    `pipeline: surface deviation inside the gate (${summary.surfaceDeviationM.symmetricMax?.toFixed(2)} m)`);
  console.log(`      ${summary.generatedPatches} generated + ${summary.protectedPatches} exact, `
    + `aspect p95 ${summary.cageAspectRatio.p95.toFixed(2)}, `
    + `deviation max ${summary.surfaceDeviationM.symmetricMax?.toFixed(2)} m`);
} else {
  recordFailure();
  console.log('FAIL  pipeline: no result document');
}

process.exit(failures ? 1 : 0);
