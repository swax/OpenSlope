# Set up and import a VRChat world

Use this guide for the complete Unity 2022.3 setup and menu reference.
The separate [Basis port](../basis/061-overview.md) uses Unity 6 and URP.

## Setup

1. Create or open a built-in-render-pipeline project in Unity **2022.3.22f1**.
2. Add `com.unity.nuget.newtonsoft-json`.
3. Install the VRChat SDK and UdonSharp.
4. Copy `Importer/` and `VRC/` into the project's `Assets/` folder.
5. With [Snowknife](../../../Snowknife/README.md) on `PATH`, build and stage a map from the
   OpenSlope repository root:

   ```powershell
   snowknife gltf  Maps\MYMAP MYMAP
   snowknife unity Maps\MYMAP C:\MyWorld\Assets\OpenSlope\Maps\MYMAP
   ```

   Retail-derived projects may also need `snowknife shared <iso> Maps\Shared`; ordinary `unity`
   staging copies that Shared sibling automatically. Public projects must instead follow the
   [public path](../../README.md#content-and-license).

## Import and test

In Unity:

1. Run **OpenSlope → Load → Map…** and select `Assets/OpenSlope/Maps/<MAP>`.
2. Run **OpenSlope → Setup All**. Keep Unity focused while its final probe bake runs.
3. Optionally run **OpenSlope → Setup → Surface Audio** for on-foot material footsteps; this is intentionally
   not part of Setup All.
4. Enter Play mode with ClientSim or build the world.

On a fresh project, Load and Setup All may each stop after creating UdonSharp program assets. Let Unity
compile, then run that command once more. Re-run Setup All after every full map import because the import
replaces the `OpenSlope_Map` root and its post-import runtime objects.

Setup All handles the normal VRChat scene pass: static chunking, teleports, locomotion, music, player
flight, board dispensers, race audio, video/score/info boards, leaderboard and finish line, HUD,
performance and tuning controls, optional map snowfall, and avatar-light probes. Individual commands
remain available for focused iteration.

| Menu | Use |
|---|---|
| **Load** | Import a complete staged map |
| **Setup All** | Run the standard post-import VRChat setup and probe bake |
| **Setup** | Run one post-import system, listed in the order Setup All runs them; includes opt-in Surface Audio |
| **Refresh** | Rebuild one imported subsystem without a full import |
| **Optimize** | Re-run scene optimization such as static chunking and draw-call batching |
| **Tools** | Scene and asset utilities, analyzers, and debug windows |
| **Dev** | Importer development: partial gltf bundle loads and the ClientSim autotest |

The ClientSim automation contract and runner are documented in
[VRChat autotest](../vrchat/055-clientsim-autotest.md).
Glass, disappearing props, fire pots, movers, and timed rail checks are listed in
[Effect lifecycle](../unity/064-effect-lifecycle.md), including the local maps and source instance names.
