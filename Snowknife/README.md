# Snowknife (`snowknife`)

**OpenSlope's bidirectional conversion CLI.** Snowknife imports *SSX Tricky* course data into a
diagnosable map folder, builds an engine-neutral glTF bundle, stages Unity projects, and repacks
authored courses into playable PS2 ISOs.

Snowknife builds on a fork of GlitcherOG's [SSX-Library](https://github.com/swax/SSX-Library) for core
retail-format support, while owning the conversion pipeline, portable contracts, additional codecs and
formats, validation, glTF bundling, Unity staging, and authored-course repacking. The fork exists because
the pipeline depends on decoding fixes and additions that are not upstream: Tricky MAP, PBD and SSF
corrections, texture and palette handling, HUD-text SSF opcodes, variable-size external sounds, and
repack-time texture-slot reuse. It merges upstream periodically, and its README lists the changes.

## Build and test

Requires the .NET 10 SDK and the repository submodule:

```powershell
git submodule update --init
dotnet build Snowknife/Snowknife/Snowknife.csproj -c Debug
dotnet test Snowknife/Snowknife.Tests/Snowknife.Tests.csproj
```

The build leaves the CLI at `Snowknife/Snowknife/bin/Debug/net10.0/snowknife` (`snowknife.exe` on
Windows). Nothing installs it: add that directory to `PATH`, or invoke the executable by path. The
commands in this README and in [REPACK.md](REPACK.md) assume it is on `PATH`. Slopesmith finds the
same build through its sibling checkout, or through `SLOPESMITH_SNOWKNIFE_EXE` when it lives elsewhere.

The default test suite uses synthetic fixtures and needs no disc. From the repository root,
`npm run verify` runs the normal cross-project gate; `npm run verify:full` also enables tests that
use your local disc-derived fixtures. See [Testing Snowknife](docs/testing.md).

## Core workflow

A retail course follows three explicit stages:

```powershell
snowknife import     discs\ssx-tricky.iso <courseSlot> Maps\<LEVEL>
snowknife race-music discs\ssx-tricky.iso <courseSlot> Maps\<LEVEL>  # optional
snowknife gltf       Maps\<LEVEL> <LEVEL>
snowknife shared     discs\ssx-tricky.iso Maps\Shared      # once per project
snowknife unity      Maps\<LEVEL> C:\MyWorld\Assets\OpenSlope\Maps\<LEVEL>
```

| Stage | Output | Purpose |
|---|---|---|
| `import` | `Maps/<LEVEL>/` | Inspectable OBJ, PNG, WAV, and JSON intermediate |
| `gltf` | `Maps/<LEVEL>/gltf/` | Engine-neutral GLB files, lightmap atlas, and versioned manifest |
| `unity` | `<project>/Assets/OpenSlope/Maps/<LEVEL>/` | Only the files the Unity importer needs |

Slopesmith exports the same portable map contract directly, so authored courses begin at `gltf`.
To send an authored map back to PCSX2 or PS2 hardware, follow [REPACK.md](REPACK.md).

Snowknife leaves source map folders untouched when building or staging, so each stage can be rerun
independently. The [bundle pipeline](docs/034-bundle-pipeline.md) documents the data boundary and
coordinate conventions.

## Command help

```text
snowknife                    grouped command index
snowknife help <command>     arguments, flags, outputs, and examples
snowknife <command>          the same help page when required arguments are omitted
```

Command groups, as the CLI's own index lists them:

| Group | Commands |
|---|---|
| A course, end to end | `import`, `world`, `gltf`, `unity`, `shared` |
| Re-run one stage against an imported map | `props`, `billboards`, `overrides`, `skybox`, `lightmaps`, `particles`, `gltf-info` |
| Riders and boards | `rider`, `board`, `skis` |
| Audio | `intro-music`, `race-music`, `sfx`, `sound-index`, `board-sound-index`, `speech`, `bnk`, `bnk-rebuild`, `audio-file`, `music-inject`, `music-linearize`, `bank-verify` |
| Build a custom disc | `repack`, `repack-many`, `texture-plan`, `pbd-from-json`, `ltg-stats`, `ltg-find` |
| Optional local executable tools | `noclip`, `skycolor` |
| Effects and contracts | `effects-export`, `effects-import`, `effects-check`, `ssf-check`, `ssf-canary`, `ssf-install-iso`, `validate` |
| Containers and codecs | `iso-ls`, `iso-extract`, `iso-replace`, `big-ls`, `big-extract`, `big-create`, `refpack`, `ssh-extract`, `ssh-append`, `ssh-encode` |

The CLI-generated help is authoritative: command declarations, arguments, and their rendered usage
live together and are checked by tests.

## Architecture and contracts

Dependencies run downward from command composition into services and format primitives:

| Path | Owns |
|---|---|
| `Snowknife/Cli/` | Command table and help renderer |
| `Snowknife/Services/` | One entry-point service per command family |
| `Snowknife/Export/` | Retail ISO/level to the portable map intermediate |
| `Snowknife/Bundle/` | Engine-neutral glTF and manifest builders |
| `Snowknife/Repack/` | Authored map, texture, audio, and patch packing |
| `Snowknife/Formats/` | Container readers/writers and audio codecs not supplied by SSX-Library |
| `Snowknife/Engine/` | Native enums and interoperability mappings |
| `Snowknife/schemas/` | Embedded portable JSON contracts |
| `Snowknife/Patches/` | Verified executable patch descriptors |
| `SSX-Library/` | The upstream submodule, referenced as a sibling project and not owned here |

Documentation by boundary:

- [Snowknife docs](docs/README.md) — extraction, audio, effects, bundle design, and testing.
- [Portable schemas](Snowknife/schemas/README.md) — versioned contracts shared with other tools.
- [Slopesmith](../Slopesmith/README.md) — interactive authoring.
- [Unity](../Unity/README.md) — Unity import and runtime behavior.
- [Trailmap](../Trailmap/specs/README.md) — observed retail behavior cited by the implementation.

Snowknife-specific diagnostics live in [`tools/`](tools/). Authoring studies stay with Slopesmith;
Unity bundle diagnostics stay under `Unity/tools/`.

## Public and private outputs

No game assets are included. Commands that read or modify retail data operate only on a user-supplied disc
image; users must determine whether making and using that image is permitted under applicable law and
contractual terms. Generated maps, images, and temporary archives remain local and gitignored.

`snowknife unity` stages content for local/private interoperability testing. A distributable project
must use an authored map and `snowknife unity --public`, which fails closed on retail-derived or unknown
content, requires a fresh destination without a Shared pack, and requires explicit rights confirmation
for user-supplied files.

Executable patch descriptors contain verification hashes and reconstruction instructions, not the retail
bytes they replace. See [REPACK.md](REPACK.md) and [NOTICE](NOTICE) for the exact safety and provenance
model.

## License

Snowknife is independent and unofficial, and is not affiliated with or endorsed by Electronic Arts.
It is licensed under GPL-3.0-only to match SSX-Library; see [LICENSE.txt](LICENSE.txt) and [NOTICE](NOTICE).
The portable contracts under [`Snowknife/schemas/`](Snowknife/schemas/README.md) are separately licensed
under Apache-2.0 so other tools can implement them.
