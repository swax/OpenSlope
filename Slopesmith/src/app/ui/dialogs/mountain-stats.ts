import {
  normalizeMountainStats, pageMegabytes, trisPerInstance, type MountainStats,
} from '../../../core/reference/census';
import { currentAccount } from '../../net/account';
import { fetchJson } from '../../net/fetch-json';
import { loadStored, saveStored, PINS_KEY, type StoredPins } from '../../state/storage';

/**
 * What every mountain in the library costs, in one table.
 *
 * The Reference picker can load one mountain at a time, which answers "what does GARIBALDI look like?" and
 * never "is what I am building affordable?". That second question is comparative by nature: a number like
 * 305,713 baked triangles means nothing until the six mountains either side of it are on the same page. So
 * this is a table rather than a readout, retail rows are marked, and the shipped courses' own range is pinned
 * underneath every column as the band a design is read against.
 *
 * Every column is a cost the target actually pays, and they do not trade against each other:
 *
 *  - **Patches** is the terrain quilt's size — the geometry that is always resident.
 *  - **Props / models / triangles** is placement density against distinct art. A mountain with 3,000 placements
 *    of 600 models is modular; one with 3,000 placements of 3,000 models carries five times the geometry for
 *    the same apparent density, which is exactly the difference between retail's instanced tables and what
 *    Slopesmith's export bakes (one mesh per placement — so an authored map's BAKED column is what it carries,
 *    and the honest comparison is against retail's DISTINCT column).
 *  - **Pages** is the one that runs out first: a repacked bank is a fixed list of texture slots.
 *  - **Lights / fx / rails** are the per-frame extras, which is where a mountain that looks cheap in triangles
 *    can still be expensive.
 *
 * Rows can be PINNED to the top and stay pinned across sessions. Comparison is usually against a handful of
 * mountains you have chosen — the two shipped courses closest to what you are building, plus your own last
 * export — and forty rows of test fixtures sit between them. A pin survives sorting, so the yardsticks stay
 * in view while the rest of the library is re-ordered underneath them.
 *
 * Read-only, and derived entirely from the map folders — nothing here can change a mountain.
 */

interface CensusResponse { mountains?: MountainStats[] }

type Align = 'name' | 'number';

interface Column {
  key: string;
  label: string;
  group: string;
  align: Align;
  title: string;
  /** The sort key and the band arithmetic; null keeps a row out of the band (an unrecovered course line). */
  value: (row: MountainStats) => number | null;
  /** How the cell reads. */
  text: (row: MountainStats) => string;
  /** How the shipped-seven band reads, given its ends. */
  band?: (low: number, high: number) => string;
}

const n = (value: number): string => Math.round(value).toLocaleString('en-US');
const km = (metres: number): string => `${(metres / 1000).toFixed(2)} km`;
const megabytes = (bytes: number): number => bytes / 1048576;
const band = (low: number, high: number): string => low === high ? n(low) : `${n(low)}–${n(high)}`;

/** An export date as a plain calendar day — the header states WHEN, and the hour is never the question. */
const exportDay = (iso: string): string => {
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? 'an unknown date'
    : when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};

const COLUMNS: Column[] = [
  {
    key: 'patches', label: 'patches', group: 'Terrain', align: 'number',
    title: 'Bezier patches in the terrain quilt — geometry that is always resident.',
    value: row => row.patches, text: row => n(row.patches), band,
  },
  {
    // Cheap on the disc — a placement is a transform and a model id — but every one was placed by somebody.
    key: 'props', label: 'props', group: 'Props', align: 'number',
    title: 'Visible placements — what the mountain reads as.',
    value: row => row.instances.visible, text: row => n(row.instances.visible), band,
  },
  {
    // The shipped courses reach thousands of placements from a few hundred models.
    key: 'models', label: 'models', group: 'Props', align: 'number',
    title: 'Distinct models placed. Props ÷ models is how modular the mountain is.',
    value: row => row.models.placed, text: row => n(row.models.placed), band,
  },
  {
    // An authored mountain's BAKED total is read against this column, because its export bakes one mesh per
    // placement rather than instancing (see the header note above).
    key: 'geomTris', label: 'distinct tris', group: 'Props', align: 'number',
    title: 'Triangles of distinct prop art, each mesh counted once however many models share it.',
    value: row => row.geomTris, text: row => n(row.geomTris), band,
  },
  {
    key: 'bakedTris', label: 'baked tris', group: 'Props', align: 'number',
    title: 'Placements × per-copy triangles: what the mountain draws. Retail earns the gap between this and its '
      + 'distinct column by instancing.',
    value: row => row.bakedTris, text: row => n(row.bakedTris), band,
  },
  {
    key: 'perProp', label: 'per prop', group: 'Props', align: 'number',
    title: 'Baked triangles per placement — “many small modules” vs “a few expensive models”.',
    value: row => trisPerInstance(row),
    text: row => { const value = trisPerInstance(row); return value === null ? '—' : n(value); },
    band,
  },
  {
    // A repacked bank is a fixed list of slots: every distinct tile a patch or a prop material names claims
    // one, flipbook frames included. Roughly 17–20 of every level's pages are the shared crowd flipbook and
    // pickup art.
    key: 'pages', label: 'pages', group: 'Textures', align: 'number',
    title: 'Texture pages in the folder — pages, not megabytes, are what runs out first.',
    value: row => row.pages.onDisk, text: row => n(row.pages.onDisk), band,
  },
  {
    // A disc's real figure comes from `snowknife repack --dry-run`, which knows each page's encoding.
    key: 'texels', label: 'texture MB', group: 'Textures', align: 'number',
    title: 'What those pages occupy at one byte per texel — format-independent, so mountains compare.',
    value: row => row.pages.texels,
    text: row => pageMegabytes(row.pages.texels).toFixed(2),
    band: (low, high) => `${pageMegabytes(low).toFixed(2)}–${pageMegabytes(high).toFixed(2)}`,
  },
  {
    key: 'lights', label: 'lights', group: 'Scene', align: 'number',
    title: 'Light records in the rig. Most bake into the lightmap, but sign and sprite lights are drawn.',
    value: row => row.extras.lights, text: row => n(row.extras.lights), band,
  },
  {
    key: 'particles', label: 'fx', group: 'Scene', align: 'number',
    title: 'Particle placements — snow plumes, fog spheres, steam. Genuinely per-frame work.',
    value: row => row.extras.particles, text: row => n(row.extras.particles), band,
  },
  {
    key: 'splines', label: 'rails', group: 'Scene', align: 'number',
    title: 'Native splines: grind rails and the paths animated props follow.',
    value: row => row.extras.splines, text: row => n(row.extras.splines), band,
  },
  {
    // The two board banks (zboard, zbxsfx) are excluded: every level's import writes the same copies, so
    // counting them would add the same ~140 slots to every row and bury the part that differs.
    key: 'soundBanks', label: 'banks', group: 'Sound', align: 'number',
    title: 'The mountain’s own SFX banks — course, crowd, and the named ambience it places.',
    value: row => row.sound.banks, text: row => n(row.sound.banks), band,
  },
  {
    key: 'soundSlots', label: 'slots', group: 'Sound', align: 'number',
    title: 'Populated slots across those banks — the budget a repack has to fit.',
    value: row => row.sound.slots, text: row => n(row.sound.slots), band,
  },
  {
    // The disc holds them ADPCM-compressed at roughly a quarter of the decoded size.
    key: 'soundBytes', label: 'sfx MB', group: 'Sound', align: 'number',
    title: 'What those slots occupy as decoded PCM — comparable between mountains, not a disc figure.',
    value: row => row.sound.bytes,
    text: row => megabytes(row.sound.bytes).toFixed(2),
    band: (low, high) => `${megabytes(low).toFixed(2)}–${megabytes(high).toFixed(2)}`,
  },
  {
    // Retail ships these on its three event courses only.
    key: 'soundSongs', label: 'songs', group: 'Sound', align: 'number',
    title: 'PathFinder race songs (a graph each). Most shipped levels read zero — not a gap.',
    value: row => row.sound.songs, text: row => n(row.sound.songs), band,
  },
  {
    key: 'course', label: 'course', group: 'Course', align: 'number',
    title: 'The recovered main racing line, top to bottom. A lap course reads short because its line is one lap.',
    value: row => row.course?.length ?? null,
    text: row => row.course ? km(row.course.length) : '—',
    band: (low, high) => `${(low / 1000).toFixed(2)}–${km(high)}`,
  },
  {
    // Steepness is what decides how fast a rider arrives at everything you place.
    key: 'drop', label: 'drop', group: 'Course', align: 'number',
    title: 'Vertical drop along that line — drop per kilometre is the mountain’s average steepness.',
    value: row => row.course?.drop ?? null,
    text: row => row.course ? `${n(row.course.drop)} m` : '—',
    band: (low, high) => `${n(low)}–${n(high)} m`,
  },
  {
    key: 'laps', label: 'laps', group: 'Course', align: 'number',
    title: 'Passes down the course that make a race. Every shipped course is a single pass except MEGAPLEX.',
    value: row => row.laps, text: row => String(row.laps), band,
  },
];

interface SortState { key: string; descending: boolean }

/**
 * The mountains pinned to the top, remembered across sessions.
 *
 * A pin for a folder that is not in the library right now is KEPT rather than pruned: a maps root that is
 * temporarily unmounted, or a mountain not yet re-exported, would otherwise silently drop the yardstick
 * somebody chose. It costs a string and it comes back the moment the folder does.
 */
function loadPins(): Set<string> {
  const stored = loadStored<StoredPins>(PINS_KEY);
  return new Set(Array.isArray(stored?.levels) ? stored.levels.filter(name => typeof name === 'string') : []);
}

const savePins = (pins: ReadonlySet<string>): void => saveStored(PINS_KEY, { levels: [...pins].sort() });

/**
 * Where a row sits. The table is read from the top, so the bands are ordered by how likely a row is to be the
 * one being looked for: your own mountain, then the yardsticks you chose, then the yardsticks that came with
 * the game, then the library.
 */
const enum Band { Own = 0, Pinned = 1, Shipped = 2, Rest = 3 }

/**
 * Open the comparison.
 *
 * `loaded` is the mountain in the Reference slot (highlighted, and scrolled to). `authored` is the name of the
 * mountain being built and `own` is the map folder its export lands in — when the library holds that folder it
 * is floated above everything else and dated, because "how does this compare with what I last shipped?" is the
 * question the table exists to answer; when it does not, the footer says the export has not happened yet.
 */
export function openMountainStatsDialog(loaded: string, authored: string, own: string): void {
  const back = document.createElement('div');
  back.className = 'sp-modal-back sp-stats-back';
  const dialog = document.createElement('section');
  dialog.className = 'sp-stats-modal';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-label', 'Mountain stats');
  back.appendChild(dialog);

  const header = document.createElement('header');
  header.className = 'sp-stats-head';
  const heading = document.createElement('div');
  const title = document.createElement('h2');
  title.textContent = 'What each mountain costs';
  const sub = document.createElement('p');
  sub.textContent = 'Measuring the library…';
  heading.append(title, sub);
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'sp-btn sp-stats-close';
  closeButton.textContent = '✕';
  closeButton.title = 'Close mountain stats';
  closeButton.onclick = () => close();
  header.append(heading, closeButton);
  dialog.appendChild(header);

  const toolbar = document.createElement('div');
  toolbar.className = 'sp-stats-toolbar';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'sp-stats-search';
  search.placeholder = 'filter mountains…';
  search.setAttribute('aria-label', 'Filter mountains by name');
  // Not a filter — a guarantee. Checked, the shipped courses are always in the list and always above the
  // library, whatever is typed in the search box: they are the band every row is read against, so a search
  // for "europa" is a question about EUROPA *versus them*, and dropping them answers half of it.
  //
  // The label carries no COUNT on purpose. It used to say seven, which was true of the library rather than
  // of the disc, and went quietly wrong the day an eighth course was extracted.
  const shippedOnly = document.createElement('label');
  shippedOnly.className = 'sp-stats-toggle';
  const shippedBox = document.createElement('input');
  shippedBox.type = 'checkbox';
  shippedBox.checked = true;
  shippedOnly.title = 'Keep the shipped courses listed above the library, whatever the search says.';
  shippedOnly.append(shippedBox, document.createTextNode('include shipped courses'));
  // Only shown once something is pinned: an always-present "unpin all" is a control for a state that is
  // usually empty, and it would read as the primary way to interact with a column nobody has used yet.
  const unpinAll = document.createElement('button');
  unpinAll.type = 'button';
  unpinAll.className = 'sp-btn sp-stats-unpin-all';
  unpinAll.onclick = () => { pins.clear(); savePins(pins); render(); };
  // Re-measure, for when the numbers are doubted. Every answer here is cached twice over — in the service's
  // response cache and, across restarts, on disk against a fingerprint (file sizes + timestamps) of the
  // folder — so the table normally costs a fingerprint rather than a measurement, and an export or a
  // re-extraction re-prices itself. That is right nearly always and unfalsifiable when it is wrong, which is
  // what this button is for: a folder changed in a way timestamps did not record (a restored backup, a copy
  // that kept its dates), or simply proving the table.
  const remeasure = document.createElement('button');
  remeasure.type = 'button';
  remeasure.className = 'sp-btn sp-stats-remeasure';
  remeasure.textContent = '↻ re-measure';
  remeasure.title = 'Read every map folder again, ignoring the caches — takes a few seconds. For folders '
    + 'that changed without their timestamps recording it.';
  // `?refresh=1` re-reads the whole library for everybody, so the service asks the moderator role of whoever
  // sends it (server/app.ts). Removed rather than left to fail for anyone else — presentation only; the route
  // repeats the check.
  void currentAccount().then(account => {
    const mayRemeasure = account.accounts === 'open'
      || ('user' in account && (account.user.role === 'admin' || account.user.role === 'moderator'));
    if (!mayRemeasure) remeasure.remove();
  });
  const hint = document.createElement('span');
  hint.className = 'sp-stats-hint';
  hint.textContent = 'Click ▲ to pin a mountain to the top · click a column to sort';
  toolbar.append(search, shippedOnly, unpinAll, remeasure, hint);
  dialog.appendChild(toolbar);

  const body = document.createElement('div');
  body.className = 'sp-stats-body';
  const status = document.createElement('div');
  status.className = 'sp-stats-status';
  status.textContent = 'Reading every map folder in the library — this takes a moment the first time.';
  body.appendChild(status);
  dialog.appendChild(body);

  const footer = document.createElement('footer');
  footer.className = 'sp-stats-foot';
  dialog.appendChild(footer);

  document.body.appendChild(back);

  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  back.addEventListener('mousedown', event => { if (event.target === back) close(); });
  function close() {
    document.removeEventListener('keydown', onKey);
    back.remove();
  }

  let mountains: MountainStats[] = [];
  // Shipped-seven-first, then alphabetical: the census tool's own order, and the one that puts the rows a
  // design is measured against at the top before anybody sorts by anything.
  let sort: SortState | null = null;
  /** The service answered without fields this page charts — it is running older code than the page is. */
  let stale = false;
  const pins = loadPins();

  const message = (error: unknown) => String(error instanceof Error ? error.message : error);
  const fail = (what: string, error: unknown) => {
    status.classList.add('error');
    status.textContent = `${what}: ${message(error)}`;
    body.replaceChildren(status);
  };

  /**
   * Fetch the library and draw it. `force` asks the service to ignore both of its caches and read every folder
   * again.
   *
   * A re-measure keeps the CURRENT table on screen while it runs, rather than replacing it with the "measuring
   * the library" placeholder the first load shows. Blanking a table somebody is reading in order to redraw it
   * with almost exactly the same numbers is the wrong trade: the point of the button is to confirm what is
   * already there, and taking it away is the one thing that makes the confirmation impossible.
   */
  async function load(force: boolean): Promise<void> {
    remeasure.disabled = true;
    if (force) remeasure.textContent = '↻ measuring…';
    try {
      const answer = await fetchJson<CensusResponse>(`/api/level-census${force ? '?refresh=1' : ''}`);
      const normalized = normalizeMountainStats(answer.mountains ?? []);
      mountains = normalized.rows;
      stale = normalized.filled;
      // The open mountain's own export leads the subtitle when there is one: the table's first question is
      // "how does this compare with what I last shipped?", and the answer starts with WHEN that was.
      const mine = mountains.find(row => row.level === own);
      // Name the folder only when it is not simply the mountain's name — an export usually lands in a folder
      // called exactly what the mountain is called, and "X … as X" is noise.
      const asFolder = authored && authored.toUpperCase() !== own ? ` as ${own}` : '';
      const dated = mine?.exported
        ? `${authored || own} last exported ${exportDay(mine.exported)}${asFolder}`
        : mine
          ? `${authored || own} is in the library${asFolder || ` as ${own}`}`
          : `${authored || 'This mountain'} has not been exported yet — nothing of yours to compare`;
      const read = force ? 'mountains re-read from their map folders just now' : 'mountains measured from '
        + 'their map folders';
      sub.textContent = `${dated} · ${mountains.length} ${read}`;
      // Drawing is a separate failure from measuring, and saying "could not measure the library" over a
      // rendering bug sends whoever reads it to look at the wrong half of the system.
      try { render(); } catch (error) { fail('Measured the library, but could not draw the comparison', error); }
    } catch (error) {
      // A failed re-measure must not wipe the table it was asked to confirm — the numbers on screen are still
      // the last ones the service gave, and they are better than an error page where a comparison was.
      if (force && mountains.length) sub.textContent = `Could not re-measure: ${message(error)}`;
      else fail('Could not measure the library', error);
    } finally {
      remeasure.disabled = false;
      remeasure.textContent = '↻ re-measure';
    }
  }

  void load(false);

  remeasure.onclick = () => { void load(true); };
  search.oninput = () => render();
  shippedBox.onchange = () => render();

  /** Which band a row belongs to. Your own export outranks a pin on it — one row, at the top, either way. */
  function bandOf(row: MountainStats): Band {
    if (row.level === own) return Band.Own;
    if (pins.has(row.level)) return Band.Pinned;
    return row.retail ? Band.Shipped : Band.Rest;
  }

  /**
   * The rows to draw, in order: own export, manual pins, the shipped courses, then the library — each band
   * ORDERED BY THE SAME SORT as the others. Pinning chooses what stays in view, not how it is read, so
   * clicking `baked tris` re-orders every band rather than freezing the top of the table.
   *
   * The search filters the LIBRARY band only. Your own export, a pinned mountain and the included seven all
   * survive it, because a search here is "how does X compare?" and the things X is compared against are
   * exactly the ones somebody chose to keep in view — dropping them answers half the question.
   *
   * Unchecking `include shipped courses` drops them from the list entirely, for looking at a shelf of your own
   * maps without retail between them. An explicit pin still beats it: pinning a course is a decision about
   * that course, and a category toggle should not overrule one.
   */
  function visibleRows(): MountainStats[] {
    const needle = search.value.trim().toLowerCase();
    const rows = mountains.filter(row => {
      const band = bandOf(row);
      if (band === Band.Shipped && !shippedBox.checked) return false;
      return band !== Band.Rest || !needle || row.level.toLowerCase().includes(needle);
    });
    const column = sort && COLUMNS.find(c => c.key === sort?.key);
    const within = !sort
      // Shipped-seven-first, then alphabetical.
      ? (a: MountainStats, b: MountainStats) => Number(b.retail) - Number(a.retail) || a.level.localeCompare(b.level)
      : !column
        ? (a: MountainStats, b: MountainStats) => (sort?.descending ? -1 : 1) * a.level.localeCompare(b.level)
        // An unmeasurable cell sorts to the bottom whichever way the column is pointing, so a missing course
        // line never displaces a real number from the end of the table being read.
        : (a: MountainStats, b: MountainStats) => {
          const left = column.value(a), right = column.value(b);
          if (left === null || right === null) return Number(left === null) - Number(right === null);
          return sort?.descending ? right - left : left - right;
        };
    return rows.sort((a, b) => bandOf(a) - bandOf(b) || within(a, b));
  }

  function togglePin(level: string): void {
    if (!pins.delete(level)) pins.add(level);
    savePins(pins);
    render();
  }

  /**
   * The per-row pin toggle: filled ▲ while pinned, hollow △ otherwise, so state reads without colour.
   *
   * Your own export is pinned by the fact that it is yours, not by a stored choice, so its control is a
   * disabled marker rather than a toggle — there is no state to store and unpinning it would only hide the
   * row the table is here to put something next to.
   */
  function pinButton(level: string): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    if (level === own) {
      button.className = 'sp-stats-pin on';
      button.textContent = '▲';
      button.disabled = true;
      button.title = 'Your own mountain’s export — always first.';
      return button;
    }
    const pinned = pins.has(level);
    button.className = `sp-stats-pin${pinned ? ' on' : ''}`;
    button.textContent = pinned ? '▲' : '△';
    button.setAttribute('aria-pressed', String(pinned));
    button.title = pinned
      ? `Unpin ${level} — it returns to its place in the sort.`
      : `Pin ${level} to the top. It stays there through sorting and across sessions.`;
    button.onclick = () => togglePin(level);
    return button;
  }

  function render(): void {
    if (!mountains.length) return;
    const rows = visibleRows();
    const shipped = mountains.filter(row => row.retail);
    unpinAll.textContent = `unpin all (${pins.size})`;
    unpinAll.title = 'Clear every pinned mountain.';
    unpinAll.style.display = pins.size ? '' : 'none';
    // The band under the columns is always the shipped courses', so say what it is even when they are not
    // listed — narrowing the view must not move the yardstick.
    footer.textContent = mountains.some(row => row.level === own)
      ? 'The band under each column is the range the shipped courses occupy, whatever the list shows.'
      : `${authored || 'This mountain'} is not here until it is exported. Export ▸ preflight prices it `
        + 'against the same shipped band.';
    // Columns the service never sent read as zero, which is indistinguishable from a mountain that has none of
    // that thing. Say which it is, and say the fix: `npm run dev` hot-updates this page but not the service.
    //
    // Naming re-measure here matters, because it is the obvious thing to reach for and the one thing that
    // cannot work: it makes the service read the folders again with the same code that has no column to put
    // the answer in. Somebody who presses it and sees nothing change learns the wrong lesson about the button.
    footer.classList.toggle('stale', stale);
    if (stale) {
      footer.textContent = 'This service is older than this page and answered without some of the columns '
        + 'below, so those read as zero rather than as a measurement. Re-measuring cannot fill them in — the '
        + 'running service has no code to compute them. Restart the server: `npm run dev` reloads the editor '
        + 'on every save but deliberately holds the API service across them.';
    }

    const table = document.createElement('table');
    table.className = 'sp-stats-table';

    // Two heading rows: the cost groups, then the columns. The groups are what make fourteen numbers legible.
    const head = document.createElement('thead');
    const groupRow = document.createElement('tr');
    groupRow.className = 'groups';
    const corner = document.createElement('th');
    corner.className = 'name';
    groupRow.appendChild(corner);
    for (let index = 0; index < COLUMNS.length;) {
      const group = COLUMNS[index].group;
      let span = 0;
      while (index + span < COLUMNS.length && COLUMNS[index + span].group === group) span++;
      const cell = document.createElement('th');
      cell.colSpan = span;
      cell.textContent = group;
      groupRow.appendChild(cell);
      index += span;
    }
    head.appendChild(groupRow);

    const columnRow = document.createElement('tr');
    const nameHead = document.createElement('th');
    nameHead.className = 'name sortable';
    nameHead.textContent = 'mountain';
    nameHead.title = 'The map folders under your Maps root: extracted courses and Slopesmith exports alike.';
    if (sort && !COLUMNS.some(c => c.key === sort?.key)) nameHead.classList.add('sorted');
    nameHead.onclick = () => { toggleSort('level'); };
    columnRow.appendChild(nameHead);
    for (const column of COLUMNS) {
      const cell = document.createElement('th');
      cell.className = `sortable ${column.align}`;
      cell.textContent = column.label;
      cell.title = column.title;
      if (sort?.key === column.key) cell.classList.add('sorted');
      cell.onclick = () => { toggleSort(column.key); };
      if (sort?.key === column.key) {
        const caret = document.createElement('i');
        caret.textContent = sort.descending ? '▾' : '▴';
        cell.appendChild(caret);
      }
      columnRow.appendChild(cell);
    }
    head.appendChild(columnRow);
    table.appendChild(head);

    const tbody = document.createElement('tbody');
    rows.forEach((row, index) => {
      const band = bandOf(row);
      const line = document.createElement('tr');
      if (row.retail) line.classList.add('retail');
      if (row.level === loaded) line.classList.add('loaded');
      if (band === Band.Own) line.classList.add('own');
      if (band <= Band.Pinned) line.classList.add('pinned');
      // A rule under the last row of every band above the library, so each block reads as a chosen set rather
      // than as the top of the sort — otherwise a pinned mountain that also sorts first is indistinguishable
      // from one that does not.
      const next = rows[index + 1];
      if (band !== Band.Rest && (!next || bandOf(next) !== band)) line.classList.add('band-edge');
      const name = document.createElement('th');
      name.className = 'name';
      name.scope = 'row';
      name.append(pinButton(row.level), document.createTextNode(row.level));
      if (band === Band.Own) {
        const mine = document.createElement('i');
        mine.className = 'own-tag';
        mine.textContent = row.exported ? exportDay(row.exported) : 'yours';
        mine.title = row.exported
          ? `${authored || own} as you last exported it, on ${exportDay(row.exported)}.`
          : `${authored || own}’s own map folder.`;
        name.appendChild(mine);
      }
      if (row.retail) {
        const star = document.createElement('i');
        star.textContent = '★';
        star.title = 'A shipped SSX Tricky course';
        name.appendChild(star);
      }
      line.appendChild(name);
      for (const column of COLUMNS) {
        const cell = document.createElement('td');
        cell.className = column.align;
        cell.textContent = column.text(row);
        line.appendChild(cell);
      }
      tbody.appendChild(line);
    });
    table.appendChild(tbody);

    // The band the shipped courses occupy, pinned under every column — the whole point of the table. It is
    // their own range whatever the filter shows, because narrowing the view must not move the yardstick.
    if (shipped.length) {
      const foot = document.createElement('tfoot');
      const line = document.createElement('tr');
      const label = document.createElement('th');
      label.className = 'name';
      label.scope = 'row';
      // The count is read off what is actually extracted rather than written into the label. A hardcoded
      // number was wrong the day an eighth course was imported, and said nothing about which ones are here.
      label.textContent = `shipped (${shipped.length})`;
      label.title = `The range the ${shipped.length} shipped SSX Tricky courses occupy: `
        + `${shipped.map(row => row.level).join(', ')}.`;
      line.appendChild(label);
      for (const column of COLUMNS) {
        const cell = document.createElement('td');
        cell.className = column.align;
        const values = shipped.map(column.value).filter((v): v is number => v !== null);
        cell.textContent = values.length
          ? (column.band ?? band)(Math.min(...values), Math.max(...values))
          : '—';
        line.appendChild(cell);
      }
      foot.appendChild(line);
      table.appendChild(foot);
    }

    body.replaceChildren(table);
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'sp-stats-status';
      empty.textContent = 'No mountain matches that filter.';
      body.appendChild(empty);
    }
    body.querySelector('tr.loaded')?.scrollIntoView({ block: 'nearest' });
  }

  function toggleSort(key: string): void {
    // First click on a numeric column shows the heaviest first, which is the question being asked of it.
    sort = sort?.key === key ? { key, descending: !sort.descending } : { key, descending: key !== 'level' };
    render();
  }
}
