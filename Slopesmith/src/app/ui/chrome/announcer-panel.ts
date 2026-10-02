import type GUI from 'lil-gui';
import {
  ANNOUNCER_EVENTS, ANNOUNCER_EVENT_IDS, normalizeAnnouncer, type AnnouncerIndex,
} from '../../../core/audio/announcer';
import type { EditDoc } from '../../../core/doc/doc-edit';
import { announcerClipUrls } from '../../audio/announcer';
import { auditionAnnouncer, stopAudition } from '../components/audition';
import { pickCustomSound } from '../components/custom-sounds';
import { note, tip } from '../components/gui';
import { toast } from '../components/toast';

/** First-pass Test voice authoring; source clips live in the mountain's existing sound library. */
export function renderAnnouncerPanel(parent: GUI, getDoc: () => EditDoc, changed: () => void,
  refresh: () => void, sounds: readonly string[], index: AnnouncerIndex): void {
  const folder = parent.addFolder('Announcer');
  const settings = normalizeAnnouncer(getDoc().announcer);
  const commit = () => { getDoc().announcer = normalizeAnnouncer(settings); changed(); };
  tip(folder.add(settings, 'volume', 0, 1, 0.01).name('volume').onChange(commit),
    'Voice level, also controlled by Test’s Game volume.');
  tip(folder.add(settings, 'cooldownSeconds', 0, 60, 0.5).name('cooldown s').onChange(commit),
    'Quiet time after each line. Start and wipeout calls can interrupt.');
  note(folder, 'Enable Announcer below Music in Test. These settings apply to both Test targets.',
    'Saved with this mountain; this first pass customizes Slopesmith playback only.');
  for (const id of ANNOUNCER_EVENT_IDS) {
    const event = ANNOUNCER_EVENTS[id];
    const section = folder.addFolder(event.label);
    const setting = settings.events[id];
    const state = { chance: Math.round(setting.chance * 100), file: setting.file ?? '' };
    tip(section.add(state, 'chance', 0, 100, 1).name('chance %').onChange((v: number) => {
      setting.chance = v / 100; commit();
    }), 'Chance of speaking when this event happens; zero disables the event.');
    const options: Record<string, string> = { 'Shared MC bank': '' };
    for (const file of sounds) options[file] = file;
    if (state.file && !sounds.includes(state.file)) options[`Missing: ${state.file}`] = state.file;
    section.add(state, 'file', options).name('voice').onChange((file: string) => {
      stopAudition();
      if (file) setting.file = file; else delete setting.file;
      commit();
    });
    const count = index[id]?.length ?? 0;
    note(section, count ? `${event.bank}: ${count} shared voice variants.`
      : `${event.bank}: no shared clips extracted. Load a WAV to use your own voice.`);
    tip(section.add({ load: async () => {
      const doc = getDoc();
      const file = await pickCustomSound();
      if (!file || getDoc() !== doc) return;
      setting.file = file; commit(); refresh();
    } }, 'load').name('⤒ load voice…'), 'Upload a WAV to this mountain’s sound library (up to 10 seconds).');
    section.add({ preview: () => {
      const urls = announcerClipUrls(index, settings, id);
      if (!urls.length) { toast('No voice clips available for this event.', 'warn'); return; }
      auditionAnnouncer(urls[Math.floor(Math.random() * urls.length)], settings.volume);
    } }, 'preview').name('▶ preview voice');
    section.close();
  }
  folder.add({ stop: stopAudition }, 'stop').name('■ stop preview');
  folder.close();
}
