/**
 * The authoring guide served at `GET /api/guide` (docs/052) — the one page an agent reads before building a
 * mountain through this API. Everything else is discoverable by following links from `/api`; this is the
 * connective tissue links cannot carry: the register grammar, the id conventions, and the order of work.
 * Kept as a string beside the routes so a change to either is a change to one module's diff.
 */
export const AUTHORING_GUIDE = `# Authoring a mountain through the Slopesmith API

Start at \`GET /api\`. Every response carries \`_links\` (where to go), \`_actions\` (ready-to-invoke
requests with a body stub and a \`schema\` URL), \`_linkTemplates\` / \`_actionTemplates\` (patterns with
\`{variables}\` you substitute). Follow those rather than memorising URLs; what you may do is decided by the
server and reflected there, with disabled actions carrying the reason.

## Authentication

On a server with accounts, send a personal access key on every request:

    Authorization: Bearer slop_...

A signed-in member mints one at \`POST /api/auth/keys {"name": "my agent"}\` (the secret is shown once).
A key authors with its account's role but can never administer. On a local server without accounts, skip
this — every request is served as the owner.

## The shape of a map

A map (project) holds one mountain document: a bicubic-Bézier terrain net (vertices + quads), one course
line the race follows, and everything placed on it — props, rails, gems, lights, models, screens, effects —
plus globals such as the sun and the skybox. \`GET /api/projects/{id}\` returns the whole document;
\`vertexIds\` / \`quadIds\` in it are the stable names registers use.

## Creating a map

\`POST /api/projects {}\` creates the default starter mountain — a complete, rideable 400 m-wide run — and
answers with the project and its full document. Pass \`{"name": "NOEL RIDGE"}\` to name it at birth (the
same free-name rule as a rename: sanitised to NOELRIDGE, suffixed \`_2\` when taken — the response says what
landed). Start there and edit; composing a whole document from nothing is rarely worth it. The response's
\`_links\` and \`_actions\` are your map of everything below. If you do compose one — the only reason is
topology, which registers cannot change — read it first with \`POST /api/projects/validate {"document": …}\`,
which answers \`{ok, counts, problems}\` and creates nothing.

## Editing: registers

The ordinary write is \`POST /api/projects/{id}/registers\` with absolute, last-writer-wins assignments
that cannot conflict — no base revision, no merge:

    { "changes": [
      { "key": "g/name", "value": "POWDER GULCH" },
      { "key": "v/local:42", "value": [812.5, 396.0, 1240.0] },
      { "key": "q/local:900/paint", "value": 5 },
      { "key": "o/gem/gem:0000", "value": { "id": "gem:0000", "pos": [800, 402, 1200] } },
      { "key": "o/light/light:0000", "remove": true }
    ] }

Key grammar (schema \`RegisterKey\` has the full statement):

| Key | Holds |
|---|---|
| \`v/<vertexId>\` | one vertex position \`[x, y, z]\` — metres, Y up |
| \`h/<fromId>><toId>\` | one directed edge's crease/tangent override (V3) |
| \`q/<quadId>/paint\` | one face's SurfaceType int (1 snow, 3 powder, 5 ice, 0 reset…) |
| \`q/<quadId>/tex\` | one face's tile ref \`"<LEVEL>/<file>.png"\` or \`"Custom/<file>.png"\` |
| \`q/<quadId>/orient\` · \`/lock\` · \`/twist\` · \`/labels\` | that face's other channels |
| \`o/<family>/<id>\` | one whole object — families: prop, light, rail, gem, model, volume, screen, label |
| \`o/effect/<table>/<rowId>\` | one effects-document row; \`o/effect/document\` its own fields |
| \`o/effect-node/<table>/<rowId>/<nodeId>\` | one node inside a graph/function row |
| \`course\` | the whole run: knots, blend, surface |
| \`g/<field>\` | one document global: name, sun, glare, skybox, baseSurface, raceMusic, laps, … |

Rules that keep edits honest:

- **Objects are assigned whole.** Read the object (from the document or \`GET …/registers?prefix=o/\`),
  change fields, assign it back. There is no per-field patch below the register.
- **Inserting** an object means assigning to an id nobody holds. Follow the family's form —
  \`prop:a001\`, \`light:0004\`, \`gem:0012\` — any unused string works, except \`model:NNNN\`, whose
  number is how placements reference it. The object's own \`id\` field must match the key (the server
  fills it in when absent, refuses a mismatch).
- **Deleting** is \`{"key": …, "remove": true}\` (or omitting \`value\`).
- The response counts \`landed\`, \`retired\` (named geometry that has since been deleted — quietly
  dropped), and \`refused\` (named nothing this map ever had), listing the refused keys.
- **Topology is not a register.** Which vertices and quads exist can only change through
  \`PUT …/document\` (optimistic: send \`baseRevision\`, expect 409 with the current state if you raced
  someone). It answers with the map's own \`_links\` and \`_actions\`, so carry on from the write.
  Everything else belongs in registers.
- Renaming the map (\`g/name\`) needs the map's owner or a moderator, like every rename.

\`GET …/registers\` returns objects + course + globals by default; add \`?prefix=v/\` (comma-separated
prefixes, or \`all\`) for terrain channels, \`?keys=…\` for exact reads.

## Whole sections in one call

Two intents accounted for nearly every register the first real build wrote, and both had been expanded
client-side into thousands of keys: *texture every quad in this section*, and *drop these props onto the
surface*. Each is one call.

**Painting a section** — an optional \`rules\` beside \`changes\` on the same register write:

    { "rules": [
      { "where": {"labels": ["kiln-gate", "trail"]}, "set": {"paint": 5, "tex": "Custom/blue-ice.png"} },
      { "where": {"label": "terrace-lip"},           "set": {"tex": "Custom/hazard-chevron.png"} }
    ] }

A quad matches when it carries **all** the labels named — the intersection is what makes "the trail quads
inside this one section" sayable — and a label is named by its name or its id. \`set\` names quad channels
only: \`paint\`, \`tex\`, \`orient\`, \`lock\`, \`twist\` (\`null\` clears one), plus \`addLabel\` /
\`removeLabel\`. Nothing else — a prop is a whole-object register and there is no per-field patch below a
register, so no rule can reach into one.

A rule is EXPANDED server-side into the same \`q/<quadId>/<field>\` assignments you would have sent yourself
and lands through the same last-writer-wins path, so nothing about the model changes because a batch arrived
as an intent. Rules apply in order and \`changes\` after all of them, so an explicit key always wins over a
rule that touched it. The response gains \`rules: [{matched, keys}]\`, one per rule. A \`where\` naming a
label this map has not got is refused **by name** rather than quietly matching nothing.

**Seating placements** — \`POST /api/projects/{id}/seat\`:

    { "where": {"labels": ["works-shelf"]}, "ids": ["rail:shelf-a"], "offset": 1.2 }

It selects props carrying every label named, plus anything in \`ids\` (\`prop:…\`, \`light:…\`, \`gem:…\`,
\`rail:…\`, or a whole \`o/prop/…\` register key) — the union of the two — samples the top surface under each
with the same sampler \`…/ground\` answers from, and sets its Y to \`height + offset\`. A rail is seated
**node by node**, so it follows the ground along its whole length instead of pivoting about its first point.
A point with no surface under it is left exactly where it is and counted in \`skipped\`, never dropped to
zero. The answer is \`{revision, seated, skipped, unchanged}\`.

Seating is a geometric operation, not a field patch: each placement's whole register is read, moved and
assigned back. Run it again after sculpting — moving vertices moves the ground out from under everything
standing on it.

## Placing things in the run's own terms

A placement's position may arrive in any of three forms and lands as \`[x, y, z]\`:

    [812.5, 396.0, 1240.0]                          as stored: three numbers
    [812.5, null, 1240.0]                           Y on the terrain under (x, z); "+1.5" a height above it
    { "station": 320, "lateral": -6, "above": 0.5 }  320 m along the run from knot 0, 6 m to the rider's LEFT
                                                    (positive = right, looking downhill), half a metre up
    { "knot": 8, "along": 12, "lateral": 5 }         12 m past knot 8, 5 m right, on the ground

\`GET …/course\` is the ruler: the run's length, each knot's station, and a table every 25 m (\`?every=10\`,
or \`?at=120,340\`) of position, heading, floor width and ground height — read it once, then place by it.
A prop's \`yaw\` may be \`"course"\` (facing downhill along the run at its station), \`"course+90"\` (facing
the rider's left — a facade on the right-hand side of the street faces the street with this),
\`"course-90"\`, \`"course+180"\`. Rails resolve node by node. Course knots take the \`[x, null, z]\` form
only, since the knots are what define the stations. Nothing placed this way needs seating afterwards.

## Rows, variants and shapes: one change, many registers

    { "changes": [
      { "key": "o/prop/prop:lamp-{i}",
        "value": { "level": "MERQUER", "model": 143, "name": "lamp {i}", "scale": 1,
                   "pos": { "station": 300, "lateral": 6 }, "yaw": "course+90" },
        "repeat": { "every": 18, "until": 420 } },
      { "key": "o/prop/prop:lamp-left-{i}", "from": "o/prop/prop:lamp-0",
        "value": { "pos": { "station": 309, "lateral": -6 }, "yaw": "course-90" },
        "repeat": { "count": 7, "step": { "station": 18 } } },
      { "key": "o/model/model:0012",
        "value": { "name": "shed", "texture": "Custom/plank.png", "solid": true,
                   "shape": { "kind": "box", "size": [4, 2.6, 3], "segments": [2, 1, 2] } } }
    ] }

- **\`repeat\`** clones a change \`count\` times, or from its own station \`every\` so many metres \`until\` a
  station; \`{i}\` in the key (and in \`name\`) takes the index, from \`start\` (default 0). \`step\` is the
  per-clone increment — \`station\` / \`lateral\` / \`above\` for a run-relative position, \`x\` / \`y\` / \`z\`
  for an \`[x, y, z]\` one, \`yaw\` for either. The same change with \`"remove": true\` deletes the row again.
- **\`from\`** copies another register's value and merges \`value\` over it (the copy's \`id\` gives way to the
  new key). It is for a NEW key: a copy onto its own key would be the per-field patch a register does not
  offer — read, change, assign whole. It reads the map as it stands when the request arrives, so a register
  created earlier in the same batch is not yet there to copy: make the original in one call, its variants
  in the next.
- **\`shape\`** on an \`o/model\` generates the geometry: \`box\` \`{size:[w,h,d], segments:[nx,ny,nz], top,
  bottom}\`; \`house\` — four walls and two gable triangles, \`{size:[w,wall,d], ridge, segments:[long,end]}\`;
  \`roof\` — two planes over a \`size:[w,d]\` footprint, \`{eave, ridge, overhang}\`, placed on the same pos and
  yaw as its house; \`panel\` — \`{size:[w,h], segments:[nx,ny], double}\`, a sign, a window card, a light
  strip. Base at y = 0, footprint centred, the ridge along the model's X; a quad wears the whole tile, so
  \`segments\` is tile repeats. The document keeps the vertices, never the recipe.

Every one of these is expanded server-side into the plain assignments you could have listed, and lands
through the same last-writer-wins path. The answer counts what expanded:
\`intents: {placed, repeated, copied, shaped, unseated}\` — \`unseated\` being run-relative positions with no
terrain under them, left at the run's own height (a bridge deck, a gap).

## From curl

Everything above is JSON over HTTP, so a build is a handful of files and a shell history — no client code:

    curl -s -H "Authorization: Bearer slop_…" http://host:5180/api
    curl -s -H "Authorization: Bearer slop_…" "http://host:5180/api/projects/ID/course?every=20"
    curl -s -H "Authorization: Bearer slop_…" --json @village.json http://host:5180/api/projects/ID/registers
    curl -s -H "Authorization: Bearer slop_…" --data-binary @plank.png "http://host:5180/api/texture-upload?project=ID&name=plank"
    curl -s -H "Authorization: Bearer slop_…" --json "{\\"note\\":\\"village lit\\"}" http://host:5180/api/projects/ID/checkpoints

\`--json\` (curl 7.82+) sends a body as \`application/json\`; an older curl uses \`-H "Content-Type:
application/json" -d @file\`. Keep each batch in a file: \`@file\` sidesteps every shell's quoting, and the
file is the record of what was built — a rework is a read, an edit of the file, and the same POST again.
On Windows PowerShell \`curl\` is an alias for Invoke-WebRequest; call \`curl.exe\`. A local server without
accounts needs no header at all. Reads scope with \`?prefix=o/prop/\` or \`?keys=course,g/sun\`.

## A sensible order of work

1. Create the map, named (\`POST /api/projects {"name": …}\`); \`g/name\` renames later.
2. Terrain: move vertices (\`v/…\`) to carve berms, kickers, a halfpipe; paint surfaces (\`q/…/paint\`);
   texture faces (\`q/…/tex\`) with reference tiles or your uploads — by \`rules\` once the faces are
   labelled, which is one call per section instead of one key per face.
3. The run (\`course\`): reposition knots along your terrain; knot 0 is the start gate, the profile fields
   (width/wall/bank/shoulder) describe the channel; \`checkpointBonus\` on a knot makes it a showoff
   checkpoint station.
4. Place things (\`o/prop\`, \`o/rail\`, \`o/gem\`, \`o/light\`, \`o/screen\`). Prop geometry comes from a
   reference level (\`level\` + ModelID), your imports (\`"@import"\`), or your authored models
   (\`"@models"\`). An invisible effect trigger is a prop too: \`level "@effects"\`, \`model 0\`, with
   \`effectTrigger: {"size": [w,h,d]}\`. Say where in the run's own terms (\`pos: {station, lateral, above}\`,
   \`yaw: "course+90"\`, a \`repeat\` for a row) and nothing needs seating; or place at any Y and put the whole
   section on the ground with \`POST …/seat\` afterwards. \`POST …/ground {"points": [[x,z], …]}\` asks the
   same sampler the same question when you want the heights themselves rather than the move.
5. Effects: author rows through \`o/effect/...\` registers — a graph (\`o/effect/graphs/graph:0000\`),
   its nodes (\`o/effect-node/graphs/graph:0000/graph:0000/node:0000\` — a node's id carries its owner's
   prefix), and a slot whose circumstance names the graph. The slot reaches a placement through the
   attachment list in \`o/effect/document\`'s \`extensions.slopesmith.attachments\`:
   \`{"id":"attachment:0000","target":{"kind":"prop","id":"<prop id>"},"slot":"slot:0000",\`
   \`"circumstance":"collision","enabled":true}\`. Copy working node payloads from a reference level's
   \`/api/effects\` document rather than inventing them.
6. Set the mood: \`g/sun\`, \`g/skybox\`, \`g/glare\`, \`g/laps\`, \`g/showoffSeconds\`, \`g/raceMusic\`.
7. Checkpoint with a note (\`POST …/checkpoints\`) at moments worth returning to.

Name your sections as you build them. A label (\`o/label/label:0000\`) is a semantic group; membership lives
on the labelled thing (a prop's \`labels\`, a face's \`q/<quadId>/labels\`). \`GET …/labels\` then answers
what each one holds, and \`GET …/labels/{labelId}\` hands back its \`quadIds\` and \`propIds\` — the ids
registers name — so "retexture the village" is one read and one batch. Working as a crew, label your own
range: it is how you find your work again among everybody else's.

## Authoring with nothing but curl

No client library is needed for any of it. Here is a whole map in the shell. Set up once:

    KEY=slop_...                              # POST /api/auth/keys; omit it on a server without accounts
    API=http://localhost:5180/api
    auth=(-H "Authorization: Bearer $KEY" -H "content-type: application/json")

(\`jq\` is only reading the answers. Every URL below either came out of an envelope or was named on this page.)

**1. Compose the surface — the one part that is not a call.** Registers cannot change topology, so a few
thousand vertices and quads have to arrive as a document. Generate that file with a throwaway script in
whatever language is already to hand — it is arithmetic and an array of four-corner quads — and have the
server read it before you spend a map name finding out:

    node build-terrain.js > doc.json          # or python, or awk. This part really is a script.
    curl -s "\${auth[@]}" -d @doc.json $API/projects/validate | jq '{ok, counts, problems}'
    # {"ok":true,"counts":{"vertices":1105,"quads":1044,…},"problems":[]}

That is the honest shape of the claim: composing topology is a file you write; everything past this line is
single calls. Carry your sections in the same document while you are in there — the \`labels\` list and each
face's \`quadLabels\` row cost nothing to author alongside the mesh, and they are what every call below
selects with.

**2. Create the map.**

    printf '{"name":"COPPERHORN","document":%s}' "$(cat doc.json)" > create.json
    ID=$(curl -s "\${auth[@]}" -d @create.json $API/projects | jq -r .project.id)

(\`-d '{"name":"COPPERHORN"}'\` on its own starts from the default rideable mountain instead.)

**3. Upload the art you drew.** Raw bytes as the body, parameters in the query string:

    NAME=$(curl -s -H "Authorization: Bearer $KEY" -H 'content-type: image/png' \\
      --data-binary @blue-ice.png "$API/texture-upload?project=$ID&name=blue-ice" | jq -r .name)
    # paint it as "Custom/$NAME.png" — a taken stem lands as blue-ice_2, so use the answer, not what you asked

**4. Paint and texture whole sections.** One call per intent rather than per face:

    curl -s "\${auth[@]}" -d '{"rules":[
      {"where":{"labels":["kiln-gate","trail"]},"set":{"paint":5,"tex":"Custom/blue-ice.png"}},
      {"where":{"label":"terrace-lip"},"set":{"tex":"Custom/hazard-chevron.png"}}
    ]}' $API/projects/$ID/registers
    # {"landed":407,…,"rules":[{"matched":40,"keys":80},{"matched":176,"keys":352}]}

**5. Place props.** Choose them by name from the slim index, then assign them as registers. Y does not
matter yet:

    curl -s "\${auth[@]}" "$API/props/index?level=GARI" | jq '.models[] | select(.name|test("Fence"))'
    curl -s "\${auth[@]}" -d '{"changes":[
      {"key":"o/prop/prop:fence-118","value":{"level":"GARI","model":214,"name":"Mdl_Fence",
        "pos":[-35.2,0,17.1],"yaw":18,"scale":1,"labels":["label:0003"]}}
    ]}' $API/projects/$ID/registers

**6. Put the section on the ground.**

    curl -s "\${auth[@]}" -d '{"where":{"labels":["works-shelf"]},"ids":["rail:shelf-a"],"offset":1.2}' \\
      $API/projects/$ID/seat
    # {"revision":4,"seated":98,"skipped":0,"unchanged":0}

**7. Set the mood.**

    curl -s "\${auth[@]}" -d '{"changes":[
      {"key":"g/sun","value":{"on":true,"el":22,"az":140,"ambient":0.42,"sun":0.85,"shadow":0.6,"ao":0.5,
        "sunTint":"#ffd9a8","skyTint":"#9fc4ff"}},
      {"key":"g/skybox","value":{"source":{"kind":"level","level":"GARI"},"on":true}},
      {"key":"g/laps","value":3}
    ]}' $API/projects/$ID/registers

**8. Price the export, then keep the moment.**

    curl -s "\${auth[@]}" $API/projects/$ID | jq '{doc: .document}' > preflight.json
    curl -s "\${auth[@]}" -d @preflight.json "$API/preflight?project=$ID" \\
      | jq '{cells: .cells.total, tiles: (.tiles|length), missing: .props.missing}'
    curl -s "\${auth[@]}" -d '{"note":"first rideable pass"}' $API/projects/$ID/checkpoints

An empty \`missing\` means every prop page resolved and the mountain is exportable. From here the loop is
sculpt, \`seat\` again, repaint by rule, checkpoint — and none of it needs anything the two write calls above
do not already do.

## Reference levels

\`GET /api/reference\` is the directory and \`GET /api/reference/{level}\` is one level's own page: what the
folder is, what it holds, and a resolved link to every part of it. Extracted retail levels lend everything:
their props, tiles (\`/api/textures?level=…\`, painted as \`"<LEVEL>/<file>"\`), whole skies (\`g/skybox\` =
\`{"source":{"kind":"level","level":"GARI"}, "on":true}\`), light rigs, sounds, music graphs, and complete
effects documents (\`/api/effects?level=…\`) — the best reference before authoring your own effects rows.

Choose props from \`GET /api/props/index?level=…\`, which answers \`{id, name, tris, pages}\` per model —
tens of kilobytes. \`/api/props?level=…\` is the same models WITH their geometry and runs to megabytes;
fetch it only if you need the vertices, which placing a prop does not.

## Uploads (a map's own asset library)

Uploads are raw bytes in the request body with parameters in the query string — no multipart. Every upload
is project-scoped: name the map with \`?project=<id>\` (an agent has no browser tab to inherit one from).
The server picks the final name — a taken or retired name becomes \`name_2\` and up — and the response's
\`name\`/\`id\` is authoritative; use it, not what you asked for.

- \`POST /api/texture-upload?project=…&name=<stem>\` — PNG/image bytes, re-encoded, shrunk to ≤512 px.
  Paint it as \`"Custom/<name>.png"\`. Send **truecolour** PNG (RGB or RGBA): the decoder checks bit depth
  but not colour type, so an indexed/palette PNG is read as garbage rather than refused. An alpha channel
  survives at ≤512 px, and a hard mask becomes a cutout — how the reference levels draw foliage, chain-link
  and crowd cards. Terrain clips a hole but never blends, so partial alpha is for props only.
- \`POST /api/sound-upload?project=…&name=<stem>\` — WAV, normalised to PCM16 mono, ≤10 s.
- \`POST /api/custom-music?project=…&name=<file>.<ext>\` — full-length race music, stored verbatim.
  Select with \`g/raceMusic\`.
- \`POST /api/skyupload?project=…&name=<stem>&fit=auto\` — a horizon panorama PNG. Select with
  \`g/skybox\` = \`{"source":{"kind":"custom","name":"<stem>"}, "on":true}\` — the **stem alone**, no
  extension, unlike a tile. A sky resolves through the data-name sanitiser, which deletes the dot, so
  \`"<stem>.png"\` addresses a file named \`<stem>png.png\` that nobody wrote.
- \`POST /api/custom-prop-import?project=…&name=<stem>\` — a decoded model as JSON (schema
  \`ImportedPropRecord\`); the caller parses its own GLB. For simple shapes, authoring an \`o/model\`
  register is far easier than composing a record.
- \`POST /api/character-import?name=<file>.fbx\` — a Mixamo-rigged FBX becomes a server-wide rider avatar
  (see \`/api/avatars\`). Avatars are chosen per player; maps never name one.

## History and safety

Every save keeps an autosave ring; \`GET …/checkpoints\` lists it. Take named checkpoints before risky
passes; \`…/checkpoints/{file}/changes\` says in words what has changed since; restore or scoped-revert if
a pass goes wrong. Register edits from you appear live to anyone editing the same map in the browser, and
theirs in your next read — last writer wins per register, so partition work rather than fighting over one
object.

## Browser views and screenshots

Follow the root's \`browser-workflows\` link to \`GET /api/browser\`. Each project advertises a browser
view and templates for an exact camera screenshot or framing a label. These links return HTML: open them
in a WebGL browser, wait for \`#capture-status[data-state="ready"]\` in that tab, verify its project,
revision and request attributes, then click **Save screenshot** to download a PNG. HTTP fetch cannot render
a view. The schema at \`/api/schemas/BrowserView\` describes each fragment parameter and preset.

Map identity uses \`?project=<id>\`; the fragment describes the camera in authored metres (Y up), display
options and optional PNG dimensions. For example, \`#view=1&label=label%3A0000&preset=topology&size=1600,900\`
frames that label's curved terrain and props. A revision in an API link checks the live revision; it never
loads history. Request a fresh link after editing. In Scene → Camera, **Copy view link** records the current
camera and display settings. \`ui=0\` hides the editor; Escape restores it. View links do not edit terrain.

The browser workflow resource also documents development-build scene inspection, Test mode's ride controls,
and browser export. Readiness waits for scene assets and completed frames; it does not freeze animation.

## Exporting

\`GET /api/projects/{id}/download?assets=bytes\` returns the whole map as one self-contained JSON bundle
(document + custom assets, base64), the same shape \`POST /api/projects/transfer\` accepts on another
server. Snowknife/Unity/ISO export composes in the browser editor, not over this API; \`POST
/api/preflight?project=<id>\` with \`{"doc": <document>}\` reports what an export of it would ship, and names
the prop pages it could not resolve. Scope it with \`?project=\` like an upload — the map's own tile and
model libraries are resolved inside it.
Original particles: upload PNGs through texture-upload. Set particleVolumes[].texture to
Custom/name.png for fog. For emitter sprite U49=0, set effects.extensions.slopesmith.particleTextures
to {"part":"Custom/spark.png"}. Browser preview scopes these to the current project and keeps reference
sprites separate. Folder export stages the images under Textures/Particles; its single fog0 slot
requires the same sprite for every fog volume. PS2 particle-bank injection needs separate verification.

`;
