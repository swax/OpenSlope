import type { EditDoc } from '../doc/doc-edit';
import type { V3 } from '../doc/types';
import { environmentDocument, normalizeEnvironmentBed } from '../audio/environment';
import {
  authoredPropTextureFlip, authoredPropUvScroll, createEmptyEffectsDocument,
  effectNodeSoundFile, syncAuthoredMotionPathEffectResources,
} from '../effects/authoring';
import { cloneEffectsDocument, type EffectsDocument } from '../effects/document';
import {
  CUSTOM_EFFECT_SOUND_SLOTS, CUSTOM_SOUND_EVENT_POOL, registerCollisionSoundIndex, resolveCollisionSound,
} from '../effects/collision-sound';
import {
  AUTHORED_AMBIENT_DEFAULT_M, HIT_GATED_EVENT_POOL, hitGatedEventForFile, resolveExternalSound,
} from '../effects/external-sound';
import { isEffectTriggerProp } from '../effects/trigger-volume';
import { authoredSignLights, authoredFreeLights, type LocalBox } from '../lighting/sign-lights';
import { authoredGroupLights, expandGroupProps } from '../reference/groups';
import { decodeProps } from '../reference/props';
import { AUTHORED_MODEL_LEVEL, modelNumber } from '../doc/models';
import { IMPORTED_PROP_LEVEL } from '../props/imported';
import { placedPropSolid } from '../props/contact';
import { particleDonorLevel } from '../particles/volumes';
import { buildLevelFiles, toRaw } from './level';
import { buildMaterialCombiner } from './materials';
import {
  bakeAuthoredModelProps, bakeEffectTriggerProps, bakeGemModels, bakeImportedProps, bakePlacedProps,
  bakeRailTubes, modelGeometryBox, placementMatrix, placementSimilarity, rawInstanceQuat,
  type BakedGroups, type BakedPropClips, type BakedPropGroup, type BakedPropPose,
} from './props';
import { buildCanonicalProps, type NativeCollisionExport } from './canonical-props';
import { discRecipeFiles } from './disc';
import { DEFAULT_LAPS } from '../doc/race';
import {
  classifyExportProvenance, SLOPESMITH_EXPORT_MANIFEST,
  type SlopesmithExportManifest, type SlopesmithTextureSource,
} from './manifest';
import { authoredOrigin, MAP_ORIGIN_FILE } from './origin';
import { textFile, type ExportFile, type ExportFolder } from './files';
import type { ExportProvider, ModelRef, NativeArt } from './provider';

/**
 * What a custom WAV is being staged FOR. The same file in both roles is two different encodings of one set
 * of samples — an emitter's bank slot carries a loop region and an impact's does not — so it is two reserved
 * events and two slots, not one shared between them.
 */
type CustomSoundRole = 'hit' | 'emitter';

/** The folder an authored level ships as, and the name it ships under. */
export interface ExportFolderOptions {
  /** Bake terrain lightmaps + write Lights.json (default true). Off ships no lighting, so an ISO repack keeps
   *  the target level's original lights verbatim. */
  lighting?: boolean;
  /** Add seeded lateral variation to the six gate-anchored race routes (default false). */
  aiPaths?: boolean;
}

/** The folder name a document exports under: its own name in the extracted-data alphabet, upper-cased. */
export function exportFolderName(doc: EditDoc): string {
  return (doc.name || 'SLOPE01').replace(/[^A-Za-z0-9_-]/g, '').toUpperCase() || 'SLOPE01';
}

/**
 * Compose the authored level folder: every file it contains, what it clears first, and the export report.
 *
 * One export form, against no particular target: every painted tile ships flattened and verbatim
 * (`Textures/GARI_0012.png`, referenced as `"GARI_0012.png"`), and `Slopesmith.json` records the
 * `{level, name, staged}` each one came from. That provenance is what lets `snowknife repack` decide per
 * page whether to reuse the target's own SSH entry, install a donor level's page, or encode a custom one —
 * so the disc is built by the tool that holds the slot table, from the same folder Unity consumes, and the
 * folder carries the invocation that does it (`discRecipeFiles`).
 *
 * `buildLevelFiles` turns the document into terrain, paths, splines, gems, effects, lights and lightmaps with
 * nothing outside itself. Everything around it — prop bakes, texture copies, sound staging, the sky ring, the
 * race track — needs bytes, and those arrive through `provider`, so this composition is the same whether it
 * runs on the server or in the browser.
 */
export async function buildExportFolder(doc: EditDoc, provider: ExportProvider,
  opts?: ExportFolderOptions): Promise<ExportFolder> {
  const name = exportFolderName(doc);
  const remove: string[] = [];
  const out: ExportFile[] = [];
  const logLines: string[] = [];

  // Audio event ids become bank slots only through the user's extracted executable. Prime the resolver from
  // each retail source level (or any installed map for an authored/imported-only document) before allocating
  // custom events or staging native clips.
  const audioLevels = [...new Set((doc.props ?? []).map(prop => prop.level)
    .filter(level => level && !level.startsWith('@')))];
  const soundIndexes = audioLevels.length
    ? await Promise.all(audioLevels.map(level => provider.soundIndex(level)))
    : [await provider.soundIndex()];
  for (const index of soundIndexes) registerCollisionSoundIndex(index);

  // group placements (docs/015): re-mine their source levels' defs (cached) so each placement expands into
  // its member models + light members — the same defs the editor placed with, reproducible from level data
  const defIdx = await provider.groupDefs([...new Set((doc.props ?? []).filter(p => p.group).map(p => p.level))]);

  // Every model the document places, plus every group member any placement expands into. The geometry is
  // fetched once, together, and answered as a synchronous lookup: the sign-light boxes and the prop bakes
  // both read it from inside plain loops, so neither can reach back out for a byte mid-emission.
  const modelKeys = new Map<string, ModelRef>();
  const wantModel = (level: string, model: number) => modelKeys.set(`${level}:${model}`, { level, model });
  for (const p of doc.props ?? []) {
    wantModel(p.level, p.model);
    const def = p.group ? defIdx.get(`${p.level}:${p.group}`) : undefined;
    for (const m of def?.props ?? []) wantModel(p.level, m.model);
  }
  const geometryOf = await provider.modelGeometry([...modelKeys.values()]);

  // Derive a sign light per placed billboard from its model's bbox — folded into the terrain lightmap bake
  // and written into Lights.json by buildLevelFiles (docs/013).
  const boxCache = new Map<string, LocalBox | null>(
    [...modelKeys].map(([key, ref]) => [key, modelGeometryBox(geometryOf(ref.level, ref.model))]));
  const boxOf = (level: string, model: number) => boxCache.get(`${level}:${model}`) ?? null;

  const signLights = authoredSignLights(doc.props, boxOf);
  const freeLights = authoredFreeLights(doc.lights);
  const groupLights = authoredGroupLights(doc.props, pp => defIdx.get(`${pp.level}:${pp.group}`) ?? null);
  const lights = [...signLights, ...freeLights, ...groupLights];

  // The imported catalogue is read at most once per export, and only when the document actually places an
  // imported model, so an ordinary map never opens the Custom catalogue at all.
  let catalogue: ReturnType<typeof decodeProps> | null | undefined;
  const importedCatalogue = async () => {
    if (catalogue === undefined) catalogue = decodeProps(await provider.importedProps());
    return catalogue!;
  };

  // A placement's seating offset — how far its lowest point sits above `pos`, editor metres, UNSCALED. The
  // twin of the app's `placedBaseOffset` (app/props/operations.ts), needed because the per-prop lighting
  // probe belongs where the prop STANDS and `pos` is the model's origin (docs/032 · lighting). Each of the
  // three prop kinds keeps its own geometry, so each measures its own lowest point.
  const authoredByNumber = new Map((doc.models ?? []).map(m => [modelNumber(m.id), m]));
  const baseOffsets = new Map<string, number>();
  const imported = (doc.props ?? []).some(p => p.level === IMPORTED_PROP_LEVEL)
    ? await importedCatalogue() : null;
  const modelBaseOffset = (level: string, model: number): number => {
    const key = `${level}:${model}`;
    const hit = baseOffsets.get(key);
    if (hit !== undefined) return hit;
    let off = 0, min = Infinity;
    if (level === AUTHORED_MODEL_LEVEL) {
      // authored quad cages carry EDITOR-space vertices (metres, Y-up) around an explicit anchor
      const m = authoredByNumber.get(model);
      for (let k = 1; k < (m?.vertices.length ?? 0); k += 3) if (m!.vertices[k] < min) min = m!.vertices[k];
      if (Number.isFinite(min)) off = min - m!.anchor[1];
    } else if (level === IMPORTED_PROP_LEVEL) {
      const m = imported?.models.find(mo => mo.id === model);
      for (const s of m?.subs ?? []) for (let k = 2; k < s.positions.length; k += 3) if (s.positions[k] < min) min = s.positions[k];
      if (Number.isFinite(min)) off = min / 100; // raw cm, Z-up
    } else {
      const box = boxOf(level, model); // source-level model, raw cm from its own geometry
      if (box) off = box.min[2] / 100;
    }
    baseOffsets.set(key, off);
    return off;
  };
  // a group seats on its LOWEST member (the assembly's base), exactly as the editor placed it
  const placedBaseOffset = (pp: { level: string; model: number; group?: string }): number => {
    const def = pp.group ? defIdx.get(`${pp.level}:${pp.group}`) : undefined;
    if (!def) return modelBaseOffset(pp.level, pp.model);
    let min = Infinity;
    for (const m of def.props) min = Math.min(min, modelBaseOffset(pp.level, m.model) + m.relPos[1]);
    return Number.isFinite(min) ? min : 0;
  };

  // Effects.json's path resources are a stable-ID view over live motion paths. Refresh a clone at the export
  // boundary so a route edited immediately before export cannot carry a stale native spline-table index.
  const exportDoc: EditDoc = doc.effects ? { ...doc, effects: cloneEffectsDocument(doc.effects) } : doc;
  if (exportDoc.effects) syncAuthoredMotionPathEffectResources(exportDoc.effects, exportDoc.rails);
  const files = buildLevelFiles(exportDoc, lights,
    { lighting: opts?.lighting, aiPaths: opts?.aiPaths, propBaseOffset: placedBaseOffset });
  const propGroups: BakedPropGroup[] = [...files.propGroups];

  if (opts?.lighting === false) logLines.push('lighting OFF (export setting): no Lights.json / Lightmaps/ — an ISO repack keeps the target level\'s original lighting verbatim');
  else if (lights.length) logLines.push(`authored lighting: ${signLights.length} billboard sign light(s) + ${freeLights.length} free light(s) + ${groupLights.length} group light(s) → Lights.json + baked terrain glow`);
  if (opts?.aiPaths) logLines.push('AI path variation ON: six gate-anchored race routes carry seeded lateral variation');
  else logLines.push('AI path variation OFF: six required gate-to-center race routes still ship in AIP.json');

  // bake any placed props into Props.obj (appended after the start gate the core emits). Each placed prop
  // imports textured: the appended usemtl mat_<id> slots resolve through a fresh combined Materials.json, and
  // the referenced tiles are copied into Textures/ (docs/012). Rail tubes and the gem tier models bake
  // through the SAME combiner, so all three share one material table.
  const combiner = buildMaterialCombiner(await provider.materialTables());
  const objCounts = () => {
    const obj = files.text['Props.obj'] ?? '';
    return { obj, v: (obj.match(/^v /gm) ?? []).length, vt: (obj.match(/^vt /gm) ?? []).length }; // faces index the combined file
  };
  // authored water flow: a placement with an enabled always-on UV-scroll attachment bakes through the
  // shipped levels' own dialect — a deduped Scroll.json motion table + `mat_<id>_scr<k>` material tags —
  // so the bundle resolves the motion exactly as it does a reference level's river segments (Unity docs/008).
  const scrollSpeeds: {
    U: number; V: number; Mode: number; ActiveDuration: number; PauseDuration: number; Lifetime: number;
  }[] = [];
  const scrollIdxByProp = new Map<string, number>();
  for (const pp of doc.props ?? []) {
    const uv = pp.id && doc.effects ? authoredPropUvScroll(doc.effects, pp.id) : null;
    if (!uv || (uv.uPerTick === 0 && uv.vPerTick === 0)) continue;
    const spec = { U: uv.uPerTick, V: uv.vPerTick, Mode: uv.mode,
      ActiveDuration: uv.activeDuration, PauseDuration: uv.pauseDuration, Lifetime: uv.lifetime };
    let k = scrollSpeeds.findIndex(s => s.U === spec.U && s.V === spec.V && s.Mode === spec.Mode
      && s.ActiveDuration === spec.ActiveDuration && s.PauseDuration === spec.PauseDuration
      && s.Lifetime === spec.Lifetime);
    if (k < 0) { k = scrollSpeeds.length; scrollSpeeds.push(spec); }
    scrollIdxByProp.set(pp.id!, k);
  }
  const scrollIndexOf = (p: { id?: string }) =>
    p.id !== undefined && scrollIdxByProp.has(p.id) ? scrollIdxByProp.get(p.id)! : null;
  // placement stable id → baked `o <group>` names, merged across the prop and authored-model bakes and
  // written into Effects.json extensions.slopesmith.bakedGroups: the join the ISO packer uses to compile an
  // effect attachment onto the packed instance's EffectSlotIndex (docs/026 — the intended P4 contract).
  const bakedGroups: BakedGroups = {};
  const mergeBaked = (groups: BakedGroups) => {
    for (const [id, names] of Object.entries(groups)) (bakedGroups[id] ??= []).push(...names);
  };
  // placement stable id → the object hierarchy its geometry moves under, for the packer to write as native
  // ModelObjects. Only an imported GLB carrying a clip produces one.
  const propClips: BakedPropClips = {};
  // Imported GLB props (docs/032) bake from the Custom catalogue rather than a source level's prop table, so
  // they take their own pass below; everything else goes through the reference-prop bake.
  const refPlacements = (doc.props ?? []).filter(pp => pp.level !== IMPORTED_PROP_LEVEL && !isEffectTriggerProp(pp));
  if (refPlacements.length) {
    // a group placement bakes as its member models at the derived poses — identical-origin instances, the
    // same form the shipped levels author assemblies in (docs/015). Members keep the placement's stable id
    // so an attached effect covers the whole assembly, the same join the viewport renders with.
    const expanded = refPlacements.flatMap(pp => {
      const def = pp.group ? defIdx.get(`${pp.level}:${pp.group}`) : undefined;
      return def ? expandGroupProps(pp, def).map(member => ({ ...member, id: pp.id })) : [pp];
    });
    const { obj: startObj, v, vt } = objCounts();
    const bake = bakePlacedProps(expanded, geometryOf, combiner, v, vt, scrollIndexOf);
    if (bake.obj) {
      files.text['Props.obj'] = startObj + bake.obj;
      propGroups.push(...bake.groups);
      mergeBaked(bake.bakedGroups);
      logLines.push(`baked ${refPlacements.length} placement(s) (${expanded.length} prop mesh(es) incl. group members) into Props.obj`);
    }
  }
  // authored-model placements ('@models'): polygon bakes at their poses, tile through the combiner's tile
  // slot, `_scr` tags for scrolled placements — the same channels a reference-prop placement ships through.
  const customPlacements = (doc.props ?? []).filter(pp => pp.level === AUTHORED_MODEL_LEVEL);
  if (customPlacements.length && doc.models?.length) {
    const { obj: startObj, v, vt } = objCounts();
    const bake = bakeAuthoredModelProps(customPlacements, doc.models, v, vt, combiner, scrollIndexOf);
    if (bake.obj) {
      files.text['Props.obj'] = startObj + bake.obj;
      propGroups.push(...bake.groups);
      mergeBaked(bake.bakedGroups);
      logLines.push(`baked ${bake.baked} authored-model placement(s) into Props.obj`);
      for (const warning of bake.warnings) logLines.push(`WARN: ${warning}`);
    }
  }
  // imported GLB placements ('@import', docs/032): geometry from the Custom catalogue, tiles through the
  // same combiner slot authored models use, so they ship textured like any other prop.
  const importedPlacements = (doc.props ?? []).filter(pp => pp.level === IMPORTED_PROP_LEVEL);
  if (importedPlacements.length) {
    const { obj: startObj, v, vt } = objCounts();
    const importedCat = await importedCatalogue();
    const bake = bakeImportedProps(importedPlacements, importedCat, v, vt, combiner, scrollIndexOf);
    if (bake.obj) {
      files.text['Props.obj'] = startObj + bake.obj;
      propGroups.push(...bake.groups);
      mergeBaked(bake.bakedGroups);
      Object.assign(propClips, bake.propClips);
      logLines.push(`baked ${bake.baked} imported GLB placement(s), `
        + `${bake.tris.toLocaleString()} triangle(s), into Props.obj`);
      // per model, because the aggregate hides which import is the heavy one — geometry bakes once per
      // placement, so the answer to "where did the space go" is placements × per-copy triangles
      const perModel = new Map<number, number>();
      for (const pp of importedPlacements) perModel.set(pp.model, (perModel.get(pp.model) ?? 0) + 1);
      for (const [id, count] of [...perModel].sort((a, b) => a[0] - b[0])) {
        const model = importedCat.models.find(m => m.id === id);
        if (!model) continue;   // the missing-record warning below already names it
        const tris = model.subs.reduce((n, s) => n + s.indices.length / 3, 0);
        logLines.push(`  imported "${model.name}": ${count} × ${tris.toLocaleString()} tris`
          + ` = ${(count * tris).toLocaleString()} baked`);
      }
    }
    for (const warning of bake.warnings) logLines.push(`WARN: ${warning}`);
    // MAX_IMPORT_TRIS is an EDITOR cap — the browser viewport holds far more than a PS2 does. There is no
    // measured triangle ceiling for a repacked level the way there is a proven-clean VRAM footprint, so this
    // is a flag to go look, not a hard limit: the reference point is docs/028's census, where GARI's entire
    // 648-model prop library is ~225k triangles.
    if (bake.tris > 150_000)
      logLines.push(`WARN: imported props alone bake ${bake.tris.toLocaleString()} triangles — comparable to a `
        + 'retail level\'s ENTIRE prop library (~225k for GARI\'s 648 models). This is not a proven limit, but '
        + 'if a repacked ISO stutters or drops geometry, decimate the densest imports or place fewer copies.');
  }
  // Effects trigger volumes are generated boxes rather than prop-library models. Their dedicated group-name
  // contract makes the ISO instance invisible while retaining the render-model bounds for mode-3 contact.
  const triggerPlacements = (doc.props ?? []).filter(isEffectTriggerProp);
  if (triggerPlacements.length) {
    const { obj: startObj, v } = objCounts();
    const bake = bakeEffectTriggerProps(triggerPlacements, v);
    if (bake.obj) {
      files.text['Props.obj'] = startObj + bake.obj;
      propGroups.push(...bake.groups);
      mergeBaked(bake.bakedGroups);
      logLines.push(`baked ${bake.baked} invisible effect trigger volume(s) into Props.obj`);
    }
  }
  // Authored prop audio. The event ids are the retail ADL contract; direct Unity bundles additionally receive
  // a staged WAV name because a custom mountain does not carry the donor level's Audio/SFX tree. Custom hit and
  // ambient clips share the same finite reserved event pool + course-bank rewrite.
  const collisionSounds: Record<string, number> = {};
  const collisionSoundClips: Record<string, string> = {};
  /** Editor metres, not centimetres: the unit conversion and the editor→native axis reorder both belong to
   *  `authoredAmbientRecord`, at the one point the native record is stamped. */
  const ambientSounds: Record<string, {
    event: number; radius: number; falloff?: number; halfExtents?: V3; clip?: string;
  }> = {};
  /** Reserved ADL event → staged WAV. Snowknife resolves the event to the target ISO's slot at repack time. */
  const customEventFiles: Record<string, string> = {};
  const customSlotFiles: Record<string, string> = {};
  /** Keyed `"<role> <file>"` for pooled ids, bare `<file>` for the gated class — see `stageCustom`. */
  const customEventByFile = new Map<string, number>();
  /** How many RESERVED-pool ids are spent. Hit-gated claims sit outside the pool and must not advance it. */
  let pooledCustomEvents = 0;
  /** Direct PlaySound clips already given an authored slot. Prop clips are event-keyed separately because
   *  their slot is a fact of the target ISO's resolver, not of this portable export. */
  const customSlotByFile = new Map<string, number>();
  const stagedSounds = new Map<string, Uint8Array>();
  const stageCustom = async (file: string, role: CustomSoundRole)
  : Promise<{ event: number; clip: string } | null> => {
    // A CLAIMED file takes the gated id its position names instead of drawing from the ordinary reserved
    // pool. It has to: the engine's interactive class tests those three ids and nothing else, so a hit-gated
    // custom loop is only possible by taking one over [Trailmap: 420-interactive-ambient].
    const claimed = hitGatedEventForFile(file, exportDoc.hitGatedSounds);
    // Keyed by file AND ROLE, because the two roles need different BYTES from the same WAV: an emitter's slot
    // is encoded with a loop region and a hit sound's is not. Keying on the filename alone gave one event and
    // therefore one slot, and the slot was then encoded looping on the emitter's account — so hitting the
    // prop started a one-shot that sustained forever. Two roles, two slots, one staged WAV between them.
    //
    // Except for the gated class, which shares one id on purpose: events 16/28/57 ARE a hit and a sustaining
    // emitter on the same id, which is what every retail fire hydrant is, so splitting them would break the
    // gate rather than fix anything.
    const cacheKey = claimed >= 0 ? file : `${role} ${file}`;
    let event = customEventByFile.get(cacheKey);
    if (event === undefined) {
      if (claimed >= 0) event = claimed;
      // Counted separately from the map: a claimed file must not consume a reserved-pool id, or every
      // ordinary custom sound after it would be pushed one slot along and the eighth would fall off.
      else if (pooledCustomEvents >= CUSTOM_SOUND_EVENT_POOL.length) {
        logLines.push(`WARN: more than ${CUSTOM_SOUND_EVENT_POOL.length} distinct custom prop sounds — "${file}" dropped`);
        return null;
      } else event = CUSTOM_SOUND_EVENT_POOL[pooledCustomEvents++];
      customEventByFile.set(cacheKey, event);
      const other = customEventByFile.get(`${role === 'hit' ? 'emitter' : 'hit'} ${file}`);
      if (other !== undefined)
        logLines.push(`note: "${file}" is used as both an impact and an ambient loop, so it takes two `
          + `reserved events (${other} and ${event}) and two bank slots — one looping, one not`);
    }
    const clip = `custom_${file}`;
    try { stagedSounds.set(clip, await provider.customSound(file)); }
    catch (e) {
      logLines.push(`WARN: custom sound ${file} missing (${e instanceof Error ? e.message : e}) — its props fall silent`);
      return null;
    }
    customEventFiles[String(event)] = clip;
    return { event, clip };
  };
  /** Stage a Play sound node's custom WAV and report the course-bank slot it lands in. Unlike a prop hit
   *  sound this needs no reserved ADL event — a MainType-8 node names its slot directly — so it allocates
   *  from the block the resolver table never maps rather than competing for the eight-id pool. */
  let effectSoundSlotsUsed = 0;
  const stageEffectSound = async (file: string): Promise<number | null> => {
    const shared = customSlotByFile.get(file);
    if (shared !== undefined) return shared;
    if (effectSoundSlotsUsed >= CUSTOM_EFFECT_SOUND_SLOTS.length) {
      logLines.push(`WARN: more than ${CUSTOM_EFFECT_SOUND_SLOTS.length} distinct custom Play sound clips — "${file}" dropped`);
      return null;
    }
    const clip = `custom_${file}`;
    try { stagedSounds.set(clip, await provider.customSound(file)); }
    catch (e) {
      logLines.push(`WARN: custom sound ${file} missing (${e instanceof Error ? e.message : e}) — its Play sound nodes fall silent`);
      return null;
    }
    const slot = CUSTOM_EFFECT_SOUND_SLOTS[effectSoundSlotsUsed++];
    customSlotFiles[String(slot)] = clip;
    customSlotByFile.set(file, slot);
    return slot;
  };
  const stageBank = async (level: string, event: number): Promise<string | undefined> => {
    const resolved = resolveCollisionSound(event, level);
    if (!resolved) return undefined;
    const safeLevel = level.replace(/[^A-Za-z0-9_-]/g, '_').toLowerCase();
    const clip = `bank_${safeLevel}_${resolved.bank}_${String(resolved.slot).padStart(3, '0')}.wav`;
    if (!stagedSounds.has(clip)) {
      try { stagedSounds.set(clip, await provider.courseEffectSound(level, resolved.slot, resolved.bank)); }
      catch (e) {
        logLines.push(`WARN: ${level} event ${event} could not be staged for Unity (${e instanceof Error ? e.message : e})`);
        return undefined;
      }
    }
    return clip;
  };
  const stageExternalBank = async (level: string, event: number): Promise<string | undefined> => {
    const resolved = resolveExternalSound(event, level);
    if (!resolved) return undefined;
    const safeLevel = level.replace(/[^A-Za-z0-9_-]/g, '_').toLowerCase();
    const bank = resolved.kind === 'fixed' ? resolved.bank : resolved.kind;
    const clip = `bank_${safeLevel}_${bank.toLowerCase()}_${String(resolved.slot).padStart(3, '0')}.wav`;
    if (!stagedSounds.has(clip)) {
      try {
        stagedSounds.set(clip, resolved.kind === 'fixed'
          ? await provider.namedEffectSound(level, resolved.slot, resolved.bank)
          : await provider.courseEffectSound(level, resolved.slot, resolved.kind));
      } catch (e) {
        logLines.push(`WARN: ${level} external event ${event} could not be staged for Unity (${e instanceof Error ? e.message : e})`);
        return undefined;
      }
    }
    return clip;
  };
  for (const pp of doc.props ?? []) {
    if (!pp.id) continue;
    if (typeof pp.collisionSoundFile === 'string' && pp.collisionSoundFile) {
      const custom = await stageCustom(pp.collisionSoundFile, 'hit');
      if (custom) {
        collisionSounds[pp.id] = custom.event;
        collisionSoundClips[pp.id] = custom.clip;
      }
    } else if (typeof pp.collisionSound === 'number' && pp.collisionSound >= 0) {
      const event = Math.trunc(pp.collisionSound);
      collisionSounds[pp.id] = event;
      const clip = await stageBank(pp.level, event);
      if (clip) collisionSoundClips[pp.id] = clip;
    }
    // Region and falloff ride along in EDITOR metres; `authoredAmbientRecord` does the clamping, the unit
    // conversion and the axis reorder in one place at the moment the native record is stamped.
    const ambientRegion = {
      radius: pp.ambientRadius ?? AUTHORED_AMBIENT_DEFAULT_M,
      ...(typeof pp.ambientFalloff === 'number' ? { falloff: pp.ambientFalloff } : {}),
      ...(pp.ambientHalfExtents ? { halfExtents: pp.ambientHalfExtents } : {}),
    };
    if (typeof pp.ambientSoundFile === 'string' && pp.ambientSoundFile) {
      const custom = await stageCustom(pp.ambientSoundFile, 'emitter');
      if (custom) ambientSounds[pp.id] = { event: custom.event, ...ambientRegion, clip: custom.clip };
    } else if (typeof pp.ambientSound === 'number' && pp.ambientSound >= 0) {
      const event = Math.trunc(pp.ambientSound);
      const clip = await stageExternalBank(pp.level, event);
      ambientSounds[pp.id] = { event, ...ambientRegion, ...(clip ? { clip } : {}) };
    }
  }
  const soundCount = Object.keys(collisionSounds).length;
  // Custom Play sound clips. Props are staged first so a WAV shared with a hit sound keeps that slot; each
  // remaining file takes one of its own, and the node's SoundPlay is rewritten to point at it. The authored
  // file name stays in the node's extensions for the editor to re-present — what the SSF compiles from is
  // always a plain slot number, exactly as a retail PlaySound node carries.
  let effectSoundNodes = 0;
  if (files.text['Effects.json']) {
    const soundDoc = JSON.parse(files.text['Effects.json']) as EffectsDocument;
    for (const owner of [...(soundDoc.graphs ?? []), ...(soundDoc.functions ?? [])])
      for (const node of owner.nodes ?? []) {
        const file = effectNodeSoundFile(node);
        if (!file) continue;
        const slot = await stageEffectSound(file);
        if (slot === null) continue;
        node.payload.SoundPlay = slot;
        effectSoundNodes++;
      }
    if (effectSoundNodes) files.text['Effects.json'] = JSON.stringify(soundDoc, null, 2) + '\n';
  }
  // Authored contact tuning: per-placement bounce kickback + rideable surface type, joined to the baked
  // group names like the hit sounds so the ISO packer can stamp PlayerBounce/PlayerBounceAmmount/SurfaceType
  // onto the packed SOLID instances [Trailmap: 130-collision-data, 120-objects].
  const propBounce: Record<string, number> = {};
  const propSurfaces: Record<string, number> = {};
  const propModePresence: Record<string, 'showoff'> = {};
  const nativeCollisions: Record<string, NativeCollisionExport> = {};
  for (const pp of doc.props ?? []) {
    if (!pp.id) continue;
    if (pp.modePresence === 'showoff') propModePresence[pp.id] = 'showoff';
    if (placedPropSolid(pp) && typeof pp.bounce === 'number' && pp.bounce >= 0)
      propBounce[pp.id] = Math.round(pp.bounce * 1000) / 1000;
    if (placedPropSolid(pp) && typeof pp.surface === 'number' && pp.surface >= 0)
      propSurfaces[pp.id] = Math.trunc(pp.surface);
    if (pp.nativeCollision) {
      nativeCollisions[pp.id] = {
        mode: pp.nativeCollision.mode,
        playerCollision: pp.nativeCollision.playerCollision,
        responseMass: pp.nativeCollision.responseMass,
        playerBounce: pp.nativeCollision.playerBounce,
        bounceAmount: pp.nativeCollision.bounceAmount,
        ...(pp.nativeCollision.physicsSource
          ? { physicsSource: { ...pp.nativeCollision.physicsSource } } : {}),
        // Editor +Y yaw maps to raw-space -Z yaw under RAW_TO_EDITOR (rawInstanceQuat carries the general
        // form). Every explicit collision profile keeps this instance transform so mesh/bounds/source-sphere
        // shapes and the visual model share one local frame.
        transform: {
          location: toRaw(pp.pos), rotation: rawInstanceQuat(pp),
          scale: [pp.scale, pp.scale, pp.scale],
        },
      };
    }
  }
  const nativeCollisionCount = Object.keys(nativeCollisions).length;
  const tuningCount = Object.keys(propBounce).length + Object.keys(propSurfaces).length + nativeCollisionCount;
  // Per-instance prop lighting authored from the sun (docs/032 · lighting), joined by placement id like the
  // contact tuning. The canonical serializer stamps this onto Instances.json so the authored sun survives
  // unchanged through glTF, Unity and PS2 packing.
  const propLighting: Record<string, { amb: number[]; key: number[]; dir: number[] }> = {};
  for (const [id, l] of Object.entries(files.propLights ?? {}))
    propLighting[id] = { amb: l.amb, key: l.key, dir: l.dir };
  const lightingCount = Object.keys(propLighting).length;
  const ambientCount = Object.keys(ambientSounds).length;
  // Props.obj is a world-space bake, while attached graph payloads remain model-local. Keep the origin-only
  // pivot used by native spline packing, and also carry the complete similarity so bundle-time P6 origins,
  // spawn axes, velocity envelopes, and gravity take the exact pose SlopeSmith previews. Derive it through
  // the same matrix/frame conversion as the vertices rather than re-encoding the coordinate-system signs here.
  const propPivots: Record<string, number[]> = {};
  const propPoses: Record<string, BakedPropPose> = {};
  for (const pp of exportDoc.props ?? []) if (pp.id && bakedGroups[pp.id]) {
    propPivots[pp.id] = toRaw(pp.pos);
    propPoses[pp.id] = placementSimilarity(placementMatrix(pp));
  }
  // A mountain can assign hit sounds / contact tuning without authoring any effects; the joins still ride
  // Effects.json extensions, so synthesize an empty document to carry them.
  if ((soundCount || ambientCount || tuningCount || lightingCount) && !files.text['Effects.json'])
    files.text['Effects.json'] = JSON.stringify(createEmptyEffectsDocument(doc.name)) + '\n';
  if (files.text['Effects.json'] && (Object.keys(bakedGroups).length || soundCount || ambientCount
    || tuningCount || lightingCount || Object.keys(customEventFiles).length || Object.keys(customSlotFiles).length)) {
    const effectsDoc = JSON.parse(files.text['Effects.json']);
    const slopesmith = ((effectsDoc.extensions ??= {}).slopesmith ??= {});
    if (Object.keys(bakedGroups).length) slopesmith.bakedGroups = bakedGroups;
    if (soundCount) slopesmith.collisionSounds = collisionSounds;
    if (Object.keys(collisionSoundClips).length) slopesmith.collisionSoundClips = collisionSoundClips;
    if (ambientCount) slopesmith.ambientSounds = ambientSounds;
    if (Object.keys(customEventFiles).length) slopesmith.customSoundEvents = customEventFiles;
    if (Object.keys(customSlotFiles).length) slopesmith.customSounds = customSlotFiles;
    if (Object.keys(propBounce).length) slopesmith.propBounce = propBounce;
    if (Object.keys(propSurfaces).length) slopesmith.propSurfaces = propSurfaces;
    if (nativeCollisionCount) slopesmith.nativeCollisions = nativeCollisions;
    if (lightingCount) slopesmith.propLighting = propLighting;
    if (Object.keys(propPivots).length) slopesmith.propPivots = propPivots;
    if (Object.keys(propPoses).length) slopesmith.propPoses = propPoses;
    if (Object.keys(propClips).length) slopesmith.propClips = propClips;
    files.text['Effects.json'] = JSON.stringify(effectsDoc, null, 2) + '\n';
    if (Object.keys(propClips).length) {
      const moving = Object.values(propClips).reduce((n, clip) =>
        n + clip.objects.filter(o => o.channels?.some(curve => !!curve?.length)).length, 0);
      logLines.push(`model clips: ${Object.keys(propClips).length} placement(s) / ${moving} moving object(s) `
        + '→ propClips join in Effects.json');
    }
    if (Object.keys(bakedGroups).length)
      logLines.push(`effect attachment join: ${Object.keys(bakedGroups).length} placement id(s) → baked group names in Effects.json`);
    if (soundCount)
      logLines.push(`hit sounds: ${soundCount} placement(s) → collisionSounds join in Effects.json`
        + (Object.keys(customEventFiles).length
          ? ` (+ ${Object.keys(customEventFiles).length} custom event/file join(s))` : ''));
    if (ambientCount)
      logLines.push(`ambient loops: ${ambientCount} placement(s) → ambientSounds join in Effects.json`);
    // A hit-gated claim takes over a retail event id, and with it the course-bank slot that id resolves to,
    // for the WHOLE target level. Say exactly which ids left the pool so the repack's own conflict check has
    // something to answer to rather than the author discovering it by ear.
    for (const [index, file] of (exportDoc.hitGatedSounds ?? []).entries()) {
      const event = HIT_GATED_EVENT_POOL[index];
      if (event === undefined) {
        logLines.push(`WARN: "${file}" claims a hit-gated slot beyond the engine's three — ignored`);
        continue;
      }
      logLines.push(`hit-gated loop: "${file}" claims event ${event} — it overrides that event's course-bank `
        + 'slot on the target level, so any retail prop using it plays this clip instead');
    }
    if (effectSoundNodes)
      logLines.push(`custom Play sound clips: ${effectSoundNodes} node(s) → course-bank slot(s) `
        + [...new Set(Object.entries(customSlotFiles)
          .filter(([slot]) => CUSTOM_EFFECT_SOUND_SLOTS.includes(Number(slot))).map(([slot]) => slot))].join(', '));
    if (tuningCount)
      logLines.push(`contact tuning: ${Object.keys(propBounce).length} legacy bounce / ${Object.keys(propSurfaces).length} surface / ${nativeCollisionCount} explicit collision profile(s)`);
    if (nativeCollisionCount)
      logLines.push(`collision profiles: ${nativeCollisionCount} placement(s) preserve shape/gates/response mass/bounce/body donor + instance transform`);
    if (lightingCount) {
      const shaded = Object.values(propLighting).filter(l => Math.max(...l.key) < 1).length;
      logLines.push(`prop lighting: ${lightingCount} placement(s) lit from the authored sun`
        + (shaded ? ` (${shaded} fully shadowed — sky fill only)` : ''));
    }
  }
  // Both animation tables are complete snapshots of what the document's effects install, and each is written
  // only when it has an entry — so they are retired first. A stale table left from a previous export would
  // keep animating a material whose effect the author has since removed.
  remove.push('Scroll.json', 'Flip.json');
  if (scrollSpeeds.length) {
    files.text['Scroll.json'] = JSON.stringify({ Speeds: scrollSpeeds });
    logLines.push(`authored UV scroll: ${scrollIdxByProp.size} placement(s) using ${scrollSpeeds.length} motion profile(s) → Scroll.json + _scr-tagged material slots`);
  }
  // authored flipbooks: a placement carrying an always-on texture flip publishes its rate through the shipped
  // levels' own dialect — Flip.json, keyed by the combined MaterialID its meshes drew with — so the bundle
  // animates the material exactly as it does a reference level's signs (docs/026 · Unity docs/008). A
  // frame list on its own is a STATE list: without this table the frames still ship and the surface simply
  // rests on frame 0, which is what a triggered button or a game-logic state pair wants and an animated sign
  // does not. Keyed per MATERIAL like the native table, so placements sharing a flipbook material share one
  // rate; the frame list is part of the material's identity, so distinct state lists already hold distinct slots.
  const flipMaterials = new Map<number, { Id: number; Speed: number; U4: number }>();
  const bakedByName = new Map(propGroups.map(group => [group.name, group]));
  for (const pp of doc.props ?? []) {
    const flip = pp.id ? authoredPropTextureFlip(doc.effects, pp.id) : null;
    if (!flip) continue;
    const slots = new Set<number>();
    for (const name of bakedGroups[pp.id!] ?? [])
      for (const sub of bakedByName.get(name)?.subs ?? [])
        if (sub.slot >= 0 && (combiner.materials[sub.slot]?.TextureFlipbook.length ?? 0) >= 2) slots.add(sub.slot);
    const u4 = flip.dwell ? 1 : 0;
    for (const slot of slots) {
      const held = flipMaterials.get(slot);
      if (!held) flipMaterials.set(slot, { Id: slot, Speed: flip.speed, U4: u4 });
      else if (held.Speed !== flip.speed || held.U4 !== u4)
        logLines.push(`WARN: material ${slot} already flips at ${held.Speed}/s and "${pp.name || pp.id}" asks for `
          + `${flip.speed}/s — the first rate wins. One rate per material is what the native table stores; give the `
          + 'second prop its own tile (or its own frame list) to flip it differently.');
    }
  }
  if (flipMaterials.size) {
    files.text['Flip.json'] = JSON.stringify({
      Materials: [...flipMaterials.values()].sort((a, b) => a.Id - b.Id),
    });
    const dwelling = [...flipMaterials.values()].filter(entry => entry.U4).length;
    logLines.push(`authored flipbooks: ${flipMaterials.size} material(s) cycle free-running → Flip.json`
      + (dwelling ? ` (${dwelling} on the dwell/flash screen law)` : ''));
  }
  // Rails and gems both borrow shipped art, so the donor is resolved once and only when one of them is
  // authored — a mountain with neither never asks which level ships a rail tube.
  let art: NativeArt | undefined;
  const nativeArt = async () => art ??= await provider.nativeArt();
  // the authored rails' visual tubes: the same sweep the viewport previews, in the donor's red/white rail
  // skin, appended as static props (the ridable grind is Splines.json — the tube is the decoration along it)
  if (doc.rails?.length) {
    const { obj: startObj, v, vt } = objCounts();
    const skin = await nativeArt();
    const tubes = bakeRailTubes(doc.rails, v, vt, combiner, { level: skin.level, material: skin.railMaterial });
    if (tubes.obj) {
      files.text['Props.obj'] = startObj + tubes.obj;
      propGroups.push(...tubes.groups);
      logLines.push(`baked ${tubes.tubes} rail tube(s) into Props.obj (native red/white skin)`
        + (tubes.posts ? ` + ${tubes.posts} support post(s)` : ''));
    }
  }
  // the gem tier crystals as their own GemModels.obj — separate from Props.obj so they DON'T merge into the
  // static props node; snowknife bakes them into per-tier gems.glb nodes the importer instantiates per gem
  if (doc.gems?.length) {
    const source = await nativeArt();
    const gemGeometry = await provider.modelGeometry(
      source.gemTiers.map(t => ({ level: source.level, model: t.model })));
    const gm = bakeGemModels(source.gemTiers, source.level, gemGeometry, combiner);
    if (gm) {
      files.text['GemModels.obj'] = gm.obj;
      logLines.push(`wrote GemModels.obj (native tier crystal(s): ${gm.tiers.map(t => '×' + t).join(' ')})`);
    }
  }
  // A canonical map always has a material table, including a fresh mountain whose only prop is the
  // untextured start gate.
  files.text['Materials.json'] = JSON.stringify({ Materials: combiner.materials });
  // This file is an owned snapshot too: a material changing from explicit cutout back to automatic must
  // retire the prior verdict instead of leaving a stale sidecar beside otherwise-current output.
  remove.push('TextureAlpha.overrides.json');
  if (Object.keys(combiner.alphaOverrides).length) {
    files.text['TextureAlpha.overrides.json'] = JSON.stringify(combiner.alphaOverrides, null, 2) + '\n';
  }
  if (combiner.materials.length) {
    for (const c of combiner.texCopies) files.copyTextures[c.dest] = { level: c.level, name: c.name };
    logLines.push(`combined material table: ${combiner.materials.length} material(s), ${combiner.texCopies.length} texture(s)`);
  }

  // The staging anchors go on the END of the list, after every placed prop, so their arrival doesn't
  // renumber a level's existing instances (Props.obj tags groups `inst<n>` positionally).
  propGroups.push(...files.anchorGroups);

  const canonical = buildCanonicalProps(propGroups, {
    bakedGroups, propClips, propPoses, collisionSounds, collisionSoundClips, ambientSounds,
    propBounce, propSurfaces, propModePresence, nativeCollisions, propLighting, effects: exportDoc.effects,
  });
  // These directories are complete snapshots of the structured prop bake. Clearing them is what makes a
  // re-export deterministic when a model loses a material submesh or a collision profile is disabled.
  remove.push('Meshes', 'Collision');
  Object.assign(files.text, canonical.text);
  logLines.push(`canonical props: ${canonical.instances} instance(s), ${canonical.models} model(s), `
    + `${canonical.meshes} render mesh(es), ${canonical.collisionMeshes} collision mesh(es); `
    + `${canonical.animatedModels} animated, ${canonical.effectBindings} effect-bound, `
    + `${canonical.posedInstances} posed`);
  for (const warning of canonical.warnings) logLines.push(`WARN: ${warning}`);

  for (const [fname, content] of Object.entries(files.text)) {
    out.push(textFile(fname, content));
    logLines.push(`wrote ${fname} (${content.length.toLocaleString()} bytes)`);
  }
  // Every file that lands under Textures/, which is what the manifest's `staged` names have to agree with.
  const staged = new Set<string>();
  for (const [tname, rgba] of Object.entries(files.textures)) {
    out.push({ path: `Textures/${tname}`, bytes: await provider.encodePng(rgba) });
    staged.add(tname);
    logLines.push(`wrote Textures/${tname}`);
  }
  for (const [lname, rgba] of Object.entries(files.lightmaps)) {
    out.push({ path: `Lightmaps/${lname}`, bytes: await provider.encodePng(rgba) });
    logLines.push(`wrote Lightmaps/${lname}`);
  }
  // the authored sky (docs/025): the ring + its 25 pages into Skybox/, shaped like an extracted level's so
  // `snowknife skybox` and `repack` both read it without knowing it was authored, cut against the ring the
  // sky itself names (SkyboxDoc.ring). No sky on the doc = no Skybox/ written, and a repack then leaves the
  // target level's own sky alone.
  if (doc.skybox) {
    try {
      const sky = await provider.skybox(doc.skybox);
      remove.push('Skybox');   // a complete snapshot: a retired page cannot survive a re-export
      out.push(...sky.files);
      logLines.push(...sky.log);
    } catch (e) {
      logLines.push(`WARN: skybox not exported (${e instanceof Error ? e.message : e}) — the repack will keep the target level's own sky`);
    }
  }

  // Every authored clip is staged for direct Unity import. For ISO repacking, customSoundEvents
  // names prop/ambient clips by portable event id; customSounds names direct PlaySound clips by slot.
  for (const [file, bytes] of stagedSounds) {
    out.push({ path: `Sounds/${file}`, bytes });
    const slot = Object.entries(customSlotFiles).find(([, value]) => value === file)?.[0];
    const event = Object.entries(customEventFiles).find(([, value]) => value === file)?.[0];
    logLines.push(`wrote Sounds/${file}` + (event ? ` (custom prop sound → event ${event})`
      : slot ? ` (custom PlaySound clip → course-bank slot ${slot})` : ' (direct Unity clip)'));
  }

  // real tiles a cell was texture-painted with: copy the extracted PNG verbatim (the same bytes the source
  // level itself rides) into this level's Textures/ under its collision-free dest name. Nothing is resampled
  // here — what a page must shrink to is a property of the disc being patched, so `repack` conforms it
  // against the target's own bank, and Unity keeps the stored detail either way.
  let copied = 0;
  for (const [dest, src] of Object.entries(files.copyTextures)) {
    let bytes: Uint8Array;
    try {
      bytes = await provider.referenceTexture(src.level, src.name);
    } catch (e) {
      logLines.push(`WARN: texture ${src.level}/${src.name} missing (${e instanceof Error ? e.message : e})`);
      continue;
    }
    out.push({ path: `Textures/${dest}`, bytes });
    staged.add(dest);
    copied++;
    logLines.push(`copied Textures/${dest} <- ${src.level}/${src.name}`);
  }
  const queuedTex = Object.keys(files.copyTextures).length;
  if (queuedTex && !copied)
    logLines.push(`ERROR: all ${queuedTex} texture copies failed — Textures/ is empty, so a repack has no `
      + 'pages to install and every borrowed/custom material falls back to slot 0000 in-game.');

  // Patches.json names each page by its flattened file name, which loses the donor. Preserve the portable
  // level/name provenance beside the staged files: it is what `repack` resolves a page's disc treatment
  // from, and what lets this output later be selected as a reference map (docs/036).
  // Machine-specific absolute paths never enter the manifest; the receiver's configured Maps root resolves it.
  const textureSources: Record<string, SlopesmithTextureSource> = {};
  for (const [ref, source] of Object.entries(files.textureSources)) {
    const local = source.staged && staged.has(source.staged) ? source.staged : undefined;
    textureSources[ref] = { level: source.level, name: source.name, ...(local ? { staged: local } : {}) };
  }
  const provenance = classifyExportProvenance(doc, textureSources);
  const manifest: SlopesmithExportManifest = {
    schema: 1,
    kind: 'slopesmith-export',
    level: name,
    documentVersion: doc.version,
    provenance,
    ...(doc.laps && doc.laps !== DEFAULT_LAPS ? { laps: doc.laps } : {}),
    // Written whenever the map carries one, default included: what the editor shows is what the bundle gets,
    // rather than a map left at 120 s silently inheriting the 90 of the slot it lands on (core/doc/race).
    ...(doc.showoffSeconds !== undefined ? { showoffSeconds: doc.showoffSeconds } : {}),
    patches: files.patchIds,
    textures: textureSources,
    props: {
      format: 'ssx-native-map-v1', instances: 'Instances.json', models: 'Models.json',
      meshes: 'Meshes', collision: 'Collision', materials: 'Materials.json', preview: 'Props.obj',
    },
    canonical: {
      schema: 1, format: 'ssx-native-map-v1', instances: canonical.instances, models: canonical.models,
      meshes: canonical.meshes, collisionMeshes: canonical.collisionMeshes,
    },
  };
  out.push(textFile(SLOPESMITH_EXPORT_MANIFEST, JSON.stringify(manifest, null, 2) + '\n'));

  // Origin.json — the same two facts `snowknife import` states about an extract, said about this folder:
  // authored, and whether the classification above found borrowed bytes in it. It is a separate file from the
  // manifest because its readers are separate: the manifest is repack's page table, this is what decides
  // whether somebody may open the folder as a reference at all (core/export/origin.ts).
  const origin = authoredOrigin(provenance);
  out.push(textFile(MAP_ORIGIN_FILE, JSON.stringify(origin, null, 2) + '\n'));
  logLines.push(`wrote ${MAP_ORIGIN_FILE} (${origin.Origin}`
    + `${origin.RetailData ? `, retail data: ${origin.Reasons.join(', ')}` : ', no retail data'})`);

  logLines.push(`wrote ${SLOPESMITH_EXPORT_MANIFEST} (${files.patchIds.length} patch id(s), `
    + `${Object.keys(textureSources).length} texture source(s)`
    + `${manifest.laps ? `, ${manifest.laps} laps` : ''}`
    + `${manifest.showoffSeconds !== undefined ? `, ${manifest.showoffSeconds}s showoff` : ''}, `
    + `public distribution: ${provenance.publicDistribution})`);

  const disc = discRecipeFiles(name, await provider.discRecipePaths());
  out.push(...disc.files);
  logLines.push(...disc.log);

  // The global environment filler is its own Maps contract, independent of the disc-derived collision index.
  // Both consumers read this exact file; the authored export also carries the selected shared-bank WAVs so a
  // Unity import never needs to know which extracted course happened to donate their identical bytes.
  const environment = environmentDocument(normalizeEnvironmentBed(doc.environmentBed));
  out.push(textFile('Audio/Environment.json', JSON.stringify(environment, null, 2) + '\n'));
  if (environment.Bed) {
    const bed = environment.Bed;
    try {
      const [full, loop] = await Promise.all([
        provider.environmentEffectSound(bed.Bank, bed.Slot, false),
        provider.environmentEffectSound(bed.Bank, bed.Slot, true),
      ]);
      out.push({ path: bed.Clip, bytes: full });
      out.push({ path: bed.Clip.replace(/\.wav$/i, '.loop.wav'), bytes: loop });
      logLines.push(`environment bed: ${bed.Bank}/${String(bed.Slot).padStart(3, '0')} at ${bed.Volume.toFixed(2)} → Audio/Environment.json`);
    } catch (e) {
      logLines.push(`WARN: environment bed ${bed.Bank}/${String(bed.Slot).padStart(3, '0')} declared but its shared bank is unavailable (${e instanceof Error ? e.message : e}) — run snowknife shared or import one retail map`);
    }
  } else logLines.push('environment bed: disabled in Audio/Environment.json');

  // Standalone fog volumes use the level-independent PARTICLE.SSH art. An ISO already owns that bank; Unity's
  // thin importer resolves the sprite from the staged level folder, so the export includes it. The volumes
  // name the extraction they were copied from, so the staged sprite is the one they were authored against.
  if (doc.particleVolumes?.length) {
    try {
      out.push({ path: 'Textures/Particles/fog0.png',
        bytes: await provider.particleTexture('fog0.png', particleDonorLevel(doc.particleVolumes)) });
      logLines.push('copied Textures/Particles/fog0.png from the shared particle bank');
    } catch (e) {
      logLines.push(`WARN: shared fog0.png missing (${e instanceof Error ? e.message : e}) — ISO output is unaffected; Unity will need \`snowknife particles\``);
    }
  }

  // Scene ▸ Sound selects an author-owned source by filename. Normalize it here, before the bake, so the
  // folder is self-contained and carries the exact Music/track.wav contract `repack` consumes
  // (Snowknife/CustomMusicInject.cs).
  const raceMusic = await provider.stageRaceMusic(doc.raceMusic, doc.raceMusicArrangement);
  remove.push(...raceMusic.remove);
  out.push(...raceMusic.files);
  if (raceMusic.status === 'staged') {
    logLines.push(`race music: ${doc.raceMusic} → Music/track.wav + arrangement.json (${raceMusic.mode}, PCM16, 36 kHz stereo, ${raceMusic.bytes!.toLocaleString()} bytes)`);
  } else if (raceMusic.status === 'cleared' && raceMusic.existing) {
    logLines.push('race music: cleared Music/track.wav');
  } else if (raceMusic.status === 'legacy' && raceMusic.existing) {
    logLines.push('race music: preserving legacy manually staged Music/track.wav');
  }

  return { remove, files: out, log: logLines };
}
