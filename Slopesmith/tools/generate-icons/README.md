# GenerateIcons — brand icon set builder

Turns the drawn Slopesmith mark into every icon the page links to. `media/slopesmith_anvil_icon_source.png`
is the only artwork; the SVGs, the home-screen tiles, the favicon, the social card, and the web
manifest are all generated from **one vector trace** of it, so they cannot drift apart.

## Usage
```bash
python -m pip install -r Slopesmith/tools/generate-icons/requirements.txt
python Slopesmith/tools/generate-icons/makeicons.py
python Slopesmith/tools/generate-icons/makeicons.py --sheet temp/icons.png   # + a contact sheet to eyeball
```
Requires: `numpy Pillow potracer` (`potracer` is a pure-Python potrace, so nothing needs compiling).

`potracer` is a port of potrace and carries potrace's **GPL**, unlike the permissively-licensed numpy
and Pillow beside it in `requirements.txt`. That is fine for what it does here: it is a build-time
tool run by hand, it emits vector path data rather than code, and neither it nor anything derived
from it is redistributed by this repository. Nothing links it, and the generated assets in `public/`
are not derivative works of the tracer.

Re-run after editing the source PNG, or after changing `NAME`, `TAGLINE`, or `DESCRIPTION` at the top
of the script. The tagline is baked into `og-image.png`; the description is baked into
`site.webmanifest`. Keep the matching metadata in `index.html` aligned when either changes.

## How it works
1. **Split** — the supplied source PNG is an opaque, high-contrast white mark on the app's dark
   tile colour. A luminance threshold extracts the complete mark, including its enclosed highlights.
2. **Trace** — potrace fits cubic Béziers to the artwork mask. Holes fall out of the nesting and
   are filled `evenodd`.
3. **Emit** — every asset is a layout expressed against the traced artwork bounds.
4. **Check** — the traced geometry is rasterised back over the source mask and the disagreement is
   printed. It should stay near 0.1% of the canvas, which is edge antialiasing being resolved to a
   hard vector edge. A jump means the trace no longer matches the drawing.

## Outputs (all into `public/`)
| File | What |
|------|------|
| `slopesmith_icon.svg` | favicon: mark centred in a square, with a `prefers-color-scheme: dark` rule that flips the artwork white so it survives a dark tab strip |
| `slopesmith_icon_light.svg` | the inverse cut — artwork alone, interiors open — cropped tight for the top bar's wordmark |
| `favicon.ico` | 16/32/48 fallback for browsers that will not take an SVG |
| `apple-touch-icon.png` | 180×180 iOS home screen |
| `icon-192.png`, `icon-512.png` | manifest icons, `purpose: any` |
| `icon-maskable-512.png` | `purpose: maskable` — art pulled into the middle 80% to survive a circular crop |
| `og-image.png` | 1200×630 social card, mark over the wordmark |
| `site.webmanifest` | name, standalone display, theme/background colours, the icon list |

Tiles are opaque rather than transparent on purpose: iOS masks the corners itself and paints
transparency black.
