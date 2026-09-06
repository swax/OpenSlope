import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileStamp, readJsonOr, writeJsonAtomic } from '../fs-async';
import { serialize } from '../serialize';
import { workspaceConfig } from '../workspace-config';
import type { Role } from './policy';
import { isManualAvailability, type ManualAvailability } from '../../core/session/member-status';

/**
 * What a server knows about the people using it: users, invites, sessions and the one-time admin-enrolment
 * code, in one JSON record under the workspace.
 *
 * One file rather than three because every interesting change touches more than one of them — redeeming an
 * invite creates a user and spends the invite, a password reset revokes that user's sessions — and a single
 * atomic write is the cheapest way for those to land together or not at all.
 *
 * The record is re-read whenever its stamp moves, which is what lets the CLI stay the source of truth: a
 * `disable` run against a live server's workspace is seen by the next request, not the next restart.
 */

export interface UserRecord {
  id: string;
  /** Lowercased, and the key sign-in matches on. */
  username: string;
  /** Member-authored public profile text. */
  bio: string;
  /** Moderator-owned provenance for the invitation, such as `discord:joe123` or `email:joe@example.com`. */
  inviteHandle: string;
  role: Role;
  /** `scrypt$…` — see passwords.ts. Never anything recoverable. */
  password: string;
  createdAt: string;
  /** Durable activity stamp used by member profiles after the browser session itself has ended. */
  lastSeenAt: string;
  /** Explicit public availability. Automatic idle remains live session state and is never written here. */
  availability: ManualAvailability;
  passwordChangedAt: string;
  /** A small, browser-cropped profile image. The public account shape exposes only its authenticated URL,
   *  never these bytes, so roster and session messages stay small. */
  profilePicture?: {
    mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
    data: string;
    /** Content-derived cache key used by the public URL. */
    version: string;
  };
  /** Named artwork libraries. Only the selected design reaches public rider/session shapes; the
   *  complete library is returned solely to its owner from `/api/auth/equipment`. */
  equipment?: EquipmentRecord;
  /** Set while the account is refused sign-in and its sessions are void. */
  disabledAt?: string;
}

/** A browser-prepared account image. Shared by the two equipment slots so validation/storage cannot drift. */
export interface AccountImage {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  data: string;
  /** Content-derived cache key used by the public URL. */
  version: string;
}

export interface EquipmentDesignRecord {
  id: string;
  name: string;
  createdAt: string;
  texture: AccountImage;
}

export interface EquipmentLibraryRecord {
  selectedId?: string;
  designs: EquipmentDesignRecord[];
}

export interface EquipmentRecord {
  /** Shared because sidewalls/end caps are a rider preference rather than pixels in either artwork library. */
  edgeColor: string;
  snowboard: EquipmentLibraryRecord;
  skis: EquipmentLibraryRecord;
}

/** The account created by a single-use invite. */
export interface InviteRedemption { userId: string; username: string; at: string }

export interface InviteRecord {
  id: string;
  /** Only the digest — the link is the credential until it is redeemed, and the server cannot reproduce it. */
  tokenHash: string;
  role: Role;
  /** Private provenance chosen by the moderator. It becomes the redeemed account's invite handle. */
  handle: string;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  /** Present after the one intended account has redeemed this link. */
  redeemed?: InviteRedemption;
  revokedAt?: string;
}

export interface SessionRecord {
  id: string;
  /** The cookie carries the token; the record keeps its digest, exactly as an invite does. */
  tokenHash: string;
  userId: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/**
 * A personal access key: how a program that is not a browser reaches this server (docs/046).
 *
 * Shaped like a session rather than like an invite, because that is what it is — a long-lived credential for
 * one account — but it is deliberately NOT a session: it has no cookie, no sliding expiry, and it cannot open
 * the session channel. What it shares with both is that only the digest is stored, so a lost key is
 * regenerated rather than recovered.
 */
export interface AccessTokenRecord {
  id: string;
  /** The key is the credential; the record keeps its digest, exactly as an invite and a session do. */
  tokenHash: string;
  userId: string;
  /** What the author called it — "Blender on the studio PC" — so a listing says which machine to go and fix
   *  when one is revoked. */
  name: string;
  createdAt: string;
  /** Written at most once every few minutes, like a session's, so a listing can say "last used yesterday"
   *  without a record write per request. */
  lastUsedAt?: string;
  revokedAt?: string;
}

/** The one-time admin enrolment: minted at first run, printed to the log, refused everything else until it
 *  is redeemed. Only the digest is kept, so regenerating it is the only way to see one again. */
export interface BootstrapRecord {
  codeHash: string;
  createdAt: string;
  redeemedAt?: string;
  redeemedBy?: string;
}

export interface AccountsFile {
  schema: number;
  users: UserRecord[];
  invites: InviteRecord[];
  sessions: SessionRecord[];
  /** Personal access keys. Absent in a record written before they existed, which `normalize` reads as none. */
  tokens: AccessTokenRecord[];
  bootstrap: BootstrapRecord | null;
}

const ACCOUNTS_SCHEMA = 4;

/** Beside the workspace's projects rather than inside one, because it describes the server, not a map. */
export const accountsFile = (): string => join(workspaceConfig().workspaceRoot, 'accounts', 'accounts.json');

/** A record with only what it is known to hold: a workspace that has never had accounts, a file written by a
 *  future schema, and a truncated one all read as something the rest of this folder can work with. */
function normalizeEquipment(raw: unknown, createdAt: string): EquipmentRecord | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;
  const edgeColor = typeof source.edgeColor === 'string' ? source.edgeColor : '#20242c';
  const library = (value: unknown): EquipmentLibraryRecord => {
    if (!value || typeof value !== 'object') return { designs: [] };
    const candidate = value as Partial<EquipmentLibraryRecord>;
    const designs = Array.isArray(candidate.designs) ? candidate.designs.filter(design => design
      && typeof design.id === 'string' && typeof design.name === 'string' && !!design.texture) : [];
    const selectedId = typeof candidate.selectedId === 'string'
      && designs.some(design => design.id === candidate.selectedId) ? candidate.selectedId : designs[0]?.id;
    return { designs, ...(selectedId ? { selectedId } : {}) };
  };
  // Schema 2 already has libraries. A schema-1 account instead has one mutable image per gear; promote each
  // into a deterministic first design so an upgrade never makes a rider's existing artwork disappear.
  if (source.snowboard || source.skis) return {
    edgeColor, snowboard: library(source.snowboard), skis: library(source.skis),
  };
  const legacy = (texture: unknown, name: string): EquipmentLibraryRecord => {
    if (!texture || typeof texture !== 'object') return { designs: [] };
    const image = texture as AccountImage;
    const design: EquipmentDesignRecord = {
      id: `legacy-${image.version || 'artwork'}`, name, createdAt, texture: image,
    };
    return { selectedId: design.id, designs: [design] };
  };
  return {
    edgeColor,
    snowboard: legacy(source.snowboardTexture, 'My snowboard'),
    skis: legacy(source.skiTexture, 'My skis'),
  };
}

function normalize(stored: Partial<AccountsFile> | null): AccountsFile {
  const users = (Array.isArray(stored?.users) ? stored.users : []).map(storedUser => {
    const user = {
      ...storedUser,
      bio: typeof storedUser.bio === 'string' ? storedUser.bio : '',
      availability: isManualAvailability(storedUser.availability) ? storedUser.availability : 'available',
    };
    const equipment = normalizeEquipment((storedUser as UserRecord).equipment, storedUser.createdAt);
    if (equipment) user.equipment = equipment;
    else delete user.equipment;
    return user;
  });
  return {
    schema: ACCOUNTS_SCHEMA,
    users,
    invites: Array.isArray(stored?.invites) ? stored.invites : [],
    sessions: Array.isArray(stored?.sessions) ? stored.sessions : [],
    tokens: Array.isArray(stored?.tokens) ? stored.tokens : [],
    bootstrap: stored?.bootstrap ?? null,
  };
}

/** The parsed record, with the stamp it was parsed at. A miss is one `stat`, which is what every request
 *  after the first one costs. */
let cached: { file: string; stamp: string | null; data: AccountsFile } | null = null;

/** Drop the memo — for a test that has just pointed the workspace somewhere else. */
export function forgetAccounts(): void { cached = null; }

export async function readAccounts(): Promise<AccountsFile> {
  const file = accountsFile();
  const stamp = await fileStamp(file);
  if (cached && cached.file === file && cached.stamp === stamp) return cached.data;
  const data = normalize(await readJsonOr<Partial<AccountsFile> | null>(file, null));
  cached = { file, stamp, data };
  return data;
}

/**
 * Read, change and write the record as one indivisible step.
 *
 * Everything here is a read-modify-write over one file, so without the queue two redemptions could both
 * accept the same unused invite — or a sign-in racing a password change could write a session against a
 * password that is no longer there. The draft is a copy, so work that throws leaves the memo holding what is
 * actually on disk.
 */
export async function updateAccounts<T>(work: (draft: AccountsFile) => T | Promise<T>): Promise<T> {
  const file = accountsFile();
  return serialize(`accounts:${file}`, async () => {
    const draft = structuredClone(await readAccounts());
    const result = await work(draft);
    await writeJsonAtomic(file, draft);
    cached = { file, stamp: await fileStamp(file), data: draft };
    return result;
  });
}

/** A credential the server hands out once and never stores: 32 random bytes, urlsafe so it survives a URL,
 *  a chat message and a copy-paste unchanged. */
export const mintToken = (): string => randomBytes(32).toString('base64url');

/** Tokens are already 256 bits of randomness, so a plain digest is what the record keeps — the deliberately
 *  slow KDF in passwords.ts exists for secrets a person chose, which are guessable. */
export const tokenHash = (token: string): string =>
  createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');
