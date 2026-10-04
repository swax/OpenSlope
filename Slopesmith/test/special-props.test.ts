// tier: fast

import {
  addSpecialZone, specialPropKind, specialPropNode, teleportDestination, type SpecialDocument,
} from '../src/core/props/special';
import { bindRiderTeleport, validateEffectsAuthoring } from '../src/core/effects/authoring';
import { effectPlayCommand } from '../src/core/effects/play-runtime';
import { isEffectTriggerProp } from '../src/core/effects/trigger-volume';
import { check, failures } from './check';

const doc: SpecialDocument = { name: 'SPECIALS' };
const reset = addSpecialZone(doc, 'reset-zone', [10, -5, 20]);
const wind = addSpecialZone(doc, 'wind-zone', [30, 10, 40]);
const lift = addSpecialZone(doc, 'vertical-lift', [50, 200, 60]);
const entrance = addSpecialZone(doc, 'teleport-entrance', [70, 10, 80]);
const teleport = specialPropNode(doc.effects, entrance, 'teleport-entrance')!;
const destination = teleportDestination(doc, teleport)!;

check(doc.props?.length === 5 && destination?.specialKind === 'teleport-destination',
  'creating an entrance also creates its paired destination');
check(doc.props!.every(prop => isEffectTriggerProp(prop) && prop.nativeCollision?.responseMass === 0),
  'zones and markers use ordinary invisible, pass-through props');
check(!destination.nativeCollision?.playerCollision && destination.nativeCollision?.mode === 0,
  'the destination does not trigger rider contact');
check(effectPlayCommand(specialPropNode(doc.effects, reset, 'reset-zone')!)?.kind === 'rider-reset',
  'the reset volume is wired to the rider reset command');
check(effectPlayCommand(specialPropNode(doc.effects, wind, 'wind-zone')!)?.kind === 'directional-boost',
  'the wind box is wired to the directional force runtime');
const liftNode = specialPropNode(doc.effects, lift, 'vertical-lift')!;
const liftFields = (liftNode.payload as { type0: { type0Sub18: { U5: number } } }).type0.type0Sub18;
check(liftFields.U5 > 20000, 'the lift target starts above its own world position');
check(validateEffectsAuthoring(doc.effects!, doc.props).every(issue => issue.severity !== 'error'),
  'fresh special props have valid effects and resolved teleport references');

const second = addSpecialZone(doc, 'teleport-entrance', [0, 0, 0]);
const secondNode = specialPropNode(doc.effects, second, 'teleport-entrance')!;
bindRiderTeleport(doc.effects!, secondNode, destination.id!);
check(teleportDestination(doc, secondNode)?.id === destination.id,
  'several entrances can share a destination');
doc.props!.reverse();
destination.name = 'Renamed landing'; destination.pos = [50, 40, 30];
check(teleportDestination(doc, teleport)?.name === 'Renamed landing',
  'pairing survives destination movement, renaming and prop array reordering');
const restored: SpecialDocument = JSON.parse(JSON.stringify(doc));
const restoredEntrance = restored.props!.find(prop => prop.id === entrance.id)!;
check(specialPropKind(restoredEntrance, restored.effects) === 'teleport-entrance'
  && teleportDestination(restored, specialPropNode(restored.effects, restoredEntrance, 'teleport-entrance')!)?.id === destination.id,
  'special panels and pairing survive save/load');
delete wind.specialKind;
check(specialPropKind(wind, doc.effects) === 'wind-zone', 'older ordinary props with these effects get a special panel too');
doc.props = doc.props!.filter(prop => prop.id !== destination.id);
check(!teleportDestination(doc, teleport), 'a removed destination is reported missing, never replaced by another array row');

if (failures) process.exit(1);
console.log('special-props: all checks passed');
