# Desktop and wrist audio settings

Build 0.51 exposes the shared music lifecycle through both play menus. Open
**Audio** to change game volume in ten-percent steps, mute/restore the previous
audible volume, enable music independently, or select **Random** or a specific
course song. A paged song list supports longer playlists. Authored mountains
show their master track instead of offering unrelated reference songs.

The behavior follows the public Slopesmith music settings contract: music starts
enabled, game volume starts at one, zero means actual silence, and explicit song
choices belong to individual courses. Music disable also silences the off-board
environment/intro layer; placed ambient effects and board/world sounds remain
under the separate master volume. The music checkbox stops that bus immediately;
dismounting retains its 1.5-second fade. Music selection takes effect in the current
run. Random retains its current run choice until a new run starts.

Desktop **M** mutes/restores the current volume, including after a restart.
Settings save when changed and apply before audio output starts or a replacement
course begins. Menu pointer input consumes the click/trigger and requires a fresh
press for the next page; changing settings cannot also mount a board. The main
wrist menu retains separate map-library and app-exit actions.
Menu FPS moves into the header so it cannot overlap the wrist Exit or Back row.
Menu FPS moves into the header so it cannot overlap the wrist Exit or Back row.

Preferences are app-owned JSON, not map assets. Windows uses
`%LOCALAPPDATA%/OpenSlope/audio-preferences.json`; Quest uses internal application
files. `--audio-preferences <file>` selects an explicit desktop profile for
testing. Offline captures and smoke windows use defaults unless a profile is
explicitly supplied. Quest passes the selected map's stable display name to
Native, so document-picker cache UUIDs do not change the per-course key. Course
keys fold ASCII case and reject path-like names. The selected map library and
imported files are unaffected.

Reads are bounded to 256 KiB and 512 course selections. Missing/corrupt settings
fall back to audible defaults; bad fields retain defaults. Writes replace a
complete temporary file atomically. Save failures leave the prior file intact
and display a short notice while play remains available. Music-on state and the
previous audible master trim persist separately.

Portable checks exercise replacement/failure/corruption, course separation,
restored volume, paged ray selection, held-trigger capture, effects independence
and first-sample master silence. Production tests launch two separate menu/map
switch sessions, reload their saved file, and record 906 Vulkan/PCM frames for
per-course song selection, music disable, surviving ambient effects, true master
zero and the compact rendered Audio panel. Device lifecycle instrumentation
temporarily supplies a synthetic audio profile, checks stable course identity
and retention across Home/resume/exit, and restores the user's prior profile.

Validation for 0.51.0/code 53: the repository gate passes in 243.8 seconds,
followed by all 48 Native suites on the final source. Focused runs pass 56
preference/menu checks, 38 music/streaming checks and 22 public music-API
observations. Production regression coverage totals 3,895 Vulkan/PCM frames,
plus live desktop menu/map-switch sessions. The source boundary checks 344
Native files. The captured Audio panel remains compact and was visually checked.

The Quest also runs the same 56 preference tests as a standalone ARM64
executable linked against the APK's actual core, exercising Android/POSIX file
replacement and mixer/menu behavior. The installed APK passes 115 library/SAF
checks; three lifecycle launches load the synthetic music/volume/song values,
Home resumes the same course, and three exits release XR resources cleanly.
Six checked ALASKA files, launcher preferences and the prior audio profile retain
their hashes/state. Eight-second ALASKA startup initializes both 1680x1760 eyes
at 4x MSAA and the full-body tracker. Lint reports zero errors and four existing
warnings; desktop and signed ARM64 APK packages retain all sixteen exact notices
and contain no private course media.

Saved builds: `temp/native/desktop-audio-settings-0.51.0` and
`temp/native/OpenSlopeNative-quest-0.51.0-audio-settings-debug.apk`. The adjacent
manifest pins hashes, source commit, ARM64 test provenance and device evidence.

Validation for 0.51.0/code 53: the repository gate passes in 243.8 seconds,
followed by all 48 Native suites on the final source. Focused runs pass 56
preference/menu checks, 38 music/streaming checks and 22 public music-API
observations. Production regression coverage totals 3,895 Vulkan/PCM frames,
plus live desktop menu/map-switch sessions. The source boundary checks 344
Native files. The captured Audio panel remains compact and was visually checked.

The Quest also runs the same 56 preference tests as a standalone ARM64
executable linked against the APK's actual core, exercising Android/POSIX file
replacement and mixer/menu behavior. The installed APK passes 115 library/SAF
checks; three lifecycle launches load the synthetic music/volume/song values,
Home resumes the same course, and three exits release XR resources cleanly.
Six checked ALASKA files, launcher preferences and the prior audio profile retain
their hashes/state. Eight-second ALASKA startup initializes both 1680x1760 eyes
at 4x MSAA and the full-body tracker. Lint reports zero errors and four existing
warnings; desktop and signed ARM64 APK packages retain all sixteen exact notices
and contain no private course media.

Saved builds: `temp/native/desktop-audio-settings-0.51.0` and
`temp/native/OpenSlopeNative-quest-0.51.0-audio-settings-debug.apk`. The adjacent
manifest pins hashes, source commit, ARM64 test provenance and device evidence.

The wider music work in music-playback.md and gameplay/rendering requirements in
desktop-parity.md remain active. Worn wrist readability, controller interaction
and listening are separate headset checks.
