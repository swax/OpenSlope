#if UNITY_EDITOR
using UnityEditor;
using UnityEngine;

namespace OpenSlope.VrcPlugin
{

    // Editor-only Scene-view visualiser for the baked grind-rail network (RailNetwork, docs/026). Walks the
    // already-baked LocalPoints / RailStart / RailCount straight off the component and draws each rail's polyline
    // as Gizmo lines, plus a small sphere at each rail's two endpoints (the junctions QueryTransfer chains across).
    //
    // Why a separate [DrawGizmo] editor class rather than OnDrawGizmos on RailNetwork itself: Gizmos.* is not a
    // supported Udon API, so putting it in the UdonSharpBehaviour would risk the UdonSharp compiler. This lives in
    // an Editor/ folder under #if UNITY_EDITOR, so it never compiles into the VRChat build and spawns no GameObjects
    // - it just reads whatever's in the scene now (no re-import needed, unlike RailBuilder's RailDebugDraw lines).
    //
    // Drawn only when the rail object is selected (GizmoType.Selected / .InSelectionHierarchy). Points are baked in
    // the object's LOCAL space, so we draw through transform.localToWorldMatrix - the lines land exactly on the
    // grind data the board queries.
    public static class RailNetworkGizmo
    {
        [DrawGizmo(GizmoType.Selected | GizmoType.InSelectionHierarchy)]
        static void Draw(RailNetwork net, GizmoType type)
        {
            Vector3[] pts = net.LocalPoints;
            int[] starts = net.RailStart;
            int[] counts = net.RailCount;
            if (pts == null || starts == null || counts == null || starts.Length != counts.Length) return;

            Matrix4x4 prev = Gizmos.matrix;
            Gizmos.matrix = net.transform.localToWorldMatrix; // points are raw SSX units in the object's LOCAL space

            for (int r = 0; r < starts.Length; r++)
            {
                int s = starts[r], c = counts[r];
                if (c < 2 || s < 0 || s + c > pts.Length) continue;

                // Colour-cycle per rail so adjacent rails are distinguishable. Golden-ratio hue step spreads them out.
                Gizmos.color = Color.HSVToRGB((r * 0.618f) % 1f, 0.85f, 1f);
                for (int i = 0; i < c - 1; i++)
                    Gizmos.DrawLine(pts[s + i], pts[s + i + 1]);

                // Endpoint markers (~0.3 m world at the level root's 0.01 scale) - the rail ends QueryTransfer joins.
                Gizmos.DrawWireSphere(pts[s], 30f);
                Gizmos.DrawWireSphere(pts[s + c - 1], 30f);
            }

            Gizmos.matrix = prev;
        }
    }
}
#endif
