using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{
    using VRC.SDK3.Components;   // VRCUrlInputField

    // The BRAIN of the video system: a SHARED, NETWORKED video JUKEBOX panel by the start gate. Where
    // VideoBillboards is the local renderer (one AVPro decode painted on every screen), this is the synced controller
    // that everyone shares - one queue, one now-playing video, one playhead. Built + wired by JukeboxSetup
    // ("OpenSlope/Setup/Jukebox"). See docs/vrchat/049.
    //
    // WHAT'S SHARED (sync Manual, owner-authoritative). The whole point: play a video and it plays for EVERYONE; change it
    // and it changes for everyone; scrub the bar and everyone's playhead moves.
    //   - queueUrls/queueOwners/queueNames : the pending queue (parallel arrays - the URL, the playerId who queued it, and
    //                                        their name for the row label). Fair-interleaved on insert (see FairInsert).
    //   - nowUrl/nowOwner/nowName          : the currently-playing video + who queued it.
    //   - nowStart (server seconds)        : the server time at which the current video's t=0 played, so every client seeks
    //                                        to (serverNow - nowStart) and shares ONE playhead (late joiners included).
    //   - nowVersion                       : bumped whenever the current video should (re)load from a fresh decode (a new
    //                                        item / a loop restart). A pure SCRUB only moves nowStart (no version bump), so
    //                                        clients SetTime instead of reloading the whole stream.
    //   - playing                          : is anything playing (false => screens hidden, original billboards show).
    //   - lockMode                         : the 3-way add + seek/skip lock (0 unlocked / 1 queue unlocked / 2 locked; below).
    //
    // OWNERSHIP. Only the object owner may write the synced fields, so every mutation (add / remove / seek / skip / lock)
    // first takes ownership, edits, and RequestSerialization()s. Two people acting in the very same network frame can race
    // (last-writer-wins on the whole bundle) - an add can be lost and need re-entering; harmless for a casual shared world,
    // and not worth per-player objects to make airtight (same trade the Players Board makes). The owner is also the ONE
    // client that advances the queue when a video ends (every client's local decode fires OnVideoEnd, but only the owner
    // pops the next item), so playback can't double-advance.
    //
    // PERMISSIONS - gated by a moderator-cycled LOCK MODE (a gradient from open to moderators-only):
    //   - UNLOCKED      : anyone adds; anyone seeks/skips.
    //   - QUEUE UNLOCKED : anyone adds to the queue, but only the current video's queuer (or a moderator) may seek/skip.
    //   - LOCKED         : moderators only - regular users can't add, seek, or skip.
    //   A "moderator" is the instance owner or the current master; only a moderator can cycle the mode. Removing a QUEUED
    //   item is always its queuer-or-moderator (independent of the mode). When seek/skip is restricted, the scrub bar goes
    //   non-interactable for everyone who isn't allowed.
    //
    // LATE JOINERS get the synced state via OnDeserialization (manual sync delivers the last-serialized values), reload the
    // current video, and seek to the shared playhead - so they drop straight into what the room is watching. A light drift
    // nudge in Update re-aligns a client whose decode has slipped from the shared playhead (buffering, a brief stall).
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)]
    public class Jukebox : UdonSharpBehaviour
    {
        [Header("Renderer + input")]
        [Tooltip("The local AVPro renderer this drives (PlayUrl/Seek/StopVideo + the time/duration readback for the scrub bar).")]
        public VideoBillboards video;

        [Tooltip("The always-active URL input the 'Add video' button focuses; its OnEndEdit -> OnAddSubmitted appends to the queue.")]
        public VRCUrlInputField addField;

        [Header("Now playing UI")]
        [Tooltip("The 'NOW PLAYING' label (title + who queued it).")]
        public Text nowLabel;
        [Tooltip("The scrub bar: fills with playback progress and (when permitted) drags to seek the SHARED playhead.")]
        public Slider seekSlider;
        [Tooltip("The 'm:ss / m:ss' time readout under the scrub bar.")]
        public Text timeLabel;

        [Header("Queue list (paged; parallel arrays, length = page size)")]
        [Tooltip("Each visible queue row's label (rank + URL + who queued it).")]
        public Text[] rowLabels;
        [Tooltip("Each visible row's GameObject (hidden when the page has fewer items).")]
        public GameObject[] rowRoots;
        [Tooltip("Each visible row's [x] remove button (shown only when YOU may remove that item).")]
        public GameObject[] rowRemoveRoots;
        [Tooltip("The 'Page 1/3 · 12 queued' readout.")]
        public Text pageLabel;

        [Header("Controls")]
        [Tooltip("The local 'Show screens (for me)' button label - flips this client's decode on/off for framerate.")]
        public Text screensLabel;
        [Tooltip("The lock button label - shows the seek/skip lock state (only a moderator can flip it).")]
        public Text lockLabel;

        [Tooltip("Maximum pending items in the shared queue (synced data has a budget; this also bounds the round-robin scan).")]
        public int maxQueue = 24;

        [Tooltip("Seconds of playhead drift before a client re-seeks itself onto the shared playhead (buffering tolerance).")]
        public float driftTolerance = 1.5f;

        // ---- the synced (owner-written) state -----------------------------------------------------------------------
        [UdonSynced] private VRCUrl[] queueUrls;
        [UdonSynced] private int[]    queueOwners;   // playerId of whoever queued each item
        [UdonSynced] private string[] queueNames;    // their display name (for the row label)
        [UdonSynced] private VRCUrl   nowUrl;
        [UdonSynced] private int      nowOwner = -1;
        [UdonSynced] private string   nowName = "";
        [UdonSynced] private double   nowStart;      // server seconds at the current video's t=0 (the shared playhead anchor)
        [UdonSynced] private int      nowVersion;    // bumped to force a (re)load; a pure scrub moves nowStart only
        [UdonSynced] private bool     playing;
        // Lock mode, cycled by a moderator (LOCK_* below): a gradient from fully open to moderators-only. Defaults to 0 =
        // unlocked (also dodges the new-field-default gotcha - an un-repushed instance reads 0 = open).
        [UdonSynced] private int      lockMode;

        // ---- local state --------------------------------------------------------------------------------------------
        private VRCPlayerApi _local;
        private int    _page;
        private bool   _seeking;          // the user is dragging the scrub bar (suspend the per-frame fill so we don't fight them)
        private bool   _uiUpdating;       // we're writing seekSlider.value ourselves (so OnSeekChanged ignores it)
        private bool   _localEnabled = true;   // this client's screens on/off (local perf control; doesn't touch synced state)
        private int    _appliedVersion = -1;   // the nowVersion we last (re)loaded into the renderer
        private string _appliedUrl = "";       // the url string we last loaded (guard against redundant reloads)
        private double _appliedStart;          // the nowStart we last applied (detect a pure scrub)
        private float  _pendingSeek;           // seconds to seek to once the freshly-loaded stream reports ready
        private float  _nextDrift;             // next time (server seconds) we're allowed to drift-correct

        // The three lock modes (synced as `lockMode`), most open -> most restricted:
        private const int LOCK_OPEN  = 0;   // unlocked: anyone adds, anyone seeks/skips
        private const int LOCK_QUEUE = 1;   // queue unlocked: anyone adds to the queue, but only the current video's queuer/moderator seeks/skips
        private const int LOCK_FULL  = 2;   // locked: moderators only - regular users can't add, seek, or skip

        // A smooth server clock (anchor once, advance by local time, ease out drift) so the shared playhead is steady -
        // mirrors RideableBoard.ServerNow. Sampling Networking.GetServerTimeInSeconds raw jitters frame to frame.
        private double _clock;
        private bool   _clockSet;
        private int    _clockFrame;

        void Start()
        {
            _local = Networking.LocalPlayer;
            if (queueUrls == null)   queueUrls = new VRCUrl[0];
            if (queueOwners == null) queueOwners = new int[0];
            if (queueNames == null)  queueNames = new string[0];
            if (nowUrl == null)      nowUrl = VRCUrl.Empty;
            // The owner-at-spawn (first in / master) has nothing to load yet; a non-owner gets the real state via the
            // OnDeserialization that manual sync delivers right after Start. Either way, paint the UI from what we have.
            LoadCurrent();
            RebuildUI();
            SendCustomEventDelayedSeconds(nameof(UiTick), 0.1f);
        }

        // Re-broadcast for a freshly-joined client so they reliably receive the queue + playhead (manual sync already
        // delivers last-serialized values to late joiners, but a nudge from the owner covers the edge cases).
        public override void OnPlayerJoined(VRCPlayerApi player)
        {
            if (player != null && !player.isLocal && Networking.IsOwner(gameObject)) RequestSerialization();
        }

        // A fresh synced bundle arrived. Reload the current video if it changed (new item / loop restart -> nowVersion
        // bumped), or just re-seek if only the playhead moved (someone scrubbed). Then repaint the list + lock + page.
        public override void OnDeserialization()
        {
            if (_local == null) _local = Networking.LocalPlayer;
            if (nowVersion != _appliedVersion)
            {
                LoadCurrent();                                   // new video or replay -> reload the decode + seek to the playhead
            }
            else if (playing && _localEnabled)
            {
                double d = nowStart - _appliedStart; if (d < 0d) d = -d;
                if (d > 0.25)                                    // a pure scrub: jump our local decode without reloading the stream
                {
                    _appliedStart = nowStart;
                    float t = (float)(ServerNow() - nowStart);
                    if (t < 0f) t = 0f;
                    video.Seek(t);
                }
            }
            RebuildUI();
        }

        // SELF-SCHEDULED ~10 Hz UI loop: a scrub bar doesn't need a per-frame canvas rebuild, and a delayed-event loop
        // costs 10 dispatches/s where a per-frame Update pays the interpreted per-behaviour dispatch 72+ times - exactly
        // the Udon cost that matters on Quest. The drift check below keeps its own 2 s throttle on top. Seeking is
        // event-driven (grab/release), unaffected. Delayed events fire even on a disabled behaviour -> immortal loop.
        public void UiTick()
        {
            SendCustomEventDelayedSeconds(nameof(UiTick), 0.1f);
            if (video == null || seekSlider == null) return;

            // Paint the scrub bar from the local decode (unless the user is dragging it). Local + cheap.
            {
                float dur = video.Duration();
                float cur = video.CurrentTime();
                if (!_seeking)
                {
                    float frac = dur > 0.01f ? Mathf.Clamp01(cur / dur) : 0f;
                    _uiUpdating = true;
                    seekSlider.value = frac;
                    _uiUpdating = false;
                    if (timeLabel != null) timeLabel.text = (playing ? Fmt(cur) + " / " + Fmt(dur) : "—");
                }

                // Drift nudge: if our decode has slipped from the shared playhead (buffering / a stall), re-seek onto it.
                // Throttled, and only well inside the clip so we don't fight the end-of-video -> advance handoff.
                if (playing && _localEnabled && !_seeking && video.IsPlaying() && dur > 0.01f)
                {
                    double now = ServerNow();
                    if (now >= _nextDrift)
                    {
                        _nextDrift = (float)now + 2f;
                        float expected = (float)(now - nowStart);
                        if (expected >= 0f && expected < dur - 0.75f && Mathf.Abs(cur - expected) > driftTolerance)
                            video.Seek(expected);
                    }
                }
            }
        }

        // ---- add / remove -------------------------------------------------------------------------------------------

        // The add field's OnEndEdit lands here: take the entered URL, and either start it now (nothing playing) or
        // fair-insert it into the queue. A real VRCUrl can only come from this field (you can't build one from a string at
        // runtime), which is exactly why every queued item carries a genuine VRCUrl ready to play when it's popped.
        public void OnAddSubmitted()
        {
            if (addField == null) return;
            VRCUrl entered = addField.GetUrl();
            ClearAddField();
            if (entered == null || string.IsNullOrEmpty(entered.Get())) return;
            if (_local == null) _local = Networking.LocalPlayer;
            if (_local == null) return;
            if (!CanAdd()) return;   // LOCKED mode: only moderators may add (the field's already cleared above)
            if (Count() >= maxQueue) { Debug.LogWarning("Jukebox: queue full (" + maxQueue + ") - not adding."); return; }

            TakeOwnership();
            int myId = _local.playerId;
            string myName = _local.displayName;
            if (!playing)
            {
                // Nothing playing -> this becomes the now-playing video straight away.
                nowUrl = entered; nowOwner = myId; nowName = myName;
                playing = true; nowStart = ServerNow(); nowVersion++;
                RequestSerialization();
                LoadCurrent();
            }
            else
            {
                FairInsert(entered, myId, myName);
                RequestSerialization();
            }
            RebuildUI();
        }

        // Remove the queued item shown in visible row `slot` of the current page. Permission: its queuer, or a moderator.
        public void RemoveSlot(int slot)
        {
            int idx = _page * VisibleRows() + slot;
            if (idx < 0 || idx >= Count()) return;
            if (!CanRemove(idx)) return;
            TakeOwnership();
            RemoveAt(idx);
            ClampPage();
            RequestSerialization();
            RebuildUI();
        }

        public void PagePrev() { if (_page > 0) { _page--; RebuildUI(); } }
        public void PageNext() { if (_page < PageCount() - 1) { _page++; RebuildUI(); } }

        // ---- seek / skip / lock -------------------------------------------------------------------------------------

        // EventTrigger PointerDown/PointerUp on the scrub bar mark the start/end of a user drag, so the per-frame fill in
        // Update steps aside while the user is scrubbing and we commit the seek once, on release (not on every drag frame).
        public void OnSeekGrab()    { if (CanSeek()) _seeking = true; }
        public void OnSeekRelease()
        {
            if (!_seeking) return;
            _seeking = false;
            if (seekSlider != null) CommitSeek(seekSlider.value);
        }

        // While dragging, preview the target time in the readout (no network traffic until release).
        public void OnSeekChanged()
        {
            if (_uiUpdating || !_seeking || timeLabel == null || video == null) return;
            float dur = video.Duration();
            timeLabel.text = Fmt(seekSlider.value * dur) + " / " + Fmt(dur);
        }

        // Move the SHARED playhead to frac of the duration: re-anchor nowStart and broadcast (no version bump, so other
        // clients SetTime rather than reloading the whole stream). Local decode jumps immediately for snappy feedback.
        private void CommitSeek(float frac)
        {
            if (!CanSeek() || video == null) { RebuildUI(); return; }
            float dur = video.Duration();
            if (dur <= 0.01f) return;
            float t = Mathf.Clamp01(frac) * dur;
            TakeOwnership();
            nowStart = ServerNow() - t;
            _appliedStart = nowStart;
            RequestSerialization();
            if (_localEnabled) video.Seek(t);
        }

        // Skip the current video: pop the next queued item (or, with an empty queue, restart the current one). Same
        // permission as seeking.
        public void Skip()
        {
            if (!CanSeek()) return;
            TakeOwnership();
            AdvanceNow(true);
        }

        // Cycle the lock mode: Unlocked -> Queue unlocked -> Locked -> Unlocked. Moderators only (instance owner / master).
        public void CycleLock()
        {
            if (!IsModerator()) return;
            TakeOwnership();
            lockMode = (lockMode + 1) % 3;
            RequestSerialization();
            RebuildUI();
        }

        // Local-only: turn THIS client's screens (the AVPro decode) on/off for framerate. Off stops the decode + hides the
        // quads (the single most expensive thing in the world); on reloads the current video and seeks back onto the shared
        // playhead. Touches no synced state - everyone else keeps watching.
        public void ToggleLocalScreens()
        {
            _localEnabled = !_localEnabled;
            if (_localEnabled) LoadCurrent();
            else if (video != null) video.StopVideo();
            RebuildUI();
        }

        // ---- renderer callbacks (only the owner advances) -----------------------------------------------------------

        public void OnRendererVideoEnd()
        {
            if (!Networking.IsOwner(gameObject)) return;   // every client's decode ends; only the owner pops the next item
            AdvanceNow(true);                              // empty queue -> loop the current so the screens stay alive
        }

        // The freshly-loaded stream is ready: seek it to where the shared playhead has moved to since we issued the load
        // (covers a late joiner dropping into the middle of a video).
        public void OnRendererVideoReady()
        {
            if (_pendingSeek > 0.5f && video != null) video.Seek(_pendingSeek);
            _pendingSeek = 0f;
        }

        // The current URL is dead (InvalidURL): the owner drops it and moves on - next item, or stop if the queue's empty
        // (don't loop a broken link).
        public void OnRendererVideoError()
        {
            if (!Networking.IsOwner(gameObject)) return;
            AdvanceNow(false);
        }

        // ---- playback advance + load --------------------------------------------------------------------------------

        // Owner-authoritative: move to the next video. Pops queue[0] into now-playing; with an empty queue either loops the
        // current (allowReplay, the natural end-of-video case) or stops (a dead link / nothing to play). Bumps nowVersion so
        // every client reloads, re-anchors the playhead to now, broadcasts, and reloads locally.
        private void AdvanceNow(bool allowReplay)
        {
            if (Count() > 0)
            {
                nowUrl = queueUrls[0]; nowOwner = queueOwners[0]; nowName = queueNames[0];
                RemoveAt(0);
                playing = true;
            }
            else if (allowReplay && playing && HasUrl(nowUrl))
            {
                // keep nowUrl/owner/name; just restart it
            }
            else
            {
                playing = false;
            }
            nowStart = ServerNow();
            nowVersion++;
            ClampPage();
            RequestSerialization();
            LoadCurrent();
            RebuildUI();
        }

        // Load the synced now-playing video into the local renderer and arm the seek-to-playhead (applied on ready). With
        // the screens turned off locally, or nothing playing, it just stops the decode.
        private void LoadCurrent()
        {
            _appliedVersion = nowVersion;
            _appliedUrl = (playing && nowUrl != null) ? nowUrl.Get() : "";
            _appliedStart = nowStart;
            if (video == null) return;
            if (!_localEnabled || !playing || !HasUrl(nowUrl)) { video.StopVideo(); return; }
            float seek = (float)(ServerNow() - nowStart);
            if (seek < 0f) seek = 0f;
            _pendingSeek = seek;       // applied in OnRendererVideoReady (you can't SetTime before the stream is ready)
            video.PlayUrl(nowUrl);
        }

        // ---- fair-interleave insert ---------------------------------------------------------------------------------

        // Insert a new item so the queue stays ROUND-ROBIN fair: a player's Nth video plays in the Nth round. A first-time
        // adder's item joins the END of round 1 (after everyone else's first), NOT behind someone who already stacked a
        // second video. Concretely, with queue A B C B and D adding: A B C [D] B. The new item's round = 1 + how many it's
        // owner already has queued; we insert it before the first existing item whose round exceeds that. The queue is kept
        // sorted by round, so this single insert preserves the invariant. n <= maxQueue, so the O(n^2) round scan is tiny.
        private void FairInsert(VRCUrl u, int ownerId, string name)
        {
            int n = queueUrls.Length;
            int newRound = 1 + CountOwner(queueOwners, ownerId, n);
            int insertAt = n;
            for (int i = 0; i < n; i++)
            {
                int roundI = CountOwner(queueOwners, queueOwners[i], i + 1);   // occurrences of this owner in [0..i]
                if (roundI > newRound) { insertAt = i; break; }
            }

            VRCUrl[] nu = new VRCUrl[n + 1];
            int[]    no = new int[n + 1];
            string[] nm = new string[n + 1];
            for (int i = 0; i < insertAt; i++) { nu[i] = queueUrls[i]; no[i] = queueOwners[i]; nm[i] = queueNames[i]; }
            nu[insertAt] = u; no[insertAt] = ownerId; nm[insertAt] = name;
            for (int i = insertAt; i < n; i++) { nu[i + 1] = queueUrls[i]; no[i + 1] = queueOwners[i]; nm[i + 1] = queueNames[i]; }
            queueUrls = nu; queueOwners = no; queueNames = nm;
        }

        // Occurrences of `id` in arr[0..upto-1].
        private int CountOwner(int[] arr, int id, int upto)
        {
            int c = 0;
            for (int i = 0; i < upto && i < arr.Length; i++) if (arr[i] == id) c++;
            return c;
        }

        private void RemoveAt(int idx)
        {
            int n = queueUrls.Length;
            if (idx < 0 || idx >= n) return;
            VRCUrl[] nu = new VRCUrl[n - 1];
            int[]    no = new int[n - 1];
            string[] nm = new string[n - 1];
            int k = 0;
            for (int i = 0; i < n; i++)
            {
                if (i == idx) continue;
                nu[k] = queueUrls[i]; no[k] = queueOwners[i]; nm[k] = queueNames[i]; k++;
            }
            queueUrls = nu; queueOwners = no; queueNames = nm;
        }

        // ---- UI -----------------------------------------------------------------------------------------------------

        private void RebuildUI()
        {
            // Now-playing line.
            if (nowLabel != null)
            {
                if (playing && HasUrl(nowUrl))
                    nowLabel.text = "<b>" + Short(nowUrl, 40) + "</b>\n<size=20>queued by " + Safe(nowName) + "</size>";
                else
                    nowLabel.text = "<b>Nothing playing</b>\n<size=20>press ▶ Add video</size>";
            }

            // The scrub bar is only draggable for those allowed to seek right now (open, or the queuer/moderator when locked).
            if (seekSlider != null) seekSlider.interactable = CanSeek();

            // Paged queue rows.
            int vis = VisibleRows();
            int total = Count();
            for (int i = 0; i < vis; i++)
            {
                int idx = _page * vis + i;
                bool has = idx < total;
                if (rowRoots != null && i < rowRoots.Length && rowRoots[i] != null && rowRoots[i].activeSelf != has)
                    rowRoots[i].SetActive(has);
                if (rowLabels != null && i < rowLabels.Length && rowLabels[i] != null)
                    rowLabels[i].text = has ? ((idx + 1) + ".  " + Short(queueUrls[idx], 32) + "   · " + Safe(queueNames[idx])) : "";
                // The [x] remove button shows only when YOU may remove this row (its queuer, or a moderator).
                bool canRm = has && CanRemove(idx);
                if (rowRemoveRoots != null && i < rowRemoveRoots.Length && rowRemoveRoots[i] != null && rowRemoveRoots[i].activeSelf != canRm)
                    rowRemoveRoots[i].SetActive(canRm);
            }

            if (pageLabel != null)
            {
                if (total == 0) pageLabel.text = "queue empty";
                else pageLabel.text = "Page " + (_page + 1) + "/" + PageCount() + "   ·   " + total + " queued";
            }

            if (screensLabel != null) screensLabel.text = _localEnabled ? "Screens: ON (for me)" : "Screens: OFF (for me)";
            if (lockLabel != null)
            {
                if (lockMode == LOCK_QUEUE)     lockLabel.text = "🔐 Queue unlocked";   // add freely; queuer/owner controls playback
                else if (lockMode == LOCK_FULL) lockLabel.text = "🔒 Locked";            // moderators only
                else                            lockLabel.text = "🔓 Unlocked";          // anyone adds + controls
            }
        }

        // ---- permissions + helpers ----------------------------------------------------------------------------------

        private bool IsModerator()
        {
            if (_local == null) _local = Networking.LocalPlayer;
            return _local != null && (_local.isInstanceOwner || Networking.IsMaster);
        }

        // Add to the queue: open in UNLOCKED + QUEUE-UNLOCKED; moderators-only in LOCKED.
        private bool CanAdd()
        {
            return lockMode != LOCK_FULL || IsModerator();
        }

        // Seek / skip the current video: open in UNLOCKED; restricted to the current video's queuer or a moderator in
        // QUEUE-UNLOCKED + LOCKED.
        private bool CanSeek()
        {
            if (lockMode == LOCK_OPEN) return true;
            if (_local == null) _local = Networking.LocalPlayer;
            return (_local != null && nowOwner == _local.playerId) || IsModerator();
        }

        private bool CanRemove(int idx)
        {
            if (_local == null) _local = Networking.LocalPlayer;
            if (idx < 0 || idx >= queueOwners.Length) return false;
            return (_local != null && queueOwners[idx] == _local.playerId) || IsModerator();
        }

        private void TakeOwnership()
        {
            if (_local == null) _local = Networking.LocalPlayer;
            if (_local != null && !Networking.IsOwner(gameObject)) Networking.SetOwner(_local, gameObject);
        }

        private void ClearAddField() { if (addField != null) addField.SetUrl(VRCUrl.Empty); }

        private int Count() { return queueUrls != null ? queueUrls.Length : 0; }
        private int VisibleRows() { return rowLabels != null ? rowLabels.Length : 0; }
        private int PageCount()
        {
            int vis = VisibleRows();
            if (vis <= 0) return 1;
            int pc = (Count() + vis - 1) / vis;
            return pc < 1 ? 1 : pc;
        }
        private void ClampPage()
        {
            int pc = PageCount();
            if (_page >= pc) _page = pc - 1;
            if (_page < 0) _page = 0;
        }

        private bool HasUrl(VRCUrl u) { return u != null && !string.IsNullOrEmpty(u.Get()); }

        private string Safe(string s) { return string.IsNullOrEmpty(s) ? "?" : s; }

        // A compact display form of a URL: trimmed of the scheme, capped to `max` chars with a trailing ellipsis.
        private string Short(VRCUrl u, int max)
        {
            if (u == null) return "";
            string s = u.Get();
            if (string.IsNullOrEmpty(s)) return "";
            if (s.StartsWith("https://")) s = s.Substring(8);
            else if (s.StartsWith("http://")) s = s.Substring(7);
            if (s.Length > max) s = s.Substring(0, max - 1) + "…";
            return s;
        }

        // Seconds -> "m:ss".
        private string Fmt(float seconds)
        {
            if (!(seconds > 0f) || seconds > 359999f) return "0:00";   // also catches NaN (NaN > 0 is false) + Infinity
            int total = (int)seconds;
            int m = total / 60;
            int s = total % 60;
            return m + ":" + (s < 10 ? "0" + s : "" + s);
        }

        // Smooth server clock (see field note): anchor once, advance by local time, ease out the drift, snap on a big stall.
        private double ServerNow()
        {
            double real = Networking.GetServerTimeInSeconds();
            if (!_clockSet) { _clock = real; _clockFrame = Time.frameCount; _clockSet = true; return _clock; }
            if (Time.frameCount != _clockFrame)
            {
                _clockFrame = Time.frameCount;
                _clock += (double)Time.deltaTime;
                double err = real - _clock;
                if (err > 0.5 || err < -0.5) _clock = real;
                else _clock += err * 0.05;
            }
            return _clock;
        }
    }
}
