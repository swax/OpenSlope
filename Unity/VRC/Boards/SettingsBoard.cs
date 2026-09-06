using UnityEngine;
using UnityEngine.UI;
using UdonSharp;
using VRC.SDKBase;

namespace OpenSlope.VrcPlugin
{

    // The in-world SETTINGS BOARD: the visitor's own preferences panel behind the start gate. Three sections, all
    // PER-PLAYER and LOCAL (the Tuning Board owns the diagnostics + every perf claw-back, the Jukebox owns video):
    //   RIDE MODE  - a 3-button picker (Race / Trick / Free ride) choosing what a gate run IS for this player.
    //   SOUND      - per-player MUTE checkboxes for the world's audio (background music / race music / MC announcer /
    //                crowd / global rider chat).
    //   WORLD      - the cosmetic world effects a player might not want: the falling SNOW EFFECT.
    // Built + wired by SettingsBoardSetup.
    //
    // PER-PLAYER + LOCAL (sync None): a click only changes the local client - nothing is networked. That holds for the
    // ride mode too: each visitor picks their own, so one player time-trialling doesn't stop the next free-riding.
    //
    // Every checkbox's onValueChanged is wired to SendCustomEvent("Apply"); Apply re-reads every control and re-asserts
    // the whole board, so it's order-independent and idempotent. Any ref left null (a system absent from this map - e.g.
    // no race music was decoded, or a map with no snowfall) is simply skipped, so the board works with any subset.
    //
    // Switch mechanisms, picked so "off" is a real change, not just a hide:
    //   - The music/announcer SOUND toggles set a MUTE flag the director already honours every frame (the music directors
    //     fold it into their volume alongside the existing race/video ducks - silent at muted, resuming cleanly when
    //     un-muted, so the bar keeps advancing under the hood; the announcer gates its lines). We deliberately DON'T
    //     SetActive the audio objects: a deactivated music director's Update won't re-Start its two-source crossfade, so it
    //     would never resume. The mute flags are BOOLS defaulting to false (= audible), so an old, un-repushed instance
    //     can't be left silent.
    //   - The CROWD toggle volume-mutes the looping AudioSources directly (restoring their original volumes from a
    //     parallel array), same silent-but-running idea - the loops keep playing at volume 0 and resume seamlessly.
    //   - The SNOW EFFECT toggle drives SnowfallU's own master switch (SnowOn/SnowOff), which enables/disables the
    //     baked field's MeshRenderer - the field is stateless (position is a function of time), so it resumes exactly
    //     where it would have been.
    //   - The RIDE MODE is pushed onto every pooled board as `runMode`, the way the Tuning Board pushes its telemetry
    //     flag: the field only matters on whichever board you're actually riding, and you can mount any of them, so the
    //     mode follows you onto any mount. See RideableBoard.Score for what each mode does to a run.
    [UdonBehaviourSyncMode(BehaviourSyncMode.None)]
    public class SettingsBoard : UdonSharpBehaviour
    {
        // ---- ride mode ------------------------------------------------------------------------------------------
        public const int ModeRace     = 0;   // timed run, recorded on the leaderboard's BEST TIMES list
        public const int ModeTrick    = 1;   // scored run, recorded on the leaderboard's TOP SCORES list
        public const int ModeFreeRide = 2;   // no timed run at all: no clock, no record, boost unlimited

        [Header("Ride mode (0 Race / 1 Trick / 2 Free ride) - pushed onto every pooled board as runMode")]
        [Tooltip("The pooled rideable boards the mode is pushed to (every board, so the mode follows you onto any mount).")]
        public BoardManager manager;
        [Tooltip("The selected mode: 0 = Race, 1 = Trick / Showoff, 2 = Free ride. Defaults to Trick / Showoff.")]
        public int mode = ModeTrick;
        [Tooltip("The three mode buttons' background Images (index = mode), re-tinted so the selected one reads as pressed.")]
        public Image[] modeButtons;
        [Tooltip("The three mode buttons' label Texts (index = mode), re-coloured alongside their backgrounds.")]
        public Text[] modeLabels;
        [Tooltip("Mode-authored prop objects. modeMasks is parallel: race=1, show-off=2, freeride=4.")]
        public GameObject[] modeObjects;
        public int[] modeMasks;
        [Tooltip("The grind network whose HideShowOff rail set follows the selected mode.")]
        public RailNetwork railNetwork;

        // ---- sound ----------------------------------------------------------------------------------------------
        [Header("Background music (off-board environment / intro fallback) - MusicDirector.uiMuted")]
        public Toggle musicToggle;
        public MusicDirector music;

        [Header("Race music (PathFinder, plays while riding) - RaceMusicDirector.uiMuted")]
        public Toggle raceMusicToggle;
        public RaceMusicDirector raceMusic;

        [Header("Announcer (the MC voice) - AnnouncerU.muted")]
        public Toggle announcerToggle;
        public AnnouncerU announcer;

        [Header("Crowd noise - the looping grandstand AudioSources (volume-muted, restored from crowdVolumes)")]
        public Toggle crowdToggle;
        public AudioSource[] crowdSources;     // the Crowd_* loops scattered at the grandstands
        public float[] crowdVolumes;           // their original volumes (parallel array), restored when un-muted

        [Header("Global rider chat - the board voice channel (riders heard across the map WHILE riding) - BoardVoiceChannel.uiMuted")]
        public Toggle riderVoiceToggle;
        public BoardVoiceChannel voiceChannel;   // muting drops you to plain proximity voice even while riding

        // ---- world effects --------------------------------------------------------------------------------------
        [Header("Snow effect (falling snow) - drives SnowfallU.SnowOn/SnowOff (renderer switch, not SetActive)")]
        public Toggle snowToggle;
        public SnowfallU snow;

        void Start() { Apply(); }   // assert the whole board (mode Trick / Showoff, everything else ON)

        // Re-read every control and re-assert the whole board. Wired to each Toggle's onValueChanged (param-less custom
        // event) and called by the row/button Interacts, so any click re-applies all of it - idempotent and
        // order-independent. Cheap: it only runs on a click.
        public void Apply()
        {
            if (music != null)        music.uiMuted        = !On(musicToggle);
            if (raceMusic != null)    raceMusic.uiMuted    = !On(raceMusicToggle);
            if (announcer != null)    announcer.muted      = !On(announcerToggle);
            if (voiceChannel != null) voiceChannel.uiMuted = !On(riderVoiceToggle);   // un-checked -> proximity voice even while riding
            ApplyCrowd();
            // Snow uses SnowfallU's own master switch (not SetActive): the field is fully shader-driven and the switch
            // just enables/disables its MeshRenderer, keeping enableSnow in sync for the inspector.
            if (snowToggle != null && snow != null) { if (snowToggle.isOn) snow.SnowOn(); else snow.SnowOff(); }
            ApplyMode();
        }

        // The mode picker's Interact target calls this with its own index (0/1/2). Re-asserts the whole board, so the
        // buttons repaint and the pooled boards get the new mode in one pass.
        public void SetMode(int m)
        {
            if (m < ModeRace) m = ModeRace;
            if (m > ModeFreeRide) m = ModeFreeRide;
            mode = m;
            Apply();
        }

        // Push the score mode onto every pooled board and apply the level's authored mode functions locally. A board
        // reads runMode when mounted; prop/rail presence changes immediately because it is world configuration.
        private void ApplyMode()
        {
            if (manager != null && manager.boards != null)
            {
                RideableBoard[] bs = manager.boards;
                for (int i = 0; i < bs.Length; i++)
                {
                    RideableBoard b = bs[i];
                    if (b != null) b.runMode = mode;
                }
            }
            int bit = mode == ModeRace ? 1 : mode == ModeTrick ? 2 : 4;
            if (modeObjects != null)
            {
                for (int i = 0; i < modeObjects.Length; i++)
                {
                    GameObject target = modeObjects[i];
                    if (target == null) continue;
                    int mask = modeMasks != null && i < modeMasks.Length ? modeMasks[i] : 7;
                    target.SetActive((mask & bit) != 0);
                }
            }
            if (railNetwork != null) railNetwork.SetShowoffEnabled(mode == ModeTrick);
            PaintModeButtons();
        }

        // The segmented look: the selected button is a bright filled chip with dark text, the others sit dim with pale
        // text. (A plain Toggle group would read as three independent checkboxes - this has to read as ONE choice.)
        private void PaintModeButtons()
        {
            if (modeButtons == null) return;
            for (int i = 0; i < modeButtons.Length; i++)
            {
                bool sel = i == mode;
                Image img = modeButtons[i];
                if (img != null) img.color = sel ? new Color(0.36f, 0.68f, 1f, 1f) : new Color(0.16f, 0.19f, 0.26f, 1f);
                Text lab = (modeLabels != null && i < modeLabels.Length) ? modeLabels[i] : null;
                if (lab != null) lab.color = sel ? new Color(0.04f, 0.07f, 0.12f) : new Color(0.72f, 0.78f, 0.88f);
            }
        }

        // Volume-mute / restore the looping crowd sources (no SetActive: a deactivated looping AudioSource with
        // playOnAwake won't auto-resume, so volume-mute keeps the loops running silently and resumes seamlessly).
        private void ApplyCrowd() { VolumeMute(crowdSources, crowdVolumes, On(crowdToggle)); }

        // Volume-mute (on=false) or restore (on=true, from the parallel originals) a set of looping sources, leaving them
        // running so a playOnAwake loop resumes seamlessly instead of needing a re-Start.
        private void VolumeMute(AudioSource[] sources, float[] volumes, bool on)
        {
            if (sources == null) return;
            for (int i = 0; i < sources.Length; i++)
            {
                AudioSource s = sources[i];
                if (s == null) continue;
                float vol = (volumes != null && i < volumes.Length) ? volumes[i] : s.volume;
                s.volume = on ? vol : 0f;
            }
        }

        // A row's state, defaulting to ON when its toggle ref is missing (so an absent checkbox never strands a system off).
        private bool On(Toggle t) { return t == null || t.isOn; }
    }
}
