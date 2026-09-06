using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Basis behaviour for SSX's knock-and-tumble physics props (crash bags, path markers, hydrant lids; docs/016) - the
    // Basis analogue of the VRChat PhysicsProp, realized from a PhysicsPropMarker by BasisWiring. The neutral
    // importer (PropBuilder.BuildPhysics) already builds the Rigidbody + BoxCollider + per-material impact AudioSource and
    // stamps the marker; this drives the runtime knock.
    //
    // The prop can't be a plain free rigid body: a body on a steep slope just slides off on spawn, and neither a walking
    // player (a driven CharacterController) nor a seated board rider imparts contact force to a rigidbody. So we ANCHOR
    // each prop (kinematic + SOLID - its box is the prop's only scenery collision, so it blocks the WALKING player like
    // the pinned props around it; the board's obstacle sweep skips BasisPhysicsProp colliders, since the game
    // physics-routes mode-3 knockables: knocked, never walling the rider), watch the LOCAL player cross the importer's
    // inflated sibling KNOCK-SENSOR trigger, then flip the body dynamic and fling it along the rider's own velocity -
    // reading the rider's motion replaces the contact force the engine never gives us. The sensor's inflation makes a
    // walking player's knock fire BEFORE the solid face blocks them; the solid box never changes state (a box going
    // solid around the rider would eject them - the AirVent bug).
    //
    // DETECTION is the Basis FX-trigger poll, NOT a physics event (docs/basis): Basis has no OnPlayerTriggerEnter, a
    // physics trigger misses a seated rider (the seat driver disables the player's CharacterController) and a teleport-in
    // (the root is moved without an enter/exit), and the board's own obstacle sweep skips triggers - so we POLL the local
    // player's root against the sensor box each frame and knock on the rising edge. The root position is written every
    // frame whether the player WALKS or RIDES, so a board rider skiing through is caught exactly like a walking one; the
    // knock direction is BasisLocalPlayerProbe.TryGetVelocity (that same root's per-frame delta). Local-only - every client
    // sees their own knock, nothing networked (matches the gems / boost pads). Optionally re-anchors once it settles so
    // it's knockable again.
    public class BasisPhysicsProp : MonoBehaviour
    {
        [Tooltip("Minimum rider speed (m/s) to knock this prop. Low = easy to send flying.")]
        public float MinPlayerSpeed = 2f;

        [Tooltip("Fraction of the rider's closing speed transferred to the prop on a knock. The game's mode-3 object " +
                 "impulse is a fixed 1.3 x closing speed / effective mass (it does NOT read PlayerBounceAmmount), so 1.3 " +
                 "is the heavy-rider limit. See docs/016, [Trailmap: 370-world-interaction].")]
        public float VelInherit = 1.3f;

        [Tooltip("Extra upward speed (m/s) added on a knock. The game adds NO vertical kick - the shove is along the " +
                 "solved contact normal - so 0 is faithful. Raise only as a stand-in for the contact-normal up-component a " +
                 "poll knock can't see.")]
        public float UpBias = 0f;

        [Tooltip("Re-anchor (kinematic) after the prop settles, so it's knockable again and won't drift.")]
        public bool ReAnchor = true;

        [Tooltip("Speed (m/s) below which the prop counts as 'settling' for re-anchoring.")]
        public float SettleSpeed = 0.4f;

        [Tooltip("Seconds the prop must stay below SettleSpeed before it re-anchors.")]
        public float SettleTime = 2.5f;

        [Tooltip("GPU-instanced shared-mesh prop (docs/012): re-apply the per-instance SSX light in Start (a " +
                 "MaterialPropertyBlock is runtime-only, so the importer's edit-time block is lost entering play - " +
                 "without this the shared-mesh prop draws black).")]
        public bool Instanced = false;
        public Color InstAmbient = Color.white;   // per-instance ambient floor (shader _InstAmbient)
        public Color InstKey1 = Color.black, InstKey2 = Color.black, InstKey3 = Color.black;
        public Vector3 InstDir1 = Vector3.up, InstDir2 = Vector3.up, InstDir3 = Vector3.up;

        [Tooltip("SPILL (docs/036): the breakable cluster this prop's collision chain ALSO throws - a garbage can's " +
                 "trash, a mail box's letters. The knock fires it, so one hit both topples the prop and sprays its " +
                 "contents, the way the SSF chain authors it. Resolved by the wiring pass; null = an ordinary body.")]
        public BasisBreakableLogo spill;

        Rigidbody _rb;
        BoxCollider _box;                     // the knock-sensor trigger box, for the local-player poll (null if absent)
        AudioSource _impact;                  // the prop's real collision clip (importer-attached); null -> silent
        bool _dynamic;
        bool _wasInside;                      // rising-edge latch for the crossing poll
        float _settle;
        Vector3 _homePos;                     // resting pose - a hydrant lid (Pop) re-arms here
        Quaternion _homeRot;
        const float ImpactMaxSpeed = 16f;     // closing speed (m/s) at/above which the impact clip is full volume
        const float ImpactVolume   = 1f;      // overall scale on the one-shot

        void Start()
        {
            _rb = GetComponent<Rigidbody>();
            // The poll volume is the KNOCK SENSOR - the inflated trigger box the importer adds beside the solid
            // body box - so the crossing fires before the rider reaches the solid face. Fall back to any box
            // (a hand-built prop with a single collider) rather than not knocking at all.
            _box = null;
            foreach (var bc in GetComponents<BoxCollider>())
                if (_box == null || bc.isTrigger) _box = bc;
            _impact = GetComponent<AudioSource>();
            _homePos = transform.position;
            _homeRot = transform.rotation;
            // Re-apply the per-instance light for a GPU-instanced shared-mesh prop. SetPropertyBlock is runtime-only (not
            // serialized), so the importer's edit-time block is gone by the time we run in play - re-push it here so the
            // URP shader's _DIRLIGHT_INST path lights this copy individually (docs/012). SetVector preserves the raw
            // /256 factors and directions; SetColor would apply an unwanted sRGB->linear conversion.
            if (Instanced)
            {
                var mr = GetComponent<MeshRenderer>();
                if (mr != null)
                {
                    var mpb = new MaterialPropertyBlock();
                    mr.GetPropertyBlock(mpb);
                    mpb.SetVector("_InstAmbient", new Vector4(InstAmbient.r, InstAmbient.g, InstAmbient.b, 1f));
                    mpb.SetVector("_InstKey1", new Vector4(InstKey1.r, InstKey1.g, InstKey1.b, 1f));
                    mpb.SetVector("_InstKey2", new Vector4(InstKey2.r, InstKey2.g, InstKey2.b, 1f));
                    mpb.SetVector("_InstKey3", new Vector4(InstKey3.r, InstKey3.g, InstKey3.b, 1f));
                    mpb.SetVector("_InstDir1", new Vector4(InstDir1.x, InstDir1.y, InstDir1.z, 0f));
                    mpb.SetVector("_InstDir2", new Vector4(InstDir2.x, InstDir2.y, InstDir2.z, 0f));
                    mpb.SetVector("_InstDir3", new Vector4(InstDir3.x, InstDir3.y, InstDir3.z, 0f));
                    mr.SetPropertyBlock(mpb);
                }
            }
            Anchor();
        }

        // At-rest state: kinematic (won't slide off the slope) and SOLID - it blocks like scenery, parked exactly where
        // the game placed it. The knock-sensor poll stays armed; the colliders themselves never change state.
        void Anchor()
        {
            if (_rb != null)
            {
                // Only a DYNAMIC body has velocity to clear; zeroing it while already kinematic warns. isKinematic=true
                // zeroes velocity internally, so the guard is purely to skip the no-op warning + work.
                if (!_rb.isKinematic) { SetLinearVelocity(_rb, Vector3.zero); _rb.angularVelocity = Vector3.zero; }
                _rb.isKinematic = true;
            }
            _dynamic = false;
            _settle = 0f;
            _wasInside = false;   // a fresh entry is required to re-knock
        }

        void Update()
        {
            if (_dynamic)
            {
                if (ReAnchor) SettleStep();   // self-settle + re-anchor once it comes to rest
                return;
            }

            if (_box == null) return;

            // Knock detection on the rising edge. On foot the player's ROOT is what crosses the box (and its per-frame
            // delta is the closing speed). While RIDING, the BOARD - not the seated rider's root, which the seat driver
            // fits into a sitting pose that can sit off the deck - is what plows through the bag, so also test the board's
            // position and prefer the board's own (cleaner) velocity for the knock. Either point inside = a crossing.
            var board = BasisBoard.LocalRider;
            bool inside = BasisLocalPlayerProbe.InsideBox(_box);
            Vector3 v; bool hasV;
            if (board != null)
            {
                inside |= BasisLocalPlayerProbe.PointInBox(_box, board.transform.position);
                v = board.RiderVelocity;
                hasV = v.sqrMagnitude > 1e-4f || BasisLocalPlayerProbe.TryGetVelocity(out v);
            }
            else hasV = BasisLocalPlayerProbe.TryGetVelocity(out v);

            if (inside && !_wasInside && hasV) Knock(v);
            _wasInside = inside;
        }

        // Flip dynamic and shove the prop along 'v' (the rider's velocity ~= the contact direction for a head-on hit), if v
        // clears MinPlayerSpeed. Game model (docs/016, [Trailmap: 370-world-interaction]): 1.3 x closing speed / effective
        // mass along the contact normal, NO up-kick - so VelInherit defaults to 1.3, UpBias to 0; the body then carries as a
        // real rigid body under gravity + drag + ground friction. We can't read the true contact normal from a poll, so we
        // approximate the direction with v and tumble with a random spin (the game's tumble is the real contact torque x
        // inverse-inertia tensor, which we don't reconstruct).
        void Knock(Vector3 v)
        {
            if (_dynamic) return;
            float speed = v.magnitude;
            if (speed < MinPlayerSpeed) return;

            // The prop's own real impact clip, volume ramped from the knock threshold (audible floor) to full at
            // ImpactMaxSpeed. One-shot so a re-knock after settling re-sounds; the source rides the body as it flies.
            if (_impact != null && _impact.clip != null)
            {
                float t = Mathf.Clamp01((speed - MinPlayerSpeed) / Mathf.Max(0.01f, ImpactMaxSpeed - MinPlayerSpeed));
                _impact.PlayOneShot(_impact.clip, Mathf.Clamp01((0.4f + 0.6f * t) * ImpactVolume));
            }

            if (_rb != null)
            {
                _rb.isKinematic = false;
                _rb.WakeUp();
                SetLinearVelocity(_rb, v * VelInherit + Vector3.up * UpBias);   // 1.3x closing speed along travel; UpBias 0 = faithful
                _rb.angularVelocity = Random.insideUnitSphere * speed * 0.5f;
            }
            // The same hit ALSO spills this prop's contents where the chain authors one (docs/036): the trash flies out
            // along the direction we were struck from, which is exactly the mesh-throw's own rule for an unset authored
            // direction. Fired here, not from a poll box of the cluster's own, so one crossing does both.
            if (spill != null) spill.HitFrom(v);
            _dynamic = true;
            _settle = 0f;
        }

        // Pop the prop off with an EXPLICIT launch (the SSF Roller = a fire-hydrant TopLid, docs/052): like Knock but the
        // direction + speed are given, not the rider's velocity - so a hydrant's BasisAmbientEmitter can shoot the lid
        // straight up when the base is hit. Public so the ambient emitter can call it. (No lid in the current Basis
        // test level, so this is unused there - kept for parity with the VRChat prop.)
        public void Pop(Vector3 dir, float speed)
        {
            if (_impact != null && _impact.clip != null) _impact.PlayOneShot(_impact.clip, Mathf.Clamp01(ImpactVolume));
            if (_rb != null)
            {
                _rb.isKinematic = false;
                _rb.WakeUp();
                SetLinearVelocity(_rb, dir.normalized * speed);
                _rb.angularVelocity = Random.insideUnitSphere * Mathf.Max(2f, speed);   // tumble
            }
            _dynamic = true;
            _settle = 0f;
        }

        // Return the prop to its original resting pose and anchor it (the Roller lid re-arm). Public so the ambient emitter
        // can re-arm the lid during its cooldown, back home BEFORE the next hit.
        public void Rearm()
        {
            if (_rb != null) { _rb.isKinematic = true; _rb.position = _homePos; _rb.rotation = _homeRot; }
            transform.position = _homePos;
            transform.rotation = _homeRot;
            Anchor();
        }

        // Settle-and-re-anchor: while dynamic, once the body is below SettleSpeed for SettleTime it re-anchors where it
        // landed (kinematic again -> knockable again). An anchored prop's Update only polls the sensor box.
        void SettleStep()
        {
            if (!_dynamic || !ReAnchor || _rb == null) return;
            if (LinearVelocity(_rb).magnitude < SettleSpeed && _rb.angularVelocity.magnitude < SettleSpeed)
            {
                _settle += Time.deltaTime;
                if (_settle >= SettleTime) { Anchor(); return; }   // settled where it landed
            }
            else _settle = 0f;
        }

        // Rigidbody velocity accessors - `velocity` was renamed `linearVelocity` in Unity 6 (Basis), so read/write through
        // the current name to avoid the deprecation. Mirrors PropBuilder's linearDamping guard.
        static void SetLinearVelocity(Rigidbody rb, Vector3 v)
        {
    #if UNITY_6000_0_OR_NEWER
            rb.linearVelocity = v;
    #else
            rb.velocity = v;
    #endif
        }

        static Vector3 LinearVelocity(Rigidbody rb)
        {
    #if UNITY_6000_0_OR_NEWER
            return rb.linearVelocity;
    #else
            return rb.velocity;
    #endif
        }
    }
}
