// tier: fast
import assert from 'node:assert/strict';
import { publicCourseGroups, requiredIsoState } from '../src/app/public/course-list';
import {
  publicProjectUrl,
  publicCourseUrl,
  isoManagementUrl,
  publicCourseRequest,
  resolvePublicCourse,
  courseEditorUrl,
} from '../src/app/public/links';
import { MAPS_PATH, ISOS_PATH } from '../src/app/navigation';
import type { PublicCourse } from '../src/core/session/public-courses';
import { isDiscCourse } from '../src/core/reference/disc-courses';
import { publicMountainDocument, publicPropPayload } from '../src/app/public/course-assets';
import { defaultMountain } from '../src/core/doc/mountain';
import { createAuthoredModel } from '../src/core/doc/models';
import { projectIsoCourses } from '../src/server/public-courses';

const reference: PublicCourse = {
  id: 'RENAMED_GARI',
  name: 'Published Garibaldi',
  kind: 'reference',
  retailData: true,
  isoCourses: ['GARI'],
};
const mountain: PublicCourse = {
  id: 'custom',
  name: 'My mountain',
  kind: 'project',
  retailData: true,
  isoCourses: ['GARI'],
};
const groups = publicCourseGroups([reference, mountain], ['GARI', 'SNOW', 'snow']);
assert.deepEqual(groups.server, [reference, mountain], 'server publications remain separate from local maps');
assert.equal(groups.local.length, 2, 'only distinct loaded ISO maps appear on the local shelf');
assert(
  groups.local.some(course => course.id === 'GARI'),
  'a published reference does not hide its local ISO map',
);
assert.deepEqual(
  groups.local.find(course => course.id === 'SNOW'),
  {
    kind: 'reference',
    id: 'SNOW',
    name: 'Snowdream',
    retailData: true,
    isoCourses: ['SNOW'],
  },
);
assert.equal(publicCourseGroups([], ['GARI']).local[0].name, 'Garibaldi', 'loaded slots need no server publication');
assert.deepEqual(
  requiredIsoState(['GARI', 'SNOW', 'gari'], ['gari']),
  [
    { slot: 'GARI', name: 'Garibaldi', loaded: true },
    { slot: 'SNOW', name: 'Snowdream', loaded: false },
  ],
  'each donor has its own loaded state, including a partial local cache',
);
const origin = 'https://slopesmith.example';
const named: PublicCourse = { ...mountain, name: 'My_Mountain' };
const namedUrl = publicProjectUrl(named.name, origin);
assert.equal(namedUrl, `${origin}/play/My_Mountain`);
assert.equal(
  resolvePublicCourse(publicCourseRequest(new URL(namedUrl)), [named], [])?.id,
  mountain.id,
  'readable links resolve names to public map ids',
);
assert.equal(
  resolvePublicCourse(publicCourseRequest(new URL(namedUrl)), [], []),
  null,
  'a name link cannot reveal a private map',
);
const reservedUrl = publicProjectUrl('assets', origin);
assert.equal(new URL(reservedUrl).pathname, '/play/assets');
assert.equal(
  publicCourseRequest(new URL(reservedUrl))?.name,
  'assets',
  'map names cannot collide with static root paths',
);
assert.equal(
  publicCourseRequest(new URL(isoManagementUrl(named, origin)))?.name,
  named.name,
  'the ISO manager keeps the map context without putting a guid in the URL',
);
assert.equal(MAPS_PATH, '/maps');
assert.equal(publicCourseRequest(new URL(`${origin}/maps`)), null, '/maps is the catalogue, never a map name');
assert.equal(
  publicCourseRequest(new URL(`${origin}/editor/My_Mountain`)),
  null,
  'editor routes never load a public course',
);
assert.equal(new URL(isoManagementUrl(undefined, origin)).pathname, ISOS_PATH);
assert.equal(new URL(isoManagementUrl(named, origin)).pathname, ISOS_PATH);
assert.equal(new URL(publicCourseUrl(reference, origin)).pathname, '/play/Published%20Garibaldi');
assert.equal(courseEditorUrl(named, origin), `${origin}/editor/My_Mountain`);
assert.equal(courseEditorUrl(reference, origin), `${origin}/editor?reference=RENAMED_GARI`);
assert.equal(courseEditorUrl({ ...named, name: 'A map' }, origin), `${origin}/editor/A%20map`);
assert.equal(
  resolvePublicCourse(publicCourseRequest(new URL(publicCourseUrl(reference, origin))), [reference], [])?.id,
  reference.id,
);
const mapsNamed = { ...named, name: 'maps' };
assert.equal(
  resolvePublicCourse(publicCourseRequest(new URL(publicProjectUrl('maps', origin))), [mapsNamed], [])?.name,
  'maps',
  'a mountain named maps has the same named play route as any other mountain',
);
const duplicate = { ...named, name: reference.name };
assert.equal(
  resolvePublicCourse(
    publicCourseRequest(new URL(publicProjectUrl(duplicate.name, origin))),
    [duplicate, reference],
    [],
  )?.kind,
  'project',
  'authored links select authored mountains when a reference has the same name',
);
assert.equal(
  resolvePublicCourse(publicCourseRequest(new URL(publicCourseUrl(reference, origin))), [duplicate, reference], [])
    ?.kind,
  'reference',
  'reference links remain unambiguous when an authored mountain shares the name',
);
const local = groups.local.find(course => course.id === 'GARI')!;
assert.equal(
  resolvePublicCourse(publicCourseRequest(new URL(publicCourseUrl(local, origin))), [], ['GARI'])?.id,
  'GARI',
  'a named ISO play URL reopens its local course without a server publication',
);
assert.equal(
  resolvePublicCourse(publicCourseRequest(new URL(isoManagementUrl(reference, origin))), [reference], [])?.id,
  reference.id,
  'reference ISO-management links retain their required source map',
);
assert(isDiscCourse('gari'));
assert(!isDiscCourse('PRIVATE_REFERENCE'));
assert(!isDiscCourse('toString'));

const document = defaultMountain();
document.quadTex = { 0: 'GARI/0000.png', 1: 'Custom/snow.png', 2: 'SNOW/0001.png' };
const model = createAuthoredModel(document, 'Authored sign');
model.texture = 'GARI/0000.png';
model.frames = ['GARI/0000.png', 'Custom/snow.png'];
document.props = ['GARI', 'SNOW', '@import', '@model'].map((level, index) => ({
  id: `prop:${index}`,
  name: level,
  level,
  model: 0,
  pos: [0, 0, 0],
  yaw: 0,
  scale: 1,
}));
document.skybox = { on: true, source: { kind: 'level', level: 'GARI' }, topColor: '#ffffff' };
const original = JSON.stringify(document);
const bare = publicMountainDocument(document, []);
assert.deepEqual(
  bare.quadTex,
  { 1: 'Custom/snow.png' },
  'missing disc tiles fall back to plain terrain; custom tiles remain',
);
assert.deepEqual(
  bare.props?.map(prop => prop.level),
  ['@import', '@model'],
  'missing disc props are absent, custom geometry remains',
);
assert.equal(bare.models?.[0].texture, undefined);
assert.equal(bare.skybox, undefined);
assert.deepEqual(bare.vertices, document.vertices, 'the rideable terrain is retained');
const partial = publicMountainDocument(document, ['gari']);
assert.deepEqual(
  partial.props?.map(prop => prop.level),
  ['GARI', '@import', '@model'],
  'partial caches restore only their own donors',
);
assert.equal(partial.quadTex?.[0], 'GARI/0000.png');
assert.equal(partial.quadTex?.[2], undefined);
assert.equal(JSON.stringify(document), original, 'public playback never rewrites the saved mountain');
const props = publicPropPayload(
  {
    level: '@import',
    models: [],
    instances: [],
    materials: [
      { id: 0, tex: 'GARI/0000.png', frames: ['GARI/0000.png', 'Custom/snow.png'] },
      { id: 1, tex: 'Custom/snow.png' },
    ],
  },
  [],
);
assert.equal(props.materials[0].tex, null, 'custom model geometry does not require its borrowed texture');
assert.deepEqual(props.materials[0].frames, ['Custom/snow.png']);
assert.equal(props.materials[1].tex, 'Custom/snow.png');
assert.deepEqual(
  projectIsoCourses(defaultMountain(), ['GARI/0000.png', 'Custom/snow.png']),
  ['GARI'],
  'borrowed textures inside imported prop materials also declare their ISO donor',
);
console.log('PUBLIC COURSE LIST PASS: named links, separate map groups, donor status and partial ISO assets.');
