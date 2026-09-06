# 035 — Rideable prop surfaces

The proxy/visibility/response split below implements [Trailmap:
120-objects, 130-collision-data, 310-surface-response]. Those chapters own the
behavior and cite the reverse-engineering evidence; this document records its
Unity realization.

## What the bridge actually is
The marked spot is the **swaying bridge**, authored in SSX as two cooperating instances:

| instance | model | role | flags |
|---|---|---|---|
| 1446 | `Mdl_bridgesway_3000` | the **visible** swaying deck | `Visable=true`, `PlayerCollision=false`, no proxy |
| 1447 | `Mdl_bridgesurface_3000` | its **collision** (invisible) | `Visable=false`, `PlayerCollision=true`, response mass 1e30 (nonzero solid response), 4 collision models, `CollisonSound=78` |

A separate `Mdl_Bridge_River_7000` (1475) nearby is **not** a deck — it's a flat plane at the gorge
floor (Y≈38), i.e. the **river water surface**. Correctly non-collidable.

The wood bridge elsewhere on the map (`Mdl_woodBridge_A1_1000`) follows the same split: a
`PlayerCollision=false` visible deck + dedicated `Mdl_BridgeProxyCollision_0/1` proxies. **The general
SSX pattern: a visible deck has no collision of its own; an invisible solid proxy carries it.**

## The collision imports correctly
Per [Trailmap: 130-collision-data], snowknife's collision bundler keeps mode-1 proxies with nonzero response mass and `PlayerBounce=true` as solid colliders. Therefore `bridgesurface`
(1447) is bucketed into `PropsCollision_Bounce_0_5_Snd78` and lands in the scene as a **continuous,
solid, non-convex MeshCollider on the Default layer covering the whole deck** (sampled Z 250→360,
~16–32 m wide, Y rising 72→97). That's why **walking works** — the VRChat player capsule collides with
every Default-layer collider.

## How the board decides what's rideable
`RideableBoard`'s ground probes (`ProbeDown`, `ProbeContact`, `SampleGroundY`) accept a raycast hit
if the collider is in the board's terrain set (`_colliders`/`_types`, populated from
`OpenSlope_Map/Collision/Surf_*`), or if it passes `IsRideableProp`:

```text
int ci = IndexOf(c);
int ty = ci >= 0 ? _types[ci] : -1;
if (haveTerrain && ty == -1)
{
    if (!IsRideableProp(c)) continue;   // skip non-surface props (sign boxes / triggers / crash bags)
    ty = propRideSurfaceType;           // ride solid prop proxies (bridges/ramps)
}
```

The base terrain-only filter exists so the board doesn't "level off" mid-air on crash bags / the start
gate / banners. `IsRideableProp(Collider)` is true only for a real solid proxy bucket (name starts
`PropsCollision_`, not a trigger) — it **excludes** the AABB sign/billboard boxes (`Bounds_*`, not a real
surface), foliage triggers (`isTrigger`), and knockable crash bags (`PhysicsProp` — their colliders
aren't named `PropsCollision_`), exactly the "leveling-off" hazards the terrain-only filter guards
against. A prop collider that fails `IsRideableProp` is skipped — so **without that check no prop
surface is rideable**: bridges, prop ramps, etc. would drop the board straight through, even though
walking across them on foot works fine (the player capsule collides with any Default-layer collider
regardless of type).

The real SSX boarder has no such terrain-vs-prop split: its ground-contact probe
(aimed by the previous contact normal — see docs/021 and [Trailmap: 320-ground-contact]) contacts
*any* collision surface in the world, so it rides the bridge proxy natively — `IsRideableProp` is what
lets our board match that.

Tunables: `rideSolidProps` (bool, default **true**) and `propRideSurfaceType` (int, default **-1** — see
"Engine grounding" below; the SurfaceType the board reports while riding a prop).

The obstacle collide-and-slide already passes through up-facing surfaces (`normal.y > wallNormalMax`),
so riding the deck doesn't fight the wall system; steep prop faces still block. `propRideSurfaceType=-1`
sits outside the OOB-Reset surface (type 0) and the wall-eject types (10/13/14/18), so neither fires.

## Recommended: import-time validation
An import-time validation pass could log surfaces the board can't ride: visible props with a solid
collider whose collider isn't in the terrain set — flag names containing
bridge/ramp/walkway/platform/stairs, or large spans over a drop. A bridge over a gorge that the board
can't see is an obvious red flag; without this pass it's only found by riding off it. Not yet built.

## Engine grounding (why -1, not snow)
Assigning a prop a terrain SurfaceType (e.g. `1` = groomed snow) is *not* faithful ([Trailmap: 320-ground-contact]):
- The boarder's ground-contact query **dispatches both terrain *and* object intersection** — so props are
  first-class collision in the contact query (riding the bridge is correct).
- The nearest-hit result carries the `SurfaceType`, copied onto the boarder.
- The per-SurfaceType material table is indexed **`SurfaceType * 100`** (20×100-byte records). A prop's
  `SurfaceType == -1` would index `-100` — it *can't* use the table, which is exactly why **extracted props carry
  `SurfaceType == -1` and route through object/collision-mode handling instead of the terrain material table.**

So `-1` is the engine's own value for a ridden prop. In our board `-1` falls through every feel switch to
the firm DEFAULT (friction 0.07 / grip 0.70 / 14.4 m/s cruise, SinkSpring "firm/dead"), the surface spray's
per-type table has no `-1` row (`UpdateSurfaceSpray` returns) and `IsSnowSurface(-1)=false` — so a wood
bridge rides firm with **no snow spray and no snow-sink**, and the board's own OOB code already calls `-1`
"prop". (Override `propRideSurfaceType` only to deliberately borrow a terrain material's feel, e.g. `5` for
an icy ramp.)

**Ride AUDIO is the exception — it reads the prop's REAL SurfaceType**, carried in the collider name as a
`_T<type>` tail (the animated bridge's colliders are `PropsCollision_..._T12`; [038](../038-animated-props.md)).
The probes track it as `_pAudioSurf` (parsed by `PropAudioSurfaceType`, one-entry collider cache) separately
from the feel's `propRideSurfaceType`, and `AudioGroupFor(12)` selects the WOOD board-audio group (zboard
carve `043` / glide `044`, the real engine surface→group pairing — [Trailmap: 420-audio-runtime]) — the planks
*sound* like wood while riding firm. An untagged prop parses to `-1` → the packed-snow fallback group.

## The sway
The marked deck is `Mdl_bridgesway_3000`; its collision is the separate `Mdl_bridgesurface_3000`. The sway is
the **AnimObject** system ([038](../038-animated-props.md)): a persistent SSF `type0 Sub256` plays the model's own
piecewise-cubic clip on the visible deck and `MainType 7`-chains the identical clip onto the collision twin, so
**the ride surface swings in sync with the render**. Both twins are built by `PropBuilder.BuildAnimated` and
driven by `AnimatedPropU`; the moving collision segments keep the `PropsCollision_*` prefix, so everything in
this doc (the `IsRideableProp` gate, the `-1` feel, the `_T12` ride audio) applies to them unchanged.

**Rollout note:** adding fields to an existing UdonSharp behaviour requires an explicit push to existing
board instances' Udon backing data (the new-field-default gotcha): force a UdonSharp
program compile (`UdonSharpProgramAsset.CompileAllCsPrograms()`), then per board set the fields +
`UdonSharpEditorUtility.CopyProxyToUdon` + save. `GetProgramVariable`/`GetProgramVariableType` are
unreliable/NRE in edit mode — use the `CopyUdonToProxy` round-trip to read backing state instead.

See docs/009 (collision), docs/vrchat/017 (rideable board), docs/021 (smooth contact normal).
