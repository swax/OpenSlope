#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

namespace OpenSlope.VrcPlugin
{

    // Inspector for StartGateConfig: the usual fields plus a one-click "Rebuild gate" that re-runs the start-gate build
    // (StartGateSetup.Spawn), which reads these values and lays the posts on firstPost + i*interval.
    [CustomEditor(typeof(StartGateConfig))]
    public class StartGateConfigEditor : Editor
    {
        public override void OnInspectorGUI()
        {
            DrawDefaultInspector();
            EditorGUILayout.Space();
            EditorGUILayout.HelpBox(
                "Drag GatePost_0 in the scene to place the row (its position sets the whole row's spot + height); the other " +
                "posts step from it along the gate's X by Spacing. Edit, then Rebuild to apply.", MessageType.Info);
            if (GUILayout.Button("Rebuild gate from these settings"))
                StartGateSetup.Spawn();
        }
    }
}
#endif
