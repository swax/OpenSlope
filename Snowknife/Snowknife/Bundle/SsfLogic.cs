using System.Collections.Concurrent;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Snowknife.Engine;

namespace Snowknife.Bundle;

#pragma warning disable CS0649 // JSON DTO fields are populated by Newtonsoft.

/// <summary>
/// The one shared, read-only view of a level's SSF effect semantics for every gltf-time bundler, sourced
/// from <c>Effects.json</c> — the lossless stable-ID interchange document that extraction, Slopesmith, and
/// Unity all share. <see cref="FromEffectsDocument"/> normalizes the document into the in-memory
/// <see cref="SsfRoot"/> model: stable references become native indices, and the field names match the
/// native SSF dialect (the same names the repack side's SSFLogic.json uses), so the bundlers and the
/// packer speak one vocabulary. Every index-like field defaults to -1 ("unset"), safe against documents
/// that omit absent references.
/// The document is parsed once per path and cached; an absent or unparseable file loads as <c>null</c>,
/// matching every consumer's "no data" degradation path. Unparseable is said out loud, once, naming the
/// file: a level that silently lost every SSF-driven feature looks exactly like one that never had any.
/// </summary>
internal static class SsfLogic
{
    static readonly ConcurrentDictionary<string, SsfRoot?> Cache = new(StringComparer.OrdinalIgnoreCase);
    static readonly ConcurrentDictionary<string, JObject?> DocCache = new(StringComparer.OrdinalIgnoreCase);

    public static SsfRoot? Load(string levelDir)
    {
        string path = Path.GetFullPath(Path.Combine(levelDir, "Effects.json"));
        return Cache.GetOrAdd(path, _ =>
        {
            var doc = LoadDocument(levelDir);
            if (doc == null) return null;
            try { return FromEffectsDocument(doc); }
            catch (Exception e)
            {
                Log.Warn($"  WARN: {path} does not normalize ({e.Message}) — SSF-driven features load as absent.");
                return null;
            }
        });
    }

    /// <summary>The raw openslope-effects document, parsed once per level. Null when absent/unparseable.</summary>
    static JObject? LoadDocument(string levelDir)
    {
        string path = Path.GetFullPath(Path.Combine(levelDir, "Effects.json"));
        return DocCache.GetOrAdd(path, p =>
        {
            if (!File.Exists(p)) return null;
            try { return JObject.Parse(File.ReadAllText(p)); }
            catch (Exception e)
            {
                Log.Warn($"  WARN: {p} is unreadable ({e.Message}) — SSF-driven features load as absent.");
                return null;
            }
        });
    }

    /// <summary>id → native index for one of the document's ID-bearing tables (originalIndex, else position).</summary>
    static Dictionary<string, int> IndexMap(JObject doc, string table)
    {
        var map = new Dictionary<string, int>(StringComparer.Ordinal);
        int i = 0;
        foreach (var row in (doc[table] as JArray ?? new JArray()).OfType<JObject>())
        {
            if ((string?)row["id"] is { Length: > 0 } id) map[id] = (int?)row["originalIndex"] ?? i;
            i++;
        }
        return map;
    }

    static int Resolve(Dictionary<string, int> map, JToken? reference) =>
        reference is { Type: JTokenType.String } && map.TryGetValue((string)reference!, out int v) ? v : -1;

    /// <summary>
    /// Effects.json is the source of the instance→effect binding too — not just the graphs. Stamps
    /// <see cref="SsxInstance.EffectSlotIndex"/> / <see cref="SsxInstance.PhysicsIndex"/> onto the loaded
    /// Instances.json rows via <c>instances[i] → objectProperties → references.{effectSlot,physics}</c>.
    /// Both extraction and Slopesmith write this same canonical instance table, so this method has no
    /// authored-map branch.
    /// </summary>
    public static void ApplyInstanceBindings(string levelDir, List<SsxInstance>? instances)
    {
        if (instances == null || instances.Count == 0) return;
        var doc = LoadDocument(levelDir);
        if (doc == null) return;
        var slotIdx = IndexMap(doc, "slots");
        var physicsIdx = IndexMap(doc, "physics");

        // Retail-shaped documents: the native instance table is populated, and it is authoritative.
        var propById = (doc["objectProperties"] as JArray ?? new JArray()).OfType<JObject>()
            .Where(p => (string?)p["id"] is { Length: > 0 })
            .ToDictionary(p => (string)p["id"]!, p => p, StringComparer.Ordinal);
        int i = 0;
        foreach (var binding in (doc["instances"] as JArray ?? new JArray()).OfType<JObject>())
        {
            int oi = (int?)binding["originalIndex"] ?? i;
            i++;
            if (oi < 0 || oi >= instances.Count) continue;
            var refs = (string?)binding["property"] is { } pid && propById.TryGetValue(pid, out var prop)
                ? prop["references"] as JObject : null;
            instances[oi].EffectSlotIndex = Resolve(slotIdx, refs?["effectSlot"]);
            instances[oi].PhysicsIndex = Resolve(physicsIdx, refs?["physics"]);
        }
    }

    /// <summary>
    /// Normalize an openslope-effects v1 document into the <see cref="SsfRoot"/> model the bundlers read:
    /// the exact inverse of EffectsDocumentService.FromSsf over the DTO-visible surface. Stable references are
    /// resolved back to native indices via each table's <c>originalIndex</c> (falling back to array position),
    /// so a document with authored insertions still lands on the correct native tables.
    /// </summary>
    internal static SsfRoot? FromEffectsDocument(JObject doc)
    {
        var graphIdx = IndexMap(doc, "graphs");
        var functionIdx = IndexMap(doc, "functions");
        var instanceIdx = IndexMap(doc, "instances");
        var splineIdx = IndexMap(doc, "splines");
        int R(Dictionary<string, int> map, JToken? reference) => Resolve(map, reference);

        JObject Node(JObject nd)
        {
            int mt = (int?)nd["mainType"] ?? 0;
            var n = nd["payload"] is JObject payload ? (JObject)payload.DeepClone() : new JObject();
            n["MainType"] = mt;
            var refs = nd["references"] as JObject ?? new JObject();

            // The payload serializes the native Effect struct superset-with-defaults: every union scalar
            // is present (zero-valued) on every node regardless of MainType. Strip the MainType-irrelevant
            // ones so the DTO defaults (-1) keep meaning "none".
            if (mt != 4) n.Remove("WaitTime");
            if (mt != 12) { n.Remove("HudText"); n.Remove("HudRed"); n.Remove("HudGreen"); n.Remove("HudBlue"); }
            if (mt != 8) n.Remove("SoundPlay");
            if (mt != 17) n.Remove("type17");
            if (mt != 18) n.Remove("type18");
            if (mt != 21) n.Remove("FunctionRunIndex");
            if (mt != 24) n.Remove("TeleportInstanceIndex");
            if (n["type0"] is JObject t0)
            {
                if ((int?)t0["SubType"] != (int)SsfType0Sub.DeadNode) t0.Remove("DeadNodeMode");
                // Native vectors serialize as {X,Y,Z}; the DTO reads [x,y,z].
                if (t0["Boost"] is JObject boost && boost["BoostDir"] is JObject dir)
                    boost["BoostDir"] = new JArray((float?)dir["X"] ?? 0f, (float?)dir["Y"] ?? 0f, (float?)dir["Z"] ?? 0f);
            }

            // Re-inline the promoted stable references as native indices (null reference -> -1).
            if (mt == 7 && n["Instance"] is JObject instance)
            {
                instance["InstanceIndex"] = R(instanceIdx, refs["instance"]);
                instance["EffectIndex"] = R(graphIdx, refs["effectGraph"]);
            }
            else if (mt == 21) n["FunctionRunIndex"] = R(functionIdx, refs["function"]);
            else if (mt == 24) n["TeleportInstanceIndex"] = R(instanceIdx, refs["instance"]);
            else if (mt == 25 && n["Spline"] is JObject spline) spline["SplineIndex"] = R(splineIdx, refs["spline"]);
            if (mt == 2 && n["type2"] is JObject t2 && (int?)t2["SubType"] == 1 && t2["SplineAnimation"] is JObject animation)
                animation["SplineIndex"] = R(splineIdx, refs["spline"]);
            return n;
        }

        JArray Owners(string table, bool named)
        {
            var owners = new JArray();
            foreach (var owner in (doc[table] as JArray ?? new JArray()).OfType<JObject>())
            {
                var entry = new JObject();
                if (named) entry["FunctionName"] = owner["name"];
                entry["Effects"] = new JArray((owner["nodes"] as JArray ?? new JArray()).OfType<JObject>().Select(Node));
                owners.Add(entry);
            }
            return owners;
        }

        var logic = new JObject
        {
            ["EffectSlots"] = new JArray((doc["slots"] as JArray ?? new JArray()).OfType<JObject>().Select(s => new JObject
            {
                ["PersistantEffectSlot"] = R(graphIdx, s["circumstances"]?["persistent"]),
                ["CollisionEffectSlot"] = R(graphIdx, s["circumstances"]?["collision"]),
                ["EffectTriggerSlot"] = R(graphIdx, s["circumstances"]?["trigger"]),
            })),
            ["EffectHeaders"] = Owners("graphs", named: false),
            ["Functions"] = Owners("functions", named: true),
            ["PhysicsHeaders"] = new JArray((doc["physics"] as JArray ?? new JArray()).OfType<JObject>()
                .Select(p => p["data"] as JObject ?? new JObject())),
        };
        return logic.ToObject<SsfRoot>();
    }
}

// ---- The in-memory SSF effect model. Field names match the document's payload keys exactly (the native
// SSF dialect, shared with the repack side's SSFLogic.json); extra JSON fields are ignored. ----

internal sealed class SsfRoot
{
    public SsfSlot[]? EffectSlots;
    public SsfHeader[]? EffectHeaders;
    public SsfFunction[]? Functions;
    public SsfPhysicsHeader[]? PhysicsHeaders;
}

/// <summary>An instance's effect binding: per-circumstance indices into EffectHeaders (-1 = none).
/// <para>
/// <c>EffectTriggerSlot</c> is the DEFERRED-TRIGGER circumstance ([Trailmap: 150-logic]): the one column with no
/// external event of its own. It is the continuation a runtime node installed by the persistent or collision
/// chain fires when its own condition elapses — a count-down Timer running out, or the <see cref="SsfCracked"/>
/// handler on a fragile surface finally giving way. The megaplex glass panes are the shipped case: their
/// collision chain only installs the crack, and the smash itself (sound, kill, shard throw) lives here.
/// </para></summary>
internal sealed class SsfSlot { public int PersistantEffectSlot = -1; public int CollisionEffectSlot = -1; public int EffectTriggerSlot = -1; }

internal class SsfHeader { public SsfNode[]? Effects; }
/// <summary>A named function body (MainType-21 CallFunction target, e.g. the BreakLogo* dispatch).</summary>
internal sealed class SsfFunction : SsfHeader { public string? FunctionName; }

internal sealed class SsfNode
{
    public SsfMainType MainType;
    public SsfInst? Instance;               // ActOnInstance (7): show/hide/play a sub-effect on another instance
    public SsfSpline? Spline;               // ToggleRail (25)
    public SsfType0? type0;                 // Property (0), sub-typed by SsfType0Sub
    public SsfType2? type2;                 // Emitter (2), sub-typed by SsfType2Sub
    public SsfType3? type3;                 // AddDelta (3/9)
    public float WaitTime;                  // Wait (4): chain delay in seconds
    public int SoundPlay = -1;              // PlaySound (8): raw course-bank slot
    public float? type17;                   // SpeedBoost (17): boost magnitude
    public float? type18;                   // TrickBoost (18): trick-window seconds
    public int FunctionRunIndex = -1;       // CallFunction (21): index into Functions
    public int TeleportInstanceIndex = -1;  // Teleport (24): warp target instance
    public string? HudText;                 // HudText (12): the message, inline in the node's own payload
    public float HudRed = 1, HudGreen = 1, HudBlue = 1;  // HudText (12): its colour, ahead of the text
}

internal sealed class SsfInst { public int InstanceIndex = -1; public int EffectIndex = -1; }
internal sealed class SsfSpline { public int SplineIndex = -1; public int Effect; }

internal sealed class SsfType0
{
    public SsfType0Sub SubType = (SsfType0Sub)(-1);
    public SsfRoller? type0Sub0;             // Sub0: dynamic-body activation and scalar mass
    public int DeadNodeMode = -1;           // Sub5: 4 = the hard kill/hide-source the breakables use
    public float Debounce;                  // Sub2: re-fire interval in seconds
    public SsfBoost? Boost;                 // Sub7 directional boost
    public SsfBoostLap? type0Sub15;         // Sub15 finish-tube lift + stage classifier
    public SsfBoostZ? type0Sub18;           // Sub18 vertical elevator
    public SsfBoostTubeEnd? type0Sub24;     // Sub24 staged launch
    public SsfUvScroll? UVScroll;           // Sub10: scrolling texture UVs (water, ad boards, chevrons)
    public SsfTextureFlip? TextureFlip;     // Sub11: flipbook / LCD-screen flip
    public SsfCracked? type0Sub14;          // Sub14: the fragile-surface crack handler (the glass panes)
    public SsfCrowd? CrowdEffect;           // Sub17: grandstand spectator marker (presence is the signal)
    public SsfSub20? type0Sub20;            // Sub20 breakable mesh throw
    public SsfSubAnim? type0Sub256;         // Sub256 AnimObject (the bridge)
    public SsfSubAnim? type0Sub257;         // Sub257 AnimDelta (the kicker)
    public SsfSubCombo? type0Sub258;        // Sub258 AnimCombo (the Aloha side-to-side barriers)
}

internal sealed class SsfRoller { public float U0, U1, U2, U3, U4, U5; }

/// <summary>Sub10 UVScroll: U0 mode; U1/U2 units per tick; U3/U4 active/pause seconds;
/// U5 total lifetime seconds (zero = until the slot unloads).</summary>
internal sealed class SsfUvScroll { public int U0; public float U1, U2, U3, U4, U5; }

/// <summary>
/// Sub11 TextureFlip: Speed = the flip rate (DirectionalSign 3.5, Lcd_ScreenLogo 1); U4 = the pause/dwell flag.
/// <para>
/// <b>Length is the node's lifetime in seconds, and it separates the two kinds of flip.</b> A persistent flip
/// authors <c>Length 0</c> — the node lives as long as its slot, so the material cycles forever (the checkpoint
/// top, the directional signs). A flip authored with <c>Length &gt; 0</c> is a collision-fired ONE-SHOT: it is
/// reached only through a <c>MainType-7</c> hop from a trigger volume's collision header, and it advances an ODD
/// number of frames before expiring, so a two-frame material ends on the frame it started from. That is the
/// megaplex buttons (Speed 3.5, Length 0.5/1.0): green at rest, a red pulse as a rider crosses, green again.
/// A material's frame list is therefore a STATE list something else selects among, not an animation — consumers
/// must not free-run a triggered flip. See <see cref="TriggeredFlipClassifier"/>.
/// </para>
/// </summary>
internal sealed class SsfTextureFlip { public float Speed; public float Length; public int Direction; public int U4; }

/// <summary>
/// Sub14 Cracked: the fragile-surface handler a collision chain installs on its own instance. The node breaks
/// nothing itself — it holds a STRENGTH pool, subtracts the force of each accepted contact, and when the pool
/// crosses zero fires the same slot's <c>EffectTriggerSlot</c> column, which is where the shatter is authored
/// ([Trailmap: 370-world-interaction], and the deferred-trigger circumstance in [Trailmap: 150-logic]).
/// <para>
/// <c>U0</c> is the CRACK's lifetime in seconds, not the surface's: when it expires the node retires and takes
/// the accumulated damage with it, so the surface HEALS. Every retail pane authors -1 and never expires.
/// <c>U1</c> is the pool — an impact budget rather than a hit count. Retail's panes ship 5, which measured on
/// PS2 as about three seconds of being ridden (carried contacts cost 0.687-2.5, gated to one per 30 frames) or
/// one hard landing (a single impact costs 70-96). Megaplex's glass is the only place the game authors it.
/// </para></summary>
internal sealed class SsfCracked { public float U0, U1; }

/// <summary>Sub17 CrowdBox payload — consumers only test presence.</summary>
internal sealed class SsfCrowd { public float U0, U1, U2; }

// The MainType-0 BOOST FAMILY. Five registry names share one mechanism: sub-7 is the base class, sub-16 and sub-24
// derive from it, and sub-15/sub-18 lay out the same rate/target/axis triple at the same payload offsets. So every
// DTO below carries that triple, and they differ only in what surrounds it ([Trailmap: 360-node-fields]).
//
// The push is a first-order lag that only ever ADDS: speed along the axis approaches the target with time constant
// 1/rate, and a rider already faster along the axis is left alone ([Trailmap: 360-node-apply]). The axis is WORLD
// space — the engine never rotates it by the host's transform.

/// <summary>MainType-0/SubType-7: a directional boost volume. U1 = the node's armed window in
/// seconds (a lifetime, not the push); U2 = the approach rate; BoostAmount = the target speed in m/s.</summary>
internal sealed class SsfBoost { public int Mode; public float BoostAmount; public float[]? BoostDir; public float U1; public float U2; }

/// <summary>SubType-15: lifts like the Z boost but bounded by the volume, and classifies the rider
/// into a launch stage the sub-24 tube-end node consumes ([Trailmap: 360-lapboost]). U0 rate, U1 target speed,
/// U2..U4 the lift axis.</summary>
internal sealed class SsfBoostLap { public float U0, U1, U2, U3, U4; }

/// <summary>SubType-18: an elevator rather than a push — it cancels horizontal motion and aims at an
/// ALTITUDE ([Trailmap: 360-zboost]). U0 rate, U1 target speed, U2..U4 the lift axis, U5 the target world Z,
/// U6 the snap tolerance (0 never snaps and eases all the way in).</summary>
internal sealed class SsfBoostZ { public float U0, U1, U2, U3, U4, U5, U6; }

/// <summary>SubType-24: the staged launch that closes the finish tube ([Trailmap: 360-tubeend]).
/// It inherits sub-7's payload wholesale (U0 mode, U1 window, U2 rate, U3 target, U4..U6 base axis) and adds three
/// (direction, speed) launch stages; the recorded stage picks one. Retail authors the inherited base axis all-zero,
/// so the inherited push contributes nothing and the stages carry the behaviour.</summary>
internal sealed class SsfBoostTubeEnd
{
    public float U0, U1, U2, U3, U4, U5, U6;
    public float U7, U8, U9;      // stage 1 direction
    public float U10, U11, U12;   // stage 2 direction
    public float U13, U14, U15;   // stage 3 direction
    public float U16, U17, U18;   // stage 1/2/3 speeds
}

// AnimObject/AnimDelta payload (the model-clip player, Unity docs/038): U0 loop mode, U1/U2 play window, U3 rate
// (30 = real-time), U7==4 reversed. Sub256 (the bridge) and Sub257 (the up/down kicker ramps) share the
// identical 44-byte payload, so one DTO carries both ([Trailmap: 230-level-ssf], [Trailmap: 370-world-interaction]).
internal sealed class SsfSubAnim { public float U0, U1, U2, U3, U4, U5, U6, U7; }

// Sub258 AnimCombo: the same eight words as SsfSubAnim, describing an IDLE window, plus four more describing a
// second window of the SAME clip that control command 3 plays over the top of it - U8/U9 its frame bounds
// (U8 < 0 = carry on from the idle window's end, U9 < 0 = to the end of the clip), U10 its rate (30 =
// real-time), and U11 what happens at its end, read for its SIGN: 0 resume the idle and stay retriggerable,
// positive stop with the idle pose, negative stop holding the last combo frame
// ([Trailmap: 230-level-ssf] sub 258, [Trailmap: 150-logic] control command 3).
internal sealed class SsfSubCombo
{
    public float U0, U1, U2, U3, U4, U5, U6, U7, U8, U9, U10, U11;
}

// U3/U4/U5 (the authored throw DIRECTION) are f32, NOT the u32 the extractor/spec [Trailmap: 230-level-ssf]
// read them as: their SSFLogic.json values are the float BIT PATTERNS (e.g. 1128792064 == the bits of 200.0f),
// stored as integers. They read as 0 on every censused level because u32 0 == f32 0.0, so the two readings
// only diverge on an authored NON-zero throw direction, such as a sewer wall's (200,-200,100).
// Typed long here to keep the exact bits; BreakableClassifier.ThrowArray reinterprets them
// back to f32. The sibling velocity/scale fields (U1/U2/U6/U7/U8/U9) are genuine f32.
internal sealed class SsfSub20 { public float U0, U1, U2, U6, U7, U8, U9; public long U3, U4, U5; }

internal sealed class SsfType2
{
    public SsfType2Sub SubType = (SsfType2Sub)(-1);
    public SsfType2Sub0? type2Sub0;         // Sub0: the particle-emitter payload
    public SsfSplineAnim? SplineAnimation;  // Sub1: the spline mover
    public SsfType2Sub2? type2Sub2;         // Sub2: contact-fired emitter; legacy decode preserves its f32 words as i32
}

/// <summary>MainType-3/9 AddDelta: op U0 (2 = grant U1/30 seconds of clip budget to the instance's anim node).</summary>
internal sealed class SsfType3 { public float U0, U1; }

// MainType-2/SubType-1. U1/U2/U5 select the end mode, orientation mode, and yaw offset
// [Trailmap: 230-level-ssf]:
// these re-aim which model axis leads down the track.
// U6/U7 are +0x24/+0x28: the flag that draws the spline itself as a line (a gondola's cable) and that line's alpha.
internal sealed class SsfSplineAnim { public int SplineIndex = -1; public int U1; public int U2; public int InstanceCount = 1; public float AnimationSpeed; public float U5; public int U6; public float U7; public float R; public float G; public float B; }

/// <summary>The semantic P6 emitter law shared by timer (sub-0) and contact (sub-2) nodes.</summary>
internal interface ISsfEmitterPayload
{
    int ParticleCount { get; }
    int TrailCopies { get; }
    float EmissionWindow { get; }
    float TimeScale { get; }
    float SizeCenter { get; }
    float ParticleLifeCenter { get; }
    float SizeSpan { get; }
    float ParticleLifeSpan { get; }
    float TrailSpacing { get; }
    int SpriteIndex { get; }
    float[] Origin();
    float[] SpawnAxisA();
    float[] SpawnAxisB();
    float[] VelocityBase();
    float[] VelocityAxisA();
    float[] VelocityAxisB();
    float[] VelocityAxisC();
    float[] Gravity();
    float[][] ColorStopsRgba();
    int BlendMode();
}

internal static class SsfEmitterFields
{
    static readonly int[] BlendRemap = { 5, 3, 2, 1, 4, 0, 6, 7 };

    public static float FloatFromRawWord(int word) => BitConverter.Int32BitsToSingle(word);
    public static int BlendMode(int selector) =>
        selector >= 0 && selector < BlendRemap.Length ? BlendRemap[selector] : 5;
}

internal sealed class SsfType2Sub0 : ISsfEmitterPayload
{
    // Effects.json retains the lossless SSF offset keys. This internal reader gives every recovered field a
    // semantic name before it crosses into the engine-neutral bundle schema. [Trailmap: 180-particles-data]
    [JsonProperty("U0")] public int ParticleCount;
    [JsonProperty("U1")] public int TrailCopies;
    [JsonProperty("U2")] public float EmissionWindow;
    [JsonProperty("U3")] public float TimeScale;
    [JsonProperty("U4")] public float SizeCenter;
    [JsonProperty("U5")] public float ParticleLifeCenter;
    [JsonProperty("U6")] public float SizeSpan;
    [JsonProperty("U7")] public float ParticleLifeSpan;
    [JsonProperty("U8")] public float TrailSpacing;
    [JsonProperty("U9")] public float OriginX;
    [JsonProperty("U10")] public float OriginY;
    [JsonProperty("U11")] public float OriginZ;
    [JsonProperty("U12")] public float SpawnAxisAX;
    [JsonProperty("U13")] public float SpawnAxisAY;
    [JsonProperty("U14")] public float SpawnAxisAZ;
    [JsonProperty("U15")] public float SpawnAxisBX;
    [JsonProperty("U16")] public float SpawnAxisBY;
    [JsonProperty("U17")] public float SpawnAxisBZ;
    [JsonProperty("U18")] public float VelocityBaseX;
    [JsonProperty("U19")] public float VelocityBaseY;
    [JsonProperty("U20")] public float VelocityBaseZ;
    [JsonProperty("U21")] public float VelocityAxisAX;
    [JsonProperty("U22")] public float VelocityAxisAY;
    [JsonProperty("U23")] public float VelocityAxisAZ;
    [JsonProperty("U24")] public float VelocityAxisBX;
    [JsonProperty("U25")] public float VelocityAxisBY;
    [JsonProperty("U26")] public float VelocityAxisBZ;
    [JsonProperty("U27")] public float VelocityAxisCX;
    [JsonProperty("U28")] public float VelocityAxisCY;
    [JsonProperty("U29")] public float VelocityAxisCZ;
    [JsonProperty("U30")] public float GravityX;
    [JsonProperty("U31")] public float GravityY;
    [JsonProperty("U32")] public float GravityZ;
    // Native A,R,G,B storage is private to this adapter. Every named consumer receives R,G,B,A below.
    [JsonProperty("U33")] float NativeColor0A;
    [JsonProperty("U34")] float NativeColor0R;
    [JsonProperty("U35")] float NativeColor0G;
    [JsonProperty("U36")] float NativeColor0B;
    [JsonProperty("U37")] float NativeColor1A;
    [JsonProperty("U38")] float NativeColor1R;
    [JsonProperty("U39")] float NativeColor1G;
    [JsonProperty("U40")] float NativeColor1B;
    [JsonProperty("U41")] float NativeColor2A;
    [JsonProperty("U42")] float NativeColor2R;
    [JsonProperty("U43")] float NativeColor2G;
    [JsonProperty("U44")] float NativeColor2B;
    [JsonProperty("U45")] float NativeColor3A;
    [JsonProperty("U46")] float NativeColor3R;
    [JsonProperty("U47")] float NativeColor3G;
    [JsonProperty("U48")] float NativeColor3B;
    [JsonProperty("U49")] public int SpriteIndex;
    [JsonProperty("U50")] public int BlendSelector;

    public float[] Origin() => new[] { OriginX, OriginY, OriginZ };
    public float[] SpawnAxisA() => new[] { SpawnAxisAX, SpawnAxisAY, SpawnAxisAZ };
    public float[] SpawnAxisB() => new[] { SpawnAxisBX, SpawnAxisBY, SpawnAxisBZ };
    public float[] VelocityBase() => new[] { VelocityBaseX, VelocityBaseY, VelocityBaseZ };
    public float[] VelocityAxisA() => new[] { VelocityAxisAX, VelocityAxisAY, VelocityAxisAZ };
    public float[] VelocityAxisB() => new[] { VelocityAxisBX, VelocityAxisBY, VelocityAxisBZ };
    public float[] VelocityAxisC() => new[] { VelocityAxisCX, VelocityAxisCY, VelocityAxisCZ };
    public float[] Gravity() => new[] { GravityX, GravityY, GravityZ };

    // The engine remaps the authored selector through this table before configuring the GS blend state.
    public int BlendMode() => SsfEmitterFields.BlendMode(BlendSelector);
    public float[] FirstColorRgb() => new[] { NativeColor0R, NativeColor0G, NativeColor0B };
    public float[][] ColorStopsRgba() => new[]
    {
        new[] { NativeColor0R, NativeColor0G, NativeColor0B, NativeColor0A },
        new[] { NativeColor1R, NativeColor1G, NativeColor1B, NativeColor1A },
        new[] { NativeColor2R, NativeColor2G, NativeColor2B, NativeColor2A },
        new[] { NativeColor3R, NativeColor3G, NativeColor3B, NativeColor3A },
    };

    // The lossless document names these as fields; expose the same values as properties only at the common
    // timer/collision-emitter boundary used by the bundle exporter.
    int ISsfEmitterPayload.ParticleCount => ParticleCount;
    int ISsfEmitterPayload.TrailCopies => TrailCopies;
    float ISsfEmitterPayload.EmissionWindow => EmissionWindow;
    float ISsfEmitterPayload.TimeScale => TimeScale;
    float ISsfEmitterPayload.SizeCenter => SizeCenter;
    float ISsfEmitterPayload.ParticleLifeCenter => ParticleLifeCenter;
    float ISsfEmitterPayload.SizeSpan => SizeSpan;
    float ISsfEmitterPayload.ParticleLifeSpan => ParticleLifeSpan;
    float ISsfEmitterPayload.TrailSpacing => TrailSpacing;
    int ISsfEmitterPayload.SpriteIndex => SpriteIndex;
}

/// <summary>
/// MainType-2/SubType-2 <c>CollideEmitter</c>. The legacy SSF reader correctly preserves all 51 words but
/// declared every one as an integer, so Effects.json contains IEEE-754 bit patterns for U2..U48. Retail ELF
/// tracing shows this is otherwise the exact same P6 law as <see cref="SsfType2Sub0"/>. Keep the document
/// lossless here and reinterpret only at the engine-neutral bundle boundary.
/// </summary>
internal sealed class SsfType2Sub2 : ISsfEmitterPayload
{
    public int U0, U1, U2, U3, U4, U5, U6, U7, U8, U9;
    public int U10, U11, U12, U13, U14, U15, U16, U17, U18, U19;
    public int U20, U21, U22, U23, U24, U25, U26, U27, U28, U29;
    public int U30, U31, U32, U33, U34, U35, U36, U37, U38, U39;
    public int U40, U41, U42, U43, U44, U45, U46, U47, U48, U49, U50;

    static float F(int word) => SsfEmitterFields.FloatFromRawWord(word);

    public int ParticleCount => U0;
    public int TrailCopies => U1;
    public float EmissionWindow => F(U2);
    public float TimeScale => F(U3);
    public float SizeCenter => F(U4);
    public float ParticleLifeCenter => F(U5);
    public float SizeSpan => F(U6);
    public float ParticleLifeSpan => F(U7);
    public float TrailSpacing => F(U8);
    public int SpriteIndex => U49;

    public float[] Origin() => new[] { F(U9), F(U10), F(U11) };
    public float[] SpawnAxisA() => new[] { F(U12), F(U13), F(U14) };
    public float[] SpawnAxisB() => new[] { F(U15), F(U16), F(U17) };
    public float[] VelocityBase() => new[] { F(U18), F(U19), F(U20) };
    public float[] VelocityAxisA() => new[] { F(U21), F(U22), F(U23) };
    public float[] VelocityAxisB() => new[] { F(U24), F(U25), F(U26) };
    public float[] VelocityAxisC() => new[] { F(U27), F(U28), F(U29) };
    public float[] Gravity() => new[] { F(U30), F(U31), F(U32) };
    public int BlendMode() => SsfEmitterFields.BlendMode(U50);
    public float[][] ColorStopsRgba() => new[]
    {
        new[] { F(U34), F(U35), F(U36), F(U33) },
        new[] { F(U38), F(U39), F(U40), F(U37) },
        new[] { F(U42), F(U43), F(U44), F(U41) },
        new[] { F(U46), F(U47), F(U48), F(U45) },
    };
}

internal sealed class SsfPhysicsHeader { public SsfPhysicsData[]? PhysicsDatas; }
internal sealed class SsfPhysicsData
{
    public float UFloat0, UFloat1, UFloat2;   // root centre
    public string? UByteData;                 // base64 RLE occupancy-tree masks
    public SsfPhysStruct[]? uPhysicsStruct0;  // per-depth level table
}
internal sealed class SsfPhysStruct
{
    public float U0;   // leaf radius at this depth
    public float U1;   // per-depth child lattice offset
    public int U2;     // child mask stride
}

#pragma warning restore CS0649
