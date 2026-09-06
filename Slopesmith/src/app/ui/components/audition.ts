import { resolveCollisionSound } from '../../../core/effects/collision-sound';
import { resolveExternalSound } from '../../../core/effects/external-sound';
import { customMusicUrl, customSoundUrl } from '../../net/asset-paths';
import { environmentSoundUrl } from '../../net/asset-paths';

/** One shared audition owner so restarting a preview never stacks sounds. Ordinary previews use an audio
 * element; a reference-music walk uses one Web Audio clock for gapless chunk scheduling. Collision-sound
 * event ids resolve through the global table to a course/crowd bank slot [Trailmap: 420-audio-runtime]. */
let auditionElement: HTMLAudioElement | null = null;
let auditionGeneration = 0;
let auditionContext: AudioContext | null = null;
let auditionSources: AudioBufferSourceNode[] = [];
const closeContext = (context: AudioContext): void => { void context.close().catch(() => {}); };

// Board-loop previews are ordinary audio-element auditions, but their panel uses one play/stop control. Keep
// only that small piece of identity here, beside the audio owner, so another preview stealing the shared
// element and a clip ending naturally both put the button back into its play state.
let boardAuditionKey: string | null = null;
const boardAuditionListeners = new Set<() => void>();
const boardKey = (slot: number, bank: string): string => `${bank.toLowerCase()}:${Math.trunc(slot)}`;

function setBoardAuditionKey(next: string | null): void {
  if (boardAuditionKey === next) return;
  boardAuditionKey = next;
  for (const listener of [...boardAuditionListeners]) listener();
}

/** Whether this exact board-bank slot owns the shared audition element. */
export const boardSoundAuditionPlaying = (slot: number, bank = 'zboard'): boolean =>
  boardAuditionKey === boardKey(slot, bank);

/** Whether any board surface preview is active. */
export const boardSoundAuditionActive = (): boolean => boardAuditionKey !== null;

/** Subscribe to a board surface preview starting, stopping, ending, failing, or being replaced. */
export function onBoardSoundAuditionChange(listener: () => void): () => void {
  boardAuditionListeners.add(listener);
  return () => { boardAuditionListeners.delete(listener); };
}

/**
 * A CONTINUING sound auditions as a real loop, because the thing worth hearing about one is how it carries —
 * whether the seam is clean and what it sounds like held. A loop has no natural end, so unlike the one-shot
 * previews it needs a stop, and the panel offering that stop needs to know which button is the live one.
 * `loopKey` is that identity: whatever the caller used to name this particular emitter.
 */
let loopKey: string | null = null;
const loopListeners = new Set<() => void>();

/** The continuing audition currently playing, or null. */
export const loopAuditionKey = (): string | null => loopKey;

/** Subscribe to the continuing audition starting or stopping; returns an unsubscribe. */
export function onLoopAuditionChange(listener: () => void): () => void {
  loopListeners.add(listener);
  return () => { loopListeners.delete(listener); };
}

function setLoopKey(next: string | null): void {
  if (loopKey === next) return;
  loopKey = next;
  for (const listener of [...loopListeners]) listener();
}

function startElementAudition(url: string, volume: number, boardKeyForPreview: string | null = null): void {
  stopAudition();
  const element = new Audio(url);
  auditionElement = element;
  element.volume = volume;
  const generation = auditionGeneration;
  setBoardAuditionKey(boardKeyForPreview);
  const finished = () => {
    if (generation !== auditionGeneration || auditionElement !== element) return;
    auditionElement = null;
    setBoardAuditionKey(null);
  };
  element.addEventListener('ended', finished, { once: true });
  element.addEventListener('error', finished, { once: true });
  void element.play().catch(finished);
}

/**
 * A held loop runs on WEB AUDIO rather than on an audio element.
 *
 * `HTMLAudioElement.loop` re-buffers at the seam, which is audible as a short break every pass — precisely
 * the artefact the BNKl loop region exists to avoid, so the one thing this preview is for is the one thing
 * that path cannot show. `AudioBufferSourceNode.loop` is sample-accurate over a decoded buffer, and it is
 * what the placed ambient bed already uses, so the preview and the bed now sound identical.
 *
 * The key is set before the fetch so the button flips immediately; a failed load clears it again.
 */
function startBufferLoopAudition(key: string, url: string, volume: number): void {
  stopAudition();
  setLoopKey(key);
  const generation = auditionGeneration;
  void (async () => {
    try {
      const context = new AudioContext();
      auditionContext = context;
      await context.resume();
      const response = await fetch(url);
      if (!response.ok) throw new Error(response.statusText || `sound ${response.status}`);
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      // Stopped, or superseded by another audition, while this was decoding.
      if (generation !== auditionGeneration || auditionContext !== context) { closeContext(context); return; }
      const gain = context.createGain();
      gain.gain.value = volume;
      gain.connect(context.destination);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(gain);
      source.start();
      auditionSources = [source];
    } catch {
      // Only tear down if this attempt is still the current one; otherwise its successor owns the state.
      if (generation === auditionGeneration) stopAudition();
    }
  })();
}

/** Audition a MainType-8 PlaySound node's direct course-bank slot. */
export const auditionEffectSound = (level: string, slot: number): boolean => {
  const sourceSlot = Math.trunc(slot);
  if (!level.trim() || !Number.isFinite(slot) || sourceSlot < 0 || sourceSlot > 999) return false;
  startElementAudition(`/api/effect-sound?level=${encodeURIComponent(level)}&slot=${sourceSlot}`, 0.9);
  return true;
};

/** Audition any extracted bank slot by its folder name — the Sound Library's browse action. `course` keeps
 *  the level's own group-2 bank; every other name resolves the folder case-insensitively. */
export const auditionBankSlot = (level: string, bank: string, slot: number): boolean => {
  const sourceSlot = Math.trunc(slot);
  if (!level.trim() || !Number.isFinite(slot) || sourceSlot < 0 || sourceSlot > 999) return false;
  startElementAudition(`/api/effect-sound?level=${encodeURIComponent(level)}&slot=${sourceSlot}`
    + (bank && bank !== 'course' ? `&bank=${encodeURIComponent(bank)}` : ''), 0.9);
  return true;
};

export const auditionCollisionSound = (level: string, eventId: number): boolean => {
  const resolved = resolveCollisionSound(eventId, level);
  if (!resolved) return false;
  startElementAudition(`/api/effect-sound?level=${encodeURIComponent(level)}&slot=${resolved.slot}`
    + (resolved.bank === 'crowd' ? '&bank=crowd' : ''), 0.9);
  return true;
};

/** Audition a looping ExternalSounds event once. Fixed environmental events use their named global bank;
 * ordinary course/crowd events retain the collision resolver's bank and slot. */
export const auditionExternalSound = (level: string, eventId: number): boolean => {
  const resolved = resolveExternalSound(eventId, level);
  if (!resolved || !level.trim()) return false;
  const bank = resolved.kind === 'fixed' ? resolved.bank : resolved.kind;
  startElementAudition(`/api/effect-sound?level=${encodeURIComponent(level)}&slot=${resolved.slot}`
    + (bank === 'course' ? '' : `&bank=${encodeURIComponent(bank)}`), 0.9);
  return true;
};

/**
 * Audition a continuing ExternalSounds event as it actually runs: the slot's BNKl loop REGION, looped, so
 * what is heard here is what the placed bed plays rather than the clip's one pass with its tail. Runs until
 * stopped — `key` names this emitter so the panel can show its stop.
 */
export const auditionExternalSoundLoop = (key: string, level: string, eventId: number): boolean => {
  const resolved = resolveExternalSound(eventId, level);
  if (!resolved || !level.trim()) return false;
  const bank = resolved.kind === 'fixed' ? resolved.bank : resolved.kind;
  startBufferLoopAudition(key, `/api/effect-sound?level=${encodeURIComponent(level)}&slot=${resolved.slot}`
    + (bank === 'course' ? '' : `&bank=${encodeURIComponent(bank)}`) + '&loop=1', 0.9);
  return true;
};

/** The same continuing audition for an uploaded WAV, which carries no loop region of its own to ask for. */
export const auditionCustomSoundLoop = (key: string, name: string): void => {
  startBufferLoopAudition(key, customSoundUrl(name), 0.9);
};

/** Preview the Maps environment-bed contract. A reference names its own extracted copy; an authored mountain
 * reads the identical bank from any installed extraction, exactly as Test and export do. */
export function auditionEnvironmentBed(key: string, bank: string, slot: number, volume: number,
  level?: string): boolean {
  const sourceSlot = Math.trunc(slot);
  if (!bank.trim() || !Number.isInteger(slot) || sourceSlot < 0 || sourceSlot > 999) return false;
  const url = level?.trim()
    ? `/api/effect-sound?level=${encodeURIComponent(level)}&slot=${sourceSlot}`
      + `&bank=${encodeURIComponent(bank)}&loop=1`
    : environmentSoundUrl(bank, sourceSlot, true);
  startBufferLoopAudition(key, url, Math.min(1, Math.max(0, volume)));
  return true;
}

/** Short external-event destination readout, including named global environment banks. */
export const externalSoundMeta = (eventId: number, level?: string): string => {
  if (eventId < 0) return 'none';
  const resolved = resolveExternalSound(eventId, level);
  if (!resolved) return 'unresolved';
  return resolved.kind === 'fixed' ? `${resolved.bank} 000`
    : `${resolved.kind} ${String(resolved.slot).padStart(3, '0')}`;
};

/** Short "where it lands" readout: bank + zero-padded slot, `silent` for unmapped ids, `none` without a record. */
export const collisionSoundMeta = (eventId: number, level?: string): string => {
  if (eventId < 0) return 'none';
  const resolved = resolveCollisionSound(eventId, level);
  return resolved ? `${resolved.bank} ${String(resolved.slot).padStart(3, '0')}` : 'silent';
};

/** Audition one shared board-bank slot — a family's glide or carve loop, played once so the Sound panel can
 * hear what a surface rides like [Trailmap: 420-audio-runtime]. False when the slot number is unusable; a
 * bank that was never extracted simply fails to load and stays silent. */
export const auditionBoardSound = (slot: number, bank = 'zboard'): boolean => {
  const sourceSlot = Math.trunc(slot);
  if (!Number.isFinite(slot) || sourceSlot < 0 || sourceSlot > 999) return false;
  startElementAudition(`/api/board-sound?bank=${encodeURIComponent(bank)}&slot=${sourceSlot}&loop=1`, 0.9,
    boardKey(sourceSlot, bank));
  return true;
};

/** Audition an uploaded mountain-local hit sound, sharing the one audition element. */
export const auditionCustomSound = (name: string): void => {
  startElementAudition(customSoundUrl(name), 0.9);
};

/** Preview a full-length source from the mountain-local music library. The export path separately normalizes this source
 * to the PCM16 WAV contract consumed by Snowknife; the browser can audition its original format directly. */
export const auditionCustomMusic = (name: string): void => {
  startElementAudition(customMusicUrl(name), 0.8);
};

/** Preview one native intro stem from Scene ▸ Sound. Test mode sequences the whole selected tier; the panel
 * keeps the preview intentionally finite so it never disguises a single bar as a separately authored song. */
export const auditionReferenceIntroMusic = (level: string, stem: string): void => {
  startElementAudition(`/api/reference-intro-music?level=${encodeURIComponent(level)}`
    + `&stem=${encodeURIComponent(stem)}`, 0.8);
};

export interface ReferenceMusicAuditionStep {
  node: number;
  sample: number;
}

export interface ReferenceMusicAuditionHooks {
  onReady?: (seconds: number) => void;
  onStep?: (step: ReferenceMusicAuditionStep, index: number) => void;
  onEnded?: () => void;
  onError?: (error: Error) => void;
}

/** Fetch and schedule extracted PathFinder chunks on one Web Audio clock. Scheduling the whole deterministic
 * walk up front avoids an HTMLAudio hand-off gap between the retail graph's ~1.7-second WAV files. */
export async function auditionReferenceMusicWalk(level: string, song: string,
  steps: ReferenceMusicAuditionStep[], hooks: ReferenceMusicAuditionHooks = {}): Promise<boolean> {
  if (!level.trim() || !song.trim() || !steps.length) return false;
  stopAudition();
  const generation = auditionGeneration;
  try {
    const context = new AudioContext();
    auditionContext = context;
    await context.resume();
    const buffers = await Promise.all(steps.map(async step => {
      const response = await fetch(`/api/reference-music-sample?level=${encodeURIComponent(level)}`
        + `&song=${encodeURIComponent(song)}&sample=${step.sample}`);
      if (!response.ok) throw new Error(`sample ${step.sample}: ${await response.text() || response.statusText}`);
      return context.decodeAudioData(await response.arrayBuffer());
    }));
    if (generation !== auditionGeneration || auditionContext !== context) { closeContext(context); return false; }
    const gain = context.createGain(); gain.gain.value = 0.8; gain.connect(context.destination);
    const total = buffers.reduce((sum, buffer) => sum + buffer.duration, 0);
    hooks.onReady?.(total);
    let when = context.currentTime + 0.05;
    auditionSources = buffers.map((buffer, index) => {
      const source = context.createBufferSource(); source.buffer = buffer; source.connect(gain);
      source.onended = () => {
        if (generation !== auditionGeneration) return;
        if (index + 1 < steps.length) hooks.onStep?.(steps[index + 1], index + 1);
        else {
          auditionSources = [];
          auditionContext = null;
          closeContext(context);
          hooks.onEnded?.();
        }
      };
      source.start(when); when += buffer.duration;
      return source;
    });
    hooks.onStep?.(steps[0], 0);
    return true;
  } catch (error) {
    if (generation === auditionGeneration) {
      const failure = error instanceof Error ? error : new Error(String(error));
      stopAudition();
      hooks.onError?.(failure);
    }
    return false;
  }
}

export const stopAudition = (): void => {
  auditionGeneration++;
  auditionElement?.pause();
  auditionElement = null;
  setBoardAuditionKey(null);
  // Any other preview starting also ends the loop, so the stop button never outlives the sound it stops.
  setLoopKey(null);
  for (const source of auditionSources) { try { source.stop(); } catch { /* already stopped */ } }
  auditionSources = [];
  if (auditionContext) closeContext(auditionContext);
  auditionContext = null;
};
