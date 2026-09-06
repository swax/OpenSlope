import * as THREE from 'three';
import { cubicPoint } from '../../../core/math/bezier';
import type { V3 } from '../../../core/doc/types';

/**
 * The Surface-mode gizmo's in-plane arrows, bent along the surface (docs/006). A Surface drag is a de Casteljau
 * re-cut: the thing under the handle slides down a boundary CUBIC of the control net, not along the straight tangent
 * three.js draws. So the arrows are drawn as that cubic — `slideRail`'s own curve, the one `planSlideRecut` reads its
 * parameter off — and what you pull is what you see.
 *
 * Two properties fall out, and both are the point:
 *  • the arrow HUGS the slope, over a lip and under a cave roof, because a rail is control-net geometry and never a
 *    vertical probe;
 *  • the arrow ENDS where the drag does. It reaches the stock arrow's length, or the neighbour vertex, whichever comes
 *    first — so pulling back the camera grows it until its head parks exactly on the vertex the slide clamps and
 *    merges at, and it never once points past where the corner can go.
 *
 * Mechanically these are extra Meshes named 'X' / 'Z', parented into TransformControls' own `gizmo.translate` and
 * `picker.translate`. That name is the whole contract: the helper's `updateMatrixWorld` seats every child it finds
 * there on the anchor (position + quaternion + one uniform scale), hides the ones facing the camera and paints the
 * hovered axis yellow — and `intersectObjectWithRay` reads the hit object's name straight into `gizmo.axis`. Sharing
 * the stock materials keeps the highlight; matching the stock's own radii keeps a bent arrow the same weight as the
 * straight Y post beside it. The stock straight meshes are simply hidden while the arcs stand, and un-hidden the
 * moment the gizmo leaves an exact slide (World mode, a knot, a corner region).
 *
 * The geometry is rewritten every frame in HANDLE-LOCAL units, because that is the space the helper's uniform scale
 * lives in: a rail point maps to `qInv · flipZ(p − anchor) / s`. The rails ride the anchor rather than the world, so
 * during a drag the arrow glides with the corner exactly as the stock gizmo does.
 */

/** A cubic Bézier whose first control point IS the gizmo anchor (`slideRail` copies the parent spline onto it). */
export type Rail = readonly [V3, V3, V3, V3];

/** The four rails the arrows follow, in DATA space, all seated on `anchor`. A null direction has no rail — a rim, a
 *  wedge ahead — and draws the stock straight arrow, which is what the drag does there: clamp, and stand. */
export interface SurfaceRails {
  anchor: V3;
  xPlus: Rail | null;
  xMinus: Rail | null;
  zPlus: Rail | null;
  zMinus: Rail | null;
}

export interface GizmoArcs {
  /** One frame. `null` (World mode, the up post, anything that is not an exact slide) restores the stock arrows. */
  update(rails: SurfaceRails | null): void;
}

// three's own translate gizmo, in handle-local units (TransformControls.js `gizmoTranslate`): a 3-sided shaft of
// radius 0.0075 out to 0.5, then a 12-sided cone head from 0.5 to the tip at 0.6.
const SHAFT_R = 0.0075, SHAFT_SIDES = 3, SHAFT_SEGS = 16;
const HEAD_R = 0.04, HEAD_LEN = 0.1, HEAD_SIDES = 12;
const TIP = 0.6;
// ...and its invisible picker: a 4-sided cone, apex on the anchor, widening to radius 0.2 at the tip.
const PICK_R = 0.2, PICK_SIDES = 4, PICK_SEGS = 8;

const LUT = 32;        // chord samples the arc-length table is built from
const MIN_ARC = 0.02;  // a rail this short in handle units has nowhere to point: the arrow is drawn empty

// ---- vector helpers (V3 tuples; three.js only enters at the quaternion) -------------------------------------
const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vmul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const vdot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const vcross = (a: V3, b: V3): V3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const vlen = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const vnorm = (a: V3): V3 => { const l = vlen(a); return l > 1e-12 ? vmul(a, 1 / l) : [0, 0, 0]; };

/** A rail resampled by arc length: the cubic plus the cumulative chord table that inverts it. */
interface Curve { rail: Rail; cum: number[] }

function measure(rail: Rail): Curve {
  const cum = [0];
  let prev = rail[0];
  for (let i = 1; i <= LUT; i++) {
    const p = cubicPoint(rail[0], rail[1], rail[2], rail[3], i / LUT);
    cum.push(cum[i - 1] + vlen(vsub(p, prev)));
    prev = p;
  }
  return { rail, cum };
}

/** The curve parameter at arc length `L`, by linear inverse of the chord table. */
function tAt(c: Curve, L: number): number {
  const n = c.cum.length - 1;
  if (L <= 0) return 0;
  if (L >= c.cum[n]) return 1;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c.cum[m] <= L) lo = m; else hi = m; }
  const span = c.cum[hi] - c.cum[lo];
  return (lo + (span > 1e-12 ? (L - c.cum[lo]) / span : 0)) / n;
}

const pointAt = (c: Curve, L: number): V3 => {
  const t = tAt(c, L);
  return cubicPoint(c.rail[0], c.rail[1], c.rail[2], c.rail[3], t);
};

/** The unit tangent at arc length `L`. The hodograph collapses on a rail whose first handle sits on its own vertex
 *  (a pinched net), so fall back to the chord. */
function tangentAt(c: Curve, L: number): V3 {
  const t = tAt(c, L), s = 1 - t, r = c.rail;
  const d: V3 = [0, 1, 2].map(k =>
    3 * s * s * (r[1][k] - r[0][k]) + 6 * s * t * (r[2][k] - r[1][k]) + 3 * t * t * (r[3][k] - r[2][k])) as V3;
  return vlen(d) > 1e-9 ? vnorm(d) : vnorm(vsub(r[3], r[0]));
}

/** A unit vector across `t`, for seeding the ring frame. */
const seedNormal = (t: V3): V3 => vnorm(vcross(t, Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]));

/** Ring frames at `n + 1` equally arc-spaced stations over `[L0, L1]`, parallel-transported so the tube carries no
 *  twist. `(e1, e2, T)` is right-handed (`e1 × e2 = T`), which is what makes the windings below front-facing. */
function stations(c: Curve, L0: number, L1: number, n: number) {
  const P: V3[] = [], T: V3[] = [], E1: V3[] = [], E2: V3[] = [];
  let e1: V3 | null = null;
  for (let i = 0; i <= n; i++) {
    const L = L0 + (L1 - L0) * (i / n);
    const t = tangentAt(c, L);
    if (e1) {
      const proj = vsub(e1, vmul(t, vdot(e1, t)));
      e1 = vlen(proj) > 1e-6 ? vnorm(proj) : seedNormal(t);
    } else e1 = seedNormal(t);
    P.push(pointAt(c, L)); T.push(t); E1.push(e1); E2.push(vcross(t, e1));
  }
  return { P, T, E1, E2 };
}

// ---- fixed index buffers -------------------------------------------------------------------------------------
// Windings, with `(e1, e2, T)` right-handed and ring vertex j at angle 2πj/S: a tube quad is (i,j)(i,j+1)(i+1,j+1)
// then (i,j)(i+1,j+1)(i+1,j); a cone side is (base_j)(base_j+1)(apex); a cap facing −T is (centre)(j+1)(j) and one
// facing +T is (centre)(j)(j+1). All front-facing, which the stock materials' default `side: FrontSide` requires.

function tubeIndices(out: number[], segs: number, sides: number, base = 0) {
  for (let i = 0; i < segs; i++) {
    for (let j = 0; j < sides; j++) {
      const j1 = (j + 1) % sides;
      const a = base + i * sides + j, b = base + i * sides + j1;
      const c = base + (i + 1) * sides + j1, d = base + (i + 1) * sides + j;
      out.push(a, b, c, a, c, d);
    }
  }
}

const ARC_SHAFT_V = (SHAFT_SEGS + 1) * SHAFT_SIDES;
const ARC_RING = ARC_SHAFT_V;              // the cone's base ring
const ARC_APEX = ARC_RING + HEAD_SIDES;
const ARC_CTR = ARC_APEX + 1;              // the cone's base-cap centre
const ARC_V = ARC_CTR + 1;

function arcIndices(): number[] {
  const idx: number[] = [];
  tubeIndices(idx, SHAFT_SEGS, SHAFT_SIDES);
  for (let j = 0; j < HEAD_SIDES; j++) {
    const j1 = (j + 1) % HEAD_SIDES;
    idx.push(ARC_RING + j, ARC_RING + j1, ARC_APEX);   // cone side
    idx.push(ARC_CTR, ARC_RING + j1, ARC_RING + j);    // cone base cap, facing back down the shaft
  }
  return idx;
}

const PICK_RINGS = (PICK_SEGS + 1) * PICK_SIDES;
const PICK_CTR = PICK_RINGS;               // the far cap's centre
const PICK_V = PICK_CTR + 1;

function pickIndices(): number[] {
  const idx: number[] = [];
  tubeIndices(idx, PICK_SEGS, PICK_SIDES);
  const last = PICK_SEGS * PICK_SIDES;
  for (let j = 0; j < PICK_SIDES; j++) idx.push(PICK_CTR, last + j, last + ((j + 1) % PICK_SIDES));
  return idx;
}

function makeGeometry(verts: number, indices: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts * 3), 3));
  g.setIndex(indices);
  return g;
}

const put = (pos: Float32Array, i: number, p: V3) => { pos[i * 3] = p[0]; pos[i * 3 + 1] = p[1]; pos[i * 3 + 2] = p[2]; };

/** Where the arrow ends: the rail's own length, but never past the stock arrow's reach. Zero means the rail is a
 *  speck and the arrow draws nothing. */
const arrowTip = (c: Curve) => {
  const total = c.cum[c.cum.length - 1];
  return total < MIN_ARC ? 0 : Math.min(total, TIP);
};

/** Shaft + head, in handle-local units. Returns false when the rail has no room for an arrow. */
function writeArc(geo: THREE.BufferGeometry, rail: Rail): boolean {
  const c = measure(rail);
  const tip = arrowTip(c);
  if (!tip) { geo.setDrawRange(0, 0); return false; }
  // a short rail gets a proportionally short head, so a stub arrow still reads as an arrow rather than a lone cone
  const k = tip / TIP;
  const headLen = HEAD_LEN * k, headR = HEAD_R * k, base = tip - headLen;

  const pos = (geo.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  const st = stations(c, 0, base, SHAFT_SEGS);
  for (let i = 0; i <= SHAFT_SEGS; i++) {
    for (let j = 0; j < SHAFT_SIDES; j++) {
      const a = (2 * Math.PI * j) / SHAFT_SIDES;
      const r: V3 = [0, 1, 2].map(x => st.E1[i][x] * Math.cos(a) + st.E2[i][x] * Math.sin(a)) as V3;
      put(pos, i * SHAFT_SIDES + j, [0, 1, 2].map(x => st.P[i][x] + r[x] * SHAFT_R) as V3);
    }
  }
  const bp = st.P[SHAFT_SEGS], e1 = st.E1[SHAFT_SEGS], e2 = st.E2[SHAFT_SEGS];
  for (let j = 0; j < HEAD_SIDES; j++) {
    const a = (2 * Math.PI * j) / HEAD_SIDES;
    put(pos, ARC_RING + j, [0, 1, 2].map(x => bp[x] + (e1[x] * Math.cos(a) + e2[x] * Math.sin(a)) * headR) as V3);
  }
  put(pos, ARC_APEX, pointAt(c, tip));
  put(pos, ARC_CTR, bp);
  (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  geo.setDrawRange(0, Infinity);
  return true;
}

/** The grab volume: the same arc, swept by a radius ramping 0 → `PICK_R`, so what the pointer catches is what the
 *  arrow draws. Stale bounds would reject the ray, so the sphere is dropped for `Mesh.raycast` to rebuild. */
function writePick(geo: THREE.BufferGeometry, rail: Rail): boolean {
  const c = measure(rail);
  const tip = arrowTip(c);
  if (!tip) { geo.setDrawRange(0, 0); return false; }

  const pos = (geo.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
  const st = stations(c, 0, tip, PICK_SEGS);
  for (let i = 0; i <= PICK_SEGS; i++) {
    const r = (PICK_R * i) / PICK_SEGS;
    for (let j = 0; j < PICK_SIDES; j++) {
      const a = (2 * Math.PI * j) / PICK_SIDES;
      put(pos, i * PICK_SIDES + j,
        [0, 1, 2].map(x => st.P[i][x] + (st.E1[i][x] * Math.cos(a) + st.E2[i][x] * Math.sin(a)) * r) as V3);
    }
  }
  put(pos, PICK_CTR, st.P[PICK_SEGS]);
  (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  geo.setDrawRange(0, Infinity);
  geo.boundingSphere = null;
  return true;
}

// ---- the four directions --------------------------------------------------------------------------------------
interface ArcDir { axis: 'X' | 'Z'; sign: 1 | -1; arc: THREE.Mesh; pick: THREE.Mesh }

const AXES: readonly ('X' | 'Z')[] = ['X', 'Z'];
const SIGNS: readonly (1 | -1)[] = [1, -1];

const railOf = (r: SurfaceRails, d: ArcDir) =>
  d.axis === 'X' ? (d.sign > 0 ? r.xPlus : r.xMinus) : (d.sign > 0 ? r.zPlus : r.zMinus);

/**
 * A data-space rail point in the handle's own frame: negate Z into the scene root, un-rotate, un-scale.
 *
 * The whole picture rests on this agreeing with `frameQuat`. That quaternion's local X is `flipZ(tu)` and its local Z
 * is `flipZ(tu) × flipZ(n)`, which is `flipZ(n × tu)` — `flipZ` is a reflection, so it negates a cross product — and
 * `n × tu` is `padV`. So an orthonormal `(tu, n, padV)` sends a data offset to `(d·tu, d·n, d·padV)`, and the rail
 * toward the `+padV` neighbour draws along the gizmo's blue arrow rather than against it. Reach for the frame's raw
 * `tv` here and half the nets draw that arrow backwards.
 */
export function railToLocal(p: V3, anchor: V3, qInv: THREE.Quaternion, s: number, out: THREE.Vector3): V3 {
  out.set(p[0] - anchor[0], p[1] - anchor[1], -(p[2] - anchor[2])).applyQuaternion(qInv).divideScalar(s);
  return [out.x, out.y, out.z];
}

/** The stock straight arrow, as a rail: a uniform-speed cubic out to the tip. What a direction with no rail draws. */
const straightRail = (d: ArcDir): Rail => {
  const e: V3 = d.axis === 'X' ? [d.sign, 0, 0] : [0, 0, d.sign];
  return [[0, 0, 0], vmul(e, TIP / 3), vmul(e, (2 * TIP) / 3), vmul(e, TIP)];
};

/**
 * Graft the four arcs (and their pickers) onto a live TransformControls gizmo. Call `update` from inside the wrapper
 * of the helper's `updateMatrixWorld`, AFTER the original body has seated and hidden the handles: the arcs read the
 * scale and quaternion it just wrote, and respect the visibility it just decided.
 */
export function createGizmoArcs(gizmo: THREE.Object3D, picker: THREE.Object3D): GizmoArcs {
  const arcIdx = arcIndices(), pickIdx = pickIndices();
  const dirs: ArcDir[] = [];
  const stock: THREE.Mesh[] = [];

  for (const axis of AXES) {
    const gMeshes = gizmo.children.filter(c => c.name === axis) as THREE.Mesh[];
    const pMeshes = picker.children.filter(c => c.name === axis) as THREE.Mesh[];
    if (!gMeshes.length || !pMeshes.length) continue; // a three.js whose translate gizmo is not what we read
    stock.push(...gMeshes, ...pMeshes);
    for (const sign of SIGNS) {
      const arc = new THREE.Mesh(makeGeometry(ARC_V, arcIdx), gMeshes[0].material as THREE.Material);
      const pick = new THREE.Mesh(makeGeometry(PICK_V, pickIdx), pMeshes[0].material as THREE.Material);
      for (const m of [arc, pick]) {
        m.name = axis;              // the helper seats it, hides it with its axis, and names `gizmo.axis` from it
        m.renderOrder = Infinity;   // ...matching the stock meshes, which draw over the whole scene
        m.frustumCulled = false;    // the bounds are rewritten every frame; the gizmo is never off-screen anyway
        m.visible = false;
      }
      gizmo.add(arc);
      picker.add(pick);
      dirs.push({ axis, sign, arc, pick });
    }
  }

  const qInv = new THREE.Quaternion();
  const scratch = new THREE.Vector3();
  const toLocal = (p: V3, anchor: V3, s: number) => railToLocal(p, anchor, qInv, s, scratch);

  return {
    update(rails: SurfaceRails | null) {
      if (!rails) {
        for (const d of dirs) { d.arc.visible = false; d.pick.visible = false; }
        return; // the stock meshes keep the visibility the helper just gave them
      }
      for (const m of stock) m.visible = false;
      // the gizmo handles ride whatever position the helper just wrote — worldPositionStart while dragging, so a
      // stock arrow stays put as the object slides out from under it. The arcs instead seat on the LIVE anchor
      // (`rails.anchor` follows the corner every frame), so they track the slide. data → scene: negate Z.
      const seatX = rails.anchor[0], seatY = rails.anchor[1], seatZ = -rails.anchor[2];
      for (const d of dirs) {
        const s = d.arc.scale.x;
        // the helper hides an axis pointing at the camera (and shrinks it to nothing); its arcs go with it
        if (!d.arc.visible || s <= 1e-9) { d.arc.visible = false; d.pick.visible = false; continue; }
        d.arc.position.set(seatX, seatY, seatZ);
        d.pick.position.set(seatX, seatY, seatZ);
        qInv.copy(d.arc.quaternion).invert();
        const rail = railOf(rails, d);
        const local: Rail = rail
          ? [toLocal(rail[0], rails.anchor, s), toLocal(rail[1], rails.anchor, s),
             toLocal(rail[2], rails.anchor, s), toLocal(rail[3], rails.anchor, s)]
          : straightRail(d);
        d.arc.visible = writeArc(d.arc.geometry, local);
        d.pick.visible = writePick(d.pick.geometry, local);
      }
    },
  };
}
