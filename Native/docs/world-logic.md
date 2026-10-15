# Authored world graph runtime

Build 0.24 connects real shape contacts to the course's authored effect slots.
Both desktop and OpenXR use the shared player, graph runner, collision flags and
draw flags. A reset volume calls the same 0.8-second course recovery as the reset
button, with no manual energy penalty. Unlike the application-only automatic
fallback policy, an authored reset node also works in Freeride. Finished runs,
pending recovery and no-reset windows still refuse it.

Showoff gems apply the strongest collected x2/x3/x5 tier, play MAIN sound slot
116/117/118 for the local human and install their authored tombstone. The draw
and player-collision bits clear together, so the gem cannot collect again. A
placement preserves the tombstone; a full run restart restores the initial mode
state. An unscored hop preserves the multiplier for the next actual banked trick;
crash/reset still cancels it. The desktop readout and right-controller panel show
the held tier. Collection during touchdown affects the trick banked that frame.

Clean Trailmap 150/230/390 governs slots, counted chains, function ownership,
wait/gate/debounce behavior, reset, multiplier, mode functions and tombstones.
Main type 8 uses its direct course-bank slot. Named mode functions execute on
setup and can hide instances or toggle authored rail candidacy. The Showoff
layer uses explicit `LTGState == 2` when provided and the first-party `Gem_`
model-family fallback for older files, covering pickups and their rail supports.
The multiplier handler has a separate Showoff gate; its human pickup chime is
outside that gate. The authored visible flag and immutable geometry are retained.

The implemented graph operations are:

- Main 4 waits in seconds; main 5 kills the remaining chain on a failed speed,
  probability, human-owner or no-installed-node gate. Speed ceilings use raw
  centimetres/second; floors use km/h, as specified.
- Main 7 resolves stable instance/graph references and runs the target graph.
  Portable direct hide/show state leaves are also accepted.
- Main 21 calls a function on a new thread with inherited rider ownership;
  main 26 detaches the rider. The caller continues. The first matching named
  function wins. Repeated IDs, unresolved references and cycles do not become
  unbounded recursion.
- Property sub 2 debounces contact. Positive time requests node-end; zero holds
  until ordinary region teardown, and negative time holds until level teardown.
- Properties 256/257/258 play model-object clips in real time, on a granted
  budget or as a triggered combo. Main 3/9 dispatch implemented controls to the
  installed player; property sub 5 destroys/restores, pauses or tombstones.
  Persistent activation and populated region/end latches now retain ownership.
  See [prop animations](prop-animations.md) for exact scope and motion limits.
- Main 2/sub 1 draws detached spline-path copies and optional cable lines.
  Base controls 7/8 and dead-node mode 3 can kill that drawing node; ordinary
  tombstones retain it. See [spline movers](spline-movers.md) for ownership,
  route activation, explicit re-arm and host-collision separation.
- Property 6 handles numbered/ordered marks and tally decrements; property 14
  holds gated crack strength and lifetime. They dispatch their own trigger slot.
  Cracked material state, paired native support and private frame rendering are
  connected; see [deferred world interactions](deferred-world.md).
- Main 13/14 reset or collect, main 8 plays course audio, and main 25 changes
  rail candidacy. Warping preserves those runtime rail toggles; restart restores
  initial candidacy and re-applies the mode graph.

Contact dispatch follows travel order before touchdown or solid response. A
trigger which disarms a wall can remove that wall from the remaining sweep.
Per-instance waiting threads re-arm on completion rather than on contact exit;
there is no universal contact cooldown. Application limits bound work to 4,096
nodes per fixed tick, 1,024 threads and 32 nested graph/instance pairs. The random
stream is seeded for replay repeatability. These bounds and seed are application
choices, not recovered constants. Contacts before GO do not consume pickups.

## Files and compatibility

Fresh ISO imports independently write `Effects.json` using the public
`openslope-effects` v1 document vocabulary. Graphs, functions, slots, properties,
instance bindings and resources carry stable IDs; references resolve those IDs
in compact array order. `originalIndex` is provenance, never identity. Nodes
retain typed payload fields and exact source words, including unknown nodes.
Physics and collision geometry remain in their dedicated portable map files;
resource rows here describe their joins and pool metadata. This is a runtime
graph export, not a full byte-exact behavior-file editing/round-trip claim.

Existing exported `SSFLogic.json` is accepted as data. An older native import
without either JSON reads its one bounded saved `Source/*.SSF` in memory, without
rewriting the user's Maps folder or requiring the ISO again. Quest's SAF cache
copies `Effects.json`; for an older import it copies just that behavior sidecar,
excluding unrelated source assets. `openslope_import convert-effects <saved-ssf>
<Effects.json>` optionally materializes the graph into a new file and refuses
to overwrite an existing destination.

All graph decoding, dispatch, threading and runtime flag integration are
independently authored. Clean specification bodies and first-party public data
contracts/tests supply behavior; existing exported Maps supply comparison data.
No separately licensed decoder implementation is used.

## Validation and remaining scope

Portable tests cover stable identities with stale provenance indices, mode
presence, nested/detached calls, cycle/work limits, waits and debounce re-fire,
gates, tombstone persistence, actual body pickup/reset, same-frame bank ordering
and PCM output. Independent ISO fixtures check chain-relative tables, framing,
joins, unknown data and atomic failure. Production Vulkan replays cover visible
pickup pixels, disappearance, mode absence, chime PCM and reset under black.
GPU fixtures also verify runtime prop hiding for both display formats and sample
counts, and reject short flag arrays before resetting renderer fences.

All 22 portable suites pass, including 47 world-runtime checks and 62 scoring
checks. The five world-interaction replays render 772 frames with image and PCM
assertions. All eleven local course behavior tables load. The independent comparison tool
checks 8,774 typed node payloads, exact source words and slot/function joins
against existing exported data. These checks establish conversion and dispatch
interoperability, not every course interaction or full-world trajectory parity.
Device JNI/SAF checks for the new files are compiled; no new device execution or
worn-headset world-interaction test is claimed.

The public first-party Effects v1 validator accepts all eleven native exports.
Final GPU suites pass 1,190 appearance/visibility checks and 84 avatar/HUD
checks. ARM64 app/test APKs build and Android lint reports zero errors with four
existing warnings. Versioned 0.24 artifacts are saved in the ignored build tree;
the Quest remains on 0.22 for the user's steering test.

Build 0.25 adds persistent regions, model-animation ownership, installed-player
controls and region/node-end continuations. See prop-animations.md for evidence.
Build 0.27 connects counter/crack deferred triggers and material frame state;
see deferred-world.md for exact scope. Complete hide/rearm lifetimes, mesh-throw
and debris, particle effects, speed/trick/directional pads, teleport, remaining
score/time opcodes and rigid-body movers still need consumers. Detached spline
path drawing is now connected; see spline-movers.md. Collected
gems use clean 390's run-long tombstone; Slopesmith's application pickup grow-back
and breakable timers are a separate play-profile gap. Full LTG/world-grid import,
exact mode coverage, reset sound and wedge/death-plane triggers also remain.
