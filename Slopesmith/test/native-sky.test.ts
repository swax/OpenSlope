// tier: fast
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { levelsWithMeshSky, readNativeLevelSky, skyboxFiles } from '../src/server/routes/skybox';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';

const root = await mkdtemp(join(tmpdir(), 'slopesmith-native-sky-'));
const before = process.env.SLOPESMITH_MAPS_ROOT;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
try {
  const files = new Map<string, string | Uint8Array>([
    [
      'Models.json',
      JSON.stringify({
        Models: [
          {
            ModelName: 'sky',
            ModelObjects: [
              { ParentID: -1, Position: [200, 300, 400], MeshData: [{ MeshPath: 'sky.obj', MaterialID: 0 }] },
            ],
          },
        ],
      }),
    ],
    [
      'Materials.json',
      JSON.stringify({ Materials: [{ TexturePath: 'sky.png', AlphaMode: 'cutout', RepeatTexture: true }] }),
    ],
    ['Meshes/sky.obj', 'v 0 0 0\nv 100 0 0\nv 0 100 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n'],
    ['Textures/sky.png', new Uint8Array([137, 80, 78, 71])],
  ]);
  for (const level of ['SSXOT_ER4_NIGHT', 'Measured', 'Empty']) {
    for (const [path, bytes] of files) {
      const dir = join(root, level, 'Skybox', path.includes('/') ? path.split('/')[0] : '');
      await mkdir(dir, { recursive: true });
      await writeFile(join(root, level, 'Skybox', path), bytes);
    }
  }
  await writeFile(join(root, 'Measured/Skybox/Ring.json'), '{}');
  await writeFile(join(root, 'Empty/Skybox/Models.json'), '{"Models":[]}');
  assert.deepEqual(
    await levelsWithMeshSky(),
    ['SSXOT_ER4_NIGHT'],
    'Catalogue separates original domes from measured rings and empty old night imports',
  );
  const sky = await readNativeLevelSky('SSXOT_ER4_NIGHT');
  assert(sky && sky.parts.length === 1);
  assert.equal(
    sky.parts[0].texture,
    'data:image/png;base64,iVBORw==',
    'Server embeds the exact original page with its extension preserved',
  );
  assert.equal(sky.parts[0].alphaMode, 'cutout');
  assert.equal(sky.parts[0].repeatTexture, true);
  assert.equal(sky.parts[0].indices.length, 3);
  assert.deepEqual(sky.parts[0].positions.slice(0, 3), [200, 300, 400], 'Preserve model-object rest transforms');
  const exported = await skyboxFiles({
    source: { kind: 'level', level: 'SSXOT_ER4_NIGHT' },
    on: true,
    topColor: '#112233',
  });
  for (const [path, bytes] of files) {
    assert.deepEqual(
      new Uint8Array(exported.files.find(file => file.path === `Skybox/${path}`)!.bytes),
      new Uint8Array(typeof bytes === 'string' ? Buffer.from(bytes) : bytes),
    );
    assert.deepEqual(
      await readFile(join(root, 'SSXOT_ER4_NIGHT', 'Skybox', path)),
      Buffer.from(bytes),
      'Original files remain unchanged',
    );
  }
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(exported.files.find(file => file.path === 'Skybox/Sky.json')!.bytes)),
    { Source: 'level', Level: 'SSXOT_ER4_NIGHT', TopColor: '#112233' },
  );
  assert.equal(await readNativeLevelSky('Empty'), null);
  await writeFile(
    join(root, 'SSXOT_ER4_NIGHT/Skybox/Materials.json'),
    '{"Materials":[{"TexturePath":"../outside.png"}]}',
  );
  await assert.rejects(readNativeLevelSky('SSXOT_ER4_NIGHT'), /Invalid sky file name/);
  console.log('PASS: server native sky catalogue, original PNG bytes/alpha, whole-sky export and source preservation');
} finally {
  if (before === undefined) delete process.env.SLOPESMITH_MAPS_ROOT;
  else process.env.SLOPESMITH_MAPS_ROOT = before;
  forgetWorkspaceConfig();
  await rm(root, { recursive: true, force: true });
}
