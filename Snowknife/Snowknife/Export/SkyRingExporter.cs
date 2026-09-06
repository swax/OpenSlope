using System.Buffers.Binary;
using System.Globalization;
using Newtonsoft.Json;
using Snowknife.Services;

namespace Snowknife.Export;

public sealed class SkyRingDocument
{
    public const string FileName = "Ring.json";
    public const string SchemaId = "openslope-sky-ring/v1";
    public string Schema { get; set; } = SchemaId;
    public double Radius { get; set; }
    public double TopZ { get; set; }
    public double MidZ { get; set; }
    public double BottomZ { get; set; }
    public int GroundIndex { get; set; }
    public double GroundUvRadius { get; set; }
    public List<SkyRingPanelDocument> Panels { get; set; } = new();
    public List<SkyRingTileDocument> Tiles { get; set; } = new();
}

public sealed class SkyRingPanelDocument
{
    public int Index { get; set; }
    public string Band { get; set; } = "";
    public double AzFrom { get; set; }
    public double AzTo { get; set; }
}

public sealed class SkyRingTileDocument
{
    public int Width { get; set; }
    public int Height { get; set; }
}

/// <summary>
/// Measures the portable sky composition metadata from an extracted ring and its texture pages.  Slopesmith
/// consumes this generated sidecar instead of carrying a second copy of the ring's dimensions or slot layout.
/// </summary>
internal static class SkyRingExporter
{
    private sealed record Vertex(double X, double Y, double Z, double U, double V);
    private sealed record Mesh(int Index, List<Vertex> Vertices)
    {
        public double MinZ => Vertices.Min(v => v.Z);
        public double MaxZ => Vertices.Max(v => v.Z);
    }

    public static SkyRingDocument Write(string skyDir, ContractValidationService contracts)
    {
        SkyRingDocument document = Extract(skyDir);
        string path = Path.Combine(skyDir, SkyRingDocument.FileName);
        string json = JsonConvert.SerializeObject(document, Formatting.Indented) + Environment.NewLine;
        contracts.RequireJson(json, ContractKind.SkyRingV1, path);
        File.WriteAllText(path, json);
        Log.Info($"  -> {path} ({document.Panels.Count} wall panel(s), ground slot {document.GroundIndex})");
        return document;
    }

    internal static SkyRingDocument Extract(string skyDir)
    {
        string meshDir = Path.Combine(skyDir, "Meshes");
        string textureDir = Path.Combine(skyDir, "Textures");
        var meshes = Directory.GetFiles(meshDir, "*.obj")
            .Select(path => (Path: path, Name: Path.GetFileNameWithoutExtension(path)))
            .Where(file => int.TryParse(file.Name, NumberStyles.None, CultureInfo.InvariantCulture, out _))
            .Select(file => ReadMesh(file.Path, int.Parse(file.Name, CultureInfo.InvariantCulture)))
            .OrderBy(mesh => mesh.Index).ToList();
        if (meshes.Count < 2) throw new InvalidDataException("Skybox/Meshes has no measurable ring.");

        const double flatTolerance = 0.01;
        List<Mesh> flat = meshes.Where(mesh => mesh.MaxZ - mesh.MinZ <= flatTolerance).ToList();
        List<Mesh> walls = meshes.Where(mesh => mesh.MaxZ - mesh.MinZ > flatTolerance).ToList();
        if (flat.Count != 1 || walls.Count == 0)
            throw new InvalidDataException("The sky ring must contain wall panels and exactly one flat ground mesh.");

        List<double> heights = Cluster(walls.SelectMany(mesh => mesh.Vertices).Select(v => v.Z), flatTolerance)
            .OrderByDescending(value => value).ToList();
        if (heights.Count != 3)
            throw new InvalidDataException($"The sky wall has {heights.Count} height bands; expected three measured levels.");
        double top = heights[0], mid = heights[1], bottom = heights[2];

        var panels = new List<SkyRingPanelDocument>();
        foreach (Mesh mesh in walls)
        {
            double uMin = mesh.Vertices.Min(v => v.U), uMax = mesh.Vertices.Max(v => v.U);
            Vertex from = mesh.Vertices.First(v => Math.Abs(v.U - uMin) < 1e-6);
            Vertex to = mesh.Vertices.First(v => Math.Abs(v.U - uMax) < 1e-6);
            string band = Math.Abs(mesh.MaxZ - top) <= flatTolerance ? "upper"
                : Math.Abs(mesh.MaxZ - mid) <= flatTolerance ? "lower"
                : throw new InvalidDataException($"Sky wall mesh {mesh.Index} does not meet a measured band height.");
            panels.Add(new SkyRingPanelDocument
            {
                Index = mesh.Index,
                Band = band,
                AzFrom = Azimuth(from),
                AzTo = Azimuth(to),
            });
        }

        int groundIndex = flat[0].Index;
        int lastIndex = meshes.Max(mesh => mesh.Index);
        if (meshes.Select(mesh => mesh.Index).Distinct().Count() != lastIndex + 1)
            throw new InvalidDataException("Sky mesh slots are not contiguous from zero.");
        var tiles = new List<SkyRingTileDocument>(lastIndex + 1);
        for (int index = 0; index <= lastIndex; index++)
        {
            string path = Path.Combine(textureDir, index.ToString("D4", CultureInfo.InvariantCulture) + ".png");
            var (width, height) = PngSize(path);
            tiles.Add(new SkyRingTileDocument { Width = width, Height = height });
        }

        Mesh ground = flat[0];
        double groundUvRadius = ground.Vertices.Max(v => Math.Sqrt(Math.Pow(v.U - 0.5, 2) + Math.Pow(v.V - 0.5, 2)));
        double radius = walls.SelectMany(mesh => mesh.Vertices)
            .Average(v => Math.Sqrt(v.X * v.X + v.Y * v.Y));
        if (!(radius > 0) || !(groundUvRadius > 0))
            throw new InvalidDataException("The sky ring has invalid measured radius or ground UVs.");

        return new SkyRingDocument
        {
            Radius = radius,
            TopZ = top,
            MidZ = mid,
            BottomZ = bottom,
            GroundIndex = groundIndex,
            GroundUvRadius = groundUvRadius,
            Panels = panels,
            Tiles = tiles,
        };
    }

    private static Mesh ReadMesh(string path, int index)
    {
        var positions = new List<(double X, double Y, double Z)>();
        var uvs = new List<(double U, double V)>();
        foreach (string raw in File.ReadLines(path))
        {
            string[] fields = raw.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (fields.Length >= 4 && fields[0] == "v")
                positions.Add((Parse(fields[1]), Parse(fields[2]), Parse(fields[3])));
            else if (fields.Length >= 3 && fields[0] == "vt")
                uvs.Add((Parse(fields[1]), Parse(fields[2])));
        }
        if (positions.Count == 0 || positions.Count != uvs.Count)
            throw new InvalidDataException($"Sky mesh {index} has no index-matched positions and UVs.");
        return new Mesh(index, positions.Select((p, i) => new Vertex(p.X, p.Y, p.Z, uvs[i].U, uvs[i].V)).ToList());
    }

    private static double Parse(string value) => double.Parse(value, NumberStyles.Float, CultureInfo.InvariantCulture);

    private static double Azimuth(Vertex vertex) => Math.Atan2(vertex.Y, vertex.X) * 180.0 / Math.PI;

    private static List<double> Cluster(IEnumerable<double> values, double tolerance)
    {
        var result = new List<double>();
        foreach (double value in values.Order())
        {
            int index = result.FindIndex(existing => Math.Abs(existing - value) <= tolerance);
            if (index < 0) result.Add(value);
            else result[index] = (result[index] + value) / 2;
        }
        return result;
    }

    private static (int Width, int Height) PngSize(string path)
    {
        byte[] header = new byte[24];
        using FileStream stream = File.OpenRead(path);
        stream.ReadExactly(header);
        ReadOnlySpan<byte> signature = new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 };
        if (!header.AsSpan(0, 8).SequenceEqual(signature))
            throw new InvalidDataException($"Sky texture is not a PNG: {path}");
        int width = checked((int)BinaryPrimitives.ReadUInt32BigEndian(header.AsSpan(16, 4)));
        int height = checked((int)BinaryPrimitives.ReadUInt32BigEndian(header.AsSpan(20, 4)));
        if (width <= 0 || height <= 0) throw new InvalidDataException($"Sky texture has invalid dimensions: {path}");
        return (width, height);
    }
}
