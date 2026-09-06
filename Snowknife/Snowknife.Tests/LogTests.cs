namespace Snowknife.Tests;

/// <summary>
/// The pipeline's one output sink. Two properties matter and neither shows up in a normal run: a Redirect
/// scope has to come back OFF (the same failure shape RepackConsoleTests guards against), and the default
/// sink has to follow <c>Console.SetOut</c> at call time, because that is how every test in this suite
/// captures output and a writer cached at type-init would have silently kept pointing at the runner's stream.
/// </summary>
public class LogTests
{
    static readonly string NL = Environment.NewLine;

    [Fact]
    public void RedirectRestoresThePreviousSinksWhenDisposed()
    {
        var outer = new StringWriter();
        var outerErr = new StringWriter();
        var inner = new StringWriter();
        using (Log.Redirect(outer, outerErr))
        {
            Log.Info("outer info");
            Log.Warn("outer warn");
            Log.Error("outer error");
            using (Log.Redirect(inner))
            {
                Log.Info("inner info");
                Log.Error("inner error");   // the nested scope left the error stream where it was
            }
            Log.Info("outer again");
        }

        Assert.Equal($"outer info{NL}outer warn{NL}outer again{NL}", outer.ToString());
        Assert.Equal($"outer error{NL}inner error{NL}", outerErr.ToString());
        Assert.Equal($"inner info{NL}", inner.ToString());

        // Past the outermost scope, output is back on Console.
        var console = new StringWriter();
        TextWriter saved = Console.Out;
        Console.SetOut(console);
        try { Log.Info("back on console"); }
        finally { Console.SetOut(saved); }
        Assert.Equal($"back on console{NL}", console.ToString());
        Assert.DoesNotContain("back on console", outer.ToString());
    }

    [Fact]
    public void TheDefaultSinkFollowsConsoleSetOutAtCallTime()
    {
        var first = new StringWriter();
        var second = new StringWriter();
        TextWriter saved = Console.Out;
        try
        {
            Console.SetOut(first);
            Log.Info("one");
            Console.SetOut(second);
            Log.Info("two");
        }
        finally { Console.SetOut(saved); }

        Assert.Equal($"one{NL}", first.ToString());
        Assert.Equal($"two{NL}", second.ToString());
    }
}
