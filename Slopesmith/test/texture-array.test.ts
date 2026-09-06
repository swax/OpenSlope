// tier: fast

/**
 * The WebGL2 array-texture bank — the port of the Unity path's Texture2DArray collapse, and the thing that
 * takes a draw call below "one per texture page". What has to hold: the plan puts pages on layers in the
 * order it was given them (which is what lets a cell's draw ranges merge), it sizes itself to the art rather
 * than to its largest outlier, the per-vertex slice really names each patch's own tile, and the shader
 * rewrites still bite the three.js source strings they anchor on.
 *
 * The packing itself (canvas -> DataArrayTexture) is deliberately not covered here: it needs a browser, and
 * everything that decides WHAT gets packed is in the pure half this exercises.
 */
import * as THREE from 'three';
import {
  materialTextureArray, planTextureArrayBank, textureArrayFragmentShader, textureArrayShaderApplies,
  textureArrayStandIn, textureArrayVertexShader, useTextureArray, TEXTURE_ARRAY_MAX_LAYERS,
} from '../src/app/viewport/mesh/texture-array';
import {
  buildPatchSliceAttribute, buildReferenceBatchLayout, mergeReferenceBatchGroups,
} from '../src/app/viewport/mesh/reference-batching';
import { isAnimatedPropMaterial, PropTextureCache } from '../src/app/props/textures';
import { applyPropShade, PROP_SHADE_TINT } from '../src/app/viewport/scene/prop-shade';
import { MergedStaticPropMesh } from '../src/app/viewport/scene/reference-prop-mesh';
import {
  analyzeTexturePixels, applyTextureAlphaMode, resolvePropAlphaMode, setCutoutAlphaToCoverage,
} from '../src/app/props/texture-alpha';
import { check, failures } from './check';

// ---- alpha classification must drive render state, not just the inspector label ----
const cutoutPixels = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 0]);
const translucentPixels = new Uint8Array([255, 255, 255, 128, 255, 255, 255, 128]);
const glowPixels = new Uint8Array(16 * 4);
for (let i = 0; i < 16; i++) {
  glowPixels[i * 4] = glowPixels[i * 4 + 1] = glowPixels[i * 4 + 2] = 255;
  glowPixels[i * 4 + 3] = i * 17;
}
const cutoutAnalysis = analyzeTexturePixels(cutoutPixels, 2, 1);
const translucentAnalysis = analyzeTexturePixels(translucentPixels, 2, 1);
const glowAnalysis = analyzeTexturePixels(glowPixels, 16, 1);
check(cutoutAnalysis.kind === 'cutout' && !cutoutAnalysis.glow
  && translucentAnalysis.kind === 'translucent' && glowAnalysis.kind === 'cutout' && glowAnalysis.glow,
  'the shared histogram separates holes, smooth translucency, and soft glow art like Snowknife');
check(resolvePropAlphaMode([cutoutAnalysis], { alphaPass: true }) === 'cutout'
  && resolvePropAlphaMode([translucentAnalysis], { alphaPass: true }) === 'blend'
  && resolvePropAlphaMode([glowAnalysis], { alphaPass: true }) === 'glow',
  'an alpha-pass flag is refined by its PNG instead of forcing every surface through transparent blending');
check(resolvePropAlphaMode([translucentAnalysis, cutoutAnalysis], { alphaPass: true }) === 'cutout'
  && resolvePropAlphaMode([translucentAnalysis], { pixelAlpha: true }) === 'blend'
  && resolvePropAlphaMode([translucentAnalysis], { priority: true }) === 'blend',
  'a cutout flipbook frame wins, while conventional partial alpha remains a real blend');
check(resolvePropAlphaMode([translucentAnalysis], { mode: 'cutout' }) === 'cutout'
  && resolvePropAlphaMode([cutoutAnalysis], { mode: 'opaque', alphaPass: true }) === 'opaque',
  'an explicit author/sidecar alpha mode wins over both pixel analysis and native flags');

const cutoutMaterial = new THREE.MeshLambertMaterial({ transparent: true, depthWrite: false });
applyTextureAlphaMode(cutoutMaterial, 'cutout', true);
check(!cutoutMaterial.transparent && cutoutMaterial.depthWrite && cutoutMaterial.alphaTest === 0.05,
  'a cutout sheet is an opaque-pass depth writer whose true holes are discarded');
check(cutoutMaterial.alphaHash && !cutoutMaterial.alphaToCoverage,
  'a cutout softens partial-alpha edges with single-sample coverage without restoring global MSAA');
setCutoutAlphaToCoverage(true);
const smoothCutoutMaterial = new THREE.MeshLambertMaterial();
applyTextureAlphaMode(smoothCutoutMaterial, 'cutout', true);
check(!smoothCutoutMaterial.transparent && smoothCutoutMaterial.depthWrite
  && smoothCutoutMaterial.alphaTest === 0 && !smoothCutoutMaterial.alphaHash
  && smoothCutoutMaterial.alphaToCoverage,
  'the enabled smooth path preserves continuous alpha for depth-writing MSAA sample coverage');
setCutoutAlphaToCoverage(false); // the remainder exercises the default fast path
const blendSheetMaterial = new THREE.MeshLambertMaterial();
applyTextureAlphaMode(blendSheetMaterial, 'blend', true);
check(blendSheetMaterial.transparent && !blendSheetMaterial.depthWrite && blendSheetMaterial.alphaTest === 0,
  'only a genuinely blended sheet keeps the stacked-water no-depth-write exception');
check(!blendSheetMaterial.alphaHash,
  'a true blend keeps continuous alpha rather than passing it through cutout coverage');

const renderCache = new PropTextureCache() as any;
renderCache.loader = { load: () => new THREE.Texture() };
renderCache.alphaAnalyses.set('TEST/cutout.png', cutoutAnalysis);
const classifiedMaterial = renderCache.material('TEST', 'cutout.png', undefined, [], undefined,
  { blend: true, sheet: true });
check(!classifiedMaterial.transparent && classifiedMaterial.depthWrite && classifiedMaterial.alphaTest === 0.05
  && classifiedMaterial.alphaHash,
  'PropTextureCache applies the cutout verdict to the real material even when native bit 18 is set');

// ---- sizing: GARI's own page census (118 at 128x128, 17 at 64x64, 2 at 32x32, one 256x128) ----
const gari = [
  ...Array.from({ length: 118 }, (_, i) => ({ key: `p${i}`, width: 128, height: 128 })),
  ...Array.from({ length: 17 }, (_, i) => ({ key: `q${i}`, width: 64, height: 64 })),
  { key: 'r0', width: 32, height: 32 },
  { key: 'r1', width: 32, height: 32 },
  { key: 'wide', width: 256, height: 128 },
];
const plan = planTextureArrayBank(gari);
check(plan.width === 128 && plan.height === 128,
  'the bank sizes to the MODAL page, not to its one oversized outlier');
check(plan.slots.size === 137 && plan.excluded.length === 1 && plan.excluded[0] === 'wide',
  'every page that fits joins the bank; the one larger page keeps its own material rather than being blurred');
check([...plan.slots.keys()].every(key => key !== 'wide'),
  'and is genuinely absent from the slot table, not merely listed as excluded');

// Order is load-bearing: chunk draw ranges are emitted in texture-slot order, so slices must be handed out in
// that same order or a cell's ranges interleave between arrays and stop merging.
const assigned = [...plan.slots.entries()].sort((a, b) =>
  (a[1].array - b[1].array) || (a[1].slice - b[1].slice)).map(([key]) => key);
const offered = gari.map(page => page.key).filter(key => key !== 'wide');
check(assigned.length === offered.length && assigned.every((key, i) => key === offered[i]),
  'pages take layers in the order they were offered, so slot order and array order agree');

check(plan.arrays.length === Math.ceil(137 / TEXTURE_ARRAY_MAX_LAYERS)
  && plan.arrays.every(array => array.length <= TEXTURE_ARRAY_MAX_LAYERS),
  `${plan.arrays.length} array(s), none over the ${TEXTURE_ARRAY_MAX_LAYERS}-layer cap`);

const missing = planTextureArrayBank([
  { key: 'a', width: 64, height: 64 }, { key: 'gone', width: 0, height: 0 }, { key: 'b', width: 64, height: 64 },
]);
check(missing.slots.size === 2 && missing.excluded.length === 1 && missing.slots.get('b')?.slice === 1,
  'a page that never loaded is excluded and does not leave a hole in the layer numbering');

const npot = planTextureArrayBank([{ key: 'a', width: 96, height: 48 }, { key: 'b', width: 96, height: 48 }]);
check(npot.width === 128 && npot.height === 64 && npot.slots.size === 2,
  'a non-power-of-two page set rounds UP to one, so the mip level count stays integral');

const budget = planTextureArrayBank(
  Array.from({ length: 64 }, (_, i) => ({ key: `b${i}`, width: 256, height: 256 })),
  { maxBytes: 4 * 1024 * 1024 },
);
check(budget.width < 256 && budget.slots.size === 64 && 64 * budget.width * budget.height * 4 <= 4 * 1024 * 1024,
  'an oversized page set halves its way under the memory budget rather than dropping pages');

check(planTextureArrayBank([]).arrays.length === 0
  && planTextureArrayBank([{ key: 'a', width: 0, height: 0 }]).slots.size === 0,
  'nothing to pack plans an empty bank, and every page stays on its own material');

// ---- the merge: a cell of mixed tiles becomes ONE draw once they share an array ----
const GRID = 4, SPACING = 100, QUAD = 90, FACES = 2;
const patchCount = GRID * GRID;
const positions = new Float32Array(patchCount * 4 * 3);
const indices = new Uint32Array(patchCount * FACES * 3);
const patchTex: (string | null)[] = [];
for (let gz = 0; gz < GRID; gz++) for (let gx = 0; gx < GRID; gx++) {
  const patch = gz * GRID + gx;
  const x = gx * SPACING, z = gz * SPACING, v = patch * 4;
  positions.set([x, 0, z, x + QUAD, 0, z, x + QUAD, 0, z + QUAD, x, 0, z + QUAD], v * 3);
  indices.set([v, v + 1, v + 2, v, v + 2, v + 3], patch * FACES * 3);
  // Four tiles, arranged so each 2x2 cell below holds ALL of them — the worst case a cell can present, and
  // the only shape that can show a merge surviving an interruption in the middle of a run.
  patchTex.push(`tile-${(gx % 2) * 2 + (gz % 2)}.png`);
}
const layout = buildReferenceBatchLayout(indices, positions, patchTex, FACES, 'ARRAY', 200);
check(layout.chunks.length > 1 && layout.chunks.every(chunk => chunk.groups.length === 4),
  'the fixture really does put all four tiles — four separate draws — in every cell');

const banked = layout.chunks.map(chunk => mergeReferenceBatchGroups(chunk.groups, () => 7));
check(banked.every(groups => groups.length === 1 && groups[0].materialIndex === 7),
  'with every tile in one array, a cell submits exactly ONE draw however many tiles it holds');
check(banked.every((groups, i) => {
  const source = layout.chunks[i].groups;
  return groups[0].start === source[0].start
    && groups[0].count === source.reduce((sum, group) => sum + group.count, 0);
}), 'and that one draw covers exactly the triangles its per-tile ranges covered');

// A page left out of the bank interrupts the run without costing the rest of the cell its merge.
const split = layout.chunks.map(chunk => mergeReferenceBatchGroups(chunk.groups, slot => slot === 2 ? 2 : 7));
check(split.every((groups, i) => groups.length <= layout.chunks[i].groups.length
  && groups.reduce((sum, group) => sum + group.count, 0)
    === layout.chunks[i].groups.reduce((sum, group) => sum + group.count, 0)),
  'an excluded page splits its cell run without dropping or duplicating any triangle');
check(split.some((groups, i) => groups.length < layout.chunks[i].groups.length),
  'and the ranges on either side of it still merge');

check(mergeReferenceBatchGroups(
  [{ start: 0, count: 3, materialIndex: 1 }, { start: 9, count: 3, materialIndex: 1 }], () => 5)
  .length === 2, 'ranges that are NOT adjacent in the index are never welded together');

// ---- the per-vertex slice names each patch's own tile ----
const slices = buildPatchSliceAttribute(indices, layout.patchSlots, FACES, positions.length / 3,
  slot => slot); // identity: slot n -> layer n, enough to tell the patches apart
const sliceOfPatch = (patch: number) => slices[indices[patch * FACES * 3]];
check(Array.from({ length: patchCount }, (_, patch) => patch).every(patch => {
  const expected = layout.patchSlots[patch];
  for (let i = patch * FACES * 3; i < (patch + 1) * FACES * 3; i++) if (slices[indices[i]] !== expected) return false;
  return true;
}), 'every vertex of a patch carries that patch\'s own layer, and all four corners agree');
check(new Set(Array.from({ length: patchCount }, (_, patch) => sliceOfPatch(patch))).size === 4,
  'the four distinct tiles land on four distinct layers');

const untextured = buildPatchSliceAttribute(
  indices, new Uint32Array(patchCount), FACES, positions.length / 3, () => 0);
check(untextured.every(slice => slice === 0),
  'an untextured quilt writes no slice at all — those triangles never sample the array');

// ---- a material rebuilt from an array material must still sample the array ----
// Both rebuilds below drop `onBeforeCompile` on the floor by construction (one re-runs `lit`, the other
// builds a fresh material from a source's fields), and the failure is silent: the draw keeps rendering, it
// just samples the 1x1 stand-in and a whole batch comes out flat white.
const array = new THREE.DataArrayTexture(new Uint8Array(4 * 4), 2, 2, 1);
const source = useTextureArray(new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, alphaTest: 0.4 }),
  array, 'test');
check(materialTextureArray(source) === array && source.map === textureArrayStandIn(),
  'an array material binds the bank and keeps the 1x1 stand-in as its map');

const cache = new PropTextureCache();
const variant = cache.variant(source);
check(variant !== source && materialTextureArray(variant) === array,
  'a material VARIANT keeps the bank — `lit` reassigns onBeforeCompile, so this has to be reinstalled');

const clayHost = new THREE.Mesh(new THREE.BufferGeometry(), source);
clayHost.userData[PROP_SHADE_TINT] = 0x4a85ed;
applyPropShade(clayHost, 'surface');
check(clayHost.material !== source && materialTextureArray(clayHost.material as THREE.Material) === array,
  'the Surface view\'s clay stand-in samples the bank too, or every cutout would fill in as a rectangle');
applyPropShade(clayHost, 'textured');
check(clayHost.material === source, 'and leaving Surface restores the original array material');

// ---- the merged fallback (no WEBGL_multi_draw) has to carry the slice through the merge ----
const submesh = new THREE.BufferGeometry();
submesh.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
submesh.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1]), 2));
submesh.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
submesh.setAttribute('texArraySlice', new THREE.BufferAttribute(new Uint16Array([9, 9, 9]), 1));
submesh.setIndex(new THREE.BufferAttribute(new Uint32Array([0, 1, 2]), 1));
const merged = new MergedStaticPropMesh(6, 6, source);
const geometryId = merged.addGeometry(submesh);
merged.addInstance(geometryId);
merged.addInstance(geometryId);
const mergedSlices = merged.geometry.getAttribute('texArraySlice');
check(!!mergedSlices && Array.from({ length: 6 }, (_, i) => mergedSlices.getX(i)).every(slice => slice === 9),
  'a physically merged batch carries each submesh\'s layer across, for both of its copies');

const plainSubmesh = submesh.clone();
plainSubmesh.deleteAttribute('texArraySlice');
const plainMerged = new MergedStaticPropMesh(3, 3, source);
plainMerged.addInstance(plainMerged.addGeometry(plainSubmesh));
check(plainMerged.geometry.getAttribute('texArraySlice')?.getX(0) === 0,
  'and a batch on an ordinary per-page material merges fine with no slice to carry');

// ---- the animated-material reading the bank branches on ----
check(!isAnimatedPropMaterial(null, []) && !isAnimatedPropMaterial({} as never, ['a.png', 'b.png'])
  && isAnimatedPropMaterial({ uvScroll: {} } as never, [])
  && isAnimatedPropMaterial({ textureFlip: {} } as never, ['a.png', 'b.png'])
  && !isAnimatedPropMaterial({ textureFlip: {} } as never, ['a.png']),
  'a scroller and a multi-frame flipbook stay out of the bank; a one-frame "flipbook" is not one');

// ---- the shader rewrites still find their three.js anchors ----
check(textureArrayShaderApplies(),
  'the vertex and fragment rewrites both still bite (a three upgrade renaming an anchor fails here)');
check(textureArrayVertexShader('#include <begin_vertex>\nvoid main() {}')
  .includes('vTexArraySlice = texArraySlice;'),
  'the slice is carried across from a real begin_vertex anchor');
check(!textureArrayFragmentShader('#include <map_fragment>\nvoid main() {}').includes('texture2D( map,'),
  'and the rewritten fragment no longer samples the 1x1 stand-in the material binds as its map');

if (failures) process.exitCode = 1;
else console.log('TEXTURE ARRAY TESTS PASSED');
