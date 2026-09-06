#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using UdonSharpEditor;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // Library setup step: stand up the course LEADERBOARD (Leaderboard) + the FINISH LINE trigger (FinishLine) at the
    // BOTTOM of the run (docs/050). A rider's run is timed + scored from the moment they mount a board (RideableBoard.Score)
    // until they cross the finish; the finish records it into the board, which keeps two top-10 lists - best trick SCORES and
    // fastest TIMES, one best per player - and shows them on the display board.
    //
    // PLACEMENT is auto-derived, entirely from the game's own data. The finish PLANE is the DTF=0 crossing of the baked
    // course progress (OpenSlope_Map/CoursePath's DistToFinish) - the engine's real finish, interpolated inside the race-line
    // segment that straddles zero. The finish arch the rider passes through (Mdl_FinnishGate_* - the game's spelling)
    // straddles that plane, so its imported bounds size the trigger's width + height; we only choose the depth. The box's
    // UPHILL face sits on the DTF=0 plane, so the record fires the instant the rider crosses it. (Mdl_StageArea_Finish is NOT
    // the line - it is the podium 20-48 m past it - and it isn't in the scene anyway; see ResolveGateArch's note.) The
    // display board stands in the run-out just past the line, SEATED ON THE SNOW under that spot (Map.GroundYTerrain,
    // the same ground rule the start gate uses), facing back uphill. A level with no baked DTF falls back to a
    // generous catch box at the course-path lowest point, then the player spawn. Both live under OpenSlope_Map (cleared when a map
    // is switched - re-run after loading a map); nudge afterward to taste. Needs the course progress baked first
    // (OpenSlope/Refresh/Course Path, which bakes the progress as it rebuilds; also part of Setup All). docs/050.
    //
    // Same two-step Udon bootstrap as the sibling board setups (a freshly created U# program asset can't be attached in the
    // same call). Idempotent: deletes + rebuilds both objects each run.
    public static class LeaderboardSetup
    {
        const string BoardName  = "Leaderboard";   // OpenSlope_Map/Leaderboard
        const string FinishName = "FinishLine";    // OpenSlope_Map/FinishLine
        const string PoleMatPath = Map.AssetsFolder + "/LeaderboardPole.mat";

        // Touch-to-win GATE box at the DTF=0 crossing. Width comes from the level's own finish arch
        // (Mdl_FinnishGate_* - the game's spelling - baked into the bundle by snowknife as CoursePath.FinishArch*); the
        // depth is ours, and so is the HEADROOM, because the engine's crossing is a PROGRESS test with no height in it
        // at all ([Trailmap: 390]) - a rider who flies over the crossbar has still crossed. The box's uphill face lies
        // ON the DTF=0 plane, so it fires the moment the rider crosses - the depth just stops a fast rider tunnelling it.
        const float GateMargin = 2f;    // world m of slack around the arch (width, and below its base)
        const float GateThick  = 8f;    // world m downhill of the plane
        // World m of catch ABOVE the arch's crossbar. An arch-height box misses any rider who crosses the plane
        // airborne, and MEGAPLE makes that the common case: its finish-shaft mouth reaches ~11 m above the crossbar
        // and the run drops riders into the funnel from above, so a crossbar-height gate never fires, no lap ever
        // counts, and the tube lifts forever. 30 m clears that mouth with margin while staying under the stacked
        // course routes overhead.
        const float GateHeadroom = 30f;

        // Fallback finish box (world m) for a level with no baked DTF - generous so a fast rider can't tunnel it.
        const float FinishWidth  = 80f;   // across the fall line
        const float FinishHeight = 40f;   // tall
        const float FinishThick  = 8f;    // along travel

        // Display board offset from the DTF=0 point, in the finish frame (world m); it faces back up the hill. Hand-picked
        // in the scene and read back: the run-out flat just past the line, a nudge right of the fall line. Both offsets are
        // HORIZONTAL - the height is then seated on the snow (see below), because a run-out that keeps dropping past the
        // line would otherwise leave the board hanging in the air (GARI drops ~4 m over these 27.5 m).
        const float BoardSide   = 2f;     // to the rider's right of the fall line
        const float BoardAhead  = 27.5f;  // past the line, into the run-out (before Mdl_StageArea_Finish, ~34 m on MERQUER)

        // Canvas-space (px) layout for the two-column panel.
        const int   Rows       = Leaderboard.Capacity;  // 10 per column
        const float CanvasW    = 1400f;
        const float TitleH     = 120f;
        const float ColTitleH  = 64f;
        const float RowH       = 58f;
        const float Pad        = 30f;
        const float ColGap     = 50f;
        const float PanelScale = 0.0019f;   // 1400 px * 0.0019 ~= 2.66 m wide (a big scoreboard)
        const float PanelBottomY = 1.6f;    // world m: bottom edge of the panel above the board origin

        [MenuItem("OpenSlope/Setup/Leaderboard", false, 172)]
        public static void Setup()
        {
            // Two-step bootstrap: a just-created U# program asset can't have a component attached in the same call.
            bool firstTime = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(Leaderboard)) == null
                          || UdonSharpProgramAsset.GetProgramAssetForClass(typeof(FinishLine)) == null;
            if (UdonTools.EnsureProgramAsset<Leaderboard>(out _) == null)
            {
                Debug.LogError("OpenSlope: could not create/find the Leaderboard program asset; aborting.");
                return;
            }
            UdonTools.EnsureProgramAsset<FinishLine>(out _);
            if (firstTime)
            {
                Debug.Log("OpenSlope: created the Udon program asset(s). UdonSharp finalizes them on the next editor tick - " +
                          "run 'OpenSlope/Setup/Leaderboard' again to build the leaderboard + finish line.");
                return;
            }

            Transform root = Map.ResolveRoot(true);
            var oldBoard = root.Find(BoardName); if (oldBoard != null) Object.DestroyImmediate(oldBoard.gameObject);
            var oldFin = root.Find(FinishName); if (oldFin != null) Object.DestroyImmediate(oldFin.gameObject);

            // The finish plane (DTF=0 crossing) + which way is downhill there; haveDtf = the plane is real, not a fallback.
            Vector3 finishPos; Vector3 downhill; string finishSrc; bool haveDtf;
            ResolveFinish(root, out finishPos, out downhill, out finishSrc, out haveDtf);
            Quaternion faceUphill = Quaternion.LookRotation(downhill, Vector3.up); // readable face (= -forward) points uphill at incoming riders
            Vector3 right = Vector3.Cross(Vector3.up, downhill).normalized;
            if (right.sqrMagnitude < 1e-4f) right = Vector3.right;

            // ---- the display board (build FIRST so the finish can reference it) ----
            var boardGo = new GameObject(BoardName);
            boardGo.transform.SetParent(root, true);
            // Stand the board in the run-out PAST the line (the flat the rider coasts into), near the fall line and facing
            // back up at them, so a finisher reads it head-on without turning round. The two offsets above are horizontal,
            // so the board would otherwise keep the finish PLANE's height - fine on a level run-out, metres in the air on a
            // course that keeps descending past the line. SEAT IT ON THE SNOW with the library's one ground rule
            // (Map.GroundYTerrain - the same call the start gate seats its posts and spawns with): prop colliders are
            // ignored, and a ride-through structure's ceiling can't be mistaken for the floor. Its pole is built from this
            // origin upward, so seating the origin plants the whole board.
            Vector3 boardPos = finishPos + right * BoardSide + downhill * BoardAhead;
            boardPos.y = Map.GroundYTerrain(boardPos.x, boardPos.z, boardPos.y + 60f, boardPos.y);
            boardGo.transform.SetPositionAndRotation(boardPos, faceUphill);
            var lb = boardGo.GetComponent<Leaderboard>() ?? boardGo.AddUdonSharpComponent<Leaderboard>();

            Font font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
            Text[] scoreRows, timeRows;
            BuildPanel(boardGo.transform, font, out scoreRows, out timeRows);
            lb.scoreRows = scoreRows;
            lb.timeRows = timeRows;
            UdonSharpEditorUtility.CopyProxyToUdon(lb);
            BuildPole(boardGo.transform);

            // ---- the finish trigger volume (an invisible pass-through box the RiderProbe sweeps; touch = win) ----
            var finGo = new GameObject(FinishName);
            finGo.transform.SetParent(root, true);
            var box = finGo.AddComponent<BoxCollider>();
            box.isTrigger = true;
            Bounds arch;
            if (haveDtf && ResolveGateArch(root, out arch))
            {
                // The arch straddles the DTF=0 plane: it gives the width, the plane gives the crossing. Slide the arch
                // centre back ONTO the plane along travel, then push forward half the depth so the box's uphill face is the
                // plane itself. Vertical span covers the arch (its posts sink below the snow) up past its crossbar by the
                // headroom - the crossing is height-agnostic, so an airborne rider must sweep the gate too (see GateHeadroom).
                float bottom = Mathf.Min(arch.min.y, finishPos.y) - GateMargin;
                float top    = arch.max.y + GateHeadroom;
                Vector3 e    = arch.extents;
                float width  = 2f * (Mathf.Abs(e.x * right.x) + Mathf.Abs(e.z * right.z)) + GateMargin;

                Vector3 c = new Vector3(arch.center.x, (bottom + top) * 0.5f, arch.center.z);
                c -= downhill * Vector3.Dot(c - finishPos, downhill);   // onto the DTF=0 plane (downhill is flat, so y is untouched)
                c += downhill * (GateThick * 0.5f);                     // uphill face == the plane

                finGo.transform.SetPositionAndRotation(c, Quaternion.LookRotation(downhill, Vector3.up));
                box.size = new Vector3(width, top - bottom, GateThick);
                box.center = Vector3.zero;
                finishSrc += $" + FinnishGate arch ({width:F1} x {top - bottom:F1} m)";
            }
            else
            {
                // No arch (or no DTF): a generous catch box rising from the finish point, oriented across the fall line.
                finGo.transform.SetPositionAndRotation(finishPos, Quaternion.LookRotation(downhill, Vector3.up));
                box.size = new Vector3(FinishWidth, FinishHeight, FinishThick);
                box.center = new Vector3(0f, FinishHeight * 0.5f, 0f);
                if (haveDtf)
                    Debug.LogWarning("OpenSlope: Leaderboard - no finish arch on OpenSlope_Map/CoursePath, so the finish is a generous " +
                                     "catch box rather than the course's own gate. Regenerate the bundle (`snowknife gltf " +
                                     "<level>`), run OpenSlope/Refresh/Course Path, then re-run this to size it from the arch.");
            }
            // LAPS come from the imported map (manifest.Race.Laps), which is where the number is decided: retail seeds
            // a lap countdown for MEGAPLEX alone and an authored map states its own count on export
            // ([Trailmap: 390-lap-counter]). Seeded here on every run because this setup rebuilds the finish object,
            // so re-importing a map with a different count is all it takes to race it correctly.
            int laps = BundleManifestReader.ReadLaps(ImportConfig.Current().LevelFolder);
            float showoffSeconds = BundleManifestReader.ReadShowoffSeconds(ImportConfig.Current().LevelFolder);
            UdonTools.AddConfigured<FinishLine>(finGo, u => {
                u.leaderboard = lb; u.Cooldown = 3f; u.Laps = laps; u.ShowoffSeconds = showoffSeconds;
            });

            Selection.activeGameObject = boardGo;
            EditorSceneMarkDirty(boardGo);
            Debug.Log($"OpenSlope: Leaderboard ready at {Map.RootName}/{BoardName} + finish trigger at {Map.RootName}/{FinishName} " +
                      $"(finish from {finishSrc} at {finishPos:F0}, {laps} lap{(laps == 1 ? "" : "s")}, " +
                      $"{showoffSeconds:F0}s showoff seed). Two top-10 lists - best " +
                      "scores + fastest times, one per player. Mount a board (run starts at 0), cross the finish to record. " +
                      "Nudge/resize the finish box + board to taste.");
        }

        // Setup IS the refresh: it find-or-creates and rebuilds the board in place, so re-running it after a data change
        // is the only entry needed (there is no separate OpenSlope/Refresh item). Greyed out until a map is loaded.
        [MenuItem("OpenSlope/Setup/Leaderboard", true)]
        static bool SetupEnabled() => GameObject.Find(Map.RootName) != null;

        // The finish anchor, in priority order:
        //   1. the DTF=0 crossing on the baked course progress (the plane the player crosses) -> haveDtf = true;
        //   2. the LOWEST world point of the baked course path (a level with no DTF) -> a generous catch box;
        //   3. the player spawn (no course path at all).
        // `downhill` = travel direction at the finish (the DTF tangent, else the gate fall-line). `source` names the branch.
        static void ResolveFinish(Transform root, out Vector3 pos, out Vector3 downhill, out string source, out bool haveDtf)
        {
            // downhill from the gate anchor's forward, projected flat (same reference Map.BenchSlot uses).
            Transform a = Map.Location(Map.GateSpawn, false) ?? Map.Location(Map.PlayerSpawn, false);
            Vector3 dh = a != null ? Vector3.ProjectOnPlane(a.forward, Vector3.up) : Vector3.forward;
            downhill = dh.sqrMagnitude > 1e-4f ? dh.normalized : Vector3.forward;
            haveDtf = false;

            // 1. The real finish: where DistToFinish crosses 0 on the course progress. The Mdl_StageArea_Finish instance is
            //    the PODIUM 20-48 m past it, so we don't use it (docs/050).
            Vector3 z, ztan;
            if (ResolveDtfZero(root, out z, out ztan))
            {
                pos = z; haveDtf = true; source = "DTF=0 plane";
                Vector3 zt = Vector3.ProjectOnPlane(ztan, Vector3.up);
                if (zt.sqrMagnitude > 1e-4f) downhill = zt.normalized;   // travel dir at the plane (for the board placement)
                return;
            }

            // 2. No DTF baked: the course-path spine's lowest point (generous fallback box).
            RailNetwork net = CourseNet(root);
            if (net != null && net.LocalPoints != null && net.LocalPoints.Length > 0)
            {
                float bestY = float.PositiveInfinity;
                Vector3 best = Vector3.zero;
                for (int i = 0; i < net.LocalPoints.Length; i++)
                {
                    Vector3 w = net.transform.TransformPoint(net.LocalPoints[i]);
                    if (w.y < bestY) { bestY = w.y; best = w; }
                }
                pos = best;
                source = "course-path lowest point (no DTF baked)";
                Debug.LogWarning("OpenSlope: Leaderboard - no baked course progress (DistToFinish) to find the DTF=0 plane; placed a " +
                                 "generous finish box at the course path's lowest point. Run OpenSlope/Refresh/Course Path, then re-run this.");
                return;
            }

            // 3. No course path: drop it at the spawn and warn (the author places it by hand).
            Transform spawn = Map.Location(Map.PlayerSpawn, false) ?? a;
            pos = spawn != null ? spawn.position : root.position;
            source = "player spawn (no course path)";
            Debug.LogWarning("OpenSlope: Leaderboard - no course path (OpenSlope_Map/CoursePath); placed the finish at the player spawn. " +
                             "Move it to the actual finish by hand.");
        }

        // The world point where DistToFinish crosses 0 on OpenSlope_Map/CoursePath (the engine's finish crossing) + the travel
        // direction there. False when no progress field is baked (run OpenSlope/Refresh/Course Path first).
        //
        // The crossing is INTERPOLATED inside the race-line segment that straddles zero (dtf > 0 -> dtf <= 0). Race-line
        // vertices are ~10 m apart on average but the final segment can be far longer - MERQUER's is 80 m - so snapping to
        // the vertex nearest zero lands up to half a segment uphill of the real line (~20 m on MERQUER). Only race lines
        // carry a DTF (CourseProgressBuilder NaNs the AI/respawn lines), and the .aip lines are baked before the .sop ones,
        // so the FIRST line that crosses zero is the .aip authoring - the one that lands on the finish arch. (Where the two
        // files disagree the .sop copy is the late one: on Garibaldi its last line zeroes ~14 m past the arch.)
        static bool ResolveDtfZero(Transform root, out Vector3 pos, out Vector3 tangent)
        {
            pos = Vector3.zero; tangent = Vector3.forward;
            RailNetwork net = CourseNet(root);
            if (net == null || net.DistToFinish == null || net.LocalPoints == null) return false;
            float[] dtf = net.DistToFinish; var lp = net.LocalPoints;
            if (dtf.Length != lp.Length) return false;
            int[] rs = net.RailStart, rc = net.RailCount;
            if (rs == null || rc == null) return false;

            int lines = Mathf.Min(rs.Length, rc.Length);
            for (int r = 0; r < lines; r++)
            {
                int s = rs[r], c = rc[r];
                if (c < 2 || s < 0 || s + c > dtf.Length) continue;
                for (int j = 1; j < c; j++)
                {
                    float a = dtf[s + j - 1], b = dtf[s + j];
                    if (float.IsNaN(a) || float.IsNaN(b) || a <= 0f || b > 0f) continue;   // want a > 0 >= b: the straddle
                    Vector3 pa = net.transform.TransformPoint(lp[s + j - 1]);
                    Vector3 pb = net.transform.TransformPoint(lp[s + j]);
                    pos = Vector3.Lerp(pa, pb, a / (a - b));   // DTF is linear along a straight segment, so this is exact
                    if ((pb - pa).sqrMagnitude > 1e-6f) tangent = pb - pa;
                    return true;
                }
            }
            return false;   // no race line reaches the finish (no DTF baked, or a course fragment)
        }

        static RailNetwork CourseNet(Transform root)
        {
            Transform cp = root.Find(Map.CoursePath);
            return cp != null ? cp.GetComponent<RailNetwork>() : null;
        }

        // The level's own finish ARCH: the union AABB of its Mdl_FinnishGate_* parts (crossbar + both posts), baked into
        // the bundle by snowknife from the props mesh - the one representation every level has (their collision shape
        // varies: bounds box, doorway body, or proxy mesh). It straddles the DTF=0 plane, so its width + height ARE the
        // crossing's. Local -> world by corners: the level root's axis swap keeps an AABB axis-aligned, so this is tight.
        static bool ResolveGateArch(Transform root, out Bounds arch)
        {
            arch = default;
            RailNetwork net = CourseNet(root);
            if (net == null || net.FinishArchSize.sqrMagnitude < 1e-6f) return false;
            Vector3 c = net.FinishArchCenter, e = net.FinishArchSize * 0.5f;
            arch = new Bounds(net.transform.TransformPoint(c), Vector3.zero);
            for (int i = 0; i < 8; i++)
                arch.Encapsulate(net.transform.TransformPoint(c + new Vector3(
                    (i & 1) == 0 ? -e.x : e.x, (i & 2) == 0 ? -e.y : e.y, (i & 4) == 0 ? -e.z : e.z)));
            return true;
        }

        // NOTE: there is no scene object to hang the board on. `Mdl_StageArea_Finish` (the post-race podium/corral, 20-48 m
        // past the line) carries PlayerCollision=false, so snowknife emits no bounds box for it and the importer leaves it in
        // the merged Props mesh - nothing in the scene is named for it. Hence the board is placed by offset, above.

        // ---- the two-column panel ------------------------------------------------------------------------------------

        static void BuildPanel(Transform boardRoot, Font font, out Text[] scoreRows, out Text[] timeRows)
        {
            float canvasH = TitleH + ColTitleH + Rows * RowH + Pad * 2f;

            var canvasGO = new GameObject("Panel", typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            canvasGO.transform.SetParent(boardRoot, false);
            canvasGO.GetComponent<Canvas>().renderMode = RenderMode.WorldSpace;
            var crt = canvasGO.GetComponent<RectTransform>();
            crt.sizeDelta = new Vector2(CanvasW, canvasH);
            crt.localRotation = Quaternion.identity;
            crt.localScale = Vector3.one * PanelScale;
            crt.pivot = new Vector2(0.5f, 0f);
            crt.localPosition = new Vector3(0f, PanelBottomY, -0.12f);

            var bg = NewUI("Backdrop", crt, out var bgRt); Stretch(bgRt);
            var bgImg = bg.AddComponent<Image>();
            bgImg.color = new Color(0.05f, 0.06f, 0.09f, 0.82f);
            bgImg.raycastTarget = false;

            // Main title across the top.
            var titleGO = NewUI("Title", crt, out var titleRt);
            titleRt.anchorMin = new Vector2(0f, 1f); titleRt.anchorMax = new Vector2(1f, 1f); titleRt.pivot = new Vector2(0.5f, 1f);
            titleRt.anchoredPosition = new Vector2(0f, -Pad * 0.5f); titleRt.sizeDelta = new Vector2(0f, TitleH);
            var title = titleGO.AddComponent<Text>();
            title.font = font; title.fontSize = 52; title.fontStyle = FontStyle.Bold; title.color = Color.white;
            title.alignment = TextAnchor.UpperCenter; title.raycastTarget = false; title.supportRichText = true;
            title.text = "LEADERBOARD\n<size=24>mount a board to start  ·  cross the finish to record</size>";

            float colW = (CanvasW - 2f * Pad - ColGap) * 0.5f;
            float leftX = Pad;
            float rightX = Pad + colW + ColGap;
            float colTop = -(TitleH);   // y offset from canvas top for the column titles

            scoreRows = BuildColumn(crt, font, leftX, colW, colTop, "TOP SCORES", new Color(1f, 0.84f, 0.30f));
            timeRows  = BuildColumn(crt, font, rightX, colW, colTop, "BEST TIMES", new Color(0.55f, 0.85f, 1f));
        }

        // One column: a coloured title then `Rows` left-aligned rich-text rows the board fills. Returns the row Texts.
        static Text[] BuildColumn(Transform panel, Font font, float x, float w, float yTop, string heading, Color headColor)
        {
            var headGO = NewUI("ColTitle_" + heading, panel, out var headRt);
            headRt.anchorMin = new Vector2(0f, 1f); headRt.anchorMax = new Vector2(0f, 1f); headRt.pivot = new Vector2(0f, 1f);
            headRt.anchoredPosition = new Vector2(x, yTop);
            headRt.sizeDelta = new Vector2(w, ColTitleH);
            var head = headGO.AddComponent<Text>();
            head.font = font; head.fontSize = 34; head.fontStyle = FontStyle.Bold; head.color = headColor;
            head.alignment = TextAnchor.MiddleLeft; head.raycastTarget = false; head.supportRichText = false;
            head.horizontalOverflow = HorizontalWrapMode.Overflow; head.verticalOverflow = VerticalWrapMode.Truncate;
            head.text = heading;

            var rows = new Text[Rows];
            float y = yTop - ColTitleH;
            for (int i = 0; i < Rows; i++)
            {
                var rowGO = NewUI("Row_" + heading + "_" + i, panel, out var rowRt);
                rowRt.anchorMin = new Vector2(0f, 1f); rowRt.anchorMax = new Vector2(0f, 1f); rowRt.pivot = new Vector2(0f, 1f);
                rowRt.anchoredPosition = new Vector2(x, y);
                rowRt.sizeDelta = new Vector2(w, RowH);
                var t = rowGO.AddComponent<Text>();
                t.font = font; t.fontSize = 30; t.color = Color.white;
                t.alignment = TextAnchor.MiddleLeft; t.raycastTarget = false; t.supportRichText = true; // <size> tags in the row
                t.horizontalOverflow = HorizontalWrapMode.Wrap; t.verticalOverflow = VerticalWrapMode.Truncate;
                t.text = "";
                rows[i] = t;
                y -= RowH;
            }
            return rows;
        }

        static void BuildPole(Transform boardRoot)
        {
            var pole = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
            pole.name = "Pole";
            var pc = pole.GetComponent<Collider>(); if (pc != null) Object.DestroyImmediate(pc);
            pole.transform.SetParent(boardRoot, false);
            float poleTop = PanelBottomY;   // back the panel up to its bottom edge (it sits on top of the pole)
            pole.transform.localScale = new Vector3(0.12f, poleTop * 0.5f, 0.12f);
            pole.transform.localPosition = new Vector3(0f, poleTop * 0.5f, 0f);
            var mat = LoadOrCreatePoleMaterial();
            if (mat != null) pole.GetComponent<MeshRenderer>().sharedMaterial = mat;
        }

        // ---- small UI helpers (mirroring the sibling board setups) ---------------------------------------------------

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
            var mat = new Material(sh) { name = "LeaderboardPole", color = new Color(0.14f, 0.16f, 0.20f) };
            mat.EnableKeyword("_EMISSION");
            mat.SetColor("_EmissionColor", new Color(0.10f, 0.12f, 0.20f));
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
