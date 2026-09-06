# Blender

Two ways Slopesmith reaches Blender. They serve different layers and neither replaces the other.

## `slopesmith_bridge.py` — the prop round trip

The escape hatch: take a model out to Blender, do the thing that was hard to do with the mesh tools, push it
straight back onto the same model. Placements, effect attachments, the model's number and its name all
survive, because the push lands on the model rather than beside it. Full design: [docs/046](../docs/046-blender-bridge.md).

**Install.** Edit → Preferences → Add-ons → Install… → pick this file → tick it on. Then set **Slopesmith
service** in its preferences:

| how you run Slopesmith | the service is on |
|---|---|
| `npm run dev` | `http://127.0.0.1:5180` (Vite serves the editor from 5179 and proxies `/api` here) |
| `npm start` | `http://127.0.0.1:5180` |

`SLOPESMITH_URL` overrides the preference, which is also what makes the file usable straight from Blender's
Text Editor (Run Script) with no add-on install at all.

**A hosted server also needs an access key.** Your own machine's Slopesmith does not — it already serves you
as its owner — but one with accounts has to know which member you are. In the editor, **File ▸ Settings ▸
Access keys ▸ Create**, copy the key (it is shown once), and paste it into the add-on's **Access key**
preference. `SLOPESMITH_KEY` overrides that too. The key is not Blender-specific: it is a bearer credential
for the whole API, so a script or a CI job carries the same one.

A key authors as you and follows your role as it changes, but it can never do what only an admin can — it
lives as plain text in `userpref.blend`, so its reach stops short of administering the server. Revoke it from
the same list when a machine stops being yours; that takes effect on the next request.

**Use.** A **Slopesmith** tab appears in the 3D view's sidebar (`N`):

- **the mountain dropdown** — every map on the server, not only the one a browser tab has open. Picking one
  reloads its models straight away.
- **Refresh** — reload the mountain list and the selected map's models: its authored models and its imported
  props.
- **Pull** — bring the selected one in. A tiled prop arrives as **real quads**; a textured prop arrives as
  triangles with its UVs and its material slots. Either way every slot wears its actual tile, so **Texture
  Paint works on it** — a tiled prop is given a copy of its derived mapping (`OpenSlope derived (not pushed)`) for
  exactly that reason.
- **Push** — send the active object back. Its object transform is baked in, so moving it here moves it on the
  mountain, and it returns to the map it was pulled from whatever the dropdown currently shows.
- **Push edited tiles** — on by default. A tile you painted on rides home with the mesh; a tile you did not
  touch is never re-uploaded, so an ordinary geometry push cannot disturb art other props share. The panel
  lists the object's tiles and marks the edited ones.

A pushed tile lands the way Slopesmith would land it: one of **your** Custom tiles is replaced and everything
wearing it follows, while an **extracted level's** tile is forked into your Custom bank under the prop's name,
leaving the reference untouched. It is conformed on the way in, like any upload — plain RGBA, 512² at most.

Nothing else is configured. Before a mountain is picked, the add-on asks for none and the service answers
about whichever one the editor has open.

One thing to know about pushing to a map **no browser tab has open**: a textured prop's mesh and every pushed
tile land immediately, but a tiled prop's cage — and the document's half of a tile move, which is what painted
terrain and other props wearing that tile follow — wait in that mountain's inbox until an editor opens it. The
editor applies them, so they stay one Ctrl+Z away. See [docs/046](../docs/046-blender-bridge.md).

**Requirements.** Blender 3.6+ and the standard library. No `pip install`.

**After changing anything under `src/server/`, restart `npm run dev`.** `scripts/dev.ts` starts the API
service once and holds it in its own scope, precisely so a Vite restart cannot throw away the response cache
and the maps watch — which means only the *browser* half hot-reloads. An add-on talking to a service older
than itself is the one failure mode that looks like a bug in the add-on; it reports the mismatch by name
rather than showing you an empty mountain list.

**Checking it.** `python check_bridge.py` runs the add-on's conversion logic against a stubbed `bpy`, so the
things most likely to be silently wrong — the Y-up ↔ Z-up rotation, the mesh → payload serialisation, and the
rule deciding which tiles are "edited" — are asserted without launching Blender. Each fails *plausibly*
otherwise: a mirrored conversion still produces a model, one that lights inside out, and an over-eager
edited-check replaces every one of your textures with a recompressed copy of itself. It is not in `npm test`,
because the gate is `test/*.test.ts`
and does not depend on a Python interpreter ([docs/024](../docs/024-source-layout.md)); run it when the
add-on changes.

## `ssx_cage_bridge.py` — the terrain cage prototype

A different problem: round-tripping an exported level's *terrain* through Blender as an editable quad control
cage, re-running the Bessel-tangent derivation on the way out so the edited cage becomes valid
`Patches.json` `Points`. It operates on an exported folder on disk rather than on a live document, and it is
a measured prototype rather than a shipped workflow — the measurements, and the argument for why terrain
needs a cage bridge while props do not, are in [docs/009](../docs/009-blender-evaluation.md).

Run it from Blender's Python console:

```python
exec(open(r"...\Slopesmith\blender\ssx_cage_bridge.py").read())
obj = import_level(r"...\Maps\MOUNTAIN01\Patches.json")
export_level(obj, r"...\out\Patches.json")
print(round_trip_test(r"...\Maps\MOUNTAIN01\Patches.json"))
```
