using System.Globalization;
using System.Numerics;
using System.Text;
using Newtonsoft.Json.Linq;
using Snowknife.Bundle;
using Snowknife.Export;
using Snowknife.Services;

namespace Snowknife.Tests.Export;

/// <summary>
/// The billboard screen detector, over synthetic boards rather than a disc: a board is an ad panel on one
/// texture page with a structural slab welded behind it, which is the shape every gate here exists for.
/// Geometry is written in SSX mesh space (centimetres, Z up) through <see cref="Board"/>, which negates X on
/// the way into the OBJ exactly as <c>PropsExporter</c> does.
/// </summary>
public class BillboardsExporterTests
{
    [Fact]
    public void AnAdFaceIsSizedToItsPageAndTurnedToTheOpenSide()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_Billboard_Ad_A_1000");
        // The ad face: one full showing of page 0031, 20 x 8 m, wound TOWARD its own backing so the fit has to
        // flip it. Its normal is what a video would be laid along.
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f);
        // The structural slab 1.5 m behind it: a tiled page, so the UV gate rejects it as an ad, and the
        // geometry the open-side test weighs.
        board.Material("mat_1");
        board.Quad(new Vector3(-400, 150, 700), new Vector3(-400, 150, 1100),
                   new Vector3(400, 150, 1100), new Vector3(400, 150, 700), uvSpan: 4f);
        board.Write(temp, materials: new[] { "0031.png", "0016.png" });

        var screens = BillboardsExporter.Detect(temp.Path).Screens;

        var screen = Assert.Single(screens);
        Assert.Equal("Ad_A_1000", screen.Name);
        Assert.Equal("Ad_A", screen.Family);
        Assert.Equal("0031", screen.Page);
        Assert.Equal(0, screen.Instance);
        Assert.Equal(2000f, screen.Width, 1f);
        Assert.Equal(800f, screen.Height, 1f);
        // Sat 0.1 m proud of the face, looking away from the slab behind it.
        AssertVector(new Vector3(0f, -10f, 900f), screen.Center, 1f);
        AssertVector(new Vector3(0f, -1f, 0f), screen.Normal, 0.001f);
        AssertVector(new Vector3(0f, 0f, 1f), screen.Up, 0.001f);
    }

    [Fact]
    public void AnAuthoredNormalDefinesTheReadableSideEvenWhenNearbyGeometryMisleads()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_Billboard_Ad_A_1000");
        // X reflection reverses geometric winding in mesh space, but the signed vn stream preserves the
        // authored/readable side. Put structural geometry on that side to prove it cannot flip the texture.
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f,
                   authoredNormal: new Vector3(0f, -1f, 0f));
        board.Material("mat_1");
        board.Quad(new Vector3(-400, -150, 700), new Vector3(-400, -150, 1100),
                   new Vector3(400, -150, 1100), new Vector3(400, -150, 700), uvSpan: 4f);
        board.Write(temp, materials: new[] { "0031.png", "0016.png" });

        var screen = Assert.Single(BillboardsExporter.Detect(temp.Path).Screens);

        AssertVector(new Vector3(0f, -10f, 900f), screen.Center, 1f);
        AssertVector(new Vector3(0f, -1f, 0f), screen.Normal, 0.001f);
    }

    [Fact]
    public void AnOppositeFacingStandMaterialIsNotMistakenForASecondAdFace()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_Billboard_AlaskaLogo_1000");
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f);
        // A nearby structural face passes the ordinary ad UV/area gates and faces the course. It is not the
        // back of the display because it draws a different material/page, so it must not replace mat_0.
        board.Material("mat_1");
        board.Quad(new Vector3(600, 20, 500), new Vector3(600, 20, 1300),
                   new Vector3(-600, 20, 1300), new Vector3(-600, 20, 500), uvSpan: 1f);
        board.Write(temp, materials: new[] { "0031.png", "0016.png" });
        board.Course(temp, new Vector3(0f, -1000f, 900f));

        var screen = Assert.Single(BillboardsExporter.Detect(temp.Path).Screens);

        Assert.Equal("0031", screen.Page);
        Assert.Equal(2000f, screen.Width, 1f);
    }

    [Fact]
    public void ADoubleSidedBoardChoosesTheReadablePhysicalFaceTowardTheCourse()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_Billboard_HorizA_1002");
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f,
                   authoredNormal: new Vector3(0f, -1f, 0f));
        board.Quad(new Vector3(1000, 20, 500), new Vector3(1000, 20, 1300),
                   new Vector3(-1000, 20, 1300), new Vector3(-1000, 20, 500), uvSpan: 1f,
                   authoredNormal: new Vector3(0f, 1f, 0f));
        board.Write(temp, materials: new[] { "0031.png" });
        board.Course(temp, new Vector3(0f, -1000f, 900f));

        var screen = Assert.Single(BillboardsExporter.Detect(temp.Path).Screens);

        AssertVector(new Vector3(0f, -10f, 900f), screen.Center, 1f);
        AssertVector(new Vector3(0f, -1f, 0f), screen.Normal, 0.001f);
    }

    [Fact]
    public void ANearbyCourseCanExposeTheOtherSideOfAnUnbackedPanel()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_Billboard_Ad_A_1000");
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f,
                   authoredNormal: new Vector3(0f, -1f, 0f));
        board.Write(temp, materials: new[] { "0031.png" });
        board.Course(temp, new Vector3(0f, 1000f, 900f));

        var screen = Assert.Single(BillboardsExporter.Detect(temp.Path).Screens);

        AssertVector(new Vector3(0f, 10f, 900f), screen.Center, 1f);
        AssertVector(new Vector3(0f, 1f, 0f), screen.Normal, 0.001f);
    }

    [Theory]
    [InlineData("Mdl_Jumbotron_Top_1001", "Jumbotron_Top_1001", "Jumbotron_Top")]
    [InlineData("Mdl_Jumbotron_SnowDreamTop_1001", "Jumbotron_SnowDreamTop_1001", "Jumbotron_SnowDreamTop")]
    public void AJumbotronAcceptsAScrollingScreenSlotWithUntiledUvs(string instanceName, string expectedName,
                                                                    string expectedFamily)
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, instanceName);
        board.Material("mat_0_scr3");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 2500),
                   new Vector3(1000, 0, 2500), new Vector3(1000, 0, 500), uvSpan: 1f,
                   authoredNormal: new Vector3(0f, -1f, 0f));
        board.Material("mat_1");
        // This nearer group clears the total area gate but splits into four cells narrower than MinSize. The
        // ad pass must continue past it rather than letting it suppress the coherent auxiliary panel.
        for (int x = -700; x <= 500; x += 400)
            board.Quad(new Vector3(x, 200, 500), new Vector3(x, 200, 1300),
                       new Vector3(x + 250, 200, 1300), new Vector3(x + 250, 200, 500), uvSpan: 1f);
        board.Material("mat_2");
        board.Quad(new Vector3(-1000, 500, 500), new Vector3(-1000, 500, 1300),
                   new Vector3(1000, 500, 1300), new Vector3(1000, 500, 500), uvSpan: 1f);
        board.Write(temp, materials: new[] { "0035.png", "0016.png", "0031.png" });
        board.Course(temp, new Vector3(0f, -1000f, 1500f));

        var screens = BillboardsExporter.Detect(temp.Path).Screens;
        Assert.Equal(2, screens.Count);
        var screen = Assert.Single(screens, s => s.Family == expectedFamily);

        Assert.Equal(expectedName, screen.Name);
        Assert.Equal(expectedFamily, screen.Family);
        Assert.Equal("0035", screen.Page);
        Assert.Equal(2000f, screen.Height, 1f);
        Assert.Equal("0031", Assert.Single(screens, s => s.Family == expectedFamily + "_Ad").Page);
    }

    [Fact]
    public void AnEaBigTopAcceptsItsHalfHeightAtlasStrip()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_Billboard_EABig_Top_1001");
        board.Material("mat_0");
        board.Quad(new Vector3(-950, 0, 500), new Vector3(-950, 0, 1200),
                   new Vector3(950, 0, 1200), new Vector3(950, 0, 500), uvSpan: 0.5f, uvSpanV: 0.25f);
        board.Write(temp, materials: new[] { "0031.png" });

        var screen = Assert.Single(BillboardsExporter.Detect(temp.Path).Screens);

        Assert.Equal("EABig_Top_1001", screen.Name);
        Assert.Equal(1900f, screen.Width, 1f);
        Assert.Equal(700f, screen.Height, 1f);
    }

    [Theory]
    [InlineData("Mdl_Billboard_Ad_I_1000", "Ad_I_1000", "Ad_I")]
    [InlineData("Mdl_Billboard_Ad_R_6000", "Ad_R_6000", "Ad_R")]
    public void AOneLetterAdFamilyIsDiscoveredAndPreserved(string instanceName, string expectedName,
                                                            string expectedFamily)
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, instanceName);
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f);
        board.Write(temp, materials: new[] { "0031.png" });

        var screen = Assert.Single(BillboardsExporter.Detect(temp.Path).Screens);

        Assert.Equal(expectedName, screen.Name);
        Assert.Equal(expectedFamily, screen.Family);
    }

    [Theory]
    [InlineData("Mdl_Billboard_AlaskaLogo_1000", "AlaskaLogo")]
    [InlineData("Mdl_Billboard_HorizA_2001", "HorizA")]
    [InlineData("Mdl_Billboard_HorizA_ShortcutRailslide2001_0", "HorizA_ShortcutRailslide2001")]
    [InlineData("Mdl_Billboard_HorizC_2001", "HorizC")]
    [InlineData("Mdl_Billboard_MercuryLogo_2000", "MercuryLogo")]
    [InlineData("Mdl_Billboard_SnowDreamLogo_1000", "SnowDreamLogo")]
    [InlineData("Mdl_Billboard_AfroSlide_2000", "AfroSlide")]
    public void ACourseSpecificAdFamilyIsAdmitted(string instanceName, string expectedFamily)
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, instanceName);
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f);
        board.Write(temp, materials: new[] { "0031.png" });

        var screen = Assert.Single(BillboardsExporter.Detect(temp.Path).Screens);

        Assert.Equal(expectedFamily, screen.Family);
    }

    [Theory]
    [InlineData("Mdl_Billboard_Ad1_1000")]
    [InlineData("Mdl_Billboard_Adimpact_1000")]
    [InlineData("Mdl_Billboard_Ad_Ice_1000")]
    [InlineData("Mdl_Billboard_Event5_3")]
    public void SimilarNamesThatAreNotOneLetterAdPanelsStayExcluded(string instanceName)
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, instanceName);
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f);
        board.Write(temp, materials: new[] { "0031.png" });

        Assert.Empty(BillboardsExporter.Detect(temp.Path).Screens);
    }

    [Fact]
    public void AStackOfCoplanarBoardsBecomesOneScreenEach()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_Billboard_Ad_A_1000");
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f);
        board.Quad(new Vector3(-1000, 0, 1500), new Vector3(-1000, 0, 2300),
                   new Vector3(1000, 0, 2300), new Vector3(1000, 0, 1500), uvSpan: 1f);
        board.Write(temp, materials: new[] { "0031.png" });

        var screens = BillboardsExporter.Detect(temp.Path).Screens;

        // One 24 m blob would be the failure: the 2 m gap between the panels is what separates them.
        Assert.Equal(2, screens.Count);
        Assert.Equal(new[] { "Ad_A_1000_0", "Ad_A_1000_1" }, screens.Select(s => s.Name));
        Assert.All(screens, s => Assert.Equal(800f, s.Height, 1f));
        Assert.Equal(new[] { 900f, 1900f }, screens.Select(s => s.Center[2]).Order().ToArray());
    }

    [Fact]
    public void ANearbyInstancesFaceDoesNotBecomeAnExtraCell()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_Billboard_Ad_B_1000");
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f);
        board.Instance(1, "Mdl_RockBoulder_1000");
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 1500), new Vector3(-1000, 0, 2300),
                   new Vector3(1000, 0, 2300), new Vector3(1000, 0, 1500), uvSpan: 1f);
        board.Write(temp, materials: new[] { "0031.png" });

        var screen = Assert.Single(BillboardsExporter.Detect(temp.Path).Screens);

        Assert.Equal("Ad_B_1000", screen.Name);
        Assert.Equal(900f, screen.Center[2], 1f);
    }

    [Theory]
    [InlineData("Mdl_Finish_Screen_0", "Finish_Screen_0", "Finish_Screen")]
    [InlineData("Mdl_Finish_Screen_5000", "Finish_Screen_5000", "Finish_Screen")]
    [InlineData("Mdl_Finsh_Screen_7000", "Finsh_Screen_7000", "Finsh_Screen")]
    public void AFinishScreenIsFoundFromItsOwnOffsetGeometry(string instanceName, string expectedName,
                                                              string expectedFamily)
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, instanceName);
        board.Material("mat_0");
        // The retail finish-screen mesh can sit well beyond the ordinary 18 m column around its stage origin,
        // and its two shallow-angled halves must become one full-width player rather than one half-screen.
        board.Quad(new Vector3(-1000, 3000, 500), new Vector3(-1000, 3000, 1900),
                   new Vector3(0, 3100, 1900), new Vector3(0, 3100, 500), uvSpan: 0.7f,
                   authoredNormal: new Vector3(0f, -1f, 0f));
        board.Quad(new Vector3(0, 3100, 500), new Vector3(0, 3100, 1900),
                   new Vector3(1000, 3000, 1900), new Vector3(1000, 3000, 500), uvSpan: 0.7f,
                   authoredNormal: new Vector3(0f, -1f, 0f));
        board.Write(temp, materials: new[] { "0031.png" });

        var screen = Assert.Single(BillboardsExporter.Detect(temp.Path).Screens);

        Assert.Equal(expectedName, screen.Name);
        Assert.Equal(expectedFamily, screen.Family);
        Assert.InRange(screen.Width, 1900f, 2100f);
        Assert.Equal(1400f, screen.Height, 1f);
    }

    [Fact]
    public void ACrowdPageIsNeverAScreen()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_Billboard_Ad_A_1000");
        // A spectator flip-book cell passes the UV and area gates on its own, so a board standing in a crowd
        // with no ad face of its own would grab a crowd quad if the page weren't blocked outright.
        board.Material("mat_crowd_c00");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f);
        board.Write(temp, materials: new[] { "cd00.png" });

        Assert.Empty(BillboardsExporter.Detect(temp.Path).Screens);
    }

    [Fact]
    public void AFaceTooSmallToBeAnAdIsIgnored()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_Billboard_Ad_A_1000");
        board.Material("mat_0");   // 4 x 2 m: a UV-passing sliver, well under a real ad face
        board.Quad(new Vector3(-200, 0, 500), new Vector3(-200, 0, 700),
                   new Vector3(200, 0, 700), new Vector3(200, 0, 500), uvSpan: 1f);
        board.Write(temp, materials: new[] { "0031.png" });

        Assert.Empty(BillboardsExporter.Detect(temp.Path).Screens);
    }

    [Fact]
    public void APropThatIsNoBillboardFamilyIsNotSearched()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_RockBoulder_AlpsC_1000");
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f);
        board.Write(temp, materials: new[] { "0031.png" });

        Assert.Empty(BillboardsExporter.Detect(temp.Path).Screens);
    }

    [Fact]
    public void AnAuthoredDocumentSurvivesADetectorRun()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_Billboard_Ad_A_1000");
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f);
        board.Write(temp, materials: new[] { "0031.png" });

        string authored = new JObject
        {
            ["Schema"] = BillboardsDocument.SchemaId,
            ["Source"] = BillboardsDocument.AuthoredSource,
            ["Screens"] = new JArray(new JObject
            {
                ["Name"] = "HandPlaced",
                ["Center"] = new JArray(1f, 2f, 3f),
                ["Normal"] = new JArray(0f, -1f, 0f),
                ["Up"] = new JArray(0f, 0f, 1f),
                ["Width"] = 400f,
                ["Height"] = 300f,
            }),
        }.ToString();
        string path = temp.Write(BillboardsDocument.FileName, authored);
        var contracts = new ContractValidationService();

        Assert.Equal(0, BillboardsExporter.Export(temp.Path, contracts));
        Assert.Equal(authored, File.ReadAllText(path));   // the author's screens are theirs, not the detector's

        // --force is the way through, and what it writes is a detected document.
        Assert.Equal(0, BillboardsExporter.Export(temp.Path, contracts, force: true));
        var rewritten = BillboardsDocument.Load(temp.Path)!;
        Assert.Equal(BillboardsDocument.DetectedSource, rewritten.Source);
        Assert.Equal("Ad_A_1000", Assert.Single(rewritten.Screens).Name);
    }

    [Fact]
    public void TheWrittenDocumentMatchesItsContractAndReachesTheManifest()
    {
        using var temp = new TempDir();
        var board = new Board();
        board.Instance(0, "Mdl_Billboard_Ad_A_1000");
        board.Material("mat_0");
        board.Quad(new Vector3(-1000, 0, 500), new Vector3(-1000, 0, 1300),
                   new Vector3(1000, 0, 1300), new Vector3(1000, 0, 500), uvSpan: 1f);
        board.Write(temp, materials: new[] { "0031.png" });

        // Export validates against billboards-v1 as it writes, so a shape the schema rejects fails here.
        Assert.Equal(0, BillboardsExporter.Export(temp.Path, new ContractValidationService()));

        var info = BillboardBundle.Build(temp.Path);
        var screen = Assert.Single(info!.Screens);
        Assert.Equal("Ad_A_1000", screen.Name);
        Assert.Equal(2000f, screen.Width, 1f);
    }

    [Fact]
    public void RepeatedScreenNamesAreMadeUniqueForTheManifest()
    {
        using var temp = new TempDir();
        // Consumers flatten every family into one container and name objects after the record, so two screens
        // answering to one name would collide there.
        temp.Write(BillboardsDocument.FileName, new JObject
        {
            ["Schema"] = BillboardsDocument.SchemaId,
            ["Source"] = BillboardsDocument.AuthoredSource,
            ["Screens"] = new JArray(Authored("Wall"), Authored("Wall"), Authored("Wall")),
        }.ToString());

        var info = BillboardBundle.Build(temp.Path);

        Assert.Equal(new[] { "Wall", "Wall_2", "Wall_3" }, info!.Screens.Select(s => s.Name));

        static JObject Authored(string name) => new()
        {
            ["Name"] = name,
            ["Center"] = new JArray(0f, 0f, 0f),
            ["Normal"] = new JArray(0f, -1f, 0f),
            ["Up"] = new JArray(0f, 0f, 1f),
            ["Width"] = 400f,
            ["Height"] = 300f,
        };
    }

    static void AssertVector(Vector3 expected, float[] actual, float tolerance)
    {
        Assert.Equal(3, actual.Length);
        Assert.Equal(expected.X, actual[0], tolerance);
        Assert.Equal(expected.Y, actual[1], tolerance);
        Assert.Equal(expected.Z, actual[2], tolerance);
    }

    /// <summary>
    /// A synthetic <c>Props.obj</c> + <c>Instances.json</c> + <c>Materials.json</c> map folder. Quads are given
    /// in mesh space and written with X negated, the way the real prop bake stores them; each carries one
    /// showing of its page scaled by <c>uvSpan</c>, so a tiled structural face is one argument away.
    /// </summary>
    sealed class Board
    {
        readonly StringBuilder _obj = new();
        readonly JArray _instances = new();
        int _vertices, _uvs, _normals;

        public void Instance(int index, string name)
        {
            _obj.Append(CultureInfo.InvariantCulture, $"o inst{index}_{name}\n");
            _instances.Add(new JObject
            {
                ["InstanceName"] = name,
                ["Location"] = new JArray(0f, 0f, 0f),
                ["Visable"] = true,
            });
        }

        public void Material(string slot) => _obj.Append(CultureInfo.InvariantCulture, $"usemtl {slot}\n");

        public void Quad(Vector3 a, Vector3 b, Vector3 c, Vector3 d, float uvSpan,
                         Vector3? authoredNormal = null, float? uvSpanV = null)
        {
            foreach (var corner in new[] { a, b, c, d })
                _obj.Append(CultureInfo.InvariantCulture, $"v {-corner.X} {corner.Y} {corner.Z}\n");
            float vSpan = uvSpanV ?? uvSpan;
            foreach (var uv in new[] { (0f, 0f), (0f, vSpan), (uvSpan, vSpan), (uvSpan, 0f) })
                _obj.Append(CultureInfo.InvariantCulture, $"vt {uv.Item1} {uv.Item2}\n");
            int normal = -1;
            if (authoredNormal is Vector3 n)
            {
                normal = _normals + 1;
                // Quad arguments are mesh-space; Props.obj stores raw SSX, whose X is mirrored.
                _obj.Append(CultureInfo.InvariantCulture, $"vn {-n.X} {n.Y} {n.Z}\n");
                _normals++;
            }
            int v = _vertices + 1, t = _uvs + 1;
            string Corner(int vi, int ti) => normal < 0 ? $"{vi}/{ti}" : $"{vi}/{ti}/{normal}";
            _obj.Append(CultureInfo.InvariantCulture,
                $"f {Corner(v, t)} {Corner(v + 1, t + 1)} {Corner(v + 2, t + 2)}\n");
            _obj.Append(CultureInfo.InvariantCulture,
                $"f {Corner(v, t)} {Corner(v + 2, t + 2)} {Corner(v + 3, t + 3)}\n");
            _vertices += 4;
            _uvs += 4;
        }

        public void Write(TempDir temp, string[] materials)
        {
            temp.Write("Props.obj", _obj.ToString());
            temp.Write("Instances.json", new JObject { ["Instances"] = _instances }.ToString());
            temp.Write("Materials.json", new JObject
            {
                ["Materials"] = new JArray(materials.Select(m => new JObject { ["TexturePath"] = m })),
            }.ToString());
        }

        public void Course(TempDir temp, Vector3 point)
        {
            // PathPos is raw SSX space (X mirrored); two zero deltas are enough to make it a valid centreline.
            temp.Write("AIP.json", new JObject
            {
                ["AIPaths"] = new JArray(new JObject
                {
                    ["Name"] = "test",
                    ["Respawnable"] = true,
                    ["PathPos"] = new JArray(-point.X, point.Y, point.Z),
                    ["PathPoints"] = new JArray(new JArray(0f, 0f, 0f), new JArray(0f, 0f, 0f)),
                }),
            }.ToString());
        }
    }
}
