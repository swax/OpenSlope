# Contributing

## Scope

Two areas are deliberately out of scope, and pull requests adding them will be declined:

- **Characters.** Custom avatars are supported through Slopesmith's
  [server-wide character library](Slopesmith/docs/030-character-models.md#server-wide-character-library) —
  ride them and improve that path. Existing `Maps/Custom/Characters/` files are migrated into the
  library for compatibility. The retail cast — models, likenesses, stats, dialogue — is neither imported
  nor recreated.
- **The game's tricks.** The retail trick repertoire — the moves and animations, extracted or
  re-created by hand. Trick flags and pads still survive conversion, Trailmap still specifies the
  behavior, and original OpenSlope tricks are not ruled out; the game's moves are the line.

## Public language

OpenSlope's user-facing story is **author, convert, ride**: start in Slopesmith or with a course converted
locally from a user-supplied SSX Tricky disc image, then use the shared map format in the browser, Unity,
PCSX2, or on PS2 hardware. Public distribution is a distinct authored/rights-cleared path enforced by
`snowknife unity --public`. Top-level component READMEs should identify their role in that loop before
explaining their implementation.

Use these nouns consistently in public documentation:

- **course** — the experience someone creates and rides;
- **mountain** — the editable Slopesmith project;
- **map** — the portable `Maps/<NAME>` artifact shared by the tools; and
- **level** — a platform's native disc or engine representation.

Deep technical documentation can use native format terms where precision requires them. No retail binary
or extracted asset ships here; disc-backed workflows accept only a user-supplied disc image and remain
local/private. Contributors must determine whether making and using that image is permitted under
applicable law and contractual terms.

## Contribution provenance

Only submit work you created or have the right to contribute under the affected component's license. Identify
third-party material and its license in the pull request. Do not submit extracted retail assets, confidential
material, or generated output whose terms you cannot satisfy.

**Contributions are licensed under the license of the component they touch**, which [`LICENSE`](LICENSE) maps
out. By opening a pull request you agree to these terms: you offer the contribution under the affected
component's license, and you confirm that you created it or otherwise have the right to submit it on those
terms, and that it contains none of the material this section excludes. No sign-off line and no CLA.

(That is not redundant boilerplate: Apache-2.0 implies it, GPL-3.0 does not, so Snowknife needs it said.)

## Repository quality gate

The gate requires the .NET 10 SDK, Node 24, and Python 3 on `PATH` (CI uses Python 3.13).

Initialize the format-library submodule, install the Trailmap tool dependencies the hygiene checks
import, and install Slopesmith's locked dependencies once:

```text
git submodule update --init
python -m pip install -r Trailmap/tools/requirements.txt
npm ci --prefix Slopesmith
```

Before submitting a change, run the complete gate from the repository root:

```text
npm run verify
```

The gate stops at the first failure and runs:

1. The Trailmap hygiene scanner tests, clean-spec separation check, and repository-wide hygiene baseline.
2. `Snowknife.Tests` — synthetic .NET tests, including byte-format round trips and cross-repository contracts.
3. Slopesmith's strict TypeScript check and its ESLint pass (`npm --prefix Slopesmith run lint`, zero findings).
4. Slopesmith's deterministic full suite — every check under `Slopesmith/test/` is discovered, including those
   outside the fast edit-time tier, with an informational coverage report. The three that read extracted
   `Maps/` data are excluded; `npm --prefix Slopesmith run test:local` adds them.
5. The Slopesmith client and server production build.
6. The end-to-end authored-map export and real `snowknife gltf` smoke test.

No retail ISO or extracted assets are needed. `verify` explicitly filters out Snowknife's `EndToEnd` category even
on a machine that has the data, so the gate you run locally is the gate the nightly `Full Windows verification`
workflow runs. The per-push `Verify` workflow runs a subset that fits the repository's GitHub Actions minute
budget: the hygiene gate, whichever fast suites the push touches, Slopesmith's type check and lint, and the
production build. Coverage and the export smoke test wait for the nightly run, so a change that passes `Verify` has not
yet passed everything; `npm run verify` locally is what closes that gap before a push. The required
gate does not launch Unity because CI would need a Unity license and a project installation. The importer
integration test below covers the platform-neutral Unity code without requiring VRChat/UdonSharp.

### Push-time gate

Install the pre-push hook once per clone, and the checks the `Verify` workflow would run for a push run on
your machine first:

```text
npm run hooks:install
```

It runs the hygiene gate plus whichever fast suites the pushed commits touch, the same selection CI makes
(both read `tools/affected-suites.mjs`), in about a minute, and refuses the push on a failure. That keeps
`main` green for everything a local run can catch; CI's Linux runner still has the last word on anything
platform-specific. `OPENSLOPE_SKIP_PREPUSH=1 git push` (or `git push --no-verify`) skips it once.
`npm run verify` remains the full gate.

If server-side enforcement becomes useful, the `Protect main` repository ruleset can require a pull request
and both stable `Verify` results: `Required hygiene gate (zero findings)` and `Required verification gate`.
The latter aggregates the conditionally selected Snowknife and Slopesmith jobs, so an intentionally skipped
component cannot leave a pull request waiting for a check that will never run. The checks remain visible and
useful without making that higher-overhead workflow mandatory for a solo-maintained repository.

## Reverse-engineering hygiene

Reverse-engineering evidence has a one-way path through the repository:

```text
Trailmap/research -> Trailmap/specs -> component docs and source
```

Addresses, native symbols and classes, runtime object offsets, disassembly narratives, and paths into local
analysis/extracted data belong in `Trailmap/research` or the purpose-built analysis, instrumentation, patch-authoring,
and autotest tools. Clean specs state observable behavior and file formats. Downstream documentation and source
refer to those conclusions with `[Trailmap: <anchor>]`; a spec citation does not make raw evidence clean enough to
repeat downstream.

Run the required checks from the repository root:

```text
npm run hygiene
npm run hygiene:report
```

`tools/hygiene.py` is the list of checks the gate runs — CI, `npm run verify`, and release preparation
all call it, so adding a check there adds it everywhere at once.
`python tools/hygiene.py --list` prints them. Do not re-list them in a workflow or a script:
they were duplicated in four places once, and twice a new check reached some entry points and
not others.

The report shows every current finding with a file, line, rule, and suggested migration. Existing cleanup debt is
recorded in `Trailmap/tools/specs/repo_hygiene_baseline.json`: CI fails on any new finding, and it also fails when a
fixed finding leaves a stale baseline entry. After cleaning findings, review the complete report and deliberately
shrink the baseline with:

```text
npm run hygiene:baseline
npm run hygiene
```

`Snowknife/Snowknife/Patches/*.json` is a narrow operational exception: target names, offsets, hashes, and patch bytes are
allowed payload, while each manifest's prose notes must cite a Trailmap spec and are still scanned for leaked derivation.
Governance documents and `Trailmap/specs` are owned by their specialized checks.

For a rare legitimate token, a same-line exception is available, but it must identify one rule and explain why the
value is not RE evidence:

```text
repo-hygiene: allow[runtime-address] -- fixed protocol fixture, not an executable address
```

Prefer clearer naming or prose over exceptions. Never baseline a new finding merely to make CI green.

## The disc-backed tier

`Snowknife.Tests` has a second tier that drives `import`, `gltf` and `repack` against a real SSX Tricky image. It
cannot run in CI, and it is where most of the suite's coverage comes from, so run it before a release or after
touching the repack or level pipelines:

```text
npm run verify:full
```

That is the gate above with the disc-backed tests included. It needs `discs/ssx-tricky-europe.iso`, an extracted
`Maps/GARI`, and the authored `Maps/{GOLD,AUTOTEST1,AUTOTEST2,AUTOTEST4}` exports; `Snowknife/docs/testing.md` lists
what each leg asserts. Without them the tests skip rather than fail.

Skipping is also how the tier could quietly stop existing, so every run prints how many tests skipped and why, and
a fast-tier test fails on a machine that has the image but is skipping anyway — naming the command that produces
the data it is missing.

## Snowknife coverage

`npm run coverage:snowknife` runs the fast .NET tier and prints its outcome tally and line coverage
by folder; `npm run coverage:snowknife:full` does the same with the disc-backed tier included. Both write the raw
`.trx` and Cobertura report under `TestResults/`, and both are what the gate's first step runs, so a plain
`npm run verify` produces the same figures.

The two numbers are far apart — the fast tier alone covers a fraction of what a disc-backed run reaches, because
the repack and level pipelines only execute against real data. CI publishes the fast-tier figure and retains the
report as the `snowknife-test-results` artifact for 7 days. Coverage is scoped to the `snowknife` assembly, so the
`Snowknife/SSX-Library` submodule appears in the same report and is deliberately excluded even though it now sits
under `Snowknife/`. Coverage is informational; CI does not enforce a minimum percentage.

## Slopesmith coverage

`npm run coverage:slopesmith` from the repository root runs the deterministic Slopesmith suite and prints line,
statement, function, and branch coverage. It writes an interactive report to `Slopesmith/coverage/index.html`,
LCOV to `Slopesmith/coverage/lcov.info`, and machine-readable totals to
`Slopesmith/coverage/coverage-summary.json`.

Coverage includes every hand-written `Slopesmith/src/**/*.ts` file; files the suite never imports count as 0%,
and generated TypeScript is excluded. CI places the totals in the job summary and retains the complete HTML/LCOV
report as the `slopesmith-coverage` artifact for 7 days. These totals are informational; CI does not enforce
minimum line, statement, function, or branch percentages.

## Unity importer test and coverage

`Unity/` is a source library rather than a complete Unity project, so its integration test creates and reuses a
minimal disposable project under the ignored `temp/` directory. The command exports the authored-only portion
of Slopesmith's `AUTOTEST1` catalogue, so a clean checkout needs no retail or imported model, then runs the real
`snowknife gltf` and `snowknife unity` seams, syncs `Importer` plus the platform shader sources, launches Unity
in batch mode, and calls the same
`LevelImporter.Import()` used by the editor menu. It fails on importer error logs, missing hierarchy anchors, missing
terrain/collision, missing neutral markers, or missing scripts.

```text
npm run test:unity
```

`npm run test:unity -- GOLD` selects the shorter one-case-per-mechanism regression map; `AUTOTEST1` is the broader
default. Set `UNITY_EXE` or pass `-UnityExe` to the PowerShell script to use a different editor; otherwise it prefers
the importer's tested Unity 2022.3.22f1 installation. Advanced switches such as `-SkipExport` can be passed by
invoking `Unity/tools/test-importer.ps1` directly. No existing Unity project is modified, and the
generated project, staged map, results, and Unity cache all remain under `temp/unity-importer-test/`.

The same run enables Unity's built-in coverage instrumentation and filters sequence points by the
`Assets/OpenSlope/Importer/**` source path. It prints line, method, and sequence-point totals and writes detailed JSON plus
the Unity log under `temp/unity-importer-test/results/`. These figures measure the neutral importer and marker types;
VRChat/Basis wiring and PlayMode ride behavior need separate platform-project tests.

## Warning policy

`Snowknife` and `Snowknife.Tests` treat compiler warnings as errors. Reflection-populated Newtonsoft DTO fields
use narrow, documented `CS0649` suppressions around the DTO declarations; do not add project-wide suppressions.

`SSX-Library` is maintained as a separate submodule and has a pre-existing warning backlog. Its warnings and
analyzers are isolated at the project-reference boundary so they cannot hide a new warning in Snowknife-owned
code. Build the library project directly when working down that backlog.

## Faster component checks

```text
npm run coverage:snowknife
dotnet test Snowknife/Snowknife.Tests/Snowknife.Tests.csproj -c Debug --filter "Category!=EndToEnd"
npm --prefix Slopesmith run typecheck
npm --prefix Slopesmith test                 # fast edit-time tier
npm --prefix Slopesmith run test:integration
npm --prefix Slopesmith run test:full        # required discovered gate
npm --prefix Slopesmith run coverage
npm --prefix Slopesmith run build
npm --prefix Slopesmith run smoke
npm run test:unity -- GOLD
```
