using Snowknife.Services;

namespace Snowknife.Tests.Services;

public class TrickyCourseTests
{
    [Theory]
    [InlineData("gari")]
    [InlineData("TRICKY_GARI")]
    public void NewImportsUsePrefixedFoldersWhileArchiveLookupsUseBareSlots(string course)
    {
        Assert.Equal("GARI", TrickyCourse.Slot(course));
        Assert.Equal("TRICKY_GARI", TrickyCourse.Id(course));
        Assert.Equal(Path.GetFullPath(Path.Combine("Maps", "TRICKY_GARI")), TrickyCourse.ImportDirectory(course));
    }

    [Fact]
    public void ExplicitDestinationsIncludingLegacyFoldersArePreserved()
    {
        Assert.Equal(Path.GetFullPath(Path.Combine("Maps", "GARI")),
            TrickyCourse.ImportDirectory("TRICKY_GARI", Path.Combine("Maps", "GARI")));
        Assert.Equal(Path.GetFullPath("MyCourse"), TrickyCourse.ImportDirectory("GARI", "MyCourse"));
    }
}
