import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, failures, recordFailure } from './check';

/**
 * Player-capacity persistence is machine-local bootstrap configuration, so this check imports that module
 * only after redirecting its app root. Nothing here may touch the developer's real `.slopesmith/config.json`.
 */
const appRoot = mkdtempSync(join(tmpdir(), 'slopesmith-player-capacity-'));
const workspaceRoot = join(appRoot, 'workspace-test');
const mapsRoot = join(appRoot, 'maps-test');
mkdirSync(mapsRoot, { recursive: true });
process.env.SLOPESMITH_APP_ROOT = appRoot;
process.env.SLOPESMITH_WORKSPACE_ROOT = workspaceRoot;
process.env.SLOPESMITH_MAPS_ROOT = mapsRoot;

try {
  const {
    BOOTSTRAP_FILE, DEFAULT_MAX_PLAYERS, forgetWorkspaceConfig, saveWorkspaceConfig, workspaceConfig,
  } = await import('../src/server/workspace-config');

  check(DEFAULT_MAX_PLAYERS === 16 && workspaceConfig().maxPlayers === 16,
    'an installation with no saved capacity defaults to 16 players');

  let belowMinimum = '';
  try { await saveWorkspaceConfig({ maxPlayers: 0 }); }
  catch (error) { belowMinimum = String(error instanceof Error ? error.message : error); }
  check(/whole number of at least 1/i.test(belowMinimum) && !existsSync(BOOTSTRAP_FILE),
    'a value below one is refused before a configuration file is written');

  let fractional = '';
  try { await saveWorkspaceConfig({ maxPlayers: 1.5 }); }
  catch (error) { fractional = String(error instanceof Error ? error.message : error); }
  check(/whole number/i.test(fractional), 'fractional player counts are refused');

  const large = await saveWorkspaceConfig({ maxPlayers: 1_000_000 });
  const stored = JSON.parse(readFileSync(BOOTSTRAP_FILE, 'utf8')) as { maxPlayers?: number };
  check(large.config.maxPlayers === 1_000_000 && stored.maxPlayers === 1_000_000
    && large.restartRequired === false,
    'large limits are accepted without an arbitrary UI cap, persisted, and take effect without a restart');

  process.env.SLOPESMITH_MAX_PLAYERS = '23';
  forgetWorkspaceConfig();
  const overridden = workspaceConfig();
  check(overridden.maxPlayers === 23 && overridden.overrides.maxPlayers
    && overridden.overrideVars.includes('SLOPESMITH_MAX_PLAYERS'),
    'the environment can own player capacity just like the server path settings');
} catch (error) {
  recordFailure();
  console.error('FAIL', error);
} finally {
  delete process.env.SLOPESMITH_APP_ROOT;
  delete process.env.SLOPESMITH_WORKSPACE_ROOT;
  delete process.env.SLOPESMITH_MAPS_ROOT;
  delete process.env.SLOPESMITH_MAX_PLAYERS;
  rmSync(appRoot, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
else console.log('PLAYER CAPACITY PASS');
