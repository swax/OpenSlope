// Unity is a required repository component. Missing implementation or test tooling is a hard failure.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const unityRoot = join(root, 'Unity');
const unityImplementation = join(unityRoot, 'Importer', 'Editor', 'LevelImporter.cs');
const importerTests = join(unityRoot, 'tools', 'test-importer.ps1');

if (!existsSync(unityImplementation)) {
  console.error(`UNITY TESTS FAILED: required implementation is missing: ${unityImplementation}`);
  process.exit(1);
}
if (!existsSync(importerTests)) {
  console.error(`UNITY TESTS FAILED: expected importer suite is missing: ${importerTests}`);
  process.exit(1);
}

// `npm run test:unity -- GOLD` selects a fixture; any other argument is handed to the script as it is,
// so its own switches (`-UnityExe`, `-SkipExport`) work from here too.
const args = process.argv.slice(2);
const fixture = args.find(arg => !arg.startsWith('-'));
const scriptArgs = [...(fixture ? ['-Fixture', fixture] : []), ...args.filter(arg => arg !== fixture)];

const result = spawnSync('pwsh', ['-NoProfile', '-File', importerTests, ...scriptArgs], {
  cwd: root,
  env: process.env,
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(`UNITY TESTS FAILED: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
