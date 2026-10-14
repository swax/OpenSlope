# Rails

Clean Trailmap chapters 140, 220, 230 and 350 define the spline records,
candidacy and grind lifecycle. Native independently converts PBD power curves
and SSF flags into the existing Splines.json contract. Optional power coefficients,
arc metadata and source links preserve the original curve without decimal control
rounding. Edited Points take precedence when they disagree with those coefficients.
Missing SSF preserves geometry with candidacy disabled. Style -1 mover paths are
excluded. Canonical raw centimetres become world metres through `(x,z,-y)/100`.

A bounded hierarchy gathers candidates within three metres. Five samples/four
chords bracket a true-cubic golden search with at most 24 iterations and 0.0005
parameter tolerance. Exact derivatives establish the tangent. Entry uses the
strict snap window scaled by 0.9; the first 0.6 seconds use its widest blend.
The independent port chooses tangent/side/up offset axes and the narrowest
post-grace blend because those details remain unresolved in the clean chapter.

Ground and air can enter Motion 3 / Control 15. Capture retains velocity and
clears carve lean. Tangent alignment runs at 30/s while preserving speed;
gravity is 9.8 m/s² and binary held boost is 24.508 m/s² along travel. The shared
cap can lower speed. Side/up snap corrections are bounded at 2.9 metres. There
is no friction or balance meter. Quantized steering slews spin at 75 degrees/s²
and clamps yaw at 80 degrees; the camera keeps the travel heading. The boost
spin multiplier is provisional pending trick windows. Eight flick bins are
retained but do not yet dispatch trick animations or scoring.

Only torso/head collision limbs are active on a rail, with the pelvis retained
as a mode 2/3 gate. The rendered tube remains an ordinary prop. Jump uses the
shared charge/release launch, with a short recapture cooldown. E on desktop or
left-stick click in VR exits with carried velocity. Lost contact returns to air;
adjacent nearest curves can chain. Wake and snow spray stop during a grind.
Runtime rail toggles exist; event-graph dispatch and LTG/mode visibility do not.
Original pose, rail audio switching and rail tricks remain outstanding.

Validation includes 588 portable assertions, malformed/import rollback fixtures,
six production Vulkan cases totalling 664 rendered frames, and Android main/test
APK builds plus lint. All eleven local course imports compare names, candidacy,
styles, counts, links, arc metadata and exact source coefficients. Existing
control output permits an explicit float32 rounding bound; its largest observed
delta is 0.026094 raw cm (0.261 mm). This is not a claim of original trajectory
equivalence. A 60-tick GARI replay captures a candidate rail with no contacts or
bounces. Retail assets remain ignored and excluded from application packages.
