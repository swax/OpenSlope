using Snowknife.Cli;

namespace Snowknife.Tests.Cli;

/// <summary>
/// The command table is the compose root: building it constructs every service, and <c>Program.Main</c>
/// immediately indexes it by name with a dictionary that throws on a duplicate. So a malformed row is a
/// startup crash for every command, not just the one that is wrong — and the rules the table claims for
/// itself ("a command cannot ship without help text", "the usage line is built from the arguments it
/// documents") are only true if something checks them.
/// </summary>
public class CommandTableTests
{
    static readonly CliGroup[] Groups = Commands.Build();

    public static TheoryData<string> CommandNames()
    {
        var data = new TheoryData<string>();
        foreach (var command in Groups.SelectMany(g => g.Commands)) data.Add(command.Name);
        return data;
    }

    static CliCommand Command(string name) => Groups.SelectMany(g => g.Commands).Single(c => c.Name == name);

    [Fact]
    public void TheTableBuildsAndIsNotEmpty()
    {
        Assert.NotEmpty(Groups);
        Assert.NotEmpty(Groups.SelectMany(g => g.Commands));
    }

    [Fact]
    public void PublicWorkflowUsesSnowknifeActionNames()
    {
        string[] names = Groups.SelectMany(g => g.Commands).Select(c => c.Name).ToArray();

        foreach (string name in new[] { "import", "repack", "intro-music", "race-music", "rider" })
            Assert.Contains(name, names);
        foreach (string legacy in new[] { "map", "repack-as", "audio", "music", "char" })
            Assert.DoesNotContain(legacy, names);
    }

    [Fact]
    public void ImportCanExplicitlyDropAnInvalidThirdPartyEffectsGraph()
    {
        var flags = Command("import").Flags.Select(flag => flag.Name).ToArray();

        Assert.Contains("--no-effects", flags);
        Assert.Contains("--salvage-effects", flags);
        Assert.Contains("--repair-missing-map-links", flags);
        Assert.Contains("--allow-nonring-sky", flags);
    }

    [Fact]
    public void CommandNamesAreUniqueEvenIgnoringCase()
    {
        // Program.Main indexes with an OrdinalIgnoreCase dictionary, so a case-only collision is an
        // ArgumentException before any command runs.
        var duplicates = Groups.SelectMany(g => g.Commands)
            .GroupBy(c => c.Name, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key)
            .ToArray();

        Assert.Empty(duplicates);
    }

    [Fact]
    public void GroupTitlesArePresentAndDistinct()
    {
        Assert.All(Groups, g => Assert.False(string.IsNullOrWhiteSpace(g.Title)));
        Assert.Equal(Groups.Length, Groups.Select(g => g.Title).Distinct(StringComparer.Ordinal).Count());
    }

    [Fact]
    public void EveryGroupHasAtLeastOneCommand()
    {
        Assert.All(Groups, g => Assert.NotEmpty(g.Commands));
    }

    [Theory]
    [MemberData(nameof(CommandNames))]
    public void EveryCommandHasTheIndexLineTheIndexNeeds(string name)
    {
        // Summary is what the grouped index prints, so every row needs one. Detail is allowed to be empty:
        // for a command like `iso-ls` the summary plus the per-argument text already says everything, and
        // the record documents Detail as what is true "once the arguments are understood".
        var command = Command(name);

        Assert.False(string.IsNullOrWhiteSpace(command.Summary), $"{name} has no summary");
    }

    [Theory]
    [MemberData(nameof(CommandNames))]
    public void EveryArgumentAndFlagSaysWhatItIsFor(string name)
    {
        var command = Command(name);

        foreach (var parameter in command.Params.Concat(command.Flags))
        {
            Assert.False(string.IsNullOrWhiteSpace(parameter.Name), $"{name} has an unnamed parameter");
            Assert.False(string.IsNullOrWhiteSpace(parameter.What), $"{name} {parameter.Name} has no explanation");
        }
    }

    [Theory]
    [MemberData(nameof(CommandNames))]
    public void TheUsageLineShowsEveryDocumentedArgument(string name)
    {
        var command = Command(name);

        var usage = command.Usage.ToArray();

        Assert.Equal("snowknife", usage[0]);
        Assert.Equal(name, usage[1]);
        foreach (var parameter in command.Params) Assert.Contains(parameter.Name, usage);
        foreach (var flag in command.Flags) Assert.Contains("[" + flag.Name + "]", usage);
        Assert.Equal(2 + command.Params.Length + command.Flags.Length, usage.Length);
    }

    [Theory]
    [MemberData(nameof(CommandNames))]
    public void FlagsAreWrittenAsFlags(string name)
    {
        // Long flags are the norm; `bnk -v` is the one short spelling, so the rule is a leading dash rather
        // than a leading double dash.
        var command = Command(name);

        foreach (var flag in command.Flags)
            Assert.StartsWith("-", flag.Name, StringComparison.Ordinal);
    }

    [Theory]
    [MemberData(nameof(CommandNames))]
    public void OptionalPositionalsComeLast(string name)
    {
        // Required counts every non-bracketed positional, but its documented meaning is "every positional up
        // to the first optional one". Those agree only while optionals trail; a required argument after an
        // optional one would make the count silently wrong.
        var command = Command(name);

        bool seenOptional = false;
        foreach (var parameter in command.Params)
        {
            bool optional = parameter.Name.StartsWith('[');
            if (optional) seenOptional = true;
            else Assert.False(seenOptional, $"{name} documents required {parameter.Name} after an optional argument");
        }
    }

    [Theory]
    [MemberData(nameof(CommandNames))]
    public void NoCommandDemandsMoreArgumentsThanItDocuments(string name)
    {
        // Program.Main refuses to dispatch below Required. Overshooting the documented positionals would
        // reject a run the usage line says is valid.
        var command = Command(name);

        Assert.InRange(command.Required, 0, command.Params.Length);
    }

    [Theory]
    [MemberData(nameof(CommandNames))]
    public void AnExplicitRequiresOverrideOnlyEverLowersTheBar(string name)
    {
        // The override exists for commands where a flag stands in for the positionals (`skycolor --revert`).
        // Undershooting is documented as harmless; raising it above the documented count is not.
        var command = Command(name);

        if (command.Requires is { } requires)
            Assert.InRange(requires, 0, command.Params.Count(p => !p.Name.StartsWith('[')));
    }

    [Theory]
    [MemberData(nameof(CommandNames))]
    public void EveryCommandsHelpPageRendersWithoutThrowing(string name)
    {
        var command = Command(name);
        var into = new StringWriter();

        Help.Page(command, into);

        string page = into.ToString();
        Assert.Contains(name, page, StringComparison.Ordinal);
        Assert.NotEqual(0, page.Trim().Length);
    }

    [Fact]
    public void TheIndexListsEveryCommandUnderItsGroup()
    {
        var original = Console.Out;
        var into = new StringWriter();
        try
        {
            Console.SetOut(into);
            Help.Index(Groups);
        }
        finally { Console.SetOut(original); }

        string index = into.ToString();
        foreach (var group in Groups)
        {
            Assert.Contains(group.Title, index, StringComparison.Ordinal);
            foreach (var command in group.Commands)
                Assert.Contains(command.Name, index, StringComparison.Ordinal);
        }
    }
}
