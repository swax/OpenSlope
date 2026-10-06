// tier: fast

/** Bézier handles on authored paths (docs/014): rails, motion paths, prop lines, trails. Run: `npx tsx test/path-handles.test.ts` */
import { blankMountain } from '../src/core/doc/mountain';
import type { AuthoredTrail, QuadMeshDoc, Rail, V3 } from '../src/core/doc/types';
import { buildMountainLevel } from '../src/core/export/level';
import { cutTrail, TRAIL_SETTINGS_DEFAULTS } from '../src/core/mesh/trail-object';
import { lineJoints } from '../src/core/props/prop-line';
import {
  pathHandleOffsets, railBezierSegments, resetPathHandles, setPathHandle, withoutPathNode,
} from '../src/core/rails/rails';
import { check, failures } from './check';

const near = (a: readonly number[], b: readonly number[], eps = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) < eps);
const nodes: V3[] = [[0, 0, 0], [30, 0, 0], [60, 10, 30], [90, 10, 30]];

// ---- no handles is exactly the Catmull-Rom curve every path always had -------------------------------------------
{
  const segs = railBezierSegments(nodes);
  // Uniform CR → Bézier: b1 = P1 + (P2 − P0)/6, b2 = P2 − (P3 − P1)/6, the ends clamped.
  const at = (i: number) => nodes[Math.max(0, Math.min(nodes.length - 1, i))];
  const expected = nodes.slice(0, -1).map((_, i) => {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    return [p1, p1.map((v, k) => v + (p2[k] - p0[k]) / 6), p2.map((v, k) => v - (p3[k] - p1[k]) / 6), p2];
  });
  check(segs.length === 3 && segs.every((seg, i) => seg.every((p, k) => near(p, expected[i][k]))),
    'automatic: with no handles the curve is the uniform Catmull-Rom it always was');
  const offsets = pathHandleOffsets(nodes);
  check(offsets[0].in === null && offsets[3].out === null && near(offsets[1].in!, offsets[1].out!.map(v => -v)),
    'automatic: the ends have one handle each, and a middle node\'s two are opposite');
}

// ---- a dragged handle moves exactly its control point ----------------------------------------------------------------
{
  const handles = [null, { out: [5, 5, 0] as V3 }];
  const segs = railBezierSegments(nodes, handles), plain = railBezierSegments(nodes);
  check(near(segs[1][1], [35, 5, 0]), 'override: a node\'s out handle is the leaving span\'s first inner point');
  check(near(segs[0][2], plain[0][2]) && near(segs[2][1], plain[2][1]) && near(segs[1][2], plain[1][2]),
    'override: an absent side, and every other node, keep the automatic curve');
}

// ---- dragging keeps the curve smooth unless told not to ------------------------------------------------------------
{
  const autoIn = pathHandleOffsets(nodes)[1].in!;
  const aligned = setPathHandle(nodes, undefined, 1, 'out', [0, 0, 8]);
  const keep = Math.hypot(...autoIn);
  check(near(aligned[1]!.out!, [0, 0, 8]) && near(aligned[1]!.in!, [0, 0, -keep]),
    'drag: the twin swings into line and keeps its own length', JSON.stringify(aligned[1]));
  const broken = setPathHandle(nodes, undefined, 1, 'out', [0, 0, 8], true);
  check(broken[1]!.in === undefined, 'drag: Alt moves one side alone, leaving a corner');
  const end = setPathHandle(nodes, undefined, 0, 'out', [3, 0, 0]);
  check(end.length === 1 && near(end[0]!.out!, [3, 0, 0]) && end[0]!.in === undefined, 'drag: an end node has only one handle');
  check(resetPathHandles(aligned, 1).length === 0, 'reset: a node back on the automatic curve leaves nothing stored');
  const spliced = withoutPathNode([null, { out: [1, 0, 0] }, { in: [2, 0, 0] }], 1);
  check(spliced.length === 2 && spliced[1]!.in![0] === 2, 'delete: a removed node takes its handles, later nodes keep theirs');
}

// ---- every consumer reads them: the export, a trail's cut, a prop line's layout ------------------------------------
{
  const doc: QuadMeshDoc = blankMountain();
  const rail: Rail = { id: 'rail:0000', kind: 'grind', nodes: nodes.map(p => [...p] as V3), height: 1.5, style: 13 };
  doc.rails = [rail];
  const plain = buildMountainLevel(doc).text['Splines.json'];
  rail.handles = setPathHandle(rail.nodes, undefined, 1, 'out', [0, 0, 12]);
  const bent = buildMountainLevel(doc).text['Splines.json'];
  type Exported = { Splines: { Segments: { Points: number[][] }[] }[] };
  const a = (JSON.parse(plain) as Exported).Splines[0].Segments, b = (JSON.parse(bent) as Exported).Splines[0].Segments;
  check(a.length === b.length && !near(a[1].Points[1], b[1].Points[1]) && near(a[0].Points[0], b[0].Points[0])
    && near(a[2].Points[3], b[2].Points[3]), 'export: Splines.json carries the dragged control point, the nodes unchanged');

  const empty: QuadMeshDoc = { ...blankMountain(), vertices: [], vertexIds: [], quads: [], quadIds: [], nextId: 0 };
  const knots: V3[] = [[0, 0, 0], [0, 0, 60], [0, 0, 120]];
  const trail: AuthoredTrail = { id: 'trail:0000', knots, settings: { ...TRAIL_SETTINGS_DEFAULTS }, vertices: [], quads: [] };
  const straight = cutTrail(empty, trail);
  const curved = cutTrail(empty, { ...trail, handles: setPathHandle(knots, undefined, 1, 'out', [15, 0, 15]) });
  check(straight.ok && curved.ok && curved.layout.stations.some(station => Math.abs(station.center[0]) > 1)
    && straight.layout.stations.every(station => Math.abs(station.center[0]) < 1e-9),
  'trail: a dragged handle bends the cut ribbon off the straight line');

  const line = lineJoints(knots, 10), bentLine = lineJoints(knots, 10, 'plan', setPathHandle(knots, undefined, 1, 'out', [15, 0, 15]));
  check(!!line && !!bentLine && line.joints.every(p => Math.abs(p[0]) < 1e-9) && bentLine.joints.some(p => Math.abs(p[0]) > 1),
    'prop line: its joints follow the bent curve');
}

if (failures) process.exitCode = 1;
