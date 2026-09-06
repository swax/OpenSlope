using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // The in-world PLAYERS BOARD: a panel by the start gate, in the middle of the board row, between the Settings and
    // Jukebox panels. It lists everyone in the instance and lets you WARP to any of them with a
    // look-and-Use, plus a single "Hide me on the board" checkbox that takes YOU off everyone else's list (so people can't
    // teleport to you). Built + wired by PlayersBoardSetup ("OpenSlope/Setup/Players Board"). See docs/vrchat/048.
    //
    // MOSTLY LOCAL, ONE NETWORKED BIT. The list itself + the teleport are pure-local (each client enumerates VRChat's own
    // player list and teleports its own avatar). The ONE thing that has to cross the wire is the hidden set: when you hide
    // yourself, every OTHER client must drop you from its list - so this behaviour is sync MANUAL with a single synced
    // `hiddenIds` (the player-ids that have hidden themselves). Toggling "hide me" takes ownership of this object, edits the
    // set, and RequestSerialization()s it to everyone; each client filters its list against the set it last received. Two
    // people toggling in the very same network frame can race (last-writer-wins on the whole array), which only means a
    // hidden player might have to re-tick the box - harmless for a cosmetic convenience, so we don't pay for per-player
    // objects to make it airtight. OnDeserialization self-heals the local checkbox from the authoritative set.
    //
    // SCROLLING = PAGING. VRChat's world-space UI laser doesn't reliably drive a Canvas widget in-world (the same lesson
    // the sibling boards learned), and a drag-scrolled ScrollRect is even less reliable - so the "scrollable list" is a
    // fixed stack of `rowLabels.Length` visible rows (8) paged with look-and-Use ◀ Prev / Next ▶ buttons. Every interactive
    // element (a player row, a nav button, the hide checkbox) is a PlayersButton: a BoxCollider + Interact that calls
    // back here.
    //
    // RACE STANDINGS. Each row also shows that player's live DISTANCE-TO-FINISH and the list is sorted by it (leader first).
    // This is FREE networking-wise: VRChat already syncs every avatar's position, so each client reads GetPosition() for all
    // players and projects it onto the course (coursePath.QueryProgress, the authored DTF metric - docs/050) locally - no
    // [UdonSynced] heartbeat. Standings re-rank on a throttle (refreshInterval); the heavier membership rebuild still only
    // runs on join/leave/hide. Every player gets a DTF (nearest race-line point) wherever they are on the mountain - riding
    // or on foot, on the line or off; '-' shows only when there's no course path baked.
    [UdonBehaviourSyncMode(BehaviourSyncMode.Manual)]
    public class PlayersBoard : UdonSharpBehaviour
    {
        [Header("Visible player rows (parallel arrays, length = page size) - built by the setup")]
        [Tooltip("The label Text on each visible row (shows a player's name, blank when the page has fewer).")]
        public Text[] rowLabels;
        [Tooltip("Each visible row's GameObject (SetActive(false) on empty slots so they carry no stray Interact).")]
        public GameObject[] rowRoots;

        [Header("Controls")]
        [Tooltip("The 'Hide me on the board' checkbox (drives the checkmark; the synced hidden set is the real state).")]
        public Toggle hideToggle;
        [Tooltip("The page / count readout under the list ('Page 1/3  ·  12 players').")]
        public Text pageText;

        [Header("Warp")]
        [Tooltip("How far in front of the target player you arrive (m), facing back at them so you're looking at each other.")]
        public float arriveDistance = 2.0f;

        [Header("Race standings (distance-to-finish)")]
        [Tooltip("The course-progress network (RailNetwork on OpenSlope_Map/CoursePath). Wired by setup; null = no DTF column.")]
        public RailNetwork coursePath;
        [Tooltip("Per-row right-aligned DTF text ('1,240m'). Parallel to rowLabels; built by setup.")]
        public Text[] rowDtf;
        [Tooltip("How often (s) the standings re-compute everyone's DTF + re-sort. Local-only + cheap, but 2s is plenty for a " +
                 "standings board - no need to re-rank every frame.")]
        public float refreshInterval = 2.0f;

        // The ONE networked field: the player-ids who have hidden themselves. Manual sync delivers it to late joiners too,
        // so a fresh client filters correctly from its first rebuild. Edited only by the owner (whoever last toggled hide).
        [UdonSynced] private int[] hiddenIds;

        private VRCPlayerApi[] _listed;   // the current filtered+sorted list (fixed buffer; only [0.._listedCount) is live)
        private float[] _dtf;             // parallel: each listed player's distance-to-finish (m); +inf = off the race line
        private int _listedCount;
        private int _page;                // 0-based page index into _listed
        private bool _hiddenLocal;        // my own checkbox intent (mirrors my membership in hiddenIds)
        private VRCPlayerApi _local;

        void Start()
        {
            _local = Networking.LocalPlayer;
            if (hiddenIds == null) hiddenIds = new int[0];
            _listed = new VRCPlayerApi[88];   // generous fixed buffer (VRChat instances cap well under this)
            _dtf = new float[88];
            RebuildAndRefresh();
            // Standings re-rank on a SELF-SCHEDULED loop at refreshInterval (no coursePath baked = no DTF column, so no
            // periodic work at all - membership repaints stay event-driven via join/leave/hide/deserialization). A
            // delayed-event loop instead of a per-frame Update: the interpreted per-behaviour dispatch is exactly the
            // per-frame Udon cost Quest pays for, and a standings board needs half-a-hertz, not frame rate.
            if (coursePath != null) SendCustomEventDelayedSeconds(nameof(StandingsTick), Mathf.Max(0.25f, refreshInterval));
        }

        // Re-rank the standings each tick. DTF is purely LOCAL: VRChat already syncs every player's avatar position, so we
        // read GetPosition() for everyone and project it onto the course (coursePath.QueryProgress) - no networked heartbeat.
        // Cheap (N players x one grid query, every couple of seconds); the heavier membership rebuild also runs on join/leave/hide.
        public void StandingsTick()
        {
            SendCustomEventDelayedSeconds(nameof(StandingsTick), Mathf.Max(0.25f, refreshInterval));
            RebuildAndRefresh();
        }

        // Membership changes: relist (a new face to show / a departed one to drop). OnPlayerLeft also lets the owner prune
        // the leaver's id from the hidden set so it can't grow without bound over a long-lived instance.
        public override void OnPlayerJoined(VRCPlayerApi player) { RebuildAndRefresh(); }
        public override void OnPlayerLeft(VRCPlayerApi player)
        {
            if (player != null && Networking.IsOwner(gameObject) && Contains(hiddenIds, player.playerId))
            {
                hiddenIds = WithoutId(hiddenIds, player.playerId);
                RequestSerialization();
            }
            RebuildAndRefresh();
        }

        // A new hidden set arrived from the owner. Self-heal my own checkbox from the authoritative set (covers the rare
        // same-frame toggle race), then re-filter the list against it.
        public override void OnDeserialization()
        {
            if (hiddenIds == null) hiddenIds = new int[0];
            if (_local == null) _local = Networking.LocalPlayer;
            if (_local != null) SetHideVisual(Contains(hiddenIds, _local.playerId));
            RebuildAndRefresh();
        }

        // ---- the PlayersButton callbacks ------------------------------------------------------------------------

        // Warp to the player shown in visible slot `slot` on the current page. Reads the target's pose FRESH (so you land on
        // where they are now, not where they were when the list was built): stand `arriveDistance` metres IN FRONT of them
        // along their flat heading, facing back at them, so you arrive looking at each other. A stale slot (they just left)
        // relists.
        public void _TeleportToSlot(int slot)
        {
            int idx = _page * VisibleRows() + slot;
            if (idx < 0 || idx >= _listedCount) return;
            VRCPlayerApi p = _listed[idx];
            if (!Utilities.IsValid(p)) { RebuildAndRefresh(); return; }
            if (_local == null) _local = Networking.LocalPlayer;
            if (_local == null) return;

            Vector3 pos = p.GetPosition();
            Vector3 fwd = p.GetRotation() * Vector3.forward;   // flatten to yaw so a banked snowboarder's tilt doesn't aim you up/down
            fwd.y = 0f;
            fwd = fwd.sqrMagnitude > 1e-4f ? fwd.normalized : Vector3.forward;
            _local.TeleportTo(pos + fwd * arriveDistance, Quaternion.LookRotation(-fwd, Vector3.up));
        }

        public void _PagePrev() { if (_page > 0) { _page--; RefreshRows(); } }
        public void _PageNext() { if (_page < PageCount() - 1) { _page++; RefreshRows(); } }

        // Flip my "hide me" state, update the checkmark, and publish the new hidden set to everyone.
        public void _ToggleHide()
        {
            SetHideVisual(!_hiddenLocal);
            PublishHide();
        }

        // ---- hidden-set publish + list build -----------------------------------------------------------------------

        // Become the owner (so we may write the synced field), fold my id into / out of the LATEST hidden set we hold, and
        // broadcast it. Editing the last-received array means sequential toggles by different people compose; only a true
        // same-frame collision can clobber (see the header note). The local list excludes me anyway, so this is about how
        // OTHERS see me - we still rebuild locally to stay consistent.
        private void PublishHide()
        {
            if (_local == null) _local = Networking.LocalPlayer;
            if (_local == null) return;
            if (!Networking.IsOwner(gameObject)) Networking.SetOwner(_local, gameObject);
            int myId = _local.playerId;
            hiddenIds = _hiddenLocal ? WithId(hiddenIds, myId) : WithoutId(hiddenIds, myId);
            RequestSerialization();
            RebuildAndRefresh();
        }

        private void SetHideVisual(bool on)
        {
            _hiddenLocal = on;
            if (hideToggle != null && hideToggle.isOn != on) hideToggle.isOn = on;   // no onValueChanged listener wired -> no re-entry
        }

        private void RebuildAndRefresh() { RebuildList(); RefreshRows(); }

        // Re-enumerate VRChat's player list into _listed: skip myself (you can't warp to you), skip anyone in the hidden
        // set, and keep a STABLE order (insertion-sort by playerId) so rows don't jump around as people come and go. Clamps
        // the page in case the list shrank under it. Allocations here are fine - this runs on join/leave/hide, not per frame.
        private void RebuildList()
        {
            _listedCount = 0;
            if (_local == null) _local = Networking.LocalPlayer;
            int n = VRCPlayerApi.GetPlayerCount();
            if (n < 0) n = 0;
            if (_listed == null || _listed.Length < n) _listed = new VRCPlayerApi[n + 8];
            if (_dtf == null || _dtf.Length < _listed.Length) _dtf = new float[_listed.Length];
            VRCPlayerApi[] all = new VRCPlayerApi[n];
            all = VRCPlayerApi.GetPlayers(all);
            for (int i = 0; i < all.Length; i++)
            {
                VRCPlayerApi p = all[i];
                if (!Utilities.IsValid(p)) continue;
                if (p.isLocal) continue;
                if (Contains(hiddenIds, p.playerId)) continue;
                float d = ProgressDtf(p);   // distance-to-finish (m), +inf when off the race line / no course path
                // insertion sort: leader (lowest DTF) first, off-course (+inf) sinks to the bottom; ties by playerId (stable).
                int j = _listedCount;
                while (j > 0 && RanksAfter(_dtf[j - 1], _listed[j - 1].playerId, d, p.playerId))
                { _listed[j] = _listed[j - 1]; _dtf[j] = _dtf[j - 1]; j--; }
                _listed[j] = p; _dtf[j] = d;
                _listedCount++;
            }
            int pc = PageCount();
            if (_page >= pc) _page = pc - 1;
            if (_page < 0) _page = 0;
        }

        // Does (dtfA, idA) rank AFTER (dtfB, idB)? Lower DTF wins (closer to the finish); ties broken by playerId for stability.
        private bool RanksAfter(float dtfA, int idA, float dtfB, int idB)
        {
            if (dtfA != dtfB) return dtfA > dtfB;
            return idA > idB;
        }

        // A player's distance-to-finish (m) = their synced position projected onto the NEAREST race-line point - resolved
        // regardless of where they are on the mountain (riding or on foot, on the line or off). +inf only if there's no course
        // path baked. GetPosition() is free - VRChat syncs every avatar's position.
        private float ProgressDtf(VRCPlayerApi p)
        {
            if (coursePath == null) return float.PositiveInfinity;
            coursePath.QueryProgressNearest(p.GetPosition());
            return coursePath.PFound ? coursePath.PDistToFinish : float.PositiveInfinity;
        }

        // Paint the current page onto the visible rows: each slot shows listed[page*size + slot] or is SetActive(false) when
        // the page runs short (so an empty row carries no name + no Interact). Updates the page/count readout.
        private void RefreshRows()
        {
            int vis = VisibleRows();
            for (int i = 0; i < vis; i++)
            {
                int idx = _page * vis + i;
                bool has = idx < _listedCount;
                if (rowRoots != null && i < rowRoots.Length && rowRoots[i] != null && rowRoots[i].activeSelf != has)
                    rowRoots[i].SetActive(has);
                if (rowLabels != null && i < rowLabels.Length && rowLabels[i] != null)
                    rowLabels[i].text = has ? _listed[idx].displayName : "";
                if (rowDtf != null && i < rowDtf.Length && rowDtf[i] != null)
                    rowDtf[i].text = has ? DtfLabel(_dtf[idx]) : "";
            }
            if (pageText != null)
            {
                if (_listedCount == 0) pageText.text = "No one else here yet";
                else pageText.text = "Page " + (_page + 1) + "/" + PageCount() + "   ·   "
                                   + _listedCount + (_listedCount == 1 ? " player" : " players");
            }
        }

        private int VisibleRows() { return rowLabels != null ? rowLabels.Length : 0; }

        private int PageCount()
        {
            int vis = VisibleRows();
            if (vis <= 0) return 1;
            int pc = (_listedCount + vis - 1) / vis;
            return pc < 1 ? 1 : pc;
        }

        // Distance-to-finish label: "1,240m" / "0m", or "—" when off the race line (+inf).
        private string DtfLabel(float d)
        {
            if (float.IsInfinity(d) || d >= 1e8f) return "—";
            int m = Mathf.RoundToInt(d);
            if (m < 0) m = 0;
            return Commas(m) + "m";
        }

        // Thousands separators (Udon-safe via Substring; values are non-negative). Mirrors RunHud.
        private string Commas(int v)
        {
            if (v < 0) v = 0;
            string s = v.ToString();
            if (s.Length <= 3) return s;
            int first = s.Length % 3;
            string outp = first > 0 ? s.Substring(0, first) : "";
            for (int i = first; i < s.Length; i += 3) { if (outp.Length > 0) outp += ","; outp += s.Substring(i, 3); }
            return outp;
        }

        // ---- tiny int-set helpers (copy-on-write so the synced field is replaced wholesale) ------------------------

        private bool Contains(int[] arr, int id)
        {
            if (arr == null) return false;
            for (int i = 0; i < arr.Length; i++) if (arr[i] == id) return true;
            return false;
        }

        private int[] WithId(int[] arr, int id)
        {
            if (Contains(arr, id)) return arr;
            int len = arr == null ? 0 : arr.Length;
            int[] r = new int[len + 1];
            for (int i = 0; i < len; i++) r[i] = arr[i];
            r[len] = id;
            return r;
        }

        private int[] WithoutId(int[] arr, int id)
        {
            if (!Contains(arr, id)) return arr;
            int[] r = new int[arr.Length - 1];
            int k = 0;
            for (int i = 0; i < arr.Length; i++) if (arr[i] != id) r[k++] = arr[i];
            return r;
        }
    }
}
