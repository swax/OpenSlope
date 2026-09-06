# 007 — Flow-aligned ribbons (the run as its own surface)

## Why

The seat (006) lays a run into the square control net by displacing corner heights. A **diagonal**
run exposes the tax: the wall is a metres-wide feature whose crest line does not lie on the axis grid,
so the bicubic can only hold it up where it passes near a control point and sags between — the
"micro-valley" scallop. Antialiasing the seat softens it, but on a coarse net you can only trade
scallop for wall height; a crisp **and** smooth wall at any angle is impossible because the patch
edges are not the trail edges.

The RE says this is the inverted model. The reference's shipped terrain is **not** a heightfield grid with
a trench stamped in — it is authored as **flow-aligned patch ribbons**:

- The trail is its own named category, `Patch_MainPath` (219 patches), a **connected ribbon** (median
  3–4 shared-edge neighbours) of **elongated** strips (aspect ~2.2, up to ~4.5) running along the
  course, distinct from the side terrain (`SideGeo`/`SCE`/`SG`…).
- **Patch size is the texture-density dial**: every patch is one UV tile (1.0×1.0), and MainPath
  patches are ~16.5×7.7 m vs SideGeo's ~33×37 m — finer where the player looks.
- **Directional decals (boost chevrons) are terrain-patch textures**, oriented by per-patch UVs, that
  point downhill *only because the patch rows follow the trail*.
- **The trail is a separate surface stitched into a cut corridor**, not welded into the body: only 3%
  of MainPath patches have body beneath them; the two meet along a shared boundary *curve* (T-junctions,
  not matched vertices). The "quads don't align" because they don't need to — the body is cut away.

(Full evidence: Trailmap `research/extracted-data.md` → "Terrain patch authoring structure".)

So the patch edges **are** the trail edges. That is why original walls and directional textures stay
clean, and it is the structural fix for both the scallop and the directional-texture-misalignment traps.

## What we already have

A run is already a **ribbon** in the data model: `CoursePath` = a spine (knots) + a cross-section
(`width`, `wall`, `bank`, `shoulder`) — a 2D swept surface. Today we *consume* it by embossing it into
the net (`seatCourse`) and throw the ribbon parameterization away. The flow-ribbon model **emits the
ribbon as patches directly** instead. No new authoring primitive — the run tool already authors the
thing; the change is downstream (preview + bake), where the run becomes geometry of its own.

## The representation

A **ribbon** tessellates the run's swept surface into a strip of patches whose **rows run along the
spine** (u = along-arc, v = across the section):

- **Along-arc (u):** sample the spine at a target patch length (~16 m, the reference patch length), so patch density —
  and therefore texel density — is set by arc length, independent of any terrain grid. Curves get more
  patches; straights fewer.
- **Across (v):** the cross-section stations (floor centre → floor edge → wall top → shoulder),
  exactly the `crossHeight` profile, but as **actual patch columns** — the wall is one or two patch
  columns wide with control points *on* the wall, so it is held straight at any heading. No scallop.
- **UV:** u tiles down the trail by chord length (already how `deriveMountain` does chord-length UV),
  v across the section. Directional textures and inset **decal tiles** (chevrons, markings) drop onto
  named ribbon cells and stay aligned because the cells follow the run.
- **Surface:** per-ribbon-cell, like the net's `cellSurf` — the floor band gets the run surface, the
  walls/shoulder their own (matches MainPath = surface 1/5 vs side terrain).

The bake path is unchanged in kind: a ribbon emits the same `Patches.json` records (16 control points
+ UVs + SurfaceType + texture) the net does. `snowknife` never knows the difference.

## How the ribbon and the net coexist

The net authors the **mountain body**; the ribbon is the **trail surface** laid through it. What the
the original data actually does is the key reference, so it heads the list:

**What the reference does — cut corridor + stitched seam (the faithful target).** The trail is a *separate*
surface, not welded vertex-for-vertex into the body. Measured on the reference `Patches.json`: only **3% of
MainPath patches** have any body patch beneath them — the body tiles up to a course-shaped **corridor**
and stops, and the ribbon **fills** it. The two meet **only at the seam**, and not by vertex-matching:
the ribbon's outer edge and the body's corridor edge trace the **same boundary curve**, so the surfaces
are watertight even though the ribbon has ~4 patches where the body has 1 (T-junctions, epsilon-welded —
ribbon perimeter tips coincide 100% with body corners, the long edges ~33%). So the model is **not**
"one watertight quilt"; it is a coarse body with a hole, and a fine ribbon stitched into the hole along
a matched curve. (RE: `research/extracted-data.md` → "Terrain patch authoring structure".)

Staged toward that, in order of fidelity:

1. **Overlay (R1, a shortcut for the look):** emit the ribbon as patches sitting just above the seated
   net trench, net left intact underneath. Gives the smooth walls + aligned textures immediately and is
   rideable, but it is *not* what original did (the body is genuinely cut there) — a fast first light, not
   the destination.
2. **Cut corridor + stitched seam (R2, the faithful model):** trim the net to a corridor along the run
   and stitch the ribbon's outer edge to the corridor edge along a **shared boundary curve** (matched
   endpoints + epsilon weld; T-junctions are fine — the interior vertices need not match). This is the
   reference structure.
3. **Body-as-ribbons (frontier):** the side terrain is itself flow-aligned strips (the reference's `SideGeo`),
   not a square net — the net becomes a *seeding* convenience and the real document is a set of
   ribbons. This is also where **tunnels** live (a run that dives under and the body roofs over it
   through a portal): the run *must* be its own surface there, which it already is.

## Keeping it editable: the cut is derived, the spline is the contract

The corridor must **not** be cut into the body when the path is drawn — the cut is a **derived**
operation, regenerated from the spline (live in preview, flattened only on export). You can edit the
course *and* the mountain freely because the cut is never the source of truth; it is always downstream.
(This is also the read of the reference: the ribbon is clearly *lofted* and the corridor edge *follows the
course offset* with a matched-curve T-junction seam — generated, then tolerance-welded, not hand-carved.
The shipped flat `Patches.json` is the bake; the editable document was `body + course spline`. You can't
iterate through a baked cut, so the cut has to be regenerable.)

**One alignment contract.** Everything that touches the seam derives from the spline, so the two sides
cannot drift:

- the **corridor boundary curve** = the spline offset by `half-width + wall + blend` (moves rigidly with
  the course);
- the **ribbon** is lofted *inside* that boundary (same spline);
- the **body** is trimmed *to* that boundary and blended back to its own shape over the blend distance.

Both surfaces are pinned to the one derived curve. Edit the course → boundary moves, body re-trims and
ribbon re-lofts together. Edit the body away from the trail → the blend absorbs it, the seam stays put.

**Authority — who owns what across the seam.** The trail's line is deliberate (grade, bank, kickers), so:

- the **course owns the trail band**: elevation / bank / width are authored *on the spline*; reshaping
  the hill next to the trail must not drag the line around;
- the **body owns everything else** and is merely *required to meet the trail at the corridor edge*;
- they **handshake at the corridor seam** — the single curve both are pinned to.

The alternative — the trail *draping* on the body (sampling its elevation) — keeps them glued
automatically but discards control of the race grade; right for a casual free-ride trail, wrong for a
course. So the spline authors the line and the body meets it, not the reverse.

For Slopesmith this means **R2 is a derived/non-destructive step, not a destructive bake**: keep
`MountainDoc = body net + course spline`, regenerate corridor + ribbon + seam from the spline on every
edit, and flatten to `Patches.json` only on export.

## Why this fixes the open problems

- **Smooth walls at any heading** — wall control points lie on the wall, not scattered across a square
  lattice. The diagonal-ridge-on-a-grid aliasing simply does not exist.
- **Aligned directional textures / decals** — UVs ride the ribbon; chevrons point downhill by
  construction (the original "compass" test passes for free).
- **Texture density where it matters** — arc-length tessellation puts small patches on the trail and
  leaves the body coarse, exactly the reference size split.
- **Tunnels become reachable** — the run is already a standalone surface; roofing it is the remaining
  step, not a rewrite.

## Staged plan

- **R1 — emit the run ribbon (preview + bake), overlaid.** Sweep `CoursePath` into a patch strip
  (arc-length u, section v), show it in the viewport, bake it into `Patches.json` alongside the net.
  Retire `seatCourse`'s wall (keep a gentle floor depression in the net so the body dips to meet it).
  Deliverable: a diagonal run with crisp, smooth, correctly-textured walls. (A shortcut for the look —
  net still intact underneath, not yet the cut corridor.)
- **R2 — cut the corridor + stitch the seam, *derived* (the faithful reference model).** Regenerate (not
  bake-once) a course-shaped corridor from the spline and stitch the ribbon's outer edge to the corridor
  edge along a *shared boundary curve* (matched endpoints + epsilon weld; T-junctions tolerated, interior
  vertices need not match). Keep `MountainDoc = body net + course spline`; corridor/ribbon/seam are
  regenerated on every edit and flattened only on export, so course and mountain stay editable and
  aligned (the spline is the single contract — see "Keeping it editable"). Body has a hole, ribbon fills
  it — the measured original structure.
- **R3 — directional texture / decal authoring on the ribbon.** Paint along-arc; drop inset marking
  tiles (chevrons) that stay oriented; per-cell surface for floor vs wall.
- **R4 — body-as-ribbons / tunnels.** The frontier: side terrain as strips, run-under-portal.

## Non-goals (for now)

- Replacing the net editor — the net stays the body/seed; ribbons are additive.
- Arbitrary original re-import as ribbons — reading the reference's `MainPath` back into editable ribbons is a
  separate fitting problem (006 Non-goals still apply).
- Branching/junction authoring — runs already branch as separate `CoursePath`s; ribbon junctions
  (shared corridor walls where two runs merge) are deferred.
