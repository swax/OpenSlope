import { referenceFilePath, REFERENCE_MAX_FILES, type ReferenceFile } from './reference-transfer';

export const REFERENCE_MUSIC_PROFILE = 'opus-128-v1';
export const REFERENCE_MUSIC_INDEX = 'Audio/Music/encoding.json';
export interface EncodedReferenceMusic extends ReferenceFile {
  /** Hash of the supplied source: WAV before conversion, or an already encoded Opus file. */
  sourceSha256: string;
}
export interface ReferenceMusicEncoding {
  profile: typeof REFERENCE_MUSIC_PROFILE;
  files: EncodedReferenceMusic[];
}
export const encodableReferenceMusic = (path: string) => /^Audio\/(Music|Intro)\/.+\.wav$/i.test(path);
export function referenceMusicEncoding(input: unknown): ReferenceMusicEncoding {
  const value = input as ReferenceMusicEncoding | null;
  if (
    !value ||
    value.profile !== REFERENCE_MUSIC_PROFILE ||
    !Array.isArray(value.files) ||
    value.files.length > REFERENCE_MAX_FILES
  )
    throw new Error('Invalid reference music encoding index.');
  const paths = new Set<string>();
  for (const file of value.files) {
    if (
      !file ||
      !referenceFilePath(file.path) ||
      !/^Audio\/(Music|Intro)\/.+\.opus$/i.test(file.path) ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size > 64 * 1024 ** 2 ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !/^[a-f0-9]{64}$/.test(file.sourceSha256) ||
      paths.has(file.path.toLowerCase())
    )
      throw new Error('Invalid encoded reference music file.');
    paths.add(file.path.toLowerCase());
  }
  return {
    profile: REFERENCE_MUSIC_PROFILE,
    files: value.files.map(({ path, size, sha256, sourceSha256 }) => ({ path, size, sha256, sourceSha256 })),
  };
}
