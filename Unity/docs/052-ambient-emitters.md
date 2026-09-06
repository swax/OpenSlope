# 052 — Ambient emitters (collision-triggered dust / spark / fire / water / snow)

SSX has a class of environmental particle bursts a rider sets off by crossing a trigger volume: a tree-break
green **spark** fountain + rising orange **fire**, cyan **sewer-dust** puffs, a **highway**-barrier smash,
**fire hydrants** (a water spray on each hit), and UNTRACK's **snow-ghost trees** (a pale `clod` burst from
the canopy). They are distinct from the two effects already imported:

- **Fireworks** (docs/019) — a lit volley whose emitter sub-effect carries a `MainType-8` SoundPlay report.
- **Continuous emitters** (snow cannons / flares, EmitterBuilder) — always-on, on a `PersistantEffectSlot`.

An ambient emitter is the collision-triggered emitter with **no report sound**.

## Graph shape

Off a trigger's `EffectSlots[slot].CollisionEffectSlot` header, in three authoring shapes:

- **M7-marker** — a `MainType-7` hop to an invisible emitter marker whose sub-effect is a `MainType-2/SubType-0`
  emitter with **no `MainType-8`**. Fires from the marker's origin. (tree-break spark/fire, city sewer-dust.)
- **Inline** — a `MainType-2/SubType-0` emitter directly in the collision header. Fires from the owning prop.
  (highway smash + fire hydrants.)
- **CollideEmitter** — a dedicated `MainType-2/SubType-2` node directly in the collision header. It uses the
  same 51-field P6 law as SubType-0, but contact is its native trigger. UNTRACK effect 10 is the single retail
  graph of this shape; its slot is shared by all 34 `Mdl_Tree_SnowGhost_*` instances and selects sprite 2
  (`clod`) with an additive pale-blue ramp. Its stored U9–U11 origin is replaced by the exact hit point. Only
  `length(U18..U20)` survives from its authored base velocity: the hit's outward normal becomes the direction,
  while U21–U29 velocity variation stays authored. UNTRACK therefore launches at 800 cm/s away from the surface.

**Discriminator**: SubType-2 is unambiguously a `CollideEmitter`. For the SubType-0 marker/inline shapes, the
absence of an `M8` report in the emitter's own sub-effect (`IsPyro` returns false) separates a firework volley
from a silent ambient burst. Silent look-alikes are classified by their sibling nodes: gems (`M14`), boost pads
(`M17/M18`) and balloon-breaks (`DeadNode` mode 4) are owned by other importers, so headers carrying those are
skipped.

**Lifecycle**: `DeadNode` mode 2 = fire once per load (one-shot); a `Debounce` (`M0/Sub2`, no DeadNode) = re-fire on
each hit (the hydrants, ~7 s). In-world both use a re-entry cooldown (`MinInterval`); hydrants inherit the 7 s debounce,
one-shots use `AmbientCooldown`. A dedicated `CollideEmitter` re-fires behind the engine's 30-logic-tick contact
gate, exported as a 0.5 s minimum interval.

`Type2Sub2` has one format wrinkle: the legacy SSF reader preserves all 51 fields as integer words. Thus
Effects.json carries IEEE-754 bit patterns in `U2..U48` (`1128792064` means `200.0f`). Snowknife reinterprets
those words at the bundle boundary, then feeds the semantic values through the same `EmitterLayerInfo` path as
SubType-0. It also expands a shared slot to every owning instance; retaining only the first owner would build one
snow tree instead of 34.

## Pipeline

- **Bake** — `ParticleBundle.BuildAmbientEmitters` → `manifest.AmbientEmitters`. Each record carries the emit origin,
  the trigger volume (the owning instance's Props.obj bounds), `Repeatable`/`MinInterval`, and the per-layer
  P6 law (reusing `EmitterLayerInfo`) transformed into root-local mesh space. A shared effect slot produces one
  record per placed owner. Only a few levels have any (a dense city map carries the most water/dust records;
  UNTRACK adds its 34 snow trees). `ContactDriven` marks only the SubType-2 records; the stored origin/base vector
  remain in the lossless layer, while `ContactSpeeds` carries each transformed base-vector magnitude to runtime.
- **Import** — `AmbientEmitterBuilder` builds a playable P6 hierarchy (playOnAwake off) at the authored origins,
  plus an invisible `BoxCollider(isTrigger)` + an `AmbientEmitterMarker` at the trigger volume (the VRChat wiring pass realizes `AmbientEmitter`, [013](vrchat/013-udon-components.md)). It uses the same P6
  shader/builder as persistent emitters and fireworks. Count, emission window, lifetime, size, spawn/velocity
  bases, gravity, color, sprite, blend, and trail copies are authored. `AmbientCooldown` remains the one-shot re-entry guard.
- **Runtime** — `AmbientEmitter` Plays the burst systems when the local rider (walking or on the board's
  RiderProbe) enters, broadcast to all (docs/vrchat/043) so everyone sees it. For `ContactDriven`, the runtime
  walks backward along the rider/board velocity to the imported bounds' entry face, writes that surface point and
  outward normal into per-renderer P6 shader overrides, and preserves the authored speed/variation. This is an
  imported-bounds approximation to retail's exact model-collision frame; Slopesmith has the exact triangle/proxy
  hit and uses it directly. VRChat manually syncs point/normal/sequence (with a late-join timestamp guard); Basis
  sends the six floats in the reliable event payload, so remote peers reproduce the same burst. Ordinary ambient
  emitters keep the parameterless event path. The
  Tuning Board's *Particles* row includes the whole `AmbientEmitters` root, so disabling it also silences these trigger
  colliders and behaviours; the static `Particles` fog meshes remain under the separate *Fog banks* control.

## Roller props — shove-able bodies + the hydrant lids

The SSF **Roller** (`MainType-0/SubType-0`, spec `230-level-ssf.md`) makes a target instance a knock-off rigid body:
launch along an authored direction + gravity + tumble + terrain bounce + settle. Every instance a **collision** header
rolls — inline (a pylon/sign) or via a `MainType-7` hop (a hydrant's `TopLid`, a garbage can's lid) — is a shove-able
prop, diverted as a `PhysicsProp` knock-and-tumble body (ride through it, it flings). It's the city clutter:
garbage cans + lids, news boxes, mailboxes, pylons, signs, benches, traffic lights — present in small numbers per
course, most on a dense city map.

The **subset** whose collision header ALSO fires an emitter — the **fire hydrants** — additionally gets a lid POP:
the hydrant's `TopLid` is a Roller target whose authored launch is `(0,1000,0)` (straight up). On a hit `AmbientEmitter`
sprays the water AND `Pop`s the lid up; after the debounce (~7 s) `RearmLids` returns it to its home pose for the next hit.

- **Bake** — `ParticleBundle.BuildRollerTargets` returns all collision-Roller targets (→ physics divert) plus the
  owner→targets map for the emitter-firing (hydrant) subset (→ the lid pop). `BundleExporter` routes the targets into
  `PropsBundle`'s physics divert.
- **Runtime** — the shove props are plain `PhysicsProp`; the hydrant lids also carry `AmbientEmitter.RollerLids`
  so the emitter Pops + re-arms them. `PhysicsProp.Pop`/`Rearm` capture a home pose in Start.

Re-run standalone with **OpenSlope/Refresh/Ambient Emitters**.
