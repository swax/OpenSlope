// tier: fast

/**
 * A rail tube's texture (docs/014): its material picks a default, and a rail's own pick overrides it.
 * Run: tsx test/rail-textures.test.ts
 *
 * What this pins is the one rule the viewport, the Tools swatch and the export bake all ask
 * (`railTubeTexture`), and that the bake ships exactly what that rule answers — so a tube never previews in
 * one skin and packs in another.
 */
import { buildMaterialCombiner } from '../src/core/export/materials';
import { bakeRailTubes } from '../src/core/export/props';
import {
  railTubeTexture, RAIL_STYLE_ICE, RAIL_STYLE_METAL, RAIL_STYLE_WOOD, type RailSkins,
} from '../src/core/rails/rails';
import type { Rail } from '../src/core/doc/types';
import { check, failures } from './check';

const skins: RailSkins = { metal: 'GARI/0077.png', wood: 'GARI/0038.png' }; // no ice default on this machine
const nodes: Rail['nodes'] = [[0, 2, 0], [6, 2, 0], [12, 2, 3]];
const rail = (extra: Partial<Rail>): Rail => ({ id: 'rail:0000', nodes, height: 2, ...extra });

// ---- the rule
check(railTubeTexture(rail({}), skins) === 'GARI/0077.png', 'a rail with no style is metal, in the metal default');
check(railTubeTexture(rail({ style: RAIL_STYLE_WOOD }), skins) === 'GARI/0038.png',
  'the material picks the default: wood wears the wood skin');
check(railTubeTexture(rail({ style: RAIL_STYLE_ICE }), skins) === null,
  'a material with no default is untextured rather than borrowing another material’s');
check(railTubeTexture(rail({ style: RAIL_STYLE_WOOD, texture: 'Custom/plank.png' }), skins) === 'Custom/plank.png',
  'a rail’s own pick overrides its material’s default');
check(railTubeTexture(rail({ style: RAIL_STYLE_METAL, texture: '' }), skins) === null,
  'an own pick of "" is a deliberate no-texture, not a fall back to the default');
check(railTubeTexture(rail({ style: RAIL_STYLE_ICE, texture: 'GARI/0077.png' }), {}) === 'GARI/0077.png',
  'an own pick needs no defaults at all');

// ---- the bake ships what the rule answers
const combiner = buildMaterialCombiner(new Map([
  ['GARI', Array.from({ length: 80 }, (_, i) => ({ TexturePath: `${String(i).padStart(4, '0')}.png`, UnknownInt18: 86024 }))],
]));
const rails: Rail[] = [
  rail({ id: 'rail:0000', name: 'Metal' }),
  rail({ id: 'rail:0001', name: 'Plank', style: RAIL_STYLE_WOOD, texture: 'Custom/plank.png' }),
  rail({ id: 'rail:0002', name: 'Ice', style: RAIL_STYLE_ICE }),
  rail({ id: 'rail:0003', name: 'Metal2' }),
  rail({ id: 'rail:0004', name: 'Bare', bare: true, texture: 'Custom/unused.png' }),
];
const baked = bakeRailTubes(rails, 0, 0, combiner, skins);
const slotOf = (name: string) => baked.groups.find(g => g.name.endsWith(`_${name}`))?.subs[0].slot;
const texOf = (slot: number | undefined) => slot !== undefined && slot >= 0 ? combiner.materials[slot].TexturePath : null;
check(baked.tubes === 4, 'every piped rail bakes a tube; the bare one ships its spline alone', String(baked.tubes));
check(texOf(slotOf('Metal')) === 'p_GARI_0077.png', 'the metal tube ships the metal default tile',
  String(texOf(slotOf('Metal'))));
check(slotOf('Metal2') === slotOf('Metal'), 'two rails wearing one tile share one material slot');
check(texOf(slotOf('Plank')) === 'p_Custom_plank.png', 'an own pick ships, Custom art included');
check(slotOf('Ice') === -1 && /usemtl mat_untextured/.test(baked.obj), 'no default and no pick bakes untextured');
check(combiner.texCopies.some(c => c.level === 'Custom' && c.name === 'plank.png')
  && !combiner.texCopies.some(c => c.name === 'unused.png'),
  'the picked tile is queued to copy into the export; a bare rail’s pick is not, as it has no tube to wear it');
check(baked.textures.join() === 'GARI/0077.png,Custom/plank.png' && baked.untextured === 1,
  'the bake reports the tiles it used and how many tubes went untextured, for the export log');

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('rail-textures: all checks passed');
