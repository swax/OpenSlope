# Scored board grabs and supersampled desktop UI

Build 0.63 keeps an airborne grip inside the current scored run. Holding the
deck accrues recognition/hold style and the clean 390 half-second flat ladder.
Transfers preserve the timer; throwing pauses it; recatching recognizes a fresh
hold. Trigger remounting preserves pending points for landing. Explicit dismount
still abandons scoring and provides unlimited boost on remount, as requested.

One held second scores 4590 and adds 0.059 boost on bank: only the 590 base-style
points fill energy. Gems scale style, not the flat 4000-point tier. Rail turns
now add rotation style alongside continuous grind style. See trick-scoring.md
for authority, arithmetic and remaining scoring gaps. Native uses independently
authored code and public behavioral documentation/tests, without consulting other
ports' runtime implementations.

Time-up and finish freeze score and event clocks while riding, steering, boost,
contacts, force volumes, transport and reset continue. Post-event boost is
unlimited. Bad landings lose pending score independently of physical knockdowns;
the default rider retains control. The desktop thin bars and controller panel
share live rotation/grind/grab details and temporary bank/loss feedback. Race
shows clock/laps and boost rather than trick points. An authored zero Showoff
clock has no timer readout or expiry.

The user's desktop menu report reproduced at 150% scene scale: the native-size
presentation pass was single-sampled even when 4x MSAA was selected. It now uses
a separate native-size multisample colour attachment and resolves after both
the downsampled world and UI draw. UI geometry stays at window resolution and
retains the selected edge coverage. A 576x429 interior menu crop differed from
the 100% render at 17,019 pixels before the fix and zero afterward. Additional
native-size multisample storage is allocated only for supersampled targets.

## Verification

- All 54 portable suites pass. Focused CPU suites pass 118 scoring, 333 course,
  72 recovery, 74 world-logic and 126 boost assertions on desktop and Quest ARM64.
- Seven production Vulkan replays cover 2,293 frames, including grab/remount,
  release before landing, expiry during a grab, loss without a knockdown, and
  continued movement with a frozen result.
- The actual Vulkan menu/font, snowfall, scale, depth and queued-stereo suite
  passes 845 assertions on desktop and Quest. It compares native UI coverage at
  100/125/150/200%, 1x/4x MSAA and UNORM/sRGB outputs.
- Avatar/controller GPU checks pass 258 assertions with owned-course desktop
  captures and 243 synthetic assertions on Quest, including actual hand/timer
  pixels. Device input and worn appearance remain play-test work.
- The full repository gate passes in 448.8 seconds. Final renderer changes also
  pass the host build, portable suites, Android build and desktop/Quest GPU
  checks. Package signatures and all sixteen notices verify; private course
  media is absent from the ARM64 package.
- The real desktop window/map-loading smoke passes. The signed APK is installed
  with all eight imported courses and saved settings preserved. JNI/library/SAF
  checks pass 115 assertions and launcher/accessibility checks pass 157. Lint
  reports zero errors and three existing warnings. Snowdream's VR activity
  launches for twelve seconds; this establishes startup, not worn rendering or
  sustained frame rate.
- The real desktop window/map-loading smoke passes. The signed APK is installed
  with all eight imported courses and saved settings preserved. JNI/library/SAF
  checks pass 115 assertions and launcher/accessibility checks pass 157. Lint
  reports zero errors and three existing warnings. Snowdream's VR activity
  launches for twelve seconds; this establishes startup, not worn rendering or
  sustained frame rate.

Frozen builds are `temp/native/desktop-score-ui-0.63.0` and
`temp/native/OpenSlopeNative-quest-0.63.0-score-ui-debug.apk`. The build manifest
records hashes, commit, device preservation and validation logs.

## Open play-test findings

The user reported falling through Snowdream at a right-angle jump corner on
desktop. This remains a collision investigation; this build does not claim to
fix it. The restored ground-flare halos are visible but still differ from the
Slopesmith/Unity appearance and need a matched visual comparison. In-world video
screens remain excluded. The broader gameplay parity objective remains active.
