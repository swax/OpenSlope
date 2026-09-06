# Experimental Basis port documentation

The Basis realization uses Unity 6, URP, ordinary MonoBehaviours, and a matching Basis client/server checkout.
It is an active, partially verified port rather than a second supported configuration of the Unity 2022.3
VRChat runtime.

Numbers are stable identifiers within this directory. Gaps are intentional; other documentation trees may
reuse the same numbers.

- [061 — Basis port overview](061-overview.md) — setup, implemented systems, current verification, and next steps.
- [062 — Basis porting notes](062-porting-notes.md) — marker wiring, triggers, networking, URP, and Unity 6 differences.

The source-oriented entry point is the [Basis README](../../Basis/README.md). Shared importer behavior and
cross-layer features are indexed in the parent [Unity documentation](../README.md).
