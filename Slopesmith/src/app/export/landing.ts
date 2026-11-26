import type { ExportFolder } from '../../core/export/files';
import { zipStoreOnly } from './zip';

/** Where a composed Snowknife map folder goes after export. */
export interface ExportTarget {
  folderName: string;
  label: string;
  existingFile(path: string): Promise<boolean>;
  land(folder: ExportFolder): Promise<string>;
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function downloadTarget(folderName: string): ExportTarget {
  const filename = `${folderName}.snowknife.zip`;
  return {
    folderName,
    label: filename,
    existingFile: async () => false,
    async land(folder) {
      const blob = zipStoreOnly(folderName, folder.files);
      downloadBlob(blob, filename);
      return (
        `downloaded ${filename} — ${folder.files.length} file(s), ` +
        `${(blob.size / 1048576).toFixed(1)} MB — ready for Snowknife`
      );
    },
  };
}
