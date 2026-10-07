// tier: fast

/** Focused regression checks for the Mesa-derived trail generator, two patches wide and more. Run: `npx tsx test/trail.test.ts` */
import { cubicPoint, patchNormal } from '../src/core/math/bezier';
import { len, sub } from '../src/core/math/vec';
import {
  applyTrailNetwork, applyTrailSpline, trailStationLanes, trimTrailSpline, type TrailCubic, type TrailLaneTiles, type TrailTiling,
} from '../src/core/mesh/trail';
import { orientUV } from '../src/core/paint/orientation';
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

/** Mesa's matched halves along a trail, its blue stripes through left turns and its red through right ones. */
const MESA_TILES: TrailTiling = {
  trail: { left: 'MESA/0045.png', right: 'MESA/0044.png', quarterTurns: 0 },
  leftTurn: { left: 'MESA/0064.png', right: 'MESA/0066.png', quarterTurns: 2 },
  rightTurn: { left: 'MESA/0063.png', right: 'MESA/0062.png', quarterTurns: 0 },
  turnRadiusM: 80,
};

const straight: TrailCubic = [
  [0, 0, 0], [0, 0, 100 / 3], [0, 0, 200 / 3], [0, 0, 100],
];

// A 100m line uses the Mesa 22.5m cap: five exact spans, three rails, and two patches per span.
{
  const source = emptyDoc(), before = JSON.stringify(source);
  const result = applyTrailSpline(source, [straight], { textures: MESA_TILES });
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
      const a = result.sections[i][1], b = result.sections[i + 1][1];
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
  const result = applyTrailSpline(emptyDoc(), [quarter], { textures: MESA_TILES });
  check(result.ok, 'turn: generator accepts a quarter-circle cubic');
  if (result.ok) {
    check(result.spans.length === 4, `turn: 90 degrees is cut into four ~22.5-degree spans (${result.spans.length})`);
    check(result.spans.every(span => span.lengthM < 22.5 && span.radiusM > 45 && span.radiusM < 55),
      'turn: the cut respects length and recovers the approximately 50m radius');
    check(result.stations.every(station => station.bankDegrees < -15 && station.bankDegrees > -19),
      'turn: positive bank gain raises the outside rim at the expected ~16.7 degrees');
    // Heading +Z and bending toward -X is a turn to a rider's left: data space is the game's left-handed frame.
    check(result.spans.every(span => span.signedCurvature > 0 && span.textures?.[0] === 'MESA/0066.png'
      && span.textures?.[1] === 'MESA/0064.png'),
    'turn: an R=50m left turn wears the left-turn pair, its right half on the span’s first patch');
    check(result.spans.every(span => span.textureOrient?.rot === 3 && !span.textureOrient.mirror),
      'turn: the tight halves are worn half a turn round from the standard ones');
  }
  // The same turn the other way: heading +Z and bending toward +X, to a rider's right.
  const mirrored = applyTrailSpline(emptyDoc(), [quarter.map(([x, y, z]) => [-x, y, z] as V3) as unknown as TrailCubic], { textures: MESA_TILES });
  check(mirrored.ok && mirrored.spans.every(span => span.signedCurvature < 0 && span.textures?.[0] === 'MESA/0062.png'
    && span.textures?.[1] === 'MESA/0063.png' && span.textureOrient?.rot === 1),
  'turn: a right turn wears the right-turn pair — Mesa’s stripes turned round');
  const leftOnly = applyTrailSpline(emptyDoc(), [quarter.map(([x, y, z]) => [-x, y, z] as V3) as unknown as TrailCubic],
    { textures: { ...MESA_TILES, rightTurn: null } });
  check(leftOnly.ok && leftOnly.spans.every(span => span.textures?.[0] === 'MESA/0044.png'),
    'turn: a turn with no pair of its own wears the trail pair');
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

// A three-way junction: three trails meeting at the origin, their six lanes carried on round a six-way hub.
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

    // Every lane carries on into the junction: each patch is one lane's end edge — its ribbon's seam and one rim
    // at the end station — taken on to the hub and to a crotch. Each seam runs into the hub between its two lanes.
    const junction = result.junctions[0];
    const hub = junction.center!;
    const ends = result.runs.map(run => ({ seam: run.sections[0][1], rims: [run.sections[0][0], run.sections[0][2]] }));
    const crotches = new Set<number>();
    const lanes = junction.quads.map(quad => {
      const corners = result.doc.quads[quad];
      const end = ends.find(e => corners.includes(e.seam));
      const rim = end?.rims.find(r => corners.includes(r));
      const crotch = corners.find(v => v !== hub && v !== end?.seam && v !== rim);
      if (crotch !== undefined) crotches.add(crotch);
      return !!end && rim !== undefined && corners.includes(hub) && crotch !== undefined;
    });
    check(lanes.every(Boolean) && crotches.size === 3,
      `network: each of the six patches carries one lane on to the hub and a crotch (${lanes.join()}, ${crotches.size} crotches)`);
    const hubEdges = new Set(junction.quads.flatMap(quad => {
      const [a, b, c, d] = result.doc.quads[quad];
      return [[a, b], [b, d], [d, c], [c, a]].filter(edge => edge.includes(hub)).map(edge => edge[0] === hub ? edge[1] : edge[0]);
    }));
    check(hubEdges.size === 6 && ends.every(e => hubEdges.has(e.seam)) && [...crotches].every(c => hubEdges.has(c)),
      'network: the hub is a six-pole — three seams run into it, and three spokes run out to the crotches');
    // A crotch is where the facing rims meet: on the line of each of the two rims it joins.
    const v = (i: number) => [result.doc.vertices[i * 3], result.doc.vertices[i * 3 + 2]];
    const onRim = (crotch: number, run: typeof result.runs[number], side: 'left' | 'right') => {
      const k = side === 'left' ? 0 : run.sections[0].length - 1;
      const [px, pz] = v(crotch), [ax, az] = v(run.sections[0][k]), [bx, bz] = v(run.sections[1][k]);
      const cross = (bx - ax) * (pz - az) - (bz - az) * (px - ax);
      return Math.abs(cross) / Math.hypot(bx - ax, bz - az) < 0.05;
    };
    check([...crotches].every(c => result.runs.filter(run => onRim(c, run, 'left') || onRim(c, run, 'right')).length === 2),
      'network: each crotch sits on both rims it joins');

    // Each trail stopped short of the hub by the fan's reach, and no further.
    const reach = result.junctions[0].reachM;
    const gaps = result.runs.map(run => {
      const seam = run.sections[0][1] * 3;
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

// ---- lanes ------------------------------------------------------------------------------------------------

/** A set with a middle tile, and one without. */
const SET: TrailLaneTiles = { left: 'T/L.png', middle: 'T/M.png', right: 'T/R.png' };
const EDGES: TrailLaneTiles = { left: 'T/L.png', right: 'T/R.png' };

/** Every patch's signed plan area, walking A→B→D→C. */
const planArea = (doc: QuadMeshDoc, corners: readonly number[]): number => {
  const ring = [corners[0], corners[1], corners[3], corners[2]];
  let sum = 0;
  for (let i = 0; i < 4; i++) {
    const p = ring[i] * 3, q = ring[(i + 1) % 4] * 3;
    sum += doc.vertices[p] * doc.vertices[q + 2] - doc.vertices[q] * doc.vertices[p + 2];
  }
  return sum / 2;
};

/** A patch's sides, a wedge's collapsed one left out. */
const sides = ([a, b, c, d]: readonly number[]) => [[a, b], [b, d], [d, c], [c, a]].filter(([x, y]) => x !== y);

/** V − E + F of a mesh: 1 for one disk. */
const euler = (doc: QuadMeshDoc): number => {
  const edges = new Set<string>();
  for (const corners of doc.quads) for (const [x, y] of sides(corners)) edges.add(x < y ? `${x},${y}` : `${y},${x}`);
  return doc.vertices.length / 3 - edges.size + doc.quads.length;
};

/** How many patches each edge borders: an interior edge two, a boundary edge one. */
const edgeUse = (doc: QuadMeshDoc, quads: readonly number[]): Map<string, number> => {
  const use = new Map<string, number>();
  for (const quad of quads) {
    for (const [x, y] of sides(doc.quads[quad])) {
      const key = x < y ? `${x},${y}` : `${y},${x}`;
      use.set(key, (use.get(key) ?? 0) + 1);
    }
  }
  return use;
};

// Three lanes: four rails sharing the width evenly, the edge lanes wearing the set's edges and the middle its middle.
{
  const result = applyTrailSpline(emptyDoc(), [straight], { lanes: 3, textures: { trail: SET } });
  check(result.ok, `lanes: a three-lane trail is cut (${result.ok ? '' : result.error})`);
  if (result.ok) {
    check(result.sections.every(section => section.length === 4) && result.doc.vertices.length / 3 === 24 && result.quads.length === 15,
      'lanes: three lanes are four rails a station and three patches a span');
    const station = result.stations[0];
    const across = station.rails.map(p => p[0]);
    // Heading +Z the generator's right is -X.
    check(across.every((x, k) => near(x, 6.5 - (13 * k) / 3, 1e-9)), `lanes: the rails share 13 m evenly (${across.map(x => x.toFixed(2)).join(', ')})`);
    // The dish is a parabola across the lanes: rims 1.365 m up, the inner rails a ninth of that.
    check(near(station.rails[0][1], 1.365, 1e-9) && near(station.rails[1][1], 1.365 / 9, 1e-9) && near(station.rails[3][1], 1.365, 1e-9),
      'lanes: the dish curves across the lanes');
    check(result.spans.every(span => span.textures?.join() === 'T/R.png,T/M.png,T/L.png'),
      'lanes: the rider’s right edge, the middle, then the rider’s left, from the generator’s left rail');
    check(!Object.keys(result.doc.edgeHandles ?? {}).length, 'lanes: an odd count puts the spline on no rail, so no seam handles');
    const derived = meshFromDoc(result.doc);
    check(result.quads.every(quad => patchNormal(quadControlPoints(derived.mesh, derived.edgeHandle, quad), 0.5, 0.5)[1] > 0),
      'lanes: every lane winds skyward');
  }
  const bare = applyTrailSpline(emptyDoc(), [straight], { lanes: 3, textures: { trail: EDGES } });
  check(bare.ok && bare.spans.every(span => span.textures?.join() === 'T/R.png,,T/L.png')
    && bare.quads.filter(quad => bare.doc.quadTex?.[quad]).length === 10,
  'lanes: a set without a middle leaves the middle lane plain');
}

// Four lanes off centre: each side's two lanes share its side, and the spline's rail carries the exact handles.
{
  const result = applyTrailSpline(emptyDoc(), [straight], { lanes: 4, widthM: 20, centerBias: 0.25 });
  check(result.ok, 'lanes: a four-lane trail is cut');
  if (result.ok) {
    const across = result.stations[0].rails.map(p => p[0]);
    check([5, 2.5, 0, -7.5, -15].every((x, k) => near(across[k], x, 1e-9)), `lanes: the bias splits the width at the spline (${across.join(', ')})`);
    const [a, b] = [result.sections[0][2], result.sections[1][2]];
    check(nearV3(result.doc.edgeHandles?.[`${a}>${b}`] ?? [Infinity, 0, 0], sub(result.spans[0].center[1], result.spans[0].center[0])),
      'lanes: the middle rail of an even count is the seam, with its exact handles');
  }
}

// One lane: a single patch a span, wearing the middle tile.
{
  const result = applyTrailSpline(emptyDoc(), [straight], { lanes: 1, textures: { trail: SET } });
  check(result.ok && result.quads.length === 5 && result.sections[0].length === 2
    && result.quads.every(quad => result.doc.quadTex?.[quad] === 'T/M.png'),
  'lanes: one lane is a patch a span, wearing the middle tile');
  const wide = applyTrailSpline(emptyDoc(), [straight], { lanes: 13 });
  check(!wide.ok && /1 to 12 patches/.test(wide.error), 'lanes: past the most lanes is refused');
}

// The lanes a run changes through to meet its ends: a lane a span from each end, or faster when it is short.
check(trailStationLanes(6, 6, [2, 6]).join() === '2,3,4,5,6,6,6' && trailStationLanes(6, 4, [2, 2]).join() === '2,3,4,4,4,3,2'
  && trailStationLanes(3, 6, [2, 2]).join() === '2,4,4,2' && trailStationLanes(2, 6, [2, 6]).join() === '2,4,6'
  && trailStationLanes(3, 1, [2, 1]).join() === '2,1,1,1' && trailStationLanes(4, 3).join() === '3,3,3,3,3',
'taper: a lane a span toward its own width, faster where the run is short, and nowhere it meets its own');

// A ribbon narrowing: the middle lanes end in wedges to a point, the edge lanes run on with their tiles.
{
  const result = applyTrailSpline(emptyDoc(), [straight], { lanes: 4, laneEnds: [4, 2], textures: { trail: SET } });
  check(result.ok, `taper: a four-lane ribbon narrows to two (${result.ok ? '' : result.error})`);
  if (result.ok) {
    check(result.sections.map(section => section.length - 1).join() === '4,4,4,4,3,2' && result.quads.length === 4 * 4 + 3,
      'taper: four lanes to two over its last two spans, a patch for each lane at a span’s wider end', result.sections.map(s => s.length - 1).join());
    const wedges = result.quads.filter(quad => result.doc.quads[quad][2] === result.doc.quads[quad][3]);
    check(wedges.length === 2 && wedges.every(quad => result.doc.quadTex?.[quad] === 'T/M.png'),
      'taper: a middle lane ends in a wedge each span, wearing the middle tile');
    check(result.spans.every(span => span.textures?.[0] === 'T/R.png' && span.textures.at(-1) === 'T/L.png'),
      'taper: the edge lanes wear their tiles all the way');
    const derived = meshFromDoc(result.doc);
    check(result.quads.every(quad => patchNormal(quadControlPoints(derived.mesh, derived.edgeHandle, quad), 0.5, 0.5)[1] > 0.5),
      'taper: every patch, the wedges too, faces the sky');
    check(Object.keys(result.doc.edgeHandles ?? {}).length === 2 * 3, 'taper: the seam keeps its exact handles where it stays even and as wide');
  }
  const widening = applyTrailSpline(emptyDoc(), [straight], { lanes: 3, laneEnds: [1, 3], textures: { trail: SET } });
  check(widening.ok && widening.sections.map(section => section.length - 1).join() === '1,2,3,3,3,3'
    && widening.quads.filter(quad => widening.doc.quads[quad][2] === widening.doc.quads[quad][3]).length === 2
    && new Set(widening.doc.quads.map(corners => Math.sign(planArea(widening.doc, corners)))).size === 1,
  'taper: widening, the new lanes begin in wedges pointing back, wound as the rest');
}

// A fork of three, two and four lanes: each run narrows to two lanes over its last spans, so the hub is the ordinary
// six-pole, and the whole network is one disk of patches, all wound one way.
{
  const spokes: V3[] = [[0, 0, -300], [260, 0, 150], [-260, 0, 150]];
  const lanes = [3, 2, 4];
  const result = applyTrailNetwork(emptyDoc(), spokes.map((tip, i) => ({
    spline: [leg([0, 0, 0], tip)], from: 0, options: { widthM: 40, lanes: lanes[i], textures: { trail: SET } },
  })), { dishFraction: 0, bankGainM: 0, maxPatchLengthM: 40, minPatchLengthM: 12, maxTurnDegrees: 30 });
  check(result.ok, `lane fork: three, two and four lanes meet (${result.ok ? '' : result.error})`);
  if (result.ok) {
    const junction = result.junctions[0];
    check(junction.quads.length === 6 && junction.vertices.length === 4,
      `lane fork: six patches and four new points, as for two-lane paths (${junction.quads.length}, ${junction.vertices.length})`);
    check(result.runs.map(run => run.sections.slice(0, 3).map(section => section.length - 1).join('')).join() === '233,222,234',
      'lane fork: the three-lane path narrows over one span, the four-lane over two',
      result.runs.map(run => run.sections.map(section => section.length - 1).join('')).join(' '));
    const wedges = result.doc.quads.filter(corners => corners[2] === corners[3]);
    check(wedges.length === 3 && !junction.quads.some(quad => result.doc.quads[quad][2] === result.doc.quads[quad][3]),
      `lane fork: a wedge for every lane dropped, none in the junction (${wedges.length})`);
    const signs = new Set(result.doc.quads.map(corners => Math.sign(planArea(result.doc, corners))));
    check(signs.size === 1, `lane fork: every patch winds the same way (${[...signs].join(', ')})`);
    const derived = meshFromDoc(result.doc);
    check(result.doc.quads.every((_, quad) => [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25]].every(([u, v]) =>
      patchNormal(quadControlPoints(derived.mesh, derived.edgeHandle, quad), u, v)[1] > 0.5)),
    'lane fork: every patch, wedges and junction too, faces the sky');
    check(euler(result.doc) === 1, `lane fork: the network is one disk (χ ${euler(result.doc)})`);
    const use = edgeUse(result.doc, result.doc.quads.map((_, i) => i));
    check([...use.values()].every(n => n <= 2), 'lane fork: no edge borders more than two patches');
    const hubRing = [...use].filter(([key]) => key.split(',').map(Number).includes(junction.center!));
    check(hubRing.length === 6 && hubRing.every(([, n]) => n === 2), `lane fork: the hub is a closed six-pole, two lanes in and out an arm (${hubRing.length})`);
    // The edge lanes wear their tiles on into the junction.
    const worn = junction.quads.map(quad => result.doc.quadTex?.[quad]?.[2]).join('');
    check(worn === 'RLRLRL', `lane fork: the junction wears the edge tiles (${worn})`);
  }
}

// A straight path split in two: its lanes run straight on across the split line — a point a rail, abeam the split; one
// lane wide, the two lanes share an edge there. Of two widths, the wider narrows to the narrower over its last spans.
for (const [a, b, patches] of [[4, 4, 8], [3, 3, 6], [1, 1, 2], [2, 3, 4], [4, 6, 8]]) {
  const result = applyTrailNetwork(emptyDoc(), [
    { spline: [leg([0, 0, -200], [0, 0, 0])], to: 0, options: { lanes: a } },
    { spline: [leg([0, 0, 0], [0, 0, 200])], from: 0, options: { lanes: b } },
  ], { dishFraction: 0, bankGainM: 0 });
  const joint = result.ok ? result.junctions[0] : null;
  check(result.ok && euler(result.doc) === 1 && joint!.quads.length === patches
    && new Set(result.doc.quads.map(corners => Math.sign(planArea(result.doc, corners)))).size === 1,
  `lane joint: ${a} lanes meeting ${b} knit one disk of ${patches} (${result.ok ? joint!.quads.length : result.error})`);
  if (!result.ok) continue;
  const n = Math.min(a, b);
  if (a !== b) {
    check(result.runs[1].sections.slice(0, b - a + 2).map(section => section.length - 1).join() === Array.from({ length: b - a + 2 }, (_, k) => Math.min(b, a + k)).join(),
      `lane joint: the ${b}-lane piece narrows to ${a} a lane a span`);
  }
  const line = joint!.vertices.map(v => result.doc.vertices.slice(v * 3, v * 3 + 3) as V3);
  check(line.length === n + 1 && line.every(p => Math.abs(p[2]) < 1e-9)
    && [...line.map(p => p[0])].sort((x, y) => x - y).every((x, k) => near(x, -6.5 + (13 * k) / n, 1e-9)),
  `lane joint: ${n} lanes cross the split line at ${n + 1} points, a rail’s each`, line.map(p => p[0].toFixed(2)).join(' '));
  check(joint!.center === (n % 2 ? null : joint!.vertices.find(v => Math.abs(result.doc.vertices[v * 3]) < 1e-9)),
    `lane joint: ${n % 2 ? 'an odd count has no hub' : 'the hub is the seam’s point on the line'}`);
}

// ---- caps ---------------------------------------------------------------------------------------------------

// A capped end is a square span, as long as a lane is wide, wearing the cap: as given at the last point, turned round
// at the first — where travelling out to the end is going back along the path.
{
  const CAP: TrailLaneTiles = { left: 'C/L.png', right: 'C/R.png', quarterTurns: 2 };
  const result = applyTrailSpline(emptyDoc(), [straight], { caps: { start: true, end: true }, textures: { trail: EDGES, cap: CAP } });
  check(result.ok, `caps: a trail capped at both ends cuts (${result.ok ? '' : result.error})`);
  if (result.ok) {
    const [first, last] = [result.spans[0], result.spans.at(-1)!];
    check(first.cap === 'start' && last.cap === 'end' && near(first.lengthM, 6.5, 1e-6) && near(last.lengthM, 6.5, 1e-6)
      && result.spans.slice(1, -1).every(span => !span.cap && span.lengthM <= 22.5 + 1e-5) && result.spans.length === 6,
    'caps: each end a square span, a lane long, the 87 m between cut as ever', result.spans.map(span => span.lengthM.toFixed(1)).join(' '));
    check(last.textures?.join() === 'C/R.png,C/L.png' && last.textureOrient?.rot === 3,
      'caps: at the last point the cap as given, its left on the rider’s left');
    check(first.textures?.join() === 'C/L.png,C/R.png' && first.textureOrient?.rot === 1,
      'caps: at the first point turned round, its left on the path’s right');
    check(result.spans[1].textures?.join() === 'T/R.png,T/L.png', 'caps: between them, the trail tiles');
    const derived = meshFromDoc(result.doc);
    check(result.quads.every(quad => patchNormal(quadControlPoints(derived.mesh, derived.edgeHandle, quad), 0.5, 0.5)[1] > 0),
      'caps: every patch faces the sky');
  }
  const three = applyTrailSpline(emptyDoc(), [straight], { lanes: 3, caps: { end: true }, textures: { trail: EDGES } });
  check(three.ok && near(three.spans.at(-1)!.lengthM, 13 / 3, 1e-6) && !three.spans[0].cap
    && three.spans.at(-1)!.textures?.join() === 'T/R.png,,T/L.png',
  'caps: three lanes, a cap a third of the width long; no cap tiles wears the trail’s');
  const short = applyTrailSpline(emptyDoc(), [leg([0, 0, 0], [0, 0, 10])], { caps: { start: true, end: true } });
  check(!short.ok && /too short/.test(short.error), 'caps: a trail too short for its caps says so', short.ok ? '' : short.error);
}

// ---- tiles turned of their own -------------------------------------------------------------------------------

// A set's tile can be turned beyond its row's turn: only that lane's patches are.
{
  const TURNED: TrailLaneTiles = { left: 'T/L.png', right: 'T/R.png', quarterTurns: 2, turns: { left: 1 } };
  const result = applyTrailSpline(emptyDoc(), [straight], { textures: { trail: TURNED } });
  check(result.ok, 'turns: a set with a tile turned of its own cuts');
  if (result.ok) {
    // A span's first patch is the generator's left lane — a rider's right.
    const [right, left] = result.quads.slice(0, 2).map(quad => result.doc.quadOrient?.[quad]);
    check(right?.rot === 3 && left?.rot === 0 && !right.mirror && !left.mirror,
      'turns: the left tile a quarter beyond the row, the right as the row', JSON.stringify([right, left]));
  }
}

// ---- mirrored tiles ---------------------------------------------------------------------------------------

// One edge tile serving both edges: the left worn mirrored ACROSS the trail — its art's left and right swapped, along
// the trail as it was.
{
  const EDGE: TrailLaneTiles = { left: 'T/E.png', middle: 'T/M.png', right: 'T/E.png', mirrored: ['left'], quarterTurns: 2 };
  const result = applyTrailSpline(emptyDoc(), [straight], { lanes: 3, textures: { trail: EDGE } });
  check(result.ok, 'mirror: a set with a mirrored tile cuts');
  if (result.ok) {
    const [right, middle, left] = result.quads.slice(0, 3).map(quad => result.doc.quadOrient?.[quad]);
    check(result.doc.quadTex?.[result.quads[0]] === 'T/E.png' && result.doc.quadTex?.[result.quads[2]] === 'T/E.png'
      && right?.rot === 3 && !right.mirror && middle?.rot === 3 && !middle.mirror && left?.rot === 1 && left.mirror,
    'mirror: the left edge mirrored, the right and the middle as the set turns them', JSON.stringify([right, middle, left]));
    const [plain, flipped] = [orientUV(0.2, 0.3, 3, false), orientUV(0.2, 0.3, 1, true)];
    check(near(flipped[0], 1 - plain[0]) && near(flipped[1], plain[1]),
      'mirror: across the trail — the tile’s left and right swapped, its along unchanged');
  }
  const CAP: TrailLaneTiles = { left: 'C/L.png', right: 'C/R.png', mirrored: ['left'], quarterTurns: 2 };
  const capped = applyTrailSpline(emptyDoc(), [straight], { caps: { start: true, end: true }, textures: { cap: CAP } });
  check(capped.ok && capped.spans[0].textureMirrors?.join() === 'true,false' && capped.spans.at(-1)!.textureMirrors?.join() === 'false,true',
    'mirror: a cap’s mirrored tile stays mirrored, turned round at the first point');
}

console.log(failures ? '\nTRAIL: FAIL' : '\nTRAIL: PASS');
process.exit(failures ? 1 : 0);
