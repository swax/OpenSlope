#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace OpenSlope.Importer
{

    // Minimal, dependency-free GLB reader for the snowknife gltf. We author the .glb ourselves
    // (GltfMeshWriter), so this only needs to handle the exact structure snowknife emits: a single
    // binary buffer, float POSITION/NORMAL/TEXCOORD, FLOAT or normalized-byte COLOR_0, and
    // USHORT/UINT indices, with interleaved bufferViews (byteStride) supported.
    //
    // It returns geometry in SSX "mesh space" (raw units, X negated, Z up) - the inverse of the
    // writer's canonical mesh-space -> glTF transform - so a loaded mesh dropped under the importer's
    // Level(-90X, 0.01) child lands in the correct SSX world position:
    //     glTF (Y-up, m)  ->  mesh space:  pos = (x, z, y) / scale ;  normal = (x, z, y)
    //     UV V is flipped (glTF top-left -> Unity bottom-left).
    // This is what lets snowknife own the geometry while the Unity importer just loads it.
    public static class GlbMeshLoader
    {
        public sealed class Prim
        {
            public string Material = "__untextured";
            public Vector3[] Positions = Array.Empty<Vector3>();
            public Vector3[] Normals   = Array.Empty<Vector3>();
            public Vector2[] Uv0;
            public Vector2[] Uv1;
            public Color[]   Colors;
            public int[]     Indices = Array.Empty<int>();
        }
        public sealed class Node
        {
            public string Name = "";
            public List<Prim> Prims = new List<Prim>();
        }

        public static List<Node> Load(string glbPath, float scale)
        {
            byte[] bytes = File.ReadAllBytes(glbPath);
            ParseGlb(bytes, out JObject gltf, out byte[] bin);

            var accessors   = (JArray)gltf["accessors"];
            var bufferViews = (JArray)gltf["bufferViews"];
            var materials   = gltf["materials"] as JArray;
            var meshes      = (JArray)gltf["meshes"];

            var nodes = new List<Node>();
            foreach (var m in meshes)
            {
                var node = new Node { Name = (string)m["name"] ?? "" };
                foreach (var prim in (JArray)m["primitives"])
                {
                    var attrs = (JObject)prim["attributes"];
                    var p = new Prim();
                    int matIdx = prim["material"] != null ? (int)prim["material"] : -1;
                    if (matIdx >= 0 && materials != null) p.Material = (string)materials[matIdx]["name"] ?? "__untextured";

                    p.Positions = ReadVec3(accessors, bufferViews, bin, (int)attrs["POSITION"], scale, position: true);
                    if (attrs["NORMAL"] != null) p.Normals = ReadVec3(accessors, bufferViews, bin, (int)attrs["NORMAL"], scale, position: false);
                    if (attrs["TEXCOORD_0"] != null) p.Uv0 = ReadVec2Uv(accessors, bufferViews, bin, (int)attrs["TEXCOORD_0"]);
                    if (attrs["TEXCOORD_1"] != null) p.Uv1 = ReadVec2Uv(accessors, bufferViews, bin, (int)attrs["TEXCOORD_1"]);
                    if (attrs["COLOR_0"] != null) p.Colors = ReadColor(accessors, bufferViews, bin, (int)attrs["COLOR_0"]);
                    if (prim["indices"] != null) p.Indices = ReadIndices(accessors, bufferViews, bin, (int)prim["indices"]);

                    // The glTF->mesh-space transform (ReadVec3) swaps Y/Z, a REFLECTION (det = -1) that reverses
                    // triangle facing. Reverse the winding here to restore it, so a MeshCollider built from these
                    // triangles has its front face pointing UP and a downward raycast hits it (the spawn/ground probe
                    // + the board's ground-find rely on this; without it the collider faces DOWN and down-rays pass
                    // straight through). Render meshes are drawn double-sided with their own loaded normals, so the
                    // winding is invisible to them; this only matters for the position/winding-defined collision meshes.
                    for (int i = 0; i + 2 < p.Indices.Length; i += 3)
                        { int t = p.Indices[i + 1]; p.Indices[i + 1] = p.Indices[i + 2]; p.Indices[i + 2] = t; }

                    node.Prims.Add(p);
                }
                nodes.Add(node);
            }
            return nodes;
        }

        // ---- GLB container ----
        static void ParseGlb(byte[] b, out JObject gltf, out byte[] bin)
        {
            if (BitConverter.ToUInt32(b, 0) != 0x46546C67u) throw new Exception("not a GLB (bad magic)");
            int len = BitConverter.ToInt32(b, 8);
            int o = 12;
            gltf = null; bin = Array.Empty<byte>();
            while (o + 8 <= len)
            {
                int clen = BitConverter.ToInt32(b, o);
                uint ctype = BitConverter.ToUInt32(b, o + 4);
                int cstart = o + 8;
                if (ctype == 0x4E4F534Au)        // "JSON"
                    gltf = JObject.Parse(System.Text.Encoding.UTF8.GetString(b, cstart, clen));
                else if (ctype == 0x004E4942u)   // "BIN\0"
                {
                    bin = new byte[clen];
                    Array.Copy(b, cstart, bin, 0, clen);
                }
                o = cstart + ((clen + 3) & ~3);  // chunks are 4-byte aligned
            }
            if (gltf == null) throw new Exception("GLB has no JSON chunk");
        }

        // ---- accessors ----
        static void View(JArray accessors, JArray bufferViews, int accIdx,
                         out int baseOff, out int stride, out int count, out int compType, out int numComp)
        {
            var acc = accessors[accIdx];
            int bvIdx = (int)acc["bufferView"];
            int accOff = acc["byteOffset"] != null ? (int)acc["byteOffset"] : 0;
            count = (int)acc["count"];
            compType = (int)acc["componentType"];
            numComp = TypeComponents((string)acc["type"]);
            var bv = bufferViews[bvIdx];
            int bvOff = bv["byteOffset"] != null ? (int)bv["byteOffset"] : 0;
            int bvStride = bv["byteStride"] != null ? (int)bv["byteStride"] : 0;
            baseOff = bvOff + accOff;
            stride = bvStride > 0 ? bvStride : numComp * CompSize(compType);
        }

        static Vector3[] ReadVec3(JArray accessors, JArray bufferViews, byte[] bin, int accIdx, float scale, bool position)
        {
            View(accessors, bufferViews, accIdx, out int baseOff, out int stride, out int count, out int ct, out _);
            var outv = new Vector3[count];
            float inv = position ? 1f / scale : 1f;
            for (int i = 0; i < count; i++)
            {
                int o = baseOff + i * stride;
                float x = BitConverter.ToSingle(bin, o);
                float y = BitConverter.ToSingle(bin, o + 4);
                float z = BitConverter.ToSingle(bin, o + 8);
                // glTF (Y-up) -> mesh space (Z-up): swap Y/Z; positions also undo the metre scale.
                var v = new Vector3(x * inv, z * inv, y * inv);
                outv[i] = position ? v : (v.sqrMagnitude > 1e-12f ? v.normalized : Vector3.up);
            }
            return outv;
        }

        static Vector2[] ReadVec2Uv(JArray accessors, JArray bufferViews, byte[] bin, int accIdx)
        {
            View(accessors, bufferViews, accIdx, out int baseOff, out int stride, out int count, out int ct, out _);
            var outv = new Vector2[count];
            for (int i = 0; i < count; i++)
            {
                int o = baseOff + i * stride;
                float u = BitConverter.ToSingle(bin, o);
                float v = BitConverter.ToSingle(bin, o + 4);
                outv[i] = new Vector2(u, 1f - v);   // glTF top-left -> Unity bottom-left
            }
            return outv;
        }

        static Color[] ReadColor(JArray accessors, JArray bufferViews, byte[] bin, int accIdx)
        {
            View(accessors, bufferViews, accIdx, out int baseOff, out int stride, out int count, out int ct, out int nc);
            var outv = new Color[count];
            for (int i = 0; i < count; i++)
            {
                int o = baseOff + i * stride;
                float r, g, b, a = 1f;
                if (ct == 5126) // float
                {
                    r = BitConverter.ToSingle(bin, o);
                    g = BitConverter.ToSingle(bin, o + 4);
                    b = BitConverter.ToSingle(bin, o + 8);
                    if (nc == 4) a = BitConverter.ToSingle(bin, o + 12);
                }
                else if (ct == 5121) // unsigned byte normalized
                {
                    r = bin[o] / 255f; g = bin[o + 1] / 255f; b = bin[o + 2] / 255f;
                    if (nc == 4) a = bin[o + 3] / 255f;
                }
                else // 5123 unsigned short normalized
                {
                    r = BitConverter.ToUInt16(bin, o) / 65535f;
                    g = BitConverter.ToUInt16(bin, o + 2) / 65535f;
                    b = BitConverter.ToUInt16(bin, o + 4) / 65535f;
                    if (nc == 4) a = BitConverter.ToUInt16(bin, o + 6) / 65535f;
                }
                outv[i] = new Color(r, g, b, a);
            }
            return outv;
        }

        static int[] ReadIndices(JArray accessors, JArray bufferViews, byte[] bin, int accIdx)
        {
            View(accessors, bufferViews, accIdx, out int baseOff, out int stride, out int count, out int ct, out _);
            var outv = new int[count];
            for (int i = 0; i < count; i++)
            {
                int o = baseOff + i * stride;
                outv[i] = ct == 5125 ? (int)BitConverter.ToUInt32(bin, o)
                        : ct == 5123 ? BitConverter.ToUInt16(bin, o)
                        : bin[o];
            }
            return outv;
        }

        static int TypeComponents(string t) => t switch { "SCALAR" => 1, "VEC2" => 2, "VEC3" => 3, "VEC4" => 4, "MAT4" => 16, _ => 1 };
        static int CompSize(int ct) => ct switch { 5120 => 1, 5121 => 1, 5122 => 2, 5123 => 2, 5125 => 4, 5126 => 4, _ => 4 };
    }
}
#endif
