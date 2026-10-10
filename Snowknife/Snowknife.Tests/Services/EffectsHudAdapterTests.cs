using Newtonsoft.Json.Linq;
using Snowknife.Services;
using SSX_Library.FileHandlers.LevelFiles.Tricky.PS2;

namespace Snowknife.Tests.Services;

public sealed class EffectsHudAdapterTests
{
    private static void WriteSsf(string path, string text)
    {
        var hud = new SSFHandler.Effect
        {
            MainType = 12,
            hudTextEffect = new SSFHandler.HUDTextEffect
            {
                HudText = text, HudRed = 0.25f, HudGreen = 0.5f, HudBlue = 0.75f,
            },
        };
        var wait = new SSFHandler.Effect { MainType = 4, WaitTime = 2f };
        var ssf = new SSFHandler();
        ssf.EffectHeaders.Add(new() { Effects = [hud, wait], EffectCount = 2 });
        ssf.Functions.Add(new() { Effects = [hud, wait], Count = 2, FunctionName = "message" });
        ssf.Save(path);
    }

    [Theory]
    [InlineData("")]
    [InlineData("a")]
    [InlineData("ab")]
    [InlineData("checkpoint")]
    public void GroupedLibraryHudRoundTripsThroughFlatEffectsDocuments(string text)
    {
        using var temp = new TempDir();
        string source = Path.Combine(temp.Path, "source.ssf");
        string document = Path.Combine(temp.Path, "Effects.json");
        string rebuilt = Path.Combine(temp.Path, "rebuilt.ssf");
        WriteSsf(source, text);
        var service = new EffectsDocumentService(new ContractValidationService());

        Assert.Equal(0, service.Export(["effects-export", source, document]));
        var json = JObject.Parse(File.ReadAllText(document));
        foreach (string table in new[] { "graphs", "functions" })
        {
            var payload = json[table]![0]!["nodes"]![0]!["payload"]!;
            Assert.Equal(text, (string?)payload["HudText"]);
            Assert.Equal(0.25f, (float?)payload["HudRed"]);
            Assert.Equal(0.5f, (float?)payload["HudGreen"]);
            Assert.Equal(0.75f, (float?)payload["HudBlue"]);
            Assert.Null(payload["hudTextEffect"]);
        }
        Assert.Equal(0, service.Import(["effects-import", document, rebuilt]));
        var actual = new SSFHandler();
        actual.Load(rebuilt);
        Assert.Equal(text, actual.EffectHeaders[0].Effects[0].hudTextEffect!.Value.HudText);
        Assert.Equal(2f, actual.EffectHeaders[0].Effects[1].WaitTime);
        Assert.Equal(text, actual.Functions[0].Effects[0].hudTextEffect!.Value.HudText);
        Assert.Equal(2f, actual.Functions[0].Effects[1].WaitTime);
    }

    [Fact]
    public void ExistingFlatDocumentsKeepDefaultColorsAndIgnoreHudFieldsOnOtherOpcodes()
    {
        using var temp = new TempDir();
        string source = Path.Combine(temp.Path, "source.ssf");
        string document = Path.Combine(temp.Path, "Effects.json");
        string rebuilt = Path.Combine(temp.Path, "rebuilt.ssf");
        WriteSsf(source, "ab");
        var service = new EffectsDocumentService(new ContractValidationService());
        service.Export(["effects-export", source, document]);
        var json = JObject.Parse(File.ReadAllText(document));
        var nodes = json["graphs"]![0]!["nodes"]!;
        var hud = (JObject)nodes[0]!["payload"]!;
        hud.Remove("HudRed");
        hud["HudBlue"] = null;
        var wait = (JObject)nodes[1]!["payload"]!;
        wait["HudText"] = null;
        wait["HudRed"] = wait["HudGreen"] = wait["HudBlue"] = 0f;
        File.WriteAllText(document, json.ToString());

        Assert.Equal(0, service.Import(["effects-import", document, rebuilt]));
        var actual = new SSFHandler();
        actual.Load(rebuilt);
        var message = actual.EffectHeaders[0].Effects[0].hudTextEffect!.Value;
        Assert.Equal((1f, 0.5f, 1f), (message.HudRed, message.HudGreen, message.HudBlue));
        Assert.Equal(2f, actual.EffectHeaders[0].Effects[1].WaitTime);
        Assert.Null(actual.EffectHeaders[0].Effects[1].hudTextEffect);
    }
}
