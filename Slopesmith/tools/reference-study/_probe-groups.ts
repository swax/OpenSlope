import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readModelGeometries } from '../../src/server/routes/props';
import { mapsRoot } from '../../src/server/workspace-config';

// Known model sizes fix the unit and the up-axis before trusting any tree number.
const WANT: Record<string, RegExp> = {
  MEGAPLE: /^(Mdl_MediaTower_Tall_4|Mdl_StartGate_1000|Mdl_Platform_C_0|Mdl_FinnishGate_0)$/,
  GARI: /^(Mdl_Tree_(Sparce|Bushy)(Leaves|Trunk)_1000|Mdl_TreeH_SnowLeaves_7|Mdl_TreeI_SnowLeaves_2|Mdl_RockBoulder_Alps[BCE]_(Snow|SharpSnow)_2)$/,
  ELYSIUM: /^(Mdl_Tree_SnowGhost_1000|Mdl_Tree(Leaves|Trunk)_G_Snow_1000)$/,
  MESA: /^(Mdl_TreeLeaves_EvergreenA_1003|Mdl_TreeTrunk_EvergreenB_1004)$/,
};
for (const [level, want] of Object.entries(WANT)) {
  const models = JSON.parse(await readFile(join(mapsRoot(), level, 'Models.json'), 'utf8')) as { Models: { ModelName: string }[] };
  const ids = new Set<number>();
  models.Models.forEach((m, id) => { if (want.test(m.ModelName)) ids.add(id); });
  const geoms = await readModelGeometries(level, ids);
  console.log(`--- ${level}`);
  for (const [id, g] of [...geoms].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const sub of g.subs) {
      for (let i = 0; i < sub.positions.length; i += 3) for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], sub.positions[i + k]); hi[k] = Math.max(hi[k], sub.positions[i + k]);
      }
    }
    const s = hi.map((v, k) => v - lo[k]);
    console.log(`  #${String(id).padStart(4)} ${g.name.padEnd(32)} raw ${s.map(v => v.toFixed(1).padStart(7)).join(' ')}`
      + `   /100 -> ${s.map(v => (v / 100).toFixed(2).padStart(6)).join(' ')}   loY ${lo[1].toFixed(0)} rot ${JSON.stringify(g.rotation ?? null)}`);
  }
}
