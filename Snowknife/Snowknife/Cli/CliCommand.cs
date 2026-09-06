namespace Snowknife.Cli;

/// <summary>
/// One argument or flag, and what it is for.
/// </summary>
/// <param name="Name">
/// As it appears on the usage line: <c>&lt;iso&gt;</c>, <c>[outDir]</c>, <c>--from &lt;clean.iso&gt;</c>. A
/// positional written in brackets is optional; a flag is bracketed for you.
/// </param>
/// <param name="What">What to pass, and what changes because you did. A default belongs here.</param>
internal readonly record struct CliParam(string Name, string What);

/// <summary>
/// One subcommand: how to run it, and everything the CLI knows how to say about it.
///
/// Dispatch and help read the same record, so a command cannot ship without help text or drift away from
/// the text it has. The usage line is built from the arguments the command documents, which extends that
/// the whole way down: it cannot show a parameter it does not explain, or explain one it does not show.
/// </summary>
/// <param name="Name">The subcommand word, as typed.</param>
/// <param name="Summary">One short line for the index - what it does, not how.</param>
/// <param name="Detail">
/// What is true of the command as a whole, once the arguments are understood: where the output goes, what
/// it costs, what has to have happened first. Per-argument facts belong on the argument. A line that starts
/// with whitespace is printed verbatim; everything else is wrapped to the terminal.
/// </param>
/// <param name="Run">The handler, given the whole argv - <c>args[0]</c> is the command word itself.</param>
internal sealed record CliCommand(string Name, string Summary, string Detail, Func<string[], int> Run)
{
    /// <summary>Positional arguments, in the order they are passed.</summary>
    public CliParam[] Params { get; init; } = [];

    /// <summary>Flags, in the order they are worth meeting.</summary>
    public CliParam[] Flags { get; init; } = [];

    /// <summary>
    /// Override for how many arguments have to be there before the command is worth dispatching. Needed only
    /// where a flag stands in for the positionals: `skycolor` takes three arguments to set a colour but one
    /// to revert. Everything else counts its own required parameters.
    ///
    /// Undershooting is harmless - the handler still has its own guard, which is the one that knows about
    /// arguments the usage line cannot express (`ssf-canary --host`). Overshooting would refuse a valid run.
    /// </summary>
    public int? Requires { get; init; }

    /// <summary>The usage line, as tokens to be laid out.</summary>
    public IEnumerable<string> Usage =>
        new[] { "snowknife", Name }
            .Concat(Params.Select(p => p.Name))
            .Concat(Flags.Select(f => "[" + f.Name + "]"));

    /// <summary>Arguments this cannot run without: every positional up to the first optional one.</summary>
    public int Required => Requires ?? Params.Count(p => !p.Name.StartsWith('['));
}

/// <summary>
/// A titled run of commands in the index. The order the groups appear in is the order an author meets them:
/// the course pipeline first, the raw containers last.
/// </summary>
internal sealed record CliGroup(string Title, CliCommand[] Commands);
