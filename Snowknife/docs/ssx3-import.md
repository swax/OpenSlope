# Import the SSX 3 mountain

`snowknife ssx3-import` reads the mountain from a user-supplied *SSX 3* PS2 disc and writes it as an ordinary
map folder that Slopesmith opens as a Reference, the same way it opens a Tricky `import`. Like every Snowknife
command that reads retail data, it works only from your own disc image, and its output stays local and gitignored;
see [LEGAL.md](../../LEGAL.md).

```powershell
$iso = "discs/ssx-3-usa.iso"
$snowknife = "Snowknife/Snowknife/bin/Debug/net10.0/snowknife.dll"
dotnet $snowknife ssx3-sections $iso                       # what is on the mountain
dotnet $snowknife ssx3-import $iso PEAK1 Maps/SSX3_PEAK1   # one peak
dotnet $snowknife ssx3-import $iso ARA1  Maps/SSX3_ARA1    # one event
```

Reload Slopesmith after importing; the folders appear in the Reference picker as "SSX 3 extract".

The SSX 3 formats and measurements this command relies on are specified in Trailmap's SSX 3 addendum,
[chapter 510](../../Trailmap/specs/510-series-ssx-3.md), and its detail chapters
[511](../../Trailmap/specs/511-ssx3-terrain-and-lightmaps.md) (terrain and lightmaps),
[512](../../Trailmap/specs/512-ssx3-textures-and-materials.md) (textures and materials),
[513](../../Trailmap/specs/513-ssx3-props-and-collision.md) (props and collision),
[514](../../Trailmap/specs/514-ssx3-paths-rails-and-sky.md) (paths, rails and sky) and
[515](../../Trailmap/specs/515-ssx3-lights-halos-and-fog.md) (lights, halos and fog). This page covers how the
importer converts them for Slopesmith.

## The mountain and its sections

*SSX 3* has one streamed mountain rather than a file per course: `DATA\WORLDS\BAM.BIG` holds `bam.sdb` (the
section list), `bam.ssb` (every section's resources as a run of `CBXS`/`CEND` RefPack blocks), and
`bam.phm`/`bam.psm` (resource names). All sections share one Z-up world space in the same centimetre units as
Tricky, so any selection lines up with any other.

SSX-Library owns the binary readers: `SSBHandler.ReadResources` follows the SDB's chunk offsets and
`WorldAIP` reads AI data. Snowknife selects sections and converts those resources into the map format used
by Slopesmith, including its texture, lightmap, collision, and race-path adaptations.

| Section | What it is |
|---|---|
| `A`, `B`, `C`, `D`, `E` | Hubs. Peak 1 is A and B (the bottom of the mountain), peak 2 is C and D, peak 3 is E. |
| `ARA1`, `ASS1`, `BHP1`, `ABC1`, … | Events: race (`RA`), slopestyle (`SS`), halfpipe (`HP`), big air (`BA`), backcountry (`BC`). |
| `A_ARA1`, `ARA1_B`, … | Connectors between a hub and an event, or an event and the next hub down. |
| `ASKY` … `ESKY` | Each hub letter's sky dome. |
| `TRANSP` | Shared models; no terrain. |

`<selection>` is a section name, a comma list of them, `PEAK1`, `PEAK2`, `PEAK3`, or `ALL`. An event name brings
its own connectors. The whole mountain is about 30,600 patches and 41,000 props, roughly ten Tricky courses; it
loads on a desktop browser but is far beyond the standalone-headset budget, where a single peak or event is the
practical size.

## What the folder contains

| Output | From | Notes |
|---|---|---|
| `Patches.json`, `Textures/` | SSB patches (type 1) and shapes (type 9) | Same Bézier form and UV corner order as Tricky. Texture IDs are mountain-wide; alpha is kept only where it is transparency (below). |
| `Lightmaps/` | SSB lightmaps (type 10) | Re-encoded onto Tricky's scale and resampled to Tricky's cell addressing (below), at 128 px. |
| `AIP.json` | SSB AIP (type 14) | Every AI path of the selected sections; the course's race lines (type-1 track paths) and start grid. |
| `Splines.json` | SSB splines (type 8) | Rails only; see below. |
| `Instances.json`, `Models.json`, `Meshes/`, `Materials.json` | SSB instances, models, materials (types 3, 2, 0) | Models and materials may come from any section. Meshes keep the game's vertex order, and each instance carries its baked lighting (below). |
| `Collision/` | SSB collision (type 12) | Shared by placements of a model within each section. |
| `Lights.json` | SSB lights and halos (types 6, 7) | Spot and point lights, and the halos as glint-only rows; suns and ambients left out (below). |
| `ParticleModels.json`, `ParticleInstances.json` | SSB particle models and placements (types 4, 5) | Tricky's fog-bank layout. |
| `Effects.json` | | Empty: no effect slots, graphs or functions, with `target.game` `ssx-3`. |
| `Skybox/` | The selection's sky section | Rebuilt as Tricky's sky ring, then measured by the Tricky skybox exporter. |
| `Origin.json` | | `retail`, with `Course` set to `SSX3_<selection>`. |

## Conversions, and what is inferred

**Lightmaps.** SSX 3 stores the same two-term GS blend as Tricky, alpha A_S and residual RGB C_S: deep blue,
low-intensity texels in shadow and neutral, high-intensity texels in sun. The difference is the base it is
subtracted from. Tricky's textures sit on disc at PS2 half brightness, while SSX 3's are full range, so the lit
result is `(C_D - C_S)·A_S/128` rather than Tricky's `(0.5·C_D - C_S)·A_S/128`. Halving the residual and doubling
the alpha makes the two identical, which is what the importer writes; a texel whose doubled alpha would overflow
is re-encoded at full alpha for a white base. Fitting a sun to the converted lightmaps scores best under the same
transposed patch-to-lightmap orientation Tricky uses.

The cells are addressed differently, though. SSX 3 puts a patch's corners on the outer edges of its cell's corner
texels, as the GS samples a texture coordinate, so the two patches either side of a seam both read the blend of the
texels straddling it; its cells are accordingly 2, 6, 14 or 30 texels. Tricky's cells, and Slopesmith's lookup, put
the corners on the corner texels' centres. Read the Tricky way, every SSX 3 seam is half a texel off on both sides,
and neighbouring patches visibly disagree. The importer resamples each page bilinearly onto a 128 px grid whose
texel centres fall on the source's texel edges, then widens every cell by one texel. Measured across the shared
edges of Race 1's patches, the mean intensity step at a seam drops from 6.5 to about 0.5 (raw alpha units),
below the Tricky courses' own.

**Course and start.** One event uses its own race. A peak or `ALL` uses the hubs' peak-race AIPs, ordered top to
bottom with each lower race's distances added on so the lines chain. Those resources cover the hubs, not the event
runs between them, so a peak's course line is partial. The start grid stores positions; each one is matched to the
course's AI path leaving it, which is the form Tricky's `StartPosList` takes.

**AI network.** The AI paths are not limited to the course's: every AIP resource of the selected sections adds its
paths, the events', connectors' and hubs' own along with the peak races and showoffs, so a peak carries the whole
peak's network (Peak 1: 467 paths where its peak races have 11) and `ALL` all 1,214. The course's paths come first,
then the rest from the highest start down. Slopesmith's predicted-speed wash and its AI riders both ride the whole
network; with only the peak races' paths they covered the hubs alone.

**Surface types** come from the patch's first flag field, mapped by what the artists' patch names suggest:
powder, deep powder, ice, trees and metal; everything else rides as snow. Treat them as approximate.

**Rails.** SSX 3 keeps grind rails and animation paths (birds, rockets, the gondola) in one spline list, with only
the name to tell them apart. Names with `rail`, `slide`, `log`, `fence` and similar become wood or metal grinds;
paths, handplant spots and the gondola are dropped.

**Transparency.** A material's render-state word is 1 for opaque, 3 for alpha-tested, 7 for blended, with bit
0x40 on the additive glows; any of those alpha bits becomes Tricky's alpha-pass bit (`UnknownInt18` 0x40000), and
Slopesmith then reads the page's own alpha to choose cutout or blend, as it does for Tricky. Without it the billboard
tree groups (`con_bboard_*`) drew their transparent background black.

**Texture alpha that is not transparency.** Many SSX 3 pages carry a glitter or gloss mask in their alpha instead:
most of the icy and carved terrain (the streaked ice on Race 3's bends, texture 376, is under 64 everywhere and
zero over most of the page), and much of the opaque prop art. The patches that reference a dark glitter page
(`U14`: textures 62, 198, 297) presumably add it through that mask; Slopesmith has no such pass. Left in, the mask
did harm twice over. Slopesmith packs pages through a premultiplied canvas, which loses the colour under low alpha,
so masked areas came out flat grey and posterised; and a mask that happens to look binary (texture 653, on 705
patches) is classified as a cutout and would punch holes in the ground. So a page keeps its alpha only for a use that
means it: an alpha-pass prop material, or terrain whose alpha really is a hole mask, with at least 5% clear and 25%
solid. Across the mountain that is one terrain page, the trusses on EBA3's metal ramp (texture 307). Everything else
is written opaque, and a page used both ways gets an opaque copy, `NNNN_o.png`, beside it.

**Palettes.** An 8-bit page's palette is stored in the GS's swizzled CLUT order, where each block of 32 entries swaps
its second and third runs of eight, and is padded past the colour count its header gives. A colour whose swizzled slot
lands in the padding used to decode as transparent black, and every pixel using it was a black speck: colours
232–235 of texture 479 (the streaked ice with direction chevrons on Race 3), 200–207 of 694, and so on across 30-odd
pages. The SSX-Library fork's `WorldSSH` now reads the padding too. The few specks left are palette entry 0, a real
transparent colour, on alpha-pass prop art (the ravens, groomers, shrubs and the BRA2 factory), where they are holes
as the game draws them.

**Hidden helpers and collision.** SSX 3 draws its helper geometry with one orange debug page, texture 17, which no
visible prop uses: collision fences and proxies, trigger, one-way and fail volumes, reset planes, teleports, and the
load/unload and ride-state boxes. Any model drawn only with it is written `Visable: false`, as are the few triggers,
volumes and load boxes that borrow a real page, by name. A collidable model's collision is stored once in each
section that places it, in the model's own space, and named after the first instance there:
`<instance>_CollideModel_ConvexHull|ProgMesh`. Every instance of that model in the section shares it as its triangle
proxy, so the one resource for the `rock_de_bolder_d` boulder serves all 439 placements. Read as one resource per
instance, about two-thirds of the rocks and many trees had no collision. Among the helpers, only the invisible course fences and fence proxies keep their collision: reset planes and
volumes would be plain walls without their effects, the start- and end-mode gates close only during an event, and a
cutscene's fences only during the cutscene.

**Prop lighting.** SSX 3 has no per-instance light record like Tricky's. Each instance instead carries one
ABGR1555 colour per vertex of its model, already lit, in the order the model's vertex records stream to the console
([chapter 513](../../Trailmap/specs/513-ssx3-props-and-collision.md)). Each part's mesh is written in that order,
one OBJ vertex per streamed vertex, and its `MeshData` entry records where the part starts in the stream
(`VertexLightingBase`). The instance's colours go into `Instances.json` as `VertexLighting`, the base64 of the raw
little-endian halfwords. An instance whose colours do not cover its model exactly is written without them, and
Slopesmith then draws it at the texture's own brightness. On the whole mountain that is one instance, the jumbotron
on CBA2's start building. Slopesmith multiplies each texel by its vertex's colour the way the GS does, with 16 of
31 drawing the texture as stored.

**Sky.** Each sky dome is a cap, a floor, and eight upper and eight lower wall panels. The walls are rebuilt as
the flat quads Tricky's ring is made of, at their own azimuths and band heights, and the floor is flattened into
the ground slot; the cap has no slot and is left out.

**Lights.** Only the spot and point lights are written. An SSX 3 light keeps its colour and intensity apart
where Tricky's `Colour` holds their product, so the importer writes the product; a negative intensity then gives
the negative colour Slopesmith reads as a subtractive light. The spot's outer cone cosine goes to `UnknownFloat2`,
the one cone field Slopesmith reads. Suns and ambients are left out because nearly all of them are one horizontal
placeholder, and Slopesmith seeds a reference's sun from the first sun it finds rather than fitting it to the
lightmaps. SSX 3 lights have no names, so each is named `<section>_light_<id>`.

**Halos.** Tricky has no halo record; it draws the same sparkle from a light whose `SpriteRes` is a small class.
Each halo is written as a point light with its sprite size as `SpriteRes` and an empty influence box at its
position, so Slopesmith draws its glint and it lights nothing. Halos are named `<section>_halo_<id>`.

**Fog.** The particle models and placements are read with chapter 515's offsets and written in the Tricky
import's `ParticlePrefabs` and `Particles` shapes. A placement pairs with its model by section and resource id,
and points at that model's index in `ParticleModels.json`. Both are named `<section>_particle_<id>`.

**Effects.** SSX 3 has no SSF; its world logic is compiled scripts that nothing decodes yet
([chapter 510](../../Trailmap/specs/510-series-ssx-3.md)). The importer writes an
empty `Effects.json` because Slopesmith loads one for every reference. The document's `header` holds the SSF
header's three fields, written as zero here.

## Not yet carried

Sounds, the per-event mode props' visibility, and the world scripts behind effects.
`ssx3-raw` dumps the library's own per-section JSON/OBJ/PNG extraction for further research.
