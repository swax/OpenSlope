// tier: fast
import assert from 'node:assert/strict';
import { prepareReferenceMusic } from '../src/app/public/reference-music-preparation';
import { sha256 } from '../src/shared/map-asset-version';
import {
  REFERENCE_MUSIC_INDEX,
  REFERENCE_MUSIC_PROFILE,
  referenceMusicEncoding,
} from '../src/shared/reference-music-encoding';

const blob = new Blob(['original waveform']);
const sourceHash = await sha256(new Uint8Array(await blob.arrayBuffer()));
const input = await Promise.all(
  ['Audio/Music/song/chunk_000.wav', 'Audio/Intro/song-C1.wav', 'Audio/SFX/board/000.wav', 'Source/Music.wav'].map(
    async path => ({ path, blob, size: blob.size, sha256: sourceHash }),
  ),
);
const compressed = new Blob(['compressed waveform']);
const encodedHash = await sha256(new Uint8Array(await compressed.arrayBuffer()));
const signal = new AbortController().signal;
let encodes = 0;
const encode = async () => {
  encodes++;
  return compressed;
};
const fresh = await prepareReferenceMusic(
  input,
  async hashes => {
    assert.deepEqual(hashes, [sourceHash]);
    return { files: [] };
  },
  encode,
  signal,
  () => {},
);
let files = await fresh.files();
assert.equal(encodes, 1, 'identical music/intro bytes encode once');
assert.equal(files[0].blob, files[1].blob);
assert.equal(files[2], input[2], 'gameplay WAV is untouched');
assert.equal(files[3], input[3], 'source sidecar is untouched');
assert.equal(await input[0].blob.text(), 'original waveform', 'cached source is never mutated');
const index = referenceMusicEncoding(
  JSON.parse(await files.find(file => file.path === REFERENCE_MUSIC_INDEX)!.blob!.text()),
);
assert.equal(index.profile, REFERENCE_MUSIC_PROFILE);
assert.equal(index.files[0].sourceSha256, sourceHash);
assert.equal(index.files[0].sha256, encodedHash);
const reused = await prepareReferenceMusic(
  input,
  async () => ({ files: index.files }),
  encode,
  signal,
  () => {},
);
files = await reused.files();
assert.equal(encodes, 1, 'server hits skip encoding entirely');
assert.equal(files[0].blob, undefined, 'server hit needs no client payload');
await reused.materialize([0, 1]);
files = await reused.files();
assert.equal(encodes, 2, 'a disappearing donor is encoded once and can be renegotiated');
assert.equal(files[0].blob, compressed);
assert.equal(files[1].blob, compressed);
const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(
  prepareReferenceMusic(
    input,
    async () => ({ files: [] }),
    encode,
    cancelled.signal,
    () => {},
  ),
);
assert.throws(() => referenceMusicEncoding({ profile: 'unknown', files: [] }));
assert.throws(() => referenceMusicEncoding({ ...index, files: [...index.files, index.files[0]] }));
console.log('Reference music encoding, source preservation, pre-encoding reuse, donor recovery and cancellation PASS');
