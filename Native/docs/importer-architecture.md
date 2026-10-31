# Disc importer structure

Native's desktop/Android loaders and Slopesmith's WebAssembly worker use the same
C++ import pipeline and public `openslope/import.hpp` API. Game readers produce
the existing portable map contracts; renderers, collision and riding consume
those contracts independently of the source game.

Source title readers attach optional names to discovered courses and persist `Import.json.DisplayName`
after extraction. All platforms consume the same metadata; see [course titles](course-titles.md).

`ImportSession` retains the normalized reader and catalogue across maps. Converted music has a
versioned, content-identified cache shared by the game converters; see [import caching](import-cache.md).

## Source layout

All disc import implementation lives under [`src/import`](../src/import).

| Location | Responsibility |
| --- | --- |
| `loader.cpp`, `game_importer.hpp` | Registered game families, cancellation and a new output directory's lifetime. |
| `session.cpp`, `music_cache.cpp`, `hash.cpp` | Reusable disc sessions, bounded source reads and verified converted music. |
| `containers/` | Bounded disc input, RVZ, raw BIN sectors, ISO9660, GameCube FST, BIG/PAK archives and their compression. No game selection. |
| `shared.hpp`, `png.cpp`, `strings.hpp` | Checked binary reads, decoded images, PNG output and common name handling. |
| `avalanche/` | Avalanche identification, course catalogue, LVL/GEO/COL/MTL/LIG/TPL conversion and prop separation. |
| `madtrix/` | Mad Trix identity, manifest catalogue, curved terrain/sky, TEX1/PAL1 images and adapted starts. |
| `ssx/original/` | Original SSX course conversion. |
| `ssx/tricky/` | Tricky course conversion and its PBD admission checks. |
| `ssx/streamed/` | Shared SSX 3 / On Tour world streams, materials, audio and playtest adaptations. |
| `ssx/common/` | Formats and executable-profile recovery shared within the SSX family. SSH decoding stays here. |
| `ssx/importer.cpp`, `ssx/formats.hpp` | SSX-family discovery/dispatch and private format helper declarations. |
| `sources.cmake` | Explicit importer sources shared by every build target. |

Portable runtime code remains in `src/`. Existing source-sidecar compatibility
fallbacks explicitly include the SSX helper header when needed; ordinary binary
readers include only the shared utilities. There is no umbrella header that
pulls every game's private declarations into all readers.

## Adding a game

1. Create a folder under `src/import/<game>/` with an `importer.hpp` exporting
   a `GameImporter` and an implementation of its three callbacks: `accepts`,
   `courses`, and `extract`. Optional `titles` and `music` callbacks attach source names and plan
   reusable music resources. A related title may share a family folder when its
   on-disc formats actually overlap, as SSX 3 and On Tour do.
2. Make `accepts` a bounded identity/layout probe on a **logical disc**. A
   filesystem or compression wrapper alone does not identify the game. Return
   false for unrelated games; let corrupt data in a recognized layout fail
   explicitly. Once a game matches, errors propagate without trying another
   converter. Course names and format versions are validated by that family.
3. Enumerate courses without decoding their textures or full geometry. Keep
   discovery small enough for browser workers and seekable Android document
   inputs. Honor cancellation while walking course/member tables.
4. Convert into the new directory supplied to `extract`. The shared loader
   creates it, refuses existing destinations and removes it on failure or
   cancellation. Keep game-specific coordinate systems, materials, prop
   policies and source sidecars inside the game's folder. Validate the portable
   output using the existing runtime readers before returning.
5. Include the new family's `importer.hpp` and add its descriptor to the registry
   in `loader.cpp`. Add its translation units to `sources.cmake`. No platform
   loader or separate browser decoder is needed. A new container belongs in
   `containers/` only if it is independent of a game's course formats.
6. Add authored format fixtures under `Native/tests`, including catalogue,
   extraction, collision/spawn/reset, malformed input and cancellation cases.
   Rebuild the Slopesmith worker with `npm --prefix Slopesmith run build:iso-importer`
   and verify its scan/extract flow. Add the game's catalogue and availability
   metadata to Slopesmith when exposing it in `/isos`.

The family callbacks are a private compile-time interface, not a public plugin
ABI. The public C++ API, WebAssembly exports, course identifiers, map schemas
and browser cache format remain unchanged by this organization.

## Baked terrain colors

`Patches.json` may carry optional `LightColorPoints`: sixteen display-domain RGB
texture multipliers in the same Bernstein order as `Points`. Neutral is `[1,1,1]`.
Controls must be finite and within -16..16; evaluate the bicubic net before
clamping to 0..255/128, retaining signed fitted handles and overbright channels.
This optional portable extension lets any importer retain baked vertex lighting
without manufacturing SSX image lightmaps. Native and Slopesmith use it for textured
terrain; absent controls preserve the existing rendering path. `LightmapID: -1`
continues to mean no image lightmap. Unity/export consumers do not yet use this
optional color net.

## Validation

The existing importer tests exercise all six supported games through the public
API. `native_import_dispatch` additionally checks unsupported-game rejection,
generic GameCube browsing, cancellation/progress exceptions, failure cleanup
and protection of existing map directories. The discovery benchmark still
checks that an authored Tricky catalogue reads less than 32 KiB.

For changes confined to a game, start with its importer fixtures. Changes to
shared containers or dispatch also need the other families' import fixtures and
the rebuilt WebAssembly worker. Compare representative local disc imports with
the preceding loader when relocating existing format code; imported asset bytes
and riding behavior should stay unchanged.
