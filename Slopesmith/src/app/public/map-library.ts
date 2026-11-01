import './map-library.css';
import { element } from './dom';
import { ISO_GAMES, type IsoGame } from './iso-discs';
import { mapGame, mapGameLabel } from '../../core/reference/map-game';
import { mapAvailability } from './presentation';
import type { LibraryCounts, LibraryReferenceGroup, LibraryVisibility } from './library-courses';

type View = LibraryVisibility | LibraryReferenceGroup;
type Source = 'all' | 'device' | 'server';
export type LibrarySection = {
  section: HTMLElement;
  grid: HTMLElement;
  source: Exclude<Source, 'all'>;
};
export type LibraryFilter = { game: LibraryReferenceGroup | null; query: string; source: Source; enabled: boolean; visibility: LibraryVisibility };
export type LibraryGameController = {
  selectGame: (game: IsoGame) => void;
  filter: (filter: LibraryFilter) => void;
  maps: HTMLElement;
  currentGame: () => IsoGame;
  sourceCounts: () => Record<Source, number>;
  viewCounts: () => LibraryCounts;
};

/** One browsing shell for custom mountains, server publications and local game imports. */
export function createMapLibrary(title: HTMLElement, sections: LibrarySection[]) {
  const isGameView = (view: View): view is IsoGame => ISO_GAMES.some(game => game.id === view);
  const el = element('div', 'map-library');
  el.dataset.layout = 'list';
  const top = element('div', 'library-top');
  title.classList.remove('public-visually-hidden');
  title.textContent = 'Map library';
  const intro = element('div', 'library-intro');
  intro.append(title, element('p', '', 'Pick a map. Find your next run.'));
  const actions = element('div', 'library-actions');
  const createSlot = element('div', 'library-create');
  const loadMapHost = element('div', 'library-load-map-host');
  actions.append(createSlot, loadMapHost);
  top.append(intro, actions);
  const layout = element('div', 'library-layout');
  const sidebar = element('aside', 'library-sidebar');
  sidebar.setAttribute('aria-label', 'Map library');
  const libraryNav = element('nav', 'library-views');
  libraryNav.setAttribute('aria-label', 'Library views');
  const views = new Map<View, HTMLButtonElement>();
  const viewCounters = new Map<LibraryVisibility | 'other', HTMLElement>();
  for (const [id, label] of [
    ['all', 'All maps'],
    ['public', 'Public'],
    ['private', 'Private'],
  ] as const) {
    const button = element('button', '', label);
    button.type = 'button';
    const count = element('span', 'library-game-count');
    count.setAttribute('aria-hidden', 'true');
    button.append(count);
    viewCounters.set(id, count);
    button.onclick = () => select(id);
    views.set(id, button);
    libraryNav.append(button);
  }
  const gamesHost = element('div', 'library-games');
  const otherRow = element('div', 'public-iso-game-card');
  const otherName = element('dt', '');
  const other = element('button', 'public-iso-game', 'Other');
  other.type = 'button';
  other.dataset.game = 'other';
  other.setAttribute('aria-label', 'Other');
  other.setAttribute('aria-controls', 'library-map-catalogue');
  other.onclick = () => select('other');
  const otherCount = element('span', 'library-game-count');
  otherCount.setAttribute('aria-hidden', 'true');
  other.append(otherCount);
  views.set('other', other);
  viewCounters.set('other', otherCount);
  otherName.append(other);
  otherRow.append(otherName);
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
  let source: Source = 'all';
  const sourceFilters = element('div', 'public-iso-filters library-source-filters');
  sourceFilters.setAttribute('role', 'group');
  sourceFilters.setAttribute('aria-label', 'Filter map sources');
  const sourceButtons = new Map<Source, HTMLButtonElement>();
  for (const [value, label] of [
    ['all', 'All maps'],
    ['device', 'Local'],
    ['server', 'Server'],
  ] as const) {
    const button = element('button', '', label);
    button.type = 'button';
    button.setAttribute('aria-controls', 'library-map-catalogue');
    button.onclick = () => { source = value; update(); };
    sourceButtons.set(value, button);
    sourceFilters.append(button);
  }
  tools.append(searchLabel);
  const context = element('div', 'library-context');
  const heading = element('h2', '', 'All maps');
  const headingRow = element('div', 'library-heading');
  const gameActionsHost = element('div', '');
  headingRow.append(heading, gameActionsHost);
  context.append(headingRow);
  const gameHost = element('div', 'library-imports');
  gameHost.hidden = true;
  const catalogue = element('div', 'library-catalogue');
  catalogue.id = 'library-map-catalogue';
  catalogue.append(...sections.map(item => item.section));
  const empty = element('div', 'library-empty');
  empty.append(element('h3', '', 'No maps found'), element('p', '', 'Try another game, source or search.'));
  const reset = element('button', '', 'Clear filters');
  reset.type = 'button';
  reset.onclick = () => {
    search.value = '';
    source = 'all';
    select('all');
  };
  empty.append(reset);
  workspace.append(tools, context, sourceFilters, gameHost, catalogue, empty);
  layout.append(sidebar, workspace);
  el.append(top, layout);
  let view: View = 'all';
  let controller: LibraryGameController | undefined;
  const url = new URL(location.href);
  const requestedGame = url.searchParams.get('game');
  if (ISO_GAMES.some(game => game.id === requestedGame)) view = requestedGame as IsoGame;
  else if (url.searchParams.get('view') === 'public') view = 'public';
  else if (url.searchParams.get('view') === 'other') view = 'other';
  else if (['private', 'custom'].includes(url.searchParams.get('view') ?? '')) {
    view = 'private';
    if (url.searchParams.get('view') === 'custom') {
      url.searchParams.set('view', 'private');
      history.replaceState(history.state, '', url);
    }
  }
  function select(next: View, notify = true) {
    view = next;
    const url = new URL(location.href);
    if (!isGameView(next)) {
      url.searchParams.delete('game');
      for (const key of ['reference', 'map', 'source']) url.searchParams.delete(key);
      if (next === 'all') url.searchParams.delete('view');
      else url.searchParams.set('view', next);
    } else {
      url.searchParams.set('game', next);
      url.searchParams.set('view', 'games');
      if (notify) controller?.selectGame(next);
    }
    history.replaceState(history.state, '', url);
    update();
  }
  function update() {
    const gameView = isGameView(view);
    el.dataset.gameView = String(gameView);
    gameHost.hidden = !gameView;
    gameActionsHost.hidden = !gameView;
    sourceFilters.hidden = gameView;
    heading.textContent = gameView
      ? ISO_GAMES.find(game => game.id === view)!.name
      : view === 'other' ? 'Other references' : view === 'public' ? 'Public maps' : view === 'private' ? 'Private maps' : 'All maps';
    for (const [id, button] of views) button.setAttribute('aria-pressed', String(id === view));
    for (const button of gamesHost.querySelectorAll<HTMLButtonElement>('.public-iso-game')) {
      button.setAttribute('aria-pressed', String(button.dataset.game === view));
    }
    let shown = 0;
    const counts = { all: 0, device: 0, server: 0 };
    const visibilityCounts: LibraryCounts = { all: 0, public: 0, private: 0, other: 0 };
    const query = search.value.trim().toLowerCase();
    controller?.filter({
      game: view === 'other' ? 'other' : gameView ? (view as IsoGame) : null,
      query,
      source: gameView ? 'all' : source,
      enabled: true,
      visibility: view === 'public' || view === 'private' ? view : 'all',
    });
    const catalogueCards: HTMLElement[] = [];
    for (const item of sections) {
      const created = item.grid.querySelector('.public-new-map');
      if (created) {
        const link = created.querySelector('.public-tile-link');
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
        metadata.textContent = `${label}${card.dataset.kind === 'private' ? ' · Private' : ''}`;
        metadata.hidden = !isReference && (view === 'public' || view === 'private');
        const visibility = item.source === 'device' || card.dataset.kind === 'private' ? 'private' : 'public';
        visibilityCounts.all++;
        visibilityCounts[visibility]++;
        card
          .querySelector('.public-map-symbol')
          ?.replaceChildren(mapAvailability({
            device: item.source === 'device' && !card.dataset.folder,
            folder: card.dataset.folder,
            server: item.source === 'server',
            public: visibility === 'public',
          }));
        const matchesView = view === 'all' || view === visibility;
        const matchesQuery = !query || `${card.getAttribute('aria-label')} ${label} ${id}`.toLowerCase().includes(query);
        if (matchesView && matchesQuery) { counts.all++; counts[item.source]++; }
        card.hidden =
          !matchesView ||
          (!gameView && source !== 'all' && item.source !== source) ||
          !matchesQuery;
        if (!card.hidden) {
          count++;
          catalogueCards.push(card);
        }
      }
      item.section.hidden = count === 0;
      shown += count;
    }
    const gameCards = [...(controller?.maps.querySelectorAll<HTMLElement>('.public-course:not([hidden])') ?? [])];
    catalogueCards.push(...gameCards);
    shown += gameCards.length;
    catalogueCards.sort((a, b) =>
      (a.getAttribute('aria-label') ?? '').localeCompare(b.getAttribute('aria-label') ?? ''),
    );
    catalogueCards.forEach((card, index) => {
      card.style.order = String(index);
    });
    empty.hidden = gameView || shown > 0;
    const gameViewCounts = controller?.viewCounts();
    for (const [id, counter] of viewCounters) {
      const total = visibilityCounts[id] + (gameViewCounts?.[id] ?? 0);
      counter.textContent = String(total);
      views.get(id)!.title = `${total} map${total === 1 ? '' : 's'}`;
    }
    const gameCounts = controller?.sourceCounts();
    for (const [value, button] of sourceButtons) {
      const label = value === 'all' ? 'All maps' : value === 'device' ? 'Local' : 'Server';
      button.textContent = `${label} (${counts[value] + (gameCounts?.[value] ?? 0)})`;
      button.setAttribute('aria-pressed', String(value === source));
    }
  }
  search.oninput = update;
  return {
    el,
    gameHost,
    gamesHost,
    loadMapHost,
    gameActionsHost,
    update,
    showPrivateMaps() {
      search.value = '';
      source = 'all';
      select('private');
    },
    selectGame: (game: IsoGame) => select(game, false),
    connect(next: LibraryGameController) {
      controller = next;
      gamesHost.querySelector('.public-iso-support > dl')?.append(otherRow);
      catalogue.append(next.maps);
      if (isGameView(view)) next.selectGame(view);
      else if (url.searchParams.get('view') === 'games') select(next.currentGame());
      update();
    },
  };
}
