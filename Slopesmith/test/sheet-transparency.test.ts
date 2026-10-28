// tier: fast

/** Sheet preview and portable export must agree on pixel alpha, including old saves and borrowed art. */
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { blankMountain } from '../src/core/doc/mountain';
import { AUTHORED_MODEL_LEVEL, authoredModelLevelProps, modelNumber } from '../src/core/doc/models';
import type { AuthoredModel } from '../src/core/doc/types';
import { buildExportFolder } from '../src/core/export/folder';
import type { CombinedMaterial } from '../src/core/export/materials';
import type { ExportProvider } from '../src/core/export/provider';
import type { PropAlphaMode } from '../src/core/reference/props';
import { analyzeTexturePixels, type TextureAlphaAnalysis } from '../src/core/props/texture-alpha';
import { PropTextureCache } from '../src/app/props/textures';
import { decodePng, encodePng } from '../src/server/routes/png';

const alphaTiles: [string, number[]][] = [
  ['solid.png', [255, 255]],
  ['holes.png', [255, 0]],
  ['water.png', [128, 128]],
  ['blank.png', [0, 0]],
];
const images = new Map(
  alphaTiles.map(([name, alphas]) => {
    const data = Uint8Array.from(alphas.flatMap(alpha => [40, 80, 120, alpha]));
    return [name, { w: 2, h: 1, data }] as const;
  }),
);
const pngs = new Map([...images].map(([name, image]) => [name, encodePng(image)]));
const cases: { name: string; tile: string; mode: PropAlphaMode; frames?: string[] }[] = [
  { name: 'Solid', tile: 'solid.png', mode: 'opaque' },
  { name: 'Fence', tile: 'holes.png', mode: 'cutout' },
  { name: 'Water', tile: 'water.png', mode: 'blend' },
  { name: 'Blank', tile: 'blank.png', mode: 'cutout' },
  { name: 'Water with blank frame', tile: 'water.png', frames: ['water.png', 'blank.png'], mode: 'blend' },
  { name: 'Solid with hole frame', tile: 'solid.png', frames: ['solid.png', 'holes.png'], mode: 'cutout' },
];

const doc = blankMountain('SHEET_ALPHA');
doc.models = [];
doc.props = [];
for (const test of cases) {
  for (const legacy of [undefined, false, true]) {
    const id = `model:${doc.models.length.toString().padStart(4, '0')}`;
    const model: AuthoredModel = {
      id,
      name: `${test.name} (${legacy})`,
      anchor: [0, 0, 0],
      vertices: [0, 0, 0, 4, 0, 0, 0, 3, 0, 4, 3, 0],
      quads: [[0, 1, 2, 3]],
      texture: `DONOR/${test.tile}`,
      line: `line:${id}`,
      ...(test.frames ? { frames: test.frames.map(frame => `DONOR/${frame}`) } : {}),
      ...(legacy !== undefined ? { blend: legacy } : {}),
    };
    doc.models.push(model);
    doc.props.push({
      id: `prop:${id}`,
      level: AUTHORED_MODEL_LEVEL,
      model: modelNumber(id),
      name: model.name,
      pos: [0, 0, 0],
      yaw: 0,
      scale: 1,
    });
  }
}
// An unused library model must not make export read a texture it does not ship.
doc.models.push({ ...doc.models[0], id: 'model:9999', texture: 'DONOR/missing.png' });
// A borrowed prop sharing the water image keeps its explicit opaque source material.
doc.props.push({ level: 'DONOR', model: 99, name: 'Native opaque', pos: [8, 0, 0], yaw: 0, scale: 1 });

const textureReads: string[] = [];
const provider: ExportProvider = {
  groupDefs: async () => new Map(),
  modelGeometry: async () => (level, model) =>
    level === 'DONOR' && model === 99
      ? { subs: [{ mat: 0, positions: [0, 0, 0, 100, 0, 0, 0, 0, 100], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2] }] }
      : null,
  materialTables: async () =>
    new Map([['DONOR', [{ TexturePath: 'water.png', UnknownInt18: 0, AlphaMode: 'opaque' }]]]),
  importedProps: async () => ({ level: '@import', models: [], instances: [], materials: [] }),
  nativeArt: async () => ({ gemLevel: '', gemTiers: [], railSkins: {} }),
  referenceTexture: async (level, name) => {
    assert.equal(level, 'DONOR');
    textureReads.push(name);
    if (!pngs.has(name)) throw new Error(`missing texture: ${name}`);
    return pngs.get(name)!;
  },
  decodePng: async bytes => decodePng(Buffer.from(bytes)),
  encodePng: async image => encodePng(image),
  particleTexture: async () => new Uint8Array(),
  customSound: async () => new Uint8Array(),
  soundIndex: async () => null,
  courseEffectSound: async () => new Uint8Array(),
  namedEffectSound: async () => new Uint8Array(),
  environmentEffectSound: async () => new Uint8Array(),
  skybox: async () => ({ files: [], log: [] }),
  stageRaceMusic: async () => ({ status: 'cleared', files: [], remove: [] }),
  discRecipePaths: async () => ({ exportDir: 'SHEET_ALPHA', levelData: 'DONOR', levelDataRelative: '../DONOR' }),
};
const folder = await buildExportFolder(doc, provider, { lighting: false });
const bytesOf = (name: string) => {
  const file = folder.files.find(file => file.path === name);
  assert(file, `missing export file: ${name}`);
  return file.bytes;
};
const readJson = (name: string) => JSON.parse(new TextDecoder().decode(bytesOf(name)));
const materials = readJson('Materials.json').Materials as CombinedMaterial[];
const overrides = readJson('TextureAlpha.overrides.json') as Record<string, PropAlphaMode>;
const obj = new TextDecoder().decode(bytesOf('Props.obj'));

// Seed the real viewport cache with decoded fixture pixels; only network/image loading is stubbed.
const cache = new PropTextureCache();
const internals = cache as unknown as {
  loader: { load: () => THREE.Texture };
  alphaAnalyses: Map<string, TextureAlphaAnalysis>;
};
internals.loader = { load: () => new THREE.Texture() };
for (const [name, image] of images)
  internals.alphaAnalyses.set(`DONOR/${name}`, analyzeTexturePixels(image.data, image.w, image.h));
const preview = authoredModelLevelProps(doc);
for (const [index, test] of cases.entries()) {
  for (let legacy = 0; legacy < 3; legacy++) {
    const i = index * 3 + legacy;
    const source = preview.materials.get(i)!;
    assert.equal(source.pixelAlpha, true);
    assert.equal(source.blend, undefined, 'old see-through settings must not reach the renderer');
    const mat = cache.material(
      'DONOR',
      test.tile,
      test.frames ? { textureFlip: { direction: 0, speed: 1, length: 0, dwell: false } } : undefined,
      source.frames,
      undefined,
      { pixelAlpha: source.pixelAlpha, sheet: true },
    );
    assert.equal(mat.transparent, test.mode === 'blend', `${test.name}: preview blend`);
    assert.equal(mat.depthWrite, test.mode !== 'blend', `${test.name}: sheet depth`);
    assert.equal(mat.alphaHash, test.mode === 'cutout', `${test.name}: preview cutout`);

    const slot = obj.match(new RegExp(`^o inst\\d+_Model_${i}_[^\\n]+\\nusemtl mat_(\\d+)`, 'm'))?.[1];
    assert(slot, `missing material assignment for ${test.name}`);
    const exported = materials[Number(slot)];
    assert.equal(overrides[exported.TexturePath], test.mode, `${test.name}: export mode`);
    assert.equal(exported.UnknownInt18 & 0x40000, test.mode === 'opaque' ? 0 : 0x40000, `${test.name}: native flag`);
    assert.deepEqual(bytesOf(`Textures/${exported.TexturePath}`), pngs.get(test.tile), 'PNG bytes stay verbatim');
    for (const frame of exported.TextureFlipbook)
      assert.equal(overrides[frame], test.mode, 'every flipbook frame carries its material mode');
  }
}
assert.equal(overrides['p_DONOR_water.png'], 'opaque', 'the borrowed prop keeps its source override');
assert(folder.remove.includes('TextureAlpha.overrides.json'), 're-export retires stale alpha overrides');
assert(!textureReads.includes('missing.png'), 'unused library models do not request texture pixels');
const missingDoc = structuredClone(doc);
missingDoc.models![0].texture = 'DONOR/missing.png';
const missingFolder = await buildExportFolder(missingDoc, provider, { lighting: false });
assert(
  missingFolder.log.some(line => line.includes('missing.png') && line.includes('WARN')),
  'missing art still warns instead of aborting export',
);
const missingOverrides = JSON.parse(
  new TextDecoder().decode(missingFolder.files.find(file => file.path === 'TextureAlpha.overrides.json')!.bytes),
);
assert.equal(
  missingOverrides['a_cutout_DONOR_missing.png'],
  'cutout',
  'unavailable pixels use the same conservative policy as the preview',
);
console.log('SHEET TRANSPARENCY: PASS (preview, export, legacy flags, flipbooks and shared source textures)');
