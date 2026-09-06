#if UNITY_EDITOR
using System.Collections.Generic;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Scene-view visualization + probe for the invisible collision the importer builds (docs/009, Snowknife docs/034):
    // computed-bounds boxes, doorway body boxes, foliage swish triggers, trigger/boost/reset volumes. None of
    // these carry a renderer, so a phantom wall (a leaning tree flattened to its computed-bounds AABB, say) is
    // invisible in the preview. This window draws every BoxCollider in the scene color-coded by its collision
    // group, and can probe a point for ALL overlapping colliders (mesh proxies and terrain included) and jump
    // to the offender. Triangle proxy buckets are merged level-wide MeshColliders whose bounds would only
    // mislead as boxes - see them with Unity's Physics Debugger (Window > Analysis > Physics Debug) instead.
    public class CollisionDebugWindow : EditorWindow
    {
        // Group = the node the importer parents each collision family under (child of Level / Collision).
        // One hue per family so no two groups read as the same color in the scene view.
        static readonly Dictionary<string, Color> GroupColors = new Dictionary<string, Color>
        {
            { "PropsBoundsCollision", new Color(1f, 0.55f, 0.1f) },   // orange - computed-bounds AABBs, the phantom-wall suspect
            { "PropsBodyCollision",   new Color(0.1f, 0.85f, 1f) },   // cyan - decomposed mode-3 body boxes (doorways stay open)
            { "PropsCollision",       new Color(1f, 0.35f, 0.6f) },   // rose - triangle proxy buckets (probe rows only)
            { "PropsFoliage",         new Color(0.25f, 0.85f, 0.3f) },// green - zero-response-mass leaf swish triggers
            { "Triggers",             new Color(1f, 0.95f, 0.2f) },   // yellow
            { "BoostPads",            new Color(0.25f, 0.5f, 1f) },   // blue
            { "BoostVolumes",         new Color(0.6f, 0.35f, 1f) },   // violet
            { "ResetZones",           new Color(1f, 0.2f, 0.2f) },    // red
            { "Physics",              new Color(0.9f, 0.3f, 0.95f) }, // magenta - knock-and-tumble body props
            { "AnimatedProps",        new Color(0.72f, 0.5f, 0.25f) },// tan
            { "BreakableLogos",       new Color(0.15f, 0.9f, 0.6f) },// spring green
            { "OobFloor",             new Color(0.65f, 0.85f, 0.2f) },// chartreuse
            { "OpenSlope_Map",              new Color(0.95f, 0.95f, 0.95f) },// white - boxes hanging directly off the map root
        };

        // A group the table doesn't know still gets its own stable hue (FNV-1a hash -> hue), never a shared gray.
        static Color ColorOf(string group)
        {
            if (GroupColors.TryGetValue(group, out var c)) return c;
            uint hash = 2166136261u;
            foreach (char ch in group) hash = (hash ^ ch) * 16777619u;
            return Color.HSVToRGB(hash % 360u / 360f, 0.75f, 0.95f);
        }

        // Where each family's record lives, for tracing a collider back to its authored data.
        static readonly Dictionary<string, string> GroupManifest = new Dictionary<string, string>
        {
            { "PropsBoundsCollision", "manifest Collision.ComputedBounds" },
            { "PropsBodyCollision",   "manifest Collision.Bodies" },
            { "PropsFoliage",         "manifest Collision.Foliage" },
            { "PropsCollision",       "manifest Collision.Buckets (collision.glb)" },
        };

        class ShapeEntry
        {
            public Collider Col;      // BoxCollider, CapsuleCollider, or SphereCollider
            public string Group;
        }

        class ProbeHit
        {
            public Collider Col;
            public string Group;
            public float Dist;
            public bool Reset;
        }

        // Does hitting this collider reset the rider? A MainType-13 host carries its reset on its OWN collision
        // rather than a ResetZone box - snowknife gives it its own "_R"-tagged bucket (Collision.Buckets with
        // ResetOnContact), and PropBuilder tags an animated host's moving segments the same way. Without this the
        // tool showed MERQUER's Parlament roof as an ordinary rose proxy bucket, with nothing to say it resets.
        //
        // Transcribed from RideableBoard.ResetOnContact so the two cannot drift: an "_R" token at the tail, ahead
        // of any "_T<surface>" suffix.
        static bool ResetsOnContact(Collider col)
        {
            if (col == null || col.isTrigger) return false;
            string nm = col.name;
            if (string.IsNullOrEmpty(nm)) return false;
            int end = nm.Length, i = end - 1;
            bool any = false;
            while (i >= 0 && nm[i] >= '0' && nm[i] <= '9') { i--; any = true; }
            if (any && i >= 1 && nm[i] == 'T' && nm[i - 1] == '_') end = i - 1;
            return end >= 2 && nm[end - 1] == 'R' && nm[end - 2] == '_';
        }

        readonly List<ShapeEntry> _boxes = new List<ShapeEntry>();
        readonly Dictionary<string, bool> _groupOn = new Dictionary<string, bool>();
        readonly List<ProbeHit> _hits = new List<ProbeHit>();
        bool _draw = true;
        bool _labels;
        float _drawDist = 250f;
        float _labelDist = 60f;
        float _probeRadius = 3f;
        Vector3 _probeCenter;
        bool _probed;
        Vector2 _scroll;

        [MenuItem("OpenSlope/Tools/Collision Debug", false, 701)]
        static void Open() => GetWindow<CollisionDebugWindow>("OpenSlope Collision");

        void OnEnable()
        {
            SceneView.duringSceneGui += OnSceneGUI;
            EditorApplication.hierarchyChanged += Refresh;
            Refresh();
        }

        void OnDisable()
        {
            SceneView.duringSceneGui -= OnSceneGUI;
            EditorApplication.hierarchyChanged -= Refresh;
            SceneView.RepaintAll();
        }

        // The importer parents each family under OpenSlope_Map/Level (or terrain under OpenSlope_Map/Collision); the child
        // of that node names the group. A collider outside any imported map reports its scene root instead.
        static string GroupOf(Transform t)
        {
            for (var cur = t; cur.parent != null; cur = cur.parent)
                if (cur.parent.name == "Level" || cur.parent.name == "Collision")
                    return cur.name;
            return t.root.name;
        }

        void Refresh()
        {
            _boxes.Clear();
            foreach (var col in FindObjectsOfType<Collider>(false))
            {
                if (!(col is BoxCollider || col is CapsuleCollider || col is SphereCollider)) continue;
                string group = GroupOf(col.transform);
                _boxes.Add(new ShapeEntry { Col = col, Group = group });
                if (!_groupOn.ContainsKey(group)) _groupOn[group] = true;
            }
            SceneView.RepaintAll();
            Repaint();
        }

        void OnSceneGUI(SceneView view)
        {
            if (_probed)
            {
                Handles.color = Color.white;
                Handles.DrawWireDisc(_probeCenter, Vector3.up, _probeRadius);
                Handles.DrawWireDisc(_probeCenter, Vector3.right, _probeRadius);
                Handles.DrawWireDisc(_probeCenter, Vector3.forward, _probeRadius);
            }
            if (!_draw) return;
            Vector3 eye = view.pivot;
            foreach (var e in _boxes)
            {
                if (e.Col == null || !_groupOn.TryGetValue(e.Group, out bool on) || !on) continue;
                Vector3 center = e.Col.bounds.center;
                float dist = Vector3.Distance(eye, center);
                if (dist > _drawDist) continue;
                using (new Handles.DrawingScope(ColorOf(e.Group), e.Col.transform.localToWorldMatrix))
                {
                    if (e.Col is BoxCollider box) Handles.DrawWireCube(box.center, box.size);
                    else if (e.Col is SphereCollider sph) DrawWireSphere(sph.center, sph.radius);
                    else if (e.Col is CapsuleCollider cap) DrawWireCapsule(cap);
                }
                if (_labels && dist <= _labelDist)
                    Handles.Label(center, e.Col.name);
            }
        }

        static void DrawWireSphere(Vector3 c, float r)
        {
            Handles.DrawWireDisc(c, Vector3.up, r);
            Handles.DrawWireDisc(c, Vector3.right, r);
            Handles.DrawWireDisc(c, Vector3.forward, r);
        }

        // Wire capsule in the collider's local space (Handles.matrix already applied): a disc + cap arcs at
        // each sphere center and four side lines. direction picks the local axis the segment runs along.
        static void DrawWireCapsule(CapsuleCollider cap)
        {
            Vector3 axis = cap.direction == 0 ? Vector3.right : cap.direction == 1 ? Vector3.up : Vector3.forward;
            Vector3 u = cap.direction == 0 ? Vector3.up : Vector3.right;
            Vector3 v = Vector3.Cross(axis, u);
            float half = Mathf.Max(0f, cap.height * 0.5f - cap.radius);
            Vector3 a = cap.center + axis * half, b = cap.center - axis * half;
            float r = cap.radius;

            Handles.DrawWireDisc(a, axis, r);
            Handles.DrawWireDisc(b, axis, r);
            foreach (var side in new[] { u, -u, v, -v })
            {
                Handles.DrawLine(a + side * r, b + side * r);
            }
            Handles.DrawWireArc(a, v, u, 180f, r);
            Handles.DrawWireArc(a, u, v, -180f, r);
            Handles.DrawWireArc(b, v, u, -180f, r);
            Handles.DrawWireArc(b, u, v, 180f, r);
        }

        void OnGUI()
        {
            EditorGUI.BeginChangeCheck();
            _draw = EditorGUILayout.ToggleLeft("Draw collision boxes in the scene view", _draw);
            _drawDist = EditorGUILayout.Slider("Draw distance (m)", _drawDist, 25f, 2000f);
            _labels = EditorGUILayout.ToggleLeft("Labels near the camera pivot", _labels);

            EditorGUILayout.Space(4);
            EditorGUILayout.LabelField("Groups", EditorStyles.boldLabel);
            foreach (var group in _groupOn.Keys.OrderBy(k => k).ToList())
            {
                using (new EditorGUILayout.HorizontalScope())
                {
                    var swatch = GUILayoutUtility.GetRect(14, 14, GUILayout.Width(14));
                    EditorGUI.DrawRect(swatch, ColorOf(group));
                    int count = _boxes.Count(b => b.Group == group);
                    _groupOn[group] = EditorGUILayout.ToggleLeft($"{group} ({count})", _groupOn[group]);
                }
            }
            if (EditorGUI.EndChangeCheck()) SceneView.RepaintAll();

            EditorGUILayout.Space(6);
            EditorGUILayout.LabelField("Probe", EditorStyles.boldLabel);
            _probeRadius = EditorGUILayout.Slider("Radius (m)", _probeRadius, 0.5f, 25f);
            var sel = Selection.activeTransform;
            EditorGUILayout.HelpBox(
                sel != null
                    ? $"Probe center: selected '{sel.name}'."
                    : "Probe center: the scene-view pivot (select any transform, e.g. a marker, to probe there).",
                MessageType.None);
            if (GUILayout.Button("Probe for overlapping colliders"))
            {
                _probeCenter = sel != null ? sel.position
                    : SceneView.lastActiveSceneView != null ? SceneView.lastActiveSceneView.pivot : Vector3.zero;
                _hits.Clear();
                foreach (var col in Physics.OverlapSphere(_probeCenter, _probeRadius, ~0, QueryTriggerInteraction.Collide))
                {
                    if (sel != null && col.transform.IsChildOf(sel)) continue;
                    _hits.Add(new ProbeHit
                    {
                        Col = col,
                        Group = GroupOf(col.transform),
                        Dist = Vector3.Distance(_probeCenter, col.bounds.ClosestPoint(_probeCenter)),
                        Reset = ResetsOnContact(col),
                    });
                }
                _hits.Sort((a, b) => a.Dist.CompareTo(b.Dist));
                _probed = true;
                SceneView.RepaintAll();
            }

            if (!_probed) return;
            EditorGUILayout.LabelField($"{_hits.Count} collider(s) within {_probeRadius:F1} m", EditorStyles.miniBoldLabel);
            _scroll = EditorGUILayout.BeginScrollView(_scroll);
            foreach (var hit in _hits)
            {
                if (hit.Col == null) continue;
                var size = hit.Col.bounds.size;
                string kind = hit.Col.GetType().Name.Replace("Collider", "") + (hit.Col.isTrigger ? " trigger" : "");
                using (new EditorGUILayout.HorizontalScope())
                {
                    var swatch = GUILayoutUtility.GetRect(10, 10, GUILayout.Width(10));
                    EditorGUI.DrawRect(swatch, ColorOf(hit.Group));
                    // A reset host wears the ResetZones red beside its own family colour: it is not a zone, but
                    // hitting it does the same thing, and that is the fact you are here to find.
                    if (hit.Reset)
                    {
                        var flag = GUILayoutUtility.GetRect(10, 10, GUILayout.Width(10));
                        EditorGUI.DrawRect(flag, ColorOf("ResetZones"));
                    }
                    string trace = GroupManifest.TryGetValue(hit.Group, out var m) ? $"  <{m}>" : "";
                    string reset = hit.Reset ? "  RESETS ON CONTACT" : "";
                    if (GUILayout.Button(
                            $"{hit.Group}/{hit.Col.name}  [{kind}]{reset}  d={hit.Dist:F2} m  size=({size.x:F1}, {size.y:F1}, {size.z:F1}){trace}",
                            EditorStyles.miniButtonLeft))
                    {
                        Selection.activeObject = hit.Col.gameObject;
                        EditorGUIUtility.PingObject(hit.Col.gameObject);
                    }
                    if (GUILayout.Button("Frame", EditorStyles.miniButtonRight, GUILayout.Width(48)))
                        SceneView.lastActiveSceneView?.Frame(hit.Col.bounds, false);
                }
            }
            EditorGUILayout.EndScrollView();
        }
    }
}
#endif
