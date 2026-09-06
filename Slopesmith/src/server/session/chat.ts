import type { Role } from '../accounts/policy';
import { createLogger } from '../log';

/**
 * The server-wide room (docs/038): what members say to each other, and the system events that ride the same
 * stream.
 *
 * One room, because a crew this size is one room — and the facts the server already holds ("Jed joined",
 * "Alice restored the checkpoint from 14:02", "Bob created MOUNTAIN01") belong in it rather than in a
 * separate log, because they answer the same question as "back in 10, don't touch the halfpipe".
 *
 * Everything here lives in memory beside presence and nowhere else. Chat is not a document: persisting it
 * would mean a `mountain.slope.json` whose bytes change because somebody said hello, which is exactly what
 * presence must never be either. A restart is allowed to forget the room entirely.
 *
 * Two rules make the stream worth reading. **A system line is made here**, from something the server knows,
 * so it is a fact rather than something a client claimed — every message a client sends becomes a line
 * attributed to whoever sent it, whatever it says. **A message is text, never markup**: it is escaped once,
 * on the way in, so retention, relay and any log downstream all hold something that cannot become an element.
 *
 * This module knows nothing about sockets. It announces deliveries and `channel.ts` fans them out, the same
 * shape presence uses — so the rules below (who hears a private line, what `/r` replies to, what a rate limit
 * refuses) are exercised directly.
 */

/** A member as a line names them. Same fields presence reports, under the name a chat line reads best with. */
export interface ChatWho {
  userId: string;
  username: string;
  role: Role;
}

/**
 * One line of the room.
 *
 * `room` is what everybody sees, `private` is a `/msg` between two members, and `system` is the server's own
 * — either a fact everybody hears, or a notice to one person about their own command. `text` is already
 * escaped, so nothing downstream has to remember to do it.
 */
export interface ChatLine {
  id: number;
  /** Milliseconds since the epoch, so a client renders it against its own clock. */
  at: number;
  kind: 'room' | 'private' | 'system';
  text: string;
  from?: ChatWho;
  /** The recipient of a private line, which is what draws it as one rather than as room traffic. */
  to?: ChatWho;
}

/** Everybody connected, or the members named by id. */
export type ChatAudience = 'everyone' | readonly string[];

export interface ChatDelivery {
  line: ChatLine;
  audience: ChatAudience;
}

/**
 * How much room there is, and how fast.
 *
 * The history is what a joining client is replayed, so it is the length of "what did I miss" rather than an
 * archive — a few hundred lines is a morning. The allowance is a bucket rather than a hard interval, so a
 * burst of three quick lines reads normally and a loop does not.
 */
export interface ChatPolicy {
  /** What one message may weigh, in characters. */
  maxLength: number;
  /** How many lines are retained and replayed on join. */
  history: number;
  /** Messages allowed back to back, and how long one takes to come back. */
  burst: number;
  refillMs: number;
}

export const chatPolicy: ChatPolicy = {
  maxLength: 400,
  history: 300,
  burst: 6,
  refillMs: 2_000,
};

/** Retune the room — the seam a test uses to exercise the rate limit without sending hundreds of lines. */
export function configureChat(patch: Partial<ChatPolicy>): ChatPolicy {
  return Object.assign(chatPolicy, patch);
}

/** Who a `/msg` may name: any member of this server, connected or not. Supplied by the channel, because the
 *  account store is the server's rather than the room's. */
export interface ChatDirectory {
  find(name: string): Promise<ChatWho | null>;
}

// ---- text ----

const ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

/**
 * A message as text that cannot be markup.
 *
 * Escaped here rather than at the point something renders it, because there is one way into the room and
 * several ways out of it — a relay, the retained history replayed to a joiner, a console line — and only the
 * way in can be counted. A client draws it back as characters in a text node, so nothing on either end ever
 * parses a member's sentence.
 */
export const asText = (raw: string): string => raw.replace(/[&<>"']/g, character => ESCAPES[character]);

/** What a member actually typed: one line, no control characters, no leading or trailing space. */
// eslint-disable-next-line no-control-regex -- strips control characters from a member-typed chat line
const clean = (raw: unknown): string => String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

// ---- the room ----

let nextId = 1;
const retained: ChatDelivery[] = [];
const listeners = new Set<(delivery: ChatDelivery) => void>();
/** Who last sent each member a private line, which is the whole of what `/r` knows. */
const lastPrivate = new Map<string, ChatWho>();
/** Each member's remaining allowance, and when it was last spent. */
const allowance = new Map<string, { tokens: number; at: number }>();

export function onChatLine(listener: (delivery: ChatDelivery) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const log = createLogger('chat');

function deliver(line: Omit<ChatLine, 'id'>, audience: ChatAudience, keep: boolean): ChatLine {
  const delivery: ChatDelivery = { line: { ...line, id: nextId++ }, audience };
  if (keep) {
    retained.push(delivery);
    if (retained.length > chatPolicy.history) retained.splice(0, retained.length - chatPolicy.history);
  }
  for (const listener of listeners) {
    try { listener(delivery); } catch (error) { log.error('a line listener failed', { error }); }
  }
  return delivery.line;
}

/**
 * Something the server did, said to everybody.
 *
 * Only this module and the routes that performed the thing call it, which is what makes a system line a fact:
 * there is no message a client can send that produces one.
 */
export function systemEvent(text: string): ChatLine {
  return deliver({ at: Date.now(), kind: 'system', text: asText(text) }, 'everyone', true);
}

/** An answer to one person about their own command — never retained, because it was never the room's. */
function notice(to: ChatWho, text: string): ChatLine {
  return deliver({ at: Date.now(), kind: 'system', text: asText(text) }, [to.userId], false);
}

function spendAllowance(userId: string, now: number): boolean {
  const held = allowance.get(userId) ?? { tokens: chatPolicy.burst, at: now };
  const tokens = Math.min(chatPolicy.burst, held.tokens + (now - held.at) / chatPolicy.refillMs);
  if (tokens < 1) {
    allowance.set(userId, { tokens, at: now });
    return false;
  }
  allowance.set(userId, { tokens: tokens - 1, at: now });
  return true;
}

// ---- the two slash commands ----

/** `/msg <user> <text>`. The quoted form remains accepted even though usernames do not contain spaces. */
const PRIVATE = /^\/(?:msg|w|tell)\b\s*(?:"([^"]*)"|(\S+))?\s*([\s\S]*)$/i;
const REPLY = /^\/r(?:eply)?\b\s*([\s\S]*)$/i;

type Command =
  | { kind: 'room'; text: string }
  | { kind: 'private'; to: string; text: string }
  | { kind: 'reply'; text: string }
  | { kind: 'incomplete'; usage: string }
  | { kind: 'unknown'; command: string };

function parseChat(text: string): Command {
  if (!text.startsWith('/')) return { kind: 'room', text };
  const priv = PRIVATE.exec(text);
  if (priv) {
    const to = (priv[1] ?? priv[2] ?? '').trim();
    const body = priv[3].trim();
    if (!to || !body) return { kind: 'incomplete', usage: '/msg <user> <text> — a private line to one member.' };
    return { kind: 'private', to, text: body };
  }
  const reply = REPLY.exec(text);
  if (reply) {
    const body = reply[1].trim();
    if (!body) return { kind: 'incomplete', usage: '/r <text> — a private reply to whoever messaged you last.' };
    return { kind: 'reply', text: body };
  }
  return { kind: 'unknown', command: text.split(/\s/)[0] };
}

function sendPrivate(from: ChatWho, to: ChatWho, body: string, now: number): ChatLine {
  const line = deliver({ at: now, kind: 'private', from, to, text: asText(body) },
    from.userId === to.userId ? [from.userId] : [from.userId, to.userId], true);
  // What `/r` replies to. A line to yourself leaves it alone, so `/r` still answers whoever really wrote.
  if (from.userId !== to.userId) lastPrivate.set(to.userId, from);
  return line;
}

/**
 * A member has said something.
 *
 * The order is deliberate: what is too long is refused before it is counted, what is too fast is refused
 * before it is parsed, and a command is resolved before anything is delivered. Every refusal answers the
 * sender alone — the room never sees somebody else's mistyped command.
 */
export async function submitChat(from: ChatWho, raw: unknown, directory: ChatDirectory,
  now = Date.now()): Promise<ChatLine | null> {
  const text = clean(raw);
  if (!text) return null;
  if (text.length > chatPolicy.maxLength) {
    return notice(from, `That is longer than ${chatPolicy.maxLength} characters — say it in two.`);
  }
  if (!spendAllowance(from.userId, now)) {
    return notice(from, 'That is faster than the room can read. Wait a moment and say it again.');
  }
  const command = parseChat(text);
  switch (command.kind) {
    case 'room':
      return deliver({ at: now, kind: 'room', from, text: asText(text) }, 'everyone', true);
    case 'private': {
      const to = await directory.find(command.to);
      if (!to) return notice(from, `There is nobody called ${command.to} on this server.`);
      return sendPrivate(from, to, command.text, now);
    }
    case 'reply': {
      const last = lastPrivate.get(from.userId);
      if (!last) return notice(from, 'Nobody has sent you a private line yet, so there is nobody to reply to.');
      // Resolved again rather than trusted: a role or username may have moved since they wrote.
      const to = await directory.find(last.username) ?? last;
      return sendPrivate(from, to, command.text, now);
    }
    case 'incomplete':
      return notice(from, command.usage);
    default:
      return notice(from, `${command.command} is not a command here. /msg <user> <text> sends a private line,`
        + ' and /r <text> replies to whoever messaged you last.');
  }
}

/**
 * What a joining client is replayed: the room, the system events, and the private lines that were this
 * member's — never anybody else's, which is the whole of what retaining them costs.
 */
export function scrollbackFor(userId: string): ChatLine[] {
  return retained
    .filter(entry => entry.audience === 'everyone' || entry.audience.includes(userId))
    .map(entry => entry.line);
}

/** Everything the room holds, discarded — for a test that wants a server's chat to start empty. Listeners
 *  belong to whoever attached them and are left alone, exactly as the presence table leaves its own. */
export function forgetChat(): void {
  retained.length = 0;
  lastPrivate.clear();
  allowance.clear();
  nextId = 1;
}
