// tier: fast
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readReferenceIntroMusicBytes, readReferenceMusicIndex } from '../src/server/routes/reference-music';

const work = mkdtempSync(join(tmpdir(), 'slopesmith-native-intro-'));
process.env.SLOPESMITH_MAPS_ROOT = work;
const wave = Buffer.alloc(44);
wave.write('RIFF');
wave.writeUInt32LE(36, 4);
wave.write('WAVE', 8);
try {
  const folder = join(work, 'SSX_FIXTURE', 'Audio', 'Intro');
  mkdirSync(folder, { recursive: true });
  for (const name of ['auth-A1.wav', 'auth-C10.wav', 'auth-C2.wav', 'end.wav']) writeFileSync(join(folder, name), wave);
  const index = await readReferenceMusicIndex('SSX_FIXTURE');
  assert.deepEqual(index.songs, []);
  assert.deepEqual(index.intro, { tier: 'C', stems: ['auth-C2.wav', 'auth-C10.wav'] });
  assert.deepEqual(await readReferenceIntroMusicBytes('SSX_FIXTURE', 'auth-C2.wav'), wave);
  await assert.rejects(readReferenceIntroMusicBytes('SSX_FIXTURE', 'auth-A1.wav'));
  await assert.rejects(readReferenceIntroMusicBytes('SSX_FIXTURE', '../end.wav'));
  const legacy = join(work, 'LEGACY', 'Audio', 'Music');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(join(legacy, 'song-B1.wav'), wave);
  assert.deepEqual((await readReferenceMusicIndex('LEGACY')).intro, { tier: 'B', stems: ['song-B1.wav'] });
  console.log('Native Intro folder, tier selection, closed sample routes and legacy Music layout PASS');
} finally {
  rmSync(work, { recursive: true, force: true });
}
