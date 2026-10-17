// tier: fast
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { GODRAY_SPOKES } from '../src/core/lighting/god-rays';

const contract = JSON.parse(
  readFileSync(new URL('../../Contracts/celestial-spokes-v1.json', import.meta.url), 'utf8'),
) as {
  Schema: string;
  Spokes: { deg: number; amp: number }[];
};
assert.equal(contract.Schema, 'openslope-celestial-spokes/v1');
assert.deepEqual(contract.Spokes, GODRAY_SPOKES);
assert.equal(contract.Spokes.length, 32);
assert.ok(
  contract.Spokes.every(
    (spoke, index) =>
      Number.isFinite(spoke.deg) &&
      Number.isFinite(spoke.amp) &&
      spoke.deg >= 0 &&
      spoke.deg < 360 &&
      spoke.amp >= 0 &&
      spoke.amp <= 1 &&
      (index === 0 || spoke.deg > contract.Spokes[index - 1].deg),
  ),
);
console.log('CELESTIAL CONTRACT: PASS');
