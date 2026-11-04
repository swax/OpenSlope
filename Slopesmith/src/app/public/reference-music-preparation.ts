import { sha256 } from '../../shared/map-asset-version';
import {
  encodableReferenceMusic,
  referenceMusicEncoding,
  REFERENCE_MUSIC_INDEX,
  REFERENCE_MUSIC_PROFILE,
  type EncodedReferenceMusic,
} from '../../shared/reference-music-encoding';
import type { ReferenceFile } from '../../shared/reference-transfer';

export interface PreparedReferenceFile extends ReferenceFile {
  blob?: Blob;
}
export async function prepareReferenceMusic(
  input: Array<ReferenceFile & { blob: Blob }>,
  lookup: (hashes: string[]) => Promise<{ files: EncodedReferenceMusic[] }>,
  encode: (blob: Blob) => Promise<Blob>,
  signal: AbortSignal,
  progress: (message: string) => void,
) {
  const compressedMusic = input.filter(file => /^Audio\/(Music|Intro)\/.+\.opus$/i.test(file.path));
  const existingIndex = input.find(file => file.path === REFERENCE_MUSIC_INDEX);
  const existingMusic = existingIndex
    ? referenceMusicEncoding(JSON.parse(await existingIndex.blob.text())).files
    : [];
  const previous = new Map(existingMusic.map(file => [file.path, file]));
  const sources = new Map(
    input.filter(file => encodableReferenceMusic(file.path)).map(file => [file.sha256, file.blob]),
  );
  const encoded = new Map<string, Omit<EncodedReferenceMusic, 'path'> & { blob?: Blob }>();
  if (sources.size) {
    progress('Checking for compressed music on the server…');
    const found = referenceMusicEncoding({ profile: REFERENCE_MUSIC_PROFILE, ...(await lookup([...sources.keys()])) });
    for (const file of found.files) if (sources.has(file.sourceSha256)) encoded.set(file.sourceSha256, file);
  }
  async function convert(hash: string) {
    signal.throwIfAborted();
    progress(`Compressing reference music… ${encoded.size}/${sources.size}`);
    const blob = await encode(sources.get(hash)!);
    signal.throwIfAborted();
    encoded.set(hash, {
      sourceSha256: hash,
      size: blob.size,
      sha256: await sha256(new Uint8Array(await blob.arrayBuffer())),
      blob,
    });
  }
  for (const hash of sources.keys()) if (!encoded.has(hash)) await convert(hash);
  const original =
    sources.size || compressedMusic.length ? input.filter(file => file.path !== REFERENCE_MUSIC_INDEX) : input;
  return {
    async files(): Promise<PreparedReferenceFile[]> {
      const music: EncodedReferenceMusic[] = [];
      const files = original.map(file => {
        if (/^Audio\/(Music|Intro)\/.+\.opus$/i.test(file.path)) {
          const old = previous.get(file.path);
          // Native SSX 3/On Tour imports already encode to the same Opus profile.
          // Preserve a verified WAV identity when available; otherwise index the supplied Opus bytes.
          music.push({
            path: file.path,
            size: file.size,
            sha256: file.sha256,
            sourceSha256:
              old?.sha256 === file.sha256 && old.size === file.size ? old.sourceSha256 : file.sha256,
          });
          return file;
        }
        if (!encodableReferenceMusic(file.path)) return file;
        const result = encoded.get(file.sha256)!;
        const path = file.path.replace(/\.wav$/i, '.opus');
        music.push({ path, sourceSha256: file.sha256, size: result.size, sha256: result.sha256 });
        return { path, size: result.size, sha256: result.sha256, blob: result.blob };
      });
      if (music.length) {
        const blob = new Blob([JSON.stringify({ profile: REFERENCE_MUSIC_PROFILE, files: music })], {
          type: 'application/json',
        });
        files.push({
          path: REFERENCE_MUSIC_INDEX,
          blob,
          size: blob.size,
          sha256: await sha256(new Uint8Array(await blob.arrayBuffer())),
        });
      }
      return files;
    },
    async materialize(indices: readonly number[]) {
      // A donor can disappear between lookup and negotiation. Encode its original clip, then negotiate fresh hashes.
      for (const index of indices) {
        const file = original[index];
        if (file && encodableReferenceMusic(file.path) && !encoded.get(file.sha256)?.blob) await convert(file.sha256);
      }
    },
  };
}
