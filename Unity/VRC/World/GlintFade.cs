using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// SOURCE-VISIBILITY fade for the light glints ([Trailmap: 160-lighting-data], the runtime glint section). On
    /// console a sparkle fades in/out gracefully with its light's visibility - a prop right next to a flare hides it -
    /// while the sprite itself draws PULLED metres toward the camera so it sits IN FRONT of nearby terrain rather than
    /// cutting into it. The depth test therefore only handles gross occlusion; this behaviour supplies the rest: each
    /// frame it line-of-sight tests a few glints (round-robin) from the local viewer's head to the glint's light with a
    /// 5-ray kernel (centre + 4 offsets), setting the target to FULL when any ray clears - on console a light with any
    /// part visible draws the whole corona blooming over the occluding edge - and eases the OpenSlope/FlareHalo shader's
    /// _Visibility toward it per renderer via a MaterialPropertyBlock. A light's own HOUSING is exempt from occlusion,
    /// in two scopes: a PRIMITIVE collider overlapping the light (the coarse bounds box the importer gives a
    /// collision-mesh-less prop - a squad car's box is mostly air with the beacon just under its lid) is exempt by
    /// identity, since it could never pass a ray and would pin the sparkle dark forever; a MESH surface is exempt only
    /// per hit, when the hit lands within a small shell of the light (a ray grazing the flare's own column centimetres
    /// before the light is the fixture, not occlusion). Mesh colliders are NEVER exempted by identity - a terrain chunk
    /// or merged prop bucket spans the course, and one touch would let that glint shine through a kilometre of world.
    /// Sits on the LightGlows root; collects its child glint quads at Start. Local-only visuals (sync None).
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class GlintFade : UdonSharpBehaviour
    {
        [Tooltip("Easing rate for _Visibility per second (~2.5 = a graceful third-of-a-second swing).")]
        public float fadePerSecond = 2.5f;
        [Tooltip("Glints line-of-sight-tested per frame, round-robin (5 linecasts each). 122 glints at 3/frame = a ~0.6 s sweep.")]
        public int testsPerFrame = 3;
        [Tooltip("Metres around the light the 5-ray kernel samples. A light just behind an edge still catches a clear offset ray - the corona blooms over the edge before the light itself is visible, as on console.")]
        public float sampleRadius = 0.8f;
        [Tooltip("Metres beyond which a glint is not tested (the shader's own range fade owns far glints).")]
        public float maxRange = 330f;
        [Tooltip("Layers that count as occluders (players/UI/foliage etc. excluded).")]
        public int occluderMask = ~0;

        private Renderer[] _renderers;
        private Vector3[] _pos;      // each glint's world position (the light), cached at Start - glints don't move
        private float[] _cur;        // eased visibility currently applied
        private float[] _target;     // visibility from the last LOS test (0 or 1; the ease supplies the gradient)
        private MaterialPropertyBlock _mpb;
        private VRCPlayerApi _player;
        private int _cursor;

        // A light is mounted INSIDE the thing that houses it - a lamp head, a police car's roof light bar - and the
        // importer's prop colliders are coarse proxies (a prop with no collision mesh gets one box around its whole
        // model, so a squad car's box is 5 x 2 x 5 m of mostly air with the beacon 10 cm under its lid). A PRIMITIVE
        // collider that contains a light can never let a ray reach it, so it is that light's housing, never its
        // occluder: collect those once and skip them by identity in the sweep. Mesh colliders are excluded from this
        // list on purpose - the importer's terrain chunks and merged prop buckets each span a kilometre of course, so
        // identity-exempting one because the light touches it anywhere (a flare planted against its own collision
        // proxy) would let that glint shine through the whole mountain. Their near-light surfaces are exempted per
        // HIT instead: anything the ray strikes within HOUSING_SHELL of the light is fixture, not occluder.
        private Collider[] _housing;   // flattened per-glint housing colliders (primitives only)
        private int[] _housingStart;
        private int[] _housingCount;
        private RaycastHit[] _hits;

        // Metres around the light within which a struck surface counts as the light's own fixture. Big enough to
        // clear a flare column grazed just under its light, small enough that the kernel's 0.8 m offset rays still
        // see real terrain at their sample points.
        private const float HOUSING_SHELL = 0.6f;

        void Start()
        {
            _player = Networking.LocalPlayer;
            _mpb = new MaterialPropertyBlock();
            _hits = new RaycastHit[8];
            _renderers = GetComponentsInChildren<Renderer>(true);
            int n = _renderers == null ? 0 : _renderers.Length;
            _pos = new Vector3[n];
            _cur = new float[n];
            _target = new float[n];
            _housingStart = new int[n];
            _housingCount = new int[n];
            for (int i = 0; i < n; i++)
            {
                if (_renderers[i] != null) _pos[i] = _renderers[i].bounds.center;
                _cur[i] = 1f; _target[i] = 1f;   // built visible; the first sweep takes over
            }

            // One overlap query per glint: gather into a worst-case scratch (a glint keeps at most the query
            // buffer's 8 colliders), then compact into the exact flattened array.
            Collider[] buf = new Collider[8];
            Collider[] scratch = new Collider[n * buf.Length];
            int w = 0;
            for (int i = 0; i < n; i++)
            {
                _housingStart[i] = w;
                int c = Physics.OverlapSphereNonAlloc(_pos[i], 0.02f, buf, occluderMask, QueryTriggerInteraction.Ignore);
                if (c > buf.Length) c = buf.Length;
                for (int k = 0; k < c; k++)
                    if (buf[k] != null && buf[k].GetType() != typeof(MeshCollider)) scratch[w++] = buf[k];   // primitives only
                _housingCount[i] = w - _housingStart[i];
            }
            _housing = new Collider[w];
            for (int i = 0; i < w; i++) _housing[i] = scratch[i];
        }

        // True when the struck surface is this glint's own housing rather than an occluder: one of the
        // identity-exempt primitives collected at Start, or any surface within HOUSING_SHELL of the light
        // itself (the flare's own column, the lamp head the light is mounted in).
        private bool Exempt(int hitIndex, int gi)
        {
            Collider c = _hits[hitIndex].collider;
            if (c == null) return true;
            int s = _housingStart[gi], e = s + _housingCount[gi];
            for (int k = s; k < e; k++) if (_housing[k] == c) return true;
            Vector3 dp = _hits[hitIndex].point - _pos[gi];
            return dp.sqrMagnitude <= HOUSING_SHELL * HOUSING_SHELL;
        }

        // True when anything that is NOT this glint's own housing stands between the head and the sample point.
        // Cost note (measured): a physics query that must FILL HIT DATA costs ~5x a boolean one, so the common
        // path avoids hit data entirely. For a glint with NO identity housing (most of them) the shell exemption
        // is applied GEOMETRICALLY: only the centre ray (target == the light) can ever strike inside the 0.6 m
        // shell - an offset ray ends sampleRadius 0.8 m from the light, outside the shell for any viewing
        // distance past arm's length - so the centre ray simply STOPS at the shell boundary and every cast is a
        // plain boolean. Only a glint that DOES have housing primitives (a beacon inside its prop's bounds box)
        // pays for hit data - one all-hits query per ray, filtered through Exempt.
        private bool Blocked(Vector3 head, Vector3 target, int gi, bool centerRay)
        {
            Vector3 seg = target - head;
            float dist = seg.magnitude;
            if (dist < 1e-4f) return false;
            Vector3 dir = seg / dist;

            if (_housingCount[gi] == 0)
            {
                float len = centerRay ? dist - HOUSING_SHELL : dist;   // fixture surfaces hugging the light never register
                if (len <= 0f) return false;
                return Physics.Raycast(head, dir, len, occluderMask, QueryTriggerInteraction.Ignore);
            }

            // Housed glint: the ray must know WHAT it struck - and a cast toward the light always strikes at
            // least the housing box that wraps it, so a closest-hit pre-query can never settle a clear ray.
            // One all-hits query, every surface filtered through Exempt.
            int hits = Physics.RaycastNonAlloc(head, dir, _hits, dist, occluderMask, QueryTriggerInteraction.Ignore);
            if (hits >= _hits.Length) return true;          // more surfaces than the buffer holds - deep inside something
            for (int h = 0; h < hits; h++)
                if (!Exempt(h, gi)) return true;
            return false;
        }

        void Update()
        {
            if (_renderers == null || _renderers.Length == 0) return;
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }
            Vector3 head = _player.GetTrackingData(VRCPlayerApi.TrackingDataType.Head).position;
            int n = _renderers.Length;

            // Round-robin LOS: 5-ray kernel per tested glint - centre plus 4 offsets perpendicular to the sight
            // line. ANY clear ray = the FULL corona: on console a light with any part visible draws the whole
            // sparkle + aura blooming over the occluding edge (the ease below supplies the graceful transition,
            // matching the game's ~1 s occlusion swing). All five blocked = dark.
            float maxR2 = maxRange * maxRange;
            for (int t = 0; t < testsPerFrame; t++)
            {
                int i = _cursor; _cursor = _cursor + 1 >= n ? 0 : _cursor + 1;
                if (_renderers[i] == null) continue;
                Vector3 p = _pos[i];
                Vector3 to = p - head;
                if (to.sqrMagnitude > maxR2)
                {
                    // Out of test range: fade it out rather than freeze it. A glint parked at its Start value of 1
                    // would otherwise stay lit - through terrain - until the player first walks within range (the
                    // shader's own distance fade covers this band only while LightGlowRange is on).
                    _target[i] = 0f;
                    continue;
                }
                Vector3 dir = to.normalized;
                Vector3 upish = Mathf.Abs(dir.y) < 0.9f ? Vector3.up : Vector3.forward;
                Vector3 side = Vector3.Normalize(Vector3.Cross(dir, upish)) * sampleRadius;
                Vector3 up = Vector3.Normalize(Vector3.Cross(side, dir)) * sampleRadius;
                bool visible = !Blocked(head, p, i, true)
                            || !Blocked(head, p + side, i, false) || !Blocked(head, p - side, i, false)
                            || !Blocked(head, p + up, i, false) || !Blocked(head, p - up, i, false);
                _target[i] = visible ? 1f : 0f;
            }

            // Ease every glint whose fade is still moving (settled ones cost one float compare).
            float step = fadePerSecond * Time.deltaTime;
            for (int i = 0; i < n; i++)
            {
                float cur = _cur[i], tgt = _target[i];
                if (cur == tgt) continue;
                cur = Mathf.MoveTowards(cur, tgt, step);
                _cur[i] = cur;
                Renderer r = _renderers[i];
                if (r == null) continue;
                _mpb.SetFloat("_Visibility", cur);
                r.SetPropertyBlock(_mpb);
            }
        }
    }
}
