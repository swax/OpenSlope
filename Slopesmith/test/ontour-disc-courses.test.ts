// tier: fast
import assert from 'node:assert/strict';
import { discCourseName, isDiscCourse } from '../src/core/reference/disc-courses';
import { publicCourseGroups } from '../src/app/public/course-list';

for (const code of [
  'ER1',
  'ER2',
  'ER3',
  'ER4',
  'NP2',
  'NP3',
  'NPP',
  'VB1',
  'VB2',
  'VB4',
  'VH1',
  'WR1',
  'WR2',
  'WR3',
  'WR4',
]) {
  assert(isDiscCourse(`SSXOT_${code}_DAY`));
}
for (const code of ['ER3', 'ER4', 'NP3', 'VB1', 'VB4', 'VH1', 'WR1', 'WR2', 'WR3', 'WR4']) {
  assert(isDiscCourse(`SSXOT_${code}_NIGHT`));
}
for (const name of [
  'SSXOT_ALL',
  'SSXOT_ALL_DAY',
  'SSXOT_MOUNTAIN_DAY',
  'SSXOT_ER1_NIGHT',
  'SSXOT_ER1',
  'SSXOT_XYZ_DAY',
  'SSXOT_WR1_DAY/../Custom',
]) {
  assert(!isDiscCourse(name), name);
}
assert(isDiscCourse('ssxot_wr1_night'));
assert.equal(discCourseName('ssxot_er1_day'), 'ER1 · Day (SSX On Tour)');
assert.equal(discCourseName('SSXOT_WR1_NIGHT'), 'WR1 · Night (SSX On Tour)');
assert.equal(discCourseName('SSXOT_ALL'), 'SSXOT_ALL');
assert.equal(publicCourseGroups([], ['SSXOT_ER1_DAY']).local[0].name, 'ER1 · Day (SSX On Tour)');
console.log('On Tour course variants, names and bounded presence identifiers: PASS');
