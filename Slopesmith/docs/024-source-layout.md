# 024 — Source Layout

Where code lives and why. Three top-level layers, strictly ordered: `core` imports nothing
from the other two, `app` imports `core`, `server` imports `core`. Nothing imports `app`
except the browser entry (`index.html` → `src/app/boot.ts`, which asks the server who this
browser is and then loads either `src/app/main.ts` or the login page — docs/038), and
`server` runs in its own Node process, so its modules never enter the client graph at all.
Filenames are kebab-case throughout.

## `src/core` — pure domain logic

No DOM, no Three.js scene, no fs. Everything here runs in the browser, in node (scripts,
server), and in the test harness alike, grouped by domain:

- **`math/`** — primitives everything else stands on: `scalar`, `color`, `vec`, `segment`,
  `spatial-hash`, `bezier` (bicubic patch evaluation), `spine` (Catmull-Rom centerline
  sampling, arc length).
- **`doc/`** — the authored document: `types` (the shared vocabulary: `V3`, surfaces,
  `QuadMeshDoc`), `mountain` (control net → derived quilt, generators, migration),
  `doc-edit` (vertex/quad-addressed editing accessors).
- **`mesh/`** — the general quad mesh and its surgery: `primitives` (flat vertex buffers,
  edge keys and quad perimeter order), `edge-curves` (shared cubic-edge diagnostic input), `topology` (mesh topology +
  adjacency), `surface` (face loops / cell blocks), `ops/index` (the public surgery API —
  a barrel over one module per op family: loop-cut, edge-rip, dissolve, weld,
  surface-cut, edge-extrusion, cell-edge-insert, append, delete, plus `contract` for shared
  op plumbing), `selection` (selection queries), `clipboard`, `control-points` (stable CP
  identity), `slide` + `slide-gesture` (de Casteljau re-cut slides), `loft`, `measure`
  (metric read-outs), `tessellation` (quilt → render arrays at bake resolution,
  `PREVIEW_RES`), `flow` (quad-meshes a trail network graph — runs with centrelines and
  widths meeting at nodes — into a `Sheet`: ladders along runs, wyes where runs share
  ground out of a node, junction patches around a centre pole, caps at trail ends; the
  graph-driven counterpart to `sheet`'s lattice-region mesher, over `flow-corridors` and
  `flow-plane`).
- **`mesh/retopology/`** — replacing a region's topology wholesale. `contour` owns the
  built-in "Elevation loops" strategy as a downward-layered pipeline (`contour-raster` →
  `contour-levels` → `contour-knit` → `contour-repair`, with `contour-join` off the levels
  stage); `integrate` merges a chosen candidate with protected authored terrain over the
  stage modules its probes replay one at a time (`integrate-cut`, `integrate-nudge`,
  `integrate-surface-fit`, on the `integrate-boundary` / `integrate-shape` leaves).
- **`collision/`** — `lab` (the ride-model collision bench) and `autotest`, which builds a
  graded course from the fixture catalogue in `autotest-cases`. The split is data from
  machinery: `autotest-cases` describes the cases, `autotest` builds a mountain out of them.
- **`props/`** — what a placeable prop is: `imported` (the GLB record, cap and emitter/spin
  declarations), `pose` (placement rotation maths), `glb-decode` / `glb-encode` (the
  dependency-free glTF reader and writer), `contact`, and `kind` — the one place the
  editor's two prop words are defined, so the selection panel, the prop library and the
  Blender add-on all describe a prop the same way (docs/028, docs/032).
- **`paint/`** — texture paint: `textures` (tile refs + brushes), `orientation` (D4 tile
  orientation), `ground-textures` (procedural tiles for authored levels).
- **`lighting/`** — `lightmap` (baked-lightmap study, sun recovery), `bake`
  (authored sun → lightmap pages), `occlusion` (shadow / AO maps), `sign-lights` (authored
  sign + free lights), `glints` (which lights draw the engine's runtime sparkle, and at what
  colour and size — the data half of docs/047, shared by the authored rig and a reference's).
- **`particles/`** — `volumes` (native PBD particle volumes) and `snowfall` (the ambient-snowfall law,
  tuning and bake — the data half of docs/050, and the specification its vertex shader implements).
- **`reference/`** — read-only loaders for an extracted level: `terrain`, `props`, `lights`,
  and `groups` (mined assemblies).
- **`rails/`** — grind rails: `rails` (node chain → Bézier segments), `rail-mesh` (the
  swept visual tube + posts).
- **`blender/`** — `portal`: the mesh interchange the Blender round trip speaks in both directions
  (docs/046), over `props/glb-encode` (the dependency-free GLB writer, mirror of `props/glb-decode`).
  Its own folder rather than a file under `props/` because it converts BOTH libraries — the
  authored quad cage in `doc/` and the imported record in `props/` — and belongs to neither.
- **`export/`** — `map` (EditDoc → the authored level folder snowknife consumes),
  `preflight` (classify painted tiles against an export target).

## `src/app` — the browser editor

`boot.ts` is the entry: it asks `net/account.ts` who this browser is and then either calls
`enter-editor.ts` (which imports `main.ts`, and importing it IS booting the editor) or shows
`ui/chrome/login-page.ts` instead. `main.ts` is the compose root: it owns the document, builds
every service and panel in dependency order, and wires them together. `viewport-callbacks.ts`
translates viewport events into app ops (the `ViewportCallbacks` factory); `shortcuts.ts`
installs the keyboard map. Subsystems by feature:

- **`state/`** — `store` (the shared mutable editor state), `history` (debounced undo/redo),
  `rebuild` (the mutation → render funnel), `storage` (localStorage persistence). The store is
  also the mesh-selection substrate the viewport reads and writes directly — it satisfies
  `MeshSelectionState` (viewport/types.ts) structurally, so the authored corner / cell / edge /
  hidden selections and the reference vertex / edge / patch picks each have ONE owner instead
  of a store field plus a viewport mirror.
- **`viewport/`** — the 3D scene platform. `viewport.ts` is the host and `stage.ts` owns the
  renderer/cameras/root scene; `coordinates.ts` names the data↔scene chirality conversion. The rest is grouped by responsibility: `input/` (pointer
  routing, typed nearest-entity picking, screen-space mesh picking, placement constraints), `camera/` (navigation and view
  grid), `gizmo/` (transform gestures, curved arrows, geometry, readout), `mesh/` (terrain,
  cage, selection, paint and tile materials), `tools/` (topology/placement previews),
  `scene/` (props, lights, `video-billboard` — the browser-local DOM decoder/VideoTexture source from docs/063,
  `screens` + pure `screen-presentation` — every authored/reference video quad and the independent playback
  versus Sources visibility policy,
  `glints` — the shader half of docs/047, one instanced quad per
  sparkle over `core/lighting/glints` — `snowfall`, the shader half of docs/050 over
  `core/particles/snowfall`, rails, gems, ride and reference decoration — `reference-decor`
  and `reference-effects` each keep their live scene registry and per-frame loop, with the
  argument-in/value-out parts beside them in `reference-decor-pose`, `reference-decor-course`,
  `reference-effects-nodes` and `reference-effects-motion`; what a PROP sounds is `prop-sound`
  over `ambient-sound`, because both of a placement's audio channels — the `CollisonSound`
  one-shot and the `ExternalSounds` bed — are native instance data driven by one contact in an
  order that matters, so `reference-effects` dispatches contacts into it and keeps only the
  shared audio graph its own PlaySound nodes need), and `shared/`
  (overlay primitives and legends). Files inside those folders drop the redundant `-layer`
  suffix because the path already supplies their role.
- **`edit/`** — Edit-mode workflows over the store: `session`, `topology`, `clipboard`.
- **`paint/`** — Paint mode's panels: `library` (the bottom panel of extracted tiles),
  `palette` (the Tools-panel staging pad), `glyph` (the orientation F overlay), `drag-drop`
  (drag MIME types between the two).
- **`props/`** — Props mode: `library`, `preview`, `textures`, `thumb-renderer` (framed
  model views), `multi-select-list`, `operations` (the placed-prop
  domain ops: geometry caches, arming/placement, deletes, the authored light rig).
- **`effects/`** — Effects mode: portable graph/list editor, semantic/raw inspector,
  stable prop-slot attachments, validation, templates, spatial emitter handle, and the read-only
  authored-mountain/reference graph + native attachment browser. `editor` is one factory
  closing over the mode's live selection; `editor-widgets` holds what that closure does not
  touch — the DOM constructors, node labellers, and template table.
- **`tricks/`** — `operations` owns rail + gem arming, deletes, and the Add-tools row.
- **`ride/`** — the in-editor playtest: `session` (host), `physics` (ported ground model at
  fixed 60 Hz, over `physics-tuning` for the constants and their provenance and
  `physics-math` for the stateless surface/contact arithmetic — the tick itself stays in
  `physics`, because its evaluation order is what the retail traces pin down), `camera`,
  `hud`, `input`, `rider` (board + figure), and `play` (setup/launch).
- **`reference/`** — `session` owns reference-world loading, lighting study, layer toggles, and the async
  `Effects.json`/legacy-graph handoff to Effects mode.
- **`ui/`** — DOM chrome grouped as `chrome/` (top bar, tools/scene panels, command sheet,
  dialogs), `components/` (controls, gui helpers, icons, toast, tooltip, bridge rail list),
  and `tool-panels/` (per-mode toolbox builders and their shared widgets). `chrome/users-mode` places the
  shared video Jukebox directly below its member roster, delegates queue transport to the session channel,
  and seats the viewport's browser-local decoder in the panel while outside a ride.
- **`net/`** — typed browser transport helpers shared by feature loaders. `video-bridge` is the direct-browser
  Yattee boundary from docs/063: origin validation, Basic Auth, connection testing, video resolution, and
  playable-stream selection stay there rather than leaking protocol details into the viewport or Settings UI.
- **`styles/`** — the editor's CSS, loaded by `<link>` from `index.html` in cascade order:
  `base` (tokens, `html/body`, `#viewport`), then `dock`, `toolbar`, `menus`, `modals`, `effects`,
  `overlays`, and `responsive` last so its media blocks win. Order is load-bearing — the files are a
  split of what was one stylesheet, not independent modules. They are `<link>`ed rather than imported
  from `main.ts` so the stylesheet is not deferred behind the module graph on first paint.

## `src/server` — the API service

A standalone Node process, `npm run serve`, bound to loopback unless `--host` says otherwise.
`main.ts` binds the socket and starts the maps watch; `app.ts` matches a request path to a
mount and hands off. Routes live one module per area in `api/` (workspace, characters, music,
export, levels, textures, props, skybox, blender) over the readers and writers in `routes/` (levels,
textures, props, groups, export, preflight, png, blender). `api/common.ts` holds what every route
module needs: body reading, JSON replies, the cache lifetime the user-asset byte routes send, and the two
cache-invalidation scopes `api/maps-watch.ts` calls when the map library changes. `safe-name` owns the
extracted-data path-segment normalization used by every reader, plus `storeUnderFreeName` — the one place
an uploaded asset picks the name it lands under, so no upload path can overwrite a name that is taken — and
`retireName`, which every delete goes through so a freed name is never issued to a second asset.

## `test` — fast feedback and the gate

Every file is `<area>.test.ts`, asserts, and exits non-zero on failure. `test/run.ts` DISCOVERS
them: the glob is the **full** gate, so a new check joins CI by existing. The tier is declared in the check
itself: a `// tier: fast` marker on the first line puts it in the edit-time loop, and a file without one is
in the integration tier. A new check therefore defaults to integration, which means it cannot silently make
the edit-time loop slower, while it still cannot disappear from the required gate — and there is no list in
the runner to keep in step with the directory. This is deliberately different from the old per-check npm
scripts: there remain only three stable tier commands, and `test:full` still reaches every discovered check.

Anything in `test/` that is NOT itself a check lacks the `.test.ts` suffix, which is what keeps the glob from
executing a helper as a check. Shared fixtures end in `.fixture.ts` (`meshops.fixture.ts`,
`prop-shader-webgl.fixture.ts`); shared helpers are named for what they provide — `check.ts` is the
`ok`/`FAIL` tally and exit-code convention every counting check imports, `http-test-support.ts` stands up the
API service, `browser-test-support.ts` finds the installed Chromium the WebGL checks drive.

```
npm test                          # quick, deterministic edit-time feedback
npm run test:integration          # server/socket/browser and CPU-heavy checks
npm run test:full                 # everything a fresh clone can run — what CI runs
npm run test:local                # the full tier plus extracted Maps/ checks
npx tsx test/run.ts --only ride   # one area from either tier, while iterating
npx tsx test/run.ts --tier fast --list # what the fast tier would run
npx tsx test/run.ts --tier full --list # the complete discovered gate
```

The fast tier lives in the checks themselves (the `// tier: fast` marker). `test/run.ts` keeps only the
constraints a file cannot express about itself: checks needing extracted `Maps/` data (excluded unless
`--local`, because a clean clone has none), checks that must not run alongside a named sibling, and checks
that must run alone. A stale name in any of those fails the run rather than silently doing nothing. `run.ts`
remains the single answer to "what does the gate run?" and is not itself `*.test.ts`, so it never sweeps
itself up.

The tree mixes focused checks with integration checks that stand up the API service, a WebSocket room or a
headless browser; several span the whole pipeline rather than one module. Keeping both in one discovered tree
lets the full gate enforce the same coverage boundary while the tier metadata controls feedback time.
`.c8rc.json` scopes coverage to `src/**/*.ts` alone. `eslint.config.mjs` at the Slopesmith root is the lint
gate (`npm run lint`, zero findings, run by `tools/verify.mjs`, the pre-push hook and CI right after the type
check); its header states every non-default decision, including that `test/` and `tools/` may use `any` while
`src/` and `scripts/` may not.

Checks in any tier run **up to six at a time** — one per core, capped at six, and `--jobs` overrides — which is
deliberately well under the core count: the
gate's wall clock is pinned by its longest single check, so the idle cores buy no speed and instead keep
the checks that wait on sockets and debounce windows off their deadlines. Resource groups in `run.ts` keep the
three checks that share the accounts store and library cache from overlapping each other, and likewise prevent
the two real-browser SwiftShader checks from launching browsers together. The one socket check known to fail on
a saturated machine briefly runs alone; the long CPU check already pins the full tier, so this reliability does
not normally add to its wall clock.

`npm test` is the normal browser-edit loop. With `npm run typecheck` and `npm run build`,
`npm run test:full` is the bar every change must pass; `npm run verify`, from the repository root, invokes
that full tier with coverage.

## `scripts` — dev, build, and ops

Entry points that run the project or act on its data, and nothing else. `dev.ts` is `npm run dev`: it
starts the API service, then Vite on 5179 proxying `/api` to it, so a Vite restart leaves the service and
everything it holds alone. Alongside it: `build-server.mjs`, `coverage-summary.mjs`, `export-project.ts`,
`auto-test-map.ts`, `autotest-play-suite.ts`, `smoke.ts` (a real `snowknife gltf` bake — needs the binary,
so it is not in the gate), `snowknife-cli.ts` (locates that binary for everything that shells out to it),
`fix-imported-winding.ts` (reports inside-out imported-prop records and, with `--apply`, rewrites them in
place), and `agent-chrome-reset.ps1` for the browser-verify skill.

A diagnostic that only prints is not a script — it is a tool, and it lives under `tools/` with the
workflow it diagnoses. `fix-imported-winding.ts` is here precisely because it is the one that WRITES.

## `tools` — offline authoring and analysis

Reusable commands and libraries that are not part of the editor runtime live under `tools/`. Multi-file
workflows own lowercase kebab-case directories; single commands may remain at the root. Asset recipes and
conditioning, terrain studies, retopology, character preparation, and reverse-engineering probes are indexed in
[`tools/README.md`](../tools/README.md).

`tools/course-authoring/` is the shared seam for authored-course publishers: project persistence/export, custom
sky conditioning, and imported-prop measurement. `tools/course-analysis/` owns offline route comparison.
Retopology commands, runner configuration, separately licensed QuadWild patches, and the three job-directory
replay probes stay together under `tools/retopology/`.

Diagnostics live beside the subject they measure rather than in one drawer of their own:
`tools/ride-study/` traces the ported ride model over synthetic geometry and grades the board-audio port
against retail; `tools/reference-study/` measures what the shipped levels actually contain, so a guessed
constant can be checked against retail's own baked output instead of shipped twice. Both print for a
person to read. `jump-trace.ts` is the single exception that also carries an `assert` mode, which
`test/run.ts` invokes for both jump shapes.

## `courses` — local authored course packages

Course-specific work does not belong in the shared `docs/`, `scripts/`, or `tools/` namespaces. Each authored
course lives under `courses/<name>/` with its own `docs/`, executable `scripts/`, generated `concepts/`, and
original `sources/`/`data`; optional `textures/` and `props/` hold map-owned recipes and committed models.
Course scripts may import reusable operations from `tools/course-authoring/`, while their layouts, source data,
renderers, and asset ownership remain local. The repository root ignores `Slopesmith/courses/`; reusable code
graduates into tracked `tools/` instead of making local course content part of the published source tree.
Capitalized `Maps/` remains the ignored extracted/exported game-data library.
