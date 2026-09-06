using UnityEngine;
using UdonSharp;

namespace OpenSlope.VrcPlugin
{

    // VRChat/Udon manager for SSX's hit-gated interactive ambient loops (retail group-2 events 16 cars / 28 fire
    // hydrants / 57 police cars). In retail these placed loops are SILENT until the rider first hits the owning
    // prop, which enables it permanently. The trigger is the IMPACT and not the impact sound - retail's hydrants
    // all carry the silent collision sentinel and still spray, which is why arming here keys on the contact rather
    // than on anything having been audible [Trailmap: 420-interactive-gate].
    // Here the rideable board notifies this manager on a wall impact and the nearest
    // still-inactive loop within activateRadius switches on (the loop objects are play-on-awake, so SetActive is the
    // whole start). Nearest-only prevents one impact arming a neighbouring prop's alarm.
    //
    // Retail never disables one again. This world's GLOBAL RESET POLICY deviates deliberately: anything retail
    // leaves on forever winds down after activeSeconds (default 7 s, the same SSF cadence the fire hydrants author
    // for their burst/re-arm cycle) - a re-hit pushes the stop later. Set activeSeconds to 0 for retail-faithful
    // alarm-forever. Loops armed by their ambient-emitter pairing (the hydrants) are stopped by the emitter's own
    // re-arm cycle instead; the deadline sweep here only touches loops it armed itself. Local-only: your hit arms
    // the alarm you hear (the hydrant path IS networked, via the emitter's burst broadcast).
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class HitGatedLoops : UdonSharpBehaviour
    {
        [Tooltip("The inactive placed-loop objects (hydrant spray / car alarm / police siren beds).")]
        public GameObject[] loops;

        [Tooltip("Metres: a wall impact activates the nearest inactive loop within this range. Sized for the largest " +
                 "authored emitter offset (a police car's siren sits 14 m from its instance origin).")]
        public float activateRadius = 18f;

        [Tooltip("Seconds an armed loop stays on; a re-hit pushes the stop later. Retail keeps them on FOREVER - this " +
                 "is the world's global wind-down for retail-infinite effects (7 s = the hydrants' authored SSF " +
                 "cadence). 0 = retail-faithful, never stop.")]
        public float activeSeconds = 7f;

        private float[] _offAt;   // per-loop stop deadline for loops THIS manager armed; 0 = not ours to stop

        void Start()
        {
            _offAt = new float[loops == null ? 0 : loops.Length];
        }

        // Arm the nearest eligible loop within range of an impact, or push an already-armed one's deadline later;
        // returns it (null = none in range).
        public GameObject ActivateNearest(Vector3 pos)
        {
            int n = loops == null ? 0 : loops.Length;
            if (_offAt == null || _offAt.Length != n) _offAt = new float[n];
            int best = -1;
            float bestSq = activateRadius * activateRadius;
            for (int i = 0; i < n; i++)
            {
                GameObject g = loops[i];
                if (g == null) continue;
                // A loop THIS manager armed stays a candidate, because the second hit on a police car has to push
                // its stop later (docs/015). One that is active with no deadline of ours is a hydrant's, armed by
                // its AmbientEmitter pairing and stopped by that emitter's re-arm; taking it over here would leave
                // the re-arm with nothing to stop. With activeSeconds = 0 nothing carries a deadline at all, so the
                // retail-faithful mode simply arms the next inactive loop.
                if (g.activeSelf && _offAt[i] <= 0f) continue;
                float d = (g.transform.position - pos).sqrMagnitude;
                if (d < bestSq) { bestSq = d; best = i; }
            }
            if (best < 0) return null;
            if (!loops[best].activeSelf) loops[best].SetActive(true);
            if (activeSeconds > 0f)
            {
                _offAt[best] = Time.time + activeSeconds;
                SendCustomEventDelayedSeconds(nameof(StopTick), activeSeconds + 0.05f);
            }
            return loops[best];
        }

        // Deadline sweep: each activation schedules one tick just past its own deadline, so the last tick lands
        // after the last deadline. A re-hit pushed _offAt later, so an earlier (stale) tick simply no-ops.
        public void StopTick()
        {
            int n = loops == null ? 0 : loops.Length;
            if (_offAt == null || _offAt.Length != n) return;
            float now = Time.time;
            for (int i = 0; i < n; i++)
            {
                if (_offAt[i] <= 0f || now < _offAt[i]) continue;
                _offAt[i] = 0f;
                if (loops[i] != null) loops[i].SetActive(false);
            }
        }

        // Silence everything (a world/props reset hook).
        public void ResetAll()
        {
            int n = loops == null ? 0 : loops.Length;
            for (int i = 0; i < n; i++)
            {
                if (_offAt != null && i < _offAt.Length) _offAt[i] = 0f;
                if (loops[i] != null) loops[i].SetActive(false);
            }
        }
    }
}
