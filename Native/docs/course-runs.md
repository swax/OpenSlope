# Course progression and timed runs

The shared player now offers Freeride, Race and Showoff. The Quest library's
Event selector remembers the choice; desktop accepts `--mode freeride|race|showoff`.
Freeride remains the application default and displays no event clock or result.
Timed runs wait while the VR player is on foot, then hold the mounted board for
a three-second countdown. Race counts up; Showoff counts down, with checkpoint
time awards. Pause/focus loss freezes simulation and its clock together.

Desktop shows the clock, phase, checkpoint count and lap in the window title.
VR shows a depth-tested clock/status panel above the left controller, with
checkpoint acknowledgement and control help. T on desktop restarts
the event and returns to the start without reloading the world. Touch Y now
toggles controls; a complete interactive wrist-menu restart is still pending.
The simple controller profile retains left Select. X/R retains the current placement-reset
behavior and preserves the event clock; complete path-driven carry-back is still
outstanding. Quest restart preserves its on-foot start preference.

## Path and event authority

Clean Trailmap 250/390 establishes stored distance-to-finish, horizontal stations,
the mode datasets, checkpoint payloads, finish location, clocks and lap order.
Slopesmith's public checkpoint/lap/clock tests and portable export manifest
establish comparison features. The native reader, projection, event crossings,
clock/state and text presentation are independently authored.

- Race and Freeride use AIP; Showoff uses SOP when present, otherwise AIP.
  The selected dataset supplies the middle start-path slot as in the existing
  application start policy. The original six-rider staging formation is deferred.
- A race line's DTF is its stored start value minus horizontal arc to the
  projected point. The seed remains vertex zero. The three nearest 3D bounds
  supply candidates; horizontal segment projection and 3D point distance choose
  the active line, distinguishing stacked runs without substituting 3D arc length.
- Forward DTF crossings dispatch raw event 11 from the active line. One route
  supplies the payload; alternate copies are not summed. Reverse travel awards
  nothing; returning behind a station re-arms it. Initial placement and changes
  of placement serial seed progress without granting crossed events.
- In Race a checkpoint advances its discrete counter and shows CHECKPOINT; even
  a nonzero AIP payload adds no time or points. In Showoff its positive payload
  adds seconds. Awards are bounded at 600 seconds, matching the authoring range.
  A last-tick checkpoint can extend the clock before expiration is finalized.
- The minimum-DTF AIP line supplies the finish at horizontal station DTF,
  including when SOP geometry disagrees. The last vertex and staging corral
  are not finish markers. Continuous forward crossing of its horizontal plane
  ends a single-pass run and freezes its result; arriving beyond it does not.
- Raw event 12 decrements passes remaining. A finish is offered before a
  coincident lap event, and remains gated while passes remain. This preserves
  Megaplex's separate lap station before the finish. Custom multiple-pass maps
  without a separate lap station count the finish plane itself, ending on the
  last pass. The tube's scripted lift/gate is a separate outstanding world feature.

The three-second countdown, 150 metre finish half-width and 30 metre vertical
clearance are explicit application tuning. Width/height tests reject far-wide
and overhead crossings. Result presentation holds the board while keeping the
world and tracked self-view available; it is not the original celebration,
podium or results animation. On-foot movement remains possible and an already
running clock continues while walking.

Clean 390's slot defaults seed the showoff clock: ALASKA 135, GARI 120, the
listed normal event slots 90, and TRICK/UNTRACK zero. Zero-clock slots do not
expire immediately. MEGAPLE seeds four passes; other slots seed one. `Origin.json`
preserves course identity through SAF's anonymous cache directories. Recognized
`Slopesmith.json` exports override `laps` (1–20) and `showoffSeconds` (0–300),
including zero. Settings are bounded to 1 MiB and cannot resolve outside the course.
The SAF cache retains both files; it still excludes `Source/` and `Import.json`.
A Race selection with no usable finish route reports a message directing the
user to Freeride or Showoff. Terrain-only maps remain playable.

## Evidence and remaining parity

329 portable assertions cover horizontal/stacked projection, countdown, mode
awards, alternate routes, reverse/forward edges, placement discontinuities,
bounded finish, frozen results, timeout, zero clocks, raw lap/finish ordering,
custom laps, centiseconds, AIP/SOP selection and authored settings. Seventeen
portable suites pass. The production Windows/Vulkan host renders 2,352 frames
across complete Race/Showoff runs, timeout, on-foot Ready, mount-to-start and
held-button restart. Existing boarding and charged-jump production replays pass.
The avatar GPU suite passes 52 checks, including a matched panel/no-panel pixel
comparison and visual inspection of clock digits and restart help.

All eleven existing local imported courses load both run datasets/settings and
their AIP finish. This is metadata/compatibility evidence, not proof of riding
every course to its finish. Quest JNI/custom-library/SAF validation passes 54
checks, including the two portable run-setting sidecars. Hardware launch and
live controller/comfort evidence are recorded separately; desktop completion
does not imply a worn VR test.

```powershell
./temp/native/Release/openslope_player.exe --map Maps/ALASKA --mode showoff --on-foot --first-person
python Native/tests/desktop_course_run_test.py temp/native/Release/openslope_player.exe
```

Full parity still requires the AI field and standings, tricks/score/meters,
pickups, mode-specific object sets, complete lap-tube/world logic, race/intro/
finish audio and music events, original countdown/results animations, path-driven
reset/fade and a complete in-view desktop HUD. These remain in desktop-parity.md;
this milestone establishes the event lifecycle and course metric they consume.
