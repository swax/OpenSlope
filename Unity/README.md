# Unity

**Turn an OpenSlope map into a rideable Unity scene.** This component imports terrain, props,
lighting, audio and effects from Snowknife bundles, then adds a ride runtime for VRChat or
[Basis](Basis/README.md). Authored and locally imported courses use the same map format.

This folder contains source to copy into a Unity project. The primary target is Unity
**2022.3.22f1**, the built-in render pipeline, the VRChat SDK and UdonSharp. The experimental
Basis port uses Unity 6 and URP; follow its [setup guide](docs/basis/061-overview.md) separately.

## Set up a VRChat world

1. Create or open a Unity **2022.3.22f1** project using the built-in render pipeline.
2. Install the VRChat SDK, UdonSharp and `com.unity.nuget.newtonsoft-json`.
3. Copy this component's `Importer/` and `VRC/` folders into the project's `Assets/` folder.
4. With [Snowknife](../Snowknife/README.md) on `PATH`, build and stage a portable map.
   Run from the OpenSlope repository root, replacing the map and project paths:

   ```powershell
   snowknife gltf Maps/MYMAP MYMAP
   snowknife unity Maps/MYMAP C:/MyWorld/Assets/OpenSlope/Maps/MYMAP
   ```

5. In Unity, choose **OpenSlope → Load → Map…** and select the staged `Assets/OpenSlope/Maps/MYMAP` folder.
6. Run **OpenSlope → Setup All**, keeping Unity focused for the final probe bake.
7. Enter Play mode with ClientSim to test the scene.

On a fresh project, Load or Setup All may pause after creating UdonSharp assets. Let Unity compile,
then run that command again. Re-run Setup All after each full map import. For optional surface
footsteps, menu commands and Shared-pack handling, see the [complete setup guide](docs/authoring/01-project-setup.md).

## Documentation

| Task | Guide |
|---|---|
| Take an authored map through the full pipeline | [Authoring and import](docs/authoring/README.md) |
| Find importer and runtime details | [Documentation index](docs/README.md) |
| Use the experimental Basis port | [Basis introduction](Basis/README.md) and [port status](docs/basis/061-overview.md) |
| Edit, format or sync project copies | [Development guide](docs/development.md) |
| Automate a ClientSim check | [VRChat autotest](docs/vrchat/055-clientsim-autotest.md) |

## Content and license

Disc-derived projects are local/private and must not be uploaded or redistributed; see
[LEGAL.md](../LEGAL.md). For a distributable world, stage an authored map into a fresh destination
with `snowknife unity --public`. It rejects retail-derived or unknown content, omits the retail
Shared pack and requires rights confirmation for user-supplied assets.

OpenSlope is independent and unofficial. This component is licensed under
[Apache-2.0](LICENSE); see [NOTICE](NOTICE).
