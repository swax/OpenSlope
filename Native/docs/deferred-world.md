# Deferred counters and fragile glass

Build 0.27 adds installed counters and crack handlers to the shared desktop/VR
world runner. Reaching a condition dispatches the trigger column on that same
instance. Existing native imports can recover their material frame lists from
saved sidecars without re-importing the ISO or rewriting Maps. New imports
write those lists explicitly.

## Counters

Clean Trailmap 150/230 and first-party public checklist tests define property
subtype 6. It installs the authored count before any input can affect it. Main
3/9 command 1 marks a numbered input once; command 2 requires the preceding
input to be marked; command 3 decrements without consuming an input number.
Repeated marks do not spend another count, and a missing, zero-count or already
spent counter cannot fire accidentally. The second constructor word is retained
as data; no timer behavior is inferred from it.

A positive count reaching zero requests its own slot's trigger on the next
update. The native scheduler drains that continuation after property iteration,
so replacing/removing the counter inside its own trigger is safe. The deferred
thread has world-node ownership rather than inheriting the most recent input's
rider. Run restart restores the initial mode and fresh counters. Ordinary
region teardown and populated latches retain their existing authority.

The real MERQUER ten-can inputs now reach the strike-sign continuation after all
ten distinct marks. The sign's UV-scroll receiver and the cans' knock-off bodies
remain separate consumers; this is a counter/dispatch result, not full mission
presentation or rigid-body completion.

## Cracking, support and shatter

Property subtype 14 installs lifetime/strength from clean 230/370. Contact
installs it once and paints the cracked state. Later contacts spend the same
pool behind an exact 0.5-second gate; they do not reinstall the node or replay
the initial crack sound. Spent strength fires the pane's own trigger once.
Authored graphs then play sound, hide/disarm the source and associated floor,
and reveal other instances. Expiring a positive lifetime retires the handler and
restores its private appearance; non-positive lifetimes never expire. Continued
contact can install a fresh crack after healing. No automatic 30-second respawn
profile is added.

The first-party play profile supplies the contact prices: carried contact costs
1, a representative hard hit costs 87, and normal speed 8 m/s separates a hard
floor impact from gentle settling. Crossing a standing pane also uses the impact
price. Projection uses contact/support normal and relative surface velocity,
so fast downhill travel along a tilted pane does not become a hard impact.
The original contact-vector reduction is not fully recovered; these prices and
classification are application behavior, not exact original force equivalence.

Native contact flags identify prospective crack receivers from their actual
collision graphs (including function calls). An authored mass-zero crack proxy
can supply a custom-map floor until disarmed; other pass-through objects keep
their existing behavior. An explicit surface type is retained; an unspecified
crack-floor surface uses ordinary surface 1 as an application fallback.

Real MEGAPLE uses a solid GLASS surface above a separate crack receiver. A bounded
0.3 m reach around actual ground contact tests the native collision proxy, not
render meshes or broadphase boxes alone. It hands the supported contact to the
nearby receiver using the real support normal. This joins the two authored
actors without a per-course special case. The pane's trigger graph identifies
material-matched kill targets; those surfaces share its private cracked frame,
while unrelated placements using the same model/material stay unchanged.
Multiple active owners retain their shared visual targets until all relevant
owners are removed.

Mounted and on-foot players share that pool. Mounting preserves damage; hard
falls can remove the floor before seating; carried riders keep support until
shatter. Walking event casts now cover lower-body, torso and head regions
with three sphere sweeps, so raised standing glass can react even when feet
and low torso pass beneath it. Per-instance deduplication prevents the three
casts from charging or marking one receiver multiple times in a tick.

## Material data and rendering

Clean 170/220 supplies the material flipbook reference and concatenated lists of
texture indices. The independent importer writes `TextureFlipbook` in material
order, including empty lists, and rejects invalid joins before publication.
Frame filenames are portable PNG references; bare frame names also accept the
usual `.png` suffix normalization.

Per-instance frame selection stays separate from immutable geometry, materials
and shared-model siblings. All referenced frames participate in asset discovery
and upload. Draw grouping includes the selected frame; that frame's actual
alpha chooses cutout/blend behavior independently. Eye-local poses and immutable
image descriptors preserve queued stereo ownership. Frame bindings are checked
before renderer fence reset. Generic free-running texture-flip and UV-scroll
clocks still need their consumers.

If an older Materials.json omits frame metadata, one bounded matching main
`Source/*.PBD` / `*.SSH` pair supplies only the material table, flipbook indices
and texture-directory names. Each sidecar is limited to 64 MiB and must resolve
within the map. Matching source texture names prevents overwriting an edited
material's meaning. Explicit frame lists, including empty ones, are authoritative.
Without those lists or the saved pair, unavailable frames remain static.

Quest SAF preparation copies that pair only when material metadata needs it,
alongside the existing optional behavior sidecar. It then copies the referenced
frame PNGs. Native assets and user Maps are not rewritten. The new JNI/SAF cases
compile; device execution of those new cases is still outstanding.

## Evidence and limits

All 26 portable suites pass. The property suite passes 70 checks with the local
Maps/reference comparison: gated damage, ordered/deduplicated counters, own-slot
continuations, healing, sloped support, hard drops, mounted/on-foot handoff,
raised walking contact, split solid/crack actors (graph and direct hide) and private material ownership.
All 93 flipbook materials across eleven native imports match the independent
existing exported frame lists exactly. All twenty MEGAPLE crack receivers are
identified. A real imported pane test paints both actors, runs the authored
shatter graph, disarms both native proxies and drops the player below the former
floor. The ten actual MERQUER can inputs also reach their continuation.

Seven production Vulkan replays render 371 frames and assert private crack/heal
pixels, the revealed twin, counter completion/deduplication, and separate crack,
shatter/counter sounds in captured PCM. The GPU suite passes 1,346
appearance/material checks, including frame-dependent alpha on UNORM/sRGB,
shared-model isolation, queued stereo and invalid-input recovery. Existing
avatar/HUD checks pass 84 assertions. The binary import oracle covers frame
ordering, empty lists and invalid-reference cleanup. Eleven old-import courses upload their frame
art and render successfully. Three actual pane captures render 158 frames in
intact, cracked and opened states; the opened case loses support at the same
position as the CPU test. Existing world/model/route/boarding/score/recovery
replays pass, including all 66 imported recovery placements.

The 0.27 ARM64 app and instrumentation APKs build and pass signature checks;
version code is 28. Android lint reports zero errors and four existing warnings.
All 15 packaged notice/license assets match their sources exactly; no course,
disc or retail audio/mesh data is bundled. The native source audit checks 206
files. Immutable desktop/APK artifacts and hashes are saved in the ignored build
tree; the build manifest pins the milestone commit.

```powershell
./temp/native/Release/openslope_fragile_tests.exe temp/native-rails-0.17.0/Maps Maps
python Native/tests/fragile_replay_test.py temp/native/Release/openslope_player.exe
```

Mesh throws/debris, knock-off rigid bodies, complete breakable rearm/respawn,
UV/texture animation clocks and other world effects remain parity work.
Original LTG activation, exact skeletal/force/trajectory equivalence and the
previously recorded fast-rotation/rising-floor/repeated-impact limits also remain.
This milestone does not establish every full-course interaction or headset
comfort. The Quest stays on 0.22 for the user's steering test; no new worn-headset
or device FPS claim is made.
