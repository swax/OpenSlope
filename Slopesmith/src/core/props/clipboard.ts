import type { AuthoredLight, PlacedProp, QuadMeshDoc, Screen, V3 } from '../doc/types';
import { nextLightId, nextScreenId } from '../doc/ids';
import { AUTHORED_MODEL_LEVEL, findModelByNumber } from '../doc/models';
import {
  attachEffectToProp, effectAttachments, nextPlacedPropId, type EffectCircumstance,
} from '../effects/authoring';
import { isEffectTriggerProp } from '../effects/trigger-volume';
import { rotateY } from './pose';
import { nextAssemblyId, wholeAssembliesIn } from './assembly';

/**
 * Copy / paste of placed props (docs/012): a snapshot of whole placements that pastes back as new ones — every
 * field, its attached video screens, and the effect slot it carries, which the pasted copy then SHARES as a
 * ＋ place copy does (docs/069 · Effects), so one edit to the effect still reaches them all.
 *
 * A set is carried by one ANCHOR: its origins' centroid, on the ground beneath it. The paste ghost hangs the set
 * off the cursor by that point and a click drops it there, turned and scaled about it as a held prop is — so a
 * set keeps its shape, and a seated prop lands seated.
 *
 * Identity is what a copy must not carry. The id is minted fresh on paste, a prop line's membership is
 * dropped (the line would replace the copy at its next re-layout, docs/070), and an Effects trigger volume is
 * not copied at all — it is authored in Effects mode as part of its graph, not placed as a prop. A copied group
 * (docs/015 · Authored groups) pastes as a new group of its own, its lights with it, and a lone member of one
 * pastes on its own.
 */

export interface PropClipboardEntry {
  /** The placement minus its identity: no `id`, no `line`. */
  prop: Omit<PlacedProp, 'id' | 'line'>;
  /** The effect slot the source carried — shared by the copy, not duplicated. */
  effect?: { slot: string; circumstance: EffectCircumstance };
  /** Screens fitted to the source, in its own frame, minus their identity and the prop they named. */
  screens: Omit<Screen, 'id' | 'prop'>[];
}

export interface PropClipboard {
  /** The mountain it was copied from. Effect slot ids and authored model numbers mean something only there. */
  mountain: string;
  /** The point the set is carried by (data space): its origins' centroid, at the ground beneath it. */
  anchor: V3;
  entries: PropClipboardEntry[];
  /** The lights of every group the copy took whole, and those selected beside the props, minus their identity —
   *  a lamp's halo comes with the lamp. */
  lights?: Omit<AuthoredLight, 'id'>[];
}

/** Where a paste lands: the anchor goes to `pos`, and the set turns `yaw` degrees and scales by `scale` about it. */
export interface PasteTransform { pos: V3; yaw: number; scale: number }

/** One placement of the paste ghost, posed relative to the anchor. */
export type PasteGhostPlacement = Pick<PlacedProp, 'level' | 'model' | 'group' | 'pos' | 'yaw' | 'pitch' | 'roll' | 'scale'>;

type PropDoc = Pick<QuadMeshDoc, 'name' | 'props' | 'lights' | 'screens' | 'effects' | 'models'>;
/** The authored terrain's height under a data-space (x, z), searched down from about `nearY`; null off it. */
type GroundAt = (x: number, z: number, nearY: number) => number | null;

/** Snapshot the placements at `indices`, with the free lights `lightIds` selected beside them. Null when none of
 *  the placements can be copied. */
export function copyPlacements(doc: PropDoc, indices: readonly number[], groundAt?: GroundAt,
  lightIds: readonly string[] = []): PropClipboard | null {
  const attachments = doc.effects ? effectAttachments(doc.effects) : [];
  const entries: PropClipboardEntry[] = [];
  for (const index of [...new Set(indices)].sort((a, b) => a - b)) {
    const source = doc.props?.[index];
    if (!source || isEffectTriggerProp(source)) continue;
    const { id: _id, line: _line, ...prop } = structuredClone(source);
    const attachment = source.id
      ? attachments.find(item => item.enabled && item.target.id === source.id) : undefined;
    const screens = source.id
      ? (doc.screens ?? []).filter(screen => screen.prop === source.id)
        .map(({ id: _screenId, prop: _prop, ...screen }) => structuredClone(screen))
      : [];
    entries.push({
      prop,
      ...(attachment ? { effect: { slot: attachment.slot, circumstance: attachment.circumstance } } : {}),
      screens,
    });
  }
  if (!entries.length) return null;
  const mean = (axis: number) => entries.reduce((sum, entry) => sum + entry.prop.pos[axis], 0) / entries.length;
  const [x, y, z] = [mean(0), mean(1), mean(2)];
  // Off the terrain (or with no terrain to ask), the lowest origin stands in for the ground.
  const ground = groundAt?.(x, z, y) ?? Math.min(...entries.map(entry => entry.prop.pos[1]));
  const groups = new Set(wholeAssembliesIn(doc, indices));
  const lights = (doc.lights ?? [])
    .filter(light => (light.assembly && groups.has(light.assembly)) || (light.id && lightIds.includes(light.id)))
    .map(({ id: _id, ...light }) => structuredClone(light));
  return { mountain: doc.name, anchor: [x, ground, z], entries, ...(lights.length ? { lights } : {}) };
}

/** The entries that can land in `doc`: one of the author's own models only on its own mountain, and only while
 *  that model still exists — the same number elsewhere names a different model. */
function pasteable(doc: PropDoc, clip: PropClipboard): PropClipboardEntry[] {
  return clip.entries.filter(entry => entry.prop.level !== AUTHORED_MODEL_LEVEL
    || (clip.mountain === doc.name && !!findModelByNumber(doc as QuadMeshDoc, entry.prop.model)));
}

/** A placement's pose after the set is carried by `at`. The turn is composed AHEAD of the placement's own
 *  rotation — yaw is the outermost of its YXZ angles — so adding it to the yaw keeps any tilt intact. */
function carried(prop: Omit<PlacedProp, 'id' | 'line'>, anchor: V3, at: PasteTransform) {
  const offset = rotateY([
    (prop.pos[0] - anchor[0]) * at.scale, (prop.pos[1] - anchor[1]) * at.scale, (prop.pos[2] - anchor[2]) * at.scale,
  ], at.yaw);
  return {
    pos: [at.pos[0] + offset[0], at.pos[1] + offset[1], at.pos[2] + offset[2]] as V3,
    yaw: ((prop.yaw + at.yaw) % 360 + 360) % 360,
    scale: prop.scale * at.scale,
  };
}

/** What the paste ghost draws: each placement that can land in `doc`, posed relative to the anchor. */
export function pasteGhost(doc: PropDoc, clip: PropClipboard): PasteGhostPlacement[] {
  return pasteable(doc, clip).map(({ prop }) => ({
    level: prop.level, model: prop.model, ...(prop.group ? { group: prop.group } : {}),
    ...(prop.pitch ? { pitch: prop.pitch } : {}), ...(prop.roll ? { roll: prop.roll } : {}),
    ...carried(prop, clip.anchor, { pos: [0, 0, 0], yaw: 0, scale: 1 }),
  }));
}

/**
 * Append the clipboard's placements to `doc` — in place, or carried by `at` — and answer the new indices and how
 * many entries could not land here. The effect is shared only on the mountain it came from, where its slot id
 * names the same slot.
 */
export function pastePlacements(doc: PropDoc, clip: PropClipboard, at?: PasteTransform):
  { indices: number[]; skipped: number; lights: string[] } {
  const props = (doc.props ??= []);
  const sameMountain = clip.mountain === doc.name;
  const entries = pasteable(doc, clip);
  const indices: number[] = [];
  // Each copied group becomes a new one, minted at its first member — so two groups in one paste stay two. A
  // group needs a prop and a second member, and its lights land only with its props.
  const groupProps = new Map<string, number>(), groupLights = new Map<string, number>();
  const count = (map: Map<string, number>, id: string | undefined) => { if (id) map.set(id, (map.get(id) ?? 0) + 1); };
  for (const { prop } of entries) count(groupProps, prop.assembly);
  for (const light of clip.lights ?? []) count(groupLights, light.assembly);
  const pastedGroup = new Map<string, string>();
  const regroup = (item: { assembly?: string }) => {
    const source = item.assembly;
    const members = source ? groupProps.get(source) ?? 0 : 0;
    if (!source || !members || members + (groupLights.get(source) ?? 0) < 2) { delete item.assembly; return; }
    let group = pastedGroup.get(source);
    if (!group) pastedGroup.set(source, (group = nextAssemblyId(doc)));
    item.assembly = group;
  };
  for (const entry of entries) {
    const id = nextPlacedPropId(props);
    const prop: PlacedProp = { id, ...structuredClone(entry.prop), ...(at ? carried(entry.prop, clip.anchor, at) : {}) };
    regroup(prop);
    indices.push(props.push(prop) - 1);
    if (entry.effect && sameMountain && doc.effects?.slots.some(slot => slot.id === entry.effect!.slot))
      attachEffectToProp(doc.effects, id, entry.effect.slot, entry.effect.circumstance);
    if (entry.screens.length) {
      const screens = (doc.screens ??= []);
      for (const screen of entry.screens) screens.push({ id: nextScreenId(screens), prop: id, ...structuredClone(screen) });
    }
  }
  const pastedLights: string[] = [];
  for (const source of clip.lights ?? []) {
    const lights = (doc.lights ??= []);
    const light: AuthoredLight = { id: nextLightId(lights), ...structuredClone(source) };
    if (at) {
      const offset = rotateY([0, 1, 2].map(k => (source.pos[k] - clip.anchor[k]) * at.scale) as V3, at.yaw);
      light.pos = [at.pos[0] + offset[0], at.pos[1] + offset[1], at.pos[2] + offset[2]];
      if (light.dir) light.dir = rotateY(light.dir, at.yaw);
      light.reach *= at.scale;
    }
    regroup(light);
    lights.push(light);
    pastedLights.push(light.id!);
  }
  return { indices, skipped: clip.entries.length - entries.length, lights: pastedLights };
}
