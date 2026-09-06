using System.Text.Json;
using System.Text.Json.Serialization;
using Snowknife.Services;

namespace Snowknife.Bundle;

/// <summary>
/// The bundle sidecar: everything the importer needs that is NOT mesh geometry. Geometry lives
/// in the .glb files; this ties them together and carries the derived, engine-agnostic data
/// importer-side systems would otherwise have to recompute themselves (coordinate convention,
/// recenter, lightmap, materials, instances, collision, rails, particles, audio, skybox). Written
/// as plain JSON (PascalCase) so the Unity importer can read it with Newtonsoft and Blender/others
/// can read it as data. Sections grow as the bundle's coverage grows; consumers must tolerate
/// missing sections.
/// </summary>
public sealed class BundleManifest
{
    public int BundleVersion { get; set; } = 3;
    public string Level { get; set; } = "";
    public ProvenanceInfo? Provenance { get; set; }
    public SpaceInfo Space { get; set; } = new();
    public RecenterInfo Recenter { get; set; } = new();
    public List<MeshRef> Meshes { get; set; } = new();
    public LightmapInfo? Lightmap { get; set; }
    public List<TextureInfo>? Textures { get; set; }
    public List<MaterialInfo>? Materials { get; set; }
    public CollisionInfo? Collision { get; set; }
    public PropsInfo? Props { get; set; }
    public PathsInfo? Paths { get; set; }
    public ParticlesInfo? Particles { get; set; }
    public FireworksInfo? Fireworks { get; set; }
    public EmittersInfo? Emitters { get; set; }
    public AmbientEmittersInfo? AmbientEmitters { get; set; }
    public LightGlowsInfo? LightGlows { get; set; }
    public BoostPadsInfo? BoostPads { get; set; }
    public ResetZonesInfo? ResetZones { get; set; }
    public BoostVolumesInfo? BoostVolumes { get; set; }
    public SplineMoversInfo? SplineMovers { get; set; }
    public TeleportsInfo? Teleports { get; set; }
    public HudMessagesInfo? HudMessages { get; set; }
    public RailGatesInfo? RailGates { get; set; }
    public AudioInfo? Audio { get; set; }
    public ProbesInfo? Probes { get; set; }
    public SunInfo? Sun { get; set; }
    public GemsInfo? Gems { get; set; }
    public BillboardsInfo? Billboards { get; set; }
    public RaceInfo? Race { get; set; }

    /// <summary>
    /// Content-origin guard carried from the authoring/export boundary. This is deliberately separate from
    /// technical bundle validity: a bundle can be perfectly loadable while still being unsuitable for public
    /// distribution. Consumers that publish or upload must fail closed when this section is absent.
    /// </summary>
    public sealed class ProvenanceInfo
    {
        public string Source { get; set; } = "unclassified-map-folder";
        public string PublicDistribution { get; set; } = "blocked-unknown";
        public bool RetailDerived { get; set; }
        public bool UserSupplied { get; set; }
        public List<string> Reasons { get; set; } = new();
    }

    // ---- race: how the course is run. Laps is the number of PASSES from the start gate to the finish, so 1 is
    // the classic single run and the finish records on the first crossing. Above 1 an engine counts the crossing
    // down and sends the rider round again on the same clock; the lap-gated boost volume reads that same
    // countdown, which is what makes a finish tube throw them back up the mountain on every lap but the last
    // ([Trailmap: 390-lap-counter]). Sourced by Bundle/RaceBundle.
    public sealed class RaceInfo
    {
        public int Laps { get; set; } = 1;
        // Seconds on the SHOWOFF clock. A trick run is a COUNTDOWN, and the number it starts at is a property of
        // the course SLOT like Laps is - but where laps are a hardcoded compare with no data behind them, this is
        // a real per-course record in the boot executable, an integer in hundredths of a second that the engine
        // divides by 100 and seeds only in the showoff modes; every other mode zeroes the same field and counts it
        // UP as the race clock ([Trailmap: 390-showoff-clock]). 0 = a slot that hosts no showoff event at all.
        // Checkpoints extend it in-run, so this is the starting budget rather than the whole of one.
        public float ShowoffSeconds { get; set; } = 120f;
    }

    // ---- authored gem pickups (Slopesmith docs/014): the collectible half of an authored course's trick layer, read
    // straight from Slopesmith's Gems.json. Distinct from the EXTRACTED gems snowknife derives from a level's
    // SSF (MainType-14 → spinner DivertInfo). The course's GemModels.obj (the donor level's shipped tier
    // crystals) bakes into gems.glb nodes recorded in TierNodes; without it the importer synthesises the
    // gem visual. Either way each record realizes as a collectible GemMarker.
    public sealed class GemsInfo
    {
        public List<GemInfo> Gems { get; set; } = new();
        public Dictionary<int, string>? TierNodes { get; set; } // tier (2/3/5) → gems.glb node with the native crystal
    }
    public sealed class GemInfo
    {
        public float[] Center { get; set; } = new float[3]; // SSX mesh space (X negated) - the gem's world pivot
        public int Value { get; set; } = 1;                 // trick-score multiplier tier
    }

    // ---- billboard screens: the flat rectangle on each of the course's boards a video can be laid over, from
    // the map folder's Billboards.json (detected by snowknife from the placed prop geometry, or authored in
    // Slopesmith). An SSX billboard is welded into the merged prop mesh with a shared atlas material, so no
    // consumer can retexture one board's face; each lays its own quad over the ad face instead, and this is
    // where that face is. Absent = the map has no screens. See Unity docs/vrchat/041.
    public sealed class BillboardsInfo
    {
        public List<BillboardScreenInfo> Screens { get; set; } = new();
    }
    public sealed class BillboardScreenInfo
    {
        public string Name { get; set; } = "";      // unique within the map; the consumer's object name
        public string? Family { get; set; }         // the billboard family / author grouping, for grouped output
        public float[] Center { get; set; } = new float[3];  // SSX mesh space (X negated, cm) - the quad centre
        public float[] Normal { get; set; } = { 0f, -1f, 0f }; // unit, out of the screen toward the viewer
        public float[] Up { get; set; } = { 0f, 0f, 1f };      // unit image-up, perpendicular to Normal
        public float Width { get; set; }            // cm, along Normal x Up
        public float Height { get; set; }           // cm, along Up
        public int? Instance { get; set; }          // the Instances.json row it was found on, when it has one
        public string? Page { get; set; }           // the texture page the covered face draws, when measured
    }

    // ---- sun: the level's directional + ambient light (Lights.json Type 0 / Type 3), so the importer can
    // orient the scene's Directional Light + probe tilt from the level itself instead of a fixed config.
    public sealed class SunInfo
    {
        public float[] Direction { get; set; } = { 0, 1, 0 };  // Unity-world TO-LIGHT (== editor to-sun), normalized
        public float[] Colour { get; set; } = { 1, 1, 1 };     // directional sun colour (Type 0)
        public float[] Ambient { get; set; } = { 0, 0, 0 };    // ambient / sky-fill colour (Type 3)
    }

    // ---- audio: the engine-agnostic placement compute (clip choice + sources stay engine-side) ----
    public sealed class AudioInfo
    {
        public List<float[]> CrowdCentroids { get; set; } = new();   // SSX mesh space (X negated) - one looping crowd source each
        public List<PlacedLoopInfo> PlacedLoops { get; set; } = new(); // per-instance ExternalSounds + authored loops
        // The level's course BANK (BANKS.INF group 2) folder name under Audio/SFX - the bank prop-impact and
        // trigger sounds resolve their slots against. Named here because only the extractor knows it: a level
        // folder can hold several non-shared SFX banks, so an importer that guesses "the one folder that isn't
        // shared" can land on a fixed environmental bank and silence every course-bank impact sound.
        public string CourseBank { get; set; } = "";
    }
    public sealed class PlacedLoopInfo
    {
        public string Name { get; set; } = "";
        public string Kind { get; set; } = "authored-ambient"; // native-crowd | native-environment | authored-ambient
        public float[] Center { get; set; } = new float[3]; // SSX mesh space (X negated, cm)
        public float Radius { get; set; } = 80;             // Unity-world metres
        public int Sound { get; set; } = -1;                // global ADL event id
        public int Curve { get; set; } = 2;                 // ExternalSound falloff selector (2 = linear)
        public string? SoundClip { get; set; }              // optional staged Sounds/*.wav for authored maps
        // Interactive ambient class (retail events 16 cars / 28 hydrants / 57 police cars): the loop is
        // SILENT until the owning prop's collision one-shot first plays, then audible forever - in retail the
        // impact-play call itself registers the entity [Trailmap: 420-audio-runtime]. Omitted when not gated.
        public bool? HitGated { get; set; }
        public string? Owner { get; set; }                  // owning instance name, for the engine-side hit pairing
    }

    // ---- light probes: de-duped sample positions (the SH authoring + bake stay engine-side) ----
    public sealed class ProbesInfo
    {
        public float MinSpacing { get; set; }                        // grid spacing used to de-dupe (SSX units)
        public List<float[]> Positions { get; set; } = new();        // SSX mesh space (X negated) - LightProbeGroup positions
    }

    // ---- particles: SSX's authored fog/cloud billboard volumes (the Fog_* clouds) ----
    public sealed class ParticlesInfo
    {
        public List<EffectInfo> Effects { get; set; } = new();
    }
    public sealed class EffectInfo
    {
        public string Name { get; set; } = "";      // effect/instance name (the importer's GameObject name)
        public string Sprite { get; set; } = "";    // billboard sprite file in Textures/Particles/ (e.g. fog0.png)
        public List<PuffInfo> Puffs { get; set; } = new();
    }
    public sealed class PuffInfo
    {
        public float[] Center { get; set; } = new float[3];  // SSX mesh space (X negated, cm) - placed under the Level child
        public float Radius { get; set; }                    // authored puff radius in SSX units (importer applies size knob * WorldScale)
    }

    // ---- fireworks: launcher bursts + the trigger volumes that fire them ----
    public sealed class FireworksInfo
    {
        public List<LauncherInfo> Launchers { get; set; } = new();
        public List<TriggerInfo> Triggers { get; set; } = new();
    }
    public sealed class LauncherInfo
    {
        public int Index { get; set; }                    // Instances.json index (Triggers[].Launchers reference this)
        public float[] Muzzle { get; set; } = new float[3];   // SSX mesh space: burst spawn (canister top), from the cylinder geometry
        public float[] Barrel { get; set; } = new float[3];   // SSX mesh space dir: burst aim (canister long axis, oriented world-up)
        public List<EmitterLayerInfo> Layers { get; set; } = new(); // native P6 layers, baked into root-local mesh space
        public int Sound { get; set; } = -1;                  // firing one-shot: SSF MainType-8 SoundPlay id, course-bank-local (-1 = none authored)
    }
    public sealed class TriggerInfo
    {
        public int Index { get; set; }                    // Instances.json index
        public string Name { get; set; } = "";
        public int Slot { get; set; } = -1;               // EffectSlotIndex the volume carried
        public float[] Center { get; set; } = new float[3];   // SSX mesh space (X negated, cm)
        public float[] Size { get; set; } = new float[3];
        public List<int> Launchers { get; set; } = new(); // launcher Indices from the SSF graph (empty -> importer radius fallback)
    }

    // ---- boost pads: the visible speed/trick pads the rider crosses (spec 360-speed-and-boost) ----
    // The gold Mdl_SpeedBoost_Gold_* (effect slot 0) and red/green Mdl_TrickBoost_RedGreen_* (slot 1) are
    // VISIBLE props (so they stay in the merged static mesh) whose EffectSlotIndex resolves - through
    // EffectSlots[slot].CollisionEffectSlot - to a collision effect carrying a MainType-17 (speed magnitude) or
    // MainType-18 (trick window seconds) node. We bake each pad's footprint AABB + tier here; the importer
    // overlays an invisible trigger volume (like the firework triggers) wired to the rideable board.
    public sealed class BoostPadsInfo
    {
        public List<BoostPadInfo> Pads { get; set; } = new();
    }
    public sealed class BoostPadInfo
    {
        public int Index { get; set; }                    // Instances.json index
        public int ModeMask { get; set; } = 7;            // race=1, show-off=2, freeride=4
        public string Name { get; set; } = "";
        public int Slot { get; set; } = -1;               // EffectSlotIndex the pad carried (0 speed / 1 trick)
        public bool Trick { get; set; }                   // false = speed pad (MainType 17), true = trick pad (MainType 18)
        public float Value { get; set; }                  // type17 speed magnitude, or type18 trick-window seconds
        public float[] Center { get; set; } = new float[3];   // SSX mesh space (X negated, cm) - the pad footprint centre
        public float[] Size { get; set; } = new float[3];     // footprint extents (importer inflates for a reliable cross)
        // The pad's own contact particles: the MainType-2/SubType-0 emitters sitting INLINE on the same collision
        // header as the MainType-17/18 boost node (a gold pad authors 9). Baked into root-local mesh space like the
        // firework launchers', so the importer renders them through the shared P6 path instead of a stand-in sparkle.
        public List<EmitterLayerInfo> Layers { get; set; } = new();
    }

    // ---- reset zones (Unity docs/053): the OOB / reset-onto-track volumes (Trailmap MainType-13) ----
    public sealed class ResetZonesInfo { public List<ResetZoneInfo> Zones { get; set; } = new(); }
    public sealed class ResetZoneInfo
    {
        public int Index { get; set; }
        public string Name { get; set; } = "";
        public float[] Center { get; set; } = new float[3];   // SSX mesh space - the reset volume box
        // A reset zone is a flat PANEL the rider crosses, not a cube of space (432 of the 433 shipped ones are
        // flat to within 10 cm). Center/Rotation place a slab fitted to that panel; without the rotation the
        // only honest shape is the panel's world AABB, which is 77x the volume and resets a rider who merely
        // passes BESIDE the panel. Absent on bundles written before this, which read as identity.
        public float[] Rotation { get; set; } = new[] { 0f, 0f, 0f, 1f };
        public float[] Size { get; set; } = new float[3];
        // A VISIBLE host with its own collision proxy - MERQUER's ParlamentBuilding, its ConcreteWalls - carries the
        // reset on that collision, exactly as an animated door does: the engine hangs MainType-13 off the prop's
        // collision slot, so it is contact-driven. Filling such a building's bounds with a trigger resets a rider
        // riding THROUGH it (the Parlament has a tunnel), which is the same failure the animated-door divert exists
        // to prevent. The importer keeps the "_R" contact tag on the prop and emits no box for these.
        public bool ContactOnly { get; set; }
    }

    // ---- boost volumes (Unity docs/053): the MainType-0 BOOST FAMILY -----------------------------------------
    // Four sub-types share one mechanism - speed along an axis approaching a target as a first-order lag, add-only -
    // and differ only in what surrounds it ([Trailmap: 360-node-apply]). One record carries all four; `Kind` says
    // which fields past the shared triple are meaningful.
    public sealed class BoostVolumesInfo { public List<BoostVolumeInfo> Volumes { get; set; } = new(); }
    public sealed class BoostVolumeInfo
    {
        public int Index { get; set; }
        public string Name { get; set; } = "";
        public float[] Center { get; set; } = new float[3];
        public float[] Size { get; set; } = new float[3];

        // "directional" (sub-7), "vertical-lift" (sub-18), "lap-gated" (sub-15), "tube-end" (sub-24).
        public string Kind { get; set; } = "directional";

        // The shared triple. Dir is the authored push AXIS in mesh space - WORLD space in the engine, which never
        // turns it by the host's transform, so the importer must not either. Amount is the target speed the rider is
        // driven toward, in m/s as authored. Rate is the lag's 1/time-constant, and is the real tuning knob.
        public float[] Dir { get; set; } = new float[3];
        public float Amount { get; set; }
        public float Rate { get; set; }

        // sub-7/24 lifetime, and the two words are one rule: Mode decides what the countdown MEANS.
        // 0 = a cooldown that SUPPRESSES the push while it runs; 1 = an active window (the whole retail
        // corpus, 45 of 45); >=2 = never seeded, so the node retires on its first tick and is inert.
        public int Mode { get; set; } = 1;
        public float Seconds { get; set; }                    // how long the countdown runs, in seconds

        // "vertical-lift" only: the world altitude the elevator carries riders to (mesh-space Z), and the gap under
        // which it places the rider there outright. Zero tolerance never snaps and eases all the way in.
        public float TargetZ { get; set; }
        public float SnapTolerance { get; set; }

        // "lap-gated" only: the host's local +X in mesh space (the stage test reads which side of the box centre the
        // rider is on) and the height above the volume's own floor a rider must clear for a stage above 0.
        public float[] Axis { get; set; } = new float[3];
        public float StageFloorOffset { get; set; }

        // "tube-end" only: the three launch stages the recorded stage picks between.
        public List<BoostStageInfo> Stages { get; set; } = new();
    }
    public sealed class BoostStageInfo
    {
        public float[] Dir { get; set; } = new float[3];      // launch direction (unit, mesh space)
        public float Speed { get; set; }                      // speed authored against that direction (m/s)
    }

    // ---- spline movers (Unity docs/053): the MainType-2/SubType-1 spline-path animation (a subway train) ----
    public sealed class SplineMoversInfo { public List<SplineMoverInfo> Movers { get; set; } = new(); }
    public sealed class SplineMoverInfo
    {
        public int Index { get; set; }                        // the moving prop's Instances.json index
        public string Name { get; set; } = "";
        public float Speed { get; set; }                      // AnimationSpeed (metres/second)
        public int Count { get; set; }                        // InstanceCount (copies spaced along the path)
        public float[] Tint { get; set; } = new float[3];
        public float[][] Path { get; set; } = System.Array.Empty<float[]>();   // sampled path points (SSX mesh space)
        // The template's authored instance rotation, mesh-space quaternion [x,y,z,w] - baked into its diverted mesh
        // like any other prop's. The specified mover builds the moving prop's matrix from the SPLINE ALONE and never
        // reads this [Trailmap: 230-level-ssf], so the importer un-bakes it before aiming the model down-track.
        public float[] Rotation { get; set; } = { 0f, 0f, 0f, 1f };
        // The pose payload [Trailmap: 230-level-ssf]. The engine yaws the model by
        // (YawOffset + pi/2) - the tangent's compass angle: the offset is what picks WHICH model axis leads down the
        // track (0 = +Y, ~pi = -Y ... the subway's 1.62 rad puts its long -X axis on the rails), not a mere trim.
        public float YawOffset { get; set; }                  // radians
        public int OrientMode { get; set; }                   // 0 = yaw+pitch, 1 = yaw/level, 2 = fixed yaw+pitch, 3 = fixed; other values alias 0
        public int EndMode { get; set; } = 1;                 // 0 = finish/destroy mover, 1 = wrap, 2 = ping-pong, 3 = hold alive at end
        // The engine also draws the SPLINE ITSELF as a line when the payload says so - that line IS a chairlift's
        // running cable, and nothing else in the level draws one (the Mdl_SupportWire_* props are short struts
        // elsewhere). It's a 1-pixel screen-space line, so it has no authored thickness; colour + alpha are the only
        // specified constants [Trailmap: 230-level-ssf].
        public bool Cable { get; set; }
        public float[] CableColor { get; set; } = { 0f, 0f, 0f, 0f };   // RGB + alpha, 0..1
    }

    // ---- teleports: the MainType-24 "warp to a named instance" portal pairs (spec 390-teleport) ----------
    // A collision trigger whose CollisionEffectSlot header carries a MainType-24 node warps the rider to near the
    // payload's TeleportInstanceIndex instance. We bake the START volume's box (the invisible Mdl_TeleportStart) +
    // the resolved DESTINATION instance's pivot (the visible Mdl_TeleportExit marker, which stays merged) + any
    // entry-cue SoundPlay on the same header. The importer overlays an invisible trigger + a destination anchor and
    // wires Teleport (walking player -> LocalPlayer.TeleportTo; a board rider -> board.RespawnAt). A level may author
    // one pair (Mdl_TeleportStart_0 -> Mdl_TeleportExit_0, cue 122); most levels author none.
    public sealed class TeleportsInfo
    {
        public List<TeleportInfo> Teleports { get; set; } = new();
    }
    public sealed class TeleportInfo
    {
        public int Index { get; set; }                    // start-volume Instances.json index
        public string Name { get; set; } = "";
        public int Slot { get; set; } = -1;               // EffectSlotIndex the start volume carried
        public float[] Center { get; set; } = new float[3];   // SSX mesh space (X negated, cm) - start trigger box centre
        public float[] Size { get; set; } = new float[3];     // start trigger box extents (importer inflates for a reliable cross)
        public int Target { get; set; } = -1;             // destination Instances.json index (the resolved exit)
        public string TargetName { get; set; } = "";
        public float[] Dest { get; set; } = new float[3];     // SSX mesh space (X negated, cm) - exit instance pivot = landing spot
        public int Sound { get; set; } = -1;              // entry cue: MainType-8 SoundPlay id on the same header, course-bank-local (-1 = none)
    }

    // ---- debug HUD messages: MainType-12 text fired by a collision effect ------------------------------
    // This is intentionally an optional bundle section: retail maps normally author none, while autotest maps
    // can add one to every cell. A platform renders it locally for the crossing rider; it is diagnostic state,
    // never a networked world event. The lifetime matches the patched native in-race HUD (2.5 seconds).
    public sealed class HudMessagesInfo
    {
        public List<HudMessageInfo> Messages { get; set; } = new();
    }
    public sealed class HudMessageInfo
    {
        public int Index { get; set; }                    // owning trigger instance
        public string Name { get; set; } = "";
        public int Slot { get; set; } = -1;
        public string Text { get; set; } = "";
        public float[] Color { get; set; } = { 1f, 1f, 1f };
        public float Duration { get; set; } = 2.5f;
        public float Delay { get; set; }                  // sum of preceding MainType-4 waits in this header
        public float[] Center { get; set; } = new float[3];
        public float[] Size { get; set; } = new float[3];
    }

    // ---- continuous emitters: the always-on SSF particle emitters authored on a VISIBLE instance ----------
    // Unlike the fireworks (TRIGGERED via a collision slot), these run permanently: a visible instance's
    // EffectSlotIndex -> EffectSlots[slot].PersistantEffectSlot header carries one or more MainType-2/SubType-0
    // emitter nodes. This is e.g. snow cannons (Mdl_SnowBlower_Top, 2 layers each = the blown-snow
    // plume) plus flares + stone lanterns (1 flame/glow layer each). We bake each emitter's muzzle +
    // barrel (its prop geometry, like a firework canister) and per-layer authored params; the importer builds one
    // looping ParticleSystem per layer aimed up the barrel. Data-derived: a big fast snow jet and a small rising
    // flare self-scale from their own authored size/speed/gravity. See [Trailmap: 180-particles-data].
    public sealed class EmittersInfo
    {
        public List<EmitterInfo> Emitters { get; set; } = new();
    }
    public sealed class EmitterInfo
    {
        public int Index { get; set; }                        // Instances.json index
        public string Name { get; set; } = "";
        public float[] Muzzle { get; set; } = new float[3];   // SSX mesh space: emit origin (barrel muzzle), from the prop geometry
        public float[] Barrel { get; set; } = new float[3];   // SSX mesh space dir: emit aim (prop long axis, oriented world-up)
        public float Radius { get; set; }                     // half the prop's long-axis extent (SSX units); importer centers+sizes the flare glow halo (0 = no geometry)
        public int GlowRes { get; set; }                      // the co-located light's spriteRes (glow-sprite resolution: e.g. 16/32 or 256/512; low = diffuse). Importer maps it to the halo's edge softness. 0 = none
        public List<EmitterLayerInfo> Layers { get; set; } = new();
        // Normalized RGB (peak 1) of the co-located Type-2 decorative light (e.g. a SD_pt_*flare / caldronlight),
        // or null. The engine bakes that light into the scene lighting so it never reaches a sprite; we surface it here
        // so the importer can colour this emitter's plume + add a glow billboard. Snow cannons have no nearby Type-2
        // light -> null (stay white). [Trailmap: 160-flare-lights]
        public float[]? Tint { get; set; }
    }
    public sealed class EmitterLayerInfo
    {
        public int ParticleCount { get; set; }                    // U0 logical particle heads
        public int TrailCopies { get; set; }                      // U1 tapered billboard copies per particle
        public float EmissionWindow { get; set; }                 // U2 start-time window; negative = persistent stream
        public float TimeScale { get; set; }                      // U3 internal trajectory/age scale
        public float SizeCenter { get; set; }                     // U4 sprite-size range centre (SSX units)
        public float ParticleLifeCenter { get; set; }             // U5 per-particle life range centre (seconds)
        public float SizeSpan { get; set; }                       // U6 full sprite-size range span (SSX units)
        public float ParticleLifeSpan { get; set; }               // U7 full per-particle life range span (seconds)
        public float TrailSpacing { get; set; }                   // U8 time offset between trail copies (seconds)
        // Extraction applies the owning instance pose here. Origin is a root-local mesh-space point; every axis,
        // velocity and gravity value is a root-local mesh-space vector. Consumers can evaluate P6 directly under
        // the level root without reconstructing an Instances.json transform.
        public float[] Origin { get; set; } = new float[3];
        public float[] SpawnAxisA { get; set; } = new float[3];
        public float[] SpawnAxisB { get; set; } = new float[3];
        public float[] VelocityBase { get; set; } = new float[3];
        public float[] VelocityAxisA { get; set; } = new float[3];
        public float[] VelocityAxisB { get; set; } = new float[3];
        public float[] VelocityAxisC { get; set; } = new float[3];
        public float[] Gravity { get; set; } = new float[3];
        public float[][] ColorStops { get; set; } = System.Array.Empty<float[]>(); // semantic [R,G,B,A]; native ARGB never crosses this boundary
        public int SpriteIndex { get; set; }                      // U49 index into PARTICLE.SSH
        public int BlendMode { get; set; } = 5;                   // U50 remapped GS blend: 5 additive, 3 alpha, 4 darken
    }

    // ---- ambient emitters: COLLISION-triggered particle bursts with NO report sound (dust/spark/fire/water/snow) ----
    // Distinct from fireworks (those carry a MainType-8 report on the emitter sub-effect) and from continuous
    // emitters (those sit on a PersistantEffectSlot). They fire once - or, for fire hydrants and dedicated
    // Type2Sub2 CollideEmitters, repeatably - when the rider enters the trigger volume. Reuses EmitterLayerInfo
    // for the common Type2Sub0/Type2Sub2 P6 law. See Unity docs/052.
    // ---- lamp-light glow sprites: the authored halo of every glowing course lamp ------------------------
    // A type-1 (point) light with a glow-sprite resolution and a positive colour is a LAMP: e.g. the
    // SD_sp_lamp lights sit at the floodlight-pole HEADS (median 2.7 m from the head once the ~36 m pole
    // height is added to the base pivot) carrying an intensity-scaled warm hue and spriteRes 32. The light
    // table itself only bakes ([Trailmap: 160-lighting-data]), so the importer draws the authored halo as a
    // camera-facing billboard at the light's own position. Negative-colour records (some levels' baked
    // shadow-darkening entries) carry spriteRes too and are excluded - a halo is light, not shadow.
    public sealed class LightGlowsInfo
    {
        public List<LightGlowInfo> Glows { get; set; } = new();
    }
    public sealed class LightGlowInfo
    {
        public string Name { get; set; } = "";              // light record name (diagnostic; no logic keys on it)
        public float[] Pos { get; set; } = new float[3];    // SSX mesh space (X negated, cm): the light's own position (the lamp head)
        public float[] Hue { get; set; } = new float[3];    // colour normalized to peak 1 (pure hue)
        public float Intensity { get; set; }                // colour max-channel before normalizing (percent scale; >100 = overbright)
        public int SpriteRes { get; set; }                  // authored glow-sprite resolution (32 here; low = diffuse) -> halo softness
    }

    public sealed class AmbientEmittersInfo
    {
        public List<AmbientEmitterInfo> Emitters { get; set; } = new();
    }
    public sealed class AmbientEmitterInfo
    {
        public int Index { get; set; }                          // emit instance (marker or prop) Instances.json index
        public string Name { get; set; } = "";
        public float[] Muzzle { get; set; } = new float[3];     // SSX mesh space: emit origin
        public float[] Barrel { get; set; } = new float[3];     // SSX mesh space dir: emit aim (default world-up)
        public float[] TriggerCenter { get; set; } = new float[3]; // activation volume centre (the trigger / prop bounds)
        public float[] TriggerSize { get; set; } = new float[3];   // activation volume size
        public bool Repeatable { get; set; }                    // hydrants and CollideEmitters re-fire; markers/highway use a long guard
        public float MinInterval { get; set; }                  // repeatable debounce seconds (0 = importer one-shot guard)
        // Dedicated MainType-2/SubType-2: origin and base-velocity direction come from the live contact frame.
        [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
        public bool ContactDriven { get; set; }
        public List<int>? RollerTargets { get; set; }           // instance indices of Roller pop-off props (fire-hydrant TopLids) this trigger pops (Unity docs/052)
        public List<EmitterLayerInfo> Layers { get; set; } = new();
    }

    // ---- props: the DIVERTED instances pulled out of the merged props.glb "Props" node ----
    // The gems/physics-bodies/breakable-logos that need their own GameObject + Udon engine-side. snowknife
    // classifies each ONCE here and bakes each one's geometry into its own props.glb node; the importer
    // reads this list and wires the engine behaviour from it, without parsing Props.obj or re-classifying.
    // See docs/034.
    public sealed class PropsInfo
    {
        public List<DivertInfo> Diverted { get; set; } = new();
        public List<AnimPropInfo>? Animated { get; set; }   // props a persistent SSF AnimObject animates
        public List<LocatorInfo>? Locators { get; set; }    // pose-only anchors for named props (e.g. the start gate); the prop stays merged
    }

    // A pose-only anchor for a named prop (the start gate) - position + rotation, no geometry. The prop itself
    // stays in the merged Props mesh; the importer just drops an empty at this pose for the post row to align to.
    public sealed class LocatorInfo
    {
        public string Key { get; set; } = "";                      // match key (e.g. "Mdl_StartGate")
        public float[] Center { get; set; } = new float[3];        // SSX mesh-space instance pivot
        public float[] Rotation { get; set; } = { 0f, 0f, 0f, 1f }; // mesh-space instance quaternion [x,y,z,w]
    }

    // ---- animated props: the model-clip players (a swinging bridge) -------------------------------
    // A persistent SSF AnimObject (type0 Sub256) plays the model's own object-hierarchy clip: per segment a
    // rest pose + piecewise-cubic channels evaluated at absolute clip time. The visible mesh and its invisible
    // collision twin are separate instances driven by identical clips (one record each). Geometry is
    // MODEL-LOCAL in props.glb (pivots at the model origin); the importer builds the GameObject chain at
    // Center/Rotation and a runtime sampler drives the segment poses. Mirroring (X negation) is baked into
    // the curves/poses here. See Unity docs/038, [Trailmap: 370-world-interaction].
    public sealed class AnimPropInfo
    {
        public int Index { get; set; }                       // Instances.json index
        public string Name { get; set; } = "";
        public string Model { get; set; } = "";
        public bool Visible { get; set; }                    // false = the collision twin (position-only segments)
        public float[] Center { get; set; } = new float[3];  // SSX mesh-space instance pivot
        public float[] Rotation { get; set; } = { 0f, 0f, 0f, 1f }; // mesh-space instance quaternion [x,y,z,w]
        public int SurfaceType { get; set; } = -1;           // ride audio class (12 = WOOD)
        public int CollisonSound { get; set; } = -1;         // one-shot impact id
        public string? SoundClip { get; set; }                // explicit map-relative WAV from Audio/SoundIndex.json
        public bool PlayerCollision { get; set; }
        public float Bounce { get; set; }
        public float ClipLength { get; set; }                // seconds (model AnimTime / 30)
        public int LoopMode { get; set; }                    // Sub256 U0: 1 wrap | 2 ping-pong | else once
        public float Rate { get; set; } = 1f;                // clip seconds per real second (Sub256 U3 / 30)
        public bool Reverse { get; set; }                    // Sub256 U7 == 4
        public bool Triggered { get; set; }                  // true = starts at rest, plays its clip once on contact (e.g. the iris door)
        // The ROLL phase of a breakable cluster (Unity docs/036 - the city globe sign): the breakable DivertInfo with the
        // same Index owns triggering + reset, so this record carries NO trigger volumes, NO colliders and NO
        // auto-reset - the importer wires the breakable behaviour to Trigger()/reset it.
        public bool BreakOwned { get; set; }
        // AnimCombo (Sub258): the idle window above free-runs, and a SECOND window of the same clip plays over
        // the top of it on control command 3 - composed onto the pose the prop was holding, so the Aloha barrier
        // falls over WHERE IT STANDS rather than snapping to the middle of its slide first.
        public bool Combo { get; set; }
        public float ComboStart { get; set; }                // seconds (U8/30; U8 < 0 = the idle window's end)
        public float ComboEnd { get; set; }                  // seconds (U9/30; U9 < 0 = the whole clip)
        public float ComboRate { get; set; } = 1f;           // clip seconds per real second (U10/30)
        public int ComboEndMode { get; set; }                // sign(U11): 0 resume the idle | 1 freeze | -1 hold the combo pose
        public float PhaseOffset { get; set; }               // seconds added to the idle clock (combo U6 random start)
        public bool DeltaGated { get; set; }                 // AnimDelta (Sub257): clip advances only while poke budget > 0; starts frozen (the kickers)
        public bool SelfPulse { get; set; }                  // its persistent header AddDeltas itself: one poke per region activation (the centre kicker)
        public float PokeSeconds { get; set; }               // clip-seconds granted per poke (AddDelta U1/30; 1.0 = one half-swing of the 2s ping-pong)
        public List<AnimTriggerBox>? Triggers { get; set; }  // the trigger volumes that fire it: play-once (Triggered) or poke budget (DeltaGated); null = persistent free-run
        public float[] Ambient { get; set; } = new float[3]; // exact /256 ambient record
        public float[] Key1 { get; set; } = new float[3];
        public float[] Key2 { get; set; } = new float[3];
        public float[] Key3 { get; set; } = new float[3];
        // Placed bundle-mesh directions (X mirrored, Z up). Unity maps these once to fixed world directions;
        // animated segment normals then turn beneath them instead of dragging the light with the object.
        public float[] Direction1 { get; set; } = new float[3];
        public float[] Direction2 { get; set; } = new float[3];
        public float[] Direction3 { get; set; } = new float[3];
        public List<AnimSegInfo> Segments { get; set; } = new();   // one per ModelObject, in model order
    }
    // One trigger volume box for a triggered animated prop (e.g. an iristrigger volume), in UNSCALED SSX mesh
    // space - the importer makes a BoxCollider(isTrigger) at Center/Rotation with this Size.
    public sealed class AnimTriggerBox
    {
        public float[] Center { get; set; } = new float[3];
        public float[] Size { get; set; } = new float[3];
        public float[] Rotation { get; set; } = { 0f, 0f, 0f, 1f };
        // The volume INSTANCE's own `Sounds.CollisonSound` ADL event id (-1 = authored-silent). Crossing a
        // volume is a collision event, so retail plays this alongside the chain the header fires - the megaplex
        // ride-over buttons are the shipped case (events 179/180/181/38, the musical button pings). SoundClip is
        // the optional staged WAV a canonical instance carries instead.
        public int CollisonSound { get; set; } = -1;
        public string? SoundClip { get; set; }
    }
    public sealed class AnimSegInfo
    {
        public string? Node { get; set; }                    // props.glb node ("Anim_{i}_o{k}"); null = hierarchy only
        public int Parent { get; set; } = -1;                // index into Segments (-1 = instance root)
        public float[] RestPos { get; set; } = new float[3]; // mesh-space model units (mirrored, scale baked)
        public float[] RestEuler { get; set; } = new float[3]; // degrees, mirrored
        // Exact static hierarchy rotation. RestEuler remains the mutable starting tuple for native animation
        // channels; a non-animated mount must instead retain its model quaternion without an Euler-order loss.
        public float[] RestRotation { get; set; } = { 0f, 0f, 0f, 1f };
        public float[] RestScale { get; set; } = { 1f, 1f, 1f }; // static object scale; animation never changes it
        public List<AnimCurveInfo>? Curves { get; set; }
    }
    // One pose-component channel: value(t) = ((a*t + b)*t + c)*t + d on the segment whose [t0,t1] window holds
    // t (absolute clip seconds; clamp to the nearest window outside). Seg layout: [a,b,c,d,t0,t1].
    public sealed class AnimCurveInfo
    {
        public int Target { get; set; }                      // 0-2 = translation x/y/z, 3-5 = rotation x/y/z (deg)
        public List<float[]> Segs { get; set; } = new();
    }
    public sealed class DivertInfo
    {
        public int Index { get; set; }                     // Instances.json index (also the "Divert_{Index}" glb node)
        // Mode-presence bitset: race=1, show-off=2, freeride=4. 7 is an ordinary prop present in every mode.
        public int ModeMask { get; set; } = 7;
        public string Kind { get; set; } = "";             // "spinner" | "physics" | "breakable"
        public string Node { get; set; } = "";             // props.glb node holding this instance's geometry (absolute, SSX mesh space)
        public string Model { get; set; } = "";            // model name (importer's GameObject name / gem multiplier)
        public string? Role { get; set; }                  // breakable only: "intact" | "broken" | "scanline"
        public string? ClusterKey { get; set; }            // breakable only: groups the intact/broken/scanline of one screen
        // Kind="physics" only: the breakable cluster this knock body's OWN collision chain also THROWS - a city
        // map's garbage cans / news boxes / mail boxes, whose hit topples the prop (the Roller below) AND spills a
        // hidden contents twin (an M7 hop to a type0 Sub20 mesh-throw). The pieces ship as ordinary breakable
        // records under this key; the importer fires them off the body's knock instead of a trigger of their own,
        // so a prop that is both a body and a throw source keeps both responses. Null = an ordinary knock body.
        public string? SpillCluster { get; set; }
        public float[] Center { get; set; } = new float[3];// SSX mesh-space pivot: importer recentres the node here (0 for breakable = stay absolute)
        // GPU-INSTANCED physics: when set, this record SHARES the geometry of Node (one model mesh drawn by many
        // instances) instead of owning a per-instance baked node. Rotation is the mesh-space quaternion [x,y,z,w] that
        // places this instance's copy relative to Node's reference orientation (identity for the reference itself);
        // the importer applies it as localRotation + pushes Ambient/Key per-instance via a MaterialPropertyBlock, so
        // one shared mesh renders every copy with its own lighting. Null = the plain per-instance baked path (Unity docs/012).
        public float[]? Rotation { get; set; }
        public float DynamicMass { get; set; }             // physics: Roller payload U0
        public float Bounce { get; set; }                  // physics: authored PlayerBounceAmmount (restitution)
        public int CollisonSound { get; set; } = -1;       // physics/breakable: impact-sound id (-1 = none)
        public string? SoundClip { get; set; }              // optional staged Sounds/*.wav
        public float[] Ambient { get; set; } = new float[3];// exact /256 ambient floor
        public float[] Key1 { get; set; } = new float[3];
        public float[] Key2 { get; set; } = new float[3];
        public float[] Key3 { get; set; } = new float[3];
        // Per-key TOWARD-light directions in placed bundle mesh space. These are the instance-local records
        // rotated through the authored placement; the runtime shader keeps them fixed while a mover turns.
        public float[] Direction1 { get; set; } = new float[3];
        public float[] Direction2 { get; set; } = new float[3];
        public float[] Direction3 { get; set; } = new float[3];
        public float[] Light { get; set; } = new float[3]; // flat combined colour (breakable + non-directional fallback)
        // Role="piece" only: the cluster's mesh-throw params [U0..U9] (SSF type0 Sub20; Unity docs/036, [Trailmap: 230-level-ssf]).
        // U1=frame step s, U2=duration s, U3-5=authored throw dir (all 0 = use the impact direction),
        // U6-8=per-axis velocity scale (SSX cm/s), U9=direction scale.
        public float[]? Throw { get; set; }
        // Role="intact" only: the [r,g,b] of the prop's "explode in stars" burst (a type2Sub0 emitter in its
        // collision effect; e.g. balloon animals). Null = an ordinary shard breakable. The importer
        // turns this into a tinted additive STAR burst instead of texture-fragment shards (Unity docs/036).
        public float[]? BurstColor { get; set; }
        // Role="intact" only. BreakSound: the break chain's MainType-8 RAW course-bank slot - the smash's own
        // sound (the glass panes' 64, the sewer walls' 43, the globe's landing crash), played at the break; -1 =
        // the chain plays nothing. BreakDelay: ROLL-AWAY breakables only (Unity docs/036 - the city globe sign), the
        // authored SEQUENCED break: on hit the intact plays its own model clip (the Props.Animated BreakOwned
        // record with the same Index - the roll down the street) for BreakDelay seconds (the chain's MainType-4
        // Wait), THEN the hide/reveal/throw runs. 0 = the instant break every other cluster uses.
        public float BreakDelay { get; set; }
        public int BreakSound { get; set; } = -1;
        // Role="intact" only, and only for a FRAGILE-SURFACE breakable (Unity docs/036 §Cracked glass - the megaplex
        // panes). A positive CrackStrength says this prop is not broken by the contact that hits it: it holds an
        // impact-budget pool that contacts drain (SSF type0 Sub14), and the break runs when the pool crosses
        // zero. CrackSound is the glancing-hit CRACK's raw course-bank slot (65), a separate event from
        // BreakSound's smash (64). CrackLifetime is the crack's own lifetime in seconds; -1 (every retail pane)
        // never expires, a positive one retires the crack and HEALS the surface. 0 = an ordinary instant break.
        public float CrackStrength { get; set; }
        public float CrackLifetime { get; set; }
        public int CrackSound { get; set; } = -1;
        // Kind="spinner" (trick gems) only: the pickup's own MainType-2 emitters, sitting inline on the same
        // collision header as the MainType-14 MultiplierScore node (2 authored layers per gem). Baked into
        // root-local mesh space like the boost pads' and the launchers', so the importer renders the gem's real
        // collect flash through the shared P6 path instead of a hand-rolled additive burst. Null = no authored
        // emitters (the importer then falls back to a synthesized layer from the GemSparkle* knobs).
        public List<EmitterLayerInfo>? Layers { get; set; }
        // Kind="button" (the ride-over buttons) only: the volumes whose crossing PULSES this instance's material.
        // Retail plays the flip on ONE button per chain, so each record pulses alone even where a whole line of
        // buttons opens the same pillars. The prop that line opens is an ordinary triggered Props.Animated record
        // fired by its own volumes - the colour and the prop are siblings under one crossing, not cause and effect.
        public List<AnimTriggerBox>? Triggers { get; set; }
        // Kind="button" only: what a crossing SHOWS, already replayed from the engine's finite flip node - the
        // material's flipbook frame index per segment, and how long each holds. The surface returns to its own
        // static frame when the list runs out (the authored advance count is odd, so the last segment already IS
        // that frame - which is what makes the node's death invisible in the original).
        public List<int>? PulseFrames { get; set; }
        public List<float>? PulseHolds { get; set; }
    }

    public sealed class PathsInfo
    {
        public PolyInfo? Rails { get; set; }    // grind rails
        public PolyInfo? Course { get; set; }   // out-of-bounds course lines
    }

    // ---- rail toggles: SSX MainType-25 gates that make a rail grindable at runtime (spec 350-rails) --------
    // A collision trigger whose effect carries a MainType-25 node (Spline.Effect != 0) promotes a spline to a rail
    // candidate when it fires. We bake the trigger volume box + which rail-network indices it enables; those rails
    // ship in Paths.Rails but start disabled (Rails.Gated), and the importer overlays an invisible trigger carrying
    // RailGate that turns them on when the rider crosses. A sibling of the teleport; a level may author such a
    // pair (e.g. a fallen-tree trunk, enabled by the same trigger that fells the tree).
    public sealed class RailGatesInfo
    {
        public List<RailGateInfo> Gates { get; set; } = new();
    }
    public sealed class RailGateInfo
    {
        public int Index { get; set; }                    // the trigger volume's Instances.json index
        public string Name { get; set; } = "";
        public float[] Center { get; set; } = new float[3];   // SSX mesh space (X negated, cm) - trigger box centre
        public float[] Size { get; set; } = new float[3];     // trigger box extents (importer inflates for a reliable cross)
        public int[] Rails { get; set; } = System.Array.Empty<int>();   // rail-network indices this gate enables (into Paths.Rails)
    }
    public sealed class PolyInfo
    {
        public List<float[]> Points { get; set; } = new();  // SSX mesh space (X negated) - root-local for RailNetwork
        public List<int> Start { get; set; } = new();        // per-polyline start index
        public List<int> Count { get; set; } = new();        // per-polyline point count
        // Rails only: the source SplineStyle for each emitted rail, parallel to Start/Count. The rail style is also
        // the surface row the engine installs while grinding (5 ice, 12 wood, 13 metal). Null on course paths and on
        // bundles written before this optional v3 field was added; consumers fall back to the legacy metal rail row.
        public List<int>? Style { get; set; }
        public CubicInfo? Cubic { get; set; }                // rails only: the source cubic bezier (null for the course polyline)
        // Course only (null on rails): the game's authored DistanceToFinish per RACE line (engine units), and how many
        // of the LEADING polylines are race lines (the rest are AI/respawn paths). Drives the course-progress metric.
        public List<float>? LineDtf { get; set; }
        public int RaceLineCount { get; set; }
        // Course only: positive SOP race-line type-11 events. Position is the point at EventStart in SSX mesh
        // space; Dtf is DistanceToFinish-EventStart. Alternate-path copies share Group, so a runtime selects the
        // nearest route's payload and awards one logical checkpoint rather than stacking every copy.
        public List<CourseCheckpointInfo> Checkpoints { get; set; } = new();
        // Course only: the level's finish ARCH - the union AABB of its Mdl_FinnishGate_* instances (crossbar + posts,
        // the game's spelling) near the DTF=0 crossing, in SSX mesh space. The arch straddles the finish plane, so its
        // width + height size the finish trigger without a hand-tuned per-course box. Null = no arch on this course.
        public BoxInfo? FinishArch { get; set; }
        // Rails only: rail-network indices that start NOT grindable and are turned on at runtime by an RailGate
        // (the SSX MainType-25 rail toggle - e.g. fallen-tree rails, off until the tree topples). Empty otherwise.
        public List<int> Gated { get; set; } = new();
        // Rails only: rail-network indices of the SHOW-OFF-mode rails (the ones a level's HideShowOff function turns
        // off in free-ride/race mode; Unity docs/026). They remain baked so the runtime mode selector can toggle them;
        // ImportConfig.GateShowoffRails controls only their initial editor/default preview state. Empty otherwise.
        public List<int> Showoff { get; set; } = new();
    }
    public sealed class CourseCheckpointInfo
    {
        public float[] Position { get; set; } = new float[3];
        public float Dtf { get; set; }
        public int BonusSeconds { get; set; }
        public int Group { get; set; }
    }

    // The rails' SOURCE cubic bezier segments, kept ALONGSIDE the sampled polyline so the runtime can ride the
    // analytic curve (closest point + exact tangent P'(t)) instead of the sampled chords - matching the PS2
    // engine, which evaluates the real cubic [Trailmap: 350-rails].
    // Points was sampled at SamplesPerSegment steps/segment + 1 final endpoint, so a polyline chord at rail-local
    // index li maps to cubic segment (li / SamplesPerSegment) with t in [(li%S)/S, (li%S+1)/S].
    public sealed class CubicInfo
    {
        public int SamplesPerSegment { get; set; }                  // how Points was sampled (chord -> segment+t mapping)
        public List<float[]> ControlPoints { get; set; } = new();   // 4 per segment, root-local (-x,y,z); segment g = [g*4 .. g*4+4)
        public List<int> SegStart { get; set; } = new();            // per-rail first segment index into ControlPoints/4
        public List<int> SegCount { get; set; } = new();            // per-rail segment count
    }

    public sealed class CollisionInfo
    {
        public List<BucketInfo> Buckets { get; set; } = new();      // prop proxy colliders (collision.glb nodes)
        public List<BoxInfo> ComputedBounds { get; set; } = new();  // collidable props with no proxy mesh
        public List<BodyInfo> Bodies { get; set; } = new();         // doorway props: boxes from the decoded mode-3 body
        public List<BoxInfo> Foliage { get; set; } = new();         // native pass-through leaf swish trigger boxes
        public List<BoxInfo> ContactSounds { get; set; } = new();    // general ride-through authored hit-sound triggers
    }
    public sealed class BucketInfo
    {
        public string Node { get; set; } = "";   // collision.glb node name
        public int ModeMask { get; set; } = 7;   // race=1, show-off=2, freeride=4
        public bool PlayerBounce { get; set; }
        public float PlayerBounceAmmount { get; set; }
        public int InstanceCount { get; set; }
        public int CollisonSound { get; set; } = -1;
        public int SurfaceType { get; set; } = -1;
        public string? SoundClip { get; set; }
        // The breakable cluster this bucket's collider belongs to (Unity docs/036 §Cracked glass), or null for the
        // ordinary shared buckets. A cracked pane's SUPPORT twin is the invisible solid slab that holds the rider
        // up until the glass gives way, so it is the one collider a break has to take AWAY - which a bucket shared
        // with the rest of the level cannot do. Set here, this bucket carries exactly one instance, and the
        // importer hands its collider to that cluster's breakable to disable on the break and re-enable on the
        // respawn.
        public string? BreakCluster { get; set; }
        // Hitting this bucket resets the rider (a MainType-13 that rides on the prop's own collision). The Node name
        // carries the same fact as an "_R" tail, which is what the board actually reads off the collider it hit.
        public bool ResetOnContact { get; set; }
    }
    public sealed class BoxInfo
    {
        public string Name { get; set; } = "";
        public int ModeMask { get; set; } = 7;   // presence of this instance's render + contact shape
        public float[] Center { get; set; } = new float[3];  // SSX mesh space (X negated, cm) - placed under the Level child
        // The collider is the MODEL's own box turned with the placement, not a world AABB (spec 130-mode2-oriented):
        // Center/Rotation position the holder, LocalCenter/Size are the box inside it. A bundle written before this
        // was understood carries neither, and identity + zero reproduces its old axis-aligned behaviour exactly.
        public float[] Rotation { get; set; } = new[] { 0f, 0f, 0f, 1f };
        public float[] LocalCenter { get; set; } = new float[3];
        public float[] Size { get; set; } = new float[3];
        public bool PlayerBounce { get; set; }
        public float PlayerBounceAmmount { get; set; }
        public int SurfaceType { get; set; } = -1;
        public int CollisonSound { get; set; } = -1;
        public string? SoundClip { get; set; }
    }
    // A "doorway" prop instance (gate arch, cave scaffold, waterfall, crowd stand): the engine's decoded
    // mode-3 occupancy body greedily merged into a few body-local boxes, so its opening stays open instead
    // of being filled by one visual AABB. Derived entirely from the game data - see Unity docs/037.
    public sealed class BodyInfo
    {
        public string Name { get; set; } = "";
        public int ModeMask { get; set; } = 7;
        public int InstanceIndex { get; set; } = -1;
        public int PhysicsIndex { get; set; } = -1;
        public float[] Center { get; set; } = new float[3];    // SSX mesh space (X negated, cm) - instance pivot under the Level child
        public float[] Rotation { get; set; } = { 0f, 0f, 0f, 1f }; // mesh-space instance quaternion [x,y,z,w]
        public int CollisonSound { get; set; } = -1;
        public string? SoundClip { get; set; }
        public List<BodyBox> Boxes { get; set; } = new();      // body-local (rotates with the instance), X already mirrored
        public List<BodyCapsule> Capsules { get; set; } = new(); // sparse bodies: sphere-swept segments from the same tree
    }
    public sealed class BodyBox
    {
        public float[] Center { get; set; } = new float[3];    // body-local cm (instance scale baked in)
        public float[] Size { get; set; } = new float[3];
    }
    // A sphere-swept segment from the decoded occupancy tree (body-local cm, X mirrored, instance scale
    // baked in) - the rounded surface the engine's own leaf-sphere contact presented. A == B is a sphere.
    public sealed class BodyCapsule
    {
        public float[] A { get; set; } = new float[3];
        public float[] B { get; set; } = new float[3];
        public float Radius { get; set; }
    }

    public sealed class TextureInfo
    {
        public string File { get; set; } = "";       // in the level's Textures/
        public string Alpha { get; set; } = "opaque"; // "opaque" | "cutout" | "blend" | "glow" (soft light-halo sheet)
        public bool? Sheet { get; set; }              // blend only: every submesh drawing it is single-facing, so
                                                      // the consumer draws it without depth write (TextureBundle)
    }

    // ---- materials: resolved per-slot material facts, consumed by the importer's MaterialFactory ----
    public sealed class MaterialInfo
    {
        public string Name { get; set; } = "";        // the glb prim's material-slot name (the key)
        public string? Texture { get; set; }          // frame-0 texture file in Textures/ (null = untextured)
        public string Alpha { get; set; } = "opaque"; // resolved per-material: "opaque" | "cutout" | "blend" | "glow"
        public List<string>? Flipbook { get; set; }   // ordered frame files (>=2) or null. A frame list is a STATE
                                                      // list; what animates it is an effect - see FlipFps. A record
                                                      // with frames and no rate renders Texture and waits on logic.
        public float FlipFps { get; set; }            // free-running playback fps (0 if the frames are not animated)
        public bool? Crowd { get; set; }              // true = the shared CrowdBox slot: Flipbook lists the cd
                                                      // frames, but playback is the shader's per-cell schedule
                                                      // (not a runtime flipbook - FlipFps stays 0). null otherwise.
        public float[]? Dwell { get; set; }           // TextureFlip U4 pause screens: [dwellBaseSeconds, flashSeconds];
                                                      // hold frame A dwellBase/u sec (u ~ uniform[0.25,1) per cycle),
                                                      // flash frame B flashSeconds. null = uniform FlipFps playback.
        public float[]? Scroll { get; set; }          // [u,v] scroll speed in units/sec (V already negated) or null
        public float[]? ScrollCycle { get; set; }     // [mode,activeSeconds,pauseSeconds,lifetimeSeconds]; required
                                                      // whenever Scroll is present, null for non-scrolled materials
    }

    public sealed class SpaceInfo
    {
        // glb files are standard Y-up, right-handed, metres. The importer returns to SSX mesh space
        // (X-negated, Z-up, centimetres) with a Y/Z swap * (1/Scale) and drops meshes under a
        // Level node carrying RootEuler + Scale, matching the rest of the scene's world layout.
        public float Scale { get; set; } = 0.01f;
        public float[] RootEuler { get; set; } = { 270f, 0f, 0f };
        public string Up { get; set; } = "Y";
        public string Handed { get; set; } = "right";
        public string Units { get; set; } = "metre";
    }

    public sealed class RecenterInfo
    {
        public bool ToOrigin { get; set; } = true;
        public float[] AxisMask { get; set; } = { 1f, 1f, 1f };
    }

    public sealed class MeshRef
    {
        public string File { get; set; } = "";   // relative to the bundle folder
        public string Kind { get; set; } = "";   // "terrain", "props", "collision", ...
    }

    public sealed class LightmapInfo
    {
        public string Atlas { get; set; } = "LightmapAtlas.png";          // exact: C_S in rgb, A_S in alpha; engine reconstructs (C_D-C_S)*A_S
        public string? MultiplyAtlas { get; set; }                        // standard colored multiply lightmap (albedo x this), for interchange
        public int Size { get; set; } = 512;
        public int MapsFound { get; set; }
        public int UvMode { get; set; }
    }

    static readonly JsonSerializerOptions Opts = new()
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    internal void Save(string path, ContractValidationService contracts)
    {
        string json = JsonSerializer.Serialize(this, Opts);
        contracts.RequireJson(json, ContractKind.BundleManifestV3, path);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        File.WriteAllText(path, json);
    }
}
