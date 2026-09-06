import * as THREE from 'three';
import type { RideObstacleSource } from './obstacles';

/**
 * The Cracked surface in the test ride ([Trailmap: 370-world-interaction, 230-level-ssf type 0 sub 14]).
 *
 * The node breaks nothing itself. It holds a STRENGTH pool, subtracts the force of each accepted contact from
 * it, and when the pool crosses zero it fires the slot's TRIGGER effect — which is where the shatter goes.
 * Retail's Megaplex pane is the only place the game authors it: ride onto the glass and it cracks, stay on it
 * and a few seconds later it gives way and you drop through.
 *
 * WHAT A HIT COSTS DEPENDS ON HOW THE RIDER MEETS THE SURFACE, and that is the whole behaviour rather than a
 * detail. Measured on PS2 two ways:
 *
 *   * CARRIED — the rider supported by the surface, riding along it. A strength-1000 cell laid in the slope
 *     took ten or more hits in one traversal, and the cheap ones cost 0.687-2.5. Retail's authored 5 drains in
 *     about three seconds of this, which is the cracked glass you ride on.
 *   * IMPACT — the rider crossing into it, hitting it as a wall, or dropping onto it from a height. One hit,
 *     70-96. Retail's 5 is gone instantly, which is why falling onto a pane breaks straight through.
 *
 * Corroborated live: three panes a player had ridden held pools of 5.0000, 3.8750 and 2.0165 mid-drain.
 *
 * The 30-FRAME GATE is what paces it. Hits land 0.5 s apart while contact lasts — measured as a flat 0.5 s on
 * a carried ride, exactly 30 frames at 60 Hz — so a carried rider reaches the ceiling continuously and the
 * pool drains at two charges a second rather than per frame.
 *
 * A RETAIL PANE IS A PAIR, and it decides how this runtime has to watch for contact. `Mdl_Glass_Pane_4000` is
 * VISIBLE and response mass 0 — pass-through — and carries the effect slot; `Mdl_Glass_Surface_4000` beside it
 * is INVISIBLE and solid, and is what actually holds the rider up. So the pane the crack lives on is never the
 * rider's ground, and a drain keyed off ground contact reads the twin's key, finds no crack on it, and never
 * spends a thing however long you ride. Containment is what the engine tests and what this tests.
 *
 * THE HIDE IS OURS TO DO. Retail's chain carries no `DeadNodeMode 4` anywhere: nothing in the effect graph
 * hides the intact pane, yet it disappears and the rider falls through. The engine's crack handler does it, so
 * this runtime does it too — `onBreak` hides the host and runs the slot's trigger column, which is where the
 * shatter sound, the twin's kill and the debris throw live.
 *
 * The cracked APPEARANCE is authored, just not in the graph: MEGAPLE material 43 — shared by every
 * `Mdl_Glass_Pane_*` and `Mdl_Glass_Surface_*` — carries a two-frame `TextureFlipbook` of plain and cracked
 * glass, and the handler selects frame 1. `onCrack` is where that selection belongs. It has to be applied PER
 * INSTANCE: one material serves all 77 glass instances, so painting the material itself cracks the whole level
 * at once, which is why retail draws a flip through a private override table ([Trailmap: 410-texture-animation]).
 */

/** What the effect graph authored, before it is joined to any geometry. */
export interface CrackedSurfaceSpec {
  /** Authored `U1` — the impact budget. Retail's panes ship 5. */
  strength: number;
  /** Authored `U0` in seconds. Zero or negative never expires, which is what every retail pane authors:
   *  once cracked, cracked until it gives way. A positive lifetime retires the crack and takes the
   *  accumulated damage with it, so the surface HEALS. */
  lifetimeSeconds: number;
}

/** One authored surface joined to the world geometry the rider is tested against. */
export interface CrackedSurface extends CrackedSurfaceSpec {
  /** Runtime object key of the host — `runtimeObjectKey`'s string, the only thing the two sides meet on. */
  key: string;
  /** The host's world bounds — the BROAD phase only. CONTAINMENT is the test, not a swept crossing, because
   *  that is what the engine does: it re-runs the contact every tick the rider overlaps the instance, which
   *  is how the pool accrues, and a rider gliding along a flat pane never crosses its faces again. */
  box: THREE.Box3;
  /** The host's collision faces in world space — the NARROW phase, and the reason the box alone cannot be
   *  the test: a tilted pane's axis-aligned box is a wedge of empty air many times the glass, so a rider
   *  descending toward it enters the box long before the surface and a box-only charge breaks panes at a
   *  distance. Empty (a sphere-set host) falls back to the box. */
  triangles: readonly THREE.Triangle[];
}

/**
 * Join what the graphs authored to what the ride can test, exactly as `buildBoostVolumes` does for the boost
 * family — and for the same reason, since both act per tick on a rider who is merely PRESENT.
 */
export function buildCrackedSurfaces(obstacles: readonly RideObstacleSource[] | undefined,
  specs: ReadonlyMap<string, CrackedSurfaceSpec> | undefined): CrackedSurface[] {
  if (!specs?.size || !obstacles?.length) return [];
  const built: CrackedSurface[] = [];
  for (const source of obstacles) {
    // Must match reference-effects' runtimeObjectKey exactly — the two sides meet only on this string.
    const objectKey = source.object.kind === 'reference'
      ? `reference:${source.object.index}` : `authored:${source.object.id}`;
    const spec = specs.get(objectKey);
    if (!spec) continue;
    const box = crackedBounds(source);
    if (!box) continue;
    built.push({ ...spec, key: source.key, box: box.applyMatrix4(source.matrixWorld),
      triangles: worldTriangles(source) });
  }
  return built;
}

/** The collider's faces lifted to world space once, at build time. A pane is a 4-vert quad, so this is tiny;
 *  it is a snapshot, which is fine for the same reason the boxes are — nothing that cracks also moves. */
function worldTriangles(source: RideObstacleSource): THREE.Triangle[] {
  const geometry = source.geometry;
  const position = geometry?.getAttribute('position');
  if (!geometry || !position) return [];
  const index = geometry.getIndex();
  const count = index ? index.count : position.count;
  const out: THREE.Triangle[] = [];
  const vertex = (at: number) => new THREE.Vector3()
    .fromBufferAttribute(position, index ? index.getX(at) : at).applyMatrix4(source.matrixWorld);
  for (let at = 0; at + 2 < count; at += 3) out.push(new THREE.Triangle(vertex(at), vertex(at + 1), vertex(at + 2)));
  return out;
}

function crackedBounds(source: RideObstacleSource): THREE.Box3 | null {
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

export interface CrackedSurfaceEvents {
  /** The surface has just taken its first damage and is now visibly cracked. */
  onCrack?(key: string): void;
  /** The pool has run out. The caller hides the host and runs the slot's trigger column. */
  onBreak?(key: string): void;
  /** A positive lifetime expired before the pool ran out: the crack retires and the surface is whole again. */
  onHeal?(key: string): void;
}

/** The 30-frame gate at 60 Hz. A carried rider reaches this ceiling continuously. */
export const CRACK_GATE_SECONDS = 0.5;

/** What one CARRIED contact costs. The measured cheap hits ran 0.687-2.5; retail's 5 wants to survive three
 *  or four of them, which this sits in the middle of. */
export const CARRIED_HIT_COST = 1.0;

/** What one IMPACT costs — the rider crossing in, or landing hard. Measured 70-96 across every staging that
 *  produced a single hard contact, tightly clustered near 87. */
export const IMPACT_HIT_COST = 87;

/** Below this speed ALONG THE SURFACE NORMAL, a contact is a ride rather than a blow, and charges the carried
 *  cost. The axis matters: a rider descending an 18-degree course carries 7+ m/s of vertical speed while
 *  riding perfectly along the glass, so vertical speed alone reads ordinary downhill riding as an impact and
 *  breaks every pane on arrival. Against the pane's own normal that same rider reads near zero. Chosen rather
 *  than measured — the PS2 arithmetic reduces two contact vectors we do not reconstruct. */
export const IMPACT_NORMAL_SPEED = 8;

/** How far past the board's own point the containment test reaches. The rider is a point to this model and a
 *  pane is a thin plate laid on the floor it is flush with, so a bare point test skims over it; half a metre
 *  is the board's own scale and keeps a rider standing on the glass inside the glass. */
const BOARD_REACH_M = 0.5;

/**
 * The longest step the swept test will believe WITHOUT the caller's own velocity vouching for it, in metres.
 * A boarder covers about half a metre per tick, so a long chord is normally not travel: it is the first tick
 * of a run (no previous sample yet), a teleport, or a frame hitch. Sweeping those spans a box from wherever
 * the rider WAS to wherever they are and charges every cracked surface between — which, from an unseeded
 * origin, is every pane on the mountain at once. Falling back to a point test at the destination is both safe
 * and right for those. But a Superman flight legitimately covers many metres in one frame, and the point
 * fallback let a fast flyer pass clean through a pane unregistered — so a chord consistent with `vel · dt`
 * is believed as travel at any length, and only a chord the velocity cannot explain takes the fallback.
 */
const MAX_SWEEP_M = 5;
/** Slack on the `vel · dt` travel test: integration substeps and slides shorten real chords, never grow them. */
const SWEEP_VEL_SLACK = 1.5;

interface SurfaceState {
  spec: CrackedSurface;
  /** Remaining pool. Starts at the authored strength and is only spent once cracked. */
  strength: number;
  /** Seconds until this surface will accept another charge. */
  gate: number;
  /** Seconds of crack remaining, or Infinity for the authored -1 that never expires. */
  life: number;
  cracked: boolean;
  broken: boolean;
}

export interface CrackedSurfaceRuntime {
  /** One tick of CONTAINMENT. Every surface whose box the rider's swept segment touches is charged, gated —
   *  the engine re-runs the contact each tick a rider overlaps the instance, and a pane is worn down by
   *  presence rather than by crossing its faces. `height` extends the presence upward from the chord — the
   *  on-foot walker passes its standing body so a chest-high pane registers on the torso, not just the feet;
   *  the board keeps the default point-with-reach presence retail's containment charges. */
  step(from: THREE.Vector3, to: THREE.Vector3, vel: THREE.Vector3, dt: number, height?: number): void;
  /** A discrete collision with a host, at `normalSpeed` m/s along the contact normal. */
  impact(key: string, normalSpeed: number): void;
  /** Refill and re-arm one pane after the shared breakable respawn timer expires. */
  restore(key: string): void;
  /** Whether this host has given way, so a caller can keep it out of the collider. */
  isBroken(key: string): boolean;
  /** Whether this host is cracked but still standing — the state the rider rides on. */
  isCracked(key: string): boolean;
  /** Remaining pool, for HUD and tests. */
  strengthOf(key: string): number | null;
}

export function createCrackedSurfaceRuntime(surfaces: readonly CrackedSurface[],
  events: CrackedSurfaceEvents = {}): CrackedSurfaceRuntime {
  const states = new Map<string, SurfaceState>();
  const swept = new THREE.Box3();
  const sample = new THREE.Vector3();
  const body = new THREE.Vector3();
  const closest = new THREE.Vector3();
  const triNormal = new THREE.Vector3();
  for (const spec of surfaces) {
    states.set(spec.key, {
      spec,
      strength: spec.strength,
      gate: 0,
      // A non-positive authored lifetime never expires. Seeded here rather than at crack time so the field
      // reads the same whether or not the rider has touched it yet.
      life: spec.lifetimeSeconds > 0 ? spec.lifetimeSeconds : Number.POSITIVE_INFINITY,
      cracked: false,
      broken: false,
    });
  }

  function charge(state: SurfaceState, cost: number): void {
    if (state.broken) return;
    // A surface whose pool has gone negative refuses every later contact, so the give-way happens once.
    if (state.gate > 0) return;
    state.gate = CRACK_GATE_SECONDS;
    if (!state.cracked) {
      state.cracked = true;
      events.onCrack?.(state.spec.key);
    }
    state.strength -= cost;
    if (state.strength <= 0) {
      state.broken = true;
      events.onBreak?.(state.spec.key);
    }
  }

  return {
    step(from, to, vel, seconds0, height = 0) {
      const seconds = Number.isFinite(seconds0) && seconds0 > 0 ? seconds0 : 0;
      for (const state of states.values()) {
        if (state.broken) continue;
        if (state.gate > 0) state.gate = Math.max(0, state.gate - seconds);
        if (state.cracked && state.life !== Number.POSITIVE_INFINITY) {
          state.life -= seconds;
          if (state.life <= 0) {
            // The crack retires and takes the accumulated damage with it. Retail authors -1 on every pane it
            // ships precisely so this cannot happen to glass.
            state.cracked = false;
            state.strength = state.spec.strength;
            state.life = state.spec.lifetimeSeconds;
            events.onHeal?.(state.spec.key);
          }
        }
      }
      // The rider's swept segment for this tick, fattened by the board so a thin pane cannot slip between two
      // samples of a fast rider — the same reason the boost volumes sweep rather than point-test. A chord the
      // caller's own velocity accounts for is genuine travel however long it is; only an unexplainable jump
      // (teleport, unseeded origin) takes the destination-point fallback.
      const presenceHeight = Math.max(0, height);
      const believable = Math.max(MAX_SWEEP_M, vel.length() * seconds * SWEEP_VEL_SLACK + BOARD_REACH_M);
      const travelled = from.distanceToSquared(to) <= believable * believable;
      const start = travelled ? from : to;
      swept.makeEmpty().expandByPoint(to).expandByPoint(start).expandByScalar(BOARD_REACH_M);
      swept.max.y += presenceHeight;
      for (const state of states.values()) {
        // The gate is checked here as well as in charge(): a gated surface skips the narrow phase entirely.
        if (state.broken || state.gate > 0 || !state.spec.box.intersectsBox(swept)) continue;
        // NARROW phase: the rider must be within board reach of an actual collision face, not merely inside
        // the world box — a tilted pane's box is mostly air, and charging on the box breaks glass the rider
        // is still descending toward. The step is sampled at board-reach spacing so a thin pane cannot fall
        // between two samples of a fast rider, and a presence height is sampled up its column the same way so
        // a standing walker's torso finds a chest-high pane their feet chord passes under.
        let contactNormal: THREE.Vector3 | null = null;
        if (state.spec.triangles.length) {
          const steps = Math.min(64, Math.max(1, Math.ceil(start.distanceTo(to) / BOARD_REACH_M)));
          const bodySteps = Math.ceil(presenceHeight / BOARD_REACH_M);
          search: for (let at = 0; at <= steps; at++) {
            sample.lerpVectors(start, to, at / steps);
            for (let up = 0; up <= bodySteps; up++) {
              body.copy(sample);
              if (up > 0) body.y += (presenceHeight * up) / bodySteps;
              for (const triangle of state.spec.triangles) {
                triangle.closestPointToPoint(body, closest);
                if (closest.distanceToSquared(body) <= BOARD_REACH_M * BOARD_REACH_M) {
                  contactNormal = triangle.getNormal(triNormal);
                  break search;
                }
              }
            }
          }
          if (!contactNormal) continue;
        }
        // The regime is speed ALONG THE SURFACE NORMAL. A rider descending a steep course rides the glass
        // with near-zero normal speed however fast they are falling with the slope; a rider dropping onto it
        // closes along the normal and pays the impact price. A sphere-set host has no faces to take a normal
        // from, and falls back to vertical speed — the right axis for the floor this node is authored on.
        const closing = contactNormal ? Math.abs(vel.dot(contactNormal)) : Math.abs(vel.y);
        charge(state, closing >= IMPACT_NORMAL_SPEED ? IMPACT_HIT_COST : CARRIED_HIT_COST);
      }
    },
    impact(key, normalSpeed) {
      const state = states.get(key);
      if (!state) return;
      const speed = Number.isFinite(normalSpeed) ? Math.abs(normalSpeed) : 0;
      charge(state, speed >= IMPACT_NORMAL_SPEED ? IMPACT_HIT_COST : CARRIED_HIT_COST);
    },
    restore(key) {
      const state = states.get(key);
      if (!state) return;
      state.strength = state.spec.strength;
      state.gate = 0;
      state.life = state.spec.lifetimeSeconds > 0
        ? state.spec.lifetimeSeconds : Number.POSITIVE_INFINITY;
      state.cracked = false;
      state.broken = false;
    },
    isBroken(key) { return states.get(key)?.broken ?? false; },
    isCracked(key) { const s = states.get(key); return !!s && s.cracked && !s.broken; },
    strengthOf(key) { return states.get(key)?.strength ?? null; },
  };
}
