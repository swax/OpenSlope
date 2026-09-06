// tier: fast

/** Focused regression checks for the Mesa-derived two-patch trail generator. Run: `npx tsx test/trail.test.ts` */
import { cubicPoint, patchNormal } from '../src/core/math/bezier';
import { len, sub } from '../src/core/math/vec';
import {
  MESA_TRAIL_TEXTURES, applyTrailNetwork, applyTrailSpline, trimTrailSpline, type TrailCubic,
} from '../src/core/mesh/trail';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { quadIndices, quadNames } from '../src/app/state/mesh-names';
import { check, failures } from './check';

const near = (a: number, b: number, tolerance = 1e-7): boolean => Math.abs(a - b) <= tolerance;
const nearV3 = (a: V3, b: V3, tolerance = 1e-7): boolean => len(sub(a, b)) <= tolerance;

const emptyDoc = (): QuadMeshDoc => ({
  kind: 'mountain', version: 5, name: 'TRAIL TEST', spacing: 30,
  course: { knots: [], blend: 30, surface: 1 }, baseSurface: 1,
  vertices: [], vertexIds: [], quads: [], quadIds: [], nextId: 0,
});

const straight: TrailCubic = [
  [0, 0, 0], [0, 0, 100 / 3], [0, 0, 200 / 3], [0, 0, 100],
];

// A 100m line uses the Mesa 22.5m cap: five exact spans, three rails, and two patches per span.
{
  const source = emptyDoc(), before = JSON.stringify(source);
  const result = applyTrailSpline(source, [straight], { textures: MESA_TRAIL_TEXTURES });
  check(result.ok, 'straight: generator accepts a finite cubic');
  if (result.ok) {
    const selected = quadNames(result.doc, result.quads);
    check(selected.length === result.quads.length
      && quadIndices(result.doc, selected).join(',') === result.quads.join(','),
    'straight: every generated patch has a stable ID and resolves as the post-create selection');
    check(result.spans.length === 5, `straight: 100m is adaptively cut into five spans (${result.spans.length})`);
    check(result.stations.length === 6 && result.doc.vertices.length / 3 === 18,
      'straight: six stations append exactly three rail vertices each');
    check(result.doc.quads.length === 10 && result.quads.length === 10,
      'straight: two patch lanes are emitted per span');
    check(result.spans.every(span => span.lengthM <= 22.5 + 1e-5),
      'straight: every ordinary patch stays under the Mesa length cap');
    check(result.stations.every(station => near(len(sub(station.left, station.right)), 13, 1e-6)),
      'straight: rim-to-rim plan/surface width is 13m when unbanked');
    check(result.stations.every(station => near(station.left[1] - station.center[1], 1.365, 1e-9)
      && near(station.right[1] - station.center[1], 1.365, 1e-9)),
    'straight: the centre seam is dished 10.5% of width below both rims');
    check(result.spans.every(span => span.textures?.[0] === 'MESA/0044.png'
      && span.textures?.[1] === 'MESA/0045.png'),
    'straight: a held ordinary Mesa left/right tile pair covers the initial run');
    check(result.quads.every(quad => result.doc.quadPaint?.[quad] === 1
      && result.doc.quadOrient?.[quad]?.rot === 1 && result.doc.quadOrient?.[quad]?.mirror === false),
    'straight: generated patches are snow-painted and their Mesa tiles rotate into u-flow');
    const derived = meshFromDoc(result.doc);
    check(result.quads.every(quad => patchNormal(quadControlPoints(derived.mesh, derived.edgeHandle, quad), 0.5, 0.5)[1] > 0),
      'straight: both lanes have skyward patch winding');

    let worstExact = 0;
    result.spans.forEach((span, i) => {
      for (const u of [0, 0.17, 0.5, 0.83, 1]) {
        const actual = cubicPoint(span.center[0], span.center[1], span.center[2], span.center[3], u);
        const t = span.sourceT0 + (span.sourceT1 - span.sourceT0) * u;
        const expected = cubicPoint(straight[0], straight[1], straight[2], straight[3], t);
        worstExact = Math.max(worstExact, len(sub(actual, expected)));
      }
      const a = result.rails.center[i], b = result.rails.center[i + 1];
      check(nearV3(result.doc.edgeHandles?.[`${a}>${b}`] ?? [Infinity, 0, 0], sub(span.center[1], span.center[0]))
        && nearV3(result.doc.edgeHandles?.[`${b}>${a}`] ?? [Infinity, 0, 0], sub(span.center[2], span.center[3])),
      `straight: span ${i} writes both exact centre-edge handles`);
    });
    check(worstExact < 1e-9, `straight: every re-cut centre cubic remains on the source curve (worst ${worstExact})`);
    check(JSON.stringify(source) === before, 'straight: generation leaves its source document untouched');
  }
}

// A near-circular 50m-radius quarter turn is curvature-limited and receives the measured auto-bank + tight tiles.
{
  const k = 0.5522847498307936, radius = 50;
  const quarter: TrailCubic = [
    [radius, 0, 0], [radius, 0, k * radius], [k * radius, 0, radius], [0, 0, radius],
  ];
  const result = applyTrailSpline(emptyDoc(), [quarter], { textures: MESA_TRAIL_TEXTURES });
  check(result.ok, 'turn: generator accepts a quarter-circle cubic');
  if (result.ok) {
    check(result.spans.length === 4, `turn: 90 degrees is cut into four ~22.5-degree spans (${result.spans.length})`);
    check(result.spans.every(span => span.lengthM < 22.5 && span.radiusM > 45 && span.radiusM < 55),
      'turn: the cut respects length and recovers the approximately 50m radius');
    check(result.stations.every(station => station.bankDegrees < -15 && station.bankDegrees > -19),
      'turn: positive bank gain raises the outside rim at the expected ~16.7 degrees');
    check(result.spans.every(span => span.textures?.[0] === 'MESA/0066.png'
      && span.textures?.[1] === 'MESA/0064.png'),
    'turn: an R=50m run receives the blue tight-turn tile halves');
  }
}

// Bad spline topology is diagnosed before any document mutation.
{
  const discontinuous: TrailCubic = [[10, 0, 0], [10, 0, 10], [10, 0, 20], [10, 0, 30]];
  const result = applyTrailSpline(emptyDoc(), [straight, discontinuous]);
  check(!result.ok && /discontinuous/.test(result.error), 'validation: disconnected cubic segments are refused explicitly');
}

// Width, dish, lane balance, and authored bank interpolate independently of adaptive mesh density.
{
  const result = applyTrailSpline(emptyDoc(), [straight], {
    knotProfile: {
      widthM: [10, 20], dishFraction: [0, .1], centerBias: [.25, .75], bankDegrees: [0, 10],
    },
  });
  check(result.ok, 'knot profile: one value per construction-spline knot is accepted');
  if (result.ok) {
    const first = result.stations[0], last = result.stations[result.stations.length - 1];
    check(near(first.widthM, 10) && near(first.centerBias, .25) && near(first.bankDegrees, 0)
      && near(last.widthM, 20) && near(last.centerBias, .75) && near(last.bankDegrees, 10),
    'knot profile: width, lane balance, and explicit bank reach their endpoint values');
    check(near(len(sub(first.left, first.center)), 2.5) && near(len(sub(first.right, first.center)), 7.5),
      'knot profile: centre bias creates intentionally unequal patch lanes');
    check(near(last.dishM, 2), 'knot profile: dish remains a fraction of the interpolated width');
  }
  const invalid = applyTrailSpline(emptyDoc(), [straight], { knotProfile: { widthM: [10] } });
  check(!invalid.ok && /profile.*2 finite values/i.test(invalid.error),
    'knot profile: a value-count mismatch is refused explicitly');
}

// A turn carried at a cubic join still drives density even when each individual cubic is perfectly straight.
{
  const corner: TrailCubic[] = [
    [[0, 0, 0], [0, 0, 20 / 3], [0, 0, 40 / 3], [0, 0, 20]],
    [[0, 0, 20], [20 / 3, 0, 20], [40 / 3, 0, 20], [20, 0, 20]],
  ];
  const result = applyTrailSpline(emptyDoc(), corner, {
    widthM: 1, dishFraction: 0, bankGainM: 0,
    maxPatchLengthM: 100, minPatchLengthM: 6, maxTurnDegrees: 20,
  });
  check(result.ok && result.spans.length === 6,
    `join curvature: a 90-degree construction-knot turn shortens both neighboring cubics (${result.ok ? result.spans.length : result.error})`);
}

// ---- networks ---------------------------------------------------------------------------------------------

/** A straight chain of one cubic from `a` to `b`. */
const leg = (a: V3, b: V3): TrailCubic => [
  a, [a[0] + (b[0] - a[0]) / 3, a[1] + (b[1] - a[1]) / 3, a[2] + (b[2] - a[2]) / 3],
  [a[0] + (b[0] - a[0]) * 2 / 3, a[1] + (b[1] - a[1]) * 2 / 3, a[2] + (b[2] - a[2]) * 2 / 3], b,
];

// Exact re-cutting: trimming a chain leaves a shorter chain on the same curve, with its profile carried.
{
  const chain: TrailCubic[] = [leg([0, 0, 0], [0, 0, 100]), leg([0, 0, 100], [0, 0, 200])];
  const trimmed = trimTrailSpline(chain, { widthM: [10, 20, 30] }, 50, 50);
  check(!('error' in trimmed) && trimmed.spline.length >= 1, 'trim: a chain survives being cut at both ends');
  if (!('error' in trimmed)) {
    const head = trimmed.spline[0][0], tail = trimmed.spline[trimmed.spline.length - 1][3];
    check(nearV3(head, [0, 0, 50], 1e-6) && nearV3(tail, [0, 0, 150], 1e-6),
      `trim: the cut lands at the requested arc distance (${head[2].toFixed(3)}..${tail[2].toFixed(3)})`);
    const widths = trimmed.profile?.widthM ?? [];
    check(near(widths[0], 15, 1e-6) && near(widths[widths.length - 1], 25, 1e-6),
      `trim: the knot profile is re-sampled at the cuts (${widths.join(', ')})`);
    check(!('dishFraction' in (trimmed.profile ?? {})),
      'trim: a profile array that was never set does not appear');
  }
}

// A three-way junction: three trails meeting at the origin, knitted by one fan of six patches.
{
  const hub: V3 = [0, 0, 0];
  const spokes: V3[] = [[0, 0, -300], [260, 0, 150], [-260, 0, 150]];
  const result = applyTrailNetwork(emptyDoc(), spokes.map(tip => ({
    spline: [leg(hub, tip)], from: 0, to: undefined, options: { widthM: 40 },
  })), { dishFraction: 0, bankGainM: 0, maxPatchLengthM: 40, minPatchLengthM: 12, maxTurnDegrees: 30 });

  check(result.ok, `network: a three-way fork is accepted (${result.ok ? '' : result.error})`);
  if (result.ok) {
    check(result.junctions.length === 1 && result.junctions[0].quads.length === 6,
      `network: one junction of six patches (${result.junctions.length}, `
      + `${result.junctions[0]?.quads.length})`);
    check(result.runs.length === 3, `network: three ribbons (${result.runs.length})`);

    // Every patch must wind the same way, or the fan was knitted inside out.
    const area = (corners: readonly number[]): number => {
      const ring = [corners[0], corners[1], corners[3], corners[2]];
      let sum = 0;
      for (let i = 0; i < 4; i++) {
        const p = ring[i] * 3, q = ring[(i + 1) % 4] * 3;
        sum += result.doc.vertices[p] * result.doc.vertices[q + 2]
          - result.doc.vertices[q] * result.doc.vertices[p + 2];
      }
      return sum / 2;
    };
    const signs = new Set(result.doc.quads.map(corners => Math.sign(area(corners))));
    check(signs.size === 1, `network: every patch winds the same way (${[...signs].join(', ')})`);

    // The fan's rim vertices are the ribbons' own, so the network is one surface, not three plus a lid.
    const shared = result.junctions[0].quads
      .flatMap(quad => result.doc.quads[quad])
      .filter(v => result.runs.some(run => run.rails.center.includes(v)));
    check(shared.length === 3, `network: the fan is sewn to each ribbon's seam (${shared.length})`);

    // Each trail stopped short of the hub by the fan's reach, and no further.
    const reach = result.junctions[0].reachM;
    const gaps = result.runs.map(run => {
      const seam = run.rails.center[0] * 3;
      return Math.hypot(result.doc.vertices[seam], result.doc.vertices[seam + 2]);
    });
    check(gaps.every(g => Math.abs(g - reach) < 1.5),
      `network: every trail stops ${reach.toFixed(0)} m short of the junction `
      + `(${gaps.map(g => g.toFixed(0)).join(', ')})`);
  }
}

// A fork too shallow to knit is refused by name rather than knitted into overlapping ribbons.
{
  const result = applyTrailNetwork(emptyDoc(), [
    { spline: [leg([0, 0, 0], [0, 0, -400])], from: 0 },
    { spline: [leg([0, 0, 0], [20, 0, 400])], from: 0 },
    { spline: [leg([0, 0, 0], [-14, 0, 400])], from: 0 },
  ], { widthM: 40, dishFraction: 0, bankGainM: 0, maxJunctionReachM: 140 });
  check(!result.ok && /still leave it \d+° apart/.test(result.error),
    `network: a fork that cannot be knitted says so (${result.ok ? 'accepted' : result.error})`);
}

console.log(failures ? '\nTRAIL: FAIL' : '\nTRAIL: PASS');
process.exit(failures ? 1 : 0);
