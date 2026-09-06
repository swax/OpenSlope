import * as THREE from 'three';
import type { Stage } from '../stage';
import {
  describeVideoBridgeFallback, playableYatteeAdaptivePair, playableYatteeStream, resolveYatteeVideo, youtubeVideoId,
  type VideoBridgeFallback,
} from '../../net/video-bridge';
import {
  loadYouTubeIframeApi, youtubePlayerErrorMessage,
  type YouTubePlayer,
} from '../../net/youtube-iframe';
import { loadSettings, SETTINGS_CHANGED_EVENT } from '../../state/settings';

function element<K extends keyof HTMLElementTagNameMap>(tag: K, cssText: string) {
  const result = document.createElement(tag);
  result.style.cssText = cssText;
  return result;
}

export type VideoPlaybackResult = {
  title: string;
} & ({
  provider: 'bridge';
} | {
  provider: 'youtube';
  bridge: VideoBridgeFallback;
});

export type VideoBillboard = {
  setMountainBounds(bounds: THREE.Box3 | null): void;
  /** Prefer the local bridge, then fall back to YouTube's iframe player. Null means Stop won. */
  play(sourceUrl: string, startAtSeconds?: number): Promise<VideoPlaybackResult | null>;
  /** Apply the server's shared playhead without resolving or reloading the source. */
  seek(positionSeconds: number): void;
  /** Follow the shared play/pause transport without replacing the resolved source. */
  setPlaying(playing: boolean): void;
  /** Audio preference is deliberately local to this browser. */
  setMuted(muted: boolean): void;
  muted(): boolean;
  setVolume(volume: number): void;
  volume(): number;
  currentTime(): number;
  duration(): number;
  /** Use a Users element as the preview rectangle; null parks the page-stable player offscreen. */
  mountPreview(host: HTMLElement | null): void;
  onEnded(listener: (() => void) | null): void;
  /** Cancel an in-flight resolve and clear the media element. */
  stop(): void;
  update(camera: THREE.Camera, inGame: boolean): void;
};

/**
 * Shared Jukebox video surface. It is view-only: no billboard state enters the mountain document, and
 * rebuilding the mountain merely re-seats it beside the upper corner of the live AABB.
 */
export function createVideoBillboard(
  stage: Stage,
  onPlaybackTexture: (texture: THREE.Texture | null) => void = () => undefined,
): VideoBillboard {
  const root = element('div', [
    'width:640px', 'height:360px', 'box-sizing:border-box', 'overflow:hidden',
    'position:relative', 'border:5px solid #f4a33a', 'border-radius:18px',
    'background:linear-gradient(145deg,#172331,#0a1018)', 'color:#f7fbff',
    'font:600 20px/1.25 system-ui,-apple-system,Segoe UI,sans-serif',
    'box-shadow:0 18px 50px rgba(0,0,0,.48)', 'user-select:none',
  ].join(';'));
  root.setAttribute('aria-label', 'Slopesmith Jukebox video');

  // Keep every decoder in one page-stable subtree. Moving an iframe between parents destroys its browsing
  // context, while Android may suspend a detached <video>; the Users panel is therefore only a positioning
  // anchor for this fixed portal and may rebuild freely without touching the live media elements.
  const decoderHost = element('div', [
    'position:fixed', 'left:-10000px', 'top:0', 'width:640px', 'height:360px',
    'z-index:21', 'opacity:0', 'pointer-events:none', 'overflow:hidden',
  ].join(';'));
  decoderHost.setAttribute('aria-hidden', 'true');
  decoderHost.inert = true;
  document.body.appendChild(decoderHost);
  decoderHost.appendChild(root);
  root.style.width = '100%';
  root.style.height = '100%';

  const video = element('video', [
    'width:100%', 'height:100%', 'display:none', 'object-fit:contain', 'background:#000',
  ].join(';'));
  video.crossOrigin = 'anonymous';
  // Transport is shared and lives in Users. Native controls would allow a local-only pause, so the dock owns
  // the one seek slider and the video element here remains a pure decoder/picture.
  video.controls = false;
  video.playsInline = true;
  // The one media element owns the soundtrack as ordinary page audio. It deliberately never enters
  // THREE.Audio/PositionalAudio: every map screen shows the picture, but none of them is an audio location.
  video.defaultMuted = false;
  video.muted = false;
  video.volume = 1;
  video.preload = 'metadata';
  root.appendChild(video);

  // A muxed YouTube format is not always usable. Keep a separate audio element ready for the adaptive
  // fallback so the visible video-only track can still own the billboard texture.
  const audio = element('audio', 'display:none');
  audio.crossOrigin = 'anonymous';
  audio.preload = 'metadata';
  audio.volume = 1;
  root.appendChild(audio);

  // The iframe fallback is a normal DOM surface. Unlike the Yattee-backed <video>, cross-origin iframe pixels
  // cannot become a VideoTexture, so this remains a panel/audio fallback and never reaches course screens.
  const youtubeSurface = element('div', [
    'position:absolute', 'inset:0', 'display:none', 'width:100%', 'height:100%', 'background:#000',
  ].join(';'));
  let youtubePlayerHost = element('div', 'width:100%;height:100%');
  youtubeSurface.appendChild(youtubePlayerHost);
  root.appendChild(youtubeSurface);

  const card = element('div', [
    'position:absolute', 'inset:0', 'display:flex', 'flex-direction:column',
    'align-items:center', 'justify-content:center', 'gap:18px', 'padding:34px',
    'box-sizing:border-box', 'text-align:center',
  ].join(';'));
  root.appendChild(card);

  const eyebrow = element('div', 'color:#f4a33a;font-size:15px;letter-spacing:.12em;text-transform:uppercase');
  eyebrow.textContent = 'Shared Jukebox';
  card.appendChild(eyebrow);

  const title = element('div', 'font-size:31px;line-height:1.08;max-width:560px');
  title.textContent = 'Video will play here';
  card.appendChild(title);

  const status = element('div', 'font-size:16px;color:#b9c9da;max-width:540px;font-weight:500');
  status.textContent = 'Paste a YouTube URL into Users → Jukebox, then choose Add.';
  card.appendChild(status);

  const play = element('button', [
    'appearance:none', 'border:0', 'border-radius:999px', 'padding:15px 27px',
    'background:#f4a33a', 'color:#17202b', 'font:800 20px system-ui', 'cursor:pointer',
    'box-shadow:0 8px 24px rgba(244,163,58,.28)',
  ].join(';'));
  play.type = 'button';
  play.textContent = '▶  Replay video';
  play.style.display = 'none';
  card.appendChild(play);

  const geometry = new THREE.PlaneGeometry(16, 9);
  // Movie pixels use WebGL's established HTMLVideoElement upload path. The same VideoTexture is shared by the
  // floating billboard and every authored screen, including during an immersive WebXR presentation.
  const movieTexture = new THREE.VideoTexture(video);
  movieTexture.generateMipmaps = false;
  movieTexture.minFilter = THREE.LinearFilter;
  movieTexture.magFilter = THREE.LinearFilter;
  movieTexture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map: movieTexture, color: 0xffffff, side: THREE.DoubleSide, toneMapped: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'jukebox-video-billboard';
  mesh.renderOrder = 3;
  mesh.visible = false;
  stage.scene.add(mesh);

  root.style.pointerEvents = 'auto';
  for (const eventName of ['pointerdown', 'pointerup', 'pointermove', 'click', 'wheel'] as const) {
    root.addEventListener(eventName, event => event.stopPropagation());
  }

  let loading = false;
  let playbackGeneration = 0;
  let videoPaintGeneration = 0;
  let selectedSource: { url: string; videoId: string } | null = null;
  let previewHost: HTMLElement | null = null;
  let previewPortalGeometry = '';
  let inGame = false;
  let endedListener: (() => void) | null = null;
  let pendingPosition = 0;
  let localMuted = false;
  let localVolume = 1;
  let showingVideo = false;
  let lastAdaptiveAudioSyncAt = Number.NEGATIVE_INFINITY;
  let activePlayback: 'none' | 'yattee' | 'youtube' = 'none';
  let preferYouTubeForVideoId = '';
  let preferredYouTubeReason: VideoBridgeFallback | null = null;
  let youtubePlayer: YouTubePlayer | null = null;
  let youtubeReady: Promise<YouTubePlayer> | null = null;
  let youtubePlayerAttempt = 0;
  let youtubeNeedsGesture = false;
  let requestedPlaying = true;
  let pendingYouTubeStart: {
    generation: number;
    resolve: () => void;
    reject: (error: Error) => void;
    timer: number;
  } | null = null;

  const adaptiveAudioSyncIntervalMs = 2_000;
  const adaptiveAudioSyncThresholdSeconds = 0.75;

  function showVideoSurface(show: boolean) {
    showingVideo = show;
    onPlaybackTexture(show && inGame ? movieTexture : null);
    if (!show) mesh.visible = false;
  }

  /** The amber card belongs to the setup/status preview in Users, not the in-world movie surface. */
  function showPlayerChrome(show: boolean) {
    root.style.borderWidth = show ? '5px' : '0';
    root.style.borderRadius = show ? '18px' : '0';
    root.style.boxShadow = show ? '0 18px 50px rgba(0,0,0,.48)' : 'none';
  }

  function clearMedia() {
    showVideoSurface(false);
    videoPaintGeneration++;
    lastAdaptiveAudioSyncAt = Number.NEGATIVE_INFINITY;
    activePlayback = 'none';
    youtubeNeedsGesture = false;
    youtubeSurface.style.display = 'none';
    try { youtubePlayer?.stopVideo(); } catch { /* a player still starting has nothing to stop yet */ }
    if (pendingYouTubeStart) {
      const pending = pendingYouTubeStart;
      window.clearTimeout(pending.timer);
      pendingYouTubeStart = null;
      pending.resolve();
    }
    video.pause();
    audio.pause();
    video.removeAttribute('src');
    audio.removeAttribute('src');
    video.load();
    audio.load();
    video.muted = localMuted;
    audio.muted = localMuted;
    video.style.display = 'none';
  }

  function showPlaybackError(message: string) {
    // A failed video track must also stop its separate adaptive audio track.
    // Leaving either source attached lets Chromium continue reopening failed
    // Range requests while the user sees a black frame.
    clearMedia();
    onPlaybackTexture(null);
    showPlayerChrome(true);
    video.style.display = 'none';
    card.style.display = 'flex';
    play.style.display = 'block';
    play.textContent = 'Retry video';
    status.textContent = message;
  }

  function settleYouTubeStart(error?: Error) {
    const pending = pendingYouTubeStart;
    if (!pending) return;
    window.clearTimeout(pending.timer);
    pendingYouTubeStart = null;
    if (error) pending.reject(error); else pending.resolve();
  }

  function showYouTubeGesturePrompt() {
    if (activePlayback !== 'youtube') return;
    youtubeNeedsGesture = true;
    showPlayerChrome(true);
    card.style.display = 'flex';
    play.disabled = false;
    play.style.display = 'block';
    play.textContent = requestedPlaying ? '▶  Play YouTube video' : 'Enable YouTube playback';
    status.textContent = requestedPlaying
      ? 'Your browser blocked automatic playback. Click Play to start the YouTube fallback.'
      : 'The shared video is paused. Click Enable now, or wait until playback resumes and click Play.';
  }

  function ensureYouTubePlayer(): Promise<YouTubePlayer> {
    if (youtubeReady) return youtubeReady;
    youtubeReady = loadYouTubeIframeApi().then(api => {
      const attempt = ++youtubePlayerAttempt;
      return new Promise<YouTubePlayer>((resolve, reject) => {
        let readySettled = false;
        const readyTimer = window.setTimeout(() => {
          if (attempt !== youtubePlayerAttempt || readySettled) return;
          readySettled = true;
          reject(new Error('YouTube did not initialize its embedded player within 15 seconds.'));
        }, 15_000);
        try {
          youtubePlayer = new api.Player(youtubePlayerHost, {
            width: '100%',
            height: '100%',
            playerVars: {
              autoplay: 1,
              controls: 0,
              disablekb: 1,
              playsinline: 1,
              rel: 0,
              origin: window.location.origin,
            },
            events: {
              onReady: event => {
                if (attempt !== youtubePlayerAttempt || readySettled) return;
                readySettled = true;
                window.clearTimeout(readyTimer);
                youtubePlayer = event.target;
                youtubePlayer.setVolume(Math.round(localVolume * 100));
                if (localMuted) youtubePlayer.mute(); else youtubePlayer.unMute();
                resolve(youtubePlayer);
              },
              onStateChange: event => {
                if (attempt !== youtubePlayerAttempt) return;
                if (pendingYouTubeStart?.generation === playbackGeneration
                  && event.data !== -1) settleYouTubeStart();
                if (activePlayback !== 'youtube') return;
                if (event.data === api.PlayerState.PLAYING) {
                  youtubeNeedsGesture = false;
                  card.style.display = 'none';
                  play.style.display = 'none';
                  showPlayerChrome(false);
                  if (!requestedPlaying) event.target.pauseVideo();
                } else if (event.data === api.PlayerState.ENDED) {
                  if (endedListener) endedListener(); else stopPlayback();
                }
              },
              onError: event => {
                if (attempt !== youtubePlayerAttempt) return;
                const error = new Error(youtubePlayerErrorMessage(event.data));
                if (pendingYouTubeStart?.generation === playbackGeneration) settleYouTubeStart(error);
                else if (activePlayback === 'youtube') showPlaybackError(error.message);
              },
              onAutoplayBlocked: () => {
                if (attempt !== youtubePlayerAttempt) return;
                if (pendingYouTubeStart?.generation === playbackGeneration) settleYouTubeStart();
                showYouTubeGesturePrompt();
              },
            },
          });
        } catch (error) {
          readySettled = true;
          window.clearTimeout(readyTimer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }).catch(error => {
      youtubeReady = null;
      youtubePlayer = null;
      youtubePlayerAttempt++;
      youtubePlayerHost = element('div', 'width:100%;height:100%');
      youtubeSurface.replaceChildren(youtubePlayerHost);
      throw error;
    });
    return youtubeReady;
  }

  async function startYouTubeFallback(videoId: string, startAtSeconds: number, generation: number) {
    const player = await ensureYouTubePlayer();
    if (generation !== playbackGeneration) return null;
    activePlayback = 'youtube';
    showVideoSurface(false);
    youtubeNeedsGesture = false;
    youtubeSurface.style.display = 'block';
    video.style.display = 'none';
    player.setVolume(Math.round(localVolume * 100));
    if (localMuted) player.mute(); else player.unMute();

    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        if (pendingYouTubeStart?.generation !== generation) return;
        settleYouTubeStart(new Error('YouTube did not start the embedded video within 10 seconds.'));
      }, 10_000);
      pendingYouTubeStart = { generation, resolve, reject, timer };
      try { player.loadVideoById({ videoId, startSeconds: Math.max(0, startAtSeconds) }); }
      catch (error) {
        settleYouTubeStart(error instanceof Error ? error : new Error(String(error)));
      }
    });
    if (generation !== playbackGeneration) return null;
    const title = player.getVideoData().title;
    root.setAttribute('aria-label', `Playing ${title || 'YouTube video'} in the shared Jukebox fallback`);
    return title?.trim() || videoId;
  }

  function stopPlayback() {
    playbackGeneration++;
    loading = false;
    onPlaybackTexture(null);
    clearMedia();
    showPlayerChrome(true);
    card.style.display = 'flex';
    play.disabled = false;
    play.style.display = selectedSource ? 'block' : 'none';
    play.textContent = '▶  Replay video';
    status.textContent = selectedSource
      ? 'Playback stopped. Replay this shared selection here.'
      : 'Paste a YouTube URL into Users → Jukebox, then choose Add.';
    root.setAttribute('aria-label', 'Slopesmith Jukebox video');
  }

  const mediaMetadata = (media: HTMLMediaElement, generation: number): Promise<void> => {
    if (media.readyState >= HTMLMediaElement.HAVE_METADATA) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const loaded = () => finish(resolve);
      const failed = () => finish(() => reject(new Error('The relayed stream did not expose media metadata.')));
      const emptied = () => { if (generation !== playbackGeneration) finish(resolve); };
      const finish = (done: () => void) => {
        media.removeEventListener('loadedmetadata', loaded);
        media.removeEventListener('error', failed);
        media.removeEventListener('emptied', emptied);
        if (generation !== playbackGeneration) resolve();
        else done();
      };
      media.addEventListener('loadedmetadata', loaded);
      media.addEventListener('error', failed);
      media.addEventListener('emptied', emptied);
    });
  };

  function seekPlayback(positionSeconds: number) {
    if (!Number.isFinite(positionSeconds)) return;
    pendingPosition = Math.max(0, positionSeconds);
    if (activePlayback === 'youtube' && youtubePlayer) {
      youtubePlayer.seekTo(pendingPosition, true);
      return;
    }
    if (!video.currentSrc) return;
    for (const media of [video, audio]) {
      if (!media.currentSrc) continue;
      const duration = Number.isFinite(media.duration) ? media.duration : Infinity;
      try { media.currentTime = Math.min(pendingPosition, Math.max(0, duration - 0.05)); }
      catch { return; /* metadata has not arrived; resolveAndPlay applies pendingPosition once it does */ }
    }
    if (audio.currentSrc) lastAdaptiveAudioSyncAt = performance.now();
  }

  function setPlaying(playing: boolean) {
    requestedPlaying = playing;
    if (activePlayback === 'youtube' && youtubePlayer) {
      if (playing) youtubePlayer.playVideo(); else youtubePlayer.pauseVideo();
      if (youtubeNeedsGesture) showYouTubeGesturePrompt();
      return;
    }
    if (!video.currentSrc) return;
    if (!playing) {
      video.pause();
      audio.pause();
      return;
    }
    void Promise.all([video.play(), ...(audio.currentSrc ? [audio.play()] : [])])
      .catch(error => showPlaybackError(
        `${error instanceof Error ? error.message : String(error)} Click Retry video to resume in this browser.`,
      ));
  }

  function setMuted(muted: boolean) {
    localMuted = muted;
    if (youtubePlayer) {
      if (localMuted) youtubePlayer.mute(); else youtubePlayer.unMute();
    }
    // Adaptive playback carries sound in the separate audio element; its video track must remain muted.
    video.muted = localMuted || !!audio.currentSrc;
    audio.muted = localMuted;
  }

  function setVolume(volume: number) {
    if (!Number.isFinite(volume)) return;
    localVolume = THREE.MathUtils.clamp(volume, 0, 1);
    youtubePlayer?.setVolume(Math.round(localVolume * 100));
    video.volume = localVolume;
    audio.volume = localVolume;
  }

  async function startResolvedStream(
    videoUrl: string,
    serverUrl: string,
    generation: number,
    audioUrl?: string,
  ) {
    activePlayback = 'yattee';
    youtubeSurface.style.display = 'none';
    video.muted = localMuted || !!audioUrl;
    audio.muted = localMuted;
    video.src = new URL(videoUrl, serverUrl).href;
    if (audioUrl) audio.src = new URL(audioUrl, serverUrl).href;
    video.style.display = 'block';
    play.style.display = 'none';
    status.textContent = 'Stream resolved — buffering the first video frame…';
    // Load both adaptive tracks before starting either one. Starting while the
    // hidden audio element is still discovering metadata creates enough drift
    // to trigger a seek/reload loop in Chromium.
    if (pendingPosition > 0 || audioUrl) {
      await Promise.all([
        mediaMetadata(video, generation),
        ...(audioUrl ? [mediaMetadata(audio, generation)] : []),
      ]);
      if (generation !== playbackGeneration) return;
      if (pendingPosition > 0) seekPlayback(pendingPosition);
    }
    lastAdaptiveAudioSyncAt = performance.now();
    await Promise.all([video.play(), ...(audioUrl ? [audio.play()] : [])]);
  }

  async function resolveAndPlay(sourceUrl: string, startAtSeconds = 0): Promise<VideoPlaybackResult | null> {
    const videoId = youtubeVideoId(sourceUrl);
    const generation = ++playbackGeneration;
    selectedSource = { url: sourceUrl.trim(), videoId };
    pendingPosition = Math.max(0, startAtSeconds);
    root.dataset.videoBillboard = videoId;
    onPlaybackTexture(null); // replacing a selection hides every course screen while its new stream resolves
    clearMedia();
    showPlayerChrome(true);
    loading = true;
    play.disabled = true;
    play.style.display = 'none';
    card.style.display = 'flex';
    status.textContent = preferYouTubeForVideoId === videoId
      ? 'Loading the YouTube fallback…'
      : 'Asking Yattee to resolve the stream…';

    try {
      const prefs = loadSettings().videoBridge;
      if (!prefs.enabled) throw new Error('Turn on video playback at the top of Users → Jukebox first.');
      let bridgeFallback = preferYouTubeForVideoId === videoId ? preferredYouTubeReason : null;
      if (preferYouTubeForVideoId !== videoId) {
        try {
          const info = await resolveYatteeVideo(prefs, videoId);
          if (generation !== playbackGeneration) return null;
          const stream = playableYatteeStream(info.formatStreams ?? [], type => video.canPlayType(type));
          const adaptive = playableYatteeAdaptivePair(
            info.adaptiveFormats ?? [],
            type => video.canPlayType(type),
            type => audio.canPlayType(type),
          );
          if (!stream?.url && !adaptive) {
            throw new Error('Yattee did not return browser-playable video and audio streams.');
          }

          let muxedFailed = false;
          if (stream?.url) {
            try {
              await startResolvedStream(stream.url, prefs.serverUrl, generation);
            } catch (error) {
              if (!adaptive || generation !== playbackGeneration) throw error;
              muxedFailed = true;
              clearMedia();
              status.textContent = 'The muxed stream was rejected — trying separate video and audio tracks…';
            }
          }
          if ((!stream?.url || muxedFailed) && adaptive) {
            await startResolvedStream(adaptive.video.url, prefs.serverUrl, generation, adaptive.audio.url);
          }
          if (generation !== playbackGeneration) return null;
          preferYouTubeForVideoId = '';
          preferredYouTubeReason = null;
          card.style.display = 'none';
          showPlayerChrome(false);
          root.setAttribute('aria-label', `Playing ${info.title || 'YouTube video'} in the shared Jukebox`);
          showVideoSurface(true);
          applyMountainBounds();
          return { title: info.title || videoId, provider: 'bridge' };
        } catch (error) {
          if (generation !== playbackGeneration) return null;
          bridgeFallback = describeVideoBridgeFallback(prefs, error);
          preferYouTubeForVideoId = videoId;
          preferredYouTubeReason = bridgeFallback;
          clearMedia();
        }
      }

      bridgeFallback ??= describeVideoBridgeFallback(
        prefs,
        new Error('The local bridge was unavailable earlier for this video.'),
      );
      const yatteeMessage = bridgeFallback.detail;
      status.textContent = `${yatteeMessage} Loading the YouTube fallback…`;
      try {
        const fallback = await startYouTubeFallback(videoId, pendingPosition, generation);
        if (generation !== playbackGeneration || !fallback) return null;
        if (youtubeNeedsGesture) showYouTubeGesturePrompt();
        else {
          card.style.display = 'none';
          play.style.display = 'none';
          showPlayerChrome(false);
        }
        // An iframe cannot be uploaded into WebGL. Keeping the texture explicitly absent leaves course screens
        // dark while the fixed page-level portal continues the shared soundtrack offscreen during a ride.
        showVideoSurface(false);
        applyMountainBounds();
        return { title: fallback, provider: 'youtube', bridge: bridgeFallback };
      } catch (error) {
        if (generation !== playbackGeneration) return null;
        const youtubeMessage = error instanceof Error ? error.message : String(error);
        const combined = `${youtubeMessage} Yattee was also unavailable: ${yatteeMessage}`;
        showPlaybackError(combined);
        throw new Error(combined, { cause: error });
      }
    } catch (error) {
      if (generation !== playbackGeneration) return null;
      const message = error instanceof Error ? error.message : String(error);
      if (activePlayback !== 'none' || video.currentSrc) showPlaybackError(message);
      else {
        card.style.display = 'flex';
        play.style.display = 'block';
        play.textContent = 'Retry video';
        status.textContent = message;
      }
      throw error;
    } finally {
      if (generation === playbackGeneration) {
        loading = false;
        play.disabled = false;
      }
    }
  }

  play.addEventListener('click', () => {
    if (activePlayback === 'youtube' && youtubeNeedsGesture && youtubePlayer) {
      youtubeNeedsGesture = false;
      card.style.display = 'none';
      play.style.display = 'none';
      showPlayerChrome(false);
      youtubePlayer.playVideo();
      return;
    }
    if (selectedSource && !loading) {
      void resolveAndPlay(selectedSource.url, pendingPosition).catch(() => undefined);
    }
  });
  video.addEventListener('error', () => {
    if (!video.currentSrc || loading) return;
    const mediaCode = video.error?.code;
    const suffix = mediaCode ? ` (media error ${mediaCode})` : '';
    showPlaybackError(`The relayed stream could not be decoded${suffix}.`);
  });
  video.addEventListener('ended', () => {
    audio.pause();
    if (endedListener) endedListener();
    else stopPlayback();
  });
  video.addEventListener('playing', () => {
    const generation = ++videoPaintGeneration;
    const paintDecodedFrame = () => {
      video.requestVideoFrameCallback(() => {
        if (generation !== videoPaintGeneration) return;
        const now = performance.now();
        if (
          audio.currentSrc
          && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
          && !video.seeking
          && !audio.seeking
          && now - lastAdaptiveAudioSyncAt >= adaptiveAudioSyncIntervalMs
          && Math.abs(audio.currentTime - video.currentTime) > adaptiveAudioSyncThresholdSeconds
        ) {
          lastAdaptiveAudioSyncAt = now;
          try { audio.currentTime = video.currentTime; }
          catch { /* A later frame can retry once the adaptive audio range is seekable. */ }
        }
        if (!video.ended) paintDecodedFrame();
      });
    };
    paintDecodedFrame();
  });

  let mountainBounds: THREE.Box3 | null = null;
  const applyMountainBounds = () => {
    const enabled = loadSettings().videoBridge.enabled;
    const bounds = mountainBounds;
    if (!enabled && (loading || activePlayback !== 'none' || video.currentSrc)) stopPlayback();
    if (!inGame || !enabled || !bounds || bounds.isEmpty() || !showingVideo) {
      mesh.visible = false;
      onPlaybackTexture(null);
      return;
    }
    const size = bounds.getSize(new THREE.Vector3());
    const width = THREE.MathUtils.clamp(Math.max(size.x, size.z) * 0.16, 24, 90);
    const height = width * 9 / 16;
    mesh.scale.setScalar(width / 16);
    // Stage.scene uses render coordinates directly; negate document Z exactly as worldRoot does.
    mesh.position.set(bounds.max.x + width * 0.6, bounds.max.y + height * 0.15, -bounds.max.z);
    mesh.visible = true;
    onPlaybackTexture(movieTexture);
  };
  window.addEventListener(SETTINGS_CHANGED_EVENT, applyMountainBounds);

  const portalPixel = (value: number) => Math.round(value * 100) / 100;

  function hidePreviewPortal() {
    if (previewPortalGeometry === 'hidden') return;
    previewPortalGeometry = 'hidden';
    decoderHost.style.left = '-10000px';
    decoderHost.style.top = '0';
    decoderHost.style.width = '640px';
    decoderHost.style.height = '360px';
    decoderHost.style.clipPath = 'none';
    decoderHost.style.opacity = '0';
    decoderHost.style.pointerEvents = 'none';
    decoderHost.inert = true;
    decoderHost.setAttribute('aria-hidden', 'true');
  }

  /** Project the permanent media subtree over the disposable Users placeholder without reparenting it. */
  function seatPreview() {
    const host = previewHost;
    if (!host?.isConnected || host.clientWidth <= 0 || host.clientHeight <= 0) {
      hidePreviewPortal();
      return;
    }

    const outer = host.getBoundingClientRect();
    const left = outer.left + host.clientLeft;
    const top = outer.top + host.clientTop;
    const width = host.clientWidth;
    const height = host.clientHeight;
    const scrollSurface = host.closest<HTMLElement>('.lil-gui.lil-root');
    const clip = scrollSurface?.getBoundingClientRect();
    const clipLeftEdge = Math.max(0, clip?.left ?? 0);
    const clipTopEdge = Math.max(0, clip?.top ?? 0);
    const clipRightEdge = Math.min(window.innerWidth, clip?.right ?? window.innerWidth);
    const clipBottomEdge = Math.min(window.innerHeight, clip?.bottom ?? window.innerHeight);
    const clipLeft = Math.min(width, Math.max(0, clipLeftEdge - left));
    const clipTop = Math.min(height, Math.max(0, clipTopEdge - top));
    const clipRight = Math.min(width, Math.max(0, left + width - clipRightEdge));
    const clipBottom = Math.min(height, Math.max(0, top + height - clipBottomEdge));
    if (width - clipLeft - clipRight <= 0 || height - clipTop - clipBottom <= 0) {
      hidePreviewPortal();
      return;
    }

    const geometry = [left, top, width, height, clipTop, clipRight, clipBottom, clipLeft]
      .map(portalPixel).join('|');
    if (previewPortalGeometry === geometry) return;
    previewPortalGeometry = geometry;
    decoderHost.style.left = `${portalPixel(left)}px`;
    decoderHost.style.top = `${portalPixel(top)}px`;
    decoderHost.style.width = `${portalPixel(width)}px`;
    decoderHost.style.height = `${portalPixel(height)}px`;
    decoderHost.style.clipPath = `inset(${portalPixel(clipTop)}px ${portalPixel(clipRight)}px `
      + `${portalPixel(clipBottom)}px ${portalPixel(clipLeft)}px)`;
    decoderHost.style.opacity = '1';
    decoderHost.style.pointerEvents = 'auto';
    decoderHost.inert = false;
    decoderHost.setAttribute('aria-hidden', 'false');
  }

  return {
    setMountainBounds(bounds) {
      mountainBounds = bounds?.clone() ?? null;
      applyMountainBounds();
    },

    play: resolveAndPlay,
    seek: seekPlayback,
    setPlaying,
    setMuted,
    muted: () => localMuted,
    setVolume,
    volume: () => localVolume,
    currentTime: () => {
      const current = activePlayback === 'youtube' && youtubePlayer
        ? youtubePlayer.getCurrentTime() : video.currentTime;
      return Number.isFinite(current) ? current : 0;
    },
    duration: () => {
      const length = activePlayback === 'youtube' && youtubePlayer
        ? youtubePlayer.getDuration() : video.duration;
      return Number.isFinite(length) ? length : 0;
    },
    mountPreview(host) {
      previewHost = host;
      seatPreview();
    },
    onEnded(listener) { endedListener = listener; },
    stop: stopPlayback,

    update(camera, nextInGame) {
      // The Users dock scrolls and changes size independently of the scene. Following its placeholder here
      // keeps the fixed portal aligned without coupling playback lifetime to panel render/teardown.
      if (previewHost) seatPreview();
      if (inGame !== nextInGame) {
        inGame = nextInGame;
        applyMountainBounds();
      }
      if (!mesh.visible) return;
      // VideoTexture normally follows requestVideoFrameCallback. Quest Chromium has shipped builds where that
      // callback stalls during immersive presentation, so also dirty the direct video upload from our XR frame.
      if (showingVideo && !video.paused && !video.ended
        && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) movieTexture.needsUpdate = true;
      // Face the editor camera while retaining the anchor at the mountain's upper AABB corner.
      mesh.quaternion.copy(camera.getWorldQuaternion(new THREE.Quaternion()));
      mesh.updateMatrixWorld(true);
      camera.updateMatrixWorld();
    },
  };
}
