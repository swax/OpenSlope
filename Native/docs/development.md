# Developing Native

Native is a C++20 player with a Vulkan renderer and OpenXR host. Platform hosts own file
access; the readers and gameplay core also compile for desktop tools and WebAssembly.
Start with [building](building.md) and [testing](testing.md) for the development loop.

## Source and behavior

- [Importer architecture](importer-architecture.md) describes `src/import/`, shared container
  readers and adding another game.
- [Specification alignment](spec-alignment.md) records implemented slices, differences from
  other ports and prototype choices. `Contracts/ride-v1.json` is embedded at build time.
- [Source provenance](source-provenance.md) explains implementation and dependency boundaries.
- [Desktop parity](desktop-parity.md) tracks remaining gameplay, presentation and device work.
- [Release packaging](releases.md) covers portable downloads, signing and publication.

Original-game research and local captures belong in the optional local research workspace;
component documents cite conclusions with `[Trailmap: anchor]` identifiers. Follow the
[research boundary](../../CONTRIBUTING.md#reverse-engineering-hygiene). Required builds and
synthetic tests use tracked contracts and do not require that workspace.

## Formatting

Java uses Prettier Java, pinned in Slopesmith's dependency lockfile.
[`Native/.prettierrc.json`](../.prettierrc.json) sets four-space indentation, a 120-column width
and LF line endings. Run from the repository root:

```text
npm ci --prefix Slopesmith
npm run format:java
npm run format:java:check
```

These commands cover Android app/instrumentation sources, host Java tests and Java tools.
The check command reports differences without writing. No JDK, Android SDK or Gradle build
is needed for formatting.

[`Native/.clang-format`](../.clang-format) sets the C++ style. Use clang-format **23.1.3**:

```powershell
uv tool install clang-format==23.1.3
```

`git clang-format` formats lines changed since `HEAD`. To format all tracked native sources:

```powershell
clang-format -i (git ls-files 'Native/src/*.?pp' 'Native/include/*.hpp' 'Native/tests/*.?pp')
```

Formatting-only commits are listed in `.git-blame-ignore-revs`. GitHub skips them in blame;
use `git config blame.ignoreRevsFile .git-blame-ignore-revs` for the same local behavior.
