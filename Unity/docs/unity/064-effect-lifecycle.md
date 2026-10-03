# Effect lifecycle and timed rail commands

The shared bundle preserves collision-chain DeadNode commands for both Unity runtimes.
Modes 0/1 stop the installed model/material/contact-emitter receiver without hiding the prop.
Modes 2/4 also hide its static renderers and disable its collision. Mode 3 additionally stops
detached particle emission and removes every copy of a spline mover. Existing particles finish
their lifetime. [Trailmap: 230-level-ssf]

`EffectLifecycle.Targets` identifies the independently controlled instances. Static targets leave
the merged props mesh, and their collision proxies leave shared collision buckets. Import-time
identity markers join their renderers, colliders, animations, private material clocks, and detached
effects. VRChat and Basis realize the same neutral target/trigger markers. Distance culling uses
`Renderer.forceRenderingOff`, preserving the effect's `Renderer.enabled` state.

`RailGates` carries parallel `Rails`, `Delays`, and `Enabled` arrays. Older bundles without the new
arrays retain immediate enable behavior. Waits and function/instance calls preserve child-chain
timing; a child's wait does not stall its caller. Animated-prop trigger boxes also carry `Delay`.
This keeps a falling tree's animation and its later grindable rail in sequence. `SourceIndex` joins the
matching animation triggers to the rail gate, which owns their common reset; re-crossings cannot
extend just one half of the sequence.

These commands use the existing transient multiplayer-event model. Current clients replay the
sequence locally; late joiners do not receive an earlier crossing. The default scene reset is
30 seconds after the sequence finishes, restoring captured render/collision/rail state and
restarting killed detached effects. Set the trigger's `respawnDelay` to zero for a permanent sequence.
An older trigger's reset cannot overwrite a more recent command on the same target.

The bundle compiler handles unconditional collision chains. It stops at conditional gates rather
than exporting their tails as guaranteed actions, and guards recursive calls. This is not a full
Unity SSF interpreter: counter/deferred continuations and receiver installation/replacement remain
outside this lifecycle hand-off. The existing specialized break, pickup, boost, and cracked-glass
paths retain ownership of their normal hide/reveal sequences.

## Local regression routes

Rebuild the bundle with `snowknife gltf Maps/<MAP> <MAP>`, stage it into the Unity project with
`snowknife unity`, sync the updated `Importer` plus `VRC` or `Basis` source, then load the map again.
An already imported scene does not acquire new trigger data from a source-code sync alone.

| Map | Find in Slopesmith / source instance | Check in Unity |
| --- | --- | --- |
| ELYSIUM | `Mdl_HalfPipeThing_GlassAwhole_5013` (3112), broken twin `Mdl_HalfPipeThing_GlassA_5013` (3116) | First contact retains the pane's bounce. After 0.05 s it hides and its collider disables; the next pass goes through. After respawn it is solid again. Leave/re-enter culling range while broken: it stays hidden. |
| ALOHA | `Mdl_Trigger_topDissapear_1000` (1258); fire pots 814 and 918 | Cross the start-area disappearance trigger. The targeted scenery disappears and stops colliding. Both fire pots stop emitting; existing flames fade. On reset the props, collision and continuous emission return. |
| MESA | `Mdl_Trigger_Fireworks_5001` (2171); falling trunks 2241/2242 | Cross the trigger. The trees start falling after 1 s; rails 88/87 become grindable after 3.56 s, then reset with the sequence. |
| MERQUER | `Mdl_Subway_Train_1000` (344) | The subway follows its spline in Basis as well as VRChat. |

Synthetic tests cover both rail directions, nested calls/waits, the five lifecycle modes, recursion,
conditional tails, and the glass delay. `OpenSlope.VrcPlugin.EffectRuntimeSmokeTest.Run` is a Unity
batch entry point that compiles the real Udon programs and checks hide/pause/flagged emission,
restore, culling, delayed rail on/off, and neutral-to-platform target binding.
