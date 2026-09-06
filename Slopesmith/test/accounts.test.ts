import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createCanvas } from '@napi-rs/canvas';
import { request, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adminCodeBanner, issueAdminCode } from '../src/server/accounts/bootstrap';
import { authorize, authorizeRequest, identify, OWNER } from '../src/server/accounts/guard';
import { mintInvite } from '../src/server/accounts/invites';
import { clientAddress, configureAccounts, isSecureOrigin } from '../src/server/accounts/policy';
import { forgetRateLimits } from '../src/server/accounts/rate-limit';
import { revokeUserSessions } from '../src/server/accounts/sessions';
import { forgetAccounts, readAccounts, updateAccounts } from '../src/server/accounts/store';
import { listUsers, setUserRole } from '../src/server/accounts/users';
import { accessFor } from '../src/server/app';
import { startApiService, type ApiService } from '../src/server/main';
import { deleteProject, listProjects } from '../src/server/projects';
import { defaultMountain } from '../src/core/doc/mountain';
import { forgetWorkspaceConfig } from '../src/server/workspace-config';
import { check, failures } from './check';

/**
 * The identity layer (docs/038), over a real socket.
 *
 * Everything here goes through `startApiService`, so what is under test is the request path an editor
 * actually takes: the route table in `app.ts`, the one identity function behind it, real cookies and real
 * headers. Two servers are exercised in turn — one nobody configured for accounts, which must serve its
 * owner and never stand between somebody and their own workspace, and one that requires them, which must
 * hold every property the design is paying for.
 */

const root = mkdtempSync(join(tmpdir(), 'slopesmith-accounts-'));
process.env.SLOPESMITH_WORKSPACE_ROOT = root;
process.env.SLOPESMITH_MAPS_ROOT = root;
forgetWorkspaceConfig();
forgetAccounts();

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  json: any;
  text: string;
  bytes: Buffer;
  /** The `set-cookie` lines, which is where the session's own properties are asserted. */
  cookies: string[];
}

interface CallOptions {
  body?: unknown;
  /** A cookie header to send back — the browser's half of a session. */
  cookie?: string;
  /** The `Host` this request claims to be for, which is what the secure-origin rule reads. */
  host?: string;
  headers?: Record<string, string>;
}

function call(service: ApiService, method: string, path: string, options: CallOptions = {}): Promise<Reply> {
  return new Promise((settle, fail) => {
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body));
    const req = request({
      host: '127.0.0.1', port: service.port, path, method,
      headers: {
        ...(options.host ? { host: options.host } : {}),
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...options.headers,
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk as Buffer));
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        const text = bytes.toString('utf8');
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { /* not every route answers JSON */ }
        settle({
          status: response.statusCode ?? 0, headers: response.headers, json, text, bytes,
          cookies: response.headers['set-cookie'] ?? [],
        });
      });
    });
    req.on('error', fail);
    if (payload) req.write(payload);
    req.end();
  });
}

/** The session cookie a reply hands out, as a browser would send it back. */
function sessionCookie(reply: Reply): string {
  const line = reply.cookies.find(cookie => cookie.startsWith('slopesmith_session='));
  return line ? line.split(';')[0] : '';
}

/** The status a WebSocket upgrade is answered with: 101 once accepted, otherwise the refusal's own. The
 *  accepted socket is dropped at once — what is under test is the door, not the room behind it. */
function upgradeStatus(service: ApiService, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((settle, fail) => {
    const req = request({
      host: '127.0.0.1', port: service.port, path, method: 'GET',
      headers: {
        connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'), 'sec-websocket-version': '13',
        ...headers,
      },
    });
    req.on('error', fail);
    req.on('response', response => { response.resume(); settle(response.statusCode ?? 0); });
    req.on('upgrade', (_response, socket) => { socket.destroy(); settle(101); });
    req.end();
  });
}

/** Collect what the server wrote to one console channel, so what it says — a logged failure, a printed
 *  enrolment code — is asserted rather than assumed. */
function capture(channel: 'log' | 'warn'): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const original = console[channel];
  console[channel] = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { lines, stop: () => { console[channel] = original; } };
}

/** The one-time code out of the banner a starting server prints: the only line whose whole content after the
 *  frame is a single unbroken token. */
const codeFromBanner = (lines: string[]): string => /│\s+(\S{16,})\s*$/m.exec(lines.join('\n'))?.[1] ?? '';

const mountain = (name: string) => ({ ...defaultMountain(), name });

let service: ApiService | null = null;
try {
  // ---- a server nobody configured for accounts: it serves its owner ----
  service = await startApiService({ port: 0, host: '127.0.0.1' });

  const owner = await call(service, 'GET', '/api/auth/session');
  check(owner.status === 200 && owner.json?.accounts === 'open' && owner.json?.user?.role === 'admin',
    'a server with no accounts answers that it is open, and names the caller its owner');
  check(!existsSync(join(root, 'accounts', 'accounts.json')),
    'it writes no account record — there is nobody to record');
  check(owner.cookies.length === 0, 'and hands out no session, because there is no sign-in to remember');

  const listed = await call(service, 'GET', '/api/projects');
  check(listed.status === 200 && Array.isArray(listed.json?.projects),
    'the owner reads the workspace without signing in to anything');
  const configured = await call(service, 'GET', '/api/config');
  check(configured.status === 200 && !!configured.json?.config?.workspaceRoot,
    'and reaches the admin-only routes too, because the owner holds the admin role');
  const created = await call(service, 'POST', '/api/projects', { body: { document: mountain('MOUNTAIN01') } });
  check(created.status === 201 && created.json?.project?.name === 'MOUNTAIN01'
    && created.json?.project?.ownerId === 'owner',
    'and creates a map marked as belonging to the account-free owner');
  const signIn = await call(service, 'POST', '/api/auth/login', { body: { username: 'a', password: 'b' } });
  check(signIn.status === 400 && signIn.json?.accounts === 'open',
    'signing in to a server with no accounts is refused as meaningless rather than offered');

  // Names never overwrite, and a deleted name is retired rather than handed to the next map (docs/038).
  const second = await call(service, 'POST', '/api/projects', { body: { document: mountain('MOUNTAIN01') } });
  check(second.status === 201 && second.json?.project?.name === 'MOUNTAIN01_2'
    && second.json?.document?.name === 'MOUNTAIN01_2',
    'a second map under a taken name lands beside it as MOUNTAIN01_2, in the document as well as the manifest');
  await deleteProject(created.json.project.id);
  check(!(await listProjects()).some(project => project.id === created.json.project.id),
    'deleting a map removes it from the workspace');
  const third = await call(service, 'POST', '/api/projects', { body: { document: mountain('MOUNTAIN01') } });
  check(third.status === 201 && third.json?.project?.name === 'MOUNTAIN01_3',
    'and retires its name, so the next MOUNTAIN01 lands as _3 rather than reusing the deleted one');
  check(existsSync(join(root, 'projects.retired.json')),
    'the retired stems are recorded beside the library they belong to');

  // A page on another site can reach this port too, and on a server with no accounts it would be served as
  // the owner. The origin a browser stamps on the request is the one thing that page cannot hide.
  const own = `http://127.0.0.1:${service.port}`;
  const sameSite = await call(service, 'POST', '/api/projects',
    { body: { document: mountain('SAMESITE') }, headers: { origin: own } });
  const crossSite = await call(service, 'POST', '/api/projects',
    { body: { document: mountain('CROSSSITE') }, headers: { origin: 'https://evil.example' } });
  const opaque = await call(service, 'POST', '/api/projects',
    { body: { document: mountain('OPAQUE') }, headers: { origin: 'null' } });
  const crossSiteRead = await call(service, 'GET', '/api/projects', { headers: { origin: 'https://evil.example' } });
  check(sameSite.status === 201 && crossSite.status === 403 && crossSite.json?.crossSite === true
    && opaque.status === 403,
    'a write from the server\'s own page is taken, and one from a page on another site — or an opaque origin — is refused');
  check(crossSiteRead.status === 200 && third.status === 201,
    'while a read from anywhere and a write with no Origin at all (a script, the Blender add-on) are unaffected');
  check(!(await listProjects()).some(project => project.name === 'CROSSSITE'),
    'and the refused write reached nothing');
  check(await upgradeStatus(service, '/api/session', { origin: 'https://evil.example' }) === 403
    && await upgradeStatus(service, '/api/session', { origin: own }) === 101,
    'the session socket is held to the same rule: a page on another site cannot open one, the server\'s own can');

  // Matching Origin to Host is insufficient after DNS rebinding: the DNS name itself must be one this API
  // was configured to serve. Exercise an admin read, an editor write, and the browser's upgrade path.
  const reboundAuthority = `attacker.example:${service.port}`;
  const reboundHeaders = { host: reboundAuthority, origin: `http://${reboundAuthority}` };
  const reboundRead = await call(service, 'GET', '/api/config', { headers: reboundHeaders });
  const reboundWrite = await call(service, 'POST', '/api/projects', {
    body: { document: mountain('REBOUND') }, headers: reboundHeaders,
  });
  check(reboundRead.status === 403 && reboundRead.json?.authority === false
    && reboundWrite.status === 403 && reboundWrite.json?.authority === false
    && !(await listProjects()).some(project => project.name === 'REBOUND'),
  'an unconfigured DNS authority is refused before account-free owner access on reads and writes');
  check(await upgradeStatus(service, '/api/session', reboundHeaders) === 403,
    'an unconfigured DNS authority is refused on WebSocket upgrades too');
  check((await call(service, 'GET', '/api/config', {
    host: 'localhost:5179', headers: { origin: 'http://localhost:5179' },
  })).status === 200,
  'the legitimate loopback editor proxy remains an accepted API authority on its own port');

  // The guard rail: nothing in the identity layer may stand between somebody and their own workspace.
  const owned = await identify({ headers: {}, socket: {} } as never);
  check(owned.kind === 'owner' && owned.user.role === 'admin',
    'identifying a request on an unconfigured server reads no file, so there is nothing that can fail');
  check(authorize(owned, 'admin').allowed && authorize(owned, 'moderator').allowed && authorize(owned, 'editor').allowed
    && authorize(owned, 'viewer').allowed,
    'and the owner it produces satisfies every role a route can ask for');
  check(OWNER.role === 'admin' && Object.isFrozen(OWNER), 'the owner principal is a frozen constant');

  // Closed by default: a mount nobody has declared is admin-only rather than open.
  check(accessFor('/api/not-declared-yet')('GET', '/') === 'admin'
    && accessFor('/api/not-declared-yet')('POST', '/') === 'admin',
    'a route with no entry in ROUTE_ACCESS needs the admin role, in both directions');
  check(accessFor('/api/textures')('GET', '/') === 'viewer'
    && accessFor('/api/textures')('POST', '/') === 'editor',
    'a shared library is read by any member and added to by an editor');
  check(accessFor('/api/version')('GET', '/') === 'viewer'
    && accessFor('/api/version')('POST', '/') === 'moderator',
    'every member may see the running version; the comparison that fetches the configured main branch is a moderator\'s to ask for');
  check(accessFor('/api/level-census')('GET', '/', new URLSearchParams('level=GARI')) === 'viewer'
    && accessFor('/api/level-census')('GET', '/', new URLSearchParams('refresh=1')) === 'moderator',
    'and so is re-measuring the whole library, while reading the cached census stays open to every member');
  check(accessFor('/api/livekit')('GET', '/rtc/v1/validate') === 'viewer',
    'the voice signalling proxy asks for a member, like the voice token route it serves');
  check(accessFor('/api/update')('GET', '/') === 'admin'
    && accessFor('/api/update')('POST', '/') === 'admin',
    'only an administrator may inspect or enqueue a service-wide release update');
  check(accessFor('/api/restart')('GET', '/') === 'admin'
    && accessFor('/api/restart')('POST', '/') === 'admin',
    'only an administrator may inspect or restart the shared service');
  check(accessFor('/api/projects')('POST', '/') === 'editor'
    && accessFor('/api/projects')('POST', '/transfer') === 'editor'
    && accessFor('/api/projects')('POST', '/transfer/manifest') === 'editor'
    && accessFor('/api/projects')('PUT', '/mountain/document') === 'editor'
    && accessFor('/api/projects')('DELETE', '/mountain') === 'editor',
    'all map mutations reach the editor gate before ownership and map policy are checked');
  check(accessFor('/api/members')('POST', '/invite') === 'moderator'
    && accessFor('/api/members')('POST', '/sam/role') === 'moderator'
    && accessFor('/api/members')('POST', '/sam/disabled') === 'moderator'
    && accessFor('/api/members')('POST', '/sam/handle') === 'moderator'
    && accessFor('/api/members')('POST', '/sam/password') === 'admin'
    && accessFor('/api/members')('GET', '/invites') === 'admin',
    'the member routes expose only invite and ordinary-account actions at the moderator gate');
  check(accessFor('/api/auth')('POST', '/login') === 'public'
    && accessFor('/api/auth')('POST', '/redeem') === 'public'
    && accessFor('/api/auth')('POST', '/bootstrap') === 'public',
    'the three routes that establish a session are the ones that answer without one');
  check(accessFor('/api/auth')('GET', '/session') === 'viewer'
    && accessFor('/api/auth')('POST', '/logout') === 'viewer'
    && accessFor('/api/auth')('POST', '/password') === 'viewer'
    && accessFor('/api/auth')('GET', '/whatever-is-added-here-next') === 'viewer',
    'and the rest of that mount asks for one, so a path added under it is closed like any other route');

  await service.close();
  service = null;

  let refusedOpenNetwork = false;
  try { await startApiService({ port: 0, host: '0.0.0.0' }); }
  catch (error) { refusedOpenNetwork = /unsafe-open-network/i.test(String(error)); }
  check(refusedOpenNetwork,
    'an account-free server refuses a network bind unless its owner explicitly accepts that exposure');

  // ---- a server that requires accounts ----
  forgetAccounts();
  forgetRateLimits();
  service = await startApiService({
    port: 0, host: '127.0.0.1', accounts: true, allowedAuthorities: ['slopes.example.com'],
  });
  const printed = service.adminCode ?? '';

  // First run: every request is refused until the one-time admin code has been redeemed.
  const blocked = await call(service, 'GET', '/api/projects');
  check(blocked.status === 503 && blocked.json?.bootstrap === true,
    'before enrolment every route is refused, and the refusal says why');
  check((await call(service, 'GET', '/api/levels')).status === 503
    && (await call(service, 'GET', '/api/config')).status === 503
    && (await call(service, 'POST', '/api/projects', { body: { document: mountain('NOPE') } })).status === 503,
    'reads and writes alike, so there is no window in which whoever finds the URL gets anything');
  const probe = await call(service, 'GET', '/api/auth/session');
  check(probe.status === 503 && probe.json?.bootstrap === true,
    'and the sign-in view learns the server is unenrolled from the refusal itself');

  // The code is minted fresh on every start rather than carried across one, because the record holds a digest
  // and a code that outlived the process could never be printed again (docs/038).
  check(printed.length >= 32, 'a server with enrolment outstanding hands back a one-time admin code as it starts');
  check(codeFromBanner(adminCodeBanner(printed, 'http://example').split('\n')) === printed,
    'and it is the code the banner shows, wherever the address a person opens turns out to be');
  const code = await issueAdminCode();
  check(typeof code === 'string' && code.length >= 32 && code !== printed,
    'and minting another — which is what the next start does — replaces it rather than reprinting it');
  const superseded = await call(service, 'POST', '/api/auth/bootstrap',
    { body: { code: printed, username: 'mallory', password: 'superseded code here' } });
  check(superseded.status === 400 && (await call(service, 'GET', '/api/projects')).status === 503,
    'so a code the last start printed enrols nobody: the cost of a restart invalidating one somebody was '
    + 'about to type, in exchange for never storing a live credential in plaintext');
  const wrongCode = await call(service, 'POST', '/api/auth/bootstrap',
    { body: { code: 'not-the-code', username: 'mallory', password: 'correct horse battery' } });
  check(wrongCode.status === 400 && (await call(service, 'GET', '/api/projects')).status === 503,
    'a wrong admin code enrols nobody and leaves the server refusing everything');

  const enrolled = await call(service, 'POST', '/api/auth/bootstrap',
    { body: { code, username: 'Ada', password: 'first admin password' } });
  check(enrolled.status === 201 && enrolled.json?.user?.role === 'admin'
    && enrolled.json?.user?.username === 'ada',
    'redeeming the code creates the first admin');
  const adminCookie = sessionCookie(enrolled);
  const cookieLine = enrolled.cookies[0] ?? '';
  check(/HttpOnly/i.test(cookieLine) && /SameSite=Lax/i.test(cookieLine) && /Path=\//.test(cookieLine),
    'the session cookie is httpOnly and same-site, so script cannot read it and a cross-site write cannot send it');
  const token = adminCookie.slice('slopesmith_session='.length);
  check(token.length >= 40 && !token.includes('.') && !token.toLowerCase().includes('ada')
    && !/^ey/.test(token),
    'and the token is opaque — 32 random bytes, not a signed claim carrying who or what the holder is');

  const again = await call(service, 'POST', '/api/auth/bootstrap',
    { body: { code, username: 'eve', password: 'second admin password' } });
  check(again.status === 400 && (await listUsers()).length === 1,
    'the admin code works exactly once');

  await updateAccounts(draft => {
    const session = draft.sessions[0];
    session.lastSeenAt = new Date(Date.now() - 10 * 60_000).toISOString();
    session.expiresAt = new Date(Date.now() + 60_000).toISOString();
  });
  const asAdmin = await call(service, 'GET', '/api/config', { cookie: adminCookie });
  check(asAdmin.status === 200, 'the admin reaches the admin-only routes');
  const adminUpdate = await call(service, 'GET', '/api/update', { cookie: adminCookie });
  check(adminUpdate.status === 200 && typeof adminUpdate.json?.repository === 'string'
    && adminUpdate.json.repository.length > 0,
  'an administrator can see which repository the server uses for updates');
  check(asAdmin.cookies.some(cookie => cookie.startsWith(`${adminCookie};`) && /Max-Age=/.test(cookie)),
    'an active session renews the browser cookie when its sliding server expiry is extended');
  check((await call(service, 'GET', '/api/config')).status === 401,
    'and a request with no session reaches nothing at all');
  const anonymousProbe = await call(service, 'GET', '/api/auth/session');
  check(anonymousProbe.status === 401 && anonymousProbe.json?.accounts === 'required'
    && !anonymousProbe.json?.user,
    'asking who you are without a session is refused too, saying only that this server requires one');
  const anonymousLogout = await call(service, 'POST', '/api/auth/logout');
  check(anonymousLogout.status === 401 && !anonymousLogout.cookies.length,
    'and so is signing out — the sign-in mount answers an unauthenticated caller only where a session is '
    + 'being established');

  // Invites: minted with a role, redeemed once, and worthless afterwards.
  const single = await mintInvite({ role: 'editor', handle: 'discord:grace', by: 'ada' });
  const joined = await call(service, 'POST', '/api/auth/redeem',
    { body: { token: single.token, username: 'Grace', password: 'grace password one' } });
  check(joined.status === 201 && joined.json?.user?.role === 'editor'
    && joined.json?.user?.username === 'grace' && joined.json?.user?.bio === '',
    'redeeming an invite creates the user, with the role the link carried');
  const editorCookie = sessionCookie(joined);

  const bioText = 'Terrain tinkerer.\nUsually working on half-pipes.';
  const bio = await call(service, 'POST', '/api/auth/bio', {
    cookie: editorCookie, body: { bio: `  ${bioText}  ` },
  });
  const longBio = await call(service, 'POST', '/api/auth/bio', {
    cookie: editorCookie, body: { bio: 'x'.repeat(501) },
  });
  check(bio.status === 200 && bio.json?.user?.bio === bioText
    && longBio.status === 400 && /at most 500/i.test(String(longBio.json?.error)),
  'a member owns a trimmed multiline bio, bounded to 500 characters');

  // Profile pictures are account-backed, but their bytes do not ride every roster/session response. A member
  // uploads their own small browser crop, and everybody else receives an authenticated, versioned byte URL.
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const picture = await call(service, 'POST', '/api/auth/profile-picture', {
    cookie: editorCookie, body: { profilePicture: `data:image/png;base64,${pngBase64}` },
  });
  const pictureUrl = String(picture.json?.user?.profilePictureUrl ?? '');
  const rosterWithPicture = await call(service, 'GET', '/api/members', { cookie: adminCookie });
  const picturedMember = rosterWithPicture.json?.members?.find((member: any) => member.username === 'grace');
  check(picture.status === 200 && /^\/api\/members\/grace\/profile-picture\?v=/.test(pictureUrl)
    && picturedMember?.profilePictureUrl === pictureUrl
    && picturedMember?.bio === bioText
    && picturedMember?.inviteHandle === 'discord:grace'
    && typeof picturedMember?.lastSeenAt === 'string'
    && !JSON.stringify(picturedMember).includes(pngBase64),
  'a member sets their own profile picture and the roster carries its versioned URL, not its bytes');
  const servedPicture = await call(service, 'GET', pictureUrl, { cookie: adminCookie });
  check(servedPicture.status === 200 && servedPicture.headers['content-type'] === 'image/png'
    && servedPicture.bytes.equals(Buffer.from(pngBase64, 'base64'))
    && /private/.test(String(servedPicture.headers['cache-control'])),
  'any signed-in member can load the exact profile-picture bytes through the authenticated image route');
  check((await call(service, 'GET', pictureUrl)).status === 401,
    'profile-picture bytes do not bypass the server account gate');
  const invalidPicture = await call(service, 'POST', '/api/auth/profile-picture', {
    cookie: editorCookie, body: { profilePicture: 'data:image/png;base64,bm90IGEgcG5n' },
  });
  check(invalidPicture.status === 400 && /invalid/i.test(String(invalidPicture.json?.error)),
    'the server rejects a claimed image whose bytes do not match its media type');

  // Equipment keeps private named libraries while public account shapes expose only the selected versioned
  // texture URLs. Each create is already the browser-composed square atlas; sources/crop transforms never land.
  const equipment = await call(service, 'POST', '/api/auth/equipment', {
    cookie: editorCookie,
    body: {
      snowboard: { create: { name: 'Powder board', texture: `data:image/png;base64,${pngBase64}` } },
      skis: { create: { name: 'Tree skis', texture: `data:image/png;base64,${pngBase64}` } },
      edgeColor: '#a1b2c3',
    },
  });
  const boardDesign = equipment.json?.equipment?.snowboard?.designs?.[0];
  const skiDesign = equipment.json?.equipment?.skis?.designs?.[0];
  const snowboardUrl = String(equipment.json?.user?.snowboardTextureUrl ?? '');
  const skiUrl = String(equipment.json?.user?.skiTextureUrl ?? '');
  const rosterWithEquipment = await call(service, 'GET', '/api/members', { cookie: adminCookie });
  const equippedMember = rosterWithEquipment.json?.members?.find((member: any) => member.username === 'grace');
  check(equipment.status === 200
    && /^\/api\/members\/grace\/equipment-texture\/snowboard\/[^?]+\?v=/.test(snowboardUrl)
    && /^\/api\/members\/grace\/equipment-texture\/skis\/[^?]+\?v=/.test(skiUrl)
    && equippedMember?.snowboardTextureUrl === snowboardUrl && equippedMember?.skiTextureUrl === skiUrl
    && equippedMember?.equipmentEdgeColor === '#a1b2c3'
    && boardDesign?.name === 'Powder board' && skiDesign?.name === 'Tree skis'
    && equipment.json?.equipment?.snowboard?.selectedId === boardDesign?.id
    && !JSON.stringify(equippedMember).includes(pngBase64),
  'a member creates named board/ski designs while the roster carries only selected URLs, never library bytes');
  const servedSnowboard = await call(service, 'GET', snowboardUrl, { cookie: adminCookie });
  const servedSkis = await call(service, 'GET', skiUrl, { cookie: editorCookie });
  const servedBoardDesign = await call(service, 'GET', String(boardDesign?.textureUrl), { cookie: editorCookie });
  check(servedSnowboard.status === 200 && servedSkis.status === 200
    && servedSnowboard.bytes.equals(Buffer.from(pngBase64, 'base64'))
    && servedSkis.headers['content-type'] === 'image/png'
    && servedBoardDesign.status === 200
    && /private/.test(String(servedBoardDesign.headers['cache-control']))
    && /immutable/.test(String(servedBoardDesign.headers['cache-control'])),
  'signed-in members load selected art through authenticated routes whose immutable cache remains private');
  check((await call(service, 'GET', snowboardUrl)).status === 401,
    'equipment texture bytes do not bypass the server account gate');
  const privateLibrary = await call(service, 'GET', '/api/auth/equipment', { cookie: editorCookie });
  check(privateLibrary.status === 200 && privateLibrary.json?.equipment?.snowboard?.designs?.[0]?.name === 'Powder board'
    && !JSON.stringify(privateLibrary.json).includes(pngBase64),
  'the owner can list their named equipment history without embedding its image bytes in JSON');
  const recolored = await call(service, 'POST', '/api/auth/equipment', {
    cookie: editorCookie, body: { edgeColor: '#102030' },
  });
  check(recolored.status === 200 && recolored.json?.user?.equipmentEdgeColor === '#102030'
    && recolored.json?.user?.snowboardTextureUrl === snowboardUrl
    && recolored.json?.user?.skiTextureUrl === skiUrl,
  'changing only the solid edge colour preserves both selected designs');

  const alternateCanvas = createCanvas(2, 2);
  const alternateContext = alternateCanvas.getContext('2d');
  alternateContext.fillStyle = '#ef3355'; alternateContext.fillRect(0, 0, 2, 2);
  const alternate = alternateCanvas.toBuffer('image/png').toString('base64');
  const secondBoard = await call(service, 'POST', '/api/auth/equipment', {
    cookie: editorCookie, body: {
      snowboard: { create: { name: 'Park board', texture: `data:image/png;base64,${alternate}` } },
    },
  });
  const secondDesign = secondBoard.json?.equipment?.snowboard?.designs?.find((design: any) => design.name === 'Park board');
  const secondUrl = String(secondBoard.json?.user?.snowboardTextureUrl ?? '');
  check(secondBoard.status === 200 && secondBoard.json?.equipment?.snowboard?.designs?.length === 2
    && secondBoard.json?.equipment?.snowboard?.selectedId === secondDesign?.id && secondUrl !== snowboardUrl,
  'creating a second named board keeps the first and equips the new immutable result');
  const reselected = await call(service, 'POST', '/api/auth/equipment', {
    cookie: editorCookie, body: { snowboard: { selectedId: boardDesign?.id } },
  });
  check(reselected.status === 200 && reselected.json?.user?.snowboardTextureUrl === snowboardUrl
    && reselected.json?.equipment?.snowboard?.designs?.length === 2,
  'selecting an earlier design equips it without rewriting or dropping later work');
  const editedBoard = await call(service, 'POST', '/api/auth/equipment', {
    cookie: editorCookie, body: {
      snowboard: {
        update: { id: boardDesign?.id, name: 'Powder board revised', texture: `data:image/png;base64,${alternate}` },
        selectedId: boardDesign?.id,
      },
    },
  });
  const editedDesign = editedBoard.json?.equipment?.snowboard?.designs
    ?.find((design: any) => design.id === boardDesign?.id);
  const editedBoardUrl = String(editedBoard.json?.user?.snowboardTextureUrl ?? '');
  const servedEditedBoard = await call(service, 'GET', String(editedDesign?.textureUrl), { cookie: editorCookie });
  check(editedBoard.status === 200 && editedDesign?.name === 'Powder board revised'
    && editedDesign?.createdAt === boardDesign?.createdAt
    && editedBoard.json?.equipment?.snowboard?.designs?.length === 2
    && editedBoard.json?.equipment?.snowboard?.selectedId === boardDesign?.id
    && editedBoardUrl !== snowboardUrl && editedBoardUrl === editedDesign?.textureUrl
    && servedEditedBoard.status === 200
    && servedEditedBoard.bytes.equals(Buffer.from(alternate, 'base64')),
  'editing a saved board preserves its identity, age, selection and neighbours while versioning the replacement texture');
  const duplicateEdit = await call(service, 'POST', '/api/auth/equipment', {
    cookie: editorCookie, body: {
      snowboard: { update: { id: boardDesign?.id, name: 'Park board', texture: `data:image/png;base64,${alternate}` } },
    },
  });
  check(duplicateEdit.status === 400 && /already has that name/i.test(String(duplicateEdit.json?.error)),
    'editing a saved design cannot take another design name');
  const deletedPrevious = await call(service, 'POST', '/api/auth/equipment', {
    cookie: editorCookie, body: { snowboard: { deleteIds: [secondDesign?.id] } },
  });
  check(deletedPrevious.status === 200 && deletedPrevious.json?.equipment?.snowboard?.designs?.length === 1
    && deletedPrevious.json?.user?.snowboardTextureUrl === editedBoardUrl
    && (await call(service, 'GET', String(secondDesign?.textureUrl), { cookie: editorCookie })).status === 404,
  'deleting an old design removes only that fixed preview and leaves the selected design equipped');
  const stockBoard = await call(service, 'POST', '/api/auth/equipment', {
    cookie: editorCookie, body: { snowboard: { selectedId: null } },
  });
  check(stockBoard.status === 200 && !stockBoard.json?.user?.snowboardTextureUrl
    && stockBoard.json?.user?.skiTextureUrl === skiUrl && stockBoard.json?.equipment?.snowboard?.designs?.length === 1,
  'stock equipment can be selected without deleting saved designs or disturbing the other gear library');
  const invalidEquipment = await call(service, 'POST', '/api/auth/equipment', {
    cookie: editorCookie, body: { edgeColor: 'blue' },
  });
  check(invalidEquipment.status === 400 && /six-digit/i.test(String(invalidEquipment.json?.error)),
    'the service refuses an edge colour that cannot be rendered as a stable CSS hex value');
  const oblong = createCanvas(2, 1).toBuffer('image/png').toString('base64');
  const nonSquareEquipment = await call(service, 'POST', '/api/auth/equipment', {
    cookie: editorCookie, body: {
      skis: { create: { name: 'Broken atlas', texture: `data:image/png;base64,${oblong}` } },
    },
  });
  check(nonSquareEquipment.status === 400 && /must be square/i.test(String(nonSquareEquipment.json?.error)),
    'the service enforces the square texture contract even for a scripted caller that bypasses the browser');

  await updateAccounts(draft => {
    const grace = draft.users.find(user => user.username === 'grace')!;
    delete (grace as Partial<typeof grace>).availability;
    (grace as any).equipment = {
      edgeColor: '#445566',
      snowboardTexture: { mimeType: 'image/png', data: pngBase64, version: 'legacy-board' },
      skiTexture: { mimeType: 'image/png', data: pngBase64, version: 'legacy-skis' },
    };
  });
  forgetAccounts();
  const migratedEquipment = await call(service, 'GET', '/api/auth/equipment', { cookie: editorCookie });
  const migratedAccount = await call(service, 'GET', '/api/auth/session', { cookie: editorCookie });
  check(migratedEquipment.status === 200
    && migratedEquipment.json?.equipment?.snowboard?.designs?.[0]?.name === 'My snowboard'
    && migratedEquipment.json?.equipment?.skis?.designs?.[0]?.name === 'My skis'
    && migratedEquipment.json?.equipment?.edgeColor === '#445566',
  'a schema-1 single board/ski image migrates into selected named designs without losing either texture');
  check(migratedAccount.json?.user?.availability === 'available',
    'an account written before availability existed migrates to Available');

  const removedPicture = await call(service, 'POST', '/api/auth/profile-picture', {
    cookie: editorCookie, body: { profilePicture: null },
  });
  check(removedPicture.status === 200 && !removedPicture.json?.user?.profilePictureUrl
    && (await call(service, 'GET', pictureUrl, { cookie: adminCookie })).status === 404,
  'a member can remove their profile picture and its old byte route stops serving it');

  const reused = await call(service, 'POST', '/api/auth/redeem',
    { body: { token: single.token, username: 'mallory', password: 'mallory password one' } });
  check(reused.status === 400 && /already been used/i.test(String(reused.json?.error)),
    'and the link is worthless afterwards — single use is what bounds a leaked one');

  const stale = await mintInvite({ role: 'viewer', handle: 'email:late@example.com', by: 'ada' });
  await updateAccounts(draft => {
    const invite = draft.invites.find(entry => entry.id === stale.invite.id)!;
    invite.expiresAt = new Date(Date.now() - 60_000).toISOString();
  });
  const expired = await call(service, 'POST', '/api/auth/redeem',
    { body: { token: stale.token, username: 'late', password: 'too late for this' } });
  check(expired.status === 400 && /expired/i.test(String(expired.json?.error)),
    'an invite past its expiry creates nobody — unredeemed links lying around are the actual risk');

  const beaInvite = await mintInvite({ role: 'viewer', handle: 'discord:bea', by: 'ada' });
  const beaJoined = await call(service, 'POST', '/api/auth/redeem',
    { body: { token: beaInvite.token, username: 'bea', password: 'bea password here' } });
  check(beaJoined.status === 201 && beaJoined.json?.user?.role === 'viewer',
    'each invitation creates exactly one account carrying its own private provenance');

  // Moderators can run the day-to-day account actions without gaining a path to privileged accounts.
  const moderatorInvite = await mintInvite({ role: 'moderator', handle: 'discord:morgan', by: 'ada' });
  const moderatorJoined = await call(service, 'POST', '/api/auth/redeem', {
    body: { token: moderatorInvite.token, username: 'morgan', password: 'morgan password one' },
  });
  const moderatorCookie = sessionCookie(moderatorJoined);
  const peerModeratorInvite = await mintInvite({ role: 'moderator', handle: 'discord:riley', by: 'ada' });
  await call(service, 'POST', '/api/auth/redeem', {
    body: { token: peerModeratorInvite.token, username: 'riley', password: 'riley password one' },
  });
  const moderatorRoster = await call(service, 'GET', '/api/members', { cookie: moderatorCookie });
  check(moderatorJoined.status === 201 && moderatorJoined.json?.user?.role === 'moderator'
    && moderatorRoster.json?.moderator === true && moderatorRoster.json?.admin === false
    && moderatorRoster.json?.maps === undefined,
    'a moderator sees ordinary-account controls without receiving admin-only map administration');
  const editorRoster = await call(service, 'GET', '/api/members', { cookie: editorCookie });
  check(moderatorRoster.json?.members?.every((member: any) => typeof member.inviteHandle === 'string')
    && editorRoster.json?.members?.every((member: any) => member.inviteHandle === undefined),
    'invite handles are present for moderators and absent — not merely hidden in the UI — for ordinary members');
  const changedHandle = await call(service, 'POST', '/api/members/grace/handle', {
    cookie: moderatorCookie, body: { handle: 'email:grace@example.com' },
  });
  check(changedHandle.status === 200
    && (await readAccounts()).users.find(user => user.username === 'grace')?.inviteHandle === 'email:grace@example.com',
    'a moderator can correct the private invite handle attached to an account');

  const ordinaryInvite = await call(service, 'POST', '/api/members/invite', {
    cookie: moderatorCookie, body: { role: 'viewer', handle: 'discord:new-viewer', days: 2 },
  });
  const privilegedInvites = await Promise.all(['moderator', 'admin'].map(role =>
    call(service!, 'POST', '/api/members/invite', {
      cookie: moderatorCookie, body: { role, handle: `discord:${role}` },
    })));
  check(ordinaryInvite.status === 201 && ordinaryInvite.json?.invite?.role === 'viewer'
    && privilegedInvites.every(reply => reply.status === 403),
    'a moderator mints viewer/editor invites but cannot mint another moderator or admin');

  const madeEditor = await call(service, 'POST', '/api/members/bea/role',
    { cookie: moderatorCookie, body: { role: 'editor' } });
  const madeViewer = await call(service, 'POST', '/api/members/bea/role',
    { cookie: moderatorCookie, body: { role: 'viewer' } });
  const moderatorMap = await call(service, 'POST', '/api/projects',
    { cookie: moderatorCookie, body: { document: mountain('MODERATORMADE') } });
  const moderatorDoomed = await call(service, 'POST', '/api/projects',
    { cookie: moderatorCookie, body: { document: mountain('MODERATORDELETES') } });
  const moderatorDelete = await call(service, 'DELETE',
    `/api/projects/${moderatorDoomed.json.project.id}`, { cookie: moderatorCookie });
  check(madeEditor.status === 200 && madeEditor.json?.user?.role === 'editor'
    && madeViewer.status === 200 && madeViewer.json?.user?.role === 'viewer'
    && moderatorMap.status === 201 && moderatorMap.json?.project?.ownerId === moderatorJoined.json?.user?.id
    && moderatorDelete.status === 200,
    'a moderator sets ordinary roles and creates, owns, and deletes maps');

  const disabledByModerator = await call(service, 'POST', '/api/members/bea/disabled',
    { cookie: moderatorCookie, body: { disabled: true } });
  const enabledByModerator = await call(service, 'POST', '/api/members/bea/disabled',
    { cookie: moderatorCookie, body: { disabled: false } });
  check(disabledByModerator.status === 200 && disabledByModerator.json?.user?.disabled
    && enabledByModerator.status === 200 && !enabledByModerator.json?.user?.disabled,
    'a moderator can disable and re-enable a viewer or editor account');

  const protectedTargets = await Promise.all([
    call(service, 'POST', '/api/members/riley/disabled', { cookie: moderatorCookie, body: { disabled: true } }),
    call(service, 'POST', '/api/members/ada/disabled', { cookie: moderatorCookie, body: { disabled: true } }),
    call(service, 'POST', '/api/members/riley/role', { cookie: moderatorCookie, body: { role: 'viewer' } }),
    call(service, 'POST', '/api/members/ada/role', { cookie: moderatorCookie, body: { role: 'viewer' } }),
    call(service, 'POST', '/api/members/bea/role', { cookie: moderatorCookie, body: { role: 'moderator' } }),
    call(service, 'POST', '/api/members/bea/role', { cookie: moderatorCookie, body: { role: 'admin' } }),
  ]);
  const adminOnlyActions = await Promise.all([
    call(service, 'POST', '/api/members/bea/password', { cookie: moderatorCookie, body: {} }),
    call(service, 'POST', '/api/members/bea/sign-out', { cookie: moderatorCookie }),
  ]);
  const lowerRoleRefusal = await call(service, 'POST', '/api/members/bea/disabled',
    { cookie: editorCookie, body: { disabled: true } });
  const protectedUsers = await listUsers();
  check(protectedTargets.every(reply => reply.status === 403)
    && adminOnlyActions.every(reply => reply.status === 403) && lowerRoleRefusal.status === 403
    && protectedUsers.find(user => user.username === 'riley')?.role === 'moderator'
    && !protectedUsers.find(user => user.username === 'riley')?.disabled
    && protectedUsers.find(user => user.username === 'ada')?.role === 'admin'
    && !protectedUsers.find(user => user.username === 'ada')?.disabled,
    'moderators cannot affect moderators or admins, grant privileged roles, reset passwords, or sign users out');

  // A wrong password is counted and logged, and the count refuses before the guessing gets anywhere.
  forgetRateLimits();
  const log = capture('warn');
  const wrong = [];
  for (let attempt = 0; attempt < 9; attempt++) {
    wrong.push(await call(service, 'POST', '/api/auth/login',
      { body: { username: 'grace', password: `guess number ${attempt}` } }));
  }
  log.stop();
  check(wrong.slice(0, 8).every(reply => reply.status === 401) && wrong[8].status === 429
    && typeof wrong[8].json?.retryAfter === 'number',
    'a wrong password is refused, and the ninth attempt is refused for being the ninth');
  check(log.lines.filter(line => line.includes('failed sign-in for grace')).length >= 8
    && !log.lines.some(line => line.includes('guess number')),
    'every failure is logged, naming who and from where and never what was tried');
  check((await call(service, 'POST', '/api/auth/login',
    { body: { username: 'grace', password: 'grace password one' } })).status === 429,
    'and the right password waits behind the limit too, so the count cannot be washed out');
  forgetRateLimits();
  const backIn = await call(service, 'POST', '/api/auth/login',
    { body: { username: 'grace', password: 'grace password one' } });
  check(backIn.status === 200 && backIn.json?.user?.username === 'grace',
    'once the window passes the right password signs in as before');

  // Editors create maps of their own. Ownership and a map-local allow-list narrow management/editing without
  // weakening the server-wide viewer/editor role floor.
  const editorCreate = await call(service, 'POST', '/api/projects',
    { cookie: editorCookie, body: { document: mountain('EDITORMADE') } });
  const editorRename = await call(service, 'PUT', `/api/projects/${editorCreate.json.project.id}/document`, {
    cookie: editorCookie,
    body: {
      baseRevision: editorCreate.json.project.revision,
      document: { ...editorCreate.json.document, name: 'EDITORRENAMED' },
    },
  });
  const editorDelete = await call(service, 'DELETE', `/api/projects/${editorCreate.json.project.id}`,
    { cookie: editorCookie });
  check(editorCreate.status === 201 && editorCreate.json?.project?.ownerId === joined.json?.user?.id
    && editorRename.status === 200 && editorRename.json?.project?.name === 'EDITORRENAMED'
    && editorDelete.status === 200,
    'an editor creates a map marked as theirs, then renames and deletes their own map');

  const existingWrite = await call(service, 'POST',
    `/api/projects/${moderatorMap.json.project.id}/checkpoints`,
    { cookie: editorCookie, body: { note: 'editor checkpoint' } });
  const grace = (await listUsers()).find(user => user.username === 'grace')!;
  const restricted = await call(service, 'PUT', `/api/projects/${moderatorMap.json.project.id}/permissions`,
    { cookie: moderatorCookie, body: { editorIds: [] } });
  const restrictedWrite = await call(service, 'POST',
    `/api/projects/${moderatorMap.json.project.id}/checkpoints`,
    { cookie: editorCookie, body: { note: 'not admitted' } });
  const nonOwnerPolicy = await call(service, 'PUT',
    `/api/projects/${moderatorMap.json.project.id}/permissions`,
    { cookie: editorCookie, body: { editorIds: [grace.id] } });
  const nonOwnerDelete = await call(service, 'DELETE', `/api/projects/${moderatorMap.json.project.id}`,
    { cookie: editorCookie });
  const admitted = await call(service, 'PUT', `/api/projects/${moderatorMap.json.project.id}/permissions`,
    { cookie: moderatorCookie, body: { editorIds: [grace.id] } });
  const admittedWrite = await call(service, 'POST',
    `/api/projects/${moderatorMap.json.project.id}/checkpoints`,
    { cookie: editorCookie, body: { note: 'admitted editor' } });
  const currentModeratorMap = await call(service, 'GET', `/api/projects/${moderatorMap.json.project.id}`,
    { cookie: editorCookie });
  const nonOwnerRename = await call(service, 'PUT',
    `/api/projects/${moderatorMap.json.project.id}/document`, {
      cookie: editorCookie,
      body: {
        baseRevision: currentModeratorMap.json.project.revision,
        document: { ...currentModeratorMap.json.document, name: 'GRACE_TRIED_TO_RENAME' },
      },
    });
  check(existingWrite.status === 201 && restricted.status === 200
    && Array.isArray(restricted.json?.project?.editorIds) && restricted.json.project.editorIds.length === 0
    && restrictedWrite.status === 403 && /restricted/i.test(String(restrictedWrite.json?.error))
    && nonOwnerPolicy.status === 403 && nonOwnerDelete.status === 403
    && admitted.status === 200 && admittedWrite.status === 201 && nonOwnerRename.status === 403,
    'a map owner restricts editing to selected people, while non-owners cannot change policy, rename, or delete');
  // A role change is in force on the next request, not whenever a token expires.
  await setUserRole('grace', 'viewer');
  const demoted = await call(service, 'POST',
    `/api/projects/${moderatorMap.json.project.id}/checkpoints`,
    { cookie: editorCookie, body: { note: 'viewer checkpoint' } });
  check(demoted.status === 403 && demoted.json?.needs === 'editor' && demoted.json?.role === 'viewer',
    'and the same cookie is refused the moment that account becomes a viewer — no waiting for a token to lapse');
  check((await call(service, 'GET', '/api/projects', { cookie: editorCookie })).status === 200,
    'a viewer still reads every map on the server, because the role is the only gate');
  check((await call(service, 'GET', '/api/config', { cookie: editorCookie })).status === 403,
    'and is refused the routes that manage the server itself');
  const viewerFetch = await call(service, 'POST', '/api/version', { cookie: editorCookie });
  const viewerRemeasure = await call(service, 'GET', '/api/level-census?refresh=1', { cookie: editorCookie });
  check(viewerFetch.status === 403 && viewerFetch.json?.needs === 'moderator'
    && viewerRemeasure.status === 403 && viewerRemeasure.json?.needs === 'moderator',
    'and the two requests that make the server do expensive work on demand — a git fetch, a library re-measure');

  // Revoking a session is immediate for the same reason: the server holds it, so it can simply delete it.
  await revokeUserSessions(grace.id);
  check((await call(service, 'GET', '/api/projects', { cookie: editorCookie })).status === 401,
    'revoking a session takes effect on the very next request — this is what opaque sessions are bought for');

  // HTTPS is required, not recommended — and loopback still counts, as it does in a browser.
  const overPlainHttp = await call(service, 'POST', '/api/auth/login',
    { host: 'slopes.example.com', body: { username: 'ada', password: 'first admin password' } });
  check(overPlainHttp.status === 403 && overPlainHttp.json?.insecure === true,
    'a login over a non-secure, non-loopback origin is refused rather than left available as a shortcut');
  const spoofed = await call(service, 'POST', '/api/auth/login', {
    host: 'slopes.example.com', headers: { 'x-forwarded-proto': 'https' },
    body: { username: 'ada', password: 'first admin password' },
  });
  check(spoofed.status === 403 && spoofed.json?.insecure === true,
    'and a forwarded-proto header is not evidence of TLS unless the operator vouched for a proxy in front');
  check((await call(service, 'POST', '/api/auth/redeem',
    { host: 'slopes.example.com', body: { token: 'anything', username: 'x', password: 'yyyyyyyyyy' } }))
    .status === 403,
    'redemption is held to the same rule, because it carries a password too');
  configureAccounts({ behindProxy: true });
  const proxied = await call(service, 'POST', '/api/auth/login', {
    host: 'slopes.example.com', headers: { 'x-forwarded-proto': 'https' },
    body: { username: 'ada', password: 'first admin password' },
  });
  check(proxied.status === 200, 'with --behind-proxy, TLS terminated by that proxy is accepted');
  configureAccounts({ behindProxy: false });

  const loopback = await call(service, 'POST', '/api/auth/login',
    { host: `127.0.0.1:${service.port}`, body: { username: 'ada', password: 'first admin password' } });
  check(loopback.status === 200,
    'loopback is a secure origin, so a server run on this machine still signs in over plain http');
  // The two halves of that exemption, and the address a rate limit counts, over requests shaped by hand.
  const secure = (host: string, remoteAddress: string) =>
    isSecureOrigin({ headers: { host }, socket: { remoteAddress } } as never);
  check(secure('localhost:5180', '127.0.0.1') && secure('[::1]:5180', '::1') && secure('127.0.0.1', '::ffff:127.0.0.1'),
    'a loopback Host on a loopback socket is secure, however the peer address is spelled');
  check(!secure('localhost:5180', '203.0.113.9') && !secure('slopes.example.com', '127.0.0.1'),
    'but a Host claiming localhost from the network is not — the exemption needs both halves to agree');
  const counted = (chain: string) => clientAddress({
    headers: { 'x-forwarded-for': chain }, socket: { remoteAddress: '127.0.0.1' },
  } as never);
  configureAccounts({ behindProxy: true });
  check(counted('203.0.113.9') === '203.0.113.9' && counted('10.0.0.1, 203.0.113.9') === '203.0.113.9',
    'behind a proxy the rate limiter counts the LAST forwarded entry — the one the proxy appended — so a first '
    + 'entry the client wrote itself buys it nothing');
  configureAccounts({ behindProxy: false });
  check(counted('203.0.113.9') === '127.0.0.1', 'and without a vouched-for proxy the header is not read at all');

  const renamed = await call(service, 'POST', '/api/auth/username', {
    cookie: adminCookie, body: { username: 'ada-new' },
  });
  const oldUsername = await call(service, 'POST', '/api/auth/login',
    { body: { username: 'ada', password: 'first admin password' } });
  const newUsername = await call(service, 'POST', '/api/auth/login',
    { body: { username: 'ada-new', password: 'first admin password' } });
  check(renamed.status === 200 && renamed.json?.user?.username === 'ada-new'
    && oldUsername.status === 401 && newUsername.status === 200,
    'a member can change their own public username while their stable account id and sessions remain intact');

  // Signing out is the same mechanism from the other side.
  const signedOut = await call(service, 'POST', '/api/auth/logout', { cookie: adminCookie });
  check(signedOut.status === 200 && /Max-Age=0/.test(signedOut.cookies[0] ?? '')
    && (await call(service, 'GET', '/api/config', { cookie: adminCookie })).status === 401,
    'signing out ends the session on the server, not merely in the browser');

  // A request the identity layer cannot answer refuses on a configured server, rather than assuming an admin.
  const unreadable = { get headers(): never { throw new Error('no headers'); } } as never;
  const brokenAccounts = await authorizeRequest(unreadable, 'viewer');
  check(!brokenAccounts.allowed && brokenAccounts.status === 500,
    'and a fault while identifying a request on a server with accounts is a refusal, never an assumed admin');
  configureAccounts({ required: false });
  const brokenOwner = await authorizeRequest(unreadable, 'admin');
  check(brokenOwner.allowed && brokenOwner.identity.kind === 'owner',
    'while a request that cannot be read at all is still served as the owner on a server with no accounts — '
    + 'that path consults nothing, so nothing about it can bar somebody from their own workspace');
  configureAccounts({ required: true });
} finally {
  await service?.close();
  configureAccounts({ required: false, behindProxy: false, allowedAuthorities: [] });
  forgetAccounts();
  forgetRateLimits();
  delete process.env.SLOPESMITH_WORKSPACE_ROOT;
  delete process.env.SLOPESMITH_MAPS_ROOT;
  forgetWorkspaceConfig();
  rmSync(root, { recursive: true, force: true });
}

if (failures) process.exitCode = 1;
else console.log('ACCOUNTS PASS');
