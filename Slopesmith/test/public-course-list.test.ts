// tier: fast
import assert from 'node:assert/strict';
import { localProjectCourse, publicCourseGroups, requiredIsoState } from '../src/app/public/course-list';
import { bundleIsoCourses, bundleAssetRequirements } from '../src/core/project/iso-requirements';
import type { ProjectBundle } from '../src/core/project/transfer';
import {
  publicProjectUrl,
  publicCourseUrl,
  isoManagementUrl,
  publicCourseRequest,
  resolvePublicCourse,
  courseEditorUrl,
  editorUrlForPublicMap,
} from '../src/app/public/links';
import { MAPS_PATH, ISOS_PATH } from '../src/app/navigation';
import type { PublicCourse } from '../src/core/session/public-courses';
import {
  canonicalDiscCourse,
  discContainsCourse,
  discCourseName,
  isDiscCourse,
  registerDiscCourseNames,
} from '../src/core/reference/disc-courses';
import { publicMountainDocument, publicPropPayload } from '../src/app/public/course-assets';
import { defaultMountain } from '../src/core/doc/mountain';
import { createAuthoredModel } from '../src/core/doc/models';
import { projectIsoCourses } from '../src/server/public-courses';
import { classifyExportProvenance } from '../src/core/export/manifest';
import { isoGameForCourse } from '../src/app/public/iso-discs';
import { mapGame, mapGameLabel } from '../src/core/reference/map-game';

for (const [id, title] of [
  ['SSXGBA_GARIBALDI', 'Garibaldi'],
  ['SSXGBA_MERQURY_CITY', 'Merqury City'],
  ['SSXGBA_TOKYO_MEGAPLEX', 'Tokyo Megaplex'],
  ['SSXGBA_ALOHA_ICE_JAM', 'Aloha Ice Jam'],
] as const) {
  assert(isDiscCourse(id));
  assert.equal(canonicalDiscCourse(id), id);
  assert.equal(discCourseName(id), title);
  assert.equal(isoGameForCourse(id), 'tricky-gba');
  assert.equal(mapGame({ name: id }), 'ssx-tricky-gba');
}
assert(!isDiscCourse('SSXGBA_UNKNOWN'));
assert.equal(mapGameLabel('ssx-tricky-gba'), 'SSX Tricky (GBA)');

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
    source: 'iso',
    retailData: true,
    isoCourses: ['SNOW'],
  },
);
assert.equal(publicCourseGroups([], ['GARI']).local[0].name, 'Garibaldi', 'loaded slots need no server publication');
assert.equal(publicCourseGroups([], ['SSX_SNOW']).local[0].name, 'Snowdream (SSX)');
assert.equal(publicCourseGroups([], ['SNOW', 'SSX_SNOW']).local.length, 2, 'original and Tricky courses coexist');
assert(isDiscCourse('ssx_snow'), 'original SSX slots can be opened locally without a server publication');
assert.deepEqual(
  requiredIsoState(['GARI', 'SNOW', 'gari'], ['gari']),
  [
    { slot: 'GARI', name: 'Garibaldi', loaded: true },
    { slot: 'SNOW', name: 'Snowdream', loaded: false },
  ],
  'each donor has its own loaded state, including a partial local cache',
);
assert.deepEqual(
  requiredIsoState(['GARI', 'TRICKY_GARI', 'SNOW'], ['tricky_gari']),
  [
    { slot: 'GARI', name: 'Garibaldi', loaded: true },
    { slot: 'SNOW', name: 'Snowdream', loaded: false },
  ],
  'legacy and namespaced Tricky dependencies share one loaded state',
);
assert.equal(requiredIsoState(['TRICKY_GARI'], ['GARI'])[0].loaded, true);
const origin = 'https://slopesmith.example';
registerDiscCourseNames({ AVALANCHE_CRS01_00: 'From the selected disc', GARI: 42 });
const imported = publicCourseGroups([], ['AVALANCHE_CRS01_00']).local[0];
assert.equal(imported.name, 'From the selected disc');
assert.equal(imported.id, 'AVALANCHE_CRS01_00');
assert.equal(publicCourseRequest(new URL(publicCourseUrl(imported, origin)))?.name, imported.id);
assert.equal(
  publicCourseGroups([], ['GARI']).local[0].name,
  'Garibaldi',
  'Invalid titles do not replace legacy labels',
);
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
assert.equal(MAPS_PATH, '/');
assert.equal(ISOS_PATH, '/');
assert.equal(new URL(isoManagementUrl(undefined, origin)).searchParams.get('view'), 'games');
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
assert.equal(courseEditorUrl({ ...named, private: true }, origin), `${origin}/editor/My_Mountain?project=custom`);
assert.equal(courseEditorUrl(reference, origin), `${origin}/editor?reference=RENAMED_GARI`);
assert.equal(courseEditorUrl({ ...named, name: 'A map' }, origin), `${origin}/editor/A%20map`);
assert.equal(editorUrlForPublicMap(new URL(`${origin}/maps`)), `${origin}/editor`);
assert.equal(editorUrlForPublicMap(new URL(`${origin}/isos`)), `${origin}/editor`);
assert.equal(editorUrlForPublicMap(new URL(`${origin}/play/My_Mountain?room=friends`)), `${origin}/editor/My_Mountain`);
assert.equal(editorUrlForPublicMap(new URL(`${origin}/isos?map=My_Mountain`)), `${origin}/editor/My_Mountain`);
assert.equal(editorUrlForPublicMap(new URL(publicCourseUrl(reference, origin))), courseEditorUrl(reference, origin));
const localGari = groups.local.find(course => course.id === 'GARI')!;
const saved = { ...named, id: 'local-fixture', localProjectId: 'local-fixture' };
const savedRequest = publicCourseRequest(new URL(publicCourseUrl(saved, origin)));
assert.equal(savedRequest?.localProjectId, saved.id);
assert.equal(
  resolvePublicCourse(savedRequest, [named], [], [saved]),
  saved,
  'a saved player link opens the browser copy even when a server map has the same name',
);
assert.equal(
  resolvePublicCourse(savedRequest, [named], []),
  null,
  'a deleted local copy never falls through to a server map',
);
assert.equal(new URL(courseEditorUrl(saved, origin)).searchParams.get('local'), saved.id);
assert.equal(editorUrlForPublicMap(new URL(publicCourseUrl(saved, origin))), courseEditorUrl(saved, origin));
const serverGari = { ...reference, id: 'GARI', name: 'Garibaldi' };
const isoUrl = publicCourseUrl(localGari, origin);
assert.equal(new URL(isoUrl).searchParams.get('source'), 'iso');
assert.equal(
  resolvePublicCourse(publicCourseRequest(new URL(isoUrl)), [serverGari], ['GARI'])?.source,
  'iso',
  'an ISO link keeps its source when a server reference has the same course ID',
);
assert.equal(
  resolvePublicCourse(publicCourseRequest(new URL(publicCourseUrl(serverGari, origin))), [serverGari], ['GARI']),
  serverGari,
  'a server reference link retains the server catalogue entry',
);
assert.equal(new URL(isoManagementUrl(localGari, origin)).searchParams.get('source'), 'iso');
assert.equal(
  resolvePublicCourse({ kind: 'reference', name: 'RENAMED_GARI', source: 'iso' }, [reference], []),
  null,
  'an unknown uncached slot cannot resolve to the server reference through an ISO link',
);
assert.equal(
  resolvePublicCourse({ kind: 'reference', name: 'RENAMED_GARI', source: 'iso' }, [reference], ['RENAMED_GARI'])
    ?.source,
  'iso',
  'an imported ISO slot outside the built-in name list survives reload without selecting its server reference',
);
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
assert(isDiscCourse('tricky_gari'));
assert(!isDiscCourse('TRICKY_PRIVATE_REFERENCE'));
assert(!isDiscCourse('TRICKY_SSX_SNOW'));
assert.equal(canonicalDiscCourse('gari'), 'TRICKY_GARI');
assert.equal(canonicalDiscCourse('SSX_SNOW'), 'SSX_SNOW');
assert.equal(canonicalDiscCourse('TRICKY_GARI'), 'TRICKY_GARI');
assert.equal(discCourseName('TRICKY_GARI'), 'Garibaldi');
assert(discContainsCourse(['TRICKY_GARI'], 'GARI'));
assert(discContainsCourse(['GARI'], 'TRICKY_GARI'));
assert(discContainsCourse(['TRICKY_FIXTURE'], 'FIXTURE'));
assert(discContainsCourse(['MY_RUN'], 'TRICKY_MY_RUN'));
assert(!isDiscCourse('TRICKY_FIXTURE'), 'source aliases do not widen the public course catalogue');
assert(!discContainsCourse(['TRICKY_SSX_SNOW'], 'SSX_SNOW'));
assert(!discContainsCourse(['TRICKY_GARI'], 'SSX_GARI'));
registerDiscCourseNames({ TRICKY_GARI: 'Recovered Tricky title' });
assert.equal(discCourseName('TRICKY_GARI'), 'Recovered Tricky title');
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
const placeholders = publicMountainDocument(document, [], true);
assert.deepEqual(placeholders.quadTex, document.quadTex, 'missing-texture markers retain the original references');
assert.deepEqual(
  placeholders.props,
  document.props,
  'missing-prop markers retain placements without editing the saved map',
);
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
const customSky = defaultMountain();
const dawn = { on: true, source: { kind: 'custom', name: 'dawn' }, topColor: '#ffffff' } as const;
customSky.skybox = { ...dawn, ring: 'GARI' };
assert.deepEqual(
  projectIsoCourses(customSky),
  [],
  'an uploaded sky plays from its own panorama, so its export ring is not an ISO requirement',
);
assert.deepEqual(
  classifyExportProvenance(customSky, {}).reasons,
  ['retail-sky-ring', 'user-sky'],
  'the export still declares the retail ring it copies the custom sky onto',
);
assert.deepEqual(
  projectIsoCourses({ ...customSky, skybox: dawn }),
  [],
  'a custom sky that names no ring is no different',
);
customSky.gems = [{ pos: [0, 0, 0] }];
assert.deepEqual(
  projectIsoCourses(customSky),
  ['GARI'],
  'a feature the player draws from disc art still needs a donor',
);
const levelSky = defaultMountain();
levelSky.skybox = { on: true, source: { kind: 'level', level: 'SNOW' }, topColor: '#ffffff' };
assert.deepEqual(projectIsoCourses(levelSky), ['SNOW'], 'a level sky lists the course it borrows');
const localDocument = defaultMountain();
localDocument.quadTex = {
  0: 'renamed-gari/snow.png',
  1: `asset2:ssx-tricky:TRICKY_GARI:texture:snow.png:${'a'.repeat(64)}`,
};
localDocument.skybox = { on: true, source: { kind: 'level', level: 'renamed-sky' }, topColor: '#ffffff' };
localDocument.props = [
  {
    level: `asset2:ssx-3-beta:SSX3B_ESS3:prop:42:${'b'.repeat(64)}`,
    model: 42,
    name: 'Tree',
    pos: [0, 0, 0],
    yaw: 0,
    scale: 1,
  },
];
const localBundle: ProjectBundle = {
  kind: 'slopesmith-project',
  schema: 1,
  name: 'Downloaded map',
  revision: 28703,
  takenAt: '2026-11-04T19:47:11Z',
  document: localDocument,
  isoAliases: { 'Renamed-Gari': 'TRICKY_GARI', 'renamed-sky': 'TRICKY_MERQUER' },
  assets: [{ kind: 'prop', name: 'custom-prop.json', hash: 'prop-materials', size: 1 }],
  blobs: {
    'prop-materials': btoa(
      JSON.stringify({ materials: [{ tex: 'SSX_SNOW/tile.png', frames: ['Custom/owned.png', 'GARI/animated.png'] }] }),
    ),
  },
};
const beforeLocalBundle = JSON.stringify(localBundle);
const localCourse = localProjectCourse({ id: 'local-saved-copy', name: localBundle.name }, localBundle);
assert.deepEqual(
  localCourse.isoCourses,
  ['SSX3B_ESS3', 'SSX_SNOW', 'TRICKY_GARI', 'TRICKY_MERQUER'],
  'old local bundles recover pinned props, textures, sky aliases and embedded material dependencies',
);
assert(localCourse.retailData);
assert.equal(localCourse.localProjectId, 'local-saved-copy');
assert.deepEqual(
  requiredIsoState(localCourse.isoCourses, ['GARI']).map(row => [row.slot, row.loaded]),
  [
    ['SSX3B_ESS3', false],
    ['SSX_SNOW', false],
    ['TRICKY_GARI', true],
    ['TRICKY_MERQUER', false],
  ],
);
assert.deepEqual(
  resolvePublicCourse(publicCourseRequest(new URL(isoManagementUrl(localCourse, origin))), [], [], [localCourse]),
  localCourse,
  'Load ISO maps retains the saved copy, even when no public map has that name',
);
assert.equal(JSON.stringify(localBundle), beforeLocalBundle, 'reporting requirements preserves the saved bundle');
assert.deepEqual(
  bundleIsoCourses({ ...localBundle, blobs: { 'prop-materials': 'invalid base64' } }),
  ['SSX3B_ESS3', 'TRICKY_GARI', 'TRICKY_MERQUER'],
  'one corrupt custom prop cannot hide other dependencies',
);
assert.deepEqual(
  bundleIsoCourses({ ...localBundle, document: defaultMountain(), assets: [], isoAliases: {} }),
  [],
  'an original mountain without disc assets has no ISO requirements',
);
const withSourceMap = structuredClone(localBundle);
withSourceMap.document.quadTex![2] = `asset2:slopesmith:TEST_MTN_7:texture:oob.png:${'c'.repeat(64)}`;
assert.deepEqual(
  bundleAssetRequirements(withSourceMap),
  {
    isoCourses: localCourse.isoCourses,
    referenceMaps: ['TEST_MTN_7'],
  },
  'custom reference-map versions are reported separately and never invented as Tricky ISO slots',
);
console.log('PUBLIC COURSE LIST PASS: named links, local bundle dependencies, source maps and partial ISO assets.');
