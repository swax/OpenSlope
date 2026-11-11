# Blender

**Inspect and model OpenSlope course assets in Blender.** These exploratory tools open
Snowknife maps and glTF bundles, support sidecar-data round trips, and provide terrain and
prop-modeling experiments. For a complete course-authoring workflow, start with
[Slopesmith](../Slopesmith/README.md).

## Open a map

Install Blender. The PowerShell launchers find it under `C:/Program Files/Blender Foundation/`
or on `PATH`. Start with a portable `Maps/MYMAP/` folder from Slopesmith or
[Snowknife](../Snowknife/README.md). Put Snowknife on `PATH`, then run from the OpenSlope repository root:

```powershell
snowknife gltf Maps/MYMAP MYMAP
./Blender/open-bundle.ps1 -BundleDir Maps/MYMAP/gltf
```

The launcher opens the bundle in Blender with its textures and baked lighting. For an imported
map's OBJ props instead, use:

```powershell
./Blender/open-level.ps1 -LevelDir Maps/MYMAP
```

That launcher requires `Props.obj`; use the glTF bundle to view terrain. The supplied launchers
are for Windows PowerShell. On other platforms, run the [Python bundle loader](open_bundle_in_blender.py)
with `blender --python Blender/open_bundle_in_blender.py -- Maps/MYMAP/gltf`.

## Documentation

- [Terrain authoring and trail carving](docs/001-nurbs-terrain-authoring.md) — Bézier/NURBS experiments.
- [Prop remodel round trip](docs/002-prop-remodel-roundtrip.md) — take a prop through Blender and back into a map.
- [Slopesmith Blender bridge](../Slopesmith/docs/046-blender-bridge.md) — edit a prop and bring it back into the editor.
- [Snowknife bundle contract](../Snowknife/docs/034-bundle-pipeline.md) — input files and coordinate conventions.

## Content and license

Keep imported disc assets local/private; see [LEGAL.md](../LEGAL.md). Repository-authored material
in this component is licensed under [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0).
