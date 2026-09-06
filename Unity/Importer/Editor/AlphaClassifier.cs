#if UNITY_EDITOR
using System.Collections.Generic;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Alpha classification: whether a texture is alpha-CUTOUT (fully-transparent holes over solid content),
    // alpha-BLEND (uniformly translucent - glass/water/LCD signs), GLOW (a soft light-halo sheet - lamp
    // starbursts/light spill; blends, but keeps the hole clip), or opaque. The verdicts come from the snowknife
    // bundle manifest (snowknife ran the identical pixel histogram once when it built the manifest; docs/unity/005,
    // Snowknife docs/034) - the importer just reads the precomputed verdicts, not raw pixels. Shared by terrain + prop material building; caches
    // each verdict and remembers which textures ended up cutout / blend / glow (for the import summary).
    public class AlphaClassifier
    {
        enum AlphaMode { Opaque, Cutout, Blend, Glow }

        readonly Dictionary<string, AlphaMode> _cache = new Dictionary<string, AlphaMode>();
        readonly List<string> _cutoutTextures = new List<string>();
        readonly List<string> _blendTextures = new List<string>();
        readonly List<string> _glowTextures = new List<string>();
        readonly BundleManifestReader _bundle;                              // snowknife-precomputed alpha modes

        public IReadOnlyList<string> CutoutTextures => _cutoutTextures;
        public IReadOnlyList<string> BlendTextures => _blendTextures;
        public IReadOnlyList<string> GlowTextures => _glowTextures;

        public AlphaClassifier(ImportConfig cfg)
        {
            _bundle = new BundleManifestReader(cfg);
            if (_bundle.Exists)
                Debug.Log($"OpenSlope: alpha modes from bundle manifest ({_bundle.TextureAlpha.Count} textures) - no pixel inspection.");
        }

        public bool IsCutout(string texFile) => Detect(texFile) == AlphaMode.Cutout;
        public bool IsBlend(string texFile)  => Detect(texFile) == AlphaMode.Blend;
        public bool IsGlow(string texFile)   => Detect(texFile) == AlphaMode.Glow;

        // Blend pages whose every submesh is a single-facing sheet (river surfaces, banners) rather than a closed
        // shell. snowknife measures this off the model normals when it builds the manifest (TextureBundle); the
        // blend path drops z-write for them so stacked sheets composite instead of depth-rejecting each other.
        public bool IsSheet(string texFile) => texFile != null && _bundle.TextureSheets.Contains(texFile);

        // Record a texture as cutout (the material builders call this when they enable the clip path) so the
        // import summary can list them. De-duped; the base texFile is recorded even for cutout flipbooks.
        public void MarkCutout(string texFile)
        {
            if (texFile != null && !_cutoutTextures.Contains(texFile)) _cutoutTextures.Add(texFile);
        }

        // Record a texture as alpha-blend (the material builders call this when they switch to translucent
        // render state) for the import summary. De-duped.
        public void MarkBlend(string texFile)
        {
            if (texFile != null && !_blendTextures.Contains(texFile)) _blendTextures.Add(texFile);
        }

        // Record a texture as a glow sheet (blend + hole clip) for the import summary. De-duped.
        public void MarkGlow(string texFile)
        {
            if (texFile != null && !_glowTextures.Contains(texFile)) _glowTextures.Add(texFile);
        }

        // The texture's alpha mode from the bundle manifest. snowknife classified every top-level Textures/*.png
        // (terrain, props, crowd flipbook frames) - exactly the set asked about here; particle sprites go straight
        // through the particle shader and are never classified. Unknown texture / no bundle -> Opaque.
        AlphaMode Detect(string texFile)
        {
            if (texFile == null) return AlphaMode.Opaque;
            if (_cache.TryGetValue(texFile, out var cached)) return cached;
            AlphaMode mode = AlphaMode.Opaque;
            if (_bundle.Exists && _bundle.TextureAlpha.TryGetValue(texFile, out var m))
                mode = m == "cutout" ? AlphaMode.Cutout : m == "blend" ? AlphaMode.Blend : m == "glow" ? AlphaMode.Glow : AlphaMode.Opaque;
            _cache[texFile] = mode;
            return mode;
        }
    }
}
#endif
