using UnityEngine;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// SOURCE-VISIBILITY fade for the sun's glare (docs/unity/046). The engine's corona and fan have no depth of their own -
    /// they are composited over the finished frame, which is why the beams read as light lying across the mountain
    /// rather than as geometry in it - but the glare still answers to whether the SUN is in view: it washes over a
    /// ridge while it clears the edge and drop away once it is behind. That is the same source-visibility model the
    /// light glints follow ([Trailmap: 160-lighting-data], the runtime glint section), and the reason
    /// <see cref="GlintFade"/> exists; this is its single-source sibling.
    ///
    /// One source, so no round-robin is needed: five rays per frame, coned at the sun's apparent size, and the
    /// FRACTION that get through drives the fade. That fraction is the point - a sun half behind a ridge should dim
    /// the beams rather than switch them off, which is what you see on console. The direction is the object's own
    /// -forward (the Directional Light convention the whole effect uses), so nothing here needs to know where the sun
    /// is; rotating the object moves both the beams and their sight lines together.
    ///
    /// Rays are cast from the viewer's HEAD, not the object, because the object rides the camera in the shader and
    /// has no meaningful world position of its own. Local-only visuals (sync None).
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class SunGlareFade : UdonSharpBehaviour
    {
        [Tooltip("Easing rate for _Visibility per second (~2 = a graceful half-second swing).")]
        public float fadePerSecond = 2f;
        [Tooltip("Metres a sight ray travels before the sun counts as clear. Past the far terrain, not to the sun itself - it is effectively at infinity.")]
        public float range = 600f;
        [Tooltip("Half-angle of the 5-ray cone, i.e. the sun's apparent size. A sun on a ridge line gets partial credit instead of snapping.")]
        public float spreadDegrees = 3f;
        [Tooltip("Floor a fully blocked sun fades to. 0 = the beams vanish; a little above keeps a hint of glare in shadow.")]
        public float minVisibility = 0f;
        [Tooltip("Layers that count as occluders (players/UI/foliage etc. excluded).")]
        public int occluderMask = ~0;

        private Renderer _renderer;
        private MaterialPropertyBlock _mpb;
        private VRCPlayerApi _player;
        private float _current = 1f;

        void Start()
        {
            _player = Networking.LocalPlayer;
            _mpb = new MaterialPropertyBlock();
            _renderer = GetComponent<Renderer>();
        }

        void Update()
        {
            if (_renderer == null) return;
            if (_player == null) { _player = Networking.LocalPlayer; if (_player == null) return; }

            // Direction TO the sun, and a pair of axes across it to spread the cone over.
            Vector3 toSun = -transform.forward;
            Vector3 upish = Mathf.Abs(toSun.y) < 0.9f ? Vector3.up : Vector3.forward;
            Vector3 side = Vector3.Normalize(Vector3.Cross(toSun, upish));
            Vector3 up = Vector3.Normalize(Vector3.Cross(side, toSun));
            float spread = Mathf.Tan(spreadDegrees * Mathf.Deg2Rad);

            Vector3 head = _player.GetTrackingData(VRCPlayerApi.TrackingDataType.Head).position;
            int clear = 0;
            if (!Physics.Raycast(head, toSun, range, occluderMask, QueryTriggerInteraction.Ignore)) clear++;
            if (!Physics.Raycast(head, Vector3.Normalize(toSun + side * spread), range, occluderMask, QueryTriggerInteraction.Ignore)) clear++;
            if (!Physics.Raycast(head, Vector3.Normalize(toSun - side * spread), range, occluderMask, QueryTriggerInteraction.Ignore)) clear++;
            if (!Physics.Raycast(head, Vector3.Normalize(toSun + up * spread), range, occluderMask, QueryTriggerInteraction.Ignore)) clear++;
            if (!Physics.Raycast(head, Vector3.Normalize(toSun - up * spread), range, occluderMask, QueryTriggerInteraction.Ignore)) clear++;

            // The fraction that got through, lifted off zero by the floor: a rim of sun over a ridge still glares.
            float target = Mathf.Lerp(Mathf.Clamp01(minVisibility), 1f, clear * 0.2f);
            if (_current != target)
            {
                _current = Mathf.MoveTowards(_current, target, fadePerSecond * Time.deltaTime);
                _mpb.SetFloat("_Visibility", _current);
                _renderer.SetPropertyBlock(_mpb);
            }
        }
    }
}
