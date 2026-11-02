using System.Globalization;
using System.Numerics;
using System.Text;

namespace Snowknife.Repack;

/// <summary>Supply the complete OBJ corner indexes required by the PS2 mesh writer.</summary>
internal static class PortableObj
{
    public static string ForTricky(string text)
    {
        var output = new StringBuilder();
        var positions = new List<Vector3>();
        var sourceUvs = new List<int>();
        var sourceNormals = new List<int>();
        int uvs = 0, normals = 0, defaultUv = 0;
        foreach (string line in text.Split('\n'))
        {
            string[] parts = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length == 0) continue;
            if (parts[0] == "v") positions.Add(new Vector3(Number(parts[1]), Number(parts[2]), Number(parts[3])));
            if (parts[0] == "vt") sourceUvs.Add(++uvs);
            if (parts[0] == "vn") sourceNormals.Add(++normals);
            if (parts[0] != "f") { output.AppendLine(line.TrimEnd('\r')); continue; }
            var corners = parts.Skip(1).TakeWhile(part => !part.StartsWith('#')).Select(part => part.Split('/')).ToArray();
            for (int i = 1; i + 1 < corners.Length; i++)
            {
                var triangle = new[] { corners[0], corners[i], corners[i + 1] };
                int[] vertices = triangle.Select(corner => Index(corner[0], positions.Count)).ToArray();
                int generatedNormal = 0;
                if (triangle.Any(corner => corner.Length < 3 || corner[2].Length == 0))
                {
                    Vector3 normal = Vector3.Cross(positions[vertices[1] - 1] - positions[vertices[0] - 1], positions[vertices[2] - 1] - positions[vertices[0] - 1]);
                    normal = normal.LengthSquared() > 1e-12f ? Vector3.Normalize(normal) : Vector3.UnitZ;
                    output.AppendLine(FormattableString.Invariant($"vn {normal.X:R} {normal.Y:R} {normal.Z:R}"));
                    generatedNormal = ++normals;
                }
                if (defaultUv == 0 && triangle.Any(corner => corner.Length < 2 || corner[1].Length == 0))
                { output.AppendLine("vt 0 0"); defaultUv = ++uvs; }
                output.Append('f');
                for (int c = 0; c < 3; c++)
                {
                    string[] corner = triangle[c];
                    int uv = corner.Length > 1 && corner[1].Length > 0 ? sourceUvs[Index(corner[1], sourceUvs.Count) - 1] : defaultUv;
                    int normal = corner.Length > 2 && corner[2].Length > 0 ? sourceNormals[Index(corner[2], sourceNormals.Count) - 1] : generatedNormal;
                    output.Append(CultureInfo.InvariantCulture, $" {vertices[c]}/{uv}/{normal}");
                }
                output.AppendLine();
            }
        }
        return output.ToString();
    }

    private static float Number(string value) => float.Parse(value, CultureInfo.InvariantCulture);
    private static int Index(string value, int count)
    {
        int index = int.Parse(value, CultureInfo.InvariantCulture);
        index = index < 0 ? count + index + 1 : index;
        return index >= 1 && index <= count ? index : throw new InvalidDataException("OBJ corner index is outside its table.");
    }
}
