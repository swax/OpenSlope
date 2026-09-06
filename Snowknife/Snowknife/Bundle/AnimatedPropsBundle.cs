using System.Globalization;
using System.Numerics;
using Newtonsoft.Json;
using Snowknife.Engine;

namespace Snowknife.Bundle;

/// <summary>
/// Bakes the level's ANIMATED world props (a swinging rope bridge; up/down kicker ramps)
/// into the bundle. A prop animates when a persistent SSF effect plays an <c>AnimObject</c> (<c>type0 Sub256</c>)
/// or <c>AnimDelta</c> (<c>type0 Sub257</c>) node on it: the node runs the MODEL's own object-hierarchy clip from
/// Models.json - per ModelObject a base translation plus piecewise-cubic channels selected by the
/// <c>AnimationAction</c> bitmask (bit 3 = X rotation, bit 4 = Y rotation, ... sampled in DEGREES at absolute
/// clip time). An animated object's ROTATION is built from its channels alone: an unchannelled component is
/// zero, and neither the base Euler nor the object's rest matrix reaches the pose [Trailmap: 120-objects].
/// AnimObject and AnimDelta share the same 44-byte payload and clip player (they differ only for a
/// non-zero object rest pose - additive vs absolute - which no observed carrier has), so both classify here.
/// The kicker is a SINGLE visible+collidable instance (a ramp you both see and ride, hinged ~27 deg ping-pong);
/// unlike the bridge's separate sway/surface pair it carries its own moving collider (PlayerCollision).
/// See the AnimObject (type0 Sub256) world-prop animation [Trailmap: 370-world-interaction]
/// and [Trailmap: 230-level-ssf] (256 AnimObject, 257 AnimDelta, 258 AnimCombo).
///
/// The bridge pattern is two stacked instances: a visible mesh with NO collision (bridgesway) and an invisible
/// <c>CollsionMode 1</c> collision twin (bridgesurface) whose persistent chain plays the IDENTICAL Sub256 via a
/// MainType-7 hop - so collision swings in sync with the render. Both classify here; the collision twin's
/// segments emit as position-only double-sided meshes the importer turns into moving MeshColliders.
///
/// Geometry comes from the per-object exports (<c>Meshes/&lt;n&gt;.obj</c>, model-local, pivots at the model
/// origin) - NOT from the merged Props.obj group (which bakes the rest pose into world space). Each segment
/// becomes its own glb node ("Anim_{inst}_o{obj}", model-local mesh space) + a manifest record carrying the
/// hierarchy, rest pose, and the mirrored cubic channels; the importer builds the GameObject chain and a
/// runtime sampler drives it. Classification yields to spinner/physics/breakable (a trick gem's spin is also
/// an AnimObject, but gems are spinners).
/// </summary>
public static class AnimatedPropsBundle
{
    public sealed class Opts
    {
        public float Scale = 0.01f;
        public bool Build = true;
        public Vector3 PropDirLightDir = new(-0.48f, 0.88f, 0f);
    }

    public sealed class Result
    {
        public List<GltfMeshWriter.Node> Nodes = new();
        public List<BundleManifest.AnimPropInfo> Records = new();
        public string Stats = "";
    }

    // ---- classification: which instances have a persistent AnimObject ------------------------------------

    /// <summary>
    /// Instance index -> the AnimObject/AnimDelta payload [U0..U7] that animates it. Three passes:
    /// (1) PERSISTENT - walk each instance's PersistantEffectSlot chain; a Sub256 (AnimObject) or Sub257
    /// (AnimDelta) claims the bound instance, a MainType-7 hop re-binds to its target (the bridge's collision-twin
    /// sync). A Sub256 free-runs; a Sub257 is DELTA-GATED - its clip clock advances only while a poke budget is
    /// positive, so it starts frozen (<paramref name="gated"/>; SelfPulse = its own header also carries a
    /// MainType-3/9 AddDelta, granting one poke per region activation - the centre kicker). (2) TRIGGERED - a
    /// COLLISION trigger volume's slot carries a CollisionEffectSlot header that MainType-7 plays an AnimObject
    /// effect ON a target instance (e.g. an iris door): the target starts at rest and plays its clip once
    /// when a rider crosses any trigger volume. (3) POKE TRIGGERS - a collision header whose MainType-7 targets a
    /// header of bare MainType-3/9 AddDelta nodes grants budget to each target's AnimDelta (the landing
    /// triggers poking all three kickers): those volumes land in <paramref name="triggered"/> too, against their
    /// delta-gated targets. <paramref name="exclude"/> keeps already-diverted kinds out of every pass.
    /// </summary>
    public static Dictionary<int, float[]> Classify(string levelDir, List<SsxInstance>? instances,
                                                    Func<int, bool> exclude, out Dictionary<int, List<int>> triggered,
                                                    out Dictionary<int, (bool selfPulse, float pokeSeconds)> gated,
                                                    out HashSet<int> combos)
    {
        var map = new Dictionary<int, float[]>();
        triggered = new Dictionary<int, List<int>>();
        gated = new Dictionary<int, (bool, float)>();
        combos = new HashSet<int>();
        if (instances == null) return map;

        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return map;

        // Pass 1: persistent AnimObject/AnimDelta (the bridge, the kickers) - bound to the carrier instance.
        for (int i = 0; i < instances.Count; i++)
        {
            int e = instances[i].EffectSlotIndex;
            if (e < 0 || e >= root.EffectSlots.Length) continue;
            int pe = root.EffectSlots[e].PersistantEffectSlot;
            if (pe < 0 || pe >= root.EffectHeaders.Length) continue;
            Walk(root.EffectHeaders, pe, i, map, gated, 0);
        }

        // Pass 1b: an AnimCombo's own contact. A combo prop free-runs its IDLE window and plays its second
        // window on control command 3, and retail sends that command from the prop's OWN collision chain
        // (Aloha slot 37: persistent = the Sub258, collision = MainType-3 {cmd 3}). So the trigger volume IS the
        // barrier - it registers itself, and the box builder makes one from its own geometry. Anything reached
        // by a MainType-7 hop is picked up by pass 2 below, which already walks that shape.
        foreach (int idx in map.Keys.Where(k => map[k].Length >= 12).ToList())
        {
            combos.Add(idx);
            int e = instances[idx].EffectSlotIndex;
            if (e < 0 || e >= root.EffectSlots.Length) continue;
            int ce = root.EffectSlots[e].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length || !SendsComboTrigger(root.EffectHeaders[ce])) continue;
            if (!triggered.TryGetValue(idx, out var own)) { own = new List<int>(); triggered[idx] = own; }
            if (!own.Contains(idx)) own.Add(idx);
        }

        // Pass 2: triggered AnimObject (e.g. the iris door). Each trigger volume instance's CollisionEffectSlot header
        // MainType-7 hops to (target instance, effect header); if that header plays a Sub256/257, the TARGET is a
        // triggered animated prop and THIS instance is one of its trigger volumes. The target keeps any persistent
        // payload it already has (pass 1 wins); a purely triggered prop takes its payload from the played effect.
        for (int i = 0; i < instances.Count; i++)
        {
            int e = instances[i].EffectSlotIndex;
            if (e < 0 || e >= root.EffectSlots.Length) continue;
            int ce = root.EffectSlots[e].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var effs = root.EffectHeaders[ce].Effects;
            if (effs == null) continue;
            foreach (var n in effs)
            {
                if (n == null || n.MainType != SsfMainType.ActOnInstance || n.Instance == null) continue;
                int tgt = n.Instance.InstanceIndex, eh = n.Instance.EffectIndex;
                if (tgt < 0 || tgt >= instances.Count || eh < 0 || eh >= root.EffectHeaders.Length) continue;
                float[]? payload = FindAnim(root.EffectHeaders[eh]);
                if (payload == null || exclude(tgt)) continue;
                if (!map.ContainsKey(tgt)) map[tgt] = payload;
                if (!triggered.TryGetValue(tgt, out var vols)) { vols = new List<int>(); triggered[tgt] = vols; }
                if (!vols.Contains(i)) vols.Add(i);
            }
        }

        // Pass 3: poke-trigger volumes (the landing triggers). A collision header's MainType-7 hops to a
        // header of bare MainType-3/9 AddDelta nodes: each hop's TARGET instance (if delta-gated from pass 1) gains
        // this instance as a poke volume - crossing it grants the target's AnimDelta its budget.
        for (int i = 0; i < instances.Count; i++)
        {
            int e = instances[i].EffectSlotIndex;
            if (e < 0 || e >= root.EffectSlots.Length) continue;
            int ce = root.EffectSlots[e].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var effs = root.EffectHeaders[ce].Effects;
            if (effs == null) continue;
            foreach (var n in effs)
            {
                if (n == null || n.MainType != SsfMainType.ActOnInstance || n.Instance == null) continue;
                int tgt = n.Instance.InstanceIndex, eh = n.Instance.EffectIndex;
                if (tgt < 0 || tgt >= instances.Count || eh < 0 || eh >= root.EffectHeaders.Length) continue;
                float poke = FindAddDelta(root.EffectHeaders[eh]);
                if (poke <= 0f || !gated.TryGetValue(tgt, out var g) || exclude(tgt)) continue;
                if (!g.selfPulse) gated[tgt] = (false, poke);   // poke grant comes from the trigger's AddDelta
                if (!triggered.TryGetValue(tgt, out var vols)) { vols = new List<int>(); triggered[tgt] = vols; }
                if (!vols.Contains(i)) vols.Add(i);
            }
        }

        foreach (int k in map.Keys.Where(exclude).ToList()) { map.Remove(k); triggered.Remove(k); gated.Remove(k); }
        return map;
    }

    // Clip-seconds granted by the first MainType-3/9 AddDelta ({U0:2, U1:frames}) in a header, or 0. U1 is in
    // 30fps frames (the engine grants U1/30 seconds of clip budget per dispatch).
    static float FindAddDelta(SsfHeader h)
    {
        if (h.Effects == null) return 0f;
        foreach (var n in h.Effects)
            if (n != null && (n.MainType == SsfMainType.AddDelta || n.MainType == SsfMainType.AddDelta9) && n.type3 is { } t && (int)t.U0 == 2 && t.U1 > 0f)
                return t.U1 / 30f;
        return 0f;
    }

    // True when a header dispatches the AnimCombo trigger - a MainType-3/9 bound-node control carrying command
    // 3. Which receiver a command reaches is decided by the receiver, not the message [Trailmap: 150-control], so
    // this is only read against a prop already known to carry a Sub258.
    static bool SendsComboTrigger(SsfHeader h)
    {
        if (h.Effects == null) return false;
        foreach (var n in h.Effects)
            if (n != null && (n.MainType == SsfMainType.AddDelta || n.MainType == SsfMainType.AddDelta9)
                && n.type3 is { } t && (int)t.U0 == 3) return true;
        return false;
    }

    // The animation payload of the first Sub256/257/258 node in a header, or null. Sub256/257 yield [U0..U7];
    // a Sub258 AnimCombo yields [U0..U11] - the same eight words plus its triggered window - and the extra
    // length is what tells `Build` which it has.
    static float[]? FindAnim(SsfHeader h)
    {
        if (h.Effects == null) return null;
        foreach (var n in h.Effects)
        {
            if (n?.MainType != SsfMainType.Property) continue;
            if (n.type0?.type0Sub258 is { } c)
                return new[] { c.U0, c.U1, c.U2, c.U3, c.U4, c.U5, c.U6, c.U7, c.U8, c.U9, c.U10, c.U11 };
            var s = n.type0?.type0Sub256 ?? n.type0?.type0Sub257;
            if (s != null) return new[] { s.U0, s.U1, s.U2, s.U3, s.U4, s.U5, s.U6, s.U7 };
        }
        return null;
    }

    static void Walk(SsfHeader[] EH, int hdr, int boundInstance, Dictionary<int, float[]> map,
                     Dictionary<int, (bool selfPulse, float pokeSeconds)> gated, int depth)
    {
        if (hdr < 0 || hdr >= EH.Length || depth > 3) return;
        var effs = EH[hdr].Effects;
        if (effs == null) return;
        foreach (var n in effs)
        {
            if (n == null) continue;
            var combo = n.type0?.type0Sub258;                          // AnimCombo (the Aloha barriers)
            var anim = n.type0?.type0Sub256 ?? n.type0?.type0Sub257;   // AnimObject (bridge) or AnimDelta (kicker)
            if (n.MainType == SsfMainType.Property && combo is { } cb && !map.ContainsKey(boundInstance))
                map[boundInstance] = new[] { cb.U0, cb.U1, cb.U2, cb.U3, cb.U4, cb.U5,
                                             cb.U6, cb.U7, cb.U8, cb.U9, cb.U10, cb.U11 };
            else if (n.MainType == SsfMainType.Property && anim is { } s && !map.ContainsKey(boundInstance))
            {
                map[boundInstance] = new[] { s.U0, s.U1, s.U2, s.U3, s.U4, s.U5, s.U6, s.U7 };
                // Sub257 AnimDelta = delta-gated (starts frozen; pokes advance it). An AddDelta in the SAME
                // header self-pokes once per region activation - the centre kicker's [Sub257][M3 +1s] pattern.
                if (n.type0?.type0Sub256 == null)
                {
                    float poke = FindAddDelta(EH[hdr]);
                    gated[boundInstance] = (poke > 0f, poke > 0f ? poke : 1f);
                }
            }
            else if (n.MainType == SsfMainType.ActOnInstance && n.Instance != null && n.Instance.EffectIndex >= 0)
                Walk(EH, n.Instance.EffectIndex, n.Instance.InstanceIndex, map, gated, depth + 1);
        }
    }

    // ---- build: per-object segment nodes + manifest records ----------------------------------------------

    // breakOwned: instance indices whose clip is the ROLL phase of a breakable cluster (Unity docs/036 - the globe
    // sign). BundleExporter merges their Sub256 payload into animMap from the break classifier (the generic
    // Classify excludes breakables); their records bake segments+curves like any triggered prop but carry no
    // trigger volumes and no collision - the breakable behaviour triggers and resets them.
    public static Result Build(string levelDir, List<SsxInstance> instances,
                               Dictionary<int, float[]> animMap, Dictionary<int, List<int>> triggered,
                               Dictionary<int, (bool selfPulse, float pokeSeconds)> gated, Opts o,
                               HashSet<int>? breakOwned = null, HashSet<int>? combos = null,
                               HashSet<int>? breakIdle = null)
    {
        var result = new Result();
        var models = LoadModels(levelDir);
        if (models == null || animMap.Count == 0) { result.Stats = "0 animated props."; return result; }

        int built = 0, segs = 0, dropped = 0;
        foreach (var (idx, sub256) in animMap.OrderBy(kv => kv.Key))
        {
            bool isCombo = sub256.Length >= 12 && (combos?.Contains(idx) ?? true);
            var inst = instances[idx];
            var model = (inst.ModelID >= 0 && inst.ModelID < models.Count) ? models[inst.ModelID] : null;
            if (model?.ModelObjects == null || model.AnimTime <= 0f ||
                !model.ModelObjects.Any(mo => mo?.Animation?.AnimationEntries is { Count: > 0 }))
            { dropped++; continue; }   // a Sub256 on a clip-less model is a no-op - leave the prop static

            // Uniform instance scale baked into verts + rest translations (animated rotation happens INSIDE
            // the instance transform, so per-axis scale would not commute; every observed instance is ~1).
            float scale = inst.Scale is { Length: >= 3 } sc ? sc[1] : 1f;

            var rec = new BundleManifest.AnimPropInfo
            {
                Index = idx,
                Name = inst.InstanceName ?? $"inst{idx}",
                Model = model.ModelName ?? "",
                Visible = inst.Visable,
                Center = BundleSpace.Xyz(BundleSpace.MeshPt(inst.Location)),
                Rotation = MirrorQuat(inst.Rotation),
                SurfaceType = inst.SurfaceType,
                CollisonSound = inst.CollisonSound,
                SoundClip = inst.SoundClip,
                PlayerCollision = inst.PlayerCollision,
                Bounce = inst.PlayerBounceAmmount,
                ClipLength = model.AnimTime / 30f,                       // 30 fps frames -> seconds
                LoopMode = (int)sub256[0],                               // 1 wrap | 2 ping-pong | else once
                Rate = sub256[3] > 0f ? sub256[3] / 30f : 1f,            // 30 = real-time
                Reverse = (int)sub256[7] == 4,
                Triggered = triggered.ContainsKey(idx) && !gated.ContainsKey(idx) && !isCombo,
                DeltaGated = gated.ContainsKey(idx),                     // AnimDelta: budget-gated, starts frozen
                SelfPulse = gated.TryGetValue(idx, out var g) && g.selfPulse,
                PokeSeconds = gated.TryGetValue(idx, out var g2) ? g2.pokeSeconds : 0f,
            };
            // AnimCombo (Sub258): the idle window free-runs like an AnimObject, and a SECOND window of the same
            // clip plays over the top of it on control command 3 [Trailmap: 230-level-ssf sub 258]. Both windows
            // are authored in 30 fps frames; the manifest carries seconds like every other clip time here.
            if (isCombo)
            {
                rec.Combo = true;
                // A negative start means "carry on from where the idle window stops"; a negative end, "run to the
                // end of the clip". The two fallbacks differ, so they are spelled out separately.
                rec.ComboStart = (sub256[8] < 0f ? (sub256[2] < 0f ? model.AnimTime : sub256[2]) : sub256[8]) / 30f;
                rec.ComboEnd = (sub256[9] < 0f ? model.AnimTime : sub256[9]) / 30f;
                rec.ComboRate = sub256[10] > 0f ? sub256[10] / 30f : 1f;
                rec.ComboEndMode = Math.Sign((int)sub256[11]);            // 0 resume | 1 freeze | -1 hold the combo pose
                // The idle loop is the FIRST window, not the whole clip: left at the full AnimTime the loop would
                // play the reaction as part of the idle. As with Sub256/257 here, a non-zero window START is not
                // carried - the player loops 0..ClipLength - and every authored node in the corpus leaves it at 0.
                rec.ClipLength = (sub256[2] < 0f ? model.AnimTime : sub256[2]) / 30f;
            }
            // U6 randomises the starting phase, and it is authored well beyond the combos: Aloha alone has 13
            // penguins and 7 boats asking for it. The consumer runs free-running clips off a shared world clock
            // with no per-instance phase of its own, so one is baked here - deterministic in the instance index,
            // so a re-import does not reshuffle the course. Only the free-running player reads it; a triggered
            // roll or a delta-gated kicker runs its own clock and is unaffected. Set AFTER the combo block,
            // which is what settles ClipLength for a combo.
            if ((int)sub256[6] != 0 && rec.ClipLength > 0f)
                rec.PhaseOffset = (float)(((idx * 2654435761L) % 100000L) / 100000.0) * rec.ClipLength;
            ApplyLighting(rec, inst, o);

            // Break-owned roll (Unity docs/036): held at frame 0 until the breakable fires it, so Triggered - but the
            // breakable behaviour is the trigger (no volumes of its own) and the prop must stay smash-THROUGH
            // (its collision is already skipped via the brk_ breakSet), so no moving colliders either.
            //
            // A break-owned IDLE is the same ownership with the opposite clock: the penguin waddles from the
            // moment it loads and the break simply hides it, so it must NOT be held at frame 0 waiting for a
            // trigger that (for these props) never comes.
            if (breakOwned != null && breakOwned.Contains(idx))
            {
                rec.Triggered = !(breakIdle?.Contains(idx) ?? false);
                rec.BreakOwned = true;
                rec.PlayerCollision = false;
            }

            // A triggered prop's trigger volumes: invisible boxes a rider crosses to fire it (the importer builds a
            // BoxCollider per box wired to the prop). Mesh-space AABB from each volume instance's geometry.
            if (triggered.TryGetValue(idx, out var vols))
                foreach (int ti in vols)
                {
                    if (ti < 0 || ti >= instances.Count) continue;
                    var box = TriggerBox(levelDir, models, instances[ti]);
                    if (box != null) (rec.Triggers ??= new List<BundleManifest.AnimTriggerBox>()).Add(box);
                }

            for (int k = 0; k < model.ModelObjects.Count; k++)
            {
                var mo = model.ModelObjects[k];
                var seg = new BundleManifest.AnimSegInfo
                {
                    Parent = mo?.ParentID ?? -1,
                    // The manifest field names say "Rest" for wire compatibility; what they carry is the
                    // animation BASE (see BasePos/BaseEuler).
                    RestPos = BasePos(mo, scale),
                    RestEuler = BaseEuler(mo),
                    RestRotation = BaseRotation(mo),
                    RestScale = ObjectScale(mo),
                    Curves = Curves(mo),
                };
                if (mo?.MeshData is { Count: > 0 })
                {
                    var node = BuildSegmentNode(levelDir, $"Anim_{idx}_o{k}", mo, inst, scale);
                    if (node != null) { result.Nodes.Add(node); seg.Node = node.Name; segs++; }
                }
                rec.Segments.Add(seg);
            }
            result.Records.Add(rec);
            built++;
        }

        result.Stats = $"{built} animated prop(s), {segs} segment meshes" +
                       (dropped > 0 ? $" ({dropped} Sub256 instance(s) without a model clip left static)" : "") + ".";
        return result;
    }

    // One ModelObject's mesh(es) -> a glb node. Model-local verts (pivot = model origin), X mirrored, uniform
    // scale baked. Visible: full render prim per MaterialID ("mat_{id}" - resolves through manifest.Materials)
    // with native normal splits. Exact ambient + three keys/directions travel in the manifest and the importer
    // installs them as live shader inputs, so an animated segment turns beneath a fixed world light. Invisible
    // collision twin: position-only, double-sided.
    static GltfMeshWriter.Node? BuildSegmentNode(string levelDir, string name, SsxModelObject mo,
                                                  SsxInstance inst, float scale)
    {
        var node = new GltfMeshWriter.Node { Name = name };
        foreach (var md in mo.MeshData!)
        {
            if (string.IsNullOrEmpty(md?.MeshPath)) continue;
            string path = Path.Combine(levelDir, "Meshes", md.MeshPath);
            if (!File.Exists(path)) continue;
            var (pos, uv, nrm, tris) = ReadObj(path, scale);
            if (pos.Count == 0 || tris.Count == 0) continue;

            if (!inst.Visable)
            {
                var dbl = new List<int>(tris.Count * 2);
                for (int t = 0; t + 2 < tris.Count; t += 3)
                {
                    dbl.Add(tris[t]); dbl.Add(tris[t + 1]); dbl.Add(tris[t + 2]);
                    dbl.Add(tris[t]); dbl.Add(tris[t + 2]); dbl.Add(tris[t + 1]);
                }
                node.Prims.Add(new GltfMeshWriter.Prim { Material = "collision", Positions = pos, Indices = dbl });
                continue;
            }

            node.Prims.Add(new GltfMeshWriter.Prim
            {
                Material = "mat_" + md.MaterialID,
                Positions = pos, Normals = nrm, Uv0 = uv, Indices = tris,
            });
        }
        return node.Prims.Count > 0 ? node : null;
    }

    // ---- pose + channel mirroring (engine model space -> SSX mesh space = negate X) -----------------------
    // Mirror rules: translation (x,y,z) -> (-x,y,z); rotation about X keeps its sign, rotations about Y/Z
    // negate; quaternion (x,y,z,w) -> (x,-y,-z,w). Curves are mirrored HERE so consumers just evaluate.

    /// <summary>
    /// The pose a playing clip is built FROM: the animation base (U1-U3), not the object's rest matrix. The
    /// engine replaces a base component with its channel's sample and never reads the rest matrix for posing,
    /// so writing the rest here would place an authored clip's part somewhere it does not belong. An object
    /// with no animation block has no base, and falls back to its rest translation because that IS its pose.
    /// </summary>
    static float[] BasePos(SsxModelObject? mo, float scale)
    {
        var a = mo?.Animation;
        if (a != null) return new[] { -a.U1 * scale, a.U2 * scale, a.U3 * scale };
        var p = mo?.Position;
        return p is { Length: >= 3 } ? new[] { -p[0] * scale, p[1] * scale, p[2] * scale } : new float[3];
    }

    /// <summary>
    /// The rotation an animated object starts from, which is ZERO on every component.
    ///
    /// The engine builds an animated object's rotation from its channels alone: a component carrying a curve
    /// takes its value from that curve, and a component without one is zero — neither the base Euler (U4-U6)
    /// nor the object's rest rotation reaches the pose [Trailmap: 120-objects]. Shipped levels never depend on
    /// this because they channel every non-zero rotation component they author, so emitting zero here matches
    /// both the disc and retail content.
    /// </summary>
    static float[] BaseEuler(SsxModelObject? mo) => new float[3];

    /// <summary>
    /// Exact hierarchy rotation used before any channel sampling. An animated native object starts from the
    /// channel Euler tuple above, but a mesh-less static mount (the Snowcap Scrambler's 90-degree platform
    /// basis is the important authored case) keeps its rest quaternion. Mirror it once into bundle space.
    /// </summary>
    static float[] BaseRotation(SsxModelObject? mo) => mo?.Animation == null
        ? MirrorQuat(mo?.Rotation)
        : new[] { 0f, 0f, 0f, 1f };

    static float[] ObjectScale(SsxModelObject? mo) =>
        mo?.Scale is { Length: >= 3 } s ? new[] { s[0], s[1], s[2] } : new[] { 1f, 1f, 1f };

    // AnimationAction is a channel BITMASK walked LSB->MSB, one AnimationEntries[] per set bit in bit order.
    // Bit -> pose component: 0-2 = translation x/y/z (model units), 3-5 = rotation x/y/z (sampled in DEGREES).
    // Only bit 3 (X rotation) is observed in the data; the 0-2/4-5 mapping follows the same ordering.
    static List<BundleManifest.AnimCurveInfo>? Curves(SsxModelObject? mo)
    {
        var a = mo?.Animation;
        if (a?.AnimationEntries is not { Count: > 0 } entries || a.AnimationAction == 0) return null;
        var list = new List<BundleManifest.AnimCurveInfo>();
        int entry = 0;
        for (int bit = 0; bit < 6 && entry < entries.Count; bit++)
        {
            if ((a.AnimationAction & (1 << bit)) == 0) continue;
            var maths = entries[entry++]?.AnimationMaths;
            if (maths == null || maths.Count == 0) continue;
            bool negate = bit == 0 || bit == 4 || bit == 5;   // tx, ry, rz flip under the X mirror
            var segsOut = new List<float[]>(maths.Count);
            foreach (var m in maths)
            {
                float s = negate ? -1f : 1f;
                segsOut.Add(new[] { s * m.Value1, s * m.Value2, s * m.Value3, s * m.Value4, m.Value5, m.Value6 });
            }
            list.Add(new BundleManifest.AnimCurveInfo { Target = bit, Segs = segsOut });
        }
        return list.Count > 0 ? list : null;
    }

    static float[] MirrorQuat(float[]? r) =>
        r is { Length: >= 4 } ? new[] { r[0], -r[1], -r[2], r[3] } : new[] { 0f, 0f, 0f, 1f };

    /// <summary>
    /// Trigger boxes for an arbitrary set of volume instances, in the same convention the animated props use -
    /// so every consumer of an SSF collision volume (the iris door's openers, the kicker pokes, the megaplex
    /// buttons' flip triggers) gets an identically-derived box. Models.json is read ONCE for the whole set.
    /// Volumes whose model has no mesh are absent from the result.
    /// </summary>
    internal static Dictionary<int, BundleManifest.AnimTriggerBox> TriggerBoxes(
        string levelDir, List<SsxInstance> instances, IEnumerable<int> volumes)
    {
        var boxes = new Dictionary<int, BundleManifest.AnimTriggerBox>();
        var models = LoadModels(levelDir);
        if (models == null) return boxes;
        foreach (int vi in volumes.Distinct())
        {
            if (vi < 0 || vi >= instances.Count || boxes.ContainsKey(vi)) continue;
            var box = TriggerBox(levelDir, models, instances[vi]);
            if (box != null) boxes[vi] = box;
        }
        return boxes;
    }

    // A trigger volume instance's box in UNSCALED mesh space (the level root applies the 0.01 like rec.Center):
    // the model's own mesh AABB (read model-local, X-mirrored, scale 1) offset by the instance's mesh-space pivot.
    // Same convention as the firework trigger boxes (ParticleBundle); the importer makes a BoxCollider(isTrigger).
    static BundleManifest.AnimTriggerBox? TriggerBox(string levelDir, List<SsxModel> models, SsxInstance inst)
    {
        var model = (inst.ModelID >= 0 && inst.ModelID < models.Count) ? models[inst.ModelID] : null;
        if (model?.ModelObjects == null) return null;
        Vector3 mn = new(float.MaxValue, float.MaxValue, float.MaxValue);
        Vector3 mx = new(float.MinValue, float.MinValue, float.MinValue);
        bool has = false;
        foreach (var mo in model.ModelObjects)
        {
            if (mo?.MeshData == null) continue;
            foreach (var md in mo.MeshData)
            {
                if (string.IsNullOrEmpty(md?.MeshPath)) continue;
                string path = Path.Combine(levelDir, "Meshes", md.MeshPath);
                if (!File.Exists(path)) continue;
                var (pos, _, _, _) = ReadObj(path, 1f);   // model-local mesh space, UNSCALED
                foreach (var p in pos) { mn = Vector3.Min(mn, p); mx = Vector3.Max(mx, p); has = true; }
            }
        }
        if (!has) return null;
        Vector3 pivot = BundleSpace.MeshPt(inst.Location);
        return new BundleManifest.AnimTriggerBox
        {
            Center = BundleSpace.Xyz(pivot + (mn + mx) * 0.5f),
            Size = BundleSpace.Xyz(mx - mn),
            Rotation = MirrorQuat(inst.Rotation),
            CollisonSound = inst.CollisonSound,
            SoundClip = inst.SoundClip,
        };
    }

    // ---- per-object OBJ reader (model-local "v -x y z" with the X mirror + uniform scale) -----------------
    static (List<Vector3> pos, List<Vector2> uv, List<Vector3> nrm, List<int> tris) ReadObj(string path, float scale)
    {
        var rawPos = new List<Vector3>(); var rawUv = new List<Vector2>(); var rawNrm = new List<Vector3>();
        var pos = new List<Vector3>(); var uv = new List<Vector2>(); var nrm = new List<Vector3>(); var tris = new List<int>();
        var vmap = new Dictionary<(int v, int vt, int vn), int>();

        int Vert(string tok)
        {
            int s1 = tok.IndexOf('/');
            int vi, ti = -1, ni = -1;
            if (s1 < 0) { if (!int.TryParse(tok, out vi)) return -1; }
            else
            {
                if (!int.TryParse(tok.AsSpan(0, s1), out vi)) return -1;
                int s2 = tok.IndexOf('/', s1 + 1);
                var tt = s2 < 0 ? tok.AsSpan(s1 + 1) : tok.AsSpan(s1 + 1, s2 - s1 - 1);
                // A token that fails to parse reads as 0, outside the 1-based OBJ index space; the line below
                // already turns that into "absent".
                if (tt.Length > 0) _ = int.TryParse(tt, out ti);
                if (s2 >= 0)
                {
                    var nn = tok.AsSpan(s2 + 1);
                    if (nn.Length > 0) _ = int.TryParse(nn, out ni);
                }
            }
            vi -= 1; ti = ti > 0 ? ti - 1 : -1; ni = ni > 0 ? ni - 1 : -1;
            if (vi < 0 || vi >= rawPos.Count) return -1;
            var key = (vi, ti, ni);
            if (vmap.TryGetValue(key, out int i)) return i;
            i = pos.Count;
            pos.Add(rawPos[vi]);
            // OBJ vt is bottom-left origin; store glTF top-left so the Unity loader's (1-v) flip restores it.
            uv.Add(ti >= 0 && ti < rawUv.Count ? new Vector2(rawUv[ti].X, 1f - rawUv[ti].Y) : Vector2.Zero);
            nrm.Add(ni >= 0 && ni < rawNrm.Count ? rawNrm[ni] : Vector3.Zero);
            vmap[key] = i;
            return i;
        }

        foreach (var line in File.ReadLines(path))
        {
            if (line.Length < 2) continue;
            if (line[0] == 'v' && line[1] == ' ')
            {
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length >= 4) rawPos.Add(new Vector3(-PF(p[1]) * scale, PF(p[2]) * scale, PF(p[3]) * scale));
            }
            else if (line[0] == 'v' && line[1] == 't')
            {
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length >= 3) rawUv.Add(new Vector2(PF(p[1]), PF(p[2])));
            }
            else if (line[0] == 'v' && line[1] == 'n')
            {
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length >= 4)
                {
                    Vector3 n = new(-PF(p[1]), PF(p[2]), PF(p[3]));
                    rawNrm.Add(n.LengthSquared() > 1e-12f ? Vector3.Normalize(n) : Vector3.Zero);
                }
            }
            else if (line[0] == 'f' && line[1] == ' ')
            {
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length < 4) continue;
                int v0 = Vert(p[1]);
                for (int k = 2; k < p.Length - 1; k++)
                {
                    int v1 = Vert(p[k]), v2 = Vert(p[k + 1]);
                    if (v0 >= 0 && v1 >= 0 && v2 >= 0) { tris.Add(v0); tris.Add(v1); tris.Add(v2); }
                }
            }
        }
        var fallback = OutwardNormals(pos, tris);
        for (int i = 0; i < nrm.Count; i++)
            nrm[i] = nrm[i].LengthSquared() > 1e-12f ? Vector3.Normalize(nrm[i]) : fallback[i];
        return (pos, uv, nrm, tris);
    }

    static Vector3[] OutwardNormals(List<Vector3> p, List<int> tris)
    {
        var nrm = new Vector3[p.Count];
        for (int i = 0; i + 2 < tris.Count; i += 3)
        {
            int a = tris[i], b = tris[i + 1], c = tris[i + 2];
            Vector3 fn = Vector3.Cross(p[b] - p[a], p[c] - p[a]);
            nrm[a] += fn; nrm[b] += fn; nrm[c] += fn;
        }
        for (int i = 0; i < nrm.Length; i++)
            nrm[i] = nrm[i].LengthSquared() > 1e-12f ? -Vector3.Normalize(nrm[i]) : new Vector3(0, 1, 0);
        return nrm;
    }

    static void ApplyLighting(BundleManifest.AnimPropInfo record, SsxInstance instance, Opts o)
    {
        Vector3 ws = o.PropDirLightDir;
        Vector3 fallback = new(ws.X, -ws.Z, ws.Y);
        if (fallback.LengthSquared() > 1e-12f) fallback = Vector3.Normalize(fallback); else fallback = Vector3.UnitZ;
        Vector3 ambient = PropLighting.Ambient(instance);
        var k1 = PropLighting.GetKey(instance, 0, fallback);
        var k2 = PropLighting.GetKey(instance, 1, fallback);
        var k3 = PropLighting.GetKey(instance, 2, fallback);
        record.Ambient = A(ambient);
        record.Key1 = A(k1.Colour); record.Key2 = A(k2.Colour); record.Key3 = A(k3.Colour);
        record.Direction1 = A(k1.MeshDirection); record.Direction2 = A(k2.MeshDirection); record.Direction3 = A(k3.MeshDirection);
    }

    static float[] A(Vector3 v) => new[] { v.X, v.Y, v.Z };
    static float PF(string s) => float.Parse(s, CultureInfo.InvariantCulture);

    // ---- Models.json DTOs (the SSF effect view is the shared SsfLogic model) -------------------------------
    static List<SsxModel>? LoadModels(string levelDir)
    {
        string p = Path.Combine(levelDir, "Models.json");
        if (!File.Exists(p)) return null;
        try { return JsonConvert.DeserializeObject<ModelFile>(File.ReadAllText(p))?.Models; }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {p} is unreadable ({e.Message}) — no animated props for this level.");
            return null;
        }
    }
    // Newtonsoft populates these fields through reflection; direct assignments would only add DTO boilerplate.
#pragma warning disable CS0649
    sealed class ModelFile { public List<SsxModel>? Models; }
    sealed class SsxModel
    {
        public string? ModelName;
        public float AnimTime;
        public List<SsxModelObject>? ModelObjects;
    }
    sealed class SsxModelObject
    {
        public int ParentID = -1;
        public SsxObjectAnim? Animation;
        public List<SsxMeshHeader>? MeshData;
        public float[]? Position;
        public float[]? Rotation;
        public float[]? Scale;
    }
    sealed class SsxMeshHeader { public string? MeshPath; public int MaterialID; }
    sealed class SsxObjectAnim
    {
        // The animation BASE pose: U1-U3 translation, U4-U6 Euler (radians). This is what the engine poses an
        // animated object from — a sampled channel replaces the matching component of THIS, and the object's own
        // rest matrix (ModelObject Position/Rotation) takes no part. Retail authors the two to agree, so they
        // look interchangeable in shipped data and are not [Trailmap: 120-objects].
        public float U1, U2, U3, U4, U5, U6;
        public int AnimationAction;              // channel bitmask (bit 3 = X rotation)
        public List<SsxAnimEntry>? AnimationEntries;
    }
    sealed class SsxAnimEntry { public List<SsxAnimMath>? AnimationMaths; }
    sealed class SsxAnimMath { public float Value1, Value2, Value3, Value4, Value5, Value6; }
#pragma warning restore CS0649

}
