// tier: fast

import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  DEFAULT_VIDEO_BRIDGE_SERVER, describeVideoBridgeFallback, normalizeVideoBridgeServer,
  playableYatteeAdaptivePair, playableYatteeStream, resolveYatteeVideo, testVideoBridge,
  videoBridgeAuthorization, VideoBridgeError, yatteeVideoUrl, youtubeVideoId,
} from '../src/app/net/video-bridge';
import {
  loadYouTubeIframeApi, YOUTUBE_IFRAME_API_URL, youtubePlayerErrorMessage,
  type YouTubeIframeApi,
} from '../src/app/net/youtube-iframe';
import { loadSettings, saveSettings, SETTINGS_KEY } from '../src/app/state/settings';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

const storage = new MemoryStorage();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

const expectBridgeError = async (work: Promise<unknown>, code: VideoBridgeError['code'], text: string) => {
  await assert.rejects(work, error => error instanceof VideoBridgeError
    && error.code === code && error.message.includes(text));
};

storage.clear();
const defaults = loadSettings();
assert.deepEqual(defaults.videoBridge, {
  enabled: true,
  serverUrl: DEFAULT_VIDEO_BRIDGE_SERVER,
  username: '',
  password: '',
}, 'Jukebox playback defaults on and points at the fork’s Windows bridge default');

saveSettings({ videoBridge: { ...defaults.videoBridge, enabled: false } });
assert.equal(loadSettings().videoBridge.enabled, false,
  'an explicit browser-local Jukebox opt-out remains off');

saveSettings({ videoBridge: {
  enabled: true,
  serverUrl: 'HTTP://LOCALHOST:8085/',
  username: 'viewer',
  password: 'local password',
} });
assert.deepEqual(loadSettings().videoBridge, {
  enabled: true,
  serverUrl: 'http://localhost:8085',
  username: 'viewer',
  password: 'local password',
}, 'bridge preferences round-trip through the shared browser-local settings record');

localStorage.setItem(SETTINGS_KEY, JSON.stringify({
  videoBridge: { enabled: 'yes', serverUrl: 'javascript:alert(1)', username: 4, password: null },
}));
assert.deepEqual(loadSettings().videoBridge, defaults.videoBridge,
  'malformed stored bridge fields fall back to the fresh Jukebox defaults');

assert.equal(normalizeVideoBridgeServer('https://Bridge.Example:443/'), 'https://bridge.example');
assert.throws(() => normalizeVideoBridgeServer('http://localhost:8085/admin'), /only the Yattee origin/);
assert.throws(() => normalizeVideoBridgeServer('file:///yattee'), /http:\/\/ or https:\/\//);

assert.equal(youtubeVideoId('https://www.youtube.com/watch?v=89tgpzE4qkY&t=12'), '89tgpzE4qkY');
assert.equal(youtubeVideoId('https://youtu.be/89tgpzE4qkY?si=example'), '89tgpzE4qkY');
assert.equal(youtubeVideoId('https://music.youtube.com/watch?v=89tgpzE4qkY'), '89tgpzE4qkY');
assert.equal(youtubeVideoId('https://www.youtube.com/shorts/89tgpzE4qkY'), '89tgpzE4qkY');
assert.equal(youtubeVideoId('89tgpzE4qkY'), '89tgpzE4qkY');
assert.throws(() => youtubeVideoId('https://example.com/watch?v=89tgpzE4qkY'), /youtube.com or youtu.be/);
assert.throws(() => youtubeVideoId('https://www.youtube.com/watch?v=short'), /valid YouTube video ID/);

assert.deepEqual(describeVideoBridgeFallback(defaults.videoBridge, new Error('connection refused')), {
  kind: 'not-configured',
  detail: 'connection refused',
  serverUrl: DEFAULT_VIDEO_BRIDGE_SERVER,
}, 'a fresh browser identifies missing bridge setup instead of reporting an unexplained fallback');
assert.deepEqual(describeVideoBridgeFallback({
  ...defaults.videoBridge, username: 'viewer', password: 'secret',
}, new Error('connection refused')), {
  kind: 'failed',
  detail: 'connection refused',
  serverUrl: DEFAULT_VIDEO_BRIDGE_SERVER,
}, 'a saved bridge account distinguishes a runtime failure from missing setup');
assert.match(youtubePlayerErrorMessage(100), /unavailable, private, or has been removed/);
assert.match(youtubePlayerErrorMessage(101), /does not allow.*embedded/);
assert.equal(youtubePlayerErrorMessage(150), youtubePlayerErrorMessage(101),
  'YouTube documents 150 as the same owner-disabled embedding failure as 101');
assert.match(youtubePlayerErrorMessage(153), /identify this Slopesmith page/);
assert.match(youtubePlayerErrorMessage(999), /error 999/);

const authorization = videoBridgeAuthorization('usér', '雪');
assert.equal(Buffer.from(authorization.slice('Basic '.length), 'base64').toString('utf8'), 'usér:雪',
  'Basic auth encodes UTF-8 credentials without btoa truncation');

const videoUrl = yatteeVideoUrl('http://127.0.0.1:8085', 'a/b');
assert.equal(videoUrl.pathname, '/api/v1/videos/a%2Fb');
assert.equal(videoUrl.searchParams.get('proxy'), 'true');
assert.equal(videoUrl.searchParams.get('proxy_mode'), 'relay');
assert.equal(videoUrl.searchParams.get('invidious'), 'false');

const picked = playableYatteeStream([
  { url: 'unsupported', type: 'video/unknown', height: 720 },
  { url: '1080', type: 'video/mp4', height: 1080 },
  { url: '360', type: 'video/mp4', height: 360 },
  { url: '720', type: 'video/mp4', height: 720 },
], type => type === 'video/mp4' ? 'probably' : '');
assert.equal(picked?.url, '720', 'the proof surface chooses the best playable stream at or below 720p');

const adaptive = playableYatteeAdaptivePair([
  { url: 'video-av1-720', type: 'video/mp4; codecs="av01.0.05M.08"', height: 720 },
  { url: 'video-1080', type: 'video/mp4; codecs="avc1.640028"', height: 1080 },
  { url: 'video-avc-480', type: 'video/mp4; codecs="avc1.4d401f"', height: 480 },
  { url: 'video-360', type: 'video/mp4; codecs="avc1.4d401e"', height: 360 },
  { url: 'audio-low', type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: '64000' },
  { url: 'audio-default', type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: '48000', audioTrack: { isDefault: true } },
  { url: 'audio-opus-default', type: 'audio/webm; codecs="opus"', bitrate: '128000', audioTrack: { isDefault: true } },
  { url: 'audio-unsupported', type: 'audio/unknown', bitrate: '999999' },
], type => type.startsWith('video/mp4') ? 'probably' : '',
type => type.startsWith('audio/mp4') ? 'probably' : '');
assert.equal(adaptive?.video.url, 'video-avc-480', 'adaptive fallback prefers reliable H.264 over higher AV1');
assert.equal(adaptive?.audio.url, 'audio-default', 'adaptive fallback prefers default AAC over default Opus');
assert.equal(playableYatteeAdaptivePair([
  { url: 'video', type: 'video/mp4', height: 360 },
], () => 'probably', () => 'probably'), null, 'adaptive fallback requires both tracks');

const prefs = {
  enabled: true,
  serverUrl: 'http://127.0.0.1:8085',
  username: 'viewer',
  password: 'local password',
};
let requestedUrl = '';
let requestedAuthorization = '';
const infoFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  requestedUrl = String(input);
  requestedAuthorization = new Headers(init?.headers).get('authorization') ?? '';
  return new Response(JSON.stringify({ name: 'Yattee Server', version: '1.0.7' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};
assert.deepEqual(await testVideoBridge(prefs, infoFetch), {
  serverUrl: 'http://127.0.0.1:8085',
  name: 'Yattee Server',
  version: '1.0.7',
});
assert.equal(requestedUrl, 'http://127.0.0.1:8085/info');
assert.equal(requestedAuthorization, videoBridgeAuthorization(prefs.username, prefs.password));

await expectBridgeError(testVideoBridge({ ...prefs, username: '', password: '' }, async () =>
  new Response(JSON.stringify({ name: 'yattee-server' }), { status: 200 })),
'authentication', 'requires a username');
await expectBridgeError(testVideoBridge(prefs, async () => new Response('{}', { status: 401 })),
  'authentication', 'rejected');
await expectBridgeError(testVideoBridge(prefs, async () => new Response('<html>not Yattee</html>', { status: 200 })),
  'response', 'did not return Yattee');

const resolved = await resolveYatteeVideo(prefs, 'test-video', async input => {
  const url = new URL(String(input));
  assert.equal(url.pathname, '/api/v1/videos/test-video');
  return new Response(JSON.stringify({
    title: 'Test',
    formatStreams: [{ url: '/proxy/relay?token=x' }],
    adaptiveFormats: [{ url: '/proxy/relay?token=video', type: 'video/mp4' }],
  }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
});
assert.equal(resolved.title, 'Test');
assert.equal(resolved.formatStreams?.[0]?.url, '/proxy/relay?token=x');
assert.equal(resolved.adaptiveFormats?.[0]?.url, '/proxy/relay?token=video');

// The browser-only loader is exercised with the narrow DOM surface it owns: one script, one chained global
// callback, and the API value YouTube publishes. This stays deterministic and never contacts youtube.com.
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
let priorReadyCalled = false;
const insertedScript = { src: '', async: false, addEventListener: () => undefined, remove: () => undefined };
const fakeWindow = {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  onYouTubeIframeAPIReady: () => { priorReadyCalled = true; },
} as unknown as Window;
const fakeDocument = {
  querySelector: () => null,
  createElement: () => {
    return insertedScript;
  },
  head: { appendChild: () => undefined },
} as unknown as Document;
Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
Object.defineProperty(globalThis, 'document', { configurable: true, value: fakeDocument });
const iframeApi = loadYouTubeIframeApi();
assert.equal(insertedScript?.src, YOUTUBE_IFRAME_API_URL, 'fallback loads only the official iframe API script');
const publishedApi = {
  Player: class {},
  PlayerState: { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
} as unknown as YouTubeIframeApi;
fakeWindow.YT = publishedApi;
fakeWindow.onYouTubeIframeAPIReady?.();
assert.equal(await iframeApi, publishedApi);
assert(priorReadyCalled, 'fallback preserves an existing global YouTube-ready listener');
if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
else Reflect.deleteProperty(globalThis, 'window');
if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
else Reflect.deleteProperty(globalThis, 'document');

console.log('VIDEO BRIDGE: PASS');
