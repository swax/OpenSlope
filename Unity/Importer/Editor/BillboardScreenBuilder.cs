#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // The CATALOG of video-ready screen quads: one flat quad laid flush over each of the course's billboard ad
    // faces, so a platform can feed any of them a video (VRChat's VideoBillboards, docs/vrchat/041).
    //
    // An SSX billboard is welded into the merged static "Props" mesh with shared atlas materials, so a screen
    // face can't be retextured on its own - the video would smear onto every prop sharing that material, and
    // the face isn't an isolable object. A fresh quad laid a little proud of the face is what makes one board
    // drivable without touching the merged world.
    //
    // WHERE each quad goes is not decided here. snowknife measures the ad face from the placed prop geometry -
    // grouping by texture page and facing, gating on the UV span that tells a single ad image from a tiled
    // structural face, splitting a cluster into one screen per board, and turning each toward the riders - and
    // ships the result as manifest.Billboards (Snowknife docs/034). This builder is the thin half: it turns each
    // record into a quad. That keeps the geometry search in one engine-agnostic place, where Blender and
    // Slopesmith read the same rectangles.
    //
    // Quads land DISABLED under Billboards/<family>, and LevelImporter re-exposes the catalog at the map root so
    // the static chunker and the texture-array packer - which own everything under Level - never touch them. A
    // platform consumes the catalog into its own video object.
    public class BillboardScreenBuilder
    {
        public const string RootObjectName = "Billboards";

        readonly ImportConfig _cfg;

        public BillboardScreenBuilder(ImportConfig cfg) { _cfg = cfg; }

        public void Build(Transform level)
        {
            var previous = level.Find(RootObjectName);
            if (previous != null) Object.DestroyImmediate(previous.gameObject);
            if (!_cfg.BuildBillboardScreens) return;

            var bundle = new BundleManifestReader(_cfg);
            if (!bundle.Exists || bundle.BillboardScreens.Count == 0) return;

            // Under Level, so a record's mesh-space centimetres ARE the quad's local coordinates: the level root
            // carries the -90X rotation and the 0.01 scale for it, exactly as it does for every bundle mesh.
            var root = new GameObject(RootObjectName);
            root.transform.SetParent(level, false);

            var preview = new Material(Shader.Find("Sprites/Default")) { color = new Color(0.1f, 1f, 0.3f, 0.4f) };
            var groups = new Dictionary<string, Transform>(System.StringComparer.Ordinal);
            int built = 0;

            foreach (var screen in bundle.BillboardScreens)
            {
                Vector3 normal = screen.Normal.sqrMagnitude > 1e-6f ? screen.Normal.normalized : Vector3.forward;
                Vector3 up = screen.Up.sqrMagnitude > 1e-6f ? screen.Up.normalized : Vector3.up;
                // Orthonormalize: the record's Up is perpendicular by construction, but an authored screen can
                // arrive with a hand-edited pair, and LookRotation would silently pick its own up for a parallel one.
                up = Vector3.ProjectOnPlane(up, normal);
                if (up.sqrMagnitude < 1e-6f) up = Mathf.Abs(normal.y) < 0.9f ? Vector3.up : Vector3.forward;
                up.Normalize();

                Transform group = root.transform;
                if (!string.IsNullOrEmpty(screen.Family))
                {
                    if (!groups.TryGetValue(screen.Family, out group))
                    {
                        var groupGo = new GameObject(screen.Family);
                        groupGo.transform.SetParent(root.transform, false);
                        group = groupGo.transform;
                        groups[screen.Family] = group;
                    }
                }

                var go = new GameObject("Screen_" + screen.Name);
                go.transform.SetParent(group, false);
                // The quad sits in its OWN frame - at the board, looking out of it - with the mesh stored local to
                // it, so the move gizmo, the hierarchy double-click frame and every transform.position read land on
                // the board rather than a kilometre away at the level origin.
                go.transform.localPosition = screen.Center;   // already sits proud of the ad face
                go.transform.localRotation = Quaternion.LookRotation(normal, up);   // local +X/+Y/+Z = right/up/front

                float halfWidth = screen.Width * 0.5f, halfHeight = screen.Height * 0.5f;
                var mesh = new Mesh
                {
                    name = go.name,
                    vertices = new[]
                    {
                        new Vector3(-halfWidth, -halfHeight, 0f), new Vector3(halfWidth, -halfHeight, 0f),
                        new Vector3(halfWidth, halfHeight, 0f), new Vector3(-halfWidth, halfHeight, 0f),
                    },
                    // U is REVERSED (u=0 at +X): local +X points to the LEFT of someone facing the front, so a
                    // naive 0..1 map shows video mirrored. V is left alone - panel top = image top, which matches
                    // the AVPro no-flip orientation.
                    uv = new[] { Vector2.right, Vector2.zero, Vector2.up, Vector2.one },
                    triangles = new[] { 0, 1, 2, 0, 2, 3, 0, 2, 1, 0, 3, 2 },   // double-sided
                };
                mesh.RecalculateNormals();
                mesh.RecalculateBounds();
                go.AddComponent<MeshFilter>().sharedMesh = mesh;
                go.AddComponent<MeshRenderer>().sharedMaterial = preview;
                go.SetActive(false);   // the catalog is hidden until a platform lights a screen up
                built++;
            }

            if (built == 0) { Object.DestroyImmediate(root); return; }
            EditorUtility.SetDirty(root);
            Debug.Log($"OpenSlope: cataloged {built} billboard screen(s) under {RootObjectName}/ (disabled). " +
                      "A platform's video setup consumes them; the rectangles come from the bundle (snowknife docs/034).");
        }
    }
}
#endif
