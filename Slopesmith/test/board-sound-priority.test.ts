// tier: fast
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-board-priority-'));
const maps = join(root, 'Maps');
const previousMaps = process.env.SLOPESMITH_MAPS_ROOT;
const previousWorkspace = process.env.SLOPESMITH_WORKSPACE_ROOT;
process.env.SLOPESMITH_MAPS_ROOT = maps;
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
const choices = [
  ['Z_RENAMED_TRICKY', 'ssx-tricky'],
  ['SSX3_FALLBACK', 'ssx-3'],
  ['SSXOT_FALLBACK', 'ssx-on-tour'],
  ['MADTRIX_FALLBACK', 'jonny-moseley-mad-trix'],
  ['AVALANCHE_FALLBACK', '1080-avalanche'],
  ['SSXGBA_FALLBACK', 'ssx-tricky-gba'],
] as const;
let api: Awaited<ReturnType<typeof import('../src/server/main').startApiService>> | undefined;
try {
  choices.forEach(([name, game], group) => {
    const audio = join(maps, name, 'Audio');
    const board = game === 'ssx-tricky' ? 'zboard' : 'openslope_board';
    const boost = game === 'ssx-tricky' ? 'zbxsfx' : 'openslope_main';
    for (const bank of [board, boost]) mkdirSync(join(audio, 'SFX', bank), { recursive: true });
    writeFileSync(
      join(audio, 'SoundIndex.json'),
      JSON.stringify({
        Schema: 'openslope-sound-index/v1',
        Level: name,
        Banks: { '1': board, '0': boost },
        CollisionEvents: {},
      }),
    );
    writeFileSync(join(audio, 'RidingImport.json'), JSON.stringify({ Game: game }));
    writeFileSync(
      join(audio, 'BoardSoundIndex.json'),
      JSON.stringify({ Schema: 'openslope-board-sound-index/v1', SurfaceGroups: [group] }),
    );
    writeFileSync(join(audio, 'SFX', board, '004.loop.wav'), `${game}-glide`);
    writeFileSync(join(audio, 'SFX', boost, '120.loop.wav'), `${game}-boost`);
    if (group === 5) writeFileSync(join(audio, 'SFX', board, '099.wav'), 'gba-only');
  });
  const { boardSoundSource, readBoardSoundBytes } = await import('../src/server/routes/audio');
  assert.equal((await readBoardSoundBytes('zboard', 4, true, 'SSXGBA_FALLBACK')).toString(), 'ssx-tricky-gba-glide');
  await assert.rejects(
    readBoardSoundBytes('zboard', 99, false),
    'a missing clip must not mix another game into the selected bank',
  );
  const { startApiService } = await import('../src/server/main');
  api = await startApiService({ host: '127.0.0.1', port: 0 });
  const metadata = await (await fetch(`${api.url}/api/board-audio`)).json();
  assert.equal(metadata.board, choices[0][0]);
  assert.equal(metadata.boost, choices[0][0]);
  assert.deepEqual(metadata.surfaceGroups, [0], 'surface routing comes from the preferred bank, even without Shared');
  await api.close();
  api = undefined;
  for (const [name, game] of choices) {
    const [board, boost, glide] = await Promise.all([
      boardSoundSource('zboard'),
      boardSoundSource('zbxsfx'),
      readBoardSoundBytes('zboard', 4, true),
    ]);
    assert.equal(board?.level, name);
    assert.equal(boost?.level, name);
    assert.equal(glide.toString(), `${game}-glide`);
    assert.equal((await readBoardSoundBytes('zbxsfx', 120, true)).toString(), `${game}-boost`);
    rmSync(join(maps, name), { recursive: true, force: true });
  }
  assert.equal(await boardSoundSource('zboard'), null);
  const shared = join(maps, 'Shared', 'Audio', 'SFX', 'zboard');
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, '004.loop.wav'), 'legacy-tricky');
  assert.equal((await readBoardSoundBytes('zboard', 4, true)).toString(), 'legacy-tricky');
  console.log(
    'Board sound priority: all six games, renamed metadata, routing, explicit references, bank consistency and live ref removal PASS.',
  );
} finally {
  await api?.close();
  if (previousMaps === undefined) delete process.env.SLOPESMITH_MAPS_ROOT;
  else process.env.SLOPESMITH_MAPS_ROOT = previousMaps;
  if (previousWorkspace === undefined) delete process.env.SLOPESMITH_WORKSPACE_ROOT;
  else process.env.SLOPESMITH_WORKSPACE_ROOT = previousWorkspace;
  rmSync(root, { recursive: true, force: true });
}
