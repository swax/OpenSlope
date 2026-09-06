/**
 * The HATEOAS surface (docs/052), over a real socket: the discovery root an agent lands on, the envelopes
 * that tell it what it may do, and the register endpoints it authors a mountain through.
 *
 * What is worth testing is not "does a link resolve" — a broken one fails loudly the first time anything
 * follows it — but the properties an agent cannot check for itself and would be misled by:
 *
 *  1. the root answers every identity honestly: unenrolled, anonymous (with the way in), and a bearer key;
 *  2. an unknown /api path answers with the way back to the root, not a bare 404;
 *  3. actions are gated the way the routes actually behave — disabled with the refusal's own reason;
 *  4. register writes land whole objects under the id their key names, fill an absent id, refuse a
 *     mismatched one, and report refused keys by name;
 *  5. effect graphs, nodes and slots are addressable through registers (a node's id carries its owner's
 *     prefix — the addressing a lastIndexOf would silently truncate);
 *  6. renaming through g/name is a rename, held to the same owner/moderator bar as every other rename;
 *  7. a map can be named at creation through the rename's own sanitiser, and the ground query answers
 *     real surface heights while staying open to viewers — a read despite arriving as POST;
 *  8. a reference level answers as its own branch, and its prop index names models WITHOUT their geometry —
 *     the whole point of it, since the payload it stands in front of is megabytes;
 *  9. the label index answers which quads and props a label holds, in the ids registers name them by, and
 *     a document can be read without a map being created from it;
 * 10. a selector write expands into the same registers an explicit one sends — the intersection it names, the
 *     ordering that lets an explicit key beat a rule, and the refusal of a label the map has not got — and
 *     `seat` puts a whole selection on the ground, a rail node by node, skipping what has no surface under it.
 *
 * Run: tsx test/hateoas-api.test.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchForTest, removeTestTree } from './http-test-support';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-hateoas-'));
const plainRoot = mkdtempSync(join(tmpdir(), 'slopesmith-hateoas-plain-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;

// One extracted level, the smallest that is really one: a folder the level list finds (Patches.json), a prop
// table that bakes (one model, one mesh, one placement) and a tile to count. The reference branch and the
// prop index are answers ABOUT a library, so they need a library rather than a stub.
const probe = join(root, 'PROBE');
mkdirSync(join(probe, 'Meshes'), { recursive: true });
mkdirSync(join(probe, 'Textures'), { recursive: true });
writeFileSync(join(probe, 'Patches.json'), '{"Patches":[]}');
writeFileSync(join(probe, 'Models.json'), JSON.stringify({ Models: [
  { ModelName: 'Mdl_Probe', ModelObjects: [{ MeshData: [{ MeshPath: 'probe.obj', MaterialID: 0 }] }] },
] }));
writeFileSync(join(probe, 'Instances.json'), JSON.stringify({ Instances: [
  { InstanceName: 'probe', Location: [0, 0, 0], Rotation: [0, 0, 0, 1], Scale: [1, 1, 1], ModelID: 0 },
] }));
writeFileSync(join(probe, 'Materials.json'), JSON.stringify({ Materials: [{ TexturePath: '0000.png' }] }));
writeFileSync(join(probe, 'Meshes', 'probe.obj'),
  'v 0 0 0\nv 100 0 0\nv 0 100 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n');
writeFileSync(join(probe, 'Textures', '0000.png'), '');

const { forgetWorkspaceConfig } = await import('../src/server/workspace-config');
const { forgetAccounts } = await import('../src/server/accounts/store');
const { forgetRateLimits } = await import('../src/server/accounts/rate-limit');
forgetWorkspaceConfig();
forgetAccounts();
forgetRateLimits();

const { startApiService } = await import('../src/server/main');
const { mintInvite } = await import('../src/server/accounts/invites');
const { setUserRole } = await import('../src/server/accounts/users');
const { configureCheckpoints } = await import('../src/server/projects');

configureCheckpoints({ intervalMs: 60_000, changeBytes: 1 << 30 });

interface Reply { status: number; body: any; text: string; cookie: string }

let service: Awaited<ReturnType<typeof startApiService>> | undefined;

async function call(method: string, path: string,
  options: { body?: unknown; cookie?: string; key?: string } = {}): Promise<Reply> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie) headers.cookie = options.cookie;
  if (options.key) headers.authorization = `Bearer ${options.key}`;
  if (!service) throw new Error('the test API service has not started');
  const res = await fetchForTest(`${service.url}${path}`, {
    method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = text; }
  const set = res.headers.get('set-cookie') ?? '';
  return { status: res.status, body, text, cookie: set.split(';')[0] ?? '' };
}

const links = (body: any): Map<string, any> =>
  new Map((body?._links ?? []).map((held: any) => [held.rel, held]));
const actions = (body: any): Map<string, any> =>
  new Map((body?._actions ?? []).map((held: any) => [held.rel, held]));

try {
  service = await startApiService({ port: 0, host: '127.0.0.1', accounts: true });

  // ---- 1. the root, before and after anyone exists ------------------------------------------------------
  const unenrolled = await call('GET', '/api');
  check(unenrolled.status === 200 && String(unenrolled.body?.error ?? '').includes('enrolled'),
    'before enrolment the root says the server is waiting, instead of guessing at links');

  const admin = await call('POST', '/api/auth/bootstrap', {
    body: { code: service.adminCode, username: 'Ada', password: 'first admin password' },
  });
  const adminCookie = admin.cookie;
  const invite = await mintInvite({ role: 'editor', handle: 'discord:grace', by: 'ada' });
  const grace = await call('POST', '/api/auth/redeem', {
    body: { token: invite.token, username: 'Grace', password: 'grace password one' },
  });
  const key = (await call('POST', '/api/auth/keys', { cookie: grace.cookie, body: { name: 'agent' } }))
    .body.key as string;
  check(typeof key === 'string' && key.length > 40, 'an editor mints the key the agent will arrive with');

  const anonymous = await call('GET', '/api');
  check(anonymous.status === 200
    && actions(anonymous.body).get('login')?.method === 'POST'
    && String(anonymous.body?.hint ?? '').includes('Bearer'),
    'an anonymous caller gets the way in — the login action and the bearer-key hint — and nothing else');
  check(!links(anonymous.body).has('maps'), 'and no tour of a server it cannot read');

  const home = await call('GET', '/api', { key });
  check(home.status === 200 && home.body?.identity?.kind === 'token'
    && ['maps', 'reference', 'avatars', 'guide', 'schemas'].every(name => links(home.body).has(name)),
    'a bearer key lands on the full directory, told apart as a key');
  check(!links(home.body).has('keys'),
    'which does not offer key management — a key cannot manage keys');

  // ---- 2. a miss answers with the way home --------------------------------------------------------------
  const lost = await call('GET', '/api/no/such/route', { key });
  check(lost.status === 404 && links(lost.body).get('root')?.href === '/api',
    'an unknown /api path is a 404 carrying the link back to the root');

  // ---- 3. the branch pages and contracts ----------------------------------------------------------------
  check((await call('GET', '/api/guide')).status === 401, 'the guide asks for a signed-in reader');
  const guide = await call('GET', '/api/guide', { key });
  check(guide.status === 200 && guide.text.includes('o/prop') && guide.text.includes('Bearer'),
    'and reads as the authoring manual: the register grammar and the credential story are both in it');

  const schemas = await call('GET', '/api/schemas', { key });
  check(schemas.status === 200 && (schemas.body.schemas ?? []).some((held: any) => held.name === 'AssignRegisters'),
    'the schema index names the register write');
  const assignSchema = await call('GET', '/api/schemas/AssignRegisters', { key });
  check(assignSchema.status === 200 && assignSchema.body?.properties?.changes?.type === 'array',
    'and each entry serves real JSON Schema');
  const missing = await call('GET', '/api/schemas/NoSuchSchema', { key });
  check(missing.status === 404 && links(missing.body).get('collection')?.href === '/api/schemas',
    'an unknown schema name points back at the index');

  const explorer = await fetchForTest(`${service.url}/api/explorer`);
  const explorerPage = await explorer.text();
  check(explorer.status === 200
    && (explorer.headers.get('content-type') ?? '').includes('text/html')
    && explorerPage.includes('Slopesmith API explorer'),
    'the interactive explorer page is served to a bare browser — it is how a human reaches the sign-in');
  check(links(home.body).get('explorer')?.href === '/api/explorer'
    && links(anonymous.body).get('explorer')?.href === '/api/explorer',
    'and the root offers it to humans, signed in or not');

  const reference = await call('GET', '/api/reference', { key });
  const referenceTemplates = new Map((reference.body._linkTemplates ?? [])
    .map((held: any) => [held.rel, held.hrefTemplate]));
  check(reference.status === 200 && referenceTemplates.has('level-props'),
    'the reference branch describes the extracted levels by template');
  check(referenceTemplates.get('item') === '/api/reference/{level}'
    && referenceTemplates.get('level-prop-index') === '/api/props/index?level={level}',
    'and offers one level as a branch of its own, with the slim prop index beside the whole payload');

  const level = await call('GET', '/api/reference/probe', { key });
  const levelLinks = links(level.body);
  check(level.status === 200 && level.body.level === 'PROBE'
    && level.body.origin?.retailData === true && level.body.holds?.props === true
    && level.body.holds?.textures === 1,
    'a level answers as its own branch — named as the folder is named, whatever case was asked for');
  check(levelLinks.get('level-prop-index')?.href === '/api/props/index?level=PROBE'
    && ['level', 'level-props', 'level-textures', 'level-effects', 'level-groups', 'level-lightrig',
      'level-sky', 'level-sounds', 'level-music'].every(rel => levelLinks.has(rel)),
    'with every part of it borrowable resolved into a link, the template already substituted');
  const noLevel = await call('GET', '/api/reference/NOSUCHLEVEL', { key });
  check(noLevel.status === 404 && links(noLevel.body).get('collection')?.href === '/api/reference',
    'and a name no folder answers to points back at the directory');

  const propIndex = await call('GET', '/api/props/index?level=PROBE', { key });
  const indexed = propIndex.body?.models?.[0];
  check(propIndex.status === 200 && propIndex.body.level === 'PROBE'
    && indexed?.id === 0 && indexed?.name === 'Mdl_Probe' && indexed?.tris === 1
    && indexed?.pages?.[0] === '0000.png',
    'the prop index names each model, what it costs and which tiles it wears');
  check(!('subs' in (indexed ?? { subs: null })),
    'and carries no geometry at all — which is the whole reason to read it instead of the payload');

  const banks = await call('GET', '/api/sound-banks?level=PROBE', { key });
  check(banks.status === 200 && Array.isArray(banks.body.banks),
    'the sound banks the reference branch links to are readable by the key that was told about them');

  const avatars = await call('GET', '/api/avatars', { key });
  check(avatars.status === 200
    && (avatars.body._actionTemplates ?? []).some((held: any) => held.rel === 'import'),
    'and the avatars branch carries the FBX import action');

  // ---- 4. creating a map from nothing -------------------------------------------------------------------
  const created = await call('POST', '/api/projects', { key, body: {} });
  check(created.status === 201 && (created.body?.document?.vertexIds?.length ?? 0) > 0,
    'POST /api/projects with an empty body answers the default starter mountain, whole');
  const mine = created.body.project.id as string;
  const mineActions = actions(created.body);
  check(mineActions.get('assignRegisters')?.disabled === undefined
    && mineActions.get('setPermissions')?.disabled === undefined,
    'and its actions are live for the creator, ownership included');
  check((created.body._actionTemplates ?? []).some((held: any) =>
    held.rel === 'uploadTexture' && held.hrefTemplate.includes(`project=${mine}`)),
    'upload actions carry ?project=, so a session-less agent is bound to this mountain explicitly');
  check(mineActions.get('queryGround')?.method === 'POST' && links(created.body).has('ground'),
    'and the envelope offers the ground query beside the registers');
  check(mineActions.get('seat')?.method === 'POST'
    && mineActions.get('seat')?.schema === '/api/schemas/SeatPlacements'
    && String(mineActions.get('assignRegisters')?.title ?? '').includes('rules'),
    'and the two selector writes are on it — seat as an action of its own, rules as the register write\'s');

  const christened = await call('POST', '/api/projects', { key, body: { name: 'NOEL TEST' } });
  check(christened.status === 201 && christened.body.project.name === 'NOELTEST'
    && christened.body.document?.name === 'NOELTEST',
    'a created map takes its name at birth, through the same sanitiser a rename uses');

  // The one write registers cannot make is the one an agent must not dead-end on: topology goes through the
  // document PUT, and everything it wants next — assign, seat, upload — hangs off the project resource.
  const replaced = await call('PUT', `/api/projects/${mine}/document`, {
    key, body: { baseRevision: created.body.project.revision, document: created.body.document },
  });
  check(replaced.status === 200 && actions(replaced.body).get('assignRegisters')?.method === 'POST'
    && links(replaced.body).get('self')?.href === `/api/projects/${mine}`,
    'a document PUT answers with the project\'s own envelope, so the walk continues from the write');
  const stale = await call('PUT', `/api/projects/${mine}/document`, {
    key, body: { baseRevision: 0, document: created.body.document },
  });
  check(stale.status === 409 && !('_links' in stale.body) && stale.body.document?.vertexIds?.length,
    'while the loser of the race gets the snapshot to rebase onto, unadorned by links it does not hold');

  const admins = await call('POST', '/api/projects', { cookie: adminCookie, body: {} });
  const theirs = admins.body.project.id as string;
  const visiting = await call('GET', `/api/projects/${theirs}`, { key });
  const visitingActions = actions(visiting.body);
  check(visitingActions.get('assignRegisters')?.disabled === undefined,
    'another member\'s map still accepts an editor\'s authoring');
  check(visitingActions.get('delete')?.disabled === true
    && String(visitingActions.get('delete')?.disabledReason ?? '').includes('owner or a moderator'),
    'but management is emitted disabled, with the refusal\'s own reason');

  // ---- 5. registers: the authoring write ----------------------------------------------------------------
  const wrote = await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [
    { key: 'o/gem/gem:0000', value: { pos: [10, 20, 30] } },
    { key: 'o/effect/graphs/graph:0000', value: { id: 'graph:0000', name: 'boost' } },
    { key: 'o/effect-node/graphs/graph:0000/graph:0000/node:0000',
      value: { id: 'graph:0000/node:0000', mainType: 17, payload: { type17: 5 }, references: {} } },
    { key: 'o/effect/slots/slot:0000', value: { id: 'slot:0000', circumstances: {
      persistent: null, collision: 'graph:0000', slot3: null, slot4: null,
      trigger: null, slot6: null, slot7: null } } },
    { key: 'v/not-a-vertex-this-map-ever-had', value: [0, 0, 0] },
  ] } });
  check(wrote.status === 200 && wrote.body.landed === 4 && wrote.body.refused === 1
    && wrote.body.refusedKeys?.[0] === 'v/not-a-vertex-this-map-ever-had',
    'a batch lands what it can and names what it refused, key by key');
  check(wrote.body.revision > 1, 'and the snapshot it produced is already on disk, revision named');

  const readBack = await call('GET',
    `/api/projects/${mine}/registers?keys=o/gem/gem:0000,o/effect-node/graphs/graph:0000/graph:0000/node:0000`,
    { key });
  const held = new Map((readBack.body.registers ?? []).map((pair: any) => [pair[0], pair[1]]));
  check((held.get('o/gem/gem:0000') as any)?.id === 'gem:0000',
    'an inserted object answers to its key, its absent id filled in from it');
  check((held.get('o/effect-node/graphs/graph:0000/graph:0000/node:0000') as any)?.mainType === 17,
    'and an effect node is addressable under its owner-prefixed id');

  const mismatched = await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [
    { key: 'o/gem/gem:0001', value: { id: 'gem:9999', pos: [0, 0, 0] } },
  ] } });
  check(mismatched.status === 400 && String(mismatched.body?.error ?? '').includes('gem:9999'),
    'an object claiming a different id than its key is refused before anything lands');

  const scoped = await call('GET', `/api/projects/${mine}/registers`, { key });
  check(scoped.status === 200
    && (scoped.body.registers ?? []).every((pair: any) => !String(pair[0]).startsWith('v/'))
    && (scoped.body.registers ?? []).some((pair: any) => pair[0] === 'course'),
    'the default read is the authoring state — objects, course, globals — never the vertex buffer');
  const terrain = await call('GET', `/api/projects/${mine}/registers?prefix=v/`, { key });
  check(terrain.body.count === created.body.document.vertexIds.length,
    'while ?prefix=v/ hands over exactly the vertex registers');

  // ---- 5b. where the ground is: heights off the actual surface ------------------------------------------
  const flat = created.body.document.vertices as number[];
  const mid = Math.floor(flat.length / 3 / 2);
  const [gx, gy, gz] = [flat[mid * 3], flat[mid * 3 + 1], flat[mid * 3 + 2]];
  const grounded = await call('POST', `/api/projects/${mine}/ground`,
    { key, body: { points: [[gx, gz], [gx + 1e6, gz + 1e6]] } });
  check(grounded.status === 200 && grounded.body.heights?.length === 2
    && Math.abs((grounded.body.heights[0] ?? 1e9) - gy) < 2,
    'the ground query answers the surface height a mid-mesh vertex actually sits at');
  check(grounded.body.heights[1] === null, 'and null where the mountain has no surface at all');
  const flooded = await call('POST', `/api/projects/${mine}/ground`,
    { key, body: { points: Array.from({ length: 4097 }, () => [0, 0]) } });
  check(flooded.status === 400, 'a batch over 4096 points is refused whole');
  check((await call('POST', `/api/projects/${mine}/ground`, { body: { points: [[0, 0]] } })).status === 401,
    'and the query still sits behind the server\'s front door');

  // ---- 5c. the label index: which quads and props a section holds ---------------------------------------
  const quads = created.body.document.quadIds as string[];
  const labelled = await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [
    { key: 'o/label/label:0000', value: { name: 'village', color: '#f06292' } },
    { key: 'o/label/label:0001', value: { name: 'nothing yet' } },
    { key: `q/${quads[0]}/labels`, value: ['label:0000'] },
    { key: `q/${quads[1]}/labels`, value: ['label:0000'] },
    { key: 'o/prop/prop:a001', value: { level: 'PROBE', model: 0, name: 'Mdl_Probe', pos: [0, 0, 0],
      yaw: 0, scale: 1, labels: ['label:0000'] } },
  ] } });
  check(labelled.status === 200 && labelled.body.landed === 5, 'a label, two labelled quads and a labelled prop land');

  const labels = await call('GET', `/api/projects/${mine}/labels`, { key });
  const village = (labels.body.labels ?? []).find((held: any) => held.id === 'label:0000');
  check(labels.status === 200 && village?.name === 'village' && village?.color === '#f06292'
    && village?.quadCount === 2 && village?.propCount === 1,
    'the label index counts what each label holds, quads and props apart');
  check((labels.body.labels ?? []).some((held: any) => held.id === 'label:0001' && held.quadCount === 0),
    'a label nothing carries yet is still listed — it is a section waiting to be filled');

  const one = await call('GET', `/api/projects/${mine}/labels/label:0000`, { key });
  check(one.status === 200 && one.body.quadIds?.length === 2 && one.body.quadIds.includes(quads[0])
    && one.body.propIds?.[0] === 'prop:a001',
    'and one label hands over the ids themselves — the quad and prop ids a register names');
  check(links(one.body).get('collection')?.href === `/api/projects/${mine}/labels`,
    'with the way back to the index it came from');
  const noLabel = await call('GET', `/api/projects/${mine}/labels/label:9999`, { key });
  check(noLabel.status === 404 && links(noLabel.body).has('collection'),
    'a label this map never defined is a 404 pointing at the ones it did');

  // ---- 5d. reading a document without creating a map, and pricing an export of one ----------------------
  const listing = await call('GET', '/api/projects', { key });
  check(actions(listing.body).get('validate')?.href === '/api/projects/validate',
    'the map collection offers the validate action beside create');
  const read = await call('POST', '/api/projects/validate', { key, body: { document: created.body.document } });
  check(read.status === 200 && read.body.ok === true
    && read.body.counts?.vertices === created.body.document.vertexIds.length
    && read.body.counts?.quads === quads.length && read.body.problems?.length === 0,
    'a real document validates, counted the way the server sees it');
  const torn = JSON.parse(JSON.stringify(created.body.document));
  torn.quads[0] = [0, 1, 2, 999999];
  const refused = await call('POST', '/api/projects/validate', { key, body: { document: torn } });
  check(refused.status === 200 && refused.body.ok === false
    && refused.body.problems?.[0]?.path === '$.quads[0]',
    'a quad naming a corner the vertex buffer has not got is named by path, not thrown from inside the migrator');
  check((await call('GET', '/api/projects', { key })).body.projects.length === listing.body.projects.length,
    'and validating created nothing');
  const dangling = JSON.parse(JSON.stringify((await call('GET', `/api/projects/${mine}`, { key })).body.document));
  dangling.effects.slots[0].circumstances.collision = 'graph:9999';
  const unresolved = await call('POST', '/api/projects/validate', { key, body: { document: dangling } });
  check(unresolved.body.ok === false
    && unresolved.body.problems?.[0]?.path === '$.effects.slots[0].circumstances.collision',
    'an effect slot naming a graph that is not there is answered by path as well, not as a paragraph');

  const stub = await call('POST', `/api/preflight?project=${mine}`, { key, body: { doc: {} } });
  check(stub.status === 400 && typeof stub.body?.error === 'string'
    && !/ at .*:\d+:\d+/.test(stub.body.error) && !/[A-Za-z]:[\\/]/.test(stub.body.error),
    'a preflight of something that is not a document is a 400 saying so — never a stack naming this machine');
  const priced = await call('POST', `/api/preflight?project=${mine}`,
    { key, body: { doc: created.body.document } });
  check(priced.status === 200 && priced.body.cells?.total === quads.length,
    'while a real one is summarised against the map the ?project= scope names');

  // ---- 5e. selector writes: one intent instead of a key per face ----------------------------------------
  // The intersection is the property worth pinning: "the trail quads inside this one section" is two labels,
  // and it must reach the faces carrying BOTH rather than either.
  const sections = await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [
    { key: 'o/label/label:0002', value: { name: 'trail' } },
    { key: `q/${quads[1]}/labels`, value: ['label:0000', 'label:0002'] },
    { key: `q/${quads[2]}/labels`, value: ['label:0002'] },
  ] } });
  check(sections.body.landed === 3, 'a second label overlaps the first on exactly one face');

  const painted = await call('POST', `/api/projects/${mine}/registers`, { key, body: { rules: [
    { where: { labels: ['village', 'trail'] },
      set: { paint: 5, tex: 'Custom/blue-ice.png', addLabel: 'label:0001' } },
  ] } });
  check(painted.status === 200 && painted.body.rules?.[0]?.matched === 1
    && painted.body.rules?.[0]?.keys === 3 && painted.body.landed === 3,
    'a rule naming two labels reaches the one face carrying both, and says how many keys that came to');
  const repainted = new Map(((await call('GET', `/api/projects/${mine}/registers`
    + `?keys=q/${quads[1]}/paint,q/${quads[1]}/tex,q/${quads[1]}/labels,q/${quads[0]}/tex`, { key }))
    .body.registers ?? []).map((pair: any) => [pair[0], pair[1]]));
  check(repainted.get(`q/${quads[1]}/paint`) === 5
    && repainted.get(`q/${quads[1]}/tex`) === 'Custom/blue-ice.png'
    && (repainted.get(`q/${quads[1]}/labels`) as string[]).includes('label:0001'),
    'the face it matched holds the ordinary registers the rule expanded into, the added label among them');
  check(!repainted.has(`q/${quads[0]}/tex`),
    'and the face carrying only one of the two labels was never touched');

  const mistyped = await call('POST', `/api/projects/${mine}/registers`, { key, body: { rules: [
    { where: { label: 'villag' }, set: { paint: 1 } },
  ] } });
  check(mistyped.status === 400 && String(mistyped.body?.error ?? '').includes('villag'),
    'a rule naming a label this map has not got is refused BY NAME — never silently matched against nothing');

  const patched = await call('POST', `/api/projects/${mine}/registers`, { key, body: { rules: [
    { where: { label: 'trail' }, set: { pos: [0, 0, 0] } },
  ] } });
  check(patched.status === 400 && String(patched.body?.error ?? '').includes('o/prop'),
    'and one reaching for a prop field is refused with the rule it would have broken: no patch below a register');

  const contested = await call('POST', `/api/projects/${mine}/registers`, { key, body: {
    changes: [{ key: `q/${quads[1]}/paint`, value: 9 }],
    rules: [{ where: { label: 'trail' }, set: { paint: 2 } }],
  } });
  check(contested.body.rules?.[0]?.matched === 2, 'a later rule reaches both faces the label holds');
  const resolved = new Map(((await call('GET', `/api/projects/${mine}/registers`
    + `?keys=q/${quads[1]}/paint,q/${quads[2]}/paint`, { key })).body.registers ?? [])
    .map((pair: any) => [pair[0], pair[1]]));
  check(resolved.get(`q/${quads[1]}/paint`) === 9 && resolved.get(`q/${quads[2]}/paint`) === 2,
    'while an explicit change beats the rule that touched the same key — rules expand first, changes land last');

  // ---- 5f. seat: putting a whole selection on the ground ------------------------------------------------
  // Three points whose surface heights really differ, so seating a rail node by node is a different answer
  // from seating the whole rail off its first node.
  const corners: number[][] = [];
  for (let at = 0; at * 3 < flat.length && corners.length < 3; at += 5) {
    const point = [flat[at * 3], flat[at * 3 + 1], flat[at * 3 + 2]];
    if (corners.every(held => Math.abs(held[1] - point[1]) > 1)) corners.push(point);
  }
  const placed = await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [
    { key: 'o/label/label:0003', value: { name: 'seating' } },
    { key: 'o/prop/prop:seat-a', value: { level: 'PROBE', model: 0, name: 'Mdl_Probe',
      pos: [gx, 999, gz], yaw: 0, scale: 1, labels: ['label:0003'] } },
    { key: 'o/prop/prop:seat-b', value: { level: 'PROBE', model: 0, name: 'Mdl_Probe',
      pos: [gx + 1e6, 5, gz + 1e6], yaw: 0, scale: 1, labels: ['label:0003'] } },
    { key: 'o/rail/rail:seat', value: { nodes: corners.map(([x, , z]) => [x, 0, z]), height: 1 } },
  ] } });
  check(placed.body.landed === 4 && corners.length === 3,
    'two props at the wrong height, a rail lying flat, and the label that names the section');

  const seated = await call('POST', `/api/projects/${mine}/seat`,
    { key, body: { where: { labels: ['seating'] }, ids: ['rail:seat'], offset: 1.5 } });
  check(seated.status === 200 && seated.body.seated === 2 && seated.body.skipped === 1
    && seated.body.unchanged === 0,
    'seat moves the labelled section and the rail named beside it, counting the point with no surface');

  const standing = new Map(((await call('GET', `/api/projects/${mine}/registers`
    + '?keys=o/prop/prop:seat-a,o/prop/prop:seat-b,o/rail/rail:seat', { key })).body.registers ?? [])
    .map((pair: any) => [pair[0], pair[1]]));
  const seatA = standing.get('o/prop/prop:seat-a') as { pos: number[] };
  const seatB = standing.get('o/prop/prop:seat-b') as { pos: number[] };
  const rail = standing.get('o/rail/rail:seat') as { nodes: number[][] };
  const under = (await call('POST', `/api/projects/${mine}/ground`, { key, body: {
    points: [[seatA.pos[0], seatA.pos[2]], ...rail.nodes.map(node => [node[0], node[2]])],
  } })).body.heights as number[];
  check(seatA.pos[1] === under[0] + 1.5 && under[0] !== null,
    'a seated prop stands the offset above the surface under it — the offset kept, not rounded away');
  check(seatB.pos[1] === 5,
    'while one over nothing keeps the height it had: a point with no surface is skipped, never dropped to zero');
  check(rail.nodes.every((node, at) => node[1] === under[at + 1] + 1.5)
    && new Set(under.slice(1)).size > 1,
    'and every node of a rail follows its own ground, so it lies along the slope instead of pivoting');

  const resettled = await call('POST', `/api/projects/${mine}/seat`,
    { key, body: { where: { label: 'seating' }, ids: ['rail:seat'], offset: 1.5 } });
  check(resettled.body.seated === 0 && resettled.body.unchanged === 2 && resettled.body.skipped === 1,
    'seating the same selection again moves nothing — it assigns where the ground is, absolutely');
  const nobody = await call('POST', `/api/projects/${mine}/seat`, { key, body: { ids: ['prop:nobody'] } });
  check(nobody.status === 400 && String(nobody.body?.error ?? '').includes('prop:nobody'),
    'and an id naming no placement is refused by name rather than counted as a skip');

  // ---- 5g. intents: the run as a ruler, positions in its terms, rows, variants and shapes ----------------
  const ruler = await call('GET', `/api/projects/${mine}/course?every=100`, { key });
  const knotCount = created.body.document.course.knots.length as number;
  const lastStation = ruler.body.stations?.[ruler.body.stations.length - 1];
  check(ruler.status === 200 && ruler.body.length > 100 && ruler.body.knots?.length === knotCount
    && ruler.body.knots[0].station === 0 && ruler.body.stations?.[0]?.station === 0
    && typeof ruler.body.stations[1]?.heading === 'number' && typeof ruler.body.stations[1]?.ground === 'number'
    && lastStation?.station === ruler.body.length,
    'GET …/course answers the run as a ruler: its length, each knot\'s station, a station table with heading and ground');
  const exact = await call('GET', `/api/projects/${mine}/course?at=50,150`, { key });
  check(exact.body.stations?.length === 2 && exact.body.stations[1].station === 150,
    'and ?at= names the stations to read');
  const beyond = await call('GET', `/api/projects/${mine}/course?at=${Math.ceil(ruler.body.length) + 500}`, { key });
  check(beyond.status === 400 && String(beyond.body?.error ?? '').includes(String(Math.floor(ruler.body.length))),
    'while a station off the end of the run is refused with the run\'s length in the answer');

  const row = await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [
    { key: 'o/prop/prop:lamp-{i}', value: { level: 'PROBE', model: 0, name: 'lamp {i}', scale: 1,
      pos: { station: 100, lateral: 6, above: 0.5 }, yaw: 'course+90' },
      repeat: { every: 20, until: 160 } },
  ] } });
  check(row.status === 200 && row.body.landed === 4 && row.body.intents?.repeated === 4
    && row.body.intents?.placed === 4 && row.body.intents?.unseated === 0,
    'one change with repeat.every lands a row of four lamps, counted as intents in the answer');
  const lamps = new Map(((await call('GET', `/api/projects/${mine}/registers?prefix=o/prop/prop:lamp-`, { key }))
    .body.registers ?? []).map((pair: any) => [pair[0], pair[1]]));
  const lamp0 = lamps.get('o/prop/prop:lamp-0') as any, lamp3 = lamps.get('o/prop/prop:lamp-3') as any;
  const lampStations = (await call('GET', `/api/projects/${mine}/course?at=100,160`, { key })).body.stations;
  const lampGround = (await call('POST', `/api/projects/${mine}/ground`, { key, body: {
    points: [[lamp0.pos[0], lamp0.pos[2]], [lamp3.pos[0], lamp3.pos[2]]],
  } })).body.heights as number[];
  check(lamps.size === 4 && lamp0?.name === 'lamp 0' && lamp3?.name === 'lamp 3' && lamp0.id === 'prop:lamp-0'
    && Math.abs(lamp0.pos[1] - (lampGround[0] + 0.5)) < 0.002 && Math.abs(lamp3.pos[1] - (lampGround[1] + 0.5)) < 0.002,
    'each clone takes its index, and stands half a metre over the ground under its own resolved position');
  const off = (lamp: any, station: any) => Math.hypot(lamp.pos[0] - station.pos[0], lamp.pos[2] - station.pos[2]);
  const bearing = (lamp: any, station: any) =>
    ((Math.atan2(lamp.pos[0] - station.pos[0], lamp.pos[2] - station.pos[2]) * 180 / Math.PI) % 360 + 360) % 360;
  const rightOfLine = (station: any) => ((station.heading - 90) % 360 + 360) % 360;
  check(Math.abs(off(lamp0, lampStations[0]) - 6) < 0.01 && Math.abs(off(lamp3, lampStations[1]) - 6) < 0.01
    && Math.abs(bearing(lamp0, lampStations[0]) - rightOfLine(lampStations[0])) < 0.5,
    'a positive lateral stands six metres to the rider\'s right of the line at its station, at 100 and at 160');
  check(Math.abs(lamp0.yaw - ((lampStations[0].heading + 90) % 360)) < 0.01,
    'and yaw "course+90" resolves to the run\'s heading there plus ninety, facing the rider\'s left');
  const whereabouts = await call('GET',
    `/api/projects/${mine}/course?near=${lamp0.pos[0]},${lamp0.pos[2]};${lamp3.pos[0]},${lamp3.pos[2]}`, { key });
  check(whereabouts.status === 200 && whereabouts.body.stations?.length === 0 && whereabouts.body.near?.length === 2
    && Math.abs(whereabouts.body.near[0].station - 100) < 0.05 && Math.abs(whereabouts.body.near[0].lateral - 6) < 0.05
    && Math.abs(whereabouts.body.near[1].station - 160) < 0.05 && Math.abs(whereabouts.body.near[1].lateral - 6) < 0.05,
    '?near= reads a point back in run terms — the station and lateral it was placed by, to the centimetre');

  const variant = await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [
    { key: 'o/prop/prop:bench', from: 'o/prop/prop:lamp-1', value: { name: 'bench', pos: [gx, null, gz], yaw: 'course' } },
    { key: 'o/gem/gem:floating', value: { pos: [gx, '+2', gz] } },
    { key: 'o/model/model:0040', value: { name: 'shed', texture: 'PROBE/0000.png', solid: true,
      shape: { kind: 'house', size: [8, 3, 6], ridge: 5, segments: [3, 2] } } },
    { key: 'o/model/model:0041', value: { shape: { kind: 'box', size: [1, 1, 1] } } },
    { key: 'o/model/model:0042', value: { name: 'sign', shape: { kind: 'panel', size: [2, 1], segments: [2, 1], double: true } } },
    { key: 'o/model/model:0043', value: { name: 'roof', shape: { kind: 'roof', size: [8, 6], eave: 2.8, ridge: 5, segments: 3 } } },
  ] } });
  check(variant.status === 200 && variant.body.landed === 6 && variant.body.intents?.copied === 1
    && variant.body.intents?.shaped === 4 && variant.body.intents?.placed === 2,
    'a variant by `from`, two ground-relative placements and four shapes land as one batch');
  const made = new Map(((await call('GET', `/api/projects/${mine}/registers?keys=o/prop/prop:bench,o/gem/gem:floating,`
    + 'o/model/model:0040,o/model/model:0041,o/model/model:0042,o/model/model:0043', { key })).body.registers ?? [])
    .map((pair: any) => [pair[0], pair[1]]));
  const bench = made.get('o/prop/prop:bench') as any;
  const benchGround = (await call('POST', `/api/projects/${mine}/ground`, { key, body: { points: [[gx, gz]] } })).body.heights[0];
  check(bench?.id === 'prop:bench' && bench.level === 'PROBE' && bench.model === 0 && bench.scale === 1
    && bench.name === 'bench' && typeof bench.yaw === 'number' && Math.abs(bench.pos[1] - benchGround) < 0.002,
    'the copy carries the source\'s fields under its own id, with the merged name, a ground Y and a resolved yaw');
  const floating = made.get('o/gem/gem:floating') as any;
  check(Math.abs(floating?.pos[1] - (benchGround + 2)) < 0.002, 'and "+2" for Y is two metres over that ground');
  const shed = made.get('o/model/model:0040') as any;
  const wedges = (shed?.quads ?? []).filter((quad: number[]) => quad[2] === quad[3]).length;
  check(shed?.id === 'model:0040' && shed.name === 'shed' && shed.texture === 'PROBE/0000.png' && shed.solid === true
    && !('shape' in shed) && shed.quads.length === 12 && wedges === 2 && shed.vertices.length === 66
    && shed.anchor.join() === '0,0,0',
    'a house shape is ten wall quads and two gable wedges over 22 shared vertices, anchored at its base centre — the recipe gone');
  const crate = made.get('o/model/model:0041') as any, sign = made.get('o/model/model:0042') as any,
    lid = made.get('o/model/model:0043') as any;
  check(crate?.name === 'box' && crate.quads.length === 5 && crate.vertices.length === 24
    && sign?.quads.length === 4 && sign.vertices.length === 18
    && lid?.quads.length === 6 && lid.vertices.length === 36 && Math.max(...lid.vertices.filter((_: number, i: number) => i % 3 === 1)) === 5,
    'a box is five faces on eight corners, a double panel four quads on six, a three-segment roof six planes meeting at the ridge');

  const selfCopy = await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [
    { key: 'o/prop/prop:lamp-0', from: 'o/prop/prop:lamp-0', value: { name: 'patched' } },
  ] } });
  check(selfCopy.status === 400 && String(selfCopy.body?.error ?? '').includes('whole'),
    'a copy onto its own key is refused as the per-field patch it would be');
  const unindexed = await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [
    { key: 'o/gem/gem:solo', value: { pos: [gx, null, gz] }, repeat: { count: 2 } },
  ] } });
  check(unindexed.status === 400 && String(unindexed.body?.error ?? '').includes('{i}'),
    'a repeat whose key has no {i} is refused before anything lands');
  const voided = await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [
    { key: 'o/gem/gem:void', value: { pos: [gx + 1e6, null, gz + 1e6] } },
  ] } });
  check(voided.status === 400 && String(voided.body?.error ?? '').includes('terrain'),
    'and "on the ground" over no terrain is refused rather than dropped to zero');
  const unrow = await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [
    { key: 'o/prop/prop:lamp-{i}', remove: true, repeat: { count: 4 } },
  ] } });
  const gone = await call('GET', `/api/projects/${mine}/registers?prefix=o/prop/prop:lamp-`, { key });
  check(unrow.body.landed === 4 && gone.body.count === 0, 'the same repeat with remove takes the row away again');

  // ---- 6. renaming is a rename, wherever it arrives from ------------------------------------------------
  const renamed = await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [
    { key: 'g/name', value: 'AGENT PROVING GROUND' },
  ] } });
  check(renamed.status === 200 && renamed.body.landed === 1, 'the map\'s owner renames it through g/name');
  const renameTheirs = await call('POST', `/api/projects/${theirs}/registers`, { key, body: { changes: [
    { key: 'g/name', value: 'NOT YOURS' },
  ] } });
  check(renameTheirs.status === 403 && String(renameTheirs.body?.error ?? '').includes('rename'),
    'and somebody else\'s map refuses the same write with the rename rule');

  // ---- 7. what a role change does to the surface --------------------------------------------------------
  const noted = await call('POST', `/api/projects/${mine}/checkpoints`,
    { key, body: { note: 'authored over HATEOAS' } });
  check(noted.status === 201, 'a checkpoint sets the pass down in history');

  await setUserRole('grace', 'viewer');
  const demoted = await call('GET', `/api/projects/${mine}`, { key });
  check(actions(demoted.body).get('assignRegisters')?.disabled === true
    && String(actions(demoted.body).get('assignRegisters')?.disabledReason ?? '').includes('editor'),
    'a demotion turns the action surface read-only, reasons attached');
  check((await call('POST', `/api/projects/${mine}/registers`, { key, body: { changes: [] } })).status === 403,
    'and the route refuses the same way the envelope said it would');
  check((await call('POST', `/api/projects/${mine}/ground`, { key, body: { points: [[gx, gz]] } })).status === 200,
    'while the ground query stays open to the demoted viewer — a read despite its method');
  check((await call('POST', `/api/projects/${mine}/seat`, { key, body: { ids: ['prop:seat-a'] } }))
    .status === 403,
    'and its neighbour seat is refused with the rest of the writes: it asks the same question, then moves things');
  check((await call('GET', `/api/projects/${mine}/labels`, { key })).status === 200,
    'and so does the label index, which is a read like every other read of a map');

  await service.close();
  service = undefined;

  // ---- 8. a server nobody configured serves its owner ---------------------------------------------------
  process.env.SLOPESMITH_WORKSPACE_ROOT = plainRoot;
  process.env.SLOPESMITH_MAPS_ROOT = plainRoot;
  forgetWorkspaceConfig();
  forgetAccounts();
  forgetRateLimits();
  service = await startApiService({ port: 0, host: '127.0.0.1', accounts: false });
  const owner = await call('GET', '/api');
  check(owner.status === 200 && owner.body?.identity?.kind === 'owner'
    && links(owner.body).has('maps'),
    'with no accounts the root serves the owner the whole directory, no credential asked');
  const local = await call('POST', '/api/projects', { body: {} });
  check(local.status === 201
    && actions(local.body).get('delete')?.disabled === undefined,
    'and every action on their own map is live');
} finally {
  try { await service?.close(); }
  finally {
    try { removeTestTree(root); }
    finally { removeTestTree(plainRoot); }
  }
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('hateoas-api: all checks passed');
