// tier: fast
import assert from 'node:assert/strict';
import { discCourseName, isDiscCourse, registerDiscCourseNames } from '../src/core/reference/disc-courses';
import { mapDisplayName } from '../src/core/reference/map-game';
import { isoCourseCacheVersion, supportsCollisionSoundUpdate } from '../src/app/public/iso-cache';
import { isoGameForCourse } from '../src/app/public/iso-discs';

const titles = [
  ['Half-Pipe', null, null, "Sid's Night Midi"],
  ['Tenderfoot Pass', 'Powder Threat', 'Revolution Cliff', 'Evolution Riff'],
  ['Spinal Damage', 'Ballistic', 'No Way Out', 'Outway Knoll'],
  ['Frosty Shadows', 'Tree Top Trauma', 'Midnight City', 'Top Tree Mama'],
  ['Ski School', "Grits n' Gravy", 'Rotted Ridge', "Dazzlin' Teaser"],
  ['Air-Make', 'Trestle Trouble', 'Diesel Disaster', 'Treble Tussle'],
  ['Terrain Park', null, 'Sick With It', "Wit's Thicket"],
];
for (const [family, variants] of titles.entries())
  for (const [variant, title] of variants.entries()) {
    if ((family === 0 && variant !== 0 && variant !== 3) || (family === 6 && variant === 1)) continue;
    const course = `AVALANCHE_CRS0${family}_0${variant}`;
    assert(isDiscCourse(course) && isDiscCourse(course.toLowerCase()), course);
    assert.equal(discCourseName(course), title);
    assert.equal(mapDisplayName({ name: course }), title, 'Map selectors omit the already-selected game');
    assert.equal(mapDisplayName({ name: 'RENAMED', course, game: '1080-avalanche' }), title);
    assert.equal(isoGameForCourse(course), 'avalanche');
    assert.equal(supportsCollisionSoundUpdate(course), false);
    assert.equal(isoCourseCacheVersion(course), 3, 'Old Avalanche caches need source colour lighting');
  }
assert(isDiscCourse('AVALANCHE_CRS00_00'));
for (const unknown of [
  'AVALANCHE_CRS00_01',
  'AVALANCHE_CRS06_01',
  'AVALANCHE_CRS07_00',
  'AVALANCHE_CRS01_04',
  'AVALANCHE_CRS01_00/../Custom',
]) {
  assert(!isDiscCourse(unknown), unknown);
  assert.equal(mapDisplayName({ name: unknown }), unknown, 'Unknown IDs keep their original label');
}
assert.equal(mapDisplayName({ name: 'GARI' }), 'Garibaldi');
assert.equal(mapDisplayName({ name: 'AVALANCHE_CRS01_00', displayName: '  Disc title  ' }), 'Disc title');
assert.equal(mapDisplayName({ name: 'AVALANCHE_CRS01_00', displayName: 'Bad\nTitle' }), 'Tenderfoot Pass');
assert.equal(mapDisplayName({ name: 'GARI', origin: 'slopesmith' }), 'GARI', 'Authored map names remain their own');
console.log('Avalanche catalogue names, game routing and bounded presence slots: PASS');

registerDiscCourseNames({ AVALANCHE_CRS01_00: '1080° Avalanche · Tenderfoot Pass' });
assert.equal(discCourseName('AVALANCHE_CRS01_00'), 'Tenderfoot Pass', 'Old cached prefixes are removed');
