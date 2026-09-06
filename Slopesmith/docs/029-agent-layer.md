# 029 — The agent layer

Making the editor drivable by an automated browser client (chrome-devtools MCP) without that client editing
app source, forging input events, or bypassing the UI it is supposed to be testing.

## The constraint that shapes everything

chrome-devtools MCP has exactly two ways to see and touch a page:

- **`take_snapshot`** builds its tree from the **accessibility tree**.
- **`click` / `hover` / `drag`** take an element **`uid`** from that snapshot. There is **no coordinate
  form** — you cannot ask the MCP to click at (620, 520).

Slopesmith's viewport is one WebGL canvas, which is one opaque a11y node. So every prop, rail, gem and light
in the scene is **unaddressable**: an agent can see the top bar and the Tools panel, but the entire 3D scene
is invisible to it and untouchable by it.

That single fact produced every symptom we had. Agents fell back to `evaluate_script` with hand-built
`PointerEvent`s, which needs `setPointerCapture` stubs, a hand-forged `button: -1` on moves, a
pointermove-before-click, and devicePixelRatio math that differs per display. And because `store` / `viewport`
are module-locals in `main.ts`, reading state meant adding a temporary `window.__dbg` hook — which the old
verify skill explicitly instructed, so it kept reappearing in diffs.

## The mechanism

**A `pointer-events: none` element still appears in the accessibility tree, but is transparent to
hit-testing.**

So the layer mirrors each interactive scene entity as a transparent DOM node with `role=button` and an
aria-label, positioned at the entity's projected screen point. The MCP sees it in the snapshot and can click
it by uid — and because the node cannot be hit, the click the MCP dispatches at its centre lands on the
**canvas beneath**, as a real browser event.

Measured, on a proxy over the canvas:

| MCP call | what the canvas receives |
|---|---|
| `click(uid)` | trusted `pointerdown`/`pointerup`/`click` at the node centre, `button 0`, `buttons 1→0`, real `pointerId` |
| `hover(uid)` | trusted `pointermove`, **`button: -1`** |
| `drag(a,b)` | full gesture: move → down → move (`button -1`, `buttons 1`) → up → click |

`isTrusted: true` throughout, coordinates in CSS pixels. The browser generates natively every property the
old synthetic recipe forged by hand, and the events flow through the genuine pointer router and raycast
picking. **Fidelity is higher than the synthetic path it replaces, not lower.**

Known limit: `drag` emits only ONE intermediate move, so gestures that need a sampled path — the gem tool's
drag-to-lay-a-row, freehand sculpt strokes — are still not expressible. Those remain `evaluate_script` work.

## The two rules

1. **The layer never mutates editor state.** It projects, labels, and reports. There is deliberately no
   `setMode()` in the API: an agent that calls it directly is not testing the button, and a regression suite
   built on that proves nothing about the UI. **Act through real clicks; observe through the API.**
2. **Caps are never silent.** When the entity budget truncates the mirror, the count is reported by
   `snapshot()` *and* by a labelled node in the tree, so a partial view cannot read as a complete one.

## What gets mirrored

Entities come off the **document** (`mdoc.props / rails / gems / lights`), not the viewport's layer
internals — the doc is the same ground truth the renderer consumes, and it holds coupling down to
`dataToWorld` + `camera`.

| kind | ref | notes |
|---|---|---|
| `prop` | `prop:12` | aims at the **bounding-sphere centre**, not the doc anchor |
| `rail` | `rail:3` | aims at a **node**, not the centroid; zero-node rails are skipped |
| `railnode` | `railnode:3.1` | only while that rail is selected, as in the editor |
| `gem` | `gem:0007` | the gem's own document id, so a ref outlives a delete above it |
| `light` | `light:0002` | likewise the light's |
| `terrain` | `terrain:C2` | ground anchors — see below |
| `refprop` | `refprop:96` | native reference instance, keyed by Instances.json index — see below |
| `marker` | `marker:reference:prop:0` | source-marker icon (bulb / speaker / hidden-prop cube) |

`aria-pressed` mirrors selection, so an agent reads what is selected straight out of the snapshot.

### The reference mirror

The reference world has no authored doc to enumerate, so `refprop` and `marker` read straight off the
rendered layers — the same `InstancedMesh` / `Points` state the picker raycasts. Two differences from the
doc entities:

- **They run on the anchor settle clock**, not the dirty frame. A retail level ships thousands of native
  instances; walking them per orbit frame is the one cost this layer must not pay. Like anchors, they drop
  while the camera moves and return when it rests.
- **Tighter budgets** (nearest 60 instances + 60 markers), because a retail level would otherwise bury the
  tree. Overflow is counted in `snapshot().agentLayer.refMirror` and in a second labelled tree note.

Hidden instances (zero-scale matrices — triggers, reset zones, junk twins) are skipped from `refprop`; they
are exactly what the `marker` mirror addresses instead, via the Sources-view hidden-prop cubes. The marker
clouds publish per-index model names and source indices in their `userData`
(`sourceLabels` / `sourceSourceIndices`, set by reference-decor), which is what turns `Marker prop 3` into
`Marker prop: Mdl_FWTrigger_1000 (reference)` and lets `aria-pressed` track the selected instance.

Markers skip the terrain-occlusion filter — they draw (and click) x-ray by design. What they do NOT skip is
**icon-vs-icon overlap**: at a wide framing two icons can share a pixel, and the real click resolves
nearest-along-ray, exactly as it does for a person. Measured: a trigger cube behind a light bulb selected
the light. `pickAt` reports the winner; the fix is the editor's own — zoom in.

### Aiming: the anchor is not the target

A placement's `pos` is its **anchor**, which for most models sits on the ground at the model's foot. A proxy
there overlays bare terrain, and the click selects the *ground*. Measured: clicking a path-marker's anchor
left `selectedProp` null, while a prop whose geometry happened to straddle its origin selected fine. Props
therefore aim at `propWorldSphere(id).center`.

Rails had the same shape of bug for a different reason: the tube follows a Catmull-Rom spline **through** the
nodes, so on a bent rail the node *centroid* sits off the curve entirely. Rails aim at a control point.

## Keeping the mirror honest

A proxy for something you cannot actually click is worse than no proxy: the node looks addressable, the click
dispatches cleanly, and nothing happens — silently. Three filters, each of which cost a real debugging
session to find:

1. **Hidden layers.** The View pills gate whole layers — 'Tricks' hides rails *and* gems together, 'Props'
   hides placements, and 'Sources' hides free-light markers — and a hidden layer is not pickable. Kinds present in
   the doc but hidden are dropped from the mirror and named in `snapshot().agentLayer.hiddenKinds`.
2. **Terrain occlusion.** An entity behind the ground is dropped. Found on a rail whose nodes had ended up
   under the surface: the proxy sat at 326 m while `pickAt` reported terrain at 204 m, and every click on it
   did nothing. The test reuses the cached anchor BVH — a tree descent per entity, with a 1 m margin so an
   entity resting *on* the ground cannot occlude itself through float noise.
3. **Off screen.** Behind the camera or outside the frustum.

All three are **reported, never silent** — counted in `snapshot()`, described in a labelled note inside the
tree, and reflected per-entity by `entities()[].clickable`.

### Terrain anchors

Selecting an entity only needs that entity addressable. **Placing** one needs an addressable patch of empty
ground, and the MCP cannot click a bare coordinate — so without anchors an agent can inspect a scene but
never build one.

Anchors are screen points raycast onto the ground mesh; each hit becomes a proxy whose label carries the
data-space landing point (`Terrain D1 (x 826, y 932, z 978)`), so an agent aims deliberately instead of
clicking blind. Two calibrations, both learned the hard way:

- **Sample densely, publish sparsely.** Terrain is often a diagonal ribbon rather than a full-frame surface.
  A 4×4 grid measured **0 hits out of 16** on a framed map whose centre cast hit fine — the grid fell through
  the gaps. The layer now casts 16×16 and keeps an evenly-strided subset (default ≤20).
- **A BVH is not optional.** Stock `THREE.Raycaster` against this ground mesh (~93k triangles with
  per-texture render groups) measured **~3 seconds for 100 casts**. The layer caches its own `MeshBVH` twin
  on the same recipe as `viewport.buildGeometryBVH`: **2974 ms → 1 ms**, with a ~140 ms one-time build.

Anchors recompute only after the camera holds still for 150 ms, and are **dropped** while it moves —
publishing stale ground coordinates would send a click to the wrong patch. Doc entities re-project on every
dirty frame, which is pure matrix work.

## The observation API — `window.slopesmith`

| call | returns |
|---|---|
| `snapshot()` | mode, doc name, counts, selection, armed prop, camera, mirror health, last build error |
| `entities(kind?)` | every entity with `ref`, `label`, screen point, distance, `selected`, `occluded`, **`clickable`** |
| `locate(ref)` | one entity by ref |
| `doc()` | the live document, clone-safe |
| `settled(ms?)` | resolves when the rebuild funnel is quiet |
| `errors()` | rebuild errors the funnel's boundary swallowed |
| `pickAt(x, y)` | **what the editor's own picker resolves at a point** — what a click there would act on |
| `diagnose()` | why the ground may not be addressable: mesh state, sweep hit count, timings |
| `refresh()` | force a full re-sync including anchors |
| `setAnchors({samples,max})` | tune anchor density |

`pickAt` is the debugging tool of choice when a click "did nothing". Occluded, sub-pixel, hidden-layer and
bare-terrain outcomes are indistinguishable from outside, and identical in `snapshot()` — but they differ
here. It runs the same queries Props mode runs **in the same order — source icons first** (a deliberate
icon click wins even over nearer world geometry), re-seating the shared raycaster exactly as a pointer
event does, and selects nothing. A `{target: 'source', sourceKind: 'light'}` where you aimed at a prop
marker means an overlapping icon wins that pixel — zoom in.

`settled()` matters more than it looks. `state/rebuild.ts` coalesces a burst of edits into one render on the
next animation frame, so an agent reading straight after an action races the rebuild. `{rendered: false,
timedOut: false}` means **nothing was pending** — a normal, quiescent answer, not a failure.

## Gating

Off unless **both** `import.meta.env.DEV` and `?agent=1`. Normal dev sessions pay nothing. The module is
dynamically imported, so `import.meta.env.DEV → false` lets the minifier drop it: a production build emits
**one chunk with zero agent-layer strings**. Add `&agentdebug=1` to tint proxies visible (cyan = entity,
green = ground anchor) for eyeballing what an agent can actually address.

## Host seam

Three lines in `main.ts`: the gated dynamic import, `agentLayer?.onRendered()` at the end of `renderDoc`, and
`agentLayer?.onBuildError(e)` in the rebuilder's error boundary. Nothing else in the app knows it exists.

## Files

- `src/app/dev/agent-layer.ts` — the whole layer
- `scripts/agent-chrome-reset.ps1` — kill only the MCP-owned Chrome, leaving personal Chrome alone
- `.claude/skills/verify/SKILL.md` — the driving procedure
