# Disc course titles

New imports store the source title in `Import.json.DisplayName` and its provenance in `NameSource`.
`Course` and the map directory remain canonical identifiers. Native desktop/wrist menus, the Quest launcher,
Slopesmith's reference and asset libraries, and browser ISO/public-map menus prefer that metadata. The
existing name catalogues remain compatibility fallbacks for older imports; new game titles are not added there.

New Tricky disc scans return `TRICKY_<slot>` IDs (for example, `TRICKY_GARI`), so automatic
browser, PC and Quest imports use `Maps/TRICKY_GARI` while displaying the source title `Garibaldi`.
Bare slots remain accepted for old saved references and caches. Existing folders are not renamed;
`refresh-names` preserves their IDs. The managed exporter defaults to the same prefixed folder when `mapDir`
is omitted, accepts bare or prefixed slots, and honors explicitly supplied destination paths.

## Map layout metadata

`Import.json.MapType` distinguishes `run`, `hub`, `connector`, `run-chain` and `full-mountain`.
SSX 3 imports also store a shared `WorldId` (`ssx-3:bam`), `ParentMap`, and `SourceSections`.
Individual connector maps record their endpoint map IDs in `Connects`. A named event is a `run` even
when its import includes its approach/exit connectors; `SourceSections` records those included pieces.
Peak bundles are `run-chain` maps. The full world is `full-mountain` where that selection is supported.
Other games' individual courses default to `run`.

All SSX 3 pieces retain the same source-world coordinates. Equal `WorldId` values identify that shared
space, while overlapping `SourceSections` reveal duplicated pieces when combining imports. The 17 named
events cover the event/connector areas; five hub sections are still needed for full peak coverage.
The ISO picker initially shows named runs. Its advanced checkbox reveals hubs, connectors and peak bundles;
explicitly required maps remain visible regardless of that filter. Existing loaded maps are not removed.

For example, Snow Jam records:

```json
{
  "Course": "SSX3_ARA1",
  "MapType": "run",
  "WorldId": "ssx-3:bam",
  "ParentMap": "SSX3_PEAK1",
  "SourceSections": ["A_ARA1", "ARA1", "ARA1_B"]
}
```

## Source readers

These readers were checked against the supplied USA images. They read bounded tables and strings rather
than executing source code. An absent or unsupported title table leaves the existing ID/fallback available.

| Game | Source and mapping |
| --- | --- |
| 1080° Avalanche | `GTEE01`, revision 0: the DOL menu table at virtual address `0x8018bef4` contains category/title pointer pairs. Row `family * 4 + layout` identifies each course. DOL section mappings resolve pointers to file bytes. All 25 supported layouts have source titles. |
| SSX / Tricky | ELF course descriptors hold an ordinal, title/menu-key pointers, length, alias and source file-stem pointer. Rows are 24 / 28 bytes; neighbouring ordinals and menu-key structure validate the match. Source stems join to discovered course IDs. |
| SSX 3 | ELF course/section descriptors hold a 32-byte title, 16-byte short name, 16-byte section ID and 16-byte world ID. Connectors combine their two source section titles. OpenSlope's three combined peak selections use generated `Peak N` labels, recorded as `openslope:peak-selection`, since they are not single retail sections. |
| SSX On Tour | `DATA/LOCALE/FEAMER.LOC`: `LOCH` identifies `LOCL`; `LOCT` maps case-sensitive EA string hashes to UTF-16 entries. `TRACK_NAME_<track>` supplies the title, while the village hub uses `TRACK_AREA_Village`. Day/night qualifiers come from `MAP_FreerideDay` / `MAP_FreerideNight`. The hash folds the high nibble with a 23-bit right shift. |
| Mad Trix | The manifest's `config.pak` contains `Text/strings.csv`. Column 0 is the source package key; column 1 is the USA English title. The CSV reader handles quoted commas, embedded newlines and doubled quotes. |

Native and WebAssembly share these readers. Source images, executable extracts and the local investigation
artifacts stay outside Git. Synthetic tests change the title strings to prove that stored names come from
the source table rather than a retail-name lookup, and reject pointers outside the executable's load map.

## Existing maps

Preview a metadata-only update against a matching disc, then apply it:

```powershell
./temp/native-core/Release/openslope_import.exe refresh-names "path/to/disc.iso" Maps --dry-run
./temp/native-core/Release/openslope_import.exe refresh-names "path/to/disc.iso" Maps
```

RVZ and supported BIN inputs use the same command. Only retail folders with a matching source course are
updated; authored exports are skipped. Other import fields and all geometry/assets remain intact. The first
update preserves `Import.names-backup.json` and publishes the new sidecar through a temporary file. Repeating
the command with the same names makes no changes. `names <disc>` prints the discovered IDs, titles and source
tables without importing course assets.
