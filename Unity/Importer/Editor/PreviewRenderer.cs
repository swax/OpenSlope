#if UNITY_EDITOR
using System.IO;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Renders the imported level to a PNG at the project root (ssx_preview.png) for a quick at-a-glance
    // check after import. Frames the whole level from a fixed 3/4 angle against the baked skybox.
    public class PreviewRenderer
    {
        readonly ImportConfig _cfg;

        public PreviewRenderer(ImportConfig cfg) { _cfg = cfg; }

        public void Render()
        {
            var root = GameObject.Find(_cfg.RootName);
            if (root == null) { Debug.LogError("OpenSlope: import first."); return; }

            var rends = root.GetComponentsInChildren<MeshRenderer>();
            if (rends.Length == 0) { Debug.LogError("OpenSlope: no renderers to preview."); return; }

            Bounds b = rends[0].bounds;
            foreach (var r in rends) b.Encapsulate(r.bounds);
            float radius = Mathf.Max(b.size.magnitude * 0.5f, 1f);

            var camGO = new GameObject("OpenSlope_PreviewCam");
            var cam = camGO.AddComponent<Camera>();
            cam.clearFlags = CameraClearFlags.Skybox;            // show the baked skybox behind the level
            cam.backgroundColor = new Color(0.10f, 0.10f, 0.12f, 1f);
            cam.nearClipPlane = radius * 0.001f;
            cam.farClipPlane = radius * 10f;
            cam.fieldOfView = 50f;
            Vector3 dir = new Vector3(1f, 0.6f, -1f).normalized;
            cam.transform.position = b.center + dir * radius * 2.2f;
            cam.transform.LookAt(b.center, Vector3.up);

            const int W = 1280, H = 800;
            var rt = new RenderTexture(W, H, 24);
            cam.targetTexture = rt;
            cam.Render();

            var prev = RenderTexture.active;
            RenderTexture.active = rt;
            var tex = new Texture2D(W, H, TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, W, H), 0, 0);
            tex.Apply();
            RenderTexture.active = prev;

            string outPath = Path.Combine(Path.GetDirectoryName(Application.dataPath), "ssx_preview.png");
            File.WriteAllBytes(outPath, tex.EncodeToPNG());

            cam.targetTexture = null;
            Object.DestroyImmediate(rt);
            Object.DestroyImmediate(tex);
            Object.DestroyImmediate(camGO);
            Debug.Log("OpenSlope: preview written to " + outPath);
        }
    }
}
#endif
