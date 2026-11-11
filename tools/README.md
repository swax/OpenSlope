# Repository tools

Run shared repository commands from the repository root through `npm run`.
The top-level scripts remain stable entry points; supporting tools are grouped
by the checks they serve.

| Location | Purpose |
| --- | --- |
| `verify.mjs`, `pre-push.mjs`, `affected-suites.mjs` | Full verification, push-time checks, and shared suite selection |
| `native-tests.mjs`, `snowknife-tests.mjs`, `unity-tests.mjs` | Component test and coverage entry points |
| `snowknife-release.py`, `test_snowknife_release.py` | Self-contained Snowknife downloads, matching sources, and packaging checks |
| `format-*.mjs` | Component and repository-tool formatting entry points |
| `python.mjs` | Shared Python interpreter discovery; honors `PYTHON` |
| `actions-usage.mjs` | GitHub Actions usage reports (`npm run actions:usage`) |
| `hygiene.py`, `hygiene/`, `binary-provenance.json` | Publication checks, scanner tests, baseline, and binary provenance |
| `native/` | Native map comparisons, source audit and tests, audio reference checks, and synthetic export fixture |
| `contracts/` | Read-only particle and surface-spray checks against a user-supplied disc image |

Keep a supporting script next to related checks. Add a shared entry point at the
top level only when it is used across the repository. When moving tools, update
relative imports, repository-root discovery, tests, documentation, and workflow
path filters together.

## Everyday validation

A Git-only sync needs checks of the resulting history and preserved local work.
Before committing, inspect the staged patch and check its whitespace. Reuse
successful checks that still cover the current changes; run focused checks when
validation is missing or relevant inputs have changed.

These commands run from the repository root:

```text
git diff --cached --check
npm --prefix Slopesmith test -- --only glb-import
npm --prefix Slopesmith test -- --only blender-bridge
npm --prefix Slopesmith test -- --only public-course-list
npm --prefix Slopesmith test -- --only local-texture-upload.test.ts
npm --prefix Slopesmith run test:dom
npm --prefix Slopesmith run test:api
npm --prefix Slopesmith run test:browser
npm --prefix Slopesmith run typecheck
npm --prefix Slopesmith run lint
```

The named tests are examples: choose the checks for the behavior being edited.
`--only` reaches matching checks in either tier, including integration tests.
A complete `.test.ts` filename selects exactly that file; an area name is a substring filter.
For wider Slopesmith changes, `npm --prefix Slopesmith test` runs its fast tier
without coverage or the full browser suite. Use Native or Snowknife checks when
those components or their shared contracts are affected.

`npm --prefix Slopesmith run check` combines type checking, lint and the fast tier.
`check:smoke` also runs the small browser smoke lane. Use the browser lane when a change
affects native form submission, navigation, rendering, image decoding or browser persistence.
DOM checks run actual UI modules with happy-dom and fake-indexeddb; they do not require Vite or Chrome.
For a focused test that should rerun when its imports change, run it directly in Node watch mode:

```text
cd Slopesmith
node --watch --import tsx test/prop-adopt.test.ts
```

Run the compiler watcher in a separate terminal from `Slopesmith/`:

```text
npm run typecheck -- --watch
```

TypeScript stores incremental state and ESLint stores a content-based cache under ignored
`Slopesmith/temp/`. Both commands still check the complete configured scope, and changed inputs
invalidate their cached results. A clean checkout runs the same checks without warm caches.

For broad component verification, `test:node` runs all Node/DOM/API tests and `coverage`
adds V8 instrumentation to that lane. The release gate, `test:ci`, and nightly CI use
the small browser smoke lane. The complete browser suite is an on-demand diagnostic;
it does not block commits, pushes or releases. No assertions have been deleted.

Run diagnostics explicitly from the repository root:

```text
npm run diagnose:browser
npm run diagnose:browser -- --only folder-workspace.test.ts
npm run diagnose:browser -- --list
```

`Slopesmith browser diagnostics` in GitHub Actions is manual-only and accepts the same
optional filename or area in its `only` input. It keeps failed checks visibly failed
and uploads incremental results and per-test logs; it is separate from required CI.
`test:browser:full` remains the component-level equivalent. `test:full` and `test:local`
are comprehensive diagnostics that also include the slow browser checks.

Each runner invocation prints its `Slopesmith/temp/test-run-*` directory. `results.json`
records completed, active and pending checks after each outcome; per-test logs update live.
The runner prints active tests every 30 seconds and stops its own process trees on cancellation
or a per-test deadline. The outer verification tool also terminates descendants on a timeout.
`npm --prefix Slopesmith test -- --retry temp/test-run-<id>` runs only failed, interrupted
and pending checks from that run. This is a focused retry, not a new full-gate result;
new tests and previously passing tests are outside that selection.

`npm run verify` retains the complete repository gate for release preparation,
broad changes across components or shared contracts, and explicit full-validation
requests. The existing pre-push hook and CI still run their mandatory checks;
the nightly workflow runs Node coverage, browser smoke and the export smoke test. Use
`npm run verify -- --list` to inspect the gate without executing its checks. A
documentation-only change does not require a compiler or browser run.

## Formatting

Install Slopesmith's locked dependencies and the pinned Python formatter once.
Use an activated Python virtual environment for the Python dependency, or set
`PYTHON` to that environment's interpreter when running the npm commands.

```text
npm ci --prefix Slopesmith
python -m pip install -r tools/requirements-format.txt
npm run format:tools
npm run format:tools:check
```

JavaScript and TypeScript use Slopesmith's existing Prettier configuration.
Python uses [Ruff](https://pypi.org/project/ruff/0.14.14/), pinned in
`requirements-format.txt` and configured in `ruff.toml` with a 120-column line
length and LF line endings. Both commands cover the entire `tools/` tree;
`format:tools:check` checks without writing. Data manifests and the hygiene
baseline are maintained by their owning checks rather than the formatter.
Ruff is optional for running verification: the hygiene checks still use only
Python's standard library.

Java uses the pinned `prettier-plugin-java` from the same Slopesmith dependency
installation. Run these commands from the repository root:

```text
npm run format:java
npm run format:java:check
```

They cover `Native/android/app/src/**/*.java`, `Native/tests/**/*.java` and
`Native/tools/**/*.java`, excluding Android build output. The Native Prettier
configuration sets four-space indentation, a 120-column print width and LF line
endings. The check command does not write files. Neither command invokes Gradle
or requires a JDK or Android SDK. See [Native formatting](../Native/docs/development.md#formatting).

## Supporting checks

```text
npm run verify:native
node --test tools/pre-push.test.mjs
node --test tools/native/native-source-audit.test.mjs
python tools/native/native-compare-maps.py <native-course> <reference-course>
python tools/native/native-compare-props.py <native-course> <reference-course>
python tools/native/native-compare-paths.py <native-course> <reference-course>
python tools/native/native-compare-rails.py <native-course> <reference-course>
python tools/native/native-compare-collision.py <native-course> <reference-course>
python tools/native/native-compare-logic.py <native-importer-executable> <native-maps> <reference-maps>
python tools/native/native-compare-sky.py <native-course> <reference-course>
python tools/contracts/check-particle-contract.py <user-supplied-iso>
python tools/contracts/check-surface-spray-contract.py <user-supplied-iso> --importer <native-importer-executable>
```

The audio reference checks and export fixture load Slopesmith's public APIs.
Run these from `Slopesmith/` so Node can resolve its installed `tsx` loader:

```text
node --import tsx ../tools/native/board-audio-reference.mjs <native-board-audio-test-executable>
node --import tsx ../tools/native/music-playback-reference.mjs
node --import tsx ../tools/native/authored-audio-export-fixture.mts <output-directory> [--music]
```

The Native tests call the synthetic audio fixture directly. Comparison scripts
use generated course folders; the optional contract checks require local disc
data and are separate from the disc-free verification gate.
