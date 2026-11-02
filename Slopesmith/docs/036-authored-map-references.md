# 036 — Custom map exports as references

Slopesmith treats any folder under the configured Reference Maps root that contains `Patches.json` as a
reference terrain. That includes both retail maps extracted by Snowknife and map folders exported by
Slopesmith.

Both sources use one prop format: `Models.json`, `Instances.json`, `Meshes/*.obj`, and optional
`Collision/*.obj`. SlopeSmith writes those canonical tables directly from its structured bake. `Props.obj` and
`PropsCollision.obj` are world-space projections for inspection and tools that want a single OBJ; neither is an
input to the reference prop loader.

## Portable effect attachments

`Effects.json` remains the editable graph document. During export, SlopeSmith resolves stable prop attachments
and writes each compiled native slot index, collision-sound row, animation hierarchy, lighting record, and contact
setting onto the canonical model or instance that consumes it. The reference service reads the same
instance-to-effect join as Snowknife and Unity, keyed by the canonical instance index.

## Portable texture provenance

Native `Patches.json` must use bare texture-slot names when a custom map targets a retail ISO. A name such
as `0019.png` therefore cannot itself say that the pixels came from GARI. Exports write `Slopesmith.json`
beside `Patches.json` with:

- every externally sourced terrain texture's level and file name;
- the local staged file name when the export contains a self-contained copy; and
- the authored prop representation.

Absolute paths are never stored. A recipient resolves `GARI/0019.png` beneath their own configured Reference
Maps root.

Reference texture resolution prefers a staged file inside the authored export, then the logical source level.
Qualified patch paths such as `Custom/candy.png` and borrowed-map paths are preserved when a reference patch is
picked for painting. Failed browser image loads are remembered until reload so a missing page produces one 404
instead of being retried after every sibling texture completes.

## Which kind of folder this is

`Patches.json` is what makes a folder a reference; it says nothing about where the folder came from, and both
producers write one. `Origin.json` answers that separately, in two fields: `Origin` (`retail` from
`snowknife import`, `slopesmith` from Export) and `RetailData` (always set on an extract; on an export,
whatever `classifyExportProvenance` found). They are separate questions because a custom mountain that
places a borrowed tree is both.

Reference, Texture Library, and Prop Library selectors use **Source → Game → Map**. Source separates
browser-local and server copies, including maps with the same ID. Reference combo changes prepare a pending
choice; **Load reference** applies it. The active reference stays loaded while choosing, and the clear
button removes it explicitly.

Open saved mountains from the main library page. Its **Local** and **Server** filters narrow the map list;
**Edit** opens the selected mountain in its workspace. **New map** also starts on this page.

The optional `Game` in
`Origin.json` is the stable source ID (`ssx-tricky`, `ssx-3`, `1080-avalanche`, etc.), independent of the
folder name. Snowknife and native imports write it. Older folders fall back to `Import.json.Game`, then
recognized course IDs; an unidentified folder appears under **Unknown**. Custom maps and the current
mountain's own assets appear under **Custom**, even when they borrow art from another game.
The catalogue APIs retain their `levels` lists and also return `maps` with each map's `game`.
Reference maps keep source-qualified identities. Props and textures use the content versions below.
Existing unqualified references retain their local-first resolution until their original assets can be pinned.
Legacy unprefixed bank names also try `TRICKY_<name>` when the requested bank is absent. This applies to
browser-local reads, server assets and exports, including props, textures, collision and sky rings. Exact
bank names take precedence; a missing file inside an existing bank never borrows from the prefixed bank.
Explicit Local/Server choices remain scoped to that source, and bank-versioned references still require an
identical bank version. Saved documents and checkpoints do not need a name-only rewrite.
Map labels prefer `Import.json.DisplayName`, recovered from the user's disc by the importer; `NameSource`
records which source table supplied it. This works independently of folder names. Browser scans retain
these titles with their saved ISO source, and cached imports retain them for offline menus. Legacy folders
without a title use the existing catalogue (for example **Tenderfoot Pass** for `AVALANCHE_CRS01_00`);
unknown slots keep their folder names. Dropdown values and saved reference-map selections use the original folder IDs.
See [source title extraction](../../Native/docs/course-titles.md) for the per-game readers and metadata-only refresh.

## Prop and texture versions

The editor, public/private player and browser exports use a shared byte resolver. Immutable reads try
in-memory cache, the browser's persistent asset cache, local imported assets, then an allowed server.
Concurrent reads share work; failed reads are never retained. Memory is bounded, and blocked browser
storage or quota failures still allow ordinary loading. Persistent caches are separated by account and
public/device policy. Project-owned custom assets keep their existing project scope. Explicit Local/Server
references remain scoped to that source; an unavailable local request never becomes a server request.
Asset URL builders return logical identities. Read them with `clientFetch`, `workspaceFetch`, `assetBytes`
or the shared image loaders so local bytes and cache hits do not require an HTTP request.

Existing `asset1:<game>:<map>:<sha256>` references retain their exact whole-bank requirement. Local
candidates precede server candidates, and a candidate must match the full fingerprint. No failed lookup
silently substitutes a different bank. Bank fingerprints normalize JSON formatting, object-key order and
OBJ line endings; they exclude display/import metadata, terrain, paths, raw disc archives and music.
An unresolved `asset1` reference is never rewritten to a merely similar asset.

`GET /api/map-asset-manifest?level=<map>` describes independently versioned textures, props and native
physics bodies under `openslope-assets/v1`. It has the same viewer authorization as bank metadata; the
browser supplies equivalent manifests from local imports. Each entry carries an identity:

```text
asset2:<game>:<map>:<texture|prop|body>:<encoded-key>:<sha256>
```

A texture's key is its map-relative name under `Textures/`; its digest covers the exact bytes. A prop key
is its model ID. Its digest covers geometry, animation, collision, material settings and texture/flipbook
dependencies, including the raw model/material fields required by export. Other models, unused textures
and source placement transforms do not revise that prop. Body entries cover the decoded native shape and
mass properties. The resolver validates the selected entry and its returned texture/prop bytes, and scopes
prop responses to the requested model or body. Content-revision image URLs are checked against the returned
bytes as well. Location is never part of an `asset2` identity.

A texture-specific reference is the standalone `asset2` ID: its encoded key already names the image, so
no `/filename.png` suffix is written. Existing suffixed `asset2` texture references remain readable and
resolve to the same resource/cache key. `asset1` bank references and a prop's texture dependencies still
include a filename because their identities can contain multiple images. New picks and verified upgrades
emit the standalone form.

Writable mountains automatically upgrade exact original-bank references and verified current-asset matches
to `asset2` when opened or replaced by a shared document snapshot. This also runs in fully local workspaces and
saves through the normal project/folder flow. Missing, different and unverified candidates are left alone.
Checks in flight cannot overwrite newer reference/model choices or apply to another project or a read-only
preview. Existing `asset2` references are unchanged.

Admins can use **File → Review asset references…** to preview remaining references. Repeated references
are grouped. Available original banks are marked **Exact original available**. The preview hashes the
texture bytes currently resolved by the editor (reusing loaded images), or checks a prop/body definition
and all its texture/flipbook dependencies against the candidate manifest. Confirmed matches show
**Matches current asset** and are selected by default. This confirms the current resolved content, not the
historical original of a name-only reference. Different or unverified candidates are unchecked.
Unqualified references choose the available local asset
before the server copy, regardless of where the mountain is stored. Explicit Local/Server references stay
scoped to that source. Pinning a name-only reference records the currently available copy; it cannot verify
the historical original. If the original bank is gone, a matching game/course candidate is marked
**Replacement — original version unavailable** and is unchecked. Missing assets remain unchanged.
Cancel performs no writes. Apply updates only selected references, takes a history checkpoint where
supported, and rejects a preview if the document has changed. Suggested replacements require manual selection.

New borrowed texture selections (including palette drags and model texture picks) and individual prop picks
use `asset2` automatically. Prop picks derive their collision and effect defaults from the displayed source
bank before pinning the individual geometry; native physics donors are pinned separately. Sampled `asset1`
pointers retain their identities until the automatic check can verify an upgrade. Project-owned uploads and models
keep their live project references. Group, sky and audio references keep their existing bank/source formats;
native audio on individual props resolves through its source map's sound bank.
Individual texture, prop and body migration can be applied independently without
changing those references or repackaging the source maps. Snowknife exports continue staging the selected
asset bytes; both older bank references and migrated native body donors remain supported.

A folder with no `Origin.json` is read as retail. An export manifest still identifies its folder as authored,
and one written before the provenance guard existed is treated as carrying data rather than as clean — the
direction that describes an extract as an extract. The reader and its fallback are `readLevelOrigin` in
`server/routes/levels.ts`; what reads the answer is the `/api/levels` listing, which the Scene toolbox's
Reference picker shows as an **origin** row under the loaded mountain
([038](038-hosted-sessions.md#map-origin)).

`npm run backfill:origins -- --dry-run [roots…]` stamps a library that predates the contract. It asks
`readLevelOrigin` for the authored half, so it cannot disagree with the listing, and asks the folder itself
for the rest: `World.json` names the slot an extract came from, and `SSFLogic.json` / `ConfigTricky.ssx` prove a
BIG unpack happened without naming it. A folder offering neither is recorded as
`retail-unidentified-folder` — the same withheld outcome it already had, without inventing a course slot for
what is more likely an early authored export. Re-exporting the mountain replaces the guess with its real
answer. Existing records are kept unless `--force`.

## Reference folder requirements

Reference folders carry canonical prop tables and explicit per-page texture provenance. Retail folders get
those files from `snowknife import`; editable SlopeSmith projects get them from Export. Reference preview, Unity
setup, glTF bundling and PS2 repacking all consume this same contract.

## Uploading browser-extracted references

Each game-map row has a three-dot menu for **Unload** and, for admins, its server reference action.
**Upload as reference** uploads a locally loaded map. Once installed, that action becomes **Remove reference from server**
and asks for confirmation before removing the server folder. Installed references remain manageable without a local
disc or loaded map. The browser's map and disc are kept; removal also clears the reference's public listing.
Uploading a reference does not publish it. Active and queued uploads can be cancelled from the same menu.

The Library uses one list, merging disc, locally imported and server copies of each game course. Disc and server
icons show where it is available; **Load local** extracts a course for this browser. Admins also see unpublished
references and manage them on the same row.

The browser uploads the native importer's already extracted files, preserving filename case, import metadata and
any `Source/` sidecars. The ISO or ROM never leaves the device. Available music and intro audio are always
included, alongside other course audio. Current native importer limitations still apply.

New music uploads encode those folders' WAV clips as Ogg Opus at 128 kb/s in a dedicated worker, using the
same pinned portable codec as the native player. Cached local WAVs, gameplay sounds and `Source/` sidecars
remain unchanged. The server retains and serves the compressed bytes with `audio/ogg; codecs=opus`; it does
not expand them for playback. Existing WAV references continue working without migration.

`Audio/Music/encoding.json` records the `opus-128-v1` profile, source WAV hashes and compressed file sizes/hashes.
An admin-only `POST /music` lookup accepts `{hashes: [sourceSha256]}` before conversion and returns matching
encoded file records. Matching clips skip both encoding and uploading. If a donor disappears before transfer
negotiation, the client encodes its cached original and negotiates again. The index itself is validated against
the uploaded files, and reused bytes still pass the ordinary transfer hash checks.

Music graphs and intro manifests retain their original WAV identifiers; readers resolve an absent WAV to its
Opus sibling. Pre-skip and final Ogg granules trim encoder delay/padding, and the original sample rate/frame
count is retained for native playback. The native player and Quest folder cache accept the compressed clips.
This is lossy playback audio; no additional raw music copy is uploaded alongside it.

Reference uploads share one queue across the Library catalogue and game views. Each map shows queued/uploading
progress. Click a queued or uploading toggle to cancel that job; later jobs continue after
cleanup, including after a failed upload. Leaving the page cancels active and queued uploads.

Before transferring bytes, the browser offers sizes and SHA-256 hashes. The server checks ordinary files
throughout its configured Maps library (including Shared), verifies matches and copies them into staging.
Only missing content is uploaded; duplicate bytes within one reference are transferred once as well.
Names alone never establish a match. Reused files are independent copies, so deleting or editing the donor
does not change another reference. File hashes are cached with filesystem signatures, and copied bytes are
verified again. The progress message reports how many files were reused.

`/api/reference-maps` is admin-only, including status and cancellation; personal access keys cannot administer.
`GET /` lists installed references, `POST /uploads` starts a manifest (`course`, `music: true`, and ordered
`files: [{path, size, sha256}]`). New clients set `reuse: true` and receive `missing` (ordered manifest-file
indices), `reusedFiles` and `reusedBytes`. `PUT /uploads/{id}?offset={bytes}` sends contiguous binary slices of
only those missing files concatenated in response order. Without `reuse`, the original all-file protocol is
retained. Each slice is at most 8 MiB. `GET /uploads/{id}` reports the accepted
offset after a lost response; `POST /uploads/{id}/complete` validates and publishes, and `DELETE /uploads/{id}`
cancels. `DELETE /maps/{name}` removes an installed reference.

Deleting a reference keeps authored project documents but can break their external asset references.
Preserve banks used by custom maps, including the exact fingerprints in versioned pointers. For music
migrations, changing only `Audio/Music/` and `Audio/Intro/` preserves those fingerprints; replacing the
full bank requires checking its identity.

Uploads are limited to two active transfers, 30,000 files, 512 MiB per file and 4 GiB total. A hidden staging
folder prevents partial maps appearing in catalogues. Completion checks hashes, JSON, PNGs, terrain controls,
provenance and terrain/model asset dependencies before renaming the new folder into place. Existing courses,
including legacy Tricky aliases, are never overwritten. Cancelled and invalid transfers remove their staging;
idle transfers expire after 30 minutes. Old staging left by a process interruption is reclaimed on a later upload.
