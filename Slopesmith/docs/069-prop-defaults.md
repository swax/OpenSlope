# 069 — Prop Defaults

A prop picked from the library arrives already set up the way that model behaves: tree canopies are
ride-through and rustle, trunks are solid and thud, signs are self-lit, Showoff pickups sit on the Showoff
layer. These per-model settings are **prop defaults**.

The editor calls them defaults rather than templates because "template" already means an effect template in
the Effects editor.

## What a default carries

A default is a `PropBehaviour` (`core/doc/types.ts`). It uses the placement's own field names, so one set of
controls edits either a placement or a model's defaults:

- **Contact and collision**: the full native profile (`nativeCollision`) and the ride `surface`.
- **Mode layer**: `modePresence`.
- **Hit sound**: `collisionSound`, or an uploaded `collisionSoundFile`.
- **Ambient loop**: `ambientSound` / `ambientSoundFile` and its region (radius, falloff, half-extents).
- **Self-lit**: `fullBright`.

Defaults are **copied** into a placement when it is placed. They are never linked: editing a model's defaults
changes the next placement, and nothing already on the mountain moves by itself. **⇉ apply to N placed** is
the explicit way to push defaults onto the existing placements of that model. Linked defaults (inherit until
overridden) would carry through the document, export and collaboration layers for a modest gain, so they are
not built.

## Where defaults come from

`resolvePropDefaults` (`core/props/defaults.ts`) answers one question for any model: what does a new
placement start with?

**Shipped levels: derived, read-only.** A retail model has no behaviour record of its own. Every instance
points at a shared ObjectProperties row [Trailmap: 120-objects]. In practice the row is per model: 98 of
GARI's 106 models that are placed more than once use one row for every instance (ELYSIUM: 142 of 152). So a
model's defaults are the behaviour its **visible** instances most often carry.

- It is a **whole-tuple vote**, so the result is always a combination that actually shipped.
- Hidden instances, and junk and reset twins, are left out.
- The donor instance a physics body is borrowed through differs per copy by construction, so the vote ignores
  it; the body itself counts.
- The panel shows how representative the result is. For example, GARI's `TreeH_SnowLeaves` uses leaf sound 7
  on 313 of its 319 placed copies and 12 on the other 6. To take a specific copy's exact settings instead,
  middle-click that copy in the reference level.

What a retail instance contributes (`instanceBehaviour`):

- its exact collision profile;
- surface, when it has one;
- the Showoff layer (LTG state 2);
- its hit sound, except event 0, which is the native "silent" marker;
- self-lit, when it has no key light and an ambient of exactly 256.

Ambient `ExternalSounds` are **never** derived. Retail puts them on a few chosen instances (a crowd on
particular trees), so a model-wide default would put a crowd on every tree.

**Your own props: saved, editable.**
- **Tiled models** (`@models`) keep defaults on `AuthoredModel.defaults` in the document. A save is an ordinary
  edit: it can be undone, it autosaves, and it syncs to collaborators.
- **Imported and revised props** (`@import`) keep them on the catalogue record (`ImportedPropRecord.defaults`),
  written through `POST /api/custom-prop-defaults?id=` (editor role). The route behaves like the materials
  route:
  - it touches behaviour fields only, and sanitises them field by field;
  - a body of `null` clears the defaults;
  - **Replace geometry** keeps them.
- **Revising** a reference prop into your library (⧉ revise prop) seeds the copy's defaults from the source
  model's, so a revised tree keeps its canopy behaviour.

**Nothing to go on: the standard start.** This is what every placement got before defaults existed: borrowed
art starts solid, your own art starts decorative and silent.

## Using it

- **Clicking a prop in the library** holds it with its model's defaults. The Props panel shows a
  **Placement defaults** section with a line on where the settings came from, then the same Mode presence,
  Contact & collision, Lighting, Impact sound and Emitters sections a placed prop has. Anything changed there
  applies to what you place next.
  - **⤓ save as model defaults** (your own props only) stores the held settings on the model.
  - **↺ use model defaults** drops unsaved changes, or a copied prop's settings.
  - **⇉ apply to N placed** gives every existing single placement of the model the held settings. Undo
    reverts it.
- **A placed prop of your own** offers **⤓ save as model defaults** too. Tune one on the mountain, then make it
  the model's starting point.
- **Copying rather than picking** holds the copied settings, not the model's defaults, and the panel says so:
  - middle-click a placed prop, or its **＋ place prop**, copies everything the placement carries, now
    including its sounds and self-lighting;
  - middle-click a reference prop, or its inspector's **＋ place prop**, copies that one instance.
- **The home placement** a newly built tiled model leaves behind also starts from its defaults.

## Not yet

- **Groups.** A group places as **one** placement with one set of settings for all its members, so a tree
  placed as a group cannot yet be "solid trunk, ride-through leaves". Groups therefore start from the standard
  settings, as before. Per-member defaults need the group placement to carry settings per member, and the
  export to write them per member.
- **Effects.** Roller, self-break, cracked surfaces and emit-on-contact behaviour are effect graphs, not
  placement fields. Mapping a reference model's effect signature onto the matching effect template and
  attaching it at placement (through the hook imported props already use) is the next step. Placed props with
  a Roller effect also need to actually roll in Test.
- **The HATEOAS API.** It assigns whole `o/prop/<id>` registers, so it applies no defaults. Filling in fields
  an agent did not send would change what an assignment means.
