# Interaction restoration

Build 0.53 adds the application-level thirty-second restoration used for ordinary
breakables and movable props. This is separate from an authored node's own
duration, debounce, effect-end latch or region-exit latch.

The source is clean Trailmap world-interaction/node semantics, public Slopesmith
documentation/tests/API observations with synthetic fixtures, and independently
inspected owned map data. No other runtime or separately licensed decoder
implementation was read or reused. The public effect tests specify thirty
seconds for breakables and movable props; this is an application policy, not an
additional field invented in Effects.json.

## Behavior

An eligible collision or fragile-trigger chain starts one gameplay-time deadline.
Reachable function/instance calls identify the source, related models and rail
switches, including delayed calls. Restoration returns authored draw/collision
flags, removes live bodies, piece transforms, material overrides, emitters and
routes, clears old delayed interaction work, and reinstalls nearby persistent
effects. Intact and hidden-debris models return together; the source can break
again. Related rails return to their authored/mode-specific eligibility.

A later interaction updates the deadline of a shared target, so an earlier
source can restore while that shared target still belongs to the newer chain.
Mode setup never starts a timer. Mode-hidden instances, collected rewards and
the clean permanent-kill recipe's region-exit latch remain protected. A new run
clears all interaction deadlines before applying the selected mode again.
Focus or game pause consumes no timer time. Per-run hit-gated ambient arming and
music selection are not reset by an individual prop restoration.

The public API probes confirm ordinary tombstones, delayed/grouped work,
latest-interaction ownership, rail restoration and cancellation of calls beyond
the reset deadline. The current public Play probe also resets a latched permanent
kill; Native retains the clean specification's permanence rather than introducing
that discrepancy into its existing latch behavior. This distinction remains
explicit rather than being claimed as complete behavioral equivalence.

## Verification

The current desktop build passes all 48 Native suites. Focused runs pass 98
world-logic checks across the eleven owned courses and 22 piece/shatter checks.
These cover the boundary before/at thirty seconds, a zero-duration tick, delayed
work, second breaks, overlapping interactions, mode hides and rails, permanent
region exit/reentry, movable props, ordinary pause commands and run restart.
Existing collected-reward checks still keep pickups absent beyond sixty seconds.

Owned-course checks establish:

- GARI's intact screen and trigger return while all 23 fragments plus their root
  return to their hidden state; it can shatter again.
- MERQUER's hydrant and trash-can chains return original flags and retire their
  moving bodies; the unhit neighboring hydrant remains unchanged.
- MESA's falling trees change pose and enable rails 87/88 after the authored wait.
  The trigger, tree poses and both rail states restore at thirty seconds. The
  Native import identifies this trigger by name rather than assuming that a
  different export's numeric instance order is the same.

The production shatter replay passes 3,972 Vulkan/PCM frames. It checks both
walking and riding impacts, crack/scanline composition, fragment rendering and
retirement, then waits out the reset and checks the intact pixels, a second
visible smash and a second mapped cue in captured stereo PCM.

Both Quest APKs build at 0.53.0/code 55. Full repository verification and Android
lint pass. USB disconnected before deployment,
so installation, ARM64 test execution and worn Quest behavior are not established
for this build. The last verified headset installation is 0.52. Desktop testing
and APK readiness continue independently of that connection.

```powershell
./temp/native/Release/openslope_world_logic_tests.exe temp/native-board-audio-owned/Maps
./temp/native/Release/openslope_mesh_throw_tests.exe temp/native-board-audio-owned/Maps
python Native/tests/shatter_replay_test.py temp/native/Release/openslope_player.exe
```

Saved builds use `temp/native/desktop-quest-playtest-0.53.0` and
`temp/native/OpenSlopeNative-quest-0.53.0-playtest-debug.apk`. Local API
observations and owned-map probes remain ignored under `temp/`; no map media is
packaged or committed. Ambient voice selection, fence flex and screen video are
still open in the effects coverage audit, alongside wider gameplay parity.
