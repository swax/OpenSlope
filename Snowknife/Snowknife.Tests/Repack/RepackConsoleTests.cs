using Snowknife.Repack;

namespace Snowknife.Tests.Repack;

/// <summary>
/// The repack view's output filters, and specifically that they come back OFF.
///
/// `Console.SetOut` wraps whatever it is handed, so a restore written as "put it back only if Console.Out is
/// still the writer I installed" can never fire. The warning-only filter — installed around the level build —
/// would then cover the whole rest of the run and silently drop every ordinary line after it: the custom
/// sounds encoded into the course bank, the archives rebuilt, the closing summary. A build that says nothing
/// about what it did looks exactly like a build that did nothing.
///
/// These run Console.Out through the real filters rather than testing the writers in isolation, because the
/// bug was entirely in the install/restore pairing. Console is process-global; the suite already disables
/// test parallelization for that reason (AssemblyInfo.cs).
/// </summary>
public class RepackConsoleTests
{
    static string Capture(Action body)
    {
        var buffer = new StringWriter();
        TextWriter saved = Console.Out;
        Console.SetOut(buffer);
        try { body(); }
        finally { Console.SetOut(saved); }
        return buffer.ToString();
    }

    [Fact]
    public void OrdinaryLinesSurviveAfterTheLevelBuildsTraceIsSuppressed()
    {
        string output = Capture(() =>
        {
            using (RepackConsole.NormalizeSharedServiceOutput())
            {
                using (RepackConsole.SuppressPackingTrace())
                    Console.WriteLine("packing instance 4131 of 9000");
                RepackConsole.Detail("custom emitter loop encoded into course-bank slot 010");
            }
        });

        Assert.DoesNotContain("packing instance", output);
        Assert.Contains("custom emitter loop encoded into course-bank slot 010", output);
    }

    [Fact]
    public void TheSuppressedBlockStillLetsWarningsThrough()
    {
        string output = Capture(() =>
        {
            using (RepackConsole.SuppressPackingTrace())
            {
                Console.WriteLine("routine chatter");
                Console.WriteLine("WARN: slot 010 unchanged");
            }
        });

        Assert.DoesNotContain("routine chatter", output);
        Assert.Contains("slot 010 unchanged", output);
    }

    [Fact]
    public void EveryFilterIsGoneOnceItsScopeEnds()
    {
        string output = Capture(() =>
        {
            using (RepackConsole.NormalizeSharedServiceOutput()) { }
            using (RepackConsole.SuppressPackingTrace()) { }
            Console.WriteLine("plain");
        });

        Assert.Contains("plain", output);
    }

    [Fact]
    public void DisposingTwiceDoesNotUnwindSomebodyElsesWriter()
    {
        string output = Capture(() =>
        {
            IDisposable outer = RepackConsole.NormalizeSharedServiceOutput();
            outer.Dispose();
            using (RepackConsole.SuppressPackingTrace())
                Console.WriteLine("swallowed");
            outer.Dispose();
            Console.WriteLine("still here");
        });

        Assert.DoesNotContain("swallowed", output);
        Assert.Contains("still here", output);
    }
}
