using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.SDK3.Components.Video;
using VRC.SDK3.Video.Components.AVPro;

namespace OpenSlope.VrcPlugin
{

    // The RENDERER half of the video system: one AVPro stream painted across every billboard SCREEN in the world. SSX
    // billboards are welded into the merged static "Props" mesh with shared atlas materials, so a screen face can't be
    // retextured on its own; instead the import lays a fresh quad flush over each screen's textured front (the
    // "Billboards" catalog, from the rectangles snowknife measured), and the ones under this object's Screens container
    // all show the video. See docs/vrchat/041.
    //
    // How "one video on many screens" works: there is exactly ONE VRCAVProVideoPlayer (VRChat caps simultaneous AVPro
    // instances, and we want the SAME frame everywhere anyway). A VRCAVProVideoScreen on the _Driver child writes the
    // decoded frame into a single shared video MATERIAL (useSharedMaterial) every frame; this script assigns that same
    // material asset to every screen quad, so they all display it from the one decode. The screen shader is unlit/emissive
    // (OpenSlope/VideoScreen) so the screens read bright in shade.
    //
    // LOCAL + cosmetic (sync None): this object only DECODES and DRAWS. WHAT plays, WHEN, the shared playhead, the queue,
    // and seeking all live on the networked Jukebox (Jukebox, sync Manual), which drives this renderer through
    // the play/seek/stop methods below and reads CurrentTime()/Duration() to paint its scrub bar. The jukebox calls PlayUrl
    // when the now-playing video changes and Seek when the shared playhead moves; this renderer just obeys, plus owns the
    // two LOCAL concerns that don't belong on the network: ducking the music while a video sounds, and retrying a transient
    // stream error. With no jukebox assigned it falls back to a standalone loop of its inspector `url` (so the renderer still
    // works on its own). Lives on the same GameObject as the VRCAVProVideoPlayer (the video events fire on Udon behaviours
    // on the player's object). The setup menu (OpenSlope/Setup/Video Billboards) builds and wires the object; don't add by hand.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class VideoBillboards : UdonSharpBehaviour
    {
        [Tooltip("The single AVPro player that decodes the stream (on this same GameObject).")]
        public VRCAVProVideoPlayer player;

        [Tooltip("The networked Jukebox that decides what/when to play + owns the shared playhead. When set, it drives " +
                 "this renderer (PlayUrl/Seek/StopVideo) and this renderer reports playback events back to it. Optional: " +
                 "with no jukebox, the renderer falls back to looping its inspector 'url'.")]
        public Jukebox jukebox;

        [Tooltip("Standalone fallback URL, used ONLY when no Jukebox is assigned. A YouTube/Twitch/etc. page " +
                 "URL (resolved client-side) or a direct .mp4/.m3u8 stream. Set in the inspector - VRChat only lets URLs " +
                 "be created in the editor or via a VRCUrlInputField, never built from a string at runtime.")]
        public VRCUrl url;

        [Tooltip("The shared video material (OpenSlope/VideoScreen). The VRCAVProVideoScreen writes the live frame into its " +
                 "_MainTex; this script assigns it to every screen quad under 'screensRoot'.")]
        public Material screenMaterial;

        [Tooltip("Container whose child quads are the billboard screens. Drag Screen_* quads from the Billboards " +
                 "catalog under here; each gets the shared video material. They're only shown while a video is playing - " +
                 "with nothing playing the quads stay hidden and the player sees the original SSX billboards.")]
        public Transform screensRoot;

        [Tooltip("Base seconds to wait before retrying after a TRANSIENT video error (network/codec/rate-limit). " +
                 "AccessDenied waits 2x this (it usually means a settings/restriction problem hammering won't fix, and " +
                 "re-running the YouTube resolver each retry can trip VRChat's video rate-limit). InvalidURL isn't retried.")]
        public float retrySeconds = 15f;

        [Header("Music ducking (video audio wins)")]
        [Tooltip("The start-area background-theme director to silence while a video plays. Optional - leave empty " +
                 "to leave the background music alone.")]
        public MusicDirector musicDirector;

        [Tooltip("The race-music (PathFinder) director to silence while a video plays. Optional.")]
        public RaceMusicDirector raceMusicDirector;

        [Tooltip("Where the music ducks TO while a video is on, 0..1 (0 = silent; the video audio wins). A small " +
                 "value like 0.1 leaves a faint music bed under the video.")]
        public float musicDuckTo = 0f;

        [Tooltip("Seconds to fade the music down when a video starts and back up when it stops.")]
        public float duckFadeSeconds = 1f;

        // A video is MEANT to be sounding (so the music stays ducked). Set true by PlayUrl, false by StopVideo; stays true
        // through transient errors/retries so the music doesn't pop back in during a reconnect.
        private bool _videoActive;
        private float _musicDuck = 1f;   // smoothed 1 -> musicDuckTo while a video plays; written to both directors

        // Guard so only ONE retry is ever scheduled at a time. A failing PlayURL can raise OnVideoError repeatedly, and
        // each delayed retry can fail again - without this they stack into a runaway storm of yt-dlp resolves (which then
        // trips the rate-limit and never recovers). One in-flight retry, cleared when it fires, keeps a steady cadence.
        private bool _retryPending;

        // The URL currently loaded into the player (set by PlayUrl, or the inspector url in the standalone fallback). Kept
        // so RetryPlayback re-issues the SAME url rather than reverting to the inspector field.
        private VRCUrl _current;

        void Start()
        {
            AssignMaterial();   // every screen quad references the one shared video material (whether shown or not)
            // The jukebox (if any) drives playback - it will call PlayUrl from its own Start/OnDeserialization once it knows
            // the synced now-playing video. So here we only start the STANDALONE fallback (no jukebox + an inspector url).
            if (jukebox == null && HasUrl(url))
            {
                PlayUrl(url);
            }
            else
            {
                HideScreens();   // nothing playing yet -> the video quads stay hidden, so the player sees the billboards
            }
        }

        // Smoothly duck the music while a video is sounding, restore it when none is. Driven here (not at the play/stop
        // calls) so it eases instead of snapping, and survives transient retries. Local-only, like the directors themselves.
        void Update()
        {
            if (musicDirector == null && raceMusicDirector == null) return;
            float target = _videoActive ? Mathf.Clamp01(musicDuckTo) : 1f;
            _musicDuck = Mathf.MoveTowards(_musicDuck, target, Time.deltaTime / Mathf.Max(0.05f, duckFadeSeconds));
            if (musicDirector != null) musicDirector.videoDuck = _musicDuck;
            if (raceMusicDirector != null) raceMusicDirector.externalDuck = _musicDuck;
        }

        // ---- the playback API the Jukebox (Jukebox) drives ------------------------------------------------

        // Load + play a URL onto the screens. Reveals the quads and ducks the music (the video audio wins). The jukebox calls
        // this for the now-playing video; a fresh PlayURL restarts the decode from 0 (the jukebox then Seeks to the shared
        // playhead in OnVideoReady so a late joiner lands at the right spot).
        public void PlayUrl(VRCUrl u)
        {
            if (player == null || !HasUrl(u)) return;
            _current = u;
            _retryPending = false;   // a deliberate (re)load supersedes any pending retry of the old url
            ShowScreens();
            player.PlayURL(u);
            _videoActive = true;
        }

        // Stop the decode + hide the emissive quads (the original SSX billboards return) and let the music swell back. The
        // jukebox calls this when the queue empties / playback is cleared. A real saving: a playing video is the single most
        // expensive thing in the world, so a player who hides the screens for framerate gets the whole decode back.
        public void StopVideo()
        {
            if (player != null) player.Stop();
            HideScreens();
            _videoActive = false;
            _current = null;
        }

        public float CurrentTime() { return player != null ? player.GetTime() : 0f; }
        public float Duration()    { return player != null ? player.GetDuration() : 0f; }
        public bool  IsPlaying()   { return player != null && player.IsPlaying; }

        // Jump the local decode to t seconds (the jukebox's shared-playhead sync + the scrub bar both seek through here).
        public void Seek(float t)
        {
            if (player == null) return;
            if (t < 0f) t = 0f;
            player.SetTime(t);
        }

        private bool HasUrl(VRCUrl u) { return u != null && !string.IsNullOrEmpty(u.Get()); }

        // ---- screens ------------------------------------------------------------------------------------------------

        // Point every screen quad at the one shared video material (the VRCAVProVideoScreen writes the live frame into it).
        // Active state is handled separately by Show/HideScreens, so this is safe to call before they're revealed.
        private void AssignMaterial()
        {
            if (screensRoot == null || screenMaterial == null) return;
            MeshRenderer[] rends = screensRoot.GetComponentsInChildren<MeshRenderer>(true);
            foreach (MeshRenderer r in rends)
            {
                if (r != null) r.sharedMaterial = screenMaterial;
            }
        }

        public void ShowScreens() { SetScreensActive(true); }
        public void HideScreens() { SetScreensActive(false); }

        private void SetScreensActive(bool on)
        {
            if (screensRoot == null) return;
            MeshRenderer[] rends = screensRoot.GetComponentsInChildren<MeshRenderer>(true);
            foreach (MeshRenderer r in rends)
            {
                if (r != null) r.gameObject.SetActive(on);
            }
        }

        // ---- VRChat video callbacks (fire on this object because the player is here) --------------------------------

        // The jukebox decides what comes next (advance the playhead / pop the next item) - it gates on ownership so only one
        // client advances. With no jukebox we're standalone, so loop the inspector url ourselves.
        public override void OnVideoEnd()
        {
            if (jukebox != null) jukebox.OnRendererVideoEnd();
            else if (HasUrl(_current)) player.PlayURL(_current);
        }

        // Ready to play: the jukebox seeks us to the shared playhead here (you can't SetTime before the stream is ready), so a
        // late joiner / a freshly-loaded item lands at the right offset instead of restarting everyone from 0.
        public override void OnVideoReady()
        {
            if (jukebox != null) jukebox.OnRendererVideoReady();
        }

        public override void OnVideoError(VideoError videoError)
        {
            // A malformed/unsupported URL won't fix itself - don't retry. Tell the jukebox so the OWNER skips to the next
            // item rather than leaving everyone stuck on a dead link.
            if (videoError == VideoError.InvalidURL)
            {
                Debug.LogError("VideoBillboards: InvalidURL - the URL is malformed or unsupported (" +
                               (_current != null ? _current.Get() : "null") + "). Not retrying.");
                if (jukebox != null) jukebox.OnRendererVideoError();
                else _videoActive = false;
                return;
            }

            if (_retryPending) return;   // a retry is already scheduled - never stack delayed calls (avoids the storm)
            _retryPending = true;

            // AccessDenied is usually the viewer's "Allow Untrusted URLs" being off, or an age/region/embed-restricted
            // video - retrying fast won't help and each retry re-runs the resolver, so back off further and explain it.
            bool denied = videoError == VideoError.AccessDenied;
            float delay = denied ? retrySeconds * 2f : retrySeconds;
            string hint = denied
                ? " (enable 'Allow Untrusted URLs' in VRChat settings, or the video is restricted - try another URL)"
                : "";
            Debug.LogError("VideoBillboards: video error " + videoError + hint + " - retrying in " + delay + "s.");
            SendCustomEventDelayedSeconds(nameof(RetryPlayback), delay);
        }

        // Fired by the delayed retry. Clears the guard first so the next failure can schedule exactly one fresh retry.
        public void RetryPlayback()
        {
            _retryPending = false;
            if (HasUrl(_current) && player != null) player.PlayURL(_current);
        }
    }
}
