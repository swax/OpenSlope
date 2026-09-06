using UdonSharp;
using UnityEngine;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Runs every SSX world-prop model clip in the scene from a SINGLE Update(), instead of one
    /// <see cref="AnimatedPropU"/> (and its own Update) per prop. The animation law is AnimatedPropU's,
    /// unchanged - free-running / TRIGGERED / DELTA-GATED clips of piecewise-cubic channels over a segment
    /// hierarchy (docs/038, [Trailmap: 370-world-interaction]) - but the per-frame cost that matters on the Udon
    /// runtime is the interpreted event DISPATCH, paid once per behaviour per frame, so a city's ~21 props are
    /// folded into one VM context iterating flat arrays. Same "one manager, parallel arrays" shape as
    /// <see cref="FlipbookAnimator"/> / <see cref="SpinnerManager"/>.
    ///
    /// Props are staggered across <see cref="updateInterval"/> frames (prop p evaluates on frames where
    /// (frame+p) % interval == 0), so each frame touches ~a third of them and a slow prop still lands on the
    /// correct pose - loop modes read absolute Time.time; the triggered/delta clocks advance by each prop's own
    /// elapsed time, so their speed is exact regardless of the stagger.
    ///
    /// You don't add this by hand: OpenSlope/Optimize/Consolidate Animated Props (ConsolidateAnimatedProps) builds
    /// it from the scene's AnimatedPropU instances - concatenating their segment/curve arrays (segment and
    /// cubic indices rebased into the shared arrays), wiring every AnimTriggerU / AnimPokerU volume to
    /// (manager, prop index), and disabling the per-prop behaviours (whose serialized data stays in place as the
    /// consolidation source, so the menu is idempotent). Local-only, sync None - the trigger volumes carry the
    /// networking (their Fire broadcast calls TriggerProp locally on every client, like it called Trigger).
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class AnimatedPropManager : UdonSharpBehaviour
    {
        [Header("Per-prop clip params (parallel arrays; the consolidator fills)")]
        [Tooltip("Clip length in seconds per prop (model AnimTime / 30).")]
        public float[] clipLength;
        [Tooltip("1 = wrap loop, 2 = ping-pong, anything else = play once and hold the last pose.")]
        public int[] loopMode;
        [Tooltip("Clip seconds per real second (1 = real-time).")]
        public float[] rate;
        [Tooltip("Play the clip backwards.")]
        public bool[] reverse;
        [Tooltip("Triggered mode: hold at frame 0 until TriggerProp, play once to the end and hold.")]
        public bool[] triggered;
        [Tooltip("Triggered only: seconds held at the end pose before playing back to the start (0 = hold forever).")]
        public float[] autoResetDelay;
        [Tooltip("Delta-gated mode (SSF AnimDelta): the clock advances only while a poke budget is positive.")]
        public bool[] deltaGated;
        [Tooltip("Clip-seconds granted per PokeProp (the SSF AddDelta grant).")]
        public float[] pokeSeconds;
        [Tooltip("Delta-gated only: self-poking persistent header - one poke when the local player first comes in range.")]
        public bool[] activatePulse;
        [Tooltip("Metres to the local player that counts as region activation.")]
        public float[] activateRange;
        [Tooltip("Metres beyond which the region deactivates (clip snaps to rest, pulse re-arms).")]
        public float[] deactivateRange;
        [Tooltip("Each prop root's world position, baked by the consolidator (for the delta-gated region emulation).")]
        public Vector3[] propPos;
        [Tooltip("Combo mode (SSF AnimCombo): the idle window free-runs and a second window plays once over the top " +
                 "of it on TriggerPropCombo, composed onto the pose the prop was holding.")]
        public bool[] combo;
        [Tooltip("First second of the reaction window per prop.")]
        public float[] comboStart;
        [Tooltip("Last second of the reaction window per prop.")]
        public float[] comboEnd;
        [Tooltip("Reaction clip-seconds per real second.")]
        public float[] comboRate;
        [Tooltip("What happens at the end of the reaction: 0 = back to the idle loop, 1 = stop on the idle pose, " +
                 "-1 = stop holding the last reaction frame.")]
        public int[] comboEndMode;
        [Tooltip("Seconds added to the shared idle clock, so copies of one prop are out of step with each other.")]
        public float[] phaseOffset;

        [Header("Per-prop slices into the shared arrays")]
        public int[] propSeg0;        // first segment index in segTransforms
        public int[] propSegCount;
        public int[] propCurve0;      // first curve index in curveSegment
        public int[] propCurveCount;

        [Header("Segments (all props, concatenated)")]
        public Transform[] segTransforms;
        public Vector3[] segRestPos;
        public Vector3[] segRestEuler;    // degrees

        [Header("Curves (all props, concatenated; indices rebased to the shared arrays)")]
        public int[] curveSegment;    // GLOBAL index into segTransforms
        public int[] curveTarget;     // 0-2 = local position x/y/z, 3-5 = local euler x/y/z (degrees)
        public int[] curveStart;      // first cubic segment, GLOBAL (index into curveData / 6)
        public int[] curveCount;      // cubic segment count
        public float[] curveData;     // [a,b,c,d,t0,t1] per cubic segment

        [Tooltip("Evaluate each prop every Nth frame, staggered so each frame touches ~1/N of the props. 0 -> default 3.")]
        public int updateInterval = 3;

        Vector3[] _pos;               // segment scratch (global segment index)
        Vector3[] _eul;
        int[] _cache;                 // per curve: last active cubic segment (avoids the scan most frames)

        // Per-prop mode state (mirrors AnimatedPropU's fields, one slot per prop).
        float[] _u;                   // triggered: normalized clip progress 0..1
        int[] _dir;                   // triggered: +1 forward / -1 back / 0 idle
        float[] _endSince;            // triggered: Time.time the end pose was last reached
        float[] _budget;              // delta: remaining clip-seconds the clock may advance
        float[] _clock;               // delta: accumulated clip time
        bool[] _activated;            // delta: the local player is inside the emulated region
        float[] _lastEval;            // Time.time this prop last evaluated (exact dt across the stagger)
        float[] _lastT;               // clip time this prop's segments were last posed at (NaN = never)
        bool[] _lastComposed;         // whether that pose was composed onto a combo snapshot
        float[] _comboT;              // combo: the reaction clock, in clip seconds
        bool[] _comboOn;              // combo: the reaction is running
        bool[] _comboDone;            // combo: an end mode has latched the prop
        float[] _idleHold;            // combo: seconds the idle clock has been frozen for
        Vector3[] _snapPos;           // combo: per-segment pose captured at the trigger (global segment index)
        Quaternion[] _snapRot;

        int _props;
        bool _anyDelta;               // any prop delta-gated -> fetch the local player position each frame
        int _frame;

        // Fire prop i's one-shot (e.g. open the iris door) - AnimatedPropU.Trigger, indexed. Called locally on
        // every client by a trigger volume's Fire (the volume carries the network hop). No-op on a non-triggered prop.
        public void TriggerProp(int i)
        {
            if (triggered == null || i < 0 || i >= _props || !triggered[i]) return;
            if (_u[i] >= 1f) { _endSince[i] = Time.time; _dir[i] = 0; }
            else _dir[i] = 1;
        }

        // Play prop i's reaction window over the pose it is holding - AnimatedPropU.TriggerCombo, indexed.
        // Refused while one is running or after an end mode has latched the prop, as the engine's guard refuses it.
        public void TriggerPropCombo(int i)
        {
            if (combo == null || _snapPos == null || i < 0 || i >= _props
                || !combo[i] || _comboOn[i] || _comboDone[i]) return;   // _snapPos null = Start has not run
            int s0 = propSeg0[i], sEnd = s0 + propSegCount[i];
            for (int k = s0; k < sEnd; k++)
            {
                Transform tf = segTransforms[k];
                _snapPos[k] = tf == null ? Vector3.zero : tf.localPosition;
                _snapRot[k] = tf == null ? Quaternion.identity : tf.localRotation;
            }
            _comboT[i] = comboStart[i];
            _comboOn[i] = true;
        }

        // Grant prop i pokeSeconds of clip budget (the SSF AddDelta) - AnimatedPropU.Poke, indexed. Called by a
        // landing-trigger volume's Fire or the idle AnimPokerU. No-op on a non-gated prop.
        public void PokeProp(int i)
        {
            if (deltaGated == null || i < 0 || i >= _props || !deltaGated[i]) return;
            _budget[i] += pokeSeconds[i];
        }

        void Start()
        {
            _props = clipLength == null ? 0 : clipLength.Length;
            int nSeg = segTransforms == null ? 0 : segTransforms.Length;
            _pos = new Vector3[nSeg];
            _eul = new Vector3[nSeg];
            int nCurve = curveSegment == null ? 0 : curveSegment.Length;
            _cache = new int[nCurve];
            for (int c = 0; c < nCurve; c++) _cache[c] = curveStart[c];
            _u = new float[_props];
            _dir = new int[_props];
            _endSince = new float[_props];
            _budget = new float[_props];
            _clock = new float[_props];
            _activated = new bool[_props];
            _lastEval = new float[_props];
            _lastT = new float[_props];
            _lastComposed = new bool[_props];
            _comboT = new float[_props];
            _comboOn = new bool[_props];
            _comboDone = new bool[_props];
            _idleHold = new float[_props];
            _snapPos = new Vector3[nSeg];
            _snapRot = new Quaternion[nSeg];
            float now = Time.time;
            for (int p = 0; p < _props; p++)
            {
                _lastEval[p] = now;
                _lastT[p] = float.NaN;    // never posed -> the first evaluation always writes
                if (deltaGated[p]) _anyDelta = true;
            }
        }

        void Update()
        {
            int props = _props;
            if (props == 0) return;
            _frame++;
            int iv = updateInterval > 0 ? updateInterval : 3;
            float now = Time.time;

            // The delta-gated region emulation reads the local player's position; fetch it once for all props.
            Vector3 lpPos = Vector3.zero;
            bool haveLp = false;
            if (_anyDelta)
            {
                VRC.SDKBase.VRCPlayerApi lp = VRC.SDKBase.Networking.LocalPlayer;
                if (lp != null) { lpPos = lp.GetPosition(); haveLp = true; }
            }

            for (int p = 0; p < props; p++)
            {
                if ((_frame + p) % iv != 0) continue;   // stagger: ~1/N of the props per frame
                float clip = clipLength[p];
                int s0 = propSeg0[p], sn = propSegCount[p];
                if (sn == 0 || clip <= 0f) continue;
                float dt = now - _lastEval[p];
                _lastEval[p] = now;

                float t;
                if (deltaGated[p])
                {
                    // Emulated region activation (AnimatedPropU's law): activate within range (one pulse), snap to
                    // rest + re-arm past the deactivate range; the clock advances only while the poke budget holds.
                    if (haveLp)
                    {
                        float d = Vector3.Distance(lpPos, propPos[p]);
                        if (!_activated[p] && d <= activateRange[p]) { _activated[p] = true; if (activatePulse[p]) _budget[p] += pokeSeconds[p]; }
                        else if (_activated[p] && d > deactivateRange[p]) { _activated[p] = false; _budget[p] = 0f; _clock[p] = 0f; }
                    }
                    if (_budget[p] > 0f)
                    {
                        float adv = dt * rate[p];
                        if (adv > _budget[p]) adv = _budget[p];   // land exactly on the grant boundary (the half-swing endpoints)
                        _budget[p] -= adv;
                        _clock[p] += adv;
                    }
                    t = _clock[p];
                    if (loopMode[p] == 1) t -= clip * Mathf.Floor(t / clip);
                    else if (loopMode[p] == 2)
                    {
                        float c2 = clip * 2f;
                        t -= c2 * Mathf.Floor(t / c2);
                        if (t > clip) t = c2 - t;
                    }
                    else if (t > clip) t = clip;
                    if (reverse[p]) t = clip - t;
                }
                else if (triggered[p])
                {
                    // Hold at the start until TriggerProp; advance once to the end and hold; autoResetDelay seconds
                    // after the last trigger it plays back to the start so it can re-fire (0 = hold).
                    if (_dir[p] > 0) { _u[p] += dt * rate[p] / clip; if (_u[p] >= 1f) { _u[p] = 1f; _dir[p] = 0; _endSince[p] = now; } }
                    else if (_dir[p] < 0) { _u[p] -= dt * rate[p] / clip; if (_u[p] <= 0f) { _u[p] = 0f; _dir[p] = 0; } }
                    else if (_u[p] >= 1f && autoResetDelay[p] > 0f && now - _endSince[p] >= autoResetDelay[p]) _dir[p] = -1;
                    t = _u[p] * clip;
                }
                else
                {
                    // The idle clock stops while a reaction runs and stays stopped once one has latched the prop,
                    // so the barrier's slide resumes where it was knocked over rather than where the world clock
                    // has got to. phaseOffset is the engine's per-instance random start.
                    if (_comboOn[p] || _comboDone[p]) _idleHold[p] += dt;
                    t = (now - _idleHold[p] + phaseOffset[p]) * rate[p];
                    if (loopMode[p] == 1) t -= clip * Mathf.Floor(t / clip);
                    else if (loopMode[p] == 2)
                    {
                        float c2 = clip * 2f;
                        t -= c2 * Mathf.Floor(t / c2);
                        if (t > clip) t = c2 - t;
                    }
                    else if (t > clip) t = clip;
                    if (reverse[p]) t = clip - t;
                }

                // The reaction, if one is running - AnimatedPropU's law, indexed. The engine's order at the end
                // is kept: clear active, latch, and only then decide the pose.
                bool composed = false;
                if (_comboOn[p])
                {
                    _comboT[p] += dt * comboRate[p];
                    if (_comboT[p] >= comboEnd[p])
                    {
                        _comboT[p] = comboEnd[p];
                        _comboOn[p] = false;
                        if (comboEndMode[p] != 0) _comboDone[p] = true;
                    }
                }
                if (_comboOn[p] || (_comboDone[p] && comboEndMode[p] < 0)) { t = _comboT[p]; composed = true; }

                // The pose is a pure function of t, so an unchanged t means unchanged transforms - and a prop at rest
                // holds one t forever (a shut door, a frozen kicker, a played-out one-shot). Skipping the rewrite is
                // what keeps those free: the segment colliders are Rigidbody-less MeshColliders, so every transform
                // write re-inserts one into PhysX's static tree, a cost a city of idle props would otherwise pay on
                // every stagger slot. Same dirty check the ride's refit takes (Slopesmith physics.ts).
                if (t == _lastT[p] && composed == _lastComposed[p]) continue;
                _lastT[p] = t;
                _lastComposed[p] = composed;

                int sEnd = s0 + sn;
                for (int i = s0; i < sEnd; i++) { _pos[i] = segRestPos[i]; _eul[i] = segRestEuler[i]; }

                int c0 = propCurve0[p], cEnd = c0 + propCurveCount[p];
                for (int c = c0; c < cEnd; c++)
                {
                    int cs0 = curveStart[c], cnt = curveCount[c];
                    int k = _cache[c];
                    if (t < curveData[k * 6 + 4] || t > curveData[k * 6 + 5])
                    {
                        k = cs0;
                        for (int j = cs0; j < cs0 + cnt; j++)
                        {
                            k = j;
                            if (t <= curveData[j * 6 + 5]) break;
                        }
                        _cache[c] = k;
                    }
                    int o = k * 6;
                    float tt = t;
                    if (tt < curveData[o + 4]) tt = curveData[o + 4];        // engine clamps outside the window
                    else if (tt > curveData[o + 5]) tt = curveData[o + 5];
                    float v = ((curveData[o] * tt + curveData[o + 1]) * tt + curveData[o + 2]) * tt + curveData[o + 3];

                    int si = curveSegment[c], tgt = curveTarget[c];
                    if (tgt < 3)
                    {
                        Vector3 pv = _pos[si];
                        if (tgt == 0) pv.x = v; else if (tgt == 1) pv.y = v; else pv.z = v;
                        _pos[si] = pv;
                    }
                    else
                    {
                        Vector3 e = _eul[si];
                        if (tgt == 3) e.x = v; else if (tgt == 4) e.y = v; else e.z = v;
                        _eul[si] = e;
                    }
                }

                for (int i = s0; i < sEnd; i++)
                {
                    Transform tf = segTransforms[i];
                    if (tf == null) continue;
                    Vector3 pv = _pos[i];
                    Quaternion rq = Quaternion.Euler(_eul[i]);
                    if (composed)
                    {
                        // snapshot x reaction: the same per-part matrix product the engine forms. These clips never
                        // animate scale, so a TRS compose is the whole of it.
                        pv = _snapPos[i] + _snapRot[i] * pv;
                        rq = _snapRot[i] * rq;
                    }
                    tf.localPosition = pv;
                    tf.localRotation = rq;
                }
            }
        }
    }
}
