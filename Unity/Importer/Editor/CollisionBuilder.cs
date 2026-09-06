#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Builds walkable colliders for Unity from the snowknife BUNDLE: the prop proxy colliders (collision.glb +
    // manifest bounce buckets), the computed-bounds boxes for proxy-less signs/billboards, and the zero-response-mass leaf
    // swish triggers. Terrain collision is built by TerrainBuilder (also from the bundle). snowknife did the
    // engine-agnostic work - parsing PropsCollision.obj, bucketing by the authored PlayerBounce tier + collision
    // sound, computing the no-proxy bounds, and selecting the foliage cutouts - so this just turns the manifest +
    // glb into MeshColliders / BoxColliders with the right metadata. See docs/009-collision.md, Snowknife docs/034.
    public class CollisionBuilder
    {
        readonly ImportConfig _cfg;
        readonly BundleManifestReader _bundle;

        public CollisionBuilder(ImportConfig cfg)
        {
            _cfg = cfg; _bundle = new BundleManifestReader(cfg);
        }

        // Keep a contact shape on exactly the same mode-presence bitset as the instance that produced it.
        // Disabling the collider GameObject also removes its bounce/audio/trigger behavior for that mode.
        void MarkMode(GameObject go, int modeMask)
        {
            if (go == null || modeMask == 7) return;
            var marker = go.AddComponent<ModeVisibilityMarker>();
            marker.ModeMask = modeMask;
            int previewBit = _cfg.GateShowoffRails ? 4 : 2;
            go.SetActive((modeMask & previewBit) != 0);
        }

        // Import the game's real collision proxies (collision.glb position-only meshes + manifest bounce buckets;
        // Snowknife docs/034) as invisible MeshColliders, bucketed by bounce tier + collision sound. Those proxies are what
        // the player actually collided with in-game - authored for collision and lighter than render geometry. Each
        // bucket becomes one MeshCollider with the prop-bounce behaviour metadata component, so the rideable board can use
        // real per-prop bounce tiers without thousands of separate colliders.
        public void ImportCollision(Transform parent)
        {
            if (_bundle.HasCollision && _bundle.Buckets.Count > 0) { ImportBucketsFromBundle(parent); return; }
            Debug.Log("OpenSlope: prop collision - no buckets in the bundle (collision.glb); skipping proxy colliders.");
        }

        // Hang a material's real impact clip on a collider GameObject as a positional AudioSource. Two consumers:
        //   - STATIC collision (bounds boxes, proxy buckets): the board reads the clip off the hit collider and plays
        //     it on its own source - no Udon on the prop (split per-material so each merged collider = one clip; docs/009).
        //   - PHYSICS props (crash bags / path markers): PropBuilder.BuildPhysics calls this too, and the physics-prop behaviour
        //     plays this source itself on a knock (the obstacle sweep ignores their triggers, so the board never sounds
        //     them; docs/016). Here the prop has its own GameObject at the real spot, so the positional source is right.
        // Snowknife resolves the event while it still has the user's map-local SoundIndex. The importer consumes
        // that explicit path and deliberately has no embedded retail event table fallback.
        public AudioClip LoadImpactClip(int collisonSound, string soundClip = null)
        {
            if (!string.IsNullOrEmpty(soundClip))
            {
                string rel = soundClip.Replace('\\', '/').TrimStart('/');
                // Authored clips remain basename-only under Sounds/. Native environmental ExternalSounds carry an
                // auditable level-relative Audio/SFX/<fixed-bank>/000.wav path from the bundle.
                string explicitPath = rel.StartsWith("Audio/SFX/", System.StringComparison.OrdinalIgnoreCase)
                    ? _cfg.LevelFolder + "/" + rel
                    : _cfg.LevelFolder + "/Sounds/" + Path.GetFileName(rel);
                var staged = AssetDatabase.LoadAssetAtPath<AudioClip>(explicitPath);
                if (staged != null) return staged;
            }
            return null;
        }

        public bool AttachImpactSound(GameObject go, int collisonSound, string soundClip = null)
        {
            var clip = LoadImpactClip(collisonSound, soundClip);
            if (clip == null) return false;

            var src = go.AddComponent<AudioSource>();
            src.clip = clip;                       // the board calls PlayOneShot(a.clip, vol); the clip rides on the source
            src.playOnAwake = false;
            src.loop = false;
            src.volume = 1f;
            src.spatialBlend = 1f;                 // positional - the impact comes from the prop you hit
            src.dopplerLevel = 0f;
            src.rolloffMode = AudioRolloffMode.Linear;
            src.minDistance = 2f;
            src.maxDistance = 40f;

            // Tag it so the platform wiring pass adds a spatial pairing that reads this 3D curve. VRChat force-spatializes
            // any BARE AudioSource at world load with its own 40 m default that DISCARDS our rolloff (and the build
            // validator warns), and a bare PlayOneShot source can come out wrong/silent on upload. Without the pairing the
            // impact clips never sounded.
            go.AddComponent<SpatialAudio>();
            return true;
        }

        // General positional one-shot carrier: hang an arbitrary AudioClip on `go` as a 3D AudioSource (+ the
        // SpatialAudio tag, same reason as AttachImpactSound) and return it, for a runtime behaviour to PlayOneShot.
        // Used by the gem pickups (PropBuilder.BuildSpinners -> the gem marker's pickupSound), whose chime is a chosen
        // bank clip, not a CollisonSound-remapped material. Returns null if clip is null. Volume is the source's, but
        // the gem-pickup behaviour passes a per-call scale to PlayOneShot too.
        public AudioSource AttachOneShotClip(GameObject go, AudioClip clip, float minDist, float maxDist)
        {
            if (clip == null) return null;
            var src = go.AddComponent<AudioSource>();
            src.clip = clip;
            src.playOnAwake = false;
            src.loop = false;
            src.volume = 1f;
            src.spatialBlend = 1f;                 // positional - the chime comes from the gem you grabbed
            src.dopplerLevel = 0f;
            src.rolloffMode = AudioRolloffMode.Linear;
            src.minDistance = minDist;
            src.maxDistance = Mathf.Max(minDist, maxDist);
            go.AddComponent<SpatialAudio>();   // platform wiring pass gives it a spatial pairing (reads this 3D curve)
            return src;
        }

        // Collidable props that ship with NO collision proxy mesh (signs, billboards, jumbotrons, crowd stands) get a
        // collider from NEITHER the proxy buckets NOR the physics pass - so the rider and the walking player would
        // pass straight through them. The game collides these via COMPUTED BOUNDS (a box from the model extents);
        // snowknife computes those boxes into the manifest (Snowknife docs/034) and we drop a BoxCollider for each here. Box
        // primitives are cheap and have correct outward face normals (which the board's wall-vs-ground normal filter
        // needs). Exact authored response/bounce/surface metadata follows the box just like a triangle bucket.
        public int ImportComputedBoundsColliders(Transform parent)
        {
            return ImportBoxesFromBundle(parent, _bundle.ComputedBounds, "PropsBoundsCollision", "Bounds_", trigger: false, foliageLayer: false);
        }

        // Body props: snowknife decoded the engine's real mode-3 physics body (an occupancy tree; docs/037)
        // and emitted its shape instead of one computed-bounds AABB - merged body-local boxes for doorway
        // structures (gate arch, cave scaffold, crowd stand: the opening you ride through stays OPEN), and
        // sphere-swept capsules for sparse bodies (leaning trunks, poles: the trail beside/under them stays
        // open and contact normals deflect the way retail's leaf spheres did). One GameObject per instance
        // (pivot + rotation); boxes sit on it directly, while each capsule needs its own child aligned to
        // its segment (a CapsuleCollider only orients along a local axis). One impact AudioSource shared.
        public int ImportBodyColliders(Transform parent)
        {
            var prev = parent.Find("PropsBodyCollision");
            if (prev != null) UnityEngine.Object.DestroyImmediate(prev.gameObject);
            if (_bundle.Bodies.Count == 0) return 0;

            var root = new GameObject("PropsBodyCollision");
            root.transform.SetParent(parent, false);

            int made = 0, boxes = 0, capsules = 0, withSound = 0;
            foreach (var b in _bundle.Bodies)
            {
                bool hasBoxes = b.Boxes != null && b.Boxes.Count > 0;
                bool hasCapsules = b.Capsules != null && b.Capsules.Count > 0;
                if (!hasBoxes && !hasCapsules) continue;
                var go = new GameObject("Body_" + b.InstanceIndex + "_" + SafeName(b.Name));
                go.transform.SetParent(root.transform, false);
                go.transform.localPosition = b.Center;
                go.transform.localRotation = b.Rotation;
                if (hasBoxes)
                    foreach (var bx in b.Boxes)
                    {
                        var box = go.AddComponent<BoxCollider>();
                        box.center = bx.Center; box.size = bx.Size;
                        boxes++;
                    }
                if (hasCapsules)
                    foreach (var cp in b.Capsules)
                    {
                        Vector3 axis = cp.B - cp.A;
                        float len = axis.magnitude;
                        if (len < 1e-3f)
                        {
                            var sph = go.AddComponent<SphereCollider>();
                            sph.center = cp.A; sph.radius = cp.Radius;
                        }
                        else
                        {
                            var seg = new GameObject("Cap" + capsules);
                            seg.transform.SetParent(go.transform, false);
                            seg.transform.localPosition = (cp.A + cp.B) * 0.5f;
                            seg.transform.localRotation = Quaternion.FromToRotation(Vector3.up, axis / len);
                            var cap = seg.AddComponent<CapsuleCollider>();
                            cap.direction = 1;                    // local Y = the segment axis
                            cap.radius = cp.Radius;
                            cap.height = len + 2f * cp.Radius;    // height spans the caps, not just the segment
                        }
                        capsules++;
                    }
                if (AttachImpactSound(go, b.Sound, b.SoundClip)) withSound++;
                MarkMode(go, b.ModeMask);
                made++;
            }
            Debug.Log($"OpenSlope: PropsBodyCollision from bundle -> {made} body prop(s), {boxes} box(es) + {capsules} capsule(s) ({withSound} with impact sound).");
            return made;
        }

        // The leaf cutouts (tree leaves -> CollisonSound 7 -> course bank slot 050; bushy leaves -> 12 -> 051) have
        // zero response mass: PASS-THROUGH proxies the game lets you ride through (only the nonzero-mass trunk blocks). snowknife
        // selects them into the manifest's foliage boxes (Snowknife docs/034); we give each a TRIGGER BoxCollider so the board
        // can detect riding THROUGH a leaf cloud and play the swish - without ever walling the rider OR the walking
        // player (triggers don't block a CharacterController, and the board's obstacle sweep ignores triggers). Boxes
        // are grouped by sound under PropsFoliage/Snd<slot>, ONE AudioSource per group (the board reads the clip off
        // the box's parent). See the rideable board.CheckFoliageSwish.
        public int ImportFoliageSwishTriggers(Transform parent)
        {
            return ImportFoliageFromBundle(parent);
        }

        // ---- bundle-driven collision: consume collision.glb + manifest ----
        void ImportBucketsFromBundle(Transform parent)
        {
            string glb = Path.Combine(Path.GetDirectoryName(Application.dataPath), _cfg.LevelFolder + "/gltf/collision.glb");
            if (!File.Exists(glb)) { Debug.LogWarning("OpenSlope: bundle has collision buckets but no collision.glb - skipping."); return; }
            var nodes = GlbMeshLoader.Load(glb, _cfg.WorldScale);
            var byName = new Dictionary<string, GlbMeshLoader.Node>();
            foreach (var n in nodes) byName[n.Name] = n;

            var prev = parent.Find("PropsCollision");
            if (prev != null) UnityEngine.Object.DestroyImmediate(prev.gameObject);
            var root = new GameObject("PropsCollision");
            root.transform.SetParent(parent, false);

            string meshPath = _cfg.LevelFolder + "/PropsCollisionColliders.mesh";
            AssetDatabase.DeleteAsset(meshPath);
            bool created = false; int colliders = 0, totalTris = 0, withSound = 0;
            // Breakable SUPPORT colliders (docs/036 §Cracked glass), gathered as they are built and handed to their
            // cluster below. A glass pane's support is the invisible solid slab holding the rider up, so it is the one
            // collider a break has to take away - which is why snowknife gives each its own single-instance bucket
            // instead of merging it into a shared one.
            var supports = new Dictionary<string, List<Collider>>(StringComparer.Ordinal);
            foreach (var b in _bundle.Buckets)
            {
                if (!byName.TryGetValue(b.Node, out var node) || node.Prims.Count == 0) continue;
                var verts = new List<Vector3>(); var tris = new List<int>();
                foreach (var p in node.Prims) { int bs = verts.Count; verts.AddRange(p.Positions); foreach (var idx in p.Indices) tris.Add(idx + bs); }
                if (tris.Count == 0) continue;
                var mesh = new Mesh { name = b.Node };
                if (verts.Count > 65000) mesh.indexFormat = UnityEngine.Rendering.IndexFormat.UInt32;
                mesh.SetVertices(verts); mesh.SetTriangles(tris, 0); mesh.RecalculateBounds();
                if (!created) { AssetDatabase.CreateAsset(mesh, meshPath); created = true; }
                else AssetDatabase.AddObjectToAsset(mesh, meshPath);
                var go = new GameObject(b.Node);
                go.transform.SetParent(root.transform, false);
                var mc = go.AddComponent<MeshCollider>();
                mc.sharedMesh = mesh;
                var bmk = go.AddComponent<PropBounceMarker>();
                bmk.PlayerBounce = b.PlayerBounce; bmk.PlayerBounceAmmount = b.Amount;
                bmk.SurfaceType = b.SurfaceType; bmk.InstanceCount = b.InstanceCount;
                bmk.NativeMode = NativeCollision.TriangleProxy;   // a proxy mesh: met by the rider's limb spheres
                if (AttachImpactSound(go, b.Sound, b.SoundClip)) withSound++;
                MarkMode(go, b.ModeMask);
                if (!string.IsNullOrEmpty(b.BreakCluster))
                {
                    if (!supports.TryGetValue(b.BreakCluster, out var list))
                    { list = new List<Collider>(); supports[b.BreakCluster] = list; }
                    list.Add(mc);
                }
                colliders++; totalTris += tris.Count / 3;
            }
            if (colliders == 0) { UnityEngine.Object.DestroyImmediate(root); return; }
            int wired = WireBreakSupports(parent, supports);
            Debug.Log($"OpenSlope: prop collision from bundle -> {colliders} bounce buckets ({withSound} with impact sound), {totalTris} tris" +
                      (supports.Count > 0 ? $"; {wired}/{supports.Count} breakable support collider set(s) handed to their cluster (a glass pane rides on one until it gives way, docs/036)" : "") + ".");
        }

        // Hand each cluster's support colliders to the breakable that owns them. PropBuilder runs BEFORE this, so its
        // markers are already in the scene and still un-realized - the platform wiring pass copies marker fields onto
        // the runtime behaviour afterwards, so writing the field here is all it takes for both platforms to get it.
        static int WireBreakSupports(Transform parent, Dictionary<string, List<Collider>> supports)
        {
            if (supports.Count == 0) return 0;
            int wired = 0;
            foreach (var mk in parent.GetComponentsInChildren<BreakableLogoMarker>(true))
            {
                if (string.IsNullOrEmpty(mk.clusterKey) || !supports.TryGetValue(mk.clusterKey, out var list)) continue;
                mk.supportColliders = list.ToArray();
                wired++;
            }
            if (wired < supports.Count)
                Debug.LogWarning($"OpenSlope: {supports.Count - wired} breakable support collider set(s) found no cluster to " +
                                 "attach to - those panes will break visually but stay solid underfoot.");
            return wired;
        }

        int ImportBoxesFromBundle(Transform parent, List<BundleManifestReader.Box> boxes, string rootName, string prefix, bool trigger, bool foliageLayer)
        {
            var prev = parent.Find(rootName);
            if (prev != null) UnityEngine.Object.DestroyImmediate(prev.gameObject);
            if (boxes.Count == 0) return 0;
            var root = new GameObject(rootName);
            root.transform.SetParent(parent, false);
            int made = 0, withSound = 0;
            foreach (var b in boxes)
            {
                var go = new GameObject(prefix + b.Name);
                go.transform.SetParent(root.transform, false);
                go.transform.localPosition = b.Center;
                // Turned with the placement, like the mode-3 body holders below: the engine collides the
                // model's own box, not the axis-aligned envelope of the turned result.
                go.transform.localRotation = b.Rotation;
                var box = go.AddComponent<BoxCollider>();
                box.center = b.LocalCenter; box.size = b.Size; box.isTrigger = trigger;
                if (!trigger)
                {
                    var marker = go.AddComponent<PropBounceMarker>();
                    marker.PlayerBounce = b.PlayerBounce;
                    marker.PlayerBounceAmmount = b.Amount;
                    marker.SurfaceType = b.SurfaceType;
                    marker.InstanceCount = 1;
                    // A bounding box: met by the rider's BODY SPHERE alone, which is why the board keeps these
                    // under their own root and sweeps them separately [Trailmap: 370-probe-modes].
                    marker.NativeMode = NativeCollision.BoundingBox;
                }
                if (AttachImpactSound(go, b.Sound, b.SoundClip)) withSound++;
                MarkMode(go, b.ModeMask);
                made++;
            }
            Debug.Log($"OpenSlope: {rootName} from bundle -> {made} box(es) ({withSound} with impact sound).");
            return made;
        }

        int ImportFoliageFromBundle(Transform parent)
        {
            var prev = parent.Find("PropsFoliage");
            if (prev != null) UnityEngine.Object.DestroyImmediate(prev.gameObject);
            if (_bundle.Foliage.Count == 0) return 0;
            var root = new GameObject("PropsFoliage");
            root.transform.SetParent(parent, false);
            int foliageLayer = EnsureFoliageLayer();
            var groups = new Dictionary<int, Transform>();
            int made = 0;
            foreach (var b in _bundle.Foliage)
            {
                if (!groups.TryGetValue(b.Sound, out var grp))
                {
                    var g = new GameObject("Snd" + b.Sound);
                    g.transform.SetParent(root.transform, false);
                    AttachImpactSound(g, b.Sound, b.SoundClip);
                    grp = g.transform; groups[b.Sound] = grp;
                }
                var go = new GameObject("Leaf_" + b.Name);
                go.transform.SetParent(grp, false);
                if (foliageLayer >= 0) go.layer = foliageLayer;
                go.transform.localPosition = b.Center;
                // Foliage boxes come from the same oriented emitter as the bounds boxes, so they turn with
                // their placement too - a leaf cutout is exactly the thin turned thing an axis-aligned
                // envelope inflates worst.
                go.transform.localRotation = b.Rotation;
                NativeCollision.AddPassThroughBox(go, b.LocalCenter, b.Size,
                    NativeCollision.TriangleProxy);
                MarkMode(go, b.ModeMask);
                made++;
            }
            Debug.Log($"OpenSlope: foliage swish from bundle -> {made} trigger box(es) in {groups.Count} sound group(s).");
            return made;
        }

        // Authored ghost props with a hit sound are ride-through contact volumes, not walls. Each keeps its own
        // staged clip + neutral marker; the platform wiring pass supplies the player/board trigger runtime.
        public int ImportContactSoundTriggers(Transform parent)
        {
            var prev = parent.Find("PropsContactSounds");
            if (prev != null) UnityEngine.Object.DestroyImmediate(prev.gameObject);
            if (_bundle.ContactSounds.Count == 0) return 0;
            var root = new GameObject("PropsContactSounds");
            root.transform.SetParent(parent, false);
            int made = 0, withSound = 0;
            foreach (var b in _bundle.ContactSounds)
            {
                var go = new GameObject("Contact_" + b.Name);
                go.transform.SetParent(root.transform, false);
                go.transform.localPosition = b.Center;
                go.transform.localRotation = b.Rotation;
                NativeCollision.AddPassThroughBox(go, b.LocalCenter, b.Size,
                    NativeCollision.TriangleProxy);
                if (AttachImpactSound(go, b.Sound, b.SoundClip)) withSound++;
                go.AddComponent<ContactSoundMarker>();
                MarkMode(go, b.ModeMask);
                made++;
            }
            Debug.Log($"OpenSlope: authored contact sounds -> {made} ride-through trigger(s) ({withSound} with clips).");
            return made;
        }

        // A dedicated, collision-ISOLATED physics layer for the leaf trigger boxes. They're detected ONLY by the board's
        // manual cast (the rideable board.CheckFoliageSwish), never by automatic OnTrigger callbacks, so they can collide
        // with NOTHING - which drops the ~1000 leaf boxes out of every other body's (player capsule, props, ...) broadphase
        // and trigger-pair bookkeeping each physics tick. Scene queries ignore the collision matrix, so the cast still
        // finds them (and the board narrows that cast to this very layer). Idempotent; returns the layer index, or -1 if
        // there's no free user-layer slot (the boxes then stay on Default - still works, just without the saving).
        static readonly string FoliageLayerName = "Foliage";
        static int EnsureFoliageLayer()
        {
            int layer = LayerMask.NameToLayer(FoliageLayerName);
            if (layer < 0)
            {
                var assets = AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/TagManager.asset");
                if (assets == null || assets.Length == 0) return -1;
                var so = new SerializedObject(assets[0]);
                var layersProp = so.FindProperty("layers");
                if (layersProp == null) return -1;
                // Prefer a free user slot in 24..31 (VRChat reserves the lower layers for avatars/world/pickups); fall
                // back to any free user slot 8..31. We never touch a named slot, so VRChat's own layers are untouched.
                int slot = FirstEmptyLayer(layersProp, 24, 31);
                if (slot < 0) slot = FirstEmptyLayer(layersProp, 8, 31);
                if (slot < 0) { Debug.LogWarning("OpenSlope: no free physics-layer slot for '" + FoliageLayerName + "'; leaf boxes stay on Default (swish still works, just no broadphase saving)."); return -1; }
                layersProp.GetArrayElementAtIndex(slot).stringValue = FoliageLayerName;
                so.ApplyModifiedPropertiesWithoutUndo();
                layer = slot;
                Debug.Log("OpenSlope: created physics layer '" + FoliageLayerName + "' at index " + slot + " for the leaf swish boxes.");
            }
            // Isolate it: turn OFF collision/trigger detection between this layer and EVERY layer (including itself).
            // The board's swish cast is a scene query, which ignores this matrix, so it still detects the leaves.
            for (int i = 0; i < 32; i++) Physics.IgnoreLayerCollision(layer, i, true);
            return layer;
        }

        static int FirstEmptyLayer(SerializedProperty layersProp, int lo, int hi)
        {
            for (int i = lo; i <= hi && i < layersProp.arraySize; i++)
                if (string.IsNullOrEmpty(layersProp.GetArrayElementAtIndex(i).stringValue))
                    return i;
            return -1;
        }

        static string SafeName(string s)
        {
            if (string.IsNullOrEmpty(s)) return "unnamed";
            return s.Replace('/', '_').Replace('\\', '_');
        }
    }
}
#endif
