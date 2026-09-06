using System.Text;

namespace Snowknife.Cli;

/// <summary>
/// The two things <c>snowknife</c> says about itself.
///
/// The index is a signpost - every command, one line each, grouped by what you came to do - and a page is
/// the manual for the one command you asked about. Splitting them is what keeps the first screen readable:
/// the detail is a keystroke away (<c>snowknife help &lt;command&gt;</c>) rather than in front of everyone
/// who ever types the bare command.
/// </summary>
internal static class Help
{
    /// <summary>Widest an argument name may be before its description moves to the next line.</summary>
    private const int NameColumn = 24;

    /// <summary>Every command, grouped, one line each. What bare `snowknife` prints.</summary>
    public static void Index(IReadOnlyList<CliGroup> groups)
    {
        Console.WriteLine("""
            snowknife - read, author and repack SSX Tricky game data

            Usage:
              snowknife <command> [args]
              snowknife help <command>   what one command does, in full
              snowknife <command>        the same page, when you leave the arguments off
            """);

        int column = groups.SelectMany(g => g.Commands).Max(c => c.Name.Length) + 2;
        foreach (var group in groups)
        {
            Console.WriteLine();
            Console.WriteLine(group.Title);
            foreach (var command in group.Commands)
                Console.WriteLine("  " + command.Name.PadRight(column) + command.Summary);
        }

        Console.WriteLine();
        Console.WriteLine("""
            A course, start to finish (`shared` runs once per project, not once per course):
              snowknife import discs\ssx-tricky.iso <courseSlot> Maps\<NAME>
              snowknife gltf   Maps\<NAME>
              snowknife shared discs\ssx-tricky.iso Maps\Shared
              snowknife unity  Maps\<NAME> C:\MyWorld\Assets\OpenSlope\Maps\<NAME>
            """);
    }

    /// <summary>
    /// One command in full: how to invoke it, what each argument is, what each flag changes, and the detail
    /// behind all of it. Goes to stderr when it answers a misuse rather than a question.
    /// </summary>
    public static void Page(CliCommand command, TextWriter? into = null)
    {
        var w = into ?? Console.Out;
        w.WriteLine();
        foreach (string line in Lay(command.Usage)) w.WriteLine("  " + line);
        w.WriteLine();
        Emit(w, command.Summary);
        Table(w, command.Params);
        Table(w, command.Flags);
        if (command.Detail.Length > 0)
        {
            w.WriteLine();
            Emit(w, command.Detail);
        }
        w.WriteLine();
    }

    /// <summary>
    /// A misspelling gets the nearest names back, not the whole index - the index is one keystroke away, and
    /// reprinting it here buries the one line that matters.
    /// </summary>
    public static int Unknown(string typed, IEnumerable<CliCommand> commands)
    {
        Console.Error.WriteLine($"snowknife: no command named '{typed}'.");

        // A prefix of a real name is an abbreviation, not a typo - "ssf" wants the three ssf-* commands, and
        // they come first. Everything else has to be close enough to be a slip: the shorter what was typed,
        // the less distance it takes before a suggestion is just a different command.
        int tolerance = Math.Clamp(typed.Length / 2, 1, 3);
        var near = commands.Select(c => c.Name)
                           .Select(name => (name,
                                            prefix: name.StartsWith(typed, StringComparison.OrdinalIgnoreCase),
                                            distance: Distance(typed, name)))
                           .Where(x => x.prefix || x.distance <= tolerance)
                           .OrderBy(x => x.prefix ? 0 : 1).ThenBy(x => x.distance).ThenBy(x => x.name, StringComparer.Ordinal)
                           .Take(3).Select(x => x.name).ToList();
        if (near.Count > 0) Console.Error.WriteLine("  did you mean: " + string.Join(", ", near) + "?");
        Console.Error.WriteLine("  `snowknife` on its own lists every command.");
        return 1;
    }

    /// <summary>Name in one column, what it is in the other - wrapped, and given its own line when the name
    /// is too wide to share one.</summary>
    private static void Table(TextWriter w, CliParam[] rows)
    {
        if (rows.Length == 0) return;
        w.WriteLine();

        int column = Math.Min(rows.Max(r => r.Name.Length) + 2, NameColumn);
        string indent = new(' ', column);
        foreach (var row in rows)
        {
            var what = Wrap(row.What, Width() - 2 - column).ToList();
            if (row.Name.Length + 2 > column)
            {
                w.WriteLine("  " + row.Name);
                foreach (string line in what) w.WriteLine("  " + indent + line);
            }
            else
            {
                w.WriteLine("  " + row.Name.PadRight(column) + what.FirstOrDefault(""));
                foreach (string line in what.Skip(1)) w.WriteLine("  " + indent + line);
            }
        }
    }

    private static void Emit(TextWriter w, string text)
    {
        foreach (string line in Wrap(text, Width() - 2)) w.WriteLine(line.Length == 0 ? "" : "  " + line);
    }

    /// <summary>Lay the usage tokens out, hanging the overflow under the command so the arguments stay
    /// readable when a command has many of them.</summary>
    private static IEnumerable<string> Lay(IEnumerable<string> tokens)
    {
        int width = Width() - 2;
        var line = new StringBuilder();
        foreach (string token in tokens)
        {
            if (line.Length > 0 && line.Length + 1 + token.Length > width)
            {
                yield return line.ToString();
                line.Clear().Append("    ");
            }
            if (line.Length > 0 && line[^1] != ' ') line.Append(' ');
            line.Append(token);
        }
        if (line.Length > 0) yield return line.ToString();
    }

    /// <summary>
    /// Reflow prose to a width. Consecutive lines are one paragraph however the source broke them - help
    /// text is written to read in a file and has to survive any terminal - and a blank line ends one.
    /// Indented lines are left alone: those are command lines and lists, where the author's own line breaks
    /// are the formatting.
    /// </summary>
    private static IEnumerable<string> Wrap(string text, int width)
    {
        var paragraph = new List<string>();
        foreach (string raw in text.Replace("\r\n", "\n").Split('\n'))
        {
            if (raw.Length > 0 && !char.IsWhiteSpace(raw[0])) { paragraph.Add(raw); continue; }
            foreach (string line in Fill(paragraph, width)) yield return line;
            paragraph.Clear();
            yield return raw.TrimEnd();
        }
        foreach (string line in Fill(paragraph, width)) yield return line;
    }

    /// <summary>Greedily fill one paragraph's words into lines.</summary>
    private static IEnumerable<string> Fill(List<string> paragraph, int width)
    {
        var line = new StringBuilder();
        foreach (string word in string.Join(' ', paragraph).Split(' ', StringSplitOptions.RemoveEmptyEntries))
        {
            if (line.Length > 0 && line.Length + 1 + word.Length > width) { yield return line.ToString(); line.Clear(); }
            if (line.Length > 0) line.Append(' ');
            line.Append(word);
        }
        if (line.Length > 0) yield return line.ToString();
    }

    /// <summary>The terminal's width, or a sane one when there is no terminal (a pipe, a CI log).</summary>
    private static int Width()
    {
        try { return Math.Clamp(Console.WindowWidth - 1, 60, 100); }
        catch { return 100; }
    }

    /// <summary>Levenshtein distance, for the did-you-mean.</summary>
    private static int Distance(string a, string b)
    {
        a = a.ToLowerInvariant();
        b = b.ToLowerInvariant();
        var previous = new int[b.Length + 1];
        var current = new int[b.Length + 1];
        for (int j = 0; j <= b.Length; j++) previous[j] = j;
        for (int i = 1; i <= a.Length; i++)
        {
            current[0] = i;
            for (int j = 1; j <= b.Length; j++)
                current[j] = Math.Min(Math.Min(current[j - 1] + 1, previous[j] + 1),
                                      previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
            (previous, current) = (current, previous);
        }
        return previous[b.Length];
    }
}
