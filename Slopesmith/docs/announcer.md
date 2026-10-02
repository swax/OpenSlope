# Announcer in Test

Test > Options > Announcer sits directly below Music. It defaults on, remembers the local preference, applies immediately, and shares Game volume. Scene > Sound > Announcer edits the mountain's voice settings: volume, quiet time after each line, event chances, and an optional uploaded WAV for each event. A zero chance disables that event. Previews bypass the Test master and share the existing exclusive sound-preview player.

The seven default banks match VRChat's AnnouncerU: Go, Big_Air, Land, Knockdown, Slow, Boost_Icon, and Sweet. Slopesmith reads the user's extracted files from Maps/Shared/speech/mc/<bank>/NNN.wav through the viewer-accessible announcer-audio and announcer-sound APIs. Missing banks stay silent; a custom voice works without a shared bank. Uploads use the existing mountain sound library and its PCM16 mono, ten-second limit.

GO fires when a timed gate run actually starts, after any countdown; free riding and ordinary remounts do not manufacture a start. Fixed physics ticks detect big air, substantial landings, held boost, slow riding, and long clean stretches. Recovery resets trigger wipeout calls. Defaults follow the VRChat tuning, including event chances, rearm times, priority interruptions, and no consecutive repeats within a bank. Only the local rider speaks. Pausing, dismounting, muting, or ending Test stops the voice and cancels pending loads.

Settings are stored in the optional announcer document field and survive save/load, undo/redo, terrain regeneration, and project asset copying. This first pass customizes Slopesmith Test playback on either target; it does not change Unity or PS2 speech exports.

Validation: test/announcer.test.ts covers normalization, document and UI preferences, event timing, missing banks, path validation, custom clips, non-repetition, interruption, cooldown, and late-load cancellation.
