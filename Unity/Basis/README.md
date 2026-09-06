# OpenSlope on Basis

**Basis-specific runtime and shader source for the OpenSlope port.** These files are copied into a local
Basis Unity project alongside the shared [`Importer`](../Importer/).

Basis uses Unity 6, URP, ordinary MonoBehaviours, and `BasisNetworkBehaviour`; the VRChat target uses
Unity 2022.3, the built-in render pipeline, UdonSharp, and VRChat APIs. The shared importer emits
platform-neutral geometry and `*Marker` components, then each platform's wiring pass realizes those
markers as native behaviors.

## Start here

- [Basis port overview](../docs/basis/061-overview.md) — setup, current feature status, import flow, and roadmap.
- [Basis porting notes](../docs/basis/062-porting-notes.md) — marker wiring, triggers, networking, URP, and Unity 6 differences.
- [Shared OpenSlope documentation](../docs/README.md) — platform-neutral feature design.

For local development, follow the overview to build a matching Basis client/server checkout, copy this
folder plus `Importer/` into the client project's `Assets/`, then use:

1. **OpenSlope Basis → Load → Map…** to select a staged `Assets/OpenSlope/Maps/<MAP>/` bundle and build the scene.
2. **OpenSlope Basis → Setup All** to rerun Basis scene finalization on an already imported map.

## Source map

| Path | Owns |
|---|---|
| `Editor/BasisImportAll.cs` | Shared importer entrypoint and Basis scene finalization |
| `Editor/BasisWiring.cs` | Neutral marker-to-Basis behavior realization |
| `Editor/BasisSetupAll.cs` | Post-import player, board, UI, and scene setup |
| `Riding/` | Rideable board, rail, scoring, audio, and network synchronization |
| `World/` | Gems, effects, course triggers, props, breakables, animation, culling, flight, and boards |
| `Shaders/` | URP counterparts of the shared OpenSlope terrain, prop, particle, and effect shaders |

The port currently covers full world import, a rideable and networked board, rails, gems, course-flow
triggers, physics props, breakables, animated textures, effects/audio placement, object culling, on-foot
flight, and start-gate controls. The overview—not this README—is the authoritative status and roadmap.

## Editing rule

This folder is the source of truth. Edit Basis scripts and shaders here, then copy them into the Basis
client checkout; do not maintain a project-only fork. Shared importer changes belong in
[`Importer/`](../Importer/) and must continue to compile for both Unity targets.

Basis is covered by the parent component's [Apache-2.0 license](../LICENSE) and
[NOTICE](../NOTICE).
