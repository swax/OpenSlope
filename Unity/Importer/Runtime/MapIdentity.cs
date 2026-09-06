using UnityEngine;

namespace OpenSlope.Importer
{

    // Authenticated scene identity for an imported OpenSlope map. Editor automation reads this component from OpenSlope_Map
    // before it is allowed to replace anything: an untagged/ordinary map is never treated as an autotest map merely
    // because EditorPrefs happens to point at an autotest folder.
    [DisallowMultipleComponent]
    public sealed class MapIdentity : MonoBehaviour
    {
        public const int CurrentSchemaVersion = 1;

        [Tooltip("Identity schema written by the importer.")]
        public int SchemaVersion = CurrentSchemaVersion;

        [Tooltip("Project-relative Assets folder from which this map was imported.")]
        public string LevelFolder = "";

        [Tooltip("True only when the imported folder contained a valid autotest-plan.json at import time.")]
        public bool AutoTestPlan;

        [Tooltip("The plan's fixture/name field. Empty for ordinary maps.")]
        public string AutoTestFixture = "";
    }
}
