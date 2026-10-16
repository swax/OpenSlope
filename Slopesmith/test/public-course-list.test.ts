// tier: fast
import assert from 'node:assert/strict';
import { coursesWithIso } from '../src/app/public/course-list';
import type { PublicCourse } from '../src/core/session/public-courses';
import { isDiscCourse } from '../src/core/reference/disc-courses';

const reference: PublicCourse = { id: 'RENAMED_GARI', name: 'Published Garibaldi', kind: 'reference', retailData: true, isoCourses: ['GARI'] };
const mountain: PublicCourse = { id: 'custom', name: 'My mountain', kind: 'project', retailData: true, isoCourses: ['GARI'] };
const courses = coursesWithIso([reference, mountain], ['GARI', 'SNOW', 'SNOW']);
assert.equal(courses.length, 3, 'a published reference and its ISO slot have one card; a custom mountain remains distinct');
assert(courses.includes(reference));
assert(courses.includes(mountain));
assert.deepEqual(courses.find(course => course.id === 'SNOW'), {
  kind: 'reference', id: 'SNOW', name: 'Snowdream', retailData: true, isoCourses: ['SNOW'],
});
assert.equal(coursesWithIso([], ['GARI'])[0].name, 'Garibaldi', 'cached slots can rebuild the list without a server publication');
assert(isDiscCourse('gari'));
assert(!isDiscCourse('PRIVATE_REFERENCE'));
assert(!isDiscCourse('toString'));
console.log('PUBLIC COURSE LIST PASS: ISO discovery, cached slots, published reference deduplication.');
