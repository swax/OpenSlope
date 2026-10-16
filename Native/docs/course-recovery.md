# Course recovery and reset fade

R/X and the existing active-run reset-surface, falling-below-bounds and unresolved
wipeout exits now use near-course recovery instead of always returning to the
start. Initial placement and a full run restart still use the start row. Existing
AIP/SOP data is sufficient; no map re-import is needed.

Clean Trailmap 250/390 supplies the placement core:

- Track a nearby AI path, including its horizontal station. A tracked path is
  projected at the request position so a fall's vertical offset does not choose
  an unrelated lower route.
- Among the six nearest respawn-enabled AI paths, minimize distance to the
  projection plus distance to the point eight horizontal metres ahead. Reject
  projections in the final two metres. Keep the tracked path when it wins.
- Raw event 103 pulls a station to its window start; 105 pushes it to the end;
  jump marker 100 pushes it past the jump interval. Raw 104 refuses the request.
- Probe from two metres above to three below the proposed point, align the deck
  to the actual support normal, raise it one world metre and seed exactly 30 km/h
  along the horizontal course heading. Placement increments the shared serial so
  camera anchoring and checkpoint crossing suppression use the existing path.
- Cancel pending score, retain banked score and event clock. An accepted manual
  reset costs 0.12 energy; automatic/refused requests cost nothing. Finished or
  expired events refuse new requests. Mounted recovery stays mounted; on-foot manual
  recovery restores the walker and a nearby board.

The support test rejects reset/unrideable/pass-through surfaces and normals below
0.2 world-up. Nearby race lines, a recent safe-ground trail and finally the run
start provide first-party play fallbacks when AI paths cannot supply a supported
target. This covers custom maps and authored airborne path sections. A course line
over 150 horizontal metres away is not used. Three accepted resets inside four
seconds choose the run start to escape a repeated carry-back trap; the guard then
re-arms after its window. These safeguards follow the first-party course-reset
behavioral examples; their exact distances, sampling and timing are application
choices rather than recovered constants.

Tracking refreshes after a metre of valid ground/rail movement. The bounded trail
records at five-metre spacing, keeps 128 positions, and first tries the previous
record. Large discontinuities discard stale ground history. AABB lower bounds
prune segment projections while retaining exact nearest-six ranking. Windows use
half-open intervals; overlaps prefer 103, then 105, then 100. These boundary and
overlap policies are explicit because the clean prose does not settle every tie.

Accepted requests enter clean 300/390's Control 22, hold position for 0.8 seconds
and fade the view to black over the first 0.5 seconds. Placement occurs while
fully black. Desktop and each OpenXR eye use the same fade across terrain, props,
sky, effects and the avatar. The controller panel reports returning to course.
The application then fades the new view in over 0.2 seconds. That fade-in is an
application choice; the separate recovered viewport effect which switches on at
0.2 seconds has no established effect type and remains outstanding.

The run clock continues during the hold; riding, boarding, jump and boost input
cannot move the rider or spend extra energy. Held buttons do not retrigger on
arrival. A full restart cancels the pending recovery. An already accepted reset
finishes if the event clock expires during its hold; subsequent requests are
refused. This terminal transition is an application policy that avoids revealing
the old unsafe position after a partial fade. Positive score results survive
zero-point terrain skips, resets and event expiry.

Authored reset-node dispatch is connected in 0.24; see world-logic.md. Build 0.66
adds field path selection, rubber-banding and shared-rider forward bias; see
ai-field.md. The original world-grid death plane and the higher-threshold contact
integrator remain outstanding.
On-foot falling retains its existing application recovery. Path selection here is
an independently authored geometric player tracker, not the complete AI tracker.

Build 0.67 adds the scored-run wedge accumulator from clean 395-reset-arm. An
actual prop response or rider separation contributes `1 - dot(boardUp, normal)`;
multiple solver contacts in one tick contribute their maximum. Terrain, passive
triggers and rideable support do not feed it. The accumulator has a 0.1-second
half-life and a threshold of four, independently chosen to reproduce about five
consecutive square-on shoves at the fixed 60 Hz simulation rate. These decay and
threshold values are explicit native application choices. Accepted recovery uses
the existing hold, nearby path placement, field bias and clock preservation.
Placement clears the accumulated contact history. Freeride, walking, scripted
transport and terminal runs do not arm this accumulator; default play retains
control after ordinary impacts.

The shared field additionally checks responsive-prop clearance for both the
raised spawn and seated avatar before choosing its recovery route. This native
application safety policy filters the existing six nearest respawn-enabled
candidates; it does not add a time-based stuck reset. See `course-contact-0.67.md`.

Portable fixtures exercise horizontal station/height, the eight-metre criterion,
respawn flags/end margins, window nudges/refusal, safe alternates, trail/start and
trap fallbacks, real sloped-floor alignment, energy/clock preservation and on-foot
placement, the hold/fade clock, held-button suppression, restart and clock expiry.
Three production Vulkan replays render 641 frames through manual and automatic
recovery plus no-reset refusal, verifying a completely black image at placement.
GPU fixtures also check partial/full fades for UNORM/sRGB and 1x/4x sampling.
An optional local Maps sweep tests six supported placements on each of eleven
imported courses (66 total), including trail fallback for airborne path sections.
This sampling does not establish every possible full-course recovery or headset
comfort. No new worn-headset recovery test is claimed.

Build 0.23.0 passes all 20 portable suites (66 recovery and 60 scoring checks),
the replay checks above, 1,158 Vulkan appearance/fade checks and 84 avatar/HUD
GPU checks. Both ARM64 debug/test APKs build; signatures, version and notices
are verified, and Android lint reports zero errors with four existing warnings.
The native source-boundary audit passes. Immutable desktop/APK artifacts are
saved under the ignored `temp/native` build tree. The installed Quest build
remains 0.22.0 for the user's steering test.
