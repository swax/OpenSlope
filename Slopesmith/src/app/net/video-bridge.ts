import type { VideoBridgePrefs } from './video-bridge-contract';

/**
 * The self-hosted media server these bindings were written and tested against: Yattee Server, a yt-dlp-based
 * media server maintained by the same author as OpenSlope. It is separate software under its own terms,
 * neither built, bundled, nor run by Slopesmith; any server answering the same Invidious-compatible video
 * API and relaying its own bytes will do.
 */
export const VIDEO_BRIDGE_REPOSITORY_URL = 'https://github.com/swax/yattee-server';
export const DEFAULT_VIDEO_BRIDGE_SERVER = 'http://127.0.0.1:8085';

export type YatteeStream = {
  url?: string;
  type?: string;
  height?: number | null;
  quality?: string;
  bitrate?: string | number | null;
  audioTrack?: { isDefault?: boolean } | null;
};

export type YatteeVideo = {
  title?: string;
  formatStreams?: YatteeStream[];
  adaptiveFormats?: YatteeStream[];
};

export type YatteeAdaptivePair = {
  video: YatteeStream & { url: string; type: string };
  audio: YatteeStream & { url: string; type: string };
};

export type VideoBridgeTestResult = {
  serverUrl: string;
  name: string;
  version: string | null;
};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class VideoBridgeError extends Error {
  constructor(message: string, readonly code: 'configuration' | 'network' | 'authentication' | 'response') {
    super(message);
    this.name = 'VideoBridgeError';
  }
}

export type VideoBridgeFallback = {
  /** No complete browser-local Yattee account is saved, or a configured bridge failed at runtime. */
  kind: 'not-configured' | 'failed';
  /** The original actionable error remains available behind the Jukebox info button. */
  detail: string;
  serverUrl: string;
};

/** Preserve why playback crossed the provider boundary instead of flattening every failure into "YouTube fallback". */
export function describeVideoBridgeFallback(prefs: VideoBridgePrefs, error: unknown): VideoBridgeFallback {
  const hasCompleteAccount = prefs.username.trim().length > 0 && prefs.password.length > 0;
  return {
    kind: hasCompleteAccount ? 'failed' : 'not-configured',
    detail: error instanceof Error ? error.message : String(error),
    serverUrl: prefs.serverUrl.trim() || DEFAULT_VIDEO_BRIDGE_SERVER,
  };
}

const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** Turn the URL pasted into the jukebox into the identifier Yattee's video-info route accepts. */
export function youtubeVideoId(value: string): string {
  const candidate = value.trim();
  if (YOUTUBE_VIDEO_ID.test(candidate)) return candidate;

  let url: URL;
  try { url = new URL(candidate); }
  catch { throw new VideoBridgeError('Enter a YouTube video URL.', 'configuration'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new VideoBridgeError('The video URL must use http:// or https://.', 'configuration');
  }

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  let videoId = '';
  if (host === 'youtu.be') {
    videoId = url.pathname.split('/').filter(Boolean)[0] ?? '';
  } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    if (url.pathname === '/watch') videoId = url.searchParams.get('v') ?? '';
    else {
      const segments = url.pathname.split('/').filter(Boolean);
      if (['shorts', 'embed', 'live', 'v'].includes(segments[0] ?? '')) videoId = segments[1] ?? '';
    }
  } else {
    throw new VideoBridgeError('Enter a youtube.com or youtu.be video URL.', 'configuration');
  }

  if (!YOUTUBE_VIDEO_ID.test(videoId)) {
    throw new VideoBridgeError('That URL does not contain a valid YouTube video ID.', 'configuration');
  }
  return videoId;
}

/** Yattee is mounted at an origin, not under a path. Canonicalising here also makes CORS entries predictable. */
export function normalizeVideoBridgeServer(value: string): string {
  const candidate = value.trim() || DEFAULT_VIDEO_BRIDGE_SERVER;
  let parsed: URL;
  try { parsed = new URL(candidate); }
  catch { throw new VideoBridgeError('Enter a complete Yattee URL such as http://127.0.0.1:8085.', 'configuration'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new VideoBridgeError('The Yattee URL must use http:// or https://.', 'configuration');
  }
  if (parsed.username || parsed.password || (parsed.pathname !== '/' && parsed.pathname !== '')
    || parsed.search || parsed.hash) {
    throw new VideoBridgeError('Enter only the Yattee origin, without credentials, a path, query, or fragment.', 'configuration');
  }
  return parsed.origin;
}

/** Basic authentication supports non-ASCII credentials rather than relying on btoa's Latin-1 input rule. */
export function videoBridgeAuthorization(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function requestHeaders(prefs: VideoBridgePrefs): Record<string, string> | undefined {
  return prefs.username || prefs.password
    ? { Authorization: videoBridgeAuthorization(prefs.username, prefs.password) }
    : undefined;
}

function timeout(milliseconds: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), milliseconds);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

async function bridgeFetch(fetcher: FetchLike, url: URL, prefs: VideoBridgePrefs, milliseconds: number): Promise<Response> {
  const deadline = timeout(milliseconds);
  try {
    return await fetcher(url, { headers: requestHeaders(prefs), cache: 'no-store', signal: deadline.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new VideoBridgeError(`Yattee did not answer within ${Math.round(milliseconds / 1000)} seconds.`, 'network');
    }
    throw new VideoBridgeError(
      'Could not reach Yattee. Start the local server, allow this Slopesmith origin in Yattee Browser Access, '
        + 'and approve the browser local-network prompt.',
      'network',
    );
  } finally {
    deadline.cancel();
  }
}

async function responseDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text ? `: ${text.slice(0, 160)}` : '';
  } catch { return ''; }
}

/** A cheap authenticated probe. Full `/info` proves credentials; its minimal anonymous reply does not. */
export async function testVideoBridge(
  prefs: VideoBridgePrefs,
  fetcher: FetchLike = fetch,
): Promise<VideoBridgeTestResult> {
  const serverUrl = normalizeVideoBridgeServer(prefs.serverUrl);
  const response = await bridgeFetch(fetcher, new URL('/info', serverUrl), prefs, 15_000);
  if (response.status === 401) {
    throw new VideoBridgeError('Yattee rejected that username or password.', 'authentication');
  }
  if (!response.ok) {
    throw new VideoBridgeError(`Yattee returned HTTP ${response.status}${await responseDetail(response)}`, 'response');
  }

  let info: { name?: unknown; version?: unknown };
  try { info = await response.json() as { name?: unknown; version?: unknown }; }
  catch { throw new VideoBridgeError('That address answered, but it did not return Yattee server information.', 'response'); }
  if (info.name === 'yattee-server' && typeof info.version !== 'string') {
    throw new VideoBridgeError('Yattee is reachable, but it requires a username and password.', 'authentication');
  }
  if (info.name !== 'Yattee Server') {
    throw new VideoBridgeError('That address answered, but it does not appear to be Yattee Server.', 'response');
  }
  return {
    serverUrl,
    name: info.name,
    version: typeof info.version === 'string' ? info.version : null,
  };
}

export function yatteeVideoUrl(serverUrl: string, videoId: string): URL {
  const url = new URL(`/api/v1/videos/${encodeURIComponent(videoId)}`, normalizeVideoBridgeServer(serverUrl));
  url.search = new URLSearchParams({ proxy: 'true', proxy_mode: 'relay', invidious: 'false' }).toString();
  return url;
}

/** Resolve a public video into signed relay streams without exposing the upstream CDN directly to the browser. */
export async function resolveYatteeVideo(
  prefs: VideoBridgePrefs,
  videoId: string,
  fetcher: FetchLike = fetch,
): Promise<YatteeVideo> {
  const response = await bridgeFetch(fetcher, yatteeVideoUrl(prefs.serverUrl, videoId), prefs, 60_000);
  if (response.status === 401) {
    throw new VideoBridgeError('Yattee rejected the saved username or password. Update Settings → Integrations.', 'authentication');
  }
  if (!response.ok) {
    throw new VideoBridgeError(`Yattee returned HTTP ${response.status}${await responseDetail(response)}`, 'response');
  }
  try { return await response.json() as YatteeVideo; }
  catch { throw new VideoBridgeError('Yattee returned an invalid video response.', 'response'); }
}

/** Prefer a muxed stream the browser can decode, with 720p as the proof surface's useful ceiling. */
export function playableYatteeStream(
  streams: readonly YatteeStream[],
  canPlayType: (type: string) => string,
): YatteeStream | null {
  const playable = streams
    .filter((stream): stream is YatteeStream & { url: string; type: string } =>
      !!stream.url && !!stream.type && canPlayType(stream.type) !== '')
    .sort((a, b) => {
      const score = (height: number | null | undefined) => {
        const pixels = height ?? 0;
        return pixels <= 720 ? pixels : 720 - (pixels - 720);
      };
      return score(b.height) - score(a.height);
    });
  return playable[0] ?? null;
}

/** Pick separate browser-decodable video and audio tracks when YouTube advertises a dead muxed format. */
export function playableYatteeAdaptivePair(
  streams: readonly YatteeStream[],
  canPlayVideo: (type: string) => string,
  canPlayAudio: (type: string) => string,
): YatteeAdaptivePair | null {
  const videoCodecScore = (type: string) => {
    const normalized = type.toLowerCase();
    if (normalized.includes('avc1') || normalized.includes('avc3')) return 3;
    if (normalized.includes('vp09') || normalized.includes('vp9')) return 2;
    if (normalized.includes('av01')) return 1;
    return 0;
  };
  const audioCodecScore = (type: string) => {
    const normalized = type.toLowerCase();
    if (normalized.includes('mp4a')) return 2;
    if (normalized.includes('opus')) return 1;
    return 0;
  };
  const videos = streams
    .filter((stream): stream is YatteeStream & { url: string; type: string } =>
      !!stream.url && !!stream.type && stream.type.startsWith('video/') && canPlayVideo(stream.type) !== '')
    .sort((a, b) => {
      const codecDifference = videoCodecScore(b.type) - videoCodecScore(a.type);
      if (codecDifference) return codecDifference;
      const score = (height: number | null | undefined) => {
        const pixels = height ?? 0;
        return pixels <= 720 ? pixels : 720 - (pixels - 720);
      };
      return score(b.height) - score(a.height);
    });
  const audios = streams
    .filter((stream): stream is YatteeStream & { url: string; type: string } =>
      !!stream.url && !!stream.type && stream.type.startsWith('audio/') && canPlayAudio(stream.type) !== '')
    .sort((a, b) => {
      const defaultDifference = Number(b.audioTrack?.isDefault === true) - Number(a.audioTrack?.isDefault === true);
      if (defaultDifference) return defaultDifference;
      const codecDifference = audioCodecScore(b.type) - audioCodecScore(a.type);
      if (codecDifference) return codecDifference;
      return Number(b.bitrate ?? 0) - Number(a.bitrate ?? 0);
    });
  return videos[0] && audios[0] ? { video: videos[0], audio: audios[0] } : null;
}
