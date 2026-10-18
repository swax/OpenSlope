import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isSecureOrigin } from './policy';
import { chatIdentity } from './chat-identity';
import type { SessionMember } from '../session/presence';
import { readAccounts } from './store';

const secret = randomBytes(32);
const COOKIE = 'slopesmith_guest';
const LIFETIME = 24 * 60 * 60;
// A configured relay survives editor-process restarts. Derive a separate cookie key from its persistent
// shared secret so a restart does not invalidate every guest's next admission renewal.
const signingKey = () =>
  process.env.SLOPESMITH_MULTIPLAYER_SECRET
    ? createHmac('sha256', process.env.SLOPESMITH_MULTIPLAYER_SECRET).update('slopesmith-guest-cookie-v1').digest()
    : secret;
const sign = (payload: string) => createHmac('sha256', signingKey()).update(payload).digest('base64url');

export function anonymousMember(member: SessionMember): SessionMember {
  const number = Number.parseInt(createHmac('sha256', signingKey()).update(member.id).digest('hex').slice(0, 8), 16);
  return { ...member, username: `guest${(number % 99) + 1}`, anonymous: true };
}

function guestCookie(req: IncomingMessage, res: ServerResponse, member: SessionMember): void {
  const payload = Buffer.from(
    JSON.stringify({
      id: member.id,
      name: member.username,
      anonymous: member.anonymous === true,
      expires: Date.now() + LIFETIME * 1000,
    }),
  ).toString('base64url');
  res.setHeader(
    'set-cookie',
    `${COOKIE}=${payload}.${sign(payload)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${LIFETIME}` +
      (isSecureOrigin(req) ? '; Secure' : ''),
  );
}

export async function createVisitor(req: IncomingMessage, res: ServerResponse): Promise<SessionMember> {
  const existing = await guestMember(req);
  if (existing) return existing;
  const member = anonymousMember({
    id: `guest:${randomUUID()}`,
    username: '',
    role: 'viewer',
    chatId: await chatIdentity(req),
  });
  guestCookie(req, res, member);
  return member;
}

const belongsToAccount = async (name: string): Promise<boolean> =>
  (await readAccounts()).users.some(user => user.username === name.normalize('NFKC').trim().toLowerCase());

export async function guestMember(req: IncomingMessage): Promise<SessionMember | null> {
  const cookie = (req.headers.cookie ?? '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!cookie || cookie.length > 1024) return null;
  const [payload, mac] = cookie.split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload)),
    received = Buffer.from(mac);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      id: string;
      name: string;
      expires: number;
      anonymous?: boolean;
    };
    if (value.expires < Date.now() || !value.id.startsWith('guest:') || typeof value.name !== 'string') return null;
    if (!value.anonymous && (await belongsToAccount(value.name.replace(/ \(guest\)$/, '')))) return null;
    const member: SessionMember = {
      id: value.id,
      username: value.name,
      role: 'viewer',
      chatId: await chatIdentity(req),
      ...(value.anonymous ? { anonymous: true } : {}),
    };
    return member.anonymous ? anonymousMember(member) : member;
  } catch {
    return null;
  }
}

export async function createGuest(req: IncomingMessage, res: ServerResponse, name: unknown): Promise<SessionMember> {
  if (typeof name !== 'string') throw new Error('Enter a rider name.');
  const clean = name
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- guest display names cannot contain controls or invisible separators
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '')
    .trim();
  if (clean.length < 1 || clean.length > 24) throw new Error('Use a rider name between 1 and 24 characters.');
  if (await belongsToAccount(clean))
    throw new Error('That name belongs to an account. Sign in or choose another name.');
  const id = (await guestMember(req))?.id ?? `guest:${randomUUID()}`;
  const username = `${clean} (guest)`;
  const member: SessionMember = { id, username, role: 'viewer', chatId: await chatIdentity(req) };
  guestCookie(req, res, member);
  return member;
}
