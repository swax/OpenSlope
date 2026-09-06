using System.Globalization;
using System.Numerics;
using Snowknife.Engine;

namespace Snowknife.Bundle;

/// <summary>
/// Bakes the PROP collision the Unity importer's CollisionBuilder consumes:
///   1. Bounce-bucket proxies - parse PropsCollision.obj, keep shapes with a native solid rider response, bucket faces
///      by (PlayerBounce, PlayerBounceAmmount, CollisonSound), double-side them -> collision.glb meshes +
///      per-bucket metadata (the board's per-prop bounce tiers without thousands of colliders).
///   2. Computed-bounds boxes - collidable props with no proxy mesh (signs/billboards/jumbotrons): an AABB
///      from their Props.obj vertex group -> a box per instance (metadata only). EXCEPT props whose decoded
///      mode-3 physics body has a player-sized DOORWAY (arch/gate/scaffold/waterfall/crowd stand): those get
///      a few boxes merged from the engine's own occupancy tree so the opening stays open (Unity docs/037).
///   3. Foliage swish triggers - zero-response-mass leaf cutouts with a foliage sound (7/12): an AABB -> a pass-through
///      trigger box per instance (metadata only).
/// The importer turns these into MeshColliders/BoxColliders + PropBounce + impact AudioSources. Terrain
/// collision ships separately, in terrain.glb. See Unity docs/009.
/// </summary>
public static class CollisionBundle
{
    public sealed class Opts
    {
        public float Scale = 0.01f;
        public bool BuildComputedBounds = true;
        public bool BuildFoliage = true;
        public bool BuildContactSounds = true;
        // A no-proxy mode-3 prop whose decoded physics body (SsxPhysicsBodies) contains a player-sized DOORWAY
        // (gate arch, cave-mouth scaffold, waterfall curtain, crowd stand) gets a few boxes merged from the
        // engine's own occupancy tree instead of one opening-filling visual AABB - fully data-derived
        // (Unity docs/037). Compact solids (rocks/signs) keep the AABB.
        public bool BuildDoorwayBodies = true;
        public float DoorwayPlayerSize = 180f;  // SSX cm: the opening cross-section that counts as ride-through
        // A no-proxy mode-3 body that FAILS the doorway test can still be badly served by one AABB: a
        // leaning trunk or thin diagonal pole occupies a sliver of its own bounds, and the flattened box
        // walls off the rideable space beside/under it. Below this occupied fraction the decoded body
        // shape is emitted instead - capsules along its cell runs (the engine's own rounded sphere
        // surface) plus boxes for any slab-like remainder. Compact solids keep the AABB: an upright
        // cylinder fills ~0.79 of its box and a sphere ~0.52, so 0.35 only reclassifies genuinely
        // sparse bodies.
        public float CompactMinFill = 0.35f;
        // Even a COMPACT body is badly served by the flattened world AABB when its INSTANCE is tilted:
        // a leaning trunk is upright and box-like in body space, and all the phantom volume comes from
        // axis-aligning the rotated shape (the ELYSIUM TreeBurnB trail blockers lean ~45 degrees by
        // instance rotation). When rotation+scale inflate the body's own bounds volume past this
        // factor, the body-space decomposition is emitted on the rotated instance instead. Per
        // instance - the same body stays a cheap AABB on its upright placements.
        public float MaxAabbInflation = 1.6f;
        public float MinHalf = 5f;   // SSX units (~0.05 m): keep flat sheets off a zero-thickness box
    }
    static readonly HashSet<int> FoliageSwishSounds = new() { 7, 12 };  // tree leaves, bushy leaves

    public static (List<GltfMeshWriter.Node> nodes, BundleManifest.CollisionInfo info) Build(
        string levelDir, Opts o, HashSet<int>? breakable = null, HashSet<int>? animated = null,
        HashSet<int>? physics = null, Dictionary<int, string>? breakSupports = null,
        HashSet<int>? hiddenByHideShowOff = null, HashSet<int>? hiddenByHideRace = null)
    {
        var instances = SsxInstances.Load(levelDir) ?? new List<SsxInstance>();
        var physicsBodies = SsxPhysicsBodies.Load(levelDir);
        var info = new BundleManifest.CollisionInfo();
        var nodes = new List<GltfMeshWriter.Node>();
        breakable ??= new HashSet<int>();   // breakable props (Unity docs/036) get a pass-through break trigger, NOT solid collision
        animated ??= new HashSet<int>();    // animated props carry their own moving segment colliders (AnimatedPropsBundle) -
                                            // a static bucket/box/doorway would stay put while the clip moves the prop away, so
                                            // drop them from every static path too (a retracting pillar would leave a rest-pose wall)
        physics ??= new HashSet<int>();     // knock-and-tumble roller/physics diverts (PropsBundle) own their own moving body -
                                            // a static box/bucket/doorway here would block the knock, so drop them from every static path
        // The one breakable role that KEEPS its collision (Unity docs/036 §Cracked glass): a glass pane's invisible
        // solid support twin, which holds the rider up until the pane gives way. It is deliberately NOT in
        // `breakable` above - it needs a real collider - but it cannot share one either, since the break has to
        // take this instance's collider away and leave the rest of the level's alone. So each gets its own
        // single-instance bucket stamped with the cluster the importer hands it to.
        breakSupports ??= new Dictionary<int, string>();
        hiddenByHideShowOff ??= new HashSet<int>();
        hiddenByHideRace ??= new HashSet<int>();

        BuildBounceBuckets(levelDir, instances, o, nodes, info, breakable, animated, physics, breakSupports,
            hiddenByHideShowOff, hiddenByHideRace);
        if (o.BuildComputedBounds) BuildBoundsBoxes(levelDir, instances, o, info, breakable, animated, physicsBodies,
            physics, hiddenByHideShowOff, hiddenByHideRace);
        if (o.BuildFoliage) BuildFoliageBoxes(levelDir, instances, o, info, hiddenByHideShowOff, hiddenByHideRace);
        if (o.BuildContactSounds)
            BuildContactSoundBoxes(levelDir, instances, o, info, breakable, animated, physics,
                hiddenByHideShowOff, hiddenByHideRace);
        return (nodes, info);
    }

    // ---- 1. bounce buckets from PropsCollision.obj ----
    sealed class Bucket
    {
        public string Name = ""; public bool PlayerBounce; public float Amount; public int Sound = -1;
        public int SurfaceType = -1; public string? SoundClip; public int InstanceCount; public int ModeMask = 7;
        public string? BreakCluster;   // set = this bucket is ONE breakable's support collider (Unity docs/036)
        public bool ResetOnContact;    // set = hitting this bucket resets the rider; its node name carries the "_R" tag
        public readonly List<Vector3> Verts = new();
        public readonly List<int> Tris = new();
        readonly Dictionary<int, int> _vmap = new();
        public int V(int src, List<Vector3> source)
        {
            if (src < 0 || src >= source.Count) return -1;
            if (_vmap.TryGetValue(src, out int i)) return i;
            i = Verts.Count; _vmap[src] = i; Verts.Add(source[src]); return i;
        }
    }

    static void BuildBounceBuckets(string levelDir, List<SsxInstance> instances, Opts o,
                                   List<GltfMeshWriter.Node> nodes, BundleManifest.CollisionInfo info,
                                   HashSet<int> breakable, HashSet<int> animated, HashSet<int> physics,
                                   Dictionary<int, string> breakSupports,
                                   HashSet<int> hiddenByHideShowOff, HashSet<int> hiddenByHideRace)
    {
        string objPath = Path.Combine(levelDir, "PropsCollision.obj");
        if (!File.Exists(objPath)) { Log.Info("  (no PropsCollision.obj)"); return; }

        // Props whose MainType-13 rides on their own collision. They get their own "_R" bucket below; BuildResetZones
        // marks the same instances ContactOnly so no trigger box is emitted over them as well.
        var resetHosts = ParticleBundle.ContactResetHosts(levelDir, instances);

        var src = new List<Vector3>(1 << 18);
        var buckets = new Dictionary<string, Bucket>();
        var order = new List<Bucket>();
        Bucket? cur = null;
        bool skip = false;
        int groups = 0, skipped = 0;

        foreach (var line in File.ReadLines(objPath))
        {
            if (line.Length < 2) continue;
            char c0 = line[0], c1 = line[1];
            if (c0 == 'v' && c1 == ' ')
            {
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length >= 4) src.Add(new Vector3(-PF(p[1]), PF(p[2]), PF(p[3])));
            }
            else if (c0 == 'o' && c1 == ' ')
            {
                groups++;
                int idx = ParseInst(line);
                // Rider response follows [Trailmap: 130-collision-data, 370-world-interaction]: exact-zero or
                // PlayerBounce-off is pass-through after contact. Breakables (Unity docs/036)
                // drop here too (they get a pass-through break trigger so you smash through, not a solid wall),
                // as do animated props (their moving segment colliders replace the static proxy bake).
                bool collidable = idx < 0 || idx >= instances.Count
                                  || (HasSolidRiderResponse(instances[idx])
                                      && !breakable.Contains(idx) && !animated.Contains(idx) && !physics.Contains(idx));
                if (!collidable) { skip = true; cur = null; skipped++; }
                else
                {
                    skip = false;
                    cur = BucketFor(idx, instances, buckets, order, breakSupports, resetHosts,
                        hiddenByHideShowOff, hiddenByHideRace);
                    cur.InstanceCount++;
                }
            }
            else if (c0 == 'f' && c1 == ' ')
            {
                if (skip) continue;
                cur ??= BucketFor(-1, instances, buckets, order, breakSupports, resetHosts,
                    hiddenByHideShowOff, hiddenByHideRace);
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length < 4) continue;
                int v0 = cur.V(FaceIdx(p[1], src.Count), src);
                for (int k = 2; k < p.Length - 1; k++)
                {
                    int v1 = cur.V(FaceIdx(p[k], src.Count), src);
                    int v2 = cur.V(FaceIdx(p[k + 1], src.Count), src);
                    if (v0 >= 0 && v1 >= 0 && v2 >= 0)
                    {
                        cur.Tris.Add(v0); cur.Tris.Add(v1); cur.Tris.Add(v2);   // double-sided: both windings
                        cur.Tris.Add(v0); cur.Tris.Add(v2); cur.Tris.Add(v1);
                    }
                }
            }
        }

        int colliders = 0, tris = 0;
        foreach (var b in order)
        {
            if (b.Tris.Count == 0) continue;
            string node = "PropsCollision_" + b.Name;
            nodes.Add(new GltfMeshWriter.Node
            {
                Name = node,
                Prims = { new GltfMeshWriter.Prim { Material = "collision", Positions = b.Verts, Indices = b.Tris } }
            });
            info.Buckets.Add(new BundleManifest.BucketInfo
            {
                Node = node, PlayerBounce = b.PlayerBounce, PlayerBounceAmmount = b.Amount,
                InstanceCount = b.InstanceCount, CollisonSound = b.Sound, SurfaceType = b.SurfaceType,
                SoundClip = b.SoundClip, BreakCluster = b.BreakCluster, ModeMask = b.ModeMask,
                ResetOnContact = b.ResetOnContact,
            });
            colliders++; tris += b.Tris.Count / 3;
        }
        int resetBuckets = order.Count(b => b.Tris.Count > 0 && b.ResetOnContact);
        Log.Info($"  Collision (props): {colliders} bounce buckets, {tris:n0} tris, {groups} groups ({skipped} pass-through skipped)."
            + (resetBuckets > 0 ? $" {resetBuckets} reset-on-contact bucket(s) over {resetHosts.Count} host(s)." : ""));
    }

    static Bucket BucketFor(int idx, List<SsxInstance> instances, Dictionary<string, Bucket> buckets, List<Bucket> order,
                            Dictionary<int, string> breakSupports, HashSet<int> resetHosts,
                            HashSet<int> hiddenByHideShowOff, HashSet<int> hiddenByHideRace)
    {
        bool bounce = false; float amount = 0f; int snd = -1; int surface = -1; string? soundClip = null;
        int modeMask = 7;
        if (idx >= 0 && idx < instances.Count)
        {
            var it = instances[idx];
            bounce = it.PlayerBounce;
            if (bounce) amount = MathF.Max(0f, it.PlayerBounceAmmount);
            snd = it.CollisonSound;
            surface = it.SurfaceType;
            soundClip = it.SoundClip;
            modeMask = PropsBundle.ModeMaskForInstance(it.LTGState == 2,
                hiddenByHideShowOff.Contains(idx), hiddenByHideRace.Contains(idx));
        }
        amount = MathF.Round(amount * 1000f) / 1000f;
        // A breakable's SUPPORT twin gets a bucket of its own, keyed by instance so nothing else can join it: the
        // whole point is a collider the break can disable on its own. It keeps the bounce/surface/sound facts of an
        // ordinary bucket, because until the glass gives way it IS an ordinary solid surface to ride on.
        // A RESET HOST rides in its own bucket for the same reason a breakable's support does: the reset is a fact
        // about THIS prop, and the board reads it off the collider it hit, so it cannot be merged in with ordinary
        // scenery. The "_R" the label ends with is that tag ([Unity docs/053]); ResetOnContact parses it off the
        // name rather than a component, to keep GetComponent off the swept-hit path in Udon.
        bool resetHost = resetHosts.Contains(idx);
        string key = breakSupports.TryGetValue(idx, out string? supportCluster)
            ? "brksupport_" + idx
            : (bounce ? "bounce_" + amount.ToString("0.###", CultureInfo.InvariantCulture) : "slide")
                     + "_snd" + snd + "_surf" + surface + "_clip" + soundClip + "_mode" + modeMask
                     + (resetHost ? "_reset" : "");
        if (!buckets.TryGetValue(key, out var b))
        {
            string label = supportCluster != null
                ? "Support_" + idx
                : (bounce ? "Bounce_" + amount.ToString("0.###", CultureInfo.InvariantCulture).Replace('.', '_') : "Slide")
                           + "_Snd" + snd + (surface >= 0 ? "_T" + surface : "")
                           + (soundClip != null ? "_Clip" + order.Count : "")
                           + (modeMask != 7 ? "_M" + modeMask : "");
            if (resetHost) label += "_R";   // must stay LAST: the board tests the name's tail
            b = new Bucket { Name = label, PlayerBounce = bounce, Amount = amount, Sound = snd,
                             SurfaceType = surface, SoundClip = soundClip, BreakCluster = supportCluster,
                             ModeMask = modeMask, ResetOnContact = resetHost };
            buckets[key] = b; order.Add(b);
        }
        return b;
    }

    // ---- 2 + 3. per-instance AABB boxes from Props.obj ----
    static void BuildBoundsBoxes(string levelDir, List<SsxInstance> instances, Opts o, BundleManifest.CollisionInfo info,
                                 HashSet<int> breakable, HashSet<int> animated, SsxPhysicsBodies physicsBodies,
                                 HashSet<int> physics, HashSet<int> hiddenByHideShowOff,
                                 HashSet<int> hiddenByHideRace)
    {
        var need = new bool[instances.Count];
        var shapes = new Dictionary<int, CachedBody>();   // PhysicsIndex -> body facts + lazy decompositions
        int bodyProps = 0, bodyBoxes = 0, bodyCapsules = 0;
        for (int i = 0; i < instances.Count; i++)
        {
            var it = instances[i];
            if (it == null || !it.Visable || !HasContactShape(it)) continue;
            if (breakable.Contains(i)) continue;                                              // breakable (Unity docs/036) -> pass-through break trigger, not a solid box
            if (animated.Contains(i)) continue;                                               // animated divert -> its segment colliders ride the clip; a static box would stay behind as a rest-pose wall
            if (physics.Contains(i)) continue;                                                // roller/physics divert -> its own knock-and-tumble body owns collision (no static box or doorway body)
            if (it.CollsionModelPaths != null && it.CollsionModelPaths.Length > 0) continue;  // has proxy -> bucketed
            if (!HasSolidRiderResponse(it)) continue;
            int modeMask = PropsBundle.ModeMaskForInstance(it.LTGState == 2,
                hiddenByHideShowOff.Contains(i), hiddenByHideRace.Contains(i));
            if (o.BuildDoorwayBodies && TryEmitBody(i, it, modeMask, o, physicsBodies, shapes, info.Bodies,
                out int boxes, out int caps))
            {
                bodyProps++;
                bodyBoxes += boxes;
                bodyCapsules += caps;
                continue;
            }
            need[i] = true;
        }
        EmitBoxes(levelDir, instances, need, o, info.ComputedBounds, hiddenByHideShowOff, hiddenByHideRace);
        Log.Info($"  Collision (bounds): {info.ComputedBounds.Count} computed-bounds boxes (no-proxy signs/billboards), " +
                          $"{bodyProps} body prop(s) using {bodyBoxes} box(es) + {bodyCapsules} capsule(s) " +
                          $"({shapes.Count(kv => kv.Value.DoorwayShape != null)} doorway / " +
                          $"{shapes.Count(kv => kv.Value.SparseShape != null)} sparse / " +
                          $"{shapes.Count(kv => kv.Value.TiltShape != null)} tilted of {shapes.Count} distinct bodies).");
    }

    // One physics body's emitted decomposition (boxes and/or capsules).
    sealed class BodyShape
    {
        public List<(Vector3 Min, Vector3 Max)> Boxes = new();
        public List<SsxPhysicsBodies.Body.Capsule> Capsules = new();
    }

    // Capsules along the body's elongated cell runs - the engine's own rounded sphere surface - plus
    // greedy boxes for the slab/blob remainder. Neither shape covers an empty cell beyond leaf reach,
    // so a doorway opening stays open (a streetlight is a pole capsule + a lamp-head box with the
    // pass-under gap between them empty).
    static BodyShape CapsuleRunsPlusBoxes(SsxPhysicsBodies.Body body)
    {
        var capsules = body.GreedyCapsules(out var leftover);
        return new BodyShape
        {
            Capsules = capsules,
            Boxes = leftover.Count >= 3 ? body.GreedyBoxes(subset: leftover) : new(),
        };
    }

    // How much an instance's rotation+scale inflate the body's own bounds into a world AABB. 1 = the
    // AABB is the body box (no rotation cost); a ~45-degree lean of a slim trunk costs several times
    // its volume in phantom space. Translation drops out - only extents matter.
    static float AabbInflation(SsxInstance it, Vector3 mn, Vector3 mx, float minHalf)
    {
        if (it.Rotation == null || it.Rotation.Length < 4) return 1f;
        var rot = new Quaternion(it.Rotation[0], it.Rotation[1], it.Rotation[2], it.Rotation[3]);
        Vector3 s = (it.Scale != null && it.Scale.Length >= 3)
            ? new Vector3(it.Scale[0], it.Scale[1], it.Scale[2]) : Vector3.One;
        Vector3 floor = new(2f * minHalf);
        Vector3 ext = Vector3.Max((mx - mn) * Vector3.Abs(s), floor);
        Vector3 amin = new(float.MaxValue), amax = new(float.MinValue);
        for (int i = 0; i < 8; i++)
        {
            var corner = new Vector3((i & 1) == 0 ? mn.X : mx.X,
                                     (i & 2) == 0 ? mn.Y : mx.Y,
                                     (i & 4) == 0 ? mn.Z : mx.Z) * s;
            var w = Vector3.Transform(corner, rot);
            amin = Vector3.Min(amin, w); amax = Vector3.Max(amax, w);
        }
        Vector3 aext = Vector3.Max(amax - amin, floor);
        return (aext.X * aext.Y * aext.Z) / (ext.X * ext.Y * ext.Z);
    }

    // Per-body facts computed once; the doorway/sparse decompositions are built lazily because whether
    // an instance uses them can depend on that instance's rotation, not only on the body.
    sealed class CachedBody
    {
        public SsxPhysicsBodies.Body Body = null!;
        public bool Doorway;
        public float Fill;
        public Vector3 BoundsMin, BoundsMax;   // occupied cells +/- leaf reach, body space
        public BodyShape? DoorwayShape;
        public BodyShape? SparseShape;
        public BodyShape? TiltShape;           // compact-but-tilted: 1-2 clean capsules, else one oriented box
    }

    // If the instance's decoded mode-3 body has a player-sized doorway OR is too sparse for its own AABB
    // (a leaning trunk fills a sliver of its bounds; the flat box would wall the trail beside it), emit
    // the body's decomposition (body-local space, instance scale baked in, X mirrored to mesh space) +
    // the instance pivot/rotation. Doorway and sparse bodies both get capsules along their elongated
    // cell runs plus boxes for any slab remainder (CapsuleRunsPlusBoxes).
    static bool TryEmitBody(int idx, SsxInstance it, int modeMask, Opts o, SsxPhysicsBodies physicsBodies,
                            Dictionary<int, CachedBody> cache,
                            List<BundleManifest.BodyInfo> outList, out int boxCount, out int capsuleCount)
    {
        boxCount = 0; capsuleCount = 0;
        if (it.PhysicsIndex < 0 || !physicsBodies.TryGet(it.PhysicsIndex, out var body)) return false;
        if (!cache.TryGetValue(it.PhysicsIndex, out var cached))
        {
            cached = new CachedBody
            {
                Body = body,
                Doorway = body.HasDoorway(o.DoorwayPlayerSize),
                Fill = body.FillFraction(o.DoorwayPlayerSize),
            };
            (cached.BoundsMin, cached.BoundsMax) = body.Bounds();
            cache[it.PhysicsIndex] = cached;
        }

        BodyShape? shape = null;
        if (cached.Doorway)
            shape = cached.DoorwayShape ??= CapsuleRunsPlusBoxes(body);
        else if (cached.Fill < o.CompactMinFill)
            shape = cached.SparseShape ??= CapsuleRunsPlusBoxes(body);
        else if (AabbInflation(it, cached.BoundsMin, cached.BoundsMax, o.MinHalf) > o.MaxAabbInflation)
        {
            if (cached.TiltShape == null)
            {
                // Compact but tilted. When the body IS one clean elongated run (a leaning trunk), its
                // capsule form keeps retail's rounded contact; anything blobbier (yawed dumpster,
                // leaned crate) becomes ONE body-local box on the rotated instance - a tight OBB that
                // beats both the phantom world AABB and a many-box greedy decomposition (the fill test
                // already proved the body's own bounds are a faithful shape proxy).
                var capsules = body.GreedyCapsules(out var leftover);
                cached.TiltShape = capsules.Count is >= 1 and <= 2 && leftover.Count < 3
                    ? new BodyShape { Capsules = capsules }
                    : new BodyShape { Boxes = new() { (cached.BoundsMin, cached.BoundsMax) } };
            }
            shape = cached.TiltShape;
        }
        if (shape == null || (shape.Boxes.Count == 0 && shape.Capsules.Count == 0)) return false;
        var boxes = shape.Boxes;

        Vector3 s = (it.Scale != null && it.Scale.Length >= 3) ? new Vector3(it.Scale[0], it.Scale[1], it.Scale[2]) : Vector3.One;
        float[] rot = (it.Rotation != null && it.Rotation.Length >= 4) ? it.Rotation : new[] { 0f, 0f, 0f, 1f };
        var rec = new BundleManifest.BodyInfo
        {
            Name = string.IsNullOrEmpty(it.InstanceName) ? ("inst" + idx) : it.InstanceName!,
            InstanceIndex = idx,
            PhysicsIndex = it.PhysicsIndex,
            Center = BundleSpace.Xyz(BundleSpace.MeshPt(it.Location)),
            // mesh space mirrors X (M = diag(-1,1,1)): M R M conjugation maps quat (x,y,z,w) -> (x,-y,-z,w)
            Rotation = new[] { rot[0], -rot[1], -rot[2], rot[3] },
            CollisonSound = it.CollisonSound,
            SoundClip = it.SoundClip,
            ModeMask = modeMask,
        };
        foreach (var (mn, mx) in boxes)
        {
            Vector3 c = (mn + mx) * 0.5f * s;
            Vector3 sz = (mx - mn) * s;
            rec.Boxes.Add(new BundleManifest.BodyBox
            {
                Center = new[] { -c.X, c.Y, c.Z },   // body-local point mirrored into mesh space (M p)
                Size = new[] { MathF.Abs(sz.X), MathF.Abs(sz.Y), MathF.Abs(sz.Z) },
            });
        }
        // A capsule radius has no exact image under non-uniform scale; the max component keeps it
        // conservative (retail prop scales are uniform in practice, where this is exact).
        float radiusScale = MathF.Max(MathF.Abs(s.X), MathF.Max(MathF.Abs(s.Y), MathF.Abs(s.Z)));
        foreach (var cp in shape.Capsules)
        {
            Vector3 a = cp.A * s, b = cp.B * s;
            rec.Capsules.Add(new BundleManifest.BodyCapsule
            {
                A = new[] { -a.X, a.Y, a.Z },
                B = new[] { -b.X, b.Y, b.Z },
                Radius = cp.Radius * radiusScale,
            });
        }
        outList.Add(rec);
        boxCount = rec.Boxes.Count;
        capsuleCount = rec.Capsules.Count;
        return true;
    }

    static void BuildFoliageBoxes(string levelDir, List<SsxInstance> instances, Opts o,
                                  BundleManifest.CollisionInfo info, HashSet<int> hiddenByHideShowOff,
                                  HashSet<int> hiddenByHideRace)
    {
        var need = new bool[instances.Count];
        for (int i = 0; i < instances.Count; i++)
        {
            var it = instances[i];
            if (it == null || !it.Visable || !HasContactShape(it)) continue;
            if (HasSolidRiderResponse(it)) continue;                        // only native pass-through response cases
            if (!FoliageSwishSounds.Contains(it.CollisonSound)) continue;   // pass-through but not leaves
            need[i] = true;
        }
        EmitBoxes(levelDir, instances, need, o, info.Foliage, hiddenByHideShowOff, hiddenByHideRace);
        Log.Info($"  Collision (foliage): {info.Foliage.Count} leaf swish trigger boxes.");
    }

    /// <summary>
    /// One instance's placement, and the two conversions an oriented box needs: a placed SSX point back into
    /// the instance's own frame, and that frame's rotation as the mesh-space quaternion the bundle carries.
    /// Scale is deliberately not divided out - the extents wanted are the ones the Unity holder will carry,
    /// and a BoxCollider size is already local to it.
    /// </summary>
    internal readonly struct Placement
    {
        public readonly Vector3 Origin;
        public readonly Quaternion Rotation;
        public Placement(Vector3 origin, Quaternion rotation) { Origin = origin; Rotation = rotation; }

        public static Placement Of(SsxInstance? it)
        {
            var loc = it?.Location;
            var rot = it?.Rotation;
            return new Placement(
                (loc != null && loc.Length >= 3) ? new Vector3(loc[0], loc[1], loc[2]) : Vector3.Zero,
                (rot != null && rot.Length >= 4) ? new Quaternion(rot[0], rot[1], rot[2], rot[3]) : Quaternion.Identity);
        }

        public Vector3 ToLocal(Vector3 rawWorld) => Vector3.Transform(rawWorld - Origin, Quaternion.Inverse(Rotation));

        /// <summary>Mesh space mirrors X (M = diag(-1,1,1)); M R M maps quat (x,y,z,w) -> (x,-y,-z,w).</summary>
        public float[] MeshRotation() => new[] { Rotation.X, -Rotation.Y, -Rotation.Z, Rotation.W };
    }

    /// <summary>
    /// 3b. The last props that would otherwise reach Unity with no presence at all: **ride-through, not
    /// foliage, and not diverted**. A solid prop carries its hit sound on its own collider and a breakable,
    /// animated or Roller prop carries it on the collider its own emitter builds — but a plain pass-through
    /// prop with a hit sound is represented by nothing, so riding through it is silent.
    ///
    /// The residue is small precisely because the diverts absorb so much of it (44 instances across the
    /// shipped levels when this was written, 38 of them one Snowdream firework prop), which is why these get a
    /// trigger volume rather than anything cleverer.
    /// </summary>
    static void BuildContactSoundBoxes(string levelDir, List<SsxInstance> instances, Opts o,
                                       BundleManifest.CollisionInfo info,
                                       HashSet<int> breakable, HashSet<int> animated, HashSet<int> physics,
                                       HashSet<int> hiddenByHideShowOff, HashSet<int> hiddenByHideRace)
    {
        var need = new bool[instances.Count];
        for (int i = 0; i < instances.Count; i++)
        {
            var it = instances[i];
            if (it == null || !it.Visable || !HasContactShape(it)) continue;
            if (HasSolidRiderResponse(it)) continue;                        // its own collider carries the sound
            if (it.CollisonSound < 0) continue;                             // nothing to play
            if (FoliageSwishSounds.Contains(it.CollisonSound)) continue;    // the foliage pass owns the leaves
            if (breakable.Contains(i) || animated.Contains(i) || physics.Contains(i)) continue;  // own emitters
            need[i] = true;
        }
        EmitBoxes(levelDir, instances, need, o, info.ContactSounds, hiddenByHideShowOff, hiddenByHideRace);
        Log.Info($"  Collision (contact sound): {info.ContactSounds.Count} ride-through hit-sound trigger box(es).");
    }

    // One ORIENTED box per needed instance, from its Props.obj 'o inst{N}' vertex group (negated X, mesh space).
    //
    // The engine's mode-2 collider is the model's OWN box turned with the placement, not the axis-aligned
    // envelope of the turned result (spec 130-mode2-oriented, read live off a paused session). So the placed
    // vertices are carried back into the instance's own frame before min/max, and the rotation rides along on
    // the record. Emitting the world AABB instead inflates 62% of the shipped mode-2 colliders - median 1.6x
    // the volume, and hundreds of times over for the thin turned things (rail supports, jumbotron screens,
    // banners) where the box is fat exactly where the art has no thickness.
    static void EmitBoxes(string levelDir, List<SsxInstance> instances, bool[] need, Opts o,
                          List<BundleManifest.BoxInfo> outList, HashSet<int> hiddenByHideShowOff,
                          HashSet<int> hiddenByHideRace)
    {
        bool any = false;
        for (int i = 0; i < need.Length; i++) if (need[i]) { any = true; break; }
        if (!any) return;
        string objPath = Path.Combine(levelDir, "Props.obj");
        if (!File.Exists(objPath)) return;

        var mn = new Vector3[instances.Count];
        var mx = new Vector3[instances.Count];
        var has = new bool[instances.Count];
        // Each needed instance's placement, so its own vertices can be read back into its own frame.
        var placement = new Placement[instances.Count];
        for (int i = 0; i < instances.Count; i++)
            if (need[i]) placement[i] = Placement.Of(instances[i]);
        int cur = -1;
        foreach (var line in File.ReadLines(objPath))
        {
            if (line.Length < 2) continue;
            char c0 = line[0], c1 = line[1];
            if (c0 == 'o' && c1 == ' ') cur = ParseInst(line);
            else if (c0 == 'v' && c1 == ' ')
            {
                if (cur < 0 || cur >= instances.Count || !need[cur]) continue;
                var p = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (p.Length < 4) continue;
                // Props.obj is placed geometry in mesh space; undo the X mirror to get raw SSX, then undo the
                // placement's translation and rotation. Scale is deliberately left in: the extents wanted here
                // are the ones the holder will carry, and a Unity BoxCollider size is already local.
                Vector3 raw = new(PF(p[1]), PF(p[2]), PF(p[3]));
                Vector3 v = placement[cur].ToLocal(raw);
                if (!has[cur]) { mn[cur] = v; mx[cur] = v; has[cur] = true; }
                else { mn[cur] = Vector3.Min(mn[cur], v); mx[cur] = Vector3.Max(mx[cur], v); }
            }
        }
        for (int i = 0; i < instances.Count; i++)
        {
            if (!need[i] || !has[i]) continue;
            Vector3 center = (mn[i] + mx[i]) * 0.5f;   // still in the instance's own frame
            Vector3 half = (mx[i] - mn[i]) * 0.5f;
            half = new Vector3(MathF.Max(half.X, o.MinHalf), MathF.Max(half.Y, o.MinHalf), MathF.Max(half.Z, o.MinHalf));
            string nm = string.IsNullOrEmpty(instances[i].InstanceName) ? ("inst" + i) : instances[i].InstanceName!;
            outList.Add(new BundleManifest.BoxInfo
            {
                Name = nm,
                Center = BundleSpace.Xyz(BundleSpace.MeshPt(instances[i].Location)),
                // Same convention as the mode-3 body records above: the rotation is conjugated by the X mirror
                // and a local point mirrors as M p.
                Rotation = placement[i].MeshRotation(),
                LocalCenter = new[] { -center.X, center.Y, center.Z },
                Size = new[] { half.X * 2f, half.Y * 2f, half.Z * 2f },
                // Keep the box proxy's response metadata tied to the retail instance that produced it.
                // The Unity importer realizes these fields through the same PropBounce hand-off used
                // by triangle buckets; the box is only a different contact shape, not a different response.
                PlayerBounce = instances[i].PlayerBounce,
                PlayerBounceAmmount = instances[i].PlayerBounce
                    ? MathF.Max(0f, instances[i].PlayerBounceAmmount)
                    : 0f,
                SurfaceType = instances[i].SurfaceType,
                CollisonSound = instances[i].CollisonSound,
                SoundClip = instances[i].SoundClip,
                ModeMask = PropsBundle.ModeMaskForInstance(instances[i].LTGState == 2,
                    hiddenByHideShowOff.Contains(i), hiddenByHideRace.Contains(i)),
            });
        }
    }

    static bool HasContactShape(SsxInstance it) => it.PlayerCollision && it.CollsionMode switch
    {
        NativeCollisionMode.TriangleProxy => it.CollsionModelPaths is { Length: > 0 },
        NativeCollisionMode.BoundingBox => true,
        NativeCollisionMode.PhysicsBodySpheres => it.PhysicsIndex >= 0,
        _ => false,
    };

    // internal: ParticleBundle.ContactResetHosts asks the same question, so that a reset is never diverted off a
    // volume and onto collision that this bake would skip as pass-through.
    internal static bool HasSolidRiderResponse(SsxInstance it) =>
        HasContactShape(it) && NativeCollisionMode.HasStaticRiderResponse(
            it.CollsionMode, it.PlayerBounce, it.ResponseMass);

    static int ParseInst(string line)
    {
        int us = line.IndexOf("inst", StringComparison.Ordinal);
        if (us < 0) return -1;
        int s = us + 4, e = s;
        while (e < line.Length && line[e] >= '0' && line[e] <= '9') e++;
        return e > s && int.TryParse(line.AsSpan(s, e - s), out int n) ? n : -1;
    }
    static int FaceIdx(string token, int srcCount)
    {
        int slash = token.IndexOf('/');
        var head = slash < 0 ? token.AsSpan() : token.AsSpan(0, slash);
        if (!int.TryParse(head, NumberStyles.Integer, CultureInfo.InvariantCulture, out int vi)) return -1;
        vi = vi < 0 ? srcCount + vi : vi - 1;
        return vi >= 0 && vi < srcCount ? vi : -1;
    }
    static float PF(string s) => float.Parse(s, CultureInfo.InvariantCulture);
}
