#if UNITY_EDITOR
using System.IO;
using UnityEditor;
using UnityEngine;
using UdonSharp;
using UdonSharpEditor;

namespace OpenSlope.VrcPlugin
{

    // Library setup step: stand up the ambient falling-snow weather (SnowfallU - the SSX ambient snowfall,
    // ported; see docs/044-snowfall.md and the SnowfallU header). The game keeps a small
    // CAMERA-RELATIVE box of additive snowflake sprites toroidally recycled around the camera; here the WHOLE behaviour
    // (fall, drift, wrap, billboarding) runs in the OpenSlope/Snowfield VERTEX shader over one static baked mesh of flake
    // quads - no ParticleSystem and no per-frame CPU/Udon work (each flake's position is a pure function of _Time + the
    // camera position). This bakes that mesh, builds the material, and wires the SnowfallU on/off switch.
    //
    // Snow is a per-MAP effect (only snow levels want it), so it lives under OpenSlope_Map and is removed when a map is
    // switched - re-run this after loading a snow course. Same two-step Udon bootstrap as PlayerFlightSetup (a freshly
    // created U# program asset can't be attached in the same call; first run creates+compiles it and stops, second run
    // attaches). See docs/vrchat/013-udon-components.md.
    public static class SnowfallSetup
    {
        const string ChildName  = "Snowfall";                                     // OpenSlope_Map/Snowfall
        const string MatPath    = Map.AssetsFolder + "/Materials/Snowfield.mat";
        const string MeshPath   = Map.AssetsFolder + "/Materials/Snowfield.asset";  // the baked flake-quad mesh
        const string OldMatPath = Map.AssetsFolder + "/Materials/Snowflake.mat";    // the ParticleSystem-era material (retired)

        const int FlakeCount = 600;    // flake quads in the wrapped box around the camera
        const int BakeSeed   = 4419;   // fixed seed: every re-run bakes the identical field

        const float MarginFrac    = 1.25f;   // the field's never-cull box = the course's renderable bounds x this
        const float MinBoundsSize = 200f;    // ...floored here, so a tiny or renderer-less course still gets a real box

        [MenuItem("OpenSlope/Setup/Snowfall", false, 190)]
        public static void Setup()
        {
            bool firstTime = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(SnowfallU)) == null;
            var programAsset = EnsureProgramAsset();
            if (programAsset == null) { Debug.LogError("OpenSlope: could not create/find the SnowfallU program asset; aborting."); return; }
            if (firstTime)
            {
                Debug.Log("OpenSlope: created the SnowfallU Udon program asset. UdonSharp finalizes it on the next editor " +
                          "tick - run 'OpenSlope/Setup/Snowfall' again to attach it.");
                return;
            }

            Shader shader = Shader.Find("OpenSlope/Snowfield");
            if (shader == null)
            {
                Debug.LogError("OpenSlope: OpenSlope/Snowfield shader not found - copy Assets/OpenSlope/VRC/Shaders/Snowfield.shader " +
                               "into the project; aborting.");
                return;
            }

            Transform root = Map.ResolveRoot(true);
            var existing = root.Find(ChildName);
            if (existing != null) Object.DestroyImmediate(existing.gameObject);

            // The field's never-cull box, measured off the course itself (the old Snowfall child is gone by now, so the
            // field never measures its own bounds). See MapBounds.
            Bounds box = MapBounds(root);

            var go = new GameObject(ChildName);
            go.transform.SetParent(root, false);
            // The shader ignores the object transform - it centres the field on whatever camera is rendering - so this
            // position is only the never-cull box's CENTRE. Parked at the middle of the course.
            go.transform.position = box.center;

            go.AddComponent<MeshFilter>().sharedMesh = GetSnowfieldMesh(LocalSize(go.transform, box.size));
            var mr = go.AddComponent<MeshRenderer>();
            mr.sharedMaterial = GetSnowfieldMaterial(shader);
            mr.shadowCastingMode = UnityEngine.Rendering.ShadowCastingMode.Off;
            mr.receiveShadows = false;
            mr.lightProbeUsage = UnityEngine.Rendering.LightProbeUsage.Off;
            mr.reflectionProbeUsage = UnityEngine.Rendering.ReflectionProbeUsage.Off;
            mr.motionVectorGenerationMode = MotionVectorGenerationMode.ForceNoMotion;
            mr.allowOcclusionWhenDynamic = false;   // the mesh's baked never-cull box must survive occlusion culling too

            var proxy = go.AddUdonSharpComponent<SnowfallU>();
            proxy.snowRenderer = mr;
            UdonSharpEditorUtility.CopyProxyToUdon(proxy);

            EditorSceneMarkDirty(go);
            Debug.Log($"OpenSlope: snowfall set up at {Map.RootName}/{ChildName} (SnowfallU + baked OpenSlope/Snowfield mesh), " +
                      $"never-cull box {box.size.ToString("F0")} centred on {box.center.ToString("F0")}. " +
                      "Fully shader-driven: world-fixed additive flakes toroidally wrapped around the render camera " +
                      "(matches the game: ride-through parallax, never left behind) with zero per-frame CPU/Udon " +
                      "cost. Tune box/fall/size/brightness on the Snowfield material. Re-run after loading a map. " +
                      "Animates live in Scene/Game view (it's just a shader).");
        }

        // The field's never-cull box: the course's world-space renderable bounds, grown by MarginFrac.
        //
        // The shader teleports the flakes to the render camera, so the mesh must never be frustum-culled out from under
        // them. A frustum can only cull an AABB when the WHOLE box falls outside it, so a box spanning the course can
        // only cull once no part of the course is on screen - which is exactly when the snow stops mattering. Sizing it
        // to the course (rather than to some arbitrary huge number) keeps the field out of OpenSlope_Map's own framing bounds,
        // so double-clicking the map in the hierarchy frames the course and not the snow box: Unity unions Renderer
        // bounds over ALL children, counting renderers whose component is merely disabled - so a field with an oversized
        // box swamps the frame distance even with the snow switched off.
        //
        // Every renderer under the map root counts, active or not; renderers with no mesh (particles, trails) have no
        // stable extent and are skipped.
        static Bounds MapBounds(Transform root)
        {
            var bounds = new Bounds();
            bool any = false;
            foreach (var r in root.GetComponentsInChildren<Renderer>(true))
            {
                var mf = r.GetComponent<MeshFilter>();
                if (mf == null || mf.sharedMesh == null) continue;
                Bounds b = r.bounds;
                float m = b.size.sqrMagnitude;
                if (float.IsNaN(m) || float.IsInfinity(m)) continue;
                if (!any) { bounds = b; any = true; } else bounds.Encapsulate(b);
            }
            if (!any) return new Bounds(root.position, Vector3.one * MinBoundsSize);
            bounds.size = Vector3.Max(bounds.size * MarginFrac, Vector3.one * MinBoundsSize);
            return bounds;
        }

        // mesh.bounds is LOCAL to the renderer, so divide the world box out by the object's scale to land the WORLD box
        // where MapBounds sized it.
        static Vector3 LocalSize(Transform t, Vector3 worldSize)
        {
            Vector3 s = t.lossyScale;
            return new Vector3(worldSize.x / (Mathf.Approximately(s.x, 0f) ? 1f : Mathf.Abs(s.x)),
                               worldSize.y / (Mathf.Approximately(s.y, 0f) ? 1f : Mathf.Abs(s.y)),
                               worldSize.z / (Mathf.Approximately(s.z, 0f) ? 1f : Mathf.Abs(s.z)));
        }

        // Bake the snow-field mesh: FlakeCount quads whose vertex POSITIONS carry each flake's random base point in the
        // unit box (the shader scales by the wrap box), quad corners in UV0 and per-flake randoms (fall speed / size /
        // drift) in UV1 - the OpenSlope/Snowfield mesh contract (see the shader header). Fixed seed, so re-runs bake the
        // identical field. Saved as a project asset (kept out of the scene file); boundsSize is the never-cull box from
        // MapBounds, so the mesh is re-baked per course.
        static Mesh GetSnowfieldMesh(Vector3 boundsSize)
        {
            var rng = new System.Random(BakeSeed);
            var verts   = new Vector3[FlakeCount * 4];
            var corners = new Vector2[FlakeCount * 4];
            var rnds    = new System.Collections.Generic.List<Vector4>(FlakeCount * 4);
            var tris    = new int[FlakeCount * 6];
            for (int i = 0; i < FlakeCount; i++)
            {
                var basePos = new Vector3((float)rng.NextDouble(), (float)rng.NextDouble(), (float)rng.NextDouble());
                var rnd = new Vector4((float)rng.NextDouble(), (float)rng.NextDouble(),
                                      (float)rng.NextDouble(), (float)rng.NextDouble());
                int v = i * 4;
                verts[v] = verts[v + 1] = verts[v + 2] = verts[v + 3] = basePos;
                corners[v]     = new Vector2(-0.5f, -0.5f);
                corners[v + 1] = new Vector2( 0.5f, -0.5f);
                corners[v + 2] = new Vector2( 0.5f,  0.5f);
                corners[v + 3] = new Vector2(-0.5f,  0.5f);
                for (int k = 0; k < 4; k++) rnds.Add(rnd);
                int t = i * 6;
                tris[t] = v; tris[t + 1] = v + 2; tris[t + 2] = v + 1;
                tris[t + 3] = v; tris[t + 4] = v + 3; tris[t + 5] = v + 2;
            }

            var mesh = AssetDatabase.LoadAssetAtPath<Mesh>(MeshPath);
            bool create = mesh == null;
            if (create) mesh = new Mesh();
            mesh.Clear();
            mesh.name = "Snowfield";
            mesh.vertices = verts;
            mesh.uv = corners;
            mesh.SetUVs(1, rnds);
            mesh.triangles = tris;
            mesh.bounds = new Bounds(Vector3.zero, boundsSize);   // the course-sized never-cull box - the shader owns placement
            if (create)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(MeshPath));
                AssetDatabase.CreateAsset(mesh, MeshPath);
            }
            else EditorUtility.SetDirty(mesh);
            return mesh;
        }

        // The snow material: OpenSlope/Snowfield does everything (mesh contract + all motion in the shader header); the
        // values here are a night-snow tuning - a 40x34x40 m box lifted 5 m above the camera, gentle 2.2-4.0 m/s fall
        // with light drift, 0.10-0.30 m flakes, drawn as faint additive soft dots. Created as a shared project asset so
        // it persists + uploads; re-runs reset it to this tuning. Also retires the ParticleSystem-era Snowflake
        // material if it's still around.
        static Material GetSnowfieldMaterial(Shader shader)
        {
            var mat = AssetDatabase.LoadAssetAtPath<Material>(MatPath);
            if (mat == null)
            {
                mat = new Material(shader) { name = "Snowfield" };
                Directory.CreateDirectory(Path.GetDirectoryName(MatPath));
                AssetDatabase.CreateAsset(mat, MatPath);
            }
            else if (mat.shader != shader) mat.shader = shader;

            mat.SetColor("_TintColor", Color.white);
            mat.SetFloat("_Alpha", 0.5f);
            mat.SetFloat("_Boost", 0.6f);
            mat.SetFloat("_Intensity", 1.0f);   // snowfall "amount" (the game's front-end "Snow fall:" 0.5..2.0); 1 = the full baked field. Dial per course.
            mat.SetFloat("_Softness", 0.55f);
            mat.SetVector("_BoxSize", new Vector4(40f, 34f, 40f, 0f));
            mat.SetFloat("_BoxLift", 5f);
            mat.SetVector("_FallSpeed", new Vector4(2.2f, 4.0f, 0f, 0f));
            mat.SetFloat("_Drift", 0.7f);
            mat.SetVector("_FlakeSize", new Vector4(0.10f, 0.30f, 0f, 0f));
            mat.SetVector("_NearFade", new Vector4(0.25f, 0.6f, 0f, 0f));
            mat.SetFloat("_EdgeFade", 0.2f);
            EditorUtility.SetDirty(mat);

            if (AssetDatabase.LoadAssetAtPath<Material>(OldMatPath) != null) AssetDatabase.DeleteAsset(OldMatPath);
            return mat;
        }

        // Create + compile the SnowfallU program asset if absent (AddUdonSharpComponent requires it to exist first).
        static UdonSharpProgramAsset EnsureProgramAsset()
        {
            var existing = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(SnowfallU));
            if (existing != null) return existing;

            string scriptPath = null;
            foreach (var guid in AssetDatabase.FindAssets("SnowfallU t:MonoScript"))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (p.EndsWith("/SnowfallU.cs")) { scriptPath = p; break; }
            }
            if (scriptPath == null) { Debug.LogError("OpenSlope: SnowfallU.cs not found in project."); return null; }

            var script = AssetDatabase.LoadAssetAtPath<MonoScript>(scriptPath);
            var pa = ScriptableObject.CreateInstance<UdonSharpProgramAsset>();
            pa.sourceCsScript = script;
            string assetPath = Path.ChangeExtension(scriptPath, ".asset");
            AssetDatabase.CreateAsset(pa, assetPath);
            AssetDatabase.Refresh();
            UdonSharpProgramAsset.CompileAllCsPrograms(true);
            Debug.Log($"OpenSlope: created UdonSharp program asset {assetPath}");
            return UdonSharpProgramAsset.GetProgramAssetForClass(typeof(SnowfallU));
        }

        static void EditorSceneMarkDirty(GameObject go)
            => UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
    }
}
#endif
