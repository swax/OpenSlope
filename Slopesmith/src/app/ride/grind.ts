import * as THREE from 'three';

/**
 * The ridable rail network under the test ride ([Trailmap: 350]) — the analytic curve query the grind state
 * re-runs every tick. The engine rides each rail segment as a TRUE parametric cubic, never its chords: a
 * broad-phase AABB walk with ±3 m slack picks the candidate segments, a coarse five-sample / four-chord pass
 * only *brackets* the nearest span, and a golden-section search refines the closest point on the real curve,
 * whose exact derivative is the travel tangent. Heading therefore varies continuously along a bend — there are
 * no per-segment heading steps. The same query serves acquisition, staying on, and chaining onto a following
 * rail (chaining is just the query accepting a different candidate on the next tick).
 *
 * The doc's rails arrive as the SAME cubic-Bézier chains the export writes to `Splines.json` (core/rails), so
 * the curve the board grinds here is byte-for-byte the curve snowknife bakes for the ISO and Unity.
 */

// [Trailmap: 350] the broad-phase slack: ±300 engine units (3 m) of AABB gate around each candidate segment.
const BROAD_PAD = 3;
// [Trailmap: 350] the golden-section refine on the true cubic: 1/φ split, ≤24 iterations, parameter tol ≈5e-4.
const GOLD_A = 0.61803, GOLD_B = 0.38197, GOLD_ITERS = 24, GOLD_TOL = 5e-4;
/**
 * [Trailmap: 350] the rail-local acceptance windows (engine units ÷100 → m): the grind holds only while the
 * rider's offsets from the queried curve point stay inside |along| < lerp(0.80, 1.50, b), |vert| < 0.72,
 * |lat| < lerp(0.30, 0.72, b). The blend `b` is forced to 1 (the widest windows) for the first 0.6 s of a
 * grind as an attach grace; what feeds it after the grace is untraced [open], so it sits at 0 (the tightest).
 * Entry runs the same windows scaled 0.9 — getting on is slightly stricter than staying on.
 */
export const RAIL_ALONG_MIN = 0.80, RAIL_ALONG_MAX = 1.50;
export const RAIL_VERT = 0.72;
export const RAIL_LAT_MIN = 0.30, RAIL_LAT_MAX = 0.72;
export const RAIL_ENTRY_SCALE = 0.9;
export const RAIL_GRACE = 0.6;

/** One rail handed to the network: its Bézier chain (four WORLD-space control points per segment, the form
 *  `railBezierSegments` emits), the SurfaceType it grinds as (normally 13 metal / 12 wood; named retail
 *  exceptions include style-5 ice), and the deck's rail-local seat above that authored curve. Retail and bare
 *  splines already name the rider/contact line and use zero; a generated pipe uses its tube radius because its
 *  spline is the decoration's centreline. The surface REPLACES the terrain's in the rider's contact fields while
 *  grinding ([Trailmap: 350]). */
export interface GrindRailIn {
  segments: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3][];
  surf: number;
  /** Metres from the authored curve toward rail-local up to the visible deck origin. */
  seat: number;
}

/** The query's answer: the nearest curve point, its exact tangent, and the rider's rail-local offsets. */
export interface GrindHit {
  rail: number;
  surf: number;
  /** Closest point ON the cubic (world). */
  point: THREE.Vector3;
  /** Unit curve tangent there (world). Unsigned — sign it against the travel direction yourself. */
  tangent: THREE.Vector3;
  /** The rail-local vertical: world up squared against the tangent — the frame the deck stands in. */
  up: THREE.Vector3;
  /** Rider offsets in the rail-local frame (m): along the tangent, up the local vertical, across. */
  along: number; vert: number; lat: number;
  /** This rail's authored-curve → deck-origin offset in metres. */
  seat: number;
}

/** The acceptance windows on a query result: `b` is the grace blend (1 = widest), `scale` 0.9 for entry. */
export function railWindows(hit: GrindHit, b: number, scale = 1): boolean {
  const mix = (lo: number, hi: number) => (lo + (hi - lo) * b) * scale;
  return Math.abs(hit.along) < mix(RAIL_ALONG_MIN, RAIL_ALONG_MAX)
      && Math.abs(hit.vert) < RAIL_VERT * scale
      && Math.abs(hit.lat) < mix(RAIL_LAT_MIN, RAIL_LAT_MAX);
}

interface Seg {
  rail: number; surf: number; seat: number;
  cp: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  min: THREE.Vector3; max: THREE.Vector3; // control hull + BROAD_PAD (the curve lies inside its hull)
}

export function createGrindRails(railsIn: GrindRailIn[]) {
  const segs: Seg[] = [];
  for (let r = 0; r < railsIn.length; r++) {
    for (const cp of railsIn[r].segments) {
      const min = cp[0].clone(), max = cp[0].clone();
      for (let i = 1; i < 4; i++) { min.min(cp[i]); max.max(cp[i]); }
      min.addScalar(-BROAD_PAD); max.addScalar(BROAD_PAD);
      segs.push({ rail: r, surf: railsIn[r].surf, seat: railsIn[r].seat, cp, min, max });
    }
  }

  // per-query scratch (the query runs every tick; nothing here allocates once warm)
  const pt = new THREE.Vector3(); const ab = new THREE.Vector3(); const ap = new THREE.Vector3();
  const coarse = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  function bez(cp: Seg['cp'], t: number, out: THREE.Vector3): THREE.Vector3 {
    const u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    return out.set(
      a * cp[0].x + b * cp[1].x + c * cp[2].x + d * cp[3].x,
      a * cp[0].y + b * cp[1].y + c * cp[2].y + d * cp[3].y,
      a * cp[0].z + b * cp[1].z + c * cp[2].z + d * cp[3].z,
    );
  }
  function bezTangent(cp: Seg['cp'], t: number, out: THREE.Vector3): THREE.Vector3 {
    const u = 1 - t, a = 3 * u * u, b = 6 * u * t, c = 3 * t * t;
    return out.set(
      a * (cp[1].x - cp[0].x) + b * (cp[2].x - cp[1].x) + c * (cp[3].x - cp[2].x),
      a * (cp[1].y - cp[0].y) + b * (cp[2].y - cp[1].y) + c * (cp[3].y - cp[2].y),
      a * (cp[1].z - cp[0].z) + b * (cp[2].z - cp[1].z) + c * (cp[3].z - cp[2].z),
    );
  }

  /**
   * Nearest point across the whole network. Engine shape exactly: AABB broad phase, the coarse
   * t ∈ {0, ¼, ½, ¾, 1} chord bracket (the query point projected onto the four chords picks the nearest
   * span — the chords are only the bracket, never the ridden curve), then golden section on the true cubic.
   */
  function query(pos: THREE.Vector3): GrindHit | null {
    let best: Seg | null = null; let bestT = 0; let bestD2 = Infinity;
    for (const seg of segs) {
      if (pos.x < seg.min.x || pos.x > seg.max.x || pos.y < seg.min.y || pos.y > seg.max.y
        || pos.z < seg.min.z || pos.z > seg.max.z) continue;
      for (let i = 0; i < 5; i++) bez(seg.cp, i / 4, coarse[i]);
      // bracket: the chord whose closest point to `pos` is nearest
      let span = 0, spanD2 = Infinity;
      for (let i = 0; i < 4; i++) {
        ab.subVectors(coarse[i + 1], coarse[i]);
        ap.subVectors(pos, coarse[i]);
        const len2 = ab.lengthSq();
        const s = len2 > 1e-12 ? Math.min(1, Math.max(0, ap.dot(ab) / len2)) : 0;
        const d2 = pt.copy(coarse[i]).addScaledVector(ab, s).distanceToSquared(pos);
        if (d2 < spanD2) { spanD2 = d2; span = i; }
      }
      // golden section over the bracketed span, re-evaluating the true cubic each probe
      let a = span / 4, b = (span + 1) / 4;
      let x1 = a + GOLD_B * (b - a), x2 = a + GOLD_A * (b - a);
      let f1 = bez(seg.cp, x1, pt).distanceToSquared(pos);
      let f2 = bez(seg.cp, x2, pt).distanceToSquared(pos);
      for (let i = 0; i < GOLD_ITERS && (b - a) > GOLD_TOL; i++) {
        if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = a + GOLD_B * (b - a); f1 = bez(seg.cp, x1, pt).distanceToSquared(pos); }
        else { a = x1; x1 = x2; f1 = f2; x2 = a + GOLD_A * (b - a); f2 = bez(seg.cp, x2, pt).distanceToSquared(pos); }
      }
      const t = (a + b) / 2;
      const d2 = bez(seg.cp, t, pt).distanceToSquared(pos);
      if (d2 < bestD2) { bestD2 = d2; best = seg; bestT = t; }
    }
    if (!best) return null;

    const point = bez(best.cp, bestT, new THREE.Vector3());
    const tangent = bezTangent(best.cp, bestT, new THREE.Vector3());
    if (tangent.lengthSq() < 1e-10) tangent.subVectors(best.cp[3], best.cp[0]); // degenerate cusp: chord stands in
    tangent.normalize();
    // the rail-local frame: vertical = world up squared against the tangent (rails are never plumb; guard anyway)
    const up = new THREE.Vector3(0, 1, 0).addScaledVector(tangent, -tangent.y);
    if (up.lengthSq() < 1e-6) up.set(1, 0, 0).addScaledVector(tangent, -tangent.x);
    up.normalize();
    const lat = new THREE.Vector3().crossVectors(tangent, up);
    const d = new THREE.Vector3().subVectors(pos, point);
    return {
      rail: best.rail, surf: best.surf, seat: best.seat, point, tangent, up,
      along: d.dot(tangent), vert: d.dot(up), lat: d.dot(lat),
    };
  }

  return { query, get segmentCount() { return segs.length; } };
}

export type GrindRails = ReturnType<typeof createGrindRails>;
