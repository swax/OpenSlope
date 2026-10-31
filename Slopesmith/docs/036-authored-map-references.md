# 036 — Authored map exports as references

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

Native `Patches.json` must use bare texture-slot names when an authored map targets a retail ISO. A name such
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
whatever `classifyExportProvenance` found). They are separate questions because an authored mountain that
places a borrowed tree is both.

Reference, Texture Library, and Prop Library selectors use **Source → Game → Map**. Source separates
browser-local and server copies, including maps with the same ID. Reference combo changes prepare a pending
choice; **Load reference** applies it. The active reference stays loaded while choosing, and the clear
button removes it explicitly.

**File → Open mountain** also starts with a **Source** selector. It filters the saved mountain list to
Local or Server; **Open** loads the selected mountain and switches its workspace when needed.

The optional `Game` in
`Origin.json` is the stable source ID (`ssx-tricky`, `ssx-3`, `1080-avalanche`, etc.), independent of the
folder name. Snowknife and native imports write it. Older folders fall back to `Import.json.Game`, then
recognized course IDs; an unidentified folder appears under **Unknown**. Authored maps and the current
mountain's own assets appear under **Custom / Authored**, even when they borrow art from another game.
The catalogue APIs retain their `levels` lists and also return `maps` with each map's `game`.
Reference maps keep source-qualified identities. Props and textures use the content versions below.
Existing unqualified references retain their local-first resolution until their original assets can be pinned.
Legacy unprefixed bank names also try `TRICKY_<name>` when the requested bank is absent. This applies to
browser-local reads, server assets and exports, including props, textures, collision and sky rings. Exact
bank names take precedence; a missing file inside an existing bank never borrows from the prefixed bank.
Explicit Local/Server choices remain scoped to that source, and fingerprinted references still require an
identical bank version. Saved documents and checkpoints do not need a name-only rewrite.
Map labels prefer `Import.json.DisplayName`, recovered from the user's disc by the importer; `NameSource`
records which source table supplied it. This works independently of folder names. Browser scans retain
these titles with their saved ISO source, and cached imports retain them for offline menus. Legacy folders
without a title use the existing catalogue (for example **Tenderfoot Pass** for `AVALANCHE_CRS01_00`);
unknown slots keep their folder names. Dropdown values and saved reference-map selections use the original folder IDs.
See [source title extraction](../../Native/docs/course-titles.md) for the per-game readers and metadata-only refresh.

## Prop and texture versions

New library selections save an `asset1:<game>:<map>:<sha256>` bank identity instead of a Local/Server path.
The source selector records this browser's loading preference for that version. Loading tries the preferred
copy first, then another copy with the same game, canonical map and fingerprint. Different fingerprints
remain separate identities even when folder names match. Details show the preference and a short version.

The fingerprint covers the whole portable asset bank: textures, meshes, collision, prop definitions,
instances, materials, defaults, effects and non-music audio. JSON formatting and object-key order and OBJ
line endings are normalized. Display names, import reports, origin metadata, terrain, paths, baked export
companions, raw disc archives and music do not participate. This deliberately treats a changed bank as a
separate version, even if an individual texture inside it did not change. It works from the portable map
files for every supported game and does not require an ISO to remain open.

The shared workspace transport resolves versioned JSON and byte requests, including image previews, the
viewport, public play and browser exports. Server exports resolve matching installed banks first. Image
caches are partitioned by bank version, and new image bytes are checked against that version. Missing or
different copies cannot silently replace the saved version.

Older document pointers are upgraded when their original source is available to fingerprint. A missing
legacy Local/Server pointer stays unchanged: without its original content there is no safe version to infer.

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

Admins can use **Reference** on a loaded game map's row in the Library catalogue or a game's course list.
The toggle is pressed when that course is installed in the server reference library. Installed references remain manageable
without a local disc or loaded map. Clicking a pressed toggle asks for confirmation before removing the server
folder; the browser's map and disc are kept. Removal also clears that reference's public listing. Uploading a
reference does not publish it.

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
