#if UNITY_EDITOR
using System;
using System.IO;
using Newtonsoft.Json.Linq;

namespace OpenSlope.Importer
{

    /// <summary>
    /// Unity-side P1 reader for the shared Effects.json contract. P3 will compile supported graph nodes into
    /// Unity behavior; P1 deliberately stops at accepting and validating the same portable source document
    /// authored by Slopesmith and compiled back to SSF by Snowknife.
    /// </summary>
    public sealed class EffectsDocumentReader
    {
        readonly ImportConfig _cfg;

        public EffectsDocumentReader(ImportConfig cfg) { _cfg = cfg; }

        public bool Exists => File.Exists(_cfg.EffectsPath);

        public Summary Load()
        {
            if (!Exists) throw new FileNotFoundException("Effects.json was not found", _cfg.EffectsPath);
            var root = JObject.Parse(File.ReadAllText(_cfg.EffectsPath));
            // "swx-effects" is the pre-rename spelling, still on disk in Effects.json authored earlier.
            string kind = (string)root["kind"];
            if (kind != "openslope-effects" && kind != "swx-effects")
                throw new InvalidDataException("Effects.json kind must be 'openslope-effects'.");
            if ((int?)root["version"] != 1) throw new InvalidDataException("Effects.json version must be 1.");
            RequireArray(root, "slots");
            RequireArray(root, "graphs");
            RequireArray(root, "functions");
            RequireArray(root, "objectProperties");
            RequireArray(root, "instances");
            RequireArray(root, "physics");
            RequireArray(root, "collisionModels");
            RequireArray(root, "splines");
            return new Summary(
                ((JArray)root["graphs"]).Count,
                ((JArray)root["functions"]).Count,
                CountNodes((JArray)root["graphs"]) + CountNodes((JArray)root["functions"]),
                ((JArray)root["instances"]).Count);
        }

        static void RequireArray(JObject root, string name)
        {
            if (!(root[name] is JArray)) throw new InvalidDataException($"Effects.json {name} must be an array.");
        }

        static int CountNodes(JArray owners)
        {
            int count = 0;
            foreach (var token in owners)
                if (token is JObject owner && owner["nodes"] is JArray nodes) count += nodes.Count;
            return count;
        }

        public readonly struct Summary
        {
            public readonly int Graphs;
            public readonly int Functions;
            public readonly int Nodes;
            public readonly int Instances;
            public Summary(int graphs, int functions, int nodes, int instances)
            { Graphs = graphs; Functions = functions; Nodes = nodes; Instances = instances; }
        }
    }
}
#endif
