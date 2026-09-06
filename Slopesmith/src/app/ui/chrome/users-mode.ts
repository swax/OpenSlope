import GUI from 'lil-gui';
import { clearGui, detail, note, tip } from '../components/gui';
import { modal } from '../components/modal';
import { askName, confirmAction } from '../components/prompts';
import { installStyles } from '../components/styles';
import { toast } from '../components/toast';
import { tooltip } from '../components/tooltip';
import { contextMenu, type MenuItem } from '../components/controls';
import { MEDIA_ICON, SCREEN_ICON_BODY, USERS_ICON, WATCHING_ICON, svg } from '../components/icons';
import { fetchJson, postJson } from '../../net/fetch-json';
import type { MemberRole } from '../../net/session-channel';
import type { ClientProject } from '../../state/project-sync';
import { youtubeVideoId } from '../../net/video-bridge';
import {
  emptyJukeboxState, jukeboxPosition, mayManageJukeboxEntry,
  type JukeboxEntry, type JukeboxState,
} from '../../../core/session/jukebox';
import type { VoiceChat, VoiceMemberState } from './voice-chat';
import type { ManualAvailability, MemberStatus } from '../../../core/session/member-status';
import { MIN_PASSWORD_LENGTH } from '../../../core/accounts/password-policy';

/**
 * Users mode: who is on this server, and — for whoever runs it — the administration that goes with that
 * (docs/038).
 *
 * It is its own mode, reached from a button beside the numbered mode row rather than inside it, because it is
 * about the server rather than about the map: it should not consume a mode number or a shortcut digit. The
 * right dock is already mode-owned, so the list simply takes the dock while the mode is active and the map
 * carries on underneath.
 *
 * The list is **every member of the server, not only the connected ones**, which is why it reads a roster
 * route rather than the presence table — presence only knows who is on a socket. Anybody online shows the map
 * they have open followed by its Reference mountain, when any. Clicking either opens the same authored map or
 * loads the same read-only reference here.
 *
 * The management panel lives in here rather than in a terminal because the person running a server is usually an
 * author rather than an administrator. The CLI remains the source of truth and still works when nothing can
 * connect; this is the same set of actions reached from a chair. Moderators get the deliberately narrow
 * account tools; privileged account actions remain behind the admin role.
 */

const CSS = `
.sp-users-comms { display: flex; flex-direction: column; gap: 6px; padding: 7px 8px;
  border-bottom: 1px solid #1c3043; }
.sp-users-comms .sp-voice { width: 100%; box-sizing: border-box; flex-wrap: wrap; }
.sp-users-chat { display: flex !important; align-items: center; gap: 7px; width: 100%; min-height: 31px;
  padding: 4px 8px !important; color: #dbe7f2; background: #14283a !important;
  border: 1px solid #315574 !important; border-radius: 5px; font: 11px/1.35 system-ui, sans-serif;
  text-align: left; cursor: pointer; }
.sp-users-chat:hover { color: #eef8ff; background: #1b3a53 !important; border-color: #4d83aa !important; }
.sp-users-chat:focus-visible { outline: 2px solid #78bce8; outline-offset: 1px; }
.sp-users-chat svg { flex: 0 0 auto; width: 14px; height: 14px; fill: none; stroke: currentColor;
  stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.sp-users-chat-key { margin-left: auto; color: #8da5b8; font: 9.5px/1 ui-monospace, Consolas, monospace; }
.sp-users-role-heading { padding: 8px 8px 4px; color: #7894aa; background: #0b1722;
  border-top: 1px solid #263b4e; font-size: 9px; font-weight: 800; letter-spacing: .09em;
  text-transform: uppercase; }
.sp-users-role-heading:first-child { border-top: 0; }
.sp-users-row { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; gap: 8px; align-items: center;
  padding: 5px 8px; border-bottom: 1px solid #1c3043; }
.sp-users-row:last-child { border-bottom: 0; }
.sp-users-actions { display: inline-flex; align-items: center; gap: 2px; }
.sp-users-view { appearance: none; display: grid !important; place-items: center;
  width: 24px !important; min-width: 24px !important; height: 24px !important; min-height: 24px !important;
  padding: 3px !important; color: #7dd7a3 !important; background: #153424 !important;
  border: 1px solid #397854 !important; border-radius: 5px !important; box-shadow: none !important; cursor: pointer; }
.sp-users-view:hover, .sp-users-view:focus-visible { color: #dfffea !important; background: #205039 !important;
  border-color: #68c88d !important; outline: 0; }
.sp-users-view svg { display: block; width: 15px; height: 15px; }
.sp-users-more { appearance: none; display: grid !important; place-items: center; align-self: center;
  width: 24px !important; min-width: 24px !important; height: 24px !important; min-height: 24px !important;
  padding: 0 !important; color: #91a9bc !important; background: transparent !important;
  border: 1px solid transparent !important; border-radius: 50% !important; box-shadow: none !important;
  font: 700 18px/1 system-ui, sans-serif; cursor: pointer; }
.sp-users-more:hover, .sp-users-more:focus-visible { color: #dcecf9 !important;
  background: #18334a !important; border-color: #315574 !important; outline: 0; }
.sp-users-avatar { position: relative; appearance: none; display: grid !important; place-items: center;
  flex: 0 0 30px; width: 30px !important; min-width: 30px !important; height: 30px !important;
  min-height: 30px !important; overflow: visible; box-sizing: border-box; padding: 0 !important;
  border: 1px solid #35516a !important; border-radius: 50% !important; box-shadow: none !important;
  color: #dcecf9 !important; background: linear-gradient(145deg, #294b67, #172d40) !important;
  font: 700 10px/1 system-ui, sans-serif; letter-spacing: .04em; cursor: pointer; }
.sp-users-avatar:hover, .sp-users-avatar:focus-visible { border-color: #78bce8 !important; outline: 0; }
.sp-users-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; border-radius: inherit;
  object-fit: cover; background: #172d40; }
.sp-users-dot { position: absolute; right: -2px; bottom: -2px; width: 9px; height: 9px;
  border: 2px solid #0d1924; border-radius: 50%; box-sizing: content-box; background: #33475a; }
.sp-users-row.status-online .sp-users-dot { background: #4fbf7a; box-shadow: 0 0 6px #4fbf7a88; }
.sp-users-row.status-idle .sp-users-dot { background: #d7b84f; box-shadow: 0 0 6px #d7b84f77; }
.sp-users-row.status-away .sp-users-dot { background: #df9148; box-shadow: 0 0 6px #df914877; }
.sp-users-row.status-dnd .sp-users-dot { background: #df6464; box-shadow: 0 0 6px #df646477; }
.sp-users-who { min-width: 0; }
.sp-users-name-line { display: flex; min-width: 0; align-items: center; gap: 5px; }
.sp-users-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  appearance: none; width: auto !important; min-height: 0 !important; height: auto !important; padding: 0 !important;
  color: #e6f0fa; background: transparent !important; border: 0 !important; border-radius: 0 !important;
  box-shadow: none !important; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; }
.sp-users-name:hover, .sp-users-name:focus-visible { color: #9ed6fa; text-decoration: underline; outline: 0; }
.sp-users-owner { flex: 0 0 auto; padding: 1px 4px; color: #ffd78c; background: #4a3518;
  border: 1px solid #785725; border-radius: 3px; font-size: 8.5px; font-weight: 800; letter-spacing: .06em;
  text-transform: uppercase; }
.sp-users-watching { flex: 0 0 auto; display: inline-grid; place-items: center; width: 15px; height: 15px;
  color: #76c9f4; filter: drop-shadow(0 0 3px #76c9f466); }
.sp-users-watching svg { width: 14px; height: 14px; }
.sp-users-row.disabled .sp-users-name { color: #7d8b98; text-decoration: line-through; }
.sp-users-sub { color: #8ba2b6; font-size: 10.5px; line-height: 1.35; }
.sp-users-voice-state { flex: 0 0 auto; display: inline-grid; place-items: center; width: 15px; height: 15px;
  color: #75bde8; }
.sp-users-voice-state:is(button) { width: 19px !important; min-height: 19px; height: 19px !important;
  padding: 2px !important; background: transparent !important; border: 1px solid transparent !important;
  border-radius: 4px; cursor: pointer; }
.sp-users-voice-state:is(button):hover { background: #18334a !important; border-color: #315574 !important; }
.sp-users-voice-state:is(button):focus-visible { outline: 2px solid #78bce8; outline-offset: 1px; }
.sp-users-voice-state svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.8;
  stroke-linecap: round; stroke-linejoin: round; }
.sp-users-voice-state .speaker, .sp-users-voice-state .speaker-muted { display: none; }
.sp-users-voice-state.speaking { color: #72db9d; filter: drop-shadow(0 0 3px #72db9d88); }
.sp-users-voice-state.speaking .mic { display: none; }
.sp-users-voice-state.speaking .speaker { display: block; }
.sp-users-voice-state .slash { display: none; }
.sp-users-voice-state.muted { color: #879bad; }
.sp-users-voice-state.muted .slash { display: block; }
.sp-users-voice-state.local-muted { color: #e6a19d; filter: none; }
.sp-users-voice-state.local-muted .mic, .sp-users-voice-state.local-muted .speaker { display: none; }
.sp-users-voice-state.local-muted .speaker-muted { display: block; }
.sp-users-map { display: inline !important; width: auto !important; min-height: 0; height: auto !important;
  padding: 0 !important; color: #7fc3ef; background: none !important; border: 0 !important;
  font: inherit; line-height: inherit; cursor: pointer; }
.sp-users-map:hover { color: #b8e2ff; text-decoration: underline; }
.sp-users-playing { display: inline-grid; width: 12px; height: 12px; margin-right: 3px; vertical-align: -2px;
  place-items: center; color: #62d98f; filter: drop-shadow(0 0 3px #62d98f66); }
.sp-users-playing svg { width: 12px; height: 12px; }
.sp-users-link { width: 100%; box-sizing: border-box; margin-top: 6px; padding: 7px 8px; color: #d9ecff;
  background: #0b1723; border: 1px solid #2c3e50; border-radius: 4px;
  font: 11px/1.4 ui-monospace, Consolas, monospace; }
.sp-user-profile { width: 390px; max-width: calc(100vw - 24px); box-sizing: border-box; padding: 15px;
  max-height: calc(100vh - 24px); overflow-y: auto;
  color: #d7e3f0; background: #0c141d; border: 1px solid #2c3e50; border-radius: 8px;
  font: 12px/1.45 system-ui, sans-serif; box-shadow: 0 12px 40px #0009; }
.sp-user-profile-head { display: flex; align-items: center; gap: 12px; padding-bottom: 12px;
  border-bottom: 1px solid #23364a; }
.sp-user-profile-avatar { position: relative; display: grid; place-items: center; flex: 0 0 auto; width: 68px;
  height: 68px; overflow: hidden; border: 1px solid #3c5a73; border-radius: 50%; color: #dcecf9;
  background: linear-gradient(145deg, #294b67, #172d40); font: 700 18px/1 system-ui, sans-serif; }
.sp-user-profile-avatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
  border-radius: 50%; }
.sp-user-profile h2 { margin: 0; color: #eef7ff; font: 650 18px/1.25 system-ui, sans-serif; }
.sp-user-profile-status { margin-top: 3px; color: #8fa8bd; font-size: 11px; }
.sp-user-profile-bio { margin: 12px 0 0; color: #c8d7e4; white-space: pre-wrap; overflow-wrap: anywhere; }
.sp-user-profile dl { display: grid; grid-template-columns: 82px minmax(0,1fr); gap: 7px 10px; margin: 13px 0; }
.sp-user-profile dt { color: #7890a5; }
.sp-user-profile dd { min-width: 0; margin: 0; color: #d7e3f0; overflow-wrap: anywhere; }
.sp-user-profile-private { margin-top: 12px; padding: 10px; border: 1px solid #5a4a2b; border-radius: 5px;
  background: #211b12; }
.sp-user-profile-private strong { display: block; margin-bottom: 3px; color: #e7c88a; font-size: 11px; }
.sp-user-profile-private p { margin: 0 0 7px; color: #a99570; font-size: 10.5px; }
.sp-user-profile-handle { display: flex; gap: 6px; }
.sp-user-profile-handle input { flex: 1 1 auto; min-width: 0; box-sizing: border-box; padding: 6px 7px;
  color: #e8dcc5; background: #130f0a; border: 1px solid #5a4a2b; border-radius: 4px;
  font: 11px/1.3 ui-monospace, Consolas, monospace; }
.sp-user-profile-handle button { flex: 0 0 auto; }
.sp-user-profile-admin { margin-top: 12px; padding-top: 12px; border-top: 1px solid #23364a; }
.sp-user-profile-admin > strong { display: block; color: #bcd3e6; font-size: 11px; }
.sp-user-profile-role-select { appearance: auto; width: auto; max-width: 100%; box-sizing: border-box;
  padding: 4px 7px; color: #dcecf9; background: #14283a; border: 1px solid #315574;
  border-radius: 4px; font: 700 10.5px/1.25 system-ui, sans-serif; text-transform: capitalize;
  cursor: pointer; }
.sp-user-profile-role-select:hover, .sp-user-profile-role-select:focus { border-color: #5b91b8; outline: 0; }
.sp-user-profile-account-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.sp-user-profile-account-actions .danger { color: #efaaa5; border-color: #70423f !important; }
.sp-user-profile-account-actions .danger:hover { color: #ffd2ce; background: #3b211f !important;
  border-color: #9a5651 !important; }
.sp-jukebox { padding: 7px 8px 8px; }
.sp-jukebox-power { display: flex; align-items: center; gap: 7px; }
.sp-jukebox-power-copy { min-width: 0; color: #8ba2b6; font-size: 10.5px; line-height: 1.25; }
.sp-jukebox-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 5px; align-items: center; }
.sp-jukebox-url { min-width: 0; width: 100%; box-sizing: border-box; padding: 6px 7px; color: #dbe7f2;
  background: #0b1723; border: 1px solid #2c3e50; border-radius: 4px;
  font: 10.5px/1.3 ui-monospace, Consolas, monospace; }
.sp-jukebox-url:focus { outline: 1px solid #5c91ba; border-color: #5c91ba; }
.sp-jukebox-btn { width: auto !important; min-height: 29px; height: 29px !important; padding: 4px 8px !important;
  display: inline-flex !important; align-items: center; justify-content: center; gap: 5px;
  color: #dbe7f2; background: #14283a !important; border: 1px solid #315574 !important;
  border-radius: 4px; font: 700 10.5px/1 system-ui, sans-serif; cursor: pointer; }
.sp-jukebox-btn svg { flex: 0 0 auto; width: 13px; height: 13px; }
.sp-jukebox-btn:hover { color: #fff; background: #1b3a53 !important; border-color: #4d83aa !important; }
.sp-jukebox-btn:disabled { color: #607487; background: #101d29 !important; border-color: #243b4e !important;
  cursor: default; }
.sp-jukebox-btn.power { min-width: 68px; }
.sp-jukebox-btn.power.on { color: #06140d; background: #72d99d !important; border-color: #8be9b1 !important; }
.sp-jukebox-btn.stop { color: #e8b3ae; }
.sp-jukebox-state { min-height: 14px; margin-top: 5px; color: #8ba2b6; font-size: 10.5px; line-height: 1.35; }
.sp-jukebox-state.ok { color: #72d99d; }
.sp-jukebox-state.warn { color: #e4b96d; }
.sp-jukebox-state.err { color: #efa29c; }
.sp-jukebox-info { appearance: none; display: inline-grid !important; place-items: center; width: 15px !important;
  min-width: 15px !important; height: 15px !important; min-height: 15px !important; margin-left: 5px;
  padding: 0 !important; vertical-align: -2px; color: currentColor !important; background: transparent !important;
  border: 1px solid currentColor !important; border-radius: 50% !important; box-shadow: none !important;
  font: 800 9px/1 system-ui, sans-serif !important; cursor: pointer; opacity: .85; }
.sp-jukebox-info:hover, .sp-jukebox-info:focus-visible { color: #f6d79b !important; opacity: 1; outline: 0; }
.sp-jukebox-player { width: 100%; aspect-ratio: 16/9; margin-top: 7px; overflow: hidden;
  background: #070d13; border: 1px solid #2c3e50; border-radius: 5px; }
.sp-jukebox-line { display: flex; align-items: center; gap: 6px; min-width: 0; color: #dceaf5;
  font-size: 10.5px; }
.sp-jukebox-owner { color: #79bde8; font-weight: 700; }
.sp-jukebox-link { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: #9db4c7; text-decoration: none; }
.sp-jukebox-link:hover { color: #cae9ff; text-decoration: underline; }
.sp-jukebox-line .sp-jukebox-btn { margin-left: auto; min-height: 23px; height: 23px !important; padding: 3px 6px !important; }
.sp-jukebox-seek { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 7px; align-items: center;
  margin-top: 7px; }
.sp-jukebox-seek input { width: 100%; accent-color: #4f9ac9; }
.sp-jukebox-time { color: #9bb0c1; font: 9.5px/1 ui-monospace, Consolas, monospace; }
.sp-jukebox-controls { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 5px; margin-top: 7px; }
.sp-jukebox-controls .sp-jukebox-btn { width: 100% !important; }
.sp-jukebox-volume { display: grid; grid-template-columns: auto minmax(0, 1fr) 31px; gap: 7px; align-items: center;
  margin-top: 6px; color: #8ba2b6; font-size: 10px; }
.sp-jukebox-volume input { width: 100%; accent-color: #4f9ac9; }
.sp-jukebox-volume output { text-align: right; font: 9.5px/1 ui-monospace, Consolas, monospace; }
.sp-jukebox-volume-icon { display: inline-grid; place-items: center; color: #9eb3c5; }
.sp-jukebox-volume-icon svg { width: 15px; height: 15px; }
.sp-jukebox-queue { display: grid; gap: 5px; margin-top: 8px; padding-top: 8px; border-top: 1px solid #263c50; }
.sp-jukebox-queue-title { color: #8299ac; font-size: 9.5px; font-weight: 700; letter-spacing: .07em;
  text-transform: uppercase; }
.sp-jukebox-queue-label { margin-top: 2px; color: #688096; font-size: 9px; font-weight: 700;
  letter-spacing: .06em; text-transform: uppercase; }
.sp-jukebox-empty { color: #8299ac; font-size: 10.5px; }
`;

/** One member as the roster route reports them: the account, plus what presence knows right now. */
interface RosterMember {
  id: string;
  username: string;
  bio: string;
  role: MemberRole;
  createdAt: string;
  lastSeenAt: string;
  availability: ManualAvailability;
  /** Present only in a roster returned to a moderator or admin. */
  inviteHandle?: string;
  disabled: boolean;
  profilePictureUrl?: string;
  online: boolean;
  status: MemberStatus;
  watching: boolean;
  sessions: number;
  devices: string[];
  maps: Array<{
    id: string; name: string; reference?: string; playing?: Array<'authored' | 'reference'>;
    /** Exact opt-in browser tab behind this map/reference pair. */
    sharingSessionId?: string;
  }>;
}

const initialsFor = (username: string): string => {
  const parts = username.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts.length === 1 ? parts[0].slice(0, 2) : `${parts[0][0]}${parts[parts.length - 1][0]}`)
    .toLocaleUpperCase();
};

const STATUS_LABELS: Record<MemberStatus, string> = {
  online: 'Online', idle: 'Idle', away: 'Away', dnd: 'Do Not Disturb', offline: 'Offline',
};

/** Tolerate one cached browser bundle briefly talking to a pre-status service during a rolling restart. */
const rosterStatus = (member: RosterMember): MemberStatus =>
  STATUS_LABELS[member.status] ? member.status : member.online ? 'online' : 'offline';

/** Voice may briefly outlive the roster socket during a reconnect; it still proves that member is connected. */
const displayedStatus = (member: RosterMember, inVoice: boolean): MemberStatus =>
  rosterStatus(member) === 'offline' && inVoice ? 'online' : rosterStatus(member);

interface Roster {
  accounts: 'open' | 'required';
  me: { id: string; username: string; role: MemberRole };
  /** Whether administration is this member's to see. The roster decides it; this panel only draws it. */
  admin: boolean;
  /** Admins and moderators may manage ordinary accounts. */
  moderator: boolean;
  members: RosterMember[];
}

export type JukeboxMessageTone = '' | 'ok' | 'warn' | 'err';

export interface JukeboxMessageInfo {
  title: string;
  body: string;
  actionLabel?: string;
  action?: () => void;
}

export interface UsersMode {
  active(): boolean;
  setActive(on: boolean): void;
  /** Re-read the roster. Cheap, and the natural answer to a presence push. */
  refresh(): void;
  /** Open the same profile card used by the roster for the signed-in member. */
  showMyProfile(): void;
  setJukebox(state: JukeboxState): void;
  setJukeboxMessage(message: string, tone?: JukeboxMessageTone, info?: JukeboxMessageInfo | null): void;
}

/** The invite token is handed back exactly once and is the credential until it is redeemed, so it is shown
 *  where it can be copied and said plainly that this is the only time it will be seen. */
function showInviteLink(token: string, role: MemberRole, days: number): void {
  const { host, close } = modal();
  const gui = new GUI({ container: host, title: 'Invite link' });
  const link = `${location.origin}/#invite=${encodeURIComponent(token)}`;
  note(gui, `One ${role} account, expiring in ${days} `
    + `day${days === 1 ? '' : 's'}. The link is the credential until it is redeemed and worthless afterwards, `
    + 'so send it the way you would send a password. This is the only time it is shown.');
  const field = document.createElement('input');
  field.className = 'sp-users-link';
  field.readOnly = true;
  field.value = link;
  gui.$children.appendChild(field);
  field.focus();
  field.select();
  gui.add({
    copy: () => {
      field.select();
      void navigator.clipboard?.writeText(link)
        .then(() => toast('Invite link copied.', 'ok'))
        .catch(() => toast('Copy it from the field — this browser refused the clipboard.', 'warn'));
    },
  }, 'copy').name('Copy the link');
  gui.add({ done: close }, 'done').name('Done');
}

export function createUsersMode(deps: {
  /** Open a map, the same way the File menu does — which is what clicking somebody's map name means. */
  openProject: (id: string) => Promise<boolean>;
  /** Load an extracted mountain into this tab's Reference slot. */
  openReference: (level: string) => void;
  /** Reveal and focus the one existing lower-left server chat. */
  openChat: (prefill?: string) => void;
  /** Seat the editor camera in front of one live avatar on the currently open map. */
  goToPlayer: (userId: string) => boolean;
  /** Browser-tab-local sharing state, transported by the authenticated session channel. */
  screenSharing: () => boolean;
  setScreenSharing: (enabled: boolean) => void;
  observeScreen: (sessionId: string, username: string) => void;
  /** The map underneath this server-wide dock; its manifest carries owner and editing policy. */
  currentProject: () => ClientProject | null;
  /** Null opens editing to every editor; an array is the explicit stable-id allow-list. */
  setProjectEditors: (editorIds: string[] | null) => Promise<ClientProject>;
  /** Voice belongs with the server roster. The call survives while this dock is closed. */
  voice: VoiceChat;
  /** Queue/transport mutations travel over the authenticated session channel. */
  addVideo: (sourceUrl: string) => boolean;
  removeVideo: (id: string) => boolean;
  skipVideo: (id: string) => boolean;
  seekVideo: (id: string, position: number) => boolean;
  setVideoPlaying: (id: string, playing: boolean) => boolean;
  videoEnabled: () => boolean;
  setVideoEnabled: (enabled: boolean) => void;
  /** The decoder remains browser-local even though its public source and clock are shared. */
  mountVideo: (host: HTMLElement | null) => void;
  videoTime: () => { current: number; duration: number };
  videoMuted: () => boolean;
  setVideoMuted: (muted: boolean) => void;
  videoVolume: () => number;
  setVideoVolume: (volume: number) => void;
  serverNow: () => number;
  /** Repaint the dock. Users is a mode, so entering and leaving it goes through the same rebuild. */
  rebuildTools: () => void;
}): UsersMode {
  installStyles('users-mode', CSS);

  const gui = new GUI({ autoPlace: false, title: 'Users Mode' });
  gui.domElement.style.display = 'none';
  gui.$title.classList.add('sp-mode-title');
  const icon = document.createElement('span');
  icon.className = 'sp-mode-title-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = USERS_ICON;
  const heading = document.createElement('span');
  heading.textContent = 'Users Mode';
  gui.$title.replaceChildren(icon, heading);
  document.getElementById('dock-right')!.appendChild(gui.domElement);

  let active = false;
  let roster: Roster | null = null;
  let loading = false;
  let jukeboxUrl = '';
  let jukebox = emptyJukeboxState();
  let jukeboxMessage = 'The queue and transport are shared; playback and mute are local to this browser.';
  let jukeboxTone: JukeboxMessageTone = '';
  let jukeboxInfo: JukeboxMessageInfo | null = null;
  let jukeboxStateEl: HTMLDivElement | null = null;
  let jukeboxPauseEl: HTMLButtonElement | null = null;
  let jukeboxTimer: ReturnType<typeof setInterval> | null = null;

  const showJukeboxMessageInfo = (info: JukeboxMessageInfo) => {
    const { host, close } = modal();
    const infoGui = new GUI({ container: host, title: info.title });
    note(infoGui, info.body);
    if (info.action && info.actionLabel) {
      infoGui.add({ open: () => { close(); info.action?.(); } }, 'open').name(info.actionLabel);
    }
    infoGui.add({ done: close }, 'done').name('Done');
  };

  const paintJukeboxMessage = () => {
    if (!jukeboxStateEl) return;
    jukeboxStateEl.className = `sp-jukebox-state${jukeboxTone ? ` ${jukeboxTone}` : ''}`;
    jukeboxStateEl.textContent = jukeboxMessage;
    if (jukeboxInfo) {
      const info = document.createElement('button');
      info.type = 'button';
      info.className = 'sp-jukebox-info';
      info.textContent = 'i';
      info.setAttribute('aria-label', jukeboxInfo.title);
      tooltip(info, `More information: ${jukeboxInfo.title}`);
      info.onclick = () => { if (jukeboxInfo) showJukeboxMessageInfo(jukeboxInfo); };
      jukeboxStateEl.appendChild(info);
    }
    jukeboxStateEl.hidden = !jukebox.current && jukeboxMessage === 'The shared queue is empty.';
  };

  const setJukeboxMessage = (
    message: string,
    tone: JukeboxMessageTone = '',
    info: JukeboxMessageInfo | null = null,
  ) => {
    jukeboxMessage = message;
    jukeboxTone = tone;
    jukeboxInfo = info;
    paintJukeboxMessage();
  };

  const stopJukeboxUi = () => {
    if (jukeboxTimer) { clearInterval(jukeboxTimer); jukeboxTimer = null; }
    jukeboxStateEl = null;
    jukeboxPauseEl = null;
    deps.mountVideo(null);
  };

  const act = async (what: string, run: () => Promise<unknown>): Promise<void> => {
    try {
      await run();
      refresh();
    } catch (error) {
      toast(`${what} failed: ${error instanceof Error ? error.message : String(error)}`, 'err', 6000);
    }
  };

  const mayManage = (member: RosterMember): boolean => !!roster
    && roster.accounts === 'required'
    && roster.me.id !== member.id
    && (roster.admin || (roster.moderator && (member.role === 'viewer' || member.role === 'editor')));

  const fullDate = (iso: string): string => new Date(iso).toLocaleString();

  const lastSeenText = (member: RosterMember): string => {
    if (member.online) return STATUS_LABELS[rosterStatus(member)];
    const elapsed = Math.max(0, Date.now() - Date.parse(member.lastSeenAt));
    if (elapsed < 60_000) return 'Just now';
    if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} minutes ago`;
    if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} hours ago`;
    return fullDate(member.lastSeenAt);
  };

  async function goToMember(member: RosterMember): Promise<void> {
    const currentId = deps.currentProject()?.id;
    const destination = member.maps.find(map => map.id === currentId) ?? member.maps[0];
    if (!destination) {
      toast(`${member.username} is online, but does not have a map open.`, 'info');
      return;
    }
    if (destination.id !== currentId && !await deps.openProject(destination.id)) return;

    // Opening their map causes the server to send that room's live awareness. Give the avatar pose a brief
    // chance to arrive rather than making the user click Go to player a second time after the map loads.
    for (let attempt = 0; attempt < 30; attempt++) {
      if (deps.goToPlayer(member.id)) return;
      await new Promise<void>(resolve => window.setTimeout(resolve, 100));
    }
    toast(`Could not find ${member.username}'s live position. They may have changed maps or entered Play.`,
      'info', 6000);
  }

  function showMemberProfile(member: RosterMember): void {
    const { host, close } = modal();
    host.classList.add('sp-user-profile');
    const head = document.createElement('div');
    head.className = 'sp-user-profile-head';
    const avatar = document.createElement('div');
    avatar.className = 'sp-user-profile-avatar';
    avatar.textContent = initialsFor(member.username);
    if (member.profilePictureUrl) {
      const image = document.createElement('img');
      image.alt = '';
      image.src = member.profilePictureUrl;
      image.onerror = () => image.remove();
      avatar.appendChild(image);
    }
    const identity = document.createElement('div');
    const title = document.createElement('h2');
    title.textContent = member.username;
    const status = document.createElement('div');
    status.className = 'sp-user-profile-status';
    status.textContent = `${member.role} · ${member.disabled ? 'Account disabled' : lastSeenText(member)}`;
    identity.append(title, status);
    head.append(avatar, identity);
    host.appendChild(head);

    if (member.bio) {
      const bio = document.createElement('p');
      bio.className = 'sp-user-profile-bio';
      bio.textContent = member.bio;
      host.appendChild(bio);
    }

    const details = document.createElement('dl');
    const add = (label: string, value: string): HTMLElement => {
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = value;
      details.append(term, description);
      return description;
    };
    const roleValue = add('Role', member.role);
    if (mayManage(member)) {
      const path = `/api/members/${encodeURIComponent(member.username)}`;
      const roles: MemberRole[] = roster?.admin
        ? ['viewer', 'editor', 'moderator', 'admin']
        : ['viewer', 'editor'];
      const roleDescriptions: Record<MemberRole, string> = {
        viewer: 'Follows read-only.',
        editor: 'Changes existing maps.',
        moderator: 'Creates mountains and manages ordinary accounts; also edits maps.',
        admin: 'Manages the server, accounts, and invites.',
      };
      const roleSelect = document.createElement('select');
      roleSelect.className = 'sp-user-profile-role-select';
      roleSelect.setAttribute('aria-label', `Role for ${member.username}`);
      for (const role of roles) {
        const option = document.createElement('option');
        option.value = role;
        option.textContent = role;
        option.title = roleDescriptions[role];
        roleSelect.appendChild(option);
      }
      roleSelect.value = member.role;
      tooltip(roleSelect, () => `Role: ${roleSelect.value}. Choose a new role for ${member.username}.`);
      roleSelect.onchange = () => {
        const role = roleSelect.value as MemberRole;
        if (role === member.role) return;
        roleSelect.disabled = true;
        close();
        void act('Changing a role', () => postJson(`${path}/role`, JSON.stringify({ role })));
      };
      roleValue.replaceChildren(roleSelect);
    }
    add('Joined', fullDate(member.createdAt));
    add('Last seen', lastSeenText(member));
    add('Status', member.disabled ? 'Disabled' : STATUS_LABELS[rosterStatus(member)]);
    add('Devices', member.devices.length ? [...member.devices].sort().join(', ') : 'None detected');
    host.appendChild(details);

    if (roster?.moderator && member.inviteHandle !== undefined) {
      const privateBox = document.createElement('div');
      privateBox.className = 'sp-user-profile-private';
      const privateTitle = document.createElement('strong');
      privateTitle.textContent = 'Invite handle · moderators only';
      const explanation = document.createElement('p');
      explanation.textContent = 'Private provenance for who was invited and where the invitation was sent.';
      const edit = document.createElement('div');
      edit.className = 'sp-user-profile-handle';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = member.inviteHandle;
      input.placeholder = 'discord:joe123';
      const save = document.createElement('button');
      save.type = 'button';
      save.className = 'sp-btn accent';
      save.textContent = 'Save';
      save.onclick = () => void (async () => {
        save.disabled = true;
        try {
          await postJson(`/api/members/${encodeURIComponent(member.username)}/handle`,
            JSON.stringify({ handle: input.value }));
          member.inviteHandle = input.value.trim();
          toast(`Invite handle saved for ${member.username}.`, 'ok');
          close();
          refresh();
        } catch (error) {
          save.disabled = false;
          toast(`Could not save invite handle: ${error instanceof Error ? error.message : error}`, 'err', 6000);
        }
      })();
      edit.append(input, save);
      privateBox.append(privateTitle, explanation, edit);
      host.appendChild(privateBox);
    }

    if (mayManage(member)) {
      const path = `/api/members/${encodeURIComponent(member.username)}`;
      const adminBox = document.createElement('section');
      adminBox.className = 'sp-user-profile-admin';
      const adminTitle = document.createElement('strong');
      adminTitle.textContent = 'Account controls · moderators only';

      const accountActions = document.createElement('div');
      accountActions.className = 'sp-user-profile-account-actions';
      const access = document.createElement('button');
      access.type = 'button';
      access.className = `sp-btn${member.disabled ? '' : ' danger'}`;
      access.textContent = member.disabled ? 'Enable account' : 'Disable account';
      tooltip(access, member.disabled ? 'Let them sign in again.'
        : 'Refuse sign-in and end every session it holds, right now.');
      access.onclick = () => {
        close();
        void act('Changing an account',
          () => postJson(`${path}/disabled`, JSON.stringify({ disabled: !member.disabled })));
      };
      accountActions.appendChild(access);

      if (roster?.admin) {
        const setPasswordButton = document.createElement('button');
        setPasswordButton.type = 'button';
        setPasswordButton.className = 'sp-btn';
        setPasswordButton.textContent = 'Set password…';
        tooltip(setPasswordButton, 'Choose a new password and end every session it protected.');
        setPasswordButton.onclick = () => { close(); void setPassword(member); };

        const generatePasswordButton = document.createElement('button');
        generatePasswordButton.type = 'button';
        generatePasswordButton.className = 'sp-btn';
        generatePasswordButton.textContent = 'Generate password';
        tooltip(generatePasswordButton, 'Generate a password, show it once, and end every session it protected.');
        generatePasswordButton.onclick = () => { close(); void generatePassword(member); };

        const signOut = document.createElement('button');
        signOut.type = 'button';
        signOut.className = 'sp-btn danger';
        signOut.textContent = 'Sign out everywhere';
        tooltip(signOut, 'End every session this account holds, on every machine.');
        signOut.onclick = () => {
          close();
          void act('Signing out', async () => {
            const { sessions } = await postJson<{ sessions: number }>(`${path}/sign-out`);
            toast(`${sessions} session${sessions === 1 ? '' : 's'} ended for ${member.username}.`, 'ok');
          });
        };
        accountActions.append(setPasswordButton, generatePasswordButton, signOut);
      }

      adminBox.append(adminTitle, accountActions);
      host.appendChild(adminBox);
    }

    const actions = document.createElement('div');
    actions.className = 'sp-modal-actions';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'sp-btn';
    done.textContent = 'Close';
    done.onclick = close;
    actions.appendChild(done);
    host.appendChild(actions);
  }

  function voiceIndicator(member: RosterMember, state: VoiceMemberState): HTMLElement {
    const indicator = document.createElement(state.self ? 'span' : 'button');
    if (indicator instanceof HTMLButtonElement) indicator.type = 'button';
    indicator.className = `sp-users-voice-state${state.speaking ? ' speaking' : ''}`
      + `${state.microphone ? '' : ' muted'}${state.locallyMuted ? ' local-muted' : ''}`;
    indicator.setAttribute('aria-label', state.self
      ? state.speaking ? 'You are speaking in voice'
        : state.microphone ? 'You are in voice with microphone on' : 'You are in voice with microphone muted'
      : state.locallyMuted ? `Unmute ${member.username}` : `Mute ${member.username}`);
    if (!state.self) indicator.setAttribute('aria-pressed', String(state.locallyMuted));
    indicator.innerHTML = '<svg class="mic" viewBox="0 0 20 20" aria-hidden="true">'
      + '<rect x="7" y="3" width="6" height="9" rx="3"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5M7.5 17.5h5"/>'
      + '<path class="slash" d="M3 3l14 14"/></svg>'
      + '<svg class="speaker" viewBox="0 0 20 20" aria-hidden="true">'
      + '<path d="M3 8h3l4-3.5v11L6 12H3zM13 7a4 4 0 0 1 0 6M15 4.5a7 7 0 0 1 0 11"/></svg>'
      + '<svg class="speaker-muted" viewBox="0 0 20 20" aria-hidden="true">'
      + '<path d="M3 8h3l4-3.5v11L6 12H3zM13 8l4 4M17 8l-4 4"/></svg>';
    tooltip(indicator, state.self
      ? state.speaking ? 'You are speaking in server voice.'
        : state.microphone ? 'Your microphone is on.' : 'Your microphone is muted or listen-only.'
      : state.locallyMuted ? `You cannot hear ${member.username}. Click to unmute.`
        : `${state.speaking ? `${member.username} is speaking` : `${member.username} is in voice`}. Click to mute.`);
    if (!state.self) indicator.onclick = event => {
      event.stopPropagation();
      deps.voice.toggleMemberMute(member.id);
    };
    return indicator;
  }

  function memberRow(member: RosterMember, state: VoiceMemberState | undefined, into: GUI): void {
    const connected = member.online || !!state;
    const status = connected ? displayedStatus(member, !!state) : 'offline';
    const row = document.createElement('div');
    row.className = `sp-gui-custom sp-users-row status-${status}`
      + `${member.disabled ? ' disabled' : ''}`;
    const avatar = document.createElement('button');
    avatar.type = 'button';
    avatar.className = 'sp-users-avatar';
    avatar.setAttribute('aria-label', `View ${member.username}'s profile`);
    avatar.onclick = () => showMemberProfile(member);
    avatar.textContent = initialsFor(member.username);
    if (member.profilePictureUrl) {
      const picture = document.createElement('img');
      picture.alt = '';
      picture.src = member.profilePictureUrl;
      picture.onload = () => { avatar.textContent = ''; avatar.append(picture, dot); };
      picture.onerror = () => picture.remove();
      avatar.appendChild(picture);
    }
    const dot = document.createElement('span');
    dot.className = 'sp-users-dot';
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', `${member.username}: ${STATUS_LABELS[status]}`);
    tooltip(dot, connected
      ? `${STATUS_LABELS[status]}. Connected${member.sessions > 1 ? ` in ${member.sessions} sessions` : ''}`
        + `${member.devices.length ? ` — ${member.devices.join(', ')}` : ''}.`
      : 'Offline. Not connected.');
    avatar.appendChild(dot);
    const who = document.createElement('div');
    who.className = 'sp-users-who';
    const nameLine = document.createElement('div');
    nameLine.className = 'sp-users-name-line';
    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'sp-users-name';
    name.textContent = member.username;
    name.onclick = () => showMemberProfile(member);
    nameLine.appendChild(name);
    if (deps.currentProject()?.ownerId === member.id) {
      const owner = document.createElement('span');
      owner.className = 'sp-users-owner';
      owner.textContent = 'owner';
      tooltip(owner, `Created and owns ${deps.currentProject()?.name ?? 'this map'}.`);
      nameLine.appendChild(owner);
    }
    if (member.watching) {
      const watching = document.createElement('span');
      watching.className = 'sp-users-watching';
      watching.setAttribute('role', 'img');
      watching.setAttribute('aria-label', `${member.username} is watching a shared screen`);
      watching.innerHTML = WATCHING_ICON;
      tooltip(watching, `${member.username} is actively watching a shared screen.`);
      nameLine.appendChild(watching);
    }
    if (state) nameLine.appendChild(voiceIndicator(member, state));
    const sub = document.createElement('div');
    sub.className = 'sp-users-sub';
    if (member.disabled) sub.append('disabled · ');
    if (!connected) sub.append('offline');
    else if (!member.maps.length) sub.append(`${STATUS_LABELS[status].toLocaleLowerCase()} · no map open`);
    else {
      if (status !== 'online') sub.append(`${STATUS_LABELS[status].toLocaleLowerCase()} · `);
      // One person may have two tabs, so a member can hold two map/reference pairs at once. Each is its own way in.
      member.maps.forEach((map, index) => {
        if (index) sub.append(' · ');
        const playingIcon = (world: string): HTMLSpanElement => {
          const playing = document.createElement('span');
          playing.className = 'sp-users-playing';
          playing.setAttribute('role', 'img');
          playing.setAttribute('aria-label', `${member.username} is playing ${world}`);
          playing.innerHTML = MEDIA_ICON.play;
          tooltip(playing, `${member.username} is playing ${world}.`);
          return playing;
        };
        if (map.playing?.includes('authored')) sub.append(playingIcon(map.name));
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'sp-users-map';
        open.textContent = map.name;
        tooltip(open, `Open ${map.name}.`);
        open.onclick = () => { void deps.openProject(map.id); };
        sub.append(open);
        if (map.reference) {
          sub.append(' / ');
          if (map.playing?.includes('reference')) sub.append(playingIcon(map.reference));
          const reference = document.createElement('button');
          reference.type = 'button';
          reference.className = 'sp-users-map';
          reference.textContent = map.reference;
          tooltip(reference, `Load ${map.reference} as Reference.`);
          reference.onclick = () => deps.openReference(map.reference!);
          sub.append(reference);
        }
      });
    }
    who.append(nameLine, sub);
    const actions = document.createElement('div');
    actions.className = 'sp-users-actions';
    const sharedMap = member.id === roster?.me.id
      ? undefined : member.maps.find(map => !!map.sharingSessionId);
    if (sharedMap?.sharingSessionId) {
      const view = document.createElement('button');
      view.type = 'button';
      view.className = 'sp-users-view';
      view.innerHTML = svg(SCREEN_ICON_BODY);
      view.setAttribute('aria-label', `View ${member.username}'s shared screen`);
      tooltip(view, `View ${member.username}'s screen on ${sharedMap.name}`
        + `${sharedMap.reference ? ` with ${sharedMap.reference} as Reference` : ''}.`);
      view.onclick = event => {
        event.stopPropagation();
        deps.observeScreen(sharedMap.sharingSessionId!, member.username);
      };
      actions.appendChild(view);
    }
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'sp-users-more';
    more.textContent = '⋮';
    more.setAttribute('aria-label', `Options for ${member.username}`);
    more.setAttribute('aria-haspopup', 'menu');
    tooltip(more, `Options for ${member.username}.`);
    more.onclick = event => {
      event.stopPropagation();
      const items: MenuItem[] = [{
        label: 'Profile',
        desc: `View ${member.username}'s profile.`,
        onClick: () => showMemberProfile(member),
      }];
      if (connected && member.id !== roster?.me.id) items.push(
        {
          label: 'Message',
          desc: `Send ${member.username} a private message.`,
          onClick: () => deps.openChat(`/msg ${member.username} `),
        },
        {
          label: 'Go to player',
          desc: `Open ${member.username}'s map and move in front of their live avatar.`,
          onClick: () => { void goToMember(member); },
        },
      );
      const rect = more.getBoundingClientRect();
      contextMenu(items, { x: rect.left, y: rect.bottom + 3 });
    };
    actions.appendChild(more);
    row.append(avatar, who, actions);
    into.$children.appendChild(row);
  }

  const passwordPath = (member: RosterMember): string =>
    `/api/members/${encodeURIComponent(member.username)}/password`;

  async function setPassword(member: RosterMember): Promise<void> {
    const chosen = await askName({
      title: `Set ${member.username}'s password`,
      label: 'New password',
      hint: 'Every session this account holds ends. Hand it over out of band; they change it once they are in.',
      confirmLabel: 'Set it',
      validate: value => value.length >= MIN_PASSWORD_LENGTH
        ? null : `At least ${MIN_PASSWORD_LENGTH} characters.`,
    });
    if (!chosen) return;
    await act('Setting a password', async () => {
      await postJson(passwordPath(member), JSON.stringify({ password: chosen }));
      toast(`${member.username}'s password is set, and every session it protected has ended.`, 'ok', 6000);
    });
  }

  async function generatePassword(member: RosterMember): Promise<void> {
    const sure = await confirmAction({
      title: `Generate a password for ${member.username}?`,
      body: 'The server picks one and shows it here once. Every session this account holds ends immediately.',
      confirmLabel: 'Generate',
    });
    if (!sure) return;
    await act('Generating a password', async () => {
      const answer = await postJson<{ password?: string }>(passwordPath(member), JSON.stringify({}));
      toast(`${member.username}'s password is now ${answer.password ?? '(shown in the server log)'}`, 'ok', 15_000);
    });
  }

  const invite = { handle: '', role: 'editor' as MemberRole, days: 7 };

  const clock = (seconds: number): string => {
    const whole = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(whole / 60);
    return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
  };

  const paintPauseButton = (button: HTMLButtonElement, playing: boolean) => {
    const label = playing ? 'Pause' : 'Play';
    button.innerHTML = `${playing ? MEDIA_ICON.pause : MEDIA_ICON.play}<span>${label}</span>`;
    button.setAttribute('aria-label', `${label} the shared video`);
  };

  const sourceLine = (entry: JukeboxEntry, action?: { label: string; run: () => void }): HTMLDivElement => {
    const line = document.createElement('div');
    line.className = 'sp-jukebox-line';
    const owner = document.createElement('span');
    owner.className = 'sp-jukebox-owner';
    owner.textContent = entry.username;
    owner.title = `@${entry.username}`;
    const link = document.createElement('a');
    link.className = 'sp-jukebox-link';
    link.href = entry.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = entry.url;
    link.title = entry.url;
    line.append(owner, link);
    if (action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sp-jukebox-btn stop';
      button.textContent = action.label;
      button.onclick = action.run;
      line.appendChild(button);
    }
    return line;
  };

  function buildJukebox(): void {
    let playbackEnabled = deps.videoEnabled();
    const folder = gui.addFolder(`Jukebox · ${playbackEnabled ? 'On' : 'Off'}`);
    const body = document.createElement('div');
    body.className = 'sp-gui-custom sp-jukebox';

    // Playback enablement is deliberately the first, obvious choice in the place that owns playback.
    const power = document.createElement('div');
    power.className = 'sp-jukebox-power';
    const powerButton = document.createElement('button');
    powerButton.type = 'button';
    const paintPower = () => {
      powerButton.className = `sp-jukebox-btn power${playbackEnabled ? ' on' : ''}`;
      powerButton.textContent = playbackEnabled ? 'Turn off' : 'Turn on';
      powerButton.setAttribute('aria-pressed', String(playbackEnabled));
    };
    paintPower();
    const powerCopy = document.createElement('div');
    powerCopy.className = 'sp-jukebox-power-copy';
    powerCopy.textContent = 'Uses Yattee when available, otherwise YouTube';
    powerButton.onclick = () => {
      playbackEnabled = !playbackEnabled;
      deps.setVideoEnabled(playbackEnabled);
      paintPower();
      render();
    };
    power.append(powerButton, powerCopy);

    body.appendChild(power);
    if (!playbackEnabled) {
      deps.mountVideo(null);
      folder.$children.appendChild(body);
      return;
    }

    const state = document.createElement('div');
    jukeboxStateEl = state;
    paintJukeboxMessage();
    body.appendChild(state);

    // Video
    if (jukebox.current && playbackEnabled) {
      const preview = document.createElement('div');
      preview.className = 'sp-jukebox-player';
      body.appendChild(preview);
      deps.mountVideo(preview);
    } else {
      deps.mountVideo(null);
      const preview = document.createElement('div');
      preview.className = 'sp-jukebox-player sp-jukebox-empty';
      preview.style.display = 'grid';
      preview.style.placeItems = 'center';
      preview.textContent = jukebox.current
        ? 'Playback is off in this browser.'
        : 'The shared queue is empty.';
      body.appendChild(preview);
    }

    // Seek
    const seek = document.createElement('div');
    seek.className = 'sp-jukebox-seek';
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.step = '0.25';
    slider.disabled = !jukebox.current;
    slider.setAttribute('aria-label', 'Shared video position');
    const time = document.createElement('output');
    time.className = 'sp-jukebox-time';
    let dragging = false;
    const paintPosition = () => {
      const local = deps.videoTime();
      const expected = jukeboxPosition(jukebox, deps.serverNow());
      const duration = playbackEnabled ? local.duration : 0;
      const shown = playbackEnabled && local.current > 0 ? local.current : expected;
      slider.max = String(duration > 0 ? duration : Math.max(1, shown + 1));
      if (!dragging) slider.value = String(Math.min(shown, Number(slider.max)));
      time.textContent = jukebox.current
        ? `${clock(dragging ? Number(slider.value) : shown)} / ${duration > 0 ? clock(duration) : '–:––'}`
        : '0:00 / –:––';
    };
    slider.onpointerdown = () => { dragging = true; };
    slider.oninput = () => {
      dragging = true;
      time.textContent = `${clock(Number(slider.value))} / ${clock(Number(slider.max))}`;
    };
    slider.onchange = () => {
      dragging = false;
      if (jukebox.current && !deps.seekVideo(jukebox.current.id, Number(slider.value))) {
        setJukeboxMessage('The server connection is not open.', 'err');
      }
    };
    slider.onpointerup = () => { dragging = false; };
    seek.append(slider, time);
    body.appendChild(seek);
    paintPosition();
    jukeboxTimer = setInterval(paintPosition, 250);

    // Pause / skip / mute
    const controls = document.createElement('div');
    controls.className = 'sp-jukebox-controls';
    const pause = document.createElement('button');
    pause.type = 'button';
    pause.className = 'sp-jukebox-btn';
    pause.disabled = !jukebox.current;
    paintPauseButton(pause, jukebox.playing);
    pause.title = 'Play or pause for everyone on this server';
    pause.onclick = () => {
      if (jukebox.current && !deps.setVideoPlaying(jukebox.current.id, !jukebox.playing)) {
        setJukeboxMessage('The server connection is not open.', 'err');
      }
    };
    jukeboxPauseEl = pause;
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'sp-jukebox-btn stop';
    const maySkip = mayManageJukeboxEntry(roster?.me ?? null, jukebox.current);
    skip.disabled = !jukebox.current || !maySkip;
    skip.innerHTML = `${MEDIA_ICON.skip}<span>Skip</span>`;
    skip.setAttribute('aria-label', 'Skip the shared video');
    skip.title = maySkip ? 'Skip this video for everyone' : 'Only its queuer, a moderator, or an admin may skip it';
    skip.onclick = () => {
      if (jukebox.current && !deps.skipVideo(jukebox.current.id)) {
        setJukeboxMessage('The server connection is not open.', 'err');
      }
    };
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'sp-jukebox-btn';
    const paintMute = () => {
      const muted = deps.videoMuted();
      const label = muted ? 'Unmute' : 'Mute';
      mute.innerHTML = `${muted ? MEDIA_ICON.muted : MEDIA_ICON.volume}<span>${label}</span>`;
      mute.setAttribute('aria-label', `${label} the video in this browser`);
    };
    paintMute();
    mute.title = 'Mute or unmute only this browser';
    mute.onclick = () => { deps.setVideoMuted(!deps.videoMuted()); paintMute(); };
    controls.append(pause, skip, mute);
    body.appendChild(controls);

    const volume = document.createElement('label');
    volume.className = 'sp-jukebox-volume';
    const volumeIcon = document.createElement('span');
    volumeIcon.className = 'sp-jukebox-volume-icon';
    volumeIcon.title = 'Volume in this browser';
    const volumeSlider = document.createElement('input');
    volumeSlider.type = 'range';
    volumeSlider.min = '0';
    volumeSlider.max = '100';
    volumeSlider.step = '1';
    volumeSlider.value = String(Math.round(deps.videoVolume() * 100));
    volumeSlider.setAttribute('aria-label', 'Jukebox volume in this browser');
    const volumeValue = document.createElement('output');
    const paintVolume = () => {
      volumeValue.textContent = `${volumeSlider.value}%`;
      volumeIcon.innerHTML = Number(volumeSlider.value) === 0 ? MEDIA_ICON.muted : MEDIA_ICON.volume;
    };
    paintVolume();
    volumeSlider.oninput = () => {
      deps.setVideoVolume(Number(volumeSlider.value) / 100);
      paintVolume();
    };
    volume.append(volumeIcon, volumeSlider, volumeValue);
    body.appendChild(volume);

    // Queue and contribution controls
    const queue = document.createElement('div');
    queue.className = 'sp-jukebox-queue';
    const title = document.createElement('div');
    title.className = 'sp-jukebox-queue-title';
    const queueSize = (jukebox.current ? 1 : 0) + jukebox.queue.length;
    title.textContent = `Video queue · ${queueSize}`;
    const row = document.createElement('div');
    row.className = 'sp-jukebox-row';
    const url = document.createElement('input');
    url.className = 'sp-jukebox-url';
    url.type = 'url';
    url.placeholder = 'YouTube video URL';
    url.value = jukeboxUrl;
    url.autocomplete = 'off';
    url.spellcheck = false;
    url.setAttribute('aria-label', 'YouTube video URL');
    url.oninput = () => { jukeboxUrl = url.value; };
    const addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.className = 'sp-jukebox-btn';
    addButton.textContent = 'Add';
    const add = () => {
      jukeboxUrl = url.value.trim();
      try {
        youtubeVideoId(jukeboxUrl);
      } catch (error) {
        setJukeboxMessage(error instanceof Error ? error.message : String(error), 'err');
        return;
      }
      if (!deps.addVideo(jukeboxUrl)) {
        setJukeboxMessage('The server connection is not open yet.', 'err');
        return;
      }
      url.value = '';
      jukeboxUrl = '';
      setJukeboxMessage('Adding that video to the shared queue…');
    };
    addButton.onclick = add;
    url.onkeydown = event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      add();
    };
    row.append(url, addButton);
    queue.append(title, row);
    if (jukebox.current) {
      const nowLabel = document.createElement('div');
      nowLabel.className = 'sp-jukebox-queue-label';
      nowLabel.textContent = 'Now playing';
      queue.append(nowLabel, sourceLine(jukebox.current));
    }
    if (jukebox.queue.length) {
      const upNext = document.createElement('div');
      upNext.className = 'sp-jukebox-queue-label';
      upNext.textContent = 'Up next';
      queue.appendChild(upNext);
      for (const entry of jukebox.queue) {
        const mayRemove = mayManageJukeboxEntry(roster?.me ?? null, entry);
        queue.appendChild(sourceLine(entry, mayRemove ? {
          label: 'Remove',
          run: () => {
            if (!deps.removeVideo(entry.id)) setJukeboxMessage('The server connection is not open.', 'err');
          },
        } : undefined));
      }
    } else if (!jukebox.current) {
      const empty = document.createElement('div');
      empty.className = 'sp-jukebox-empty';
      empty.textContent = 'Nothing queued yet.';
      queue.appendChild(empty);
    }
    body.appendChild(queue);
    folder.$children.appendChild(body);
  }

  function buildManagement(): void {
    if (!roster?.moderator) return;
    if (roster.accounts === 'required') {
      const folder = gui.addFolder('Invite somebody');
      folder.close();
      note(folder, 'Each link creates one account.',
        'The private handle records who you intended to invite and where you contacted them; only moderators '
        + 'can see it.');
      tip(folder.add(invite, 'handle').name('invite handle'),
        'Use a source prefix when useful, such as discord:joe123 or email:joe@example.com. Members never see it.');
      folder.add(invite, 'role', roster.admin
        ? ['viewer', 'editor', 'moderator', 'admin']
        : ['viewer', 'editor']).name('role');
      folder.add(invite, 'days', 1, 90, 1).name('expires in (days)');
      tip(folder.add({
        mint: () => void act('Minting an invite', async () => {
          const minted = await postJson<{ token: string }>('/api/members/invite', JSON.stringify(invite));
          showInviteLink(minted.token, invite.role, invite.days);
          invite.handle = '';
        }),
      }, 'mint').name('Mint an invite link'),
      'The token is shown once and never stored — only its digest is, so nothing here can read one back.');
    }
  }

  /** The open map's policy, kept at the bottom of the Users panel because it administers the map rather than
   *  describing anybody's current presence. Undefined editorIds means the role alone is enough; once
   *  restricted, owner and moderator/admin access remain implicit. */
  function buildMapPermissions(): void {
    const project = deps.currentProject();
    if (!project || !roster) return;
    const policy = { restricted: project.editorIds !== undefined };
    const folder = gui.addFolder(`Map permissions · ${policy.restricted ? 'Restricted' : 'Open'}`);
    folder.close();
    const owner = roster.members.find(member => member.id === project.ownerId);
    const manager = project.ownerId === roster.me.id || roster.me.role === 'moderator' || roster.me.role === 'admin';
    note(folder, owner
      ? `${owner.username} owns this map. ${manager ? 'Owners and moderators can change this policy.' : ''}`
      : 'This map predates ownership. A moderator can manage it.');

    const restrict = folder.add(policy, 'restricted').name('restrict editing');
    tip(restrict, 'Off: every editor may edit. On: only selected editors, the owner, and moderators/admins may edit.');
    if (!manager) restrict.disable();
    else restrict.onChange((restricted: boolean) => {
      const initial = restricted
        ? roster!.members.filter(member => member.role === 'editor' && member.id !== project!.ownerId)
          .map(member => member.id)
        : null;
      void act('Changing map permissions', () => deps.setProjectEditors(initial));
    });

    if (!policy.restricted) {
      detail(folder, 'All members with the editor role can edit.', 'editing');
      return;
    }

    const selected = new Set(project.editorIds ?? []);
    const editors = roster.members
      .filter(member => member.role === 'editor' && member.id !== project.ownerId)
      .sort((a, b) => a.username.localeCompare(b.username));
    if (!editors.length) detail(folder, 'No other editor accounts are available.', 'allowed editors');
    for (const member of editors) {
      const choice = { allowed: selected.has(member.id) };
      const control = folder.add(choice, 'allowed').name(member.username);
      tip(control, `Allow ${member.username} to edit ${project.name}.`);
      if (!manager) control.disable();
      else control.onChange((allowed: boolean) => {
        if (allowed) selected.add(member.id); else selected.delete(member.id);
        void act('Changing map permissions', () => deps.setProjectEditors([...selected]));
      });
    }
    detail(folder, 'The owner and moderators/admins always retain editing access.', 'implicit access');
  }

  function render(): void {
    stopJukeboxUi();
    clearGui(gui);
    const comms = document.createElement('div');
    comms.className = 'sp-gui-custom sp-users-comms';
    const chat = document.createElement('button');
    chat.type = 'button';
    chat.className = 'sp-users-chat';
    chat.setAttribute('aria-label', 'Open text chat');
    chat.title = 'Open and focus the lower-left server chat';
    chat.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true">'
      + '<path d="M3 4.5h14v9H9l-4 3v-3H3z"/><path d="M6.5 8h7M6.5 10.5h4.5"/></svg>'
      + '<span>Text chat</span><span class="sp-users-chat-key">T</span>';
    chat.onclick = () => deps.openChat();
    comms.append(chat, deps.voice.el);
    gui.$children.appendChild(comms);
    if (!roster) {
      note(gui, loading ? 'Reading the roster…' : 'This server did not answer who is on it.');
      return;
    }
    const voiceMembers = new Map(deps.voice.members().map(member => [member.userId, member]));
    const online = roster.members.filter(member => member.online || voiceMembers.has(member.id)).length;
    if (roster.accounts === 'required') {
      const me = roster.members.find(member => member.id === roster!.me.id);
      if (me) {
        const choice = { availability: me.availability ?? 'available' };
        const control = gui.add(choice, 'availability', {
          Available: 'available', Away: 'away', 'Do Not Disturb': 'dnd',
        }).name('Your status');
        tip(control, 'Available turns Idle after five minutes without input. Away and Do Not Disturb stay set until you change them.');
        control.onChange((availability: ManualAvailability) => {
          control.disable();
          void postJson<{ user: { availability: ManualAvailability } }>('/api/auth/availability',
            JSON.stringify({ availability }))
            .then(() => refresh())
            .catch(error => {
              toast(`Could not change your status: ${error instanceof Error ? error.message : error}`, 'err', 6000);
              refresh();
            });
        });
      }
    }
    const sharing = { enabled: deps.screenSharing() };
    tip(gui.add(sharing, 'enabled').name('Share screen').onChange((enabled: boolean) => {
      deps.setScreenSharing(enabled);
    }), 'Let other connected members follow this tab’s mountain, Reference, view options, and camera.');
    // A server with no accounts is somebody's own workspace on loopback: one member, and nothing to join.
    if (roster.accounts === 'open') {
      note(gui, 'This server has no accounts — it serves whoever is running it.',
        'Start it with --accounts to require a sign-in and invite other people.');
    }
    const list = gui.addFolder(`Online ${online}`);
    const members = [...roster.members].sort((a, b) => {
      const groupA = voiceMembers.has(a.id) ? 0 : 1;
      const groupB = voiceMembers.has(b.id) ? 0 : 1;
      return groupA - groupB || a.username.localeCompare(b.username);
    });
    const roleSections: readonly { role: MemberRole; label: string }[] = [
      { role: 'admin', label: 'Admins' },
      { role: 'moderator', label: 'Moderators' },
      { role: 'editor', label: 'Editors' },
      { role: 'viewer', label: 'Viewers' },
    ];
    const appendSection = (label: string, sectionMembers: RosterMember[]): void => {
      if (!sectionMembers.length) return;
      const heading = document.createElement('div');
      heading.className = 'sp-gui-custom sp-users-role-heading';
      heading.textContent = label;
      heading.setAttribute('role', 'heading');
      heading.setAttribute('aria-level', '3');
      list.$children.appendChild(heading);
      for (const member of sectionMembers) memberRow(member, voiceMembers.get(member.id), list);
    };
    const connectedMembers = members.filter(member => member.online || voiceMembers.has(member.id));
    for (const section of roleSections) {
      const inRole = connectedMembers.filter(member => member.role === section.role);
      if (!inRole.length) continue;
      appendSection(section.label, inRole);
    }
    const offlineMembers = members.filter(member => !member.online && !voiceMembers.has(member.id));
    if (offlineMembers.length) {
      const offline = gui.addFolder(`Offline ${offlineMembers.length}`);
      offline.close();
      for (const member of offlineMembers) memberRow(member, undefined, offline);
    }
    buildJukebox();
    buildManagement();
    buildMapPermissions();
  }

  function refresh(): void {
    if (!active) return;
    loading = true;
    void fetchJson<Roster>('/api/members')
      .then(answer => { roster = answer; })
      .catch(() => { roster = null; })
      .finally(() => { loading = false; if (active) render(); });
    render();
  }

  function showMyProfile(): void {
    void fetchJson<Roster>('/api/members').then(answer => {
      roster = answer;
      const member = answer.members.find(candidate => candidate.id === answer.me.id);
      if (!member) throw new Error('Your profile is not in the member roster.');
      showMemberProfile(member);
      if (active) render();
    }).catch(error => {
      toast(`Could not open your profile: ${error instanceof Error ? error.message : error}`, 'err', 6000);
    });
  }

  deps.voice.subscribe(() => { if (active && roster) render(); });

  return {
    active: () => active,
    setActive(on: boolean): void {
      if (active === on) return;
      active = on;
      gui.domElement.style.display = on ? '' : 'none';
      if (on) refresh(); else { stopJukeboxUi(); clearGui(gui); }
      deps.rebuildTools();
    },
    refresh,
    showMyProfile,
    setJukebox(state): void {
      const before = `${jukebox.current?.id ?? ''}|${jukebox.queue.map(entry => entry.id).join(',')}`;
      const after = `${state.current?.id ?? ''}|${state.queue.map(entry => entry.id).join(',')}`;
      jukebox = state;
      if (jukeboxPauseEl) paintPauseButton(jukeboxPauseEl, state.playing);
      // A pure seek or loop epoch is consumed by the live slider/controller. Keep the media subtree seated;
      // rebuilding the whole roster for transport ticks would needlessly move a playing <video> in the DOM.
      if (before !== after && active && roster) render();
    },
    setJukeboxMessage,
  };
}
