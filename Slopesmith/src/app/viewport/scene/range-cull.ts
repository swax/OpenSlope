import * as THREE from 'three';
import type { ReferencePropMesh } from './reference-prop-mesh';

/**
 * The RANGE gate — the half of the engine's visibility model that frustum culling cannot supply.
 *
 * Chunking the quilt (mesh/reference-batching) lets the renderer reject what is off SCREEN. At a start gate
 * that buys almost nothing: you stand at the top of the mountain and the whole fall line is in front of you,
 * so everything downhill is inside the frustum and the entire course draws. The original engine bounded that
 * by RANGE — each frame it gathered the placed objects within a camera range and let the terrain fade into
 * fog past it (Trailmap specs/400-rendering) — and the Unity port restored the same gate as
 * `ObjectCuller`. This is that gate for the browser, and it is where the numbers a headset cares about
 * actually come from.
 *
 * Two populations, one range:
 *
 *   terrain  per CHUNK, measured to the cell's NEAR EDGE, so the cell under your board can never blink out
 *            because its centre happens to be far away
 *   props    per SLOT, through `BatchedMesh.setVisibleAt` — the same per-instance channel Three's own
 *            frustum cull already drives, so the two compose and neither needs to know about the other
 *
 * Not gated: the `InstancedMesh` draws (animated / effect-controlled props — 79 of GARI's 4,757 slots) and
 * the `MergedStaticPropMesh` fallback, whose instances are physically merged into one buffer and cannot be
 * addressed individually. Both keep drawing. They are a rounding error against the batched set, and the
 * merged path only exists on a renderer without `WEBGL_multi_draw` at all.
 *
 * Owning `setVisibleAt` outright is safe because prop visibility everywhere else in the reference decor
 * rides a ZERO-SCALE MATRIX (`hiddenMatrix`) instead: a prop hidden by a graph and a prop dropped by range
 * are recorded through different channels, so neither can resurrect the other, and leaving the ride restores
 * exactly the slots this gate hid.
 */

/** Re-evaluate once the viewer has moved this far (m) — the way the engine only re-gathered when its camera
 *  cell moved. A ride crosses it several times a second; standing still costs nothing at all. */
const RECHECK_METRES = 25;
/** ...or after this long, so a stationary viewer still picks up a rebuild it did not move for. */
const RECHECK_MS = 3000;
/** Where the haze begins (m), held CONSTANT across the tiers the way the Unity port holds
 *  `FogStartDistance` at 300 for both its cull ranges. Widening the range then pushes the far edge out
 *  without also pushing the haze back, so a tier reads as seeing further into the same weather rather than
 *  as the air itself changing — and the two ports' 600 m gates fog identically. */
const FOG_START_METRES = 300;
/** ...held back off the far plane by at least this much on a range too short to reach it, so `near`
 *  (300 m) hazes its last 50 m rather than landing the whole band on the plane itself: a fog whose near
 *  meets its far is a hard step, which is the cut this gate exists to hide. Keeping the band thin rather
 *  than proportional is the point — the short tier is chosen for headroom, and a haze that opened at 150 m
 *  would spend that tier's whole draw distance fogged. */
const FOG_BAND_MIN_METRES = 50;

/**
 * The three draw distances a ride can be taken at, in metres. `far` brackets the Unity culler's PC range and
 * `medium` its Quest range, which is the tier a headset usually wants: presence dies at a stutter long before
 * it dies at a short draw distance, and the fog is what makes the bound read as weather rather than as a cut.
 *
 * What the tiers actually buy depends on the view, and on this content they can buy nothing at all. Paused at
 * GARI's start gate, a desktop ride submits 164 draws / 154,249 triangles unbounded — and the identical
 * 164 / 154,249 at `far` (10 of 24 cells, 1,521 of 4,677 slots admitted) and again at `medium` (5 cells, 816
 * slots): everything the range dropped was already outside the frustum. At 60 m it does bite (88 / 71,379),
 * which is how we know the gate reaches the renderer rather than the range being ignored.
 *
 * That is a property of what we cull with rather than of the course. The Unity importer merges every prop
 * into ONE renderer with no per-instance culling, so a range gate is the only bound available to it, while
 * here `BatchedMesh` frustum-culls each slot and the quilt is chunked. The case that can still differ is a
 * headset, where both eyes' frustums unioned admit a much wider field than a desktop camera does.
 */
export const DRAW_DISTANCE_METRES = { near: 300, medium: 600, far: 1200 } as const;

export type DrawDistance = keyof typeof DRAW_DISTANCE_METRES;

/** The Quest tier, because the measurements above say it is free where a desktop ride can see the difference
 *  and it is already the right answer where a headset cannot. Raise to `far` on a view a longer draw actually
 *  reaches; drop to `near` on a course that still stutters. */
export const DEFAULT_DRAW_DISTANCE: DrawDistance = 'medium';

export function drawDistanceMetres(tier: DrawDistance): number {
  return DRAW_DISTANCE_METRES[tier] ?? DRAW_DISTANCE_METRES[DEFAULT_DRAW_DISTANCE];
}

export interface RangeCullStats {
  /** Active range in metres; 0 when the gate is off. */
  range: number;
  chunks: number;
  chunksDrawn: number;
  slots: number;
  slotsDrawn: number;
}

export interface RangeCullDeps {
  scene: THREE.Scene;
  /** The reference quilt's per-cell draw meshes. */
  chunks(): readonly THREE.Mesh[];
  /** Every reference prop draw; only the `BatchedMesh` ones can gate an individual slot. */
  propMeshes(): readonly ReferencePropMesh[];
  /** The hung sky's horizon colour — haze has to fade into the backdrop standing behind it. */
  fogColor(): THREE.Color | null;
}

const IDLE: RangeCullStats = { range: 0, chunks: 0, chunksDrawn: 0, slots: 0, slotsDrawn: 0 };
/** Where the haze lands when a level hangs no sky: a neutral daylight grey, so the gate still reads as
 *  distance rather than as geometry being deleted in front of you. */
const DEFAULT_FOG = 0xa8b6c6;

export function createRangeCull(deps: RangeCullDeps) {
  const eyeLocal = new THREE.Vector3();
  const inverse = new THREE.Matrix4();
  const slotMatrix = new THREE.Matrix4();
  /** Slot origins in each batch's own frame. Props are placed once and do not translate, so this is cached;
   *  a Play mutation that moves one keeps its authored gate position, exactly as the Unity culler's
   *  Start-time position cache does. */
  const slotCentres = new WeakMap<THREE.BatchedMesh, Float32Array>();
  /** Which slots THIS gate hid, so leaving the ride restores those and touches nothing else. */
  const gated = new WeakMap<THREE.BatchedMesh, Uint8Array>();
  const touched = new Set<THREE.BatchedMesh>();
  const lastEye = new THREE.Vector3();

  let range: number | null = null;
  let armed = false;
  let dirty = true;
  let lastPass = 0;
  let lastPopulation = -1;
  let stats: RangeCullStats = IDLE;

  /** Compare in the object's own frame: one inverse per mesh instead of transforming every cached centre.
   *  The reference root's placement is a translation plus the chirality REFLECTION, and a reflection
   *  preserves distance, so a range measured here is the range measured in world space. */
  function toLocal(object: THREE.Object3D, eye: THREE.Vector3): void {
    inverse.copy(object.matrixWorld).invert();
    eyeLocal.copy(eye).applyMatrix4(inverse);
  }

  function centresOf(batch: THREE.BatchedMesh): Float32Array {
    const count = batch.instanceCount;
    const known = slotCentres.get(batch);
    if (known && known.length >= count * 3) return known;
    const centres = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      batch.getMatrixAt(i, slotMatrix);
      centres[i * 3] = slotMatrix.elements[12];
      centres[i * 3 + 1] = slotMatrix.elements[13];
      centres[i * 3 + 2] = slotMatrix.elements[14];
    }
    slotCentres.set(batch, centres);
    return centres;
  }

  function pass(eye: THREE.Vector3): void {
    const metres = range as number;
    let chunks = 0, chunksDrawn = 0, slots = 0, slotsDrawn = 0;

    for (const chunk of deps.chunks()) {
      const sphere = chunk.geometry.boundingSphere;
      if (!sphere) continue;
      chunks++;
      toLocal(chunk, eye);
      // Near EDGE, not centre. A 400 m cell measured from its middle would drop while you were standing
      // on the far side of it, which is the one place a range gate must never cut.
      const want = eyeLocal.distanceTo(sphere.center) - sphere.radius <= metres;
      chunk.visible = want;
      if (want) chunksDrawn++;
    }

    const limit = metres * metres;
    for (const mesh of deps.propMeshes()) {
      if (!(mesh as THREE.BatchedMesh).isBatchedMesh) continue;
      const batch = mesh as THREE.BatchedMesh;
      const count = batch.instanceCount;
      if (!count) continue;
      const centres = centresOf(batch);
      let flags = gated.get(batch);
      if (!flags || flags.length < count) { flags = new Uint8Array(count); gated.set(batch, flags); }
      toLocal(batch, eye);
      slots += count;
      for (let i = 0; i < count; i++) {
        const dx = centres[i * 3] - eyeLocal.x;
        const dy = centres[i * 3 + 1] - eyeLocal.y;
        const dz = centres[i * 3 + 2] - eyeLocal.z;
        if (dx * dx + dy * dy + dz * dz <= limit) {
          slotsDrawn++;
          if (flags[i]) { batch.setVisibleAt(i, true); flags[i] = 0; }
        } else if (!flags[i]) {
          batch.setVisibleAt(i, false);
          flags[i] = 1;
        }
      }
      touched.add(batch);
    }

    stats = { range: metres, chunks, chunksDrawn, slots, slotsDrawn };
  }

  /** Show everything this gate hid. Called when the gate turns off, so stepping out of a ride never leaves
   *  a cell or a slot dark — the same duty `ObjectCuller.OnDisable` carries. */
  function restore(): void {
    for (const chunk of deps.chunks()) chunk.visible = true;
    for (const batch of touched) {
      const flags = gated.get(batch);
      if (!flags) continue;
      for (let i = 0; i < flags.length; i++) if (flags[i]) { batch.setVisibleAt(i, true); flags[i] = 0; }
    }
    touched.clear();
    armed = false;
    stats = IDLE;
  }

  function applyFog(): void {
    if (range === null) { deps.scene.fog = null; return; }
    const colour = deps.fogColor() ?? new THREE.Color(DEFAULT_FOG);
    const near = Math.max(0, Math.min(FOG_START_METRES, range - FOG_BAND_MIN_METRES));
    // Mutate an existing Fog rather than replacing it: `scene.fog` appearing or vanishing is part of every
    // fogged material's program key, so a swap recompiles them, while moving near/far is free.
    const fog = deps.scene.fog;
    if (fog instanceof THREE.Fog) { fog.color.copy(colour); fog.near = near; fog.far = range; }
    else deps.scene.fog = new THREE.Fog(colour, near, range);
  }

  return {
    /** Arm the gate at a range in metres, or `null` to turn it off and re-show everything. Idempotent, so
     *  the frame loop can simply assert the range it wants every frame. */
    setRange(metres: number | null): void {
      const next = metres !== null && Number.isFinite(metres) && metres > 0 ? metres : null;
      if (next === range) return;
      const wasOn = range !== null;
      range = next;
      dirty = true;
      if (range === null) { restore(); applyFog(); return; }
      applyFog();
      if (!wasOn) lastPopulation = -1; // a fresh arming re-reads the population it is about to gate
    },

    /** Re-read the active backdrop without disturbing the range or forcing a population pass. Sky images
     *  arrive asynchronously, so a ride can already have armed its fog while the preceding world's panorama
     *  is still installed. The sky layer calls this when that image (or its visibility) changes. */
    refreshFogColor(): void {
      if (range !== null) applyFog();
    },

    /** Re-gate if the viewer has travelled far enough, enough time has passed, or the drawn population
     *  changed under us (a level load or a props rebuild). Cheap enough to call every frame. */
    update(eye: THREE.Vector3): void {
      if (range === null) return;
      const population = deps.chunks().length * 4096 + deps.propMeshes().length;
      if (population !== lastPopulation) { lastPopulation = population; dirty = true; }
      const now = performance.now();
      if (armed && !dirty && now - lastPass < RECHECK_MS
        && eye.distanceToSquared(lastEye) < RECHECK_METRES * RECHECK_METRES) return;
      pass(eye);
      lastEye.copy(eye);
      lastPass = now;
      armed = true;
      dirty = false;
    },

    stats(): RangeCullStats { return stats; },
  };
}

export type RangeCull = ReturnType<typeof createRangeCull>;
