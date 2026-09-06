import { watch } from 'node:fs';
import { relative, resolve } from 'node:path';
import { canonicalDir, isDirectory } from '../fs-async';
import { createLogger } from '../log';
import { responseCache } from '../response-cache';
import { mapsRoot } from '../workspace-config';
import { invalidateReferenceLevel, invalidateSharedLibrary } from './common';
import { clearReferenceAssetRevisions } from '../reference-asset-revisions';
import { invalidateReferenceSkyCache } from '../routes/skybox';

const log = createLogger('maps');

/** A change too broad to attribute to one level throws away every derived answer, since any of them could now
 *  be wrong. */
function forgetEverything(): void {
  responseCache.clear();
  clearReferenceAssetRevisions();
  invalidateReferenceSkyCache();
}

/** The map library lives outside the app's own tree, so watch it explicitly and invalidate generated responses
 * derived from the changed level/library. The rebuilt bytes receive a new content-derived ETag.
 *
 * The watch is recursive: a single OS-level handle reports every level folder under the root, which is what
 * makes an extraction landing hundreds of files cheap to observe. The root is read once, matching the restart
 * `saveWorkspaceConfig` already advertises for a changed map library. */
export async function watchMapsRoot(): Promise<() => void> {
  forgetEverything();
  const configured = resolve(mapsRoot());
  if (!await isDirectory(configured)) return () => {};
  // Canonical, because a recursive watch opened on an 8.3 short path aborts the process — see `canonicalDir`.
  // Everything below reads back relative to whatever was watched, so the whole function works off that path.
  const root = await canonicalDir(configured);
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    // A change the platform declines to name could be anywhere beneath the root.
    if (filename === null) { forgetEverything(); return; }
    const changed = relative(root, resolve(root, filename.toString()));
    if (changed === '') { forgetEverything(); return; }
    if (/^\.\.(?:[\\/]|$)/.test(changed)) return;
    const scope = changed.split(/[\\/]/, 1)[0];
    if (!scope) { forgetEverything(); return; }
    // Maps/Custom is legacy migration input only. Live authored catalogues are project-owned, so changing
    // that old folder must not make an editor believe its mountain-local assets changed.
    if (/^custom$/i.test(scope)) return;
    clearReferenceAssetRevisions();
    invalidateReferenceSkyCache(scope);
    if (/^shared$/i.test(scope)) invalidateSharedLibrary(scope);
    else invalidateReferenceLevel(scope);
  });
  // Losing the watch costs freshness, never correctness: every response is still ETag-validated. Say so once
  // rather than taking the service down with it.
  watcher.on('error', error => log.warn('maps watch stopped', { error }));
  return () => watcher.close();
}
