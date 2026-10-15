# World effects coverage audit

Audited on 2026-10-15 against Native runtime commit `7412ae6` (build 0.51).
The named interaction families are implemented, but complete effects parity is
not established. This audit changes documentation only.

Follow-up: build 0.53 implements the ordinary breakable/movable restoration gap,
including related tree rails, while preserving mode hides, collected rewards and
the clean permanent latch recipe. See `interaction-resets.md` for current evidence
and the explicit public-Play permanence discrepancy. The table below records the
original audit; ambient voice selection, fence flex and video remain open.

Authority: clean Trailmap 180, 230, 370 and 420; shared contracts; Slopesmith
public documentation and tests; independently inspected local map exports.
No other runtime or separately licensed decoder implementation was used.

## Coverage

| Family | Current behavior and evidence | Remaining work |
| --- | --- | --- |
| Breakables and glass | Collision chains hide intact models, reveal broken twins, throw individual pieces, advance private crack frames and play mapped impact cues. Existing CPU and production replay tests cover walking and riding. Actual GARI screen instance 324 hides its intact/trigger instances and activates a 24-object broken model. | Ordinary breakable respawn does not match the public Slopesmith lifecycle tests. With an observer held nearby, the GARI screen remains absent after 32 seconds and returns only on run restart. A roughly 30-second interaction reset must preserve mode-entry hides and permanent recipe/pickup retirement. Fragile-property expiry already exists and is a separate mechanism. |
| Fire hydrants | Actual MERQUER base 473 activates one water emitter and the matching lid body 472, without activating nearby pair 536/535. The probe reaches 434 visible particle sprites; the lid moves and restart restores it. The map contains 25 base/lid pairs; 22 bases carry event-28 spray ambience with a 32 m radius. | Shared rigid-body simulation uses application tuning; exact trajectories and worn-device sound/appearance are not established here. |
| Trash cans | Actual MERQUER can 796 and lid 795 both become moving bodies, while debris instance 797 reveals a 21-object throw model. The chain adds no unsupported operations; restart restores the initial state. There are 88 can/lid pairs in the imported map. | Wider trajectories and all placements have not been individually played through. Ordinary interaction reset needs the lifecycle work described above. |
| Ambient sound emitters | Native reads point, oriented ellipsoid and directional regions, six radial curves, optional one-entry voices, extracted/shared/custom WAV routes and loop regions. Events 16/28/57 arm on contact with their owning instance, including a silent impact row. Production PCM tests confirm silence before contact and audible ambience afterward. | The scene iterates emitters in document order; mixer voice eviction does not implement the public field's loudest-first selection and stable ties under a constrained voice budget. Dense-emitter selection needs alignment. |
| Fireworks and other particles | Timer and collision emitters, layered bursts, streams, contact position/normal, sprite registration, alpha/additive/darkening blends and run/region cleanup are implemented. Current production replays verify visible particles and timed sound while walking and riding. | This audit does not establish every emitter's visual match or weather/snow presentation. |
| Other graph-driven world effects | Handlers exist for material scrolling/flipbooks, flags, crowd cells, model animation, spline movers, counters, gates/waits/calls, pickups, boosts, resets, teleports and rail switches. Current graph suites load all eleven imported courses. | Having a handler does not establish complete behavior or visual parity for every authored recipe. |
| Fence flex | Imported effect node `0/12` exists in GARI, MEGAPLE, MERQUER and SNOW (four graph/function nodes total). | No runtime handler: collision-triggered damped fence flex is missing. |
| In-world video screens | Effect node `0/23` occurs fourteen times across seven imported courses. | No runtime playback handler: these screen surfaces do not play their course video. Ordinary flipbooks and breaking a screen are separate supported paths. |

## Current verification

Focused checks rerun with the existing build:

- 18 mesh-throw checks, including the actual GARI break chain.
- 59 fragile/counter checks, including actual panes, MERQUER continuation and
  93 material flipbooks across eleven courses.
- 42 rigid-prop checks, including actual walking/riding impacts on GARI's bag.
- 70 world-graph checks and 77 particle checks, loading all eleven courses.
- 52 audio codec/mixer/loop/spatial/program/music checks.
- 918 production Vulkan/PCM particle replay frames and 170 audio replay frames.
- Three additional direct Native runtime probes against owned MERQUER/GARI
  data, held near each target for 32 simulated seconds, followed by run restart.

The direct probes invoke the real graph/particle/body APIs and inspect their
outputs. They do not replace collision-entry/render/audio integration tests or
a worn Quest play test. Water spray and debris counts describe runtime output,
not a claim of perceived image quality or heard audio on a headset.

Local evidence is retained under ignored `temp/effects-audit-*`, including
`effects-audit-runtime.json` and `effects-audit-node-types.json`. No map data or
media is added to the repository. Existing focused checks can be rerun with:

```powershell
./temp/native/Release/openslope_mesh_throw_tests.exe temp/native-board-audio-owned/Maps
./temp/native/Release/openslope_fragile_tests.exe temp/native-board-audio-owned/Maps
python Native/tests/rigid_prop_test.py temp/native/Release/openslope_rigid_prop_tests.exe temp/native-board-audio-owned/Maps
./temp/native/Release/openslope_world_logic_tests.exe temp/native-board-audio-owned/Maps
./temp/native/Release/openslope_particles_tests.exe temp/native-board-audio-owned/Maps
./temp/native/Release/openslope_audio_tests.exe
python Native/tests/particles_replay_test.py temp/native/Release/openslope_player.exe
python Native/tests/audio_scene_test.py temp/native/Release/openslope_player.exe
```

Build 0.53 completes the ordinary interaction restoration described above; see
`interaction-resets.md` for current evidence. Subsequent effects work includes
Tokyo Megaplex vent/contact integration and pressure-button cues, point-light
glints/halos, ambient voice selection and fence flex. Screen video remains open.
