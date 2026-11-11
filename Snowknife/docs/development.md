# Developing Snowknife

Build, formatting and source navigation for contributors. For downloads and the normal
conversion workflow, start with the [Snowknife README](../README.md).

## Build and test from source

Requires the .NET 10 SDK selected by [`global.json`](../../global.json) and the repository submodule.
Run these commands from the **OpenSlope repository root**. `dotnet --version` must succeed there;
if it reports a missing SDK, install the version named in `global.json`.

```powershell
git submodule update --init --recursive
dotnet --version
dotnet build Snowknife/Snowknife/Snowknife.csproj -c Debug
dotnet test Snowknife/Snowknife.Tests/Snowknife.Tests.csproj --filter "Category!=EndToEnd"
```

The build leaves the CLI at `Snowknife/Snowknife/bin/Debug/net10.0/snowknife` (`snowknife.exe` on
Windows). Nothing installs it: add that directory to `PATH`, or invoke the executable by path. The
examples in this guide and in [REPACK.md](../REPACK.md) assume it is on `PATH`. Slopesmith finds the
same build through its sibling checkout, or through `SLOPESMITH_SNOWKNIFE_EXE` when it lives elsewhere.

The filtered test command uses synthetic fixtures and needs no disc. See
[Testing Snowknife](testing.md) for the optional disc-backed tier and
[repository validation](../../CONTRIBUTING.md#routine-development) for choosing checks.

## Formatting

[`Snowknife/.editorconfig`](../.editorconfig) sets the C# whitespace style for the CLI and tests:
four spaces, Allman braces, preserved single-line blocks, and CRLF line endings matching `.gitattributes`.
The formatter is the SDK's built-in [`dotnet format whitespace`](https://learn.microsoft.com/dotnet/core/tools/dotnet-format#whitespace),
using the .NET version selected by [`global.json`](../../global.json); no extra tool install is needed.
Run from the repository root:

```text
npm run format:snowknife        # apply formatting
npm run format:snowknife:check  # check without writing; exits nonzero on differences
```

Both commands cover hand-written C# in `Snowknife/` and `Snowknife.Tests/`. Folder mode needs no
restore or build and leaves the SSX-Library submodule, linked Unity sources, generated code, and
`bin/` and `obj/` output alone. Style suggestions such as `var` and namespace preferences remain
editor hints; these commands only apply whitespace formatting. Like the native formatter, this
is an explicit local command rather than an additional CI gate.

## Architecture and contracts

Snowknife uses a [fork of SSX-Library](https://github.com/swax/SSX-Library) for core retail-format
support. The fork carries decoding fixes and additions needed by the conversion and repacking
pipeline; its README lists the changes. Snowknife owns the pipeline, additional codecs,
validation, portable contracts, glTF bundles and Unity staging.

Dependencies run downward from command composition into services and format primitives.
Paths below are relative to `Snowknife/`:

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

- [Snowknife docs](README.md) — extraction, audio, effects, bundle design, and testing.
- [Portable schemas](../Snowknife/schemas/README.md) — versioned contracts shared with other tools.
- [Slopesmith](../../Slopesmith/README.md) — interactive authoring.
- [Unity](../../Unity/README.md) — Unity import and runtime behavior.
- Trailmap (`../../Trailmap/specs/README.md` in the local Trailmap workspace) — observed retail behavior cited by the implementation.

Snowknife-specific diagnostics live in [`tools/`](../tools/). Authoring studies stay with Slopesmith;
Unity bundle diagnostics stay under `Unity/tools/`.
