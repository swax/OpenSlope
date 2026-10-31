// tier: fast
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reusableReferenceMusic } from '../src/server/reference-music-encoding';
import { REFERENCE_MUSIC_PROFILE } from '../src/shared/reference-music-encoding';
const root = await mkdtemp(join(tmpdir(), 'slopesmith-encoded-music-'));
process.env.SLOPESMITH_MAPS_ROOT = root;
const sourceSha256 = 'a'.repeat(64),
  bytes = Buffer.from('encoded sample'),
  sha256 = createHash('sha256').update(bytes).digest('hex');
const file = { path: 'Audio/Music/song/chunk_000.opus', sourceSha256, size: bytes.length, sha256 };
const folder = join(root, 'REFERENCE', 'Audio', 'Music');
try {
  await mkdir(join(folder, 'song'), { recursive: true });
  await writeFile(join(folder, 'encoding.json'), JSON.stringify({ profile: REFERENCE_MUSIC_PROFILE, files: [file] }));
  const clip = join(root, 'REFERENCE', file.path);
  await writeFile(clip, bytes);
  assert.deepEqual((await reusableReferenceMusic({ hashes: [sourceSha256] })).files, [file]);
  await writeFile(clip, Buffer.from('changed sample'));
  assert.deepEqual(
    (await reusableReferenceMusic({ hashes: [sourceSha256] })).files,
    [],
    'changed bytes invalidate the stat/hash cache',
  );
  await writeFile(clip, bytes);
  await writeFile(join(folder, 'encoding.json'), JSON.stringify({ profile: 'old-profile', files: [file] }));
  assert.deepEqual(
    (await reusableReferenceMusic({ hashes: [sourceSha256] })).files,
    [],
    'encoding profiles cannot be mixed',
  );
  await assert.rejects(reusableReferenceMusic({ hashes: ['bad hash'] }));
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(reusableReferenceMusic({ hashes: [sourceSha256] }, cancelled.signal));
  console.log('Compressed music lookup validates source/profile identities, current bytes and cancellation PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
