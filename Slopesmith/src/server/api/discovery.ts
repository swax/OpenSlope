import type { ApiRequest } from './request';
import type { Identity } from '../accounts/guard';
import { requiresAccounts } from '../accounts/policy';
import { holds } from '../accounts/policy';
import { originSummary } from '../../core/export/origin';
import { responseCache } from '../response-cache';
import { listSoundBanks } from '../routes/audio';
import { listLevels, readLevelOrigin } from '../routes/levels';
import { levelsWithProps } from '../routes/props';
import { textureFiles } from '../routes/textures';
import { jsonResponse, type ApiHandler } from './common';
import { AUTHORING_GUIDE } from './guide';
import { BROWSER_WORKFLOWS } from './browser-workflows';
import { link, type ApiAction, type ApiLink, type HateoasEnvelope } from './hateoas';

/**
 * The API's front door (docs/052): `GET /api` answers with who the caller is and where everything else is,
 * so a program that knows only this server's address — an AI agent with a bearer key, a script, a person
 * with curl — discovers the rest by following links instead of by reading source. Modelled on the naisys
 * HATEOAS design: the entry point is tiny, navigation is context-sensitive, and each branch page describes
 * one area with the URL templates and upload encodings its routes actually accept.
 *
 * This module also owns what an unknown `/api/*` path answers. Its mounts register LAST (`app.ts`), so
 * `/api` claims only what no real route did — and instead of a bare 404, the miss carries a link back to
 * the root, which is the recourse an agent that guessed a URL needs.
 */

/** Who the caller is, in the terms the rest of the response is shaped by. */
function identitySummary(identity: Identity | undefined) {
  if (!identity) return { kind: 'anonymous' as const };
  if ('user' in identity) {
    return { kind: identity.kind, username: identity.user.username, role: identity.user.role };
  }
  return { kind: identity.kind };
}

function root(identity: Identity | undefined): Record<string, unknown> {
  const summary = identitySummary(identity);
  if (identity?.kind === 'unenrolled') {
    return {
      service: 'slopesmith',
      identity: summary,
      error: 'This server has not been enrolled yet — its operator has a one-time admin code in the log.',
      _links: [link('self', '/api')],
    };
  }
  if (!identity || identity.kind === 'anonymous') {
    const actions: ApiAction[] = [{
      rel: 'login', href: '/api/auth/login', method: 'POST', title: 'Sign in (browser sessions)',
      schema: '/api/schemas/Login', body: { username: '', password: '' },
    }];
    return {
      service: 'slopesmith',
      identity: summary,
      hint: 'Programs authenticate with a personal access key on every request: '
        + '`Authorization: Bearer slop_…`. A signed-in member mints one at POST /api/auth/keys.',
      _links: [
        link('self', '/api'),
        link('explorer', '/api/explorer', 'Browse this API interactively (humans, in a browser)'),
      ],
      _actions: actions,
    };
  }
  const role = 'user' in identity ? identity.user.role : 'admin';
  const links: ApiLink[] = [
    link('self', '/api'),
    link('maps', '/api/projects', 'Authored mountains: list, create, edit through registers, checkpoint'),
    link('reference', '/api/reference', 'Extracted reference levels: terrain, props, textures, effects, sounds'),
    link('avatars', '/api/avatars', 'The server-wide rider avatar library'),
    link('guide', '/api/guide', 'How to author a mountain through this API — read this first'),
    link('explorer', '/api/explorer', 'Browse this API interactively (humans, in a browser)'),
    link('schemas', '/api/schemas', 'JSON Schemas the action bodies point at'),
    link('browser-workflows', '/api/browser', 'Browser view links, screenshot readiness, inspection, rides and exports'),
    link('me', '/api/auth/session', 'The signed-in account behind this request'),
    link('version', '/api/version', 'What this server is running'),
  ];
  // A key cannot manage keys (accounts/guard.ts), and on a server without accounts there are none to manage.
  if (identity.kind === 'member') {
    links.push(link('keys', '/api/auth/keys', 'Personal access keys: list here, mint with POST {name}'));
  }
  if (holds(role, 'moderator')) {
    links.push(link('members', '/api/members', 'The server roster: accounts, roles, invites'));
  }
  return {
    service: 'slopesmith',
    identity: summary,
    accounts: requiresAccounts() ? 'required' : 'open',
    _links: links,
  };
}

/** The extracted-levels branch: everything a shipped course can lend an authored one. */
function referenceBranch(): Record<string, unknown> {
  const envelope: HateoasEnvelope = {
    _links: [
      link('self', '/api/reference'),
      link('root', '/api'),
      link('levels', '/api/levels', 'Every extracted level in the library, with origins'),
      link('census', '/api/level-census', 'Size and cost of every mountain, for comparison'),
      link('prop-materials', '/api/props/materials', 'Every level\'s prop material table'),
      link('board-audio', '/api/board-audio', 'The shared board-ride sound banks'),
    ],
    _linkTemplates: [
      { rel: 'item', hrefTemplate: '/api/reference/{level}',
        title: 'One level of the `levels` list, as a branch page: what it is, and every part of it borrowable' },
      { rel: 'level', hrefTemplate: '/api/level?name={level}',
        title: 'One level\'s terrain patches, course line, splines, AI paths, sun and world record' },
      { rel: 'level-textures', hrefTemplate: '/api/textures?level={level}',
        title: 'The tiles a level ships; bytes at /api/texture?level={level}&name={file}' },
      { rel: 'level-prop-index', hrefTemplate: '/api/props/index?level={level}',
        title: 'A level\'s models by name, triangle cost and tiles — the slim index to choose one from' },
      { rel: 'level-props', hrefTemplate: '/api/props?level={level}',
        title: 'A level\'s whole prop payload — models by ModelID, for placing as o/prop registers. Large.' },
      { rel: 'level-effects', hrefTemplate: '/api/effects?level={level}',
        title: 'A level\'s portable SSF effect graph — the best reference for authoring your own' },
      { rel: 'level-groups', hrefTemplate: '/api/groups?level={level}',
        title: 'Mined multi-prop assemblies placeable as one group prop' },
      { rel: 'level-lightrig', hrefTemplate: '/api/lightrig?level={level}',
        title: 'A level\'s whole shipped light rig' },
      { rel: 'level-sky', hrefTemplate: '/api/skypano?level={level}',
        title: 'A level\'s sky panorama PNG; borrow the whole sky with the g/skybox register' },
      { rel: 'level-sounds', hrefTemplate: '/api/sound-banks?level={level}',
        title: 'The sound banks a level ships; slot bytes at /api/effect-sound' },
      { rel: 'level-music', hrefTemplate: '/api/reference-music?level={level}',
        title: 'A level\'s interactive race-music graph' },
    ],
  };
  return { title: 'Reference: the extracted levels', ...envelope };
}

/**
 * One extracted level's own page: what the folder is, roughly what it holds, and a resolved link to every
 * part of it a mountain can borrow — the reference branch's templates already substituted.
 *
 * Only cheap facts go in it. Each of the payloads these links reach is megabytes on a real course, so a
 * summary that opened them would cost more than the thing it describes; what is answered here is a folder's
 * origin record and two directory listings. Shared through the response cache like every other library read,
 * which is why it reads no identity (docs/052).
 */
async function levelBranch(level: string): Promise<Record<string, unknown>> {
  const [origin, textures, banks, withProps] = await Promise.all([
    readLevelOrigin(level), textureFiles(level), listSoundBanks(level), levelsWithProps(),
  ]);
  const name = encodeURIComponent(level);
  const envelope: HateoasEnvelope = {
    _links: [
      link('self', `/api/reference/${name}`),
      link('collection', '/api/reference'),
      link('root', '/api'),
      link('level', `/api/level?name=${name}`,
        'Terrain patches, course line, splines, AI paths, sun and world record'),
      link('level-textures', `/api/textures?level=${name}`,
        'The tiles it ships; paint one as the q/<quadId>/tex register "<LEVEL>/<file>.png"'),
      link('level-prop-index', `/api/props/index?level=${name}`,
        'Its models by name, triangle cost and tiles — read this before the payload below'),
      link('level-props', `/api/props?level=${name}`,
        'The whole prop payload: geometry for every model, by ModelID. Large.'),
      link('level-effects', `/api/effects?level=${name}`,
        'Its portable SSF effect graph — the best reference for authoring your own'),
      link('level-groups', `/api/groups?level=${name}`,
        'Mined multi-prop assemblies placeable as one group prop'),
      link('level-lightrig', `/api/lightrig?level=${name}`, 'Its whole shipped light rig'),
      link('level-sky', `/api/skypano?level=${name}`,
        'Its sky panorama PNG; borrow the whole sky with the g/skybox register'),
      link('level-sounds', `/api/sound-banks?level=${name}`,
        'The sound banks it ships; slot bytes at /api/effect-sound'),
      link('level-music', `/api/reference-music?level=${name}`, 'Its interactive race-music graph'),
    ],
  };
  return {
    title: `Reference: ${level}`,
    level,
    origin: originSummary(level, origin),
    // What the folder carries, without pricing it: `props` is whether a prop table exists at all, since
    // counting its models means reading the table.
    holds: { props: withProps.includes(level), textures: textures.length, soundBanks: banks.length },
    ...envelope,
  };
}

/** The avatars branch: the one asset library that belongs to the server rather than to a map. */
function avatarsBranch(): Record<string, unknown> {
  const envelope: HateoasEnvelope = {
    _links: [
      link('self', '/api/avatars'),
      link('root', '/api'),
      link('list', '/api/characters', 'Every rider avatar on this server'),
    ],
    _linkTemplates: [
      { rel: 'model', hrefTemplate: '/api/character-model?name={file}', title: 'One avatar\'s GLB bytes' },
    ],
    _actionTemplates: [{
      rel: 'import', hrefTemplate: '/api/character-import?name={sourceFileName}', method: 'POST',
      title: 'Import a rigged Mixamo character as a rider avatar',
      alternateEncoding: {
        contentType: 'application/octet-stream',
        description: 'Raw Mixamo FBX bytes as the request body (96 MB cap); the response is a conversion '
          + 'report naming the stored avatar.',
      },
    }],
  };
  return {
    title: 'Avatars: rider characters',
    note: 'Which avatar a player wears is a per-person choice made in the editor, not map data — a map '
      + 'never names one. This library is what everyone chooses from.',
    ...envelope,
  };
}

export const discoveryRoutes: Record<string, ApiHandler> = {
  '/api/browser': (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    jsonResponse(res, 200, BROWSER_WORKFLOWS);
  },
  // The directory of extracted levels, and — one path down — any one of them: `/api/reference/GARI` is the
  // `item` template of the `levels` list, resolved. A name no folder answers to is a 404 back to the
  // directory, the same recourse the root's catch-all gives.
  '/api/reference': async (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    const path = (req.url ?? '/').split('?')[0].replace(/^\/+|\/+$/g, '');
    if (!path) { jsonResponse(res, 200, referenceBranch()); return; }
    const asked = decodeURIComponent(path);
    const level = (await listLevels()).find(name => name.toLowerCase() === asked.toLowerCase());
    if (!level) {
      jsonResponse(res, 404, {
        error: `No extracted level is named ${asked}.`,
        _links: [link('collection', '/api/reference', 'The extracted levels this server holds')],
      });
      return;
    }
    await responseCache.json(req, res, `reference-level:${level}`, () => levelBranch(level));
  },

  '/api/avatars': (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    jsonResponse(res, 200, avatarsBranch());
  },

  '/api/guide': (req, res) => {
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    res.statusCode = 200;
    res.setHeader('content-type', 'text/markdown; charset=utf-8');
    res.end(AUTHORING_GUIDE);
  },

  // Registered last of every mount (app.ts), so this is both `GET /api` itself and the answer to any
  // `/api/*` path no real route claimed.
  '/api': (req, res) => {
    const path = (req.url ?? '/').split('?')[0].replace(/\/+$/, '') || '/';
    if (path !== '/') {
      jsonResponse(res, 404, {
        error: `Nothing answers at /api${path}.`,
        _links: [link('root', '/api', 'The API directory — start here and follow links')],
      });
      return;
    }
    if (req.method !== 'GET') { res.statusCode = 405; res.end('GET only'); return; }
    jsonResponse(res, 200, root((req as ApiRequest).identity));
  },
};
