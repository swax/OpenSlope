// tier: fast

import * as THREE from 'three';
import { check, failures } from './check';

/**
 * The board bed's performance (docs/034), driven headlessly over a synthetic run: the layers open and close
 * where they should, the surface under the board picks the family row, a rail hands over to the grind loop,
 * and the transients fire on their edges. Web Audio and the bank route are stubbed — what is under test is
 * `board-audio.ts`'s own decisions, not the browser's mixer.
 */

// ---- a fake Web Audio graph + bank route ----------------------------------------------------------

/** Every started source, in order, tagged with the bank URL its buffer came from. */
const started: { url: string; loop: boolean; node: FakeSource }[] = [];
const bufferUrls = new Map<object, string>();
const fetchCounts = new Map<string, number>();
let contextCount = 0;
let contextCloseCount = 0;
let contextLatencyHint: AudioContextLatencyCategory | number | undefined;

class FakeParam {
  value = 0;
  linearRampToValueAtTime(value: number) { this.value = value; return this; }
  setValueAtTime(value: number) { this.value = value; return this; }
  cancelScheduledValues() { return this; }
}
class FakeNode {
  connect() { return this; }
  disconnect() { return this; }
}
class FakeGain extends FakeNode { gain = new FakeParam(); }
/** Gains in creation order (see the BoardAudio constructor). Per-one-shot gains append past these. */
const gains: FakeGain[] = [];
const LAYER = { game: 0, master: 1, transients: 2, cues: 3, glide: 4, carve: 5, grind: 6, bigAir: 7, boost: 8 } as const;
const level = (layer: keyof typeof LAYER): number => gains[LAYER[layer]].gain.value;
class FakeSource extends FakeNode {
  buffer: object | null = null;
  loop = false;
  playbackRate = new FakeParam();
  onended: (() => void) | null = null;
  stopped = false;
  start() { started.push({ url: bufferUrls.get(this.buffer!) ?? '?', loop: this.loop, node: this }); }
  stop() { this.stopped = true; }
}
class FakeContext {
  state = 'running';
  currentTime = 0;
  destination = new FakeNode();
  constructor(options?: AudioContextOptions) {
    contextCount++;
    contextLatencyHint = options?.latencyHint;
  }
  createGain() { const gain = new FakeGain(); gains.push(gain); return gain; }
  createBufferSource() { return new FakeSource(); }
  decodeAudioData(bytes: ArrayBuffer) { return Promise.resolve(bytes as unknown as AudioBuffer); }
  resume() { return Promise.resolve(); }
  close() { contextCloseCount++; return Promise.resolve(); }
}

// Each URL decodes to its own distinct "buffer", so a started source names the slot it is playing.
(globalThis as Record<string, unknown>).AudioContext = FakeContext;
(globalThis as Record<string, unknown>).fetch = (url: string) => {
  fetchCounts.set(url, (fetchCounts.get(url) ?? 0) + 1);
  const bytes = new ArrayBuffer(8);
  bufferUrls.set(bytes, url);
  return Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(bytes) });
};

const { createBoardAudio } = await import('../src/app/ride/board-audio');
const { setGameAudioVolume } = await import('../src/app/audio/runtime');
const { DEFAULT_BOARD_SOUND } = await import('../src/core/audio/board-sound');
type RideState = import('../src/app/ride/physics').RideState;

/** The fields the bed reads off the live ride, at rest on packed snow. */
function rideState(overrides: Partial<Record<string, unknown>> = {}): RideState {
  return {
    vel: new THREE.Vector3(0, 0, 0),
    contactN: new THREE.Vector3(0, 1, 0),
    lean: 0, slip: 0, surf: 1, grounded: true, railIdx: -1, popTime: 0, popDrive: 0,
    predictedAirTime: 0,
    ...overrides,
  } as unknown as RideState;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const FRAME = 1 / 60;
/** Run the bed for `seconds` of frames on one state. */
async function ride(audio: NonNullable<ReturnType<typeof createBoardAudio>>, st: RideState,
  seconds: number, boosting = false) {
  for (let t = 0; t < seconds; t += FRAME) audio.update(st, FRAME, boosting);
  await settle();
}
/** Sources started from one exact slot (`slot=1` must not answer for `slot=11`). */
const playing = (slot: number, bank = 'zboard') =>
  started.filter(s => new RegExp(`bank=${bank}&slot=${slot}(&|$)`).test(s.url));
const pitchOf = (slot: number, bank = 'zboard'): number => {
  const source = playing(slot, bank).at(-1);
  return source ? source.node.playbackRate.value : -1;
};

// ---- the run --------------------------------------------------------------------------------------

gains.length = 0;
const off = createBoardAudio({ ...DEFAULT_BOARD_SOUND, enabled: false });
check(off === null, 'a mix with sound switched off builds no bed at all');
check(createBoardAudio({ ...DEFAULT_BOARD_SOUND, volume: 0 }) === null, 'a silent master builds no bed');

// Only the two synthetic surfaces exercised below: routing itself is tested from the generated sidecar.
const testSurfaceGroups: number[] = [];
testSurfaceGroups[1] = 0;
testSurfaceGroups[3] = 1;
const audio = createBoardAudio(DEFAULT_BOARD_SOUND, testSurfaceGroups)!;
check(!!audio, 'the default mix builds a bed');
await settle();
const boostUrl = '/api/board-sound?bank=zbxsfx&slot=120&loop=1';
const speedPadUrl = '/api/board-sound?bank=zbxsfx&slot=115';
check(contextCount === 1 && contextLatencyHint === 'interactive',
  'board audio opens one shared interactive-latency context');
setGameAudioVolume(0.4);
check(level('game') === 0.4, 'the Test game-volume master applies live over the board graph');
setGameAudioVolume(0);
check(level('game') === 0, 'zero game volume is a real master mute');
setGameAudioVolume(1);
check(fetchCounts.get(boostUrl) === 1 && fetchCounts.get(speedPadUrl) === 1,
  'ride-critical boost and cue buffers are fetched before their event edges');

// Riding packed snow fast and clean: OpenSlope's authored response opens glide at natural pitch and leaves
// the carve row shut.
const cruising = rideState({ vel: new THREE.Vector3(0, 0, 16) });
await ride(audio, cruising, 0.5);
check(playing(4).length === 1 && playing(4)[0].loop, 'packed snow runs the PACK glide loop (slot 004), looping');
check(playing(3).length === 1 && playing(3)[0].loop, 'and the PACK carve loop (slot 003)');
check(level('master') === DEFAULT_BOARD_SOUND.volume, 'the master gain is the authored volume');
check(level('glide') > 0.1, 'the glide row is open riding clean at speed');
check(level('carve') < 0.02, 'nothing scrapes riding clean on groomed snow');
check(pitchOf(4) === 1, 'tracking clean, the glide loop plays at natural pitch (bend rides slip, not speed)');
const cruisingGlide = level('glide');

// A hard carve: the authored crossfade hands the bed to the carve row and raises glide pitch with the skid.
await ride(audio, rideState({ vel: new THREE.Vector3(0, 0, 14), lean: 0.6, slip: 3 }), 0.5);
check(level('carve') > 0.5 && level('glide') < 0.02, 'a hard carve hands the bed to the carve row');
check(pitchOf(4) > 1.3, 'the glide bend rides the skid up');

// Crawling: the reconstructed dig scales with speed, so the bed closes on a near-parked board.
await ride(audio, rideState({ vel: new THREE.Vector3(0, 0, 3) }), 0.5);
check(level('glide') < cruisingGlide && level('glide') < 0.05, 'crawling, the glide layer closes');
check(level('carve') < 0.02, 'a straight, slow board does not scrape');

// Painting powder under the same board swaps the row, and does not restart the one it left.
await ride(audio, rideState({ vel: new THREE.Vector3(0, 0, 14), surf: 3 }), 0.2);
check(playing(12).length === 1 && playing(11).length === 1, 'powder swaps to the POWDER row (slots 011/012)');
await ride(audio, cruising, 0.2);
check(playing(4).length === 2, 'coming back to packed snow restarts the PACK loop rather than resuming powder');

// A rail hands the bed over to the RAIL row; the terrain loops fade out under it.
await ride(audio, rideState({ vel: new THREE.Vector3(0, 0, 14), railIdx: 2, surf: 1 }), 0.5);
check(playing(52).length === 1, 'a grind runs the RAIL family glide loop (slot 052) — the row terrain never picks');
check(playing(4).length === 2 && playing(3).length === 2, 'the grind does not restart the terrain loops');
check(level('grind') > 0.3 && level('glide') < 0.02 && level('carve') < 0.02,
  'the grind scrape replaces the snow bed rather than layering over it');

// Catching a rail out of the air is a grind, not a thud in the snow.
await ride(audio, rideState({
  vel: new THREE.Vector3(0, -8, 14), grounded: false, predictedAirTime: 1.5,
}), 0.2);
await ride(audio, rideState({ vel: new THREE.Vector3(0, 0, 14), railIdx: 2 }), 0.2);
check(playing(1).length === 0, 'catching a rail out of the air raises no landing thud');
check(playing(32, 'zbxsfx').length === 0, 'a predicted 1.5-second flight does not pass the retail strict threshold');

// The ollie pop fires once on the launch edge, not every frame of the pop.
const popping = rideState({
  vel: new THREE.Vector3(0, 4, 14), grounded: false, popTime: 0.2, popDrive: 0.8, predictedAirTime: 2.2,
});
await ride(audio, popping, 0.15);
check(playing(2).length === 1, 'the traced BOARD +2 ollie pop fires once on the launch edge');
check(!playing(2)[0].loop, 'a transient is a one-shot, not a loop');
check(playing(32, 'zbxsfx').length === 1 && playing(32, 'zbxsfx')[0].loop,
  'a predicted >1.5-second flight starts the rider-owned MAIN/032 wind loop');

// Airborne, the ride bed goes quiet with no explicit stop.
await ride(audio, rideState({
  vel: new THREE.Vector3(0, -6, 14), grounded: false, predictedAirTime: 2.2,
}), 1);
check(playing(4).length === 2 && playing(52).length === 1, 'nothing new starts in the air');
check(level('glide') === 0 && level('carve') === 0 && level('grind') === 0,
  'leaving the snow cuts the whole bed, with no explicit stop');
check(level('bigAir') > 0.4, 'the qualifying flight keeps the big-air wind audible while airborne');

// Touchdown: a hard arrival thuds, a soft set-down doesn't.
const bigAirSource = playing(32, 'zbxsfx')[0].node;
await ride(audio, rideState({ vel: new THREE.Vector3(0, 0, 14) }), 0.2);
check(playing(1).length === 1, 'the traced BOARD +1 landing thud fires on the touchdown edge');
check(bigAirSource.stopped, 'landing fades and destroys the focused-rider wind voice');
await ride(audio, rideState({ vel: new THREE.Vector3(0, -0.2, 14), grounded: false }), 0.1);
await ride(audio, rideState({ vel: new THREE.Vector3(0, 0, 14) }), 0.1);
check(playing(1).length === 1, 'a drift-down onto the snow is below the thud threshold');

// Held boost: the roar comes from the OTHER shared bank, loops, and stops when the boost is released.
await ride(audio, cruising, 0.3, true);
check(playing(120, 'zbxsfx').length === 1 && playing(120, 'zbxsfx')[0].loop,
  'held boost runs the full-meter roar from zbxsfx, looping');
const boostSource = playing(120, 'zbxsfx')[0].node;
await ride(audio, cruising, 1.5);
check(boostSource.stopped, 'releasing boost fades the roar out and stops it');
audio.updateFlightBoost(false, 0.3);
await settle();
check(playing(120, 'zbxsfx').length === 1, 'ordinary off-board flight does not start the boost roar');
audio.updateFlightBoost(true, 0.3);
await settle();
check(playing(120, 'zbxsfx').length === 2, 'applied Superman boost starts the same boost roar');
check(level('glide') === 0 && level('carve') === 0 && level('grind') === 0 && level('bigAir') === 0,
  'flight boost keeps every board-specific bed silent');
const flightBoostSource = playing(120, 'zbxsfx').at(-1)!.node;
audio.updateFlightBoost(false, 1.5);
check(flightBoostSource.stopped, 'ending applied flight boost fades its roar out');

// Game-event cues: the code-driven MAIN-bank one-shots, handed over at the gameplay apply.
audio.gemChime(2);
audio.gemChime(3);
audio.gemChime(5);
await settle();
check(playing(116, 'zbxsfx').length === 1 && playing(117, 'zbxsfx').length === 1
  && playing(118, 'zbxsfx').length === 1, 'the gem chime picks its tier off the multiplier: ×2/×3/×5 → 116/117/118');
check(playing(116, 'zbxsfx').every(s => !s.loop), 'a chime is a one-shot');
audio.gemChime(4);
await settle();
check(playing(117, 'zbxsfx').length === 2,
  'an authored ×4 chimes like a ×3 — the engine thresholds on the value, not on a tier index');
audio.padCue('speed');
audio.padCue('trick');
await settle();
check(playing(115, 'zbxsfx').length === 1, 'a speed pad (MainType 17) plays MAIN slot 115');
check(playing(114, 'zbxsfx').length === 1, 'a trick pad (MainType 18) plays MAIN slot 114');
check(level('cues') === DEFAULT_BOARD_SOUND.cues && level('transients') === DEFAULT_BOARD_SOUND.transients,
  'cues and board transients ride their own trims');

audio.dispose();
check(started.every(s => s.node.stopped || !s.loop), 'disposing the bed stops every loop it started');
const nextRun = createBoardAudio(DEFAULT_BOARD_SOUND, testSurfaceGroups)!;
await settle();
check(contextCount === 1 && contextCloseCount === 0,
  'Stop → Play reuses the warm context instead of reopening the audio device');
check(fetchCounts.get(boostUrl) === 1 && fetchCounts.get(speedPadUrl) === 1,
  'Stop → Play reuses decoded buffers instead of fetching them again');
nextRun.dispose();

console.log(failures ? `\n${failures} check(s) failed` : '\nall board-audio checks passed');
process.exit(failures ? 1 : 0);
