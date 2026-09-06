# 035 — Local Projects

Slopesmith is local-first. The browser is the fast editing replica; one local Slopesmith service owns durable
files. A hosted WebRTC room can later relay edit transactions through the host, but it does not change where the
host's authoritative mountain is saved.

## Roots

Two folders make up the machine-local record — everything Slopesmith needs that lives outside its own tree.
**Settings → Server → Local storage** shows them as *Workspace folder* and *Maps folder*; the explanation for
each sits behind its `?` badge rather than in body copy, so the dialog stays a short list of fields.

These are the server's folders, not the browser's: one set of paths for everybody connected. On a server with
accounts (`038`) the section is therefore built only for an **admin**, and the rest of Settings — the member's
own fal.ai key (`033`) — is what an ordinary member sees. `/api/config` is `admin` in the route-access table
either way; hiding the fields only keeps the editor from offering what the server would refuse.

- `workspaceRoot` owns projects, ordinary user data, caches and logs. Its default is `<Slopesmith>/workspace`.
- `mapsRoot` is the map library the service reads extracted reference levels from. In the OpenSlope checkout
  its default is the sibling `Maps` — the folder every `snowknife` command, every doc and every generated
  `Repack.md` already names — and a standalone Slopesmith clone falls back to `<workspace>/maps`. Which one
  applies is decided by whether the checkout is there (a sibling `Snowknife/`), **not** by whether `Maps/`
  exists yet: keying off the library folder made the default depend on whether anything had been extracted
  when the server happened to start, so a server started before the first import quietly read a different
  library than the one the extraction landed in. The default root is created at startup for the same reason
  the workspace folders are — the library watcher only attaches to a root that exists, and one that appears
  later stays unwatched until a restart. A record written before the field was named `mapsRoot` is read under
  its former `referenceRoot` key, so an existing machine keeps its library.

Export is not one of these paths. The browser composes the map folder itself and writes it through a directory
the author picks from the Export dialog — pointed at that same library, an authored course lands beside the
retail ones and reloads as a reference (`036`). Nor is there a toolchain or disc-image record, because
Slopesmith runs no processes: an export writes a portable map folder plus the `snowknife` invocations that bake
it for Unity and turn it into a disc (`011`, `037`), and their arguments belong to those commands rather than
to a machine setting.

The bootstrap is `<Slopesmith>/.slopesmith/config.json`. It is deliberately outside the configurable workspace:
the app cannot discover a path by first reading a settings file inside that unknown path. Both folders are
gitignored. Each field has an environment override for machines and automation —
`SLOPESMITH_WORKSPACE_ROOT` and `SLOPESMITH_MAPS_ROOT` — and an overridden field is shown read-only, left out
of what Settings writes, and kept in the file exactly as it already reads, so a temporary variable is never
baked in by an unrelated Save.

Saving validates before it writes. Slopesmith's own folders may be created; a library it only reads must already
exist, so a typo cannot masquerade as an empty asset catalogue. Both roots are read once at startup, so changing
either asks for a restart that switches every server route and file watcher together.

## Project layout

```
workspace/
  session.json
  projects/
    MyMountain-12ab34cd/
      project.json
      mountain.slope.json
      assets/
        skies/ textures/ props/ music/ sounds/
      autosaves/
      build/
  library/
    characters/
  cache/
  logs/
```

`project.json` carries a stable UUID, display name, timestamps, document hash and monotonically increasing
revision. The folder's readable name is presentation only. `session.json` remembers the active UUID.

New mountains and imported mountain ZIPs create projects. The mountain picker reads the workspace catalogue and
activates an existing project. Switching mountains resets undo/redo because snapshots from two mountains must
never share a history stack.

## The open mountain is the URL

`slopesmith.example.com/MOUNTAIN01` is the map this tab has open (`app/state/map-url.ts`). It is a link worth
bookmarking, an address bar that says what is being worked on, and — the part `session.json` alone cannot give —
a deterministic load: the page opens the map its URL names rather than whichever one this tab last activated.
Opening it activates it too, so the plain address afterwards returns to the same mountain.

The name is the map's own, and `project.json` is the authority on it: a rename moves the URL with it, and the
address is blank while no project is open, so a browser-recovery document is never advertised as a map this
server holds. A name the server does not have is reported and ignored — a link to a renamed, deleted or
somebody else's mountain opens the editor rather than failing.

Two consequences. A map name shares the root namespace with the paths the host serves, so `api`, `assets`,
`characters`, `src` and `node_modules` are refused by the name prompt; nothing with a dot can collide, because
a map name is `safeDataName`. And reaching these addresses needs the SPA fallback the editor is already served
with — `try_files {path} /index.html` in `deploy/Caddyfile.example`, and Vite's own in development.

The URL is written with `replaceState`, so Back leaves the editor as it always has rather than swapping the
document out from under an author mid-edit.

## Portable mountain archives

**Export mountain** is a source transfer, not a map export. It flushes the open mountain, asks the project
service for that durable revision and the complete mountain-local asset catalogue, and downloads
`<NAME>-r<REVISION>-<UTC-TIMESTAMP>.slopesmith.zip`:

The revision is the source server's durable project revision. The compact UTC capture time (for example,
`20260809T123456Z`) keeps repeated exports sortable and distinguishable without relying on anyone's local timezone.

```
NAME/
  manifest.json
  mountain.slope.json
  assets/
    textures/ sounds/ music/ skies/ props/
```

The manifest identifies every asset by sha256, its original server-local name and its file in the archive.
Import checks the ZIP structure, sizes and CRCs; the project service checks each asset hash again before storing
anything. Existing names never overwrite: an asset may land under a free name and the imported document is
retargeted to that name before its new project is created.

The archive deliberately excludes the source server's UUID, sessions, server-wide rider avatars, build output and autosave ring. Import
therefore asks for a name and creates a fresh workspace mountain with a new identity. Duplicate mountain asks
for the copy's name too. A complete self-contained
mountain is quick to transfer because this path does not tessellate terrain, bake lighting, compose AI paths or
perform any other map-export work. **Duplicate mountain** is faster again because the server copies the source
project directly without sending those bytes through the browser. The `Maps/<NAME>/` artifact remains the separate
**Export map** operation.

A history checkpoint is stored internally as a gzipped `mountain.slope.json`, not as a portable archive. The
History panel's **Export as mountain…** action wraps that historical document in the same `.slopesmith.zip`
format at download time, names it `<NAME>-checkpoint-r<REVISION>-<UTC-TIMESTAMP>.slopesmith.zip`, and includes
the project's current mountain-local catalogue. If an old checkpoint names an
asset the server no longer has, the archive records the missing asset and the export warns before handoff.

## Save protocol

`GET /api/projects/current` opens the last active snapshot. With no project, the browser POSTs its existing
`localStorage` recovery document to `/api/projects`; this is a one-time, lossless migration for existing users.

Every realized edit still updates the viewport synchronously. After 450 ms of quiet, the browser PUTs a complete
document snapshot to `/api/projects/<id>/document` with its `baseRevision`. Full JSON is intentionally simple and
cheap over localhost. The server:

1. validates and migrates the document;
2. rejects a stale base with HTTP 409 and the current snapshot;
3. sets the previous mountain aside in `autosaves/` when a checkpoint is due (docs/040);
4. writes the new document through a same-directory temporary file and atomic rename;
5. advances the revision and document hash in the manifest;
6. acknowledges the durable revision.

Writes are serialized in the browser. An edit made during an in-flight request becomes the next snapshot.
Identical documents do not create revisions. Network failures retain the dirty replica, retry with bounded
backoff, and continue writing the browser recovery copy. A conflict blocks disk autosave rather than overwriting
an external edit.

**Every writer carries a base revision, including the ones that are not browsers.** A headless recipe
reads a project, works for some seconds, then saves against
the revision it OPENED — not against whatever the file holds by then — so a mountain that moved underneath it
refuses the write and says which revision it moved to. The live register room does the same with its periodic
snapshot and re-reads on a conflict, because a write from another process reaches the file and no in-process
listener; `watchProjectWrites` (docs/039) closes the gap by announcing outside writes as ordinary
revisions. What none of them do is take the current revision as their base immediately before writing — that
is not concurrency control, it is a clobber with a version number on it.

The browser recovery key remains `slopesmith-mountain-v1`, but it is no longer the primary project store.

## Reference and project assets

Reference data is resolved from `mapsRoot` and remains outside a project. A project can name a stable retail
resource such as a GARI model without copying extracted game data or an absolute path into its document.

The project-owned `assets/` directories are the authored side of the contract. Texture, prop, sound, music and
sky uploads read and write only beneath the mountain that is open in the calling tab. The UI presents that
catalogue under the open mountain's actual name; compact document refs such as `Custom/snow.png` remain a logical compatibility
name, not a path into `Maps/Custom`.

On first access, an existing project scans both its live document and retained checkpoints and copies the
legacy dependencies it actually names out of `Maps/Custom` and `Maps/Shared/Skies`. The source files are left
untouched for recovery, but active reads and writes use only the project copies. If a dependency was missing,
the migration records the hole and retries after the file is restored.

Rider avatars have different ownership: they are server-wide, live under `library/characters/`, and are not
included in a mountain archive. The first avatar-library access copies existing
`Maps/Custom/Characters/*.glb` files into that server-data folder without overwriting or deleting the source.

## Collaboration boundary

The project service owns persistence and revisions. In a future hosted session, the host browser is the WebRTC
gateway: it orders accepted peer transactions, applies them to its replica, persists the resulting revision
through this same API, and broadcasts the acknowledgement. Presence, cursors and selections are ephemeral and
never enter `mountain.slope.json`.
