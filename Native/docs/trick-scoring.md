# Shared trick score and boost energy

Race and Showoff start scoring at GO, after the countdown. Freeride keeps
unrestricted held boost. Desktop and the right-controller VR panel consume the
same score state. Showoff separates banked score, live trick points, green
banked/red lost results, and fifteen whole boost segments. The live readout
itemizes the four-factor rotation equation, grind duration or holding hand and
grab duration. Race shows clock/laps and boost while retaining internal trick
scoring for energy. The left-controller clock remains separate.

Air rotations accrue 0.25 style per 360 degrees, combining spin and flip travel.
Style points use the clean 390 constant 6786.9 and nearest-ten rounding. A plain
360 previews 1700; x3 previews 5090. A clean landing banks once. Rails accrue
0.15 style per second and retain the open combo into air; returning to snow banks
it. Rail turns contribute rotation style to that same combo, including a launch
tick's turn. At four seconds, big air adds `(airtime - 3) * 1000`, rounded to whole points.
Tiny flights below the application profile's 0.15-second grace discard their
preview without consuming a multiplier. Crashes, landing off the board and
placement discard pending points while retaining banked points. Timed finish/expiry
freezes banked plus live preview; movement, steering, world contacts, boost,
transport and course reset remain available. Finished boost is unlimited. The
result clock stays frozen and transient trick feedback still expires after three
seconds. Restarting creates a fresh score and quarter boost bar. An authored
Showoff clock of zero has no timer readout or expiry.
Zero-point skips, placements and finishes preserve the last positive bank/loss
readout; only a real scored trick creates a new result.

An airborne grip takes the mounted deck into a hand without abandoning the
event, changing course-placement continuity or discarding rotation style. Holding
it adds 0.0425 style on recognition and 0.045 style/s (the first-party default
rate), plus the clean 390 flat ladder: 4000 at 1 s, 8000 at 1.5 s, 12000 at 2 s,
16000 at 2.5 s and beyond. A hand transfer keeps the timer and recognition;
throwing pauses held time, and recatching recognizes the trick again. Trigger
re-equipping preserves the combo for landing. Gem multiplication and boost fill
apply only to style, not to the flat grab bonus. A one-second grab scores 4590
and fills 0.059 boost, matching Slopesmith's public scoring test. The recognition
and hold rates are also documented in Unity's public `docs/050-leaderboard.md`;
Native does not consult either port's runtime implementation.

An explicit dismount still abandons the event and clears its scoring, preserving
the requested unlimited-boost free ride on remount. That action is separate from
the airborne grip used for a scored grab. Restart restores the selected event.

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
those public examples; it does not claim the clean 360 flip divisor, passive
airborne bleed or uber/infinite tier escalation, which remain explicit work.
Retail character stats are not recreated, so this single first-party profile
stands in for per-character scaling. Actual gems now collect through authored shape
contacts, apply the Showoff gate, tombstone draw/collision and chime through the
MAIN bank; see world-logic.md. Unscored hops preserve the tier until a scored bank. Live rail energy
registration, trick audio, score pickups, score targets and the remaining HUD
remain outstanding. The retail named-trick and grab repertoire is out of scope
(see the Scope section of CONTRIBUTING.md). Held engage and pad chimes now use their MAIN slots through
the audio mixer; boost-volumes.md describes the updated application air-thrust
profile and its remaining recovered-behavior gap.

Validation: 118 portable checks include production analytic touchdown, scored
airborne grips/remounts, bad landing without a default knockdown, manual reset,
countdown/restart, on-foot exclusion, empty-meter physics gating and VR readouts.
Seven production Vulkan replays render 2293 frames through bank, grab, off-board
loss, manual reset and midair timed finish, checking frozen results and continued
physical riding. See score-ui-0.63.md for host/Quest and UI evidence.
Avatar GPU checks render the right-controller digits and changed bank/loss colors;
see avatar.md. Build/device evidence for steering is in vr-steering.md.
