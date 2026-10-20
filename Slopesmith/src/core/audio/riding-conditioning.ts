import tuning from '../../../../Contracts/streamed-riding-audio-v1.json';

type RidingRole = keyof typeof tuning.rms;
export const adaptedRidingPitch = (rail: boolean, response: number): number => {
  const value = Number.isFinite(response) ? Math.max(0, Math.min(1, response)) : 0;
  return rail
    ? tuning.pitch.railMin + (tuning.pitch.railMax - tuning.pitch.railMin) * value
    : tuning.pitch.base + tuning.pitch.bendSpan * value;
};
export function adaptedRidingRole(bank: string, slot: number): RidingRole | null {
  if (!Number.isInteger(slot)) return null;
  if (bank.toLowerCase() === 'openslope_board' && slot >= 0 && slot < 80)
    return ({ 1: 'land', 2: 'jump', 3: 'carve', 4: 'glide' } as const)[(slot % 8) as 1 | 2 | 3 | 4] ?? null;
  if (bank.toLowerCase() === 'openslope_rider') {
    if (slot === 32) return 'wind';
    if (slot >= 120 && slot <= 122) return 'boost';
  }
  return null;
}

/** First-party playback policy. Clone before processing so shared decoded source buffers remain intact. */
export function conditionRidingPcm(source: readonly Float32Array[], rate: number, bank: string, slot: number) {
  const role = adaptedRidingRole(bank, slot);
  if (!role) return null;
  const frames = source[0]?.length ?? 0;
  if (
    source.length < 1 ||
    source.length > 2 ||
    !Number.isFinite(rate) ||
    rate < 8000 ||
    rate > 192000 ||
    !frames ||
    frames * source.length > 32 * 1024 * 1024 ||
    source.some(channel => channel.length !== frames || channel.some(value => !Number.isFinite(value)))
  )
    throw new Error('Invalid adapted riding PCM');
  const channels = source.map(channel => channel.slice());
  const continuous = role !== 'land' && role !== 'jump';
  const edgeFrames = continuous ? Math.min(Math.floor(rate * tuning.loopEdgeSeconds + 0.5), Math.floor(frames / 8)) : 0;
  let beforeSquares = 0;
  for (const channel of channels) {
    let mean = 0;
    for (const value of channel) {
      mean += value;
      beforeSquares += value * value;
    }
    if (!continuous) continue;
    mean /= frames;
    for (let i = 0; i < frames; i++) channel[i] -= mean;
    if (edgeFrames < 2) continue;
    const first = channel[0],
      last = channel[frames - 1],
      join = (first + last) * 0.5;
    for (let i = 0; i < edgeFrames; i++) {
      const weight = 0.5 * (1 + Math.cos((Math.PI * i) / (edgeFrames - 1)));
      channel[i] += (join - first) * weight;
      channel[frames - 1 - i] += (join - last) * weight;
    }
  }
  let squares = 0,
    peak = 0;
  for (const channel of channels)
    for (const value of channel) {
      squares += value * value;
      peak = Math.max(peak, Math.abs(value));
    }
  const rms = Math.sqrt(squares / (frames * channels.length));
  const ceiling = continuous ? tuning.peak.continuous : tuning.peak.transient;
  const gain = Math.min(1, rms > 0 ? tuning.rms[role] / rms : 1, peak > 0 ? ceiling / peak : 1);
  for (const channel of channels) for (let i = 0; i < frames; i++) channel[i] *= gain;
  return {
    channels,
    gain,
    edgeFrames,
    rmsBefore: Math.sqrt(beforeSquares / (frames * channels.length)),
    rmsAfter: rms * gain,
    peakAfter: peak * gain,
  };
}
