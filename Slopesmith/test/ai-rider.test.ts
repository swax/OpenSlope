/**
 * The AI field ([Trailmap: 395]): the opponents are riders, and the AI is only their stick and buttons. This
 * drives the real `createAiRiders` over a synthetic slope and checks the things `tsc` cannot — the pursuit
 * controller's sign (a flipped one steers away from the line and diverges), S-bend tracking, the deadband, the
 * catch-up ladder, the line rating, and the four behaviours that were missing until the tracker was traced
 * properly: that a rider passing UNDER an airborne stretch of its own path keeps riding instead of circling
 * beneath it, that its arc never rewinds, that it ollies on a jump marker and only there, that rivals push a
 * field apart instead of letting it ride in single file, and that a fallen rider is put back on a RESPAWNABLE
 * path.
 *
 * Run: npx tsx test/ai-rider.test.ts
 */
import * as THREE from 'three';
import { createAiRiders, type AiPathMarker } from '../src/app/ride/ai';
import type { BoostVolume } from '../src/app/ride/boost-volumes';
import { createRideModel, riderDrive, type RideObstacleSource } from '../src/app/ride/physics';

let failures = 0;
function ok(cond: boolean, label: string, detail = '') {
  if (cond) console.log(`ok    ${label}${detail ? ` — ${detail}` : ''}`);
  else { failures++; console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`); }
}

// ---- terrain: a constant slope along +Z, wide enough to carve across ----
const D2R = Math.PI / 180;
const ZMAX = 400, ZSTEP = 4;
const surfaceOf = () => 1; // snow everywhere

/** A planar slope of `deg` degrees. Steepness matters: on a steep run gravity carries every rider past snow's
 *  14.4 m/s cruise target, so the drive — and with it the speed statistic — is idle; it only bites where a rider
 *  is still being driven UP to the target. Both regimes get ridden below. */
function makeSlope(deg: number, maxZ = ZMAX) {
  const M = -Math.tan(deg * D2R);
  const yOf = (z: number) => M * z;
  const nz = Math.floor(maxZ / ZSTEP);
  const XS: number[] = [];
  for (let x = -60; x <= 60; x += 5) XS.push(x);
  const positions: number[] = [];
  for (let iz = 0; iz <= nz; iz++) for (const x of XS) positions.push(x, yOf(iz * ZSTEP), iz * ZSTEP);
  const index: number[] = [];
  const W = XS.length;
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < W - 1; ix++) {
      const a = iz * W + ix, b = a + 1, c = a + W, d = c + 1;
      index.push(a, c, b, b, c, d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setIndex(index);
  const terrain = new THREE.Mesh(geo);
  terrain.updateMatrixWorld(true);
  return { terrain, yOf, oobFloorY: yOf(maxZ) - 100 };
}

const STEEP = makeSlope(12);
const terrain = STEEP.terrain;
const yOf = STEEP.yOf;
const oobFloorY = STEEP.oobFloorY;

// A race countdown freezes the physics, so its initial pose must be seated rather than left in the ordinary
// one-metre respawn drop. The saved respawn behavior remains unchanged after that one gate-only operation.
{
  const model = createRideModel({
    spawn: new THREE.Vector3(0, yOf(12), 12), heading: new THREE.Vector3(0, 0, 1),
    terrain, surfaceOf, oobFloorY,
    keys: { left: false, right: false, tuck: false, brake: false, boost: false },
    stick: { active: false, x: 0 }, onRespawn: () => {},
  });
  model.start();
  model.seatAtSpawn();
  ok(model.st.grounded && model.st.vel.lengthSq() === 0 && Math.abs(model.st.pos.y - yOf(model.st.pos.z)) < 0.05,
    'countdown gate seats a stationary rider at the snow rest depth');
  model.respawn();
  ok(!model.st.grounded && model.st.pos.y - yOf(model.st.pos.z) > 0.8,
    'countdown seating does not replace the ordinary respawn drop-in');
}

/** A path down the fall line, weaving `amp` metres either side with `waves` full swings. */
function path(amp: number, waves: number, h: (z: number) => number = yOf): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let z = 4; z <= ZMAX - 8; z += 4) {
    const x = amp * Math.sin((waves * 2 * Math.PI * z) / ZMAX);
    pts.push(new THREE.Vector3(x, h(z), z));
  }
  return pts;
}

/** A straight segment of the network: from `z0` to `z1`, offset `x` metres across the fall line. */
function seg(z0: number, z1: number, x = 0, h: (z: number) => number = yOf): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  for (let z = z0; z <= z1; z += 4) pts.push(new THREE.Vector3(x, h(z), z));
  return pts;
}

const line = (points: THREE.Vector3[], rating = 50) => ({ points, rating });
/** The two path fields the AI reads besides the points: where it may be put back, and where it jumps. */
type Def = { points: THREE.Vector3[]; rating: number; respawnable?: boolean; markers?: AiPathMarker[] };

/** Perpendicular distance from `p` to the polyline (the tracking error the controller is judged on). */
function lateral(pts: THREE.Vector3[], p: THREE.Vector3): number {
  let best = Infinity;
  const ab = new THREE.Vector3(), ap = new THREE.Vector3(), q = new THREE.Vector3();
  for (let k = 0; k + 1 < pts.length; k++) {
    ab.copy(pts[k + 1]).sub(pts[k]);
    const len2 = ab.lengthSq();
    if (len2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ap.copy(p).sub(pts[k]).dot(ab) / len2));
    best = Math.min(best, q.copy(pts[k]).addScaledVector(ab, t).distanceTo(p));
  }
  return best;
}

interface RunOpts {
  /** A pinned "player" position — a competitor the standings sort against, held still so the gap is the one we set. */
  player?: THREE.Vector3;
  /** Which paths riders are fielded on (default: just path 0). */
  starts?: number[];
  /** The progress ruler. Defaults to the straight fall line, which is the spine of every fixture here. */
  course?: THREE.Vector3[];
  /** Pin the mood's commit roll: 0 = always commit (what the rating tests want to isolate). */
  rng?: () => number;
  /** The slope to ride (default: the steep one). */
  slope?: ReturnType<typeof makeSlope>;
}

/** Run a field over `defs` for `seconds`; returns the last probe + per-rider error stats. */
function run(defs: Def[], seconds: number, opts: RunOpts = {}) {
  const paths = defs.map(d => d.points);
  const starts = opts.starts ?? [0];
  const player = opts.player;
  const { terrain, yOf: h, oobFloorY } = opts.slope ?? STEEP;
  const scene = new THREE.Group();
  const playerModel = player
    ? createRideModel({
      spawn: player, terrain, surfaceOf, oobFloorY,
      keys: { left: false, right: false, tuck: false, brake: false, boost: false },
      stick: { active: false, x: 0 }, onRespawn: () => {},
    })
    : null;
  playerModel?.start();
  if (playerModel) playerModel.st.pos.copy(player!);

  const field = createAiRiders({
    paths: defs, starts, terrain, scene, surfaceOf, oobFloorY, player: playerModel?.st,
    course: opts.course ?? seg(0, ZMAX, 0, h), rng: opts.rng,
  });
  const worst = starts.map(() => 0);
  const peakStick = starts.map(() => 0);
  const maxAir = starts.map(() => 0);
  const states = starts.map(() => new Set<string>());
  const pathsSeen = starts.map(() => new Set<number>());
  const prevSeg = starts.map(() => -1);
  const prevPath = starts.map(() => -1);
  // The forward-only property, as the engine actually states it: the projection resumes at a cached SEGMENT and
  // only ever scans forward, so on a path it is already on, a rider can never re-latch onto an earlier segment and
  // start going round. (The arc itself may dip a little — it is `cum[segment] + s`, and `s` shrinks if the rider
  // drifts back *within* the segment it is on. That is the engine's, and counting it as a rewind is a bad test.)
  let rewound = 0;
  let minSep = Infinity; // the closest two riders ever got (bodies must not occupy the same snow)
  let maxSpread = 0;     // the widest the field ever got ACROSS the line (a single-file field never fans out)
  // The frame a rider is put back on the course — the only frame the reset is visible, since it rides on from there.
  let postReset: { path: number; pos: THREE.Vector3 } | null = null;
  let sum = 0, n = 0;
  const H = 1 / 60;
  for (let t = 0; t < seconds; t += H) {
    field.step(H);
    if (playerModel) playerModel.st.pos.copy(player!); // held still, so the gap is the one we set
    const probe = field.probe();
    for (let i = 0; i < probe.length; i++) {
      if (probe[i].path === prevPath[i] && prevSeg[i] >= 0 && probe[i].seg >= 0 && probe[i].seg < prevSeg[i]) rewound++;
      prevSeg[i] = probe[i].seg; prevPath[i] = probe[i].path;
      states[i].add(probe[i].state);
      pathsSeen[i].add(probe[i].path);
      if (i === 0 && probe[i].resets > 0 && !postReset) postReset = { path: probe[i].path, pos: probe[i].pos.clone() };
      if (t < 1) continue; // the drop-in settles first — and it is a fall, so it must not count as air time
      maxAir[i] = Math.max(maxAir[i], probe[i].airTime);
      const e = lateral(paths[probe[i].path], probe[i].pos); // judged against the line it is CURRENTLY on
      worst[i] = Math.max(worst[i], e);
      peakStick[i] = Math.max(peakStick[i], Math.abs(probe[i].stick));
      sum += e; n++;
      for (let j = i + 1; j < probe.length; j++) {
        minSep = Math.min(minSep, Math.hypot(probe[i].pos.x - probe[j].pos.x, probe[i].pos.z - probe[j].pos.z));
      }
    }
    if (t >= 1 && probe.length > 1) {
      const xs = probe.map(p => p.pos.x);
      maxSpread = Math.max(maxSpread, Math.max(...xs) - Math.min(...xs));
    }
  }
  const probe = field.probe().map(p => ({ ...p, pos: p.pos.clone() }));
  field.dispose();
  return {
    probe, worst, peakStick, maxAir, states, pathsSeen, rewound, minSep, maxSpread, postReset,
    mean: n ? sum / n : 0,
  };
}

// ---- 1. a straight fall-line path: the rider descends it and the deadband keeps the stick centred ----
{
  const p = path(0, 0);
  const { probe, worst, peakStick } = run([line(p)], 12);
  const r = probe[0];
  ok(r.pos.z > 60, 'straight: the rider actually rides away from the gate', `z = ${r.pos.z.toFixed(1)} m`);
  ok(r.speed > 8, 'straight: it picks up speed under gravity', `${r.speed.toFixed(1)} m/s`);
  ok(worst[0] < 1.0, 'straight: it holds the line', `worst lateral ${worst[0].toFixed(2)} m`);
  ok(peakStick[0] === 0, 'straight: the deadband never presses the stick at all', `peak |stick| = ${peakStick[0]}`);
}

// ---- 2. an S-bend it has to carve: the pursuit controller tracks it (a flipped sign diverges instead) ----
{
  const p = path(25, 1.5);
  const { probe, worst, mean, peakStick } = run([line(p)], 20);
  const r = probe[0];
  ok(worst[0] < 8, 'S-bend: the controller tracks the line it has to carve for', `worst ${worst[0].toFixed(2)} m`);
  ok(mean < 3, 'S-bend: and sits on it on average', `mean ${mean.toFixed(2)} m`);
  ok(r.arc > 0.5 * r.total, 'S-bend: it gets down the course, not stuck in a circle',
    `${((100 * r.arc) / r.total).toFixed(0)}% of the path`);
  ok(peakStick[0] > 0.2, 'S-bend: and it carves the bends rather than coasting through them',
    `peak |stick| = ${peakStick[0].toFixed(3)}`);
}

// ---- 3. catch-up: time dilates toward the ceiling when behind the player, the floor when ahead ----
{
  const p = path(0, 0);
  // The reference rider is pinned 60 m DOWN-course of the gate, so the field starts far behind it.
  const behind = run([line(p)], 3, { player: new THREE.Vector3(0, yOf(60) + 1, 60) });
  ok(behind.probe[0].timeScale > 1.2, 'catch-up: a rider behind the player is given faster time',
    `timeScale = ${behind.probe[0].timeScale.toFixed(3)}`);

  // ...and pinned back at the gate, so the field (which rides away from it) is soon far ahead.
  const ahead = run([line(p)], 8, { player: new THREE.Vector3(0, yOf(2) + 1, 2) });
  ok(ahead.probe[0].timeScale < 0.8, 'catch-up: a rider ahead of the player is slowed down',
    `timeScale = ${ahead.probe[0].timeScale.toFixed(3)}`);
}

// ---- 4. the chain: a gate stub hands off to the network instead of stranding the rider at its end ----
{
  // The rider's gate line stops at 60 m — like a real level's ~350 m StartPosList stub. The network continues.
  const { probe } = run([line(seg(4, 60)), line(seg(50, ZMAX - 8))], 14);
  const r = probe[0];
  ok(r.path === 1, 'chain: the rider hands off to the next path at the end of its gate line', `on path ${r.path}`);
  ok(r.pos.z > 150, 'chain: and keeps riding down the mountain past where its gate line ended',
    `z = ${r.pos.z.toFixed(1)} m (gate ended at 60)`);
}

// ---- 5. the line rating: the hand-off picks the line whose rating matches the rider's mood ----
{
  // Two continuations of the same gate stub, side by side and equally near: one timid (0), one daring (100).
  // With the player pinned far DOWN-course the rider is trailing, so its mood is 100 and it should take that one.
  const gate = line(seg(4, 60));
  const timid = line(seg(50, ZMAX - 8, -6), 0);
  const daring = line(seg(50, ZMAX - 8, 6), 100);
  const trailing = run([gate, timid, daring], 10,
    { player: new THREE.Vector3(0, yOf(ZMAX - 20) + 1, ZMAX - 20), rng: () => 0 });
  ok(trailing.probe[0].path === 2, 'rating: a trailing rider (mood 100) takes the daring line, not the timid one',
    `on path ${trailing.probe[0].path} (2 = rating 100)`);

  // Swap the ratings over and the same rider must swap lines — proof it is the RATING deciding, not the geometry.
  const swapped = run([gate, line(seg(50, ZMAX - 8, -6), 100), line(seg(50, ZMAX - 8, 6), 0)], 10,
    { player: new THREE.Vector3(0, yOf(ZMAX - 20) + 1, ZMAX - 20), rng: () => 0 });
  ok(swapped.probe[0].path === 1, 'rating: swap the ratings and it takes the other line — the rating decides',
    `on path ${swapped.probe[0].path} (1 = rating 100)`);
}

// ---- 6. the ladder: a rider paces the competitor immediately AHEAD of it, not the player ----
{
  // Three riders down the same fall line, plus a player pinned at the bottom (so the player leads and every rider
  // is chasing). Each rider's reference must be the one directly in front of it in the standings, never one shared
  // target: banding a field against a single competitor is what collapses it into a clump.
  const p = path(0, 0);
  const { probe } = run([line(p)], 6,
    { starts: [0, 0, 0], player: new THREE.Vector3(0, yOf(ZMAX - 30) + 1, ZMAX - 30) });

  const places = probe.map(r => r.place).sort((a, b) => a - b);
  ok(places.join(',') === '1,2,3', 'ladder: the player leads and the riders take the places behind it',
    `places ${probe.map(r => r.place).join('/')}`);
  ok(probe.every(r => r.refAhead), 'ladder: every chasing rider is banded to someone ahead of it');

  const refs = probe.map(r => r.refProgress.toFixed(2));
  ok(new Set(refs).size === probe.length, 'ladder: and each to a DIFFERENT one — a chain, not a star',
    `refs ${refs.join(' / ')}`);
  ok(probe.every(r => r.refProgress > r.progress - 1e-6),
    'ladder: every reference is further down the course than the rider pacing it');
}

// ---- 7. the speed statistic: what it actually is (a recovery stat, NOT a top speed) ----
{
  // The traced statistic gates the cruise DRIVE — the pull toward the surface's speed target ([Trailmap: 360],
  // factor 0.738–1.015 across characters). It does not raise the target, and the drive is strong enough that
  // every rider pins to it, so no character has a higher top speed than any other: what the stat buys is how
  // quickly a rider gets back up to pace — off the gate, and out of every carve that scrubbed speed. Two boards
  // identical but for the stat, from a standing start:
  // Long enough that the no-drag retail-speed boards are still on snow at 20 s; the old 400 m fixture only
  // worked because the removed port drag kept them from reaching its edge.
  const shallow = makeSlope(4, 800);
  const ends = [0, 1].map(stat => {
    const m = createRideModel({
      spawn: new THREE.Vector3(0, shallow.yOf(4) + 1, 4),
      heading: new THREE.Vector3(0, 0, 1),
      terrain: shallow.terrain, surfaceOf, oobFloorY: shallow.oobFloorY,
      keys: { left: false, right: false, tuck: false, brake: false, boost: false },
      stick: { active: true, x: 0 }, drive: riderDrive(stat), onRespawn: () => {},
    });
    m.start();
    for (let t = 0; t < 20; t += 1 / 60) m.step(1 / 60);
    return { z: m.st.pos.z, v: m.st.vel.length() };
  });
  ok(ends[1].z - ends[0].z > 3, 'stats: the speed statistic is wired, and the strong rider gains ground on the weak',
    `${(ends[1].z - ends[0].z).toFixed(1)} m over 20 s on shallow ground`);
  ok(Math.abs(ends[1].v - ends[0].v) < 0.5, 'stats: ...but they end at the SAME pace — it is a recovery stat',
    `${ends[0].v.toFixed(1)} vs ${ends[1].v.toFixed(1)} m/s`);
}

// ---- 8. the airborne stretch: a rider UNDER its own line keeps riding, it does not circle beneath it ----
{
  // The reported bug, as a fixture. The path arcs 20 m into the air across the middle of the run — the way a real
  // AI path arcs over a jump — but this rider has no marker to jump at, so it stays on the snow and passes clean
  // underneath. The engine's tracker is HORIZONTAL: from below, the rider is still on its line (small perp), its
  // arc keeps advancing, and the lookahead keeps pulling it down the mountain. Measure that perp in 3-D instead —
  // which is the obvious way to write it — and the rider decides it is 20 m off-line, re-chooses every second, and
  // spins in circles under the arc forever. That is exactly what was happening.
  const arcOver = (z: number) => yOf(z) + 20 * Math.exp(-(((z - 150) / 30) ** 2));
  const p = seg(4, ZMAX - 8, 0, arcOver);
  const { probe, rewound } = run([line(p)], 22);
  const r = probe[0];
  const air = Math.max(...p.map(q => q.y - yOf(q.z)));
  ok(air > 15, 'airborne: the fixture really does lift the line off the snow', `${air.toFixed(1)} m up`);
  ok(r.pos.z > 250, 'airborne: the rider rides on THROUGH, under the arcing line — it does not circle beneath it',
    `z = ${r.pos.z.toFixed(1)} m (the arc peaks at z = 150)`);
  ok(r.path === 0, 'airborne: and it never panics off its line', `still on path ${r.path}`);
  ok(rewound === 0, 'airborne: its projection is forward-only — it never re-latches onto an earlier part of the line',
    `${rewound} rewinds`);
}

// ---- 9. the jump marker: the AI ollies at a type-25 marker, and ONLY there ----
{
  // The AI's jump is authored, not emergent: it presses the button at a marker on its path ([Trailmap: 395]).
  // Same line, same slope, same rider — one with a marker on it, one without.
  const p = seg(4, ZMAX - 8);
  const bare = run([line(p)], 12);
  const marked = run([{ ...line(p), markers: [{ arc: 80, speed: 20, trickA: false, trickB: false }] }], 12);
  ok(bare.maxAir[0] < 0.15, 'marker: with no marker on the line the rider never leaves the ground',
    `max airtime ${bare.maxAir[0].toFixed(2)} s`);
  ok(marked.maxAir[0] > 0.3, 'marker: put a marker on it and the same rider ollies',
    `max airtime ${marked.maxAir[0].toFixed(2)} s`);
  ok(marked.states[0].has('approach'), 'marker: ...through the approach behaviour, which is what presses the button');
}

// ---- 10. rivals: riders react to each other, which is the only thing that pushes a field apart ----
{
  // Three riders fielded on the SAME line — the worst case, and the one that rides in single file when the riders
  // cannot see each other. The engine gives them an avoid cone and a body bump; with those, they must not end up
  // sharing one groove.
  const p = seg(4, ZMAX - 8);
  const { states, minSep, maxSpread } = run([line(p)], 14, { starts: [0, 0, 0] });
  ok(minSep > 0.5, 'rivals: no two riders ever occupy the same snow — the bodies push apart',
    `closest approach ${minSep.toFixed(2)} m`);
  ok(states.some(s => s.has('avoid')), 'rivals: and they take avoiding action rather than driving through each other');
  // Not the FINAL spread: a rider that has finished passing returns to the line, so a snapshot can catch the whole
  // field back on it. What matters is that they fan out ACROSS the line to get round each other at all — a field
  // that cannot see itself rides nose-to-tail down one groove and this number stays at nothing.
  ok(maxSpread > 1.5, 'rivals: they fan out across the line to get past each other, rather than queueing on it',
    `widest the field got: ${maxSpread.toFixed(2)} m`);
}

// ---- 11. the course reset: a fallen rider is put back on a RESPAWNABLE path ----
{
  // Its gate line runs off the side of the mountain, so the rider follows it into the void and falls out of the
  // world. The engine warps it onto the nearest *respawnable* path, facing down-course and already moving — and
  // the respawnable flag is the whole point: the nearest line here is NOT respawnable, and must be passed over.
  // A gate line that drifts gently across the fall line and off the edge of the world (the mesh ends at x = 60),
  // and keeps going, so the rider is still on it — not handed off — when it runs out of mountain at z ≈ 240.
  const cliffPts: THREE.Vector3[] = [];
  for (let z = 4; z <= ZMAX - 8; z += 4) cliffPts.push(new THREE.Vector3((z - 4) * 0.25, yOf(z), z));
  const cliff = { ...line(cliffPts), respawnable: false }; // a line that runs off the mountain: never a reset target
  const near = { ...line(seg(4, ZMAX - 8, 40)), respawnable: false }; // nearest to where it falls — but forbidden
  const far = { ...line(seg(4, ZMAX - 8, -40)), respawnable: true };  // further away — but allowed
  // Judged on the frame it is put back down — it rides on from there, so a snapshot at the end shows nothing.
  const { postReset } = run([cliff, near, far], 45); // long: 240 m to the edge, then a FALL out of the world
  ok(!!postReset, 'reset: the rider that rode off the mountain is put back on the course at all');
  if (postReset) {
    ok(postReset.path === 2, 'reset: onto the RESPAWNABLE line — not the nearer forbidden one, nor the line it fell off',
      `path ${postReset.path} (2 = the only respawnable line)`);
    ok(Math.abs(postReset.pos.x + 40) < 10, 'reset: standing on that line',
      `x = ${postReset.pos.x.toFixed(1)} m (the respawnable line is at x = -40)`);
    ok(postReset.pos.z > 100, 'reset: and put down where it fell out — not sent back to the top of its gate',
      `z = ${postReset.pos.z.toFixed(1)} m (it rode off the edge at z ≈ 240)`);
  }
}

// ---- 12. the arc is measured in PLAN VIEW: a line that leaves the ground still pulls the rider down the hill ----
{
  // Garibaldi's big drop, as a fixture, and the real cause of the donuts. One authored segment there falls 162 m
  // while crossing just 31 m of ground: 165 m of 3-D length, 31 m of plan. The engine measures a path's arc
  // HORIZONTALLY ([Trailmap: 250]) — so 8 m of lookahead is 8 m of *ground*, however steeply the line is climbing
  // or falling, and the rider is always aiming somewhere it can actually get to.
  //
  // Measure that arc in 3-D — the obvious way — and the same 8 m of lookahead buys 1.5 m of ground on a segment
  // like that. The pursuit target lands almost on top of the rider, the bearing to it is noise, and the rider
  // carves at a point beside itself. The orbit that follows is self-sustaining: going round in a circle holds the
  // rider's own projection still, so the target never moves on and the rider never comes out.
  //
  // Here the gate line tents 80 m into the air across 16 m of ground and back down — the same 5:1 Garibaldi's drop
  // has — while the rider, with no marker to jump at, stays on the snow and passes under it. The ground-level line
  // beneath is not a convenience: 51 of Garibaldi's 90 AI paths fly more than 15 m over snow you can stand on (one
  // of them by 101 m), and the ground lines running under them are what a rider left behind re-chooses onto. See
  // `lostUnderLine` — the one piece of this the engine does not have, and why it can do without it.
  const flier: THREE.Vector3[] = [];
  for (let z = 4; z < 140; z += 4) flier.push(new THREE.Vector3(0, yOf(z), z));
  flier.push(new THREE.Vector3(0, yOf(156) + 80, 156)); // up 80 m across 16 m of ground
  flier.push(new THREE.Vector3(0, yOf(172), 172));      // ...and back down onto it
  for (let z = 176; z <= ZMAX - 8; z += 4) flier.push(new THREE.Vector3(0, yOf(z), z));

  const { probe, pathsSeen, rewound } = run([line(flier), line(seg(4, ZMAX - 8, 0))], 22);
  const r = probe[0];

  const plan = 388;                                    // the line runs z = 4 → 392 straight down the fall line
  const cubed = flier.reduce((s, q, k) => k ? s + q.distanceTo(flier[k - 1]) : 0, 0);
  ok(cubed > plan + 100, 'plan arc: the fixture really is a line whose 3-D length dwarfs its ground length',
    `${cubed.toFixed(0)} m of 3-D line over ${plan} m of ground`);
  ok(Math.abs(r.total - plan) < 1.5, 'plan arc: a path is ruled by its GROUND length, not its 3-D length',
    `total = ${r.total.toFixed(1)} m (ground ${plan} m, 3-D ${cubed.toFixed(0)} m)`);
  ok(r.pos.z > 300, 'plan arc: and the rider gets down the mountain instead of doing donuts under the tent',
    `z = ${r.pos.z.toFixed(1)} m (the tent peaks at z = 156)`);
  ok(pathsSeen[0].has(1), 'plan arc: it re-chooses onto the line that stayed on the snow when its own flew away',
    `visited paths ${[...pathsSeen[0]].join('/')} (1 = the ground line)`);
  ok(rewound === 0, 'plan arc: and its projection never re-latches behind itself', `${rewound} rewinds`);
}

// ---- 13. the hand-placed rider (docs/016): a click drops a rider that RIDES, and a full field recycles ----
{
  // OURS, not the engine's — it only ever seeded a field at the gates. An author working on one pitch needs a
  // rider *there*, so a slope click in Play drops one. What lands has to be an ordinary member of the field from
  // its first frame, or the whole thing is a lie: it takes the best line from where it was put down, through the
  // same 3-D chooser a shoved rider re-chooses with, and rides it. And it has to have a ceiling — every rider is
  // a whole physics board on the same terrain the player's is on — so a full field recycles its oldest rider into
  // the new spot rather than growing without limit under a click that costs nothing to repeat.
  const fall = seg(0, ZMAX, 0);   // the fall line
  const across = seg(0, ZMAX, 30); // ...and a second line, 30 m across the hill
  const at = (x: number, z: number) => new THREE.Vector3(x, yOf(z), z);
  const field = createAiRiders({
    paths: [line(fall), line(across)], starts: [], terrain, scene: new THREE.Group(), surfaceOf, oobFloorY,
    course: seg(0, ZMAX, 0), maxRiders: 2,
  });

  ok(field.count === 0, 'drop: a field seeded with no gates starts empty — there is nothing out there to watch yet');
  ok(field.spawnAt(at(28, 40)), 'drop: a click on the slope puts a rider on it');
  ok(field.count === 1, 'drop: …and the field grows by one', `${field.count} out`);
  ok(field.probe()[0].path === 1, 'drop: it takes the line nearest where it landed, not simply the first in the network',
    `path ${field.probe()[0].path} (1 = the line 30 m across)`);

  for (let t = 0; t < 6; t += 1 / 60) field.step(1 / 60);
  const rode = field.probe()[0];
  const off = lateral(across, rode.pos);
  ok(rode.pos.z > 60, 'drop: and it RIDES — the real controller, on the real terrain, from wherever you put it',
    `z = ${rode.pos.z.toFixed(1)} m (dropped at z = 40)`);
  ok(off < 4, 'drop: tracking the line it chose', `${off.toFixed(2)} m off it`);

  field.spawnAt(at(0, 40));
  ok(field.count === 2, 'drop: a second click fills the field to its cap', `${field.count} out, cap 2`);
  const wasOldest = field.probe()[0].pos.clone(); // the first rider: the one that has been out on the mountain longest

  field.spawnAt(at(0, 200));
  ok(field.count === 2, 'drop: past the cap the field does not grow — a click costs a rider, it does not add one',
    `${field.count} out, cap 2`);
  const recycled = field.probe()[0].pos;
  ok(recycled.distanceTo(at(0, 200)) < 3, 'drop: the rider that had been out longest is the one recycled into the new spot',
    `slot 0 is now at z = ${recycled.z.toFixed(1)} m — it was at z = ${wasOldest.z.toFixed(1)} m`);
  field.setMax(0);
  ok(field.count === 0, 'drop: a zero cap retires the whole live field — zero is the off setting');
  ok(!field.spawnAt(at(0, 240)), 'drop: a zero cap refuses new slope-click riders instead of indexing an empty field');
  field.dispose();

  const empty = createAiRiders({
    paths: [], starts: [], terrain, scene: new THREE.Group(), surfaceOf, oobFloorY, maxRiders: 2,
  });
  ok(!empty.spawnAt(at(0, 40)), 'drop: refused on a mountain with no AI network — a rider with no line just stands there');
  empty.dispose();
}

// ---- 14. the field races the LEVEL, not just its lines: boost volumes and a lap count of its own ----------
{
  // An opponent is the player's model with a synthesized stick, and that has to mean the whole model. Handed no
  // boost volumes a field rides straight through every conveyor, shaft and finish tube the level authored — on
  // MEGAPLEX that is the difference between a lap course and a one-way run, because the tube IS how a rider gets
  // back to the top. And the lap countdown is PER RIDER: the engine keeps one counter each, and it is what the
  // lap-gated volume reads ([Trailmap: 390-lap-counter, 360-lapboost-gate]).
  const fall = seg(0, ZMAX, 0);
  const finishAt = 300;
  // A plate across the fall line, well down the run: a rider that reaches it is pushed hard along +X, which
  // nothing else in this fixture can do.
  const plate: BoostVolume = {
    key: 'pad', box: new THREE.Box3(new THREE.Vector3(-60, -200, 100), new THREE.Vector3(60, 200, 120)),
    spec: { kind: 'directional', dir: new THREE.Vector3(1, 0, 0), target: 18, rate: 6, mode: 1, seconds: 0 },
  };
  const field = createAiRiders({
    paths: [line(fall)], starts: [0], terrain, scene: new THREE.Group(), surfaceOf, oobFloorY,
    course: fall, boostVolumes: [plate], laps: 3,
    finish: { pos: new THREE.Vector3(0, yOf(finishAt), finishAt), fwd: new THREE.Vector3(0, 0, 1) },
  });
  const laps: number[] = [];
  let shoved = 0; // the widest the pad ever threw it — it carves back onto the line afterwards, as it should
  for (let t = 0; t < 40; t += 1 / 60) {
    field.step(1 / 60);
    const r = field.probe()[0];
    shoved = Math.max(shoved, Math.abs(r.pos.x));
    if (!laps.length || laps[laps.length - 1] !== r.lapsRemaining) laps.push(r.lapsRemaining);
  }
  const end = field.probe()[0];
  ok(shoved > 5, 'level: the field is pushed by the mountain’s boost volumes, not only by its lines',
    `thrown ${shoved.toFixed(1)} m across the fall line (the pad pushes +X)`);
  ok(laps.join(',') === '3,2', 'level: and each rider counts its own passes over the level’s own finish',
    `laps remaining went ${laps.join(' → ')} (seeded to the pass count, one decrement per crossing)`);
  ok(end.lap === 2, 'level: a counted crossing puts the rider on the next lap', `lap ${end.lap} of 3`);
  field.dispose();

  // The MainType-13 RESET volume, which is the level's own answer to a rider that has left the run
  // ([Trailmap: 390-pickups-and-race, 395-reset-arm]). A ride-through slab across the fall line, flagged as a
  // reset host: the rider meets it, and is put back on a respawnable line rather than carrying on through.
  const zone: RideObstacleSource = {
    key: 'reference:9', object: { kind: 'reference', index: 9 },
    geometry: new THREE.BoxGeometry(120, 40, 4),
    matrixWorld: new THREE.Matrix4().makeTranslation(0, yOf(150) + 18, 150),
    solid: false, bounce: 0, surface: -1,
  };
  const guarded = createAiRiders({
    paths: [line(fall)], starts: [0], terrain, scene: new THREE.Group(), surfaceOf, oobFloorY,
    course: fall, obstacles: [zone], resetVolumes: new Set(['reference:9']),
  });
  // Bounded well short of the line's end: a field whose ONLY path runs out has nothing to hand off to and
  // resets on that instead, which would prove nothing about the volume.
  let resetAt = -1;
  for (let t = 0; t < 14 && resetAt < 0; t += 1 / 60) {
    guarded.step(1 / 60);
    if (guarded.probe()[0].resets > 0) resetAt = t;
  }
  ok(resetAt > 0, 'level: riding into a reset volume puts the rider back on the course',
    resetAt > 0 ? `reset at ${resetAt.toFixed(1)} s` : 'never reset');
  guarded.dispose();

  // ...and the same slab without the flag is just scenery: a reset must come from the AUTHORED volume, never
  // from touching a prop.
  const unflagged = createAiRiders({
    paths: [line(fall)], starts: [0], terrain, scene: new THREE.Group(), surfaceOf, oobFloorY,
    course: fall, obstacles: [zone],
  });
  for (let t = 0; t < 14; t += 1 / 60) unflagged.step(1 / 60);
  ok(unflagged.probe()[0].resets === 0, 'level: an unflagged prop in the same place resets nobody',
    `${unflagged.probe()[0].resets} resets`);
  unflagged.dispose();

  // SSF collision graphs: an opponent's prop contacts reach the runtime with ITS slot, and the rider-directed
  // half of what the graph then does lands on that rider ([Trailmap: 390-pickups-and-race]). A button is both
  // halves at once — the material flips for everybody, the Speed 3.5 is for whoever rode over it — so a field
  // that reported no contact would light nothing, and one that reported the wrong subject would boost you.
  const button: RideObstacleSource = {
    key: 'reference:12', object: { kind: 'reference', index: 12 },
    geometry: new THREE.BoxGeometry(30, 1, 2),
    matrixWorld: new THREE.Matrix4().makeTranslation(0, yOf(120), 120),
    solid: false, bounce: 0, surface: -1,
  };
  const hits: { slot: number; index: number }[] = [];
  const wired = createAiRiders({
    paths: [line(fall)], starts: [0], terrain, scene: new THREE.Group(), surfaceOf, oobFloorY,
    course: fall, obstacles: [button],
    onPropCollision: (slot, hit) => {
      if (hit.object.kind === 'reference') hits.push({ slot, index: hit.object.index });
    },
  });
  let boostedAt = -1;
  for (let t = 0; t < 14; t += 1 / 60) {
    wired.step(1 / 60);
    if (hits.length && boostedAt < 0) {
      wired.applyEffect(hits[0].slot, { kind: 'speed-boost', amount: 3.5 });
      boostedAt = t;
    }
  }
  ok(hits.length > 0 && hits[0].slot === 0 && hits[0].index === 12,
    'level: an opponent’s prop contact reaches the collision runtime with its own slot',
    hits.length ? `slot ${hits[0].slot} on reference:${hits[0].index}` : 'no contact reported');
  ok(boostedAt > 0, 'level: ...and the rider-directed half of the graph lands on that rider',
    boostedAt > 0 ? `boosted at ${boostedAt.toFixed(1)} s` : 'never boosted');
  wired.dispose();

  // A bowl plug exposed a different contact shape from the raised button above: its pass-through
  // triangles replace one terrain cell exactly, so the board rides parallel to them instead of crossing a front
  // edge. That still is native ground contact and must dispatch the collision graph. The matching plate two
  // metres overhead is the negative — a floor sensor must not turn passing beneath scenery into contact.
  const slopePanel = (z: number, lift: number) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([
      -15, yOf(z - 2) + lift, z - 2, 15, yOf(z - 2) + lift, z - 2,
      -15, yOf(z + 2) + lift, z + 2, 15, yOf(z + 2) + lift, z + 2,
    ], 3));
    geometry.setIndex([0, 2, 1, 1, 2, 3]);
    return geometry;
  };
  const flushPanel: RideObstacleSource = {
    key: 'reference:13', object: { kind: 'reference', index: 13 }, geometry: slopePanel(120, 0),
    matrixWorld: new THREE.Matrix4(), solid: false, bounce: 0, surface: -1,
  };
  const overheadPanel: RideObstacleSource = {
    key: 'reference:14', object: { kind: 'reference', index: 14 }, geometry: slopePanel(150, 2),
    matrixWorld: new THREE.Matrix4(), solid: false, bounce: 0, surface: -1,
  };
  const panelHits: number[] = [];
  const panels = createAiRiders({
    paths: [line(fall)], starts: [0], terrain, scene: new THREE.Group(), surfaceOf, oobFloorY,
    course: fall, obstacles: [flushPanel, overheadPanel],
    onPropCollision: (_slot, hit) => { if (hit.object.kind === 'reference') panelHits.push(hit.object.index); },
  });
  for (let t = 0; t < 14; t += 1 / 60) panels.step(1 / 60);
  ok(panelHits.includes(13), 'level: a flush pass-through floor panel dispatches its collision graph',
    panelHits.includes(13) ? 'contacted reference:13' : 'no contact reported');
  ok(!panelHits.includes(14), 'level: the flush-panel sensor does not fire on a plate overhead',
    panelHits.includes(14) ? 'contacted reference:14' : 'no overhead contact');
  panels.dispose();

  // The pad boost is real thrust, not a flag: the same rider over the same line ends further down it.
  const paced = [3.5, 0].map(amount => {
    const solo = createAiRiders({
      paths: [line(fall)], starts: [0], terrain, scene: new THREE.Group(), surfaceOf, oobFloorY, course: fall,
    });
    for (let t = 0; t < 8; t += 1 / 60) {
      solo.step(1 / 60);
      if (amount > 0 && Math.abs(t - 2) < 1 / 120) solo.applyEffect(0, { kind: 'speed-boost', amount });
    }
    const z = solo.probe()[0].pos.z;
    solo.dispose();
    return z;
  });
  ok(paced[0] > paced[1] + 1, 'level: a pad boost applied to an opponent actually drives it down the hill',
    `${paced[0].toFixed(1)} m vs ${paced[1].toFixed(1)} m over 8 s`);

  // No volumes and no lap count is still a legal mountain: it must ride exactly as it always did.
  const bare = createAiRiders({
    paths: [line(fall)], starts: [0], terrain, scene: new THREE.Group(), surfaceOf, oobFloorY, course: fall,
  });
  for (let t = 0; t < 10; t += 1 / 60) bare.step(1 / 60);
  const plain = bare.probe()[0];
  ok(Math.abs(plain.pos.x) < 2 && plain.pos.z > 60 && plain.lap === 1 && !plain.finished,
    'level: a mountain with no volumes and no laps rides straight down it and counts nothing',
    `x = ${plain.pos.x.toFixed(2)} m, z = ${plain.pos.z.toFixed(1)} m, lap ${plain.lap}`);
  bare.dispose();
}

console.log(failures ? `\nAI RIDER: ${failures} FAILED` : '\nAI RIDER: PASS');
process.exit(failures ? 1 : 0);
