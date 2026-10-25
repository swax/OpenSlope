// tier: fast
import assert from 'node:assert/strict';
import { discCourseName, isDiscCourse } from '../src/core/reference/disc-courses';
import { supportsCollisionSoundUpdate } from '../src/app/public/iso-cache';
import { isoGameForCourse } from '../src/app/public/iso-discs';

for (const family of [0, 1, 2, 3, 4, 5, 6])
  for (const [variant, difficulty] of ['Normal', 'Hard', 'Expert', 'Diamond'].entries()) {
    if ((family === 0 && variant !== 0 && variant !== 3) || (family === 6 && variant === 1)) continue;
    const course = `AVALANCHE_CRS0${family}_0${variant}`;
    assert(isDiscCourse(course) && isDiscCourse(course.toLowerCase()), course);
    assert.equal(discCourseName(course), `1080° Avalanche · Crs0${family} ${difficulty}`);
    assert.equal(isoGameForCourse(course), 'avalanche');
    assert.equal(supportsCollisionSoundUpdate(course), false);
  }
assert(isDiscCourse('AVALANCHE_CRS00_00'));
for (const unknown of [
  'AVALANCHE_CRS00_01',
  'AVALANCHE_CRS06_01',
  'AVALANCHE_CRS07_00',
  'AVALANCHE_CRS01_04',
  'AVALANCHE_CRS01_00/../Custom',
])
  assert(!isDiscCourse(unknown), unknown);
console.log('Avalanche catalogue names, game routing and bounded presence slots: PASS');
