# Shared trick score and boost energy

Race and Showoff start scoring at GO, after the countdown. Freeride keeps
unrestricted held boost. Desktop title/capture output and the right-controller
VR panel consume the same score state. The panel separates banked score, live
trick points, green banked/red lost results, and fifteen whole boost segments.
The existing left-controller clock remains separate.

Air rotations accrue 0.25 style per 360 degrees, combining spin and flip travel.
Style points use the clean 390 constant 6786.9 and nearest-ten rounding. A plain
360 previews 1700; x3 previews 5090. A clean landing banks once. Rails accrue
0.15 style per second and retain the open combo into air; returning to snow banks
it. At four seconds, big air adds `(airtime - 3) * 1000`, rounded to whole points.
Tiny flights below the application profile's 0.15-second grace discard their
preview without consuming a multiplier. Crashes, board release and placement
discard pending points while retaining banked points. Timed finish/expiry freezes
banked plus live preview; restarting creates a fresh score and quarter boost bar.
Zero-point skips, placements and finishes preserve the last positive bank/loss
readout; only a real scored trick creates a new result.

Held boost drains 0.045 per second and is unavailable at zero during an active
scored run. Walking/running does not spend board energy. Crash costs 0.1; manual
reset costs 0.12, while automatic placement is free, following clean 360/390.
The level selects default/weak/strong speed-cap tiers at 0.334/0.666; weak uses
1.1 times the default cap (30.6768 m/s). Rail thrust and resistance receive the
held amount. Base ground thrust retains clean 360's established 23.5 m/s² lean
window without inventing its unresolved slope multiplier.

Slopesmith's public `ride-score.test.ts` provides behavioral examples, not source
implementation. Native's play profile starts with 0.25 energy and fills on bank
from rounded **unmultiplied style points / 10000**. Consequently a 360 adds exactly
0.17, irrespective of its gem tier. Flat big-air points fill nothing. This matches
those public examples; it does not claim the complete clean 360 character-stat
formula, flip divisor, passive airborne bleed or uber/infinite tier escalation.
Those remain explicit work. Actual gems now collect through authored shape
contacts, apply the Showoff gate, tombstone draw/collision and chime through the
MAIN bank; see world-logic.md. Unscored hops preserve the tier until a scored bank. Named tricks, held-board grabs/flat hold tiers, live rail energy
registration, trick/boost audio, score pickups, score targets and a complete HUD
remain outstanding. The existing application air-boost aiming also remains a
separate parity gap.

Validation: 62 portable checks include production analytic touchdown, bad landing,
manual reset, countdown/restart, on-foot exclusion, empty-meter physics gating and
VR readouts. Four production Vulkan replays render 1311 frames through bank,
crash, manual reset and midair timed finish, checking frozen results and energy.
Avatar GPU checks render the right-controller digits and changed bank/loss colors;
see avatar.md. Build/device evidence for steering is in vr-steering.md.
