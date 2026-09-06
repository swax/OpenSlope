import { installStyles } from '../components/styles';
import type { ChatLine, SessionMember } from '../../net/session-channel';

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

export function createChatBox(deps: {
  say: (text: string) => void;
  /** Who this browser is, for drawing a private line as "to you" rather than as a name. */
  me: () => SessionMember | null;
  /** While a ride is running the ride owns the keyboard, so the passive feed remains but cannot be opened. */
  suspended?: () => boolean;
}): ChatBox {
  installStyles('chat-box', CSS);

  const el = document.createElement('div');
  el.className = 'sp-chat';
  const speakerList = document.createElement('div');
  speakerList.className = 'sp-chat-speakers';
  speakerList.setAttribute('role', 'status');
  speakerList.setAttribute('aria-live', 'polite');
  const log = document.createElement('div');
  log.className = 'sp-chat-log';
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
  note.textContent = '/msg <user> <text> · /r <text> replies. Private lines are private from other members, '
    + 'not from whoever runs this server — it relays and retains them. Esc closes.';
  el.append(speakerList, log, entry, note);
  document.body.appendChild(el);

  const lines: ChatLine[] = [];
  const rows = new Map<number, HTMLElement>();
  let open = false;
  let holding = false;
  let fade = 0;

  // The bottom-left corner already carries the command sheet, so the box sits above whatever that strip is
  // currently as tall as rather than over it.
  const lowerLeft = document.getElementById('lowerleft');
  const anchor = (): void => {
    const above = lowerLeft?.offsetHeight ?? 0;
    el.style.bottom = `${above ? above + 14 : 8}px`;
  };
  anchor();
  if (lowerLeft && typeof ResizeObserver !== 'undefined') new ResizeObserver(anchor).observe(lowerLeft);

  function nameOf(line: ChatLine): string {
    const mine = deps.me()?.id;
    if (line.kind !== 'private') return line.from?.username ?? '';
    const to = line.to?.userId === mine ? 'you' : line.to?.username ?? '';
    const from = line.from?.userId === mine ? 'you' : line.from?.username ?? '';
    return `${from} → ${to}`;
  }

  function rowFor(line: ChatLine): HTMLElement {
    const row = document.createElement('div');
    row.className = `sp-chat-line sp-chat-${line.kind}`;
    if (line.from && line.from.userId === deps.me()?.id && line.kind === 'room') row.classList.add('sp-chat-mine');
    if (line.kind === 'system') {
      row.textContent = plainChatText(line.text);
      return row;
    }
    const who = document.createElement('span');
    who.className = 'sp-chat-who';
    who.textContent = `${nameOf(line)}: `;
    const body = document.createElement('span');
    body.textContent = plainChatText(line.text);
    row.append(who, body);
    return row;
  }

  /** Which rows are shown: everything while the box is open, only what was said recently while it is not. */
  function paint(): void {
    const now = Date.now();
    const shown = new Map((open ? lines : lines.slice(-RECENT_LINES)).map(line => [line.id, line]));
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
    if (!pending && fade) { clearInterval(fade); fade = 0; }
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
    const unique = new Map(active.filter(speaker => speaker.userId && speaker.username)
      .map(speaker => [speaker.userId, speaker]));
    const sorted = [...unique.values()].sort((a, b) => a.username.localeCompare(b.username));
    for (const speaker of sorted) {
      const row = document.createElement('span');
      row.className = 'sp-chat-speaker';
      row.setAttribute('aria-label', `${speaker.username} is speaking in voice`);
      row.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true">'
        + '<path d="M3 8h3l4-3.5v11L6 12H3zM13 7a4 4 0 0 1 0 6M15 4.5a7 7 0 0 1 0 11"/></svg>';
      row.append(document.createTextNode(speaker.username));
      speakerList.appendChild(row);
    }
    speakerList.classList.toggle('on', sorted.length > 0);
    speakerList.setAttribute('aria-label', sorted.length
      ? `${sorted.map(speaker => speaker.username).join(', ')} speaking in voice`
      : 'Nobody speaking in voice');
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
    open = false;
    holding = false;
    el.classList.remove('open');
    input.blur();
    paint();
  }

  input.addEventListener('focus', () => { holding = true; });
  input.addEventListener('blur', () => { holding = false; });
  input.addEventListener('keydown', event => {
    // Every key typed here is a character. Stopping propagation is belt to the suppression brace in
    // `shortcuts.ts`, which is the rule that actually holds — a listener attached elsewhere is not this
    // box's to know about.
    event.stopPropagation();
    if (event.key === 'Enter') { event.preventDefault(); send(); return; }
    if (event.key === 'Escape') { event.preventDefault(); close(); }
  });
  el.addEventListener('mousedown', event => {
    if (open || deps.suspended?.()) return;
    event.preventDefault();
    api.open();
  });

  const api: ChatBox = {
    el,
    push(line: ChatLine): void { remember(line); paint(); },
    replay(replayed: ChatLine[]): void {
      lines.length = 0;
      for (const row of rows.values()) row.remove();
      rows.clear();
      for (const line of replayed) remember(line);
      paint();
    },
    setSpeakers,
    open(prefill = ''): void {
      if (deps.suspended?.()) return;
      open = true;
      el.classList.add('open');
      if (prefill) input.value = prefill;
      paint();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
    close,
    focused: (): boolean => holding,
  };
  return api;
}
