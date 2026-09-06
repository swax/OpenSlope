import * as THREE from 'three';
import { makeTexRef, type TexRef } from '../../../core/paint/textures';
import { orientUV, orientFromPatchUV } from '../../../core/paint/orientation';
import type { PreviewData } from '../../../core/mesh/tessellation';
import type { ReferenceMesh } from '../../../core/reference/terrain';
import { FRAME_GLYPH_COLOR, F_LINE_WIDTH, UV_GLYPH_COLOR } from '../constants';
import { appendFrameGlyph, appendUvGlyph, clearGlyphGroup, glyphLines } from '../shared/overlays';
import type { Stage } from '../stage';

/** The painted substrate the paint visuals read: the authored tessellated preview + its terrain mesh (cell
 *  hits + per-cell tiles / orientations), the loaded reference (patch hits + its recovered tile UVs + the
 *  level that names its tile set), the shared tile-texture cache the ghost drapes with, and the view state
 *  the overlays follow (Edit-mode hidden quads, the control-net cage toggle the green frame Fs ride). The
 *  shell owns all of it and hands it in as closures, null where nothing is loaded. */
export interface PaintMeshAccess {
  preview(): PreviewData | null;
  terrain(): THREE.Mesh;
  reference(): THREE.Mesh | null;
  refData(): ReferenceMesh | null;
  refLevel(): string;
  /** Get a loaded tile texture, or kick off its download (null until ready; arrival re-drapes the ghost). */
  ensureTile(ref: TexRef): THREE.Texture | null;
  /** Edit-mode hidden quads drop their F glyphs with their surface. */
  quadHidden(quad: number): boolean;
  /** The green frame Fs ride the control-net cage's toggle. */
  cageOn(): boolean;
}

/**
 * The texture-paint visuals of Paint mode, serving the authored terrain and the loaded reference alike: the
 * armed brush's translucent drape ghost (the hovered cell's own tessellated surface re-UV'd to the brush's
 * D4 orientation — exactly what a click paints), the amber selection outlines (the selected painted cell(s)
 * and the read-only reference patch, one fat-line style), the tile-orientation F overlays (a pink art F per
 * painted cell / textured patch at its stored D4, a green frame F marking each patch's own param square),
 * and the paint select pick that resolves a click to an authored cell or a reference patch (nearest wins).
 * The layer owns the F toggle and the paint selection state; the shell hands in the painted substrate
 * through accessors (`PaintMeshAccess`) and keeps the paint stroke / surface-sampling pointer routing, with picks
 * reported back through `stage.cb`.
 */
export function createPaintLayer(stage: Stage, mesh: PaintMeshAccess) {
  // the pink tile-orientation F overlay (top-bar toggle, independent of the cage): one group per side,
  // plus the green frame-F groups shown only while the control cage is ALSO on
  const fGroup = new THREE.Group();         // authored painted cells (worldRoot coords)
  const refFGroup = new THREE.Group();      // reference patches (refRoot coords)
  const frameFGroup = new THREE.Group();    // authored green frame Fs (visible = cage on)
  const refFrameFGroup = new THREE.Group(); // reference green frame Fs (visible = ref cage shown)
  let tileFOn = false;
  // Paint placement mode: the armed brush's tile + orientation, draped over the hovered cell as a translucent
  // ghost showing exactly what a click paints. ← / → turn it a quarter (the host re-arms it). Null = select
  // mode: a click selects the painted cell under the cursor instead (amber outline, see setSelectedPaintCell).
  let paintArm: { ref: TexRef; rot: number; mirror: boolean } | null = null;
  let paintGhost: THREE.Mesh | null = null;                // the hovered cell's surface, re-UV'd to the brush
  const paintGhostMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.75, depthWrite: false,
    side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
  let paintGhostCell = -1;                                 // cell the ghost geometry was last built for
  let paintSelCell: number | null = null;       // selected painted cell = quad id (select mode)
  let paintMultiSel: number[] = [];              // multi-selection of painted cells = quad ids (host-owned set)
  const paintSelGroup = new THREE.Group();       // its amber outline, rebuilt with the terrain
  const refPatchSelGroup = new THREE.Group();    // outline around the selected reference patch (paint select)
  let refPatchSel: number | null = null;

  /**
   * Arm paint placement with the active brush, or put it down with null. While armed, a translucent ghost
   * of the tile drapes over the hovered cell exactly as a click paints it (orientation included), and the
   * host's ← / → turn re-arms it. With no brush armed, clicks SELECT painted cells instead. Re-called on
   * every brush change — rotations re-drape a showing ghost in place.
   */
  function setPaintBrush(b: { ref: TexRef; rot: number; mirror: boolean } | null) {
    paintArm = b ? { ref: b.ref, rot: b.rot, mirror: b.mirror } : null;
    if (!b) { if (paintGhost) paintGhost.visible = false; return; }
    const showing = paintGhost?.visible ? paintGhostCell : -1;
    paintGhostCell = -1; // the cached drape carries the old tile / orientation
    if (showing >= 0) drapePaintGhost(showing);
  }

  /** Paint-mode hover (pointer already cast): drape the brush ghost over the hovered cell, or hide it.
   *  `midStroke` while the left button is laying a stroke — see {@link cellAtPointer}. */
  function updatePaintGhost(midStroke = false) {
    if (!paintArm) return;
    const c = cellAtPointer(midStroke);
    if (c === null) { if (paintGhost) paintGhost.visible = false; return; }
    drapePaintGhost(c);
  }

  /** (Re)build the ghost for cell `index`: the cell's own tessellated surface (so it hugs the curve),
   *  re-UV'd to the brush's D4 orientation — the preview builder's exact math — and textured with the brush
   *  tile, translucent. A still-loading tile shows as a flat amber drape until it arrives. */
  function drapePaintGhost(index: number) {
    const pv = mesh.preview(), arm = paintArm;
    if (!pv || !arm || index < 0 || index >= pv.cellTex.length) return;
    if (!paintGhost) {
      paintGhost = new THREE.Mesh(new THREE.BufferGeometry(), paintGhostMat);
      paintGhost.raycast = () => { /* the ghost is never a pick target */ };
      paintGhost.renderOrder = 11;
      stage.worldRoot.add(paintGhost);
    }
    const tex = mesh.ensureTile(arm.ref);
    if (paintGhostMat.map !== tex) {
      paintGhostMat.map = tex;
      paintGhostMat.color.set(tex ? 0xffffff : 0xffc24d);
      paintGhostMat.needsUpdate = true;
    }
    if (index !== paintGhostCell) {
      const res = Math.round(Math.sqrt(pv.facesPerCell / 2)), side = res + 1;
      const base = index * side * side;
      const uvs = new Float32Array(side * side * 2);
      for (let iu = 0; iu < side; iu++) {
        for (let iv = 0; iv < side; iv++) {
          const [ou, ov] = orientUV(iu / res, iv / res, arm.rot, arm.mirror); // tessellation.ts writes (ou, -ov)
          const vi = (iu * side + iv) * 2;
          uvs[vi] = ou;
          uvs[vi + 1] = -ov;
        }
      }
      const indices: number[] = [];
      for (let iu = 0; iu < res; iu++) {
        for (let iv = 0; iv < res; iv++) {
          const a = iu * side + iv, b = a + 1, c = a + side, d = c + 1;
          indices.push(a, d, c, a, b, d); // the terrain's winding (double-sided anyway)
        }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pv.positions.slice(base * 3, (base + side * side) * 3), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      g.setIndex(indices);
      paintGhost.geometry.dispose();
      paintGhost.geometry = g;
      paintGhostCell = index;
    }
    paintGhost.visible = true;
  }

  /** Re-drape a showing ghost in place (a tile that finished downloading trades its amber fallback for the art). */
  function redrapeGhost() {
    if (paintGhost?.visible && paintGhostCell >= 0) drapePaintGhost(paintGhostCell);
  }

  /** Drop the ghost's cached cell geometry (the terrain rebuilt underneath it); the next hover re-drapes. */
  function invalidateGhostCell() { paintGhostCell = -1; }

  /** Select the painted cell (quad id) shown with the amber outline (paint select mode), or clear with null. */
  function setSelectedPaintCell(quad: number | null) {
    paintSelCell = quad;
    rebuildPaintSel();
  }

  /** Mark the multi-selection of painted cells (quad ids; amber outlines like the single selection), or
   *  clear with an empty list. The anchor cell rides in setSelectedPaintCell as usual. */
  function setSelectedPaintCells(quads: number[]) {
    paintMultiSel = quads;
    rebuildPaintSel();
  }

  /** Select a REFERENCE patch shown with the amber outline (paint select mode, read-only), or clear. */
  function setSelectedRefPatch(index: number | null) {
    refPatchSel = index;
    rebuildRefPatchSel();
  }

  /** Rebuild the selected reference patch's outline on its tessellated lattice, under refRoot so it rides
   *  the placement offset. Same fat-line style as the authored cell outline. */
  function rebuildRefPatchSel() {
    clearGlyphGroup(refPatchSelGroup);
    const data = mesh.refData(), j = refPatchSel;
    if (j === null || !data || j < 0 || j >= data.patchTex.length) return;
    const res = Math.max(1, Math.round(Math.sqrt(data.facesPerPatch / 2)));
    const side = res + 1, base = j * side * side;
    const P = (iu: number, iv: number): [number, number, number] => {
      const p = (base + iu * side + iv) * 3;
      return [data.positions[p], data.positions[p + 1], data.positions[p + 2]];
    };
    const arr: number[] = [];
    for (let i = 0; i < res; i++) {
      arr.push(...P(i, 0), ...P(i + 1, 0), ...P(i, res), ...P(i + 1, res));
      arr.push(...P(0, i), ...P(0, i + 1), ...P(res, i), ...P(res, i + 1));
    }
    addGlyphLines(refPatchSelGroup, arr, 0xffc24d, 0.95);
  }

  /** Paint select mode click: resolve to the authored cell OR the reference patch under the cursor (nearest
   *  wins) and tell the host. A reference patch selects read-only (its tile + recovered D4 in the readout);
   *  an untextured patch clears, like an unpainted authored cell. */
  function paintSelectAtPointer(shift = false) {
    const terrain = mesh.terrain(), reference = mesh.reference(), refData = mesh.refData(), pv = mesh.preview();
    const targets: THREE.Object3D[] = reference ? [terrain, reference] : [terrain];
    const hit = stage.ray.intersectObjects(targets, false)[0];
    if (hit && reference && hit.object === reference && refData && hit.faceIndex != null) {
      const rd = refData;
      const patch = Math.floor(hit.faceIndex / rd.facesPerPatch);
      const name = rd.patchTex[patch] ?? null;
      if (name) {
        const uv = rd.patchUV[patch];
        const o = uv ? orientFromPatchUV(uv) : { rot: 0, mirror: false };
        stage.cb.onSelectRefPatch?.(patch, makeTexRef(mesh.refLevel(), name), o.rot, o.mirror,
          rd.patchSurf[patch] ?? null);
        return;
      }
    } else if (hit && hit.object === terrain && pv && hit.faceIndex != null) {
      const quad = Math.floor(hit.faceIndex / pv.facesPerCell);
      // shift-click while a cell (single or set) is already selected: add this quad to the multi-selection.
      // Otherwise the click re-seats the single selection.
      if (shift && (paintSelCell !== null || paintMultiSel.length)) {
        stage.cb.onRangeSelectPaintCell?.(quad);
        return;
      }
      stage.cb.onSelectPaintCell?.(quad);
      return;
    }
    stage.cb.onSelectPaintCell?.(null); // empty space / an untextured reference patch clears
  }

  /** Append slot `ci`'s border on the tessellated lattice (it hugs the curved surface) to `arr` as fat-line
   *  segment endpoints — shared by the paint and Edit cell selections. */
  function appendCellOutline(pv: PreviewData, ci: number, arr: number[]) {
    const res = Math.round(Math.sqrt(pv.facesPerCell / 2)), side = res + 1;
    if (ci < 0 || ci >= pv.positions.length / 3 / (side * side)) return;
    const base = ci * side * side;
    const P = (iu: number, iv: number): [number, number, number] => {
      const p = (base + iu * side + iv) * 3;
      return [pv.positions[p], pv.positions[p + 1], pv.positions[p + 2]];
    };
    for (let i = 0; i < res; i++) {
      arr.push(...P(i, 0), ...P(i + 1, 0), ...P(i, res), ...P(i + 1, res)); // the two iu-running borders
      arr.push(...P(0, i), ...P(0, i + 1), ...P(res, i), ...P(res, i + 1)); // the two iv-running borders
    }
  }

  /** Rebuild the selected cells' amber outlines (paint select mode), in the F overlay's fat-line style: the
   *  single selected cell plus any shift-range block, one line set. Cleared when nothing is selected;
   *  re-run on terrain rebuilds. */
  function rebuildPaintSel() {
    clearGlyphGroup(paintSelGroup);
    const pv = mesh.preview();
    if (!pv) return;
    const sel = new Set<number>();
    if (paintSelCell !== null) sel.add(paintSelCell);
    for (const q of paintMultiSel) sel.add(q);
    const arr: number[] = [];
    for (const ci of sel) appendCellOutline(pv, ci, arr);
    if (arr.length) addGlyphLines(paintSelGroup, arr, 0xffc24d, 0.95);
  }

  /** The quad id of the terrain cell under the cursor, or null off-terrain. Runs per pointer move, so it
   *  goes through the terrain's cached pick tree rather than walking every triangle (Stage.pickSurface). The
   *  stroke's own edits move the quilt through the buffers that tree indexes and it is refit over them, so it
   *  stays the same tree; `midStroke` only declines to pay a COLD build inside the stroke. */
  function cellAtPointer(midStroke = false): number | null {
    const pv = mesh.preview();
    if (!pv) return null;
    const hit = stage.pickSurface(mesh.terrain(), !midStroke);
    if (!hit || hit.faceIndex == null) return null;
    return Math.floor(hit.faceIndex / pv.facesPerCell);
  }

  /** Add one F-overlay line set as FAT lines at the current canvas resolution (see overlays.glyphLines). */
  function addGlyphLines(group: THREE.Group, arr: number[] | Float32Array, color: number, opacity: number,
    width = F_LINE_WIDTH, renderOrder = 12, depthTest = true) {
    glyphLines(group, arr, color, opacity, [stage.container.clientWidth || 1, stage.container.clientHeight || 1], width, renderOrder, depthTest);
  }

  /** Toggle the pink tile-orientation F overlay on the 3D terrain (authored painted cells + reference
   *  patches). Independent of the cage; the 2D panels (Library / preview / pad) draw their own Fs. */
  function setTileF(on: boolean) {
    tileFOn = on;
    rebuildAuthoredF();
    rebuildRefF();
  }

  /** Emit the F's strokes (segment endpoints) through an (art x,y) → (patch u,v) map, evaluate them on the
   *  surface and lift them off it so the glyph reads on top of the drawn texture. */
  /** Rebuild the authored side of the F overlay: a pink art F per painted cell at its stored D4
   *  orientation, plus a green frame F per cell (shown only while the cage is also on), evaluated on the
   *  tessellated preview lattice so the Fs hug the curved surface. Cleared while the F toggle is off. */
  function rebuildAuthoredF() {
    clearGlyphGroup(fGroup);
    clearGlyphGroup(frameFGroup);
    const pv = mesh.preview();
    if (!tileFOn || !pv) return;
    const res = Math.round(Math.sqrt(pv.facesPerCell / 2)), side = res + 1;
    const artGlyphs: number[] = [], frameGlyphs: number[] = [];
    for (let ci = 0; ci < pv.cellTex.length; ci++) {
      if (mesh.quadHidden(ci)) continue;
      const base = ci * side * side;
      const P = (iu: number, iv: number, k: number) => pv.positions[(base + iu * side + iv) * 3 + k];
      const evalW = (u: number, v: number): [number, number, number] => {
        const fu = Math.min(u, 0.999999) * res, fv = Math.min(v, 0.999999) * res;
        const iu = Math.floor(fu), iv = Math.floor(fv), au = fu - iu, av = fv - iv;
        return [0, 1, 2].map(k =>
          P(iu, iv, k) * (1 - au) * (1 - av) + P(iu, iv + 1, k) * (1 - au) * av
          + P(iu + 1, iv, k) * au * (1 - av) + P(iu + 1, iv + 1, k) * au * av) as [number, number, number];
      };
      const lift: [number, number, number] = [0, 0, 0]; // coincident with the surface; the material's depth bias carries it toward the camera
      appendFrameGlyph(frameGlyphs, evalW, lift);
      if (!pv.cellTex[ci]) continue;
      const o = pv.cellOrient[ci];
      const t = (u: number, v: number): [number, number] => { const [a, b] = orientUV(u, v, o?.rot ?? 0, o?.mirror ?? false); return [a, -b]; };
      const tA = t(0, 0), tU = t(1, 0), tV = t(0, 1);
      appendUvGlyph(artGlyphs, tA, [tU[0] - tA[0], tU[1] - tA[1]], [tV[0] - tA[0], tV[1] - tA[1]], evalW, lift);
    }
    if (artGlyphs.length) addGlyphLines(fGroup, artGlyphs, UV_GLYPH_COLOR, 0.95);
    if (frameGlyphs.length) addGlyphLines(frameFGroup, frameGlyphs, FRAME_GLYPH_COLOR, 0.85);
    frameFGroup.visible = mesh.cageOn();
  }

  /** Rebuild the reference side of the F overlay: a pink art F per textured patch (mapped through the
   *  patch's own tile UVs), plus a green frame F per patch (shown only while the reference cage is on).
   *  Evaluated on the patch's tessellated (res-4) surface — the same lattice that's drawn — so a convex
   *  patch's curve can't rise over and hide the glyph. Drawn coincident with the surface with a camera-ward
   *  depth bias (see addGlyphLines), so walls / cave overhangs can't hide it either. Cleared while the F
   *  toggle is off. */
  function rebuildRefF() {
    clearGlyphGroup(refFGroup);
    clearGlyphGroup(refFrameFGroup);
    const data = mesh.refData();
    if (!tileFOn || !data) return;
    // evaluate on the tessellated surface (like the authored side): the res-4 lattice hugs a convex patch's
    // curve, where the flat corner bilinear would sink below it and let the surface hide the glyph.
    const res = Math.max(1, Math.round(Math.sqrt(data.facesPerPatch / 2)));
    const side = res + 1, per = side * side;
    const artGlyphs: number[] = [], frameGlyphs: number[] = [];
    for (let j = 0; j < data.patchCorners.length; j++) {
      const wc = data.patchCorners[j];
      if (!wc || wc.length < 4) continue;
      const base = j * per;
      const P = (iu: number, iv: number, k: number) => data.positions[(base + iu * side + iv) * 3 + k];
      const evalW = (u: number, v: number): [number, number, number] => {
        const fu = Math.min(u, 0.999999) * res, fv = Math.min(v, 0.999999) * res;
        const iu = Math.floor(fu), iv = Math.floor(fv), au = fu - iu, av = fv - iv;
        return [0, 1, 2].map(k =>
          P(iu, iv, k) * (1 - au) * (1 - av) + P(iu, iv + 1, k) * (1 - au) * av
          + P(iu + 1, iv, k) * au * (1 - av) + P(iu + 1, iv + 1, k) * au * av) as [number, number, number];
      };
      const lift: [number, number, number] = [0, 0, 0]; // coincident with the surface; the material's depth bias carries it toward the camera
      appendFrameGlyph(frameGlyphs, evalW, lift);
      const uv = data.patchUV[j];
      if (!data.patchTex[j] || !uv) continue;
      appendUvGlyph(artGlyphs,
        [uv[0][0], uv[0][1]],
        [uv[2][0] - uv[0][0], uv[2][1] - uv[0][1]],
        [uv[1][0] - uv[0][0], uv[1][1] - uv[0][1]],
        evalW, lift);
    }
    if (artGlyphs.length) addGlyphLines(refFGroup, artGlyphs, UV_GLYPH_COLOR, 0.95);
    if (frameGlyphs.length) addGlyphLines(refFrameFGroup, frameGlyphs, FRAME_GLYPH_COLOR, 0.85);
    refFrameFGroup.visible = !!data && mesh.cageOn();
  }

  /** Green frame Fs (built only while the F overlay is on) ride the cage toggle. */
  function applyCageView() { frameFGroup.visible = mesh.cageOn(); }

  /** Green frame Fs on the reference ride the reference cage's visibility (a reference loaded + cage on). */
  function applyRefView() { refFrameFGroup.visible = !!mesh.refData() && mesh.cageOn(); }

  stage.refRoot.add(refFGroup);       // tile-F overlay rides the reference's own frame
  refFrameFGroup.visible = false;     // green frame Fs follow the reference cage's visibility
  stage.refRoot.add(refFrameFGroup);
  stage.refRoot.add(refPatchSelGroup);
  stage.worldRoot.add(fGroup);        // authored tile-F overlay, data coords like the cage
  frameFGroup.visible = false;        // green frame Fs follow the cage toggle
  stage.worldRoot.add(frameFGroup);
  stage.worldRoot.add(paintSelGroup); // selected-cell outline (paint select mode), data coords like the F overlay

  return {
    /** The armed brush's tile + D4 orientation, or null = paint select mode. */
    get paintArm() { return paintArm; },
    /** The translucent brush drape over the hovered cell (created on the first drape). */
    get paintGhost() { return paintGhost; },
    /** The authored tile-F overlay group (a live reference ride hides it with the other authored objects). */
    fGroup,
    /** The fat-line overlay groups; the shell's resize() feeds their materials the live canvas resolution. */
    fatLineGroups: [fGroup, refFGroup, frameFGroup, refFrameFGroup, paintSelGroup, refPatchSelGroup] as const,
    setPaintBrush, updatePaintGhost, redrapeGhost, invalidateGhostCell,
    setSelectedPaintCell, setSelectedPaintCells, setSelectedRefPatch,
    rebuildPaintSel, paintSelectAtPointer, cellAtPointer,
    setTileF, rebuildAuthoredF, rebuildRefF, applyCageView, applyRefView,
  };
}

export type PaintLayer = ReturnType<typeof createPaintLayer>;
