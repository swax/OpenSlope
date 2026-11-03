// tier: fast
import assert from 'node:assert/strict';
import { ISO_GAMES, isoGameForCourse } from '../src/app/public/iso-discs';
import { isoCourseCacheVersion, supportsCollisionSoundUpdate } from '../src/app/public/iso-cache';
import { libraryGameCourses } from '../src/app/public/library-courses';
import {
  canonicalDiscCourse,
  discContainsCourse,
  discCourseName,
  isDiscCourse,
} from '../src/core/reference/disc-courses';
import { courseLayout, isoCourseVisible } from '../src/core/reference/course-layout';
import { mapGame, mapGameLabel } from '../src/core/reference/map-game';

assert(ISO_GAMES.some(game => game.id === 'ssx3-beta' && game.name === 'SSX 3 Beta'));
assert.equal(isoGameForCourse('ssx3b_ara1'), 'ssx3-beta');
assert.equal(mapGame({ name: 'local:SSX3B_ARA1' }), 'ssx-3-beta');
assert.equal(mapGameLabel('ssx-3-beta'), 'SSX 3 Beta');
assert.equal(canonicalDiscCourse('SSX3B_ARA1'), 'SSX3B_ARA1');
assert(!discContainsCourse(['SSX3_ARA1'], 'SSX3B_ARA1'));
assert(!discContainsCourse(['SSX3B_ARA1'], 'SSX3_ARA1'));
assert(isDiscCourse('SSX3B_ARA1'));
assert(!isDiscCourse('SSX3B_UNKNOWN'));
assert(!isDiscCourse('SSX3B_ALL'));
assert.equal(discCourseName('SSX3B_PEAK1'), 'Peak 1 (SSX 3 Beta)');
assert.equal(isoCourseCacheVersion('SSX3B_ARA1'), isoCourseCacheVersion('SSX3_ARA1'));
assert(!supportsCollisionSoundUpdate('SSX3B_ARA1'));
assert.deepEqual(courseLayout('SSX3B_ARA1'), {
  MapType: 'run',
  WorldId: 'ssx-3-beta:bam',
  ParentMap: 'SSX3B_PEAK1',
});
assert.equal(courseLayout('SSX3B_PEAK1').ParentMap, 'SSX3B_ALL');
assert(isoCourseVisible('SSX3B_ARA1', false));
assert(!isoCourseVisible('SSX3B_A', false));
assert(isoCourseVisible('SSX3B_A', true));
assert(isoCourseVisible('SSX3B_A', false, ['SSX3B_A']));
const entries = libraryGameCourses(['SSX3_ARA1', 'SSX3B_ARA1'], [], [], []);
assert.deepEqual(
  entries.map(entry => entry.game),
  ['ssx3', 'ssx3-beta'],
);
console.log('SSX 3 beta game, map identities, cache, library and layout filtering passed');
