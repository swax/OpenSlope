namespace Snowknife.Repack;

/// <summary>
/// Small, dependency-free presentation layer for the repack commands. Repack has enough moving parts that a
/// flat stream of indented messages is difficult to scan; these helpers supply the hierarchy while leaving
/// the messages themselves (and, importantly, JSON stdout) alone. Every line is written through
/// <see cref="Log"/>; the only Console this class touches directly is colour, and the two output filters
/// below, which have to sit on Console itself (see them for why).
/// </summary>
internal static class RepackConsole
{
    // Colour is a terminal property: no point painting it when either Console or Log is pointed at a buffer.
    private static bool UseColor => !Console.IsOutputRedirected && !Log.IsRedirected
        && Environment.GetEnvironmentVariable("NO_COLOR") == null
        && !string.Equals(Environment.GetEnvironmentVariable("TERM"), "dumb", StringComparison.OrdinalIgnoreCase);

    public static void Header(string command, string subject, string input, string output)
    {
        Log.Info();
        Accent("╭─ ");
        Strong(command.ToUpperInvariant());
        Log.Info();
        Log.Write("│  ");
        Strong(subject);
        Log.Info();
        Log.Info($"│  {Path.GetFileName(input)}  →  {Path.GetFileName(output)}");
        Accent("╰─");
        Log.Info();
    }

    public static void Section(string title)
    {
        Log.Info();
        Accent("── ");
        Strong(title);
        Log.Info();
    }

    public static void Detail(string message) => Log.Info($"  {message}");

    public static void Warning(string message)
    {
        Log.Write("  ");
        Color("! ", ConsoleColor.Yellow);
        Log.Info(message);
    }

    /// <summary>A non-fatal condition that makes the produced PS2 data unsafe. Unlike a warning, the whole
    /// labelled line is red; callers still continue when another output target (notably Unity) remains valid.</summary>
    public static void Alert(string message)
    {
        Log.Write("  ");
        Color($"ALERT: {message}", ConsoleColor.Red);
        Log.Info();
    }

    public static void Success(string subject, string output, TimeSpan elapsed)
    {
        Log.Info();
        Color("✓ ", ConsoleColor.Green);
        Strong(subject);
        Color($"  ({Duration(elapsed)})", ConsoleColor.DarkGray);
        Log.Info();
        Log.Info($"  {Path.GetFullPath(output)}");
    }

    /// <summary>
    /// Services shared with non-repack commands still write their own standalone status lines. Inside a
    /// repack, trim their temporary paths and fold them into the current phase instead of letting them break
    /// the visual hierarchy. Warning text from the older helpers is normalized here too.
    ///
    /// Both filters install with <see cref="Console.SetOut"/> rather than <see cref="Log.Redirect"/> on
    /// purpose: the SSX-Library level builder writes its trace straight to Console, and that trace is most of
    /// what <see cref="SuppressPackingTrace"/> exists to hide. <see cref="Log"/> resolves Console.Out on every
    /// call, so Snowknife's own lines pass through the same filter without a second hook.
    /// </summary>
    public static IDisposable NormalizeSharedServiceOutput()
    {
        var previous = Console.Out;
        var writer = new RepackWriter(previous);
        Console.SetOut(writer);
        return new RestoreWriter(previous);
    }

    /// <summary>
    /// The legacy level builder logs every patch, instance, model and material as it packs it. That is useful
    /// when running the builder's standalone diagnostics, but a normal repack already reports the aggregate
    /// result immediately after the call. Keep only warnings in the repack view.
    /// </summary>
    public static IDisposable SuppressPackingTrace()
    {
        var previous = Console.Out;
        var writer = new WarningOnlyWriter(previous);
        Console.SetOut(writer);
        return new RestoreWriter(previous);
    }

    private static string Duration(TimeSpan elapsed) => elapsed.TotalMinutes >= 1
        ? $"{(int)elapsed.TotalMinutes}m {elapsed.Seconds}s"
        : $"{Math.Max(0.1, elapsed.TotalSeconds):0.0}s";

    private static void Accent(string text) => Color(text, ConsoleColor.DarkCyan);

    private static void Strong(string text) => Color(text, ConsoleColor.Cyan);

    private static void Color(string text, ConsoleColor color)
    {
        if (!UseColor)
        {
            Log.Write(text);
            return;
        }

        ConsoleColor previous = Console.ForegroundColor;
        try
        {
            Console.ForegroundColor = color;
            Log.Write(text);
        }
        finally { Console.ForegroundColor = previous; }
    }

    private sealed class RepackWriter(TextWriter inner) : TextWriter
    {
        public override System.Text.Encoding Encoding => inner.Encoding;

        public override void Write(char value) => inner.Write(value);

        public override void Write(string? value) => inner.Write(value);

        public override void WriteLine() => inner.WriteLine();

        public override void WriteLine(string? value)
        {
            if (value == null)
            {
                inner.WriteLine();
                return;
            }

            string warning = value.StartsWith("  WARN: ", StringComparison.Ordinal)
                ? value[8..]
                : value.StartsWith("WARN: ", StringComparison.Ordinal) ? value[6..] : "";
            if (warning.Length > 0)
            {
                inner.Write("  ");
                WriteColor(inner, "! ", ConsoleColor.Yellow);
                inner.WriteLine(warning);
                return;
            }

            const string extracted = "Extracted ";
            int arrow = value.LastIndexOf(" -> ", StringComparison.Ordinal);
            if (value.StartsWith(extracted, StringComparison.Ordinal) && arrow > extracted.Length)
            {
                string size = value[extracted.Length..arrow];
                string file = Path.GetFileName(value[(arrow + 4)..]);
                inner.WriteLine($"  Extracted {file} ({size})");
                return;
            }

            if (value.StartsWith("In-place: ", StringComparison.Ordinal)
                || value.StartsWith("Relocated: ", StringComparison.Ordinal)
                || value.StartsWith("noclip: ", StringComparison.Ordinal)
                || value.StartsWith("skycolor: ", StringComparison.Ordinal))
            {
                inner.WriteLine("  " + value);
                return;
            }

            inner.WriteLine(value);
        }
    }

    /// <summary>Puts back whatever <see cref="Console.Out"/> was when the filter went in.
    ///
    /// The restore is unconditional on purpose. A reference-equality guard — restore only while
    /// <c>Console.Out</c> is still the writer this installed — reads like protection against an out-of-order
    /// dispose and is in fact a guard that never opens: <see cref="Console.SetOut"/> wraps what it is handed
    /// in a synchronizing writer, so the property never returns the instance that was passed in. The
    /// warning-only filter would then stay installed for the rest of the run and every ordinary line a repack
    /// prints after the level build would go nowhere. Both filters are used as strictly nested `using` scopes,
    /// so unconditional restore is the correct behaviour; the flag only guards against a double dispose.</summary>
    private sealed class RestoreWriter(TextWriter previous) : IDisposable
    {
        private bool restored;

        public void Dispose()
        {
            if (restored) return;
            restored = true;
            Console.SetOut(previous);
        }
    }

    private sealed class WarningOnlyWriter(TextWriter inner) : TextWriter
    {
        public override System.Text.Encoding Encoding => inner.Encoding;

        public override void WriteLine(string? value)
        {
            string line = value?.TrimStart() ?? "";
            if (line.StartsWith("WARN", StringComparison.OrdinalIgnoreCase)
                || line.StartsWith('!'))
                inner.WriteLine(value);
        }
    }

    private static void WriteColor(TextWriter writer, string text, ConsoleColor color)
    {
        if (!UseColor)
        {
            writer.Write(text);
            return;
        }

        ConsoleColor previous = Console.ForegroundColor;
        try
        {
            Console.ForegroundColor = color;
            writer.Write(text);
        }
        finally { Console.ForegroundColor = previous; }
    }
}
