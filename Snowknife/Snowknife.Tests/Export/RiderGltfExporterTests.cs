using System.Numerics;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using Snowknife.Export;
using SSXLibrary.FileHandlers.Models.Tricky;

namespace Snowknife.Tests.Export;

public class RiderGltfExporterTests
{
    [Fact]
    public void AxisChangeIsARotationThatStandsTheRiderUpFacingGltfForward()
    {
        Vector3 x = RiderGltfExporter.ToGltf(Vector3.UnitX);
        Vector3 y = RiderGltfExporter.ToGltf(Vector3.UnitY);
        Vector3 z = RiderGltfExporter.ToGltf(Vector3.UnitZ);

        Assert.Equal(Vector3.UnitY, z);                                    // engine up is glTF up
        Assert.Equal(Vector3.UnitZ, RiderGltfExporter.ToGltf(-Vector3.UnitY)); // the rider's -Y front faces +Z
        Assert.Equal(Vector3.UnitX, x);
        Assert.Equal(z, Vector3.Cross(x, y));                              // right-handed in, right-handed out

        foreach (var v in new[] { Vector3.UnitX, Vector3.UnitY, Vector3.UnitZ, new Vector3(3f, -2f, 7f) })
            AssertClose(RiderGltfExporter.ToGltf(v), Vector3.Transform(v, RiderGltfExporter.AxisSwap));
    }

    [Fact]
    public void WeightsMergeKeepTheStrongestFourAndSumToOne()
    {
        var weights = RiderGltfExporter.NormalizeWeights(
            [(1, 30f), (2, 20f), (1, 30f), (3, 10f), (4, 5f), (5, 4f), (6, 0f)]);

        Assert.Equal(new[] { 1, 2, 3, 4 }, weights.Select(w => w.Joint));
        Assert.Equal(1f, weights.Sum(w => w.Weight), 5);
        Assert.Equal(60f / 95f, weights[0].Weight, 5);

        Assert.Equal(new[] { (0, 1f) }, RiderGltfExporter.NormalizeWeights([(2, 0f)]));
    }

    [Fact]
    public void OutfitsAreTheNumberedSuitBanksOfThatRiderOnly()
    {
        using var temp = new TempDir();
        foreach (string file in new[] { "mac1_suit.ssh", "mac12_suit.ssh", "mac3_suit.ssh", "mac_suit.ssh",
                                        "macx_suit.ssh", "marisol2_suit.ssh", "mac4_boot.ssh" })
            temp.Write(file, "");

        Assert.Equal(new[] { 1, 3, 12 }, RiderGltfExporter.Outfits(temp.Path, "mac"));
        Assert.Empty(RiderGltfExporter.Outfits(Path.Combine(temp.Path, "missing"), "mac"));
        Assert.Equal("mmm", RiderGltfExporter.TextureName("zz_mmm"));
        Assert.Equal("mac", RiderGltfExporter.TextureName("mac"));
    }

    [Fact]
    public void BuildsAnUprightMetreScaleSkinOnTheFloorWhoseRestPoseIsTheBindPose()
    {
        using var temp = new TempDir();
        string suit = temp.File("suit1.png");
        using (var image = new Image<Rgba32>(2, 2, new Rgba32(200, 40, 40, 255))) image.SaveAsPng(suit);

        // Hips 100 units up on engine Z, a child bone 50 units above that, turned a quarter about Z; the lowest
        // vertex, at 40, becomes the floor.
        var combiner = new TrickyPS2ModelCombiner
        {
            bones =
            [
                new TrickyPS2MPF.BoneData { BoneName = "hips", ParentBone = -1, Position = new Vector3(0, 0, 100) },
                new TrickyPS2MPF.BoneData { BoneName = "head", ParentBone = 0, Position = new Vector3(0, 0, 50),
                                            Radians = new Vector3(0, 0, MathF.PI / 2) },
            ],
            reassignedMesh =
            [
                new TrickyPS2ModelCombiner.ReassignedMesh
                {
                    MeshName = "Body3000 ",
                    faces =
                    [
                        new TrickyPS2MPF.Face
                        {
                            V1 = new Vector3(0, 0, 40), V2 = new Vector3(10, 0, 150), V3 = new Vector3(0, -10, 150),
                            Normal1 = -Vector3.UnitY, Normal2 = -Vector3.UnitY, Normal3 = -Vector3.UnitY,
                            UV1 = new Vector4(0, 0, 0, 0), UV2 = new Vector4(1, 0, 0, 0), UV3 = new Vector4(0, 1, 0, 0),
                            Weight1 = Weights((0, 100)), Weight2 = Weights((1, 100)), Weight3 = Weights((0, 25), (1, 75)),
                            MaterialID = 9, // 3 * suit + base finish
                        },
                    ],
                },
                new TrickyPS2ModelCombiner.ReassignedMesh { MeshName = "BodyShdw750", ShadowModel = true, faces = [] },
            ],
        };

        var model = RiderGltfExporter.BuildModel(combiner, new Dictionary<string, string> { ["suit"] = suit });

        var mesh = Assert.Single(model.LogicalMeshes);
        Assert.Equal("Body3000", mesh.Name);
        var prim = Assert.Single(mesh.Primitives);
        Assert.Equal("suit", prim.Material.Name);
        Assert.NotNull(prim.Material.FindChannel("BaseColor")?.Texture);

        var positions = prim.GetVertexAccessor("POSITION").AsVector3Array();
        Assert.Contains(positions, p => Close(p, new Vector3(0, 0, 0)));
        Assert.Contains(positions, p => Close(p, new Vector3(0.1f, 1.1f, 0)));
        Assert.Contains(positions, p => Close(p, new Vector3(0, 1.1f, 0.1f)));   // engine -Y is the front, +Z
        Assert.All(prim.GetVertexAccessor("NORMAL").AsVector3Array(), n => AssertClose(Vector3.UnitZ, n));
        Assert.All(prim.GetVertexAccessor("WEIGHTS_0").AsVector4Array(),
            w => Assert.Equal(1f, w.X + w.Y + w.Z + w.W, 5));

        var skin = Assert.Single(model.LogicalSkins);
        Assert.Equal(2, skin.JointsCount);
        var (hips, hipsBind) = skin.GetJoint(0);
        var (head, headBind) = skin.GetJoint(1);
        Assert.Equal("hips", hips.Name);
        AssertClose(new Vector3(0, 0.6f, 0), hips.WorldMatrix.Translation);
        AssertClose(new Vector3(0, 1.1f, 0), head.WorldMatrix.Translation);
        AssertIdentity(hipsBind * hips.WorldMatrix);
        AssertIdentity(headBind * head.WorldMatrix);
    }

    static TrickyPS2MPF.BoneWeightHeader Weights(params (int Bone, int Weight)[] weights) => new()
    {
        boneWeights = weights.Select(w => new TrickyPS2MPF.BoneWeight { BoneID = w.Bone, Weight = w.Weight }).ToList(),
    };

    static bool Close(Vector3 a, Vector3 b) => Vector3.Distance(a, b) < 1e-5f;

    static void AssertClose(Vector3 expected, Vector3 actual) =>
        Assert.True(Close(expected, actual), $"expected {expected}, got {actual}");

    static void AssertIdentity(Matrix4x4 m)
    {
        for (int r = 0; r < 4; r++)
            for (int c = 0; c < 4; c++)
                Assert.Equal(r == c ? 1f : 0f, m[r, c], 4);
    }
}
