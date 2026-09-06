#if UNITY_EDITOR
using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;

namespace OpenSlope.BasisPlugin
{

    // Builds the Basis UI boards - the Performance Board (per-player cosmetic toggle plates) and the Info Board (a display
    // panel with the control cheat-sheet + live rider count) - standing at the start gate. The Basis analogue of the
    // VRChat PerfBoardSetup + InfoBoardSetup, on Basis's own interactable pointer instead of uGUI: each toggle is a
    // BasisWorldToggle plate (point + trigger to flip, VR and desktop), and the Info Board is plain 3D TextMesh (no
    // interaction, so no UI-raycast plumbing). Called by BasisSetupAll.FinalizeScene, and re-runnable from the menu.
    //
    // Boards are built at SCENE ROOT with identity scale (like the board rack), NOT under OpenSlope_Map/Level (whose -90X / 0.01
    // scale would distort the colliders + text). They stand a little downhill of the gate, to either side, facing back up
    // toward the player who spawns at the gate. Tune the offsets if a level's gate sits oddly.
    public static class BasisBoardsSetup
    {
        const string PerfName = "PerfBoard";
        const string InfoName = "InfoBoard";
        const float SideOffset = 2.6f;      // metres to the side of the gate
        const float DownhillOffset = 1.5f;  // metres downhill of the gate (in front of the spawning player)
        const float BoardBaseHeight = 1.2f; // board centre height (m) above the gate ground

        [MenuItem("OpenSlope Basis/Setup/UI Boards", false, 170)]
        public static void SetupUiBoardsMenu()
        {
            if (SetupUiBoards()) Debug.Log("Basis: built the Performance + Info boards at the start gate.");
            else Debug.LogWarning("Basis: no gate/spawn anchor found - import a level first (OpenSlope Basis/Load/Map...).");
        }

        // Build (or rebuild) both boards. Returns false if there's no gate anchor yet. Idempotent: removes any prior boards.
        public static bool SetupUiBoards()
        {
            Transform gate = FindGate();
            if (gate == null) return false;

            Vector3 fwd = FlatForward(gate);
            Vector3 right = Vector3.Cross(Vector3.up, fwd).normalized;
            // Face back up toward the player standing at the gate (their spawn faces downhill, so the boards face -fwd).
            Quaternion facing = Quaternion.LookRotation(-fwd, Vector3.up);
            Vector3 baseCenter = gate.position + fwd * DownhillOffset + Vector3.up * BoardBaseHeight;

            Remove(PerfName); Remove(InfoName);
            BuildPerfBoard(baseCenter + right * SideOffset, facing);
            BuildInfoBoard(baseCenter - right * SideOffset, facing);

            EditorSceneManager.MarkSceneDirty(gate.gameObject.scene);
            return true;
        }

        // ---- Performance Board -----------------------------------------------------------------------------

        static void BuildPerfBoard(Vector3 pos, Quaternion facing)
        {
            var root = new GameObject(PerfName);
            Undo.RegisterCreatedObjectUndo(root, "Setup UI Boards");
            root.transform.SetPositionAndRotation(pos, facing);
            var perf = root.AddComponent<BasisPerfBoard>();

            BuildBacking(root.transform, new Vector3(0.62f, 1.0f, 0.02f), new Vector3(0f, 0f, 0.02f));
            MakeText(root.transform, "PERFORMANCE", new Vector3(0f, 0.42f, -0.02f), 0.06f, TextAnchor.MiddleCenter, Color.white);

            // One toggle plate + label per controllable system, stacked down the panel. Systems absent from this level leave
            // their target null (the board's Apply skips them), so the plate is harmless.
            float y = 0.26f;
            const float step = 0.17f;
            perf.cullToggle      = BuildRow(root.transform, ref y, step, "Cull distant props", true);
            perf.emittersToggle  = BuildRow(root.transform, ref y, step, "Snow cannons / flares", true);
            perf.gemSpinToggle   = BuildRow(root.transform, ref y, step, "Gem spin", true);
            perf.fireworksToggle = BuildRow(root.transform, ref y, step, "Fireworks", true);
            perf.boardFxToggle   = BuildRow(root.transform, ref y, step, "My board sparks", true);

            // Wire the plates to the level's systems (found in the loaded scene).
            perf.culler = Object.FindFirstObjectByType<BasisObjectCuller>(FindObjectsInactive.Include);
            perf.spinner = Object.FindFirstObjectByType<BasisSpinnerManager>(FindObjectsInactive.Include);
            var emitters = GameObject.Find("OpenSlope_Map/Emitters");
            perf.emittersObject = emitters;
            var fireworks = Object.FindObjectsByType<BasisFirework>(FindObjectsInactive.Include, FindObjectsSortMode.None);
            var fireObjs = new GameObject[fireworks.Length];
            for (int i = 0; i < fireworks.Length; i++) fireObjs[i] = fireworks[i].gameObject;
            perf.fireworkObjects = fireObjs;
        }

        // A labelled toggle row: the plate on the left, its label to the right. Advances y down the panel.
        static BasisWorldToggle BuildRow(Transform parent, ref float y, float step, string label, bool startOn)
        {
            var toggle = BuildPlate(parent, new Vector3(-0.24f, y, -0.02f), startOn);
            MakeText(parent, label, new Vector3(-0.12f, y, -0.02f), 0.045f, TextAnchor.MiddleLeft, Color.white);
            y -= step;
            return toggle;
        }

        static BasisWorldToggle BuildPlate(Transform parent, Vector3 localPos, bool startOn)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube); // Cube = BoxCollider (pointer target) + MeshRenderer
            go.name = "Plate";
            go.transform.SetParent(parent, false);
            go.transform.localPosition = localPos;
            go.transform.localScale = new Vector3(0.14f, 0.14f, 0.02f); // a flat plate
            var mr = go.GetComponent<MeshRenderer>();
            mr.sharedMaterial = PlateMaterial();
            var toggle = go.AddComponent<BasisWorldToggle>();
            toggle.targetRenderer = mr;
            toggle.IsOn = startOn;
            toggle.InteractRange = 2.5f;   // reachable from a step back (desktop reach is extended by the base)
            return toggle;
        }

        // ---- Info Board ------------------------------------------------------------------------------------

        static void BuildInfoBoard(Vector3 pos, Quaternion facing)
        {
            var root = new GameObject(InfoName);
            Undo.RegisterCreatedObjectUndo(root, "Setup UI Boards");
            root.transform.SetPositionAndRotation(pos, facing);
            var info = root.AddComponent<BasisInfoBoard>();

            BuildBacking(root.transform, new Vector3(0.9f, 1.0f, 0.02f), new Vector3(0f, 0f, 0.02f));
            MakeText(root.transform, "HOW TO RIDE", new Vector3(0f, 0.42f, -0.02f), 0.06f, TextAnchor.MiddleCenter, Color.white);

            info.playerText = MakeText(root.transform, "Riders here:  1", new Vector3(0f, 0.30f, -0.02f), 0.04f, TextAnchor.MiddleCenter, new Color(0.7f, 0.9f, 1f));

            // Static control cheat-sheet (desktop + VR), baked once. Left-anchored block. Mirrors BasisBoard.ReadInput /
            // ReadOllieTrigger / ReadBoostHeld - note JUMP is the dismount here (not the ollie) and the ollie is the right
            // trigger, exactly as on the VRChat board. Basis has NO carry / summon gesture, so those rows are absent.
            string controls =
                "Walk up to a board, press Interact to ride\n" +
                "Move / WASD : steer + tuck\n" +
                "Right trigger / Left-click : ollie (hold = charge)\n" +
                "Left trigger / Shift : boost\n" +
                "Air boost : hold boost, aims by hand / view\n" +
                "Jump : get off\n" +
                "\n" +
                "On foot:  jump + hold Trigger to FLY";
            MakeText(root.transform, controls, new Vector3(-0.4f, 0.12f, -0.02f), 0.04f, TextAnchor.UpperLeft, Color.white);
        }

        // ---- shared builders -------------------------------------------------------------------------------

        // A dark backing quad behind the text/plates (no collider - removed so it never blocks a plate's pointer ray).
        static void BuildBacking(Transform parent, Vector3 scale, Vector3 localPos)
        {
            var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
            go.name = "Backing";
            var col = go.GetComponent<Collider>();
            if (col != null) Object.DestroyImmediate(col);
            go.transform.SetParent(parent, false);
            go.transform.localPosition = localPos;
            go.transform.localScale = scale;
            var mr = go.GetComponent<MeshRenderer>();
            var m = new Material(UnlitShader());
            m.SetColor(BaseColorId(), new Color(0.06f, 0.07f, 0.10f, 1f));
            mr.sharedMaterial = m;
        }

        // A 3D TextMesh label. Best-effort font (a null builtin font leaves it blank but the board still works - the plate
        // COLOUR conveys on/off without the label). Returns the TextMesh so a caller can keep the dynamic one.
        static TextMesh MakeText(Transform parent, string text, Vector3 localPos, float charSize, TextAnchor anchor, Color color)
        {
            var go = new GameObject("Label");
            go.transform.SetParent(parent, false);
            go.transform.localPosition = localPos;
            go.transform.localRotation = Quaternion.identity;
            var tm = go.AddComponent<TextMesh>();
            tm.text = text;
            tm.anchor = anchor;
            tm.alignment = anchor == TextAnchor.MiddleCenter ? TextAlignment.Center : TextAlignment.Left;
            tm.color = color;
            tm.fontSize = 64;               // high res, scaled down by characterSize for crisp text
            tm.characterSize = charSize;
            var font = UiFont();
            if (font != null)
            {
                tm.font = font;
                var mr = go.GetComponent<MeshRenderer>();
                if (mr != null) mr.sharedMaterial = font.material;
            }
            return tm;
        }

        static Material _plateMat;
        static Material PlateMaterial()
        {
            // Shared base; each plate instantiates its own at runtime (targetRenderer.material) so states don't cross-talk.
            if (_plateMat == null) { _plateMat = new Material(UnlitShader()); _plateMat.SetColor(BaseColorId(), new Color(0.2f, 0.7f, 0.32f)); }
            return _plateMat;
        }

        static Shader _unlit;
        static Shader UnlitShader()
        {
            if (_unlit == null)
                _unlit = Shader.Find("Universal Render Pipeline/Unlit") ?? Shader.Find("Unlit/Color") ?? Shader.Find("Sprites/Default");
            return _unlit;
        }

        static int _baseColorId = -1;
        static int BaseColorId()
        {
            if (_baseColorId == -1) _baseColorId = Shader.PropertyToID("_BaseColor");
            return _baseColorId;
        }

        static Font _font;
        static Font UiFont()
        {
            if (_font == null)
                _font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
            return _font;
        }

        // ---- anchors ---------------------------------------------------------------------------------------

        static Transform FindGate()
        {
            var go = GameObject.Find("OpenSlope_Map/Locations/GateSpawn");
            if (go != null) return go.transform;
            go = GameObject.Find("OpenSlope_Map/Locations/PlayerSpawn");
            if (go != null) return go.transform;
            go = GameObject.Find("OpenSlope_Map/Locations/Spawn");
            return go != null ? go.transform : null;
        }

        static Vector3 FlatForward(Transform anchor)
        {
            Vector3 f = anchor != null ? Vector3.ProjectOnPlane(anchor.forward, Vector3.up) : Vector3.forward;
            return f.sqrMagnitude > 1e-4f ? f.normalized : Vector3.forward;
        }

        static void Remove(string name)
        {
            var go = GameObject.Find(name);
            if (go != null && go.transform.parent == null) Object.DestroyImmediate(go);
        }
    }
}
#endif
