import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  PLAY_PROTOCOL_VERSION,
  type PlayConfig,
  type PlayControlMessage,
  type TicketClaims,
  type TicketRequest,
  type TicketResponse,
} from '../core/session/play-protocol.generated';
import { guestMember } from './accounts/guests';
import { onAccountAccessChanged } from './accounts/events';
import { clientAddress, behindProxy } from './accounts/policy';
import { publicRoomAllowed, publicRoomKnown, onPublicCoursesChanged } from './public-courses';
import { projectManifest, onProjectDeleted } from './projects';
import { sessionById, colorFor } from './session/presence';
import type { ApiRequest } from './api/request';
import { createLogger } from './log';

const log = createLogger('play');
const SOCKET_PATH = '/api/play/session';
export function playConfig(): PlayConfig {
  const secret = process.env.SLOPESMITH_MULTIPLAYER_SECRET ?? '';
  const enabled = !!process.env.SLOPESMITH_MULTIPLAYER_URL;
  if (enabled && secret.length < 32) throw new Error('SLOPESMITH_MULTIPLAYER_SECRET must contain at least 32 bytes.');
  return { enabled, socketPath: SOCKET_PATH, ticketPath: '/api/play/ticket' };
}
function secret(): string {
  if (!playConfig().enabled) throw new Error('The multiplayer relay is not configured.');
  return process.env.SLOPESMITH_MULTIPLAYER_SECRET!;
}
function signature(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}
function previousClaims(value: unknown): TicketClaims | null {
  if (typeof value !== 'string' || value.length > 8192) return null;
  const [payload, mac, extra] = value.split('.');
  if (!payload || !mac || extra) return null;
  const expected = Buffer.from(signature(payload)),
    received = Buffer.from(mac);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TicketClaims;
  } catch {
    return null;
  }
}

// Admission is low frequency, but public retries must not turn it into unbounded disk/auth work.
const admissions = new Map<string, { tokens: number; at: number }>();
const admittedPublicCourses = new Set<string>();
function admitted(req: IncomingMessage): boolean {
  const now = Date.now();
  for (const [key, bucket] of admissions) if (now - bucket.at > 60_000) admissions.delete(key);
  const key = clientAddress(req),
    bucket = admissions.get(key) ?? { tokens: 120, at: now };
  bucket.tokens = Math.min(120, bucket.tokens + ((now - bucket.at) / 1000) * 20);
  bucket.at = now;
  if (admissions.size >= 10_000 && !admissions.has(key)) return false;
  admissions.set(key, bucket);
  if (bucket.tokens < 1) return false;
  bucket.tokens--;
  return true;
}

export async function issuePlayTicket(req: ApiRequest, input: TicketRequest): Promise<TicketResponse> {
  secret();
  if (!admitted(req)) throw new Error('Too many play admission requests. Try again shortly.');
  if (!input || typeof input !== 'object') throw new Error('Invalid play request.');
  const clean = (value: unknown, max: number): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);
  if (
    !clean(input.courseId, 160) ||
    !clean(input.clientId, 64) ||
    !clean(input.deviceLabel, 32) ||
    typeof input.roomId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,64}$/.test(input.roomId) ||
    typeof input.publicPlay !== 'boolean'
  )
    throw new Error('Invalid play room or client identity.');
  const courseId = input.courseId.startsWith('@reference:')
    ? `@reference:${input.courseId.slice(11).toUpperCase()}`
    : input.courseId;
  const identity = req.identity;
  const guest = input.publicPlay && identity?.kind !== 'member' ? await guestMember(req) : null;
  const user = guest ?? (identity?.kind === 'member' || identity?.kind === 'owner' ? identity.user : null);
  if (!user) throw new Error('Enter a rider name before joining multiplayer.');
  if (input.publicPlay) {
    if (!(await publicRoomAllowed(courseId))) throw new Error('This course is not public.');
    admittedPublicCourses.add(courseId);
  } else {
    const editor = input.editorSessionId ? sessionById(input.editorSessionId) : undefined;
    if (!editor || editor.publicPlay || editor.member.id !== user.id || editor.clientId !== input.clientId)
      throw new Error('The editor session is no longer connected.');
    if (!courseId.startsWith('@reference:')) await projectManifest(courseId);
  }
  const prior = previousClaims(input.previousTicket);
  const reusable =
    prior &&
    prior.member.id === user.id &&
    prior.clientId === input.clientId &&
    prior.courseId === courseId &&
    prior.roomId === input.roomId &&
    prior.publicPlay === input.publicPlay;
  const originHeader = req.headers.origin;
  const origin =
    typeof originHeader === 'string'
      ? new URL(originHeader).origin
      : `${behindProxy() && req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`;
  const claims: TicketClaims = {
    protocol: PLAY_PROTOCOL_VERSION,
    nonce: randomUUID(),
    expiresAt: Date.now() + 60_000,
    sessionId: input.publicPlay ? (reusable ? prior.sessionId : randomUUID()) : input.editorSessionId!,
    clientId: input.clientId,
    deviceLabel: input.deviceLabel,
    member: {
      id: user.id,
      username: user.username,
      role: user.role,
      ...('snowboardTextureUrl' in user && user.snowboardTextureUrl
        ? { snowboardTextureUrl: user.snowboardTextureUrl }
        : {}),
      ...('skiTextureUrl' in user && user.skiTextureUrl ? { skiTextureUrl: user.skiTextureUrl } : {}),
      ...('equipmentEdgeColor' in user && user.equipmentEdgeColor
        ? { equipmentEdgeColor: user.equipmentEdgeColor }
        : {}),
    },
    color: colorFor(user.id),
    courseId,
    roomId: input.roomId,
    publicPlay: input.publicPlay,
    origin,
    ...(identity?.kind === 'member' && !guest ? { accountSessionId: identity.sessionId } : {}),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return { ticket: `${payload}.${signature(payload)}`, expiresAt: claims.expiresAt };
}

/** Control traffic only. Browser WebSockets are routed straight to Rust by Vite/the production proxy. */
export async function sendPlayControl(message: PlayControlMessage): Promise<void> {
  if (!playConfig().enabled) return;
  const base = new URL(process.env.SLOPESMITH_MULTIPLAYER_URL!);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))
    throw new Error('SLOPESMITH_MULTIPLAYER_URL must name a loopback HTTP relay.');
  const response = await fetch(new URL('/control', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret()}`, 'content-type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error(`Multiplayer control failed (${response.status}).`);
}
export function attachPlayControl(): () => void {
  // Fail fast on invalid deployment configuration, before serving admission tickets.
  playConfig();
  const dispatch = (message: PlayControlMessage) => {
    void sendPlayControl(message).catch(error =>
      log.warn('Relay control unavailable; admission leases will expire.', { error }),
    );
  };
  const access = onAccountAccessChanged(event =>
    dispatch(
      event.kind === 'session-revoked'
        ? { t: 'revoke-session', accountSessionId: event.accountSessionId }
        : { t: 'revoke-user', userId: event.kind === 'role-changed' ? event.user.id : event.userId },
    ),
  );
  const deleted = onProjectDeleted(project => dispatch({ t: 'remove-course', courseId: project.id }));
  const publication = onPublicCoursesChanged(() => {
    for (const courseId of admittedPublicCourses)
      if (!publicRoomKnown(courseId)) {
        dispatch({ t: 'remove-course', courseId });
        admittedPublicCourses.delete(courseId);
      }
  });
  return () => {
    access();
    deleted();
    publication();
  };
}
