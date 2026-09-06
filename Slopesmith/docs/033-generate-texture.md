# 033 — Generate Texture

Describe a material and get a paintable tile — the second way art enters the open mountain's texture library,
beside the **＋** tile that loads an image from disk (docs/005). Click **✨** in the Texture Library view named for the open mountain
view and the dialog opens on three tabs, all landing at the same destination — `Custom/<name>.png`, exactly
like an uploaded file: same store, same refs, same export path.

| Tab | Source | fal call |
| --- | --- | --- |
| **New texture** | a one-line description | text-to-image |
| **Transition** | two existing tiles A and C | inpainting — the strip between them becomes tile B |
| **Decal** | one existing tile + a description | inpainting — the decal lands on the tile's centre |

Generation calls [fal.ai](https://fal.ai) with the author's **own** API key and bills their own account.
Without a key in **Settings ▸ Integrations** the dialog still opens and explains itself, but Generate stays disabled.

## Model terms and saved provenance

fal's [model licensing FAQ](https://fal.ai/docs/documentation/model-apis/faq) says each model has its own
licence; the provider's generic terms are not a substitute. Every enabled catalogue row therefore carries
the exact fal model page, the commercial/research status shown there, and the date it was reviewed. The
dialog shows that model-specific status and links its model licence/status page beside the selector, followed
by fal's [Terms](https://fal.ai/legal/terms-of-service),
[API Terms](https://fal.ai/legal/api-services), and
[AUP](https://fal.ai/legal/acceptable-use-policy). The proxy checks the same row: an unknown, unreviewed, or
research-only endpoint cannot become billable just because its id reached the request.

“Commercial use through fal.ai” describes permission to use that endpoint. It does **not** promise that an
output is exclusive, original, non-infringing, or otherwise cleared, and it does not grant rights to inputs.
The dialog says that plainly and reminds the author to confirm input rights and any model-specific,
territorial, and acceptable-use restrictions. In particular, an endpoint page can grant commercial use
through fal even when separately downloaded model weights have different terms.

When a result is successfully generated, the client snapshots its actual endpoint(s), generation timestamp,
model page/licence/status, review date, and those four provider-document URLs. Saving the PNG writes that
canonical JSON beside it as `assets/textures/<stem>.generation.json`; prompts and API keys are deliberately
absent. Changing the menu after a run cannot rewrite the snapshot—the archive describes the paid result,
not the selector at Save time. Rename moves the sidecar, duplicate copies it, and delete removes it; manually
replacing the art starts a new asset without the old generation claim.

Code: `src/core/paint/fal-models.ts` (both model catalogues + pricing, shared by the dialog and the proxy),
`src/core/paint/seamless.ts` (the wrap blend, pure and tested), `src/app/paint/texture-gen.ts` (the dialog:
tabs, composes, masks, composite), `src/app/paint/library.ts` (the ✨ tile, and the pick mode the inpaint
tabs borrow), `src/app/state/settings.ts` + `src/app/ui/chrome/settings-dialog.ts` (the key),
`src/server/routes/fal.ts` + the `/api/fal-texture` and `/api/fal-inpaint` routes in `src/server/api/textures.ts`
(the proxies). Tests: `test/custom-textures.test.ts`.

## Why it needs almost no new pipeline

The destination is a file under the open project's `assets/textures/`, which `saveCustomTexture` already writes and
`/api/texture-upload` already exposes. So the generator's last step is the *upload path's* last step — POST
the PNG bytes, take the name the store answered with, reload the Custom level, make that tile the brush. `adoptCustomTexture`
in `library.ts` is that shared tail, called by both the ＋ file picker and the ✨ dialog. Everything
downstream — painting, model texture fields, the VRAM preflight, the ISO repack's 128² cap, the Unity
bundle — sees an ordinary custom tile and needs no knowledge that a model made it.

## Four decisions that look like oversights

**One field is the source.** You type a description — "ice cream with sprinkles" — and it fans out into both
the prompt sent to fal *and* the name the tile is stored under (`ice-cream-with-sprinkles.png`). Nothing is
kept in sync by hand, and there is no second thing to fill in before you can press Generate.

The tiling boilerplate — flat lay, top-down, ambient light, no shadows, edge to edge, no border — is what
separates a *material sample* from a photograph of a thing, so it is real, visible and editable under **Full
prompt sent to fal.ai**. It sits one disclosure down because it is identical every time and is not what you
came here to write. Editing it by hand takes it off the description's leash (the summary says so, and the
disclosure is forced open, so the dialog never quietly sends something other than what it shows) until
**↺ Recompose from description** puts it back.

**Add to library does not close the dialog.** Generating a usable material is a numbers game: you run it a
few times and keep the ones that worked. Closing on the first keeper would make the common path "reopen,
retype, re-pick the model". Instead each add rolls the suggested name forward — `gravel`, `gravel-2` — so
consecutive adds land beside each other rather than overwriting, and the prompt and settings stay put for
the next run. Pressing Add twice on the *same* result under different names is how you fork a generation you
like before regenerating over one of them. For the same reason the modal is **sticky**: an unsaved
generation is paid-for work, so a stray click outside the dialog does nothing — only **Close** and **Esc**
dismiss it (and while a texture pick is up, Esc cancels the pick first; the dialog waits underneath).

**Generation size and stored size are separate menus, and only the first is billed.** Diffusion models are
trained at 512 and up and return mush when asked for 128, so a PS2-sized tile is generated large and
downscaled here. The downscale is a supersample: a 512² generation stored at 128² is *sharper* than a
128² generation would have been, and costs the same as any other 512² run. fal prices these models per
megapixel, so the estimate beside the model menu is exact and 512² genuinely costs a quarter of 1024².
Only per-megapixel models are offered — a per-compute-second model could show a guess at best, and a guess
sitting beside a real number reads as a real number.

**Seamless wrap blend is on by default and is not decoration.** No text-to-image model tiles on its own.
See below.

## Making it actually tile

The prompt can *ask* for a borderless frame; it cannot make the left edge agree with the right one. So
`makeSeamless` cross-fades every pixel with a copy of the image offset by half its size in **both** axes,
weighted to stay pure source through the middle and pure offset at the very border. The guarantee falls out
of the two border cases:

- at `x = 0` the weight is 0, so the output samples source column `w/2`
- at `x = w-1` the weight is also 0, so the output samples source column `w/2 − 1`

Those are **adjacent columns of the original**, so where tiles meet, the pixels either side of the join were
neighbours in the source. The same argument runs down `y` and through the corners — which is why the offset
is applied in both axes at once rather than one at a time.

`SEAMLESS_BAND` (0.25) sets how far in the cross-fade reaches. A quarter leaves the central half untouched;
the classic whole-image version of this trick blends everywhere and ghosts the entire texture. The cost is a
softened outer band, which organic materials (snow, rock, gravel, bark) hide completely and regular
geometric patterns do not — hence the checkbox, and hence a preview that repeats the tile 4 × 2 so the seam,
or its absence, is the thing you are actually looking at.

The blend runs at **generation** resolution, before the downscale, where the cross-fade has pixels to work
with. `seamError` measures the mean per-channel difference across the wrap and exists so the tests can
assert the improvement rather than eyeball it: a luminance ramp — the worst case, edges maximally far
apart — goes from 95.6 to 1.88, and that residual is one gradient step, not a leftover seam.

## Transition: a tile that walks from A to C

Pick tiles **A** and **C** (each opens the Texture Library's pick mode, docs/005 — the dialog steps aside
while the question is up and comes back with the answer in its slot), rotate either in quarter turns if its
grain runs the wrong way, and Generate. The client composes a square with A filling one half and C the
other — side by side by default, or stacked A-above-C with the **Vertical stack** checkbox, for transitions
painted as rows rather than columns (the A · B · C boxes rearrange to match, and the prompt's geometry
words flip with them). The **middle third** is replaced by `bridgeFill` — a linear blend of the two pixel
lines just outside it — and sent with a mask (white = repaint) to an inpainting model, whose whole job is
to continue the two visible materials into the gap. The optional description steers *how* they meet ("snow
thinning out over wet gravel") and names the tile; left blank, the model is simply asked to mix them.

The bridge, not flat grey, is what the repaint zone is "cleared" to, and the distinction matters: a
fill-style model (FLUX Fill) ignores masked content entirely, but a controlnet-style one (Z-Image, the
default) **conditions on it** — a grey slab pulls the strip toward grey mush, and stale content would pull
it toward the past. Not that there is any: the compose is rebuilt from A and C on every Generate, so a
regeneration never contains the previous result — the B box shows exactly what is in flight while the call
runs.

The geometry is the point (described for the horizontal layout; the vertical stack is the same argument
transposed):

- The half/half split puts **A's own left edge at x = 0** and **C's own right edge at x = size−1**. Painted
  as columns A · B · C, the A→B seam is A's art meeting A's art across its own wrap, and B→C likewise for
  C — exactly as seamless as A and C already are, no better and no worse.
- The middle third is the only part the model invents; the outer thirds are context it can see.
- After the round-trip, `compositeMasked` keeps the model's pixels **inside** the band and puts the
  composed source back **bit-for-bit outside it**, cross-fading over ~size/128 px at the boundary.
  Inpainting endpoints re-encode the whole frame, so unmasked pixels come back *approximately* right —
  and approximately is exactly what a tiling edge cannot afford. The seam claim above is true by
  construction, not by model good behaviour.

The preview shows an **A · B · C strip** rather than the usual 4 × 2 self-repeat, because B against itself
(C's edge meeting A's) is a seam nobody will ever paint.

That leaves one pair of edges the construction doesn't cover: B's edges facing A and C are their art, but
the invented strip's **other two edges** only meet if the model happens to make them — Bs repeated along
the strip can show a seam. The **wrap repair pass** (a checkbox, on by default) closes it the same
by-construction way rather than hoping: roll the composite half a tile across the blend (so the strip's
wrap seam sits mid-frame as an ordinary join), send **one more inpaint** over just that join — limited to
the strip, so A and C never enter the mask — composite, roll back. Two details make it work: the sent
join is `bridgeFill`ed first, because a conditioning model handed the seam it is meant to erase will
happily hand it back; and the healed pixels become the tile's wrap edge on roll-back, while what ends up
at the edges was mid-frame continuity in the healed image, so B repeats along the strip by construction
too. Rolling by half twice is the identity, so A and C still come back pixel-exact. It is a second
same-size call, so it honestly **doubles the run price** — the estimate says so — and it sends a fixed
seam-repair prompt (`healPromptFor`) derived from the same blend description. A deterministic cross-fade
would have been free, but it ghosts the strip against itself; the model repair costs half a cent and
doesn't.

## Decal: paint something onto a tile

Pick a source tile, describe the decal ("faded yellow hazard chevrons, stencilled"), Generate. The source
goes up **unbridged** — the decal belongs on the material, so the model should see it — with the mask set to
the **central half in both axes**. The same `compositeMasked` pass then restores the source's outer band
bit-for-bit, so the result tiles exactly like the tile it came from: the edges, which are what make a tile
tile, are never offered to the model in the first place.

The preview reflects how a decal is actually painted — one marked cell in a field of the material — by
showing the decal tile **once, surrounded by plain source tiles**, so the joins between decaled and plain
cells are the thing on show, not a wall of repeated decals.

The **seamless wrap blend checkbox belongs to the New tab only** and is hidden on the other two — the
half-offset blend would drag A's art into C's half, or the freshly painted decal into the corners. The
inpaint tabs get their wrap from construction instead, as above.

Both tabs share the inpainting model menu (`FAL_INPAINT_MODELS` — per-megapixel priced like the
text-to-image list, so the estimate stays exact, and the default is the cheap one). The one vendor split
worth recording: Black Forest's fill endpoints call the mask `mask_url`, Tongyi's inpaint calls it
`mask_image_url` — the catalogue carries a `maskParam` per model so the proxy stays free of special cases.
Results are held **per tab**, so flipping tabs never discards a generation someone paid for, and editing a
tab's inputs (A, C, a rotation, the decal source) drops that tab's stale result rather than leaving a
preview the next Generate would contradict.

`POST /api/fal-inpaint` takes `{model, prompt, image, mask, seed?}` with the key in `x-fal-key`; the image
and mask travel as PNG **data URIs** end to end — fal accepts them wherever it takes an image URL, so
nothing is uploaded anywhere first, nothing lands on disk, and the proxy passes them through untouched. The
route's allow-list is `FAL_INPAINT_MODELS`, disjoint from the text-to-image list (the tests hold both
proxies to that), and each data URI is size-capped before fal is dialled.

## The key, and why the call is proxied

The key lives in `localStorage` under `slopesmith-settings-v1`, which also makes it **per member rather than
per server**. Slopesmith has accounts (`038`) but no account-backed secret store, and a key is a billed
credential: everybody sets their own in their own browser, it travels only on their own generate requests,
and the server spends it on those and nothing else. Nobody generates on somebody else's credit, an admin
never holds a key on other people's behalf, and a member leaving takes their key with them. It is the same
exposure as a key in a local `.env`, and the Settings dialog says so rather than implying more safety than it
has.

That is also why the fal routes are `editor` in the route-access table rather than `viewer`: generation
spends real credit, so it is an authoring action.

fal's REST API *is* reachable from a browser, so the proxy is a choice, for three reasons in order of weight:

1. The key never appears in a cross-origin request, a CORS preflight, or any extension's view of one.
2. fal returns the image on a CDN host. Fetching it server-side is one round-trip for the client and no
   dependence on that host's CORS policy staying permissive.
3. fal's errors arrive as JSON that can be turned into a sentence the dialog shows — "fal.ai rejected the
   API key", "no credit on this account" — instead of the opaque `TypeError: Failed to fetch` a blocked
   browser request produces.

`POST /api/fal-texture` takes `{model, prompt, size, seed?}` with the key in `x-fal-key`, and answers with
PNG bytes and the used seed in `x-fal-seed`. The key is used for that one call and never written anywhere.
The route's `ALLOWED` set is the model catalogue: without it, the endpoint would forward an arbitrary path
to `fal.run` under the user's key, which is a credential relay rather than a texture generator. The response
deliberately skips `responseCache` — every generation is a fresh billed result, and only what the author
presses **Save** on enters the library.

## Storing at the right size

| Store as | For |
| --- | --- |
| **128²** | The dominant native SSX terrain size, and the cap an ISO export applies anyway. Pick it for anything shipping to PS2. |
| 256² | More detail for Unity exports; an ISO export with "maximum 128²" on halves it again. |
| 512² | The library's ceiling (`MAX_CUSTOM_TEX`). Fine for Unity, well over the PS2 VRAM budget for more than a tile or two — watch the export dialog's VRAM bar (docs/011). |

A name already in the library is stepped past rather than written over — `snow`, then `snow_2` — as with an
uploaded file ([038](038-hosted-sessions.md)), so generating again never changes art an existing cell
is wearing. The dialog arms whichever name the store answered with, and rolls the name field forward so the
next add lands beside this one. To put a generated tile *onto* an existing one, use its **⟳ replace art**
action (docs/005).

## Managing what you generated

Right-click a tile in the open mountain's view for **✎ rename**, **⧉ duplicate**, **⟳ replace art** and
**🗑 delete**. They only appear for the open mountain — an extracted level's bank is read-only. Each is confined to
the open project's `assets/textures/` by construction: the level is a constant and `safeDataName` reduces whatever the
client sends to the level-asset alphabet, so no argument can address a file outside that folder.

Rename and duplicate **suffix an occupied target** rather than landing on it, the same rule an upload plays
by: replacing a tile the author did not name is not a rename, it is a deletion with extra steps. Putting new
art on a tile on purpose is what **replace** is, and it says what it will affect before it does it.

A texture ref lives in three places, and rename and replace fix up all three:

| Where | On rename / replace | On delete |
| --- | --- | --- |
| `doc.quadTex` — painted cells | repointed | cleared, cell falls back to its SurfaceType tint |
| `AuthoredModel.texture` | repointed | cleared, model reads as untextured clay |
| Imported prop records (`assets/props/*.json`) | repointed server-side | **left alone**, reported in the confirmation |

Delete leaves imported records deliberately. Dropping a material's texture would edit the author's *models*
as a side effect of a *library* action, so the confirmation reports the count and lets them decide. Those
records are also the one place the editor cannot count for itself — they live on disk, outside the document
— which is what `GET /api/texture-usage` is for.

The document edits go through history, so a delete that turns out to be a mistake is one Ctrl+Z away. The
**file** operation is not undoable, and the confirmation says so; leaving the document half of it
un-undoable as well would be the more surprising choice. Undo after a delete therefore restores refs to a
file that is gone — visible as a missing tile until you generate or load one under that name again.
