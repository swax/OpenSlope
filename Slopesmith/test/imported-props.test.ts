/**
 * Imported GLB prop checks (docs/032): a stored record round-trips into the SAME LevelProps an extracted
 * level decodes to, importing a file name that is taken stores beside it with its own model number so
 * placements never repoint under the author, material ids rebase so one import can never renumber another's,
 * a "Custom/<name>.png" ref resolves to the shared texture bank, and — because imported props do not bake
 * yet — an imported placement is excluded from the export and preflight loudly rather than silently.
 * Run: tsx test/imported-props.test.ts
 *
 * Writes real files under an isolated mountain assets/props folder and removes them afterwards; the Props folder
 * itself is kept only if it existed before the run or holds the user's own models.
 */
import * as THREE from 'three';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultMountain, migrateMountain } from '../src/core/doc/mountain';
import { DEFAULT_SUN } from '../src/core/doc/types';
import { EFFECT_TEMPLATES, attachModelEffectsToProp, createEmptyEffectsDocument,
  ensurePlacedPropIds, timerEmitterFields } from '../src/core/effects/authoring';
import { compatibleEffectSemanticTypes } from '../src/core/effects/document';
import { timerEmitterPreviewLaw } from '../src/core/effects/emitter-preview';
import { nodeMaterialScope, uvScrollFromGraph, uvScrollFromNode } from '../src/core/effects/world-effects';
import { decodeProps, modelDeclaredEffects, projectedNativeModelObjectCount, samplePropModelCurve,
  SSX_TRICKY_MAX_NATIVE_MODEL_OBJECTS } from '../src/core/reference/props';
import type { PropModelAnimationObject, PropModelCurve } from '../src/core/reference/props';
import { bakedPropClip, placementMatrix, placementSimilarity, rawInstanceQuat } from '../src/core/export/props';
import { placementQuat, propRotationFromQuat, writePropRotation } from '../src/core/props/pose';
import type { BakedPropClip } from '../src/core/export/props';
import type { PlacedProp } from '../src/core/doc/types';
import { CUSTOM_TEX_LEVEL, resolvePropTex } from '../src/core/paint/textures';
import { IMPORTED_PROP_LEVEL, MAX_IMPORT_EMITTERS, MAX_IMPORT_FLIPBOOK_FRAMES, MAX_IMPORT_TRIS,
  OS_ANIM_EXTRA, OS_EFFECT_EXTRA,
  OS_EMITTERS_EXTRA, importedEmittersFromExtras, importedMaterialFlipbook, importedMaterialScroll,
  importedPropName, importedSpinAnimation, importedSpinFromExtras, rawFromGltfPoint,
  scaleDraftTo } from '../src/core/props/imported';
import { draftToRecord } from '../src/app/props/glb-import';
import { cloneImportedProp, deleteImportedProp, importedPropsPayload, listImportedProps, renameImportedProp,
  replaceImportedProp, saveImportedProp, updateImportedPropMaterials } from '../src/server/routes/imported-props';
import { retiredNamesFile } from '../src/server/routes/safe-name';
import { bakeGltf } from '../scripts/snowknife-cli';
import { saveCustomTexture } from '../src/server/routes/textures';
import { encodePng } from '../src/server/routes/png';
import { exportLevel } from '../src/server/routes/export';
import { preflightFor } from '../src/server/routes/preflight';
import { createPropAssets } from '../src/app/viewport/scene/prop-assets';
import { createPropsLayer } from '../src/app/viewport/scene/props';
import { ps2ColorModulationShaderApplies, ps2NormalShaderApplies, ps2ObjectNormalVertexShaderApplies,
  propKeyScaleShader, propKeyScaleShaderApplies, propLightIndexColor } from '../src/app/props/textures';
import { PROP_FULL_BRIGHT_FACTOR, PROP_FULL_BRIGHT_RECORD, PROP_LAMBERT_IRRADIANCE,
  propPreviewIntensity, propRecordScreenFactor, rawSunVector } from '../src/core/lighting/prop-lights';
import { groundLightSampler } from '../src/core/lighting/ground-light';
import { check, failures } from './check';

const b64 = (view: ArrayBufferView) =>
  Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString('base64');

/** One triangle's worth of a record, in the base64 packing the wire format uses. */
const record = (name: string, tex: string | null, z = 0) => ({
  name,
  tris: 1,
  subs: [{
    mat: 0,
    pos: b64(new Float32Array([0, 0, z, 100, 0, z, 0, 100, z])),
    uv: b64(new Float32Array([0, 0, 1, 0, 0, 1])),
    idx: b64(new Uint32Array([0, 1, 2])),
  }],
  materials: [{ id: 0, tex }],
});

// --- model-declared material motion, from the GLB's own glTF `extras` (docs/032 · animation) ------------
// `extras` is whatever was in a file the user dropped on the library, so every field here is attacker-shaped
// input. The scroll is read per MATERIAL, which is the only way a snow gun's plume can move while its
// bodywork stays put.
{
  const wrap = (value: unknown) => ({ [OS_EFFECT_EXTRA]: value });
  const emptyDraft = { name: 'zz', tris: 0, verts: 0, size: [1, 1, 1] as [number, number, number],
    subs: [], textures: [], scrolls: [], flipbooks: [], alphaModes: [], emitters: [], animation: null };
  const good = { uvScroll: {
    mode: 0, uPerTick: -0.0225, vPerTick: 0, activeDuration: 1, pauseDuration: 0, lifetime: 0,
  } };

  check(importedMaterialScroll(wrap(JSON.stringify(good)))?.uPerTick === -0.0225,
    'a scroll declared as a JSON string (what Blender writes) is recovered');
  check(importedMaterialScroll(wrap(good))?.uPerTick === -0.0225,
    'a scroll declared as an object is recovered too');
  check(importedMaterialScroll(undefined) === null && importedMaterialScroll({}) === null,
    'a material with no extras declares no motion');
  check(importedMaterialScroll(wrap('{ not json')) === null,
    'malformed JSON is refused rather than thrown — one bad file must not fail the whole import');
  check(importedMaterialScroll(wrap({ uvScroll: { ...good.uvScroll, activeDuration: 0 } })) === null,
    'a zero active duration is refused because the native node can never produce a moving tick');
  check(importedMaterialScroll(wrap({ uvScroll: { ...good.uvScroll, pauseDuration: -1 } })) === null,
    'a negative pause duration is refused rather than producing an invalid native cycle');
  check(importedMaterialScroll(wrap({ uvScroll: {
    mode: 2, uPerTick: -0.004, vPerTick: 0, uLength: 0.5, vLength: 1.5,
  } }))?.pauseDuration === 1.5,
  'legacy uLength/vLength declarations migrate to their recovered active/pause duration meanings');
  check(importedMaterialScroll(wrap({ uvScroll: { ...good.uvScroll, uPerTick: 'fast' } })) === null,
    'a non-numeric rate is refused rather than coerced');
  check(importedMaterialScroll(wrap({ uvScroll: { ...good.uvScroll, uPerTick: Number.NaN } })) === null,
    'NaN is refused — it would poison the offset and the surface would vanish silently');
  check(importedMaterialScroll(wrap({ uvScroll: { ...good.uvScroll, uPerTick: 9e9 } })) === null,
    'an absurd rate is refused rather than rendered as noise');
  check(importedMaterialScroll(wrap({ uvScroll: { ...good.uvScroll, uPerTick: 0, vPerTick: 0 } })) === null,
    'a declared but stationary scroll is dropped, so it never allocates an animated material');

  // A flipbook declares only how many STATES its page carries. What plays them is an SSF effect authored
  // against the placement, which is why nothing here carries a rate.
  check(importedMaterialFlipbook(wrap(JSON.stringify({ flipbook: { frames: 2 } }))) === 2
    && importedMaterialFlipbook(wrap({ flipbook: { frames: 5 } })) === 5,
    'a flipbook frame count is recovered from either the JSON string Blender writes or a plain object');
  check(importedMaterialFlipbook(undefined) === null && importedMaterialFlipbook(wrap({})) === null
    && importedMaterialFlipbook(wrap({ uvScroll: good.uvScroll })) === null,
    'a material declaring no flipbook — or only a scroll — is an ordinary single-image material');
  check(importedMaterialFlipbook(wrap({ flipbook: { frames: 1 } })) === null
    && importedMaterialFlipbook(wrap({ flipbook: { frames: MAX_IMPORT_FLIPBOOK_FRAMES + 1 } })) === null
    && importedMaterialFlipbook(wrap({ flipbook: { frames: 2.5 } })) === null
    && importedMaterialFlipbook(wrap({ flipbook: { frames: 'two' } })) === null,
    'a count below two, past the crowd bank\'s 16, fractional or non-numeric is refused rather than cut');
  check(draftToRecord({ ...emptyDraft, textures: [null, null], scrolls: [null, null],
    flipbooks: [null, null], alphaModes: ['cutout', 'blend'] },
  ['Custom/a.png', 'Custom/b.png'], [null, ['Custom/b_f1.png']])
    .materials.map(m => m.frames?.join(' ') ?? '-').join(' | ')
    === '- | Custom/b.png Custom/b_f1.png',
    'the stored state list is the material\'s own tile followed by its staged frames, in strip order');
  const alphaRecord = draftToRecord({ ...emptyDraft, textures: [null, null], scrolls: [null, null],
    flipbooks: [null, null], alphaModes: ['cutout', 'blend'] }, ['Custom/a.png', 'Custom/b.png']);
  check(alphaRecord.materials[0].alphaMode === 'cutout'
    && alphaRecord.materials[1].alphaMode === 'blend' && alphaRecord.materials[1].blend === true,
  'glTF MASK/BLEND modes persist on the stored material, with BLEND retaining the legacy alpha-pass flag');

  // …and it survives the trip the real thing takes: record → server payload → decodeProps → PropMaterial.
  const moving = {
    ...record('zz-test-scroll', 'Custom/zz.png'),
    materials: [{ id: 0, tex: 'Custom/zz.png', scroll: good.uvScroll }],
  };
  const decoded = decodeProps({
    level: IMPORTED_PROP_LEVEL, models: [{ id: 1, name: moving.name, subs: moving.subs }],
    materials: moving.materials, crowdFrames: [], instances: [],
  });
  check(decoded.materials.get(0)?.scroll?.uPerTick === -0.0225,
    'a declared scroll survives the payload round trip onto PropMaterial');
  check(decodeProps({
    level: IMPORTED_PROP_LEVEL, models: [], materials: [{ id: 0, tex: null }],
    crowdFrames: [], instances: [],
  }).materials.get(0)?.scroll === undefined,
    'a material that declared nothing carries no scroll key at all');

  // …and through REGISTRATION, which is the second path and the one that skips no material field silently.
  // Imported props are a LIVE pseudo-level, so they go through syncLiveModels rather than registerPropModels;
  // a state list wired into only one of the two is a prop whose flipbook exists everywhere except on screen —
  // no frame strip in Texture Details, and no animated material for a pulse to reach.
  const flipped = {
    ...record('zz-test-flip', 'Custom/zz.png'),
    materials: [{ id: 0, tex: 'Custom/zz.png', frames: ['Custom/zz.png', 'Custom/zz_f1.png'] }],
  };
  const flipLp = decodeProps({
    level: IMPORTED_PROP_LEVEL, models: [{ id: 42, name: flipped.name, subs: flipped.subs }],
    materials: [{ id: 0, tex: 'Custom/zz.png', frames: ['zz.png', 'zz_f1.png'],
      blend: true, alphaMode: 'cutout', prio: true }],
    crowdFrames: [], instances: [],
  });
  check(flipLp.materials.get(0)?.frames?.join(' ') === 'zz.png zz_f1.png',
    'a declared flipbook survives the payload round trip onto PropMaterial');
  const flipAssets = createPropAssets();
  flipAssets.syncLiveModels(flipLp);
  const registered = flipAssets.propGeom.get(`${IMPORTED_PROP_LEVEL}:42`)?.[0];
  check(registered?.frames.join(' ') === 'zz.png zz_f1.png' && registered?.level === CUSTOM_TEX_LEVEL
      && registered.blend === true && registered.alphaMode === 'cutout' && registered.prio === true,
    'registering a live model keeps its state list and appearance flags against the bank its tile named');
  // Changing only an appearance flag moves no vertex and names no new texture. The live signature still has
  // to notice it, or an imported glass prop remains on the cutout material it first registered with.
  const opaqueChanged = decodeProps({
    level: IMPORTED_PROP_LEVEL, models: [{ id: 42, name: flipped.name, subs: flipped.subs }],
    materials: [{ id: 0, tex: 'Custom/zz.png', frames: ['zz.png', 'zz_f1.png'] }],
    crowdFrames: [], instances: [],
  });
  flipAssets.syncLiveModels(opaqueChanged);
  const opaqueRegistered = flipAssets.propGeom.get(`${IMPORTED_PROP_LEVEL}:42`)?.[0];
  check(opaqueRegistered?.blend === false && opaqueRegistered.alphaMode === undefined
    && opaqueRegistered.prio === false,
    'a live appearance-only edit re-registers instead of retaining stale blend/priority flags');
  // Retexturing moves no vertex, so a geometry-only signature would call the model unchanged and keep
  // serving the tile it first saw — the same trap the clip hash exists for, one field along.
  const retextured = decodeProps({
    level: IMPORTED_PROP_LEVEL, models: [{ id: 42, name: flipped.name, subs: flipped.subs }],
    materials: [{ id: 0, tex: 'Custom/zz2.png', frames: ['zz2.png', 'zz_f1.png'] }],
    crowdFrames: [], instances: [],
  });
  flipAssets.syncLiveModels(retextured);
  check(flipAssets.propGeom.get(`${IMPORTED_PROP_LEVEL}:42`)?.[0].tex === 'zz2.png',
    'a MATERIAL-only edit re-registers, so an edited tile reaches the draw instead of the one first seen');
  const nativeLight = decodeProps({
    level: 'DONOR', models: [], materials: [], instances: [{
      i: 7, m: 3, p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1], n: 'lit',
      la: [36.4, 62.7, 76.8],
      lk: [316.16, 286.76, 261.15, 0, 0, 0, 0, 0, 0],
      lv: [0.518, -0.2, 0.831, 0, 0, 0, 0, 0, 0],
    }],
  }).instances[0].lighting;
  check(nativeLight?.keys.length === 3 && nativeLight.ambient[2] === 76.8
      && nativeLight.keys[0].color[0] === 316.16 && nativeLight.keys[0].direction[2] === 0.831,
    'retail per-instance ambient/key records survive the compact prop payload');
  const listStates = decodeProps({
    level: 'DONOR', models: [], materials: [], instances: [
      { i: 0, m: 0, p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1], n: 'showoff support', ls: 2 },
      { i: 1, m: 0, p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1], n: 'ordinary prop' },
    ],
  }).instances.map(instance => instance.ltgState);
  check(listStates.join(',') === '2,0',
    'native LTG list state survives the prop payload, with omitted common rows decoding as state 0');
  const nativeNormals = new Float32Array([0, 0, 1, 0, 1, 0, 1, 0, 0]);
  const normalModel = decodeProps({
    level: 'SNOW', materials: [], instances: [], models: [{ id: 1, name: 'native normals', subs: [{
      mat: -1,
      pos: b64(new Float32Array(9)), uv: b64(new Float32Array(6)), nor: b64(nativeNormals),
      idx: b64(new Uint32Array([0, 1, 2])),
    }] }],
  }).models[0].subs[0];
  check(normalModel.normals?.length === nativeNormals.length
      && normalModel.normals.every((value, index) => value === nativeNormals[index]),
    'retail OBJ normals survive the compact prop payload without being re-smoothed');
}

// --- model-declared PARTICLE emitters (docs/032 · particles) ---------------------------------------------
// The model carries SSX's own `type2Sub0` payload, so an emitter declared in a GLB and one authored in the
// Effects editor are the same record and the same runtime plays both.
{
  const fields = (over: Record<string, number> = {}) => {
    const f: Record<string, number> = {};
    for (let i = 0; i <= 50; i++) f[`U${i}`] = 0;
    f.U0 = 64; f.U5 = 2.6; f.U20 = 1500; f.U32 = -340; f.U49 = 1;
    return { ...f, ...over };
  };
  const wrap = (value: unknown) => ({ [OS_EMITTERS_EXTRA]: value });
  const one = [{ at: [1.44, 3.92, 0], fields: fields() }];

  check(importedEmittersFromExtras(wrap(JSON.stringify(one))).length === 1,
    'an emitter declared as a JSON string (what Blender writes) is recovered');
  check(importedEmittersFromExtras(wrap(one))[0].emitter.fields.U49 === 1,
    'the native payload survives verbatim — the sprite index is the one the recipe chose');
  check(importedEmittersFromExtras(undefined).length === 0
    && importedEmittersFromExtras(wrap('nope')).length === 0,
    'no extras, or malformed JSON, declares no emitters');
  check(importedEmittersFromExtras(wrap([{ at: [0, 0], fields: fields() }])).length === 0,
    'a spawn point that is not three numbers is refused');
  check(importedEmittersFromExtras(wrap([{ at: [0, Number.NaN, 0], fields: fields() }])).length === 0,
    'a non-finite spawn coordinate is refused rather than propagated into the scene graph');
  check(importedEmittersFromExtras(wrap([{ at: [0, 0, 0], fields: fields({ U20: Number.POSITIVE_INFINITY }) }]))
    .length === 0, 'a non-finite field is refused');
  check(importedEmittersFromExtras(wrap([{ at: [0, 0, 0], fields: fields({ U0: 0 }) }])).length === 0,
    'an emitter with no particles is dropped rather than scheduled');
  check(importedEmittersFromExtras(wrap([{ at: [0, 0, 0], fields: fields({ U0: 1e6 }) }]))[0]
    .emitter.fields.U0 === 512, 'the per-emitter particle count is bounded');
  check(importedEmittersFromExtras(wrap(Array.from({ length: 40 }, () => one[0]))).length
    === MAX_IMPORT_EMITTERS, `a file cannot declare more than ${MAX_IMPORT_EMITTERS} emitters`);

  // The invariant that actually matters: a spawn point takes the SAME route as a vertex. If these ever
  // diverge the emitter sits off the model, which reads as a physics bug rather than an import one.
  const gltfPoint: [number, number, number] = [1.44, 3.92, -0.25];
  const cx = 37, cy = -12;
  const vertexPath = [-100 * gltfPoint[0] - cx, -100 * gltfPoint[2] - cy, 100 * gltfPoint[1]];
  const emitterPath = rawFromGltfPoint(gltfPoint, cx, cy);
  check(emitterPath.every((v, i) => Math.abs(v - vertexPath[i]) < 1e-9),
    'a spawn point converts by the same map as a vertex, re-centring included');

  // Scaling: the spawn point and particle size follow the model; velocity and gravity are physics.
  const draft = { size: [2, 1, 1] as [number, number, number], subs: [{ positions: new Float32Array([100, 0, 0]) }],
    emitters: [{ fields: fields({ U9: 100, U10: 0, U11: 200, U4: 55, U6: 30 }) }] };
  scaleDraftTo(draft, 4);                                     // longest edge 2 m → 4 m, so k = 2
  check(draft.emitters[0].fields.U9 === 200 && draft.emitters[0].fields.U11 === 400,
    'scaling a model at import carries its spawn point with it');
  check(draft.emitters[0].fields.U4 === 110 && draft.emitters[0].fields.U6 === 60,
    '…and the particle size, so a bigger gun does not throw the same flecks');
  check(draft.emitters[0].fields.U20 === 1500 && draft.emitters[0].fields.U32 === -340,
    '…but not velocity or gravity, which are physics and do not scale with the model');

  // Placing such a model attaches the declaration as an ordinary persistent graph.
  const doc = createEmptyEffectsDocument('zz-test');
  check(attachModelEffectsToProp(doc, 'prop:0001', { emitters: [{ fields: fields() }],
    scrolls: [{ mat: 1, effect: {
      mode: 0, uPerTick: -0.0225, vPerTick: 0, activeDuration: 1, pauseDuration: 0, lifetime: 0,
    } }] }),
    'a placement of a model that declared effects attaches them');
  const attached = doc.graphs.find(g => g.nodes.some(n => timerEmitterFields(n)));
  check(!!attached, 'the attached graph holds a real timer-emitter node the runtime already reads');
  check(timerEmitterPreviewLaw(attached!.nodes[0])?.spriteIndex === 1,
    'and it decodes through the SAME law an editor-authored emitter uses');
  check(!attachModelEffectsToProp(doc, 'prop:0001', { emitters: [{ fields: fields() }] }),
    're-attaching is a no-op, so a prop someone has since retuned is left alone');
  check(attachModelEffectsToProp(doc, 'prop:0002', {}) === false,
    'a model that declared nothing attaches nothing');

  // The scroll is a REAL node, so it is visible in the Effects editor and decodes with the retail reader —
  // and it names the material it drives, which is what lets one submesh scroll while the rest stay still.
  const scrollNode = attached!.nodes.find(n => uvScrollFromNode(n));
  check(!!scrollNode, 'the declared scroll became an ordinary UVScroll node, not a private side channel');
  check(nodeMaterialScope(scrollNode!) === 1,
    'the node names the material it drives, in extensions rather than the native payload');
  check(uvScrollFromGraph(attached, 1)?.uPerTick === -0.0225,
    'resolving for that material finds the scroll');
  check(uvScrollFromGraph(attached, 0) === null,
    '…and resolving for a different material finds nothing, so the bodywork stays put');
  check(uvScrollFromNode(scrollNode!)?.uPerTick === -0.0225,
    'the payload is retail-shaped, so the existing reader decodes it and an export can ship it');

  // Auto-attached nodes must be indistinguishable from hand-added ones in the inspector. The label comes
  // straight off semanticType, so a node without one shows as the bare "Main type 2".
  const emitterNode = attached!.nodes.find(n => timerEmitterFields(n));
  const template = (id: string) => EFFECT_TEMPLATES.find(t => t.id === id)?.nodes?.[0]?.semanticType;
  check(emitterNode!.semanticType === template('timer-emitter'),
    `the emitter node carries the same semanticType the editor's own template does (${template('timer-emitter')})`);
  check(scrollNode!.semanticType === template('uv-scroll'),
    `and so does the scroll node (${template('uv-scroll')})`);
  check(emitterNode!.semanticType === compatibleEffectSemanticTypes(emitterNode!)?.[0],
    '…derived from the payload rather than written out, so it cannot drift from the mapping');

  // What the prop library badges with a bolt: a model that arrives already animated.
  const withFx = decodeProps({
    level: IMPORTED_PROP_LEVEL,
    models: [{ id: 1, name: 'gun', subs: record('gun', null).subs, emitters: [{ fields: fields() }] },
      { id: 2, name: 'scroller', subs: record('scroller', null).subs },
      { id: 3, name: 'plain', subs: record('plain', null).subs }],
    materials: [{ id: 0, tex: null, scroll: {
      mode: 0, uPerTick: -0.02, vPerTick: 0, activeDuration: 1, pauseDuration: 0, lifetime: 0,
    } }],
    crowdFrames: [], instances: [],
  });
  // models 1 and 2 both draw material 0, which scrolls; only model 1 also carries an emitter
  check(modelDeclaredEffects(withFx, withFx.models[0]).emitters === 1,
    'the library sees a model that brings its own emitter');
  check(modelDeclaredEffects(withFx, withFx.models[1]).scroll === 1
    && modelDeclaredEffects(withFx, withFx.models[1]).any,
    'a model whose material scrolls is badged too, with no emitter of its own');
  const plainProps = decodeProps({
    level: IMPORTED_PROP_LEVEL, models: [{ id: 3, name: 'plain', subs: record('plain', null).subs }],
    materials: [{ id: 0, tex: null }], crowdFrames: [], instances: [],
  });
  check(!modelDeclaredEffects(plainProps, plainProps.models[0]).any,
    'an ordinary model declares nothing and gets no bolt');
}

// ---- declared SPINS: the node extras a turning part rides in, and the clip they become --------------
{
  const wrap = (value: unknown) => ({ [OS_ANIM_EXTRA]: value });
  const good = { spin: { axis: [0.91, 0, 0.41], revsPerSecond: 0.75 } };

  check(importedSpinFromExtras(wrap(JSON.stringify(good)))?.revsPerSecond === 0.75,
    'a spin declared as a JSON string (what Blender writes) is recovered');
  check(importedSpinFromExtras(undefined) === null && importedSpinFromExtras(wrap('nope')) === null,
    'no extras, or malformed JSON, declares no spin');
  check(importedSpinFromExtras(wrap({ spin: { axis: [0, 0, 0], revsPerSecond: 1 } })) === null,
    'a zero-length axis is refused rather than dividing by its own length');
  check(importedSpinFromExtras(wrap({ spin: { axis: [0, 1, 0], revsPerSecond: 0 } })) === null,
    'a declared but stationary spin is dropped rather than costing a clip');
  check(importedSpinFromExtras(wrap({ spin: { axis: [0, 1, 0], revsPerSecond: 900 } })) === null,
    'a rate past the cap is refused — it would be a strobe, and a sub-frame clip');
  check(importedSpinFromExtras(wrap({ spin: { axis: [0, 1, 0], revsPerSecond: Number.NaN } })) === null,
    'a non-finite rate is refused');
  check(importedSpinFromExtras(wrap({ swing: {
    axis: [0, 0, 1], amplitudeDegrees: 58, periodSeconds: 4.8,
  } }))?.amplitudeDegrees === 58, 'a bounded pendulum declaration is recovered alongside continuous spins');
  check(importedSpinFromExtras(wrap({ swing: {
    axis: [0, 0, 1], amplitudeDegrees: 120, periodSeconds: 4.8,
  } })) === null, 'a swing past the safe apex cap is refused');
  check(importedSpinFromExtras(wrap({ swing: {
    axis: [0, 0, 1], amplitudeDegrees: 58, periodSeconds: 0,
  } })) === null, 'a swing with no period is refused rather than producing a zero-length clip');

  // The geometry the clip has to produce: a turn about the declared axis, through the declared pivot.
  // Composed exactly the way the prop renderer composes it (viewport/scene/props.ts hierarchyDeltas), so
  // a mistake in the object chain shows up here rather than as a fan orbiting the machine.
  const axis: [number, number, number] = [0.9135454576, 0, 0.4067366431];
  const pivot: [number, number, number] = [111.11, 0, 377.36];
  const built = importedSpinAnimation([{ pivot, axis, revsPerSecond: 0.75 }]);
  check(built?.animation.clipFrames === 40 && built.objectOf[0] === 2,
    'one spin becomes a mount + a turning child, and a 0.75 rev/s clip is 40 frames at 30 fps');

  const localMatrix = (animation: NonNullable<typeof built>['animation'], index: number,
    frame: number | null): THREE.Matrix4 => {
    const o = animation.objects[index];
    if (frame === null || !o.channels?.some(c => !!c?.length)) {
      return new THREE.Matrix4().compose(new THREE.Vector3(...o.restPosition),
        new THREE.Quaternion(...o.restRotation), new THREE.Vector3(...o.restScale));
    }
    const euler = new THREE.Vector3(...(o.baseEuler ?? [0, 0, 0]));
    for (let a = 0; a < 3; a++) {
      const curve = o.channels[a + 3];
      if (curve?.length) euler.setComponent(a, samplePropModelCurve(curve, frame));
    }
    return new THREE.Matrix4().compose(new THREE.Vector3(...(o.basePosition ?? o.restPosition)),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(euler.x),
        THREE.MathUtils.degToRad(euler.y), THREE.MathUtils.degToRad(euler.z), 'ZYX')),
      new THREE.Vector3(...o.restScale));
  };
  const worldMatrix = (animation: NonNullable<typeof built>['animation'], index: number,
    frame: number | null): THREE.Matrix4 => {
    const parent = animation.objects[index].parent;
    const local = localMatrix(animation, index, frame);
    return parent >= 0 ? worldMatrix(animation, parent, frame).clone().multiply(local) : local;
  };
  const deltaAt = (frame: number) =>
    worldMatrix(built!.animation, 2, frame).clone()
      .multiply(worldMatrix(built!.animation, 2, null).clone().invert());

  const rim = new THREE.Vector3(pivot[0] - 41 * axis[2], 0, pivot[2] + 41 * axis[0]); // ⟂ to the axis
  const rest = deltaAt(0).elements;
  check(rest.every((v, i) => Math.abs(v - (i % 5 === 0 ? 1 : 0)) < 1e-6),
    'frame 0 is the rest pose exactly — a clip that starts anywhere else pops on attach');

  const quarter = rim.clone().applyMatrix4(deltaAt(10));   // 10/40 of one turn per clip = 90°
  const a = new THREE.Vector3(...axis);
  const from = rim.clone().sub(new THREE.Vector3(...pivot));
  const to = quarter.clone().sub(new THREE.Vector3(...pivot));
  check(Math.abs(to.length() - from.length()) < 1e-3,
    'the turn is rigid about the pivot — the blade tip keeps its radius');
  check(Math.abs(to.dot(a) - from.dot(a)) < 1e-3,
    'nothing travels along the axis — the fan turns in its barrel rather than out of it');
  check(Math.abs(from.angleTo(to) - Math.PI / 2) < 1e-3,
    'a quarter of the clip is a quarter turn, about the DECLARED axis and not a model cardinal one');
  check(Math.abs(rim.clone().applyMatrix4(deltaAt(40)).distanceTo(rim)) < 1e-3,
    'the clip closes on a whole turn, so the loop wraps without a jump');

  const pendulum = importedSpinAnimation([{
    pivot: [0, 0, 480], axis: [0, 1, 0], amplitudeDegrees: 60, periodSeconds: 4,
  }]);
  const pendulumCurve = pendulum?.animation.objects[2].channels?.[4];
  check(pendulum?.animation.clipFrames === 120 && pendulumCurve?.length === 4,
    'one swing becomes a four-quarter cubic pendulum over its declared period');
  check(Math.abs(samplePropModelCurve(pendulumCurve, 0)) < 1e-6
    && Math.abs(samplePropModelCurve(pendulumCurve, 30) - 60) < 1e-6
    && Math.abs(samplePropModelCurve(pendulumCurve, 60)) < 1e-6
    && Math.abs(samplePropModelCurve(pendulumCurve, 90) + 60) < 1e-6
    && Math.abs(samplePropModelCurve(pendulumCurve, 120)) < 1e-6,
  'the pendulum crosses rest, eases through both apexes, and closes at rest without a loop pop');

  // A nested spinner is the carnival-ride case: the car's mount belongs below the platform's turning
  // child, so its centre orbits while its own channel turns the car locally. Both declarations still use
  // model-space pivots and axes; the builder is responsible for deriving the child mount's local rest pose.
  const nested = importedSpinAnimation([
    { pivot: [0, 0, 0], axis: [0, 0, 1], revsPerSecond: 0.1 },
    { pivot: [300, 0, 0], axis: [0, 0, 1], revsPerSecond: -0.2, parent: 0 },
  ]);
  check(nested?.animation.clipFrames === 300 && nested.objectOf[0] === 2 && nested.objectOf[1] === 4,
    'a ten-second platform plus child car shares one whole-turn clip and keeps stable object indices');
  check(nested?.animation.objects[3].parent === 2 && nested.animation.objects[4].parent === 3,
    'the car mount hangs from the PLATFORM TURN, then owns the car turn');
  const carRest = new THREE.Vector3(300, 0, 0);
  const carDelta = worldMatrix(nested!.animation, nested!.objectOf[1], 75).clone()
    .multiply(worldMatrix(nested!.animation, nested!.objectOf[1], null).clone().invert());
  const carQuarter = carRest.clone().applyMatrix4(carDelta);
  check(carQuarter.distanceTo(new THREE.Vector3(0, 300, 0)) < 1e-3,
    'at a quarter platform turn the nested car centre has orbited 90 degrees, independent of its own spin');
  check(importedSpinAnimation([
    { pivot: [0, 0, 0], axis: [0, 0, 1], revsPerSecond: 1, parent: 0 },
  ]) === null, 'a self/cyclic parent is rejected instead of building a recursive object hierarchy');

  // --- what the ISO packer receives, and what it does with it -------------------------------------
  // The clip ships VERBATIM — hierarchy, rest poses and all six channels — plus the similarity the
  // placement's vertices were baked through. Nothing is summarised, so nothing can be summarised wrongly;
  // the packer's whole job is one change of frame.
  const placement: PlacedProp = { level: IMPORTED_PROP_LEVEL, model: 1, name: 'gun',
    pos: [12, 3.5, -40], yaw: 37, scale: 1.5 };
  const posed = placementMatrix(placement);
  const shipped = bakedPropClip(built!.animation, posed);
  check(shipped?.clip.objects.length === 3 && shipped.clip.clipFrames === 40,
    'the clip travels as its own object hierarchy rather than as a summary of one');
  check(shipped?.tagOf(2) === 2 && shipped.tagOf(undefined) === 0,
    'a submesh’s _obj tag is the clip object index directly, and static geometry belongs to the root');
  check(shipped?.clip.objects[1].parent === 0 && shipped.clip.objects[2].parent === 1,
    'the parent chain survives, which is what lets a mount hold the tilt for the part below it');
  check(!!shipped?.clip.objects[2].channels?.[4]?.length
    && !!shipped.clip.objects[2].basePosition && !!shipped.clip.objects[2].baseEuler,
    'an animated object ships its base pose beside its channels — the engine builds its pose from those '
    + 'two and never reads its rest matrix, so a missing base is a part snapped somewhere else');
  check(Math.abs(shipped!.clip.pose.scale - 1.5) < 1e-9
    && Math.hypot(...shipped!.clip.pose.rotation) - 1 < 1e-9,
    'the shipped pose is a plain similarity: one uniform scale and a unit quaternion');

  // A clip that does NOT already start with an unanimated identity object — anything recovered from an
  // extracted level might not — gets one prepended, and every index moves with it. Object 0 meaning "the
  // part that stays put" is what `_obj0` rests on at the far end.
  const headless = bakedPropClip({ clipFrames: 30, objects: [
    { parent: -1, restPosition: [0, 40, 0], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1],
      basePosition: [0, 40, 0], baseEuler: [0, 0, 0],
      channels: [null, null, null, null, [[0, 0, 360, 0, 0, 1]], null] },
  ] }, posed);
  check(headless?.clip.objects.length === 2 && headless.clip.objects[0].parent === -1
    && !headless.clip.objects[0].channels && headless.clip.objects[1].parent === 0,
    'a rootless clip gains an identity root rather than packing its moving object as the static one');
  check(headless?.tagOf(0) === 1 && headless.tagOf(undefined) === 0,
    'and the submesh tags shift with it, so geometry still finds the object that owns it');

  // The selected-prop warning predicts the canonical export's normal final count. Identity placement mounts
  // are omitted; the authored hierarchy and its guaranteed root are the actual PS2 budget consumers.
  const capacityRoot: PropModelAnimationObject = {
    parent: -1, restPosition: [0, 0, 0], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1],
  };
  const capacityMover = (parent: number): PropModelAnimationObject => ({
    parent, restPosition: [0, 0, 30], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1],
    basePosition: [0, 0, 30], baseEuler: [0, 0, 0],
    channels: [null, null, null, null, null, [[0, 0, 0, 90, 0, 3]]],
  });
  const capacityClip = (count: number, flat: boolean) => ({ clipFrames: 90,
    objects: [capacityRoot, ...Array.from({ length: count }, (_, i) => capacityMover(flat ? 0 : i))] });
  check(SSX_TRICKY_MAX_NATIVE_MODEL_OBJECTS === 27
    && projectedNativeModelObjectCount(capacityClip(26, true)) === 27
    && projectedNativeModelObjectCount(capacityClip(27, true)) === 28,
  'the native-count projection omits identity mounts (26 flat movers fit, 27 exceed the budget)');
  check(projectedNativeModelObjectCount(capacityClip(25, false)) === 26
    && projectedNativeModelObjectCount(capacityClip(26, false)) === 27,
  'the native-count projection counts a nested chain and its one identity root exactly');
  check(projectedNativeModelObjectCount({ clipFrames: 30, objects: [{
    parent: -1, restPosition: [0, 40, 0], restRotation: [0, 0, 0, 1], restScale: [1, 1, 1],
    basePosition: [0, 40, 0], baseEuler: [0, 0, 0],
    channels: [null, null, null, null, [[0, 0, 360, 0, 0, 1]], null],
  }] }) === 2,
  'the projection adds the guaranteed root but no no-op placement mount to a headless moving clip');

  // The load-bearing check: replicate the canonical exporter (`canonical-props.ts` packClip) and compare the motion
  // it encodes against the motion the viewport previews, point for point and frame for frame. The rules
  // being tested are that the frame change belongs at the TOP of the hierarchy only, that it rides on an
  // unanimated object (a mount, when the top-level object moves), and that translations carry the scale
  // while rotations do not. Getting any of them wrong is a prop that animates perfectly in the editor and
  // wrongly on the disc, which is exactly the class of bug this cannot be allowed to have.
  const packAgainst = (clip: BakedPropClip, localize: (p: THREE.Vector3) => THREE.Vector3) => {
    const origin = new THREE.Vector3(...clip.pose.origin);
    const poseQ = new THREE.Quaternion(...clip.pose.rotation);
    const frameT = localize(origin);
    const columns = [0, 1, 2].map(i => localize(origin.clone().add(
      new THREE.Vector3().setComponent(i, clip.pose.scale).applyQuaternion(poseQ))).sub(frameT));
    const frameS = columns[0].length();
    const [bx, by, bz] = columns.map(column => column.clone().normalize());
    const frameQ = new THREE.Quaternion()
      .setFromRotationMatrix(new THREE.Matrix4().makeBasis(bx, by, bz));
    const packedOf: number[] = [];
    const objects: { parent: number; local: (frame: number | null) => THREE.Matrix4 }[] = [];
    clip.objects.forEach((o, k) => {
      if (k === 0) {
        packedOf[0] = 0;
        objects.push({ parent: -1, local: () => new THREE.Matrix4() });
        return;
      }
      let parent = o.parent <= 0 ? 0 : packedOf[o.parent];
      let position = new THREE.Vector3(...o.restPosition).multiplyScalar(frameS);
      let rotation = new THREE.Quaternion(...o.restRotation);
      const scale = new THREE.Vector3(...o.restScale);
      const moving = !!o.channels?.some(curve => !!curve?.length);
      if (o.parent <= 0) {
        if (moving) {
          const mount = new THREE.Matrix4().compose(frameT, frameQ, new THREE.Vector3(1, 1, 1));
          objects.push({ parent, local: () => mount.clone() });
          parent = objects.length - 1;
        } else {
          position = position.applyQuaternion(frameQ).add(frameT);
          rotation = frameQ.clone().multiply(rotation);
        }
      }
      const rest = new THREE.Matrix4().compose(position, rotation, scale);
      packedOf[k] = objects.length;
      objects.push({ parent, local: frame => {
        if (frame === null || !moving) return rest.clone();
        const p = new THREE.Vector3(...o.basePosition!).multiplyScalar(frameS);
        const e = new THREE.Vector3(...o.baseEuler!);
        for (let a = 0; a < 3; a++) {
          const travel = o.channels![a], turn = o.channels![a + 3];
          if (travel?.length) p.setComponent(a, samplePropModelCurve(travel as PropModelCurve, frame) * frameS);
          if (turn?.length) e.setComponent(a, samplePropModelCurve(turn as PropModelCurve, frame));
        }
        return new THREE.Matrix4().compose(p, new THREE.Quaternion().setFromEuler(new THREE.Euler(
          THREE.MathUtils.degToRad(e.x), THREE.MathUtils.degToRad(e.y),
          THREE.MathUtils.degToRad(e.z), 'ZYX')), scale);
      } });
    });
    const packedWorld = (index: number, frame: number | null): THREE.Matrix4 => {
      const o = objects[index];
      const local = o.local(frame);
      return o.parent >= 0 ? packedWorld(o.parent, frame).clone().multiply(local) : local;
    };
    // The engine draws an object's mesh — held in that object's own rest frame — at its animated world
    // matrix, so what a packed vertex undergoes is exactly animated × rest⁻¹.
    return (object: number, frame: number) => packedWorld(packedOf[object], frame).clone()
      .multiply(packedWorld(packedOf[object], null).invert());
  };

  // An imported placement packs with an explicit collision profile carrying its own location, rotation and
  // scale, so the localization the packer applies is the full inverse rather than a bare pivot subtraction.
  const instanceQ = new THREE.Quaternion(0.1, -0.3, 0.2, 0.927).normalize();
  const instanceLoc = new THREE.Vector3(...shipped!.clip.pose.origin);
  const localize = (p: THREE.Vector3) =>
    p.clone().sub(instanceLoc).applyQuaternion(instanceQ.clone().conjugate()).divideScalar(1.5);
  // model-local raw cm → the world raw cm a `v` line is written in → the packed instance's own frame
  const posedMatrix = new THREE.Matrix4().fromArray(posed);
  const toInstance = (v: THREE.Vector3) => {
    const editor = v.clone().applyMatrix4(posedMatrix);
    return localize(new THREE.Vector3(-100 * editor.x, -100 * editor.z, 100 * editor.y));
  };
  const packedDelta = packAgainst(shipped!.clip, localize);
  const probes = [rim, new THREE.Vector3(...pivot), new THREE.Vector3(pivot[0], 60, pivot[2] - 12)];
  let drift = 0;
  for (let frame = 0; frame <= 40; frame += 5) {
    for (const probe of probes) {
      const truth = toInstance(probe.clone().applyMatrix4(deltaAt(frame)));
      const packedAt = toInstance(probe).applyMatrix4(packedDelta(2, frame));
      drift = Math.max(drift, truth.distanceTo(packedAt));
    }
  }
  check(drift < 1e-6,
    `the packed hierarchy moves a vertex exactly where the preview does, every frame (worst ${drift.toExponential(1)} cm)`);
}

// ---- the authored PLACEMENT ROTATION: one resolver, read by everything that poses a prop -------------
// A placement authors yaw / pitch / roll (docs/012), so the gizmo shows all three rings. The risk that
// buys is DIVERGENCE: the viewport renders through one matrix, the OBJ bake writes through another, and
// the canonical instance carries a third for collision. These check they are the same rotation, and that
// an untilted placement still resolves to exactly the yaw-only formulas they replaced.
{
  const upright: PlacedProp = { level: IMPORTED_PROP_LEVEL, model: 1, name: 'gun',
    pos: [12, 3.5, -40], yaw: 37, scale: 1.5 };
  const tilted: PlacedProp = { ...upright, pitch: -24, roll: 63 };

  // Back-compat first: absent tilt must not perturb anything. A saved mountain full of upright props has
  // to bake byte-identically after this change, so the fast path and the general path must agree to the
  // last bit for pitch = roll = 0.
  const yawOnly = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), upright.yaw * Math.PI / 180);
  const resolved = new THREE.Quaternion(...placementQuat(upright));
  check(resolved.angleTo(yawOnly) < 1e-12,
    'an untilted placement resolves to exactly the yaw-about-vertical rotation it always did');
  check(rawInstanceQuat(upright).every((v, i) =>
    Math.abs(v - [0, 0, -Math.sin(upright.yaw * Math.PI / 360), Math.cos(upright.yaw * Math.PI / 360)][i]) < 1e-12),
    'and its native instance rotation is still the raw −Z turn the packer has always been handed');

  // The canonical instance's rotation must be the rotation the VERTICES actually went through, measured
  // off the same map rather than re-encoded by hand — that is the whole reason `placementSimilarity` reads
  // the pose back off its own matrix. A disagreement puts a tilted prop's collision shape at one angle and
  // its art at another, which is exactly the failure a single yaw could never expose.
  const similarity = placementSimilarity(placementMatrix(tilted));
  const declared = new THREE.Quaternion(...(rawInstanceQuat(tilted) as [number, number, number, number]));
  const measured = new THREE.Quaternion(...(similarity.rotation as [number, number, number, number]));
  check(Math.min(declared.angleTo(measured), declared.angleTo(measured.clone().set(
    -measured.x, -measured.y, -measured.z, -measured.w))) < 1e-9,
    'the native instance rotation is the same rotation the baked vertices rode through');

  // The GIZMO round trip. A drag hands the layer a scene-space delta; the authored angles it writes back
  // must reproduce that exact visual turn. worldRoot mirrors Z, so a data rotation reads on screen as the
  // conjugate through that reflection: axis (x, y, z) → (−x, −y, z), an involution.
  const toScene = (r: PlacedProp) => {
    const [x, y, z, w] = placementQuat(r);
    return new THREE.Quaternion(-x, -y, z, w);
  };
  let worstRing = 0;
  for (const axis of [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)]) {
    const delta = new THREE.Quaternion().setFromAxisAngle(axis, 0.7);
    const wanted = delta.clone().multiply(toScene(tilted)).normalize();
    const q = wanted;
    const authored = propRotationFromQuat([-q.x, -q.y, q.z, q.w]);
    const got = toScene({ ...tilted, ...authored });
    worstRing = Math.max(worstRing, Math.min(got.angleTo(wanted), got.angleTo(wanted.clone().set(
      -wanted.x, -wanted.y, -wanted.z, -wanted.w))));
  }
  check(worstRing < 1e-9,
    `every gizmo ring's drag survives the trip through the three authored angles (worst ${worstRing.toExponential(1)} rad)`);

  // Tilt is stored as OPTIONAL fields, so a rotation that comes back upright must delete them rather than
  // write zeros — an untilted prop that was merely dragged has to serialize as it did before tilt existed.
  const scratch: PlacedProp = { ...tilted };
  writePropRotation(scratch, propRotationFromQuat(placementQuat({ yaw: 90 })));
  check(Math.abs(scratch.yaw - 90) < 1e-9 && !('pitch' in scratch) && !('roll' in scratch),
    'rotating a prop back upright drops its tilt fields instead of storing zeros');
}

const assetRoot = mkdtempSync(join(tmpdir(), 'slopesmith-prop-assets-'));
process.env.SLOPESMITH_PROJECT_ASSETS_ROOT = assetRoot;
const propsDir = join(assetRoot, 'props');
const texDir = join(assetRoot, 'textures');
const hadDirBefore = existsSync(propsDir);
const hadTexDirBefore = existsSync(texDir);
const written: string[] = [];
const texWritten: string[] = [];
/** The catalogue's two sidecars outlive the records they describe, which is the point of them — so this
 *  run's retirements and its spent model numbers are rolled back afterwards, leaving the author's own
 *  catalogue exactly as it was. */
const sidecars = [retiredNamesFile(propsDir), `${propsDir}.nextid.json`]
  .map(file => ({ file, before: existsSync(file) ? readFileSync(file) : null }));

/** A real tile in the Custom bank, so the export's copy step has actual bytes to move — the import path
 *  stages one exactly this way, through the ordinary texture-upload route. */
const tile = await saveCustomTexture('zz-test-imported-tile', encodePng({ w: 8, h: 8,
  data: new Uint8Array(8 * 8 * 4).fill(200) }));
texWritten.push(tile);

try {
  // --- naming -------------------------------------------------------------------------------------
  check(importedPropName('old_lamp-post.glb') === 'old lamp post',
    'the GLB file name becomes a readable model name');

  // --- store, sanitise, allocate ------------------------------------------------------------------
  // Track the file names the store REPORTS rather than re-deriving them: safeDataName keeps hyphens and
  // underscores but drops spaces and punctuation, and a second guess at that alphabet silently leaks test
  // files into the user's Maps/ (this cleanup did exactly that before saveImportedProp returned the name).
  const lamp0 = await saveImportedProp('zz test lamp!.glb', {
    ...record('zz test lamp', `${CUSTOM_TEX_LEVEL}/${tile}`),
    materials: [{ id: 0, tex: `${CUSTOM_TEX_LEVEL}/${tile}`, alphaMode: 'cutout' }],
  });
  written.push(lamp0.file);
  const first = lamp0.record;
  check(lamp0.file === 'zztestlamp.json',
    `the record lands under the mountain's assets/props folder with a sanitised name (${lamp0.file})`);
  check(existsSync(join(propsDir, lamp0.file)), 'the reported file is the one actually written');
  const rock0 = await saveImportedProp('zz-test-rock', record('zz test rock', null, 50));
  written.push(rock0.file);
  const second = rock0.record;
  check(rock0.file === 'zz-test-rock.json', `hyphens survive sanitising (${rock0.file})`);
  check(second.id !== first.id, `a new file gets its own model number (${first.id} → ${second.id})`);

  // The load-bearing one: placements persist the model NUMBER, so a stored record's number must keep naming
  // the same geometry for as long as the record exists. Importing a file whose name is already in the
  // catalogue lands beside it as <name>_2 with its own number (docs/038), so an import can never repoint
  // placements of a model it merely shares a file name with.
  const lamp1 = await saveImportedProp('zz test lamp!.glb', record('zz test lamp v2', `${CUSTOM_TEX_LEVEL}/${tile}`, 7));
  written.push(lamp1.file);
  const again = lamp1.record;
  check(lamp1.file === 'zztestlamp_2.json', `re-importing one file name lands beside it (${lamp1.file})`);
  check(again.id !== first.id, `the second import gets its own model number (${first.id} → ${again.id})`);
  check((await listImportedProps()).filter(e => e.file.startsWith('zztestlamp')).length === 2,
    'both records survive — the first model keeps the geometry its placements are wearing');

  // --- managing a stored model (the library's right-click menu) -----------------------------------
  // Rename, duplicate, replace and delete are the props answer to the Texture Library's tile menu. What
  // separates them is the model NUMBER: rename and replace keep it (so placements follow), duplicate mints
  // one, and delete spends one for good.
  {
    const managed = await saveImportedProp('zz-test-manage-prop', record('zz test manage', null, 11));
    written.push(managed.file);
    const id = managed.record.id;

    // RENAME: the label the grid shows and the file it stores under move together; the number does not.
    const renamed = await renameImportedProp(id, 'zz test manage renamed');
    written.push(renamed.file);
    check(renamed.id === id && renamed.name === 'zz test manage renamed',
      'rename keeps the model number, so every placement of it follows the new name');
    check(renamed.file === 'zztestmanagerenamed.json' && existsSync(join(propsDir, renamed.file)),
      `the stored file is renamed to match (${renamed.file})`);
    check(!existsSync(join(propsDir, managed.file)), 'and it left its old file behind');
    check((await listImportedProps()).find(e => e.record.id === id)?.record.name === 'zz test manage renamed',
      'the stored record wears the new name');
    // the file stem plays by the library's naming rules; the display name is free text, because nothing
    // addresses a model by it
    const spaced = await renameImportedProp(id, 'zz test manage renamed');
    check(spaced.file === renamed.file, 'renaming to the name it already has is a no-op, not a collision');

    // a name the library has already spoken for steps aside for the FILE while the label is taken verbatim
    const rival = await saveImportedProp('zz-test-manage-rival', record('zz test rival', null, 12));
    written.push(rival.file);
    const collided = await renameImportedProp(rival.record.id, 'zz test manage renamed');
    written.push(collided.file);
    check(collided.file === 'zztestmanagerenamed_2.json' && collided.name === 'zz test manage renamed',
      `a rename onto a taken stem suffixes the file, not the name (${collided.file})`);
    check((await listImportedProps()).find(e => e.record.id === id)?.record.subs[0].pos
      === managed.record.subs[0].pos, 'the model it collided with is untouched');

    // DUPLICATE: same geometry, its own number — nothing already placed follows the copy.
    const copy = await cloneImportedProp(id, 'zz test manage copy');
    written.push(copy.file);
    check(copy.id !== id, `the copy gets its own model number (${id} → ${copy.id})`);
    const copies = await listImportedProps();
    check(copies.find(e => e.record.id === copy.id)?.record.subs[0].pos === managed.record.subs[0].pos,
      'the copy carries the geometry');
    check(!!copies.find(e => e.record.id === id), 'and the original is still there');

    // REPLACE: new geometry on the SAME number — the answer to "I rebuilt this and it is already placed".
    // A re-import cannot do it (names never overwrite), so this is the deliberate escape hatch.
    const fresh = record('ignored — replace keeps the name', `${CUSTOM_TEX_LEVEL}/${tile}`, 99);
    const replaced = await replaceImportedProp(id, fresh);
    check(replaced.id === id && replaced.file === renamed.file,
      'replace writes the same record file under the same model number');
    check(replaced.name === 'zz test manage renamed',
      'the model keeps the name the author gave it — the new file only supplies geometry');
    const afterReplace = (await listImportedProps()).find(e => e.record.id === id)!.record;
    check(afterReplace.subs[0].pos === fresh.subs[0].pos && afterReplace.materials[0].tex
      === `${CUSTOM_TEX_LEVEL}/${tile}`, 'the stored geometry and materials are the new ones');
    check((await listImportedProps()).find(e => e.record.id === copy.id)?.record.subs[0].pos
      === managed.record.subs[0].pos, 'the duplicate made beforehand still holds the geometry it copied');

    // …and a body that did not convert is refused while the original is still on disk. Import can only ever
    // ADD a bad record; replace would write one OVER a model in use, and an unreadable record is skipped by
    // the catalogue — so without this check a malformed replace deletes the model instead of failing.
    let refused = '';
    try {
      await replaceImportedProp(id, { tris: 0, subs: [], materials: [] });
    } catch (e) { refused = String(e); }
    check(/did not convert/.test(refused), 'replace refuses a body with no geometry');
    check((await listImportedProps()).find(e => e.record.id === id)?.record.subs[0].pos === fresh.subs[0].pos,
      'and the model it would have overwritten is untouched');

    // DELETE: the record goes, and BOTH of its identities are spent. The name retires like a tile's
    // (docs/038); the number retires for the same reason one step further in — a placement in another
    // mountain, or in this one's undo stack, must never find someone else's geometry under a number it
    // still holds. `max(existing) + 1` alone would hand the newest record's number straight back.
    const doomed = await saveImportedProp('zz-test-manage-doomed', record('zz test doomed', null, 13));
    written.push(doomed.file);
    check(doomed.record.id > copy.id, 'the doomed record holds the catalogue’s highest number');
    check(await deleteImportedProp(doomed.record.id), 'delete removes the record');
    check(!existsSync(join(propsDir, doomed.file)) && !(await listImportedProps())
      .some(e => e.record.id === doomed.record.id), 'and it leaves the catalogue');
    check(await deleteImportedProp(doomed.record.id) === false,
      'deleting an already-absent model reports false, not an error');
    const successor = await saveImportedProp('zz-test-manage-doomed', record('zz test successor', null, 14));
    written.push(successor.file);
    check(successor.record.id > doomed.record.id,
      `the deleted model number is never reissued (${doomed.record.id} → ${successor.record.id})`);
    check(successor.file === 'zz-test-manage-doomed_2.json',
      `and its file name is retired like any freed name (${successor.file})`);

    // RETEXTURE: the prop inspector's Materials block edits a model the author is already using, so it takes
    // a narrow patch. It must not be able to arrive carrying a mesh, and it must not lose what the record
    // knows and an older tab does not.
    const skinned = await saveImportedProp('zz-test-manage-skin', {
      ...record('zz test skin', 'Custom/a.png', 15),
      materials: [{ id: 0, tex: 'Custom/a.png', scroll: { mode: 0, uPerTick: -0.02, vPerTick: 0,
        activeDuration: 1, pauseDuration: 0, lifetime: 0 } }],
    });
    written.push(skinned.file);
    const skinId = skinned.record.id;
    const reskinned = await updateImportedPropMaterials(skinId, [{ id: 0, tex: 'Custom/b.png' }]);
    check(reskinned.materials[0].tex === 'Custom/b.png' && !!reskinned.materials[0].scroll,
      'a retexture takes the tile it was given and leaves the declared scroll the client never sent');
    const stored = (await listImportedProps()).find(e => e.record.id === skinId)?.record;
    check(stored?.subs[0].pos === skinned.record.subs[0].pos && stored?.tris === 1,
      'and it leaves the geometry alone — a material edit can never arrive carrying a different mesh');

    const flipped2 = await updateImportedPropMaterials(skinId,
      [{ id: 0, tex: 'Custom/b.png', frames: ['ignored', 'Custom/b_f1.png'] }]);
    check(flipped2.materials[0].frames?.join(' ') === 'Custom/b.png Custom/b_f1.png',
      'a state list is re-headed onto the material\'s own tile, whatever the client sent as frame 0');
    const rehead = await updateImportedPropMaterials(skinId,
      [{ id: 0, tex: 'Custom/c.png', frames: ['Custom/b.png', 'Custom/b_f1.png'] }]);
    check(rehead.materials[0].frames?.join(' ') === 'Custom/c.png Custom/b_f1.png',
      'so re-picking the texture re-heads the flipbook rather than stranding one on a tile it no longer rests on');
    check((await updateImportedPropMaterials(skinId, [{ id: 0, tex: 'Custom/c.png', frames: [] }]))
      .materials[0].frames === undefined,
      'clearing the frames drops the flipbook key entirely — a state list of one is a still image');
    check((await updateImportedPropMaterials(skinId, [{ id: 99, tex: 'Custom/zzz.png' }]))
      .materials[0].tex === 'Custom/c.png',
      'a row naming a material the model does not have changes nothing');
    let refusedMaterials = false;
    try { await updateImportedPropMaterials(skinId, { id: 0 } as unknown as []); }
    catch { refusedMaterials = true; }
    check(refusedMaterials, 'a body that is not an array of rows is refused rather than emptying the table');
  }

  // --- the catalogue decodes like any level -------------------------------------------------------
  const payload = await importedPropsPayload();
  check(payload.level === IMPORTED_PROP_LEVEL, `the catalogue answers as the ${IMPORTED_PROP_LEVEL} level`);
  const lp = decodeProps(payload);
  const lamp = lp.models.find(m => m.id === first.id);
  const rock = lp.models.find(m => m.id === second.id);
  check(!!lamp && !!rock, 'every stored record appears as a model');
  check(lamp?.subs[0].positions.length === 9 && lamp.subs[0].indices.length === 3,
    'geometry round-trips through the base64 packing into typed arrays');
  const lampV2 = lp.models.find(m => m.id === again.id);
  check(lamp?.subs[0].positions[2] === 0 && lampV2?.subs[0].positions[2] === 7,
    'each record supplies its own geometry — the second import of that file name left the first alone');

  // Material ids are LOCAL to each record and rebased on assembly — two records both using local id 0 must
  // not collide, or importing one model would repaint another.
  check(lamp!.subs[0].mat !== rock!.subs[0].mat,
    `records sharing a local material id rebase apart (${lamp!.subs[0].mat} vs ${rock!.subs[0].mat})`);
  check(lp.materials.get(lamp!.subs[0].mat)?.tex === `${CUSTOM_TEX_LEVEL}/${tile}`,
    'a model keeps its own tile ref through the rebase');
  check(lp.materials.get(lamp!.subs[0].mat)?.alphaMode === 'cutout',
    'an imported material keeps its explicit alpha mode through the catalogue payload');
  check(lp.materials.get(rock!.subs[0].mat)?.tex === null, 'an untextured material stays untextured');

  const translucent = await saveImportedProp('zz-test-translucent', {
    ...record('zz test translucent', `${CUSTOM_TEX_LEVEL}/${tile}`),
    materials: [{ id: 0, tex: `${CUSTOM_TEX_LEVEL}/${tile}`, blend: true }],
  });
  written.push(translucent.file);
  const translucentProps = decodeProps(await importedPropsPayload());
  const translucentModel = translucentProps.models.find(m => m.id === translucent.record.id);
  check(translucentProps.materials.get(translucentModel!.subs[0].mat)?.blend === true,
    'an imported material keeps its alpha-blend flag through the catalogue payload');
  check(translucentProps.materials.get(translucentModel!.subs[0].mat)?.pixelAlpha === true,
    'an imported material asks Slopesmith to classify its decoded alpha pixels');

  // A declared SPIN has to survive the same trip. This is the seam the record and the renderer meet at:
  // the clip and the per-submesh object index are stored, served and decoded by three different modules,
  // and a model whose clip is dropped anywhere along the way renders perfectly and simply never moves —
  // which looks exactly like an authoring mistake and is the reason this is asserted end to end.
  const turning = await saveImportedProp('zz-test-spin', {
    ...record('zz test spin', null),
    subs: [{ ...record('zz test spin', null).subs[0], object: 2 }],
    animation: importedSpinAnimation([{ pivot: [0, 0, 100], axis: [0, 0, 1], revsPerSecond: 1 }])!.animation,
  });
  written.push(turning.file);
  const spinLp = decodeProps(await importedPropsPayload());
  const spinModel = spinLp.models.find(m => m.id === turning.record.id);
  check(spinModel?.animation?.objects.length === 3 && spinModel.animation.clipFrames === 30,
    'a declared spin reaches the viewport as a PropModelAnimation, mount and all');
  check(spinModel?.subs[0].object === 2,
    'the submesh keeps the object index that says WHICH part of the clip moves it');
  check(!!spinModel?.animation?.objects[2].channels?.[4]?.length,
    'the turning object still carries its rotation channel after the payload round trip');

  // …and it has to survive REGISTRATION, which is a second path. Imported props are a LIVE pseudo-level —
  // their definitions change under a stable model number — so they go through syncLiveModels rather than
  // registerPropModels, and a clip wired into only one of the two is a model that renders perfectly, opens
  // an anim-object node in Effects, and never moves.
  const assets = createPropAssets();
  assets.syncLiveModels(spinLp);
  const liveKey = `${IMPORTED_PROP_LEVEL}:${turning.record.id}`;
  check(assets.propClips.get(liveKey) === spinModel?.animation,
    'syncLiveModels registers the clip, not just the geometry');
  check(assets.propGeom.get(liveKey)?.[0].object === 2,
    'the registered submesh keeps its object index, so the delta reaches the right vertices');
  // The signature that decides whether a re-import re-registers has to notice a clip-only change: retiming
  // a spin moves no vertex, so a geometry-only hash would keep serving the clip it first saw.
  const retimed = { ...spinLp, models: spinLp.models.map(m => (m.id === turning.record.id
    ? { ...m, animation: importedSpinAnimation([{ pivot: [0, 0, 100], axis: [0, 0, 1], revsPerSecond: 2 }])!.animation }
    : m)) };
  assets.syncLiveModels(retimed);
  check(assets.propClips.get(liveKey)?.clipFrames === 15,
    're-importing with only the rate changed re-registers rather than keeping the stale clip');

  // The Effects inspector's clip timeline holds a placement at one frame while the author scrubs it. That
  // hold has to outrank every player: a scrub the ambient loop keeps advancing past is a slider that snaps
  // back, which reads as a broken control rather than as a held pose.
  assets.syncLiveModels(spinLp);
  const stage = {
    worldRoot: new THREE.Group(), scene: new THREE.Scene(), gizmo: { dragging: false }, gizmoKind: null,
    snapDataPoint: (point: unknown) => point, attachGizmo() {}, detachGizmo() {}, cb: {},
  };
  const layer = createPropsLayer(stage as never, assets,
    { authoredRigData: null, authoredLightsVisible: false, authoredLights: [] } as never);
  const effects = createEmptyEffectsDocument('scrub');
  attachModelEffectsToProp(effects, 'prop-spin', { clip: true });
  // U1/U2 are the clip WINDOW in frames, and negative means "the whole clip" — the value 40 of retail's 43
  // anim nodes carry. A zero-length (0, 0) window plays nothing on hardware, and the editor's own playback
  // repairs it silently (createAnimObjectPlayback snaps endFrame to the clip end), so the prop animates in
  // Preview and stands still in a repacked ISO. The window has to be right in the DOCUMENT.
  const clipNode = effects.graphs.flatMap(g => g.nodes)
    .find(n => (n.payload.type0 as { SubType?: number } | undefined)?.SubType === 256);
  const window = (clipNode?.payload.type0 as { type0Sub256?: Record<string, number> } | undefined)?.type0Sub256;
  check(window?.U1 === -1 && window?.U2 === -1,
    'the auto-attached model clip asks for the WHOLE clip, not a zero-length window');
  for (const template of EFFECT_TEMPLATES) for (const source of template.nodes ?? []) {
    const t0 = source.payload?.type0 as { SubType?: number; type0Sub256?: Record<string, number> } | undefined;
    if (t0?.SubType !== 256) continue;
    check(!(t0.type0Sub256?.U1 === 0 && t0.type0Sub256?.U2 === 0),
      `the "${template.label}" template ships a playable clip window`);
  }
  layer.setPlacedProps([{ id: 'prop-spin', level: IMPORTED_PROP_LEVEL, model: turning.record.id,
    name: 'zz test spin', pos: [0, 0, 0], yaw: 0, scale: 1 }] as never, effects as never);
  check(layer.propAnimObjectClip('prop-spin')?.clipFrames === 30,
    'a placement of a model with a clip exposes it to the inspector');

  layer.setWorldEffectsEnabled(true);
  check(layer.setPropAnimObjectScrubFrame('prop-spin', 7) === true,
    'the timeline can hold an authored placement at a frame');
  const held = layer.placedPropMeshes[0]!.clone(true);
  layer.stepWorldEffects(0.5);
  const after = layer.placedPropMeshes[0]!;
  const poseOf = (root: THREE.Object3D) => {
    const out: number[] = [];
    root.traverse(o => { if ((o as THREE.Mesh).isMesh) out.push(...o.matrix.elements); });
    return out;
  };
  check(poseOf(held).join() === poseOf(after).join(),
    'a half second of world effects does not advance a held pose');
  check(layer.setPropAnimObjectScrubFrame('prop-spin', null) === true,
    'releasing the hold is accepted');
  layer.stepWorldEffects(0.5);
  check(poseOf(held).join() !== poseOf(layer.placedPropMeshes[0]!).join(),
    '…and the ambient player takes the clip back over once released');
  check(layer.setPropAnimObjectScrubFrame('prop-nonexistent', 3) === false,
    'a placement with no clip reports no timeline rather than pretending to hold one');

  // --- cross-level tile refs ----------------------------------------------------------------------
  // How an imported model's art reaches the mountain-local Custom bank: the ref names its own level, and that wins
  // over the model's. A bare name (every extracted level's case) still resolves against the model's level.
  const cross = resolvePropTex(IMPORTED_PROP_LEVEL, `${CUSTOM_TEX_LEVEL}/${tile}`);
  check(cross.level === CUSTOM_TEX_LEVEL && cross.name === tile,
    'a "LEVEL/file.png" ref resolves to that level’s bank, not the model’s');
  const bare = resolvePropTex('DONOR', '0106.png');
  check(bare.level === 'DONOR' && bare.name === '0106.png', 'a bare tile name stays in the model’s own level');
  check(resolvePropTex('DONOR', null).name === null, 'a material with no tile resolves to no texture');

  // --- the cap ------------------------------------------------------------------------------------
  // Grounded against the retail census in docs/028 (648 GARI models ≈ 225k triangles): the cap has to sit
  // well above a shipped prop's ~350 while still refusing scan-sized geometry.
  check(MAX_IMPORT_TRIS > 10_000 && MAX_IMPORT_TRIS <= 100_000,
    `the import triangle cap is generous but bounded (${MAX_IMPORT_TRIS.toLocaleString()})`);

  // --- the export bake ----------------------------------------------------------------------------
  // A textured copy keeps the Node-only material regression independent of the earlier headless viewport
  // checks (which intentionally use an untextured model and therefore do not need a browser ImageLoader).
  const turningTextured = await saveImportedProp('zz-test-spin-textured', {
    ...record('zz test spin', `${CUSTOM_TEX_LEVEL}/${tile}`),
    subs: [{ ...record('zz test spin', `${CUSTOM_TEX_LEVEL}/${tile}`).subs[0], object: 2 }],
    animation: turning.record.animation,
  });
  written.push(turningTextured.file);
  // Four placements: one plain (ghost), one solid, one carrying a clip, one pointing at a record that no
  // longer exists.
  const mountain = migrateMountain(JSON.parse(JSON.stringify(defaultMountain())));
  mountain.props = [
    // identity pose on purpose — see the verbatim check below
    { level: IMPORTED_PROP_LEVEL, model: first.id, name: 'zz test lamp', pos: [0, 0, 0], yaw: 0, scale: 1 },
    { level: IMPORTED_PROP_LEVEL, model: second.id, name: 'zz test rock', pos: [5, 1, 5], yaw: 90, scale: 2, solid: true },
    { level: IMPORTED_PROP_LEVEL, model: 9999, name: 'zz deleted thing', pos: [1, 1, 1], yaw: 0, scale: 1 },
    { level: IMPORTED_PROP_LEVEL, model: turningTextured.record.id, name: 'zz test spin',
      pos: [-3, 2, 8], yaw: 145, scale: 0.75 },
  ];
  ensurePlacedPropIds(mountain.props);
  const exportEffects = createEmptyEffectsDocument('zz imported export');
  attachModelEffectsToProp(exportEffects, mountain.props[3].id!, { clip: true });
  mountain.effects = exportEffects;
  const outDir = mkdtempSync(join(tmpdir(), 'slopesmith-import-export-'));
  try {
    const res = await exportLevel(mountain, { outDir, lighting: false });
    const log = res.log ?? '';
    const obj = readFileSync(join(outDir, 'Props.obj'), 'utf8');

    check(/baked 3 imported GLB placement\(s\)/.test(log), 'the export bakes imported placements');
    const lampObject = /^o inst\d+_Import_0_zztestlamp/m.exec(obj);
    check(!!lampObject, 'a ghost placement bakes under the canonical instance/Import_ join');

    // The prefix IS the authoring contract: canonical export keys collision off it, so a
    // renamed prefix silently turns every solid imported prop back into a ride-through ghost.
    check(/^o inst\d+_ImportSolid_1_zztestrock/m.test(obj),
      'a placement with solid:true bakes under the canonical instance/ImportSolid_ join');
    check(!/^o inst\d+_ImportSolid_0_/m.test(obj), 'a placement without the toggle stays a ghost');

    // An IDENTITY placement must bake the record's raw coordinates verbatim: the client renders the model
    // through RAW_TO_EDITOR and the bake undoes exactly that map, so any drift here means the two halves of
    // the round trip have diverged and every imported prop ships displaced from where it was placed.
    const lampBlock = obj.slice(lampObject?.index ?? 0);
    const lampVerts = lampBlock.split('\n').filter(l => l.startsWith('v ')).slice(0, 3);
    check(lampVerts[0] === 'v 0.000 0.000 0.000' && lampVerts[1] === 'v 100.000 0.000 0.000'
      && lampVerts[2] === 'v 0.000 100.000 0.000',
      `an identity placement bakes the stored raw verts verbatim (${lampVerts[1] ?? 'none'})`);

    // The tile has to reach Textures/ as real bytes. The material entry alone passing proves nothing: an
    // absent page makes the material fall back to slot 0000 in-game — a silently wrong texture.
    const mats = JSON.parse(readFileSync(join(outDir, 'Materials.json'), 'utf8')) as
      { Materials: { TexturePath: string }[] };
    const dest = `p_${CUSTOM_TEX_LEVEL}_${tile}`;
    check(mats.Materials.some(m => m.TexturePath === dest),
      'the imported model’s Custom tile takes a slot in the combined material table');
    check(existsSync(join(outDir, 'Textures', dest)),
      `the tile bytes are copied into the export’s Textures/ (${dest})`);
    const alphaOverrides = JSON.parse(readFileSync(join(outDir, 'TextureAlpha.overrides.json'), 'utf8')) as
      Record<string, string>;
    check(alphaOverrides[dest] === 'cutout',
      'the imported GLB alpha mode ships beside its renamed texture instead of being re-guessed at repack time');
    check(/usemtl mat_\d+/.test(lampBlock),
      'the baked submesh references that slot rather than mat_untextured');

    // A record deleted off disk while its placements stayed in the document. The prop is still visible in
    // the editor, so silence would ship a level missing something the user can still see.
    check(/WARN: 1 imported model\(s\) placed in the document are no longer in the Custom catalogue/.test(log),
      'a placement whose record was deleted warns instead of vanishing');
    check(log.includes('zz deleted thing'), 'that warning names the model, so it is actionable');
    check(existsSync(join(outDir, 'Patches.json')),
      'the rest of the export still completes alongside a missing record');

    // Per-model log lines: the aggregate "baked N placements" hides WHICH import is the heavy one, and
    // "where did the space go" is answered by placements × per-copy triangles, model by model.
    check(/imported "zz test lamp": 1 × 1 tris/.test(log),
      'the export log names each imported model with its placement count and tris');

    // --- the clip join the ISO packer reads ------------------------------------------------------
    // The placement's motion reaches Snowknife through Effects.json rather than the OBJ, joined to the
    // baked group by the same stable id every other authored attachment uses.
    const fxDoc = JSON.parse(readFileSync(join(outDir, 'Effects.json'), 'utf8')) as
      { extensions?: { slopesmith?: { propClips?: Record<string, BakedPropClip>;
        bakedGroups?: Record<string, string[]> } } };
    const ext = fxDoc.extensions?.slopesmith;
    const spinId = mountain.props[3].id!;
    const shippedClip = ext?.propClips?.[spinId];
    check(shippedClip?.objects.length === 3 && shippedClip.clipFrames === 30,
      'a placement of a model with a clip ships that clip’s whole hierarchy in propClips');
    check(ext?.bakedGroups?.[spinId]?.[0] === 'Import_3_zztestspin',
      'and the join names the group it baked as, which is what the packer keys the clip off');
    check(/model clips: 1 placement\(s\) \/ 1 moving object\(s\)/.test(log),
      'the export log reports the clip it shipped');

    const nativeModels = JSON.parse(readFileSync(join(outDir, 'Models.json'), 'utf8')) as { Models: {
      ModelName: string; AnimTime: number; ModelObjects: {
        Animation?: { AnimationAction?: number; AnimationEntries?: unknown[] };
        MeshData?: { MaterialID: number }[];
      }[];
    }[] };
    const nativeSpin = nativeModels.Models.find(model => model.ModelName === 'Import_3_zztestspin');
    check(nativeSpin?.AnimTime === 30 && nativeSpin.ModelObjects.length === 3
      && (nativeSpin.ModelObjects[2].Animation?.AnimationAction ?? 0) !== 0
      && !!nativeSpin.ModelObjects[2].Animation?.AnimationEntries?.length,
    'the same export directly packs the imported hierarchy and motion into canonical Models.json');

    // Bundle regressions found with the pirate ship and Scrambler: the split GLB segment asks for the BASE
    // material slot even though Props.obj keeps an `_objN` alias, and a static hierarchy mount needs its exact
    // quaternion independently of the animated Euler tuple.
    const bundle = bakeGltf(outDir, 'ZZIMPORT');
    check(bundle?.status === 0, 'an authored model clip completes the real Snowknife Unity bundle bake');
    const manifest = bundle?.status === 0
      ? JSON.parse(readFileSync(join(outDir, 'gltf', 'manifest.json'), 'utf8')) : {};
    const bundledSpin = manifest.Props?.Animated?.find((item: { Name?: string }) => item.Name === 'Import_3_zztestspin');
    const spinMaterial = nativeSpin?.ModelObjects[2].MeshData?.[0]?.MaterialID;
    check(spinMaterial !== undefined && manifest.Materials?.some((item: { Name?: string; Texture?: string }) =>
      item.Name === `mat_${spinMaterial}` && item.Texture === dest),
    'the animated GLB base material slot resolves its authored PNG instead of importing white');
    const mountRotation = bundledSpin?.Segments?.[1]?.RestRotation;
    check(Array.isArray(mountRotation) && mountRotation.length === 4
      && Math.abs(mountRotation[3] - 1) > 1e-4,
    'the animated bundle preserves an unanimated mount\'s exact rest quaternion');

    // The pose is the whole reason the packer can put a MODEL-space clip into an INSTANCE's frame, so it
    // has to be the very map the vertices took. Replay it over the record's own raw verts and compare
    // against the `v` lines that placement actually baked: a pose that drifts from the geometry is a part
    // that animates correctly around a pivot the machine is not standing on.
    const spinObject = /^o inst\d+_Import_3_zztestspin/m.exec(obj);
    const spinBlock = obj.slice(spinObject?.index ?? 0);
    check(/usemtl mat_(?:\d+|untextured)_obj2/.test(spinBlock),
      'the moving submesh carries the _obj tag naming which clip object owns it');
    const spinVerts = spinBlock.split('\n').filter(l => l.startsWith('v ')).slice(0, 3)
      .map(l => l.split(' ').slice(1).map(Number));
    const poseOrigin = new THREE.Vector3(...(shippedClip!.pose.origin as [number, number, number]));
    const poseRot = new THREE.Quaternion(...(shippedClip!.pose.rotation as [number, number, number, number]));
    const replay = ([x, y, z]: number[]) => new THREE.Vector3(x, y, z)
      .multiplyScalar(shippedClip!.pose.scale).applyQuaternion(poseRot).add(poseOrigin);
    const modelVerts = [[0, 0, 0], [100, 0, 0], [0, 100, 0]];   // the record's own triangle, raw cm
    const poseDrift = Math.max(...modelVerts.map((v, i) =>
      replay(v).distanceTo(new THREE.Vector3(spinVerts[i][0], spinVerts[i][1], spinVerts[i][2]))));
    check(poseDrift < 1e-3,
      `the shipped pose reproduces the baked vertices exactly (worst ${poseDrift.toFixed(6)} cm)`);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }

  // --- the exporter's imported-model summary --------------------------------------------------------
  // The preflight previously listed only these models' TEXTURE pages ("(imported)" rows), so a generated
  // prop read as an anonymous texture and its geometry did not appear at all. The summary names the
  // MODELS — per-copy tris, placement counts, tile refs — and a deleted record surfaces as a flagged row.
  {
    const pf = await preflightFor(mountain);
    const rows = pf.importedModels ?? [];
    const lampRow = rows.find(m => m.name === first.name);
    check(!!lampRow && lampRow.placements === 1 && lampRow.tris === first.tris,
      'the preflight lists a placed imported model with its per-copy tris');
    check(!!lampRow && lampRow.pages.length === 1 && lampRow.pages[0].includes(tile),
      'the model row carries its Custom tile refs for the page cross-reference');
    check(rows.find(m => m.name === second.name)?.pages.length === 0,
      'an untextured model carries no page refs');
    const gone = rows.find(m => m.missing);
    check(!!gone && gone.placements === 1,
      'a placement whose record is gone appears as a flagged row rather than disappearing');
  }

  // --- the editor's in-game shading preview --------------------------------------------------------
  // Prop meshes are double-sided (arbitrary art, back faces have to draw) and three.js NEGATES the shading
  // normal on a back face — so a mesh wound inside-out is lit exactly as if it were wound correctly, and the
  // editor cannot show what the hardware will do (`ambient + Σ max(0, N·L)·key` against the stored normal:
  // ambient-only, the MOUNTAIN39 lollipop). Suppressing that flip anchors on two three.js SOURCE strings, so
  // an upgrade that renames either would revert prop shading silently, with nothing to see but the preview
  // quietly lying again.
  check(ps2NormalShaderApplies(),
    'the in-game prop shading rewrite still matches three.js\'s shader source');
  check(ps2ObjectNormalVertexShaderApplies(),
    'the native-light shader still receives each model-local stored normal');

  // The preview's per-prop key rides the same kind of anchor. A three.js upgrade that renamed it would
  // flatten every prop back to one uniform key — which looks entirely plausible on screen, and is exactly
  // the thing this preview exists to rule out.
  check(propKeyScaleShaderApplies(),
    'the per-prop key-scale rewrite still matches three.js\'s shader source');
  // …and it must scale the KEY only. Lambert folds `material.color` into ambient as well, so tinting would
  // over-darken a prop in shade — the one case the preview is for (docs/032 · lighting).
  {
    const patched = propKeyScaleShader('#include <lights_fragment_begin>\nvoid main() {}');
    const keyCut = patched.indexOf('directLight.color *= mix( 1.0, uKeyScale, uPs2Normals );');
    const fillCut = patched.indexOf('irradiance *= mix( 1.0, uFillScale, uPs2Normals );');
    check(keyCut > 0 && fillCut > keyCut,
      'the native key and ambient scales land on their separate Lambert terms');
  }

  // --- the ground-light sampler --------------------------------------------------------------------
  // One sampler serves both the export bake and the editor preview, because "preview it, ship it, it looks
  // the same" is only true if there is a single field to read (docs/032 · lighting). These pin the two
  // behaviours the callers depend on.
  {
    // two sheets of ground sharing an XZ — a tunnel: floor at y=0 (bright), roof at y=20 (dark)
    const positions = new Float32Array([0, 0, 0, /**/ 0, 20, 0]);
    const colored = new Float32Array([0.9, 0.9, 0.9, /**/ 0.1, 0.1, 0.1]);
    const sample = groundLightSampler(positions, colored);
    check(Math.abs(sample([0, 1, 0]) - 0.9) < 1e-6,
      `a prop on the tunnel FLOOR reads the floor (${sample([0, 1, 0]).toFixed(2)})`);
    check(Math.abs(sample([0, 19, 0]) - 0.1) < 1e-6,
      `…and one up at the roof reads the roof, so nearest-in-3D is doing the work, not nearest-in-XZ `
      + `(${sample([0, 19, 0]).toFixed(2)})`);
    // A_S is the peak channel, exactly what encodeLightmapTexel writes — not the mean, which would read a
    // tinted shadow as darker than the lightmap it ships in.
    const tinted = groundLightSampler(new Float32Array([0, 0, 0]), new Float32Array([0.2, 0.4, 0.8]));
    check(Math.abs(tinted([0, 0, 0]) - 0.8) < 1e-6,
      `ground light is the PEAK channel, as the lightmap encodes it (${tinted([0, 0, 0]).toFixed(2)})`);
    check(sample([500, 0, 500]) === 1,
      'a prop off the quilt reads as fully lit rather than pitch dark');
  }

  // --- per-instance prop lighting ------------------------------------------------------------------
  // Props are lit from data on their own INSTANCE, not the terrain lightmap or the PBD light list, so the
  // export has to author those values — otherwise the packer's cloned donor decides how every authored prop
  // looks and the mountain's own sun never reaches them.
  const textureTrue = PROP_LAMBERT_IRRADIANCE; // Three's Lambert BRDF divides this by PI
  check(PROP_FULL_BRIGHT_FACTOR === 2
      && PROP_FULL_BRIGHT_RECORD === 256
      && Math.abs(propPreviewIntensity(PROP_FULL_BRIGHT_FACTOR) - textureTrue) < 1e-9,
    'the prop preview maps retail full-bright factor 2 / instance ambient 256 to texture-true');
  const defaultPreview = propPreviewIntensity(1) + propPreviewIntensity(0.3);
  check(Math.abs(defaultPreview / textureTrue - 0.65) < 1e-9,
    `the default 1.0 sun + 0.3 ambient previews at its packed 65%, without auto-exposure `
    + `(${(100 * defaultPreview / textureTrue).toFixed(1)}%)`);
  const gariPreview = propPreviewIntensity(2.47) + propPreviewIntensity(0.678);
  check(gariPreview > textureTrue,
    `an HDR retail-seeded sun stays above texture-true instead of being normalised away `
    + `(${(gariPreview / textureTrue).toFixed(2)}x)`);
  check(ps2ColorModulationShaderApplies(),
    'the prop shader applies PS2 byte/sRGB modulation with or without a native instance-colour channel');
  const lookupColor = propLightIndexColor(0x563412);
  check(Math.round(lookupColor.r * 255) === 0x12 && Math.round(lookupColor.g * 255) === 0x34
      && Math.round(lookupColor.b * 255) === 0x56,
    'the per-instance RGB channel losslessly carries the 24-bit native light-table index');
  const gnomonAmbientBlue = propRecordScreenFactor(37.14, 112.439, 0);
  const gnomonTopBlue = propRecordScreenFactor(37.14, 112.439, 0.839);
  check(Math.abs(gnomonAmbientBlue - 37.14 / 256) < 1e-9
      && gnomonTopBlue > 0.51 && gnomonTopBlue < 0.52,
    `the 5o gnomon oracle predicts ambient-only ${(100 * gnomonAmbientBlue).toFixed(1)}% and +Z `
    + `${(100 * gnomonTopBlue).toFixed(1)}% of its self-lit texture`);

  const lit = migrateMountain(JSON.parse(JSON.stringify(defaultMountain())));
  // The DEFAULT authored sun, white-tinted so the checks read channel values directly. This is the case
  // normal maps ship, and the one the first calibration got wrong: it was validated only against a
  // record-seeded sun (GARI's HDR 2.47), where the raw reading happened to land right.
  // Spread DEFAULT_SUN, not defaultMountain().sun — a fresh doc carries no sun at all and the export falls
  // back to the default, so spreading the absent one silently drops el/az and authors a NaN light vector.
  // GARI's OWN sun record (2.47), because that is the case with a measured ground truth: the brightest
  // instance key in a shipped level is exactly its sun record x 128, so a fully-lit prop here must be
  // 316.16 — the very number GARI's instances carry, confirmed live in EE RAM.
  lit.sun = { ...DEFAULT_SUN, sun: 2.47, ambient: 0.678, shadow: 0, ao: 0, sunTint: '#ffffff', skyTint: '#ffffff' };
  const litYaw = 73;
  lit.props = [{ level: IMPORTED_PROP_LEVEL, model: first.id, name: 'zz lit', pos: [-182, 200, -260], yaw: litYaw, scale: 1 }];
  ensurePlacedPropIds(lit.props);
  const litDir = mkdtempSync(join(tmpdir(), 'slopesmith-import-light-'));
  try {
    await exportLevel(lit, { outDir: litDir, lighting: true });
    const fx = JSON.parse(readFileSync(join(litDir, 'Effects.json'), 'utf8')) as
      { extensions?: { slopesmith?: { propLighting?: Record<string, { amb: number[]; key: number[]; dir: number[] }> } } };
    const entry = Object.values(fx.extensions?.slopesmith?.propLighting ?? {})[0];
    check(!!entry, 'the export authors per-instance lighting for a placed prop');

    // THE CALIBRATION LOCK — retail's own rule, measured, not fitted: an instance's key is its level's sun
    // record x 128 (GARI 2.470 -> 316.16, ELYSIUM 2.200 -> 281.60, MERQUER 0.629 -> 80.49, MESA 2.230 ->
    // 285.39 — ratio 128.00 to the digit on all four), and its ambient is the ambient record x 128. Both
    // take the RAW record value, not the bake-exposed pair: terrain saturates at the lightmap ceiling while
    // prop light is linear, and `bakeExposure` is what decouples them. Two earlier revisions moved this
    // constant on a single hand-picked number and shipped wrong twice; `tools/reference-study/ref-lighting.ts` measures it
    // against every shipped level, and this asserts the same law on the case with a live ground truth.
    const key = Math.max(...entry!.key), amb = Math.max(...entry!.amb);
    check(Math.abs(key - 2.47 * 128) < 1,
      `a fully-lit prop's key is its sun record x 128, as retail bakes it (${key.toFixed(1)} vs 316.2)`);
    check(Math.abs(amb - 0.678 * 128) < 1,
      `…and its ambient is the ambient record x 128 (${amb.toFixed(1)} vs 86.8)`);

    // The direction is the TOWARD-light vector in raw space — the negation of the propagation vector
    // Lights.json stores. Ship the propagation vector by mistake and every prop lights from underneath.
    check(Math.abs(Math.hypot(...entry!.dir) - 1) < 1e-3, 'the light vector is unit length');
    check(entry!.dir[2] > 0,
      `an above-horizon sun points UP in raw Z (toward-light, not propagation) (${entry!.dir[2].toFixed(3)})`);
    const worldDir = rawSunVector(lit.sun);
    const yaw = (litYaw * Math.PI) / 180, c = Math.cos(yaw), s = Math.sin(yaw);
    const expectedLocal = [c * worldDir[0] - s * worldDir[1],
      s * worldDir[0] + c * worldDir[1], worldDir[2]];
    check(entry!.dir.every((value, index) => Math.abs(value - expectedLocal[index]) < 1e-3),
      `the exported light is inverse-rotated into the prop's local frame at yaw ${litYaw}° `
      + `(local ${entry!.dir.map(value => value.toFixed(3)).join(', ')})`);

    // The ground's own baked light has to reach props, or every prop on the mountain ships equally bright.
    // These two positions differ only in the terrain under them: (150,-100) sits on ground the bake shades
    // down, (350,0) on ground in full sun.
    const shaded = migrateMountain(JSON.parse(JSON.stringify(defaultMountain())));
    shaded.props = [
      { level: IMPORTED_PROP_LEVEL, model: first.id, name: 'sunlit', pos: [350, 200, 0], yaw: 0, scale: 1 },
      { level: IMPORTED_PROP_LEVEL, model: first.id, name: 'shaded', pos: [150, 200, -100], yaw: 0, scale: 1 },
      // the same shaded spot, but self-lit: it must come out at retail's flag values regardless
      { level: IMPORTED_PROP_LEVEL, model: first.id, name: 'sign', pos: [150, 200, -100], yaw: 0, scale: 1,
        fullBright: true },
    ];
    ensurePlacedPropIds(shaded.props);
    const shDir = mkdtempSync(join(tmpdir(), 'slopesmith-import-shade-'));
    try {
      await exportLevel(shaded, { outDir: shDir, lighting: true });
      const sfx = JSON.parse(readFileSync(join(shDir, 'Effects.json'), 'utf8')) as
        { extensions: { slopesmith: { propLighting: Record<string, { key: number[]; amb: number[] }> } } };
      const lit = shaded.props.map(p => sfx.extensions.slopesmith.propLighting[p.id!]);
      const [sunlit, shade] = lit.map(e => Math.max(...e.key));
      check(shade < sunlit * 0.95,
        `a prop on shaded ground authors a darker key than one on sunlit ground `
        + `(${shade.toFixed(1)} < ${sunlit.toFixed(1)})`);

      // SELF-LIT is retail's own flag, not a tuned value: no key at all, ambient exactly 256 (2 × the
      // half-bright 128). Measured across every full-bright instance in GARI (112) and MERQUER (544) —
      // min and max both 256, zero spread. A sign face emits, so the shade it stands in must not reach it.
      const sign = lit[2];
      check(Math.max(...sign.key) === 0,
        `a self-lit prop authors NO key (${Math.max(...sign.key)})`);
      check(Math.max(...sign.amb) === 256,
        `…and an ambient of exactly 256, as every shipped full-bright instance carries (${Math.max(...sign.amb)})`);
      check(Math.max(...sign.amb) > Math.max(...lit[1].amb),
        `…so it stays bright on the very ground that dimmed its neighbour `
        + `(${Math.max(...sign.amb)} vs ${Math.max(...lit[1].amb).toFixed(1)})`);
    } finally { rmSync(shDir, { recursive: true, force: true }); }

    // A prop's key comes from the LIGHT ON THE GROUND under it, never from an occlusion query at the prop
    // itself — so how deep its own origin sits cannot darken it. That is measured, not assumed: against
    // retail's shipped instances the ground's baked light predicts the key (GARI r=0.593, monotone over
    // seven bins) while a cast-shadow query at the prop predicts nothing (r=0.003), however it is
    // configured — terrain-only or with 2.4M triangles of props as occluders, probed at the origin or at
    // the standing point. See `propInstanceLight` and `npx tsx tools/reference-study/ref-lighting.ts`.
    //
    // This is the regression that motivated the whole study, from the other side. `pos` is the model's own
    // origin, and placement stores pos.y = terrainY − scale×baseOffset so the model's BOTTOM lands on the
    // ground — so for a model whose geometry sits above its origin (SSX's own trees are +15.4 m), `pos` is
    // metres underground. Reading cast shadow there read it from INSIDE the mountain: MOUNTAIN38 shipped 70
    // of 89 props flagged fully shadowed, at half key, while the ground they stood on was in full sun.
    // Sampling the ground makes that unrepresentable rather than merely fixed — all three of these props
    // stand on the same ground, so all three must light the same, whatever their origins do.
    // (This record's triangle is 530 m above its origin, exactly the open/buried drop.)
    const raised = await saveImportedProp('zz-test-raised', record('zz test raised', null, 53_000));
    written.push(raised.file);
    const seat = migrateMountain(JSON.parse(JSON.stringify(defaultMountain())));
    seat.props = [
      { level: IMPORTED_PROP_LEVEL, model: first.id, name: 'open', pos: [-182, 200, -260], yaw: 0, scale: 1 },
      { level: IMPORTED_PROP_LEVEL, model: first.id, name: 'buried', pos: [-182, -330, -260], yaw: 0, scale: 1 },
      { level: IMPORTED_PROP_LEVEL, model: raised.record.id, name: 'seated', pos: [-182, -330, -260], yaw: 0, scale: 1 },
    ];
    ensurePlacedPropIds(seat.props);
    const seatDir = mkdtempSync(join(tmpdir(), 'slopesmith-import-seat-'));
    try {
      await exportLevel(seat, { outDir: seatDir, lighting: true });
      const efx = JSON.parse(readFileSync(join(seatDir, 'Effects.json'), 'utf8')) as
        { extensions: { slopesmith: { propLighting: Record<string, { key: number[] }> } } };
      const [openP, buriedP, seatedP] = seat.props.map(p =>
        Math.max(...efx.extensions.slopesmith.propLighting[p.id!].key));
      check(Math.abs(seatedP - openP) < openP * 0.05,
        `a prop whose origin is underground is lit where it STANDS (${seatedP.toFixed(1)} ≈ open ${openP.toFixed(1)})`);
      check(Math.abs(buriedP - openP) < openP * 0.05,
        `…and burying the origin cannot darken it — the ground is what lights it `
        + `(buried ${buriedP.toFixed(1)} ≈ open ${openP.toFixed(1)})`);
    } finally { rmSync(seatDir, { recursive: true, force: true }); }

    // Lighting off must ship none of this, so an ISO repack leaves props on the target level's own values —
    // the same contract that leaves the terrain on the target's lightmaps.
    const offDir = mkdtempSync(join(tmpdir(), 'slopesmith-import-nolight-'));
    try {
      await exportLevel(lit, { outDir: offDir, lighting: false });
      const offFx = JSON.parse(readFileSync(join(offDir, 'Effects.json'), 'utf8')) as
        { extensions?: { slopesmith?: { propLighting?: unknown } } };
      check(!offFx.extensions?.slopesmith?.propLighting,
        'an export with lighting off ships no prop lighting (the repack keeps the donor’s)');
    } finally { rmSync(offDir, { recursive: true, force: true }); }
  } finally {
    rmSync(litDir, { recursive: true, force: true });
  }
} finally {
  for (const { file, before } of sidecars) {
    if (before) writeFileSync(file, before); else rmSync(file, { force: true });
  }
  for (const f of new Set(written)) rmSync(join(propsDir, f), { force: true });
  for (const f of new Set(texWritten)) rmSync(join(texDir, f), { force: true });
  if (!hadDirBefore && existsSync(propsDir) && readdirSync(propsDir).length === 0) {
    rmSync(propsDir, { recursive: true, force: true });
  }
  if (!hadTexDirBefore && existsSync(texDir) && readdirSync(texDir).length === 0) {
    rmSync(texDir, { recursive: true, force: true });
  }
  rmSync(assetRoot, { recursive: true, force: true });
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('imported-props: all checks passed');
