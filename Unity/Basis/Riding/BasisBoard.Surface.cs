using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Part of BasisBoard (partial): the per-SurfaceType feel table (friction/grip/speed), the snow-sink contact
    // spring, and the terrain-collider cache + smooth-normal lookup. Basis runs plain C# (no Udon), so the math is
    // identical to the VRChat board (VRC/Riding/Board/RideableBoard.Surface.cs); only the VRChat-specific
    // analytic-patch / prop-audio branches are dropped (the faceted smooth-normal contact is the fallback the VRChat
    // board already used when no patch data was present).
    //
    // Surface rows are generated into BasisBoard.Contract.Generated.cs from the one authoritative contract at
    // Trailmap/specs/data/ride-v1.json. This file keeps only the independently implemented runtime algorithm.
    public partial class BasisBoard
    {
        // ---- Surface table (relative feel) --------------------------------------------------------------

        // Row 0 is a reset/non-riding record. Unknown and reset contacts use the ordinary-ground row, matching VRC.
        int SurfaceRow(int t) { return (t >= 1 && t < 20) ? t : 15; }
        float CarveGripFor(int t) { return _rideSurfDrag[SurfaceRow(t)]; }
        float SpeedGainFor(int t) { return _rideSurfTarget[SurfaceRow(t)]; }
        float SpeedMultFor(int t) { return _rideSurfMult[SurfaceRow(t)]; }

        // ---- Snow sink / soft contact spring (docs/vrchat/020) ------------------------------------------

        float SinkBudgetFor(int t) { return _rideSurfBudget[SurfaceRow(t)] * sinkDepthScale; }
        float SinkStiffnessFor(int t) { return _rideSurfA[SurfaceRow(t)] / 30f; }
        float SinkDampingFor(int t) { return _rideSurfP[SurfaceRow(t)]; }

        float SinkOvershootFor(int t)
        {
            float bog = _rideSurfBog[SurfaceRow(t)] * sinkBogScale;
            return bog > sinkMaxOvershoot ? bog : sinkMaxOvershoot;
        }

        // Advance the contact spring one step and return the depth (m) to drop the ground-snap by. Semi-implicit spring
        // with implicit damping so the firm (high-c) surfaces stay stable at any frame rate.
        float SinkUpdate(int surf, float dt)
        {
            if (!snowSink) { _sinkDepth = 0f; _sinkVel = 0f; _sinkBudget = 0f; return 0f; }
            float target = SinkBudgetFor(surf);
            _sinkBudget = Mathf.MoveTowards(_sinkBudget, target, sinkBudgetSlew * dt);
            float k = SinkStiffnessFor(surf) * sinkStiffness;
            float c = SinkDampingFor(surf) * sinkDamping;
            _sinkVel = (_sinkVel + k * (_sinkBudget - _sinkDepth) * dt) / (1f + c * dt);
            _sinkDepth += _sinkVel * dt;
            float maxD = _sinkBudget + SinkOvershootFor(surf);
            if (_sinkDepth > maxD) { _sinkDepth = maxD; if (_sinkVel > 0f) _sinkVel = 0f; }
            if (_sinkDepth < 0f) { _sinkDepth = 0f; if (_sinkVel < 0f) _sinkVel = 0f; }
            return _sinkDepth;
        }

        void SinkLandingPunch(float impact)
        {
            if (!snowSink) return;
            _sinkDepth = 0f;
            _sinkVel = (impact > 0f ? impact : 0f) * sinkLandingPunch;
        }

        // ---- Surface cache (Surf_<type> colliders under the collision root) -----------------------------

        void CacheSurfaces()
        {
            if (collisionRoot == null)
            {
                _colliders = new Collider[0]; _types = new int[0];
                _meshTris = new int[0][]; _meshNorms = new Vector3[0][];
                _idxCacheCol = null; _idxCacheVal = -1;
                return;
            }
            int n = collisionRoot.childCount;
            Collider[] cols = new Collider[n];
            int[] types = new int[n];
            int[][] tris = new int[n][];
            Vector3[][] norms = new Vector3[n][];
            int count = 0;
            for (int i = 0; i < n; i++)
            {
                Transform c = collisionRoot.GetChild(i);
                Collider col = c.GetComponent<Collider>();
                if (col == null) continue;
                cols[count] = col;
                types[count] = ParseSurfType(c.name);
                // Cache the smooth (analytic Bezier) normals the importer baked onto this Surf_ mesh + its triangle list,
                // so SmoothNormal can barycentric-blend them. A non-readable / normalless mesh leaves these null and the
                // ride falls back to the raw hit normal.
                MeshCollider mc = c.GetComponent<MeshCollider>();
                if (mc != null && mc.sharedMesh != null)
                {
                    Mesh m = mc.sharedMesh;
                    if (m.isReadable && m.vertexCount > 0)
                    {
                        Vector3[] mn = m.normals;
                        if (mn != null && mn.Length == m.vertexCount) { norms[count] = mn; tris[count] = m.triangles; }
                    }
                }
                count++;
            }
            _colliders = new Collider[count];
            _types = new int[count];
            _meshTris = new int[count][];
            _meshNorms = new Vector3[count][];
            for (int i = 0; i < count; i++)
            {
                _colliders[i] = cols[i]; _types[i] = types[i];
                _meshTris[i] = tris[i]; _meshNorms[i] = norms[i];
            }
            _idxCacheCol = null; _idxCacheVal = -1;
        }

        // One-entry memo: you ride the SAME Surf_ collider for many frames, so caching the last collider->index turns the
        // linear scan into one compare on the common path. Caches the -1 (not-a-surface) result too.
        private Collider _idxCacheCol;
        private int _idxCacheVal = -1;
        int IndexOf(Collider col)
        {
            if (col == _idxCacheCol) return _idxCacheVal;
            for (int i = 0; i < _colliders.Length; i++)
                if (_colliders[i] == col) { _idxCacheCol = col; _idxCacheVal = i; return i; }
            _idxCacheCol = col; _idxCacheVal = -1;
            return -1;
        }

        // A non-terrain collider the board should still RIDE as ground: a real solid prop collision proxy (the
        // PropsCollision_* bucket meshes the importer bakes from the game's pinned collision proxies - bridges, ramps).
        bool IsRideableProp(Collider col)
        {
            if (!rideSolidProps || col == null || col.isTrigger) return false;
            string nm = col.name;
            return nm != null && nm.StartsWith("PropsCollision_");
        }

        // True when hitting this collider should put the rider back at spawn: a prop whose own collision carries the
        // host's MainType-13 reset (docs/053). The engine hangs that node off the prop's COLLISION slot, so it is
        // contact-driven - smack the shut megaplex door and you're reset, and once it has opened there is nothing left
        // to hit. Read off the NAME like IsRideableProp: an "_R" token ahead of any "_T<surface>" tail, so a door that
        // is also a ride surface parses as both.
        bool ResetOnContact(Collider col)
        {
            if (col == null || col.isTrigger) return false;
            string nm = col.name;
            if (nm == null) return false;
            int end = nm.Length;
            int i = end - 1;
            bool any = false;
            while (i >= 0) { int d = (int)nm[i] - (int)'0'; if (d < 0 || d > 9) break; i--; any = true; }
            if (any && i >= 1 && nm[i] == 'T' && nm[i - 1] == '_') end = i - 1;   // step over the "_T<digits>" tail
            return end >= 2 && nm[end - 1] == 'R' && nm[end - 2] == '_';
        }

        // Authored static buckets carry SurfaceType on the realized metadata component. Animated legacy buckets carry
        // the same value as a _T<number> tail. Return -1 when neither path types the prop, preserving object fallback.
        int PropSurfaceType(Collider col)
        {
            if (col == null) return -1;
            var prop = col.GetComponent<BasisPropBounce>();
            if (prop != null && prop.SurfaceType >= 0) return prop.SurfaceType;
            string nm = col.name;
            if (string.IsNullOrEmpty(nm)) return -1;
            int i = nm.Length - 1;
            bool any = false;
            while (i >= 0 && nm[i] >= '0' && nm[i] <= '9') { i--; any = true; }
            if (!any || i < 1 || nm[i] != 'T' || nm[i - 1] != '_') return -1;
            int value = 0;
            for (int k = i + 1; k < nm.Length; k++) value = value * 10 + (nm[k] - '0');
            return value;
        }

        // Barycentric blend of the hit triangle's three baked vertex normals -> a contact normal that follows the smooth
        // Bezier surface instead of the faceted triangle (docs/021). Returns flatN whenever the data isn't there.
        Vector3 SmoothNormal(int ci, int tri, Vector3 bary, Vector3 flatN)
        {
            if (!smoothContactNormal) return flatN;
            if (ci < 0 || tri < 0) return flatN;
            int[] idx = _meshTris[ci];
            Vector3[] nrm = _meshNorms[ci];
            if (idx == null || nrm == null) return flatN;
            int b = tri * 3;
            if (b + 2 >= idx.Length) return flatN;
            int i0 = idx[b], i1 = idx[b + 1], i2 = idx[b + 2];
            if (i0 >= nrm.Length || i1 >= nrm.Length || i2 >= nrm.Length) return flatN;
            Vector3 n = nrm[i0] * bary.x + nrm[i1] * bary.y + nrm[i2] * bary.z;
            if (n.sqrMagnitude < 1e-8f) return flatN;
            // Baked normals are in the collision mesh's LOCAL space; rotate to world by the collider's world rotation.
            n = (_colliders[ci].transform.rotation * n).normalized;
            return Vector3.Dot(n, flatN) > 0f ? n : flatN;
        }

        // "Surf_5" -> 5 ; -1 if unparseable.
        int ParseSurfType(string nm)
        {
            if (nm == null) return -1;
            int us = nm.IndexOf('_');
            if (us < 0 || us + 1 >= nm.Length) return -1;
            int v = 0; bool any = false;
            for (int i = us + 1; i < nm.Length; i++)
            {
                int d = (int)nm[i] - (int)'0';
                if (d < 0 || d > 9) return -1;
                v = v * 10 + d; any = true;
            }
            return any ? v : -1;
        }
    }
}
