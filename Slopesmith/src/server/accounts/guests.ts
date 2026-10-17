import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isSecureOrigin } from './policy';
import type { SessionMember } from '../session/presence';
import { readAccounts } from './store';

const secret = randomBytes(32);
const COOKIE = 'slopesmith_guest';
const LIFETIME = 24 * 60 * 60;
const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');

const belongsToAccount = async (name: string): Promise<boolean> => (await readAccounts()).users
  .some(user => user.username === name.normalize('NFKC').trim().toLowerCase());

export async function guestMember(req: IncomingMessage): Promise<SessionMember | null> {
  const cookie = (req.headers.cookie ?? '').split(';').map(part => part.trim())
    .find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!cookie || cookie.length > 1024) return null;
  const [payload, mac] = cookie.split('.');
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(payload)), received = Buffer.from(mac);
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      id: string; name: string; expires: number;
    };
    if (value.expires < Date.now() || !value.id.startsWith('guest:') || typeof value.name !== 'string') return null;
    if (await belongsToAccount(value.name.replace(/ \(guest\)$/, ''))) return null;
    return { id: value.id, username: value.name, role: 'viewer' };
  } catch { return null; }
}

export async function createGuest(req: IncomingMessage, res: ServerResponse, name: unknown): Promise<SessionMember> {
  if (typeof name !== 'string') throw new Error('Enter a rider name.');
  // eslint-disable-next-line no-control-regex -- guest display names cannot contain controls or invisible separators
  const clean = name.normalize('NFKC').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, '').trim();
  if (clean.length < 1 || clean.length > 24) throw new Error('Use a rider name between 1 and 24 characters.');
  if (await belongsToAccount(clean)) throw new Error('That name belongs to an account. Sign in or choose another name.');
  const id = (await guestMember(req))?.id ?? `guest:${randomUUID()}`;
  const username = `${clean} (guest)`;
  const payload = Buffer.from(JSON.stringify({ id, name: username, expires: Date.now() + LIFETIME * 1000 })).toString('base64url');
  res.setHeader('set-cookie', `${COOKIE}=${payload}.${sign(payload)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${LIFETIME}`
    + (isSecureOrigin(req) ? '; Secure' : ''));
  return { id, username, role: 'viewer' };
}
