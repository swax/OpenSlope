/**
 * The Blender bridge over real HTTP (docs/046) — the path the add-on actually takes.
 *
 * `blender-bridge.test.ts` proves the conversions; this proves the WIRING, which is where a bridge fails in
 * practice. The add-on carries no session, no client id and no project parameter, so every request it makes
 * has to resolve to "the mountain the editor has open" by itself; a push has to land on the model its STAMP
 * names rather than on whatever a URL said; and an authored model's push has to reach the editor's inbox
 * instead of being written to a document from a route.
 *
 * Run: tsx test/blender-routes.test.ts
 *
 * Stands the service up on an ephemeral port under a throwaway workspace, so the author's own mountains and
 * Maps/ library are never touched.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectOk, fetchForTest, removeTestTree } from './http-test-support';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-blender-'));
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
const { decodeGlb } = await import('../src/core/props/glb-decode');
const { decodePng, encodePng } = await import('../src/server/routes/png');
type PortalMesh = import('../src/core/blender/portal').PortalMesh;

/** A flat 8×8 PNG — a tile, small enough that the store keeps it pixel for pixel (`MAX_CUSTOM_TEX` is 512),
 *  so what comes back out of the bank can be compared against what went in. */
const tile = (rgba: [number, number, number, number]): Buffer => {
  const data = new Uint8Array(8 * 8 * 4);
  for (let i = 0; i < data.length; i += 4) data.set(rgba, i);
  return encodePng({ w: 8, h: 8, data });
};

configureCheckpoints({ intervalMs: 60_000, changeBytes: 1 << 30 });

/** A closed unit cube as six outward-wound quads — the same fixture the conversion test measures. */
const CUBE_LOCAL: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [0, 0, 1], [1, 0, 1],
  [0, 1, 0], [1, 1, 0], [0, 1, 1], [1, 1, 1],
];
const CUBE_QUADS = [[0, 1, 2, 3], [4, 6, 5, 7], [2, 3, 6, 7], [0, 4, 1, 5], [1, 5, 3, 7], [0, 2, 4, 6]];

function cubeModel(id: string, name: string, anchor: [number, number, number]) {
  const vertices: number[] = [];
  for (const [x, y, z] of CUBE_LOCAL) vertices.push(x + anchor[0], y + anchor[1], z + anchor[2]);
  return { id, name, anchor, vertices, quads: CUBE_QUADS.map(quad => [...quad]) };
}

let service: Awaited<ReturnType<typeof startApiService>> | undefined;
const api = (path: string) => {
  if (!service) throw new Error('the test API service has not started');
  return `${service.url}${path}`;
};
const getJson = async <T>(path: string): Promise<T> =>
  (await expectOk(fetchForTest(api(path)), `GET ${path}`)).json() as Promise<T>;
const post = (path: string, body: unknown) => fetchForTest(api(path), {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

try {
  service = await startApiService({ port: 0, host: '127.0.0.1' });
  // ---- a mountain holding one authored model ---------------------------------------------------------
  const authored = migrateMountain(collisionLabMountain('BRIDGE')) as unknown as
    { models?: unknown[] };
  authored.models = [cubeModel('model:0002', 'Rail jump', [12, 3, -4])];
  const created = await (await expectOk(post('/api/projects', { document: authored }),
    'creating the test mountain')).json() as
    { project: { id: string; name: string } };
  const projectId = created.project.id;
  check(!!projectId, `a test mountain exists (${created.project.name})`);

  // ---- the catalogue, asked for the way the add-on asks: no project, no client, no session ------------
  const catalogue = await getJson<{ project: { id: string }; maps: { id: string; name: string }[]; models: {
    kind: string; id: number; name: string; faces: number; cage: boolean }[] }>('/api/blender');
  check(catalogue.project.id === projectId,
    'a request carrying no project parameter resolves to the mountain the editor has open');
  check(catalogue.maps.some(map => map.id === projectId && map.name === created.project.name),
    'and the answer lists every mountain on the server, so the add-on can offer a picker');
  check(catalogue.maps.every(map => !('folder' in map)),
    'without leaking the folder each one lives in');
  const cage = catalogue.models.find(model => model.kind === 'model');
  check(cage?.id === 2 && cage.name === 'Rail jump' && cage.faces === 6 && cage.cage,
    'the authored model is listed by its number, with its quad count');

  // ---- pull ------------------------------------------------------------------------------------------
  const portal = await getJson<PortalMesh>('/api/blender/mesh?kind=model&id=2');
  check(portal.stamp.project === projectId && portal.stamp.id === 2,
    'a pulled model is stamped with the mountain and the number it goes back to');
  check(portal.faces.length === 6 && portal.faces.every(face => face.length === 4),
    'it arrives as six quads, not twelve triangles');
  check(portal.anchor[0] === 12 && Math.abs(portal.verts[0]) < 1e-9,
    'anchor-local, so it lands at Blender’s origin with the anchor carried beside it');

  const glbResponse = await expectOk(fetchForTest(api('/api/blender/mesh.glb?kind=model&id=2')),
    'downloading the authored model GLB');
  const glb = decodeGlb(new Uint8Array(await glbResponse.arrayBuffer()));
  check(glbResponse.headers.get('content-type') === 'model/gltf-binary'
    && (glbResponse.headers.get('content-disposition') ?? '').includes('Rail_jump.glb'),
    'the same model downloads as a named GLB for a tool that is not the add-on');
  check(glb.meshes[0].primitives[0].indices?.length === 36,
    'and that GLB carries the cage triangulated for whoever is looking at it');

  // ---- push: an authored model goes to the inbox, not to the document ---------------------------------
  const edited: PortalMesh = { ...portal, verts: [...portal.verts] };
  edited.verts[3 * 7 + 1] += 2;                       // pull the far top corner two metres up
  const pushed = await (await expectOk(post('/api/blender/mesh', edited),
    'pushing the authored model')).json() as
    { pending?: boolean; faces?: number; name?: string };
  check(pushed.pending === true && pushed.faces === 6,
    'an authored model’s push is accepted as PENDING — a route never writes the document');

  const pending = await getJson<{ pushes: { token: string; id: number; cage: {
    vertices: number[]; quads: number[][]; fanned: number; dropped: number } }[] }>('/api/blender/pending');
  check(pending.pushes.length === 1 && pending.pushes[0].id === 2, 'and waits in the mountain’s inbox');
  const returned = pending.pushes[0].cage;
  check(returned.quads.length === 6 && returned.quads[0].join() === CUBE_QUADS[0].join(),
    'the inbox holds the cage as quads, corners in their stored order');
  check(Math.abs(returned.vertices[0] - 12) < 1e-9 && Math.abs(returned.vertices[3 * 7 + 1] - (3 + 1 + 2)) < 1e-9,
    'in WORLD metres against the anchor it left with, the artist’s two-metre pull included');

  // A second push of the same model replaces the first rather than queueing behind it.
  await expectOk(post('/api/blender/mesh', edited), 're-pushing the authored model');
  const requeued = await getJson<{ pushes: unknown[] }>('/api/blender/pending');
  check(requeued.pushes.length === 1,
    'pushing twice leaves ONE pending state — the inbox holds states, not a log of edits');

  const cleared = await (await expectOk(post(
    `/api/blender/ack?token=${encodeURIComponent(pending.pushes[0].token)}`, {}),
  'acknowledging the superseded push')).json() as { cleared: boolean };
  const drained = await getJson<{ pushes: unknown[] }>('/api/blender/pending');
  // The ack names the FIRST push's token, which the re-push replaced — so the inbox is untouched, which is
  // exactly right: acknowledging a state that is no longer the pending one must not drop the newer one.
  check(cleared.cleared === false && drained.pushes.length === 1,
    'an ack for a superseded push clears nothing, so the newer state survives it');
  const live = (await getJson<{ pushes: { token: string }[] }>('/api/blender/pending')).pushes[0];
  await expectOk(post(`/api/blender/ack?token=${encodeURIComponent(live.token)}`, {}),
    'acknowledging the current push');
  check((await getJson<{ pushes: unknown[] }>('/api/blender/pending')).pushes.length === 0,
    'acking the current one empties the inbox');

  // ---- a push aimed at another mountain is refused ----------------------------------------------------
  const foreign = { ...edited, stamp: { ...edited.stamp, project: 'some-other-mountain' } };
  const refused = await post('/api/blender/mesh', foreign);
  const reason = await refused.json() as { error?: string };
  check(refused.status === 400 && (reason.error ?? '').includes('different mountain'),
    'a model pulled from another mountain is refused by name rather than overwriting this one’s number 2');

  // ---- an imported prop round-trips through the record ------------------------------------------------
  const baked = authoredModelLevelProps({
    models: [cubeModel('model:0000', 'Crate', [0, 0, 0])],
  } as never).models[0].subs[0];
  const b64 = (view: ArrayBufferView) =>
    Buffer.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength).toString('base64');
  const imported = await (await expectOk(post('/api/custom-prop-import?name=crate', {
    name: 'Crate', tris: baked.indices.length / 3,
    subs: [{ mat: 0, pos: b64(baked.positions), uv: b64(baked.uvs), idx: b64(baked.indices) }],
    materials: [{ id: 0, tex: null }],
  }), 'importing the custom prop')).json() as { id: number };
  check(Number.isInteger(imported.id), `an imported record exists to round-trip (number ${imported.id})`);

  const propPortal = await getJson<PortalMesh>(`/api/blender/mesh?kind=import&id=${imported.id}`);
  check(propPortal.stamp.kind === 'import' && propPortal.faces.every(face => face.length === 3),
    'an imported prop pulls as the triangle mesh it is');
  check(propPortal.uvs?.length === propPortal.verts.length / 3 * 2,
    'and brings its UVs, which — unlike a cage’s — are authored data');

  // Split one face into two by adding a mid vertex, so the push-back is a real topology change.
  const grown: PortalMesh = {
    ...propPortal,
    verts: [...propPortal.verts, 0.5, 0.5, 2],
    uvs: [...(propPortal.uvs ?? []), 0.5, 0.5],
    faces: [...propPortal.faces, [0, 1, propPortal.verts.length / 3]],
    faceMaterial: [...(propPortal.faceMaterial ?? []), 0],
  };
  const applied = await (await expectOk(post('/api/blender/mesh', grown),
    'pushing the imported prop')).json() as
    { pending?: boolean; faces?: number; name?: string };
  check(!applied.pending && applied.faces === propPortal.faces.length + 1,
    'an imported prop’s push is applied immediately — its record is the server’s to write');
  check(applied.name === 'Crate', 'and it keeps its name, so every placement of it follows the new mesh');

  const after = await getJson<{ models: { kind: string; id: number; faces: number }[] }>('/api/blender');
  const row = after.models.find(model => model.kind === 'import' && model.id === imported.id);
  check(row?.faces === propPortal.faces.length + 1,
    'the catalogue reports the new triangle count under the SAME model number');

  // ---- a tile painted in Blender comes home with the mesh ---------------------------------------------
  let lampId = -1;
  // The rule this section pins down is where the art LANDS, and it is the same line the rest of the editor
  // draws: one of the author's own Custom tiles is replaced, an extracted level's is forked. Getting it
  // backwards would write over reference art that is supposed to be immutable.
  {
    const upload = async (name: string, bytes: Buffer) => (await (await expectOk(fetchForTest(
      api(`/api/texture-upload?name=${name}`),
      { method: 'POST', body: new Uint8Array(bytes) }), `uploading texture ${name}`)).json()) as { name: string };
    const staged = (await upload('lamp', tile([200, 30, 40, 255]))).name;
    check(staged === 'lamp.png', 'a Custom tile is staged for the prop to wear');

    // A second prop, imported already wearing that tile — the ordinary case for art out of the bank.
    const lamp = await (await expectOk(post('/api/custom-prop-import?name=lamp', {
      name: 'Lamp', tris: baked.indices.length / 3,
      subs: [{ mat: 0, pos: b64(baked.positions), uv: b64(baked.uvs), idx: b64(baked.indices) }],
      materials: [{ id: 0, tex: `Custom/${staged}` }],
    }), 'importing the textured prop')).json() as { id: number };
    lampId = lamp.id;

    const pulled = await getJson<PortalMesh>(`/api/blender/mesh?kind=import&id=${lamp.id}`);
    check(pulled.materials[0].tex === `Custom/${staged}`
      && (pulled.materials[0].texUrl ?? '').includes('/api/texture?level=Custom'),
      'a pull hands the addon the slot’s ref and a URL to fetch its PNG — not the bytes, which the bank serves');
    check(pulled.materials[0].png === undefined,
      'and no art travels outward inline, so a pull is not three times the size it needs to be');

    // Paint on it: the same mesh back, with the slot's art attached.
    const painted = await (await expectOk(post('/api/blender/mesh', {
      ...pulled,
      materials: [{ ...pulled.materials[0], png: tile([10, 220, 60, 255]).toString('base64') }],
    }), 'pushing replacement texture art')).json() as
      { textures?: number; forkedTextures?: number; name?: string };
    check(painted.textures === 1 && !painted.forkedTextures && painted.name === 'Lamp',
      'a push carrying art writes it and says so — and this one REPLACED the tile, so nothing forked');

    // A replace stores under a free name and retires the old one (docs/038), so what the slot wears MOVED.
    const bank = await getJson<{ tiles: { name: string }[] }>('/api/textures?level=Custom');
    check(bank.tiles.some(t => t.name === 'lamp_2.png') && !bank.tiles.some(t => t.name === 'lamp.png'),
      'the art landed under its own free name and the tile it replaced is gone — no URL changed meaning');
    const fresh = await getJson<{ models: { id: number; kind: string }[] }>('/api/blender');
    check(fresh.models.some(m => m.kind === 'import' && m.id === lamp.id), 'the prop is still model ' + lamp.id);
    const repointed = await getJson<PortalMesh>(`/api/blender/mesh?kind=import&id=${lamp.id}`);
    check(repointed.materials[0].tex === 'Custom/lamp_2.png',
      'and the record followed its tile onto the new ref rather than being left holding a deleted one');
    const art = decodePng(await (await expectOk(fetchForTest(
      api('/api/texture?level=Custom&name=lamp_2.png')), 'reading replacement texture art')).arrayBuffer()
      .then(bytes => Buffer.from(bytes)));
    check(art.data[1] > 200 && art.data[0] < 40, 'the bytes behind it are the ones painted in Blender');

    // The document's half of that move — painted cells, and the tile an authored model wears — cannot be
    // written from a route, so it waits in the same inbox the cages do.
    const moves = await getJson<{ pushes: { kind: string; from?: string; to?: string }[] }>('/api/blender/pending');
    check(moves.pushes.length === 1 && moves.pushes[0].kind === 'retex'
      && moves.pushes[0].from === `Custom/${staged}` && moves.pushes[0].to === 'Custom/lamp_2.png',
      'and the ref move waits for the editor, which applies it as one undoable edit');

    // Now the other half of the rule. The authored cage wears no tile at all, so its art has nowhere of its
    // own to replace — it FORKS into Custom, named for the prop, and rides in on the cage's own inbox entry.
    const cageMesh = await getJson<PortalMesh>('/api/blender/mesh?kind=model&id=2');
    const forked = await (await expectOk(post('/api/blender/mesh', {
      ...cageMesh,
      materials: [{ id: 0, name: 'clay', tex: null, png: tile([20, 40, 230, 255]).toString('base64') }],
    }), 'pushing forked texture art')).json() as { textures?: number; forkedTextures?: number };
    check(forked.textures === 1 && forked.forkedTextures === 1,
      'a slot with no Custom tile of its own forks one instead of writing where it was pointing');
    const inbox = await getJson<{ pushes: { kind: string; texture?: string }[] }>('/api/blender/pending');
    const cagePush = inbox.pushes.find(push => push.kind === 'model');
    check(cagePush?.texture === 'Custom/Rail_jump.png',
      'named for the PROP, and carried on the cage’s own push so the tile and the mesh are one Ctrl+Z');
    check(inbox.pushes.filter(push => push.kind === 'retex').length === 1,
      'a fork moves nothing, so it adds no retarget — "DONOR/0012.png" still means what it meant this morning');

    // Push the same tile again: now the slot DOES wear one of the author's own, so it replaces, and the
    // waiting move extends rather than queueing a second one the document would have to chain by hand.
    await expectOk(post('/api/blender/mesh', {
      ...pulled, materials: [{ id: 0, name: 'lamp', tex: 'Custom/lamp_2.png',
        png: tile([230, 220, 10, 255]).toString('base64') }],
    }), 'pushing the replacement texture again');
    const chained = (await getJson<{ pushes: { kind: string; from?: string; to?: string }[] }>(
      '/api/blender/pending')).pushes.filter(push => push.kind === 'retex');
    check(chained.length === 1 && chained[0].from === `Custom/${staged}` && chained[0].to === 'Custom/lamp_3.png',
      'pushing a tile twice leaves ONE move, naming the ref the document actually holds and where it goes');

    // The art is written before the geometry is, so a push whose MESH is refused has already moved a ref.
    // Reporting the refusal and dropping the move would leave every painted cell wearing that tile pointing
    // at a file this request deleted, which is a far worse outcome than the refusal itself.
    const half = await post('/api/blender/mesh', {
      ...pulled, faces: [[0, 0, 0]], faceMaterial: [0],
      materials: [{ id: 0, name: 'lamp', tex: 'Custom/lamp_3.png',
        png: tile([120, 120, 120, 255]).toString('base64') }],
    });
    check(half.status === 400 && ((await half.json()) as { error: string }).error.includes('no triangles'),
      'a push whose mesh is refused still answers with the reason');
    const survived = (await getJson<{ pushes: { kind: string; to?: string }[] }>('/api/blender/pending'))
      .pushes.filter(push => push.kind === 'retex');
    check(survived.length === 1 && survived[0].to === 'Custom/lamp_4.png',
      'and the ref its art already moved is still reported, not lost with the refusal');

    for (const push of (await getJson<{ pushes: { token: string }[] }>('/api/blender/pending')).pushes) {
      await expectOk(post(`/api/blender/ack?token=${encodeURIComponent(push.token)}`, {}),
        'draining a pending Blender push');
    }
  }

  // ---- refusals the add-on shows verbatim --------------------------------------------------------------
  const missing = await fetchForTest(api('/api/blender/mesh?kind=model&id=404'));
  check(missing.status === 400 && ((await missing.json()) as { error: string }).error.includes('no authored model'),
    'asking for a model this mountain does not have answers a reason, not a stack trace');
  const wrongKind = await fetchForTest(api('/api/blender/mesh?kind=terrain&id=1'));
  check(wrongKind.status === 400, 'and so does a kind the bridge does not carry');

  // ---- a second mountain: the add-on can work on one the browser does not have open ---------------------
  {
    const other = migrateMountain(collisionLabMountain('OTHER')) as unknown as { models?: unknown[] };
    other.models = [cubeModel('model:0009', 'Half pipe', [0, 0, 0])];
    // Creating a mountain ACTIVATES it, so from here the no-parameter default is this one — which is exactly
    // the situation the picker exists for: Blender is working on BRIDGE while the tab moved to OTHER.
    const second = await (await expectOk(post('/api/projects', { document: other }),
      'creating the second test mountain')).json() as
      { project: { id: string } };
    const now = await getJson<{ project: { id: string }; maps: unknown[] }>('/api/blender');
    check(now.project.id === second.project.id && now.maps.length === 2,
      'creating a second mountain moves the default, and both are listed');

    const named = await getJson<{ project: { id: string }; models: { id: number; name: string }[] }>(
      `/api/blender?project=${encodeURIComponent(projectId)}`);
    check(named.project.id === projectId && named.models.some(model => model.name === 'Rail jump'),
      'naming a mountain lists ITS models, whatever the editor has open');

    const away = await getJson<PortalMesh>(
      `/api/blender/mesh?kind=model&id=2&project=${encodeURIComponent(projectId)}`);
    check(away.stamp.project === projectId,
      'and pulling from it stamps the mountain it came from, not the active one');

    // The tile URLs have to name that mountain too. A `Custom/` ref addresses ONE map's bank, and the add-on
    // carries no tab id — so an unqualified URL resolves against whichever map is active, which here is the
    // other one. The prop would arrive as grey clay, and only for props wearing the author's own art:
    // an extracted level's bank is global, so those would keep working and hide the bug.
    const lampPortal = await getJson<PortalMesh>(
      `/api/blender/mesh?kind=import&id=${lampId}&project=${encodeURIComponent(projectId)}`);
    const lampUrl = lampPortal.materials[0].texUrl ?? '';
    check(lampUrl.includes(`project=${projectId}`),
      'a pulled tile’s URL names the mountain whose bank it lives in');
    const tileResponse = await fetchForTest(api(lampUrl));
    check(tileResponse.status === 200 && (await tileResponse.arrayBuffer()).byteLength > 0,
      'so the add-on still fetches it while a DIFFERENT mountain is the open one');

    const home = await (await expectOk(post(
      `/api/blender/mesh?project=${encodeURIComponent(projectId)}`, away),
    'pushing to the explicitly selected mountain')).json() as { pending?: boolean };
    check(home.pending === true,
      'a push addressed to that same mountain is accepted while a DIFFERENT one is open — the picker works');

    const stray = await post('/api/blender/mesh', away);
    check(stray.status === 400,
      'while the same push left unaddressed still refuses, because it would land in the open mountain');

    const inbox = await getJson<{ pushes: unknown[] }>(
      `/api/blender/pending?project=${encodeURIComponent(projectId)}`);
    check(inbox.pushes.length === 1, 'and the cage waits in the inbox of the mountain it belongs to');
    check((await getJson<{ pushes: unknown[] }>('/api/blender/pending')).pushes.length === 0,
      'not in the open one’s, which is what keeps two mountains’ pushes from crossing');
  }
} finally {
  try { await service?.close(); }
  finally { removeTestTree(root); }
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('blender-routes: all checks passed');
