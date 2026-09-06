using System.Globalization;
using System.Linq;
using System.Numerics;
using Newtonsoft.Json;
using Snowknife.Engine;

namespace Snowknife.Bundle;

/// <summary>
/// The engine-agnostic PARTICLE + FIREWORK data the Unity importer's ParticleBuilder / TriggerBuilder consume
/// rather than recompute. Two unrelated effect families, both authored in SSX units (X-negated mesh space):
///   - Particles (fog): each ParticleInstances.json effect's PUFF CLUSTER - per puff a world-space centre
///     (instanceLoc + instanceRot * (instanceScale (.) puffLocal)) and an authored radius (frame.Unknown *
///     per-puff scale * max-abs instance scale; the explicit non-unit authoring convention). The importer turns
///     each puff into a camera-facing billboard quad (shader-specific), so
///     only the centre+radius+sprite move here. See Unity docs/unity/014.
///   - Fireworks: the LAUNCHER geometry (each canister's barrel axis + muzzle, by covariance/power-iteration on
///     its Props.obj cylinder verts), the TRIGGER volume AABBs, and the SSF effect-graph decode
///     (slot -> launcher instance indices + each launcher's native P6 emitter layers). The importer
///     builds the ParticleSystems / trigger colliders / Udon from this. See Unity docs/019.
/// </summary>
public static class ParticleBundle
{
    public sealed class Opts
    {
        public string DefaultSprite = "fog0.png";        // fallback billboard sprite (Textures/Particles/<name>)
    }

    // ---- fog / cloud billboard volumes -------------------------------------------------------------------
    public static BundleManifest.ParticlesInfo? BuildParticles(string levelDir, Opts opts)
    {
        var instances = LoadJson<PInstList>(Path.Combine(levelDir, "ParticleInstances.json"))?.Particles;
        if (instances == null || instances.Count == 0) return null;
        var models = LoadModels(Path.Combine(levelDir, "ParticleModels.json"));

        var info = new BundleManifest.ParticlesInfo();
        int puffs = 0, missing = 0;
        foreach (var inst in instances)
        {
            if (inst?.ParticleName == null) continue;
            // ParticleModelIndex is the native model-table join. ELYSIUM, for example, has 59 placements sharing
            // 19 models, so names are presentation only and never participate in data resolution.
            List<PFrame>? frames = inst.ParticleModelIndex >= 0 && inst.ParticleModelIndex < models.Ordered.Count
                ? models.Ordered[inst.ParticleModelIndex]
                : null;
            if (frames == null || frames.Count == 0) { missing++; continue; }

            Quaternion q = ToQuat(inst.Rotation);
            Vector3 scl = ToVec3(inst.Scale, Vector3.One);
            Vector3 loc = ToVec3(inst.Location, Vector3.Zero);
            // Retail placements are all unit-scale, so non-unit puff-size behavior is not observable in the
            // corpus. For authored volumes use the largest absolute axis: the puff stays a spherical billboard,
            // contains the fully transformed cluster, and matches Slopesmith's viewport convention.
            float instanceRadiusScale = MathF.Max(MathF.Abs(scl.X), MathF.Max(MathF.Abs(scl.Y), MathF.Abs(scl.Z)));

            var effect = new BundleManifest.EffectInfo { Name = inst.ParticleName, Sprite = PickSprite(inst.ParticleName, opts) };
            foreach (var f in frames)
            {
                Vector3 local = ToVec3(f.Position, Vector3.Zero);
                Vector3 wSSX = loc + Vector3.Transform(scl * local, q);   // instanceLoc + instanceRot * (scale (.) puffLocal)
                float pScale = (f.Rotation != null && f.Rotation.Length > 0) ? f.Rotation[0] : 1f;  // near-uniform per-puff scale
                float radius = MathF.Max(1f, f.Unknown) * pScale * instanceRadiusScale; // Unknown = puff radius in SSX units
                effect.Puffs.Add(new BundleManifest.PuffInfo { Center = new[] { -wSSX.X, wSSX.Y, wSSX.Z }, Radius = radius });
                puffs++;
            }
            if (effect.Puffs.Count > 0) info.Effects.Add(effect);
        }
        if (info.Effects.Count == 0) return null;
        Log.Info($"  Particles: {info.Effects.Count} effect(s), {puffs} puffs" + (missing > 0 ? $", {missing} with no model." : "."));
        return info;
    }

    static string PickSprite(string name, Opts opts)
        => name.StartsWith("Fog", StringComparison.OrdinalIgnoreCase) ? "fog0.png" : opts.DefaultSprite;

    // ---- fireworks: launchers + trigger volumes ----------------------------------------------------------
    // Both TRIGGERS and LAUNCHERS are data-derived from the SSF effect graph, no name lists. A firework trigger
    // is any invisible instance whose EffectSlotIndex -> EffectSlots[slot].CollisionEffectSlot header contains a
    // MainType-7 "Instance" hop into a PYRO sub-effect; each such hop's target instance is a LAUNCHER and the
    // hop's sub-effect carries its colour ramp + firing sound. Pyro = a MainType-2/SubType-0 emitter that fires a
    // report (a MainType-8 SoundPlay) - the report separates a firework volley from a silent ambient/continuous
    // collision emitter that shares the same shape (see IsPyro). That signature finds
    // FireworkCylindar canisters, FlashPot/Bomb props, cluster bombs and flashpots on
    // every level - the non-emitter M7 targets (triggered falling trees), the silent spark/fire/sewer-dust
    // emitters, and the scripted-show pyro reached via MainType-21 functions are all correctly left out (only the
    // direct CollisionEffectSlot header is walked). A level whose firework pyro was never authored into the graph
    // (e.g. barrels placed, no effect wiring) yields no fireworks - matching the original data.
    public static BundleManifest.FireworksInfo? BuildFireworks(string levelDir)
    {
        var instances = SsxInstances.Load(levelDir);
        if (instances == null) return null;

        var ssf = LoadSsfFireworks(levelDir);
        if (ssf == null) return null;   // no SSF effect graph -> no authored fireworks

        // Firework triggers, data-derived by graph shape (see above): an invisible instance whose slot's
        // CollisionEffectSlot header MainType-7-hops to a MainType-2/SubType-0 pyro emitter.
        var triggerInsts = new HashSet<int>();
        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it == null || it.Visable || it.EffectSlotIndex < 0) continue;
            if (!ssf.SlotTargets.TryGetValue(it.EffectSlotIndex, out var tg)) continue;
            foreach (var (_, eff) in tg)
                if (IsPyro(ssf, eff)) { triggerInsts.Add(n); break; }
        }
        var trigVols = ParseTriggerBounds(levelDir, instances, triggerInsts);

        // The launcher set + per-slot launcher lists, from the triggers' slots. Per launcher keep the sub-effect
        // that fires it (its P6 emitter layers + SoundPlay one-shot live there).
        var launcherEffect = new SortedDictionary<int, int>();     // launcher instance -> its sub-effect index
        var slotMap = new Dictionary<int, List<int>>();            // trigger slot -> launcher instances
        foreach (var t in trigVols)
        {
            if (t.Slot < 0 || !ssf.SlotTargets.TryGetValue(t.Slot, out var targets)) continue;
            List<int>? pyro = null;
            foreach (var (inst, eff) in targets)
            {
                if (inst < 0 || inst >= instances.Count || !IsPyro(ssf, eff)) continue;
                if (!launcherEffect.ContainsKey(inst)) launcherEffect[inst] = eff;
                if (pyro == null || !pyro.Contains(inst)) (pyro ??= new List<int>()).Add(inst);
            }
            if (pyro != null) slotMap[t.Slot] = pyro;
        }

        // launcher geometry (muzzle + barrel) from each launcher prop's Props.obj verts.
        var geo = ParseLauncherGeometry(levelDir, instances, launcherEffect.Keys);

        var info = new BundleManifest.FireworksInfo();
        int layerCount = 0, aimed = 0;
        foreach (var kv in launcherEffect)
        {
            int n = kv.Key;
            var it = instances[n];
            if (it == null) continue;

            // muzzle/barrel from the geometry; fall back to the instance base aiming straight up (local +Z) -
            // an invisible launcher (no Props.obj group, e.g. Bomb_Event markers) fires from its origin.
            bool hasGeo = geo.TryGetValue(n, out var g);
            Vector3 muzzle = hasGeo ? g!.Top : NegX(it.Location);
            Vector3 barrel = hasGeo ? g!.Barrel : Vector3.UnitZ;
            if (hasGeo) aimed++;

            int sound = -1;
            List<SsfType2Sub0>? layers = null;
            if (kv.Value >= 0)
            {
                ssf.LayersByEffect.TryGetValue(kv.Value, out layers);
                if (!ssf.SoundByEffect.TryGetValue(kv.Value, out sound)) sound = -1;
            }
            var launcher = new BundleManifest.LauncherInfo
            {
                Index = n,
                Muzzle = BundleSpace.Xyz(muzzle),
                Barrel = BundleSpace.Xyz(barrel),
                Sound = sound,
            };
            if (layers != null)
            {
                foreach (var layer in layers) launcher.Layers.Add(EmitterLayer(layer, it, muzzle, barrel));
                layerCount += launcher.Layers.Count;
            }
            info.Launchers.Add(launcher);
        }

        foreach (var t in trigVols)
        {
            if (!t.Has) continue;
            Vector3 center = (t.Min + t.Max) * 0.5f, size = t.Max - t.Min;
            var trig = new BundleManifest.TriggerInfo
            {
                Index = t.Index, Name = t.Name ?? "", Slot = t.Slot,
                Center = BundleSpace.Xyz(center),
                Size = BundleSpace.Xyz(size),
            };
            if (t.Slot >= 0 && slotMap.TryGetValue(t.Slot, out var launchers)) trig.Launchers.AddRange(launchers);
            info.Triggers.Add(trig);
        }

        if (info.Launchers.Count == 0 && info.Triggers.Count == 0) return null;
        Log.Info($"  Fireworks: {info.Launchers.Count} launcher(s) ({aimed} barrel-aimed, {layerCount} P6 layer(s)), " +
                          $"{info.Triggers.Count} trigger volume(s).");
        return info;
    }

    // ---- continuous emitters: the always-on SSF particle emitters on a bound instance ---------------------
    // A continuous emitter is any bound instance whose EffectSlotIndex resolves - via
    // EffectSlots[slot].PersistantEffectSlot -> that effect header - to one or more MainType-2/SubType-0 emitter
    // nodes (the persistent timer emitter). That is the snow-cannon snow plume (Mdl_SnowBlower_Top, 2 layers) and
    // the road flares + stone lantern flames; on any level it data-derives whatever persistent pyro
    // is authored. We reuse the firework launcher-geometry (each prop's barrel axis + muzzle, by covariance on its
    // Props.obj verts) to aim the plume, and bake each emitter layer's authored params. No name match - purely the
    // effect-graph shape, so it never overlaps the fireworks (those carry EffectSlotIndex -1, fired via a trigger
    // slot's MainType-7 hops) or the boost pads (a CollisionEffectSlot MainType-17/18). [Trailmap: 180-particles-data]
    public static BundleManifest.EmittersInfo? BuildEmitters(string levelDir, Opts opts)
    {
        var instances = SsxInstances.Load(levelDir);
        if (instances == null) return null;

        var slotLayers = LoadSsfPersistent(levelDir);   // EffectSlotIndex -> the persistent header's Type2Sub0 layers
        if (slotLayers == null || slotLayers.Count == 0) return null;

        var flareLights = LoadFlareLights(levelDir);     // Type-2 decorative lights (SD_pt_*flare / caldronlight): raw pos + hue

        // Extracted emitters normally sit on visible props. Per [Trailmap: 120-objects, 150-logic], authored
        // EffectTrigger_ owners are intentionally hidden and use their box only as the stable placement frame
        // for a separately positioned emitter.
        var emitterInsts = new SortedDictionary<int, int>();   // instance -> slot
        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it == null || it.EffectSlotIndex < 0) continue;
            if (slotLayers.ContainsKey(it.EffectSlotIndex)) emitterInsts[n] = it.EffectSlotIndex;
        }
        if (emitterInsts.Count == 0) return null;

        var geo = ParseLauncherGeometry(levelDir, instances, emitterInsts.Keys);   // muzzle + barrel per emitter prop

        var info = new BundleManifest.EmittersInfo();
        int aimed = 0, totLayers = 0;
        foreach (var kv in emitterInsts)
        {
            int n = kv.Key;
            var it = instances[n];
            if (it == null) continue;

            bool hasGeo = geo.TryGetValue(n, out var g);
            Vector3 muzzle = hasGeo ? g!.Top : NegX(it.Location);
            Vector3 barrel = hasGeo ? g!.Barrel : Vector3.UnitZ;   // no Props.obj group -> fire straight up (local +Z)
            if (hasGeo) aimed++;

            var fl = NearestFlareLight(flareLights, it.Location);   // the co-located decorative light (null for snow cannons)
            var em = new BundleManifest.EmitterInfo
            {
                Index = n,
                Name = it.InstanceName ?? "",
                Muzzle = BundleSpace.Xyz(muzzle),
                Barrel = BundleSpace.Xyz(barrel),
                Radius = hasGeo ? g!.Radius : 0f,                    // prop half-extent -> importer centers + sizes the glow halo
                Tint = fl?.Hue,                                      // the light's hue (null -> snow cannon, no halo)
                GlowRes = fl?.SpriteRes ?? 0,                        // the light's spriteRes (16/32; low = a blurry/diffuse halo) -> importer halo softness
            };
            foreach (var L in slotLayers[kv.Value])
            {
                em.Layers.Add(EmitterLayer(L, it));
                totLayers++;
            }
            info.Emitters.Add(em);
        }

        if (info.Emitters.Count == 0) return null;
        Log.Info($"  Emitters: {info.Emitters.Count} continuous emitter(s) ({aimed} barrel-aimed), {totLayers} layer(s).");
        return info;
    }

    // ---- light glint sprites (Unity docs/unity/045): the engine's runtime lamp/flare sparkle -----------------------
    // The engine's glint renderer ([Trailmap: 160-lighting-data], the runtime glint section) draws a small
    // additive sparkle at every authored light whose glow-sprite resolution is a SMALL class - the gate is
    // literally `spriteRes & 0x70`, so 16/32/64 glint and 256/512 never do. Type does not matter:
    // type-1 street lamps AND type-2 flare lights both glint through the same path. A
    // negative-colour record (some levels bake shadow-darkening through the same table) would draw an invisible
    // black additive sprite, so those are skipped here as an optimization rather than a semantic. The colour
    // splits into a pure hue (peak 1) and the peak as an intensity (percent scale; some lamps run to
    // ~4700 = strongly overbright), so the importer can dim a faintly-authored light without losing its hue.
    public static BundleManifest.LightGlowsInfo? BuildLightGlows(string levelDir)
    {
        var root = LoadJson<LightsFile>(Path.Combine(levelDir, "Lights.json"));
        if (root?.Lights == null) return null;

        var info = new BundleManifest.LightGlowsInfo();
        foreach (var l in root.Lights)
        {
            if ((l.SpriteRes & 0x70) == 0 || l.Position == null || l.Position.Length < 3
                || l.Colour == null || l.Colour.Length < 3) continue;
            float m = MathF.Max(l.Colour[0], MathF.Max(l.Colour[1], l.Colour[2]));
            if (m <= 1e-4f || l.Colour[0] < 0f || l.Colour[1] < 0f || l.Colour[2] < 0f) continue;   // black additive = invisible
            info.Glows.Add(new BundleManifest.LightGlowInfo
            {
                Name = l.LightName ?? "",
                Pos = BundleSpace.Xyz(BundleSpace.MeshPt(l.Position)),
                Hue = new[] { l.Colour[0] / m, l.Colour[1] / m, l.Colour[2] / m },
                Intensity = m,
                SpriteRes = l.SpriteRes,
            });
        }

        if (info.Glows.Count == 0) return null;
        Log.Info($"  LightGlows: {info.Glows.Count} glint light(s) (any type, spriteRes & 0x70 - the engine's own gate).");
        return info;
    }

    // EffectSlotIndex -> the Type2Sub0 emitter layers its PersistantEffectSlot header carries (the always-on pyro).
    // Null if the effect document is absent. One slot can hold several emitter nodes (the snow cannon authors two).
    static Dictionary<int, List<SsfType2Sub0>>? LoadSsfPersistent(string levelDir)
    {
        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return null;

        var map = new Dictionary<int, List<SsfType2Sub0>>();
        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            int pe = root.EffectSlots[slot].PersistantEffectSlot;
            if (pe < 0 || pe >= root.EffectHeaders.Length) continue;
            var hdr = root.EffectHeaders[pe];
            if (hdr?.Effects == null) continue;
            List<SsfType2Sub0>? layers = null;
            foreach (var node in hdr.Effects)
            {
                if (node == null || node.MainType != SsfMainType.Emitter || node.type2 == null) continue;
                if (node.type2.SubType == SsfType2Sub.Emitter && node.type2.type2Sub0 != null)
                    (layers ??= new List<SsfType2Sub0>()).Add(node.type2.type2Sub0);
            }
            if (layers != null) map[slot] = layers;
        }
        return map;
    }

    // ---- ambient emitters: collision-triggered dust/spark/fire/water/snow bursts (no report sound) ------------
    // The COLLISION-triggered particle bursts that are neither fireworks (those carry a MainType-8 report on the
    // emitter sub-effect) nor continuous emitters (those sit on a PersistantEffectSlot). Three authoring shapes, all
    // off a trigger's EffectSlots[slot].CollisionEffectSlot header: an M7 hop to an invisible emitter MARKER whose
    // sub-effect is a MainType-2/SubType-0 emitter with NO MainType-8 (spark/fire, sewer-dust), or an
    // INLINE MainType-2/SubType-0 in the header itself fired from the owning prop (a highway smash + its
    // fire hydrants), or the dedicated MainType-2/SubType-2 CollideEmitter (UNTRACK snow trees). Sub-2 stores
    // the same P6 law as sub-0, but the legacy document retains U2..U48 as raw f32 bit-pattern integers. Gems
    // (M14), boost pads (M17/M18) and balloons (DeadNode mode 4) carry inline sub-0 emitters too but are owned by
    // other importer paths, so headers with those are skipped. DeadNode mode 2 = fire once per load; a Debounce
    // (M0/Sub2) with no DeadNode = re-fire on each hit (the hydrants, ~7s). A dedicated CollideEmitter is natively
    // contact-repeatable behind a hardcoded 30-tick (0.5-second) gate. Reuses EmitterLayerInfo for both payload types.
    public static BundleManifest.AmbientEmittersInfo? BuildAmbientEmitters(string levelDir)
    {
        var instances = SsxInstances.Load(levelDir);
        if (instances == null) return null;
        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return null;

        // slot -> every instance that owns it (its EffectSlotIndex): a trigger volume (invisible) or firing prop.
        // Slots are templates and may be shared by many placements: UNTRACK's one collision-emitter slot belongs
        // to all 34 SnowGhost trees. A first-owner map silently exported only one of those bursts.
        var slotOwners = new Dictionary<int, List<int>>();
        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it == null || it.EffectSlotIndex < 0) continue;
            if (!slotOwners.TryGetValue(it.EffectSlotIndex, out var boundOwners))
                slotOwners[it.EffectSlotIndex] = boundOwners = new List<int>();
            boundOwners.Add(n);
        }

        var recs = new List<(BundleManifest.AmbientEmitterInfo rec, int owner)>();
        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            int ce = root.EffectSlots[slot].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var hdr = root.EffectHeaders[ce];
            if (hdr?.Effects == null || !slotOwners.TryGetValue(slot, out var boundOwners)) continue;

            // Classify the header; skip the pickup/breakable categories other importers own.
            bool skip = false; int deadMode = -1; float debounce = -1f;
            foreach (var node in hdr.Effects)
            {
                if (node == null) continue;
                if (node.MainType == SsfMainType.ScoreMultiplier || node.MainType == SsfMainType.SpeedBoost || node.MainType == SsfMainType.TrickBoost) { skip = true; break; }
                if (node.MainType == SsfMainType.Property && node.type0 != null)
                {
                    if (node.type0.SubType == SsfType0Sub.DeadNode) deadMode = node.type0.DeadNodeMode;
                    else if (node.type0.SubType == SsfType0Sub.Debounce) debounce = node.type0.Debounce;
                }
            }
            if (skip || deadMode == 4) continue;   // gem/boost, or balloon-break
            bool repeatable = debounce >= 0f && deadMode != 2;
            float minInterval = repeatable ? MathF.Max(0f, debounce) : 0f;

            // (a) INLINE emitters -> fire from the owning prop (hydrant / highway / SnowGhost tree).
            // A sub-2 node is a contact trigger in its own right; the graph is otherwise identical to an inline
            // sub-0 burst and uses the same transformed P6 realization.
            List<ISsfEmitterPayload>? inline = null;
            bool hasCollisionEmitter = false;
            foreach (var node in hdr.Effects)
            {
                if (node?.MainType != SsfMainType.Emitter || node.type2 == null) continue;
                if (node.type2.SubType == SsfType2Sub.Emitter && node.type2.type2Sub0 != null)
                    (inline ??= new List<ISsfEmitterPayload>()).Add(node.type2.type2Sub0);
                else if (node.type2.SubType == SsfType2Sub.CollisionEmitter && node.type2.type2Sub2 != null)
                {
                    (inline ??= new List<ISsfEmitterPayload>()).Add(node.type2.type2Sub2);
                    hasCollisionEmitter = true;
                }
            }

            foreach (int owner in boundOwners)
            {
                var owningIt = instances[owner];
                if (owningIt == null) continue;
                if (owningIt.ExactCollisionProfile
                    && (!owningIt.PlayerCollision || owningIt.CollsionMode == NativeCollisionMode.None
                        || (owningIt.CollsionMode == NativeCollisionMode.PhysicsBodySpheres && owningIt.PhysicsIndex < 0)))
                    continue; // an attached graph cannot manufacture contact when the explicit native shape/gate says none

                bool firesAgain = repeatable || (hasCollisionEmitter && deadMode != 2);
                float interval = hasCollisionEmitter && deadMode != 2 ? CollisionEmitterMinInterval : minInterval;
                if (inline != null)
                    recs.Add((MakeAmbient(owner, owningIt, inline, firesAgain, interval, hasCollisionEmitter), owner));

                // (b) M7-marker emitters -> a hop to an emitter marker whose sub-effect is a no-sound Type2Sub0.
                foreach (var node in hdr.Effects)
                {
                    if (node?.MainType != SsfMainType.ActOnInstance || node.Instance == null) continue;
                    int mk = node.Instance.InstanceIndex, eff = node.Instance.EffectIndex;
                    if (mk < 0 || mk >= instances.Count || eff < 0 || eff >= root.EffectHeaders.Length) continue;
                    var sub = root.EffectHeaders[eff];
                    if (sub?.Effects == null) continue;
                    List<ISsfEmitterPayload>? layers = null; bool hasSound = false;
                    foreach (var sn in sub.Effects)
                    {
                        if (sn == null) continue;
                        if (sn.MainType == SsfMainType.PlaySound && sn.SoundPlay >= 0) hasSound = true;
                        else if (sn.MainType == SsfMainType.Emitter && sn.type2 != null && sn.type2.SubType == SsfType2Sub.Emitter && sn.type2.type2Sub0 != null)
                            (layers ??= new List<ISsfEmitterPayload>()).Add(sn.type2.type2Sub0);
                    }
                    if (layers != null && !hasSound && instances[mk] != null)
                        recs.Add((MakeAmbient(mk, instances[mk]!, layers, repeatable, minInterval), owner));
                }
            }
        }
        if (recs.Count == 0) return null;

        // Roller pop-off targets (fire-hydrant TopLids) fired from the SAME trigger as the water (Unity docs/052).
        var (_, rollerOwners, _) = BuildRollerTargets(levelDir, instances);
        foreach (var (rec, owner) in recs)
            if (rollerOwners.TryGetValue(owner, out var rt) && rt.Count > 0) rec.RollerTargets = new List<int>(rt);

        // Trigger volumes from the owning instances' Props.obj geometry.
        var triggerOwners = new HashSet<int>(recs.Select(p => p.owner));
        var bounds = WalkPropsGroups(levelDir, triggerOwners.Contains);
        foreach (var (rec, owner) in recs)
        {
            if (bounds.TryGetValue(owner, out var pts) && pts.Count > 0)
            {
                Vector3 mn = pts[0], mx = pts[0];
                foreach (var p in pts) { mn = Vector3.Min(mn, p); mx = Vector3.Max(mx, p); }
                rec.TriggerCenter = BundleSpace.Xyz((mn + mx) * 0.5f);
                rec.TriggerSize = BundleSpace.Xyz(mx - mn);
            }
            else
            {
                rec.TriggerCenter = rec.Muzzle;   // no geometry -> a default box around the emit origin
                rec.TriggerSize = new[] { AmbientDefaultBox, AmbientDefaultBox, AmbientDefaultBox };
            }
        }

        var info = new BundleManifest.AmbientEmittersInfo { Emitters = recs.Select(p => p.rec).ToList() };
        int rep = info.Emitters.Count(r => r.Repeatable), lay = info.Emitters.Sum(r => r.Layers.Count);
        Log.Info($"  Ambient emitters: {info.Emitters.Count} ({rep} repeatable), {lay} layer(s).");
        return info;
    }

    const float AmbientDefaultBox = 800f;   // SSX units (~8m): fallback trigger box when the firing prop has no Props.obj volume
    const float CollisionEmitterMinInterval = 0.5f; // native collision-effect cooldown: 30 ticks at the engine's 60 Hz logic rate

    static BundleManifest.AmbientEmitterInfo MakeAmbient(int idx, SsxInstance it, List<ISsfEmitterPayload> layers,
        bool repeatable, float minInterval, bool contactDriven = false)
    {
        var rec = new BundleManifest.AmbientEmitterInfo
        {
            Index = idx,
            Name = it.InstanceName ?? "",
            Muzzle = BundleSpace.Xyz(NegX(it.Location)),
            Barrel = BundleSpace.Xyz(Vector3.UnitZ),
            Repeatable = repeatable,
            MinInterval = minInterval,
            ContactDriven = contactDriven,
        };
        foreach (var L in layers)
        {
            rec.Layers.Add(EmitterLayer(L, it));
        }
        // No semantic "kind": the importer renders each burst straight from the authored layer data (sprite index
        // U49 + colour ramp + gravity), exactly as the engine does (one shared emitter footprint, no kind enum).
        return rec;
    }

    // Bake one raw, instance-local P6 record into the bundle's root-local mesh space. Firework records with a zero
    // origin use the geometry-derived muzzle and rotate the native local +Z basis onto the canister barrel, matching
    // the game/editor correction for launcher models whose visible long axis differs from their authored effect axis.
    static BundleManifest.EmitterLayerInfo EmitterLayer(ISsfEmitterPayload layer, SsxInstance owner,
        Vector3? zeroOrigin = null, Vector3? correctedAim = null)
    {
        Vector3 localOrigin = ToVec3(layer.Origin(), Vector3.Zero);
        bool replaceOrigin = zeroOrigin.HasValue && localOrigin.LengthSquared() < 1e-8f;
        Vector3 nativeAim = InstanceVector(owner, Vector3.UnitZ);
        Quaternion correction = replaceOrigin && correctedAim.HasValue && nativeAim.LengthSquared() > 1e-8f
            ? FromTo(nativeAim, correctedAim.Value) : Quaternion.Identity;
        Vector3 Vec(float[] value) => Vector3.Transform(InstanceVector(owner, ToVec3(value, Vector3.Zero)), correction);
        float sizeScale = InstanceSizeScale(owner);
        return new BundleManifest.EmitterLayerInfo
        {
            ParticleCount = layer.ParticleCount,
            TrailCopies = layer.TrailCopies,
            EmissionWindow = layer.EmissionWindow,
            TimeScale = layer.TimeScale,
            SizeCenter = layer.SizeCenter * sizeScale,
            ParticleLifeCenter = layer.ParticleLifeCenter,
            SizeSpan = layer.SizeSpan * sizeScale,
            ParticleLifeSpan = layer.ParticleLifeSpan,
            TrailSpacing = layer.TrailSpacing,
            Origin = BundleSpace.Xyz(replaceOrigin ? zeroOrigin!.Value : InstancePoint(owner, localOrigin)),
            SpawnAxisA = BundleSpace.Xyz(Vec(layer.SpawnAxisA())),
            SpawnAxisB = BundleSpace.Xyz(Vec(layer.SpawnAxisB())),
            VelocityBase = BundleSpace.Xyz(Vec(layer.VelocityBase())),
            VelocityAxisA = BundleSpace.Xyz(Vec(layer.VelocityAxisA())),
            VelocityAxisB = BundleSpace.Xyz(Vec(layer.VelocityAxisB())),
            VelocityAxisC = BundleSpace.Xyz(Vec(layer.VelocityAxisC())),
            Gravity = BundleSpace.Xyz(Vec(layer.Gravity())),
            ColorStops = layer.ColorStopsRgba(),
            SpriteIndex = layer.SpriteIndex,
            BlendMode = layer.BlendMode(),
        };
    }

    // Roller targets (Unity docs/052): the SSF MainType-0/SubType-0 "Roller" makes a target instance a knock-off rigid body
    // Trick-multiplier GEMS, data-derived: an instance whose CollisionEffectSlot header carries a MainType-14
    // (MultiplierScore) node is a spinning score pickup (Unity docs/012, Unity docs/023) - the same signal the ambient path
    // skips (a gem is owned by the spinner/pickup importer, not emitters). Returns the set of such instance
    // indices. Data-derived rather than a "Gem_TrickMultiplier" model-name match, so it also catches
    // renamed/custom gems (verified to match the name-match result on every original level). Same walk
    // shape as BuildRollerTargets.
    public static HashSet<int> GemTargets(string levelDir, List<SsxInstance> instances)
    {
        var targets = new HashSet<int>();
        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return targets;

        // Effect slots whose COLLISION header runs a MainType-14 (the gem's pickup effect).
        var gemSlots = new HashSet<int>();
        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            int ce = root.EffectSlots[slot].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var effs = root.EffectHeaders[ce]?.Effects;
            if (effs == null) continue;
            foreach (var e in effs) if (e?.MainType == SsfMainType.ScoreMultiplier) { gemSlots.Add(slot); break; }
        }
        if (gemSlots.Count == 0) return targets;

        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it != null && it.EffectSlotIndex >= 0 && gemSlots.Contains(it.EffectSlotIndex)) targets.Add(n);
        }
        return targets;
    }

    // (launch + gravity + tumble + settle; [Trailmap: 370-world-interaction]). Every instance a COLLISION header rolls - inline
    // (the prop itself: a pylon/sign) or via a MainType-7 hop (a hydrant's TopLid, a garbage can's lid) - is a
    // shove-able prop we DIVERT as a physics knock-and-tumble body (PhysicsProp: ride through it, it flings). The
    // SUBSET whose header ALSO fires an emitter (the fire-hydrant water+lid) additionally goes in OwnerTargets, so the
    // ambient emitter pops that lid straight up when the base is hit. Returns (all targets to divert, owner->pop map).
    public static (HashSet<int> Targets, Dictionary<int, List<int>> OwnerTargets, Dictionary<int, float> Masses) BuildRollerTargets(
        string levelDir, List<SsxInstance> instances)
    {
        var targets = new HashSet<int>();
        var ownerTargets = new Dictionary<int, List<int>>();
        var masses = new Dictionary<int, float>();
        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return (targets, ownerTargets, masses);

        // A COLLISION slot is shared by every instance that carries the same EffectSlotIndex - whole rows of identical
        // street furniture (69 parking meters, 68 traffic lights, 46 air vents, 42 pylons, 25 benches ...) sit on one
        // slot each. Keep both the representative owner (for the M7-hop emitter-pop wiring) AND the full instance list
        // (so an inline Roller rolls EVERY instance on the slot, not just the first).
        var slotOwner = new Dictionary<int, int>();
        var slotInstances = new Dictionary<int, List<int>>();
        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it == null || it.EffectSlotIndex < 0) continue;
            if (!slotOwner.ContainsKey(it.EffectSlotIndex)) slotOwner[it.EffectSlotIndex] = n;
            if (!slotInstances.TryGetValue(it.EffectSlotIndex, out var lst)) { lst = new List<int>(); slotInstances[it.EffectSlotIndex] = lst; }
            lst.Add(n);
        }

        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            int ce = root.EffectSlots[slot].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var hdr = root.EffectHeaders[ce];
            if (hdr?.Effects == null || !slotOwner.TryGetValue(slot, out int owner)) continue;

            bool hasEmitter = false, inlineRoller = false;
            float inlineMass = float.NaN;
            foreach (var node in hdr.Effects)
            {
                if (node == null) continue;
                if (node.MainType == SsfMainType.Emitter && node.type2 != null && node.type2.SubType == SsfType2Sub.Emitter && node.type2.type2Sub0 != null) hasEmitter = true;
                else if (node.MainType == SsfMainType.Property && node.type0 != null && node.type0.SubType == SsfType0Sub.Roller)
                {
                    inlineRoller = true;
                    inlineMass = node.type0.type0Sub0?.U0 ?? float.NaN;
                }
            }

            // Inline Roller in the collision header -> EVERY instance sharing this slot is a shove-able body (the
            // pylon/sign/parking-meter/bench row that rolls when you ride into it). The engine rolls whichever
            // instance the player actually hits, so all instances on the slot qualify - not just the first. Each is
            // its own owner+target for the (rare) self-emitter pop.
            if (inlineRoller)
                foreach (int inst in slotInstances[slot]) AddRoller(inst, inst, inlineMass, hasEmitter, targets, ownerTargets, masses);

            // M7 hop to a Roller sub-effect on another instance -> that instance is the shove-able body (a hydrant's
            // TopLid, a garbage can's lid).
            foreach (var node in hdr.Effects)
            {
                if (node?.MainType != SsfMainType.ActOnInstance || node.Instance == null) continue;
                int ti = node.Instance.InstanceIndex, te = node.Instance.EffectIndex;
                if (ti < 0 || ti >= instances.Count || te < 0 || te >= root.EffectHeaders.Length) continue;
                var sub = root.EffectHeaders[te];
                if (sub?.Effects == null) continue;
                bool isRoller = false;
                float rollerMass = float.NaN;
                foreach (var sn in sub.Effects)
                    if (sn?.MainType == SsfMainType.Property && sn.type0 != null && sn.type0.SubType == SsfType0Sub.Roller)
                    {
                        isRoller = true;
                        rollerMass = sn.type0.type0Sub0?.U0 ?? float.NaN;
                        break;
                    }
                if (isRoller) AddRoller(owner, ti, rollerMass, hasEmitter, targets, ownerTargets, masses);
            }
        }
        return (targets, ownerTargets, masses);
    }

    // Only a finite positive Roller mass activates a body. Zero/invalid payloads are preserved in the authored
    // graph but cannot produce a usable inverse mass, so the portable preview/bundle safely ignores them.
    static void AddRoller(int owner, int target, float mass, bool hasEmitter, HashSet<int> targets,
                          Dictionary<int, List<int>> ownerTargets, Dictionary<int, float> masses)
    {
        if (!float.IsFinite(mass) || mass <= 0f) return;
        targets.Add(target);
        masses[target] = mass;
        if (!hasEmitter) return;
        if (!ownerTargets.TryGetValue(owner, out var lst)) { lst = new List<int>(); ownerTargets[owner] = lst; }
        if (!lst.Contains(target)) lst.Add(target);
    }

    // ---- flare tint: the co-located Type-2 decorative light gives each flare/lantern its colour --------------
    // SSX bakes the SD_pt_*flare / caldronlight point lights into the scene lighting (they never reach a sprite,
    // verified: no runtime path reads a light's spriteRes), so a flare's COLOUR is the point light sitting on it -
    // the flares are 0-7u from their light, the stone cauldrons ~150u. We surface that hue on the co-located emitter
    // so the importer can colour the plume + add a glow. A snow cannon has no nearby Type-2 light -> null (stays
    // white). Data-derived, no name match. [Trailmap: 160-flare-lights]
    const float FlareColocRadius = 600f;   // SSX units; flares 0-7u, cauldrons ~150u, a snow cannon's nearest Type-2 far

    sealed class FlareLight { public Vector3 Pos; public float[] Hue = { 1f, 1f, 1f }; public int SpriteRes; }

    static List<FlareLight> LoadFlareLights(string levelDir)
    {
        var outl = new List<FlareLight>();
        var root = LoadJson<LightsFile>(Path.Combine(levelDir, "Lights.json"));
        if (root?.Lights == null) return outl;
        foreach (var l in root.Lights)
        {
            if (l.Type != 2 || l.Position == null || l.Position.Length < 3 || l.Colour == null || l.Colour.Length < 3) continue;
            float m = MathF.Max(l.Colour[0], MathF.Max(l.Colour[1], l.Colour[2]));
            if (m <= 1e-4f) continue;
            outl.Add(new FlareLight
            {
                Pos = new Vector3(l.Position[0], l.Position[1], l.Position[2]),    // raw SSX (same space as instance Location)
                Hue = new[] { l.Colour[0] / m, l.Colour[1] / m, l.Colour[2] / m }, // normalize to peak 1 = pure hue
                SpriteRes = l.SpriteRes,                                           // the light's glow-sprite resolution (16/32 here; low = diffuse) -> importer halo softness
            });
        }
        return outl;
    }

    // The Type-2 light nearest this emitter instance, if within FlareColocRadius (raw SSX coords); else null.
    static FlareLight? NearestFlareLight(List<FlareLight> lights, float[]? loc)
    {
        if (lights.Count == 0 || loc == null || loc.Length < 3) return null;
        var p = new Vector3(loc[0], loc[1], loc[2]);
        float best = FlareColocRadius * FlareColocRadius; FlareLight? hit = null;
        foreach (var fl in lights)
        {
            float d = (fl.Pos - p).LengthSquared();
            if (d < best) { best = d; hit = fl; }
        }
        return hit;
    }

    // ---- boost pads: the visible speed/trick pads (spec 360) ---------------------------------------------
    // A boost pad is any VISIBLE instance whose EffectSlotIndex resolves - via EffectSlots[slot].CollisionEffectSlot
    // -> that effect header - to a MainType-17 (speed magnitude) or MainType-18 (trick window seconds) node. The
    // pad's footprint AABB comes from its own Props.obj group (visible decals keep their geometry there, like the
    // firework launchers). Data-derived: no name match, so it works on any level that authors the same effect nodes.
    // ---- reset zones (Unity docs/053): OOB / reset-onto-track volumes (Trailmap MainType-13) ----------------------
    /// <summary>
    /// How thick a fitted reset slab is made, in SSX cm. A reset zone is geometrically a PANEL, but
    /// <c>BasisResetZone</c> polls containment once a frame rather than sweeping, so a slab thin enough to be
    /// geometrically honest would be stepped over by a fast rider between two polls. Two metres is the
    /// compromise: thick enough that nothing crosses it unseen at ride speed, thin enough that the trigger no
    /// longer reaches metres out to the side of the panel it stands for.
    /// </summary>
    const float ResetZoneMinThickness = 200f;

    /// <summary>
    /// Fit an oriented slab to a group of mesh-space points that are (nearly always) coplanar.
    ///
    /// The plane comes from the largest-area triangle among the points — these groups are 4 to 7 vertices, so
    /// the exhaustive search is trivial and is far steadier than a covariance fit on so few points. The frame
    /// is built right-handed by construction, so the quaternion is always a proper rotation.
    /// </summary>
    internal static (Vector3 Center, float[] Rotation, Vector3 Size) FitPanelSlab(
        IReadOnlyList<Vector3> pts, float minThickness)
    {
        Vector3 mn = pts[0], mx = pts[0];
        foreach (var p in pts) { mn = Vector3.Min(mn, p); mx = Vector3.Max(mx, p); }
        var aabb = (Center: (mn + mx) * 0.5f, Rotation: new[] { 0f, 0f, 0f, 1f },
                    Size: Vector3.Max(mx - mn, new Vector3(minThickness)));
        if (pts.Count < 3) return aabb;

        Vector3 normal = Vector3.Zero;
        float best = 0f;
        for (int a = 0; a < pts.Count; a++)
            for (int b = a + 1; b < pts.Count; b++)
                for (int c = b + 1; c < pts.Count; c++)
                {
                    var cr = Vector3.Cross(pts[b] - pts[a], pts[c] - pts[a]);
                    float area = cr.Length();
                    if (area > best) { best = area; normal = cr / area; }
                }
        if (best <= 1e-4f) return aabb;   // degenerate group: nothing to orient to

        // The in-plane axis is chosen to MINIMISE the fitted rectangle, not merely to be some direction in the
        // plane: taking the longest point-to-point span picks a quad's diagonal and inflates the rectangle by
        // half again. Every point-pair direction is tried, which for these 4-to-7 vertex groups is a handful
        // of candidates and includes every edge — and the minimum-area rectangle of a convex polygon is always
        // edge-aligned, so the best candidate here is the optimum.
        Vector3 u = Vector3.Zero;
        float bestArea = float.MaxValue;
        for (int a = 0; a < pts.Count; a++)
            for (int b = a + 1; b < pts.Count; b++)
            {
                var d = pts[b] - pts[a];
                d -= normal * Vector3.Dot(d, normal);
                if (d.LengthSquared() <= 1e-6f) continue;
                d = Vector3.Normalize(d);
                var perp = Vector3.Cross(normal, d);
                float dLo = float.MaxValue, dHi = float.MinValue, pLo = float.MaxValue, pHi = float.MinValue;
                foreach (var q0 in pts)
                {
                    float x = Vector3.Dot(q0, d), y = Vector3.Dot(q0, perp);
                    if (x < dLo) dLo = x; if (x > dHi) dHi = x;
                    if (y < pLo) pLo = y; if (y > pHi) pHi = y;
                }
                float area = (dHi - dLo) * (pHi - pLo);
                if (area < bestArea) { bestArea = area; u = d; }
            }
        if (bestArea == float.MaxValue) return aabb;
        var w = Vector3.Cross(normal, u);   // (u, w, normal) is right-handed: cross(u, w) == normal

        var axes = new[] { u, w, normal };
        var lo = new float[3];
        var hi = new float[3];
        for (int k = 0; k < 3; k++)
        {
            lo[k] = float.MaxValue; hi[k] = float.MinValue;
            foreach (var p in pts)
            {
                float d = Vector3.Dot(p, axes[k]);
                if (d < lo[k]) lo[k] = d;
                if (d > hi[k]) hi[k] = d;
            }
        }
        var center = Vector3.Zero;
        for (int k = 0; k < 3; k++) center += axes[k] * ((lo[k] + hi[k]) * 0.5f);
        var size = new Vector3(hi[0] - lo[0], hi[1] - lo[1], MathF.Max(hi[2] - lo[2], minThickness));

        // A group that is not really a panel has no meaningful plane to fit. The largest-area triangle then picks
        // an essentially arbitrary frame, and an oriented box in an arbitrary frame can be far BIGGER than the
        // axis-aligned one — MERQUER's Mdl_ParlamentBuilding_59 (10 vertices, 41 m thick, no plane to speak of)
        // fitted to exactly 2.00x its own AABB. Since the whole point of fitting is to remove phantom trigger
        // volume, keep whichever box is smaller: the fit can then only ever shrink a zone, never inflate one.
        if (size.X * size.Y * size.Z >= aabb.Size.X * aabb.Size.Y * aabb.Size.Z) return aabb;

        // Rows are the images of the local axes, matching Vector3.Transform's row-vector convention.
        var m = new Matrix4x4(u.X, u.Y, u.Z, 0, w.X, w.Y, w.Z, 0, normal.X, normal.Y, normal.Z, 0, 0, 0, 0, 1);
        var q = Quaternion.CreateFromRotationMatrix(m);
        return (center, new[] { q.X, q.Y, q.Z, q.W }, size);
    }

    /// <summary>
    /// Reset hosts that carry their reset on their OWN COLLISION instead of a volume: a VISIBLE instance with a
    /// triangle proxy the rider can actually hit (MERQUER's ParlamentBuilding and ConcreteWalls, the crowd stands,
    /// MESA's tree line). The engine hangs MainType-13 off the prop's collision slot, so these are contact-driven
    /// exactly as an animated door is, and a box over their bounds resets a rider riding THROUGH them - the
    /// Parlament has a tunnel under it.
    ///
    /// One predicate, two consumers, deliberately: <c>BuildResetZones</c> marks these ContactOnly so the importer
    /// emits no box, and <c>CollisionBundle</c> gives them their own "_R"-tagged bucket so the board resets on
    /// hitting them. If the two ever disagreed, a host would lose its reset entirely.
    /// </summary>
    public static HashSet<int> ContactResetHosts(string levelDir, List<SsxInstance> instances)
    {
        var hosts = new HashSet<int>();
        var slots = CollisionSlotsWith(levelDir, n => n.MainType == SsfMainType.ResetZone);
        if (slots == null || slots.Count == 0) return hosts;
        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it == null || it.EffectSlotIndex < 0 || !slots.Contains(it.EffectSlotIndex)) continue;
            // Every clause is load-bearing, and the direction of failure is deliberate: anything that would NOT end
            // up as a solid "_R" bucket keeps its volume instead. A host diverted off its box onto collision that
            // the collision bake then skips has no reset AT ALL, which is worse than an oversized trigger.
            //   visible + proxy   - there is real geometry to hit (an invisible marker panel has none)
            //   TriangleProxy     - modes 2/3 land in ComputedBounds/Bodies, which carry no name tag
            //   solid response    - a pass-through prop is not bucketed, so it would never be hit
            if (it.Visable
                && it.CollsionModelPaths is { Length: > 0 }
                && it.CollsionMode == NativeCollisionMode.TriangleProxy
                && CollisionBundle.HasSolidRiderResponse(it)) hosts.Add(n);
        }
        return hosts;
    }

    // Any instance whose CollisionEffectSlot header carries a MainType-13 node is an out-of-bounds / reset trigger
    // (Mdl_ResetZone_*, Water_River, back-of-course walls + crowd stands). We bake each one's AABB from its Props.obj
    // volume so the importer drops a trigger box that snaps a rider back onto the course.
    public static BundleManifest.ResetZonesInfo? BuildResetZones(string levelDir)
    {
        var instances = SsxInstances.Load(levelDir);
        if (instances == null) return null;
        var slots = CollisionSlotsWith(levelDir, n => n.MainType == SsfMainType.ResetZone);
        if (slots == null || slots.Count == 0) return null;

        var zoneInsts = new HashSet<int>();
        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it != null && it.EffectSlotIndex >= 0 && slots.Contains(it.EffectSlotIndex)) zoneInsts.Add(n);
        }
        if (zoneInsts.Count == 0) return null;

        var groups = WalkPropsGroups(levelDir, zoneInsts.Contains);
        var contactHosts = ContactResetHosts(levelDir, instances);
        var info = new BundleManifest.ResetZonesInfo();
        foreach (int n in zoneInsts.OrderBy(x => x))
        {
            if (!groups.TryGetValue(n, out var verts) || verts.Count == 0) continue;   // need a volume to place the trigger
            var slab = FitPanelSlab(verts, ResetZoneMinThickness);
            // VISIBLE host + its own collision proxy = a solid object in the world (a building, a wall), whose reset
            // the engine hangs off that collision and fires on CONTACT. A box over its bounds is wrong the way a box
            // over a shut door is wrong: MERQUER's Mdl_ParlamentBuilding_59 has a TUNNEL through it, and the box
            // resets a rider taking it. The invisible marker panels (no proxy, or not drawn) keep their volume -
            // there is nothing to hit, so containment is the only way to catch the crossing.
            var host = instances[n]!;
            bool contactOnly = contactHosts.Contains(n);
            info.Zones.Add(new BundleManifest.ResetZoneInfo
            {
                Index = n, Name = host.InstanceName ?? "", ContactOnly = contactOnly,
                Center = BundleSpace.Xyz(slab.Center), Rotation = slab.Rotation, Size = BundleSpace.Xyz(slab.Size),
            });
        }
        if (info.Zones.Count == 0) return null;
        Log.Info($"  Reset zones: {info.Zones.Count} OOB/reset volume(s).");
        return info;
    }

    // ---- boost volumes (Unity docs/053): the MainType-0 BOOST FAMILY --------------------------------------------------
    // Four sub-types, one mechanism: speed along an axis approaching a target as a first-order lag, add-only
    // ([Trailmap: 360-node-apply]). Sub-7 is the base directional push; sub-18 turns it into a vertical elevator;
    // sub-15 lifts and classifies the rider into a launch stage; sub-24 consumes that stage to launch them out.
    // A slot carries at most one of the four, so one record shape carries all of them behind a `Kind` tag.
    //
    // The push AXIS is world space in the engine, which never turns it by the host's transform, so it needs only
    // the mesh-space X-negate. The lap boost's STAGE axis is the opposite case - the engine explicitly runs the
    // host's instance matrix over (1,0,0) ([Trailmap: 360-lapboost-stage]) - so that one is rotated here.
    public static BundleManifest.BoostVolumesInfo? BuildBoostVolumes(string levelDir)
    {
        var instances = SsxInstances.Load(levelDir);
        if (instances == null) return null;
        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return null;

        // slot -> the boost node that slot fires on collision
        var boostSlots = new Dictionary<int, SsfType0>();
        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            int ce = root.EffectSlots[slot].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var hdr = root.EffectHeaders[ce];
            if (hdr?.Effects == null) continue;
            foreach (var node in hdr.Effects)
            {
                if (node?.MainType != SsfMainType.Property || node.type0 == null) continue;
                if (BoostKind(node.type0) == null) continue;
                boostSlots[slot] = node.type0;
                break;
            }
        }
        if (boostSlots.Count == 0) return null;

        var volInsts = new HashSet<int>();
        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it != null && it.EffectSlotIndex >= 0 && boostSlots.ContainsKey(it.EffectSlotIndex)) volInsts.Add(n);
        }
        if (volInsts.Count == 0) return null;

        var groups = WalkPropsGroups(levelDir, volInsts.Contains);
        var info = new BundleManifest.BoostVolumesInfo();
        foreach (int n in volInsts.OrderBy(x => x))
        {
            var it = instances[n];
            var t0 = boostSlots[it.EffectSlotIndex];
            string kind = BoostKind(t0)!;
            Vector3 center, size;
            if (groups.TryGetValue(n, out var verts) && verts.Count > 0)
            {
                Vector3 mn = verts[0], mx = verts[0];
                foreach (var p in verts) { mn = Vector3.Min(mn, p); mx = Vector3.Max(mx, p); }
                center = (mn + mx) * 0.5f; size = mx - mn;
            }
            else { center = BundleSpace.MeshPt(it.Location); size = new Vector3(400f, 200f, 400f); }

            var rec = new BundleManifest.BoostVolumeInfo
            {
                Index = n, Name = it.InstanceName ?? "", Kind = kind,
                Center = BundleSpace.Xyz(center), Size = BundleSpace.Xyz(size),
            };

            switch (kind)
            {
                case "directional":
                {
                    var b = t0.Boost!;
                    float[] d = (b.BoostDir != null && b.BoostDir.Length >= 3) ? b.BoostDir : new[] { 0f, 0f, 1f };
                    rec.Dir = BundleSpace.Xyz(MeshDir(d[0], d[1], d[2]));
                    rec.Amount = b.BoostAmount; rec.Rate = b.U2; rec.Seconds = b.U1; rec.Mode = b.Mode;
                    break;
                }
                case "vertical-lift":
                {
                    var z = t0.type0Sub18!;
                    rec.Dir = BundleSpace.Xyz(MeshDir(z.U2, z.U3, z.U4));
                    rec.Amount = z.U1; rec.Rate = z.U0;
                    // Native world Z survives the mesh transform untouched (only X is negated), so the target
                    // altitude and its tolerance carry across as authored.
                    rec.TargetZ = z.U5; rec.SnapTolerance = z.U6;
                    break;
                }
                case "lap-gated":
                {
                    var l = t0.type0Sub15!;
                    rec.Dir = BundleSpace.Xyz(MeshDir(l.U2, l.U3, l.U4));
                    rec.Amount = l.U1; rec.Rate = l.U0;
                    // The host's own world X axis - the side of the box midpoint the rider is on along it decides
                    // stage 1 vs 2 - and the 10 m the engine requires above the host's floor for any stage above 0.
                    Vector3 hostX = Vector3.Transform(Vector3.UnitX, ToQuat(it.Rotation));
                    rec.Axis = BundleSpace.Xyz(MeshDir(hostX.X, hostX.Y, hostX.Z));
                    rec.StageFloorOffset = 1000f;
                    break;
                }
                case "tube-end":
                {
                    var t = t0.type0Sub24!;
                    rec.Dir = BundleSpace.Xyz(MeshDir(t.U4, t.U5, t.U6));
                    // Its ctor calls sub-7's and its update IS sub-7's, so the lifetime words sit at sub-7's offsets.
                    rec.Amount = t.U3; rec.Rate = t.U2; rec.Seconds = t.U1; rec.Mode = (int)t.U0;
                    rec.Stages.Add(Stage(t.U7, t.U8, t.U9, t.U16));
                    rec.Stages.Add(Stage(t.U10, t.U11, t.U12, t.U17));
                    rec.Stages.Add(Stage(t.U13, t.U14, t.U15, t.U18));
                    break;
                }
            }
            info.Volumes.Add(rec);
        }
        if (info.Volumes.Count == 0) return null;
        var byKind = info.Volumes.GroupBy(v => v.Kind).OrderBy(g => g.Key).Select(g => $"{g.Count()} {g.Key}");
        Log.Info($"  Boost volumes: {info.Volumes.Count} ({string.Join(", ", byKind)}).");
        return info;
    }

    /// <summary>The manifest Kind for a MainType-0 node, or null if this node is not in the boost family.</summary>
    static string? BoostKind(SsfType0 t0) => t0.SubType switch
    {
        SsfType0Sub.Boost when t0.Boost != null => "directional",
        SsfType0Sub.ZBoost when t0.type0Sub18 != null => "vertical-lift",
        SsfType0Sub.LapBoost when t0.type0Sub15 != null => "lap-gated",
        SsfType0Sub.TubeEndBoost when t0.type0Sub24 != null => "tube-end",
        _ => null,
    };

    /// <summary>A raw SSX direction into mesh space - the same X-negate as positions, so it rides the Level
    /// transform to world. Directions carry no translation, so nothing else applies.</summary>
    static Vector3 MeshDir(float x, float y, float z) => new(-x, y, z);

    static BundleManifest.BoostStageInfo Stage(float x, float y, float z, float speed) =>
        new() { Dir = BundleSpace.Xyz(MeshDir(x, y, z)), Speed = speed };

    // ---- spline movers (Unity docs/053): MainType-2/SubType-1 spline-path animation (a subway train) ---------
    // A PERSISTENT (load-time) node that walks the owning prop - and InstanceCount copies spaced along - down a named
    // spline at AnimationSpeed. We sample the spline's cubic-Bezier segments into a path and bake {prop, path, speed}.
    public static BundleManifest.SplineMoversInfo? BuildSplineMovers(string levelDir)
    {
        var instances = SsxInstances.Load(levelDir);
        if (instances == null) return null;
        var root = SsfLogic.Load(levelDir);
        var movers = MoversByInstance(root, instances);
        if (movers.Count == 0) return null;

        var splines = LoadJson<SplinesFile>(Path.Combine(levelDir, "Splines.json"))?.Splines;
        var info = new BundleManifest.SplineMoversInfo();
        foreach (int n in movers.Keys.OrderBy(k => k))
        {
            var sa = movers[n];
            var it = instances[n];
            if (it == null) continue;
            if (splines == null || sa.SplineIndex < 0 || sa.SplineIndex >= splines.Count) continue;   // orphaned (no live spline) -> skip
            var path = SampleSpline(splines[sa.SplineIndex]);
            if (path.Count < 2) continue;
            info.Movers.Add(new BundleManifest.SplineMoverInfo
            {
                Index = n, Name = it.InstanceName ?? "",
                Speed = sa.AnimationSpeed, Count = Math.Max(1, sa.InstanceCount),
                Tint = new[] { sa.R, sa.G, sa.B },
                Path = path.Select(p => BundleSpace.Xyz(p)).ToArray(),
                Rotation = MirrorQuat(it.Rotation),   // baked into the diverted mesh; the importer un-bakes it (the engine ignores it)
                YawOffset = sa.U5, OrientMode = sa.U2, EndMode = sa.U1,
                Cable = sa.U6 != 0, CableColor = new[] { sa.R, sa.G, sa.B, sa.U7 },
            });
        }
        if (info.Movers.Count == 0) return null;
        Log.Info($"  Spline movers: {info.Movers.Count} prop(s), {info.Movers.Sum(m => m.Count)} copies riding " +
                          $"{info.Movers.Select(m => m.Path.Length).Sum()} path points.");
        return info;
    }

    // The instances a spline mover (MainType-2/SubType-1) drives - so PropsBundle can DIVERT them (they're invisible
    // templates, otherwise dropped from the merged mesh). Computed before props, so it can't reuse BuildSplineMovers.
    public static HashSet<int> SplineMoverTargets(string levelDir, List<SsxInstance> instances)
        => new HashSet<int>(MoversByInstance(SsfLogic.Load(levelDir), instances).Keys);

    // Every instance a spline mover drives, with the payload driving it. A level wires this two ways, and both land
    // the mover on a TARGET instance that is not necessarily the one carrying the effect slot:
    //
    //   direct   - the instance's own slot has the mover on its persistent header (a subway train).
    //   handed   - the slot's header holds a MainType-7 "act on instance", which plays another header on ANOTHER
    //              instance. A chairlift's towers do this: the tower carries the slot, and hands the mover to the
    //              gondola chair. Reading only the direct wiring finds no mover at all (the chair's own
    //              EffectSlotIndex is -1); reading the slot's carrier as the target would ride the TOWERS down the wire.
    //
    // A level can wire the same prop both ways (the subway is also handed to itself by a duplicate chain), so the
    // first hit per instance wins - the payloads are identical and a second record would build the prop twice.
    static Dictionary<int, SsfSplineAnim> MoversByInstance(SsfRoot? root, List<SsxInstance> instances)
    {
        var byInstance = new Dictionary<int, SsfSplineAnim>();
        if (root?.EffectSlots == null || root.EffectHeaders == null) return byInstance;

        var slotOwn = new Dictionary<int, SsfSplineAnim>();
        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            var hdr = HeaderAt(root, root.EffectSlots[slot].PersistantEffectSlot);
            if (hdr?.Effects == null) continue;

            var own = MoverIn(hdr);
            if (own != null) slotOwn[slot] = own;

            foreach (var node in hdr.Effects)
            {
                if (node?.MainType != SsfMainType.ActOnInstance || node.Instance == null) continue;
                var handed = MoverIn(HeaderAt(root, node.Instance.EffectIndex));
                int target = node.Instance.InstanceIndex;
                if (handed != null && target >= 0 && target < instances.Count && !byInstance.ContainsKey(target))
                    byInstance[target] = handed;
            }
        }

        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it == null || it.EffectSlotIndex < 0) continue;
            if (slotOwn.TryGetValue(it.EffectSlotIndex, out var sa) && !byInstance.ContainsKey(n)) byInstance[n] = sa;
        }
        return byInstance;
    }

    static SsfHeader? HeaderAt(SsfRoot root, int idx)
        => (idx >= 0 && root.EffectHeaders != null && idx < root.EffectHeaders.Length) ? root.EffectHeaders[idx] : null;

    static SsfSplineAnim? MoverIn(SsfHeader? hdr)
    {
        if (hdr?.Effects == null) return null;
        foreach (var node in hdr.Effects)
            if (node?.MainType == SsfMainType.Emitter && node.type2 != null
                && node.type2.SubType == SsfType2Sub.SplineMover && node.type2.SplineAnimation != null)
                return node.type2.SplineAnimation;
        return null;
    }

    // Flag (MainType-0/Sub13, persistent) + fence (MainType-0/Sub12, collision) instances - the soft-prop wind
    // pipeline (Unity docs/053) pulls their geometry into a combined wind mesh, so PropsBundle DIVERTS them out of the
    // merged mesh (Kind softflag/softfence). Computed before props, so it can't reuse the full BuildSoftBodies pass.
    public static (HashSet<int> Flags, HashSet<int> Fences) SoftBodyTargets(string levelDir, List<SsxInstance> instances)
    {
        var flags = new HashSet<int>();
        var fences = new HashSet<int>();
        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return (flags, fences);

        var flagSlots = new HashSet<int>();
        var fenceSlots = new HashSet<int>();
        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            if (HeaderHasType0Sub(root, root.EffectSlots[slot].PersistantEffectSlot, SsfType0Sub.Flag)) flagSlots.Add(slot);
            if (HeaderHasType0Sub(root, root.EffectSlots[slot].CollisionEffectSlot, SsfType0Sub.Fence)) fenceSlots.Add(slot);
        }
        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it == null || it.EffectSlotIndex < 0) continue;
            if (flagSlots.Contains(it.EffectSlotIndex)) flags.Add(n);
            if (fenceSlots.Contains(it.EffectSlotIndex)) fences.Add(n);
        }
        return (flags, fences);
    }

    static bool HeaderHasType0Sub(SsfRoot root, int hi, SsfType0Sub sub)
    {
        var headers = root.EffectHeaders;
        if (headers == null || hi < 0 || hi >= headers.Length) return false;
        var hdr = headers[hi];
        var effects = hdr?.Effects;
        if (effects == null) return false;
        foreach (var node in effects)
            if (node?.MainType == SsfMainType.Property && node.type0 != null && node.type0.SubType == sub) return true;
        return false;
    }

    // Sample a spline's cubic-Bezier segments into mesh-space points (negated-X), dropping near-duplicates.
    // An instance quaternion under the same X-negation the geometry gets (mesh space), as PropsBundle does for the
    // GPU-instanced props.
    static float[] MirrorQuat(float[]? r) =>
        r is { Length: >= 4 } ? new[] { r[0], -r[1], -r[2], r[3] } : new[] { 0f, 0f, 0f, 1f };

    static List<Vector3> SampleSpline(SplineRec? spline, int per = 12)
    {
        var outp = new List<Vector3>();
        if (spline?.Segments == null) return outp;
        foreach (var seg in spline.Segments)
        {
            if (seg?.Points == null || seg.Points.Length < 4) continue;
            Vector3 p0 = BundleSpace.MeshPt(seg.Points[0]), p1 = BundleSpace.MeshPt(seg.Points[1]),
                    p2 = BundleSpace.MeshPt(seg.Points[2]), p3 = BundleSpace.MeshPt(seg.Points[3]);
            for (int i = 0; i <= per; i++)
            {
                float t = i / (float)per, u = 1f - t;
                Vector3 pt = u * u * u * p0 + 3f * u * u * t * p1 + 3f * u * t * t * p2 + t * t * t * p3;
                if (outp.Count == 0 || (pt - outp[^1]).LengthSquared() > 1f) outp.Add(pt);
            }
        }
        return outp;
    }

    // Slots whose CollisionEffectSlot header contains a node matching `match`. Small shared helper.
    static HashSet<int>? CollisionSlotsWith(string levelDir, System.Func<SsfNode, bool> match)
    {
        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return null;
        var slots = new HashSet<int>();
        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            int ce = root.EffectSlots[slot].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var hdr = root.EffectHeaders[ce];
            if (hdr?.Effects == null) continue;
            foreach (var node in hdr.Effects) if (node != null && match(node)) { slots.Add(slot); break; }
        }
        return slots;
    }

    // The visible pad instances, data-derived exactly like GemTargets: an instance whose EffectSlotIndex resolves -
    // through EffectSlots[slot].CollisionEffectSlot - to a MainType-17/18 boost node. PropsBundle diverts these out
    // of the merged static mesh so each pad owns a transform the runtime can pop + regrow (Unity docs/040); without the
    // divert the decal is welded into the world mesh and can only burst, never vanish.
    public static HashSet<int> BoostPadTargets(string levelDir, List<SsxInstance> instances)
    {
        var targets = new HashSet<int>();
        var boostSlots = LoadBoostSlots(levelDir);
        if (boostSlots == null || boostSlots.Count == 0) return targets;
        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it == null || !it.Visable || it.EffectSlotIndex < 0) continue;
            if (boostSlots.ContainsKey(it.EffectSlotIndex)) targets.Add(n);
        }
        return targets;
    }

    // Per-instance CONTACT PARTICLES: every MainType-2/SubType-0 emitter sitting inline on an instance's collision
    // header, baked against that instance so the burst lands where the prop is (root-local mesh space). One
    // extractor for every prop that flashes on a hit - the SSF authors them all the same way, and only the owning
    // node beside them differs:
    //   MainType-14 (MultiplierScore) -> a trick gem's collect flash   (2 layers, Unity docs/023)
    //   DeadNodeMode 4                -> a balloon animal's pop        (2 layers, Unity docs/036)
    //   MainType-17/18                -> a boost pad's cross           (9 layers, Unity docs/040 - baked by BuildBoostPads,
    //                                    which needs the pad's tier/value off the same header anyway)
    // PropsBundle hangs the result on the matching DivertInfo.Layers, and the importer renders whichever it finds
    // through the one shared P6 path. Empty = the level authors none.
    public static Dictionary<int, List<BundleManifest.EmitterLayerInfo>> CollisionBurstLayers(string levelDir, List<SsxInstance> instances)
    {
        var map = new Dictionary<int, List<BundleManifest.EmitterLayerInfo>>();
        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return map;

        var bySlot = new Dictionary<int, List<SsfType2Sub0>>();
        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            int ce = root.EffectSlots[slot].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var hdr = root.EffectHeaders[ce];
            if (hdr?.Effects == null) continue;

            bool owned = false;
            var layers = new List<SsfType2Sub0>();
            foreach (var node in hdr.Effects)
            {
                if (node == null) continue;
                if (node.MainType == SsfMainType.ScoreMultiplier) owned = true;           // gem pickup
                else if (node.MainType == SsfMainType.Property && node.type0 != null
                         && node.type0.SubType == SsfType0Sub.DeadNode && node.type0.DeadNodeMode == 4)
                    owned = true;                                                          // balloon pop (hides the source)
                else if (node.MainType == SsfMainType.Emitter && node.type2 != null
                         && node.type2.SubType == SsfType2Sub.Emitter && node.type2.type2Sub0 != null)
                    layers.Add(node.type2.type2Sub0);
            }
            // Unowned headers are the AMBIENT emitters (Unity docs/052) - a different importer builds those, and
            // attaching them here would render the same burst twice.
            if (owned && layers.Count > 0) bySlot[slot] = layers;
        }
        if (bySlot.Count == 0) return map;

        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it == null || it.EffectSlotIndex < 0) continue;
            if (!bySlot.TryGetValue(it.EffectSlotIndex, out var layers)) continue;
            var baked = new List<BundleManifest.EmitterLayerInfo>(layers.Count);
            foreach (var L in layers) baked.Add(EmitterLayer(L, it));
            map[n] = baked;
        }
        return map;
    }

    public static BundleManifest.BoostPadsInfo? BuildBoostPads(string levelDir)
    {
        var instances = SsxInstances.Load(levelDir);
        if (instances == null) return null;

        var boostSlots = LoadBoostSlots(levelDir);   // EffectSlotIndex -> (trick?, value)
        if (boostSlots == null || boostSlots.Count == 0) return null;

        // The boost owners: extracted pads are visible decals, while a Slopesmith-authored EffectTrigger_ is an
        // intentionally invisible contact box. Both carry the same specified collision-slot semantics
        // [Trailmap: 130-collision-data, 150-logic] and both
        // must become runtime trigger volumes. A hidden authored owner simply has no decal to pop/regrow.
        var padIndices = new HashSet<int>();
        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it == null || it.EffectSlotIndex < 0) continue;
            if (boostSlots.ContainsKey(it.EffectSlotIndex)) padIndices.Add(n);
        }
        if (padIndices.Count == 0) return null;

        var groups = WalkPropsGroups(levelDir, padIndices.Contains);   // footprint verts per pad (negated-X mesh space)

        var info = new BundleManifest.BoostPadsInfo();
        foreach (int n in padIndices.OrderBy(x => x))
        {
            var it = instances[n];
            var (trick, value, emitters) = boostSlots[it.EffectSlotIndex];

            Vector3 center, size;
            if (groups.TryGetValue(n, out var verts) && verts.Count > 0)
            {
                Vector3 min = verts[0], max = verts[0];
                foreach (var p in verts) { min = Vector3.Min(min, p); max = Vector3.Max(max, p); }
                center = (min + max) * 0.5f;
                size = max - min;
            }
            else
            {
                // No drawn geometry (shouldn't happen for a visible pad): a small box at the instance origin.
                center = BundleSpace.MeshPt(it.Location);
                size = new Vector3(400f, 60f, 400f);
            }

            var rec = new BundleManifest.BoostPadInfo
            {
                Index = n, Name = it.InstanceName ?? "", Slot = it.EffectSlotIndex,
                Trick = trick, Value = value,
                Center = BundleSpace.Xyz(center), Size = BundleSpace.Xyz(size),
            };
            // The contact burst the engine fires on a cross, straight off the pad's own collision header. The pad
            // instance owns these inline emitters, so they bake against it exactly like a hydrant's inline spray.
            foreach (var L in emitters) rec.Layers.Add(EmitterLayer(L, it));
            info.Pads.Add(rec);
        }
        if (info.Pads.Count == 0) return null;
        int speed = info.Pads.Count(p => !p.Trick);
        int layerCount = info.Pads.Sum(p => p.Layers.Count);
        Log.Info($"  Boost pads: {speed} speed + {info.Pads.Count - speed} trick, {layerCount} particle layer(s).");
        return info;
    }

    // EffectSlot -> the boost it requests on collision: MainType 17 = speed magnitude (type17), MainType 18 =
    // trick window seconds (type18). Resolves each slot's CollisionEffectSlot header and takes the first boost
    // node it carries, PLUS every MainType-2/SubType-0 emitter sitting inline on the same header - the pad's real
    // contact particles (a gold pad authors 9 of them). Collecting those means walking the WHOLE header, so the
    // boost scan must not break early on the first hit. Null if the effect document is absent.
    static Dictionary<int, (bool Trick, float Value, List<SsfType2Sub0> Layers)>? LoadBoostSlots(string levelDir)
    {
        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return null;

        var map = new Dictionary<int, (bool, float, List<SsfType2Sub0>)>();
        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            int ce = root.EffectSlots[slot].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var hdr = root.EffectHeaders[ce];
            if (hdr?.Effects == null) continue;

            bool found = false, trick = false; float value = 0f;
            var layers = new List<SsfType2Sub0>();
            foreach (var node in hdr.Effects)
            {
                if (node == null) continue;
                if (!found && node.MainType == SsfMainType.SpeedBoost && node.type17.HasValue) { found = true; trick = false; value = node.type17.Value; }
                else if (!found && node.MainType == SsfMainType.TrickBoost && node.type18.HasValue) { found = true; trick = true; value = node.type18.Value; }
                else if (node.MainType == SsfMainType.Emitter && node.type2 != null
                         && node.type2.SubType == SsfType2Sub.Emitter && node.type2.type2Sub0 != null)
                    layers.Add(node.type2.type2Sub0);
            }
            if (found) map[slot] = (trick, value, layers);
        }
        return map;
    }

    // ---- teleports: the MainType-24 "warp to a named instance" portal pairs (spec 390-teleport) ----------
    // A teleport is a collision trigger whose CollisionEffectSlot header carries a MainType-24 node: on cross the
    // engine warps the rider to near the payload's TeleportInstanceIndex instance (Boarder_WarpNearInstance). The
    // START is any instance whose EffectSlotIndex resolves - via EffectSlots[slot].CollisionEffectSlot - to that
    // header (the invisible Mdl_TeleportStart volume); the DESTINATION is the resolved instance's pivot (the visible
    // Mdl_TeleportExit marker, which stays in the merged mesh). Any MainType-8 SoundPlay on the same header is the
    // entry cue (e.g. course-bank 122). Data-derived: no name match, so it works on any level that authors
    // the same node. [Trailmap: 390-teleport]
    public static BundleManifest.TeleportsInfo? BuildTeleports(string levelDir)
    {
        var instances = SsxInstances.Load(levelDir);
        if (instances == null) return null;

        var slotTargets = LoadTeleportSlots(levelDir);   // EffectSlotIndex -> (targetInstance, entry SoundPlay)
        if (slotTargets == null || slotTargets.Count == 0) return null;

        // The start volumes: an instance whose EffectSlotIndex maps to a teleport collision effect.
        var startIndices = new HashSet<int>();
        for (int n = 0; n < instances.Count; n++)
        {
            var it = instances[n];
            if (it == null || it.EffectSlotIndex < 0) continue;
            if (slotTargets.ContainsKey(it.EffectSlotIndex)) startIndices.Add(n);
        }
        if (startIndices.Count == 0) return null;

        var groups = WalkPropsGroups(levelDir, startIndices.Contains);   // start-volume verts (negated-X mesh space)

        var info = new BundleManifest.TeleportsInfo();
        foreach (int n in startIndices.OrderBy(x => x))
        {
            var it = instances[n];
            var (target, sound) = slotTargets[it.EffectSlotIndex];
            if (target < 0 || target >= instances.Count) continue;   // destination out of range - skip (nothing to warp to)
            var exit = instances[target];
            if (exit == null) continue;

            Vector3 center, size;
            if (groups.TryGetValue(n, out var verts) && verts.Count > 0)
            {
                Vector3 min = verts[0], max = verts[0];
                foreach (var p in verts) { min = Vector3.Min(min, p); max = Vector3.Max(max, p); }
                center = (min + max) * 0.5f;
                size = max - min;
            }
            else
            {
                // No drawn volume (e.g. a pure marker instance): a small box at the instance origin.
                center = BundleSpace.MeshPt(it.Location);
                size = new Vector3(400f, 400f, 400f);
            }

            info.Teleports.Add(new BundleManifest.TeleportInfo
            {
                Index = n, Name = it.InstanceName ?? "", Slot = it.EffectSlotIndex,
                Center = BundleSpace.Xyz(center), Size = BundleSpace.Xyz(size),
                Target = target, TargetName = exit.InstanceName ?? "",
                Dest = BundleSpace.Xyz(BundleSpace.MeshPt(exit.Location)),
                Sound = sound,
            });
        }
        if (info.Teleports.Count == 0) return null;
        Log.Info($"  Teleports: {info.Teleports.Count} portal pair(s).");
        return info;
    }

    // ---- debug HUD messages: MainType-12 ---------------------------------------------------------------
    // A Show message node is ordinary ordered collision-graph work. Bake each owning instance's contact bounds plus
    // its inline text/colour, so Unity does not need to understand Effects.json or recreate the SSF scheduler. Waits
    // before the message are additive in the native chain; other nodes do not alter its presentation. Instance and
    // function hops are out of scope here: authored and autotest messages sit inline on the collision header, which
    // makes this transform exact rather than a guessed control-flow flattening.
    public static BundleManifest.HudMessagesInfo? BuildHudMessages(string levelDir)
    {
        var instances = SsxInstances.Load(levelDir);
        var root = SsfLogic.Load(levelDir);
        if (instances == null || root?.EffectSlots == null || root.EffectHeaders == null) return null;

        var bySlot = new Dictionary<int, List<(string Text, float[] Color, float Delay)>>();
        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            int ce = root.EffectSlots[slot].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var nodes = root.EffectHeaders[ce]?.Effects;
            if (nodes == null) continue;
            float delay = 0f;
            foreach (var node in nodes)
            {
                if (node == null) continue;
                if (node.MainType == SsfMainType.Wait) { delay += Math.Max(0f, node.WaitTime); continue; }
                if (node.MainType != SsfMainType.HudText || string.IsNullOrWhiteSpace(node.HudText)) continue;
                if (!bySlot.TryGetValue(slot, out var messages)) bySlot[slot] = messages = new();
                messages.Add((node.HudText.Trim(), new[]
                {
                    Math.Clamp(node.HudRed, 0f, 1f), Math.Clamp(node.HudGreen, 0f, 1f), Math.Clamp(node.HudBlue, 0f, 1f),
                }, delay));
            }
        }
        if (bySlot.Count == 0) return null;

        var owners = new HashSet<int>();
        for (int n = 0; n < instances.Count; n++)
            if (instances[n] is { EffectSlotIndex: >= 0 } it && bySlot.ContainsKey(it.EffectSlotIndex)) owners.Add(n);
        if (owners.Count == 0) return null;
        var groups = WalkPropsGroups(levelDir, owners.Contains);

        var info = new BundleManifest.HudMessagesInfo();
        foreach (int n in owners.OrderBy(x => x))
        {
            var it = instances[n];
            Vector3 center, size;
            if (groups.TryGetValue(n, out var verts) && verts.Count > 0)
            {
                Vector3 min = verts[0], max = verts[0];
                foreach (var p in verts) { min = Vector3.Min(min, p); max = Vector3.Max(max, p); }
                center = (min + max) * 0.5f; size = max - min;
            }
            else
            {
                center = BundleSpace.MeshPt(it.Location);
                size = new Vector3(400f, 400f, 400f);
            }
            foreach (var message in bySlot[it.EffectSlotIndex]) info.Messages.Add(new BundleManifest.HudMessageInfo
            {
                Index = n, Name = it.InstanceName ?? "", Slot = it.EffectSlotIndex,
                Text = message.Text, Color = message.Color, Duration = 2.5f, Delay = message.Delay,
                Center = BundleSpace.Xyz(center), Size = BundleSpace.Xyz(size),
            });
        }
        Log.Info($"  HUD messages: {info.Messages.Count} collision-triggered banner(s).");
        return info.Messages.Count == 0 ? null : info;
    }

    // EffectSlot -> the teleport it requests on collision: MainType 24's TeleportInstanceIndex (destination
    // instance) + the MainType-8 SoundPlay on the same CollisionEffectSlot header (the entry cue; -1 = none).
    // Resolves each slot's CollisionEffectSlot header and takes the first MainType-24 node. Null if the effect document
    // is absent.
    static Dictionary<int, (int Target, int Sound)>? LoadTeleportSlots(string levelDir)
    {
        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return null;

        var map = new Dictionary<int, (int, int)>();
        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            int ce = root.EffectSlots[slot].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var hdr = root.EffectHeaders[ce];
            if (hdr?.Effects == null) continue;
            int target = -1, sound = -1;
            foreach (var node in hdr.Effects)
            {
                if (node == null) continue;
                if (node.MainType == SsfMainType.PlaySound && node.SoundPlay >= 0 && sound < 0) sound = node.SoundPlay;
                else if (node.MainType == SsfMainType.Teleport && node.TeleportInstanceIndex >= 0 && target < 0) target = node.TeleportInstanceIndex;
            }
            if (target >= 0) map[slot] = (target, sound);
        }
        return map;
    }

    // One trigger volume's AABB (in negated-X mesh space), grown from its Props.obj verts.
    class TriggerVol
    {
        public int Index; public string? Name; public int Slot = -1;
        public Vector3 Min, Max; public bool Has;
        public void Add(Vector3 p) { if (!Has) { Min = Max = p; Has = true; } else { Min = Vector3.Min(Min, p); Max = Vector3.Max(Max, p); } }
    }

    // Bounds (from Props.obj) for the given firework-trigger instances. A trigger with no Props.obj group still
    // gets a (volume-less) entry so its slot's launchers are discovered - it just carries no AABB.
    static List<TriggerVol> ParseTriggerBounds(string levelDir, List<SsxInstance> instances, HashSet<int> triggerInstances)
    {
        var bounds = WalkPropsGroups(levelDir, triggerInstances.Contains);
        var outList = new List<TriggerVol>();
        foreach (int idx in triggerInstances)
        {
            if (idx < 0 || idx >= instances.Count) continue;
            var it = instances[idx];
            if (it == null) continue;
            var tv = new TriggerVol { Index = idx, Name = it.InstanceName, Slot = it.EffectSlotIndex };
            if (bounds.TryGetValue(idx, out var pts)) foreach (var p in pts) tv.Add(p);
            outList.Add(tv);
        }
        outList.Sort((a, b) => a.Index.CompareTo(b.Index));
        return outList;
    }

    class LauncherGeo { public Vector3 Top; public Vector3 Barrel; public float Radius; }

    // Each launcher's BARREL axis (long axis, by covariance + power-iteration on its verts) + MUZZLE (the higher
    // end along that axis). Convention-free (no quaternion handedness); verts negated-X like every placed prop.
    // Launchers with no Props.obj group (invisible instances) just aren't in the result - the caller falls back.
    static Dictionary<int, LauncherGeo> ParseLauncherGeometry(string levelDir, List<SsxInstance> instances, IEnumerable<int> launcherIndices)
    {
        var outMap = new Dictionary<int, LauncherGeo>();
        var wanted = new HashSet<int>(launcherIndices);
        var groups = WalkPropsGroups(levelDir, n => wanted.Contains(n));

        foreach (var kv in groups)
        {
            var v = kv.Value;
            if (v.Count < 2) continue;
            Vector3 c = Vector3.Zero;
            foreach (var p in v) c += p;
            c /= v.Count;
            float sxx = 0, sxy = 0, sxz = 0, syy = 0, syz = 0, szz = 0;
            foreach (var p in v)
            {
                Vector3 d = p - c;
                sxx += d.X * d.X; sxy += d.X * d.Y; sxz += d.X * d.Z;
                syy += d.Y * d.Y; syz += d.Y * d.Z; szz += d.Z * d.Z;
            }
            Vector3 dir = Vector3.Normalize(new Vector3(1f, 1f, 1f));
            for (int i = 0; i < 24; i++)
            {
                Vector3 nx = new Vector3(
                    sxx * dir.X + sxy * dir.Y + sxz * dir.Z,
                    sxy * dir.X + syy * dir.Y + syz * dir.Z,
                    sxz * dir.X + syz * dir.Y + szz * dir.Z);
                if (nx.LengthSquared() < 1e-12f) break;
                dir = Vector3.Normalize(nx);
            }
            // Eigenvectors have no inherent sign.  Prefer mesh-space +Z (world-up); for an effectively
            // horizontal barrel, use a stable X/Y tie-break so harmless OBJ tessellation changes cannot swap
            // the muzzle to the other end between normalization runs.
            const float axisEpsilon = 1e-5f;
            if (dir.Z < -axisEpsilon
                || (MathF.Abs(dir.Z) <= axisEpsilon
                    && (dir.X > axisEpsilon || (MathF.Abs(dir.X) <= axisEpsilon && dir.Y > 0f))))
                dir = -dir;
            float maxProj = float.NegativeInfinity, minProj = float.PositiveInfinity;
            foreach (var p in v) { float pr = Vector3.Dot(p - c, dir); if (pr > maxProj) maxProj = pr; if (pr < minProj) minProj = pr; }
            // Radius = half the prop's long-axis extent (the flare column's half-height); the importer centers + sizes the glow by it.
            outMap[kv.Key] = new LauncherGeo { Top = c + dir * maxProj, Barrel = dir, Radius = (maxProj - minProj) * 0.5f };
        }
        return outMap;
    }

    // Walk canonical Props.obj's "o inst{N}_..." groups; for each group whose instance index passes `keep`,
    // collect its v lines as negated-X mesh-space points. One pass, only the kept groups held in memory.
    internal static Dictionary<int, List<Vector3>> WalkPropsGroups(string levelDir, Func<int, bool> keep)
    {
        var outMap = new Dictionary<int, List<Vector3>>();
        string path = Path.Combine(levelDir, "Props.obj");
        if (!File.Exists(path)) return outMap;
        List<Vector3>? cur = null;
        foreach (var line in File.ReadLines(path))
        {
            if (line.Length < 2) continue;
            char c0 = line[0], c1 = line[1];
            if (c0 == 'v' && c1 == ' ')
            {
                if (cur == null) continue;
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length >= 4) cur.Add(new Vector3(-PF(p[1]), PF(p[2]), PF(p[3])));
            }
            else if (c0 == 'o' && c1 == ' ')
            {
                cur = null;
                int us = line.IndexOf("inst", StringComparison.Ordinal);
                if (us < 0) continue;
                int s = us + 4, e = s;
                while (e < line.Length && line[e] >= '0' && line[e] <= '9') e++;
                if (e <= s || !int.TryParse(line.AsSpan(s, e - s), out int n)) continue;
                if (!keep(n)) continue;
                cur = new List<Vector3>();
                outMap[n] = cur;
            }
        }
        return outMap;
    }

    // SSF effect-graph decode, per effect header and per slot. Per effect e: whether it contains a
    // MainType-2/SubType-0 particle emitter (= pyro), its complete P6 layer payload, and its MainType-8
    // SoundPlay id (the firing one-shot, course-bank-local). Per slot: the (instance, sub-effect) pairs its
    // CollisionEffectSlot fires via MainType-7 "Instance" hops. Null if the file/data is absent.
    class SsfFireworks
    {
        public readonly Dictionary<int, List<(int Inst, int Eff)>> SlotTargets = new();
        public readonly HashSet<int> EmitterEffects = new();
        public readonly Dictionary<int, List<SsfType2Sub0>> LayersByEffect = new();
        public readonly Dictionary<int, int> SoundByEffect = new();
    }

    // A firework pyro sub-effect: a MainType-2/SubType-0 emitter that also fires a report (a MainType-8 SoundPlay).
    // The report is what separates a firework volley from a SILENT ambient/continuous collision emitter that shares
    // the same trigger -> M7 -> emitter shape (e.g. a Mdl_Emitter_Spark/fire, a sewerdustemitter).
    static bool IsPyro(SsfFireworks ssf, int eff) => ssf.EmitterEffects.Contains(eff) && ssf.SoundByEffect.ContainsKey(eff);

    static SsfFireworks? LoadSsfFireworks(string levelDir)
    {
        var root = SsfLogic.Load(levelDir);
        if (root?.EffectSlots == null || root.EffectHeaders == null) return null;

        var d = new SsfFireworks();
        for (int e = 0; e < root.EffectHeaders.Length; e++)
        {
            var hdr = root.EffectHeaders[e];
            if (hdr?.Effects == null) continue;
            foreach (var node in hdr.Effects)
            {
                if (node == null) continue;
                if (node.MainType == SsfMainType.Emitter && node.type2 != null && node.type2.SubType == SsfType2Sub.Emitter && node.type2.type2Sub0 != null)
                {
                    d.EmitterEffects.Add(e);
                    if (!d.LayersByEffect.TryGetValue(e, out var layers)) d.LayersByEffect[e] = layers = new List<SsfType2Sub0>();
                    layers.Add(node.type2.type2Sub0);
                }
                else if (node.MainType == SsfMainType.PlaySound && node.SoundPlay >= 0 && !d.SoundByEffect.ContainsKey(e))
                    d.SoundByEffect[e] = node.SoundPlay;
            }
        }

        for (int slot = 0; slot < root.EffectSlots.Length; slot++)
        {
            int ce = root.EffectSlots[slot].CollisionEffectSlot;
            if (ce < 0 || ce >= root.EffectHeaders.Length) continue;
            var hdr = root.EffectHeaders[ce];
            if (hdr?.Effects == null) continue;
            List<(int, int)>? targets = null;
            foreach (var node in hdr.Effects)
            {
                if (node == null || node.MainType != SsfMainType.ActOnInstance || node.Instance == null || node.Instance.InstanceIndex < 0) continue;
                (targets ??= new List<(int, int)>()).Add((node.Instance.InstanceIndex, node.Instance.EffectIndex));
            }
            if (targets != null) d.SlotTargets[slot] = targets;
        }
        return d;
    }

    // ---- helpers ----
    static T? LoadJson<T>(string path) where T : class
    {
        if (!File.Exists(path)) return null;
        try { return JsonConvert.DeserializeObject<T>(File.ReadAllText(path)); }
        catch (Exception e)
        {
            Log.Warn($"  WARN: {path} is unreadable ({e.Message}) — read as absent.");
            return null;
        }
    }

    sealed class LoadedParticleModels
    {
        public readonly List<List<PFrame>> Ordered = new();
    }

    static LoadedParticleModels LoadModels(string path)
    {
        var result = new LoadedParticleModels();
        var parsed = LoadJson<PModelList>(path);
        if (parsed?.ParticlePrefabs == null) return result;
        foreach (var m in parsed.ParticlePrefabs)
        {
            var frames = new List<PFrame>();
            if (m.ParticleObjectHeaders != null)
                foreach (var h in m.ParticleObjectHeaders)
                    if (h.ParticleObject?.AnimationFrames != null) frames.AddRange(h.ParticleObject.AnimationFrames);
            result.Ordered.Add(frames);
        }
        return result;
    }

    static Vector3 InstancePoint(SsxInstance owner, Vector3 local)
    {
        Vector3 scale = ToVec3(owner.Scale, Vector3.One);
        Vector3 world = ToVec3(owner.Location, Vector3.Zero)
            + Vector3.Transform(scale * local, ToQuat(owner.Rotation));
        return new Vector3(-world.X, world.Y, world.Z);
    }

    static Vector3 InstanceVector(SsxInstance owner, Vector3 local)
    {
        Vector3 world = Vector3.Transform(ToVec3(owner.Scale, Vector3.One) * local, ToQuat(owner.Rotation));
        return new Vector3(-world.X, world.Y, world.Z);
    }

    static float InstanceSizeScale(SsxInstance owner)
    {
        Vector3 scale = ToVec3(owner.Scale, Vector3.One);
        return MathF.Pow(MathF.Abs(scale.X * scale.Y * scale.Z), 1f / 3f);
    }

    static Quaternion FromTo(Vector3 from, Vector3 to)
    {
        from = Vector3.Normalize(from); to = Vector3.Normalize(to);
        float dot = Math.Clamp(Vector3.Dot(from, to), -1f, 1f);
        if (dot > 0.999999f) return Quaternion.Identity;
        if (dot < -0.999999f)
        {
            Vector3 axis = Vector3.Cross(from, MathF.Abs(from.X) < 0.9f ? Vector3.UnitX : Vector3.UnitY);
            return Quaternion.CreateFromAxisAngle(Vector3.Normalize(axis), MathF.PI);
        }
        Vector3 cross = Vector3.Cross(from, to);
        return Quaternion.Normalize(new Quaternion(cross.X, cross.Y, cross.Z, 1f + dot));
    }

    static Vector3 ToVec3(float[]? a, Vector3 fallback) => (a != null && a.Length >= 3) ? new Vector3(a[0], a[1], a[2]) : fallback;
    static Quaternion ToQuat(float[]? a) => (a != null && a.Length >= 4) ? new Quaternion(a[0], a[1], a[2], a[3]) : Quaternion.Identity;
    static Vector3 NegX(float[]? a) => BundleSpace.MeshPt(a);
    static float PF(string s) => float.Parse(s, CultureInfo.InvariantCulture);

    // ---- JSON DTOs (Newtonsoft; extra fields ignored) ----
    // Newtonsoft populates these fields through reflection; direct assignments would only add DTO boilerplate.
#pragma warning disable CS0649
    class PInstList { public List<PInst>? Particles; }
    class PInst
    {
        public string? ParticleName;
        public float[]? Location;
        public float[]? Rotation;
        public float[]? Scale;
        public int ParticleModelIndex = -1;
    }
    class PModelList { public List<PModel>? ParticlePrefabs; }
    class PModel { public List<PObjHeader>? ParticleObjectHeaders; }
    class PObjHeader { public PObj? ParticleObject; }
    class PObj { public List<PFrame>? AnimationFrames; }
    class PFrame { public float[]? Position; public float[]? Rotation; public float Unknown; }

    class LightsFile { public List<LightRec>? Lights; }
    class LightRec { public string? LightName; public int Type; public int SpriteRes; public float[]? Colour; public float[]? Position; }

    class SplinesFile { public List<SplineRec>? Splines; }
    class SplineRec { public string? SplineName; public int SplineStyle; public List<SplineSeg>? Segments; }
    class SplineSeg { public float[][]? Points; }
#pragma warning restore CS0649
}
