---
name: verify
description: EXCEPTION ROUTE — how to drive the Slopesmith editor in a real browser (Vite + chrome-devtools MCP + the agent layer). NOT the default finish for UI/viewport work. Use only when the user explicitly asks to see the change running in the app, or when the open question is genuinely pixels / 3D picking / a gesture that no check under test/ can assert. Otherwise finish the code, run typecheck + the fast tier, say plainly what is and is not covered, and leave regression testing to the user.
---

# Verifying Slopesmith changes in the running editor

Scope: the **browser editor** only. The Unity importer, snowknife, and ISO/PCSX2
layers need their own checks — this skill doesn't cover them.

## Read this before standing a browser up

**Driving the browser is the exception, not how UI work ends.** The default finish
for a change to the editor is: the code, a check under `test/` where one is
possible, `npx tsc --noEmit`, `npm test`, and a plain statement of what is covered
and what isn't. Then stop. The user regression-tests in their own editor, on their
own mountain, far faster than a fresh browser session can be stood up — a Vite
server, an API service, an MCP-driven Chrome and a document to work in cost
minutes before the first thing is seen, and the tooling itself drops often enough
that the run may not finish at all.

Only come here when one of these holds:

- the user **asked** to see it running, screenshotted, or driven; or
- the open question is genuinely **pixels, 3D picking, or a gesture** — something
  no assertion in `test/` can reach.

"It touches the UI" is not one of those. Neither is wanting extra confidence in
code that already typechecks and has a check: say so and hand it over. And if a
visual question is left open, **name it in the report** — an unverified detail the
user can see in seconds is a fine thing to hand back, and a much better outcome
than a long session spent rebuilding a browser harness to look at it.

When the change is a *keymap*, a document edit, or a pure function, a check under
`test/` is both faster and permanent; `test/paint-turn.test.ts` is the pattern
(capture the listener `installShortcuts` registers, hand it event literals, assert
against the doc helper), and `test/tiled-prop-turn.test.ts` extends it to the
document and bake sides of the same feature. Standing a browser up proves it once.

The editor ships an **agent layer** (docs/029) that mirrors 3D scene entities into
the accessibility tree, so props / rails / gems / lights / ground are addressable
by `uid` like any button. **Do not add debug hooks to `main.ts`** — everything you
need is on `window.slopesmith`. If something is genuinely missing, extend
`src/app/dev/agent-layer.ts`; do not scatter one-off hooks through the app.

## Launch

The dev server is **two processes**: Vite serves the app and proxies `/api/*` to a
separate API service (`vite.config.ts` reads `PORT` for that proxy target). Vite
alone serves an editor with no catalogue behind it — the Texture Library reads
"(dev server only)", the Prop Library is empty, and nothing data-driven works. So
start **both**, on throwaway ports, as two background tasks:

```bash
cd Slopesmith && PORT=5224 npx tsx src/server/main.ts          # the API service
cd Slopesmith && PORT=5224 npx vite --port 5223 --strictPort   # the app + /api proxy
```

Use **throwaway ports** (not 5179/5180): localStorage is per-origin, so the test
doc never touches the real editing doc, and a separate API service keeps the
user's own session's caches and leases out of it.

If either exits with **"address already in use"**, a stale server (NOT Chrome)
still holds it — `curl` it, and if it answers as Slopesmith just reuse it. Killing
Chrome won't free it. If you reuse an API someone else started, expect it to be
serving *their* open project.

**`/api/textures` 409s until a mountain is open** — `NoOpenProjectError`, "No
mountain is open for this editor". It surfaces in the UI as "Start or reconnect
the dev server", which sends you looking for the wrong problem: the catalogue
endpoints need an open project, not a reachable server. Open one from the File
menu's mountain list first, or expect an empty Texture/Prop Library. `init()` runs
once at boot and caches the failure, so fix the cause and **reload** — reopening
the panel will not retry.

Open with `?agent=1`, which turns the agent layer on:

```
new_page → http://localhost:5223/?agent=1
```

Add `&agentdebug=1` to tint the proxies visible (cyan = entity, green = ground
anchor) when you want to *see* what you can address.

Then **confirm the tab**: `evaluate_script(() => location.href)` must echo the
localhost URL. The first call or two after a fresh `new_page` can fail with
"Execution context was destroyed" while the app boots — just retry.

**"The browser is already running"**, or MCP split-brain (`list_pages` reports the
editor tab while `evaluate_script` still sees `about:blank`): run

```bash
pwsh -File scripts/agent-chrome-reset.ps1
```

It kills only Chrome processes whose command line contains `chrome-devtools-mcp`,
leaving an ordinary Chrome session untouched. A *partial* kill leaves the split
state, so let the script finish, then `new_page` again.

## Driving

**Act through real clicks. Observe through `window.slopesmith`.** The API is
read-only on purpose — driving state directly would not exercise the UI, and a
check built that way proves nothing about the app.

`take_snapshot` lists DOM chrome *and* scene entities together:

```
uid=6_29 button "Add gem"
uid=6_71 button "Prop 2: EmptyTest"              ← a 3D prop
uid=6_81 button "Terrain D1 (x 826, y 932, z 978)"  ← a point on the ground
```

- Mode / view buttons are **icon buttons with empty textContent** — match them by
  aria-label ('Edit', 'Props', 'Play', 'Frame map', 'Add light'; view pills
  'Tricks', 'Prop lights', …). Tools-panel buttons ('Add rail', 'Add gem',
  'Prop Library') match by textContent.
- Scene entities are `Prop N: <name>`, `Rail N`, `Gem N`, `Light N`. `pressed` in
  the snapshot means selected. Rail **nodes** appear only while their rail is
  selected, as in the editor.
- The **reference world** is mirrored too: `Ref prop N: <model>` for native
  instances and `Marker <kind>: <model>` for source icons (bulbs / speakers /
  hidden-prop trigger cubes). These follow the camera-settle clock like anchors —
  absent while orbiting, back when the view rests — and carry tight nearest-first
  budgets (`snapshot().agentLayer.refMirror` reports what was cut). Overlapping
  icons resolve nearest-along-ray exactly as they do for a person; if a marker
  click selects the wrong icon, `pickAt` names the winner — zoom in and re-click.
- **Only clickable things get a proxy.** Entities that are off screen, behind the
  terrain, or hidden by a View pill are deliberately absent — a proxy over them
  would dispatch a clean click that selects nothing. The layer says which case
  applies, in `snapshot().agentLayer` (`hiddenKinds`, `occluded`, `truncated`), in
  a labelled note inside the tree, and per-entity via `entities()[].clickable`.
- Ground anchors are `Terrain <cell> (x, y, z)` — the label is where the click
  will land, so pick one deliberately.
- **Panel grids are not in the tree.** Palette cells (`.sc-cell`) and Texture /
  Prop Library swatches are plain divs with tooltips, so `take_snapshot` gives you
  no uid for them and there is nothing to `click`. Read their state from the DOM
  (`.sc-prev` innerText carries the selected tile's name, ride feel and rotation)
  and drive them with `dispatchEvent(new MouseEvent('click', {bubbles: true}))`.
  The Palette also persists to `localStorage['slopesmith-scratch-v1']`
  (`{pads: Cell[][], pad, view}`, 10 pads × 75 cells) — seeding that and reloading
  stages tiles without needing a library, which is the quickest way to get a real
  brush armed.

**Placing something** is arm-then-click, with a hover first (tools raycast the
hover on move and place on the click):

```
click(uid of "Add gem")  →  hover(uid of "Terrain D1")  →  click(same uid)
```

Then `await window.slopesmith.settled()` before reading the doc.

**A click selected nothing?** Don't guess — ask the picker:

```js
window.slopesmith.pickAt(x, y)   // what a click there would actually act on
```

`{target: 'surface'}` where you expected a prop means something is in front of it,
or you aimed at bare ground. Compare its `distance` against the entity's `dist`
from `entities()`. This one call distinguishes occluded / hidden-layer /
mis-aimed, which otherwise look identical.

Gotchas that remain:

- **`drag(a,b)` emits only ONE intermediate move.** Gizmo drags are fine; gestures
  needing a sampled path (the gem tool's drag-to-lay-a-row, freehand sculpt
  strokes) are not expressible and still need synthetic events via
  `evaluate_script`.
- **Anchors vanish while the camera moves** and return ~150 ms after it stops —
  by design, since stale ground coordinates would misplace a click. If
  `snapshot().agentLayer.anchorsFresh` is false, wait a beat and re-snapshot.
- **No anchors at all?** Call `window.slopesmith.diagnose()`. It reports whether
  the ground mesh is present and how many of the sample casts hit. A view of
  mostly sky legitimately yields few anchors; `setAnchors({samples: 24})` helps
  when terrain is a thin ribbon.
- Arming a prop from the library is **async** (a few-MB fetch) — wait for the
  preview card's thumbnail to build (the `.pp-card` element gains the `orbit`
  class) before place-clicks.
- Wheel zoom: dispatch `WheelEvent` on `#viewport` (capture listener),
  `deltaY: -120` per step.
- Vite hot-reloads the page on edit, which **resets the doc and selection** —
  re-establish state after any source change mid-session.

## Observing

`window.slopesmith` (see docs/029 for the full table):

- `snapshot()` — mode, counts, selection, camera, mirror health, last build error.
  One call answers most questions.
- `doc()` — the live document, without the localStorage persist race.
- `settled()` — resolves when the rebuild funnel is quiet. `{rendered: false,
  timedOut: false}` means nothing was pending: quiescent, not failed.
- `entities(kind?)` / `locate(ref)` — what is addressable, and where it is.
- `errors()` — rebuild errors. `state/rebuild.ts` swallows exceptions into `#log`,
  so an empty doc after an action usually means one fired.
- Zero-error check: `list_console_messages` types=[error].

Ground truth for a doc assertion is `slopesmith.doc()`; `#toast` carries the last
status line and the lower-left command sheet reflects mode/state.

## Leave it as you found it

The test origin holds a real document. Undo what you placed (`Control+z` via
`press_key` works and exercises the real undo path), and confirm with
`snapshot().counts` before you finish.
