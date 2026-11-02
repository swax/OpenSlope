import type { ExportFolder } from '../../core/export/files';
import { zipStoreOnly } from './zip';

/** A fresh Snowknife input archive, with no files carried over from an earlier export. */
export interface ExportTarget {
  kind: 'download';
  folderName: string;
  label: string;
  existingFile(path: string): Promise<boolean>;
  land(folder: ExportFolder): Promise<string>;
}

export function downloadTarget(folderName: string): ExportTarget {
  const filename = `${folderName}.snowknife.zip`;
  return {
    kind: 'download',
    folderName,
    label: filename,
    existingFile: async () => false,
    async land(folder) {
      const blob = zipStoreOnly(folderName, folder.files);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return (
        `downloaded ${filename} — ${folder.files.length} file(s), ` +
        `${(blob.size / 1048576).toFixed(1)} MB — ready for Snowknife`
      );
    },
  };
}
