# 002 — Prop Remodel Round-Trip (Blender ↔ snowknife)

How to take a game prop out of the extracted level data, remodel it in Blender (new geometry,
doorways, interiors, retextures), and ship it as an **override package** so every placement of
that prop — in every level that uses it — picks up the change on every map rebuild. The worked
example throughout is the **MediaTower**: hollowed out with a doorway, a full stairwell, six
furnished floors, and balcony/roof access. The process is prop-generic. Background: props
[003](../../Unity/docs/unity/003-props.md), collision
[009](../../Unity/docs/009-collision.md), materials/alpha
[005](../../Unity/docs/unity/005-materials-and-alpha.md), CLI
[001](../../Snowknife/docs/001-cli-export-pipeline.md), and bundle
[034](../../Snowknife/docs/034-bundle-pipeline.md).

Files: `Snowknife/Snowknife/Export/PropOverrides.cs` (the package installer) and
`Snowknife/Snowknife/Bundle/TextureBundle.cs` (`LoadOverrides`). The worked example's own artefacts —
`Blender/MediaTower/MediaTower_v4/` (`tower.blend` + `export_tower.py` + `tex/`) and
`Maps/Overrides/MediaTower/override.json` — are hand-authored local content and are gitignored, like every
remodel package; the paths below name where they sit in a working copy, not files a clone ships.

## The shape of the loop

Static props have **no per-prop GameObject** in Unity — `snowknife` merges every visible instance
into one `Props` mesh. So you never edit a prop in the scene, and you never hand-copy files into
`Maps/<LEVEL>/` either: the remodel lives in a **package** — a folder with an `override.json`
under the `Overrides` sibling of the level folders that names the prop (a `ModelName` prefix) and
points at the exported OBJs. Every pipeline command that reads `Meshes/` installs the matching
packages first, so the loop is:

```
Blender: edit tower.blend, then  blender -b tower.blend -P export_tower.py
Maps/Overrides/<Prop>/override.json   package: match + mesh/collision/texture sources
        │  name-matched + installed automatically by each of:
        ▼
snowknife import <iso> <courseSlot> <mapDir>  fresh import — then re-installs the packages
snowknife props <mapDir>                      install + rebake Props.obj + PropsCollision.obj
snowknife gltf  <mapDir>                      install + rebuild gltf/props.glb + manifest.json
snowknife unity <mapDir> <dest>               copy into <project>/Assets/OpenSlope/Maps/<LEVEL>
        ▼
LevelImporter.ImportFolder("Assets/OpenSlope/Maps/<LEVEL>")   (or OpenSlope ▸ Load ▸ Map…)
```

Installation resolves the prefix against the level's `Models.json` — every chunk variant's
`Meshes/<n>.obj`, every `Collision/<n>.obj` its instances reference, and the texture pages via
each mesh slot's MaterialID — and copies the package's files over them, backing each original up
as `*.orig_bak` once. Because resolution is per level, **one package applies to any level that
ships the prop** (one level's tower body page might be `0058.png`, another's `0037.png`; same package).
The durable master stays outside the extracted folders (the `.blend` + export script); a
re-extract just re-installs. `snowknife overrides <levelDir> --dry` previews what a package would
touch; `--no-overrides` on `import`/`props`/`gltf` gives a vanilla run.

Each command *installs* the package into `Meshes/Collision/Textures`, but for **static props** that
is not the whole story: their geometry is bundled from the pre-baked world-space `Props.obj` /
`PropsCollision.obj`, which only `import` and `props` regenerate (via `PropsExporter`). So a static
remodel reaches the bundle through `props` → `gltf`, in that order — running `gltf` alone after
editing the mesh/collision installs the new `Meshes/` but bundles the stale `Props.obj`, leaving the
prop unchanged. (`gltf` alone *does* suffice for retextures and for **animated** props, which the
bundle reads model-local from `Meshes/` directly.)

`Maps/` is gitignored, `Maps/Overrides/` included — so unlike the rest of the tree the
packages are hand-authored config that exists only in your working copy. Back one up
like any other local source.

### override.json

Paths are relative to the json, so a package points straight at the Blender `export/` folder —
no copy step after a re-export, and bumping the remodel version is editing the version in the
paths. The MediaTower package:

```json
{
  "name":      "MediaTower v4 (fleshed-out interior)",
  "match":     "Mdl_MediaTower_Tall",
  "meshes":    ["../../../Blender/MediaTower/MediaTower_v4/export/tower_body.obj",
                "../../../Blender/MediaTower/MediaTower_v4/export/tower_lattice.obj",
                "../../../Blender/MediaTower/MediaTower_v4/export/tower_mesh.obj"],
  "collision": "../../../Blender/MediaTower/MediaTower_v4/export/tower_collision.obj",
  "textures":  { "0": "../../../Blender/MediaTower/MediaTower_v4/tex/body4.png" },
  "alpha":     { "0": "blend" },
  "privatePages": { "0": { "texture": "tex/skin.png", "page": "tower_priv.png", "alpha": "blend" } },
  "alphaPages":   { "0058.png": "opaque" }
}
```

- `match` is a `ModelName` **prefix**: `Mdl_MediaTower_Tall` catches the `_1000/_2000/_5000`
  chunk variants but not `Mdl_MediaTower_Fat` (a different prop on another level).
- `meshes` is one OBJ per **mesh slot**, in the model's `MeshData` order (the tower's
  body/lattice/mesh trio). Every matched variant must have the same slot count or the package is
  refused whole.
- `collision` (optional) replaces every collision proxy referenced by an instance of a matched
  model. Visuals and collision are **separate files** — without this, a new doorway is a wall you
  can see through and not enter.
- `textures` / `alpha` are keyed by slot **index**, not page filename — the page is resolved per
  level through the slot's MaterialID, and `alpha` merges into `TextureAlpha.overrides.json` (§3).
  The installer warns when a resolved page or collision proxy is shared with non-matching props.
- `privatePages` (optional) gives the matched models their **own** copy of a slot's page instead of
  repainting the shared one: it installs a NEW page, clones the slot's material onto it (appending to
  `Materials.json`), and repoints the matched models' `MeshData.MaterialID` there. Use it when the
  page is still referenced by a *sibling* prop the remodel doesn't touch — e.g. `Mdl_MediaTower_Fat`
  shares the Tall body's `0037.png`, so repainting it would wreck the Fat towers; a private page leaves
  `0037` vanilla for them. Keyed by slot index → `{ texture, page, alpha }`. Idempotent across re-extracts.
- `alphaPages` (optional) forces an alpha mode on **any** page by filename (not tied to a slot) — an
  escape hatch for correcting a page's classification when the data-driven flag (§3) can't, e.g. on a
  synthetic page a remodel introduces.
- `levels` (optional) is an allow-list of level folder names when a remodel shouldn't go everywhere.

## 1 — Author a package: find the prop

The installer resolves file numbers automatically at install time; authoring a package only needs
the `match` prefix and the slot order, read once from the level tables. Everything keys off
`Instances.json` + `Models.json`:

- Instance → `ModelID` (index into `Models.json`) → `ModelObjects[].MeshData[]` =
  `{ MeshPath: "<n>.obj", MaterialID }`; `Materials.json[MaterialID].TexturePath` = the page.
- Instance → `CollsionModelPaths` = the **collision proxy** in `Collision/` (with
  `CollsionMode == 1` + `PlayerCollision == true`; see
  [009](../../Unity/docs/009-collision.md)).
- One prop often exists as **several near-identical ModelIDs** (one per level chunk, e.g.
  `_1000/_2000/_5000` suffixes) — which is exactly what the prefix `match` sweeps up.
  MediaTower in this worked example: ModelIDs **47/121/181**, meshes `84/85/86`, `229/230/231`,
  `323/324/325` (body/lattice/mesh per trio), mats **50/51/52** → `0058/0059/0060.png`,
  collision `16/74/338.obj` — 11 instances total.

Check texture sharing before repainting a page (`Materials.json` → who else uses that
`TexturePath`); `0058.png` is tower-exclusive in this level, but e.g. the diamond-mesh page is shared
with the wire props. The installer repeats this check per level and warns.

## 2 — Source meshes ↔ Blender

`Meshes/*.obj` are **model-local, game units (cm), Z-up, no axis swap** — Blender world space is
the same space at ×0.01 (see
[004](../../Unity/docs/unity/004-orientation-and-scale.md) for the importer-side handedness;
that negate-X happens downstream and is *not* this layer's concern). The convenient setup, as in
`tower.blend`:

- Import/assemble the source meshes as one object with **scale 0.01** and a Z **location offset**
  that puts the base on the Blender floor. Keep that object untouched as the transform reference:
  `obj.matrix_world.inverted()` maps any world-space point back into source-file coordinates, so
  the export never hand-derives the convention. (Tower: offset z = 14.857, file z range
  −1487…+4863.)
- Build new geometry as **separate objects** (`OpenSlope_Floors`, `OpenSlope_Stairs`,
  `OpenSlope_Furniture`, `OpenSlope_Patches`) at identity transform in world meters — easy to tweak
  or delete individually; the exporter folds them in. The export script matches whatever object names
  the `.blend` actually carries, so an older file's naming keeps working.
- **Reuse the prop's existing materials/pages** rather than adding texture pages. Two UV
  strategies cover everything: *fit-to-rect* (map each face's bbox into a clean texel rectangle —
  a concrete panel, a window pane) for plain surfaces, and *planar world-tile* (uv = world/k) for
  repeating cutout grids like the deck plate. Mapping furniture "screens" into the window texels
  gives free glowing glass.

### Cutting doorways in a game shell

The shells are **open, zero-thickness skins**, which makes boolean DIFFERENCE messy in two
specific ways:

1. The boolean can't decide inside/outside, so it leaves the cutter's own faces behind as a gray
   **plug** filling the hole. Sweep them after applying: delete every face whose verts all lie
   inside a (slightly inflated) cutter box.
2. That same sweep eats any **walkable slab the cutter dips into** — a cutter whose bottom sits
   below a balcony/deck surface deletes the floor piece inside its footprint (threshold holes,
   deck holes). Either start door cutters *exactly at* the walking surface, or patch the holes
   with flush boxes afterwards (the tower's patch object).

Where the prop has a shared interior wall as two coincident planes (tower body back + stairwell
slab front), one cutter box spanning both cuts the doorway through both at once.

## 3 — Translucent windows: force the blend path

The remodel's frosted windows are genuine translucent glass, not binary holes: the private body page has
opaque wall texels and a broad partial-alpha band for the windows, with no fully transparent texels. It wants
the **blend** path so Unity, Slopesmith, and glTF previews composite those window texels smoothly instead of
turning them into alpha-hash grain. Opaque wall texels remain alpha 1. The data-driven alpha flag
([005](../../Unity/docs/unity/005-materials-and-alpha.md) §5) won't pick blend on its own here: the private page is
cloned from the solid building material and inherits that material's **opaque** flag. So you force it. If a
future remodel needs several overlapping glass shells, split the glass onto its own material rather than
putting the whole hollow building through one transparent surface.

`TextureBundle` reads a per-level override for exactly this:
`Maps/<LEVEL>/TextureAlpha.overrides.json`

```json
{ "mediatower_tall_priv.png": "blend" }
```

wins over the data-driven flag in Slopesmith preview and at `gltf` time, and survives re-runs (it lives
beside the level data, not in the regenerated manifest). The package maintains these entries for you — `alpha` (slot-keyed),
`privatePages[].alpha` (the synthetic page), or `alphaPages` (any page by name).

## 4 — Export from Blender

`export_tower.py` beside the `.blend`, run headless so it works from the saved file without a
live session:

```
blender -b tower.blend -P export_tower.py
```

It triangulates every object (booleans leave concave n-gons — never fan-triangulate by hand),
buckets faces by material kind, converts world → source space via the reference object's inverse
matrix, and writes to `export/` — the files the package's `meshes`/`collision` entries point at:

- one **visual OBJ per mesh slot** (`v/vt/vn`, triangles) — the installer copies each over the
  matching `Meshes/<n>.obj` of every ModelID variant;
- one **merged collision OBJ** (`v/f` only) — all visual groups concatenated. Collision proxies
  are authored in instance-local space, which for single-object models *is* the mesh space, so the
  same transform applies. Using the full visual set (~1.7k tris) instead of the original ~370-tri
  hull is what makes doorways enterable and stairs/floors/railings walkable.

Collision geometry can be **flat 2D sheets** — no thickness, no manually doubled back-faces, and
winding doesn't matter. The game's own data works this way (a chain-link fence collision proxy is
a single quad: 2 tris, 4 verts), and although Unity MeshColliders are natively one-sided,
`CollisionBundle` emits every prop-collision triangle with **both windings** at `gltf` time
([009](../../Unity/docs/009-collision.md)), so every sheet collides from both sides in-world. Model
walls/floors as single faces and let the bundle make them two-sided.

## 5 — Install, bake, import

```powershell
snowknife overrides Maps/<LEVEL> --dry      # optional: preview what the packages resolve to
snowknife props  Maps/<LEVEL>               # installs the packages, then rebakes
snowknife gltf   Maps/<LEVEL>
snowknife unity  Maps/<LEVEL> <project>/Assets/OpenSlope/Maps/<LEVEL>
```

In Unity, refresh assets and re-run the level import (`LevelImporter.ImportFolder` is the
programmatic entry; the menu item is the same thing with a folder picker). The import rebuilds the
merged Props mesh, the materials (the override shows up in the alpha-cutout list of the import
summary), and the collision buckets in one pass. Verify count: the prop's submesh tri count should
be (new tris) × (instance count) exactly.

## Gotchas

1. **Visuals and collision are separate files.** A package without a `collision` entry leaves the
   old solid hull in place — the new doorway will be a wall you can see through and not enter.
2. **`match` must sweep every variant and only yours.** Wide enough for every `_N000` chunk
   suffix, narrow enough to miss sibling props (`Tall` vs `Fat`). `--dry` shows exactly which
   models matched.
3. **Don't repaint a shared texture page** — heed the installer's shared-page warning (it changes
   every prop on that page).
4. **Boolean plugs and slab holes** (§2) — sweep + patch, then *visually verify every cut*.
5. **Whole-prop blend = see-through walls.** Frosted windows on solid props go through the
   package's `alpha: cutout` (§3), not blend.
6. **The `.blend` + export script is the master.** `snowknife import` writes vanilla files and
   re-installs the packages itself; the only state that matters is the package pointing at the
   right export. `--no-overrides` is the escape hatch for a pure-vanilla extract.
7. **Headless export beats live-session export** — `blender -b` works whether or not Blender is
   already running, and never touches the artist's open scene.
8. **`props` before `gltf` for static-mesh/collision edits.** `gltf` bundles static geometry from the
   pre-baked `Props.obj`, not from `Meshes/`, so running `gltf` alone after a mesh/collision change
   produces a byte-identical bundle. Always `props` then `gltf` (§5). Verify the bundle actually moved:
   the "merged N verts" line and `props.glb` byte size should change (or `sha256sum props.glb` before
   vs after). Retextures and animated props are exempt — those `gltf` picks up on its own.
