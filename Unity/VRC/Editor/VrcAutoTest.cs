#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using UnityEditor;
using UnityEngine;
using VRC.SDKBase;
using VRC.Udon;
using OpenSlope.Importer;

namespace OpenSlope.VrcPlugin
{

    // Guarded ClientSim integration runner for authored autotest maps. It deliberately operates only when OpenSlope_Map is
    // absent or carries an importer-written MapIdentity whose AutoTestPlan flag is true. This makes a stale command,
    // preference, or CI invocation unable to replace an ordinary/production map that happens to be open.
    //
    // The state lives in SessionState so UdonSharp compilation and the Edit -> Play -> Edit domain reloads can resume the
    // same run. Runtime driving goes through the compiled UdonBehaviour's public variables/custom events, exercising the
    // same board physics, RiderProbe, and trigger behaviours that ClientSim/VRChat run.
    [InitializeOnLoad]
    public static class VrcAutoTest
    {
        const string LevelArg = "-openslopeVrcTestLevel";
        const string ResultArg = "-openslopeVrcTestResult";
        const string ExitArg = "-openslopeVrcTestExit";
        const string SessionKey = "OpenSlope.VrcPlugin.AutoTest.Request.v1";
        const string RootName = "OpenSlope_Map";
        const double RetryDelaySeconds = 2.0;
        const double StageTimeoutSeconds = 600.0;
        const double ClientSimTimeoutSeconds = 45.0;
        const float CellSeconds = 4f;
        const int PositiveAttempts = 2;

        static RuntimeSession _runtime;
        static bool _pumping;

        static VrcAutoTest()
        {
            EditorApplication.update -= Pump;
            EditorApplication.update += Pump;
            Application.logMessageReceived -= CaptureError;
            Application.logMessageReceived += CaptureError;
        }

        [MenuItem("OpenSlope/Dev/Run VRChat ClientSim Map...", false, 900)]
        public static void RunFromMenu()
        {
            string projectRoot = ProjectRoot;
            string start = Path.Combine(projectRoot, "Assets", "Maps");
            if (!Directory.Exists(start)) start = Application.dataPath;
            string absolute = EditorUtility.OpenFolderPanel("Select an OpenSlope autotest map folder", start, "");
            if (string.IsNullOrEmpty(absolute)) return;

            string levelFolder = ToAssetsPath(absolute);
            if (string.IsNullOrEmpty(levelFolder))
            {
                EditorUtility.DisplayDialog("OpenSlope VRChat autotest", "The autotest folder must be inside this project's Assets folder.", "OK");
                return;
            }

            try
            {
                string fixture = ReadFixture(levelFolder);
                string result = Path.Combine(projectRoot, "Temp", "openslope-vrc-autotest-" + SafeName(fixture) + ".json");
                Start(levelFolder, result, false);
            }
            catch (Exception ex) { EditorUtility.DisplayDialog("OpenSlope VRChat autotest refused", ex.Message, "OK"); }
        }

        [MenuItem("OpenSlope/Dev/Run VRChat ClientSim Map...", true)]
        static bool RunFromMenuEnabled() => !EditorApplication.isPlayingOrWillChangePlaymode && LoadRequest() == null;

        // Unity -executeMethod entry point used by tools/test-vrc.ps1.
        public static void Run()
        {
            string levelFolder = Arg(LevelArg);
            string resultPath = Arg(ResultArg);
            if (string.IsNullOrEmpty(resultPath))
                resultPath = Path.Combine(ProjectRoot, "Temp", "openslope-vrc-autotest.json");
            resultPath = Path.GetFullPath(resultPath);
            bool exitWhenDone = HasArg(ExitArg);
            try
            {
                if (string.IsNullOrEmpty(levelFolder)) throw new ArgumentException("Missing " + LevelArg + " <Assets/...>.");
                Start(levelFolder, resultPath, exitWhenDone);
            }
            catch (Exception ex)
            {
                var result = new Result
                {
                    passed = false,
                    levelFolder = levelFolder ?? "",
                    unityVersion = Application.unityVersion,
                    scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().path,
                    startedUtc = DateTime.UtcNow.ToString("O"),
                    finishedUtc = DateTime.UtcNow.ToString("O"),
                    errors = new List<string> { ex.GetType().Name + ": " + ex.Message },
                };
                string parent = Path.GetDirectoryName(resultPath);
                if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
                File.WriteAllText(resultPath, JsonUtility.ToJson(result, true) + Environment.NewLine);
                Debug.LogException(ex);
                if (exitWhenDone) EditorApplication.Exit(1);
                else throw;
            }
        }

        static void Start(string levelFolder, string resultPath, bool exitWhenDone)
        {
            if (LoadRequest() != null) throw new InvalidOperationException("An OpenSlope VRChat autotest is already active in this editor session.");
            if (EditorApplication.isPlayingOrWillChangePlaymode) throw new InvalidOperationException("Exit Play Mode before starting the OpenSlope VRChat autotest.");

            levelFolder = NormalLevelFolder(levelFolder);
            string fixture = ReadFixture(levelFolder); // validates the plan before the scene safety decision
            AssertSafeScene(levelFolder);

            var request = new Request
            {
                active = true,
                stage = "import",
                levelFolder = levelFolder,
                fixture = fixture,
                resultPath = Path.GetFullPath(resultPath),
                exitWhenDone = exitWhenDone,
                startedUtc = DateTime.UtcNow.ToString("O"),
                stageStartedTicks = DateTime.UtcNow.Ticks,
                nextActionTicks = DateTime.UtcNow.Ticks,
            };
            SaveRequest(request);
            Debug.Log("OpenSlope VRCHAT AUTOTEST: starting fixture '" + fixture + "' from " + levelFolder + ".");
            Pump();
        }

        static void Pump()
        {
            if (_pumping) return;
            Request request = LoadRequest();
            if (request == null || !request.active) return;
            if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
            if (DateTime.UtcNow.Ticks < request.nextActionTicks) return;

            _pumping = true;
            try
            {
                if (StageAge(request) > StageTimeoutSeconds)
                    throw new TimeoutException("Timed out in VRChat autotest stage '" + request.stage + "'.");

                if (request.stage == "import") Import(request);
                else if (request.stage == "setup") Setup(request);
                else if (request.stage == "enter-play") EnterPlay(request);
                else if (request.stage == "runtime") RuntimeUpdate(request);
                else if (request.stage == "stop-play") StopPlay(request);
                else if (request.stage == "finish") Finish(request);
            }
            catch (Exception ex)
            {
                Fail(request, ex);
            }
            finally { _pumping = false; }
        }

        static void Import(Request request)
        {
            if (EditorApplication.isPlaying) throw new InvalidOperationException("Import stage unexpectedly entered Play Mode.");
            AssertSafeScene(request.levelFolder);

            GameObject root = GameObject.Find(RootName);
            if (IdentityMatches(root, request.levelFolder))
            {
                SetStage(request, "setup");
                return;
            }

            ImportAll.ImportFolder(request.levelFolder);
            root = GameObject.Find(RootName);
            if (IdentityMatches(root, request.levelFolder)) SetStage(request, "setup");
            else Retry(request, "import"); // first run may only create/finalize UdonSharp program assets
        }

        static void Setup(Request request)
        {
            if (EditorApplication.isPlaying) throw new InvalidOperationException("Setup stage unexpectedly entered Play Mode.");
            RequireTargetIdentity(request.levelFolder);
            if (SetupAll.RunForAutoTest()) SetStage(request, "enter-play");
            else Retry(request, "setup"); // freshly-created setup program assets require a compile/reload pass
        }

        static void EnterPlay(Request request)
        {
            RequireTargetIdentity(request.levelFolder);
            SetStage(request, "runtime");
            EditorApplication.isPlaying = true;
        }

        static void RuntimeUpdate(Request request)
        {
            if (!EditorApplication.isPlaying) return; // waiting for the play-mode transition/domain reload
            if (_runtime == null) _runtime = new RuntimeSession(request);
            if (_runtime.Update())
            {
                WriteResult(request, _runtime.result);
                request.exitCode = _runtime.result.passed ? 0 : 1;
                SetStage(request, "stop-play");
                EditorApplication.isPlaying = false;
            }
        }

        static void StopPlay(Request request)
        {
            if (EditorApplication.isPlaying) { EditorApplication.isPlaying = false; return; }
            _runtime = null;
            SetStage(request, "finish");
        }

        static void Finish(Request request)
        {
            int exitCode = request.exitCode;
            bool shouldExit = request.exitWhenDone;
            string resultPath = request.resultPath;
            SessionState.EraseString(SessionKey);
            _runtime = null;
            if (exitCode == 0) Debug.Log("OpenSlope VRCHAT AUTOTEST PASS: " + resultPath);
            else Debug.LogError("OpenSlope VRCHAT AUTOTEST FAIL: " + resultPath);
            if (shouldExit) EditorApplication.Exit(exitCode);
        }

        static void Fail(Request request, Exception ex)
        {
            AddError(request, ex.GetType().Name + ": " + ex.Message);
            var result = _runtime != null ? _runtime.result : NewResult(request);
            result.errors = request.errors.Distinct().ToList();
            result.passed = false;
            result.finishedUtc = DateTime.UtcNow.ToString("O");
            WriteResult(request, result);
            request.exitCode = 1;
            if (EditorApplication.isPlaying)
            {
                SetStage(request, "stop-play");
                EditorApplication.isPlaying = false;
            }
            else
            {
                SetStage(request, "finish");
            }
            Debug.LogException(ex);
        }

        static void CaptureError(string condition, string stackTrace, LogType type)
        {
            if (type != LogType.Error && type != LogType.Assert && type != LogType.Exception) return;
            Request request = LoadRequest();
            if (request == null || !request.active || request.stage == "finish") return;
            AddError(request, type + ": " + condition);
        }

        static void AddError(Request request, string message)
        {
            if (request.errors == null) request.errors = new List<string>();
            if (!request.errors.Contains(message)) request.errors.Add(message);
            SaveRequest(request);
        }

        static void Retry(Request request, string stage)
        {
            request.attempts++;
            request.nextActionTicks = DateTime.UtcNow.AddSeconds(RetryDelaySeconds).Ticks;
            SaveRequest(request);
            Debug.Log("OpenSlope VRCHAT AUTOTEST: waiting to retry " + stage + " (pass " + request.attempts + ").");
        }

        static void SetStage(Request request, string stage)
        {
            request.stage = stage;
            request.attempts = 0;
            request.stageStartedTicks = DateTime.UtcNow.Ticks;
            request.nextActionTicks = DateTime.UtcNow.Ticks;
            SaveRequest(request);
            Debug.Log("OpenSlope VRCHAT AUTOTEST: stage " + stage + ".");
        }

        static double StageAge(Request request) => new TimeSpan(DateTime.UtcNow.Ticks - request.stageStartedTicks).TotalSeconds;

        static void AssertSafeScene(string targetLevel)
        {
            GameObject root = GameObject.Find(RootName);
            if (root == null) return;
            var identity = root.GetComponent<MapIdentity>();
            if (identity != null && identity.SchemaVersion == MapIdentity.CurrentSchemaVersion && identity.AutoTestPlan) return;
            throw new InvalidOperationException("Safety stop: '" + RootName + "' is already loaded but is not tagged as an autotest map. " +
                "The runner will only start with no map, or with an importer-tagged autotest map already loaded. Target was " + targetLevel + ".");
        }

        static void RequireTargetIdentity(string levelFolder)
        {
            GameObject root = GameObject.Find(RootName);
            if (!IdentityMatches(root, levelFolder))
                throw new InvalidOperationException("The loaded map identity does not match the requested autotest folder " + levelFolder + ".");
        }

        static bool IdentityMatches(GameObject root, string levelFolder)
        {
            if (root == null) return false;
            var identity = root.GetComponent<MapIdentity>();
            return identity != null && identity.SchemaVersion == MapIdentity.CurrentSchemaVersion && identity.AutoTestPlan
                && string.Equals(NormalLevelFolder(identity.LevelFolder), NormalLevelFolder(levelFolder), StringComparison.OrdinalIgnoreCase);
        }

        static string ReadFixture(string levelFolder)
        {
            levelFolder = NormalLevelFolder(levelFolder);
            string path = PlanPath(levelFolder);
            if (!File.Exists(path)) throw new FileNotFoundException("autotest-plan.json was not found; refusing to treat this as an autotest map.", path);
            var plan = JObject.Parse(File.ReadAllText(path));
            string fixture = (string)plan["name"];
            if (string.IsNullOrWhiteSpace(fixture)) throw new InvalidDataException(path + " has no non-empty 'name'.");
            if (!(plan["entries"] is JArray entries) || entries.Count == 0) throw new InvalidDataException(path + " has no autotest entries.");
            return fixture.Trim();
        }

        static string PlanPath(string levelFolder) => Path.Combine(ProjectRoot, NormalLevelFolder(levelFolder), "autotest-plan.json");
        static string ProjectRoot => Path.GetDirectoryName(Application.dataPath);

        static string NormalLevelFolder(string value)
        {
            value = (value ?? "").Replace('\\', '/').TrimEnd('/');
            if (!value.StartsWith("Assets/", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Autotest level must be a project-relative Assets/... folder: " + value);
            return "Assets/" + value.Substring("Assets/".Length);
        }

        static string ToAssetsPath(string absolute)
        {
            absolute = Path.GetFullPath(absolute).Replace('\\', '/').TrimEnd('/');
            string assets = Path.GetFullPath(Application.dataPath).Replace('\\', '/').TrimEnd('/');
            if (!absolute.StartsWith(assets + "/", StringComparison.OrdinalIgnoreCase)) return "";
            return "Assets" + absolute.Substring(assets.Length);
        }

        static string SafeName(string value)
        {
            foreach (char c in Path.GetInvalidFileNameChars()) value = value.Replace(c, '_');
            return value.ToLowerInvariant();
        }

        static string Arg(string name)
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 0; i + 1 < args.Length; i++)
                if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) return args[i + 1];
            return "";
        }

        static bool HasArg(string name) => Environment.GetCommandLineArgs().Any(a => string.Equals(a, name, StringComparison.OrdinalIgnoreCase));

        static Request LoadRequest()
        {
            string json = SessionState.GetString(SessionKey, "");
            if (string.IsNullOrEmpty(json)) return null;
            try { return JsonUtility.FromJson<Request>(json); }
            catch { SessionState.EraseString(SessionKey); return null; }
        }

        static void SaveRequest(Request request) => SessionState.SetString(SessionKey, JsonUtility.ToJson(request));

        static Result NewResult(Request request) => new Result
        {
            fixture = request.fixture,
            levelFolder = request.levelFolder,
            unityVersion = Application.unityVersion,
            startedUtc = request.startedUtc,
            scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().path,
        };

        static void WriteResult(Request request, Result result)
        {
            if (request.errors != null) result.errors = request.errors.Distinct().ToList();
            if (result.errors.Count > 0) result.passed = false;
            if (string.IsNullOrEmpty(result.finishedUtc)) result.finishedUtc = DateTime.UtcNow.ToString("O");
            string parent = Path.GetDirectoryName(request.resultPath);
            if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(parent);
            File.WriteAllText(request.resultPath, JsonUtility.ToJson(result, true) + Environment.NewLine);
        }

        [Serializable]
        sealed class Request
        {
            public bool active;
            public string stage;
            public string levelFolder;
            public string fixture;
            public string resultPath;
            public bool exitWhenDone;
            public string startedUtc;
            public long stageStartedTicks;
            public long nextActionTicks;
            public int attempts;
            public int exitCode;
            public List<string> errors = new List<string>();
        }

        sealed class RuntimeSession
        {
            readonly Request _request;
            readonly List<PlanEntry> _plan;
            readonly UdonBehaviour[] _udons;
            UdonBehaviour _board;
            int _index;
            int _attempt;
            bool _mountRequested;
            double _waitStarted;
            double _cellStarted;
            Transform _target;
            UdonBehaviour _observer;
            int _fireBefore;
            int _paintBefore;
            Vector3 _dropPosition;
            float _startY;
            float _minDistance;
            float _maxRise;
            float _maxSpeed;
            float _maxBoost;

            public readonly Result result;

            public RuntimeSession(Request request)
            {
                _request = request;
                _plan = ParsePlan(PlanPath(request.levelFolder));
                // The VRCObjectPool boards begin inactive and are activated by BoardManager only after ClientSim has
                // initialized ownership. Cache inactive behaviours too, then FindBoard waits until one becomes active.
                _udons = UnityEngine.Object.FindObjectsOfType<UdonBehaviour>(true);
                result = NewResult(request);
                result.total = _plan.Count;
                _waitStarted = EditorApplication.timeSinceStartup;
            }

            public bool Update()
            {
                if (_board == null)
                {
                    if (Networking.LocalPlayer == null || !FindBoard())
                    {
                        if (EditorApplication.timeSinceStartup - _waitStarted > ClientSimTimeoutSeconds)
                            throw new TimeoutException("ClientSim did not provide a local player and active rideable board within " + ClientSimTimeoutSeconds + " seconds.");
                        return false;
                    }
                }

                if (!ReadBool(_board, "IsRiding"))
                {
                    if (!_mountRequested)
                    {
                        Set(_board, "AutoTestControl", true);
                        _board.SendCustomEvent("AutoTestMount");
                        _mountRequested = true;
                        _waitStarted = EditorApplication.timeSinceStartup;
                    }
                    else if (EditorApplication.timeSinceStartup - _waitStarted > ClientSimTimeoutSeconds)
                        throw new TimeoutException("ClientSim local player did not enter the autotest board station.");
                    return false;
                }

                if (_index >= _plan.Count)
                {
                    result.finishedUtc = DateTime.UtcNow.ToString("O");
                    result.passed = result.failed == 0;
                    return true;
                }

                if (_cellStarted <= 0)
                {
                    BeginCell();
                    if (_cellStarted <= 0) return false; // unsupported/missing target was recorded synchronously
                }
                SampleCell();
                if (EditorApplication.timeSinceStartup - _cellStarted < CellSeconds) return false;

                PlanEntry entry = _plan[_index];
                int fireDelta = _observer == null ? 0 : Math.Max(0, ReadInt(_observer, "AutoTestFireCount") - _fireBefore);
                if (entry.expect == "dispatch" && fireDelta == 0 && _attempt + 1 < PositiveAttempts)
                {
                    _attempt++;
                    BeginCell();
                    return false;
                }

                GradeCell(entry, fireDelta);
                _index++;
                _attempt = 0;
                _cellStarted = 0;
                return false;
            }

            bool FindBoard()
            {
                foreach (UdonBehaviour udon in _udons)
                {
                    if (udon == null || !udon.gameObject.activeInHierarchy || !HasPublic(udon, "AutoTestControl")) continue;
                    _board = udon;
                    return true;
                }
                return false;
            }

            void BeginCell()
            {
                PlanEntry entry = _plan[_index];
                FindTargetAndObserver(entry.propName, out _target, out _observer);
                if (_target == null)
                {
                    AddUnsupported(entry, "No imported object name matched the plan propName.");
                    _index++;
                    _attempt = 0;
                    _cellStarted = 0;
                    return;
                }

                Vector3 direction = CourseDirection();
                Vector3 targetPosition = _target.position;
                _dropPosition = targetPosition - direction * 7f + Vector3.up * 2f;
                _startY = _dropPosition.y;
                _minDistance = float.MaxValue;
                _maxRise = 0f;
                _maxSpeed = 0f;
                _maxBoost = 0f;
                _fireBefore = _observer == null ? 0 : ReadInt(_observer, "AutoTestFireCount");
                _paintBefore = _observer == null || !HasPublic(_observer, "AutoTestPaintCount")
                    ? 0 : ReadInt(_observer, "AutoTestPaintCount");

                Set(_board, "AutoTestControl", true);
                Set(_board, "AutoTestSteer", 0f);
                Set(_board, "AutoTestThrottle", 0f);
                Set(_board, "AutoTestBoost", false);
                Set(_board, "AutoTestDropPosition", _dropPosition);
                Set(_board, "AutoTestDropForward", direction);
                Set(_board, "AutoTestDropSpeed", 20f);
                _board.SendCustomEvent("AutoTestDrop");
                _cellStarted = EditorApplication.timeSinceStartup;
            }

            void SampleCell()
            {
                if (_target == null) return;
                Vector3 pos = _board.transform.position;
                _minDistance = Mathf.Min(_minDistance, Vector3.Distance(pos, _target.position));
                _maxRise = Mathf.Max(_maxRise, pos.y - _startY);
                object velocity = _board.GetProgramVariable("RiderVelocity");
                if (velocity is Vector3 v) _maxSpeed = Mathf.Max(_maxSpeed, v.magnitude);
                _maxBoost = Mathf.Max(_maxBoost, ReadFloat(_board, "AutoTestBoostWindow"));
            }

            void GradeCell(PlanEntry entry, int fireDelta)
            {
                int paintDelta = _observer == null || !HasPublic(_observer, "AutoTestPaintCount")
                    ? 0 : Math.Max(0, ReadInt(_observer, "AutoTestPaintCount") - _paintBefore);
                var row = NewRow(entry);
                row.observer = _observer == null ? "" : HierarchyPath(_observer.transform);
                row.dispatchCount = fireDelta;
                row.paintCount = paintDelta;
                row.minDistanceM = Finite(_minDistance);
                row.maxRiseM = _maxRise;
                row.maxSpeedMps = _maxSpeed;
                row.maxBoostSeconds = _maxBoost;

                bool checkedSomething = false;
                bool failed = false;
                bool unsupported = false;
                var notes = new List<string>();

                if (entry.expect == "dispatch" || entry.expect == "no-dispatch")
                {
                    if (_observer == null)
                    {
                        unsupported = true;
                        notes.Add("No supported Udon dispatch counter was found.");
                    }
                    else
                    {
                        checkedSomething = true;
                        bool wanted = entry.expect == "dispatch";
                        if ((fireDelta > 0) != wanted) failed = true;
                    }
                }

                if (entry.hasPaintExpectation)
                {
                    if (_observer == null)
                    {
                        unsupported = true;
                        notes.Add("Paint/frame mutation is not observable on this Unity mechanism.");
                    }
                    else if (entry.expectPaint && !HasPublic(_observer, "AutoTestPaintCount"))
                    {
                        unsupported = true;
                        notes.Add("The plan requires paint/frame mutation, but this Unity mechanism has no paint output.");
                    }
                    else
                    {
                        checkedSomething = true;
                        // A behaviour with no paint output can satisfy an explicit false expectation structurally.
                        bool painted = HasPublic(_observer, "AutoTestPaintCount") && paintDelta > 0;
                        if (painted != entry.expectPaint) failed = true;
                    }
                }

                foreach (RiderExpectation expectation in entry.rider)
                {
                    float observed;
                    if (expectation.signal == "rise" || expectation.signal == "jump") observed = _maxRise;
                    else if (expectation.signal == "boost-request") observed = _maxBoost;
                    else if (expectation.signal == "speed") observed = _maxSpeed;
                    else
                    {
                        unsupported = true;
                        notes.Add("Unsupported rider signal: " + expectation.signal + ".");
                        continue;
                    }
                    checkedSomething = true;
                    if (expectation.hasAtLeast && observed < expectation.atLeast) failed = true;
                    if (expectation.hasAtMost && observed > expectation.atMost) failed = true;
                }

                if (entry.hasMemoryChecks) notes.Add("PCSX live-node watches/slot checks are not available in Unity; observable gameplay checks still ran.");
                if (failed) { row.status = "fail"; result.failed++; }
                else if (unsupported) { row.status = "unsupported"; result.unsupported++; }
                else if (!checkedSomething) { row.status = "open"; result.open++; }
                else { row.status = "pass"; result.passedEntries++; }
                row.notes = string.Join(" ", notes);
                result.entries.Add(row);
            }

            void AddUnsupported(PlanEntry entry, string note)
            {
                EntryResult row = NewRow(entry);
                row.status = "unsupported";
                row.notes = note;
                result.unsupported++;
                result.entries.Add(row);
            }

            static EntryResult NewRow(PlanEntry entry) => new EntryResult
            {
                id = entry.id,
                propName = entry.propName,
                expected = string.IsNullOrEmpty(entry.expect) ? "open" : entry.expect,
            };

            void FindTargetAndObserver(string propName, out Transform target, out UdonBehaviour observer)
            {
                string key = MatchKey(propName);
                Transform[] transforms = GameObject.Find(RootName).GetComponentsInChildren<Transform>(true);
                var candidates = transforms.Where(t => MatchKey(t.name).Contains(key)).ToArray();
                target = null;
                observer = null;
                foreach (Transform candidate in candidates)
                {
                    UdonBehaviour found = FindObserverNear(candidate);
                    if (found != null) { target = candidate; observer = found; return; }
                }
                if (candidates.Length > 0) target = candidates[0];
            }

            UdonBehaviour FindObserverNear(Transform target)
            {
                foreach (UdonBehaviour u in target.GetComponents<UdonBehaviour>()) if (HasPublic(u, "AutoTestFireCount")) return u;
                foreach (UdonBehaviour u in target.GetComponentsInChildren<UdonBehaviour>(true)) if (HasPublic(u, "AutoTestFireCount")) return u;
                for (Transform p = target.parent; p != null; p = p.parent)
                    foreach (UdonBehaviour u in p.GetComponents<UdonBehaviour>()) if (HasPublic(u, "AutoTestFireCount")) return u;
                return null;
            }

            static Vector3 CourseDirection()
            {
                GameObject root = GameObject.Find(RootName);
                Transform gate = root == null ? null : root.transform.Find("Locations/GateSpawn");
                Vector3 direction = gate == null ? Vector3.forward : Vector3.ProjectOnPlane(gate.forward, Vector3.up);
                return direction.sqrMagnitude > 1e-4f ? direction.normalized : Vector3.forward;
            }
        }

        static List<PlanEntry> ParsePlan(string path)
        {
            var root = JObject.Parse(File.ReadAllText(path));
            var rows = new List<PlanEntry>();
            foreach (JObject item in (JArray)root["entries"])
            {
                var row = new PlanEntry
                {
                    id = (string)item["id"] ?? "",
                    propName = (string)item["propName"] ?? "",
                    expect = ((string)item["expect"] ?? "").ToLowerInvariant(),
                    hasPaintExpectation = item["expectPaint"] != null && item["expectPaint"].Type != JTokenType.Null,
                    expectPaint = (bool?)item["expectPaint"] ?? false,
                    hasMemoryChecks = item["expectSlot"] != null && item["expectSlot"].Type != JTokenType.Null
                        || item["watches"] is JArray watches && watches.Count > 0
                        || item["lateWatch"] != null && item["lateWatch"].Type != JTokenType.Null,
                };
                if (item["expectRider"] is JArray rider)
                {
                    foreach (JObject expectation in rider)
                    {
                        var parsed = new RiderExpectation { signal = ((string)expectation["signal"] ?? "").ToLowerInvariant() };
                        if (expectation["atLeast"] != null) { parsed.hasAtLeast = true; parsed.atLeast = (float)expectation["atLeast"]; }
                        if (expectation["atMost"] != null) { parsed.hasAtMost = true; parsed.atMost = (float)expectation["atMost"]; }
                        row.rider.Add(parsed);
                    }
                }
                rows.Add(row);
            }
            return rows;
        }

        static bool HasPublic(UdonBehaviour udon, string name)
        {
            if (udon == null || udon.publicVariables == null) return false;
            object value;
            return udon.publicVariables.TryGetVariableValue(name, out value);
        }

        static void Set(UdonBehaviour udon, string name, object value) => udon.SetProgramVariable(name, value);
        static bool ReadBool(UdonBehaviour udon, string name) { object v = udon.GetProgramVariable(name); return v is bool b && b; }
        static int ReadInt(UdonBehaviour udon, string name) { object v = udon.GetProgramVariable(name); return v is int i ? i : 0; }
        static float ReadFloat(UdonBehaviour udon, string name) { object v = udon.GetProgramVariable(name); return v is float f ? f : 0f; }
        static float Finite(float value) => float.IsNaN(value) || float.IsInfinity(value) ? -1f : value;
        static string MatchKey(string value) => new string((value ?? "").Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
        static string HierarchyPath(Transform t) => t.parent == null ? t.name : HierarchyPath(t.parent) + "/" + t.name;

        sealed class PlanEntry
        {
            public string id;
            public string propName;
            public string expect;
            public bool hasPaintExpectation;
            public bool expectPaint;
            public bool hasMemoryChecks;
            public readonly List<RiderExpectation> rider = new List<RiderExpectation>();
        }

        sealed class RiderExpectation
        {
            public string signal;
            public bool hasAtLeast;
            public float atLeast;
            public bool hasAtMost;
            public float atMost;
        }

        [Serializable]
        public sealed class Result
        {
            public bool passed;
            public string fixture;
            public string levelFolder;
            public string unityVersion;
            public string scene;
            public string startedUtc;
            public string finishedUtc;
            public int total;
            public int passedEntries;
            public int failed;
            public int unsupported;
            public int open;
            public List<string> errors = new List<string>();
            public List<EntryResult> entries = new List<EntryResult>();
        }

        [Serializable]
        public sealed class EntryResult
        {
            public string id;
            public string propName;
            public string status;
            public string expected;
            public string observer;
            public int dispatchCount;
            public int paintCount;
            public float minDistanceM;
            public float maxRiseM;
            public float maxSpeedMps;
            public float maxBoostSeconds;
            public string notes;
        }
    }
}
#endif
