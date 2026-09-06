using Snowknife.Formats;
using Snowknife.Repack;

namespace Snowknife.Tests.Repack;

/// <summary>
/// What rate a custom clip is encoded at when nothing on the command line asks for one.
///
/// It is NOT "the rate it was authored at". The engine does not honour a course-bank sound's own 0x84 tag —
/// it plays the slot at the rate the bank is played at, measured as a 440 Hz tone authored at 22,050 coming
/// back a fourth flat beside the same tone authored at 16,000 — so a clip that arrives at any other rate is
/// simply at the wrong pitch. The injection therefore converts EVERY clip, up or down, and `--sound-rate`
/// overrides the target rather than capping it.
///
/// That is worth a test of its own because the flag reads like a ceiling, and a ceiling is a thing a reader
/// can act on wrongly in both directions: leaving a 48 kHz clip alone "because it is under the limit", or
/// setting 22050 on a 16 kHz bank to "stay within retail" and detuning the whole course.
/// </summary>
public class CourseBankInjectRateTests
{
    /// <summary>A bank whose slots carry the given rates, one short sound each.</summary>
    static BnkFile Bank(params int[] rates)
    {
        var bank = new BnkFile();
        foreach (int rate in rates)
            bank.Slots.Add(BnkFile.BuildPsAdpcm(new byte[16 * 4], 4 * 28, rate));
        return bank;
    }

    [Fact]
    public void TheBanksRateIsItsMODE_NotItsMeanOrItsHighest()
    {
        // garibaldi1's own shape: 16,000 in the ordinary prop one-shots and 22,050 in the two that are not.
        // A mean would land between the two and match nothing; the highest would detune all twenty-one.
        Assert.Equal(16_000, CourseBankInject.ModalRate(
            Bank(16_000, 16_000, 16_000, 16_000, 16_000, 22_050, 22_050)));
    }

    [Fact]
    public void ABankWithNoSoundsAtAllFallsBackToRetailsRate()
    {
        Assert.Equal(CourseBankInject.RetailSoundRate, CourseBankInject.ModalRate(new BnkFile()));
    }

    [Fact]
    public void EmptySlotsDoNotVoteOnTheRate()
    {
        var bank = Bank(22_050, 22_050);
        bank.Slots.Insert(0, null);
        bank.Slots.Insert(0, null);
        bank.Slots.Add(null);

        Assert.Equal(22_050, CourseBankInject.ModalRate(bank));
    }
}
