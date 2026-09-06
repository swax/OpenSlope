import type { RaceMusicArrangement } from '../../core/doc/types';
import { textFile } from '../../core/export/files';
import type { StagedRaceMusic } from '../../core/export/provider';
import {
  encodePcm16Wav, RACE_MUSIC_CHANNELS, RACE_MUSIC_SAMPLE_RATE, STAGED_ARRANGEMENT, STAGED_TRACK,
} from '../../core/export/wav';
import { normalizeRaceMusicArrangement } from '../../core/music/arrangement';
import { assetBytes } from '../net/asset-bytes';
import { customMusicUrl } from '../net/asset-paths';

/**
 * Race-music staging in the browser: WebAudio is the transcoder.
 *
 * `Music/track.wav` ships PCM16, 36 kHz, stereo. `decodeAudioData` on a context at that rate resamples as it
 * decodes, and rendering the result through an `OfflineAudioContext(2, …)` folds a mono source up to both
 * sides — so the pair reproduces exactly what the contract asks for, for every container the browser can
 * play, without anything having to be installed. `encodePcm16Wav` writes the container, the same one a
 * headless export writes.
 */
export async function stageRaceMusic(selection: string | null | undefined,
  authoredArrangement: RaceMusicArrangement | undefined,
  existingTrack: (path: string) => Promise<boolean>): Promise<StagedRaceMusic> {
  if (selection === undefined)
    return { status: 'legacy', files: [], remove: [], existing: await existingTrack(STAGED_TRACK) };
  if (selection === null || !selection.trim()) {
    return { status: 'cleared', files: [], remove: [STAGED_TRACK, STAGED_ARRANGEMENT],
      existing: await existingTrack(STAGED_TRACK) };
  }

  const source = await assetBytes(customMusicUrl(selection));
  const track = encodePcm16Wav(await renderRaceTrack(source), RACE_MUSIC_SAMPLE_RATE);
  const arrangement = normalizeRaceMusicArrangement(authoredArrangement);
  return {
    status: 'staged',
    files: [
      { path: STAGED_TRACK, bytes: track },
      textFile(STAGED_ARRANGEMENT, `${JSON.stringify({ version: 1, ...arrangement }, null, 2)}\n`),
    ],
    remove: [],
    mode: arrangement.mode,
    bytes: track.length,
  };
}

async function renderRaceTrack(source: Uint8Array): Promise<Float32Array[]> {
  // decodeAudioData resamples into the context it is called on, so the rate is settled before any rendering
  // starts. The bytes are copied because decoding DETACHES the buffer it is handed, and the byte cache still
  // holds this one.
  const probe = new OfflineAudioContext(RACE_MUSIC_CHANNELS, 1, RACE_MUSIC_SAMPLE_RATE);
  const decoded = await probe.decodeAudioData(source.slice().buffer as ArrayBuffer);

  const frames = Math.max(1, Math.ceil(decoded.duration * RACE_MUSIC_SAMPLE_RATE));
  const render = new OfflineAudioContext(RACE_MUSIC_CHANNELS, frames, RACE_MUSIC_SAMPLE_RATE);
  const player = render.createBufferSource();
  player.buffer = decoded;
  player.connect(render.destination);
  player.start();
  const rendered = await render.startRendering();
  return Array.from({ length: RACE_MUSIC_CHANNELS }, (_unused, channel) => rendered.getChannelData(channel));
}
