#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;
using UdonSharp;
using UdonSharpEditor;
using VRC.SDKBase;
using VRC.SDK3.Components;        // VRCSpatialAudioSource
using VRC.SDK3.Video.Components.AVPro;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // Library setup step: stand up the VIDEO BILLBOARDS system (docs/vrchat/041-video-billboards.md). One AVPro player streams
    // a video (a YouTube URL or a direct MP4) onto every billboard SCREEN in the world. SSX billboards are welded into
    // the merged static "Props" mesh with shared atlas materials, so a face can't be retextured on its own; instead the
    // IMPORT lays a fresh quad flush over each screen's textured front (the disabled OpenSlope_Map/Billboards catalog,
    // BillboardScreenBuilder, from the rectangles snowknife measured into the bundle). Setup All consumes the whole
    // catalog; you can also drag individual screens under VideoBillboards/Screens and they play the one stream.
    //
    // This builds OpenSlope_Map/VideoBillboards:
    //   - VRCAVProVideoPlayer            the single decoder (one shared frame everywhere; VRChat caps AVPro instances)
    //   - AudioSource + VRCAVProVideoSpeaker   the video's audio (2D, so it's audible regardless of which screen)
    //   - VideoBillboards (Udon)      plays the URL, assigns the shared material to the screen quads, loops
    //   - _Driver                        a zero-scale quad whose VRCAVProVideoScreen writes the live frame into the one
    //                                    shared video MATERIAL (useSharedMaterial) - every quad using that material shows it
    //   - Screens                        empty container; drop catalog Screen_* quads in here
    //
    // This setup just stands up the player + screens (the RENDERER). WHAT plays, the shared queue, the scrub bar and
    // seeking all live on the Jukebox (JukeboxSetup builds Jukebox and cross-wires it to this renderer).
    //
    // VIDEO IS OPT-IN: with nothing playing (no queued video AND an empty inspector Url) the screen quads stay HIDDEN, so
    // the player just sees the original SSX billboards. Adding a video at the Jukebox (or setting the inspector Url for
    // the standalone fallback) reveals the quads and plays it. That's why this setup seeds NO default URL.
    //
    // Idempotent: re-running find-or-creates each piece and re-asserts the wiring + (re)assigns the shared material to
    // whatever screens are now under Screens (it does NOT force them visible - the Udon shows/hides them at runtime by
    // URL). It never deletes the Screens you dragged in. Lives under OpenSlope_Map (cleared when a map is loaded), so re-run
    // after loading/switching a map.
    //
    // The Udon two-step (a just-created U# program asset can't take a component in the same call - create+compile, then
    // run again) mirrors PlayerFlightSetup / StartGateSetup. See docs/vrchat/013-udon-components.md.
    public static class VideoBillboardsSetup
    {
        const string ObjName     = "VideoBillboards";
        const string DriverName  = "_Driver";
        const string ScreensName = "Screens";
        const string CatalogName = MapLayout.Billboards;   // the import's screen catalog root that Setup All consumes
        const string MatPath     = Map.AssetsFolder + "/VideoScreen.mat";

        [MenuItem("OpenSlope/Setup/Video Billboards", false, 151)]
        public static void Setup()
        {
            // Two-step bootstrap: a just-created U# program asset can't have a component attached in the same call.
            bool firstTime = UdonSharpProgramAsset.GetProgramAssetForClass(typeof(VideoBillboards)) == null;
            if (UdonTools.EnsureProgramAsset<VideoBillboards>(out _) == null)
            {
                Debug.LogError("OpenSlope: could not create/find the VideoBillboards program asset; aborting.");
                return;
            }
            if (firstTime)
            {
                Debug.Log("OpenSlope: created the Udon program asset(s). UdonSharp finalizes them on the next editor tick - " +
                          "run 'OpenSlope/Setup/Video Billboards' again to build the object.");
                return;
            }

            Transform root = Map.ResolveRoot(true);
            Transform vbT = root.Find(ObjName);
            GameObject vb = vbT != null ? vbT.gameObject : new GameObject(ObjName);
            if (vbT == null) vb.transform.SetParent(root, false);

            Material screenMat = LoadOrCreateScreenMaterial();

            // 1) The single AVPro player, on the root (the video events fire on Udon behaviours on the player's object).
            var player = vb.GetComponent<VRCAVProVideoPlayer>();
            if (player == null) player = vb.AddComponent<VRCAVProVideoPlayer>();
            ConfigurePlayer(player);

            // 2) Audio: an AudioSource fed by a VRCAVProVideoSpeaker. 2D (spatialization off) so the soundtrack is
            //    audible no matter which scattered screen you're near - a single point-source would be odd here.
            var audio = vb.GetComponent<AudioSource>();
            if (audio == null) audio = vb.AddComponent<AudioSource>();
            audio.playOnAwake = false;
            audio.loop = false;
            audio.spatialBlend = 0f;
            // Every VRChat AudioSource must be paired 1:1 with a VRCSpatialAudioSource, or VRChat force-spatializes it at
            // world load with a default 40 m rolloff that DISCARDS our 2D setting (and the build validator warns). One
            // shared source feeds every scattered screen, so 2D (spatialization off) is correct: the soundtrack is heard
            // everywhere, not pinned to this object's origin position. Same recipe as MusicDirectorSetup.
            var spatial = vb.GetComponent<VRCSpatialAudioSource>();
            if (spatial == null) spatial = vb.AddComponent<VRCSpatialAudioSource>();
            spatial.EnableSpatialization = false;
            spatial.UseAudioSourceVolumeCurve = true;
            var speaker = vb.GetComponent<VRCAVProVideoSpeaker>();
            if (speaker == null) speaker = vb.AddComponent<VRCAVProVideoSpeaker>();
            ConfigureSpeaker(speaker, player);

            // 3) The driver: a zero-scale (invisible) quad whose VRCAVProVideoScreen writes the live frame into the one
            //    shared video material every frame. useSharedMaterial -> it modifies the material ASSET, so every screen
            //    quad referencing it updates from this single decode.
            Transform driverT = vb.transform.Find(DriverName);
            GameObject driver = driverT != null ? driverT.gameObject : BuildDriver(vb.transform);
            var driverRend = driver.GetComponent<MeshRenderer>();
            if (driverRend != null) driverRend.sharedMaterial = screenMat;
            var screen = driver.GetComponent<VRCAVProVideoScreen>();
            if (screen == null) screen = driver.AddComponent<VRCAVProVideoScreen>();
            ConfigureScreen(screen, player);

            // 4) The screens container (find-or-create; never cleared so dragged-in screens survive a re-run).
            Transform screens = vb.transform.Find(ScreensName);
            if (screens == null)
            {
                var sgo = new GameObject(ScreensName);
                sgo.transform.SetParent(vb.transform, false);
                screens = sgo.transform;
            }

            // 5) The Udon controller on the root, wired up. We DON'T seed a URL: video is opt-in, so leaving it empty
            //    keeps the screens hidden (original billboards) until someone sets one.
            var udon = vb.GetComponent<VideoBillboards>();
            if (udon == null) udon = vb.AddUdonSharpComponent<VideoBillboards>();
            udon.player = player;
            udon.screenMaterial = screenMat;
            udon.screensRoot = screens;

            // Duck the music while a video plays (video audio wins). Auto-find the two directors in the scene if
            // they're present; both are optional, so absence is harmless (no music to duck). Only fill an empty slot
            // so a deliberate manual assignment survives a re-run.
            if (udon.musicDirector == null) udon.musicDirector = Object.FindObjectOfType<MusicDirector>(true);
            if (udon.raceMusicDirector == null) udon.raceMusicDirector = Object.FindObjectOfType<RaceMusicDirector>(true);

            // 6) Persist the wiring. WHAT plays + the shared queue/scrub UI live on the Jukebox (JukeboxSetup
            //    builds Jukebox, sets this udon's `jukebox`, and back-links it so OnVideoEnd advances the queue); this
            //    setup just stands up the renderer (player + screens + the music-duck refs above).
            UdonSharpEditorUtility.CopyProxyToUdon(udon);

            // 7) Refresh: point every screen quad at the shared material. We deliberately DON'T force them active - the
            //    Udon reveals/hides them at runtime based on whether a URL is set (no URL -> original billboards show).
            int count = BakeScreenMaterials(screens, screenMat);

            Selection.activeGameObject = vb;
            EditorSceneMarkDirty(vb);
            bool hasUrl = udon.url != null && !string.IsNullOrEmpty(udon.url.Get());
            Debug.Log($"OpenSlope: VideoBillboards ready at {Map.RootName}/{ObjName} - {count} screen(s)" +
                      ". Video is opt-in: " + (hasUrl ? "a standalone URL is set, so screens play it." :
                      "no URL set, so the quads stay HIDDEN and players see the original billboards.") +
                      " Add videos in-world at the Jukebox (it drives this renderer). Upload to view (ClientSim doesn't " +
                      "play AVPro video).");
        }

        // OpenSlope/Setup All consumes the WHOLE Billboards catalog into VideoBillboards/Screens and bakes it (MoveCatalogIntoScreens
        // below), so every detected billboard is video-ready out of the box - no manual dragging. This "Rebake" command is the
        // iteration-only follow-up, sitting next to Video Billboards in OpenSlope/Setup: if you hand-edit the screens or their
        // material drifts, re-bake the live VideoScreen material onto whatever's under Screens without a full Setup All.
        // It swaps the green Sprites/Default preview so the editor stops showing green (the Udon does the same swap at
        // runtime). Does NOT rebuild the player / URL post and does NOT re-import the catalog. Idempotent.
        [MenuItem("OpenSlope/Setup/Rebake Video Screens", false, 152)]
        public static void BakeScreens()
        {
            Transform screens = FindScreens();
            if (screens == null)
            {
                Debug.LogError($"OpenSlope: no {Map.RootName}/{ObjName}/{ScreensName} - run OpenSlope/Setup All first " +
                               "(it builds VideoBillboards and moves every billboard screen under it).");
                return;
            }
            Material screenMat = LoadOrCreateScreenMaterial();
            if (screenMat == null) return;

            int count = BakeScreenMaterials(screens, screenMat);
            EditorSceneMarkDirty(screens.gameObject);
            Debug.Log($"OpenSlope: re-baked the video material onto {count} screen(s) under {Map.RootName}/{ObjName}/{ScreensName}" +
                      (count == 0 ? " - none found; run OpenSlope/Setup All to populate them." :
                       ". They play the video at runtime when a URL is set (opt-in)."));
        }

        [MenuItem("OpenSlope/Setup/Rebake Video Screens", true)]
        static bool BakeScreensEnabled() => FindScreens() != null;

        // OpenSlope/Setup All step: consume the entire screen catalog the import built (OpenSlope_Map/Billboards) into
        // VideoBillboards/Screens and bake it, so EVERY billboard is video-ready with no manual dragging. Video is opt-in
        // (the screens stay hidden until a URL is set), so wiring them all has no downside. Idempotent: Screens is cleared
        // first and repopulated from the catalog, so re-running Setup All can't accumulate duplicates; the empty catalog
        // husk is then removed. No-op (returns 0) when there's no catalog (a map whose bundle carries no screens, or one
        // already consumed) or VideoBillboards isn't set up yet.
        public static int MoveCatalogIntoScreens()
        {
            Transform screens = FindScreens();
            if (screens == null) return 0;   // Setup()/VideoBillboards not present - nothing to move into

            // The catalog screen quads (the MeshRenderer leaves under "Billboards"). Collect BEFORE touching Screens so we
            // only clear + repopulate when there's genuinely a catalog to move in - otherwise (no screens on this map, or
            // the catalog was already consumed) we leave Screens untouched rather than wiping it.
            var catalog = FindCatalog();
            var rends = catalog != null ? catalog.GetComponentsInChildren<MeshRenderer>(true) : new MeshRenderer[0];
            if (rends.Length == 0)
            {
                if (catalog != null) Object.DestroyImmediate(catalog);   // empty husk - drop it, but don't disturb Screens
                return 0;
            }

            // Clear existing screens so the move is idempotent (the catalog rebuilds deterministically each Setup All, so
            // re-running can't accumulate duplicates).
            for (int i = screens.childCount - 1; i >= 0; i--) Object.DestroyImmediate(screens.GetChild(i).gameObject);

            int moved = 0;
            foreach (var r in rends)
            {
                r.transform.SetParent(screens, true);   // worldPositionStays: the quad geometry is baked in world space
                moved++;
            }
            Object.DestroyImmediate(catalog);   // catalog fully consumed -> drop the now-empty husk

            Material screenMat = LoadOrCreateScreenMaterial();
            if (screenMat != null) BakeScreenMaterials(screens, screenMat);
            int gated = RegisterScreensWithCuller();
            EditorSceneMarkDirty(screens.gameObject);
            Debug.Log($"OpenSlope: moved {moved} billboard screen(s) under {Map.RootName}/{ObjName}/{ScreensName} and baked the " +
                      $"video material ({gated} range-culled with their boards). Video is opt-in: they stay hidden until a URL is set.");
            return moved;
        }

        // Hand the screen quads to the range culler so a screen gates at the SAME distance as the Props chunk its billboard
        // sits in. Without this a playing screen outlives its board past the cull range, and only the distance fog (whose
        // end tracks the active range) hides the difference - a level with fog off would show unlit quads floating where the
        // boards were dropped. The screens are deliberately INACTIVE (video is opt-in), so they're gathered regardless of
        // active state - unlike ObjectCullerSetup's placed-object roots, which skip never-drawn renderers on purpose.
        // The culler keys on renderer.bounds.center, so it locates them correctly either way.
        //
        // Run AFTER the culler exists: VrcWiring realizes the marker into ObjectCuller and strips the marker, so
        // this appends to whichever is present. Rebuilding the culler (OpenSlope/Optimize/Chunk Static Geometry) drops the
        // screens, so that menu re-runs this afterwards. Returns the number of screens now gated.
        public static int RegisterScreensWithCuller()
        {
            Transform screens = FindScreens();
            if (screens == null) return 0;

            var culler = Object.FindObjectOfType<ObjectCuller>(true);
            var marker = culler == null ? Object.FindObjectOfType<ObjectCullerMarker>(true) : null;
            if (culler == null && marker == null) return 0;   // no culler on this map - nothing to register with

            Renderer[] current = culler != null ? culler.renderers : marker.renderers;
            var kept = new List<Renderer>();
            // Drop destroyed entries first: a re-catalog replaces every screen GameObject, leaving
            // the culler holding dangling references to the old ones.
            if (current != null) foreach (var r in current) if (r != null) kept.Add(r);

            int added = 0;
            foreach (var r in screens.GetComponentsInChildren<MeshRenderer>(true))
                if (r != null && !kept.Contains(r)) { kept.Add(r); added++; }

            if (culler != null) { culler.renderers = kept.ToArray(); UdonTools.Push(culler); }
            else                { marker.renderers = kept.ToArray(); EditorUtility.SetDirty(marker); }
            return added;
        }

        // The import's screen catalog: OpenSlope_Map/Billboards. Scoped to the map root rather than found by name
        // anywhere in the scene, so a scene object that happens to share the name can't be consumed as one.
        static GameObject FindCatalog()
        {
            Transform root = Map.ResolveRoot(false);
            Transform catalog = root != null ? root.Find(CatalogName) : null;
            return catalog != null ? catalog.gameObject : null;
        }

        // The VideoBillboards/Screens container, or null if VideoBillboards hasn't been set up yet (no map root either).
        static Transform FindScreens()
        {
            Transform root = Map.ResolveRoot(false);
            if (root == null) return null;
            Transform vb = root.Find(ObjName);
            return vb != null ? vb.Find(ScreensName) : null;
        }

        // Point every screen quad under 'screens' at the one shared video material. Active state is left alone (the Udon
        // shows/hides them at runtime by URL). Returns the count baked. Shared by Setup() and the Refresh command.
        static int BakeScreenMaterials(Transform screens, Material screenMat)
        {
            int count = 0;
            foreach (var r in screens.GetComponentsInChildren<MeshRenderer>(true))
            {
                r.sharedMaterial = screenMat;
                count++;
            }
            return count;
        }

        static void ConfigurePlayer(VRCAVProVideoPlayer player)
        {
            // Native loop is OFF: the Jukebox (Jukebox) is the brain - it must see OnVideoEnd to advance the
            // shared queue (pop the next item, or loop the current one itself when the queue is empty). A native loop would
            // silently restart the stream and never fire OnVideoEnd, so the queue would never advance. autoPlay stays off
            // too - the queue decides when to play (PlayUrl).
            var so = new SerializedObject(player);
            SetBool(so, "autoPlay", false);
            SetBool(so, "loop", false);
            SetInt(so, "maximumResolution", 720);
            so.ApplyModifiedProperties();
        }

        static void ConfigureScreen(VRCAVProVideoScreen screen, VRCAVProVideoPlayer player)
        {
            var so = new SerializedObject(screen);
            var vp = so.FindProperty("videoPlayer");
            if (vp != null) vp.objectReferenceValue = player;
            SetInt(so, "materialIndex", 0);
            SetString(so, "textureProperty", "_MainTex");
            SetBool(so, "useSharedMaterial", true);   // write into the shared material ASSET, not a per-renderer copy
            so.ApplyModifiedProperties();
        }

        // The speaker pulls the player's audio into the AudioSource on its own object. Its only knobs are which player
        // and the channel mode (StereoMix folds all channels to stereo). Spatialization/volume live on the AudioSource
        // itself - we set spatialBlend = 0 (2D) above so the soundtrack is heard everywhere, since the screens scatter.
        static void ConfigureSpeaker(VRCAVProVideoSpeaker speaker, VRCAVProVideoPlayer player)
        {
            var so = new SerializedObject(speaker);
            var vp = so.FindProperty("videoPlayer");
            if (vp != null) vp.objectReferenceValue = player;
            SetInt(so, "mode", (int)VRCAVProVideoSpeaker.ChannelMode.StereoMix);
            so.ApplyModifiedProperties();
        }

        // A zero-scale quad: an enabled MeshRenderer (so the VRCAVProVideoScreen has a renderer to drive) that draws
        // nothing (degenerate at scale 0). Collider stripped.
        static GameObject BuildDriver(Transform parent)
        {
            var driver = GameObject.CreatePrimitive(PrimitiveType.Quad);
            driver.name = DriverName;
            var col = driver.GetComponent<Collider>();
            if (col != null) Object.DestroyImmediate(col);
            driver.transform.SetParent(parent, false);
            driver.transform.localScale = Vector3.zero;
            return driver;
        }

        static Material LoadOrCreateScreenMaterial()
        {
            var existing = AssetDatabase.LoadAssetAtPath<Material>(MatPath);
            if (existing != null) return existing;

            var sh = Shader.Find("OpenSlope/VideoScreen");
            if (sh == null) { Debug.LogError("OpenSlope: shader 'OpenSlope/VideoScreen' not found (VideoScreen.shader missing?)."); return null; }
            var mat = new Material(sh) { name = "VideoScreen" };
            AssetDatabase.CreateAsset(mat, MatPath);
            AssetDatabase.SaveAssets();
            return mat;
        }

        // Guarded serialized-property setters: skip silently if a future SDK renames a field rather than throwing.
        static void SetBool(SerializedObject so, string name, bool v) { var p = so.FindProperty(name); if (p != null) p.boolValue = v; }
        static void SetInt(SerializedObject so, string name, int v) { var p = so.FindProperty(name); if (p != null) p.intValue = v; }
        static void SetString(SerializedObject so, string name, string v) { var p = so.FindProperty(name); if (p != null) p.stringValue = v; }

        static void EditorSceneMarkDirty(GameObject go)
            => UnityEditor.SceneManagement.EditorSceneManager.MarkSceneDirty(go.scene);
    }
}
#endif
