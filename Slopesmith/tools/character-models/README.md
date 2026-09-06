# Character model tools

Authoring and QA helpers for the custom rider contract documented in
[`docs/030-character-models.md`](../../docs/030-character-models.md). The runtime checker uses the same shared
bone-name contract as Slopesmith itself. The two conversion/render helpers run inside Blender because they use
`bpy`; they are optional authoring tools and are not part of the editor server.

## Generated built-in characters

All four Slopesmith built-ins are generated rather than modelled. Each file holds one figure — a bone
table, a table of solids, and a short palette — and writes its own GLB into the client build:

```bash
cd Slopesmith
npx tsx tools/character-models/blocky-rider.ts            # rewrite the built-in
npx tsx tools/character-models/stick-figure.ts
npx tsx tools/character-models/alpine-exo.ts
npx tsx tools/character-models/servo-scout.ts
npx tsx tools/character-models/blocky-rider.ts out.glb    # or somewhere else, to compare
```

- `blocky-rider.ts` → [`blocky-rider-rigged.glb`](../../public/characters/blocky-rider-rigged.glb). Twenty
  axis-aligned boxes given as corners, six flat colours, 240 triangles.
- `stick-figure.ts` → [`stick-figure-rigged.glb`](../../public/characters/stick-figure-rigged.glb). A
  4,816-triangle full-body diagnostic on 49 bones: side-coloured limbs, front/rear roll rails, joint beads,
  palm/back and toe/heel markers, and five articulated colour-coded digits per hand.
- `alpine-exo.ts` → [`alpine-exo-rigged.glb`](../../public/characters/alpine-exo-rigged.glb). 142
  lofted plates on a 17-degree bind A-pose, eight materials, 4,392 triangles, two emissive masks, and
  articulated fingers on 49 bones.
- `servo-scout.ts` → [`servo-scout-rigged.glb`](../../public/characters/servo-scout-rigged.glb). 124 lofted
  solids on a 14-degree bind A-pose, eight materials, 4,432 triangles, two emissive masks, and a treaded
  utility robot's three-digit grippers and rubber tracks on 37 bones.
- `figure.ts` is the half all four share: the rider skeleton, the solid builders (`box`, `hexahedron`, `extrude`,
  `limb`, `placed`, `mirroredX`), the UVs, the skinning, and the export. A figure file owns its parts table
  and nothing else, so the characters cannot disagree about where a joint is.
- `alpine-exo-lights.ts` and `servo-scout-lights.ts` author their figure's two emissive masks as functions of
  (u, v), and `embed-texture.ts` PNG-encodes them and inserts them into the finished GLB —
  deterministically, which is why it does not use a canvas. Each figure keeps its own masks rather than
  sharing an atlas, so an edit to one character's lights is never a question about the other's pinned bytes.
  All of it is explained in [docs/030](../../docs/030-character-models.md).

Each command validates its output with `check.ts` and writes nothing if the result would fail the contract.
Editing a figure means editing its table: re-run the command and commit both the source and the regenerated
GLB; each generated-character test asserts its tracked asset is byte-identical. Those
checks also pin the skeleton to the procedural rider's segment lengths, because the runtime rotates an
imported skeleton without re-proportioning it — a drifting thigh is boots through the deck, not a compile
error — and, for Alpine Exo and Servo Scout, that every solid is closed and wound outward.

Preview a change with the Blender renderer below; the solids are only as good as the last look at them.

## Tracking diagnostic design

The stick figure is intentionally more explicit than the procedural fallback. Lime and orange identify the
anatomical left and right chains. Cyan/magenta pairs mean front/rear on the torso and long bones, palm/back on
the hands, and toe/heel on the feet. White beads are joint pivots, the crown target exposes head roll, and each
digit has its own colour plus a white fingertip. A swapped chain, reversed roll, inverted palm, bad foot frame,
missing joint, or incorrect optical-hand curl therefore has a distinct visible symptom in a WebXR capture.

It is regenerated with `npx tsx tools/character-models/stick-figure.ts`; `test/stick-figure.test.ts` checks the
49-bone contract, every diagnostic cue, and byte identity with the tracked GLB.

## Check a finished GLB

```bash
cd Slopesmith
npx tsx tools/character-models/check.ts Maps/Custom/Characters/my-rider.glb
npx tsx tools/character-models/check.ts --json first.glb second.glb
```

The command fails when a model is missing a required bone, has a broken hierarchy, does not use those bones in
a skin, contains unweighted vertices, exceeds four influences, or references external images. It also reports
standing bounds, geometry size, materials, embedded images, and unused animation clips. This is the final check
for a hand-authored GLB; the in-app Mixamo importer already validates the FBX files it converts.

## Prepare an upload for Mixamo

This is the other half of the in-app Mixamo workflow. Use it when an otherwise useful GLB has no compatible
rig: the script bakes its visible form into one 1.8 m unrigged mesh and embeds its images in an FBX that Mixamo
can auto-rig.

```bash
blender --background --factory-startup \
  --python Slopesmith/tools/character-models/prepare_mixamo_upload.py -- \
  source.glb temp/source-mixamo.fbx

# For a rigged GLB whose bind pose is the desired upload pose:
blender --background --factory-startup \
  --python Slopesmith/tools/character-models/prepare_mixamo_upload.py -- \
  source.glb temp/source-mixamo.fbx --rest-pose
```

Upload the FBX, auto-rig it, select a T-pose, and download **FBX Binary / With Skin / embedded media**. Import
that downloaded FBX through **Test Mode → Import Mixamo FBX…**. `--height` changes the upload height when the
default is inappropriate; Slopesmith will still apply its own uniform 1.75 m fit to the returned skin.

## Render a preview

```bash
blender --background --factory-startup \
  --python Slopesmith/tools/character-models/render_preview.py -- \
  Maps/Custom/Characters/my-rider.glb temp/my-rider.png --view three-quarter

# A diagnostic action stored in a .blend file:
blender --background --factory-startup \
  --python Slopesmith/tools/character-models/render_preview.py -- \
  character.blend temp/heel-pose.png --frame 40 --view front --transparent
```

Views are `three-quarter`, `front`, `side`, and `back`. `--size` sets the square output resolution. Framing and
light placement scale from the model bounds, so unusually broad or small characters remain visible.

`--dark` drops the key and fill to a trace and blacks the background, leaving only emissive materials
visible: what a character looks like at night, and the only way to see whether its lights actually read.

```bash
blender --background --factory-startup \
  --python Slopesmith/tools/character-models/render_preview.py -- \
  Slopesmith/public/characters/alpine-exo-rigged.glb temp/alpine-exo-night.png --dark
```
