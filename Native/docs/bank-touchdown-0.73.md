# Bank touchdown and ground-state continuity

Build 0.73 addresses the desktop Snowdream report: a rider slides along the snow,
loses carve sound and can spin with air controls, including after a jump and
around large banks.

The raised terrain-guard sphere can touch a steep surface while the deck root
is still above it. The guard prevents further approach, but the ordinary landing
ray requires a root crossing. The rider remains in the air state indefinitely.
An authored 65-degree bank reproduces this in 0.72: no landing in 180 ticks,
175 near-surface air ticks and 202.5 degrees of input-driven air rotation.
The same symptom reproduces in the full Snowdream scene.

A falling rider's actual guard contact now refines the contacted curved sheet
and enters ordinary touchdown. It requires the same patch, matching front-facing
normals, the root on the front side and velocity approaching that surface.
Rising/departing riders keep the ordinary crossing path. A cached probe behind a
rider cannot cause this handoff. The landing response, score handling, board
orientation recovery and default no-knockdown profile retain their existing rules.

At a narrow floor/bank junction, the carve offset can keep the deck above the
floor while the physics root crosses it. A real front-facing root crossing into
a sufficiently different terrain plane now hands off support to that plane.
The existing corner-containment requirements remain unchanged. The first guard
handoff candidate failed one of those requirements; it was corrected before
preparing the final build.

These are independently authored Native containment rules alongside clean
Trailmap 320's analytic contact and 340's touchdown response. They do not claim
that the additional containment guard is recovered retail behavior.

## Verification

- 288 authored cases cover flat ground and banks at 20, 45, 65, 70 and 75 degrees;
  three world headings; across-bank/downhill travel; upright/75-degree-rolled
  decks; and four surfaces. Incoming riders must land within 30 ticks, retain
  ground controls for at least 29 of the final 30 ticks, stay finite and never
  reset. The prior runtime fails the new regression.
- The shared player-safety suite passes 27,473 checks, including the existing
  departing-wall, jump, landing, walking and boost checks. All 57 Native suites
  pass. The unchanged 1,536-case corner matrix retains 184,320 contained ticks
  and 48 near-vertical support trials.
- The final paired Snowdream diagnostic tests the same 24 placements against
  the complete scene. The retained stuck placement changes from 85/90 near-air
  ticks with no landing to 15/90 with a landing; none of the 24 final placements
  meets the diagnostic's persistent-air-lock condition. These are targeted
  placements, not a claim of complete human trajectory equivalence.
- Four production-player replays render 480 Vulkan frames on authored flat,
  downhill and steep-bank courses. An original generated tone exists only in
  the carve slot: no glide, wind or music can satisfy the audio check. Each
  case must finish grounded with one touchdown, no wipeout and audible carve
  PCM in the last half-second. The 0.72 executable fails this regression.

Windows and Quest debug/test APK builds and Android lint pass. Versioned frozen
artifacts preserve the preceding 0.72 builds. This milestone does not claim a
new headset installation or worn Quest validation. The requested playtest is
desktop Snowdream, including tilted jump landings, long downhill sections and
the large banked curves. Existing maps need no re-import; opponents remain off
by default.

Full repository verification passed (572.8 s), including all 57 Native suites,
1,002 synthetic .NET checks and 232 covered web test files. Final production
bank, prop, recovery and corner replay checks passed. The user reports an
improvement but still encountered some ground-skimming air states in 0.73.
The follow-up in [0.74](playtest-contact-0.74.md) adds incoming contacts with
upward world velocity; the 0.73 frozen executable remains available for comparison.
The broader feature-parity goal remains paused.
