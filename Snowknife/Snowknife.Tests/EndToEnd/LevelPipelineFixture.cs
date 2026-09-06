namespace Snowknife.Tests.EndToEnd;

/// <summary>
/// One real <c>map</c> extract, and the <c>gltf</c> bundle built from it, shared by every test that reads
/// either. The extract is the expensive step (a couple of minutes and ~140 MB), so it happens once per run
/// and lazily — a skipped run never pays for it.
///
/// Note that <c>map</c> deliberately leaves its temp work dir under <c>%TEMP%/snowknife_*</c> for inspection.
/// That is the command's documented behaviour rather than a leak, but it does mean repeated runs accumulate
/// work dirs that nothing here cleans up.
/// </summary>
public sealed class LevelPipelineFixture : IDisposable
{
    readonly TempDir _temp = new();
    readonly Lazy<string> _extract;
    readonly Lazy<string> _bundle;

    public LevelPipelineFixture()
    {
        _extract = new Lazy<string>(Extract);
        _bundle = new Lazy<string>(Bundle);
    }

    /// <summary>The extracted level directory (the `Maps/&lt;LEVEL&gt;` intermediate).</summary>
    public string LevelDir => _extract.Value;

    /// <summary>The bundle directory built from it (`&lt;levelDir&gt;/gltf`).</summary>
    public string BundleDir => _bundle.Value;

    string Extract()
    {
        string outDir = Path.Combine(_temp.Path, E2E.Slot);
        var (exitCode, output) = E2E.Import(outDir);
        Assert.True(exitCode == 0, $"map failed with {exitCode}:\n{Tail(output)}");
        return outDir;
    }

    string Bundle()
    {
        var (exitCode, output) = E2E.Gltf(LevelDir);
        Assert.True(exitCode == 0, $"gltf failed with {exitCode}:\n{Tail(output)}");
        return Path.Combine(LevelDir, "gltf");
    }

    /// <summary>The last few lines of a command's output — enough to say why it failed without pasting a
    /// full extract log into the test result.</summary>
    static string Tail(string output) =>
        string.Join(Environment.NewLine, output.Split('\n').TakeLast(15));

    public void Dispose() => _temp.Dispose();
}

/// <summary>Binds the fixture to both pipeline test classes so the extract is shared across them.</summary>
[CollectionDefinition(Name)]
public sealed class LevelPipelineCollection : ICollectionFixture<LevelPipelineFixture>
{
    public const string Name = "Snowknife level pipeline";
}
