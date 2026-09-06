#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using UdonSharpEditor;

namespace OpenSlope.VrcPlugin
{

    // Library setup step: stand up the in-world INFO BOARD (InfoBoard) - the leftmost panel in the row behind the start
    // gate (bench slot 0, see Map.BenchSlot). It's a pure DISPLAY panel: a live instance-owner line plus a static
    // cheat-sheet of the board controls (desktop + VR). What it shows + how the one live line refreshes lives in the
    // InfoBoard header.
    //
    // No interactive widgets (nothing to click), so unlike the sibling boards it builds no colliders / Interact behaviours
    // - just text on a panel, with one Text wired into the Udon for the owner line. Lives under OpenSlope_Map/GateBench, the
    // shared parent of the bench row (cleared when a map is switched) - re-run after loading a map, AND after the Start
    // Gate (it lines up behind a gate post). Idempotent:
    // deletes + rebuilds its object each run. Same two-step Udon bootstrap as the sibling setups (a freshly created U#
    // program asset can't be attached in the same call). See docs/vrchat/013-udon-components.md.
    public static class InfoBoardSetup
    {
        const string ObjName     = "InfoBoard";   // OpenSlope_Map/GateBench/InfoBoard
        const string PoleMatPath = Map.AssetsFolder + "/InfoBoardPole.mat";

        const int   Slot        = 0;      // bench order: 0 Info · 1 Settings · 2 Players · 3 Jukebox · 4 Diagnostics (Map.BenchSlot)
        const int   SlotCount   = 5;
        const float PostBehind  = 6.0f;   // metres uphill (behind) the matching snowboard at the gate
        const float PostHeight  = 1.4f;
        const float PostDiam    = 0.10f;
        const float PanelBottom = 1.05f;
        const float PanelClear  = 0.18f;

        const float CanvasW = 700f;   // ~1.11 m wide at PanelScale (matches the sibling boards)
        const float TitleH  = 96f;
        const float OwnerH  = 58f;    // the live instance-owner line
        const float SectH   = 46f;    // a "DESKTOP" / "VR" sub-header
        const float LineH   = 33.5f;  // one cheat-sheet row at fontSize 25 / lineSpacing 1.1, with slack
        const float Pad     = 24f;
        const float PanelScale = 0.00158f;

        // The board controls, baked as text (the rideable board's real input map - see RideableBoard). Keep each row
        // under ~50 characters: the block wraps at CanvasW - 2*Pad, and a wrapped row costs a line the height budget
        // below doesn't know about.
        //
        // Carry / summon / grab-off-your-feet are VR ONLY and deliberately absent from the desktop list: desktop collapses
        // Use and Grab onto the one left-click, so the click resolves to riding (RideableBoard.Grab.cs).
        const string DesktopControls =
            "Get a board:  look at a red gate post + E\n" +
            "Ride:  look at the board + E\n" +
            "Steer:  A / D\n" +
            "Tuck / brake:  W / S\n" +
            "Ollie:  Left-click  (hold = bigger)\n" +
            "Boost:  hold Right-mouse\n" +
            "Air boost:  the same, aimed where you look\n" +
            "Spin / flip (in air):  A / D  ·  W / S\n" +
            "Get off:  Space  (on a rail, ollie hops off)\n" +
            "On foot:  jump + hold Left-click to fly\n" +
            "Carry / summon a board:  VR only";
        const string VrControls =
            "Get a board:  point at a red gate post + Trigger\n" +
            "Ride:  point at the board + Trigger\n" +
            "Steer:  left stick  ·  or look / turn\n" +
            "Tuck / brake:  left stick up / down\n" +
            "Ollie:  right trigger  (hold = bigger)\n" +
            "Boost:  hold left trigger\n" +
            "Air boost:  the same, aimed by your left hand\n" +
            "Spin / flip (in air):  left stick L-R  ·  U-D\n" +
            "Get off:  jump  (on a rail, ollie hops off)\n" +
            "Take the board off (in air):  Grip while riding\n" +
            "Put it back on:  Trigger while holding it\n" +
            "Summon a board:  Grip behind your head\n" +
            "Carry / drop:  Grip the deck  ·  release to throw\n" +
            "Pass hand to hand:  Grip with your free hand\n" +
            "On foot:  jump + hold right trigger to fly";

        [MenuItem("OpenSlope/Setup/Info Board", false, 171)]
        public static void Setup()
        {
            // Two-step bootstrap: a just-created U# program asset can't have a component attached in the same call.
            bool firstTime = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(InfoBoard)) == null;
            if (UdonTools.EnsureProgramAsset<InfoBoard>(out _) == null)
            {
                Debug.LogError("OpenSlope: could not create/find the InfoBoard program asset; aborting.");
                return;
            }
            if (firstTime)
            {
                Debug.Log("OpenSlope: created the Udon program asset. UdonSharp finalizes it on the next editor tick - " +
                          "run 'OpenSlope/Setup/Info Board' again to build the board.");
                return;
            }

            Map.ClearBenchBoard(ObjName);

            // Placement: behind (uphill of) the snowboard at this board's start-gate post, facing downhill at the player.
            var board = new GameObject(ObjName);
            Map.PlaceOnBench(board.transform, Slot, SlotCount, PostBehind);

            var udon = board.GetComponent<InfoBoard>() ?? board.AddUdonSharpComponent<InfoBoard>();

            Transform panel = BuildPanel(board.transform, Map.BenchPanelHeight);   // identical height across the board row

            Font font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");

            float y = -TitleH;
            udon.ownerText = BuildOwnerLine(panel, y, font);
            y -= OwnerH;

            // Block heights follow the row COUNT (the lists are edited far more often than this layout is). The blocks
            // Truncate, and the canvas is the shared Map.BenchPanelHeight, so a hand-tuned constant here silently
            // crops the rows you just added; ContentHeight() is what keeps Map's "sized to the tallest board" honest.
            float desktopH = BlockHeight(DesktopControls);
            float vrH      = BlockHeight(VrControls);

            BuildSection(panel, y, "Desktop", font); y -= SectH;
            BuildTextBlock(panel, y, desktopH, DesktopControls, font); y -= desktopH;

            BuildSection(panel, y, "VR", font); y -= SectH;
            BuildTextBlock(panel, y, vrH, VrControls, font); y -= vrH;

            if (ContentHeight() > Map.BenchPanelHeight)
                Debug.LogWarning($"OpenSlope: the Info Board's content is {ContentHeight():0} px but the shared bench canvas is " +
                                 $"{Map.BenchPanelHeight:0} px - the bottom rows will be CROPPED. Raise " +
                                 "Map.BenchPanelHeight (it is sized to the tallest board).");

            UdonSharpEditorUtility.CopyProxyToUdon(udon);   // push ownerText into the backing UdonBehaviour
            BuildPole(board.transform);

            Selection.activeGameObject = board;
            EditorSceneMarkDirty(board);
            Debug.Log($"OpenSlope: Info Board ready at {Map.RootName}/{Map.GateBench}/{ObjName} - the live instance owner + desktop/VR control " +
                      "cheat-sheet, leftmost behind the start gate. Display-only (no clicks). Enter Play (ClientSim) or " +
                      "upload to see the owner line populate.");
        }

        // Setup IS the refresh: it find-or-creates and rebuilds the board in place, so re-running it after a data change
        // is the only entry needed (there is no separate OpenSlope/Refresh item). Greyed out until a map is loaded.
        [MenuItem("OpenSlope/Setup/Info Board", true)]
        static bool SetupEnabled() => GameObject.Find(Map.RootName) != null;

        // ---- panel + content --------------------------------------------------------------------------------------

        // Rows in a cheat-sheet block. Counts AUTHORED rows, so a row long enough to wrap is undercounted - keep the
        // literals under ~50 characters (see the note on DesktopControls).
        static int RowCount(string block) => block.Split('\n').Length;

        static float BlockHeight(string block) => RowCount(block) * LineH;

        // Total canvas px this board wants, for the crop check against the shared bench height.
        static float ContentHeight()
            => TitleH + OwnerH + 2f * SectH + BlockHeight(DesktopControls) + BlockHeight(VrControls);

        static Transform BuildPanel(Transform boardRoot, float canvasH)
        {
            var canvasGO = new GameObject("Panel", typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            canvasGO.transform.SetParent(boardRoot, false);
            canvasGO.GetComponent<Canvas>().renderMode = RenderMode.WorldSpace;
            var crt = canvasGO.GetComponent<RectTransform>();
            crt.sizeDelta = new Vector2(CanvasW, canvasH);
            crt.localRotation = Quaternion.identity;
            crt.localScale = Vector3.one * PanelScale;
            crt.pivot = new Vector2(0.5f, 0f);
            crt.localPosition = new Vector3(0f, Map.BenchPanelBottom, -PanelClear);

            var bg = NewUI("Backdrop", crt, out var bgRt); Stretch(bgRt);
            var bgImg = bg.AddComponent<Image>();
            bgImg.color = new Color(0.05f, 0.08f, 0.09f, 0.80f);   // a cool-dark tint, distinct from the sibling boards
            bgImg.raycastTarget = false;

            var titleGO = NewUI("Title", crt, out var titleRt);
            titleRt.anchorMin = new Vector2(0f, 1f); titleRt.anchorMax = new Vector2(1f, 1f); titleRt.pivot = new Vector2(0.5f, 1f);
            titleRt.anchoredPosition = new Vector2(0f, -Pad * 0.5f); titleRt.sizeDelta = new Vector2(0f, TitleH);
            var title = titleGO.AddComponent<Text>();
            var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
            title.font = font; title.fontSize = 40; title.fontStyle = FontStyle.Bold; title.color = Color.white;
            title.alignment = TextAnchor.UpperCenter; title.raycastTarget = false; title.supportRichText = true;
            title.text = "INFO\n<size=22>instance  ·  how to ride</size>";

            return crt;
        }

        static void BuildSection(Transform panel, float yTop, string text, Font font)
        {
            var go = NewUI("Section_" + text, panel, out var rt);
            rt.anchorMin = new Vector2(0f, 1f); rt.anchorMax = new Vector2(0f, 1f); rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(Pad, yTop);
            rt.sizeDelta = new Vector2(CanvasW - 2f * Pad, SectH);
            var t = go.AddComponent<Text>();
            t.font = font; t.fontSize = 26; t.fontStyle = FontStyle.Bold; t.color = new Color(0.62f, 0.78f, 0.95f);
            t.alignment = TextAnchor.LowerLeft; t.raycastTarget = false; t.supportRichText = false;
            t.horizontalOverflow = HorizontalWrapMode.Overflow; t.verticalOverflow = VerticalWrapMode.Truncate;
            t.text = text.ToUpperInvariant();
        }

        // The one live line (the board rewrites this Text with the instance owner). Returns its Text.
        static Text BuildOwnerLine(Transform panel, float yTop, Font font)
        {
            var go = NewUI("OwnerLine", panel, out var rt);
            rt.anchorMin = new Vector2(0f, 1f); rt.anchorMax = new Vector2(0f, 1f); rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(Pad, yTop);
            rt.sizeDelta = new Vector2(CanvasW - 2f * Pad, OwnerH);
            var t = go.AddComponent<Text>();
            t.font = font; t.fontSize = 30; t.fontStyle = FontStyle.Bold; t.color = new Color(0.92f, 0.95f, 1f);
            t.alignment = TextAnchor.MiddleLeft; t.raycastTarget = false; t.supportRichText = false;
            t.horizontalOverflow = HorizontalWrapMode.Wrap; t.verticalOverflow = VerticalWrapMode.Truncate;
            t.text = "Instance owner:  …";   // placeholder until InfoBoard fills it on Start
            return t;
        }

        // A non-interactive multi-line cheat-sheet block (top-left aligned, wrapped).
        static void BuildTextBlock(Transform panel, float yTop, float h, string text, Font font)
        {
            var go = NewUI("Block", panel, out var rt);
            rt.anchorMin = new Vector2(0f, 1f); rt.anchorMax = new Vector2(0f, 1f); rt.pivot = new Vector2(0f, 1f);
            rt.anchoredPosition = new Vector2(Pad, yTop);
            rt.sizeDelta = new Vector2(CanvasW - 2f * Pad, h);
            var t = go.AddComponent<Text>();
            t.font = font; t.fontSize = 25; t.color = new Color(0.86f, 0.90f, 0.94f);
            t.alignment = TextAnchor.UpperLeft; t.raycastTarget = false; t.supportRichText = false;
            t.lineSpacing = 1.1f;
            t.horizontalOverflow = HorizontalWrapMode.Wrap; t.verticalOverflow = VerticalWrapMode.Truncate;
            t.text = text;
        }

        static void BuildPole(Transform boardRoot)
        {
            var pole = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            pole.name = "Pole";
            var pc = pole.GetComponent<Collider>(); if (pc != null) Object.DestroyImmediate(pc);
            pole.transform.SetParent(boardRoot, false);
            float poleTop = Map.BenchPanelBottom + Map.BenchPanelHeight * PanelScale;   // reach the panel top so the pole backs the whole board
            pole.transform.localScale = new Vector3(PostDiam, poleTop * 0.5f, PostDiam);
            pole.transform.localPosition = new Vector3(0f, poleTop * 0.5f, 0f);
            var mat = LoadOrCreatePoleMaterial();
            if (mat != null) pole.GetComponent<MeshRenderer>().sharedMaterial = mat;
        }

        // ---- small UI + scene helpers (mirroring the sibling board setups) ------------------------------------------

        static GameObject NewUI(string name, Transform parent, out RectTransform rt)
        {
            var go = new GameObject(name, typeof(RectTransform));
            rt = go.GetComponent<RectTransform>();
            rt.SetParent(parent, false);
            rt.localScale = Vector3.one; rt.localRotation = Quaternion.identity;
            return go;
        }

        static void Stretch(RectTransform rt) { rt.anchorMin = Vector2.zero; rt.anchorMax = Vector2.one; rt.offsetMin = Vector2.zero; rt.offsetMax = Vector2.zero; }

        static Material LoadOrCreatePoleMaterial()
        {
            var existing = AssetDatabase.LoadAssetAtPath<Material>(PoleMatPath);
            if (existing != null) return existing;
            var sh = Shader.Find("Standard");
            if (sh == null) return null;
            var mat = new Material(sh) { name = "InfoBoardPole", color = new Color(0.13f, 0.18f, 0.20f) };
            mat.EnableKeyword("_EMISSION");
            mat.SetColor("_EmissionColor", new Color(0.06f, 0.16f, 0.20f));
            mat.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
            AssetDatabase.CreateAsset(mat, PoleMatPath);
            AssetDatabase.SaveAssets();
            return mat;
        }

        static void EditorSceneMarkDirty(GameObject go)
            => UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
    }
}
#endif
