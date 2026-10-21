# Stock board artwork

The four built-in snowboard designs are **Contour**, **Sunset Rally**,
**Timberline**, and **Night Shift**. Their canonical PNGs live in
[`public/equipment/boards`](../public/equipment/boards/). Native embeds those same
files at build time; it does not require the web application at runtime.

A new game/session board and each full course restart get a random design. Explicit creation, recall, or the
on-foot behind-the-head pull selects another design without an immediate repeat.
Respawning, mounting, dropping, throwing, catching, changing
stance and rebuilding a presentation retain the choice. Mounted and loose models
share one selection. Multiplayer publishes the optional `stockBoard` ID so
observers see the owner's choice; older poses without that field remain supported.
Account-owned artwork and edge colours override the stock design. Skis retain
their existing presentation.

Mounted, held and loose gear uses the same course lighting field and colour
response as avatars, sampled at the gear's world position. Directional light
follows the board's outward-facing normals as it rolls or turns. This applies
to stock and account-owned textures; maps without course probes retain the
normal scene-light fallback.

Each opaque square PNG is two equal vertical panels: **top on the left, base on
the right, noses at the image's top**. Graphics stretch across each panel and
recover their narrow proportions on the deck. Stock UVs follow the sidecut width
and keep lettering inside the curved tips with a 1.1 longitudinal scale and
clamped border ink. Existing account plan UVs remain
compatible. Increment
`stockBoardUrl`'s asset revision when replacing a PNG. The Native geometry exporter
uses explicit plain art so its saved mesh is independent of random image choice.

## Artwork generation

These are original OpenSlope designs made with the built-in image generation
tool. The approved top/base concept sheets were edit references; the four flat
atlases are the final assets. No external board graphics were used. The component's
Apache-2.0 license applies. The common conversion prompt, with the corresponding
design description inserted, was:

> Convert the approved top/base artwork into a production game texture atlas.
> Preserve the illustration, palette, layout and typography. Output one square,
> flat, opaque RGB atlas: left half is a full rectangular topsheet, right half a
> full rectangular base, each 50% width by 100% height, noses at top. Remap/stretch
> each full face to fill its panel; the game maps it back onto a narrow snowboard.
> Preserve OPENSLOPE wordmarks, spelling and orientation. Only the two rectangular
> printed panels, edge-to-edge. No silhouettes, rounded corners, outlines, margins,
> background, transparency, labels, scene, bindings, shadows, highlights, bevels
> or surface lighting. Extend background and graphics to every rectangular edge.
> Keep the approved design recognizable; add no text, marks or decorations.

- **Contour:** cyan contour lines and flowing descent ribbon on charcoal,
  off-white mountains, cyan OPENSLOPE base.
- **Sunset Rally:** orange, cream and navy retro sunset/mountain racing graphic,
  burnt-orange base with cream OPENSLOPE lettering.
- **Timberline:** ivory and pine-green woodcut mountains and conifers, pine-green
  base with ivory OPENSLOPE lettering.
- **Night Shift:** ink black, magenta, lime and white arcade chevrons and checker
  stripe, magenta base with dark OPENSLOPE lettering.

Focused checks: Slopesmith `stock-boards`, `stock-boards-webgl`,
`equipment-texture`, `multiplayer-motion`; Native equipment and avatar-render tests.
