import type { NativeCollisionProfile, PlacedProp, V3 } from '../../core/doc/types';
import { AUTHORED_MODEL_LEVEL, authoredModelLevelProps } from '../../core/doc/models';
import { IMPORTED_PROP_LEVEL } from '../../core/props/imported';
import { isEffectTriggerProp } from '../../core/effects/trigger-volume';
import { collisionProfileFromSourceInstance, defaultPlacedPropCollision } from '../../core/props/contact';
import { detachEffectFromProp } from '../../core/effects/authoring';
import { decodeProps, type LevelProps, type PropsPayload } from '../../core/reference/props';
import type { UvScrollEffect } from '../../core/effects/world-effects';
import { authoredSignLights, authoredFreeLights, type LocalBox } from '../../core/lighting/sign-lights';
import { authoredGroupLights, type GroupDef, type GroupsPayload } from '../../core/reference/groups';
import type { Store } from '../state/store';
import type { Mode, Viewport } from '../viewport/viewport';
import type { PropLibrary } from './library';
import type { PropPreview } from './preview';
import { dropScreensForProp } from './screens';
import { toast } from '../ui/components/toast';
import { fetchJson } from '../net/fetch-json';
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
  const propLoadsByLevel = new Map<string, Promise<LevelProps>>(); // in-flight /api/props fetches, one per level

  /** Short prop label: drop the "Mdl_" prefix and the trailing "_<n>" instance suffix (matches the library). */
  const shortPropName = (n: string) => n.replace(/^Mdl_/, '').replace(/_\d+$/, '');

  type PlacementContactDefaults = {
    nativeCollision?: NativeCollisionProfile;
    /** Native instance copied directly from the reference viewport (MMB). */
    sourceIndex?: number;
    /** Backward-compatible call shape for older/library callers; compiled once into the complete profile. */
    solid?: boolean;
    bounce?: number;
    surface?: number;
    /** Semantic event-layer setting; raw native LTG integers never enter the authored document. */
    modePresence?: 'showoff';
  };

  function placementCollision(level: string, contact: PlacementContactDefaults): NativeCollisionProfile {
    if (contact.nativeCollision) return structuredClone(contact.nativeCollision);
    const source = typeof contact.sourceIndex === 'number'
      ? propLevels.get(level)?.instances.find(instance => instance.sourceIndex === contact.sourceIndex) : undefined;
    if (source) return collisionProfileFromSourceInstance(level, source);
    const out = defaultPlacedPropCollision(level);
    if (typeof contact.solid === 'boolean') {
      out.mode = contact.solid ? 1 : 0;
      out.playerCollision = contact.solid;
      out.responseMass = contact.solid ? 1e30 : 0;
      out.playerBounce = contact.solid;
      out.bounceAmount = contact.solid ? 0.5 : 0;
    }
    if (typeof contact.bounce === 'number') out.bounceAmount = Math.max(0, contact.bounce);
    return out;
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
   *  placements, its mined group defs — then optionally re-render. Undo uses the retry; progressive document
   *  loading passes false because it waits for these assets before its one object-render stage. */
  async function syncPropGeom(rebuild = true) {
    const modelProps = (store.mdoc.props ?? []).filter(p => !isEffectTriggerProp(p));
    const levels = new Set(modelProps.map(p => p.level));
    if (!levels.size) return;
    const defLevels = new Set(modelProps.filter(p => p.group).map(p => p.level));
    await Promise.all([
      ...[...levels].map(l => ensurePropLevel(l).catch(() => null)),
      ...[...defLevels].map(l => ensureGroupDefs(l).catch(() => null)),
    ]);
    if (rebuild) scheduleRebuild();
  }

  /** Pick up a prop (from the Library, or middle-clicking a reference / placed prop): arm placement mode, drop
   *  any placed-prop selection (so the preview shows what you're now holding), and jump to Props mode. The
   *  viewport shows it as a ghost under the cursor; a click drops it, Esc puts it down. */
  async function armProp(level: string, model: number, name: string,
    contact: PlacementContactDefaults = {}) {
    try { await ensurePropLevel(level); } catch (e) { toast(`props load failed: ${e}`, 'err'); return; }
    const source = typeof contact.sourceIndex === 'number'
      ? propLevels.get(level)?.instances.find(instance => instance.sourceIndex === contact.sourceIndex) : undefined;
    store.armedProp = { level, model, name,
      nativeCollision: placementCollision(level, contact),
      ...(contact.modePresence === 'showoff' || source?.ltgState === 2 ? { modePresence: 'showoff' as const } : {}),
      ...(typeof contact.surface === 'number' ? { surface: contact.surface }
        : source && source.surface >= 0 ? { surface: source.surface } : {}) };
    store.selectedProp = null; // holding a new prop deselects any placed one (the gizmo releases on the next rebuild)
    store.multiSel = [];       // …and any box selection
    viewport.setLightArmed(false); // arming a prop cancels a held light
    store.railDrawing = false; viewport.setRailArmed(false); // …and cancels rail drawing
    store.gemArmed = false; viewport.setGemArmed(false); store.trickTool = null; // …and leaves the trick tools
    viewport.setPropArmed({ level, model, baseOffset: propBaseOffset(level, model) });
    if (store.currentMode !== 'props') setMode('props'); else { scheduleRebuild(); rebuildTools(); updateCmdSheet(); }
    propLib.highlight(level, model);
    toast(`${shortPropName(name)} — click to place · scroll turns it · Esc puts it down`, 'info');
  }

  /** Pick up a GROUP (from the Library's Groups section, or middle-clicking a placed group): arm the whole
   *  assembly for placement — the ghost previews every member; a click drops ONE placement that carries them
   *  all (docs/015). The armed leader model is what the placement stores / previews. */
  async function armGroupById(level: string, id: string,
    contact: PlacementContactDefaults = {}) {
    let def: GroupDef | undefined;
    try {
      await ensurePropLevel(level); // members render from the same level payload
      def = (await ensureGroupDefs(level)).find(d => d.id === id);
    } catch (e) { toast(`groups load failed: ${e}`, 'err'); return; }
    if (!def) { toast(`no group "${id}" in ${level}`, 'err'); return; }
    const leader = def.props[0];
    store.armedProp = { level, model: leader.model, name: def.name, group: def.id,
      nativeCollision: placementCollision(level, contact),
      ...(contact.modePresence === 'showoff' ? { modePresence: 'showoff' as const } : {}),
      ...(typeof contact.surface === 'number' ? { surface: contact.surface } : {}) };
    store.selectedProp = null;
    store.multiSel = [];
    viewport.setLightArmed(false);
    store.railDrawing = false; viewport.setRailArmed(false);
    store.gemArmed = false; viewport.setGemArmed(false); store.trickTool = null;
    viewport.setPropArmed({ level, model: leader.model, baseOffset: placedBaseOffset({ level, model: leader.model, group: def.id }), group: def.id });
    if (store.currentMode !== 'props') setMode('props'); else { scheduleRebuild(); rebuildTools(); updateCmdSheet(); }
    propLib.highlight(level, null); // a group isn't a single model tile
    const bits = [`${def.props.length} prop${def.props.length > 1 ? 's' : ''}`];
    if (def.lights.length) bits.push(`${def.lights.length} light${def.lights.length > 1 ? 's' : ''}`);
    toast(`${def.name} (${bits.join(' + ')}) — click to place · scroll turns it · Esc puts it down`, 'info');
  }

  /** Put the held prop down (Esc in placement mode): back to select mode, where clicks grab placed props. */
  function disarmProp() {
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
    const selected = store.selectedProp !== null || store.multiSel.length > 0 || store.selectedRefProp !== null
      || store.selectedLight !== null || store.selectedRefLight !== null || store.selectedScreen !== null
      || store.selectedRefScreen !== null;
    if (!selected) return;
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
    shortPropName, propBaseOffset, authoredBoxOf, rebuildAuthoredRig, defOfPlaced,
    ensureGroupDefs, placedBaseOffset, ensurePropLevel, syncPropGeom, syncAuthoredModelLevel,
    reloadImportedProps,
    armProp, armGroupById, disarmProp, deselectPropOrLight,
    deleteSelectedProp, deleteMultiSelProps, removeFromMultiSel, identifyMultiProp,
  };
}

export type PropOps = ReturnType<typeof createPropOps>;
