using Newtonsoft.Json.Linq;
using Snowknife.Repack;
using Snowknife.Services;

namespace Snowknife.Tests.Repack;

public class PortableObjTests
{
    [Fact]
    public void PortableStartRouteSuppliesSixSlotsAndAStageAnchorRaceLine()
    {
        var input = JObject.Parse("""{"AIPaths":[{"PathPos":[1,2,3],"PathPoints":[[10,0,0]]}],"RaceLines":[],"StartPosList":[0]}""");
        Assert.True(RepackService.EnsureSixStartPaths(input));
        Assert.Equal(6, ((JArray)input["StartPosList"]!).Count);
        Assert.Equal(7, ((JArray)input["AIPaths"]!).Count);
        Assert.Single((JArray)input["RaceLines"]!);
        Assert.False(RepackService.EnsureSixStartPaths(input));
    }
    [Fact]
    public void GbaFacesAcquireUnitNormalsAndKeepTheirTextureCoordinates()
    {
        string result = PortableObj.ForTricky("v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n");
        Assert.Contains("vn 0 0 1", result, StringComparison.Ordinal);
        Assert.Contains("f 1/1/1 2/2/1 3/3/1", result, StringComparison.Ordinal);
    }

    [Fact]
    public void CompleteNormalsArePreservedAndRelativePolygonsAreTriangulated()
    {
        string result = PortableObj.ForTricky("v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvn 0 0 -1\nf -4/1/1 -3/1/1 -2/1/1 -1/1/1\n");
        Assert.Contains("vn 0 0 -1", result, StringComparison.Ordinal);
        Assert.Contains("f 1/1/1 2/1/1 3/1/1", result, StringComparison.Ordinal);
        Assert.Contains("f 1/1/1 3/1/1 4/1/1", result, StringComparison.Ordinal);
        Assert.DoesNotContain("vn 0 0 1", result, StringComparison.Ordinal);
    }

    [Fact]
    public void BareVerticesReceiveDefaultUvsAndInvalidIndexesFailClearly()
    {
        string vertices = "v 0 0 0\nv 1 0 0\nv 0 1 0\n";
        Assert.Contains("f 1/1/1 2/1/1 3/1/1", PortableObj.ForTricky(vertices + "f 1 2 3\n"), StringComparison.Ordinal);
        Assert.Throws<InvalidDataException>(() => PortableObj.ForTricky(vertices + "f 0 2 3\n"));
    }

    [Fact]
    public void GeneratedCornersDoNotChangeLaterRelativeSourceIndexes()
    {
        string result = PortableObj.ForTricky("v 0 0 0\nv 1 0 0\nv 0 1 0\nvn 0 0 -1\nf 1 2 3\nvt 1 1\nf 1/-1/-1 2/-1/-1 3/-1/-1\n");
        Assert.Contains("f 1/2/1 2/2/1 3/2/1", result, StringComparison.Ordinal);
    }

    [Fact]
    public void PortableMaterialAlphaIsTranslatedToThePs2Flag()
    {
        using var temp = new TempDir();
        temp.Write("Materials.json", """{"Materials":[{"TexturePath":"gba-keyed.png","AlphaMode":"cutout","UnknownInt18":7}]}""");
        temp.Write("Models.json", """{"Models":[{"ModelObjects":[]}]}""");
        temp.Write("Instances.json", """{"Instances":[]}""");
        Directory.CreateDirectory(Path.Combine(temp.Path, "Meshes"));
        var source = CanonicalMapProps.Load(temp.Path)!;
        Assert.Equal(0x40007, source.Materials[0].Int18);
    }
}
