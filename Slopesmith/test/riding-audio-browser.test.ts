// tier: integration
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';

const work = mkdtempSync(join(tmpdir(), 'slopesmith-riding-condition-'));
const bundle = join(work, 'ride.js');
const rate = 16000,
  frames = 8000;
const wave = Buffer.alloc(44 + frames * 2);
wave.write('RIFF');
wave.writeUInt32LE(wave.length - 8, 4);
wave.write('WAVEfmt ', 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(rate, 24);
wave.writeUInt32LE(rate * 2, 28);
wave.writeUInt16LE(2, 32);
wave.writeUInt16LE(16, 34);
wave.write('data', 36);
wave.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++) wave.writeInt16LE(Math.round((0.1 + 0.8 * Math.sin(i * 0.13)) * 32767), 44 + i * 2);
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');
  if (url.pathname === '/ride.js') {
    response.setHeader('content-type', 'text/javascript');
    response.end(readFileSync(bundle));
  } else if (url.pathname === '/api/board-audio') {
    response.setHeader('content-type', 'application/json');
    const adapted = url.searchParams.get('level') !== 'GARI';
    response.end(
      JSON.stringify({
        boardBank: adapted ? 'openslope_board' : 'zboard',
        boostBank: adapted ? 'openslope_rider' : 'zbxsfx',
      }),
    );
  } else if (url.pathname === '/api/board-sound') {
    response.setHeader('content-type', 'audio/wav');
    response.end(wave);
  } else response.end('<!doctype html><title>Riding audio cache verification</title>');
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await build({
    stdin: {
      contents: `
    export { BoardAudio } from './src/app/ride/board-audio';
    export { sharedAudioBuffer, setGameAudioVolume } from './src/app/audio/runtime';
    export { DEFAULT_BOARD_SOUND } from './src/core/audio/board-sound';`,
      resolveDir: process.cwd(),
      loader: 'ts',
    },
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    logLevel: 'silent',
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');
  browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
  const page = await browser.newPage();
  await page.addInitScript('globalThis.__name = fn => fn;');
  await page.goto(`http://127.0.0.1:${address.port}`);
  const result = await page.evaluate(async () => {
    const moduleUrl = '/ride.js';
    const { BoardAudio, sharedAudioBuffer, setGameAudioVolume, DEFAULT_BOARD_SOUND } = await import(moduleUrl);
    setGameAudioVolume(0);
    const source = new BoardAudio(DEFAULT_BOARD_SOUND, [0], 'SSX3_A');
    const url = '/api/board-sound?bank=zboard&slot=4&loop=1&level=SSX3_A';
    const raw = await sharedAudioBuffer(url);
    const original = raw.getChannelData(0).slice();
    const prepared = await source.buffer('zboard', 4, true);
    const again = await source.buffer('zboard', 4, true);
    const other = new BoardAudio(DEFAULT_BOARD_SOUND, [0], 'SSXOT_ER1_DAY');
    const carve = await other.buffer('zboard', 3, true);
    const stock = new BoardAudio(DEFAULT_BOARD_SOUND, [0], 'GARI');
    const stockBuffer = await stock.buffer('zboard', 4, true);
    const stockRaw = await sharedAudioBuffer('/api/board-sound?bank=zboard&slot=4&loop=1&level=GARI');
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((sum, v) => sum + v * v, 0) / a.length);
    const samples = prepared.getChannelData(0);
    const state = {
      vel: { length: () => 12 },
      railIdx: -1,
      grounded: true,
      surf: 0,
      slip: 0,
      lean: 0,
      popTime: 0,
      contactN: { x: 0, y: 1, z: 0 },
      predictedAirTime: 0,
    };
    source.update(state, 0.1, false);
    await new Promise(resolve => setTimeout(resolve, 0));
    const glidePitch = source.glide.source?.playbackRate.value;
    source.update({ ...state, railIdx: 0 }, 0.1, false);
    await new Promise(resolve => setTimeout(resolve, 0));
    const railPitch = source.grind.source?.playbackRate.value;
    source.dispose();
    other.dispose();
    stock.dispose();
    return {
      sourceRms: rms(original),
      glideRms: rms(samples),
      carveRms: rms(carve.getChannelData(0)),
      seam: Math.abs(samples[0] - samples[samples.length - 1]),
      rawUnchanged: raw.getChannelData(0).every((v: number, i: number) => v === original[i]),
      cloned: prepared !== raw,
      reused: again === prepared,
      rate: prepared.sampleRate === raw.sampleRate,
      frames: prepared.length === raw.length,
      stockUntouched: stockBuffer === stockRaw,
      glidePitch,
      railPitch,
    };
  });
  assert(result.sourceRms > 0.5 && result.glideRms <= 0.120001 && result.carveRms <= 0.160001);
  assert(result.seam < 1e-6 && result.rawUnchanged && result.cloned && result.reused);
  assert(result.rate && result.frames && result.stockUntouched);
  assert(Math.abs(result.glidePitch - 0.9) < 1e-6);
  assert(result.railPitch >= 0.9 - 1e-6 && result.railPitch <= 1.05 + 1e-6);
  console.log(
    'PASS: actual Web Audio decode, adapted-bank metadata, conditioned cache reuse and unmodified original banks',
  );
} finally {
  await browser?.close();
  await new Promise<void>(resolve => server.close(() => resolve()));
  rmSync(work, { recursive: true, force: true });
}
