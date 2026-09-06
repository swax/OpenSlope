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

The intended production shape is deliberately small: a Linux VM, Apache (with Caddy as a supported
alternative) for HTTPS and static files, one Node.js API process, and persistent workspace storage. The
[production deployment guide](docs/041-production-deployment.md) is kept aligned with the running reference
host: Apache serves the browser build and proxies `/api`, systemd owns one loopback-only Node 24 service, and
immutable `/opt/slopesmith/releases/<commit>` directories are selected through an atomic
`/opt/slopesmith/current` link. Durable projects and maps stay under `/srv/slopesmith`, outside every
release. The repository includes Apache, Caddy, systemd, and environment examples under
[`deploy/`](deploy/). Run exactly one API process; live rooms are coordinated in process and are not designed
for load-balanced replicas.

Once the first administrator enrols, server management stays in the browser: invite members, assign roles,
limit who may edit each mountain, inspect connected users, and install a guarded revision from the update
repository configured by the host operator—including a fork—or restart the supervised service from
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

Jukebox playback is on by default and can be turned off per browser. **Users → Jukebox** joins the server-wide
video queue and plays through YouTube's official embedded player, which needs no setup. Public URLs, queue
order, play/pause, seeking, and playback time are synchronized so members watch together; volume and mute
remain local to each browser. Putting the movie onto authored course screens instead of the panel needs a
frame Three.js is allowed to sample, which YouTube's iframe does not provide; the
[Jukebox guide](docs/063-video-bridge.md) describes the optional local media server that covers that case.

## Editing workflow

Every mode edits or observes the same mountain document:

| Mode | Purpose | Details |
|---|---|---|
| Info | Inspect the mountain, references, and scene settings | [Design](docs/001-design.md) |
| Edit | Transform and restructure points, edges, patches, and Bézier controls | [Course model](docs/002-course-model.md), [topology surgery](docs/017-topology-surgery.md) |
| Sculpt | Raise, lower, smooth, and flatten the surface | [Sculpt mode](docs/004-sculpt-mode.md) |
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
npm run import:mod-map -- "C:\Mods\My Course.zip" "C:\discs\ssx-tricky-usa.iso" ALOHA MY_COURSE
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
