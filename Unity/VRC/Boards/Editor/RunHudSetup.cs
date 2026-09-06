#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using UdonSharpEditor;

namespace OpenSlope.VrcPlugin
{

    // Library setup step: stand up the in-world RUN HUD (RunHud) - a small local readout that rides on the TOP of the
    // board you're riding and shows your live run (TIME / POINTS / the w x x x y x z in-progress trick breakdown) while a
    // timed run is active (docs/050). Local + per-client; it tracks the board the LOCAL player is on via the board manager.
    //
    // Lives under OpenSlope_Map/RunHud (cleared when a map is switched - re-run after loading a map). Runs as part of OpenSlope/Setup
    // All after the Leaderboard; re-runnable via OpenSlope/Setup/Run HUD. Idempotent: deletes + rebuilds its object each run.
    // Same two-step Udon bootstrap as the sibling board setups.
    public static class RunHudSetup
    {
        const string ObjName = "RunHud";

        [MenuItem("OpenSlope/Setup/Run HUD", false, 173)]
        public static void Setup()
        {
            bool firstTime = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(RunHud)) == null;
            if (UdonTools.EnsureProgramAsset<RunHud>(out _) == null)
            {
                Debug.LogError("OpenSlope: could not create/find the RunHud program asset; aborting.");
                return;
            }
            if (firstTime)
            {
                Debug.Log("OpenSlope: created the RunHud program asset - run 'OpenSlope/Setup/Run HUD' again to build the HUD.");
                return;
            }

            Transform root = Map.ResolveRoot(true);
            var existing = root.Find(ObjName);
            if (existing != null) Object.DestroyImmediate(existing.gameObject);

            var mgr = Object.FindObjectOfType<BoardManager>(true);
            if (mgr == null)
                Debug.LogWarning("OpenSlope: Run HUD - no BoardManager in the scene yet (build the Start Gate first). The HUD " +
                                 "will show nothing until one exists; re-run after the gate is built.");

            var go = new GameObject(ObjName);
            go.transform.SetParent(root, false);

            // The visible panel: a small world-space canvas with an OUTLINED 3-line Text (no backdrop box) the HUD toggles
            // on while riding. The outline (vs a panel box) keeps the readout legible on any surface without a heavy plate.
            var panelGO = new GameObject("Panel", typeof(RectTransform), typeof(Canvas));
            panelGO.transform.SetParent(go.transform, false);
            panelGO.GetComponent<Canvas>().renderMode = RenderMode.WorldSpace;
            var crt = panelGO.GetComponent<RectTransform>();
            crt.sizeDelta = new Vector2(560f, 320f);
            crt.localScale = Vector3.one * 0.0011f;   // ~0.62 m wide
            crt.pivot = new Vector2(0.5f, 0.5f);
            crt.localPosition = Vector3.zero;

            // Whole-HUD opacity: a CanvasGroup dims the text + meter together to ~75%.
            var cg = panelGO.AddComponent<CanvasGroup>();
            cg.alpha = 0.75f;

            var txtGO = NewUI("Text", crt, out var txtRt); Stretch(txtRt); Inset(txtRt, 22f);
            txtRt.offsetMin = new Vector2(22f, 112f); // leave room at the bottom for the mph readout + boost dots + jump wedge
            var txt = txtGO.AddComponent<Text>();
            var font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf") ?? Resources.GetBuiltinResource<Font>("Arial.ttf");
            txt.font = font; txt.fontSize = 48; txt.color = Color.white;
            txt.alignment = TextAnchor.MiddleCenter; txt.raycastTarget = false; txt.supportRichText = true;
            txt.horizontalOverflow = HorizontalWrapMode.Overflow; txt.verticalOverflow = VerticalWrapMode.Overflow;
            txt.text = "0:00.00\n<color=#ffd24d>0 pts</color>\n<color=#9fd4ff>0.00 × 0.25 × 1 × 6787 = 0</color>";

            // Outline the glyphs (instead of a backdrop box) for legibility on any background: a cheap 4-way mesh duplicate.
            var outline = txtGO.AddComponent<Outline>();
            outline.effectColor = new Color(0f, 0f, 0f, 0.92f);
            outline.effectDistance = new Vector2(2.5f, 2.5f);

            // The bottom cluster is THREE stacked elements, centered and 1/3 the old wedge width. BOTTOM: the mph SPEED
            // readout. Above it: the BOOST METER as a row of 15 DOTS (a 5-step yellow->orange->red ramp, 3 dots per step),
            // horizontally Filled by the live meter in whole-dot steps. TOP: the JUMP-CHARGE WEDGE - 15 white vertical
            // stripes in a triangle (no-height left -> full-height right), one stripe over each boost dot,
            // horizontally Filled by the ollie charge and shown only while a jump is held. All INSIDE the panel rect: the
            // panel lies nearly flat on the deck and its 20-deg tilt dips the rect's bottom edge under the 5 cm float
            // height, so anything hung below the rect sits inside the snowboard's deck mesh (skis have no deck there,
            // which is how a below-the-rect label shows on skis and vanishes on the board).
            const float meterWidth = 167f;   // ~1/3 of the old full-width wedge (560 - 60), centered on the panel

            // Boost meter: a row of 15 dots above the mph readout, one under each wedge stripe.
            var barGO = NewUI("BoostMeter", crt, out var barRt);
            barRt.anchorMin = new Vector2(0.5f, 0f); barRt.anchorMax = new Vector2(0.5f, 0f); barRt.pivot = new Vector2(0.5f, 0f);
            barRt.sizeDelta = new Vector2(meterWidth, meterWidth / 15f);   // height = one square sprite cell, so the dots stay round
            barRt.anchoredPosition = new Vector2(0f, 48f);    // above the mph readout
            var barImg = barGO.AddComponent<Image>();
            barImg.sprite = GetOrCreateBoostDotsSprite();
            barImg.type = Image.Type.Filled;
            barImg.fillMethod = Image.FillMethod.Horizontal;
            barImg.fillOrigin = (int)Image.OriginHorizontal.Left;
            barImg.fillAmount = 0.5f;
            barImg.preserveAspect = false;
            barImg.raycastTarget = false;

            // Speed readout: the "NN mph" label at the panel's bottom edge, under the boost bar. Same outlined-glyph
            // legibility as the main text.
            var spdGO = NewUI("Speed", crt, out var spdRt);
            spdRt.anchorMin = new Vector2(0.5f, 0f); spdRt.anchorMax = new Vector2(0.5f, 0f); spdRt.pivot = new Vector2(0.5f, 0f);
            spdRt.sizeDelta = new Vector2(meterWidth, 42f);
            spdRt.anchoredPosition = new Vector2(0f, 2f);     // hug the bottom edge, inside the rect
            var spdTxt = spdGO.AddComponent<Text>();
            spdTxt.font = font; spdTxt.fontSize = 36; spdTxt.color = Color.white;
            spdTxt.alignment = TextAnchor.MiddleCenter; spdTxt.raycastTarget = false;
            spdTxt.horizontalOverflow = HorizontalWrapMode.Overflow; spdTxt.verticalOverflow = VerticalWrapMode.Overflow;
            spdTxt.text = "0 mph";
            var spdOutline = spdGO.AddComponent<Outline>();
            spdOutline.effectColor = new Color(0f, 0f, 0f, 0.92f);
            spdOutline.effectDistance = new Vector2(2f, 2f);

            // Jump-charge wedge: white striped triangle sitting just above the boost dots.
            var wedgeGO = NewUI("JumpCharge", crt, out var wRt);
            wRt.anchorMin = new Vector2(0.5f, 0f); wRt.anchorMax = new Vector2(0.5f, 0f); wRt.pivot = new Vector2(0.5f, 0f);
            wRt.sizeDelta = new Vector2(meterWidth, 44f);
            wRt.anchoredPosition = new Vector2(0f, 64f);      // above the thin boost bar
            var wedgeImg = wedgeGO.AddComponent<Image>();
            wedgeImg.sprite = GetOrCreateJumpWedgeSprite();
            wedgeImg.type = Image.Type.Filled;
            wedgeImg.fillMethod = Image.FillMethod.Horizontal;
            wedgeImg.fillOrigin = (int)Image.OriginHorizontal.Left;
            wedgeImg.fillAmount = 0.5f;
            wedgeImg.preserveAspect = false;
            wedgeImg.raycastTarget = false;

            UdonTools.AddConfigured<RunHud>(go, h => { h.boardManager = mgr; h.panel = panelGO; h.text = txt; h.boostMeterImage = barImg; h.boostMeterRoot = barGO; h.jumpChargeImage = wedgeImg; h.jumpChargeRoot = wedgeGO; h.speedText = spdTxt; });
            panelGO.SetActive(false);   // hidden until a run is active

            Selection.activeGameObject = go;
            UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
            Debug.Log($"OpenSlope: Run HUD ready at {Map.RootName}/{ObjName} - rides your run TIME / POINTS / breakdown on top " +
                      "of the board while a timed run is active (mount a fresh gate board, cross the finish). docs/050.");
        }

        // Setup IS the refresh: it find-or-creates and rebuilds the HUD in place, so re-running it after a data change
        // is the only entry needed (there is no separate OpenSlope/Refresh item). Greyed out until a map is loaded.
        [MenuItem("OpenSlope/Setup/Run HUD", true)]
        static bool SetupEnabled() => GameObject.Find(Map.RootName) != null;

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
        static void Inset(RectTransform rt, float pad) { rt.offsetMin = new Vector2(pad, pad); rt.offsetMax = new Vector2(-pad, -pad); }

        // Generate (once) + cache the boost-meter DOTS sprite: 15 round dots in a row, coloured in a 5-step YELLOW ->
        // ORANGE -> RED ramp (3 dots per step; the endpoints are the old bar's colours). The runtime horizontally-Fills an
        // Image with it in whole-dot steps, so dots light up left->right as the meter charges.
        static Sprite GetOrCreateBoostDotsSprite()
        {
            const string path = Map.GeneratedFolder + "/openslope_boost_dots.png";
            int W = 240, H = 16, cell = 16;   // 15 square cells, one dot centred in each (same cells as the wedge stripes)
            var existing = AssetDatabase.LoadAssetAtPath<Sprite>(path);
            if (existing != null && existing.texture.width == W) return existing;   // width doubles as the art version
            AssetDatabase.DeleteAsset(Map.GeneratedFolder + "/openslope_boost_bar.png"); // retire the old tri-band bar art

            var ramp = new[]
            {
                new Color(1f,    0.84f, 0.20f, 1f),   // yellow
                new Color(1f,    0.69f, 0.16f, 1f),
                new Color(1f,    0.53f, 0.12f, 1f),   // orange
                new Color(0.99f, 0.39f, 0.15f, 1f),
                new Color(0.98f, 0.24f, 0.18f, 1f),   // red
            };
            Color clear = new Color(0f, 0f, 0f, 0f);
            var tex = new Texture2D(W, H, TextureFormat.RGBA32, false);
            var px = new Color[W * H];
            for (int x = 0; x < W; x++)
            {
                int dot = x / cell;
                Color c = ramp[dot / 3];                       // 3 dots per ramp step
                float dx = x + 0.5f - (dot * cell + cell / 2); // pixel-centre offset from the dot's centre
                for (int y = 0; y < H; y++)
                {
                    float dy = y + 0.5f - H / 2;
                    px[y * W + x] = (dx * dx + dy * dy) <= 6f * 6f ? c : clear;   // radius-6 dot in the 16px cell
                }
            }
            tex.SetPixels(px); tex.Apply();
            return SaveSprite(tex, path);
        }

        // Generate (once) + cache the jump-charge WEDGE sprite: a right-triangle that's no-height at the LEFT and full-height
        // at the RIGHT, filled with 15 vertical WHITE STRIPES (opaque columns separated by clear gaps, one column centred
        // over each boost dot below); everything outside the triangle is transparent. The runtime horizontally-Fills an
        // Image with it, so charge reveals the striped wedge left->right.
        static Sprite GetOrCreateJumpWedgeSprite()
        {
            const string path = Map.GeneratedFolder + "/openslope_jump_wedge.png";
            int W = 240, H = 64, stripe = 16;   // 15 stripe periods: an 8px white column centred in each 16px cell
            var existing = AssetDatabase.LoadAssetAtPath<Sprite>(path);
            if (existing != null && existing.texture.width == W) return existing;   // width doubles as the art version

            var tex = new Texture2D(W, H, TextureFormat.RGBA32, false);
            Color white = new Color(1f, 1f, 1f, 1f);
            Color clear = new Color(0f, 0f, 0f, 0f);
            var px = new Color[W * H];
            for (int x = 0; x < W; x++)
            {
                int hpx = Mathf.RoundToInt((x + 1) / (float)W * H);   // ramp: wedge height grows left->right
                int m = x % stripe;
                bool onStripe = m >= 4 && m < 12;                     // centred white column vs transparent gap
                Color c = onStripe ? white : clear;
                for (int y = 0; y < H; y++) px[y * W + x] = (y < hpx) ? c : clear; // fill from the bottom up, inside the wedge
            }
            tex.SetPixels(px); tex.Apply();
            return SaveSprite(tex, path);
        }

        // Write a generated Texture2D out as a PNG sprite asset (so it survives + uploads) and return the imported Sprite.
        // Point-filtered to keep the wedge stripes + colour bands crisp when the Image scales it.
        static Sprite SaveSprite(Texture2D tex, string path)
        {
            EnsureFolder(Map.GeneratedFolder);
            System.IO.File.WriteAllBytes(path, tex.EncodeToPNG());
            Object.DestroyImmediate(tex);
            AssetDatabase.ImportAsset(path);
            var imp = AssetImporter.GetAtPath(path) as TextureImporter;
            if (imp != null)
            {
                imp.textureType = TextureImporterType.Sprite;
                imp.spriteImportMode = SpriteImportMode.Single;
                imp.alphaIsTransparency = true;
                imp.mipmapEnabled = false;
                imp.filterMode = FilterMode.Point;
                imp.SaveAndReimport();
            }
            return AssetDatabase.LoadAssetAtPath<Sprite>(path);
        }

        static void EnsureFolder(string assetFolder)
        {
            if (AssetDatabase.IsValidFolder(assetFolder)) return;
            string parent = System.IO.Path.GetDirectoryName(assetFolder).Replace('\\', '/');
            string leaf = System.IO.Path.GetFileName(assetFolder);
            if (!AssetDatabase.IsValidFolder(parent)) EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, leaf);
        }
    }
}
#endif
