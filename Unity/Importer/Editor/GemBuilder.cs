#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Places an authored course's GEM PICKUPS (Slopesmith's Gems.json -> manifest.Gems, Slopesmith docs/014). These are the
    // AUTHORED gems - the collectible half of the trick layer - as opposed to the EXTRACTED gems PropBuilder pulls
    // out of a level's SSF (MainType-14 -> spinner Divert). The course ships the donor level's tier crystals in
    // gltf/gems.glb (manifest.Gems.TierNodes: the same yellow x2 / orange x3 / red x5 models the ISO packer
    // clones), instantiated per gem by Value; a course without gem art falls back to a synthesized octahedron.
    // Both reuse the SAME runtime as the extracted gems: each gem gets a collectible trigger + GemMarker, and
    // one shared SpinnerMarker revolves them all from a single update (the platform wiring pass realizes
    // both). Positions are root-local mesh space, like the other builders.
    public class GemBuilder
    {
        readonly ImportConfig _cfg;
        readonly MaterialFactory _materials;
        public GemBuilder(ImportConfig cfg, MaterialFactory materials) { _cfg = cfg; _materials = materials; }

        public void Build(Transform root)
        {
            if (!_cfg.EmitGems) return;

            // Re-runnable (the standalone refresh menu): drop any prior build.
            var old = root.Find("Gems"); if (old != null) Object.DestroyImmediate(old.gameObject);

            var reader = new BundleManifestReader(_cfg);
            if (!reader.Exists || reader.Gems.Count == 0) return;   // no bundle / this level authored no gems

            var gemRoot = new GameObject("Gems");
            gemRoot.transform.SetParent(root, false);
            // Gems.json is the authored form of the same native pickup layer: retail creates it only for Showoff.
            // One marker on the root switches renderers, triggers, audio and the shared spinner as a unit.
            var mode = gemRoot.AddComponent<ModeVisibilityMarker>();
            mode.ModeMask = 2;
            if (_cfg.GateShowoffRails) gemRoot.SetActive(false); // optional editor/default preview = Freeride

            // Native tier crystals from gems.glb when the course ships them; the synthesized octahedron otherwise.
            var tiers = LoadTierMeshes(reader);
            Mesh fallback = null; Material fallbackMat = null;
            if (tiers == null)
            {
                fallback = BuildOctahedron(_cfg.GemMeshRadius);
                AssetDatabase.CreateAsset(fallback, _cfg.MatFolder + "/authored_gem.asset"); // persist with the scene
                fallbackMat = BuildGemMaterial();
            }

            // Per-tier pickup chimes (game-code driven: x2->116, x3->117, x5->118 in the MAIN bank), shared across gems.
            var clips = new Dictionary<int, AudioClip>();
            if (_cfg.GemPickup)
            {
                LoadClip(clips, 2, _cfg.GemPickupClipX2);
                LoadClip(clips, 3, _cfg.GemPickupClipX3);
                LoadClip(clips, 5, _cfg.GemPickupClipX5);
            }

            // One shared spinner manager revolves every gem (the same one-Update-for-all pattern the extracted gems use).
            var spinTargets = new List<Transform>();
            var spinAxes = new List<Vector3>();
            var spinDps = new List<float>();
            var spinPhase = new List<float>();

            int pick = 0;
            for (int i = 0; i < reader.Gems.Count; i++)
            {
                var g = reader.Gems[i];
                var go = new GameObject($"Gem_{i}_x{g.Value}");
                go.transform.SetParent(gemRoot.transform, false);
                go.transform.localPosition = g.Center;
                (Mesh mesh, Material[] mats) tier = tiers != null ? tiers[GemTier(g.Value)] : (fallback, new[] { fallbackMat });
                go.AddComponent<MeshFilter>().sharedMesh = tier.mesh;
                var mr = go.AddComponent<MeshRenderer>();
                mr.sharedMaterials = tier.mats;

                spinTargets.Add(go.transform);
                spinAxes.Add(Vector3.up);                                  // revolve about world vertical, like the real gems
                spinDps.Add(_cfg.SpinnerDegreesPerSec);
                spinPhase.Add((i * 137.50776f) % 360f);                   // golden-angle spread so they're out of sync

                if (_cfg.GemPickup) { AttachPickup(go, tier.mesh, g.Value, clips); pick++; }
            }

            // Tag the shared root now that every gem transform exists.
            var spinMk = gemRoot.AddComponent<SpinnerMarker>();
            spinMk.Targets = spinTargets.ToArray();
            spinMk.Axes = spinAxes.ToArray();
            spinMk.DegreesPerSecond = spinDps.ToArray();
            spinMk.PhaseDegrees = spinPhase.ToArray();

            Debug.Log($"OpenSlope: authored gems -> {reader.Gems.Count} pickups under Gems " +
                      $"({(tiers != null ? "native tier crystals" : "synthesized crystal")}, " +
                      $"{(_cfg.GemPickup ? pick + " collectible, chime " + clips.Count + "/3 tiers" : "spin-only")}), " +
                      $"revolving @ {_cfg.SpinnerDegreesPerSec} deg/s.");
        }

        // A gem Value's crystal tier - the SAME bucketing the ISO packer uses to pick a shipped gem to clone
        // (<=2 yellow x2, <=4 orange x3, else red x5), so Unity and the PS2 show the same crystal.
        static int GemTier(int value) => value <= 2 ? 2 : value <= 4 ? 3 : 5;

        // Load the course's native tier crystals from gltf/gems.glb (manifest.Gems.TierNodes): one shared Mesh +
        // materials per tier, persisted as assets. Missing glb / nodes -> null (the octahedron stands in). A tier
        // the course didn't ship (no gems of that value) maps to the nearest shipped one.
        Dictionary<int, (Mesh mesh, Material[] mats)> LoadTierMeshes(BundleManifestReader reader)
        {
            if (reader.GemTierNodes == null || reader.GemTierNodes.Count == 0) return null;
            string glb = Path.Combine(Path.GetDirectoryName(Application.dataPath), _cfg.LevelFolder + "/gltf/gems.glb");
            if (!File.Exists(glb)) { Debug.LogWarning("OpenSlope: authored gems - manifest lists TierNodes but gltf/gems.glb is missing; re-run `snowknife gltf`. Using the synthesized crystal."); return null; }

            var byName = new Dictionary<string, GlbMeshLoader.Node>(System.StringComparer.Ordinal);
            foreach (var n in GlbMeshLoader.Load(glb, _cfg.WorldScale)) if (!byName.ContainsKey(n.Name)) byName[n.Name] = n;

            var loaded = new Dictionary<int, (Mesh mesh, Material[] mats)>();
            foreach (var kv in reader.GemTierNodes)
            {
                if (!byName.TryGetValue(kv.Value, out var node) || node.Prims.Count == 0) continue;
                var verts = new List<Vector3>(); var uv = new List<Vector2>(); var nrm = new List<Vector3>();
                var subTris = new List<int[]>(); var mats = new Material[node.Prims.Count];
                for (int s = 0; s < node.Prims.Count; s++)
                {
                    var p = node.Prims[s]; int b = verts.Count;
                    verts.AddRange(p.Positions);
                    if (p.Normals != null) nrm.AddRange(p.Normals);
                    if (p.Uv0 != null) uv.AddRange(p.Uv0);
                    var t = new int[p.Indices.Length];
                    for (int k = 0; k < t.Length; k++) t[k] = p.Indices[k] + b;
                    subTris.Add(t);
                    _materials.Resolve(p.Material, out string tex, out List<string> frames, out MaterialFactory.ScrollSpec? scroll, out _, out _);
                    mats[s] = _materials.Build(tex, frames, scroll);
                }
                var m = new Mesh { name = $"AuthoredGemX{kv.Key}", indexFormat = UnityEngine.Rendering.IndexFormat.UInt32 };
                m.SetVertices(verts);
                if (uv.Count == verts.Count) m.SetUVs(0, uv);
                if (nrm.Count == verts.Count) m.SetNormals(nrm);   // outward normals already baked by snowknife
                m.subMeshCount = subTris.Count;
                for (int s = 0; s < subTris.Count; s++) m.SetTriangles(subTris[s], s, calculateBounds: false);
                m.RecalculateBounds();
                AssetDatabase.CreateAsset(m, _cfg.MatFolder + $"/authored_gem_x{kv.Key}.asset");
                loaded[kv.Key] = (m, mats);
            }
            if (loaded.Count == 0) return null;

            // fill the tiers the course didn't ship with the nearest shipped one, so lookups never miss
            foreach (var tier in new[] { 2, 3, 5 })
            {
                if (loaded.ContainsKey(tier)) continue;
                int best = -1, bestD = int.MaxValue;
                foreach (var k in loaded.Keys) { int d = Mathf.Abs(k - tier); if (d < bestD) { bestD = d; best = k; } }
                loaded[tier] = loaded[best];
            }
            return loaded;
        }

        // A collectible gem: a trigger sphere + kinematic Rigidbody (so both the walking player and the riding board's
        // RiderProbe fire) + GemMarker, exactly like PropBuilder.AttachGemPickup - the platform wiring pass realizes
        // the pop / chime / grow-back behaviour. A sphere (not a box) so the gem's spin never sweeps its trigger edge;
        // the catch volume tracks the crystal's own size (native tiers differ; the octahedron matches its radius).
        void AttachPickup(GameObject go, Mesh gm, int value, Dictionary<int, AudioClip> clips)
        {
            var rb = go.AddComponent<Rigidbody>();
            rb.isKinematic = true;
            rb.useGravity = false;

            var sc = go.AddComponent<SphereCollider>();
            sc.isTrigger = true;
            sc.center = gm.bounds.center;
            float ext = Mathf.Max(gm.bounds.extents.x, Mathf.Max(gm.bounds.extents.y, gm.bounds.extents.z));
            sc.radius = Mathf.Max(1f, ext * Mathf.Max(0.05f, _cfg.GemPickupRadiusScale));

            AudioClip clip = NearestTierClip(clips, value);
            AudioSource chime = clip != null ? AttachChime(go, clip) : null;

            var mk = go.AddComponent<GemMarker>();
            mk.Multiplier   = value;
            mk.pickupSound  = chime;
            mk.minRideSpeed = _cfg.GemMinRideSpeed;
            mk.pickupVolume = 1f;
        }

        // The nearest authored tier's chime: an exact x2/x3/x5 match, else the closest of the three loaded clips.
        static AudioClip NearestTierClip(Dictionary<int, AudioClip> clips, int value)
        {
            if (clips == null || clips.Count == 0) return null;
            if (clips.TryGetValue(value, out var exact)) return exact;
            AudioClip best = null; int bestD = int.MaxValue;
            foreach (var kv in clips) { int d = Mathf.Abs(kv.Key - value); if (d < bestD) { bestD = d; best = kv.Value; } }
            return best;
        }

        AudioSource AttachChime(GameObject go, AudioClip clip)
        {
            var src = go.AddComponent<AudioSource>();
            src.clip = clip;
            src.playOnAwake = false;
            src.loop = false;
            src.volume = 1f;
            src.spatialBlend = 1f;
            src.dopplerLevel = 0f;
            src.rolloffMode = AudioRolloffMode.Linear;
            src.minDistance = _cfg.GemPickupMinDistance;
            src.maxDistance = Mathf.Max(_cfg.GemPickupMinDistance, _cfg.GemPickupMaxDistance);
            go.AddComponent<SpatialAudio>();   // the wiring pass pairs it (VRChat force-spatializes bare sources otherwise)
            return src;
        }

        void LoadClip(Dictionary<int, AudioClip> into, int tier, string rel)
        {
            if (string.IsNullOrEmpty(rel)) return;
            var clip = AssetDatabase.LoadAssetAtPath<AudioClip>(_cfg.LevelFolder + "/Audio/" + rel);
            if (clip != null) into[tier] = clip;
        }

        // A unit octahedron scaled to `r` (mesh-space units - the level root's Scale shrinks it to world), flat-shaded
        // per face so the gem reads as a faceted crystal, matching the editor's placement markers.
        static Mesh BuildOctahedron(float r)
        {
            Vector3[] p = { new(0, r, 0), new(0, -r, 0), new(r, 0, 0), new(-r, 0, 0), new(0, 0, r), new(0, 0, -r) };
            int[,] faces = { {0,2,4},{0,4,3},{0,3,5},{0,5,2},{1,4,2},{1,3,4},{1,5,3},{1,2,5} };
            var verts = new List<Vector3>(); var tris = new List<int>(); var norms = new List<Vector3>();
            for (int f = 0; f < 8; f++)
            {
                Vector3 a = p[faces[f, 0]], b = p[faces[f, 1]], c = p[faces[f, 2]];
                Vector3 n = Vector3.Cross(b - a, c - a).normalized;
                int baseIdx = verts.Count;
                verts.Add(a); verts.Add(b); verts.Add(c);
                norms.Add(n); norms.Add(n); norms.Add(n);
                tris.Add(baseIdx); tris.Add(baseIdx + 1); tris.Add(baseIdx + 2);
            }
            var m = new Mesh { name = "AuthoredGem" };
            m.SetVertices(verts); m.SetNormals(norms); m.SetTriangles(tris, 0);
            m.RecalculateBounds();
            return m;
        }

        // A lit gem material tinted to the authored gem colour + a matching emission so it glows. Shader chosen by
        // availability (URP Lit on Basis, Standard on built-in), falling back to an unlit colour.
        Material BuildGemMaterial()
        {
            Color c = _cfg.GemColor;
            Shader sh = Shader.Find("Universal Render Pipeline/Lit") ?? Shader.Find("Standard") ?? Shader.Find("Sprites/Default");
            var mat = new Material(sh) { name = "authored_gem" };
            if (mat.HasProperty("_BaseColor")) mat.SetColor("_BaseColor", c); else if (mat.HasProperty("_Color")) mat.SetColor("_Color", c);
            if (mat.HasProperty("_EmissionColor")) { mat.EnableKeyword("_EMISSION"); mat.SetColor("_EmissionColor", c * 0.6f); }
            AssetDatabase.CreateAsset(mat, _cfg.MatFolder + "/authored_gem.mat");
            return mat;
        }
    }
}
#endif
