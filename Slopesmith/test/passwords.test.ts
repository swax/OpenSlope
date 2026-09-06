// tier: fast

import assert from 'node:assert/strict';
import { MIN_PASSWORD_LENGTH } from '../src/core/accounts/password-policy';
import { assertUsablePassword, hashPassword, verifyPassword } from '../src/server/accounts/passwords';

const valid = 'a'.repeat(MIN_PASSWORD_LENGTH);

assert.throws(() => assertUsablePassword('a'.repeat(MIN_PASSWORD_LENGTH - 1)),
  new RegExp(`at least ${MIN_PASSWORD_LENGTH} characters`));
assert.doesNotThrow(() => assertUsablePassword(valid));

const stored = await hashPassword(valid);
assert.equal(await verifyPassword(valid, stored), true);
assert.equal(await verifyPassword(`${valid}x`, stored), false);
assert.equal(await verifyPassword(valid, 'not-a-password-record'), false);

console.log('password policy and verification: pass');
