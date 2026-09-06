# 010 — Object lighting

This page documents how the portable per-instance lighting contract is
delivered to Unity props, movers, the board, and avatars. Canonical SSX light
records, normal/vector spaces, shading equation, normalization, and display-
domain modulation live in [Trailmap: 160-lighting-data, 400-rendering]. Terrain
lighting is covered by [007 terrain lighting](007-terrain-lighting.md).

## Bundle contract

`Snowknife/Bundle/PropLighting.cs` owns source-space conversion and the shared
lighting evaluation. `PropsBundle` bakes the final factor into static prop
vertex color before instances are merged. Diverted and animated records retain
ambient, three keys, and three fixed world directions so their shading can be
evaluated after their transforms move.

Native normal indices remain in exporter and bundle weld keys. Geometry,
normal, instance rotation, and light-vector conversion form one contract;
Unity must not recalculate normals or apply the instance rotation a second
time.

Current bundles are required. The importer does not synthesize a one-light or
flat-color fallback when the live lighting payload is missing.

## Directional object lighting

Static props use `_LIGHTMAP + _PROPLIGHT` with their baked COLOR stream.
Non-instanced moving meshes carry ambient/key/direction values in COLOR and
TEXCOORD streams. Shared meshes receive the same values through a
`MaterialPropertyBlock`, which runtime components reapply in `Start` because
edit-time property blocks are not serialized into builds.

`_DIRLIGHT + _PROPLIGHT` evaluates the retained three-light record for moving
geometry. The shader handles display-domain texture modulation explicitly in a
Linear project. `PropLightGain` and `PropLightStrength` are presentation
overrides; they do not redefine the source equation.

The rideable board uses probe DC for location brightness and a separate global
directional term for its moving deck. This is an aggregate approximation, not
the per-instance prop path.

## Avatar probes

`Importer/Editor/ProbeBuilder.cs` deduplicates instance positions and creates a
`LightProbeGroup`. **OpenSlope > Setup > Bake & Apply Probes** lets Unity build
the tetrahedral structure, then replaces the baked spherical harmonics with
the authored aggregate record. If an existing structure still matches the
positions, the command restamps it without running the lightmapper.

Before baking, the command removes duplicate probe groups. Duplicate positions
can produce a valid Unity bake whose probe count no longer matches the authored
payload.

On Windows, Unity may loop indefinitely at probe initialization when available
system commit is low even though the eventual probe bake is small. The command
checks available commit and asks before entering the synchronous bake below its
safety threshold. Free commit or enlarge the pagefile rather than treating the
scene as corrupt.

## Asset and stream constraints

- Set material keywords and floats before `AssetDatabase.CreateAsset`; changes
  made afterward can disappear on domain reload.
- `TextureArrayPacker` and `StaticChunker` must preserve all live-lighting
  TEXCOORD streams.
- `_PROPLIGHT` remains distinct from terrain `_LIGHTMAP_GS`.
- Geometry-derived normals are allowed only when the input genuinely has no
  usable normal stream.

## Verification

- Use asymmetric normal and full-bright canaries to isolate coordinate,
  texture, and lighting failures.
- Compare which face is lit before comparing brightness.
- Reload the editor and inspect serialized keywords on static and moving
  materials.
- Verify live property blocks after entering Play mode and in a build.
- Confirm probe positions/counts before stamping and compare their DC spread to
  the authored input.
- Run `PropLightingTests` and `CrossRepoContractTests` when the portable stream
  or shader channels change.
