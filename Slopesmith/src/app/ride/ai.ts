import * as THREE from 'three';
import {
  RESET_SPEED, WORLD_UP, clamp, createRideModel, moveTowards, projectOnPlane, rideForward, riderDrive,
  type PatchContact, type RideModel, type RideObstacleHit, type RideObstacleObject,
  type RideObstacleSource, type RideState,
} from './physics';
import type { BoostVolume } from './boost-volumes';
import type { CrackedSurface } from './cracked-surfaces';
import type { RideEffectAction } from './effect-actions';
import type { FinishLine } from './laps';
import type { RideGear, SnowboardStance } from './gear';
import type { GrindRails } from './grind';
import type { RideKeys } from './input';
import { createRiderPose, type RiderPose } from './pose';

/**
 * The AI field for the test ride ([Trailmap: 395]).
 *
 * These are not path followers. Each opponent is a *rider* — the same `physics.ts` model the player rides, on
 * the same terrain, with the same contact, carve and gravity — and the AI's entire job is to synthesize what the
 * player supplies with a keyboard: the stick, and the buttons. That is exactly what the engine does. An SSX AI
 * racer is an ordinary boarder whose input source fills the same packed pad word the human's pad fills, so it
 * cannot steer outside the physics, cannot cheat the terrain, and washes out on ice for the same reasons the
 * player does. Everything below produces that word and hands it over.
 *
 * Four things drive it, and each is one traced piece of the engine:
 *
 * 1. **The tracker.** Project the rider onto its current AI path, take the point `LOOKAHEAD` further along as a
 *    pursuit target, and press the stick in proportion to the bearing error to it. The projection is
 *    **horizontal**, the arc it runs along is **horizontal** (see `AiPath` — that is the one that bites), and the
 *    arc is **forward-only** — see `track()`.
 * 2. **The behaviour machine.** The engine runs a four-state member-function-pointer machine — approach-a-marker
 *    (the jump), cruise, avoid a rival, attack a rival — of which we field three. `behave()`.
 * 3. **The path chain.** A level's AI paths are short overlapping segments — a menu of racing lines — and a rider
 *    hands off as it runs out of one, or re-chooses when it is shoved off it. Candidates are scored by geometry
 *    *and* by how well their **line rating** matches the rider's mood.
 * 4. **Catch-up**, which is not a force but **time dilation**, banded on the along-course gap to the competitor
 *    immediately ahead in the standings — a ladder, not a star. Band the whole field against the player and it
 *    collapses into a clump around them; that is a bug, not rubber-banding.
 *
 * What makes a field of riders *differ* is, in order: the lines they choose (rating × mood), how they react to
 * **each other** (avoid / attack / body bumps — with no rivals a field has nothing that can push it apart), the
 * skill scalars, and last and least the speed statistic (which is a recovery stat, not a top-speed stat: see
 * `CHARACTERS`).
 *
 * NOT ported, and named as gaps rather than hidden: the engine's cruise **boost** press is gated on the boost
 * meter, which this ride has no equivalent of ([Trailmap: 360]), so a rider only boosts where the engine boosts
 * for a *traced* reason — under-speed on the run-in to a jump marker. The **throttle axis** has no counterpart in
 * this model's automatic cruise drive, so the tuck stands in for it. **Tricks** are selected by the engine at the
 * jump press and we have no trick system to fire. And the AI never bumps the *player* here (the engine bumps
 * everyone; our player's model owns its own position).
 *
 * One thing here is purely the editor's and has no engine counterpart: `spawnAt`, which drops a rider wherever
 * you click. A race field is seeded at the gates and that is all the engine ever needed; an author testing a
 * slope needs to put a rider *at the bit they are working on*. It is the same rider either way — only where it
 * starts is new.
 */

// ---- the tracker + steering law ([Trailmap: 395], engine units converted: 100 u = 1 m) ----
// Every arc below is HORIZONTAL arc — plan-view metres along the line, the climb discarded. See `AiPath`.
const LOOKAHEAD = 8.0;            // m of arc ahead of the projection — fixed, NOT speed-scaled (800 u)
const STEER_GAIN = 6.2897;        // stick per radian of bearing error
const STEER_DEADBAND = 0.2;       // below this the stick stays centred (≈1.8° of error)
const STEER_CLAMP = 0.9705;       // and it saturates here (≈8.8° of error)
const TRACK_WINDOW = 30.0;        // m of arc the forward-only projection scans per frame (3000 u)

// The path chain ([Trailmap: 395]).
const END_MARGIN = 2.0;           // m — this close to a path's end, hand off to the next one (200 u)
const OFF_PATH = 5.0;             // m of HORIZONTAL perp — shoved this far off the line, re-choose (500 u)
const RECHOOSE_EVERY = 1.0;       // s — and no more often than this
const CANDIDATES = 6;             // the nearest N paths are the only ones considered
const RATING_WEIGHT = 2.3189357;  // m² of score per rating point matched (23189.357 u²) — worth ~15 m at a match

// The jump ([Trailmap: 395]): the AI's ollie is AUTHORED, not emergent. It presses on a type-25 path marker.
const MARKER_AHEAD = 3.0;         // m — the marker query window runs [lastArc, arc + this] (300 u)
const MARKER_HOLD = 0.5;          // m — it keeps the button held while a marker is inside this shorter window (50 u)
const MARKER_PERP = 1.5310;       // m — and only presses when it is this close to its line (153.102 u)
const MARKER_STEER = 0.5361633;   // ...and only when it is going straight: |stick| under this
const SPEED_SLOP = 1.3889;        // m/s — 5 km/h: the band around a marker's target speed (138.889 u/s)

// Rivals ([Trailmap: 395]): who a rider is reacting to, re-scored every 12th frame.
const RIVAL_EVERY = 0.2;          // s (12 frames)
const RIVAL_ACQUIRE = 7.0;        // m — the acquisition radius (700 u)
const RIVAL_DROP = 10.5;          // m — drop the rival past this (1050 u)
const RIVAL_DROP_OFF = 6.0;       // m off my own path — too lost to care about anyone (600 u)
const RIVAL_HOLD_OFF = 5.4;       // m off my own path — too lost to acquire anyone (540 u)
const AVOID_CLEAR = 1.5;          // m — the clearance disc the avoid cone is drawn around a rival (150 u)
const BUMP_SPLIT = 0.55;          // each rider takes this much of the separation when two bodies overlap
const BUMP_RADIUS = 0.55;         // m — OURS: the engine tests authored collision volumes, which we don't have

// Catch-up ([Trailmap: 395]): a per-rider timestep multiplier, banded on the along-course gap to its reference.
const CATCHUP_BAND = 5.1734;      // m — inside this, time runs normally
const CATCHUP_BEHIND = 1.13598;   // linear ramp coefficient once the rider is more than a band behind
const CATCHUP_AHEAD = 0.0204874;  // reciprocal falloff coefficient once it is more than a band ahead (m)
const CATCHUP_MIN = 0.70008, CATCHUP_MAX = 1.50227;
const CATCHUP_SLEW = 0.008444;    // per 60 Hz tick — a full swing takes ~1.6 s, so the band is never entered abruptly

const STANDINGS_EVERY = 0.1;      // s — the engine re-sorts the field every 6th frame
const SKILL_SWITCH_EVERY = 1.0;   // s — and re-picks each rider's skill scalar every 60th
const SKILL_COMMIT_DIV = 1.1039;  // skill ÷ this = the odds a rider commits to its mood instead of the safe line

/** One topsheet tint per rider, so the field reads apart from the chase camera. */
const TINTS = [0xff5a4a, 0xffb84a, 0x7ee04a, 0x4ad0ff, 0xb06cff, 0xff6cd0];
/**
 * The field's characters. `skill` is the engine's pair of steering-gain scalars — the first is used while the
 * rider's reference is *behind* it (i.e. it is leading its own duel), the second while it is chasing — and it
 * doubles as the odds the rider commits to its mood. `speed` is the character's speed statistic, 0–1 across the
 * engine's traced cruise-drive band ([Trailmap: 360]): how hard it drives back up to the surface's speed target,
 * which every rider shares — so it decides who recovers first out of a bad corner, not who is fastest.
 */
const CHARACTERS: { skill: [number, number]; speed: number }[] = [
  { skill: [1.00, 1.06], speed: 0.95 },  // quick, tidy
  { skill: [0.92, 0.99], speed: 0.55 },  // steady mid-pack
  { skill: [1.08, 1.10], speed: 0.80 },
  { skill: [0.96, 1.02], speed: 0.30 },  // slow but neat
  { skill: [1.04, 1.08], speed: 0.68 },
  { skill: [0.88, 0.95], speed: 0.42 },  // sloppy: wanders off the line, gets re-chosen back onto it
];

/** Deterministic per-field PRNG (mulberry32), so a run is reproducible and the tests are not flaky. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A **jump marker** on an AI path — the engine's type-25 path item, which is raw `EventType` 100 in the AIP
 * ([Trailmap: 250]). This is where the AI's ollie comes from: it is authored, not emergent. `speed` is the
 * marker's target speed (m/s; the file stores km/h in the high bits of its value word) and the two trick flags
 * are what the engine's trick picker rolls against — we have no trick system, so they ride along unused.
 */
export interface AiPathMarker {
  /** Arc length along the path, in metres. */
  arc: number;
  speed: number;
  trickA: boolean;
  trickB: boolean;
}

/** One path of the mountain's AI network, in world space. */
export interface AiPathDef {
  points: THREE.Vector3[];
  /** 0–100 ([Trailmap: 395]); 50 is the default/safe line. */
  rating: number;
  /** The AIP's respawnable flag: the course reset may put a fallen rider back on THIS path. It gates the reset
   *  ONLY — a rider may freely *ride* a non-respawnable path ([Trailmap: 395]). Absent = treated as respawnable. */
  respawnable?: boolean;
  /** Its jump markers, ascending by arc. */
  markers?: AiPathMarker[];
}

export interface AiRidersOpts {
  /** The mountain's whole AI network (world space) — riders chain through it, they do not each own one path. */
  paths: AiPathDef[];
  /** Indices into `paths` of the start-gate lines: one rider is fielded on each. May be empty — a field with no
   *  gate riders is exactly what Play's click-to-drop starts from. */
  starts: number[];
  /** How many riders the field may hold at once. The gates fill it first; `spawnAt` recycles the oldest rider
   *  once it is full. Defaults to the number of gates. */
  maxRiders?: number;
  /** The ridden mesh — the same terrain the player is on. */
  terrain: THREE.Mesh;
  scene: THREE.Object3D;
  /** Character-library id shared by riders in this field. */
  riderModel?: string;
  riderStyle?: string;
  /** The kit the whole field is on — the player's own, so a run is not the only skier on the mountain. */
  gear?: RideGear;
  /** The player's selected snowboard foot order, shared by the visible comparison field. */
  snowboardStance?: SnowboardStance;
  surfaceOf: (faceIndex: number) => number | null;
  /** The authored terrain's analytic Bezier contact; absent for a baked reference world. */
  patchContact?: PatchContact;
  /** The course's grind-rail network — the field grinds what the player grinds ([Trailmap: 350]). */
  rails?: GrindRails;
  /** The mountain's static prop collision. An opponent meets the same solids the player does: without it a
   *  field rides through the level's architecture, which on an urban course is most of the course. */
  obstacles?: readonly RideObstacleSource[];
  /**
   * The mountain's MainType-0 boost volumes ([Trailmap: 360-node]), built once by the caller and shared —
   * read-only geometry, so each rider still builds its own latch over them.
   *
   * The engine runs these off the boarder's carried velocity, not the player's: an AI rider is pushed by a
   * conveyor, lifted by a shaft and thrown by a finish tube exactly as the human is. A field handed none of
   * them rides straight through the level's boosts, which on MEGAPLEX means it can never take the lap tube and
   * therefore can never start a second lap.
   */
  boostVolumes?: readonly BoostVolume[];
  /** The same per-tick cracked-surface containment the human Test rider receives. */
  crackedSurfaces?: readonly CrackedSurface[];
  onCrackedChange?: (slot: number, key: string, cracked: boolean) => void;
  onCrackedBreak?: (slot: number, key: string) => void;
  /**
   * Object keys of the mountain's MainType-13 RESET volumes — `reference:<index>` / `authored:<id>`, the same
   * identity the effect runtime uses ([Trailmap: 390-pickups-and-race]). Touching one puts the rider back on
   * the course, and it is one of the traced arming sites for the reset ([Trailmap: 395-reset-arm]).
   *
   * The player takes these through the SSF graph runtime, which dispatches from its own board and cannot see an
   * opponent; a field is handed the keys instead and each rider matches them against its own prop contacts. Same
   * event, same collider, same answer. Without it a rider that has left the run — through the wall, into the
   * plaza, off the edge of the ledge — simply stays there, because the level's own boundary never reaches it.
   */
  resetVolumes?: ReadonlySet<string>;
  /** Every prop contact a rider makes, with its slot — the field's hand-off into the SSF collision runtime, so
   *  an opponent riding over a button fires the button's graph exactly as the player's board does. */
  onPropCollision?: (slot: number, hit: RideObstacleHit) => void;
  /** The mountain's own finish crossing (`ride/laps.FinishLine`), which on a lap course is nowhere near either
   *  end of `course`. */
  finish?: FinishLine | null;
  /** Passes this course is raced over (core/doc/race). EACH rider counts its own — the engine keeps one
   *  counter per rider, and it is what the lap-gated volume reads ([Trailmap: 390-lap-counter]). */
  laps?: number;
  /** Fires when a rider counts a finish crossing, with its slot and the passes it has left. */
  onLap?: (slot: number, remaining: number) => void;
  oobFloorY: number;
  /** The player's live physics state — they are a competitor in the standings like anyone else. */
  player?: RideState;
  /**
   * The course spine in world space: the field's **progress ruler**. Everything that needs to know who is
   * winning — the standings, and therefore the catch-up ladder, the skill switch, the mood and where a course
   * reset puts you — measures a rider's progress as its arc length along this line ([Trailmap: 140]).
   */
  course?: THREE.Vector3[];
  /** Seeded for the mood's commit roll; injectable so a test can pin it. */
  rng?: () => number;
}

/**
 * A network path with its arc-length table built once and shared by every rider that rides it.
 *
 * **The arc is measured in PLAN VIEW** — the horizontal length of each segment, with the climb thrown away
 * ([Trailmap: 250]). This is not a simplification, it is the engine's own metric, and it is load-bearing enough
 * to be worth spelling out. In the file a path point is `{direction, length}`, and the engine finds a rider's
 * foot on a segment with `s = clamp(dot2(rider − segStart, direction), 0, length)` — a **two-component** dot,
 * horizontal, clamped against that stored length. The clamp only means anything if the two are in the same
 * unit, so the stored length is the segment's *horizontal* extent; the arc that accumulates them is horizontal;
 * the total is horizontal; and every arc-addressed thing on the path — the lookahead, the marker query, the
 * distance-to-finish — is therefore horizontal too. (Confirmed against the data: where a level's race lines
 * genuinely chain, `DistanceToFinish` drops by exactly the plan-view length of the line it just left.)
 *
 * Measure the arc in 3-D instead and a path that leaves the ground stops working. Garibaldi's big drop is a
 * single authored segment that falls 162 m while advancing 31 m across the ground: in 3-D it is 165 m of arc,
 * so a lookahead of 8 m of arc buys only 1.5 m of ground — the pursuit target lands almost on top of the rider,
 * the bearing to it is noise, and the rider carves at a point beside itself. Worse, the orbit is stable: going
 * round in a circle holds the rider's own projection still, so the target never moves on and it never comes
 * out. That is the "riders doing donuts under the jump" bug, and this one field is the whole of it.
 */
interface AiPath {
  pts: THREE.Vector3[];
  cum: Float64Array;      // cumulative HORIZONTAL arc length per point — the metric the file's arcs are in
  flat: Float64Array;     // per-segment horizontal length², for the projection's divide
  total: number;          // ...and the horizontal total
  rating: number;
  respawnable: boolean;
  markers: AiPathMarker[];
}

/**
 * Which behaviour state a rider is in — the machine it runs is `behave()`. The engine has a fourth, **attack**
 * (abandon the line and pursue an intercept point 3 m ahead of a rival along the rival's own velocity), but it is
 * selected by a game-mode enum we could not resolve and, in a race, only against a rider's designated objective
 * target — which a test ride has none of. It is traced in the spec and deliberately not fielded here rather than
 * guessed into a branch that never fires.
 */
type Behaviour = 'approach' | 'cruise' | 'avoid';

interface AiRider {
  born: number;           // monotonic: who has been out on the mountain longest (a full field recycles that one)
  home: number;           // the start-gate path it was fielded on
  path: number;           // index into the network of the path it is riding NOW
  arc: number;            // arc length of the rider's projection onto that path — MONOTONIC, never rewinds
  prevArc: number;        // ...and last frame's, which is the back edge of the marker query window
  seg: number;            // the cached segment the forward-only scan resumes at; −1 = re-scan the whole path
  perp: number;           // HORIZONTAL distance from the line (a rider flying over it is barely off it)
  sinceChoice: number;    // s since the last re-choice, so an off-path rider re-chooses at most once a second
  skills: [number, number]; // the two authored steering gains: [reference behind me, reference ahead of me]
  skill: number;          // whichever of those is live right now (re-picked once a second)
  progress: number;       // arc length along the course ruler — the standings key
  place: number;          // 0 = leading the field (the player counts)
  refProgress: number;    // the progress of the competitor this rider is banded to
  refAhead: boolean;      // ...and whether that competitor is in front of it
  timeScale: number;      // the engine's rubber band: this rider's dt multiplier
  state: Behaviour;
  rival: number;          // index into `riders` of the competitor it is reacting to, or −1
  targetSpeed: number;    // m/s, from the marker it is running at; 0 = none
  jumpHeld: boolean;      // the ollie button is down (the charge is building)
  resetPending: boolean;  // out of play: the course reset fires on the next step
  inWarp: boolean;        // ...and the reset's own teleport must not re-arm it (see courseReset)
  resets: number;         // how many times it has been put back on the course
  model: RideModel;
  pose: RiderPose;
  keys: RideKeys;         // synthesized, never touched by a device
  stick: { active: boolean; x: number };
}

/** The identity a prop carries into the effect runtime, so a contact can be matched against `resetVolumes`.
 *  Must read exactly as reference-effects' `runtimeObjectKey` writes it — the two sides meet only on this string. */
const objectKey = (object: RideObstacleObject): string =>
  object.kind === 'reference' ? `reference:${object.index}` : `authored:${object.id}`;

/** Signed angle in the ground plane. Every bearing below — to a rival, along a path, of a rider's facing — is
 *  this same convention, so only their *differences* are ever used and the world's chirality cannot flip a sign. */
function bearing(dx: number, dz: number): number { return Math.atan2(dz, dx); }
/** Wrap to (−π, π] — the engine wraps every bearing difference exactly here. */
function wrapPi(a: number): number {
  const t = (a + Math.PI) % (2 * Math.PI);
  return (t < 0 ? t + 2 * Math.PI : t) - Math.PI;
}

export function createAiRiders(o: AiRidersOpts) {
  const rng = o.rng ?? mulberry32(0x5105e); // a field rides the same way twice unless the caller says otherwise
  // The network, arc-length tabled once: several riders share a path, and the chooser projects onto all of them.
  const net: AiPath[] = [];
  const netIndex: number[] = []; // net[j] came from o.paths[netIndex[j]] — so `starts` still resolves after culls
  for (let i = 0; i < o.paths.length; i++) {
    const src = o.paths[i], pts = src.points;
    if (pts.length < 2) continue;
    const cum = new Float64Array(pts.length);
    const flat = new Float64Array(Math.max(1, pts.length - 1));
    for (let k = 1; k < pts.length; k++) {
      const dx = pts[k].x - pts[k - 1].x, dz = pts[k].z - pts[k - 1].z;
      flat[k - 1] = dx * dx + dz * dz;
      cum[k] = cum[k - 1] + Math.sqrt(flat[k - 1]); // horizontal: the climb is not arc (see AiPath)
    }
    const total = cum[pts.length - 1];
    if (total < 1) continue;
    net.push({
      pts, cum, flat, total,
      rating: src.rating,
      respawnable: src.respawnable !== false,
      markers: (src.markers ?? []).slice().sort((a, b) => a.arc - b.arc),
    });
    netIndex.push(i);
  }
  const fromSource = new Map(netIndex.map((src, j) => [src, j]));

  const riders: AiRider[] = [];
  const tmpA = new THREE.Vector3(); const tmpB = new THREE.Vector3(); const seg = new THREE.Vector3();
  const target = new THREE.Vector3(); const tan = new THREE.Vector3(); const candTarget = new THREE.Vector3();
  const closest = new THREE.Vector3(); const fwdN = new THREE.Vector3(); const right = new THREE.Vector3();
  const toTarget = new THREE.Vector3(); const push = new THREE.Vector3();
  const aiRideTmp = new THREE.Vector3(); // the rider's ridden direction, rebuilt per query — never retained
  // The reset's query point needs its own vector: `project3` uses tmpA/tmpB as scratch, so handing it one of
  // those as the point to search FROM silently shreds it on the first segment.
  const aim = new THREE.Vector3();
  const lostAt = new THREE.Vector3();

  // ---- the tracker ----

  /**
   * Where the rider is on its line, and where it is aiming. Three details here are the whole difference between a
   * field that rides a mountain and a field that spins in circles under it — all three are the engine's, and none
   * is something you would invent:
   *
   * **The arc is HORIZONTAL** — see `AiPath`. Everything below counts distance along the ground, never up it.
   *
   * **The projection is HORIZONTAL.** The closest-point search, the perpendicular distance and the path heading
   * all drop the vertical component (the engine's `perpDist² = dx² + dy²`, no `dz²`). So a rider sailing over a
   * jump — or one that *missed* the jump and is twenty metres below the line that arcs over it — is, as far as the
   * tracker is concerned, still ON its path: small perp, arc still advancing, lookahead still pulling it
   * down-course. Measure that perp in 3-D instead and the rider decides it is hopelessly off-line, re-chooses its
   * path every second, and orbits below the jump forever. (Only the path *chooser* measures in 3-D, which is what
   * stops a rider selecting a line that flies overhead.)
   *
   * **The arc is FORWARD-ONLY.** The search resumes at the cached segment and runs forward at most one window,
   * stopping at the first segment whose foot is interior. The projection therefore cannot rewind onto an earlier
   * part of the line, so a rider that doubles back cannot re-latch behind itself and loop. The cache is dropped
   * (−1 ⇒ full re-scan) exactly when the rider's path changes.
   */
  function track(r: AiRider) {
    const p = net[r.path], pos = r.model.st.pos;
    const cached = r.seg >= 0;
    const limit = cached ? r.arc + TRACK_WINDOW : Infinity;
    let bestD = Infinity, bestArc = cached ? r.arc : 0, bestSeg = cached ? r.seg : 0;
    for (let k = cached ? r.seg : 0; k + 1 < p.pts.length; k++) {
      if (p.cum[k] > limit) break;
      const a = p.pts[k], len2 = p.flat[k];
      if (len2 < 1e-9) continue;
      const dx = p.pts[k + 1].x - a.x, dz = p.pts[k + 1].z - a.z;
      const t = clamp(((pos.x - a.x) * dx + (pos.z - a.z) * dz) / len2, 0, 1);
      const fx = pos.x - (a.x + dx * t), fz = pos.z - (a.z + dz * t);
      const d = fx * fx + fz * fz; // horizontal, and only horizontal
      if (d < bestD) {
        bestD = d; bestSeg = k;
        bestArc = p.cum[k] + t * (p.cum[k + 1] - p.cum[k]);
      }
      if (cached && t > 0 && t < 1) break; // the foot lies inside this segment: the engine stops looking
    }
    r.seg = bestSeg;
    r.prevArc = r.arc;
    r.arc = bestArc;
    r.perp = Math.sqrt(bestD);
  }

  /** Position (and unit tangent) at HORIZONTAL arc `s` along a path, clamped to its ends. The point that comes
   *  back is the real 3-D one — only the ruler `s` is measured in plan view (a segment is straight, so the
   *  fraction along it is the same whichever way you measure). */
  function sample(p: AiPath, s: number, outPos: THREE.Vector3, outTan: THREE.Vector3) {
    const t = clamp(s, 0, p.total);
    let lo = 0, hi = p.pts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (p.cum[mid] <= t) lo = mid; else hi = mid; }
    const span = Math.max(1e-9, p.cum[hi] - p.cum[lo]);
    outPos.lerpVectors(p.pts[lo], p.pts[hi], (t - p.cum[lo]) / span);
    outTan.copy(p.pts[hi]).sub(p.pts[lo]).normalize();
  }

  /** Closest point on a path in FULL 3-D, scanning all of it — what the path *chooser* and the course reset ask
   *  (unlike the tracker, which is horizontal and windowed). A line that arcs overhead is far away to this, which
   *  is what stops a rider picking a line that flies over its head. The *distance* is 3-D; the arc it reports is
   *  still the path's own horizontal one (on a straight segment the fraction along is the same either way). */
  function project3(p: AiPath, pos: THREE.Vector3): { arc: number; dist: number } {
    let bestD = Infinity, bestArc = 0;
    for (let k = 0; k + 1 < p.pts.length; k++) {
      const a = p.pts[k], b = p.pts[k + 1];
      seg.copy(b).sub(a);
      const len2 = seg.lengthSq();
      if (len2 < 1e-9) continue;
      const t = clamp(tmpA.copy(pos).sub(a).dot(seg) / len2, 0, 1);
      const d = tmpB.copy(a).addScaledVector(seg, t).distanceToSquared(pos);
      if (d < bestD) { bestD = d; bestArc = p.cum[k] + t * (p.cum[k + 1] - p.cum[k]); }
    }
    return { arc: bestArc, dist: Math.sqrt(bestD) };
  }

  // ---- the path chain ----

  /**
   * The rider's mood, 0–100: which *kind* of line it wants right now. The engine reads race placement, the boost
   * meter and a skill-weighted dice roll ([Trailmap: 395]). We have the placement and the roll; a test ride has
   * no boost meter, so that input is simply missing. Leading, a rider wants the safe fast line; last, it gambles
   * on the daring one; in between it takes the default. Then the roll: a rider only *commits* to that mood with
   * odds equal to its skill — lose it and it falls back to the safe 50.
   */
  function mood(r: AiRider): number {
    if (!haveRuler || board.length < 2) return 50;
    const last = board.length - 1;
    const want = r.place === 0 ? 0 : r.place === last ? 100 : 50;
    return rng() < clamp(r.skill / SKILL_COMMIT_DIV, 0, 1) ? want : 50;
  }

  /**
   * The best line to be riding from `pos`, for someone whose mood is `want` ([Trailmap: 395]). Candidates are the
   * nearest few *in full 3-D*; any that is itself about to run out is no use to anybody, and `exclude` drops the
   * incumbent when the caller is deliberately advancing off it. Lowest score wins: near the point and pointing
   * where it is going, minus a bonus for how well the line's rating matches the mood — worth ~15 m of geometry at
   * a perfect match, enough to pull a rider onto a line it is not currently nearest to. That bonus is the entire
   * reason a level ships ninety overlapping paths.
   */
  function bestPathFrom(pos: THREE.Vector3, want: number, exclude = -1): { path: number; arc: number } | null {
    const near: { i: number; arc: number; dist: number }[] = [];
    for (let i = 0; i < net.length; i++) {
      if (i === exclude) continue;
      const { arc, dist } = project3(net[i], pos);
      if (net[i].total - arc < END_MARGIN) continue; // already at ITS end: no use to anyone
      near.push({ i, arc, dist });
    }
    if (!near.length) return null;
    near.sort((a, b) => a.dist - b.dist);
    near.length = Math.min(near.length, CANDIDATES);

    let best = -1, bestScore = Infinity, bestArc = 0;
    for (const c of near) {
      sample(net[c.i], c.arc + LOOKAHEAD, candTarget, tan);
      const score = c.dist * c.dist + candTarget.distanceToSquared(pos)
        - (100 - Math.abs(net[c.i].rating - want)) * RATING_WEIGHT;
      if (score < bestScore) { bestScore = score; best = c.i; bestArc = c.arc; }
    }
    return best < 0 ? null : { path: best, arc: bestArc };
  }

  /** Move this rider onto the best line from where it is now. When *advancing* the incumbent is excluded — that
   *  is the whole point of the hand-off. */
  function choosePath(r: AiRider, advancing: boolean): boolean {
    const pick = bestPathFrom(r.model.st.pos, mood(r), advancing ? r.path : -1);
    if (!pick) return false;
    setPath(r, pick.path, pick.arc);
    return true;
  }

  /**
   * Has this rider's line flown away and left it standing on the snow? **OURS — the engine has no such test**, and
   * why it can do without one is worth writing down, because it is also why we cannot.
   *
   * Everything the engine uses to decide "am I still on my line" is horizontal: the perp it re-chooses on
   * (`OFF_PATH`) throws away the vertical component, so a rider directly underneath its own path reads as dead on
   * it, however far below it has ended up. That is deliberate, and it is exactly what lets a rider *fly* its line
   * over a jump. But it leaves the engine blind to the other case — a rider that **missed** the jump and is now on
   * the snow with its line fifty metres over its head — and in that state the steering itself breaks. The pursuit
   * target is projected into the rider's **board plane**, and once the target is more than about `cot(slope)` times
   * higher than it is far ahead, that projection comes out pointing *backwards*. The rider turns to chase a point
   * above and behind it, and the turn sustains itself, because going round in a circle holds its own projection
   * still, so the target never moves on. Donuts under the jump.
   *
   * The engine never gets there: its riders take the jump, because the marker telling them to is authored and it
   * fires where the data says. Ours do too — but one knocked off the lip by a rival still has to get down the
   * mountain, and Garibaldi is unforgiving here: **51 of its 90 AI paths fly more than 15 m over solid, standable
   * snow**, one of them by 101 m.
   *
   * So the test is the pathology itself, not a proxy for it: if the target this rider is steering at lies *behind*
   * it in the very plane it steers in, no stick input can ever take it there, and that line is not its line any
   * more. Then it re-chooses — on the engine's own once-a-second cadence, through the engine's own chooser, which
   * measures in 3-D and will hand it the ground-level line running underneath the one that flew away. Only the
   * trigger is new. Airborne riders are exempt: one sailing over a jump is far from the *snow*, not from its line.
   */
  function lostUnderLine(r: AiRider): boolean {
    if (!r.model.st.grounded) return false;
    sample(net[r.path], r.arc + LOOKAHEAD, lostAt, tan);
    return Math.abs(bearingErr(r, lostAt)) > Math.PI / 2;
  }

  /** Move a rider onto a path. The tracker cache MUST be dropped with it — a segment index means nothing on a
   *  line it did not come from, and keeping it is how a rider ends up projected onto the wrong end of its line. */
  function setPath(r: AiRider, path: number, arc: number) {
    r.path = path;
    r.arc = arc;
    r.prevArc = arc;
    r.seg = -1;
    r.sinceChoice = 0;
  }

  // ---- the course reset ----

  /**
   * The engine's out-of-play reset ([Trailmap: 395]). A rider that has fallen out of the world is not nudged: it
   * is **warped**, onto the nearest **respawnable** path, at a point as far down the course as the rest of the
   * field has got, facing down-course and already moving at `RESET_SPEED`. The respawnable flag exists for exactly
   * this and gates nothing else — a rider may ride any line it likes, but it can only be *put back* on a line the
   * level's author marked as safe to be put back on.
   *
   * `delta` is the engine's rubber-band placement: how far ahead of where the rider fell the pack has got, never
   * negative — so a reset never costs you ground you had already made.
   */
  function courseReset(r: AiRider) {
    // The warp goes through the model's respawn, which is also what ARMS a reset — so it must not arm this one
    // again, or a reset rider resets forever and never rides a metre.
    r.inWarp = true;
    r.resetPending = false;
    r.resets++;
    const others = board.filter(b => b.rider !== r);
    const mean = others.length ? others.reduce((s, b) => s + b.progress, 0) / others.length : r.progress;
    const delta = Math.max(0, mean - r.progress);

    sample(net[r.path], r.arc + delta, aim, tan); // where down the course the field is by now
    let best = -1, bestScore = Infinity, bestArc = 0;
    const near: { i: number; arc: number; dist: number }[] = [];
    for (let i = 0; i < net.length; i++) {
      if (!net[i].respawnable) continue; // the whole point of the flag
      const { arc, dist } = project3(net[i], aim);
      near.push({ i, arc, dist });
    }
    // A network with nothing to be put back on: fall back to the rider's own gate.
    if (!near.length) { r.model.respawn(); r.inWarp = false; return; }
    near.sort((a, b) => a.dist - b.dist);
    near.length = Math.min(near.length, CANDIDATES);
    for (const c of near) {
      sample(net[c.i], c.arc + LOOKAHEAD, candTarget, tan);
      const score = c.dist * c.dist + candTarget.distanceToSquared(aim);
      if (score < bestScore) { bestScore = score; best = c.i; bestArc = c.arc; }
    }
    setPath(r, best, bestArc);
    sample(net[best], bestArc, closest, tan);
    r.model.warpTo(closest, tan, RESET_SPEED);
    r.timeScale = 1;
    r.state = 'cruise';
    r.rival = -1;
    r.jumpHeld = false;
    r.inWarp = false;
  }

  // ---- the field, and who is racing whom ----

  /** How many riders may be out at once. The gates fill the field first; a hand-placed rider takes the next free
   *  slot and, once there is none, recycles the oldest — every rider is a whole physics board, so a click has to
   *  cost a rider, not add one forever. */
  let max = Math.max(0, Math.floor(o.maxRiders ?? Math.max(1, o.starts.length)));
  let born = 0;
  let visible = true;

  /**
   * One rider: the same ride model the player gets, its drawn board, and the synthesized stick that is the only
   * thing the AI actually supplies. `slot` is its index in the field and decides nothing but its character and
   * topsheet tint; `pos` / `fwd` are where it is put down and which way it is pointing.
   */
  function makeRider(slot: number, path: number, arc: number, pos: THREE.Vector3, fwd: THREE.Vector3): AiRider {
    const keys: RideKeys = { left: false, right: false, tuck: false, brake: false, boost: false };
    const stick = { active: true, x: 0 }; // always "held": the AI's stick is the only input this rider has
    const who = CHARACTERS[slot % CHARACTERS.length];
    const r: AiRider = {
      born: born++,
      home: path, path, arc, prevArc: arc, seg: -1, perp: 0, sinceChoice: 0,
      skills: who.skill, skill: who.skill[0],
      progress: 0, place: 0, refProgress: 0, refAhead: false,
      timeScale: 1, state: 'cruise', rival: -1, targetSpeed: 0, jumpHeld: false, resetPending: false, inWarp: false,
      resets: 0, keys, stick,
      pose: createRiderPose({
        scene: o.scene, tint: TINTS[slot % TINTS.length],
        riderModel: o.riderModel, riderStyle: o.riderStyle, gear: o.gear,
        snowboardStance: o.snowboardStance,
      }),
      model: createRideModel({
        spawn: pos.clone(),
        heading: fwd.clone(),
        terrain: o.terrain, surfaceOf: o.surfaceOf, patchContact: o.patchContact, rails: o.rails,
        obstacles: o.obstacles, boostVolumes: o.boostVolumes,
        crackedSurfaces: o.crackedSurfaces,
        onCrackedChange: (key, cracked) => o.onCrackedChange?.(riders.indexOf(r), key, cracked),
        onCrackedBreak: key => o.onCrackedBreak?.(riders.indexOf(r), key),
        onObstacleHit: o.resetVolumes?.size || o.onPropCollision ? hit => {
          // The level's own boundary, arming the same course reset the out-of-bounds floor does...
          if (o.resetVolumes?.has(objectKey(hit.object))) r.resetPending = true;
          // ...and the contact itself, which is what runs the prop's collision graph for this rider.
          o.onPropCollision?.(riders.indexOf(r), hit);
        } : undefined,
        // Its own lap countdown over the shared course line: the gate on the lap-gated volume is per rider.
        course: o.course, finish: o.finish, laps: o.laps,
        onLap: remaining => o.onLap?.(riders.indexOf(r), remaining),
        oobFloorY: o.oobFloorY, keys, stick,
        carryBack: false, // the field's own reset places this rider, and it is armed by the plain respawn below
        drive: riderDrive(who.speed), // its speed statistic: this is the board it rides, and they differ
        // The model respawns itself when the rider leaves the world (the out-of-bounds floor, a reset surface).
        // That is exactly the engine's out-of-play condition, so it arms the course reset: the rider is put back
        // on a respawnable path with the field, not dropped at the top of its own start gate.
        onRespawn: () => { if (!r.inWarp) r.resetPending = true; r.seg = -1; r.jumpHeld = false; },
      }),
    };
    r.model.start();
    r.resetPending = false; // the spawn itself is not a reset
    r.pose.update(r.model.st, 0, r.keys); // seat the board before the first render, not at the world origin
    r.pose.setVisible(visible);
    return r;
  }

  /** The rider that has been out on the mountain longest — the one a full field recycles. */
  function oldest(): number {
    let slot = 0;
    for (let i = 1; i < riders.length; i++) if (riders[i].born < riders[slot].born) slot = i;
    return slot;
  }

  for (const src of o.starts) {
    if (riders.length >= max) break;
    const home = fromSource.get(src);
    if (home === undefined) continue;
    const p = net[home];
    riders.push(makeRider(riders.length, home, 0, p.pts[0], tmpA.copy(p.pts[1]).sub(p.pts[0]).normalize()));
  }

  /**
   * Drop a rider at `pos` and let it go (docs/016) — **OURS**: the engine seeds a field at the gates and never
   * needed anything else, but an author working on one pitch needs a rider *there*, not at the top of the
   * mountain. What lands is an ordinary member of the field from its first frame: it takes the best line from
   * where it was put down — through the same 3-D chooser a shoved rider re-chooses with, at a neutral mood, since
   * a rider that has not raced yet has no placement to have an opinion from — and sets off along that line. So
   * what you are watching is the real controller on the real terrain, which is the whole point of being able to
   * put one anywhere.
   *
   * A full field recycles its oldest rider into the new spot. False when the mountain has no AI network at all —
   * there is no line for a rider to follow, and one dropped without a line would just stand there.
   */
  function spawnAt(pos: THREE.Vector3, initialSpeed = 0, initialHeading?: THREE.Vector3): boolean {
    if (max === 0) return false;
    const pick = bestPathFrom(pos, 50);
    if (!pick) return false;
    sample(net[pick.path], pick.arc, closest, tan); // the line's heading where it was dropped: it starts down-course
    const heading = initialHeading?.lengthSq() ? initialHeading.clone().normalize() : tan;
    if (riders.length < max) {
      const rider = makeRider(riders.length, pick.path, pick.arc, pos, heading);
      if (initialSpeed > 0) {
        rider.inWarp = true; rider.model.warpTo(pos, heading, initialSpeed); rider.inWarp = false;
        if (initialHeading?.lengthSq()) rider.model.st.vel.copy(heading).multiplyScalar(initialSpeed);
        rider.resetPending = false;
      }
      riders.push(rider);
      return true;
    }
    const slot = oldest();
    riders[slot].pose.dispose();
    const rider = makeRider(slot, pick.path, pick.arc, pos, heading);
    if (initialSpeed > 0) {
      rider.inWarp = true; rider.model.warpTo(pos, heading, initialSpeed); rider.inWarp = false;
      if (initialHeading?.lengthSq()) rider.model.st.vel.copy(heading).multiplyScalar(initialSpeed);
      rider.resetPending = false;
    }
    riders[slot] = rider;
    for (const r of riders) if (r.rival === slot) r.rival = -1; // that slot holds a different rider now
    return true;
  }

  /** Re-cap the field. Zero retires everybody and disables new drops; lowering retires the oldest first. */
  function setMax(n: number) {
    max = Math.max(0, Math.floor(n));
    while (riders.length > max) {
      const slot = oldest();
      riders[slot].pose.dispose();
      riders.splice(slot, 1);
      for (const r of riders) r.rival = -1; // the splice shifted every index above it
    }
  }

  /** Restance the whole field, live. Riders spawned later pick it up from `o`, and no pose update is needed —
   *  each rider's own frame loop crosses it into the body. */
  function setRiderStyle(styleId: string) {
    o.riderStyle = styleId;
    for (const r of riders) r.pose.setRiderStyle(styleId);
  }

  /** Hot-swap every visible character without rebuilding its board, controller, race state or physics model. */
  function setRiderModel(modelId: string) {
    o.riderModel = modelId;
    for (const r of riders) {
      r.pose.setRiderModel(modelId);
      r.pose.update(r.model.st, 0, r.keys, r.model.renderState());
    }
  }

  /** Re-kit the whole field, live. Deck and body are rebuilt per rider; the controller, race state and physics
   *  model are not touched, so a field switched mid-race keeps every place it has earned. */
  function setGear(gear: RideGear) {
    o.gear = gear;
    for (const r of riders) {
      r.pose.setGear(gear);
      r.model.st.riderSeated = false;
      r.pose.update(r.model.st, 0, r.keys, r.model.renderState());
    }
  }

  /** Mirror every snowboard body and binding set live; retained while the field is on skis. */
  function setSnowboardStance(stance: SnowboardStance) {
    o.snowboardStance = stance;
    for (const r of riders) {
      r.pose.setSnowboardStance(stance);
      r.model.st.riderSeated = false;
      r.pose.update(r.model.st, 0, r.keys, r.model.renderState());
    }
  }

  /** Stand a prebuilt field out of sight until its run starts, without throwing away any of its ride models. */
  function setVisible(next: boolean) {
    visible = next;
    for (const r of riders) r.pose.setVisible(next);
  }

  // ---- the course ruler: one arc-length line every competitor's progress is measured on ----
  const rulerCum = new Float64Array(o.course?.length ?? 0);
  if (o.course) for (let k = 1; k < o.course.length; k++) {
    rulerCum[k] = rulerCum[k - 1] + o.course[k].distanceTo(o.course[k - 1]);
  }
  const haveRuler = !!o.course && o.course.length >= 2;

  /** How far down the course a point is: arc length of its closest-point projection onto the spine. */
  function progressOf(pos: THREE.Vector3): number {
    if (!haveRuler) return 0;
    const line = o.course!;
    let bestD = Infinity, bestS = 0;
    for (let k = 0; k + 1 < line.length; k++) {
      const a = line[k], b = line[k + 1];
      seg.copy(b).sub(a);
      const len2 = seg.lengthSq();
      if (len2 < 1e-9) continue;
      const t = clamp(tmpA.copy(pos).sub(a).dot(seg) / len2, 0, 1);
      const d = tmpB.copy(a).addScaledVector(seg, t).distanceToSquared(pos);
      if (d < bestD) { bestD = d; bestS = rulerCum[k] + t * Math.sqrt(len2); }
    }
    return bestS;
  }

  /**
   * The standings pass ([Trailmap: 395]). Sort every competitor — the player included — by progress down the
   * course, hand each rider its **placement** and, as its catch-up reference, the competitor *immediately ahead
   * of it*; the leader references the runner-up instead, which is what slows a runaway leader. The result is a
   * ladder: each rider paces the one in front of it, and the field strings out instead of piling onto whoever
   * everybody is banded to.
   */
  const board: { progress: number; rider: AiRider | null }[] = [];
  function standings() {
    if (!haveRuler) return;
    board.length = 0;
    for (const r of riders) {
      r.progress = progressOf(r.model.st.pos);
      board.push({ progress: r.progress, rider: r });
    }
    if (o.player) board.push({ progress: progressOf(o.player.pos), rider: null });
    board.sort((a, b) => b.progress - a.progress); // furthest down the course leads
    for (let i = 0; i < board.length; i++) {
      const r = board[i].rider;
      if (!r) continue;
      const ref = i === 0 ? board[1] : board[i - 1]; // the leader paces the runner-up; everyone else the one ahead
      r.place = i;
      r.refProgress = ref ? ref.progress : r.progress;
      r.refAhead = i > 0;
    }
  }

  /**
   * Acquire (or drop) the competitor this rider is reacting to ([Trailmap: 395]). The engine keeps a pairwise
   * table of every rider's distance and bearing to every other and re-scores this every 12th frame: take anyone
   * within `RIVAL_ACQUIRE`, score them by distance weighted *against* how far off the nose they are — so the one
   * straight ahead wins over a nearer one off to the side — and drop the rival once it is past `RIVAL_DROP` or
   * once this rider is too far off its own line to be racing anybody.
   *
   * This is the machinery a field needs to stop riding in single file, and it is the piece I had missing.
   */
  function pickRival(r: AiRider) {
    const st = r.model.st;
    if (r.rival >= 0) {
      const cur = riders[r.rival];
      const d = Math.hypot(cur.model.st.pos.x - st.pos.x, cur.model.st.pos.z - st.pos.z);
      if (d > RIVAL_DROP || r.perp > RIVAL_DROP_OFF) r.rival = -1;
    }
    if (r.perp >= RIVAL_HOLD_OFF) { r.rival = -1; return; }
    // "In front of it" is the direction the rider is travelling, which on a rider knocked switch is the tail.
    const ride = rideForward(st, aiRideTmp);
    const face = bearing(ride.x, ride.z);
    let best = -1, bestScore = Infinity;
    for (let i = 0; i < riders.length; i++) {
      if (riders[i] === r) continue;
      const other = riders[i].model.st.pos;
      const dx = other.x - st.pos.x, dz = other.z - st.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > RIVAL_ACQUIRE) continue;
      // Not "attackable" in a race (the engine gates that on the game mode), so the weight is 1 − cos(off-nose):
      // zero straight ahead, 2 directly behind. A rider reacts to what is in front of it.
      const off = wrapPi(bearing(dx, dz) - face);
      const score = dist * (1 - Math.cos(off));
      if (score < bestScore) { bestScore = score; best = i; }
    }
    if (best >= 0) r.rival = best;
  }

  // ---- the four behaviours ----

  /**
   * The steering law: the signed bearing error from the board's facing to the pursuit target, pressed into the
   * stick proportionally. The engine takes this error in the rider's **board plane** — it projects the board's own
   * up out of the delta first — which is why a target far above or below the rider still reads as a bearing to the
   * side rather than a huge error.
   *
   * `right` is defined as *the way a +1 stick actually turns the board*, the only definition that cannot be off by
   * a sign: our physics negates the stick and yaws `fwd` about the contact normal, so a +1 stick moves the facing
   * toward `fwd × up`. Steering into a positive bearing error is then the same press the D key makes.
   */
  function bearingErr(r: AiRider, aim: THREE.Vector3): number {
    const st = r.model.st;
    const up = st.boardUp.lengthSq() > 1e-6 ? st.boardUp : WORLD_UP;
    // The RIDDEN end, not the drawn nose: the carve yaws that one, so a rider who came out of a crash switch
    // steers toward its aim instead of away from it (docs/016).
    projectOnPlane(rideForward(st, aiRideTmp), up, fwdN);
    if (fwdN.lengthSq() < 1e-6) return 0;
    fwdN.normalize();
    right.crossVectors(fwdN, up).normalize();
    projectOnPlane(toTarget.copy(aim).sub(st.pos), up, toTarget);
    if (toTarget.lengthSq() < 1e-6) return 0;
    return Math.atan2(toTarget.dot(right), toTarget.dot(fwdN));
  }

  function steerTo(r: AiRider, aim: THREE.Vector3): number {
    const err = bearingErr(r, aim);
    const mag = Math.abs(err) * STEER_GAIN * r.skill;
    if (mag < STEER_DEADBAND) return 0;
    return Math.sign(err) * Math.min(mag, STEER_CLAMP);
  }

  /** The jump marker the rider is running at, if any: the engine queries its path for type-25 items in the arc
   *  window `[lastFrameArc, arc + window]`, so a marker cannot be stepped over however fast the rider is going. */
  function markerIn(r: AiRider, window: number): AiPathMarker | null {
    const p = net[r.path], lo = Math.min(r.prevArc, r.arc), hi = r.arc + window;
    for (const m of p.markers) {
      if (m.arc < lo) continue;
      if (m.arc > hi) break;
      return m;
    }
    return null;
  }

  /**
   * The behaviour machine ([Trailmap: 395]) — four states, and every one of them ends by steering somewhere.
   *
   * **approach** — a jump marker is in range. This is where the AI's ollie comes from, and it is entirely
   * authored: press the button when the marker is still ahead, the rider is within `MARKER_PERP` of its line and
   * it is going straight (a rider does not jump mid-carve); hold it while the marker stays inside the tighter
   * window, so the charge builds over the last half-metre and releases as the rider crosses the lip. Boost if it
   * is under the marker's target speed, brake if it is well over.
   *
   * **avoid** — a rival is in the way. The "in the way" test is a cone of `atan(clearance / distance)`, which
   * *widens as you close* (≈12° at 7 m, 45° at 1.5 m). The swerve is not a nudge on the stick: the whole pursuit
   * vector is rotated in yaw around the rival, so the rider aims *past* it and carves there properly. And it only
   * swerves if it is **faster** than the rival — a slower rider holds its line and eats the block, which is why
   * real SSX traffic bunches and shoves rather than politely parting.
   *
   * **cruise** — nothing in the way: ride the line.
   */
  function behave(r: AiRider) {
    const st = r.model.st;
    const p = net[r.path];
    r.keys.boost = false; r.keys.brake = false;

    // Aim: the pursuit target is a point ON the line, LOOKAHEAD of arc further along. Nothing displaces it
    // sideways — the engine has no per-rider "lane", which is worth stating because it is the obvious thing to
    // invent and it is wrong: a field spreads because riders react to each other, not because they aim wide.
    sample(p, r.arc + LOOKAHEAD, target, tan);
    const pathHeading = bearing(target.x - st.pos.x, target.z - st.pos.z);

    const marker = markerIn(r, MARKER_AHEAD);
    if (marker) {
      r.state = 'approach';
      r.targetSpeed = marker.speed;
      r.stick.x = steerTo(r, target);
      const speed = st.vel.length();
      const ahead = marker.arc >= r.arc;
      if (ahead && r.perp < MARKER_PERP && Math.abs(r.stick.x) < MARKER_STEER && !r.jumpHeld) {
        r.model.ollieDown(); // press: the charge starts here, ~3 m out
        r.jumpHeld = true;
      }
      if (marker.speed > 0 && speed < marker.speed - SPEED_SLOP) r.keys.boost = true;
      if (marker.speed > 0 && speed > marker.speed + SPEED_SLOP) r.keys.brake = true;
    } else {
      r.targetSpeed = 0;
      const rival = r.rival >= 0 ? riders[r.rival] : null;
      const rst = rival?.model.st;
      if (rst) {
        const dx = rst.pos.x - st.pos.x, dz = rst.pos.z - st.pos.z;
        const dist = Math.max(0.01, Math.hypot(dx, dz));
        const off = wrapPi(bearing(dx, dz) - pathHeading); // where the rival sits relative to where I'm going
        const halfWidth = Math.atan(AVOID_CLEAR / dist);
        const mySpeed = st.vel.length(), itsSpeed = rst.vel.length();
        if (Math.abs(off) > halfWidth || mySpeed <= itsSpeed) {
          r.state = 'cruise'; // not in my way, or I can't get past it: hold the line and take the block
          r.stick.x = steerTo(r, target);
        } else {
          r.state = 'avoid';
          // Rotate the pursuit vector away from the rival by the angle that clears its disc. (The engine's two
          // sides are not mirror images — `off - halfWidth` one way, `halfWidth - off` the other — which
          // over-swings one of them. That asymmetry is in the retail code; it is kept.)
          const theta = off > 0 ? off - halfWidth : halfWidth - off;
          toTarget.copy(target).sub(st.pos);
          toTarget.applyAxisAngle(WORLD_UP, -theta); // −θ: our +Y rotation runs against the atan2(z, x) convention
          r.stick.x = steerTo(r, tmpB.copy(st.pos).add(toTarget));
        }
      } else {
        r.state = 'cruise';
        r.stick.x = steerTo(r, target);
      }
    }

    // The charge releases the moment no marker is inside the tight window — i.e. as the rider crosses the lip.
    if (r.jumpHeld && !markerIn(r, MARKER_HOLD)) {
      r.model.ollieUp();
      r.jumpHeld = false;
    }
    // OURS, not the engine's: it drives a throttle axis this model's automatic cruise has no counterpart for, so
    // the tuck stands in — thin the drag down the straights, stand up to carve.
    r.keys.tuck = st.grounded && Math.abs(r.stick.x) < 0.25;
  }

  /**
   * The rubber band, as time dilation ([Trailmap: 395]). `gap` is this rider's along-course separation from **the
   * competitor it is banded to** — the one immediately ahead of it in the standings, not the player — so lateral
   * distance never counts and nobody is dragged toward a single point. Inside the band time runs normally; behind
   * it ramps up linearly, ahead it collapses to the floor almost at once (the engine's reciprocal is that abrupt;
   * the slew is what keeps it from showing).
   */
  function catchUp(r: AiRider, dt: number) {
    if (!haveRuler || board.length < 2) return;
    const gap = r.progress - r.refProgress; // + = this rider is ahead of the one it paces
    let f = 1;
    if (gap < -CATCHUP_BAND) f = ((gap + CATCHUP_BAND) / -CATCHUP_BAND + 1) * CATCHUP_BEHIND;
    else if (gap > CATCHUP_BAND) f = CATCHUP_AHEAD / (gap - CATCHUP_BAND);
    f = clamp(f, CATCHUP_MIN, CATCHUP_MAX);
    r.timeScale = moveTowards(r.timeScale, f, CATCHUP_SLEW * dt * 60);
  }

  /**
   * Bodies ([Trailmap: 395]): two riders that overlap are pushed apart, `BUMP_SPLIT` of the separation each. The
   * engine tests authored collision volumes, which we have no equivalent of, so the radius is ours — but the
   * response law is the engine's, and it matters more than it looks: without it a field can occupy the same metre
   * of snow, and the whole jostle of a pack disappears.
   */
  function bumps() {
    for (let i = 0; i < riders.length; i++) {
      for (let j = i + 1; j < riders.length; j++) {
        const a = riders[i].model.st.pos, b = riders[j].model.st.pos;
        const dx = b.x - a.x, dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        const min = BUMP_RADIUS * 2;
        if (d > min || Math.abs(b.y - a.y) > 2) continue; // side by side, not one flying over the other
        if (d < 1e-4) { push.set(1, 0, 0); } else { push.set(dx / d, 0, dz / d); }
        const sep = (min - d) * BUMP_SPLIT;
        a.addScaledVector(push, -sep);
        b.addScaledVector(push, sep);
      }
    }
  }

  let sinceStandings = Infinity, sinceSkill = Infinity, sinceRival = Infinity;

  function step(dt: number) {
    if (dt <= 0) return;

    // The engine re-sorts the field every 6th frame, re-picks each rider's skill every 60th and re-scores rivals
    // every 12th; the cadence is what stops a rider's reference (and so its time dilation) from chattering.
    sinceStandings += dt; sinceSkill += dt; sinceRival += dt;
    if (sinceStandings >= STANDINGS_EVERY) { standings(); sinceStandings = 0; }
    if (sinceSkill >= SKILL_SWITCH_EVERY) {
      // Two authored gains per rider: chasing sharpens it, leading its own duel relaxes it ([Trailmap: 395]).
      for (const r of riders) r.skill = r.refAhead ? r.skills[1] : r.skills[0];
      sinceSkill = 0;
    }
    const rescoreRivals = sinceRival >= RIVAL_EVERY;
    if (rescoreRivals) sinceRival = 0;

    for (const r of riders) {
      if (r.resetPending) { courseReset(r); continue; } // out of play: warped, and it rides again next frame
      r.sinceChoice += dt;

      track(r); // where am I on my line — horizontal, forward-only

      if (net[r.path].total - r.arc < END_MARGIN) {
        // The line ran out. Hand off to the next one; if the network has nothing left, this rider is at the
        // bottom of the mountain — put it back with the field so a long editing session keeps a field on it.
        if (!choosePath(r, true)) { courseReset(r); continue; }
      } else if (r.sinceChoice >= RECHOOSE_EVERY && (r.perp > OFF_PATH || lostUnderLine(r))) {
        // Shoved clean off the line — measured HORIZONTALLY, so being *under* it does not count, which is the
        // engine's rule and the whole reason a rider can fly its line over a jump. `lostUnderLine` is the one case
        // that rule cannot see and we have to: the line left without us. Either way, take the best line from here,
        // which may well be this one.
        choosePath(r, false);
      }

      if (rescoreRivals) pickRival(r);
      behave(r);
      catchUp(r, dt);
      r.model.step(dt * r.timeScale);
      r.pose.update(r.model.st, dt, r.keys, r.model.renderState()); // same anti-alias lerp as the player's board
    }
    bumps();
  }

  function dispose() {
    for (const r of riders) r.pose.dispose();
    riders.length = 0;
  }

  /** A shared pickup pop removes/re-arms the object for every rider's private collider snapshot. */
  function retireObstacle(key: string) { for (const r of riders) r.model.retireObstacle(key); }
  function restoreObstacle(key: string) { for (const r of riders) r.model.restoreObstacle(key); }

  /**
   * Apply an SSF graph's rider-directed action to the opponent that earned it ([Trailmap: 390-pickups-and-race]).
   * This is the same handful of commands the player's board takes (`ride/session.ts applyEffect`) — a boost pad
   * pushes an opponent exactly as hard, a reset volume puts it back, a teleport moves it — with the two SCORING
   * commands deliberately absent: a trick-boost window and a gem multiplier are consumed by a scoreboard, and an
   * AI rider has none. The cues stay with the player too: the pad hit and the gem chime are the sounds of *your*
   * pickup, played from the engine's own apply path, not a noise every rider on the mountain makes.
   */
  function applyEffect(slot: number, action: RideEffectAction) {
    const r = riders[slot];
    if (!r) return;
    switch (action.kind) {
      case 'speed-boost': r.model.applyPadBoost(action.amount); return;
      case 'reset': r.resetPending = true; return; // through the field's own warp, onto a respawnable line
      case 'teleport':
        r.model.warpTo(action.position, action.heading, Math.max(8, r.model.st.vel.length()));
        r.seg = -1; // the tracker cache means nothing on the line it lands beside
        return;
      case 'trick-boost': case 'score-multiplier': case 'hud-message': return;
    }
  }

  /** What the field is actually doing — the controller's own numbers, for the tests and for tracing a bad line. */
  function probe() {
    return riders.map(r => ({
      path: r.path, arc: r.arc, total: net[r.path].total, perp: r.perp, seg: r.seg,
      stick: r.stick.x, timeScale: r.timeScale, skill: r.skill,
      state: r.state, rival: r.rival, jumpHeld: r.jumpHeld, targetSpeed: r.targetSpeed, resets: r.resets,
      place: r.place, progress: r.progress, refProgress: r.refProgress, refAhead: r.refAhead,
      pos: r.model.st.pos, speed: r.model.st.vel.length(), velY: r.model.st.vel.y,
      boostRequest: r.model.padBoostSeconds,
      grounded: r.model.st.grounded,
      charging: r.model.st.charging, airTime: r.model.st.airTime,
      // Its own race, not the field's: which pass it is on, what the lap-gated volume reads, and whether it
      // has taken the flag ([Trailmap: 390-lap-counter]).
      lap: r.model.laps?.lap ?? 1, lapsRemaining: r.model.laps?.remaining ?? 0,
      finished: r.model.laps?.finished ?? false,
    }));
  }

  return {
    step, dispose, probe, spawnAt, setMax, setRiderModel, setRiderStyle, setGear, setSnowboardStance,
    setVisible, applyEffect,
    retireObstacle, restoreObstacle,
    get count() { return riders.length; },
  };
}

export type AiRiders = ReturnType<typeof createAiRiders>;
