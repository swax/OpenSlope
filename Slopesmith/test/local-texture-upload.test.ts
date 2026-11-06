// tier: fast
// environment: dom
import assert from 'node:assert/strict';
import { installTestDom } from './dom-test-support';
import { encodePng } from '../src/server/routes/png';
import type { ProjectBundle } from '../src/core/project/transfer';

const cleanup = installTestDom();
const { openLocalProjects, readLocalProject } = await import('../src/app/state/local-projects');
const { blankMountain } = await import('../src/core/doc/mountain');
const png = Array.from(encodePng({ w: 1, h: 1, data: new Uint8Array([255, 0, 0, 128]) }));
const projects = await openLocalProjects();
try {
  const initial = await projects.seed(blankMountain('TEXTURES'));
  const id = initial.project.id;
  const upload = (name: string) =>
    projects.request(new URL('/api/texture-upload?name=' + name, location.origin), {
      method: 'POST',
      body: new Blob([new Uint8Array(png)], { type: 'image/png' }),
    });
  const responses = await Promise.all([
    upload('same'),
    upload('same'),
    projects.request(new URL('/api/projects/' + id + '/document', location.origin), {
      method: 'PUT',
      body: JSON.stringify({
        baseRevision: initial.project.revision,
        document: { ...initial.document, name: 'EDIT_PRESERVED' },
      }),
    }),
  ]);
  const names = await Promise.all(responses.slice(0, 2).map(async response => (await response!.json()).name));
  const saved = (await readLocalProject(id)) as ProjectBundle;
  const storedBytes = Object.values(saved.blobs ?? {}).map(encoded =>
    Array.from(atob(encoded), char => char.charCodeAt(0)),
  );
  assert.deepEqual(
    responses.map(response => response!.status),
    [200, 200, 200],
  );
  assert.deepEqual(names.sort(), ['same.png', 'same_2.png']);
  assert.deepEqual(saved.assets.map(asset => asset.name).sort(), names);
  assert.deepEqual(storedBytes, [png], 'original PNG bytes are persisted once and shared by identical uploads');
  assert.equal(saved.document.name, 'EDIT_PRESERVED', 'uploading assets preserves concurrent document edits');
  const invalid = await projects.request(new URL('/api/texture-upload?name=bad', location.origin), {
    method: 'POST',
    body: new Blob(['not a PNG']),
  });
  const otherProject = await projects.request(
    new URL('/api/texture-upload?project=another&name=bad', location.origin),
    {
      method: 'POST',
      body: new Blob([new Uint8Array(png)]),
    },
  );
  assert.equal(invalid!.status, 400);
  assert.equal(otherProject!.status, 404);
  await projects.remove(id);
  assert.equal((await upload('missing'))!.status, 404);
  assert.equal(await readLocalProject(id), null);
  console.log(
    'LOCAL TEXTURE PASS: PNG bytes, concurrent uploads/edits, unique names, project scoping and deletion in Node',
  );
} finally {
  projects.close();
  await cleanup();
}
