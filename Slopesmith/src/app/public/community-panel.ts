import type { Account } from '../net/account';
import { clientId } from '../net/client';
import { createSessionChannel, type SessionMember } from '../net/session-channel';
import { ensureVisitor, setSiteRoster, siteMembers, watchSitePresence } from '../net/site-presence';
import { createChatBox } from '../ui/chrome/chat-box';
import type { ChatMember } from '../../core/session/chat-member';
import type { MenuItem } from '../ui/components/controls';
import { element, publicJson } from './dom';

type ChannelOptions = Parameters<typeof createSessionChannel>[0];
export type PublicCommunityHooks = Pick<ChannelOptions,
  'onWelcome' | 'onPresence' | 'onAware' | 'onRideEvent' | 'onStatus' | 'onAccessChanged'> & {
  userActions?: (member: ChatMember) => MenuItem[];
};

const JOINED = 'slopesmith.public-chat-joined.v1';
const VISIBLE = 'slopesmith.public-community-visible.v1';
function remembered(key: string): boolean {
  try { return sessionStorage.getItem(key) === '1'; } catch { return false; }
}
function remember(key: string, value: boolean) {
  try { if (value) sessionStorage.setItem(key, '1'); else sessionStorage.removeItem(key); } catch { /* storage can be disabled */ }
}

/** One public chat/session per page. Closing the drawer preserves membership; leaving chat ends it. */
export function publicCommunityPanel(account: Account, trigger: HTMLButtonElement) {
  const offline = account.accounts === 'open' && account.offline;
  const member: SessionMember | null = 'user' in account ? account.user : account.accounts === 'open' && !offline
    ? { id: 'owner', username: 'owner', role: 'admin' } : null;
  let me = member;
  let hooks: PublicCommunityHooks = {};
  let joined = false;
  let visible = remembered(VISIBLE);
  let usersShown = true;
  let joining = false;
  let attempt = 0;
  const chat = createChatBox({
    docked: true,
    say: text => { if (joined) session.say(text); },
    me: () => me,
    suspended: () => !joined || !visible,
    userActions: person => hooks.userActions?.(person) ?? [],
  });
  chat.el.id = 'public-chat';
  chat.el.classList.add('public-community-panel');
  chat.el.setAttribute('role', 'complementary');
  chat.el.setAttribute('aria-label', 'Users and chat');
  chat.el.querySelector('h2')?.remove();
  const tabs = chat.el.querySelector<HTMLElement>('.sp-chat-tabs')!;
  tabs.setAttribute('aria-label', 'Chat and users');
  const header = element('div', 'public-community-tabs');
  const hide = element('a', 'public-community-hide', 'Hide');
  hide.href = '#public-chat';
  header.append(tabs, hide);
  chat.el.prepend(header);
  const log = chat.el.querySelector<HTMLElement>('.sp-chat-log')!;
  const entry = chat.el.querySelector<HTMLElement>('.sp-chat-entry')!;
  const input = entry.querySelector('input')!;
  input.enterKeyHint = 'send'; input.placeholder = 'Say something…'; input.disabled = true;
  const status = element('p', 'public-chat-status'); status.setAttribute('role', 'status');
  const identity = element('form', 'public-chat-join');
  const label = element('label', '');
  label.append(element('span', '', 'Nickname'));
  const name = element('input', ''); name.name = 'name'; name.maxLength = 24; name.required = true;
  name.setAttribute('autocomplete', 'nickname'); name.placeholder = 'Rider name'; name.setAttribute('aria-label', 'Your rider name');
  label.append(name); label.hidden = !!member; name.disabled = !!member;
  const join = element('button', 'public-primary', member ? `Join as ${member.username}` : 'Join chat'); join.type = 'submit';
  const who = element('p', 'public-who'); who.setAttribute('role', 'status');
  identity.append(label, join, who);
  const leave = element('button', 'public-leave-chat', 'Leave chat'); leave.type = 'button';
  const actions = element('div', 'public-community-actions'); actions.append(leave);
  header.after(status, identity);
  chat.el.append(actions);

  function render() {
    identity.hidden = joined;
    entry.hidden = log.hidden = !joined || usersShown;
    // Before joining, the row still offers what does not need chat (the avatar picker); Leave chat waits.
    actions.hidden = joined && usersShown;
    leave.hidden = !joined;
    status.hidden = !joined;
    join.disabled = joining;
    input.disabled = !joined || !session.chatOpen();
  }
  function show(open: boolean) {
    visible = open; remember(VISIBLE, visible);
    chat.el.classList.toggle('is-open', visible);
    chat.el.inert = !visible;
    chat.el.setAttribute('aria-hidden', String(!visible));
    trigger.setAttribute('aria-expanded', String(visible));
    document.body.classList.toggle('public-chat-visible', visible);
    setSiteRoster(visible && usersShown);
    if (!visible) chat.close();
    window.dispatchEvent(new Event('resize'));
  }
  function leaveChat() {
    attempt++; joining = false; joined = false; remember(JOINED, false);
    session.setChatEnabled(false);
    chat.close(); chat.replay([]); chat.setChatEnabled(false);
    input.value = ''; who.textContent = ''; status.textContent = '';
    render();
  }
  function enterChat(person: SessionMember) {
    me = person; joined = true; remember(JOINED, true);
    session.setChatEnabled(true); session.start();
    chat.setChatEnabled(true); chat.selectTab('chat');
    status.textContent = 'Connecting…';
    render();
  }
  const session = createSessionChannel({
    clientId, deviceLabel: 'public visitor', publicPlay: true, chatInitiallyEnabled: false,
    url: () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/public/session?client=${encodeURIComponent(clientId)}`,
    onWelcome(welcome) {
      me = welcome.member;
      if (joined) status.textContent = `Connected as ${me.username}`;
      render(); hooks.onWelcome?.(welcome);
    },
    onChatRoster(members) { if (!session.usesPlayRelay()) chat.setUsers(members); },
    onPresence: maps => hooks.onPresence?.(maps),
    onAware: peer => hooks.onAware?.(peer),
    onRideEvent: event => hooks.onRideEvent?.(event),
    onChat: line => { if (joined) chat.push(line); },
    onChatHistory: lines => { if (joined) chat.replay(lines); },
    onCapacityRefused: message => { status.textContent = message; },
    onStatus(state) {
      if (joined) { status.dataset.state = state; status.textContent = 'Connecting…'; }
      render(); hooks.onStatus?.(state);
    },
    onAccessChanged(reason) { leaveChat(); who.textContent = reason; hooks.onAccessChanged?.(reason); },
  });
  watchSitePresence(snapshot => {
    if (snapshot) chat.setUsers(siteMembers(snapshot), snapshot.online);
  });
  chat.el.addEventListener('chat-tab-change', event => {
    event.stopPropagation();
    usersShown = (event as CustomEvent<boolean>).detail;
    render(); setSiteRoster(visible && usersShown);
  });
  trigger.setAttribute('aria-controls', chat.el.id);
  trigger.onclick = () => show(!visible);
  hide.onclick = event => { event.preventDefault(); show(false); trigger.focus(); };
  chat.el.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); show(false); trigger.focus();
    }
  }, true);
  leave.onclick = leaveChat;
  identity.addEventListener('submit', event => {
    event.preventDefault();
    if (offline) { who.textContent = 'Chat requires an internet connection. Reconnect and reopen to join.'; return; }
    if (joined || joining) return;
    joining = true; who.textContent = ''; render();
    const request = ++attempt;
    const identityRequest = member ? Promise.resolve({ member })
      : ensureVisitor().then(() => publicJson<{ member: SessionMember }>('/api/public/guest', { name: name.value }));
    void identityRequest.then(result => {
      if (request === attempt) enterChat(result.member);
    }).catch(error => {
      if (request === attempt) who.textContent = error instanceof Error ? error.message : String(error);
    }).finally(() => { if (request === attempt) { joining = false; render(); } });
  });
  const restore = remembered(JOINED);
  chat.setChatEnabled(false);
  render(); show(visible);
  session.watch(null);
  if (!offline) session.start();
  if (member) { if (restore) enterChat(member); }
  else if (!offline) {
    const request = attempt;
    void ensureVisitor().then(person => {
      if (request !== attempt) return;
      me = person;
      if (!person.anonymous) name.value = person.username.replace(/ \(guest\)$/, '');
      if (restore && !person.anonymous) enterChat(person);
      else remember(JOINED, false);
    }).catch(() => { remember(JOINED, false); });
  }
  window.addEventListener('pagehide', () => { session.close(); setSiteRoster(false); });
  window.addEventListener('pageshow', event => {
    if (event.persisted && !offline) { session.start(); setSiteRoster(visible && usersShown); }
  });
  return {
    session, actions, show,
    setHooks(next: PublicCommunityHooks) { hooks = next; },
  };
}
