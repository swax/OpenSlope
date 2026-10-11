import { relative, resolve } from 'node:path';
import { isDirectory } from '../fs-async';
import { createLogger } from '../log';
import { responseCache } from '../response-cache';
import { mapsRoot } from '../workspace-config';
import { invalidateReferenceLevel, invalidateSharedLibrary } from './common';
import { clearReferenceAssetRevisions } from '../reference-asset-revisions';
import { invalidateReferenceSkyCache } from '../routes/skybox';
import { watchTree } from '../watch-tree';

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
 * The watch covers the whole tree with one kernel watch per directory, never per file (`watchTree`), so an
 * extraction landing tens of thousands of files costs nothing extra to observe. The root is read once,
 * matching the restart `saveWorkspaceConfig` already advertises for a changed map library. */
export async function watchMapsRoot(): Promise<() => void> {
  forgetEverything();
  const root = resolve(mapsRoot());
  if (!await isDirectory(root)) return () => {};
  const tree = await watchTree(root, filename => {
    // A change the platform declines to name could be anywhere beneath the root.
    if (filename === null) { forgetEverything(); return; }
    const changed = relative(root, resolve(root, filename));
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
  }, {
    // Losing part of the watch costs freshness, never correctness: every response is still ETag-validated.
    // Say so rather than taking the service down with it.
    onError: error => log.warn('maps watch incomplete; edits inside the unwatched folders show only after a restart',
      { error }),
  });
  return () => tree.close();
}
