using DiscUtils.Iso9660;
using SSX_Library; // BIG
using SSX_Library.EATextureLibrary; // OldShapeHandler / NewShapeHandler (.SSH decode)
using Snowknife.Export;

namespace Snowknife.Services;

/// <summary>
/// Rips equipment models + their skins out of the character/vehicle BIG archives: rider bodies (`rider`), the
/// three snowboard decks + skins (`board`), and the SSX On Tour ski decks + skins (`skis`). The board export is
/// the shared-asset workhorse `shared` calls to stage decks for the rideable board.
/// </summary>
internal sealed class ModelService
{
    private readonly IsoService _iso;

    public ModelService(IsoService iso) => _iso = iso;

    // Rip one rider model from DATA\CHAR\MDLPS2.BIG and measure its standing height,
    // so the level WorldScale can be anchored to a real human size. Also drops <name>.obj.
    public int Rider(string[] args)
    {
        if (args.Length < 3) { Log.Error("rider needs <iso> <name> [outDir]"); return 1; }
        string iso = args[1];
        string name = args[2].ToLowerInvariant();
        string outDir = Path.GetFullPath(args.Length >= 4 ? args[3] : Path.Combine("Assets", "OpenSlope", "Maps", "chars"));

        string work = ExtractCharBig(iso, out string filesDir);

        Log.Info("[3/3] Measuring rider + exporting OBJ...");
        Log.Info();
        int rc = CharExporter.Export(filesDir, name, outDir);
        Log.Info();
        Log.Info($"(temp work dir left for inspection: {work})");
        return rc;
    }

    // Rip the snowboard models (board.mpf) AND their real deck skins, ready to drop onto the Unity
    // rideable board. The geometry is the three regular decks board_Al/Bx/Fr.obj (with UVs + normals);
    // the per-character look is texture - the 'bord' skins in DATA\CHAR\TEXPS2.BIG, decoded to
    // BoardTextures/<id>.png. The deck UVs already map onto that atlas.
    public int Board(string[] args)
    {
        if (args.Length < 2) { Log.Error("board needs <iso> [outDir]"); return 1; }
        string iso = args[1];
        string outDir = Path.GetFullPath(args.Length >= 3 ? args[2] : Path.Combine("Assets", "OpenSlope", "Maps", "chars"));

        string work = ExtractCharBig(iso, out string filesDir);

        Log.Info("[3/4] Exporting board deck OBJs (Al/Bx/Fr)...");
        Log.Info();
        int rc = CharExporter.ExportBoard(filesDir, outDir);
        if (rc != 0) { Log.Info($"(temp work dir left for inspection: {work})"); return rc; }

        Log.Info();
        Log.Info("[4/4] Decoding board skins from DATA\\CHAR\\TEXPS2.BIG...");
        int n = ExportBoardTextures(iso, outDir);
        Log.Info($"  Board skins: {n} -> {Path.Combine(outDir, "BoardTextures")}");

        Log.Info();
        Log.Info($"(temp work dir left for inspection: {work})");
        return 0;
    }

    // Rip the SSX On Tour ski decks (vehicles_Skis*_H.mpf) AND their real skins - the skiing
    // counterpart of `board`. Geometry is the ski render deck(s) ski_<name>.obj (UVs + normals);
    // the per-skier look is texture - the 'skis' skins in DATA\CHAR\TEXPS2.BIG, decoded to
    // SkiTextures/<id>.png. On Tour keeps equipment models in the vehicle archive
    // DATA\CHAR\V_MDLPS2.BIG (MDLPS2.BIG holds bodies/clothing, not vehicles).
    public int Skis(string[] args)
    {
        if (args.Length < 2) { Log.Error("skis needs <iso> [outDir]  (point at the SSX On Tour disc)"); return 1; }
        string iso = args[1];
        string outDir = Path.GetFullPath(args.Length >= 3 ? args[2] : Path.Combine("Assets", "OpenSlope", "Maps", "chars"));

        string work = ExtractOnTourVehicleBig(iso, out string filesDir);

        Log.Info("[3/4] Exporting ski deck OBJ(s)...");
        Log.Info();
        int rc = SkiExporter.ExportSkis(filesDir, outDir);
        if (rc != 0) { Log.Info($"(temp work dir left for inspection: {work})"); return rc; }

        Log.Info();
        Log.Info("[4/4] Decoding ski skins from DATA\\CHAR\\TEXPS2.BIG...");
        int n = ExportSkiTextures(iso, outDir);
        Log.Info($"  Ski skins: {n} -> {Path.Combine(outDir, "SkiTextures")}");

        Log.Info();
        Log.Info($"(temp work dir left for inspection: {work})");
        return 0;
    }

    // Decode every board deck skin out of DATA\CHAR\TEXPS2.BIG into <outDir>/BoardTextures/<id>.png.
    // The char texture bank holds data/char/<char><N>_bord.ssh (12 skins x 12 riders + a couple of
    // specials); each is the "SHPS" (old PS2) variant -> OldShapeHandler, decoding to a single 128x128
    // image whose shortname is literally 'bord' - the id board.mpf's deck materials reference. The
    // decoded skin is *2-brightened (BrightenImage) like the level/skybox/lightmap exports, undoing the
    // PS2 GS colour-doubling so the deck isn't half-bright. We name
    // the PNG after the bank (e.g. mac1.png, psymon3.png) so the Unity board picker can pick by rider.
    // Non-fatal if TEXPS2.BIG is absent (older/region discs) - the board just stays untextured.
    private int ExportBoardTextures(string iso, string outDir)
    {
        string texDir = Path.Combine(outDir, "BoardTextures");
        Directory.CreateDirectory(texDir);

        string work = Path.Combine(Path.GetTempPath(), "snowknife_bordtex_" + Guid.NewGuid().ToString("N"));
        string bigPath = Path.Combine(work, "TEXPS2.BIG");
        Directory.CreateDirectory(work);
        try
        {
            using (FileStream isoStream = File.OpenRead(iso))
            {
                CDReader cd = _iso.OpenIso(isoStream);
                var tex = _iso.FindIsoFile(cd, @"DATA\CHAR\TEXPS2.BIG");
                if (tex == null) { Log.Info("      (TEXPS2.BIG not in ISO - boards will stay untextured.)"); return 0; }
                using Stream s = tex.OpenRead();
                using FileStream d = File.Create(bigPath);
                s.CopyTo(d);
            }

            string membersDir = Path.Combine(work, "files");
            BIG.Extract(bigPath, membersDir);

            int count = 0;
            foreach (string ssh in Directory.GetFiles(membersDir, "*_bord.ssh", SearchOption.AllDirectories))
            {
                // boardId = the file name minus "_bord.ssh" (e.g. "mac1", "psymon3").
                string boardId = Path.GetFileName(ssh);
                boardId = boardId.Substring(0, boardId.Length - "_bord.ssh".Length);
                try
                {
                    var shape = new OldShapeHandler();
                    shape.LoadShape(ssh);
                    if (shape.ShapeImages.Count == 0) continue;
                    // PS2 GS doubles texture colour at draw (stored 0x80 == 1.0), so the on-disc
                    // skins are half-bright. Apply the same *2 brighten the level/skybox/lightmap
                    // exports use (TrickyLevelInterface), else every bord skin caps at 128 and looks dim.
                    shape.BrightenImage(0);
                    shape.ExtractSingleImage(Path.Combine(texDir, boardId + ".png"), 0);
                    count++;
                }
                catch (Exception ex) { Log.Error($"      skip {boardId}: {ex.Message}"); }
            }
            // Decode-time premultiply fix (TextureFinish) - BoardTextures ships finished like every set.
            TextureFinish.FinishDir(texDir);
            return count;
        }
        finally { try { if (Directory.Exists(work)) Directory.Delete(work, true); } catch { } }
    }

    // Pull DATA\CHAR\MDLPS2.BIG (the PS2 character model archive) out of the ISO and unpack
    // it; members land under <filesDir>\data\char\*.mpf. Shared by `rider` and `board`.
    private string ExtractCharBig(string iso, out string filesDir)
    {
        string work = Path.Combine(Path.GetTempPath(), "snowknife_char_" + Guid.NewGuid().ToString("N"));
        filesDir = Path.Combine(work, "files");
        Directory.CreateDirectory(filesDir);

        string bigPath = Path.Combine(work, "MDLPS2.BIG");
        Log.Info("[1/3] Reading DATA\\CHAR\\MDLPS2.BIG from ISO...");
        using (FileStream isoStream = File.OpenRead(iso))
        {
            CDReader cd = _iso.OpenIso(isoStream);
            var mdl = _iso.FindIsoFile(cd, @"DATA\CHAR\MDLPS2.BIG")
                      ?? throw new FileNotFoundException("Could not find DATA\\CHAR\\MDLPS2.BIG in the ISO.");
            using Stream src = mdl.OpenRead();
            using FileStream dst = File.Create(bigPath);
            src.CopyTo(dst);
        }

        Log.Info($"[2/3] Unpacking ({BIG.GetBigType(bigPath)})...");
        BIG.Extract(bigPath, filesDir);
        return work;
    }

    // Pull DATA\CHAR\V_MDLPS2.BIG (the On Tour vehicle/equipment model archive - skis, poles,
    // boards) out of the ISO and unpack it; members land under <filesDir>\vehicles_*.mpf.
    private string ExtractOnTourVehicleBig(string iso, out string filesDir)
    {
        string work = Path.Combine(Path.GetTempPath(), "snowknife_veh_" + Guid.NewGuid().ToString("N"));
        filesDir = Path.Combine(work, "files");
        Directory.CreateDirectory(filesDir);

        string bigPath = Path.Combine(work, "V_MDLPS2.BIG");
        Log.Info("[1/4] Reading DATA\\CHAR\\V_MDLPS2.BIG from ISO...");
        using (FileStream isoStream = File.OpenRead(iso))
        {
            CDReader cd = _iso.OpenIso(isoStream);
            var mdl = _iso.FindIsoFile(cd, @"DATA\CHAR\V_MDLPS2.BIG")
                      ?? throw new FileNotFoundException("Could not find DATA\\CHAR\\V_MDLPS2.BIG in the ISO (is this the SSX On Tour disc?).");
            using Stream src = mdl.OpenRead();
            using FileStream dst = File.Create(bigPath);
            src.CopyTo(dst);
        }

        Log.Info($"[2/4] Unpacking ({BIG.GetBigType(bigPath)})...");
        BIG.Extract(bigPath, filesDir);
        return work;
    }

    // Decode every ski skin out of DATA\CHAR\TEXPS2.BIG into <outDir>/SkiTextures/<id>.png.
    // On Tour stores them as data/char/skis_<brand>_NNN.ssh - the "ShpS" (old PS2) shape
    // variant, like the Tricky board skins - each a single 128x128 image whose shortname is
    // 'skis' (the code the ski model's material references). The decoded skin is *2-brightened
    // (BrightenImage), undoing the PS2 GS colour-doubling so it isn't half-bright, and named
    // after the bank (e.g. skis_Armada_006.png) so a picker can choose by brand.
    // Non-fatal if TEXPS2.BIG is absent - the ski just stays untextured.
    private int ExportSkiTextures(string iso, string outDir)
    {
        string texDir = Path.Combine(outDir, "SkiTextures");
        Directory.CreateDirectory(texDir);

        string work = Path.Combine(Path.GetTempPath(), "snowknife_skitex_" + Guid.NewGuid().ToString("N"));
        string bigPath = Path.Combine(work, "TEXPS2.BIG");
        Directory.CreateDirectory(work);
        try
        {
            using (FileStream isoStream = File.OpenRead(iso))
            {
                CDReader cd = _iso.OpenIso(isoStream);
                var tex = _iso.FindIsoFile(cd, @"DATA\CHAR\TEXPS2.BIG");
                if (tex == null) { Log.Info("      (TEXPS2.BIG not in ISO - skis will stay untextured.)"); return 0; }
                using Stream s = tex.OpenRead();
                using FileStream d = File.Create(bigPath);
                s.CopyTo(d);
            }

            string membersDir = Path.Combine(work, "files");
            BIG.Extract(bigPath, membersDir);

            int count = 0;
            foreach (string ssh in Directory.GetFiles(membersDir, "skis_*.ssh", SearchOption.AllDirectories))
            {
                string skiId = Path.GetFileName(ssh);
                skiId = skiId.Substring(0, skiId.Length - ".ssh".Length); // e.g. "skis_Armada_006"
                try
                {
                    // On Tour char skins are the mixed-case "ShpS" variant -> NewShapeHandler
                    // (the uppercase "SHPS" board skins use OldShapeHandler). NewShapeHandler
                    // already *2s the half-bright alpha at decode; the RGB half-bright is undone
                    // by BrightenSkiImage below so the skins match the board/level brightness.
                    var shape = new NewShapeHandler();
                    shape.LoadShape(ssh);
                    if (shape.ShapeImages.Count == 0) continue;
                    BrightenSkiImage(shape.ShapeImages[0].Image);
                    shape.ExtractSingleImage(Path.Combine(texDir, skiId + ".png"), 0);
                    count++;
                }
                catch (Exception ex) { Log.Error($"      skip {skiId}: {ex.Message}"); }
            }
            // Decode-time premultiply fix (TextureFinish) - SkiTextures ships finished like every set.
            TextureFinish.FinishDir(texDir);
            return count;
        }
        finally { try { if (Directory.Exists(work)) Directory.Delete(work, true); } catch { } }
    }

    // *2 the RGB to undo the PS2 GS half-bright store (NewShapeHandler already doubles the
    // alpha, OldShapeHandler.BrightenImage doubles both - this is the RGB half for the new
    // format). Clamped to 255, alpha left untouched.
    private static void BrightenSkiImage(SixLabors.ImageSharp.Image<SixLabors.ImageSharp.PixelFormats.Rgba32> img)
    {
        img.ProcessPixelRows(accessor =>
        {
            for (int y = 0; y < accessor.Height; y++)
            {
                var row = accessor.GetRowSpan(y);
                for (int x = 0; x < row.Length; x++)
                {
                    var p = row[x];
                    p.R = (byte)Math.Min(255, p.R * 2);
                    p.G = (byte)Math.Min(255, p.G * 2);
                    p.B = (byte)Math.Min(255, p.B * 2);
                    row[x] = p;
                }
            }
        });
    }
}
