# Automatic collision sound routes

Build 0.44 completes collision-event routing during native ISO import on desktop
and Quest. It writes the map-local `Audio/SoundIndex.json` contract using the
selected disc's configured bank names and independently recovered group/slot
outputs. It supplies no compiled retail event table or course-to-bank list.

Clean Trailmap 190/420 establish event resolution, authored silence, the separate
environmental group, the receiver/event/output-pointer interface and contact
playback. Native's new bounded scalar control-flow evaluator is independently
authored using standard ELF/MIPS conventions. It shares container/boot-reference
validation with the sun/sky reader. It does not execute the supplied binary as
host code, call platform APIs from it, or write source/executable memory.

Discovery finds bounded runs of code pointers and nearby entry candidates.
Only candidates whose control flow demonstrably dispatches through that table
and returns valid output words are considered. Analysis tracks scalar registers,
helper calls/returns, conditional and indirect branches, branch delay effects
and private stack/output bytes. An untouched slot remains silent; writing an
unknown or invalid result rejects the candidate. Matching duplicates are
accepted and conflicting complete results reject import.

The application bounds discovery to pointer runs of 24..1024 entries, target
spans of 16 KiB, entry searches within 4 KiB, 512 tables and 64 entry candidates
per table. It probes the first 32 event ids for dispatch evidence, then checks
ids 0..1023. Each probe has a 4096-instruction budget; the whole recovery has a
15-million-instruction budget and cancellation checkpoints. This supports the
observed dispatcher, not arbitrary executable revisions or general emulation.
Unsupported dispatchers retain the explicit empty Deferred index. Malformed
containers, conflicting results or exhausted global work fail with normal
whole-course rollback.

Recovered indexes use the existing schema fields: `Schema`, `Level`,
`SourceExecutable`, `Banks` and `CollisionEvents`. Each event has `Group`, `Slot`,
`Bank` and an explicit map-relative `Clip`. Routes for groups absent from the
course configuration are omitted. Group 6's separate environmental path still
uses `ExternalIndex.json`; dynamic traffic/chant selection remains separate
work. A mapped but empty bank slot has no substitute WAV or fallback sound.
Native retains the bank archive member's filename case in both folder and clip
paths. Older exports can spell the same bank identifier with different case.

First-party synthetic ISO/ELF fixtures use unrelated case data and register
allocation. They cover nested calls, indirect dispatch, delayed stores,
silent/empty slots, group overrides, relocation, duplicates/ambiguity,
nonlocal/unknown writes, cancellation and the normal config-driven import path.
The Android fixture imports the same authored dispatcher through a seekable
descriptor and checks its map-local output.

Validation passes 43 native suites, including 18 authored dispatcher/import
cases and immediate/mid-analysis cancellation. The full repository gate passes
in 235.7 seconds. The user's USA image yields 95 ordinary/crowd routes matching
the existing portable export, plus 87 separate environmental classifications.
All eleven fresh native imports reproduce their existing 1,045 collision routes;
bank identifiers agree, allowing the established filename-case difference.
No PAL image has been tested.

Actual GARI walking/riding comparisons each play one contact cue. Against an
unresolved-index comparison, captured PCM differs in 10,952/9,350 samples with
peak differences of 9,222/14,217 respectively, while position/velocity stay
identical. The authored barrier replay passes 315 production Vulkan frames for
transparency, visible fragments, retirement and mapped PCM. Its impact view is
sampled before the first-person head passes the debris. GARI's broader graph
still reports two unrelated unsupported operations; whole-course logic parity
is not established by these sound checks.
Another 240 comparison frames start walking from rest with the glass route
isolated; they produce one cue with unchanged motion, confirming ordinary
walking without an initial velocity or boost.

The signed 0.44.0/code 45 ARM64 app passes 98 Quest JNI/custom-library/SAF checks,
including automatic route recovery. Lint reports zero errors and four existing
warnings. All sixteen license/notice assets match their sources and no private
course/media files are packaged. ALASKA's verified Deferred index is upgraded
with 95 routes; its existing bank names, geometry, instances, world settings
and library preferences are preserved. Original sidecars are backed up locally.
An eight-second ALASKA activity check initializes both 1680x1760 eyes at
4x MSAA and the full-body tracker. This is startup evidence only.

Existing custom Maps folders continue to supply explicit routes. Existing
imported folders are preserved; a fresh import into a new Maps root adds the
new sidecar. The desktop command below inspects routing without changing an
ISO, executable or map:

```text
openslope_import collision-routes <user-supplied.iso>
```

Build 0.45 adds independent board-family extraction (board-audio-import.md).
Wider audio/music/announcer behavior, exact impact gain,
complete breakable lifecycle and worn headset listening/performance remain
active parity work. Successful device import/startup checks do not prove worn
audio perception or sustained frame rate.
