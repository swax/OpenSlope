using Newtonsoft.Json.Linq;
using Snowknife.Formats;
using Snowknife.Repack;
using Snowknife.Services;

namespace Snowknife.Tests.Repack;

/// <summary>
/// Where a custom clip's bytes land in the target course bank.
///
/// Two hard rules meet here and neither is visible from the export. A rebuilt bank past the size its level
/// shipped with plays NOTHING — no error, no partial sound, the ISO simply comes back mute — so an empty
/// destination slot, which charges the clip full price, is the expensive choice the export cannot help
/// making. And an ordinary event id that retail only ever uses for a collision hit cannot be handed a
/// CONTINUING emitter: event 63 on GARI freezes the level clock at frame 0, while the same clip as a
/// one-shot on the same slot rides.
///
/// So these assert the two refusals as much as the choice. A test that only checked "the biggest slot wins"
/// would have passed on the build that hung.
/// </summary>
public class CustomSoundRoutingTests
{
    /// <summary>A bank whose slot <c>i</c> holds <c>bytes[i]</c> bytes of sample data, or nothing for 0.
    /// The runs are distinct by construction so nothing reads as shared unless a test says so.</summary>
    static BnkFile Bank(params (int Slot, int Bytes)[] slots)
    {
        var bank = new BnkFile();
        int fill = 1;
        foreach (var (slot, bytes) in slots)
        {
            while (bank.Slots.Count <= slot) bank.Slots.Add(null);
            var frames = new byte[bytes];
            Array.Fill(frames, (byte)fill++);
            bank.Slots[slot] = BnkFile.BuildPsAdpcm(frames, bytes / 16 * 28, 16000);
        }
        return bank;
    }

    static SoundIndexDocument Index(params (int Event, int Slot)[] routes) => Index(null, routes);

    /// <summary>An index whose group-2 bank is named, for the rules keyed by which bank is being packed.</summary>
    static SoundIndexDocument Index(string? courseBank, params (int Event, int Slot)[] routes)
    {
        var document = new SoundIndexDocument();
        if (courseBank != null) document.Banks[2] = courseBank;
        foreach (var (eventId, slot) in routes)
            document.CollisionEvents[eventId] = new SoundIndexEvent { Group = 2, Slot = slot };
        return document;
    }

    static (int, string, int) Clip(int eventId, int cost) => (eventId, $"clip{eventId}.wav", cost);

    [Fact]
    public void HitSoundTakesTheRichestFreeSlot()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 2_000) },
            Bank((10, 0), (64, 50_000), (83, 20_000)),
            Index((179, 10), (63, 64), (26, 83)),
            reservedSlots: Array.Empty<int>(), emitterEvents: Array.Empty<int>());

        var choice = Assert.Single(choices);
        Assert.Equal(63, choice.ToEvent);
        Assert.Equal(64, choice.ToSlot);
        Assert.Equal(50_000, choice.Reclaimed);
        Assert.Equal(2_000 - 50_000, choice.Delta);
    }

    [Fact]
    public void BiggestClipTakesTheBiggestSlot()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 2_000), Clip(180, 9_000) },
            Bank((10, 0), (11, 0), (64, 50_000), (83, 20_000)),
            Index((179, 10), (180, 11), (63, 64), (26, 83)),
            reservedSlots: Array.Empty<int>(), emitterEvents: Array.Empty<int>());

        Assert.Equal(64, choices.Single(c => c.FromEvent == 180).ToSlot);
        Assert.Equal(83, choices.Single(c => c.FromEvent == 179).ToSlot);
    }

    /// <summary>
    /// An emitter must reach a slot the bank SHIPS, whatever id gets it there.
    ///
    /// Restricting the emitter pool to the six ids retail sustains silences the course instead: on GARI all
    /// six resolve to slots garibaldi1 leaves empty, so an emitter could never be given a shipped one, and a
    /// clip in an unshipped slot is injected, decoded, dispatched, given a voice — and inaudible
    /// [Trailmap: 260-shipped-slot]. A hand-fitted disc has to put its beds on events 16 and 26 for exactly
    /// this reason.
    /// </summary>
    [Fact]
    public void AnEmitterTakesTheRichestSHIPPEDSlot_OrdinaryIdOrNot()
    {
        // 26 is an ordinary collision id: retail never sustains it, and an emitter loop is measured riding
        // on the slot behind it.
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 9_000) },
            Bank((10, 0), (38, 12_000), (83, 20_000)),
            Index((179, 10), (68, 38), (26, 83)),
            reservedSlots: Array.Empty<int>(), emitterEvents: new[] { 179 });

        var choice = Assert.Single(choices);
        Assert.Equal(83, choice.ToSlot);
        Assert.Equal(26, choice.ToEvent);
    }

    /// <summary>The one slot rule an emitter still obeys, and the only one measured to matter: slot 64 is
    /// stereo, and a mono LOOP written there and sustained freezes the level clock.</summary>
    [Fact]
    public void AnEmitterStillNeverTakesTheMultiChannelSlot()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 9_000) },
            BankWithStereo64(), Index((179, 10), (63, 64), (26, 83)),
            reservedSlots: Array.Empty<int>(), emitterEvents: new[] { 179 });

        // 64 is the fattest slot in this bank; the emitter takes the next one down instead.
        Assert.Equal(83, Assert.Single(choices).ToSlot);
    }

    /// <summary>An emitter bids before a hit sound, so the one slot it was allowed cannot be spent on a clip
    /// that had the whole bank to choose from.</summary>
    [Fact]
    public void EmitterBidsBeforeHitSoundsForASharedCandidate()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 2_000), Clip(180, 9_000) },
            Bank((10, 0), (11, 0), (38, 12_000)),
            Index((179, 10), (180, 11), (68, 38)),
            reservedSlots: Array.Empty<int>(), emitterEvents: new[] { 179 });

        var choice = Assert.Single(choices);
        Assert.Equal(179, choice.FromEvent);
        Assert.Equal(38, choice.ToSlot);
    }

    /// <summary>
    /// A build the budget is going to refuse must not be re-pointed at all.
    ///
    /// The rewrite happens here and the ADL is regenerated from it; the bank is weighed much later. So a
    /// refused build ships the RETAIL bank with the authored props still aimed at the events routing moved
    /// them onto — and they then play whatever retail put in those slots. Measured on a real refused build:
    /// an authored foghorn sounded garibaldi1's glass smash, because slot 64 is where routing had sent it and
    /// the smash is what slot 64 ships. Silence would have been wrong; someone else's sound is worse.
    /// </summary>
    [Fact]
    public void ClipsTooBigForTheBankAreLeftOnTheirOwnIdsRatherThanPointedAtRetailSounds()
    {
        // 60,000 bytes of clip against 30,000 bytes of reclaim: the best case is still 30,000 over.
        var customs = new[] { Clip(179, 60_000) };
        var bank = Bank((10, 0), (83, 30_000));
        var index = Index((179, 10), (26, 83));

        var choices = CustomSoundRouting.Choose(customs, bank, index,
            reservedSlots: Array.Empty<int>(), emitterEvents: Array.Empty<int>());

        // Routing still finds the best slot — it is `Apply` that declines to COMMIT it...
        Assert.Equal(83, Assert.Single(choices).ToSlot);
        // ...on this, which is what it decides from.
        Assert.Equal(30_000, CustomSoundRouting.ProjectedDelta(customs, bank, index, choices));
    }

    [Fact]
    public void AProjectionThatFitsIsReportedAsFitting()
    {
        var customs = new[] { Clip(179, 2_000) };
        var bank = Bank((10, 0), (83, 30_000));
        var index = Index((179, 10), (26, 83));
        var choices = CustomSoundRouting.Choose(customs, bank, index,
            reservedSlots: Array.Empty<int>(), emitterEvents: Array.Empty<int>());

        Assert.Equal(2_000 - 30_000, CustomSoundRouting.ProjectedDelta(customs, bank, index, choices));
    }

    /// <summary>An unrouted clip still costs, and its own slot still counts — the projection is over EVERY
    /// clip, not only the ones that moved. Reading only the moved ones would call a doomed build fine.</summary>
    [Fact]
    public void TheProjectionCountsClipsThatWereNeverMoved()
    {
        var customs = new[] { Clip(179, 40_000), Clip(180, 40_000) };
        var bank = Bank((10, 0), (11, 0), (83, 30_000));
        var index = Index((179, 10), (180, 11), (26, 83));
        var choices = CustomSoundRouting.Choose(customs, bank, index,
            reservedSlots: Array.Empty<int>(), emitterEvents: Array.Empty<int>());

        // One clip took slot 83; the other stayed on its empty slot and reclaims nothing.
        Assert.Single(choices);
        Assert.Equal(80_000 - 30_000, CustomSoundRouting.ProjectedDelta(customs, bank, index, choices));
    }

    /// <summary>
    /// garibaldi1 slot 083 holds a loop correctly and halves the console's speed while it does — 88-95 s to
    /// the gate against 51 s for the same bed in any other slot, and 51 s for retail. Routing would pick it
    /// every time without this: it is the fattest mono slot in the bank, so the biggest bed lands there by
    /// default and every GARI course with ambience pays it.
    /// </summary>
    [Fact]
    public void AnEmitterIsNotGivenASlotMeasuredToHalfTheConsolesSpeed()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 9_000) },
            Bank((10, 0), (52, 18_720), (83, 22_304)),
            Index("garibaldi1", (179, 10), (22, 52), (26, 83)),
            reservedSlots: Array.Empty<int>(), emitterEvents: new[] { 179 });

        // 083 is the fattest and would win on bytes alone.
        Assert.Equal(52, Assert.Single(choices).ToSlot);
    }

    /// <summary>Only sustaining voices were measured slow there, and a hit sound is the biggest reclaim the
    /// slot has to offer — so the refusal is not widened past what was ridden.</summary>
    [Fact]
    public void AHitSoundStillTakesThatSlot()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 9_000) },
            Bank((10, 0), (52, 18_720), (83, 22_304)),
            Index("garibaldi1", (179, 10), (22, 52), (26, 83)),
            reservedSlots: Array.Empty<int>(), emitterEvents: Array.Empty<int>());

        Assert.Equal(83, Assert.Single(choices).ToSlot);
    }

    /// <summary>And it is keyed to the bank it was measured on: the same slot number elsewhere is untested,
    /// not condemned.</summary>
    [Fact]
    public void AnotherBanksSlot83IsNotRefused()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 9_000) },
            Bank((10, 0), (52, 18_720), (83, 22_304)),
            Index("mesabanca1", (179, 10), (22, 52), (26, 83)),
            reservedSlots: Array.Empty<int>(), emitterEvents: new[] { 179 });

        Assert.Equal(83, Assert.Single(choices).ToSlot);
    }

    [Fact]
    public void ReservedSlotsAreNotCandidates()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 2_000) },
            Bank((10, 0), (64, 50_000), (83, 20_000)),
            Index((179, 10), (63, 64), (26, 83)),
            reservedSlots: new[] { 64 }, emitterEvents: Array.Empty<int>());

        Assert.Equal(83, Assert.Single(choices).ToSlot);
    }

    /// <summary>A stereo bank slot: every course bank on the disc ships exactly one, slot 64, holding the same
    /// 2.17 s glass smash.</summary>
    static BnkFile BankWithStereo64()
    {
        var bank = Bank((10, 0), (11, 0), (38, 12_000), (64, 27_344), (83, 20_000));
        bank.Slots[64]!.ChannelData.Add(new byte[27_344]);   // the second channel
        return bank;
    }

    /// <summary>A mono loop written into slot 64 and placed as an emitter freezes level load, so the slot is
    /// refused to emitters from the slot side as well as from the id side.</summary>
    [Fact]
    public void AMultiChannelSlotIsNeverOfferedToAnEmitter()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 9_000) },
            BankWithStereo64(),
            // 63 IS in the emitter-eligible set here, which retail's census says it is not — so this proves
            // the slot rule holds on its own rather than riding on RetailEmitterEvents.
            Index((179, 10), (16, 64), (68, 38)),
            reservedSlots: Array.Empty<int>(), emitterEvents: new[] { 179 });

        Assert.Equal(38, Assert.Single(choices).ToSlot);
    }

    /// <summary>A mono ONE-SHOT in slot 64 rides, and at 54,688 bytes on a real bank it is the biggest reclaim
    /// on offer. Refusing it to hit sounds too would throw away the whole point of routing.</summary>
    [Fact]
    public void AMultiChannelSlotIsOfferedToAHitSound()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 2_000) },
            BankWithStereo64(), Index((179, 10), (63, 64), (26, 83)),
            reservedSlots: Array.Empty<int>(), emitterEvents: Array.Empty<int>());

        var choice = Assert.Single(choices);
        Assert.Equal(64, choice.ToSlot);
        Assert.Equal(2 * 27_344, choice.Reclaimed);   // BOTH channel runs come back
    }

    /// <summary>The level still ships an LCD screen, so event 63 pins slot 64 and the smash survives. This is
    /// the rule that keeps the reclaim from ever being taken out of a level that can hear it.</summary>
    [Fact]
    public void ASlotAPropStillReachesIsNotSoldEvenThoughItIsTheFattest()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 2_000) },
            BankWithStereo64(), Index((179, 10), (63, 64), (26, 83)),
            reservedSlots: new[] { 64 }, emitterEvents: Array.Empty<int>());

        Assert.Equal(83, Assert.Single(choices).ToSlot);
    }

    /// <summary>Shipped banks point two headers at one sample run (garibaldi1 50 and 51). Overwriting one of
    /// a pair hands back nothing, so such a slot has to score zero — an estimate that over-promises here
    /// spends budget that does not exist.</summary>
    [Fact]
    public void ASlotSharingItsRunWithAnotherReclaimsNothing()
    {
        var bank = Bank((10, 0), (50, 17_856), (51, 0), (83, 20_000));
        bank.Slots[51] = BnkFile.BuildPsAdpcm(bank.Slots[50]!.ChannelData[0], 17_856 / 16 * 28, 16000);

        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 2_000) },
            bank, Index((179, 10), (7, 50), (12, 51), (26, 83)),
            reservedSlots: Array.Empty<int>(), emitterEvents: Array.Empty<int>());

        Assert.Equal(83, Assert.Single(choices).ToSlot);
    }

    /// <summary>
    /// Two clips must never end up on one id. The reserved pool usually lands on slots the bank leaves empty,
    /// which score nothing and are never offered — but Megaplex SHIPS sounds on 148-151, and there the slot
    /// behind a reserved id looks like an ordinary reclaim. Handing clip A the id clip B is still sitting on
    /// resolves both to one slot, and the injection keeps whichever it writes last: A's props play B's sound,
    /// with nothing logged anywhere.
    /// </summary>
    [Fact]
    public void AnIdAnotherCUSTOMClipIsStillUsingIsNeverOffered()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 2_000), Clip(149, 1_000) },
            // 149 is a reserved pool id that this level's bank ships a sound on — the Megaplex case. It is
            // the fattest thing in the bank, so nothing but the rule keeps 179 off it.
            Bank((10, 0), (40, 50_000), (83, 20_000)),
            Index((179, 10), (149, 40), (26, 83)),
            reservedSlots: Array.Empty<int>(), emitterEvents: Array.Empty<int>());

        var choice = Assert.Single(choices);
        Assert.Equal(179, choice.FromEvent);
        Assert.Equal(83, choice.ToSlot);
        Assert.DoesNotContain(choices, c => c.ToEvent == 149 || c.ToSlot == 40);
    }

    /// <summary>The same rule read through the SLOT rather than the id: excluding 149 by name is not enough
    /// when a second id reaches the same slot, because candidates are grouped by slot and named by the lowest
    /// id in the group.</summary>
    [Fact]
    public void NorIsTheSlOTBehindIt_ReachedBySomeOtherId()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(179, 2_000), Clip(149, 1_000) },
            Bank((10, 0), (40, 50_000), (83, 20_000)),
            // 7 and 149 both resolve to slot 40, so the candidate for that slot is named "7" and the
            // id-based exclusion never sees it.
            Index((179, 10), (149, 40), (7, 40), (26, 83)),
            reservedSlots: Array.Empty<int>(), emitterEvents: Array.Empty<int>());

        Assert.Equal(83, Assert.Single(choices).ToSlot);
    }

    [Fact]
    public void AClipAlreadyOnAFatterSlotIsLeftAlone()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(26, 2_000) },
            Bank((83, 50_000), (112, 8_000)),
            Index((26, 83), (67, 112)),
            reservedSlots: Array.Empty<int>(), emitterEvents: Array.Empty<int>());

        Assert.Empty(choices);
    }

    [Fact]
    public void HitGatedClipsAreNeverMoved()
    {
        var choices = CustomSoundRouting.Choose(
            new[] { Clip(16, 9_000), Clip(28, 9_000), Clip(57, 9_000) },
            Bank((64, 50_000)), Index((16, 35), (28, 24), (57, 36), (63, 64)),
            reservedSlots: Array.Empty<int>(), emitterEvents: new[] { 16, 28, 57 });

        Assert.Empty(choices);
    }

    [Fact]
    public void ReservedSlotsReadsInstancesAndPlaySoundNodes()
    {
        using var dir = new TempDir();
        dir.Write("work/Instances.json", new JObject
        {
            ["Instances"] = new JArray(
                // A donor prop that survived: its event pins its slot even though the custom clips share it.
                new JObject { ["Sounds"] = new JObject { ["CollisonSound"] = 45 } },
                // A donor prop --bare-slot hid: no sound of its own to protect.
                new JObject { ["IncludeSound"] = false, ["Sounds"] = new JObject { ["CollisonSound"] = 63 } },
                // An authored prop on a RETAIL event, which does pin its slot...
                new JObject { ["Sounds"] = new JObject { ["ExternalSounds"] = new JArray(
                    new JObject { ["SoundIndex"] = 26 }) } },
                // ...and one on its own custom event, which is the thing being moved.
                new JObject { ["Sounds"] = new JObject { ["CollisonSound"] = 179 } }),
        }.ToString());
        dir.Write("work/SSFLogic.json", new JObject
        {
            ["Functions"] = new JArray(new JObject
            {
                ["Effects"] = new JArray(new JObject { ["MainType"] = 8, ["SoundPlay"] = 82 }),
            }),
        }.ToString());

        var reserved = CustomSoundRouting.ReservedSlots(
            Path.Combine(dir.Path, "work"), donorInstances: 2,
            customEvents: new HashSet<int> { 179 },
            Index((45, 20), (63, 64), (26, 83), (179, 10)));

        Assert.Contains(20, reserved);   // the surviving donor prop
        Assert.Contains(83, reserved);   // the authored prop's retail emitter
        Assert.Contains(82, reserved);   // the PlaySound node, which no event table can see
        Assert.DoesNotContain(64, reserved);  // hidden, so its sound is gone with it
        Assert.DoesNotContain(10, reserved);  // the custom clip's own slot, which is what moves
    }

    [Fact]
    public void OnlyAuthoredRowsAreRewritten()
    {
        using var dir = new TempDir();
        string path = dir.Write("Instances.json", new JObject
        {
            ["Instances"] = new JArray(
                new JObject { ["Sounds"] = new JObject { ["CollisonSound"] = 179 } },
                new JObject { ["Sounds"] = new JObject { ["CollisonSound"] = 179 } },
                new JObject { ["Sounds"] = new JObject { ["ExternalSounds"] = new JArray(
                    new JObject { ["SoundIndex"] = 179 }) } }),
        }.ToString());

        int rewritten = CustomSoundRouting.RewriteInstances(path, new Dictionary<int, int> { [179] = 63 },
                                                            fromIndex: 1);

        Assert.Equal(2, rewritten);
        var rows = (JArray)JObject.Parse(File.ReadAllText(path))["Instances"]!;
        // The donor row keeps its own sound: a retail prop that happens to carry a reserved id is a reason
        // to move the AUTHORED clip off it, not a row to rewrite.
        Assert.Equal(179, (int)rows[0]["Sounds"]!["CollisonSound"]!);
        Assert.Equal(63, (int)rows[1]["Sounds"]!["CollisonSound"]!);
        Assert.Equal(63, (int)rows[2]["Sounds"]!["ExternalSounds"]![0]!["SoundIndex"]!);
    }
}
