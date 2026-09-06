using Newtonsoft.Json.Linq;
using Snowknife.Bundle;
using Snowknife.Engine;
using static Snowknife.Tests.Bundle.EffectsFixture;

namespace Snowknife.Tests.Bundle;

/// <summary>
/// The scripted-break classifier. Its whole difficulty is what it must NOT match: an EffectSlotIndex alone is
/// not a break, so a directional sign that texture-flips, a chain-link fence that flexes and a boost pad whose
/// dead node uses mode 2 all have to be walked past. Each of those look-alikes has a test here beside the real
/// break it resembles, because "classified too much" is a prop that vanishes when a rider brushes it.
/// </summary>
public class BreakableClassifierTests
{
    static List<SsxInstance> Instances(params bool[] visible) =>
        visible.Select(v => new SsxInstance { Visable = v }).ToList();

    /// <summary>Slot 0 routes its collision circumstance at <c>g-collide</c>.</summary>
    static JArray CollisionSlot() => new(new JObject
    {
        ["id"] = "slot0",
        ["circumstances"] = new JObject { ["collision"] = "g-collide" },
    });

    /// <summary>A <c>MainType 0 / Sub 20</c> mesh-throw. U3/U4/U5 carry the authored direction as the float
    /// BIT PATTERNS the SSF stores them in.</summary>
    static JObject MeshThrow(float x = 0f, float y = 0f, float z = 0f) => Node(SsfMainType.Property, new JObject
    {
        ["type0"] = new JObject
        {
            ["SubType"] = (int)SsfType0Sub.MeshAnim,
            ["type0Sub20"] = new JObject
            {
                ["U0"] = 0f,
                ["U1"] = 0.5f,
                ["U2"] = 2f,
                ["U3"] = BitConverter.SingleToInt32Bits(x),
                ["U4"] = BitConverter.SingleToInt32Bits(y),
                ["U5"] = BitConverter.SingleToInt32Bits(z),
                ["U6"] = 1f,
                ["U7"] = 1f,
                ["U8"] = 1f,
                ["U9"] = 1f,
            },
        },
    });

    static JObject CallFunction(string functionId) =>
        Node(SsfMainType.CallFunction, references: new JObject { ["function"] = functionId });

    static Dictionary<int, BreakableClassifier.Member> Classify(
        TempDir temp, JObject document, List<SsxInstance> instances) =>
        BreakableClassifier.Build(WriteLevel(temp, document), instances, out _);

    [Fact]
    public void AFenceThatHidesItselfAndRevealsAJunkTwinIsABreak()
    {
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(Graph("g-collide", 0, DeadNode(4), ActOnInstance("inst-twin"))),
            instances: new JArray(Row("inst-fence", 0), Row("inst-twin", 1)),
            slots: CollisionSlot());
        var instances = Instances(true, false);
        instances[0].EffectSlotIndex = 0;

        var map = Classify(temp, document, instances);

        Assert.Equal("brk_0", map[0].ClusterKey);
        Assert.Equal("intact", map[0].Role);
        Assert.Equal("brk_0", map[1].ClusterKey);
        Assert.Equal("broken", map[1].Role);
    }

    [Fact]
    public void ATextureFlipIsNotABreak()
    {
        // The directional sign carries an effect slot and does nothing but cycle its material.
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(Graph("g-collide", 0, TextureFlip(speed: 3.5f, length: 0f))),
            instances: new JArray(Row("inst-sign", 0)),
            slots: CollisionSlot());
        var instances = Instances(true);
        instances[0].EffectSlotIndex = 0;

        Assert.Empty(Classify(temp, document, instances));
    }

    [Fact]
    public void AFenceFlexIsNotABreak()
    {
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(Graph("g-collide", 0, Node(SsfMainType.Property, new JObject
            {
                ["type0"] = new JObject { ["SubType"] = (int)SsfType0Sub.Fence },
            }))),
            instances: new JArray(Row("inst-fence", 0)),
            slots: CollisionSlot());
        var instances = Instances(true);
        instances[0].EffectSlotIndex = 0;

        Assert.Empty(Classify(temp, document, instances));
    }

    [Fact]
    public void ADeadNodeModeOtherThanFourIsNotABreak()
    {
        // Mode 2 is what a SPEED-BOOST pad's effect carries. The mode is load-bearing, not decoration.
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(Graph("g-collide", 0, DeadNode(2))),
            instances: new JArray(Row("inst-pad", 0)),
            slots: CollisionSlot());
        var instances = Instances(true);
        instances[0].EffectSlotIndex = 0;

        Assert.Empty(Classify(temp, document, instances));
    }

    [Fact]
    public void AnInvisibleTriggerVolumeIsNotABreakable()
    {
        // A Mdl_Trigger_* volume's Sub5/Dead4 means "this one-shot node dies after firing", and its M7 targets
        // are the pyro it fires. Without the visibility gate they would all be mis-tagged as break companions.
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(Graph("g-collide", 0, DeadNode(4), ActOnInstance("inst-spark"))),
            instances: new JArray(Row("inst-trigger", 0), Row("inst-spark", 1)),
            slots: CollisionSlot());
        var instances = Instances(false, false);
        instances[0].EffectSlotIndex = 0;

        Assert.Empty(Classify(temp, document, instances));
    }

    [Fact]
    public void AVisibleCompanionHiddenOnBreakIsAScanline()
    {
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(Graph("g-collide", 0,
                DeadNode(4), ActOnInstance("inst-overlay"), ActOnInstance("inst-twin"))),
            instances: new JArray(Row("inst-screen", 0), Row("inst-overlay", 1), Row("inst-twin", 2)),
            slots: CollisionSlot());
        var instances = Instances(true, true, false);
        instances[0].EffectSlotIndex = 0;

        var map = Classify(temp, document, instances);

        Assert.Equal("intact", map[0].Role);
        Assert.Equal("scanline", map[1].Role);
        Assert.Equal("broken", map[2].Role);
        Assert.All(map.Values, m => Assert.Equal("brk_0", m.ClusterKey));
    }

    [Fact]
    public void ABreakWithNoTwinMarksTheSourceAsItsOwnDebris()
    {
        // A branch animates the source itself rather than revealing pieces, so the intact IS the debris.
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(Graph("g-collide", 0, DeadNode(4))),
            instances: new JArray(Row("inst-branch", 0)),
            slots: CollisionSlot());
        var instances = Instances(true);
        instances[0].EffectSlotIndex = 0;

        var map = Classify(temp, document, instances);

        Assert.Equal("intact", map[0].Role);
        Assert.True(map[0].IsDebris);
    }

    [Fact]
    public void TheTwinsOwnMeshThrowIsFollowedOneLevelDown()
    {
        // The hole cover's boards are thrown by the TWIN's sub-effect, not the source's chain.
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(
                Graph("g-collide", 0, DeadNode(4), ActOnInstance("inst-twin", "g-throw")),
                Graph("g-throw", 1, MeshThrow(x: 200f, y: -200f, z: 100f))),
            instances: new JArray(Row("inst-cover", 0), Row("inst-twin", 1)),
            slots: CollisionSlot());
        var instances = Instances(true, false);
        instances[0].EffectSlotIndex = 0;

        var map = Classify(temp, document, instances);

        Assert.NotNull(map[0].Throw);
        Assert.Equal(10, map[0].Throw!.Length);
    }

    [Fact]
    public void TheAuthoredThrowDirectionIsReadAsFloatsNotAsTheIntegersItIsStoredAs()
    {
        // U3/U4/U5 hold the float BIT PATTERNS of the direction. Reading them as the u32 they are typed as
        // gives 1128792064 where 200.0 was meant — invisible on every level that authored a zero direction.
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(
                Graph("g-collide", 0, DeadNode(4), ActOnInstance("inst-twin", "g-throw")),
                Graph("g-throw", 1, MeshThrow(x: 200f, y: -200f, z: 100f))),
            instances: new JArray(Row("inst-wall", 0), Row("inst-twin", 1)),
            slots: CollisionSlot());
        var instances = Instances(true, false);
        instances[0].EffectSlotIndex = 0;

        float[] thrown = Classify(temp, document, instances)[0].Throw!;

        Assert.Equal(200f, thrown[3]);
        Assert.Equal(-200f, thrown[4]);
        Assert.Equal(100f, thrown[5]);
    }

    [Fact]
    public void AZeroThrowDirectionStaysZeroSoTheCollisionFallbackSurvives()
    {
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(
                Graph("g-collide", 0, DeadNode(4), ActOnInstance("inst-twin", "g-throw")),
                Graph("g-throw", 1, MeshThrow())),
            instances: new JArray(Row("inst-wall", 0), Row("inst-twin", 1)),
            slots: CollisionSlot());
        var instances = Instances(true, false);
        instances[0].EffectSlotIndex = 0;

        float[] thrown = Classify(temp, document, instances)[0].Throw!;

        Assert.Equal(0f, thrown[3]);
        Assert.Equal(0f, thrown[4]);
        Assert.Equal(0f, thrown[5]);
    }

    [Fact]
    public void AFunctionDrivenLcdBreakGetsItsOwnClusterNamespace()
    {
        // The importer keeps HIDING an LCD's identical welded twin rather than revealing it the way it reveals
        // a fence's junk twin, so the two kinds must not share a namespace.
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(Graph("g-collide", 0, CallFunction("fn-break"))),
            functions: new JArray(Function("fn-break", 0, "BreakLogo1",
                ActOnInstance("inst-screen"), ActOnInstance("inst-twin"))),
            instances: new JArray(Row("inst-screen", 0), Row("inst-twin", 1)),
            slots: CollisionSlot());
        var instances = Instances(true, false);
        instances[0].EffectSlotIndex = 0;

        var map = Classify(temp, document, instances);

        Assert.Equal("lcd_0", map[0].ClusterKey);
        Assert.Equal("intact", map[0].Role);
        Assert.Equal("lcd_0", map[1].ClusterKey);
        Assert.Equal("broken", map[1].Role);
    }

    [Fact]
    public void AnLcdClusterCarriesNoThrowBecauseItsBreakIsAShardBurst()
    {
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(
                Graph("g-collide", 0, CallFunction("fn-break")),
                Graph("g-throw", 1, MeshThrow(x: 50f))),
            functions: new JArray(Function("fn-break", 0, "BreakLogo1",
                ActOnInstance("inst-screen"), ActOnInstance("inst-twin", "g-throw"))),
            instances: new JArray(Row("inst-screen", 0), Row("inst-twin", 1)),
            slots: CollisionSlot());
        var instances = Instances(true, false);
        instances[0].EffectSlotIndex = 0;

        var map = Classify(temp, document, instances);

        Assert.Equal("lcd_0", map[0].ClusterKey);
        Assert.Null(map[0].Throw);
    }

    // ---- fragile surfaces: the megaplex glass panes (Unity docs/036 §Cracked glass) --------------------------------
    // These are the one breakable whose collision chain does not break anything. It installs a crack that holds an
    // impact pool, and the shatter is the continuation the crack fires when the pool runs out - the slot's
    // deferred-TRIGGER column. The tests below pin both halves: that the shape is recognised at all, and that the
    // Cracked node is what licenses walking a trigger column in the first place.

    /// <summary>A pane's slot: the crack on its collision circumstance, the shatter on its trigger one.</summary>
    static JArray CrackedSlot() => new(new JObject
    {
        ["id"] = "slot0",
        ["circumstances"] = new JObject { ["collision"] = "g-collide", ["trigger"] = "g-trigger" },
    });

    /// <summary>The authored megaplex sandwich, as instances: a visible pass-through pane, its invisible SOLID
    /// support, an invisible pass-through smash volume, and the invisible shard twin.</summary>
    static List<SsxInstance> GlassInstances()
    {
        var pane = new SsxInstance { Visable = true, PlayerCollision = true, ResponseMass = 0f, EffectSlotIndex = 0 };
        var support = new SsxInstance { Visable = false, PlayerCollision = true, ResponseMass = 1e30f };
        var smash = new SsxInstance { Visable = false, PlayerCollision = true, ResponseMass = 0f };
        var junk = new SsxInstance { Visable = false, PlayerCollision = false };
        return new List<SsxInstance> { pane, support, smash, junk };
    }

    static JObject GlassDocument() => Document(
        graphs: new JArray(
            Graph("g-collide", 0, Cracked(strength: 5f, lifetime: -1f), PlaySound(65)),
            Graph("g-trigger", 1, PlaySound(64), DeadNode(2),
                ActOnInstance("inst-support", "g-kill"),
                ActOnInstance("inst-smash", "g-kill"),
                ActOnInstance("inst-junk", "g-throw")),
            Graph("g-kill", 2, DeadNode(2)),
            Graph("g-throw", 3, MeshThrow())),
        instances: new JArray(Row("inst-pane", 0), Row("inst-support", 1), Row("inst-smash", 2), Row("inst-junk", 3)),
        slots: CrackedSlot());

    [Fact]
    public void ACrackedPaneIsClassifiedFromItsTriggerColumn()
    {
        using var temp = new TempDir();

        var map = Classify(temp, GlassDocument(), GlassInstances());

        Assert.Equal("intact", map[0].Role);
        Assert.Equal("support", map[1].Role);
        Assert.Equal("smash", map[2].Role);
        Assert.Equal("broken", map[3].Role);
        Assert.All(map.Values, m => Assert.Equal("brk_0", m.ClusterKey));
    }

    [Fact]
    public void ACrackedPaneCarriesItsPoolAndBothOfItsSounds()
    {
        // The crack (65) and the smash (64) are separate authored events on separate columns, and every instance
        // in the sandwich is CollisonSound -1 - so losing either leaves that half of the break silent.
        using var temp = new TempDir();

        var intact = Classify(temp, GlassDocument(), GlassInstances())[0];

        Assert.Equal(5f, intact.CrackStrength);
        Assert.Equal(-1f, intact.CrackLifetime);
        Assert.Equal(65, intact.CrackSound);
        Assert.Equal(64, intact.BreakSound);
    }

    [Fact]
    public void ResponseMassSplitsTheSolidSupportFromThePassThroughSmashVolume()
    {
        // Both twins are invisible and both are killed by the same chain, so only the mass tells them apart - and
        // the roles do opposite things downstream: the support KEEPS its collider (the rider stands on it until
        // the glass gives way), the smash volume has none and contributes only its bounds.
        using var temp = new TempDir();
        var instances = GlassInstances();
        instances[1].ResponseMass = 0f;                    // the "support" is authored pass-through after all

        var map = Classify(temp, GlassDocument(), instances);

        Assert.Equal("smash", map[1].Role);
        Assert.DoesNotContain(map.Values, m => m.Role == "support");
    }

    [Fact]
    public void AFragileSurfaceWithNoAuthoredShatterIsNotABreak()
    {
        // A bench cell fires its trigger column at a prop without throwing a hidden twin. It is a fragile surface
        // doing something else, and dressing it up as a breakable would vanish a prop nothing ever breaks.
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(
                Graph("g-collide", 0, Cracked()),
                Graph("g-trigger", 1, ActOnInstance("inst-other", "g-kill")),
                Graph("g-kill", 2, DeadNode(2))),
            instances: new JArray(Row("inst-pane", 0), Row("inst-other", 1)),
            slots: CrackedSlot());
        var instances = new List<SsxInstance>
        {
            new SsxInstance { Visable = true, PlayerCollision = true, ResponseMass = 0f, EffectSlotIndex = 0 },
            new SsxInstance { Visable = false, PlayerCollision = true },
        };

        Assert.Empty(Classify(temp, document, instances));
    }

    [Fact]
    public void ATriggerColumnWithNoCrackedNodeIsNotWalked()
    {
        // The Cracked node is the whole licence to read a trigger column: firing column 5 on a fragile surface is
        // that node's purpose, so a column reached any other way (a Counter's count-down continuation) is not a
        // break however much its chain looks like one.
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(
                Graph("g-collide", 0, TextureFlip(speed: 3.5f, length: 0f)),
                Graph("g-trigger", 1, PlaySound(64), DeadNode(2), ActOnInstance("inst-junk", "g-throw")),
                Graph("g-throw", 2, MeshThrow())),
            instances: new JArray(Row("inst-counter", 0), Row("inst-junk", 1)),
            slots: CrackedSlot());
        var instances = new List<SsxInstance>
        {
            new SsxInstance { Visable = true, PlayerCollision = true, ResponseMass = 0f, EffectSlotIndex = 0 },
            new SsxInstance { Visable = false, PlayerCollision = false },
        };

        Assert.Empty(Classify(temp, document, instances));
    }

    [Fact]
    public void ACrackedPaneClaimsItsClusterBeforeTheTriggerDrivenPassCanForkIt()
    {
        // The pane's own smash volume is exactly the shape ScanTriggerDriven matches - an invisible zero-mass
        // volume whose chain hides a visible collidable prop and throws a hidden twin. Running the crack pass
        // first is what stops the same pane appearing as a second, crack-less cluster keyed off that volume.
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(
                Graph("g-collide", 0, Cracked(), PlaySound(65)),
                Graph("g-trigger", 1, PlaySound(64), DeadNode(2),
                    ActOnInstance("inst-support", "g-kill"), ActOnInstance("inst-junk", "g-throw")),
                Graph("g-kill", 2, DeadNode(2)),
                Graph("g-throw", 3, MeshThrow()),
                // The smash volume's OWN collision chain, breaking the same glass on contact.
                Graph("g-smash", 4, PlaySound(64), DeadNode(2),
                    ActOnInstance("inst-pane", "g-kill"), ActOnInstance("inst-junk", "g-throw"))),
            instances: new JArray(Row("inst-pane", 0), Row("inst-support", 1), Row("inst-smash", 2), Row("inst-junk", 3)),
            slots: new JArray(
                new JObject
                {
                    ["id"] = "slot0",
                    ["circumstances"] = new JObject { ["collision"] = "g-collide", ["trigger"] = "g-trigger" },
                },
                new JObject { ["id"] = "slot1", ["circumstances"] = new JObject { ["collision"] = "g-smash" } }));
        var instances = GlassInstances();
        instances[2].EffectSlotIndex = 1;

        var map = Classify(temp, document, instances);

        Assert.Equal(new[] { "brk_0" }, map.Values.Select(m => m.ClusterKey).Distinct().ToArray());
        Assert.Equal(5f, map[0].CrackStrength);
    }

    [Fact]
    public void APersistentEffectIsNotABreakHoweverItIsShaped()
    {
        // A persistent effect is what the directional sign and the fence flex live on; following it would turn
        // every one of them into a breakable.
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(Graph("g-persist", 0, DeadNode(4), ActOnInstance("inst-twin"))),
            instances: new JArray(Row("inst-prop", 0), Row("inst-twin", 1)),
            slots: new JArray(new JObject
            {
                ["id"] = "slot0",
                ["circumstances"] = new JObject { ["persistent"] = "g-persist" },
            }));
        var instances = Instances(true, false);
        instances[0].EffectSlotIndex = 0;

        Assert.Empty(Classify(temp, document, instances));
    }

    [Fact]
    public void AnInstanceWithNoEffectSlotIsNotABreakable()
    {
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(Graph("g-collide", 0, DeadNode(4))),
            instances: new JArray(Row("inst-prop", 0)),
            slots: CollisionSlot());

        Assert.Empty(Classify(temp, document, Instances(true)));
    }

    [Fact]
    public void NoDocumentOrNoInstancesClassifiesNothing()
    {
        using var temp = new TempDir();

        Assert.Empty(BreakableClassifier.Build(temp.Path, Instances(true), out var spills));
        Assert.Empty(spills);
        Assert.Empty(BreakableClassifier.Build(temp.Path, null, out _));
    }
}
