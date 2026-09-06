namespace Snowknife.Tests;

/// <summary>
/// A scratch directory that deletes itself. Every instance gets a fresh GUID path, which matters beyond
/// tidiness: <see cref="Snowknife.Bundle.SsfLogic"/> caches parsed <c>Effects.json</c> documents in a static
/// map keyed by full path, so two tests that wrote different fixtures to the same path would read each
/// other's cached graph.
/// </summary>
internal sealed class TempDir : IDisposable
{
    public string Path { get; }

    public TempDir()
    {
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "snowknife_tests_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(Path);
    }

    /// <summary>Absolute path of <paramref name="name"/> inside this directory, parents created.</summary>
    public string File(string name)
    {
        string full = System.IO.Path.Combine(Path, name);
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(full)!);
        return full;
    }

    /// <summary>Write <paramref name="text"/> to <paramref name="name"/> and hand back its absolute path.</summary>
    public string Write(string name, string text)
    {
        string full = File(name);
        System.IO.File.WriteAllText(full, text);
        return full;
    }

    /// <summary>Write <paramref name="bytes"/> to <paramref name="name"/> and hand back its absolute path.</summary>
    public string Write(string name, byte[] bytes)
    {
        string full = File(name);
        System.IO.File.WriteAllBytes(full, bytes);
        return full;
    }

    public void Dispose()
    {
        try { Directory.Delete(Path, recursive: true); } catch { /* a locked scratch file is not a test failure */ }
    }
}
