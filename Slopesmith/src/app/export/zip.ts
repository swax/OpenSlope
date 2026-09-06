import type { ExportFile } from '../../core/export/files';
import { crc32 } from './crc32';

/**
 * A store-only ZIP of the composed map folder — the export's fallback landing.
 *
 * Nothing is compressed. The folder is mostly PNG pages and WAV clips, which are already compressed and would
 * gain nothing; the text files that would compress are a rounding error beside them. Storing means the writer
 * is a header format rather than a codec, which is the whole reason this can be forty lines in the app instead
 * of a dependency.
 *
 * Entries are written under `<folderName>/`, so the archive extracts as the map folder itself wherever it is
 * opened — the same shape the directory writer produces under the picked `Maps/`.
 */
export function zipStoreOnly(folderName: string, files: readonly ExportFile[]): Blob {
  const encoder = new TextEncoder();
  const { date, time } = dosStamp(new Date());
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(`${folderName}/${file.path}`);
    const crc = crc32(file.bytes);

    const header = new Uint8Array(30 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x04034b50, true);   // local file header
    headerView.setUint16(4, 20, true);           // version needed: 2.0
    headerView.setUint16(6, 0x0800, true);       // flag bit 11: the name is UTF-8
    headerView.setUint16(8, 0, true);            // method: stored
    headerView.setUint16(10, time, true);
    headerView.setUint16(12, date, true);
    headerView.setUint32(14, crc, true);
    headerView.setUint32(18, file.bytes.length, true);
    headerView.setUint32(22, file.bytes.length, true);
    headerView.setUint16(26, name.length, true);
    header.set(name, 30);
    local.push(header, file.bytes);

    const entry = new Uint8Array(46 + name.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);    // central directory header
    entryView.setUint16(4, 20, true);            // version made by
    entryView.setUint16(6, 20, true);            // version needed
    entryView.setUint16(8, 0x0800, true);
    entryView.setUint16(10, 0, true);
    entryView.setUint16(12, time, true);
    entryView.setUint16(14, date, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, file.bytes.length, true);
    entryView.setUint32(24, file.bytes.length, true);
    entryView.setUint16(28, name.length, true);
    entryView.setUint32(42, offset, true);       // where this entry's local header sits
    entry.set(name, 46);
    central.push(entry);

    offset += header.length + file.bytes.length;
  }

  const directoryBytes = central.reduce((n, entry) => n + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);        // end of central directory
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, directoryBytes, true);
  endView.setUint32(16, offset, true);
  return new Blob([...local, ...central, end] as BlobPart[], { type: 'application/zip' });
}

/** MS-DOS packed date/time, the only timestamp a ZIP entry carries. */
function dosStamp(at: Date): { date: number; time: number } {
  return {
    date: ((Math.max(1980, at.getFullYear()) - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
  };
}
