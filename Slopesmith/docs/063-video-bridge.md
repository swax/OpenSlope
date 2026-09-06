# 063 — Jukebox Playback

Paste a YouTube URL into **Users → Jukebox** and add it to the server-wide queue. Slopesmith plays it through
the official YouTube IFrame Player, which needs no setup and no companion software. The shared queue,
play/pause, seek, local mute, and local volume all work through it. Browsers may require one click before
autoplay with sound, and videos whose owners disable embedding cannot be played.

That player is a DOM iframe, so its cross-origin pixels cannot be uploaded into Three.js. The Jukebox panel and
its soundtrack work; the authored and reference **course screens** inside a ride stay dark, because putting the
movie on them needs a frame the page is allowed to sample. Covering that case is the only thing the optional
integration below exists for.

Nothing about video is mountain content. Playback settings are a browser preference: turning them on never
changes a project or an export, and another member never inherits your URL, account, or credentials. What does
travel over the authenticated session channel is the public YouTube URL, queuer identity, queue order, and
playback epoch, so everybody follows the same selection and position.

## Optional: sourcing video from a local media server

**Slopesmith ships no media extractor and never requests media from YouTube's servers itself.** If you already
run a self-hosted media server on your own machine, you can point Slopesmith at it and it will ask that server
for a browser-playable stream instead of loading the iframe — which is what makes the movie available to the
course screens. The request is a plain, authenticated, Invidious-compatible `GET /api/v1/videos/{id}`, made by
your browser directly to an origin you configured; Slopesmith's Node service is never in that path and proxies
nothing. Whatever that server does to answer is between you, the software you installed, and its sources.

This is off the beaten path. It needs software installed from elsewhere, a dedicated account, a CORS
allowance, and — away from the desktop — a tunnel. Skip the rest of this page unless you specifically want
video on in-course screens.

[Yattee Server](https://github.com/swax/yattee-server) is the implementation these instructions are written
and tested against: a yt-dlp-based media server maintained by the same author as OpenSlope, under its own MIT
licence, and neither built, bundled, nor distributed with Slopesmith. Any server answering the same API and
relaying its own bytes will do. When it is absent,
unreachable, rejects the request, or produces no playable stream, Slopesmith falls back to the YouTube player
above without interrupting the queue. A later queue item tries the server again; retrying the same failed item
stays on YouTube.

### Setup on Windows

1. Install and start a media server that answers the Invidious-compatible video API and relays its own
   bytes. [yattee-server](https://github.com/swax/yattee-server) is the one these steps were tested against.
   It is a separate project under its own terms, and nothing in it is built, bundled, run, or distributed by
   Slopesmith: follow that project's own setup and start instructions, and satisfy its prerequisites there.
2. Open `http://127.0.0.1:8085`, finish Yattee's first-run setup, and create an account.
3. In **Yattee Admin → Settings → Browser Access**, add the exact origin shown by Slopesmith's setup guide.
   For example, a local development editor may be `http://localhost:5179`, while the hosted editor has its own
   `https://` origin. Do not add a path. The optional localhost toggle covers changing local development ports.
4. In **Slopesmith Settings → Integrations → Local video bridge**, enter the Yattee origin and account, then choose
   **Test connection**. Approve the browser's local-network permission prompt if it appears.
5. Save, then open **Users → Jukebox**. Paste a YouTube video URL into the queue and
   choose Add. Pause/play and seek are shared transport controls; mute, volume, and Turn on/off affect only
   this browser. Skip/removal follows queue ownership.

### Reaching a local server from Quest or mobile

`http://127.0.0.1:8085` works only when the browser and Yattee run on the same computer. In a Quest or mobile
browser it points back to the headset or phone. Keep Yattee bound to the workstation's loopback interface and
give port 8085 its own HTTPS ngrok endpoint instead.

If Slopesmith is also running locally on that workstation, it needs a second endpoint. If the browser already
uses a hosted Slopesmith site, skip the editor tunnel and create only the Yattee tunnel. The included launchers
expect preassigned endpoint URLs; when both are needed they must be distinct.

1. Install and authenticate the [ngrok agent](https://ngrok.com/docs/start). In
   `OpenSlope\Slopesmith`, copy `.env.example` to the gitignored `.env` and set:

   ```dotenv
   # Hostname only: the Vite host allow-list.
   SLOPESMITH_ALLOWED_HOSTS=your-editor-domain.ngrok.app

   # Complete, distinct HTTPS endpoint URLs.
   SLOPESMITH_LOCAL_SERVER_NGROK_URL=https://your-editor-domain.ngrok.app
   SLOPESMITH_VIDEO_BRIDGE_NGROK_URL=https://your-video-domain.ngrok.app
   ```

   When Slopesmith is already hosted, the first two values are not used for this workflow; the video endpoint
   is still required.
2. From `OpenSlope\Slopesmith`, keep the required processes running in separate terminals:

   ```powershell
   # Local Slopesmith only; omit both commands when using an existing hosted site.
   npm run run:local-server
   npm run run:local-server:ngrok

   # Required for the remote video bridge: start the media server per its own instructions, then tunnel it.
   npm run run:video-bridge:ngrok
   ```

   `run:local-server` deliberately enables accounts and trusted-proxy handling. Do not substitute the ordinary
   unauthenticated `npm run dev` process when tunneling Slopesmith to the Internet.
3. On the workstation, open Yattee Admin at `http://127.0.0.1:8085`. Under **Settings → Browser Access**, add
   the exact public Slopesmith origin—not the video endpoint. That is either the hosted site origin or
   `https://your-editor-domain.ngrok.app`.
4. On the Quest or mobile device, open the public Slopesmith URL. Under **File → Settings → Integrations → Local
   video bridge**, enter `https://your-video-domain.ngrok.app` plus the dedicated Yattee account, choose
   **Test connection**, and save.
5. Open **Users → Jukebox** and play a video. Keep the workstation, Yattee, and the video tunnel running for
   the entire session. The relayed media bytes travel through that tunnel, so video uses substantially more
   tunnel bandwidth than the editor UI.

Both endpoints are Internet-reachable while their tunnels run. Use strong, unique Slopesmith and Yattee
passwords, share the URLs only with intended participants, and stop the endpoints after the session. A tunnel
does not turn the Yattee account into a Slopesmith account; its Basic credentials remain separate and are saved
only in that device's browser profile.

The connection test is intentionally more than a ping. It makes an authenticated cross-origin request to
Yattee's `/info`, which proves all of these together:

- the local process is running at the entered origin;
- Yattee allows this Slopesmith origin through CORS;
- the browser granted access to the local network; and
- the username and password are accepted.

It does not download a video. Jukebox Play is the end-to-end test: server resolution, signed relay, byte-range,
media type, decode, and WebGL texture.

## Troubleshooting

| What Slopesmith says | What to check |
|---|---|
| Could not reach Yattee | Start Yattee; confirm the URL; add Slopesmith's exact origin under Yattee Browser Access. On the same computer, accept the browser's local-network prompt. On Quest/mobile, use the HTTPS video endpoint rather than `127.0.0.1` and confirm its ngrok process is running. |
| That address answered, but it did not return Yattee server information | Confirm the video endpoint forwards to port 8085. If ngrok presents its anti-abuse interstitial, open the video endpoint once on that device, continue through the warning, and retry the connection test. |
| Yattee is reachable, but it requires a username and password | Enter the account created during Yattee setup. An anonymous `/info` reply proves reachability but not authorization. |
| Yattee rejected that username or password | Re-enter the dedicated local account. The credentials are HTTP Basic Auth, not the Slopesmith account. |
| Enter a YouTube video URL | Paste a `youtube.com` or `youtu.be` watch, Shorts, live, or embed URL. A bare 11-character video ID also works. |
| No browser-playable muxed stream | The server did not offer a combined audio/video format that this browser reports it can decode. Check the server's own documentation and prerequisites, or try another public video. |
| Video plays without sound | Check the tab/site mute state plus the Jukebox Mute button and volume slider. Slopesmith starts Jukebox media unmuted at full volume. |
| Relay answered but media could not start | Inspect the relay response for `206 Partial Content` and a `video/*` Content-Type. Update the server if it reports `text/plain`. |
| YouTube fallback · video bridge not set up; course screens off | Playback is working through YouTube's embedded player, but this browser has no complete Yattee account saved. Use the status-line info button to open the bridge setup, test it, and save. On another computer, remember that `127.0.0.1` names that computer. |
| YouTube fallback · video bridge failed; course screens off | Slopesmith tried the saved bridge and retained its exact failure behind the status-line info button. Open it for the attempted endpoint and error, then use **Open bridge settings** to test or repair the connection. |
| The owner does not allow this video to be embedded | Choose another video or restore Yattee; YouTube blocks its iframe for this item. |
| Your browser blocked automatic playback | Click **Play YouTube video** once in the Jukebox preview. Shared transport resumes after that local permission gesture. |
| The course surface is absent | Confirm Users → Jukebox still shows On. Course screens additionally require a working Yattee stream and enough mountain geometry to produce bounds. |

## Privacy and trust boundary

The bridge URL, username, and password live in `localStorage` under `slopesmith-settings-v1`, beside the
browser-local fal.ai key and generator preferences. They do not enter `.slope.json`, project sync, exports, or
Slopesmith's Node service. The browser sends them directly to the configured Yattee origin as a Basic
`Authorization` header.

Anyone who can read that browser profile can read the saved password. Use a dedicated Yattee account and do
not reuse an important password. Keep Yattee itself bound to loopback unless its authentication, TLS, network
policy, and abuse controls have been deliberately configured for a wider network. An ngrok endpoint still makes
that loopback service reachable through ngrok for as long as the agent runs; TLS terminates at the tunnel
provider and the relayed video crosses its service. The origin field accepts only an HTTP(S) origin: embedded
credentials, paths, queries, fragments, and non-web schemes are rejected.

Fallback playback loads YouTube's official iframe API and embedded player directly from `youtube.com`. That
request is subject to YouTube's own privacy policy, cookies, availability, advertising, and embed rules. Nothing
from the iframe is proxied through Slopesmith's Node service.

## Internal contract

The feature has these owners:

- `src/app/state/settings.ts` owns `VideoBridgePrefs`, safe defaults, validation on load, persistence, and the
  `slopesmith:settings-changed` event. The default is enabled; an explicit browser-local opt-out persists.
- `src/app/net/video-bridge.ts` is the Yattee protocol boundary. It canonicalizes origins, emits UTF-8 Basic
  Auth, tests `/info`, resolves `/api/v1/videos/{id}?proxy=true&proxy_mode=relay&invidious=false`, and chooses a
  browser-decodable muxed stream with 720p as the proof surface's useful ceiling.
- `src/app/net/youtube-iframe.ts` loads the official player API once, declares its narrow local TypeScript
  contract, and maps YouTube's numeric embed errors into Jukebox messages.
- `src/app/ui/chrome/settings-dialog.ts` owns the connection fields, test result, and inline setup guide. Testing
  uses the unsaved field values; Save persists them without changing the Jukebox's local on/off state.
- `src/app/ui/chrome/users-mode.ts` owns the local Turn on/off, mute, and volume controls; draws the shared
  play/pause, seek, Add, queue, and ownership-aware Remove/Skip controls; and hosts the real media element while
  the user is outside a ride.
- `src/server/session/jukebox.ts` owns the ephemeral, service-wide fair queue and enforces removal/skip
  permissions. `session/channel.ts` broadcasts its absolute state and gives late joiners the current epoch.
- `src/core/session/jukebox.ts` is the shared wire contract and turns `(position, changedAt, serverNow)` into
  the authoritative playhead each browser follows.
- `src/app/viewport/scene/video-billboard.ts` owns both view-only players. It reads settings at playback time,
  tries Yattee before YouTube, makes a newer queue epoch win over late provider responses, and publishes only a
  Yattee-backed texture to the course-screen layer. Its structured result distinguishes a missing browser-local
  setup from a failed configured bridge, retaining the original error for the clickable Jukebox status info.
  The selected provider owns one non-positional soundtrack; no screen creates a Three.js audio source.
- `src/app/viewport/scene/screens.ts` applies that one texture to every authored and reference video screen.
  Playback controls panel visibility; Sources independently controls borders, movie icons, and picking.

Yattee must proxy/relay the bytes rather than redirecting the `<video>` element to a media CDN. Otherwise the
CDN controls CORS. Stream URLs returned by the video-info call may be relative; Slopesmith resolves them against
the configured Yattee origin. Signed relay URLs are deliberately usable by the media element without copying
the Basic credential into the URL.

### Browser rendering path

Playback uses one standard `THREE.VideoTexture` sourced from the real media element and shared by the floating
billboard and every authored screen. The viewport marks it dirty on each visible, playing frame as a fallback
for Quest Chromium builds that throttle `requestVideoFrameCallback` in WebXR. The status/retry card and native
video preview remain ordinary DOM. One fixed page-level portal owns that subtree for its entire lifetime and is
positioned over a disposable placeholder while Users is open; closing or rebuilding the panel parks the portal
offscreen without reparenting its `<video>` or iframe. That preserves the YouTube browsing context and keeps the
native decoder laid out so Android does not suspend it. Slopesmith does not use the experimental HTML-in-Canvas
APIs and needs no browser flag or origin trial for video.

The YouTube fallback iframe never moves in the DOM. Its portal follows the visible panel rectangle while Users
is open and becomes transparent, inert, and offscreen when Users closes, preserving audio and the shared clock.
It is deliberately never sampled into a canvas or texture. During fallback playback there is consequently no
floating in-world panel and no movie material on authored/reference screens, including in WebXR.

The in-world panel is anchored from the authored mountain AABB and faces the editor camera. Turning playback
off hides the mesh and stops the local decoder. No billboard state is serialised.

## Synchronised playback

The server carries only public source identity and an authoritative playback epoch: current entry, pending
entries, media version, media seconds, and the server timestamp at which those seconds were true. Each viewer
independently starts its available provider, seeks to that clock after startup, and rejoins the authoritative
position after provider delay. Yattee media nudges back when local buffering drifts by more than 1.5 seconds.
Play/pause and seek change the clock anchor without
reloading; a new,
skipped, ended, or looped item bumps the media version and starts/restarts the decoder. The queue is ephemeral
and service-wide, capped at 24 entries, and fair by contribution round so one member cannot stack several turns
ahead of everybody else's first.

Anyone may add, play/pause, or seek. A queued item can be removed, and the current one skipped, only by its queuer or a
moderator/admin. The final intact video loops until it is explicitly skipped. Every decoder can report an end,
but the server accepts it only for the current media version, so simultaneous reports advance at most once.

`test/video-bridge.test.ts` pins settings migration/fail-closed behavior, origin and YouTube URL validation,
UTF-8 auth, request shape, connection-test interpretation, relay response parsing, stream selection, fallback
labels, and iframe error messages. `test/video-screens.test.ts` pins the key rendering boundary: iframe fallback
never publishes a course-screen texture. Neither test has a live network dependency.
