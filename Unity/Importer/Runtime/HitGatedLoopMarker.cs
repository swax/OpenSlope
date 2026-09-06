using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for SSX's interactive ambient emitters (retail group-2 events 16 cars / 28 fire hydrants /
    // 57 police cars). The loop is SILENT until the rider first hits the owning prop, which enables it permanently.
    // The trigger is the IMPACT, not the impact sound: retail's hydrants all carry the silent collision sentinel
    // and still spray, so a hit that makes no other noise must arm the loop [Trailmap: 420-interactive-gate].
    // AudioBuilder parks
    // the AudioSource on an INACTIVE GameObject under this marker; platform wiring realizes the hit pairing
    // (impact on the owner -> activate the loop; the world's prop reset may deactivate it again - a deliberate
    // deviation, retail never stops one).
    public sealed class HitGatedLoopMarker : Marker
    {
        public AudioSource source;   // the looping spray/alarm/siren bed (on an inactive GameObject)
        public string owner;         // owning instance name (e.g. Mdl_FireHyDrant_Base_1004) for the hit pairing
        public int sound = -1;       // global ADL event id (16 / 28 / 57)
    }
}
