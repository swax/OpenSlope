# Testing Snowknife

Snowknife uses two test tiers: a fast synthetic suite that runs everywhere and an optional end-to-end
tier that validates the real pipeline against locally supplied disc data.

## Synthetic suite

```powershell
dotnet test Snowknife/Snowknife.Tests/Snowknife.Tests.csproj --filter "Category!=EndToEnd"
```

The synthetic suite covers:

- BIGF, SHPS, and BNKl container round-trips, alignment, and gap filling;
- PS-ADPCM and EA-XA encoding against the same decoders used for retail input;
- texture alpha detection and GS texture-budget heuristics;
- effect-graph IDs, references, and classifiers;
- schema rejection behavior and command-table/help consistency;
- cross-project contracts shared with Slopesmith and Unity.

It requires neither a disc nor an existing `Maps/` export.

## End-to-end tier

From the repository root:

```powershell
npm run verify:full
npm run coverage:snowknife:full
```

A bare `dotnet test` also includes the end-to-end category, but those tests skip with an explanation
when their local inputs are absent. Set `SNOWKNIFE_SKIP_E2E=1` to request that behavior explicitly.

The tier expects:

- `discs/ssx-tricky-europe.iso`;
- an imported `Maps/GARI`;
- authored `Maps/GOLD`, `Maps/AUTOTEST1`, `Maps/AUTOTEST2`, and `Maps/AUTOTEST4` fixtures.

A clean public checkout plus the Europe ISO can create every input; no private repository files are
required. After installing dependencies and building Snowknife, run these commands from the repository root:

```powershell
$snowknife = Resolve-Path Snowknife/Snowknife/bin/Debug/net10.0/snowknife.exe
& $snowknife import discs/ssx-tricky-europe.iso GARI Maps/GARI
Push-Location Slopesmith
npx tsx scripts/auto-test-map.ts ../Maps/GOLD --fixture GOLD --no-project
npx tsx scripts/auto-test-map.ts ../Maps/AUTOTEST1 --fixture AUTOTEST1 --no-project
npx tsx scripts/auto-test-map.ts ../Maps/AUTOTEST2 --fixture AUTOTEST2 --no-project
npx tsx scripts/auto-test-map.ts ../Maps/AUTOTEST4 --fixture AUTOTEST4 --no-project
Pop-Location
npm run coverage:snowknife:full
```

The fixture generator imports its animated SnowGun from the committed
`Slopesmith/tools/prop-recipes/props/SnowGun.glb`. The generated `Maps/` folders and disc image remain ignored
local test inputs and must not be committed.

It verifies the same inputs used by `Trailmap/tools/autotest/run.py`:

- `import` writes non-trivial artifacts whose textures, effects references, and embedded schemas resolve;
- `gltf` produces valid deterministic GLB/manifest output with populated collision and material data;
- `repack --dry-run --json` reports deterministic allocation, texture budgets, and only reviewed findings;
- a built ISO changes the selected course without changing its neighbor or, where required, the boot ELF.

These tests call services in-process so normal .NET coverage includes them. Retail-dependent exporters
that remain outside this tier are checked by self-verifying commands such as `bank-verify`,
`effects-check`, and `validate`, plus the PCSX2 autotest harness.
