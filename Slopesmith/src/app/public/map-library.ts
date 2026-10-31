import './map-library.css';
import { element } from './dom';
import { ISO_GAMES, type IsoGame } from './iso-discs';
import { mapGame, mapGameLabel } from '../../core/reference/map-game';
import { mapAvailability } from './presentation';

type View = 'all' | 'custom' | IsoGame;
type Source = 'all' | 'device' | 'server';
export type LibrarySection = {
  section: HTMLElement;
  grid: HTMLElement;
  source: Exclude<Source, 'all'>;
};
export type LibraryFilter = { game: IsoGame | null; query: string; source: Source; enabled: boolean };
export type LibraryGameController = {
  selectGame: (game: IsoGame) => void;
  filter: (filter: LibraryFilter) => void;
  maps: HTMLElement;
  chooseFile: () => void;
  currentGame: () => IsoGame;
};

/** One browsing shell for authored mountains, server publications and local game imports. */
export function createMapLibrary(title: HTMLElement, sections: LibrarySection[]) {
  const isGameView = (view: View): view is IsoGame => ISO_GAMES.some(game => game.id === view);
  const el = element('div', 'map-library');
  el.dataset.layout = 'list';
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
  tools.append(searchLabel, sourceLabel);
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
  const folderHost = element('div', 'library-folder');
  for (const item of sections) {
    const folder = item.section.querySelector('.public-open-folder');
    if (folder) folderHost.append(folder);
  }
  workspace.append(tools, context, gameHost, catalogue, empty, folderHost);
  layout.append(sidebar, workspace);
  el.append(top, layout);
  let view: View = 'all';
  let controller: LibraryGameController | undefined;
  const url = new URL(location.href);
  const requestedGame = url.searchParams.get('game');
  if (ISO_GAMES.some(game => game.id === requestedGame)) view = requestedGame as IsoGame;
  else if (url.searchParams.get('view') === 'custom') view = 'custom';
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
    folderHost.hidden = gameView || source.value === 'server' || !!search.value.trim();
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
    controller?.filter({
      game: gameView ? (view as IsoGame) : null,
      query,
      source: source.value as Source,
      enabled: view !== 'custom',
    });
    const catalogueCards: HTMLElement[] = [];
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
        metadata.textContent = `${label}${card.dataset.kind === 'private' ? ' · Private' : ''}`;
        card
          .querySelector('.public-map-symbol')
          ?.replaceChildren(mapAvailability({ device: item.source === 'device', server: item.source === 'server' }));
        const matchesView = view === 'all' || (view === 'custom' && !isReference);
        card.hidden =
          !matchesView ||
          (!gameView && source.value !== 'all' && item.source !== source.value) ||
          (!!query && !`${card.getAttribute('aria-label')} ${label} ${id}`.toLowerCase().includes(query));
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
    result.textContent = `${shown} map${shown === 1 ? '' : 's'}`;
  }
  search.oninput = update;
  source.onchange = update;
  open.onclick = () => controller?.chooseFile();
  return {
    el,
    gameHost,
    gamesHost,
    summaryHost,
    update,
    selectGame: (game: IsoGame) => select(game, false),
    connect(next: LibraryGameController) {
      controller = next;
      catalogue.append(next.maps);
      if (isGameView(view)) next.selectGame(view);
      else if (url.searchParams.get('view') === 'games') select(next.currentGame());
      update();
    },
  };
}
