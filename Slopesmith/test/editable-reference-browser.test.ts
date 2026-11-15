// browser: smoke
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { editableReferenceFixture } from './editable-reference.fixture';
import { authoredPatches } from '../src/app/reference/authored';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { createProject, openProject } from '../src/server/projects';
import { encodePng, decodePng } from '../src/server/routes/png';
import type { Viewport } from '../src/app/viewport/viewport';
import type { QuadMeshDoc, V3 } from '../src/core/doc/types';
import type { ProjectBundle } from '../src/core/project/transfer';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-editable-reference-'));
const maps = join(root, 'Maps');
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = maps;
mkdirSync(maps);
forgetWorkspaceConfig();
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
const source = editableReferenceFixture();
const active = editableReferenceFixture('ACTIVE_MOUNTAIN');
active.document.models![0].vertices[4] = 30;
const sourceProject = await createProject(source.document);
const activeProject = await createProject(active.document);
const green = encodePng({ w: 2, h: 2, data: new Uint8Array(Array.from({ length: 4 }, () => [0, 255, 0, 255]).flat()) });
for (const project of [sourceProject, activeProject]) {
  const folder = join(project.project.folder!, 'assets', 'textures');
  mkdirSync(folder, { recursive: true });
  writeFileSync(
    join(folder, 'shared.png'),
    project === sourceProject ? green : encodePng({ w: 1, h: 1, data: new Uint8Array([255, 0, 255, 255]) }),
  );
}
const originalFolder = join(maps, 'MAP_FOLDER');
mkdirSync(originalFolder);
writeFileSync(join(originalFolder, 'Patches.json'), JSON.stringify({ Patches: authoredPatches(source.document) }));
writeFileSync(join(originalFolder, 'Instances.json'), '{"Instances":[]}');
writeFileSync(join(originalFolder, 'Models.json'), '{"Models":[]}');
writeFileSync(join(originalFolder, 'Materials.json'), '{"Materials":[]}');
const filesBefore = readdirSync(maps, { recursive: true });
const localBundle = editableReferenceFixture();
const yellow = encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 0, 255]) });
const hash = createHash('sha256').update(yellow).digest('hex');
localBundle.assets = [{ kind: 'texture', name: 'shared.png', hash, size: yellow.length }];
localBundle.blobs = { [hash]: yellow.toString('base64') };
type Observation = {
  slopesmith: { doc(): QuadMeshDoc; errors(): unknown[]; settled(): Promise<unknown> };
  referenceState(): { level: string; draws: number; offset: V3 };
  moveReference(offset: V3): void;
  frameReference(): number[];
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
try {
  await vite.listen();
  const base = vite.resolvedUrls!.local[0];
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript('globalThis.__name = value => value');
  await page.goto(base + 'maps');
  const localId = await page.evaluate(async serialized => {
    const moduleName = '/src/app/state/local-projects.ts';
    const { openLocalProjects } = (await import(moduleName)) as typeof import('../src/app/state/local-projects');
    const projects = await openLocalProjects({ restoreActive: false });
    try {
      return (await projects.restore(JSON.parse(serialized) as ProjectBundle, false)).project.id;
    } finally {
      projects.close();
    }
  }, JSON.stringify(localBundle));
  const url = base + `editor/ACTIVE_MOUNTAIN?project=${activeProject.project.id}&agent=1`;
  const loaded = () =>
    page!.waitForFunction(
      () =>
        !!(window as unknown as Observation).slopesmith &&
        document.querySelector('#load-status')?.getAttribute('aria-busy') === 'false',
      undefined,
      { timeout: 90_000 },
    );
  const capture = async () => {
    await page!.evaluate(async () => {
      const moduleName = '/src/app/viewport/viewport.ts';
      const { Viewport: ViewportClass } = (await import(moduleName)) as { Viewport: { prototype: Viewport } };
      const prototype = ViewportClass.prototype;
      const mode = Object.getOwnPropertyDescriptor(prototype, 'mode')!;
      Object.defineProperty(prototype, 'mode', {
        ...mode,
        set(value) {
          Object.defineProperty(prototype, 'mode', mode);
          mode.set!.call(this, value);
          const viewport = this as Viewport;
          (window as unknown as Observation).referenceState = () => ({
            level: viewport.refLevelName,
            draws: viewport.refDecor.propDrawMeshes.length,
            offset: viewport.referenceOffset(),
          });
          (window as unknown as Observation).moveReference = offset => {
            viewport.setReferenceOffset(offset);
            viewport.stage.cb.onMoveReference?.();
          };
          (window as unknown as Observation).frameReference = () => {
            viewport.applyView({
              pos: [100, 240, -30],
              target: [100, 0, -30],
              up: [0, 0, -1],
              ortho: true,
              zoom: 1,
              orthoHalfH: 140,
            });
            viewport.stage.refRoot.updateWorldMatrix(true, true);
            const point = viewport.stage.camera.position
              .clone()
              .set(30, 0, 30)
              .applyMatrix4(viewport.stage.refRoot.matrixWorld)
              .project(viewport.stage.camera);
            const rect = viewport.stage.renderer.domElement.getBoundingClientRect();
            return [rect.x + ((point.x + 1) * rect.width) / 2, rect.y + ((1 - point.y) * rect.height) / 2];
          };
        },
      });
    });
    await page!.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page!.getByRole('button', { name: 'Scene', exact: true }).first().click();
  };
  await page.goto(url);
  await loaded();
  await capture();
  const before = await page.evaluate(() => (window as unknown as Observation).slopesmith.doc());
  const writes: string[] = [];
  page.on('request', request => {
    if (request.method() !== 'GET' && request.url().includes(sourceProject.project.id)) writes.push(request.url());
  });
  const choose = async (storage: string, id: string) => {
    await page!.getByLabel('Reference source', { exact: true }).selectOption(storage);
    await page!.getByLabel('Reference game', { exact: true }).selectOption('slopesmith');
    await page!.getByLabel('Reference map', { exact: true }).selectOption(`${storage}:@project:${id}`);
    await page!.getByRole('button', { name: 'Load reference', exact: true }).click();
    await loaded();
    await page!.waitForFunction(
      id =>
        (window as unknown as Observation).referenceState().level.includes(id) &&
        (window as unknown as Observation).referenceState().draws > 0,
      id,
    );
  };
  const pixels = () =>
    page!.evaluate(async () => {
      const moduleName = '/src/app/net/workspace.ts';
      const { workspaceFetch } = (await import(moduleName)) as typeof import('../src/app/net/workspace');
      const id = (window as unknown as Observation).referenceState().level;
      const result = await workspaceFetch(`/api/level?name=${encodeURIComponent(id)}`);
      const level = await result.json();
      const response = await workspaceFetch(
        `/api/texture?level=${encodeURIComponent(id)}&name=${level.patches[0].TexturePath}`,
      );
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0, 1, 1);
      bitmap.close();
      return [...context.getImageData(0, 0, 1, 1).data];
    });
  await choose('server', sourceProject.project.id);
  assert.deepEqual(
    await pixels(),
    [0, 255, 0, 255],
    'server reference art comes from the source map, not the active map',
  );
  assert.match(await page.getByLabel('Reference map').inputValue(), /server:@project:/);
  await page.evaluate(() => (window as unknown as Observation).moveReference([140, 3, 7]));
  const point = await page.evaluate(() => (window as unknown as Observation).frameReference());
  await page.evaluate(
    () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  const image = decodePng(await page.screenshot({ path: join(root, 'server-reference.png') }));
  const at = (Math.round(point[1]) * image.w + Math.round(point[0])) * 4;
  assert(
    image.data[at + 1] > image.data[at] * 1.5 && image.data[at + 1] > image.data[at + 2] * 1.5,
    'the WebGL reference terrain renders the source texture',
  );
  await page.reload();
  await loaded();
  await capture();
  assert.deepEqual(
    await page.evaluate(() => (window as unknown as Observation).referenceState().offset),
    [140, 3, 7],
    'reload restores the saved editable reference placement',
  );
  assert.deepEqual(await pixels(), [0, 255, 0, 255]);
  await choose('local', localId);
  assert.deepEqual(await pixels(), [255, 255, 0, 255], 'a same-named Local reference retains its own custom art');
  assert.deepEqual(
    await page.evaluate(() => (window as unknown as Observation).slopesmith.doc()),
    before,
    'loading references does not replace or modify the active document',
  );
  assert.equal(new URL(page.url()).searchParams.get('project'), activeProject.project.id);
  assert.equal(writes.length, 0, 'reference loads never write or activate the source project');
  assert.deepEqual(
    JSON.parse(JSON.stringify((await openProject(sourceProject.project.id)).document)),
    JSON.parse(JSON.stringify(sourceProject.document)),
  );
  assert.deepEqual(
    readdirSync(maps, { recursive: true }),
    filesBefore,
    'no exported map folder or reference files are produced',
  );
  await page.getByLabel('Reference source', { exact: true }).selectOption('server');
  await page.getByLabel('Reference game', { exact: true }).selectOption('unknown');
  await page.getByLabel('Reference map', { exact: true }).selectOption({ label: 'MAP_FOLDER' });
  await page.getByRole('button', { name: 'Load reference', exact: true }).click();
  await loaded();
  assert.equal(
    await page.evaluate(() => (window as unknown as Observation).referenceState().level),
    'MAP_FOLDER',
    'ordinary map-folder references keep loading',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(await page.evaluate(() => (window as unknown as Observation).slopesmith.errors()), []);
  console.log(
    `EDITABLE REFERENCE BROWSER: PASS (Local/Server full references, rendered props, source-scoped image decoding, reload/placement, read-only snapshots, folder compatibility). Artifacts: ${root}`,
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: join(root, 'failure.png') });
    console.error(await page.locator('#dock-right').innerText());
  }
  console.error(`Editable reference browser failure: ${root}`);
  throw error;
} finally {
  await browser?.close();
  await vite.close();
  await api.close();
}
