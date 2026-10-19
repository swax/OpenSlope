// The SDK's whitespace formatter handles Unity C# without loading a Unity project or its SDK packages.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--check')) {
  console.error('Usage: node tools/format-unity.mjs [--check]');
  process.exit(1);
}

const check = args.includes('--check');
let exitCode = 0;
// Enable editor code and opt-in reload diagnostics in both passes. Only the version-specific symbol varies.
for (const [profile, symbols] of [
  ['Unity 2022', ''],
  ['Unity 6', 'UNITY_6000_0_OR_NEWER'],
]) {
  console.log(`${check ? 'Checking' : 'Formatting'} Unity C# sources (${profile})`);
  const result = spawnSync(
    'dotnet',
    [
      'format',
      'whitespace',
      'Unity/tools/Unity.Formatting.csproj',
      '--no-restore',
      ...(check ? ['--verify-no-changes'] : []),
    ],
    {
      cwd: root,
      env: { ...process.env, OpenSlopeUnityFormatSymbols: symbols },
      stdio: 'inherit',
      windowsHide: true,
    },
  );
  if (result.error) {
    console.error(`Unity formatter failed: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) exitCode = result.status ?? 1;
}
process.exit(exitCode);
