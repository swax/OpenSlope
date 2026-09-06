# 026 — Effects editor

Effects mode is the P2 authoring surface over the shared P1 `Effects.json`
contract. It sits between Props and Test in the top mode bar. Shortcut `6`
enters Effects; Test moves to `7`.

> **Normative behavior:** graph circumstances, contact eligibility, re-fire,
> and Roller activation follow [Trailmap: 130-collision-data, 150-logic,
> 370-world-interaction]. The editor and compilers consume those rules; the
> spec citations carry the underlying reverse-engineering evidence.

## Workflow

1. Run `snowknife import` on a reference level and import its `Effects.json`, or
   create a new document from the Effects panel.
2. Select an attached prop, then choose a node in its persistent effect/node
   tree. Effect rows group the graph by circumstance; node rows are the actual
   inspection targets. Node details update below without hiding the prop's
   other effects. Use **Unassigned** for graphs with no host and for the shared
   function catch-all. Array order is the native SSF execution/output order;
   stable string IDs remain identity.
3. Use **Semantic** for named, RE-backed fields. Use **Raw fields** to edit
   the exact portable node object. Raw changes are applied only if the complete
   Effects document still validates.
4. Authoring is prop-first: select a prop and use its panel's **+ Add effect**.
   The menu is the whole native vocabulary in five runs, ordered by confidence
   rather than alphabet — **Validated** first, then **Empty** (a container to
   build in), **Nodes** (the single native nodes), **Recipes** (several nodes
   laid down together because they are inert apart), and **Not addable yet**,
   greyed. Every row shows its one-line summary; caveats and evidence are on
   hover (see *Two tiers of copy* below). The graph, slot, and stable-ID attachment are created together, so
   a graph is never born unattached. On an already-attached prop, a template
   whose circumstance is free wires a new graph into the prop's own slot (the
   native multi-circumstance shape — the retail river authors persistent flow
   plus collision reset on one slot); an occupied circumstance appends the
   template's nodes to that graph's execution chain. Most templates are a single
   node meant to be composed with others; a few are recipes whose nodes are
   meaningless apart and are laid down as a chain. Graphs/functions and nodes can
   be renamed, reordered, duplicated, and deleted. Deleting a graph/function
   clears native references to it rather than leaving stale compact indices.
5. **Attach to level object** remains for rewiring: point another prop at a slot
   used by the selected graph — the way several placements share one graph, like
   the retail river segments. Attachments use the prop's stable ID and are
   retained in `extensions.slopesmith.attachments`.
6. In Effects mode, clicking ANY authored prop in the viewport selects it: an
   attached prop opens its graph and selects its timer emitter when present; an
   unattached prop opens its Add-effect panel. A **grind rail** answers here too
   (*Rails in Effects mode* below). Other clickable scene targets show the
   matching Scene, Edit, or Props hint.
   Attached graphs are displayed as `Effect 5 · Trigger`; their editable portable
   graph name remains available separately for shared-graph fidelity.
7. A selected timer emitter exposes a purple move handle. It writes the exact
   local emitter-origin fields `U9/U10/U11` in engine centimetres, including the
   prop's rotation/scale and Slopesmith/raw axis conversion.

Every mutation goes through Slopesmith's normal document rebuild funnel, so the
existing undo/redo history, browser persistence, `.slope.json` save/load, and
level export cover effects without a second history stack. Delete removes the
selected node (or graph when no node is selected). The Effects home toolbox is
prop-centric: document import/export, the attached-prop list, an **Unassigned**
catch-all, and validation. Selecting a prop keeps all graphs/circumstances for
that prop visible while graph, node, and attachment details update below. The
Unassigned list likewise remains visible while its selected graph/function is
inspected. Escape or **Deselect** returns to the Effects home toolbox.

## Two tiers of copy

Every template carries a `summary` and, when there is more to say, a `detail`.
A live PS2 run adds a third thing, `proven`. They answer three different
questions asked at three different moments, and keeping them apart is what
stops the panel from burying its own controls.

| Field | Answers | Where it renders |
| --- | --- | --- |
| `summary` | *What will this do?* | Always visible — under the label in the picker, above the fields on the node |
| `detail` | *How do I use it properly?* | Collapsed, under **How to use this** |
| `proven` | *What was actually seen on hardware?* | A one-line badge inline; the observation and its cell under the same disclosure |

`summary` is one or two plain sentences and is the only tier a reader is
guaranteed to see, so anything that decides whether a node works at all belongs
in it — that a Cracked surface runs the prop's Trigger effect, that a Speed
boost's number is seconds. `detail` is for the author who has already chosen
the node: it carries the caveats that change what someone builds and nothing
else. Reverse-engineering narrative is not one of those; the observation lives
in `proven`, the evidence behind it lives in Trailmap, and neither belongs
in prose an author reads while trying to place a prop.

The fourth home is `validateEffectsAuthoring`, and it is the preferred one
whenever the caveat is a *condition*. A rule that can be tested should fire on
the prop that breaks it rather than being read hopefully in advance — a
paragraph warning that lifetime commands hang the console is read once and
forgotten, where the same rule as a validator arrives with the prop's name on
it. `EffectSemanticNumberField.title` follows the same rule at field scale: it
says what the control does and how to choose a value, not how the value was
recovered.

## Latch circumstances (Region exit / Effect end)

The native slot's columns 3 and 4 are **suppression latches**, not chains to
author [Trailmap: 150-logic §slot-columns]: column 3 (**Region exit**) runs
when the object's world-grid region deactivates, column 4 (**Effect end**) when
an installed effect node self-ends — each *instead of* the engine's default
teardown + rest-pose revert. The engine only tests whether the column is
populated, and a zero-node chain finishes on its prime tick, so **an empty
graph is the retail authored form** — every one of the 29 retail references is
empty. The Elysium iris door is the worked example: a play-once open clip plus
both latches keep it open.

Slopesmith therefore authors them as two prop-panel checkboxes under **When
this effect ends** — *Hold the final state (don't reset)* (`slot4`) and *Keep
it when the area unloads* (`slot3`). Checking one writes the retail shape (a
reference to a fresh empty graph) through the normal document funnel; wire keys
stay `slot3`/`slot4` in the v1 schema. Unchecking clears the column and
garbage-collects the empty sentinel. In the effect tree a checked latch renders
as a `⟨latch⟩` row rather than "No nodes". Validation warns when a latch chain
carries nodes (they'd run instead of the revert — unexercised territory), when
`slot4` is populated but nothing on the slot can self-end (loops never finish;
a delta-gated clip never reaches its end block), when `slot4` coexists with a
no-live-node gate (the kept node blocks the gate forever), and on any
`slot6`/`slot7` reference (no engine path reads them).

Both columns are measured on PS2, each as a latched cell against an unlatched
control carrying the identical chain — the pairing being obligatory, since the
claim is a teardown that *does not happen* and a single cell could not make it.
Column 3 keeps a persistent node and the instance flags it set; column 4 keeps a
self-ending one alive past its end (a pulsing flipbook built one node instead of
three).

**Which column an effect needs is decided by how its node ends, not by what the
effect does**, and getting that backwards is silent. A breakable kill leaves a
tombstone that never self-ends, so *Hold the final state* does nothing for it at
all — measured as behaving exactly like no latch — and *Keep it when the area
unloads* is what makes a break permanent. The `Breakable (permanent)` recipe is
that pairing, laid down together for the same reason the one-shot door is: the
column lives on the slot while the node lives in the chain, so an author who
ticks the wrong one of two adjacent checkboxes gets a prop that unbreaks itself
and nothing anywhere to say why.

The **One-shot clip (door / gate)** template is the door's recipe
self-contained on one prop: a collision-circumstance play-once model clip
(retail effect 100's exact payload) plus both latches — ride into the prop and
it plays its clip once and stays there. It ships both columns because a clip
does self-end *and* its region unloads, so it is one of the cases that genuinely
wants the pair. The retail door's exact *remote* trigger shape (volumes
elsewhere playing the clip via MainType 7) still needs Raw references for the
cross-instance call, like the hidden-twin reveal.

## Which node goes in which circumstance

Not a free-for-all, but the constraints are not the ones the picker's grouping
suggests. The circumstance decides **when** a chain runs, and the retail corpus
is a convention rather than a whitelist: a UV scroll, a counter and a budgeted
clip appear only in persistent chains across all twelve retail levels, and all
three were built and run from a **collision** chain on hardware — the scroll
advancing its own phase, the counter counting. What actually constrains an
author is sharper than a per-column list, and cuts across the columns instead of
along them.

**A placement runs one property node at a time.** The instance has a single
live-node slot, and the node factory destroys whatever is in it before building
a node of a different sub-type. So within one chain the **last** property node
wins and everything before it is a stepping stone: this is why the shipped
ride-over button's leading Cooldown gates nothing (the flip destroys it one
dispatch later), and why a node-lifetime command placed behind the node it means
to end does not read the way it looks. Retail authors as though the rule were
one-property-per-chain because in effect it is — of the 1,020 retail chains
carrying a property node, **1,019 carry exactly one distinct sub-type**.

That rule crosses circumstances too, and it is the one pairing that genuinely
bites: a prop with both a persistent effect and a collision effect has the two
competing for the same slot. Measured on hardware — a persistent UV scroll holds
the instance until the rider arrives, and then the collision chain's Cooldown
takes it. Neither is broken; they take turns, and the last one to build is the
one that is running.

**A bound-node command is addressed to whatever is installed right now**, not to
a node named in the document. There are exactly two shapes that put the right
receiver there, and both are retail:

- the receiver **immediately ahead of the command in the same chain** — the
  Megaplex buttons (flip, then select frame ×60 in the corpus) and Elysium's
  budgeted clip (clip, then grant);
- a **MainType-7 hop** onto a placement whose *own* installed node is the
  receiver — Merqury City's strike sign (hop onto a persistent UV scroll, then
  set phase), its ten-input counter, and Elysium's remote clip grants.

Anything between the receiver and the command that seizes the slot redirects the
message, silently. This is the single most common way a control chain that looks
right does nothing.

**A gate ends its chain from where it sits**, so it only tests anything at the
front. **Columns 3 and 4 are latches**, above — populated-ness, not chains.
**Columns 6 and 7 have no reader at all.**

**The trigger column has no event of its own.** It is a continuation, and only a
runtime node another column installed can fire it. Two nodes can, and both are
authorable: a **Counter reaching zero**, and a **Cracked surface giving way**.
Each holds a quantity its own update walks down — a count of marked inputs, a pool
of strength — and resolves this column on its own slot the moment that quantity is
spent. Attaching a trigger effect and expecting contact to run it is the one
circumstance mistake the editor cannot warn about from the graph alone.

It is now demonstrated end to end: a counter emptied by a Mark fired its column,
and a companion prop 130 m off the course with no chain of its own held the
hopped node on the same sample the count reached zero, three passes of three.

**Which installer fires the column decides what may go in it**, and the difference
is one of lifetime rather than taste. A **Counter fires and then retires**, so the
column runs while the counter is still inside the update that is about to let the
object go. A **Cracked surface fires and stays**: its update calls the chain and
then touches nothing of its own, which is why the same payload that hangs the
console behind a counter is what all twenty retail glass panes put behind a crack.

### Behind a Counter: put a Run-on-another-instance there and nothing else

That constrains the payload harder than anything else in the editor:

- a node that **installs on this object** — a flipbook, a breakable kill, any
  property node — pulls the counter out from under itself. Measured as a
  reproducible console hang for both, within a second, which is why the safe
  payload is not a matter of taste;
- a **bound-node command** finds nothing installed to address, because the
  counter has already let the object go, and is silently dropped;
- a **hop** installs on somebody else and never touches it. It is also the only
  thing retail ever puts in a counter-fired column — Merqury City's strike sign
  is the corpus's single example and carries exactly one node, a hop.

### Behind a Cracked surface: put the whole break there

A **Cracked surface** template in the collision column turns the prop into
two-stage breakable glass. Riding it cracks it; it gives way once it has taken
enough. The node itself breaks nothing — it holds a **strength** pool, subtracts
the force of each hit from it, and fires this column when the pool runs out. So
the break goes here, and it is the ordinary break vocabulary with no restriction
on it: the shatter sound, the kill, and Run-on-another-instance reveals of whatever
the broken surface should become. Megaplex's twenty panes are exactly that shape,
and their column carries no Wait — the delay is the pool, not a timer.

**Strength is a budget of impact, not a count of hits, and it does not port
between shapes.** Measured on PS2, one contact with a pass-through trigger volume
at course pace costs about **88**. Retail authors 5 on its panes, which on a volume
like that is gone on the first touch. Size it for the prop you are attaching it to.
A surface whose pool has gone negative refuses every later hit, so it gives way
exactly once.

Its other field is the crack's **lifetime**, not the surface's: when it expires the
node retires and takes the accumulated damage with it, so the surface heals. Retail
ships `-1` on every pane, which never expires — once cracked, cracked until it goes.

A Cracked surface with an **empty** trigger effect cracks and then stands there
forever, which is the one mistake this pairing invites and the reason the two
halves are described together.

Beyond that it is convention, and the convention is worth following because it
describes what the nodes are *for*. Retail's property nodes partition almost
perfectly:

| column | property nodes retail puts there |
|---|---|
| Persistent | UV scroll, flipbook, flag, crowd box, counter, budgeted clip, anim combo — a **continuous state of the object** |
| Collision | roller, node lifetime, boost, fence, mesh throw, lap lift, Z boost — a **reaction to being hit** |
| Either | debounce, model clip, particle emitter, gate, hop, bound-node command |

## What the picker will and will not lay down

Showing the greyed half is the point. An absent entry reads as "SSX has no such
thing"; a greyed one says the node exists and what stands in the way. Reading a
level that uses any of them is unaffected — the inspector shows every field in
Raw, as it always has.

A node is **addable** when its complete native record can be laid down from
recovered data. Complete matters: templates emit the whole record including the
words whose meaning is not established, at the value retail ships them at,
because a short record would be written back as one and the fields left out are
exactly the ones nobody could check by eye. Defaults are modal authored values
rather than guesses — `Debounce 3` (75 of 118 records), `Speed 3.5` cycling,
`Speed 1` dwelling.

A node is **proven** when an authored document carrying it was packed into a real
ISO, ridden by `Trailmap/tools/autotest`, and the node was seen doing its job —
not merely being constructed. The hover text states exactly what was read and
names the fixture cell, so any claim in that run can be re-run rather than taken
on trust. The bar excludes two nodes whose evidence is just as good and says the
opposite: the roller builds and never moves its host, and the lap-gated lift
builds and lifts nobody outside Megaplex. Those findings live in the template's
own description and in the authoring validator, where they read as the warnings
they are instead of under a heading an author scans for "these work".

It also excludes several whose evidence stops half way. A fence flex, a mesh
throw, a counter, a flag, a crowd box, a UV scroll and a model clip have each
been packed, ridden and seen to BUILD on a PS2 — the persistent four without any
contact at all, which is what demonstrated that circumstance — but what any of
them does is pixels or an internal count, and this harness reads memory. They
carry that evidence in their description, naming the fixture cell, and no badge.
The distinction is the whole value of the badge: a row an author reads as "this
works" has to mean the effect was observed, not the allocation.

Only two things make a node **not addable**, and the greyed row says which:

- Its payload words have **no recovered meaning**. Defaulting those would be
  inventing data: the node would author, export, and do something nobody could
  predict. `property.tube-end-boost` is the shape of this — recovered enough to
  read, not enough to say which of its three staged directions fires when.
- The **opcode has no writer**. `function.call-detached` is MainType 26, which
  the level writer has no case for, so it would pack as a node header with no
  index behind it and the engine would read whatever followed. Call shared
  effect is the same call with an owning rider, and it does pack.

A node whose reference has no sensible default is not in this category: it is
addable and it BINDS on the way in, because an author picking it from the menu
has already said what they want. A rail toggle takes the selected rail, a
vertical lift takes an altitude above the prop it landed on, and a call makes
the empty function it names. Three references are stable ids the compiler turns
into native table rows — a PLACEMENT for the MainType-7 hand-off and the
teleport, a spline resource for the toggle and the mover, and a document
function for the call.

**Flipbook** and **Dwell screen** are the two ways a material's frame list plays
on its own, both persistent. They are separate templates rather than one with a
flag because they are separate machines: the pause path re-times itself at every
change, so `Speed` stops meaning frames per second and becomes the base hold
([Trailmap: 410-texture-animation]). Their defaults are the modal shipped values
— `Speed 3.5` cycling (20 records) and `Speed 1` dwelling (36, the most common
flip in the game). Both want a material carrying at least two frames; the prop
inspector's Materials section is where that list is authored (docs/012).

The **Ride-over button** template is the megaplex button's recipe, likewise
self-contained on one prop: a collision graph of `[debounce 3 s]`, a
`property.texture-flip` carrying a 0.5-second `Length`, and the
`material.texture-frame` select that paints the pulse — crossing the prop flashes
its material to frame 1 and back ([Trailmap: 410-texture-animation]). All three
are needed: a flip node with no frame select paints nothing, and without the
debounce the contact walk rebuilds the node every frame the rider overlaps, which
re-selects the pulsed frame for as long as they stand there instead of flashing
it. The model has to carry at least two flipbook frames on the material — an
imported prop keeps its native `TextureFlipbook` list.

Retail splits that recipe across two objects: an invisible trigger volume whose
collision header hops onto the flat button with MainType 7, and a sibling hop
that drops the barricade. Both hops are authorable — **Run on another prop**
names a placement rather than a native index, and the repack compiler back-patches
the packed index once the props are appended. This recipe is the one-prop form:
the same three nodes in the same order, with the engine building the same node on
contact. Reach for it when the thing you ride over is the thing that reacts, and
for the hop when they are two objects.

## Rails in Effects mode

An effect hangs off a **placement** — the graph is in SSF, the `EffectSlotIndex`
is on the packed instance — so a spline can never own one. What it can be is
**named**: `Rail on / off` names a grind rail, and a Spline mover names a motion
path, each through a stable resource id the compiler turns back into a native
spline-table row. The join therefore runs one way only, prop → slot → graph →
node → spline, and a rail has no way of knowing anything points at it.

That asymmetry is what made rails read as inert scenery in the one mode that
switches them. Clicking one used to be answered with "switch to the Props view
to edit" — true of its geometry and beside the point in a mode whose whole
business with a rail is which effect catches it. So Effects mode draws **every
grind rail's surface-coloured centreline** while it is up — metal red, wood
yellow, ice blue — and clicking one opens a rail
panel. `splineEffectUses` walks the join backwards to fill that panel in: what
names this rail — *switches it on*, *switches it off*, *travels along it* — each
row opening that effect on its host prop, or in **Unassigned** when the node
lives in a shared function. A **dashed** line means the rail is not in the
network as it stands, which is the one rail state this panel owns.

Every rail rather than only the named ones, which is what an earlier pass drew.
This mode binds nodes to **curves**, so showing the curves is showing what there
is to bind to — where marking out the referenced ones lit up exactly the rails
already accounted for and left the ones still waiting to be wired looking like
scenery. The reverse lookup stays; it just answers the panel's question rather
than the viewport's. Colour identifies the ridden surface; it is not inferred
from the effect wiring.

Surface hues rather than the mode's purple, because the two are different
**relationships** rather than different shapes. Purple is worn by what Effects
owns outright and can delete from here — trigger boxes, fog banks, and a motion
path, which *is* its purple line and exists for no other reason. A grind rail
belongs to the course; this mode only switches it. Reading someone else's
mountain, the grind palette answers both "can I delete this from here?" and
"what surface is this?" before you click anything.

### What the panel offers turns on the tube

A rail with a **pipe** is course scenery that Props mode draws, materials and
floats, so this panel offers exactly the one field the effect side owns —
**starts off** — and sends points, height, material and posts to the Tricks
tools. Effects mode is not a second place to draw a rail. Its read-only
**Material** and **Speed** properties still identify the retained `SplineStyle`
and that surface row's cruise target; **Shape** says pipe or bare independently.

A **bare** rail has no geometry in Props mode to send anyone to (docs/014): the
grind and the pipe are unrelated records on disc, so a rail can perfectly well be
the curve alone, laid along a fallen trunk or a handrail model that already has
the shape. **Add rail spline**, beside *Add motion path* in **Effect scenery**,
draws one — and because the curve is all there is, this panel keeps the whole of
it: ground offset, extend, trim, delete, on exactly the shared point-chain
actions a motion path uses. Delete follows the same line: it removes a bare rail
and declines a piped one.

That is also why the Effects-mode rail spline exists here rather than in the
Tricks tools. Most reasons to lay a grind over existing art are effect-shaped —
the trunk that becomes grindable when the tree comes down — and a spline with
nothing drawn on it is only visible in this mode's guide layer to begin with.

All grind-guide colours follow the **Tricks view filter**, like every other rail. Turning
rails off turns the curves off with them: the filter is the author's own "hide
the rails" control, and it would be strange for one mode to overrule it. The
**selected** curve draws a step wider and a step brighter — weight alone is too
close a call at distance, and colour alone is lost where two rails cross.

### Shipped rails on the reference map

A loaded reference draws its own grind curves in the same surface palette, off the level's
`Splines.json` rows selected by the shared style/name candidacy rule — styles 13/12, plus named exceptions
such as Alaska's six style-5 IceRails — the same filter the reference test ride grinds by. This is not decoration: a shipped
rail exists *only* as that row, because its tube is an ordinary prop instance
joined to nothing. Drawing the curve is the only way to read a retail level's
rail network at all — which pipes are catchable, where a grind starts and stops,
and which curves have no tube over them. GARI, for instance, carries 169 grind
splines against 98 `Mdl_Rail_Metal` instances.

Clicking one opens a read-only panel: its native row, what names it, and — the
point of the exercise — **Go to prop**.

### What pairs a curve with a model

Nothing, in the general case. `splinePairedProps` (and its reference twin) does
not guess: it reports the placements that the very graphs naming this spline
*also* aim a `MainType 7` at. That is retail's own pairing, written by hand in
`HideShowOff` — a `MainType 25` naming the spline and a `MainType 7` naming the
instance, in one graph. An author who wired those together said, in the only way
the format allows, that this curve and that model are the same rail.

So the button is absent for a curve no effect touches, and that is correct
rather than a gap. Nothing in the level claims those two objects belong
together, and pairing them by proximity would be the editor inventing a fact and
serving it in the same button as a real one.

This is also what a purple rail tube on the reference map has been telling you
all along. `referenceEffectInstanceIndices` marks *direct slot owners plus
cross-instance targets*, so GARI's `Mdl_Rail_Metal_2014` shows purple while
carrying no effect of its own: it is the receiving end of a `MainType 7`, and
the graph aiming at it is the graph that toggles its rail. The purple is not a
rail marking and never came from a name match — the only string test in the
reference decor (`REF_TRICK_MODEL_RE`) routes models between the Props and
Tricks view filters and sets no colour at all.

**Starts off** ships the rail outside the rail query and lets a toggle put it in
— the fallen trunk that only grinds once the tree is down. It is a
`SplineStyle` swap rather than a flag because that is the whole of the retail
mechanism ([Trailmap: 140-rail-toggle], docs/014): candidacy has no authored bit
on disc, and MESA's trunk splines ship at the non-grind style 1 that the rail
query does not search. Whatever the rail looks like — its own tube, drawn,
textured and solid exactly as authored, or the prop a bare curve was laid along —
is untouched either way, since the toggle switches catchability and never
visibility. Slopesmith's own test ride refuses such a rail as well — no preview
here runs a MainType-25 node, so grinding it in the editor would be the one
thing the console will not do.

Both halves of the pairing are decided from the document rather than left to
prose, and each warns on the rail that has the problem: a rail that starts off
with nothing to switch it on can never be grinded by anyone, and a toggle set to
ON against a rail that was already grindable is a node that changes nothing.
Neither is visible on the mountain, and neither is visible in the node either —
the effect dispatches identically in both cases.

## Semantic/raw boundary

The semantic view currently names the recovered timer-emitter controls (count,
spawn step, lifetime, size, local origin, gravity, sprite, blend), Wait,
PlaySound, SpeedBoost, TrickBoost, and promoted stable references. Fields not
yet named stay visible and editable in Raw. Semantic labels never replace raw
payload fields in the portable document.

**UV scroll** exposes the recovered native cycle instead of the old guessed
axis-length labels. **Mode** is a named selector in the authored editor and a
label in read-only reference inspection:

| Mode | Native value | Behavior |
|---|---:|---|
| Linear (same direction) | 0 | move at the authored rate; restart each active interval without reversing |
| Eased ping-pong | 1 | ramp from zero to half-rate and back to zero, then reverse |
| Constant-speed ping-pong | 2 | move at the authored rate, then reverse |

Unknown native values remain lossless and display as a numbered fallback; the
game's update routine sends them through the same linear path as mode 0. The
other semantic controls are horizontal/vertical **UV units per 60 Hz tick**,
**Active duration**, **Pause duration**, and total **Lifetime**, all three times
in seconds. A zero pause repeats immediately and a zero lifetime remains
installed until the slot unloads. The viewport uses the same fixed-tick cycle,
including reversal, easing, pauses, lifetime, and one-texture-repeat wrapping.
The field mapping and native-code evidence are in Trailmap 170/410.

**▶ Preview effect** runs that cycle on the selected prop alone, whatever the
top-bar Effects filter says; Stop or Escape rests the material again. Both reach
it the same way, and it is not the way the rest of the panel's Preview works: a
material property is a render-layer clock rather than an action to dispatch, so
running one means ungating the clock the renderer already built from the node —
Preview for one host, the Effects filter for every scroller at once. The same
holds for a free-running **Flipbook** or **Dwell screen**. A *one-shot* flip is
deliberately left out: its Length says it rests until a graph builds its node,
and the frame select that paints it already runs under Preview.

Claiming the material is also what lets Preview deliver a **bound-node command**
to it — a **Set UV phase** or a frame select — since Stop can now put back
whatever the command wrote (docs/027). Both mountains' drawn materials follow
the frame a flipbook selects, including the native-lit, ground-lit, sign-tinted
and self-lit variants a placement is actually drawn with.

**Roller / knockable prop** is the one movement-authoring path. It adds a
collision `property.roller` node whose semantic **Mass** activates Slopesmith's
moving-body preview and the Unity physics divert; the same node is
compiled into the native effect graph. There is no separate Unity-only checkbox
or mass field. Portable movement requires a finite positive Mass; a non-positive
value is preserved losslessly but warns and is ignored by preview/bundle activation.
A custom ISO prop still needs sphere-tree shape/inertia data before
the PS2 engine has a body for Roller to move.

## Authored motion

Two persistent templates turn the recovered blimp/train behavior into an
authoring workflow:

- **Model clip** plays the placed source model's embedded animation. Slopesmith
  detects the clip automatically, reports its frame count in the semantic
  inspector, and uses the authored loop/rate/range controls in Preview, Test,
  and the World Effects toggle. A placement whose source model has no embedded
  curves reports that there is nothing to animate. The node also carries the
  **Model animation** timeline — play/pause, restart, loop, a frame scrub and a
  per-channel track with the recovered cubic boundaries — which is the same panel
  the read-only reference browser shows, driven through a `ClipTarget` rather
  than duplicated. Scrubbing outranks every player, so a held pose is not
  advanced by a running Preview or by the World Effects loop; releasing the
  timeline hands the clip back to whichever was running. The authored side draws
  no trajectory line: the cyan path is reference decor. Imported GLBs can declare
  a spin (docs/032), so a custom prop reaches this panel too.
- **Model clip (combo)** is the same player with a SECOND window of the same clip
  behind it. The first window loops as the prop's idle motion; **Trigger anim
  combo**, usually on the prop's own collision effect, plays the second one once —
  composed onto the pose the idle animation had reached, not replayed from the
  clip's origin. That composition is the point of the node and it is what the
  author has to build around: the reaction's frames are a movement *away from
  rest*, and the idle motion must not appear in them. Aloha's sliding barriers are
  the shipped example — frames 0–60 slide them ±430 cm, frames 61–100 rotate them
  flat about a translation of zero, and the composition is why one knocked over
  mid-slide falls where it stands instead of jumping to the middle of its travel
  first. `When the combo ends` chooses between going back to the idle loop
  (re-triggerable, what retail authors) and stopping for good on either pose. A
  second trigger while one is running is refused, by the node rather than by the
  chain, so a collision effect needs no debounce of its own.
- **Spline mover** moves the complete prop along one of the open mountain's authored
  motion paths, and it is demonstrated to run: on PS2 the mover's own
  distance-along-route advances at exactly the speed authored for it, three
  passes of three, and wraps back to the start on reaching the route's end. Two
  further things about it are not obvious from the panel and were measured rather
  than inferred. The placement you attach it to becomes an
  invisible **source**: the engine draws moving copies from a separate pose buffer
  and hides the original, so the prop is not where you put it, its own
  translation never changes, and *that is what a working mover looks like from
  the outside* — the stillness of the host is not a fault to debug. And because
  the packed source is hidden, **it takes
  no contact** — an identical collision chain fired on an ordinary prop in every
  pass and never once on a mover's host. A mover's own prop therefore cannot also
  be a trigger; put the contact on a second placement and reach the mover with
  **Run on another prop**. (A mover can also be stopped: it destroys itself the
  frame it finds instance flag `0x0800` set on its host, and clearing the flag
  again will not bring it back.) In the Effects home panel choose **+ Add motion path** beside
  **+ Add fog volume**, click at least two points on the mountain, then add Spline
  mover to the prop. The route field keeps a stable path ID while
  speed, end behavior, orientation, instance count, and yaw offset remain
  semantic fields. **Show route line** generically exposes the native `U6` line-draw
  flag, with named RGB and opacity controls backed by `R/G/B/U7`; gondola cables are
  one use of this spline visual rather than a separate effect type. End and orientation modes use named selects rather than raw
  integers:

  | End behavior | Native value |
  |---|---:|
  | One-shot (finish) | 0 |
  | Loop (wrap) | 1 |
  | Ping-pong | 2 |
  | Hold at end | 3 |

  | Orientation | Native value |
  |---|---:|
  | Follow yaw + pitch | 0 |
  | Follow yaw, stay level | 1 |
  | Fixed yaw, follow pitch | 2 |
  | Fixed orientation | 3 |

  On a ping-pong return leg every mode receives the native 180° direction flip;
  “fixed yaw” means the route's changing tangent yaw is ignored.

  Preview runs the selected graph immediately; Stop or Escape restores the
  placement. One-shot hides the moving copy when its native node finishes,
  while Hold at end keeps the copy visible at the endpoint. Loop and ping-pong
  continue until preview is stopped. A negative speed starts at distance zero,
  matching the native constructor: only ping-pong reverses there; the other
  modes remain pinned to the start.

Motion paths reuse the proven point-chain editing gestures but are their own
effects-owned spline kind. They appear as purple guides only in Effects mode,
never enter the grind network, and do not bake a visible rail tube or supports.
Reference-map preview and Test render `InstanceCount` shared-model copies evenly spaced by arc length, matching the
retail gondola law while retaining one native placement identity. Authored-map preview currently moves the owning
placement once; its `InstanceCount` is still preserved for the native runtime.

Spline mover packages through ISO export: `Effects.json` carries the stable path
resource, `Splines.json` carries the matching curve with the retail animation-route
row `(-1, -2, style -1)`, and `snowknife repack` resolves the stable reference
to the final compact spline index while compiling the node into the regenerated
SSF. Model clip is
fully available in Slopesmith Preview/Test for borrowed animated source models,
but the current authored `Props.obj` bake writes static model objects and does
not yet copy those embedded curves into a repacked PS2 model.

## Breakable vocabulary (roll-away chains)

The `model-clip` (`property.anim-object`), `breakable-kill` (`property.
breakable-kill`, DeadNodeMode 4) and `mesh-throw` (`property.mesh-animation`)
templates are the retail break vocabulary (Unity docs/036); their semantic
inspectors were already present, so each is now authorable without Raw JSON. A
**roll-away breakable** — the retail city globe: hit it, it plays its model's
own clip down the street, then crashes — is the chain `[model clip (loop 0)]
[wait] [sound] [breakable-kill] [mesh-throw]` composed on one collision graph
with the "+ Node" append. Template defaults are the retail globe's authored
values. The hidden-twin reveal (`MainType 7` cross-instance handoff) still
needs Raw references, and the Test-mode preview of a full twin chain remains on
the 027 not-yet list.
### Play sound

A `MainType 8` node's whole native payload is `SoundPlay`: a number naming a slot of the level's group-2
course bank, addressed **directly** rather than through the ADL event table a prop hit sound goes through
([012](012-props.md)). Two things follow. A bare slot number is a poor authoring control — it means whatever
the *repack target* happens to ship in that slot — and a custom clip on one of these nodes needs no reserved
event id at all, so it is not bound by the eight-id pool prop sounds share.

So the node's primary control is a **`<mountain name>` WAV** picker over the uploads in the project's `assets/sounds/`, with
**⤒ load custom wav…** to add one (normalized PCM16 mono, ≤ 10 s, the same store and the same `<name>_2`
collision rule as every uploaded asset). The chosen file rides the node's own `extensions.slopesmith.soundFile`
rather than its payload or its references — references are stable ids Snowknife compacts back to native table
indices, while the payload must stay the plain number the engine reads. Export stages the WAV, allocates it a
course-bank slot from `CUSTOM_EFFECT_SOUND_SLOTS` (98–111, the resolver table's unmapped gap, so an effect
clip and a prop clip can never claim the same slot), writes that slot into `SoundPlay`, and joins it into the
existing `customSounds` slot→file map the ISO repacker already PS-ADPCM-encodes. A file shared with a prop's
hit or ambient sound still receives a separate direct slot: prop clips travel in the portable
`customSoundEvents` event→file join because their slot is resolved from the target ISO at repack time.

While a WAV is assigned the **Sound slot** field is read-only: export owns it, so presenting it as editable
would show a value that is about to be replaced. Clearing the picker hands the slot back, which is what a
retail graph wants — the direct slot stays editable whenever no WAV is assigned. Either reading ends in a
read-only **Filepath** field and then the same closing action group as prop audio ([012](012-props.md)):
**🔊 sound library…**, **⤒ load custom wav…**, **▶ play sound**, in that order, whichever channel is driving
the node. Test mode plays the authored WAV positionally at the host rather than the slot it will eventually
occupy.

Auditioning a *direct slot* needs a bank to listen against, and an authored mountain ships none — its slot
becomes a sound only once it is repacked onto a level. So when the document's own level has no extracted bank
(every authored mountain: the target level is the mountain's name), the node grows an **Audition bank**
picker over `COURSE_BANK_LEVELS`, defaulting to the source level of the prop the effect is attached to. The
preview then answers "what does slot N hold on GARI", which is the honest question — the repack target
decides what actually plays. A retail reference graph names its own level, so it keeps the plain read-only
readout with no picker and nothing to author. Invalid slots show unresolved without a dead action.

### Sound Library

A slot number says nothing about what it holds, and the banks are sparse and level-specific — garibaldi1
populates 23 of them. **🔊 sound library…** on a Play sound node opens a browser over the extracted
`Maps/<level>/Audio/SFX` trees: pick a level, pick a bank, and every populated slot appears as its number
with **▶** to hear it. On the course bank each slot also carries **use**, which writes that number onto the
node *and* moves the node's Audition bank to the level it was heard on — a slot number means a different
sound in every course bank, so the choice is the pair, not the number. A slot gets picked by hearing it
rather than by guessing. Crowd, board and the named global banks are
listed under the same picker because they are the same on-disk shape, but they are browse-only: they are
reached by collision or ExternalSounds *events*, and a PlaySound slot number pointing at their index would
name an unrelated course slot.

The index comes from `GET /api/sound-banks` (levels) and `?level=<LEVEL>` (banks, populated slots, and the
map-local `Audio/SoundIndex.json` Snowknife extracted from that disc); slot bytes still come from
`/api/effect-sound`. Which folder *is* the course bank is answered by the sidecar rather than by scanning — a
level's SFX folder holds its group-2 bank beside named global banks that also ship a `000.wav`, so name-order
scanning answers low slots with the wrong sound.

The same browser serves the prop channels in an **event** mode (`SoundPickMode`), reached from **🔊 browse
impact events…** and **🔊 browse emitter events…** in the Props inspector ([012](012-props.md)). What changes
is the unit, not the panel: a Play sound node stores a slot, while a prop stores an *event id* the engine
remaps, and that mapping is many-to-one — collision events 5 and 70 both land on slot 1 — so a slot can never
be turned back into the id a prop needs. Event rows show the id, its material or bank name, where it
resolves, and ▶; ids the resolver leaves unmapped stay listed and marked `silent`, because "this id plays
nothing" is exactly the fact an author meets on an existing prop. The labels come from `collisionSoundLabel`
and `externalSoundLabel` — the fixed external banks name themselves (`River`, `Snowmachine`, `Helicopter2`),
which is what makes that space browsable at all.

The uploaded-WAV channel is one shared model in `ui/components/custom-sounds.ts`: one cache of the library,
one upload-and-name flow, one filepath convention, for props and effect nodes alike. It is a model rather
than a widget on purpose — the props inspector renders through lil-gui and this one through hand-built DOM,
so the two panels draw the same state in their own idiom. Those uploads are also a **Custom** source in the
browser, listed first like the Texture Library's own bank, with ▶ and **use**. That is a third assignment
channel — neither a slot nor an event but the file itself — so it arrives on its own `assignFile` callback,
and picking one clears the numeric side rather than leaving a WAV set alongside an id it would silently beat.

All three libraries open on the same rule (`ui/components/library-default.ts`): **your own content first,
then the level you are studying.** Custom wins when it holds anything, otherwise the loaded reference level,
otherwise whatever exists. An empty Custom deliberately loses — a view whose only content is an "add" button
is not where anyone wants to start. The Texture and Prop libraries re-derive this on first open as well as at
`init`, because boot chooses before the reference has finished loading; once the author picks a level
themselves that choice stands for the session.

Validation combines the P1 structural/reference validator with authoring checks.
Errors remain visible in the panel and block strict raw-node application;
warnings call out risky but representable values.

The authoring checks are the home for every rule that can be *decided from the
document*, in preference to a paragraph an author reads in advance:

| Check | Severity | Why it cannot be prose |
| --- | --- | --- |
| Missing prop target, out-of-range emitter word, non-positive Roller mass | error / warning | Structural |
| Roller on a prop with no physics source | warning | Moves in preview and Unity, static on PS2 |
| Lap-gated lift off the Megaplex slot | warning | Builds normally, lifts nobody |
| Latch columns: populated chain, no self-ending source, `slot4` vs a no-live-node gate, `slot6`/`slot7` | warning | Each is silent on hardware |
| Cracked surface with no Trigger effect | warning | Every node in it is correct and it still never breaks |
| Lifetime command in a Counter-fired Trigger effect | **error** | Measured as a reproducible console freeze |
| Any installing node in a Counter-fired Trigger effect | warning | Displaces the counter mid-update |
| `act-on-instance` / `rider-teleport` / `spline-toggle` / `call-function` with an empty reference | error | Drops the effect at export, or does nothing in game |
| A rail that starts off with nothing switching it on; a toggle switching on a rail that never left the network | warning | The node dispatches either way and the rail looks identical |
| Score multiplier present | warning | Exports cleanly and has never been seen to score |

The Counter checks are conditioned on the *sender*, not on the column: a
crack-fired Trigger effect full of property nodes is the shape the original
game ships, and warning on it would be wrong.

## Packaging boundary

`Effects.json` exports through the existing level bundle today and compiles back
to SSF through `snowknife effects-import`. A prop attachment itself spans two
files in the original game: the graph/slot is in SSF, while the owning object's
`EffectSlotIndex` is in the packed level instance table. P2 records that join
portably. P4 resolves stable authored prop IDs to final instance indices and
writes the join during ISO packaging (below).

## ISO compile (P4)

The export writes the resolver's other half into the same file: the prop bakes
report which `o <group>` names each placement produced in `Props.obj`, and the
exporter records them as `extensions.slopesmith.bakedGroups`
(`{ "<prop id>": ["<group>", …] }` — a group placement lists one entry per
member). `snowknife repack` then compiles the attachments (`Snowknife/Repack/AuthoredEffects.cs`):

- Each ATTACHED slot's circumstance graphs append to the work dir's
  `SSFLogic.json` (node payloads are already the library's SSF JSON dialect —
  `MainType` + the `typeN` payload, explicit nulls stripped), and the level
  build's `SSFGenerate` compiles them into the `.ssf` with everything else.
  Unattached slots and graphs are ignored. A Slopesmith-managed
  spline reference is resolved through its exported resource row to the matching
  compact index in authored `Splines.json`; unresolved or unsupported spline
  references still refuse the slot.
- A **called function** compiles the same way and appends to the work logic's
  `Functions` table, past the donor's own, and the appended row's index is
  written into the calling node as `FunctionRunIndex`. A body is an ordinary
  node list: it may hop, teleport, carry splines and call further functions, and
  a hop inside one is back-patched against the function table rather than
  `EffectHeaders`. A call naming no function refuses the slot rather than
  shipping a leftover index — the runtime only tests that index for negative, so
  any in-range value would run one of the donor's own functions on the rider.
  Because a called body runs on the SAME instance, the UV-scroll, mover and
  roller wiring below follows calls into it; it does not follow hops, which run
  on somebody else. The function's **name** is written through as authored,
  trimmed to 15 characters — 15 rather than 16 because the level writer pads
  that field without terminating it and the engine's own name lookup is a
  `strcmp`. That lookup is how the mode switch runs `RaceMode`, `ShowoffMode`
  and `FreerideMode` on an unowned thread ([Trailmap: 150-logic]), and it is
  **not** a hook an authored level reaches today: authored functions are
  appended after the donor course's, and the lookup returns the first match, so
  the donor's entry still wins. The name is preserved rather than normalized
  because that stops being true as soon as a level owns its whole table.
- The packed instance is stamped through `Instances.json`: `EffectSlotIndex` =
  the appended slot; a UV-scroll property node (type-0 SubType 10/19) anywhere
  in the slot sets the instance's `UVScroll` bool, which the library turns into
  ObjectProperties **BitFlags bit 13** — the retail river wiring, and what makes
  the scroll actually run on the PS2. A collision-circumstance graph does not rewrite
  its placement's collision profile: shape, PlayerCollision, responseMass, PlayerBounce/amount,
  and an optional physics-body donor remain independently editable. Incompatible
  combinations warn because the graph cannot dispatch without eligible contact.
  Ordinary mesh contact uses a generated `TriangleProxy` (`CollsionMode 1`), bounds use
  mode 2, and mode 3 may reuse a sphere-tree donor from the export target's own physics
  pool. **Add Trigger** starts with the conventional hidden, ride-through profile:
  `PlayerCollision=true`, `responseMass=0`, and `PlayerBounce=false`. Those are defaults rather
  than restrictions; making the trigger solid is allowed and warns that it will block
  the rider. `Visable` is render-only; mode 3 fails when its required body is missing,
  not because the host is hidden.

The full mode/rate/timing cycle comes from the compiled graph's UVScroll node.
The deduped `Scroll.json` + `mat_<id>_scr<k>` tags carry that same complete
motion profile into the Unity bundle (Unity docs/008): U/V rate, named mode, active and
pause intervals, and finite lifetime. The shared Unity shader evaluates it
at the native fixed 60 Hz without a runtime script. An export made before `bakedGroups` existed
compiles nothing and warns — re-export to wire its effects. Suite:
`npx tsx test/effects-wiring.test.ts`.

Texture **flipbooks** ride the same seam. A material's frame list is a *state*
list; what plays it is the effect, and the flip node's **lifetime** is the whole
discriminator. A placement whose persistent graph carries a **Flipbook** or
**Dwell screen** node (lifetime 0, so it lives as long as its slot) publishes its
rate in `Flip.json` — `{Id, Speed, U4}` per combined MaterialID, the same table
`snowknife` writes out of a retail level — and the bundle then animates it exactly
like a shipped directional sign. A **Ride-over button**'s flip carries a finite
lifetime instead: it is a one-shot the crossing fires, so it stays out of
`Flip.json` and Snowknife classifies the placement as a triggered pulse, replaying
the node offline into the frame-and-hold list the runtime walks. A material whose
frames no effect drives at all simply rests on frame 0. One rate per material, as
the native table stores it: placements sharing a flipbook material share its rate,
and the export warns when a second placement asks for a different one — give it
its own tile or its own frame list to flip it differently.
