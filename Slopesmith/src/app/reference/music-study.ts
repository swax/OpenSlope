import GUI from 'lil-gui';
import { musicWalkAtLevel, type ReferenceIntroMusic, type ReferenceMusicIndex,
  type ReferenceMusicSummary } from '../../core/reference/music';
import type { EnvironmentAudioBed } from '../../core/audio/environment';
import { BIG_AIR_WIND_SLOT, BOOST_BANK } from '../../core/audio/board-sound';
import { fetchJson } from '../net/fetch-json';
import { clearGui, detail, note, tip } from '../ui/components/gui';
import { openMusicGraphDialog } from '../ui/dialogs/music-graph';
import {
  auditionBoardSound, auditionEnvironmentBed, auditionReferenceIntroMusic, auditionReferenceMusicWalk,
  boardSoundAuditionPlaying, onBoardSoundAuditionChange, stopAudition,
} from '../ui/components/audition';
import {
  preloadReferenceRideMusic, referenceMusicGraph,
} from '../audio/ride-music';

/** Populate Scene ▸ Sound ▸ Reference with the shared rider cue plus the race-music graph JSON extracted
 * beside the level. Kept apart from the reference terrain session because it has no viewport state: it is a
 * small async data panel plus a self-contained graph dialog. */
export function createReferenceMusicStudy(folder: GUI) {
  let request = 0;
  let level: string | null = null;
  let intro: ReferenceIntroMusic | null = null;
  let environment: EnvironmentAudioBed | null = null;
  let songs: ReferenceMusicSummary[] = [];
  const selectedByLevel = new Map<string, string>();
  const introStemByLevel = new Map<string, string>();
  let unsubscribeBigAirAudition = () => {};

  /** The flight cue is shared game data, not a property of whichever reference happens to be loaded. Keep it
   * visible even with an empty reference slot so the panel does not accidentally present it as map ambience. */
  function beginPanel() {
    unsubscribeBigAirAudition();
    unsubscribeBigAirAudition = () => {};
    clearGui(folder);
    folder.title('Reference');
    folder.open(); // outer Scene card is a label; only its Sound subsections start collapsed

    const rider = folder.addFolder('Rider sound');
    detail(rider, 'big-air wind', 'cue');
    detail(rider, `${BOOST_BANK} ${String(BIG_AIR_WIND_SLOT).padStart(3, '0')}`, 'source');
    detail(rider, 'predicted flight > 1.5 s', 'trigger');
    note(rider, 'Shared focused-rider audio — not a map background bed or a weather sound.');
    const auditionControl = tip(rider.add({ audition: () => {
      if (boardSoundAuditionPlaying(BIG_AIR_WIND_SLOT, BOOST_BANK)) stopAudition();
      else auditionBoardSound(BIG_AIR_WIND_SLOT, BOOST_BANK);
    } }, 'audition'),
    'Hear the loop played while a jump is predicted to stay airborne past 1.5 s.');
    const syncAuditionControl = () => auditionControl.name(
      boardSoundAuditionPlaying(BIG_AIR_WIND_SLOT, BOOST_BANK) ? '■ stop big air' : '▶ preview big air');
    unsubscribeBigAirAudition = onBoardSoundAuditionChange(syncAuditionControl);
    syncAuditionControl();
    rider.close();
  }

  function clear() {
    stopAudition();
    request++;
    level = null; intro = null; environment = null; songs = [];
    beginPanel();
    note(folder, 'Load a reference mountain to inspect its race-music graph.');
  }

  async function setLevel(nextLevel: string | null) {
    if (nextLevel !== level) stopAudition();
    const token = ++request;
    level = nextLevel;
    intro = null; environment = null; songs = [];
    beginPanel();
    if (!nextLevel) {
      note(folder, 'Load a reference mountain to inspect its race-music graph.');
      return;
    }
    note(folder, 'Loading race-music graph index…');
    try {
      const index = await fetchJson<ReferenceMusicIndex>(`/api/reference-music?level=${encodeURIComponent(nextLevel)}`);
      if (token !== request || level !== nextLevel) return;
      intro = index.intro ?? null;
      environment = index.environment ?? null;
      songs = index.songs ?? [];
      preloadReferenceRideMusic(nextLevel);
      render();
    } catch (error) {
      if (token !== request || level !== nextLevel) return;
      beginPanel();
      note(folder, `No extracted race-music study for ${nextLevel}.`);
      tip(folder.add({ retry: () => void setLevel(nextLevel) }, 'retry').name('↻ retry'),
        `The study expects Maps/${nextLevel}/Audio/Music/playlist.json and each song's graph.json from snowknife race-music. ${error instanceof Error ? error.message : error}`);
    }
  }

  function render() {
    beginPanel();
    if (!level) return;

    if (environment) {
      const bed = folder.addFolder('Environment filler');
      detail(bed, `${environment.Bank} ${String(environment.Slot).padStart(3, '0')}`, 'source');
      detail(bed, environment.Volume.toFixed(2), 'volume');
      detail(bed, 'off-board', 'use');
      note(bed, 'An OpenSlope silence filler (Audio/Environment.json), not a retail weather or ExternalSounds emitter.');
      bed.add({ preview: () => auditionEnvironmentBed(`reference-environment:${level}`,
        environment!.Bank, environment!.Slot, environment!.Volume, level!) }, 'preview')
        .name('▶ preview environment');
      bed.add({ stop: stopAudition }, 'stop').name('■ stop preview');
      bed.close();
    } else note(folder, 'This reference declares no environment filler.');

    if (intro?.stems.length) {
      const introFolder = folder.addFolder('Intro / ambient music');
      detail(introFolder, `${intro.tier} tier · ${intro.stems.length} stems`, 'playback set');
      detail(introFolder, '0.25 s shuffled crossfade', 'sequencing');
      note(introFolder, 'Available for direct study here; Test prefers the map-declared environment bed off-board.');
      let stem = introStemByLevel.get(level) ?? intro.stems[0];
      if (!intro.stems.includes(stem)) stem = intro.stems[0];
      introStemByLevel.set(level, stem);
      const stemState = { stem };
      const stemOptions = Object.fromEntries(intro.stems.map(name => [name, name]));
      introFolder.add(stemState, 'stem', stemOptions).name('stem').onChange((name: string) => {
        stopAudition();
        introStemByLevel.set(level!, name);
      });
      introFolder.add({ preview: () => {
        const selected = introStemByLevel.get(level!) ?? intro!.stems[0];
        auditionReferenceIntroMusic(level!, selected);
      } }, 'preview').name('▶ preview stem');
      introFolder.add({ stop: stopAudition }, 'stop').name('■ stop preview');
      introFolder.close();
    } else note(folder, 'This reference has no extracted intro-music stems.');

    if (!songs.length) {
      note(folder, 'This reference has no extracted race-music graphs.');
      return;
    }
    const race = folder.addFolder('Race music');
    let selected = selectedByLevel.get(level) ?? songs[0].id;
    if (!songs.some(song => song.id === selected)) selected = songs[0].id;
    selectedByLevel.set(level, selected);
    const state = { song: selected };
    const options: Record<string, string> = {};
    for (const song of songs) options[`${song.title} · ${song.bpm.toFixed(1)} BPM`] = song.id;
    tip(race.add(state, 'song', options).name('race song').onChange((id: string) => {
      if (!level) return;
      stopAudition();
      selectedByLevel.set(level, id);
      render();
    }), 'A course cycles through these PathFinder songs between races. Choose one to inspect its native graph.');

    const song = songs.find(item => item.id === selected) ?? songs[0];
    detail(race, `${song.nodes} nodes · ${song.samples} audio samples`, 'graph');
    detail(race, `${song.sections} sections · ${song.events} event slots · ${song.routers} routers`, 'routing');
    detail(race, `${(song.totalSeconds / 60).toFixed(1)} min of graph slots · ${song.averageChunkSeconds.toFixed(2)} s average`, 'streaming');
    note(race, 'Test follows path level 0–127 from speed, air and boost, and switches at native chunk boundaries.');
    tip(race.add({ preview: () => void (async () => {
      const graph = await referenceMusicGraph(level!, song.id);
      if (!graph) return;
      const walk = musicWalkAtLevel(graph, 0, 80, 12);
      if (walk.samples.length) void auditionReferenceMusicWalk(level!, song.id, walk.samples);
    })() }, 'preview').name('▶ preview normal path'),
    'Play twelve native chunks at the game’s normal path level (80).');
    race.add({ stop: stopAudition }, 'stop').name('■ stop preview');
    tip(race.add({ open: () => level && openMusicGraphDialog(level, song) }, 'open').name('↗ open annotated graph…'),
      'Open the complete node/link diagram.');
    race.close();
  }

  clear();
  return { setLevel, clear };
}

export type ReferenceMusicStudy = ReturnType<typeof createReferenceMusicStudy>;
