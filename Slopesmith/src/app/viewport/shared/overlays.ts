import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { UV_GLYPH_STROKES, F_LINE_WIDTH, CAGE_OCCLUDED_DIM } from '../constants';
import { clamp01 } from '../../../core/math/scalar';

/**
 * Pure overlay-draw helpers shared by the authored terrain, the reference terrain, the paint / edit cell
 * selections and the edit-loop highlights: the tile-orientation F glyph builders (art-space strokes pulled
 * onto the curved surface), the fat-line + control-point drawers, and the cage-wire / point drawers with
 * their behind-surface "ghost" dimming pass. None hold state — they append to a positions array or add
 * meshes to a group the caller owns. `glyphLines` needs the canvas resolution (fat lines are screen-space),
 * which the caller passes in.
 */

/** Append the F glyph's strokes to `out`, each endpoint pulled from art space through `toParam` into the
 *  patch's param square, then onto the surface by `evalWorld`, lifted by `lift`. */
export function appendGlyphStrokes(
  out: number[],
  toParam: (ax: number, ay: number) => [number, number],
  evalWorld: (u: number, v: number) => [number, number, number],
  lift: [number, number, number],
) {
  for (const [x0, y0, x1, y1] of UV_GLYPH_STROKES) {
    for (const [ax, ay] of [[x0, y0], [x1, y1]] as [number, number][]) {
      const [u, v] = toParam(ax, ay);
      const p = evalWorld(clamp01(u), clamp01(v));
      out.push(p[0] + lift[0], p[1] + lift[1], p[2] + lift[2]);
    }
  }
}

/** Append one patch's tile-art F to `out`: the strokes live in the tile's art space, centred on the
 *  patch's tex parallelogram, pulled back through the patch's affine tex map `texA + u·du + v·dv` into
 *  params. Skips a degenerate tex map (no orientation to show). */
export function appendUvGlyph(
  out: number[],
  texA: [number, number], du: [number, number], dv: [number, number],
  evalWorld: (u: number, v: number) => [number, number, number],
  lift: [number, number, number],
) {
  const det = du[0] * dv[1] - du[1] * dv[0];
  if (Math.abs(det) < 1e-9) return;
  const cx = texA[0] + 0.5 * (du[0] + dv[0]), cy = texA[1] + 0.5 * (du[1] + dv[1]); // the tile's centre in tex space
  const S = 0.34; // the glyph spans a third of the tile, matching the panels' F overlays
  appendGlyphStrokes(out, (ax, ay) => {
    // art y-up -> tex y-down (flipY=false sampling), hence the negated y term
    const tx = cx + (ax - 0.5) * S - texA[0], ty = cy - (ay - 0.5) * S - texA[1];
    return [(tx * dv[1] - ty * dv[0]) / det, (ty * du[0] - tx * du[1]) / det];
  }, evalWorld, lift);
}

/** Append one patch's frame F to `out`: the F a tile applied at rot 0 would draw, straight in the
 *  patch's OWN param square — art-right along `+u`, art-up along `+v` — tucked into the quadrant at the
 *  patch's real `(0,0)` corner, so it marks the origin and stays clear of the centred pink art F. */
export function appendFrameGlyph(
  out: number[],
  evalWorld: (u: number, v: number) => [number, number, number],
  lift: [number, number, number],
) {
  appendGlyphStrokes(out, (ax, ay) => [0.04 + 0.34 * ax, 0.04 + 0.34 * ay], evalWorld, lift);
}

/** Dispose + drop everything in an F-overlay group. */
export function clearGlyphGroup(group: THREE.Group) {
  for (const child of group.children) child.traverse(obj => {
    const drawable = obj as THREE.Object3D & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    drawable.geometry?.dispose();
    if (Array.isArray(drawable.material)) for (const m of drawable.material) m.dispose();
    else drawable.material?.dispose();
  });
  group.clear();
}

/** Add one F-overlay line set as FAT lines (F_LINE_WIDTH px — LineBasicMaterial can't go past 1px).
 *  The material needs the canvas `res` (fat lines are screen-space); the host's resize() keeps it fresh.
 *  `depthTest` false draws the set ALWAYS-ON-TOP (ignores the depth buffer entirely), for a highlight that
 *  must stay visible over the surface / selection shade it floats above (e.g. a control net's off-surface
 *  handles); the default true keeps the coincident-only polygon-offset behaviour below. */
export function glyphLines(group: THREE.Group, arr: number[] | Float32Array, color: number, opacity: number,
  res: readonly [number, number], width = F_LINE_WIDTH, renderOrder = 12, depthTest = true) {
  const g = new LineSegmentsGeometry();
  g.setPositions(arr);
  // DoubleSide: worldRoot's chirality flip (negative scale) inverts the fat-line quads' winding,
  // which would back-face-cull the whole overlay.
  // polygonOffset: the glyph is drawn coincident with the surface (no geometric lift), and its depth is
  // biased toward the camera so it wins the depth test against its OWN patch from whichever side it's
  // viewed. This is robust on walls / cave overhangs where a normal-lift would push it INTO the rock (a
  // folded patch's outward side is ambiguous). It's a small bias, so it only beats coincident geometry —
  // real terrain in front still occludes it. Fat lines render as triangles, so GL polygon offset applies.
  const m = new LineMaterial({ color, linewidth: width, transparent: true, opacity, depthTest, depthWrite: false, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  m.resolution.set(res[0], res[1]);
  const l = new LineSegments2(g, m);
  l.renderOrder = renderOrder;
  group.add(l);
}

/** A cloud of always-on-top marker dots (screen-constant size, depth-test off) — the edge-loop / control-net
 *  stops and the loop-cut ghost's inserted-vertex + rim / pole markers. Pure: appends one Points to `group`. */
export function addLoopDots(group: THREE.Group, pts: number[] | Float32Array, color: number, size: number) {
  if (!pts.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pts instanceof Float32Array ? pts : new Float32Array(pts), 3));
  const m = new THREE.PointsMaterial({ color, size, sizeAttenuation: false, transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
  const p = new THREE.Points(g, m);
  p.renderOrder = 11;
  group.add(p);
}

/**
 * A billboard text label, canvas-baked, `w` metres wide and always drawn on top — the START / FINISH
 * callouts on the authored course markers and on a loaded reference's recovered endpoints. Shared so both
 * read identically: the same word over the same kind of place means the same thing whichever mountain it
 * annotates. The sprite owns its texture; dispose it with the group that holds it.
 */
export function textSprite(text: string, color: string, w: number): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 8;
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.strokeText(text, 128, 32);
  ctx.fillStyle = color;
  ctx.fillText(text, 128, 32);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set(w, w / 4, 1);
  return sprite;
}

/** A lazily-built white filled-circle sprite (tinted per-material) so PointsMaterial renders round dots —
 *  CIRCLES — instead of the default square. One shared texture for every round-dot cloud. */
let roundDotSprite: THREE.CanvasTexture | null = null;
function roundDotTexture(): THREE.CanvasTexture {
  if (roundDotSprite) return roundDotSprite;
  const s = 64, cnv = document.createElement('canvas'); cnv.width = cnv.height = s;
  const ctx = cnv.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(s / 2, s / 2, s / 2 - 1, 0, Math.PI * 2); ctx.fill();
  roundDotSprite = new THREE.CanvasTexture(cnv);
  return roundDotSprite;
}

/** Like addLoopDots but the points render as CIRCLES (round sprite, the square corners alpha-clipped),
 *  screen-constant + always-on-top — the control-cage handles (the prospective pull targets). */
export function addRoundDots(group: THREE.Group, pts: number[] | Float32Array, color: number, size: number, renderOrder = 11) {
  if (!pts.length) return;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pts instanceof Float32Array ? pts : new Float32Array(pts), 3));
  const m = new THREE.PointsMaterial({ color, size, sizeAttenuation: false, map: roundDotTexture(), alphaTest: 0.5,
    transparent: true, opacity: 0.95, depthTest: false, depthWrite: false });
  const p = new THREE.Points(g, m);
  p.renderOrder = renderOrder;
  group.add(p);
}

/** Add a cage-wire line set, ghosted: in cage-wires-only view the part hidden behind the (invisible) depth
 *  mask draws dim, the visible part bright; in surface view a single depth-culled pass hides the occluded
 *  part as before. Both passes share the geometry and never write depth. */
export function addCageLines(group: THREE.Group, arr: ArrayLike<number>, color: number, opacity: number, ghost: boolean, renderOrder = 11): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr instanceof Float32Array ? arr : new Float32Array(arr), 3));
  const pass = (op: number, behind: boolean) => {
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: op, depthTest: true, depthWrite: false });
    if (behind) m.depthFunc = THREE.GreaterDepth; // only the fragments farther than the surface = the hidden part
    const l = new THREE.LineSegments(g, m);
    l.renderOrder = renderOrder;
    group.add(l);
  };
  if (ghost) pass(opacity * CAGE_OCCLUDED_DIM, true); // dim: the part hidden behind the invisible depth mask
  pass(opacity, false);                               // bright visible part (or the whole set, depth-culled in surface view)
  return g;
}

/** Add only the faint BEHIND-surface pass of a cage-wire set. Unlike `addCageLines(..., ghost=true)`, this
 * geometry may be a visibility-filtered subset of the bright cage, allowing a locally visible patch to reveal
 * its own hidden controls without X-raying every fully occluded patch on the mountain. */
export function addCageLinesBehind(group: THREE.Group, arr: ArrayLike<number>, color: number, opacity: number, renderOrder = 11): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(arr instanceof Float32Array ? arr : new Float32Array(arr), 3));
  const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: opacity * CAGE_OCCLUDED_DIM,
    depthTest: true, depthWrite: false, depthFunc: THREE.GreaterDepth });
  const l = new THREE.LineSegments(g, m);
  l.renderOrder = renderOrder;
  group.add(l);
  return g;
}

/** Control-point cloud, ghosted the same way as the cage lines: in cage-wires-only view the points behind
 *  the (invisible) surface draw dim, the visible ones bright; in surface view a single pass hides occluded
 *  points as before. Both passes share the geometry and never write depth. */
export function addCagePoints(group: THREE.Group, geo: THREE.BufferGeometry, color: number, size: number, ghost: boolean, renderOrder = 11) {
  const pass = (op: number, behind: boolean) => {
    const m = new THREE.PointsMaterial({ color, size, sizeAttenuation: false, map: roundDotTexture(), alphaTest: 0.05,
      transparent: true, opacity: op, depthTest: true, depthWrite: false });
    if (behind) m.depthFunc = THREE.GreaterDepth;
    const p = new THREE.Points(geo, m);
    p.renderOrder = renderOrder;
    group.add(p);
  };
  if (ghost) pass(CAGE_OCCLUDED_DIM, true); // dim points hidden behind the depth mask
  pass(1, false);                           // bright visible points (or all points, depth-culled in surface view)
}

/** Point-cloud twin of `addCageLinesBehind`: a separately filtered faint pass for controls belonging to a
 * patch that has some front-visible control, without revealing points owned only by fully hidden patches. */
export function addCagePointsBehind(group: THREE.Group, geo: THREE.BufferGeometry, color: number, size: number, renderOrder = 11) {
  const m = new THREE.PointsMaterial({ color, size, sizeAttenuation: false, transparent: true,
    map: roundDotTexture(), alphaTest: 0.05, opacity: CAGE_OCCLUDED_DIM,
    depthTest: true, depthWrite: false, depthFunc: THREE.GreaterDepth });
  const p = new THREE.Points(geo, m);
  p.renderOrder = renderOrder;
  group.add(p);
}
