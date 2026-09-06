/**
 * Headless checks for the geometry-preserving slides (src/core/mesh/slide.ts, docs/017): the control net
 * re-cut over the SAME surface, the auto-merge weld a slide arms when it reaches its neighbour, how a
 * slide reads its parameter off the cursor, the host's clone/re-cut/install path, the CELL slide, and the
 * 2-D exact slide across the XZ tangent pad.
 * Run: `npx tsx test/meshops-slide.test.ts`
 *
 * Asserts that a slide re-cuts the control net over the SAME surface (the doc's vertices + directed
 * handles + twist offsets round-trip a whole 16-CP net, and a slid quad is the exact sub-patch of itself).
 *
 * Split out of test/meshops.test.ts; the grid fixture and the `check()` tally live in
 * test/meshops.fixture.ts, shared with the other `meshops-*` checks.
 */
import { meshSetHandle, meshSetTwist } from '../src/core/doc/mountain';
import { meshFromDoc, quadControlPoints } from '../src/core/mesh/topology';
import { patchPoint, patchNormal, cubicPoint, nearestCubicT, splitCubic, splitPatchU, splitPatchV } from '../src/core/math/bezier';
import { add, len, mul, sub } from '../src/core/math/vec';
import { meshContext, applyVertexWeld, checkManifold, ekey } from '../src/core/mesh/ops';
import { SLIDE_EPS, SLIDE_MERGE_SNAP, applySlidePlan, edgeSlideTargets, planCellSlide, slideEdgesInQuads, slideQuadrantTargets, slideVertexAlongEdge, slideVertexOnPatch, slideVerticesAlongEdges, slideWeldPairs, vertexSlideWeldPairs, writeQuadControlPoints, type SlidePass } from '../src/core/mesh/slide';
import { getVertex, setVertex } from '../src/core/doc/doc-edit';
import { buildMountainPreview } from '../src/core/mesh/tessellation';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { watertight, hasNaN, GRID_COLS, GRID_ROWS, freshGrid, cellRows, cellCols, V0, Q0 } from './meshops.fixture';
import { check, failures } from './check';

// ---- 17. slides: the control net re-cut over the SAME surface (src/core/mesh/slide.ts) ---------------------------
{
  const dist = (a: V3, b: V3) => len(sub(a, b));
  const at = (c: [V3, V3, V3, V3], s: number) => cubicPoint(c[0], c[1], c[2], c[3], s);
  /** The quad's live 16-CP net, re-derived from the doc (corners + directed handles + twist offsets). */
  const netOf = (doc: QuadMeshDoc, q: number): V3[] => {
    const { mesh, edgeHandle } = meshFromDoc(doc);
    return quadControlPoints(mesh, edgeHandle, q, doc.quadTwist?.[q]);
  };
  const netErr = (a: V3[], b: V3[]) => Math.max(...a.map((p, i) => dist(p, b[i])));
  /** The edge's live cubic: its two corners and the two directed handles the patches read. */
  const cubicOf = (doc: QuadMeshDoc, x: number, y: number): [V3, V3, V3, V3] => {
    const { mesh, edgeHandle } = meshFromDoc(doc);
    const P = (i: number): V3 => [mesh.vertices[i * 3], mesh.vertices[i * 3 + 1], mesh.vertices[i * 3 + 2]];
    const Px = P(x), Py = P(y);
    return [Px, add(Px, edgeHandle(x, y)), add(Py, edgeHandle(y, x)), Py];
  };
  const QI = 3 * cellCols + 5;   // an interior quad — every boundary shared with a neighbour, no rim degeneracy

  // ---- writeQuadControlPoints round-trip: the doc's storage spans the whole bicubic net
  {
    const doc = freshGrid();
    meshSetTwist(doc, QI, 1, [0.4, -0.9, 0.6]);        // a sculpted interior, so the twist path carries a real offset
    const cur = netOf(doc, QI);
    writeQuadControlPoints(doc, QI, cur);
    const eSame = netErr(netOf(doc, QI), cur);
    check(eSame < 1e-9, `slide: writing a quad's CURRENT net back is a no-op (max err ${eSame.toExponential(2)})`);

    // an ARBITRARY net: corners, boundary handles AND interiors all move, so the twist offset can only land if
    // its zero-twist base is re-derived AFTER the corners + handles are written
    const want = cur.map((p, i): V3 => add(p, [Math.sin(i * 1.7) * 2, Math.cos(i * 2.3) * 1.5, Math.sin(i * 0.9) * 2.5]));
    writeQuadControlPoints(doc, QI, want);
    const eArb = netErr(netOf(doc, QI), want);
    check(eArb < 1e-9, `slide: an arbitrary 16-CP net round-trips through the doc (max err ${eArb.toExponential(2)})`);
    check(!hasNaN(doc) && watertight(doc).ok, 'slide: writeQuadControlPoints leaves the doc finite + watertight');
  }

  // ---- surface exactness: a slid quad IS the de Casteljau sub-patch of itself, on all four boundaries
  const T = 0.3;
  const branch = (name: string, pick: (q: number[]) => [number, number], remap: (u: number, v: number) => [number, number]) => {
    const doc = freshGrid();
    const V1 = doc.vertices.length, Q1 = doc.quads.length;
    const cp0 = netOf(doc, QI);
    slideEdgesInQuads(doc, [{ quad: QI, edge: pick(doc.quads[QI]) }], T);
    const cp1 = netOf(doc, QI);
    let max = 0;
    for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
      const [pu, pv] = remap(i / 12, j / 12);
      max = Math.max(max, dist(patchPoint(cp1, i / 12, j / 12), patchPoint(cp0, pu, pv)));
    }
    check(max < 1e-9, `slide ${name}: the quad re-evaluates its own parent surface (max err ${max.toExponential(2)})`);
    check(!hasNaN(doc) && watertight(doc).ok, `slide ${name}: finite + watertight`);
    check(doc.vertices.length === V1 && doc.quads.length === Q1, `slide ${name}: topology untouched (a slide adds nothing)`);
  };
  branch('A–B (u=0, splitPatchU.upper)', q => [q[0], q[1]], (u, v) => [T + (1 - T) * u, v]);
  branch('C–D (u=1, splitPatchU.lower)', q => [q[2], q[3]], (u, v) => [(1 - T) * u, v]);
  branch('A–C (v=0, splitPatchV.upper)', q => [q[0], q[2]], (u, v) => [u, T + (1 - T) * v]);
  branch('B–D (v=1, splitPatchV.lower)', q => [q[1], q[3]], (u, v) => [u, (1 - T) * v]);

  // ---- a whole loop: adjacent quads share the CROSS edge the slide cuts, so each still lands on its own
  // sub-patch — the property the read-every-net-before-writing-any pass buys (a half-written doc would feed the
  // second quad a corner the first had already moved).
  {
    const doc = freshGrid();
    const row = [QI, QI + 1, QI + 2, QI + 3];
    const cp0 = row.map(q => netOf(doc, q));
    slideEdgesInQuads(doc, row.map(q => ({ quad: q, edge: [doc.quads[q][0], doc.quads[q][1]] as [number, number] })), T);
    let max = 0;
    row.forEach((q, k) => {
      const cp1 = netOf(doc, q);
      for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) max = Math.max(max, dist(patchPoint(cp1, i / 8, j / 8), patchPoint(cp0[k], T + (1 - T) * (i / 8), j / 8)));
    });
    check(max < 1e-9, `slide loop: every quad in the run re-evaluates its own parent surface (max err ${max.toExponential(2)})`);
    check(!hasNaN(doc) && watertight(doc).ok, 'slide loop: finite + watertight');
  }

  // ---- curve exactness: a vertex slide re-cuts its own boundary cubic and nothing else
  {
    const doc = freshGrid();
    const [a, b] = doc.quads[QI];
    const before = doc.vertices.slice();
    const old = cubicOf(doc, a, b);
    slideVertexAlongEdge(doc, a, b, 0.4);
    const now = cubicOf(doc, a, b);
    let max = 0;
    for (let i = 0; i <= 64; i++) { const s = i / 64; max = Math.max(max, dist(at(now, s), at(old, 0.4 + 0.6 * s))); }
    check(max < 1e-9, `slide vertex: the a–b curve is the parent re-cut over [t,1] (max err ${max.toExponential(2)})`);
    const others = before.every((v, i) => Math.floor(i / 3) === a || v === doc.vertices[i]);
    check(others, 'slide vertex: only the slid vertex moves; every other corner is bit-identical');
    check(!hasNaN(doc) && watertight(doc).ok, 'slide vertex: finite + watertight');
  }

  // ---- the clamp: a slide never reaches an end, and at the clamp it is a PARAMETRIC no-op. The moved corner
  // still travels 3·SLIDE_EPS·|handle| along the curve (≈3 mm on the 30 m default grid) — the bound below is
  // scale-free, and every corner the slide does not name stays bit-identical.
  {
    const doc = freshGrid();
    const before = doc.vertices.slice();
    const [a, b] = doc.quads[QI];
    const chord = dist([before[a * 3], before[a * 3 + 1], before[a * 3 + 2]], [before[b * 3], before[b * 3 + 1], before[b * 3 + 2]]);
    slideVertexAlongEdge(doc, a, b, 0);                    // clamped up to SLIDE_EPS
    const movedV = dist([before[a * 3], before[a * 3 + 1], before[a * 3 + 2]], [doc.vertices[a * 3], doc.vertices[a * 3 + 1], doc.vertices[a * 3 + 2]]);
    check(movedV > 0 && movedV < 2 * SLIDE_EPS * chord, `slide t≈0: the vertex barely moves (${movedV.toExponential(2)} m of a ${chord.toFixed(1)} m edge)`);
    check(before.every((v, i) => Math.floor(i / 3) === a || v === doc.vertices[i]), 'slide t≈0: every other corner bit-identical');

    const doc2 = freshGrid();
    const before2 = doc2.vertices.slice();
    const [a2, b2, , d2] = doc2.quads[QI];
    slideEdgesInQuads(doc2, [{ quad: QI, edge: [a2, b2] }], 0);
    let maxE = 0;
    for (let i = 0; i < before2.length; i++) maxE = Math.max(maxE, Math.abs(before2[i] - doc2.vertices[i]));
    check(maxE > 0 && maxE < 2 * SLIDE_EPS * chord, `slide edge t≈0: the edge barely moves (${maxE.toExponential(2)} m)`);
    const held = before2.every((v, i) => { const id = Math.floor(i / 3); return id === a2 || id === b2 || v === doc2.vertices[i]; });
    check(held, 'slide edge t≈0: only the slid edge\'s two corners move; the far edge is bit-identical');
    check(doc2.vertices[d2 * 3] === before2[d2 * 3], 'slide edge: the opposite corners are copied through untouched');
  }

  // ---- guards: a WEDGE (collapsed C===D row) and a non-boundary edge are skipped, not crashed on
  {
    const r = applyVertexWeld(freshGrid(), [[3 * GRID_COLS + 2, 2 * GRID_COLS + 2]]);
    check(r.ok, 'slide guard: wedge fixture built by welding an adjacent edge');
    if (r.ok) {
      const doc = r.doc;
      const wq = doc.quads.findIndex(q => q[2] === q[3]);
      const nq = doc.quads.findIndex(q => q[2] !== q[3]);
      check(wq >= 0, 'slide guard: the fixture carries a wedge quad');
      const snap = () => JSON.stringify([doc.vertices, doc.edgeHandles ?? {}, doc.quadTwist ?? {}]);
      const s0 = snap();

      slideEdgesInQuads(doc, [{ quad: wq, edge: [doc.quads[wq][0], doc.quads[wq][1]] }], 0.3);
      check(snap() === s0, 'slide guard: a wedge quad is skipped, the doc unchanged');
      writeQuadControlPoints(doc, wq, netOf(doc, wq));
      check(snap() === s0, 'slide guard: writeQuadControlPoints refuses a wedge, the doc unchanged');

      slideEdgesInQuads(doc, [{ quad: nq, edge: [doc.quads[nq][0], doc.quads[nq][3]] }], 0.3);  // the A–D diagonal
      check(snap() === s0, 'slide guard: an edge that is not one of the quad\'s four boundaries is skipped');
      check(!hasNaN(doc) && watertight(doc).ok, 'slide guard: finite + watertight');
    }
  }
}

// ---- 18. vertex weld: the slide's auto-merge — a vertex/edge that reaches its neighbour FUSES with it -------
// `watertight()` hashes a wedge's collapsed D–C side under the shared key `ekey(C,C)`, so k wedges on ONE apex
// read as one edge with k cells: it stays valid up to 2 (the tally `checkManifold` skips the self-edge for).
// An interior-edge weld makes exactly 2 wedges on the surviving vertex, so it is still a fair watertight test.
{
  const cols = GRID_COLS;
  const vid = (r: number, c: number) => r * cols + c;         // grid vertex id
  const cid = (r: number, c: number) => r * cellCols + c;     // grid cell (quad) id
  const isWedge = (q: number[]) => new Set(q).size === 3 && q[2] === q[3];

  // ---- 18a. an INTERIOR edge: both cells that shared it fold into wedges on the survivor
  {
    const doc = freshGrid();
    const from = vid(3, 3), into = vid(3, 4);
    const V0d = doc.vertices.length / 3, Q0d = doc.quads.length;
    const r = applyVertexWeld(doc, [[from, into]]);
    check(r.ok, 'weld: interior edge accepted');
    if (r.ok) {
      check(r.doc.vertices.length / 3 === V0d - 1, `weld: exactly one vertex disappears (${V0d - r.doc.vertices.length / 3})`);
      check(r.doc.quads.length === Q0d, `weld: no cell is dropped (${r.doc.quads.length - Q0d})`);
      const wedges = r.doc.quads.filter(isWedge);
      check(wedges.length === 2, `weld: the two cells that shared the edge become wedges (${wedges.length})`);
      // only `from` is pruned and from < into, so the survivor compacts down onto `from`'s id
      const s = into - 1;
      check(wedges.every(w => w[2] === s && w[3] === s), 'weld: both wedges fold onto the surviving vertex');
      check(r.doc.quads[cid(2, 3)][2] === s && r.doc.quads[cid(3, 3)][2] === s, 'weld: the wedges are the two cells that shared the edge');
      const wt = watertight(r.doc);
      check(wt.ok && !hasNaN(r.doc), `weld: watertight (no 3+ edges; over=${wt.over}), finite`);
      check(checkManifold(r.doc.quads).ok, 'weld: the manifold guard accepts the result');
      const P = [doc.vertices[into * 3], doc.vertices[into * 3 + 1], doc.vertices[into * 3 + 2]];
      check([0, 1, 2].every(k => r.doc.vertices[s * 3 + k] === P[k]), 'weld: the survivor keeps `into`\'s position');
      // the derived quilt still tessellates (the survivor is now a 6-valence pole with two wedges on it)
      const pv = buildMountainPreview(r.doc);
      check(!pv.positions.some(x => !Number.isFinite(x)) && !pv.normals.some(x => !Number.isFinite(x)), 'weld: derived quilt + normals finite');
      const { mesh: rm, edgeHandle: reh } = meshFromDoc(r.doc);
      let skyward = true;
      r.doc.quads.forEach((q, qi) => { if (isWedge(q)) { const n = patchNormal(quadControlPoints(rm, reh, qi), 0.4, 0.5); if (n[1] <= 0) skyward = false; } });
      check(skyward, 'weld: the wedges are wound skyward (the cycle rotation keeps the handedness)');
    }
  }

  // ---- 18b. a RIM edge: only the one cell on it folds into a wedge
  {
    const doc = freshGrid();
    const V0d = doc.vertices.length / 3, Q0d = doc.quads.length;
    const r = applyVertexWeld(doc, [[vid(0, 3), vid(0, 4)]]);
    check(r.ok, 'weld rim: accepted');
    if (r.ok) {
      check(r.doc.vertices.length / 3 === V0d - 1 && r.doc.quads.length === Q0d, 'weld rim: -1 vertex, no cell dropped');
      check(r.doc.quads.filter(isWedge).length === 1, `weld rim: one wedge (${r.doc.quads.filter(isWedge).length})`);
      const wt = watertight(r.doc);
      check(wt.ok && !hasNaN(r.doc) && checkManifold(r.doc.quads).ok, 'weld rim: watertight, finite, manifold');
    }
  }

  // ---- 18c. a whole edge LOOP welded into the next one: that row of cells (and its vertices) disappears
  {
    const doc = freshGrid();
    const V0d = doc.vertices.length / 3, Q0d = doc.quads.length;
    const R = 2;
    const pairs: [number, number][] = [];
    for (let c = 0; c < cols; c++) pairs.push([vid(R, c), vid(R + 1, c)]);
    const r = applyVertexWeld(doc, pairs);
    check(r.ok, 'weld loop: accepted');
    if (r.ok) {
      check(r.doc.quads.length === Q0d - cellCols, `weld loop: exactly one cell row dropped (${Q0d - r.doc.quads.length} of ${cellCols})`);
      check(r.doc.vertices.length / 3 === V0d - cols, `weld loop: exactly one vertex row dropped (${V0d - r.doc.vertices.length / 3} of ${cols})`);
      check(r.doc.quads.every(q => new Set(q).size === 4), 'weld loop: a whole-loop merge leaves no wedge — the cells collapsed outright');
      const wt = watertight(r.doc);
      check(wt.ok && !hasNaN(r.doc) && checkManifold(r.doc.quads).ok, 'weld loop: watertight, finite, manifold');
      const pv = buildMountainPreview(r.doc);
      check(!pv.positions.some(x => !Number.isFinite(x)), 'weld loop: derived quilt finite');
    }
  }

  // ---- 18d. chains resolve: weld a→b and b→c and all three become c
  {
    const doc = freshGrid();
    const a = vid(3, 2), b = vid(3, 3), c = vid(3, 4);
    const V0d = doc.vertices.length / 3;
    const Pc: [number, number, number] = [doc.vertices[c * 3], doc.vertices[c * 3 + 1], doc.vertices[c * 3 + 2]];
    const r = applyVertexWeld(doc, [[a, b], [b, c]]);
    check(r.ok, 'weld chain: accepted');
    if (r.ok) {
      check(r.doc.vertices.length / 3 === V0d - 2, `weld chain: two of the three vertices disappear (${V0d - r.doc.vertices.length / 3})`);
      const s = c - 2; // a and b both pruned, both below c
      check([0, 1, 2].every(k => r.doc.vertices[s * 3 + k] === Pc[k]), 'weld chain: the survivor sits at c (the chain\'s final `into`)');
      check(r.doc.quads.filter(isWedge).length === 4, `weld chain: the four cells around the run become wedges (${r.doc.quads.filter(isWedge).length})`);
      check(r.doc.quads.every(q => q.every(v => v < V0d - 2)), 'weld chain: every corner id is in the compacted range');
      // the eight cells that touched a, b or c now all name the one survivor
      check(r.doc.quads.filter(q => q.includes(s)).length === 8, `weld chain: the survivor absorbs all three rings (${r.doc.quads.filter(q => q.includes(s)).length} cells)`);
      // NOT watertight() here: four wedges share the apex `s`, and the helper hashes every collapsed D–C side
      // under the one `ekey(s,s)` key, so it reads them as a single edge on four cells. checkManifold — which
      // drops the self-edge before tallying — is the real guard, and it accepts.
      check(checkManifold(r.doc.quads).ok && !hasNaN(r.doc), 'weld chain: manifold + finite');
    }
  }

  // ---- 18e. per-quad data follows the quads through the drop + compaction
  {
    const doc = freshGrid();
    doc.quadPaint = {}; doc.quadTex = {};
    doc.quads.forEach((_, q) => { doc.quadPaint![q] = q; doc.quadTex![q] = `T/${q}.png`; }); // a unique tag per cell
    const R = 2;
    const pairs: [number, number][] = [];
    for (let c = 0; c < cols; c++) pairs.push([vid(R, c), vid(R + 1, c)]);
    const r = applyVertexWeld(doc, pairs);
    check(r.ok, 'weld paint: accepted');
    if (r.ok) {
      const dropped = new Set(Array.from({ length: cellCols }, (_, i) => cid(R, i)));
      const survivors = doc.quads.map((_, q) => q).filter(q => !dropped.has(q));   // ascending old id = new id order
      check(r.doc.quads.length === survivors.length, 'weld paint: the surviving cell count matches');
      const carried = survivors.every((oldQ, newQ) => r.doc.quadPaint?.[newQ] === oldQ && r.doc.quadTex?.[newQ] === `T/${oldQ}.png`);
      check(carried, 'weld paint: every surviving cell still carries its OWN SurfaceType + tile after compaction');
      check(Object.keys(r.doc.quadPaint ?? {}).length === survivors.length, 'weld paint: the dropped row\'s paint is gone (no orphan keys)');
    }

    // twist: an untouched cell keeps its interior sculpt; a cell that collapsed to a wedge resets it (no drops
    // here, so quad ids are stable across the weld)
    const tdoc = freshGrid();
    const qWedge = cid(3, 3), qFar = cid(6, 10);
    meshSetTwist(tdoc, qWedge, 0, [4, 5, 6]);
    meshSetTwist(tdoc, qFar, 0, [1, 2, 3]);
    const rt = applyVertexWeld(tdoc, [[vid(3, 3), vid(3, 4)]]);
    check(rt.ok, 'weld twist: accepted');
    if (rt.ok) {
      check(rt.doc.quadTwist?.[qFar]?.[0][1] === 2, 'weld twist: an untouched cell keeps its interior twist');
      check(rt.doc.quadTwist?.[qWedge] === undefined, 'weld twist: a cell that folded into a wedge resets its twist');
    }

    // edge handles: remapped onto the survivor; the fused pair's own directed keys are dropped (no self-edge)
    const hdoc = freshGrid();
    const from = vid(3, 3), into = vid(3, 4), up = vid(2, 3);
    hdoc.edgeHandles = { [`${from}>${into}`]: [9, 9, 9], [`${into}>${from}`]: [8, 8, 8], [`${from}>${up}`]: [1, 2, 3] };
    const rh = applyVertexWeld(hdoc, [[from, into]]);
    check(rh.ok, 'weld handles: accepted');
    if (rh.ok) {
      const keys = Object.keys(rh.doc.edgeHandles ?? {});
      check(keys.every(k => { const [x, y] = k.split('>'); return x !== y; }), 'weld handles: the fused pair leaves no self-edge handle');
      check(keys.length === 1 && rh.doc.edgeHandles![`${into - 1}>${up}`]?.[1] === 2, 'weld handles: a crease on the vanished vertex follows onto the survivor');
    }

    // a handle COLLISION: fold a rim vertex onto its next-but-one neighbour, so the two rim edges either side of
    // the shared neighbour land on the ONE directed key. (Both were single-cell rim edges, so the merged edge
    // carries 2 cells and the guard passes — the only shape where two distinct cage edges can collide; an
    // interior pair would put 4 cells on the edge and be rejected.) The lowest original (from, to) wins.
    const cdoc = freshGrid();
    const lo = vid(0, 3), mid0 = vid(0, 4), hi = vid(0, 5);
    cdoc.edgeHandles = { [`${lo}>${mid0}`]: [1, 1, 1], [`${hi}>${mid0}`]: [2, 2, 2] };
    const rc = applyVertexWeld(cdoc, [[lo, hi]]);
    check(rc.ok, 'weld handle collision: the rim fold is accepted');
    if (rc.ok) {
      check(Object.keys(rc.doc.edgeHandles ?? {}).length === 1, 'weld handle collision: the two fused cage edges leave one handle');
      check(rc.doc.edgeHandles?.[`${hi - 1}>${mid0 - 1}`]?.[0] === 1, 'weld handle collision: the lowest original (from,to) wins — deterministic');
    }
  }

  // ---- 18f. purity: the input doc is untouched, on both the accepted and the rejected path
  {
    const doc = freshGrid();
    doc.quadPaint = { 0: 5 };
    doc.quadTex = { 0: 'DONOR/0019.png' };
    doc.edgeHandles = { [`${vid(3, 3)}>${vid(3, 4)}`]: [1, 2, 3] };
    meshSetTwist(doc, cid(3, 3), 1, [0.5, -0.5, 0.5]);
    const snap = JSON.stringify(doc);
    const r = applyVertexWeld(doc, [[vid(3, 3), vid(3, 4)]]);
    check(r.ok, 'weld purity: accepted');
    check(JSON.stringify(doc) === snap, 'weld purity: the input doc is byte-identical after an accepted weld');
    applyVertexWeld(doc, [[vid(3, 3), vid(4, 4)]]);
    check(JSON.stringify(doc) === snap, 'weld purity: the input doc is byte-identical after a rejected weld');
  }

  // ---- 18g. guards: a DIAGONAL weld can't be encoded; degenerate requests are rejected, never thrown
  {
    const doc = freshGrid();
    let threw = false, diag: ReturnType<typeof applyVertexWeld> = { ok: false, error: 'not run' };
    try { diag = applyVertexWeld(doc, [[vid(3, 3), vid(4, 4)]]); } catch { threw = true; } // the two ends of cell (3,3)'s diagonal
    check(!threw, 'weld diagonal: does not throw');
    check(!diag.ok, 'weld diagonal: a cell\'s non-cycle-adjacent corners cannot fuse — rejected');
    check(!diag.ok && /DIAGONAL/.test(diag.error), `weld diagonal: the error names the cause (${diag.ok ? '' : diag.error})`);
    check(!applyVertexWeld(doc, []).ok, 'weld guard: no pairs is rejected');
    check(!applyVertexWeld(doc, [[7, 7]]).ok, 'weld guard: a vertex welded to itself is rejected');
    check(!applyVertexWeld(doc, [[0, 999999]]).ok, 'weld guard: an out-of-range vertex id is rejected');
    check(!applyVertexWeld(doc, [[-1, 0]]).ok, 'weld guard: a negative vertex id is rejected');
    // folding a row onto itself would make one edge carry 4 cells — the manifold guard catches it
    check(!applyVertexWeld(doc, [[vid(3, 3), vid(3, 5)]]).ok, 'weld guard: a fold that makes an edge shared by 3+ cells is rejected');
  }
}

// ---- 19. nearestCubicT: how a slide reads its parameter off the cursor ---------------------------------------
// A Surface-mode arrow drag is parameterised by WHERE ALONG the frozen edge the cursor landed, not by how far it
// travelled — a delta on a straight axis walks off a curved edge. So the drag projects the anchor onto the frozen
// cubic. Endpoint exactness is load-bearing: t = 1 is precisely "the cursor is at or past the neighbour", which
// is the condition that clamps the slide and arms its merge.
{
  const C: [V3, V3, V3, V3] = [[-4, 2, 1], [3, 9, -6], [14, -5, 11], [21, 7, 4]]; // non-planar, asymmetric
  const dist = (a: V3, b: V3) => len(sub(a, b));
  const at = (s: number) => cubicPoint(C[0], C[1], C[2], C[3], s);
  const T = (p: V3) => nearestCubicT(C[0], C[1], C[2], C[3], p);
  const SCAN = 200000;
  /** Ground truth: the nearest parameter over a dense scan of the same curve. */
  const scanT = (p: V3) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i <= SCAN; i++) { const s = i / SCAN, d = dist(at(s), p); if (d < bd) { bd = d; best = s; } }
    return best;
  };

  let onErr = 0;
  for (const t of [0, 0.017, 0.13, 0.35, 0.5, 0.62, 0.77, 0.95, 1]) onErr = Math.max(onErr, Math.abs(T(at(t)) - t));
  check(onErr < 1e-4, `nearestCubicT: a point ON the curve recovers its own t (max err ${onErr.toExponential(2)})`);

  let offErr = 0, offWorse = 0;
  for (let k = 0; k < 40; k++) {
    const p: V3 = [Math.sin(k * 1.3) * 26 + 6, Math.cos(k * 2.1) * 14, Math.sin(k * 0.7) * 18 + 3]; // scattered around the curve
    const t = T(p), s = scanT(p);
    offErr = Math.max(offErr, Math.abs(t - s));
    offWorse = Math.max(offWorse, dist(at(t), p) - dist(at(s), p)); // and never a farther point than the scan's best
  }
  check(offErr < 1e-4, `nearestCubicT: an off-curve point finds the true nearest (max Δt vs a ${SCAN}-step scan ${offErr.toExponential(2)})`);
  check(offWorse < 1e-9, `nearestCubicT: ...and never lands farther from p than the scan does (Δd ${offWorse.toExponential(2)})`);

  // past either end the perpendicular has no foot on the curve, so the endpoint itself comes back — exactly
  check(T(add(C[3], mul(sub(C[3], C[2]), 3))) === 1, 'nearestCubicT: a point past the far end returns t = 1 exactly (the merge condition)');
  check(T(add(C[0], mul(sub(C[0], C[1]), 3))) === 0, 'nearestCubicT: a point behind the near end returns t = 0 exactly');
  check(T(C[0]) === 0 && T(C[3]) === 1, 'nearestCubicT: the endpoints themselves return 0 / 1');
}

// ---- 20. the host side of a Surface-mode arrow drag: clone the frozen doc, re-cut it, install ----------------
// Every drag frame runs `structuredClone(base) → slide*(clone) → the clone is the live doc`, always from the SAME
// frozen base. Headless, that path must (a) recover the parent curve at every t, (b) hold the clamp when the
// cursor runs past the neighbour, and (c) name the corners the slide actually arrived at as its weld pairs.
{
  const dist = (a: V3, b: V3) => len(sub(a, b));
  const at = (c: [V3, V3, V3, V3], s: number) => cubicPoint(c[0], c[1], c[2], c[3], s);
  const pv = (d: QuadMeshDoc, i: number): V3 => [d.vertices[i * 3], d.vertices[i * 3 + 1], d.vertices[i * 3 + 2]];
  /** The edge's live cubic (its corners + the two directed handles the patches read). */
  const cubicOf = (doc: QuadMeshDoc, x: number, y: number): [V3, V3, V3, V3] => {
    const { edgeHandle } = meshFromDoc(doc);
    const Px = pv(doc, x), Py = pv(doc, y);
    return [Px, add(Px, edgeHandle(x, y)), add(Py, edgeHandle(y, x)), Py];
  };

  const base = freshGrid();              // the drag-start document: frozen, never written
  const QI = 3 * cellCols + 5;                // an interior quad, every boundary shared
  const [qa, qb, qc, qd] = base.quads[QI];    // [A@(u0,v0), B@(u0,v1), C@(u1,v0), D@(u1,v1)]

  // ---- a corner drag: each frame re-cuts the frozen base, so the A–B curve is always the parent over [t,1]
  {
    const parent = cubicOf(base, qa, qb);
    let maxRe = 0;
    for (const t of [0.05, 0.2, 0.45, 0.7, 0.9]) {          // the anchor dragged a little further each frame
      const doc = structuredClone(base);
      slideVertexAlongEdge(doc, qa, qb, t);
      const cut = cubicOf(doc, qa, qb);
      for (let i = 0; i <= 32; i++) { const s = i / 32; maxRe = Math.max(maxRe, dist(at(cut, s), at(parent, t + (1 - t) * s))); }
    }
    check(maxRe < 1e-9, `slide host: every frame re-cuts the frozen base onto the parent curve (max err ${maxRe.toExponential(2)})`);

    // why the base is frozen: re-cutting the PREVIOUS frame's output composes the two cuts, so `t` would stop
    // naming a point on the parent and a long drag would run away from the cursor.
    const chained = structuredClone(base);
    slideVertexAlongEdge(chained, qa, qb, 0.5);
    slideVertexAlongEdge(chained, qa, qb, 0.5);
    const composed = structuredClone(base);
    slideVertexAlongEdge(composed, qa, qb, 0.75); // 0.5 of [0.5,1] IS 0.75 of the parent
    check(dist(pv(chained, qa), pv(composed, qa)) < 1e-9, 'slide host: a re-cut of a re-cut compounds (0.5 then 0.5 = 0.75 of the parent) — hence the frozen base');
  }

  // ---- the bound: dragged past the neighbour, the corner holds short of it and a release merges the two
  {
    const far = structuredClone(base);
    slideVertexAlongEdge(far, qa, qb, 1.4);                  // the cursor ran off the far end
    const span = dist(pv(base, qa), pv(base, qb));
    const gap = dist(pv(far, qa), pv(base, qb));
    check(gap > 0 && gap < 1e-2 * span, `slide t>1: the clamp holds — the corner stops short of the neighbour (${gap.toExponential(2)} m of a ${span.toFixed(1)} m edge)`);
    check(pv(far, qb).every((x, k) => x === pv(base, qb)[k]), 'slide t>1: the neighbour itself never moves');
    const w = applyVertexWeld(far, [[qa, qb]]);              // the pair the host emits for a corner drag
    check(w.ok, 'slide t>1: releasing there welds the clamped corner into the neighbour');
    check(w.ok && w.doc.vertices.length / 3 === base.vertices.length / 3 - 1, 'slide t>1: the merge retires exactly one vertex');
  }

  // ---- the far-corner pairing, read off the storage contract [A@(u0,v0), B@(u0,v1), C@(u1,v0), D@(u1,v1)]:
  // a corner keeps its coordinate on the moved edge's own axis and travels along the other one.
  {
    const eq = base.quads[QI];
    const same = (got: unknown, want: unknown) => JSON.stringify(got) === JSON.stringify(want);
    check(same(edgeSlideTargets(eq, [qa, qb]), [[qa, qc], [qb, qd]]), 'edge slide targets: the u=0 row A–B rides its columns to C / D');
    check(same(edgeSlideTargets(eq, [qc, qd]), [[qc, qa], [qd, qb]]), 'edge slide targets: the u=1 row C–D rides back up to A / B');
    check(same(edgeSlideTargets(eq, [qa, qc]), [[qa, qb], [qc, qd]]), 'edge slide targets: the v=0 column A–C rides its rows to B / D');
    check(same(edgeSlideTargets(eq, [qb, qd]), [[qb, qa], [qd, qc]]), 'edge slide targets: the v=1 column B–D rides back to A / C');
    check(same(edgeSlideTargets(eq, [qb, qa]), [[qa, qc], [qb, qd]]), 'edge slide targets: the edge is unordered — B–A names the same side as A–B');
    check(edgeSlideTargets(eq, [qa, qd]) === null, 'edge slide targets: the A–D diagonal is no boundary — no rail to ride');
    check(edgeSlideTargets([qa, qb, qc, qc], [qa, qb]) === null, 'edge slide targets: a wedge\'s collapsed row has no rail (the slide skips it too)');

    // and the pairing is GEOMETRY, not bookkeeping: slid to its far clamp, A lands on C and B on D
    const eDoc = structuredClone(base);
    slideEdgesInQuads(eDoc, [{ quad: QI, edge: [qa, qb] }], 1.4);
    const runA = dist(pv(base, qa), pv(base, qc)), runB = dist(pv(base, qb), pv(base, qd));
    check(dist(pv(eDoc, qa), pv(base, qc)) < 1e-2 * runA, 'slide edge t>1: the clamped A has arrived at C');
    check(dist(pv(eDoc, qb), pv(base, qd)) < 1e-2 * runB, 'slide edge t>1: ...and B at D — exactly the pairs slideWeldPairs emits');

    const pairs = slideWeldPairs(base.quads, [{ quad: QI, edge: [qa, qb] }]);
    check(same(pairs, [[qa, qc], [qb, qd]]), 'slideWeldPairs: one edge yields its two far-corner pairs');
    const w = applyVertexWeld(eDoc, pairs);
    check(w.ok, 'slide edge t>1: releasing there welds the edge into the far edge it arrived at');
    check(w.ok && w.doc.quads.length === base.quads.length - 1, 'slide edge t>1: the quad the edge swept through collapses away');
    check(w.ok && checkManifold(w.doc.quads).ok && !hasNaN(w.doc), 'slide edge t>1: the merged doc is manifold + finite');
  }

  // ---- an edge LOOP: one shared t, and the run's shared endpoints yield each weld pair exactly once
  {
    const row = [QI, QI + 1, QI + 2];
    const items = row.map(q => ({ quad: q, edge: [base.quads[q][0], base.quads[q][1]] as [number, number] }));
    const pairs = slideWeldPairs(base.quads, items);
    const wanted = new Set(row.flatMap(q => [`${base.quads[q][0]}>${base.quads[q][2]}`, `${base.quads[q][1]}>${base.quads[q][3]}`]));
    check(pairs.length === wanted.size, `slideWeldPairs: the run's shared endpoints are de-duplicated (${pairs.length} pairs, ${wanted.size} distinct)`);
    check(pairs.every(([f, i]) => wanted.has(`${f}>${i}`)), 'slideWeldPairs: every pair names a real column of one of the run\'s quads');

    const loop = structuredClone(base);
    slideEdgesInQuads(loop, items, 1.4);                     // the whole loop dragged past its far edge
    const ok = row.every(q => dist(pv(loop, base.quads[q][0]), pv(base, base.quads[q][2])) < 1e-2 * dist(pv(base, base.quads[q][0]), pv(base, base.quads[q][2])));
    check(ok, 'slide loop t>1: one shared t clamps every quad in the run against its own far edge');
    const w = applyVertexWeld(loop, pairs);
    check(w.ok && w.doc.quads.length === base.quads.length - row.length, `slide loop t>1: the merge drops the run's ${row.length} quads`);
    check(w.ok && checkManifold(w.doc.quads).ok, 'slide loop t>1: the merged doc is manifold');
  }
}

// ---- 21. CELL slide: a dragged face carries BOTH its boundaries — the trail across itself, the lead across the
// quad ahead (src/core/mesh/slide.ts `planCellSlide`) ---------------------------------------------------------------
// The exactness ledger this section pins: the LEADING quad is the exact sub-patch of itself; the dragged cell's two
// moved boundary CURVES are exact (each an iso-curve of an original patch at t); the dragged cell's SURFACE is not,
// because it now spans [t,1] of its own patch ∪ [0,t] of the next and two G1-joined bicubics are not one bicubic.
{
  const dist = (a: V3, b: V3) => len(sub(a, b));
  const cid = (r: number, c: number) => r * cellCols + c;
  const posOf = (doc: QuadMeshDoc) => (id: number): V3 => [doc.vertices[id * 3], doc.vertices[id * 3 + 1], doc.vertices[id * 3 + 2]];
  const netOf = (doc: QuadMeshDoc, q: number): V3[] => {
    const { mesh, edgeHandle } = meshFromDoc(doc);
    return quadControlPoints(mesh, edgeHandle, q, doc.quadTwist?.[q]);
  };
  const cubicOf = (doc: QuadMeshDoc, x: number, y: number): [V3, V3, V3, V3] => {
    const { edgeHandle } = meshFromDoc(doc);
    const P = posOf(doc), Px = P(x), Py = P(y);
    return [Px, add(Px, edgeHandle(x, y)), add(Py, edgeHandle(y, x)), Py];
  };
  const at = (c: [V3, V3, V3, V3], s: number) => cubicPoint(c[0], c[1], c[2], c[3], s);
  const same = (got: unknown, want: unknown) => JSON.stringify(got) === JSON.stringify(want);
  /** Every number the slide writes, with the sparse maps read in sorted key order — so two item orders can differ
   *  only in VALUES, never in the order the keys happened to be inserted. */
  const canon = (doc: QuadMeshDoc) => JSON.stringify({
    v: doc.vertices,
    h: Object.keys(doc.edgeHandles ?? {}).sort().map(k => [k, doc.edgeHandles![k]]),
    w: Object.keys(doc.quadTwist ?? {}).sort().map(k => [k, doc.quadTwist![+k]]),
  });
  /** Plan a drag of `cells` in +u (down the rows), the direction quad `q`'s A→C rail points. */
  const plan = (doc: QuadMeshDoc, cells: number[], q: number) => {
    const { mesh, adj } = meshContext(doc);
    const P = posOf(doc), [A, , C] = doc.quads[q];
    return planCellSlide(mesh, adj, cells, sub(P(C), P(A)), P);
  };
  const T = 0.3;
  const QC = cid(3, 5);               // an interior cell: a full ring of proper neighbours around it

  // ---- 21a. item order cannot change the doc (the two-pass frame write). A 2-across selection is the shape that
  // exercises both hazards at once: one item's far edge is another's moved edge, and two items share a rail.
  {
    const src = freshGrid();
    const p = plan(src, [QC, QC + 1], QC)!;
    check(p.items.length === 4, `cell slide order: two cells across the drag plan four items (${p.items.length})`);
    const orders = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [1, 3, 0, 2]];
    const docs = orders.map(o => { const d = freshGrid(); slideEdgesInQuads(d, o.map(i => p.items[i]), T); return d; });
    check(docs.every(d => canon(d) === canon(docs[0])), 'cell slide order: four permutations of the item list yield a bit-identical doc');
    check(docs.every(d => !hasNaN(d) && watertight(d).ok), 'cell slide order: finite + watertight');
    // and the resolution goes the right way: the lead edge is owned by the quad AHEAD of it, so it MOVES —
    // it is not left pinned at the default the trailing cell's far-edge pass laid down.
    const [, , qc] = src.quads[QC];
    check(dist(posOf(docs[0])(qc), posOf(src)(qc)) > 1e-3, 'cell slide order: the lead edge is written by the quad ahead of it, not left at its old seat');
  }

  // ---- 21b/c/d. one interior cell: N is exact, the two moved curves are exact, the cell's surface is not
  {
    const doc = freshGrid();
    const base = posOf(doc), [qa, qb, qc, qd] = doc.quads[QC];
    const N = QC + cellCols;                       // the quad ahead, across the lead edge C–D
    const p = plan(doc, [QC], QC)!;
    check(p.items.length === 2 && !p.blocked, `cell slide: one cell plans two items (${p.items.length}), not blocked`);
    check(p.items.some(i => i.quad === QC && ekey(i.edge[0], i.edge[1]) === ekey(qa, qb)), 'cell slide: the TRAIL edge A–B slides across the cell itself');
    check(p.items.some(i => i.quad === N && ekey(i.edge[0], i.edge[1]) === ekey(qc, qd)), 'cell slide: the LEAD edge C–D slides across the neighbour ahead');
    const diag = dist(base(qa), base(qd));
    const cpQ0 = netOf(doc, QC), cpN0 = netOf(doc, N);

    slideEdgesInQuads(doc, p.items, T);
    check(!hasNaN(doc) && watertight(doc).ok, 'cell slide: finite + watertight');
    check(doc.quads.length === Q0 && doc.vertices.length / 3 === V0, 'cell slide: topology untouched (a slide adds nothing)');

    // the LEADING quad is the exact de Casteljau sub-patch of itself — nothing but its own item writes it
    const cpN1 = netOf(doc, N);
    let maxN = 0;
    for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
      const u = i / 12, v = j / 12;
      maxN = Math.max(maxN, dist(patchPoint(cpN1, u, v), patchPoint(cpN0, T + (1 - T) * u, v)));
    }
    check(maxN < 1e-9, `cell slide: the LEADING quad re-evaluates its own parent surface exactly (max err ${maxN.toExponential(2)})`);

    // the dragged cell's two MOVED boundary curves are exact: the trail is Q's iso-curve at u=T, the lead is N's
    const trail = cubicOf(doc, qa, qb), lead = cubicOf(doc, qc, qd);
    let maxTC = 0, maxLC = 0;
    for (let i = 0; i <= 32; i++) {
      const v = i / 32;
      maxTC = Math.max(maxTC, dist(at(trail, v), patchPoint(cpQ0, T, v)));
      maxLC = Math.max(maxLC, dist(at(lead, v), patchPoint(cpN0, T, v)));
    }
    check(maxTC < 1e-9, `cell slide: the trail curve IS the iso-curve of its own quad at u=t (max err ${maxTC.toExponential(2)})`);
    check(maxLC < 1e-9, `cell slide: the lead curve IS the iso-curve of the quad ahead at u=t (max err ${maxLC.toExponential(2)})`);

    // ...and the cell BETWEEN them is a cubic interpolant across a G1 join, so it is NOT surface-exact. Two numbers
    // measure that, and only one of them is the off-surface error:
    //  - MATCHED-PARAMETER: |Qnew(u,v) − parent(u,v)| against the parent's own piecewise map (Q's polynomial while
    //    the point is still inside Q, N's once it has crossed). A single cubic rail cannot carry the arc-length of
    //    two joined cubics, so most of this is RE-PARAMETERISATION: the point is on the surface, just not at the
    //    parameter the map names. It is the number a naive comparison reports, and it overstates the damage.
    //  - GEOMETRIC: the true distance from the new patch to the parent point set. This is the surface error.
    const cpQ1 = netOf(doc, QC);
    let maxParam = 0;
    for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
      const u = i / 16, v = j / 16;
      const parent = u <= 1 - T ? patchPoint(cpQ0, T + u, v) : patchPoint(cpN0, u - (1 - T), v);
      maxParam = Math.max(maxParam, dist(patchPoint(cpQ1, u, v), parent));
    }
    /** Distance from `q` to patch `cp` restricted to u ∈ [u0,u1]: a coarse scan, then a shrinking window on the best. */
    const nearestOn = (cp: V3[], u0: number, u1: number, q: V3): number => {
      let bu = (u0 + u1) / 2, bv = 0.5, bd = Infinity, hu = (u1 - u0) / 2, hv = 0.5;
      for (let pass = 0; pass < 8; pass++) {
        const lu = Math.max(u0, bu - hu), ru = Math.min(u1, bu + hu);
        const lv = Math.max(0, bv - hv), rv = Math.min(1, bv + hv);
        const S = pass === 0 ? 24 : 8;
        let cu = bu, cv = bv;
        for (let i = 0; i <= S; i++) for (let j = 0; j <= S; j++) {
          const u = lu + (ru - lu) * (i / S), v = lv + (rv - lv) * (j / S);
          const d = dist(patchPoint(cp, u, v), q);
          if (d < bd) { bd = d; cu = u; cv = v; }
        }
        bu = cu; bv = cv; hu = (ru - lu) / S; hv = (rv - lv) / S;
      }
      return bd;
    };
    const offSurface = (q: V3) => Math.min(nearestOn(cpQ0, T, 1, q), nearestOn(cpN0, 0, T, q));
    let maxGeom = 0, edgeGeom = 0;
    for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
      const d = offSurface(patchPoint(cpQ1, i / 8, j / 8));
      maxGeom = Math.max(maxGeom, d);
      if (i === 0 || i === 8) edgeGeom = Math.max(edgeGeom, d);   // the two moved boundary curves: exact, by 21c
    }
    console.log(`      cell slide inexactness (t=${T}, ${diag.toFixed(2)} m quad diagonal):`
      + ` geometric off-surface ${maxGeom.toExponential(3)} m = ${(100 * maxGeom / diag).toFixed(3)}% of the diagonal;`
      + ` matched-parameter ${maxParam.toExponential(3)} m = ${(100 * maxParam / diag).toFixed(3)}% (mostly re-parameterisation, not surface error)`);
    check(edgeGeom < 1e-6, `cell slide: the off-surface probe reads ~0 on the two exact boundary curves (${edgeGeom.toExponential(2)} m) — it measures what it claims`);
    check(maxGeom < 0.03 * diag, `cell slide: the dragged cell is NOT surface-exact, but stays inside 3% of the quad diagonal (${(100 * maxGeom / diag).toFixed(3)}%)`);
    check(maxGeom > 1e-9, 'cell slide: ...and the error is REAL — two G1-joined bicubics are not one bicubic');
    check(maxParam > 10 * maxGeom, 'cell slide: the matched-parameter error dwarfs the geometric one — the rail is re-parameterised, not bowed off the surface');
  }

  // ---- 21e. the merge: dragged to the clamp, ONLY the leading quad has degenerated
  {
    const doc = freshGrid();
    const frozen = doc.vertices.slice();
    const bp = (id: number): V3 => [frozen[id * 3], frozen[id * 3 + 1], frozen[id * 3 + 2]];
    const [qa, qb, qc, qd] = doc.quads[QC];
    const N = QC + cellCols;
    const [, , nc, nd] = doc.quads[N];
    const p = plan(doc, [QC], QC)!;
    check(same(p.weld, [[qc, nc], [qd, nd]]), 'cell slide weld: only the leading quad\'s two rails are named');
    check(!p.weld.some(([f]) => f === qa || f === qb), 'cell slide weld: the dragged cell\'s own trail corners never weld — that would collapse the selection');

    slideEdgesInQuads(doc, p.items, 1.4);           // the cursor ran past the far clamp
    const now = posOf(doc);
    check(dist(now(qa), bp(qc)) < 1e-2 * dist(bp(qa), bp(qc)), 'cell slide t>1: the trail edge has arrived where the lead edge started');
    check(dist(now(qc), bp(nc)) < 1e-2 * dist(bp(qc), bp(nc)), 'cell slide t>1: ...and the lead edge at the far side of the quad ahead');
    check(!hasNaN(doc) && watertight(doc).ok, 'cell slide t>1: finite + watertight');

    const w = applyVertexWeld(doc, p.weld);
    check(w.ok, 'cell slide merge: releasing at the clamp welds the leading quad away');
    check(w.ok && w.doc.quads.length === Q0 - 1, `cell slide merge: exactly one quad is dropped (${w.ok ? Q0 - w.doc.quads.length : -1})`);
    check(w.ok && checkManifold(w.doc.quads).ok && !hasNaN(w.doc) && watertight(w.doc).ok, 'cell slide merge: manifold + watertight + finite');
    if (w.ok) {
      // no quad is dropped below QC, so it keeps its id; its A corner has advanced into the seat C used to hold.
      const isW = (q: number[]) => new Set(q).size === 3 && q[2] === q[3];
      check(new Set(w.doc.quads[QC]).size === 4, 'cell slide merge: the dragged cell survives as a proper quad');
      // only qc / qd are pruned, and both sit below nc / nd, so the survivors compact down by two ids
      check(same(w.doc.quads[QC], [qa, qb, nc - 2, nd - 2]), 'cell slide merge: the dragged cell now spans its trail edge and the vanished quad\'s far edge — one seat forward');
      // the merge collapses two RAILS (C→N.C and D→N.D), and the cell flanking each rail loses a corner — the same
      // wedge termination an edge slide's merge leaves (docs/017 S3), on the two cells beside the vanished quad.
      check(w.doc.quads.filter(isW).length === 2, `cell slide merge: the two cells flanking the vanished quad fold into wedges (${w.doc.quads.filter(isW).length})`);
    }
  }

  // ---- 21f. a block of two cells ALONG the drag: the shared edge is one cell's lead and the next's trail, and
  // both name the same quad ahead — so it is ONE item, and only the outermost quad welds away.
  {
    const doc = freshGrid();
    const Q2 = QC + cellCols, N = QC + 2 * cellCols;
    const p = plan(doc, [QC, Q2], QC)!;
    check(p.items.length === 3, `cell slide 2-along: the shared edge dedupes to one item (3, got ${p.items.length})`);
    const shared = doc.quads[QC].slice(2) as [number, number];   // QC's C–D = Q2's A–B
    const it = p.items.filter(i => ekey(i.edge[0], i.edge[1]) === ekey(shared[0], shared[1]));
    check(it.length === 1 && it[0].quad === Q2, 'cell slide 2-along: the shared edge names the quad ahead of it (the front cell)');
    const [, , nc, nd] = doc.quads[N];
    check(same(p.weld, [[doc.quads[Q2][2], nc], [doc.quads[Q2][3], nd]]), 'cell slide 2-along: only the outer leading quad welds');

    slideEdgesInQuads(doc, p.items, 1.4);
    check(!hasNaN(doc) && watertight(doc).ok, 'cell slide 2-along: finite + watertight');
    const w = applyVertexWeld(doc, p.weld);
    check(w.ok && w.doc.quads.length === Q0 - 1, `cell slide 2-along: the block advances one cell, dropping one quad (${w.ok ? Q0 - w.doc.quads.length : -1})`);
    check(w.ok && checkManifold(w.doc.quads).ok, 'cell slide 2-along: manifold');
  }

  // ---- 21g. a block of two cells ACROSS the drag: two separate leading quads, and the rail they share is written
  // bit-identically by both items (the same rail cubic, cut at the same t, read from either side).
  {
    const doc = freshGrid();
    const Q2 = QC + 1, N1 = QC + cellCols, N2 = Q2 + cellCols;
    const p = plan(doc, [QC, Q2], QC)!;
    check(p.items.length === 4, `cell slide 2-across: four items, no shared edge (${p.items.length})`);
    check(p.items.filter(i => i.quad === N1 || i.quad === N2).length === 2, 'cell slide 2-across: both leading quads take a lead item');
    const welded = new Set(p.weld.map(([f]) => f));
    check(p.weld.length === 3 && [QC, Q2].every(q => doc.quads[q].slice(2).every(v => welded.has(v))), `cell slide 2-across: both leading quads weld, the shared rail pair once (${p.weld.length} pairs)`);

    slideEdgesInQuads(doc, p.items, 1.4);
    check(!hasNaN(doc) && watertight(doc).ok, 'cell slide 2-across: finite + watertight');
    const w = applyVertexWeld(doc, p.weld);
    check(w.ok && w.doc.quads.length === Q0 - 2, `cell slide 2-across: both leading quads collapse (${w.ok ? Q0 - w.doc.quads.length : -1})`);
    check(w.ok && checkManifold(w.doc.quads).ok, 'cell slide 2-across: manifold');

    // the shared rail B–D: cut it from QC's side alone and from Q2's side alone — the corner and both directed
    // handles come out identical, which is why pass B has no conflict to resolve.
    const [, qb, , qd] = doc.quads[QC];
    const d1 = freshGrid(), d2 = freshGrid();
    slideEdgesInQuads(d1, [{ quad: QC, edge: [d1.quads[QC][0], d1.quads[QC][1]] }], T);
    slideEdgesInQuads(d2, [{ quad: Q2, edge: [d2.quads[Q2][0], d2.quads[Q2][1]] }], T);
    const bitSame = [0, 1, 2].every(k => d1.vertices[qb * 3 + k] === d2.vertices[qb * 3 + k])
      && same(d1.edgeHandles?.[`${qb}>${qd}`], d2.edgeHandles?.[`${qb}>${qd}`])
      && same(d1.edgeHandles?.[`${qd}>${qb}`], d2.edgeHandles?.[`${qd}>${qb}`]);
    check(bitSame, 'cell slide 2-across: the shared rail\'s corner + both handles are bit-identical from either cell');
  }

  // ---- 21h. the rim: a cell whose lead edge has no quad beyond it cannot slide forward
  {
    const doc = freshGrid();
    const QR = cid(cellRows - 1, 5);                // the last cell row: its C–D edge is the net's bottom rim
    const p = plan(doc, [QR], QR)!;
    check(p.blocked, 'cell slide rim: a lead edge on the rim blocks the slide');
    check(p.weld.length === 0, 'cell slide rim: a clamped slide commits no merge');
    check(p.items.length === 1 && p.items[0].quad === QR, 'cell slide rim: only the trail item survives — the caller decides whether to refuse');
    check(planCellSlide(meshContext(doc).mesh, meshContext(doc).adj, [QR], [0, 0, 0], posOf(doc)) === null, 'cell slide: a degenerate drag direction plans nothing');
  }
}

// ---- 22. the 2-D exact slide (the XZ tangent pad): a u-PASS then a v-PASS, both landing on the parent surface ----
// The law this section pins: every moved vertex lands on `P(tu, tv)` of its QUADRANT quad — the quad incident to it
// whose interior lies in the drag's +u,+v corner — so a 2-D drag never leaves the ORIGINAL surface and casts no ray.
// The v-pass reads the doc the u-pass wrote, and that is what makes it exact: after the u-pass a quad's moved boundary
// IS the parent's own `u = tu` iso-curve, so cutting THAT at `tv` lands on `P(tu, tv)`.
//
// Every parameter is clamped to [SLIDE_EPS, 1-SLIDE_EPS], so a "t = 0" axis still steps SLIDE_EPS along its rail
// (≈ 5 mm of a 42 m edge on the default grid). Every reduction below is therefore exact up to that one ε step, and the
// tests measure the step rather than pretend it away — the same clamp section 17 already documents for the 1-D slide.
{
  const dist = (a: V3, b: V3) => len(sub(a, b));
  const pv = (d: QuadMeshDoc, i: number): V3 => [d.vertices[i * 3], d.vertices[i * 3 + 1], d.vertices[i * 3 + 2]];
  const posOf = (doc: QuadMeshDoc) => (id: number): V3 => pv(doc, id);
  const netOf = (doc: QuadMeshDoc, q: number): V3[] => {
    const { mesh, edgeHandle } = meshFromDoc(doc);
    return quadControlPoints(mesh, edgeHandle, q, doc.quadTwist?.[q]);
  };
  const cid = (r: number, c: number) => r * cellCols + c;
  /** Corner slot 0/1/2/3 = A/B/C/D → its patch parameter (the storage contract read as coordinates). */
  const CORNER_UV: [number, number][] = [[0, 0], [0, 1], [1, 0], [1, 1]];
  /** The cycle A→B→D→C→A: each slot's two CYCLE-adjacent slots (the two rails it can ride). */
  const CYCLE_NB: [number, number][] = [[1, 2], [0, 3], [3, 0], [2, 1]];
  /** Where a corner in `slot` arrives when its u rail is cut at `tu` and its v rail at `tv`: a corner at 0 runs
   *  forward to t, one at 1 runs back to 1-t. This is the fold `slideVertexOnPatch` applies, restated. */
  const fold = (slot: number, tu: number, tv: number): [number, number] => {
    const [u, v] = CORNER_UV[slot];
    return [u === 0 ? tu : 1 - tu, v === 0 ? tv : 1 - tv];
  };
  const canon = (doc: QuadMeshDoc) => JSON.stringify({
    v: doc.vertices,
    h: Object.keys(doc.edgeHandles ?? {}).sort().map(k => [k, doc.edgeHandles![k]]),
    w: Object.keys(doc.quadTwist ?? {}).sort().map(k => [k, doc.quadTwist![+k]]),
  });

  const base = freshGrid();
  const QC = cid(3, 5);                          // an interior cell: a full ring of proper neighbours around it
  const [A, B, C, D] = base.quads[QC];           // A@(0,0) B@(0,1) C@(1,0) D@(1,1)
  const uSpan = dist(pv(base, A), pv(base, C)), vSpan = dist(pv(base, A), pv(base, B));
  const diag = dist(pv(base, A), pv(base, D));
  console.log(`      2-D slide fixture: quad ${QC}, ${uSpan.toFixed(1)} m down u × ${vSpan.toFixed(1)} m across v, ${diag.toFixed(1)} m diagonal`);

  check(SLIDE_MERGE_SNAP > SLIDE_EPS && SLIDE_MERGE_SNAP < 0.5, `merge snap: a window inside one cell (${SLIDE_MERGE_SNAP}) — wider than half a cell would arm a merge from the MIDDLE of the link edge, where no vertex sits`);

  // ---- 22a. the refactor: `slideVerticesAlongEdges` with ONE item is byte-for-byte the 1-D slide it replaced.
  // The yardstick is an inline replica of the shipped 1-D body, not the batch itself — so a reordered write, a
  // dropped handle pin or a changed clamp all move a bit and fail here.
  {
    const shipped1D = (doc: QuadMeshDoc, vertex: number, toward: number, t: number) => {
      if (vertex === toward || !Number.isFinite(vertex) || !Number.isFinite(toward)) return;
      const { edgeHandle } = meshFromDoc(doc);
      const P0 = getVertex(doc, vertex), P3 = getVertex(doc, toward);
      const s = Number.isFinite(t) ? Math.min(Math.max(t, SLIDE_EPS), 1 - SLIDE_EPS) : SLIDE_EPS;
      const { right } = splitCubic(P0, add(P0, edgeHandle(vertex, toward)), add(P3, edgeHandle(toward, vertex)), P3, s);
      setVertex(doc, vertex, right[0]);
      meshSetHandle(doc, vertex, toward, sub(right[1], right[0]));
      meshSetHandle(doc, toward, vertex, sub(right[2], right[3]));
    };
    let bits = true, batchBits = true;
    for (const t of [0.05, 0.3, 0.7, 1.4, -1, NaN]) {
      const want = freshGrid(); shipped1D(want, A, B, t);
      const got = freshGrid(); slideVertexAlongEdge(got, A, B, t);
      const via = freshGrid(); slideVerticesAlongEdges(via, [{ vertex: A, toward: B, t }]);
      if (JSON.stringify(got) !== JSON.stringify(want)) bits = false;
      if (JSON.stringify(via) !== JSON.stringify(want)) batchBits = false;
    }
    check(bits, 'vertex slide refactor: `slideVertexAlongEdge` is byte-identical to the 1-D body it delegates away (6 parameters incl. the clamps and NaN)');
    check(batchBits, 'vertex slide refactor: ...and so is a one-item `slideVerticesAlongEdges` — a lone `toward` moves for nobody, so both handles pin');

    const noop = freshGrid();
    const s0 = canon(noop);
    slideVerticesAlongEdges(noop, [{ vertex: A, toward: A, t: 0.3 }, { vertex: NaN, toward: B, t: 0.3 }]);
    check(canon(noop) === s0, 'vertex slide: a self-edge and a non-finite id are skipped, the doc untouched');
  }

  // ---- 22b. a RUN along a loop: every cubic is read before any is written, and a moving `toward` gets no pin.
  {
    const cols = GRID_COLS;
    const run = [3 * cols + 5, 3 * cols + 6, 3 * cols + 7, 3 * cols + 8];   // A0→A1→A2→A3 across one row
    const T = 0.3;
    const doc = freshGrid();
    const cubic = (d: QuadMeshDoc, x: number, y: number): [V3, V3, V3, V3] => {
      const { edgeHandle } = meshFromDoc(d);
      const Px = pv(d, x), Py = pv(d, y);
      return [Px, add(Px, edgeHandle(x, y)), add(Py, edgeHandle(y, x)), Py];
    };
    const parents = [0, 1, 2].map(i => cubic(doc, run[i], run[i + 1]));
    const items = [0, 1, 2].map(i => ({ vertex: run[i], toward: run[i + 1], t: T }));
    slideVerticesAlongEdges(doc, items);
    let maxOn = 0;
    for (let i = 0; i < 3; i++) maxOn = Math.max(maxOn, dist(pv(doc, run[i]), cubicPoint(...parents[i], T)));
    check(maxOn < 1e-12, `vertex run: every vertex lands on ITS OWN pre-slide cubic at t (max err ${maxOn.toExponential(2)} m) — a half-written doc would feed the next item a corner the last one moved`);

    // a moving `toward` writes its own outgoing handle; only the run's lead pins the far end's incoming one
    const h = doc.edgeHandles!;
    check([0, 1, 2].every(i => h[`${run[i]}>${run[i + 1]}`] !== undefined), 'vertex run: every item pins its own outgoing handle');
    check(h[`${run[1]}>${run[0]}`] === undefined && h[`${run[2]}>${run[1]}`] === undefined, 'vertex run: a `toward` that MOVES gets no incoming pin — its position no longer terminates that curve');
    check(h[`${run[3]}>${run[2]}`] !== undefined, 'vertex run: ...but the standing lead `toward` does pin, exactly as a lone slide would');

    // sequential application is NOT the same gesture: item 2 would then read a curve item 1 had already re-cut
    const seq = freshGrid();
    for (const it of items) slideVerticesAlongEdges(seq, [it]);
    check(canon(seq) !== canon(doc), 'vertex run: applying the items one at a time gives a DIFFERENT doc — the batch is the gesture, not a loop over it');
  }

  // ---- 22c. slot / param mapping: on all four corner slots, saturating one rail lands on that rail's far corner.
  // A transposed fold passes slot 0 and lands a whole edge away on the others, so this is the mapping's real test.
  // The residual is the clamp's own ε step (≈ 3·SLIDE_EPS·|handle|), not an error in the placement.
  {
    let maxU = 0, maxV = 0, maxSelf = 0, maxDiag = 0;
    for (let s = 0; s < 4; s++) {
      const V = base.quads[QC][s], tU = base.quads[QC][CYCLE_NB[s][0]], tV = base.quads[QC][CYCLE_NB[s][1]];
      const far = base.quads[QC][3 - s];                                    // the slot diagonally across
      const run = (tu: number, tv: number) => { const d = structuredClone(base); slideVertexOnPatch(d, QC, V, tU, tu, tV, tv); return pv(d, V); };
      maxU = Math.max(maxU, dist(run(1, 0), pv(base, tU)));
      maxV = Math.max(maxV, dist(run(0, 1), pv(base, tV)));
      maxSelf = Math.max(maxSelf, dist(run(0, 0), pv(base, V)));
      maxDiag = Math.max(maxDiag, dist(run(1, 1), pv(base, far)));
    }
    const bound = 3 * SLIDE_EPS * diag;   // a cubic's speed is at most 3× its longest control leg
    check(maxU < bound, `patch slide: saturating the \`towardU\` rail lands on towardU, all four slots (max ${(1e3 * maxU).toFixed(3)} mm, inside the clamp's own ${(1e3 * bound).toFixed(3)} mm ε step)`);
    check(maxV < bound, `patch slide: saturating the \`towardV\` rail lands on towardV, all four slots (max ${(1e3 * maxV).toFixed(3)} mm)`);
    check(maxSelf < bound, `patch slide: both rails at t≈0 leave the vertex on its own seat, all four slots (max ${(1e3 * maxSelf).toFixed(3)} mm)`);
    check(maxDiag < bound, `patch slide: both rails saturated reach the quad's far corner, all four slots (max ${(1e3 * maxDiag).toFixed(3)} mm)`);
    check(bound < 1e-3 * Math.min(uSpan, vSpan), `patch slide: ...and that ε step is under 0.1% of the shortest edge (${(1e3 * bound).toFixed(2)} mm of ${Math.min(uSpan, vSpan).toFixed(1)} m) — a transposed fold would land a whole edge away`);

    // The placement is the PATCH point: no ray, no chord, no composition of splits. The yardstick is the parent's own
    // de Casteljau sub-patch — `splitPatchU(cp0, pu).upper` evaluated at its u=0 corner — so the check crosses code
    // paths (column splits + Bernstein) instead of restating the implementation's own call. It is the very identity the
    // cell 2-D slide leans on: cutting the patch at `pu` and reading the cut boundary at `pv` IS `P(pu, pv)`.
    const cp0 = netOf(base, QC);
    let maxP = 0;
    for (let s = 0; s < 4; s++) {
      const V = base.quads[QC][s], tU = base.quads[QC][CYCLE_NB[s][0]], tV = base.quads[QC][CYCLE_NB[s][1]];
      for (const [tu, tv] of [[0.23, 0.61], [0.7, 0.15]] as [number, number][]) {
        const d = structuredClone(base);
        slideVertexOnPatch(d, QC, V, tU, tu, tV, tv);
        // `tU` rides whichever coordinate it actually moves; `fold` names the pair either way round
        const cU = CORNER_UV[s][0] !== CORNER_UV[CYCLE_NB[s][0]][0] ? 0 : 1;
        const [pu, pv2] = cU === 0 ? fold(s, tu, tv) : fold(s, tv, tu);
        maxP = Math.max(maxP, dist(pv(d, V), patchPoint(splitPatchU(cp0, pu).upper, 0, pv2)));
      }
    }
    check(maxP < 1e-12, `patch slide: the vertex IS P(tu,tv) of its own quad — measured against the parent's de Casteljau sub-patch corner, on every slot and either rail labelling (max err ${maxP.toExponential(2)} m)`);
  }

  // ---- 22d. the reduction: at tv → 0 the 2-D corner slide IS `slideVertexAlongEdge` on the u rail, up to the clamp.
  // The load-bearing identity is that the 1-D slide's landing point is the PATCH point at v = 0 — one path cuts the
  // edge cubic with de Casteljau, the other evaluates the 16-CP net with Bernstein, and they agree to fp.
  {
    const TU = 0.37;
    const cp0 = netOf(base, QC);
    const d1 = structuredClone(base); slideVertexAlongEdge(d1, A, C, TU);            // A→C is A's u rail
    const d2 = structuredClone(base); slideVertexOnPatch(d2, QC, A, C, TU, B, 0);    // ...and B its v rail, at tv → 0
    const e1D = dist(pv(d1, A), patchPoint(cp0, TU, 0));
    check(e1D < 1e-12, `2-D reduction: the 1-D slide's landing point IS P(tu, 0) of the quad (err ${e1D.toExponential(2)} m) — every 1-D case is the tv=0 slice`);
    const gap = dist(pv(d1, A), pv(d2, A));
    const step = dist(patchPoint(cp0, TU, 0), patchPoint(cp0, TU, SLIDE_EPS));
    check(Math.abs(gap - step) < 1e-12, `2-D reduction: ...and the 2-D slide at tv→0 differs from it by exactly the clamp's ε step along the v rail (${(1e3 * gap).toFixed(3)} mm vs ${(1e3 * step).toFixed(3)} mm)`);
  }

  // ---- 22e. the bails: a diagonal `toward`, a repeated one, a wedge, a stranger vertex — skipped, not crashed on
  {
    const doc = structuredClone(base);
    const s0 = canon(doc);
    slideVertexOnPatch(doc, QC, A, D, 0.3, B, 0.3);       // D is the DIAGONAL of A: no rail
    check(canon(doc) === s0, 'patch slide guard: a diagonal `toward` is a caller bug — skipped, the doc unchanged');
    slideVertexOnPatch(doc, QC, A, B, 0.3, B, 0.3);       // both rails the same
    check(canon(doc) === s0, 'patch slide guard: two `toward`s on one axis name one rail — skipped');
    slideVertexOnPatch(doc, QC, A, A, 0.3, B, 0.3);
    check(canon(doc) === s0, 'patch slide guard: `toward` = `vertex` — skipped');
    slideVertexOnPatch(doc, QC, base.quads[QC + cellCols][3], B, 0.3, C, 0.3);
    check(canon(doc) === s0, 'patch slide guard: a vertex that is not a corner of the quad — skipped');
    slideVertexOnPatch(doc, 1e6, A, B, 0.3, C, 0.3);
    check(canon(doc) === s0, 'patch slide guard: a quad that does not exist — skipped');

    const r = applyVertexWeld(freshGrid(), [[3 * GRID_COLS + 2, 2 * GRID_COLS + 2]]);
    if (r.ok) {
      const wq = r.doc.quads.findIndex(q => q[2] === q[3]);
      const w0 = canon(r.doc);
      slideVertexOnPatch(r.doc, wq, r.doc.quads[wq][0], r.doc.quads[wq][1], 0.3, r.doc.quads[wq][2], 0.3);
      check(canon(r.doc) === w0, 'patch slide guard: a WEDGE has no second axis to fold — skipped, the doc unchanged');
    }
  }

  // ---- 22f. THE KEY CLAIM, and the defect that forces the `place` pass. A cell dragged in both axes: two
  // `planCellSlide`s, two `slideEdgesInQuads` passes. Each pass re-cuts exactly two of the cell's four rails, so the two
  // corners whose v rail the u-pass re-cut land on the parent surface and the OTHER two are dragged back down a chord
  // toward a neighbour the u-pass never moved. Which two depends on the pass order — so no order delivers the law.
  //
  // The law is delivered instead by `slideQuadrantTargets` + a final `place` pass: every moved vertex is written to
  // `P(tu, tv)` of its own QUADRANT quad. The passes keep their job of shaping the TANGENTS; the positions come from
  // the law. Each of the four corners is checked against a path that shares no code with `place`.
  const cellPlan = (doc: QuadMeshDoc, cells: number[], dir: V3, t: number): Extract<SlidePass, { kind: 'edges' }> => {
    const { mesh, adj } = meshContext(doc);
    return { kind: 'edges', items: planCellSlide(mesh, adj, cells, dir, posOf(doc))!.items, t };
  };
  const NU = QC + cellCols, NV = QC + 1, NUV = QC + cellCols + 1;   // the quadrant quads of C, B and D
  const placeOf = (verts: number[], du: V3, dv: V3, tu: number, tv: number): Extract<SlidePass, { kind: 'place' }> => {
    const { mesh, adj, edgeHandle } = meshContext(base);
    return { kind: 'place', items: slideQuadrantTargets(mesh, edgeHandle, adj, verts, du, dv, tu, tv, base.quadTwist) };
  };
  /** `P_q(pu, pv)` by DOUBLE de Casteljau sub-patch — `splitPatch*` and `patchPoint` are different code paths. */
  const dblCut = (q: number, pu: number, pvv: number): V3 => splitPatchV(splitPatchU(netOf(base, q), pu).upper, pvv).upper[0];
  {
    const P = posOf(base);
    const du = sub(P(C), P(A)), dv = sub(P(B), P(A));
    const TU = 0.3, TV = 0.42;
    const uPass = cellPlan(base, [QC], du, TU), vPass = cellPlan(base, [QC], dv, TV);

    // the DEFECT, measured. Two compositions, four corners, the law's target for each read off its quadrant quad.
    const dUV = structuredClone(base); applySlidePlan(dUV, { passes: [uPass, vPass], weld: [] });
    const dVU = structuredClone(base); applySlidePlan(dVU, { passes: [vPass, uPass], weld: [] });
    const law: Record<number, V3> = { [A]: dblCut(QC, TU, TV), [B]: dblCut(NV, TU, TV), [C]: dblCut(NU, TU, TV), [D]: dblCut(NUV, TU, TV) };
    const miss = (d: QuadMeshDoc, v: number) => dist(pv(d, v), law[v]);
    const pct = (d: QuadMeshDoc, v: number) => (100 * miss(d, v) / diag).toFixed(3) + '%';
    console.log(`      cell 2-D pass-order defect (miss from the law, % of the ${diag.toFixed(1)} m quad diagonal):`
      + ` (u,v) A ${pct(dUV, A)} B ${pct(dUV, B)} C ${pct(dUV, C)} D ${pct(dUV, D)};`
      + ` (v,u) A ${pct(dVU, A)} B ${pct(dVU, B)} C ${pct(dVU, C)} D ${pct(dVU, D)}`);
    check(miss(dUV, A) < 1e-11 && miss(dUV, C) < 1e-11, `cell 2-D defect: (u,v) leaves A and C exactly on the law (${miss(dUV, A).toExponential(2)} m, ${miss(dUV, C).toExponential(2)} m)`);
    check(miss(dUV, B) > 0.05 * diag && miss(dUV, D) > 0.05 * diag, `cell 2-D defect: ...and drags B and D down a chord, ${miss(dUV, B).toFixed(2)} m / ${miss(dUV, D).toFixed(2)} m off it — their v rail was never re-cut, so the vertex they slid toward never moved in u`);
    check(miss(dVU, A) < 1e-11 && miss(dVU, B) < 1e-11, `cell 2-D defect: (v,u) leaves A and B exact instead (${miss(dVU, A).toExponential(2)} m, ${miss(dVU, B).toExponential(2)} m) — the exact pair is a function of the pass ORDER`);
    check(miss(dVU, C) > 0.05 * diag && miss(dVU, D) > 0.05 * diag, `cell 2-D defect: ...and misses C and D by ${miss(dVU, C).toFixed(2)} m / ${miss(dVU, D).toFixed(2)} m — D is never exact under either order, so no composition delivers the law`);

    // and each composition's exact corner IS the double sub-patch of its quadrant quad — the yardstick the checks below
    // lean on, verified before it is leaned on (`splitPatch*` vs the `writeSideEdge` round-trip: different code paths)
    check(dist(pv(dVU, B), dblCut(NV, TU, TV)) < 1e-11, `cell 2-D: the (v,u) composition's B IS P_Nv(${TU},${TV}) by double sub-patch (${dist(pv(dVU, B), dblCut(NV, TU, TV)).toExponential(2)} m) — the claim the B check below rests on`);

    // ---- the correction: quadrant targets + a `place` pass
    const place = placeOf([A, B, C, D], du, dv, TU, TV);
    check(place.items.length === 4, `slideQuadrantTargets: a dragged cell's four corners all have a quadrant quad (${place.items.length})`);
    const dFix = structuredClone(base);
    applySlidePlan(dFix, { passes: [uPass, vPass, place], weld: [] });

    const yard: [string, number, V3][] = [
      ['A (vs the (u,v) composition)', A, pv(dUV, A)],
      ['C (vs the (u,v) composition)', C, pv(dUV, C)],
      ['B (vs the (v,u) composition)', B, pv(dVU, B)],
      ['D (vs N_uv\'s double sub-patch)', D, dblCut(NUV, TU, TV)],
    ];
    for (const [name, v, want] of yard) {
      const e = dist(pv(dFix, v), want);
      check(e < 1e-11, `cell 2-D place: corner ${name} — err ${e.toExponential(2)} m = ${(100 * e / diag).toExponential(1)}% of the ${diag.toFixed(1)} m diagonal`);
    }
    check([A, B, C, D].every(v => dist(pv(dFix, v), pv(base, v)) > 0.1 * diag), `cell 2-D place: all four corners really travelled (min ${Math.min(...[A, B, C, D].map(v => dist(pv(dFix, v), pv(base, v)))).toFixed(2)} m) — the claim is not exactness by standing still`);

    // the -u,-v drag: every corner's quadrant quad is the one up-slope and back across, and D's is the cell itself —
    // so the fold's `1-t` branch carries the whole gesture.
    const dNeg = structuredClone(base);
    const negU = sub(P(A), P(C)), negV = sub(P(A), P(B));
    const negPlace = placeOf([A, B, C, D], negU, negV, TU, TV);
    check(negPlace.items.length === 4, `cell 2-D place (-u,-v): all four corners still find a quadrant quad, the ring on the other side (${negPlace.items.length})`);
    applySlidePlan(dNeg, { passes: [cellPlan(base, [QC], negU, TU), cellPlan(base, [QC], negV, TV), negPlace], weld: [] });
    const [pu, pvv] = fold(3, TU, TV);
    const eNeg = dist(pv(dNeg, D), dblCut(QC, pu, pvv));
    check(eNeg < 1e-11, `cell 2-D place (-u,-v): D's quadrant quad is the cell itself and it lands on P(${pu.toFixed(2)},${pvv.toFixed(2)}) — the fold's 1-t branch (err ${eNeg.toExponential(2)} m)`);

    // ---- continuity: at tv = SLIDE_EPS the law's targets and the passes' own positions coincide, so the `place` pass
    // switching on as the drag leaves the rail moves nothing the eye can see.
    const vEps = cellPlan(base, [QC], dv, SLIDE_EPS);
    const dEps = structuredClone(base); applySlidePlan(dEps, { passes: [uPass, vEps], weld: [] });
    const placeEps = placeOf([A, B, C, D], du, dv, TU, SLIDE_EPS);
    const jump = Math.max(...placeEps.items.map(it => dist(it.pos, pv(dEps, it.vertex))));
    check(jump < 1e-3 * diag, `cell 2-D place: at tv = SLIDE_EPS the law's targets sit ${jump.toExponential(2)} m = ${(jump / diag).toExponential(1)} of a cell diagonal from the passes' own positions — the pass switches on without a jump`);

    // ---- and the shipped ARROWS are untouched: at tv <= SLIDE_EPS the host emits the u-pass alone, no v-pass and no
    // `place`, so a 1-D drag is byte-for-byte the slide that shipped.
    const arrow = structuredClone(base); applySlidePlan(arrow, { passes: [uPass], weld: [] });
    const oneD = structuredClone(base); slideEdgesInQuads(oneD, uPass.items, TU);
    check(JSON.stringify(arrow) === JSON.stringify(oneD), 'cell 2-D place: a plan with tv ≤ SLIDE_EPS carries no v-pass and no `place` — byte-identical to the shipped 1-D cell slide');
  }

  // ---- 22g. an EDGE dragged in both axes: u-pass = `slideEdgesInQuads`, v-pass = the endpoints sliding along the loop,
  // then `place`. Without `place` the TRAILING endpoint rides the exact iso-curve the u-pass left, but the LEADING one
  // rides its CONTINUATION edge — a re-shaped chord to a vertex the u-pass never moved — and misses the law by the
  // cross term that chord cannot carry. That miss is the measurement that justifies the `place` pass existing.
  {
    check(base.quads[NV][0] === B, 'edge 2-D: the leading endpoint\'s quadrant quad has it as its A corner');
    const Bplus = base.quads[NV][1];               // the loop's next vertex past B
    const cpN0 = netOf(base, NV);
    const T = 0.3;
    const P = posOf(base);
    const du = sub(P(C), P(A)), dv = sub(P(B), P(A));
    const uPass: SlidePass = { kind: 'edges', items: [{ quad: QC, edge: [A, B] }], t: T };
    const vPass: SlidePass = { kind: 'verts', items: [{ vertex: A, toward: B, t: T }, { vertex: B, toward: Bplus, t: T }] };

    // after the u-pass alone, B sits EXACTLY on the shared B–D boundary curve at u = t: the miss enters in the v-pass
    const mid = structuredClone(base);
    applySlidePlan(mid, { passes: [uPass], weld: [] });
    const eMid = dist(pv(mid, B), patchPoint(cpN0, T, 0));
    check(eMid < 1e-11, `edge 2-D: after the u-pass the leading endpoint is exactly on its quadrant quad's P(t,0) (err ${eMid.toExponential(2)} m) — the shared boundary curve, read from either side`);

    const sweep = [0.1, 0.2, 0.3].map(t => {
      const d = structuredClone(base);
      applySlidePlan(d, { passes: [{ kind: 'edges', items: [{ quad: QC, edge: [A, B] }], t }, { kind: 'verts', items: [{ vertex: A, toward: B, t }, { vertex: B, toward: Bplus, t }] }], weld: [] });
      return { t, eA: dist(pv(d, A), dblCut(QC, t, t)), eB: dist(pv(d, B), dblCut(NV, t, t)) };
    });
    const s = sweep.find(x => x.t === T)!;
    check(s.eA < 1e-11, `edge 2-D (no place): the TRAILING endpoint lands exactly on P(${T},${T}) of its own quad (err ${s.eA.toExponential(2)} m) — it rides the u-pass's exact iso-curve`);
    check(s.eB > 1e-3 * diag && s.eB < 0.08 * diag, `edge 2-D (no place): the LEADING endpoint rides a re-shaped continuation edge and misses P(${T},${T}) of its quadrant quad by ${s.eB.toFixed(3)} m = ${(100 * s.eB / diag).toFixed(2)}% of the ${diag.toFixed(1)} m diagonal`);
    console.log(`      edge 2-D leading-endpoint miss WITHOUT \`place\` (% of the ${diag.toFixed(1)} m quad diagonal):`
      + sweep.map(x => ` t=${x.t} → ${(100 * x.eB / diag).toFixed(3)}%`).join(','));
    check(sweep[0].eB < sweep[1].eB && sweep[1].eB < sweep[2].eB, 'edge 2-D (no place): the miss is the missing cross term — second-order in t');

    // ---- with `place`, both endpoints land on the parent surface, at the law's own points
    const place = placeOf([A, B], du, dv, T, T);
    check(place.items.length === 2 && place.items[0].vertex === A && place.items[1].vertex === B, `slideQuadrantTargets: both endpoints of the dragged edge have a quadrant quad (${place.items.length})`);
    const fixed = structuredClone(base);
    applySlidePlan(fixed, { passes: [uPass, vPass, place], weld: [] });
    const fA = dist(pv(fixed, A), dblCut(QC, T, T)), fB = dist(pv(fixed, B), dblCut(NV, T, T));
    check(fA < 1e-11, `edge 2-D place: the trailing endpoint is on P(${T},${T}) of Q — err ${fA.toExponential(2)} m = ${(100 * fA / diag).toExponential(1)}% of the diagonal`);
    check(fB < 1e-11, `edge 2-D place: the leading endpoint is on P(${T},${T}) of N_v — err ${fB.toExponential(2)} m = ${(100 * fB / diag).toExponential(1)}% of the diagonal, down from ${(100 * s.eB / diag).toFixed(2)}%`);
  }

  // ---- 22h. `applySlidePlan` is exactly its passes, in order: one pass is the bare op call, byte for byte.
  {
    const P = posOf(base);
    const uPass = cellPlan(base, [QC], sub(P(C), P(A)), 0.3);
    const a1 = structuredClone(base); applySlidePlan(a1, { passes: [uPass], weld: [[9, 9]] });
    const a2 = structuredClone(base); slideEdgesInQuads(a2, uPass.items, 0.3);
    check(JSON.stringify(a1) === JSON.stringify(a2), 'applySlidePlan: one `edges` pass is `slideEdgesInQuads`, byte for byte — and `weld` is the host\'s to commit, never touched here');

    const vItems = [{ vertex: A, toward: B, t: 0.3 }];
    const b1 = structuredClone(base); applySlidePlan(b1, { passes: [{ kind: 'verts', items: vItems }], weld: [] });
    const b2 = structuredClone(base); slideVerticesAlongEdges(b2, vItems);
    check(JSON.stringify(b1) === JSON.stringify(b2), 'applySlidePlan: one `verts` pass is `slideVerticesAlongEdges`, byte for byte');

    const c1 = structuredClone(base); applySlidePlan(c1, { passes: [{ kind: 'patch', quad: QC, vertex: A, towardU: C, tu: 0.3, towardV: B, tv: 0.42 }], weld: [] });
    const c2 = structuredClone(base); slideVertexOnPatch(c2, QC, A, C, 0.3, B, 0.42);
    check(JSON.stringify(c1) === JSON.stringify(c2), 'applySlidePlan: one `patch` pass is `slideVertexOnPatch`, byte for byte');

    const e1 = structuredClone(base); applySlidePlan(e1, { passes: [], weld: [[A, B]] });
    check(JSON.stringify(e1) === JSON.stringify(base), 'applySlidePlan: no passes, no writes — a blocked drag commits nothing');

    // a `place` pass is nothing but setVertex — it never touches a handle or a twist
    const items = [{ vertex: A, pos: [1, 2, 3] as V3 }, { vertex: B, pos: [4, 5, 6] as V3 }];
    const p1 = structuredClone(base); applySlidePlan(p1, { passes: [{ kind: 'place', items }], weld: [] });
    const p2 = structuredClone(base); for (const it of items) setVertex(p2, it.vertex, it.pos);
    check(JSON.stringify(p1) === JSON.stringify(p2), 'applySlidePlan: one `place` pass is a `setVertex` loop, byte for byte — no handle, no twist');

    // ...and it runs LAST whatever order the plan lists it in: a shaping pass reads positions to derive its cut, so a
    // correction written before one is simply re-cut away.
    const q1 = structuredClone(base); applySlidePlan(q1, { passes: [uPass, { kind: 'place', items }], weld: [] });
    const q2 = structuredClone(base); applySlidePlan(q2, { passes: [{ kind: 'place', items }, uPass], weld: [] });
    check(JSON.stringify(q1) === JSON.stringify(q2), 'applySlidePlan: `place` runs last however the plan lists it — the correction is the answer, not a step toward it');
    check(dist(pv(q1, A), [1, 2, 3]) === 0, 'applySlidePlan: ...so the placed vertex keeps the law\'s point, not the shaping pass\'s');
  }

  // ---- 22h2. `slideQuadrantTargets` skips a vertex the law has nothing to say about, rather than guessing
  {
    const { mesh, adj, edgeHandle } = meshContext(base);
    const P = posOf(base);
    const du = sub(P(C), P(A)), dv = sub(P(B), P(A));
    const rim = (GRID_ROWS - 1) * GRID_COLS + 5;                 // the last vertex row: no +u neighbour to lead
    check(slideQuadrantTargets(mesh, edgeHandle, adj, [rim], du, dv, 0.3, 0.3).length === 0, 'slideQuadrantTargets: a rim vertex with no leading neighbour is skipped — it keeps the pass\'s position');
    check(slideQuadrantTargets(mesh, edgeHandle, adj, [A], [0, 0, 0], dv, 0.3, 0.3).length === 0, 'slideQuadrantTargets: a degenerate drag direction names no quadrant');
    check(slideQuadrantTargets(mesh, edgeHandle, adj, [A], du, du, 0.3, 0.3).length === 0, 'slideQuadrantTargets: both axes on one rail is one rail — skipped');
    check(slideQuadrantTargets(mesh, edgeHandle, adj, [A, A, A], du, dv, 0.3, 0.3).length === 1, 'slideQuadrantTargets: a repeated vertex yields one item');

    // a WEDGE quadrant quad has no second axis to fold. Aim the drag exactly down the wedge's own two rails, so its
    // A corner can name no other quadrant, and the vertex must be skipped rather than folded across a collapsed row.
    const r = applyVertexWeld(freshGrid(), [[3 * GRID_COLS + 2, 2 * GRID_COLS + 2]]);
    check(r.ok, 'slideQuadrantTargets: wedge fixture built by welding an adjacent edge');
    if (r.ok) {
      const ctx = meshContext(r.doc);
      const wq = r.doc.quads.findIndex(q => q[2] === q[3]);
      const [wa, wb, wc] = r.doc.quads[wq];
      const Pw = posOf(r.doc);
      const got = slideQuadrantTargets(ctx.mesh, ctx.edgeHandle, ctx.adj, [wa], sub(Pw(wc), Pw(wa)), sub(Pw(wb), Pw(wa)), 0.3, 0.3);
      check(got.length === 0, `slideQuadrantTargets: a WEDGE quadrant quad has no second axis — the vertex is skipped, not folded across the collapsed row (${got.length} items)`);
    }
  }

  // ---- 22i. weld pairs for a vertex run: only the lead item's `toward` is standing still
  {
    const cols = GRID_COLS;
    const run = [3 * cols + 5, 3 * cols + 6, 3 * cols + 7, 3 * cols + 8];
    const items = [0, 1, 2].map(i => ({ vertex: run[i], toward: run[i + 1], t: 0.3 }));
    const pairs = vertexSlideWeldPairs(items);
    check(JSON.stringify(pairs) === JSON.stringify([[run[2], run[3]]]), `vertexSlideWeldPairs: a 3-item run yields exactly its lead pair (${JSON.stringify(pairs)}) — the others merely vacate a seat their successor has already left`);
    check(JSON.stringify(vertexSlideWeldPairs([items[0]])) === JSON.stringify([[run[0], run[1]]]), 'vertexSlideWeldPairs: a lone item always welds');
    check(vertexSlideWeldPairs([{ vertex: A, toward: A, t: 0.3 }]).length === 0, 'vertexSlideWeldPairs: a self-edge has nothing to weld');
    check(JSON.stringify(vertexSlideWeldPairs([items[2], items[2]])) === JSON.stringify([[run[2], run[3]]]), 'vertexSlideWeldPairs: repeated items de-duplicate');

    // and the pairs are GEOMETRY: dragged to the clamp, the lead vertex has arrived at its `toward`
    const doc = structuredClone(base);
    slideVerticesAlongEdges(doc, items.map(it => ({ ...it, t: 1.4 })));
    const span = dist(pv(base, run[2]), pv(base, run[3]));
    const gapLead = dist(pv(doc, run[2]), pv(base, run[3]));
    check(gapLead < 1e-2 * span, `vertexSlideWeldPairs: at the clamp the lead vertex has arrived at its toward (${gapLead.toExponential(2)} m of a ${span.toFixed(1)} m edge)`);
    const w = applyVertexWeld(doc, pairs);
    check(w.ok && w.doc.vertices.length / 3 === base.vertices.length / 3 - 1, 'vertexSlideWeldPairs: releasing there retires exactly one vertex');
  }

  // ---- 22j. sanity: a 2-D-slid doc is still a mesh — manifold, watertight, and it tessellates without a NaN
  {
    const P = posOf(base);
    const du = sub(P(C), P(A)), dv = sub(P(B), P(A));
    const cell = structuredClone(base);
    applySlidePlan(cell, { passes: [cellPlan(base, [QC], du, 0.3), cellPlan(base, [QC], dv, 0.42), placeOf([A, B, C, D], du, dv, 0.3, 0.42)], weld: [] });
    const corner = structuredClone(base);
    applySlidePlan(corner, { passes: [{ kind: 'patch', quad: QC, vertex: A, towardU: C, tu: 0.3, towardV: B, tv: 0.42 }], weld: [] });
    const edge = structuredClone(base);
    applySlidePlan(edge, { passes: [{ kind: 'edges', items: [{ quad: QC, edge: [A, B] }], t: 0.3 }, { kind: 'verts', items: [{ vertex: A, toward: B, t: 0.3 }, { vertex: B, toward: base.quads[cid(3, 6)][1], t: 0.3 }], }, placeOf([A, B], du, dv, 0.3, 0.3)], weld: [] });
    for (const [name, d] of [['cell', cell], ['corner', corner], ['edge', edge]] as const) {
      check(!hasNaN(d) && watertight(d).ok && checkManifold(d.quads).ok, `2-D slide ${name}: finite, watertight, manifold`);
      check(d.quads.length === Q0 && d.vertices.length / 3 === V0, `2-D slide ${name}: topology untouched (a slide adds nothing)`);
      const preview = buildMountainPreview(d);
      check(!preview.positions.some(x => !Number.isFinite(x)) && !preview.normals.some(x => !Number.isFinite(x)), `2-D slide ${name}: the derived quilt tessellates with no NaN`);
    }
  }

  // ---- 22k. the freeze law: a plan is a function of the FROZEN base, and re-cutting a re-cut composes
  {
    const P = posOf(base);
    const passes = [cellPlan(base, [QC], sub(P(C), P(A)), 0.3), cellPlan(base, [QC], sub(P(B), P(A)), 0.42)];
    const once = structuredClone(base); applySlidePlan(once, { passes, weld: [] });
    const twice = structuredClone(base); applySlidePlan(twice, { passes, weld: [] });
    check(canon(once) === canon(twice), 'freeze law: the same plan on two clones of the base gives bit-identical docs — a drag frame is pure');
    const chained = structuredClone(once); applySlidePlan(chained, { passes, weld: [] });
    const travel = dist(pv(chained, A), pv(once, A));
    check(canon(chained) !== canon(once), `freeze law: the same plan applied to its OWN OUTPUT composes the cuts and moves the corner another ${travel.toFixed(2)} m — a host that drops its \`structuredClone(base)\` runs away from the cursor`);
    check(travel > 1e-3, `freeze law: ...and the composition is a real re-cut, not a rounding wobble (${travel.toFixed(3)} m)`);
  }

  // ---- 22l. THE EXACTNESS LEDGER for a 2-D cell drag: every moved VERTEX is exactly on the parent surface, and nothing
  // else is. What the shaping passes buy is the moved boundary CURVES between those vertices — so the ledger is measured,
  // not asserted: each of the dragged cell's four moved boundaries is sampled at 9 parameters and every sample's true
  // distance to the parent surface (the 2×2 base-patch block the drag lives in) is found by a shrinking-window scan.
  //
  // Three variants answer whether the v-pass earns its keep:
  //   1. u + v + place — the shipped shape: the v-pass leaves each moved boundary the parent's own iso-curve tangent AT
  //      the cut parameter, and `place` seats the corners on the law.
  //   2. u + place     — no v-pass: the corners are still on the law, but each boundary carries the tangent it had a
  //      whole cell away, at v = 0.
  //   3. u + v         — today's composition, no correction: the CURVES hug the surface, but two of the four corners sit
  //      metres from where the law puts them (22f). Off-surface distance cannot see that; the ledger below shows why the
  //      corner column matters as much as the curve column.
  {
    const P = posOf(base);
    const du = sub(P(C), P(A)), dv = sub(P(B), P(A));
    const T = 0.3;
    const uP = cellPlan(base, [QC], du, T), vP = cellPlan(base, [QC], dv, T);
    const place = placeOf([A, B, C, D], du, dv, T, T);
    const block = [QC, NU, NV, NUV].map(q => netOf(base, q));   // the parent surface the drag stays inside
    const cubicOf = (d: QuadMeshDoc, x: number, y: number): [V3, V3, V3, V3] => {
      const { edgeHandle } = meshFromDoc(d);
      const Px = pv(d, x), Py = pv(d, y);
      return [Px, add(Px, edgeHandle(x, y)), add(Py, edgeHandle(y, x)), Py];
    };
    /** Distance from `q` to one bicubic patch: a coarse scan, then a shrinking window on the best (section-21 idiom). */
    const nearestOn = (cp: V3[], q: V3): number => {
      let bu = 0.5, bvv = 0.5, bd = Infinity, hu = 0.5, hv = 0.5;
      for (let pass = 0; pass < 9; pass++) {
        const lu = Math.max(0, bu - hu), ru = Math.min(1, bu + hu);
        const lv = Math.max(0, bvv - hv), rv = Math.min(1, bvv + hv);
        const S = pass === 0 ? 28 : 8;
        let cu = bu, cv = bvv;
        for (let i = 0; i <= S; i++) for (let j = 0; j <= S; j++) {
          const u = lu + (ru - lu) * (i / S), v = lv + (rv - lv) * (j / S);
          const dd = dist(patchPoint(cp, u, v), q);
          if (dd < bd) { bd = dd; cu = u; cv = v; }
        }
        bu = cu; bvv = cv; hu = (ru - lu) / S; hv = (rv - lv) / S;
      }
      return bd;
    };
    const offSurface = (q: V3) => Math.min(...block.map(cp => nearestOn(cp, q)));
    const bez = (c: [V3, V3, V3, V3], t: number): V3 => {
      const s = 1 - t;
      return [0, 1, 2].map(k => s * s * s * c[0][k] + 3 * s * s * t * c[1][k] + 3 * s * t * t * c[2][k] + t * t * t * c[3][k]) as V3;
    };

    const rows = ([['1. u + v + place', [uP, vP, place]], ['2. u + place    ', [uP, place]], ['3. u + v (control)', [uP, vP]]] as [string, SlidePass[]][])
      .map(([name, passes]) => {
        const d = structuredClone(base);
        applySlidePlan(d, { passes, weld: [] });
        let curve = 0;
        for (const [x, y] of [[A, B], [C, D], [A, C], [B, D]] as [number, number][]) {
          const c = cubicOf(d, x, y);
          for (let i = 0; i <= 8; i++) curve = Math.max(curve, offSurface(bez(c, i / 8)));
        }
        const corner = Math.max(...[A, B, C, D].map(v => offSurface(pv(d, v))));
        // no quad inverts: the skyward normal stays skyward across the whole 4×3 neighbourhood the drag touches
        const { mesh: m2, edgeHandle: eh2 } = meshFromDoc(d);
        let skyward = true;
        for (let r = 2; r <= 5; r++) for (let c = 4; c <= 6; c++) {
          const cp = quadControlPoints(m2, eh2, cid(r, c), d.quadTwist?.[cid(r, c)]);
          for (let i = 0; i <= 3; i++) for (let j = 0; j <= 3; j++) if (patchNormal(cp, i / 3, j / 3)[1] <= 0) skyward = false;
        }
        return { name, d, curve, corner, skyward };
      });

    // The scan converges on the foot's PARAMETER, so a point known to be exactly on the surface still reads a small
    // distance. Measure that floor on four such points rather than guess a threshold: it is what "reads zero" means here.
    const probeFloor = Math.max(...block.map(cp => offSurface(patchPoint(cp, T, T))));

    console.log(`      2-D cell drag exactness ledger (tu=tv=${T}, ${diag.toFixed(1)} m quad diagonal), off-surface distance`
      + ` (the scan's own floor on a point known to be ON the surface: ${probeFloor.toExponential(2)} m):`);
    for (const r of rows) console.log(`        ${r.name}: moved boundary curves ${r.curve.toFixed(4)} m = ${(100 * r.curve / diag).toFixed(3)}%   |   corners ${r.corner.toExponential(2)} m = ${(100 * r.corner / diag).toExponential(1)}%`);

    for (const r of rows) {
      check(checkManifold(r.d.quads).ok && watertight(r.d).ok && !hasNaN(r.d), `ledger ${r.name.trim()}: manifold, watertight, finite`);
      check(r.skyward, `ledger ${r.name.trim()}: no quad inverts — every patch normal in the touched neighbourhood stays skyward`);
    }
    check(probeFloor < 1e-3 * rows[2].curve, `ledger: the off-surface scan reads its own floor (${probeFloor.toExponential(2)} m) three orders under the errors it reports — it measures what it claims`);
    check(rows[0].corner <= 3 * probeFloor && rows[1].corner <= 3 * probeFloor, `ledger: with \`place\`, every moved vertex is ON the parent surface — the scan cannot tell it from a point it was handed (${rows[0].corner.toExponential(2)} m vs a ${probeFloor.toExponential(2)} m floor)`);
    check(rows[2].corner > 20 * probeFloor, `ledger: without it the corners drift off the surface (${rows[2].corner.toExponential(2)} m, ${(rows[2].corner / probeFloor).toFixed(0)}× the floor) — and they sit metres from the law's point ALONG it, which no off-surface distance can see (22f)`);
    check(rows[0].curve < rows[1].curve, `ledger: the v-pass EARNS ITS KEEP — the moved boundary curves hug the parent to ${(100 * rows[0].curve / diag).toFixed(3)}% of the diagonal with it and ${(100 * rows[1].curve / diag).toFixed(3)}% without (u + place alone leaves each boundary the tangent it had a cell away)`);
    check(rows[0].curve < 1e-3 * diag, `ledger: ...and that is the whole inexactness of a 2-D cell drag — ${rows[0].curve.toFixed(4)} m on a ${diag.toFixed(1)} m cell, all of it between the vertices`);
  }
}

console.log(failures ? '\nMESHOPS-SLIDE: FAIL' : '\nMESHOPS-SLIDE: PASS');
process.exit(failures ? 1 : 0);
