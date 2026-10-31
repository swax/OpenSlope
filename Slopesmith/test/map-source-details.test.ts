import assert from 'node:assert/strict';
import { mapSourceDetails, registerMapSources, watchMapSources } from '../src/app/state/map-sources';
import { configureWorkspace } from '../src/app/net/workspace';

registerMapSources('details', [
  { name: 'local:SSX3_ARA1', game: 'ssx-3', displayName: 'Disc Snow Jam' },
  { name: 'server:SSX3_ARA1', game: 'ssx-3', displayName: 'Server Snow Jam' },
  { name: 'Custom', game: 'slopesmith', label: 'My Mountain' },
]);
assert.deepEqual(mapSourceDetails('local:SSX3_ARA1'), { source: 'Local', game: 'SSX 3', map: 'Disc Snow Jam' });
assert.deepEqual(mapSourceDetails('server:SSX3_ARA1'), { source: 'Server', game: 'SSX 3', map: 'Server Snow Jam' });
assert.equal(
  mapSourceDetails('SSX3_ARA1').source,
  'Local',
  'legacy IDs match the same local-first resolution as loading',
);
assert.deepEqual(mapSourceDetails('server:TRICKY_GARI'), { source: 'Server', game: 'SSX Tricky', map: 'Garibaldi' });
assert.deepEqual(mapSourceDetails('@models'), { source: 'Server', game: 'Custom / Authored', map: 'My Mountain' });
configureWorkspace(true, async () => null);
assert.deepEqual(mapSourceDetails('@import'), { source: 'Local', game: 'Custom / Authored', map: 'My Mountain' });
let notifications = 0;
const unwatch = watchMapSources(() => notifications++);
registerMapSources('details', [{ name: 'Custom', game: 'slopesmith', label: 'Renamed Mountain' }]);
assert.equal(notifications, 1);
assert.equal(mapSourceDetails('Custom').map, 'Renamed Mountain');
unwatch();
registerMapSources('details', []);
assert.equal(notifications, 1);
console.log('Asset details retain source, game, disc titles, legacy identity and authored mountain names PASS');
