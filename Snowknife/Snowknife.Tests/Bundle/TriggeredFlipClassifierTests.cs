using Newtonsoft.Json.Linq;
using Snowknife.Bundle;
using Snowknife.Engine;
using static Snowknife.Tests.Bundle.EffectsFixture;

namespace Snowknife.Tests.Bundle;

/// <summary>
/// The ride-over buttons that pulse a second material state and settle back. The distinction this class
/// exists to draw is the flip node's <b>Length</b>: zero is a free-running flipbook, above zero is a
/// collision-fired one-shot. Read it wrong in one direction and a checkpoint stops animating; in the other,
/// every megaplex button free-runs forever instead of flashing on a crossing.
/// </summary>
public class TriggeredFlipClassifierTests
{
    static List<SsxInstance> Instances(int count) =>
        Enumerable.Range(0, count).Select(_ => new SsxInstance()).ToList();

    /// <summary>Slot 0 binds the collision circumstance to graph <c>g-collide</c>.</summary>
    static JObject WithCollisionSlot(JArray graphs, JArray? instances = null) => Document(
        graphs: graphs,
        instances: instances ?? new JArray(),
        slots: new JArray(new JObject
        {
            ["id"] = "slot0",
            ["circumstances"] = new JObject { ["collision"] = "g-collide" },
        }));

    static JObject SelectFrame(int frame) => Node(SsfMainType.AddDelta,
        new JObject { ["type3"] = new JObject { ["U0"] = 2f, ["U1"] = (float)frame } });

    [Fact]
    public void AVolumeThatHopsAOneShotFlipOntoAButtonProducesAPulse()
    {
        using var temp = new TempDir();
        var document = WithCollisionSlot(
            new JArray(
                Graph("g-collide", 0, ActOnInstance("inst-button", "g-flip")),
                Graph("g-flip", 1, TextureFlip(speed: 3.5f, length: 0.5f), SelectFrame(1))),
            new JArray(Row("inst-volume", 0), Row("inst-button", 1)));
        var instances = Instances(2);
        instances[0].EffectSlotIndex = 0;

        var pulses = TriggeredFlipClassifier.Classify(WriteLevel(temp, document), instances, _ => false);

        var pulse = Assert.Single(pulses).Value;
        Assert.Equal(1, pulse.Instance);
        Assert.Equal(3.5f, pulse.Speed);
        Assert.Equal(0.5f, pulse.Length);
        Assert.Equal(1, pulse.SelectFrame);
        Assert.Equal(new[] { 0 }, pulse.Volumes);
    }

    [Fact]
    public void APersistentFlipIsNotAPulse()
    {
        // Length 0 lives as long as its slot: that is the checkpoint top and the directional signs, which
        // PropsExporter records in Flip.json instead. Treating it as a pulse would stop it animating.
        using var temp = new TempDir();
        var document = WithCollisionSlot(
            new JArray(
                Graph("g-collide", 0, ActOnInstance("inst-sign", "g-flip")),
                Graph("g-flip", 1, TextureFlip(speed: 3.5f, length: 0f))),
            new JArray(Row("inst-volume", 0), Row("inst-sign", 1)));
        var instances = Instances(2);
        instances[0].EffectSlotIndex = 0;

        Assert.Empty(TriggeredFlipClassifier.Classify(WriteLevel(temp, document), instances, _ => false));
    }

    [Fact]
    public void AHeaderThatFlipsItsOwnCarrierIsAPulseOnItself()
    {
        // The only shape an authored level can express, since Slopesmith's document has no instance table for
        // a hop to name. The prop is both the trigger and the surface that flashes.
        using var temp = new TempDir();
        var document = WithCollisionSlot(
            new JArray(Graph("g-collide", 0, TextureFlip(speed: 2f, length: 1f))),
            new JArray(Row("inst-button", 0)));
        var instances = Instances(1);
        instances[0].EffectSlotIndex = 0;

        var pulse = Assert.Single(TriggeredFlipClassifier.Classify(
            WriteLevel(temp, document), instances, _ => false)).Value;

        Assert.Equal(0, pulse.Instance);
        Assert.Equal(new[] { 0 }, pulse.Volumes);
        Assert.Equal(1f, pulse.Length);
    }

    [Fact]
    public void AnInstanceClaimedByAnotherDivertKindIsLeftAlone()
    {
        // A breakable or spinner owns its geometry; it must not also become a button.
        using var temp = new TempDir();
        var document = WithCollisionSlot(
            new JArray(
                Graph("g-collide", 0, ActOnInstance("inst-button", "g-flip")),
                Graph("g-flip", 1, TextureFlip(speed: 3.5f, length: 0.5f))),
            new JArray(Row("inst-volume", 0), Row("inst-button", 1)));
        var instances = Instances(2);
        instances[0].EffectSlotIndex = 0;

        Assert.Empty(TriggeredFlipClassifier.Classify(
            WriteLevel(temp, document), instances, target => target == 1));
    }

    [Fact]
    public void SeveralVolumesFiringOneButtonAreCollectedUnderOnePulse()
    {
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(
                Graph("g-collide", 0, ActOnInstance("inst-button", "g-flip")),
                Graph("g-flip", 1, TextureFlip(speed: 3.5f, length: 0.5f))),
            instances: new JArray(Row("inst-a", 0), Row("inst-b", 1), Row("inst-button", 2)),
            slots: new JArray(new JObject
            {
                ["id"] = "slot0",
                ["circumstances"] = new JObject { ["collision"] = "g-collide" },
            }));
        var instances = Instances(3);
        instances[0].EffectSlotIndex = 0;
        instances[1].EffectSlotIndex = 0;

        var pulse = Assert.Single(TriggeredFlipClassifier.Classify(
            WriteLevel(temp, document), instances, _ => false)).Value;

        Assert.Equal(2, pulse.Instance);
        Assert.Equal(new[] { 0, 1 }, pulse.Volumes);
    }

    [Fact]
    public void AGraphThatSelectsNoFrameReportsMinusOne()
    {
        using var temp = new TempDir();
        var document = WithCollisionSlot(
            new JArray(
                Graph("g-collide", 0, ActOnInstance("inst-button", "g-flip")),
                Graph("g-flip", 1, TextureFlip(speed: 3.5f, length: 0.5f))),
            new JArray(Row("inst-volume", 0), Row("inst-button", 1)));
        var instances = Instances(2);
        instances[0].EffectSlotIndex = 0;

        Assert.Equal(-1, Assert.Single(TriggeredFlipClassifier.Classify(
            WriteLevel(temp, document), instances, _ => false)).Value.SelectFrame);
    }

    [Fact]
    public void APersistentCircumstanceIsNotScanned()
    {
        // Only the COLLISION circumstance fires a one-shot. A flip on the persistent slot is the free-running
        // kind however long its Length says it is.
        using var temp = new TempDir();
        var document = Document(
            graphs: new JArray(Graph("g-persist", 0, TextureFlip(speed: 3.5f, length: 0.5f))),
            instances: new JArray(Row("inst-a", 0)),
            slots: new JArray(new JObject
            {
                ["id"] = "slot0",
                ["circumstances"] = new JObject { ["persistent"] = "g-persist" },
            }));
        var instances = Instances(1);
        instances[0].EffectSlotIndex = 0;

        Assert.Empty(TriggeredFlipClassifier.Classify(WriteLevel(temp, document), instances, _ => false));
    }

    [Fact]
    public void NoDocumentOrNoInstancesClassifiesNothing()
    {
        using var temp = new TempDir();

        Assert.Empty(TriggeredFlipClassifier.Classify(temp.Path, Instances(2), _ => false));
        Assert.Empty(TriggeredFlipClassifier.Classify(temp.Path, null, _ => false));
    }

    [Fact]
    public void AnInstanceWithNoEffectSlotIsSkipped()
    {
        using var temp = new TempDir();
        var document = WithCollisionSlot(
            new JArray(Graph("g-collide", 0, TextureFlip(speed: 2f, length: 1f))),
            new JArray(Row("inst-a", 0)));

        // EffectSlotIndex stays at its -1 default.
        Assert.Empty(TriggeredFlipClassifier.Classify(WriteLevel(temp, document), Instances(1), _ => false));
    }
}
