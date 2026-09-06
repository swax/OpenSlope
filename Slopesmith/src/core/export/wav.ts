/**
 * The race track's audio contract, both directions: read a WAV, and write the one the repacker consumes.
 *
 * `Music/track.wav` ships PCM16, 36 kHz, stereo — the shape `CustomMusicInject` splices into the target
 * course's PathFinder graph. Getting there is a decode and a resample, and the two providers reach it from
 * different sides: a browser hands WebAudio the source bytes and reads back rendered float channels, while
 * the server parses a RIFF file itself. Both end in `encodePcm16Wav`, so the container is written once.
 */

/** Sample rate the repacker's donor-shaped replacement expects. */
export const RACE_MUSIC_SAMPLE_RATE = 36000;
/** Stereo, because the donor track is. */
export const RACE_MUSIC_CHANNELS = 2;
/** Where the staged track and its arrangement contract land inside the export folder. */
export const STAGED_TRACK = 'Music/track.wav';
export const STAGED_ARRANGEMENT = 'Music/arrangement.json';

/** Deinterleaved audio in the float form both decoders answer with, one array per channel. */
export interface AudioSamples {
  sampleRate: number;
  channels: Float32Array[];
}

const ascii = (bytes: Uint8Array, at: number) =>
  String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

/**
 * Decode a RIFF/WAVE file into float channels.
 *
 * Uncompressed only — PCM 8 / 16 / 24 / 32-bit and IEEE float 32 / 64-bit, including the WAVE_FORMAT_EXTENSIBLE
 * wrapper the common encoders write. That is what an author-owned source has to be for the server to stage it
 * at all: a browser hands anything it can play to WebAudio instead, and this is the path a headless export
 * takes, so it decodes the containers Node itself can read rather than pretending to be a codec library.
 */
export function decodeWav(bytes: Uint8Array): AudioSamples {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 12 || ascii(bytes, 0) !== 'RIFF' || ascii(bytes, 8) !== 'WAVE')
    throw new Error('not a RIFF/WAVE file');

  let format = 0, channelCount = 0, sampleRate = 0, bits = 0;
  let data: Uint8Array | null = null;
  for (let at = 12; at + 8 <= bytes.length;) {
    const id = ascii(bytes, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16) {
      format = view.getUint16(body, true);
      channelCount = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE carries the real format in the first two bytes of its GUID sub-format.
      if (format === 0xfffe && size >= 40) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      data = bytes.subarray(body, Math.min(bytes.length, body + size));
    }
    at = body + size + (size & 1); // chunks are word-aligned
  }
  if (!data || !channelCount || !sampleRate) throw new Error('WAV has no usable fmt / data chunk');
  if (format !== 1 && format !== 3) throw new Error(`unsupported WAV format ${format} (PCM or IEEE float only)`);

  const bytesPerSample = bits >> 3;
  if (!bytesPerSample || (format === 3 && bits !== 32 && bits !== 64))
    throw new Error(`unsupported WAV sample width ${bits}-bit`);
  const frames = Math.floor(data.length / (bytesPerSample * channelCount));
  const channels = Array.from({ length: channelCount }, () => new Float32Array(frames));
  const sample = (at: number): number => {
    if (format === 3) return bits === 32 ? view.getFloat32(at, true) : view.getFloat64(at, true);
    switch (bits) {
      // 8-bit PCM is the one unsigned width in the format.
      case 8: return (bytes[at] - 128) / 128;
      case 16: return view.getInt16(at, true) / 32768;
      case 24: return ((bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 24) >> 8)) / 8388608;
      case 32: return view.getInt32(at, true) / 2147483648;
      default: throw new Error(`unsupported WAV sample width ${bits}-bit`);
    }
  };
  const base = data.byteOffset - bytes.byteOffset;
  for (let frame = 0; frame < frames; frame++)
    for (let channel = 0; channel < channelCount; channel++)
      channels[channel][frame] = sample(base + (frame * channelCount + channel) * bytesPerSample);
  return { sampleRate, channels };
}

/**
 * Resample to `sampleRate` and fold to `channelCount`, linearly.
 *
 * Mono duplicates into both sides and anything wider keeps its first two, which is what `-ac 2` did for the
 * sources this path sees. Linear interpolation is the honest choice for a resampler written here: it is
 * exact when the rates match, and a race track is a bed under engine noise rather than a mastering deliverable.
 */
export function resampleAudio(samples: AudioSamples, sampleRate: number, channelCount: number): Float32Array[] {
  const source = samples.channels;
  if (!source.length) return Array.from({ length: channelCount }, () => new Float32Array(0));
  const ratio = samples.sampleRate / sampleRate;
  const frames = Math.max(1, Math.round(source[0].length / ratio));
  return Array.from({ length: channelCount }, (_unused, channel) => {
    const from = source[Math.min(channel, source.length - 1)];
    const out = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      const at = frame * ratio;
      const left = Math.floor(at);
      const right = Math.min(from.length - 1, left + 1);
      const t = at - left;
      out[frame] = left >= from.length ? 0 : from[left] * (1 - t) + from[right] * t;
    }
    return out;
  });
}

/** Float channels as one PCM16 RIFF/WAVE file: the 44-byte canonical header, then interleaved frames. */
export function encodePcm16Wav(channels: readonly Float32Array[], sampleRate: number): Uint8Array {
  const channelCount = Math.max(1, channels.length);
  const frames = channels[0]?.length ?? 0;
  const dataBytes = frames * channelCount * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);
  const tag = (at: number, text: string) => { for (let i = 0; i < 4; i++) out[at + i] = text.charCodeAt(i); };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);         // PCM fmt chunk size
  view.setUint16(20, 1, true);          // format: PCM
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true); // byte rate
  view.setUint16(32, channelCount * 2, true);              // block align
  view.setUint16(34, 16, true);                            // bits per sample
  tag(36, 'data');
  view.setUint32(40, dataBytes, true);
  let at = 44;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      const value = channels[channel][frame];
      // Round-half-away-from-zero into the asymmetric int16 range, so full-scale input never wraps sign.
      const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
      view.setInt16(at, Math.max(-32768, Math.min(32767, Math.round(clamped * 32767))), true);
      at += 2;
    }
  }
  return out;
}
