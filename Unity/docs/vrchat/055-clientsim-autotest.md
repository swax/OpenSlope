# 055 — VRChat ClientSim autotest

The VRChat path can import a Slopesmith autotest fixture, run the ordinary post-import setup, enter Play Mode through
ClientSim, mount a pooled board, and drop it through each planned mechanism. The run writes a machine-readable JSON
report using the same `autotest-plan.json` that drives the PCSX and Slopesmith validation paths.

## Safety boundary

The runner starts only in either of these scene states:

1. there is no `OpenSlope_Map`; or
2. `OpenSlope_Map` has an importer-written `MapIdentity` whose schema is current and whose `AutoTestPlan` flag is true.

An ordinary map, a legacy untagged map, or a hand-created object named `OpenSlope_Map` causes a hard refusal before the
importer deletes or replaces anything. The flag comes from successfully parsing `<level>/autotest-plan.json` during
import; the runner does not trust `EditorPrefs`, the folder name, or the selected fixture name. After import it also
requires the loaded identity's source folder to exactly match the requested folder.

The editor automation does not save the scene. Its setup pass intentionally skips only Bake & Apply Probes, because
that step calls `SaveOpenScenes`; probe lighting is not part of these collision/effect assertions. The command-line
harness therefore changes the open editor session, but it does not write those map/setup changes back to the project's
scene asset.

## Run it

In an already-open VRChat project, sync the library and choose:

`OpenSlope → Dev → Run VRChat ClientSim Map...`

Pick a staged `Assets/OpenSlope/Maps/...` folder containing both `autotest-plan.json` and `gltf/manifest.json`. The runner handles
the Udon program-asset compile/reload passes, `OpenSlope/Load`, the runtime portions of `OpenSlope/Setup All`, Play Mode, and the
ClientSim run. It skips the probe bake/save as described above.

For a repeatable repository-side run, close the target Unity project and use:

```powershell
pwsh Unity/tools/test-vrc.ps1 -Target C:\path\to\YourVrchatProject -Fixture GOLD
```

`-Target` may also be a short project name when `OPENSLOPE_UNITY_PROJECTS` points at its parent. `GOLD` is the default
regression fixture. `-SkipExport` reuses the baked fixture under `temp/vrc-autotest/source`; `-SkipSync` leaves the
target project's library copy alone. The harness launches a visible editor because ClientSim is a Play Mode/runtime
test; it intentionally does not use `-batchmode` or `-nographics`.

Results and the Unity log are written under `temp/vrc-autotest/results/`.

## What is validated

The board control seam is dormant in normal play. During the guarded run it drives the compiled Udon behaviour via
public program variables and custom events. Mounting still goes through the real ownership/VRCStation path; each drop
then uses the real fixed-tick board physics, RiderProbe, colliders, and trigger behaviours.

Supported observations currently include:

- dispatch/no-dispatch counts on ambient emitters, animated-prop triggers, buttons, boost pads, and fireworks;
- button paint/frame pulses;
- rider rise/jump, speed, and speed-pad boost-window requests; and
- proximity to the imported target, approach speed, and the Udon behaviour that supplied the observation.

Each plan row is reported as `pass`, `fail`, `unsupported`, or `open`. Unsupported rows do not silently become passes.
PCSX live-node memory watches, effect-slot memory, and late watches are preserved as limitations in the row notes;
Unity has no equivalent memory table. ClientSim also supplies one real local player, so this harness does not claim to
validate remote clients, ownership races, serialization timing, or late joiners. Those remain VRChat multi-client
checks.
