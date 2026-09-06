#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // "Setup All" - runs the post-import setup steps in one click (the same items in the OpenSlope/Setup + OpenSlope/Optimize
    // submenus): Chunk Static Geometry (split the merged Props/Terrain into a 200 m grid of frustum/range-cullable
    // chunks - skipped when already chunked), Consolidate Animated Props (fold the per-prop Update dispatches into one
    // manager - a fresh import re-creates the per-prop behaviours, so this has to re-run after every Load),
    // Teleports (the data-derived MainType-24 portal volumes - a no-op on a
    // level that authors none), Player
    // Locomotion (stamps OpenSlope run/walk/jump speed onto VRCWorldSettings), Music Director, Player Flight, Start Gate
    // Boards, Board Voice Channel, Race Audio, Video Billboards, Jukebox, Players
    // Board, Info Board, Leaderboard (+ finish line), Run HUD, (snow courses only) Snowfall, Settings Board,
    // Diagnostics Board, and finally Bake & Apply Probes.
    // Surface Audio (the per-surface footstep SFX) is opt-in and intentionally NOT run here - run OpenSlope/Setup/Surface Audio
    // by hand if you want on-foot footstep sounds.
    //
    // Snowfall (the ambient falling-snow weather) is per-MAP: a night snow course wants it, so Setup All attaches it
    // ONLY when the config opts in (BuildSnowfall). On any other map it's skipped -
    // run OpenSlope/Setup/Snowfall by hand to force snow on a custom map (the component itself is map-agnostic).
    //
    // Video Billboards stands up the single AVPro player, then the WHOLE screen catalog the IMPORT built (under
    // OpenSlope_Map/Billboards, from the bundle's measured rectangles) is moved under VideoBillboards/Screens and baked
    // (MoveCatalogIntoScreens), so every billboard is video-ready with no manual dragging - video is opt-in, so the
    // screens stay hidden until a URL is set. Idempotent: Screens is cleared + repopulated from the catalog (no
    // duplicates) and Video Billboards find-or-creates each piece; once consumed there is no catalog left to move, so a
    // second run leaves the screens alone. A map whose bundle carries no screens simply has none, and the move is a
    // no-op. OpenSlope/Refresh/Billboard Screens re-catalogs from the bundle without a full import.
    //
    // Bake & Apply Probes runs LAST (it lights moving avatars in shade - needed before a VRChat upload). When the probe
    // positions are unchanged from a prior bake it re-stamps the authored SH instantly with NO lightmapper run; a fresh
    // import / different map runs a synchronous min-quality lightmapper bake (Lightmapping.Bake) that blocks the editor's
    // main thread for a few seconds - so keep the Unity window FOCUSED while Setup All runs (Unity throttles an unfocused
    // bake and it can appear to hang for minutes). The non-interactive automation path (Run(false)) skips only the
    // low-memory confirmation modal so an MCP-driven call can't hang on a dialog - see BakeAndApply(interactive). The
    // other steps are fast component-attach passes; none block.
    //
    // Each step attaches UdonSharp components, which need their program assets to already exist + be finalized. On a
    // brand-new project those assets don't exist yet, and a freshly-created one can't be attached until UdonSharp
    // finalizes it on the NEXT editor tick - so EnsureAssets() creates them up front; if it had to create any, the
    // setup can't finish this pass and Run() returns false. Run it again after the next recompile to finish (one clean
    // pass once the assets exist). Greyed out until a map is loaded.
    //
    // Run(interactive): the menu uses interactive=true (a dialog explains the two-pass case). Automation drivers
    // (Unity-MCP / batch scripts) call Run(false) - same steps, but it never pops a modal, because a modal blocks an
    // MCP-driven editor command mid-call. EnsureAssets()/RunSteps() are also exposed so a driver can ensure assets,
    // wait for the recompile itself, then attach in a controlled second call.
    public static class SetupAll
    {
        [MenuItem("OpenSlope/Setup All", false, 100)]
        public static void All() => Run(true);

        /// Run the post-import setup steps, then Bake &amp; Apply Probes last. interactive=true pops a dialog on the first
        /// (asset-creating) pass; false is the non-interactive path for automation. Returns true if the steps ran, false
        /// if it had to create program assets first (call again after the next recompile to finish). The probe bake
        /// blocks the editor while it runs (instant when probe positions are unchanged) - keep the Unity window focused.
        public static bool Run(bool interactive)
        {
            if (GameObject.Find(Map.RootName) == null)
            {
                Debug.LogError($"OpenSlope: '{Map.RootName}' not found - run OpenSlope/Load first.");
                return false;
            }

            if (EnsureAssets())
            {
                const string msg = "Created the UdonSharp program assets for the setup components. UdonSharp finalizes them " +
                    "on the next editor tick, so the steps can't attach their components yet.\n\nRun OpenSlope/Setup All again to finish.";
                if (interactive) EditorUtility.DisplayDialog("Setup All - one more pass needed", msg, "OK");
                Debug.Log("OpenSlope: Setup All created Udon program asset(s) - run again after the recompile to finish the setup.");
                return false;
            }

            Debug.Log("OpenSlope: Setup All - running the post-import setup steps...");
            RunSteps();
            // Bake & apply the avatar light probes last (avatar shade lighting for the VRChat upload). Re-stamps instantly
            // when probe positions are unchanged; a fresh import / new map runs the synchronous min-quality lightmapper
            // bake (keep the Unity window focused - Unity throttles an unfocused bake). interactive=false skips only the
            // low-memory modal so an automation/MCP-driven Setup All can't hang on a dialog.
            var cfg = ImportConfig.Current();
            new ProbeBuilder(cfg, new InstanceLighting(cfg)).BakeAndApply(interactive);
            Debug.Log("OpenSlope: Setup All finished (post-import steps + probe bake).");
            return true;
        }

        /// Automation-only setup used by VrcAutoTest. It stands up the same runtime systems, including the start-gate
        /// board pool, but deliberately skips Bake & Apply Probes: ProbeBuilder saves every open scene after stamping the
        /// LightingDataAsset, while an autotest must leave the user's scene asset untouched. Lighting is not part of the
        /// collision/effect assertions. Returns false for the same first-pass program-asset compile case as Run(false).
        public static bool RunForAutoTest()
        {
            if (GameObject.Find(Map.RootName) == null)
            {
                Debug.LogError($"OpenSlope: '{Map.RootName}' not found - run OpenSlope/Load first.");
                return false;
            }
            if (EnsureAssets())
            {
                Debug.Log("OpenSlope: autotest setup created Udon program asset(s) - retrying after the recompile.");
                return false;
            }
            Debug.Log("OpenSlope: autotest setup - running post-import steps (probe bake intentionally skipped; scene will not be saved).");
            RunSteps();
            Debug.Log("OpenSlope: autotest setup finished.");
            return true;
        }

        /// Ensure every UdonSharp program asset the steps below attach. Returns true if any were created this call -
        /// UdonSharp must finalize a freshly-created asset on the next editor tick before it can be attached.
        public static bool EnsureAssets()
        {
            bool created = false;
            UdonTools.EnsureProgramAsset(typeof(MusicDirector),   out bool c1); created |= c1;  // Music Director
            UdonTools.EnsureProgramAsset(typeof(PlayerFlight),    out bool c2); created |= c2;  // Player Flight
            UdonTools.EnsureProgramAsset(typeof(BoardSpawner),    out bool c3); created |= c3;  // Start Gate
            UdonTools.EnsureProgramAsset(typeof(RideableBoard),   out bool c4); created |= c4;  // Start Gate boards
            UdonTools.EnsureProgramAsset(typeof(RaceMusicDirector), out bool c5); created |= c5; // Race Audio
            UdonTools.EnsureProgramAsset(typeof(AnnouncerU),      out bool c6); created |= c6;  // Race Audio (announcer)
            UdonTools.EnsureProgramAsset(typeof(VideoBillboards), out bool c7); created |= c7;  // Video Billboards (the AVPro renderer)
            UdonTools.EnsureProgramAsset(typeof(UrlBox),          out bool c8); created |= c8;  // Jukebox (Add-button URL field Interact)
            UdonTools.EnsureProgramAsset(typeof(BoardVoiceChannel), out bool c9); created |= c9; // Board Voice Channel
            UdonTools.EnsureProgramAsset(typeof(SettingsBoard),   out bool c12); created |= c12; // Settings Board (ride mode / sound / world)
            UdonTools.EnsureProgramAsset(typeof(SettingsToggle),  out bool c13); created |= c13; // Settings Board (per-row Interact toggle)
            UdonTools.EnsureProgramAsset(typeof(SettingsModeButton), out bool c13b); created |= c13b; // Settings Board (ride-mode picker button)
            UdonTools.EnsureProgramAsset(typeof(ModeVisibility), out bool c13c); created |= c13c; // authored race/show-off/freeride prop presence
            UdonTools.EnsureProgramAsset(typeof(PlayersBoard),    out bool c14); created |= c14; // Players Board
            UdonTools.EnsureProgramAsset(typeof(PlayersButton),   out bool c15); created |= c15; // Players Board (per-element Interact button)
            UdonTools.EnsureProgramAsset(typeof(Jukebox),      out bool c16); created |= c16; // Jukebox (shared video queue brain)
            UdonTools.EnsureProgramAsset(typeof(JukeboxButton),     out bool c17); created |= c17; // Jukebox (per-element Interact button)
            UdonTools.EnsureProgramAsset(typeof(SnowfallU),       out bool c18); created |= c18; // Snowfall (built on every map so the Settings Board toggle is available - see RunSteps)
            UdonTools.EnsureProgramAsset(typeof(InfoBoard),       out bool c19); created |= c19; // Info Board (instance owner + control cheat-sheet)
            UdonTools.EnsureProgramAsset(typeof(DiagnosticsBoard),  out bool c20); created |= c20; // Tuning Board (diagnostics + perf)
            UdonTools.EnsureProgramAsset(typeof(DiagnosticsToggle), out bool c21); created |= c21; // Tuning Board (per-row Interact toggle)
            UdonTools.EnsureProgramAsset(typeof(DebugHud),        out bool c21b); created |= c21b; // Tuning Board (head-following FPS/debug HUD)
            UdonTools.EnsureProgramAsset(typeof(Leaderboard),     out bool c22); created |= c22; // Leaderboard (top scores + times)
            UdonTools.EnsureProgramAsset(typeof(FinishLine),      out bool c23); created |= c23; // Leaderboard (finish-line record trigger)
            UdonTools.EnsureProgramAsset(typeof(RunHud),          out bool c24); created |= c24; // Run HUD (nose time/points/breakdown readout)
            UdonTools.EnsureProgramAsset(typeof(Teleport),        out bool c25); created |= c25; // Teleports (MainType-24 portal warp)
            UdonTools.EnsureProgramAsset(typeof(AnimatedPropManager), out bool c26); created |= c26; // Consolidate Animated Props
            return created;
        }

        /// The component-attach passes (no asset creation, no probe bake). Safe to call once EnsureAssets() reports
        /// nothing left to create.
        public static void RunSteps()
        {
            // Spatial-chunk the merged Props/Terrain into a 200 m grid so off-screen / distant course cells frustum +
            // range cull (the big draw/vertex win - ChunkMenu, restoring the engine's per-cell visibility model).
            // Idempotent: skipped when the scene is already chunked, so a repeated Setup All doesn't re-pay the split;
            // run OpenSlope/Optimize/Chunk Static Geometry by hand to retune the cell size.
            if (!ChunkMenu.IsChunked()) ChunkMenu.Run();
            // Fold every per-prop AnimatedPropU Update into the single AnimatedPropManager. A fresh import lays
            // down one ticking UdonBehaviour per animated prop (Aloha: 44), and each carries an interpreted VM dispatch
            // per frame; the manager runs the same 1-in-3 throttle but STAGGERS it across props, so the load is spread
            // instead of landing on every third frame at once. Runs AFTER the chunker because that calls
            // VrcWiring.Wire() - re-wiring is safe either way (it only re-resolves AnimTriggerU.target and never
            // touches `enabled` or the manager refs consolidation writes), but this keeps the ordering obvious.
            // Idempotent: the disabled per-prop behaviours keep their serialized data and are the source on re-runs.
            // NOTE: OpenSlope/Optimize/Batch Draw Calls also calls Wire(); that stays safe for the same reason.
            ConsolidateAnimatedProps.Run();
            // (Re)place the MainType-24 teleport portals - an invisible trigger + destination anchor per pair, wired to
            // Teleport (data-derived from the bundle; a no-op on a level that authors no portal pairs).
            // Built at Load too, but included here so Setup All fully (re)stands a loaded map without a fresh re-import,
            // and runs AFTER the chunker so a rebuilt Teleports node can't be caught in the static split (docs/051).
            BuildTeleports();
            Map.ApplyPlayerLocomotion();     // stamp on-foot run/walk/strafe speed + jump onto VRCWorldSettings (no probe/asset deps)
            MusicDirectorSetup.Setup();
            PlayerFlightSetup.Setup();
            StartGateSetup.Spawn();
            BoardVoiceChannelSetup.Setup();  // AFTER Start Gate: it reads the board manager to find who's riding
            RaceAudioSetup.Setup();        // AFTER Start Gate: it wires raceMusic/announcer into the freshly spawned boards
            VideoBillboardsSetup.Setup();            // AFTER the Start Gate (the AVPro player + screens; the queue/scrub UI lives on the Jukebox)
            VideoBillboardsSetup.MoveCatalogIntoScreens();  // consume the whole catalog into VideoBillboards/Screens + bake (video opt-in)
            JukeboxSetup.Setup();                 // AFTER Video Billboards: the shared video queue (add/scrub/skip) that DRIVES that renderer
            PlayersBoardSetup.Setup();               // a start-gate-area board with no map deps (the player list is runtime) - just needs the gate for placement
            InfoBoardSetup.Setup();                  // start-gate-area display board (instance owner + control cheat-sheet); needs the gate only for placement
            LeaderboardSetup.Setup();                // the run leaderboard + finish-line trigger at the BOTTOM of the run (placed from the course path)
            RunHudSetup.Setup();                     // the at-the-nose run readout (time / points / breakdown); AFTER Start Gate (needs the board manager)
            // Ambient falling snow (SnowfallU): built on every map by default so the Settings Board's "Snow effect"
            // row is ALWAYS available. Whether a course actually snows isn't in the level data: the engine decides it at
            // course init via a weather roll we can't extract (docs/044), so the port doesn't guess - it just offers the
            // toggle. ImportConfig.BuildSnowfall (default true) can omit the system entirely on a map that should never
            // have snow. MUST run BEFORE the Settings Board: that board's "Snow effect" row holds a live ref to this
            // Snowfall, so building (or rebuilding) snow AFTER the board would orphan the ref and the toggle would do nothing.
            if (ImportConfig.Current().BuildSnowfall) SnowfallSetup.Setup();
            // AFTER Music Director + Race Audio + Snowfall + Start Gate: it holds live refs to every one of them (the mute
            // toggles, the snow effect, and the pooled boards the ride mode is pushed onto).
            SettingsBoardSetup.Setup();
            DiagnosticsBoardSetup.Setup();           // LAST: the Tuning board (bench slot 4) - it wires the perf systems + pushes itself into the board pool, so everything it touches already exists
        }

        // (Re)build the level's teleport portals under OpenSlope_Map/Level/Teleports (the same pass OpenSlope/Refresh/Teleports and the
        // main import run). Data-derived from the bundle - returns without adding a node on a level that authors no teleport.
        static void BuildTeleports()
        {
            var cfg = ImportConfig.Current();
            var root = GameObject.Find(cfg.RootName);
            if (root == null) return;
            var level = root.transform.Find(cfg.LevelName) ?? root.transform;   // sub-objects live under OpenSlope_Map/Level
            new TeleportBuilder(cfg).Build(level);
        }

        [MenuItem("OpenSlope/Setup All", true)]
        static bool AllEnabled() => GameObject.Find(Map.RootName) != null;
    }
}
#endif
