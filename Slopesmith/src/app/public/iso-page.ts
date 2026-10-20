import './home.css';
import type { PublicCourse } from '../../core/session/public-courses';
import { discCourseName } from '../../core/reference/disc-courses';
import { currentAccount } from '../net/account';
import { cachedIsoCourses, clearIsoCache, importIso, scanIso, unloadIsoCourse } from './iso-cache';
import { element, publicJson } from './dom';
import { publicHeader } from './header';
import { isoStatusBadges } from './iso-status';
import { createIsoLoadQueue } from './iso-load-queue';
import { courseEditorUrl, publicCourseRequest, publicCourseUrl, resolvePublicCourse } from './links';
import { mapHeading, publicGlyph } from './presentation';
import { confirmAction } from '../ui/components/prompts';
import { EDITOR_PATH } from '../navigation';
import { ISO_GAMES, clearSavedIsoDiscs, isoGameForCourse, saveIsoDisc, savedIsoDiscs, type IsoGame, type SavedIsoDisc } from './iso-discs';

const SELECTED_GAME = 'slopesmith.isoGame';

/** Disc files and extraction stay on this device; this page needs no member or guest session. */
export async function showIsoPage(): Promise<void> {
  document.body.classList.add('public-play', 'public-iso-page', 'sp-page-background');
  document.getElementById('load-status')?.classList.remove('show');
  document.title = 'ISO · Slopesmith';
  const account = await currentAccount();
  let cached = await cachedIsoCourses().catch(() => [] as string[]);
  const discs = new Map<IsoGame, SavedIsoDisc & { saved: boolean }>(
    (await savedIsoDiscs().catch(() => [] as SavedIsoDisc[])).map(disc => [disc.game, { ...disc, saved: true }]));
  let selectedGame: IsoGame = ISO_GAMES.find(game => discs.has(game.id) || cached.some(slot => isoGameForCourse(slot) === game.id))?.id ?? 'tricky';
  try {
    const remembered = sessionStorage.getItem(SELECTED_GAME) as IsoGame;
    if (discs.has(remembered) || cached.some(slot => isoGameForCourse(slot) === remembered)) selectedGame = remembered;
  } catch { /* Selection is optional; the saved discs remain available. */ }
  let busy = false;
  let scanning = false;
  let confirmingLeave = false;
  let confirmingClear = false;
  let leaving = false;
  let abort: AbortController | null = null;
  let target: PublicCourse | null = null;
  const { header, setEditor, syncIsoMaps } = publicHeader('iso', account);
  const main = element('main', 'public-home');
  const title = element('h1', 'public-visually-hidden', 'ISO');
  const dependencies = element('section', 'public-iso-requirements'); dependencies.hidden = true;
  dependencies.setAttribute('aria-label', 'Required ISO maps');
  const iso = element('section', 'public-iso');
  const input = element('input', ''); input.type = 'file'; input.accept = '.iso,.bin'; input.id = 'public-iso';
  const label = element('label', 'public-iso-button', 'Load ISO'); label.htmlFor = input.id;
  label.prepend(publicGlyph('disc'));
  label.title = 'SSX, SSX Tricky, SSX 3 or SSX On Tour PS2 · Choose an ISO or the BIN from a BIN/CUE disc · Files stay on this device';
  const count = element('span', 'public-cache');
  const clear = element('button', 'public-clear', 'Clear all'); clear.type = 'button'; clear.setAttribute('aria-label', 'Clear all ISO maps');
  const loadRequired = element('button', 'public-primary', 'Load required maps'); loadRequired.type = 'button'; loadRequired.hidden = true;
  const cancel = element('button', '', 'Cancel scan'); cancel.type = 'button'; cancel.hidden = true;
  const actions = element('div', 'public-iso-actions'); actions.append(label, input, count, loadRequired, clear, cancel);
  const status = element('p', 'public-iso-status'); status.setAttribute('role', 'status');
  const support = element('section', 'public-iso-support'); support.setAttribute('aria-label', 'PS2 game support');
  support.append(element('h2', '', 'Games'));
  const supportList = element('dl', '');
  const gameButtons = new Map<IsoGame, { button: HTMLButtonElement; detail: HTMLElement }>();
  for (const game of ISO_GAMES) {
    const item = element('div', '');
    const name = element('dt', '');
    const button = element('button', 'public-iso-game', game.name); button.type = 'button';
    button.setAttribute('aria-controls', 'public-iso-maps');
    button.onclick = () => { selectGame(game.id); status.textContent = ''; render(); };
    name.append(button);
    const detail = element('dd', 'public-iso-game-detail');
    item.append(name, element('dd', '', game.support), detail);
    gameButtons.set(game.id, { button, detail });
    supportList.append(item);
  }
  support.append(supportList,
    element('p', 'public-local-note', 'Select a loaded game to browse its maps. Discs and loaded maps are saved in this browser on this device.'),
    element('p', '', 'SSX support is still incomplete. SSX 3 and On Tour are early imports with missing features and possible map issues. ISO and BIN files stay on this device.'));
  iso.append(actions, support, status);
  const heading = element('h2', 'public-visually-hidden', 'ISO maps');
  const rows = element('ul', 'public-iso-map-list'); rows.setAttribute('aria-label', 'Manage ISO maps');
  rows.id = 'public-iso-maps';
  const empty = element('p', 'public-empty', 'No maps loaded.');
  main.append(title, dependencies, iso, heading, rows, empty);
  document.body.append(header, main);
  const cards = new Map<string, ReturnType<typeof createCard>>();
  let dependencyState = '';

  const loads = createIsoLoadQueue(async (selectedFile, slot, progress, signal) => {
    try { await importIso(selectedFile, [slot], progress, signal); }
    catch (error) { await unloadIsoCourse(slot); throw error; }
    finally { cached = await cachedIsoCourses().catch(() => cached); }
  }, render);

  const loadingIso = () => scanning || loads.busy;
  function selectGame(game: IsoGame) {
    selectedGame = game;
    try { sessionStorage.setItem(SELECTED_GAME, game); } catch { /* optional */ }
  }
  const sourceFor = (slot: string) => {
    const disc = discs.get(isoGameForCourse(slot));
    return disc?.courses.includes(slot) ? disc : undefined;
  };
  function confirmUnload(event: BeforeUnloadEvent) {
    if (leaving || !loadingIso()) return;
    event.preventDefault();
    event.returnValue = ''; // Browsers supply their own wording for refresh, Back and tab-close warnings.
  }
  function confirmNavigation(event: MouseEvent) {
    if (leaving || !loadingIso() || event.defaultPrevented || event.button !== 0
      || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null;
    if (!link || link.hasAttribute('download') || link.getAttribute('href')?.startsWith('#')
      || (link.target && link.target.toLowerCase() !== '_self')) return;
    const destination = new URL(link.href);
    if (!['http:', 'https:'].includes(destination.protocol)) return;
    if (destination.origin === location.origin && destination.pathname === location.pathname
      && destination.search === location.search && destination.hash) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (confirmingLeave) return;
    confirmingLeave = true;
    void confirmAction({
      title: 'Leave while ISO is loading?',
      body: 'Leaving this page will cancel the active ISO load and any queued maps.',
      confirmLabel: 'Leave page', danger: true,
    }).then(confirmed => {
      if (!confirmed) return;
      leaving = true;
      window.removeEventListener('beforeunload', confirmUnload);
      location.assign(destination.href);
    }).finally(() => { confirmingLeave = false; });
  }
  document.addEventListener('click', confirmNavigation, true);

  function createCard(slot: string) {
    const row = element('li', 'public-iso-map public-map-tile'); row.dataset.course = slot;
    const heading = mapHeading(discCourseName(slot), 'disc');
    const badge = element('span', 'public-iso-badge');
    const controls = element('div', 'public-iso-map-actions');
    const button = element('button', ''); button.type = 'button';
    const course: PublicCourse = { kind: 'reference', id: slot, name: discCourseName(slot), source: 'iso', retailData: true, isoCourses: [slot] };
    const open = element('a', 'public-iso-open public-primary', 'Play'); open.href = publicCourseUrl(course);
    open.setAttribute('aria-label', `Play ${discCourseName(slot)}`); open.prepend(publicGlyph('play'));
    const inspect = element('a', 'public-iso-inspect', 'Inspect'); inspect.href = courseEditorUrl(course);
    inspect.setAttribute('aria-label', `Inspect ${discCourseName(slot)}`); inspect.prepend(publicGlyph('view'));
    button.onclick = () => {
      const phase = loads.state(slot)?.phase;
      if (phase === 'queued' || phase === 'loading') loads.cancel(slot);
      else if (cached.includes(slot)) void operate(async () => unloadIsoCourse(slot), () => '', false);
      else loadMaps([slot]);
    };
    controls.append(button, open, inspect);
    const feedback = element('div', 'public-iso-feedback');
    const progress = element('progress', 'public-iso-progress');
    progress.setAttribute('aria-label', `Loading ${discCourseName(slot)}`);
    const message = element('p', 'public-iso-load-status'); message.setAttribute('role', 'status');
    feedback.append(progress, message);
    row.append(heading, badge, controls, feedback);
    return { row, badge, button, message, open, inspect };
  }

  function render() {
    const disc = discs.get(selectedGame);
    syncIsoMaps(cached);
    if (target) setEditor(target.kind === 'reference' && target.isoCourses.some(slot => !cached.includes(slot))
      ? EDITOR_PATH : courseEditorUrl(target));
    if (!leaving && loadingIso()) window.addEventListener('beforeunload', confirmUnload);
    else window.removeEventListener('beforeunload', confirmUnload);
    count.textContent = `${cached.length} loaded`;
    input.disabled = clear.disabled = busy || loads.busy;
    clear.style.visibility = cached.length || discs.size ? 'visible' : 'hidden';
    for (const game of ISO_GAMES) {
      const { button, detail } = gameButtons.get(game.id)!;
      const source = discs.get(game.id);
      const loadedCourses = cached.filter(slot => isoGameForCourse(slot) === game.id);
      const loaded = loadedCourses.length;
      const total = new Set([...loadedCourses, ...(source?.courses ?? [])]).size;
      button.disabled = !source && !loaded;
      button.setAttribute('aria-pressed', String(game.id === selectedGame && !button.disabled));
      detail.textContent = source
        ? `${source.file.name} · ${source.saved ? 'Saved in this browser' : 'Available until you leave'} · ${loaded}/${total} maps loaded`
        : loaded ? `${loaded} maps loaded` : 'No ISO loaded';
    }
    const required = target?.isoCourses ?? [];
    const missing = required.filter(slot => !cached.includes(slot));
    loadRequired.hidden = !required.length;
    loadRequired.style.visibility = missing.length ? 'visible' : 'hidden';
    loadRequired.disabled = busy || !missing.some(slot => sourceFor(slot)
      && !['queued', 'loading'].includes(loads.state(slot)?.phase ?? ''));
    const nextDependencies = JSON.stringify(required.map(slot => [slot, cached.includes(slot)]));
    if (target && required.length && dependencyState !== nextDependencies) {
      dependencies.replaceChildren(element('h2', '', 'Required maps'),
        isoStatusBadges(required, cached));
      dependencies.hidden = false;
      dependencyState = nextDependencies;
    }
    const maps = [...new Set([...required, ...cached, ...(disc?.courses ?? [])])]
      .filter(slot => isoGameForCourse(slot) === selectedGame).sort((a, b) =>
      Number(required.includes(b)) - Number(required.includes(a)) || discCourseName(a).localeCompare(discCourseName(b)));
    empty.hidden = !!maps.length;
    for (const [slot, card] of cards) {
      if (!maps.includes(slot)) { card.row.remove(); cards.delete(slot); }
    }
    for (const [index, slot] of maps.entries()) {
      let card = cards.get(slot);
      if (!card) { card = createCard(slot); cards.set(slot, card); }
      const { row, badge, button, message, open, inspect } = card;
      const loaded = cached.includes(slot);
      open.hidden = inspect.hidden = !loaded;
      const state = loads.state(slot);
      const pending = state?.phase === 'queued' || state?.phase === 'loading';
      const phase = state?.phase ?? (loaded ? 'loaded' : 'missing');
      row.dataset.state = phase;
      row.setAttribute('aria-busy', String(state?.phase === 'loading'));
      badge.className = `public-iso-badge ${phase}`;
      const badgeText = pending ? state.phase === 'queued' ? 'Queued' : 'Loading…'
        : state?.phase === 'error' ? 'Failed' : loaded ? 'Loaded' : 'Not loaded';
      if (badge.textContent !== badgeText) badge.textContent = badgeText;
      const feedback = state?.phase === 'error' || (state?.phase === 'loading' && state.message !== 'Loading…')
        ? state.message : disc && !disc.courses.includes(slot) && !loaded ? 'Not found in the selected ISO.' : '';
      if (message.textContent !== feedback) { message.textContent = feedback; message.title = feedback; }
      const action = pending ? 'Cancel' : loaded ? 'Unload' : 'Load';
      if (button.textContent !== action) button.textContent = action;
      button.setAttribute('aria-label', `${pending ? 'Cancel loading' : loaded ? 'Unload' : 'Load'} ${discCourseName(slot)}`);
      button.disabled = busy || (loaded ? loads.busy : !pending && !sourceFor(slot));
      if (rows.children[index] !== row) rows.insertBefore(row, rows.children[index] ?? null);
    }
  }

  async function operate(run: (signal: AbortSignal) => Promise<void>, success: () => string, cancellable = true) {
    if (busy || loads.busy) return;
    busy = true; scanning = cancellable; abort = new AbortController(); cancel.hidden = !cancellable; render();
    try { await run(abort.signal); status.textContent = success(); }
    catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
    finally {
      cached = await cachedIsoCourses().catch(() => cached);
      busy = false; scanning = false; abort = null; cancel.hidden = true; render();
    }
  }
  function loadMaps(slots: string[]) {
    if (busy || !slots.length) return;
    status.textContent = '';
    for (const disc of discs.values()) {
      const wanted = slots.filter(slot => disc.courses.includes(slot));
      if (wanted.length) void loads.add(disc.file, wanted);
    }
  }
  input.onchange = () => {
    const selectedFile = input.files?.[0];
    if (!selectedFile) return;
    let result = '';
    status.textContent = `Reading maps from ${selectedFile.name}…`;
    void operate(async signal => {
      const courses = await scanIso(selectedFile, signal);
      const game = isoGameForCourse(courses[0]);
      const disc = { game, file: selectedFile, courses, saved: false };
      result = `${selectedFile.name} · ${courses.length} map${courses.length === 1 ? '' : 's'} found`;
      try { await saveIsoDisc({ game, file: selectedFile, courses }, signal); disc.saved = true; }
      catch (error) {
        signal.throwIfAborted();
        result += ` · Could not keep this disc in browser storage: ${error instanceof Error ? error.message : error}. Choose it again after leaving this page.`;
      }
      discs.set(game, disc); selectGame(game);
    }, () => result).finally(() => { input.value = ''; });
  };
  loadRequired.onclick = () => { loadMaps((target?.isoCourses ?? []).filter(slot => !cached.includes(slot) && sourceFor(slot))); };
  clear.onclick = async () => {
    if (busy || loads.busy || confirmingClear || (!cached.length && !discs.size)) return;
    confirmingClear = true;
    try {
      const confirmed = await confirmAction({
        title: 'Unload all ISO maps?',
        body: 'This removes every saved disc and loaded ISO map from this browser. Choose your disc images again to reload maps. Your original ISO and BIN files are kept.',
        confirmLabel: 'Unload all maps', danger: true,
      });
      if (!confirmed) return;
      await operate(async () => {
        await clearIsoCache();
        await clearSavedIsoDiscs();
        discs.clear(); input.value = '';
      }, () => 'All ISO maps unloaded.', false);
    } finally { confirmingClear = false; }
  };
  cancel.onclick = () => abort?.abort();
  window.addEventListener('pagehide', () => {
    window.removeEventListener('beforeunload', confirmUnload);
    document.removeEventListener('click', confirmNavigation, true);
    abort?.abort(); loads.dispose();
  }, { once: true });
  window.addEventListener('pageshow', event => {
    if (event.persisted) location.reload(); // A history-restored page must recreate its cancelled load queue.
  });
  render();
  try {
    const request = publicCourseRequest(new URL(location.href));
    if (request) {
      const localTarget = resolvePublicCourse(request, [], cached);
      const data = request.source === 'iso' || !navigator.onLine ? { courses: [] }
        : await publicJson<{ courses: PublicCourse[] }>('/api/public/courses').catch(() => ({ courses: [] }));
      target = resolvePublicCourse(request, data.courses, cached) ?? localTarget;
      if (target?.isoCourses.length) selectGame(isoGameForCourse(target.isoCourses.find(slot => !cached.includes(slot)) ?? target.isoCourses[0]));
      if (!target) status.textContent = 'This public map is unavailable. You can still manage your local ISO maps.';
      render();
    }
  } catch (error) { status.textContent = error instanceof Error ? error.message : String(error); }
}
