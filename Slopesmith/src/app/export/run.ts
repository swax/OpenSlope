import type { EditDoc } from '../../core/doc/doc-edit';
import { buildExportFolder, exportFolderName } from '../../core/export/folder';
import { browserExportProvider } from './provider';
import {
  canPickDirectory, directoryTarget, downloadTarget, pickMapsDirectory, rememberedMapsDirectory,
  type ExportTarget,
} from './landing';

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

/**
 * Where this export should land, resolved before any bytes are fetched.
 *
 * A browser with the File System Access API writes into the folder the author picked — asked for once, then
 * remembered — so the resolution can prompt and must be reached from the click that started the export.
 * Null means the picker was dismissed: nothing was chosen, so nothing is exported.
 */
export async function resolveExportTarget(doc: EditDoc): Promise<ExportTarget | null> {
  const folderName = exportFolderName(doc);
  if (!canPickDirectory()) return downloadTarget(folderName);
  const remembered = await rememberedMapsDirectory();
  if (remembered) return directoryTarget(remembered, folderName);
  const picked = await pickMapsDirectory();
  return picked ? directoryTarget(picked, folderName) : null;
}

export async function exportMapFolder(doc: EditDoc, target: ExportTarget,
  opts?: { lighting?: boolean; aiPaths?: boolean }): Promise<BrowserExportResult> {
  const provider = browserExportProvider({
    folderName: target.folderName, existingFile: path => target.existingFile(path),
  });
  const folder = await buildExportFolder(doc, provider, { lighting: opts?.lighting, aiPaths: opts?.aiPaths });
  const landed = await target.land(folder);
  return {
    folderName: target.folderName,
    destination: target.label,
    log: [...folder.log, '', landed].join('\n'),
  };
}
