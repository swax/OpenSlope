using System.Numerics;
using Newtonsoft.Json.Linq;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Snowknife.Services;
using SSXLibrary.FileHandlers.LevelFiles.SSX3PS2;
using SSXLibrary.FileHandlers.LevelFiles.SSX3PS2.SSBData;

namespace Snowknife.Tests.Formats;

/// <summary>
/// The SSX 3 world readers, on synthetic bytes: the SSB's RefPack block stream, the AIP layout, and the lightmap
/// re-encoding that puts SSX 3's full-range lighting on Tricky's half-bright scale.
/// </summary>
public class Ssx3WorldTests
{
    static byte[] Resource(int type, int track, int rid, byte[] payload)
    {
        var bytes = new List<byte>
        {
            (byte)type, (byte)payload.Length, (byte)(payload.Length >> 8), (byte)(payload.Length >> 16),
            (byte)track, (byte)rid, (byte)(rid >> 8), (byte)(rid >> 16),
        };
        bytes.AddRange(payload);
        return bytes.ToArray();
    }

    static void Block(Stream ssb, string magic, byte[] raw)
    {
        byte[] packed = new RefpackService().Compress(raw);
        ssb.Write(System.Text.Encoding.ASCII.GetBytes(magic));
        ssb.Write(BitConverter.GetBytes(packed.Length + 8));
        ssb.Write(packed);
    }

    [Fact]
    public void RefPackDecodeInvertsTheRepackCompressor()
    {
        var random = new Random(3);
        byte[] raw = new byte[20000];
        for (int i = 0; i < raw.Length; i++) raw[i] = (byte)(i % 97 < 60 ? i % 13 : random.Next(256));

        using var dir = new TempDir();
        string path = Path.Combine(dir.Path, "bam.ssb");
        using (var ssb = File.Create(path)) Block(ssb, "CEND", Resource(1, 8, 494, raw));
        var sdb = new SDBHandler();
        sdb.streamingChunkInfos.Add(new() { numResources = 1 });
        sdb.Save(Path.ChangeExtension(path, ".sdb"));

        Assert.Equal(raw, Assert.Single(SSBHandler.ReadResources(path)).Data);
    }

    // [Trailmap: 510-ssb]
    [Fact]
    public void AStreamingBlockSpansItsRefPackChunksUntilCend()
    {
        // One block split mid-resource across a CBXS and its CEND, then a second block: resources are framed
        // only after CEND, so the split must not cut the patch in two.
        byte[] patch = Enumerable.Range(0, 300).Select(i => (byte)i).ToArray();
        byte[] first = [.. Resource(1, 8, 494, patch), .. Resource(9, 0, 12, [1, 2, 3, 4])];
        byte[] second = Resource(14, 8, 0, [5, 6, 7, 8, 9, 10, 11, 12]);
        using var dir = new TempDir();
        string path = Path.Combine(dir.Path, "bam.ssb");
        using (var ssb = File.Create(path))
        {
            Block(ssb, "CBXS", first[..150]);
            Block(ssb, "CEND", first[150..]);
            ssb.Position = 1024; // Chunks need not be physically adjacent.
            Block(ssb, "CEND", second);
        }
        var sdb = new SDBHandler();
        sdb.streamingChunkInfos.Add(new() { numResources = 2 });
        sdb.streamingChunkInfos.Add(new() { numResources = 1, chunkOffset = 4 });
        sdb.Save(Path.ChangeExtension(path, ".sdb"));

        var resources = SSBHandler.ReadResources(path).ToList();

        Assert.Equal(3, resources.Count);
        Assert.Equal((1, 8, 494, 0), (resources[0].Type, resources[0].Track, resources[0].Rid, resources[0].StreamingChunkId));
        Assert.Equal(patch, resources[0].Data);
        Assert.Equal((9, 0, 12, 0), (resources[1].Type, resources[1].Track, resources[1].Rid, resources[1].StreamingChunkId));
        Assert.Equal((14, 8, 0, 1), (resources[2].Type, resources[2].Track, resources[2].Rid, resources[2].StreamingChunkId));
        Assert.Equal(8, resources[2].Data.Length);
    }

    // [Trailmap: 514-path-slots, 514-start-slots]
    [Fact]
    public void AnAipPathPreservesDirectionsLengthsEventsAndGrid()
    {
        var ms = new MemoryStream();
        var w = new BinaryWriter(ms);
        void Vec(float x, float y, float z) { w.Write(x); w.Write(y); w.Write(z); }
        w.Write(0x1234);                                   // magic
        w.Write(1);                                        // one AI path
        for (int i = 0; i < 7; i++) w.Write(i);            // its flags
        w.Write(2); w.Write(1);                            // two steps, one event
        Vec(100, 200, 300); Vec(0, 0, 0); Vec(1, 1, 1);    // start, bounds
        Vec(1, 0, 0); w.Write(50f);                        // direction, length
        Vec(0, -1, 0); w.Write(25f);
        w.Write(100); w.Write(930); w.Write(10f); w.Write(20f);
        w.Write(1);                                        // one track path
        w.Write(1); w.Write(0); w.Write(4); w.Write(372267f); // a race line and its distance to the finish
        w.Write(1); w.Write(0);
        Vec(-5, -6, -7); Vec(0, 0, 0); Vec(0, 0, 0);
        Vec(0, 0, -1); w.Write(10f);
        w.Write(2); w.Write(0L); w.Write(0L);              // two unread pairs
        w.Write(1);                                        // one grid slot
        w.Write(2); w.Write(3); Vec(7, 8, 9); Vec(-1, 0, 0); w.Write(0); w.Write(0);

        var aip = new WorldAIP();
        aip.LoadData(ms.ToArray());

        var path = Assert.Single(aip.aiPaths);
        Assert.Equal(new Vector3(100, 200, 300), path.PathPos);
        Assert.Equal([new Vector4(1, 0, 0, 50), new Vector4(0, -1, 0, 25)], path.VectorPoints);
        var ev = Assert.Single(path.PathEvents);
        Assert.Equal((100, 930, 10f, 20f), (ev.EventType, ev.EventValue, ev.EventStart, ev.EventEnd));
        var race = Assert.Single(aip.trackPaths);
        Assert.Equal((1, 372267f), (race.Type, race.U2));
        Assert.Equal(new Vector4(0, 0, -1, 10), Assert.Single(race.VectorPoints));
        Assert.Equal(new Vector3(7, 8, 9), Assert.Single(aip.u1Structs).U2);

        // Reusing the public handler for a header-only event must clear the preceding event.
        aip.LoadData(new byte[8]);
        Assert.Empty(aip.aiPaths);
        Assert.Empty(aip.trackPaths);
        Assert.Empty(aip.u0Structs);
        Assert.Empty(aip.u1Structs);
        Assert.Equal((0, 0, 0, 0), (aip.NumAIPaths, aip.NumTrackPaths, aip.NumU0, aip.NumU1));
    }

    // [Trailmap: 514-path-slots]
    [Theory]
    [InlineData(0)]
    [InlineData(8)]
    public void AnEventWithoutAiReadsAsEmpty(int length)
    {
        var aip = new WorldAIP();
        aip.LoadData(new byte[length]);

        Assert.Empty(aip.aiPaths);
        Assert.Empty(aip.trackPaths);
    }

    // [Trailmap: 514-path-slots, 514-peak-coverage]
    [Fact]
    public void TheAiNetworkListsTheCourseFirstThenEverySectionsPathsTopDown()
    {
        static WorldAIP Aip(params float[] heights) => new()
        {
            aiPaths = heights.Select(z => new WorldAIP.AIPath { PathPos = new Vector3(0, 0, z) }).ToList(),
        };
        var peakRace = Aip(900, 500);
        var (paths, coursePaths) = Ssx3Service.AiNetwork(
            [(0, peakRace)],
            [(0, Aip(800)), (3, Aip(100, 700)), (4, Aip()), (5, Aip(950))]);

        Assert.Equal(2, coursePaths);
        Assert.Equal([0, 0, 5, 0, 3, 3], paths.Select(n => n.Section));
        Assert.Equal([900f, 500, 950, 800, 700, 100], paths.Select(n => n.Path.PathPos.Z));
    }

    /// <summary>Slopesmith's sampleTile along one axis: the cell's first texel centre to its last.</summary>
    static float CentreLookup(Image<Rgba32> page, float start, float width, float u)
    {
        int bx = (int)MathF.Round(start * 128), tw = Math.Max(1, (int)MathF.Round(width * 128) - 1);
        float fx = u * tw;
        int ix = Math.Clamp((int)MathF.Floor(fx), 0, tw - 1);
        return page[bx + ix, 0].A + (page[bx + ix + 1, 0].A - page[bx + ix, 0].A) * (fx - ix);
    }

    // [Trailmap: 511-lm-slots, 511-lm-edges]
    [Theory]
    [InlineData(32)]
    [InlineData(64)]
    [InlineData(128)]
    public void ACentreLookupOnTheResampledPageReadsTheCellEdgeToEdge(int size)
    {
        // SSX 3 puts a patch corner on its cell's outer texel edge, where the GS blends the texels either side.
        var random = new Random(size);
        byte[] column = Enumerable.Range(0, size).Select(_ => (byte)random.Next(256)).ToArray();
        using var source = new Image<Rgba32>(size, 4);
        for (int x = 0; x < size; x++) for (int y = 0; y < 4; y++) source[x, y] = new Rgba32(0, 0, 0, column[x]);
        float[] cell = [5f / size, 0, 6f / size, 6f / size];

        using var page = Ssx3Service.ToCentreAddressed(source);
        float[] wide = Ssx3Service.CentreAddressedCell(cell);

        Assert.Equal((128, 128), (page.Width, page.Height));
        Assert.InRange(CentreLookup(page, wide[0], wide[2], 0) - (column[4] + column[5]) / 2f, -1, 1);
        Assert.InRange(CentreLookup(page, wide[0], wide[2], 1) - (column[10] + column[11]) / 2f, -1, 1);
        Assert.InRange(CentreLookup(page, wide[0], wide[2], 0.5f) - (column[7] + column[8]) / 2f, -1, 1);
    }

    static Image<Rgba32> AlphaPage(params (int share, byte alpha)[] bands)
    {
        var image = new Image<Rgba32>(100, 1);
        int x = 0;
        foreach (var (share, alpha) in bands)
            for (int i = 0; i < share; i++) image[x++, 0] = new Rgba32(200, 210, 220, alpha);
        return image;
    }

    // [Trailmap: 512-terrain-mask, 512-cutout]
    [Theory]
    [InlineData(70, 30, 0, false)]   // an ice streak's gloss mask: clear, then faint (texture 376)
    [InlineData(40, 59, 1, false)]   // a mask that merely looks binary, with a speck of solid (texture 653)
    [InlineData(0, 0, 100, false)]   // ordinary opaque snow
    [InlineData(33, 15, 52, true)]   // the trusses on EBA3's metal ramp (texture 307)
    public void OnlyARealHoleMaskKeepsItsAlphaOnTerrain(int clear, int faint, int solid, bool holes)
    {
        using var page = AlphaPage((clear, 0), (faint, 40), (solid, 255));

        Assert.Equal(holes, Ssx3Service.IsHoleMask(page));
    }

    // [Trailmap: 512-terrain-mask]
    [Fact]
    public void AnOpaquePageKeepsItsColourAndLosesOnlyItsAlpha()
    {
        using var page = AlphaPage((50, 0), (50, 3));

        Ssx3Service.MakeOpaque(page);

        Assert.All(Enumerable.Range(0, 100), x => Assert.Equal(new Rgba32(200, 210, 220, 255), page[x, 0]));
    }

    // [Trailmap: 513-helpers, 513-helper-proxies]
    [Theory]
    [InlineData("mdl_ABA1_FreeRideState_0", true, false, false)]          // the orange page alone hides it
    [InlineData("mdl_ABA1_EZseqTrig_1000", false, false, false)]          // a trigger on a borrowed page
    [InlineData("mdl_B_BHP1_Unload_0", false, false, false)]
    [InlineData("mdl_ABA1_reset_plane_3", true, false, false)]            // a wall only with its effect
    [InlineData("mdl_ARA1_startmode_collide_0", true, false, false)]      // a gate shut only during the event
    [InlineData("mdl_ARA1_fcollision_s1_14", true, false, true)]          // the invisible course fences block
    [InlineData("mdl_DRA4_fencing_collision_2", false, false, true)]
    [InlineData("mdl_B_collision_fence_nis_1", true, false, false)]       // a cutscene's fence
    [InlineData("mdl_CBA2_fenceb_startright_1", false, true, true)]       // `startright` is not a trigger
    [InlineData("mdl_ASS1_noColliderockwall_3", false, true, true)]       // visible art, named for no collision
    [InlineData("mdl_ABA1_con_bboard_group1_med_01_00032", false, true, true)]
    public void HelpersAreHiddenAndOnlyFencesStaySolid(string name, bool debugPageOnly, bool visible, bool solid)
    {
        Assert.Equal((visible, solid), Ssx3Service.Classify(name, debugPageOnly));
    }

    // [Trailmap: 513-binding]
    [Fact]
    public void AModelsCollisionIsSharedByItsOtherInstancesInTheSection()
    {
        // One boulder model placed three times in section 1 and once in section 2; each section names its copy of
        // the collision after its first boulder.
        var instances = new[]
        {
            (1, "mdl_A_rock_de_bolder_d_1000", 30, 7),
            (1, "mdl_A_rock_de_bolder_d_1001", 30, 7),
            (1, "mdl_A_nc_rock_gen2_b_0_0006", 30, 9),
            (2, "mdl_B_rock_de_bolder_d_1000", 30, 7),
        };
        var byOwner = new Dictionary<string, string>
        {
            ["mdl_A_rock_de_bolder_d_1000"] = "c0.obj",
            ["mdl_B_rock_de_bolder_d_1000"] = "c1.obj",
        };

        var shared = Ssx3Service.CollisionByModel(instances, byOwner);

        Assert.Equal("c0.obj", shared[(1, 30, 7)]);
        Assert.Equal("c1.obj", shared[(2, 30, 7)]);
        Assert.False(shared.ContainsKey((1, 30, 9)));   // a model with no collision stays without
    }

    // [Trailmap: 512-render-state]
    [Theory]
    [InlineData(1, 0)]
    [InlineData(33, 0)]           // opaque, with an unrelated state bit
    [InlineData(3, 0x40000)]      // alpha-tested: the billboard trees
    [InlineData(7, 0x40000)]      // blended
    [InlineData(97, 0x40000)]     // the additive glows
    public void AlphaStatesJoinTheAlphaPass(int renderState, int appearance)
    {
        Assert.Equal(appearance, Ssx3Service.Appearance(renderState));
    }

    /// <summary>Slopesmith's GS display decode, (0.5·C_D − C_S)·A/128, for one channel.</summary>
    static float TrickyLit(byte residual, byte alpha, float diffuse) =>
        Math.Clamp((0.5f * diffuse - residual / 255f) * alpha / 128f, 0, 1);

    // [Trailmap: 511-lm-base]
    [Theory]
    [InlineData(116, 55)]   // a blue shadow: strong residual, weak light
    [InlineData(8, 115)]    // open snow: almost no residual, full light
    [InlineData(0, 127)]
    public void ARemappedTexelLightsAsSsx3DoesOnAnyBase(byte residual, byte alpha)
    {
        using var image = new Image<Rgba32>(1, 1, new Rgba32(residual, residual, 0, alpha));

        Ssx3Service.ToTrickyLightmap(image);

        var p = image[0, 0];
        foreach (float diffuse in new[] { 1f, 0.6f, 0.25f })
        {
            float ssx3 = Math.Clamp((diffuse - residual / 255f) * alpha / 128f, 0, 1);
            Assert.InRange(TrickyLit(p.R, p.A, diffuse) - ssx3, -0.01f, 0.01f);
            Assert.InRange(TrickyLit(p.B, p.A, diffuse) - Math.Clamp(diffuse * alpha / 128f, 0, 1), -0.01f, 0.01f);
        }
    }

    // [Trailmap: 511-lm-base]
    [Fact]
    public void AnOverbrightTexelSaturatesAlphaAndKeepsWhiteSnowRight()
    {
        // 2·A no longer fits a byte, so the texel is re-encoded at full alpha for the white base snow is.
        using var image = new Image<Rgba32>(1, 1, new Rgba32(60, 40, 0, 200));

        Ssx3Service.ToTrickyLightmap(image);

        var p = image[0, 0];
        Assert.Equal(255, p.A);
        Assert.InRange(TrickyLit(p.R, p.A, 1) - Math.Clamp((1 - 60 / 255f) * 200 / 128f, 0, 1), -0.01f, 0.01f);
        Assert.InRange(TrickyLit(p.G, p.A, 1) - Math.Clamp((1 - 40 / 255f) * 200 / 128f, 0, 1), -0.01f, 0.01f);
    }
}
