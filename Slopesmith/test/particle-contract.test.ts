// tier: fast
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PARTICLE_SPRITE_NAMES } from '../src/core/effects/emitter-preview';

const contract = JSON.parse(readFileSync(new URL('../../Contracts/particle-sprites-v1.json', import.meta.url), 'utf8')) as {
  schema: string;
  version: number;
  sprites: string[];
};
assert.equal(contract.schema, 'openslope-particle-sprites/v1');
assert.equal(contract.version, 1);
assert.deepEqual([...PARTICLE_SPRITE_NAMES], contract.sprites,
  'Slopesmith and Native must use registration order, including duplicate slots');
assert.equal(contract.sprites[30], contract.sprites[31]);
console.log('PASS shared particle registry matches the public Slopesmith preview API');
