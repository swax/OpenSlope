/**
 * The exported map folder as a value: what is in it, and what has to go before it is written.
 *
 * An export composes the whole folder in memory and hands it to whoever owns the destination — a directory on
 * disk, a picked directory handle, a ZIP. That is what lets one export path serve all three: the composition
 * knows the folder's contents and nothing about where they land.
 */

/** One file, addressed relative to the export folder with POSIX separators. */
export interface ExportFile {
  path: string;
  bytes: Uint8Array;
}

export interface ExportFolder {
  /** Paths to clear before writing, relative to the folder; a directory clears recursively. An export is a
   *  complete snapshot of the subtrees it owns, so a retired page cannot survive from a previous run. */
  remove: string[];
  files: ExportFile[];
  /** The export report, one line per thing done — the text the dialog shows. */
  log: string[];
}

const encoder = new TextEncoder();

/** A text file as UTF-8 bytes. */
export function textFile(path: string, content: string): ExportFile {
  return { path, bytes: encoder.encode(content) };
}
