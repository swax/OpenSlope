using Newtonsoft.Json;
using Snowknife.Bundle;

namespace Snowknife.Tests.Bundle;

public class CheckpointBundleTests
{
    [Fact]
    public void SopType11EventsBecomeGroupedCourseCheckpoints()
    {
        using var temp = new TempDir();
        var sop = new
        {
            RaceLines = new object[]
            {
                new
                {
                    Name = "main", DistanceToFinish = 10000f, PathPos = new[] { 0f, 0f, 0f },
                    PathPoints = new[] { new[] { 0f, 0f, 0f }, new[] { 10000f, 0f, 0f } },
                    PathEvents = new[] { new { EventType = 11, EventValue = 150, EventStart = 5000f, EventEnd = 5000f } },
                },
                new
                {
                    Name = "alternate", DistanceToFinish = 10050f, PathPos = new[] { 0f, -2000f, 0f },
                    PathPoints = new[] { new[] { 0f, 0f, 0f }, new[] { 10000f, 0f, 0f } },
                    PathEvents = new[] { new { EventType = 11, EventValue = 120, EventStart = 5050f, EventEnd = 5050f } },
                },
            },
            AIPaths = Array.Empty<object>(),
        };
        File.WriteAllText(Path.Combine(temp.Path, "SOP.json"), JsonConvert.SerializeObject(sop));

        var paths = PathBundle.Build(temp.Path, out _);
        Assert.NotNull(paths.Course);
        var checkpoints = paths.Course!.Checkpoints;
        Assert.Equal(2, checkpoints.Count);
        Assert.Equal(checkpoints[0].Group, checkpoints[1].Group);
        Assert.Equal(new[] { 150, 120 }, checkpoints.Select(checkpoint => checkpoint.BonusSeconds));
        Assert.Equal(-5000f, checkpoints[0].Position[0], 2);
        Assert.Equal(-2000f, checkpoints[1].Position[1], 2);
        Assert.Equal(5000f, checkpoints[0].Dtf, 2);
        Assert.Equal(5000f, checkpoints[1].Dtf, 2);
    }
}
