import './home.css';
import type { PublicCourse } from '../../core/session/public-courses';
import { referenceRoom } from '../../core/session/public-courses';
import { isDiscCourse } from '../../core/reference/disc-courses';
import { currentAccount } from '../net/account';
import { localEditorUrl, mapPath } from '../navigation';
import { deleteLocalProject, listLocalProjects } from '../state/local-projects';
import type { ClientProject } from '../state/project-sync';
import { clientId } from '../net/client';
import { createSessionChannel, type PresenceEntry, type SessionMember } from '../net/session-channel';
import { createChatBox } from '../ui/chrome/chat-box';
import { confirmAction } from '../ui/components/prompts';
import { canSaveMountainFolder } from '../mountain/folder';
import { openLocalMountainFolder } from '../mountain/open-folder';
import type { PeerMarks } from '../viewport/scene/peers';
import { cachedIsoCourses, needsCollisionSoundUpdate } from './iso-cache';
import { publicCourseGroups } from './course-list';
import { element, publicJson } from './dom';
import { publicHeader } from './header';
import { isoRequirements, isoStatusBadges } from './iso-status';
import { courseEditorUrl, isoManagementUrl, publicCourseRequest, publicCourseUrl, resolvePublicCourse } from './links';
import type { PublicPlayer } from './player';
import { mapHeading, publicGlyph } from './presentation';
import { publicMapControls } from './map-controls';

export async function showPublicHome(): Promise<void> {
  document.body.classList.add('public-play');
  document.getElementById('load-status')?.classList.remove('show');
  const account = await currentAccount();
  const member: SessionMember | null = 'user' in account ? account.user : account.accounts === 'open'
    ? { id: 'owner', username: 'owner', role: 'admin' } : null;
  let me: SessionMember | null = null;
  let joined = false;
  let chatVisible = false;
  let joinAttempt = 0;
  let player: PublicPlayer | null = null;
  let selected: PublicCourse | null = null;
  const linked = publicCourseRequest(new URL(location.href));
  let friendRoom = new URL(location.href).searchParams.get('room');
  if (friendRoom && !/^[a-zA-Z0-9_-]{1,64}$/.test(friendRoom)) friendRoom = null;
  const playUrl = (course: PublicCourse) => {
    const url = new URL(publicCourseUrl(course));
    if (friendRoom) url.searchParams.set('room', friendRoom);
    return url.href;
  };
  if (!linked) document.body.classList.add('sp-page-background');
  let room: string | null = null;
  let preparing = false;
  let published: PublicCourse[] = [];
  let serverProjects: ClientProject[] = [];
  let serverMapsLoaded = false;
  let serverMapsError = '';
  const cardMessages = new Map<string, string>();
  const cached = await cachedIsoCourses().catch(() => [] as string[]);
  let savedProjects: ClientProject[] = [];
  const peers = new Map<string, PeerMarks>();
  let presence: Record<string, PresenceEntry[]> = {};

  const { header, iso: manage, setMap } = publicHeader('maps', account);
  document.title = 'Maps · Slopesmith';
  const main = element('main', 'public-home');
  const title = element('h1', 'public-visually-hidden', 'Maps');
  const serverSection = element('section', 'public-server-maps'); serverSection.setAttribute('aria-label', 'Public server maps');
  const serverTitle = element('h2', 'public-course-title', 'Public maps');
  const serverGrid = element('div', 'public-courses'); serverGrid.setAttribute('aria-label', 'Public server maps');
  const serverEmpty = element('p', 'public-empty', 'No public maps yet.');
  serverSection.append(serverTitle, serverGrid, serverEmpty);
  const privateSection = element('section', 'public-private-maps'); privateSection.setAttribute('aria-label', 'Private server maps');
  const privateTitle = element('h2', 'public-course-title', 'Private server maps');
  const privateGrid = element('div', 'public-courses'); privateGrid.setAttribute('aria-label', 'Private server maps');
  const privateEmpty = element('p', 'public-empty', 'Loading server maps…'); privateEmpty.setAttribute('role', 'status');
  privateSection.append(privateTitle, privateGrid, privateEmpty);
  const savedSection = element('section', 'public-saved-maps'); savedSection.setAttribute('aria-label', 'Local maps');
  const savedTitle = element('h2', 'public-course-title', 'Local maps');
  const savedNote = element('p', 'public-local-note', 'Saved in this browser.');
  savedNote.setAttribute('role', 'status');
  const savedGrid = element('div', 'public-courses'); savedGrid.setAttribute('aria-label', 'Local maps');
  savedSection.append(savedTitle, savedNote, savedGrid);
  if (canSaveMountainFolder()) {
    const openFolder = element('button', 'public-open-folder', 'Open mountain folder…'); openFolder.type = 'button';
    openFolder.addEventListener('click', () => {
      void openLocalMountainFolder().catch(error => { savedNote.textContent = error instanceof Error ? error.message : String(error); });
    });
    savedTitle.append(openFolder);
  }
  const localSection = element('section', 'public-local-maps'); localSection.setAttribute('aria-label', 'Loaded ISO maps');
  const localTitle = element('h2', 'public-course-title', 'From your ISO');
  const localGrid = element('div', 'public-courses'); localGrid.setAttribute('aria-label', 'Loaded ISO maps');
  const localEmpty = element('p', 'public-empty', 'No maps loaded.');
  localSection.append(localTitle, localGrid, localEmpty);
  const requirements = element('details', 'public-requirements-host'); requirements.hidden = true;
  const status = element('p', 'public-status', 'Loading public maps…'); status.setAttribute('role', 'status');
  const actions = element('div', 'public-actions'); actions.hidden = true;
  const stop = element('button', 'public-stop', ''); stop.type = 'button'; stop.hidden = true;
  stop.setAttribute('aria-label', 'Exit play'); stop.title = 'Exit play';
  stop.append(publicGlyph('stop'), element('span', 'public-stop-label', 'Exit'));
  header.append(stop);
  const toggleChat = element('button', 'public-chat-toggle'); toggleChat.type = 'button';
  toggleChat.setAttribute('aria-controls', 'public-chat');
  actions.append(toggleChat);
  const mapControls = publicMapControls({
    play: () => { void player?.play().catch(showPlayerError); },
    vr: () => { void player?.vr().catch(showPlayerError); },
    view: () => player?.view(),
    resetStart: () => player?.resetStart(),
  });
  function showPlayerError(error: unknown) {
    mapControls.error(error instanceof Error ? error.message : String(error));
  }
  main.append(title, ...(member && !linked ? [privateSection] : []), serverSection, savedSection, localSection, requirements, status, actions);
  document.body.append(header, main, mapControls.el);

  function showRequirements() {
    manage.href = isoManagementUrl(selected ?? undefined);
    requirements.replaceChildren();
    requirements.hidden = !selected?.isoCourses.length;
    document.body.classList.toggle('public-map-assets', !!selected?.isoCourses.length);
    if (selected) {
      const loaded = selected.isoCourses.filter(slot => cached.includes(slot)).length;
      const total = selected.isoCourses.length;
      const summary = element('summary', 'public-assets-summary');
      summary.setAttribute('aria-label', `ISO assets: ${loaded} of ${total} maps loaded`);
      summary.title = `${loaded} of ${total} ISO maps loaded`;
      summary.dataset.complete = String(loaded === total);
      summary.append(element('span', 'public-assets-label', 'Assets'), element('span', 'public-assets-count', `${loaded}/${total}`));
      const assets = isoRequirements(selected, cached);
      if (loaded < total && selected.kind === 'project') assets.querySelector('p')!.textContent = 'ISO textures/props omitted for unloaded maps.';
      requirements.append(summary, assets);
    }
  }
  document.addEventListener('pointerdown', event => {
    if (!requirements.contains(event.target as Node)) requirements.open = false;
  });
  requirements.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.stopPropagation(); requirements.open = false; requirements.querySelector('summary')?.focus(); }
  });
  function renderCourses() {
    const groups = publicCourseGroups(published, cached);
    const publicIds = new Set(published.filter(course => course.kind === 'project').map(course => course.id));
    const privateProjects = serverProjects.filter(project => !publicIds.has(project.id));
    for (const [heading, label, count] of [[serverTitle, 'Public maps', groups.server.length],
      [privateTitle, 'Private server maps', privateProjects.length],
      [savedTitle, 'Local maps', savedProjects.length],
      [localTitle, 'From your ISO', groups.local.length]] as const) {
      const total = element('span', 'public-section-count', String(count)); total.setAttribute('aria-hidden', 'true');
      const folderButton = heading.querySelector('.public-open-folder');
      heading.replaceChildren(document.createTextNode(label), total, ...(folderButton ? [folderButton] : []));
    }
    serverGrid.replaceChildren(); localGrid.replaceChildren();
    privateGrid.replaceChildren();
    privateEmpty.hidden = !!privateProjects.length;
    privateEmpty.textContent = serverMapsError || (serverMapsLoaded ? 'No private server maps.' : 'Loading server maps…');
    for (const project of privateProjects) {
      const displayName = project.name.replace(/[_-]/g, ' ');
      const card = element('article', 'public-course public-map-tile'); card.setAttribute('aria-label', displayName);
      card.dataset.kind = 'private';
      const metadata = element('p', 'public-map-meta');
      metadata.append(element('span', 'public-private-badge', 'Private'), element('span', '', 'Saved on server'));
      const controls = element('div', 'public-card-actions');
      const edit = element('a', 'public-primary', 'Edit');
      edit.href = `${mapPath('editor', project.name)}?${new URLSearchParams({ project: project.id })}`;
      edit.setAttribute('aria-label', `Edit ${displayName}`); edit.prepend(publicGlyph('editor'));
      controls.append(edit); card.append(mapHeading(displayName, 'mountain'), metadata, controls); privateGrid.append(card);
    }
    const newMap = element('article', 'public-map-tile public-new-map'); newMap.setAttribute('aria-label', 'New map');
    newMap.append(mapHeading('New map', 'new'), element('span', 'public-local-note', 'Create on this device'));
    const createControls = element('div', 'public-card-actions');
    const create = element('a', 'public-primary', 'Create'); create.href = localEditorUrl('', 'new');
    create.setAttribute('aria-label', 'New map'); create.prepend(publicGlyph('new'));
    createControls.append(create); newMap.append(createControls);
    savedGrid.replaceChildren(newMap);
    for (const project of savedProjects) {
      const card = element('article', 'public-course public-map-tile'); card.setAttribute('aria-label', project.name);
      card.dataset.kind = 'local';
      card.append(mapHeading(project.name, 'mountain'));
      const controls = element('div', 'public-card-actions');
      const edit = element('a', 'public-primary', 'Edit'); edit.href = localEditorUrl(project.name, project.id);
      edit.setAttribute('aria-label', `Edit ${project.name}`); edit.prepend(publicGlyph('editor'));
      const remove = element('button', 'public-delete', 'Delete'); remove.type = 'button';
      remove.setAttribute('aria-label', `Delete ${project.name}`);
      remove.addEventListener('click', () => { void deleteSavedMap(project, remove); });
      controls.append(edit, remove); card.append(controls); savedGrid.append(card);
    }
    serverEmpty.hidden = !!groups.server.length; localEmpty.hidden = !!groups.local.length;
    for (const [courses, grid] of [
      [groups.server, serverGrid], [groups.local, localGrid],
    ] as const) {
      for (const course of courses) {
        const missing = course.isoCourses.some(slot => !cached.includes(slot));
        const displayName = course.name.replace(/[_-]/g, ' ');
        const card = element('article', 'public-course public-map-tile'); card.setAttribute('aria-label', displayName);
        card.dataset.kind = course.kind;
        card.append(mapHeading(displayName, course.kind === 'project' ? 'mountain' : 'disc'));
        if (missing) card.append(element('span', 'public-requirements',
          course.kind === 'project' ? 'ISO optional' : 'ISO needed'));
        if (course.isoCourses.length) card.append(isoStatusBadges(course.isoCourses, cached));
        const message = cardMessages.get(`${course.kind}:${course.id}`);
        if (message) {
          const feedback = element('p', 'public-card-status', message); feedback.setAttribute('role', 'status'); card.append(feedback);
        }
        const controls = element('div', 'public-card-actions');
        const open = element('button', 'public-primary', 'Open'); open.type = 'button';
        open.prepend(publicGlyph('view'));
        open.setAttribute('aria-label', `Open ${displayName}`);
        open.disabled = preparing || (course.kind === 'reference' && missing);
        open.addEventListener('click', () => {
          if (preparing) return;
          selected = course;
          void load();
        });
        controls.append(open);
        const edit = element('a', '', course.kind === 'project' ? 'Edit' : 'Inspect');
        edit.href = courseEditorUrl(course);
        edit.setAttribute('aria-label', `${course.kind === 'project' ? 'Edit' : 'Inspect'} ${displayName}`);
        edit.prepend(publicGlyph(course.kind === 'project' ? 'editor' : 'view'));
        controls.append(edit);
        if (missing || message) {
          const manageIso = element('a', '', 'Load ISO maps'); manageIso.href = isoManagementUrl(course);
          manageIso.prepend(publicGlyph('load'));
          controls.append(manageIso);
        }
        card.append(controls);
        grid.append(card);
      }
    }
  }
  async function deleteSavedMap(project: ClientProject, button: HTMLButtonElement) {
    button.disabled = true;
    try {
      if (!await confirmAction({
        title: `Delete ${project.name}?`,
        body: 'This deletes the browser copy and its custom assets. Folder copies and downloaded backups are kept.',
        confirmLabel: 'Delete', danger: true,
      })) return;
      await deleteLocalProject(project.id);
      await refreshLocalMaps();
      savedGrid.querySelector<HTMLElement>('a')?.focus();
    } catch (error) {
      savedNote.textContent = `Could not delete ${project.name}: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      button.disabled = false;
      if (button.isConnected) button.focus();
    }
  }
  renderCourses();
  async function refreshLocalMaps() {
    try {
      savedProjects = await listLocalProjects();
      savedNote.textContent = 'Saved on this device.';
      renderCourses();
    } catch {
      savedNote.textContent = 'Browser storage is unavailable. Allow site storage to save local maps.';
    }
  }
  await refreshLocalMaps();
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    // A returned member catalogue must re-check sign-in and reflect server edits/publication changes.
    if (member && !linked) location.reload();
    else void refreshLocalMaps();
  });

  const chat = createChatBox({ docked: true, say: text => session.say(text), me: () => me,
    suspended: () => !joined || !chatVisible || !player });
  chat.el.id = 'public-chat'; chat.el.hidden = true;
  const chatEntry = chat.el.querySelector<HTMLElement>('.sp-chat-entry')!;
  const chatLog = chat.el.querySelector<HTMLElement>('.sp-chat-log')!;
  const chatInput = chatEntry.querySelector('input')!;
  chatInput.enterKeyHint = 'send';
  chatInput.placeholder = 'Say something…'; chatInput.disabled = true;
  const chatStatus = element('p', 'public-chat-status');
  chat.el.insertBefore(chatStatus, chat.el.children[1]);
  const identity = element('form', 'public-chat-join');
  const invite = element('p', '', 'Play locally, or join chat and other riders.');
  const nameLabel = element('label', '');
  nameLabel.append(element('span', 'public-visually-hidden', 'Your rider name'));
  const name = element('input', ''); name.name = 'name'; name.maxLength = 24; name.required = true;
  name.setAttribute('autocomplete', 'nickname'); name.placeholder = 'Rider name'; nameLabel.append(name);
  nameLabel.hidden = !!member; name.disabled = !!member;
  const join = element('button', 'public-iso-button', member ? `Join as ${member.username}` : 'Join chat'); join.type = 'submit';
  const who = element('p', 'public-who'); who.setAttribute('role', 'status');
  identity.append(invite, nameLabel, join, who);
  const inviteFriends = element('button', 'public-iso-button', 'Invite friends');
  inviteFriends.hidden = true;
  inviteFriends.type = 'button';
  inviteFriends.addEventListener('click', () => {
    if (!selected) return;
    friendRoom ??= crypto.randomUUID().replaceAll('-', '');
    const link = playUrl(selected);
    history.replaceState(history.state, '', link);
    session.setPlayRoom(friendRoom);
    const copied = navigator.clipboard?.writeText(link) ?? Promise.reject(new Error('Clipboard unavailable'));
    void copied.then(() => { inviteFriends.textContent = 'Link copied'; })
      .catch(() => { chatStatus.textContent = 'Share the link in your address bar to invite friends.'; });
  });
  chat.el.append(inviteFriends);
  chat.el.insertBefore(identity, chatLog);
  chatEntry.hidden = chatLog.hidden = true;
  function showChat(visible: boolean) {
    chatVisible = visible;
    chat.el.hidden = !visible;
    document.body.classList.toggle('public-chat-visible', visible);
    const label = visible ? 'Leave chat' : 'Show chat';
    toggleChat.replaceChildren(publicGlyph(visible ? 'leaveChat' : 'chat'), element('span', 'public-chat-toggle-label', label));
    toggleChat.setAttribute('aria-label', label); toggleChat.title = label;
    toggleChat.setAttribute('aria-expanded', String(visible));
    window.dispatchEvent(new Event('resize'));
  }
  function leaveChat() {
    joinAttempt++;
    joined = false; me = null;
    session.close(); chat.close(); chat.replay([]);
    presence = {}; peers.clear(); refreshPeers();
    chatInput.value = ''; chatInput.disabled = true;
    chatEntry.hidden = chatLog.hidden = true; identity.hidden = false;
    chatStatus.textContent = ''; who.textContent = ''; join.disabled = false;
  }
  toggleChat.addEventListener('click', () => {
    if (chatVisible) leaveChat();
    showChat(!chatVisible);
  });
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
    onWelcome(welcome) {
      if (!joined) return;
      inviteFriends.hidden = !session.usesPlayRelay();
      me = welcome.member; session.watch(room);
      chatInput.disabled = false;
      chatStatus.textContent = `Connected as ${me.username}`;
    },
    onPresence(maps) { if (joined) { presence = maps; refreshPeers(); } },
    onAware(peer) { if (joined) { peers.set(peer.sessionId, { ...peer, ...peer.aware }); refreshPeers(); } },
    onChat: line => { if (joined) chat.push(line); }, onChatHistory: lines => { if (joined) chat.replay(lines); },
    onRideEvent: event => { if (joined) player?.rideEvent(event); },
    onCapacityRefused: message => { chatStatus.textContent = message; },
    onStatus: state => {
      if (!joined) return;
      chatInput.disabled = true;
      chatStatus.dataset.state = state; chatStatus.textContent = 'Connecting…';
      if (state !== 'open') { presence = {}; peers.clear(); refreshPeers(); }
    },
    onAccessChanged: reason => { leaveChat(); who.textContent = reason; },
  });
  identity.addEventListener('submit', event => {
    if (!player || !chatVisible || joined) { event.preventDefault(); return; }
    event.preventDefault(); join.disabled = true;
    const attempt = ++joinAttempt;
    const identityRequest = member ? Promise.resolve({ member })
      : publicJson<{ member: SessionMember }>('/api/public/guest', { name: name.value });
    void identityRequest.then(result => {
      if (attempt !== joinAttempt || !chatVisible) return;
      me = result.member; joined = true;
      identity.hidden = true; chatEntry.hidden = chatLog.hidden = false;
      session.start();
    }).catch(error => {
      if (attempt === joinAttempt) who.textContent = error instanceof Error ? error.message : String(error);
    }).finally(() => { if (attempt === joinAttempt) join.disabled = false; });
  });
  async function load() {
    if (!selected || preparing) return;
    const course = selected;
    const missing = course.isoCourses.some(slot => !cached.includes(slot));
    if (course.kind === 'reference' && missing) { location.href = isoManagementUrl(course); return; }
    preparing = true; renderCourses();
    try {
      if (course.kind === 'reference' && await needsCollisionSoundUpdate(course.isoCourses)) {
        const message = 'Choose your ISO once more to restore collision sounds.';
        cardMessages.set(`${course.kind}:${course.id}`, message);
        if (linked) status.textContent = message;
        return;
      }
      showRequirements();
      document.body.classList.remove('sp-page-background');
      document.body.classList.add('public-preparing');
      setMap(course.name.replace(/[_-]/g, ' '), playUrl(course));
      history.replaceState(history.state, '', playUrl(course));
      document.title = `${course.name} · Slopesmith`;
      main.classList.add('public-in-world');
      header.insertBefore(status, header.children[2]);
      header.insertBefore(actions, header.children[3]);
      header.insertBefore(requirements, actions);
      const { preparePublicPlayer } = await import('./player');
      player = await preparePublicPlayer(course, document.getElementById('viewport')!, session, {
        progress: text => { status.textContent = text; },
        onPlaying: playing => { mapControls.setPlaying(playing); stop.hidden = !playing; },
        onRideControls: help => mapControls.setRideControls(help),
        onStartChanged: custom => mapControls.setCustomStart(custom),
      });
      const known = published.some(entry => entry.kind === course.kind && entry.id === course.id);
      room = course.kind === 'project' ? course.id : known || isDiscCourse(course.id) ? referenceRoom(course.id) : null;
      session.watch(room);
      actions.hidden = false; mapControls.setPlaying(false);
      status.textContent = '';
      document.body.classList.add('public-ready');
      showChat(true);
      refreshPeers();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      if (main.classList.contains('public-in-world')) {
        main.append(status);
        document.body.classList.add('public-ready');
        status.textContent += ' Return to Maps to try again.';
      }
    } finally { preparing = false; renderCourses(); }
  }
  stop.addEventListener('click', () => player?.stop());
  try {
    const [data, projects] = await Promise.all([
      publicJson<{ courses: PublicCourse[]; guest: SessionMember | null }>('/api/public/courses'),
      member && !linked ? publicJson<{ projects: ClientProject[] }>('/api/projects').catch(error => {
        serverMapsError = `Could not load server maps: ${error instanceof Error ? error.message : String(error)}`;
        return null;
      }) : null,
    ]);
    serverProjects = projects?.projects ?? [];
    serverMapsLoaded = true;
    if (data.guest && !member) name.value = data.guest.username.replace(/ \(guest\)$/, '');
    published = data.courses;
    if (linked) selected = resolvePublicCourse(linked, published, cached);
    renderCourses();
    if (linked) showRequirements();
    if (linked && !selected) {
      title.classList.remove('public-visually-hidden'); title.textContent = 'Map unavailable';
      status.textContent = 'This map is private or deleted. Choose another map.';
    } else if (linked && selected) {
      history.replaceState(null, '', playUrl(selected));
      document.title = `${selected.name} · Slopesmith`;
      title.classList.remove('public-visually-hidden');
      title.textContent = selected.name.replace(/[_-]/g, ' ');
      privateSection.hidden = serverSection.hidden = savedSection.hidden = localSection.hidden = true;
      status.textContent = 'Loading map…';
    } else status.textContent = '';
    if (linked && selected) await load();
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
}
