// tier: fast
import assert from 'node:assert/strict';
import { discCourseName, isDiscCourse } from '../src/core/reference/disc-courses';
import { isoCourseCacheVersion, supportsCollisionSoundUpdate } from '../src/app/public/iso-cache';
import { ISO_GAMES, isoGameForCourse } from '../src/app/public/iso-discs';
import { publicCourseUrl, resolvePublicCourse } from '../src/app/public/links';

const catalogue = {
  AN_ANTARTICA: 'Antarctica',
  DC_WASHINGTON: 'Washington DC',
  LV_LAS_VEGAS: 'Las Vegas',
  MK_MT_KILI: 'Mount Kilimanjaro',
  MP_MACHU_PIHU: 'Machu Picchu',
  NP_NEPAL: 'Nepal',
  RV_ROME: 'Rome',
  SF_SAN_FRAN: 'San Francisco',
  TH_TAHOE: 'Tahoe',
  TR_TRAINING: 'Training',
  VA_VALDEZ_ALASKA: 'Valdez Alaska',
};
assert.deepEqual(
  ISO_GAMES.find(game => game.id === 'madtrix'),
  {
    id: 'madtrix',
    name: 'Jonny Moseley Mad Trix',
    support: '11 courses · Preliminary support',
  },
);
for (const [stem, label] of Object.entries(catalogue))
  for (const course of [`MADTRIX_${stem}`, `madtrix_${stem.toLowerCase()}`]) {
    assert(isDiscCourse(course), course);
    assert.equal(discCourseName(course), `${label} (Mad Trix)`);
    assert.equal(isoGameForCourse(course), 'madtrix');
    assert.equal(supportsCollisionSoundUpdate(course), false);
    assert.equal(isoCourseCacheVersion(course), 8, 'Reload earlier caches missing source music');
  }
for (const course of [
  'MADTRIX_UNKNOWN',
  'MADTRIX_AN_ANTARCTICA',
  'MADTRIX_MP_MACHU_PICCHU',
  'MADTRIX_AN_ANTARTICA/../Custom',
]) {
  assert(!isDiscCourse(course), course);
  assert.equal(discCourseName(course), course);
}
const resolved = resolvePublicCourse({ kind: 'reference', name: 'MADTRIX_AN_ANTARTICA', source: 'iso' }, [], []);
assert(resolved, 'Known Mad Trix links can request a missing local course');
assert.equal(resolved.name, 'Antarctica (Mad Trix)');
const play = new URL(publicCourseUrl(resolved, 'https://slopesmith.test'));
assert.equal(play.searchParams.get('reference'), 'MADTRIX_AN_ANTARTICA');
assert.equal(play.searchParams.get('source'), 'iso');
console.log('Mad Trix catalogue, labels, game routing, audio policy and cache generation: PASS');
