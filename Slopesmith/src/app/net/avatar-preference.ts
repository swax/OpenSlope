/**
 * Which character this person rides as, wherever they ride: the play page and the editor's test rides read and
 * write the same choice.
 *
 * A signed-in member's choice lives on their account (`POST /api/auth/avatar`), so it follows them across
 * devices and sign-ins; the session probe already carries it, so reading it costs no request. Everybody also
 * keeps it in this browser, which is the whole story for a visitor or a server without accounts, and a
 * fallback for a member while their account is unreachable.
 */
import { avatarId, randomAvatarId } from '../../core/characters/builtins';
import { adoptAccount, currentAccount, type Member } from './account';
import { postJson } from './fetch-json';

const KEY = 'slopesmith.avatar.v1';

function localAvatar(): string | null {
  try {
    return avatarId(localStorage.getItem(KEY));
  } catch {
    return null; // storage can be disabled
  }
}

function rememberLocally(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage can be disabled */
  }
}

/**
 * The rider to start as: the account's choice, else this browser's, else `fallback` (a choice saved before
 * avatars were shared), else one picked at random for a newcomer. Whatever is settled here is saved — to the
 * account too, for a member — so the editor, the play page and the member's other devices all agree from then on.
 */
export async function preferredAvatar(fallback?: string | null): Promise<string> {
  const account = await currentAccount();
  const fromAccount = 'user' in account ? avatarId(account.user.avatar) : null;
  if (fromAccount) return fromAccount;
  const chosen = localAvatar() ?? avatarId(fallback) ?? randomAvatarId();
  void saveAvatar(chosen).catch(() => {}); // best effort: the browser copy is already kept
  return chosen;
}

/**
 * Remember a new choice here and, for a signed-in member, on their account. Resolves once the account has it;
 * rejects with the server's message when it refused (the browser copy is kept either way).
 */
export async function saveAvatar(id: string): Promise<void> {
  const avatar = avatarId(id);
  if (!avatar) return;
  rememberLocally(avatar);
  const account = await currentAccount();
  if (!('user' in account) || account.user.avatar === avatar) return;
  const answer = await postJson<{ user?: Member }>('/api/auth/avatar', JSON.stringify({ avatar }));
  if (answer.user) adoptAccount(answer.user);
}
