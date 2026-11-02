// tier: integration
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { encodePng } from '../src/server/routes/png';
import type { ProjectBundle } from '../src/core/project/transfer';

const png = Array.from(encodePng({ w: 1, h: 1, data: new Uint8Array([255, 0, 0, 128]) }));
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, watch: null },
});
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
try {
  await vite.listen();
  const page = await browser.newPage();
  await page.addInitScript('globalThis.__name = value => value');
  await page.route('**/upload-test.html', route =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }),
  );
  await page.goto(vite.resolvedUrls!.local[0] + 'upload-test.html');
  const result = await page.evaluate(async pixels => {
    const projectsUrl = '/src/app/state/local-projects.ts';
    const mountainUrl = '/src/core/doc/mountain.ts';
    const { openLocalProjects, readLocalProject } = await import(/* @vite-ignore */ projectsUrl);
    const { blankMountain } = await import(/* @vite-ignore */ mountainUrl);
    const projects = await openLocalProjects();
    try {
      const initial = await projects.seed(blankMountain('TEXTURES'));
      const id = initial.project.id;
      const upload = (name: string) =>
        projects.request(new URL('/api/texture-upload?name=' + name, location.origin), {
          method: 'POST',
          body: new Blob([new Uint8Array(pixels)], { type: 'image/png' }),
        });
      const responses = await Promise.all([
        upload('same'),
        upload('same'),
        projects.request(new URL(`/api/projects/${id}/document`, location.origin), {
          method: 'PUT',
          body: JSON.stringify({
            baseRevision: initial.project.revision,
            document: { ...initial.document, name: 'EDIT_PRESERVED' },
          }),
        }),
      ]);
      const names = await Promise.all(responses.slice(0, 2).map(async response => (await response.json()).name));
      const saved: ProjectBundle = await readLocalProject(id);
      const storedBytes = Object.values(saved.blobs ?? {}).map(encoded =>
        Array.from(atob(encoded), char => char.charCodeAt(0)),
      );
      const invalid = await projects.request(new URL('/api/texture-upload?name=bad', location.origin), {
        method: 'POST',
        body: new Blob(['not a PNG']),
      });
      const otherProject = await projects.request(
        new URL('/api/texture-upload?project=another&name=bad', location.origin),
        { method: 'POST', body: new Blob([new Uint8Array(pixels)]) },
      );
      await projects.remove(id);
      const removed = await upload('missing');
      return {
        statuses: responses.map(response => response.status),
        names: names.sort(),
        assetNames: saved.assets.map(asset => asset.name).sort(),
        storedBytes,
        name: saved.document.name,
        invalid: invalid.status,
        otherProject: otherProject.status,
        removed: removed.status,
        existsAfterDelete: !!(await readLocalProject(id)),
      };
    } finally {
      projects.close();
    }
  }, png);
  assert.deepEqual(result.statuses, [200, 200, 200]);
  assert.deepEqual(result.names, ['same.png', 'same_2.png']);
  assert.deepEqual(result.assetNames, result.names);
  assert.deepEqual(result.storedBytes, [png], 'the original PNG is persisted once and shared by identical uploads');
  assert.equal(result.name, 'EDIT_PRESERVED', 'uploading assets does not overwrite concurrent document edits');
  assert.equal(result.invalid, 400);
  assert.equal(result.otherProject, 404);
  assert.equal(result.removed, 404);
  assert.equal(result.existsAfterDelete, false);
  console.log(
    'PASS local PNG bytes, concurrent uploads/document edits, unique names, project scoping and deleted-map isolation',
  );
} finally {
  await browser.close();
  await vite.close();
}
