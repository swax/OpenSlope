// tier: integration
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import type { RideMusicFrame } from '../src/app/audio/ride-music';
import type { ReferenceMusicGraph, ReferenceMusicIndex } from '../src/core/reference/music';

const work = mkdtempSync(join(tmpdir(), 'slopesmith-music-preload-'));
const bundle = join(work, 'music.js');
const wave = Buffer.alloc(44 + 800 * 4);
wave.write('RIFF');
wave.writeUInt32LE(wave.length - 8, 4);
wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(2, 22);
wave.writeUInt32LE(8000, 24);
wave.writeUInt32LE(32000, 28);
wave.writeUInt16LE(4, 32);
wave.writeUInt16LE(16, 34);
wave.write('data', 36);
wave.writeUInt32LE(wave.length - 44, 40);
for (let i = 44; i < wave.length; i += 2) wave.writeInt16LE(2048, i);

function graph(chunks: number): ReferenceMusicGraph {
  return {
    Song: 'Authored soundtrack fixture',
    Short: 'fixture',
    Bpm: 120,
    Tracks: 1,
    Sections: 1,
    Events: 0,
    EventTable: '',
    Routers: [],
    Vars: [],
    Nodes: Array.from({ length: chunks }, (_, i) => ({
      Index: i,
      Sample: i + 1,
      Flags: 0,
      Word1: 0,
      Word2: 0,
      Links: [],
      LinkRaw: [(Math.min(i + 1, chunks - 1) << 16) | (127 << 8)],
    })),
    Samples: Array.from({ length: chunks }, (_, i) => ({
      Index: i + 1,
      Wav: `chunk_${i}.wav`,
      MusOffset: 0,
      Meta: 0,
      Samples: 800,
      Rate: 8000,
      Channels: 2,
      Seconds: 0.1,
    })),
  };
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/music.js') {
    response.setHeader('content-type', 'text/javascript');
    response.end(readFileSync(bundle));
  } else if (url.pathname === '/api/reference-music') {
    const level = url.searchParams.get('level') ?? '';
    const chunks = level === 'CHUNKED' ? 3 : 1;
    const index: ReferenceMusicIndex = {
      level,
      intro: null,
      environment: { Bank: 'Wind1', Slot: 0, Clip: 'Banks/Wind1/000.wav', Volume: 0.15 },
      songs: Array.from({ length: level === 'CHUNKED' ? 1 : 41 }, (_, i) => ({
        id: `song_${i}`,
        title: `Track ${i}`,
        short: 'fixture',
        bpm: 120,
        tracks: 1,
        sections: 1,
        events: 0,
        routers: 0,
        nodes: chunks,
        samples: chunks,
        totalSeconds: chunks * 0.1,
        averageChunkSeconds: 0.1,
      })),
    };
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(url.searchParams.has('song') ? graph(chunks) : index));
  } else if (url.pathname === '/api/reference-music-sample' || url.pathname === '/api/effect-sound') {
    response.setHeader('content-type', 'audio/wav');
    response.end(wave);
  } else {
    response.end('<!doctype html><title>Music preload regression</title>');
  }
});

let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await build({
    entryPoints: ['src/app/audio/ride-music.ts'],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  await page.addInitScript('globalThis.__name = fn => fn;');
  await page.goto(`http://127.0.0.1:${address.port}`);
  const result = await page.evaluate(async () => {
    const moduleUrl = '/music.js';
    const { preloadReferenceRideMusic, RideMusicRuntime } = await import(/* @vite-ignore */ moduleUrl);
    const requests: URL[] = [];
    const fetch = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      requests.push(new URL(input instanceof Request ? input.url : String(input), location.href));
      return fetch(input, init);
    };
    let decoded = 0;
    const decode = AudioContext.prototype.decodeAudioData;
    Object.defineProperty(AudioContext.prototype, 'decodeAudioData', {
      value: function (this: AudioContext, data: ArrayBuffer) {
        return decode.call(this, data).then(buffer => {
          decoded++;
          return buffer;
        });
      },
    });
    const tick = (ms = 20) => new Promise<void>(resolve => setTimeout(resolve, ms));
    async function until(ready: () => boolean) {
      for (let i = 0; i < 200 && !ready(); i++) await tick();
      if (!ready()) throw new Error(`Audio preload timed out: decoded=${decoded}, requests=${requests}`);
    }
    const samples = (level = 'FULL') =>
      requests.filter(url => url.pathname === '/api/reference-music-sample' && url.searchParams.get('level') === level);
    const songs = () => samples().map(url => url.searchParams.get('song'));
    const graphs = () =>
      requests.filter(url => url.pathname === '/api/reference-music' && url.searchParams.has('song'));

    preloadReferenceRideMusic('FULL');
    await until(() => decoded >= 1);
    await tick(100);
    if (graphs().length || samples().length) throw new Error('Random setup eagerly loaded soundtrack candidates');

    Math.random = () => 10.5 / 41;
    const runtime = new RideMusicRuntime();
    const frame: RideMusicFrame = {
      active: true,
      target: 'reference',
      referenceLevel: 'FULL',
      referenceSong: '',
      authoredTrack: null,
      authoredArrangement: { mode: 'linear-loop', bpm: 120, loopStartSeconds: 0, loopEndSeconds: 0 },
      authoredEnvironment: null,
      mounted: false,
      speed: 0,
      grounded: true,
      airTime: 0,
      boosting: false,
    };
    runtime.beginRun();
    runtime.step(0, frame);
    await until(() => decoded >= 2);
    const first = songs();
    runtime.step(0.1, { ...frame, mounted: true });
    await tick();
    runtime.stop();
    Math.random = () => 20.5 / 41;
    runtime.step(0, frame);
    await tick(100);
    const resumed = songs();

    runtime.beginRun();
    runtime.step(0, frame);
    await until(() => decoded >= 3);
    const nextRun = songs();
    preloadReferenceRideMusic('FULL', 'song_0');
    await until(() => decoded >= 4);
    runtime.step(0, { ...frame, referenceSong: 'song_0' });
    await tick(100);
    const explicit = songs();
    preloadReferenceRideMusic('FULL', 'retired-song');
    await tick(100);
    const missing = songs();
    Math.random = () => 30.5 / 41;
    runtime.step(0, { ...frame, referenceSong: 'retired-song' });
    await until(() => decoded >= 5);
    const fallback = songs();
    runtime.stop();

    preloadReferenceRideMusic('CHUNKED', 'song_0');
    await until(() => decoded >= 8);
    return {
      first,
      resumed,
      nextRun,
      explicit,
      missing,
      fallback,
      decoded,
      chunks: samples('CHUNKED').map(url => url.searchParams.get('sample')),
    };
  });
  assert.deepEqual(result.first, ['song_10'], '41-song Random playlist decodes only the chosen complete song');
  assert.deepEqual(result.resumed, result.first, 'mounting and mute/resume reuse the same run choice and buffer');
  assert.deepEqual(result.nextRun, ['song_10', 'song_20'], 'a new run picks and warms one new song');
  assert.deepEqual(result.explicit, ['song_10', 'song_20', 'song_0'], 'explicit preload and playback share one buffer');
  assert.deepEqual(result.missing, result.explicit, 'a retired selection never preloads every candidate');
  assert.deepEqual(
    result.fallback,
    [...result.explicit, 'song_30'],
    'retired selections choose one fallback at runtime',
  );
  assert.deepEqual(result.chunks, ['1', '2'], 'segmented music still warms only the first two chunks');
  assert.equal(result.decoded, 8, 'only requested songs, two chunks and their ambience enter decoded memory');
  console.log('Ride music preload PASS: 41-song Random stays lazy, per-run choice, explicit reuse and chunk lookahead');
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
}
