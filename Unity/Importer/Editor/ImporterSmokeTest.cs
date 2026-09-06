#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.TestTools;

namespace OpenSlope.Importer
{

    // Batch-mode integration test for the neutral importer. The repository-side PowerShell driver exports an
    // authored Slopesmith fixture, bakes/stages it with snowknife, syncs this source into a real Unity project, then
    // invokes Run with -executeMethod. Keeping the driver here means the test exercises the exact source authors
    // copy into their project; it has no NUnit/package dependency and works with Unity's built-in Coverage API.
    [ExcludeFromCoverage]
    public static class ImporterSmokeTest
    {
        const string LevelArg = "-openslopeTestLevel";
        const string ResultArg = "-openslopeTestResult";
        const string ImporterPath = "/Importer/";
        const string SmokeFileName = "/Editor/ImporterSmokeTest.cs";

        static readonly List<string> Errors = new List<string>();

        // Unity command-line entry point. A non-zero Editor exit is deliberate: the outer script treats scene
        // assertion failures and importer Debug.LogError calls exactly like ordinary test failures.
        public static void Run()
        {
            string levelFolder = Arg(LevelArg);
            string resultPath = Arg(ResultArg);
            var result = new ImporterSmokeResult
            {
                unityVersion = Application.unityVersion,
                levelFolder = levelFolder,
                startedUtc = DateTime.UtcNow.ToString("O"),
            };

            if (string.IsNullOrEmpty(resultPath))
                resultPath = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Application.dataPath), "openslope-importer-result.json"));

            Errors.Clear();
            Application.logMessageReceived += CaptureError;
            try
            {
                if (string.IsNullOrEmpty(levelFolder))
                    throw new ArgumentException("Missing " + LevelArg + " <Assets/...> command-line argument.");
                if (!levelFolder.Replace('\\', '/').StartsWith("Assets/", StringComparison.OrdinalIgnoreCase))
                    throw new ArgumentException(LevelArg + " must be a project-relative Assets/... folder: " + levelFolder);

                string manifest = Path.Combine(Path.GetDirectoryName(Application.dataPath), levelFolder, "gltf", "manifest.json");
                if (!File.Exists(manifest)) throw new FileNotFoundException("Staged bundle manifest not found", manifest);

                EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);

                if (!Coverage.enabled)
                    throw new InvalidOperationException("Unity coverage is disabled; launch with -enableCodeCoverage.");
                Coverage.ResetAll();

                var cfg = ImportConfig.For(levelFolder);
                new LevelImporter(cfg).Import();

                ValidateScene(cfg, result);
                result.coverage = CollectCoverage();
                Check(result, result.coverage.totalLines > 0, "coverage",
                    "Unity returned no Importer sequence points; ensure -enableCodeCoverage is active.");
            }
            catch (Exception ex)
            {
                Errors.Add(ex.GetType().Name + ": " + ex.Message);
                result.exception = ex.ToString();
            }
            finally
            {
                Application.logMessageReceived -= CaptureError;
            }

            result.errors = Errors.Distinct().ToArray();
            result.passed = result.errors.Length == 0 && result.assertions.All(a => a.passed);
            result.finishedUtc = DateTime.UtcNow.ToString("O");

            string parent = Path.GetDirectoryName(resultPath);
            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            File.WriteAllText(resultPath, JsonUtility.ToJson(result, true) + Environment.NewLine);

            string coverage = result.coverage == null
                ? "coverage unavailable"
                : string.Format("{0}/{1} lines ({2:0.00}%), {3}/{4} methods ({5:0.00}%)",
                    result.coverage.coveredLines, result.coverage.totalLines, result.coverage.linePercent,
                    result.coverage.coveredMethods, result.coverage.totalMethods, result.coverage.methodPercent);
            if (result.passed)
            {
                Debug.Log("OpenSlope UNITY TEST PASS: " + result.scene.gameObjects + " objects, " + result.scene.meshColliders
                    + " mesh colliders, " + result.scene.markers + " neutral markers; " + coverage + ".");
                EditorApplication.Exit(0);
            }
            else
            {
                Debug.LogError("OpenSlope UNITY TEST FAIL: " + string.Join(" | ", result.errors) + " (" + coverage + ")");
                EditorApplication.Exit(1);
            }
        }

        static void ValidateScene(ImportConfig cfg, ImporterSmokeResult result)
        {
            GameObject root = GameObject.Find(cfg.RootName);
            Check(result, root != null, "root", "Importer did not create " + cfg.RootName + ".");
            if (root == null) return;

            Transform level = root.transform.Find(cfg.LevelName);
            Transform collision = root.transform.Find(MapLayout.CollisionName);
            Transform locations = root.transform.Find(MapLayout.LocationsName);
            Transform terrain = level == null ? null : level.Find("Terrain");
            MapIdentity identity = root.GetComponent<MapIdentity>();

            Check(result, RootIsIdentity(root.transform), "identity root", cfg.RootName + " must remain at identity.");
            Check(result, identity != null && identity.SchemaVersion == MapIdentity.CurrentSchemaVersion,
                "map identity", "Importer did not stamp the current MapIdentity schema on " + cfg.RootName + ".");
            Check(result, identity != null && string.Equals(identity.LevelFolder, cfg.LevelFolder.Replace('\\', '/').TrimEnd('/'),
                    StringComparison.OrdinalIgnoreCase),
                "map source identity", "MapIdentity does not carry the imported level folder.");
            string planPath = Path.Combine(Path.GetDirectoryName(Application.dataPath), cfg.LevelFolder, "autotest-plan.json");
            Check(result, identity != null && identity.AutoTestPlan == File.Exists(planPath),
                "autotest identity", "MapIdentity autotest flag does not match the staged autotest-plan.json.");
            Check(result, level != null, "level", cfg.RootName + "/" + cfg.LevelName + " is missing.");
            Check(result, terrain != null && terrain.GetComponent<MeshFilter>() != null
                && terrain.GetComponent<MeshFilter>().sharedMesh != null, "terrain mesh", "Imported terrain mesh is missing.");
            Check(result, collision != null, "collision root", "Top-level collision anchor is missing.");
            Check(result, locations != null && locations.Find(MapLayout.PlayerSpawn) != null,
                "player spawn", "PlayerSpawn anchor is missing.");
            Check(result, locations != null && locations.Find(MapLayout.GateSpawn) != null,
                "gate spawn", "GateSpawn anchor is missing.");
            Check(result, AssetDatabase.LoadAssetAtPath<Mesh>(cfg.TerrainMeshPath) != null,
                "terrain asset", "Terrain mesh asset was not persisted.");

            Transform[] transforms = root.GetComponentsInChildren<Transform>(true);
            result.scene.gameObjects = transforms.Length;
            result.scene.renderers = root.GetComponentsInChildren<Renderer>(true).Length;
            result.scene.meshFilters = root.GetComponentsInChildren<MeshFilter>(true).Length;
            result.scene.meshColliders = root.GetComponentsInChildren<MeshCollider>(true).Length;
            result.scene.markers = root.GetComponentsInChildren<Marker>(true).Length;
            result.scene.materials = root.GetComponentsInChildren<Renderer>(true)
                .SelectMany(r => r.sharedMaterials).Where(m => m != null).Distinct().Count();

            // A neutral import must still open in one coherent retail mode before a platform selector runs:
            // Showoff by default, or Freeride when the legacy preview override is explicitly enabled.
            ModeVisibilityMarker[] modeMarkers = root.GetComponentsInChildren<ModeVisibilityMarker>(true);
            int previewBit = cfg.GateShowoffRails ? 4 : 2;
            int wrongModePresence = modeMarkers.Count(marker =>
                marker.gameObject.activeSelf != ((marker.ModeMask & previewBit) != 0));

            int missingScripts = 0;
            foreach (Transform transform in transforms)
                missingScripts += transform.GetComponents<Component>().Count(component => component == null);
            result.scene.missingScripts = missingScripts;

            Check(result, result.scene.gameObjects > 5, "populated hierarchy", "Imported hierarchy is unexpectedly empty.");
            Check(result, result.scene.renderers > 0, "renderers", "Importer produced no renderers.");
            Check(result, result.scene.meshColliders > 0, "colliders", "Importer produced no terrain collision.");
            Check(result, result.scene.markers > 0, "markers", "Autotest fixture produced no neutral platform markers.");
            Check(result, wrongModePresence == 0, "default mode preview",
                wrongModePresence + " mode-gated object(s) do not match the imported "
                + (cfg.GateShowoffRails ? "Freeride" : "Showoff") + " preview.");
            Check(result, missingScripts == 0, "scripts", missingScripts + " missing script component(s) found.");
            ValidateSunGlareContract(result);

            if (Errors.Count > 0)
                Check(result, false, "import logs", "Importer emitted " + Errors.Count + " error/exception log(s).");
        }

        static void ValidateSunGlareContract(ImporterSmokeResult result)
        {
            Shader shader = Shader.Find("OpenSlope/SunGodRays");
            Material material = shader == null ? null : new Material(shader);
            bool currentShader = material != null
                && material.HasProperty("_FanIntensity")
                && material.HasProperty("_SpriteIntensity")
                && material.HasProperty("_CoronaRadius")
                && material.HasProperty("_CoronaTex")
                && HasVectorProperty(shader, "_CoreColor")
                && HasVectorProperty(shader, "_RimColor")
                && !material.HasProperty("_CoreBoost");
            Check(result, currentShader, "sun glare shader contract",
                "OpenSlope/SunGodRays does not expose the retail fan/corona properties as raw vectors, or still exposes the synthetic core.");
            if (material != null) UnityEngine.Object.DestroyImmediate(material);

            Check(result,
                Mathf.Abs(SunGodRaysBuilder.FanDisplayGain - 128f / 255f) < 0.000001f
                && Mathf.Abs(SunGodRaysBuilder.CoronaDisplayGain - 255f / 128f) < 0.000001f,
                "sun glare GS gains", "Sun glare transfer gains no longer match the captured GS paths.");

            Mesh mesh = SunGodRaysBuilder.BuildGlareMesh();
            try
            {
                Vector3[] vertices = mesh.vertices;
                Vector2[] uv = mesh.uv;
                bool coronaQuad = vertices.Length == 112 && uv.Length == vertices.Length && mesh.triangles.Length == 114;
                for (int i = Mathf.Max(0, vertices.Length - 4); i < vertices.Length && coronaQuad; i++)
                    coronaQuad = vertices[i].z == 1f && uv[i].x >= 0.5f && uv[i].y >= 0.5f;
                Check(result, coronaQuad, "sun glare corona mesh",
                    "Sun glare mesh must append one z-tagged quad selecting the lens atlas's top-right quadrant.");
            }
            finally { UnityEngine.Object.DestroyImmediate(mesh); }
        }

        static bool RootIsIdentity(Transform root)
        {
            return root.position.sqrMagnitude < 0.000001f
                && Quaternion.Angle(root.rotation, Quaternion.identity) < 0.001f
                && (root.localScale - Vector3.one).sqrMagnitude < 0.000001f;
        }

        static void Check(ImporterSmokeResult result, bool passed, string name, string failure)
        {
            result.assertions.Add(new ImporterAssertion { name = name, passed = passed, message = passed ? "" : failure });
            if (!passed) Errors.Add(name + ": " + failure);
        }

        static void CaptureError(string condition, string stackTrace, LogType type)
        {
            if (type == LogType.Error || type == LogType.Assert || type == LogType.Exception)
                Errors.Add(type + ": " + condition);
        }

        static string Arg(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 0; i + 1 < args.Length; i++)
                if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
            return "";
        }

        static ImporterCoverage CollectCoverage()
        {
            var files = new Dictionary<string, MutableFileCoverage>(StringComparer.OrdinalIgnoreCase);
            var methodKeys = new HashSet<string>(StringComparer.Ordinal);
            var coveredMethodKeys = new HashSet<string>(StringComparer.Ordinal);
            var sequenceKeys = new HashSet<string>(StringComparer.Ordinal);
            var coveredSequenceKeys = new HashSet<string>(StringComparer.Ordinal);

            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                string assemblyName = assembly.GetName().Name;
                if (!assemblyName.StartsWith("Assembly-CSharp", StringComparison.Ordinal)) continue;

                foreach (Type type in SafeTypes(assembly))
                {
                    var methods = new List<MethodBase>();
                    const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance
                        | BindingFlags.Static | BindingFlags.DeclaredOnly;
                    try
                    {
                        methods.AddRange(type.GetMethods(flags));
                        methods.AddRange(type.GetConstructors(flags));
                    }
                    catch { continue; }

                    foreach (MethodBase method in methods)
                    {
                        CoveredSequencePoint[] points;
                        try { points = Coverage.GetSequencePointsFor(method); }
                        catch { continue; }
                        if (points == null || points.Length == 0) continue;

                        string methodKey = assemblyName + "|" + type.FullName + "|" + method.MetadataToken;
                        bool importerMethod = false;
                        bool methodCovered = false;
                        foreach (CoveredSequencePoint point in points)
                        {
                            string file = NormalFile(point.filename);
                            if (!IsImporterFile(file) || point.line <= 0 || point.line >= 0xFEEFEE) continue;
                            importerMethod = true;
                            bool hit = point.hitCount > 0;
                            methodCovered |= hit;

                            MutableFileCoverage item;
                            if (!files.TryGetValue(file, out item)) files[file] = item = new MutableFileCoverage(file);
                            string sequenceKey = methodKey + "|" + point.ilOffset;
                            string lineKey = file + "|" + point.line;
                            if (sequenceKeys.Add(sequenceKey)) item.totalSequencePoints++;
                            if (hit && coveredSequenceKeys.Add(sequenceKey)) item.coveredSequencePoints++;
                            item.totalLines.Add(lineKey);
                            if (hit) item.coveredLines.Add(lineKey);
                        }
                        if (importerMethod) methodKeys.Add(methodKey);
                        if (importerMethod && methodCovered) coveredMethodKeys.Add(methodKey);
                    }
                }
            }

            var report = new ImporterCoverage();
            report.totalMethods = methodKeys.Count;
            report.coveredMethods = coveredMethodKeys.Count;
            report.files = files.Values.OrderBy(f => f.file, StringComparer.OrdinalIgnoreCase).Select(f => f.Freeze()).ToArray();
            report.totalLines = report.files.Sum(f => f.totalLines);
            report.coveredLines = report.files.Sum(f => f.coveredLines);
            report.totalSequencePoints = report.files.Sum(f => f.totalSequencePoints);
            report.coveredSequencePoints = report.files.Sum(f => f.coveredSequencePoints);
            report.linePercent = Percent(report.coveredLines, report.totalLines);
            report.methodPercent = Percent(report.coveredMethods, report.totalMethods);
            report.sequencePointPercent = Percent(report.coveredSequencePoints, report.totalSequencePoints);
            return report;
        }

        static IEnumerable<Type> SafeTypes(Assembly assembly)
        {
            try { return assembly.GetTypes(); }
            catch (ReflectionTypeLoadException ex) { return ex.Types.Where(t => t != null); }
            catch { return new Type[0]; }
        }

        static string NormalFile(string path) => string.IsNullOrEmpty(path) ? "" : path.Replace('\\', '/');

        static bool IsImporterFile(string file)
        {
            return file.IndexOf(ImporterPath, StringComparison.OrdinalIgnoreCase) >= 0
                && !file.EndsWith(SmokeFileName, StringComparison.OrdinalIgnoreCase);
        }

        static float Percent(int covered, int total) => total == 0 ? 0f : (float)Math.Round(covered * 100.0 / total, 2);

        sealed class MutableFileCoverage
        {
            public readonly string file;
            public readonly HashSet<string> totalLines = new HashSet<string>(StringComparer.Ordinal);
            public readonly HashSet<string> coveredLines = new HashSet<string>(StringComparer.Ordinal);
            public int totalSequencePoints;
            public int coveredSequencePoints;

            public MutableFileCoverage(string absoluteFile)
            {
                int at = absoluteFile.IndexOf(ImporterPath, StringComparison.OrdinalIgnoreCase);
                file = at < 0 ? absoluteFile : absoluteFile.Substring(at + 1);
            }

            public ImporterFileCoverage Freeze()
            {
                return new ImporterFileCoverage
                {
                    file = file,
                    totalLines = totalLines.Count,
                    coveredLines = coveredLines.Count,
                    linePercent = Percent(coveredLines.Count, totalLines.Count),
                    totalSequencePoints = totalSequencePoints,
                    coveredSequencePoints = coveredSequencePoints,
                    sequencePointPercent = Percent(coveredSequencePoints, totalSequencePoints),
                };
            }
        }

        // These values are normalized GS display bytes, not Unity colours. ShaderLab Color properties are
        // converted before the shader in a linear project even when assigned through Material.SetVector, which
        // darkens the corona enough that it no longer washes out the fan convergence.
        static bool HasVectorProperty(Shader shader, string name)
        {
            if (shader == null) return false;
            int count = ShaderUtil.GetPropertyCount(shader);
            for (int i = 0; i < count; i++)
                if (ShaderUtil.GetPropertyName(shader, i) == name)
                    return ShaderUtil.GetPropertyType(shader, i) == ShaderUtil.ShaderPropertyType.Vector;
            return false;
        }
    }

    [Serializable]
    public sealed class ImporterSmokeResult
    {
        public bool passed;
        public string unityVersion;
        public string levelFolder;
        public string startedUtc;
        public string finishedUtc;
        public string exception;
        public string[] errors = new string[0];
        public List<ImporterAssertion> assertions = new List<ImporterAssertion>();
        public ImporterSceneCounts scene = new ImporterSceneCounts();
        public ImporterCoverage coverage;
    }

    [Serializable]
    public sealed class ImporterAssertion
    {
        public string name;
        public bool passed;
        public string message;
    }

    [Serializable]
    public sealed class ImporterSceneCounts
    {
        public int gameObjects;
        public int renderers;
        public int meshFilters;
        public int meshColliders;
        public int markers;
        public int materials;
        public int missingScripts;
    }

    [Serializable]
    public sealed class ImporterCoverage
    {
        public int totalLines;
        public int coveredLines;
        public float linePercent;
        public int totalMethods;
        public int coveredMethods;
        public float methodPercent;
        public int totalSequencePoints;
        public int coveredSequencePoints;
        public float sequencePointPercent;
        public ImporterFileCoverage[] files = new ImporterFileCoverage[0];
    }

    [Serializable]
    public sealed class ImporterFileCoverage
    {
        public string file;
        public int totalLines;
        public int coveredLines;
        public float linePercent;
        public int totalSequencePoints;
        public int coveredSequencePoints;
        public float sequencePointPercent;
    }
}
#endif
