# 028 — Breakable Signs (the LCD logo break)

> The break is reproduced in the importer (`PropBuilder.BuildBreakableLogos`) + a runtime
> Udon (`BreakableLogoU`); see ["How it's wired"](#how-its-wired) below. Developed against a shipped
> SSX level. The data wiring is in `Maps/<level>/Effects.json`; the functional spec is [Trailmap: 150-logic].

## The short version

The thing you "smash through with a sound" is the **LCD jumbotron logo**, not the wooden
directional or warning signs. Breaking it is a **scripted mesh-swap**: the intact logo screen is hidden
and a pre-modelled *broken* twin (already placed at the same spot, `Visable=false`) is revealed, plus the
LCD collision sound. It is **not** a physics shatter and **not** a particle debris burst — the game authors
zero collision-debris emitters (see [014](unity/014-particles.md)).

## Which props actually break

All the "sign-ish" props carry an `EffectSlotIndex`, but only one fires a *break* on collision:

| Prop | mode | response mass (native `U0`) | `EffectSlotIndex` | On-collision effect | Behaviour |
|---|---|---|---|---|---|
| `Mdl_DirectionalSign_Blue/_Red` | 1 | 1e30 | 48 | none (persistent arrow `TextureFlip`) | **solid bounce**, arrow animates |
| `Mdl_WarningSign_*` (Jump/Gap/Ice/Cliff) | 3 | 1e30 | 52 | none (persistent `TextureFlip`) | **knock-over physics prop** ([016](016-physics-props.md)) |
| `Fnc_FenceChainLink_*` | 1 | 1e30 | 44 | `Type0` sub12 `Fence` (flex/rattle) | solid, rattles |
| `Mdl_Billboard_Ad_A` / `EABig` | 2 | 1e30 | −1 / 37 | none | solid scenery |
| **`Mdl_Lcd_ScreenLogo_*`** | **2** | **0** | **15** | **`RunFunc BreakLogo*`** | **rides through, logo breaks** |

The breakable screen's zero response mass is the same value the [leaf-swish cutouts](../VRC/Riding/Board/RideableBoard.Surface.cs)
use — it registers a collision *event* (to fire the effect + sound) without hard-stopping you. That is
literally "hit it and break **through** with a sound".

## The break chain (data, fully traced)

For the `_4001` jumbotron the `BreakableLogoMarker` sits on:

1. **Intact screen** `Mdl_Lcd_ScreenLogo_4001` (instance 1470): `mode 2`, `ResponseMass 0`, `PlayerCollision true`,
   `EffectSlotIndex 15`, `CollisonSound 63`.
2. **Pre-broken twin** `Mdl_Lcd_ScreenLogoBroken_4001` (instance 1469): same place, `Visable=false`
   (hidden at load — [003 gotcha 4](unity/003-props.md) keeps its render mesh out).
3. **Scanline overlay** `Mdl_Lcdscan_4001` (instance 1468).
4. Player contact → `EffectSlots[15].CollisionEffectSlot = 49` → `EffectHeaders[49]` = one `MainType 21`
   node → `Functions[6] = BreakLogo4001` → three `MainType 7` instance toggles:
   - 1470 intact logo → **hide**
   - 1469 broken logo → **show**
   - 1468 scanlines → **hide**

One `BreakLogo1000…7000` function exists per jumbotron, so each breaks independently. The same
collision→`EffectSlotIndex` mechanism drives the [fireworks](019-fireworks.md); here the effect runs a
named `Function` instead of spawning pyro. The bounce + sound on that hit are the separate prop-collision
response; sound id `63` remaps (`63→64`) to the LCD/glass-break slot in the course bank ([015](015-audio-runtime.md)).

## The effect-graph side (confirmation)

Each effect node is dispatched by its `MainType` [Trailmap: 150-logic]:

- **`MainType 21`** — schedule `Functions[idx]`.
- **`MainType 7`** — resolve the target instance by index, then construct an effect node carrying the node's
  `EffectIndex`, which sets that instance's rendered state. This is the primitive that hides the intact logo
  and shows the broken one.

## The broken twin is a real mesh — but it looks ~identical to the intact

[003 gotcha 4](unity/003-props.md) lumped the `Visable=false` "broken screen" variants in with the firework /
reset / phantom volumes as "wearing the red no-entry placeholder sheet `0052`". That is **wrong for the
broken screens** (it's right for the genuine volumes). Inspecting `Props.obj` + `Materials.json`:

| instance | geometry | material → texture |
|---|---|---|
| `Mdl_Lcd_ScreenLogo_4001` (intact) | 156 v / 174 f | `mat_106` → flipbook `0061↔0062` (the lit, animated logo) |
| `Mdl_Lcd_ScreenLogoBroken_4001` (broken) | **852 v / 825 f** | `mat_54` → `0061` (same logo texture, more-tessellated geometry) |
| `Mdl_Lcdscan_4001` (scanline) | 12 v / 6 f | `mat_56_scr1` → `0063` UV-scroll overlay |

So the broken twin is a real mesh (not the red sheet) — but **verified in-engine, it looks almost identical
to the intact screen**: same `0061` logo texture on subtly-more-tessellated geometry, no visible shatter
from any normal angle/distance. So the game's literal "swap intact→broken" reads as *nothing changing*.

**What the break actually looks like in-game:** the screen **disappears**, shattering into glass shards
that burst away (the player's lived experience), leaving the empty frame. The broken twin is best understood
as the pre-fractured shards in their *unburst* position (which is why it looks like the logo); the game
scatters them. We reproduce that directly: hide the screen + scanlines (it vanishes) and **throw the broken
twin's own shards** — its mesh is split into connected-component pieces that fly apart on the hit (the same
piece-throw the fences/hole-covers use, [036](036-breakable-props.md)). A twin modelled as a
single welded sheet has no shards to scatter, so there we fall back to a textured sprite burst instead.

## How it's wired

Maps onto the single-layer Udon pattern ([013](vrchat/013-udon-components.md)), like the firework triggers
([019](019-fireworks.md)) — local-only, no networking. Config lives under `// breakable LCD logos` in
`ImportConfig` (`BuildBreakableLogos`, the three match strings, trigger inflate, respawn, debris knobs).

1. **Importer (`PropBuilder.BuildBreakableLogos`), fed by `snowknife`'s break classifier.** The
   intact/broken/scanline roles come from the SSF **`MainType 21` `BreakLogo*` function** the screen's
   `CollisionEffectSlot` runs (`BreakableClassifier.FunctionRoles`): the function's `MainType 7` nodes name the
   members — the collision-effect **source** instance is the **intact** screen, an invisible reveal-target is the
   pre-placed **broken** twin (`Visable=false`), a visible hide-target is the **scanline** overlay. The cluster
   keys **`lcd_<source>`** — distinct from a fence/hole-cover's `brk_` cluster, so the importer keeps the
   identical-looking twin **hidden** on break (the shard burst is the visible break, [036](036-breakable-props.md)).
   The three screen instances are pulled OUT of the merged mesh into their own `Accum`s (the spinner/physics
   extraction trick, [012](012-spinning-pickups.md)/[016](016-physics-props.md)); the `Visable=false` broken twin
   is **force-emitted** (`curForceEmit`) so its geometry survives. Each instance becomes a `MeshFilter`+`MeshRenderer` child at a shared `localPos 0` (the
   divert's `Center` is 0, so the meshes keep absolute root-local coords and stay aligned); the intact logo's
   animated material is re-registered with the flipbook animator ([008](008-texture-animation.md)). One
   pass-through trigger `BoxCollider` (grown by `BreakLogoTriggerInflate` so a fast rider catches the thin
   panel) covers the screen face; an `Fx` child at the screen centre carries the break `AudioSource`
   (CollisonSound 63 → course bank slot 064) + the debris. All under `BreakableLogos`.
2. **Runtime (`BreakableLogoU`, `SyncMode.Manual`).** `OnPlayerTriggerEnter` (walking) / `OnTriggerEnter`
   from the board's `RiderProbe` (riding, gated on `IsRiding` + optional `minRideSpeed`, mirroring
   [023](023-gem-pickups.md)) → hide the intact + scanline renderers (**the screen vanishes**), one-shot
   the LCD break sound, **throw the broken twin's shards** (the `pieceTransforms`, integrated as a
   mesh-piece toss along the impact direction with gravity for `throwDuration`, [036](036-breakable-props.md)),
   and latch. When the twin is a single welded sheet (no shards), it is instead revealed only if
   `BreakLogoRevealBroken=true` (off by default — such a twin looks identical to the intact, so showing it
   reads as "no change") and a sprite burst stands in for the shatter. `respawn` re-arms the screen after
   `respawnDelay` so the persistent free-roam world stays whole (and it can be broken again).
3. **Shard throw (the visible payoff).** The screen vanishing is the swap; the *shatter* is the broken
   twin's own geometry flying apart. Where the twin is a real fractured model (e.g. a fractured model on
   another level, `Mdl_Lcd_ScreenLogoBroken*`, which splits into ~9–18 textured shards — a panel face, bezel/frame strips,
   thin fragments), `snowknife` splits it into its **connected components** in the bundle (the same split the
   fences/hole-covers get, [036](036-breakable-props.md)) and emits one `Piece` record per shard, recentred
   on its own centroid so it can tumble. The importer builds those as the cluster's `pieceTransforms` (hidden
   until the break), and `BreakableLogoU` throws them. No particle is spawned in that case — the flying
   shards *are* the shatter (and the original emits no `CollideEmitter` here either).
   - **Sprite-burst fallback.** When the broken twin is a single welded sheet (nothing to split) and
     `BreakLogoDebris` is on, `BuildLogoDebris` stands in a particle burst: by default each shard is a
     **fragment of the screen's own image** — the intact screen's texture (the `0061` logo) split into a
     `BreakLogoDebrisTiles`×`Tiles` grid (4×4 = 16) via the particle texture-sheet — emitted from a box the
     size of the screen face (gravity + tumble). `BreakLogoDebrisUseScreenTexture=false` swaps in the bank's
     angular glass-shard sprites `cnf1/cnf2` (icy-tinted). `brk1-3` are **tree bark**, not glass. Toggle the
     whole burst with `BreakLogoDebris`.
4. **Networked option (later).** A logo break is a shared spectacle; a master-owned synced bool per screen
   would let everyone see it broken. Left out like every other SSX runtime so far.
