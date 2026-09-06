#if UNITY_EDITOR
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Unity-side reader for the snowknife gltf/manifest.json. One place that knows the bundle layout, so the
    // importer consumes snowknife's derived data (coordinate scale, per-texture alpha mode, lightmap, collision
    // buckets, rails/course polylines, particle/firework/audio/probe placement) instead of recomputing it. The
    // importer REQUIRES the bundle - LevelImporter fails the import up front if it's absent (Exists==false),
    // so the builders here just consume it; there is no recompute-it-here fallback.
    //
    // The per-section shapes are DESERIALIZED with Newtonsoft (token.ToObject<T>) using the annotated classes
    // below plus a Vector3/Color converter (the manifest stores vectors/colours as JSON [x,y,z] arrays).
    // Section presence/flags + the keyed dictionaries (TextureAlpha/Materials) stay explicit.
    public class BundleManifestReader
    {
        const int BundleVersion = 3;
        public bool Exists { get; private set; }
        public float Scale { get; private set; } = 0.01f;
        public bool HasLightmap { get; private set; }
        public readonly Dictionary<string, string> TextureAlpha = new Dictionary<string, string>(); // file -> opaque/cutout/blend/glow
        public readonly HashSet<string> TextureSheets = new HashSet<string>();  // blend files whose every submesh is single-facing

        // ---- materials (Phase 10): snowknife's resolved per-slot material facts ----
        public readonly Dictionary<string, MatRecord> Materials = new Dictionary<string, MatRecord>();
        public class MatRecord
        {
            public string Texture;          // the texture this material RENDERS at rest (flipbook frame 0 when it has one)
            public List<string> Flipbook;   // ordered frame files (>=2) or null. A frame list is a STATE list; what
                                            // animates it is an effect. FlipFps > 0 = free-running; otherwise the frames
                                            // are states something else selects (a button pulse, a break, game logic).
            public float FlipFps;           // free-running playback fps (0 if the frames are not animated)
            public bool Crowd;              // the shared CrowdBox slot: Flipbook = the cd frame bank, played by
                                            // the shader's per-cell schedule (_CROWD), not a runtime flipbook
            [JsonProperty("Dwell")] float[] _dwell;              // U4 pause screens: [dwellBaseSeconds, flashSeconds] or null
            [JsonIgnore] public Vector2? Dwell => _dwell != null && _dwell.Length >= 2 ? new Vector2(_dwell[0], _dwell[1]) : (Vector2?)null;
            [JsonProperty("Scroll")] float[] _scroll;            // [u,v] scroll speed (already scaled + V-negated) or null
            [JsonIgnore] public Vector2? Scroll => _scroll != null && _scroll.Length >= 2 ? new Vector2(_scroll[0], _scroll[1]) : (Vector2?)null;
            [JsonProperty("ScrollCycle")] float[] _scrollCycle;  // [mode,activeSeconds,pauseSeconds,lifetimeSeconds]; required with Scroll
            [JsonIgnore] public Vector4? ScrollCycle => _scrollCycle != null && _scrollCycle.Length >= 4
                ? new Vector4(_scrollCycle[0], _scrollCycle[1], _scrollCycle[2], _scrollCycle[3]) : (Vector4?)null;
        }

        // ---- collision (Phase 4) ----
        public bool HasCollision { get; private set; }
        public readonly List<Bucket> Buckets = new List<Bucket>();       // prop proxy colliders (collision.glb nodes)
        public readonly List<Box> ComputedBounds = new List<Box>();      // no-proxy signs/billboards
        public readonly List<Body> Bodies = new List<Body>();            // doorway props: boxes from the decoded mode-3 body
        public readonly List<Box> Foliage = new List<Box>();             // zero-response-mass leaf swish triggers
        public readonly List<Box> ContactSounds = new List<Box>();       // authored ride-through sound triggers
        public class Bucket
        {
            public string Node;
            public int ModeMask = 7;
            public bool PlayerBounce;
            [JsonProperty("PlayerBounceAmmount")] public float Amount;
            public int InstanceCount;
            [JsonProperty("CollisonSound")] public int Sound = -1;
            public int SurfaceType = -1;
            public string SoundClip;
            // Set = this bucket holds ONE breakable's support collider (docs/036 §Cracked glass): the invisible solid
            // slab a glass pane rests on. It is bucketed alone precisely so the break can disable it and leave the rest
            // of the level's collision alone; CollisionBuilder hands it to that cluster's breakable behaviour.
            public string BreakCluster;
        }
        public class Box
        {
            public string Name;
            public int ModeMask = 7;
            public Vector3 Center;
            // A mode-2 collider is the model's own box turned with its placement, not a world AABB (spec
            // 130-mode2-oriented). Center/Rotation place the holder; LocalCenter/Size are the box on it. A
            // bundle written before this was understood carries neither, and these defaults reproduce its old
            // axis-aligned behaviour exactly.
            [JsonProperty("Rotation")] float[] _rotation;
            [JsonIgnore] public Quaternion Rotation => _rotation != null && _rotation.Length >= 4
                ? new Quaternion(_rotation[0], _rotation[1], _rotation[2], _rotation[3]) : Quaternion.identity;
            public Vector3 LocalCenter = Vector3.zero;
            public Vector3 Size;
            public bool PlayerBounce;
            [JsonProperty("PlayerBounceAmmount")] public float Amount;
            public int SurfaceType = -1;
            [JsonProperty("CollisonSound")] public int Sound = -1;
            public string SoundClip;
        }
        // A doorway prop (gate arch, cave scaffold, waterfall, crowd stand): the engine's decoded mode-3 physics
        // body merged into a few body-local boxes so its opening stays open (docs/037). Center/Rotation are the
        // instance pivot in mesh space; box centers/sizes are body-local with scale baked in.
        public class Body
        {
            public string Name;
            public int ModeMask = 7;
            public int InstanceIndex = -1;
            public int PhysicsIndex = -1;
            public Vector3 Center;
            [JsonProperty("Rotation")] float[] _rotation;
            [JsonIgnore] public Quaternion Rotation => _rotation != null && _rotation.Length >= 4
                ? new Quaternion(_rotation[0], _rotation[1], _rotation[2], _rotation[3]) : Quaternion.identity;
            [JsonProperty("CollisonSound")] public int Sound = -1;
            public string SoundClip;
            public List<BodyBox> Boxes;
            public List<BodyCapsule> Capsules;
        }
        public class BodyBox { public Vector3 Center; public Vector3 Size; }
        public class BodyCapsule { public Vector3 A; public Vector3 B; public float Radius; }

        // ---- props (Phase 11): the diverted instances snowknife pulled out of props.glb's "Props" node ----
        public readonly List<Divert> Diverted = new List<Divert>();           // gems / physics bodies / breakable logos
        public class Divert
        {
            public int Index;
            public int ModeMask = 7;     // race=1, show-off=2, freeride=4
            public string Kind;          // "spinner" | "physics" | "breakable"
            public string Node;          // props.glb node with this instance's geometry (absolute, SSX mesh space)
            public string Model;
            public string Role;          // breakable: "intact" | "broken" | "scanline" (null otherwise)
            public string ClusterKey;    // breakable cluster id (null otherwise)
            // Kind="physics" only: the breakable cluster this knock body's own collision chain ALSO throws (docs/036) -
            // a garbage can / news box / mail box, whose hit topples the prop AND spills a hidden contents twin. The
            // pieces ship as ordinary breakable records under this key; the importer fires them off the knock rather
            // than a trigger of their own. Null = an ordinary knock body.
            public string SpillCluster;
            public Vector3 Center;       // recentre pivot / localPosition (0 for breakable)
            public float DynamicMass;    // physics: Roller payload U0
            public float Bounce;         // physics: PlayerBounceAmmount
            [JsonProperty("CollisonSound")] public int Sound = -1;  // physics/breakable: impact sound id (-1 = none)
            public string SoundClip;
            // GPU-instanced physics: when present, this record SHARES Node's mesh (one model, many copies) and this is the
            // copy's mesh-space rotation (localRotation); the importer pushes Ambient/Key per-instance via a MaterialPropertyBlock.
            [JsonProperty("Rotation")] float[] _rotation;
            [JsonIgnore] public bool Instanced => _rotation != null && _rotation.Length >= 4;
            [JsonIgnore] public Quaternion Rotation => Instanced
                ? new Quaternion(_rotation[0], _rotation[1], _rotation[2], _rotation[3]) : Quaternion.identity;
            public Color Ambient = Color.white, Light = Color.white; // Light is the explicit non-directional fallback
            public Color Key1 = Color.black, Key2 = Color.black, Key3 = Color.black;
            public Vector3 Direction1, Direction2, Direction3; // placed bundle-mesh directions; converted to world by PropBuilder
            public float[] Throw;        // Role="piece" only: mesh-throw (Sub20) params [U0..U9] (docs/036); null otherwise
            public float[] BurstColor;   // Role="intact" only: "explode in stars" [r,g,b] (balloon pop); null = ordinary shard break (docs/036)
            // Role="intact" only, roll-away breakables (docs/036 - the globe sign): seconds the intact plays its own
            // model clip (the Animated BreakOwned record with the same Index) before the swap, and the RAW course-bank
            // slot of the crash played at the swap. 0 / -1 = the instant break every other cluster uses.
            public float BreakDelay;
            public int BreakSound = -1;
            // Role="intact" only, FRAGILE-SURFACE breakables (docs/036 §Cracked glass - the megaplex panes). A positive
            // CrackStrength means this prop is worn down rather than smashed on contact: it holds an impact-budget pool
            // that each contact drains, and the break runs when the pool crosses zero. CrackSound is the glancing-hit
            // CRACK's raw course-bank slot, a separate event from BreakSound's smash. CrackLifetime is the crack's own
            // lifetime in seconds; -1 (every retail pane) never expires, a positive one heals the surface.
            // 0 = an ordinary instant break.
            public float CrackStrength;
            public float CrackLifetime;
            public int CrackSound = -1;
            public List<EmitterLayer> Layers;   // Kind="spinner" (gems) only: the pickup's own authored collect burst (docs/023); null = none authored
            // Kind="button" (the ride-over buttons, docs/008) only: the volumes whose crossing PULSES this instance's
            // material, and the pulse itself - already replayed from the engine's finite flip node as a frame index per
            // segment plus how long each holds. One record pulses alone: retail gives the node a private material
            // override table, so only the button you crossed changes even where a line of them opens the same pillars.
            public List<AnimTriggerBox> Triggers;
            public List<int> PulseFrames;
            public List<float> PulseHolds;
        }

        // ---- locators: pose-only anchors for named props (the start gate) ----------------------------------
        // No geometry - the prop stays in the merged Props mesh. The importer drops an empty at Center/Rotation
        // (mesh space, placed under the level root) so the start-gate setup can read the gate's true pose.
        public readonly List<Locator> Locators = new List<Locator>();
        public class Locator
        {
            public string Key;           // match key (e.g. "Mdl_StartGate")
            public Vector3 Center;       // mesh-space instance pivot (under the level root)
            [JsonProperty("Rotation")] float[] _rotation;
            [JsonIgnore] public Quaternion Rotation => _rotation != null && _rotation.Length >= 4
                ? new Quaternion(_rotation[0], _rotation[1], _rotation[2], _rotation[3]) : Quaternion.identity;
        }

        /**
         * The locator of a key that belongs to THIS course's start, when a level authors more than one.
         *
         * Alaska ships two `Mdl_StartGate_*`: one at the rider grid and one 71 m away serving a route the course does
         * not take. Instance order does not distinguish them, so the tie is broken on the COURSE - the gate nearest
         * the head of the longest race line is the gate this run leaves through. Levels with a single match (every
         * other retail course) return it unchanged, and a bundle with no course falls back to the first, which is the
         * behaviour every consumer had before the bundle carried duplicates at all.
         */
        public Locator BestLocator(string key)
        {
            Vector3 head;
            bool haveHead = CourseHead(out head);
            Locator best = null;
            float bestScore = float.MaxValue;
            foreach (var l in Locators)
            {
                if (l == null || l.Key != key) continue;
                if (!haveHead) return l;                  // no course to judge by: first match, as before
                float score = (l.Center - head).sqrMagnitude;
                if (best == null || score < bestScore) { best = l; bestScore = score; }
            }
            return best;
        }

        /** The first point of the race line with the greatest authored DistanceToFinish - where the run starts. */
        bool CourseHead(out Vector3 head)
        {
            head = Vector3.zero;
            var c = Course;
            if (c?.Points == null || c.Start == null || c.Count == null) return false;
            int lines = Mathf.Min(c.Start.Length, c.Count.Length);
            int race = c.RaceLineCount > 0 ? Mathf.Min(c.RaceLineCount, lines) : lines;
            int pick = -1;
            float bestDtf = float.NegativeInfinity;
            for (int i = 0; i < race; i++)
            {
                if (c.Count[i] < 1 || c.Start[i] < 0 || c.Start[i] >= c.Points.Length) continue;
                float dtf = c.LineDtf != null && i < c.LineDtf.Length ? c.LineDtf[i] : 0f;
                if (pick >= 0 && dtf <= bestDtf) continue;
                pick = i; bestDtf = dtf;
            }
            if (pick < 0) return false;
            head = c.Points[c.Start[pick]];
            return true;
        }

        // ---- animated props: model-clip players (the swinging bridge) -------------------------------------
        // A persistent SSF AnimObject plays the model's object-hierarchy clip; snowknife bakes the hierarchy,
        // rest poses, and (already X-mirrored) piecewise-cubic channels. Segment geometry is MODEL-LOCAL in
        // props.glb; the importer builds the GameObject chain at Center/Rotation and the animated-prop behaviour samples
        // the curves at runtime. Visible=false = the collision twin (MeshCollider segments, no renderer).
        public readonly List<AnimProp> Animated = new List<AnimProp>();
        public class AnimProp
        {
            public int Index;
            public string Name;
            public string Model;
            public bool Visible;
            public Vector3 Center;
            [JsonProperty("Rotation")] float[] _rotation;
            [JsonIgnore] public Quaternion Rotation => _rotation != null && _rotation.Length >= 4
                ? new Quaternion(_rotation[0], _rotation[1], _rotation[2], _rotation[3]) : Quaternion.identity;
            public int SurfaceType = -1;
            [JsonProperty("CollisonSound")] public int Sound = -1;
            public string SoundClip;
            public bool PlayerCollision;
            public float Bounce;
            public float ClipLength;     // seconds
            public int LoopMode;         // 1 wrap | 2 ping-pong | else once
            public float Rate = 1f;      // clip seconds per real second
            public bool Reverse;
            public bool Triggered;       // starts at rest, plays its clip once on contact (e.g. the iris door)
            public bool BreakOwned;      // the roll phase of a breakable cluster (docs/036): the breakable behaviour triggers/resets it
            // AnimCombo (Sub258): the idle window above free-runs, and a SECOND window of the same clip plays over
            // the top of it when the prop is hit - composed onto the pose it was holding, so an Aloha barrier
            // knocked over mid-slide falls where it stands [Trailmap: 230-level-ssf sub 258].
            public bool Combo;
            public float ComboStart;     // seconds: first frame of the reaction window
            public float ComboEnd;       // seconds: last frame of the reaction window
            public float ComboRate = 1f; // reaction clip seconds per real second
            public int ComboEndMode;     // 0 back to the idle loop | 1 stop on the idle pose | -1 stop holding the reaction
            public float PhaseOffset;    // seconds added to the shared idle clock (the per-instance random start)
            public bool DeltaGated;      // AnimDelta: clip advances only while poke budget > 0; starts frozen (the kickers)
            public bool SelfPulse;       // self-pokes once per region activation (the centre kicker)
            public float PokeSeconds;    // clip-seconds granted per poke (1.0 = one half-swing of the 2s ping-pong)
            public List<AnimTriggerBox> Triggers;   // volumes that fire it: play-once (Triggered) or poke (DeltaGated); null = free-run
            public Color Ambient = Color.white, Key1 = Color.black, Key2 = Color.black, Key3 = Color.black;
            public Vector3 Direction1, Direction2, Direction3;
            public List<AnimSeg> Segments;
        }
        public class AnimTriggerBox
        {
            public Vector3 Center;       // unscaled mesh space (placed under the level root, like the prop pivots)
            public Vector3 Size;
            [JsonProperty("Rotation")] float[] _rotation;
            [JsonIgnore] public Quaternion Rotation => _rotation != null && _rotation.Length >= 4
                ? new Quaternion(_rotation[0], _rotation[1], _rotation[2], _rotation[3]) : Quaternion.identity;
            // The volume instance's own CollisonSound ADL event id (crossing a volume is a collision event, so
            // retail plays it alongside the chain - the megaplex buttons' musical pings). -1 = authored-silent.
            [JsonProperty("CollisonSound")] public int Sound = -1;
            public string SoundClip;
        }
        public class AnimSeg
        {
            public string Node;          // props.glb node ("Anim_{i}_o{k}"); null = hierarchy only
            public int Parent = -1;      // index into Segments (-1 = instance root)
            // The pose a clip starts from. An animated object's curve supplies its components and its unchannelled
            // rotation components are zero; an unanimated hierarchy mount instead keeps its rest rotation/scale.
            public Vector3 RestPos;      // mesh-space model units
            public Vector3 RestEuler;    // degrees
            [JsonProperty("RestRotation")] float[] _restRotation;
            [JsonIgnore] public Quaternion RestRotation => _restRotation != null && _restRotation.Length >= 4
                ? new Quaternion(_restRotation[0], _restRotation[1], _restRotation[2], _restRotation[3])
                : Quaternion.Euler(RestEuler);
            public Vector3 RestScale = Vector3.one; // static object scale (not an animated channel)
            public List<AnimCurve> Curves;
        }
        // value(t) = ((a*t + b)*t + c)*t + d on the seg whose [t0,t1] holds t; segs are [a,b,c,d,t0,t1].
        public class AnimCurve { public int Target; public List<float[]> Segs; }  // 0-2 trans xyz, 3-5 rot xyz (deg)

        // ---- paths (Phase 5): rail + course polylines (root-local mesh space) ----
        public Poly Rails { get; private set; }
        public Poly Course { get; private set; }
        public class Poly
        {
            public Vector3[] Points; public int[] Start; public int[] Count;
            // Rails only: source SplineStyle parallel to Start/Count. Null on older bundles and on the course path.
            public int[] Style;
            // Course only (null on rails): the game's authored DistanceToFinish per RACE line (engine units), and how many
            // of the leading polylines are race lines (the rest are AI/respawn paths). Drives CourseProgressBuilder.
            public float[] LineDtf;
            public int RaceLineCount;
            // Course only: positive SOP type-11 checkpoint events. Route alternatives share Group.
            public CourseCheckpoint[] Checkpoints;
            // Course only: the level's finish ARCH (the union AABB of its Mdl_FinnishGate_* instances at the DTF=0
            // crossing, root-local mesh space). Sizes the finish trigger; null on an older bundle / a course with no arch.
            public Box FinishArch;
            // Rails only: rail-network indices that start NOT grindable (SSX MainType-25 toggle rails, enabled at runtime
            // by the rail gate). RailBuilder feeds these to the rail network.StartDisabledRails. null/empty = all grindable.
            public int[] Gated;
            // Rails only: rail-network indices of the SHOW-OFF-mode rails (docs/026). When ImportConfig.GateShowoffRails
            // is on, RailBuilder adds these to StartDisabledRails too (a free-ride player's rail set). null/empty = none.
            public int[] Showoff;
            // Rails only (null on the course path): the SOURCE cubic bezier so the runtime rides the analytic curve.
            [JsonProperty("Cubic")] CubicData _cubic;
            [JsonIgnore] public Vector3[] SegControlPoints => _cubic?.ControlPoints;   // 4 per segment, root-local
            [JsonIgnore] public int[] SegStart => _cubic?.SegStart;                    // per-rail first segment index
            [JsonIgnore] public int[] SegCount => _cubic?.SegCount;                    // per-rail segment count
            [JsonIgnore] public int SamplesPerSegment => _cubic?.SamplesPerSegment ?? 0; // chord -> segment+t mapping; 0 = no cubic
            class CubicData { public Vector3[] ControlPoints; public int[] SegStart; public int[] SegCount; public int SamplesPerSegment; }
        }
        public class CourseCheckpoint
        {
            public Vector3 Position;
            public float Dtf;
            public int BonusSeconds;
            public int Group;
        }

        // ---- particles + fireworks (Phase 6): all in root-local mesh space ----
        public readonly List<ParticleEffect> Particles = new List<ParticleEffect>();    // fog/cloud billboard volumes
        public class ParticleEffect { public string Name; public string Sprite; public Puff[] Puffs; }
        public struct Puff { public Vector3 Center; public float Radius; }              // Radius in SSX units (apply size knob * WorldScale)

        public bool HasFireworks { get; private set; }
        public readonly List<FwLauncher> FwLaunchers = new List<FwLauncher>();          // one burst per launcher
        public readonly List<FwTrigger> FwTriggers = new List<FwTrigger>();             // trigger volumes that fire them
        public class FwLauncher
        {
            public int Index; public Vector3 Muzzle; public Vector3 Barrel;
            public int Sound = -1;                                       // firing one-shot: course-bank slot (SSF SoundPlay); -1 = none authored
            public List<EmitterLayer> Layers;
        }
        public class FwTrigger { public int Index; public string Name; public int Slot; public Vector3 Center; public Vector3 Size; public int[] Launchers; }

        // ---- continuous emitters: always-on SSF emitters on a visible instance (snow cannons / flares / lanterns) ----
        public bool HasEmitters { get; private set; }
        public readonly List<Emitter> Emitters = new List<Emitter>();
        public class Emitter
        {
            public int Index; public string Name;
            public Vector3 Muzzle; public Vector3 Barrel;   // root-local mesh space: emit origin + aim (prop long axis)
            public float Radius;                            // half the prop's long-axis extent (SSX units); centers + sizes the flare glow halo
            public int GlowRes;                             // co-located light's spriteRes (16/32 = low-res/diffuse) -> halo softness
            public List<EmitterLayer> Layers;
            [JsonProperty("Tint")] float[] _tint;            // normalized RGB of the co-located Type-2 flare light (null = none -> white)
            [JsonIgnore] public Color? Tint => (_tint != null && _tint.Length >= 3) ? (Color?)new Color(_tint[0], _tint[1], _tint[2]) : null;
        }
        public class EmitterLayer
        {
            public int ParticleCount;
            public int TrailCopies;
            public float EmissionWindow;
            public float TimeScale;
            public float SizeCenter;
            public float ParticleLifeCenter;
            public float SizeSpan;
            public float ParticleLifeSpan;
            public float TrailSpacing;
            public Vector3 Origin;
            public Vector3 SpawnAxisA;
            public Vector3 SpawnAxisB;
            public Vector3 VelocityBase;
            public Vector3 VelocityAxisA;
            public Vector3 VelocityAxisB;
            public Vector3 VelocityAxisC;
            public Vector3 Gravity;
            public int SpriteIndex;
            public int BlendMode = 5;
            // Bundle colour tuples are always semantic [R,G,B,A]. Native SSF ARGB is normalized by Snowknife.
            [JsonProperty("ColorStops")] float[][] _colorStops;
            [JsonIgnore] public Color[] ColorStops => _colorStops?.Select(s => new Color(s[0], s[1], s[2], s.Length > 3 ? s[3] : 1f)).ToArray();
            [JsonIgnore] public bool Darkens => BlendMode == 4;

            // The maximum of a convex velocity envelope lies at one of its eight corners.
            [JsonIgnore] public float MaximumVelocity
            {
                get
                {
                    float maximum = 0f;
                    for (int mask = 0; mask < 8; mask++)
                    {
                        Vector3 velocity = VelocityBase
                            + VelocityAxisA * ((mask & 1) == 0 ? -0.5f : 0.5f)
                            + VelocityAxisB * ((mask & 2) == 0 ? -0.5f : 0.5f)
                            + VelocityAxisC * ((mask & 4) == 0 ? -0.5f : 0.5f);
                        maximum = Mathf.Max(maximum, velocity.magnitude);
                    }
                    return maximum;
                }
            }
        }

        // ---- lamp-light glow sprites: authored halos at glowing course-lamp positions (docs/unity/045) ----
        public bool HasLightGlows { get; private set; }
        public readonly List<LightGlow> LightGlows = new List<LightGlow>();
        public class LightGlow
        {
            public string Name;            // light record name (diagnostic)
            public Vector3 Pos;            // root-local mesh space: the light's own position (the lamp head)
            public float Intensity;        // the light's LIGHTING intensity: colour max-channel before normalizing (percent scale; >100 = overbright). The runtime glint IGNORES it - every glint draws at one brightness ([Trailmap: 160-lighting-data])
            public int SpriteRes;          // authored glow-sprite resolution (low = diffuse) -> halo softness
            [JsonProperty("Hue")] float[] _hue;   // normalized RGB (peak 1)
            [JsonIgnore] public Color Hue => (_hue != null && _hue.Length >= 3) ? new Color(_hue[0], _hue[1], _hue[2]) : Color.white;
        }

        // ---- ambient emitters: collision-triggered dust/spark/fire/water bursts (docs/052) ----
        public bool HasAmbientEmitters { get; private set; }
        public readonly List<AmbientEmitter> AmbientEmitters = new List<AmbientEmitter>();
        public class AmbientEmitter
        {
            public int Index; public string Name;
            public Vector3 Muzzle; public Vector3 Barrel;              // root-local mesh space: emit origin + aim
            public Vector3 TriggerCenter; public Vector3 TriggerSize;  // the collision trigger volume (root-local mesh space)
            public bool Repeatable; public float MinInterval;         // hydrants re-fire; MinInterval = the SSX debounce seconds
            public bool ContactDriven;                                // Type2/Sub2: origin + base direction use live contact
            public int[] RollerTargets;                               // instance indices of Roller pop-off props (hydrant TopLids) this trigger pops (docs/052)
            public List<EmitterLayer> Layers;                         // reuses the continuous-emitter layer params
        }

        // ---- boost pads (spec 360): the visible speed/trick pads, baked as footprint AABBs + tier ----
        public readonly List<BoostPad> BoostPads = new List<BoostPad>();
        public class BoostPad
        {
            public int Index; public int ModeMask = 7; public string Name; public int Slot;
            public bool Trick;          // false = speed pad (boosts the board); true = trick pad (cosmetic here)
            public float Value;         // speed magnitude (type17) or trick-window seconds (type18)
            public Vector3 Center; public Vector3 Size;   // root-local mesh space; importer inflates the trigger box
            public List<EmitterLayer> Layers;             // the pad's own contact burst (9 authored layers), same P6 params as every other emitter
        }

        // ---- reset zones (docs/053): OOB / reset-onto-track volumes (MainType-13) ----
        public readonly List<ResetZone> ResetZones = new List<ResetZone>();
        // A reset zone is a PANEL the rider crosses, so its trigger is a slab fitted to that panel and turned
        // with it, not the panel's world AABB (which is ~77x the volume and resets a rider passing beside it).
        // Absent on bundles written before this, where identity reproduces the old axis-aligned box.
        public class ResetZone
        {
            public int Index;
            public string Name;
            public Vector3 Center;
            [JsonProperty("Rotation")] float[] _rotation;
            [JsonIgnore] public Quaternion Rotation => _rotation != null && _rotation.Length >= 4
                ? new Quaternion(_rotation[0], _rotation[1], _rotation[2], _rotation[3]) : Quaternion.identity;
            public Vector3 Size;
            // A VISIBLE host with its own collision proxy carries the reset on that collision, exactly as an
            // animated door does - contact-driven, so no box. Absent on older bundles, which read false and keep
            // the volume they already had.
            public bool ContactOnly;
        }

        // ---- boost volumes (docs/053): the MainType-0 boost family (one mechanism, four sub-types) ----
        // Kind picks which fields past the shared Dir/Amount/Rate triple are meaningful: "directional" (sub-7),
        // "vertical-lift" (sub-18), "lap-gated" (sub-15), "tube-end" (sub-24).
        public readonly List<BoostVolume> BoostVolumes = new List<BoostVolume>();
        public class BoostVolume
        {
            public int Index; public string Name; public string Kind;
            public Vector3 Center; public Vector3 Size;
            public Vector3 Dir;                 // push axis (mesh space; WORLD in the engine, not host-local)
            public float Amount;                // target speed (m/s) along that axis
            public float Rate;                  // approach rate: the lag's 1/time-constant
            // sub-7/24 lifetime: Mode decides what the countdown MEANS. 0 = a cooldown that SUPPRESSES the push
            // while it runs; 1 = an active window (the whole retail corpus); >=2 = never seeded, so the node
            // retires on its first tick and is inert.
            public int Mode = 1;
            public float Seconds;               // how long that countdown runs, in seconds
            public float TargetZ;               // vertical lift: target altitude, mesh-space Z
            public float SnapTolerance;         // vertical lift: gap under which the rider is placed there outright
            public Vector3 Axis;                // lap-gated: the host's own X axis, mesh space
            public float StageFloorOffset;      // lap-gated: height above the volume floor needed for a stage above 0
            public List<BoostStage> Stages;     // tube-end: the three launch pairs the recorded stage picks between
        }
        public class BoostStage { public Vector3 Dir; public float Speed; }

        // ---- spline movers (docs/053): MainType-2/SubType-1 spline-path animation (e.g. a subway car) ----
        public readonly List<SplineMover> SplineMovers = new List<SplineMover>();
        public class SplineMover
        {
            public int Index; public string Name; public float Speed; public int Count;
            [JsonProperty("Path")] float[][] _path;
            [JsonIgnore] public Vector3[] Path => _path?.Select(p => new Vector3(p[0], p[1], p[2])).ToArray();
            // The template's authored rotation, baked into its diverted mesh. The engine builds the moving prop's matrix
            // from the spline alone and never reads it, so the mover behaviour un-bakes it (SplineMoverBuilder).
            [JsonProperty("Rotation")] float[] _rotation;
            [JsonIgnore] public Quaternion Rotation => _rotation != null && _rotation.Length >= 4
                ? new Quaternion(_rotation[0], _rotation[1], _rotation[2], _rotation[3]) : Quaternion.identity;
            public float YawOffset;   // radians; (YawOffset + pi/2) - the tangent angle = the model's yaw. Picks the lead axis
            public int OrientMode;    // 0 = yaw+pitch, 1 = yaw/level, 2 = fixed yaw+pitch, 3 = fixed
            public int EndMode = 1;   // 0 = finish, 1 = wrap, 2 = ping-pong, 3 = hold alive at end
            // The engine draws the spline itself as a line when Cable is set - a chairlift's running cable.
            public bool Cable;
            [JsonProperty("CableColor")] float[] _cable;
            [JsonIgnore] public Color CableRgba => _cable != null && _cable.Length >= 4
                ? new Color(_cable[0], _cable[1], _cable[2], _cable[3]) : Color.black;
        }

        // ---- rail toggles (spec 350): MainType-25 gates that make a gated rail grindable on cross ----
        public readonly List<RailGate> RailGates = new List<RailGate>();
        public class RailGate
        {
            public int Index; public string Name;
            public Vector3 Center; public Vector3 Size;   // root-local mesh space; importer inflates the trigger box
            public int[] Rails;                           // rail-network indices this gate enables (into the rail network)
        }

        // ---- teleports (spec 390): MainType-24 portal pairs (start volume -> destination instance) ----
        public readonly List<Teleport> Teleports = new List<Teleport>();
        public class Teleport
        {
            public int Index; public string Name; public int Slot;
            public Vector3 Center; public Vector3 Size;   // root-local mesh space; importer inflates the trigger box
            public int Target; public string TargetName;
            public Vector3 Dest;        // root-local mesh space: the landing spot (exit instance pivot)
            public int Sound = -1;      // entry cue: course-bank slot the SSF MainType-8 played (-1 = none)
        }

        // ---- debug HUD messages (MainType-12): local collision-triggered in-race banners ----
        public readonly List<HudMessage> HudMessages = new List<HudMessage>();
        public class HudMessage
        {
            public int Index; public string Name; public int Slot;
            public string Text; public Color Color = Color.white;
            public float Duration = 2.5f; public float Delay;
            public Vector3 Center; public Vector3 Size;
        }

        // ---- authored gem pickups (Slopesmith docs/014): the collectible half of a Slopesmith course's trick layer ----
        // GemTierNodes maps a tier (2/3/5) to its gems.glb node — the donor level's shipped crystal baked from
        // the course's GemModels.obj — which the importer instantiates per record; when null (older courses) it
        // synthesises the gem visual instead. Center is root-local mesh space, like the other placements.
        public readonly List<Gem> Gems = new List<Gem>();
        public Dictionary<int, string> GemTierNodes { get; private set; }
        public class Gem { public Vector3 Center; public int Value = 1; }

        // ---- billboard screens (docs/vrchat/041): the flat rectangle on each of the course's boards a video
        // can be laid over. snowknife measures them from the placed prop geometry (or Slopesmith authors them)
        // and ships them here, so BillboardScreenBuilder only has to lay a quad on each. Center/Normal/Up are
        // root-local mesh space; Width/Height are SSX units, like every other size in the manifest.
        public readonly List<BillboardScreen> BillboardScreens = new List<BillboardScreen>();
        public class BillboardScreen
        {
            public string Name;
            public string Family;    // the billboard family / author grouping; null = ungrouped
            public Vector3 Center;
            public Vector3 Normal;   // out of the screen, toward the viewer
            public Vector3 Up;       // image up
            public float Width;
            public float Height;
            public string Page;      // the texture page the covered face draws (diagnostic)
        }

        // ---- audio + probes (Phase 7): root-local mesh-space placements ----
        public readonly List<Vector3> CrowdCentroids = new List<Vector3>();             // one looping crowd source each
        public readonly List<PlacedLoop> PlacedLoops = new List<PlacedLoop>();
        public string CourseBank = "";                                                  // Audio/SFX course-bank folder (group 2)
        public class PlacedLoop
        {
            public string Name;
            public string Kind;                    // absent in early bundle-v2 manifests
            public Vector3 Center;
            public float Radius = 80f;
            public int Sound = -1;
            public int Curve = 2;
            public string SoundClip;
            public bool HitGated;                  // interactive ambient (events 16/28/57): silent until the prop is first hit
            public string Owner;                   // owning instance name, for the hit pairing
        }
        public Vector3[] ProbePositions { get; private set; }                            // LightProbeGroup positions (null if absent)
        public float ProbeMinSpacing { get; private set; }

        readonly ImportConfig _cfg;
        public BundleManifestReader(ImportConfig cfg)
        {
            _cfg = cfg;
            string p = Path.Combine(Path.GetDirectoryName(Application.dataPath), cfg.LevelFolder + "/gltf/manifest.json");
            if (!File.Exists(p)) return;
            try
            {
                var j = JObject.Parse(File.ReadAllText(p));
                int version = (int?)j["BundleVersion"] ?? 0;
                if (version != BundleVersion)
                    throw new InvalidDataException($"bundle version {version}; expected {BundleVersion}. Re-run snowknife gltf.");
                Exists = true;
                var ser = JsonSerializer.Create();
                ser.Converters.Add(new Vec3Converter());
                ser.Converters.Add(new Color3Converter());

                var scale = j["Space"]?["Scale"];
                if (scale != null) Scale = (float)scale;
                HasLightmap = j["Lightmap"] != null && j["Lightmap"].Type != JTokenType.Null;

                if (j["Textures"] is JArray tex)
                    foreach (var t in tex)
                    {
                        TextureAlpha[(string)t["File"]] = (string)t["Alpha"];
                        if (t["Sheet"] != null && (bool)t["Sheet"]) TextureSheets.Add((string)t["File"]);
                    }

                if (j["Materials"] is JArray mtl)
                    foreach (var mm in mtl) Materials[(string)mm["Name"]] = mm.ToObject<MatRecord>(ser);

                var col = j["Collision"];
                if (col != null && col.Type != JTokenType.Null)
                {
                    HasCollision = true;
                    if (col["Buckets"] is JArray bk) Buckets.AddRange(bk.ToObject<List<Bucket>>(ser));
                    if (col["ComputedBounds"] is JArray cb) ComputedBounds.AddRange(cb.ToObject<List<Box>>(ser));
                    if (col["Bodies"] is JArray bd) Bodies.AddRange(bd.ToObject<List<Body>>(ser));
                    if (col["Foliage"] is JArray fo) Foliage.AddRange(fo.ToObject<List<Box>>(ser));
                    if (col["ContactSounds"] is JArray cs) ContactSounds.AddRange(cs.ToObject<List<Box>>(ser));
                }

                if (j["Props"]?["Diverted"] is JArray dv) Diverted.AddRange(dv.ToObject<List<Divert>>(ser));
                if (j["Props"]?["Animated"] is JArray an) Animated.AddRange(an.ToObject<List<AnimProp>>(ser));
                if (j["Props"]?["Locators"] is JArray lo) Locators.AddRange(lo.ToObject<List<Locator>>(ser));

                var paths = j["Paths"];
                if (paths != null && paths.Type != JTokenType.Null)
                {
                    Rails = paths["Rails"]?.ToObject<Poly>(ser);
                    Course = paths["Course"]?.ToObject<Poly>(ser);
                }

                if (j["Particles"]?["Effects"] is JArray eff) Particles.AddRange(eff.ToObject<List<ParticleEffect>>(ser));

                var fw = j["Fireworks"];
                if (fw != null && fw.Type != JTokenType.Null)
                {
                    HasFireworks = true;
                    if (fw["Launchers"] is JArray la) FwLaunchers.AddRange(la.ToObject<List<FwLauncher>>(ser));
                    if (fw["Triggers"] is JArray ta) FwTriggers.AddRange(ta.ToObject<List<FwTrigger>>(ser));
                }

                var emit = j["Emitters"];
                if (emit != null && emit.Type != JTokenType.Null && emit["Emitters"] is JArray ea)
                {
                    HasEmitters = true;
                    Emitters.AddRange(ea.ToObject<List<Emitter>>(ser));
                }

                var amb = j["AmbientEmitters"];
                if (amb != null && amb.Type != JTokenType.Null && amb["Emitters"] is JArray aea)
                {
                    HasAmbientEmitters = true;
                    AmbientEmitters.AddRange(aea.ToObject<List<AmbientEmitter>>(ser));
                }

                var lg = j["LightGlows"];
                if (lg != null && lg.Type != JTokenType.Null && lg["Glows"] is JArray lga)
                {
                    HasLightGlows = true;
                    LightGlows.AddRange(lga.ToObject<List<LightGlow>>(ser));
                }

                if (j["BoostPads"]?["Pads"] is JArray bp) BoostPads.AddRange(bp.ToObject<List<BoostPad>>(ser));
                if (j["ResetZones"]?["Zones"] is JArray rzj) ResetZones.AddRange(rzj.ToObject<List<ResetZone>>(ser));
                if (j["BoostVolumes"]?["Volumes"] is JArray bvj) BoostVolumes.AddRange(bvj.ToObject<List<BoostVolume>>(ser));
                if (j["SplineMovers"]?["Movers"] is JArray smj) SplineMovers.AddRange(smj.ToObject<List<SplineMover>>(ser));

                if (j["Teleports"]?["Teleports"] is JArray tp) Teleports.AddRange(tp.ToObject<List<Teleport>>(ser));
                if (j["HudMessages"]?["Messages"] is JArray hm) HudMessages.AddRange(hm.ToObject<List<HudMessage>>(ser));

                if (j["RailGates"]?["Gates"] is JArray rg) RailGates.AddRange(rg.ToObject<List<RailGate>>(ser));

                if (j["Billboards"]?["Screens"] is JArray bbs) BillboardScreens.AddRange(bbs.ToObject<List<BillboardScreen>>(ser));

                if (j["Gems"]?["Gems"] is JArray gmj) Gems.AddRange(gmj.ToObject<List<Gem>>(ser));
                if (j["Gems"]?["TierNodes"] is JObject gtn) GemTierNodes = gtn.ToObject<Dictionary<int, string>>(ser);

                if (j["Audio"]?["CrowdCentroids"] is JArray cc) CrowdCentroids.AddRange(cc.ToObject<List<Vector3>>(ser));
                if (j["Audio"]?["PlacedLoops"] is JArray pl) PlacedLoops.AddRange(pl.ToObject<List<PlacedLoop>>(ser));
                var courseBank = j["Audio"]?["CourseBank"];
                if (courseBank != null && courseBank.Type == JTokenType.String) CourseBank = (string)courseBank;

                var probes = j["Probes"];
                if (probes != null && probes.Type != JTokenType.Null && probes["Positions"] is JArray pp)
                {
                    var sp = probes["MinSpacing"]; if (sp != null) ProbeMinSpacing = (float)sp;
                    ProbePositions = pp.ToObject<Vector3[]>(ser);
                }
            }
            catch (System.Exception e) { Debug.LogWarning("OpenSlope: failed to read bundle manifest: " + e.Message); Exists = false; }
        }

        public string BundlePath(string rel) => _cfg.LevelFolder + "/gltf/" + rel;

        // The level's course BANK folder under Audio/SFX, as named by the bundle. Empty when the bundle predates
        // the field (older exports) - the caller then falls back to scanning the folder listing.
        public static string ReadCourseBank(string levelFolder)
        {
            string p = Path.Combine(Path.GetDirectoryName(Application.dataPath), levelFolder + "/gltf/manifest.json");
            if (!File.Exists(p)) return "";
            try
            {
                var manifest = JObject.Parse(File.ReadAllText(p));
                var cb = manifest["Audio"]?["CourseBank"];
                return cb != null && cb.Type == JTokenType.String ? (string)cb : "";
            }
            catch { return ""; }
        }

        // How many PASSES from the start gate to the finish this map is raced over (manifest.Race.Laps). One - the
        // classic single run - for a bundle that predates the field or names no count, so a map with nothing to say
        // about laps records on the first crossing exactly as it always has.
        public static int ReadLaps(string levelFolder)
        {
            string p = Path.Combine(Path.GetDirectoryName(Application.dataPath), levelFolder + "/gltf/manifest.json");
            if (!File.Exists(p)) return 1;
            try
            {
                var laps = JObject.Parse(File.ReadAllText(p))["Race"]?["Laps"];
                return laps != null && laps.Type == JTokenType.Integer && (int)laps >= 1 ? (int)laps : 1;
            }
            catch { return 1; }
        }

        // Initial showoff countdown in seconds (manifest.Race.ShowoffSeconds). Checkpoints are carried on the
        // CoursePath separately and extend this budget while the run is live.
        public static float ReadShowoffSeconds(string levelFolder)
        {
            string p = Path.Combine(Path.GetDirectoryName(Application.dataPath), levelFolder + "/gltf/manifest.json");
            if (!File.Exists(p)) return 120f;
            try
            {
                var seconds = JObject.Parse(File.ReadAllText(p))["Race"]?["ShowoffSeconds"];
                float value = seconds != null && (seconds.Type == JTokenType.Float || seconds.Type == JTokenType.Integer)
                    ? (float)seconds : 120f;
                return Mathf.Max(0f, value);
            }
            catch { return 120f; }
        }

        // Lightweight read of just `manifest.Sun` (the level's authored directional + ambient), so the config
        // can orient the scene sun from the level itself. `Direction` is the Unity-world TO-LIGHT vector snowknife
        // wrote (== editor to-sun). Returns false when the level didn't author a sun (no manifest.Sun).
        public static bool ReadSun(string levelFolder, out Vector3 direction, out Color colour, out Color ambient)
        {
            direction = Vector3.up; colour = Color.white; ambient = Color.black;
            string p = Path.Combine(Path.GetDirectoryName(Application.dataPath), levelFolder + "/gltf/manifest.json");
            if (!File.Exists(p)) return false;
            try
            {
                var manifest = JObject.Parse(File.ReadAllText(p));
                if (((int?)manifest["BundleVersion"] ?? 0) != BundleVersion) return false;
                var sun = manifest["Sun"];
                if (sun == null || sun.Type == JTokenType.Null) return false;
                if (sun["Direction"] is JArray d && d.Count >= 3) direction = new Vector3((float)d[0], (float)d[1], (float)d[2]).normalized;
                if (sun["Colour"]    is JArray c && c.Count >= 3) colour    = new Color((float)c[0], (float)c[1], (float)c[2]);
                if (sun["Ambient"]   is JArray a && a.Count >= 3) ambient   = new Color((float)a[0], (float)a[1], (float)a[2]);
                return true;
            }
            catch { return false; }
        }

        // The manifest stores vectors as JSON [x,y,z] and colours as [r,g,b]; these converters let Newtonsoft map
        // them straight into Unity types wherever they appear (single fields, arrays, and List<T> elements alike).
        class Vec3Converter : JsonConverter<Vector3>
        {
            public override bool CanWrite => false;
            public override void WriteJson(JsonWriter w, Vector3 v, JsonSerializer s) => throw new System.NotSupportedException();
            public override Vector3 ReadJson(JsonReader r, System.Type t, Vector3 ex, bool has, JsonSerializer s)
            {
                if (r.TokenType == JsonToken.Null) return Vector3.zero;
                var a = JArray.Load(r);
                return a.Count >= 3 ? new Vector3((float)a[0], (float)a[1], (float)a[2]) : Vector3.zero;
            }
        }
        class Color3Converter : JsonConverter<Color>
        {
            public override bool CanWrite => false;
            public override void WriteJson(JsonWriter w, Color c, JsonSerializer s) => throw new System.NotSupportedException();
            public override Color ReadJson(JsonReader r, System.Type t, Color ex, bool has, JsonSerializer s)
            {
                if (r.TokenType == JsonToken.Null) return Color.white;
                var a = JArray.Load(r);
                return a.Count >= 3 ? new Color((float)a[0], (float)a[1], (float)a[2], 1f) : Color.white;
            }
        }
    }
}
#endif
