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
