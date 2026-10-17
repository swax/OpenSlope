// tier: fast
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validatePlayClientMessage } from '../src/core/session/play-validators.generated.js';
import { sanitizePlayerPose } from '../src/core/session/player-pose';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/play-protocol-v1.json', import.meta.url), 'utf8')) as {
  valid: unknown[];
  invalid: unknown[];
};
for (const message of fixtures.valid) {
  assert(validatePlayClientMessage(message), 'shared fixture must be accepted by the TypeScript validator');
  if (message.t === 'pose' && message.player)
    assert(
      sanitizePlayerPose(message.player, 1000),
      'generated pose type remains compatible with the renderer sanitizer',
    );
}
for (const message of fixtures.invalid) assert(!validatePlayClientMessage(message), 'invalid fixture must be rejected');
console.log('Play protocol shared fixtures PASS');
