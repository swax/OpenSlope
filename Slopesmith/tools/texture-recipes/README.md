# Texture recipes

Terrain tiles for Slopesmith's Asset Library, authored as re-runnable Python rather than photographed
or generated from a prompt. A recipe reads like a spec, re-bakes at a different feature scale or
contrast by changing a constant, and proves itself against the shipped levels' own snow before it
saves.

The sibling of [`prop-recipes`](../prop-recipes/README.md), and the same bargain: nothing is
hand-edited, so nothing is lost, and the numbers in a recipe come out of measurement rather than
judgement. It is a much smaller pipeline, because a tile needs no Blender — one process, numpy and
Pillow, under a second end to end.

```
_texture.py            the field, the ramp, the guards, save and preview
measure.py             measures the SHIPPED snow — start here
check.py               validates every recipe without writing anything
build_all.py           repaints every tile; --install puts them where the editor reads them
surface/               open ground
  <name>.py            a recipe: bands in metres, two ramp colours, a step count
build/                 ignored scratch: <name>.png and its preview
```

Recipes live in a folder, so `check.py` and `build_all.py` both search one directory down and the
root stays tools-only. A recipe resolves the shared library one level up:

```python
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
```

## What a snow tile actually is

Four measurements decide everything here, and none of them is obvious from looking at snow. All came
out of `measure.py`, run over the ten pages the shipped levels really paint their mountains with.

Add `--adjacency` when choosing which pages are reference *fields*. Its `self%` column measures how often a
page meets itself across a shared terrain edge: a high value identifies a repeated field, while a low value
usually identifies a mural, transition, or one-off accent even when its raw usage count is large.

```
page              uses   size  mean RGB           grain  skew  cols  axis%  seam u/v
SNOW/0048.png      657   128  [224. 234. 236.]    11.6 -0.10    19  99.63  0.94/0.76
SNOW/0046.png      155   128  [222. 232. 235.]    20.9 -0.69    31  99.89  1.04/1.01
SNOW/0047.png      148   128  [215. 227. 232.]    26.5 -0.74    25  99.86  1.17/1.23
SNOW/0045.png      143   128  [215. 227. 231.]    26.4 -0.77    24  99.84  1.18/1.14
SNOW/0053.png       90   128  [224. 233. 236.]    20.5 -0.65    34  99.85  0.57/1.25
GARI/0019.png     1904   128  [214. 219. 225.]    11.8 -0.12    22  99.55  0.96/0.80
GARI/0012.png      378   128  [211. 219. 229.]    26.8 -0.55    94  99.79  0.94/1.06
ELYSIUM/0052.png  2162   128  [224. 234. 236.]    11.6 -0.10    19  99.63  0.94/0.76
ELYSIUM/0059.png   328   128  [211. 219. 229.]    26.8 -0.55    94  99.79  0.94/1.06
MERQUER/0006.png  1319   128  [229. 229. 229.]    26.1 -1.44    30  100.00  1.03/0.98
```

**A tile is a scalar field pushed through ONE colour ramp.** 99.55–100% of every shipped page's colour
variance lies on a single axis, and it is the same axis every time: `(0.742, 0.511, 0.431)`. Snow has
no hue variation whatsoever. What it has is depth of shadow, and shadow on snow is skylight, so red
falls fastest and blue barely moves. There is nothing to paint — there is a field, and a ramp from a
near-neutral white to a blue.

**Its palette is tiny, and every channel value is odd.** 19 to 94 colours on a 128² page. The
extracted art lives on a 7-bit lattice (`1, 3, 5, … 253`): pure white 255 appears nowhere in a shipped
page and neither does any even value, because the console stores 7 bits per component and the
extractor expands them as `2v+1`. This is most of what separates these tiles from a modern
noise texture, which emits tens of thousands of colours where retail emits twenty. `ladder()` builds
the whole palette up front and `paint()` only ever indexes into it, so the count is a stated
constant rather than an outcome.

**One tile covers 15–30 m of mountain.** Measured over SNOW's 1103 snow patches, a repeat spans 23 m
along `u` and 16 m along `v`; an authored Slopesmith mountain defaults to 30 m grid spacing. Take it
as **20 m, or 16 cm/px**, and most art questions answer themselves: a snowboard's edge cut is 15 cm
and lands on ONE pixel, a boot print is sub-pixel, a ski track is a 1–2 px line, and the smallest
thing that can be *drawn* rather than implied is a 2–3 m drift. Bands are therefore written in metres.

**The histogram always leans to the light.** Skew runs −0.10 to −1.44 and is never positive. Snow is a
bright surface with shadow cut into it, not a grey surface with highlights added.

**Anything directional runs down the image, because texture V is the fall line.** Comparing each
texture axis against the downhill direction in its own patch plane, across SNOW's patches, V wins
every time: 0.85 on `0045`, 0.86 on `0047`, 0.99 on `0053`, against 0.52–0.69 for U. Every shipped
streaked page is drawn as vertical stripes, so those stripes point down the hill. A cell aims them
with its D4 orientation, and the F overlay is how you match one by eye (docs/005).

Two pairs in that table are the same file: `SNOW/0048` is `ELYSIUM/0052`, and `GARI/0012` is
`ELYSIUM/0059`. Snow pages travel between levels, which is worth knowing before building a fifth
variant of one.

### The two families

`measure.py --scales` splits the shipped set cleanly in two — not on contrast or colour but on
**streaks**, the share of the tile that survives being averaged down every column:

```
page              10.0-20.0m  5.0-10.0m  2.5-5.0m  1.2-2.5m  0.6-1.2m  0.3-0.6m    u/v  streaks
SNOW/0048.png          0.0%      2.8%      4.3%      6.2%     23.9%     50.2%   0.40    1.4%
GARI/0019.png          0.0%      2.8%      4.4%      6.4%     23.6%     50.4%   0.40    1.3%
MERQUER/0006.png       0.8%      3.1%      4.4%      6.7%     21.0%     51.9%   0.70    1.8%
SNOW/0053.png          1.3%      5.0%      5.6%     12.0%     23.4%     42.5%   1.47    4.7%
GARI/0012.png         12.2%     20.9%     12.3%     15.5%     15.2%     19.1%   2.84   29.3%
SNOW/0045.png         28.1%     15.4%      3.7%      7.9%     14.1%     24.9%   3.65   40.2%
SNOW/0047.png         29.0%     15.2%      4.9%      7.4%     13.7%     24.0%   4.03   41.6%
```

The **open field** (1–5%) puts three quarters of its variation below 1.2 m and essentially nothing
above 5 m. It is fine, directionless and nearly featureless, and it is what a mountain is made of —
`SNOW/0048` and `ELYSIUM/0052` alone account for 2819 patches. `powder` is this family.

The **tracked** family (29–42%) moves a third of its energy up to 5–20 m and runs it the whole way
down the page. `streaks` is the measurement that finds them, and it is worth having beside
`direction`, because direction alone cannot tell a full-length cut from an elongated blob: `SNOW/0053`
is visibly streaky at 1.47 and scores 4.7%, while `0045` at 3.65 scores 40.2%. `tracks` is this
family.

**What retail calls a streak is not a track.** 95% of `SNOW/0045`'s streak profile is 5 m and wider —
those are scoured *lanes* where dozens of descents have merged, not the mark a rider leaves. At 16
cm/px a ski edge's 10–15 cm cut and a board's 20–40 cm trench are one to three pixels, and a mark that
thin has no octave to live in, so no band ever produces one. That is what `grooves()` is for, and it
is one of the two things in the library that draw rather than filter. `crackle()` is the other, and
it is the same argument about a fracture rather than a cut: a crack in ice is centimetres to a metre
across, and a filter shapes how fast a field varies rather than what shape the variation takes. A
line is a shape. It draws one as the zero contour of a smooth field — irregular, closed, different
everywhere, and periodic because the field is.

### The other ground

Nine of the ten reference pages are snow because snow is what a mountain is mostly made of, but the
shipped levels do paint bare ground, and one measurement changes when they do. MESA covers 869 of its
patches with `0054` and `0058`, which mean `(175, 122, 87)` and `(170, 118, 85)` — red 87 and 85 units
over blue, where no snow page is warm at all. So `_texture.WARMTH` carries a bound per family and a
recipe declares which it is making, `finish(..., family='rock')`; `check.py` prints the declaration
beside the colour count. Everything else — grain, skew, palette size, seam, the single colour axis —
is measured over the whole shipped set and holds whatever family the page belongs to.

## Running one

```bash
python Slopesmith/tools/texture-recipes/measure.py --scales      # what the shipped pages measure
python Slopesmith/tools/texture-recipes/surface/powder.py        # paint one, into build/
python Slopesmith/tools/texture-recipes/check.py                 # validate every recipe
python Slopesmith/tools/texture-recipes/build_all.py --install MY_PROJECT  # repaint all into a project
```

`check.py` runs the recipe with `_texture.finish` intercepted, so it writes nothing, and prints what the
page measured beside the shipped envelope:

```
tracks  (surface\tracks.py)
    128x128 opaque, one tile = 20 m at 16 cm/px, 24 colours, snow family
    mean RGB      [219. 229. 233.]   shipped 211-229 219-234 225-236
    grain                     25.2   shipped 11.6 - 26.8
    skew                     -0.73   shipped -1.44 - -0.10
    colours                     24   shipped 19 - 94
    axis share               99.92   shipped 99.55 - 100.00
    seam u                    0.84   shipped 0.57 - 1.25
    seam v                    1.06   shipped 0.57 - 1.25
    direction                 4.06   shipped 0.4-0.7 open, 2.8-4.0 streaked
    streaks                  35.3%   shipped 1-5% open, 29-40% tracked

    where it varies  10.0-20.0m  5.0-10.0m  2.5-5.0m  1.2-2.5m  0.6-1.2m  0.3-0.6m
    recipe asks           9.0%     17.2%     12.8%      9.7%     13.5%     19.8%
                     (the other 18% is drawn, not banded)
    page measures         0.5%     15.6%     21.1%     16.6%     23.5%     20.7%

    ok    every guard passed
```

A **`.`** marks a number outside the shipped range and is a note, not a failure — that envelope is the
min and max of ten pages, so both edges are single samples. `powder` earns two of them and both are
the palette quantiser rather than the art: rounding each ladder entry to the nearest odd value
scatters it up to one unit off the ideal line, which costs about 0.3 points of axis share, and a
symmetric field gives −0.04 skew where the least-skewed shipped page manages −0.10. Only **FAIL**
lines matter, and they come from `_texture.guards`.

**`direction` and `streaks` carry no envelope at all**, because they are what a recipe is *choosing*
rather than a bar it has to clear. The shipped numbers beside them name the two families so you can
see which one you landed in.

The last rows are the loop worth running. The recipe asks for a share of its variation at each feature
size and the page comes out somewhere near it — the band lobes overlap by design, so shares land
within a few points rather than exactly, and `check.py` follows each `field()`'s bands through
whatever `mix()` did with them so the row is weighted correctly whatever shape the recipe is. Anything
`grooves()` drew has no band and shows up as the shortfall. Move the asked-for numbers until the
measured row sits where the shipped page's does.

## Where the output goes

| | tracked? | why |
|---|---|---|
| `build/` — the tile and its preview | no | rebuilds byte-identically from numpy and Pillow in under a second |
| `<workspace>/projects/<project>/assets/textures/<name>.png` | no | the mountain owns its authored catalogue |

Nothing here is committed but the recipe, and that is the opposite of `prop-recipes`, deliberately.
A prop's GLB is checked in because rebuilding one needs a multi-gigabyte, version-sensitive Blender
that is usually not even on `PATH`, so a fresh clone must not have to. A snow tile needs two libraries
that are already installed. Committing it would create a second source of truth that silently drifts
from the recipe the moment a constant changes — and `build_all.py` really is a checkout bootstrap.

`--install PROJECT` copies into that mountain's `assets/textures/`, which the editor presents as
the open mountain's named entry (docs/005), so an installed tile
is paintable as soon as the page reloads and a `Custom/<name>.png` ref resolves through the viewport,
the model textures and the export copies alike. It **overwrites by name**, which the editor's own
upload path deliberately never does — uploading `powder.png` twice gives `powder_2.png` so no cell's
art can change under it. Here that protection is backwards: a recipe is re-run a dozen times before
it is right, and a fresh name each time would leave the mountain wearing the first attempt. So settle
a tile in `build/` and install it when it is worth painting with.

## Writing one

1. **Measure the shipped page you are answering to.** Not "snow in general" — a specific page, with a
   usage count behind it.

   ```bash
   python Slopesmith/tools/texture-recipes/measure.py SNOW --scales     # what SNOW is made of
   python Slopesmith/tools/texture-recipes/measure.py SNOW/0048.png
   ```

2. **Write the constants.** Bands in metres, `LIT` and `SHADE` off the page's own palette extremes,
   `STEPS` at its colour count. Five or six numbers, each traceable to a column of that table. A tile
   with more than one thing going on `mix`es a field per ingredient by share — `tracks` is lanes,
   cuts and grain at 30/18/52.

3. **`check.py` until the FAIL lines are gone and the bands rows agree.**

4. **Look at `build/_preview_<name>.png`, which is 2×2 tiled at 4×.** A tile at 1:1 tells you nothing
   about either of the two things that matter — whether it wraps, and whether it has a feature
   distinctive enough to become a polka-dot grid down a whole slope. Both only show up next to a copy
   of itself.

5. **`build_all.py --install`, then paint with it** and ride it. Contrast that looks timid on the page
   is usually right on the mountain; contrast that looks right on the page is usually loud.

## Traps

**Seamlessness is not a knob.** `field()` shapes white noise in the frequency domain, so it is
periodic by construction — there is no edge to blend, no mirror, no offset-and-heal. `check.py` still
measures the wrap because anything added *after* the field (a gradient, a drawn mark, a vignette) can
break what the noise guarantees.

**A share is a share of variance, not a filter gain.** A band at 0.4 m and one at 7 m with the same
number in the second column contribute the same amount to the page, even though their filter
amplitudes differ by 17×. `field()` does that conversion so a recipe can be read as a claim about
snow.

**Nothing above about a third of the tile.** A 10 m feature on a 20 m page has nowhere to repeat; it
just tints one corner, and it tints the neighbouring cell's corner identically because both cells wear
the same page. Feature scale is bounded by the tile, not by the mountain.

**A distinctive mark repeats every 20 m, forever.** This is the tile version of the bark-panel trap in
`prop-recipes`: on the page that covers the most ground, distinctive is a defect. Anything with an
identifiable shape belongs on a tile placed a handful of times, not on the base.

**A track that swings paints a braid.** The same trap, one level up, and it is why `grooves(wander=)`
is in pixels and stays small. A carving turn really does swing several metres across 20 m of fall
line, but a track that swings must return to where it started at the tile's edge — and then does the
identical S on every cell below it. The shipped streaked pages drift 6–9 px over their full height and
that is the number to answer to; `tracks` runs 7. Real curvature belongs to the *mountain*, laid down
by which cells you paint, not to the page.

**Quantise last.** `seven_bit` on a value and then arithmetic on the result walks back off the lattice.
`ladder()` quantises the palette once and `paint()` only indexes into it, so a recipe that goes
through those two never has the problem; a recipe that blends two tiles or lays a gradient over one
has to re-snap at the very end.

**The grain has to survive the palette.** 19 colours over a 60-unit ramp is a 3-unit step, and a field
whose variation is mostly slower than a few pixels bands visibly across it. The open field gets away
with a short ladder precisely because three quarters of its energy is under 8 px — if you smooth a
recipe out, lengthen its ladder in the same edit.

**`spread` sets rarity, not contrast.** It says how many standard deviations of the field the ladder
covers, so it decides how often a pixel reaches the extreme colours; the ramp's endpoints decide how
far apart they are. At the default 3.5 the ends land on about one pixel in 5000 — which is what the
shipped pages measure, SNOW/0048's brightest and darkest entries being 0.02% of the page each. Reach
for `SHADE` to change contrast and for `spread` only to change how the tails behave.

## Recipes

| recipe | answers to | what it demonstrates |
| --- | --- | --- |
| `surface/powder.py` | `SNOW/0048` (657 patches) | the plain open field: no direction, no drawn feature, three quarters of it below 1.2 m |
| `surface/tracks.py` | `SNOW/0045` (143), `GARI/0012` (378) | three ingredients `mix`ed by share, `stretch` down the fall line, and the one thing that has to be drawn |

`tracks` is worth reading beside `powder` for what a second ingredient costs. Its grain is the same
open snow at a slightly coarser balance, and everything that makes it a different tile is 30% of
stretched lanes, 18% of drawn cuts, a ramp twice as long, and a `gamma` that bleaches the flats so the
shadow is only in the trenches.
