/**
 * Sound Library: a browser over the extracted SFX banks, opened from a Play sound node in the Effects panel.
 *
 * A `MainType 8` node stores a DIRECT bank slot (docs/026), and there is no way to know from the number alone
 * what it holds — the banks are sparse and level-specific. This lists what each level actually ships, so a
 * slot is chosen by hearing it rather than by guessing a number. The course bank leads because it is the one
 * a PlaySound slot indexes; crowd, board and the named global banks are behind the same picker because they
 * are the same on-disk shape and are what collision / ExternalSounds events reach.
 *
 * Choosing a slot writes it straight onto the node, which is why the panel takes an `assign` callback rather
 * than making the author copy the number across.
 */
import { installStyles } from '../ui/components/styles';
import { modal } from '../ui/components/modal';
import { auditionBankSlot, auditionCustomSound, stopAudition } from '../ui/components/audition';
import { tooltip } from '../ui/components/tooltip';
import { customSoundFilepath, customSounds, loadCustomSounds } from '../ui/components/custom-sounds';
import { defaultLibrarySource } from '../ui/components/library-default';
import {
  collisionSoundEventIds, collisionSoundLabel, registerCollisionSoundIndex, resolveCollisionSound,
  type CollisionSoundIndex,
} from '../../core/effects/collision-sound';
import {
  externalSoundEventIds, externalSoundLabel, resolveExternalSound,
} from '../../core/effects/external-sound';

export type SoundBankKind = 'course' | 'crowd' | 'board' | 'named';

interface SoundBank {
  name: string;
  kind: SoundBankKind;
  slots: number[];
}

const KIND_NOTE: Record<SoundBankKind, string> = {
  course: 'The level’s group-2 course bank — the slots a Play sound node indexes and the target of prop collision-sound events.',
  crowd: 'The shared Crowd bank, reached by collision events 97–99.',
  board: 'A shared level-independent board bank (the ride’s own glide/carve/boost beds).',
  named: 'A fixed global environment bank, reached by name from an ExternalSounds event rather than by course slot.',
};

const css = `
.sp-sound-lib { width: min(760px, 92vw); box-sizing: border-box; padding: 12px 14px 10px; color: #d7e3f0;
  background: #0c141d; border: 1px solid #2c3e50; border-radius: 7px;
  font: 12px/1.45 system-ui, sans-serif; box-shadow: 0 12px 40px #0009; }
.sp-sound-lib h3 { margin: 0 0 8px; color: #cfe3f5; font: 600 13px system-ui, sans-serif; }
.sp-sound-lib .pickers { display: flex; gap: 8px; margin-bottom: 8px; }
.sp-sound-lib .pickers label { flex: 1 1 0; min-width: 0; color: #a9bdd0; font-size: 11px; }
.sp-sound-lib select { width: 100%; box-sizing: border-box; margin-top: 3px; background: #0e1822; color: #d7e3f0;
  border: 1px solid #2c3e50; border-radius: 4px; padding: 5px 7px; font: 12px/1.3 ui-monospace, Consolas, monospace; }
.sp-sound-lib select:focus { outline: 0; border-color: #3a6ea5; }
.sp-sound-lib .note { color: #7f97ac; font-size: 11px; margin: 0 0 8px; }
.sp-sound-lib .slots { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 6px;
  max-height: min(46vh, 380px); overflow-y: auto; padding: 2px; }
/* event rows carry a name and a destination, so they need room a bare slot number does not */
.sp-sound-lib .slots.events { grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); }
.sp-sound-lib .slot.event .num { text-align: left; font-size: 12px; }
.sp-sound-lib .slot .where { color: #7f97ac; font: 11px ui-monospace, Consolas, monospace; }
.sp-sound-lib .slot { display: flex; flex-direction: column; gap: 4px; padding: 6px; border-radius: 5px;
  background: #101b26; border: 1px solid #22364a; }
.sp-sound-lib .slot .num { color: #cfe3f5; font: 600 13px ui-monospace, Consolas, monospace; text-align: center; }
.sp-sound-lib .slot .acts { display: flex; gap: 4px; }
.sp-sound-lib .slot button { flex: 1 1 0; min-width: 0; cursor: pointer; background: #16232f; color: #cfe3f5;
  border: 1px solid #2c3e50; border-radius: 4px; padding: 3px 0; font: 11px system-ui, sans-serif; }
.sp-sound-lib .slot button:hover { background: #1d2f40; border-color: #3a6ea5; }
.sp-sound-lib .slot button.use { color: #9fe0b8; }
.sp-sound-lib .empty { color: #7f97ac; padding: 14px 2px; }
.sp-sound-lib .actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; }
.sp-sound-lib .actions button { cursor: pointer; background: #16232f; color: #cfe3f5; border: 1px solid #2c3e50;
  border-radius: 4px; padding: 5px 12px; font: 12px system-ui, sans-serif; }
.sp-sound-lib .actions button:hover { background: #1d2f40; border-color: #3a6ea5; }
`;

/**
 * What the browser assigns, which is not the same question as what it plays.
 *
 * `slots` is a Play sound node: its payload IS a course-bank slot. The two event modes are prop channels,
 * where the stored value is an id the engine remaps — so the pick has to be the id, never the slot it lands
 * on. That mapping is many-to-one (collision events 5 and 70 both resolve to slot 1), so a slot cannot be
 * turned back into the id a prop needs; the browse axis changes with the mode rather than the assignment
 * being derived from a shared one.
 */
export type SoundPickMode = 'slots' | 'collision-events' | 'external-events';

interface EventRow {
  id: number;
  label: string;
  /** Bank folder + slot to audition, or null for the resolver's authored-silent ids. */
  source: { bank: string; slot: number } | null;
}

const MODE_TITLE: Record<SoundPickMode, string> = {
  slots: 'Sound Library',
  'collision-events': 'Sound Library · impact events',
  'external-events': 'Sound Library · emitter events',
};

const MODE_NOTE: Record<SoundPickMode, string> = {
  slots: '',
  'collision-events': 'Prop hits store an ADL event id, not a slot — the engine remaps it through one global '
    + 'table, so an id means the same KIND of surface on every level, realized by whatever that level’s bank '
    + 'ships. Auditioned here against the level chosen above.',
  'external-events': 'Emitters store an ExternalSounds event id. Named events select clip 000 of a fixed '
    + 'global bank and sound the same everywhere; the rest fall through to the course/crowd resolver and '
    + 'depend on the level.',
};

/** Where one event id's clip lives, as a bank folder the audition route can read. Resolution uses the
 * selected level's Snowknife sidecar, including the executable/region it was extracted from. */
function eventSource(mode: SoundPickMode, id: number, level: string): { bank: string; slot: number } | null {
  if (mode === 'external-events') {
    const resolved = resolveExternalSound(id, level);
    if (!resolved) return null;
    return resolved.kind === 'fixed'
      ? { bank: resolved.bank, slot: 0 }
      : { bank: resolved.kind === 'crowd' ? 'crowd' : 'course', slot: resolved.slot };
  }
  const resolved = resolveCollisionSound(id, level);
  return resolved ? { bank: resolved.bank === 'crowd' ? 'crowd' : 'course', slot: resolved.slot } : null;
}

function eventRows(mode: SoundPickMode, level: string): EventRow[] {
  const ids = mode === 'external-events' ? externalSoundEventIds(level) : collisionSoundEventIds(level);
  const label = mode === 'external-events' ? externalSoundLabel : collisionSoundLabel;
  return ids.map(id => ({ id, label: label(id, level), source: eventSource(mode, id, level) }));
}

export interface SoundLibraryOptions {
  /** Open authored mountain name shown for its uploaded-WAV pseudo-level. */
  mountainName?: string;
  /** Which namespace is being picked from. Defaults to course-bank slots. */
  mode?: SoundPickMode;
  /** Level whose banks open first — the effect's donor / attached prop level. */
  level?: string;
  /** Slot (slots mode) or event id (event modes) highlighted on open. */
  slot?: number;
  /** Called with the value the author picked and the level it was heard on. The level matters as much as the
   *  number: a course slot holds a different sound in every bank, so whatever previews afterwards has to
   *  follow the choice here rather than keep its previous donor. */
  assign?: (value: number, level: string) => void;
  /** Called with an uploaded WAV the author picked from the Custom view. This is the third channel — neither
   *  a slot nor an event, but the file the export stages — so it is a separate callback rather than a value
   *  the other one could carry. Absent leaves Custom browse-only. */
  assignFile?: (file: string) => void;
  /** The uploaded clip selected on open, so Custom can mark it. */
  file?: string | null;
}

/** The author's own uploads, offered as a pseudo-level beside the extracted ones. */
const CUSTOM_SOUND_LEVEL = '@custom';

/** Open the browser. Resolves when it closes. */
export async function openSoundLibrary(opts: SoundLibraryOptions = {}): Promise<void> {
  installStyles('sound-library', css);
  const { host, close: closeModal } = modal();
  const panel = document.createElement('div');
  panel.className = 'sp-sound-lib';
  host.appendChild(panel);

  const mode = opts.mode ?? 'slots';
  const mountainName = opts.mountainName?.trim() || 'Mountain';
  const title = document.createElement('h3');
  title.textContent = MODE_TITLE[mode];
  const pickers = document.createElement('div');
  pickers.className = 'pickers';
  const note = document.createElement('p');
  note.className = 'note';
  const slots = document.createElement('div');
  slots.className = 'slots';
  const actions = document.createElement('div');
  actions.className = 'actions';
  panel.append(title, pickers, note, slots, actions);

  const labelled = (text: string, control: HTMLElement): HTMLLabelElement => {
    const label = document.createElement('label');
    label.append(document.createTextNode(text), control);
    return label;
  };
  const levelSelect = document.createElement('select');
  const bankSelect = document.createElement('select');
  pickers.appendChild(labelled('Level', levelSelect));
  // Events resolve their own bank — the id decides it — so the bank picker belongs to slot browsing only.
  if (mode === 'slots') pickers.appendChild(labelled('Bank', bankSelect));

  const done = document.createElement('button');
  done.textContent = 'Close';
  actions.appendChild(done);

  const close = () => { stopAudition(); closeModal(); };
  done.onclick = close;

  let banks: SoundBank[] = [];

  /** One id per row: its label, where it lands, ▶, and the assignment. Ids the resolver leaves unmapped are
   *  kept visible and marked silent rather than hidden — "this id plays nothing" is the fact an author needs
   *  when they meet one on an existing prop. */
  /** The author's own uploads: no bank, no slot, no event — just files, auditioned from their own route. */
  function renderCustom(): void {
    slots.replaceChildren();
    slots.classList.add('events');
    bankSelect.parentElement?.style.setProperty('display', 'none');
    note.textContent = 'This mountain’s uploaded WAVs. Export stages the chosen clip into a '
      + 'reserved course-bank slot, so these carry into a repacked ISO as well as into Unity.';
    const files = customSounds();
    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No uploaded sounds yet. Use ⤒ load WAV… on a prop or a Play sound node.';
      slots.appendChild(empty);
      return;
    }
    for (const file of files) {
      const cell = document.createElement('div');
      cell.className = 'slot event';
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = file;
      const where = document.createElement('div');
      where.className = 'where';
      where.textContent = customSoundFilepath(file, mountainName);
      const acts = document.createElement('div');
      acts.className = 'acts';
      const play = document.createElement('button');
      play.textContent = '▶';
      tooltip(play, `Audition ${file}.`);
      play.onclick = () => { auditionCustomSound(file); };
      acts.appendChild(play);
      if (opts.assignFile) {
        const use = document.createElement('button');
        use.className = 'use';
        use.textContent = 'use';
        tooltip(use, `Assign ${file}.`);
        use.onclick = () => { opts.assignFile!(file); close(); };
        acts.appendChild(use);
      }
      cell.append(num, where, acts);
      if (file === opts.file) cell.style.borderColor = '#3a6ea5';
      slots.appendChild(cell);
    }
  }

  function renderEvents(): void {
    slots.replaceChildren();
    note.textContent = MODE_NOTE[mode];
    slots.classList.add('events');
    for (const row of eventRows(mode, levelSelect.value)) {
      const cell = document.createElement('div');
      cell.className = 'slot event';
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = row.label;
      const where = document.createElement('div');
      where.className = 'where';
      where.textContent = row.source
        ? `${row.source.bank} ${String(row.source.slot).padStart(3, '0')}` : 'silent';
      const acts = document.createElement('div');
      acts.className = 'acts';
      if (row.source) {
        const play = document.createElement('button');
        play.textContent = '▶';
        tooltip(play, `Audition event ${row.id} as ${levelSelect.value} realizes it.`);
        play.onclick = () => { auditionBankSlot(levelSelect.value, row.source!.bank, row.source!.slot); };
        acts.appendChild(play);
      }
      if (opts.assign) {
        const use = document.createElement('button');
        use.className = 'use';
        use.textContent = 'use';
        tooltip(use, `Assign event id ${row.id}.`);
        use.onclick = () => { opts.assign!(row.id, levelSelect.value); close(); };
        acts.appendChild(use);
      }
      cell.append(num, where, acts);
      if (row.id === opts.slot) cell.style.borderColor = '#3a6ea5';
      slots.appendChild(cell);
    }
  }

  function renderSlots(): void {
    slots.replaceChildren();
    const bank = banks.find(candidate => candidate.name === bankSelect.value);
    note.textContent = bank ? KIND_NOTE[bank.kind] : '';
    if (!bank) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'This level has no extracted sound banks. Run `snowknife import` for it first.';
      slots.appendChild(empty);
      return;
    }
    for (const slot of bank.slots) {
      const cell = document.createElement('div');
      cell.className = 'slot';
      const num = document.createElement('div');
      num.className = 'num';
      num.textContent = String(slot).padStart(3, '0');
      const acts = document.createElement('div');
      acts.className = 'acts';
      const play = document.createElement('button');
      play.textContent = '▶';
      tooltip(play, `Audition ${levelSelect.value} ${bank.name} slot ${String(slot).padStart(3, '0')}.`);
      play.onclick = () => { auditionBankSlot(levelSelect.value, bank.name, slot); };
      acts.appendChild(play);
      // Only the course bank is addressable by a PlaySound slot number; assigning a crowd or named-bank
      // index would name a course slot that holds something else entirely, so those stay browse-only.
      if (opts.assign && bank.kind === 'course') {
        const use = document.createElement('button');
        use.className = 'use';
        use.textContent = 'use';
        tooltip(use, `Set this Play sound node's slot to ${slot}.`);
        use.onclick = () => { opts.assign!(slot, levelSelect.value); close(); };
        acts.appendChild(use);
      }
      cell.append(num, acts);
      if (slot === opts.slot && bank.kind === 'course') cell.style.borderColor = '#3a6ea5';
      slots.appendChild(cell);
    }
    if (!bank.slots.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'This bank ships no populated slots.';
      slots.appendChild(empty);
    }
  }

  async function loadLevel(level: string): Promise<void> {
    if (level === CUSTOM_SOUND_LEVEL) { renderCustom(); return; }
    slots.classList.remove('events');
    bankSelect.parentElement?.style.removeProperty('display');
    slots.replaceChildren();
    note.textContent = 'Loading…';
    try {
      const response = await fetch(`/api/sound-banks?level=${encodeURIComponent(level)}`);
      const body = (await response.json()) as { banks?: SoundBank[]; soundIndex?: CollisionSoundIndex };
      banks = body.banks ?? [];
      registerCollisionSoundIndex(body.soundIndex);
    } catch { banks = []; }
    if (mode !== 'slots') { renderEvents(); return; }
    bankSelect.replaceChildren();
    for (const bank of banks) {
      const option = document.createElement('option');
      option.value = bank.name;
      option.textContent = `${bank.name} (${bank.slots.length})`;
      bankSelect.appendChild(option);
    }
    bankSelect.value = (banks.find(bank => bank.kind === 'course') ?? banks[0])?.name ?? '';
    renderSlots();
  }

  levelSelect.onchange = () => { void loadLevel(levelSelect.value); };
  bankSelect.onchange = renderSlots;

  let levels: string[] = [];
  const [, uploads] = await Promise.all([
    fetch('/api/sound-banks').then(r => r.json())
      .then((body: { levels?: string[] }) => { levels = body.levels ?? []; })
      .catch(() => { levels = []; }),
    loadCustomSounds(),
  ]);
  // Custom leads whether or not it holds anything — like the Texture Library's own bank, it is the one
  // source that is authored rather than extracted, so it should not sit under a list of level names.
  const custom = document.createElement('option');
  custom.value = CUSTOM_SOUND_LEVEL;
  custom.textContent = `${mountainName} (${uploads.length})`;
  levelSelect.appendChild(custom);
  for (const level of levels) {
    const option = document.createElement('option');
    option.value = level;
    option.textContent = level;
    levelSelect.appendChild(option);
  }
  const wanted = (opts.level ?? '').trim().toUpperCase();
  const donor = levels.find(level => level.toUpperCase() === wanted);
  const has = (key: string) => key === CUSTOM_SOUND_LEVEL || levels.includes(key);
  // The caller's donor level is an explicit request, so it only loses to the author's own clips — which is
  // exactly the shared rule, with the donor standing in for "the level being studied".
  levelSelect.value = defaultLibrarySource({
    custom: CUSTOM_SOUND_LEVEL,
    hasCustom: uploads.length > 0 && !!opts.assignFile,
    reference: donor,
    has,
    fallback: levels[0] ?? CUSTOM_SOUND_LEVEL,
  });
  if (levelSelect.value) await loadLevel(levelSelect.value);
  else {
    note.textContent = '';
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No level has an extracted Audio/SFX tree yet.';
    slots.appendChild(empty);
  }
}
