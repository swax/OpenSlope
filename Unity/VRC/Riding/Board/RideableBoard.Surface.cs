using UnityEngine;
using UdonSharp;
using VRC.SDKBase;
using VRC.Udon.Common;

namespace OpenSlope.VrcPlugin
{

    // Part of RideableBoard (partial): the per-SurfaceType response table - the contact columns (A/P/bog/budget/
    // threshold/lift) the fixed-tick ground model reads, the carve/cruise columns, the three-zone contact response,
    // and the terrain-collider cache + smooth-normal lookup. [Trailmap: 310-surface-response]
    public partial class RideableBoard
    {
        // ---- The per-surface response table ([Trailmap: 310-surface-response], all 20 measured rows) -------
        // One row per SurfaceType (0..19), indexed by the painted type. Almost everything that makes one surface ride
        // differently from another is this data, not code - there is no `if powder` branch anywhere in the motion core.
        //
        // `A` is the surface's CONTACT-response scale in engine units/s^2; it is not the independently measured
        // grounded-pull scalar. `P` is contact damping. `bog` is the soft give; `budget` is the depth past which the
        // capped pushout intervenes; `thresh` is the clearance at which grounded state ends; `lift` raises only the
        // drawn deck. Runtime values are generated from Trailmap/specs/data/ride-v1.json into the `_rideSurf*`
        // arrays on RideableBoard.Contract.Generated.cs, so Unity and Slopesmith cannot silently diverge.
        //
        // Every type gets its own row - folding families together by their level-authoring names (7 and 11 onto ice,
        // 8 and 16 onto snow, 13 and 14 onto wall) reads plausibly and is wrong in every case: type 7 has a 13.8 cm
        // give on an A~980 dead contact, nothing like ice's 5 mm; type 8's give is 14.4 cm, not snow's 5 mm; type 14
        // carries the fastest speed target in the game. The generic A=980 / P=30 row is shared by the surfaces never
        // meant to be ridden (6 bounce, 10 wall, 15, 16 sand, 17 no-collision) plus the table's spare 20th record -
        // and its A of 980 units/s^2 is a 9.8 m/s^2 response at the bog floor.
        // Carve / cruise columns: drag is the lateral carve drag that eats sideways slip (ice's 0.0025 is two to
        // three ORDERS below every other rideable surface - that ratio IS the ice skid); target/mult are the cruise
        // drive's speed target (m/s) and response multiplier [Trailmap: 360-speed-and-boost]. Same row order.
        // Carve-tilt angle in DEGREES (per-surface record): the grounded contact response rides a frame banked tilt*lean
        // off the normal (GroundTick), so leaning tilts the whole normal force into the turn - THAT is the carve
        // force, independent of carve_drag. 58.3 everywhere except ice's 45.0 and rock's 21.34
        // [Trailmap: 310-surface-response].

        // Out-of-range SurfaceTypes (a prop's -1, airborne -2, anything unmapped) fall on row 15, the table's own
        // "standard" generic bucket. Type 0 (Reset) ALSO takes the generic row: the engine wipes out on reset contact,
        // so row 0's metre-deep bog/budget columns are never actually ridden - while this world free-roams across
        // Reset patches (the race path DQs separately, reading _pSurf directly), so its CONTACT must ride like
        // ordinary ground rather than slewing the deck a metre under and off the probe's reach.
        int SurfRow(int t) { return (t >= 1 && t < 20) ? t : 15; }
        float SurfA(int t)      { return _rideSurfA[SurfRow(t)]; }
        float SurfP(int t)      { return _rideSurfP[SurfRow(t)]; }
        float SurfBog(int t)    { return _rideSurfBog[SurfRow(t)]; }
        float SurfBudget(int t) { return _rideSurfBudget[SurfRow(t)]; }
        float SurfThresh(int t) { return _rideSurfThresh[SurfRow(t)]; }
        float SurfLift(int t)   { return _rideSurfLift[SurfRow(t)]; }
        float SurfDrag(int t)   { return _rideSurfDrag[SurfRow(t)]; }
        float SurfTarget(int t) { return _rideSurfTarget[SurfRow(t)]; }
        float SurfMult(int t)   { return _rideSurfMult[SurfRow(t)]; }
        float SurfTilt(int t)   { return _rideSurfTilt[SurfRow(t)]; }

        // Optional port assistance, disabled by default. Tuning predates the recovered response laws;
        // it is not a set of original-game parameters. Keep Slopesmith's ICE_* tuning in sync.
        // See docs/vrchat/040-carving-response.md for the remaining implementation differences.
        float SurfIceAssist(int t)
        {
            if (!lowGripAssist || lowGripDragRef <= 0f) return 0f;
            return Mathf.Clamp01((lowGripDragRef - SurfDrag(t)) / lowGripDragRef);
        }

        // The carve tilt 17 of the 20 rows share; the lift interpolates toward it and never past it.
        const float CARVE_TILT_BASE = 58.3f;

        // Increase the banked contact force by lifting tilt toward the common surface-table value.
        float SurfCarveTilt(int t, float assist)
        {
            float tilt = SurfTilt(t);
            if (tilt >= CARVE_TILT_BASE) return tilt;
            return tilt + assist * lowGripTiltLift * (CARVE_TILT_BASE - tilt);
        }

        // The three-zone contact response, as an OUTWARD acceleration (m/s^2)
        // along the contact normal [Trailmap: 320-ground-contact]. `error` is the deck reference's signed clearance
        // (negative = penetrating); `vn` the outward normal speed; `bog`/`budget` the rider's SLEWED copies of the
        // surface's two depth fields. Units are the subtlety: the engine's scalar is units/s^2 at 100 units = 1 m, so
        // the bog and deep zones return an ACCELERATION ~ A/100 m/s^2 (13.0 at the bog floor on snow); only the
        // above-surface zone's A/30 is a stiffness (1/s^2). Its damping is ONE-SIDED there: -P*vn applies only while
        // separating. The same row A supplies the grounded normal load, so the bog-zone equilibrium is
        // `-bog * cos(slope)` before banking. GroundTick also preserves the banked residual [Trailmap: 330-bank-force].
        // The budget is not the sink; it is where the capped pushout starts to intervene.
        float ContactResponse(float A, float P, float error, float vn, float bog, float budget)
        {
            float accel = A / 100f;                                              // engine units/s^2 -> m/s^2
            if (error > 0f) return -(A / 30f) * error - (vn > 0f ? P * vn : 0f); // above: soft pull, damped only if separating
            if (bog < 1e-4f) bog = 1e-4f;                                        // guard a degenerate slewed field
            if (error > -bog) return -accel * (error / bog) - P * vn;            // bog zone: 0 -> A across the soft give
            float span = budget - bog;
            if (span < 1e-4f) span = 1e-4f;
            float e = error < -budget ? -budget : error;
            return accel * (1f - 2f * (e + bog) / span) - P * vn;                // deep: A at -bog, 3A at -budget
        }

        // ---- Surface cache (copied shape from SurfaceDetector) -----------------------------------------

        void CacheSurfaces()
        {
            if (collisionRoot == null)
            {
                _colliders = new Collider[0]; _types = new int[0];
                _meshTris = new int[0][]; _meshNorms = new Vector3[0][];
                _idxCacheCol = null; _idxCacheVal = -1; // no surfaces -> the memo must not return a stale index into the empty list
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
                // so SmoothNormal can barycentric-blend them (the fallback contact normal when the analytic patch path
                // isn't available). Read ONCE here (each getter allocates). Guarded: a non-readable / normalless mesh
                // leaves these null and the ride falls back to the raw hit normal, so an un-rebaked terrain still works.
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
            _idxCacheCol = null; _idxCacheVal = -1; // the collider->index memo is stale once the list is rebuilt
        }

        // One-entry memo: the probes/sweeps call this per hit, but you ride the SAME Surf_ collider (and re-hit the same
        // few props) for many consecutive frames, so caching the last collider->index turns the linear scan into one
        // compare on the common path. Caches the -1 (not-a-terrain-surface) result too, so a prop/wall hit recurring every
        // frame doesn't re-scan the whole list. Invalidated in CacheSurfaces when _colliders is rebuilt.
        private Collider _idxCacheCol;
        private int _idxCacheVal = -1;
        int IndexOf(Collider col)
        {
            if (col == _idxCacheCol) return _idxCacheVal;
            for (int i = 0; i < _colliders.Length; i++)
                if (_colliders[i] == col) { _idxCacheCol = col; _idxCacheVal = i; return i; }
            _idxCacheCol = col; _idxCacheVal = -1; // hit something solid that isn't a tagged surface (a prop) - ride it with defaults
            return -1;
        }

        // A non-terrain collider the board should still RIDE as ground (rideSolidProps): a real solid prop collision
        // proxy - the PropsCollision_* bucket meshes the importer bakes from the game's PINNED collision proxies
        // (bridges, ramps, structures - e.g. Mesa's bridgesurface). This is the SSX-faithful "ride any solid surface"
        // behaviour. Deliberately EXCLUDES: the AABB sign/billboard approximation boxes (Bounds_*, not a real surface),
        // foliage swish triggers (isTrigger), and knockable crash bags (PhysicsProp - their colliders aren't named
        // PropsCollision_*). The probes assign such a hit propRideSurfaceType so the feel/audio tables have a value.
        bool IsRideableProp(Collider col)
        {
            if (!rideSolidProps || col == null || col.isTrigger) return false;
            string nm = col.name;
            return nm != null && nm.StartsWith("PropsCollision_");
        }

        // True when hitting this collider should put the rider back on the course: a prop whose own collision carries
        // the host's MainType-13 reset (docs/053). The engine hangs that node off the prop's COLLISION slot, so it is
        // contact-driven - smack the shut megaplex door and you're reset; once it has opened there is nothing left to
        // hit. That is why an ANIMATED reset host gets this tag instead of a ResetZone box: no volume can both cover a
        // shut door and vacate the opening as its panels swing away.
        //
        // Read off the NAME, like IsRideableProp - the board already has the name in hand, and a component here would
        // put another GetComponent on the swept-hit path (an allocating GetComponents scan in Udon). The tag is an
        // "_R" token sitting ahead of any "_T<surface>" tail, so a door that is also a ride surface parses as both.
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

        // The SurfaceType a PROP collider uses for ride feel + audio. New bundle buckets carry it on PropBounce;
        // the legacy animated-prop path carries the same value in a "_T12" name suffix. One-entry cache: you ride one
        // collider for many frames, so the component/name lookup runs only on a collider change. -1 = untyped object.
        Collider _propTypeCol;
        int _propTypeVal = -1;
        int PropAudioSurfaceType(Collider col)
        {
            if (col == _propTypeCol) return _propTypeVal;
            _propTypeCol = col;
            _propTypeVal = -1;
            PropBounce prop = col.GetComponent<PropBounce>();
            if (prop != null && prop.SurfaceType >= 0)
            {
                _propTypeVal = prop.SurfaceType;
                return _propTypeVal;
            }
            string nm = col.name;
            if (nm == null) return -1;
            // Accept only a "_T<digits>" TAIL: walk the digit run back from the end, then require the "_T" before it.
            int i = nm.Length - 1;
            bool any = false;
            while (i >= 0)
            {
                int d = (int)nm[i] - (int)'0';
                if (d < 0 || d > 9) break;
                i--; any = true;
            }
            if (any && i >= 1 && nm[i] == 'T' && nm[i - 1] == '_')
            {
                int v = 0;
                for (int k = i + 1; k < nm.Length; k++) v = v * 10 + ((int)nm[k] - (int)'0');
                _propTypeVal = v;
            }
            return _propTypeVal;
        }

        // Barycentric blend of the hit triangle's three baked vertex normals -> a contact normal that follows the smooth
        // Bezier surface instead of the faceted triangle (docs/021). ci = collider index, tri = RaycastHit.triangleIndex,
        // bary = its barycentricCoordinate. Returns flatN (the raw hit normal) whenever the data isn't there, so the ride
        // is never worse than before, only smoother.
        Vector3 SmoothNormal(int ci, int tri, Vector3 bary, Vector3 flatN)
        {
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
            // The baked normals are in the collision mesh's LOCAL space; the board works in WORLD space. Rotate by the
            // collider's world rotation (correct for a rotated, uniformly-scaled frame), then normalize.
            n = (_colliders[ci].transform.rotation * n).normalized;
            return Vector3.Dot(n, flatN) > 0f ? n : flatN; // accept the smooth normal when it agrees with the hit (any orientation, incl. walls); reject a degenerate flip
        }

        // Effective local-FX switch: YOUR OWN board's wake ribbon + snow spray, gated by the Tuning Board's PERF row "My
        // board FX" (diagnosticsBoard.boardLocalFx) so a weak client can drop that per-frame Udon for itself. Distinct from
        // remoteRiderFx (which gates OTHER riders' boards). Null diagnosticsBoard => on (the editor default stands).
        bool LocalFxOn() { return diagnosticsBoard == null || diagnosticsBoard.boardLocalFx; }

        // Resolve a ground-probe hit into the contact point + normal (-> _pPoint/_pGroundY/_pNormal), preferring the
        // EXACT analytic bicubic patch surface (approach A: terrainPatches Newton-refines the real surface the PS2 rode)
        // over the faceted fallback. Used by both ProbeDown (rayDir = down) and ProbeContact (rayDir = -contactN), so it
        // works for walls too. The patch path is gated on ci >= 0 (a real terrain Surf_ collider, not a prop) and on the
        // refine converging; a prop, missing patch data, or a non-convergence falls back to the faceted hit POINT plus the
        // smooth analytic NORMAL (SmoothNormal) so nothing regresses. 'ty' is the terrain SurfaceType (the patch-match
        // hint); flatPoint/flatNormal are the raw faceted hit. rayOrigin/rayDir are the exact ray the caller cast (world).
        void ResolveContact(int ci, int tri, Vector3 bary, Vector3 flatPoint, Vector3 flatNormal, int ty, Vector3 rayOrigin, Vector3 rayDir)
        {
            Vector3 cp, cn;
            _pAnalytic = false;
            _pSource = 2;
            if (terrainPatches != null)
            {
                // The holder decodes this triangle's patch + corner (u,v), then runs the contract-bounded exact
                // probe/patch solve from that close seed (docs/021). ci/tri/bary come straight from the raycast.
                // Called even for a PROP hit (ci < 0): Refine self-rejects it and clears the analytic warm start.
                terrainPatches.Refine(ci, tri, bary, flatPoint, rayDir);
                if (terrainPatches.RFound) { cp = terrainPatches.RPoint; cn = terrainPatches.RNormal; _pAnalytic = true; _pSource = 1; }
                else { cn = SmoothNormal(ci, tri, bary, flatNormal); cp = flatPoint; } // props / un-baked / miss
            }
            else { cn = SmoothNormal(ci, tri, bary, flatNormal); cp = flatPoint; }

            // CLAMP the SINK: the analytic surface may LIFT the deck freely (the convex poke-through fix), but it may only
            // SINK it BELOW the faceted COLLIDER by SinkAllowance() - the depth the raised obstacle-sweep capsule
            // (sweepFootClearance) can ride below the facet before it embeds and the collide-and-slide jams ("stuck
            // off-trail"). Within the allowance the deck rides the TRUE concave dip (so dips feel like the convex bumps);
            // past it, the contact clamps to the allowance depth so the sweep stays clear. Measured along the probe ray:
            // t = distance from origin, larger t = deeper.
            Vector3 d = rayDir.sqrMagnitude > 1e-12f ? rayDir.normalized : Vector3.down;
            float tFlat = Vector3.Dot(flatPoint - rayOrigin, d);
            float tCp = Vector3.Dot(cp - rayOrigin, d);
            float allow = SinkAllowance();
            if (tCp > tFlat + allow) cp = rayOrigin + d * (tFlat + allow);   // sank past the safe budget -> hold it there

            _pNormal = cn;
            _pPoint = cp;
            _pGroundY = cp.y;
        }

        // How far (world m) the resolved contact may sit BELOW the faceted collider before the raised obstacle-sweep
        // capsule (sweepFootClearance) would embed in the facet and the collide-and-slide jam. Lifting the sweep's bottom
        // to ~torso height buys this budget, so the deck + legs ride down into the real concave dip while the upper body
        // still collides; the contact clamps once it would dip deeper. Capped by the active probe-above reach so a deeply-sunk board's next
        // down-probe ray still starts above the facet (else it loses its broad-phase anchor). The deck reference itself
        // rides at the contact point (settling a bog depth into it), so both limits measure from the contact. No sweep
        // capsule (_capRadius == 0, an old board) -> only the ray cap applies.
        float SinkAllowance()
        {
            float byRay = RIDE_PROBE_ABOVE - 0.1f;             // keep the next down-ray origin above the facet
            if (byRay < 0f) byRay = 0f;
            if (_capRadius <= 0f) return byRay;                // obstacle sweep off -> nothing to embed
            float swLow = _capLow + sweepFootClearance; if (swLow > _capHigh) swLow = _capHigh;
            float byCap = swLow - _capRadius - 0.05f;          // sweep-capsule bottom stays ~5 cm above the facet
            if (byCap < 0f) byCap = 0f;
            return byCap < byRay ? byCap : byRay;              // the tighter of the two limits
        }

        // "Surf_5" -> 5 ; -1 if unparseable. Hand-rolled (no int.Parse) to stay safely inside Udon.
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
