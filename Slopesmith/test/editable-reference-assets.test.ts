// tier: fast
// environment: dom
import assert from 'node:assert/strict';
import { installTestDom } from './dom-test-support';
import { editableReferenceFixture } from './editable-reference.fixture';
import { referenceAssetId } from '../src/core/reference/asset-manifest';
import { assetVersion } from '../src/core/reference/asset-version';
import { sha256 } from '../src/core/reference/asset-hash';
import { bundleProps } from '../src/app/public/bundle-assets';
import { encodePng } from '../src/server/routes/png';

const cleanup = installTestDom();
const originalFetch = globalThis.fetch;
try {
  const { openIsoCache, cacheTransaction, isoCourseCacheVersion } = await import('../src/app/public/iso-cache');
  const { openLocalProjects, readLocalProject } = await import('../src/app/state/local-projects');
  const { editableReferenceChoice, openEditableReference } = await import('../src/app/reference/editable');
  const { lazyLocalMapData } = await import('../src/app/public/lazy-local-map-data');
  const { installLocalAssetApi } = await import('../src/app/public/local-asset-api');
  const { matchImportedAssets } = await import('../src/app/public/imported-assets');
  const { reportImportedAssetReplacements, importedAssetReplacements } = await import('../src/app/net/asset-versions');
  const course = 'TRICKY_GARI';
  const green = encodePng({ w: 1, h: 1, data: new Uint8Array([0, 255, 0, 255]) });
  const files = {
    'Import.json': new Blob([JSON.stringify({ Game: 'ssx-tricky' })]),
    'Patches.json': new Blob(['{"Patches":[]}']),
    'Materials.json': new Blob([JSON.stringify({ Materials: [{ TexturePath: 'tile.png' }] })]),
    'Models.json': new Blob([
      JSON.stringify({
        Models: [
          { ModelName: 'Tree', ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: 'tree.obj', MaterialID: 0 }] }] },
        ],
      }),
    ]),
    'Instances.json': new Blob([
      JSON.stringify({
        Instances: [{ ModelID: 0, Location: [0, 0, 0], Rotation: [0, 0, 0, 1], Scale: [1, 1, 1] }],
      }),
    ]),
    'Meshes/tree.obj': new Blob(['v 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n']),
    'Textures/tile.png': new Blob([green as BlobPart], { type: 'image/png' }),
  };
  const db = await openIsoCache();
  await cacheTransaction(db, 'files', 'readwrite', store => {
    for (const [path, blob] of Object.entries(files))
      store.put({ key: `${course}/${path.toLowerCase()}`, course, path, blob });
  });
  await cacheTransaction(db, 'courses', 'readwrite', store =>
    store.put({ course, files: Object.keys(files).length, version: isoCourseCacheVersion(course) }),
  );
  db.close();
  const oldTexture = referenceAssetId('ssx-tricky', course, 'texture', 'tile.png', 'a'.repeat(64));
  const oldProp = referenceAssetId('ssx-tricky', course, 'prop', '0', 'b'.repeat(64));
  const oldBank = assetVersion('ssx-tricky', course, 'c'.repeat(64)).id;
  const bundle = editableReferenceFixture('OLDER_IMPORTED_ASSETS');
  bundle.document.quadTex = { 0: oldTexture };
  bundle.document.models![0].texture = `${oldBank}/tile.png`;
  bundle.document.props!.push({
    id: 'prop:0001',
    level: oldProp,
    model: 0,
    name: 'Tree',
    pos: [15, 0, 15],
    yaw: 0,
    scale: 1,
  });
  const packed = (values: Float32Array | Uint32Array) => Buffer.from(values.buffer).toString('base64');
  const imported = Buffer.from(
    JSON.stringify({
      id: 0,
      name: 'Imported sign',
      subs: [
        {
          mat: 0,
          pos: packed(new Float32Array([0, 0, 0, 100, 0, 0, 0, 100, 0])),
          uv: packed(new Float32Array([0, 0, 1, 0, 0, 1])),
          idx: packed(new Uint32Array([0, 1, 2])),
        },
      ],
      materials: [{ id: 0, tex: oldTexture, frames: [] }],
    }),
  );
  const hash = await sha256(imported);
  bundle.assets.push({ kind: 'prop', name: 'sign', model: 0, hash, size: imported.length });
  bundle.blobs![hash] = imported.toString('base64');
  bundle.document.props!.push({
    id: 'prop:0002',
    level: '@import',
    model: 0,
    name: 'Imported sign',
    pos: [5, 0, 5],
    yaw: 0,
    scale: 1,
  });
  const projects = await openLocalProjects();
  const saved = await projects.seed(bundle.document, bundle);
  projects.close();
  const before = await readLocalProject(saved.project.id);
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    if (url.protocol === 'blob:') return originalFetch(input, init);
    if (url.pathname === '/api/levels') return Response.json({ levels: [], maps: [] });
    if (url.pathname === '/api/projects/server-snapshot') return Response.json(saved);
    if (url.pathname === '/api/custom-props') return Response.json(bundleProps(bundle));
    return Response.json({ error: 'No matching server asset.' }, { status: 404 });
  };
  const editorAssets = await lazyLocalMapData([course]);
  installLocalAssetApi(editorAssets, [course], false);
  try {
    const editorMatch = await matchImportedAssets(bundle.document);
    assert.equal(
      editorMatch.replacements.length,
      3,
      'the editor resolves individual assets and legacy bank references',
    );
    reportImportedAssetReplacements(editorMatch.replacements);
    const activeReplacements = importedAssetReplacements();
    const { projectAssetSource } = await import('../src/app/net/project-assets');
    const exact = await projectAssetSource(bundle);
    try {
      const catalogue = await (await exact.request('/api/levels')).json();
      assert.deepEqual(catalogue.levels, [`local:${course}`], 'snapshot readers retain imported bank casing');
      assert.equal(
        (await exact.request(`/api/texture?${new URLSearchParams({ level: oldTexture, name: 'tile.png' })}`)).status,
        404,
        'direct asset reads and exports still require the saved immutable identity',
      );
    } finally {
      exact.dispose();
    }
    for (const choice of [
      editableReferenceChoice(saved.project, 'local'),
      editableReferenceChoice({ ...saved.project, id: 'server-snapshot' }, 'server'),
    ]) {
      const reference = await openEditableReference(choice);
      try {
        const level = await (await reference.read(new URL('/api/level', location.origin))).json();
        const texture = await reference.read(
          new URL(`/api/texture?name=${level.patches[0].TexturePath}`, location.origin),
        );
        assert.equal(
          texture.status,
          200,
          `${choice.source} references must match imported terrain textures like the editor: ${await texture.clone().text()}`,
        );
        assert.deepEqual(new Uint8Array(await texture.arrayBuffer()), new Uint8Array(green));
        const props = await (await reference.read(new URL('/api/props', location.origin))).json();
        assert.equal(props.instances.length, 3, 'authored, imported and borrowed props load from the saved map');
        assert(props.models.some((model: { name: string }) => model.name === 'Tree'));
        for (const material of props.materials) {
          const texture = await reference.read(new URL(`/api/texture?name=${material.tex}`, location.origin));
          assert.equal(texture.status, 200, 'authored and borrowed prop materials use the same compatible textures');
        }
      } finally {
        reference.dispose();
      }
    }
    assert.equal(
      importedAssetReplacements(),
      activeReplacements,
      'matching a reference preserves active-project substitutions',
    );
    assert.deepEqual(
      await readLocalProject(saved.project.id),
      before,
      'matching references does not rewrite saved asset identities',
    );
  } finally {
    editorAssets.dispose();
  }
  console.log(
    'EDITABLE REFERENCE ASSETS: PASS (editor parity for older imported textures/props, Local/Server snapshots, isolation)',
  );
} finally {
  globalThis.fetch = originalFetch;
  await cleanup();
}
