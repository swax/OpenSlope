#if UNITY_EDITOR
using System;
using System.IO;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Configuration for one level import: the paths into the exported folder plus the tuning knobs the
    // services read. One instance is built per import (ImportConfig.For(folder)) and passed to every service,
    // so nothing is shared through statics. Every knob is level-INDEPENDENT; only the two paths change per level.
    // See docs/unity/004 (scale/orientation), docs/unity/007 (lightmap), docs/008 (animation), docs/009 (collision),
    // docs/unity/010 (object lighting).
    public class ImportConfig
    {
        // The default level folder Current() falls back to before anything has been imported via the picker.
        public const string DefaultLevelFolder = MapLayout.MapsFolder + "/Level";

        // ---- paths -------------------------------------------------------------
        // The level's exported folder (the one snowknife wrote, holding gltf/ + Textures/ + Audio/...). Everything
        // the importer reads is relative to this, so pointing it at a different folder is all it takes to import a
        // different level - see For(folder) / Current(). MatFolder defaults to a "Materials" subfolder of it.
        public string LevelFolder    = DefaultLevelFolder;
        public string MatFolder      = DefaultLevelFolder + "/Materials";
        // The neutral library map root (the platform map helper convention): the importer builds OpenSlope_Map (identity @ origin) with the
        // scaled/rotated/recentered level geometry under a `Level` child, and re-exposes the board-facing subsystems
        // (Collision/Rails/CoursePath/PropsFoliage) + Locations anchors at the identity top, so board/flight/gate find
        // the same paths whatever the loaded map is.
        public string RootName       = "OpenSlope_Map";
        public string LevelName      = "Level";                  // scaled child under OpenSlope_Map that holds the visual level
        public string ShaderName     = "OpenSlope/UnlitDoubleSided";   // falls back to stock unlit/standard if missing
        public string ProbeGroupName = "LightProbes";

        // derived asset paths
        public string LightmapDir       => LevelFolder + "/Lightmaps";
        public string TerrainMeshPath   => LevelFolder + "/Terrain.mesh";
        public string TerrainHdMeshPath => LevelFolder + "/TerrainHD.mesh";   // the render-only high-detail swap (bundle "TerrainHD" node)
        public string LightmapAtlasPath => LevelFolder + "/LightmapAtlas.asset";
        public string PropsMeshPath     => LevelFolder + "/Props.mesh";
        public string SkyboxObjPath     => LevelFolder + "/Skybox.obj";
        public string SkyboxTexDir      => LevelFolder + "/Skybox/Textures";
        public string EffectsPath       => LevelFolder + "/Effects.json";

        // ---- orientation & scale (docs/unity/004) ------------------------------------
        // SSX is -Y-up and opposite-handed to Unity, so the OBJ import lands upside-down; the root rotates
        // -90 about X to bring it upright. WorldScale: SSX models in CENTIMETRES (riders ~175u = 1.75m), so
        // 0.01 makes a default VRChat avatar rider-sized. Both applied on the root, not baked into the OBJ.
        public Vector3 RootEuler  = new Vector3(270f, 0f, 0f);
        public float   WorldScale = 0.01f;

        // ---- start area: spawn + start gate ------------------------------------
        // Where the player spawns and the start gate stands. By DEFAULT (SpawnFromCourse=true) the importer reads the
        // level's OWN start marker - the `Mdl_StageArea_Start_0` placeholder instance the engine itself resolves by
        // name hash to place the six-rider grid ([Trailmap: 120-objects]) - faced down the nearest course line. A
        // bundle without that marker falls back to the course path's highest endpoint, which is only right for a
        // single top-to-bottom run (see LevelImporter.TryStartMarkerSpawn). Either way no per-map coordinates are
        // needed. A level can instead PIN it to reproduce an exact authored start: set SpawnFromCourse=false and the
        // two overrides below. The override is world-space in the SUMMIT-AT-0 frame (pre-recenter); the importer adds
        // the recenter offset, drops it onto the terrain, and faces Downhill. (Marker/course-derived points already
        // include the recenter, since they transform through Level.)
        public bool    SpawnFromCourse  = true;                       // read the level's start marker / course path (generic); false = use the overrides
        public Vector3 SpawnPosOverride = Vector3.zero;               // authored start in the SUMMIT-AT-0 frame (only used when SpawnFromCourse=false)
        public Vector3 DownhillOverride = new Vector3(1f, 0f, 0f);

        // ---- world recenter (docs/vrchat/027) -----------------------------------------
        // SSX levels are authored from the SUMMIT (world ~0) down to roughly -3000 m at the base. Quest's mobile GPU
        // loses precision that far from the origin - vertices wobble / z-fight at the bottom of the run while the
        // top stays clean (desktop fp32 hides it). Shifting the whole level so the terrain's CENTRE is the origin
        // (~+/-1500 m instead of 0..-3000) halves the worst-case magnitude. Everything the importer builds lives
        // UNDER root in local space, so moving root's WORLD position translates it all in lockstep - no
        // per-subsystem re-baking (rails transform their local points at runtime; child AudioSources/probes ride
        // along). Computed from the terrain mesh bounds, so the offset is DETERMINISTIC (identical every import -
        // the one-time spawn/gate shift never has to be redone). Objects OUTSIDE root (the VRChat spawn point, the
        // OpenSlope_StartGate) are brought along by the recenter-aware gate menu + OpenSlope/Tools/Recenter Scene Objects.
        public bool    RecenterToOrigin = true;
        // Per-axis enable (1 = center that axis, 0 = leave it). Default centers all three (precision error grows
        // with distance on EVERY axis, not just the vertical drop). Set to (0,1,0) for vertical-only.
        public Vector3 RecenterAxisMask = Vector3.one;

        // ---- skybox (docs/unity/006) -------------------------------------------------
        // SSX draws its backdrop as an open-topped CYLINDER (a ring of mountains/clouds, no cap), so the
        // cubemap bake has nothing to capture straight up/down - those open faces get a flat fill colour. To
        // avoid a visible "ceiling", that colour must match the sky at the cylinder's TOP EDGE. AutoSkyFill
        // derives it per-level straight from the bake (samples the sky just inside the open top), so it
        // adapts to any level. SkyFillColor is the manual override / fallback used when AutoSkyFill is off or
        // derivation finds no sky (e.g. a deep blue ~0.21, 0.46, 0.77).
        public bool  AutoSkyFill  = true;
        public Color SkyFillColor = new Color(0.21f, 0.46f, 0.77f, 1f);

        // The skybox bake sets ambientMode = Skybox (the environment ambient that the avatar's light probes sit
        // on top of - docs/unity/006/010); we PIN the Intensity Multiplier here so it stays deterministic per import.
        // The unlit level art ignores ambient entirely - only DYNAMIC objects (the player avatar + the rideable
        // board) sample it, via light probes. A high multiplier floods those with flat light that drowns the
        // per-instance shade variation baked into the probes, so a shaded avatar/board stops reading as darker
        // (the Lighting window's Intensity Multiplier slider can drift this as high as 8). 1 = Unity's
        // default / the known-good; re-importing resets any manual drift.
        public float SkyAmbientIntensity = 1f;

        // The scene's single Directional Light is the sun that orients the avatar/board shading and seeds the
        // probe L1 tilt (ProbeBuilder). The unlit level art casts/receives no realtime shadows, so the sun's
        // shadow pass only ever shadows the dynamic objects against each other - a per-frame shadow-map render
        // (doubled in VR) for almost no visual payoff. We pin its shadows OFF here so a re-import resets any
        // manual drift back to Soft/Hard. Set false to keep whatever the scene's light has.
        public bool  SunShadowsOff = true;

        // ---- fog (docs/unity/006) ----------------------------------------------------
        // SSX fades distant terrain into the horizon haze - it cuts off a few hundred metres out. We
        // reproduce it with Unity linear fog. FogColorAuto samples the colour from the baked sky at the
        // HORIZON (the hazy lower edge of the band, where distant terrain meets sky) so geometry dissolves
        // into the same colour the sky already shows there - distinct from the zenith SkyFillColor above.
        // Distances are in world units (WorldScale makes 1 unit = 1 m). Unity never fogs the skybox itself,
        // so only the terrain/props fade; the painted sky behind stays crisp. FogColor is the override/fallback.
        public bool  Fog              = true;
        public bool  FogColorAuto     = true;
        public Color FogColor         = new Color(0.55f, 0.68f, 0.80f, 1f); // hazy horizon blue (override/fallback)
        public float FogStartDistance = 300f;  // m: haze begins (both cull tiers)
        // FogEndDistance is the STATIC fog end baked at import - used as-is on a level with no object culler. When the range
        // culler IS present (RangeCullObjects), it OWNS the fog end at runtime, driving RenderSettings.fogEnd to the ACTIVE
        // cull range (so distant props are fully hazed exactly where they cull - no pop-out; the haze widens with the range
        // when the Perf Board loosens the cull to its OFF tier). See docs/unity/006 + ObjectCuller / ObjectCullRange*Off.
        public float FogEndDistance    = 1000f; // m: static fog end (no-culler levels; the culler overrides at runtime)

        // ---- terrain geometry (docs/unity/002) + lightmap (docs/unity/007) -----------------
        public int LightmapUvMode = 6;   // lightmap tile orientation vs patch (u,v); 6 = transpose. 0..7
        public int TerrainRes     = 4;   // GEOMETRY tessellation (quads/edge); lighting is texture-based, so 4 is plenty

        // ---- texture animation (docs/008) --------------------------------------
        public float FlipSpeedScale   = 1f;   // Flip.json Speed -> fps (1 = Speed as fps directly)
        public float ScrollSpeedScale = 60f;  // SSX per-tick UV-scroll -> units/sec: the scroll tick is the
                                              // 60 Hz sim rate (retail vs 30/s preview side-by-side showed 2x)

        // ---- spinning pickups (docs/012) ---------------------------------------
        // SSX's trick-multiplier "gem" pickups revolve in place. PropBuilder pulls each instance whose
        // model name contains SpinnerModelMatch out of the merged Props mesh into its own GameObject (under
        // OpenSlope_Spinners) and registers it with the spinner manager so it can actually turn. Match is a model-name substring, so
        // it generalises to any future spin-in-place prop. Set AnimateSpinners=false to keep them static
        // (baked into the merged mesh like every other prop).
        public bool   AnimateSpinners      = true;
        public string SpinnerModelMatch    = "Gem_TrickMultiplier";
        public float  SpinnerDegreesPerSec = 90f;   // revolve rate (deg/s); ~4 s per turn. Tune to taste.

        // ---- gem pickups: collect on contact (docs/023) ------------------------
        // The spinning gems above are trick-multiplier pickups. On top of the spin, PropBuilder.BuildSpinners adds a
        // trigger sphere + kinematic Rigidbody + the gem-pickup behaviour so the gem DISAPPEARS when the player rides or walks
        // through it, plays a one-shot chime + sparkle, and (respawn) fades back after a delay. Detection mirrors the
        // physics props (walking via OnPlayerTriggerEnter, riding via the board's RiderProbe). Set GemPickup=false to
        // leave the gems as spin-only scenery.
        public bool   GemPickup            = true;
        public bool   GemRespawn           = true;   // bring it back after collection (persistent free-roam world)
        public float  GemRespawnDelay      = 8f;     // seconds before a collected gem fades back
        public float  GemPickupRadiusScale = 0.7f;   // trigger-sphere radius as a fraction of the gem's mesh half-extent
        public float  GemMinRideSpeed      = 0f;     // min board speed (m/s) to collect while riding; 0 = any contact
        // ---- authored gems (Slopesmith docs/014): Slopesmith's Gems.json placements, synthesised by GemBuilder ----
        // These reuse the spinner + pickup runtime above; unlike the extracted gems they carry no model, so the
        // importer synthesises a small octahedron crystal per gem, sized in SSX mesh units (the level Scale shrinks it).
        public bool   EmitGems             = true;   // build authored gem pickups from manifest.Gems
        public float  GemMeshRadius        = 80f;    // authored-gem octahedron radius, SSX units (~0.8 m at Scale 0.01)
        public Color  GemColor             = new Color(0.25f, 0.88f, 0.82f); // authored-gem crystal tint (cyan-teal, matches the editor)
        // The real game plays the pickup chime from GAME CODE, not the level's SSF effect graph (the gem effect carries
        // only a score multiplier + particle sparkle, no sound node). Code-driven, not an SSF node (docs/023): applying a
        // gem's score multiplier (SSF MainType 14) plays a group-0 chime picked by the multiplier tier: x2 -> sound
        // id 116, x3 -> 117, x5 -> 118 - from the MAIN bank (BANKS.INF group 0 =
        // zbxsfx.bnk) [Trailmap: 390-pickups-and-race]. So the
        // chime is PER TIER, and these are the game's EXACT clips: slots 116/117/118 exist only in zbxsfx and are
        // identical-length variants. "" on a tier = that tier collects silently.
        public string GemPickupClipX2      = "SFX/zbxsfx/116.wav";  // Yellow x2 (game sound id 116)
        public string GemPickupClipX3      = "SFX/zbxsfx/117.wav";  // Orange x3 (id 117)
        public string GemPickupClipX5      = "SFX/zbxsfx/118.wav";  // Red x5 (id 118)
        public float  GemPickupMinDistance = 5f;     // world m: full pickup-chime volume within
        public float  GemPickupMaxDistance = 60f;    // world m: inaudible beyond (Linear rolloff)
        // Sparkle: the game's real pickup effect is a particle flash. We reproduce a small additive burst tinted to the
        // gem tier, anchored to the SSF emitter's spark count (effect 9/11/13 U0 = 150). Off = disappear + chime only.
        public bool   GemSparkle           = true;
        public int    GemSparkleCount      = 150;    // sparks per burst (game U0 = 150)
        public float  GemSparkleLifetime   = 0.7f;   // seconds each spark lives
        public float  GemSparkleSpeed      = 1400f;  // SSX-unit burst speed (game U2x velocities ~1875-2500); x WorldScale
        public float  GemSparkleSize       = 40f;    // SSX-unit spark size; x WorldScale
        public string GemSparkleSprite     = "str3.png"; // white tintable TWINKLE sprite (Textures/Particles/<name>); tinted per tier. part.png is a soft dot that reads as a generic particle; str3 is a 4-point sparkle

        // ---- physics props: knock-and-tumble bodies (docs/016) -----------------
        // Collision Roller effects activate knock-and-tumble bodies and author their scalar mass as specified by
        // [Trailmap: 130-collision-data, 370-world-interaction]. The bundle owns
        // that graph join and pulls only Roller targets out of the merged Props mesh. Instance collision mode/response mass
        // remain shape and rider-response data; they do not select Rigidbodies. PhysicsExcludeModels is a local
        // name-based escape hatch for an intentionally unsupported visual.
        //
        // RUNTIME REALITY (docs/016): a plain Rigidbody is NOT enough for the "anchored until a rider plows in,
        // then flies away" feel. (1) VRChat/ClientSim players are CharacterControllers and impart NO force to a
        // rigidbody on contact, so you can't push these by skiing into them. (2) Free bodies on a steep
        // slope just slide downhill the instant physics starts. So each body ANCHORS at rest (kinematic +
        // SOLID - it blocks the walking player like the scenery it replaces, since its static collision is
        // deliberately absent from the bundle; the boards' obstacle sweeps skip physics-prop colliders, the
        // game's physics-routing) with a slightly INFLATED sibling trigger as the knock sensor; the platform
        // hit-handler reads the sensor crossing and flips the body dynamic with an impulse from the rider's
        // velocity. The friction/mass/bounce below are set correctly so the dynamic state needs no retuning.
        public bool     BuildPhysicsProps    = true;
        public bool     PhysicsStartKinematic = true;    // anchor at rest (no slide on the slope) until the platform hit-handler flips it dynamic
        public float    PhysicsKnockSensorInflate = 50f; // SSX units (~0.5 m) the knock-sensor trigger box GROWS beyond the body's solid box on every side, so a walking player's knock fires BEFORE the solid face blocks them (the body itself never flips trigger<->solid - a box going solid around the player ejects them skyward)
        public bool     PhysicsMassFromRoller = true;    // use the collision Roller's authored scalar mass
        public float    PhysicsDefaultMass   = 5f;       // compatibility fallback for an older bundle with absent/invalid mass
        public float    PhysicsMinMass       = 1f;       // Unity-safe floor for a positive but tiny effect mass
        public float    PhysicsFriction      = 0.6f;     // PhysicMaterial friction so a dynamic body grips the slope instead of sliding forever
        public float    PhysicsLinearDrag    = 0.05f;    // light damping so a knocked body slides/rolls then settles
        public float    PhysicsAngularDrag   = 0.1f;
        public float    PhysicsDefaultBounce = 0.2f;     // restitution fallback (the knockables read PlayerBounceAmmount 0.2)
        public string[] PhysicsExcludeModels = { };     // name-based opt-out from the tumble set (empty: extract all) (docs/016)
        // Knock tuning -> stamped onto the physics-prop behaviour directly by the importer (PropBuilder.BuildPhysics). The
        // Udon prop anchors (kinematic) at rest, and on OnPlayerTriggerEnter (rider faster than MinPlayerSpeed)
        // goes dynamic with velocity = player.velocity * VelInherit + up * UpBias, optionally re-anchoring once it settles.
        public float PhysicsMinPlayerSpeed  = 2f;        // m/s: rider must be this fast to knock a prop (low = easy)
        public float PhysicsKnockVelInherit = 1.3f;      // mode-3 object impulse = fixed 1.3 x closing speed / eff. mass (does NOT read PlayerBounceAmmount); 1.3 = heavy-rider limit (docs/016) [Trailmap: 370-world-interaction]
        public float PhysicsKnockUpBias     = 0f;        // NO vertical kick - the shove is along the contact normal; vertical is contact-geometry + gravity. >0 only as a contact-normal-up proxy [Trailmap: 370-world-interaction]
        public bool  PhysicsReAnchor        = true;      // re-anchor after it settles (knockable again, won't drift)
        public float PhysicsSettleSpeed     = 0.4f;      // m/s below which it counts as settling
        public float PhysicsSettleTime      = 2.5f;      // s below SettleSpeed before re-anchoring

        // ---- particle effects (docs/unity/014) ---------------------------------------
        // SSX placed soft billboard particle clouds (the Fog_* volumes, incl. the start-line clouds).
        // ParticleInstances.json gives each volume's world placement; ParticleModels.json gives its cluster of
        // puffs (local position + size). The sprites aren't per-level - the engine draws them from the shared
        // DATA\TEXTURES\PARTICLE.SSH bank, which `snowknife import` decodes into Textures/Particles/ (fog0 = fog).
        // ParticleBuilder rebuilds each volume as camera-facing billboard quads (OpenSlope/Particle shader) under
        // OpenSlope_Particles. Sprite is chosen by effect-name prefix (Fog_* -> fog0); size/tint/alpha are tunable.
        public bool   BuildParticles     = true;
        public string ParticleShaderName = "OpenSlope/Particle";
        public string ParticleSprite     = "fog0.png";              // default/fallback sprite (Textures/Particles/<name>)
        // 2 = the on-console DRAW size. The puff RADIUS reproduces the authored cluster bounds, but the fog0 sprite's
        // legible core fills only about half of its quad and the rest is soft falloff. So a quad
        // drawn at half-extent = radius shows visible haze only out to ~half the authored radius - small, separate
        // blobs. ~2x draws the soft haze out to the authored radius, so the puffs merge into one continuous soft mass
        // the way the engine's sprite scatterer does. See docs/unity/014.
        public float  ParticleSizeScale  = 2f;
        // Cool haze tint (not pure white): the fog sits in the level's atmosphere, so an unlit full-white sprite reads
        // too bright. This dims the NEAR fog to a translucent grey; the fog-aware OpenSlope/Particle shader additionally
        // dissolves the FAR banks into the scene fog colour with distance. Raise toward white for a bright/day course.
        public Color  ParticleTint       = new Color(0.72f, 0.78f, 0.86f, 1f);
        // fog0 peaks at ~0.5 alpha and 13-18 puffs overlap per cluster, so alpha-over saturates (1-0.5^n) toward
        // OPAQUE white at 1.0. 0.5 keeps the stack translucent - a haze, not solid blobs. Raise (max 4) to thicken.
        public float  ParticleAlpha      = 0.5f;

        // ---- triggers & fireworks (docs/011, docs/019) -------------------------
        // SSX's scripted-effect TRIGGERS are invisible marker volumes (Visable=false, so PropBuilder draws
        // nothing for them). The firework half is two models: Mdl_FWTrigger (the invisible boxes the rider
        // passes through, each carrying a sequential EffectSlotIndex 55..77 - the "where it fires") and
        // Mdl_FireworkCylindar_Red (the VISIBLE launcher props, EffectSlotIndex -1 - the trigger fires the pyro
        // AT these). TriggerBuilder rebuilds each launcher's native P6 layers as Unity ParticleSystems under
        // OpenSlope_Fireworks and emits
        // each FWTrigger volume as an invisible BoxCollider(isTrigger) under OpenSlope_Triggers (sized from the
        // volume's own geometry in Props.obj) carrying the firework-trigger behaviour, wired to the launchers within
        // FireworkFireRadius. A stock ParticleSystem supplies timing/quads while the P6 shader evaluates the recovered
        // trajectory, so the burst plays with no runtime MonoBehaviour; the importer
        // attaches the firework-trigger behaviour directly, which fires the volley when the LOCAL player skis through
        // (docs/vrchat/013). The manifest carries the complete authored particle law in root-local SSX units.
        public bool     EmitTriggers          = true;
        // Use the game's REAL trigger->launcher wiring from the effect graph (SSFLogic.json: slot -> CollisionEffectSlot
        // -> MainType-7 launcher instances) instead of "all launchers within a radius". The real map fires the AUTHORED
        // launchers per trigger - mean ~2.7, range 1-7 - vs the radius fallback's up-to-8-within-90m, which
        // over-fired and lit distant launchers. Falls back to radius per trigger when the map is absent. See docs/019.
        public bool     FireworkUseRealMapping = true;
        public float    FireworkFireRadius    = 9000f;   // FALLBACK only (no real map): SSX units (~90 m) launchers within this fire
        public int      FireworkMaxPerTrigger = 8;       // FALLBACK only: cap rockets per trigger so a dense cluster can't fire dozens
        public float    FireworkVolleyStagger = 0.12f;   // s between rockets in a trigger's volley (0 = all at once)
        public float    FireworkCooldown      = 4f;      // s before a trigger can re-fire (stops re-entry spamming it)
        // Firing SOUND. The real game plays SSF effect-graph SoundPlay event 82 when a firework fires; SSF
        // MainType-8 (SoundPlay) resolves to the course BANK (BANKS.INF group 2), slot passed raw
        // [Trailmap: 230-level-ssf] - i.e. the level's course bank, bank-local slot 82 = the clip we already extract
        // to Audio/SFX/<bank>/082.wav. TriggerBuilder hangs a positional AudioSource (+ paired VRCSpatialAudioSource,
        // since every SSX source is paired 1:1 or VRChat force-spatializes it silent - see CollisionBuilder) carrying
        // that clip on each launcher; the firework-trigger behaviour PlayOneShots it as it fires each rocket of the volley.
        public string   FireworkSoundSlot        = "082"; // course-bank slot for the firing sound (SSF SoundPlay 82); "" = silent
        public float    FireworkSoundVolume      = 1f;    // 0..1 one-shot volume
        public float    FireworkSoundMinDistance = 12f;   // world m at full volume (aerial bursts carry; tune by ear)
        public float    FireworkSoundMaxDistance = 220f;  // world m where it fades to silence (heard across the course, fainter far off)

        // ---- continuous emitters (the snow cannons + flares + lanterns) --------
        // SSX's always-on SSF particle emitters live on a VISIBLE instance via its EffectSlotIndex ->
        // EffectSlots[slot].PersistantEffectSlot header (a MainType-2/SubType-0 node) - unlike the TRIGGERED fireworks.
        // e.g. snow cannons (Mdl_SnowBlower_Top, 2 layers = the blown-snow plume), course flares, and stone lanterns.
        // snowknife bakes every layer into root-local mesh space; EmitterBuilder evaluates the native P6 trajectory and
        // authored timing/size/color/sprite/blend directly. [Trailmap: 180-particles-data]
        public bool   BuildEmitters      = true;
        public float  EmitterMinSize     = 0f;     // only build emitters whose biggest layer SizeCenter >= this (SSX units). 0 = all (snow cannons + flares + lanterns); ~80 = JUST the big snow plumes (drops the many small flares for perf - data-derived, no name match)
        // Ambient emitters (docs/052): the COLLISION-triggered dust/spark/fire/water/snow bursts (e.g. tree-break
        // spark+fire, sewer-dust, highway smash, fire hydrants, UNTRACK's dedicated snow-tree CollideEmitter).
        // The same P6 builder realizes their burst layers.
        public bool   BuildAmbientEmitters = true;
        public float  AmbientCooldown      = 4f;   // s between re-fires for a ONE-SHOT ambient emitter (re-entry guard); hydrants use their own ~7s SSX debounce
        public float  AmbientRollerPopSpeed = 4f;   // m/s: explicit-direction launch speed for a knockable prop; hydrant lids pop straight up [Trailmap: 370-world-interaction]
        public float  AmbientTriggerInflate = 100f; // SSX units (~1m total, ~0.5m each side) added to each trigger-box dimension - just past the hydrant's solid Bounds collider so the 0.3m-radius RiderProbe reliably enters ON contact (a same-size box only tangents the rider and never fires). Raise if hits at speed miss 0 = the raw prop/volume bounds. The INLINE prop emitters (hydrants/highway) sit ON a solid collider coincident with the trigger, so if a same-size box proves unreliable to fire on contact, raise this (~100 = ~1m reaches just past the surface). M7-marker emitters (sewer/spark/fire) have separate pass-through volumes and never need it

        // ---- light glints: the engine's runtime sparkle on every authored glow light ----
        // The halo ring + streak cross on a level's street lamps AND its course flares. The engine draws these
        // per frame from the light table itself - gate spriteRes & 0x70 (16/32/64 glint, 256/512
        // never), colour = the record's hue, occlusion = the depth buffer at the light's position. The sparkle is
        // WORLD-anchored (a res-32 glint is ~1.5 m across, growing by plain perspective as you approach) with a
        // fixed-PIXEL floor (the engine's constant 16x8-px core - far lamps keep a tiny constant glint), blooms
        // toward the screen centre, and its star turns with the glint's screen X ([Trailmap: 160-lighting-data],
        // the runtime glint section). LightGlowBuilder places one depth-tested OpenSlope/FlareHalo billboard per
        // manifest.LightGlows record using the authored PARTICLE.SSH glint art; no runtime script needed. The
        // flares' moving plume stays on the emitters (docs/unity/045).
        public bool   LightGlows          = true;   // build a glint billboard per qualifying authored light
        public float  LightGlowSize       = 75f;    // SSX units: glint radius for the res-32 class (x res/32 per record) -> ~1.5 m diameter, the on-console size of a flare's sparkle
        public float  LightGlowAlpha      = 0.9f;   // glint brightness (OpenSlope/FlareHalo _Color.a). Additive. ONE value for every glint: the engine's per-record glint brightness is 1.0 in every light of every shipped course, so a squad-car beacon sparkles as brightly as a floodlight - only hue and size class differ ([Trailmap: 160-lighting-data])
        public float  LightGlowStreak     = 1.2f;   // streak-cross strength (shader _Streak; the always-on half of the sparkle). 0 = plain ring
        public float  LightGlowTwinkle    = 1f;     // scales the game's rotation law (star angle = -90deg x the glint's screen X; the sparkle turns as you ride past). 0 = static star
        public float  LightGlowRange      = 300f;   // metres: draw range D - alpha 1 out to D/2, then linear to 0 at D (the engine's fade law; lamps sparkle from far across a night course). 0 = never fades
        public float  LightGlowMinPx      = 14f;    // screen pixels the sparkle never shrinks below (the engine's constant 16x8-px core; far lamps keep a tiny constant glint). 0 = pure world size
        public float  LightGlowBoost      = 1f;     // screen-centre bloom: size x (1 + this x centredness^4) - glints grow when looked at dead-on. 0 = off
        public float  LightGlowAura       = 2.5f;   // the game's second, larger glow element: a soft same-hue gradient extending this x beyond the sparkle (its smooth falloff is also what makes occlusion fade gracefully). 1 = off
        public float  LightGlowAuraAlpha  = 0.3f;   // aura brightness (fraction of the sparkle's; soft additive)
        public float  LightGlowHot        = 0.3f;   // white-hot centre: the star + core elements add this much WHITE on top of the hue (the console's overbright additive saturation - a red flare burns white at the middle, pure hue at the halo/aura). 0 = fully tinted
        public float  LightGlowRing       = 0.7f;   // halo ring strength; the ring samples a blurrier mip so its rim reads soft, and this scales its alpha. 1 = the raw atlas ring
        public float  LightGlowNudge      = 5f;     // metres the billboard pulls toward the camera for the res-32 class (the game's per-class pull: 3/5/8 m for 16/32/64) - the sparkle sits IN FRONT of nearby terrain/fixtures instead of cutting into them, as on console. OCCLUSION is the source-visibility fade below (the game's model), not the z-test, so the big pull costs nothing
        public bool   LightGlowFade       = true;   // the game's occlusion model: fade each glint with its light's LINE OF SIGHT from the viewer (round-robin 5-ray tests, eased) - a prop right next to a flare hides its sparkle, and the fade is graceful. Realized by the platform wiring (GlintFade)
        public float  LightGlowFadeSpeed  = 2.5f;   // _Visibility easing per second (~2.5 = a graceful third-of-a-second swing)

        // ---- billboard screens (docs/vrchat/041) --------------------------------
        // The catalog of video-ready quads, one flush over each billboard's ad face. WHERE each goes is measured
        // by snowknife from the placed prop geometry and shipped as manifest.Billboards (or authored in
        // Slopesmith); BillboardScreenBuilder just lays the quads, disabled, for a platform's video setup to
        // consume. Off = no catalog, so the platform's video object simply has no screens to drive.
        public bool   BuildBillboardScreens  = true;

        // ---- boost pads (spec 360, docs/040) -----------------------------------
        // SSX's gold SPEED pads (Mdl_SpeedBoost_Gold_*) and red/green TRICK pads (Mdl_TrickBoost_RedGreen_*) are visible
        // arrow decals the rider crosses. snowknife bakes each pad's footprint + tier (manifest.BoostPads), data-derived
        // from the SSF graph (a MainType-17 speed magnitude / MainType-18 trick window) - so it works on any level with
        // the same effect nodes, not by name. BoostPadBuilder overlays an invisible trigger volume on each carrying
        // the boost-pad behaviour: a SPEED pad runs the board's timed boost (raise the top-speed cap + lean-gated thrust for a
        // window - the game's pad mechanic, which raises the cap + feeds the cruise drive, no instant velocity write);
        // a TRICK pad is cosmetic (sparkle + chime) - a free-roam world has no trick scoring for the window to feed, and
        // trick pads apply no upward launch [Trailmap: 360-speed-and-boost].
        public bool   EmitBoostPads          = true;
        public float  BoostPadSecondsPerUnit = 0.5f;  // speed-pad boost SECONDS = authored magnitude x this (e.g. 5.0 -> 2.5 s)
        public float  BoostPadTriggerInflate = 100f;  // SSX units (~1 m) grown on EACH side of the thin pad footprint so a fast rider reliably crosses it
        // Collision VOLUMES wired to the board (docs/053): OOB/reset zones (MainType-13) + directional boost volumes (MainType-0/Sub7).
        public bool   EmitResetZones        = true;
        public float  ResetZoneInflate      = 0f;     // SSX units added to each reset-volume dimension (they're already sized boundaries)
        // The OOB FLOOR (docs/031): one trigger slab under the whole map, built as another reset volume, so falling out of
        // the world is a PLACE you cross instead of a per-frame guess. The game itself has no void check at all - this is
        // the ONE thing we add, and it only catches a rider who leaves through a gap the authored volumes don't cover.
        public bool   EmitOobFloor          = true;
        public bool   OobFloorTilt          = true;   // fit the slab PARALLEL to the mountain (least-squares plane through the terrain) instead of level under its lowest point, so the drop to it is ~constant down the run instead of the whole height of the mountain at the summit. Off = a level slab
        public float  OobFloorDrop          = 60f;    // WORLD m of GUARANTEED clearance below the terrain (the tilted plane is pushed past its deepest sample, so this is a minimum, not a nominal). MUST stay well under Map.RespawnMarginBelowMap (120 m), or VRChat's respawn yanks the rider to spawn (off the board) before ever reaching us
        public float  OobFloorMargin        = 2000f;  // WORLD m of slab beyond the terrain's XZ extent on each side, so leaving sideways still crosses it
        public float  OobFloorThickness     = 150f;   // WORLD m thick - a rider at terminal velocity must not tunnel it in a single physics step (a board moves a couple of metres per step, so this is ~75 steps of headroom). Kept no larger than it needs to be: the slab is a trigger, and its bounds are what every rigidbody broadphases against
        public bool   EmitBoostVolumes      = true;
        public float  BoostVolumeInflate    = 100f;   // SSX units (~1 m) the TRIGGER collider is grown by, so its callback is already running when a fast rider reaches the box. Broadphase only: the behaviour narrows to the authored extent, so this never moves where the push starts
        public float  BoostVolumeSpeedScale = 1f;     // x the authored target speed -> world m/s. The authored value IS metres/second (the engine stores it x100 as cm/s, [Trailmap: 360-node-fields]), so 1.0 = faithful. Retail spans 45-200; toward the top of that range the target is unreachable anyway and only the rate decides the feel, so lower this only to soften a volume on purpose
        public float  BoostVolumeRateScale  = 1f;     // x the authored approach rate. THE tuning knob if a volume feels wrong: speed along the axis approaches the target with time constant 1/rate, so halving this halves how hard the volume grabs. Retail spans 0.1 (a gentle air shaft) through 3-4 (exhaust vents, wind) to 10.0 (a conveyor slamming the rider to speed)
        public bool   BuildSplineMovers     = true;   // MainType-2/Sub1 spline-path movers (e.g. a subway car)
        public float  SplineMoverSpeedScale = 1f;     // x the authored SSX AnimationSpeed -> world m/s. AnimationSpeed IS metres/second: the game takes it x100/60 = cm per 60 Hz tick ([Trailmap: 230-level-ssf]), so 1.0 = faithful. The PAL disc ticks at 50 Hz with that 60 hardcoded, i.e. runs it ~0.83x - drop this to 0.83 to match a PAL playthrough, or lower still by feel
        public float  SplineMoverCableWidthPx = 2f;   // SCREEN pixels wide, at any distance - the engine's cable is a GS line primitive, which is 1 pixel wide whether you're touching the wire or a kilometre away (confirmed in-game). 1 px at the PS2's 640x448 is ~2 px at a modern resolution; OpenSlope/ScreenLine does the widening in clip space
        public Color  SplineMoverCableColor   = new Color(0f, 0f, 0f, 0f);  // alpha 0 = use the colour the level authored (a near-black #1a1a1a, which is what the game renders). Set a colour only to override that on purpose
        // Soft-prop wind (docs/053): flags ripple, fences shimmer. A per-vertex flap weight (0 base .. 1 free tip) keeps
        // bases anchored; the flag/fence geometry is diverted into ONE combined mesh per kind (cheap - 1 draw call/material).
        public bool   EmitSoftBodies     = true;
        public float  WindFlagStrength   = 0.6f;      // world-m sway at a flag's free tip
        public float  WindFlagSpeed      = 2.2f;
        public float  WindFlagFreq       = 0.10f;
        public float  WindFenceStrength  = 0.05f;     // small - a subtle chain-link shimmer, not a bend (the real Sub12 flex is collision-triggered)
        public float  WindFenceSpeed     = 4.0f;
        public float  WindFenceFreq      = 0.20f;
        public float  BoostPadCooldown       = 2f;    // s before a pad can re-fire (stops sitting-in-it / re-entry spamming)
        public float  BoostPadMinRideSpeed   = 0f;    // min board speed (m/s) to fire while riding; 0 = any contact
        // The pad's contact burst, entirely data-derived: the pad's collision header authors its OWN particle
        // emitters inline beside the MainType-17/18 boost node (9 layers on every shipped level). snowknife bakes
        // those layers into manifest.BoostPads[].Layers and the shared P6 path (docs/019, docs/052) renders them,
        // same as the fireworks / ambient bursts. Off = the pad crosses with sound + pop only.
        public bool   BoostPadParticles      = true;
        // Hit feedback (docs/040): unlike the game - whose pad never disappears (DeadNodeMode 2) - a crossed pad here
        // POPS like a gem (docs/023): snaps to nothing, holds, then grows back. Needs the pad diverted out of the
        // merged static mesh so it has its own transform to scale.
        public bool   BoostPadPop            = true;
        public float  BoostPadPopHoldDelay   = 0.5f;  // s gone before regrow starts (this blackout IS the re-entry debounce)
        public float  BoostPadGrowBack       = 1.2f;  // s to ease back to full size
        // The pad-cross sound. Like the gem chime it is CODE-driven, not an SSF SoundPlay node: the MainType-17
        // handler plays MAIN-bank (zbxsfx) slot 115 for a gold SPEED pad, MainType-18 plays slot 114 for a
        // red/green TRICK pad - fixed per pad TYPE (not tier), gated on the local human player. Both are the clips
        // snowknife decodes to Audio/SFX/zbxsfx/. "" = silent for that type. [Trailmap: 360-speed-and-boost]
        public string BoostPadSpeedChimeClip   = "SFX/zbxsfx/115.wav"; // gold speed pad cross (zbxsfx 115)
        public string BoostPadTrickChimeClip   = "SFX/zbxsfx/114.wav"; // red/green trick pad cross (zbxsfx 114)
        public float  BoostPadChimeMinDistance = 6f;  // world m at full volume
        public float  BoostPadChimeMaxDistance = 50f; // world m where it fades to silence

        // ---- teleports (spec 390-teleport, docs/051) ---------------------------
        // SSX's MainType-24 portal pairs: a collision trigger whose SSF effect warps the rider to near a named
        // instance. snowknife bakes each pair (manifest.Teleports), data-derived from the effect graph (not by name):
        // the invisible START volume box, the DESTINATION instance pivot, and any entry-cue SoundPlay. TeleportBuilder
        // overlays an invisible trigger + a destination anchor carrying the teleport behaviour, which warps the local rider there
        // - a walking player via VRCPlayerApi.TeleportTo, a board rider via the board's RespawnAt (station carry).
        // A level may author one or more portal pairs (each with an entry cue in its course bank); many author none.
        public bool   EmitTeleports          = true;
        public float  TeleportTriggerInflate = 0f;    // SSX units grown on EACH side (the baked box already spans the volume)
        public float  TeleportCooldown       = 2f;    // s before a portal can re-fire (stops re-entry / landing-in-it re-trigger)
        public float  TeleportUpOffset       = 0.5f;  // world m lift on landing so a walking player doesn't spawn inside the ground
        public float  TeleportChimeVolume    = 1f;    // entry-cue volume (0..1). The cue plays 2D: the rider is warped away
                                                      // the instant it fires, so a positional source would cut off "at the entrance"

        // ---- rail toggles (spec 350-rails, docs/026) ---------------------------
        // SSX's MainType-25 rail toggles: a trigger volume that makes a gated grind rail grindable at runtime (e.g. a
        // fallen-tree trunk becomes a rail once the tree topples). snowknife bakes the gated rails start-disabled
        // (Paths.Rails.Gated) + each toggle's trigger box + rail indices (manifest.RailGates); RailGateBuilder overlays
        // an invisible trigger carrying the rail gate that enables those rails on cross. No-op on levels that author none.
        public bool  EmitRailGates          = true;
        public float RailGateTriggerInflate = 0f;   // SSX units grown on EACH side (the baked box already spans the volume)
        public float RailGateCooldown       = 1f;   // s re-fire guard (enabling is idempotent, so this is just a throttle)

        // ---- breakable LCD logos (docs/028) ------------------------------------
        // SSX's LCD jumbotron logo screens BREAK when you ride through them (a scripted MESH-SWAP, not a
        // physics shatter) [Trailmap: 370-world-interaction]. The intact lit screen (Mdl_Lcd_ScreenLogo_*, zero response mass so you pass THROUGH it like a leaf
        // cutout) carries an EffectSlotIndex, and the game swaps the screen on collision: the intact logo and its
        // scanline overlay (Mdl_Lcdscan_*) go hidden, the pre-modelled broken twin (Mdl_Lcd_ScreenLogoBroken_*, shipped
        // invisible = Visable=false) appears, and the LCD break sound plays (CollisonSound 63 -> the course bank, slot
        // 064). PropBuilder pulls the
        // three screen instances OUT of the merged Props mesh into their own toggle-able GameObjects under
        // OpenSlope_BreakableLogos (the broken twin is force-emitted despite Visable=false), drops a pass-through trigger
        // BoxCollider over the screen face, and attaches the breakable behaviour that does the swap on contact (walking
        // player OR the riding board's RiderProbe), local-only. Matched by model-name substring so it generalises.
        // See docs/028-breakable-signs.md.
        public bool   BuildBreakableLogos    = true;
        public string BreakLogoIntactMatch   = "Mdl_Lcd_ScreenLogo";        // the intact screen (NOTE: ScreenLogoBroken also contains this - classify Broken FIRST)
        public string BreakLogoBrokenMatch   = "Mdl_Lcd_ScreenLogoBroken";  // the pre-modelled broken twin (Visable=false in the data; force-emitted)
        public string BreakLogoScanlineMatch = "Mdl_Lcdscan";               // the scrolling scanline overlay (hidden on break, like the game)
        public float  BreakLogoTriggerInflate = 60f;   // SSX units (~0.6 m) the pass-through trigger box GROWS beyond the screen bounds on every side, so a fast rider reliably catches the thin panel
        public bool   BreakLogoRespawn        = true;  // re-arm the screen after a break (persistent free-roam world stays whole; you can break it again)
        public float  BreakLogoRespawnDelay   = 12f;   // seconds before a broken screen restores (respawn only)
        public float  BreakLogoMinRideSpeed   = 0f;    // min board speed (m/s) to break while riding; 0 = any contact (you ride through it). Walking always breaks on contact
        // What the break LOOKS like. In the real game the screen DISAPPEARS, shattering into shards that burst away -
        // it does NOT visibly swap to a "broken" picture. SSX's Mdl_Lcd_ScreenLogoBroken twin is in fact near-identical
        // to the intact logo (same 0061 texture, only subtly more tessellated), so revealing it reads as "nothing
        // changed". So by DEFAULT we hide the intact screen + scanlines (it vanishes) and let the shard burst sell the
        // break, leaving an empty frame. Set true to instead do the literal mesh-swap (reveal the broken twin)
        // - faithful to the data path, but visually almost a no-op.
        public bool   BreakLogoRevealBroken   = false;
        // Shard burst: the screen shatters into chunks that burst away (the visible payoff - the swap alone can't show
        // it). The game look: the screen breaks into a FEW BIG shards TEXTURED LIKE THE SCREEN ITSELF.
        // We reproduce that by texturing each shard with the screen's own image (the 0061 logo, read off the intact
        // renderer) split into a Tiles x Tiles grid via the particle texture-sheet - each shard shows one random
        // FRAGMENT of the logo, so the panel looks like it fractured into textured pieces. The game emits no particle
        // here at all (the source level authors no collision-particle emitter) [Trailmap: 370-world-interaction], and brk1-3 are TREE BARK / cnf1-2 are generic glass - so the
        // screen-texture path is both more faithful and better-looking. Tuned live (16 chunks, ~1-2 m, ~4.5 m/s).
        public bool     BreakLogoDebris        = true;
        public bool     BreakLogoDebrisUseScreenTexture = true; // texture each shard with a fragment of the screen's own image (the game look); false = generic cnf glass sprites below
        public int      BreakLogoDebrisTiles   = 4;      // screen texture split into Tiles x Tiles fragments (4 -> 16 chunks); each shard = one random tile
        public string[] BreakLogoDebrisSprites = { "cnf1.png", "cnf2.png" };  // FALLBACK sprite (UseScreenTexture off): SSX's white angular SHARD sprites (NOT brk* - those are bark)
        public Color    BreakLogoDebrisTint    = new Color(0.82f, 0.92f, 1f, 1f); // FALLBACK tint (icy white-blue glass); screen-textured shards render white (true colours)
        public bool     BreakLogoDebrisAdditive = false; // shards read as SOLID flying pieces (alpha-blended); additive would make them glow/glint
        public int      BreakLogoDebrisCount   = 16;     // shards per burst - FEW, big chunks (~Tiles^2 so the panel breaks into roughly one of each tile; tuned live)
        public float    BreakLogoDebrisLifetime = 1.6f;  // seconds each shard lives before it fades (long enough to tumble out + fall)
        public float    BreakLogoDebrisSpeed   = 450f;   // SSX-unit burst-away speed (~4.5 m/s; BuildLogoDebris spawns a 0.25x..1x range); x WorldScale -> world
        public float    BreakLogoDebrisSize    = 200f;   // SSX-unit shard size (~2 m max, ~1..2 m range; BIG screen chunks); x WorldScale -> world
        public float    BreakLogoDebrisGravity = 1.2f;   // gravityModifier (World sim space -> ~11.8 m/s^2): chunks hang briefly then arc down (tuned live)

        // ---- balloon "explode in stars" burst (docs/036) -----------------------
        // A breakable whose SSF COLLISION effect carries a type2Sub0 particle emitter (e.g. balloon-animal props,
        // BurstColor in the bundle) pops into a spray of additive STAR sprites tinted to the authored emitter colour
        // (a per-prop authored hue), instead of the texture-fragment shards above. Data-derived (no name
        // match): any prop authored this way bursts into coloured stars. The real game effect (two type2Sub0 emitters
        // + a DeadNode that hides the balloon) [Trailmap: 180-particles-data].
        public bool     BalloonBurst         = true;
        public string   BalloonBurstSprite   = "str1.png"; // additive star sprite in Textures/Particles/ (str1/str2/str3 are the game's stars)
        public int      BalloonBurstCount    = 40;         // stars per pop
        public float    BalloonBurstSize     = 150f;       // SSX-unit star size (~1.5 m; spawns a 0.5x..1x range); x WorldScale -> world
        public float    BalloonBurstSpeed    = 700f;       // SSX-unit spray speed (~7 m/s; spawns a 0.35x..1x range); x WorldScale -> world
        public float    BalloonBurstLifetime = 1.2f;       // seconds each star lives before it fades
        public float    BalloonBurstGravity  = 1.0f;       // gravityModifier (World sim space): stars arc down after the pop
        public bool     BalloonGrowBack         = true;    // on respawn, GROW the balloon back from nothing (like the gems) instead of popping it in instantly
        public float    BalloonGrowBackDuration = 1f;      // seconds the grow-back eases from nothing to full size

        // ---- rail grinding (docs/026) ------------------------------------------
        // SSX authored grind RAILS as splines in DATA Splines.json (normally SplineStyle 13, plus named exceptions
        // such as Alaska's style-5 IceRails), each a chain of cubic Bezier segments. The visible rail/fence geometry
        // already renders as ordinary props; these splines are the separate grind CENTERLINES the board snaps to.
        // RailBuilder samples each Bezier into a polyline (same -x,y,z + root transform as all geometry) and bakes
        // them into one rail network on OpenSlope_Rails, which the rideable board queries to grind (docs/026, docs/vrchat/017).
        public bool  BuildRails           = true;
        // Editor/default preview policy (docs/026). Both show-off-only and race-only props are always imported with
        // mode tags, and show-off rail indices stay separately switchable; the VRChat Settings Board applies the exact
        // Race/Trick/Free-ride set at runtime. ON starts the scene from Freeride (both mode-only prop sets + show-off
        // rails disabled) until a selector runs. OFF (default) starts in Showoff, including gems and show-off rails.
        public bool  GateShowoffRails     = false;
        public int   RailSamplesPerSegment = 8;     // polyline points sampled per cubic Bezier segment (higher = smoother snap/tangent, more points)
        public bool  RailDebugDraw        = false;  // also draw a thin LineRenderer along each rail (to eyeball that the grind lines lie on the visible rails); off for shipping
        // Course path for out-of-bounds reset: bake AIP.json/SOP.json RaceLines (+ Respawnable AIPaths) into a
        // rail network on OpenSlope_CoursePath, which the board snaps to on OOB so you land back ON the course near
        // where you left, not at spawn (loop-proof). CoursePathBuilder; see the rideable board, docs/011.
        public bool  BuildCoursePath      = true;
        // (No import-time vertical lift: the board's runtime railHeight sits the deck above the grind line in world-up
        //  and is tunable live, so a bake-time offset would be redundant.)

        // ---- collision (docs/009) ----------------------------------------------
        public bool TerrainColliders        = true;
        public bool PropColliders           = true;
        public int  NoCollisionSurfaceType  = 17;  // SSX "No Collision": those patches render but get no collider

        // ---- draw-call batching (perf) -----------------------------------------
        // The combined "Terrain" and "Props" meshes carry one submesh+material per source texture (50-80 each),
        // and every visible submesh is a SetPass + draw - the dominant Quest CPU cost (the GPU sits idle).
        // Collapse each into ONE draw per render-config by stacking the (tiling) textures as
        // Texture2DArray slices and baking the slice index into UV0.z (TextureArrayPacker + the OpenSlope unlit shader _TEXARRAY).
        // Flipbook / UV-scroll submeshes are left alone. Arrays land under MatFolder/TexArrays.
        public bool BatchDrawCalls          = true;

        // Camera-range cull for placed objects (gems/balloons/crash-bags/animated props): the engine gathered placed
        // objects within a ~300 m camera range and drew only those (RE Trailmap/specs/400-rendering); the port otherwise
        // draws the whole course's props from the mountain top. ObjectCuller (built by ObjectCullerSetup) gates
        // each prop renderer beyond ObjectCullRange m of the local player. Terrain is unaffected (keeps drawing to fog).
        public bool  RangeCullObjects       = true;
        public float ObjectCullRangeQuest   = 600f;   // metres on Quest, cull ON (the tighter bound it needs)
        public float ObjectCullRangePC      = 1200f;  // metres on PC, cull ON (bounds the mountain-top fall-line view + compact-city prop draw)
        // The Perf Board "cull" toggle is TWO-TIER (docs/unity/006): OFF widens the range instead of switching the culler
        // off, so 'off' still bounds the draw (the culler stays active). Quest OFF widens to the PC on-range (Quest can't
        // afford truly-unbounded draw); PC OFF widens past every prop (~1770 m) = full draw. The distance fog end follows
        // whichever range is active, so the haze widens with the cull.
        public float ObjectCullRangeQuestOff = 1200f; // metres on Quest, cull OFF (= the PC on-range)
        public float ObjectCullRangePCOff    = 3000f; // metres on PC, cull OFF (full draw)

        // ---- object lighting: props + avatar (docs/unity/010) ------------------------
        // SSX lit every PLACED object per-instance (NOT from the terrain lightmap). Static props bake the exact
        // ambient + three max(0,N.L)*key result into COLOR; movers evaluate those same three terms in the shader.
        // Both use the game's /256 records and byte/sRGB texture modulation. The avatar still uses light probes.
        public bool  PropLighting      = true;
        public float PropLightNorm     = 256f;  // aggregate probe normalization; exact prop bundle records always use 256
        public float PropKeyFactor     = 0.5f;  // aggregate probe weighting; exact props retain all three keys
        public float PropLightContrast = 1.6f;  // terrain/probe presentation; exact _PROPLIGHT does explicit sRGB modulation
        public float PropLightGain     = 1f;
        public float PropLightStrength = 1f;
        public bool  BuildProbes       = true;
        public float ProbeMinSpacing   = 150f;  // de-dupe spacing in raw SSX units (~1.5 m at WorldScale 0.01)
        // Avatar probes get the directional sun too (docs/unity/010): the warm KEY is added as a directional light along
        // `PropDirLightDir` so a moving avatar's sunny side warms / shaded side cools, matching the props. The probe
        // DC (L0) - which the board reads, and which equals the avatar's surface-average - is held EXACTLY at the old
        // isotropic LightColour (the directional's own DC is subtracted back out of the ambient floor), so nothing's
        // overall brightness changes; ProbeDirIntensity only sets the CONTRAST of the tilt. Off = old isotropic.
        public bool  ProbeDirLight     = true;
        public float ProbeDirIntensity = 0.6f;  // directional CONTRAST in the probe SH (DC is preserved at any value; 0 = flat)

        // Real-time DIRECTIONAL light for props that rotate. Exact bundle data supplies all three per-instance
        // directions and keys. PropDirLightDir remains the aggregate direction for probes, the board, and scene sun.
        public bool    PropDirLight     = true;
        // Project-authored fallback direction TO the sun (shader normalizes), matching Slopesmith DEFAULT_SUN
        // at azimuth 210 / elevation 52. A level manifest overrides this with the course's own imported or
        // authored sun, so the fallback is used only when no direction was supplied.
        public Vector3 PropDirLightDir  = new Vector3(-0.533f, 0.788f, -0.308f);
        public Color   PropDirLightColor = Color.white;                    // the sun's hue (from manifest.Sun), used to colour the scene Directional Light
        public bool    HasManifestSun    = false;                          // the level authored a sun -> orient the scene light from it (SunBuilder)
        // Static props get the same directional equation baked per vertex by snowknife; native OBJ normals and the
        // instance-local light vectors are retained. No Unity global-sun approximation is involved.
        public bool    PropStaticDirLight = true;

        // ---- ambient weather (docs/044) ----------------------------------------
        // Build the ambient falling-snow system (SnowfallU) so the Settings Board's "Snow effect" row is available.
        // Whether a course snows isn't in the level data - the engine rolls it at course init (unextractable), so the port
        // doesn't guess: the snow is built but renders only when a player opts in (the board toggle defaults OFF). Default
        // true = every map offers the toggle; set false to omit snow entirely on a map that should never have it. Setup All
        // stands it up before the Perf Board; OpenSlope/Setup/Snowfall is the manual path. Snowfall "amount" (the game's front-end
        // "Snow fall:" 0.5..2.0, [Trailmap: 400-rendering]) is the Snowfield._Intensity material knob.
        public bool BuildSnowfall = true;

        // ---- audio (docs/015) --------------------------------------------------
        // `snowknife import` decodes the level's music (Audio/Music/*.wav) and SFX banks (Audio/SFX/<bank>/NNN.wav).
        // AudioBuilder places them as native Unity AudioSources under OpenSlope_Audio, each with a configured
        // VRCSpatialAudioSource so VRChat honours the rolloff (docs/015). Retail crowd cheers use the exact ADL
        // type-0 placements and share one throttled proximity gate; geometry centroids remain the fan-map fallback.
        // Audio/Environment.json declares the optional non-positional off-board filler; there is no importer
        // knob or Wind bank guess. Per-surface footstep/board SFX
        // are NOT here - they ride on the surface detector (VRC/Riding, SDK-only). Clip paths are relative to
        // LevelFolder/Audio and are FIRST-GUESS picks from the numbered banks - retune by ear.
        public bool BuildAudio = true;

        // The level's own SFX bank name (the "BANK" sound group): the bank that carries collision-impact + firework
        // firing one-shots, decoded by snowknife into Audio/SFX/<bank>/NNN.wav. It's NOT derivable from the level name,
        // so it's data: For(folder) auto-detects it (DetectLevelSfxBank - the one non-shared SFX folder). Stays EMPTY
        // until `snowknife sfx <level>` has decoded the banks, in which case collision/firework sounds stay silent
        // (non-fatal). CollisionBuilder + TriggerBuilder read it instead of a hardcoded bank.
        public string LevelSfxBank = "";

        // Crowd: native ADL records resolve events 97..99 exactly to Crowd/000..002 and carry their own placement,
        // radius, and falloff. These clip/range/cluster settings are used only by the geometry fallback for fan maps
        // with no classified native records; that fallback round-robins clips so adjacent stands do not phase-lock.
        public bool     CrowdAudio         = true;
        public string[] CrowdClips         = { "SFX/Crowd/002.wav", "SFX/Crowd/001.wav", "SFX/Crowd/018.wav", "SFX/Crowd/000.wav" };
        public float    CrowdClusterRadius = 12000f; // SSX units (~120 m): mat_crowd billboards within this merge into one stand source
        public int      CrowdMaxSources    = 24;     // safety cap so a denser level can't spawn dozens of voices
        public float    CrowdVolume        = 0.55f;
        public float    CrowdMinDistance   = 10f;    // world m: full volume within
        public float    CrowdMaxDistance   = 180f;   // world m: inaudible beyond (Linear rolloff); long, to bridge stand gaps

        // EditorPrefs key holding the folder of the most-recently-imported level, so the "refresh one subsystem"
        // menus + the import dialog default to the level you're actually working on. Set by
        // LevelImporter.ImportFolder.
        public const string LastFolderPrefKey = "OpenSlope.LastLevelFolder";

        // Build a config for an arbitrary exported level folder (e.g. "Assets/OpenSlope/Maps/MyLevel"). All paths derive from
        // it and the spawn is course-derived; this is the generic path the folder-picker import uses. The library
        // root/level names, orientation, lighting and every other knob are level-INDEPENDENT, so only the two paths
        // (+ a "Materials" subfolder) change here.
        public static ImportConfig For(string levelFolder)
        {
            levelFolder = levelFolder.Replace('\\', '/').TrimEnd('/');
            var c = new ImportConfig
            {
                LevelFolder     = levelFolder,
                MatFolder       = levelFolder + "/Materials",
                SpawnFromCourse = true,
                LevelSfxBank    = DetectLevelSfxBank(levelFolder),   // the one decoded SFX folder that isn't a shared bank
            };
            // Orient the sun from the level itself when it authored one (manifest.Sun): the directional drives the
            // props' + probes' lighting (PropDirLightDir) here, and the scene Directional Light in SunBuilder, so a
            // custom map - or a re-baked original level - lights its dynamic objects from its own sun, not the default.
            if (BundleManifestReader.ReadSun(levelFolder, out var sunDir, out var sunCol, out _))
            {
                c.PropDirLightDir = sunDir;
                float m = Mathf.Max(sunCol.r, Mathf.Max(sunCol.g, sunCol.b));
                c.PropDirLightColor = m > 1e-4f ? new Color(sunCol.r / m, sunCol.g / m, sunCol.b / m) : Color.white; // hue at full intensity
                c.HasManifestSun = true;
            }
            return c;
        }

        // The shared/reference SFX banks (crowd cheers, board carve, external wind candidates, the MAIN
        // one-shot/gem bank, the tricky announcer); the per-level "BANK" group is whatever folder is left.
        static readonly string[] SharedSfxBanks = { "Crowd", "zboard", "Wind1", "Wind2", "zbxsfx", "tricky" };

        // Auto-detect the level's own SFX bank: the one Audio/SFX/<bank> folder that isn't a shared bank. Returns ""
        // until `snowknife sfx <level>` has decoded the banks. Folder-generic, so the importer needs NO per-level name
        // table. Current bundles name the BANKS.INF group-2 bank explicitly; this scan is legacy-only.
        static string DetectLevelSfxBank(string levelFolder)
        {
            string abs = Path.Combine(Path.GetDirectoryName(Application.dataPath), levelFolder, "Audio", "SFX");
            if (!Directory.Exists(abs)) return "";

            // The bundle names the course bank outright - trust it. The folder scan below is only a fallback for
            // bundles exported before the manifest carried it: it takes the first non-shared folder, which stopped
            // being the course bank once fixed environmental banks (Alleyway_1, Bird_Owl, ...) were decoded beside
            // it, silently muting every course-bank impact sound.
            string named = BundleManifestReader.ReadCourseBank(levelFolder);
            if (!string.IsNullOrEmpty(named) && Directory.Exists(Path.Combine(abs, named))) return named;

            foreach (string dir in Directory.GetDirectories(abs))
            {
                string name = Path.GetFileName(dir);
                bool shared = false;
                foreach (string s in SharedSfxBanks)
                    if (string.Equals(s, name, StringComparison.OrdinalIgnoreCase)) { shared = true; break; }
                if (!shared) return name;
            }
            return "";
        }

        // The config for the level currently being worked on: the last folder imported via the picker (EditorPrefs),
        // or DefaultLevelFolder if none. The post-import "Refresh/*" + "Setup/*" menus use this so they target the
        // loaded map. Fully data-derived (For): spawn from the course, sun from the manifest, SFX bank auto-detected.
        public static ImportConfig Current()
        {
            string last = UnityEditor.EditorPrefs.GetString(LastFolderPrefKey, "");
            return For(string.IsNullOrEmpty(last) ? DefaultLevelFolder : last);
        }

        // Preferred level shader, falling back to stock unlit/standard so a fresh project still imports.
        public Shader ResolveShader()
            => Shader.Find(ShaderName) ?? Shader.Find("Unlit/Texture") ?? Shader.Find("Standard");

        // Billboard shader for the particle effects. No good stock fallback exists (the puff quads are
        // degenerate without the view-space corner spread this shader does), so a missing OpenSlope/Particle just
        // means the particles don't show - ParticleBuilder warns. It ships in VRC, so normally it's found.
        public Shader ResolveParticleShader()
            => Shader.Find(ParticleShaderName);
    }
}
#endif
