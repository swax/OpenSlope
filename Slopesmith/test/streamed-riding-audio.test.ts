// tier: fast
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-riding-routes-'));
const previous = process.env.SLOPESMITH_MAPS_ROOT;
process.env.SLOPESMITH_MAPS_ROOT = root;
try {
  for (const [level, bank, value] of [
    ['SSX3_A', 'first', 'ssx3'],
    ['SSXOT_ER1_DAY', 'SECOND', 'tour'],
  ]) {
    const audio = join(root, level, 'Audio');
    mkdirSync(join(audio, 'SFX', bank), { recursive: true });
    writeFileSync(
      join(audio, 'SoundIndex.json'),
      JSON.stringify({
        Schema: 'openslope-sound-index/v1',
        Level: level,
        Banks: { '1': bank.toLowerCase() },
        NamedBanks: {},
        CollisionEvents: {},
        ResolverState: 'Deferred',
      }),
    );
    writeFileSync(join(audio, 'SFX', bank, '004.wav'), `${value}-attack`);
    writeFileSync(join(audio, 'SFX', bank, '004.loop.wav'), `${value}-sustain`);
  }
  const { boardSoundSource, readBoardSoundBytes } = await import('../src/server/routes/audio');
  assert.equal((await boardSoundSource('zboard', 'SSX3_A'))?.level, 'SSX3_A');
  assert.equal((await boardSoundSource('zboard', 'SSX3_A'))?.bank, 'first');
  assert.equal((await boardSoundSource('zboard', 'SSXOT_ER1_DAY'))?.bank, 'SECOND');
  assert.equal((await readBoardSoundBytes('zboard', 4, true, 'SSX3_A')).toString(), 'ssx3-sustain');
  assert.equal((await readBoardSoundBytes('zboard', 4, false, 'SSXOT_ER1_DAY')).toString(), 'tour-attack');
  assert.equal((await readBoardSoundBytes('zboard', 4, true, 'SSXOT_ER1_DAY')).toString(), 'tour-sustain');
  await assert.rejects(readBoardSoundBytes('zboard', 4, true, 'MISSING'));
  await assert.rejects(readBoardSoundBytes('zboard', 5, true, 'SSX3_A'));
  writeFileSync(join(root, 'SSXOT_ER1_DAY', 'Audio', 'SFX', 'SECOND', '005.wav'), 'tour-only');
  assert.equal((await readBoardSoundBytes('zboard', 5, false, 'SSXOT_ER1_DAY')).toString(), 'tour-only');
  await assert.rejects(readBoardSoundBytes('zboard', 5, false), 'global audio keeps one consistent source bank');
  assert.equal(await boardSoundSource('zboard', '../SSX3_A'), null);
  const adapted = join(root, 'SSX3_ADAPTED', 'Audio');
  mkdirSync(join(adapted, 'SFX', 'openslope_board'), { recursive: true });
  mkdirSync(join(adapted, 'SFX', 'original'), { recursive: true });
  writeFileSync(
    join(adapted, 'SoundIndex.json'),
    JSON.stringify({
      Schema: 'openslope-sound-index/v1',
      Level: 'SSX3_ADAPTED',
      Banks: { '1': 'openslope_board' },
      NamedBanks: { BOARD: 'original' },
      CollisionEvents: {},
    }),
  );
  writeFileSync(join(adapted, 'SFX', 'original', '035.loop.wav'), 'metal-sustain');
  writeFileSync(join(adapted, 'SFX', 'openslope_board', '052.loop.wav'), 'old-clank');
  writeFileSync(join(adapted, 'SFX', 'openslope_board', '052.wav'), 'attack');
  assert.equal((await readBoardSoundBytes('zboard', 52, true, 'SSX3_ADAPTED')).toString(), 'metal-sustain');
  assert.equal((await readBoardSoundBytes('zboard', 52, false, 'SSX3_ADAPTED')).toString(), 'attack');
  const tricky = join(root, 'GARI', 'Audio'),
    madtrix = join(root, 'MADTRIX_LV_LAS_VEGAS', 'Audio');
  for (const [folder, banks, fallback] of [
    [tricky, { '1': 'zboard', '0': 'zbxsfx' }, undefined],
    [madtrix, { '1': 'openslope_board' }, 'ssx-tricky'],
  ] as const) {
    mkdirSync(join(folder, 'SFX', banks['1']), { recursive: true });
    writeFileSync(
      join(folder, 'SoundIndex.json'),
      JSON.stringify({
        Schema: 'openslope-sound-index/v1',
        Level: '',
        Banks: banks,
        CollisionEvents: {},
        ...(fallback ? { RidingFallback: fallback } : {}),
      }),
    );
  }
  mkdirSync(join(tricky, 'SFX', 'zbxsfx'), { recursive: true });
  writeFileSync(join(tricky, 'SFX', 'zboard', '004.loop.wav'), 'tricky-glide');
  writeFileSync(join(tricky, 'SFX', 'zboard', '002.wav'), 'tricky-jump');
  writeFileSync(join(tricky, 'SFX', 'zbxsfx', '120.loop.wav'), 'tricky-boost');
  writeFileSync(join(madtrix, 'SFX', 'openslope_board', '004.loop.wav'), 'madtrix-ski');
  assert.equal((await readBoardSoundBytes('zboard', 4, true, 'MADTRIX_LV_LAS_VEGAS')).toString(), 'madtrix-ski');
  assert.equal((await readBoardSoundBytes('zboard', 2, false, 'MADTRIX_LV_LAS_VEGAS')).toString(), 'tricky-jump');
  assert.equal((await readBoardSoundBytes('zbxsfx', 120, true, 'MADTRIX_LV_LAS_VEGAS')).toString(), 'tricky-boost');
  assert.equal((await boardSoundSource('zbxsfx', 'MADTRIX_LV_LAS_VEGAS'))?.level, 'GARI');
  await assert.rejects(readBoardSoundBytes('zboard', 2, false, 'SSX3_A'), 'fallback requires explicit map metadata');
  console.log(
    'Common riding audio: map-specific banks, loop/attack selection, case matching and explicit Tricky fallback PASS',
  );
} finally {
  if (previous === undefined) delete process.env.SLOPESMITH_MAPS_ROOT;
  else process.env.SLOPESMITH_MAPS_ROOT = previous;
  rmSync(root, { recursive: true, force: true });
}
