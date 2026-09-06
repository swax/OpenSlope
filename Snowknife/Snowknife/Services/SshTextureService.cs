using SSX_Library.EATextureLibrary; // OldShapeHandler / NewShapeHandler (.SSH decode)
using Snowknife.Formats;

namespace Snowknife.Services;

/// <summary>
/// EA .SSH texture-bank operations: decode a bank to PNGs, verbatim-append donor pages, and encode a PNG as a
/// type-5 (32-bit FullColor) or opt-in type-2 (8-bit indexed) page. The append/encode primitives power
/// repack's borrowed + custom textures;
/// <see cref="EncodeCustomPage"/> is the shared encoder the repack path also calls, and the single point every
/// page built from an arbitrary image passes through - which is why the GS ladder conform lives there.
/// </summary>
internal sealed class SshTextureService
{
    // Decode an EA .SSH texture bank (the format SSX uses for shared/level textures) to PNGs.
    // Each contained image is written as "<shortname><index>.png" (the library's naming).
    public int SshExtract(string[] args)
    {
        if (args.Length < 3) { Log.Error("ssh-extract needs <file.ssh> <outDir>"); return 1; }
        string sshPath = args[1];
        string outDir = args[2];
        if (!File.Exists(sshPath)) { Log.Error($"Not found: {sshPath}"); return 1; }

        Directory.CreateDirectory(outDir);

        // EA ships two SSH variants: "ShpS" (the level/skybox banks) vs "SHPS"/"SHPX"/"SHPG"
        // (the shared DATA\TEXTURES banks, incl. CROWD). Pick the matching decoder by magic word.
        string magic;
        using (var fs = File.OpenRead(sshPath))
        {
            byte[] b = new byte[4];
            fs.ReadExactly(b, 0, 4);
            magic = System.Text.Encoding.ASCII.GetString(b);
        }

        int count;
        if (magic == "ShpS")
        {
            var shape = new NewShapeHandler();
            shape.LoadShape(sshPath);
            shape.ExtractImage(outDir);
            count = shape.ShapeImages.Count;
            foreach (var img in shape.ShapeImages)
                Log.Info($"  {img.Shortname,-20} {img.Image.Width}x{img.Image.Height}");
        }
        else
        {
            var shape = new OldShapeHandler();
            shape.LoadShape(sshPath);
            shape.ExtractImage(outDir);
            count = shape.ShapeImages.Count;
            foreach (var img in shape.ShapeImages)
                Log.Info($"  {img.Shortname,-20} {img.Image?.Width}x{img.Image?.Height}");
        }

        Log.Info($"Decoded {count} image(s) ({magic}) from {Path.GetFileName(sshPath)} -> {outDir}");
        return 0;
    }

    // Encode a PNG as a type-5 page (or type-2 with --type2) and append it to an SHPS bank - the custom-texture
    // counterpart of ssh-append. Test harness for the encode+splice repack does internally.
    //   ssh-encode <target.ssh> <out.ssh> <image.png>
    public int SshEncode(string[] args)
    {
        if (args.Length < 4) { Log.Error("ssh-encode needs <target.ssh> <out.ssh> <image.png> [--type2]"); return 1; }
        if (!File.Exists(args[3])) { Log.Error($"no image at {args[3]}"); return 1; }
        bool type2 = args.Contains("--type2");
        var (bank, newSlots) = SshBank.Append(File.ReadAllBytes(args[1]), new[] { EncodeCustomPage(args[3], type2) });
        File.WriteAllBytes(args[2], bank);
        Log.Info($"ssh-encode: {Path.GetFileName(args[3])} ({(type2 ? "type-2, 8-bit" : "type-5, 32-bit")}) -> slot {newSlots[0]} ({SshBank.Load(bank).Count} slots) -> {args[2]} ({bank.Length:n0} B)");
        return 0;
    }

    // Verbatim-append page(s) from donor SHPS bank(s) onto a target bank (Slopesmith docs/011 Phase 2). Each donor page
    // is copied byte-for-byte (no decode/re-encode) and renumbered to the next free slot; the target's own
    // pages are untouched. Mainly a test harness for the splice repack uses internally (SshBank.Append).
    //   ssh-append <target.ssh> <out.ssh> <donor.ssh> <name> [<donor.ssh> <name> ...]
    public int SshAppend(string[] args)
    {
        if (args.Length < 5 || (args.Length - 3) % 2 != 0)
        { Log.Error("ssh-append needs <target.ssh> <out.ssh> <donor.ssh> <name> [<donor.ssh> <name> ...]"); return 1; }
        string targetPath = args[1], outPath = args[2];
        var target = SshBank.Load(targetPath);
        var blobs = new List<byte[]>();
        var srcDesc = new List<string>();
        for (int i = 3; i + 1 < args.Length; i += 2)
        {
            var donor = SshBank.Load(args[i]);
            string name = args[i + 1];
            int idx = donor.IndexOfName(name);
            if (idx < 0) { Log.Error($"page '{name}' not in {Path.GetFileName(args[i])} ({donor.Count} slots)"); return 1; }
            blobs.Add(donor.PageBytes(idx));
            srcDesc.Add($"{Path.GetFileNameWithoutExtension(args[i])}/{name}");
        }
        var (bank, newSlots) = SshBank.Append(File.ReadAllBytes(targetPath), blobs);
        File.WriteAllBytes(outPath, bank);
        for (int i = 0; i < newSlots.Count; i++) Log.Info($"  appended {srcDesc[i]} -> slot {newSlots[i]}");
        Log.Info($"ssh-append: {target.Count} + {blobs.Count} = {SshBank.Load(bank).Count} slots -> {outPath} ({bank.Length:n0} B)");
        return 0;
    }

    // Encode a custom RGBA image (PNG) into a single verbatim-appendable SHPS page (Slopesmith docs/011 Phase 3).
    // Type 5 remains the proven default. `type2` mirrors retail GARI terrain pages: an unswizzled type-2
    // index matrix followed by an unswizzled, 256-entry type-33 RGBA palette. The library quantizes images
    // over 256 colours before writing. Both formats use the game's half-bright GS colour/alpha convention.
    //
    // The image is conformed to the GS power-of-two ladder first (GsTextureLadder), because the caller hands
    // over an arbitrary PNG and a page's edges are what the hardware addresses it by. `ceiling` is how big a
    // page this bank's headroom leaves; repack derives it from the whole set it is installing, while the
    // ladder's own top rung means "snap to the ladder, cap nothing". A PNG already on the ladder is encoded
    // from its own bytes, untouched.
    public byte[] EncodeCustomPage(string pngPath, bool type2 = false, int ceiling = GsTextureLadder.MaxEdge)
    {
        string source = GsTextureLadder.Conform(pngPath, ceiling, out string? conformed);
        byte[] blob;
        try { blob = Encode(source, type2); }
        finally { if (conformed != null) { try { File.Delete(conformed); } catch { } } }

        // Half-bright to match original terrain pages [Trailmap: 210-textures-ssh]: the GS treats 128 as 1.0 and DOUBLES at
        // draw, and the terrain lightmap alpha-blend (accurate only at GS Blending = Full) expects opaque
        // alpha = 128. So store every channel as (c+1)/2 (255 -> 128), the inverse of the decode brighten -
        // otherwise a full-range page double-brightens + mis-blends under accurate emulation. The type-5 image
        // chunk is first: 16-byte header (type@0, width@4, height@6 LE i16), RGBA payload from +16.
        if (!type2 && blob.Length > 16 && blob[0] == (byte)OldShapeHandler.MatrixType.FullColor)
        {
            int w = blob[4] | (blob[5] << 8), ht = blob[6] | (blob[7] << 8);
            int end = Math.Min(blob.Length, 16 + w * ht * 4);
            for (int i = 16; i < end; i++) blob[i] = (byte)((blob[i] + 1) / 2);
        }
        return blob;
    }

    // The library builds a page only as a one-image bank on disk, so the page's chunk chain is read back out
    // of a scratch .ssh.
    private static byte[] Encode(string pngPath, bool type2)
    {
        var h = new OldShapeHandler { Format = "G278" }; // ConsoleVersion defaults to OldPS2 -> "SHPS" magic
        var matrixType = type2 ? OldShapeHandler.MatrixType.EightBit : OldShapeHandler.MatrixType.FullColor;
        h.AddImage(matrixType, "0000", pngPath);
        if (type2)
        {
            // Retail terrain palettes store RGB and alpha in the GS half range (max 127/128). DarkenImage
            // handles RGB; AlphaFix makes WriteColourTable halve alpha after RGBA-aware quantization.
            h.DarkenImage(0);
            var image = h.ShapeImages[0];
            image.AlphaFix = true;
            h.ShapeImages[0] = image;
        }
        string tmp = Path.Combine(Path.GetTempPath(), "sshenc_" + Guid.NewGuid().ToString("N") + ".ssh");
        try { h.SaveShape(tmp); return SshBank.Load(tmp).PageBytes(0); }
        finally { try { File.Delete(tmp); } catch { } }
    }
}
