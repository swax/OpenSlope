import type { PlacedProp, PropBehaviour, V3 } from '../../core/doc/types';
import { AUTHORED_MODEL_LEVEL, authoredModelLevelProps, findModelByNumber } from '../../core/doc/models';
import { IMPORTED_PROP_LEVEL } from '../../core/props/imported';
import { isEffectTriggerProp } from '../../core/effects/trigger-volume';
import type { NativeArt } from '../../core/export/provider';
import { boostPadPreset, type BoostPadKind } from '../../core/props/boost-pad';
import { promoteGem } from '../../core/props/gem';
import {
  applyBehaviour, groupMemberDefaults, instanceBehaviour, resolvePropDefaults, sameBehaviour, sanitizePropBehaviour,
  stampBehaviour, type ResolvedPropDefaults, type StampBehaviour,
} from '../../core/props/defaults';
import {
  attachEffectTemplateToProp, attachEffectToProp, attachModelEffectsToProp, createEmptyEffectsDocument,
  detachEffectFromProp, effectAttachments, nextPlacedPropId,
} from '../../core/effects/authoring';
import { decodeProps, type LevelProps, type PropsPayload } from '../../core/reference/props';
import type { UvScrollEffect } from '../../core/effects/world-effects';
import { authoredSignLights, authoredFreeLights, type LocalBox } from '../../core/lighting/sign-lights';
import { authoredGroupLights, type GroupDef, type GroupsPayload } from '../../core/reference/groups';
import type { ArmedProp, HeldEffect, Store } from '../state/store';
import type { Mode, Viewport } from '../viewport/viewport';
import type { PropLibrary } from './library';
import type { PropPreview } from './preview';
import { dropScreensForProp } from './screens';
import { toast } from '../ui/components/toast';
import { fetchJson, postJson } from '../net/fetch-json';
import { runDiagnosticPhase } from '../net/diagnostics';

/**
 * Placed-prop ops (docs/012 + 015): the prop domain around a placement — the model geometry caches (base
 * offsets + local bounding boxes), the per-level prop payload + mined group-def fetches, arming a prop or a
 * whole group for placement, the delete / multi-select ops, and the authored light rig (billboard sign lights
 * + free lights + a group placement's light members) that re-derives on every scene rebuild.
 */

export type PropOpsDeps = {
  store: Store;
  viewport: Viewport;
  propLevels: Map<string, LevelProps>; // fetched prop payloads, shared by the library + placement geometry
  groupDefIdx: Map<string, GroupDef>;  // "<level>:<id>" -> mined group def, for placements to resolve
  propLib: PropLibrary;
  propPreview: PropPreview;
  setMode: (m: Mode) => void;
  scheduleRebuild: () => void;
  rebuildTools: () => void;
  updateCmdSheet: () => void;
};

export function createPropOps(deps: PropOpsDeps) {
  const { store, viewport, propLevels, groupDefIdx, propLib, propPreview, setMode, scheduleRebuild, rebuildTools, updateCmdSheet } = deps;

  const groupDefsByLevel = new Map<string, Promise<GroupDef[]>>(); // /api/groups fetches, one per level (docs/015)
  const loadedGroupLevels = new Set<string>(); // includes successfully loaded empty group catalogues
  const propLoadsByLevel = new Map<string, Promise<LevelProps>>(); // in-flight /api/props fetches, one per level

  /** Short prop label: drop the "Mdl_" prefix and the trailing "_<n>" instance suffix (matches the library). */
  const shortPropName = (n: string) => n.replace(/^Mdl_/, '').replace(/_\d+$/, '');

  /**
   * What a held prop will stamp (docs/069), by how it was picked up:
   *  - `behaviour`: copying a placement (MMB, or a replacement pick) — its own settings, exactly;
   *  - `sourceIndex`: an exact reference instance (MMB on the reference, or its inspector's ＋ place) — that
   *    instance's own contact, surface, hit sound, self-lighting and mode layer;
   *  - neither: a library pick — the MODEL's defaults.
   * The effect follows the same source (docs/069 · Effects): the model's portable effect, the instance's own, or
   * — with `placementId` — the copied placement's effect slot, which the copies then share.
   */
  type ArmFrom = { behaviour?: PropBehaviour; sourceIndex?: number; placementId?: string;
    preset?: ReturnType<typeof boostPadPreset> };

  function armBehaviour(level: string, model: number, from: ArmFrom):
    Pick<ArmedProp, 'behaviour' | 'from' | 'effect' | 'specialKind'> {
    if (from.preset) return { behaviour: structuredClone(from.preset.behaviour), from: 'preset',
      specialKind: from.preset.effect.key.startsWith('boost-pad:speed') ? 'speed-boost' : 'trick-boost',
      effect: { kind: 'template', template: structuredClone(from.preset.effect) } };
    if (from.behaviour) return { behaviour: stampBehaviour(level, from.behaviour), from: 'placement',
      specialKind: store.mdoc.props?.find(prop => prop.id === from.placementId)?.specialKind,
      ...withEffect(placementEffect(from.placementId)) };
    const props = propLevels.get(level);
    const source = typeof from.sourceIndex === 'number'
      ? props?.instances.find(instance => instance.sourceIndex === from.sourceIndex) : undefined;
    if (source) {
      const template = source.effect !== undefined ? props?.effects?.[source.effect] : undefined;
      return { behaviour: instanceBehaviour(level, source), from: 'instance',
        ...withEffect(template ? { kind: 'template', template: structuredClone(template) } : undefined) };
    }
    return { behaviour: propDefaults(level, model).behaviour, from: 'defaults', ...withEffect(modelEffect(level, model)) };
  }

  const withEffect = (effect: HeldEffect | undefined) => effect ? { effect } : {};

  /** The portable effect a shipped level's model hands new placements (docs/069 · Effects), with how many of its
   *  visible copies carry it. None for the author's own models, whose effects they attach themselves. */
  function modelEffect(level: string, model: number): HeldEffect | undefined {
    const props = propLevels.get(level);
    const found = props?.models.find(candidate => candidate.id === model)?.effect;
    const template = found ? props?.effects?.[found.template] : undefined;
    return template && found
      ? { kind: 'template', template: structuredClone(template), matching: found.matching, total: found.total }
      : undefined;
  }

  /** The effect slot a placement carries, for its copies to share. */
  function placementEffect(placementId: string | undefined): HeldEffect | undefined {
    const effects = store.mdoc.effects;
    if (!effects || !placementId) return undefined;
    const attachment = effectAttachments(effects).find(item => item.enabled && item.target.id === placementId);
    return attachment && effects.slots.some(slot => slot.id === attachment.slot)
      ? { kind: 'slot', slot: attachment.slot, circumstance: attachment.circumstance } : undefined;
  }

  /** The defaults a new placement of this model starts with: the author's saved ones for their own models,
   *  derived from the level's placements for a shipped one, else the standard starting point (docs/069). */
  function propDefaults(level: string, model: number): ResolvedPropDefaults {
    return resolvePropDefaults(level, model, propLevels.get(level));
  }

  /**
   * What a group picked from the library stamps (docs/069): each member its OWN model's defaults, so a tree
   * arrives with a solid trunk under ride-through, rustling leaves. The placement's own fields are the leader's,
   * for anything that reads the placement whole. Members that would all behave alike carry no per-member record.
   */
  function groupDefaults(level: string, def: GroupDef): StampBehaviour {
    const members = groupMemberDefaults(level, def.props.map(m => m.model), propLevels.get(level));
    const leader = propDefaults(level, def.props[0].model).behaviour;
    const alike = Object.values(members).every(member => sameBehaviour(member, { ...leader, modePresence: undefined }));
    return alike ? leader : { ...leader, memberBehaviour: members };
  }

  /** The existing single placements of one model — what "apply to placed" would change. Groups and effect
   *  triggers are not placements OF a model in that sense, and a prop line's members take their settings from
   *  the line, which would put its own back at the next re-layout (docs/070). */
  function placementsOfModel(level: string, model: number): PlacedProp[] {
    return (store.mdoc.props ?? []).filter(p => p.level === level && p.model === model
      && !p.group && !p.line && !isEffectTriggerProp(p));
  }

  /**
   * Save `behaviour` as this model's defaults (docs/069), or clear them with null. Only the author's own models
   * have somewhere to keep them: a tiled model's record is in the document (so the save is an ordinary,
   * undoable document edit), an imported one's is its catalogue file. False for a shipped level's model.
   */
  async function saveModelDefaults(level: string, model: number, behaviour: PropBehaviour | null): Promise<boolean> {
    const clean = behaviour ? sanitizePropBehaviour(behaviour) : null;
    if (level === AUTHORED_MODEL_LEVEL) {
      const record = findModelByNumber(store.mdoc, model);
      if (!record) return false;
      if (clean) record.defaults = clean; else delete record.defaults;
      syncAuthoredModelLevel(); // the resolver reads the re-baked level; renderDoc would get there a frame later
      scheduleRebuild();
      return true;
    }
    if (level === IMPORTED_PROP_LEVEL) {
      await postJson(`/api/custom-prop-defaults?id=${model}`, JSON.stringify(clean));
      // Patched in place rather than refetched: nothing else in the catalogue changed, and a refetch would
      // re-register every imported model's geometry for one record's behaviour.
      const entry = propLevels.get(level)?.models.find(m => m.id === model);
      if (entry) { if (clean) entry.defaults = clean; else delete entry.defaults; }
      return true;
    }
    return false;
  }

  /** Give every existing placement of the model `behaviour` — the explicit way to push changed defaults onto
   *  props already on the mountain, since placements copy rather than link. Returns how many changed. */
  function applyBehaviourToPlaced(level: string, model: number, behaviour: PropBehaviour): number {
    const placed = placementsOfModel(level, model);
    for (const p of placed) applyBehaviour(p, stampBehaviour(level, behaviour));
    if (placed.length) { scheduleRebuild(); rebuildTools(); }
    return placed.length;
  }

  const propBaseOffsetCache = new Map<string, number>(); // `${level}:${model}` -> the model's lowest point above its origin (editor m)
  /**
   * How far a model's LOWEST vertex sits above its origin, in editor metres. Model geometry is raw cm, Z-up, and
   * RAW_TO_EDITOR maps vertical rawZ → editorY = rawZ/100, so this is minRawZ/100. Placement subtracts
   * scale×this from the clicked terrain height so the prop's bottom rests on the ground (a model whose origin is
   * its base has offset ≈ 0 and doesn't move; a centre-origin model lifts by half its height). 0 if not loaded.
   */
  function propBaseOffset(level: string, model: number): number {
    const key = `${level}:${model}`;
    const cached = propBaseOffsetCache.get(key);
    if (cached !== undefined) return cached;
    const m = propLevels.get(level)?.models.find(mm => mm.id === model);
    if (!m) return 0; // geometry not loaded yet (rare — armProp loads it before you can place)
    let minZ = Infinity;
    for (const s of m.subs) for (let k = 2; k < s.positions.length; k += 3) if (s.positions[k] < minZ) minZ = s.positions[k];
    const base = Number.isFinite(minZ) ? minZ / 100 : 0;
    propBaseOffsetCache.set(key, base);
    return base;
  }

  const propBoxCache = new Map<string, LocalBox | null>(); // `${level}:${model}` -> model-local bbox (raw cm)
  /** A placed prop model's local bounding box (raw cm), from the loaded prop geometry — what a billboard's sign
   *  light is derived from. Null until the level's props are fetched (rebuildAuthoredRig re-runs on load). */
  function authoredBoxOf(level: string, model: number): LocalBox | null {
    const key = `${level}:${model}`;
    if (propBoxCache.has(key)) return propBoxCache.get(key)!;
    const m = propLevels.get(level)?.models.find(mm => mm.id === model);
    if (!m) return null; // geometry not loaded yet
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const s of m.subs) for (let k = 0; k < s.positions.length; k += 3) for (let j = 0; j < 3; j++) {
      const v = s.positions[k + j]; if (v < min[j]) min[j] = v; if (v > max[j]) max[j] = v;
    }
    const box = Number.isFinite(min[0]) ? { min, max } : null;
    propBoxCache.set(key, box);
    return box;
  }

  /** Rebuild the authored local lights — the billboard sign lights (derived from the doc's billboards) plus the
   *  hand-placed free lights — and hand them to the viewport (gizmos + terrain glow + billboard tint). Called in
   *  the scene rebuild BEFORE the placed props, so the tint is ready when they're built. The same combined set
   *  the export bakes into the lightmap + writes to Lights.json (docs/013). */
  function rebuildAuthoredRig() {
    const sign = authoredSignLights(store.mdoc.props, authoredBoxOf);
    const free = authoredFreeLights(store.mdoc.lights);
    const grp = authoredGroupLights(store.mdoc.props, defOfPlaced); // a group placement's light members (docs/015)
    viewport.setAuthoredLights([...sign, ...free, ...grp]);
  }

  /** The mined def a group placement references, or null while its level's defs are still loading. */
  function defOfPlaced(pp: PlacedProp): GroupDef | null {
    return pp.group ? groupDefIdx.get(`${pp.level}:${pp.group}`) ?? null : null;
  }

  /**
   * Fetch a level's mined group defs once (deduped by the promise cache) and register them with the viewport
   * (member rendering) + the index (light derivation, Tools member list). Shared by the Prop Library's Groups
   * section, group arming, and the doc-load sync.
   */
  function ensureGroupDefs(level: string): Promise<GroupDef[]> {
    let p = groupDefsByLevel.get(level);
    if (!p) {
      p = (async () => {
        const payload = await fetchJson<GroupsPayload>(`/api/groups?level=${encodeURIComponent(level)}`);
        if (payload.error) throw new Error(payload.error);
        for (const d of payload.groups) groupDefIdx.set(`${level}:${d.id}`, d);
        viewport.registerGroupDefs(level, payload.groups);
        loadedGroupLevels.add(level);
        return payload.groups;
      })();
      p.catch(() => groupDefsByLevel.delete(level)); // a failed fetch retries next time
      groupDefsByLevel.set(level, p);
    }
    return p;
  }

  /** A placement's seating offset: a group seats on its LOWEST member (the assembly's base), a plain prop on
   *  its own model — how far the bottom sits above the placement origin, editor metres. */
  function placedBaseOffset(pp: { level: string; model: number; group?: string }): number {
    const def = pp.group ? groupDefIdx.get(`${pp.level}:${pp.group}`) : undefined;
    if (!def) return propBaseOffset(pp.level, pp.model);
    let min = Infinity;
    for (const m of def.props) min = Math.min(min, propBaseOffset(pp.level, m.model) + m.relPos[1]);
    return Number.isFinite(min) ? min : 0;
  }

  /**
   * Fetch + decode a level's props once (cached in propLevels), and register its model geometry with the
   * viewport so placements of that level can render. Shared by the Prop Library, prop placement, and the
   * reference props view — so a level's few-MB payload is fetched at most once per session.
   */
  function ensurePropLevel(level: string): Promise<LevelProps> {
    if (level === AUTHORED_MODEL_LEVEL) return Promise.resolve(syncAuthoredModelLevel()); // live in-doc definitions, never fetched
    const cached = propLevels.get(level);
    if (cached) {
      runDiagnosticPhase('props', `${level}:register-models-cached`, () => viewport.registerPropModels(cached),
        `${cached.models.length} models · ${cached.instances.length} instances`);
      return Promise.resolve(cached);
    }
    let pending = propLoadsByLevel.get(level);
    if (!pending) {
      // imported GLB props are a whole catalogue rather than one level's table, so they answer on their own
      // route; everything downstream of decodeProps is identical (docs/032)
      const imported = level === IMPORTED_PROP_LEVEL;
      pending = (async () => {
        const payload = await fetchJson<PropsPayload>(
          imported ? '/api/custom-props' : `/api/props?level=${encodeURIComponent(level)}`);
        if (payload.error) throw new Error(payload.error);
        const lp = runDiagnosticPhase('props', `${level}:decode`, () => decodeProps(payload),
          `${payload.models.length} models · ${payload.instances.length} instances`);
        propLevels.set(level, lp);
        // a re-imported model keeps its number but changes its geometry, so the imported catalogue
        // replace-registers (like authored models) rather than register-once
        runDiagnosticPhase('props', `${level}:register-models`, () => {
          if (imported) viewport.syncLiveModels(lp); else viewport.registerPropModels(lp);
        }, `${lp.models.length} models · ${lp.instances.length} instances`);
        return lp;
      })();
      propLoadsByLevel.set(level, pending);
      void pending.then(
        () => { if (propLoadsByLevel.get(level) === pending) propLoadsByLevel.delete(level); },
        () => { if (propLoadsByLevel.get(level) === pending) propLoadsByLevel.delete(level); }, // failures retry next time
      );
    }
    return pending;
  }

  /** Re-bake the authored models' pseudo-level from the live document: the library payload, the seating
   *  offsets, and the viewport geometry all refresh together. renderDoc calls this every rebuild, so an
   *  edited model's placements re-render live; unchanged models skip on a content signature downstream. */
  function syncAuthoredModelLevel(): LevelProps {
    const lp = authoredModelLevelProps(store.mdoc);
    propLevels.set(AUTHORED_MODEL_LEVEL, lp);
    for (const key of [...propBaseOffsetCache.keys()]) if (key.startsWith(`${AUTHORED_MODEL_LEVEL}:`)) propBaseOffsetCache.delete(key);
    for (const key of [...propBoxCache.keys()]) if (key.startsWith(`${AUTHORED_MODEL_LEVEL}:`)) propBoxCache.delete(key);
    viewport.syncLiveModels(lp);
    return lp;
  }

  /** Refetch the imported-prop catalogue after a record changed server-side. The library's Replace action
   *  puts new geometry under the SAME model number, so every geometry-derived cache keyed on that number has
   *  to go with it — otherwise the model's placements keep seating and boxing against the mesh it replaced. */
  async function reloadImportedProps(): Promise<LevelProps> {
    propLevels.delete(IMPORTED_PROP_LEVEL);
    propLoadsByLevel.delete(IMPORTED_PROP_LEVEL);
    for (const key of [...propBaseOffsetCache.keys()]) if (key.startsWith(`${IMPORTED_PROP_LEVEL}:`)) propBaseOffsetCache.delete(key);
    for (const key of [...propBoxCache.keys()]) if (key.startsWith(`${IMPORTED_PROP_LEVEL}:`)) propBoxCache.delete(key);
    const lp = await ensurePropLevel(IMPORTED_PROP_LEVEL);
    scheduleRebuild(); // placements of a replaced model re-render against the new geometry
    return lp;
  }

  /** Ensure every level referenced by the doc's placed props has its geometry loaded — and, for group
   *  placements, its mined group defs. Return whether assets arrived that need another object render. Undo
   *  uses the retry; progressive loading waits before rendering, while sync redraws only for new assets.
   *  Authored models are already refreshed by renderMountainObjects, including on the first load. */
  async function syncPropGeom(rebuild = true): Promise<boolean> {
    const modelProps = (store.mdoc.props ?? []).filter(p => !isEffectTriggerProp(p));
    const levels = new Set(modelProps.map(p => p.level));
    const defLevels = new Set(modelProps.filter(p => p.group).map(p => p.level));
    const loads = [
      ...[...levels].filter(l => l !== AUTHORED_MODEL_LEVEL && !propLevels.has(l)).map(ensurePropLevel),
      ...[...defLevels].filter(l => !loadedGroupLevels.has(l)).map(ensureGroupDefs),
    ];
    if (!loads.length) return false;
    const changed = (await Promise.all(loads.map(load => load.then(() => true, () => false)))).some(Boolean);
    if (changed && rebuild) scheduleRebuild();
    return changed;
  }

  /**
   * Give a freshly stamped placement what the held prop carries beyond its own fields (docs/069 · Effects): the
   * held effect — a shipped model's portable one, through the slot every placement of it shares, or a copied
   * placement's own slot — and then whatever effects the model declared for itself, so a snow gun goes down
   * already throwing snow. One path for a single drop and for a prop line's members (docs/070).
   */
  function stampHeldEffects(id: string, armed: Pick<ArmedProp, 'level' | 'model' | 'name' | 'effect' | 'effectOff' | 'specialKind'>) {
    const prop = store.mdoc.props?.find(item => item.id === id);
    if (prop && armed.specialKind) prop.specialKind = armed.specialKind;
    // Before the declared effects, so a copy of an imported prop shares its source's effect rather than growing
    // a slot of its own.
    const held = armed.effect;
    if (held && !armed.effectOff) {
      const effects = (store.mdoc.effects ??= createEmptyEffectsDocument(store.mdoc.name));
      if (held.kind === 'template') attachEffectTemplateToProp(effects, id, held.template, shortPropName(armed.name));
      else if (effects.slots.some(slot => slot.id === held.slot)) attachEffectToProp(effects, id, held.slot, held.circumstance);
    }
    // Emitters and scrolling surfaces become ordinary nodes in an ordinary graph the Effects editor then owns;
    // this only fires for a prop with no attachment yet, so retuning or deleting it never touches the next stamp.
    const declared = modelDeclarations(armed.level, armed.model);
    if (declared.emitters.length || declared.scrolls.length || declared.clip) {
      const effects = (store.mdoc.effects ??= createEmptyEffectsDocument(store.mdoc.name));
      attachModelEffectsToProp(effects, id, declared);
    }
  }

  /** While set, the next prop picked up — from the Library, or middle-clicked in the world — is handed here
   *  instead of being held: a prop line swapping its model (docs/070). One-shot; answers whether it took it. */
  let pickInterceptor: ((armed: ArmedProp) => boolean) | null = null;
  function interceptNextPick(take: ((armed: ArmedProp) => boolean) | null) { pickInterceptor = take; }
  /** Offer a pick to the interceptor first; true when it took the pick and nothing should be held. */
  function intercepted(armed: ArmedProp): boolean {
    const take = pickInterceptor;
    if (!take) return false;
    pickInterceptor = null;
    return take(armed);
  }

  type Replacement = { doc: Store['mdoc']; selection: (PlacedProp | undefined)[]; targets: PlacedProp[] };
  let replacement: Replacement | null = null;

  function replacementSelection() {
    const indices = store.multiSel.length ? store.multiSel : store.selectedProp === null ? [] : [store.selectedProp];
    return [...new Set(indices)].map(index => store.mdoc.props?.[index]);
  }

  /** A replacement belongs to this document and selection, never to reused array indices after undo. */
  function isReplacingProp(): boolean {
    const request = replacement;
    if (!request) return false;
    const selection = replacementSelection();
    if (store.currentMode !== 'props' || store.mdoc !== request.doc
      || selection.length !== request.selection.length
      || selection.some(prop => !request.selection.includes(prop)) || store.armedProp) replacement = null;
    return replacement !== null;
  }

  function replaceSelectedProp() {
    const selection = replacementSelection();
    const targets = selection.filter((prop): prop is PlacedProp => !!prop && !prop.line && !isEffectTriggerProp(prop));
    if (!targets.length) return;
    // The multi-selection inspector is also available after narrowing an Edit marquee to props.
    if (store.currentMode !== 'props') setMode('props');
    pickInterceptor = null;
    replacement = { doc: store.mdoc, selection, targets };
    rebuildTools(); updateCmdSheet();
  }

  function cancelPropReplacement() {
    if (!replacement) return;
    replacement = null;
    rebuildTools(); updateCmdSheet();
  }

  /** Consume even a cancelled request, so a late asset load cannot arm a prop or replace another target. */
  function finishReplacement(request: Replacement | null, armed: ArmedProp, sourceId?: string): boolean {
    if (!request) return false;
    if (!isReplacingProp() || replacement !== request) return true;
    replacement = null;
    const { targets, doc } = request;
    let replaced = 0;
    for (const target of targets) {
      // Picking a member of the selection uses it as the source for the others, leaving its own effects intact.
      if (sourceId && sourceId === target.id) continue;
      target.id ??= nextPlacedPropId(doc.props ?? []);
      target.level = armed.level;
      target.model = armed.model;
      target.name = armed.name;
      if (armed.group) target.group = armed.group; else delete target.group;
      if (armed.specialKind) target.specialKind = armed.specialKind; else delete target.specialKind;
      applyBehaviour(target, armed.behaviour);
      if (doc.effects) detachEffectFromProp(doc.effects, target.id);
      stampHeldEffects(target.id, armed);
      replaced++;
    }
    if (replaced) {
      scheduleRebuild();
      toast(`Replaced ${replaced} prop${replaced === 1 ? '' : 's'} with ${shortPropName(armed.name)} — undo restores the original${replaced === 1 ? '' : 's'}.`, 'ok');
    }
    rebuildTools(); updateCmdSheet();
    return true;
  }

  /** Leave prop-line drawing and drop a line selection (docs/070): holding something new ends both. */
  function leavePropLine() {
    store.lineDrawing = false; viewport.setLineDrawing(false);
    store.selectedLine = null; store.selectedLineNode = null;
  }

  /** Pick up a prop (from the Library, or middle-clicking a reference / placed prop): arm placement mode, drop
   *  any placed-prop selection (so the preview shows what you're now holding), and jump to Props mode. The
   *  viewport shows it as a ghost under the cursor; a click drops it, Esc puts it down. */
  async function armProp(level: string, model: number, name: string, from: ArmFrom = {}) {
    const request = isReplacingProp() ? replacement : null;
    try { await ensurePropLevel(level); } catch (e) { toast(`props load failed: ${e}`, 'err'); return; }
    const armed: ArmedProp = { level, model, name, ...armBehaviour(level, model, from) };
    if (finishReplacement(request, armed, from.placementId)) return;
    if (intercepted(armed)) return;
    store.armedProp = armed;
    leavePropLine();
    store.selectedProp = null; // holding a new prop deselects any placed one (the gizmo releases on the next rebuild)
    store.multiSel = [];       // …and any box selection
    // …and a picked reference instance, whose inspector would otherwise sit where the held prop's panel belongs
    store.selectedRefProp = null;
    viewport.clearRefPropSelection();
    viewport.setLightArmed(false); // arming a prop cancels a held light
    store.railDrawing = false; viewport.setRailArmed(false); // …and cancels rail drawing
    store.gemArmed = false; viewport.setGemArmed(false); store.trickTool = null; // …and leaves the trick tools
    viewport.setPropArmed({ level, model, baseOffset: propBaseOffset(level, model) });
    if (store.currentMode !== 'props') setMode('props'); else { scheduleRebuild(); rebuildTools(); updateCmdSheet(); }
    propLib.highlight(level, model);
    toast(`${shortPropName(name)} — click to place · Alt+scroll or ← → turns it · Esc puts it down`, 'info');
  }

  /** Quick placement of a visible pad with its contact and boost already wired. */
  async function armBoostPad(kind: BoostPadKind) {
    try {
      const art = await fetchJson<NativeArt>('/api/props/native-art');
      const pad = art.boostPads?.[kind];
      if (!pad) {
        toast(`No ${kind} boost pad model is available. Import a course with boost pads first.`, 'err');
        return;
      }
      await ensurePropLevel(pad.level);
      await armProp(pad.level, pad.model, pad.name, {
        preset: boostPadPreset(kind, propDefaults(pad.level, pad.model).behaviour),
      });
    } catch (e) { toast(`Boost pad load failed: ${e}`, 'err'); }
  }

  async function editableGem(id: string): Promise<PlacedProp | null> {
    const doc = store.mdoc;
    const gem = doc.gems?.find(item => item.id === id);
    if (!gem) return null;
    try {
      const art = await fetchJson<NativeArt>('/api/props/native-art');
      const tier = (gem.value ?? 2) >= 5 ? 5 : (gem.value ?? 2) >= 3 ? 3 : 2;
      const source = art.gemTiers.find(item => item.tier === tier);
      if (!art.gemLevel || !source?.effect) throw new Error('Import a course with this gem’s model and effects first.');
      const library = await ensurePropLevel(art.gemLevel);
      const model = library.models.find(item => item.id === source.model);
      if (!model?.subs.length) throw new Error('The gem model has no geometry.');
      if (store.mdoc !== doc || !doc.gems?.includes(gem)) return null;
      return promoteGem(doc, id, { level: art.gemLevel, model: source.model, name: model.name },
        propDefaults(art.gemLevel, source.model).behaviour, source.effect);
    } catch (e) { toast(`Could not open gem tools: ${e instanceof Error ? e.message : e}`, 'err'); return null; }
  }

  /** Pick up a GROUP (from the Library's Groups section, or middle-clicking a placed group): arm the whole
   *  assembly for placement — the ghost previews every member; a click drops ONE placement that carries them
   *  all (docs/015). The armed leader model is what the placement stores / previews. */
  async function armGroupById(level: string, id: string, from: ArmFrom = {}) {
    const request = isReplacingProp() ? replacement : null;
    let def: GroupDef | undefined;
    try {
      await ensurePropLevel(level); // members render from the same level payload
      def = (await ensureGroupDefs(level)).find(d => d.id === id);
    } catch (e) { toast(`groups load failed: ${e}`, 'err'); return; }
    if (!def) { toast(`no group "${id}" in ${level}`, 'err'); return; }
    const leader = def.props[0];
    // A group gets no effect default: until an effect can attach to one member, it would attach to the whole
    // group, which Test plays as one prop and the ISO as one copy per member. A copied group keeps its own.
    const armed: ArmedProp = { level, model: leader.model, name: def.name, group: def.id,
      ...(from.behaviour
        ? { behaviour: stampBehaviour(level, from.behaviour), from: 'placement' as const,
          ...withEffect(placementEffect(from.placementId)) }
        : { behaviour: groupDefaults(level, def), from: 'defaults' as const }) };
    if (finishReplacement(request, armed, from.placementId)) return;
    if (intercepted(armed)) return;
    store.armedProp = armed;
    leavePropLine();
    store.selectedProp = null;
    store.multiSel = [];
    store.selectedRefProp = null;
    viewport.clearRefPropSelection();
    viewport.setLightArmed(false);
    store.railDrawing = false; viewport.setRailArmed(false);
    store.gemArmed = false; viewport.setGemArmed(false); store.trickTool = null;
    viewport.setPropArmed({ level, model: leader.model, baseOffset: placedBaseOffset({ level, model: leader.model, group: def.id }), group: def.id });
    if (store.currentMode !== 'props') setMode('props'); else { scheduleRebuild(); rebuildTools(); updateCmdSheet(); }
    propLib.highlight(level, null); // a group isn't a single model tile
    const bits = [`${def.props.length} prop${def.props.length > 1 ? 's' : ''}`];
    if (def.lights.length) bits.push(`${def.lights.length} light${def.lights.length > 1 ? 's' : ''}`);
    toast(`${def.name} (${bits.join(' + ')}) — click to place · Alt+scroll or ← → turns it · Esc puts it down`, 'info');
  }

  /** Put the held prop down (Esc in placement mode): back to select mode, where clicks grab placed props. */
  function disarmProp() {
    cancelPropReplacement();
    if (!store.armedProp) return;
    store.armedProp = null;
    viewport.setPropArmed(null);
    propLib.highlight(propLib.level, null);
    if (store.currentMode === 'props') { rebuildTools(); updateCmdSheet(); }
  }

  /** Clear whichever prop/light inspector currently owns Props mode. This is the shared path behind the
   *  visible Deselect action and Props-mode Escape, so reference callbacks, viewport decoration and the idle
   *  launcher return together. */
  function deselectPropOrLight() {
    replacement = null;
    const selected = store.selectedProp !== null || store.multiSel.length > 0 || store.selectedRefProp !== null
      || store.selectedLight !== null || store.selectedRefLight !== null || store.selectedScreen !== null
      || store.selectedRefScreen !== null || store.selectedLine !== null;
    if (!selected) return;
    leavePropLine();
    pickInterceptor = null; // a pending "swap prop" belonged to the line being let go
    store.selectedProp = null;
    store.multiSel = [];
    store.selectedRefProp = null;
    store.selectedLight = null;
    store.selectedRefLight = null;
    store.selectedScreen = null;   // a screen's inspector uses the same deselect (docs/051)
    store.selectedRefScreen = null;
    viewport.clearRefPropSelection();
    viewport.clearScreenSelection();
    scheduleRebuild();
    rebuildTools();
    updateCmdSheet();
  }

  /** Remove the selected placed prop (Delete key or the Tools button). */
  function deleteSelectedProp() {
    replacement = null;
    if (store.selectedProp === null || !store.mdoc.props) return;
    const id = store.mdoc.props[store.selectedProp]?.id;
    if (id && store.mdoc.effects) detachEffectFromProp(store.mdoc.effects, id);
    // A screen attached to this board goes with it: the thing it named no longer exists, and a rectangle
    // hanging where a billboard used to stand is worse than no screen (docs/051).
    dropScreensForProp(store.mdoc, id);
    store.mdoc.props.splice(store.selectedProp, 1);
    store.selectedProp = null;
    scheduleRebuild();
    rebuildTools();
  }

  /** Remove every box-selected prop (Delete key or the Tools button). Spliced highest-index first so the
   *  remaining doc indices stay valid while the set drains. */
  function deleteMultiSelProps() {
    replacement = null;
    if (!store.multiSel.length || !store.mdoc.props) return;
    for (const i of [...store.multiSel].sort((a, b) => b - a)) {
      const id = store.mdoc.props[i]?.id;
      if (id && store.mdoc.effects) detachEffectFromProp(store.mdoc.effects, id);
      dropScreensForProp(store.mdoc, id);
      store.mdoc.props.splice(i, 1);
    }
    store.multiSel = [];
    scheduleRebuild();
    rebuildTools();
  }

  /** Drop ONE prop from the box selection (the list row's ✕) — the prop itself stays placed. */
  function removeFromMultiSel(index: number) {
    store.multiSel = store.multiSel.filter(i => i !== index);
    scheduleRebuild(); // its outline drops; the group gizmo re-seats on the smaller set's centroid
    rebuildTools();
  }

  /** Point out one prop of the box selection (the list row click): flash it in 3D + show it in the preview card. */
  function identifyMultiProp(index: number) {
    const p = store.mdoc.props?.[index];
    if (!p) return;
    viewport.flashProp(index);
    // The prop's own id, because that is what an effect binds to — with twenty panes sharing one model name,
    // the model line says WHAT you selected and this says WHICH.
    propPreview.show(p.level, p.model, shortPropName(p.name), propLevels.get(p.level), defOfPlaced(p),
      p.id ?? `#${index}`);
  }

  /** Everything a model declared for ITSELF (docs/032), for the auto-attach a placement of it performs:
   *  emitters, plus the scrolling surfaces named by material so each lands on the right submesh. */
  function modelDeclarations(level: string, model: number): {
    emitters: { fields: Record<string, number> }[];
    scrolls: { mat: number; effect: UvScrollEffect }[];
    clip: boolean;
  } {
    const props = propLevels.get(level);
    const m = props?.models.find(x => x.id === model);
    if (!props || !m) return { emitters: [], scrolls: [], clip: false };
    const scrolls: { mat: number; effect: UvScrollEffect }[] = [];
    for (const mat of new Set(m.subs.map(s => s.mat))) {
      const effect = props.materials.get(mat)?.scroll;
      if (effect) scrolls.push({ mat, effect });
    }
    // Only an IMPORTED model's clip auto-attaches. A borrowed reference model may well have one too, but
    // that is a level's own animation and the author asks for it in the Effects editor — stamping down a
    // reference blimp should not start it flying on its own.
    return { emitters: m.emitters ?? [], scrolls,
      clip: level === IMPORTED_PROP_LEVEL && !!m.animation?.objects.length };
  }

  return {
    modelDeclarations,
    propDefaults, groupDefaults, modelEffect, placementsOfModel, saveModelDefaults, applyBehaviourToPlaced,
    stampHeldEffects, interceptNextPick,
    replaceSelectedProp, cancelPropReplacement, isReplacingProp,
    shortPropName, propBaseOffset, authoredBoxOf, rebuildAuthoredRig, defOfPlaced,
    ensureGroupDefs, placedBaseOffset, ensurePropLevel, syncPropGeom, syncAuthoredModelLevel,
    reloadImportedProps,
    armProp, armBoostPad, editableGem, armGroupById, disarmProp, deselectPropOrLight,
    deleteSelectedProp, deleteMultiSelProps, removeFromMultiSel, identifyMultiProp,
  };
}

export type PropOps = ReturnType<typeof createPropOps>;
