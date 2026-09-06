using Newtonsoft.Json;
using Snowknife.Services;

namespace Snowknife.Tests.Services;

/// <summary>
/// The schema gate at every portable-JSON boundary. Today the schemas are only ever proven by real pipeline
/// output happening to pass, which says nothing about what they REJECT — and a contract that accepts anything
/// is not a contract. Each kind here gets a minimal valid document plus the specific malformations the schema
/// exists to catch, so a loosened constraint fails visibly.
/// </summary>
public class ContractValidationTests
{
    static readonly ContractValidationService Contracts = new();

    // ---- minimal documents that satisfy each schema's required set ----

    const string MinimalPatches = """
        { "Patches": [] }
        """;

    const string MinimalSplines = """
        { "Splines": [] }
        """;

    const string MinimalSoundIndex = """
        {
          "Schema": "openslope-sound-index/v1",
          "Level": "DONOR",
          "SourceExecutable": "BOOT.ELF",
          "Banks": { "2": "course-a" },
          "CollisionEvents": {
            "700": { "Group": 2, "Slot": 4, "Bank": "course-a", "Clip": "Audio/SFX/course-a/004.wav" }
          }
        }
        """;

    const string MinimalBoardSoundIndex = """
        {
          "Schema": "openslope-board-sound-index/v1",
          "SourceExecutable": "BOOT.ELF",
          "SurfaceGroups": [2, 0, 1]
        }
        """;

    const string MinimalEnvironmentAudio = """
        {
          "Schema": "openslope-environment-audio/v1",
          "Bed": {
            "Bank": "Wind1",
            "Slot": 0,
            "Clip": "Audio/SFX/Wind1/000.wav",
            "Volume": 0.15
          }
        }
        """;

    const string MinimalSkyRing = """
        {
          "Schema": "openslope-sky-ring/v1",
          "Radius": 10,
          "TopZ": 2,
          "MidZ": 0,
          "BottomZ": -2,
          "GroundIndex": 2,
          "GroundUvRadius": 0.5,
          "Panels": [
            { "Index": 0, "Band": "upper", "AzFrom": 180, "AzTo": 0 },
            { "Index": 1, "Band": "lower", "AzFrom": 180, "AzTo": 0 }
          ],
          "Tiles": [
            { "Width": 64, "Height": 64 },
            { "Width": 32, "Height": 32 },
            { "Width": 64, "Height": 64 }
          ]
        }
        """;

    // The minimum a screen set can be: a map whose boards carry none. Detection writes this for a course with
    // no billboards at all, so an empty list has to be a legal document rather than a missing file.
    const string MinimalBillboards = """
        {
          "Schema": "openslope-billboards/v1",
          "Source": "detected",
          "Screens": []
        }
        """;

    const string PopulatedBillboards = """
        {
          "Schema": "openslope-billboards/v1",
          "Source": "authored",
          "Screens": [{
            "Name": "Ad_A_1000",
            "Family": "Ad_A",
            "Center": [0, -10, 900],
            "Normal": [0, -1, 0],
            "Up": [0, 0, 1],
            "Width": 2000,
            "Height": 800,
            "Instance": 4,
            "Page": "0031"
          }]
        }
        """;

    const string MinimalPropOverride = """
        { "match": "Mdl_Tree", "meshes": ["tree.obj"] }
        """;

    const string MinimalRepackManifest = """
        {
          "InputIso": "clean.iso",
          "OutputIso": "out.iso",
          "Levels": [{ "Slot": "DONOR", "LevelData": "data", "Export": "Maps/MYLEVEL" }]
        }
        """;

    const string MinimalBundleManifest = """
        {
          "BundleVersion": 3,
          "Level": "MYLEVEL",
          "Space": { "Scale": 1.0, "RootEuler": [0, 0, 0], "Up": "Y", "Handed": "left", "Units": "m" },
          "Recenter": { "ToOrigin": false, "AxisMask": [0, 0, 0] },
          "Meshes": []
        }
        """;

    const string MinimalEffects = """
        {
          "kind": "openslope-effects",
          "version": 1,
          "target": { "game": "SSX Tricky", "platform": "PS2", "region": "NTSC", "level": "MYLEVEL" },
          "header": { "U1": 0, "U2": 0, "U3": 0 },
          "slots": [],
          "graphs": [],
          "functions": [],
          "objectProperties": [],
          "instances": [],
          "physics": [],
          "collisionModels": [],
          "splines": []
        }
        """;

    // The minimum a course's world configuration can be: the schema declaration alone. Every block inside it
    // (today: the sun glare) is optional, because a course that authors none is the common case.
    const string MinimalWorld =
        """
        { "Schema": "openslope-world/v1" }
        """;

    // Every value is invented; the contract check is about shape and required fields, not any course's numbers.
    const string PopulatedWorld =
        """
        {
          "Schema": "openslope-world/v1",
          "Glare": {
            "Enabled": true,
            "CoreColour": [255, 128, 64],
            "FanIntensity": 0.25,
            "RimColour": [64, 128, 255],
            "SpriteIntensity": 0.5,
            "AzimuthDegrees": 45.0,
            "ElevationDegrees": 10.0,
            "DistanceUnits": 20000.0,
            "SizeUnits": 3000.0
          }
        }
        """;

    // The minimum a map origin can be: an authored mountain carrying nothing borrowed. Nothing here is
    // optional except `Course`, which only an extract has to name.
    const string MinimalOrigin =
        """
        {
          "Schema": "openslope-origin/v1",
          "Origin": "slopesmith",
          "RetailData": false,
          "Reasons": []
        }
        """;

    const string RetailExtractOrigin =
        """
        {
          "Schema": "openslope-origin/v1",
          "Origin": "retail",
          "Course": "GARI",
          "RetailData": true,
          "Reasons": ["retail-extract"]
        }
        """;

    // ContractKind is internal, and xunit only discovers public test classes, so the theories are keyed by
    // name and resolved through this table rather than taking the enum as a parameter.
    static readonly Dictionary<string, (ContractKind Kind, string Json)> Fixtures = new(StringComparer.Ordinal)
    {
        ["PatchesV1"] = (ContractKind.PatchesV1, MinimalPatches),
        ["SplinesV1"] = (ContractKind.SplinesV1, MinimalSplines),
        ["SoundIndexV1"] = (ContractKind.SoundIndexV1, MinimalSoundIndex),
        ["EnvironmentAudioV1"] = (ContractKind.EnvironmentAudioV1, MinimalEnvironmentAudio),
        ["BoardSoundIndexV1"] = (ContractKind.BoardSoundIndexV1, MinimalBoardSoundIndex),
        ["SkyRingV1"] = (ContractKind.SkyRingV1, MinimalSkyRing),
        ["BillboardsV1"] = (ContractKind.BillboardsV1, MinimalBillboards),
        ["PropOverrideV1"] = (ContractKind.PropOverrideV1, MinimalPropOverride),
        ["RepackManifestV1"] = (ContractKind.RepackManifestV1, MinimalRepackManifest),
        ["BundleManifestV3"] = (ContractKind.BundleManifestV3, MinimalBundleManifest),
        ["EffectsV1"] = (ContractKind.EffectsV1, MinimalEffects),
        ["WorldV1"] = (ContractKind.WorldV1, MinimalWorld),
        ["OriginV1"] = (ContractKind.OriginV1, MinimalOrigin),
    };

    public static TheoryData<string> ContractNames()
    {
        var data = new TheoryData<string>();
        foreach (string name in Fixtures.Keys) data.Add(name);
        return data;
    }

    [Fact]
    public void EveryContractKindHasAFixture()
    {
        // A new ContractKind with no fixture would silently sit outside every theory below.
        Assert.Equal(Enum.GetValues<ContractKind>().Length, Fixtures.Count);
    }

    [Theory]
    [MemberData(nameof(ContractNames))]
    public void AMinimalWellFormedDocumentIsAccepted(string name)
    {
        var (kind, json) = Fixtures[name];

        Contracts.RequireJson(json, kind, "fixture");
    }

    [Theory]
    [MemberData(nameof(ContractNames))]
    public void AnEmptyObjectIsRejectedForEveryKind(string name)
    {
        // Every schema has a required set; none of them should accept {}.
        var (kind, _) = Fixtures[name];

        Assert.Throws<ContractValidationException>(() => Contracts.RequireJson("{}", kind, "empty"));
    }

    [Theory]
    [MemberData(nameof(ContractNames))]
    public void MalformedJsonIsReportedAsSuchRatherThanCrashing(string name)
    {
        var (kind, _) = Fixtures[name];

        var error = Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson("{ not json", kind, "broken"));
        Assert.Contains("not valid JSON", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void TheRecordAnImportActuallyWritesSatisfiesTheSchema()
    {
        // Every other check here is against hand-written JSON, which proves what the schema accepts and says
        // nothing about what the producer emits. This is the object `import` serializes into the map folder: a
        // renamed property or a flipped default would pass all of them and still write a file that fails the
        // RequireFile immediately after it — at the end of an extraction, which is an expensive place to find out.
        string json = JsonConvert.SerializeObject(MapOrigin.ForRetailExtract("gari"), Formatting.Indented);

        Contracts.RequireJson(json, ContractKind.OriginV1, "MapOrigin.ForRetailExtract");
    }

    [Fact]
    public void AGlareRequiresBothRecoveredIntensityFields()
    {
        Contracts.RequireJson(PopulatedWorld, ContractKind.WorldV1, "complete glare");
        string noFan = PopulatedWorld.Replace("\"FanIntensity\": 0.25,", "");
        string noSprite = PopulatedWorld.Replace("\"SpriteIntensity\": 0.5,", "");

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(noFan, ContractKind.WorldV1, "old glare without fan intensity"));
        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(noSprite, ContractKind.WorldV1, "old glare without sprite intensity"));
    }

    [Fact]
    public void AnExtractedCourseOriginIsAccepted()
    {
        // The other half of the contract: `import` writes exactly this, and a schema that only accepted the
        // authored shape would fail every extraction rather than the one thing it is meant to catch.
        Contracts.RequireJson(RetailExtractOrigin, ContractKind.OriginV1, "extract");
    }

    [Fact]
    public void TheTwoRecordsABackfillWritesAreAccepted()
    {
        // Slopesmith's backfill (scripts/backfill-map-origins.ts) stamps folders that predate the contract, and
        // writes two shapes neither producer emits: an authored mountain that borrows art — authored, retail,
        // and with no slot to name — and a folder nothing identifies, which is retail with no Course either.
        // Both are legal and both are now on disk in real libraries, so both belong in the accepted set.
        string borrowedAuthored = MinimalOrigin
            .Replace("\"RetailData\": false", "\"RetailData\": true")
            .Replace("\"Reasons\": []", "\"Reasons\": [\"retail-sky-ring\"]");
        string unidentified = borrowedAuthored
            .Replace("\"slopesmith\"", "\"retail\"")
            .Replace("\"retail-sky-ring\"", "\"retail-unidentified-folder\"");

        Contracts.RequireJson(borrowedAuthored, ContractKind.OriginV1, "authored, borrowing");
        Contracts.RequireJson(unidentified, ContractKind.OriginV1, "unidentified folder");
    }

    [Fact]
    public void AMapOriginMustAgreeWithItselfAboutRetailData()
    {
        // The gate reads the boolean and shows the reasons. A record claiming data with nothing to point at,
        // or pointing at reasons while claiming none, is one no producer here wrote — and reading either as
        // "clean" would open the library on a typo.
        string noReason = RetailExtractOrigin.Replace("[\"retail-extract\"]", "[]");
        string noData = RetailExtractOrigin.Replace("\"RetailData\": true", "\"RetailData\": false");

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(noReason, ContractKind.OriginV1, "retail with no reason"));
        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(noData, ContractKind.OriginV1, "reasons with no retail data"));
    }

    [Fact]
    public void OnlyAnExtractNamesACourseSlot()
    {
        // An authored mountain has no slot until it is packed onto one, so a `Course` on one is a record built
        // by copying an extract's rather than by classifying anything.
        string authoredWithSlot = MinimalOrigin.TrimEnd().TrimEnd('}').TrimEnd()
            + ",\n  \"Course\": \"GARI\"\n}";

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(authoredWithSlot, ContractKind.OriginV1, "authored with a slot"));
    }

    [Fact]
    public void AMapOriginRejectsAnUnknownProducer()
    {
        string invented = MinimalOrigin.Replace("\"slopesmith\"", "\"somebody-else\"");

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(invented, ContractKind.OriginV1, "unknown origin"));
    }

    [Fact]
    public void TheBundleManifestVersionIsPinnedToThree()
    {
        // The importer branches on this. A v2 document reaching a v3 reader is the failure the const exists
        // to stop.
        string wrongVersion = MinimalBundleManifest.Replace("\"BundleVersion\": 3", "\"BundleVersion\": 2");

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(wrongVersion, ContractKind.BundleManifestV3, "v2"));
    }

    [Fact]
    public void TheBundleManifestAcceptsPositiveCourseCheckpointRecords()
    {
        string withCheckpoint = MinimalBundleManifest.TrimEnd().TrimEnd('}') + """
            , "Paths": {
                "Course": {
                  "Points": [[0, 0, 0], [100, 0, 0]], "Start": [0], "Count": [2],
                  "LineDtf": [100], "RaceLineCount": 1,
                  "Checkpoints": [{ "Position": [50, 0, 0], "Dtf": 50, "BonusSeconds": 150, "Group": 0 }],
                  "Gated": [], "Showoff": []
                }
              }
            }
            """;

        Contracts.RequireJson(withCheckpoint, ContractKind.BundleManifestV3, "checkpoint");
        string zeroBonus = withCheckpoint.Replace("\"BonusSeconds\": 150", "\"BonusSeconds\": 0");
        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(zeroBonus, ContractKind.BundleManifestV3, "zero checkpoint"));
    }

    [Fact]
    public void TheBundleManifestAcceptsOptionalPerRailStyles()
    {
        string withRailStyles = MinimalBundleManifest.TrimEnd().TrimEnd('}') + """
            , "Paths": {
                "Rails": {
                  "Points": [[0, 0, 0], [100, 0, 0]], "Start": [0], "Count": [2],
                  "Style": [5], "RaceLineCount": 0, "Gated": [], "Showoff": []
                }
              }
            }
            """;

        Contracts.RequireJson(withRailStyles, ContractKind.BundleManifestV3, "styled rail");

        string invalidStyle = withRailStyles.Replace("\"Style\": [5]", "\"Style\": [\"ice\"]");
        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(invalidStyle, ContractKind.BundleManifestV3, "named rail style"));
    }

    [Fact]
    public void ASoundIndexRequiresAnExplicitMapRelativeClip()
    {
        string unsafeClip = MinimalSoundIndex.Replace(
            "Audio/SFX/course-a/004.wav", "C:/retail/course-a/004.wav");

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(unsafeClip, ContractKind.SoundIndexV1, "unsafe clip"));
    }

    [Fact]
    public void TheBundleManifestRejectsAnUnknownTopLevelKey()
    {
        // additionalProperties is false throughout, so a typo'd section is caught at the boundary instead of
        // being silently dropped on the floor by the consumer.
        string extra = MinimalBundleManifest.TrimEnd().TrimEnd('}') + ", \"Partikles\": [] }";

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(extra, ContractKind.BundleManifestV3, "typo"));
    }

    [Fact]
    public void TheBundleManifestRejectsAnUnknownHandednessOrUpAxis()
    {
        string badHand = MinimalBundleManifest.Replace("\"Handed\": \"left\"", "\"Handed\": \"sideways\"");
        string badUp = MinimalBundleManifest.Replace("\"Up\": \"Y\"", "\"Up\": \"W\"");

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(badHand, ContractKind.BundleManifestV3, "hand"));
        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(badUp, ContractKind.BundleManifestV3, "up"));
    }

    [Fact]
    public void TheBundleManifestRejectsANonPositiveScale()
    {
        string zeroScale = MinimalBundleManifest.Replace("\"Scale\": 1.0", "\"Scale\": 0");

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(zeroScale, ContractKind.BundleManifestV3, "scale"));
    }

    [Fact]
    public void APatchMustCarryAllSixteenControlPoints()
    {
        // A bicubic patch with fifteen points is not a patch. The tessellator indexes cp[15] unconditionally.
        string fifteen = """
            {
              "Patches": [{
                "PatchName": "p0",
                "LightMapPoint": [0, 0, 1, 1],
                "UVPoints": [[0,0],[1,0],[0,1],[1,1]],
                "Points": [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],
                           [0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]],
                "SurfaceType": 0,
                "TrickOnlyPatch": false,
                "TexturePath": "t.png",
                "LightmapID": 0
              }]
            }
            """;

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(fifteen, ContractKind.PatchesV1, "short patch"));
    }

    [Fact]
    public void AFullyPopulatedPatchIsAccepted()
    {
        string sixteen = """
            {
              "Patches": [{
                "PatchName": "p0",
                "LightMapPoint": [0, 0, 1, 1],
                "UVPoints": [[0,0],[1,0],[0,1],[1,1]],
                "Points": [[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],
                           [0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0],[0,0,0]],
                "SurfaceType": 0,
                "TrickOnlyPatch": false,
                "TexturePath": "t.png",
                "LightmapID": 0
              }]
            }
            """;

        Contracts.RequireJson(sixteen, ContractKind.PatchesV1, "patch");
    }

    [Fact]
    public void ASplineSegmentMustCarryFourControlPoints()
    {
        string threePoints = """
            {
              "Splines": [{
                "SplineName": "rail0", "U0": 0, "U1": 0, "SplineStyle": 0,
                "Segments": [{ "Points": [[0,0,0],[1,0,0],[2,0,0]] }]
              }]
            }
            """;

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(threePoints, ContractKind.SplinesV1, "short segment"));
    }

    [Fact]
    public void APropOverrideNeedsAtLeastOneMesh()
    {
        Assert.Throws<ContractValidationException>(() => Contracts.RequireJson(
            """{ "match": "Mdl_Tree", "meshes": [] }""", ContractKind.PropOverrideV1, "no meshes"));
        Assert.Throws<ContractValidationException>(() => Contracts.RequireJson(
            """{ "match": "", "meshes": ["tree.obj"] }""", ContractKind.PropOverrideV1, "blank match"));
    }

    [Fact]
    public void APropOverrideOnlyAcceptsTheKnownAlphaModes()
    {
        Contracts.RequireJson(
            """{ "match": "m", "meshes": ["a.obj"], "alpha": { "0": "cutout" } }""",
            ContractKind.PropOverrideV1, "cutout");

        Assert.Throws<ContractValidationException>(() => Contracts.RequireJson(
            """{ "match": "m", "meshes": ["a.obj"], "alpha": { "0": "translucent" } }""",
            ContractKind.PropOverrideV1, "bad alpha"));
    }

    [Fact]
    public void APropOverrideKeysTextureSlotsByNumber()
    {
        Assert.Throws<ContractValidationException>(() => Contracts.RequireJson(
            """{ "match": "m", "meshes": ["a.obj"], "textures": { "trunk": "t.png" } }""",
            ContractKind.PropOverrideV1, "named slot"));
    }

    [Fact]
    public void ARepackManifestNeedsAtLeastOneLevel()
    {
        string noLevels = """
            { "InputIso": "clean.iso", "OutputIso": "out.iso", "Levels": [] }
            """;

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(noLevels, ContractKind.RepackManifestV1, "no levels"));
    }

    [Fact]
    public void AnEffectsDocumentIsPinnedToItsKindAndVersion()
    {
        string wrongKind = MinimalEffects.Replace("\"openslope-effects\"", "\"openslope-something-else\"");
        string wrongVersion = MinimalEffects.Replace("\"version\": 1", "\"version\": 2");

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(wrongKind, ContractKind.EffectsV1, "kind"));
        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(wrongVersion, ContractKind.EffectsV1, "version"));
    }

    [Fact]
    public void AnEffectsDocumentMustNameItsTarget()
    {
        string noLevel = MinimalEffects.Replace("""
            "target": { "game": "SSX Tricky", "platform": "PS2", "region": "NTSC", "level": "MYLEVEL" }
            """.Trim(), """
            "target": { "game": "SSX Tricky", "platform": "PS2", "region": "NTSC" }
            """.Trim());

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(noLevel, ContractKind.EffectsV1, "no level"));
    }

    [Fact]
    public void AScreenSetIsPinnedToItsProducerAndAGeometricallyRealRectangle()
    {
        // Source is what tells a hand-placed screen set from a detected one, which is the whole basis for the
        // detector leaving an authored document alone. A zero-sized screen is a degenerate fit that would
        // otherwise reach a consumer as an invisible quad.
        Contracts.RequireJson(PopulatedBillboards, ContractKind.BillboardsV1, "authored screens");

        string inventedSource = MinimalBillboards.Replace("\"detected\"", "\"guessed\"");
        string zeroWidth = PopulatedBillboards.Replace("\"Width\": 2000", "\"Width\": 0");
        string flatVector = PopulatedBillboards.Replace("\"Normal\": [0, -1, 0]", "\"Normal\": [0, -1]");
        string unnamed = PopulatedBillboards.Replace("\"Name\": \"Ad_A_1000\"", "\"Name\": \"\"");

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(inventedSource, ContractKind.BillboardsV1, "source"));
        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(zeroWidth, ContractKind.BillboardsV1, "width"));
        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(flatVector, ContractKind.BillboardsV1, "normal"));
        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(unnamed, ContractKind.BillboardsV1, "name"));
    }

    [Fact]
    public void RequireFileReportsAMissingDocumentByPath()
    {
        using var temp = new TempDir();
        string missing = Path.Combine(temp.Path, "Patches.json");

        var error = Assert.Throws<ContractValidationException>(
            () => Contracts.RequireFile(missing, ContractKind.PatchesV1));
        Assert.Contains("not found", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void RequireIfPresentSkipsADocumentThatIsNotThere()
    {
        using var temp = new TempDir();

        Contracts.RequireIfPresent(Path.Combine(temp.Path, "Patches.json"), ContractKind.PatchesV1);
    }

    [Fact]
    public void RequireIfPresentStillValidatesADocumentThatIs()
    {
        using var temp = new TempDir();
        string path = temp.Write("Patches.json", """{ "Patches": [{ "PatchName": "p" }] }""");

        Assert.Throws<ContractValidationException>(
            () => Contracts.RequireIfPresent(path, ContractKind.PatchesV1));
    }

    [Fact]
    public void TheFailureMessageNamesTheSchemaAndThePathThatBrokeIt()
    {
        // These messages are what someone reads when a repack fails at 2am; they have to identify the field.
        string badUp = MinimalBundleManifest.Replace("\"Up\": \"Y\"", "\"Up\": \"W\"");

        var error = Assert.Throws<ContractValidationException>(
            () => Contracts.RequireJson(badUp, ContractKind.BundleManifestV3, "Maps/X/gltf/manifest.json"));

        Assert.Contains("Maps/X/gltf/manifest.json", error.Message, StringComparison.Ordinal);
        Assert.Contains("bundle-manifest-v3.schema.json", error.Message, StringComparison.Ordinal);
        Assert.Contains("/Space/Up", error.Message, StringComparison.Ordinal);
    }
}
