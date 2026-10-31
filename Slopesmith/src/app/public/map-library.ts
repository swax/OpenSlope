import './map-library.css';
import { element } from './dom';
import { ISO_GAMES, isoGameForCourse, type IsoGame } from './iso-discs';
import { mapGame, mapGameLabel } from '../../core/reference/map-game';

type View = 'all' | 'custom' | IsoGame;
type Source = 'all' | 'device' | 'server';
export type LibrarySection = { section: HTMLElement; grid: HTMLElement; source: Exclude<Source, 'all'> };
export type LibraryGameController = {
  selectGame: (game: IsoGame) => void;
  search: (query: string) => void;
  chooseFile: () => void;
  currentGame: () => IsoGame;
};

/** One browsing shell for authored mountains, server publications and local game imports. */
export function createMapLibrary(title: HTMLElement, sections: LibrarySection[]) {
  const el = element('div', 'map-library');
  const top = element('div', 'library-top');
  title.classList.remove('public-visually-hidden');
  title.textContent = 'Map library';
  const intro = element('div', 'library-intro');
  intro.append(title, element('p', '', 'Pick a game. Find your next run.'));
  const actions = element('div', 'library-actions');
  const summaryHost = element('div', 'library-summary');
  const createSlot = element('div', 'library-create');
  const open = element('button', '', 'Open game file');
  open.type = 'button';
  open.title = 'Open an ISO, BIN, GCM, RVZ or GBA file on this device';
  actions.append(summaryHost, open, createSlot);
  top.append(intro, actions);
  const layout = element('div', 'library-layout');
  const sidebar = element('aside', 'library-sidebar');
  sidebar.setAttribute('aria-label', 'Map library');
  const libraryNav = element('nav', 'library-views');
  libraryNav.setAttribute('aria-label', 'Library views');
  const views = new Map<View, HTMLButtonElement>();
  for (const [id, label] of [
    ['all', 'All maps'],
    ['custom', 'Custom maps'],
  ] as const) {
    const button = element('button', '', label);
    button.type = 'button';
    button.onclick = () => select(id);
    views.set(id, button);
    libraryNav.append(button);
  }
  const gamesHost = element('div', 'library-games');
  sidebar.append(
    libraryNav,
    gamesHost,
    element('p', 'library-device-note', 'Game files and imported courses stay on this device.'),
  );
  const workspace = element('div', 'library-workspace');
  const tools = element('div', 'library-toolbar');
  const searchLabel = element('label', 'library-search');
  searchLabel.append(element('span', 'public-visually-hidden', 'Search maps'));
  const search = element('input', '');
  search.type = 'search';
  search.placeholder = 'Search maps…';
  searchLabel.append(search);
  const sourceLabel = element('label', 'library-source');
  sourceLabel.append(element('span', '', 'Source'));
  const source = element('select', '');
  for (const [value, label] of [
    ['all', 'All sources'],
    ['device', 'On this device'],
    ['server', 'On the server'],
  ]) {
    const option = element('option', '', label);
    option.value = value;
    source.append(option);
  }
  sourceLabel.append(source);
  const formats = element('div', 'library-formats');
  formats.setAttribute('role', 'group');
  formats.setAttribute('aria-label', 'Map layout');
  const viewButtons = new Map<string, HTMLButtonElement>();
  for (const format of ['List', 'Cards']) {
    const button = element('button', '', format);
    button.type = 'button';
    button.onclick = () => setFormat(format.toLowerCase());
    viewButtons.set(format.toLowerCase(), button);
    formats.append(button);
  }
  tools.append(searchLabel, sourceLabel, formats);
  const context = element('div', 'library-context');
  const heading = element('h2', '', 'All maps');
  const result = element('p', '');
  result.setAttribute('role', 'status');
  context.append(heading, result);
  const gameHost = element('div', 'library-imports');
  gameHost.hidden = true;
  const catalogue = element('div', 'library-catalogue');
  catalogue.append(...sections.map(item => item.section));
  const empty = element('div', 'library-empty');
  empty.append(element('h3', '', 'No maps found'), element('p', '', 'Try another game, source or search.'));
  const reset = element('button', '', 'Clear filters');
  reset.type = 'button';
  reset.onclick = () => {
    search.value = '';
    source.value = 'all';
    select('all');
  };
  empty.append(reset);
  workspace.append(tools, context, gameHost, catalogue, empty);
  layout.append(sidebar, workspace);
  el.append(top, layout);
  let view: View = 'all';
  let format = 'list';
  let controller: LibraryGameController | undefined;
  const url = new URL(location.href);
  const requestedGame = url.searchParams.get('game');
  if (ISO_GAMES.some(game => game.id === requestedGame)) view = requestedGame as IsoGame;
  else if (url.searchParams.get('view') === 'custom') view = 'custom';
  try {
    format = localStorage.getItem('slopesmith.library.layout') === 'cards' ? 'cards' : 'list';
  } catch {
    /* optional */
  }

  function setFormat(next: string) {
    format = next;
    el.dataset.layout = format;
    for (const [id, button] of viewButtons) button.setAttribute('aria-pressed', String(id === format));
    try {
      localStorage.setItem('slopesmith.library.layout', format);
    } catch {
      /* optional */
    }
  }
  function select(next: View, notify = true) {
    view = next;
    const url = new URL(location.href);
    if (next === 'all' || next === 'custom') {
      url.searchParams.delete('game');
      for (const key of ['reference', 'map', 'source']) url.searchParams.delete(key);
      if (next === 'custom') url.searchParams.set('view', 'custom');
      else url.searchParams.delete('view');
    } else {
      url.searchParams.set('game', next);
      url.searchParams.set('view', 'games');
      if (notify) controller?.selectGame(next);
    }
    history.replaceState(history.state, '', url);
    update();
  }
  function update() {
    const gameView = view !== 'all' && view !== 'custom';
    el.dataset.gameView = String(gameView);
    gameHost.hidden = !gameView;
    sourceLabel.hidden = gameView;
    heading.textContent = gameView
      ? ISO_GAMES.find(game => game.id === view)!.name
      : view === 'custom'
        ? 'Custom maps'
        : 'All maps';
    for (const [id, button] of views) button.setAttribute('aria-pressed', String(id === view));
    for (const button of gamesHost.querySelectorAll<HTMLButtonElement>('.public-iso-game')) {
      const game = ISO_GAMES.find(game => game.id === button.dataset.game);
      button.setAttribute('aria-pressed', String(game?.id === view));
    }
    let shown = 0;
    const query = search.value.trim().toLowerCase();
    for (const item of sections) {
      const created = item.grid.querySelector('.public-new-map');
      if (created) {
        const link = created.querySelector('a');
        if (link?.lastChild) link.lastChild.textContent = 'New map';
        createSlot.replaceChildren(created);
      }
      let count = 0;
      const cards = [...item.grid.querySelectorAll<HTMLElement>('.public-course')];
      cards.sort((a, b) => (a.getAttribute('aria-label') ?? '').localeCompare(b.getAttribute('aria-label') ?? ''));
      for (const card of cards) {
        item.grid.append(card);
        const isReference = card.dataset.kind === 'reference';
        const id = card.dataset.course ?? '';
        const game = isReference ? mapGame({ name: id }) : 'slopesmith';
        const label = mapGameLabel(game);
        let metadata = card.querySelector<HTMLElement>('.library-map-origin');
        if (!metadata) {
          metadata = element('p', 'library-map-origin');
          card.querySelector('.public-map-heading')?.after(metadata);
        }
        metadata.textContent = `${label} · ${item.source === 'device' ? 'This device' : card.dataset.kind === 'private' ? 'Private server' : 'Server'}`;
        const matchesView =
          view === 'all' ||
          (view === 'custom' ? !isReference : isReference && item.source === 'server' && isoGameForCourse(id) === view);
        card.hidden =
          !matchesView ||
          (!gameView && source.value !== 'all' && item.source !== source.value) ||
          (!!query && !`${card.getAttribute('aria-label')} ${label} ${id}`.toLowerCase().includes(query));
        if (!card.hidden) count++;
      }
      const canOpenFolder =
        !gameView &&
        !query &&
        source.value !== 'server' &&
        item.source === 'device' &&
        !!item.section.querySelector('.public-open-folder');
      item.section.hidden = count === 0 && !canOpenFolder;
      shown += count;
    }
    empty.hidden = gameView || shown > 0;
    result.textContent = gameView ? 'Courses from your game file' : `${shown} map${shown === 1 ? '' : 's'}`;
    controller?.search(query);
  }
  search.oninput = update;
  source.onchange = update;
  open.onclick = () => controller?.chooseFile();
  setFormat(format);
  return {
    el,
    gameHost,
    gamesHost,
    summaryHost,
    update,
    selectGame: (game: IsoGame) => select(game, false),
    connect(next: LibraryGameController) {
      controller = next;
      if (view !== 'all' && view !== 'custom') next.selectGame(view);
      else if (url.searchParams.get('view') === 'games') select(next.currentGame());
      update();
    },
  };
}
