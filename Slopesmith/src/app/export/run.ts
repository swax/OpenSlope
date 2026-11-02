import type { EditDoc } from '../../core/doc/doc-edit';
import { buildExportFolder, exportFolderName } from '../../core/export/folder';
import { browserExportProvider } from './provider';
import { assetVersionsIn } from '../../core/reference/asset-version';
import { pinDocumentAssets } from '../net/asset-versions';
import { isLocalWorkspace } from '../net/workspace';
import { downloadTarget, type ExportTarget } from './landing';

/**
 * An export, end to end, in the browser: compose the map folder against the HTTP byte provider, then land it.
 *
 * Everything Slopesmith writes is here. What comes after — `snowknife gltf` for Unity, `repack` for a disc —
 * is a command line, because a browser cannot spawn one and `snowknife` is the thing that holds the target's
 * slot table anyway. Every export writes `Repack.md` beside itself carrying both invocations, so the step
 * after this one is a paste rather than a remembered argument.
 */

export interface BrowserExportResult {
  folderName: string;
  /** Where it landed, as the toast and the log name it. */
  destination: string;
  log: string;
}

/** Every Snowknife export downloads a ZIP, on every browser. */
export function resolveExportTarget(doc: EditDoc): ExportTarget {
  return downloadTarget(exportFolderName(doc));
}

export async function exportMapFolder(doc: EditDoc, target: ExportTarget): Promise<BrowserExportResult> {
  await pinDocumentAssets(doc, isLocalWorkspace() ? 'local' : 'server');
  const provider = browserExportProvider({
    assetLevels: assetVersionsIn(doc),
    folderName: target.folderName,
    existingFile: path => target.existingFile(path),
  });
  const folder = await buildExportFolder(doc, provider, { lighting: true, aiPaths: true });
  const landed = await target.land(folder);
  return {
    folderName: target.folderName,
    destination: target.label,
    log: [...folder.log, '', landed].join('\n'),
  };
}
