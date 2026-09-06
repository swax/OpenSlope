# 037 — Export on the client, discs in Snowknife

Where the map folder is written, and who is allowed to know about a PS2 disc. The design in two lines:
**the editor writes one portable map folder, from the browser, against no particular target**, and
**the disc is built by `snowknife`, which is the only thing holding a target's slot table.** Slopesmith stops
spawning processes entirely.

`038` needs this: it puts the browser directly on the server with no local install, and its sharpest cost is
that every HTTP route is a file-write or process-exec surface. Both follow from export living on the server.

## Where it stands

Done, both halves. The editor emits one portable folder and holds nothing about a disc; `snowknife` resolves
textures through `Slopesmith.json`, conforms custom pages to the GS ladder, and reports a whole allocation
plan under `--dry-run` without writing an image. SSH allocation and encoding live in `snowknife`.

The folder is assembled in the browser. `buildExportFolder` (core) decides what a map folder contains and
never decides where a byte comes from: everything outside the document arrives through one `ExportProvider`,
which has a node implementation reading the extracted library off disk and a browser one reading the same
library over HTTP. `npm run smoke` composes through the node provider and bakes the result with a real
`snowknife gltf`, so the seam is proven headlessly rather than mocked.

The Slopesmith server resolves assets and stores projects. Every export writes `Repack.md` and a
`repack-many.json` stub naming itself, so both the glTF bake and disc build have complete invocations.

## One export form

The folder becomes target-agnostic. Every painted tile ships flattened and verbatim — `Textures/GARI_0012.png`
with `TexturePath: "GARI_0012.png"` — the portable representation Unity consumes.

`Slopesmith.json` carries, per `TexturePath`, the
`{level, name, staged}` it came from — written so an authored folder can be reopened as a reference (`036`).
That is exactly what a repacker needs to choose:

| Manifest says | `repack` does |
|---|---|
| `level` == the target slot being replaced | reuse that verbatim ssh page; install nothing |
| `level` is another retail map | install the staged PNG's donor page into a reusable slot, else append |
| `level` is `Custom` | encode the staged PNG (type 5, or type 2 under `--texture-type2`) |

`snowknife` holds the target's slot table, the reuse-before-append allocator, the encoder, and the measured
VRAM numbers. The target-aware dry run reports PS2 headroom for the disc being patched.

`repack-many` accepts `{Slot, LevelData, Export}` per level, so the export-to-slot mapping has a home
outside the editor, and one manifest can build several courses into one image.

The export dialog reports what is about the *map* — how many cells are painted, which tiles they use, how
many triangles each imported model bakes per placement — and nothing about a *disc*.

### Three things that look target-shaped and are not

The target had quietly become the answer to questions that were never about a disc, so each carries its own
source:

- **The sky ring and the particle donor are properties of the document.** `SkyboxDoc.ring` names the level
  whose ring geometry a custom sky was composed against, and it is kept once set — so changing tier or fill
  colour never re-cuts pages against different geometry. `ParticleVolume.donor` names the reference level a
  volume was lifted from. A volume built from scratch names no donor and takes the first extracted copy.
  Reading these off the export target instead would have silently swung every custom sky onto an arbitrary
  fallback ring the moment the target went.
- **Texture provenance is per page.** `Slopesmith.json` records the logical source and staged name for every
  external terrain page. Reference loading and repacking consume this explicit contract.
- **Tool discovery belongs to CLI checks.** Export runs without a configured toolchain path. Checks that assert
  against a real bake locate the binary through `scripts/snowknife-cli.ts`.

The PS2 native tile size has one consumer that is not about a disc either: the generated-texture store-size
menu offers it and asserts it. That is a generator invariant, so it carries its own `128` rather than
importing a constant from a disc.

## The dry run

`repack … --dry-run` runs the real pipeline up to the point of writing bytes and reports what it would do.
It reads the source ISO's bank, the target level, and the export folder; it produces no `out.iso`.

What it reports is the set the export dialog shows today, sourced from the allocator instead of a model of it:

- **Slots** — original slot count, how many are retained (referenced by kept materials and flipbooks, plus
  slot 0000), how many are reusable.
- **Pages to install**, in allocation order, each marked **reuse → slot N** (an overwrite of a page nothing
  retained references) or **append**, with its source ref and its shipped dimensions after the power-of-two
  snap.
- **Bytes** — retained original, reused-install, free space left in the reusable pool, appended, and the
  projected bank total against the original.
- **Custom-page aggregate** against the proven-clean budget, priced in the format actually selected, with the
  page list behind it. This is the VRAM bar, computed by the thing that installs the pages.
- **Paths and placement** — whether the authored mountain overlaps the target's footprint (reuses its
  `aip`/`sop`) or ships standalone, and how the six start slots resolve.
- **Sky** — donor bank lifted verbatim, or *N* pages re-encoded at *X* bytes.
- **Anything that will be dropped or fall back**, named: an unresolved ref, a missing staged PNG, a page past
  the append ceiling.

`--json` emits the same as a record, which is what makes it a **regression check**: the allocation plan can be
asserted in a test without building a four-gigabyte image, and the numbers in it are the same ones a human
reads. `repack-many --dry-run` runs every listed slot and reports them together, since the interesting failure
there is two courses contending for the same bank.

## Export in the browser

`buildLevelFiles` is fs-free by construction — patches, paths, splines, gems, effects, lights, the start-gate
OBJ, the procedural tiles and the baked lightmaps all come out of the document the browser owns. `encodePng`
is a hand-rolled writer, so the browser's runs on `Uint8Array` + `CompressionStream` where the server's runs
on `Buffer` + `node:zlib`. The remaining work is target-independent byte fetching.

The composition is **core plus an injected byte provider**, with a node implementation and a browser one —
not browser-only code. That is the difference between moving the export and forking it, and it is what keeps
`npm run smoke` running the real thing headless.

| Piece | Where the bytes come from |
|---|---|
| Prop OBJ bake | `/api/props`, which is the same `readModelGeometries` the server bakes from; the bake needs only `{positions, uvs, indices}` |
| Material combiner | `/api/props/materials` — every level's whole `Materials[]`, the same table the server reads, so a `usemtl` slot and an authored model's tile inherit the same raw `UnknownInt18` either way |
| Painted-tile + prop texture copies | The byte cache (`app/net/asset-bytes.ts`): a stored asset's name is its identity, so a URL is a permanent address and the PNG passes through **untouched** rather than being re-encoded from a decoded canvas |
| Sign-light boxes, rail tubes, gem crystals | Derived from the prop payloads plus `/api/props/native-art`, which names the level supplying the rail skin and the tier crystals |
| `Sounds/` | `/api/custom-sound` and `/api/effect-sound`, through the same cache |
| `Skybox/` ring | `/api/skybox/ring` answers the resolved ring level, its `Skybox/` shell, and the complete Snowknife-measured `Ring.json` contract (dimensions, slots, spans, UV radius, and page sizes); `/api/skybox/page` serves a shipped page verbatim. `composeSkybox` (core) then writes the same folder for both providers |

Files land through `showDirectoryPicker()` with the handle persisted in IndexedDB — pick `Maps/` once, write
`Maps/<NAME>/` on every later export. A store-only ZIP download is the fallback for browsers without it.
Because a picked directory has no path a browser may read, `Repack.md`'s commands are written relative to it.

### Music without ffmpeg

`Music/track.wav` ships PCM16, 36 kHz, stereo. In the browser `decodeAudioData` on an
`OfflineAudioContext(2, n, 36000)` resamples as it decodes and folds a mono source up to both sides, for
every container the browser can play; the server, which has no codecs of its own, decodes an uncompressed WAV
and resamples it linearly. Both end in one core PCM16 writer, so the container is written once. Against the
`ffmpeg -ac 2 -ar 36000 -c:a pcm_s16le`, the pure-JS path lands within a -73 dBFS residual on a
44.1 kHz source, frame count for frame count.

## Costs

- **Disc and glTF builds are CLI steps.** A browser cannot spawn `snowknife`. Each export writes the exact
  invocations and a `repack-many` stub naming that folder.
- **Firefox and Safari get ZIP only**, so the good path is Chromium-shaped. The export dialog says which one
  this browser is on rather than quietly downloading.
- **A headless export stages only uncompressed music.** Nothing on the server decodes an mp3 any more; the
  browser hands its sources to WebAudio, which is where an author's tracks are staged.
