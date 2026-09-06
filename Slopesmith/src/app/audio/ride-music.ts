import type { RaceMusicArrangement } from '../../core/doc/types';
import type { AuthoredEnvironmentBed, EnvironmentAudioBed } from '../../core/audio/environment';
import {
  decodeMusicEventTable, decodeMusicLink, decodeMusicRouter, musicNodeSection,
  type ReferenceMusicGraph, type ReferenceMusicIndex,
} from '../../core/reference/music';
import { MAX_SPEED } from '../ride/physics-tuning';
import { customMusicUrl } from '../net/asset-paths';
import { environmentSoundUrl } from '../net/asset-paths';
import { fetchJson } from '../net/fetch-json';
import {
  gameAudioDestination, preloadAudio, resumeSharedAudio, sharedAudioBuffer, sharedAudioContext,
} from './runtime';

const INTRO_VOLUME = 0.30;
const RACE_VOLUME = 0.42;
const INTRO_CROSSFADE_SECONDS = 0.25;
const RACE_FADE_SECONDS = 1.5;
const RACE_SCHEDULE_AHEAD_SECONDS = 0.5;
const ENVIRONMENT_FADE_SECONDS = 1.5;

const referenceIndexCache = new Map<string, Promise<ReferenceMusicIndex | null>>();
const referenceGraphCache = new Map<string, Promise<ReferenceMusicGraph | null>>();

export const referenceIntroMusicUrl = (level: string, stem: string): string =>
  `/api/reference-intro-music?level=${encodeURIComponent(level)}&stem=${encodeURIComponent(stem)}`;

export const referenceRaceMusicUrl = (level: string, song: string, sample: number): string =>
  `/api/reference-music-sample?level=${encodeURIComponent(level)}`
  + `&song=${encodeURIComponent(song)}&sample=${sample}`;

export const referenceEnvironmentUrl = (level: string, bed: EnvironmentAudioBed): string =>
  `/api/effect-sound?level=${encodeURIComponent(level)}&slot=${bed.Slot}`
  + `&bank=${encodeURIComponent(bed.Bank)}&loop=1`;

export function referenceMusicIndex(level: string): Promise<ReferenceMusicIndex | null> {
  const key = level.trim();
  if (!key) return Promise.resolve(null);
  let pending = referenceIndexCache.get(key);
  if (!pending) {
    pending = fetchJson<ReferenceMusicIndex>(`/api/reference-music?level=${encodeURIComponent(key)}`)
      .catch(() => null);
    referenceIndexCache.set(key, pending);
  }
  return pending;
}

export function referenceMusicGraph(level: string, song: string): Promise<ReferenceMusicGraph | null> {
  const key = `${level.trim()}:${song.trim()}`;
  if (!level.trim() || !song.trim()) return Promise.resolve(null);
  let pending = referenceGraphCache.get(key);
  if (!pending) {
    pending = fetchJson<ReferenceMusicGraph>(`/api/reference-music?level=${encodeURIComponent(level)}`
      + `&song=${encodeURIComponent(song)}`).catch(() => null);
    referenceGraphCache.set(key, pending);
  }
  return pending;
}

function pickLink(graph: ReferenceMusicGraph, nodeIndex: number, pathLevel: number): number {
  const node = graph.Nodes[nodeIndex];
  if (!node?.LinkRaw.length) return -1;
  const links = node.LinkRaw.map(decodeMusicLink);
  const level = Math.max(0, Math.min(127, Math.trunc(pathLevel)));
  return (links.find(link => link.min <= level && level <= link.max) ?? links[0]).target;
}

/** Pass through PathFinder control nodes until an audible, one-based sample node is reached. Mirrors the
 * bounded Unity walk: malformed graphs go silent rather than trapping the render loop. */
export function resolveMusicSampleNode(graph: ReferenceMusicGraph, start: number, pathLevel: number): number {
  let node = Math.trunc(start);
  for (let guard = 0; guard < 16; guard++) {
    const record = graph.Nodes[node];
    if (!record) return -1;
    if (record.Sample > 0 && record.Sample <= graph.Samples.length) return node;
    node = pickLink(graph, node, pathLevel);
  }
  return -1;
}

function resolveMusicEvent(graph: ReferenceMusicGraph, event: number, nodeIndex: number,
  pathLevel: number): number {
  const section = Math.min(Math.max(0, musicNodeSection(graph.Nodes[nodeIndex])), graph.Sections - 1);
  const table = decodeMusicEventTable(graph.EventTable);
  const at = ((event * graph.Tracks) * graph.Sections) + section;
  const routerIndex = table[at];
  if (routerIndex === undefined || routerIndex >= graph.Routers.length) return -1;
  const router = decodeMusicRouter(graph.Routers[routerIndex]);
  if (!router.changesNode || router.target >= graph.Nodes.length) return -1;
  return resolveMusicSampleNode(graph, router.target, pathLevel);
}

/** Warm the intro tier and the first two ordinary race chunks when a reference is selected. This keeps the
 * first mount off the network/decode path without decoding hundreds of PathFinder chunks up front. */
export function preloadReferenceRideMusic(level: string): void {
  void referenceMusicIndex(level).then(async index => {
    if (!index) return;
    // The map-declared environment bed is Test's off-board layer. Intro stems remain available to the Sound
    // reference panel, and are only the runtime fallback for an older/external Maps folder with no declaration.
    if (index.environment) preloadAudio([referenceEnvironmentUrl(level, index.environment)]);
    else preloadAudio(index.intro?.stems.map(stem => referenceIntroMusicUrl(level, stem)) ?? []);
    const song = index.songs[0]?.id;
    if (!song) return;
    const graph = await referenceMusicGraph(level, song);
    if (!graph) return;
    const first = resolveMusicSampleNode(graph, 0, 80);
    if (first < 0) return;
    const second = resolveMusicSampleNode(graph, pickLink(graph, first, 80), 80);
    preloadAudio([first, second].filter(node => node >= 0)
      .map(node => referenceRaceMusicUrl(level, song, graph.Nodes[node].Sample)));
  });
}

/** Warm an authored master from Test setup; the later mount reuses the decoded page-lifetime buffer. */
export function preloadAuthoredRideMusic(track: string | null | undefined,
  environment?: AuthoredEnvironmentBed | null): void {
  if (track) preloadAudio([customMusicUrl(track)]);
  if (environment) preloadAudio([environmentSoundUrl(environment.bank, 0, true)]);
}

export interface RideMusicFrame {
  active: boolean;
  target: 'authored' | 'reference';
  referenceLevel: string;
  authoredTrack: string | null;
  authoredArrangement: RaceMusicArrangement;
  authoredEnvironment: AuthoredEnvironmentBed | null;
  mounted: boolean;
  speed: number;
  grounded: boolean;
  airTime: number;
  boosting: boolean;
}

/** One simple Test-mode state machine: environment off-board, race music on-board. */
export function rideMusicMixTargets(mounted: boolean, hasRace: boolean, hasEnvironment: boolean): {
  race: number; environment: number;
} {
  return {
    race: mounted && hasRace ? 1 : 0,
    environment: !mounted && hasEnvironment ? 1 : 0,
  };
}

/** The Test music checkbox is a preference, while a locally playing Jukebox is a temporary override. */
export function rideMusicPlaybackEnabled(musicChecked: boolean, jukeboxPlaying: boolean): boolean {
  return musicChecked && !jukeboxPlaying;
}

type Voice = { source: AudioBufferSourceNode; gain: GainNode; start: number; end: number; node?: number };

const moveTowards = (value: number, target: number, maxDelta: number): number =>
  value < target ? Math.min(target, value + maxDelta) : Math.max(target, value - maxDelta);

/** The Test-mode counterpart of Unity's MusicDirector + RaceMusicDirector. It owns no assets: every buffer
 * comes from Snowknife's Maps intermediate or the authored project music library, through the shared page
 * AudioContext. */
export class RideMusicRuntime {
  private generation = 0;
  private configKey = '';
  private context: AudioContext | null = null;
  private introMaster: GainNode | null = null;
  private raceMaster: GainNode | null = null;
  private environmentMaster: GainNode | null = null;
  private environmentVoice: Voice | null = null;
  private environmentVolume = 0;
  private environmentFade = 0;
  private introBuffers: AudioBuffer[] = [];
  private introBag: number[] = [];
  private introBagAt = 0;
  private introLast = -1;
  private introCurrent: Voice | null = null;
  private introQueued: Voice | null = null;
  private raceGraph: ReferenceMusicGraph | null = null;
  private raceLevel = '';
  private raceSong = '';
  private customBuffer: AudioBuffer | null = null;
  private customArrangement: RaceMusicArrangement | null = null;
  private raceCurrent: Voice | null = null;
  private raceQueued: Voice | null = null;
  private raceQueuePending = false;
  private raceFade = 0;
  private intensity = 20;
  private pendingEvent = -1;
  private boostWasHeld = false;

  step(dt: number, frame: RideMusicFrame): void {
    if (!frame.active) { this.stop(); return; }
    resumeSharedAudio();
    const key = frame.target === 'reference'
      ? `reference:${frame.referenceLevel}`
      : `authored:${frame.authoredTrack ?? ''}:${JSON.stringify(frame.authoredArrangement)}`
        + `:${JSON.stringify(frame.authoredEnvironment)}`;
    if (key !== this.configKey) this.configure(key, frame);

    const hasRace = !!this.raceGraph || !!this.customBuffer;
    const targets = rideMusicMixTargets(frame.mounted, hasRace, !!this.environmentVoice);
    this.raceFade = moveTowards(this.raceFade, targets.race,
      Math.max(0, dt) / RACE_FADE_SECONDS);
    if (this.introMaster) this.introMaster.gain.value = INTRO_VOLUME * (1 - this.raceFade);
    if (this.raceMaster) this.raceMaster.gain.value = RACE_VOLUME * this.raceFade;
    this.environmentFade = moveTowards(this.environmentFade, targets.environment,
      Math.max(0, dt) / ENVIRONMENT_FADE_SECONDS);
    if (this.environmentMaster)
      this.environmentMaster.gain.value = this.environmentVolume * this.environmentFade;

    this.stepIntro();
    if (!hasRace) return;
    if (frame.mounted) {
      if (!this.raceCurrent) this.startRace();
      if (frame.boosting !== this.boostWasHeld) {
        this.pendingEvent = frame.boosting ? 1 : 2;
        this.boostWasHeld = frame.boosting;
      }
    }
    this.stepIntensity(dt, frame);
    this.stepRace();
    if (!frame.mounted && this.raceFade <= 0) this.stopRace();
  }

  stop(): void {
    if (!this.configKey && !this.context) return;
    this.generation++;
    this.configKey = '';
    this.stopVoices([this.introCurrent, this.introQueued, this.raceCurrent, this.raceQueued, this.environmentVoice]);
    this.introCurrent = this.introQueued = this.raceCurrent = this.raceQueued = this.environmentVoice = null;
    this.introMaster?.disconnect();
    this.raceMaster?.disconnect();
    this.environmentMaster?.disconnect();
    this.context = null;
    this.introMaster = this.raceMaster = this.environmentMaster = null;
    this.introBuffers = [];
    this.raceGraph = null;
    this.customBuffer = null;
    this.raceFade = 0;
    this.environmentFade = this.environmentVolume = 0;
    this.intensity = 20;
    this.raceQueuePending = false;
    this.pendingEvent = -1;
    this.boostWasHeld = false;
  }

  private configure(key: string, frame: RideMusicFrame): void {
    this.stop();
    this.configKey = key;
    this.context = sharedAudioContext();
    this.introMaster = this.context.createGain();
    this.raceMaster = this.context.createGain();
    this.environmentMaster = this.context.createGain();
    this.introMaster.gain.value = INTRO_VOLUME;
    this.raceMaster.gain.value = 0;
    this.environmentMaster.gain.value = 0;
    const destination = gameAudioDestination();
    this.introMaster.connect(destination);
    this.raceMaster.connect(destination);
    this.environmentMaster.connect(destination);
    const generation = this.generation;
    if (frame.target === 'reference') void this.loadReference(frame.referenceLevel, generation);
    else {
      if (frame.authoredTrack) void this.loadCustom(frame.authoredTrack, frame.authoredArrangement, generation);
      if (frame.authoredEnvironment) void this.loadAuthoredEnvironment(frame.authoredEnvironment, generation);
    }
  }

  private async loadReference(level: string, generation: number): Promise<void> {
    const index = await referenceMusicIndex(level);
    if (!index || generation !== this.generation || !this.context) return;
    const [intro, graph, environment] = await Promise.all([
      Promise.all((index.environment ? [] : index.intro?.stems ?? [])
        .map(stem => sharedAudioBuffer(referenceIntroMusicUrl(level, stem)))),
      index.songs[0] ? referenceMusicGraph(level, index.songs[0].id) : Promise.resolve(null),
      index.environment ? sharedAudioBuffer(referenceEnvironmentUrl(level, index.environment)) : Promise.resolve(null),
    ]);
    if (generation !== this.generation || !this.context) return;
    this.introBuffers = intro.filter((buffer): buffer is AudioBuffer => !!buffer);
    this.introBag = [];
    this.introBagAt = 0;
    if (environment && index.environment) this.startEnvironment(environment, index.environment.Volume);
    if (index.songs[0] && graph) {
      this.raceGraph = graph;
      this.raceLevel = level;
      this.raceSong = index.songs[0].id;
    }
  }

  private async loadCustom(track: string, arrangement: RaceMusicArrangement, generation: number): Promise<void> {
    const buffer = await sharedAudioBuffer(customMusicUrl(track));
    if (generation !== this.generation || !this.context || !buffer) return;
    this.customBuffer = buffer;
    this.customArrangement = arrangement;
  }

  private async loadAuthoredEnvironment(bed: AuthoredEnvironmentBed, generation: number): Promise<void> {
    const buffer = await sharedAudioBuffer(environmentSoundUrl(bed.bank, 0, true));
    if (generation !== this.generation || !this.context || !buffer) return;
    this.startEnvironment(buffer, bed.volume);
  }

  private startEnvironment(buffer: AudioBuffer, volume: number): void {
    if (!this.context || !this.environmentMaster || this.environmentVoice) return;
    const source = this.context.createBufferSource();
    const gain = this.context.createGain();
    source.buffer = buffer;
    source.loop = true;
    gain.gain.value = 1;
    source.connect(gain).connect(this.environmentMaster);
    source.start();
    this.environmentVoice = { source, gain, start: this.context.currentTime, end: Number.POSITIVE_INFINITY };
    this.environmentVolume = Math.min(1, Math.max(0, volume));
  }

  private stepIntro(): void {
    const context = this.context;
    if (!context || !this.introMaster || !this.introBuffers.length) return;
    const now = context.currentTime;
    if (!this.introCurrent) {
      this.introCurrent = this.startIntroVoice(this.nextIntroBuffer(), now + 0.02, 1);
      return;
    }
    if (!this.introQueued && now >= this.introCurrent.end - INTRO_CROSSFADE_SECONDS) {
      const start = Math.max(now + 0.01, this.introCurrent.end - INTRO_CROSSFADE_SECONDS);
      const endFade = start + INTRO_CROSSFADE_SECONDS;
      this.introCurrent.gain.gain.cancelScheduledValues(start);
      this.introCurrent.gain.gain.setValueAtTime(this.introCurrent.gain.gain.value, start);
      this.introCurrent.gain.gain.linearRampToValueAtTime(0, endFade);
      this.introQueued = this.startIntroVoice(this.nextIntroBuffer(), start, 0);
      this.introQueued.gain.gain.linearRampToValueAtTime(1, endFade);
    }
    if (this.introQueued && now >= this.introCurrent.end) {
      this.stopVoices([this.introCurrent]);
      this.introCurrent = this.introQueued;
      this.introQueued = null;
    }
  }

  private startIntroVoice(buffer: AudioBuffer, start: number, gainValue: number): Voice {
    const context = this.context!;
    const source = context.createBufferSource();
    const gain = context.createGain();
    source.buffer = buffer;
    gain.gain.setValueAtTime(gainValue, start);
    source.connect(gain).connect(this.introMaster!);
    source.start(start);
    return { source, gain, start, end: start + buffer.duration };
  }

  private nextIntroBuffer(): AudioBuffer {
    if (this.introBagAt >= this.introBag.length) {
      this.introBag = this.introBuffers.map((_buffer, index) => index);
      for (let i = this.introBag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.introBag[i], this.introBag[j]] = [this.introBag[j], this.introBag[i]];
      }
      if (this.introBag.length > 1 && this.introBag[0] === this.introLast)
        [this.introBag[0], this.introBag[this.introBag.length - 1]] =
          [this.introBag[this.introBag.length - 1], this.introBag[0]];
      this.introBagAt = 0;
    }
    const index = this.introBag[this.introBagAt++];
    this.introLast = index;
    return this.introBuffers[index];
  }

  private startRace(): void {
    if (!this.context || !this.raceMaster || this.raceCurrent) return;
    if (this.customBuffer) {
      const source = this.context.createBufferSource();
      const gain = this.context.createGain();
      const start = this.context.currentTime + 0.02;
      const arrangement = this.customArrangement;
      source.buffer = this.customBuffer;
      source.loop = true;
      source.loopStart = Math.min(arrangement?.loopStartSeconds ?? 0, Math.max(0, this.customBuffer.duration - 0.01));
      source.loopEnd = arrangement?.loopEndSeconds
        ? Math.min(this.customBuffer.duration, arrangement.loopEndSeconds) : this.customBuffer.duration;
      if (source.loopEnd <= source.loopStart) source.loopEnd = this.customBuffer.duration;
      source.connect(gain).connect(this.raceMaster);
      source.start(start);
      this.raceCurrent = { source, gain, start, end: Number.POSITIVE_INFINITY };
      return;
    }
    const graph = this.raceGraph;
    if (!graph) return;
    const node = resolveMusicSampleNode(graph, 0, this.intensity);
    if (node < 0) return;
    const generation = this.generation;
    const sample = graph.Nodes[node].Sample;
    void sharedAudioBuffer(referenceRaceMusicUrl(this.raceLevel, this.raceSong, sample)).then(buffer => {
      if (!buffer || generation !== this.generation || !this.context || this.raceCurrent) return;
      const start = this.context.currentTime + 0.05;
      this.raceCurrent = this.startRaceVoice(buffer, node, start);
    });
  }

  private startRaceVoice(buffer: AudioBuffer, node: number, start: number): Voice {
    const source = this.context!.createBufferSource();
    const gain = this.context!.createGain();
    source.buffer = buffer;
    source.connect(gain).connect(this.raceMaster!);
    source.start(start);
    return { source, gain, node, start, end: start + buffer.duration };
  }

  private stepRace(): void {
    if (!this.context || !this.raceGraph || !this.raceCurrent || !Number.isFinite(this.raceCurrent.end)) return;
    const now = this.context.currentTime;
    if (this.raceQueued && now >= this.raceQueued.start) {
      this.stopVoices([this.raceCurrent]);
      this.raceCurrent = this.raceQueued;
      this.raceQueued = null;
    }
    if (!this.raceQueued && !this.raceQueuePending
      && now + RACE_SCHEDULE_AHEAD_SECONDS >= this.raceCurrent.end) this.queueRaceNext();
  }

  private queueRaceNext(): void {
    const graph = this.raceGraph;
    const current = this.raceCurrent;
    if (!graph || !current || current.node === undefined || !this.context) return;
    let next = -1;
    if (this.pendingEvent >= 0) {
      next = resolveMusicEvent(graph, this.pendingEvent, current.node, this.intensity);
      this.pendingEvent = -1;
    }
    if (next < 0) next = resolveMusicSampleNode(graph, pickLink(graph, current.node, this.intensity), this.intensity);
    if (next < 0) next = current.node;
    const generation = this.generation;
    const expectedCurrent = current;
    const sample = graph.Nodes[next].Sample;
    this.raceQueuePending = true;
    void sharedAudioBuffer(referenceRaceMusicUrl(this.raceLevel, this.raceSong, sample)).then(buffer => {
      if (generation !== this.generation || expectedCurrent !== this.raceCurrent || !this.context) return;
      this.raceQueuePending = false;
      if (!buffer) return;
      const start = Math.max(expectedCurrent.end, this.context.currentTime + 0.01);
      this.raceQueued = this.startRaceVoice(buffer, next, start);
    });
  }

  private stepIntensity(dt: number, frame: RideMusicFrame): void {
    let target = frame.mounted ? 55 + Math.min(1, Math.max(0, frame.speed / MAX_SPEED)) * 30 : 0;
    if (frame.boosting) target += 25;
    if (!frame.grounded && frame.airTime > 0.4) target += 12;
    target = Math.min(127, target);
    const tau = target > this.intensity ? 1.2 : 4;
    this.intensity += (target - this.intensity) * Math.min(1, Math.max(0, dt) / tau);
    this.intensity = Math.min(127, Math.max(0, this.intensity));
  }

  private stopRace(): void {
    this.stopVoices([this.raceCurrent, this.raceQueued]);
    this.raceCurrent = this.raceQueued = null;
    this.raceQueuePending = false;
    this.pendingEvent = -1;
    this.boostWasHeld = false;
  }

  private stopVoices(voices: Array<Voice | null>): void {
    for (const voice of voices) {
      if (!voice) continue;
      try { voice.source.stop(); } catch { /* a naturally ended or not-yet-started source */ }
      voice.source.disconnect();
      voice.gain.disconnect();
    }
  }
}
