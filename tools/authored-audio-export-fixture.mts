/** Synthetic public-export fixture for Native audio interoperability; no private media. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { buildExportFolder } from '../Slopesmith/src/core/export/folder.ts';
import { blankMountain } from '../Slopesmith/src/core/doc/mountain.ts';
import type { ExportProvider } from '../Slopesmith/src/core/export/provider.ts';

function tone(hz: number | ((seconds: number) => number), rate = 8000, seconds = 1, channels = 1): Uint8Array {
  const frames = Math.round(rate * seconds), bytes = new Uint8Array(44 + frames * channels * 2), v = new DataView(bytes.buffer);
  const text = (at: number, value: string) => [...value].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  text(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * channels * 2, true); v.setUint16(32, channels * 2, true);
  v.setUint16(34, 16, true); text(36, 'data'); v.setUint32(40, frames * channels * 2, true);
  for (let i = 0; i < frames; ++i) {
    const frequency = typeof hz === 'function' ? hz(i / rate) : hz;
    for (let c = 0; c < channels; ++c)
      v.setInt16(44 + (i * channels + c) * 2, Math.round(6000 * Math.sin(2 * Math.PI * frequency * i / rate)), true);
  }
  return bytes;
}
const withMusic = process.argv.includes('--music');
const arrangement = { version: 1, mode: 'linear-loop', bpm: 120, loopStartSeconds: .5, loopEndSeconds: 1 };
const master = withMusic ? tone(t => t < .5 ? 220 : t < 1 ? 660 : 1100, 36000, 2, 2) : new Uint8Array();
const provider = {
  groupDefs: async () => new Map(),
  modelGeometry: async () => () => ({ subs: [{ mat: -1,
    positions: new Float32Array([-50,-300,0, 50,-300,0, 50,300,0, -50,300,0, -50,-300,400, 50,-300,400, 50,300,400, -50,300,400]),
    uvs: new Float32Array(16), indices: new Uint32Array([0,1,2,0,2,3,0,4,5,0,5,1,1,5,6,1,6,2,2,6,7,2,7,3,3,7,4,3,4,0,4,7,6,4,6,5]) }] }),
  materialTables: async () => new Map(), importedProps: async () => ({ models: [], instances: [] }),
  nativeArt: async () => ({ gemLevel: '', gemTiers: [], railSkins: {} }),
  referenceTexture: async () => new Uint8Array(), particleTexture: async () => new Uint8Array(),
  customSound: async (file: string) => tone(file === 'impact.wav' ? 880 : 660),
  soundIndex: async () => null, courseEffectSound: async () => tone(330), namedEffectSound: async () => tone(330),
  environmentEffectSound: async () => tone(110), skybox: async () => ({ files: [], log: [] }),
  discRecipePaths: async () => ({ exportDir: 'AUDIOTEST', levelData: 'Maps/DONOR', levelDataRelative: '../DONOR' }),
  stageRaceMusic: async () => withMusic ? { status: 'staged', mode: arrangement.mode, bytes: master.length, files: [
    { path: 'Music/track.wav', bytes: master },
    { path: 'Music/arrangement.json', bytes: new TextEncoder().encode(JSON.stringify(arrangement)) },
  ], remove: [] } : { status: 'cleared', files: [], remove: [] },
} as unknown as ExportProvider;
const doc = { ...blankMountain('AUDIOTEST'),
  boardSound: { enabled: !withMusic, volume: .4, glide: .7, carve: .8, transients: .7, cues: .8 },
  ...(withMusic ? { raceMusic: 'fixture.wav', raceMusicArrangement: arrangement } : {}),
  props: withMusic ? [] : [
    { id: 'impact', level: 'DONOR', model: 1, name: 'Mdl_Box', pos: [0,0,0], yaw: 0, scale: 1,
      collisionSoundFile: 'impact.wav', nativeCollision: { mode: 1, playerCollision: true, responseMass: 0, playerBounce: false, bounceAmount: 0 } },
    { id: 'bed', level: 'DONOR', model: 1, name: 'Mdl_Box', pos: [10,0,0], yaw: 0, scale: 1, ambientSoundFile: 'bed.wav' },
  ],
};
const folder = await buildExportFolder(doc as never, provider, { lighting: false });
const output = resolve(process.argv[2]);
for (const file of folder.files) {
  const path = join(output, file.path); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, file.bytes);
}
console.log('Wrote synthetic public export to ' + output);
