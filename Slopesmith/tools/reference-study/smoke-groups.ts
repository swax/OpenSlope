import { readLevelGroups } from '../../src/server/routes/groups';

// Smoke the group mining (docs/015) against extracted levels: expect MERQUER to recover the fire hydrant
// (base + lid ×25), the directional sign (stand + sign ×57) and the street lamp + halo spot fixture.
for (const level of process.argv.slice(2).length ? process.argv.slice(2) : ['MERQUER', 'GARI']) {
  const p = await readLevelGroups(level);
  console.log(`\n=== ${level}: ${p.groups.length} group(s)`);
  for (const g of p.groups) {
    const lights = g.lights.map(L =>
      `${L.kind} ${L.color} ×${L.intensity.toFixed(1)} rel(${L.relPos.map(v => v.toFixed(1)).join(',')})m aim(${L.dir.map(v => v.toFixed(2)).join(',')}) reach ${L.reach.toFixed(0)}m`);
    console.log(`- [${g.id}] ${g.name} ×${g.occurrences}: ${g.props.map(m => m.name).join(' + ')}`);
    for (const L of lights) console.log(`    ✸ ${L}`);
  }
}
