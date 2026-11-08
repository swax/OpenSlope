// tier: fast
// environment: dom
import assert from 'node:assert/strict';
import { installTestDom } from './dom-test-support';
import type { ProjectBundle } from '../src/core/project/transfer';

const cleanup = installTestDom();
const { openLocalProjects, readLocalProject } = await import('../src/app/state/local-projects');
const { blankMountain } = await import('../src/core/doc/mountain');
const { bundleProps } = await import('../src/app/public/bundle-assets');
const { sha256 } = await import('../src/core/reference/asset-hash');
const projects = await openLocalProjects();
const model = {
  id: 99,
  name: 'Pine',
  tris: 1,
  subs: [{ mat: 0, pos: 'AAAA', uv: 'AAAA', idx: 'AAAA' }],
  materials: [{ id: 0, tex: 'Custom/pine.png' }],
};
const upload = (workspace = projects, name = 'pine.glb', body: unknown = model) =>
  workspace.request(new URL('/api/custom-prop-import?name=' + name, location.origin), {
    method: 'POST',
    body: JSON.stringify(body),
  });
try {
  assert.equal((await upload())!.status, 404);
  const initial = await projects.seed(blankMountain('PROPS'));
  const id = initial.project.id;
  const secondTab = await openLocalProjects();
  try {
    const responses = await Promise.all([
      upload(),
      upload(secondTab, 'PINE'),
      projects.request(new URL(`/api/projects/${id}/document`, location.origin), {
        method: 'PUT',
        body: JSON.stringify({
          baseRevision: initial.project.revision,
          document: { ...initial.document, name: 'EDIT_PRESERVED' },
        }),
      }),
    ]);
    assert.deepEqual(
      responses.map(response => response!.status),
      [200, 200, 200],
    );
    const ids = await Promise.all(responses.slice(0, 2).map(async response => (await response!.json()).id));
    assert.deepEqual(ids.sort(), [0, 1], 'tabs allocate distinct model numbers, ignoring the supplied id');
    const saved = (await readLocalProject(id)) as ProjectBundle;
    assert.equal(saved.document.name, 'EDIT_PRESERVED');
    assert.deepEqual(saved.assets.map(asset => asset.name.toLowerCase()).sort(), ['pine.json', 'pine_2.json']);
    assert.deepEqual(
      bundleProps(saved)
        .models.map(model => model.id)
        .sort(),
      [0, 1],
    );
    assert.equal(bundleProps(saved).materials[1].id, 1, 'the catalogue rebases materials for each model');
    for (const asset of saved.assets) {
      const bytes = Uint8Array.from(atob(saved.blobs![asset.hash]), char => char.charCodeAt(0));
      assert.equal(await sha256(bytes), asset.hash);
      assert.equal(JSON.parse(new TextDecoder().decode(bytes)).id, asset.model);
    }
    const reopened = await openLocalProjects();
    try {
      assert.equal((await upload(reopened))!.status, 200);
      assert.equal(bundleProps(reopened.current()!).models.length, 3, 'imports survive storage reopen');
    } finally {
      reopened.close();
    }
    assert.equal((await upload(projects, 'bad', null))!.status, 400);
    assert.equal(
      (await projects.request(new URL('/api/custom-prop-import?project=other', location.origin), {
        method: 'POST',
        body: JSON.stringify(model),
      }))!.status,
      404,
    );
    await projects.remove(id);
    assert.equal((await upload(secondTab))!.status, 404, 'a stale tab cannot recreate a deleted map');
    assert.equal(await readLocalProject(id), null);
  } finally {
    secondTab.close();
  }
  console.log('LOCAL PROP PASS: concurrent imports/edits, stable ids, portable asset bytes, reopen and deletion');
} finally {
  projects.close();
  await cleanup();
}
