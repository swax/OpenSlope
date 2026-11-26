import type { EditDoc } from '../../core/doc/doc-edit';
import { buildExportFolder, exportFolderName } from '../../core/export/folder';
import { browserExportProvider } from './provider';
import { downloadTarget, type ExportTarget } from './landing';

export interface BrowserExportResult {
  folderName: string;
  /** Where it landed, as the toast and the log name it. */
  destination: string;
  log: string;
}

/** The CLI export downloads the composed map as a ZIP. */
export function resolveExportTarget(doc: EditDoc): ExportTarget {
  return downloadTarget(exportFolderName(doc));
}

export async function exportMapFolder(doc: EditDoc, target: ExportTarget): Promise<BrowserExportResult> {
  const provider = browserExportProvider({
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
