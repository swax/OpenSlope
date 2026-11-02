import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { createServer } from 'vite';
import { chromium, type Browser, type Page } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { forgetAccounts } from '../src/server/accounts/store';
import { defaultMountain } from '../src/core/doc/mountain';
import { createAuthoredModel, modelNumber } from '../src/core/doc/models';
import type { ImportedPropRecord } from '../src/core/props/imported';
import { encodePng } from '../src/server/routes/png';
import { readMountainArchive } from '../src/app/mountain/archive';
import { MOUNTAIN_FOLDER_FILE } from '../src/app/mountain/folder';
import type { ProjectBundle } from '../src/core/project/transfer';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-folder-workspace-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
forgetAccounts();
const api = await startApiService({ host: '127.0.0.1', port: 0, accounts: true });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  server: {
    host: '127.0.0.1',
    port: 0,
    proxy: { '/api': { target: api.url, ws: true } },
  },
});
let browser: Browser | undefined, page: Page | undefined;
let cookie = '';
async function call(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`${api.url}${path}`, {
    method,
    headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
  return response;
}
async function ready() {
  await page!.waitForFunction(() => document.documentElement.dataset.projectSave === 'saved', undefined, {
    timeout: 90_000,
  });
  await page!.locator('#load-status').waitFor({ state: 'hidden', timeout: 90_000 });
}
async function fileAction(name: string) {
  await page!.getByRole('button', { name: 'File menu', exact: true }).click();
  await page!.getByRole('button', { name, exact: true }).click();
}
async function folderSaved() {
  await page!.waitForFunction(() => {
    const icon = document.querySelector<HTMLElement>('#save-status');
    return icon?.dataset.destination === 'folder' && icon.dataset.state === 'saved';
  });
}
async function rename(name: string) {
  await fileAction('Rename mountain…');
  await page!.locator('.sp-ask input').fill(name);
  await page!.getByRole('button', { name: 'Rename', exact: true }).click();
  await page!.waitForFunction(name => document.title === `${name} - Slopesmith`, name);
}
async function disk() {
  const bytes = await page!.evaluate(async filename => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
    return [...new Uint8Array(await (await (await folder.getFileHandle(filename)).getFile()).arrayBuffer())];
  }, MOUNTAIN_FOLDER_FILE);
  return readMountainArchive(new Blob([new Uint8Array(bytes)]));
}
async function diskNamed(name: string) {
  const deadline = Date.now() + 20_000;
  let bundle = await disk();
  while (bundle.document.name !== name && Date.now() < deadline) {
    await setTimeout(200);
    bundle = await disk();
  }
  assert.equal(bundle.document.name, name);
  return bundle;
}
async function replaceDisk(bundle: ProjectBundle) {
  await page!.evaluate(
    async serialized => {
      const { bundle, filename } = JSON.parse(serialized) as { bundle: ProjectBundle; filename: string };
      const path = '/src/app/mountain/archive.ts';
      const { createMountainArchive } = await import(/* @vite-ignore */ path);
      const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
      const output = await (await folder.getFileHandle(filename)).createWritable();
      await output.write(createMountainArchive(bundle).blob);
      await output.close();
    },
    JSON.stringify({ bundle, filename: MOUNTAIN_FOLDER_FILE }),
  );
}
try {
  const enrolled = await call('/api/auth/bootstrap', 'POST', {
    code: api.adminCode,
    username: 'admin',
    password: 'folder workspace test password',
  });
  cookie = enrolled.headers.get('set-cookie')!.split(';')[0];
  const mountain = defaultMountain();
  mountain.name = 'FOLDER_SOURCE';
  mountain.quadTex = { 0: 'Custom/snow.png' };
  const created = (await (await call('/api/projects', 'POST', { document: mountain })).json()) as any;
  mkdirSync(join(created.project.folder, 'assets', 'textures'), { recursive: true });
  writeFileSync(
    join(created.project.folder, 'assets', 'textures', 'snow.png'),
    encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) }),
  );
  await call(`/api/publication?kind=project&id=${created.project.id}`, 'PUT', { published: true });
  await vite.listen();
  const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
  browser = await chromium.launch({
    executablePath: chromiumExecutable(),
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // A real serializable browser handle exercises IndexedDB and writable streams without an OS dialog.
  // OPFS is only the test picker stand-in; production uses the user's external directory picker.
  await page.addInitScript(`(() => {
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: async () => {
        const handle = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder', { create: true });
        return handle;
      },
    });
    Object.defineProperty(FileSystemHandle.prototype, 'queryPermission', {
      configurable: true,
      value: async () => (sessionStorage.getItem('folder-permission') ? 'prompt' : 'granted'),
    });
    Object.defineProperty(FileSystemHandle.prototype, 'requestPermission', {
      configurable: true,
      value: async () => {
        if (sessionStorage.getItem('folder-permission') === 'denied') return 'denied';
        sessionStorage.removeItem('folder-permission');
        return 'granted';
      },
    });
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function (options) {
      const output = await create.call(this, options);
      if (sessionStorage.getItem('folder-fail') === '1')
        output.write = async () => {
          throw new Error('Simulated disk write failure');
        };
      return output;
    };
  })();`);
  const mutations: string[] = [],
    errors: string[] = [];
  page.on('request', request => {
    // Anonymous site presence is allowed; all other server mutations remain forbidden.
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/public/visitor') return;
    if (new URL(request.url()).pathname.startsWith('/api/') && request.method() !== 'GET')
      mutations.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/`);
  await page
    .getByRole('article', { name: 'FOLDER SOURCE', exact: true })
    .getByRole('img', { name: 'Available on server', exact: true })
    .waitFor();
  await page.getByRole('link', { name: 'Edit FOLDER SOURCE', exact: true }).click();
  await ready();
  assert.equal(await page.locator('#save-status').getAttribute('data-destination'), 'browser');
  await page.locator('#save-status').click();
  await page.getByRole('region', { name: 'Save location' }).waitFor();
  assert.match(await page.locator('.sp-save-details').innerText(), /Clearing site data removes these maps/);
  await page.getByRole('button', { name: 'Save to folder…', exact: true }).click();
  await folderSaved();
  const initial = await diskNamed('FOLDER_SOURCE_REV_1');
  assert.equal(initial.assets[0]?.name, 'snow.png');
  assert(initial.blobs?.[initial.assets[0].hash], 'the folder includes the custom texture bytes');
  await fileAction('Save to folder…');
  await page.getByText('This folder already contains a mountain.', { exact: false }).waitFor();
  assert.equal(
    (await disk()).document.name,
    initial.document.name,
    'selecting an occupied folder does not overwrite it',
  );
  await rename('FOLDER_RUN');
  await diskNamed('FOLDER_RUN');
  await folderSaved();
  await page.locator('#save-status').click();
  assert(
    await page.locator('.sp-menu-pop').evaluate(pop => pop.scrollWidth <= pop.clientWidth),
    'save details fit their popup',
  );
  await page.screenshot({ path: join(root, 'folder-saved.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 375, height: 700 });
  await page.locator('#save-status').click();
  assert(
    await page
      .locator('.sp-menu-pop')
      .evaluate(pop => pop.getBoundingClientRect().right <= innerWidth && pop.scrollWidth <= pop.clientWidth),
    'folder save details fit a phone',
  );
  await page.screenshot({ path: join(root, 'folder-mobile.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1440, height: 1000 });

  await page.evaluate(() => sessionStorage.setItem('folder-permission', 'prompt'));
  await page.reload();
  await ready();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('#save-status')?.dataset.state === 'reconnecting',
  );
  await rename('WAITING_FOR_ACCESS');
  assert.equal((await disk()).document.name, 'FOLDER_RUN', 'paused permission preserves the disk copy');
  await page.locator('#save-status').click();
  await page.getByRole('button', { name: 'Resume folder autosave', exact: true }).click();
  await diskNamed('WAITING_FOR_ACCESS');
  await folderSaved();

  await page.evaluate(() => sessionStorage.setItem('folder-fail', '1'));
  await rename('BROWSER_AHEAD');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#save-status')?.dataset.state === 'error');
  assert.equal(
    (await disk()).document.name,
    'WAITING_FOR_ACCESS',
    'a failed write keeps the last complete disk snapshot',
  );
  await page.locator('#save-status').click();
  assert.match(await page.locator('.sp-save-details').innerText(), /Simulated disk write failure/);
  await page.evaluate(() => sessionStorage.removeItem('folder-fail'));
  await page.getByRole('button', { name: 'Resume folder autosave', exact: true }).click();
  await diskNamed('BROWSER_AHEAD');
  await folderSaved();

  await page.reload();
  await ready();
  await folderSaved();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForURL(`${origin}/`);
  await page.getByRole('button', { name: 'New map', exact: true }).click();
  await page.getByRole('dialog', { name: 'New map' }).getByRole('button', { name: 'Create map' }).click();
  await ready();
  assert.equal(
    await page.locator('#save-status').getAttribute('data-destination'),
    'browser',
    'folder bindings belong to one project',
  );
  assert.equal((await disk()).document.name, 'BROWSER_AHEAD');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForURL(`${origin}/`);
  await page
    .locator('.public-course[data-kind="local"]')
    .getByRole('img', { name: 'Saved in this browser', exact: true })
    .waitFor();

  // Remove application databases, preserving the stand-in disk directory, as external folders survive site clearing.
  await page.evaluate(async () => {
    localStorage.clear();
    sessionStorage.clear();
    for (const name of ['slopesmith-local-workspace', 'slopesmith-mountain-folders'])
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
  });
  await page.reload();
  assert.equal(await page.getByRole('link', { name: 'Edit BROWSER_AHEAD', exact: true }).count(), 0);
  const beforeLink = await disk();
  await page.getByRole('button', { name: 'Load map', exact: true }).click();
  await page.getByRole('button', { name: 'Link folder', exact: true }).click();
  const linkedCard = page.getByRole('article', { name: 'BROWSER_AHEAD', exact: true });
  await linkedCard.getByRole('img', { name: 'Linked folder: picked-folder', exact: true }).waitFor();
  assert.equal(new URL(page.url()).pathname, '/', 'linking stays in the library');
  assert.equal(new URL(page.url()).searchParams.get('view'), 'private', 'linked folders appear under Private');
  const linkedId = new URL(
    (await linkedCard.getByRole('link', { name: 'Edit BROWSER_AHEAD', exact: true }).getAttribute('href'))!,
    origin,
  ).searchParams.get('local');
  const linkedDisk = await disk();
  assert.deepEqual(linkedDisk, beforeLink, 'linking does not rewrite the folder archive');
  await page.reload();
  await linkedCard.getByRole('img', { name: 'Linked folder: picked-folder', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Load map', exact: true }).click();
  await page.getByRole('button', { name: 'Link folder', exact: true }).click();
  await page.getByText('BROWSER_AHEAD linked to its folder.', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('article', { name: 'BROWSER_AHEAD', exact: true }).count(),
    1,
    'linking again reuses the map',
  );
  assert.equal(
    new URL(
      (await linkedCard.getByRole('link', { name: 'Edit BROWSER_AHEAD', exact: true }).getAttribute('href'))!,
      origin,
    ).searchParams.get('local'),
    linkedId,
  );
  await page.setViewportSize({ width: 375, height: 700 });
  assert(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
  await page.screenshot({ path: join(root, 'linked-folder-library-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => sessionStorage.setItem('folder-permission', 'denied'));
  await linkedCard.getByRole('link', { name: 'Edit BROWSER_AHEAD', exact: true }).click();
  await page
    .getByText('Folder access was not allowed. Your browser copy is still available.', { exact: true })
    .waitFor();
  assert.equal(new URL(page.url()).pathname, '/', 'denied folder access keeps the library open');
  assert.deepEqual(await disk(), beforeLink, 'denied permission leaves the disk copy intact');
  await page.evaluate(() => sessionStorage.setItem('folder-permission', 'prompt'));
  const newer = structuredClone(linkedDisk);
  newer.document.name = newer.name = 'EXTERNAL_FOLDER_UPDATE';
  newer.takenAt = new Date().toISOString();
  const model = createAuthoredModel(newer.document, 'Folder authored panel');
  model.vertices = [0, 0, 0, 2, 0, 0, 2, 2, 0, 0, 2, 0];
  model.quads = [[0, 1, 2, 3]];
  model.texture = 'Custom/snow.png';
  const packed = (values: Float32Array | Uint32Array) => Buffer.from(values.buffer).toString('base64');
  const imported: ImportedPropRecord = {
    id: 5,
    name: 'Folder imported triangle',
    tris: 1,
    materials: [{ id: 0, tex: 'Custom/snow.png' }],
    subs: [
      {
        mat: 0,
        pos: packed(new Float32Array([0, 0, 0, 100, 0, 0, 0, 0, 200])),
        uv: packed(new Float32Array([0, 0, 1, 0, 0, 1])),
        idx: packed(new Uint32Array([0, 1, 2])),
      },
    ],
  };
  const propBytes = Buffer.from(JSON.stringify(imported));
  const propHash = createHash('sha256').update(propBytes).digest('hex');
  newer.assets.push({
    kind: 'prop',
    name: 'folder-triangle.json',
    model: imported.id,
    hash: propHash,
    size: propBytes.length,
  });
  newer.blobs = { ...newer.blobs, [propHash]: propBytes.toString('base64') };
  newer.document.props = [
    { level: '@models', model: modelNumber(model.id), name: model.name, pos: [2, 0, 2], yaw: 0, scale: 1 },
    { level: '@import', model: imported.id, name: imported.name, pos: [-2, 0, 2], yaw: 0, scale: 1 },
  ];
  await replaceDisk(newer);
  await linkedCard.getByRole('link', { name: 'Edit BROWSER_AHEAD', exact: true }).click();
  await page.waitForURL('**/editor/EXTERNAL_FOLDER_UPDATE?*');
  assert.equal(new URL(page.url()).searchParams.get('local'), linkedId, 'folder refresh preserves local identity');
  assert.equal(
    await page.evaluate(() => sessionStorage.getItem('folder-permission')),
    null,
    'opening can renew folder access',
  );
  await ready();
  await folderSaved();
  const restored = await diskNamed('EXTERNAL_FOLDER_UPDATE');
  assert.equal(restored.assets[0]?.hash, initial.assets[0].hash, 'recovery retains custom assets');
  await fileAction('Export…');
  const exportDialog = page.getByRole('dialog', { name: 'Export', exact: true });
  await exportDialog.getByLabel('Export for', { exact: true }).selectOption('snowknife-iso');
  const downloaded = page.waitForEvent('download', { timeout: 90_000 });
  await exportDialog.getByRole('button', { name: 'Download .snowknife.zip', exact: true }).click();
  const snowknife = await downloaded;
  const archive = join(root, 'folder-export.snowknife.zip');
  await snowknife.saveAs(archive);
  const contents = spawnSync(
    'python',
    [
      '-c',
      [
        'import zipfile,json,sys,hashlib',
        'z=zipfile.ZipFile(sys.argv[1]); root="EXTERNAL_FOLDER_UPDATE/"',
        'models=json.loads(z.read(root+"Models.json"))["Models"]',
        'instances=json.loads(z.read(root+"Instances.json"))["Instances"]',
        'ids={i for i,m in enumerate(models) if m["ModelName"].startswith(("Model_","Import_"))}',
        'meshes=[z.read(root+"Meshes/"+mesh["MeshPath"]).decode() for i in ids for obj in models[i]["ModelObjects"] for mesh in obj["MeshData"]]',
        'faces=sorted(sum(line.startswith("f ") for line in mesh.splitlines()) for mesh in meshes)',
        'texture=next(name for name in z.namelist() if name.endswith("/Custom_snow.png"))',
        'print(json.dumps(dict(models=len(ids),instances=sum(i["ModelID"] in ids for i in instances),faces=faces,texture=hashlib.sha256(z.read(texture)).hexdigest())))',
      ].join('\n'),
      archive,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(contents.status, 0, contents.stderr);
  assert.deepEqual(
    JSON.parse(contents.stdout),
    {
      models: 2,
      instances: 2,
      faces: [1, 2],
      texture: initial.assets[0].hash,
    },
    'Folder Snowknife export retains authored and embedded prop geometry and original texture bytes',
  );
  const missingSourceStatus = await page.evaluate(async () => {
    const module = '/src/app/net/client.ts';
    const { clientFetch } = await import(/* @vite-ignore */ module);
    return (await clientFetch('/api/props?level=MISSING_SOURCE')).status;
  });
  assert.equal(missingSourceStatus, 404, 'Missing local prop sources must not return a map catalogue');
  await rename('RESTORED_FROM_FOLDER');
  await diskNamed('RESTORED_FROM_FOLDER');
  await folderSaved();

  const beforeConflict = await disk();

  // Changing the file outside this editor must never be silently overwritten by its next autosave.
  await page.evaluate(async filename => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
    const output = await (await folder.getFileHandle(filename)).createWritable();
    await output.write('changed externally');
    await output.close();
  }, MOUNTAIN_FOLDER_FILE);
  await rename('KEEP_BROWSER_EDIT');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#save-status')?.dataset.state === 'error');
  await page.locator('#save-status').click();
  assert.match(await page.locator('.sp-save-details').innerText(), /changed in another editor/);
  const external = await page.evaluate(async filename => {
    const folder = await (await navigator.storage.getDirectory()).getDirectoryHandle('picked-folder');
    return (await (await folder.getFileHandle(filename)).getFile()).text();
  }, MOUNTAIN_FOLDER_FILE);
  assert.equal(external, 'changed externally');
  await page.keyboard.press('Escape');
  // Legacy links only tracked archive hashes/timestamps. Matching timestamps cannot discard recovery edits.
  await page.evaluate(async id => {
    const path = '/src/app/state/local-projects.ts';
    const { openLocalProjects } = await import(/* @vite-ignore */ path);
    const projects = await openLocalProjects();
    const takenAt = projects.bundle(id).takenAt;
    projects.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('slopesmith-mountain-folders', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('handles', 'readwrite');
      const store = tx.objectStore('handles');
      const request = store.get(id);
      request.onsuccess = () => {
        const binding = request.result;
        delete binding.browserHash;
        binding.savedAt = takenAt;
        store.put(binding);
      };
      tx.oncomplete = () => resolve();
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, linkedId!);
  const changedAgain = structuredClone(beforeConflict);
  changedAgain.document.name = changedAgain.name = 'EXTERNAL_AFTER_CONFLICT';
  changedAgain.takenAt = new Date().toISOString();
  await replaceDisk(changedAgain);
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForURL(`${origin}/`);
  await page.getByRole('link', { name: 'Edit KEEP_BROWSER_EDIT', exact: true }).click();
  await page.waitForURL('**/editor/EXTERNAL_AFTER_CONFLICT?*');
  await ready();
  await folderSaved();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForURL(`${origin}/`);
  const recoveryCard = page.getByRole('article', { name: 'KEEP_BROWSER_EDIT_browser_recovery', exact: true });
  await recoveryCard.getByRole('img', { name: 'Saved in this browser', exact: true }).waitFor();
  assert.equal((await disk()).document.name, 'EXTERNAL_AFTER_CONFLICT', 'both changed copies are kept');
  await page.getByRole('link', { name: 'Edit EXTERNAL_AFTER_CONFLICT', exact: true }).click();
  await ready();
  await folderSaved();
  await page.locator('#save-status').click();
  await page.getByRole('button', { name: 'Stop folder autosave', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('#save-status')?.dataset.destination === 'browser',
  );
  assert.equal(await page.locator('#save-status').getAttribute('data-destination'), 'browser');
  assert.deepEqual(mutations, [], 'the entire folder workspace performs no server map mutation');
  assert.deepEqual(errors, []);
  console.log(
    `FOLDER WORKSPACE PASS: library linking/icons, persistent identity, external refresh, browser recovery, autosave/assets, permission resume, atomic failure and project isolation. Artifacts: ${root}`,
  );
} catch (error) {
  await page?.screenshot({ path: join(root, 'failure.png') });
  console.error('Folder workspace artifacts:', root);
  console.error(
    'Last status:',
    await page?.locator('#toast').textContent(),
    await page
      ?.locator('#save-status')
      .getAttribute('aria-label', { timeout: 1000 })
      .catch(() => null),
  );
  console.error(
    await page
      ?.locator('#load-status')
      .innerText()
      .catch(() => ''),
  );
  throw error;
} finally {
  await browser?.close();
  await api.close();
  await vite.close();
}
