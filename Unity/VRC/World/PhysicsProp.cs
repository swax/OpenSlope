using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // VRChat/Udon component for SSX's knock-and-tumble physics props (docs/016) - the one that runs in-world. The knock-and-tumble
    // props (crash bags, vents, path markers) can't be a plain Rigidbody: VRChat players are CharacterControllers and
    // impart NO force to a rigidbody on contact, so you can't ski into one and send it flying; and a free body on
    // a steep slope just slides off on spawn. So we ANCHOR each prop (kinematic + SOLID - its box is the prop's
    // only scenery collision, so it blocks the WALKING player like the pinned props around it; the board's obstacle
    // sweep skips PhysicsProp colliders, since the game physics-routes mode-3 knockables: knocked, never walling
    // the rider), detect the local player crossing the importer's slightly-inflated sibling KNOCK-SENSOR trigger
    // via OnPlayerTriggerEnter, then flip the body dynamic and fling it along the player's own velocity. The
    // sensor's inflation makes a walking player's knock fire BEFORE the solid face blocks them; the solid box
    // itself NEVER becomes a trigger - a body that went solid at the knock would materialise a box around the
    // rider and launch them (overlap resolution - the AirVent bug).
    // Local-only (sync mode None) - every client sees their own knock, nothing networked (matches the spinners /
    // surface detector). Optionally re-anchors after it settles so it's knockable again.
    //
    // You don't add this by hand per prop: the importer (PropBuilder.BuildPhysics) adds the Rigidbody + the solid
    // box + the sensor and attaches+configures this directly via UdonTools.AddConfigured. See docs/016-physics-props.md
    // and docs/vrchat/013-udon-components.md.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class PhysicsProp : UdonSharpBehaviour
    {
        [Tooltip("Minimum player speed (m/s) to knock this prop. Low = easy to send flying.")]
        public float MinPlayerSpeed = 2f;

        [Tooltip("Fraction of the rider's closing speed transferred to the prop on a knock. The game's mode-3 object impulse is a fixed 1.3 x closing speed / effective mass (it does NOT read PlayerBounceAmmount), so 1.3 is the heavy-rider limit. See docs/016, [Trailmap: 370-world-interaction].")]
        public float VelInherit = 1.3f;

        [Tooltip("Extra upward speed (m/s) added on a knock. The game adds NO vertical kick - the shove is along the solved contact normal and vertical motion comes from contact geometry + gravity, so 0 is faithful. Raise only as a stand-in for the contact-normal up-component our trigger knock can't see. See docs/016, [Trailmap: 370-world-interaction].")]
        public float UpBias = 0f;

        [Tooltip("Re-anchor (kinematic) after the prop settles, so it's knockable again and won't drift.")]
        public bool ReAnchor = true;

        [Tooltip("Speed (m/s) below which the prop counts as 'settling' for re-anchoring.")]
        public float SettleSpeed = 0.4f;

        [Tooltip("Seconds the prop must stay below SettleSpeed before it re-anchors.")]
        public float SettleTime = 2.5f;

        [Tooltip("GPU-instanced shared-mesh prop: re-apply the per-instance SSX light in Start (a MaterialPropertyBlock " +
                 "is runtime-only, so the importer's edit-time block is lost entering play/build - without this the prop draws black).")]
        public bool Instanced = false;
        public Color InstAmbient = Color.white;   // per-instance ambient floor (shader _InstAmbient)
        public Color InstKey1 = Color.black, InstKey2 = Color.black, InstKey3 = Color.black;
        public Vector3 InstDir1 = Vector3.up, InstDir2 = Vector3.up, InstDir3 = Vector3.up;

        [Tooltip("SPILL (docs/036): the breakable cluster this prop's collision chain ALSO throws - a garbage can's " +
                 "trash, a mail box's letters. The knock fires it, so one hit both topples the prop and sprays its " +
                 "contents, the way the SSF chain authors it. Resolved by the wiring PASS 2; null = an ordinary body.")]
        public BreakableLogoU spill;

        private Rigidbody _rb;
        private bool _dynamic;
        private float _settle;
        private Vector3 _homePos;              // original resting pose - the Roller lid (Pop) snaps back here + re-pops on each hit
        private Quaternion _homeRot;
        // The prop's real collision clip, attached by the importer (CollisionBuilder.AttachImpactSound -> CollisonSound
        // remapped to the course-bank slot; docs/009). We play it ourselves on a knock: the board's obstacle sweep
        // skips our colliders (physics-routed, never a wall), so unlike a wall the board never sounds us. Baked tuning,
        // matching RideableBoard's wall-impact curve - promote to public if per-prop knobs are ever wanted.
        private AudioSource _impact;          // null if this prop's CollisonSound had no known clip -> silent
        private float _impactMaxSpeed = 16f;  // closing speed (m/s) at/above which the clip is full volume
        private float _impactVolume   = 1f;   // overall scale on the one-shot

        void Start()
        {
            _rb = (Rigidbody)GetComponent(typeof(Rigidbody));
            _impact = (AudioSource)GetComponent(typeof(AudioSource));
            _homePos = transform.position;        // remember the resting pose so a Roller lid re-pops cleanly from the hydrant
            _homeRot = transform.rotation;
            // Re-apply the per-instance light for a GPU-instanced shared-mesh prop. SetPropertyBlock is runtime-only (not
            // serialized), so the importer's edit-time block is gone by the time we run in play/build - re-push it here so
            // the shader's _DIRLIGHT_INST path lights this copy individually (docs/012). SetVector preserves the raw
            // /256 factors and directions; SetColor would apply an unwanted sRGB->linear conversion.
            if (Instanced)
            {
                var mr = (MeshRenderer)GetComponent(typeof(MeshRenderer));
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

        // At-rest state: kinematic (won't slide off the slope) and SOLID - it blocks like scenery, parked exactly
        // where the game placed it. The knock sensor (the importer's inflated sibling trigger) stays armed; the
        // colliders themselves never change state.
        private void Anchor()
        {
            if (_rb != null)
            {
                // Only a DYNAMIC body has velocity to clear; zeroing it while already kinematic logs "Setting velocity of
                // a kinematic body is not supported" - every prop x every Start (and each ReAnchor). isKinematic=true zeroes
                // the body's velocity internally anyway, so the guard is purely to skip the no-op warning + work.
                if (!_rb.isKinematic)
                {
                    _rb.velocity = Vector3.zero;
                    _rb.angularVelocity = Vector3.zero;
                }
                _rb.isKinematic = true;
            }
            _dynamic = false;
            _settle = 0f;
        }

        public override void OnPlayerTriggerEnter(VRCPlayerApi player)
        {
            if (player == null || !player.isLocal || _dynamic) return;
            Knock(player.GetVelocity());
        }

        // Also knock for the RIDEABLE BOARD. A VRCStation passenger stops raising OnPlayerTriggerEnter (you're
        // carried by the station, not walking the capsule through us), so the board sweeps an invisible RiderProbe
        // capsule through here. We fling along the BOARD's velocity - the seated rider reports none of their own.
        public void OnTriggerEnter(Collider other)
        {
            if (other == null || _dynamic) return;
            RideableBoard board = other.GetComponentInParent<RideableBoard>();
            if (board != null && board.IsRiding) Knock(board.RiderVelocity);
        }

        // Flip dynamic and shove the prop along 'v' (the rider's velocity ~= the contact direction for a head-on hit),
        // if v clears MinPlayerSpeed. Shared by the walking (OnPlayerTriggerEnter) and riding (OnTriggerEnter) paths.
        // Game model (docs/016, [Trailmap: 370-world-interaction]): the game's mode-3 object impulse is 1.3 x closing speed / effective mass along the
        // contact normal, with NO up-kick - so VelInherit defaults to 1.3 and UpBias to 0; the body then carries as a
        // real rigid body under gravity + light drag + ground friction (not a canned shove). We can't read the true
        // contact normal from a trigger callback, so we approximate the direction with v and tumble with a random spin
        // (the game's tumble is the real contact torque x inverse-inertia tensor, which we don't reconstruct).
        private void Knock(Vector3 v)
        {
            if (_dynamic) return;
            float speed = v.magnitude;
            if (speed < MinPlayerSpeed) return;

            // The prop's own real impact clip, volume ramped from the knock threshold (audible floor) to full at
            // _impactMaxSpeed. One-shot so a re-knock after settling re-sounds; the source rides the body as it flies.
            if (_impact != null && _impact.clip != null)
            {
                float t = Mathf.Clamp01((speed - MinPlayerSpeed) / Mathf.Max(0.01f, _impactMaxSpeed - MinPlayerSpeed));
                _impact.PlayOneShot(_impact.clip, Mathf.Clamp01((0.4f + 0.6f * t) * _impactVolume));
            }

            if (_rb != null)
            {
                _rb.isKinematic = false;
                _rb.WakeUp();
                _rb.velocity = v * VelInherit + Vector3.up * UpBias;   // 1.3x closing speed along travel; UpBias 0 = faithful (game adds no up-kick)
                _rb.angularVelocity = Random.insideUnitSphere * v.magnitude * 0.5f;
            }
            // The same hit ALSO spills this prop's contents where the chain authors one (docs/036): the trash flies out
            // along the direction we were struck from, which is exactly the mesh-throw's own rule for an unset authored
            // direction. Fired here, not from a trigger of the cluster's own, so one contact does both.
            if (spill != null) spill.HitFrom(v);

            _dynamic = true;
            _settle = 0f;
            if (ReAnchor && _rb != null) SendCustomEventDelayedFrames(nameof(SettleStep), 1); // self-scheduled settle check, not a persistent FixedUpdate
        }

        // Pop the prop off with an EXPLICIT launch (the SSF Roller = a fire-hydrant TopLid, docs/052): like Knock but the
        // direction + speed are given, not the rider's velocity - so the hydrant's AmbientEmitter can shoot the lid
        // straight up when the base is hit. The lid then tumbles under gravity, bounces off the terrain, and settles
        // where it lands [Trailmap: 370-world-interaction]. Public so the ambient emitter's Play() calls it.
        public void Pop(Vector3 dir, float speed)
        {
            // Launch from wherever the lid currently sits - the AmbientEmitter re-arms it home DURING the cooldown, so
            // on a normal hit it's already back on the hydrant. No reset here: resetting AT the hit looks like the lid
            // spawns on top the instant you touch it (which is what we're avoiding).
            if (_impact != null && _impact.clip != null) _impact.PlayOneShot(_impact.clip, Mathf.Clamp01(_impactVolume));
            if (_rb != null)
            {
                _rb.isKinematic = false;
                _rb.WakeUp();
                _rb.velocity = dir.normalized * speed;
                _rb.angularVelocity = Random.insideUnitSphere * Mathf.Max(2f, speed);   // tumble
            }
            _dynamic = true;
            _settle = 0f;
            if (ReAnchor && _rb != null) SendCustomEventDelayedFrames(nameof(SettleStep), 1);
        }

        // Return the prop to its original resting pose (the Roller lid re-arm): stop the body, teleport home, anchor.
        // The hydrant's AmbientEmitter calls this after the cooldown so the lid is back on the hydrant BEFORE the next
        // hit - not snapped back at the moment of the hit.
        public void Rearm()
        {
            if (_rb != null) { _rb.isKinematic = true; _rb.position = _homePos; _rb.rotation = _homeRot; }
            transform.position = _homePos;
            transform.rotation = _homeRot;
            Anchor();
        }

        // Settle check, SELF-SCHEDULED while dynamic (no persistent FixedUpdate): Knock fires the first call and each call
        // reschedules until the knocked body settles and re-anchors. So an anchored/at-rest prop costs ZERO per-frame Udon -
        // a persistent FixedUpdate would dispatch on every prop every physics step (33 idle dispatches) just to early-out
        // on !_dynamic. We only sample velocity + accumulate seconds here, so Update-rate timing (Time.deltaTime) is fine; PhysX still
        // simulates the body at the fixed step. ReAnchor off -> never scheduled (the body just stays dynamic).
        public void SettleStep()
        {
            if (!_dynamic || !ReAnchor || _rb == null) return;
            if (_rb.velocity.magnitude < SettleSpeed && _rb.angularVelocity.magnitude < SettleSpeed)
            {
                _settle += Time.deltaTime;
                if (_settle >= SettleTime) { Anchor(); return; }   // settled where it landed; kinematic again -> knockable again (loop ends)
            }
            else
            {
                _settle = 0f;
            }
            SendCustomEventDelayedFrames(nameof(SettleStep), 1);
        }
    }
}
