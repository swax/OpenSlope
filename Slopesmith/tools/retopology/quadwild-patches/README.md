# QuadWild patches

Modifications to the QuadWild-BiMDF solver that the retopology feature drives. They add prescribed
subdivision counts and prescribed boundary placement, which is what lets a generated cage meet an
exact locked trail edge-for-edge instead of being cut to fit afterwards
([docs/045](../../../docs/045-retopology-benchmark.md), [docs/ideas/042](../../../docs/ideas/042-relayout-quantization.md)).

```
quadwild-prescribed-subsides.patch           the main tree: quad_from_patches, quadretopology, quadwild
quadwild-prescribed-subsides-satsuma.patch   the vendored satsuma submodule
quadriflow-msvc.patch                        MSVC-compatible release flags for the optional QuadriFlow baseline
```

## Licensing

**These three files are not covered by this repository's Apache-2.0 grant.** They are diffs against
other people's programs, and each carries its subject's license:

| Patch | Applies to | Upstream license |
|---|---|---|
| `quadwild-prescribed-subsides.patch` | [QuadWild-BiMDF](https://github.com/cgg-bern/quadwild-bimdf), a fork of [QuadWild](https://github.com/nicopietroni/quadwild), and the `quadretopology` library it vendors | GPL-3.0 |
| `quadwild-prescribed-subsides-satsuma.patch` | [libsatsuma](https://github.com/cgg-bern/libsatsuma), vendored at `libs/satsuma` | MIT — © 2023 Martin Heistermann; see [`LIBSATSUMA-LICENSE.txt`](LIBSATSUMA-LICENSE.txt) |
| `quadriflow-msvc.patch` | [QuadriFlow](https://github.com/hjwdzh/QuadriFlow) | BSD-3-Clause-style terms — © 2018 Jingwei Huang et al.; see [`QUADRIFLOW-LICENSE.txt`](QUADRIFLOW-LICENSE.txt) |

The main patch reproduces GPL-3.0 source as diff context and adds code to GPL-3.0 files, so it is a
derivative work of that program and is conveyed under **GPL-3.0**. A full copy of the license text
is in [`LICENSE`](LICENSE) beside these files. The satsuma patch is a derivative of MIT-licensed
source and is conveyed under the **MIT License**, with its complete copyright and permission notice in
[`LIBSATSUMA-LICENSE.txt`](LIBSATSUMA-LICENSE.txt). The QuadriFlow
build patch is conveyed under QuadriFlow's terms reproduced beside it.

Nothing else in Slopesmith is affected. The editor's server spawns the built `quadwild` and
`quad_from_patches` executables as separate processes and exchanges `.obj` and `.sharp` files with
them (`src/server/retopology/jobs.ts`). It links no part of either program, and no upstream source
is vendored in this repository — only these diffs.

Verify the upstream licenses at the revision you check out. The table above records what those
projects carried when these patches were written.

## Before you build it, know what it can pull in

QuadWild-BiMDF's own dependencies are its business, not this repository's, but one of them has terms
strict enough to be worth reading before you rely on the feature. QuadWild can optionally build
**Blossom V** (Vladimir Kolmogorov's minimum-cost perfect-matching implementation), which is *not*
free software: it is available for evaluation and research only, redistribution of its source is not
permitted, and commercial use requires a license from UCLB. That is why `libs/blossom5-cmake` ships a
patch file rather than the code. The OpenSlope build commands below explicitly keep
`SATSUMA_ENABLE_BLOSSOM5=OFF`; do not enable it without first settling those terms for your use.

The practical consequences, all of which land on whoever builds and runs the solver:

- **Do not redistribute binaries built with dependencies whose terms prohibit it.** Ship the patches
  and let people build their own.
- **A hosted deployment that enables Blossom V is not obviously "research".** If you opt into that
  dependency for a Slopesmith service, settle its terms for your use first.
- Several other vendored libraries are copyleft in their own right — CoMISo and lemon among them.

Retopology is the one optional feature with this shape. The rest of the editor has no native
dependency: a deployment that never sets `SLOPESMITH_QUADWILD_ROOT` simply reports the solver as
unavailable, and everything else works.

## Checkout, patch, and build

Prerequisites are Git, CMake, and a C++20 compiler. On Windows, install Visual Studio 2022 Build
Tools with **Desktop development with C++**, plus CMake itself. On Linux or macOS, use the platform's
ordinary compiler and CMake packages.

Keep this optional dependency durable but outside OpenSlope's source history. From the **OpenSlope
repository root**, clone the tested upstream revision into the gitignored `quadwild-bimdf/` folder:

```powershell
git clone --recursive https://github.com/cgg-bern/quadwild-bimdf.git quadwild-bimdf
git -C quadwild-bimdf checkout e722c7e961982cf61db7c10812329dd0fc7d60df
git -C quadwild-bimdf submodule update --init --recursive
```

The pinned revision currently selects libsatsuma
`4e96979ecb11bbfe8d9c05e8f8be1ecb992ca5fd`. Test both OpenSlope patches before changing the checkout,
then apply them:

```powershell
git -C quadwild-bimdf apply --check ../Slopesmith/tools/retopology/quadwild-patches/quadwild-prescribed-subsides.patch
git -C quadwild-bimdf/libs/satsuma apply --check ../../../Slopesmith/tools/retopology/quadwild-patches/quadwild-prescribed-subsides-satsuma.patch
git -C quadwild-bimdf apply ../Slopesmith/tools/retopology/quadwild-patches/quadwild-prescribed-subsides.patch
git -C quadwild-bimdf/libs/satsuma apply ../../../Slopesmith/tools/retopology/quadwild-patches/quadwild-prescribed-subsides-satsuma.patch
```

Configure a release build without the optional non-free Blossom V dependency and build the two
executables Slopesmith invokes:

```powershell
cmake -S quadwild-bimdf -B quadwild-bimdf/build-release -DSATSUMA_ENABLE_BLOSSOM5=OFF '-DCMAKE_POLICY_VERSION_MINIMUM=3.5'
cmake --build quadwild-bimdf/build-release --config Release --target quadwild quad_from_patches --parallel
```

The quoted policy option keeps QuadWild's older dependency CMake files compatible with CMake 4;
older CMake releases safely accept it too. Keep the quotes in PowerShell so `3.5` is passed intact.

On Windows, a Visual Studio generator writes the detected binaries under
`quadwild-bimdf/build-release/Build/bin/Release/`. A single-configuration Linux or macOS generator
normally writes them under `quadwild-bimdf/build-release/Build/bin/`; set
`SLOPESMITH_QUADWILD_BIN` to that directory.

The optional QuadriFlow comparison build needs its separate patch on MSVC:

```bash
git apply /path/to/quadriflow-msvc.patch
```

The server first looks for the durable repository-root checkout at `../quadwild-bimdf` relative to
the Slopesmith app. An existing checkout at the former `../temp/retopo/quadwild-bimdf` path remains a
compatibility fallback. `SLOPESMITH_QUADWILD_ROOT` overrides the checkout and
`SLOPESMITH_QUADWILD_BIN` overrides the binary directory alone. The capabilities endpoint and the
Retopology strategy dropdown report a missing executable instead of silently selecting a different
algorithm.

After starting Slopesmith, confirm the native strategy is detected at
`http://localhost:5179/api/retopology/capabilities`. Its `quadwild` entry should report
`"available": true`; restart an already-running server after installing the checkout.

## What each patch changes

**Main tree.** `loadFixedSubsides` reads an optional `input_rem_p0.fixed` sidecar naming per-subside
subdivision counts, which are pinned through the quantization rather than solved for.
`computeQuadrangulation`'s chart-UV mapping honours per-subside split fractions so a prescribed
boundary vertex lands at an exact parameter rather than at an even division. Prescribed rims are
held fixed through the post-solve smoothing, so the join survives the pass that would otherwise
relax it.

**Satsuma.** One correctness fix in `BiMDF_to_BiMCF`: the remaining capacity of a bounded arc has to
subtract the guess as well as the deviation, or flow can exceed a finite upper bound. Plus a missing
`<algorithm>` include.
