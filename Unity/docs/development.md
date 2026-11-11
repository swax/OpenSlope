# Developing the Unity integration

The repository copy is the source of truth for the importer and platform runtimes.
Start with the [Unity README](../README.md) for first use.

## What is here

Paths below are relative to `Unity/`.

| Path | Owns |
|---|---|
| `Importer/` | Engine-neutral Unity editor importer and bundle readers |
| `VRC/` | VRChat/Udon runtime, shaders, setup commands, and platform wiring |
| `Basis/` | Basis realization of the same imported marker contracts |
| `docs/` | Importer, runtime, Basis, and authoring design documents |
| `tools/` | Source sync, boundary checks, Unity/ClientSim tests, and built-world diagnostics |

The importer builds one `OpenSlope_Map` root from Snowknife's glTF files and `manifest.json`. It handles
geometry, materials, lightmaps, collision, rails, effects, particles, audio placement, and probe
positions without reinterpreting retail formats. Platform wiring then realizes neutral markers as
VRChat or Basis behaviors. See the [documentation index](README.md) and Snowknife's
[bundle pipeline](../../Snowknife/docs/034-bundle-pipeline.md).

## Formatting

[`Unity/.editorconfig`](../.editorconfig) defines C# whitespace formatting: four spaces, Allman braces,
preserved single-line blocks, and CRLF line endings matching `.gitattributes`. Run from the repository root:

```text
npm run format:unity        # apply formatting
npm run format:unity:check  # check without writing; exits nonzero on differences
```

Like Snowknife, this uses the SDK's built-in [`dotnet format whitespace`](https://learn.microsoft.com/dotnet/core/tools/dotnet-format#whitespace)
and the .NET SDK selected by [`global.json`](../../global.json). No Unity editor, VRChat/Basis SDK,
package restore, or build is needed. The formatting-only [workspace](../tools/Unity.Formatting.csproj)
enables `UNITY_EDITOR` and reload diagnostics, with separate Unity 2022 and Unity 6 passes so conditional
editor code is included.

The commands cover C# in `Importer/`, `VRC/`, `Basis/`, and `tools/diagnostics/`. Generated C#,
`bin/` and `obj/`, staged maps, local Unity projects, and shaders are outside their scope.
Formatting preserves the existing block-scoped namespaces and changes whitespace only. As with the
native and Snowknife formatters, these are explicit local commands rather than an additional CI gate.

## Keeping project copies in sync

This folder is the source of truth. Do not edit only the copy inside a Unity project. To update a
project and report changed `.cs` and `.shader` files:

```powershell
pwsh Unity/tools/sync-unity.ps1 -Target <project-name-or-path>
```

Use `-DryRun` to preview and `-Prune` to remove project-copy files deleted from the repository.
`OPENSLOPE_UNITY_PROJECTS` may point short target names at a common Unity-projects folder.

## Editor menu conventions

A system built by find-or-create has one entry under **Setup**: rerun it to refresh boards,
the HUD or the Jukebox. **Refresh** is for subsystems rebuilt from the bundle.

Menu order uses `MenuItem` priority bands, with each item inside a band taking the next `+1`
(Setup 110/130/150/170/190/210, Refresh
300/320/340, Optimize 500, Tools 700/720/740, Dev 900/920). Unity draws a separator wherever
consecutive priorities differ by 11 or more, so the bands are what produce the grouping. When adding an
item, take the next free number in its band; never reuse one, because tied priorities fall back to
assembly registration order and shuffle on recompile.
