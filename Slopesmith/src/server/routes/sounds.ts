import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectAssetPath } from '../project-assets';
import { ensureDir, listDir, pathExists, readBytesOrNull } from '../fs-async';
import { safeDataName, storeUnderFreeName } from './safe-name';

/** The mountain's own hit-sound WAVs, stored under `assets/sounds/<stem>.wav`. Uploads are
 * normalized to canonical PCM16 MONO on store (any PCM8/16/float32, mono or stereo source), so the editor's
 * audition, the test-ride runtime, and the ISO repacker's PS-ADPCM encoder all read one known shape.
 * Bank sounds are mono positional one-shots [Trailmap: 260-audio-files], so stereo averages down. */
const WAV = /\.wav$/i;

/** Cap stored length — a prop hit one-shot, not a music bed. 10 s at 44.1 kHz mono PCM16 ≈ 880 kB. */
const MAX_CUSTOM_SOUND_SECONDS = 10;

interface DecodedWav {
  rate: number;
  /** mono s16 */
  samples: Int16Array;
}

function chunkAt(bytes: Buffer, id: string): { offset: number; size: number } | null {
  // RIFF chunk walk: [4 id][u32 LE size][payload, padded to even]
  let at = 12;
  while (at + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    if (chunkId === id) return { offset: at + 8, size: Math.min(size, bytes.length - at - 8) };
    at += 8 + size + (size & 1);
  }
  return null;
}

function decodeWav(bytes: Buffer): DecodedWav {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a RIFF WAV file');
  const fmt = chunkAt(bytes, 'fmt ');
  const data = chunkAt(bytes, 'data');
  if (!fmt || !data) throw new Error('WAV is missing its fmt or data chunk');
  const format = bytes.readUInt16LE(fmt.offset);
  const channels = bytes.readUInt16LE(fmt.offset + 2);
  const rate = bytes.readUInt32LE(fmt.offset + 4);
  const bits = bytes.readUInt16LE(fmt.offset + 14);
  if (channels < 1 || channels > 2) throw new Error(`unsupported channel count ${channels}`);
  if (rate < 4000 || rate > 48000) throw new Error(`unsupported sample rate ${rate}`);

  const frameBytes = channels * (bits / 8);
  const frames = Math.floor(data.size / frameBytes);
  const readSample = (frame: number, channel: number): number => {
    const at = data.offset + frame * frameBytes + channel * (bits / 8);
    if (format === 1 && bits === 16) return bytes.readInt16LE(at);
    if (format === 1 && bits === 8) return (bytes.readUInt8(at) - 128) * 256; // WAV 8-bit is unsigned
    if (format === 3 && bits === 32) return Math.max(-32768, Math.min(32767, Math.round(bytes.readFloatLE(at) * 32767)));
    throw new Error(`unsupported WAV encoding (format ${format}, ${bits}-bit)`);
  };
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    samples[i] = channels === 1 ? readSample(i, 0)
      : Math.max(-32768, Math.min(32767, Math.round((readSample(i, 0) + readSample(i, 1)) / 2)));
  }
  return { rate, samples };
}

function encodeWavPcm16Mono(wav: DecodedWav): Buffer {
  const dataBytes = wav.samples.length * 2;
  const out = Buffer.alloc(44 + dataBytes);
  out.write('RIFF', 0, 'ascii'); out.writeUInt32LE(36 + dataBytes, 4); out.write('WAVE', 8, 'ascii');
  out.write('fmt ', 12, 'ascii'); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(wav.rate, 24); out.writeUInt32LE(wav.rate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write('data', 36, 'ascii'); out.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < wav.samples.length; i++) out.writeInt16LE(wav.samples[i], 44 + i * 2);
  return out;
}

const soundsDir = () => projectAssetPath('sounds');

/** Store an uploaded WAV as a custom hit sound (normalized PCM16 mono, length-capped). A name that is taken
 * lands beside the original as `name_2` rather than over it, like every uploaded asset (docs/038). Returns
 * the stored file name. */
export async function saveCustomSound(name: string, bytes: Buffer): Promise<string> {
  const wav = decodeWav(bytes);
  const maxSamples = wav.rate * MAX_CUSTOM_SOUND_SECONDS;
  if (wav.samples.length > maxSamples) wav.samples = wav.samples.subarray(0, maxSamples);
  if (!wav.samples.length) throw new Error('WAV has no samples');
  const pcm = encodeWavPcm16Mono(wav);
  const { name: stem } = await storeUnderFreeName({
    library: soundsDir(),
    name: name.replace(WAV, ''),
    fallback: 'sound',
    taken: candidate => pathExists(join(soundsDir(), `${candidate}.wav`)),
    write: async stored => {
      await ensureDir(soundsDir());
      await writeFile(join(soundsDir(), `${stored}.wav`), pcm);
    },
  });
  return `${stem}.wav`;
}

/** Store a WAV under the name it was ASKED for, reusing the file when the bytes already match.
 *
 * `saveCustomSound` deliberately never overwrites: an upload that collides lands beside the original as
 * `name_2`, because an author's asset is theirs. A generated fixture asset wants the opposite — the auto-test
 * mountain is rebuilt on every pass and would otherwise leave `zz-autotest-tone_2`, `_3`, `_4` behind while
 * the cell it is authored for points at a different file each run. Same argument, and same shape, as
 * `saveSharedCustomTexture`.
 */
export async function saveSharedCustomSound(name: string, bytes: Buffer): Promise<string> {
  const wav = decodeWav(bytes);
  if (!wav.samples.length) throw new Error('WAV has no samples');
  const maxSamples = wav.rate * MAX_CUSTOM_SOUND_SECONDS;
  if (wav.samples.length > maxSamples) wav.samples = wav.samples.subarray(0, maxSamples);
  const pcm = encodeWavPcm16Mono(wav);
  const stem = safeDataName(name.replace(WAV, ''));
  if (!stem) throw new Error(`"${name}" is not a usable sound name`);
  await ensureDir(soundsDir());
  const path = join(soundsDir(), `${stem}.wav`);
  // Rewriting identical bytes is harmless but moves the mtime the response cache validates against, so
  // every viewer would refetch a clip that did not change.
  const stored = await readBytesOrNull(path);
  if (!stored || !stored.equals(pcm)) await writeFile(path, pcm);
  return `${stem}.wav`;
}

export async function readCustomSoundBytes(name: string): Promise<Buffer> {
  const stem = safeDataName(name.replace(WAV, ''));
  const bytes = stem ? await readBytesOrNull(join(soundsDir(), `${stem}.wav`)) : null;
  if (!bytes) throw new Error(`no custom sound ${name}`);
  return bytes;
}

export async function listCustomSounds(): Promise<string[]> {
  return (await listDir(soundsDir())).filter(f => WAV.test(f)).sort();
}
