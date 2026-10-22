# The rider family

Kestrel, Robin and Raven are the textured built-in riders. Unlike the generated figures one folder up, which
are tables of solids written out by TypeScript, these are sculpted, lofted and painted in Blender by Python
recipes. They wear the same contract skeleton (49 bones, Mixamo-named fingers) and pass the same checker.

| Rider | Look | Triangles | GLB |
| --- | --- | --- | --- |
| Kestrel | Backcountry freerider: mustard anorak, beanie and headphones, gaiter over the mouth | 13,556 | `public/characters/kestrel-rigged.glb` |
| Robin | Big mountain: quilted red parka, hood up with a fur ruff, work gloves on leashes, avalanche pack | 17,526 | `public/characters/robin-rigged.glb` |
| Raven | Halloween skeleton: black suit with a glow-in-the-dark bone print, skull balaclava | 9,724 | `public/characters/raven-rigged.glb` |

## Files

- `rider_kit.py` — the shared half: the contract rig, loft and skinning helpers, the sculpted head (a signed
  distance field meshed by rays and decimated) and the gaiter draped over it, goggles, boots, five-finger
  gloves, the Cycles bake of what every atlas texel is, the numpy painting pipeline (including glow), and the
  glTF export.
- `kestrel.py`, `robin.py`, `raven.py` — one recipe per rider: palette, face, parts and painters.
- `src/<rider>/` — fabric swatches and emblems the painters sample, generated with fal.ai (FLUX.1 [dev]).
  Raven reuses Kestrel's swatches.
- `build/` — gitignored scratch: the painted albedo, normal and glow maps the GLB embeds.

## Rebuild

Blender 5.2, from `Slopesmith/`:

```bash
blender -b --factory-startup --python tools/character-models/riders/kestrel.py -- \
    --paint --export public/characters/kestrel-rigged.glb
npx tsx tools/character-models/check.ts public/characters/kestrel-rigged.glb
```

The build is deterministic: the same sources give the same bytes. After a change, update the rider's
`revision` in `src/core/characters/builtins.ts` to the new file's SHA-256; `test/character-check.test.ts`
checks every built-in against the contract and its revision.

Recipes vary bulk and fit, never bone lengths. When editing the kit, keep its defaults so the other riders
still rebuild byte-identically.
