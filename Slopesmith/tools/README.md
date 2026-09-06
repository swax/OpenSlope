# Offline tools

Reusable authoring, analysis, asset-conditioning, and reverse-engineering utilities live here. Run Node
commands from `Slopesmith/` unless a command shows a repository-root path.

Course packages may import these modules. Tools may import shared implementation from `src/`, but they must not
depend on a particular `courses/<name>/` package. Course-owned geometry, renderers, source data, and asset recipes
stay with their course.

| Area | Purpose | Main entry point |
|---|---|---|
| [`character-models`](character-models/README.md) | Rider preparation and validation, and the generated built-in characters | `npx tsx tools/character-models/check.ts <model.glb>` |
| [`course-authoring`](course-authoring/README.md) | Shared project publishing, prop measurement, and sky conditioning | imported by course scripts |
| [`course-analysis`](course-analysis/README.md) | Retail/authored route comparison | imported by course renderers |
| [`generate-icons`](generate-icons/README.md) | Rebuild public brand and application icons | `python tools/generate-icons/makeicons.py` |
| [`generate-terrain`](generate-terrain/README.md) | Fetch and build georeferenced ski-mountain height maps | `python tools/generate-terrain/openslopegen.py mammoth` |
| [`mountain-study`](mountain-study/) | Measure retail terrain vocabulary and candidate mountains | `npx tsx tools/mountain-study/score.ts` |
| [`ride-study`](ride-study/README.md) | Trace the ported ride model and grade it against retail | `npx tsx tools/ride-study/jump-trace.ts kicker` |
| [`reference-study`](reference-study/README.md) | Census and validate against what the shipped levels actually contain | `npx tsx tools/reference-study/ref-lighting.ts` |
| [`prop-recipes`](prop-recipes/README.md) | Build and validate reusable low-poly props | `python tools/prop-recipes/check.py` |
| [`texture-recipes`](texture-recipes/README.md) | Build deterministic terrain pages | `python tools/texture-recipes/check.py` |
| [`texture-conditioning`](texture-conditioning/README.md) | Condition generated bitmap candidates into tileable pages | `python tools/texture-conditioning/test.py` |
| [`retopology`](retopology/README.md) | Prepare, run, score, and integrate retopology candidates | `npm run benchmark:retopology` |
| [`re-canaries`](re-canaries/README.md) | Author runtime probes for unresolved engine behavior | `npx tsx tools/re-canaries/make.ts` |
| [`prop-budget.ts`](prop-budget.ts) | Compare project prop cost with retail levels (same census as Scene ▸ Reference ▸ compare every mountain) | `npm run budget` |
| [`generate_ride_contract.py`](generate_ride_contract.py) | Regenerate runtime views of the shared ride contract | `python tools/generate_ride_contract.py --unity --check && npx tsx test/ride-contract.test.ts` |

Keep this tree shallow: a workflow gets a directory when it owns several files or reusable modules; a single
command can remain at the root. Directory names use lowercase kebab-case.
