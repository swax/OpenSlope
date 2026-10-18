# Slopesmith

**OpenSlope's collaborative browser space for authoring and riding original snowboard courses.**

Shape a watertight bicubic Bézier-patch mountain, paint its surfaces, place props, lights, rails,
pickups, and effects, then ride it in the same window. Run it locally or host a private server with
accounts, roles, per-map permissions, live presence, optional voice chat, and a synchronized video
Jukebox. The same site supports desktop, mobile touch and game controllers, and standalone WebXR
headsets. Slopesmith requires no disc or DCC tool for original authoring.

```text
Slopesmith ──┬──▶ Test mode: ride in the browser
             └──▶ Maps/<NAME>/ ──┬──▶ Snowknife glTF ──▶ Unity
                                  └──▶ Snowknife repack ──▶ PCSX2 / PS2
```

## Quick start

Slopesmith requires Node.js 24:

```powershell
cd Slopesmith
npm ci
npm run dev       # editor: http://localhost:5179; the API starts on a free port behind Vite's /api proxy
```

Useful commands:

```powershell
npm run serve     # API only, on http://127.0.0.1:5180
npm test                  # fast edit-time checks
npm run test:integration  # server, socket, browser, and CPU-heavy checks
npm run test:full         # required gate: every check under test/
npm run test:local        # full gate plus checks that read extracted Maps/ data
npm run typecheck # strict TypeScript check
npm run lint      # ESLint over src, test, scripts, and tools; the gate requires zero findings
npm run build     # production browser and server builds
npm run smoke     # default mountain -> export -> real Snowknife glTF -> verify GLB
```

The editor and API bind to loopback by default. The API has owner-level access to local maps and
projects, so Slopesmith refuses a bare network-facing `--host`. For an isolated trusted network,
`npm run dev -- --host --unsafe-open-network` is the explicit escape hatch. For a real multi-user
deployment, use accounts, TLS, and the [production deployment guide](docs/041-production-deployment.md).

The same API is self-describing for programs: an AI agent (or curl) starts at `GET /api` with a personal
access key and discovers everything by following links — creating maps, editing them register-by-register,
uploading textures, sounds, skies, and avatars ([docs/052](docs/052-hateoas-api.md)). Open `/api/explorer`
in a browser for the interactive reference over that same surface, and
`npx tsx scripts/hateoas-demo.ts <url>` authors a complete demo mountain through it.

### Production shape

The production package contains the frontend, Node API and Rust multiplayer relay, including their runtime
dependencies. systemd supervises Node and Rust separately; a shared host Caddy serves HTTPS and static files
and routes each socket to its service. Existing Apache deployments can retain their proxy during migration.
The [packaged deployment guide](docs/060-packaged-deployment.md) covers signed releases, installation and
automatic rollback. Immutable `/opt/slopesmith/releases/<commit>` directories are selected through an atomic
`/opt/slopesmith/current` link; durable projects and maps stay under `/srv/slopesmith`. The
[host operations guide](docs/041-production-deployment.md) covers capacity, backups and the existing Apache
installation. Run exactly one API and one relay process; their in-memory rooms require additional
coordination before either can use load-balanced replicas.

Once the first administrator enrols, server management stays in the browser: invite members, assign roles,
limit who may edit each mountain, inspect connected users, and install a guarded revision from the update
signed release channel configured by the host operator—including a fork—or restart the supervised service from
**Settings → Server**. The project files remain on storage you control.
Voice is an optional, separate self-hosted LiveKit service; the Jukebox shares only public video identity,
queue state, and timing through Slopesmith while each member keeps their video-bridge credentials in their
own browser.

### Quick Quest/mobile access through ngrok

Use the account-enabled launcher when a standalone Quest, phone, or tablet needs to reach a Slopesmith instance
running on this computer. Install and authenticate the [ngrok agent](https://ngrok.com/docs/start),
copy `.env.example` to the gitignored `.env`, and give the editor endpoint an exact hostname:

```powershell
Copy-Item .env.example .env
# Edit .env: SLOPESMITH_ALLOWED_HOSTS is a hostname; SLOPESMITH_LOCAL_SERVER_NGROK_URL is its https:// URL.
npm run run:local-server
# In a second terminal:
npm run run:local-server:ngrok
```

`run:local-server` builds and starts Rust multiplayer alongside the account-enabled Node API and Vite,
configuring their shared secret and relay routing automatically. Rust 1.99+ is required. The same ngrok
tunnel carries multiplayer WebSockets; no second multiplayer tunnel is needed.

Open `SLOPESMITH_LOCAL_SERVER_NGROK_URL` on the remote device. This launcher requires Slopesmith accounts and
trusts ngrok's forwarded HTTPS metadata; do not expose the ordinary unauthenticated `npm run dev` process.
Name only endpoints you control in `SLOPESMITH_ALLOWED_HOSTS` and stop the tunnel when the session is over.

Reaching an optional local media server from a remote device needs a second, distinct endpoint of its own; the
[Jukebox guide](docs/063-video-bridge.md#reaching-a-local-server-from-quest-or-mobile) covers that case.

Most authoring features have no native dependencies. **QuadWild — native global solver** is an
optional retopology strategy and is not bundled; install the locally patched checkout at
`../quadwild-bimdf/` using the [QuadWild setup guide](tools/retopology/quadwild-patches/README.md). If it is not
installed, the Retopology panel marks that strategy unavailable and requires an explicit choice of
the built-in **Elevation loops — contour flow** strategy instead.

Jukebox playback starts off and its panel starts collapsed. Turn it on in **Users → Jukebox** to join the server-wide
video queue and plays through YouTube's official embedded player, which needs no setup. Public URLs, queue
order, play/pause, seeking, and playback time are synchronized so members watch together; volume and mute
remain local to each browser. Putting the movie onto authored course screens instead of the panel needs a
frame Three.js is allowed to sample, which YouTube's iframe does not provide; the
[Jukebox guide](docs/063-video-bridge.md) describes the optional local media server that covers that case.

### Public homepage and guest riding

**Users → Map permissions → share publicly** publishes the current editable mountain for guest riding.
Its owner or a moderator can change publication. The separate **Public reference maps** dialog manages
reference-map listings; its menu entry is currently hidden. Everything starts private.
**Copy public link**, beside the sharing checkbox, opens that mountain directly in the guest player using
its name, for example `/play/MyMountain`.
Shared maps load immediately for visitors and members. No rider name or sign-in
is required. Private or deleted links show an unavailable message. The sign-in page includes **Back to homepage**.
The map catalogue is `/maps`, ISO management is `/isos`, and the editor uses `/editor/<mapname>`.
Signed-in members also see **Private server maps** on `/maps`. Those tiles open the existing server mountain
in the editor; public mountains stay in **Public maps** without duplicate tiles. Guests receive only the public
catalogue, and private mountains remain unavailable through public play links.
Each authored map has **Edit**; ISO maps have **Inspect**, which opens the map as a read-only reference beside
an empty editing workspace. Signed-in authors keep the server editor. Signed-out visitors edit locally:
the published mountain is copied into browser storage, and references come from this device's loaded ISO maps.
Editing, creating, importing, duplicating, and exporting mountains stay on the device. No server project is
created or saved and no collaboration session connects. **Export mountain…** downloads an editable ZIP with
the custom assets; **Import mountain…** restores one locally. Browser storage is separate from signed-in
recovery and can be cleared by the browser. **Save to folder…** keeps `mountain.slopesmith.zip` in a folder you
choose and updates it automatically after browser saves, including custom assets. The save icon distinguishes
browser, folder, and server saves; click it for the location, last save time, and backup actions. Folder autosave
requires a browser with the directory picker (such as desktop Chrome or Edge). If folder permission expires,
choose **Resume folder autosave** from the save icon. The folder copy survives clearing site data; use
**Open mountain folder…** in the editor or on `/maps` to reopen it. Other browsers can use Export/Import mountain
for file backups. **Export map…** writes the map files Snowknife uses to repack the course into your ISO.
The **Home** icon saves
pending edits and returns to `/maps`. Its **Local maps** section lists browser-saved mountains, including
imports, and **New map** starts a new local mountain. Guest edits of public maps create numbered copies such
as `MyMountain_REV_1` and `MyMountain_REV_2`; reopening a local tile resumes that copy. **File → Rename mountain…**
renames it without changing its identity or the public source. Local tiles have **Delete**, with a confirmation
before removing that browser copy and its custom assets. Deleting a browser copy keeps folder copies and downloads.
Local tiles stay local even for signed-in
members; local copies are never uploaded automatically. Signed-in members keep their account menu in the local
editor, including profile, settings, sign-out and Exit editor. Only signed-out local editors use the Home-only
control. Sign in from the Maps header to use the server editor.
Its header uses the editor's logo and signed-in account menu. **File → Exit editor** and
**Account menu → Exit editor** save pending changes and return home without signing out.
GitHub, Discord and About live at the right of the ISO, Maps and player toolbar. About describes using your
own assets and links to the source and server setup guide; narrow player headers keep those links inside About.
Public and ISO map cards have **Open**, plus **Load ISO maps** when assets are missing. Choose
the card or its highlighted **Open** button to open that mountain. Saved-map tiles open **Edit**, and the new-map
tile opens **Create**. On `/isos`, clicking a tile activates its current **Load**, **Unload**, or **Cancel** button.
Loaded ISO maps also offer **Open** for public Play and **Inspect** for the editor's reference view.
Primary buttons share the same highlighted style; secondary actions keep their own targets.
**Play**, **Play in VR**, **View map**, and **Inspect map** appear over the map preview.
Click the map to choose a local start point; **Reset start** restores its default. **View map** shows the mouse
movement legend for start placement, orbit, pan, and zoom. Hold **Alt + WASD** to move the camera.
There is no separate map selection panel.
Click the online-user count in the header to slide out the shared **Users** and **Chat** panel on Maps, ISO,
or Play. Before joining, it shows the user list and nickname form. Choose **Join chat** (members choose
**Join as** their account name) to reveal the Chat tab. Account names are reserved. Closing the panel keeps
chat joined across public-page navigation. **Leave chat** returns to Users and lets guests edit their nickname
before rejoining. Anonymous multiplayer continues independently of chat.
The user list labels each map **ISO** or **Server map** and marks people in the **Same play room**.
People on your map in another room show **Different play room**; map links preserve that room and map source.

For an isolated Rust multiplayer service, run `npm run dev:multiplayer` with Rust 1.99+ installed.
Guests use separate play connections and can invite friends into a room without occupying editor seats.
See [the multiplayer setup guide](multiplayer/README.md) for contracts, tests, deployment, and current limits.
Enter focuses connected chat while the panel is open; Escape closes the panel and returns control to the mountain.
The header remembers the last public map so it can be reopened from Maps or ISO, with a labeled **Exit**
button at the far right while playing.
Public play hides editor bounds and fullscreen controls, with the score just below the header. **ISO** stays available
alongside **Maps**, which returns to the catalogue. ISO availability and its load link live in the **Assets** menu.
The lower-left ride legend follows board/on-foot and first/third-person changes; on narrow screens
it folds into an expandable **Ride controls** tab.
Editor Test rides keep the normal bottom-left editor chat and the Test tools panel. Press **Enter** during a
ride to chat; sending a message or pressing **Escape** returns the keyboard to the ride.

Retail courses require the visitor's own SSX Tricky PS2 ISO. Authored mountains that borrow game assets
are labelled **ISO optional** and remain playable without it: missing game textures render as plain
surfaces and missing props are omitted. Custom textures and models remain available. Supplying an ISO
restores its assets locally. The existing Native importer runs as WebAssembly in a browser worker, reads the ISO locally, and saves
the extracted maps in IndexedDB. The homepage has separate **Public maps** and **From your ISO**
sections. Only maps already loaded on this device appear in the latter, including maps the server
has never imported or published.

The **ISO** and **Maps** tabs at the top switch between ISO management and the map browser. Both pages use
compact map tiles. Under **ISO**, choose a disc to discover its maps, then use **Load**
or **Unload** beside each map. Shared map pages show the required donor maps with green **Loaded** and red
**Not loaded** badges, derived from their prop, texture and other game-asset references. Their ISO management
link retains that map's name, lists its requirements, and offers **Load required maps** and a return link.
You can load several maps: each tile shows its progress or **Queued** state, and imports run one at a time.
Tiles reserve space for progress and messages, and update in place so loading never reshuffles the grid.
Cancel a loading or queued map from its tile; other queued maps continue.
Leaving `/isos` during a scan or load asks for confirmation because it cancels the active load and queued maps.
Selecting an ISO scans it without loading every map. **Clear** removes loaded ISO maps;
browser storage may also evict them. Your ISO and extracted retail files are never uploaded.

Collision sounds use the event lookup recovered from that ISO's boot executable. For courses cached by
an older importer, choose the ISO once more when prompted: the scan repairs only the sound metadata and
keeps the cached course assets. Local sky tiles clamp their texture edges and render outside course fog;
the open top uses a fill derived from the upper tile edges.

Guest riders share multiplayer poses, world interactions, and server chat with members on the same
mountain or reference course. Guests cannot edit, browse private maps, or call member APIs. Public
reference listings expose names and ISO course slots; the server still requires member authentication to
stream retail terrain or art. Retail disc slots have shared riding rooms available to local ISO users.
Unpublishing removes the server listing and closes guest sessions for unpublished custom/reference rooms;
it does not remove a visitor's own local disc courses or their retail riding rooms.
Reference exports that mix authored and retail files must be published through their editable mountain;
their flattened model files cannot be safely separated back into authored and ISO content.
Editable mountains containing imported retail effect graphs can be published; the public document omits
those graphs so their terrain remains playable without distributing imported effect data.

The checked-in browser importer runtime keeps ordinary builds independent of native tools. After changing
the Native import code, install and activate Emscripten **6.0.12**, set `EMSDK`, and run
`npm run build:iso-importer`. The build script copies JavaScript, WebAssembly, and dependency notices into
`public/iso-importer/`. `test/public-home.test.ts` exercises publication, guest isolation, riding, chat,
member multiplayer, and a synthetic ISO extraction/cache reload without retail data.

### Load a reference in the editor

Follow the [import-to-browser guide](../Snowknife/docs/browser-play.md) to build Snowknife and populate
the repository's `Maps/` folder. Slopesmith reads that output directly; no glTF conversion is needed.
In **Scene ▸ Reference**, choose the imported mountain and wait for it to load. Then enter **Test**,
select **Reference** as the ride target, and click **Play**.

## Formatting

[`Slopesmith/.prettierrc.json`](.prettierrc.json) defines the source style: two spaces, single quotes,
semicolons, and a 120-column wrapping target. Prettier is pinned in `devDependencies` and installed by
`npm ci` in `Slopesmith/`; no global formatter is needed. Run from the repository root:

```text
npm run format:slopesmith        # apply formatting
npm run format:slopesmith:check  # check without writing; exits nonzero on differences
```

Inside `Slopesmith/`, the equivalent commands are `npm run format` and `npm run format:check`.
They cover hand-written TypeScript, JavaScript, CSS, and HTML in `src/`, `test/`, `scripts/`, `tools/`,
and the top-level configuration and entry point. Generated contracts, vendored code, upstream patches,
build output, and local map/workspace data are excluded by [`.prettierignore`](.prettierignore).
Line endings match [`.gitattributes`](../.gitattributes): LF for scripts and CRLF for CSS.
Embedded languages in template strings are left intact. As with the native, Snowknife, and Unity
formatters, these are explicit local commands rather than an additional CI gate; ESLint remains a
separate correctness check.

## Editing workflow

Every mode edits or observes the same mountain document:

| Mode | Purpose | Details |
|---|---|---|
| Info | Inspect the mountain, references, and scene settings | [Design](docs/001-design.md) |
| Edit | Transform and restructure points, edges, patches, and Bézier controls | [Course model](docs/002-course-model.md), [topology surgery](docs/017-topology-surgery.md) |
| Sculpt | Raise, lower, pull, push, smooth, flatten, grab, and nudge the surface | [Sculpt mode](docs/004-sculpt-mode.md) |
| Paint | Assign ride surfaces and terrain textures | [Texture paint](docs/005-texture-paint.md) |
| Props | Place models, lights, rails, groups, pickups, and imported glTF assets | [Scene authoring docs](docs/README.md#scene-content) |
| Effects | Author and inspect portable effect graphs and prop attachments | [Effects editor](docs/026-effects-editor.md) |
| Test | Ride the mountain or a loaded reference with keyboard, touch, controller, or WebXR | [Test ride](docs/016-ride.md) |

The saved terrain is a general quad control mesh, not a heightfield or fixed ribbon. One required
Catmull-Rom racing line supplies the start, respawn direction, exported path, and high-level channel
shape; the mesh owns the actual terrain. Preview, ride contact, and export use the same Bézier data.

## Mountains, references, and export

Editable mountains live as revisioned projects under the API-owned, gitignored `workspace/` folder.
Use **File → Settings → Server → Local storage** to choose the workspace and `Maps/` locations. See
[Local Projects](docs/035-local-projects.md).

**File → Export mountain…** downloads the current editable revision and its complete mountain-local asset library as
`<NAME>-r<REVISION>-<UTC-TIMESTAMP>.slopesmith.zip`. **Import mountain…** asks for the new workspace mountain's name, then creates it from
one of those archives; it never overwrites the source mountain or an existing name. **Duplicate mountain**
asks for the copy's name and makes the same kind of fork inside one server without sending asset bytes through
the browser. History checkpoints can be exported in the same portable
mountain format from **File → History…**.

The File menu keeps actions that affect the open project together under the mountain's actual name: History, Rename,
Duplicate, Export Mountain, Export Map, and the admin-only Delete Mountain action. Delete removes the
mountain's revisions, checkpoints, and local assets and retires its name; it does not silently reuse that name.

The Reference panel can load an imported or previously exported map read-only for scale, terrain,
props, effects, textures, audio, and course-line study. It does not convert a retail mountain into an
editable project; **new mountain from this course** instead seeds a fresh document from its racing line.
Once loaded, comparison halves read **Reference: `<name>`**. The Scene entry and Effects/Test selectors remain
**Reference** because they choose the comparison role rather than identify its current source.
See [Authored Map References](docs/036-authored-map-references.md).

SSX Mod Manager loose-level ZIPs can be converted directly into that reference contract when Snowknife and a
clean Tricky disc dump are available in the surrounding OpenSlope checkout:

```powershell
npm run import:mod-map -- "C:\Mods\My Course.zip" "C:\discs\ssx-tricky.iso" ALOHA MY_COURSE
```

The command infers the replaced course slot from `DATA/MODELS/<slot>.map`, rebuilds the native level archive
inside a temporary copy of the ISO, and publishes the completed folder beneath the configured Maps root. It
never writes to the supplied ISO and refuses to overwrite an existing map. Run
`npm run import:mod-map -- help` for destination, override, environment-variable, and diagnostic-workspace
options. Older mods are handled conservatively: missing optional MAP labels are repaired only in temporary
data, dangling effect-node targets are audited and replaced with the SSF format's native null value so valid
effects survive, structurally corrupt SSFs are reported and omitted as `Effects.json`, and a non-retail sky is
kept as merged geometry even when it cannot provide editable ring metadata.

**Export map…** writes the canonical `Maps/<NAME>/` folder, a provenance record, and a `Repack.md` with
target-specific commands. Apart from the explicit offline ZIP importer above, the editor does not bundle or
invoke Snowknife: it produces one portable map, while the separately licensed [Snowknife](../Snowknife/README.md) handles glTF, Unity,
and disc operations. The boundary is documented in the [export contract](docs/003-export-contract.md)
and [export preflight guide](docs/011-export-target.md).

Editor coordinates are metres, Y-up, and right-handed. Export converts to the original raw map space;
the exact transform and round-trip rules live in the [export contract](docs/003-export-contract.md).

## Documentation and source

- [Slopesmith documentation index](docs/README.md) — design, editing, scene systems, export, operation, and experiments.
- [Original-course authoring](docs/authoring/README.md) — vocabulary and the code-driven scored build loop.
- [Agent layer](docs/029-agent-layer.md) — inspect and drive the WebGL editor through real browser UI interactions.
- [`tools/`](tools/) — terrain studies, prop and texture recipes, conditioning, and offline generators.
- [Source layout](docs/024-source-layout.md) — module ownership and dependency boundaries.

Shared domain logic lives under `src/core/`; the browser under `src/app/`; the Node API under
`src/server/`. `scripts/` holds dev, build and ops entry points, `test/` the deterministic suite that
`npm run test:full` discovers, and `tools/` the offline authoring, analysis and diagnostic commands. Run
the complete repository gate from the parent folder with `npm run verify`; use `npm test` while editing for
the deliberately short, load-independent subset.

## Content and license

No game assets are included. Original authoring needs only this repository. Optional reference features
read local `Maps/` data generated from a user-supplied disc image; users must determine whether making and
using that image is permitted under applicable law and contractual terms. Those files and the workspace are
gitignored and must not be redistributed.

Every export records whether content is authored/procedural, user-supplied, retail-derived, or unknown.
`snowknife unity --public` accepts only a distributable authored path, fails closed on retail-derived or
unknown content, and requires an explicit rights confirmation for user-supplied files.

Slopesmith is independent and unofficial, and is not affiliated with or endorsed by Electronic Arts.
It is licensed under [Apache-2.0](LICENSE); see [NOTICE](NOTICE) for scope and attribution. The
[`quadwild-patches`](tools/retopology/quadwild-patches/README.md) subtree carries its own scoped licensing terms.
