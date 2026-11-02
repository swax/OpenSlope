// tier: integration
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { chromiumExecutable } from './browser-test-support';
import { startApiService } from '../src/server/main';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { encodePng } from '../src/server/routes/png';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-asset-migration-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = join(root, 'workspace');
process.env.SLOPESMITH_MAPS_ROOT = join(root, 'Maps');
forgetWorkspaceConfig();
const bank = join(root, 'Maps/TRICKY_GARI/Textures');
mkdirSync(bank, { recursive: true });
writeFileSync(join(bank, 'tile.png'), encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) }));
writeFileSync(join(bank, 'partial.png'), encodePng({ w: 1, h: 1, data: new Uint8Array([255, 255, 255, 255]) }));
writeFileSync(join(bank, '../Import.json'), JSON.stringify({ Game: 'ssx-tricky' }));
writeFileSync(join(bank, '../Patches.json'), JSON.stringify({ Patches: [] }));
mkdirSync(join(bank, '../Meshes'));
writeFileSync(join(bank, '../Meshes/tree.obj'), 'v 0 0 0\nv 100 0 0\nv 0 100 0\nf 1 2 3\n');
writeFileSync(
  join(bank, '../Models.json'),
  JSON.stringify({
    Models: [
      { ModelName: 'Tree', ModelObjects: [{ ParentID: -1, MeshData: [{ MeshPath: 'tree.obj', MaterialID: 0 }] }] },
    ],
  }),
);
writeFileSync(join(bank, '../Materials.json'), JSON.stringify({ Materials: [{ TexturePath: 'tile.png' }] }));
writeFileSync(
  join(bank, '../Instances.json'),
  JSON.stringify({ Instances: [{ ModelID: 0, Location: [0, 0, 0], Rotation: [0, 0, 0, 1], Scale: [1, 1, 1] }] }),
);
const api = await startApiService({ host: '127.0.0.1', port: 0 });
const vite = await createServer({
  root: process.cwd(),
  logLevel: 'error',
  plugins: [
    {
      name: 'resolver-fixture',
      configureServer(server) {
        server.middlewares.use('/resolver-fixture', (_req, res) => {
          res.setHeader('content-type', 'text/html');
          res.end('<!doctype html><html><body></body></html>');
        });
      },
    },
  ],
  server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api.url, ws: true } } },
});
await vite.listen();
const origin = vite.resolvedUrls!.local[0].replace(/\/$/, '');
const browser = await chromium.launch({ executablePath: chromiumExecutable(), headless: true });
const page = await browser.newPage();
await page.addInitScript('globalThis.__name = value => value');
try {
  await page.goto(`${origin}/resolver-fixture`);
  await page.evaluate(async () => {
    const uiUrl = '/src/app/ui/chrome/asset-migration.ts',
      docUrl = '/src/core/doc/mountain.ts',
      workspaceUrl = '/src/app/net/workspace.ts';
    const { showAssetMigration } = await import(/* @vite-ignore */ uiUrl);
    const { defaultMountain } = await import(/* @vite-ignore */ docUrl);
    const { configureWorkspace } = await import(/* @vite-ignore */ workspaceUrl);
    configureWorkspace(false, async () => null, 'migration-test');
    const state = window as any;
    const libraryUrl = '/src/app/paint/library.ts',
      versionsUrl = '/src/app/net/asset-versions.ts',
      storeUrl = '/src/app/state/store.ts',
      propsUrl = '/src/app/props/operations.ts';
    const { TextureLibrary } = await import(/* @vite-ignore */ libraryUrl);
    const { pinAssetMap } = await import(/* @vite-ignore */ versionsUrl);
    let brush = '',
      picked = '';
    const library = new TextureLibrary({
      onBrush: (value: { ref: string }) => {
        brush = value.ref;
      },
    });
    await library.init('server:TRICKY_GARI');
    library.show();
    await library.pickTexture('server:TRICKY_GARI/tile.png', 1);
    const texture = brush;
    const swatch = library.el.querySelector(`.sp-tile[data-asset-ref="${texture}"]`);
    if (!swatch) throw new Error(`Missing brush swatch: ${texture}`);
    (swatch as HTMLElement).click();
    const clicked = brush;
    const transfer = new DataTransfer();
    library.el
      .querySelector(`.sp-tile[data-asset-ref="${texture}"]`)!
      .dispatchEvent(new DragEvent('dragstart', { dataTransfer: transfer }));
    const dragged = JSON.parse(transfer.getData(transfer.types[0])).ref;
    library.openPick({
      title: 'Pick an image',
      onPick: (ref: string) => {
        picked = ref;
      },
    });
    await Promise.resolve();
    const pickSwatch = library.el.querySelector(`.sp-tile[data-asset-ref="${texture}"]`) as HTMLElement;
    if (!pickSwatch) throw new Error(`Missing picker swatch: ${texture}`);
    pickSwatch.click();
    const bankId = await pinAssetMap('server:TRICKY_GARI');
    await library.pickTexture(`${bankId}/tile.png`, 1);
    const legacySample = brush;
    await library.pickTexture(texture, 1);
    const individualSample = brush;
    const paletteUrl = '/src/app/paint/palette.ts';
    const { Palette } = await import(/* @vite-ignore */ paletteUrl);
    const unavailable = bankId.replace(/:[a-f0-9]{64}$/, ':' + '0'.repeat(64)) + '/tile.png';
    localStorage.setItem(
      'slopesmith-scratch-v1',
      JSON.stringify({
        cells: [
          { ref: `${bankId}/tile.png`, surface: 13, rot: 2, mirror: true },
          { ref: unavailable, surface: 1, rot: 0, mirror: false },
        ],
      }),
    );
    let selected: (brush: { ref: string; surface: number; rot: number; mirror: boolean }) => void = () => {};
    const palette = new Palette({ onSelect: (brush: any) => selected(brush) });
    document.body.append(palette.el);
    const waitPalette = () =>
      new Promise<any>(resolve => {
        selected = resolve;
      });
    const firstPalette = waitPalette();
    (palette.el.querySelectorAll('.sc-cell')[0] as HTMLElement).click();
    const palettePick = await firstPalette;
    const secondPalette = waitPalette();
    (palette.el.querySelectorAll('.sc-cell')[1] as HTMLElement).click();
    const unresolvedPick = await secondPalette;
    const storedPalette = JSON.parse(localStorage.getItem('slopesmith-scratch-v1')!);
    palette.el.remove();
    library.el.remove();
    const { createStore } = await import(/* @vite-ignore */ storeUrl);
    const { createPropOps } = await import(/* @vite-ignore */ propsUrl);
    // Render a frozen group without registering a bank's mined definitions. Each mesh lives under its own
    // asset identity; its placed view and placement ghost must both contain the two members.
    const assetsUrl = '/src/app/viewport/scene/prop-assets.ts',
      layerUrl = '/src/app/viewport/scene/props.ts',
      threeUrl = '/node_modules/three/build/three.module.js';
    const { createPropAssets } = await import(/* @vite-ignore */ assetsUrl);
    const { createPropsLayer } = await import(/* @vite-ignore */ layerUrl);
    const { Group } = await import(/* @vite-ignore */ threeUrl);
    const renderAssets = createPropAssets();
    const renderLevels = [
      'asset2:ssx-tricky:TRICKY_GARI:prop:0:' + '1'.repeat(64),
      'asset2:ssx-tricky:TRICKY_GARI:prop:1:' + '2'.repeat(64),
    ];
    renderLevels.forEach((level, model) =>
      renderAssets.registerPropModels({
        level,
        models: [
          {
            id: model,
            name: 'Part',
            subs: [
              {
                mat: -1,
                positions: new Float32Array([0, 0, 0, 100, 0, 0, 0, 100, 100]),
                indices: new Uint32Array([0, 1, 2]),
                uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
              },
            ],
          },
        ],
        materials: new Map(),
        instances: [],
        crowdFrames: [],
      }),
    );
    const definition = {
      id: 'fixture',
      level: renderLevels[0],
      name: 'Fixture',
      occurrences: 3,
      lights: [],
      props: renderLevels.map((level, model) => ({ level, model, name: 'Part', relPos: [model, 0, 0], relYaw: 0 })),
    };
    const renderLayer = createPropsLayer(
      { scene: new Group(), worldRoot: new Group() },
      { ...renderAssets },
      { authoredLights: [] },
    );
    renderLayer.setPlacedProps(
      [
        {
          level: renderLevels[0],
          model: 0,
          group: 'fixture',
          groupDefinition: definition,
          id: 'prop:fixture',
          name: 'Fixture',
          pos: [0, 0, 0],
          yaw: 0,
          scale: 1,
        },
      ],
      null,
    );
    const renderedMembers = renderLayer.placedPropMeshes[0].children.length;
    renderLayer.setArmed({
      level: renderLevels[0],
      model: 0,
      group: 'fixture',
      groupDefinition: definition,
      baseOffset: 0,
    });
    const ghostMembers = renderLayer.propGhost.children.length;
    renderLayer.stopAssetWatching();
    const selectionDoc = { ...defaultMountain(), quadTex: { 0: 'GARI/tile.png' } };
    const selectionBefore = JSON.stringify(selectionDoc),
      store = createStore({ mdoc: selectionDoc, currentMode: 'props', storedUi: {} });
    const propLevels = new Map(),
      registered: string[] = [];
    const ops = createPropOps({
      store,
      propLevels,
      groupDefIdx: new Map(),
      viewport: {
        registerPropModels: (props: { level: string }) => registered.push(props.level),
        setPropArmed() {},
        setLineDrawing() {},
        setLightArmed() {},
        setRailArmed() {},
        setGemArmed() {},
        clearRefPropSelection() {},
      },
      propLib: { highlight() {} },
      setMode() {},
      scheduleRebuild() {},
      rebuildTools() {},
      updateCmdSheet() {},
    });
    await ops.armProp('server:TRICKY_GARI', 0, 'Tree');
    state.automatic = {
      texture,
      clicked,
      dragged,
      picked,
      legacySample,
      bankId,
      individualSample,
      palettePick,
      unresolvedPick,
      unavailable,
      storedPalette,
      renderedMembers,
      ghostMembers,
      prop: structuredClone(store.armedProp),
      defaults: ops.propDefaults(bankId, 0).behaviour,
      individualDefaults: ops.propDefaults(store.armedProp.level, 0),
      registered,
      unchanged: selectionBefore === JSON.stringify(selectionDoc),
    };
    state.migrationDocument = {
      ...defaultMountain(),
      quadTex: { 0: 'GARI/tile.png', 1: `asset1:ssx-tricky:TRICKY_GARI:${'a'.repeat(64)}/tile.png` },
      props: [{ level: 'GARI', model: 0 }],
    };
    state.originalDocument = JSON.stringify(state.migrationDocument);
    state.applied = 0;
    state.checkpoints = 0;
    state.openMigration = () =>
      showAssetMigration({
        getDoc: () => state.migrationDocument,
        setDoc: (doc: unknown) => {
          state.migrationDocument = doc;
          state.applied++;
        },
        isWritable: () => true,
        checkpoint: async () => {
          state.checkpoints++;
        },
        reload: async () => {},
      });
    void state.openMigration();
  });
  const automatic = await page.evaluate(() => (window as any).automatic);
  assert.match(automatic.texture, /^asset2:.*:texture:tile\.png:/);
  assert(!automatic.texture.includes('/'), 'new texture references do not repeat the filename after the hash');
  for (const ref of [automatic.clicked, automatic.dragged, automatic.picked, automatic.individualSample])
    assert.equal(ref, automatic.texture);
  assert.equal(
    automatic.legacySample,
    automatic.texture,
    'sampling an existing bank reference pins the exact individual texture',
  );
  assert.match(automatic.prop?.level ?? '', /^asset2:.*:prop:0:/);
  assert.equal(automatic.renderedMembers, 2, 'frozen groups render every independently pinned member');
  assert.equal(automatic.ghostMembers, 2, 'the placement ghost uses the same member identities');
  assert.equal(automatic.palettePick.ref, automatic.texture);
  assert.deepEqual(
    [automatic.palettePick.surface, automatic.palettePick.rot, automatic.palettePick.mirror],
    [13, 2, true],
  );
  assert.equal(automatic.unresolvedPick.ref, automatic.unavailable, 'unverified saved swatches remain unchanged');
  assert.equal(
    automatic.storedPalette.pads[0][0].ref,
    automatic.texture,
    'verified saved palette entries retain asset2 on reload',
  );
  assert.deepEqual(
    automatic.prop.behaviour,
    automatic.defaults,
    'automatic pinning preserves source-bank prop defaults',
  );
  assert.deepEqual(
    automatic.individualDefaults.behaviour,
    automatic.defaults,
    'the held-prop inspector retains the source defaults',
  );
  assert(automatic.registered.includes(automatic.prop.level), 'individual geometry was loaded and registered');
  assert(automatic.unchanged, 'choosing new brushes/props does not rewrite saved references');
  const dialog = page.getByRole('dialog', { name: 'Review asset references' });
  await dialog.getByText('3 assets reviewed.', { exact: false }).waitFor();
  await page.screenshot({ path: join(root, 'preview.png') });
  assert.equal(await dialog.getByRole('checkbox').count(), 3);
  await dialog.getByText('GARI · prop 0', { exact: true }).waitFor();
  assert.equal(await dialog.getByText('Matches current asset · 1 reference', { exact: true }).count(), 2);
  const matchingRows = dialog.locator('label').filter({ hasText: 'Matches current asset' });
  for (const row of await matchingRows.all())
    assert(await row.getByRole('checkbox').isChecked(), 'matching textures and prop definitions are preselected');
  assert.equal(
    await dialog
      .locator('label')
      .filter({ hasText: 'Replacement — original version unavailable' })
      .getByRole('checkbox')
      .isChecked(),
    false,
    'unavailable originals need explicit replacement selection',
  );
  assert(
    await page.evaluate(() => JSON.stringify((window as any).migrationDocument) === (window as any).originalDocument),
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  assert.equal(await page.evaluate(() => (window as any).applied), 0);
  await page.evaluate(() => {
    void (window as any).openMigration();
  });
  await dialog.getByText('3 assets reviewed.', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: 'Apply selected references' }).click();
  await dialog.waitFor({ state: 'detached' });
  const result = await page.evaluate(() => ({
    doc: (window as any).migrationDocument,
    applied: (window as any).applied,
    checkpoints: (window as any).checkpoints,
  }));
  assert(result.doc.quadTex[0].startsWith('asset2:'));
  assert(result.doc.quadTex[1].startsWith('asset1:'));
  assert.match(result.doc.props[0].level, /^asset2:.*:prop:0:/);
  assert.equal(result.doc.props[0].model, 0, 'the display label does not change the separate model selector');
  assert.equal(result.applied, 1);
  assert.equal(result.checkpoints, 1);
  const first = await page.evaluate(async () => {
    const workspaceUrl = '/src/app/net/workspace.ts';
    const { workspaceFetch } = await import(/* @vite-ignore */ workspaceUrl);
    const ref = (window as any).migrationDocument.quadTex[0];
    const pathsUrl = '/src/app/net/asset-paths.ts';
    const { textureRefUrl } = await import(/* @vite-ignore */ pathsUrl);
    (window as any).immutableUrl = textureRefUrl(ref);
    const response = await workspaceFetch((window as any).immutableUrl);
    return { status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  });
  assert.equal(first.status, 200);
  await page.route('**/api/texture?**', route => route.abort());
  const cached = await page.evaluate(async () => {
    const workspaceUrl = '/src/app/net/workspace.ts';
    const { workspaceFetch, configureWorkspace } = await import(/* @vite-ignore */ workspaceUrl);
    configureWorkspace(false, async () => null, 'migration-test');
    const response = await workspaceFetch((window as any).immutableUrl);
    return { status: response.status, bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  });
  assert.deepEqual(cached, first, 'persisted exact bytes survive a new memory cache and unavailable network');
  const isolated = await page.evaluate(async () => {
    const workspaceUrl = '/src/app/net/workspace.ts';
    const { workspaceFetch, configureWorkspace } = await import(/* @vite-ignore */ workspaceUrl);
    configureWorkspace(false, async () => null, 'different-account');
    return (await workspaceFetch((window as any).immutableUrl)).status;
  });
  assert.equal(isolated, 404, 'another account/policy scope cannot reuse private cache entries');
  await page.unroute('**/api/texture?**');
  const fallback = await page.evaluate(async () => {
    const cacheUrl = '/src/app/public/iso-cache.ts',
      localUrl = '/src/app/public/lazy-local-map-data.ts',
      apiUrl = '/src/app/public/local-asset-api.ts',
      workspaceUrl = '/src/app/net/workspace.ts',
      exportUrl = '/src/app/public/course-export-source.ts';
    const { openIsoCache, cacheTransaction, isoCourseCacheVersion } = await import(/* @vite-ignore */ cacheUrl);
    const { lazyLocalMapData } = await import(/* @vite-ignore */ localUrl);
    const { installLocalAssetApi } = await import(/* @vite-ignore */ apiUrl);
    const { workspaceFetch } = await import(/* @vite-ignore */ workspaceUrl);
    const { courseExportSource } = await import(/* @vite-ignore */ exportUrl);
    const course = 'TRICKY_GARI',
      db = await openIsoCache();
    await cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
      for (const [path, blob] of Object.entries({
        'Import.json': new Blob([JSON.stringify({ Game: 'ssx-tricky' })]),
        'Textures/local-only.png': new Blob([new Uint8Array([1])]),
      }))
        store.put({ key: `${course}/${path.toLowerCase()}`, course, path, blob });
    });
    await cacheTransaction(db, 'courses', 'readwrite', (store: IDBObjectStore) =>
      store.put({ course, files: 2, version: isoCourseCacheVersion(course) }),
    );
    db.close();
    const local = await lazyLocalMapData([course]);
    installLocalAssetApi(local, [course], true);
    const rendered = await workspaceFetch('/api/texture?level=GARI&name=partial.png');
    const explicit = await workspaceFetch('/api/texture?level=local:GARI&name=partial.png');
    const bundle = {
      kind: 'slopesmith-project',
      schema: 1,
      name: 'PARTIAL',
      revision: 0,
      takenAt: '',
      document: (window as any).migrationDocument,
      assets: [],
      blobs: {},
    };
    const source = await courseExportSource(bundle);
    try {
      const exported = await source.request('/api/texture?level=GARI&name=partial.png');
      const explicitExport = await source.request('/api/texture?level=local:GARI&name=partial.png');
      return {
        render: rendered.status,
        renderBytes: Array.from(new Uint8Array(await rendered.arrayBuffer())),
        local: explicit.status,
        export: exported.status,
        exportBytes: Array.from(new Uint8Array(await exported.arrayBuffer())),
        localExport: explicitExport.status,
      };
    } finally {
      source.dispose();
      local.dispose();
    }
  });
  assert.equal(fallback.render, 200);
  assert.equal(fallback.export, 200);
  assert.deepEqual(
    fallback.renderBytes,
    fallback.exportBytes,
    'rendering and export share missing-local-file fallback',
  );
  assert.equal(fallback.local, 404);
  assert.equal(fallback.localExport, 404);
  await page.evaluate(
    async (localBytes: number[]) => {
      const cacheUrl = '/src/app/public/iso-cache.ts',
        localUrl = '/src/app/public/lazy-local-map-data.ts',
        apiUrl = '/src/app/public/local-asset-api.ts',
        workspaceUrl = '/src/app/net/workspace.ts';
      const { openIsoCache, cacheTransaction, isoCourseCacheVersion } = await import(/* @vite-ignore */ cacheUrl);
      const { lazyLocalMapData } = await import(/* @vite-ignore */ localUrl);
      const { installLocalAssetApi } = await import(/* @vite-ignore */ apiUrl);
      const { workspaceFetch } = await import(/* @vite-ignore */ workspaceUrl);
      const course = 'TRICKY_GARI',
        db = await openIsoCache();
      await cacheTransaction(db, 'files', 'readwrite', (store: IDBObjectStore) => {
        for (const [path, blob] of Object.entries({
          'Patches.json': new Blob([JSON.stringify({ Patches: [] })]),
          'Textures/tile.png': new Blob([new Uint8Array(localBytes)]),
        }))
          store.put({ key: `${course}/${path.toLowerCase()}`, course, path, blob });
      });
      await cacheTransaction(db, 'courses', 'readwrite', (store: IDBObjectStore) =>
        store.put({ course, files: 4, version: isoCourseCacheVersion(course) }),
      );
      db.close();
      const state = window as any;
      state.mixedLocal = await lazyLocalMapData([course]);
      installLocalAssetApi(state.mixedLocal, [course], true);
      state.beforeLocalBytes = Array.from(
        new Uint8Array(await (await workspaceFetch('/api/texture?level=GARI&name=tile.png')).arrayBuffer()),
      );
      state.migrationDocument = {
        ...state.migrationDocument,
        quadTex: {
          0: 'GARI/tile.png',
          1: 'server:GARI/tile.png',
          2: 'GARI/partial.png',
          3: 'local:GARI/partial.png',
        },
      };
      state.originalDocument = JSON.stringify(state.migrationDocument);
      await state.openMigration();
    },
    Array.from(encodePng({ w: 1, h: 1, data: new Uint8Array([255, 0, 0, 255]) })),
  );
  await dialog.getByText('4 assets reviewed.', { exact: false }).waitFor();
  const choices = dialog.locator('label');
  assert.match((await choices.nth(0).textContent())!, /Matches current asset/);
  assert.match((await choices.nth(0).textContent())!, /\(local:TRICKY_GARI\)/);
  assert.match((await choices.nth(1).textContent())!, /\(server:TRICKY_GARI\)/);
  assert.match((await choices.nth(2).textContent())!, /\(server:TRICKY_GARI\)/);
  assert(await choices.nth(3).getByRole('checkbox').isDisabled());
  assert(
    await page.evaluate(() => JSON.stringify((window as any).migrationDocument) === (window as any).originalDocument),
  );
  await page.screenshot({ path: join(root, 'mixed-source-preview.png') });
  await dialog.getByRole('button', { name: 'Apply selected references' }).click();
  await dialog.waitFor({ state: 'detached' });
  const mixed = await page.evaluate(async () => {
    const workspaceUrl = '/src/app/net/workspace.ts';
    const { workspaceFetch } = await import(/* @vite-ignore */ workspaceUrl);
    const state = window as any,
      ref = state.migrationDocument.quadTex[0];
    const pathsUrl = '/src/app/net/asset-paths.ts';
    const { textureRefUrl } = await import(/* @vite-ignore */ pathsUrl);
    const response = await workspaceFetch(textureRefUrl(ref));
    return {
      doc: state.migrationDocument,
      before: state.beforeLocalBytes,
      after: Array.from(new Uint8Array(await response.arrayBuffer())),
    };
  });
  assert.notEqual(
    mixed.doc.quadTex[0],
    result.doc.quadTex[0],
    'different local pixels must not become the server identity',
  );
  assert.equal(mixed.doc.quadTex[1], result.doc.quadTex[0], 'an explicit server selection keeps the server pixels');
  assert.equal(mixed.doc.quadTex[3], 'local:GARI/partial.png', 'missing explicit local references stay unchanged');
  assert.deepEqual(mixed.after, mixed.before, 'migration preserves the texture bytes rendered before apply');
  await page.evaluate(() => (window as any).mixedLocal.dispose());
  await page.evaluate(async () => {
    const workspaceUrl = '/src/app/net/workspace.ts',
      imageUrl = '/src/app/net/asset-images.ts',
      pathsUrl = '/src/app/net/asset-paths.ts';
    const { configureWorkspace } = await import(/* @vite-ignore */ workspaceUrl);
    const { imageAssetUrl } = await import(/* @vite-ignore */ imageUrl);
    const { textureUrl } = await import(/* @vite-ignore */ pathsUrl);
    configureWorkspace(false, async () => null, 'migration-test');
    await imageAssetUrl(textureUrl('server:GARI', 'tile.png'));
  });
  writeFileSync(join(bank, 'tile.png'), encodePng({ w: 1, h: 1, data: new Uint8Array([0, 0, 255, 255]) }));
  await page.evaluate(async () => {
    const state = window as any;
    state.migrationDocument = { ...state.migrationDocument, quadTex: { 0: 'server:GARI/tile.png' } };
    await state.openMigration();
  });
  await dialog.getByText('1 assets reviewed.', { exact: false }).waitFor();
  await dialog.getByText('Different from current asset — review before replacing', { exact: false }).waitFor();
  assert(
    !(await dialog.getByRole('checkbox').isChecked()),
    'a new same-named file must not silently replace the loaded pixels',
  );
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await page.screenshot({ path: join(root, 'result.png') });
  console.log(
    `ASSET MIGRATION PASS: read-only preview, explicit replacements, selected apply, checkpoint, persistent cache, scope isolation and different local/server copies. Artifacts: ${root}`,
  );
} finally {
  await browser.close();
  await vite.close();
  await api.close();
}
