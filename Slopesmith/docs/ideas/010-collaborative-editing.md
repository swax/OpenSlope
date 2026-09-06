# 010 — Collaborative editing (multi-client, region-locked, P2P)

This is the original assessment of the codebase against collaborative editing, and its reading of what helps
and what works against it still holds. The two designs that grew out of it live elsewhere: `038` for the
runtime — where the authoritative document lives and how participants reach each other — and `039` for
concurrency, which claims one register at a time automatically rather than rectangles by hand.

An assessment of how well Slopesmith's current architecture lends itself to multiple clients
editing the same map, the lowest-cost path to get there, and where the pieces run. The conclusion
in two lines: **the data model is collaboration-friendly; the runtime is collaboration-agnostic.**
And the deployment shape: **the editor is a static site (GitHub Pages, custom domain); mountains
are never stored centrally; the only server is a small lobby subdomain that introduces peers, who
then sync directly over WebRTC with one of them acting as master host.** The hard, irreducible
parts — a deterministic pure core and a single clean serializable document — are already in good
shape. The entire sync *tier* is absent and would be additive, greenfield work.

## What the architecture is today

Slopesmith is a single-user authoring workstation. The document lives in the browser tab; the
server is a thin file-I/O + bake bridge.

**Client (`src/app/`)** — one mutable module-global `mdoc: MountainDoc` (`main.ts`). Every edit
writes fields in place (`mdoc.corners[j] = …`, `setCornerHandle`, paint a `"row,col"` key).
Persistence is a single `localStorage` slot per browser (`MOUNTAIN_KEY`, `persistDoc`). Undo/redo is
whole-document JSON snapshots on an in-memory stack (`snapshot()` = `JSON.stringify(mdoc)`;
`applySnap` does `mdoc = JSON.parse(...)`). Rendering rebuilds the entire scene on each commit
(`rebuildMountainScene`, frame-coalesced through `rebuildQueued`).

**Server (`src/server/`, Vite dev middleware)** — completely **stateless** request handlers.
`/api/export` is a pure `doc → writes Maps/<doc.name>/ + runs snowknife` function of the POST
body. The rest (`/api/level`, `/api/lightmap`, `/api/textures`, `/api/keyed`, …) are read-only file
reads for the reference layer and the texture palette. There is no database, no session, no
server-held document, no WebSocket, and no auth.

## What helps

1. **The whole authored state is one plain-JSON object.** `MountainDoc` is a flat `corners`
   number array + sparse keyed maps (`handles`, `paint`, `texPaint`) + a `course` array + `sun`. No
   class instances, no Three.js objects in the doc, no cycles. That is exactly the shape you want to
   ship over a wire, diff, and store.
2. **`src/core/` is pure and fs-free.** Same doc in → identical geometry and lightmaps out, on every
   client. There is **no hidden state that can diverge** — the single biggest thing in
   collaboration's favour, and the part most tools get wrong.
3. **Edits are already granular and structured.** Localized field writes over a grid of *independent*
   cells plus sparse maps. That maps almost 1:1 onto per-cell / per-corner operations or registers.
4. **The bake/write path is already stateless** and does not care who sends the doc.

## What works against it

1. **No shared source of truth.** The doc only ever lives in one tab's `mdoc` + that tab's
   `localStorage`. Two clients today are two unrelated documents that never see each other. A shared
   source of truth and a sync channel must be added — in the chosen shape a master-host *peer* over
   WebRTC rather than a server store — and the Vite dev-middleware host has no realtime layer and is
   not a production server (nor needs to become one; see "Where it runs").
2. **Whole-doc-replace semantics everywhere.** Undo, load, export, and `applySnap` all swap the
   entire document. Nothing is expressed as a mergeable operation, so a naive "sync the doc" is
   last-write-wins clobbering of concurrent edits.
3. **Mutate-in-place + reassigned module global** (`let mdoc`, reassigned on undo/load/regen) fights
   a long-lived shared store; lil-gui binds by reference, so every reassignment already forces a
   panel rebuild, and a remote-op layer inherits all of that plumbing.
4. **Rebuild-the-world rendering, with a lightmap bake on the critical path.** Fine for one human at
   human speed; with N clients streaming edits, every remote op would re-tessellate the quilt and
   re-bake lightmaps. The lightmap bake is the part that will feel sluggish first.
5. **No identity / presence / locking / auth**, and **global undo** becomes ambiguous the moment
   there are two editors (undo whose change?). All greenfield.

## The chosen direction: region locks

Instead of a full merge engine (CRDT/OT), partition the map: a client **highlights and claims a
rectangular region of the corner grid**, others see it is taken, and the owner edits freely inside
it. The key insight that makes this cheap:

> **If every concurrent edit is confined to a disjoint locked region, you never need CRDT or OT at
> all.** Two clients never write the same field, so there is nothing to merge — the document stays
> consistent *by construction* (spatial partitioning instead of merge resolution). Locking solves
> "who may write"; disjointness makes "how do I merge concurrent writes" disappear.

### Why it fits this document unusually well

The lockable unit already exists. The document *is* a grid of corner control points (`corners`,
row-major) plus cell-keyed maps (`paint` / `texPaint`, keyed `"row,col"`). A region lock is a
rectangular corner range `[r0..r1] × [c0..c1]`, and the mapping falls out:

- **corner drags / handle edits** → indexed by corner → trivially inside or outside a region.
- **paint cells** → a cell `(r,c)` is bounded by four corners → "yours if all four corners are
  yours".
- **the highlight UI is already built** — the editor has box-select of corners (`regionSel`,
  `setRegion`, `viewport.setRegionMarks`), used today for bulk crease/smooth. That
  selection rectangle is most of the "highlight the area I'm claiming" primitive; reuse it to request
  a lock and to draw other people's locks in their colour.

### Runtime shape (master host over WebRTC)

There is no server-held document. One peer — the **master host**, normally the mountain's owner —
plays the role a sync server otherwise would, over WebRTC data channels:

- The host holds the authoritative `mdoc` plus a **lock table** (`region → peerId`, with a
  heartbeat TTL so a dropped peer does not freeze a region forever).
- Topology is a **star**: every peer keeps one data channel to the host (opened via the lobby,
  below). A full mesh buys nothing while a single peer is authoritative, and the star gives ops a
  total order for free — the host's apply order *is* the order.
- A peer **claims** a rectangle. The host grants it if disjoint from existing locks, else rejects
  and the UI shows the conflicting region.
- The peer edits inside its lock and **streams ops** (set-corner, set-handle, paint-cell) to the
  host, which **validates** each op falls within the sender's lock, applies it to the authoritative
  doc, and **fans it out** to the other peers, who render it read-only.
- **Late joiners** get the whole doc as one snapshot — `MountainDoc` being a single plain-JSON
  object pays off again here — then the live op stream.
- Locks **release** on idle, explicit unlock, or disconnect.
- **Persistence is peer-local.** Every peer applies every op, so each holds a current replica in
  its own tab + `localStorage`, and any peer can export `.slope.json`. "Saving the session" is any
  peer exporting; nothing is ever stored server-side, by construction.

## Gotchas (all manageable, all real)

1. **Boundary corners are shared.** If A locks `0..5` and B locks `5..10`, corner 5 sits on patches
   in both regions and moving it changes both sides. Either leave a one-corner gutter, or adopt the
   rule "a corner is movable only if *every* cell it touches is yours" (locks cover cells; shared
   edge corners are frozen for both). The latter is cleanest.
2. **Some edits cannot be regional.** Grid resize (`rows` / `cols` / `spacing`), the sun (global),
   and the "new mountain from reference" / corridor regen paths *replace `mdoc` wholesale*. These
   need an exclusive whole-doc lock or an owner-only mode — you cannot partition a structural rebuild.
3. **Course knots are not grid-indexed.** They are free 3D positions, not corner indices, so they do
   not fall cleanly inside a corner rectangle. Make each `CoursePath` its own lockable object ("lock
   Course A"), independent of the terrain region locks.
4. **Locking removes conflict, not the op channel.** Remote ops must still be broadcast, applied, and
   rendered, and today that means `rebuildMountainScene` re-tessellates and **re-bakes lightmaps** on
   every remote commit. Locks do not fix that.
5. **Undo must become per-user** and scoped to your own ops in your own region; the global
   `JSON.stringify(mdoc)` snapshot stack cannot survive two editors.
6. **The host is a tab.** Closing it ends the session unless the role is handed off. Mitigation is
   cheap in this design: every peer already holds a full current replica (it applied every op), so
   host migration is "lobby promotes a peer, everyone reconnects, locks re-claim" — a reconnect
   dance, not a state-recovery problem. Ship without migration first (session ends, everyone still
   has the doc), add promotion later.

## Where it runs: static site + lobby subdomain, no central store

- **The editor — GitHub Pages, custom domain.** The Vite build is plain static assets, and the
  editing core is fully client-side: `src/core/` is pure, the doc lives in the tab, autosave is
  `localStorage`, and `.slope.json` download/load already exists. Single-user Slopesmith needs no
  server at all.
- **The lobby — one small always-on service on a subdomain.** WebRTC cannot bootstrap itself: two
  browsers must exchange SDP offers/answers and ICE candidates through a rendezvous before any data
  channel exists. That is a WebSocket service, which Pages cannot host. It is also *all* the server
  there is: rooms ("who is hosting which mountain right now"), presence, and handshake-blob relay.
  It never sees a corner, a paint key, or a course knot. A Cloudflare Worker + Durable Object (free
  tier, WebSocket hibernation) fits; so does a ~40-line Node `ws` process anywhere.
- **NAT reality.** STUN (free public servers) gets most peer pairs a direct connection. Symmetric /
  CGNAT / corporate pairs cannot connect without a TURN relay, which carries the actual session
  traffic and costs real bandwidth. Ship STUN-only and let the rare failing pair get a clear error;
  add TURN only if it bites.

### What the public build cannot carry: the asset/bake bridge

Every `/api/*` endpoint in `vite.config.ts` is local file I/O against extracted, non-redistributable
game data, or runs `snowknife` — the reference layer (`/api/level`, `/api/props`, `/api/lightrig`),
the texture palette (`/api/textures`), the bake (`/api/export`). None of that exists on a static
host, and the art is not ours to publish. So the split:

- **The public site** is the geometry + ride + collaborate editor. The client already survives the
  endpoints being absent (the texture-list fetch catches `offline / static build`); promote that to
  a deliberate mode — probe once for `/api/*` and gate the reference layer, texture palette, prop
  library, and export-bake UI on the probe.
- **Bake + reference layers stay local capabilities** (`npm run dev` against your own extracted
  data). A shared session's `.slope.json` travels to a local setup for baking — which the export
  path, being a pure function of the doc, does not care about.

## Auth & session workflow

One insight makes this small: **the master host is already the bouncer.** Every op flows through
the host and is validated against the lock table; that same choke point is admission, roles, and
kick. The lobby never touches the doc, so there is nothing server-side worth protecting beyond
rate-limiting room creation. No accounts, no user database — three small pieces instead:

1. **The room code is the credential (capability URL).** Hosting mints an unguessable room ID; the
   join link is `slopesmith.example/#join=brisk-elk-4207`. Whoever holds the link may knock. Posting it
   in a private Discord channel scopes it to exactly the people you would have invited — the
   community's own chat does the identity work.
2. **Knock-and-approve, host-side.** The link does not drop a peer into the session; it sends a
   knock through the lobby with a self-picked username + colour. The host sees "Jed wants to
   join — Accept / Viewer / Reject", and the WebRTC handshake proceeds only on accept.
   Impersonation is theoretically possible and practically irrelevant among people sitting in the
   same voice channel saying "let me in".
3. **A browser keypair for "remember me".** On first run the editor generates an Ed25519 keypair
   (WebCrypto, ~10 lines) in `localStorage`; the peer ID is the pubkey fingerprint. This buys
   stable pseudonymous identity across sessions with zero accounts: the host ticks "always admit"
   on a knock, and the same browser auto-admits next session. It is also the hook later features
   hang off (ban lists that survive rejoin, per-map ACLs) without ever building a user database.

Authorization stays entirely host-side: editor vs. viewer, region grants, kick (close the data
channel; locks release). One cheap safeguard: **the host snapshots a region when it grants the
lock**, so reverting a bad actor's work is kick + restore-region, not archaeology.

### The session, as a user story

1. Maya opens the site; her mountain loads from `localStorage`. **Host session** → the editor
   connects to the lobby, gets a room, and she posts the join link in Discord.
2. Jed clicks it; his knock appears in Maya's editor; on accept her host streams the doc snapshot
   and the mountain pops into his viewport.
3. Jed box-selects the canyon → **Claim**; the host checks disjointness and grants; the region
   outlines in his colour on every screen. Priya joins late and claims the finish area. Three
   editors, three regions, zero merge conflicts by construction.
4. Maya leaves: either the session ends (every peer still holds a full replica — nothing is lost)
   or she passes host and the others reconnect (gotcha 6).
5. End of night, someone exports `.slope.json` and posts it in the channel; the pinned attachment
   is the save file, the backup, and the canonical latest. The Discord channel quietly becomes the
   map archive — and a crew that wants diffs and history keeps the files in a git repo instead,
   since the doc is line-diffable JSON.
6. Thursday, Maya is offline; Jed loads the pinned file, hosts, posts a new link. "The map" is a
   convention (the latest pin), not a database row, and forking a map is loading the file — a
   feature, not a leak.

### Discord OAuth: the escalation, not the start

Bolt OAuth onto the lobby only when one of these becomes real: a public "open sessions" browser on
the lobby subdomain (needs trustworthy names), impersonation actually biting, or server-enforced
bans. The Worker runs the OAuth2 `identify` dance and signs a token; knocks then arrive bearing a
verified Discord tag + avatar instead of a self-claimed name. The trust model does not change —
host approval stays the gate — only the label quality improves, so nothing needs redesigning.

## Staged path (increasing fidelity)

- **Tier 0 — today: file hand-off.** People take turns. Export → `Maps/<name>`, someone else
  loads the `.slope.json`. Async, no concurrency. (Already works.)
- **Tier 1 — host-held doc + region locks over P2P.** One peer is the master host holding the doc
  and the lock table; the lobby introduces peers; ops flow over WebRTC gated by region ownership.
  This is the recommended starting point: real multiplayer with no merge engine *and no storage
  tier*, reusing the existing box-select for the claim/highlight primitive. Good for a handful of
  editors who are not fighting over the same cells.
- **Tier 2 — operation-based sync everywhere.** Broadcast fine-grained ops rather than snapshots even
  outside locks; add presence and live cursors. The edit sites are already this granular, so it is
  mostly mechanical.
- **Tier 3 — CRDT.** The document is already a grid of independent registers + keyed maps, which is
  almost exactly Yjs's model: `Y.Array` for `corners` (LWW per index), `Y.Map` for `paint` /
  `texPaint` / `handles`, and a list-CRDT (fractional indexing) for the ordered `course` knots. This
  buys true same-cell concurrency and offline merge — and `y-webrtc` is *exactly* the deployment
  above (static app + signaling subdomain + P2P doc, no central store), so the hosting shape carries
  over unchanged. A CRDT also dissolves the master-host role: no session owner, any peer can drop.
  Reach for it only when region locks or host fragility are not enough.

## The two costs you pay regardless of tier

1. **Incremental rendering** — make remote ops update only the affected patches instead of
   re-tessellating and re-baking the whole mountain. The lightmap bake on the critical path is the
   thing that will feel sluggish with several editors; it is the one piece of genuine engineering
   that none of the tiers give you for free.
2. **Per-user undo** — rework undo/redo from the global snapshot stack to per-user op histories
   scoped to each editor's own changes.

## Bottom line

On the parts that are hard to retrofit — a clean serializable document and a deterministic pure core
— Slopesmith is already most of the way there. On the sync tier it is at zero, but that work is
well-understood and additive. Region locks are the right first architecture for this codebase: the
corner grid and the existing box-select make the lock granularity fall out naturally, and spatial
partitioning lets you ship multiplayer without ever building a merge engine. The deployment keeps
the same austerity: a static editor on Pages, a lobby that only introduces peers, admission by
invite link + host approval rather than accounts, and mountains living nowhere except with their
editors. Start at Tier 1; reach for Yjs only if same-cell concurrency, offline merge, or host
fragility become real requirements.
