namespace Snowknife;

/// <summary>
/// The one sink for everything the pipeline says about its progress. Services, exporters and bundlers used to
/// write straight to <see cref="Console"/>, which left no single place to quiet them or to capture their output
/// in a test. The CLI's own surface (<c>Cli/</c>, <c>Program.cs</c>) keeps talking to Console directly: usage
/// and help text ARE the terminal surface, not progress.
///
/// Three channels. <see cref="Info(string)"/> is ordinary progress; <see cref="Warn"/> is a line a future
/// <c>--quiet</c> should keep; <see cref="Error"/> is what a command exits non-zero over. Info and Warn both
/// land on stdout and Error on stderr, so the default output is byte-identical to the Console calls it replaced.
///
/// The default writers are looked up on every call, never cached: <see cref="Console.SetOut"/> is how xunit
/// captures output, how <c>--json</c> commands push their own progress to stderr, and how the repack view
/// filters the SSX-Library submodule's chatter. None of those swaps are visible from here, and a writer captured
/// at type-init would keep pointing at the stream from before the swap.
/// </summary>
internal static class Log
{
    // Null means "whatever Console has right now". A Redirect scope sets these and its dispose puts the previous
    // pair back, so scopes nest.
    private static TextWriter? outSink;
    private static TextWriter? errSink;

    /// <summary>Where Info and Warn currently go, for callers that stream a whole document to the sink.</summary>
    public static TextWriter Out => outSink ?? Console.Out;

    private static TextWriter Err => errSink ?? Console.Error;

    /// <summary>True inside a <see cref="Redirect"/> scope, when output is not reaching the terminal.</summary>
    public static bool IsRedirected => outSink != null;

    public static void Info(string message) => Out.WriteLine(message);

    public static void Info() => Out.WriteLine();

    public static void Warn(string message) => Out.WriteLine(message);

    public static void Error(string message) => Err.WriteLine(message);

    /// <summary>A fragment without its newline; the repack view assembles coloured lines piecewise.</summary>
    public static void Write(string text) => Out.Write(text);

    /// <summary>
    /// Send output to <paramref name="output"/> and errors to <paramref name="error"/> until the returned scope
    /// is disposed. Either may be null to leave that stream where it was. The restore is unconditional: scopes
    /// are used strictly nested, and a second dispose is a no-op rather than a second unwind.
    /// </summary>
    public static IDisposable Redirect(TextWriter? output = null, TextWriter? error = null)
    {
        var scope = new Scope(outSink, errSink);
        if (output != null) outSink = output;
        if (error != null) errSink = error;
        return scope;
    }

    private sealed class Scope(TextWriter? previousOut, TextWriter? previousErr) : IDisposable
    {
        private bool restored;

        public void Dispose()
        {
            if (restored) return;
            restored = true;
            outSink = previousOut;
            errSink = previousErr;
        }
    }
}
