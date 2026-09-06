/**
 * A change to a mountain's own assets must be visible on the very next request (docs/035, docs/038).
 *
 * This guards one specific, invisible failure. Generated responses are cached in memory by `ResponseCache`,
 * which files each entry under a KIND prefix — `json:` or `bytes:` — while `projectAssetCacheKey` produces
 * the logical key WITHOUT one. `invalidateProjectLibrary` tested the scope against the stored key, so it
 * matched nothing and every import, rename, replace and delete left the previous catalogue in place.
 *
 * What made that worth a test of its own rather than a fix is how it FAILED. These responses are
 * `private, no-cache` with an ETag, so a stale entry does not merely serve old bytes once — it answers 304
 * to every revalidation forever after. Reloading the page does not clear it, opening a new tab does not
 * clear it, and the only recovery is restarting the service. The symptom ("I have to restart the server to
 * see my change") points at everything except the line that causes it.
 *
 * So the assertion is deliberately made through the HTTP surface, on the `x-slopesmith-cache` header AND on
 * the body, for every route family that mutates a mountain's own library.
 *
 * Run: tsx test/library-cache.test.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk, fetchForTest, removeTestTree } from './http-test-support';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-libcache-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;

const { forgetWorkspaceConfig } = await import('../src/server/workspace-config');
const { forgetAccounts } = await import('../src/server/accounts/store');
forgetWorkspaceConfig();
forgetAccounts();

const { startApiService } = await import('../src/server/main');
const { configureCheckpoints } = await import('../src/server/projects');
const { collisionLabMountain } = await import('../src/core/collision/lab');
const { migrateMountain } = await import('../src/core/doc/mountain');
const { authoredModelLevelProps } = await import('../src/core/doc/models');
const { encodePng } = await import('../src/server/routes/png');

// A retail page is workspace-owned, not mountain-owned. Plant one before the service starts so the fresh-tab
// check below is hermetic and does not depend on somebody having extracted MESA on this machine.
const retailPng = encodePng({ w: 2, h: 2, data: new Uint8Array(2 * 2 * 4).fill(123) });
mkdirSync(join(root, 'MESA', 'Textures'), { recursive: true });
writeFileSync(join(root, 'MESA', 'Textures', '0059.png'), retailPng);
writeFileSync(join(root, 'MESA', 'Patches.json'), JSON.stringify({
  Patches: [{ Points: [], SurfaceType: 0, TexturePath: '0059.png' }],
}));

configureCheckpoints({ intervalMs: 60_000, changeBytes: 1 << 30 });

let service: Awaited<ReturnType<typeof startApiService>> | undefined;
const api = (path: string) => {
  if (!service) throw new Error('the test API service has not started');
  return `${service.url}${path}`;
};
const post = (path: string, body?: BodyInit) =>
  fetchForTest(api(path), { method: 'POST', ...(body === undefined ? {} : { body }) });

/** A GET, reported the way the cache sees it. */
async function get<T>(path: string): Promise<{ cached: boolean; body: T }> {
  const res = await expectOk(fetchForTest(api(path)), `GET ${path}`);
  return { cached: res.headers.get('x-slopesmith-cache') === 'hit', body: await res.json() as T };
}

interface Catalogue { models: { id: number; name: string }[] }
interface Tiles { tiles: { name: string; revision?: string }[] }

try {
  service = await startApiService({ port: 0, host: '127.0.0.1' });

  // A new browser tab with several mountains has no active project until its picker resolves. Extracted art
  // must still load in that interval; only the authored Custom bank actually needs a mountain context.
  {
    const retail = await fetchForTest(api('/api/texture?level=MESA&name=0059.png&client=tab-unbound'));
    check(retail.status === 200 && Buffer.from(await retail.arrayBuffer()).equals(retailPng)
      && retail.headers.get('cache-control') === 'private, max-age=3600',
      'a fresh tab reads an extracted texture with bounded private caching before it has an active mountain');
    const revision = (retail.headers.get('etag') ?? '').replace(/^"|"$/g, '');
    const versioned = await fetchForTest(api(
      `/api/texture?level=MESA&name=0059.png&v=${encodeURIComponent(revision)}`));
    check(versioned.status === 200
      && versioned.headers.get('cache-control') === 'private, max-age=31536000, immutable',
      'the same protected extracted texture becomes privately immutable at its content-addressed URL');
    const catalogue = await fetchForTest(api('/api/textures?level=MESA&client=tab-unbound'));
    const catalogueBody = await catalogue.json() as Tiles;
    check(catalogue.status === 200
      && catalogueBody.tiles.some(tile => tile.name === '0059.png' && tile.revision === revision),
      'and its catalogue publishes that content revision without a mountain context');
    const level = await fetchForTest(api('/api/level?name=MESA'));
    const levelBody = await level.json() as { textureRevisions?: Record<string, string> };
    check(level.status === 200 && levelBody.textureRevisions?.['0059.png'] === revision,
      'the terrain payload publishes revisions before its image loaders start');
    const custom = await fetchForTest(api('/api/texture?level=Custom&name=0059.png&client=tab-unbound'));
    check(custom.status === 409,
      'while an authored texture still refuses a tab that has not chosen which mountain owns it');
    for (const path of [
      '/api/skypano?level=MESA&client=tab-unbound',
      '/api/skyground?level=MESA&client=tab-unbound',
      '/api/skybox/ring?level=MESA&client=tab-unbound',
      '/api/skybox/page?level=MESA&index=0&client=tab-unbound',
    ]) {
      const referenceSky = await fetchForTest(api(path));
      check(referenceSky.status !== 409
        && !String(referenceSky.headers.get('cache-control')).startsWith('public'),
      `a fresh tab reaches the extracted sky route without a mountain context and no shared cache (${path})`);
    }
  }

  const made = await (await expectOk(post('/api/projects', new Blob([JSON.stringify({
    document: migrateMountain(collisionLabMountain('LIBCACHE')),
  })], { type: 'application/json' }) as unknown as BodyInit), 'creating the first test mountain')).json() as
    { project: { id: string } };
  const mountain = made.project.id;

  const cube = {
    id: 'model:0000', name: 'Crate', anchor: [0, 0, 0] as [number, number, number],
    vertices: [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1],
    quads: [[0, 1, 2, 3], [4, 6, 5, 7], [2, 3, 6, 7], [0, 4, 1, 5], [1, 5, 3, 7], [0, 2, 4, 6]],
  };
  const baked = authoredModelLevelProps({ models: [cube] } as never).models[0].subs[0];
  const b64 = (view: ArrayBufferView) =>
    Buffer.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength).toString('base64');
  const record = (name: string) => JSON.stringify({
    name, tris: baked.indices.length / 3,
    subs: [{ mat: 0, pos: b64(baked.positions), uv: b64(baked.uvs), idx: b64(baked.indices) }],
    materials: [{ id: 0, tex: null }],
  });

  // ---- warm the cache, and prove it is actually caching -------------------------------------------------
  const first = await expectOk(post('/api/custom-prop-import?name=crate', record('Crate')),
    'importing the first custom prop');
  const id = ((await first.json()) as { id: number }).id;
  check(await get<Catalogue>('/api/custom-props').then(r => !r.cached), 'the first catalogue read is a miss');
  check(await get<Catalogue>('/api/custom-props').then(r => r.cached),
    'and the second is a hit — this route really is cached, so the rest of this file means something');

  // ---- every mutation has to be visible on the next read ------------------------------------------------
  await expectOk(post('/api/custom-prop-import?name=second', record('Second')),
    'importing the second custom prop');
  {
    const { cached, body } = await get<Catalogue>('/api/custom-props');
    check(!cached && body.models.length === 2,
      'an import lands in the very next read — the regression: it used to answer the one-model catalogue');
  }

  await expectOk(post(`/api/custom-prop-rename?id=${id}&to=${encodeURIComponent('Renamed crate')}`),
    'renaming the custom prop');
  {
    const { body } = await get<Catalogue>('/api/custom-props');
    check(body.models.some(model => model.id === id && model.name === 'Renamed crate'),
      'a rename lands in the very next read');
  }

  await expectOk(post(`/api/custom-prop-delete?id=${id}`), 'deleting the custom prop');
  {
    const { body } = await get<Catalogue>('/api/custom-props');
    check(body.models.length === 1 && !body.models.some(model => model.id === id),
      'a delete lands in the very next read');
  }

  // ---- the same invalidation carries the texture bank, so check a second route family --------------------
  const png = encodePng({ w: 8, h: 8, data: new Uint8Array(8 * 8 * 4).fill(200) });
  check(await get<Tiles>('/api/textures?level=Custom').then(r => r.body.tiles.length === 0),
    'the Custom tile bank starts empty');
  await get<Tiles>('/api/textures?level=Custom');                       // warm it
  const uploadedTexture = await (await expectOk(post('/api/texture-upload?name=cliff',
    new Blob([new Uint8Array(png)]) as unknown as BodyInit), 'uploading the custom texture')).json() as
    { name: string };
  {
    const { cached, body } = await get<Tiles>('/api/textures?level=Custom');
    check(!cached && body.tiles.some(tile => tile.name.startsWith('cliff')),
      'an uploaded tile lands in the very next read of the bank');
    const bytes = await fetchForTest(api(`/api/texture?level=Custom&name=${encodeURIComponent(uploadedTexture.name)}`
      + `&project=${encodeURIComponent(mountain)}`));
    check(bytes.status === 200
      && bytes.headers.get('cache-control') === 'private, max-age=31536000, immutable',
      'an uploaded tile keeps its private permanent URL without revalidation');
  }

  // ---- a mutation must not evict a DIFFERENT mountain's cached answers ------------------------------------
  {
    const other = await (await expectOk(post('/api/projects', new Blob([JSON.stringify({
      document: migrateMountain(collisionLabMountain('LIBCACHE2')),
    })], { type: 'application/json' }) as unknown as BodyInit), 'creating the second test mountain')).json() as
      { project: { id: string } };
    const scoped = `/api/custom-props?project=${encodeURIComponent(other.project.id)}`;
    await get<Catalogue>(scoped);                                        // warm the second mountain
    await get<Catalogue>(scoped);
    // Addressed at the FIRST mountain explicitly: creating the second one ACTIVATED it, so an unaddressed
    // write would land there and this check would be asserting nothing.
    await expectOk(post(`/api/custom-prop-import?name=third&project=${encodeURIComponent(mountain)}`,
      record('Third')), 'importing into the first test mountain');
    check(await get<Catalogue>(scoped).then(r => r.cached),
      'changing one mountain leaves another mountain’s cached catalogue alone — the scope still scopes');
    const { body } = await get<Catalogue>(`/api/custom-props?project=${encodeURIComponent(mountain)}`);
    check(body.models.some(model => model.name === 'Third'),
      'while the mountain that changed serves the new catalogue');
  }
} finally {
  try { await service?.close(); }
  finally { removeTestTree(root); }
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('library-cache: all checks passed');
