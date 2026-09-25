# 069 — Prop Defaults

A prop picked from the library arrives already set up the way that model behaves: tree canopies are
ride-through and rustle, trunks are solid and thud, signs are self-lit, Showoff pickups sit on the Showoff
layer, crash bags get knocked away. These per-model settings are **prop defaults**.

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
    including its sounds and self-lighting, and shares its effect;
  - middle-click a reference prop, or its inspector's **＋ place prop**, copies that one instance, its effect
    included when that effect is portable.
- **The home placement** a newly built tiled model leaves behind also starts from its defaults.

## Groups

A group (docs/015) places as **one** placement, but its members are different models: a tree's trunk and its
leaves. So a group can carry settings **per member**, in `PlacedProp.memberBehaviour`, keyed by the member's
model id.

- **From the library**, each member starts with its own model's defaults (`groupMemberDefaults`). A GARI tree
  arrives with a solid, thudding trunk inside ride-through, rustling leaves. When every member's defaults are
  the same, the group carries no per-member record and behaves as one placement.
- **When present, `memberBehaviour` has an entry for every member.** A member with no entry (a group placed
  before this, or a member the group def gained later) behaves as its placement's own fields say.
- **Only the leader inherits the placement's ambient loop.** A group placed before per-member settings keeps
  one loop, as Test always played it. The export used to write that loop once per member.
- **The mode layer is always the group's.** It stays on the placement, and entries never carry it.

**Editing.** A selected or held group with more than one member shows a **Member settings** section. Its
**settings for** picker chooses whose settings the Contact, Lighting, Impact sound and Emitters sections show;
Mode presence always edits the whole group.
- Until a member differs, **whole group** edits the placement as before.
- The first edit to one member gives **every** member an entry holding what it does now
  (`materializeMemberBehaviour`), including an inferred collision profile for an older placement. No other
  member changes.
- **⊟ one setting for all members** folds a split group back, giving everyone the picked member's settings.

**Where it lands:**
- **Export** tunes each member under its own join key, `<placement id>#<model>` (`groupMemberKey`). The bake
  registers that key for the member's mesh alone. That key carries hit and ambient sounds, bounce, surface,
  the collision profile with the member's own transform, and self-lit lighting. Effects, poses and clips still
  join on the placement id, so an effect attached to a group still covers all of it.
- **Test** gives each member with its own entry its own collider, keyed `authored:<id>#<model>`. It debounces
  apart from its siblings, so the trunk still thuds right after the leaves rustle. Retiring the placement (a
  breakable, a pickup) retires every member (`obstacleKeyCovers`).
- **The viewport** shades and self-lights each member by its own settings, and the Collision overlay draws
  each member's shape.
- **Project transfer** carries WAVs named per member, and on a model's saved defaults, and renames them when
  they land under a different name.

## Effects

A shipped model also hands new placements its **effect**: a GARI crash bag arrives knockable, a fence flexes when
hit, a warning sign flips its texture, a jumbotron scrolls, a path marker breaks into pieces, a river scrolls and
resets the rider. Effects are graphs rather than placement fields, so this is its own channel beside the
behaviour (`core/props/effect-defaults.ts`).

**Where they come from.** A retail instance names an effect slot, and in practice the slot is per model the way its
behaviour row is: in GARI and ELYSIUM, 533 of the 547 placed models that carry an effect have most copies on one
identical effect. `referenceEffectDefaults` runs the same whole-effect vote over a model's visible copies:
- copies with no effect vote too, so a billboard of which 7 of 43 play a movie defaults to none;
- hidden copies and junk and reset twins do not vote;
- a tie is no default.

The server derives them with the props payload: a table of the level's portable effects (`effects`), each
model's default as an index with its count (`fx`), and each copy's own effect (instance `fx`).

**Only effects that act on the prop alone.** Every node must be one of `DEFAULT_EFFECT_KINDS`, in the persistent,
collision or trigger column, and name no other instance, graph, function or spline:
- **In:** knock (Roller), fence flex, texture flip, UV scroll, break into pieces (mesh throw) and rider reset,
  plus the debounce, wait and tombstone nodes that sequence them.
- **Level wiring stays out:** ELYSIUM's glass halfpipe panes that break their neighbours, GARI's LCD logos that
  switch other screens.
- **Not yet, pending a portability check:** sounds, particle emitters, crowds and gems. Their payloads index
  the source level's sound bank and particle tables.

**Placing.** The held prop's **Effect** section names the effect, how many copies carry it and whether it is
the picked instance's own. Its **attach on place** switch places without it. **↺ use model defaults** brings
it back.
- **One shared slot per effect.** `attachEffectTemplateToProp` gives every placement of one effect the same
  slot, marked `extensions.slopesmith.effectDefault`, as retail instances share one. So retuning a crash bag's
  mass in Effects mode retunes every crash bag placed from the library. A slot whose graph was deleted is
  rebuilt on the next placement.
- **A placement that already carries an effect is left alone.**
- **Copying a placement** (middle-click, or **＋ place prop**) shares the copied placement's effect slot.
- **Groups get no effect default.** Until an effect can attach to one member, it attaches to the whole group,
  and Test moves and hides that as one prop while the ISO gives every member its own copy of the slot. A copied
  group still shares its source's effect.

## Not yet

- **More effect kinds, and member effects.** Sounds, particles, crowds and gems wait on their portability check
  (see Effects). Effects that attach to one group member wait on Test hosts per member.
- **The HATEOAS API.** It assigns whole `o/prop/<id>` registers, so it applies no defaults. Filling in fields
  an agent did not send would change what an assignment means. An agent can still send `memberBehaviour`.
- **A peer's replayed hit on a group member** plays the group's own hit sound rather than the member's. The
  shared ride event names the placement, not the member.
- **Group defaults can't be saved.** A group's per-member settings come from each member's model; there is no
  record of a group's own to keep a saved set on.
