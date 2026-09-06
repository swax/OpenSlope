using UdonSharp;
using UnityEngine;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Plays an SSX world-prop model clip on a segment hierarchy - the Mesa swinging rope bridge. In the game a
    /// persistent SSF "AnimObject" node (type0 Sub256) runs the model's own animation: per segment a rest pose plus
    /// piecewise-CUBIC channels evaluated at absolute clip time (rotation channels in degrees; the curve value IS
    /// the full local pose component, so at t=0 it reproduces the rest pose) [Trailmap: 370-world-interaction].
    ///
    /// The clock is the shared absolute Time.time (scaled by rate, wrapped per loopMode), NOT an accumulated
    /// per-behaviour timer - so the visible bridge and its invisible collision twin (two separate instances of this
    /// behaviour with identical clips) stay in sync with each other, and every visitor sees the same phase with
    /// nothing networked (sync mode None, like all SSX runtime behaviours).
    ///
    /// A TRIGGERED prop carries no persistent effect; an SSF collision-trigger volume plays its AnimObject on contact
    /// instead. It holds at frame 0 until Trigger() is called by a trigger volume (AnimTriggerU), plays once to the
    /// end and holds, then - after autoResetDelay - plays back to the start so it can re-fire. Its moving segment
    /// colliders carry the motion, so the change is real, not cosmetic (e.g. an iris door slides open a real
    /// gap to pass through). Any prop the level authors this way - a gate, hatch, drawbridge - works the same.
    ///
    /// A DELTA-GATED prop (SSF AnimDelta, type0 Sub257 - e.g. kicker ramps) starts frozen and its clip clock
    /// advances only while a poke BUDGET is positive: Poke() grants pokeSeconds (the engine's AddDelta), and at the
    /// authored 1s grant on the 2s ping-pong each poke is one half-swing - the ramp toggles up or down. Pokes come
    /// from landing-trigger volumes (AnimTriggerU in poke mode), the emulated region activation (activatePulse,
    /// the centre kicker's self-poking header), and the idle AnimPokerU that stands in for the AI race pack. The
    /// budget clock is per-client (unsynced) - original runs it per console the same way.
    ///
    /// A COMBO prop (SSF AnimCombo, type0 Sub258 - the Aloha side-to-side barriers) free-runs an IDLE window like
    /// the bridge above, and carries a SECOND window of the same clip that TriggerCombo() plays once over the top of
    /// it. "Over the top of" is the whole of what makes it a combo: the reaction is composed onto the pose each
    /// segment was holding when it fired, so the barrier falls over WHERE IT STANDS instead of snapping back to the
    /// middle of its slide first [Trailmap: 230-level-ssf sub 258]. The idle clock is frozen for the duration and
    /// picks up where it left off, and comboEndMode decides what happens after: 0 resume the idle and stay
    /// re-triggerable (retail), 1 stop on the idle pose, -1 stop holding the last combo frame. Re-triggering while
    /// one is running is refused, as the engine's own two-byte guard refuses it.
    ///
    /// Curves arrive flattened (Udon has no nested arrays): curveData holds [a,b,c,d,t0,t1] runs; curve c covers
    /// curveData segments [curveStart[c] .. +curveCount[c]) and writes component curveTarget[c] of segment
    /// curveSegment[c]'s pose. value(t) = ((a*t + b)*t + c)*t + d on the cubic segment whose [t0,t1] window holds
    /// t, clamped to the window outside it (the engine rule). You don't add this by hand - the importer
    /// (PropBuilder.BuildAnimated) builds the hierarchy from the bundle manifest and wires every field.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class AnimatedPropU : UdonSharpBehaviour
    {
        [Header("Clip (from the SSF AnimObject params)")]
        [Tooltip("Clip length in seconds (model AnimTime / 30).")]
        public float clipLength = 3f;
        [Tooltip("1 = wrap loop, 2 = ping-pong, anything else = play once and hold the last pose.")]
        public int loopMode = 1;
        [Tooltip("Clip seconds per real second (Sub256 U3 / 30; 1 = real-time).")]
        public float rate = 1f;
        [Tooltip("Play the clip backwards (Sub256 U7 == 4).")]
        public bool reverse;

        [Header("Triggered mode (e.g. an iris door)")]
        [Tooltip("If set, the clip does NOT free-run. It holds at frame 0 until Trigger() is called, then plays once " +
                 "to the end and holds. The persistent props (the bridge) leave this off.")]
        public bool triggered;
        [Tooltip("Triggered only: seconds the prop holds at the end pose after the last Trigger() before it plays " +
                 "back to the start so it can re-fire. 0 = hold at the end once played (e.g. the iris door has no close).")]
        public float autoResetDelay = 8f;

        [Header("Delta-gated mode (SSF AnimDelta - kicker ramps)")]
        [Tooltip("If set, the clip clock advances only while a poke BUDGET is positive - it starts frozen at rest. " +
                 "Poke() grants pokeSeconds of budget; at the authored 1s grant on the 2s ping-pong each poke is one " +
                 "half-swing, toggling the ramp up or down. This is the engine's AnimDelta (type0 Sub257) law.")]
        public bool deltaGated;
        [Tooltip("Clip-seconds granted per Poke() (the SSF AddDelta grant, U1/30).")]
        public float pokeSeconds = 1f;
        [Tooltip("Delta-gated only: self-poking persistent header (the centre kicker). Grants one poke when the local " +
                 "player first comes within activateRange - the engine pulses it once per world-grid region activation.")]
        public bool activatePulse;
        [Tooltip("Metres to the local player that counts as region activation (the engine activates the 3x3 world-grid " +
                 "cells around every racer and the camera).")]
        public float activateRange = 250f;
        [Tooltip("Metres beyond which the region deactivates: the clip snaps back to rest and the activate pulse " +
                 "re-arms (the engine destroys the anim node when everyone leaves, reverting to bind pose).")]
        public float deactivateRange = 400f;

        [Header("Combo mode (SSF AnimCombo - the Aloha barriers)")]
        [Tooltip("If set, the clip's IDLE window free-runs and a second window plays once over the top of it when " +
                 "TriggerCombo() is called - composed onto the pose the prop was holding, so a barrier knocked over " +
                 "mid-slide falls where it stands. This is the engine's AnimCombo (type0 Sub258) law.")]
        public bool combo;
        [Tooltip("First second of the reaction window (Sub258 U8 / 30).")]
        public float comboStart;
        [Tooltip("Last second of the reaction window (Sub258 U9 / 30).")]
        public float comboEnd;
        [Tooltip("Reaction clip-seconds per real second (Sub258 U10 / 30; 1 = real-time).")]
        public float comboRate = 1f;
        [Tooltip("What happens when the reaction ends, from the sign of Sub258 U11: 0 = back to the idle loop and " +
                 "re-triggerable, 1 = stop on the idle pose, -1 = stop holding the last reaction frame.")]
        public int comboEndMode;
        [Tooltip("Seconds added to the shared idle clock, so copies of one prop are out of step with each other " +
                 "(Sub258 U6, the random start phase). Baked per instance by the exporter.")]
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

        Vector3[] _pos;
        Vector3[] _eul;
        int[] _cache;                      // per curve: last active cubic segment (avoids the scan most frames)

        // Triggered mode state: _u = normalized clip progress 0 (start) .. 1 (end); _dir = +1 forward / -1 back / 0
        // idle; _endSince = Time.time it last reached the end pose (for autoResetDelay).
        float _u;
        int _dir;
        float _endSince;

        // Delta-gated mode state: _budget = remaining clip-seconds the clock may advance; _clock = accumulated clip
        // time (ping-pong wrapped at sample time); _activated = the local player is inside the emulated region.
        float _budget;
        float _clock;
        bool _activated;

        // Combo state: _comboT = the reaction clock (seconds into the clip, not into the window); _comboOn while it
        // runs; _comboDone once an end mode has latched it; _idleHold = total seconds the idle clock has been frozen
        // for, subtracted from the shared world clock so the idle resumes where it stopped instead of jumping
        // forward by the reaction's length. _snapPos/_snapRot are the composed-onto pose, captured at the trigger.
        float _comboT;
        bool _comboOn;
        bool _comboDone;
        float _idleHold;
        Vector3[] _snapPos;
        Quaternion[] _snapRot;

        // Clip time the segments were last posed at. NaN until the first evaluation, so the rest pose is always
        // written once.
        float _lastT = float.NaN;
        // Whether the pose last written was composed onto the snapshot. A combo re-poses every tick while it runs,
        // so the _lastT dirty check alone would wrongly skip the frame the composition turns on or off.
        bool _lastComposed;

        // Fire the prop's one-shot (e.g. open the iris door): start playing forward, or - if already at the end -
        // just extend the hold timer. Called by a trigger volume's AnimTriggerU. No-op on a non-triggered prop.
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


        // Snap a triggered prop straight back to frame 0, writing the rest pose THIS call (not on the next
        // throttled Update): the roll-away breakable's respawn (docs/036) re-enables the intact renderers in the
        // same frame it calls this, so the rolled-away end pose must not flash at the restore. No-op otherwise.
        public void ResetToStart()
        {
            if (!triggered) return;
            _u = 0f; _dir = 0; _lastT = 0f;   // the rest pose IS the t=0 pose, and it is written below
            int n = segTransforms == null ? 0 : segTransforms.Length;
            for (int i = 0; i < n; i++)
            {
                Transform tf = segTransforms[i];
                if (tf == null) continue;
                tf.localPosition = segRestPos[i];
                tf.localRotation = ClipRotation(segRestEuler[i]);
            }
        }

        // Grant a delta-gated prop pokeSeconds of clip budget (the SSF AddDelta). Called by a landing-trigger
        // volume's AnimTriggerU or the idle AnimPokerU. No-op on a non-gated prop.
        public void Poke()
        {
            if (deltaGated) _budget += pokeSeconds;
        }

        // Play the reaction window once, composed onto the pose the prop is holding right now (the engine's control
        // command 3). Refused while one is already running or after an end mode has latched the prop, which is the
        // engine's own guard: it tests both state bytes as one halfword, so a spent one-shot cannot be re-armed.
        // Called by a trigger volume's AnimTriggerU - for the retail barriers, the prop's own.
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

        // Perf throttle: re-evaluate the curve only every Nth frame instead of all 60/s. Loop mode reads Time.time, so a
        // throttled refresh still lands at the correct pose (just fewer visual steps - imperceptible on a slow prop); the
        // triggered branch advances by ELAPSED time (_accumDt) so its speed is unchanged, only choppier. 0 -> default 3.
        public int updateInterval = 3;
        private int _tick;
        private float _accumDt;

        void Update()
        {
            int n = segTransforms == null ? 0 : segTransforms.Length;
            if (n == 0 || clipLength <= 0f) return;

            _accumDt += Time.deltaTime;
            int iv = updateInterval > 0 ? updateInterval : 3;
            if (++_tick < iv) return;
            _tick = 0;
            float dt = _accumDt; _accumDt = 0f;   // elapsed time since the last run (keeps triggered-mode speed correct)

            float t;
            if (deltaGated)
            {
                // Emulated region activation: the engine creates the anim node when a racer/camera enters the
                // surrounding world-grid cells (a SelfPulse header grants one poke as it spawns) and destroys it -
                // snapping the model to rest - once everyone leaves. Local-player distance stands in for the cells.
                VRC.SDKBase.VRCPlayerApi lp = VRC.SDKBase.Networking.LocalPlayer;
                if (lp != null)
                {
                    float d = Vector3.Distance(lp.GetPosition(), transform.position);
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
                t = _clock;
                if (loopMode == 1) t -= clipLength * Mathf.Floor(t / clipLength);
                else if (loopMode == 2)
                {
                    float c2 = clipLength * 2f;
                    t -= c2 * Mathf.Floor(t / c2);
                    if (t > clipLength) t = c2 - t;
                }
                else if (t > clipLength) t = clipLength;
                if (reverse) t = clipLength - t;
            }
            else if (triggered)
            {
                // Hold at the start (t=0) until Trigger(); advance once to the end (t=clipLength) and hold.
                // autoResetDelay seconds after the last Trigger() it plays back to the start so it can re-fire (0 = hold).
                if (_dir > 0) { _u += dt * rate / clipLength; if (_u >= 1f) { _u = 1f; _dir = 0; _endSince = Time.time; } }
                else if (_dir < 0) { _u -= dt * rate / clipLength; if (_u <= 0f) { _u = 0f; _dir = 0; } }
                else if (_u >= 1f && autoResetDelay > 0f && Time.time - _endSince >= autoResetDelay) _dir = -1;
                t = _u * clipLength;
            }
            else
            {
                // The idle clock stops while a reaction runs and stays stopped once one has LATCHED the prop, so
                // holding it at `Time.time` minus the accumulated freeze is the whole of both behaviours: without
                // it the shared world clock would run on underneath a frozen barrier and the idle would come back
                // several metres away from where it was knocked over.
                if (_comboOn || _comboDone) _idleHold += dt;
                t = (Time.time - _idleHold + phaseOffset) * rate;
                if (loopMode == 1) t -= clipLength * Mathf.Floor(t / clipLength);
                else if (loopMode == 2)
                {
                    float c2 = clipLength * 2f;
                    t -= c2 * Mathf.Floor(t / c2);
                    if (t > clipLength) t = c2 - t;
                }
                else if (t > clipLength) t = clipLength;
                if (reverse) t = clipLength - t;
            }

            // The reaction, if one is running. It replaces the sampled time with its own clock and turns composition
            // on. The engine's ORDER at the end is kept - clear active, latch, and only THEN decide the pose - which
            // is why a resuming combo never shows its final frame and a holding one shows nothing else ever again.
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

            // The pose is a pure function of t, so an unchanged t means unchanged transforms - and a prop at rest
            // holds one t forever (a shut door, a frozen kicker, a played-out one-shot). Skipping the rewrite is what
            // keeps those free: the segment colliders are Rigidbody-less MeshColliders, so every transform write
            // re-inserts one into PhysX's static tree, a cost a level of idle props would otherwise pay every tick.
            // The ride's own refit takes the same dirty check (Slopesmith physics.ts, `now.equals(live.applied)`).
            if (t == _lastT && composed == _lastComposed) return;
            _lastT = t;
            _lastComposed = composed;

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
                float tt = t;
                if (tt < curveData[o + 4]) tt = curveData[o + 4];        // engine clamps outside the window
                else if (tt > curveData[o + 5]) tt = curveData[o + 5];
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
                    // snapshot x reaction, the same per-part matrix product the engine forms before it walks the
                    // hierarchy. Scale is never animated by these clips, so a TRS compose is the whole of it.
                    p = _snapPos[i] + _snapRot[i] * p;
                    r = _snapRot[i] * r;
                }
                tf.localPosition = p;
                tf.localRotation = r;
            }
        }
    }
}
