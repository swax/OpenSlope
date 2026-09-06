#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // SSX collision VOLUMES that wire to the rideable board (docs/053): the OOB/reset zones (MainType-13, which snap a
    // rider back onto the course) and the directional boost volumes (MainType-0/Sub7, a shove along an authored
    // vector). Both are invisible BoxCollider(isTrigger) boxes the board's RiderProbe sweeps - the same pattern as the
    // firework / boost-pad triggers. snowknife bakes each volume's AABB (+ the dir/amount for boosts); this overlays the
    // trigger + a neutral marker the platform wiring pass realizes into the runtime behaviour. Stock trigger, no other wiring.
    public class VolumeBuilder
    {
        readonly ImportConfig _cfg;
        public VolumeBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform root)
        {
            var reader = new BundleManifestReader(_cfg);
            if (!reader.Exists) return;
            BuildResetZones(root, reader);
            BuildBoostVolumes(root, reader);
            BuildOobFloor(root);
        }

        // The terrain colliders, under EITHER name - we run at two different moments in that node's life. Mid FULL IMPORT
        // we build before ExposeLibraryAnchors, so they're still `Level/TerrainCollision` (TerrainBuilder's name). Run
        // standalone from OpenSlope > Refresh > Volumes on a finished map and the node has been reparented and renamed to
        // `OpenSlope_Map/Collision` - a SIBLING of the Level node we build under. Both paths must resolve, or the floor builds on
        // one entry point and silently skips on the other.
        Transform FindTerrainCollision(Transform root)
        {
            return root.Find("TerrainCollision")                                                    // mid-import
                ?? (root.parent != null ? root.parent.Find(MapLayout.CollisionName) : null)      // finished map
                ?? root.Find(MapLayout.CollisionName);                                           // custom layout
        }

        // The OOB FLOOR: one big trigger slab fitted under the whole map, so leaving the world is a PLACE YOU CROSS rather
        // than something the board infers per-frame. It is just another reset volume - same ResetZoneMarker, same
        // ResetZone, same TriggerReset - so it carries no runtime code of its own.
        //
        // Why a volume and not a check: SSX's out-of-bounds is 100% authored (the MainType-13 volumes above; the RE
        // finds no void check and no death plane anywhere on the player path). An inference cannot be made to work anyway -
        // a rail strung over water satisfies every condition one would test. The authored volumes ARE the boundary; this
        // catches a rider who leaves through a gap between them. See docs/031.
        //
        // TILTED to the slope (FitTerrainPlane): a level slab under a mountain's lowest point sits the whole vertical
        // extent of the run below the summit, so the drop to it is enormous at the top and small at the base. The fitted
        // plane is then pushed past the DEEPEST terrain vertex, which is what makes OobFloorDrop a GUARANTEED MINIMUM
        // clearance - the floor must never rise above rideable terrain, or a rider riding legitimately sits inside the
        // trigger and is reset on the spot. Thick enough that a rider at terminal velocity cannot tunnel it in a single
        // physics step, and no thicker: it is a trigger, and its bounds are what every rigidbody broadphases against.
        //
        // It must also be crossed BEFORE VRChat's respawn line, which yanks the player to spawn and off the board - this
        // floor is what carries them back ONTO THE COURSE instead. Map.SetRespawnHeightFromMap puts that line below this
        // floor's top face, so the ordering holds even where the tilt hangs the floor far under the terrain minimum.
        void BuildOobFloor(Transform root)
        {
            var old = root.Find("OobFloor"); if (old != null) Object.DestroyImmediate(old.gameObject);
            if (!_cfg.EmitOobFloor) return;

            var collision = FindTerrainCollision(root);
            if (collision == null) { Debug.LogWarning("OpenSlope: no terrain collision node - skipping the OOB floor."); return; }
            var cols = collision.GetComponentsInChildren<MeshCollider>();
            if (cols.Length == 0) { Debug.LogWarning("OpenSlope: no terrain colliders - skipping the OOB floor."); return; }

            Bounds b = cols[0].bounds;                                   // Collider.bounds is a WORLD-space AABB
            for (int i = 1; i < cols.Length; i++) b.Encapsulate(cols[i].bounds);

            // TILT THE FLOOR TO THE SLOPE. A mountain descends, so a level slab hung under its lowest point sits the whole
            // vertical extent of the run below the summit - fall off the top and you drop for ages before anything catches
            // you. Least-squares fit y = a*x + b*z + c through the terrain instead, so the floor runs PARALLEL to the
            // mountain and the drop to it is roughly constant wherever you leave.
            //
            // Hard safety constraint: the floor must never rise ABOVE rideable terrain, or you'd be inside the trigger
            // while legitimately riding and reset on the spot. A least-squares plane has terrain on BOTH sides of it by
            // construction, so after fitting we push the whole plane down past the single deepest terrain sample. That
            // makes OobFloorDrop a GUARANTEED MINIMUM clearance rather than a nominal one.
            Vector3 n = Vector3.up;                                      // floor normal (world)
            // A point ON the top face. It MUST be the point the plane was fitted about - the vertex CENTROID - not the
            // bounds centre. The fit is anchored at the centroid, and on a tilted plane any other XZ anchor slides the whole
            // floor vertically - on a steeply-fitted level, by most of the clearance.
            Vector3 top = new Vector3(b.center.x, b.min.y - _cfg.OobFloorDrop, b.center.z);   // fallback: a level slab
            float minClear = _cfg.OobFloorDrop, maxClear = b.size.y + _cfg.OobFloorDrop;

            if (_cfg.OobFloorTilt && FitTerrainPlane(cols, b, out float pa, out float pb, out Vector3 mean,
                                                     out float minRes, out float maxRes))
            {
                // Plane through the centroid, shifted down so even the deepest vertex clears it by OobFloorDrop.
                float shift = minRes - _cfg.OobFloorDrop;
                n = new Vector3(-pa, 1f, -pb).normalized;                // y = a*x + b*z + k  ->  normal (-a, 1, -b)
                top = new Vector3(mean.x, mean.y + shift, mean.z);       // on the fitted plane, at the centroid it's about
                minClear = _cfg.OobFloorDrop;                            // by construction, at the deepest vertex
                maxClear = maxRes - shift;                               // at the highest vertex above the plane
            }

            var go = new GameObject("OobFloor");
            go.transform.SetParent(root, false);
            go.transform.rotation = Quaternion.FromToRotation(Vector3.up, n);  // local +Y = the floor normal
            go.transform.position = top - n * (_cfg.OobFloorThickness * 0.5f); // box centre: half a thickness down the normal

            // Half-extents measured FROM the anchor point (which is the centroid, not the bounds centre - so the map is not
            // centred on it), plus the margin. BoxCollider.size is LOCAL, and we're parented under the Level node's uniform
            // WorldScale - divide it back out so the authored metres are the metres we get. The box is tilted, so also
            // divide by cos(tilt) to keep the slab covering the full world-XZ footprint.
            float halfX = Mathf.Max(top.x - b.min.x, b.max.x - top.x) + _cfg.OobFloorMargin;
            float halfZ = Mathf.Max(top.z - b.min.z, b.max.z - top.z) + _cfg.OobFloorMargin;
            float s = Mathf.Abs(go.transform.lossyScale.x);
            if (s < 1e-4f) s = 1f;
            float cos = Mathf.Max(0.2f, n.y);                            // tilt shrinks the footprint the box projects
            var box = go.AddComponent<BoxCollider>();
            box.isTrigger = true;
            box.center = Vector3.zero;
            box.size = new Vector3(halfX * 2f / cos, _cfg.OobFloorThickness, halfZ * 2f / cos) / s;
            go.AddComponent<ResetZoneMarker>();

            float tiltDeg = Vector3.Angle(Vector3.up, n);
            Debug.Log($"OpenSlope: OOB floor -> one {box.size.x * s * cos:F0} x {box.size.z * s * cos:F0} m trigger slab, " +
                      $"{_cfg.OobFloorThickness:F0} m thick, tilted {tiltDeg:F1}deg to the slope. Clearance below terrain: " +
                      $"{minClear:F0} m at the tightest, {maxClear:F0} m at the loosest. " +
                      "Falling through the world crosses it and resets onto the course.");
        }

        // Least-squares fit of y = a*x + b*z + c through the terrain's collision vertices (world space), so the OOB floor
        // can run parallel to the mountain instead of level under it. Also returns the residual range (how far terrain sits
        // below / above the fitted plane), which is what lets the caller drop the plane clear of ALL of it.
        //
        // Every vertex is walked, ONCE, into a cached world-space array. The residual pass in particular MUST be exhaustive:
        // minRes is what the caller shifts the plane past, so it is what makes the clearance a GUARANTEE. Strided, it would
        // only guarantee clearance over the vertices it happened to look at, and the ones it skipped can sit closer to (or
        // through) the floor. The fit itself could be strided; the guarantee cannot. Sums are accumulated in double about
        // the centroid: the map spans kilometres and sits kilometres from the origin, so raw x^2 sums lose the precision the
        // normal equations need.
        bool FitTerrainPlane(MeshCollider[] cols, Bounds b, out float a, out float bb, out Vector3 mean,
                             out float minRes, out float maxRes)
        {
            a = 0f; bb = 0f; mean = b.center; minRes = 0f; maxRes = 0f;

            var pts = new System.Collections.Generic.List<Vector3>();
            foreach (var mc in cols)
            {
                var mesh = mc.sharedMesh; if (mesh == null) continue;
                var vs = mesh.vertices; var tf = mc.transform;
                for (int i = 0; i < vs.Length; i++) pts.Add(tf.TransformPoint(vs[i]));
            }
            if (pts.Count < 16) return false;

            double sx = 0, sy = 0, sz = 0;
            for (int i = 0; i < pts.Count; i++) { sx += pts[i].x; sy += pts[i].y; sz += pts[i].z; }
            double mx = sx / pts.Count, my = sy / pts.Count, mz = sz / pts.Count;

            // Normal equations for y' = a*x' + b*z', about the centroid (so the constant term vanishes).
            double xx = 0, xz = 0, zz = 0, xy = 0, zy = 0;
            for (int i = 0; i < pts.Count; i++)
            {
                double dx = pts[i].x - mx, dy = pts[i].y - my, dz = pts[i].z - mz;
                xx += dx * dx; xz += dx * dz; zz += dz * dz; xy += dx * dy; zy += dz * dy;
            }
            double det = xx * zz - xz * xz;
            if (System.Math.Abs(det) < 1e-6) return false;               // degenerate spread (a line / a point)
            a  = (float)((xy * zz - zy * xz) / det);
            bb = (float)((zy * xx - xy * xz) / det);
            mean = new Vector3((float)mx, (float)my, (float)mz);

            // Residuals - how far each vertex sits above (+) or below (-) the fitted plane. EXHAUSTIVE, see above.
            minRes = float.PositiveInfinity; maxRes = float.NegativeInfinity;
            for (int i = 0; i < pts.Count; i++)
            {
                float r = (pts[i].y - mean.y) - (a * (pts[i].x - mean.x) + bb * (pts[i].z - mean.z));
                if (r < minRes) minRes = r;
                if (r > maxRes) maxRes = r;
            }
            return !float.IsInfinity(minRes) && !float.IsInfinity(maxRes);
        }

        void BuildResetZones(Transform root, BundleManifestReader reader)
        {
            var old = root.Find("ResetZones"); if (old != null) Object.DestroyImmediate(old.gameObject);
            if (!_cfg.EmitResetZones || reader.ResetZones.Count == 0) return;

            var rzRoot = new GameObject("ResetZones");
            rzRoot.transform.SetParent(root, false);
            // An ANIMATED host carries its reset on its own COLLISION instead (PropBuilder tags the collider "_R",
            // the board resets when it hits one). The engine hangs MainType-13 off the prop's collision slot, so it
            // is contact-driven; one static AABB here is the doorway itself, and would keep resetting a rider who is
            // riding through the open gap.
            // The same is true of a VISIBLE host with its own collision proxy - MERQUER's ParlamentBuilding, its
            // ConcreteWalls. It is a solid object in the world, so its reset fires when the rider HITS it, and a box
            // over its bounds resets a rider riding through the tunnel that runs under it. Snowknife marks those
            // ContactOnly; both kinds keep the "_R" tag PropBuilder puts on their collision.
            var animated = new HashSet<int>();
            foreach (var a in reader.Animated) animated.Add(a.Index);
            int skipped = 0, contact = 0;
            foreach (var z in reader.ResetZones)
            {
                if (animated.Contains(z.Index)) { skipped++; continue; }
                if (z.ContactOnly) { contact++; continue; }
                var go = new GameObject($"Reset_{z.Index}_{z.Name}");
                go.transform.SetParent(rzRoot.transform, false);
                go.transform.localPosition = z.Center;
                // Turned with the panel it stands for. Without this the slab would be the right SIZE in the
                // wrong orientation, which is worse than the old AABB rather than better.
                go.transform.localRotation = z.Rotation;
                NativeCollision.AddPassThroughBox(go, Vector3.zero,
                    z.Size + Vector3.one * _cfg.ResetZoneInflate, NativeCollision.TriangleProxy);
                go.AddComponent<ResetZoneMarker>();
            }
            Debug.Log($"OpenSlope: reset zones -> {reader.ResetZones.Count - skipped - contact} OOB/reset volume(s) under ResetZones " +
                      "(the reset zone snaps a board rider back onto the course; the authored MainType-13 boundaries)." +
                      (skipped > 0 ? $" {skipped} animated host(s) reset on contact with their own collision instead." : "") +
                      (contact > 0 ? $" {contact} visible host(s) with their own collision proxy likewise." : ""));
        }

        // The MainType-0 BOOST FAMILY (docs/053). Four sub-types share one mechanism - speed along an axis approaching a
        // target as a first-order lag, add-only ([Trailmap: 360-node-apply]) - so one trigger + one marker carries all of
        // them behind a Kind tag, and the runtime behaviour switches on it.
        //
        // Two frame conversions happen HERE, where the Level node's -90X/0.01 is available, so the runtime never has to
        // know about mesh space. Both land on a RELATIVE quantity, and that is load-bearing: the importer recenters the
        // Level once every child is built, which moves these volumes but would leave any baked absolute position behind.
        //   - ALTITUDES (the vertical lift's target) are mesh-space Z; run BOTH that point and the volume's own centre
        //     through the Level transform and bake the DIFFERENCE of their world Y. Under the -90X that Z is the only
        //     component reaching world Y, so it is exact, and a difference of two points in one frame survives the
        //     recenter. The behaviour adds it back to its own centre at Start.
        //   - LENGTHS (the snap tolerance, the stage floor offset) are SSX units; scale them by the Level node's own.
        // DIRECTIONS stay local and are TransformDirection'd by the behaviour, which is what carries them to world - the
        // trigger itself is unrotated, so that reproduces the engine's authored world vector and nothing else.
        void BuildBoostVolumes(Transform root, BundleManifestReader reader)
        {
            var old = root.Find("BoostVolumes"); if (old != null) Object.DestroyImmediate(old.gameObject);
            if (!_cfg.EmitBoostVolumes || reader.BoostVolumes.Count == 0) return;

            var bvRoot = new GameObject("BoostVolumes");
            bvRoot.transform.SetParent(root, false);
            float unit = Mathf.Abs(root.lossyScale.x);        // SSX unit -> world metres
            int directional = 0, lift = 0, lap = 0, tube = 0;

            foreach (var v in reader.BoostVolumes)
            {
                var go = new GameObject($"BoostVol_{v.Index}_{v.Name}");
                go.transform.SetParent(bvRoot.transform, false);
                go.transform.localPosition = v.Center;
                // The collider is a BROADPHASE, not the boundary. It is grown so its callback is already running by the
                // time a fast rider reaches the real box; the behaviour then narrows to the authored extent, so the
                // margin never moves where the push starts. Engine parallel: the world grid offers candidates, and
                // WorldEntity_IntersectLineQuery decides ([Trailmap: 130-modes, 360-node-apply]).
                var box = go.AddComponent<BoxCollider>();
                box.center = Vector3.zero;
                box.size = v.Size + Vector3.one * _cfg.BoostVolumeInflate;
                box.isTrigger = true;

                var mk = go.AddComponent<BoostVolumeMarker>();
                mk.Kind     = KindIndex(v.Kind);
                mk.LocalDir = Dir(v.Dir);
                mk.Target   = v.Amount * _cfg.BoostVolumeSpeedScale;
                mk.Rate     = v.Rate * _cfg.BoostVolumeRateScale;
                mk.Mode     = v.Mode;      // NOT scaled by anything: a lifetime rule, not a tuning knob
                mk.Seconds  = v.Seconds;
                mk.BroadphaseMargin = _cfg.BoostVolumeInflate * unit * 0.5f;   // per FACE, in world metres

                // A RISE above this volume's own centre, not an absolute world Y - both points run through the same
                // Level transform, so the difference survives the recenter that follows the build (LevelImporter).
                mk.TargetAltitudeRise = root.TransformPoint(new Vector3(0f, 0f, v.TargetZ)).y
                                      - root.TransformPoint(v.Center).y;
                mk.SnapTolerance      = v.SnapTolerance * unit;

                mk.LocalStageAxis   = v.Axis.sqrMagnitude > 1e-6f ? v.Axis.normalized : Vector3.right;
                mk.StageFloorOffset = v.StageFloorOffset * unit;

                // A tube-end volume always bakes three stages; anything else leaves the list empty and these stay at
                // their harmless defaults, since the behaviour never reads them for another Kind.
                if (v.Stages != null && v.Stages.Count >= 3)
                {
                    mk.Stage0Dir = Dir(v.Stages[0].Dir); mk.Stage0Speed = v.Stages[0].Speed * _cfg.BoostVolumeSpeedScale;
                    mk.Stage1Dir = Dir(v.Stages[1].Dir); mk.Stage1Speed = v.Stages[1].Speed * _cfg.BoostVolumeSpeedScale;
                    mk.Stage2Dir = Dir(v.Stages[2].Dir); mk.Stage2Speed = v.Stages[2].Speed * _cfg.BoostVolumeSpeedScale;
                }

                switch (mk.Kind) { case 1: lift++; break; case 2: lap++; break; case 3: tube++; break; default: directional++; break; }
            }
            Debug.Log($"OpenSlope: boost volumes -> {reader.BoostVolumes.Count} under BoostVolumes: {directional} directional, " +
                      $"{lift} vertical lift, {lap} lap-gated, {tube} tube-end. Each drives the rider's velocity EVERY " +
                      $"TICK they're inside (a first-order lag toward the authored target, add-only), not once on the " +
                      $"cross (speed x {_cfg.BoostVolumeSpeedScale}, rate x {_cfg.BoostVolumeRateScale}).");
        }

        static Vector3 Dir(Vector3 v) => v.sqrMagnitude > 1e-6f ? v.normalized : Vector3.forward;

        // The manifest's Kind string as the runtime's switch index. An unknown kind falls back to the base directional
        // push rather than dropping the volume: a newer bundle then still shoves the rider roughly the right way.
        static int KindIndex(string kind)
        {
            switch (kind)
            {
                case "vertical-lift": return 1;
                case "lap-gated":     return 2;
                case "tube-end":      return 3;
                default:              return 0;
            }
        }

        // OpenSlope/Refresh/Reset & Boost Volumes lives in VRC (the platform Refresh menus): re-building the volumes needs the wiring pass to realize the
        // markers, so it can't sit in the neutral importer.
    }
}
#endif
