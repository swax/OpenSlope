using Newtonsoft.Json;
using Snowknife.Engine;

namespace Snowknife.Bundle;

/// <summary>
/// Finds the level's TRIGGERED texture flips - the ride-over buttons that PULSE a second material state while a
/// rider crosses them, then settle back.
///
/// A flipbook material's frame list is a STATE list; what makes it an animation is an effect. The distinction is
/// authored in the SSF as the <c>Sub11 TextureFlip</c> node's <b>Length</b> (its lifetime in seconds):
///
///  - <b>Length == 0</b> - a PERSISTENT flip on the carrier's own <c>PersistantEffectSlot</c>. The node lives as
///    long as its slot, so the material cycles forever: the checkpoint top, the directional signs. Those are the
///    free-running flipbooks, and <c>PropsExporter</c> records their rate in <c>Flip.json</c>.
///  - <b>Length &gt; 0</b> - a collision-fired ONE-SHOT, reached only through a <c>MainType-7</c> hop from a
///    trigger volume's <c>CollisionEffectSlot</c> header. That is this class.
///
/// The one-shot is a PULSE - the surface returns to where it started - and its colour comes from a SECOND node
/// in the same graph:
///
/// <code>
///   node 0: MainType 0 / Sub 11  TextureFlip {U0:0, Direction:0, Speed:3.5, Length:0.5|1.0, U4:0}
///   node 1: MainType 3           {U0:2, U1:1.0}      -- control-op 2 = "select frame 1"
/// </code>
///
/// Both nodes dispatch in the same tick, so the flip node is forced onto the selected frame before it ever renders.
/// It then advances on the ordinary phase accumulator until its lifetime expires, and the authored numbers make
/// that an ODD number of advances - so a two-frame material lands back where it started and the node's death is
/// invisible. Net observable: the material's own frame, a brief flash of the selected one on a crossing, back.
/// Nothing persists between crossings. Verified against retail. [Trailmap: 410-texture-animation]
///
/// MainType-3's control op is shared with the animation nodes, where op 2 grants clip budget instead (Unity docs/038's
/// kickers). Same opcode, different node class - so it must be read against the node the hop targets, never alone.
///
/// The megaplex buttons are the worked example: 77 collision headers, each debounced 3 s, each hopping TWICE - once
/// to pulse ONE visible button, and once to play an AnimObject on the pillars/door/ramp it opens. The colour and
/// the prop are therefore siblings under one crossing, not cause and effect, and the prop is what actually stays
/// open. The buttons carry no effect slot at all, which is why walking an instance's own slot never finds them.
///
/// This layer yields the target instance, the volumes that fire it, and the pulse timeline. Nothing is keyed on a
/// model name - any level that authors a button this way is caught. See Unity docs/008 (texture animation).
/// </summary>
public static class TriggeredFlipClassifier
{
    /// <summary>One pulsing instance: what a crossing shows on it, and the volumes that fire it.</summary>
    public sealed class Pulse
    {
        public int Instance;                     // the visible button instance the flip is played ON
        public List<int> Volumes = new();        // trigger volume instance indices (their meshes are the boxes)
        public float Speed;                      // authored flip rate
        public float Length;                     // node lifetime in seconds (> 0 by construction)
        public int Direction;                    // 0 = forward through the frame list
        public int SelectFrame = -1;             // MainType-3 control-op-2 frame, -1 if the graph selects none
    }

    /// <summary>
    /// Scan every instance's <c>CollisionEffectSlot</c> for MainType-7 hops that play a <c>Length &gt; 0</c>
    /// TextureFlip on a target instance. <paramref name="exclude"/> keeps instances already claimed by another
    /// divert kind out (a breakable/spinner owns its geometry; it must not also become a button).
    /// </summary>
    public static Dictionary<int, Pulse> Classify(string levelDir, List<SsxInstance>? instances, Func<int, bool> exclude)
    {
        var pulses = new Dictionary<int, Pulse>();
        if (instances == null) return pulses;

        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return pulses;

        for (int i = 0; i < instances.Count; i++)
        {
            int e = instances[i].EffectSlotIndex;
            if (e < 0 || e >= root.EffectSlots.Length) continue;
            int ce = root.EffectSlots[e].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var effs = root.EffectHeaders[ce].Effects;
            if (effs == null) continue;

            // A header may pulse the instance it is ATTACHED to, with no hop at all: the collision graph builds
            // the flip node on its own carrier, so the prop is both the trigger and the surface that flashes.
            // Retail never authors this - its buttons are flat decals with a separate volume overhead - but it is
            // the only shape an authored level can express, because Slopesmith's document has no instance table
            // for a hop to name. The engine builds the same node either way.
            var own = FindTriggeredFlip(root.EffectHeaders[ce]);
            if (own != null && !exclude(i) && !pulses.ContainsKey(i))
                pulses[i] = new Pulse
                {
                    Instance = i, Speed = own.Speed, Length = own.Length, Direction = own.Direction,
                    SelectFrame = FindSelectFrame(root.EffectHeaders[ce]),
                    Volumes = { i },
                };

            // The header's own Sub2 Debounce (3 s on every shipped button chain) is deliberately NOT carried: the
            // consumer re-fire interval is a runtime concern shared with the trigger volumes of the prop the same
            // header opens, and reading it here would only desynchronize the two halves of one crossing.
            foreach (var n in effs)
            {
                if (n == null || n.MainType != SsfMainType.ActOnInstance || n.Instance == null) continue;
                int tgt = n.Instance.InstanceIndex, eh = n.Instance.EffectIndex;
                if (tgt < 0 || tgt >= instances.Count || eh < 0 || eh >= root.EffectHeaders.Length) continue;
                if (exclude(tgt)) continue;
                var flip = FindTriggeredFlip(root.EffectHeaders[eh]);
                if (flip == null) continue;

                if (!pulses.TryGetValue(tgt, out var pulse))
                    pulses[tgt] = pulse = new Pulse
                    {
                        Instance = tgt, Speed = flip.Speed, Length = flip.Length, Direction = flip.Direction,
                        SelectFrame = FindSelectFrame(root.EffectHeaders[eh]),
                    };
                if (!pulse.Volumes.Contains(i)) pulse.Volumes.Add(i);
            }
        }
        return pulses;
    }

    // The first Sub11 TextureFlip in a header that is a ONE-SHOT (Length > 0), or null. A Length-0 node reached
    // through a hop would be a persistent flip played on another instance - not a pulse - so it is skipped.
    static SsfTextureFlip? FindTriggeredFlip(SsfHeader h)
    {
        if (h.Effects == null) return null;
        foreach (var n in h.Effects)
            if (n?.MainType == SsfMainType.Property && n.type0 is { SubType: SsfType0Sub.TextureFlip } t
                && t.TextureFlip is { Length: > 0f } f)
                return f;
        return null;
    }

    // The frame a MainType-3/9 control op selects on the flip node sharing this header: op U0 == 2 with U1 = the
    // frame index. On an animation node the same op grants clip budget instead (Unity docs/038), which is why this is
    // only ever read from a header already known to carry a TextureFlip. -1 = none authored.
    static int FindSelectFrame(SsfHeader h)
    {
        if (h.Effects == null) return -1;
        foreach (var n in h.Effects)
            if (n != null && (n.MainType == SsfMainType.AddDelta || n.MainType == SsfMainType.AddDelta9)
                && n.type3 is { } t && (int)t.U0 == 2 && t.U1 >= 0f)
                return (int)t.U1;
        return -1;
    }

    /// <summary>
    /// Replay the engine's flip node over its finite lifetime and return what the surface SHOWS, as a list of
    /// (frame index, hold seconds) segments starting at the crossing.
    ///
    /// The specified texture-flip law [Trailmap: 410-texture-animation]: the node starts on the
    /// control op's selected frame, adds <c>Speed/60</c> to a phase accumulator each tick and steps one frame
    /// whenever the phase crosses 1 (the excess carries, so the rate does not drift), and its <c>killTicks =
    /// (int)(Length x 60)</c> counter is tested at the TOP of the update - so the final tick kills the node
    /// WITHOUT accumulating. Both the increment and the lifetime scale with the same 60, so the frame sequence and
    /// its parity are tick-rate independent; only the wall clock below depends on the tick, which is taken as the
    /// 60 Hz effect thread (its own wait timer counts down 1/60 per call, which is what makes an authored
    /// Debounce 3.0 mean three seconds).
    /// </summary>
    public static (int[] frames, float[] holds) Timeline(Pulse p, int frameCount)
    {
        var frames = new List<int>();
        var holds = new List<float>();
        if (frameCount < 2) return (frames.ToArray(), holds.ToArray());

        int killTicks = (int)(p.Length * 60f);
        float inc = p.Speed / 60f;
        int step = p.Direction == 0 ? 1 : frameCount - 1;   // non-zero Direction runs the list backwards
        int frame = p.SelectFrame >= 0 ? p.SelectFrame % frameCount : 0;

        frames.Add(frame);
        int since = 0;                 // ticks the current frame has been showing
        float accum = 0f;
        for (int tick = 1; tick <= killTicks; tick++)
        {
            since++;
            if (tick == killTicks) break;   // the kill test precedes the accumulate on the final tick
            accum += inc;
            if (accum < 1f) continue;
            accum -= 1f;
            frame = (frame + step) % frameCount;
            holds.Add(since / 60f);
            frames.Add(frame);
            since = 0;
        }
        holds.Add(since / 60f);
        return (frames.ToArray(), holds.ToArray());
    }

    /// <summary>
    /// The MaterialIDs a pulsing instance's model draws with - the materials whose frame list is switched by a
    /// trigger rather than animated. <see cref="MaterialBundle"/> uses this to keep them off the flipbook path.
    /// </summary>
    public static HashSet<int> PulsedMaterials(string levelDir, List<SsxInstance>? instances, IEnumerable<int> pulsed)
    {
        var ids = new HashSet<int>();
        var models = LoadModels(levelDir);
        if (models == null || instances == null) return ids;
        foreach (int i in pulsed)
        {
            if (i < 0 || i >= instances.Count) continue;
            int mi = instances[i].ModelID;
            if (mi < 0 || mi >= models.Count || models[mi].ModelObjects == null) continue;
            foreach (var mo in models[mi].ModelObjects!)
            {
                if (mo?.MeshData == null) continue;
                foreach (var md in mo.MeshData) if (md.MaterialID >= 0) ids.Add(md.MaterialID);
            }
        }
        return ids;
    }

    /// <summary>
    /// The replayed pulse per pulsing instance, ready for the manifest: what its surface shows on a crossing.
    /// Resolves each instance's own flipbook frame count (its model's material) and runs <see cref="Timeline"/>.
    /// An instance whose material has no frame list yields nothing - there is no second state to show.
    /// </summary>
    public static Dictionary<int, (int[] frames, float[] holds)> Timelines(
        string levelDir, List<SsxInstance>? instances, Dictionary<int, Pulse> pulses)
    {
        var outv = new Dictionary<int, (int[], float[])>();
        var models = LoadModels(levelDir);
        var counts = FlipbookFrameCounts(levelDir);
        if (models == null || instances == null) return outv;
        foreach (var kv in pulses)
        {
            int i = kv.Key;
            if (i < 0 || i >= instances.Count) continue;
            int mi = instances[i].ModelID;
            if (mi < 0 || mi >= models.Count || models[mi].ModelObjects == null) continue;
            int frameCount = 0;
            foreach (var mo in models[mi].ModelObjects!)
            {
                if (mo?.MeshData == null) continue;
                foreach (var md in mo.MeshData)
                    if (md.MaterialID >= 0 && counts.TryGetValue(md.MaterialID, out int c) && c > frameCount) frameCount = c;
            }
            if (frameCount < 2) continue;
            var (frames, holds) = Timeline(kv.Value, frameCount);
            if (frames.Length > 0) outv[i] = (frames, holds);
        }
        return outv;
    }

    /// <summary>Frame count of a material's flipbook (0 when it has none), for the timeline replay.</summary>
    static Dictionary<int, int> FlipbookFrameCounts(string levelDir)
    {
        var counts = new Dictionary<int, int>();
        string p = Path.Combine(levelDir, "Materials.json");
        if (!File.Exists(p)) return counts;
        try
        {
            var mats = JsonConvert.DeserializeObject<MatFile>(File.ReadAllText(p))?.Materials;
            if (mats != null)
                for (int i = 0; i < mats.Count; i++) counts[i] = mats[i].TextureFlipbook?.Count ?? 0;
        }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {p} is unreadable ({e.Message}) — no flipbook timelines for trigger-driven flips.");
        }
        return counts;
    }

    static List<Model>? LoadModels(string levelDir)
    {
        string p = Path.Combine(levelDir, "Models.json");
        if (!File.Exists(p)) return null;
        try { return JsonConvert.DeserializeObject<ModelFile>(File.ReadAllText(p))?.Models; }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {p} is unreadable ({e.Message}) — no trigger-driven flips classified.");
            return null;
        }
    }

    // Newtonsoft populates these fields through reflection; direct assignments would only add DTO boilerplate.
#pragma warning disable CS0649
    sealed class ModelFile { public List<Model>? Models; }
    sealed class Model { public List<ModelObj>? ModelObjects; }
    sealed class ModelObj { public List<MeshRef>? MeshData; }
    sealed class MeshRef { public int MaterialID = -1; }
    sealed class MatFile { public List<Mat>? Materials; }
    sealed class Mat { public List<string>? TextureFlipbook; }
#pragma warning restore CS0649
}
