/** The official YouTube player script. It is loaded only after this browser turns Jukebox playback on. */
export const YOUTUBE_IFRAME_API_URL = 'https://www.youtube.com/iframe_api';

export interface YouTubePlayer {
  loadVideoById(options: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  setVolume(volume: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getVideoData(): { title?: string };
}

export interface YouTubePlayerEvent<T = unknown> {
  target: YouTubePlayer;
  data: T;
}

export interface YouTubePlayerOptions {
  width: string | number;
  height: string | number;
  videoId?: string;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (event: YouTubePlayerEvent) => void;
    onStateChange?: (event: YouTubePlayerEvent<number>) => void;
    onError?: (event: YouTubePlayerEvent<number>) => void;
    onAutoplayBlocked?: (event: YouTubePlayerEvent) => void;
  };
}

export interface YouTubeIframeApi {
  Player: new (host: HTMLElement | string, options: YouTubePlayerOptions) => YouTubePlayer;
  PlayerState: {
    ENDED: number;
    PLAYING: number;
    PAUSED: number;
    BUFFERING: number;
    CUED: number;
  };
}

declare global {
  interface Window {
    YT?: YouTubeIframeApi;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiPromise: Promise<YouTubeIframeApi> | null = null;

/** Load the official API once without taking ownership of another feature's global ready callback. */
export function loadYouTubeIframeApi(): Promise<YouTubeIframeApi> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('The YouTube embedded player requires a browser.'));
  }
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise<YouTubeIframeApi>((resolve, reject) => {
    const previousReady = window.onYouTubeIframeAPIReady;
    let inserted: HTMLScriptElement | null = null;
    let settled = false;
    const timer = window.setTimeout(() => fail('YouTube did not load its embedded player within 15 seconds.'), 15_000);

    const restore = () => {
      window.clearTimeout(timer);
      if (window.onYouTubeIframeAPIReady === ready) window.onYouTubeIframeAPIReady = previousReady;
    };
    const succeed = () => {
      if (settled) return;
      const api = window.YT;
      if (!api?.Player) { fail('YouTube loaded without its embedded player API.'); return; }
      settled = true;
      restore();
      resolve(api);
    };
    function fail(message: string) {
      if (settled) return;
      settled = true;
      restore();
      inserted?.remove();
      reject(new Error(message));
    }
    const ready = () => {
      try { previousReady?.(); } catch { /* another callback must not strand Jukebox startup */ }
      succeed();
    };
    window.onYouTubeIframeAPIReady = ready;

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${YOUTUBE_IFRAME_API_URL}"]`);
    if (existing) {
      existing.addEventListener('error', () => fail('Could not load YouTube’s embedded player.'), { once: true });
      return;
    }
    inserted = document.createElement('script');
    inserted.src = YOUTUBE_IFRAME_API_URL;
    inserted.async = true;
    inserted.addEventListener('error', () => fail('Could not load YouTube’s embedded player.'), { once: true });
    document.head.appendChild(inserted);
  }).catch(error => {
    apiPromise = null;
    throw error;
  });
  return apiPromise;
}

/** Turn the iframe API's numeric failures into something useful in the Jukebox status card. */
export function youtubePlayerErrorMessage(code: number): string {
  if (code === 2) return 'YouTube rejected that video ID.';
  if (code === 5) return 'YouTube could not play this video in the browser.';
  if (code === 100) return 'That YouTube video is unavailable, private, or has been removed.';
  if (code === 101 || code === 150) return 'The owner does not allow this YouTube video to be embedded.';
  if (code === 153) return 'YouTube could not identify this Slopesmith page as the embedded player client.';
  return `YouTube playback failed (error ${code}).`;
}
