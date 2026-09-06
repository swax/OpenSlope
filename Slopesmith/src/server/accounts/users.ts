import { createHash, randomUUID } from 'node:crypto';
import { loadImage } from '@napi-rs/canvas';
import { announceAccountAccessChanged, announceAccountProfileChanged } from './events';
import { assertUsablePassword, hashPassword } from './passwords';
import { holds, isOrdinaryRole, isRole, type Role } from './policy';
import { isManualAvailability } from '../../core/session/member-status';
import { readAccounts, updateAccounts, type AccountImage, type AccountsFile, type EquipmentLibraryRecord,
  type EquipmentRecord, type UserRecord } from './store';
import type { PublicUser } from './public-user';

export type { PublicUser } from './public-user';

/**
 * The members of a server: create one, change what one is allowed to do, disable one, reset a password.
 *
 * A member is a username and a password, usable from any machine (docs/038) — there is no per-device
 * enrolment and nothing to carry between computers. What leaves this module never carries a password hash.
 */

/** 2–32 characters, starting on a letter or digit. Narrow on purpose: a username appears in a chat line, a
 *  presence list and a CLI argument, so it stays something all three can render without quoting. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export function normalizeUsername(raw: unknown): string {
  const username = String(raw ?? '').trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username))
    throw new Error('A username is 2–32 characters — letters, digits, dot, dash or underscore, starting on a letter or digit');
  return username;
}

/** A member as everything outside this module sees one. */
export type EquipmentGear = 'snowboard' | 'skis';

export interface EquipmentDesignSummary {
  id: string;
  name: string;
  createdAt: string;
  textureUrl: string;
}

export interface EquipmentProfile {
  edgeColor: string;
  snowboard: { selectedId?: string; designs: EquipmentDesignSummary[] };
  skis: { selectedId?: string; designs: EquipmentDesignSummary[] };
}

const selectedEquipmentDesign = (user: UserRecord, gear: EquipmentGear) => {
  const library = user.equipment?.[gear];
  return library?.designs.find(design => design.id === library.selectedId);
};

export const publicUser = (user: UserRecord): PublicUser => {
  const snowboard = selectedEquipmentDesign(user, 'snowboard');
  const skis = selectedEquipmentDesign(user, 'skis');
  return {
    id: user.id, username: user.username, bio: user.bio, role: user.role,
    createdAt: user.createdAt, lastSeenAt: user.lastSeenAt, availability: user.availability,
    disabled: !!user.disabledAt,
    ...(user.profilePicture ? {
      profilePictureUrl: `/api/members/${encodeURIComponent(user.username)}/profile-picture`
        + `?v=${encodeURIComponent(user.profilePicture.version)}`,
    } : {}),
    ...(snowboard ? {
      snowboardTextureUrl: `/api/members/${encodeURIComponent(user.username)}/equipment-texture/snowboard`
        + `/${encodeURIComponent(snowboard.id)}?v=${encodeURIComponent(snowboard.texture.version)}`,
    } : {}),
    ...(skis ? {
      skiTextureUrl: `/api/members/${encodeURIComponent(user.username)}/equipment-texture/skis`
        + `/${encodeURIComponent(skis.id)}?v=${encodeURIComponent(skis.texture.version)}`,
    } : {}),
    ...(user.equipment?.edgeColor ? { equipmentEdgeColor: user.equipment.edgeColor } : {}),
  };
};

export const equipmentProfile = (user: UserRecord): EquipmentProfile => {
  const equipment = user.equipment ?? {
    edgeColor: '#20242c', snowboard: { designs: [] }, skis: { designs: [] },
  };
  const library = (gear: EquipmentGear) => ({
    ...(equipment[gear].selectedId ? { selectedId: equipment[gear].selectedId } : {}),
    designs: equipment[gear].designs.map(design => ({
      id: design.id, name: design.name, createdAt: design.createdAt,
      textureUrl: `/api/members/${encodeURIComponent(user.username)}/equipment-texture/${gear}`
        + `/${encodeURIComponent(design.id)}?v=${encodeURIComponent(design.texture.version)}`,
    })),
  });
  return { edgeColor: equipment.edgeColor, snowboard: library('snowboard'), skis: library('skis') };
};

export const findUserRecord = (accounts: AccountsFile, username: string): UserRecord | undefined =>
  accounts.users.find(user => user.username === username);

export async function listUsers(): Promise<PublicUser[]> {
  return (await readAccounts()).users
    .slice()
    .sort((a, b) => a.username.localeCompare(b.username))
    .map(publicUser);
}

export interface NewUser {
  username: string;
  password: string;
  role: Role;
  inviteHandle: string;
}

const INVITE_HANDLE_MAX = 128;

/** A private moderator note, deliberately broader than a username so it can carry a source prefix. */
export function normalizeInviteHandle(raw: unknown): string {
  // eslint-disable-next-line no-control-regex -- strips control characters from a moderator-typed handle
  const handle = String(raw ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!handle) throw new Error('Enter an invite handle, such as discord:joe123 or email:joe@example.com');
  if (handle.length > INVITE_HANDLE_MAX)
    throw new Error(`An invite handle is at most ${INVITE_HANDLE_MAX} characters`);
  return handle;
}

/** The caller attached to an in-editor account change. CLI changes omit this and remain the recovery path. */
export type AccountAdministrator = Pick<PublicUser, 'username' | 'role'>;

/** A permission refusal is distinct from malformed input, so the HTTP surface can answer 403 rather than
 *  making a moderator's forbidden action look like a bad request. */
export class AccountAdministrationError extends Error {}

function assertMayManageOrdinary(actor: AccountAdministrator | undefined, target: UserRecord,
  nextRole?: Role): void {
  if (!actor || actor.role === 'admin') return;
  if (actor.role !== 'moderator')
    throw new AccountAdministrationError('Only a moderator or admin may manage another account.');
  if (!isOrdinaryRole(target.role))
    throw new AccountAdministrationError('Moderators cannot manage moderator or admin accounts.');
  if (nextRole && !isOrdinaryRole(nextRole))
    throw new AccountAdministrationError('Moderators may assign only the viewer or editor role.');
}

/** Build the record without touching the store, for the two paths that create a user inside a larger change
 *  — redeeming an invite, and redeeming the admin-enrolment code. Hashing happens before the caller takes
 *  the queue, because scrypt is deliberately slow and holding a lock across it stalls every other writer. */
export async function draftUser(input: NewUser): Promise<UserRecord> {
  const username = normalizeUsername(input.username);
  assertUsablePassword(input.password);
  if (!isRole(input.role)) throw new Error(`Unknown role: ${String(input.role)}`);
  const inviteHandle = normalizeInviteHandle(input.inviteHandle);
  const now = new Date().toISOString();
  return {
    id: randomUUID(), username, bio: '', inviteHandle, role: input.role, availability: 'available',
    password: await hashPassword(input.password), createdAt: now, lastSeenAt: now, passwordChangedAt: now,
  };
}

/** Refuse a username already spoken for. Callers hold the accounts queue, which is what makes the check and
 *  the insert that follows it one step. */
export function claimUsername(draft: AccountsFile, username: string): void {
  if (findUserRecord(draft, username)) throw new Error(`That username is taken: ${username}`);
}

export async function addUser(input: NewUser): Promise<PublicUser> {
  const user = await draftUser(input);
  return updateAccounts(draft => {
    claimUsername(draft, user.username);
    draft.users.push(user);
    return publicUser(user);
  });
}

/** Change the signed-in member's public name without changing their stable UUID or ending their sessions. */
export async function setUserUsername(currentUsername: string, nextUsername: unknown): Promise<PublicUser> {
  const current = normalizeUsername(currentUsername);
  const next = normalizeUsername(nextUsername);
  const changed = await updateAccounts(draft => {
    const user = mustFind(draft, current);
    if (next !== current) {
      claimUsername(draft, next);
      user.username = next;
    }
    return publicUser(user);
  });
  announceAccountProfileChanged(changed);
  return changed;
}

const BIO_MAX = 500;

/** Public, member-authored profile text. Preserve intentional line breaks while stripping control bytes. */
export function normalizeBio(raw: unknown): string {
  if (typeof raw !== 'string') throw new Error('Bio must be text.');
  // eslint-disable-next-line no-control-regex -- strips control bytes from member-authored text, keeping newlines
  const bio = raw.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (bio.length > BIO_MAX) throw new Error(`A bio is at most ${BIO_MAX} characters.`);
  return bio;
}

/** Change the signed-in member's optional public bio without disturbing their stable identity or sessions. */
export async function setUserBio(username: string, value: unknown): Promise<PublicUser> {
  const name = normalizeUsername(username);
  const bio = normalizeBio(value);
  const changed = await updateAccounts(draft => {
    const user = mustFind(draft, name);
    user.bio = bio;
    return publicUser(user);
  });
  announceAccountProfileChanged(changed);
  return changed;
}

/** Set the signed-in member's durable manual availability. Idle is per-tab and never accepted here. */
export async function setUserAvailability(username: string, value: unknown): Promise<PublicUser> {
  const name = normalizeUsername(username);
  if (!isManualAvailability(value)) throw new Error('Status must be Available, Away, or Do Not Disturb.');
  const changed = await updateAccounts(draft => {
    const user = mustFind(draft, name);
    user.availability = value;
    return publicUser(user);
  });
  announceAccountProfileChanged(changed);
  return changed;
}

/** Change private invitation provenance. This note is moderator-owned even when the target has a senior role. */
export async function setUserInviteHandle(username: string, value: unknown,
  actor?: AccountAdministrator): Promise<PublicUser> {
  const name = normalizeUsername(username);
  const handle = normalizeInviteHandle(value);
  const changed = await updateAccounts(draft => {
    const user = mustFind(draft, name);
    if (actor && !holds(actor.role, 'moderator'))
      throw new AccountAdministrationError('Only a moderator or admin may change an invite handle.');
    user.inviteHandle = handle;
    return publicUser(user);
  });
  announceAccountProfileChanged(changed);
  return changed;
}

/**
 * Change what a member may do.
 *
 * Sessions are server-side and opaque, so this is in force on that member's very next request rather than
 * whenever a token they are already holding happens to expire (docs/038).
 */
export async function setUserRole(username: string, role: Role,
  actor?: AccountAdministrator): Promise<PublicUser> {
  if (!isRole(role)) throw new Error(`Unknown role: ${String(role)}`);
  const name = normalizeUsername(username);
  const changed = await updateAccounts(draft => {
    const user = mustFind(draft, name);
    // This check shares the accounts write with the mutation. A target promoted by a racing admin cannot be
    // demoted again by a moderator who authorized against an older read of the roster.
    assertMayManageOrdinary(actor, user, role);
    user.role = role;
    return publicUser(user);
  });
  announceAccountAccessChanged({ kind: 'role-changed', user: changed });
  return changed;
}

/** Disabling takes the account's sessions AND its access keys with it, so it is a sign-out everywhere rather
 *  than a note that applies at the next sign-in. `resolveAccessToken` already refuses a disabled user, so the
 *  revocation is belt and braces — but it also means re-enabling somebody does not silently bring a key on a
 *  machine they no longer have back to life, which is the half a liveness check alone would miss. */
export async function setUserDisabled(username: string, disabled: boolean,
  actor?: AccountAdministrator): Promise<PublicUser> {
  const name = normalizeUsername(username);
  const changed = await updateAccounts(draft => {
    const user = mustFind(draft, name);
    assertMayManageOrdinary(actor, user);
    if (disabled) {
      user.disabledAt = new Date().toISOString();
      draft.sessions = draft.sessions.filter(session => session.userId !== user.id);
      const at = new Date().toISOString();
      for (const token of draft.tokens) if (token.userId === user.id && !token.revokedAt) token.revokedAt = at;
    } else delete user.disabledAt;
    return publicUser(user);
  });
  if (disabled) announceAccountAccessChanged({ kind: 'user-revoked', userId: changed.id });
  return changed;
}

/**
 * A reset, or a member changing their own — both end every session the account has, because a password that
 * has just changed should not leave a browser somewhere still signed in on the old one.
 *
 * Access keys deliberately SURVIVE a password change. A key is an independent credential, not something
 * derived from the password, and revoking them here would mean every rotation silently breaks the Blender
 * install on every machine the author uses — which is a good way to teach people not to rotate. They are
 * listed and revocable on their own in Settings, which is where "I think this leaked" belongs. Disabling the
 * account, which is the response to an actual compromise, does take them.
 */
export async function setUserPassword(username: string, password: string): Promise<PublicUser> {
  const name = normalizeUsername(username);
  assertUsablePassword(password);
  const hash = await hashPassword(password);
  const changed = await updateAccounts(draft => {
    const user = mustFind(draft, name);
    user.password = hash;
    user.passwordChangedAt = new Date().toISOString();
    draft.sessions = draft.sessions.filter(session => session.userId !== user.id);
    return publicUser(user);
  });
  announceAccountAccessChanged({ kind: 'user-revoked', userId: changed.id });
  return changed;
}

const PROFILE_PICTURE_BYTES = 256 * 1024;
const PROFILE_PICTURE_DATA = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const EQUIPMENT_TEXTURE_BYTES = 1024 * 1024;
const EQUIPMENT_EDGE_COLOR = /^#[0-9a-f]{6}$/i;

function validPictureSignature(mimeType: string, bytes: Buffer): boolean {
  if (mimeType === 'image/jpeg') return bytes.length >= 3
    && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP';
}

/** Set or clear one member's own picture. The browser normally sends a 256px crop; validation here keeps a
 *  scripted caller from storing an arbitrary or unbounded blob in the accounts record. */
export async function setUserProfilePicture(username: string, value: unknown): Promise<PublicUser> {
  const name = normalizeUsername(username);
  let picture: UserRecord['profilePicture'];
  if (value !== null && value !== '') {
    if (typeof value !== 'string') throw new Error('Choose a JPG, PNG or WebP image.');
    const match = PROFILE_PICTURE_DATA.exec(value);
    if (!match) throw new Error('Choose a JPG, PNG or WebP image.');
    const bytes = Buffer.from(match[2], 'base64');
    if (!bytes.length || bytes.length > PROFILE_PICTURE_BYTES)
      throw new Error('That profile picture is too large. Choose an image under 256 KB.');
    if (!validPictureSignature(match[1], bytes)) throw new Error('That profile picture file is invalid.');
    picture = {
      mimeType: match[1] as NonNullable<UserRecord['profilePicture']>['mimeType'],
      data: bytes.toString('base64'),
      version: createHash('sha256').update(bytes).digest('base64url').slice(0, 16),
    };
  }
  const changed = await updateAccounts(draft => {
    const user = mustFind(draft, name);
    if (picture) user.profilePicture = picture;
    else delete user.profilePicture;
    return publicUser(user);
  });
  announceAccountProfileChanged(changed);
  return changed;
}

function accountImage(value: unknown, label: string, maxBytes: number): AccountImage | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`Choose a JPG, PNG or WebP ${label}.`);
  const match = PROFILE_PICTURE_DATA.exec(value);
  if (!match) throw new Error(`Choose a JPG, PNG or WebP ${label}.`);
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > maxBytes)
    throw new Error(`That ${label} is too large. Choose an image under ${Math.floor(maxBytes / 1024)} KB.`);
  if (!validPictureSignature(match[1], bytes)) throw new Error(`That ${label} file is invalid.`);
  return {
    mimeType: match[1] as AccountImage['mimeType'],
    data: bytes.toString('base64'),
    version: createHash('sha256').update(bytes).digest('base64url').slice(0, 16),
  };
}

async function equipmentImage(value: unknown, label: string): Promise<AccountImage | null> {
  const picture = accountImage(value, label, EQUIPMENT_TEXTURE_BYTES);
  if (!picture) return null;
  const image = await loadImage(Buffer.from(picture.data, 'base64'))
    .catch(() => { throw new Error(`That ${label} file is invalid.`); });
  if (image.width !== image.height)
    throw new Error(`Equipment art must be square; that ${label} is ${image.width}×${image.height}.`);
  if (image.width > 4096) throw new Error(`That ${label} is too large. Use a square image up to 4096×4096.`);
  return picture;
}

export interface EquipmentLibraryPatch {
  create?: unknown;
  update?: unknown;
  selectedId?: unknown;
  deleteIds?: unknown;
}

export interface EquipmentProfilePatch {
  snowboard?: unknown;
  skis?: unknown;
  edgeColor?: unknown;
}

interface PreparedEquipmentPatch {
  create?: { name: string; texture: AccountImage };
  update?: { id: string; name: string; texture: AccountImage };
  selectedId?: string | null;
  deleteIds: string[];
}

const EQUIPMENT_DESIGN_NAME_MAX = 40;
const EQUIPMENT_DESIGNS_MAX = 12;

async function prepareEquipmentLibraryPatch(value: unknown, label: string): Promise<PreparedEquipmentPatch | undefined> {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error(`Choose ${label} artwork settings to save.`);
  const patch = value as EquipmentLibraryPatch;
  let selectedId: string | null | undefined;
  if (patch.selectedId !== undefined) {
    if (patch.selectedId !== null && typeof patch.selectedId !== 'string')
      throw new Error(`Choose a saved ${label} design.`);
    selectedId = patch.selectedId === null ? null : patch.selectedId.trim();
    if (selectedId === '') selectedId = null;
  }
  let deleteIds: string[] = [];
  if (patch.deleteIds !== undefined) {
    if (!Array.isArray(patch.deleteIds) || patch.deleteIds.some(id => typeof id !== 'string'))
      throw new Error(`Choose valid ${label} designs to delete.`);
    deleteIds = [...new Set(patch.deleteIds.map(id => id.trim()).filter(Boolean))];
  }
  let create: PreparedEquipmentPatch['create'];
  if (patch.create !== undefined) {
    if (!patch.create || typeof patch.create !== 'object') throw new Error(`Name the new ${label} design.`);
    const raw = patch.create as { name?: unknown; texture?: unknown };
    const designName = String(raw.name ?? '').trim();
    if (!designName) throw new Error(`Name the new ${label} design.`);
    if (designName.length > EQUIPMENT_DESIGN_NAME_MAX)
      throw new Error(`${label[0].toUpperCase() + label.slice(1)} design names are at most ${EQUIPMENT_DESIGN_NAME_MAX} characters.`);
    const texture = await equipmentImage(raw.texture, `${label} texture`);
    if (!texture) throw new Error(`Load every ${label} artwork section before saving.`);
    create = { name: designName, texture };
  }
  let update: PreparedEquipmentPatch['update'];
  if (patch.update !== undefined) {
    if (!patch.update || typeof patch.update !== 'object') throw new Error(`Choose a saved ${label} design to edit.`);
    const raw = patch.update as { id?: unknown; name?: unknown; texture?: unknown };
    const id = String(raw.id ?? '').trim();
    if (!id) throw new Error(`Choose a saved ${label} design to edit.`);
    const designName = String(raw.name ?? '').trim();
    if (!designName) throw new Error(`Name the edited ${label} design.`);
    if (designName.length > EQUIPMENT_DESIGN_NAME_MAX)
      throw new Error(`${label[0].toUpperCase() + label.slice(1)} design names are at most ${EQUIPMENT_DESIGN_NAME_MAX} characters.`);
    const texture = await equipmentImage(raw.texture, `${label} texture`);
    if (!texture) throw new Error(`Load every ${label} artwork section before saving.`);
    update = { id, name: designName, texture };
  }
  return {
    ...(create ? { create } : {}), ...(update ? { update } : {}),
    ...(selectedId !== undefined ? { selectedId } : {}), deleteIds,
  };
}

/** Create or edit named designs, select one, and/or delete old designs in one account-file transaction. */
export async function setUserEquipment(username: string, patch: EquipmentProfilePatch): Promise<{
  user: PublicUser; equipment: EquipmentProfile;
}> {
  const name = normalizeUsername(username);
  if (!patch || typeof patch !== 'object') throw new Error('Choose equipment settings to save.');
  const [snowboard, skis] = await Promise.all([
    prepareEquipmentLibraryPatch(patch.snowboard, 'snowboard'),
    prepareEquipmentLibraryPatch(patch.skis, 'ski'),
  ]);
  let edgeColor: string | undefined;
  if (patch.edgeColor !== undefined) {
    edgeColor = String(patch.edgeColor).trim().toLowerCase();
    if (!EQUIPMENT_EDGE_COLOR.test(edgeColor)) throw new Error('Choose a six-digit equipment edge colour.');
  }
  const changed = await updateAccounts(draft => {
    const user = mustFind(draft, name);
    const equipment: EquipmentRecord = user.equipment ?? {
      edgeColor: '#20242c', snowboard: { designs: [] }, skis: { designs: [] },
    };
    const apply = (library: EquipmentLibraryRecord, prepared: PreparedEquipmentPatch | undefined,
      label: string) => {
      if (!prepared) return;
      for (const id of prepared.deleteIds) {
        if (!library.designs.some(design => design.id === id)) throw new Error(`No such saved ${label} design.`);
      }
      const deleted = new Set(prepared.deleteIds);
      library.designs = library.designs.filter(design => !deleted.has(design.id));
      if (prepared.update) {
        const design = library.designs.find(candidate => candidate.id === prepared.update!.id);
        if (!design) throw new Error(`No such saved ${label} design.`);
        if (library.designs.some(candidate => candidate.id !== design.id
          && candidate.name.toLocaleLowerCase() === prepared.update!.name.toLocaleLowerCase()))
          throw new Error(`A saved ${label} design already has that name.`);
        design.name = prepared.update.name;
        design.texture = prepared.update.texture;
      }
      if (prepared.create) {
        if (library.designs.length >= EQUIPMENT_DESIGNS_MAX)
          throw new Error(`Keep at most ${EQUIPMENT_DESIGNS_MAX} saved ${label} designs; delete one before adding another.`);
        if (library.designs.some(design => design.name.toLocaleLowerCase() === prepared.create!.name.toLocaleLowerCase()))
          throw new Error(`A saved ${label} design already has that name.`);
        const design = {
          id: randomUUID(), name: prepared.create.name, createdAt: new Date().toISOString(),
          texture: prepared.create.texture,
        };
        library.designs.push(design);
        library.selectedId = design.id;
      }
      if (prepared.selectedId !== undefined) {
        if (prepared.selectedId !== null
          && !library.designs.some(design => design.id === prepared.selectedId))
          throw new Error(`No such saved ${label} design.`);
        if (prepared.selectedId) library.selectedId = prepared.selectedId;
        else delete library.selectedId;
      } else if (library.selectedId && !library.designs.some(design => design.id === library.selectedId)) {
        library.selectedId = library.designs[0]?.id;
        if (!library.selectedId) delete library.selectedId;
      }
    };
    apply(equipment.snowboard, snowboard, 'snowboard');
    apply(equipment.skis, skis, 'ski');
    if (edgeColor !== undefined) equipment.edgeColor = edgeColor;
    user.equipment = equipment;
    return { user: publicUser(user), equipment: equipmentProfile(user) };
  });
  announceAccountProfileChanged(changed.user);
  return changed;
}

function mustFind(draft: AccountsFile, username: string): UserRecord {
  const user = findUserRecord(draft, username);
  if (!user) throw new Error(`No such user: ${username}`);
  return user;
}
