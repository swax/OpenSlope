# Start, interaction and lighting follow-up

Build 0.54 addresses the next Quest play-test reports. The implementation uses
clean Trailmap 160/360/370, public first-party tests/docs and independently
inspected owned course data. No separately licensed runtime implementation is
read or reused.

## Starts and scoring

Negligible sideways drift no longer disables application cruise propulsion.
The normal speed-dependent alignment law still controls established travel.
Snowdream's Race/Showoff start lies in its authored start-reset volume. Previously
each recovery placed the rider back in that same volume, immediately starting
another fade. Placement now latches overlapping reset volumes until the rider
leaves them. Entering an armed volume still activates recovery. Full restart,
manual recovery, mounting and on-foot placement all establish fresh overlap
history; this does not add a timer that masks unrelated hazards.

Getting off the board abandons the current event and clears scoring. The next
mount stays in Freeride with unlimited boost. Explicit Restart restores the
originally selected Race/Showoff configuration and countdown. World layout and
already collected rewards are not reloaded by a dismount.

## Vents and contact cues

Force occupancy uses the same swept rider spheres as prop contact, as well as
the foot-point segment. Previously a body could enter a wind volume while its
feet remained outside: a zero-duration force then retired without driving it.
The same coverage governs exit/rearm. Authored directions, target speeds, time
windows, tube stages and lap rules retain their existing units and behavior.

Nonresponsive contact volumes play their mapped sound once on entry, independent
of the surface-normal impact speed. Solid impact sounds retain speed scaling.
This includes Tokyo's pressure buttons, whose gate graph and contact sound are
separate authored routes.

## Quest settings

Fresh settings default to 150% eye resolution and a 120 fps target. Saved choices
remain in effect. Ride settings offer 72, 80, 90 and 120 fps. Native enables
`XR_FB_display_refresh_rate` only when advertised and requests an enumerated
supported rate, falling back to the highest supported rate below the target.
An optional-extension failure leaves the runtime in control. The request occurs
once at session begin; thermal/runtime changes are not repeatedly overridden.
The target does not guarantee sustained rendering throughput.

Authority: the [registered refresh-rate extension](https://registry.khronos.org/OpenXR/specs/1.1/html/xrspec.html#XR_FB_display_refresh_rate).

## Lamp glints and halos

New ISO imports write portable `Lights.json`. Older Native imports can recover
the light records from their retained `Source/*.PBD`; custom maps use their
portable table. The small sprite classes select glints, independent of type or
name. Euclidean normalization removes illumination magnitude from the hue;
negative/subtractive and black records produce no additive sprite.

Each eye submits at most ten nearest on-screen lights in one additive batch.
The source-depth-tested procedural halo, screen-position-rotated cross and
fixed 16 by 8 pixel core share the source hue. World-sized geometry uses the
clean small/medium/large scale; centredness raises size/brightness and the last
half of the application 600 m range fades linearly. Opaque terrain/props/avatar
occlude each pixel; glints do not write depth. This is a first-party procedural
presentation, not a claim of pixel identity with an extracted lens atlas.

The independent light-table inspection identified the count/offset pair and
92-byte records by matching owned exported vectors against owned source data.
The bounded decoder exports the shared field names without importing another
decoder. An automatic approval review rejected an attempted public tuning-API
query because it would import runtime code; no such query was executed, and the
implementation instead follows clean semantics and public tests/docs.

## Validation

The full repository gate and all 48 Native suites pass. Actual Vulkan celestial
and lamp checks pass 585 assertions in UNORM/sRGB, including partial/full depth
occlusion. Owned checks pass 320 start/recovery assertions (66 placements on
eleven courses), 299 boost assertions (67 drivers and 47 pads), and 1,005 light
and celestial assertions. The production shatter replay passes 3,972 Vulkan/PCM
frames; trigger-entry audio has an additional stationary-volume replay.

Both ARM64 APKs build and pass lint/signature/package checks. Quest 0.54.0/code 56
is installed, with 115 JNI/library checks and 154 launcher/accessibility checks.
Checked ALASKA files and preferences preserve their hashes. The fifteen-second
ALASKA startup reports 2520x2640 per eye (150% of 1680x1760) at 4x MSAA, but no
active headset views/session begin. Worn appearance, refresh negotiation and
sustained frame rate are not established by that startup.

Saved builds use `temp/native/desktop-playtest-0.54.0` and
`temp/native/OpenSlopeNative-quest-0.54.0-playtest-debug.apk`.

Additional ground-level approach probes identify a remaining fan-housing/contact
margin issue and require a gentler tube lift to separate from ground support.
These remain follow-up work rather than being claimed fixed by force occupancy
alone. Broader prop brightness, the
Quest-only train report, ambient voice budgeting, fence flex and screen video
remain separate parity work.
