import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { join } from 'node:path';
import { readTextOrNull, writeJsonAtomic } from '../fs-async';
import { serialize } from '../serialize';
import { workspaceConfig } from '../workspace-config';
import { clientAddress } from './policy';

interface ChatPolicy {
  secret: string;
  bans: Record<string, { by: string; at: string }>;
}

const policies = new Map<string, Promise<ChatPolicy>>();
const policyFile = () => join(workspaceConfig().workspaceRoot, 'accounts', 'chat-policy.json');
export const isChatId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function policy(): Promise<ChatPolicy> {
  const file = policyFile();
  let pending = policies.get(file);
  if (!pending) {
    pending = serialize(`chat-policy:${file}`, async () => {
      const text = await readTextOrNull(file);
      if (text !== null) {
        const stored = JSON.parse(text) as ChatPolicy;
        if (!isChatId(stored.secret) || !stored.bans || typeof stored.bans !== 'object')
          throw new Error('Invalid chat policy.');
        return stored;
      }
      const fresh: ChatPolicy = { secret: randomBytes(32).toString('hex'), bans: {} };
      await writeJsonAtomic(file, fresh);
      return fresh;
    });
    policies.set(file, pending);
    void pending.catch(() => policies.delete(file));
  }
  return pending;
}

/** Uses the existing trusted-proxy boundary; equivalent IPv4 socket forms share an identity. */
export async function chatIdentity(req: IncomingMessage): Promise<string> {
  let address = clientAddress(req).toLowerCase();
  if (address.startsWith('::ffff:')) address = address.slice(7);
  if (address.includes(':')) {
    try {
      address = new URL(`http://[${address}]/`).hostname;
    } catch {
      /* use the socket representation */
    }
  }
  return createHmac('sha256', (await policy()).secret)
    .update(`slopesmith-chat-ip-v1:${address}`)
    .digest('hex');
}

export async function chatBans(): Promise<string[]> {
  return Object.keys((await policy()).bans);
}

export async function chatBanned(hash?: string): Promise<boolean> {
  return !!hash && Object.hasOwn((await policy()).bans, hash);
}

export async function setChatBan(hash: string, banned: boolean, by: string): Promise<void> {
  if (!isChatId(hash)) throw new Error('Invalid chat identity.');
  const file = policyFile();
  const current = await policy();
  await serialize(`chat-policy:${file}`, async () => {
    const bans = { ...current.bans };
    if (banned) bans[hash] = { by, at: new Date().toISOString() };
    else delete bans[hash];
    await writeJsonAtomic(file, { ...current, bans });
    current.bans = bans;
  });
}

export function forgetChatIdentity(): void {
  policies.clear();
}
