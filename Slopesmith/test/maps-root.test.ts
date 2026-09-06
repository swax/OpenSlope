// tier: fast

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultMapsRootFor } from '../src/server/workspace-config';
import { check, failures } from './check';

/**
 * Where the map library lives by default (docs/035).
 *
 * This is a boot-time decision every route and both file watchers are then pinned to, which is what makes
 * getting it wrong so quiet: the picker lists a different library than the one an extraction just landed in,
 * and nothing anywhere says so. It used to key off whether `Maps/` existed, so the answer depended on whether
 * anything had been extracted at the moment the server happened to start — a server started before the first
 * `snowknife import` kept reading `<workspace>/maps` forever. The rule is now a property of the CHECKOUT.
 */
const scratch = mkdtempSync(join(tmpdir(), 'slopesmith-maps-root-'));
try {
  // An OpenSlope checkout: Slopesmith beside the other components. `Maps/` is deliberately NOT created.
  const repository = join(scratch, 'OpenSlope');
  const app = join(repository, 'Slopesmith');
  mkdirSync(join(repository, 'Snowknife'), { recursive: true });
  mkdirSync(app, { recursive: true });
  const workspace = join(app, 'workspace');

  check(defaultMapsRootFor(app, workspace) === join(repository, 'Maps'),
    'checkout: the library is the repository’s own Maps/');

  // The whole point: the answer does not change once something has been extracted into it.
  mkdirSync(join(repository, 'Maps', 'GARI'), { recursive: true });
  check(defaultMapsRootFor(app, workspace) === join(repository, 'Maps'),
    'checkout: and it was already that before the folder existed');

  // A standalone clone has no OpenSlope around it, so it owns a library inside its workspace.
  const solo = join(scratch, 'slopesmith-only');
  mkdirSync(solo, { recursive: true });
  const soloWorkspace = join(solo, 'workspace');
  check(defaultMapsRootFor(solo, soloWorkspace) === join(soloWorkspace, 'maps'),
    'standalone: the library lives in the workspace');

  // A sibling `Maps` alone is not a checkout — somebody else's folder next door must not become the library.
  const bare = join(scratch, 'elsewhere', 'Slopesmith');
  mkdirSync(join(scratch, 'elsewhere', 'Maps'), { recursive: true });
  mkdirSync(bare, { recursive: true });
  check(defaultMapsRootFor(bare, join(bare, 'workspace')) === join(bare, 'workspace', 'maps'),
    'standalone: a sibling Maps/ without the checkout is not adopted');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('maps-root: all checks passed');
