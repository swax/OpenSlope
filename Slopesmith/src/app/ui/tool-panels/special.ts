import type { PlacedProp } from '../../../core/doc/types';
import type { EffectNode } from '../../../core/effects/document';
import { bindRiderTeleport, effectAttachments } from '../../../core/effects/authoring';
import { isEffectTriggerProp } from '../../../core/effects/trigger-volume';
import {
  SPECIAL_LABELS, specialPropKind, specialPropNode, teleportDestination, type SpecialPropKind,
} from '../../../core/props/special';
import { note, tip } from '../components/gui';
import type { ToolsContext } from './widgets';

/** Compact views edit the same fields as the advanced inspectors; there is no second settings copy. */
export function buildSpecialPropTools(ctx: ToolsContext): boolean {
  const { store, gui, propPreview, scheduleRebuild, rebuildTools } = ctx;
  if (store.multiSel.length) return false;
  const prop = store.selectedProp === null ? undefined : store.mdoc.props?.[store.selectedProp];
  const held = !prop ? store.armedProp : null;
  const template = held?.effect?.kind === 'template' ? held.effect.template : undefined;
  const kind: SpecialPropKind | null = prop ? specialPropKind(prop, store.mdoc.effects)
    : template?.key.startsWith('boost-pad:speed') ? 'speed-boost'
      : template?.key.startsWith('boost-pad:trick') ? 'trick-boost' : null;
  if (!kind) return false;
  const key = prop ? `prop:${prop.id}` : `held:${held!.level}:${held!.model}`;
  if (store.specialPropView === key) {
    gui.add({ back: () => { store.specialPropView = undefined; rebuildTools(); } }, 'back')
      .name(`◀ ${SPECIAL_LABELS[kind]} settings`);
    return false;
  }
  propPreview.hide();
  gui.add({ advanced: () => { store.specialPropView = key; rebuildTools(); } }, 'advanced').name('Prop settings');
  const effects = gui.add({ effects: () => ctx.goToEffects() }, 'effects').name('Effects');
  if (!prop) { effects.disable(); tip(effects, 'Place the pad first to open its effect graph.'); }
  const section = ctx.editSection(`special-${kind}`, SPECIAL_LABELS[kind]);
  if (prop) {
    section.add(prop, 'name').name('name').onFinishChange(scheduleRebuild);
    for (const [index, label] of ['position X (m)', 'height (m)', 'position Z (m)'].entries()) {
      const value = {
        get position() { return prop.pos[index]; },
        set position(v: number) { if (Number.isFinite(v)) prop.pos[index] = v; },
      };
      section.add(value, 'position').name(label).listen().onChange(scheduleRebuild);
    }
    if (isEffectTriggerProp(prop) && kind !== 'teleport-destination') {
      for (const [index, label] of ['width (m)', 'height of box (m)', 'depth (m)'].entries()) {
        const value = {
          get size() { return prop.effectTrigger!.size[index] * prop.scale; },
          set size(v: number) { if (Number.isFinite(v)) prop.effectTrigger!.size[index] = Math.max(0.5, v) / prop.scale; },
        };
        section.add(value, 'size', 0.5, 1000, 0.5).name(label).listen().onChange(scheduleRebuild);
      }
    }
    section.add(prop, 'yaw', 0, 360, 1).name(kind === 'teleport-destination' ? 'arrival heading (°)' : 'turn (°)')
      .listen().onChange(scheduleRebuild);
  } else {
    note(section, 'Click the mountain to place. These settings apply to the next pad.');
  }
  const node = prop ? specialPropNode(store.mdoc.effects, prop, kind)
    : template?.circumstances.collision?.[0];
  const changed = () => {
    if (template) template.key = `boost-pad:${kind === 'speed-boost' ? 'speed' : 'trick'}:${JSON.stringify(template.circumstances)}`;
    if (prop) scheduleRebuild();
  };
  const scalar = (target: Record<string, unknown>, field: string, label: string, min: number, max: number,
    step: number, hint: string, factor = 1) => {
    const value = { amount: Number(target[field] ?? 0) / factor };
    tip(section.add(value, 'amount', min, max, step).name(label).onChange((v: number) => {
      if (!Number.isFinite(v)) return;
      target[field] = v * factor; changed();
    }), hint);
  };
  if (node) {
    if (kind === 'speed-boost' || kind === 'trick-boost') {
      scalar(node.payload, kind === 'speed-boost' ? 'type17' : 'type18', 'duration (seconds)', 0, 120, 0.1,
        'How long the boost window lasts.');
    } else if (kind === 'wind-zone') {
      const boost = (node.payload as { type0?: { Boost?: Record<string, unknown> } }).type0?.Boost;
      if (boost) {
        scalar(boost, 'U2', 'strength', 0, 20, 0.1, 'How quickly the rider approaches the target speed.');
        scalar(boost, 'BoostAmount', 'target speed (m/s)', 0, 200, 1, 'The speed the wind pushes toward.');
        const direction = boost.BoostDir as Record<string, number>;
        if (direction) {
          scalar(direction, 'X', 'direction X', -1, 1, 0.1, 'World-space sideways component.', -1);
          scalar(direction, 'Z', 'direction up', -1, 1, 0.1, 'Positive pushes upward.');
          scalar(direction, 'Y', 'direction Z', -1, 1, 0.1, 'World-space course-axis component.', -1);
        }
        note(section, 'Pushes while the rider is inside. Direction stays in world space when the box turns.');
      }
    } else if (kind === 'vertical-lift') {
      const lift = (node.payload as { type0?: { type0Sub18?: Record<string, unknown> } }).type0?.type0Sub18;
      if (lift) {
        scalar(lift, 'U5', 'target height (m)', -10000, 10000, 1,
          'Absolute world height. Moving the lift does not change this destination height.', 100);
        scalar(lift, 'U0', 'strength', 0, 20, 0.1, 'How quickly the rider approaches the lift speed.');
        scalar(lift, 'U1', 'lift speed (m/s)', 0, 200, 1, 'Target upward speed.');
      }
    } else if (kind === 'teleport-entrance' && prop) {
      teleportControls(ctx, section, prop, node as EffectNode);
    } else if (kind === 'gem') {
      scalar(node.payload, 'MultiplierScore', 'score multiplier', 1, 10, 1,
        'The multiplier awarded to the rider’s next trick.');
    }
    if (prop && store.mdoc.effects) {
      const attachment = effectAttachments(store.mdoc.effects).find(item => item.target.id === prop.id);
      const shares = attachment ? effectAttachments(store.mdoc.effects).filter(item => item.slot === attachment.slot).length : 0;
      if (shares > 1) note(section, `This effect is shared by ${shares} props; changing its settings changes them together.`);
    }
  } else if (kind !== 'teleport-destination') {
    note(section, 'The special effect is missing or detached. Open Effects to inspect or restore it.');
  }
  if (kind === 'reset-zone') note(section, 'An invisible catch volume. Riders touching it return to the course.');
  if (kind === 'teleport-destination' && prop) {
    note(section, 'Arrival marker: the rider arrives about 3 m beside it, facing this heading, stopped.');
    const entrances = (store.mdoc.props ?? []).filter(candidate => {
      const teleport = specialPropNode(store.mdoc.effects, candidate, 'teleport-entrance');
      return teleport && teleportDestination(store.mdoc, teleport)?.id === prop.id;
    });
    note(section, `${entrances.length} entrance${entrances.length === 1 ? '' : 's'} paired with this destination.`);
    for (const entrance of entrances) section.add({ visit: () => ctx.selectSpecialProp(entrance.id!) }, 'visit')
      .name(`Go to ${entrance.name}`);
  }
  if (prop) gui.add({ remove: ctx.deleteSelectedProp }, 'remove').name('Delete special prop');
  gui.add({ done: () => {
    store.specialPropView = undefined;
    if (held) { store.armedProp = null; ctx.viewport.setPropArmed(null); }
    ctx.deselectPropOrLight(); rebuildTools();
  } }, 'done').name(prop ? 'Deselect' : 'Cancel placement');
  return true;
}

function teleportControls(ctx: ToolsContext, section: ReturnType<ToolsContext['editSection']>,
  prop: PlacedProp, node: EffectNode) {
  const { store, scheduleRebuild, rebuildTools } = ctx;
  const current = teleportDestination(store.mdoc, node);
  const options: Record<string, string> = { '(choose destination)': '' };
  for (const candidate of store.mdoc.props ?? []) {
    if (candidate.id && candidate.id !== prop.id)
      options[`${candidate.name} · ${candidate.id}`] = candidate.id;
  }
  section.add({ destination: current?.id ?? '' }, 'destination', options).name('destination').onChange((id: string) => {
    if (id) bindRiderTeleport(store.mdoc.effects!, node, id);
    else node.references = { ...node.references, instance: null };
    scheduleRebuild(); rebuildTools();
  });
  if (current) section.add({ visit: () => ctx.selectSpecialProp(current.id!) }, 'visit').name('Go to destination');
  else note(section, 'Choose a destination before exporting this teleport.');
}
