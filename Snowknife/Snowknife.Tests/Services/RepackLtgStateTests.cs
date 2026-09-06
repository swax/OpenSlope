using Snowknife.Services;

namespace Snowknife.Tests.Services;

public sealed class RepackLtgStateTests
{
    [Theory]
    [InlineData(2, 2)]
    [InlineData(0, 0)]
    [InlineData(-1, 0)]
    [InlineData(1, 0)]
    [InlineData(99, 0)]
    public void OnlyTheValidatedShowoffLayerSurvivesAuthoredPropNormalization(int input, int expected)
    {
        Assert.Equal(expected, RepackService.NormalizeAuthoredPropLtgState(input));
    }
}
