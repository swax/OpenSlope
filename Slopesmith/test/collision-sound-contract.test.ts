// tier: fast

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COURSE_BANK_LEVELS,
  clearCollisionSoundIndexes,
  collisionSoundEventIds,
  collisionSoundSource,
  courseBankName,
  effectSoundSource,
  registerCollisionSoundIndex,
  resolveCollisionSound,
  type CollisionSoundIndex,
} from '../src/core/effects/collision-sound';

const fixture: CollisionSoundIndex = {
  Schema: 'openslope-sound-index/v1',
  Level: 'DONOR',
  SourceExecutable: 'local-test-elf',
  Banks: { 2: 'course-a', 3: 'Crowd' },
  CollisionEvents: {
    700: { Group: 2, Slot: 4, Bank: 'course-a', Clip: 'Audio/SFX/course-a/004.wav' },
    701: { Group: 3, Slot: 5, Bank: 'Crowd', Clip: 'Audio/SFX/Crowd/005.wav' },
  },
};
const otherRegion: CollisionSoundIndex = {
  ...fixture,
  Level: 'DONOR2',
  SourceExecutable: 'other-test-elf',
  Banks: { 2: 'course-b', 3: 'Crowd' },
  CollisionEvents: {
    700: { Group: 2, Slot: 9, Bank: 'course-b', Clip: 'Audio/SFX/course-b/009.wav' },
  },
};

clearCollisionSoundIndexes();
assert.equal(resolveCollisionSound(700), null, 'no retail resolver is compiled into Slopesmith');
assert.equal(registerCollisionSoundIndex(fixture), true);
assert.equal(registerCollisionSoundIndex(otherRegion), true);
assert.deepEqual(COURSE_BANK_LEVELS, ['DONOR', 'DONOR2']);
assert.equal(courseBankName('donor'), 'course-a');
assert.deepEqual(resolveCollisionSound(700), { bank: 'course', slot: 4 });
assert.deepEqual(resolveCollisionSound(701), { bank: 'crowd', slot: 5 });
assert.deepEqual(resolveCollisionSound(700, 'DONOR2'), { bank: 'course', slot: 9 });
assert.equal(resolveCollisionSound(701, 'DONOR2'), null);
assert.equal(resolveCollisionSound(7), null);
assert.deepEqual(collisionSoundEventIds(), [700, 701]);
assert.deepEqual(collisionSoundEventIds('DONOR2'), [700]);
assert.equal(collisionSoundSource('DONOR', 700), 'DONOR/course-a/004.wav');
assert.equal(collisionSoundSource('DONOR', 701), 'DONOR/Crowd/005.wav');
assert.equal(effectSoundSource('DONOR', 4), 'DONOR/course-a/004.wav');

const source = readFileSync(resolve(process.cwd(), 'src/core/effects/collision-sound.ts'), 'utf8');
assert.doesNotMatch(source, /COLLISION_SOUND_EVENT_MAP|collision-sound-data\.generated/);
assert.match(source, /SoundIndex\.json/);
console.log('COLLISION SOUND CONTRACT PASS');
