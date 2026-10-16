import './home.css';
import type { PublicCourse } from '../../core/session/public-courses';
import { referenceRoom } from '../../core/session/public-courses';
import { discCourseName, isDiscCourse } from '../../core/reference/disc-courses';
import { currentAccount } from '../net/account';
import { clientId } from '../net/client';
import { createSessionChannel, type PresenceEntry, type SessionMember } from '../net/session-channel';
import { createChatBox } from '../ui/chrome/chat-box';
import type { PeerMarks } from '../viewport/scene/peers';
import { cachedIsoCourses, clearIsoCache, importIso, needsCollisionSoundUpdate, scanIso, unloadIsoCourse } from './iso-cache';
import { coursesWithIso } from './course-list';
import type { PublicPlayer } from './player';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
async function request<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}

export async function showPublicHome(): Promise<void> {
  document.body.classList.add('public-play');
  document.getElementById('load-status')?.classList.remove('show');
  const account = await currentAccount();
  let me: SessionMember | null = 'user' in account ? account.user : account.accounts === 'open'
    ? { id: 'owner', username: 'owner', role: 'admin' } : null;
  let player: PublicPlayer | null = null;
  let selected: PublicCourse | null = null;
  let room: string | null = null;
  let file: File | null = null;
  let preparing = false;
  let scanning = false;
  let discovered: string[] = [];
  let published: PublicCourse[] = [];
  let cached = await cachedIsoCourses().catch(() => [] as string[]);
  const peers = new Map<string, PeerMarks>();
  let presence: Record<string, PresenceEntry[]> = {};

  const header = element('header', 'public-header');
  const brand = element('a', 'public-brand', 'SLOPESMITH'); brand.href = '/?play';
  const home = element('a', 'public-back', '← Courses'); home.href = '/?play';
  const signIn = element('a', 'public-sign-in', me ? 'Open editor ↗' : 'Member sign in ↗');
  signIn.href = me ? '/' : '/?sign-in=1#sign-in';
  header.append(brand, home, signIn);
  const main = element('main', 'public-home');
  const eyebrow = element('p', 'public-eyebrow', 'DROP IN. FIND YOUR LINE.');
  const title = element('h1', '', 'The mountain is open.');
  const intro = element('p', 'public-intro', 'Pick a course. Ride together in your browser or step into VR.');
  const identity = element('form', 'public-identity');
  const nameLabel = element('label', '', 'Your rider name');
  const name = element('input', ''); name.name = 'name'; name.maxLength = 24; name.setAttribute('autocomplete', 'nickname');
  name.placeholder = 'How should we call you?'; nameLabel.append(name);
  const join = element('button', '', 'Join the lodge'); join.type = 'submit';
  const who = element('p', 'public-who', me ? `Riding as ${me.username}` : 'No account needed. Enter a name to join multiplayer and chat.');
  identity.append(nameLabel, join, who);
  if (me) { nameLabel.hidden = true; join.hidden = true; }
  const iso = element('section', 'public-iso');
  const isoTitle = element('h2', '', 'Your disc. Your browser.');
  const isoText = element('p', '', 'Choose your SSX Tricky PS2 ISO to list its courses. Assets are extracted when you load a course and stay on this device. Your ISO is never uploaded.');
  const isoInput = element('input', ''); isoInput.type = 'file'; isoInput.accept = '.iso'; isoInput.id = 'public-iso';
  const isoLabel = element('label', 'public-iso-button', 'Choose game ISO'); isoLabel.htmlFor = isoInput.id;
  const cacheState = element('span', 'public-cache');
  const clear = element('button', 'public-clear', 'Clear local assets'); clear.type = 'button';
  const isoActions = element('div', 'public-iso-actions'); isoActions.append(isoLabel, isoInput, cacheState, clear);
  const cachedList = element('ul', 'public-cached-courses'); cachedList.setAttribute('aria-label', 'Cached courses');
  const updateCache = () => {
    cacheState.textContent = cached.length ? `${cached.length} course${cached.length === 1 ? '' : 's'} cached on this device` : 'No courses cached yet';
    clear.hidden = !cached.length; clear.disabled = preparing || scanning;
    cachedList.replaceChildren(); cachedList.hidden = !cached.length;
    for (const [index, course] of cached.entries()) {
      const row = element('li', '');
      const label = element('span', '', discCourseName(course)); label.id = `public-cached-course-${index}`;
      const unload = element('button', '', 'Unload'); unload.type = 'button'; unload.disabled = preparing || scanning;
      unload.setAttribute('aria-describedby', label.id);
      unload.addEventListener('click', () => { void changeCache(() => unloadIsoCourse(course),
        `${discCourseName(course)} unloaded. Load it again to extract a fresh copy from your ISO.`); });
      row.append(label, unload); cachedList.append(row);
    }
  };
  updateCache();
  const isoStatus = element('p', 'public-iso-status'); isoStatus.setAttribute('role', 'status'); isoStatus.hidden = true;
  iso.append(isoTitle, isoText, isoActions, cachedList, isoStatus);
  const courseTitle = element('h2', 'public-course-title', 'Choose your next run');
  const grid = element('div', 'public-courses'); grid.setAttribute('aria-label', 'Playable courses');
  const status = element('p', 'public-status', 'Loading public courses…'); status.setAttribute('role', 'status');
  const actions = element('div', 'public-actions');
  const prepare = element('button', 'public-primary', 'Load course'); prepare.type = 'button'; prepare.disabled = true;
  const cancel = element('button', '', 'Cancel import'); cancel.type = 'button'; cancel.hidden = true;
  const ride = element('button', 'public-primary', 'Ride'); ride.type = 'button'; ride.hidden = true;
  const vr = element('button', '', 'Play in VR'); vr.type = 'button'; vr.hidden = true;
  const stop = element('button', '', 'Stop riding'); stop.type = 'button'; stop.hidden = true;
  actions.append(prepare, cancel, ride, vr, stop);
  main.append(eyebrow, title, intro, identity, iso, courseTitle, grid, status, actions);
  document.body.append(header, main);

  function renderCourses() {
    const available = new Set([...discovered, ...cached]);
    const courses = coursesWithIso(published, [...available]);
    selected = courses.find(course => course.kind === selected?.kind && course.id === selected.id) ?? null;
    grid.replaceChildren();
    for (const [index, course] of courses.entries()) {
      const fromIso = course.kind === 'reference' && course.retailData && course.isoCourses.some(slot => available.has(slot));
      const ready = course.isoCourses.length > 0 && course.isoCourses.every(slot => cached.includes(slot));
      const card = element('button', `public-course public-course-${index % 4}`); card.type = 'button';
      card.disabled = preparing || scanning;
      const art = element('div', 'public-course-art'); art.setAttribute('aria-hidden', 'true');
      const badge = element('span', 'public-course-kind', fromIso ? 'FROM YOUR ISO'
        : course.kind === 'project' ? 'COMMUNITY MOUNTAIN' : 'REFERENCE COURSE');
      const courseName = element('h3', '', course.name.replace(/[_-]/g, ' '));
      const requirements = element('span', 'public-requirements', ready ? 'Cached on this device'
        : course.retailData ? fromIso ? 'Extracted when you load this course' : 'Your ISO required' : 'Ready in your browser');
      card.append(art, badge, courseName, requirements);
      card.setAttribute('aria-pressed', String(selected === course));
      card.addEventListener('click', () => {
        selected = course;
        grid.querySelectorAll('button').forEach(button => button.setAttribute('aria-pressed', String(button === card)));
        prepare.disabled = false;
        status.textContent = ready ? `${course.name} is cached and ready to load.`
          : course.retailData ? `${course.name} uses game assets from your local ISO.` : `${course.name} is ready to load.`;
        prepare.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
      grid.append(card);
    }
    prepare.disabled = !selected || preparing || scanning;
    return courses.length;
  }
  function coursePrompt() {
    return grid.childElementCount ? 'Select a course to get started.'
      : 'Choose your ISO to discover playable courses. Members can also publish mountains from the editor.';
  }
  renderCourses();

  const chat = createChatBox({ docked: true, say: text => session.say(text), me: () => me });
  const chatInput = chat.el.querySelector('input')!;
  chatInput.enterKeyHint = 'send';
  chatInput.placeholder = me ? 'Say something…' : 'Enter a rider name to chat'; chatInput.disabled = !me;
  const chatStatus = element('p', 'public-chat-status', 'Join the lodge to chat with other riders.');
  chat.el.insertBefore(chatStatus, chat.el.children[1]);
  function refreshPeers() {
    if (!selected || !player) return;
    const entries = selected.kind === 'project' ? presence[selected.id] ?? []
      : Object.values(presence).flat().filter(entry => entry.referenceLevel?.toUpperCase() === selected!.id.toUpperCase()
        && entry.playing === 'reference');
    const here = new Set(entries.map(entry => entry.sessionId));
    player.peers([...peers.values()].filter(peer => here.has(peer.sessionId) && peer.sessionId !== session.sessionId()));
  }
  const session = createSessionChannel({
    clientId, deviceLabel: 'public rider', publicPlay: true,
    url: () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/public/session?client=${encodeURIComponent(clientId)}`,
    onWelcome(welcome) { me = welcome.member; session.watch(room); },
    onPresence(maps) { presence = maps; refreshPeers(); },
    onAware(peer) {
      peers.set(peer.sessionId, { ...peer, ...peer.aware }); refreshPeers();
    },
    onChat: line => chat.push(line), onChatHistory: lines => chat.replay(lines),
    onRideEvent: event => player?.rideEvent(event),
    onCapacityRefused: message => { chatStatus.textContent = message; },
    onStatus: state => { chatStatus.textContent = state === 'open' ? 'Connected · server chat' : 'Connecting to the lodge…'; },
  });
  async function connect() {
    if (!me) return;
    chatInput.disabled = false; chatInput.placeholder = 'Say something…'; session.start();
  }
  identity.addEventListener('submit', event => {
    event.preventDefault(); join.disabled = true;
    void request<{ member: SessionMember }>('/api/public/guest', { name: name.value }).then(async result => {
      me = result.member; who.textContent = `Riding as ${me.username}`; nameLabel.hidden = true; join.hidden = true;
      await connect();
    }).catch(error => { who.textContent = String(error instanceof Error ? error.message : error); })
      .finally(() => { join.disabled = false; });
  });
  isoInput.addEventListener('change', () => { void discoverIso(); });
  async function discoverIso() {
    file = isoInput.files?.[0] ?? null;
    discovered = [];
    if (!file) { renderCourses(); return; }
    scanning = true; isoInput.disabled = clear.disabled = true;
    updateCache();
    abort = new AbortController(); cancel.hidden = false;
    isoStatus.hidden = false; isoStatus.textContent = `Reading courses from ${file.name}…`;
    renderCourses();
    try {
      discovered = await scanIso(file, abort.signal);
      isoStatus.textContent = `${file.name} · ${discovered.length} course${discovered.length === 1 ? '' : 's'} found. Select one below to extract and ride.`;
    } catch (error) {
      file = null; isoInput.value = '';
      isoStatus.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      scanning = false; isoInput.disabled = clear.disabled = false; cancel.hidden = true; abort = null;
      updateCache(); renderCourses(); status.textContent = coursePrompt();
    }
  }
  async function changeCache(change: () => Promise<void>, message: string) {
    if (preparing || scanning || player) return;
    preparing = true; isoInput.disabled = true; updateCache(); renderCourses();
    try { await change(); cached = await cachedIsoCourses(); status.textContent = message; }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally { preparing = false; isoInput.disabled = false; updateCache(); renderCourses(); }
  }
  clear.addEventListener('click', () => { void changeCache(clearIsoCache, 'Local course assets cleared. Choose a course to load again.'); });
  let abort: AbortController | null = null;
  cancel.addEventListener('click', () => abort?.abort());
  prepare.addEventListener('click', () => { void load(); });
  async function load() {
    if (!selected || preparing || scanning) return;
    if (!me) { who.textContent = 'Enter a rider name before loading a course.'; name.focus(); return; }
    const course = selected;
    preparing = true; prepare.disabled = true; clear.disabled = true; isoInput.disabled = true;
    updateCache();
    grid.querySelectorAll('button').forEach(button => { button.disabled = true; });
    try {
      const needed = course.isoCourses.filter(course => !cached.includes(course));
      if (needed.length) {
        if (!file) throw new Error('Choose your game ISO above to prepare this course.');
        abort = new AbortController(); cancel.hidden = false;
        await importIso(file, needed, text => { status.textContent = text; }, abort.signal);
        cached = await cachedIsoCourses(); updateCache();
      }
      if (await needsCollisionSoundUpdate(course.isoCourses))
        throw new Error('Choose your ISO once more to restore collision sounds. Your cached course assets will be kept.');
      cancel.hidden = true;
      document.body.classList.add('public-preparing');
      main.classList.add('public-in-world');
      const { preparePublicPlayer } = await import('./player');
      player = await preparePublicPlayer(course, document.getElementById('viewport')!, session,
        text => { status.textContent = text; }, playing => { ride.hidden = vr.hidden = playing; stop.hidden = !playing; });
      const known = published.some(entry => entry.kind === course.kind && entry.id === course.id);
      room = course.kind === 'project' ? course.id : known || isDiscCourse(course.id) ? referenceRoom(course.id) : null;
      session.watch(room);
      prepare.hidden = true; ride.hidden = vr.hidden = false;
      status.textContent = `${course.name} · Ready to ride. Enter chats. Esc releases the mouse.`;
      document.body.classList.add('public-ready');
      refreshPeers();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      prepare.disabled = false;
      if (main.classList.contains('public-in-world')) {
        prepare.hidden = true; document.body.classList.add('public-ready');
        status.textContent += ' Return to Courses to try again.';
      }
    } finally {
      preparing = false; cancel.hidden = true; abort = null; clear.disabled = false; isoInput.disabled = false;
      updateCache();
      grid.querySelectorAll('button').forEach(button => { button.disabled = false; });
    }
  }
  ride.addEventListener('click', () => { void player?.play(); });
  vr.addEventListener('click', () => { void player?.vr().catch(error => {
    status.textContent = error instanceof Error ? error.message : String(error);
  }); });
  stop.addEventListener('click', () => player?.stop());
  try {
    const data = await request<{ courses: PublicCourse[]; guest: SessionMember | null }>('/api/public/courses');
    if (!me && data.guest) { me = data.guest; who.textContent = `Riding as ${me.username}`; nameLabel.hidden = join.hidden = true; }
    published = data.courses;
    renderCourses();
    if (!scanning) status.textContent = coursePrompt();
    await connect();
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
}
