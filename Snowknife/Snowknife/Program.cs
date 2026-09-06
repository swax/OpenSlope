using Snowknife.Cli;
using Snowknife.Services;

namespace Snowknife;

/// <summary>
/// Command-line front-end for the SSX library. Reads a PS2 game ISO directly (via DiscUtils) and drives the
/// existing SSX-Library extractors so we can go ISO -> Blender-ready assets without the WinForms GUI.
///
/// `Main` only routes. <see cref="Commands"/> is the compose root and the table of what exists, the services
/// (Services/*.cs) hold the domain logic, and <see cref="Help"/> does the talking.
/// </summary>
internal static class Program
{
    /// <summary>Asking for help, in any of the spellings someone reaches for first.</summary>
    private static readonly string[] Asking = ["help", "--help", "-h", "-?", "/?"];

    private static int Main(string[] args)
    {
        var groups = Commands.Build();
        var byName = groups.SelectMany(g => g.Commands)
                           .ToDictionary(c => c.Name, StringComparer.OrdinalIgnoreCase);

        // Bare `snowknife` is a misuse, so it exits nonzero - but it still gets the index rather than a scolding.
        if (args.Length == 0) { Help.Index(groups); return 1; }

        // `snowknife help`, `snowknife help <command>` and `snowknife <command> --help` all land on the same page.
        if (IsAsking(args[0]))
        {
            if (args.Length < 2) { Help.Index(groups); return 0; }
            return byName.TryGetValue(args[1], out var asked)
                ? Show(asked)
                : Help.Unknown(args[1], byName.Values);
        }
        if (!byName.TryGetValue(args[0], out var command)) return Help.Unknown(args[0], byName.Values);
        if (args.Length > 1 && IsAsking(args[1])) return Show(command);

        // Too few arguments is a question, not an offence: answer it with the command's own page rather than
        // a one-line scold. Flags are not counted, so `skycolor <iso> --revert` reads as the one argument it
        // is; the handler's own guard still has the last word on the arguments a usage line cannot express.
        if (args.Skip(1).Count(a => !a.StartsWith('-')) < command.Required)
        {
            Help.Page(command, Console.Error);
            return 1;
        }

        try
        {
            return command.Run(args);
        }
        catch (ContractValidationException ex)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine("ERROR: " + ex.Message);
            return 2;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine("ERROR: " + ex.Message);
            Console.Error.WriteLine(ex);
            return 2;
        }
    }

    private static bool IsAsking(string arg) => Asking.Contains(arg, StringComparer.OrdinalIgnoreCase);

    private static int Show(CliCommand command)
    {
        Help.Page(command);
        return 0;
    }
}
