import { chatBans, setChatBan, isChatId } from '../accounts/chat-identity';
import { holds } from '../accounts/policy';
import { siteSnapshot } from '../play';
import { liveSessions } from '../session/presence';
import type { ChatMember } from '../../core/session/chat-member';
import { jsonResponse, readJsonBody, type ApiHandler } from './common';
import type { ApiRequest } from './request';

export function liveChatMembers(): ChatMember[] {
  return [
    ...new Map(
      liveSessions().map(session => [
        session.member.id,
        {
          id: session.member.id,
          username: session.member.username,
          role: session.member.role,
          ...(session.member.anonymous ? { anonymous: true } : {}),
          ...(session.member.chatId ? { chatId: session.member.chatId } : {}),
        },
      ]),
    ).values(),
  ];
}

export const chatRoutes: Record<string, ApiHandler> = {
  '/api/chat': async (req, res) => {
    res.setHeader('cache-control', 'no-store');
    if ((req.url ?? '').replace(/\/+$/, '') !== '/moderation') {
      jsonResponse(res, 404, { error: 'Unknown chat route.' });
      return;
    }
    const identity = (req as ApiRequest).identity;
    if (
      !identity ||
      (identity.kind !== 'member' && identity.kind !== 'owner') ||
      !holds(identity.user.role, 'moderator')
    ) {
      jsonResponse(res, 403, { error: 'Chat moderation requires a moderator.' });
      return;
    }
    if (req.method === 'GET') {
      jsonResponse(res, 200, { hashes: await chatBans() });
      return;
    }
    if (req.method !== 'POST') {
      jsonResponse(res, 405, { error: 'Use GET or POST.' });
      return;
    }
    const body = (await readJsonBody(req, 1024)) as { hash?: unknown; banned?: unknown };
    if (!body || !isChatId(body.hash) || typeof body.banned !== 'boolean') {
      jsonResponse(res, 400, { error: 'Supply a chat hash and banned flag.' });
      return;
    }
    const site = await siteSnapshot().catch(() => null);
    const targets = [...liveChatMembers(), ...(site?.members.map(entry => entry.member) ?? [])].filter(
      member => member.chatId === body.hash,
    );
    if (
      body.banned &&
      targets.some(
        member =>
          member.id === identity.user.id ||
          member.role === 'admin' ||
          (identity.user.role === 'moderator' && member.role === 'moderator'),
      )
    ) {
      jsonResponse(res, 403, {
        error: 'You cannot shadow-ban this network while it includes your account or a protected staff account.',
      });
      return;
    }
    await setChatBan(body.hash, body.banned, identity.user.id);
    jsonResponse(res, 200, { hashes: await chatBans() });
  },
};
