import { adoptAccount, currentAccount, type Member } from '../../net/account';
import { postJson } from '../../net/fetch-json';
import { deviceLabel, setDeviceLabel } from '../../state/project-sync';
import { infoBadge } from '../components/info';
import { toast } from '../components/toast';
import { tooltip } from '../components/tooltip';
import { blobDataUrl, encodeCanvas } from './settings-dialog-image';
import { MIN_PASSWORD_LENGTH } from '../../../core/accounts/password-policy';

const PROFILE_PICTURE_HELP = 'Your username and picture are shown throughout this server. The browser crops the centre '
  + 'to a 256-pixel square before upload; Slopesmith stores that small copy with your account so every member '
  + 'sees the same picture. Choose JPG, PNG, WebP or GIF. Save commits the change; Close discards it.';

export interface ProfileSaveResult {
  username: boolean;
  bio: boolean;
  picture: 'saved' | 'removed' | null;
}

interface ProfileSection {
  el: HTMLDivElement;
  save: () => Promise<ProfileSaveResult>;
}

const profileInitials = (username: string): string => {
  const parts = username.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts[parts.length - 1][0]}`)
    .toLocaleUpperCase();
};

/** Decode whatever image format the browser accepts, centre-crop it and upload only the small derivative. */
async function prepareProfilePicture(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 12 * 1024 * 1024) throw new Error('Choose an image smaller than 12 MB.');
  const source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    if (!source.width || !source.height) throw new Error('That image has no usable pixels.');
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot crop images.');
    context.fillStyle = '#172d40';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.max(canvas.width / source.width, canvas.height / source.height);
    const width = source.width * scale;
    const height = source.height * scale;
    context.drawImage(source, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    let encoded = await encodeCanvas(canvas, 'image/webp', 0.86);
    // A pathological noisy crop can defeat WebP compression. JPEG is the bounded fallback the server accepts.
    if (encoded.size > 240 * 1024) encoded = await encodeCanvas(canvas, 'image/jpeg', 0.8);
    if (encoded.size > 256 * 1024) throw new Error('That picture could not be compressed below 256 KB.');
    return await blobDataUrl(encoded);
  } finally {
    source.close();
  }
}

/** Staged public profile edits. The private invitation handle is moderator-owned and never appears here. */
export function buildProfileSection(): ProfileSection {
  const sec = document.createElement('div');
  sec.className = 'sec profile-picture';
  const title = document.createElement('h3');
  title.textContent = 'Profile';
  title.appendChild(infoBadge(PROFILE_PICTURE_HELP));

  const usernameRow = document.createElement('div');
  usernameRow.className = 'profile-username';
  const usernameHead = document.createElement('div');
  usernameHead.className = 'rowhead';
  const usernameLabel = document.createElement('label');
  usernameLabel.textContent = 'Username';
  const username = document.createElement('input');
  username.type = 'text';
  username.autocomplete = 'username';
  username.disabled = true;
  usernameHead.appendChild(usernameLabel);
  usernameRow.append(usernameHead, username);

  const bioRow = document.createElement('div');
  bioRow.className = 'profile-bio';
  const bioHead = document.createElement('div');
  bioHead.className = 'rowhead';
  const bioLabel = document.createElement('label');
  bioLabel.textContent = 'Bio';
  bioLabel.htmlFor = 'sp-settings-profile-bio';
  const bioCount = document.createElement('span');
  bioCount.className = 'profile-bio-count';
  const bio = document.createElement('textarea');
  bio.id = 'sp-settings-profile-bio';
  bio.maxLength = 500;
  bio.rows = 4;
  bio.placeholder = 'Tell people a little about yourself…';
  bio.disabled = true;
  bioHead.append(bioLabel, bioCount);
  bioRow.append(bioHead, bio);
  const paintBioCount = () => { bioCount.textContent = `${bio.value.length}/500`; };
  bio.oninput = paintBioCount;
  paintBioCount();

  const row = document.createElement('div');
  row.className = 'profile-picture-row';
  const preview = document.createElement('div');
  preview.className = 'profile-picture-preview';
  preview.setAttribute('aria-label', 'Profile picture preview');
  const actions = document.createElement('div');
  actions.className = 'profile-picture-actions';
  const choose = document.createElement('button');
  choose.type = 'button';
  choose.className = 'sp-btn';
  choose.textContent = 'Choose image…';
  choose.disabled = true;
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'sp-btn';
  remove.textContent = 'Remove';
  remove.disabled = true;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/jpeg,image/png,image/webp,image/gif';
  actions.append(choose, remove, input);
  row.append(preview, actions);
  const state = document.createElement('div');
  state.className = 'state';
  state.textContent = 'Reading your account…';
  sec.append(title, usernameRow, bioRow, row, state);

  let member: Member | null = null;
  let initialUsername = '';
  let initialBio = '';
  let currentUrl: string | undefined;
  let staged: string | null | undefined;
  let dirty = false;
  let preparing: Promise<void> | null = null;

  const showPreview = (url?: string) => {
    preview.replaceChildren(document.createTextNode(profileInitials(member?.username ?? '?')));
    if (!url) return;
    const image = document.createElement('img');
    image.alt = '';
    image.src = url;
    image.onerror = () => image.remove();
    preview.appendChild(image);
  };
  const setState = (message: string, tone: '' | 'set' | 'warn' = '') => {
    state.className = `state${tone ? ` ${tone}` : ''}`;
    state.textContent = message;
  };

  choose.onclick = () => input.click();
  input.onchange = () => {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    choose.disabled = true;
    setState('Cropping and compressing…');
    preparing = prepareProfilePicture(file).then(dataUrl => {
      staged = dataUrl;
      dirty = true;
      showPreview(dataUrl);
      remove.disabled = false;
      setState('New picture ready — Save to use it.', 'set');
    }).catch(error => {
      setState(error instanceof Error ? error.message : String(error), 'warn');
    }).finally(() => {
      choose.disabled = !member;
      preparing = null;
    });
  };
  remove.onclick = () => {
    staged = null;
    dirty = true;
    showPreview();
    remove.disabled = true;
    setState('Picture will be removed when you Save.');
  };

  void currentAccount().then(account => {
    if (!('user' in account)) {
      setState('This Slopesmith has no accounts, so it has no shared user profile.');
      return;
    }
    member = account.user;
    initialUsername = member.username;
    username.value = member.username;
    username.disabled = false;
    initialBio = member.bio;
    bio.value = member.bio;
    bio.disabled = false;
    paintBioCount();
    currentUrl = member.profilePictureUrl;
    choose.disabled = false;
    remove.disabled = !currentUrl;
    showPreview(currentUrl);
    setState(currentUrl ? 'Your current server profile picture.' : 'No picture yet — your initials are shown.');
  });

  return {
    el: sec,
    save: async () => {
      if (preparing) await preparing;
      if (!member) return { username: false, bio: false, picture: null };
      let usernameChanged = false;
      let bioChanged = false;
      if (username.value.trim().toLowerCase() !== initialUsername) {
        const answer = await postJson<{ user: Member }>('/api/auth/username',
          JSON.stringify({ username: username.value }));
        member = answer.user;
        initialUsername = answer.user.username;
        username.value = answer.user.username;
        adoptAccount(answer.user);
        usernameChanged = true;
      }
      if (bio.value !== initialBio) {
        const answer = await postJson<{ user: Member }>('/api/auth/bio', JSON.stringify({ bio: bio.value }));
        member = answer.user;
        initialBio = answer.user.bio;
        bio.value = answer.user.bio;
        paintBioCount();
        adoptAccount(answer.user);
        bioChanged = true;
      }
      if (!dirty) return { username: usernameChanged, bio: bioChanged, picture: null };
      const removed = staged === null;
      const answer = await postJson<{ user: Member }>('/api/auth/profile-picture',
        JSON.stringify({ profilePicture: staged }));
      member = answer.user;
      adoptAccount(answer.user);
      currentUrl = answer.user.profilePictureUrl;
      staged = undefined;
      dirty = false;
      showPreview(currentUrl);
      return { username: usernameChanged, bio: bioChanged, picture: removed ? 'removed' : 'saved' };
    },
  };
}

interface DeviceSection {
  el: HTMLDivElement;
  save: () => string | null;
}

/** Browser-profile name carried by live presence, staged with the rest of Settings. */
export function buildDeviceSection(): DeviceSection {
  const sec = document.createElement('div');
  sec.className = 'sec account-device';
  const title = document.createElement('h3');
  title.textContent = 'This device';
  const row = document.createElement('div');
  row.className = 'keyrow';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 32;
  input.value = deviceLabel;
  input.placeholder = 'computer';
  input.setAttribute('aria-label', 'This device name');
  const state = document.createElement('div');
  state.className = 'state';
  state.textContent = 'Shown in profiles and after your username when this account is open on multiple devices.';
  row.appendChild(input);
  sec.append(title, row, state);
  let savedLabel = deviceLabel;
  return {
    el: sec,
    save: () => {
      if (input.value.trim() === savedLabel) return null;
      const named = setDeviceLabel(input.value);
      input.value = named;
      if (named === savedLabel) return null;
      savedLabel = named;
      return named;
    },
  };
}

/** Credential actions are immediate by design: changing a password must report its own validation result. */
export function buildAccountSecuritySection(): HTMLDivElement {
  const sec = document.createElement('div');
  sec.className = 'sec account-security';
  const title = document.createElement('h3');
  title.textContent = 'Password & sessions';
  const grid = document.createElement('div');
  grid.className = 'account-password-grid';
  const field = (labelText: string, autocomplete: 'current-password' | 'new-password'): HTMLInputElement => {
    const label = document.createElement('label');
    label.appendChild(document.createTextNode(labelText));
    const input = document.createElement('input');
    input.type = 'password';
    input.autocomplete = autocomplete;
    input.disabled = true;
    label.appendChild(input);
    grid.appendChild(label);
    return input;
  };
  const current = field('Current password', 'current-password');
  const next = field('New password', 'new-password');
  const repeat = field('Repeat new password', 'new-password');
  const actions = document.createElement('div');
  actions.className = 'account-password-actions';
  const change = document.createElement('button');
  change.type = 'button';
  change.className = 'sp-btn accent';
  change.textContent = 'Change password';
  change.disabled = true;
  const everywhere = document.createElement('button');
  everywhere.type = 'button';
  everywhere.className = 'sp-btn danger';
  everywhere.textContent = 'Sign out all devices';
  everywhere.disabled = true;
  tooltip(everywhere, 'End every session this account holds, including this browser.');
  actions.append(change, everywhere);
  const state = document.createElement('div');
  state.className = 'state';
  state.textContent = 'Reading your account…';
  sec.append(title, grid, actions, state);

  let available = false;
  const setState = (message: string, tone: '' | 'set' | 'warn' = '') => {
    state.className = `state${tone ? ` ${tone}` : ''}`;
    state.textContent = message;
  };
  void currentAccount().then(account => {
    if (!('user' in account)) {
      setState('This Slopesmith has no account password or sessions.');
      return;
    }
    available = true;
    current.disabled = false;
    next.disabled = false;
    repeat.disabled = false;
    change.disabled = false;
    everywhere.disabled = false;
    setState('Changing your password signs out every other device.');
  });

  change.onclick = () => void (async () => {
    if (next.value !== repeat.value) {
      setState('The two new passwords are different.', 'warn');
      return;
    }
    if (next.value.length < MIN_PASSWORD_LENGTH) {
      setState(`Use at least ${MIN_PASSWORD_LENGTH} characters for the new password.`, 'warn');
      return;
    }
    change.disabled = true;
    setState('Changing password…');
    try {
      const answer = await postJson<{ user: Member }>('/api/auth/password', JSON.stringify({
        current: current.value, next: next.value,
      }));
      adoptAccount(answer.user);
      current.value = '';
      next.value = '';
      repeat.value = '';
      setState('Password changed. Every other device was signed out.', 'set');
      toast('Password changed — every other device was signed out.', 'ok', 5000);
    } catch (error) {
      setState(error instanceof Error ? error.message : String(error), 'warn');
    } finally {
      change.disabled = !available;
    }
  })();

  everywhere.onclick = () => void (async () => {
    everywhere.disabled = true;
    setState('Signing out every device…');
    try {
      await postJson('/api/auth/logout-everywhere');
      location.reload();
    } catch (error) {
      everywhere.disabled = !available;
      setState(error instanceof Error ? error.message : String(error), 'warn');
    }
  })();
  return sec;
}
