using System.Buffers.Binary;
using Newtonsoft.Json.Linq;
using Snowknife.Formats;
using Snowknife.Repack;

namespace Snowknife.Tests.Repack;

public class BareSlotResourcesTests
{
    [Fact]
    public void OnlyUnreachableDonorPayloadIsRemovedAndAllTableIndexesStayStable()
    {
        using var temp = new TempDir();
        var models = new JArray(Enumerable.Range(0, 4).Select(i => new JObject
        {
            ["ModelName"] = $"Model {i}",
            ["ModelObjects"] = new JArray(new JObject
            {
                ["MeshData"] = new JArray(new JObject { ["MeshPath"] = $"{i}.obj", ["MaterialID"] = i }),
            }),
        }));
        temp.Write("Models.json", new JObject { ["Models"] = models }.ToString());
        temp.Write("Instances.json", """
            {"Instances":[
              {"ModelID":0,"Visable":false,"PlayerCollision":false,"IncludeSound":false},
              {"ModelID":1,"Visable":false,"PlayerCollision":false},
              {"ModelID":2,"InstanceName":"Mdl_StageArea_Start_0","Visable":true},
              {"ModelID":1,"Visable":true}
            ]}
            """);
        string instances = File.ReadAllText(temp.File("Instances.json"));
        Assert.Equal(1, BareSlotResources.PruneModels(temp.Path, donorInstances: 3, donorModels: 3));
        var result = (JArray)JObject.Parse(File.ReadAllText(temp.File("Models.json")))["Models"]!;
        Assert.Equal(4, result.Count);
        Assert.Equal("Model 0", (string?)result[0]["ModelName"]);
        Assert.Empty((JArray)result[0]["ModelObjects"]!);
        Assert.All(result.Skip(1), model => Assert.Single((JArray)model["ModelObjects"]!));
        Assert.Equal(instances, File.ReadAllText(temp.File("Instances.json")));
        Assert.Equal(0, BareSlotResources.PruneModels(temp.Path, 3, 3));

        temp.Write("Patches.json", """{"Patches":[{"TexturePath":"0002.png","LightmapID":-1},{"TexturePath":"0002.png","LightmapID":1}]}""");
        temp.Write("Materials.json", """
            {"Materials":[
              {"TexturePath":"0003.png"},
              {"TexturePath":"0004.png","TextureFlipbook":["0005.png"]},
              {"TexturePath":"0006.png"},
              {"TexturePath":"0007.png"}
            ]}
            """);
        var (textures, lightmaps) = BareSlotResources.UsedPages(temp.Path);
        Assert.Equal(new[] { 0, 2, 4, 5, 6, 7 }, textures.Order());
        Assert.Equal(new[] { 1 }, lightmaps.Order());
    }

    [Fact]
    public void UsedPagesAndDirectoryIdentitySurviveBankTrimmingVerbatim()
    {
        byte[] bank = Bank();
        byte[] placeholder = Enumerable.Repeat((byte)128, 16).ToArray();
        var original = SshBank.Load(bank);
        var result = SshBank.Load(BareSlotResources.TrimBank(bank, new HashSet<int> { 0, 2 }, placeholder));
        Assert.Equal(original.Count, result.Count);
        Assert.Equal(original.Dir.Select(entry => entry.Name), result.Dir.Select(entry => entry.Name));
        Assert.Equal(original.PageBytes(0), result.PageBytes(0));
        Assert.Equal(original.PageBytes(2), result.PageBytes(2));
        Assert.Equal(placeholder, result.PageBytes(1));
        Assert.Equal(placeholder, result.PageBytes(3));
        Assert.Equal(bank.Length - 96, result.Bytes.Length);
        Assert.Throws<InvalidDataException>(() => BareSlotResources.TrimBank(bank, new HashSet<int> { 4 }, placeholder));
    }

    private static byte[] Bank()
    {
        byte[] data = new byte[48 + 4 * 64];
        "SHPS"u8.CopyTo(data);
        BinaryPrimitives.WriteInt32LittleEndian(data.AsSpan(4), data.Length);
        BinaryPrimitives.WriteInt32LittleEndian(data.AsSpan(8), 4);
        for (int i = 0; i < 4; i++)
        {
            System.Text.Encoding.ASCII.GetBytes(i.ToString("D4", System.Globalization.CultureInfo.InvariantCulture)).CopyTo(data, 16 + i * 8);
            BinaryPrimitives.WriteInt32LittleEndian(data.AsSpan(20 + i * 8), 48 + i * 64);
            data.AsSpan(48 + i * 64, 64).Fill((byte)(i + 1));
        }
        return data;
    }
}
