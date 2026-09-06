using UnityEngine;

namespace OpenSlope.Importer
{

    // Neutral hand-off for a knockable physics prop (crash bags, hydrant lids, docs/016): anchored kinematic until the
    // local rider skis through it, then flips dynamic and is flung. The importer (PropBuilder) builds the Rigidbody +
    // collider + impact sound and tags it; the platform wiring pass realizes the runtime physics-prop behaviour (the
    // anchor-at-start intent already lives on the Rigidbody.isKinematic). Field names mirror the behaviour's.
    public sealed class PhysicsPropMarker : Marker
    {
        public float MinPlayerSpeed = 2f;    // minimum rider speed to knock
        public float VelInherit = 1.3f;      // fraction of rider velocity imparted
        public float UpBias = 0f;            // extra upward knock
        public bool ReAnchor = true;         // settle + re-anchor after coming to rest
        public float SettleSpeed = 0.4f;     // speed below which it's "at rest"
        public float SettleTime = 2.5f;      // time at rest before re-anchoring
        // GPU-instanced shared-mesh prop (docs/012): the per-instance SSX light the behaviour re-applies at runtime via a
        // MaterialPropertyBlock. An edit-time block is runtime-only (not serialized) so it's lost entering play/build -
        // the prop would draw black; the behaviour re-applies these in Start so it lights correctly in-world.
        public bool Instanced = false;
        public Color InstAmbient = Color.white;
        public Color InstKey1 = Color.black;
        public Color InstKey2 = Color.black;
        public Color InstKey3 = Color.black;
        public Vector3 InstDir1 = Vector3.up;
        public Vector3 InstDir2 = Vector3.up;
        public Vector3 InstDir3 = Vector3.up;
        // SPILL (docs/036): this body's collision chain also THROWS a hidden contents twin - a garbage can / news box /
        // mail box, whose hit topples the prop AND sprays its trash/letters. The thrown pieces are an ordinary breakable
        // cluster; this points at that cluster's GameObject, resolved to the platform's breakable behaviour by the
        // wiring PASS 2 so the knock can fire it. The body owns the hit detection, so the cluster carries no trigger of
        // its own. Null = an ordinary knock body.
        public GameObject spillObject;
    }
}
