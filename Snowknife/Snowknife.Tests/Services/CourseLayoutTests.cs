using Snowknife.Services;
using Newtonsoft.Json.Linq;

namespace Snowknife.Tests.Services;

public class CourseLayoutTests
{
    [Fact]
    public void RunsAndConnectorsRetainTheirSourceComposition()
    {
        var run = CourseLayout.Ssx3("SSX3_ARA1", ["A_ARA1", "ARA1", "ARA1_B"]);
        Assert.Equal("run", (string?)run["MapType"]);
        Assert.Equal("ssx-3:bam", (string?)run["WorldId"]);
        Assert.Equal("SSX3_PEAK1", (string?)run["ParentMap"]);
        Assert.Equal(new[] { "A_ARA1", "ARA1", "ARA1_B" }, run["SourceSections"]!.Values<string>());
        var connector = CourseLayout.Ssx3("SSX3_ERA5_C", ["ERA5_C"]);
        Assert.Equal("connector", (string?)connector["MapType"]);
        Assert.Equal("SSX3_PEAK3", (string?)connector["ParentMap"]);
        Assert.Equal(new[] { "SSX3_ERA5", "SSX3_C" }, connector["Connects"]!.Values<string>());
    }

    [Theory]
    [InlineData("SSX3_C", "hub", "SSX3_PEAK2")]
    [InlineData("SSX3_PEAK2", "run-chain", "SSX3_ALL")]
    [InlineData("SSX3_ALL", "full-mountain", null)]
    public void HubsAndBundlesAreDistinct(string id, string kind, string? parent)
    {
        var layout = CourseLayout.Ssx3(id, []);
        Assert.Equal(kind, (string?)layout["MapType"]);
        Assert.Equal(parent, (string?)layout["ParentMap"]);
    }
}
