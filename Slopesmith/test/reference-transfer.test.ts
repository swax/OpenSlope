// tier: fast
import assert from 'node:assert/strict';
import { referenceFilePath, referenceManifest } from '../src/shared/reference-transfer';
import { referenceForCourse } from '../src/app/public/reference-upload';

for (const path of [
  'Patches.json',
  'Source/GARI.PBD',
  'Source/Resources.bin',
  'Textures/Particles/snow.png',
  'Audio/Music/song/graph.json',
])
  assert(referenceFilePath(path), path);
for (const path of [
  '../Patches.json',
  '/Patches.json',
  'Source/../Patches.json',
  'Source/a\\b',
  'Source/CON.bin',
  'Source/nul',
  'Source/a.',
  'Source/a ',
  'Source//a',
  'Source/C:a',
  'Other/file',
  'disc.iso',
  'patches.json/child',
])
  assert(!referenceFilePath(path), path);
const file = { path: 'Patches.json', size: 8, sha256: 'a'.repeat(64) };
const manifest = { course: 'TRICKY_GARI', music: false, files: [file] };
assert.deepEqual(referenceManifest(manifest), manifest);
assert.throws(() => referenceManifest({ ...manifest, files: [file, { ...file, path: 'patches.json' }] }), /Duplicate/);
assert.throws(() => referenceManifest({ ...manifest, files: [{ ...file, path: 'patches.json' }] }), /Patches/);
assert.throws(() => referenceManifest({ ...manifest, course: 'SHARED' }));
assert.throws(() => referenceManifest({ ...manifest, files: [file, { ...file, size: 2 ** 30 }] }));
assert.throws(() => referenceManifest({ ...manifest, files: [file, { ...file, path: 'Audio/Music/song.json' }] }));
assert.throws(
  () =>
    referenceManifest({
      ...manifest,
      files: [file, { ...file, path: 'Source/a.json' }, { ...file, path: 'Source/a.json/child' }],
    }),
  /Conflicting/,
);
assert(referenceManifest({ ...manifest, music: true, files: [file, { ...file, path: 'Audio/Intro/song.wav' }] }));
assert.equal(referenceForCourse([{ name: 'GARI', course: 'GARI' }], 'TRICKY_GARI')?.name, 'GARI');
assert.equal(referenceForCourse([{ name: 'TRICKY_GARI', course: 'TRICKY_GARI' }], 'GARI')?.name, 'TRICKY_GARI');
console.log('Reference manifest boundaries, music selection and legacy course identity PASS');
