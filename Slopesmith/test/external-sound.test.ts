// tier: fast

/**
 * Placed ambience is a gain field, not a one-shot.
 *
 * An instance's `Sounds.ExternalSounds` records are continuing emitters: active while the listener is inside
 * an authored region, with a gain read off one of six exact falloff curves at the normalized distance
 * [Trailmap: 420-audio-runtime]. Merquer's fire hydrants are the case that exposed the gap — 22 of its 25
 * carry a 32 m type-0 loop of the spray clip and no collision row at all, so with no emitter runtime they
 * were silent and the hit read as a clip playing only its first half (the lid's separate clang).
 *
 * Those same hydrants are also the case that exposed the OPPOSITE gap. Events 16/28/57 are the interactive
 * ambient class: hit-gated, so an untouched hydrant is silent no matter how close you stand, and only a hit
 * on its owning instance starts the spray [Trailmap: 420-interactive-ambient]. Running the field without that
 * gate made every car alarm and police siren in Merquer sound from the drop gate.
 *
 * These checks pin the curve table, the ellipsoid's orientation handling, the region boundary, and the gate,
 * because all four decide whether a voice is audible at a given listener position.
 *
 * Run: tsx test/external-sound.test.ts
 */
import {
  externalSoundField, externalSoundGain, externalSoundNormalizedDistance, externalSoundReach,
  externalSoundShape, isInteractiveAmbientEvent, resolveExternalSound, type ExternalSoundEmitter,
  authoredAmbientEmitter, authoredAmbientRecord, authoredAmbientEvent,
  externalSoundLabel, HIT_GATED_EVENT_POOL, hitGatedEventForFile,
  AUTHORED_AMBIENT_MAX_M, AUTHORED_AMBIENT_MIN_M,
} from '../src/core/effects/external-sound';
import type { V3 } from '../src/core/doc/types';
import { check, checkNear, failures } from './check';


/** A type-0 point emitter: `params` is [radius, curve]. */
const point = (radius: number, curve: number): ExternalSoundEmitter =>
  ({ type: 0, sound: 28, offset: [0, 0, 0], params: [radius, curve] });

// ---- the six curves, at the normalized distances that separate them ----

checkNear(externalSoundGain(point(100, 0), [0, 0, 0]), 1, 'curve 0 is full gain at the centre');
checkNear(externalSoundGain(point(100, 0), [50, 0, 0]), 1 - 0.25, 'curve 0 = 1 − d² at d=0.5');
checkNear(externalSoundGain(point(100, 1), [50, 0, 0]), 1 - 0.5 / 1.25, 'curve 1 = 1 − d/(1.5 − 0.5d) at d=0.5');
checkNear(externalSoundGain(point(100, 2), [50, 0, 0]), 0.5, 'curve 2 = 1 − d at d=0.5');
checkNear(externalSoundGain(point(100, 3), [50, 0, 0]), 0.5 / 1.25, 'curve 3 = (1−d)/(1.5 − 0.5(1−d)) at d=0.5');
checkNear(externalSoundGain(point(100, 4), [50, 0, 0]), 0.25, 'curve 4 = (1 − d)² at d=0.5');
checkNear(externalSoundGain(point(100, 5), [50, 0, 0]), 1, 'curve 5 holds full gain through d=0.7');
checkNear(externalSoundGain(point(100, 5), [85, 0, 0]), 0.5, 'curve 5 falls linearly past d=0.7');

// Every curve must reach the boundary silent, or a voice pops as the listener crosses out of range.
for (let curve = 0; curve <= 5; curve++)
  checkNear(externalSoundGain(point(100, curve), [99.999, 0, 0]), 0, `curve ${curve} is ~silent at the boundary`, 1e-4);

// ---- the region boundary ----

check(externalSoundGain(point(100, 2), [100, 0, 0]) === 0, 'exactly at the radius is outside');
check(externalSoundGain(point(100, 2), [140, 0, 0]) === 0, 'beyond the radius is silent');
check(externalSoundGain(point(100, 2), [60, 60, 60]) === 0, 'the region is a sphere, not a box');
checkNear(externalSoundNormalizedDistance(point(3200, 2), [1600, 0, 0])!, 0.5,
  'a hydrant listener half way out reads d=0.5');

// An unusable record must not become an always-on voice at full gain.
check(externalSoundGain({ type: 0, sound: 28, offset: [0, 0, 0], params: [0, 2] }, [0, 0, 0]) === 0,
  'a zero-radius record is silent rather than infinite');
check(externalSoundGain({ type: 0, sound: 28, offset: [0, 0, 0], params: [] }, [0, 0, 0]) === 0,
  'a truncated record is silent');
check(externalSoundShape({ type: 9, sound: 28, offset: [0, 0, 0], params: [100] }) === null,
  'an unknown record type has no region');

// ---- type 1: the oriented ellipsoid ----

/** Merquer's subway-station emitter shape: triaxial, laid along world +X. */
const ellipsoid: ExternalSoundEmitter = {
  type: 1, sound: 160, offset: [0, 0, 0], params: [3050, 8325, 5475, 1, 0, 0, 2],
};
checkNear(externalSoundGain(ellipsoid, [0, 0, 0]), 1, 'ellipsoid is full gain at its centre');
// +Z maps onto the axis, so the record's third half-extent is the one that runs along world +X.
checkNear(externalSoundNormalizedDistance(ellipsoid, [5475, 0, 0])!, 1,
  'the third half-extent lies along the authored axis');
check(externalSoundGain(ellipsoid, [5474, 0, 0]) > 0, 'just inside along the axis is audible');
check(externalSoundGain(ellipsoid, [5476, 0, 0]) === 0, 'just outside along the axis is silent');
// The same 5475 cm offset ACROSS the axis leaves the region, which is the whole point of orienting it.
check(externalSoundGain(ellipsoid, [0, 0, 5475]) === 0, 'the same distance across the axis is out of range');

/** A degenerate axis must not silence the emitter or throw — it stays axis-aligned. */
const unoriented: ExternalSoundEmitter = {
  type: 1, sound: 160, offset: [0, 0, 0], params: [1000, 2000, 3000, 0, 0, 0, 2],
};
checkNear(externalSoundNormalizedDistance(unoriented, [1000, 0, 0])!, 1, 'a zero axis leaves half-extents in place');
checkNear(externalSoundNormalizedDistance(unoriented, [0, 0, 3000])!, 1, '…on every axis');

/** An axis antiparallel to +Z is the 180° case the rotation shortcut skips; it must still measure right. */
const flipped: ExternalSoundEmitter = {
  type: 1, sound: 160, offset: [0, 0, 0], params: [1000, 2000, 3000, 0, 0, -1, 2],
};
checkNear(externalSoundNormalizedDistance(flipped, [0, 0, 3000])!, 1, 'an antiparallel axis measures the same region');
checkNear(externalSoundNormalizedDistance(flipped, [1000, 0, 0])!, 1, '…across it too');

// ---- type 3: constant gain inside its radius ----

const alternate: ExternalSoundEmitter = { type: 3, sound: 105, offset: [0, 0, 0], params: [500] };
checkNear(externalSoundGain(alternate, [0, 0, 0]), 1, 'type 3 is full gain at the centre');
checkNear(externalSoundGain(alternate, [499, 0, 0]), 1, 'type 3 holds constant gain to its edge');
check(externalSoundGain(alternate, [501, 0, 0]) === 0, 'type 3 still stops at its radius');

// ---- reach: what a proximity scan culls against ----

checkNear(externalSoundReach(point(3200, 2)), 3200, 'a point emitter reaches its radius');
checkNear(externalSoundReach(ellipsoid), 8325, 'an ellipsoid reaches its longest half-extent whatever its axis');
check(externalSoundReach({ type: 9, sound: 1, offset: [0, 0, 0], params: [] }) === 0,
  'an unusable record reaches nothing, so a scan drops it');

// A reach that under-reports would cull an audible voice: sample the ellipsoid's own boundary.
for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const)
  check(externalSoundReach(ellipsoid) >= 8325 * Math.max(...axis),
    `reach covers the ${axis.join('')} extreme`);

// ---- the field: which emitters a listener hears, and in what order ----

/** Two of Merquer's hydrants at their shipped 32 m radius, 40 m apart along X, plus a distant third. All
 *  BURST — event 28 is hit-gated, so an unarmed hydrant would drop out of the field before any of the
 *  ranking below could be observed. The gate itself is exercised in its own section further down. */
const hydrantA = { key: 'a', emitter: point(3200, 2), center: [0, 0, 0] as V3, armed: true };
const hydrantB = { key: 'b', emitter: point(3200, 2), center: [4000, 0, 0] as V3, armed: true };
const faraway = { key: 'far', emitter: point(3200, 2), center: [100000, 0, 0] as V3, armed: true };
const field = [hydrantA, hydrantB, faraway];

check(externalSoundField(field, [0, 0, 0]).length === 1, 'at one hydrant only that hydrant is heard');
check(externalSoundField(field, [0, 0, 0])[0].key === 'a', '…and it is the one under the listener');
check(externalSoundField(field, [50000, 0, 0]).length === 0, 'between clusters nothing is audible');

// Standing between two overlapping hydrants, the nearer must rank first — this is the ordering a voice
// budget truncates against, so getting it backwards would silence the emitter you are standing next to.
const between = externalSoundField(field, [1500, 0, 0]);
check(between.length === 2, 'inside two overlapping regions both are heard');
check(between[0].key === 'a' && between[1].key === 'b', 'the nearer of two equal regions ranks first');
check(between[0].gain > between[1].gain, '…and is genuinely louder');

// The budget truncates by gain, never by list order.
const budgeted = externalSoundField([hydrantB, hydrantA], [1500, 0, 0], 1);
check(budgeted.length === 1 && budgeted[0].key === 'a',
  'a one-voice budget keeps the loudest regardless of list order');
check(externalSoundField(field, [0, 0, 0], 0).length === 0, 'a zero budget yields no voices');

// A record with no usable region must never occupy a voice slot.
check(externalSoundField([{ key: 'broken', emitter: point(0, 2), center: [0, 0, 0] as V3, armed: true }],
  [0, 0, 0]).length === 0, 'an unusable record is not selected');

// Ranking must be stable, or voices restart every scan as equal-gain emitters trade places.
const tie = [
  { key: 'z', emitter: point(3200, 2), center: [1000, 0, 0] as V3, armed: true },
  { key: 'a', emitter: point(3200, 2), center: [-1000, 0, 0] as V3, armed: true },
];
check(externalSoundField(tie, [0, 0, 0])[0].key === 'a'
  && externalSoundField([tie[1], tie[0]], [0, 0, 0])[0].key === 'a',
  'equal gains break ties by key, so a scan does not churn voices');

// The hydrant case end to end: audible across its authored radius, silent a step outside it.
check(externalSoundField([hydrantA], [3199, 0, 0]).length === 1, 'a hydrant is audible to its 32 m edge');
check(externalSoundField([hydrantA], [3201, 0, 0]).length === 0, '…and silent just past it');

// ---- the interactive ambient class: hit-gated, per instance ----

// Membership is engine-fixed, not authored: exactly cars/hydrants/police, and nothing adjacent to them.
check([16, 28, 57].every(isInteractiveAmbientEvent), 'events 16/28/57 are the interactive class');
check(![15, 17, 27, 29, 56, 58, 68, 97, 102].some(isInteractiveAmbientEvent),
  'no neighbouring event is gated — 68, the floodlight hum, plays on proximity like the rest');

/** The same hydrant, untouched. Identical region and curve; only the arming differs. */
const idle = { key: 'idle', emitter: point(3200, 2), center: [0, 0, 0] as V3 };
check(externalSoundField([idle], [0, 0, 0]).length === 0,
  'an unhit hydrant is silent with the listener standing on top of it');
check(externalSoundField([{ ...idle, armed: true }], [0, 0, 0]).length === 1,
  '…and sprays once its own instance has been hit');

// Per-instance, or hitting one hydrant would start the whole street.
const pair = [idle, { key: 'burst', emitter: point(3200, 2), center: [500, 0, 0] as V3, armed: true }];
const afterHit = externalSoundField(pair, [0, 0, 0]);
check(afterHit.length === 1 && afterHit[0].key === 'burst',
  'arming one hydrant leaves its unhit neighbour silent');

// The ordinary proximity events must be unaffected by the gate, with no arming anywhere in sight.
const floodlight = { key: 'hum', emitter: { ...point(3200, 2), sound: 68 }, center: [0, 0, 0] as V3 };
check(externalSoundField([floodlight], [0, 0, 0]).length === 1,
  'a non-interactive emitter needs no arming at all');

// ---- the AUTHORED contract: one spec, two readings that must agree ----

// The sphere case is what authoring has always emitted; it stays byte-for-byte what it was.
const sphere = authoredAmbientEmitter({ event: 90, radius: 40 });
check(sphere.type === 0 && sphere.params[0] === 40 && sphere.params[1] === 2,
  'a sphere reads as a type-0 point at its authored radius, linear by default');
check(JSON.stringify(authoredAmbientRecord({ event: 90, radius: 40 })) === '[4000,2]',
  '…and ships as native centimetres with the curve beside it');

// An unset curve is linear; every one of the six is authorable, including 0, which is falsy.
check(authoredAmbientEmitter({ event: 90, radius: 40, falloff: 0 }).params[1] === 0,
  'curve 0 survives being authored — it is a real selector, not an absent one');
check(authoredAmbientEmitter({ event: 90, radius: 40, falloff: 9 }).params[1] === 5,
  'an out-of-range curve clamps into the six the runtime actually evaluates');
check(authoredAmbientRecord({ event: 90, radius: 1 })[0] === AUTHORED_AMBIENT_MIN_M * 100
  && authoredAmbientRecord({ event: 90, radius: 9999 })[0] === AUTHORED_AMBIENT_MAX_M * 100,
  'radius clamps to the authorable range before it reaches the native record');

// The ellipsoid is the reason this contract is derived rather than hand-written: editor (x, y, z) is native
// (x, z, y), and a sphere hides that because it is permutation-invariant.
const authoredEllipsoid = { event: 90, radius: 40, halfExtents: [10, 20, 30] as V3 };
const drawn = authoredAmbientEmitter(authoredEllipsoid);
check(drawn.type === 1 && JSON.stringify(drawn.params) === '[10,20,30,0,0,1,2]',
  'an ellipsoid draws from the authored half-extents in editor metres, axis-aligned');
check(JSON.stringify(authoredAmbientRecord(authoredEllipsoid)) === '[1000,3000,2000,0,0,1,2]',
  '…and ships reordered into native axes: editor Y and Z swap on the way out');

// The invariant that matters: what the viewport outlines and what the ISO carries are the SAME volume. Take
// a listener on each editor axis, and the same point expressed natively, and demand the same gain.
const shipped: ExternalSoundEmitter = {
  type: 1, sound: 90, offset: [0, 0, 0], params: authoredAmbientRecord(authoredEllipsoid),
};
for (const [axis, name] of [[0, 'X'], [1, 'Y'], [2, 'Z']] as const) {
  const editorPoint: V3 = [0, 0, 0];
  editorPoint[axis] = drawn.params[axis] * 0.5;          // half way to the boundary on this axis
  const nativePoint: V3 = [0, 0, 0];
  nativePoint[axis === 1 ? 2 : axis === 2 ? 1 : 0] = editorPoint[axis] * 100;
  checkNear(externalSoundGain(shipped, nativePoint), externalSoundGain(drawn, editorPoint),
    `the drawn and shipped regions agree on editor ${name}`);
}

// A degenerate half-extent would divide by zero in the region maths, so the floor applies per axis.
check(authoredAmbientEmitter({ event: 90, radius: 40, halfExtents: [0, 20, 30] as V3 }).params[0]
  === AUTHORED_AMBIENT_MIN_M, 'a zero half-extent clamps to the floor rather than collapsing the region');

// ---- hit-gated claims: an uploaded WAV takes over one of the engine's three ids ----

check(JSON.stringify(HIT_GATED_EVENT_POOL) === '[16,28,57]',
  'the claim pool is exactly the three ids the engine classifier tests');

// Position IS the id, so the editor and the export allocate identically without coordinating.
const claims = ['spray.wav', 'alarm.wav', 'siren.wav'];
check(hitGatedEventForFile('spray.wav', claims) === 16
  && hitGatedEventForFile('alarm.wav', claims) === 28
  && hitGatedEventForFile('siren.wav', claims) === 57,
  'each claim position takes its own event id');
check(hitGatedEventForFile('unclaimed.wav', claims) === -1, 'an unclaimed file holds no gated id');
check(hitGatedEventForFile(undefined, claims) === -1, 'a prop with no uploaded file holds none either');
check(hitGatedEventForFile('spray.wav', undefined) === -1, 'nor does one on a mountain with no claims');

// Releasing blanks a slot rather than closing the gap: compacting would slide later claims onto different
// event ids, silently changing which retail props they override.
const released = ['', 'alarm.wav'];
check(hitGatedEventForFile('alarm.wav', released) === 28,
  'a released slot leaves the claims after it on their original ids');

// A claimed file supplies the CLIP while the event supplies the ROUTING, so the two coexist.
check(authoredAmbientEvent(-1, 'spray.wav', claims) === 16,
  'a claimed WAV reports the gated event it took over');
check(isInteractiveAmbientEvent(authoredAmbientEvent(-1, 'spray.wav', claims)),
  '…so every reading that gates on the id gates it, with no second notion of "gated"');
check(authoredAmbientEvent(90, 'unclaimed.wav', claims) === 90,
  'an unclaimed WAV leaves the prop event alone — the export pool assigns it, and that pool is never gated');
check(authoredAmbientEvent(90, undefined, claims) === 90, 'a bank-event prop is unaffected by claims');
check(!isInteractiveAmbientEvent(authoredAmbientEvent(90, 'unclaimed.wav', claims)),
  'an unclaimed custom loop is NOT hit-gated, however many claims the mountain holds');

// The browse list has to say so: picking one of these changes WHEN a loop is heard, not just how it sounds.
check(externalSoundLabel(16).includes('(hit-gated)') && externalSoundLabel(28).includes('(hit-gated)')
  && externalSoundLabel(57).includes('(hit-gated)'), 'the three ids are marked wherever events are browsed');
check(!externalSoundLabel(68).includes('(hit-gated)'), '…and no other event is');
check(externalSoundLabel(115).startsWith('115 — Coyote'),
  'a fixed environment bank keeps naming itself');

// ---- event routing: the fixed environment banks are not course slots ----

const fixed = resolveExternalSound(177, 'MERQUER');
check(fixed?.kind === 'fixed' && fixed.bank === 'CopCar' && fixed.slot === 0,
  'a fixed environmental event names its own global bank');
check(resolveExternalSound(102, 'MERQUER') === null,
  'the context-selected chant bank stays unresolved rather than guessing');

console.log(failures ? `\n${failures} failure(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
