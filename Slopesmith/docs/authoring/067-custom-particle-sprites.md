# 067 — Original particle sprites

Upload PNGs through `POST /api/texture-upload?project=<id>&name=<stem>`.
For fog, set `particleVolumes[].texture` to the returned `Custom/name.png` reference.
In the fog inspector, click the **Texture** thumbnail to choose from the Texture Library or add an image
with its **+** tile. **Shared** restores the original shared fog sprite; **Cancel** keeps the current
reference, including a missing one. Reference fog is read-only until copied onto your mountain.
Each volume may use its own texture in the browser. Folder export has one native fog0 slot and rejects mixed fog sprites.

New native fog selections store an `asset2` texture reference in `particleVolumes[].texture`.
Preview and export resolve it through the same cache, local and server readers as terrain textures.
Existing maps without a texture reference discover the original sprite through the source course's
`RidingEffects.json` `SpriteBank`, or its legacy `Textures/Particles` / `Textures` layout, then resolve
the resulting asset2 texture. Missing source images remain missing; no generated replacement is used.
Different references can share the native export slot when their PNG bytes are identical.

For SSF emitters, set `effects.extensions.slopesmith.particleTextures` to a map of native sprite names to custom refs, for example `{"part":"Custom/spark.png"}`. `U49:0` selects `part`. This is project-scoped and does not replace reference-map art when both are shown. The custom bytes are also staged under `Textures/Particles` in a folder export. PS2 bank injection must be verified separately; browser preview and folder staging are supported here.

Missing overrides retain the existing native sprite behavior. Alpha PNGs work for soft fog or sparks. A wholly original scene must override every emitter sprite it uses, supply a fog texture, and avoid native audio or prop donors.

Private-map Play loads shared native sprites from the authenticated server library, matching the editor.
Public Play loads them from the local ISO cache. Shared sprite lookup checks the loaded courses for
`Textures/Particles/<name>` and supports older flat `Textures/<name>` copies. An empty ISO cache never
claims a shared sprite request, so it cannot hide the server's fog texture on a private map.
