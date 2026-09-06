# 046 — Blender bridge

The escape hatch: when a piece of geometry is easier somewhere else, take it there and bring it back onto the
same model. Not an export format and not a migration — a **round trip** whose defining property is that the
thing you edited is the thing that updates. Same model number, same name, every placement of it on the
mountain follows, and every effect attached to those placements stays attached.

Code: `src/core/blender/portal.ts` (the interchange shape and both conversions), `src/core/props/glb-encode.ts`
(the GLB writer), `src/server/routes/blender.ts` + `src/server/api/blender.ts` (the service half),
`replaceCustomTextureArt` in `src/server/routes/textures.ts` (where a pushed tile lands),
`blender/slopesmith_bridge.py` (the add-on), `src/app/props/blender-bridge.ts` + `applyBlenderCage` in
`src/app/main.ts` (the editor half). Tests: `test/blender-bridge.test.ts` (the conversions),
`test/blender-routes.test.ts` (the wiring, over real HTTP), and `blender/check_bridge.py` (the add-on's own
conversion, against a stubbed `bpy` — outside `npm test`, which does not depend on a Python interpreter).

For add-on installation and the user-facing workflow, see the [Blender bridge README](../blender/README.md).

## Why this and not the two halves that already existed

Both ends were already here separately, and neither of them closed the loop.

- **GLB import** (docs/032) reads a model IN. But nothing goes out, so the only way to edit an existing
  Slopesmith model in Blender was to not have made it in Slopesmith.
- **`ssx_cage_bridge.py`** (docs/009) round-trips a level's *terrain* cage through `Patches.json` on disk. It
  proved the idea works and measured it — geometry lossless to float32, every non-geometry field byte-exact —
  but it operates on an exported folder, not on a live document, and it is about terrain rather than props.
- **Replace geometry** (docs/032) puts a rebuilt GLB onto a model that is already placed. That is the *last*
  step of the loop and it was the only step that existed: the author still had to get the model out by hand,
  keep track of which file was which, and come back through a file picker.

What was missing is the trip out, and the identity that survives it. A model that leaves Slopesmith as
`untitled.glb` and returns through the import path lands **beside** the original with its own number, which
is the correct behaviour for an import (names never overwrite — docs/038) and exactly wrong for an edit.

## The loop

```
Slopesmith                     the bridge                      Blender
─────────────────────────────────────────────────────────────────────────────────
                          GET  /api/blender          →  refresh: what can I pull?
tiled / textured prop  →  GET  /api/blender/mesh     →  pull: a real mesh, real quads
                          GET  /api/texture          →        wearing its real tiles
                                                          (edit with everything Blender has,
                                                           Texture Paint included)
placements re-render   ←  POST /api/blender/mesh     ←  push: mesh, and any tile you painted;
tiles follow it                                              the stamp says where it goes
```

Three clicks, no file dialog, no export settings, nothing to name. The add-on is a single stdlib-only
`.py` — an add-on that needs `pip install` is an add-on that does not get installed.

## Two libraries, and they behave differently on purpose

The author's own geometry comes in two kinds and they are not the same object, so the bridge does not pretend
they are.

| | **Tiled prop** (`@models`, docs/028) | **Textured prop** (`@import`, docs/032) |
|---|---|---|
| what it is | a quad cage wearing ONE tile | a triangle mesh with a material table |
| why it splits here | its mapping is COMPUTED, so nothing is lost by regenerating it | its mapping is DATA, so it has to survive the trip |
| goes out as | **quads** | triangles |
| comes back as | **quads** — the cage survives | triangles |
| UVs | derived from the quad corners. A copy is built in Blender so the tile is paintable; it is not read back | authored; round-trip both ways |
| materials | one tile | matched back **by slot**, extended if the push needs more |
| tile art | edit it in Blender and it comes home | same, per slot |
| where it lives | the open document | a record on disk |
| where a push lands | the mountain's **inbox**, applied by the editor | written to the record immediately |

That last row is the one design decision worth defending. An imported prop's record is the server's to write,
so a push rewrites it in place and every connected editor refetches the catalogue it already refetches on any
custom-library change. An authored model is a definition inside the document, and **writing a document from a
route would put an author's geometry beyond Ctrl+Z**. So a push parks a whole cage in
`assets/blender/pending.json`, announces the ordinary custom-library change, and the tab collects it and
applies it as an ordinary edit — one `commit()`, one undo entry, the same history and persistence every other
edit gets. The one thing an escape hatch must never do is make the trip out harder to take back than it was
to take.

The inbox holds **states, not a log**: a second push of the same model replaces the first. Two pushes are not
two changes to apply — they are one change described twice, and applying the stale one first would flash the
older geometry through the viewport and into the undo stack.

## Textures ride with the mesh

Each slot's tile arrives as a real image on a Principled BSDF, so **Texture Paint works on it directly** —
including on a tiled prop, which gets a copy of its derived mapping as a UV layer for exactly this reason
(named `OpenSlope derived (not pushed)`, because a layer that looks authored but is thrown away would be a trap).
A tile you edit rides home with the geometry; a tile you leave alone is never re-uploaded.

Where the art lands follows the line the rest of the editor draws, and there are only two outcomes:

| the slot was wearing | what a push does | why |
|---|---|---|
| one of **your** Custom tiles | **replaces** it — everything wearing that tile follows | it is your art, and you painted over it |
| an **extracted level's** tile, or none | **forks** a new Custom tile named for the prop, and repoints only this slot | the reference is never written (docs/032). `GARI/0012.png` still means what it meant this morning |

The replace is not a near-copy of the Texture Library's **⟳ replace art** — it is the same function,
`replaceCustomTextureArt`. Both write the new bytes under a free name, move every stored thing wearing the old
ref onto the new one, and delete the tile they replaced. Nothing overwrites, so no URL ever answers with bytes
it did not answer with a moment ago, which is what keeps a one-hour asset cache out of the problem (docs/038).

Two consequences of that are worth stating because they look like bugs otherwise:

- **The ref moves on every push.** `lamp.png` → `lamp_2.png` → `lamp_3.png`. It walks the counter rather than
  compounding a suffix (`lamp_2_2` and onward), which `replaceCustomTexture` handles by asking for the *base*
  name — the iterate-on-one-tile loop is what replace exists for, so it is the case that would have gone
  furthest down that road.
- **The document has to follow the move**, because painted terrain cells and the tile an authored model wears
  are in it. That half cannot be written from a route, so it is parked in the same inbox as a cage and applied
  by the tab through the same `retargetDocTex` the Texture Library uses. Those entries are a **chain, not a
  state**: a second push extends the waiting move (`lamp → lamp_3`) rather than queueing a second one, so the
  entry always names the ref the document actually holds however long the tab stays shut.

A tiled prop's new tile does not need its own entry — it rides on the cage's push, so painting a texture and
reshaping what wears it are one `commit()` and one Ctrl+Z.

### "Edited" is a signature, not Blender's dirty flag

Deciding *whether* to send a tile is the part that fails quietly. Two rules make it safe:

- The comparison is between **digests of Blender's own PNG encoder** on both sides — the baseline is stamped
  at pull time by saving and hashing what just arrived. Hashing the *downloaded* bytes instead would mean
  every untouched tile re-encoded differently on the way out, and every ordinary geometry push would silently
  replace all of an artist's textures with recompressed copies of themselves.
- The new digest is written **only after the service answers**. Saving an image clears Blender's `is_dirty`,
  so an add-on that stamped before knowing the push landed would throw the artist's paint away the first time
  the network hiccupped.

The add-on's panel still marks edited tiles with `is_dirty`, because encoding every tile to PNG on each redraw
would be absurd. The two disagree only after a *failed* push, and in the safe direction: the panel
under-claims, and the retry still carries the art.

Art was added to the wire format **without bumping `PORTAL_VERSION`**. The change is additive both ways — an
older add-on sends no `png`, an older service drops the field — and a version gate should refuse only what it
must, not every geometry pull over a feature nobody was using. The one gap that leaves, a new add-on pushing
tiles at an old service, is caught after the fact: the answer reports how many tiles it took, and none coming
back while some went out prints "the service took no tiles, so it may predate texture push — restart it".

## The portal: a JSON mesh, not glTF

The wire format is polygon loops, a vertex pool, and a stamp. A GLB is what a *foreign* tool should be handed,
and `/api/blender/mesh.glb` writes a proper one — but the add-on is ours, and driving Blender's own
importer/exporter through it would cost three things this format keeps:

- **quads.** glTF has only triangles, and an authored model *is* a quad cage. A cage that came back
  triangulated would be a cage destroyed by the tool that was supposed to help edit it.
- **determinism.** Blender's glTF importer applies its Y-up→Z-up conversion as a baked object transform whose
  exact form has changed between releases. The add-on converting the axes itself is one line
  (`(x, y, z) → (x, −z, y)`) that cannot drift.
- **legibility.** An exporter flag silently off — `export_extras`, most of all — is a whole class of bug that
  cannot happen when the add-on writes the payload itself.

Portal coordinates are glTF's: **metres, Y-up, right-handed, anchor-local**, so a model lands at Blender's
origin. That is also the editor's own data space — `authoredModelLevelProps` and `glbToPropDraft` both reduce
to the same `raw = (−100x, −100z, 100y)` map — so an authored model needs no axis change at all and an
imported prop needs exactly the inverse of the one its import applied.

### Orientation is the claim that fails plausibly

The editor→raw map is a **mirror**, and a prop's normals come from its stored winding alone: a face that
survives the trip pointing the wrong way still *draws* (prop meshes are double-sided) and draws ambient-only
dark from every view — in the editor's PS2 shading preview, in the thumbnails, and on the disc (docs/028,
docs/032). So the mirror and the triangle-order reversal have to cancel in both directions, and neither one
alone would.

That is asserted rather than argued. `test/blender-bridge.test.ts` takes a closed unit cube through every
stage and measures the signed volume — the same invariant `tools/prop-recipes/check.py` makes of a recipe and
every shipped retail prop measures positive:

| stage | signed volume |
|---|---|
| the cage in portal space | **+1.000000 m³** |
| the same cage baked to raw (what a placement renders) | **+1.000000 m³** |
| the GLB a foreign tool downloads | **+1.000000 m³** |
| an imported record pulled out to portal space | **+1.000000 m³** |
| that push written back to raw | **positive** |

The Blender-side conversion is a *proper* rotation (determinant +1), so it preserves winding and no index is
reversed there. The add-on owns only Y-up ↔ Z-up; the service owns the mirror.

### The cage is lossless, corner order included

A cage that goes out and comes straight back is the same cage: same corners, same quads, and the **same corner
order**. That last part is not decoration — an authored model's UVs are derived per quad from the corner
positions (A(0,0) B(1,0) C(0,1) D(1,1), full 0–1 tile, no inset, so a UV scroll flows unbroken — docs/028), so
a round trip that quietly rotated a quad's corners would repaint the model. The stored `[A, B, C, D]` maps to
the perimeter loop `A → B → D → C` and back through `loopQuad`, and the test asserts the identity.

What a *real edit* in Blender can produce, and what happens to it:

| Blender made | the cage takes |
|---|---|
| a quad | a quad |
| a triangle | the wedge `[A, B, C, C]` the mesh tools already speak |
| an n-gon | fanned into wedges, and the count is reported |
| a loose edge / degenerate face | dropped, and the count is reported |
| a moved, rotated or scaled OBJECT | baked into the vertices — the model moves on the mountain |

Nothing is silently repaired: a push answers with how many faces it split and how many it dropped, the add-on
puts that in its status line, and the editor puts it in the toast. Curvature channels are not carried, because
a model's flat cage derives every handle anyway (docs/028) — and `quadLocked` / `freeEdges` / `tJunctions` are
**dropped** on apply, because a channel keyed on the old topology now names somebody else's quads.

## Identity: the stamp

Every payload carries `OpenSlope_slopesmith` — portal version, kind, model number, name, and the **project UUID**.
It rides a glTF root node's `extras` as a JSON string (the convention `OpenSlope_effect` already uses — Blender
stores node extras as ID properties, and only a string survives that with its structure intact), so a model
that went out as a GLB and came in through plain File → Import can still be pushed.

The stamp, not the URL, decides where a push lands. A push whose project does not match the open mountain is
**refused by name** rather than overwriting the same model number in a different map — which is a real hazard,
because model numbers are per-mountain and `model:0002` exists nearly everywhere.

Everything arriving from Blender is treated as untrusted: `readPortalMesh` refuses a missing stamp, a newer
portal version (naming both), a partial vertex buffer, and an empty face list. An out-of-range corner is
*dropped* rather than refused — one stray index must not cost the whole push.

## What does not round-trip, and why

- **A slot's identity.** The material TABLE belongs to the record and a push is matched to it **by slot
  number**, so renaming a material in Blender changes nothing and reordering the slots repaints the model. A
  push reaching past the existing table gets new untextured slots, ready for a tile. What a push *can* change
  is the art on a slot — see above.
- **A model's declarations about itself** — emitters, the spin clip, flipbook lists (docs/032). They are
  carried verbatim across a push: a geometry edit is not a statement about any of them. A tiled prop's
  flipbook is the near miss: Blender only ever sees the tile the model is resting on, so a texture push moves
  the head of that list and leaves the remaining frames exactly where they were.
- **Terrain.** The mountain net is not in this bridge. Terrain has its own path (docs/009), and the reason is
  the one 009 measured: the SSX surface is a quilt of *interpolating* bicubic patches, and Blender's viewport
  cannot show it (subdivision sits up to 0.42 m off every corner). A prop is a polygon mesh in both tools,
  which is exactly why the prop bridge can be lossless and the terrain one has to be a cage bridge.
- **An extracted level's props.** They are the reference, not the work — a push has to land *on* something,
  and a shipped prop is shared read-only by every mountain using that level. `blenderCatalogue` therefore
  lists only the author's own two libraries, and `⬈ edit in Blender…` is gated on `ownGeometry`. The way in
  is one click: **`⧉ revise prop (v2)`** (docs/032) re-packs it as a textured prop in your library — geometry,
  UVs and material table byte-identical, and its **tiles copied into your Custom bank** so the copy is
  paintable rather than merely visible. That copy pulls like anything else.

## Using it

**With the add-on** (the intended path). Install `blender/slopesmith_bridge.py` through Edit → Preferences →
Add-ons → Install, and point its preference at the service (`npm run dev` binds **5180** and serves the editor
from 5179; `npm start` serves both from 5180; `SLOPESMITH_URL` overrides). A **Slopesmith** tab appears in the
3D view's N-panel: a **mountain dropdown** lists every map on the server, **Refresh** reloads it, **Pull**
brings the selected model in, **Push** sends the active object back.

A request naming no mountain resolves to the one the editor has open, which is the right *default* for a
local-first tool — the add-on has no session and no project id to offer. It is only a default, though: the
catalogue answers with every map the service holds, and `?project=` addresses any of them. Picking one in the
dropdown reloads its models through the property's own update callback, so there is no second button.

**A push is addressed by its stamp, not by the dropdown.** The add-on sends `?project=` from the model's own
stamp, so a model pushes back to where it came from even if the panel has since been pointed elsewhere — and
the service still checks the two agree, so the honest case works without weakening the guard against landing
on the same model number in the wrong map.

**From the editor.** Three places, because the hatch is reached for at three different moments — and all
three open the same guide, so the answer does not depend on where it was asked:

- **On a selected prop** — `⬈ edit in Blender…` in the Props panel, beside `⧉ revise prop`. Offered on the
  author's own geometry only, which is what the bridge can carry.
- **Inside a prop's edit session** — `⬈ edit in Blender` in the Prop actions, which is where "this bit is
  hard to do with the mesh tools" is actually discovered. Hidden while the prop is still empty.
- **The Prop Library's Custom view** — right-click any of the author's own geometry → **⬈ Edit in Blender…**.

The guide (`openBlenderGuide`) is six numbered steps — install, address, key, panel, Pull, Push — plus one
line on what survives *this* prop's trip, which is the only part that differs by kind: a tiled prop arrives as
real quads with a paint-only copy of its derived mapping, a textured one arrives as triangles with its own
layout and one Blender material per slot. A second line covers painting, because it answers a different worry
— not "will my mesh come back" but "am I about to overwrite a texture something else is using".
Underneath, **Download GLB** is the no-install route: self-contained, textures embedded,
1 unit = 1 metre, Y-up. It carries the same stamp, so it can still come back through the add-on's Push, or
through **⟳ Replace geometry** for a textured prop.

## Reaching a hosted server: access keys

On a loopback Slopesmith the add-on needs no credential — `identify` resolves a server nobody configured for
accounts to its owner without looking at one. A hosted server has real accounts, and a program has no cookie
jar, no sign-in form and no session channel. So it carries a **personal access key**: minted in
**Settings ▸ Integrations ▸ Access keys**, shown exactly once, pasted into the add-on's preferences, and sent
as `Authorization: Bearer`.

It is described here because the bridge is what needed it first, but **nothing about it is Blender-specific**
— it is an ordinary bearer credential for the whole API, and a script, a CI job or another editor carries one
the same way. That is why it is called an access key everywhere a person reads it: labelling it "Blender"
would send anyone writing a script somewhere else looking for a mechanism that already exists.

Code: `src/server/accounts/tokens.ts`, the `/keys` routes in `src/server/api/auth.ts`, `buildKeysSection` in
`src/app/ui/chrome/settings-dialog-integrations.ts`. Tests: `test/access-tokens.test.ts`.

It is stored the way every other credential here is — **only the digest** — so a lost key is regenerated
rather than recovered, and it reads `slop_<43 urlsafe chars>` so a secret scanner or a person who finds the
string in a config file can recognise it on sight.

Four properties are the design, and each of them is a way a key could otherwise end up **more powerful than
the account it belongs to**:

| | why |
|---|---|
| a key can never satisfy **`admin`** | it lives as plain text in `userpref.blend` on whatever machine Blender is installed on. Authoring is recoverable; adding users, changing roles and repointing the workspace are not. This holds even for an admin's own key. |
| a key **cannot mint another key** | a leaked key that could issue its own successors would survive being revoked. `/keys` requires a `member` identity, and a key is not one. |
| the **role is resolved per request** | nothing is baked into the credential, so a demotion or a promotion binds on the very next request — the same property opaque sessions are chosen for (docs/038). |
| **revoking is immediate** | there is no expiry to wait out. Disabling the account revokes every key it holds; re-enabling does not bring them back. |

The last row has one deliberate exception: **a password change leaves keys alone.** A key is an independent
credential, not something derived from the password, and revoking them on rotation would silently break the
Blender install on every machine an author uses — which is a good way to teach people not to rotate. They are
listed and revocable individually in Settings, which is where "I think this leaked" belongs; disabling the
account, which is the response to an actual compromise, does take them.

A key gets its own `Identity` kind rather than a synthetic session. Roughly twenty places downstream ask
`kind === 'member'` for things a key must not have — a refreshed cookie, a seat in the session channel, the
account self-service routes — and a separate kind makes every one of them exclude keys **by default** rather
than by remembering to.

## Limits, stated plainly

- **A tile URL names its mountain.** `Custom/lamp.png` addresses one map's bank, and the add-on has no tab id
  — so `textureUrl` sends `?project=` with every tile. Without it a pull from the mountain picker while a
  browser tab sits elsewhere fetches against the *active* map: 404, or another map's tile of that name. It
  fails asymmetrically, which is what makes it worth stating — an extracted level's bank is global, so props
  wearing borrowed art keep working and hide it, and only the author's own tiles go grey.
- **A tab has to be open on THAT mountain** for an authored model's push to land. The inbox is per-mountain,
  which is what keeps two maps' pushes from crossing — but it also means a cage pushed to a map nobody has
  open waits there until somebody opens it. Nothing is lost (the inbox keeps the newest few per mountain) and
  an imported prop has no such wait, since its record is written immediately.
- **The document a pull reads is the durable one.** Authored models come from `mountain.slope.json`, so a
  cage edited in the last second before pulling may be one autosave behind. Imported props have no such gap;
  their records are the only copy.
- **A pushed tile is conformed, not preserved.** The Custom bank stores plain 8-bit RGBA at 512² or under
  (`MAX_CUSTOM_TEX`), so art painted at 4K comes home shrunk — the same normalising every upload goes through,
  and what a page must become for a disc is `snowknife repack`'s business, not the bank's. A tile over 12 MB
  (`MAX_PORTAL_TEX_BYTES`) is refused **by slot**, before anything allocates a buffer for it.
- **Float32.** The portal carries doubles, but Blender stores mesh vertices as 32-bit floats — the same
  quantisation 009 measured on the terrain cage (~0.2 mm across a kilometres-wide level). Negligible against
  a format whose unit is the centimetre, and worth stating rather than discovering.
- **No file watch.** There is deliberately no "drop a GLB in this folder and it reimports" path. The add-on's
  Push button is the trigger, which means the author says when a change is ready instead of every intermediate
  save reaching the mountain.
