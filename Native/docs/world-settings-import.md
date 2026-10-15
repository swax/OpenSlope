# Automatic course sun and sky import

Build 0.43 writes `World.json` during ISO course extraction on desktop and Quest.
The file uses `openslope-world/v1`, with the selected course identifier, a byte RGB
`SkyColor` and the portable `Glare` fields already consumed by the renderer.
Authored Maps folders continue to supply their own world settings.

Clean Trailmap 442 establishes a startup-initialized array of thirteen scalar
records. The shared `Contracts/world-layout-v1.json` contains the slot identifiers
and relative field offsets, with no executable addresses, instructions or retail
colour/settings table. Clean 400 supplies the rendering meaning and map-frame
angles. The native reader is independently authored; it does not use another
component's executable reader or runtime implementation.

The reader follows `SYSTEM.CNF`'s `BOOT2` reference through the existing bounded
ISO directory reader. It validates a little-endian ELF32 MIPS executable and its
load/code ranges. Candidate regions are found structurally from scalar constant
stores, ordinary return boundaries and stack prologues. A small constant evaluator
tracks known bytes in integer/FPU registers, a private stack and a private output
record buffer. It supports the scalar arithmetic, stores, bounded branches and
unaligned copies needed to materialize the records. The supplied executable is
never loaded as host code, invoked or allowed to write its own memory.

Standard field/shift/load conventions follow the
[MIPS Technologies instruction-set manual](https://minnie.tuhs.org/CompArch/Resources/MD00086-2B-MIPS32BIS-AFP-02.50.pdf).
The target's three-register low-word multiply behavior and record copies were
independently checked against user-supplied data and newly authored programs.
Every output record must have all bytes known, and all thirteen records must
satisfy typed flag, RGB and finite scalar constraints. Matching duplicate
initializers are accepted; conflicting complete profiles reject import.

The analysis has a 64 MiB executable limit, bounded load/section counts, a
256 KiB candidate limit, 32,768 steps per candidate and two million steps total.
Unsupported instructions/calls or unknown data reject that candidate. Cancellation
is checked during scanning and evaluation. A missing settings source, unknown
course slot or unrecognized initializer contributes no world file; malformed
containers, ambiguous results and exhausted global work limits fail the import.
Existing import rollback prevents a partly populated course from being published.

The ordinary conformance suite uses only original synthetic ISO/ELF data. It
covers all slots, float transfers, counted loops, four/eight-byte unaligned
copies, code relocation, prologue discovery, duplicate/ambiguous sources,
unknown bytes, malformed containers, cancellation and full-import rollback.
Android instrumentation additionally imports its synthetic GARI slot through the
actual descriptor/JNI path and checks the automatically written world settings.

Validation passes all 42 native suites, including 58 authored import cases and
direct immediate/mid-analysis cancellation checks. The full repository gate
passes in 271.0 seconds. The user's image supplies all thirteen profiles;
99 sun fields across eleven existing exports match exactly, including float32
bits. All 39 sky bytes match both published regional manifest digests. A fresh
Mesa ISO import automatically includes its matching world file and renders
62 comparison frames with identical rider physics and visible beams. The
existing celestial Vulkan suite passes 565 checks.

The signed 0.43.0/code 44 ARM64 app passes 96 Quest JNI/custom-library/SAF
checks, including the new automatic import path. Lint has zero errors and four
existing warnings. All sixteen license/notice assets match their sources;
the main APK contains no private disc/course/media files. The existing verified
retail ALASKA folder receives only its previously missing recovered world file;
its patch and library-preference hashes are unchanged.
An eight-second ALASKA activity check initializes both 1680x1760 eyes at
4x MSAA and the full-body tracker; this is startup evidence only.

Private comparison uses the user's USA image and existing portable map exports.
Those files and derived captures stay outside source and application packages.
No PAL image has been tested. Relocated authored binaries demonstrate address
independence; they do not establish compatibility with every executable revision
or a general-purpose CPU emulator.

Existing imported folders are preserved. Reimporting into a new Maps folder adds
the settings; the reader never guesses a retail profile for an arbitrary custom
course or overwrites an authored `World.json`. A separate desktop inspection
command prints a recovered profile without modifying the ISO or a map:

```text
openslope_import world <user-supplied.iso> <course>
```

Weather, complete fog/light setup, point-light flares, original display-domain
composition, collision-event sound routing and wider gameplay parity remain
separate work. APK/instrumentation checks do not prove worn sun appearance,
comfort or sustained headset performance.
