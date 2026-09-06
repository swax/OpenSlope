# 052 — The HATEOAS API

Making the whole authoring surface consumable by a program that knows nothing but the server's address —
so a Slopesmith server can be deployed anywhere, an AI agent pointed at it with an access key, and the
agent can discover, one response at a time, everything it needs to author a mountain.

The design is naisys's HATEOAS envelope (its `docs/012-hateoas.md`), adapted to this server's own
architecture: no framework, no schema library, roles enforced at the mount table, and a document that
already decomposes into last-writer-wins registers ([docs/039](039-concurrent-editing.md)) — which turns out to be exactly the editing
model an agent wants.

## Why discovery instead of a tool catalog

An MCP-style catalog front-loads every endpoint description into the agent's context on every session,
and each description has to anticipate every caller state. A REST surface with hypermedia inverts that:

- **The entry point is tiny.** `GET /api` answers with who the caller is and eight-odd links.
- **Navigation is context-sensitive.** An agent authoring a map follows `maps` → one project → its
  actions; it never loads the members branch, the reference tour, or the admin surface.
- **Capability is stated, not guessed.** Each response's `_actions` are gated against the caller's
  identity the same way the routes will actually answer: an action the caller cannot invoke is emitted
  `disabled` with the refusal's own reason, which doubles as the recourse ("Only this map's owner or a
  moderator can do that.").
- **Bodies explain themselves.** Every action carries an inline `body` stub; `schema` points at full
  JSON Schema under `/api/schemas/` for the rare body a stub cannot explain.

## The envelope

Four optional members, spread into the ordinary response — never wrapping it, so every existing client
keeps reading the shape it always read (`src/server/api/hateoas.ts`):

| Member             | Purpose                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `_links`           | Navigation: `self`, `collection`, `root`, related resources      |
| `_actions`         | Ready-to-invoke requests: `rel`, `href`, `method`, `body` stub, `schema`, `disabled?` + `disabledReason?` |
| `_linkTemplates`   | URL patterns with `{variables}` for the items of a list          |
| `_actionTemplates` | Action patterns — uploads with `{stem}`, duplicate with `{name}` |

Uploads are raw bytes with query-string parameters (this server has no multipart anywhere), so upload
actions carry `alternateEncoding: { contentType, description }` instead of a `body` stub.

Identity-dependent gating appears only on responses that are never shared through the response cache
(the project surface, the root). A cached producer must not read the identity at all; the library routes
are therefore *described* by the discovery pages rather than enveloped in place.

## The map of the surface

```
GET /api                      the root: identity summary + directory (public — it is how a caller
                              learns HOW to authenticate; anonymous sees only the login action)
GET /api/explorer             the interactive reference (below) — a browser page over this surface
GET /api/guide                the authoring manual for agents (markdown; read this first)
GET /api/reference            the extracted-levels branch, by link template
GET /api/reference/{level}    one level: what it is, what it holds, every part of it borrowable
GET /api/props/index?level=   that level's models by name, cost and tiles — no geometry (50 KB, not 3.7 MB)
GET /api/avatars              the server-wide rider library + the FBX import action
GET /api/schemas[/Name]       hand-written JSON Schema registry (src/server/api/schemas.ts)
GET /api/projects             maps: slim rows + the create and validate actions
POST /api/projects/validate   read a hand-authored document the way a create would; nothing is written
GET /api/projects/{id}        one map: manifest + whole document + every link/action it offers
GET /api/projects/{id}/registers[?prefix=|keys=]   the authoring state as registers
POST /api/projects/{id}/registers                  the ordinary write: `changes`, and `rules` that name
                                                   faces by label instead of by key (below)
POST /api/projects/{id}/ground                     the top-surface height under a batch of [x, z] points
POST /api/projects/{id}/seat                       put a selection of placements on that surface (below)
GET /api/projects/{id}/labels[/{labelId}]          which quads and props each section holds
```

Everything else an agent reaches — checkpoints, download, document PUT, texture/sound/music/sky uploads,
prop import, preflight, duplicate/permissions/delete — hangs off the project resource as actions, with
`?project=` baked into the asset hrefs because an agent has no browser tab for `withRequestProjectAssets`
to bind to.

Four of those reads exist because the browser never needed them, and an agent cannot work without them.
A level was only ever *described* by the reference branch's templates, so `/api/reference/{level}` answers
the description as a page — the folder's origin, what it holds, and every template already substituted —
built from a directory listing rather than from the payloads it points at, and shared through the response
cache like the library reads it sits in front of (so it reads no identity). The prop index is the one that
changes what an agent can afford: choosing a model by name cost 3.7 MB of packed geometry on GARI, and
costs 50 KB now. The label index inverts membership — it lives on the labelled thing, so "which quads carry
X" was a whole-document read and a join, and is now `GET …/labels/{labelId}` answering in the ids registers
name. And `POST /api/projects/validate` runs the create's own migrator over a hand-authored document
without keeping the result, because composing one is the only thing registers cannot do and there was no
way to check it but to spend a map name finding out.

The discovery module's `/api` mount registers **last** in `app.ts`, so it claims only what no real route
did: the root itself, and every unknown `/api/*` path — which answers 404 *plus a link back to the root*,
the recourse an agent that guessed a URL needs. `ROUTE_ACCESS` opens exactly five new mounts: `/api`
public (it names no data), the four discovery/contract pages at `viewer`. It also gained one entry it
should always have had: `/api/sound-banks` declared no access, so the closed-by-default rule made the
`level-sounds` link the reference branch advertises a 403 for everyone but an administrator.

## Editing through registers

The register model of [039](039-concurrent-editing.md) was built for concurrent humans; it serves agents unchanged, through
`POST /api/projects/{id}/registers`:

```json
{ "changes": [
  { "key": "g/name", "value": "AGENT GULCH" },
  { "key": "v/local:42", "value": [812.5, 396.0, 1240.0] },
  { "key": "o/gem/gem:0000", "value": { "pos": [800, 402, 1200] } },
  { "key": "o/light/light:0003", "remove": true }
] }
```

Why this is the right agent write, in order of importance:

- **It cannot conflict.** Assignments are absolute and last-writer-wins, so there is no baseRevision to
  track and no 409 loop to program around. A concurrent human in the browser sees the agent's changes
  stream in live — the handler goes through the same room `assign` every socket edit lands through, then
  `takeSnapshot` before answering (a room joined over HTTP has no departing participant to flush it;
  compare the scoped-revert route, which set this pattern).
- **Outcomes are named.** The response counts `landed` / `retired` / `refused` and lists `refusedKeys`,
  so a key naming deleted geometry is distinguishable from one that was never real.
- **Object identity is enforced at the door.** A whole-object register's value must carry the id its key
  names — an absent id is filled in from the key, a mismatched one is refused before anything lands,
  because `byIdentity` would otherwise insert an object that answers to *neither* register.
- **Renames stay renames.** `g/name` is held to the owner/moderator bar exactly as the document PUT and
  the checkpoint revert hold it.
- **Topology stays out.** Which vertices and quads exist changes only through the optimistic
  `PUT …/document`, as [039](039-concurrent-editing.md) requires — which therefore answers with the project's own envelope, the
  way create does. It is the one write registers cannot make, so it was also the one that dead-ended the
  walk: an agent that had just replaced a mountain's topology held no link to the actions it wanted next.
  The 409 stays bare, because what the loser of that race needs is the snapshot to rebase onto, and links
  would describe a state it does not hold.

`GET …/registers` defaults to the authoring state — objects, `course`, globals — because the vertex
buffer of a real mountain is megabytes an agent should fetch by choice (`?prefix=v/`, `?keys=…`,
`?prefix=all`).

One route change rides along: `POST /api/projects` with no document now creates the **default starter
mountain** instead of refusing. The browser always composed `defaultMountain()` client-side; a remote
agent cannot, and "give me a mountain to start editing" is the request it actually has.

Two more came out of the first real agent build. `POST /api/projects` accepts an optional **`name`**,
because every agent's first act after creating a map was renaming it — the name rides the same free-name
walk a `g/name` rename does (sanitised, `_2` when taken), so nothing about naming got a second rule. And
`POST …/ground` answers **`{ points: [[x,z], …] }`** with the top-surface height under each point (4096
per request), sampled from the actual bicubic quilt of the *current* document, live room included. Before
it, every placement agent re-implemented nearest-vertex lookup client-side — wrong between vertices, and
stale the moment another writer sculpted. It is a read that happens to arrive as POST, and `ROUTE_ACCESS`
treats it as one (viewer, not editor).

### Saying it once: selector writes

The measurement that forced the last two additions: on a real map, ~1478 of ~1500 register writes were two
intents a client had expanded itself — *texture every quad in this section*, and *drop these props onto the
surface*. The read side had scoped with `?prefix=`/`?keys=` from the beginning; the write side took only an
explicit list, so every caller re-implemented the same two loops, both of them wrong in the same two ways
(a stale idea of which quads a section holds, and nearest-vertex arithmetic for the ground).

`POST …/registers` therefore takes an optional **`rules`** beside `changes`. A rule names faces by label
intersection — a quad matches when it carries *all* of them, which is what makes "the trail quads inside
this one section" expressible — and `set`s the quad channels: `paint`, `tex`, `orient`, `lock`, `twist`,
plus `addLabel` / `removeLabel`.

**Why this is not a second write model.** A rule is *expanded here* into ordinary `q/<quadId>/<field>`
assignments — the same keys the caller could have listed itself — and those go through the same
`assign(room, …)` as `changes`. Nothing downstream can tell the difference: the same absolute values, the
same last-writer-wins resolution, the same per-register authorship for a scoped revert, the same sync frame
to everyone on the map. What arrives is an intent; what lands is registers, and the register model is
exactly as it was. Order carries the rest of the contract: rules expand in order and the explicit `changes`
are appended *after* all of them, so an explicit key always wins over a rule that happened to touch it. The
response gains `rules: [{matched, keys}]` per rule, and a `where` naming a label the map has not got is
refused by name before anything lands — a rule is a query, and a query that silently matches nothing reads
as a successful edit that never happened.

`set` names quad channels only, on purpose. A prop is a whole-object register and this document states there
is no per-field patch below a register; a rule that could set `pos` on every prop in a section would be that
patch, arriving through a side door. What placements actually needed was not a patch but a geometric
operation, which is the other route.

**`POST …/seat`** takes `{ where, ids, offset }`: props carrying every label in `where`, union the
placements named in `ids` (a bare `prop:…`/`light:…`/`gem:…`/`rail:…` id, or a whole `o/prop/…` key —
labels live on props, so `ids` is how the rest join), each sampled with the very sampler `ground` answers
from and set to `height + offset`. A **rail is seated node by node**, because a rail follows the ground
along its whole length rather than pivoting about its first point. A point with no surface under it is
skipped and counted rather than dropped to zero. It reads each placement's whole register, moves it and
assigns the whole thing back, so it is a geometry call and not a field patch — and it *writes*, which is
why `projectAccess` leaves it on the editor side while `ground`, which asks the same sampler the same
question and changes nothing, stays the one POST exception at viewer.

## The interactive reference

Naisys serves Scalar over the OpenAPI spec its Zod/Fastify stack generates. This server has no spec and
needs none, so its counterpart at `GET /api/explorer` is built the other way round: a single
self-contained page (inline CSS/JS, no CDN, no build step, no dependency) that is itself a **generic
hypermedia client**. It starts at `/api` and renders whatever comes back — `_links` as navigation chips,
`_actions` as forms pre-filled from their body stubs (disabled ones greyed with their reason), templates
with inputs for their `{variables}`, schemas expanded inline on demand, image/audio responses previewed —
and sends real requests with the browser's own session cookie, or a bearer key typed into the header
field (held in a tab-local variable, never stored). It cannot drift from the API because it renders what
the API says rather than a copy of it, and what it shows a human is exactly what an agent sees.

The mount is public like the login page in front of the editor: the page itself carries no data, and
every request it makes is gated by the route being called. Fetched text reaches the DOM only through
`textContent`, so a stored name cannot script the page; it talks only to `/api/...` on its own origin.

## What the demo proved

`scripts/hateoas-demo.ts` is the worked example: an agent that starts from `GET /api` (every later URL
comes out of an envelope), creates a map, sculpts a kicker and berms as vertex registers, paints the
corridor, widens and banks the course with a showoff checkpoint, borrows GARI props and its sky, lays a
rail, a gem line, lights, a label, uploads a tile it drew and a chime it synthesised, authors a collision
speed-boost effect on an `@effects` trigger volume (slot + graph + owner-prefixed node + attachment,
all as registers), and takes a named checkpoint. The result passes `POST /api/preflight` with every prop
page resolved — an exportable mountain authored over HTTP alone.

`test/hateoas-api.test.ts` pins the properties an agent cannot check for itself: honest identity at the
root, the 404-with-recourse, action gating that matches the routes' real refusals, id fill-in/mismatch on
object registers, effect-node addressing (a node's id carries its owner's prefix — the case a
`lastIndexOf('/')` silently truncates), and the rename bar.

The second exercise was a themed mountain built by a team rather than one script: a director agent and
six crews (capability research, terrain, textures, buildings, trees and decor, lights and effects) plus an
independent auditor, every one of them working through the same envelopes against one shared map. Two
things made that safe without any coordination in the server. Registers are addressed by id, so the
director handed each crew an id range (`model:0000–0019` to buildings, `prop:t*`/`prop:d*` to decor, every
`o/effect*` register to one crew because the attachments array lives in a single whole-object register)
and their batches could not collide; and the crews passed each other plain JSON handoffs — a site plan of
post-sculpt coordinates, world-space eave lines, a treetop height — instead of reading each other's writes.
The build put the register grammar through things the demo never touched: buildings as authored-model
kits (walls, roof, windows, chimney as four one-tile models sharing a placement, since a model wears one
tile), a candy-striped arch, and — because an `AuthoredLight` is static and no effect node addresses one —
Christmas lights as flipbook fixtures: two-frame tiles on `fullBright` strips driven by a persistent
`property.texture-flip` (dwell mode for the star toppers) and `property.uv-scroll` for the chase on the
arch. Two API improvements came straight out of the friction: `POST /api/projects` accepting a `name`, and
the batch ground query, which every placement crew used in place of the demo's nearest-vertex arithmetic.

The same team then measured that village against a retail level and rebuilt it (the study is docs/054).
Merqury City (MERQUER, freshly imported with `snowknife import`) was analysed from its extraction — real
wall triangles in the rider band against the main racing line — into a dozen quantified rules for how a
trail runs between buildings: nearest facade 13–20 m from the line (6–10 m at village scale), both walls kept at 77% of
stations, the line riding one-third across the street, buildings on one grid the trail cuts diagonally, a
building with a route on both sides every ~100 m, a pass-under every few hundred metres, furniture in
4–10 / 10–20 / 25–45 m bands. Run over the village's frozen document, the same script put the first build
at zero on every one of those: median setback 51 m, no station walled on both sides, a 400 m run floor,
five buildings at five yaws. The rework crew — one register batch — re-cut the course knots into a
26-m-wide street weaving through two canyons and a plaza, lined it with eleven chalet kits on one
alignment, made the lodge an island with a 24 m alternate lane, spanned canyon A with a covered bridge
at 6.9 m headroom, and borrowed Merqury's own lamps, hydrants, benches, park walls and snowed-in cars for
the bands. Measured again: median setback 9 m, ten of twelve buildings within 20 m, four stations walled
both sides at 14–22 m with the nearer face at 6.9 m, nine buildings per 100 m through the core. What the
format could not express is as instructive: a document carries one course line, so a split around a
building is physical (an open lane with a rail in it) but not an authored route; and height-over-width
stays at 0.5 because a 50 m vertex net cannot cut a retaining wall behind a row of 6 m chalets.

The third round asked why every crew had still written a script, when the surface was meant to be
driven from curl. The answer was four pieces of arithmetic, the same four in every script: walking the
course spine to turn "station 320, six metres off the line" into an `[x, y, z]`; asking the ground where
to seat it; unrolling one lamp into a row of lamps; and composing the eight vertices and six faces of a
box for the tenth time. None of it is authoring judgment, and all of it is done against a document the
server already holds — so it moved into the server (`src/server/api/intents.ts`), as **intents on a
change** that expand into plain assignments before landing, exactly the way a `rules` selector does. A
placement's `pos` may be `[x, null, z]` (Y on the terrain) or `[x, "+1.5", z]`, or `{station, lateral,
above}` / `{knot, along, lateral, above}` in the run's own frame — station in metres from knot 0 along the
same spine the AIP export samples, lateral to the rider's right (the sign `bank` uses); a prop's `yaw`
may be `"course+90"`, facing the rider's left at that station. `repeat` makes a row of one change — `count`
and a `step`, or `every`/`until` along the run — with `{i}` in the key and the name; `from` copies another
register and merges `value` over it (for a *new* key: a copy onto itself would be the per-field patch a
register does not offer); `shape` on an `o/model` generates a `box`, a gabled `house` shell, a `roof` or a
`panel` in the frame the bake expects. `GET …/course` is the ruler all of this is read against: the run's
length, each knot's station, and a station table with heading, floor width and ground. The response's
`intents` block counts what expanded, so twelve lamps read as twelve. The guide gained a *From curl*
section to match — `--json @file` and `--data-binary @tile.png` are the whole client.

The village's next pass was made that way: five `curl.exe` calls and no script. The first read of
`GET …/course` found what the knot-to-knot audit could not: the spine is a uniform Catmull-Rom through
the knots, and a 400 m segment running into a 33 m one loops — headings swinging through 250° and back —
diving 10 m under the plateau at the village entrance and 18 m at its exit, on the very line the AIP
export samples for the race line and the AI paths. One `course` assignment with fifteen `[x, null, z]`
knots (seated by the server as they landed) re-cut it to within a metre of the ground and monotone in
heading from knot 6 to the finish. Then a market: three `shape` models (a gabled stall, its roof, a
garland panel), two stalls by `repeat` on the plaza's wide side, a third on the near side by `from`, and
the plaza's lamps paired across the line by `from`, every position given as `{knot, along, lateral}` so
the re-cut could not move it; `?near=` read each one back at the station and setback it was asked for,
on the ground to the millimetre. Revision 16: 31 knots, 14 new placements, 3 new models.

## Files

| File                              | Role                                                            |
| --------------------------------- | --------------------------------------------------------------- |
| `src/server/api/hateoas.ts`       | Envelope types, `link`, identity `gate`                         |
| `src/server/api/discovery.ts`     | `/api` root, `/api/reference`, `/api/avatars`, unknown-path 404 |
| `src/server/api/guide.ts`         | The agent-facing authoring manual served at `/api/guide`        |
| `src/server/api/explorer.ts`      | The interactive reference at `/api/explorer` — a hypermedia client |
| `src/server/api/schemas.ts`       | JSON Schema registry + `/api/schemas` routes                    |
| `src/server/api/workspace.ts`     | Project envelopes (`projectEnvelope`), register GET/POST + rule expansion, ground query, seat, course ruler |
| `src/server/api/intents.ts`       | Intents on a register write: run-relative positions, ground Y, `repeat`, `from`, `shape` |
| `src/server/app.ts`               | Mount order (discovery last) + `ROUTE_ACCESS` entries           |
| `scripts/hateoas-demo.ts`         | The end-to-end authoring agent                                  |
| `test/hateoas-api.test.ts`        | The gate's coverage of all of the above                         |

## Future considerations

- **Envelope coverage of the cached library lists.** Safe as long as a producer's envelope depends only
  on what its cache key encodes; deferred until something consumes it.
- **A `rels` page.** Short descriptions per rel name, so `rotate-key`-style questions need no guessing;
  titles carry this weight today.
- **Server-sent register stream.** An agent that wants to *watch* a map edits arrive today by polling
  `GET …/registers`; the session channel already carries the stream a socket client would want.
