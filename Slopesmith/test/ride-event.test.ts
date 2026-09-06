// tier: fast

import {
  sameRideEventTarget, sanitizeRideEventMessage, type RideEventMessage,
} from '../src/core/session/ride-event';
import { check, failures } from './check';

const now = 1_800_000_000_000;
const valid: RideEventMessage = {
  target: { kind: 'reference', level: 'MEGAPLE' },
  mode: 'showoff',
  kind: 'collision',
  key: 'reference:42',
  id: 7,
  riderSpeed: 31.5,
  contact: { point: [12.5, 4, -8], normal: [0, 0.6, 0.8] },
  sentAt: now - 120,
};

const clean = sanitizeRideEventMessage(valid, now);
check(clean?.target.kind === 'reference' && clean.target.level === 'MEGAPLE'
  && clean.key === valid.key && clean.sentAt === valid.sentAt
  && clean.contact?.point[0] === 12.5 && clean.contact.normal[2] === 0.8,
'a valid interaction retains its stable target, contact frame and healthy sender-clock sample');

const authored = sanitizeRideEventMessage({ ...valid, target: { kind: 'authored' }, key: ' authored:launch ' }, now);
check(authored?.target.kind === 'authored' && authored.key === 'authored:launch',
'an authored target is canonical and bounded text is trimmed at the trust boundary');

check(sanitizeRideEventMessage({ ...valid, contact: undefined, kind: 'cracked' }, now)?.kind === 'cracked'
  && sanitizeRideEventMessage({ ...valid, contact: undefined, kind: 'cracked-heal' }, now)?.kind === 'cracked-heal'
  && sanitizeRideEventMessage({ ...valid, contact: undefined, kind: 'cracked-break' }, now)?.kind === 'cracked-break',
'crack appearance, healing and final break are explicit replayable world events');

const skewed = sanitizeRideEventMessage({ ...valid, sentAt: now + 31_000 }, now);
check(skewed?.sentAt === now, 'a badly skewed sender clock is replaced by server receive time');

for (const [name, patch] of [
  ['empty reference level', { target: { kind: 'reference', level: '' } }],
  ['unknown mode', { mode: 'halfpipe' }],
  ['unknown event kind', { kind: 'teleport' }],
  ['control characters in a key', { key: 'reference:\n42' }],
  ['negative event id', { id: -1 }],
  ['unsafe event id', { id: Number.MAX_SAFE_INTEGER + 1 }],
  ['negative rider speed', { riderSpeed: -1 }],
  ['implausible rider speed', { riderSpeed: 501 }],
  ['non-finite sender time', { sentAt: Number.NaN }],
  ['contact on a non-collision event', { kind: 'trigger' }],
  ['short contact point', { contact: { point: [1, 2], normal: [0, 1, 0] } }],
  ['zero contact normal', { contact: { point: [1, 2, 3], normal: [0, 0, 0] } }],
] as const) {
  check(sanitizeRideEventMessage({ ...valid, ...patch }, now) === null, `${name} is not relayable`);
}

check(sameRideEventTarget({ kind: 'authored' }, { kind: 'authored' })
  && sameRideEventTarget({ kind: 'reference', level: 'ALPINE' }, { kind: 'reference', level: 'ALPINE' })
  && !sameRideEventTarget({ kind: 'reference', level: 'ALPINE' }, { kind: 'reference', level: 'MEGAPLE' })
  && !sameRideEventTarget({ kind: 'authored' }, { kind: 'reference', level: 'ALPINE' }),
'only the same authored world or exact reference level accepts a shared interaction');

if (failures) process.exitCode = 1;
