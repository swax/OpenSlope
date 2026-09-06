using Snowknife.Bundle;

namespace Snowknife.Tests;

/// <summary>
/// Agreements that span repositories with no compiler link between them: Snowknife writes a bundle, Slopesmith
/// writes the same shapes from the authoring side, and the Unity importer plus its two shaders read them. A
/// rename on either side type-checks perfectly and produces a level that is silently wrong — the prop lighting
/// goes flat, or the spawn falls back to a course-top scan 447 m from the start gate.
///
/// Text is the only mechanism available across a `.ts` file, a `.shader` and an assembly this solution does
/// not reference, so these are deliberately grep-shaped. Where the subject IS in this assembly the check is
/// behavioural instead, and lives beside the rest of its type's tests.
///
/// A missing subject is reported as a broken contract rather than a crash: if a file moves, re-point the row or
/// retire it on purpose.
/// </summary>
public class CrossRepoContractTests
{
    internal static readonly string Root = FindRepoRoot();

    /// <summary>Walk up to the toolkit root, marked by <c>.gitmodules</c> — see the note on
    /// <see cref="EndToEnd.E2E"/>'s copy for why a project file is the wrong marker here.</summary>
    static string FindRepoRoot()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory != null)
        {
            if (File.Exists(Path.Combine(directory.FullName, ".gitmodules"))) return directory.FullName;
            directory = directory.Parent;
        }
        throw new InvalidOperationException("Could not locate the OpenSlope root from the test assembly.");
    }

    static string Source(string relativePath)
    {
        string path = Path.Combine(Root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Assert.True(File.Exists(path),
            $"{relativePath}: contract subject no longer exists - retire or re-point this check");
        return File.ReadAllText(path);
    }

    static void Contains(string relativePath, params string[] required)
    {
        string source = Source(relativePath);
        foreach (string token in required)
            Assert.True(source.Contains(token, StringComparison.Ordinal),
                $"{relativePath}: missing contract token '{token}'");
    }

    static void Excludes(string relativePath, params string[] forbidden)
    {
        string source = Source(relativePath);
        foreach (string token in forbidden)
            Assert.False(source.Contains(token, StringComparison.Ordinal),
                $"{relativePath}: obsolete fallback token remains '{token}'");
    }

    // ---- the bundle side ----

    [Fact]
    public void TheBundleStillDeclaresVersionThree()
    {
        // Behavioural: the manifest type is in this assembly, so its default is checkable directly. The
        // schema's matching `"const": 3` is proven by ContractValidationTests.
        Assert.Equal(3, new BundleManifest().BundleVersion);
    }

    [Fact]
    public void PropNormalsAreTransformedByTheInverseTransposeOfThePlacement()
    {
        // Non-uniform prop scale is common; transforming a normal by the placement matrix itself shears it,
        // and the lighting error that follows looks like a texture problem.
        Contains("Snowknife/Snowknife/Export/PropsExporter.cs",
            "mesh.Normals", "Matrix4x4.Transpose(invWorld)", "t.Vn[k]");
    }

    [Fact]
    public void AnInstanceStillCarriesThreeLightVectors()
    {
        Contains("Snowknife/Snowknife/Bundle/SsxInstance.cs", "LightVector1", "LightVector2", "LightVector3");
    }

    [Fact]
    public void TheManifestStillCarriesThreeLightKeysAndDirections()
    {
        Contains("Snowknife/Snowknife/Bundle/BundleManifest.cs",
            "Key1", "Key2", "Key3", "Direction1", "Direction2", "Direction3");
    }

    [Fact]
    public void TheSchemaAgreesWithTheManifestOnTheLightingFields()
    {
        Contains("Snowknife/Snowknife/schemas/bundle/bundle-manifest-v3.schema.json",
            "\"BundleVersion\": { \"const\": 3 }", "\"Key1\"", "\"Direction3\"", "\"RestScale\"");
    }

    [Fact]
    public void MaterialResolutionStillGoesThroughTheAuthoredPolicy()
    {
        Contains("Snowknife/Snowknife/Bundle/MaterialBundle.cs", "AuthoredMaterialPolicy.StripObjectSuffix(s)");
        Contains("Snowknife/Snowknife/Bundle/TextureBundle.cs",
            "AuthoredMaterialPolicy.UsesPixelAlpha(m.MaterialName)", "authoredPixelAlpha.Contains(name)");
    }

    [Fact]
    public void TheBundleClassifiesAgainstTheEffectInstances()
    {
        Contains("Snowknife/Snowknife/Bundle/BundleExporter.cs", "Classify(levelDir, effectInstances");
    }

    [Fact]
    public void AnimatedPropSegmentsStillCarryTheirRestScale()
    {
        Contains("Snowknife/Snowknife/Bundle/AnimatedPropsBundle.cs", "RestScale = ObjectScale(mo)");
    }

    // ---- Origin.json: one map contract, two producers, and a gate that fails open if they drift ----

    [Fact]
    public void BothProducersWriteTheSameMapOriginContract()
    {
        // `snowknife import` writes this for an extract and Slopesmith's export writes it for an authored
        // mountain, with no compiler link between them. A rename on either side produces a file the other's
        // reader rejects — and Slopesmith's reader resolves a rejected record to "retail", so the whole
        // authored half of a library would silently lock rather than fail visibly.
        Contains("Snowknife/Snowknife/Services/MapOrigin.cs",
            "openslope-origin/v1", "\"Origin.json\"", "RetailOrigin = \"retail\"",
            "SlopesmithOrigin = \"slopesmith\"", "RetailExtractReason = \"retail-extract\"");
        Contains("Slopesmith/src/core/export/origin.ts",
            "MAP_ORIGIN_FILE = 'Origin.json'", "MAP_ORIGIN_SCHEMA = 'openslope-origin/v1'",
            "'retail' | 'slopesmith'", "RETAIL_EXTRACT_REASON = 'retail-extract'");
        Contains("Snowknife/Snowknife/schemas/course/origin-v1.schema.json",
            "\"const\": \"openslope-origin/v1\"", "\"enum\": [\"retail\", \"slopesmith\"]",
            "\"RetailData\"", "\"Reasons\"", "\"Course\"");
    }

    [Fact]
    public void TheImportWritesAndValidatesTheOriginContract()
    {
        // A folder with no Origin.json is read as retail by every consumer, so a missing write is invisible on
        // an extract and wrong on nothing — until the day an authored folder relies on the same writer.
        Contains("Snowknife/Snowknife/Services/LevelPipelineService.cs",
            "MapOrigin.ForRetailExtract(levelName)", "ContractKind.OriginV1");
        Contains("Slopesmith/src/core/export/folder.ts", "authoredOrigin(provenance)", "MAP_ORIGIN_FILE");
    }

    [Fact]
    public void OnlyTheRetailHalfOfProvenanceReachesTheOrigin()
    {
        // A user- reason is a rights question with its own answer (--confirm-rights). Letting one set
        // RetailData would make a mountain full of the author's own photographs need a copy of the game.
        Contains("Slopesmith/src/core/export/origin.ts", "reason.startsWith('retail-')");
    }

    // ---- the start-anchor keys: bare strings agreed across two repos ----

    [Fact]
    public void TheStartAnchorKeysMatchOnBothSides()
    {
        // snowknife emits these placeholders as pose-only locators and the Unity importer spawns at whichever
        // locator carries them. Drift either side and the spawn silently falls back a rung, ending at the
        // course-top endpoint scan, which is 447 m out on a lap course ([Trailmap: 120-objects]).
        //
        // The GATE is the preferred anchor and the stage marker the fallback, measured rather than assumed: over
        // the eight retail courses the gate sits 2.6-2.7 m from where the AI start paths actually place the
        // riders, while the marker is 16-71 m away and up to 16 m out vertically. The marker still has to be
        // named on both sides, because it is the only one of the two that authored/test maps carry.
        Contains("Snowknife/Snowknife/Bundle/PropsBundle.cs", "\"Mdl_StartGate\"");
        Contains("Snowknife/Snowknife/Bundle/PropsBundle.cs", "\"Mdl_StageArea_Start\"");
        Contains("Unity/Importer/Editor/LevelImporter.cs",
            "StartGateKey   = \"Mdl_StartGate\"");
        Contains("Unity/Importer/Editor/LevelImporter.cs",
            "StartMarkerKey = \"Mdl_StageArea_Start\"");
    }

    [Fact]
    public void EveryStartGateReachesTheBundleNotJustTheFirst()
    {
        // Alaska authors two `Mdl_StartGate_*` and the one at the rider grid is not the one that comes first in
        // instance order, so a first-match-wins emit shipped the wrong gate 71 m away. The bundle carries them
        // all and BundleManifestReader.BestLocator breaks the tie on the course line.
        Contains("Snowknife/Snowknife/Bundle/PropsBundle.cs", "locators.Add(new BundleManifest.LocatorInfo");
        Contains("Unity/Importer/Editor/Bundle/BundleManifestReader.cs", "public Locator BestLocator(");
    }

    // ---- the Slopesmith authoring side ----

    [Fact]
    public void TheAuthoredPropPoseJoinIsStillSlopesmithInternal()
    {
        // The export stamps each baked group's placement and the canonical serializer reads it back to write
        // the Instances.json rows, which is why snowknife needs no authored-specific pose path of its own.
        Contains("Slopesmith/src/core/export/folder.ts",
            "slopesmith.propPoses = propPoses", "placementSimilarity(placementMatrix(pp))");
        Contains("Slopesmith/src/core/export/canonical-props.ts",
            "joined(metadata.bakedGroups, metadata.propPoses)");
    }

    // ---- the Unity importer and its two shader variants ----

    [Fact]
    public void EveryBundleBoxIsPlacedWithTheRotationTheEmitterGivesIt()
    {
        // Mode-2 colliders are the model's OWN box turned with the placement, not the axis-aligned envelope of
        // the turned result (spec 130-mode2-oriented). CollisionBundle.EmitBoxes emits Center/Rotation as the
        // holder and LocalCenter/Size as the box on it, and EVERY consumer of those records has to honour both
        // halves. Dropping the rotation is silently worse than the axis-aligned version it replaced: the box
        // would keep the tight local extents while facing the wrong way.
        Contains("Unity/Importer/Editor/Bundle/BundleManifestReader.cs",
            "[JsonProperty(\"Rotation\")] float[] _rotation;",
            "public Vector3 LocalCenter = Vector3.zero;");
        Contains("Unity/Importer/Editor/CollisionBuilder.cs",
            "box.center = b.LocalCenter; box.size = b.Size;",
            "NativeCollision.AddPassThroughBox(go, b.LocalCenter, b.Size,");
    }

    [Fact]
    public void ResetZoneTriggersArePlacedWithTheOrientationTheyWereFittedWith()
    {
        // A reset zone is a flat panel; its trigger is a slab fitted to that panel and TURNED with it. A
        // consumer that keeps the fitted size but drops the rotation gets a slab facing the wrong way, which
        // is worse than the world AABB it replaced - it would both miss real crossings and fire on false ones.
        Contains("Unity/Importer/Editor/Bundle/BundleManifestReader.cs",
            "public class ResetZone",
            "[JsonProperty(\"Rotation\")] float[] _rotation;");
        Contains("Unity/Importer/Editor/VolumeBuilder.cs", "go.transform.localRotation = z.Rotation;");
    }

    [Fact]
    public void ABoundingBoxIsMetByTheBodySphereAndAProxyByTheCapsule()
    {
        // The rider is a different SHAPE per collision mode [Trailmap: 370-probe-modes]: a mode-2 box is met by
        // one 0.85 m ball at the pelvis, while proxies and bodies are met by the limb spheres the board's ~0.3 m
        // capsule stands in for. Both boards keep that split, and both rely on the importer parenting every
        // bounds box under the one root the parent-reference test compares against.
        Contains("Unity/Importer/Editor/CollisionBuilder.cs",
            "marker.NativeMode = NativeCollision.BoundingBox;",
            "\"PropsBoundsCollision\"");
        Contains("Unity/VRC/World/PropBounce.cs", "public int NativeMode = 1;");
        Contains("Unity/Basis/World/BasisPropBounce.cs", "public int NativeMode = 1;");
        Contains("Unity/VRC/Riding/Board/RideableBoard.cs",
            "public float bodySphereRadius = 0.85f;",
            "if (c.transform.parent != _boundsRoot) continue;");
        Contains("Unity/Basis/Riding/BasisBoard.Probe.cs",
            "if (c.transform.parent != _boundsRoot) continue;");
    }

    [Fact]
    public void ThePropBuilderReadsEveryLightingChannelTheBundleWrites()
    {
        Contains("Unity/Importer/Editor/PropBuilder.cs",
            "mesh.SetUVs(2, key1)", "mesh.SetUVs(7, dir3)", "_InstKey3", "_InstDir3",
            "segTf[k].localScale = seg.RestScale");
    }

    [Fact]
    public void AmbientBreakAnimationsStayImmediateWhileTriggeredOnesRollAway()
    {
        // BreakOwned covers both the free-running Snowdream balloons and the triggered city globe. Unity must use
        // the animated renderers for both, but only the latter may turn its clip length into a delayed break.
        Contains("Unity/Importer/Editor/PropBuilder.cs",
            "if (animatedIntact && bk.Role == LogoRole.Intact)",
            "bool rolls = animatedIntact && _breakOwnedAnims[intactBk.Index].triggered;",
            "if (rolls)");
    }

    [Fact]
    public void TheMeshRewritersPreserveTheLightingUvChannels()
    {
        // Both of these rebuild meshes after import. Dropping UV7 silently flattens prop lighting on exactly
        // the props that got packed or chunked.
        Contains("Unity/Importer/Editor/TextureArrayPacker.cs",
            "src.GetUVs(7, uv7)", "mesh.SetUVs(7, nUv7)", "IsKeywordEnabled(\"_PROPLIGHT\")");
        Contains("Unity/Importer/Editor/StaticChunker.cs",
            "src.GetUVs(7, uv7)", "cmesh.SetUVs(7, c7)", "anim.SetUVs(7, a7)");
    }

    [Fact]
    public void TheMaterialFactoryTurnsPropLightingOn()
    {
        Contains("Unity/Importer/Editor/MaterialFactory.cs",
            "mat.EnableKeyword(\"_PROPLIGHT\")", "mat.SetFloat(\"_UsePropLight\", 1f)");
    }

    [Fact]
    public void BothShaderVariantsEvaluateTheSameLightingInTheSameColourSpace()
    {
        // The VRC and Basis shaders are separate files that must stay in step; they differ only in the
        // keyword scope and their gamma helper names.
        Contains("Unity/VRC/Shaders/Unlit.shader",
            "#pragma shader_feature _PROPLIGHT", "_InstKey3", "_InstDir3",
            "LinearToGammaSpace(textureLinear)", "GammaToLinearSpace");
        Contains("Unity/Basis/Shaders/Unlit.shader",
            "#pragma shader_feature_local _PROPLIGHT", "_InstKey3", "_InstDir3",
            "ToGamma(textureLinear)", "ToLinear");
    }

    // ---- retired approaches that must not come back ----

    [Fact]
    public void ThePropBuilderNoLongerFallsBackToASingleLightKey()
    {
        Excludes("Unity/Importer/Editor/PropBuilder.cs", "exact ? rec.Key1 : rec.Key");
    }

    [Fact]
    public void TheReplacedDirectionalLightUniformsAreGoneFromEveryConsumer()
    {
        foreach (string subject in new[]
                 {
                     "Unity/Importer/Editor/MaterialFactory.cs",
                     "Unity/VRC/Shaders/Unlit.shader",
                     "Unity/Basis/Shaders/Unlit.shader",
                 })
            Excludes(subject, "_DirLightDir", "_DirLightGain", "_DirLightWrap");
    }
}
