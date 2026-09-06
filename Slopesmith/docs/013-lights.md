# 013 — Light and sound sources

A read-only **Sources** overlay: show a reference level's spatial light sources as compact bulb/spotlight icons and its
prop-attached external sound emitters as speaker icons. Click a light icon to expand only that light's cone, sphere,
or sun arrow; click a speaker to expand only that emitter's listener range. This keeps dense retail rigs
legible while still exposing the exact source you want to study.

This is a study layer, not an authoring one — it draws the extracted rig so you can see it. Baking a sign
glow onto authored terrain is a later step (see **Next**).

## Where the lights live

`snowknife import` writes `Maps/<LEVEL>/Lights.json` — the level's whole light rig, one record per light:

- **`Type`** — `0` directional (the sun), `1` spot, `2` point, `3` ambient (sky fill).
- **`Colour`** — HDR RGB. Well past `1.0` for bright lights, and **negative** for the *subtractive* "shadow"
  lights the artists use to pool darkness under objects and in tunnels.
- **`Position` + `Direction`** — source point and unit aim, in raw SSX space (cm, Z-up, X-mirrored).
- **`LowestXYZ` / `HighestXYZ`** — the light's influence box, which sizes how far its gizmo reaches.
- **`UnknownFloat2`** — a spot's cone half-angle **cosine** (`0.92388` = cos 22.5°, `0.9397` = cos 20°).

A reference night-city level carries close to a thousand lights: 1 sun, 1 ambient, and the rest local — of
which some are named **`SignLight`** (each sitting ~12–19 m off a `Mdl_Billboard_*` prop, aimed at it), a set
of tunnel lights, a handful of `Sunlight` fill spots, and hundreds of **subtractive shadow lights**. The
night-city levels carry the richest rigs; the daytime peaks (MOUNTAIN09, SMOKEMTN) ship only the sun + ambient.

`ref-level.sunFromLights` already reads the ONE directional + ambient from this file to seed the authored sun
(see 011 / the lighting study). This overlay reads the **whole** rig to draw it.

## Co-registration (why the lights land on their props)

Every light goes through the **same** raw→editor map as the terrain and props — `ref-level.editorFromRaw`
for positions, and its linear part (renormalised) for directions. So a light lands exactly where the level
authored it, on the prop it lights, and rides `refRoot`'s game-chirality flip + placement offset along
with the terrain and props. A raw-cm standoff of, say, 12 m between a sign light and its billboard is 12 m in
the editor too (the map is an isometry up to the cm→m scale).

## Pipeline

- **`server/routes/levels.ts`** — `readLevelLightRig(level)` reads `Lights.json` and trims each record to a
  `RawRigLight` (name, type, colour, dir, pos, influence box, cone cosine). Returns `null` when the level
  ships no `Lights.json`.
- **`server/api/levels.ts`** — `GET /api/lightrig?level=<LEVEL>` → the `LightRigPayload`. Fetched on demand, only the
  first time the overlay is switched on for a level.
- **`core/reference/lights.ts`** — `decodeLightRig(payload)` maps every light into editor space: `pos` / `dir`
  through `editorFromRaw`, a `reach` in metres from the influence box, a display `colorHex` (the light's own
  normalised hue, or a cool slate for a subtractive one), a `category` (`sign` / `sun` / `tunnel` / `crowd` /
  `neg` / `spot` / `point` / `ambient`) for colour-coding + the summary counts, and `negative` (an
  all-non-positive colour = a shadow light). Browser-safe; the server does the disk work.
- **`app/viewport/scene/source-markers.ts`** — builds DOM-free, screen-constant bulb and speaker point clouds.
  Each family is one draw call and uses a pixel-sized raycast threshold, so a distant icon remains clickable.
- **`app/viewport/scene/reference-decor.ts`** — `setReferenceLights(rig)` creates one bulb per non-ambient light;
  `setProps` creates one speaker per non-silent `Sounds.ExternalSounds` record at `instance loc + emitter
  offset`. Selecting a bulb builds just that light's native-colour gizmo and publishes its full recovered
  record—name, level, type/category, additive/subtractive role, colour, HDR brightness, position/direction,
  cone, and reach—to both Props and Scene → Lighting → Reference. Selecting a speaker builds just its cyan
  listener boundary and selects the owning prop for context. Both ride `refRoot` with the terrain.
- **`app/main.ts`** — a **Sources** on/off pill in the top bar. It loads reference lights on demand, exposes
  already-loaded sound emitters immediately, and also gates the authored sign/group/free-light bulbs. The
  persisted storage key remains `StoredUi.lightRig` for compatibility.

## Lighting the terrain

The **Sources** toggle is inspection-only. **Scene ▸ Lighting ▸ Local lights** folds the rig's own light into
the reference terrain. `core/reference/lights.ts bakeRigLighting(positions, normals, rig)` accumulates a per-vertex additive glow
(RGB) from the local lights: each is a spot cone (or omni point) with a Lambert `N·L`, a smooth inverse-square
falloff concentrated near the source, a saturating intensity weight (so an HDR-hot light doesn't dominate),
hard-culled to a capped range. `main.ts` composites it over the recovered sun **model** view with a screen
blend — `base + (1 − base)·(1 − e^(−strength·E))` — so overlapping lights saturate toward full-bright instead
of blowing out. The term is independent of the sun sliders, so it's baked once per level; a **light rig glow**
strength slider (Scene ▸ Lighting ▸ Reference, shown in the model view) scales it live. Compare it to the
**lightmap** view for the baked ground truth.

**The option does not touch the study's view.** It used to force `model` so the glow read at once, which failed
two ways. Local lights persists, so every reference load silently opened on the reconstruction rather than the
ground truth, with no visible cause. And because folding the glow in awaits a lightmap decode and a rig fetch,
a view picked while that was in flight got stomped when it resumed — the picker looked stuck on `model`. The
option is a light-layer toggle; the view is the user's selection; they are independent, and the panel shows a
**rig glow → switch view to "model"** hint instead of moving anyone. Nothing about the study survives a load.

Worth knowing when that hint appears: on `lightmap` nothing is actually missing, because the baked page
already carries this level's own local lights — that is what makes it ground truth. The reconstruction needs
the glow composited in only because it lacks them.

Three deliberate exclusions keep it faithful: the **subtractive shadow lights** are skipped (a bake-time
tuning hack already in the lightmap — adding them just crushes the terrain to black); the **sun / ambient /
`Sunlight` fill spots** are skipped (the study's own sun fit already carries the global key/fill — adding them
double-counts the sun); so what lands on the terrain is the genuinely LOCAL character lighting the smooth fit
can't express.

**Aim matters — it's why the reference snow doesn't light up.** A light only lights what it points at, and the reference
sign lights aim *horizontally* at the vertical billboard **faces** (the props), not down at the snow — so they
correctly add almost nothing to the near-horizontal terrain (the ambient snow-glow you remember is the baked
lightmap's bounce, not these spots). What pools on the reference terrain is the tunnel / point / downward lights
(~5% of it); the night-city levels light up broadly as you'd expect. The billboard
faces themselves lighting up is the **props** side, below.

## Lighting the props

The hero effect — a sign light brightening the billboard it aims at — lands on the props, not the terrain.
Reference props are `InstancedMesh` (one shared geometry per model, thousands of placements), so per-vertex
baking won't do; instead each placement takes a **per-instance tint** via `instanceColor`. `core/reference/lights.ts
propRigGlow(pos, rig)` samples the rig's received glow at a placement's origin — the whole-object companion to
the terrain bake, with **no `N·L`** (a prop has faces every way, so "is it in the light" is what matters), and
a gentler intensity weight so the authored-dim sign lights (intensity ≈ 1) aren't starved next to the hot
lights. `viewport.setPropRigLighting(rig, strength)` turns that into a saturating multiply
`1 + MAX·(1 − e^(−strength·glow))` per channel (bounded to ≤ 3× so overlaps don't blow out) and writes it to
each instance; a prop that catches no light stays white (unchanged). It re-applies on a prop rebuild, on the
rig toggle, and on the strength slider — the same `light rig glow` slider drives both terrain and props. It's
reference-only (the authored map has no rig).

Faithful by construction: on a daytime reference level only the fraction of billboards that actually have a sign light light up
(~1.7×) — the rest are unlit signs in the game too — while props near the brighter area lights glow more; on
the night-city levels nearly every billboard lights up (~2×).

## Authoring sign lights

The study becomes authoring: **dropping a billboard on a course drops a matching sign light with it** — the
`SD_sp_SignLight`-off-a-`Mdl_Billboard` pattern the shipped levels carry, built into your own maps too
(`core/lighting/sign-lights.ts`). The light is **derived, not stored**: it's a pure function of the billboard's
placement + its model's bounding box, so it follows the billboard automatically (move it, the light moves;
delete it, the light's gone), and the editor preview and the export bake call the same `deriveSignLight`, so
what you see is what ships. A billboard is any placed prop whose model name carries `Billboard`.

**The recipe**, grounded on the reference SignLights (every one a Type-1 spot standing ~15 m off its board, ~22–30°
cone, white at intensity 1): the board's thinner horizontal axis is its front-back normal; the light stands
~15 m out along it, mounted a little above the face centre, aimed **down at the lower face**, with a 30° cone.
The shipped lights aim dead horizontal and lean on the baked lightmap's *bounce* for the snow glow under a
sign; an authored course has no bounce to bake, so the authored light rakes down instead — it lights the sign
face *and* pools on the snow in front, the effect the sign lights were remembered for. The lit side is the
board's +thin-axis face; yaw the billboard 180° to light the other side.

Once derived, the sign lights ride the **same** machinery as the reference rig (they wrap into a
`ref-lights.LightRig` via `authoredRig`):

- **The terrain** — `bakeRigLighting` folds each light's glow into the reference/authored terrain and the
  exported lightmap (`light-bake.bakeLightmaps` screen-composites it into the sun-lit colour before the GS
  encode), so a sign's snow pool ships baked into `Lightmaps/`. Authored sign lights are deliberately dim
  (white, I = 1), so the terrain bake lifts them with a gentler intensity weight (`SIGN_TERRAIN_WEIGHT_K`)
  than the reference's HDR set. The glow reads best against a dim / night sun — a bright day sun saturates the
  slope to full-bright and leaves no headroom, exactly as a real sign washes out in daylight.
- **The props** — each lit billboard's tiles are multiplied by a warm tint (`viewport.setPlacedProps`),
  sampled *where the light aims* (on the beam, so a tall sign whose centre sits above the down-raked beam still
  lights), bounded to ≤ 3×. Every other placement samples the rig at its own bbox centre
  (`viewport.placementGlowTint`) — so a free light colours the props near it, and a group's fixture light
  lights its own lamp (015); a prop that catches no light keeps its shared, untinted materials.
- **The sources** — one bulb per sign/group light draws under **Sources** in data coords; clicking it expands
  only that light's rig (`viewport.setAuthoredLights`).
- **`Lights.json`** — `level.buildLightsJson` writes a Type-1 spot per sign light (editor → raw for position
  and propagation direction, the cone cosine in `UnknownFloat2`, a reach-sized influence box) next to the sun
  and ambient, so a from-scratch course self-describes its own sign lighting and the ISO repack carries it.

Verified end-to-end: a billboard placed on a course adds one spot to `Lights.json` and changes the baked
lightmap page its patch lands on; a non-billboard prop adds neither.

## Top-level Sources and Lighting

The top bar separates discovery from rendering. **Sources** shows clickable light/sound origins and one
selected rig/range. Source icons are full-bright when visible and retain a faint 7%-opacity x-ray pass when
terrain or a prop occludes them; their screen-space click target intentionally remains selectable through that occlusion.
Point/directional lights use a bulb while cone lights use a side-on theatre spotlight, rotated in screen space
to point at the same projected cone-centre target as the expanded rig. Each uses its light's recovered/authored hue
inside a thin black contour; selecting a source redraws its icon with the bold contour so the active light or
speaker remains identifiable alongside its expanded rig/range.
**Lighting** is the complete lit result: sun + sky fill (the lightmap bake), cast shadow/AO, and the enabled
local-light contribution. **Local lights** is retained under **Scene ▸ Lighting** for focused study; it controls the LIGHT the
course's own local sources cast — the sign light
a billboard drops, the free lights you place, and a group placement's light members (015) — as a unit: the
glow they pool on the terrain and the tint they cast on the props they light. Turning Lighting off hides both
sun/sky lighting and local light. Turning Local lights off keeps the sun/sky/shadow result for comparison;
turning it on also turns Lighting on so its pools have a lit terrain to composite over.
`viewport.showAuthoredLights` gates the light cast (terrain fold + prop tint, `authoredLightsVisible`);
the icon markers and selected inspection detail ride **Sources** instead
(`viewport.showAuthoredLightRig`, `authoredRigVisible`): discovery vs light output.

## Free lights

An **Add light** button in the idle Prop Tools launcher (stacked with Add rail / Add gem) drops a free,
hand-placed light — the general case of the sign light, not tied to any prop.
Click it, then click the mountain to place a warm point light;
select it to edit its **name**, **type** (point / spot), **colour**, **brightness**, **reach** and (for a spot)
its normalized **direction** and **cone half-angle** in Tools, or drag its gizmo to move it
(`MountainDoc.lights: AuthoredLight[]`, in the same data space as the
props, so undo / save / reload carry it). Free lights render as pickable bulb icons and reuse the placed-prop
selection + move-gizmo path; selecting one expands its wire sphere or cone. The icons live on Sources, so Add
light turns Sources, Lighting, and Local lights on — with Sources hidden a free light still casts, it just
can't be seen or picked.

The authored-mountain and loaded-reference inspectors deliberately share their common labels, order and units: name,
source, type, effect, colour, brightness, position, direction/cone where applicable, and reach. Reference
records remain read-only and append their native category/cosine; the corresponding authored-mountain controls are
editable, with position following the viewport move gizmo.

A free light can also draw the game's runtime **glint** — the halo/core/twinkle-star sparkle a street lamp or
course flare carries. Its size class is one control on the light and one field on the exported record; see
[047 — Light Glints](047-light-glints.md).

A free light resolves to the same `PlacedLight` the sign lights use (`signlights.freeLightToPlaced`), so it
joins the one authored rig: it pools its colour on the terrain (baked into the lightmap) and exports to
`Lights.json` as a **Type-2 point** or **Type-1 spot** next to the sun, ambient and sign lights. So a course
carries its whole authored light set — sun, signs and free lights — self-described and baked, ready for the
ISO repack. Verified: a point + a spot free light add two records to `Lights.json` and bake into the terrain
lightmap; the doc round-trips through save / load with its lights intact.

## Next

- **Per-sign tuning** — a colour / intensity / standoff override on a placed billboard (the derived defaults
  are white and dim, matching the reference).
- **Spot aim gizmo** — the normalized direction is editable numerically; add a rotation handle for direct cone aiming.
- **Authored prop emitters** — expose custom-prop sound records through the same speaker/range path once the
  editor can create and modify their native parameters.
