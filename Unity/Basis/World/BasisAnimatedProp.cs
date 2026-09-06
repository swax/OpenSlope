using UnityEngine;

namespace OpenSlope.BasisPlugin
{

    // Basis runtime behaviour for an SSX animated world prop (docs/038) - the Basis analogue of the VRChat
    // AnimatedPropU, realized by BasisWiring from the same AnimatedPropMarker. Plays the model's own
    // object-hierarchy clip on a segment chain: per segment a rest pose plus piecewise-CUBIC channels evaluated at
    // absolute clip time (rotation channels in degrees; the curve value IS the full local pose component, so at t=0
    // it reproduces the rest pose) [Trailmap: 370-world-interaction].
    //
    // Three drive modes, exactly the VRChat behaviour's:
    //  - FREE-RUN (the swinging bridge): the clock is absolute Time.time * rate wrapped per loopMode, so every
    //    client/visitor sees the same phase with nothing networked.
    //  - TRIGGERED (the iris door; a roll-away breakable's roll, docs/036): holds at frame 0 until Trigger(), plays
    //    once to the end and holds; autoResetDelay seconds after the last Trigger() it plays back to re-arm (0 =
    //    hold; a break-owned roll is reset by the breakable's respawn via ResetToStart() instead).
    //  - DELTA-GATED (the kicker ramps): starts frozen; the clip clock advances only while a poke BUDGET is
    //    positive (Poke() grants pokeSeconds). Emulated region activation uses the local player's distance
    //    (BasisLocalPlayerProbe) the way the VRChat twin uses the VRC local player.
    //
    // Curves arrive flattened (the marker seam is shared with Udon, which has no nested arrays): curveData holds
    // [a,b,c,d,t0,t1] runs; curve c covers curveData segments [curveStart[c] .. +curveCount[c]) and writes component
    // curveTarget[c] of segment curveSegment[c]'s pose, clamped to the window outside it (the engine rule). You don't
    // add this by hand - the importer builds the hierarchy and BasisWiring copies every field.
    public class BasisAnimatedProp : MonoBehaviour
    {
        [Header("Clip (from the SSF AnimObject params)")]
        public float clipLength = 3f;
        [Tooltip("1 = wrap loop, 2 = ping-pong, anything else = play once and hold the last pose.")]
        public int loopMode = 1;
        [Tooltip("Clip seconds per real second (Sub256 U3 / 30; 1 = real-time).")]
        public float rate = 1f;
        public bool reverse;

        [Header("Triggered mode (iris door / roll-away breakable)")]
        public bool triggered;
        [Tooltip("Triggered only: seconds held at the end pose after the last Trigger() before playing back to " +
                 "re-arm. 0 = hold (the break-owned rolls; the breakable respawn ResetToStart()s them).")]
        public float autoResetDelay = 8f;

        [Header("Delta-gated mode (SSF AnimDelta - kicker ramps)")]
        public bool deltaGated;
        [Tooltip("Clip-seconds granted per Poke() (the SSF AddDelta grant, U1/30).")]
        public float pokeSeconds = 1f;
        [Tooltip("Delta-gated only: self-poking persistent header (the centre kicker) - one poke when the local " +
                 "player first comes within activateRange.")]
        public bool activatePulse;
        public float activateRange = 250f;
        public float deactivateRange = 400f;

        [Header("Combo mode (SSF AnimCombo - the Aloha barriers)")]
        [Tooltip("If set, the clip's IDLE window free-runs and a second window plays once over the top of it when " +
                 "TriggerCombo() is called - composed onto the pose the prop was holding, so a barrier knocked over " +
                 "mid-slide falls where it stands (type0 Sub258). The trigger VOLUME is not ported to Basis, " +
                 "alongside the door/kicker ones, so the idle half is what a Basis world shows.")]
        public bool combo;
        public float comboStart;
        public float comboEnd;
        public float comboRate = 1f;
        [Tooltip("Sign of Sub258 U11: 0 = back to the idle loop, 1 = stop on the idle pose, -1 = stop holding the " +
                 "last reaction frame.")]
        public int comboEndMode;
        [Tooltip("Seconds added to the shared idle clock, so copies of one prop are out of step (Sub258 U6).")]
        public float phaseOffset;

        [Header("Segments (wired by the importer; only segments with curves)")]
        public Transform[] segTransforms;
        public Vector3[] segRestPos;
        public Vector3[] segRestEuler;     // degrees

        [Header("Curves (flattened; wired by the importer)")]
        public int[] curveSegment;         // index into segTransforms
        public int[] curveTarget;          // 0-2 = local position x/y/z, 3-5 = local euler x/y/z (degrees)
        public int[] curveStart;           // first cubic segment (index into curveData / 6)
        public int[] curveCount;           // cubic segment count
        public float[] curveData;          // [a,b,c,d,t0,t1] per cubic segment

        [Tooltip("Re-evaluate the curves only every Nth frame (imperceptible on these slow props). 0 -> default 3.")]
        public int updateInterval = 3;

        Vector3[] _pos;
        Vector3[] _eul;
        int[] _cache;                      // per curve: last active cubic segment (avoids the scan most frames)

        // Triggered mode: _u = normalized progress 0..1; _dir = +1 forward / -1 back / 0 idle; _endSince = end-pose time.
        float _u;
        int _dir;
        float _endSince;

        // Delta-gated mode: _budget = remaining clip-seconds; _clock = accumulated clip time; _activated = in-region.
        float _budget;
        float _clock;
        bool _activated;

        // Combo state: _comboT the reaction clock, _idleHold the seconds the idle clock has been frozen for (so the
        // idle resumes where it stopped rather than where the world clock has got to), _snap* the composed-onto pose.
        float _comboT;
        bool _comboOn;
        bool _comboDone;
        float _idleHold;
        Vector3[] _snapPos;
        Quaternion[] _snapRot;

        int _tick;
        float _accumDt;

        // Fire the prop's one-shot (open the door / start the roll-away). No-op on a non-triggered prop.
        public void Trigger()
        {
            if (!triggered) return;
            if (_u >= 1f) { _endSince = Time.time; _dir = 0; }
            else _dir = 1;
        }

        // The engine composes an animated object's Euler triple ZYX - Rz, then Ry, then Rx applied outward-in
        // [Trailmap: 120-objects]. Unity's Quaternion.Euler is ZXY, so the order is spelled out here. It only
        // differs when two or more rotation curves are live at once; retail authors none, so shipped content
        // renders identically either way.
        Quaternion ClipRotation(Vector3 e)
        {
            return Quaternion.AngleAxis(e.z, Vector3.forward)
                 * Quaternion.AngleAxis(e.y, Vector3.up)
                 * Quaternion.AngleAxis(e.x, Vector3.right);
        }


        // Snap a triggered prop straight back to frame 0, writing the rest pose THIS call (not on the next throttled
        // Update): the roll-away breakable's respawn re-enables the intact renderers the same frame (docs/036).
        public void ResetToStart()
        {
            if (!triggered) return;
            _u = 0f; _dir = 0;
            int n = segTransforms == null ? 0 : segTransforms.Length;
            for (int i = 0; i < n; i++)
            {
                Transform tf = segTransforms[i];
                if (tf == null) continue;
                tf.localPosition = segRestPos[i];
                tf.localRotation = ClipRotation(segRestEuler[i]);
            }
        }

        // Grant a delta-gated prop pokeSeconds of clip budget (the SSF AddDelta). No-op on a non-gated prop.
        public void Poke()
        {
            if (deltaGated) _budget += pokeSeconds;
        }

        // Play the reaction window once, composed onto the pose the prop is holding (the engine's control command 3).
        // Refused while one runs or after an end mode has latched it, as the engine's own guard refuses it.
        public void TriggerCombo()
        {
            if (!combo || _comboOn || _comboDone || _snapPos == null) return;   // _snapPos null = Start has not run
            int n = segTransforms == null ? 0 : segTransforms.Length;
            for (int i = 0; i < n; i++)
            {
                Transform tf = segTransforms[i];
                _snapPos[i] = tf == null ? Vector3.zero : tf.localPosition;
                _snapRot[i] = tf == null ? Quaternion.identity : tf.localRotation;
            }
            _comboT = comboStart;
            _comboOn = true;
        }

        void Start()
        {
            int n = segTransforms == null ? 0 : segTransforms.Length;
            _pos = new Vector3[n];
            _eul = new Vector3[n];
            _snapPos = new Vector3[n];
            _snapRot = new Quaternion[n];
            _cache = new int[curveSegment == null ? 0 : curveSegment.Length];
            for (int c = 0; c < _cache.Length; c++) _cache[c] = curveStart[c];
        }

        void Update()
        {
            int n = segTransforms == null ? 0 : segTransforms.Length;
            if (n == 0 || clipLength <= 0f) return;

            _accumDt += Time.deltaTime;
            int iv = updateInterval > 0 ? updateInterval : 3;
            if (++_tick < iv) return;
            _tick = 0;
            float dt = _accumDt; _accumDt = 0f;   // elapsed since the last run (keeps triggered-mode speed correct)

            float t;
            if (deltaGated)
            {
                // Emulated region activation: local-player distance stands in for the engine's world-grid cells.
                if (BasisLocalPlayerProbe.TryGetPosition(out Vector3 lp))
                {
                    float d = Vector3.Distance(lp, transform.position);
                    if (!_activated && d <= activateRange) { _activated = true; if (activatePulse) _budget += pokeSeconds; }
                    else if (_activated && d > deactivateRange) { _activated = false; _budget = 0f; _clock = 0f; }
                }
                if (_budget > 0f)
                {
                    float adv = dt * rate;
                    if (adv > _budget) adv = _budget;   // land exactly on the grant boundary (the half-swing endpoints)
                    _budget -= adv;
                    _clock += adv;
                }
                t = Wrap(_clock);
            }
            else if (triggered)
            {
                if (_dir > 0) { _u += dt * rate / clipLength; if (_u >= 1f) { _u = 1f; _dir = 0; _endSince = Time.time; } }
                else if (_dir < 0) { _u -= dt * rate / clipLength; if (_u <= 0f) { _u = 0f; _dir = 0; } }
                else if (_u >= 1f && autoResetDelay > 0f && Time.time - _endSince >= autoResetDelay) _dir = -1;
                t = _u * clipLength;
            }
            else
            {
                if (_comboOn || _comboDone) _idleHold += dt;
                t = Wrap((Time.time - _idleHold + phaseOffset) * rate);
            }

            // The reaction, if one is running. The engine's order at the end is kept: clear active, latch, and only
            // then decide the pose - so a resuming combo never shows its final frame.
            bool composed = false;
            if (_comboOn)
            {
                _comboT += dt * comboRate;
                if (_comboT >= comboEnd)
                {
                    _comboT = comboEnd;
                    _comboOn = false;
                    if (comboEndMode != 0) _comboDone = true;
                }
            }
            if (_comboOn || (_comboDone && comboEndMode < 0)) { t = _comboT; composed = true; }

            for (int i = 0; i < n; i++) { _pos[i] = segRestPos[i]; _eul[i] = segRestEuler[i]; }

            for (int c = 0; c < curveSegment.Length; c++)
            {
                int s0 = curveStart[c], cnt = curveCount[c];
                int k = _cache[c];
                if (t < curveData[k * 6 + 4] || t > curveData[k * 6 + 5])
                {
                    k = s0;
                    for (int j = s0; j < s0 + cnt; j++)
                    {
                        k = j;
                        if (t <= curveData[j * 6 + 5]) break;
                    }
                    _cache[c] = k;
                }
                int o = k * 6;
                float tt = Mathf.Clamp(t, curveData[o + 4], curveData[o + 5]);   // engine clamps outside the window
                float v = ((curveData[o] * tt + curveData[o + 1]) * tt + curveData[o + 2]) * tt + curveData[o + 3];

                int si = curveSegment[c], tgt = curveTarget[c];
                if (tgt < 3)
                {
                    Vector3 p = _pos[si];
                    if (tgt == 0) p.x = v; else if (tgt == 1) p.y = v; else p.z = v;
                    _pos[si] = p;
                }
                else
                {
                    Vector3 e = _eul[si];
                    if (tgt == 3) e.x = v; else if (tgt == 4) e.y = v; else e.z = v;
                    _eul[si] = e;
                }
            }

            for (int i = 0; i < n; i++)
            {
                Transform tf = segTransforms[i];
                if (tf == null) continue;
                Vector3 p = _pos[i];
                Quaternion r = ClipRotation(_eul[i]);
                if (composed)
                {
                    // snapshot x reaction - the same per-part matrix product the engine forms. These clips never
                    // animate scale, so a TRS compose is the whole of it.
                    p = _snapPos[i] + _snapRot[i] * p;
                    r = _snapRot[i] * r;
                }
                tf.localPosition = p;
                tf.localRotation = r;
            }
        }

        // Apply loopMode + reverse to a raw clock value (free-run / delta-gated paths share this).
        float Wrap(float t)
        {
            if (loopMode == 1) t -= clipLength * Mathf.Floor(t / clipLength);
            else if (loopMode == 2)
            {
                float c2 = clipLength * 2f;
                t -= c2 * Mathf.Floor(t / c2);
                if (t > clipLength) t = c2 - t;
            }
            else if (t > clipLength) t = clipLength;
            return reverse ? clipLength - t : t;
        }
    }
}
