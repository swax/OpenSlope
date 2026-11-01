// tier: fast
import assert from 'node:assert/strict';
import { findSkyLevel, qualifySkyCatalogue } from '../src/core/sky/catalogue';
import type { SkyRing } from '../src/core/sky/ring';

const ring = { radius: 123 } as SkyRing;
const server = qualifySkyCatalogue(
  {
    levels: ['GARI'],
    nativeLevels: ['SSXOT_ER1_DAY'],
    rings: { GARI: ring },
    versions: { GARI: { panorama: 'server-revision' } },
    skies: ['sunset'],
  },
  'server',
);
assert.deepEqual(server.levels, ['server:GARI']);
assert.deepEqual(server.nativeLevels, ['server:SSXOT_ER1_DAY']);
assert.equal(server.rings?.['server:GARI'], ring);
assert.deepEqual(server.versions?.['server:GARI'], { panorama: 'server-revision' });
assert.deepEqual(server.skies, ['sunset']);
const levels = ['server:TRICKY_GARI', 'local:TRICKY_GARI', 'server:SSXOT_ER1_DAY'];
assert.equal(findSkyLevel(levels, 'server:GARI'), 'server:TRICKY_GARI');
assert.equal(findSkyLevel(levels, 'local:GARI'), 'local:TRICKY_GARI');
assert.equal(findSkyLevel(levels, 'GARI'), 'local:TRICKY_GARI');
assert.equal(findSkyLevel(levels, 'server:ssxot_er1_day'), 'server:SSXOT_ER1_DAY');
assert.equal(
  findSkyLevel(levels, 'local:SSXOT_ER1_DAY'),
  undefined,
  'Never borrow the server sky for an explicit local map',
);
assert.equal(
  findSkyLevel(['SSXOT_ER1_DAY'], 'server:SSXOT_ER1_DAY'),
  'SSXOT_ER1_DAY',
  'Server-only catalogues retain their legacy shape',
);
assert.equal(findSkyLevel(['local:SSXOT_ER1_DAY'], 'server:SSXOT_ER1_DAY'), undefined);
console.log('PASS: source-aware sky catalogues, ring revisions and legacy aliases');
