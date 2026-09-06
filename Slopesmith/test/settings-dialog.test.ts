// tier: fast

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(fileURLToPath(new URL(
  '../src/app/ui/chrome/settings-dialog.ts', import.meta.url,
)), 'utf8');
const serverSource = readFileSync(fileURLToPath(new URL(
  '../src/app/ui/chrome/settings-dialog-server.ts', import.meta.url,
)), 'utf8');

assert.match(source, /modal\(\{ sticky: true \}\)/,
  'Settings ignores clicks on the modal backdrop');
assert.match(source, /closeButton\.textContent = 'Close'/,
  'Settings has an explicit Close control');
assert.doesNotMatch(source, /const deviceName = device\.save\(\);\s*closeSettings\(\)/,
  'Save persists changes without dismissing Settings');
assert.match(serverSource, /repositoryLabel\.textContent = 'Repo'/,
  'the Server tab identifies the repository used for updates');
