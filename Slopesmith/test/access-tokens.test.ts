/**
 * Personal access keys (docs/046), over a real socket on a server that requires accounts.
 *
 * A key is the credential the Blender add-on carries to a hosted Slopesmith, and it lives as plain text in
 * `userpref.blend` on whatever machine Blender is installed on. So the properties worth testing are not
 * "does it authenticate" — that one fails loudly — but the four that fail SILENTLY, each of which would leave
 * a key more powerful than the account it belongs to:
 *
 *  1. a key can never satisfy the `admin` role, whatever role its owner holds;
 *  2. a key cannot mint another key, so revoking one really ends it;
 *  3. a key resolves its owner's role at REQUEST time, so a demotion binds immediately;
 *  4. revoking a key, and disabling its account, both take effect on the very next request.
 *
 * Run: tsx test/access-tokens.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchForTest, removeTestTree } from './http-test-support';
import { check, failures } from './check';

const root = mkdtempSync(join(tmpdir(), 'slopesmith-keys-'));
/** A second workspace for the no-accounts half: `requiresAccounts` reads the record, so the two servers
 *  cannot share one. */
const plainRoot = mkdtempSync(join(tmpdir(), 'slopesmith-keys-plain-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;

const { forgetWorkspaceConfig } = await import('../src/server/workspace-config');
const { forgetAccounts } = await import('../src/server/accounts/store');
const { forgetRateLimits } = await import('../src/server/accounts/rate-limit');
forgetWorkspaceConfig();
forgetAccounts();
forgetRateLimits();

const { startApiService } = await import('../src/server/main');
const { mintInvite } = await import('../src/server/accounts/invites');
const { setUserDisabled, setUserRole } = await import('../src/server/accounts/users');
const { ACCESS_TOKEN_PREFIX, MAX_TOKENS_PER_USER } = await import('../src/server/accounts/tokens');
const { configureCheckpoints } = await import('../src/server/projects');
const { collisionLabMountain } = await import('../src/core/collision/lab');
const { migrateMountain } = await import('../src/core/doc/mountain');

configureCheckpoints({ intervalMs: 60_000, changeBytes: 1 << 30 });

interface Reply { status: number; body: any; cookie: string }

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
  return { status: res.status, body, cookie: set.split(';')[0] ?? '' };
}

try {
  service = await startApiService({ port: 0, host: '127.0.0.1', accounts: true });
  // ---- an enrolled server with an admin, an editor, and a mountain to act on ----------------------------
  const enrolled = await call('POST', '/api/auth/bootstrap', {
    body: { code: service.adminCode, username: 'Ada', password: 'first admin password' },
  });
  check(enrolled.status === 201 && enrolled.body?.user?.role === 'admin', 'a server with accounts enrols an admin');
  const adminCookie = enrolled.cookie;

  const invite = await mintInvite({ role: 'editor', handle: 'discord:grace', by: 'ada' });
  const joined = await call('POST', '/api/auth/redeem', {
    body: { token: invite.token, username: 'Grace', password: 'grace password one' },
  });
  check(joined.status === 201 && joined.body?.user?.role === 'editor', 'and an editor joins by invite');
  const editorCookie = joined.cookie;

  // The bridge acts on a mountain, so there has to be one.
  const map = await call('POST', '/api/projects',
    { cookie: adminCookie, body: { document: migrateMountain(collisionLabMountain('KEYS')) } });
  check(map.status === 201 || map.status === 200, 'and the admin makes a mountain for the bridge to answer about');

  // A request that names no mountain at all is a refusal with a reason, not a crash — the state a program
  // with no browser tab meets first on a server whose workspace is still empty.
  const nowhere = await call('GET', '/api/blender?project=not-a-real-mountain', { cookie: adminCookie });
  check(nowhere.status === 409 && String(nowhere.body?.error).includes('no mountain'),
    'a bridge request naming a mountain the server does not have answers 409 and says so');

  // ---- minting -------------------------------------------------------------------------------------------
  const minted = await call('POST', '/api/auth/keys', { cookie: editorCookie, body: { name: 'Blender · studio' } });
  const key = minted.body?.key as string;
  check(minted.status === 200 && typeof key === 'string' && key.startsWith(ACCESS_TOKEN_PREFIX),
    `a member mints a key, and it is recognisable on sight (${ACCESS_TOKEN_PREFIX}…)`);
  check(key.length > 40, 'and it is long enough to be a credential rather than a guess');

  const listed = await call('GET', '/api/auth/keys', { cookie: editorCookie });
  check(listed.status === 200 && listed.body.tokens.length === 1
    && listed.body.tokens[0].name === 'Blender · studio',
    'it appears in the owner’s list under the name they gave it');
  check(!JSON.stringify(listed.body).includes(key),
    'and the listing never carries the secret again — the server keeps only its digest');

  // ---- it authenticates ------------------------------------------------------------------------------------
  check((await call('GET', '/api/blender')).status === 401,
    'the bridge refuses a caller with no credential at all');
  const pulled = await call('GET', '/api/blender', { key });
  check(pulled.status === 200 && Array.isArray(pulled.body?.maps),
    'and answers the same request carrying the key');

  // ---- 1. a key is the account MINUS administration ---------------------------------------------------------
  const adminKey = (await call('POST', '/api/auth/keys', { cookie: adminCookie, body: { name: 'admin key' } }))
    .body.key as string;
  check((await call('GET', '/api/config', { cookie: adminCookie })).status === 200,
    'an admin reads the machine-local config from the editor');
  const byKey = await call('GET', '/api/config', { key: adminKey });
  check(byKey.status === 403 && byKey.body?.token === true,
    'but their own KEY cannot — a key authors, it does not administer, whatever role it belongs to');

  // ---- 2. a key cannot mint another key ----------------------------------------------------------------------
  const selfMint = await call('POST', '/api/auth/keys', { key, body: { name: 'a successor' } });
  check(selfMint.status === 403 && selfMint.body?.token === true,
    'a key cannot mint another key, so revoking one really is the end of it');
  check((await call('GET', '/api/auth/keys', { key })).status === 403,
    'nor can it even list them');

  // ---- 3. the role is resolved per request, never baked into the key --------------------------------------------
  const writable = await call('POST', '/api/projects', {
    key, body: { document: migrateMountain(collisionLabMountain('KEY_OWNED')) },
  });
  check(writable.status === 201 && writable.body?.project?.ownerId === joined.body?.user?.id,
    'an editor’s key creates a mountain under that editor’s stable ownership identity');
  await setUserRole('grace', 'viewer');
  const demoted = await call('GET', '/api/blender', { key });
  check(demoted.status === 200, 'after a demotion to viewer the key still reads');
  const refusedWrite = await call('POST', '/api/blender/mesh', { key, body: { nope: true } });
  check(refusedWrite.status === 403,
    'but no longer writes — the role came from the account at request time, not from the credential');
  await setUserRole('grace', 'editor');
  check((await call('POST', '/api/blender/mesh', { key, body: { nope: true } })).status === 400,
    'and a promotion binds just as immediately (400 now: past the gate, refused on its contents)');

  // ---- 4. revocation, and the account going away ------------------------------------------------------------------
  const second = await call('POST', '/api/auth/keys', { cookie: editorCookie, body: { name: 'laptop' } });
  const laptop = second.body.key as string;
  check((await call('GET', '/api/blender', { key: laptop })).status === 200, 'a second key works too');
  const revoked = await call('POST', '/api/auth/keys/revoke',
    { cookie: editorCookie, body: { id: second.body.token.id } });
  check(revoked.body?.revoked === true, 'revoking one reports that it did');
  check((await call('GET', '/api/blender', { key: laptop })).status === 401,
    'and it stops working on the very NEXT request — no expiry to wait out');
  check((await call('GET', '/api/blender', { key })).status === 200,
    'while the other key of the same account is untouched');

  const mine = await call('GET', '/api/auth/keys', { cookie: adminCookie });
  check(mine.body.tokens.length === 1 && mine.body.tokens[0].name === 'admin key',
    'a listing shows only the caller’s OWN keys');
  const foreign = await call('POST', '/api/auth/keys/revoke',
    { cookie: adminCookie, body: { id: second.body.token.id } });
  check(foreign.body?.revoked === false,
    'and one member cannot revoke another’s key by guessing its id');

  // A password change deliberately LEAVES keys alone (rotating a password must not break every machine);
  // disabling the account, which is the response to an actual compromise, takes them.
  await call('POST', '/api/auth/password',
    { cookie: editorCookie, body: { current: 'grace password one', password: 'grace password two' } });
  check((await call('GET', '/api/blender', { key })).status === 200,
    'a password change leaves keys working — they are independent credentials, revocable on their own');
  await setUserDisabled('grace', true);
  check((await call('GET', '/api/blender', { key })).status === 401,
    'disabling the account ends every key it holds, on the next request');
  await setUserDisabled('grace', false);
  check((await call('GET', '/api/blender', { key })).status === 401,
    'and re-enabling does NOT bring them back — a revoked key stays revoked');

  // ---- the cap ----------------------------------------------------------------------------------------------------
  {
    let refusal = '';
    for (let i = 0; i < MAX_TOKENS_PER_USER + 2; i++) {
      const reply = await call('POST', '/api/auth/keys', { cookie: adminCookie, body: { name: `k${i}` } });
      if (reply.status !== 200) { refusal = String(reply.body?.error ?? ''); break; }
    }
    check(refusal.includes(`${MAX_TOKENS_PER_USER} keys already`),
      `a member is stopped at ${MAX_TOKENS_PER_USER} live keys rather than accumulating ways in`);
  }

  // ---- an unmatched key is nobody, and never an error --------------------------------------------------------------
  check((await call('GET', '/api/blender', { key: `${ACCESS_TOKEN_PREFIX}notarealkeyatall` })).status === 401,
    'a key the server has never seen is simply anonymous');
  check((await call('GET', '/api/blender', { key: 'garbage without a prefix' })).status === 401,
    'and so is a malformed one — no branch of this treats a bad credential as a good one');

  await service.close();
  service = undefined;

  // ---- a server with no accounts says so instead of handing out a useless secret ------------------------------------
  // Its OWN workspace: `requiresAccounts` reads the record, so a server pointed at the one above would still
  // demand a sign-in however it was started.
  process.env.SLOPESMITH_WORKSPACE_ROOT = plainRoot;
  process.env.SLOPESMITH_MAPS_ROOT = plainRoot;
  forgetWorkspaceConfig();
  forgetAccounts();
  forgetRateLimits();
  // `accounts` is sticky when omitted — `startApiService` only writes the flag it was given — so this says so.
  service = await startApiService({ port: 0, host: '127.0.0.1', accounts: false });
  await call('POST', '/api/projects', { body: { document: migrateMountain(collisionLabMountain('PLAIN')) } });
  const loopback = await call('POST', '/api/auth/keys', { body: { name: 'pointless' } });
  check(loopback.status === 400 && String(loopback.body?.error).includes('needs no key'),
    'on a server with no accounts, minting a key is refused with the reason — the add-on is already you');
  check((await call('GET', '/api/blender')).status === 200,
    'because the bridge answers it with no credential at all');
} finally {
  try { await service?.close(); }
  finally {
    try { removeTestTree(root); }
    finally { removeTestTree(plainRoot); }
  }
}

if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('access-tokens: all checks passed');
