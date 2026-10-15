// Optional conformance through the public music API, using synthetic audio only.
// Run from Slopesmith: node --import tsx ../tools/music-playback-reference.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const profile = JSON.parse(readFileSync(new URL('../Contracts/music-playback-v1.json', import.meta.url), 'utf8'));
const starts = [], stops = [], contexts = [], buffers = new Map();
class Param {
  value = 1;
  setValueAtTime(v) { this.value = v; return this; }
  linearRampToValueAtTime(v) { this.value = v; return this; }
  setTargetAtTime(v) { this.value = v; return this; }
  cancelScheduledValues() { return this; }
}
class Node {
  target = null;
  connect(node) { this.target = node; return this; }
  disconnect() {}
}
class Source extends Node {
  buffer = null; loop = false; loopStart = 0; loopEnd = 0; playbackRate = new Param(); onended = null;
  start(...args) { starts.push({ node: this, args }); }
  stop() { stops.push(this); }
}
class Context {
  state = 'running'; currentTime = 0; sampleRate = 48000; destination = new Node();
  constructor() { contexts.push(this); }
  createGain() { const node = new Node(); node.gain = new Param(); return node; }
  createBufferSource() { return new Source(); }
  decodeAudioData(bytes) { return Promise.resolve({ url: buffers.get(bytes), duration: 2, sampleRate: 48000, length: 96000, numberOfChannels: 2 }); }
  resume() { return Promise.resolve(); }
}
globalThis.AudioContext = Context;
let index;
const graph = { Song: 'song', Short: 'S', Bpm: 120, Tracks: 1, Sections: 1, Events: 0,
  EventTable: '', Routers: [], Vars: [], Volume: .2,
  Nodes: [{ Index: 0, Sample: 1, Flags: 0, Word1: 1, Word2: 1 << 24, Links: [0], LinkRaw: [127 << 8] }],
  Samples: [{ Index: 0, Wav: 'sample.wav', MusOffset: 0, Meta: 2000, Samples: 96000, Rate: 48000, Channels: 2, Seconds: 2 }] };
globalThis.fetch = async url => {
  const bytes = new ArrayBuffer(8); buffers.set(bytes, String(url));
  const data = String(url).includes('song=') ? graph : index;
  return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(data),
    json: async () => data, arrayBuffer: async () => bytes };
};
const { RideMusicRuntime } = await import('../Slopesmith/src/app/audio/ride-music.ts');
const { setGameAudioVolume } = await import('../Slopesmith/src/app/audio/runtime.ts');
const settle = async () => { for (let i = 0; i < 20; ++i) await new Promise(resolve => setTimeout(resolve, 0)); };
const gain = node => { let value = 1; for (; node; node = node.target) value *= node.gain?.value ?? 1; return value; };
let checks = 0;
const near = (actual, expected) => { assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`); ++checks; };
for (const mode of ['authored', 'reference', 'intro']) {
  starts.length = stops.length = 0;
  const level = mode.toUpperCase();
  index = { level, environment: null,
    intro: mode === 'intro' ? { tier: 'C', stems: ['Course-C1.wav'] } : null,
    songs: mode === 'reference' ? [{ id: 'song', title: 'Synthetic', short: 'S', bpm: 120, tracks: 1,
      sections: 1, events: 0, routers: 0, nodes: 1, samples: 1, totalSeconds: 2, averageChunkSeconds: 2 }] : [] };
  const api = new RideMusicRuntime();
  const frame = { active: true, target: mode === 'authored' ? 'authored' : 'reference', referenceLevel: level,
    referenceSong: '', authoredTrack: mode === 'authored' ? 'master.wav' : null,
    authoredArrangement: { mode: 'linear-loop', bpm: 120, loopStartSeconds: .2, loopEndSeconds: 1.5 },
    authoredEnvironment: null, mounted: mode !== 'intro', speed: 0, grounded: true, airTime: 0, boosting: false };
  setGameAudioVolume(1);
  api.step(1 / 60, frame); await settle();
  api.step(1 / 60, frame); await settle();
  assert.equal(starts.length, 1, mode); ++checks;
  if (mode !== 'intro') near(gain(starts[0].node), profile.raceGain / (60 * profile.fadeSeconds));
  for (let i = 0; i < 600; ++i) {
    for (const context of contexts) context.currentTime = (i + 1) / 60;
    api.step(1 / 60, frame);
  }
  await settle();
  const source = starts[0].node;
  near(gain(source), mode === 'intro' ? profile.introGain : profile.raceGain);
  setGameAudioVolume(.5);
  near(gain(source), (mode === 'intro' ? profile.introGain : profile.raceGain) / 2);
  if (mode === 'authored') {
    assert.equal(source.loop, true); ++checks;
    near(source.loopStart, .2); near(source.loopEnd, 1.5);
    for (let i = 0; i < 180; ++i) api.step(1 / 60, { ...frame, mounted: false });
    assert.ok(stops.includes(source)); ++checks;
    api.step(1 / 60, frame); await settle();
    assert.equal(starts.length, 2); ++checks;
    assert.equal(starts[1].args.length, 1, 'remount starts without a playback offset'); ++checks;
  } else if (mode === 'intro') {
    assert.equal(source.loop, false); ++checks;
    assert.match(source.buffer.url, /Course-C1/); ++checks;
  }
  api.stop();
}
setGameAudioVolume(1);
console.log(`PASS: ${checks} public music API observations verify shared gains, fade, master volume, intro phrase and remount loop behavior`);
