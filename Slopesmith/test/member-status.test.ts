// tier: fast

import assert from 'node:assert/strict';
import { effectiveMemberStatus, isManualAvailability } from '../src/core/session/member-status';

assert.equal(effectiveMemberStatus('available', []), 'offline',
  'a saved preference does not make a disconnected member present');
assert.equal(effectiveMemberStatus('available', [false]), 'online',
  'one active tab makes an available member online');
assert.equal(effectiveMemberStatus('available', [true, true]), 'idle',
  'all connected tabs must be idle before the member is idle');
assert.equal(effectiveMemberStatus('available', [true, false]), 'online',
  'an active tab outranks another idle tab');
assert.equal(effectiveMemberStatus('away', [false]), 'away',
  'manual Away overrides activity while connected');
assert.equal(effectiveMemberStatus('dnd', [true]), 'dnd',
  'manual Do Not Disturb overrides automatic idle');
assert.equal(effectiveMemberStatus('dnd', []), 'offline',
  'disconnecting still shows Offline while retaining the preference for next time');
assert.equal(isManualAvailability('idle'), false,
  'automatic Idle is not accepted as a durable manual preference');

console.log('MEMBER STATUS: PASS');
