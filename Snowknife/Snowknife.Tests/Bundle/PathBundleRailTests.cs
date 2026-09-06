using Newtonsoft.Json;
using Snowknife.Bundle;

namespace Snowknife.Tests.Bundle;

public class PathBundleRailTests
{
    [Fact]
    public void NamedIceRailsKeepTheirSplineStyleInRailOrder()
    {
        using var temp = new TempDir();
        var document = new
        {
            Splines = new object[]
            {
                Spline("Spline_IceRail_2000", 5, 0),
                Spline("Spline_MetalRail_1000", 13, 100),
                Spline("Spline_NotRideable", 5, 200),
            },
        };
        File.WriteAllText(Path.Combine(temp.Path, "Splines.json"), JsonConvert.SerializeObject(document));

        var paths = PathBundle.Build(temp.Path, out var splineToRail);

        Assert.NotNull(paths.Rails);
        var styles = Assert.IsType<List<int>>(paths.Rails!.Style);
        Assert.Equal(new[] { 5, 13 }, styles);
        Assert.Equal(paths.Rails.Start.Count, styles.Count);
        Assert.Equal(paths.Rails.Count.Count, styles.Count);
        Assert.Equal(0, splineToRail[0]);
        Assert.Equal(1, splineToRail[1]);
        Assert.DoesNotContain(2, splineToRail.Keys);
    }

    static object Spline(string name, int style, float x) => new
    {
        SplineName = name,
        U0 = 1,
        U1 = 1,
        SplineStyle = style,
        Segments = new[]
        {
            new
            {
                Points = new[]
                {
                    new[] { x, 0f, 0f },
                    new[] { x + 25f, 0f, 0f },
                    new[] { x + 75f, 0f, 0f },
                    new[] { x + 100f, 0f, 0f },
                },
            },
        },
    };
}
