# OpenSlope on Basis

**Ride OpenSlope maps in an experimental Basis world.** This runtime uses the shared Unity
importer to bring terrain, props, audio and course interactions into a Basis client.
It uses Unity 6, URP and ordinary C# behaviours alongside `BasisNetworkBehaviour`.

The port is partially verified. The [Basis overview](../docs/basis/061-overview.md) records
setup requirements, implemented features and known gaps.

## Try the port

1. Follow the [local setup guide](../docs/basis/061-overview.md#local-dev-setup) to build a matching
   Basis client and server from the same checkout.
2. Copy this `Basis/` folder and the shared [`Importer/`](../Importer/) into the client project's `Assets/`.
3. Build and stage a map with [Snowknife](../../Snowknife/README.md) under
   `Assets/OpenSlope/Maps/MYMAP/`, as described in the [import pipeline](../docs/basis/061-overview.md).
4. Choose **OpenSlope Basis → Load → Map…** and select that map folder to build the scene.
   **OpenSlope Basis → Setup All** reruns finalization on an already imported map.

Edit scripts and shaders in this repository, then copy them into the client project.
Shared importer changes must continue to compile for both Unity targets.

## Documentation

- [Port overview and status](../docs/basis/061-overview.md) — setup, import flow and feature coverage.
- [Porting notes](../docs/basis/062-porting-notes.md) — source layout, marker wiring, networking and Unity 6 differences.
- [Unity documentation](../docs/README.md) — shared importer and runtime systems.
- [Development guide](../docs/development.md) — formatting and keeping project copies in sync.

## Content and license

Use authored or rights-cleared assets for shared worlds. Disc-derived projects remain local/private;
follow the parent component's [content guidance](../README.md#content-and-license).
Basis source is covered by the parent [Apache-2.0 license](../LICENSE) and [NOTICE](../NOTICE).
