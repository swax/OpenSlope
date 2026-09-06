using System.Security.Cryptography;
using Snowknife.Services;

namespace Snowknife.Tests.EndToEnd;

/// <summary>
/// Builds a real ISO from the GOLD regression fixture — the same command, the same flags and the same clean
/// source the autotest harness uses — and reads the result back off the disc image.
///
/// The build is done ONCE for the whole class (it writes ~2.9 GB and takes about a minute) and the image is
/// deleted afterwards. Everything asserted here is read out of the built ISO rather than out of the
/// pipeline's own report, so it is checking the artefact, not the narration.
/// </summary>
public sealed class GoldIsoFixture : IDisposable
{
    readonly TempDir _temp = new();
    readonly Lazy<string> _built;

    public GoldIsoFixture() => _built = new Lazy<string>(Build);

    /// <summary>Path of the built image. Built on first use, so a skipped run never pays for it.</summary>
    public string Iso => _built.Value;

    string Build()
    {
        string outIso = Path.Combine(_temp.Path, "gold.iso");
        var (exitCode, _) = E2E.Repack([
            "repack", E2E.BaseIso, E2E.Slot, E2E.SlotMapDir, E2E.FixtureDir("GOLD"), outIso,
            .. E2E.PackFlags,
        ]);
        Assert.Equal(0, exitCode);
        return outIso;
    }

    public void Dispose() => _temp.Dispose();
}

[Trait("Category", "EndToEnd")]
public class RepackBuildTests : IClassFixture<GoldIsoFixture>
{
    readonly GoldIsoFixture _gold;
    static readonly IsoService Iso = new();

    public RepackBuildTests(GoldIsoFixture gold) => _gold = gold;

    static byte[] Hash(string path)
    {
        using var stream = File.OpenRead(path);
        return SHA256.HashData(stream);
    }

    /// <summary>Pull one member out of an image into a scratch file and hash it. The ISO9660 directory
    /// carries a ";1" version suffix that the extractor's own lookup does not expect, so paths taken off a
    /// DiscFileInfo are cleaned first.</summary>
    static byte[] HashMember(string iso, string internalPath, TempDir temp, string name)
    {
        string extracted = Path.Combine(temp.Path, name);
        Iso.ExtractFile(iso, Iso.CleanName(internalPath), extracted);
        return Hash(extracted);
    }

    [E2EFact]
    public void TheBuiltImageIsAPlausibleDisc()
    {
        var built = new FileInfo(_gold.Iso);
        var clean = new FileInfo(E2E.BaseIso);

        Assert.True(built.Exists, "no image was written");
        // The build replaces one course in place, so the image stays the same order of magnitude. A wildly
        // different size means a truncated write rather than a repack.
        Assert.InRange(built.Length, (long)(clean.Length * 0.9), (long)(clean.Length * 1.1));
    }

    [E2EFact]
    public void TheBuiltImageStillHasItsBootRecordAndDataTree()
    {
        using var stream = File.OpenRead(_gold.Iso);
        var cd = Iso.OpenIso(stream);

        Assert.NotNull(Iso.FindIsoFile(cd, "SYSTEM.CNF"));
        Assert.True(cd.DirectoryExists("DATA"), "the DATA tree is missing from the built image");
    }

    [E2EFact]
    public void TheBootExecutableIsUnchanged()
    {
        // run.py packs with --no-skycolor precisely because "the executable must stay byte-identical or the
        // boot savestate is resuming a different program". Nothing was checking that, and a repack that
        // started touching the ELF would surface as an unexplained autotest failure rather than as this.
        using var temp = new TempDir();
        string cleanName, builtName;
        using (var stream = File.OpenRead(E2E.BaseIso)) cleanName = Iso.ReadBootExecutableName(stream)!;
        using (var stream = File.OpenRead(_gold.Iso)) builtName = Iso.ReadBootExecutableName(stream)!;

        Assert.Equal(cleanName, builtName);
        Assert.Equal(
            HashMember(E2E.BaseIso, cleanName, temp, "clean.elf"),
            HashMember(_gold.Iso, builtName, temp, "built.elf"));
    }

    [E2EFact]
    public void TheTargetSlotsLevelDataWasActuallyReplaced()
    {
        // The counterpart to the executable check: something HAS to have changed, or the repack silently
        // shipped the retail course under a custom name.
        using var temp = new TempDir();
        string member;
        using (var stream = File.OpenRead(E2E.BaseIso))
            member = Iso.FindLevelBig(Iso.OpenIso(stream), E2E.Slot)!.FullName;

        byte[] clean = HashMember(E2E.BaseIso, member, temp, "clean.big");
        byte[] built = HashMember(_gold.Iso, member, temp, "built.big");

        Assert.NotEqual(clean, built);
    }

    [E2EFact]
    public void AnotherCoursesLevelDataIsLeftAlone()
    {
        // repack replaces ONE slot. A neighbouring course changing means the write ran long or the
        // directory extents were rebuilt wrongly - the kind of fault that boots fine until you pick MESA.
        using var temp = new TempDir();
        string member;
        using (var stream = File.OpenRead(E2E.BaseIso))
            member = Iso.FindLevelBig(Iso.OpenIso(stream), "MESA")!.FullName;

        Assert.Equal(
            HashMember(E2E.BaseIso, member, temp, "clean-mesa.big"),
            HashMember(_gold.Iso, member, temp, "built-mesa.big"));
    }
}
