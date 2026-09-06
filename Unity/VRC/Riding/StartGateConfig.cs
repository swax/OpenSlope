using UnityEngine;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // Inspector-editable layout for the start-gate post row, parked on the OpenSlope_Map/StartGate object so the gate can be
    // tuned without touching code. StartGateSetup reads it when it (re)builds the gate and PRESERVES it across the
    // rebuild; the "Rebuild gate" button (custom inspector) re-runs that build. Implements VRChat's IEditorOnly, so the SDK
    // strips it on upload - it's pure authoring data, nothing reads it at runtime.
    //
    // The row's FIRST post comes from the SCENE: drag GatePost_0 where you want it and rebuild - its position sets the whole
    // row's spot/height. Every other post steps from there along the gate model's X axis (rider's right) by `spacing`, so
    // the row stays level and parallel to the gate. So you drag post 0 to place/raise/lower the row, set `spacing` for the
    // gap, and `postCount` for how many - there's no stored first-post offset.
    [AddComponentMenu("OpenSlope/Start Gate Config")]
    public class StartGateConfig : MonoBehaviour, IEditorOnly
    {
        [Tooltip("How many posts in the row.")]
        [Min(1)] public int postCount = 6;

        [Tooltip("Spacing between posts along the gate's X axis (rider's right). Post 0 is placed by dragging it in the " +
                 "scene; the rest step from there by this. Posts step in X only, so the row stays aligned to the gate.")]
        public float spacing = 1.385f;

        [Header("Pole look")]
        [Tooltip("Visible pole size: (diameter, half-height, diameter). The cylinder mesh is 2 units tall, so world height = y*2.")]
        public Vector3 poleScale = new Vector3(0.15f, 1.2f, 0.15f);

        [Tooltip("Pole offset under the post root (y = how high it sits, z = back/forward nudge).")]
        public Vector3 poleOffset = new Vector3(0f, 0.158f, 0.043f);

        [Header("Board spawn")]
        [Tooltip("Where each post's board spawns, as an offset from that post in the gate frame: x = right (so it sits " +
                 "between this post and the next), y = lift above the snow (the board is grounded, then lifted by this), " +
                 "z = downhill (NEGATIVE = behind the post, so the post is ahead of the board's front). The board faces " +
                 "downhill. The green gizmo box shows where the board lands.")]
        public Vector3 boardOffset = new Vector3(0.69f, 0.05f, -1.0f);

        [Header("Player spawns")]
        [Tooltip("Put a VRChat player spawn behind each board (facing the board) and set the scene to spawn players " +
                 "RANDOMLY among them. The magenta gizmo markers show them.")]
        public bool spawnBehindBoards = true;

        [Tooltip("How far behind each board (uphill) the player spawns, in metres.")]
        public float spawnBehind = 1.5f;

    #if UNITY_EDITOR
        // Editor preview (stripped on upload): a green board-deck box at each SpawnAnchor (centred where the board's root
        // lands, so it matches the actual board), with a red downhill nub; and a magenta marker for each player spawn.
        void OnDrawGizmos()
        {
            foreach (Transform post in transform)
            {
                if (!post.name.StartsWith("GatePost")) continue;
                Transform anchor = post.Find("SpawnAnchor");
                if (anchor == null) continue;
                Gizmos.matrix = Matrix4x4.TRS(anchor.position, anchor.rotation, Vector3.one);
                Vector3 sz = new Vector3(0.32f, 0.10f, 1.55f);                                       // board deck footprint
                Gizmos.color = new Color(0.20f, 1f, 0.20f, 0.45f); Gizmos.DrawCube(Vector3.zero, sz);     // translucent body
                Gizmos.color = new Color(0.10f, 1f, 0.10f, 1f);    Gizmos.DrawWireCube(Vector3.zero, sz); // outline
                Gizmos.color = new Color(1f, 0.20f, 0.10f, 1f);                                      // front (downhill) nub
                Gizmos.DrawLine(new Vector3(0f, 0f, 0.78f), new Vector3(0f, 0.45f, 0.78f));
            }
            Transform spawnRoot = transform.Find("PlayerSpawns");
            if (spawnRoot != null)
                foreach (Transform s in spawnRoot)
                {
                    Gizmos.matrix = Matrix4x4.TRS(s.position, s.rotation, Vector3.one);
                    Gizmos.color = new Color(1f, 0.30f, 0.90f, 1f);                                  // player marker + facing
                    Gizmos.DrawWireSphere(new Vector3(0f, 0.9f, 0f), 0.30f);
                    Gizmos.DrawLine(new Vector3(0f, 0.9f, 0f), new Vector3(0f, 0.9f, 0.9f));
                }
            Gizmos.matrix = Matrix4x4.identity;
        }
    #endif
    }
}
