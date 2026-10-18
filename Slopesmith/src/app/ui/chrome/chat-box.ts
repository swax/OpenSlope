import { installStyles } from '../components/styles';
import type { ChatLine, SessionMember } from '../../net/session-channel';
import { chatName, chatMapRoomLabel, shortChatId, type ChatMember } from '../../../core/session/chat-member';
import type { MenuItem } from '../components/controls';
import { toast } from '../components/toast';
import {
  bannedChatIds,
  shadowBanChat,
  chatActions,
  chatMuted,
  mutedChatIds,
  muteChat,
  onChatMutesChanged,
  roleMarker,
} from './chat-identity';

// Keep the formatting helpers importable without a DOM; menu listeners belong to the browser.
const contextMenu = async (items: MenuItem[], at: { x: number; y: number }) =>
  (await import('../components/controls')).contextMenu(items, at);
let nextChatBox = 0;

/**
 * The room, bottom-left over the viewport (docs/038).
 *
 * The shape is the one game chat converged on, for the same reasons: recent lines fade out over the world so the conversation is
 * ambient rather than a panel to keep open, a key opens the input when there is something to say, and the
 * scrollback is there when somebody wants to read back. System events share the stream — "Jed joined"
 * and "back in 10, don't touch the halfpipe" are the same question answered — and private lines are drawn
 * distinctly so the two are never mistaken for each other.
 *
 * **Focus is the rule that bites.** The editor binds bare single keys for modes and tools, so a box typed
 * into without holding focus turns a sentence into a burst of mode switches. This box takes focus explicitly
 * — a shortcut opens it and clicking it does too — and while it holds focus `shortcuts.ts` routes nothing to
 * the editor at all. Escape closes it and gives the keys back to the viewport.
 *
 * Nothing here parses a message. `text` arrives escaped from the server and is drawn back into a text node,
 * so a line is characters on both ends of the wire and never markup anywhere in between.
 */

/** How long a line stays legible over the viewport once it has been said, and how many hold that space. */
const RECENT_MS = 12_000;
const RECENT_LINES = 7;
/** What the scrollback keeps in this tab. The server retains its own few hundred and replays them on join. */
const KEPT_LINES = 300;

const CSS = `
.sp-chat { position: fixed; left: 10px; bottom: 8px; z-index: 16; width: min(400px, calc(100vw - 24px));
  display: flex; flex-direction: column; gap: 4px; pointer-events: none;
  font: 12px/1.45 system-ui, sans-serif; }
.sp-chat.open { pointer-events: auto; }
.sp-chat-log { display: flex; flex-direction: column; gap: 2px; max-height: 168px; overflow: hidden;
  padding: 0; border-radius: 6px; }
.sp-chat.open .sp-chat-log { max-height: 40vh; overflow-y: auto; padding: 6px 8px;
  background: rgba(12, 20, 29, 0.93); border: 1px solid #26405a; }
/* A line that is actually drawn is clickable, so clicking the box opens it — while the space around it stays
   transparent to the viewport, because a chat box must never eat a click meant for the mountain. */
.sp-chat-line { padding: 2px 7px; color: #dbe7f2; background: rgba(20, 26, 32, 0.78); border-radius: 4px;
  overflow-wrap: anywhere; transition: opacity .5s ease-out; pointer-events: auto; cursor: text; }
.sp-chat-line.faded { pointer-events: none; }
.sp-chat.open .sp-chat-line { padding: 1px 0; background: none; opacity: 1 !important; }
.sp-chat-line.faded { opacity: 0; }
.sp-chat-who { color: #7fc3ef; font-weight: 650; }
.sp-chat-time { margin-right: 6px; color: #6f8597; font-style: normal; font-variant-numeric: tabular-nums; }
.sp-chat-speakers { display: none; align-self: flex-start; flex-wrap: wrap; gap: 5px; max-width: 100%;
  padding: 4px 7px; box-sizing: border-box; color: #bcebd0; background: rgba(16, 42, 32, 0.88);
  border: 1px solid rgba(73, 137, 101, 0.72); border-radius: 5px; }
.sp-chat-speakers.on { display: flex; }
.sp-chat-speaker { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; font-weight: 650; }
.sp-chat-speaker + .sp-chat-speaker::before { content: '·'; margin-right: 1px; color: #709a82; }
.sp-chat-speaker svg { width: 14px; height: 14px; fill: none; stroke: #72db9d; stroke-width: 1.8;
  stroke-linecap: round; stroke-linejoin: round; }
.sp-chat-system { color: #9fb2c5; font-style: italic; }
.sp-chat-private { color: #f0d2a8; }
.sp-chat-private .sp-chat-who { color: #e8b169; }
.sp-chat-mine .sp-chat-who { color: #8fe0b0; }
.sp-chat-entry { display: none; gap: 6px; align-items: center; padding: 5px 6px;
  background: rgba(12, 20, 29, 0.96); border: 1px solid #3a6ea5; border-radius: 6px; }
.sp-chat.open .sp-chat-entry { display: flex; }
.sp-chat-entry input { flex: 1 1 auto; min-width: 0; padding: 4px 6px; color: #eaf6ff; background: #0b1723;
  border: 1px solid #24405a; border-radius: 4px; font: inherit; }
.sp-chat-entry input:focus { outline: none; border-color: #5aa2dd; }
.sp-chat-note { display: none; padding: 0 2px; color: #7f97ab; font-size: 10px; line-height: 1.4; }
.sp-chat.open .sp-chat-note { display: block; }
/* A live ride owns the keyboard, but incoming conversation and voice activity remain useful HUD. Rows stop
   taking pointer input so the passive feed cannot steal a steering/camera gesture. */
body.os-riding .sp-chat-line { pointer-events: none; cursor: default; }
.sp-chat h2 { display: none; }
.sp-chat.sp-chat-docked { left: auto; right: 0; top: var(--bar-h, 46px); bottom: 0; width: 300px;
  padding: 18px; box-sizing: border-box; pointer-events: auto; background: #101f2b; border-left: 1px solid #293e4b; gap: 10px; }
.sp-chat.sp-chat-docked h2 { display: block; margin: 0 0 12px; font-size: 18px; }
.sp-chat.sp-chat-docked .sp-chat-log { max-height: none; flex: 1; min-height: 0; padding: 0; border: 0; background: none; }
.sp-chat.sp-chat-docked .sp-chat-entry { display: flex; }
.sp-chat.sp-chat-docked input { font-size: 16px; }
.sp-chat.sp-chat-docked .sp-chat-line { pointer-events: auto; }
.sp-chat-tabs { display: none; gap: 6px; }
.sp-chat.open .sp-chat-tabs { display: flex; }
.sp-chat-tabs button, .sp-chat-users button { color: #dbe7f2; background: #172f41; border: 1px solid #365568;
  border-radius: 4px; padding: 5px 8px; cursor: pointer; font: inherit; }
.sp-chat-tabs button[aria-selected="true"] { background: #285270; border-color: #7ebde6; }
.sp-chat-users { flex: 1; min-height: 0; overflow: auto; padding: 5px; background: #0d1a25; border-radius: 5px; }
.sp-chat-user { display: flex; align-items: center; gap: 5px; padding: 7px 0; border-bottom: 1px solid #243a4a; }
.sp-chat-user-identity { flex: 1; min-width: 0; }
.sp-chat-user-maps { color: #8ea9bc; font-size: 11px; overflow-wrap: anywhere; }
.sp-chat-user-map { display: flex; align-items: baseline; flex-wrap: wrap; gap: 3px 6px; margin-top: 3px; }
.sp-chat-map-source { padding: 0 4px; border: 1px solid #365568; border-radius: 3px; color: #adc6d8;
  font-size: 10px; white-space: nowrap; }
.sp-chat-map-room { color: #8ea9bc; font-size: 10px; }
.sp-chat-map-room.same { color: #8fe0b0; font-weight: 600; }
.sp-chat-user-maps a { color: #8cc9ef; text-decoration: none; }
.sp-chat-user-maps a:hover { text-decoration: underline; }
.sp-chat-user-name { flex: 1; overflow-wrap: anywhere; }
.sp-chat-user.muted { opacity: .65; }
.sp-chat-users summary { cursor: pointer; padding: 8px 0; }
.sp-chat-users p { color: #9eb4c4; }
.sp-chat [hidden] { display: none !important; }
@media (max-width: 640px) {
  .sp-chat.sp-chat-docked { top: auto; height: 190px; width: 100%; }
  .sp-chat.sp-chat-docked h2, .sp-chat.sp-chat-docked .sp-chat-note { display: none; }
}
`;

export interface ChatSpeaker {
  userId: string;
  username: string;
}

export interface ChatBox {
  el: HTMLElement;
  /** One line, as it arrives. */
  push(line: ChatLine): void;
  /** The scrollback the server replayed, replacing whatever this tab had. */
  replay(lines: ChatLine[]): void;
  /** Replace the server-voice members currently speaking beside the passive chat feed. */
  setSpeakers(speakers: readonly ChatSpeaker[]): void;
  setUsers(users: readonly ChatMember[], online?: number): void;
  setChatEnabled(enabled: boolean): void;
  selectTab(tab: 'chat' | 'users'): void;
  /** Take the keyboard. `prefill` is what a `/`-shortcut opens with. */
  open(prefill?: string): void;
  close(): void;
  /** Whether the box is holding the keyboard — the one thing `shortcuts.ts` asks it. */
  focused(): boolean;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };

/** The message back as characters. It arrives escaped, and a text node never parses what it is given, so a
 *  sentence with a `<` in it reads as the author typed it and cannot become an element on the way. */
export const plainChatText = (text: string): string =>
  text.replace(/&(amp|lt|gt|quot|#39);/g, (whole, name: string) => ENTITIES[name] ?? whole);

/** When a line was said, as `hh:mm` in this browser's own timezone (`at` is the server's epoch milliseconds). */
export function chatTime(at: number): string {
  const when = new Date(at);
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
}

export function createChatBox(deps: {
  say: (text: string) => void;
  /** Who this browser is, for drawing a private line as "to you" rather than as a name. */
  me: () => SessionMember | null;
  /** While a ride is running the ride owns the keyboard, so the passive feed remains but cannot be opened. */
  suspended?: () => boolean;
  /** A persistent right-hand room for public riding. */
  docked?: boolean;
  /** Actions supplied by the current map, alongside chat mute and moderation controls. */
  userActions?: (member: ChatMember) => MenuItem[];
}): ChatBox {
  installStyles('chat-box', CSS);

  const el = document.createElement('div');
  el.className = deps.docked ? 'sp-chat sp-chat-docked open' : 'sp-chat';
  const heading = document.createElement('h2');
  heading.textContent = 'The lodge';
  el.append(heading);
  const speakerList = document.createElement('div');
  speakerList.className = 'sp-chat-speakers';
  speakerList.setAttribute('role', 'status');
  speakerList.setAttribute('aria-live', 'polite');
  const log = document.createElement('div');
  log.className = 'sp-chat-log';
  const panelId = `sp-chat-${++nextChatBox}`;
  log.id = `${panelId}-messages`;
  log.setAttribute('role', 'tabpanel');
  log.setAttribute('aria-labelledby', `${panelId}-chat-tab`);
  const tabs = document.createElement('div');
  tabs.className = 'sp-chat-tabs';
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-label', 'Lodge panel');
  const chatTab = document.createElement('button');
  chatTab.type = 'button';
  chatTab.textContent = 'Chat';
  chatTab.setAttribute('role', 'tab');
  chatTab.id = `${panelId}-chat-tab`;
  chatTab.setAttribute('aria-controls', log.id);
  const usersTab = document.createElement('button');
  usersTab.type = 'button';
  usersTab.textContent = 'Users';
  usersTab.setAttribute('role', 'tab');
  usersTab.id = `${panelId}-users-tab`;
  usersTab.setAttribute('aria-controls', `${panelId}-users`);
  tabs.append(chatTab, usersTab);
  const userList = document.createElement('div');
  userList.className = 'sp-chat-users';
  userList.id = `${panelId}-users`;
  userList.hidden = true;
  userList.setAttribute('role', 'tabpanel');
  userList.setAttribute('aria-label', 'Connected users');
  userList.setAttribute('aria-labelledby', usersTab.id);
  const entry = document.createElement('div');
  entry.className = 'sp-chat-entry';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 400;
  input.placeholder = 'Say something · /msg <user> <text>';
  input.setAttribute('aria-label', 'Chat message');
  input.autocomplete = 'off';
  entry.append(input);
  const note = document.createElement('div');
  note.className = 'sp-chat-note';
  // Said once, here, rather than left for people to assume: the server relays and retains a private line like
  // any other, so it is private from other members and not from whoever runs the machine.
  note.textContent =
    '/msg <user> <text> · /r <text> replies. Private lines are private from other members, ' +
    'not from whoever runs this server — it relays and retains them. Esc closes.';
  if (deps.docked)
    note.textContent = 'Enter to chat while riding. Esc returns to the mountain. /msg and /r work here too.';
  el.append(speakerList, tabs, log, userList, entry, note);
  document.body.appendChild(el);

  const lines: ChatLine[] = [];
  const rows = new Map<number, HTMLElement>();
  const docked = !!deps.docked;
  let open = docked;
  let holding = false;
  let fade = 0;
  let users: readonly ChatMember[] = [];
  let onlineCount = 0;
  let usersShown = false;
  let chatEnabled = true;
  let rosterVersion = 0;

  function selectTab(showUsers: boolean): void {
    showUsers ||= !chatEnabled;
    usersShown = showUsers;
    el.dispatchEvent(new CustomEvent('chat-tab-change', { detail: showUsers, bubbles: true }));
    log.hidden = showUsers;
    userList.hidden = !showUsers;
    entry.hidden = showUsers;
    chatTab.setAttribute('aria-selected', String(!showUsers));
    usersTab.setAttribute('aria-selected', String(showUsers));
    chatTab.tabIndex = showUsers ? -1 : 0;
    usersTab.tabIndex = showUsers ? 0 : -1;
    if (showUsers) {
      input.blur();
      void paintUsers();
    }
  }
  chatTab.onclick = () => selectTab(false);
  usersTab.onclick = () => selectTab(true);
  tabs.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    const showUsers = !chatEnabled || event.key === 'End' || (event.key !== 'Home' && !usersShown);
    selectTab(showUsers);
    (showUsers ? usersTab : chatTab).focus();
  });
  selectTab(false);

  async function actionsFor(member: ChatMember): Promise<MenuItem[]> {
    if (member.id === deps.me()?.id) return [];
    const items = await chatActions(member, deps.me());
    return [...(deps.userActions?.(member) ?? []), ...items];
  }

  async function paintUsers(): Promise<void> {
    const version = ++rosterVersion;
    userList.replaceChildren();
    const sharesRoom = (member: ChatMember) => !!member.maps?.some(map => map.sameRoom);
    for (const member of [...users].sort(
      (a, b) => Number(sharesRoom(b)) - Number(sharesRoom(a)) || a.username.localeCompare(b.username),
    )) {
      const row = document.createElement('div');
      row.className = 'sp-chat-user';
      row.classList.toggle('muted', chatMuted(member.chatId));
      const name = document.createElement('span');
      name.className = 'sp-chat-user-name';
      name.textContent = chatName(member);
      const identity = document.createElement('div');
      identity.className = 'sp-chat-user-identity';
      identity.append(name);
      const maps = document.createElement('div');
      maps.className = 'sp-chat-user-maps';
      for (const map of member.maps ?? []) {
        const line = document.createElement('div');
        line.className = 'sp-chat-user-map';
        if (map.playUrl) {
          const link = document.createElement('a');
          link.textContent = map.name;
          link.href = map.playUrl;
          line.append(link);
        } else line.append(map.name);
        const source = document.createElement('span');
        source.className = 'sp-chat-map-source';
        source.textContent = map.source === 'iso' ? 'ISO' : 'Server map';
        const room = document.createElement('span');
        room.className = `sp-chat-map-room${map.sameRoom ? ' same' : ''}`;
        room.textContent = chatMapRoomLabel(map);
        line.append(source, room);
        maps.append(line);
      }
      if (!member.maps?.length) maps.textContent = 'Browsing';
      identity.append(maps);
      row.append(roleMarker(member), identity);
      if (member.id !== deps.me()?.id) {
        const more = document.createElement('button');
        more.type = 'button';
        more.textContent = '⋮';
        more.setAttribute('aria-label', `Options for ${chatName(member)}`);
        more.onclick = async () => {
          const items = await actionsFor(member);
          const rect = more.getBoundingClientRect();
          if (items.length && more.isConnected) contextMenu(items, { x: rect.left, y: rect.bottom });
        };
        row.append(more);
      }
      userList.append(row);
    }
    if (!users.length) {
      const empty = document.createElement('p');
      empty.textContent = onlineCount ? 'Loading players…' : 'No players online.';
      userList.append(empty);
    }
    const saved = (label: string, entries: [string, string][], remove: (hash: string) => Promise<void> | void) => {
      if (!entries.length) return;
      const details = document.createElement('details');
      const summary = document.createElement('summary');
      summary.textContent = `${label} (${entries.length})`;
      details.append(summary);
      for (const [hash, label] of entries) {
        const row = document.createElement('div');
        row.className = 'sp-chat-user';
        const name = document.createElement('span');
        name.className = 'sp-chat-user-name';
        name.textContent = label;
        const undo = document.createElement('button');
        undo.type = 'button';
        undo.textContent = 'Remove';
        undo.setAttribute('aria-label', `Remove ${label}`);
        undo.onclick = () => {
          void Promise.resolve(remove(hash))
            .then(() => paintUsers())
            .catch(error => toast(String(error.message ?? error), 'err'));
        };
        row.append(name, undo);
        details.append(row);
      }
      userList.append(details);
    };
    saved(
      'Muted in this browser',
      Object.entries(mutedChatIds()).map(([hash, name]) => [hash, `${name} · #${shortChatId(hash)}`]),
      hash => muteChat(hash, '', false),
    );
    if (deps.me()?.role === 'moderator' || deps.me()?.role === 'admin') {
      try {
        const hashes = await bannedChatIds();
        if (version !== rosterVersion) return;
        saved(
          'Chat shadow bans',
          hashes.map(hash => [hash, `#${shortChatId(hash)}`]),
          hash => shadowBanChat(hash, false),
        );
      } catch (error) {
        if (version !== rosterVersion) return;
        const notice = document.createElement('p');
        notice.textContent = error instanceof Error ? error.message : String(error);
        userList.append(notice);
      }
    }
  }

  // The bottom-left corner already carries the command sheet, so the box sits above whatever that strip is
  // currently as tall as rather than over it.
  const lowerLeft = document.getElementById('lowerleft');
  const anchor = (): void => {
    if (docked) return;
    const above = lowerLeft?.offsetHeight ?? 0;
    el.style.bottom = `${above ? above + 14 : 8}px`;
  };
  anchor();
  if (lowerLeft && typeof ResizeObserver !== 'undefined') new ResizeObserver(anchor).observe(lowerLeft);

  function nameOf(line: ChatLine): string {
    const mine = deps.me()?.id;
    const display = (who: NonNullable<ChatLine['from']>) => chatName({ ...who, id: who.userId });
    if (line.kind !== 'private') return line.from ? display(line.from) : '';
    const to = line.to?.userId === mine ? 'you' : line.to ? display(line.to) : '';
    const from = line.from?.userId === mine ? 'you' : line.from ? display(line.from) : '';
    return `${from} → ${to}`;
  }

  function rowFor(line: ChatLine): HTMLElement {
    const row = document.createElement('div');
    row.className = `sp-chat-line sp-chat-${line.kind}`;
    if (line.from && line.from.userId === deps.me()?.id && line.kind === 'room') row.classList.add('sp-chat-mine');
    const time = document.createElement('span');
    time.className = 'sp-chat-time';
    time.textContent = chatTime(line.at);
    time.title = new Date(line.at).toLocaleString();
    row.append(time);
    if (line.kind === 'system') {
      row.append(plainChatText(line.text));
      return row;
    }
    const who = document.createElement('span');
    who.className = 'sp-chat-who';
    who.textContent = `${nameOf(line)}: `;
    if (line.from) {
      const member = { ...line.from, id: line.from.userId };
      who.prepend(roleMarker(member));
      who.addEventListener('contextmenu', event => {
        event.preventDefault();
        void actionsFor(member).then(items => {
          if (items.length) contextMenu(items, { x: event.clientX, y: event.clientY });
        });
      });
    }
    const body = document.createElement('span');
    body.textContent = plainChatText(line.text);
    row.append(who, body);
    return row;
  }

  /** Which rows are shown: everything while the box is open, only what was said recently while it is not. */
  function paint(): void {
    const now = Date.now();
    const unmuted = lines.filter(line => !chatMuted(line.from?.chatId));
    const shown = new Map((open ? unmuted : unmuted.slice(-RECENT_LINES)).map(line => [line.id, line]));
    for (const line of shown.values()) {
      if (rows.has(line.id)) continue;
      const row = rowFor(line);
      rows.set(line.id, row);
      log.appendChild(row);
    }
    for (const [id, row] of rows) {
      const line = shown.get(id);
      row.style.display = line ? '' : 'none';
      row.classList.toggle('faded', !!line && !open && now - line.at > RECENT_MS);
    }
    log.scrollTop = log.scrollHeight;
    scheduleFade();
  }

  /** The fade is a one-second tick that stops itself: nothing is animating once the last recent line has
   *  gone, so an idle editor is not repainting a box nobody is looking at. */
  function scheduleFade(): void {
    const pending = !open && lines.slice(-RECENT_LINES).some(line => Date.now() - line.at <= RECENT_MS);
    if (pending && !fade) fade = window.setInterval(paint, 1000);
    if (!pending && fade) {
      clearInterval(fade);
      fade = 0;
    }
  }

  function remember(line: ChatLine): void {
    lines.push(line);
    if (lines.length > KEPT_LINES) {
      for (const dropped of lines.splice(0, lines.length - KEPT_LINES)) {
        rows.get(dropped.id)?.remove();
        rows.delete(dropped.id);
      }
    }
  }

  function setSpeakers(active: readonly ChatSpeaker[]): void {
    speakerList.replaceChildren();
    const unique = new Map(
      active.filter(speaker => speaker.userId && speaker.username).map(speaker => [speaker.userId, speaker]),
    );
    const sorted = [...unique.values()].sort((a, b) => a.username.localeCompare(b.username));
    for (const speaker of sorted) {
      const row = document.createElement('span');
      row.className = 'sp-chat-speaker';
      row.setAttribute('aria-label', `${speaker.username} is speaking in voice`);
      row.innerHTML =
        '<svg viewBox="0 0 20 20" aria-hidden="true">' +
        '<path d="M3 8h3l4-3.5v11L6 12H3zM13 7a4 4 0 0 1 0 6M15 4.5a7 7 0 0 1 0 11"/></svg>';
      row.append(document.createTextNode(speaker.username));
      speakerList.appendChild(row);
    }
    speakerList.classList.toggle('on', sorted.length > 0);
    speakerList.setAttribute(
      'aria-label',
      sorted.length
        ? `${sorted.map(speaker => speaker.username).join(', ')} speaking in voice`
        : 'Nobody speaking in voice',
    );
  }

  function send(): void {
    const text = input.value.trim();
    input.value = '';
    if (text) deps.say(text);
    // Closed on send, the way the shortcut opened it: the keys go back to the viewport between sentences
    // rather than staying captured by a box nobody is typing in.
    close();
  }

  function close(): void {
    open = docked;
    holding = false;
    el.classList.toggle('open', open);
    input.blur();
    paint();
  }

  input.addEventListener('focus', () => {
    holding = true;
  });
  input.addEventListener('blur', () => {
    holding = false;
  });
  input.addEventListener('keydown', event => {
    // Every key typed here is a character. Stopping propagation is belt to the suppression brace in
    // `shortcuts.ts`, which is the rule that actually holds — a listener attached elsewhere is not this
    // box's to know about.
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      send();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });
  el.addEventListener('mousedown', event => {
    if (open || deps.suspended?.()) return;
    event.preventDefault();
    api.open();
  });

  const api: ChatBox = {
    el,
    push(line: ChatLine): void {
      remember(line);
      paint();
    },
    replay(replayed: ChatLine[]): void {
      lines.length = 0;
      for (const row of rows.values()) row.remove();
      rows.clear();
      for (const line of replayed) remember(line);
      paint();
    },
    setSpeakers,
    setChatEnabled(enabled) {
      chatEnabled = enabled;
      chatTab.hidden = !enabled;
      if (!enabled) selectTab(true);
    },
    selectTab: tab => selectTab(tab === 'users'),
    setUsers(members, online = members.length): void {
      users = members;
      onlineCount = online;
      usersTab.textContent = `Users (${online})`;
      if (usersShown) void paintUsers();
    },
    open(prefill = ''): void {
      if (deps.suspended?.()) return;
      open = true;
      selectTab(false);
      el.classList.add('open');
      if (prefill) input.value = prefill;
      paint();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    close,
    focused: (): boolean => holding,
  };
  onChatMutesChanged(() => {
    paint();
    if (usersShown) void paintUsers();
  });
  window.addEventListener(
    'keydown',
    event => {
      if (
        (!docked && !document.body.classList.contains('os-riding')) ||
        deps.suspended?.() ||
        event.key !== 'Enter' ||
        (event.target as HTMLElement | null)?.closest?.('input, textarea, select, button, a, [contenteditable="true"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      document.exitPointerLock?.();
      api.open();
    },
    true,
  );
  return api;
}
