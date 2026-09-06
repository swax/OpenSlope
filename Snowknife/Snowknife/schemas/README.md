# Snowknife interchange schemas

This directory is the canonical home for the versioned JSON contracts that
Snowknife shares with Slopesmith, Blender, Unity, and other tools. A schema belongs
here when the document is intended to be authored or consumed outside the
extractor itself.

## Contracts

| Schema | Document | Stability |
| --- | --- | --- |
| [`bundle/bundle-manifest-v3.schema.json`](bundle/bundle-manifest-v3.schema.json) | `gltf/manifest.json` | Versioned interchange contract |
| [`course/patches-v1.schema.json`](course/patches-v1.schema.json) | `Patches.json` | Versioned course-source contract |
| [`course/splines-v1.schema.json`](course/splines-v1.schema.json) | `Splines.json` | Versioned course-source contract |
| [`course/sound-index-v1.schema.json`](course/sound-index-v1.schema.json) | `Audio/SoundIndex.json` | Generated, map-local audio-routing contract |
| [`course/environment-audio-v1.schema.json`](course/environment-audio-v1.schema.json) | `Audio/Environment.json` | Explicit map-local off-board environment bed |
| [`course/sky-ring-v1.schema.json`](course/sky-ring-v1.schema.json) | `Skybox/Ring.json` | Generated, map-local sky-composition contract |
| [`course/billboards-v1.schema.json`](course/billboards-v1.schema.json) | `Billboards.json` | Versioned course-source contract (detected or authored) |
| [`course/world-v1.schema.json`](course/world-v1.schema.json) | `World.json` | Versioned course-source contract |
| [`shared/board-sound-index-v1.schema.json`](shared/board-sound-index-v1.schema.json) | `Shared/Audio/BoardSoundIndex.json` | Generated, shared board-routing contract |
| [`authoring/openslope-effects-v1.schema.json`](authoring/openslope-effects-v1.schema.json) | `Effects.json` | Versioned authoring contract |
| [`tooling/prop-override-v1.schema.json`](tooling/prop-override-v1.schema.json) | `Overrides/*/override.json` | Versioned tooling input |
| [`tooling/repack-manifest-v1.schema.json`](tooling/repack-manifest-v1.schema.json) | `snowknife repack-many` manifest | Versioned tooling input |

Standard files such as glTF, OBJ, PNG, and WAV use their upstream format
specifications. Raw extraction intermediates such as `Models.json`,
`Instances.json`, `Materials.json`, and `SSFLogic.json` mirror incompletely
understood retail structures and are not stable interchange contracts. They
should not acquire schemas until another project needs to rely on their shape.

Schemas use JSON Schema Draft 2020-12 and are embedded in the `snowknife`
executable. Snowknife validates them automatically before consuming authored
documents and before publishing portable exports. A file or directory can also
be checked explicitly:

```text
snowknife validate Maps/MYLEVEL
snowknife validate Maps/MYLEVEL/Effects.json
```

A directory check recursively recognizes `Patches.json`, `Splines.json`, `SoundIndex.json`, `Environment.json`,
`BoardSoundIndex.json`, `Ring.json`, `Billboards.json`, `Effects.json`, bundle/repack `manifest.json`, and prop
`override.json` files.
Schema validation covers document shape; format-specific semantic checks still
enforce references, external files, and binary round trips.

PowerShell 7 can apply an individual schema independently:

```powershell
Test-Json -LiteralPath <document.json> -SchemaFile <schema.json>
```

## License

Copyright 2026 swax. The schemas and documentation in this directory are
licensed under the **Apache License 2.0** (`Apache-2.0`) — see
[`LICENSE`](LICENSE) for the full text.

This grant is a deliberate, scoped exception to the rest of the repository, so
that tools outside Snowknife can implement against these contracts without
taking on a copyleft obligation. Precisely:

- **What it covers:** every file in `Snowknife/Snowknife/schemas/`, including this README.
- **What it does not cover:** the Snowknife program itself, which is licensed
  `GPL-3.0-only` (see [`LICENSE.txt`](../../LICENSE.txt) and
  [`NOTICE`](../../NOTICE)). Documents *described* by these schemas are the
  author's own data and are not licensed here at all.
- **Combination:** Apache-2.0 is one-way compatible with GPLv3. These schemas
  are embedded as resources in the `snowknife` executable, and that combined
  build is conveyed as a whole under `GPL-3.0-only`. Extracting the schema
  files on their own leaves them under Apache-2.0.
