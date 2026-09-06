import * as THREE from 'three';
import type { Gem, V3 } from '../../../core/doc/types';
import type { RaceMode } from '../../../core/doc/race';
import { gemTier, RAW_TO_EDITOR } from '../constants';
import type { PropAssets } from './prop-assets';
import type { Stage } from '../stage';

const GEM_GEO = new THREE.OctahedronGeometry(1.1, 0); // stand-in crystal until the native geometry registers
// Repacked authored gems clone the retail tier template and its persistent AnimObject: 45 clip frames/second
// over a 179.82031 degrees/second model curve (one near-exact revolution every 4/3 seconds).
const GEM_SPIN_RADIANS_PER_SECOND = THREE.MathUtils.degToRad(179.82031 * 1.5);

/**
 * Gem pickups (docs/014): the collectible half of the Tricks layer, one spinning marker per gem, under
 * `stage.worldRoot` in data coords. Markers render the NATIVE tiered crystal (the donor's Gem_TrickMultiplier_*
 * model, registered via setModels) so the editor shows the exact crystal the ISO packer clones; until that
 * geometry lands, a tier-tinted octahedron stands in. Placed by click (one) or drag (a spaced row) — the
 * shell's gem-tool pointer handlers drive `gemLine` / the ghost and call back into `seatGem` / `clearSelection`.
 * Reads the shared prop-model geometry cache (`propGeom`) the props layer populates.
 */
export function createGemsLayer(stage: Stage, assets: PropAssets) {
  const gemGroup = new THREE.Group();
  let gems: Gem[] = [];
  let selectedGem: string | null = null;                // the selected gem's stable id (docs/039)
  let gemArmed = false;                                 // the Gem tool is active: a click drops a gem / a drag a row
  let gemLine: { start: V3; end: V3 } | null = null;    // in-progress drag-to-row (final authored positions)
  let gemGhost: THREE.Group | null = null;              // translucent drop preview riding the cursor while armed
  let gemArmOpts = { value: 2, height: 2 };             // the pending drop the ghost previews (host's tool defaults)

  let visible = true;                                   // the Tricks view filter (coordinated with the rails by the shell)
  let playMode: RaceMode | null = null;                 // null outside Test; native gems exist only in Showoff
  let worldEffectsEnabled = false;
  const gemMoveHandle = new THREE.Object3D();           // scene-root gizmo anchor for the selected gem
  let gemModels: Map<number, { level: string; model: number }> | null = null; // tier (2/3/5) -> native gem model
  let gemGhostMats: THREE.Material[] = [];              // ghost material clones, disposed on rebuild
  let gemSelMats: THREE.Material[] = [];               // selected-marker material clones, disposed on setGems
  // stand-in tints per tier while the native geometry loads — yellow ×2 / orange ×3 / red ×5, like the crystals
  const gemMatTier = new Map<number, THREE.MeshLambertMaterial>([
    [2, new THREE.MeshLambertMaterial({ color: 0xf2c744, emissive: 0x4a3a08 })],
    [3, new THREE.MeshLambertMaterial({ color: 0xef8a2e, emissive: 0x46250a })],
    [5, new THREE.MeshLambertMaterial({ color: 0xe23d3d, emissive: 0x460f0f })],
  ]);
  const gemSelMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x557766 });

  // the faint line drawn while dragging a gem row (data coords)
  const gemLinePreview = new THREE.Line(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({ color: 0x3fe0d0, transparent: true, opacity: 0.8, depthWrite: false }),
  );

  /** Arm / disarm the Gem tool: while armed, a props-mode click drops a gem and a drag lays a spaced row,
   *  with a translucent ghost of the pending tier's crystal riding the cursor at the drop height. */
  function setArmed(on: boolean, opts?: { value: number; height: number }) {
    gemArmed = on;
    if (opts) gemArmOpts = opts;
    disposeGemGhost();
    if (on) buildGemGhost();
  }

  /** Register the native gem models (tier 2/3/5 -> a donor level's Gem_TrickMultiplier_* model). */
  function setModels(models: Map<number, { level: string; model: number }>) {
    gemModels = models;
    setGems(gems, selectedGem);
    if (gemArmed) { disposeGemGhost(); buildGemGhost(); }
  }

  const applyVisibility = () => {
    const presentInMode = playMode === null || playMode === 'showoff';
    gemGroup.visible = visible && presentInMode && gems.length > 0;
  };

  /** Tricks view filter: show / hide the gems (coordinated with the rails by the shell's showTricks). */
  function setVisible(on: boolean) {
    visible = on;
    applyVisibility();
    if (!on) gemLinePreview.visible = false;
  }

  /** Test setup's native object-set gate. Gems are present only for Showoff; null restores the editor view. */
  function setPlayMode(mode: RaceMode | null) {
    playMode = mode;
    applyVisibility();
  }

  function setWorldEffectsEnabled(on: boolean) {
    worldEffectsEnabled = on;
    if (!on) {
      for (const gem of gemGroup.children) gem.rotation.y = 0;
      if (gemGhost) gemGhost.rotation.y = 0;
    }
  }

  function stepWorldEffects(dt: number) {
    if (!worldEffectsEnabled || dt <= 0) return;
    if (gemGroup.visible) for (const gem of gemGroup.children)
      gem.rotation.y -= dt * GEM_SPIN_RADIANS_PER_SECOND;
    if (gemGhost?.visible) gemGhost.rotation.y -= dt * GEM_SPIN_RADIANS_PER_SECOND;
  }

  /** Where the selected gem sits in the list right now, or -1. The selection names a gem rather than the slot
   *  it happens to occupy, so it is resolved fresh on every rebuild: deleting a gem below it moves its index
   *  and leaves the selection exactly where it was (docs/039). */
  const selectedIndex = (): number =>
    selectedGem === null ? -1 : gems.findIndex(gem => gem.id === selectedGem);

  /** Rebuild the gem markers from the doc, and keep the selected gem's gizmo in sync. Parallels setRails.
   *  Marker geometry is shared (the octahedron / the propGeom cache), so only the selection clones dispose. */
  function setGems(newGems: Gem[], selectedId: string | null) {
    for (const m of gemSelMats) m.dispose();
    gemSelMats = [];
    gemGroup.clear();
    gems = newGems;
    selectedGem = selectedId;
    const selIdx = selectedIndex();
    for (let i = 0; i < gems.length; i++) gemGroup.add(buildGemMarker(gems[i], i, i === selIdx));
    applyVisibility();
    if (selIdx >= 0) {
      if (!(stage.gizmoKind === 'gem' && stage.gizmo.dragging)) {
        placeGemHandle(selIdx);
        gemMoveHandle.visible = true;
        if (stage.gizmoKind !== 'gem') stage.attachGizmo(gemMoveHandle, 'gem', selIdx);
      }
    } else if (stage.gizmoKind === 'gem') {
      clearSelection();
    }
  }

  /** One gem marker: the native tiered crystal (yellow ×2 / orange ×3 / red ×5) spinning in data coords —
   *  the exact model the ISO packer clones for this gem's Value — brightened + scaled up when selected,
   *  carrying its doc index on every mesh for raycast picking. Until the donor geometry registers, a
   *  tier-tinted octahedron stands in. */
  function buildGemMarker(gem: Gem, index: number, selected: boolean): THREE.Object3D {
    const tier = gemTier(gem.value ?? 1);
    const native = buildGemModel(tier, selected ? mat => {
      const m = mat.clone();
      m.emissive = new THREE.Color(0x666655);
      gemSelMats.push(m);
      return m;
    } : undefined);
    const marker: THREE.Object3D = native ?? new THREE.Mesh(
      GEM_GEO,
      selected ? gemSelMat : (gemMatTier.get(tier) ?? gemMatTier.get(2)!),
    );
    marker.scale.setScalar(selected ? (native ? 1.25 : 1.5) : 1);
    marker.position.set(gem.pos[0], gem.pos[1], gem.pos[2]);
    marker.traverse(o => { o.userData.gemIndex = index; });
    return marker;
  }

  /** The native crystal for a gem tier as a fresh spin-ready Group: the donor model's cached submeshes seated
   *  by RAW_TO_EDITOR (cm/Z-up -> m/Y-up) under a pivot Group whose Y-rotation the render loop animates —
   *  the model pivot stays put, matching how the shipped gems spin in place. Null until the host registers
   *  the tier's geometry. `wrapMat` lets a caller substitute materials (selection highlight, ghost). */
  function buildGemModel(tier: number, wrapMat?: (m: THREE.MeshLambertMaterial) => THREE.Material): THREE.Group | null {
    const spec = gemModels?.get(tier);
    const subs = spec ? assets.propGeom.get(`${spec.level}:${spec.model}`) : undefined;
    if (!spec || !subs?.length) return null;
    const seated = new THREE.Group();
    seated.matrixAutoUpdate = false;
    seated.matrix.copy(RAW_TO_EDITOR);
    for (const sub of subs) {
      const shared = assets.propTex.material(sub.level, sub.tex);
      seated.add(new THREE.Mesh(sub.geometry, wrapMat ? wrapMat(shared) : shared));
    }
    const pivot = new THREE.Group();
    pivot.add(seated);
    return pivot;
  }

  /** Seat the scene-root gizmo handle on gem `i` (data pos, Z negated onto the flipped scene). */
  function placeGemHandle(i: number) {
    const g = gems[i];
    if (!g) return;
    gemMoveHandle.position.set(g.pos[0], g.pos[1], -g.pos[2]);
  }

  /** Seat the translate gizmo on the gem a pick landed on — an index, because that is what a raycast yields —
   *  and tell the host which gem that is by name. The shell has cleared the other selections. */
  function seatGem(i: number) {
    const id = gems[i]?.id;
    if (!id) return;
    selectedGem = id;
    placeGemHandle(i);
    gemMoveHandle.visible = true;
    stage.attachGizmo(gemMoveHandle, 'gem', i);
    stage.cb.onSelectGem?.(id);
  }

  /** Drop any gem selection: hide the handle and release the gizmo if it was on it. */
  function clearSelection() {
    if (selectedGem === null && stage.gizmoKind !== 'gem') return;
    selectedGem = null;
    gemMoveHandle.visible = false;
    if (stage.gizmoKind === 'gem') stage.detachGizmo();
  }

  /** Build the armed Gem tool's ghost: a translucent crystal of the pending tier (the native model, or the
   *  stand-in octahedron until it registers), hidden until the cursor hovers the terrain. Never pickable. */
  function buildGemGhost() {
    const ghostMat = (m: THREE.MeshLambertMaterial): THREE.Material => {
      const clone = m.clone();
      clone.transparent = true;
      clone.opacity = 0.55;
      clone.depthWrite = false;
      clone.alphaHash = false; // opacity belongs to the ghost blend, not to cutout coverage
      clone.needsUpdate = true;
      gemGhostMats.push(clone);
      return clone;
    };
    const tier = gemTier(gemArmOpts.value);
    let g = buildGemModel(tier, ghostMat);
    if (!g) {
      g = new THREE.Group();
      g.add(new THREE.Mesh(GEM_GEO, ghostMat(gemMatTier.get(tier) ?? gemMatTier.get(2)!)));
    }
    g.traverse(o => { if (o instanceof THREE.Mesh) o.raycast = () => { /* the ghost is never a pick target */ }; });
    g.visible = false;
    stage.worldRoot.add(g);
    gemGhost = g;
  }

  function disposeGemGhost() {
    if (gemGhost) { stage.worldRoot.remove(gemGhost); gemGhost = null; }
    for (const m of gemGhostMats) m.dispose();
    gemGhostMats = [];
  }

  /** Gem-tool hover: seat the ghost at the final snapped authored position above the terrain. */
  function updateGemGhost() {
    if (!gemArmed || !gemGhost || !stage.terrainMesh) return;
    const hit = stage.groundHit(); // BVH-accelerated: this runs on every pointer move (see Stage.groundHit)
    if (!hit) { gemGhost.visible = false; return; }
    const p = stage.snapDataPoint([hit.x, hit.y + gemArmOpts.height, -hit.z]);
    gemGhost.position.set(p[0], p[1], p[2]);
    gemGhost.visible = true;
  }

  stage.worldRoot.add(gemGroup); // gem pickups, data coords like the rails (the other half of the trick layer)
  gemMoveHandle.visible = false;
  stage.scene.add(gemMoveHandle); // scene-root anchor, Z negated by hand like the other nodes
  gemLinePreview.visible = false;
  stage.worldRoot.add(gemLinePreview);

  return {
    get gemGroup() { return gemGroup; },
    get gems() { return gems; },
    get selectedGem() { return selectedGem; },
    get gemArmed() { return gemArmed; },
    get gemLine() { return gemLine; },
    set gemLine(v: { start: V3; end: V3 } | null) { gemLine = v; },
    get gemLinePreview() { return gemLinePreview; },
    get gemGhost() { return gemGhost; },
    get gemArmOpts() { return gemArmOpts; },
    setArmed, setModels, setVisible, setPlayMode, setWorldEffectsEnabled, stepWorldEffects,
    setGems, seatGem, clearSelection, updateGemGhost,
  };
}

export type GemsLayer = ReturnType<typeof createGemsLayer>;
