import assert from 'node:assert/strict';
import { libraryGameCourses } from '../src/app/public/library-courses';
import type { PublicCourse } from '../src/core/session/public-courses';

const published: PublicCourse = {
  id: 'TRICKY_GARI',
  name: 'Garibaldi',
  kind: 'reference',
  source: 'server',
  retailData: true,
  isoCourses: ['TRICKY_GARI'],
};
const courses = libraryGameCourses(
  ['GARI', 'SSXGBA_GARIBALDI'],
  ['TRICKY_GARI', 'TRICKY_SNOW'],
  [
    { name: 'TRICKY_GARI', course: 'TRICKY_GARI' },
    { name: 'TRICKY_MESA', course: 'TRICKY_MESA' },
  ],
  [published],
);
assert.equal(courses.length, 4, 'disc, cache, public listing and installed reference merge by canonical course');
const gari = courses.find(entry => entry.course === 'GARI')!;
assert(gari.loaded && gari.disc && gari.server);
assert.equal(gari.publication, published);
assert.equal(gari.course, 'GARI', 'legacy cache keys remain usable for reads and unloads');
const gba = courses.find(entry => entry.course === 'SSXGBA_GARIBALDI')!;
assert(gba.loaded && !gba.server, 'same names in different games stay distinct');
const snow = courses.find(entry => entry.course === 'TRICKY_SNOW')!;
assert(snow.disc && !snow.loaded && !snow.server, 'maps can be available on disc before extraction');
const mesa = courses.find(entry => entry.course === 'TRICKY_MESA')!;
assert(
  mesa.server && !mesa.loaded && !mesa.disc && !mesa.publication,
  'unpublished server references remain manageable',
);
assert.equal(
  libraryGameCourses([], [], [], [published]).length,
  1,
  'public server maps remain available without admin inventory',
);
assert.equal(
  libraryGameCourses([], [], [{ name: 'TRICKY_GARI', course: 'GARI' }], [])[0].course,
  'TRICKY_GARI',
  'server-only legacy aliases retain canonical row identities after local caches are cleared',
);
assert.equal(
  libraryGameCourses(
    [],
    [],
    [{ name: 'old-garibaldi-folder', course: 'GARI' }],
    [{ ...published, id: 'old-garibaldi-folder' }],
  ).length,
  1,
  'legacy server folder names use their reference course identity',
);
assert.equal(
  libraryGameCourses([], [], [], [published, { ...published, id: 'MY_MAP', isoCourses: ['TRICKY_GARI'] }]).length,
  2,
  'a reference that borrows a course does not become that donor course',
);
assert.equal(libraryGameCourses([], [], [], [], ['TRICKY_GARI']).length, 1, 'missing required maps remain visible');
console.log('LIBRARY COURSES PASS: canonical merging, disc/cache/server availability, legacy keys and separate games.');
