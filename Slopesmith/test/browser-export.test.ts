// tier: fast

/**
 * The browser export's byte writers, checked headlessly against the counterparts they have to agree with.
 * Run: `npx tsx test/browser-export.test.ts`
 *
 * Three writers exist only on the browser side of the export seam — the PNG encoder, the PCM16 WAV encoder
 * and the store-only ZIP — and none of them needs a DOM: `CompressionStream`, `Blob` and `Response` are as
 * available in Node as in a tab. So each is exercised here against something that already knows the answer:
 * the PNG against the server's own encoder and decoder, the WAV against `ffmpeg -ac 2 -ar 36000 -c:a
 * pcm_s16le` (the transcode this replaced) and against its own reader, and the ZIP against the platform's
 * unzip.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { encodePng as browserEncodePng } from '../src/app/export/png';
import { zipStoreOnly } from '../src/app/export/zip';
import { createMountainArchive, readMountainArchive } from '../src/app/mountain/archive';
import { decodePng, encodePng as nodeEncodePng } from '../src/server/routes/png';
import { blankMountain } from '../src/core/doc/mountain';
import { decodeWav, encodePcm16Wav, resampleAudio, RACE_MUSIC_CHANNELS, RACE_MUSIC_SAMPLE_RATE } from '../src/core/export/wav';
import type { Rgba } from '../src/core/paint/ground-textures';
import type { ProjectBundle } from '../src/core/project/transfer';
import { check, failures, recordFailure } from './check';

const work = mkdtempSync(join(tmpdir(), 'slopesmith-browser-export-'));
try {
  // ---- PNG: the browser writer against the server's, page for page ---------------------------------------
  const images: [string, Rgba][] = [
    ['1x1 opaque', { w: 1, h: 1, data: new Uint8Array([13, 240, 77, 255]) }],
    ['4x4 gradient', { w: 4, h: 4, data: Uint8Array.from({ length: 64 },
      (_unused, i) => i % 4 === 3 ? 255 : (i * 7) & 0xff) }],
    ['128x128 noise + alpha', { w: 128, h: 128, data: (() => {
      const data = new Uint8Array(128 * 128 * 4);
      let seed = 1;
      for (let i = 0; i < data.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; data[i] = seed & 0xff; }
      return data;
    })() }],
  ];
  for (const [label, image] of images) {
    const browser = await browserEncodePng(image);
    const node = nodeEncodePng(image);
    // Same container: signature, IHDR and IEND are byte-identical, so only the compressed IDAT can differ.
    const idatAt = (bytes: Uint8Array) => {
      let at = 8;
      while (at + 8 <= bytes.length) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const size = view.getUint32(at);
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
        if (type === 'IDAT') return { start: at + 8, size, header: bytes.subarray(0, at) };
        at += 12 + size;
      }
      throw new Error('no IDAT');
    };
    const b = idatAt(browser), n = idatAt(node);
    check(Buffer.from(b.header).equals(Buffer.from(n.header)),
      `PNG ${label}: signature + IHDR are byte-identical to the server writer`);
    check(Buffer.from(inflateSync(Buffer.from(browser.subarray(b.start, b.start + b.size))))
      .equals(inflateSync(Buffer.from(node.subarray(n.start, n.start + n.size)))),
    `PNG ${label}: the IDAT inflates to exactly the same filtered scanlines`);
    const round = decodePng(Buffer.from(browser));
    check(round.w === image.w && round.h === image.h
      && Buffer.from(round.data).equals(Buffer.from(image.data)),
    `PNG ${label}: the server's decoder reads back every pixel unchanged`);
  }

  // ---- WAV: the PCM16 writer against the ffmpeg invocation it replaced -----------------------------------
  // A source with content worth resampling: two channels, a rate that is not a multiple of 36 kHz.
  const rate = 44100, seconds = 2;
  const frames = rate * seconds;
  const source: Float32Array[] = [new Float32Array(frames), new Float32Array(frames)];
  for (let i = 0; i < frames; i++) {
    source[0][i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / rate);
    source[1][i] = 0.4 * Math.sin((2 * Math.PI * 660 * i) / rate);
  }
  const sourceFile = join(work, 'source.wav');
  writeFileSync(sourceFile, encodePcm16Wav(source, rate));

  const ours = encodePcm16Wav(
    resampleAudio(decodeWav(readFileSync(sourceFile)), RACE_MUSIC_SAMPLE_RATE, RACE_MUSIC_CHANNELS),
    RACE_MUSIC_SAMPLE_RATE);
  const oursFile = join(work, 'ours.wav');
  writeFileSync(oursFile, ours);

  const referenceFile = join(work, 'ffmpeg.wav');
  const ffmpeg = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', sourceFile,
    '-map_metadata', '-1', '-vn', '-ac', '2', '-ar', '36000', '-c:a', 'pcm_s16le', referenceFile],
  { encoding: 'utf8', timeout: 120_000 });
  if (ffmpeg.status !== 0) {
    console.log('note: no ffmpeg on this machine — the WAV comparison is skipped, the round trip below is not');
  } else {
    const reference = readFileSync(referenceFile);
    const ourHeader = Buffer.from(ours.subarray(0, 44));
    // ffmpeg writes a LIST chunk before `data`, so the containers differ in chunk layout by design. What has
    // to agree is the format: PCM, stereo, 36 kHz, 16-bit — the contract `CustomMusicInject` splices in.
    const referenceFormat = decodeWav(new Uint8Array(reference));
    check(ourHeader.toString('ascii', 0, 4) === 'RIFF' && ourHeader.toString('ascii', 8, 12) === 'WAVE'
      && ourHeader.readUInt16LE(20) === 1 && ourHeader.readUInt16LE(22) === RACE_MUSIC_CHANNELS
      && ourHeader.readUInt32LE(24) === RACE_MUSIC_SAMPLE_RATE && ourHeader.readUInt16LE(34) === 16,
    'WAV: the writer emits PCM16 / stereo / 36 kHz, the same format ffmpeg was asked for');
    check(referenceFormat.sampleRate === RACE_MUSIC_SAMPLE_RATE
      && referenceFormat.channels.length === RACE_MUSIC_CHANNELS,
    'WAV: ffmpeg agrees on rate and channel count');

    const mine = decodeWav(ours);
    const frameDelta = Math.abs(mine.channels[0].length - referenceFormat.channels[0].length);
    check(frameDelta <= 2, `WAV: the two transcodes agree on length to within ${frameDelta} frame(s)`);
    // Sample values cannot match byte for byte — ffmpeg resamples with swresample, this interpolates — so the
    // honest measure is how far apart the two waveforms sit. Report it rather than assert an exact match.
    let sum = 0, peak = 0, counted = 0;
    for (let channel = 0; channel < RACE_MUSIC_CHANNELS; channel++) {
      const a = mine.channels[channel], b = referenceFormat.channels[channel];
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const delta = Math.abs(a[i] - b[i]);
        sum += delta * delta; peak = Math.max(peak, delta); counted++;
      }
    }
    const rms = Math.sqrt(sum / Math.max(1, counted));
    console.log(`     vs ffmpeg: RMS ${rms.toFixed(5)} (${(20 * Math.log10(Math.max(rms, 1e-9))).toFixed(1)} dBFS),`
      + ` peak |Δ| ${peak.toFixed(5)}, ${mine.channels[0].length} vs ${referenceFormat.channels[0].length} frames`);
    check(rms < 0.02, `WAV: the staged track tracks ffmpeg's within a quiet residual (RMS ${rms.toFixed(5)})`);
  }

  const round = decodeWav(ours);
  check(round.sampleRate === RACE_MUSIC_SAMPLE_RATE && round.channels.length === RACE_MUSIC_CHANNELS,
    'WAV: the reader recovers the writer\'s rate and channel count');
  const mono = { sampleRate: 8000, channels: [Float32Array.from({ length: 800 },
    (_unused, i) => Math.sin(i / 8)) ] };
  const upmixed = decodeWav(encodePcm16Wav(resampleAudio(mono, RACE_MUSIC_SAMPLE_RATE, RACE_MUSIC_CHANNELS),
    RACE_MUSIC_SAMPLE_RATE));
  check(upmixed.channels.length === 2 && Buffer.from(upmixed.channels[0].buffer)
    .equals(Buffer.from(upmixed.channels[1].buffer)),
  'WAV: a mono source folds up to both sides, as -ac 2 did');

  // ---- ZIP: the platform unzips what the fallback writes -------------------------------------------------
  const files = [
    { path: 'Patches.json', bytes: new TextEncoder().encode('{"Patches":[]}\n') },
    { path: 'Textures/snow.png', bytes: nodeEncodePng({ w: 2, h: 2, data: new Uint8Array(16).fill(180) }) },
    { path: 'Skybox/Meshes/0.obj', bytes: new TextEncoder().encode('v 0 0 0\n') },
  ];
  const archive = join(work, 'MOUNTAIN.zip');
  writeFileSync(archive, Buffer.from(await zipStoreOnly('MOUNTAIN', files).arrayBuffer()));
  const unpacked = join(work, 'unpacked');
  mkdirSync(unpacked);
  // Unpacked by an implementation that had no part in writing it — Python's `zipfile`, which the toolchain
  // already depends on for the ride contract. Its CRC check is the archive's own integrity assertion.
  const expand = spawnSync('python', ['-c',
    'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', archive, unpacked],
  { encoding: 'utf8', timeout: 120_000 });
  if (expand.status !== 0) {
    console.log(`note: no python to unzip with (${(expand.stderr ?? expand.error?.message ?? '').trim()})`
      + ' — the ZIP check is skipped');
  } else {
    check(readdirSync(unpacked).join(',') === 'MOUNTAIN',
      'ZIP: the archive extracts as the map folder itself');
    const same = files.every(file => Buffer.from(file.bytes)
      .equals(readFileSync(join(unpacked, 'MOUNTAIN', ...file.path.split('/')))));
    check(same, 'ZIP: every stored entry comes back byte for byte, nested folders included');
  }

  // ---- mountain ZIP: editable source + custom assets round-trip through the public archive ----------------
  const tile = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
  const tileHash = createHash('sha256').update(tile).digest('hex');
  const mountain = blankMountain('PORTABLE');
  mountain.quadTex = { 0: 'Custom/snow.png' };
  const bundle: ProjectBundle = {
    kind: 'slopesmith-project', schema: 1, name: mountain.name, revision: 7,
    takenAt: '2026-08-09T12:34:56.000Z', document: mountain,
    assets: [{ kind: 'texture', name: 'snow.png', hash: tileHash, size: tile.length }],
    blobs: { [tileHash]: Buffer.from(tile).toString('base64') },
  };
  const portable = createMountainArchive(bundle);
  const checkpoint = createMountainArchive(bundle, { filenameStem: mountain.name, checkpoint: true });
  const mountainZip = join(work, portable.filename);
  writeFileSync(mountainZip, Buffer.from(await portable.blob.arrayBuffer()));
  const roundMountain = await readMountainArchive(portable.blob);
  check(portable.filename === 'PORTABLE-r7-20260809T123456Z.slopesmith.zip'
    && checkpoint.filename === 'PORTABLE-checkpoint-r7-20260809T123456Z.slopesmith.zip'
    && roundMountain.document.name === 'PORTABLE' && roundMountain.revision === 7
    && roundMountain.takenAt === bundle.takenAt,
  'mountain ZIP: the editable document and revision round-trip');
  check(roundMountain.assets.length === 1 && roundMountain.assets[0].name === 'snow.png'
    && roundMountain.blobs?.[tileHash] === bundle.blobs?.[tileHash],
  'mountain ZIP: custom asset metadata and bytes round-trip by hash');
  const corrupted = Buffer.from(await portable.blob.arrayBuffer());
  const payloadAt = corrupted.indexOf(Buffer.from(tile));
  if (payloadAt >= 0) corrupted[payloadAt + tile.length - 1] ^= 0xff;
  let rejectedCorruption = false;
  try { await readMountainArchive(new Blob([corrupted])); }
  catch { rejectedCorruption = true; }
  check(payloadAt >= 0 && rejectedCorruption,
    'mountain ZIP: an entry changed after export is refused by its CRC');

  // A ZIP utility commonly rewrites stored entries with DEFLATE. Import accepts that ordinary ZIP form too.
  const deflatedZip = join(work, 'PORTABLE-deflated.zip');
  const deflate = spawnSync('python', ['-c',
    'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1]) as src, zipfile.ZipFile(sys.argv[2], "w", zipfile.ZIP_DEFLATED) as dst:\n  [dst.writestr(item.filename, src.read(item)) for item in src.infolist()]',
    mountainZip, deflatedZip], { encoding: 'utf8', timeout: 120_000 });
  if (deflate.status !== 0) {
    console.log('note: no python to recompress the mountain ZIP — the DEFLATE import check is skipped');
  } else {
    const deflatedMountain = await readMountainArchive(new Blob([readFileSync(deflatedZip)]));
    check(deflatedMountain.document.name === 'PORTABLE' && deflatedMountain.blobs?.[tileHash] === bundle.blobs?.[tileHash],
      'mountain ZIP: import accepts entries recompressed with ordinary DEFLATE');
  }
} catch (error) {
  recordFailure();
  console.error(error);
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (failures) {
  console.error(`BROWSER EXPORT FAIL (${failures})`);
  process.exitCode = 1;
} else {
  console.log('BROWSER EXPORT PASS');
}
