# Snowknife

**Import, convert and repack OpenSlope courses from the command line.** Snowknife brings
*SSX Tricky* courses into portable map folders, converts maps to glTF for Blender and Unity,
and builds custom PS2 discs or SSX Mod Manager packages from authored courses.
[Slopesmith](../Slopesmith/README.md) creates the same map format directly.

## Download and run

Download a package from the [Snowknife releases](https://github.com/swax/OpenSlope/releases?q=snowknife-v)
for Windows x64, Linux x64, macOS Intel (`osx-x64`) or Apple Silicon (`osx-arm64`).
Extract the **entire archive**, then open a terminal in that folder:

```powershell
.\snowknife.exe --help
```

On Linux or macOS:

```sh
./snowknife --help
```

The .NET runtime is included. Keep `Patches/`, `licenses/` and the accompanying files beside
the executable. macOS packages are not notarized. To build from source instead, see
[development setup](docs/development.md).

## Use a course

Choose the workflow you need:

| Task | Start here |
|---|---|
| Build a Slopesmith `.snowknife.zip` into a custom ISO or mod ZIP | [Repack guide](REPACK.md) — accepts the download directly |
| Import a disc course for Slopesmith | [Browser-play guide](docs/browser-play.md) — no glTF conversion needed |
| Import the SSX 3 mountain | [SSX 3 guide](docs/ssx3-import.md) |
| Bring a portable map into Blender or Unity | Convert it with `gltf`, as shown below |

With Snowknife on `PATH`, run this from the OpenSlope repository root for an existing
`Maps/MYMAP/` folder:

```powershell
snowknife gltf Maps/MYMAP MYMAP
```

This writes `Maps/MYMAP/gltf/`. Open it with the [Blender tools](../Blender/README.md), or
follow the [Unity setup](../Unity/README.md) to stage and import it. Each conversion stage can
be rerun independently; the [bundle pipeline](docs/034-bundle-pipeline.md) describes its inputs and outputs.

For command-specific arguments and examples:

```text
snowknife
snowknife help repack
snowknife help import
```

The CLI's grouped index and help pages are the command reference.

## Documentation

- [Documentation index](docs/README.md) — import, audio, effects and conversion guides.
- [Portable map schemas](Snowknife/schemas/README.md) — contracts shared with other tools.
- [Development](docs/development.md), [testing](docs/testing.md) and [releases](docs/releases.md) — contributor instructions.

## Content and license

No game content is included. Disc operations use your own image and keep derived content
local/private; see [LEGAL.md](../LEGAL.md). Distributable Unity projects must use authored
or rights-cleared content and `snowknife unity --public`, which rejects retail-derived or
unknown content and requires rights confirmation for user-supplied files.

Snowknife is independent and unofficial. It is licensed under [GPL-3.0-only](LICENSE.txt) and
builds on the [SSX-Library fork](https://github.com/swax/SSX-Library). Portable schemas are
separately licensed under Apache-2.0. See [NOTICE](NOTICE) for scope and attribution.
