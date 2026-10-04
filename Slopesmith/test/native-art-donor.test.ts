// tier: fast

/**
 * Where a from-scratch mountain's borrowed trick art comes from (docs/014): each rail material's default tube
 * skin and the gem tier crystals, each off the first extracted level that SHIPS it.
 *
 * The donor used to be simply the first level with prop tables. Extracting a small test track that sorts
 * ahead of the courses (`AUTOTEST1`) quietly made it the donor: it ships no rail tube and no gems, so every
 * rail lost its red/white skin, every gem became a stand-in, and the export baked the tubes untextured.
 * The pin here is that each piece is chosen by the art a level ships, not by where its name sorts.
 *
 * Run: tsx test/native-art-donor.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-native-art-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
const { forgetWorkspaceConfig } = await import('../src/server/workspace-config');
forgetWorkspaceConfig();
const { nativeArtSource } = await import('../src/server/routes/props');

const model = (name: string, mat = -1) => ({ ModelName: name, ModelObjects: [{ MeshData: [{ MaterialID: mat }] }] });
/** A level laid out the way an extraction leaves it; material `i` wears `tex<i>.png`. */
const level = (name: string, models: object[]) => {
  mkdirSync(join(root, name, 'Meshes'), { recursive: true });
  writeFileSync(join(root, name, 'Instances.json'), '{"Instances":[]}');
  writeFileSync(join(root, name, 'Models.json'), JSON.stringify({ Models: models }));
  writeFileSync(join(root, name, 'Materials.json'), JSON.stringify({
    Materials: Array.from({ length: 16 }, (_, i) => ({ TexturePath: `tex${i}.png` })) }));
};
const clearLevels = () => {
  for (const name of ['AUTOTEST1', 'COURSE', 'FOREST', 'PARTIAL', 'PADS']) rmSync(join(root, name), { recursive: true, force: true });
};

try {
  level('AUTOTEST1', [model('Mdl_Start_Gate', 3), model('Mdl_Fence', 4)]);
  level('COURSE', [
    model('Mdl_Tree'), model('Mdl_Rail_Metal_01', 7),
    model('Gem_TrickMultiplier_YellowX2', 11), model('Gem_TrickMultiplier_OrangeX3', 12),
    model('Gem_TrickMultiplier_RedX5', 13), model('Mdl_Icicle_BigA_Chunk2', 3),
  ]);
  level('FOREST', [model('Mdl_Rail_Metal_01', 1), model('Mdl_Tree_BushyTrunk', 9)]);
  level('PADS', [model('Mdl_SpeedBoost_Gold_2000', 2), model('Mdl_TrickBoost_RedGreen_5000', 3)]);
  let art = await nativeArtSource();
  check(art.railSkins.metal === 'COURSE/tex7.png',
    'the metal default is the first SHIPPED rail tube’s own texture, past a level that merely sorts first',
    String(art.railSkins.metal));
  check(art.railSkins.ice === 'COURSE/tex3.png', 'ice borrows the shipped icicle', String(art.railSkins.ice));
  check(art.railSkins.wood === 'FOREST/tex9.png',
    'wood borrows tree bark from whichever level ships a trunk — each default is searched for on its own',
    String(art.railSkins.wood));
  check(art.gemLevel === 'COURSE' && art.gemTiers.map(t => `${t.tier}:${t.model}`).join() === '2:2,3:3,5:4',
    'the three tier crystals come off the level that ships them, by ModelID');
  check(art.boostPads?.speed?.level === 'PADS' && art.boostPads.speed.model === 0
    && art.boostPads.trick?.level === 'PADS' && art.boostPads.trick.model === 1,
  'boost donors are still searched after all gem and rail art has been found');

  // No level carries every tier: take whichever carries most, rather than the first by name.
  clearLevels();
  level('AUTOTEST1', [model('Mdl_Start_Gate', 3), model('Gem_TrickMultiplier_RedX5', 5)]);
  level('PARTIAL', [model('Gem_TrickMultiplier_YellowX2', 5), model('Gem_TrickMultiplier_RedX5', 6)]);
  level('PADS', [model('Mdl_TrickBoost_RedGreen_5000', 3)]);
  art = await nativeArtSource();
  check(art.gemLevel === 'PARTIAL' && art.gemTiers.length === 2, 'with no complete gem set, the fullest one wins');
  check(!art.boostPads?.speed && art.boostPads?.trick?.model === 0,
    'each boost kind resolves independently, without guessing a missing model');

  // Nothing ships the art: no defaults, so tubes bake untextured and gems fall back to their stand-in.
  clearLevels();
  level('AUTOTEST1', [model('Mdl_Start_Gate', 3)]);
  art = await nativeArtSource();
  check(Object.keys(art.railSkins).length === 0 && art.gemLevel === '' && art.gemTiers.length === 0,
    'with no art anywhere the answer is empty rather than a guess');
  check(Object.keys(art.boostPads ?? {}).length === 0, 'without boost art no pad is offered as a donor');
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('native-art-donor: all checks passed');
