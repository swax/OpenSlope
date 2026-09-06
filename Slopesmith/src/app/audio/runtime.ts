import { AudioContext as ThreeAudioContext } from 'three';

/**
 * One browser audio device for the whole editor.
 *
 * Creating a context at ride start made the first board sounds pay device start-up, while Three's positional
 * effects used a different context and cache. Keep one interactive-latency context alive for the page instead:
 * decoded buffers remain valid between Test runs, and every gameplay event can start an already-warm source.
 */

type BrowserAudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

let context: AudioContext | null = null;
let gameMaster: GainNode | null = null;
let gameVolume = 1;
const buffers = new Map<string, Promise<AudioBuffer | null>>();

/** Stored Test preference → safe Web Audio gain. Missing/invalid values keep the game audible. */
export function normalizeGameAudioVolume(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 1;
}

function audioContextConstructor(): BrowserAudioContextConstructor {
  const host = globalThis as typeof globalThis & { webkitAudioContext?: BrowserAudioContextConstructor };
  const ctor = host.AudioContext ?? host.webkitAudioContext;
  if (!ctor) throw new Error('Web Audio is unavailable in this browser');
  return ctor;
}

/** The shared context, also installed as Three.js's context before any AudioListener is constructed. */
export function sharedAudioContext(): AudioContext {
  if (!context || context.state === 'closed') {
    const Ctor = audioContextConstructor();
    try { context = new Ctor({ latencyHint: 'interactive' }); }
    catch { context = new Ctor(); } // older Safari accepts no options object
    gameMaster = context.createGain();
    gameMaster.gain.value = gameVolume;
    gameMaster.connect(context.destination);
    buffers.clear(); // AudioBuffers belong to the context that decoded them
    ThreeAudioContext.setContext(context);
  }
  return context;
}

/** Destination for gameplay audio. Authoring previews use their own context/element and deliberately bypass it. */
export function gameAudioDestination(): GainNode {
  sharedAudioContext();
  return gameMaster!;
}

/** Live Test master: zero mutes the complete gameplay graph without stopping or resetting any voices. */
export function setGameAudioVolume(value: number): void {
  gameVolume = normalizeGameAudioVolume(value);
  if (gameMaster && context && context.state !== 'closed')
    gameMaster.gain.setValueAtTime(gameVolume, context.currentTime);
}

/** Call synchronously from the Play gesture. Do not await it before another gesture-gated API such as WebXR. */
export function resumeSharedAudio(): void {
  const audio = sharedAudioContext();
  if (audio.state !== 'running' && audio.state !== 'closed') void audio.resume().catch(() => {});
}

/** Fetch and decode once per page, shared by board audio, positional effects, prop hits, and ambience. */
export function sharedAudioBuffer(url: string): Promise<AudioBuffer | null> {
  let pending = buffers.get(url);
  if (!pending) {
    const audio = sharedAudioContext();
    pending = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return await audio.decodeAudioData(await response.arrayBuffer());
      } catch { return null; }
    })();
    buffers.set(url, pending);
  }
  return pending;
}

/** Begin warming unique URLs without putting network or decode work on the eventual event frame. */
export function preloadAudio(urls: Iterable<string>): void {
  for (const url of new Set(urls)) if (url) void sharedAudioBuffer(url);
}
