// tier: fast

/**
 * Headless checks for the meshops charting ops and the authored-model container: the ridable-side flip
 * (src/core/mesh/ops/flip.ts), the loft that spans N ordered rails with a reused-vertex quad chart
 * (src/core/mesh/loft.ts, docs/023 S1), and the flat (linearCage) evaluation of authored polygon models.
 * Run: `npx tsx test/meshops-loft.test.ts`
 *
 * Split out of test/meshops.test.ts; the grid fixture and the `check()` tally live in
 * test/meshops.fixture.ts, shared with the other `meshops-*` checks.
 */
import { deriveQuadMesh } from '../src/core/doc/mountain';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import { patchPoint, patchNormal } from '../src/core/math/bezier';
import { dot, len, sub } from '../src/core/math/vec';
import { appendPatchFromCorners, applyMeshFlip, checkManifold } from '../src/core/mesh/ops';
import { orientUV } from '../src/core/paint/orientation';
import { applyLoft, railFromEdges, railsFromEdges } from '../src/core/mesh/loft';
import { getVertex } from '../src/core/doc/doc-edit';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { watertight, hasNaN, grid, GRID_COLS, freshGrid } from './meshops.fixture';
import { check, failures } from './check';

// ---- 24. FLIP RIDABLE SIDE (core/mesh/ops/flip.ts): the engine's contact is one-sided along the patch's
// parametric normal, so which side is ridable is the corner ORDER's business. The flip mirrors the v axis
// ([A,B,C,D] → [B,A,D,C]): same surface, same edges, reversed normal — and every per-quad sidecar rides along.
{
  const dist = (a: V3, b: V3) => len(sub(a, b));
  const doc = freshGrid();
  doc.quadTex = { 3: 'DONOR/0028.png' };
  doc.quadOrient = { 3: { rot: 1, mirror: false } };
  const t0: [V3, V3, V3, V3] = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6], [0.7, 0.8, 0.9], [1.0, 1.1, 1.2]];
  doc.quadTwist = { 5: structuredClone(t0) };
  const before = structuredClone(doc);

  const empty = applyMeshFlip(doc, []);
  check(!empty.ok, 'flip: an empty selection is refused with a message');

  const r = applyMeshFlip(doc, [3, 5, 3]); // the duplicate id collapses
  check(r.ok, 'flip: applies to a cell selection');
  if (r.ok) {
    check(r.flipped === 2, `flip: reports unique flipped cells (${r.flipped} = 2, duplicate collapsed)`);
    check(JSON.stringify(doc) === JSON.stringify(before), 'flip: the source document is untouched (pure rewrite)');
    const q0 = before.quads[3], q1 = r.doc.quads[3];
    check(q1[0] === q0[1] && q1[1] === q0[0] && q1[2] === q0[3] && q1[3] === q0[2],
      'flip: corner order mirrors the v axis — [A,B,C,D] → [B,A,D,C]');
    check(before.quads[0].every((v, i) => r.doc.quads[0][i] === v)
      && before.vertices.every((x, i) => r.doc.vertices[i] === x),
      'flip: unselected quads and all vertices stay byte-identical');
    check(checkManifold(r.doc.quads).ok, 'flip: the manifold guard still passes (the undirected edge set is unchanged)');

    // The surface itself does not move: P'(u,v) == P(u, 1−v), with the swapped twist offsets feeding the
    // flipped net — so this one comparison also proves the twist seats swapped correctly. The normal reverses.
    const { mesh: m0, edgeHandle: eh0 } = meshFromDoc(before);
    const { mesh: m1, edgeHandle: eh1 } = meshFromDoc(r.doc);
    for (const q of [3, 5]) {
      const cp0 = quadControlPoints(m0, eh0, q, before.quadTwist?.[q] ?? null);
      const cp1 = quadControlPoints(m1, eh1, q, r.doc.quadTwist?.[q] ?? null);
      let sameSurface = true, normalReversed = true;
      for (const [u, v] of [[0.2, 0.3], [0.5, 0.5], [0.85, 0.1]] as [number, number][]) {
        if (dist(patchPoint(cp0, u, 1 - v), patchPoint(cp1, u, v)) > 1e-9) sameSurface = false;
        if (dot(patchNormal(cp0, u, 1 - v), patchNormal(cp1, u, v)) > -0.999999) normalReversed = false;
      }
      check(sameSurface, `flip: quad ${q} is the same surface reparameterized — P'(u,v) == P(u,1−v) to 1e-9`);
      check(normalReversed, `flip: quad ${q}'s analytic normal is exactly reversed at every sample`);
    }
    check(r.doc.quadTwist![5].every((o, i) => dist(o, before.quadTwist![5][[1, 0, 3, 2][i]]) === 0),
      'flip: interior twist offsets swap seats with their corners ([tA,tB,tC,tD] → [tB,tA,tD,tC])');

    // Paint state: the tile ref survives untouched, and the D4 orientation composes with the v-mirror
    // (rot += 2, mirror toggles) so the painted tile keeps rendering exactly as placed.
    check(r.doc.quadTex?.[3] === 'DONOR/0028.png', 'flip: the painted tile ref is untouched');
    const o1 = r.doc.quadOrient?.[3];
    check(!!o1 && o1.rot === 3 && o1.mirror === true, `flip: D4 orientation composes with the v-mirror ({rot 1} → {rot ${o1?.rot}, mirror ${o1?.mirror}} = {rot 3, mirror true})`);
    let orientHolds = true;
    for (const [u, v] of [[0.2, 0.3], [0.5, 0.5], [0.85, 0.1], [0, 1]] as [number, number][]) {
      const [a0, b0] = orientUV(u, 1 - v, 1, false), [a1, b1] = orientUV(u, v, 3, true);
      if (Math.abs(a0 - a1) > 1e-12 || Math.abs(b0 - b1) > 1e-12) orientHolds = false;
    }
    check(orientHolds, 'flip: the composed orientation samples the same texel at every mirrored parameter — the tile is visually frozen');
    check(r.doc.quadTwist![5] !== before.quadTwist![5] && r.doc.quadOrient![3] !== before.quadOrient![3],
      'flip: sidecar maps are copied, never aliased into the source');

    // Flipping twice is the identity, on the corners and on both sidecars (rot wraps 3+2 → 1, mirror untoggles).
    const r2 = applyMeshFlip(r.doc, [3, 5]);
    check(r2.ok && r2.doc.quads.every((q, i) => q.every((v, k) => before.quads[i][k] === v)),
      'flip: flipping twice restores every corner order — the flip is an involution');
    check(r2.ok && r2.doc.quadTwist![5].every((o, i) => dist(o, before.quadTwist![5][i]) === 0),
      'flip: ...and the twist offsets return to their seats');
    const o2 = r2.ok ? r2.doc.quadOrient?.[3] : undefined;
    check(!!o2 && o2.rot === 1 && o2.mirror === false, 'flip: ...and the D4 orientation returns to {rot 1, mirror false}');
  }

  // A painted cell with NO stored orientation gets the pure v-mirror element, so its tile still renders in
  // place; a virgin cell (no tex, no orient) gets no entry at all — the flip is geometry, not paint.
  const docTex = freshGrid();
  docTex.quadTex = { 2: 'DONOR/0040.png' };
  const rt = applyMeshFlip(docTex, [2, 4]);
  check(rt.ok && !!rt.doc.quadOrient && rt.doc.quadOrient[2]?.rot === 2 && rt.doc.quadOrient[2]?.mirror === true,
    'flip: a painted cell without an orientation entry gains the v-mirror element ({rot 2, mirror true})');
  check(rt.ok && rt.doc.quadOrient?.[4] === undefined,
    'flip: a virgin cell gains no orientation entry');

  // A WEDGE [A,B,C,C] flips to [B,A,C,C]: the collapsed pair stays in its one legal slot (a u/v transpose
  // would scatter it into a degenerate), and the guard still passes.
  const docW = freshGrid();
  const W0 = docW.vertices.length / 3, QW = docW.quads.length;
  docW.vertices = docW.vertices.concat([1000, 0, 0, 1010, 0, 0, 1000, 0, 10]);
  docW.quads = docW.quads.concat([[W0, W0 + 1, W0 + 2, W0 + 2]]);
  const rw = applyMeshFlip(docW, [QW]);
  check(rw.ok && rw.doc.quads[QW][0] === W0 + 1 && rw.doc.quads[QW][1] === W0
    && rw.doc.quads[QW][2] === W0 + 2 && rw.doc.quads[QW][3] === W0 + 2,
    'flip: a wedge [A,B,C,C] flips to [B,A,C,C] — still the one legal collapsed form');
  check(rw.ok && checkManifold(rw.doc.quads).ok, 'flip: the flipped wedge passes the manifold guard');
}

// ---- 24. LOFT (docs/023 S1): span N ordered rails with a reused-vertex quad chart (src/core/mesh/loft.ts) --------
{
  // a standalone doc whose vertex buffer is exactly `pts` and quads `quads` — a DISCONNECTED chart the loft is
  // meant to bridge (the S1 audit confirms cage / BVH / derive tolerate one). Grid meta is cloned for a valid
  // QuadMeshDoc; every id-keyed map is cleared so it can't reference the grid's old vertices.
  const miniDoc = (pts: V3[], quads: number[][] = []): QuadMeshDoc => {
    const d = structuredClone(grid);
    d.vertices = pts.flatMap(p => [p[0], p[1], p[2]]);
    d.quads = quads.map(q => q.slice());
    delete d.quadPaint; delete d.quadTex; delete d.quadOrient; delete d.quadTwist; delete d.edgeHandles;
    return d;
  };
  // three parallel rails in the XZ plane: rail A at x=0, B at x=-10, C at x=-20; stations up +Z at z=0,10,20. With
  // v = A→B (−X) across the rails and u = +Z (station) along them, cross(dv,du) = +Y, so the flow-oriented chart
  // faces skyward — the winding lands where the reference's up-facing snow ribbons do.
  const railPts: V3[] = [
    [0, 0, 0], [0, 0, 10], [0, 0, 20],       // rail A = ids 0,1,2
    [-10, 0, 0], [-10, 0, 10], [-10, 0, 20], // rail B = ids 3,4,5
    [-20, 0, 0], [-20, 0, 10], [-20, 0, 20], // rail C = ids 6,7,8
  ];
  const railA = [0, 1, 2], railB = [3, 4, 5], railC = [6, 7, 8];
  const skyward = (doc: QuadMeshDoc): boolean => {
    const { mesh, edgeHandle } = meshFromDoc(doc);
    return doc.quads.every((_, qi) => patchNormal(quadControlPoints(mesh, edgeHandle, qi), 0.5, 0.5)[1] > 0);
  };

  // ---- 24a. two-rail bridge: reuse the rail vertices, emit one lane of quads, watertight + skyward
  {
    const doc = miniDoc(railPts.slice(0, 6));
    const r = applyLoft(doc, [railA, railB]);
    check(r.ok, 'loft 2-rail: commit accepted');
    if (r.ok) {
      check(r.doc.vertices.length / 3 === 6, 'loft 2-rail: no new vertices (rails supply every corner)');
      check(r.doc.quads.length === 2, `loft 2-rail: one lane × two stations = 2 quads (${r.doc.quads.length})`);
      check(r.reversed.length === 0, 'loft 2-rail: nothing reversed (rails already aligned)');
      // winding: [A@(u0,v0), B@(u0,v1), C@(u1,v0), D@(u1,v1)] = [railA[s], railB[s], railA[s+1], railB[s+1]]
      check(JSON.stringify(r.doc.quads[0]) === JSON.stringify([0, 3, 1, 4]), `loft 2-rail: station-0 quad winds [rA0,rB0,rA1,rB1] (got ${r.doc.quads[0]})`);
      check(JSON.stringify(r.doc.quads[1]) === JSON.stringify([1, 4, 2, 5]), `loft 2-rail: station-1 quad winds [rA1,rB1,rA2,rB2] (got ${r.doc.quads[1]})`);
      const wt = watertight(r.doc);
      check(wt.ok && !hasNaN(r.doc), 'loft 2-rail: watertight (the shared station seam counts twice), finite');
      check(skyward(r.doc), 'loft 2-rail: every quad normal is skyward (winding matches the reference flow-oriented convention)');
    }
  }

  // ---- 24b. three-rail two-lane loft: adjacent lanes share the middle rail as opposite v-boundaries
  {
    const doc = miniDoc(railPts);
    const r = applyLoft(doc, [railA, railB, railC]);
    check(r.ok, 'loft 3-rail: commit accepted');
    if (r.ok) {
      check(r.doc.quads.length === 4, `loft 3-rail: two lanes × two stations = 4 quads (${r.doc.quads.length})`);
      check(r.doc.vertices.length / 3 === 9, 'loft 3-rail: no new vertices');
      const wt = watertight(r.doc);
      check(wt.ok && !hasNaN(r.doc), 'loft 3-rail: watertight, finite');
      check(skyward(r.doc), 'loft 3-rail: all four quads wound skyward + congruent');
      // the middle rail's seams (3-4, 4-5) each abut exactly two quads — lane 0's v=1 column, lane 1's v=0 column
      const share = (a: number, b: number) => r.doc.quads.filter(q =>
        ([[q[0], q[1]], [q[1], q[3]], [q[3], q[2]], [q[2], q[0]]] as [number, number][]).some(([x, y]) => (x === a && y === b) || (x === b && y === a))).length;
      check(share(3, 4) === 2 && share(4, 5) === 2, 'loft 3-rail: the middle rail seams each abut exactly two lanes (self-consistent chart)');
    }
  }

  // Target patch size adds intermediate rails only when the across-rail span is too large.
  {
    const pts: V3[] = [
      [0, 0, 0], [0, 0, 10], [0, 0, 20],
      [-100, 0, 0], [-100, 0, 10], [-100, 0, 20],
    ];
    const r = applyLoft(miniDoc(pts), [[0, 1, 2], [3, 4, 5]], { targetPatchM: 30 });
    check(r.ok, 'loft target size: long span accepted');
    if (r.ok) {
      check(r.doc.vertices.length / 3 === 15, `loft target size: three intermediate 3-point rails appended (${r.doc.vertices.length / 3} vertices)`);
      check(r.doc.quads.length === 8, `loft target size: four lanes × two stations = 8 quads (${r.doc.quads.length})`);
      check(r.doc.vertices[18] === -25 && r.doc.vertices[27] === -50 && r.doc.vertices[36] === -75,
        'loft target size: intermediate rails are evenly spaced across the span');
    }
    const unchanged = applyLoft(miniDoc(pts), [[0, 1, 2], [3, 4, 5]]);
    check(unchanged.ok && unchanged.doc.vertices.length / 3 === 6 && unchanged.doc.quads.length === 2,
      'loft target size: absent option preserves the original no-new-vertices behavior');
  }

  // Connection curvature bends inserted loops through a multi-rail path; zero preserves straight interpolation.
  {
    const pts: V3[] = [
      [0, 0, 0], [0, 0, 10],
      [50, 0, 50], [50, 0, 60],
      [100, 0, 0], [100, 0, 10],
    ];
    const rails = [[0, 1], [2, 3], [4, 5]];
    const straight = applyLoft(miniDoc(pts), rails, { preserveRailOrder: true, targetPatchM: 30, connectionCurve: 0 });
    const curved = applyLoft(miniDoc(pts), rails, { preserveRailOrder: true, targetPatchM: 30, connectionCurve: 1 });
    check(straight.ok && curved.ok, 'loft connection curve: straight and smooth variants both commit');
    if (straight.ok && curved.ok) {
      const firstInserted = pts.length;
      const straightP = straight.doc.vertices.slice(firstInserted * 3, firstInserted * 3 + 3);
      const curvedP = curved.doc.vertices.slice(firstInserted * 3, firstInserted * 3 + 3);
      check(Math.abs(straightP[0] - 50 / 3) < 1e-9 && Math.abs(straightP[2] - 50 / 3) < 1e-9,
        `loft connection curve: zero uses linear intermediate placement (${straightP.map(v => v.toFixed(2))})`);
      check(Math.hypot(curvedP[0] - straightP[0], curvedP[2] - straightP[2]) > 1,
        `loft connection curve: smooth placement bows away from the straight chord (${curvedP.map(v => v.toFixed(2))})`);
      const straightHandle = straight.doc.edgeHandles?.['0>6'];
      check(!!straightHandle && Math.abs(straightHandle[0] - straightP[0] / 3) < 1e-9
        && Math.abs(straightHandle[2] - straightP[2] / 3) < 1e-9,
      'loft connection curve: zero writes straight chord-third connector handles');
      check(JSON.stringify(curved.doc) !== JSON.stringify(straight.doc),
        'loft connection curve: smooth and straight bridge documents are materially different');
    }
  }

  // ---- 24c. auto-reversal: a rail picked end-for-end is detected, flipped, and lofts the aligned chart
  {
    const doc = miniDoc(railPts.slice(0, 6));
    const flippedB = [5, 4, 3]; // rail B listed z=20→0, opposite rail A's z=0→20
    const r = applyLoft(doc, [railA, flippedB]);
    check(r.ok, 'loft reverse: commit accepted');
    if (r.ok) {
      check(r.reversed.length === 1 && r.reversed[0] === 1, `loft reverse: rail 1 reported reversed (${r.reversed})`);
      const ref = applyLoft(miniDoc(railPts.slice(0, 6)), [railA, railB]);
      check(ref.ok && JSON.stringify(r.doc.quads) === JSON.stringify(ref.doc.quads), 'loft reverse: the flipped pick lofts the SAME chart as the aligned pick');
    }
  }

  // ---- 24d. reversal ambiguity: a rail whose ends are equidistant from the previous rail's is refused, not guessed
  {
    const pts: V3[] = [[0, 0, 0], [0, 0, 4], [5, 0, 2], [6, 0, 2]]; // rail B's ends both on the z=2 bisector plane
    const r = applyLoft(miniDoc(pts), [[0, 1], [2, 3]]);
    check(!r.ok && /orient|equidistant|symmetric/.test(r.error), 'loft ambiguity: an equidistant (symmetric) rail is refused explicitly');
  }

  // Bridge Builder directions are explicit: its Reverse control must survive commit instead of auto-aligning back.
  {
    const manual = applyLoft(miniDoc(railPts.slice(0, 6)), [railA, [5, 4, 3]], { preserveRailOrder: true });
    check(manual.ok && manual.reversed.length === 0 && manual.doc.quads[0]?.[1] === 5,
      'bridge direction: preserveRailOrder keeps a manually reversed rail exactly as listed');
  }

  // ---- 24e. mismatched station counts: refused (the stitched-refuses model — no silent resample)
  {
    const r = applyLoft(miniDoc(railPts), [[0, 1, 2], [3, 4]]);
    check(!r.ok && /station count/.test(r.error), 'loft mismatch: unequal station counts refused');
  }

  // ---- 24f. duplicate-quad rejection: lofting two ADJACENT grid rows re-covers existing patches
  {
    const g = freshGrid();
    const cols = GRID_COLS;
    const rowA = Array.from({ length: cols }, (_, c) => 2 * cols + c); // grid row 2
    const rowB = Array.from({ length: cols }, (_, c) => 3 * cols + c); // grid row 3 (already quadded to row 2)
    const r = applyLoft(g, [rowA, rowB]);
    check(!r.ok && /existing patch|already form a quad/.test(r.error), 'loft duplicate: re-covering an existing grid patch is refused');
  }

  // ---- 24g. degenerate rejections, each with its own distinct message
  {
    const pts: V3[] = [[0, 0, 0], [0, 0, 10], [0, 0, 20], [-10, 0, 0], [-10, 0, 10], [-10, 0, 20]];
    // two rails meeting at station 1 (both name vertex 1): the lane folds to a triangle — the "same station" error
    const meet = applyLoft(miniDoc(pts), [[0, 1, 2], [3, 1, 5]]);
    check(!meet.ok && /meet at station|collapses to a triangle/.test(meet.error), 'loft degenerate: rails meeting at a station are refused (lane collapse)');
    // a rail doubling back (id 0 at stations 0 AND 1): a repeated corner that is NOT a same-station meet
    const doubled = applyLoft(miniDoc(pts), [[0, 0, 2], [3, 4, 5]]);
    check(!doubled.ok && /doubles back|corner repeats/.test(doubled.error), 'loft degenerate: a rail doubling back on itself is refused');
  }

  // ---- 24h. determinism: the same inputs loft a byte-identical doc
  {
    const a = applyLoft(miniDoc(railPts), [railA, railB, railC]);
    const b = applyLoft(miniDoc(railPts), [railA, railB, railC]);
    check(a.ok && b.ok && JSON.stringify(a.doc) === JSON.stringify(b.doc), 'loft determinism: same inputs → byte-identical doc');
  }

  // ---- 24i. paint option: every emitted quad takes opts.surface, and only those quads
  {
    const doc = miniDoc(railPts);
    const r = applyLoft(doc, [railA, railB, railC], { surface: 5 });
    check(r.ok, 'loft paint: commit accepted');
    if (r.ok) {
      check(r.doc.quads.every((_, qi) => r.doc.quadPaint?.[qi] === 5), 'loft paint: opts.surface paints all four emitted quads');
      check(r.doc.baseSurface === doc.baseSurface, 'loft paint: baseSurface is unchanged (paint is per-quad)');
    }
    const plain = applyLoft(miniDoc(railPts), [railA, railB, railC]);
    check(plain.ok && !plain.doc.quadPaint, 'loft paint: absent surface leaves no quadPaint (the quads inherit baseSurface)');
  }

  // ---- 24j. railsFromEdges (docs/023 S1, "edge-runs-as-rails"): an Edit edge selection → the ordered rails
  {
    // canonical [lo,hi] edge pairs for rail A (ids 0-1-2) and rail B (ids 3-4-5): the shape a double-click loop +
    // a shift-added second loop leaves in store.edgeSel, fed in SCRAMBLED order and either winding.
    const scrambled: [number, number][] = [[4, 5], [1, 2], [3, 4], [0, 1]];
    const der = railsFromEdges(scrambled);
    check(der.ok, 'railsFromEdges: two disjoint runs parse');
    if (der.ok) {
      check(JSON.stringify(der.rails) === JSON.stringify([[0, 1, 2], [3, 4, 5]]),
        `railsFromEdges: each run ordered from its smaller endpoint, cross-section-sorted by first id (got ${JSON.stringify(der.rails)})`);
      // the derived rails feed applyLoft directly — the round trip the UI runs (adopt → dry-run)
      const lofted = applyLoft(miniDoc(railPts.slice(0, 6)), der.rails);
      check(lofted.ok && lofted.doc.quads.length === 2, 'railsFromEdges: the derived rails loft (adopt → dry-run round trip)');
    }
    // cross-section order is independent of pick / insertion order: rail B's edges first still sorts A before B
    const bFirst = railsFromEdges([[3, 4], [4, 5], [0, 1], [1, 2]]);
    check(bFirst.ok && JSON.stringify(bFirst.rails) === JSON.stringify([[0, 1, 2], [3, 4, 5]]),
      'railsFromEdges: cross-section order is by first vertex id, not pick order');
  }

  // ---- 24k. railsFromEdges refusals: a single run, a branching run, a closed loop — each rejected explicitly
  {
    const one = railsFromEdges([[0, 1], [1, 2]]); // one connected run = one rail, not a loft
    check(!one.ok && /two or more edge runs|one run/.test(one.error), 'railsFromEdges: a single run is not a loft (needs 2+)');
    // a valid run PLUS a branching second component (vertex 11 on three edges): the branch is refused, not guessed
    const fork = railsFromEdges([[0, 1], [1, 2], [10, 11], [11, 12], [11, 13]]);
    check(!fork.ok && /open edge run|closed loop or branches/.test(fork.error), 'railsFromEdges: a branching run is refused');
    // a valid run PLUS a closed-loop second component (a triangle ring 10-11-12): the ring is refused
    const ring = railsFromEdges([[0, 1], [1, 2], [10, 11], [11, 12], [10, 12]]);
    check(!ring.ok && /open edge run|closed loop or branches/.test(ring.error), 'railsFromEdges: a closed loop is refused');
  }

  // ---- 24l. Bridge Builder seed/candidate parsing: exactly one simple open edge chain
  {
    const one = railFromEdges([[1, 2], [0, 1]]);
    check(one.ok && JSON.stringify(one.rail) === JSON.stringify([0, 1, 2]),
      `railFromEdges: a scrambled single chain becomes one ordered builder rail${one.ok ? ` (${one.rail})` : ''}`);
    const separate = railFromEdges([[0, 1], [3, 4]]);
    check(!separate.ok && /one connected open edge chain|not separate runs/.test(separate.error),
      'railFromEdges: separate runs cannot become one builder rail');
    const ring = railFromEdges([[0, 1], [1, 2], [0, 2]]);
    check(!ring.ok && /closed ring/.test(ring.error), 'railFromEdges: a closed ring cannot become a builder rail');
  }

  // ---- 24m. completing a free-edge bridge consumes the now-redundant free-edge records, not their handles
  {
    const doc = miniDoc(railPts.slice(0, 6));
    doc.freeEdges = [[0, 1], [1, 2], [3, 4], [4, 5], [0, 3]];
    doc.edgeHandles = { '0>1': [0, 0, 3] };
    const r = applyLoft(doc, [railA, railB], { preserveRailOrder: true });
    check(r.ok && r.doc.freeEdges === undefined,
      'bridge free edges: rail/cross edges become ordinary surface edges and leave no duplicate free-edge records');
    check(r.ok && JSON.stringify(r.doc.edgeHandles?.['0>1']) === JSON.stringify([0, 0, 3]),
      'bridge free edges: a consumed free edge keeps its directed curve handle on the resulting surface edge');
  }
}

// ---- authored polygon models: the flat (linearCage) evaluation + the model container ----
{
  const { createAuthoredModel, commitModelEditDoc, duplicateAuthoredModel, modelEditDocFor, reviseModelName,
    authoredModelLevelProps, modelNumber, AUTHORED_MODEL_LEVEL, reviseModelFromProp, rebaseModelToPlacement } = await import('../src/core/doc/models');
  const { rotateByPlacement } = await import('../src/core/props/pose');
  type PlacedProp = import('../src/core/doc/types').PlacedProp;
  const host = freshGrid();
  const model = createAuthoredModel(host, 'Ribbon');
  const edit = modelEditDocFor(host, model);
  // a non-planar quad, authored the way create-patch would: four perimeter clicks on fresh points
  const grown = appendPatchFromCorners(edit, [[0, 0, 0], [10, 2, 0], [10, 4, 12], [0, 1, 12]]);
  check(grown.ok, 'model mesh: create patch appends into the model substrate');
  if (grown.ok) {
    commitModelEditDoc(model, grown.doc);
    check(model.quads.length === 1 && model.vertices.length === 12 && model.anchor[1] === 0,
      'model commit stores the mesh and seats the anchor at the base centre');
    const live = modelEditDocFor(host, model);
    const derived = deriveQuadMesh(live);
    const cp = quadControlPoints(derived.mesh, derived.edgeHandle, 0, derived.twistOf(0));
    // the flat cage: the bicubic patch must equal the BILINEAR (doubly-ruled) quad exactly at any parameter
    const [A, B, C, D] = live.quads[0].map(id => getVertex(live, id));
    const bilinear = (u: number, v: number): V3 => [0, 1, 2].map(k =>
      (1 - u) * ((1 - v) * A[k] + v * B[k]) + u * ((1 - v) * C[k] + v * D[k])) as V3;
    let worst = 0;
    for (const [u, v] of [[0.25, 0.5], [0.5, 0.5], [0.75, 0.1], [1, 1], [0.33, 0.66]] as const) {
      const p = patchPoint(cp, u, v), q = bilinear(u, v);
      worst = Math.max(worst, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]));
    }
    check(worst < 1e-9, 'linearCage evaluation degenerates the bicubic patch EXACTLY to the flat quad');
    // curvature channels an op writes are dropped at commit — the flat cage is derived, never stored
    const curved = { ...live, edgeHandles: { '0>1': [0, 5, 0] as V3 }, quadTwist: { 0: [[0, 3, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] as [V3, V3, V3, V3] } };
    commitModelEditDoc(model, curved);
    const healed = deriveQuadMesh(modelEditDocFor(host, model));
    const healedCp = quadControlPoints(healed.mesh, healed.edgeHandle, 0, healed.twistOf(0));
    const p = patchPoint(healedCp, 0.75, 0.3), q = bilinear(0.75, 0.3);
    check(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) < 1e-9,
      'model commit drops written curvature: the surface self-heals to the polygons');
  }
  model.texture = 'DONOR/0106.png'; // a river-water tile borrowed from the donor level
  const lp = authoredModelLevelProps(host);
  const baked = lp.models.find(x => x.id === modelNumber(model.id))!;
  check(lp.level === AUTHORED_MODEL_LEVEL && baked.subs[0].indices.length === 6
    && baked.subs[0].positions.length === model.quads.length * 12
    && lp.materials.get(baked.subs[0].mat)?.tex === 'DONOR/0106.png',
    'authored models bake into the reference-prop payload shape (two triangles per quad + the tile ref)');
  check([...baked.subs[0].uvs.slice(0, 8)].join(',') === '0,0,1,0,0,1,1,1',
    'each baked quad wears the full 0–1 tile — wrap-continuous UVs, the scroll-safe form');
  model.blend = true;
  check(authoredModelLevelProps(host).materials.get(baked.subs[0].mat)?.blend === true,
    'an authored model carries its explicit alpha-pass material into the viewport prop payload');
  delete model.blend;
  {
    // A model's tile can carry a flipbook STATE list. The tile rides whole as a cross-level ref; its frames
    // go bare, because a frame list resolves against the bank the tile already named.
    const { authoredModelFrames } = await import('../src/core/doc/models');
    model.frames = ['DONOR/0106.png', 'DONOR/0107.png'];
    check(lp.materials.get(baked.subs[0].mat)?.frames.length === 0,
      'the payload built before the list existed is untouched — it is derived, not cached');
    const flipped = authoredModelLevelProps(host);
    check(flipped.materials.get(baked.subs[0].mat)?.frames.join(' ') === '0106.png 0107.png',
      'an authored flipbook reaches the payload as bare names in the tile\'s own bank');
    model.frames = ['DONOR2/9999.png', 'DONOR/0107.png'];
    check(authoredModelFrames(model).join(' ') === 'DONOR/0106.png DONOR/0107.png',
      'the list is re-headed onto the model\'s own tile, so frames[0] === texture cannot drift');
    model.frames = ['DONOR/0106.png'];
    check(authoredModelFrames(model).length === 0,
      'a list that falls below two entries is a still image, not a one-frame animation');
    delete model.frames;
  }
  const [ax, ay, az] = model.anchor, raw = baked.subs[0].positions;
  let worstRt = 0;
  model.quads[0].forEach((vid, s) => {
    // RAW_TO_EDITOR inverse of the bake, plus the anchor: must land back on the built world vertex
    const ex = -raw[s * 3] / 100 + ax, ey = raw[s * 3 + 2] / 100 + ay, ez = -raw[s * 3 + 1] / 100 + az;
    worstRt = Math.max(worstRt, Math.abs(ex - model.vertices[vid * 3]),
      Math.abs(ey - model.vertices[vid * 3 + 1]), Math.abs(ez - model.vertices[vid * 3 + 2]));
  });
  check(worstRt < 1e-4, 'model bake raw space round-trips through RAW_TO_EDITOR to the built world position');
  check(reviseModelName('Ribbon') === 'Ribbon v2' && reviseModelName('Ribbon v2') === 'Ribbon v3',
    'save-as revision naming suffixes v2 and increments an existing revision');
  const copy = duplicateAuthoredModel(host, model);
  check(copy.id !== model.id && copy.name === 'Ribbon v2' && copy.vertices.length === model.vertices.length,
    'duplicate model allocates a fresh id and the revision name');

  // ---- revise-a-copy: reviseModelFromProp is the bake's exact inverse (weld + wedge winding + pose) ----
  const revised = reviseModelFromProp(host, 'Ribbon rev', baked.subs, { pos: [ax, ay, az], yaw: 0, scale: 1 });
  check(revised.vertices.length === model.vertices.length && revised.quads.length === 2
    && revised.quads.every(q => q[2] === q[3]),
    'revise welds the baked per-corner vertices back to shared ids and lands every triangle as a wedge quad');
  const nearestOriginal = (x: number, y: number, z: number) => {
    let best = Infinity;
    for (let i = 0; i < model.vertices.length; i += 3) {
      best = Math.min(best, Math.hypot(x - model.vertices[i], y - model.vertices[i + 1], z - model.vertices[i + 2]));
    }
    return best;
  };
  let worstRevise = 0;
  for (let i = 0; i < revised.vertices.length; i += 3) {
    worstRevise = Math.max(worstRevise, nearestOriginal(revised.vertices[i], revised.vertices[i + 1], revised.vertices[i + 2]));
  }
  check(worstRevise < 1e-4, 'revise at the identity pose lands back on the source world vertices');
  const rebaked = authoredModelLevelProps(host).models.find(x => x.id === modelNumber(revised.id))!;
  let worstTri = 0;
  for (let k = 0; k < baked.subs[0].indices.length; k++) { // corner-by-corner, order-preserving winding
    const a = baked.subs[0].indices[k] * 3, b = rebaked.subs[0].indices[k] * 3;
    worstTri = Math.max(worstTri, Math.hypot(
      baked.subs[0].positions[a] - rebaked.subs[0].positions[b],
      baked.subs[0].positions[a + 1] - rebaked.subs[0].positions[b + 1],
      baked.subs[0].positions[a + 2] - rebaked.subs[0].positions[b + 2]));
  }
  check(worstTri < 1e-2, 're-baking a revised model reproduces the source raw triangles in the same order');
  // a posed placement bakes its transform into the copy: yaw 90° about +Y, ×2, seated at a new spot
  const posed = reviseModelFromProp(host, 'Ribbon posed', baked.subs, { pos: [100, 50, -30], yaw: 90, scale: 2 });
  const L = [model.vertices[0] - ax, model.vertices[1] - ay, model.vertices[2] - az];
  const expected = [100 + 2 * L[2], 50 + 2 * L[1], -30 - 2 * L[0]];
  let bestPosed = Infinity;
  for (let i = 0; i < posed.vertices.length; i += 3) {
    bestPosed = Math.min(bestPosed, Math.hypot(
      posed.vertices[i] - expected[0], posed.vertices[i + 1] - expected[1], posed.vertices[i + 2] - expected[2]));
  }
  check(bestPosed < 1e-4, 'revise bakes the placement pose (translate · rotY · uniform scale) into the copy');

  // ---- rebase to a placement: an edit session opens AT the prop that was picked, nothing rendered moves ----
  const poseOf = (pp: { pos: V3; yaw: number; scale: number }, v: V3, anchor: V3): V3 => {
    const t = pp.yaw * Math.PI / 180, c = Math.cos(t), s = Math.sin(t);
    const lx = pp.scale * (v[0] - anchor[0]), ly = pp.scale * (v[1] - anchor[1]), lz = pp.scale * (v[2] - anchor[2]);
    return [pp.pos[0] + lx * c + lz * s, pp.pos[1] + ly, pp.pos[2] - lx * s + lz * c];
  };
  host.props = [
    { level: AUTHORED_MODEL_LEVEL, model: modelNumber(model.id), name: model.name, pos: [...model.anchor] as V3, yaw: 0, scale: 1 },
    { level: AUTHORED_MODEL_LEVEL, model: modelNumber(model.id), name: model.name, pos: [40, 7, -12], yaw: 135, scale: 2.5 },
  ];
  const vertAt = (i: number): V3 => [model.vertices[i * 3], model.vertices[i * 3 + 1], model.vertices[i * 3 + 2]];
  const before = host.props.map(pp => Array.from({ length: model.vertices.length / 3 }, (_, i) => poseOf(pp, vertAt(i), model.anchor)));
  const absorbed = rebaseModelToPlacement(host, model, host.props[1]);
  check(!!absorbed && absorbed.rotation.yaw === 135 && absorbed.scale === 2.5, 'rebase reports the absorbed placement pose');
  check(host.props[1].yaw === 0 && host.props[1].scale === 1 && model.anchor.join(',') === host.props[1].pos.join(','),
    'rebase seats the picked placement as the identity/home pose');
  let worstRebase = 0;
  host.props.forEach((pp, p) => before[p].forEach((was, i) => {
    const now = poseOf(pp, vertAt(i), model.anchor);
    worstRebase = Math.max(worstRebase, Math.hypot(now[0] - was[0], now[1] - was[1], now[2] - was[2]));
  }));
  check(worstRebase < 1e-9, 'rebase moves nothing rendered: every placement of the model lands exactly where it was');
  check(rebaseModelToPlacement(host, model, host.props[1]) === null, 'rebasing onto the home placement is a no-op');

  // The same contract with TILT in play (docs/012). Absorbing a rotation that is not a yaw means the other
  // placements can no longer re-derive by subtracting one angle — they compose with the absorbed pose's
  // inverse — so this is the check that the general path is as exact as the yaw-only one it generalizes.
  const posedBy = (pp: PlacedProp, v: V3, anchor: V3): V3 => {
    const local: V3 = [pp.scale * (v[0] - anchor[0]), pp.scale * (v[1] - anchor[1]), pp.scale * (v[2] - anchor[2])];
    const r = rotateByPlacement(local, pp);
    return [pp.pos[0] + r[0], pp.pos[1] + r[1], pp.pos[2] + r[2]];
  };
  host.props = [
    { level: AUTHORED_MODEL_LEVEL, model: modelNumber(model.id), name: model.name,
      pos: [-8, 2, 19], yaw: 20, pitch: 35, scale: 0.6 },
    { level: AUTHORED_MODEL_LEVEL, model: modelNumber(model.id), name: model.name,
      pos: [40, 7, -12], yaw: 135, pitch: -18, roll: 44, scale: 2.5 },
  ];
  const tiltedBefore = host.props.map(pp =>
    Array.from({ length: model.vertices.length / 3 }, (_, i) => posedBy(pp, vertAt(i), model.anchor)));
  const tiltedAbsorbed = rebaseModelToPlacement(host, model, host.props[1]);
  check(!!tiltedAbsorbed && tiltedAbsorbed.rotation.pitch === -18 && tiltedAbsorbed.rotation.roll === 44,
    'rebase reports the absorbed pose including its tilt');
  check(host.props[1].yaw === 0 && host.props[1].pitch === undefined && host.props[1].roll === undefined
    && host.props[1].scale === 1,
    'rebase seats the picked TILTED placement as the identity home pose, storing no residual tilt');
  let worstTilted = 0;
  host.props.forEach((pp, p) => tiltedBefore[p].forEach((was, i) => {
    const now = posedBy(pp, vertAt(i), model.anchor);
    worstTilted = Math.max(worstTilted, Math.hypot(now[0] - was[0], now[1] - was[1], now[2] - was[2]));
  }));
  check(worstTilted < 1e-9,
    `rebasing a tilted placement moves nothing rendered either (worst ${worstTilted.toExponential(1)} m)`);
}

console.log(failures ? '\nMESHOPS-LOFT: FAIL' : '\nMESHOPS-LOFT: PASS');
process.exit(failures ? 1 : 0);
