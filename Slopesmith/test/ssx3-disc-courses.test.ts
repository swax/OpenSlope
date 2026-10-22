// tier: fast
import assert from 'node:assert/strict';
import { discCourseName, isDiscCourse } from '../src/core/reference/disc-courses';

for (const name of ['SSX3_ARA1', 'ssx3_peak1', 'SSX3_ERA5_C', 'SSX_SNOW', 'GARI']) {
  assert(isDiscCourse(name), name);
}
for (const name of ['SSX3_ALL', 'SSX3_UNKNOWN', 'SSX3_ASKY', 'SSX3_TRANSP', 'SSX3_PEAK4', 'SSX3_ARA1/../../Custom']) {
  assert(!isDiscCourse(name), name);
}
assert.equal(discCourseName('SSX3_PEAK1'), 'Peak 1 (SSX 3)');
assert.equal(discCourseName('ssx3_all'), 'ssx3_all');
assert.equal(discCourseName('SSX3_ARA1_B'), 'ARA1 → B (SSX 3)');
assert.equal(discCourseName('GARI'), 'Garibaldi');
console.log('SSX3 disc names and bounded presence identifiers: PASS');
