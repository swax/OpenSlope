using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// A small head-following debug readout for diagnosing performance in-world while riding - the on-headset
    /// companion to the perf work. Toggled by the Diagnostics Board's "Show FPS / debug" checkbox (SetActive),
    /// so it costs nothing until a player turns it on; local + per-client (sync None).
    ///
    /// Shows what Udon can actually read at runtime: smoothed FPS + frame ms + the worst frame since the last refresh,
    /// the player count, and - when an <see cref="ObjectCuller"/> is wired - how many placed objects are currently
    /// being DRAWN vs the total (a live proxy for the draw load the range-cull is shedding; you'll watch it fall as you
    /// ride away from the dense start). NOTE: true draw-call / SetPass / batch counts are NOT available to Udon at
    /// runtime (that's an editor-only UnityStats API) - use VRChat's built-in stats overlay or OVR Metrics for those.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class DebugHud : UdonSharpBehaviour
    {
        [Tooltip("The readout text (built + assigned by the Diagnostics Board setup).")]
        public Text text;
        [Tooltip("Optional - the placed-object range culler; when set the HUD shows 'objects drawn N/total'.")]
        public ObjectCuller culler;
        [Tooltip("Optional - the board manager; when set the HUD shows the local rider's speed / surface / grounded / boost.")]
        public BoardManager boardManager;

        [Tooltip("How far in front of the head to float the panel (m).")]
        public float followDistance = 1.1f;
        [Tooltip("Head-local offset so the panel sits below the centre of view (m).")]
        public Vector3 viewOffset = new Vector3(0f, -0.32f, 0f);
        [Tooltip("Text refresh interval (s) - the panel still re-positions every frame, only the string rebuilds at this rate.")]
        public float refreshInterval = 0.25f;

        private VRCPlayerApi _player;
        private float _fps;       // smoothed
        private float _worstDt;   // worst (largest) frame time since the last text refresh
        private float _timer;

        void Start() { _player = Networking.LocalPlayer; }

        // FPS accounting + text refresh. The HUD POSITIONING is NOT done here - see PostLateUpdate.
        void Update()
        {
            float dt = Time.deltaTime;
            if (dt > 0f)
            {
                float f = 1f / dt;
                _fps = _fps <= 0f ? f : Mathf.Lerp(_fps, f, 0.1f);   // light smoothing
                if (dt > _worstDt) _worstDt = dt;
            }

            _timer += dt;
            if (_timer < refreshInterval || text == null) return;
            _timer = 0f;
            float worstFps = _worstDt > 0f ? 1f / _worstDt : _fps;

            string s = "FPS " + Mathf.RoundToInt(_fps) + "   " + (dt * 1000f).ToString("F1") + " ms"
                     + "\nworst " + Mathf.RoundToInt(worstFps);
            if (culler != null) s += "\nobjects drawn " + culler.DrawnCount() + " / " + culler.Total();
            s += "\nplayers " + VRCPlayerApi.GetPlayerCount();
            s += BoardNetworkStatus();

            // Ride stats from the local rider's board (only while actually riding one).
            RideableBoard b = LocalBoard();
            if (b != null)
            {
                float spd = b.RiderVelocity.magnitude;
                s += "\n—\nspeed " + spd.ToString("F1") + " m/s  (" + Mathf.RoundToInt(spd * 3.6f) + " kmh)";
                // Board Update wall-time + per-section breakdown (ms) to find which part spikes:
                //   pr=probe  rl=oob/rail  in=integration  or=orientation  ax=audio/fx
                s += "\nbrd " + b.dbgUpdateMs.ToString("F1") + "ms = pr" + b.dbgSecProbe.ToString("F1")
                   + " rl" + b.dbgSecRail.ToString("F1") + " in" + b.dbgSecInteg.ToString("F1")
                   + " or" + b.dbgSecOrient.ToString("F1") + " ax" + b.dbgSecAudioFx.ToString("F1");
                // RESET = the contact under the board is a MainType-13 host (an "_R"-tagged prop collider), so touching
                // it carries the rider back to the course. Worth seeing on the HUD: the host is ordinary-looking
                // scenery, and nothing else on screen distinguishes it from the surface beside it.
                s += "\n" + (b.dbgGround ? SurfName(b.dbgSurf) : "AIR")
                   + (b.dbgResetHost ? "   RESET" : "") + (b.dbgBoost ? "   BOOST" : "");
                if (b.dbgCharge > 0.01f) s += "\ncharge " + Bar(b.dbgCharge) + " " + Mathf.RoundToInt(b.dbgCharge * 100f) + "%";
            }

            text.text = s;
            _worstDt = 0f;
        }

        // Session totals across pooled boards. TX/RX should keep increasing while someone rides; parked boards stop.
        // Useful on the headset itself, where the Unity inspector and the other player's client logs are unavailable.
        private string BoardNetworkStatus()
        {
            if (boardManager == null || boardManager.boards == null) return "";
            int sent = 0, received = 0, failed = 0, corrected = 0, active = 0, owned = 0;
            RideableBoard observed = null;
            float nearest = float.MaxValue;
            Vector3 playerPos = _player != null ? _player.GetPosition() : transform.position;
            for (int i = 0; i < boardManager.boards.Length; i++)
            {
                RideableBoard b = boardManager.boards[i];
                if (b == null) continue;
                sent += b.NetSendCount;
                received += b.NetReceiveCount;
                failed += b.NetSendFailures;
                corrected += b.NetGateCorrections;
                if (!b.gameObject.activeSelf) continue;
                active++;
                if (Networking.IsOwner(b.gameObject)) owned++;
                float distance = (b.transform.position - playerPos).sqrMagnitude;
                if (b.IsRiding) { observed = b; nearest = -1f; }
                else if (distance < nearest) { observed = b; nearest = distance; }
            }
            string status = "\nme " + PlayerLabel(_player) + (Networking.IsMaster ? " [MASTER]" : "")
                + "\nmaster " + PlayerLabel(Networking.Master)
                + "\npool owner " + PlayerLabel(Networking.GetOwner(boardManager.gameObject))
                + "\nboards " + active + "  mine " + owned + "  gate fixes " + corrected
                + "\nnet TX " + sent + "  RX " + received + "  fail " + failed;
            if (observed != null)
            {
                bool own = Networking.IsOwner(observed.gameObject);
                int count = own ? observed.NetSendCount : observed.NetReceiveCount;
                float last = own ? observed.NetLastSendTime : observed.NetLastReceiveTime;
                status += "\n" + observed.gameObject.name + " owner " + PlayerLabel(Networking.GetOwner(observed.gameObject))
                    + (observed.occupied ? " [IN USE]" : " [FREE]")
                    + "\n  " + (own ? "TX " : "RX ") + count + "  age "
                    + (count > 0 ? (Time.time - last).ToString("F1") + "s" : "never");
            }
            return status;
        }

        private string PlayerLabel(VRCPlayerApi player)
        {
            if (player == null) return "none";
            return player.displayName + " #" + player.playerId;
        }

        // The board the LOCAL player is riding (IsRiding is true only on the owner-rider's board), or null.
        private RideableBoard LocalBoard()
        {
            if (boardManager == null || boardManager.boards == null) return null;
            int n = boardManager.boards.Length;
            for (int i = 0; i < n; i++)
            {
                RideableBoard b = boardManager.boards[i];
                if (b != null && b.IsRiding) return b;
            }
            return null;
        }

        // A little 8-segment charge bar, e.g. [#####   ].
        private string Bar(float t)
        {
            int n = Mathf.Clamp(Mathf.RoundToInt(t * 8f), 0, 8);
            string b = "[";
            for (int i = 0; i < 8; i++) b += i < n ? "#" : " ";
            return b + "]";
        }

        // SSX SurfaceType -> short name (PBDHandler buckets; see the RideableBoard header legend).
        private string SurfName(int t)
        {
            if (t == 1 || t == 3 || t == 4 || t == 8 || t == 16) return "snow";
            if (t == 5 || t == 7 || t == 11) return "ice";
            if (t == 9 || t == 2) return "rock";
            if (t == 10 || t == 13 || t == 14) return "wall";
            if (t == 18) return "ramp";
            if (t == 0) return "reset";
            if (t == 17) return "no-collision";
            return "surf " + t;
        }

        // Position the head-locked panel in PostLateUpdate, NOT Update: VRChat finalises the player's head/camera pose
        // after all Updates run, so placing the HUD in Update() uses a stale pose and the panel swims/jitters against the
        // rendered view (badly while riding). PostLateUpdate runs after tracking is final, so the panel locks to the exact
        // pose that gets rendered - rock-steady even on a bumpy run. Rigid head-local placement (no smoothing) is the
        // stable choice: the HUD sits at a FIXED head-local offset, so head jitter moves your eyes and the panel together
        // and it never shifts in view; a smoothed follow would instead make it lag and swing.
        public override void PostLateUpdate()
        {
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }
            VRCPlayerApi.TrackingData head = _player.GetTrackingData(VRCPlayerApi.TrackingDataType.Head);
            Vector3 pos = head.position + head.rotation * (Vector3.forward * followDistance + viewOffset);
            transform.position = pos;
            transform.rotation = Quaternion.LookRotation(pos - head.position, head.rotation * Vector3.up);
        }
    }
}
