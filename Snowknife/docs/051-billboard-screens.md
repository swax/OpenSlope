# 051 — Billboard screens (finding a course's video faces)

`snowknife billboards <mapDir>` measures the flat rectangle on each of a course's billboards that a video can be
laid over, and writes them as `Billboards.json`. `import` and `props` run it; `gltf` folds the result into
`manifest.Billboards`. Unity builds one quad per record ([Unity docs/vrchat/041](../../Unity/docs/vrchat/041-video-billboards.md))
and Slopesmith draws and authors the same rectangles ([Slopesmith docs/051](../../Slopesmith/docs/051-video-screens.md)).

Code: `Export/BillboardsExporter.cs` (the document + the search), `Bundle/BillboardBundle.cs` (into the
manifest), contract [`course/billboards-v1.schema.json`](../Snowknife/schemas/course/billboards-v1.schema.json).

## Why this is snowknife's job

An SSX billboard is welded into the merged static prop mesh with **shared atlas materials**. No engine can
retexture one board's face on its own — the video would smear onto every prop sharing that material, and the
face is not an isolable object. Every consumer therefore lays its **own** quad flush over the face, and what it
needs from the map is only *where that face is*.

That question is answered from geometry and texture coordinates, so it is the bundle rule exactly: *would
Blender/Godot/any engine also need this?* → snowknife (docs/034). It was originally solved inside the VRChat
plugin, against Unity's merged mesh; the search is the same, and moving it here made two Unity-only crutches
unnecessary — the canonical `Props.mesh` asset the finder had to read instead of the live renderer, and the
`Props.pages.json` submesh→page index written beside it, because the optimization passes had destroyed both
identities the search depends on. Reading `Props.obj` has neither problem.

## Input

- **`Props.obj`** — the world-placed prop bake: `o inst<n>_<name>` groups, `usemtl` material slots, and
  `v`/`vt`/`vn`. One slot is one SSX **texture page**, which is the identity the whole recipe keys on; the
  authored signed normal is the side from which that texture reads forward. Triangles belonging to instances
  the level hides are skipped, matching the merged mesh a consumer actually draws. The `inst<n>` owner is
  retained too, so an ordinary named board is measured from its own mesh rather than a nearby coplanar prop.
- **`Instances.json`** — `InstanceName` (`Mdl_<Model>_<id>`) and `Location`, which say where each board stands.
- **`AIP.json` / `SOP.json`** — the course centreline, which decides which face of a genuinely two-sided board
  the riders see. A folder with no path tables keeps the first authored face.

Everything is computed in SSX **mesh space** (centimetres, Z up, X negated) — the frame the manifest already
uses, so no consumer converts anything.

## The recipe (single-image ad boards)

For each instance of a configured family, the column within `FindRadius` (18 m in the ground plane) is searched:

1. **Group by (material slot, facing).** An ordinary named board searches triangles owned by its exact OBJ
   instance; only calibrated composite frames (`EABigBottom*`) and instance-less tower side panels search the
   surrounding column. Near-vertical triangles (`|n.z| ≤ 0.6`) are bucketed by slot *and*
   quantized normal — **not** by depth. Two coplanar faces on **different pages** (the ad image versus the
   structural frame welded right behind it) therefore split apart, while a whole stack or row of same-page
   coplanar boards lands in **one** group, which the cell split separates again. **Crowd pages are blocked
   outright**: the spectator flip-book has its own page (`cd##`) and its sprite cells pass the UV test, so a
   board with no real ad face standing in a crowd would otherwise grab a crowd quad.
2. **Keep contiguous-ad groups.** A group is an ad image only if its UV box spans a single, non-repeating chunk
   of its page — `0.40 ≤ span ≤ 1.20` on **both** axes. A real ad shows its page once (≈1, or ≈0.5 for the
   stacked half-height boards); a **tiled** structural face repeats (> 1.2); a flip-book cell or atlas sliver
   spans less than 0.40. Groups under `MinAdArea` (70 m²) are stray slivers and drop out.
3. **The board on this base.** The instance's own ad face is the UV-passing group whose centroid is **closest in
   the ground plane to the instance origin** — not the largest in range, or a bigger neighbour board inside the
   search radius steals it and this board's screen goes missing. Ties break on area then first triangle, so the
   written document is a function of the geometry rather than of hash order.
4. **Front side.** A single-faced panel follows its authored `vn`: this is the readable side of the texture and
   survives the raw→mesh X reflection as a direction (`x` negated), whereas recomputing a cross-product normal
   after that reflection reverses it. Nearby stand/frame geometry is not allowed to overturn that explicit
   signal. On a genuinely **double-sided** board — two opposite faces on the **same material slot**, centred
   within 3 m and within 2× of one another's area — the **course** still selects the physical face the riders
   see, comparing each face's authored/readable direction rather than its reflection-reversed winding. Once
   that face is fixed, its authored normal supplies the readable-side sign without changing the
   measured face or its cell split. Requiring the same page/centre/size is important: a stand or punchout can
   itself pass the UV gate and face backward, but it is not the display's second side. A custom or legacy OBJ
   with no `vn` stream retains the old **open-side** fallback: whichever side carries less geometry directly
   behind it, measured within the panel footprint and a shallow depth. For a single freestanding face, a
   nearby course may override an away-facing authored normal only when that same open-side test agrees; this
   puts the overlay on the rider side without letting a distant path or the board's backing flip it casually.
5. **Split into board cells.** The chosen face is split along up (a vertical **stack**), right (a horizontal
   **row**) and the normal (a **depth** step) wherever a gap exceeds `SplitGap` (0.6 m). Within one face the
   triangles overlap on every axis and stay together; the ~1 m gap between adjacent boards separates them. Each
   cell is sized and placed from **its own** normal and centre — the group average would yaw or mis-depth a
   fanned or depth-stepped cluster — and sat `Proud` (0.1 m) off the face. A stacked triptych becomes three
   flush screens instead of one 24 m blob.
6. **De-dup.** SSX stacks model variants on one board (a breakable twin, a co-located ad + structure pair).
   Screens whose centres are within `DedupDist` (2.5 m) and roughly coplanar are the same screen, so the first
   is kept.

## Jumbotrons (the tiled/scrolling pass)

The animated-LCD towers need a second recipe. Most use a **tiled flip-book page** on a curved drum; Merquer and
Snowdream instead use ordinary `[0,1]` UVs on an explicitly scrolling `mat_*_scr*` slot:

- **The LCD page is auto-detected**: each tower votes from triangles belonging to that exact OBJ instance, not
  every prop in the surrounding 18 m column. Its largest tiled near-vertical face wins, with an explicit
  scrolling slot also admitted for the Merquer/Snowdream form; the family majority then selects the shared page.
- **Parallel to the flat main plane.** The drum is curved, so fitting to the *average* normal tilts the quad and
  slices it through the curve. The largest flat facing-group gives the drum's main plane; the quad is built
  parallel to it. As with ordinary panels, its authored normal supplies the readable-side sign; choosing that
  sign does not discard the physical face when the course lies behind a single-sided LCD.
- **Trim only shared-post variants.** On tiled towers, the base/post column sits directly below the display and
  shares its page (depth cannot separate them), so only the top `JumboScreenFrac` (≈42 %) is kept. A scrolling
  slot's model face is already exactly the display, so it keeps its full height.
- The quad is pushed proud of the front-most surface, so the drum cannot poke through it.

Each tower also carries a **static ad panel** beside the drum with no instance of its own, so a second pass runs
the ad finder from the tower's origin and catalogs it separately (`<tower>_Ad`). The selected LCD slot is
excluded from that pass — essential for Merquer, whose untiled LCD would otherwise satisfy the ordinary ad
gate too. Candidates are ranked in full 3D instead of only the ground plane on these tall towers, and a
qualified group that splits entirely into undersized fragments cannot suppress the next coherent face. Where
two remaining fits cover the same spot the de-dup keeps one.

## Finish screens

Every exact `Mdl_Finish_Screen_<id>` instance is cataloged, along with the misspelled retail family
`Mdl_Finsh_Screen` used by Garibaldi (`7000`) and Snowdream (`4000`). These meshes sit with the finish-stage
family but their display can be more than 18 m from the shared instance origin, so detection reads the screen's
own OBJ triangles directly. The display is a shallow curve split across facing buckets; the whole-surface
fitter merges those halves into one full-width player and pushes its flat overlay beyond the front-most point.

## Which families, and why the others are excluded

Listing or discovering a family only **admits** it — the per-board UV and area gates still decide per instance,
so a family with no ad face in range simply yields nothing. Ordinary interchangeable panels are discovered
from `Instances.json` by their exact `Mdl_Billboard_Ad_<one letter>` family; this covers another course's letter
without collapsing every panel into one family name or admitting similarly named non-panels.

| Family | Cataloged | Why |
|---|---|---|
| `Mdl_Billboard_Ad_<one letter>` | yes (discovered) | flat single-image ad panels; observed families are `A–C`, `E–K`, `M–N`, and `P–R` |
| `Mdl_Billboard_Elys` | yes | flat single-image ad face |
| `Mdl_Billboard_EABigBottom` / `EABigBottomnostand` | yes | sized to the real ad page, not the 26 m structural frame |
| `Mdl_Billboard_Event2` | yes | single-image page, the top of the roadside boards |
| `Mdl_Billboard_EABig_Top` | yes | single-image **half-height** strip above the posts; its atlas V span is admitted down to 0.20 |
| `Mdl_Jumbotron_Top` / `GariTop` / `SnowDreamTop` | yes (tiled/scrolling pass) | their matching `Bottom` models are co-located lower halves → one screen per tower |
| `AlaskaLogo` / `MercuryLogo` / `SnowDreamLogo` / `AfroSlide` | yes | course-specific names for flat, single-image billboard art |
| `HorizA` / `HorizC` / the `HorizA` shortcut variant | yes | Aloha's horizontal ad boards; their atlas regions pass the same UV/area gate |
| `Mdl_Billboard_Ad1` … `Ad4` | no | co-located pieces of `EABigBottom*`; the calibrated family already catalogs the same screen |
| `Mdl_Billboard_EABig_Impact` / `Adimpact` | no | breakable twins of the ad boards; the live faces are already cataloged and the twins' meshes are fragmented |
| `Mdl_Billboard_Event1` | no | the support **posts** of the `EABig_Top` boards (co-located, distance 0); detecting them produced only post-inclusive mis-fits |
| `Mdl_Billboard_Event5` | no | a knockable physics prop; a static video quad would be left behind when the sign moves |
| `Mdl_Finish_Screen_<id>` / `Mdl_Finsh_Screen_<id>` | yes (whole-surface pass) | shallow curved finish display; Gari and Snowdream use the misspelled retail family |
| Signs / stands / lights / LCD logos | no | not ad screens; most have no `[0,1]` page, so the gate skips them anyway |
| crowd (`cd*` pages) | blocked | spectator flip-book sprites, blocked so a board standing in a crowd cannot grab one |

Measured results on the two shipped levels this was developed against: **69 screens** on one (Ad_A 10, Ad_B 7,
Elys 1, EABigBottom 32, EABigBottomnostand 14, Jumbotron_Top 5) and **82** on the other (Ad_A 41, Event2 1,
EABig_Top 32, Jumbotron_GariTop 5, Jumbotron_GariTop_Ad 3), each sized to its real ad face — the EA boards at
~18×7 m, the ad region rather than the 26 m frame — with stacked and clustered boards split one screen each.

**Known limitations.** The cell split keys off ~1 m gaps, so a cluster packed tighter than `SplitGap`, or boards
fanned wider than the normal-quantization bucket, can still merge or mis-split. Two genuinely flush stacked
boards read as one screen. There is no connected-component fit, so a few oversized faces fit more loosely than
the clean 19×7 m strip on the rest.

## The document, and who may overwrite it

`Billboards.json` carries `Source`: the detector writes `detected`, Slopesmith writes `authored`, and a
detector run **refuses to replace an authored document** without `--force`. A hand-placed screen set is the
author's, not the tool's — re-running `import` over a folder someone has edited must not silently discard it.

`BillboardBundle` passes the document into `manifest.Billboards` unchanged (mesh space throughout), rejecting
degenerate records and suffixing a repeated name, since consumers name objects after it and flatten every family
into one container. The `unity` staging step **skips** the source document: the importer reads only the bundle.

## Verification

`Snowknife.Tests/Export/BillboardsExporterTests.cs` builds synthetic boards — an ad panel on one page with a
tiled structural slab welded behind it, the shape every gate here exists for — and asserts the fit is sized to
the ad face, sat proud of it, turned to the open side, split one screen per board in a stack, blocked on crowd
pages, and silent on faces too small to be an ad. Regressions also cover a backward stand material not being
mistaken for an ad's second side, exact-instance isolation from a nearby panel, readable-side selection on a
double-sided board, a nearby course exposing an unbacked panel, an untiled scrolling jumbotron retaining its
full display, and an offset curved finish screen becoming one full-width player. The suite also covers the
authored-document guard and manifest hand-off. Detection against a shipped level is a local check.
