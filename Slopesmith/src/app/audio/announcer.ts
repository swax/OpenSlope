import {
  ANNOUNCER_EVENT_IDS, AnnouncerRideEvents, normalizeAnnouncer,
  type AnnouncerEvent, type AnnouncerIndex, type AnnouncerRideFrame, type AnnouncerSettings,
} from '../../core/audio/announcer';
import { fetchJson } from '../net/fetch-json';
import { customSoundUrl } from '../net/asset-paths';
import { gameAudioDestination, preloadAudio, sharedAudioBuffer, sharedAudioContext } from './runtime';

export const announcerSoundUrl = (event: AnnouncerEvent, file: string): string =>
  `/api/announcer-sound?event=${encodeURIComponent(event)}&file=${encodeURIComponent(file)}`;

let indexPromise: Promise<AnnouncerIndex> | null = null;
export function announcerIndex(refresh = false): Promise<AnnouncerIndex> {
  if (refresh) indexPromise = null;
  return indexPromise ??= fetchJson<AnnouncerIndex>('/api/announcer-audio').catch(() => {
    indexPromise = null;
    return Object.fromEntries(ANNOUNCER_EVENT_IDS.map(id => [id, [] as string[]])) as AnnouncerIndex;
  });
}

export function announcerClipUrls(index: AnnouncerIndex, settings: AnnouncerSettings, event: AnnouncerEvent): string[] {
  const file = settings.events[event].file;
  return file ? [customSoundUrl(file)] : (index[event] ?? []).map(clip => announcerSoundUrl(event, clip));
}

/** One local, non-spatial voice, connected to Game volume. Late fetches cannot outlive a mute/exit. */
export class RideAnnouncerRuntime {
  private settings = normalizeAnnouncer(undefined);
  private active = false;
  private generation = 0;
  private pending = false;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  private coolUntil = 0;
  private last = new Map<AnnouncerEvent, string>();
  private events = new AnnouncerRideEvents();

  configure(settings: AnnouncerSettings, active: boolean): void {
    this.settings = settings;
    if (!active && this.active) this.stop();
    this.active = active;
    if (this.gain) this.gain.gain.value = settings.volume;
  }

  preload(): void {
    // Warm a small opening set; hundreds of landing variants are decoded only when selected.
    void announcerIndex().then(index => {
      preloadAudio(ANNOUNCER_EVENT_IDS.flatMap(id => announcerClipUrls(index, this.settings, id).slice(0, 2)));
    });
  }

  reset(): void { this.stop(); this.coolUntil = 0; }

  stop(): void {
    ++this.generation;
    this.pending = false;
    this.active = false;
    this.stopVoice();
    this.events.reset();
  }

  step(dt: number, frame: AnnouncerRideFrame): void {
    if (!this.active) return;
    for (const event of this.events.step(dt, frame)) this.fire(event);
  }

  fire(event: AnnouncerEvent): void {
    if (event === 'knockdown' || event === 'go') this.events.reset();
    if (!this.active || Math.random() >= this.settings.events[event].chance) return;
    const audio = sharedAudioContext();
    const interrupt = event === 'go' || event === 'knockdown';
    if (!interrupt && (this.pending || this.source || audio.currentTime < this.coolUntil)) return;
    // Claim before loading so simultaneous events cannot race into overlapping lines.
    this.stopVoice();
    const generation = ++this.generation;
    this.pending = true;
    void this.play(event, generation);
  }

  private stopVoice(): void {
    if (this.source) { this.source.onended = null; this.source.stop(); this.source.disconnect(); this.source = null; }
    this.gain?.disconnect(); this.gain = null;
  }

  private async play(event: AnnouncerEvent, generation: number): Promise<void> {
    try {
      const urls = announcerClipUrls(await announcerIndex(), this.settings, event);
      if (generation !== this.generation || !this.active) return;
      const choices = urls.length > 1 ? urls.filter(url => url !== this.last.get(event)) : urls;
      const url = choices[Math.floor(Math.random() * choices.length)];
      if (!url) return;
      const buffer = await sharedAudioBuffer(url);
      if (!buffer || generation !== this.generation || !this.active) return;
      const audio = sharedAudioContext();
      const gain = audio.createGain();
      gain.gain.value = this.settings.volume;
      gain.connect(gameAudioDestination());
      const source = audio.createBufferSource();
      source.buffer = buffer; source.connect(gain);
      this.source = source; this.gain = gain;
      source.onended = () => {
        source.disconnect(); gain.disconnect();
        if (this.source === source) { this.source = null; this.gain = null; }
      };
      source.start();
      this.last.set(event, url);
      this.coolUntil = audio.currentTime + buffer.duration + this.settings.cooldownSeconds * (event === 'go' ? 1.1 : 1);
    } finally {
      if (generation === this.generation) this.pending = false;
    }
  }
}
