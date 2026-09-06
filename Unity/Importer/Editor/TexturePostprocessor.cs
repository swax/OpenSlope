#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Import-time flag for SSX decoded textures: the level textures (Assets/OpenSlope/Maps/<LEVEL>/Textures/...) and
    // the board deck skins (Assets/OpenSlope/Maps/Shared/chars/BoardTextures/..., the 'bord' atlases). The PIXELS arrive
    // finished from snowknife (half-bright corrected + premultiplied-alpha sprites un-multiplied at decode
    // time - see TextureFinish), so the only correction left is a Unity IMPORTER setting that can't be baked
    // into a PNG: alphaIsTransparency. Unity's default leaves it off, so fully-transparent texels keep their
    // (often near-black) decoded RGB; the alpha-cutout edges then fringe dark where bilinear filtering /
    // alpha-to-coverage samples those holes. The flag makes Unity dilate the colour out under the
    // fully-transparent areas so the softened edge picks up the right colour. No-op for opaque textures.
    // Re-applied on every import (a code postprocessor, not a committed .meta, because these live under the
    // gitignored Assets/OpenSlope/Maps/ data and are re-decoded by the CLI). See docs/unity/005-materials-and-alpha.md.
    //
    // Also forces Kaiser mipmap filtering project-wide. Unity's default (box) over-blurs distant mip levels,
    // which VRChat flags on upload ("textures with box mipmap filtering ... switch to kaiser"). Kaiser keeps
    // distant terrain/board textures sharp. Only meaningful when mipmaps are generated; a no-op otherwise.
    class TexturePostprocessor : AssetPostprocessor
    {
        static bool IsMapTexture(string assetPath)
        {
            string p = assetPath.Replace('\\', '/');
            return p.Contains("/Maps/") && (p.Contains("/Textures/") || p.Contains("/BoardTextures/"));
        }

        void OnPreprocessTexture()
        {
            var importer = (TextureImporter)assetImporter;

            // Sharper distant mips for every mipmapped texture (clears the VRChat box-filter warning).
            if (importer.mipmapEnabled)
                importer.mipmapFilter = TextureImporterMipFilter.KaiserFilter;

            if (!IsMapTexture(assetPath)) return;
            importer.alphaIsTransparency = true;
        }
    }
}
#endif
