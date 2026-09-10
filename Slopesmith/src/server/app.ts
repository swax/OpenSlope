import type { IncomingMessage, ServerResponse } from 'node:http';
import { CUSTOM_TEX_LEVEL } from '../core/paint/textures';
import { authorizeRequest, crossSiteRefusal, type Need } from './accounts/guard';
import { isSecureOrigin, type Role } from './accounts/policy';
import { sessionToken, setSessionCookie } from './accounts/sessions';
import { authRoutes, memberRoutes } from './api/auth';
import { blenderRoutes } from './api/blender';
import { characterRoutes } from './api/characters';
import { discoveryRoutes } from './api/discovery';
import { explorerRoutes } from './api/explorer';
import { jsonResponse, type ApiControls, type ApiHandler } from './api/common';
import { schemaRoutes } from './api/schemas';
import { exportRoutes } from './api/export';
import { levelRoutes } from './api/levels';
import { musicRoutes } from './api/music';
import { propRoutes } from './api/props';
import { retopologyRoutes } from './api/retopology';
import { restartRoutes } from './api/restart';
import { skyboxRoutes } from './api/skybox';
import { textureRoutes } from './api/textures';
import { updateRoutes } from './api/update';
import { voiceRoutes } from './api/voice';
import { versionRoutes } from './api/version';
import { workspaceRoutes } from './api/workspace';
import type { ApiRequest } from './api/request';
import { createLogger } from './log';
import { NoOpenProjectError, withRequestProjectAssets } from './project-assets';
import { ProjectPermissionError } from './projects';

export type { ApiRequest } from './api/request';

const log = createLogger('api');
const accountsLog = createLogger('accounts');

const routes: Array<[mount: string, handle: ApiHandler]> = [
  authRoutes, memberRoutes, workspaceRoutes, characterRoutes, musicRoutes, exportRoutes, levelRoutes,
  textureRoutes, propRoutes, skyboxRoutes, retopologyRoutes, blenderRoutes, voiceRoutes, versionRoutes, updateRoutes,
  restartRoutes, schemaRoutes, explorerRoutes,
  // Deliberately last: its `/api` mount is the discovery root AND the catch-all that answers an unclaimed
  // `/api/*` path with a link back to the root (docs/052). A module added after it would never be reached.
  discoveryRoutes,
].flatMap(module => Object.entries(module));

/** Routes whose authored side resolves inside the mountain open in the calling tab. Reference-only branches
 * can harmlessly share the context; keeping the boundary at mounts makes it impossible for a new handler in
 * one of these modules to accidentally fall back to a process-global asset folder. Characters are omitted:
 * rider avatars intentionally belong to the server-wide workspace library. */
const PROJECT_ASSET_MOUNTS = new Set([
  '/api/preflight',
  '/api/blender',
  '/api/textures', '/api/texture', '/api/texture-usage',
  '/api/custom-props', '/api/custom-prop-import', '/api/custom-prop-rename', '/api/custom-prop-clone',
  '/api/custom-prop-replace', '/api/custom-prop-materials', '/api/custom-prop-delete',
  '/api/texture-upload', '/api/texture-rename', '/api/texture-clone', '/api/texture-replace', '/api/texture-delete',
  '/api/custom-music', '/api/custom-music-file',
  '/api/custom-sounds', '/api/custom-sound', '/api/sound-upload',
  '/api/skybox', '/api/skypano', '/api/skyground', '/api/skyupload',
]);

/**
 * The texture and sky mounts mix two kinds of address: immutable extracted-level art, which belongs to the
 * workspace, and authored art, which belongs to one mountain. A fresh tab can render an extracted
 * recovery/reference level before it has chosen a mountain; making those global reads resolve a project first
 * turns every image into a 409 and leaves the renderer remembering a bank of failed pages.
 *
 * An explicit project always wins, as does either spelling of a Custom dependency. Extracted sky panorama,
 * ground, ring and page reads can be answered without a project context; the combined sky catalogue remains
 * scoped because it also lists custom skies. The other authored mounts remain unconditional.
 */
function requestNeedsProjectAssets(mount: string, mounted: string): boolean {
  if (!PROJECT_ASSET_MOUNTS.has(mount)) return false;
  const url = new URL(mounted, 'http://localhost');
  const query = url.searchParams;
  if (query.has('project')) return true;
  if (mount === '/api/skypano' || mount === '/api/skyground') return !query.get('level');
  if (mount === '/api/skybox') return url.pathname !== '/ring' && url.pathname !== '/page';
  if (mount !== '/api/texture' && mount !== '/api/textures') return true;
  if ((query.get('level') ?? '').toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()) return true;
  if (mount === '/api/texture') {
    const source = (query.get('name') ?? '').replace(/\\/g, '/').split('/')[0];
    if (source.toLowerCase() === CUSTOM_TEX_LEVEL.toLowerCase()) return true;
  }
  return false;
}

/**
 * A route owns its mount path and everything below it, and sees the remainder in `req.url` — so
 * `/api/projects` reads `/current` off a sub-path while a leaf route reads `/?level=MESA`.
 *
 * The boundary test is what keeps neighbouring names apart without depending on registration order:
 * `/api/textures` is not a request for `/api/texture`, and `/api/custom-music-file` is not one for
 * `/api/custom-music`, because the character after a matched mount must end the segment.
 */
function mountedUrl(url: string, mount: string): string | null {
  const query = url.indexOf('?');
  const pathname = query < 0 ? url : url.slice(0, query);
  if (pathname.length < mount.length) return null;
  if (pathname.slice(0, mount.length).toLowerCase() !== mount.toLowerCase()) return null;
  const boundary = pathname[mount.length];
  if (boundary && boundary !== '/' && boundary !== '.') return null;
  const rest = url.slice(mount.length);
  return rest.startsWith('/') ? rest : `/${rest}`;
}

/** What one mount asks of a request, given its method, the path below the mount and — for the few routes whose
 *  cost rides in the query string — its parameters. */
type Access = (method: string, path: string, query?: URLSearchParams) => Need;

/** Methods that only read. Everything else is a write, whatever it is called. */
export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** One role, whatever the request is. */
const at = (role: Role): Access => () => role;

/** A role to read and a role to change — the shape almost every route has: everyone with an account sees the
 *  server's maps and libraries, and the editor role is the gate on changing them. */
const rw = (read: Role, write: Role): Access => method => SAFE_METHODS.has(method) ? read : write;

/** A shared library: any member may read it, an editor may add to it. */
const library = rw('viewer', 'editor');

/** The narrow account actions a moderator may reach. Role/access changes are still bounded by the target's
 * current role in the handler; private invite handles belong to moderators for every account. */
const memberAccess: Access = (method, path) => {
  const relative = path.replace(/^\/+|\/+$/g, '');
  if (SAFE_METHODS.has(method)) return relative.startsWith('invites') ? 'admin' : 'viewer';
  if (relative === 'invite' || /^[^/]+\/(?:role|disabled|handle)$/.test(relative)) return 'moderator';
  return 'admin';
};

/** Every project mutation reaches at least the editor gate. Ownership and per-map allow-lists are then checked
 *  against the actual project in the handler/session layer, where the project id and principal are both known. */
const projectAccess: Access = (method, path) => {
  const relative = path.replace(/^\/+|\/+$/g, '');
  // `ground` is a read that arrives as POST only because its input is a batch of points; it writes nothing.
  // Its neighbour `seat` asks the same sampler the same question and then MOVES what it found, so it is not
  // in this exception and falls through to the editor gate below with every other map write.
  if (SAFE_METHODS.has(method) || /^[^/]+\/(activate|ground)$/.test(relative)) return 'viewer';
  return 'editor';
};

/** The paths under `/api/auth` that cannot ask a caller for a session, because they are how one is
 *  established. Everything else there is a member acting on their own account. */
const SIGN_IN: ReadonlySet<string> = new Set(['/bootstrap', '/redeem', '/login']);

/**
 * What each mount needs, and — the part that matters — what an unlisted one gets.
 *
 * Roles are server-wide and this is where they are enforced, once, rather than at every route that touches a
 * map (docs/038). A mount with no entry here needs the admin role, so a route added tomorrow is closed until
 * someone decides what it should be, instead of being open because nobody remembered to close it. The
 * warning names the mount the first time such a route is reached, so the omission surfaces as a line in the
 * log rather than as a permission nobody intended.
 *
 * This runs for every request on every server. On one nobody configured for accounts the principal is the
 * owner, with the admin role, so each of these checks passes and the route behaves as it always has — one
 * table, one path, and no second shape of request to keep in step with this one.
 */
const ROUTE_ACCESS: Record<string, Access> = {
  // The HATEOAS front door (docs/052). Public on purpose: an agent arriving with nothing but this server's
  // address reads WHO it is and HOW to authenticate off the root, and an unknown-path miss under /api is a
  // 404 pointing home. The root itself carries links only — everything it names still asks its own role.
  '/api': () => 'public',
  // The interactive reference is a page with no data in it — a generic hypermedia client over this same
  // surface. Public like the login page it may need to show first; every request it MAKES is gated as the
  // route being called demands.
  '/api/explorer': () => 'public',
  // The directory pages and machine-readable contracts behind it: signed-in reading, like the libraries
  // they describe.
  '/api/reference': at('viewer'),
  '/api/avatars': at('viewer'),
  '/api/guide': at('viewer'),
  '/api/browser': at('viewer'),
  '/api/schemas': at('viewer'),

  // Signing in. The three paths that establish a session are the only ones that answer without one, and
  // enrolment is the only route of any kind that answers while a server is waiting for its first admin —
  // every other request is refused until the one-time code has been redeemed. The rest of the mount is a
  // member acting on their own account, so it asks for a session like everything else, and a path added
  // under `/api/auth` tomorrow is closed by default rather than open because the mount is.
  '/api/auth': (_method, path) => SIGN_IN.has(path.replace(/\/+$/, '') || '/') ? 'public' : 'viewer',

  // The roster the Users mode lists, and the administration inside it. Every member sees who is on the
  // server, because that is what a room is. Moderators may mint ordinary invites, set viewer/editor roles,
  // disable ordinary accounts, and correct private invite handles. All other administration is admin.
  '/api/members': memberAccess,

  // Machine-local paths — where the workspace and the map library live. Nothing a member needs, and
  // something only whoever runs the machine should be reading, let alone repointing.
  '/api/config': at('admin'),

  // The running commit contains no machine paths or secrets, so every signed-in user may read it. Comparing
  // it with the configured main branch runs `git fetch` for whoever asks, so that POST is a moderator's:
  // a cost the server pays on request is not something a viewer should be able to trigger at will.
  '/api/version': rw('viewer', 'moderator'),

  // Installing a release restarts the shared service. Only a signed-in administrator may enqueue it; access
  // keys are explicitly barred from every admin route by the central guard.
  '/api/update': at('admin'),

  // Restarting reconstructs every startup-owned cache and watcher and briefly disconnects all members. Like
  // a release update, it belongs only to an administrator and is unavailable to access keys.
  '/api/restart': at('admin'),

  // Maps. Every member reads; editors create. Existing-map writes are narrowed by that map's allow-list, and
  // rename/delete/permission changes require its owner or a moderator, inside the project handler/channel.
  '/api/projects': projectAccess,

  // Native whole-mountain processing. Every member may inspect capability/job progress; only editors may
  // submit or cancel work because a completed result is an authored topology replacement.
  '/api/retopology': rw('viewer', 'editor'),

  // The session channel: presence, awareness and register changes, over one socket per tab. Any member
  // may connect and follow; the editor role is checked where it belongs, on the claim itself, so a viewer
  // sees the room rather than being shut out of it.
  '/api/session': at('viewer'),

  // A short-lived LiveKit token for this server's shared voice room. Viewers participate too; the token
  // itself is restricted to microphone publication and audio subscription.
  '/api/voice': at('viewer'),
  // The signalling proxy in front of that room (voice-proxy.ts). LiveKit checks its own token on the far
  // side; this is the nearer question — a member of this server at all? — asked before anything is relayed.
  '/api/livekit': at('viewer'),

  // A preflight summarises a document the client already holds. Composing the folder happens in the browser,
  // so an export reaches the server only as the ordinary library reads its pieces come from.
  '/api/preflight': at('viewer'),

  // Extracted reference levels and everything read out of them.
  '/api/levels': at('viewer'),
  '/api/level': at('viewer'),
  // Reading the census is a cache hit; `?refresh=1` throws both caches away and re-reads every map folder in
  // the library, for everybody — a cost that belongs to a moderator, like the fetch behind /api/version.
  '/api/level-census': (_method, _path, query) => query?.get('refresh') === '1' ? 'moderator' : 'viewer',
  '/api/effects': at('viewer'),
  '/api/groups': at('viewer'),
  '/api/lightrig': at('viewer'),
  '/api/lightmap': at('viewer'),
  '/api/physics-body': at('viewer'),
  '/api/reference-music': at('viewer'),
  '/api/reference-music-sample': at('viewer'),
    '/api/reference-intro-music': at('viewer'),
    '/api/effect-sound': at('viewer'),
    '/api/environment-sound': at('viewer'),
    '/api/board-audio': at('viewer'),
  '/api/board-sound': at('viewer'),
  '/api/sound-banks': at('viewer'),

  // Reference libraries and the open mountain's own authored assets: read by everyone, changed by an editor.
  '/api/textures': library,
  '/api/texture': library,
  '/api/texture-usage': library,
  '/api/particle-texture': library,
  '/api/props': library,
  '/api/custom-props': library,
  '/api/characters': library,
  '/api/character-model': library,
  '/api/custom-music': library,
  '/api/custom-music-file': library,
  '/api/custom-sounds': library,
  '/api/custom-sound': library,
  '/api/skybox': library,
  '/api/skypano': library,
  '/api/skyground': library,

  // The Blender bridge (docs/046). Reading a model out is a read of the mountain's own geometry; pushing one
  // back changes it, so it sits behind the same editor gate every other authoring write does. The addon
  // carries the ordinary session cookie on a server with accounts and resolves to the owner on one without.
  '/api/blender': library,

  // The routes that put something into a library, or take it out of one.
  '/api/texture-upload': at('editor'),
  '/api/texture-rename': at('editor'),
  '/api/texture-clone': at('editor'),
  '/api/texture-replace': at('editor'),
  '/api/texture-delete': at('editor'),
  '/api/sound-upload': at('editor'),
  '/api/skyupload': at('editor'),
  '/api/custom-prop-import': at('editor'),
  '/api/custom-prop-rename': at('editor'),
  '/api/custom-prop-clone': at('editor'),
  '/api/custom-prop-replace': at('editor'),
  '/api/custom-prop-materials': at('editor'),
  '/api/custom-prop-delete': at('editor'),
  '/api/character-import': at('editor'),

  // Generation spends the operator's API credit, so it is an authoring action rather than a read.
  '/api/fal-texture': at('editor'),
  '/api/fal-inpaint': at('editor'),
  '/api/fal-panorama': at('editor'),
  '/api/fal-3d': at('editor'),
};

/** Mounts already reported as unlisted, so one is named once rather than on every request. */
const reportedClosed = new Set<string>();

/** What a mount asks of a request — the closed-by-default rule itself, so it can be asserted rather than
 *  assumed. */
export function accessFor(mount: string): Access {
  const declared = ROUTE_ACCESS[mount];
  if (declared) return declared;
  if (!reportedClosed.has(mount)) {
    reportedClosed.add(mount);
    accountsLog.warn(`${mount} declares no access in app.ts, so it is admin-only. Give it an entry in`
      + ' ROUTE_ACCESS to open it to members.');
  }
  return at('admin');
}

/** What every route sees: the request, and who it is from. Nothing below this line asks whether the server
 *  has accounts — the principal is already the answer. */
/** Every `/api/*` route the editor calls. Answers `true` once it has taken the request, `false` when no route
 * claims it, so the caller decides what an unknown path means. */
export async function handleApiRequest(
  req: IncomingMessage, res: ServerResponse, controls: ApiControls = {},
): Promise<boolean> {
  const url = req.url ?? '/';
  for (const [mount, handle] of routes) {
    const mounted = mountedUrl(url, mount);
    if (mounted === null) continue;
    req.url = mounted;
    try {
      const method = req.method ?? 'GET';
      const path = mounted.split('?')[0];
      // Before identity, because it is about where the request came from rather than who sent it: a write
      // from a page on another site is refused whoever that page's browser is signed in as.
      const crossSite = SAFE_METHODS.has(method) ? null : crossSiteRefusal(req);
      if (crossSite) {
        jsonResponse(res, crossSite.status, crossSite.body);
        return true;
      }
      const need = accessFor(mount)(method, path, new URL(mounted, 'http://localhost').searchParams);
      const decision = await authorizeRequest(req, need);
      if (!decision.allowed) {
        jsonResponse(res, decision.status, decision.body);
        return true;
      }
      // Carried on the request so a handler that comes to need it — who took the lease, who authored a
      // checkpoint — reads the principal this decision was made against rather than resolving its own.
      (req as ApiRequest).identity = decision.identity;
      // Reset the browser's Max-Age when the server-side sliding session was touched. Without this, the
      // record lives on while the browser drops its cookie fourteen days after the original login.
      if (decision.identity.kind === 'member' && decision.identity.refreshCookie) {
        const token = sessionToken(req);
        if (token) setSessionCookie(res, token, isSecureOrigin(req));
      }
      if (requestNeedsProjectAssets(mount, mounted)) {
        await withRequestProjectAssets(req, () => handle(req, res, controls), need === 'editor');
      }
      else await handle(req, res, controls);
    } catch (error) {
      // Handlers answer their own failures; this is the net under a handler that threw before it could —
      // which includes the project-asset wrapper above, running OUTSIDE the handler's own try/catch. A
      // request that named no mountain is a refusal with a reason rather than a fault, so it is answered as
      // one and not logged as a crash; everything else is still a 500 with the stack.
      const expected = error instanceof NoOpenProjectError || error instanceof ProjectPermissionError;
      if (!expected) log.error(`${req.method ?? 'GET'} ${url} failed`, { error });
      if (!res.headersSent) {
        res.statusCode = expected ? error.statusCode : 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }));
      } else res.destroy();
    }
    return true;
  }
  return false;
}
