# Texture conditioning

Small, material-agnostic helpers for turning generated artwork into terrain tiles. These scripts were
distilled from the successful `ice-cream-social/textures` experiments so the reusable parts live in the
tracked Slopesmith toolset while generated candidates remain course-local scratch.

The pipeline is deliberately measurement-first:

```text
fal candidates -> pick_best.py -> condition.py -> check_seams.py
                                      |
base tile A + base tile B -> make_transition.py
```

`tiling_mode=both` is a useful generation prior, not proof that a bitmap wraps. Generate several
candidates, measure them, and retain the quietest edge. Conditioning cannot rescue a source with a large
wrap discontinuity; it only preserves a good wrap while changing output size, density, or direction.

## Commands

```bash
# Rank candidates and copy the best source.
python Slopesmith/tools/texture-conditioning/pick_best.py \
  --out texture-work/raw/vanilla.png \
  texture-work/candidates/vanilla-*.png

# Produce a 128px terrain page, preserving the wrap while downsampling.
python Slopesmith/tools/texture-conditioning/condition.py \
  texture-work/raw/vanilla.png \
  texture-work/vanilla.png --size 128

# Inspect any number of source or shipping pages.
python Slopesmith/tools/texture-conditioning/check_seams.py texture-work/*.png

# Review candidates repeated 2x2, which exposes both seams and conspicuous motifs.
python Slopesmith/tools/texture-conditioning/contact_sheet.py review.png candidates/*.png

# Build an organic A|B transition. `vertical` means A is on the left and B on the right;
# `horizontal` means A is above B. The outside bands remain pixel-exact copies of A and B.
python Slopesmith/tools/texture-conditioning/make_transition.py \
  vanilla.png strawberry.png vanilla-to-strawberry.png --axis vertical --seed 23 --amplitude 0.45
```

Useful conditioning options:

- `--density 2|4|8` repeats a smaller, seam-preserving sub-tile when generated motifs are too large.
- `--axis vertical|horizontal` measures directional artwork and rotates it onto the requested axis.
- `--stripes` measures one period of regular ribbing and rebuilds it before resizing.
- `--lattice` measures periods on both axes and crops a regular waffle/grid source to whole cells before
  resizing. It preserves cell-to-cell variation, unlike `--stripes`, which repeats one measured rib.
- `make_transition.py --amplitude` scales the syrup lobes; `0.35–0.55` gives a quiet flowing band while
  `1.0` makes a deliberately drippy edge.
- `--repair` applies Slopesmith's half-offset edge blend before conditioning. It is useful for organic
  frosting, snow, soil, and gravel with a slight residual seam; avoid it on geometric patterns because it
  can ghost their structure.

`--stripes` and `--lattice` are alternatives. Use neither for organic artwork, and do not combine a geometric
period fit with `--repair` unless the source has been visually checked for ghosting.

The seam score compares the first/last edge discontinuity against ordinary interior variation. Values
below about `1.6` are normally clean; values above `2.5` deserve a new source candidate rather than a
heavy repair.

Run the focused operation checks with:

```bash
python Slopesmith/tools/texture-conditioning/test.py
```
