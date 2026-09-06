# 020 — Patch finish (interior sculpt, handle tension, the artist pass)

The control-point construction Slopesmith already uses is, measured fact, the same one the original
pipeline used: `quadControlPoints` builds every patch from its boundary with chord-⅓ Bessel handles
and zero-twist (Ferguson) interiors — and the reference quilts show exactly those defaults as their
fingerprint (handle/chord median exactly ⅓ on every level; a machine-exact zero-twist cluster in the
interior CPs). What the reference *also* shows is the pass that came after construction: on most
patches the artists moved the interior CPs off the zero-twist prediction and tuned handle lengths
across a 0.2–0.5 chord spread. That finish pass — detail *below* the grid frequency, without spending
quads — is what this doc adds. It is the fidelity half of the performance story: the reference stays
at a few thousand patches because moguls and micro-relief live in the CPs, not the topology.

## Data model

One addition to `QuadMeshDoc`:

- `quadTwist?: Record<number, [V3, V3, V3, V3]>` — per-quad offsets added to the four interior CPs
  (cp5@A, cp6@B, cp9@C, cp10@D) *after* the zero-twist construction. Absent (or an absent corner ⇒
  zero) ⇒ pure Ferguson, exactly today's output. Offsets are editor-space metres, stored per quad. A
  loop cut carries an unsplit quad's twist through the id remap and resets a *cut* quad to zero-twist
  (the surface-preserving split of offsets across the new corners is the [018](018-density-transitions.md)
  refine job); `meshSetTwist` pins one corner, `quadControlPoints(mesh, eh, quad, twist)` applies it.

`quadControlPoints` adds the offsets last, so a twist rides its boundary handles: it is stored off the
*current* zero-twist base, exactly how the reference carries a sculpted interior past its tangents.

Handle tension needs no new storage: a tuned handle is an `edgeHandles` override whose direction is
the Bessel direction and whose length differs — the existing crease mechanism, used at magnitude
rather than angle.

## Ops

### Direct interior-CP edit

A singly-selected cell (Edit, cage on) exposes all twelve non-corner control points as pickable spheres:
the eight on-edge tangents (write `edgeHandles`) and the four interior twist points (cp5/6/9/10, write
`quadTwist`). Picking an interior sphere seats the standard translate gizmo — Surface (aligned to that
corner's slope) or World per the pill — and a drag stores the point's offset off its zero-twist base.
This is the precise, one-point-at-a-time counterpart to the brush below; the sphere sits at the CP's true
(sculpted) position, so pulling a boundary handle visibly carries the interior point with it.

### Mogul / relief brush

A sculpt brush that displaces **interior CPs only** (writes `quadTwist`), leaving corners and shared
edges untouched — so it can never open a crack or move a seam, and its footprint is sub-cell. Modes
mirror the corner sculpt: raise/lower along the surface normal, smooth (decay offsets toward zero),
with the existing radius/strength controls. A "moguls" preset stamps an alternating ± pattern sized
to the brush, the reference's bump-field look in one stroke.

### Handle tension

On a selected corner, edge, or seam-run: a tension scalar (0.6–1.5×) scales the Bessel handle
lengths without changing direction — tighter reads crisp, looser reads soft, G1 is preserved because
direction is untouched. The existing per-corner crease/smooth assists sit alongside; this is the
third state: *smooth but tuned*.

### Reset to construction

Per selection: drop `quadTwist` and length-only `edgeHandles` overrides back to defaults (creases —
direction overrides — are kept unless explicitly smoothed). The escape hatch that makes the finish
pass fearless.

## Preview & export

- `quadControlPoints` adds the quad's `quadTwist` offsets to cp5/6/9/10 — one addition per interior
  CP, no other path changes; preview tessellation and export stay one code path.
- Export needs no format change: interiors are just CPs in `Patches.json`, which is precisely how the
  reference carries its sculpted interiors.
- Test-ride collision picks the detail up for free (BVH tessellates the derived quilt) — moguls are
  ridable, which is their entire job.

## Fidelity guidance (enforced softly via [021](ideas/021-fidelity-lint.md))

Prefer finish over densification: if a detail fits inside one cell, it belongs in `quadTwist`/tension,
not in a loop cut. The lint surfaces the tell — patch budget climbing while median cell size falls
below the reference envelope (10–30 m) means topology is being spent where CPs would do.

## Verification

- Unit: `quadTwist` moves only interior CPs (seam CPs byte-identical before/after); refine splits
  offsets so the surface is unchanged to tolerance; reset restores construction exactly.
- Smoke: mogul-brushed export re-imports with interiors off zero-twist (the reference fingerprint
  test applied to our own output — `temp/cage-test.ts` Test D reads a sculpted cluster).
- In-browser: brush a mogul field on a seeded slope, ride it; tension a wall lip and see the
  silhouette tighten.

## Staged build

- **S1 — `quadTwist` storage + direct interior-CP edit + preview/export/surgery wiring** (built). The
  mogul brush (raise/lower/smooth over a footprint) is the remaining S1 op.
- **S2 — handle tension** on selections; reset-to-construction.
- **S3 — mogul preset** + lint tell.
