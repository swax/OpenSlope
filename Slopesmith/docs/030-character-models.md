# 030 — Character models

Slopesmith ships four tracked characters under `public/characters/`, listed in `core/characters/builtins.ts`
and addressed as static files rather than through the library API. Because they are part of the client
build, a clean checkout has working riders without a populated workspace or legacy `Maps` folder.

- **Blocky Rider** — the default for new sessions. A blocky, voxel-styled boarder built out of twenty boxes,
  each rigidly bound to one bone. It has no Blender file at all: `tools/character-models/blocky-rider.ts` IS
  the model, and `public/characters/blocky-rider-rigged.glb` is generated from it (see below).
- **Alpine Exo** — a heavy powered-armour rider: 142 solids, 4,392 triangles, 49 bones, eight materials
  and two embedded emissive masks, generated the same way from `tools/character-models/alpine-exo.ts`. It
  is the demonstration that a generated character is not limited to boxes, to flat colour, or to mittens —
  it is the only built-in with articulated fingers.
- **Servo Scout** — a treaded utility robot: a sensor head nearly as wide as its chest, a hinged brow shade
  over two camera eyes, an exposed frame with visible piston rods, a **three-digit gripper** on each hand,
  and rubber **tracks in place of boots**. 124 solids, 4,432 triangles, 37 bones, eight materials and two
  embedded emissive masks, generated from `tools/character-models/servo-scout.ts`. It is the demonstration
  that the rig contract does not require a humanoid hand or a humanoid foot — only humanoid *joints*.
- **Stick Figure** — the full-body tracking diagnostic: side-coloured limbs, front/rear roll rails, visible
  pivots, palm/back and toe/heel markers, and five articulated colour-coded digits per hand. Its 148 solids,
  4,816 triangles and 49 bones are generated from `tools/character-models/stick-figure.ts`.

The **Procedural** option remains available as a skeletal debug view and is also kept visible automatically
while a GLB loads or if it fails validation at runtime. Existing sessions retain their saved rider selection,
including a saved choice of a non-default built-in.

## Generated characters

The built-ins have no binary working file, because they do not need one. Their real source is a bone
table, a table of solids, and a short palette — all of which review as a diff and regenerate with

```bash
npx tsx tools/character-models/blocky-rider.ts       # rewrites public/characters/blocky-rider-rigged.glb
npx tsx tools/character-models/stick-figure.ts       # rewrites public/characters/stick-figure-rigged.glb
npx tsx tools/character-models/alpine-exo.ts         # rewrites public/characters/alpine-exo-rigged.glb
npx tsx tools/character-models/servo-scout.ts        # rewrites public/characters/servo-scout-rigged.glb
```

Each command validates its own output against the contract below and refuses to write a file that would fail
it. `test/blocky-rider.test.ts`, `test/stick-figure.test.ts`, `test/alpine-exo.test.ts`, and
`test/servo-scout.test.ts` regenerate their model and assert the tracked GLB is byte-identical, so a
checked-in asset cannot drift from the source that produced it; the same checks pin the skeleton's segment
lengths.

The shared half — skeleton, solid builders, skinning and export — is `tools/character-models/figure.ts`. A
figure file owns its parts table and nothing else, which is what keeps the four characters from disagreeing
about where a joint is.

### The one constraint that is not negotiable

The runtime driver anchors the hips and only *rotates* an imported skeleton — every descendant keeps the
joint offsets it was authored with — so the model's own segment lengths decide where its boots land. Every
generated character therefore uses the procedural rider's anthropometry exactly (docs/016; Winter's stature
fractions on a 1.70 m rider), which is what puts their soles on the deck rather than through it.

Everything the driver never measures is free, and that is where a figure's silhouette comes from. The blocky
rider spends it on toy proportions: a head almost as wide as the shoulders, limbs a third thicker than the
bones inside them, boots, mitts and a hat. Alpine Exo spends all of it on breadth — 0.86 m across the
pauldrons against a 0.32 m waist — because a shared skeleton can deliver a broad character but not a taller
one. Lengthening the shins to gain height is boots through the deck. Servo Scout spends it almost entirely on
one part: a 0.29 m sensor head against a 0.32 m chest, with a body deliberately thinned to exposed frame
tubes around it.

What the driver measures is *joints*, and Servo Scout is the demonstration of how little else is fixed. Its
feet are rubber tracks whose underside — not a sole — is the surface the ride seats on the binding, and the
ankle joint lives 11.5 cm up **inside** the track unit rather than above a boot. Its hands carry three digits
instead of five: the runtime matches fingers by Mixamo name and simply never finds `ring` or `pinky`, so the
two it does find behave exactly as they would on a full hand, including under optical hand tracking.

What the driver does *not* care about is bind orientation: it sets each driven bone's world rotation outright,
and hands and feet retarget through their own bind frame. So Alpine Exo's 17-degree bind A-pose costs nothing
at ride time, and buys arms that thick somewhere to hang clear of the belt and thigh plates.

### Rigid skinning, and why armour suits it

Binding each solid to a single bone with a weight of 1 is what makes the blocky rider read as blocks rather
than as low-poly, and it costs a joint any smooth deformation. Every limb solid instead runs past its joint
at both ends, so a bend buries the seam inside the neighbouring solid; the checks assert that overlap rather
than leaving it to be re-discovered after somebody trims a box.

For powered armour that constraint stops being a compromise and becomes the subject: hard shells that slide
over each other at the knee and the elbow with a black bodyglove showing through the gap. Alpine Exo's
`KneeSeal` and `ElbowSeal` are bound to the *parent* limb precisely so the two hard shells slide over that
rather than over each other.

Solids there are lofted rings rather than boxes, which can be inside out or open in a way a box cannot — an
inverted solid is invisible from outside, a missing cap is a hole. `test/alpine-exo.test.ts` checks every
shape for positive signed volume and paired edges, so neither can reach a build.

### Lights, and how they move

A character can carry emissive masks. Alpine Exo has two, embedded in its GLB: a 64 × 64 atlas of light
shapes (visor, indicator, lamp, readout bars) and a 16 × 64 conduit strip. Servo Scout carries its own pair
of the same two shapes for different lights — an iris with a dark pupil, a marker slot, and a data feed drawn
as a travelling dash rather than a surge. They are **greyscale**, because
glTF multiplies `emissiveTexture` by the material's `emissiveFactor` — so the mask supplies a light's shape
and the palette supplies its colour, two materials can share one atlas and glow differently, and a repaint
is still a hex digit. `tools/character-models/alpine-exo-lights.ts` authors them as functions of (u, v)
rather than as image files, so they review as a diff like everything else.

Emissive is added after shading, so these are the parts of a rider that stay visible once the sun preset is
`Night` and everything else has gone to silhouette. Check that with the preview renderer's `--dark`, which
drops the lights to a trace so only the emissive reads.

A material may also declare that its mask **scrolls**, by carrying a `[u, v]` rate in texture-units per
second under `slopesmith_uv_scroll` in its glTF `extras` (`CHARACTER_UV_SCROLL_KEY` in
`core/characters/contract.ts`). `app/ride/character-glow.ts` drives whatever declares one — nothing in the
runtime knows Alpine Exo's material names, so a hand-authored GLB that sets the same key animates the same
way. Alpine Exo uses it for the power conduits on its spine, chest, forearms and thighs; Servo Scout uses it
for the data feeds on the same four places, at a different rate and off its own strip.

That step runs **once a frame for the whole scene**, not once per rider, and this is deliberate: rider
models are loaded once and cloned, and `SkeletonUtils.clone` shares materials, so every player, AI rider and
remote avatar wearing a character is looking at the same `Texture` object. Advancing it per instance would
run the animation at the field's size in multiples of its authored speed. The offset is wrapped back into
[0, 1) every frame for the same class of reason: the texture repeats, so wrapping is invisible, but an
offset left to accumulate reaches the shader as a float whose fractional part — the only part that matters —
has lost the precision the pattern is drawn from.

Two constraints come with the masks. They are **not mipmapped**: every reduction of an atlas blends
neighbouring cells, so at distance an unlit plate would pick up its neighbour's light and the whole figure
would haze over. And a part on a material that samples a mask must name its window explicitly — a part that
does not falls back on `UNLIT`, a texel every atlas keeps black, which is a light that silently never comes
on. The check asserts both.

### Arm roll, and why it is shared out

A rider's hands are almost never in the orientation their bind pose left them, and on a board they are
rarely near it: between the arm's neutral roll and the tracked palm there is routinely 120° or more of
pronation. Something has to absorb that, and whichever joint absorbs it alone is the one that pinches — the
elbow's vertices are blended between the upper arm and the forearm, so wrapping them around their own axis
collapses them into the candy-wrapper twist any skinned arm is prone to. On a rigidly plated character the
same thing reads as a forearm rotated bodily against its own elbow.

The driver therefore splits it: the shoulder takes 0.30 and the forearm 0.65, leaving the elbow the 0.35
between them and the wrist the remaining 0.35 (`SHOULDER_TWIST_SHARE` / `FOREARM_TWIST_SHARE` in
`app/ride/character-rig.ts`). That is also where it goes anatomically — pronation is the radius crossing the
ulna along the whole forearm, with humeral rotation carrying the rest, rather than a hinge at either end.
Each bone is rolled about its OWN axis, because with the elbow bent the two differ and rolling the upper arm
about the forearm's axis would tip it out of plane instead of twisting it.

`test/arm-twist.test.ts` drives a real rig from a real solved stance and measures the result across every
riding style, holding each joint under 75° and asserting the elbow never carries much more than the wrist.
Before the split it was 100–177° at the elbow against 1° at the wrist.

### Resting palms

`handFrontPalm` / `handRearPalm` in the solved pose are the direction each palm FACES, and the driver
retargets the model's own bind palm onto them — so they decide the wrists on every character, procedural
and skinned alike. A resting palm faces **down**; it was being handed the body's up axis, which is the same
vector pointing the wrong way, and every character rode and walked with its palms turned to the sky.

Down alone is not sufficient. For a hanging arm "down" runs along the forearm and cannot be a palm normal at
all — it is projected away, leaving a degenerate fallback to pick a world axis. So the resting reference is
down plus a lean toward the body's midline (`PALM_MEDIAL` in `app/ride/rider.ts`), and the two cases fall out
of one expression: an arm held out keeps the downward part and rests palm-down, while an arm hanging at the
side loses it and keeps the medial part, ending with its palm toward the thigh.

A tracked VR wrist is unaffected — it owns its orientation, and `test/palm-facing.test.ts` asserts that it
still does alongside the resting cases.

### Hands

A character may have articulated digits; Alpine Exo, Servo Scout and the tracking stick figure do — five,
three and five respectively. Two things about them are not obvious.

**The bone names are Mixamo's, not this rig's.** The runtime matches digits with
`/^(left|right)hand(thumb|index|middle|ring|pinky)([1-4])$/` against a punctuation-stripped name, and reads
the hand's palm frame from `…HandMiddle1` and `…HandThumb1`. That convention exists because an imported
Mixamo character keeps its source finger names while its driven humanoid bones are renamed — so `Hand.L` and
`LeftHandIndex1` in one skeleton is the contract rather than an inconsistency. A rig that invents its own
finger names gets a hand that never closes, and nothing reports why. `riderBones({ digits })` emits the
right ones from a table written in the hand bone's own frame (+X the way the palm faces, +Y down the
fingers, +Z across toward the thumb), so one table serves both hands.

**The driver bends each segment by a fixed angle** — `FINGER_CURL_ANGLES`, 1.15 / 1.45 / 1.2 / 0.9 radians,
proximal to distal — and it does not vary them by digit. So whether a hand closes properly is a property of
its segment LENGTHS and rest directions against those angles, and a three-segment thumb folds through 218°
and buries itself. Alpine Exo and Servo Scout both give their thumb two segments and their fingers three.

The thumb's *base* is load-bearing beyond where the thumb looks: the driver builds the whole hand's palm
normal from `middle1 × thumb1`, so a base lifted out of the palm plane tilts that normal — and with it the
curl plane of every finger, which then slides sideways across the palm as it closes. `test/alpine-exo.test.ts`
poses a full fist with the driver's own functions and asserts that every fingertip lands on the palm rather
than through the back of the hand, and that each one curls in its own plane.

**Optical hand tracking drives them.** A tracked hand reports no gamepad, so `controllerFingerCurls` returns
zeros for it and fingers used to stay open however the rider's real hand was held. `app/ride/xr/hand-curl.ts`
recovers a curl from the 25 WebXR joint poses instead, as the total TURN along each digit's chain — the angle
between consecutive bone segments, summed. That is scale-free, which "fingertip to palm distance" is not: it
reads the same for a large hand and a small one making the same shape. It is normalized per joint, so a digit
with one joint missing degrades to a slightly-off answer rather than a badly wrong one — which matters
because the fallback when it returns null is the controller pose, and a tracked hand has no controller.

The four constants mapping radians onto 0..1 (`FINGER_REST`, `FINGER_FULL`, `THUMB_REST`, `THUMB_FULL`) are
set from anatomy rather than measured off a headset. They are the first thing to adjust if tracked hands read
consistently over- or under-closed.

The images are PNG-encoded by `tools/character-models/embed-texture.ts` and inserted into the finished GLB
rather than written by `GLTFExporter`, whose image path needs a canvas. That is not only a Node
inconvenience: the canvas this repository already depends on is a per-platform native binary, so its PNG
bytes are a property of the installed build, and a character asserted byte-identical to its source would
start failing on whichever machine was not the one that generated it. The encoder here uses stored deflate
blocks — no compression, and therefore no compressor whose heuristics can differ — which costs about 0.03%
on a mask of a few kilobytes.

## Server-wide character library

Slopesmith discovers rider models from `<workspace>/library/characters/`. Put a binary glTF file (`.glb`) directly in
that folder and reload Slopesmith; its filename becomes an option under **Test Mode → Rider model**. Subfolders
are not scanned. Hyphens and underscores in filenames become spaces, and a trailing `-rigged` or `-character`
is omitted from the display label. The selected model is used for the player and AI riders; changing it during
Test hot-swaps their visuals without restarting their physics.

This is a server-wide library, not part of any mountain and not included by Export mountain. On first access,
Slopesmith copies legacy `Maps/Custom/Characters/*.glb` files here without deleting the originals.

**Test Mode → Riding style**, directly below, is the separate question of how that character *stands* — hip
height, how far they incline and angulate into a carve, how much they counter-rotate, where they carry their
hands. The two compose: any style poses any model, including the procedural body. Changing it mid-run restances
the player and the whole AI field without rebuilding anything, so the ride is not interrupted. The styles and
what each one means are in [docs/016](016-ride.md#the-stance-model).

## Importing a Mixamo FBX

In Test Mode, choose **Import Mixamo FBX…** and select a standard `.fbx` downloaded from Mixamo. The FBX is
uploaded to the Slopesmith server, converted there, validated, and stored as
`<workspace>/library/characters/<source-name>-rigged.glb`; the new character is selected immediately. Conversion uses
Three.js plus the server's image decoder. It does not start Blender and Blender does not need to be installed.

The importer recognizes the ordinary `mixamorig:` skeleton as well as numbered prefixes such as `mixamorig6:`.
It keeps the source mesh, materials, bind pose, fingers, and accessory joints; maps the driven humanoid bones to
the contract below; merges the duplicate skeletons Three's FBX loader creates for multi-part skins; drops source
animation clips; fits the complete standing mesh bounds uniformly to a 1.75 m boarder; bakes that metre scale
into the vertices and joint offsets; records diagnostic bone lengths; and exports a self-contained GLB. The
runtime preserves those uniformly fitted proportions: it anchors the hips and rotates the imported hierarchy
while retaining every descendant joint offset. It does not pull individual joints onto the procedural rider or
stretch body parts to match it. Baking the whole-model scale is important:
a centimetre-scale FBX left under a `0.01` GLB root can have that scale cancelled by the skin bind matrix once the
runtime starts driving its bones. Vertices with more than four influences are reduced to the four strongest
weights by the loader.

Download the FBX with media embedded. A one-file upload cannot recover a texture that exists only as a separate
file beside the FBX; those missing slots are reported and the material colour is kept. The first importer profile
is intentionally Mixamo-specific. A custom/non-Mixamo rig is rejected with its missing contract bones instead of
producing a character that loads but deforms unpredictably.

You can still add an already compatible GLB to the folder manually. The reference-template workflow below is the
right path for a custom skeleton, unusual rest pose, or hand-authored weighting.

`<workspace>/library/characters/character-rig-template.blend` is the reference rig. The reliable workflow is to duplicate
that file, replace or reshape its meshes, bind them to its armature, and export a single GLB beside it. Keep the
armature's rest transforms, bone heads/tails, bone rolls, hierarchy, and object scale unchanged. The runtime
anchors and rotates this known skeleton from Slopesmith's solved pose directions while preserving its imported
joint spacing and proportions; it is not a general humanoid retargeter yet.

## Required rig contract

The GLB must contain at least one skinned mesh and these deform bones (case-insensitive; punctuation is ignored
by the importer, but the canonical names are strongly preferred):

- `Hips`, `Chest`, `Head`
- `UpperArm.L`, `LowerArm.L`, `Hand.L`
- `UpperArm.R`, `LowerArm.R`, `Hand.R`
- `UpperLeg.L`, `LowerLeg.L`, `Foot.L`
- `UpperLeg.R`, `LowerLeg.R`, `Foot.R`

The `.L` and `.R` chains retain the source rig's anatomical labels. At runtime Slopesmith detects which imported
chain lands toward the front binding and maps the front/rear riding targets accordingly, so differing skeleton
handedness cannot cross the limbs. Keep each deform bone's local +Y axis running from its head to its tail. The
template's mirrored boot roll is also part of the contract:
`Foot.L` local +X is sole-up and `Foot.R` local -X is sole-up. The easiest way to satisfy all axes and lengths is
not to edit the template armature at all.

A hand-authored rig that wants the contract in code rather than in a `.blend` can read `riderBones()` in
`tools/character-models/figure.ts`: it is the same contract expressed as head/tail/roll triples, including
the mirrored boot roll and the hand frame (local +Y down the fingers, so local ±X is the palm normal the
runtime recovers when a model has no finger hierarchy).

The template also includes these optional but strongly recommended connector bones:

```text
Hips
├─ Spine → Chest → Neck → Head
├─ Pelvis.L → UpperLeg.L → LowerLeg.L → Foot.L
└─ Pelvis.R → UpperLeg.R → LowerLeg.R → Foot.R
Chest
├─ Clavicle.L → UpperArm.L → LowerArm.L → Hand.L
└─ Clavicle.R → UpperArm.R → LowerArm.R → Hand.R
```

`Hips` is the first 14 cm lower-spine segment and aims toward the upper back. `Spine` continues from its tail to
the `Chest` head; `Neck` bridges `Chest` to `Head`; and each `Pelvis` bone
runs from the hips pivot to its femur socket. Each clavicle runs from the `Chest` tail to its `UpperArm` head.
The runtime drives every connector from the same shared landmarks as its neighboring bones, making the skeleton
continuous and giving conventional torso, pelvis, neck, and shoulder vertices useful deformation influences.
It also derives the chest's axial twist from the live shoulder line. Older models without connector bones remain
compatible, but their corresponding mesh regions must bridge the independently driven required bones directly.

The Mixamo importer records each driven bone's fitted world length as `slopesmith_length_m` glTF metadata for
diagnostics and compatibility. Runtime posing deliberately does not use it to resize bones: the uniformly fitted
mesh and skeleton retain their authored relative proportions.

`Root`, `HaloRod`, `Halo`, `Wing.L`, and `Wing.R` are also optional to the driver. Any optional rigid accessories
can be parented below the driven skeleton and will follow their parent normally.

## Mesh and export rules

- Work in metres and keep the reference armature scale/proportions.
- Bake the intended neutral upright pose into the bind/rest pose before export. Runtime animation clips are not
  used.
- Every visible vertex must be weighted. Use no more than four normalized influences per vertex; one or two is
  preferable for the low-poly style.
- On a humanoid, blend the shoulder-cap vertices between `Chest`, the matching `Clavicle`, and `UpperArm`; avoid
  weighting the whole shoulder directly to the upper arm.
- Apply mesh transforms before binding/export, but do not alter the reference armature transforms afterward.
- Embed textures and materials in the GLB. External texture files are not catalogued or served with a character.
- Export **glTF 2.0 Binary (`.glb`)**, including the skinned meshes and armature. Animations, lights, cameras,
  helper spheres, and exporter-generated leaf/end bones are unnecessary.
- Keep the file directly under `<workspace>/library/characters/`. `.blend`, notes, and texture-source files may live
  there too, but only top-level `.glb` files appear in the selector.

If a selected GLB is missing a required bone or cannot load, Slopesmith leaves the procedural debug rider visible
and reports the failed model in the browser console instead of breaking the ride.

## Offline authoring tools

[`tools/character-models`](../tools/character-models/README.md) contains the reusable command-line side of this
workflow. `check.ts` validates a finished GLB with the same shared bone-name contract as the runtime and server;
`figure.ts` holds the skeleton, solid builders and export shared by the generated characters; and
`blocky-rider.ts`, `stick-figure.ts`, `alpine-exo.ts`, and `servo-scout.ts` each define and regenerate one of
them. The optional
Blender scripts prepare an arbitrary GLB for Mixamo auto-rigging and render consistently framed preview images
from GLBs or posed `.blend` files.
