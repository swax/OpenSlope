// tier: fast
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { referenceParticleTexturePaths } from '../src/core/effects/particle-textures';
import {
  readParticleTextureBytes,
  particleTextureReference,
  readReferenceTextureBytes,
} from '../src/server/routes/textures';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { referenceMapData } from '../src/server/reference-map-paths';
import { readAssetManifest } from '../src/shared/map-asset-manifest';
import { parseAssetVersion } from '../src/core/reference/asset-version';
import { sha256 } from '../src/core/reference/asset-hash';
import {
  createFogVolume,
  particleVolumesToNative,
  cloneParticleVolume,
  normalizeParticleVolumes,
} from '../src/core/particles/volumes';
import { createEmptyEffectsDocument } from '../src/core/effects/authoring';
import { readReferenceEffects } from '../src/shared/map-effects';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-particle-sources-'));
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
const level = join(root, 'TRICKY_GARI');
mkdirSync(join(level, 'Textures', 'Particles'), { recursive: true });
writeFileSync(join(level, 'Textures', 'tile.png'), new Uint8Array([9]));
const original = new Uint8Array([1, 2, 3]);
const other = new Uint8Array([4, 5, 6]);
const profile = { Schema: 'openslope-riding-effects/v1', Enabled: true, SpriteBank: { fog0: 'particle-fog0.png' } };
writeFileSync(join(level, 'RidingEffects.json'), JSON.stringify(profile));
writeFileSync(join(level, 'Textures', 'particle-fog0.png'), original);
writeFileSync(join(level, 'Textures', 'Particles', 'fog0.png'), other);
const pinned = await particleTextureReference('fog0.png', 'TRICKY_GARI');
assert.equal(parseAssetVersion(pinned)?.kind, 'texture');
assert.equal(parseAssetVersion(pinned)?.key, 'particle-fog0.png');
assert.equal(parseAssetVersion(pinned)?.hash, await sha256(original));
assert(
  (await readAssetManifest(referenceMapData(), 'TRICKY_GARI')).assets.some(asset => asset.id === pinned),
  'fog discovery returns the ordinary manifest texture identity',
);
const native = particleVolumesToNative([createFogVolume([0, 2, 0])]);
writeFileSync(join(level, 'Effects.json'), JSON.stringify(createEmptyEffectsDocument('TRICKY_GARI')));
writeFileSync(join(level, 'Instances.json'), JSON.stringify({ Instances: [] }));
writeFileSync(join(level, 'ParticleInstances.json'), JSON.stringify(native.instances));
writeFileSync(join(level, 'ParticleModels.json'), JSON.stringify(native.models));
const reference = await readReferenceEffects(referenceMapData(), 'TRICKY_GARI');
assert.equal(reference.particleVolumes?.[0].texture, pinned, 'native reference fog exposes its asset2 texture');
const copy = cloneParticleVolume(reference.particleVolumes![0], []);
assert.equal(
  normalizeParticleVolumes(JSON.parse(JSON.stringify([copy])))[0].texture,
  pinned,
  'copying and saving a reference fog volume retains its exact texture',
);
assert.deepEqual(
  new Uint8Array(await readReferenceTextureBytes('TRICKY_GARI', 'particles/fog0.png')),
  other,
  'ordinary texture reads support nested particle paths and case-independent asset2 keys',
);
await assert.rejects(readReferenceTextureBytes('TRICKY_GARI', '../outside.png'), /no reference texture/);
assert.deepEqual(
  new Uint8Array(await readParticleTextureBytes('fog0.png', 'TRICKY_GARI')),
  original,
  'native SpriteBank filenames take precedence over conventional filenames',
);
unlinkSync(join(level, 'Textures', 'particle-fog0.png'));
await assert.rejects(
  readParticleTextureBytes('fog0.png', 'TRICKY_GARI'),
  /no shared particle texture/,
  'a declared file that is absent never becomes another same-named sprite',
);
await assert.rejects(particleTextureReference('fog0.png', 'TRICKY_GARI'), /no shared particle texture/);
unlinkSync(join(level, 'RidingEffects.json'));
assert.deepEqual(
  new Uint8Array(await readParticleTextureBytes('fog0.png', 'TRICKY_GARI')),
  other,
  'Snowknife Particles folders keep resolving without a profile',
);
unlinkSync(join(level, 'Textures', 'Particles', 'fog0.png'));
writeFileSync(join(level, 'Textures', 'fog0.png'), original);
assert.deepEqual(
  new Uint8Array(await readParticleTextureBytes('fog0.png', 'TRICKY_GARI')),
  original,
  'legacy root-level sprite files remain supported',
);
assert.deepEqual(referenceParticleTexturePaths('FOG0.PNG', profile), ['particle-fog0.png']);
assert.deepEqual(
  referenceParticleTexturePaths('ex06.png', {
    ...profile,
    Puff: 'adapted-puff.png',
    SpriteBank: { ex06: 'actual-explosion.png' },
  }),
  ['actual-explosion.png'],
  'an explicit native sprite wins over a generic riding puff',
);
assert.deepEqual(referenceParticleTexturePaths('spry.png', { ...profile, Sheet: 'Sprites/spray.png' }), [
  'Sprites/spray.png',
]);
for (const file of ['../outside.png', '/absolute.png', 'bad\\path.png', '', null])
  assert.deepEqual(
    referenceParticleTexturePaths('fog0.png', { ...profile, SpriteBank: { fog0: file } }),
    [],
    'unsafe or invalid declared sprite paths remain unavailable',
  );
assert.deepEqual(referenceParticleTexturePaths('../fog0.png', profile), []);
console.log('PASS native particle sprite mappings, unchanged source bytes, legacy layouts and missing-source errors');
