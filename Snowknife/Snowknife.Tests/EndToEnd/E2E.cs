using Snowknife.Services;

namespace Snowknife.Tests.EndToEnd;

/// <summary>
/// Shared plumbing for the tests that drive the real pipeline against real disc data.
///
/// These need a clean SSX Tricky image and an extracted <c>Maps/GARI</c>, neither of which can live in the
/// repository, so they SKIP rather than fail when the data is absent — a checkout without a disc still runs
/// green, and one with a disc gets the coverage. Everything is called in-process rather than through
/// <c>snowknife.exe</c>, so an ordinary <c>dotnet test --collect:"XPlat Code Coverage"</c> counts it; the
/// autotest harness shells out to the same entry points and its coverage is invisible.
/// </summary>
internal static class E2E
{
    /// <summary>The clean image the autotest harness builds from (Trailmap/tools/autotest/run.py).</summary>
    public const string BaseIsoName = "ssx-tricky-europe.iso";

    /// <summary>The course slot every autotest fixture rides as.</summary>
    public const string Slot = "GARI";

    public static readonly string Root = FindRepoRoot();
    public static readonly string BaseIso = Path.Combine(Root, "discs", BaseIsoName);
    public static readonly string SlotMapDir = Path.Combine(Root, "Maps", Slot);

    /// <summary>The authored Slopesmith exports the harness rides. <c>Maps/&lt;name&gt;</c> IS the export
    /// directory — <c>run.py</c> defaults <c>export_dir</c> to it — so no Node build is needed here.</summary>
    public static readonly string[] Fixtures = ["GOLD", "AUTOTEST1", "AUTOTEST2", "AUTOTEST4"];

    /// <summary>The flags the harness packs with. Kept identical so a green test means the ISO it rides is
    /// the ISO this asserted on.</summary>
    public static readonly string[] PackFlags = ["--texture-type2", "--bare-slot", "--no-skycolor"];

    public static string FixtureDir(string fixture) => Path.Combine(Root, "Maps", fixture);

    /// <summary>Why the suite cannot run here, or null when it can.</summary>
    public static string? Unavailable
    {
        get
        {
            // An explicit opt-out, for a fast inner loop and for anywhere the disc data happens to be
            // present but the two minutes are not wanted.
            if (Environment.GetEnvironmentVariable("SNOWKNIFE_SKIP_E2E") == "1") return "SNOWKNIFE_SKIP_E2E=1";
            if (!File.Exists(BaseIso)) return $"needs discs/{BaseIsoName} (a disc you supply)";
            if (!File.Exists(Path.Combine(SlotMapDir, "Instances.json")))
                return $"needs an extracted Maps/{Slot} (run: snowknife import <iso> {Slot} Maps/{Slot})";
            foreach (string fixture in Fixtures)
                if (!File.Exists(Path.Combine(FixtureDir(fixture), "Patches.json")))
                    return $"needs the authored Maps/{fixture} export";
            return null;
        }
    }

    /// <summary>Walk up to the toolkit root. The marker is <c>.gitmodules</c> rather than a project file:
    /// Snowknife's own folder contains an <c>Snowknife/Snowknife.csproj</c>, so a project-shaped marker matches
    /// one level early and every path below resolves inside Snowknife instead of the repository.</summary>
    static string FindRepoRoot()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory != null)
        {
            if (File.Exists(Path.Combine(directory.FullName, ".gitmodules"))) return directory.FullName;
            directory = directory.Parent;
        }
        throw new InvalidOperationException("Could not locate the OpenSlope root from the test assembly.");
    }

    /// <summary>The composed repack service, wired exactly as the CLI's own compose root wires it.</summary>
    public static RepackService Service()
    {
        var iso = new IsoService();
        return new RepackService(iso, new BigArchiveService(), new RefpackService(),
            new SshTextureService(), new ElfPatchService(iso), new ContractValidationService());
    }

    /// <summary>The level pipeline behind <c>map</c> and <c>gltf</c>, wired the same way.</summary>
    public static LevelPipelineService LevelService()
    {
        var iso = new IsoService();
        var contracts = new ContractValidationService();
        return new LevelPipelineService(iso, new AudioService(iso), new ParticleService(iso),
            new EffectsDocumentService(contracts), contracts, new ElfPatchService(iso));
    }

    /// <summary>Run a level-pipeline command with its console output captured.</summary>
    static (int ExitCode, string Output) Capture(Func<int> run)
    {
        var captured = new StringWriter();
        TextWriter previous = Console.Out;
        try
        {
            Console.SetOut(captured);
            return (run(), captured.ToString());
        }
        finally { Console.SetOut(previous); }
    }

    /// <summary>[1/3] Import a course into <paramref name="outDir"/>.</summary>
    public static (int ExitCode, string Output) Import(string outDir) =>
        Capture(() => LevelService().Import(["import", BaseIso, Slot, outDir]));

    /// <summary>[2/3] Build the engine-neutral bundle from an extracted level folder.</summary>
    public static (int ExitCode, string Output) Gltf(string levelDir) =>
        Capture(() => LevelService().Gltf(["gltf", levelDir, Slot]));

    /// <summary>Run <c>repack</c> and hand back its exit code plus everything it wrote to stdout.
    /// The pipeline reports through the console, and under <c>--json</c> that is where the plan record
    /// itself lands, so capturing it is reading the command's documented output rather than its internals.</summary>
    public static (int ExitCode, string Output) Repack(params string[] args)
    {
        var captured = new StringWriter();
        TextWriter previous = Console.Out;
        try
        {
            Console.SetOut(captured);
            return (Service().Repack(args), captured.ToString());
        }
        finally { Console.SetOut(previous); }
    }
}

/// <summary>A fact that skips itself when the disc data is not here. The <c>Category</c> trait that lets
/// these be filtered out goes on the test CLASS — a trait on an attribute type does not reach the tests
/// that use it.</summary>
public sealed class E2EFactAttribute : FactAttribute
{
    public E2EFactAttribute()
    {
        if (E2E.Unavailable is { } why) Skip = why;
    }
}

/// <summary>The theory counterpart of <see cref="E2EFactAttribute"/>.</summary>
public sealed class E2ETheoryAttribute : TheoryAttribute
{
    public E2ETheoryAttribute()
    {
        if (E2E.Unavailable is { } why) Skip = why;
    }
}
