# Ambient voice selection

Build 0.55 ranks audible placed emitters by their computed region gain before
assigning mixer voices. The clean Trailmap audio runtime description supplies
the point, ellipsoid, cone, gain-curve and contact-arming interfaces. Public
Slopesmith external-sound and ambient-sound tests establish loudest-first
selection, stable ties, inert zero-radius records and missing-buffer behavior.
No runtime implementation or differently licensed library supplies Native code.

Native uses an application default of 32 ambient voices. Its API permits 0..96,
leaving capacity in the shared 128-voice mixer for music, board audio and cues.
Those numbers are application policy; they are not a claimed Slopesmith default.
Equal gains use instance name plus external-record index, with input index as a
final fallback. Names therefore keep ties stable across reordered named
instances. Unnamed or duplicate records cannot promise order-independent identity.

An unavailable clip does not reserve a selected slot. Losing membership stops
that emitter's voice before replacements start; retained membership updates its
gain and position without resetting playback. Physical region entry remains
separate from budget membership, so an exhausted one-entry clip cannot restart
just because the budget changes. Native owns those one-entry voices too, retiring
them on region exit, budget eviction or restart. Contact-gated events retain
their arming when evicted, and run restart clears it. Placed ambience remains an
effect independent of the music enable setting.

The new portable suite passes 28 checks, including two-tone captured mixer PCM,
listener movement, stable voice/cursor identity, both tie orders, missing media,
zero budget/radius, dense fields, cone and elongated ellipsoid regions, one-entry
clips and silent-contact hydrant arming. All 49 Native suites pass. Production
contact, ambience, board and music replay validation covers 260 rendered frames.
Its pre-contact assertion was corrected from four ticks to three: both the saved
0.54.1 executable and this build first produce the identical cue on tick four
after the earlier body/trigger reach correction.

The same 28 checks pass against the built ARM64 core on the connected Quest
without opening or replacing the installed game. Both 0.55.0/code 58 APKs build,
Android lint passes, and the main package contains the sixteen exact notices,
ARM64 binaries and no private course media. These are build/CPU checks; this
milestone does not claim worn listening or sustained frame rate.

The field still evaluates all emitter gains. Spatial gathering, voice transition
fades, exact authored acoustic character and worn-device listening remain wider
parity/quality work. This milestone does not resolve fence flex, screen video or
the Merquer prop rendering and trash-can performance reports.
