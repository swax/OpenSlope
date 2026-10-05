// tier: fast

import assert from 'node:assert/strict';
import { chatTime } from '../src/app/ui/chrome/chat-box';

assert.equal(chatTime(new Date(2026, 9, 4, 9, 5).getTime()), '09:05', 'hours and minutes are zero-padded');
assert.equal(chatTime(new Date(2026, 9, 4, 23, 59, 59).getTime()), '23:59', 'seconds are dropped, not rounded up');
assert.equal(chatTime(new Date(2026, 9, 4, 0, 0).getTime()), '00:00', 'midnight reads as 00:00');

console.log('CHAT TIME: PASS');
