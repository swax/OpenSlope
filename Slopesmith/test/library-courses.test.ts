import assert from 'node:assert/strict';
import { libraryGameCourses, libraryGameSources } from '../src/app/public/library-courses';
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
assert.deepEqual(libraryGameSources(gari, 'all'), { device: true, server: true });
assert.deepEqual(
  libraryGameSources(gari, 'public'),
  { device: false, server: true },
  'only the published copy is public',
);
assert.deepEqual(
  libraryGameSources(gari, 'private'),
  { device: false, server: false },
  'loaded game maps stay out of the private custom-map view',
);
const gba = courses.find(entry => entry.course === 'SSXGBA_GARIBALDI')!;
assert(gba.loaded && !gba.server, 'same names in different games stay distinct');
assert.deepEqual(libraryGameSources(gba, 'public'), { device: false, server: false });
assert.deepEqual(libraryGameSources(gba, 'private'), { device: false, server: false });
const snow = courses.find(entry => entry.course === 'TRICKY_SNOW')!;
assert(snow.disc && !snow.loaded && !snow.server, 'maps can be available on disc before extraction');
assert.deepEqual(libraryGameSources(snow, 'private'), { device: false, server: false });
const mesa = courses.find(entry => entry.course === 'TRICKY_MESA')!;
assert(
  mesa.server && !mesa.loaded && !mesa.disc && !mesa.publication,
  'unpublished server references remain manageable',
);
assert.deepEqual(libraryGameSources(mesa, 'all'), { device: false, server: true });
assert.deepEqual(libraryGameSources(mesa, 'private'), { device: false, server: false });
assert.deepEqual(libraryGameSources(mesa, 'public'), { device: false, server: false });
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
const otherReferences = libraryGameCourses(
  [],
  [],
  [
    { name: 'Training_Hill', course: 'Training_Hill', origin: 'slopesmith', retailData: false },
    { name: 'MYSTERY', course: 'MYSTERY' },
    { name: 'TRICKY_OUR_HILL', course: 'TRICKY_OUR_HILL', origin: 'slopesmith' },
    { name: 'GARI', course: 'GARI', origin: 'slopesmith' },
    { name: 'TRICKY_GARI', course: 'TRICKY_GARI', origin: 'retail', game: 'ssx-tricky' },
    { name: 'Renamed_Tour', course: 'WR2', game: 'ssx-on-tour', origin: 'retail' },
  ],
  [],
);
assert.equal(otherReferences.filter(entry => entry.game === 'other').length, 4);
assert.equal(otherReferences.find(entry => entry.course === 'Training_Hill')?.reference?.name, 'Training_Hill');
assert(otherReferences.some(entry => entry.game === 'other' && entry.course === 'GARI'));
assert.equal(otherReferences.find(entry => entry.game === 'other' && entry.course === 'GARI')?.name, 'GARI');
assert(otherReferences.some(entry => entry.game === 'tricky' && entry.course === 'TRICKY_GARI'));
assert.equal(otherReferences.find(entry => entry.course === 'WR2')?.game, 'ontour');
assert(!otherReferences.some(entry => entry.course === 'TRICKY_MYSTERY'), 'unknown refs retain their physical names');
assert.equal(libraryGameCourses(['FIXTURE'], [], [], [])[0].game, 'tricky', 'legacy ISO imports remain game maps');
const publicOther = libraryGameCourses(
  [],
  [],
  [],
  [
    {
      ...published,
      id: 'Our_Hill',
      name: 'Our Hill',
      retailData: false,
      isoCourses: [],
    },
  ],
)[0];
assert.equal(publicOther.game, 'other');
assert.equal(publicOther.course, 'Our_Hill');
const sameNames = libraryGameCourses(['GARI'], [], [{ name: 'GARI', course: 'GARI', origin: 'slopesmith' }], []);
assert.equal(sameNames.length, 2);
assert.equal(
  new Set(sameNames.map(entry => entry.key)).size,
  2,
  'reference groups keep identical local/server names separate',
);
console.log('LIBRARY COURSES PASS: canonical merging, disc/cache/server availability, legacy keys and separate games.');
