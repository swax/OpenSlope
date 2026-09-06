import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../../core/accounts/password-policy';

/**
 * Password hashing, with `node:crypto`'s own scrypt.
 *
 * The server holds nothing recoverable (docs/038): an admin can disable an account or force a reset, never
 * read a password. scrypt rather than argon2id because it is in the platform — a memory-hard KDF that needs
 * no dependency, no native build step and no supply chain, which for a tool people run from a clone is worth
 * more than the margin argon2id would add at these parameters.
 *
 * The cost is stored beside every hash, so raising it later re-hashes on next sign-in rather than locking
 * everyone out of the record they already have.
 */

interface ScryptCost { N: number; r: number; p: number }

/**
 * 2^15 rounds at r=8, p=1 — about 32 MB and a tenth of a second per attempt on an ordinary desktop.
 *
 * That is the knob that matters: it costs a person signing in nothing they notice, and it costs anyone who
 * has walked off with the file 32 MB of working memory per guess, which is what memory-hardness buys over a
 * fast digest a GPU runs billions of at once.
 */
const COST: ScryptCost = { N: 32_768, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;

/** scrypt refuses to allocate past `maxmem`, whose default (32 MB) sits just under what these parameters
 *  need. Derived from the cost actually in force so a hash written under a different one still verifies. */
const maxmem = (cost: ScryptCost): number => 256 * cost.N * cost.r;

export function assertUsablePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH)
    throw new Error(`A password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  if (password.length > MAX_PASSWORD_LENGTH)
    throw new Error(`A password must be at most ${MAX_PASSWORD_LENGTH} characters`);
}

function derive(password: string, salt: Buffer, cost: ScryptCost): Promise<Buffer> {
  return new Promise((ok, fail) => {
    // NFKC so a password typed on a keyboard that composes accents differently still matches the one enrolled.
    scrypt(password.normalize('NFKC'), salt, KEY_LENGTH, { ...cost, maxmem: maxmem(cost) },
      (error, key) => error ? fail(error) : ok(key));
  });
}

/** `scrypt$N$r$p$salt$hash`, base64 — the cost travels with the hash it produced. */
export async function hashPassword(password: string): Promise<string> {
  assertUsablePassword(password);
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Whether a password produces the stored hash.
 *
 * Compared in constant time, because a comparison that returns early on the first differing byte leaks how
 * much of a guess was right. A malformed or absent record is a false rather than a throw: a user row that
 * cannot be parsed must fail sign-in, not fail the request in a way that tells the caller the row exists.
 */
export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  if (typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false;
  const parts = (stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, N, r, p, salt, hash] = parts;
  const cost = { N: Number(N), r: Number(r), p: Number(p) };
  if (!Number.isInteger(cost.N) || !Number.isInteger(cost.r) || !Number.isInteger(cost.p)) return false;
  const expected = Buffer.from(hash, 'base64');
  if (expected.length !== KEY_LENGTH) return false;
  try {
    return timingSafeEqual(await derive(password, Buffer.from(salt, 'base64'), cost), expected);
  } catch { return false; }
}

/** A password the CLI hands out on a reset: 16 urlsafe characters, which nobody is expected to remember past
 *  the first sign-in that changes it. */
export const generatePassword = (): string => randomBytes(12).toString('base64url');
