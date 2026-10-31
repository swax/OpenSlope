/** The portable course files produced by the native importer, never the source disc itself. */
export interface ReferenceFile {
  path: string;
  size: number;
  sha256: string;
}

export interface ReferenceManifest {
  course: string;
  music: boolean;
  /** Opt in to a response naming only the files whose bytes must cross the network. */
  reuse?: boolean;
  files: ReferenceFile[];
}

export interface ReferenceUploadPlan {
  id: string;
  offset: number;
  missing?: number[];
  reusedFiles?: number;
  reusedBytes?: number;
}

export interface ServerReference {
  name: string;
  course: string;
  displayName?: string;
}

export const REFERENCE_CHUNK_BYTES = 8 * 1024 ** 2;
export const REFERENCE_MAX_BYTES = 4 * 1024 ** 3;
export const REFERENCE_MAX_FILE_BYTES = 512 * 1024 ** 2;
export const REFERENCE_MAX_FILES = 30_000;
export const referenceMusicFile = (path: string): boolean => /^Audio\/(Music|Intro)(\/|$)/i.test(path);

/** Case is retained for Linux. Reject aliases, device names and directory traversal on either server OS. */
export function referenceFilePath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length > 240) return false;
  const parts = path.split('/');
  if (
    parts.some(
      part =>
        !/^[a-z0-9_][a-z0-9_. -]*$/i.test(part) ||
        /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part),
    )
  )
    return false;
  return parts.length === 1
    ? /\.json$/i.test(path)
    : /^(Textures|Lightmaps|Meshes|Collision|Skybox|Audio|Source)$/.test(parts[0]);
}

export function referenceManifest(input: unknown): ReferenceManifest {
  const value = input as Partial<ReferenceManifest> | null;
  if (
    !value ||
    typeof value.course !== 'string' ||
    !/^[A-Z0-9][A-Z0-9_-]{0,79}$/.test(value.course) ||
    /^(SHARED|CUSTOM|RIDERS)$/.test(value.course) ||
    typeof value.music !== 'boolean' ||
    (value.reuse !== undefined && typeof value.reuse !== 'boolean') ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > REFERENCE_MAX_FILES
  )
    throw new Error('Invalid reference upload manifest.');
  let total = 0;
  const names = new Set<string>();
  const files = value.files.map(file => {
    if (
      !file ||
      !referenceFilePath(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > REFERENCE_MAX_FILE_BYTES ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      (!value.music && referenceMusicFile(file.path))
    )
      throw new Error('Invalid reference upload file.');
    const key = file.path.toLowerCase();
    if (names.has(key)) throw new Error('Duplicate reference upload path.');
    names.add(key);
    total += file.size;
    return { path: file.path, size: file.size, sha256: file.sha256 };
  });
  for (const path of names) {
    const parts = path.split('/');
    while (parts.pop() && parts.length)
      if (names.has(parts.join('/'))) throw new Error('Conflicting reference upload paths.');
  }
  if (total > REFERENCE_MAX_BYTES || !files.some(file => file.path === 'Patches.json'))
    throw new Error('Reference upload is too large or has no Patches.json.');
  return {
    course: value.course,
    music: value.music,
    ...(value.reuse === undefined ? {} : { reuse: value.reuse }),
    files,
  };
}
