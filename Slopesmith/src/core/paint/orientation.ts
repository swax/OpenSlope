/**
 * Tile orientation (D4) for texture paint: a placed tile may be rotated in quarter-turns and/or
 * mirrored (right-click cycles the 8 states). This transforms the tile's UVs by that orientation so
 * the preview and the export bake land the tile the right way. Pure: no I/O, no pixels.
 */

/**
 * Transform a tile UV coordinate by a D4 orientation (mirror-then-rotate). `u,v` in [0,1]; the
 * rotation `(a,b)→(b,1-a)` is a 90° clockwise turn, mirror flips u. Used by the preview + the bake.
 */
export function orientUV(u: number, v: number, rot: number, mirror: boolean): [number, number] {
  let a = mirror ? 1 - u : u, b = v;
  for (let i = 0; i < (((rot % 4) + 4) % 4); i++) { const na = b, nb = 1 - a; a = na; b = nb; }
  return [a, b];
}

/**
 * ONE quarter-turn (or one mirror) of a D4 state — what ← / → do to a tile, wherever a tile is worn: the
 * held brush, a Palette cell, a painted terrain quad (`turnOrient`), and the single tile a tiled prop wears
 * (`AuthoredModel.orient`).
 *
 * `dir` −1 (→) steps `rot` DOWN, which reads as a quarter CW on screen: the surface samples through
 * `orientUV`, whose rising `rot` reads CCW on it. `flip` toggles the mirror and holds the rotation instead —
 * mirrored tiles are essentially unused in the original game, so flipping is a deliberate act and nothing
 * cycles into one. Shared rather than re-derived per caller because "which way does → turn it" has to be
 * one answer: two copies that disagree by a sign are invisible in code and obvious on the mountain.
 */
export function turnD4(o: { rot: number; mirror: boolean }, dir: 1 | -1, flip: boolean):
{ rot: number; mirror: boolean } {
  return flip
    ? { rot: o.rot, mirror: !o.mirror }
    : { rot: (o.rot + (dir === -1 ? 3 : 1)) % 4, mirror: o.mirror };
}

/**
 * The same D4 as a CSS transform, for the flat pictures of a tile the panels show — the Palette's pad cells
 * and the tiled prop's texture swatch. Drawn the way the TERRAIN renders it (via `orientUV`) so a picture of
 * a tile and the surface wearing it agree: rot 0 is upright (file-native, 0 = up), and a rising rot turns a
 * non-mirrored tile CCW (the UV rotation reads counter-clockwise on the surface), a mirrored tile the other
 * way. Display only — the stored rot and the bake are unchanged. Verified against the 3D F overlay for all 8
 * states, which is the reason it lives beside `orientUV` rather than in whichever panel needed it first: the
 * two have to be re-derived together or a swatch quietly starts lying about its surface.
 */
export function orientCss(rot: number, mirror: boolean): string {
  return `rotate(${(mirror ? rot : -rot) * 90}deg) scaleX(${mirror ? -1 : 1})`;
}

/** rot (quarter-turns) + mirror as a short label, e.g. "0°", "90° ⇋" — the readout the Palette's rotation
 *  column has always shown, shared so a tile reads the same in every panel that states one. */
export function orientText(rot: number, mirror: boolean): string {
  return `${((rot % 4) + 4) % 4 * 90}°${mirror ? ' ⇋' : ''}`;
}

/**
 * Recover the D4 orientation (quarter-turns + mirror) a tile is applied at, from a patch's four tile-UV
 * corners `[uvA@(0,0), uvB@(0,1), uvC@(1,0), uvD@(1,1)]` (the ref-level/patchUV order). This is the inverse
 * of `orientUV` as the F overlay draws it: the patch's `+u` tile-UV edge (uvC−uvA) and `+v` edge (uvB−uvA)
 * give the tile's oriented basis, and we return the D4 state whose `orientUV` basis points the same way — so
 * sampling a patch lands the brush at the rotation its pink art-F shows against the green frame-F, and
 * painting it back reproduces that orientation. Degenerate / missing UVs → 0°.
 */
export function orientFromPatchUV(uv: number[][]): { rot: number; mirror: boolean } {
  if (!uv || uv.length < 4 || !uv[0] || !uv[1] || !uv[2]) return { rot: 0, mirror: false };
  const norm = (x: number, y: number): [number, number] => {
    const l = Math.hypot(x, y);
    return l < 1e-9 ? [0, 0] : [x / l, y / l];
  };
  const du = norm(uv[2][0] - uv[0][0], uv[2][1] - uv[0][1]); // +u tile-UV edge (patch corner A→C)
  const dv = norm(uv[1][0] - uv[0][0], uv[1][1] - uv[0][1]); // +v tile-UV edge (patch corner A→B)
  if (du[0] === 0 && du[1] === 0) return { rot: 0, mirror: false };
  if (dv[0] === 0 && dv[1] === 0) return { rot: 0, mirror: false };
  // the F overlay maps a tile at (rot,mirror) through t(u,v) = [a, −b] of orientUV (the terrain UV's v-flip);
  // match that oriented unit basis against the observed edges and take the best-scoring of the 8 D4 states.
  const tAt = (u: number, v: number, rot: number, mirror: boolean): [number, number] => {
    const [a, b] = orientUV(u, v, rot, mirror);
    return [a, -b];
  };
  let best = { rot: 0, mirror: false }, bestScore = -Infinity;
  for (let rot = 0; rot < 4; rot++) for (const mirror of [false, true]) {
    const t0 = tAt(0, 0, rot, mirror), tU = tAt(1, 0, rot, mirror), tV = tAt(0, 1, rot, mirror);
    const dut = norm(tU[0] - t0[0], tU[1] - t0[1]), dvt = norm(tV[0] - t0[0], tV[1] - t0[1]);
    const score = du[0] * dut[0] + du[1] * dut[1] + dv[0] * dvt[0] + dv[1] * dvt[1];
    if (score > bestScore) { bestScore = score; best = { rot, mirror }; }
  }
  return best;
}
