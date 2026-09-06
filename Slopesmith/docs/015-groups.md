# 015 — Group props

A **group** is a library entry that places a whole assembly with one click — the fire hydrant *and* its top
lid, the directional sign *and* its stand, the street lamp *and* the halo spot at its head. Groups are
**mined from the reference levels' own placement data**, not hand-authored: the shipped levels already
compose props this way, and the mining recovers exactly the assemblies (and lights) the artists placed.

It generalises the billboard sign-light idea (013): where a billboard *derives* its light from the placement,
a group placement derives its sibling models **and** its lights — move it, everything follows; delete it,
everything's gone.

## What the shipped data authors

Two placement patterns carry the assemblies, and both are exact — no proximity fuzz:

- **Co-placed models.** Multi-model props stack at an IDENTICAL `Location` + `Rotation`; the member offset is
  baked into each model's local geometry. Every reference `FireHyDrant_TopLid` sits at exactly its
  `FireHyDrant_Base`'s coordinates (25/25), every `DirectionalSign` exactly on its stand (57/57), every
  `Tree_SparceLeaves` exactly on its trunk (441×). So an assembly = a set of models that repeatedly co-occur
  at the same placement.
- **Fixture lights.** A lamp's light is a separate `Lights.json` record standing at a CONSISTENT offset in
  the fixture's LOCAL frame: the reference's `mediumHalo_streetLight` spots sit 25.4 m up and ~4.6 m out along the
  arm of each `StreetLight_Tall`, rotating with the lamp's yaw. (The plain `SD_StreetLight` records, by
  contrast, are free-placed road lighting — no consistent local offset, so they correctly don't attach.)

## Mining (`core/reference/groups.ts mineGroups`, pure)

- **Combos** — bucket instances by exact location; a bucket with ≥ 2 distinct models, co-rotated and
  co-scaled, records one occurrence of that model-set signature. Signatures placed ≥ 3 times become defs
  (`MIN_COMBO_OCC`), capped at 6 members (`MAX_COMBO_MODELS` — larger identical-origin stacks are modular
  architecture). Junk twins (`junk`) and reset shells (`_reset`) are excluded first, so a group never stacks
  a broken mesh or a collision volume over the real model.
- **Fixture lights** — for combos, and for single models with ≥ 8 placements (`MIN_FIXTURE_OCC`), express
  every positive spot/point within 35 m (`LIGHT_NEAR_CM` — past the tallest fixture head, short of the NEXT
  lamp in a regularly spaced row) in each occurrence's local frame, cluster the offsets (1 m buckets), and
  keep clusters consistent across ≥ max(4, 30 %) of occurrences. A light that belongs to the fixture sits at
  the same local offset every time; nearby scene lighting doesn't. Colour/intensity/cone/reach are averaged
  over the cluster's records (peak-normalised hex + HDR intensity, like the decoded reference rig); the
  member's name is the cluster's dominant record family. Billboards are excluded — they already derive
  their sign light (013). Subtractive and sun-family records never attach.
- Results: a dense night-city level mines 50 groups (streetlight ×153 with its halo spot, hydrant, garbage can + lid, trees,
  traffic lights, park lamps, police car with red/blue flashers, jumbotron, billboards…), a daytime mountain 13 (trees,
  billboards, sign + stand, the 3-model LCD tower, checkpoints).

Mining is deterministic over the static extracted data, so a def is **reproducible from the level alone** —
docs stay small (a placement stores just the def id) and the export re-mines the same defs it placed with.
`tools/reference-study/smoke-groups.ts` prints a level's mined defs.

## Serving

`server/routes/groups.ts readLevelGroups(level)` reads `Models.json` + `Instances.json` (+ the light rig via
`readLevelLightRig`), runs the miner once per level (cached), and orders each def's members **leader-first**
by bbox volume — the leader is the model a placement stores, previews and seats by. `GET /api/groups?level=`
serves the `GroupsPayload`; `groupDefIndex(levels)` is the export's lookup.

## Placement model — a group IS a placed prop

A placed group is one `PlacedProp` carrying `group: <def id>` (`model`/`name` = the leader). Everything else
derives, so the whole prop machinery is reused verbatim: selection, the move gizmo, MMB pickup (re-arms the
whole group), undo/save/persist, the ghost (which previews every member), and the placement matrix. In the
viewport a placement renders as a pose Group with one child Group per member (`memberLocalMatrix` — zero
offset for mined members, the transform exists for future hand-authored groups); clicking any member selects
the assembly.

The group's **light members** resolve into the one authored rig (`authoredGroupLights` →
`setAuthoredLights([...sign, ...free, ...group])`), so the terrain glow, the gizmo cones and the Local lights
pill all apply with zero new lighting code. `PlacedLight.ofGroup` marks them (they draw with the derived
gizmos, not the editable free-light ones).

## UI

- **Prop Library ▸ Groups chip** — one tile per def: a thumbnail of the WHOLE assembly
  (`ThumbRenderer.renderSet` — every member at its group-local pose), a `⧉N` member-count badge (`✸` marks a
  light member), and a tooltip listing the members + how often the source level places the assembly. Click
  to arm; one click on the mountain places the set.
- **Preview card** — holding or selecting a group shows the assembled set in the live drag-to-orbit view
  (`prepareSet`), with the **component list** right below the name: `▪` per member model, a coloured dot +
  kind/intensity per light. A plain prop shows no list.
- **Tools** — a selected group shows the usual turn / size / delete (labelled *delete group*); the
  base-keeping scale nudge uses the assembly's lowest member.

## Prop tint from the rig (all placements)

Alongside groups, placed-prop tinting generalised: a placement without a billboard sign light samples the
authored rig at its leader's bbox centre (`viewport.placementGlowTint`, same saturating multiply as the
billboard tint) — so a free light colours the props near it, and a group's fixture light lights its own
lamp. A placement that catches no light keeps its shared materials (no clones). Billboards keep the on-beam
`aimAt` sampling (a tall board's centre can sit above the raked beam).

## Export

- **Props** — `expandGroupProps` turns each group placement into per-member placements for the Props.obj
  bake: identical-origin instances, exactly the form the shipped levels author. The log line counts
  placements vs baked prop meshes.
- **Lights** — the group lights join the sign + free lights: baked into the terrain lightmap and written to
  `Lights.json` (a Type-1 spot / Type-2 point at the placement-derived position, HDR colour, cone cosine,
  reach-sized influence box). Verified: a placed street-lamp group exports one spot at exactly the lamp-head
  offset rotated by the placement's rotation. A member's own `relYaw` is a turn in the GROUP's frame, so it
  composes onto that rotation rather than adding to its yaw — a tilted group carries its members with it.

## Caveats

- A group placement renders just its leader until its level's defs land (`ensureGroupDefs`, fetched on doc
  load / arming); the member models + lights appear on the retry rebuild.
- Mined defs are suggestions from placement statistics. The evidence thresholds kill almost all noise, but a
  crowd-district def can carry the event lights that consistently ring it — delete a group and place the
  plain model if a def isn't what you want.
- Def ids are slugs of the member-name prefix, unique per level (`streetlight-tall`, `firehydrant`,
  `directionalsign-2`). Re-extracting a level keeps them stable as long as its placements don't change.
