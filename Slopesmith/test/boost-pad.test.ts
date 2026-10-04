// tier: fast

import { boostPadPreset } from '../src/core/props/boost-pad';
import { baselineBehaviour } from '../src/core/props/defaults';
import { effectTemplateLabel } from '../src/core/props/effect-defaults';
import { attachEffectTemplateToProp, createEmptyEffectsDocument, effectAttachments } from '../src/core/effects/authoring';
import { effectPlayCommand } from '../src/core/effects/play-runtime';
import { check, failures } from './check';

const defaults = { ...baselineBehaviour('COURSE'), modePresence: 'showoff' as const };
const effects = createEmptyEffectsDocument('BOOSTS');
for (const kind of ['speed', 'trick'] as const) {
  const preset = boostPadPreset(kind, defaults);
  check(preset.behaviour.nativeCollision.mode === 2 && preset.behaviour.nativeCollision.playerCollision
    && preset.behaviour.nativeCollision.responseMass === 0 && !preset.behaviour.nativeCollision.playerBounce
    && preset.behaviour.modePresence === undefined,
  `${kind}: contact triggers the pad without blocking the rider, in either race mode`);
  check(defaults.nativeCollision.responseMass !== 0 && defaults.modePresence === 'showoff',
    `${kind}: the source model's defaults are preserved`);
  for (let i = 0; i < 2; i++) attachEffectTemplateToProp(effects, `${kind}:${i}`, preset.effect, kind);
  const attachments = effectAttachments(effects).filter(item => item.target.id.startsWith(kind));
  check(attachments.length === 2 && attachments.every(item => item.slot === attachments[0].slot
    && item.circumstance === 'collision'), `${kind}: repeated placement shares the collision effect`);
  const slot = effects.slots.find(item => item.id === attachments[0].slot)!;
  const collision = effects.graphs.find(graph => graph.id === slot.circumstances.collision)!;
  const command = effectPlayCommand(collision.nodes[0]);
  check(kind === 'speed' ? command?.kind === 'speed-boost' && command.amount === 5
    : command?.kind === 'trick-boost' && command.seconds === 5,
  `${kind}: the placed graph executes the intended five-second gameplay command`);
  const persistent = effects.graphs.find(graph => graph.id === slot.circumstances.persistent)!;
  check(persistent.nodes[0].semanticType === 'property.uv-scroll', `${kind}: the arrows scroll without contact`);
  check(effectTemplateLabel(preset.effect).includes(`${kind} boost`), `${kind}: the inspector names the boost`);
}
check(effects.slots.length === 2, 'speed and trick pads keep separate effect slots');
const altered = boostPadPreset('speed', defaults);
altered.effect.circumstances.collision![0].payload.type17 = 20;
check(boostPadPreset('speed', defaults).effect.circumstances.collision![0].payload.type17 === 5,
  'editing one preset does not mutate the catalogue or a future hold');

if (failures) process.exit(1);
console.log('boost-pad: all checks passed');
