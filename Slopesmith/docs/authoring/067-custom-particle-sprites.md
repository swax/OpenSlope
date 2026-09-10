# 067 — Original particle sprites

Upload PNGs through `POST /api/texture-upload?project=<id>&name=<stem>`.
For fog, set `particleVolumes[].texture` to the returned `Custom/name.png` reference.
Each volume may use its own texture in the browser. Folder export has one native fog0 slot and rejects mixed fog sprites.

For SSF emitters, set `effects.extensions.slopesmith.particleTextures` to a map of native sprite names to custom refs, for example `{"part":"Custom/spark.png"}`. `U49:0` selects `part`. This is project-scoped and does not replace reference-map art when both are shown. The custom bytes are also staged under `Textures/Particles` in a folder export. PS2 bank injection must be verified separately; browser preview and folder staging are supported here.

Missing overrides retain the existing native sprite behavior. Alpha PNGs work for soft fog or sparks. A wholly original scene must override every emitter sprite it uses, supply a fog texture, and avoid native audio or prop donors.
