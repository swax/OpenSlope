import './home.css';
import type { PublicCourse } from '../../core/session/public-courses';
import { referenceRoom } from '../../core/session/public-courses';
import { discCourseName, isDiscCourse } from '../../core/reference/disc-courses';
import { currentAccount } from '../net/account';
import { localEditorUrl } from '../navigation';
import { deleteLocalProject, listLocalProjects } from '../state/local-projects';
import type { ClientProject } from '../state/project-sync';
import type { PresenceEntry, SessionMember } from '../net/session-channel';
import { toast } from '../ui/components/toast';
import { confirmAction } from '../ui/components/prompts';
import { canSaveMountainFolder } from '../mountain/folder';
import { openLocalMountainFolder } from '../mountain/open-folder';
import type { PeerMarks } from '../viewport/scene/peers';
import { cachedIsoCourses, needsCollisionSoundUpdate } from './iso-cache';
import { publicCourseGroups, publicCourseLabel } from './course-list';
import { element, publicJson } from './dom';
import { publicHeader } from './header';
import { isoRequirements, isoStatusBadges } from './iso-status';
import { courseEditorUrl, isoManagementUrl, publicCourseRequest, publicCourseUrl, resolvePublicCourse } from './links';
import type { PublicPlayer } from './player';
import { mapHeading, publicGlyph } from './presentation';
import { setSiteCourse } from '../net/site-presence';
import { publicMapControls } from './map-controls';
import type { ChatActivity } from '../../core/session/chat-activity';
import { activityCounter, watchChatActivity } from './chat-activity';
import { publicAvatarPicker } from './avatar-picker';
import { createMapLibrary } from './map-library';

export async function showPublicHome(): Promise<void> {
  document.body.classList.add('public-play');
  document.getElementById('load-status')?.classList.remove('show');
  const account = await currentAccount();
  const offline = account.accounts === 'open' && account.offline;
  const member: SessionMember | null =
    'user' in account
      ? account.user
      : account.accounts === 'open' && !offline
        ? { id: 'owner', username: 'owner', role: 'admin' }
        : null;
  let player: PublicPlayer | null = null;
  let selected: PublicCourse | null = null;
  const linked = location.pathname.startsWith('/play') ? publicCourseRequest(new URL(location.href)) : null;
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
  let cached = await cachedIsoCourses().catch(() => [] as string[]);
  let savedProjects: ClientProject[] = [];
  const localCourses = (): PublicCourse[] =>
    savedProjects.map(project => ({
      id: project.id,
      localProjectId: project.id,
      kind: 'project',
      name: project.name,
      retailData: false,
      isoCourses: [],
    }));
  const privateCourse = (project: ClientProject): PublicCourse => ({
    id: project.id,
    kind: 'project',
    name: project.name,
    private: true,
    retailData: false,
    isoCourses: [],
  });
  const peers = new Map<string, PeerMarks>();
  let presence: Record<string, PresenceEntry[]> = {};

  const navigation = publicHeader('maps', account);
  const { header, iso: manage, setMap, syncIsoMaps, community } = navigation;
  syncIsoMaps(cached);
  const session = community.session;
  if (friendRoom) session.setPlayRoom(friendRoom);
  let activity: ChatActivity | null = null;
  const mapCounters = new Map<string, ReturnType<typeof activityCounter>[]>();
  const countOnMap = (id: string): number | null => (activity ? (activity.courses[id] ?? 0) : null);
  watchChatActivity(next => {
    activity = next;
    for (const [id, counters] of mapCounters) for (const counter of counters) counter.set(countOnMap(id));
  });
  function courseHeading(name: string, kind: 'mountain' | 'disc', id: string) {
    const heading = mapHeading(name, kind);
    const counter = activityCounter('map');
    counter.set(countOnMap(id));
    const counters = mapCounters.get(id) ?? [];
    counters.push(counter);
    mapCounters.set(id, counters);
    heading.append(counter.el);
    return heading;
  }
  document.title = linked ? 'Maps · Slopesmith' : 'Library · Slopesmith';
  const main = element('main', 'public-home');
  const title = element('h1', 'public-visually-hidden', 'Maps');
  const serverSection = element('section', 'public-server-maps');
  serverSection.setAttribute('aria-label', 'Public server maps');
  const serverTitle = element('h2', 'public-course-title', 'Public maps');
  const serverGrid = element('div', 'public-courses');
  serverGrid.setAttribute('aria-label', 'Public server maps');
  const serverEmpty = element('p', 'public-empty', 'No public maps yet.');
  if (offline) serverEmpty.textContent = 'Offline. Use your local maps and loaded ISO maps.';
  serverSection.append(serverTitle, serverGrid, serverEmpty);
  const privateSection = element('section', 'public-private-maps');
  privateSection.setAttribute('aria-label', 'Private server maps');
  const privateTitle = element('h2', 'public-course-title', 'Private server maps');
  const privateGrid = element('div', 'public-courses');
  privateGrid.setAttribute('aria-label', 'Private server maps');
  const privateEmpty = element('p', 'public-empty', 'Loading server maps…');
  privateEmpty.setAttribute('role', 'status');
  privateSection.append(privateTitle, privateGrid, privateEmpty);
  const savedSection = element('section', 'public-saved-maps');
  savedSection.setAttribute('aria-label', 'Local maps');
  const savedTitle = element('h2', 'public-course-title', 'Local maps');
  const savedNote = element('p', 'public-local-note', 'Saved in this browser.');
  savedNote.setAttribute('role', 'status');
  const savedGrid = element('div', 'public-courses');
  savedGrid.setAttribute('aria-label', 'Local maps');
  savedSection.append(savedTitle, savedNote, savedGrid);
  if (canSaveMountainFolder()) {
    const openFolder = element('button', 'public-open-folder', 'Open mountain folder…');
    openFolder.type = 'button';
    openFolder.addEventListener('click', () => {
      void openLocalMountainFolder().catch(error => {
        savedNote.textContent = error instanceof Error ? error.message : String(error);
      });
    });
    savedTitle.append(openFolder);
  }
  const localSection = element('section', 'public-local-maps');
  localSection.setAttribute('aria-label', 'Loaded ISO maps');
  const localTitle = element('h2', 'public-course-title', 'From your ISO');
  const localGrid = element('div', 'public-courses');
  localGrid.setAttribute('aria-label', 'Loaded ISO maps');
  const localEmpty = element('p', 'public-empty', 'No maps loaded.');
  localSection.append(localTitle, localGrid, localEmpty);
  const requirements = element('details', 'public-requirements-host');
  requirements.hidden = true;
  const status = element('p', 'public-status', 'Loading public maps…');
  status.setAttribute('role', 'status');
  const stop = element('button', 'public-stop', '');
  stop.type = 'button';
  stop.hidden = true;
  stop.setAttribute('aria-label', 'Exit play');
  stop.title = 'Exit play';
  stop.append(publicGlyph('stop'), element('span', 'public-stop-label', 'Exit'));
  header.append(stop);
  const mapControls = publicMapControls({
    play: () => {
      void player?.play().catch(showPlayerError);
    },
    vr: () => {
      void player?.vr().catch(showPlayerError);
    },
    inspect: () => {
      if (selected) location.href = courseEditorUrl(selected);
    },
    resetStart: () => player?.resetStart(),
  });
  function showPlayerError(error: unknown) {
    mapControls.error(error instanceof Error ? error.message : String(error));
  }
  const library = linked
    ? null
    : createMapLibrary(title, [
        ...(member ? [{ section: privateSection, grid: privateGrid, source: 'server' as const }] : []),
        { section: serverSection, grid: serverGrid, source: 'server' },
        { section: savedSection, grid: savedGrid, source: 'device' },
        { section: localSection, grid: localGrid, source: 'device' },
      ]);
  main.append(...(library ? [library.el] : [title, serverSection, savedSection, localSection]), requirements, status);
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
      summary.append(
        element('span', 'public-assets-label', 'Assets'),
        element('span', 'public-assets-count', `${loaded}/${total}`),
      );
      const assets = isoRequirements(selected, cached);
      if (loaded < total && selected.kind === 'project')
        assets.querySelector('p')!.textContent = 'ISO textures/props omitted for unloaded maps.';
      requirements.append(summary, assets);
    }
  }
  document.addEventListener('pointerdown', event => {
    if (!requirements.contains(event.target as Node)) requirements.open = false;
  });
  requirements.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      requirements.open = false;
      requirements.querySelector('summary')?.focus();
    }
  });
  function renderCourses() {
    mapCounters.clear();
    const groups = publicCourseGroups(published, cached);
    const publicIds = new Set(published.filter(course => course.kind === 'project').map(course => course.id));
    const privateProjects = serverProjects.filter(project => !publicIds.has(project.id));
    for (const [heading, label, count] of [
      [serverTitle, 'Public maps', groups.server.length],
      [privateTitle, 'Private server maps', privateProjects.length],
      [savedTitle, 'Local maps', savedProjects.length],
      [localTitle, 'From your ISO', groups.local.length],
    ] as const) {
      const total = element('span', 'public-section-count', String(count));
      total.setAttribute('aria-hidden', 'true');
      const folderButton = heading.querySelector('.public-open-folder');
      heading.replaceChildren(document.createTextNode(label), total, ...(folderButton ? [folderButton] : []));
    }
    serverGrid.replaceChildren();
    localGrid.replaceChildren();
    privateGrid.replaceChildren();
    privateEmpty.hidden = !!privateProjects.length;
    privateEmpty.textContent =
      serverMapsError || (serverMapsLoaded ? 'No private server maps.' : 'Loading server maps…');
    for (const project of privateProjects) {
      const displayName = project.name.replace(/[_-]/g, ' ');
      const card = element('article', 'public-course public-map-tile');
      card.setAttribute('aria-label', displayName);
      card.dataset.kind = 'private';
      const metadata = element('p', 'public-map-meta');
      metadata.append(element('span', 'public-private-badge', 'Private'), element('span', '', 'Saved on server'));
      const controls = element('div', 'public-card-actions');
      const play = element('a', 'public-primary', 'Play');
      play.href = playUrl(privateCourse(project));
      play.setAttribute('aria-label', `Play ${displayName}`);
      play.prepend(publicGlyph('play'));
      const edit = element('a', '', 'Edit');
      edit.href = courseEditorUrl(privateCourse(project));
      edit.setAttribute('aria-label', `Edit ${displayName}`);
      edit.prepend(publicGlyph('editor'));
      controls.append(play, edit);
      card.append(courseHeading(displayName, 'mountain', project.id), metadata, controls);
      privateGrid.append(card);
    }
    const newMap = element('article', 'public-map-tile public-new-map');
    newMap.setAttribute('aria-label', 'New map');
    newMap.append(mapHeading('New map', 'new'), element('span', 'public-local-note', 'Create on this device'));
    const createControls = element('div', 'public-card-actions');
    const create = element('a', 'public-tile-link', 'Create');
    create.href = localEditorUrl('', 'new');
    create.setAttribute('aria-label', 'New map');
    create.prepend(publicGlyph('new'));
    createControls.append(create);
    newMap.append(createControls);
    savedGrid.replaceChildren(newMap);
    for (const project of savedProjects) {
      const card = element('article', 'public-course public-map-tile');
      card.setAttribute('aria-label', project.name);
      card.dataset.kind = 'local';
      card.append(mapHeading(project.name, 'mountain'));
      const controls = element('div', 'public-card-actions');
      const edit = element('a', '', 'Edit');
      edit.href = localEditorUrl(project.name, project.id);
      const open = element('a', 'public-primary', 'Play');
      open.href = publicCourseUrl(localCourses().find(course => course.id === project.id)!);
      open.setAttribute('aria-label', `Play ${project.name}`);
      open.prepend(publicGlyph('play'));
      edit.setAttribute('aria-label', `Edit ${project.name}`);
      edit.prepend(publicGlyph('editor'));
      const remove = element('button', 'public-delete', 'Delete');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Delete ${project.name}`);
      remove.addEventListener('click', () => {
        void deleteSavedMap(project, remove);
      });
      controls.append(open, edit, remove);
      card.append(controls);
      savedGrid.append(card);
    }
    serverEmpty.hidden = !!groups.server.length;
    localEmpty.hidden = !!groups.local.length;
    for (const [courses, grid] of [
      [groups.server, serverGrid],
      [groups.local, localGrid],
    ] as const) {
      for (const course of courses) {
        const missing = course.isoCourses.some(slot => !cached.includes(slot));
        const displayName = publicCourseLabel(course);
        const card = element('article', 'public-course public-map-tile');
        card.setAttribute('aria-label', displayName);
        card.dataset.kind = course.kind;
        card.dataset.course = course.id;
        card.append(
          courseHeading(
            displayName,
            course.kind === 'project' ? 'mountain' : 'disc',
            course.kind === 'reference' ? referenceRoom(course.id) : course.id,
          ),
        );
        if (missing)
          card.append(
            element('span', 'public-requirements', course.kind === 'project' ? 'ISO optional' : 'ISO needed'),
          );
        if (course.isoCourses.length) card.append(isoStatusBadges(course.isoCourses, cached));
        const message = cardMessages.get(`${course.kind}:${course.id}`);
        if (message) {
          const feedback = element('p', 'public-card-status', message);
          feedback.setAttribute('role', 'status');
          card.append(feedback);
        }
        const controls = element('div', 'public-card-actions');
        const open = element('button', 'public-primary', 'Play');
        open.type = 'button';
        open.prepend(publicGlyph('play'));
        open.setAttribute('aria-label', `Play ${displayName}`);
        open.disabled = preparing || (course.kind === 'reference' && missing);
        open.addEventListener('click', () => {
          if (preparing) return;
          location.href = playUrl(course);
        });
        controls.append(open);
        const edit = element('a', '', course.kind === 'project' ? 'Edit' : 'Inspect');
        edit.href = courseEditorUrl(course);
        edit.setAttribute('aria-label', `${course.kind === 'project' ? 'Edit' : 'Inspect'} ${displayName}`);
        edit.prepend(publicGlyph(course.kind === 'project' ? 'editor' : 'view'));
        controls.append(edit);
        if (missing || message) {
          const manageIso = element('a', '', 'Load ISO maps');
          manageIso.href = isoManagementUrl(course);
          manageIso.prepend(publicGlyph('load'));
          controls.append(manageIso);
        }
        card.append(controls);
        grid.append(card);
      }
    }
    library?.update();
  }
  async function deleteSavedMap(project: ClientProject, button: HTMLButtonElement) {
    button.disabled = true;
    try {
      if (
        !(await confirmAction({
          title: `Delete ${project.name}?`,
          body: 'This deletes the browser copy and its custom assets. Folder copies and downloaded backups are kept.',
          confirmLabel: 'Delete',
          danger: true,
        }))
      )
        return;
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
  if (library) {
    let inventoryKey = JSON.stringify(cached.map(id => [id, discCourseName(id)]));
    const { showIsoPage } = await import('./iso-page');
    const importer = await showIsoPage({
      host: library.gameHost,
      gamesHost: library.gamesHost,
      summaryHost: library.summaryHost,
      account,
      navigation,
      onSelect: library.selectGame,
      onInventory: next => {
        const key = JSON.stringify(next.map(id => [id, discCourseName(id)]));
        if (key === inventoryKey) return;
        inventoryKey = key;
        cached = [...next];
        renderCourses();
      },
    });
    library.connect(importer);
  }
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    // A returned member catalogue must re-check sign-in and reflect server edits/publication changes.
    if (member && !linked) location.reload();
    else void refreshLocalMaps();
  });

  function refreshPeers() {
    if (!selected || !player) return;
    const entries =
      selected.kind === 'project'
        ? (presence[selected.id] ?? [])
        : Object.values(presence)
            .flat()
            .filter(
              entry =>
                entry.referenceLevel?.toUpperCase() === selected!.id.toUpperCase() && entry.playing === 'reference',
            );
    const here = new Set(entries.map(entry => entry.sessionId));
    player.peers(
      [...peers.values()].filter(peer => here.has(peer.sessionId) && peer.sessionId !== session.sessionId()),
    );
  }
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
    void copied
      .then(() => {
        inviteFriends.textContent = 'Link copied';
      })
      .catch(() => {
        status.textContent = 'Share the link in your address bar to invite friends.';
      });
  });
  community.actions.append(inviteFriends);
  // Left of Leave chat. The choice applies to our rider at once, mid-run included.
  const avatar = publicAvatarPicker(account, id => player?.setAvatar(id));
  community.actions.prepend(avatar.el);
  community.setHooks({
    userActions: member =>
      player?.canGoToPlayer(member.id)
        ? [
            {
              label: 'Go to player',
              desc: `Move to ${member.username}'s live position on this map.`,
              onClick: () => {
                if (!player?.goToPlayer(member.id)) toast('That player is no longer available.', 'info');
              },
            },
          ]
        : [],
    onWelcome() {
      inviteFriends.hidden = !session.usesPlayRelay();
    },
    onPresence(maps) {
      presence = maps;
      refreshPeers();
    },
    onAware(peer) {
      peers.set(peer.sessionId, { ...peer, ...peer.aware });
      refreshPeers();
    },
    onRideEvent: event => {
      player?.rideEvent(event);
    },
    onStatus(state) {
      if (state !== 'open' && !session.usesPlayRelay()) {
        presence = {};
        peers.clear();
        refreshPeers();
      }
    },
    onAccessChanged(reason) {
      session.watch(null);
      setSiteCourse(null);
      status.textContent = reason;
    },
  });
  async function load() {
    if (!selected || preparing) return;
    const course = selected;
    const missing = course.isoCourses.some(slot => !cached.includes(slot));
    if (course.kind === 'reference' && missing) {
      location.href = isoManagementUrl(course);
      return;
    }
    const knownCourse = published.some(entry => entry.kind === course.kind && entry.id === course.id);
    room =
      course.localProjectId || course.private
        ? null
        : course.kind === 'project'
          ? course.id
          : knownCourse || isDiscCourse(course.id)
            ? referenceRoom(course.id)
            : null;
    if (!offline) setSiteCourse(room, course.source ?? 'server');
    if (!course.localProjectId && !course.private && !offline) {
      session.watch(room);
      session.start();
    }
    preparing = true;
    renderCourses();
    try {
      showRequirements();
      if (course.kind === 'reference' && (await needsCollisionSoundUpdate(course.isoCourses))) {
        const message = 'Choose your ISO once more to restore collision sounds.';
        cardMessages.set(`${course.kind}:${course.id}`, message);
        if (linked) {
          const repair = element('a', '', 'Load ISO maps');
          repair.href = isoManagementUrl(course);
          status.replaceChildren(document.createTextNode(`${message} `), repair);
        }
        return;
      }
      mapControls.setMapType(course.kind);
      document.body.classList.remove('sp-page-background');
      document.body.classList.add('public-preparing');
      setMap(
        publicCourseLabel(course),
        playUrl(course),
        courseEditorUrl(course),
        course.kind === 'reference' ? course.isoCourses : [],
      );
      history.replaceState(history.state, '', playUrl(course));
      document.title = `${course.name} · Slopesmith`;
      main.classList.add('public-in-world');
      header.insertBefore(requirements, header.children[2]);
      header.insertBefore(status, stop);
      const { preparePublicPlayer } = await import('./player');
      player = await preparePublicPlayer(course, document.getElementById('viewport')!, session, {
        progress: text => {
          status.textContent = text;
        },
        onPlaying: playing => {
          mapControls.setPlaying(playing);
          stop.hidden = !playing;
        },
        onRideControls: help => mapControls.setRideControls(help),
        onStartChanged: custom => mapControls.setCustomStart(custom),
        avatar: avatar.current(),
      });
      player.setAvatar(avatar.current()); // in case the saved choice arrived while the map loaded
      const known = published.some(entry => entry.kind === course.kind && entry.id === course.id);
      room =
        course.localProjectId || course.private
          ? null
          : course.kind === 'project'
            ? course.id
            : known || isDiscCourse(course.id)
              ? referenceRoom(course.id)
              : null;
      if (!course.localProjectId && !course.private && !offline) session.watch(room);
      inviteFriends.hidden = !session.usesPlayRelay();
      mapControls.setPlaying(false);
      status.textContent = '';
      document.body.classList.add('public-ready');
      refreshPeers();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      if (main.classList.contains('public-in-world')) {
        main.append(status);
        document.body.classList.add('public-ready');
        status.textContent += ' Return to Maps to try again.';
      }
    } finally {
      preparing = false;
      renderCourses();
    }
  }
  stop.addEventListener('click', () => player?.stop());
  try {
    // Local links resolve before any server request, including when a connection hangs rather than rejects.
    selected =
      linked?.localProjectId || linked?.source === 'iso' || offline
        ? resolvePublicCourse(linked, [], cached, localCourses())
        : null;
    if (linked && selected) {
      document.title = `${selected.name} · Slopesmith`;
      privateSection.hidden = serverSection.hidden = savedSection.hidden = localSection.hidden = true;
      await load();
      return;
    }
    const [data, projects] = await Promise.all([
      offline
        ? { courses: [] }
        : publicJson<{ courses: PublicCourse[]; guest: SessionMember | null }>('/api/public/courses').catch(() => {
            serverEmpty.textContent = 'Server unavailable. Use your local maps and loaded ISO maps.';
            return { courses: [] };
          }),
      member && (!linked || (linked.kind === 'project' && !linked.localProjectId))
        ? publicJson<{ projects: ClientProject[] }>('/api/projects').catch(error => {
            serverMapsError = `Could not load server maps: ${error instanceof Error ? error.message : String(error)}`;
            return null;
          })
        : null,
    ]);
    serverProjects = projects?.projects ?? [];
    serverMapsLoaded = true;
    published = data.courses;
    if (linked)
      selected = resolvePublicCourse(
        linked,
        [...published, ...serverProjects.map(privateCourse)],
        cached,
        localCourses(),
      );
    renderCourses();
    if (linked) showRequirements();
    if (linked && !selected) {
      title.classList.remove('public-visually-hidden');
      title.textContent = 'Map unavailable';
      status.textContent = 'This map is private or deleted. Choose another map.';
    } else if (linked && selected) {
      history.replaceState(null, '', playUrl(selected));
      document.title = `${selected.name} · Slopesmith`;
      title.classList.remove('public-visually-hidden');
      title.textContent = publicCourseLabel(selected);
      privateSection.hidden = serverSection.hidden = savedSection.hidden = localSection.hidden = true;
      status.textContent = 'Loading map…';
    } else status.textContent = '';
    if (linked && selected) await load();
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
}
