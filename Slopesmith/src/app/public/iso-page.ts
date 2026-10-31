import './home.css';
import type { PublicCourse } from '../../core/session/public-courses';
import { referenceRoom } from '../../core/session/public-courses';
import type { ChatActivity } from '../../core/session/chat-activity';
import { activityCounter, watchChatActivity } from './chat-activity';
import { discContainsCourse, discCourseName, importedDiscCourseNames } from '../../core/reference/disc-courses';
import { importedCourseLayouts, isoCourseVisible } from '../../core/reference/course-layout';
import { currentAccount } from '../net/account';
import {
  cachedIsoCourses,
  clearIsoCache,
  closeIsoImporterSessions,
  importIso,
  scanIso,
  unloadIsoCourse,
} from './iso-cache';
import { element, publicJson } from './dom';
import { publicHeader } from './header';
import { isoStatusBadges } from './iso-status';
import { createIsoLoadQueue } from './iso-load-queue';
import { courseEditorUrl, publicCourseRequest, publicCourseUrl, resolvePublicCourse } from './links';
import { mapAvailability, mapHeading, publicGlyph } from './presentation';
import { libraryGameCourses } from './library-courses';
import type { LibraryFilter } from './map-library';
import { mapGame, mapGameLabel } from '../../core/reference/map-game';
import { confirmAction } from '../ui/components/prompts';
import { EDITOR_PATH } from '../navigation';
import type { Account } from '../net/account';
import { beforeAppUpdate } from '../offline';
import { referenceForCourse, removeReference } from './reference-upload';
import { createReferenceLibrary, type ReferenceLibrary } from './reference-library';
import {
  ISO_GAMES,
  clearSavedIsoDiscs,
  isoGameForCourse,
  saveIsoDisc,
  savedIsoDiscs,
  removeSavedIsoDisc,
  type IsoGame,
  type SavedIsoDisc,
} from './iso-discs';

const SELECTED_GAME = 'slopesmith.isoGame';

/** Disc files and extraction stay on this device; this page needs no member or guest session. */
export type IsoLibraryOptions = {
  host: HTMLElement;
  gamesHost: HTMLElement;
  summaryHost: HTMLElement;
  account: Account;
  navigation: ReturnType<typeof publicHeader>;
  references?: ReferenceLibrary;
  published?: () => readonly PublicCourse[];
  playUrl?: (course: PublicCourse) => string;
  onMapsChanged?: () => void;
  onSelect: (game: IsoGame) => void;
  onInventory: (cached: string[]) => void;
};

export async function showIsoPage(options?: IsoLibraryOptions) {
  if (!options) document.body.classList.add('public-play', 'public-iso-page', 'sp-page-background');
  document.getElementById('load-status')?.classList.remove('show');
  if (!options) document.title = 'ISO · Slopesmith';
  const account = options?.account ?? (await currentAccount());
  const admin =
    ('user' in account && account.user.role === 'admin') || (account.accounts === 'open' && !account.offline);
  const referenceLibrary = options?.references ?? createReferenceLibrary();
  let referenceDialog = false;
  let transferringReference = false;
  const referenceMessages = new Map<string, string>();
  let cached = await cachedIsoCourses().catch(() => [] as string[]);
  const discs = new Map<IsoGame, SavedIsoDisc & { saved: boolean }>(
    (await savedIsoDiscs().catch(() => [] as SavedIsoDisc[])).map(disc => [disc.game, { ...disc, saved: true }]),
  );
  let selectedGame: IsoGame =
    ISO_GAMES.find(game => discs.has(game.id) || cached.some(slot => isoGameForCourse(slot) === game.id))?.id ??
    'tricky';
  try {
    const remembered = sessionStorage.getItem(SELECTED_GAME) as IsoGame;
    if (discs.has(remembered) || cached.some(slot => isoGameForCourse(slot) === remembered)) selectedGame = remembered;
  } catch {
    /* Selection is optional; the saved discs remain available. */
  }
  let busy = false;
  let scanning = false;
  let confirmingLeave = false;
  let confirmingClear = false;
  let leaving = false;
  let abort: AbortController | null = null;
  let target: PublicCourse | null = null;
  let mapFilter: 'all' | 'loaded' | 'missing' = 'all';
  let allMapTypes = false;
  let searchQuery = '';
  const { header, setEditor, syncIsoMaps } = options?.navigation ?? publicHeader('iso', account);
  const main = element('section', options ? 'library-game-panel' : 'public-home');
  const title = element('h1', 'public-iso-title', 'Disc maps');
  const intro = element(
    'p',
    'public-local-note',
    `Choose a disc or GBA ROM, then load the maps you want to Play or Inspect. Source files stay on this device.${admin ? ' Use Reference to upload a loaded map to the server.' : ' Maps stay in this browser on this device.'}`,
  );
  const dependencies = element('section', 'public-iso-requirements');
  dependencies.hidden = true;
  dependencies.setAttribute('aria-label', 'Required ISO maps');
  const iso = element('section', 'public-iso');
  const input = element('input', '');
  input.type = 'file';
  input.accept = '.iso,.bin,.gcm,.rvz,.gba';
  input.id = 'public-iso';
  const label = element('label', 'public-iso-button', 'Choose disc');
  label.htmlFor = input.id;
  label.prepend(publicGlyph('disc'));
  label.title =
    'SSX PS2 games, SSX Tricky GBA, Jonny Moseley Mad Trix USA PS2 or 1080° Avalanche USA · Choose ISO, BIN, GCM, RVZ or GBA · Files stay on this device';
  const count = element('span', 'public-cache');
  const totalLoaded = element('strong', '');
  count.append(element('span', '', 'Maps across all games'), totalLoaded);
  const clear = element('button', 'public-clear', 'Clear all');
  clear.type = 'button';
  clear.setAttribute('aria-label', 'Clear all ISO maps');
  const loadRequired = element('button', 'public-primary', 'Load required maps');
  loadRequired.type = 'button';
  loadRequired.hidden = true;
  const cancel = element('button', '', 'Cancel scan');
  cancel.type = 'button';
  cancel.hidden = true;
  const actions = element('div', 'public-iso-actions');
  actions.append(label, input, count, loadRequired, clear, cancel);
  const status = element('p', 'public-iso-status');
  status.setAttribute('role', 'status');
  const sourceNote = element('p', 'library-source-file');
  const sourceActions = element('div', 'library-source-actions');
  const refreshImage = element('button', '', 'Refresh image');
  refreshImage.title = 'Rescan course names and the map list without re-extracting courses';
  const removeImage = element('button', '', 'Remove image…');
  removeImage.title = 'Forget this saved image and keep imported courses';
  const unloadGame = element('button', '', 'Unload game…');
  unloadGame.title = 'Remove this image and its imported courses from this browser';
  for (const button of [refreshImage, removeImage, unloadGame]) button.type = 'button';
  sourceActions.append(refreshImage, removeImage, unloadGame);
  const support = element('section', 'public-iso-support');
  support.setAttribute('aria-label', 'Disc game support');
  support.append(element('h2', '', 'Games'));
  const supportList = element('dl', '');
  const gameButtons = new Map<
    IsoGame,
    { item: HTMLElement; button: HTMLButtonElement; state: HTMLElement; detail: HTMLElement }
  >();
  for (const game of ISO_GAMES) {
    const item = element('div', 'public-iso-game-card');
    const name = element('dt', '');
    const button = element('button', 'public-iso-game', game.name);
    button.type = 'button';
    button.dataset.game = game.id;
    button.setAttribute('aria-label', game.name);
    if (options) {
      const count = element('span', 'library-game-count');
      count.setAttribute('aria-hidden', 'true');
      button.append(count);
    }
    button.setAttribute('aria-controls', 'public-iso-maps');
    button.onclick = () => {
      selectGame(game.id);
      status.textContent = '';
      render();
    };
    name.append(button);
    const state = element('dd', 'public-iso-game-state');
    const detail = element('dd', 'public-iso-game-detail');
    item.append(name, state, detail, element('dd', 'public-iso-game-support', game.support));
    gameButtons.set(game.id, { item, button, state, detail });
    supportList.append(item);
  }
  support.append(
    supportList,
    element(
      'p',
      'public-local-note',
      'A saved disc makes its maps available to load. Only loaded maps are ready to Play or Inspect. Unloading a map keeps the saved disc.',
    ),
    element(
      'p',
      '',
      'SSX support is still incomplete. SSX 3, On Tour and 1080° Avalanche are early imports with missing features and possible map issues. Mad Trix includes terrain with baked colored lighting, sky, adapted grind strips, blinking sign panels, scrolling Las Vegas waterfalls, source ski sounds and the original music tracks. Animation timing and full-track music looping are adaptations; other props, sky lighting and events remain incomplete. Missing riding sounds can use a Tricky map loaded in this browser.',
    ),
  );
  iso.append(actions, support, ...(options ? [sourceNote] : []), status);
  const mapHeader = element('div', 'public-iso-map-header');
  const heading = element('h2', '', 'Maps');
  const mapSummary = element('p', 'public-iso-map-summary');
  mapHeader.append(heading, mapSummary);
  const typeFilter = element('label', 'public-local-note');
  const showAllTypes = element('input', '');
  showAllTypes.type = 'checkbox';
  showAllTypes.setAttribute('aria-label', 'Show all SSX 3 map types');
  showAllTypes.onchange = () => {
    allMapTypes = showAllTypes.checked;
    render();
  };
  typeFilter.append(showAllTypes, document.createTextNode(' Include stations, connectors and peak bundles'));
  mapHeader.append(typeFilter);
  const filters = element('div', 'public-iso-filters');
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', 'Filter ISO maps');
  const filterButtons = new Map<'all' | 'loaded' | 'missing', HTMLButtonElement>();
  for (const [value, name] of [
    ['all', 'All maps'],
    ['loaded', 'Loaded'],
    ['missing', 'Not loaded'],
  ] as const) {
    const button = element('button', '', name);
    button.type = 'button';
    button.setAttribute('aria-controls', 'public-iso-maps');
    button.onclick = () => {
      mapFilter = value;
      render();
    };
    filterButtons.set(value, button);
    filters.append(button);
  }
  const rows = element('div', 'public-iso-map-list');
  rows.id = 'public-iso-maps';
  const empty = element('p', 'public-empty');
  main.append(title, intro, dependencies, iso, mapHeader, filters, rows, empty, sourceActions);
  if (options) {
    rows.remove();
    title.hidden = intro.hidden = true;
    options.host.append(main);
    options.gamesHost.append(support);
    options.summaryHost.append(count);
    const storage = element('details', 'library-storage');
    storage.append(element('summary', '', 'Device storage'), clear);
    options.gamesHost.append(storage);
  } else document.body.append(header, main);
  const cards = new Map<string, ReturnType<typeof createCard>>();
  let activity: ChatActivity | null = null;
  const stopActivity = watchChatActivity(next => {
    activity = next;
    for (const [slot, card] of cards) card.online.set(next ? (next.courses[referenceRoom(slot)] ?? 0) : null);
  });
  let dependencyState = '';
  let libraryFilter: LibraryFilter = { game: options ? null : selectedGame, query: '', source: 'all', enabled: true };
  let filterKey = '';

  const loads = createIsoLoadQueue(async (selectedFile, slot, progress, signal) => {
    try {
      await importIso(selectedFile, [slot], progress, signal);
    } catch (error) {
      await unloadIsoCourse(slot);
      throw error;
    } finally {
      cached = await cachedIsoCourses().catch(() => cached);
    }
  }, render);

  const uploads = referenceLibrary.uploads;
  referenceLibrary.subscribe(render);
  const loadingIso = () => scanning || loads.busy || uploads.busy;
  beforeAppUpdate(() => {
    if (busy || loadingIso()) throw new Error('Wait for ISO loading to finish, or cancel it, before reloading.');
  });
  function selectGame(game: IsoGame) {
    if (selectedGame !== game) mapFilter = 'all';
    selectedGame = game;
    if (!options) libraryFilter.game = game;
    options?.onSelect(game);
    try {
      sessionStorage.setItem(SELECTED_GAME, game);
    } catch {
      /* optional */
    }
  }
  const sourceFor = (slot: string) => {
    const disc = discs.get(isoGameForCourse(slot));
    return disc && discContainsCourse(disc.courses, slot) ? disc : undefined;
  };
  function confirmUnload(event: BeforeUnloadEvent) {
    if (leaving || !loadingIso()) return;
    event.preventDefault();
    event.returnValue = ''; // Browsers supply their own wording for refresh, Back and tab-close warnings.
  }
  function confirmNavigation(event: MouseEvent) {
    if (
      leaving ||
      !loadingIso() ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (
      !link ||
      link.hasAttribute('download') ||
      link.getAttribute('href')?.startsWith('#') ||
      (link.target && link.target.toLowerCase() !== '_self')
    )
      return;
    const destination = new URL(link.href);
    if (!['http:', 'https:'].includes(destination.protocol)) return;
    if (
      destination.origin === location.origin &&
      destination.pathname === location.pathname &&
      destination.search === location.search &&
      destination.hash
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (confirmingLeave) return;
    confirmingLeave = true;
    void confirmAction({
      title:
        transferringReference || uploads.busy ? 'Leave while reference is uploading?' : 'Leave while ISO is loading?',
      body:
        transferringReference || uploads.busy
          ? 'Leaving this page will cancel the active reference operation and any queued uploads.'
          : 'Leaving this page will cancel the active ISO load and any queued maps.',
      confirmLabel: 'Leave page',
      danger: true,
    })
      .then(confirmed => {
        if (!confirmed) return;
        leaving = true;
        window.removeEventListener('beforeunload', confirmUnload);
        location.assign(destination.href);
      })
      .finally(() => {
        confirmingLeave = false;
      });
  }
  document.addEventListener('click', confirmNavigation, true);

  function createCard(slot: string) {
    const row = element('article', 'public-course public-iso-map public-map-tile');
    row.dataset.course = slot;
    row.dataset.kind = 'reference';
    const heading = mapHeading(discCourseName(slot), 'mountain');
    const online = activityCounter('map');
    online.set(activity ? (activity.courses[referenceRoom(slot)] ?? 0) : null);
    heading.append(online.el);
    const origin = element('p', 'library-map-origin', mapGameLabel(mapGame({ name: slot })));
    const badge = element('span', 'public-iso-badge');
    const controls = element('div', 'public-iso-map-actions');
    const button = element('button', '');
    button.type = 'button';
    const course: PublicCourse = {
      kind: 'reference',
      id: slot,
      name: discCourseName(slot),
      source: 'iso',
      retailData: true,
      isoCourses: [slot],
    };
    const open = element('a', 'public-iso-open public-primary', 'Play');
    open.href = publicCourseUrl(course);
    open.setAttribute('aria-label', `Play ${discCourseName(slot)}`);
    open.prepend(publicGlyph('play'));
    const inspect = element('a', 'public-iso-inspect', 'Inspect');
    inspect.href = courseEditorUrl(course);
    inspect.setAttribute('aria-label', `Inspect ${discCourseName(slot)}`);
    inspect.prepend(publicGlyph('view'));
    const reference = element('button', 'public-iso-reference', 'Reference');
    reference.type = 'button';
    reference.setAttribute('aria-label', `Reference ${discCourseName(slot)}`);
    const musicLabel = element('label', 'public-reference-music');
    const music = element('input', '');
    music.type = 'checkbox';
    musicLabel.append(music, document.createTextNode(' Include music'));
    reference.onclick = async () => {
      const phase = uploads.state(slot)?.phase;
      if (phase === 'queued' || phase === 'uploading') {
        uploads.cancel(slot);
        return;
      }
      if (busy || referenceDialog || !referenceLibrary.ready) return;
      const installed = referenceForCourse(referenceLibrary.maps, slot);
      if (!installed) {
        referenceMessages.delete(slot);
        void uploads.add(slot, music.checked);
        return;
      }
      if (installed) {
        referenceDialog = true;
        const confirmed = await confirmAction({
          title: `Remove ${discCourseName(slot)} reference?`,
          body: 'This removes the map and its files from the server reference library. Mountains borrowing its assets may need the reference uploaded again. Your local map and disc are kept.',
          confirmLabel: 'Remove reference',
          danger: true,
        });
        referenceDialog = false;
        if (!confirmed || busy || loads.busy) return;
      }
      referenceMessages.delete(slot);
      transferringReference = true;
      cancel.textContent = installed ? 'Cancel removal' : 'Cancel upload';
      await operate(
        async signal => {
          try {
            if (installed) {
              await removeReference(installed.name, signal);
              uploads.clear(slot);
            }
            referenceMessages.set(slot, installed ? 'Server reference removed.' : 'Server reference uploaded.');
          } catch (error) {
            referenceMessages.set(
              slot,
              signal.aborted
                ? 'Reference operation cancelled.'
                : error instanceof Error
                  ? error.message
                  : String(error),
            );
            throw error;
          } finally {
            // Reconcile a lost completion/removal response with the server's authoritative state.
            await referenceLibrary.refresh().catch(() => {});
          }
        },
        () => (installed ? 'Server reference removed.' : 'Server reference uploaded.'),
      );
      cancel.textContent = 'Cancel scan';
      transferringReference = false;
    };
    button.onclick = () => {
      const phase = loads.state(slot)?.phase;
      if (phase === 'queued' || phase === 'loading') loads.cancel(slot);
      else if (cached.includes(slot))
        void operate(
          async () => unloadIsoCourse(slot),
          () => '',
          false,
        );
      else loadMaps([slot]);
    };
    controls.append(button, open, inspect, reference, musicLabel);
    const feedback = element('div', 'public-iso-feedback');
    const progress = element('progress', 'public-iso-progress');
    progress.setAttribute('aria-label', `Loading ${discCourseName(slot)}`);
    const message = element('p', 'public-iso-load-status');
    message.setAttribute('role', 'status');
    feedback.append(progress, message);
    const controlPanel = element('div', 'public-reference-controls');
    controlPanel.append(controls);
    row.append(heading, origin, badge, controlPanel, feedback);
    return {
      row,
      badge,
      button,
      message,
      open,
      inspect,
      reference,
      music,
      musicLabel,
      progress,
      course,
      online,
      title: heading.querySelector('h3')!,
    };
  }

  function render() {
    const disc = discs.get(selectedGame);
    syncIsoMaps(cached);
    options?.onInventory(cached);
    if (target)
      setEditor(
        target.kind === 'reference' && target.isoCourses.some(slot => !cached.includes(slot))
          ? EDITOR_PATH
          : courseEditorUrl(target),
      );
    if (!leaving && loadingIso()) window.addEventListener('beforeunload', confirmUnload);
    else window.removeEventListener('beforeunload', confirmUnload);
    totalLoaded.textContent = `${cached.length} loaded`;
    input.disabled = busy || loads.busy;
    clear.disabled = busy || loads.busy || uploads.busy;
    sourceActions.hidden = !disc && !cached.some(slot => isoGameForCourse(slot) === selectedGame);
    refreshImage.hidden = removeImage.hidden = !disc;
    refreshImage.disabled = removeImage.disabled = busy || loads.busy;
    unloadGame.disabled = busy || loads.busy || uploads.busy;
    clear.style.visibility = cached.length || discs.size ? 'visible' : 'hidden';
    for (const game of ISO_GAMES) {
      const { item, button, state, detail } = gameButtons.get(game.id)!;
      const source = discs.get(game.id);
      const serverCourses = referenceLibrary.maps
        .map(map => map.course)
        .filter(slot => isoGameForCourse(slot) === game.id);
      const loadedCourses = cached.filter(slot => isoGameForCourse(slot) === game.id);
      const loaded = loadedCourses.length;
      const total = new Set([...loadedCourses, ...(source?.courses ?? [])]).size;
      button.disabled = options ? false : !source && !loaded && !serverCourses.length;
      if (!options) button.setAttribute('aria-pressed', String(game.id === selectedGame && !button.disabled));
      item.dataset.state = loaded ? 'loaded' : source ? 'available' : 'missing';
      const counter = button.querySelector('.library-game-count');
      if (counter) counter.textContent = total ? `${loaded}/${total}` : '—';
      state.textContent = total ? `${loaded} of ${total} maps loaded` : 'No maps loaded';
      detail.textContent = source
        ? `${source.saved ? 'Disc saved' : 'Disc available for this visit'} · ${source.file.name}`
        : loaded
          ? 'No disc saved · Loaded maps are ready to use'
          : serverCourses.length
            ? `${serverCourses.length} server reference${serverCourses.length === 1 ? '' : 's'}`
            : 'No disc selected';
      item.title = `${state.textContent} · ${detail.textContent} · ${game.support}`;
    }
    const required = target?.isoCourses ?? [];
    if (options)
      sourceNote.textContent = disc
        ? `${disc.saved ? 'Saved on this device' : 'Available this visit'} · ${disc.file.name} · ${ISO_GAMES.find(game => game.id === selectedGame)!.support}`
        : 'No game file selected. Open an ISO, BIN, GCM, RVZ or GBA file to see its courses.';
    const missing = required.filter(slot => !cached.includes(slot));
    loadRequired.hidden = !required.length;
    loadRequired.style.visibility = missing.length ? 'visible' : 'hidden';
    loadRequired.disabled =
      busy || !missing.some(slot => sourceFor(slot) && !['queued', 'loading'].includes(loads.state(slot)?.phase ?? ''));
    const nextDependencies = JSON.stringify(required.map(slot => [slot, cached.includes(slot)]));
    if (target && required.length && dependencyState !== nextDependencies) {
      dependencies.replaceChildren(element('h2', '', 'Required maps'), isoStatusBadges(required, cached));
      dependencies.hidden = false;
      dependencyState = nextDependencies;
    }
    const inventory = libraryGameCourses(
      cached,
      [...discs.values()].flatMap(source => source.courses),
      referenceLibrary.maps,
      options?.published?.() ?? [],
      required,
    );
    const entries = inventory.filter(
      entry =>
        (!libraryFilter.game || isoGameForCourse(entry.course) === libraryFilter.game) &&
        isoCourseVisible(entry.course, allMapTypes, required),
    );
    entries.sort(
      (a, b) =>
        Number(required.includes(b.course)) - Number(required.includes(a.course)) || a.name.localeCompare(b.name),
    );
    const maps = entries.map(entry => entry.course);
    const byCourse = new Map(entries.map(entry => [entry.course, entry]));
    const loadedCount = maps.filter(slot => cached.includes(slot)).length;
    const missingCount = maps.length - loadedCount;
    typeFilter.hidden = selectedGame !== 'ssx3';
    heading.textContent = `${ISO_GAMES.find(game => game.id === selectedGame)!.name} maps`;
    mapSummary.textContent = maps.length
      ? `${loadedCount} of ${maps.length} maps loaded · ${missingCount} not loaded`
      : 'Choose a disc to see its maps.';
    filters.hidden = !maps.length;
    for (const [filter, button] of filterButtons) {
      const label = filter === 'all' ? 'All maps' : filter === 'loaded' ? 'Loaded' : 'Not loaded';
      button.textContent = `${label} (${filter === 'all' ? maps.length : filter === 'loaded' ? loadedCount : missingCount})`;
      button.setAttribute('aria-pressed', String(filter === mapFilter));
    }
    const visibleMaps = maps.filter(
      slot =>
        libraryFilter.enabled &&
        (libraryFilter.source === 'all' ||
          (libraryFilter.source === 'server'
            ? byCourse.get(slot)!.server
            : byCourse.get(slot)!.disc || byCourse.get(slot)!.loaded)) &&
        (mapFilter === 'all' || cached.includes(slot) === (mapFilter === 'loaded')) &&
        (!searchQuery ||
          `${byCourse.get(slot)!.name} ${slot} ${mapGameLabel(mapGame({ name: slot }))}`
            .toLowerCase()
            .includes(searchQuery)),
    );
    empty.hidden = !!visibleMaps.length;
    empty.textContent =
      searchQuery && maps.length
        ? `No courses match “${searchQuery}”.`
        : !maps.length
          ? 'Choose a supported disc above, then load individual maps here.'
          : libraryFilter.source !== 'all'
            ? 'No courses match the selected source and load filters.'
            : mapFilter === 'loaded'
              ? 'No loaded maps for this game. Select Not loaded, then Load a map to make it ready to play.'
              : 'All listed maps are loaded and ready to play.';
    for (const [slot, card] of cards) {
      if (!maps.includes(slot)) {
        card.row.remove();
        cards.delete(slot);
      }
    }
    for (const [index, slot] of maps.entries()) {
      let card = cards.get(slot);
      if (!card) {
        card = createCard(slot);
        cards.set(slot, card);
      }
      const { row, badge, button, message, open, inspect, reference, music, musicLabel, progress, course, title } =
        card;
      const entry = byCourse.get(slot)!;
      const name = entry.name;
      row.setAttribute('aria-label', name);
      row.dataset.disc = String(entry.disc || entry.loaded);
      row.dataset.server = String(entry.server);
      row
        .querySelector('.public-map-symbol')
        ?.replaceChildren(mapAvailability({ disc: entry.disc || entry.loaded, server: entry.server }));
      if (title.textContent !== name) {
        title.textContent = course.name = name;
        reference.setAttribute('aria-label', `Reference ${name}`);
        music.setAttribute('aria-label', `Include music for ${name}`);
        open.href = publicCourseUrl(course);
        inspect.href = courseEditorUrl(course);
        open.setAttribute('aria-label', `Play ${name}`);
        inspect.setAttribute('aria-label', `Inspect ${name}`);
      }
      const loaded = entry.loaded;
      const installed = referenceForCourse(referenceLibrary.maps, slot);
      reference.hidden = !admin || (!loaded && !installed);
      const upload = uploads.state(slot);
      const referencePending = upload?.phase === 'queued' || upload?.phase === 'uploading';
      reference.disabled = !referencePending && (busy || !referenceLibrary.ready || (!!installed && loads.busy));
      reference.setAttribute('aria-pressed', String(!!installed));
      reference.textContent =
        upload?.phase === 'queued' ? 'Queued' : upload?.phase === 'uploading' ? 'Cancel upload' : 'Reference';
      reference.title = referencePending
        ? 'Cancel reference upload'
        : installed
          ? 'Remove server reference'
          : 'Upload server reference';
      row.dataset.referenceState = upload?.phase ?? '';
      progress.setAttribute(
        'aria-label',
        upload?.phase === 'uploading'
          ? `Uploading reference ${discCourseName(slot)}`
          : `Loading ${discCourseName(slot)}`,
      );
      musicLabel.hidden = !admin || !loaded || !!installed;
      music.disabled = busy || referencePending;
      if (referencePending) music.checked = upload.music;
      const playable = loaded
        ? { ...course, name, source: 'iso' as const }
        : entry.publication?.isoCourses.every(slot => cached.includes(slot))
          ? entry.publication
          : undefined;
      const inspectable = playable ?? entry.publication;
      open.hidden = !playable;
      inspect.hidden = !inspectable;
      if (playable) {
        open.href = options?.playUrl?.(playable) ?? publicCourseUrl(playable);
      }
      if (inspectable) inspect.href = courseEditorUrl(inspectable);
      const state = loads.state(slot);
      const pending = state?.phase === 'queued' || state?.phase === 'loading';
      const phase = state?.phase ?? (loaded ? 'loaded' : 'missing');
      row.dataset.state = phase;
      row.hidden = !visibleMaps.includes(slot);
      row.setAttribute('aria-busy', String(state?.phase === 'loading' || upload?.phase === 'uploading'));
      badge.className = `public-iso-badge ${phase}`;
      const badgeText = pending
        ? state.phase === 'queued'
          ? 'Queued'
          : 'Loading…'
        : state?.phase === 'error'
          ? 'Failed'
          : loaded
            ? 'Loaded'
            : 'Not loaded';
      if (badge.textContent !== badgeText) badge.textContent = badgeText;
      const feedback =
        upload?.message ??
        referenceMessages.get(slot) ??
        (state
          ? state.phase === 'queued'
            ? 'Waiting for another map to finish loading.'
            : state.message
          : loaded
            ? 'Ready to Play or Inspect. Saved in this browser.'
            : sourceFor(slot)
              ? 'Load this map to Play or Inspect.'
              : installed
                ? 'Reference saved on the server. Load a local copy to Play or Inspect.'
                : 'Choose this game’s disc to load this map.');
      if (message.textContent !== feedback) {
        message.textContent = feedback;
        message.title = feedback;
      }
      const action = pending ? 'Cancel' : loaded ? 'Unload' : 'Load local';
      if (button.textContent !== action) button.textContent = action;
      button.setAttribute('aria-label', `${pending ? 'Cancel loading' : loaded ? 'Unload' : 'Load local'} ${name}`);
      button.disabled = busy || (loaded ? loads.busy || referencePending : !pending && !sourceFor(slot));
      if (rows.children[index] !== row) rows.insertBefore(row, rows.children[index] ?? null);
    }
    options?.onMapsChanged?.();
  }

  async function operate(run: (signal: AbortSignal) => Promise<void>, success: () => string, cancellable = true) {
    if (busy || loads.busy) return;
    busy = true;
    scanning = cancellable;
    abort = new AbortController();
    cancel.hidden = !cancellable;
    render();
    try {
      await run(abort.signal);
      status.textContent = success();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      cached = await cachedIsoCourses().catch(() => cached);
      busy = false;
      scanning = false;
      abort = null;
      cancel.hidden = true;
      render();
    }
  }
  function loadMaps(slots: string[]) {
    if (busy || !slots.length) return;
    status.textContent = '';
    for (const disc of discs.values()) {
      const wanted = slots.filter(slot => discContainsCourse(disc.courses, slot));
      if (wanted.length) void loads.add(disc.file, wanted);
    }
  }
  async function readImage(selectedFile: File, signal: AbortSignal): Promise<string> {
    const courses = await scanIso(selectedFile, signal);
    const game = isoGameForCourse(courses[0]);
    const names = importedDiscCourseNames(courses);
    const layouts = importedCourseLayouts(courses);
    const disc = { game, file: selectedFile, courses, names, layouts, saved: false };
    let result = `${selectedFile.name} · ${courses.length} map${courses.length === 1 ? '' : 's'} found`;
    try {
      await saveIsoDisc({ game, file: selectedFile, courses, names, layouts }, signal);
      disc.saved = true;
    } catch (error) {
      signal.throwIfAborted();
      result += ` · Could not keep this image in browser storage: ${error instanceof Error ? error.message : String(error)}. Choose it again after leaving this page.`;
    }
    discs.set(game, disc);
    selectGame(game);
    return result;
  }
  refreshImage.onclick = () => {
    const disc = discs.get(selectedGame);
    if (!disc || busy || loads.busy) return;
    let result = '';
    status.textContent = `Refreshing ${disc.file.name}…`;
    void operate(
      async signal => {
        closeIsoImporterSessions();
        result = await readImage(disc.file, signal);
      },
      () => `${result} · Course names refreshed.`,
    );
  };
  async function removeGame(removeCourses: boolean) {
    const game = selectedGame;
    if (busy || loads.busy || confirmingClear) return;
    const name = ISO_GAMES.find(item => item.id === game)!.name;
    const courses = cached.filter(slot => isoGameForCourse(slot) === game);
    confirmingClear = true;
    try {
      const confirmed = await confirmAction({
        title: removeCourses ? `Unload ${name}?` : `Remove ${name} image?`,
        body: removeCourses
          ? `This removes this game's saved image and ${courses.length} imported course(s) from this browser. Other games, custom mountains and original files are kept.`
          : 'This forgets the saved image in this browser. Imported courses stay playable, and the original file is kept. Choose the image again to load more courses.',
        confirmLabel: removeCourses ? 'Unload game' : 'Remove image',
        danger: true,
      });
      if (!confirmed) return;
      await operate(
        async () => {
          closeIsoImporterSessions();
          if (removeCourses) for (const course of courses) await unloadIsoCourse(course);
          await removeSavedIsoDisc(game);
          discs.delete(game);
        },
        () => (removeCourses ? `${name} unloaded.` : `${name} image removed. Imported courses are kept.`),
        false,
      );
    } finally {
      confirmingClear = false;
    }
  }
  removeImage.onclick = () => {
    void removeGame(false);
  };
  unloadGame.onclick = () => {
    void removeGame(true);
  };
  input.onchange = () => {
    const selectedFile = input.files?.[0];
    if (!selectedFile) return;
    let result = '';
    status.textContent = `Reading maps from ${selectedFile.name}…`;
    void operate(
      async signal => {
        result = await readImage(selectedFile, signal);
      },
      () => result,
    ).finally(() => {
      input.value = '';
    });
  };
  loadRequired.onclick = () => {
    loadMaps((target?.isoCourses ?? []).filter(slot => !cached.includes(slot) && sourceFor(slot)));
  };
  clear.onclick = async () => {
    if (busy || loads.busy || uploads.busy || confirmingClear || (!cached.length && !discs.size)) return;
    confirmingClear = true;
    try {
      const confirmed = await confirmAction({
        title: 'Unload all ISO maps?',
        body: 'This removes every saved disc and loaded ISO map from this browser. Choose your disc images again to reload maps. Your original ISO and BIN files are kept.',
        confirmLabel: 'Unload all maps',
        danger: true,
      });
      if (!confirmed) return;
      await operate(
        async () => {
          await clearIsoCache();
          await clearSavedIsoDiscs();
          discs.clear();
          input.value = '';
        },
        () => 'All ISO maps unloaded.',
        false,
      );
    } finally {
      confirmingClear = false;
    }
  };
  cancel.onclick = () => abort?.abort();
  window.addEventListener(
    'pagehide',
    () => {
      window.removeEventListener('beforeunload', confirmUnload);
      document.removeEventListener('click', confirmNavigation, true);
      abort?.abort();
      loads.dispose();
      referenceLibrary.dispose();
      stopActivity();
    },
    { once: true },
  );
  window.addEventListener('pageshow', event => {
    if (event.persisted) location.reload(); // A history-restored page must recreate its cancelled load queue.
  });
  render();
  if (admin) {
    const refreshReferences = async () => {
      if (busy || uploads.busy) return;
      try {
        await referenceLibrary.refresh();
        if (
          !options &&
          !discs.has(selectedGame) &&
          !cached.some(slot => isoGameForCourse(slot) === selectedGame) &&
          referenceLibrary.maps.length
        )
          selectGame(isoGameForCourse(referenceLibrary.maps[0].course));
        render();
      } catch (error) {
        status.textContent = `Could not read server references: ${error instanceof Error ? error.message : String(error)}`;
      }
    };
    window.addEventListener('focus', () => {
      void refreshReferences();
    });
    if (!options?.references) await refreshReferences();
  }
  try {
    const request = publicCourseRequest(new URL(location.href));
    if (request) {
      const localTarget = resolvePublicCourse(request, [], cached);
      const data =
        request.source === 'iso' || !navigator.onLine
          ? { courses: [] }
          : await publicJson<{ courses: PublicCourse[] }>('/api/public/courses').catch(() => ({ courses: [] }));
      target = resolvePublicCourse(request, data.courses, cached) ?? localTarget;
      if (target?.isoCourses.length)
        selectGame(isoGameForCourse(target.isoCourses.find(slot => !cached.includes(slot)) ?? target.isoCourses[0]));
      if (!target) status.textContent = 'This public map is unavailable. You can still manage your local ISO maps.';
      render();
    }
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
  return {
    selectGame(game: IsoGame) {
      selectGame(game);
      render();
    },
    maps: rows,
    filter(next: LibraryFilter) {
      const key = JSON.stringify([next, options?.published?.()]);
      if (key === filterKey) return;
      filterKey = key;
      if (libraryFilter.game !== next.game) mapFilter = 'all';
      libraryFilter = next;
      searchQuery = next.query;
      render();
    },
    chooseFile: () => input.click(),
    currentGame: () => selectedGame,
  };
}
