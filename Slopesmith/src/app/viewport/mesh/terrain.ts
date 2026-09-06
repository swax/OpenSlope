import * as THREE from 'three';
import { PATCH_VERTS, type PreviewData } from '../../../core/mesh/tessellation';
import type { TexRef } from '../../../core/paint/textures';
import type { LightRig } from '../../../core/reference/lights';
import { bakeRigLighting } from '../../../core/reference/lights';
import { SIGN_TERRAIN_WEIGHT_K } from '../../../core/lighting/sign-lights';
import { bakeSunShadow, bakeAO } from '../../../core/lighting/occlusion';
import { computeModelColored } from '../../../core/lighting/lightmap';
import { bakedLightmapDisplay, compositeRigGlow } from '../../../core/lighting/bake';
import { lightToWorkingSpace } from '../../../core/lighting/color-space';
import { groundLightSampler } from '../../../core/lighting/ground-light';
import type { V3 } from '../../../core/doc/types';
import { SURFACE_POLY_OFFSET } from '../constants';
import { tintBackfaces } from './backface-tint';
import { refitSurfaceTrees, type TreeGeometry } from './surface-trees';
import type { ShadeMode } from '../types';
import type { Stage } from '../stage';
import type { TileMaterials } from './tile-materials';

/** Scratch for the patch-extent bookkeeping below, which runs per incremental update and allocates nothing. */
const priorExtent = new Float32Array(6);
const scratchPoint = new THREE.Vector3();

/** The Stage-D sun's parameters: direction, ambient / sun / shadow / AO strengths, and the sun / sky tints. */
export type TerrainLightOptions = { dir: [number, number, number]; ambient: number; sun: number; shadow: number; ao: number; sunTint: [number, number, number]; skyTint: [number, number, number] };

/** The view state the terrain solid draws with: the active shade mode (real tiles / SurfaceType tint / no
 *  solid) and the authored local-light rig (sign + free) whose glow folds into the lit terrain, gated by the
 *  effective Local lights gate. The shell owns all of it and hands it in as closures. */
export interface TerrainViewAccess {
  shading(): ShadeMode;
  rigData(): LightRig | null;
  rigVisible(): boolean;
}

/** Host work a terrain geometry rebuild triggers: every dependent overlay — the cage's depth mask, the
 *  Edit-mode hidden-quad index filter, the F overlays and selection outlines / shadings, the builder
 *  previews, the paint ghost's cached cell — re-targets the freshly-swapped geometry. */
export interface TerrainHostHooks {
  onGeometryRebuilt(geometry: THREE.BufferGeometry): void;
}

/**
 * The authored terrain solid, one mesh serving every mode: the tessellated quilt preview as indexed geometry
 * (position / normal / colour / UV straight from the preview buffers), the per-cell tile material split
 * (consecutive painted cells grouped by tile, slot 0 the SurfaceType-tint fallback), and the Stage-D SSX sun
 * lighting (an unlit vertex-colour material over cached AO / cast-shadow bakes + the authored rig's glow,
 * with the baked-lightmap in-game view riding the same path). The layer owns the terrain mesh, its material
 * flavours, the live preview data and the lighting caches; the shell hands in the shade mode + light rig
 * through accessors (`TerrainViewAccess`) and re-targets its dependent overlays on each geometry rebuild
 * (`TerrainHostHooks`).
 */
export function createTerrainLayer(stage: Stage, tiles: TileMaterials, view: TerrainViewAccess, host: TerrainHostHooks,
  opts: { pickTarget?: boolean } = {}) {
  /** Fallback material (material slot 0): SurfaceType tint for cells with no painted tile. Back faces tint
   *  magenta — the non-ridable side of a one-sided patch (backface-tint.ts). */
  const terrainMat = tintBackfaces(new THREE.MeshLambertMaterial({
    vertexColors: true, side: THREE.DoubleSide,
    ...SURFACE_POLY_OFFSET, // sit behind the cage wires (incl. their dips into the surface) so they read on top
  }));
  const terrain: THREE.Mesh = new THREE.Mesh(new THREE.BufferGeometry(), terrainMat);
  let preview: PreviewData | null = null;
  // Authored-terrain SSX sun lighting (Stage D): an unlit material + cached occlusion bakes for the
  // preview (AO by geometry, shadow by geometry + direction), so editing re-lights live.
  const terrainLightMat = tintBackfaces(new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  let terrainLight: TerrainLightOptions | null = null;
  let terrainBakedView = false; // show the authored terrain AS its own baked lightmap (reference-scale)
  let tlShadow: Float32Array | null = null;
  let tlAO: Float32Array | null = null;
  let tlDirKey = '';
  let authoredRigGlow: Float32Array | null = null;        // cached per-vertex terrain glow (preview space)
  let groundLit: Float32Array | null = null;              // per-vertex lit colour = the bake's `colored`
  let terrainDisplay: Float32Array | null = null;         // what the colour attribute holds (lit, or a display transform of it)
  let sampleGroundLight: ((p: V3) => number) | null = null; // lazy spatial index over it
  let occlusionStale = false;                             // patches moved under the retained AO / shadow bakes
  // Where each patch's positions stood when the geometry's ray-acceleration trees last saw them: six floats
  // per patch (min xyz, max xyz). Those trees index the terrain's OWN buffers (mesh/surface-trees.ts), so an
  // incremental re-emit moves the surface out from under their node bounds, and the box a patch is vacating
  // is what says which of those nodes have to be refit — nothing else remembers where the surface was.
  let patchBounds: Float32Array | null = null;

  /** Swap the tessellated preview in as the terrain's geometry (disposing the old one), let the shell
   *  re-target every dependent overlay, then re-split the materials and re-light against the new vertices. */
  function applyPreview(p: PreviewData) {
    preview = p;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
    g.setAttribute('color', new THREE.BufferAttribute(p.colors, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
    g.setIndex(new THREE.BufferAttribute(p.indices, 1));
    terrain.geometry.dispose();
    terrain.geometry = g;
    patchBounds = measurePatchBounds(p);
    host.onGeometryRebuilt(g);
    applyMaterials();
    tlShadow = tlAO = null; // geometry changed -> the cached occlusion bakes are stale
    authoredRigGlow = null;      // ...and the cached authored sign-light glow (bound to the old vertices)
    occlusionStale = false;
    if (terrainLight) applyTerrainLight(); // re-light the rebuilt terrain
  }

  /**
   * Fold an incremental re-tessellation into the live geometry: the named patches have already been rewritten
   * in the preview's own buffers (`refreshPreviewPatches`), so this is what the GPU and the lighting have to
   * be told about them.
   *
   * The colour of a moved patch is recomputed through the SAME per-vertex functions a full re-light uses, over
   * the contiguous quilt slice the patch owns — a patch is `PATCH_VERTS` consecutive vertices in every buffer,
   * which is what makes that legal. What it does NOT recompute is the occlusion underneath: cast shadow and
   * ambient occlusion are whole-mountain queries (a moved ridge darkens ground it never touches), so they are
   * marked stale and re-baked when the mountain settles rather than approximated per patch.
   *
   * The ray-acceleration trees are the other thing bound to these buffers, and they are put right here rather
   * than deferred: a stale pick tree is a cursor that stops finding the ground it is standing on, which is a
   * broken tool rather than a lagging one.
   */
  function updatePatches(quads: ReadonlySet<number>, spans: readonly [number, number][],
    moved: { geometry: boolean; materials: boolean }) {
    const p = preview;
    if (!p || !quads.size) return;
    const g = terrain.geometry;
    // Every attribute wraps the preview's own buffer, which the re-emit has already rewritten in place — so
    // this is an upload, not a rebuild.
    for (const name of ['position', 'normal', 'uv']) {
      const attr = g.getAttribute(name) as THREE.BufferAttribute | undefined;
      if (attr) attr.needsUpdate = true;
    }
    // The ray-acceleration trees index the same buffers, so the surface has just moved under their node
    // bounds. Hand them where each run of moved patches was and now is, and take the new extents as what the
    // next update will call "was". Unconditional: `moved.geometry` names the corner and crease edits, but an
    // interior twist arrives as a face attribute and moves the patch's control points just as surely.
    if (patchBounds) refitSurfaceTrees(g as TreeGeometry, movedPatchBoxes(p, patchBounds, spans));
    // Writing spans is only equivalent to a full re-light when there is something retained to write INTO and
    // every input a full pass would compute is already in hand. Otherwise take the full pass.
    const rig = view.rigData();
    const retained = groundLit && terrainDisplay && !(rig && view.rigVisible() && !authoredRigGlow);
    if (terrainLight && !retained) applyTerrainLight();
    else if (terrainLight) {
      relightSpans(terrainLight, spans);
      // Only MOVED geometry can invalidate the occlusion. A repainted face changes its tint and shades
      // exactly as much of the mountain as it did before, so it owes no re-bake.
      occlusionStale ||= moved.geometry;
    }
    const colorAttr = g.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (colorAttr) colorAttr.needsUpdate = true;
    // A retained spatial index over the lit ground is bound to colours that just moved.
    sampleGroundLight = null;
    if (moved.materials) applyMaterials(); // a repainted cell may have joined or left a tile's draw group
  }

  /** Every patch's position extent, six floats each — the baseline a later incremental update measures the
   *  patches it moves against. A patch is `PATCH_VERTS` consecutive vertices, so each is one contiguous read. */
  function measurePatchBounds(p: PreviewData): Float32Array {
    const patches = p.positions.length / (PATCH_VERTS * 3);
    const bounds = new Float32Array(patches * 6);
    for (let q = 0; q < patches; q++) measurePatch(p, bounds, q);
    return bounds;
  }

  /** Write patch `q`'s current extent into `bounds`, answering the extent it held before (in shared scratch,
   *  so the caller reads it before the next call). */
  function measurePatch(p: PreviewData, bounds: Float32Array, q: number): Float32Array {
    const at = q * 6, was = priorExtent;
    for (let i = 0; i < 6; i++) was[i] = bounds[at + i];
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = q * PATCH_VERTS * 3, end = i + PATCH_VERTS * 3; i < end; i += 3) {
      const x = p.positions[i], y = p.positions[i + 1], z = p.positions[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    bounds[at] = minX; bounds[at + 1] = minY; bounds[at + 2] = minZ;
    bounds[at + 3] = maxX; bounds[at + 4] = maxY; bounds[at + 5] = maxZ;
    return was;
  }

  /** One box per run of moved patches, covering where the run WAS and where it now IS — what the geometry's
   *  ray-acceleration trees are refit over. Re-measures the runs into `bounds` on the way through, so the
   *  baseline follows the surface. `spans` are quilt-vertex ranges, each a whole number of patches. */
  function movedPatchBoxes(p: PreviewData, bounds: Float32Array, spans: readonly [number, number][]): THREE.Box3[] {
    const boxes: THREE.Box3[] = [];
    for (const [from, to] of spans) {
      const box = new THREE.Box3();
      for (let q = from / PATCH_VERTS; q < to / PATCH_VERTS; q++) {
        const was = measurePatch(p, bounds, q), at = q * 6;
        box.expandByPoint(scratchPoint.set(was[0], was[1], was[2]));
        box.expandByPoint(scratchPoint.set(was[3], was[4], was[5]));
        box.expandByPoint(scratchPoint.set(bounds[at], bounds[at + 1], bounds[at + 2]));
        box.expandByPoint(scratchPoint.set(bounds[at + 3], bounds[at + 4], bounds[at + 5]));
      }
      boxes.push(box);
    }
    return boxes;
  }

  /** Re-run the per-vertex lighting over exactly the quilt slices that moved, into the retained arrays. */
  function relightSpans(o: TerrainLightOptions, spans: readonly [number, number][]) {
    const p = preview;
    if (!p || !groundLit || !terrainDisplay) return;
    const rig = view.rigData();
    const glow = rig && view.rigVisible() ? authoredRigGlow : null;
    for (const [from, to] of spans) {
      const f3 = from * 3, t3 = to * 3;
      const colors = computeModelColored(p.normals.subarray(f3, t3), o.dir, o,
        tlShadow?.subarray(from, to), tlAO?.subarray(from, to));
      if (glow) {
        const span = bakeRigLighting(p.positions.subarray(f3, t3), p.normals.subarray(f3, t3), rig!, SIGN_TERRAIN_WEIGHT_K);
        glow.set(span, f3);
        compositeRigGlow(colors, span);
      }
      groundLit.set(colors, f3);
      // the same display chain applyTerrainLight runs, in the same order: the baked round-trip stays in the
      // light's display domain, then the light crosses into the working space, then the (already linear)
      // ride-feel tint composites on top
      const display = lightToWorkingSpace(terrainBakedView ? bakedLightmapDisplay(colors) : colors);
      if (view.shading() === 'surface') for (let i = 0; i < display.length; i++) display[i] *= p.colors[f3 + i];
      terrainDisplay.set(display, f3);
    }
  }

  /**
   * Stage D: light the AUTHORED terrain with a directional SSX sun (sun + sky colour) + baked cast-shadow
   * / AO, drawn UNLIT so the colour is the lighting - so shadows take the sky colour (blue / pink). Pass
   * null to restore the normal textured / tint shading. Occlusion bakes are cached (AO by geometry,
   * shadow by geometry + direction) so dragging the strength / colour controls doesn't re-bake.
   */
  function setTerrainLight(opts: TerrainLightOptions | null) {
    terrainLight = opts;
    applyTerrainLight();
  }

  /** Toggle the baked (in-game) view: ON runs the LIGHT through the lightmap encode + GS decode (the bake's
   *  8-bit quantization + rail clamp) and rides it under the full-resolution tile (texture × baked-light) —
   *  the in-game terrain look. Because the bake is faithful, it reads ≈ the live model in textured mode (the
   *  match is WYSIWYG); the lightmap's quantization / highlight clamp is what differs. OFF is the live smooth
   *  sun model (the default). */
  function setTerrainBakedView(on: boolean) {
    terrainBakedView = on;
    applyTerrainLight();
  }

  function applyTerrainLight() {
    const p = preview, o = terrainLight, g = terrain.geometry;
    if (!o || !p) {
      groundLit = terrainDisplay = null;
      occlusionStale = false;
      if (p) g.setAttribute('color', new THREE.BufferAttribute(p.colors, 3)); // restore surface / tile colours
      applyMaterials();
      return;
    }
    occlusionStale = false;
    if (!tlAO) tlAO = bakeAO(p.positions, p.indices, p.normals);
    const dirKey = o.dir.join(',');
    if (!tlShadow || dirKey !== tlDirKey) { tlShadow = bakeSunShadow(p.positions, p.indices, o.dir); tlDirKey = dirKey; }
    const colors = computeModelColored(p.normals, o.dir, o, tlShadow, tlAO); // sun + sky tint (= the bake's Lc)
    // fold the authored local lights (sign + free) into the lit terrain, gated by effective Local lights
    // (WYSIWYG with the exported lightmap: the same bakeRigLighting + screen composite). Cached per rig /
    // terrain edit so dragging sun sliders is free.
    const rig = view.rigData();
    if (rig && view.rigVisible()) {
      if (!authoredRigGlow) authoredRigGlow = bakeRigLighting(p.positions, p.normals, rig, SIGN_TERRAIN_WEIGHT_K);
      compositeRigGlow(colors, authoredRigGlow);
    }
    // Snapshot the lit colour BEFORE the display transforms below: this is the bake's `colored`, the exact
    // array `bakeLightmaps` samples a prop's key from, so the preview and the export read one field
    // (docs/032 · lighting). Taking it after the baked-view round-trip or the surface-tint multiply would
    // hand props a display artefact instead.
    groundLit = colors;
    sampleGroundLight = null;      // rebuilt lazily; the grid costs more than most frames need
    // baked (in-game) view: run the LIGHT through the lightmap encode + GS decode (the bake's 8-bit
    // quantization + rail clamp), and let the tile ride on top per-pixel (applyMaterials keeps the textured
    // material), so it's texture × baked-light at full texture resolution — the in-game look, with the rock
    // grain intact rather than averaged into the coarse vertex mesh. It belongs BEFORE the working-space
    // crossing below: the encode is defined on the display bytes the lightmap actually stores.
    // Then the light crosses into three's linear working space, because that is where the colour attribute is
    // read and the tile is sampled (core/lighting/color-space). Always into a fresh array, so `colors` stays
    // the snapshot props read their key from.
    const display = lightToWorkingSpace(terrainBakedView ? bakedLightmapDisplay(colors) : colors);
    if (view.shading() === 'surface') {
      // Surface-type view composites the ride-feel tint with the sun (tint x light), exactly like the
      // textured view's tile x light; textured/none let the lighting colour ride alone (tile, or grey).
      // SURFACE_STYLE already holds linear triples, so this multiply is one space throughout.
      for (let i = 0; i < display.length; i++) display[i] *= p.colors[i];
    }
    terrainDisplay = display; // retained, so an incremental update can rewrite the slices that moved
    g.setAttribute('color', new THREE.BufferAttribute(display, 3)); // lighting rides the colour attribute
    (g.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    applyMaterials(); // textured -> tiles x light; surface -> tint x light; none -> grey light
  }

  /**
   * Re-bake the occlusion an incremental update left standing, and re-light on it.
   *
   * Cast shadow and AO are the expensive half of a rebuild and cannot be made local — a moved ridge changes
   * what it shades a long way downhill — so incremental updates run on the last full bake and this puts the
   * mountain right once it has stopped moving. A no-op when nothing has moved since the last bake, so the
   * caller can arm it freely.
   */
  function settleLighting(): boolean {
    if (!occlusionStale || !terrainLight || !preview) return false;
    tlShadow = tlAO = null;
    authoredRigGlow = null;
    applyTerrainLight();
    return true;
  }

  /**
   * Split the quilt into draw groups by painted tile so each cell shows its real texture
   * (one tile per patch = the SSX model; there is no per-texel blend to fake). Cells with no
   * painted tile - or whose tile hasn't downloaded yet - fall to the SurfaceType tint material.
   * Re-runnable without re-tessellating: a finished texture download just calls this again.
   */
  function applyMaterials() {
    const p = preview;
    const g = terrain.geometry;
    if (!p) return;
    const lit = terrainLit(); // a lighting view swaps tiles to unlit x lighting
    terrain.visible = view.shading() !== 'none'; // cage-only view draws no solid surface, lit or not
    if (!terrain.visible) return; // no solid surface drawn (wireframe / cage only)
    if (view.shading() !== 'textured') { // surface = ride-feel tint (x light when lit); none(+lit) = grey light
      g.clearGroups();
      terrain.material = lit ? terrainLightMat : terrainMat; // unlit vertex-colour buffer
      return;
    }
    const indicesPerCell = p.facesPerCell * 3; // res*res*2 tris * 3
    const fallback = lit ? terrainLightMat : terrainMat; // unpainted cells: lighting, or tint
    const mats: THREE.Material[] = [fallback]; // slot 0
    const slotOf = new Map<TexRef, number>();
    g.clearGroups();

    let runStart = 0, runSlot = -1;
    const flush = (end: number) => {
      if (runSlot >= 0 && end > runStart) g.addGroup(runStart * indicesPerCell, (end - runStart) * indicesPerCell, runSlot);
    };
    for (let cell = 0; cell < p.cellTex.length; cell++) {
      const ref = p.cellTex[cell];
      let slot = 0;
      if (ref) {
        const tex = tiles.ensure(ref);
        if (tex) {
          slot = slotOf.get(ref) ?? -1;
          if (slot < 0) { slot = mats.length; slotOf.set(ref, slot); mats.push(lit ? tiles.materialLit(ref, tex) : tiles.material(ref, tex)); }
        }
      }
      if (slot !== runSlot) { flush(cell); runStart = cell; runSlot = slot; }
    }
    flush(p.cellTex.length);

    terrain.material = mats;
  }

  /** Whether a lighting view currently drives the terrain colour attribute (so tiles draw unlit x it). */
  function terrainLit() { return !!terrainLight; }

  /** Drop the cached rig glow (the rig changed; the next lit pass re-bakes it from the new rig). */
  function invalidateRigGlow() { authoredRigGlow = null; }

  /** Park the layer empty: drop the preview, geometry and lighting caches, and hide the mesh until the
   *  next applyPreview. A secondary layer (the model-session mountain backdrop) rests here between uses. */
  function release() {
    preview = null;
    terrain.geometry.dispose();
    terrain.geometry = new THREE.BufferGeometry();
    terrain.visible = false;
    tlShadow = tlAO = null;
    authoredRigGlow = null;
    groundLit = terrainDisplay = null;
    patchBounds = null;
    occlusionStale = false;
  }

  stage.worldRoot.add(terrain);
  // the primary layer is the shared ground-pick target (gems / props / paint drop onto it); a secondary
  // context layer must never steal that role
  if (opts.pickTarget !== false) stage.terrainMesh = terrain;

  return {
    /** The authored terrain solid — the shared ground-pick / ray target every input path reads. */
    get terrain() { return terrain; },
    /** The live tessellated preview the mesh draws (null until a mountain is applied). */
    get preview() { return preview; },
    get terrainLit() { return terrainLit(); },
    /**
     * The baked light on the ground at a world point — what a prop standing there reads its key from
     * (docs/032 · lighting). Null when the terrain isn't sun-lit, in which case props have no ground light
     * to inherit and stay on the studio rig.
     *
     * The spatial index is built on first use after each re-light rather than eagerly, because dragging a
     * sun slider re-lights every frame while only a prop rebuild actually asks.
     */
    groundLightAt(p: V3): number | null {
      if (!groundLit || !preview) return null;
      if (!sampleGroundLight) sampleGroundLight = groundLightSampler(preview.positions, groundLit);
      return sampleGroundLight(p);
    },
    /** Whether patches have moved under the retained occlusion bakes — what `settleLighting` will put right. */
    get lightingStale() { return occlusionStale; },
    applyPreview, updatePatches, settleLighting,
    applyMaterials, applyTerrainLight, setTerrainLight, setTerrainBakedView, invalidateRigGlow,
    release,
  };
}

export type TerrainLayer = ReturnType<typeof createTerrainLayer>;
