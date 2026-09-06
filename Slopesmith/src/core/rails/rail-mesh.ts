import type { Rail, V3 } from '../doc/types';
import { cross, len, rotateAroundAxis, sub } from '../math/vec';
import { sampleRail } from './rails';

/**
 * The rail's VISUAL tube (docs/014): a low-poly sweep of the grind curve, matching the shipped rail art.
 * The originals bake each rail as a bespoke swept chunk — a 3–5 sided n-gon tube whose rings follow the
 * spline (the reference Mdl_Rail_Metal_*: cross-section ~30–50 raw units, pentagonal at its roundest), skinned with
 * the red/white split texture (0077.png: half red, half white across V). The shipped UV wiring (148.obj):
 * u wraps the RING and every ring's verts share one v, ping-ponging 0,1,0,1 ring-to-ring — so each ring
 * interval sweeps across the split and the tube reads as ALTERNATING RED/WHITE BANDS down its length, a
 * band pair per ring interval (~1.5–2.5 m). A faithful custom rail is the same sweep + wiring along the
 * authored curve. This ONE sweep feeds both the viewport preview (a BufferGeometry) and the export (OBJ
 * appended to Props.obj), so the tube you see while authoring is the tube that ships. The grind behaviour
 * itself is the SPLINE (Splines.json) — this mesh is decoration along it.
 */

/** Tube dimensions measured off the shipped art: radius ~15–25 raw units → 0.2 m; pentagonal section. */
export const RAIL_TUBE_RADIUS = 0.2;
export const RAIL_TUBE_SIDES = 5;
/** Ring cadence (m) — the shipped chunks' ring spacing, which is also the red/white band-pair length. */
export const RAIL_RING_SPACING = 2.2;

export interface RailTubeGeom {
  /** xyz triples, editor space (m, Y-up) — the frame rail nodes live in. */
  positions: number[];
  /** uv pairs, the shipped wiring: u wraps the ring 0..1; v is shared per ring and ping-pongs 0/1
   *  ring-to-ring, so each interval sweeps the red/white split — alternating bands down the tube. */
  uvs: number[];
  /** Triangle indices into positions/uvs (they are index-aligned). */
  indices: number[];
}

const norm = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * Sweep one rail's curve into its tube. The curve is densely sampled then resampled to the shipped ring
 * cadence (~one ring per RAIL_RING_SPACING metres — smooth bends AND authentic band size regardless of how
 * far apart the authored nodes sit), with parallel-transported frames — each ring's frame is the previous
 * one rotated by the minimal turn between tangents, so the tube never twists through a bend. Fewer than two
 * curve points (a half-drawn rail) yields null, mirroring the exporter's empty-spline guard.
 */
export function sweepRail(rail: Rail, radius = RAIL_TUBE_RADIUS, sides = RAIL_TUBE_SIDES,
                          ringSpacing = RAIL_RING_SPACING): RailTubeGeom | null {
  const dense = sampleRail(rail.nodes, 24);
  if (dense.length < 2) return null;
  const pts: V3[] = [dense[0]];
  let acc = 0;
  for (let i = 1; i < dense.length; i++) {
    acc += len(sub(dense[i], dense[i - 1]));
    if (acc >= ringSpacing) { pts.push(dense[i]); acc = 0; }
  }
  if (acc > 1e-3 || pts.length < 2) pts.push(dense[dense.length - 1]); // always ring the far end
  if (pts.length < 2) return null;

  // tangent per ring: central difference (clamped ends)
  const tangents: V3[] = pts.map((_, i) =>
    norm(sub(pts[Math.min(pts.length - 1, i + 1)], pts[Math.max(0, i - 1)])));

  // initial frame: side = t × up, falling back for a vertical start; b completes the ring basis
  let n = cross(tangents[0], [0, 1, 0]);
  if (len(n) < 1e-4) n = [1, 0, 0];
  n = norm(n);

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringVerts = sides + 1; // seam duplicated so u wraps a clean 0..1

  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      // transport the frame: rotate by the minimal turn from the previous tangent to this one
      const axis = cross(tangents[i - 1], tangents[i]);
      const l = len(axis);
      if (l > 1e-6) n = norm(rotateAroundAxis(n, [axis[0] / l, axis[1] / l, axis[2] / l], Math.asin(Math.min(1, l))));
    }
    const b = norm(cross(tangents[i], n));
    const v = i % 2; // the shipped ping-pong: each ring interval sweeps the red/white split -> candy bands
    for (let j = 0; j <= sides; j++) {
      const around = j / sides;
      const a = around * 2 * Math.PI;
      const off: V3 = [
        Math.cos(a) * n[0] + Math.sin(a) * b[0],
        Math.cos(a) * n[1] + Math.sin(a) * b[1],
        Math.cos(a) * n[2] + Math.sin(a) * b[2],
      ];
      positions.push(pts[i][0] + off[0] * radius, pts[i][1] + off[1] * radius, pts[i][2] + off[2] * radius);
      uvs.push(around, v);
    }
    if (i > 0) {
      const r0 = (i - 1) * ringVerts, r1 = i * ringVerts;
      for (let j = 0; j < sides; j++) {
        indices.push(r0 + j, r1 + j, r1 + j + 1);
        indices.push(r0 + j, r1 + j + 1, r0 + j + 1);
      }
    }
  }
  return { positions, uvs, indices };
}

/** Support post dimensions: a slim square prism, sized off the shipped support posts (~0.08 m half-width). */
export const RAIL_POST_RADIUS = 0.08;
/** Posts sink this far below the ground the node was laid on, so a post never hovers over a dip. */
export const RAIL_POST_SINK = 0.3;

/**
 * The rail's support posts (docs/014): one slim square prism under each node point, from the tube's
 * underside down through the authored standoff (`rail.height`, already baked into every node's Y) and
 * RAIL_POST_SINK into the ground. No terrain sampler needed - the standoff IS the node-to-ground distance
 * as laid, and a dragged node keeps a plausible post. Sides only (the top hides under the tube, the foot
 * sits in the snow); UVs are a constant centre sample - posts bake untextured, like the start gate. The
 * same geometry feeds the viewport preview and the export bake, so the posts you see are the posts that
 * ship. Rails floating too low for a visible post (under ~0.15 m of standoff) yield null.
 */
export function railSupportPosts(rail: Rail, radius = RAIL_POST_RADIUS): RailTubeGeom | null {
  if (rail.nodes.length === 0 || rail.height < 0.15) return null;
  const drop = rail.height + RAIL_POST_SINK;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const p of rail.nodes) {
    const top = p[1] - RAIL_TUBE_RADIUS * 0.5;
    const bottom = p[1] - drop;
    const base = positions.length / 3;
    for (const y of [top, bottom]) {
      positions.push(p[0] - radius, y, p[2] - radius);
      positions.push(p[0] + radius, y, p[2] - radius);
      positions.push(p[0] + radius, y, p[2] + radius);
      positions.push(p[0] - radius, y, p[2] + radius);
      for (let k = 0; k < 4; k++) uvs.push(0.5, 0.5);
    }
    for (let j = 0; j < 4; j++) {
      const a = base + j, b = base + ((j + 1) % 4), c = base + 4 + ((j + 1) % 4), d = base + 4 + j;
      indices.push(a, b, c);
      indices.push(a, c, d);
    }
  }
  return positions.length ? { positions, uvs, indices } : null;
}
