#if UNITY_EDITOR
// The neutral OpenSlope map-root layout convention: the standard node names every OpenSlope world uses so the importer and the
// platform tools/runtime find the same things at the same paths regardless of which map is loaded. This is the
// platform-agnostic half of the platform map helper (VRC) - the constants the importer needs to name
// its output. The platform map helper re-exports these and adds the VRChat-specific behaviours (respawn floor, world-settings
// warning, locomotion, the start-gate board bench).

namespace OpenSlope.Importer
{
    public static class MapLayout
    {
        // --- project-relative asset roots -------------------------------------------------------------
        // The library and the level data it consumes live under ONE folder, so a host project's Assets/ stays
        // legible and an OpenSlope world can be told apart from whatever else the project holds. Everything
        // below derives from AssetsRoot: `sync-unity.ps1` writes the library into it, `snowknife unity` stages
        // levels into MapsFolder, and the setup passes read the shared board/announcer assets from
        // SharedFolder. Moving the whole tree is a one-line change here plus the sync script's -AssetSubdir.
        public const string AssetsRoot   = "Assets/OpenSlope";
        public const string MapsFolder   = AssetsRoot + "/Maps";    // `snowknife unity <mapDir> <project>/Assets/OpenSlope/Maps/<LEVEL>`
        public const string SharedFolder = MapsFolder + "/Shared";  // boards/skis/announcer shared across levels

        public const string RootName       = "OpenSlope_Map";       // the one identity-transform root every OpenSlope world lives under
        public const string CollisionName  = "Collision";     // standard terrain/surface collider parent (Surf_<type> children)
        public const string LocationsName  = "Locations";     // standard named-anchor parent
        public const string PlayerSpawn    = "PlayerSpawn";   // where the player spawns / respawns onto the map
        public const string GateSpawn      = "GateSpawn";     // where a start gate stands (the top of the run)
        public const string PlayerFlight   = "PlayerFlight";  // the free-standing trigger-jetpack controller
        public const string StartGate      = "StartGate";     // the board-dispensing start gate
        public const string StartGateModel = "StartGateModel";// anchor on the level's actual start-gate prop
        public const string Rails          = "Rails";         // grind-rail network
        public const string CoursePath     = "CoursePath";    // out-of-bounds course path
        public const string Foliage        = "PropsFoliage";  // leaf-swish trigger volumes
        public const string Billboards     = "Billboards";    // the catalog of video-ready billboard screen quads
    }
}
#endif
