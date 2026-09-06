import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { APP_ROOT } from '../src/server/workspace-config';

/**
 * The `snowknife` CLI, for the checks that assert against a real bake.
 *
 * Slopesmith itself never runs a process: the editor writes a map folder from the browser and every step past
 * that is a command an author pastes out of `Repack.md`. The tests are the other side of that — `npm run
 * smoke` asserts a REAL `snowknife gltf` over a real export, so the seam is proven end to end rather than
 * mocked — so the locator lives here, beside them, rather than in the app.
 *
 * `SLOPESMITH_SNOWKNIFE_EXE` names the binary outright; otherwise the sibling Snowknife checkout's Debug build
 * is used, which is where an OpenSlope working copy puts it.
 */

const DEBUG_EXE = join('bin', 'Debug', 'net10.0', process.platform === 'win32' ? 'snowknife.exe' : 'snowknife');

/** The CLI binary, or null when this machine has no built checkout to run. */
export function snowknifeExe(): string | null {
  const named = process.env.SLOPESMITH_SNOWKNIFE_EXE;
  if (named) return existsSync(named) ? named : null;
  const sibling = resolve(APP_ROOT, '..', 'Snowknife', 'Snowknife', DEBUG_EXE);
  return existsSync(sibling) ? sibling : null;
}

export interface SnowknifeRun {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

/** Run the CLI, or answer `null` when there is none to run — a machine without a checkout skips the
 *  bake-dependent assertions rather than failing them. */
export function runSnowknife(args: readonly string[], timeout = 120_000): SnowknifeRun | null {
  const exe = snowknifeExe();
  if (!exe) return null;
  const run = spawnSync(exe, [...args], { encoding: 'utf8', timeout, windowsHide: true });
  return { status: run.status, stdout: run.stdout ?? '', stderr: run.stderr ?? '', error: run.error?.message };
}

/** Bake an exported folder for Unity, exactly as the folder's own `Repack.md` says to. */
export function bakeGltf(dir: string, level: string): SnowknifeRun | null {
  return runSnowknife(['gltf', dir, level.toLowerCase()]);
}
