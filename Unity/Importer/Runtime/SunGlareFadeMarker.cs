using UnityEngine;

namespace OpenSlope.Importer
{

    // SOURCE-VISIBILITY fade for the sun glare (docs/unity/046). The engine's corona and fan carry no depth of their own -
    // they are composited over the finished frame - but the glare still answers to whether the SUN is in view: it washes
    // over a ridge while it clears the edge and drop away as it goes behind, the same source-visibility behaviour the
    // light glints show ([Trailmap: 160-lighting-data], the runtime glint section). Without it the glare hangs at full
    // brightness through a rock face, which reads as a bug however faithful the primitives themselves are.
    //
    // Unlike every other marker in here, this one DOES the work as well as carrying the fields, and runs in edit mode
    // ([ExecuteAlways]) - deliberately, because a marker that only hands data to a platform behaviour would leave the
    // Scene view (and a plain-Unity or Basis project) with no occlusion at all, which is exactly where the effect gets
    // judged. The platform wiring still realizes the VRChat behaviour from these fields and then strips this
    // component, so a built world runs the Udon one and never both.
    //
    // One source, so no round-robin: five rays a frame, coned at the sun's apparent size, and the FRACTION that get
    // through drives the fade. The fraction is the point - a sun half behind a ridge should dim the beams rather than
    // switch them off. Rays start at the CAMERA, not this object: the glare rides the camera in the shader and has no
    // meaningful world position of its own.
    [ExecuteAlways]
    public sealed class SunGlareFadeMarker : Marker
    {
        public float fadePerSecond = 2f;    // easing rate for _Visibility (~2 = a graceful half-second swing)
        public float range = 600f;          // metres a sight ray travels before it counts as clear
        public float spreadDegrees = 3f;    // half-angle of the 5-ray cone - the sun's apparent size, so a rim gives partial credit
        public float minVisibility = 0f;    // floor a fully blocked sun fades to (0 = the beams vanish entirely)
        public int occluderMask = ~0;       // layers that count as occluders (players/UI/foliage etc. excluded)

        private Renderer _renderer;
        private MaterialPropertyBlock _mpb;
        private float _current = 1f;
        private static readonly int VisibilityId = Shader.PropertyToID("_Visibility");

        void OnEnable()
        {
            _renderer = GetComponent<Renderer>();
            _mpb = new MaterialPropertyBlock();
            _current = 1f;
        }

        // Driven from OnWillRenderObject rather than Update, for two reasons. It is called once per CAMERA that
        // actually draws this object, so the sight lines are cast from the eye that is about to look down them -
        // the Scene view included, which is where the effect gets judged. And it ticks on every repaint, whereas
        // the editor throttles Update while its window is unfocused, leaving the fade frozen at full brightness
        // exactly when someone is inspecting it from another window.
        void OnWillRenderObject()
        {
            var cam = Camera.current;
            if (_renderer == null || cam == null) return;

            float target = Mathf.Lerp(Mathf.Clamp01(minVisibility), 1f, ClearFraction(cam.transform.position));
            // Edit mode has no meaningful frame pacing, so settle straight away rather than crawl.
            float step = Application.isPlaying ? fadePerSecond * Time.deltaTime : 1f;
            float next = Mathf.MoveTowards(_current, target, step);
            if (next == _current) return;
            _current = next;
            _mpb.SetFloat(VisibilityId, _current);
            _renderer.SetPropertyBlock(_mpb);
        }

        /// <summary>The fraction of the 5-ray cone toward the sun that reaches the sky unobstructed.</summary>
        public float ClearFraction(Vector3 eye)
        {
            Vector3 toSun = -transform.forward;
            Vector3 upish = Mathf.Abs(toSun.y) < 0.9f ? Vector3.up : Vector3.forward;
            Vector3 side = Vector3.Normalize(Vector3.Cross(toSun, upish));
            Vector3 up = Vector3.Normalize(Vector3.Cross(side, toSun));
            float spread = Mathf.Tan(spreadDegrees * Mathf.Deg2Rad);

            int clear = 0;
            if (Clear(eye, toSun)) clear++;
            if (Clear(eye, toSun + side * spread)) clear++;
            if (Clear(eye, toSun - side * spread)) clear++;
            if (Clear(eye, toSun + up * spread)) clear++;
            if (Clear(eye, toSun - up * spread)) clear++;
            return clear * 0.2f;
        }

        private bool Clear(Vector3 from, Vector3 dir) =>
            !Physics.Raycast(from, Vector3.Normalize(dir), range, occluderMask, QueryTriggerInteraction.Ignore);
    }
}
