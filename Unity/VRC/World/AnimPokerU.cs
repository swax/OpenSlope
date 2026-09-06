using UdonSharp;
using UnityEngine;

namespace OpenSlope.VrcPlugin
{

    /// <summary>
    /// Idle "race pack" for the delta-gated animated props (e.g. kicker ramps). In the game the ramps'
    /// AnimDelta clips only advance on pokes - the 4 landing-trigger volumes any of the six racers cross pump all
    /// three ramps at once, and the centre ramp's self-poking header adds its own half-swings as world-grid regions
    /// (re)activate - so a race keeps them toggling, mutually out of phase. A VRChat world has no AI pack, so this
    /// behaviour stands in for it: at a random interval it pokes every target TOGETHER, preserving the original
    /// signature that the trigger-driven ramps stay in lockstep with each other while the centre (whose extra
    /// activatePulse half-swing offsets it) runs anti-phased. Purely cosmetic and LOCAL (sync mode None): each
    /// client rolls its own cadence, exactly as the original runs it per console. Riders crossing the real imported
    /// landing-trigger volumes still poke on top of this.
    ///
    /// SELF-SCHEDULED: the cadence is a SendCustomEventDelayedSeconds loop at the rolled interval - a poke every
    /// 5-12 s needs no per-frame Update, and the interpreted per-behaviour event dispatch is exactly the per-frame
    /// Udon cost Quest pays for. Delayed events fire even on a disabled behaviour, so the loop is immortal;
    /// pokeEnabled is honoured at fire time (off = strict data-faithful: motion only from real rider crossings +
    /// approach pulses).
    ///
    /// You don't add this by hand: the importer (PropBuilder.BuildAnimated) creates one per level when delta-gated
    /// props exist and wires every target; OpenSlope/Optimize/Consolidate Animated Props re-routes it to the
    /// consolidated manager (manager + managerIndices) when it folds the per-prop behaviours. See
    /// docs/038-animated-props.md.
    /// </summary>
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class AnimPokerU : UdonSharpBehaviour
    {
        [Tooltip("The delta-gated props to pump (wired by the importer). All poked together, like the shared landing-trigger header.")]
        public AnimatedPropU[] targets;

        [Tooltip("Consolidated routing (OpenSlope/Optimize/Consolidate Animated Props): when set, pokes drive " +
                 "manager.PokeProp(managerIndices[i]) instead of the per-prop behaviours (which the consolidator " +
                 "disables). `targets` stays wired as the consolidation source + fallback.")]
        public AnimatedPropManager manager;
        [Tooltip("The targets' prop indices in the manager's arrays. Wired by the consolidator.")]
        public int[] managerIndices;

        [Tooltip("Random seconds between pokes (min). The cadence emulates AI racers crossing the landing zones.")]
        public float intervalMin = 5f;
        [Tooltip("Random seconds between pokes (max).")]
        public float intervalMax = 12f;

        [Tooltip("Off = strict data-faithful: the ramps only move on real rider crossings and approach pulses.")]
        public bool pokeEnabled = true;

        void Start()
        {
            SendCustomEventDelayedSeconds(nameof(PokeTick), Random.Range(intervalMin, intervalMax));
        }

        // One pack crossing: poke every target together, then roll the next cadence.
        public void PokeTick()
        {
            SendCustomEventDelayedSeconds(nameof(PokeTick), Random.Range(intervalMin, intervalMax));
            if (!pokeEnabled) return;
            if (manager != null && managerIndices != null)
            {
                for (int i = 0; i < managerIndices.Length; i++) manager.PokeProp(managerIndices[i]);
                return;
            }
            if (targets == null) return;
            for (int i = 0; i < targets.Length; i++)
                if (targets[i] != null) targets[i].Poke();
        }
    }
}
