// tier: fast
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  ANNOUNCER_EVENT_IDS, AnnouncerRideEvents, normalizeAnnouncer, type AnnouncerIndex,
} from '../src/core/audio/announcer';
import { blankMountain, migrateMountain } from '../src/core/doc/mountain';
import { createStore } from '../src/app/state/store';
import { readAnnouncerIndex, readAnnouncerSound } from '../src/server/routes/announcer';
import { RideAnnouncerRuntime } from '../src/app/audio/announcer';

const settings = normalizeAnnouncer({ volume: 4, cooldownSeconds: -3,
  events: { go: { chance: 0, file: '../unsafe.wav' }, land: { chance: NaN, file: 'hello.wav' } } });
assert.equal(settings.volume, 1);
assert.equal(settings.cooldownSeconds, 0);
assert.deepEqual(settings.events.go, { chance: 0 });
assert.deepEqual(settings.events.land, { chance: 0.45, file: 'hello.wav' });
const doc = blankMountain('ANNOUNCER_TEST');
doc.announcer = settings;
assert.deepEqual(migrateMountain(JSON.parse(JSON.stringify(doc))).announcer, settings);
assert.equal(createStore({ mdoc: doc, storedUi: {}, currentMode: 'play' }).playAnnouncerOn, true);
assert.equal(createStore({ mdoc: doc, storedUi: { playAnnouncer: false }, currentMode: 'play' }).playAnnouncerOn, false);

const detector = new AnnouncerRideEvents();
const ground = { grounded: true, airTime: 0, speed01: 0.3, boosting: false };
assert.deepEqual(detector.step(1, { ...ground, grounded: false, airTime: 1 }), []);
assert.deepEqual(detector.step(0.5, { ...ground, grounded: false, airTime: 1.5 }), ['bigAir']);
assert.deepEqual(detector.step(0.5, { ...ground, grounded: false, airTime: 2 }), []);
assert.deepEqual(detector.step(0.01, ground), ['land']);
assert.deepEqual(detector.step(0.01, ground), []);
detector.step(1, { ...ground, grounded: false, airTime: 1 });
detector.reset();
assert.deepEqual(detector.step(0.01, ground), [], 'respawn must not invent a landing');
assert.deepEqual(detector.step(6.1, { ...ground, speed01: 0 }), ['slow']);
assert.deepEqual(detector.step(6.1, { ...ground, speed01: 0 }), [], 'slow calls have a long rearm');
detector.reset();
assert.deepEqual(detector.step(9, { ...ground, boosting: true }), []);
assert.deepEqual(detector.step(1.1, { ...ground, boosting: true }), ['boost']);
assert.deepEqual(detector.step(1, { ...ground, boosting: true }), []);
detector.reset();
assert.deepEqual(detector.step(40.1, { ...ground, speed01: 0.8 }), ['sweet']);

const fixture = mkdtempSync(join(tmpdir(), 'slopesmith-announcer-'));
process.env.SLOPESMITH_MAPS_ROOT = fixture;
try {
  const bank = join(fixture, 'Shared', 'speech', 'mc', 'Go');
  mkdirSync(bank, { recursive: true });
  writeFileSync(join(bank, '000.wav'), 'test voice bytes');
  writeFileSync(join(bank, '001.wav'), 'second voice');
  writeFileSync(join(bank, 'notes.txt'), 'ignored');
  const index = await readAnnouncerIndex();
  assert.deepEqual(index.go, ['000.wav', '001.wav']);
  assert.deepEqual(index.land, [], 'missing bank stays silent');
  assert.equal((await readAnnouncerSound('go', '000.wav')).toString(), 'test voice bytes');
  await assert.rejects(readAnnouncerSound('../Go', '000.wav'));
  await assert.rejects(readAnnouncerSound('go', '../000.wav'));
  await assert.rejects(readAnnouncerSound('land', '000.wav'));
} finally {
  assert.ok(resolve(fixture).startsWith(resolve(tmpdir()) + '\\') || resolve(fixture).startsWith(resolve(tmpdir()) + '/'));
  rmSync(fixture, { recursive: true, force: true });
}

// Exercise the asynchronous voice owner with a real fetch/decode-shaped boundary, including late arrivals.
const started: FakeSource[] = [];
class FakeSource {
  buffer: { duration: number; tag: string } | null = null;
  onended: (() => void) | null = null;
  stopped = false;
  connect() {}
  disconnect() {}
  start() { started.push(this); }
  stop() { this.stopped = true; }
}
class FakeContext {
  currentTime = 0;
  state = 'running';
  destination = {};
  createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; }
  createBufferSource() { return new FakeSource(); }
  async decodeAudioData(data: ArrayBuffer) { return { duration: 2, tag: Buffer.from(data).toString() }; }
}
const originalFetch = globalThis.fetch;
const originalRandom = Math.random;
const originalContext = globalThis.AudioContext;
globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
Math.random = () => 0;
let release: (() => void) | undefined;
const index = Object.fromEntries(ANNOUNCER_EVENT_IDS.map(id => [id, ['000.wav', '001.wav']])) as AnnouncerIndex;
globalThis.fetch = async input => {
  const url = String(input);
  if (url === '/api/announcer-audio') return Response.json(index);
  if (url.includes('delayed.wav')) await new Promise<void>(resolve => { release = resolve; });
  return new Response(url);
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
try {
  const runtime = new RideAnnouncerRuntime();
  const mix = normalizeAnnouncer(undefined);
  runtime.configure(mix, true);
  runtime.fire('go'); await flush();
  assert.equal(started.length, 1);
  runtime.fire('land'); await flush();
  assert.equal(started.length, 1, 'ordinary call cannot overlap or cut a playing line');
  runtime.fire('knockdown'); await flush();
  assert.equal(started.length, 2);
  assert.equal(started[0].stopped, true, 'wipeout interrupts');
  started[1].onended?.();
  runtime.fire('land'); await flush();
  assert.equal(started.length, 2, 'cooldown continues after the voice ends');
  runtime.fire('go'); await flush();
  assert.equal(started.length, 3);
  assert.notEqual(started[0].buffer?.tag, started[2].buffer?.tag, 'no consecutive bank variant repeats');
  runtime.configure(mix, false);
  assert.equal(started[2].stopped, true, 'mute cuts the live voice immediately');
  runtime.fire('go'); await flush();
  assert.equal(started.length, 3);
  runtime.configure(mix, true);
  await flush();
  assert.equal(started.length, 3, 'unmuting does not fabricate a start');
  mix.events.go.file = 'delayed.wav';
  runtime.fire('go'); await flush();
  assert.ok(release);
  runtime.configure(mix, false);
  release(); await flush();
  assert.equal(started.length, 3, 'late decode cannot speak after mute');
  runtime.configure(mix, true);
  runtime.fire('go'); await flush();
  assert.match(started[3].buffer?.tag ?? '', /custom-sound.*delayed\.wav/);
  runtime.reset();
  assert.equal(started[3].stopped, true, 'exit/reset stops custom voices too');
  mix.events.go.chance = 0;
  runtime.configure(mix, true);
  runtime.fire('go'); await flush();
  assert.equal(started.length, 4, 'zero chance disables even priority calls');
} finally {
  globalThis.fetch = originalFetch;
  Math.random = originalRandom;
  globalThis.AudioContext = originalContext;
}
console.log('Announcer: settings, persistence, events, bank reads, interruptions, cooldowns and mute cancellation passed.');
