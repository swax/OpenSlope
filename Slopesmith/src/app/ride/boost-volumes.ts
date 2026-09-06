import * as THREE from 'three';
import type { RideObstacleSource } from './obstacles';

/**
 * The MainType-0 boost family in the test ride ([Trailmap: 360-node, 360-zboost, 360-lapboost, 360-tubeend]).
 *
 * Five registry names share one mechanism, and the engine's class layout says so: sub-7 is the base, sub-16 and
 * sub-24 derive from it, and sub-15 and sub-18 lay out the same three fields at the same offsets. So all four
 * kinds below reduce to the same push — speed along an axis approaching a target as a first-order lag — and
 * differ only in what they do around it.
 *
 * `dir` is WORLD space in every kind. The engine never rotates it by the host's transform, so neither do we
 * ([Trailmap: 360-node-fields]); the caller resolves each vector and altitude into editor world space before
 * building a spec, which keeps this module frame-agnostic.
 *
 * Duration is containment, not a debounced contact event. These volumes act every tick a rider is inside them —
 * the vertical lift cancels horizontal motion *per tick*, and a lift that only fired every debounce interval
 * would lurch instead of climb. The engine tests the host's bounding box, which is confirmed
 * ([Trailmap: 360-tube-box]), so the ride tests an AABB too.
 */
/**
 * The lifetime rule the two nodes that run `BoostNode_Update` carry — sub-7 and the sub-24 that inherits it
 * ([Trailmap: 360-node-mode]). The same countdown means opposite things depending on it:
 *
 *   0    a COOLDOWN. While it runs the push is suppressed entirely; the node never self-retires.
 *   1    an ACTIVE WINDOW. With the usual `U1` of 0 the node lives exactly as long as contact does, which is
 *        what containment already reproduces — so mode 1 needs nothing here.
 *   >=2  never seeded, so the countdown is 0 and the node retires on its first tick. INERT.
 *
 * Every scripted boost in the retail corpus is mode 1 (45 of 45), so this exists for AUTHORED content, and
 * that is exactly why it has to be honoured: the effects editor offers the field and documents its meaning,
 * and a mode an author can set that does nothing on PS2 must not push here.
 */
export type BoostMode = number;

export type BoostVolumeSpec =
  /** Sub-7. The general directional velocity driver: conveyors, exhaust vents, sand boosts, wind. */
  | { kind: 'directional'; dir: THREE.Vector3; target: number; rate: number;
      mode: BoostMode; seconds: number }
  /**
   * Sub-18. An elevator, not a push: it cancels horizontal motion, aims at an ALTITUDE rather than a speed,
   * and writes the rider to that altitude once within `snapTolerance` of it. A tolerance of zero never snaps
   * and eases all the way in; one larger than any gap it can see snaps on the first tick.
   */
  | { kind: 'vertical-lift'; dir: THREE.Vector3; target: number; rate: number;
      targetY: number; snapTolerance: number }
  /**
   * Sub-15. Lifts like the elevator but bounded by the volume rather than an altitude, and additionally
   * classifies the rider into a launch stage that the tube-end volume consumes. The stage is latched on entry
   * and never revised ([Trailmap: 360-tube-latch]).
   */
  | { kind: 'lap-gated'; dir: THREE.Vector3; target: number; rate: number;
      /** The host's own +X in editor world space — the one field in the family the engine turns by the host's
       *  instance matrix. The stage test reads which side of the box centre the rider is on along it. */
      axis: THREE.Vector3;
      /** Height above the volume's own floor a rider must clear for a stage above 0 — the engine's 10 m. */
      stageFloorOffset: number }
  /** Sub-24. The staged launch: the recorded stage picks one of three (direction, speed) pairs. Its
   *  constructor calls sub-7's and its per-tick update IS sub-7's, so it inherits the same mode/window
   *  lifetime ([Trailmap: 360-tubeend]). */
  | { kind: 'tube-end'; stages: readonly { dir: THREE.Vector3; speed: number }[]; rate: number;
      mode: BoostMode; seconds: number };

export interface BoostVolume {
  key: string;
  box: THREE.Box3;
  spec: BoostVolumeSpec;
}

/**
 * The host's bounds in its own model space — the box the engine reads off the bound entity
 * ([Trailmap: 360-tube-box]) — from whichever collision representation the prop actually carries.
 *
 * Both branches matter, because a boost node is now the ONLY way a MainType-0 boost reaches the rider: the
 * debounced collision dispatch that used to double as a fallback is gone (`reference-effects.ts`), so a host
 * this cannot bound is a host whose boost silently does nothing. A mode-3 prop carries a sphere tree instead
 * of triangles, and a sphere tree bounds perfectly well — it is packed model-local x/y/z/r leaves, so the
 * box is the union of each leaf's own.
 */
function sourceBounds(source: RideObstacleSource): THREE.Box3 | null {
  if (source.geometry) {
    source.geometry.computeBoundingBox();
    return source.geometry.boundingBox?.clone() ?? null;
  }
  const leaves = source.spheres;
  if (!leaves?.length) return null;
  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  for (let at = 0; at + 3 < leaves.length; at += 4) {
    const radius = leaves[at + 3];
    box.expandByPoint(corner.set(leaves[at] - radius, leaves[at + 1] - radius, leaves[at + 2] - radius));
    box.expandByPoint(corner.set(leaves[at] + radius, leaves[at + 1] + radius, leaves[at + 2] + radius));
  }
  return box.isEmpty() ? null : box;
}

/**
 * Resolve the authored specs against the ridden world's prop colliders: a volume takes its bounds from the
 * hosting obstacle, which is the engine's rule — the node reads a bounding box off its bound entity
 * ([Trailmap: 360-tube-box]).
 *
 * Built ONCE per launch and shared by every rider on the mountain. A `BoostVolume` is read-only geometry; the
 * latch and the captured launch axis are per-rider and live in the runtime built around it, so the player and
 * each AI opponent get their own `createBoostVolumeRuntime` over this one list.
 */
export function buildBoostVolumes(obstacles: readonly RideObstacleSource[] | undefined,
  specs: ReadonlyMap<string, BoostVolumeSpec> | undefined): BoostVolume[] {
  if (!specs?.size || !obstacles?.length) return [];
  const built: BoostVolume[] = [];
  for (const source of obstacles) {
    // Must match reference-effects' runtimeObjectKey exactly — the two sides meet only on this string.
    const objectKey = source.object.kind === 'reference'
      ? `reference:${source.object.index}` : `authored:${source.object.id}`;
    const spec = specs.get(objectKey);
    if (!spec) continue;
    const box = sourceBounds(source);
    if (!box) continue;
    built.push({ key: source.key, box: box.applyMatrix4(source.matrixWorld), spec });
  }
  return built;
}

/** Per-volume runtime state. Mirrors the engine's per-rider arrays, collapsed to the test ride's single rider. */
interface VolumeState {
  /** The engine latches on entry so classification and direction capture happen exactly once. */
  latched: boolean;
  captured: THREE.Vector3 | null;
  /** Lap-gated only: whether this contact serves the rider at all, decided with the latch. */
  serviced: boolean;
  /**
   * Vertical lift only: the node has RETIRED, so it will not lift again for this contact.
   *
   * The lift's lifetime rule is presence, not a window — its alive flag is set by a rider it lifted and by
   * nothing else, and an alive flag of zero self-ends the node on that tick ([Trailmap: 360-zboost]). So the
   * first tick every rider inside is at or above the target altitude is the tick the node ceases to exist,
   * and nothing rebuilds it until a fresh collision dispatch does.
   *
   * Without this the volume is a trampoline, and a bad one: the lift cancels horizontal motion every tick, so
   * a rider it has carried to the ceiling cannot travel out of the box — they fall back through the target,
   * qualify again, and are lifted again, forever. Megaplex's air shaft is authored to lift 14.9 m; measured
   * without the retire, `tools/ride-study/boost-throw.ts` had the rider inside for 989 ticks and 33 m up.
   */
  retired: boolean;
  /** Seconds this contact has lasted, for the mode-0 cooldown to count against. */
  elapsed: number;
}

/**
 * Is the push suppressed this tick by the node's own lifetime rule ([Trailmap: 360-node-mode])?
 *
 * Mode 1 is the whole retail corpus and needs nothing: its window governs when the NODE retires, not when it
 * pushes, and containment already reproduces "alive exactly as long as contact". The other two are what an
 * author can reach and the engine treats very differently.
 *
 * WHERE THE COOLDOWN STARTS is the one thing containment has to choose. The engine seeds the countdown when
 * the node is CONSTRUCTED, and construction is a collision dispatch — an event a permanent volume does not
 * have. Contact is the closest thing to it, so the cooldown runs from the tick the rider arrived. Said out
 * loud because no shipped content exercises it: modes 0 and 2+ are read from the lifetime logic rather than
 * observed in data, so this is the traced rule applied to a model the trace did not cover.
 */
function suppressed(mode: BoostMode, seconds: number, state: VolumeState): boolean {
  if (mode >= 2) return true;               // never seeded, retires on its first tick — inert by construction
  if (mode === 0) return state.elapsed < seconds;   // the cooldown: alive, and pushing nobody while it runs
  return false;
}

export interface BoostVolumeOpts {
  /** Called once per lap-gated ENTRY latch. The volume's mouth is a lap-crossing station of its own
   *  (`app/ride/laps.ts` — on MEGAPLEX the one every mid-race pass ends at, its finish plane being down-course
   *  of the tube), so this counts the crossing when one is due and returns the counter as the gate must read
   *  it: the post-crossing passes left, zero only for the pass that ends the race, which the volume then
   *  declines to lift ([Trailmap: 360-lapboost-gate, 390-lap-field]). Absent
   *  means the ridden world counts no laps, and a lap volume then lifts on every pass — the only answer a
   *  course with no lap count can give, and the one a rider testing the volume itself wants. */
  enterLapVolume?: () => number;
}

export interface BoostVolumeRuntime {
  /** The stage the lap-gated volume recorded, read by the tube-end volume. The engine keeps this in a small
   *  global table indexed by rider — the two volumes are one mechanism ([Trailmap: 360-tube-pair]). */
  stage: number;
  /** `from` is where the rider was at the START of the tick; presence is the swept segment, not the end point. */
  step(pos: THREE.Vector3, vel: THREE.Vector3, dt: number, from?: THREE.Vector3): void;
  reset(): void;
}

const scratch = new THREE.Vector3();
const sweepLo = new THREE.Vector3(), sweepHi = new THREE.Vector3();

/**
 * Does the rider's travel THIS TICK meet the volume? The engine's presence pass gates every node in the family
 * on an `IntersectLineQuery` over the tick's movement ([Trailmap: 360-zboost]), not on where the rider happened
 * to finish — and the difference is not academic: at 30 m/s a rider covers half a metre a tick, so a point test
 * walks straight through a conveyor plate or a boost pad thin enough to fit between two samples.
 *
 * A slab test on the segment, which for a zero-length movement degenerates to exactly the point test.
 */
function sweepHitsBox(box: THREE.Box3, from: THREE.Vector3, to: THREE.Vector3): boolean {
  let enter = 0, exit = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const a = from[axis], delta = to[axis] - a;
    const lo = box.min[axis], hi = box.max[axis];
    if (Math.abs(delta) < 1e-9) { if (a < lo || a > hi) return false; continue; }
    const t0 = (lo - a) / delta, t1 = (hi - a) / delta;
    enter = Math.max(enter, Math.min(t0, t1));
    exit = Math.min(exit, Math.max(t0, t1));
    if (enter > exit) return false;
  }
  return true;
}

/**
 * The shared push. Speed along `dir` approaches `target` as a first-order lag with time constant `1/rate`, and
 * it only ever ADDS — a rider already faster along the axis is left alone, so a boost never brakes
 * ([Trailmap: 360-node-apply]).
 */
function approach(vel: THREE.Vector3, dir: THREE.Vector3, target: number, rate: number, dt: number): void {
  if (rate <= 0 || dir.lengthSq() < 1e-8) return;
  const deficit = target - vel.dot(dir);
  if (deficit <= 0) return;
  vel.addScaledVector(dir, deficit * rate * dt);
}

/** Both lift kinds cancel travel and leave only the climb; the engine zeroes X and Y every tick it lifts. */
function killHorizontal(vel: THREE.Vector3): void {
  vel.x = 0;
  vel.z = 0;
}

export function createBoostVolumeRuntime(volumes: readonly BoostVolume[],
  opts: BoostVolumeOpts = {}): BoostVolumeRuntime {
  const states = new Map<string, VolumeState>();
  const runtime: BoostVolumeRuntime = {
    stage: 0,
    reset() { states.clear(); runtime.stage = 0; },
    step(pos, vel, dt, from) {
      if (!volumes.length || dt <= 0) return;
      sweepLo.copy(from ?? pos);
      sweepHi.copy(pos);
      for (const volume of volumes) {
        let state = states.get(volume.key);
        const inside = sweepHitsBox(volume.box, sweepLo, sweepHi);
        if (!inside) {
          // Leaving clears the latch, so a re-entry classifies and captures afresh — the engine builds a new
          // node per contact dispatch, which has the same effect.
          if (state) states.delete(volume.key);
          continue;
        }
        if (!state) {
          state = { latched: false, captured: null, serviced: false, retired: false, elapsed: 0 };
          states.set(volume.key, state);
        }
        if (!state.retired) applyVolume(volume, state, runtime, opts, pos, vel, dt);
        // Counted after the apply, so the first tick of contact sees a zero-length cooldown as already run —
        // which is what `U1` = 0 means, and what every retail placement authors.
        state.elapsed += dt;
      }
    },
  };
  return runtime;
}

function applyVolume(volume: BoostVolume, state: VolumeState, runtime: BoostVolumeRuntime,
  opts: BoostVolumeOpts, pos: THREE.Vector3, vel: THREE.Vector3, dt: number): void {
  const spec = volume.spec;
  switch (spec.kind) {
    case 'directional':
      if (suppressed(spec.mode, spec.seconds, state)) return;
      approach(vel, spec.dir, spec.target, spec.rate, dt);
      return;

    case 'vertical-lift': {
      // A rider at or above the target is released outright rather than held — and with nobody left to lift,
      // the node ends here. That is the lift's whole lifetime rule, and it is what makes the volume a ride
      // rather than a trampoline: it carries the rider up once, and a rider who falls back through the target
      // afterwards meets nothing ([Trailmap: 360-zboost]).
      if (pos.y >= spec.targetY) { state.retired = true; return; }
      const gap = spec.targetY - pos.y;
      if (gap < spec.snapTolerance) {
        // The arrival branch writes the ALTITUDE and nothing else about the climb: the vertical velocity
        // survives, and is what the tube-end launch then builds on. The horizontal still goes — the engine
        // zeroes X and Y on both exits of this node, the snap included ([Trailmap: 360-zboost]).
        //
        // Arrival is arrival: the rider is at the target, so the next tick lifts nobody and the node is done.
        pos.y = spec.targetY;
        killHorizontal(vel);
        state.retired = true;
        return;
      }
      approach(vel, spec.dir, spec.target, spec.rate, dt);
      killHorizontal(vel);
      return;
    }

    case 'lap-gated': {
      if (!state.latched) {
        state.latched = true;
        // Entry is the lap crossing (BoostVolumeOpts.enterLapVolume): the counter counts it at this mouth and
        // hands back the post-crossing value, which the engine's gate reads — nonzero lifts, zero is the pass
        // that ends the race riding through ([Trailmap: 360-lapboost-gate]). On MEGAPLEX that is 3, 2, 1 at
        // three lifted crossings, then 0. Counted once, with the latch, so a lap counted mid-contact cannot
        // drop a rider out of a lift already under way.
        state.serviced = (opts.enterLapVolume?.() ?? 1) !== 0;
        if (state.serviced) runtime.stage = classifyStage(spec, volume.box, pos);
      }
      if (!state.serviced) return;
      approach(vel, spec.dir, spec.target, spec.rate, dt);
      killHorizontal(vel);
      return;
    }

    case 'tube-end': {
      // Its update IS sub-7's, so the same lifetime rule gates it ([Trailmap: 360-tubeend]).
      if (suppressed(spec.mode, spec.seconds, state)) return;
      const stage = spec.stages[runtime.stage] ?? spec.stages[0];
      if (!stage) return;
      // Captured once on entry, exactly as the engine copies the stage's vector into a per-rider slot seeded
      // with a sentinel and normalises it there.
      if (!state.captured) state.captured = stage.dir.clone().normalize();
      approach(vel, state.captured, stage.speed, spec.rate, dt);
      return;
    }
  }
}

/**
 * Stage 0 below the floor line; otherwise which side of the box centre the rider is on along the host's local
 * +X. Note stage 0 is what a real run of the retail course produces, because a rider enters the shaft at its
 * base — well under the floor line — and the answer is latched there ([Trailmap: 360-tube-latch]).
 */
function classifyStage(spec: Extract<BoostVolumeSpec, { kind: 'lap-gated' }>, box: THREE.Box3,
  pos: THREE.Vector3): number {
  if (pos.y <= box.min.y + spec.stageFloorOffset) return 0;
  box.getCenter(scratch);
  scratch.subVectors(pos, scratch).setY(0);
  return scratch.dot(spec.axis) < 0 ? 1 : 2;
}
