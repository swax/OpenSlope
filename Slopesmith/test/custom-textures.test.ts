/**
 * Custom texture store checks: saveCustomTexture normalises what the user loads into the same kind of file
 * the extracted levels carry (8-bit RGBA PNG, ≤512 per edge, safe name) and never lands on a name that is
 * taken, the Custom folder stays OUT of the real-level list, and a "Custom/<name>.png" ref resolves through
 * the same consumers as an extracted level's tile — the palette listing, the byte reader, and the export
 * combiner's tile slot.
 * Run: tsx test/custom-textures.test.ts
 *
 * Writes real files under an isolated mountain assets/textures folder and removes them afterwards; the
 * Custom folder itself is kept only if it existed before the run or holds the user's own tiles.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { AUTHORED_MODEL_LEVEL, commitModelEditDoc, createAuthoredModel, modelEditDocFor, modelNumber } from '../src/core/doc/models';
import { appendPatchFromCorners } from '../src/core/mesh/ops';
import { ensurePlacedPropIds } from '../src/core/effects/authoring';
import { CUSTOM_TEX_LEVEL, MAX_CUSTOM_TEX, cloneCustomTexture, customTextureExists, deleteCustomTexture, deriveLevelTextures, levelsWithTextures, readTextureBytes, renameCustomTexture, replaceCustomTexture, saveCustomTexture } from '../src/server/routes/textures';
import { countImportedTextureUsers, retargetImportedTexture, saveImportedProp } from '../src/server/routes/imported-props';
import { retiredNamesFile } from '../src/server/routes/safe-name';
import { exportLevel } from '../src/server/routes/export';
import { preflightFor } from '../src/server/routes/preflight';
import { computePreflight } from '../src/core/export/preflight';
import type { SkyPanel, SkyRing } from '../src/core/sky/ring';
import { createMaterialCombiner, materialsWithAlphaOverrides } from '../src/server/routes/props';
import { buildMaterialCombiner } from '../src/core/export/materials';
import { decodePng, encodePng } from '../src/server/routes/png';
import { textureUrl } from '../src/app/net/asset-paths';
import { makeSeamless, seamError } from '../src/core/paint/seamless';
import { suggestTextureName } from '../src/core/paint/textures';
import {
  DEFAULT_FAL_3D_MODEL, DEFAULT_FAL_INPAINT_MODEL, DEFAULT_FAL_MODEL, FAL_3D_MODELS,
  FAL_INPAINT_MODELS, FAL_MODELS, FAL_PANORAMA_MODEL, FAL_PANORAMA_USD,
  FAL_PROVIDER_TERMS, GEN_SIZES, STORE_SIZES, createFalGenerationProvenance,
  estimateInpaintUsd, estimateUsd, fal3dDetail, fal3dModel, falEndpoint,
  falEndpointMayGenerate, parseFalGenerationProvenance,
} from '../src/core/paint/fal-models';
import { scaleDraftTo } from '../src/core/props/imported';
import { check, failures } from './check';

/**
 * A ring shaped like the one Snowknife measures off a retail level — 8 upper wall panels, 16 lower, and the
 * ground cap — without needing extracted Maps data on disk. Only the panel bands and the tile count feed the
 * preflight's page pricing; the geometry is filled in plausibly so the value type-checks as a real `SkyRing`.
 */
const RETAIL_SHAPED_RING: SkyRing = {
  radius: 1, topZ: 0.5, midZ: 0, bottomZ: -0.5, groundUvRadius: 0.5,
  groundIndex: 24,
  panels: [
    ...Array.from({ length: 8 }, (_, i): SkyPanel =>
      ({ index: i, band: 'upper', azFrom: i * 45, azTo: (i + 1) * 45 })),
    ...Array.from({ length: 16 }, (_, i): SkyPanel =>
      ({ index: 8 + i, band: 'lower', azFrom: i * 22.5, azTo: (i + 1) * 22.5 })),
  ],
  tiles: Array.from({ length: 25 }, () => ({ w: 64, h: 64 })),
};

/** A solid-colour RGBA fixture image encoded as PNG bytes. */
const fixture = (w: number, h: number, rgba: [number, number, number, number]) => {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set(rgba, i * 4);
  return encodePng({ w, h, data });
};

const assetRoot = mkdtempSync(join(tmpdir(), 'slopesmith-texture-assets-'));
process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = assetRoot;
const customDir = join(assetRoot, 'textures');
const hadDirBefore = existsSync(customDir);
const written: string[] = [];
/** The library's retired names outlive the files they came from, which is the point of them — so the run's
 *  own retirements are rolled back afterwards, leaving the user's record exactly as it was. */
const retiredFile = retiredNamesFile(customDir);
const retiredBefore = existsSync(retiredFile) ? readFileSync(retiredFile) : null;
/** Imported-prop records the Replace checks need a real on-disk wearer for; removed with the tiles. */
const importedDir = join(assetRoot, 'props');
const hadImportedDirBefore = existsSync(importedDir);
const propsWritten: string[] = [];
/** Storing one costs a model number, which the prop catalogue records so a deleted one is never reissued.
 *  Rolled back with the record, so a test run leaves the author's numbering exactly where it was. */
const propIdFile = `${importedDir}.nextid.json`;
const propIdBefore = existsSync(propIdFile) ? readFileSync(propIdFile) : null;

try {
  // --- store + sanitise ---------------------------------------------------------------------------
  const name = await saveCustomTexture('zz test tile!.png', fixture(64, 32, [10, 200, 30, 255]));
  written.push(name);
  check(name === 'zztesttile.png', `stored name is sanitised to the level-asset alphabet (${name})`);
  check(existsSync(join(customDir, name)), 'file lands under the mountain assets/textures folder');
  const small = decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, name));
  check(small.w === 64 && small.h === 32, 'an in-budget image keeps its size');
  check(small.data[0] === 10 && small.data[1] === 200 && small.data[2] === 30 && small.data[3] === 255,
    'pixels round-trip through the normalising re-encode');

  // A generated PNG keeps a canonical model/terms snapshot beside it, and that sidecar follows the image
  // through the two identity-preserving library operations. Deleting the asset deletes its sidecar too.
  const generatedAt = '2026-08-16T19:30:00.000Z';
  const generation = createFalGenerationProvenance([DEFAULT_FAL_MODEL], generatedAt);
  const generated = await saveCustomTexture('zz-test-generated', fixture(8, 8, [9, 8, 7, 255]), generation);
  written.push(generated);
  const generatedStem = generated.replace(/\.png$/i, '');
  const generatedSidecar = join(customDir, `${generatedStem}.generation.json`);
  const archived = JSON.parse(readFileSync(generatedSidecar, 'utf8'));
  check(archived.generatedAt === generatedAt && archived.models[0].id === DEFAULT_FAL_MODEL,
    'a generated tile archives its generation date and exact model beside the PNG');
  check(archived.providerTerms.apiServicesTerms === FAL_PROVIDER_TERMS.apiServicesTerms,
    'a generated tile archives the reviewed fal API Terms reference');
  const generatedProp = await saveImportedProp('zz-test-generated-prop', {
    name: 'zz test generated prop', tris: 1,
    subs: [{ mat: 0, pos: '', uv: '', idx: '' }],
    materials: [{ id: 0, tex: null }], generation,
  });
  propsWritten.push(generatedProp.file);
  const propArchive = JSON.parse(readFileSync(join(importedDir, generatedProp.file), 'utf8'));
  check(propArchive.generation.generatedAt === generatedAt
    && propArchive.generation.models[0].id === DEFAULT_FAL_MODEL,
  'a generated prop embeds the same endpoint/terms snapshot in its stored record');
  const generatedMoved = await renameCustomTexture(generated, 'zz-test-generated-moved');
  written.push(generatedMoved);
  check(existsSync(join(customDir, generatedMoved.replace(/\.png$/i, '.generation.json')))
    && !existsSync(generatedSidecar), 'renaming a generated tile moves its provenance sidecar');
  const generatedClone = await cloneCustomTexture(generatedMoved, 'zz-test-generated-copy');
  written.push(generatedClone);
  check(existsSync(join(customDir, generatedClone.replace(/\.png$/i, '.generation.json'))),
    'cloning a generated tile copies its provenance sidecar');
  await deleteCustomTexture(generatedMoved);
  await deleteCustomTexture(generatedClone);
  check(!existsSync(join(customDir, generatedMoved.replace(/\.png$/i, '.generation.json')))
    && !existsSync(join(customDir, generatedClone.replace(/\.png$/i, '.generation.json'))),
  'deleting generated tiles removes their provenance sidecars');

  // --- oversize shrink ----------------------------------------------------------------------------
  const big = await saveCustomTexture('zz-test-big', fixture(700, 300, [255, 0, 0, 255]));
  written.push(big);
  const shrunk = decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, big));
  check(shrunk.w === MAX_CUSTOM_TEX && shrunk.h === Math.round(300 * (MAX_CUSTOM_TEX / 700)),
    `oversize art shrinks to fit ${MAX_CUSTOM_TEX} keeping aspect (${shrunk.w}x${shrunk.h})`);
  check(shrunk.data[0] === 255 && shrunk.data[1] === 0, 'shrunk pixels keep their colour');

  // --- names never overwrite (docs/038) -----------------------------------------------------------
  // The rule that makes a shared library safe, and the reason a tile's URL is a permanent address: an
  // upload under a name that is taken lands BESIDE it. Nothing anyone already painted can change underfoot.
  const second = await saveCustomTexture('zz test tile!', fixture(16, 16, [0, 0, 250, 255]));
  written.push(second);
  check(second === 'zztesttile_2.png', `a second upload of one name lands as _2 (${second})`);
  const untouched = decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, name));
  check(untouched.w === 64 && untouched.h === 32 && untouched.data[1] === 200,
    'the first tile is byte-for-byte what it was — the second upload did not reach it');
  check(decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, second)).data[2] === 250,
    'the second upload keeps its own art under its own name');
  const third = await saveCustomTexture('zztesttile', fixture(8, 8, [1, 2, 3, 255]));
  written.push(third);
  check(third === 'zztesttile_3.png', `a third lands as _3, walking past the taken names (${third})`);

  // Two uploads of one name arriving together: the collision check and the write are one read-modify-write,
  // so without serializing them both see the name free and the second silently eats the first.
  const [raceA, raceB] = await Promise.all([
    saveCustomTexture('zz-test-race', fixture(4, 4, [5, 0, 0, 255])),
    saveCustomTexture('zz-test-race', fixture(4, 4, [0, 5, 0, 255])),
  ]);
  written.push(raceA, raceB);
  check(raceA !== raceB && new Set([raceA, raceB]).size === 2,
    `concurrent uploads of one name get two distinct names (${raceA}, ${raceB})`);
  check(decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, raceA)).data[0] === 5
    && decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, raceB)).data[1] === 5,
    'each concurrent upload kept its own bytes');

  // The logical ref is permanent inside one mountain; the request also carries the tab scope that chooses
  // which mountain owns those bytes.
  const tileUrl = new URL(textureUrl(CUSTOM_TEX_LEVEL, name), 'http://slopesmith.test');
  check(tileUrl.pathname === '/api/texture' && tileUrl.searchParams.get('level') === CUSTOM_TEX_LEVEL
    && tileUrl.searchParams.get('name') === name && !!tileUrl.searchParams.get('client'),
  'a tile URL carries its logical ref and the tab identity that scopes it to a mountain');

  // --- listings -----------------------------------------------------------------------------------
  check(!(await levelsWithTextures()).some(l => l.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()),
    'Custom stays out of the real-level list (the repack-target menu)');
  const listed = await deriveLevelTextures(CUSTOM_TEX_LEVEL);
  check(listed.level === CUSTOM_TEX_LEVEL && listed.tiles.some(t => t.name === name && t.count === 0),
    'the Custom level lists its tiles to the palette (terrain-usage count 0)');

  // --- export combiner ----------------------------------------------------------------------------
  const combiner = await createMaterialCombiner();
  const slot = combiner.resolveTileSlot(`${CUSTOM_TEX_LEVEL}/${name}`);
  check(slot >= 0, 'resolveTileSlot accepts a Custom ref');
  const mat = combiner.materials[slot];
  check(mat?.TexturePath === `p_${CUSTOM_TEX_LEVEL}_${name}` && mat?.UnknownInt18 === 0,
    'the combined material copies the tile and defaults to opaque (no source material to inherit from)');
  check(combiner.texCopies.some(c => c.level === CUSTOM_TEX_LEVEL && c.name === name),
    'the tile is queued for the verbatim export copy');

  const blendSlot = combiner.resolveTileSlot(`${CUSTOM_TEX_LEVEL}/${name}`, [], true);
  check(blendSlot !== slot && combiner.materials[blendSlot]?.UnknownInt18 === 0x40000,
    'a custom tile can request its own alpha-blend slot without changing an opaque use of the same art');

  // A flipbook material is the same tile plus a state list. It takes its OWN slot: the frame list is part
  // of what the material is, so a plain use of the same tile must not silently inherit — or lose — it.
  const frame1 = await saveCustomTexture('zz-test-flip-f1', fixture(64, 64, [20, 200, 90, 255]));
  written.push(frame1);
  const flipSlot = combiner.resolveTileSlot(`${CUSTOM_TEX_LEVEL}/${name}`, [name, frame1]);
  const flipMat = combiner.materials[flipSlot];
  check(flipSlot !== slot
    && flipMat?.TextureFlipbook.join(' ') === `p_${CUSTOM_TEX_LEVEL}_${name} p_${CUSTOM_TEX_LEVEL}_${frame1}`
    && combiner.materials[slot]?.TextureFlipbook.length === 0,
    'a declared flipbook lands in its own combined material, leaving the plain tile\'s entry a still image');
  check(combiner.texCopies.some(c => c.level === CUSTOM_TEX_LEVEL && c.name === frame1),
    'every frame of the state list is queued for copy, not just the one the material draws at rest');

  const forcedTable = materialsWithAlphaOverrides(
    [{ TexturePath: 'TowerGlass.PNG', UnknownInt18: 0x15008 }], { 'towerglass.png': 'cutout' });
  const forcedCombiner = buildMaterialCombiner(new Map([['SOURCE', forcedTable]]));
  const forcedSlot = forcedCombiner.resolveSlot('SOURCE', 0);
  check(forcedTable[0].AlphaMode === 'cutout'
    && forcedCombiner.alphaOverrides['p_SOURCE_TowerGlass.PNG'] === 'cutout'
    && (forcedCombiner.materials[forcedSlot].UnknownInt18 & 0x40000) !== 0,
  'a case-insensitive TextureAlpha sidecar forces a native opaque material and follows its copied export page');

  // --- the tile actually lands in the export -------------------------------------------------------
  // End-to-end, because the unit checks above all pass even if the copy loop writes nothing: an empty
  // Textures/ leaves the repacker no page to install and every material silently falls back to slot 0000
  // in-game, which looks like "my custom textures were replaced by a stock one" rather than an error.
  const big512 = await saveCustomTexture('zz-test-export', fixture(512, 512, [200, 100, 50, 255]));
  written.push(big512);
  const mountain = migrateMountain(JSON.parse(JSON.stringify(defaultMountain())));
  const model = createAuthoredModel(mountain, 'Custom skin');
  const grown = appendPatchFromCorners(modelEditDocFor(mountain, model),
    [[0, -2, 20], [8, -2, 20], [8, -2.5, 50], [0, -2.5, 50]]);
  if (grown.ok) commitModelEditDoc(model, grown.doc);
  model.texture = `${CUSTOM_TEX_LEVEL}/${big512}`;
  // …and give it a FLIPBOOK, so the export is checked to carry a state list rather than only a still tile.
  // An authored model's list lives on its own document record; every frame is an ordinary bank tile.
  const modelFrame1 = await saveCustomTexture('zz-test-export-f1', fixture(64, 64, [40, 180, 90, 255]));
  written.push(modelFrame1);
  model.frames = [`${CUSTOM_TEX_LEVEL}/${big512}`, `${CUSTOM_TEX_LEVEL}/${modelFrame1}`];
  mountain.props = [{ level: AUTHORED_MODEL_LEVEL, model: modelNumber(model.id), name: model.name,
    pos: [model.anchor[0], model.anchor[1], model.anchor[2]], yaw: 0, scale: 1 }];
  ensurePlacedPropIds(mountain.props);
  // …and TERRAIN-PAINT a cell with the same tile. The two ride different channels: the model texture is
  // staged by the material combiner (p_-prefixed), the painted cell by the quilt under its own flattened
  // dest name. Both must land, or the repacker has no page to install and the material silently falls back
  // to slot 0000 in-game.
  mountain.quadTex = { 0: `${CUSTOM_TEX_LEVEL}/${big512}` };
  const dest = `p_${CUSTOM_TEX_LEVEL}_${big512}`;
  const terrainDest = `${CUSTOM_TEX_LEVEL}_${big512}`;

  {
    const outDir = mkdtempSync(join(tmpdir(), 'slopesmith-tex-export-'));
    try {
      const res = await exportLevel(mountain, { outDir, lighting: false });
      const file = join(outDir, 'Textures', dest);
      check(existsSync(file), `export: the model's custom tile lands in Textures/ (${dest})`);
      if (existsSync(file)) {
        const out = decodePng(readFileSync(file));
        check(out.w === MAX_CUSTOM_TEX && out.h === MAX_CUSTOM_TEX,
          `export: the copied tile keeps its stored size (${out.w}x${out.h})`);
      }
      // The state list has to survive the bake as the native field, with every frame staged — a flipbook
      // whose frames were never copied is a material that falls back to slot 0000 the moment it switches.
      const frameDest = `p_${CUSTOM_TEX_LEVEL}_${modelFrame1}`;
      const materialsJson = readFileSync(join(outDir, 'Materials.json'), 'utf8');
      check(materialsJson.includes(`"${dest}"`) && materialsJson.includes(`"${frameDest}"`),
        'export: an authored model\'s flipbook lands in Materials.json as a TextureFlipbook state list');
      check(existsSync(join(outDir, 'Textures', frameDest)),
        `export: every frame of that list is staged too (${frameDest})`);
      check(readFileSync(join(outDir, 'Patches.json'), 'utf8').includes(`"TexturePath":"${terrainDest}"`),
        'export: the painted cell ships its flattened dest name');
      const terrainFile = join(outDir, 'Textures', terrainDest);
      check(existsSync(terrainFile), `export: the painted tile is staged as Textures/${terrainDest}`);
      if (existsSync(terrainFile)) {
        const t = decodePng(readFileSync(terrainFile));
        check(t.w === MAX_CUSTOM_TEX && t.h === MAX_CUSTOM_TEX,
          `export: the staged painted tile keeps its stored size (${t.w}x${t.h})`);
      }
      // The flattened name loses the donor, so Slopesmith.json is what tells `repack` this page is the
      // author's own art to encode rather than a level page to install verbatim.
      const manifest = JSON.parse(readFileSync(join(outDir, 'Slopesmith.json'), 'utf8')) as
        { textures: Record<string, { level: string; staged?: string }> };
      check(manifest.textures[terrainDest]?.level === CUSTOM_TEX_LEVEL
        && manifest.textures[terrainDest]?.staged === terrainDest,
      'export: the manifest records the painted tile as Custom art with its staged copy');
      check(!/ERROR: all \d+ texture copies failed/.test(res.log ?? ''),
        'export: the copy loop reports no wholesale failure');
      // The disc is a separate command, so the folder carries it: the invocation, and the same build as a
      // repack-many manifest already naming this export.
      check(existsSync(join(outDir, 'Repack.md')), 'export: the folder carries the snowknife invocation');
      const many = JSON.parse(readFileSync(join(outDir, 'repack-many.json'), 'utf8')) as
        { InputIso?: string; OutputIso?: string; TextureType2?: boolean; BareSlot?: boolean;
          Noclip?: boolean; SkyColors?: boolean;
          Levels?: { Slot?: string; LevelData?: string; Export?: string }[] };
      check(!!many.InputIso && !!many.OutputIso && many.Levels?.length === 1
        && !!many.Levels[0].Slot && !!many.Levels[0].LevelData && many.Levels[0].Export === '.'
        && many.TextureType2 === true && many.BareSlot === true && many.SkyColors === false
        && many.Noclip === undefined,
      'export: the repack-many stub is complete, names this folder, selects the VRAM-safe page format '
      + 'and bare slot, and keeps the supplied executable unchanged by default');
      const recipe = readFileSync(join(outDir, 'Repack.md'), 'utf8');
      check(/repack .*--texture-type2 --bare-slot --no-skycolor --dry-run/.test(recipe)
        && /repack .*--texture-type2 --bare-slot --no-skycolor/.test(recipe)
        && !/^snowknife repack .*--patches/m.test(recipe)
        && recipe.includes('course-access cheat'),
      'export: the one-course recipes keep the executable stock and document the retail course-access path');
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }

  // --- preflight (docs/011): what the folder ships, not what a disc does with it -------------------
  {
    const pf = await preflightFor(mountain);
    const painted = pf.tiles.find(t => t.ref === `${CUSTOM_TEX_LEVEL}/${big512}`);
    check(painted?.cls === 'custom' && painted.cells === 1,
      'preflight classifies a Custom/ painted tile as custom and counts its cells');
    check(pf.cells.painted === 1 && pf.cells.unpainted === pf.cells.total - 1,
      'preflight counts painted against un-painted cells');

    // the sky line (docs/025): a custom sky's 25 forced-type-5 pages are priced exactly per tier; a donor
    // level's sky is verbatim and free. Standard = 8·128² + 16·64² + 256² texels × 4 B = exactly 1 MiB.
    //
    // The page count comes off the MEASURED ring, so the pure classifier has to be handed one — on the server
    // `preflightFor` reads it from the level (`routes/preflight.ts`). Rather than depend on extracted Maps
    // data, price against a synthetic ring shaped like the retail one: 8 upper panels, 16 lower, 1 ground.
    check(computePreflight(mountain).sky === undefined, 'no sky on the doc ⇒ no sky line');
    const skyDoc = { ...mountain, skybox: { source: { kind: 'custom' as const, name: 'zz-sky' }, on: true } };
    const skyPf = computePreflight(skyDoc, RETAIL_SHAPED_RING);
    check(skyPf.sky?.kind === 'custom' && skyPf.sky.pages === 25 && skyPf.sky.bytes === 1_048_576,
      'a custom sky prices its 25 standard-tier type-5 pages at exactly 1 MiB');
    const highPf = computePreflight({ ...skyDoc, skybox: { ...skyDoc.skybox, tier: 'high' as const } },
      RETAIL_SHAPED_RING);
    check(highPf.sky?.kind === 'custom' && highPf.sky.bytes === 3_407_872,
      'the high tier prices at ~3.3 MB — the unproven budget the dialog warns about');
    // no ring measured yet ⇒ the zero-sized estimate the route falls back to, never a wrong number
    const ringlessPf = computePreflight(skyDoc);
    check(ringlessPf.sky?.kind === 'custom' && ringlessPf.sky.pages === 0 && ringlessPf.sky.bytes === 0,
      'an unmeasured ring prices at zero rather than guessing a page count');
    const levelPf = computePreflight(
      { ...mountain, skybox: { source: { kind: 'level' as const, level: 'DONOR' }, on: true } });
    check(levelPf.sky?.kind === 'level', 'a donor level sky reports verbatim (no bytes to price)');
  }

  // ---- rename / duplicate / delete (docs/005, docs/033) ----
  {
    const a = await saveCustomTexture('zz-test-manage', fixture(32, 32, [11, 22, 33, 255]));
    written.push(a);
    check(await customTextureExists(a) && await customTextureExists('zz-test-manage'),
      'customTextureExists finds a stored tile with or without the .png');

    // duplicate: both survive, and the copy carries the same pixels
    const copy = await cloneCustomTexture(a, 'zz-test-manage-copy');
    written.push(copy);
    check(copy === 'zz-test-manage-copy.png' && await customTextureExists(a) && await customTextureExists(copy),
      'clone leaves the original in place and adds the copy');
    check(decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, copy)).data[1] === 22, 'the copy carries the art');

    // an occupied target steps aside rather than landing on the tile someone is already wearing — the same
    // rule an upload plays by, so no path into the library can take a name that is spoken for (docs/038)
    const copy2 = await cloneCustomTexture(a, 'zz-test-manage-copy');
    written.push(copy2);
    check(copy2 === 'zz-test-manage-copy_2.png', `clone onto a taken name suffixes instead of overwriting (${copy2})`);
    check(decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, copy)).data[1] === 22,
      'the tile the clone would have landed on is untouched');
    const b = await saveCustomTexture('zz-test-manage-moved', fixture(32, 32, [44, 55, 66, 255]));
    const moved = await renameCustomTexture(b, 'zz-test-manage-copy');
    written.push(moved);
    check(moved === 'zz-test-manage-copy_3.png', `rename onto a taken name suffixes too (${moved})`);
    check(!await customTextureExists(b), 'the renamed tile left its old name');
    check(decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, copy)).data[1] === 22,
      'and the tile it was renamed onto is still its own art');
    check(await deleteCustomTexture(moved) && await deleteCustomTexture(copy2), 'the suffixed tiles clean up');

    // rename: the file moves, the old name stops resolving
    const renamed = await renameCustomTexture(a, 'zz test RENAMED!');
    written.push(renamed);
    check(renamed === 'zztestRENAMED.png', `rename sanitises to the asset alphabet (${renamed})`);
    check(await customTextureExists(renamed) && !await customTextureExists(a), 'rename moves the file off the old name');
    check(decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, renamed)).data[2] === 33, 'renamed art is unchanged');
    check(await renameCustomTexture(renamed, 'zztestRENAMED') === 'zztestRENAMED.png',
      'renaming a tile to its own name is a no-op, not a collision');

    // a name that sanitises away is refused rather than silently becoming "texture"
    let refused = '';
    try { await renameCustomTexture(renamed, '!!!'); } catch (e) { refused = String(e); }
    check(/no usable characters/.test(refused), 'rename refuses a name with nothing left after sanitising');

    // delete: gone, and a second delete is not an error
    check(await deleteCustomTexture(copy) && !await customTextureExists(copy), 'delete removes the tile');
    check(await deleteCustomTexture(copy) === false, 'deleting an already-absent tile reports false, not an error');
    check(await deleteCustomTexture(renamed) && !await customTextureExists(renamed), 'delete removes the renamed tile');
    check(!(await deriveLevelTextures(CUSTOM_TEX_LEVEL)).tiles.some(t => t.name.startsWith('zz-test-manage')),
      'deleted tiles leave the Custom listing');

    // Every operation is confined to the mountain's own textures folder, whatever the caller passes. The
    // sentinel is planted where the traversal would land — `<assets>/textures/../../ELYSIUM/Textures/0000.png`
    // — so surviving is a real statement about the sandbox rather than about which levels this machine has
    // extracted. (This previously asserted a retail ELYSIUM page was still there, which only held on a
    // machine that had one, and asserted nothing at all on a machine that did not.)
    const outside = join(assetRoot, '..', 'ELYSIUM', 'Textures');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, '0000.png'), fixture(2, 2, [1, 2, 3, 255]));
    let escaped = '';
    try { await deleteCustomTexture('../../ELYSIUM/Textures/0000'); } catch (e) { escaped = String(e); }
    check(existsSync(join(outside, '0000.png')),
      'a traversal-shaped name cannot reach outside the mountain assets/textures folder');
    check(!escaped, 'and it is confined quietly rather than by throwing at the caller');
  }

  // ---- a deleted name is retired, never reissued (docs/038) ----
  // Without this, deleting `snow` and uploading a different `snow` puts new art on the URL the old one owned,
  // and every warm cache — plus every checkpoint and painted cell recorded against that ref — quietly follows.
  {
    const first = await saveCustomTexture('zz-test-retire', fixture(8, 8, [70, 0, 0, 255]));
    written.push(first);
    check(first === 'zz-test-retire.png', `a free name is taken as-is (${first})`);
    check(await deleteCustomTexture(first), 'the tile is deleted');
    const reused = await saveCustomTexture('zz-test-retire', fixture(8, 8, [0, 70, 0, 255]));
    written.push(reused);
    check(reused === 'zz-test-retire_2.png',
      `re-uploading a deleted name lands as _2, exactly as if the original were still there (${reused})`);
    check(!await customTextureExists('zz-test-retire'),
      'the deleted name stays vacant — nothing new answers the URL it owned');
    check(decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, reused)).data[1] === 70,
      'the re-upload keeps its own art under its own name');

    // a rename frees its source name the same way a delete does, so it retires the same way
    const source = await saveCustomTexture('zz-test-retire-move', fixture(8, 8, [0, 0, 71, 255]));
    written.push(source);
    const moved = await renameCustomTexture(source, 'zz-test-retire-moved');
    written.push(moved);
    check(moved === 'zz-test-retire-moved.png', `rename moves the tile onto its new name (${moved})`);
    const afterRename = await saveCustomTexture('zz-test-retire-move', fixture(8, 8, [72, 72, 0, 255]));
    written.push(afterRename);
    check(afterRename === 'zz-test-retire-move_2.png',
      `the name a rename moved off is retired too (${afterRename})`);

    // a delete and an upload of one name arriving together: the removal and the retirement are one locked
    // step, so the upload either finds the file or finds the name retired — there is no gap to slip into
    const contested = await saveCustomTexture('zz-test-retire-race', fixture(8, 8, [0, 73, 73, 255]));
    written.push(contested);
    const [deleted, raced] = await Promise.all([
      deleteCustomTexture('zz-test-retire-race'),
      saveCustomTexture('zz-test-retire-race', fixture(8, 8, [74, 0, 74, 255])),
    ]);
    written.push(raced);
    check(contested === 'zz-test-retire-race.png' && deleted, 'the contested tile existed and was deleted');
    check(raced === 'zz-test-retire-race_2.png',
      `a delete racing an upload of one name cannot both take it (${raced})`);
    check(!await customTextureExists('zz-test-retire-race') && await customTextureExists(raced),
      'the deleted name is gone and the upload kept the name it was told it got');
  }

  // ---- Replace: the deliberate iterate-on-one-tile loop (docs/038) ----
  // The escape hatch from "names never overwrite". It is an upload plus a repoint, exactly as
  // /api/texture-replace composes it: the new art lands under its own free name, every user of the old ref
  // is moved onto it, the old file goes. The author's tile shows the new art; no URL ever answers with
  // different bytes than it did before, so nothing has a cache to bust.
  {
    const tile = await saveCustomTexture('zz-test-replace', fixture(32, 32, [90, 0, 0, 255]));
    written.push(tile);
    const oldRef = `${CUSTOM_TEX_LEVEL}/${tile}`;
    const wearer = await saveImportedProp('zz-test-replace-wearer', {
      name: 'zz test replace wearer', tris: 1,
      subs: [{ mat: 0, pos: '', uv: '', idx: '' }],
      materials: [{ id: 0, tex: oldRef }],
    });
    propsWritten.push(wearer.file);

    // what it will affect, before it does it — the count the confirmation shows, which the editor cannot
    // work out for itself because imported records live on disk outside the document
    check(await countImportedTextureUsers(oldRef) === 1,
      'replace can say what it affects: the imported prop wearing the tile is counted first');

    const { from, to } = await replaceCustomTexture(tile, fixture(16, 16, [0, 0, 190, 255]));
    written.push(to);
    const repointed = await retargetImportedTexture(oldRef, `${CUSTOM_TEX_LEVEL}/${to}`);
    await deleteCustomTexture(from);
    check(from === tile && to !== tile, `replace names both ends of the move (${from} -> ${to})`);
    const art = decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, to));
    check(art.w === 16 && art.data[2] === 190, 'the tile the author is holding now carries the new art');
    check(!await customTextureExists(from), 'the replaced file is gone rather than left as a duplicate');
    check(repointed === 1 && await countImportedTextureUsers(`${CUSTOM_TEX_LEVEL}/${to}`) === 1
      && await countImportedTextureUsers(oldRef) === 0,
      'everything that wore the old ref wears the new one — that is what "replace" means to the author');

    // the cleanup is an ordinary delete, so the name it removed is retired: the old ref is a dead address,
    // not a vacancy the next upload of that name moves into behind everyone still holding it
    const afterReplace = await saveCustomTexture('zz-test-replace', fixture(4, 4, [0, 0, 60, 255]));
    written.push(afterReplace);
    check(afterReplace === 'zz-test-replace_3.png',
      `replace retires the name it cleaned up (${afterReplace}, not ${from})`);
    check(decodePng(await readTextureBytes(CUSTOM_TEX_LEVEL, to)).data[2] === 190,
      'and the replaced tile still carries the art the author replaced it with');

    // Replacing a tile that is ITSELF a `_2` walks the counter on rather than compounding the suffix. The
    // name still has to change — new bytes need a new ref — but `_2`, `_2_2`, `_2_2_2` is a name growing
    // without a bound, and iterating on one tile is exactly what replace is for. The Blender bridge takes
    // this path on every texture push (docs/046), so it is the loop that would have gone furthest.
    const again = await replaceCustomTexture(to, fixture(8, 8, [0, 130, 0, 255]));
    written.push(again.to);
    await deleteCustomTexture(again.from);
    check(again.to === 'zz-test-replace_4.png',
      `replacing again steps past the names in use (${again.to}, not ${to.replace(/\.png$/, '')}_2.png)`);

    let missing = '';
    try { await replaceCustomTexture('zz-test-replace-absent', fixture(4, 4, [0, 0, 0, 255])); }
    catch (e) { missing = String(e); }
    check(/no custom texture/.test(missing), 'replace refuses a tile that is not there rather than creating one');
  }

  // ---- generated tile names come from the prompt and dodge what is already stored ----
  {
    const none = new Set<string>();
    check(suggestTextureName('Seamless tileable texture of packed snow with faint ski tracks.\n\nSeamless repeating pattern, top-down…', none)
      === 'packed-snow-with-faint',
      'the suggestion reads the subject, not the fixed tiling boilerplate');
    check(suggestTextureName('Seamless tileable texture of grey granite rock face.', new Set(['grey-granite-rock-face']))
      === 'grey-granite-rock-face-2', 'a taken name is numbered rather than reused');
    check(suggestTextureName('texture of ice', new Set(['ice', 'ice-2', 'ice-3'])) === 'ice-4',
      'numbering keeps walking until it finds a free name');
    check(suggestTextureName('!!! ???', none) === 'texture', 'a prompt with no usable words still yields a name');
  }

  // ---- Generate texture: the wrap blend must actually make a tile wrap (docs/033) ----
  {
    // A left-to-right luminance ramp is the worst case: its edges are maximally far apart, so a blend that
    // only *looks* softer without wrapping would show up immediately.
    const size = 64;
    const ramp = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4, v = Math.round((x / (size - 1)) * 255);
        ramp[i] = v; ramp[i + 1] = v; ramp[i + 2] = 255 - v; ramp[i + 3] = 255;
      }
    }
    const before = { w: size, h: size, data: ramp };
    const after = makeSeamless(before);
    const errBefore = seamError(before), errAfter = seamError(after);
    check(errBefore > 50, `a raw ramp seams badly (${errBefore.toFixed(1)})`);
    // the residual is one gradient step (the two columns that meet are neighbours in the source, not the
    // same pixel), so this asserts continuity rather than an implausible exact zero
    check(errAfter < 4, `makeSeamless wraps the ramp's edges (${errBefore.toFixed(1)} -> ${errAfter.toFixed(2)})`);
    check(errAfter < errBefore / 20, 'the blend cuts the seam by more than an order of magnitude');
    check(after.data !== before.data && before.data[0] === 0, 'makeSeamless does not mutate its input');

    // the central band is left alone — that is what separates this from whole-image ghosting
    const mid = ((size / 2) * size + size / 2) * 4;
    check(after.data[mid] === before.data[mid], 'the tile centre survives the blend untouched');

    // a flat image has nothing to fix and must come back unchanged, not merely close
    const flat = { w: size, h: size, data: new Uint8Array(size * size * 4).fill(200) };
    check(seamError(makeSeamless(flat)) === 0, 'a flat image stays flat through the blend');

    // too small to band: returned as-is rather than averaged to mud
    const tiny = { w: 4, h: 4, data: new Uint8Array(4 * 4 * 4).fill(9) };
    check(makeSeamless(tiny) === tiny, 'images below the band size pass through untouched');
  }

  // ---- Generate texture: the model catalogue the dialog prices and the proxy allows ----
  {
    check(FAL_MODELS.length > 0 && FAL_MODELS.some(m => m.id === DEFAULT_FAL_MODEL),
      'the default fal model is in the catalogue');
    check(FAL_MODELS.every(m => m.usdPerMegapixel > 0), 'every offered model carries a per-megapixel price');
    // the dialog's whole "low res is cheaper" claim rests on this being exactly proportional to area
    const at512 = estimateUsd(DEFAULT_FAL_MODEL, 512)!, at1024 = estimateUsd(DEFAULT_FAL_MODEL, 1024)!;
    check(Math.abs(at1024 / at512 - 4) < 1e-9, 'a 1024² run is priced at exactly 4× a 512² one');
    check(estimateUsd('not-a-model', 512) === null, 'an unknown model has no price rather than a wrong one');
    // 128 is the dominant terrain-tile size across the shipped levels, so generated art can be stored at
    // the same density the maps are painted in. A generator invariant — what a disc can upload is
    // `snowknife`'s business, not the store's.
    check(STORE_SIZES.includes(128), 'the native terrain tile size is offered as a store size');
    check(GEN_SIZES.every(s => s >= 512), 'generation sizes stay at or above the 512 diffusion floor');

    // the inpainting catalogue (Transition / Decal tabs) plays by the same rules
    check(FAL_INPAINT_MODELS.length > 0 && FAL_INPAINT_MODELS.some(m => m.id === DEFAULT_FAL_INPAINT_MODEL),
      'the default inpainting model is in the catalogue');
    check(FAL_INPAINT_MODELS.every(m => m.usdPerMegapixel > 0), 'every inpainting model carries a per-megapixel price');
    check(FAL_INPAINT_MODELS.every(m => m.maskParam === 'mask_url' || m.maskParam === 'mask_image_url'),
      'every inpainting model names which body field its mask travels in');
    const ip512 = estimateInpaintUsd(DEFAULT_FAL_INPAINT_MODEL, 512)!, ip1024 = estimateInpaintUsd(DEFAULT_FAL_INPAINT_MODEL, 1024)!;
    check(Math.abs(ip1024 / ip512 - 4) < 1e-9, 'an inpaint at 1024² is priced at exactly 4× a 512² one');
    check(estimateInpaintUsd('not-a-model', 512) === null, 'an unknown inpainting model has no price rather than a wrong one');
    // the two catalogues must not overlap: the proxies use them as their allow-lists, and a shared id would
    // let a text-to-image body reach an inpainting endpoint (or the reverse) under the user's key
    check(!FAL_MODELS.some(m => FAL_INPAINT_MODELS.some(i => i.id === m.id)),
      'the text-to-image and inpainting allow-lists are disjoint');
    // the skybox dialog's panorama pass: one fixed endpoint at one flat price, so the estimate stays exact
    check(FAL_PANORAMA_MODEL.length > 0 && FAL_PANORAMA_USD > 0,
      'the panorama pass names its endpoint and carries its flat price');

    // the Generate prop dialog's image-to-3D catalogue (docs/032): flat per-run prices, schema facts
    // recorded per model, and an allow-list of its own that must not overlap the image catalogues
    check(FAL_3D_MODELS.length > 0 && FAL_3D_MODELS.some(m => m.id === DEFAULT_FAL_3D_MODEL),
      'the default 3D model is in the catalogue');
    check(FAL_3D_MODELS.every(m => m.usdPerRun > 0), 'every 3D model carries a flat per-run price');
    check(FAL_3D_MODELS.every(m => m.imageParam === 'image_url' || m.imageParam === 'input_image_urls'),
      'every 3D model names which body field its image travels in');
    check(fal3dModel('not-a-model') === undefined, 'an unknown 3D model resolves to nothing rather than something');
    check(!FAL_3D_MODELS.some(m => FAL_MODELS.some(i => i.id === m.id) || FAL_INPAINT_MODELS.some(i => i.id === m.id)),
      'the 3D allow-list is disjoint from both image allow-lists');

    // Item 22: every endpoint the UI/proxy can bill has a model-specific, currently reviewed commercial
    // status. The provider's generic terms are additional references, never a substitute for this row.
    const offered = [
      ...FAL_MODELS.map(m => m.id), ...FAL_INPAINT_MODELS.map(m => m.id),
      FAL_PANORAMA_MODEL, ...FAL_3D_MODELS.map(m => m.id),
    ];
    check(offered.length === 8 && new Set(offered).size === offered.length,
      'the eight enabled fal endpoints each have one catalogue identity');
    check(offered.every(id => falEndpoint(id)?.terms.status === 'commercial-use'
      && falEndpoint(id)?.terms.modelPage === `https://fal.ai/models/${id}`
      && falEndpoint(id)?.terms.licenseUrl.startsWith('https://fal.ai/models/')
      && !!falEndpoint(id)?.terms.reviewedAt),
    'every enabled endpoint links its exact fal model licence/status page and review date');
    check(offered.every(falEndpointMayGenerate) && !falEndpointMayGenerate('fal-ai/not-reviewed'),
      'only reviewed commercial-use endpoints pass the shared generation gate');
    const provenance = createFalGenerationProvenance(
      [DEFAULT_FAL_MODEL, DEFAULT_FAL_MODEL, FAL_PANORAMA_MODEL], generatedAt);
    check(provenance.models.length === 2 && provenance.generatedAt === generatedAt,
      'provenance snapshots exact generation time and de-duplicates repeated model calls');
    check(Object.values(provenance.providerTerms).includes(FAL_PROVIDER_TERMS.acceptableUsePolicy)
      && !JSON.stringify(provenance).toLowerCase().includes('api key')
      && !JSON.stringify(provenance).toLowerCase().includes('prompt'),
    'provenance archives provider legal references without prompts or credentials');
    const tampered = { ...provenance, models: [{ ...provenance.models[0], id: 'fal-ai/not-reviewed' }] };
    check(parseFalGenerationProvenance(provenance)?.models.length === 2
      && parseFalGenerationProvenance(tampered) === undefined,
    'upload provenance is canonicalised and an unknown model is refused');

    // Rodin's detail menu: quality tiers plus the Sketch tier, resolved through one helper the client's
    // stored pref and the dialog both use (the proxy itself REJECTS unknown details rather than defaulting)
    const rodin = FAL_3D_MODELS.find(m => m.id === 'fal-ai/hyper3d/rodin')!;
    check(['low', 'extra-low', 'sketch'].every(id => rodin.details!.some(d => d.id === id)),
      'Rodin offers the low / extra-low / sketch detail levels');
    check(fal3dDetail(rodin.id)?.id === rodin.details![0].id, 'no stored detail resolves to the model default');
    check(fal3dDetail(rodin.id, 'nope')?.id === rodin.details![0].id, 'an unknown stored detail falls back to the default');
    check(fal3dDetail(rodin.id, 'sketch')?.body.tier === 'Sketch', 'the sketch level selects Rodin’s Sketch tier');
    check(fal3dDetail(rodin.id, 'extra-low')?.body.quality === 'extra-low', 'the extra-low level selects that quality');
    check(fal3dDetail('fal-ai/trellis') === null, 'a model with one detail level offers no menu');

    // the generated-model rescale: uniform, longest-side anchored, and inert on degenerate input
    const draft = {
      size: [2, 4, 1] as [number, number, number],
      subs: [{ positions: new Float32Array([100, -200, 50, 0, 400, -100]) }],
    };
    scaleDraftTo(draft, 8);
    check(Math.abs(draft.size[1] - 8) < 1e-9 && Math.abs(draft.size[0] - 4) < 1e-9 && Math.abs(draft.size[2] - 2) < 1e-9,
      'scaleDraftTo anchors the longest side and scales the rest uniformly');
    check(draft.subs[0].positions[0] === 200 && draft.subs[0].positions[4] === 800,
      'scaleDraftTo rescales the packed vertex positions by the same factor');
    const flat0 = { size: [0, 0, 0] as [number, number, number], subs: [{ positions: new Float32Array([1, 2, 3]) }] };
    scaleDraftTo(flat0, 5);
    check(flat0.subs[0].positions[0] === 1, 'a degenerate (zero-extent) draft passes through unscaled');
  }
} finally {
  if (retiredBefore) writeFileSync(retiredFile, retiredBefore);
  else rmSync(retiredFile, { force: true });
  if (propIdBefore) writeFileSync(propIdFile, propIdBefore);
  else rmSync(propIdFile, { force: true });
  for (const f of new Set(written)) rmSync(join(customDir, f), { force: true });
  for (const f of new Set(propsWritten)) rmSync(join(importedDir, f), { force: true });
  // drop the folders only if this run created them and left nothing of the user's behind
  if (!hadImportedDirBefore && existsSync(importedDir) && readdirSync(importedDir).length === 0)
    rmSync(importedDir, { recursive: true, force: true });
  if (!hadDirBefore && existsSync(customDir) && readdirSync(customDir).length === 0)
    rmSync(customDir, { recursive: true, force: true });
  rmSync(assetRoot, { recursive: true, force: true });
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('custom-textures: all checks passed');
