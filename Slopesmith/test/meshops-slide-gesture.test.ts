/**
 * Headless checks for THE HOST PATH of a Surface-mode drag: the pure gesture planner
 * (src/core/mesh/slide-gesture.ts). test/meshops-slide.test.ts pins the geometry the plan is made of;
 * this file pins the PLAN — which passes it carries, at which parameters, and what a release welds.
 * Run: `npx tsx test/meshops-slide-gesture.test.ts`
 *
 * Split out of test/meshops.test.ts; the grid fixture and the `check()` tally live in
 * test/meshops.fixture.ts, shared with the other `meshops-*` checks.
 */
import * as THREE from 'three';
import { meshFromDoc, quadControlPoints, buildQuadMesh, meshAdjacency, meshEdgeHandles, vertexAxes, vertexFrame } from '../src/core/mesh/topology';
import { patchPoint, cubicPoint, nearestCubicT } from '../src/core/math/bezier';
import { add, cross, dot, len, mul, norm, sub } from '../src/core/math/vec';
import { applyVertexWeld, checkManifold, ekey } from '../src/core/mesh/ops';
import { SLIDE_EPS, SLIDE_MERGE_SNAP, applySlidePlan, edgeSlideTargets, planCellSlide, slideEdgesInQuads, slideVertexAlongEdge, slideWeldPairs, type EdgeSlideItem, type SlidePass } from '../src/core/mesh/slide';
import { planSlideRecut, slideDragFrame, slideRail, type SlideExact } from '../src/core/mesh/slide-gesture';
import { railToLocal } from '../src/app/viewport/gizmo/arcs';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import { watertight, hasNaN, GRID_COLS, GRID_ROWS, freshGrid, cellCols, V0 } from './meshops.fixture';
import { check, failures } from './check';

// ---- 23. THE HOST PATH for a Surface-mode drag: the pure gesture planner (src/core/mesh/slide-gesture.ts) -------------
// The viewport freezes a `SlideExact` at pointer-down, resolves the dragged anchor into the pad's two coordinates
// (`slideDragFrame`) and hands the host one `SlidePlan` per frame (`planSlideRecut`). Sections 17–22 pin the geometry
// the plan is made of; this one pins the PLAN: which passes it carries, at which parameters, and what a release welds.
//
// The regression that matters is the two in-plane ARROWS. They are the precision instrument and they shipped in 1-D
// long before the pad existed, so the yardstick below is an inline replica of the three viewport bodies + the three
// host callbacks as they stood — not the planner itself. A changed item search, a different lead rail, a re-labelled
// weld or a shifted clamp all move a bit and fail there.
{
  const dist = (a: V3, b: V3) => len(sub(a, b));
  const pv = (d: QuadMeshDoc, i: number): V3 => [d.vertices[i * 3], d.vertices[i * 3 + 1], d.vertices[i * 3 + 2]];
  const cid = (r: number, c: number) => r * cellCols + c;
  const netOf = (doc: QuadMeshDoc, q: number): V3[] => {
    const { mesh, edgeHandle } = meshFromDoc(doc);
    return quadControlPoints(mesh, edgeHandle, q, doc.quadTwist?.[q]);
  };
  const base = freshGrid();
  const QC = cid(3, 5);
  const [A, B, C, D] = base.quads[QC];
  const uSpan = dist(pv(base, A), pv(base, C)), vSpan = dist(pv(base, A), pv(base, B));

  /**
   * The `SlideExact` `seatExactSlide` would freeze for this selection: the frozen net, the gizmo anchor (a corner's
   * own seat, or the selection's centroid), and the two flavours of surface axis — the frame's raw tangents `tu`/`tv`
   * (which orient `vertexAxes`' pairs) and the gizmo's orthonormal arrows `tu`/`padV = n × tu`. Mirrors
   * `cornerFrame` / `regionFrame` + `frameQuat`'s local Z.
   */
  const seat = (opts: { vertex?: number; edges?: [number, number][]; cells?: number[] }): SlideExact => {
    const mesh = buildQuadMesh(base.vertices.slice(), base.quads);
    const adj = meshAdjacency(mesh);
    const verts = opts.vertex !== undefined ? [opts.vertex]
      : opts.edges ? [...new Set(opts.edges.flat())]
      : [...new Set(opts.cells!.flatMap(q => base.quads[q]))];
    let tu: V3, tv: V3, n: V3;
    if (opts.vertex !== undefined) {                                     // cornerFrame
      const f = vertexFrame(base.vertices, adj, opts.vertex);
      tu = norm(f.tu); tv = norm(f.tv); n = f.n;
    } else {                                                             // regionFrame: the members' averaged frame
      let sN: V3 = [0, 0, 0], sU: V3 = [0, 0, 0];
      for (const i of verts) { const f = vertexFrame(base.vertices, adj, i); sN = add(sN, f.n); sU = add(sU, norm(f.tu)); }
      n = norm(sN);
      tu = norm(sub(sU, mul(n, dot(sU, n))));
      tv = cross(n, tu);
    }
    let c: V3 = [0, 0, 0];
    for (const i of verts) c = add(c, mul(pv(base, i), 1 / verts.length));
    return {
      mesh, adj, eh: meshEdgeHandles(mesh, base.edgeHandles ? { ...base.edgeHandles } : undefined),
      twist: base.quadTwist ? structuredClone(base.quadTwist) : undefined,
      anchor0: opts.vertex !== undefined ? pv(base, opts.vertex) : c,
      tu, tv, padV: cross(n, tu),
      vertex: opts.vertex ?? -1, edges: opts.edges ?? [], cells: opts.cells ?? [],
    };
  };
  /** Where the gizmo anchor sits after a drag of `du` along the red arrow and `dv` along the blue one, in metres. */
  const at = (s: SlideExact, du: number, dv: number): V3 => add(add(s.anchor0, mul(s.tu, du)), mul(s.padV, dv));
  const cut = (s: SlideExact, ax: 'X' | 'Z' | 'XZ', p: V3) => {
    const g = slideDragFrame(s, ax, p);
    return g && planSlideRecut(s, g);
  };
  const applied = (plan: { passes: SlidePass[]; weld: [number, number][] }) => {
    const d = structuredClone(base); applySlidePlan(d, plan); return d;
  };
  const kinds = (plan: { passes: SlidePass[] }) => plan.passes.map(x => x.kind).join('+');
  /** Every vertex a plan actually moved, so the `place`/`patch` subject set can be checked against reality. */
  const movedVerts = (d: QuadMeshDoc) => {
    const out: number[] = [];
    for (let i = 0; i < base.vertices.length / 3; i++) if (dist(pv(base, i), pv(d, i)) > 1e-12) out.push(i);
    return out;
  };

  const cornerS = seat({ vertex: A });
  const edgeS = seat({ edges: [[Math.min(A, B), Math.max(A, B)]] });
  const cellS = seat({ cells: [QC] });
  const downEdgeS = seat({ edges: [[Math.min(A, C), Math.max(A, C)]] });          // rails run along v, not u
  const cols = GRID_COLS;
  const loopS = seat({ edges: [[3 * cols + 5, 3 * cols + 6], [3 * cols + 6, 3 * cols + 7], [3 * cols + 7, 3 * cols + 8]] });
  const rimS = seat({ vertex: (GRID_ROWS - 1) * cols + 5 });                      // no +u neighbour: the rim clamp

  // ---- 23a. the two frames, and why the planner carries both. `vertexFrame` crosses `tv × tu` and flips the result
  // skyward, so the gizmo's blue arrow (`frameQuat`'s local Z = `n × tu`) generally runs AGAINST the raw `tv` — while
  // `vertexAxes`' v pair is oriented BY the raw `tv`. Read a neighbour's side off the pad axis and the corner slides
  // away from the arrow the user is pulling.
  {
    check(Math.abs(dot(cornerS.tu, cornerS.padV)) < 1e-12, `slide frame: the pad's two axes are orthonormal — |tu·padV| = ${Math.abs(dot(cornerS.tu, cornerS.padV)).toExponential(1)}, so stripping one coordinate leaves the other exact`);
    check(Math.abs(dot(cornerS.tu, cornerS.tv)) > 1e-3, `slide frame: ...and the raw axis TANGENTS are not — |tu·tv| = ${Math.abs(dot(cornerS.tu, cornerS.tv)).toFixed(4)} on the default grid, so the two frames are genuinely different bases`);
    check(dot(cornerS.tv, cornerS.padV) < 0, `slide frame: the blue arrow runs AGAINST the raw tv here (tv·padV = ${dot(cornerS.tv, cornerS.padV).toFixed(4)}) — a skyward-flipped normal reverses n × tu`);

    const zPlan = cut(cornerS, 'Z', at(cornerS, 0, 0.4 * vSpan))!;
    const toward = (zPlan.plan.passes[0] as Extract<SlidePass, { kind: 'verts' }>).items[0].toward;
    const agree = (x: number) => dot(norm(sub(pv(base, x), pv(base, A))), cornerS.padV);
    const { v } = vertexAxes(cornerS.adj, A);
    const other = v[0] === toward ? v[1] : v[0];
    check(agree(toward) > 0.9, `slide frame: a +Z drag slides the corner toward the neighbour the BLUE ARROW points at (agreement ${agree(toward).toFixed(4)})`);
    check(agree(other) < -0.9, `slide frame: ...and not toward the other end of its v axis, which the arrow points away from (agreement ${agree(other).toFixed(4)}) — the side comes off \`tv\`, the coordinate off \`padV\``);
  }

  // ---- 23b. THE REGRESSION. Every unchanged in-plane arrow path, over a drag sweep that covers the near clamp, the
  // working range, the far clamp and both signs. The yardstick is the shipped 1-D code, inlined. Edge/loop ALONG
  // arrows deliberately leave that baseline in 23i-5; their old across-rail behaviour was the defect.
  {
    /** The viewport's three per-family bodies and the host's three callbacks as they shipped, in 1-D. */
    const shipped = (s: SlideExact, ax: 'X' | 'Z', p: V3): { doc: QuadMeshDoc; weld: [number, number][]; pos: V3; merge: boolean } | null => {
      const fPos = (i: number): V3 => [s.mesh.vertices[i * 3], s.mesh.vertices[i * 3 + 1], s.mesh.vertices[i * 3 + 2]];
      const fRail = (from: number, to: number): [V3, V3, V3, V3] => {
        const P0 = fPos(from), P3 = fPos(to), o = sub(s.anchor0, P0);
        return [add(P0, o), add(add(P0, s.eh(from, to)), o), add(add(P3, s.eh(to, from)), o), add(P3, o)];
      };
      const lead = (items: EdgeSlideItem[]): [number, number] | null => {
        let best: [number, number] | null = null, bd = Infinity;
        for (const { quad, edge } of items) for (const pair of edgeSlideTargets(s.mesh.quads[quad], edge) ?? []) {
          const r = sub(fPos(pair[0]), s.anchor0), q = dot(r, r);
          if (q < bd) { bd = q; best = pair; }
        }
        return best;
      };
      const clamp = (t: number) => Math.min(Math.max(t, SLIDE_EPS), 1 - SLIDE_EPS);
      const park = (rail: [V3, V3, V3, V3], t: number) => cubicPoint(rail[0], rail[1], rail[2], rail[3], clamp(t));
      const d = sub(p, s.anchor0);
      const along = dot(d, ax === 'X' ? s.tu : s.tv);                   // the arrow's own axis TANGENT, signed
      if (Math.abs(along) < 1e-9) return null;
      const doc = structuredClone(base);
      if (s.vertex >= 0) {                                              // slideRecutVertex + onSlideVertexAlongEdge
        const { u, v } = vertexAxes(s.adj, s.vertex);
        const pair = ax === 'X' ? u : v;
        const ahead = along > 0 ? pair[1] : pair[0];
        const toward = ahead >= 0 ? ahead : along > 0 ? pair[0] : pair[1];
        if (toward < 0) return null;
        const rail = fRail(s.vertex, toward);
        const t = ahead >= 0 ? nearestCubicT(rail[0], rail[1], rail[2], rail[3], p) : 0;
        slideVertexAlongEdge(doc, s.vertex, toward, t);
        const merge = ahead >= 0 && t >= 1 - SLIDE_EPS;
        return { doc, weld: [[s.vertex, toward]], pos: park(rail, t), merge };
      }
      if (s.cells.length) {                                             // slideRecutCells + onSlideCells
        const plan = planCellSlide(s.mesh, s.adj, s.cells, d, fPos);
        if (!plan) return null;
        const pair = lead(plan.items);
        if (!pair) return null;
        const rail = fRail(pair[0], pair[1]);
        const t = plan.blocked ? 0 : nearestCubicT(rail[0], rail[1], rail[2], rail[3], p);
        slideEdgesInQuads(doc, plan.items, t);
        return { doc, weld: plan.weld, pos: park(rail, t), merge: !plan.blocked && t >= 1 - SLIDE_EPS };
      }
      const items: EdgeSlideItem[] = [];                                // slideRecutEdges + onSlideEdges
      let blocked = false;
      for (const e of s.edges) {
        let ahead = -1, best = 0, any = -1;
        for (const q of s.adj.edgeQuads.get(ekey(e[0], e[1])) ?? []) {
          const targets = edgeSlideTargets(s.mesh.quads[q], e);
          if (!targets) continue;
          if (any < 0) any = q;
          const k = dot(sub(fPos(targets[0][1]), fPos(targets[0][0])), d);
          if (k > best) { best = k; ahead = q; }
        }
        if (ahead >= 0) items.push({ quad: ahead, edge: e });
        else if (any >= 0) { items.push({ quad: any, edge: e }); blocked = true; }
      }
      if (!items.length) return null;
      const pair = lead(items);
      if (!pair) return null;
      const rail = fRail(pair[0], pair[1]);
      const t = blocked ? 0 : nearestCubicT(rail[0], rail[1], rail[2], rail[3], p);
      slideEdgesInQuads(doc, items, t);
      return { doc, weld: slideWeldPairs(base.quads, items), pos: park(rail, t), merge: !blocked && t >= 1 - SLIDE_EPS };
    };

    const sweep = [-1.4, -0.35, 0.02, 0.35, 0.8, 1.4];
    // a little OFF-axis noise: the arrow reads its parameter off the raw pointer, and the planner must too — its
    // `pu` is the pointer itself when the other coordinate is a literal zero, which is what makes the bits match
    const noise: V3 = [0.031, -0.017, 0.023];
    let bits = true, welds = true, parks = true, merges = true, ran = 0, merged = 0;
    const rows: [string, SlideExact, readonly ('X' | 'Z')[]][] = [
      ['corner', cornerS, ['X', 'Z']], ['edge', edgeS, ['X']], ['loop', loopS, ['X']],
      ['cell', cellS, ['X', 'Z']], ['rim corner', rimS, ['X', 'Z']],
    ];
    for (const [name, s, axes] of rows) {
      for (const ax of axes) {
        for (const k of sweep) {
          const p = add(at(s, ax === 'X' ? k * uSpan : 0, ax === 'Z' ? k * vSpan : 0), noise);
          const want = shipped(s, ax, p), got = cut(s, ax, p);
          ran++;
          if (!want || !got) { if (!!want !== !!got) bits = welds = parks = merges = false; continue; }
          if (JSON.stringify(applied(got.plan)) !== JSON.stringify(want.doc)) { bits = false; console.log(`      MISMATCH doc: ${name} ${ax} ${k}`); }
          // the shipped host stored the weld every frame and committed it only when the drag was clamped; the plan
          // carries exactly the weld a release WOULD commit, so that is what the two must agree on
          if (JSON.stringify(got.plan.weld) !== JSON.stringify(want.merge ? want.weld : [])) { welds = false; console.log(`      MISMATCH weld: ${name} ${ax} ${k}`); }
          if (JSON.stringify(got.pos) !== JSON.stringify(want.pos)) { parks = false; console.log(`      MISMATCH pos: ${name} ${ax} ${k}`); }
          if (got.merge !== want.merge) { merges = false; console.log(`      MISMATCH merge: ${name} ${ax} ${k}`); }
          if (want.merge) merged++;
        }
      }
    }
    check(ran === 48 && merged >= 6, `arrow regression: ${ran} unchanged arrow drags over 5 selections and 6 travels, ${merged} of them clamped at a merge — the sweep reaches both clamps`);
    check(bits, 'arrow regression: every unchanged arrow plan applied to the frozen base is BYTE-IDENTICAL to the shipped 1-D slide — corner, edge/loop across, cell and a rim corner');
    check(welds, 'arrow regression: ...and names the same weld a release would commit');
    check(parks, 'arrow regression: ...and parks the gizmo anchor on the same point of the same rail');
    check(merges, 'arrow regression: ...and raises the merge hint on the same frames');
  }

  // ---- 23c. THE STRIP. Each axis projects its own drag onto its own frozen rail, after the other axis's travel is
  // taken out — so a pad drag reads the parameter the matching ARROW would read, whatever the cross drift. Without the
  // strip the foot of the raw pointer slides along the rail and the parameter drifts with it.
  {
    const arrow = cut(cornerS, 'X', at(cornerS, 0.4 * uSpan, 0))!;
    const tArrow = (arrow.plan.passes[0] as Extract<SlidePass, { kind: 'verts' }>).items[0].t;
    const pad = cut(cornerS, 'XZ', at(cornerS, 0.4 * uSpan, 0.3 * vSpan))!;
    const tPad = (pad.plan.passes[0] as Extract<SlidePass, { kind: 'patch' }>).tu;
    check(pad.plan.passes[0].kind === 'patch' && Math.abs(tArrow - tPad) < 1e-12, `pad strip: a pad drag 0.3 of a cell off the rail reads the ARROW's own u parameter (${tArrow.toFixed(12)} vs ${tPad.toFixed(12)})`);

    // the same projection WITHOUT the strip — the yardstick that keeps the check above from passing vacuously
    const P0 = pv(base, A), P3 = pv(base, C);
    const rail: [V3, V3, V3, V3] = [P0, add(P0, cornerS.eh(A, C)), add(P3, cornerS.eh(C, A)), P3];
    const tRaw = nearestCubicT(rail[0], rail[1], rail[2], rail[3], at(cornerS, 0.4 * uSpan, 0.3 * vSpan));
    check(Math.abs(tRaw - tArrow) > 1e-6, `pad strip: ...where projecting the RAW pointer moves it to ${tRaw.toFixed(12)}, ${(1e3 * Math.abs(tRaw - tArrow) * uSpan).toFixed(3)} mm along a ${uSpan.toFixed(1)} m rail`);

    // and a cross drift under SLIDE_EPS drops the v pass and the `place` with it: the plan IS the 1-D plan
    const tiny = cut(cornerS, 'XZ', at(cornerS, 0.4 * uSpan, 1e-6 * vSpan))!;
    check(JSON.stringify(applied(tiny.plan)) === JSON.stringify(applied(arrow.plan)), 'pad strip: a cross drift under SLIDE_EPS carries no v pass and no `place` — the pad is byte-identical to the arrow there');
  }

  // ---- 23d. THE LAW, as the plan states it: a 2-D drag writes every vertex it moves onto the parent surface. The
  // subject set is what is really at stake — a `place` pass that misses one moved vertex leaves it on the chord the
  // shaping passes dragged it down (22f/22g measure that miss at metres). So the moved set is read back off the
  // applied doc and compared with the pass's own items, and every one of them is scanned against the parent patches.
  {
    /** Distance from `q` to one bicubic patch: a coarse scan, then a shrinking window (the section-21/22 idiom). */
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
    // the parent surface a drag around QC can reach: the frozen nets of every quad touching the cell's own corners
    const block = base.quads.flatMap((q, i) => q.some(x => [A, B, C, D].includes(x)) ? [netOf(base, i)] : []);
    const offSurface = (q: V3) => Math.min(...block.map(cp => nearestOn(cp, q)));
    // the scan converges on the foot's PARAMETER, so a point known to be on the surface still reads a small distance:
    // measure that floor rather than guess a threshold
    const floor = Math.max(...block.map(cp => offSurface(patchPoint(cp, 0.3, 0.42))));

    const rows: [string, SlideExact, number[]][] = [
      ['corner', cornerS, [A]],
      ['edge', edgeS, [A, B]],
      ['cell', cellS, [A, B, C, D]],
    ];
    const report: string[] = [];
    for (const [name, s, want] of rows) {
      const c = cut(s, 'XZ', at(s, 0.3 * uSpan, 0.42 * vSpan))!;
      const doc = applied(c.plan);
      const moved = movedVerts(doc);
      check(JSON.stringify(moved) === JSON.stringify([...want].sort((x, y) => x - y)), `2-D plan (${name}): the drag moves exactly the vertices the law is stated for (${moved.join(',')})`);
      const seatSet = c.plan.passes.flatMap(p => p.kind === 'place' ? p.items.map(i => i.vertex) : p.kind === 'patch' ? [p.vertex] : []);
      check(JSON.stringify([...seatSet].sort((x, y) => x - y)) === JSON.stringify(moved), `2-D plan (${name}): ...and the \`${name === 'corner' ? 'patch' : 'place'}\` pass seats every one of them — a miss would leave it on the shaping passes' chord`);
      const worst = Math.max(...moved.map(v => offSurface(pv(doc, v))));
      report.push(`${name} ${worst.toExponential(2)} m`);
      check(worst <= 3 * floor, `2-D plan (${name}): every moved vertex is ON the parent surface — the scan cannot tell it from a point it was handed (${worst.toExponential(2)} m vs a ${floor.toExponential(2)} m floor)`);
      check(Math.max(...moved.map(v => dist(pv(doc, v), pv(base, v)))) > 0.1 * uSpan, `2-D plan (${name}): ...and the drag really travelled (${Math.max(...moved.map(v => dist(pv(doc, v), pv(base, v)))).toFixed(2)} m) — the claim is not exactness by standing still`);
      check(!hasNaN(doc) && watertight(doc).ok && checkManifold(doc.quads).ok, `2-D plan (${name}): the re-cut doc is finite, watertight and manifold`);
      // the anchor the gizmo parks on IS the geometry, so the handle never floats off what it just wrote
      if (name === 'corner') check(dist(c.pos, pv(doc, A)) === 0, '2-D plan (corner): the gizmo anchor parks on the patch point the pass wrote, to the bit');
    }
    console.log(`      2-D plan: worst moved-vertex off-surface distance (scan floor ${floor.toExponential(2)} m): ${report.join(', ')}`);
  }

  // ---- 23e. A MERGING AXIS PINS THE OTHER AT ZERO. So the committed geometry sits on the weld target rather than
  // springing back off it, the plan carries the single pass the 1-D slide would have carried, and the weld applies.
  {
    const rows: [string, SlideExact, string][] = [
      ['corner', cornerS, 'verts'],
      ['edge', edgeS, 'edges'],
      ['loop', loopS, 'edges'],
      ['cell', cellS, 'edges'],
    ];
    for (const [name, s, kind] of rows) {
      const c = cut(s, 'XZ', at(s, 1.4 * uSpan, 0.02 * vSpan))!;
      check(c.merge && kinds(c.plan) === kind, `merge (${name}, u saturated): the plan carries the u pass alone — no v pass, no \`place\` (${kinds(c.plan)})`);
      check(c.plan.weld.length > 0, `merge (${name}): ...and names ${c.plan.weld.length} weld pair(s) ${JSON.stringify(c.plan.weld)}`);
      const doc = applied(c.plan);
      const w = applyVertexWeld(doc, c.plan.weld);
      check(w.ok, `merge (${name}): releasing at the clamp welds — \`applyVertexWeld\` accepts the plan's pairs`);
      check(w.ok && checkManifold(w.doc.quads).ok && !hasNaN(w.doc) && watertight(w.doc).ok, `merge (${name}): ...and the merged doc is manifold, watertight and finite`);
      check(w.ok && w.doc.vertices.length / 3 === base.vertices.length / 3 - c.plan.weld.length, `merge (${name}): ...retiring exactly one vertex per pair (${base.vertices.length / 3} → ${w.ok ? w.doc.vertices.length / 3 : -1})`);
    }
    // the ALONG axis of an edge loop merges too, and its weld is the run's LEAD pair alone — the earlier items merely
    // vacate a seat their successor has already left (`vertexSlideWeldPairs`)
    const along = cut(loopS, 'XZ', at(loopS, 0.02 * uSpan, 1.4 * vSpan))!;
    check(along.merge && kinds(along.plan) === 'verts', `merge (loop, along the loop): the plan is the endpoint run alone (${kinds(along.plan)})`);
    check(along.plan.weld.length === 1, `merge (loop, along): ...and only the run's LEAD endpoint welds (${JSON.stringify(along.plan.weld)}) — the other three shift one seat`);
    const wl = applyVertexWeld(applied(along.plan), along.plan.weld);
    check(wl.ok && checkManifold(wl.doc.quads).ok, 'merge (loop, along): releasing there welds, and the merged doc is manifold');
  }

  // ---- 23f. BOTH AXES SATURATED MERGES NOTHING, and the two candidate welds are measured rather than asserted.
  // A corner hauled into both clamps has arrived at its quadrant quad's FAR corner — the one diagonally across from
  // it. Two welds could be read off that state and neither is a merge:
  //   • `V → far` is what the GEOMETRY asks for, and it is the one fusion `applyVertexWeld` refuses outright: a quad
  //     has no encoding for a diagonal collapse, only for the edge-collapsed wedge [A,B,C,C].
  //   • `V → Nu` + `V → Nv`, the naive union of the two 1-D welds, PASSES the guard — but Nu and Nv are that same
  //     diagonal pair, so union-find fuses all three through V, drops the quadrant quad, and lands the corner a whole
  //     cell back up the rails it had just crossed. That is a teleport, not a fusion of what met.
  // Two cells' worth of merge is a different topological operation. The drag simply clamps against the corner.
  {
    for (const [name, s] of [['corner', cornerS], ['edge', edgeS], ['cell', cellS]] as [string, SlideExact][]) {
      const c = cut(s, 'XZ', at(s, 1.4 * uSpan, 1.4 * vSpan))!;
      check(c.plan.weld.length === 0 && !c.merge, `both saturated (${name}): no merge — the drag clamps into the far corner instead (${kinds(c.plan)})`);
    }
    const sat = cut(cornerS, 'XZ', at(cornerS, 1.4 * uSpan, 1.4 * vSpan))!;
    const pass = sat.plan.passes[0] as Extract<SlidePass, { kind: 'patch' }>;
    const qv = base.quads[pass.quad];
    const far = qv[3 - qv.indexOf(A)];                       // the slot differing from V in BOTH coordinates
    const qDiag = dist(pv(base, qv[0]), pv(base, qv[3]));
    const arrived = dist(pv(applied(sat.plan), A), pv(base, far));
    check(arrived < 1e-3 * qDiag, `both saturated: the corner has arrived at its quadrant quad's FAR corner, ${(1e3 * arrived).toFixed(1)} mm short of it on a ${qDiag.toFixed(1)} m diagonal — the clamp's own ε step`);
    check(qv.indexOf(pass.towardU) + qv.indexOf(pass.towardV) === 3 && Math.abs(qv.indexOf(pass.towardU) - qv.indexOf(pass.towardV)) !== 0, `both saturated: ...and its two rail neighbours ${pass.towardU} / ${pass.towardV} are that quad's own diagonal pair (slots ${qv.indexOf(pass.towardU)} + ${qv.indexOf(pass.towardV)})`);

    const diag = applyVertexWeld(structuredClone(base), [[A, far]]);
    check(!diag.ok && /DIAGONAL/.test(diag.ok ? '' : diag.error), `both saturated: the weld the geometry asks for — V into that far corner — is exactly the one \`applyVertexWeld\` refuses: "${diag.ok ? '' : diag.error}"`);

    const naive = applyVertexWeld(applied(sat.plan), [[A, pass.towardU], [A, pass.towardV]]);
    check(naive.ok && naive.doc.vertices.length / 3 === V0 - 2, `both saturated: ...while the naive union of the two 1-D welds PASSES the guard, fusing all THREE of V, Nu, Nv (${V0} → ${naive.ok ? naive.doc.vertices.length / 3 : -1} vertices) and dropping the quadrant quad`);
    const seat = Math.min(...[A, pass.towardU, pass.towardV].map(x => dist(pv(applied(sat.plan), A), pv(base, x))));
    check(seat > 0.4 * qDiag, `both saturated: ...so it would TELEPORT the corner ${seat.toFixed(1)} m — ${(100 * seat / qDiag).toFixed(0)}% of the quad diagonal — back onto a rail neighbour's seat. Neither weld is a merge, so the pad emits none`);

    // the WALL below the double clamp: u saturated while v sits past the snap. The corner stands on the link EDGE,
    // not on either of its ends, and a quad mesh has no legal T-junction — so the pad clamps and stays clamped.
    const wall = cut(cornerS, 'XZ', at(cornerS, 1.4 * uSpan, (SLIDE_MERGE_SNAP + 0.3) * vSpan))!;
    check(!wall.merge && wall.plan.weld.length === 0, `merge snap: u saturated with v ${(SLIDE_MERGE_SNAP + 0.3).toFixed(2)} of a cell off its rail is a WALL, not a merge — welding there would teleport the corner back up the link edge`);
    const armed = cut(cornerS, 'XZ', at(cornerS, 1.4 * uSpan, (SLIDE_MERGE_SNAP - 0.02) * vSpan))!;
    check(armed.merge && armed.plan.weld.length === 1, `merge snap: ...and inside the ${SLIDE_MERGE_SNAP} snap it arms, pinning v at zero so the geometry lands ON the weld target`);
  }

  // ---- 23g. THE RIM. An axis with nothing ahead of it pins at `t = 0` and commits no merge. Riding ALONE (an arrow)
  // it still emits its pass, exactly as the 1-D slide does — the geometry and the parked anchor then agree on the
  // clamp's own ε step. SHARING the drag (the pad) it drops out entirely, leaving the live axis the whole gesture.
  {
    const arrow = cut(rimS, 'X', at(rimS, 0.4 * uSpan, 0))!;
    const item = (arrow.plan.passes[0] as Extract<SlidePass, { kind: 'verts' }>).items[0];
    check(kinds(arrow.plan) === 'verts' && item.t === 0 && !arrow.merge, 'rim arrow: no +u neighbour, so the corner pins at t = 0 on the edge that does exist and commits no merge');
    const { u } = vertexAxes(rimS.adj, rimS.vertex);
    check(u[1] < 0 && item.toward === u[0], 'rim arrow: ...and it names the near-side neighbour, the only curve it has');

    const pad = cut(rimS, 'XZ', at(rimS, 0.4 * uSpan, 0.4 * vSpan))!;
    check(kinds(pad.plan) === 'verts' && pad.plan.passes.length === 1, `rim pad: the blocked u axis drops out and the live v axis carries the drag alone (${kinds(pad.plan)})`);
    const padItem = (pad.plan.passes[0] as Extract<SlidePass, { kind: 'verts' }>).items[0];
    check(padItem.t > SLIDE_EPS && padItem.toward !== item.toward, `rim pad: ...at a real v parameter (${padItem.t.toFixed(3)}), along the v axis — no \`place\` pass, because the law has no quadrant quad to state`);
  }

  // ---- 23h. THE EDGE FAMILY'S TWO MOTIONS, and which axis drives which. An edge slides ACROSS the quads it borders
  // (surface-exact) and its endpoints slide ALONG it (curve-exact per endpoint). Which is which is a property of the
  // SELECTION's own rails, not of the gizmo — so a down-mountain edge takes them the other way round, for both pad
  // drags and single-arrow drags.
  {
    const across = cut(edgeS, 'XZ', at(edgeS, 0.3 * uSpan, 0.3 * vSpan))!;
    check(kinds(across.plan) === 'edges+verts+place', `edge roles: a CROSS-SLOPE edge's rails run down u, so u slides it across its quads and v runs its endpoints along it (${kinds(across.plan)})`);
    const aPass = across.plan.passes[0] as Extract<SlidePass, { kind: 'edges' }>;
    check(aPass.items.length === 1 && aPass.items[0].edge[0] === Math.min(A, B), 'edge roles: ...the across pass names the selected edge and the quad ahead of it');

    const down = cut(downEdgeS, 'XZ', at(downEdgeS, 0.3 * uSpan, 0.3 * vSpan))!;
    check(kinds(down.plan) === 'edges+verts+place', 'edge roles: a DOWN-MOUNTAIN edge takes the same shape of plan — the across pass first, so the along pass cuts the parent\'s own iso-curve');
    const dVerts = (down.plan.passes[1] as Extract<SlidePass, { kind: 'verts' }>).items;
    check(dVerts.some(i => i.vertex === A && i.toward === C), 'edge roles: ...but its endpoints run down U, not across it — the roles follow the selection\'s rails, and a hard-wired u = across would slide it sideways twice');

    // the run: every endpoint of a loop takes one seat along the loop, at one shared parameter
    const loop = cut(loopS, 'XZ', at(loopS, 0.3 * uSpan, 0.3 * vSpan))!;
    const lVerts = (loop.plan.passes[1] as Extract<SlidePass, { kind: 'verts' }>).items;
    check(lVerts.length === 4 && new Set(lVerts.map(i => i.t)).size === 1, `edge roles: a 3-edge loop runs all four of its endpoints along itself at one shared parameter (${lVerts.length} items, t = ${lVerts[0].t.toFixed(4)})`);
    check(lVerts.filter(i => lVerts.some(j => j.vertex === i.toward)).length === 3, 'edge roles: ...and three of the four slide onto a seat their neighbour is vacating — only the lead lands on a standing vertex');
  }

  // ---- 23i. THE ARROW IS THE PATH. The Surface gizmo draws its two in-plane arrows as `slideRail`'s own cubics
  // (src/app/viewport/gizmo/arcs.ts) instead of the straight tangents three.js ships. That only means anything if the
  // drawn curve IS the curve the anchor rides: `planSlideRecut` parks it at `railPoint(rail, t)` on exactly the rail
  // `slideRail` hands back, so the shaft is where the thing under the handle goes and the head is the vertex the drag
  // clamps and merges at. Below: the rails exist and point where they say, the parked anchor sits ON them, the head is
  // the weld target, a direction with nowhere to go has no rail — and `railToLocal` agrees with `frameQuat`, which is
  // the one law standing between the blue arrow and being drawn backwards.
  {
    type Rail4 = [V3, V3, V3, V3];
    const railDot = (r: Rail4, d: V3) => dot(norm(sub(r[3], r[0])), norm(d));
    const onAnchor = (r: Rail4, s: SlideExact) => r[0][0] === s.anchor0[0] && r[0][1] === s.anchor0[1] && r[0][2] === s.anchor0[2];
    /** How far `p` sits off a cubic, by the planner's own projection. `nearestCubicT` converges on the foot's
     *  PARAMETER, so even a point taken straight off the curve reads back a small distance — `railFloor` below
     *  measures that, rather than guessing a threshold. */
    const offRail = (r: Rail4, p: V3) => {
      const t = nearestCubicT(r[0], r[1], r[2], r[3], p);
      return dist(cubicPoint(r[0], r[1], r[2], r[3], t), p);
    };

    // ---- 23i-1. the premise. `vertexFrame` crosses `tv × tu` and flips the result skyward, so on this net the
    // gizmo's blue arrow runs AGAINST the frame's raw cross-slope tangent. Every side test downstream reads the
    // neighbour off `tv` and the coordinate off `padV`; swap them and half the drags invert.
    const trap = dot(cornerS.tv, cornerS.padV);
    check(trap < -0.99, `arrow frame: the gizmo's blue arrow runs AGAINST the frame's raw cross-slope tangent here — tv·padV = ${trap.toFixed(6)}, a near-perfect reversal, so the two are interchangeable NOWHERE and reading a side off the wrong one flips the drag`);

    // ---- 23i-2. every arrow points where it says. An interior corner has a rail down all four in-plane directions,
    // each copied onto the gizmo anchor (`rail[0] === anchor0`, to the bit) and each running the way its arrow does.
    const armDirs: [string, V3][] = [
      ['+X', cornerS.tu], ['−X', mul(cornerS.tu, -1)],
      ['+Z', cornerS.padV], ['−Z', mul(cornerS.padV, -1)],
    ];
    const arms = armDirs.map(([nm, d]) => ({ nm, d, rail: slideRail(cornerS, d) as Rail4 | null }));
    check(arms.every(a => !!a.rail), `arrow rails: an interior corner carries a rail down all four in-plane directions (${arms.map(a => `${a.nm} ${a.rail ? 'rail' : 'NONE'}`).join(', ')}) — nothing there falls back to a straight arrow`);
    check(arms.every(a => !!a.rail && onAnchor(a.rail, cornerS)), 'arrow rails: ...each of them seated on the gizmo anchor to the bit — the parent spline copied onto the handle the user is holding, which is what lets the arrow ride the corner during a drag');
    const agree = arms.map(a => (a.rail ? railDot(a.rail, a.d) : -2));
    check(Math.min(...agree) > 0.5, `arrow rails: ...and each running the way its own arrow points (worst chord agreement ${Math.min(...agree).toFixed(6)} of the four — the rails are near-straight on this grid, but a sign error would read −1)`);

    // the projection floor: re-project 41 points taken straight off each rail and keep the worst miss
    let railFloor = 0;
    for (const a of arms) if (a.rail) for (let i = 0; i <= 40; i++) railFloor = Math.max(railFloor, offRail(a.rail, cubicPoint(a.rail[0], a.rail[1], a.rail[2], a.rail[3], i / 40)));
    check(railFloor < 1e-9, `arrow rails: \`nearestCubicT\` re-finds a point taken off its own cubic to ${railFloor.toExponential(2)} m — the floor every "is the anchor ON the rail" reading below is measured against, so none of them is a tautology about a loose threshold`);

    // ---- 23i-3. THE IDENTITY, all three selection families and both arrows: the anchor a drag parks lands ON the
    // cubic the arrow drew. For an edge these are genuinely different curves: ACROSS re-cuts its adjacent quads,
    // while ALONG advances its endpoints down the selected run.
    const pathRows: [string, SlideExact, 'X' | 'Z'][] = [
      ['corner', cornerS, 'X'], ['edge', edgeS, 'X'], ['cell', cellS, 'X'],
      ['corner', cornerS, 'Z'], ['edge', edgeS, 'Z'], ['cell', cellS, 'Z'],
      ['down-mountain edge', downEdgeS, 'Z'],
    ];
    const pathReport: string[] = [];
    for (const [name, s, ax] of pathRows) {
      const dir = ax === 'X' ? s.tu : s.padV;
      const c = cut(s, ax, ax === 'X' ? at(s, 0.35 * uSpan, 0) : at(s, 0, 0.35 * vSpan))!;
      const rail = slideRail(s, dir) as Rail4 | null;
      const off = rail ? offRail(rail, c.pos) : Infinity;
      const rode = rail ? dist(c.pos, s.anchor0) : 0;
      pathReport.push(`${name}/${ax} ${off.toExponential(2)} m off after ${rode.toFixed(3)} m`);
      check(!!rail && off <= railFloor, `arrow is the path (${name}, ${ax}): the anchor a 0.35-cell drag parks is ON the cubic that arrow draws — ${off.toExponential(2)} m off it, inside the ${railFloor.toExponential(2)} m projection floor, after a ${rode.toFixed(3)} m ride`);
    }
    console.log(`      arrow is the path: ${pathReport.join(' | ')}`);

    // ---- 23i-4. THE HEAD IS THE MERGE TARGET. Haul the red arrow five cells past its clamp: the plan welds one pair,
    // and the arrow's last control point is the frozen seat of the vertex it welds INTO. The arrowhead is the vertex
    // you will fuse with, and the anchor parks the clamp's own ε step short of it.
    {
      const far = cut(cornerS, 'X', at(cornerS, 5 * uSpan, 0))!;
      const rail = slideRail(cornerS, cornerS.tu) as Rail4;
      check(far.merge, 'arrowhead: a red-arrow drag hauled five cells past the clamp holds at the far end and arms the merge');
      check(far.plan.weld.length === 1 && far.plan.weld[0][0] === cornerS.vertex, `arrowhead: ...naming exactly one pair, ${JSON.stringify(far.plan.weld)} — the corner under the hand and the vertex it fuses into`);
      const T = far.plan.weld[0][1];
      check(dist(rail[3], pv(base, T)) < 1e-12, `arrowhead: ...and the rail's last control point IS that vertex's frozen seat (${dist(rail[3], pv(base, T)).toExponential(1)} m apart). The head of the drawn arrow is the vertex you will fuse with`);
      const gap = dist(far.pos, rail[3]), chord = dist(rail[0], rail[3]), handle = dist(rail[3], rail[2]);
      check(gap < 3 * SLIDE_EPS * chord, `arrowhead: the anchor parks ${(1e3 * gap).toFixed(3)} mm short of the head, inside 3·SLIDE_EPS·|chord| = ${(1e3 * 3 * SLIDE_EPS * chord).toFixed(3)} mm — a bound loose by exactly 3× here, because this rail's own end handle is ${(handle / chord).toFixed(4)} of its chord`);
      check(Math.abs(gap - 3 * SLIDE_EPS * handle) < 1e-6 * gap, `arrowhead: ...and tightly it is the clamp itself, |B(1−ε) − P₃| = 3ε|P₃−P₂| = ${(1e3 * 3 * SLIDE_EPS * handle).toFixed(4)} mm at ε = SLIDE_EPS (relative miss ${(Math.abs(gap - 3 * SLIDE_EPS * handle) / gap).toExponential(1)}, the cubic's own O(ε²) term)`);
    }

    // ---- 23i-5. NO RAIL, NO ARC. (a) A rim corner's off-mesh direction has no rail, and the gizmo keeps the stock
    // straight arrow there — the honest picture, since the drag clamps and the net stands.
    {
      const { u } = vertexAxes(rimS.adj, rimS.vertex);
      check(slideRail(rimS, rimS.tu) === null, `no rail (rim corner ${rimS.vertex}): +u runs off the mesh (vertexAxes u = [${u[0]}, ${u[1]}]), so no rail and no arc — the stock straight arrow stands where the drag would clamp`);
      check(!!slideRail(rimS, mul(rimS.tu, -1)), 'no rail: ...while −u, which has a neighbour, carries one — a rim kills one direction, not an axis');
    }

    // (b) EDGE AND LOOP ALONG RAILS. Each edge-family arrow keeps the role its selection geometry gives it. ACROSS
    // uses the far-corner rails of adjacent quads; ALONG uses the selected run's endpoint curves. The two arrows are
    // therefore distinct, point where they say, and a one-axis along drag performs the same endpoint motion as the
    // corresponding component of a pad drag.
    {
      const eDir = norm(sub(pv(base, B), pv(base, A)));
      check(Math.abs(dot(eDir, edgeS.padV)) > 0.99, `edge rails: the selected edge [${A},${B}] runs down the BLUE arrow (|dir·padV| = ${Math.abs(dot(eDir, edgeS.padV)).toFixed(6)}) — so +Z asks ALONG it and +X asks ACROSS it`);
      const across = slideRail(edgeS, edgeS.tu) as Rail4;
      check(!!across && railDot(across, edgeS.tu) > 0.99, `edge rails: the ACROSS query answers with a rail that runs the way it points (chord agreement ${railDot(across, edgeS.tu).toFixed(6)})`);
      const along = slideRail(edgeS, edgeS.padV) as Rail4 | null;
      check(!!along && railDot(along, edgeS.padV) > 0.99, `edge rails: the ALONG query answers with an endpoint rail down the selected edge (chord agreement ${along ? railDot(along, edgeS.padV).toFixed(6) : 'NONE'})`);
      check(!!along && dist(along[3], across[3]) > 0.5 * Math.min(uSpan, vSpan), 'edge rails: ...and it is distinct from the across rail, so the blue arrow no longer overlays the red arrow');

      const zc = cut(edgeS, 'Z', at(edgeS, 0, 0.35 * vSpan))!;
      check(kinds(zc.plan) === 'verts' && dist(zc.pos, edgeS.anchor0) > 0.2 * vSpan, `edge rails: a 0.35-cell blue-arrow drag emits the ALONG endpoint pass and carries the anchor ${dist(zc.pos, edgeS.anchor0).toFixed(3)} m (${kinds(zc.plan)}), rather than an ε step across a quad`);
      const zFar = cut(edgeS, 'Z', at(edgeS, 0, 1.4 * vSpan))!;
      check(zFar.merge && kinds(zFar.plan) === 'verts' && zFar.plan.weld.length === 1, `edge rails: hauling that arrow through its clamp arms the run's one lead weld (${JSON.stringify(zFar.plan.weld)})`);

      const loopPlus = slideRail(loopS, loopS.padV) as Rail4 | null;
      const loopMinus = slideRail(loopS, mul(loopS.padV, -1)) as Rail4 | null;
      check(!!loopPlus && !!loopMinus, `edge rails: a 3-edge LOOP exposes along rails in both directions (+Z ${loopPlus ? 'draws' : 'NONE'}, −Z ${loopMinus ? 'draws' : 'NONE'})`);
      check(!!loopPlus && !!loopMinus && railDot(loopPlus, loopS.padV) > 0.99 && railDot(loopMinus, mul(loopS.padV, -1)) > 0.99, 'edge rails: ...and each loop rail follows the sign that asked for it, independent of tiny curvature residue in the perpendicular quad rails');
      const loopForward = cut(loopS, 'Z', at(loopS, 0, 0.35 * vSpan))!;
      const loopBack = cut(loopS, 'Z', at(loopS, 0, -0.35 * vSpan))!;
      check([loopForward, loopBack].every(c => kinds(c.plan) === 'verts' && dist(c.pos, loopS.anchor0) > 0.2 * vSpan), 'edge rails: ...and either arrow direction produces a meaningful along-run endpoint slide');
    }

    // ---- 23i-6. THE VISUAL GUARD. `gizmo/arcs.ts` writes its geometry in the handle's own local units, and its whole
    // picture rests on `railToLocal` agreeing with viewport.ts's `frameQuat`. That quaternion's local X is `flipZ(tu)`
    // and its local Z is `flipZ(tu) × flipZ(n)`, which is `flipZ(n × tu) = flipZ(padV)` — `flipZ` is a reflection, so
    // it negates a cross product. So an orthonormal `(tu, n, padV)` sends a data offset `d` to `(d·tu, d·n, d·padV)`,
    // the `+tu` rail draws down local +X, and the `+padV` rail draws down local +Z rather than backwards along it.
    {
      /** viewport.ts's `frameQuat`, verbatim: local Y = the normal, X = the down-mountain tangent projected into the
       *  tangent plane (falling back to the cross-slope one on a pinched net), Z = X × Y — all Z-negated into the
       *  scene root. */
      const frameQuat = (tu: THREE.Vector3, tv: THREE.Vector3, n: THREE.Vector3): THREE.Quaternion => {
        const flipZ = (v: THREE.Vector3) => new THREE.Vector3(v.x, v.y, -v.z);
        const yAxis = flipZ(n).normalize();
        let xAxis = flipZ(tu); xAxis.addScaledVector(yAxis, -xAxis.dot(yAxis));
        if (xAxis.lengthSq() < 1e-8) { xAxis = flipZ(tv); xAxis.addScaledVector(yAxis, -xAxis.dot(yAxis)); }
        xAxis.normalize();
        const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
        return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
      };
      // `padV = n × tu` on an orthonormal pair, so `tu × padV` hands the normal back — the third axis the planner
      // never stores, and the one `frameQuat` builds its up post from
      const n = cross(cornerS.tu, cornerS.padV);
      check(Math.abs(len(n) - 1) < 1e-12 && Math.abs(dot(n, cornerS.tu)) < 1e-12, `gizmo frame: (tu, n, padV) is orthonormal, so tu × padV recovers the frame's own normal (|n| = ${len(n).toFixed(12)}, n·tu = ${dot(n, cornerS.tu).toExponential(1)})`);

      const qInv = frameQuat(new THREE.Vector3(...cornerS.tu), new THREE.Vector3(...cornerS.tv), new THREE.Vector3(...n)).clone().invert();
      const sc = 0.37; // the helper's uniform handle scale; `railToLocal` divides it out
      let worst = 0;
      for (const a of arms) if (a.rail) for (const p of a.rail) {
        const got = railToLocal(p, cornerS.anchor0, qInv, sc, new THREE.Vector3());
        const d = sub(p, cornerS.anchor0);
        worst = Math.max(worst, dist(got, [dot(d, cornerS.tu) / sc, dot(d, n) / sc, dot(d, cornerS.padV) / sc]));
      }
      check(worst < 1e-9, `gizmo frame: over all 16 control points of the corner's four rails, \`railToLocal\` IS (d·tu, d·n, d·padV)/s — worst miss ${worst.toExponential(2)} m at s = ${sc}, floating-point noise on a 42 m rail. The flipZ and the quaternion cancel exactly`);

      const xFar = railToLocal((arms[0].rail as Rail4)[3], cornerS.anchor0, qInv, sc, new THREE.Vector3());
      check(xFar[0] > 0 && Math.abs(xFar[1]) < 0.05 * xFar[0] && Math.abs(xFar[2]) < 0.05 * xFar[0], `gizmo frame: so the +tu rail's head draws down the gizmo's local +X — [${xFar.map(x => x.toFixed(3)).join(', ')}], the off-axis pair ${(100 * Math.max(Math.abs(xFar[1]), Math.abs(xFar[2])) / xFar[0]).toFixed(2)}% of the shaft (the net's own sag, not a frame error)`);
      const zFar = railToLocal((arms[2].rail as Rail4)[3], cornerS.anchor0, qInv, sc, new THREE.Vector3());
      check(zFar[2] > 0 && Math.abs(zFar[0]) < 0.05 * zFar[2] && Math.abs(zFar[1]) < 0.05 * zFar[2], `gizmo frame: ...and the +padV rail's head down local +Z — [${zFar.map(x => x.toFixed(3)).join(', ')}], off-axis by ${(100 * Math.max(Math.abs(zFar[0]), Math.abs(zFar[1])) / zFar[2]).toFixed(2)}%. NOT backwards, which is what \`slideRail\` reading the neighbour's side off \`tv\` (tv·padV = ${trap.toFixed(4)}) and the coordinate off \`padV\` buys`);
    }
  }

  // ---- 23j. LIVE ARROWS: the rail re-cuts as the corner slides. `arcRails()` always seats a FRESH `SlideExact`
  // off the LIVE net (`buildSlideExact(false)`), never the frozen `slideExact` — so mid-drag the host has re-installed
  // the re-cut doc and the next arrow reads the corner where it now IS. Headless, that is: apply a partial drag's plan
  // to the base, RE-SEAT a `SlideExact` on the re-cut doc at the moved corner, and ask `slideRail` for the arrow. The
  // claim "the bezier updates while dragging" is exactly that this re-seated rail re-originates on the slid corner and
  // shrinks onto the very vertex the drag will merge with, its head pinned there the whole way down.
  {
    type Rail4 = [V3, V3, V3, V3];
    /** `seat({vertex})` against a DIFFERENT doc at an explicit anchor — the frozen-net record `arcRails` builds mid-drag
     *  from the host's re-installed doc. Mirrors `seat`'s field construction: live frame, `padV = n × tu`, twist copied. */
    const reseat = (doc: QuadMeshDoc, vertex: number, anchor: V3): SlideExact => {
      const mesh = buildQuadMesh(doc.vertices.slice(), doc.quads);
      const adj = meshAdjacency(mesh);
      const f = vertexFrame(doc.vertices, adj, vertex);
      const tu = norm(f.tu), tv = norm(f.tv), n = f.n;
      return {
        mesh, adj, eh: meshEdgeHandles(mesh, doc.edgeHandles ? { ...doc.edgeHandles } : undefined),
        twist: doc.quadTwist ? structuredClone(doc.quadTwist) : undefined,
        anchor0: anchor,
        tu, tv, padV: cross(n, tu),
        vertex, edges: [], cells: [],
      };
    };
    /** The polyline length of a rail's cubic at 64 samples — coarse, but the rails are near-straight here, so it tracks
     *  the true arc length to well under a millimetre and its ORDERING (the only thing the shrink checks read) is exact. */
    const railLen = (r: Rail4): number => {
      let L = 0, prev = cubicPoint(r[0], r[1], r[2], r[3], 0);
      for (let i = 1; i <= 64; i++) { const p = cubicPoint(r[0], r[1], r[2], r[3], i / 64); L += dist(p, prev); prev = p; }
      return L;
    };
    const onAnchor = (r: Rail4, p: V3) => r[0][0] === p[0] && r[0][1] === p[1] && r[0][2] === p[2];
    const chordDot = (r: Rail4, d: V3) => dot(norm(sub(r[3], r[0])), norm(d));

    const S0 = seat({ vertex: A });

    // ---- 23j-1. THE DRAGGED ARROW RE-ORIGINATES ON THE MOVED CORNER. A partial +X drag slides the corner most of a
    // cell without merging; re-seating on the re-cut doc puts the +X rail's first control point exactly on where the
    // corner now sits, not on the drag-start seat the frozen record would keep.
    const c1 = cut(S0, 'X', at(S0, 0.4 * uSpan, 0));
    check(!!c1 && dist(c1.pos, S0.anchor0) > 0.1 * uSpan && c1.merge === false,
      `live arrow (re-origin): a 0.4-cell +X drag slides the corner ${c1 ? dist(c1.pos, S0.anchor0).toFixed(3) : '-'} m (> 0.1·uSpan = ${(0.1 * uSpan).toFixed(3)} m) and, partway, does not merge`);
    const d1 = applied(c1!.plan);
    const S1 = reseat(d1, A, c1!.pos);
    check(S1.anchor0 === c1!.pos, 'live arrow (re-origin): the re-seat takes the SLID corner as its anchor (S1.anchor0 === c1.pos, by reference — the moved seat, not the drag-start one)');
    const R1u = slideRail(S1, S1.tu) as Rail4 | null;
    check(!!R1u && onAnchor(R1u, c1!.pos),
      'live arrow (re-origin): the +X rail off the re-cut doc re-originates on that corner — rail[0] IS c1.pos to the bit (frozenRail copies the parent spline onto the live anchor, so a build that kept `slideExact` would draw it from the drag-start corner instead)');

    // ---- 23j-2. THE DRAGGED RAIL SHRINKS; ITS HEAD STAYS THE MERGE TARGET. The +X rail heads for neighbour T; as the
    // corner advances toward T the rail that REMAINS gets shorter, while its last control point stays pinned to T's
    // (unmoving) seat. Drag further and it shrinks again — monotone — head still on T.
    const R0 = slideRail(S0, S0.tu) as Rail4;
    let T = -1;
    for (let i = 0; i < base.vertices.length / 3; i++) if (dist(pv(base, i), R0[3]) < 1e-9) { T = i; break; }
    check(T >= 0, `live arrow (shrink): the +X rail's head R0[3] is the frozen seat of a real neighbour T = ${T} (the +u vertex the drag heads for)`);
    const R1 = slideRail(S1, S1.tu) as Rail4;
    const L0 = railLen(R0), L1 = railLen(R1);
    check(L1 < L0, `live arrow (shrink): the dragged rail gets SHORTER as the corner advances — |R1| ${L1.toFixed(3)} m < |R0| ${L0.toFixed(3)} m (ratio ${(L1 / L0).toFixed(4)}, 64-sample polyline; the corner ate 0.4 of a cell, so ~0.6 of the rail is left)`);
    check(dist(R1[3], pv(d1, T)) < 1e-9, `live arrow (shrink): ...and its HEAD stays pinned to the merge target — R1[3] is pv(d1,T) to ${dist(R1[3], pv(d1, T)).toExponential(1)} m (< 1e-9; the residual is the frozenRail anchor offset, a Sterbenz-exact few ULP)`);
    check(dist(pv(d1, T), pv(base, T)) === 0, `live arrow (shrink): ...and T never moved (a lone corner slide touches only the corner), so pv(d1,T) == pv(base,T) to the bit — the head is nailed to a standing vertex`);
    const c2 = cut(S0, 'X', at(S0, 0.8 * uSpan, 0));
    const d2 = applied(c2!.plan);
    const S2 = reseat(d2, A, c2!.pos);
    const R2 = slideRail(S2, S2.tu) as Rail4;
    const L2 = railLen(R2);
    check(L2 < L1, `live arrow (shrink): a further drag to 0.8 of a cell shrinks it again — |R2| ${L2.toFixed(3)} m < |R1| ${L1.toFixed(3)} m (monotone: the rail is what remains between the moving corner and its fixed target)`);
    check(dist(R2[3], pv(base, T)) < 1e-9, `live arrow (shrink): ...head still on T (R2[3] vs pv(base,T) = ${dist(R2[3], pv(base, T)).toExponential(1)} m) — the arrowhead is the same merge vertex throughout the drag`);
    console.log(`      live arrow (shrink): |R0|=${L0.toFixed(3)}  |R1|=${L1.toFixed(3)}  |R2|=${L2.toFixed(3)} m; ratios R1/R0=${(L1 / L0).toFixed(4)}, R2/R0=${(L2 / L0).toFixed(4)}`);

    // ---- 23j-3. THE CROSS ARROW SWINGS WITH THE CORNER. The moved corner still has cross-slope neighbours, so both
    // blue arrows re-seat on it and each runs (roughly) the way it points — the point is that they re-originate on the
    // slid corner, not that they aim anywhere in particular.
    const zP = slideRail(S1, S1.padV) as Rail4 | null;
    const zM = slideRail(S1, mul(S1.padV, -1)) as Rail4 | null;
    check(!!zP && !!zM, 'live arrow (cross): the slid corner still carries a cross-slope rail each way (+Z and −Z both non-null)');
    check(!!zP && !!zM && onAnchor(zP, c1!.pos) && onAnchor(zM, c1!.pos), 'live arrow (cross): ...and both re-originate on the slid corner (rail[0] === c1.pos), swinging to the surface direction from the new spot');
    const cdP = zP ? chordDot(zP, S1.padV) : -2, cdM = zM ? chordDot(zM, mul(S1.padV, -1)) : -2;
    check(cdP > 0.4 && cdM > 0.4, `live arrow (cross): ...each running the way its own blue arrow points (chord agreement +Z ${cdP.toFixed(3)}, −Z ${cdM.toFixed(3)}, both > 0.4)`);

    // ---- 23j-4. NON-VACUITY: what the OLD frozen behaviour looked like. A build that kept `slideExact` (drag-start net
    // AND drag-start anchor) would re-read S0 every frame, so its +X arrow would be R0 — a CONSTANT length, never the
    // shrunk R1. The shrink checks above only bite because `arcRails` re-seats on the live doc.
    const frozen = railLen(slideRail(S0, S0.tu) as Rail4);
    check(frozen === L0 && frozen > L1, `live arrow (non-vacuity): the frozen (drag-start) seat draws a CONSTANT-length arrow — re-reading S0 gives |R0| ${frozen.toFixed(3)} m every frame, strictly longer than the re-seated ${L1.toFixed(3)} m. Re-seating on the re-cut doc is the whole difference`);
  }
}

console.log(failures ? '\nMESHOPS-SLIDE-GESTURE: FAIL' : '\nMESHOPS-SLIDE-GESTURE: PASS');
process.exit(failures ? 1 : 0);
