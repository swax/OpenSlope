import { mkdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(TOOL_DIR, "../../..");
export const MAPS_DIR = join(REPO_ROOT, "Maps");
export const GARI_DIR = join(MAPS_DIR, "GARI");

export function tempFile(name: string): string {
  const tempDir = join(REPO_ROOT, "temp");
  mkdirSync(tempDir, { recursive: true });
  return join(tempDir, name);
}

/**
 * How an input file is named inside a saved study. These reports are archived as research evidence and
 * quoted in docs, so they record a path relative to the repository rather than to the machine that ran
 * the tool; an input from outside the repository keeps only its file name.
 */
export function evidencePath(path: string): string {
  const rel = relative(REPO_ROOT, resolve(path));
  return rel && !rel.startsWith("..") ? rel.split(sep).join("/") : basename(path);
}
