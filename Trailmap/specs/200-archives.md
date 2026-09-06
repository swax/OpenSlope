# 200 — Disc Layout, Archives, and Compression

Every on-disc format in Part 2 is reached through the containers this chapter
defines: the disc's directory tree, the **BIG** archive format (two variants),
and the **RefPack** compression scheme that wraps most archive members. A
loader that can walk the tree, open the two BIG variants, and decompress
RefPack can reach every file the rest of Part 2 specifies.

The baseline is the PS2 PAL disc (`002-conventions.md`). The texture banks the
archives contain are specified in `210-textures-ssh.md`; the level files in
`220-level-pbd.md` and `230-level-ssf.md`; models in `240-models-mpf.md`;
paths in `250-paths-aip-sop.md`; audio containers in `260-audio-files.md`; the
interactive-music files in `270-music-graph.md`.

## Disc layout

The disc is plain ISO9660 using only the primary (uppercase) volume
descriptor — there is no Joliet extension, and directory entries carry the
ISO `;1` version suffix, which must be stripped. The root holds the boot
configuration, the game executable, and a single `DATA\` directory; everything
the game loads lives under `DATA\`. [observed] [[200-iso]]()

> [[200-iso]]() ISO carries a primary (uppercase) volume descriptor, no Joliet;
> member names strip at `';'`; root listing measured on the real PAL ISO:
> SYSTEM.CNF (50 B), SLES_505.45 (2,933,092 B), DATA.

The `DATA\` tree, with what lives loose versus archived: [measured] [[200-tree]]()

| Directory | Contents |
|---|---|
| `DATA\MODELS\` | 12 level archives `<LEVEL>.BIG` (1.0–5.5 MB): ALASKA, ALOHA, ELYSIUM, GARI, MEGAPLE, MERQUER, MESA, PIPE, SNOW, SSXFE (front end), TRICK, UNTRACK |
| `DATA\AUDIO\` | per-level intro-music archives + shared `AUDIO.BIG` (SFX banks), `MUSIC.BIG`, `SPEECH.BIG`, `JUKEBOX.BIG` |
| `DATA\CHAR\` | character data archives: `ANM.BIG` (animations), `MDLPS2.BIG` (rider models), `BRDPS2.BIG` (the board model), `TEXPS2.BIG` (rider/board textures) |
| `DATA\TUTORIAL\` | 12 per-rider tutorial archives + loose `TRICKDEF.DAT` |
| `DATA\TEXTURES\` | ~115 **loose** texture banks (`CROWD.SSH`, `PARTICLE.SSH`, HUD/loading banks) + `PS2LOAD.BIG` |
| `DATA\CONFIG\` | loose config files (`AUDIO.INF`, `BANKS.INF`, `INTROMUS.INF`, `SPEECH.INF`, …) |
| `DATA\LANG\` | localization files (`BRITISH.LOC`, `FRENCH.LOC`, `GERMAN.LOC` on PAL) |
| `DATA\FONTS\` | font files (`.SFN`) |
| `DATA\CAMERA\` | per-level camera files (`.CML`) + `MODELIST.TUL` |
| `DATA\MODULES\` | IOP driver modules (`.IRX`, `IOPRP224.IMG`) |
| `DATA\VIDEO\` | movie streams + `TB\TB_<RIDER>.BIG` trick-book video archives |
| `DATA\ICON\` | memory-card icon |

> [[200-tree]]() full sweep of every DATA directory on the PAL ISO; archive
> variant per file via `GetBigType`,
> doc:../../Snowknife/SSX-Library/SSX-Library/BIG.cs.

The game builds archive paths and member names from format strings keyed by
course or rider name — e.g. the level archive as `data/models/<name>.big` and
members inside it as the course name plus an extension (`<name>.pbd`,
`<name>_L.ssh`). A loader should treat the naming as conventional, not
incidental: the course name is the join key between the archive, its members,
and the config files. [observed] [[200-engine-paths]]()

> [[200-engine-paths]]() PAL ELF format strings: `data/models/%s.big`
> @0x00389760, `data/tutorial/%s.big` @0x0031f158, `data/char/mdlps2.big`
> @0x003656c8, `data/audio/music.big` @0x00386cb0, `data/video/tb/tb_%s.big`
> @0x003b0a60; member composition `|data/models/%s%s` @0x003a8e28 with `.ssh`
> @0x003a8e40, `.pbd` @0x003a8dc8, `%s_L` @0x003a8e58. Engine bigfile classes
> (RTTI): cMemoryBigFile @0x003a54a0, cAsyncBigFile @0x003a54b8,
> ABigFileUnpack @0x003a5380 — the async streaming reader (vtable
> `0x003a5418`, 16 slots), its whole-into-RAM subclass (vtable `0x003a5390`,
> type-info `0x0023d510` links base = `cAsyncBigFile` via `0x002f9fe0`) and the
> unpack allocation tag; roles read from the code — `[[200-loader]]()`.

The speech subsystem is the one case where archive mounting is itself
config-driven: a config file names the archive to mount and a base path, and
the bank metadata (headers, the event table) lives *inside* that archive under
the configured base path. [observed] [[200-speech-mount]]()

> [[200-speech-mount]]() db:speech-events; `data/config/speech.inf`
> @0x003a1608, keys `BIGFILE` @0x003a1638 / `BASEPATH` @0x003a1640, then
> `%sheaders.big` @0x003a1650, `%seventdat\events.evt` @0x003a1660.

## The per-level file set

One level archive contains the complete level definition: textures, geometry,
lighting, logic, paths, and the audio-attachment table, all named by the
course stem. The Garibaldi archive is representative — 11 members, every one
RefPack-compressed: [measured] [[200-level-set]]()

| Member | Role | Specified in |
|---|---|---|
| `gari.ssh` | level texture bank | `210-textures-ssh.md` |
| `gari_L.ssh` | lightmap bank | `210-textures-ssh.md` |
| `gari_sky.ssh` | skybox texture bank | `210-textures-ssh.md` |
| `gari.pbd` | level geometry/database | `220-level-pbd.md` |
| `gari_sky.pbd` | skybox geometry | `220-level-pbd.md` |
| `gari.ltg` | world spatial grid (broad-phase index) | `160-lighting-data.md` (data model) |
| `gari.map` | text linker manifest (below) | this chapter |
| `gari.ssf` | object properties, logic, physics | `230-level-ssf.md` |
| `gari.aip` | AI/respawn paths | `250-paths-aip-sop.md` |
| `gari.sop` | course path data | `250-paths-aip-sop.md` |
| `gari.adl` | level audio attachment data | `190-audio-data.md`, `260-audio-files.md` |

> [[200-level-set]]() GARI.BIG holds 11 members under `data/models/`, stored <
> decompressed for all (e.g. gari.ssh 1,335,590 → 1,883,168; gari.pbd
> 1,596,162 → 4,098,656).

### The `.map` manifest

The `.map` member is **plain text**: a linker manifest listing, per asset
section, the name, UID, reference, and name-hash of every named asset the
level's binary files contain. It has 13 sections — MODELS, PARTICLE MODELS,
PATCHES, INTERNAL INSTANCES, PLAYER STARTS, PARTICLE INSTANCES, SPLINES,
LIGHTS, MATERIALS, CONTEXT BLOCKS, CAMERAS, TEXTURES, LIGHTMAPS — each row
fixed-width: name (82 characters), UID (10), reference (10), hash value (10).
[observed] [[200-map-manifest]]()

The hash is a string hash computed per character as `hash = (hash << 4) + c`;
then, with `high` = the hash's top four bits (bits 28–31, kept in place), if
any are set `hash = hash XOR (high >> 23)`, and in all cases those four bits
are cleared (`hash = hash AND NOT high`).
The same hash value joins the manifest row to hash fields in the binary level
files (`220-level-pbd.md`). [observed] [[200-map-hash]]()

> [[200-map-manifest]]() doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/MapHandler.cs
> `Load`, `ReadLinkerItems`; content starts at line index 23 in the community
> parser.

> [[200-map-hash]]() `bxStringHash` in
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/Tricky/MapHandler.cs.

## BIG archives

A BIG archive is a flat container: a header, a table of `(offset, size, path)`
entries, then member data at explicit absolute offsets. The disc uses exactly
two variants, distinguished by their first bytes: **C0FB** (compact, 24-bit
offsets) and **BIGF** (32-bit fields). Member paths are stored as
null-terminated ASCII; the path separator varies per archive (both `/` and
`\` occur), and names may be bare (no directory) — readers must accept all of
these. [measured] [[200-big-variants]]()

> [[200-big-variants]]() doc:../../Snowknife/SSX-Library/SSX-Library/BIG.cs `GetBigType`
> (detection order C0FB → "EB" → BIGF → BIG4); disc sweep: separators
> `data/models/...` (GARI.BIG) vs `data\tutorial\...` (BROD.BIG); bare names
> in the intro-music BIGs (`Garibaldi-A1`).

### C0FB variant

All multi-byte integers **big-endian**. [observed, header decode verified
byte-for-byte against a real archive] [[200-c0fb]]()

| Offset | Size | Field |
|---:|---:|---|
| 0 | 2 | magic, bytes `C0 FB` |
| 2 | 2 | header size — the bytes of the entry table **excluding the four bytes of magic and this field**; the entry table ends at `field + 4`, and member data follows at or after it |
| 4 | 2 | entry count — **not read by the engine**, whose walk is bounded by the header size |
| 6 | … | entry table |

Each entry is variable-length: a 24-bit offset (absolute, from the start of
the archive), a 24-bit stored size, and the null-terminated path. The 24-bit
fields give C0FB a hard 16 MiB limit on archive addressing; the 16-bit count
caps entries at 65,535. Entries whose offset is zero, or whose path contains
`*`, are placeholders and must be skipped by a tool — the engine itself has
no placeholder handling (a `*` entry simply never matches a real request).
[observed] [[200-c0fb-entries]]()

> [[200-c0fb]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/BIG/COFB.cs;
> measured on GARI.BIG: `C0 FB | 01 35 | 00 0B` → field 309, table ends at
> 313 = the byte after the last entry's NUL (the "+4" is the engine's:
> `Big_GetHeaderSize` `0x002ccee0` does `addiu s1,v0,4` on the C0FB branch
> only, and reads `+12` verbatim for BIGF); 11 entries; entry 0 offset 384,
> size 1,335,590 = gari.ssh stored size. Rule `field + 4 == byte after the
> last NUL` holds on all 44 PAL C0FB archives plus the local GARI.BIG /
> BRDPS2.BIG (`c0fb_check.py`: 0 mismatches). Neither variant's count field is
> read by the engine.

> [[200-c0fb-entries]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/BIG/COFB.cs `Extract` (offset==0 / `'*'` skip; RefPack
> sniff `data[0]==0x10 && data[1]==0xFB`). Engine lookup `Big_FindEntry`
> `0x002ccf98`: C0FB entries from `+6`, stride `6 + strlen + 1`; BIGF from
> `+16`, stride `8 + strlen + 1`; `strcasecmp` `0x002fde78` (ctype table
> `0x003bb821`, +32 folding); first match wins; index match when the name is
> NULL; writes `*offset/*size`; no placeholder test.

Member alignment is writer-defined and must not be assumed: archives on the
disc pad member starts to 128 bytes in some directories and to 8 bytes in
others; offsets are explicit, so readers need no alignment rule. [measured]
[[200-alignment]]()

> [[200-alignment]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/BIG/COFB.cs `Create`; GARI.BIG member starts at multiples of 128 (384,
> 1,336,064, …); BROD.BIG starts at 936/2336 (8-byte); the community writer always pads to 128 (`AlignBy(128)`).

### BIGF variant

Same shape with 32-bit fields, and a 4-byte ASCII magic. A sibling magic
`BIG4` selects an identical layout (not present on this disc). [observed]
[[200-bigf]]()

| Offset | Size | Field |
|---:|---:|---|
| 0 | 4 | magic, ASCII `BIGF` (or `BIG4`) |
| 4 | 4 | file-size field, big-endian: **header size + the sum of every member's stored size** — the length the archive would have with no inter-member alignment padding; never read by the engine, so readers may ignore it (below) |
| 8 | 4 | entry count (big-endian) — not read by the engine |
| 12 | 4 | header size (big-endian) — end of the entry table |
| 16 | … | entry table: per entry a 32-bit offset, 32-bit stored size (both big-endian), null-terminated path |

The file-size field is slightly *less* than the actual file length on every
real archive because it omits the padding the writer inserts to align member
starts: on every BIGF archive of both retail discs it equals the header size
plus the sum of the stored sizes exactly. Readers may rely on the entry table
alone; a fidelity writer emits that sum, big-endian. The engine's own loader
never reads the field (nor the entry count). [measured] [[200-bigf-filesize]]()

> [[200-bigf]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/BIG/BIGF4.cs;
> measured on the audio GARI.BIG: 17 entries, header size 364, entry 0 offset
> 384, size 140,072 = `Garibaldi-A1`.

> [[200-bigf-filesize]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/BIG/BIGF4.cs (`Extract` reads it LE — garbage, e.g. 2,288,392,704 for ALOHA — while `GetMembersInfo` skips it);
> `iso9660.py bigscan` over all 16 PAL BIGF archives: fileSize(BE) ==
> header_size + Σ sizes on 16/16 (audio GARI.BIG 364 + 2,311,220 = 2,311,584;
> AUDIO.BIG 5,286 + 13,665,532 = 13,670,818; MUSIC.BIG 1,988 + 451,435,076 =
> 451,437,064; TB_PSYM 2,086 + 29,560,832 = 29,562,918); NTSC-U 17/17; last
> entry's end == file length everywhere (no trailing pad). Engine:
> `Big_GetHeaderSize` `0x002ccee0` reads only `+12` for BIGF and
> `Big_FindEntry` `0x002ccf98` only the entry table — nothing reads `+4` or
> `+8`.

### Variant selection tracks the C0FB size limit

The packer's variant choice follows addressing range, not subsystem: within
one disc directory, trick-book video archives under **16 MiB (2²⁴ bytes)**
are C0FB while those above it are BIGF — the split is exact, in binary units
(two archives above 16 MB decimal but below 16 MiB are still C0FB). Audio
archives (which are large) are always BIGF; level, character, and tutorial
archives (small) are always C0FB. A writer targeting fidelity should apply
the same rule. [measured] [[200-variant-split]]()

> [[200-variant-split]]() doc:../../Snowknife/SSX-Library/SSX-Library/BIG.cs `GetBigType` measurement; all twelve trick-book
> archives (`bigscan-pal.txt`): TB_BROD 15,211,608 C0FB; TB_EDDI 16,812,112
> BIGF; TB_ELIS 15,690,272 C0FB; TB_JP 15,772,880 C0FB; TB_KAOR 15,871,752
> C0FB; TB_LUTH 16,597,768 C0FB; TB_MAC 14,478,008 C0FB; TB_MARI 15,929,848
> C0FB; TB_MOBY 16,845,464 BIGF; TB_PSYM 29,566,480 BIGF (60 entries,
> `Psym000..` and `Psym_0xx..` series, no placeholders); TB_SEEI 15,764,376
> C0FB; TB_ZOE 16,317,208 C0FB — nine C0FB, three BIGF, split exactly at
> 16,777,216; all members raw, 30 entries each except PSYM, starts
> 128-aligned.

### Member compression is sniffed, not flagged

No BIG variant carries a per-entry compression flag. A member is
RefPack-compressed if and only if its first two bytes are a RefPack header
(second byte 0xFB — in practice the pair `10 FB` for everything on this
disc); otherwise it is stored raw. Level, character, and tutorial members are
all RefPack-compressed; audio archive members (stream/bank/music files) are
all stored raw. [measured] [[200-sniff]]()

> [[200-sniff]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/BIG/COFB.cs + doc:../../Snowknife/SSX-Library/SSX-Library/Internal/BIG/BIGF4.cs `Extract` sniff; measured: all 11 GARI.BIG
> members compressed; audio GARI.BIG member 0 begins `53 43 48 6C` ("SCHl") —
> raw. Engine sniff in `AsyncBigFile_Unpack` `0x0023c8b8`: byte 1 must be
> 0xFB and byte 0 with its low bit masked must be a known codec id
> (`Codex_DecompressDispatch` `0x002c3fb8`); otherwise the raw block is
> copied verbatim.

## How the engine reads an archive

The engine mounts an archive by reading its first 2,704 bytes, classifying
the magic (two big-endian bytes `C0FB` → the compact variant; else four
bytes `BIGF` → the 32-bit variant; anything else, `BIG4` included, is
rejected), computing the table end from the header-size field and, if the
table is longer than that first read, allocating and reading the whole
table, which stays resident for the life of the mount. Member lookup is a
**linear walk** of the table comparing the requested path
**case-insensitively** with each stored path; the first match wins; there is
no name hash and no placeholder handling. Only offset, size and path are
used — the count fields are never read. [measured] [[200-loader]]()

Member requests go through an asynchronous big-file object with a global
table of 100 request slots. Paths are normalised with a leading `|` (the
mounted-archive namespace — the same prefix the level-file name templates
carry), de-duplicated (a repeat request bumps the slot's use count), handed
to the file system, which finds the entry in the mounted archives and reads
exactly the stored `[offset, size]` range, and completed by callback. The
unpack step then sniffs the raw member (above): a compressed member is
decompressed into a fresh allocation of the declared size and the raw block
freed; anything else is copied verbatim. A memory-resident subclass holds a
whole archive in RAM and scans its in-memory table with the same lookup —
the speech-headers archive uses that path. [measured] [[200-loader]]()

> [[200-loader]]() `Big_GetType` `0x002cce60` (BE u16 `0xC0FB` → 1, BE u32
> `BIGF` → 2, else 0); `Big_GetHeaderSize` `0x002ccee0`; `Big_FindEntry`
> `0x002ccf98`; mount read `0x002c9700–0x002c9820` (2,704-byte first read,
> grows to the header size); member open `0x002cc7a0–0x002cc800` (mount-list
> walk → `Big_FindEntry` → handle `{mount, size, offset}`); `cAsyncBigFile`
> vtable `0x003a5418` (16 slots, 8-byte GCC-2.9x entries, slot 0 =
> `__tf13cAsyncBigFile` `0x0023d5a8`, descriptor `0x003bcf50`);
> `cMemoryBigFile` vtable `0x003a5390`; ctor `0x0023c230`, dtor `0x0023c2b0`,
> table clear `0x0023c348` (memset `0x00344c58`, 9,200 = 100 × 92-byte slots:
> owner, callback + argument, state 0 free / 1 queued / 2 reading / 3
> complete, raw pointer, unpacked pointer, 52-character path, use count),
> `AsyncBigFile_Request` `0x0023c730` (prefix via `0x0023c6b0` from `0x003a5378`
> "|", dedupe `strcmp` on `+0x24`, refcount `+0x58`), `Pump` `0x0023c5a8`
> (1 → 2, `0x0023c530` → fs open `0x002c6ff8` with completion `0x0023c3d0`),
> `OnReadComplete` `0x0023c438` (2 → 3, data at `+0x1c`), `IsReady`
> `0x0023c890`, `Unpack` `0x0023c8b8` (size `0x002c4368` → alloc `0x0023d8d0`
> arena when the caller sets flag bit 30, else heap `0x002ce148` tagged
> `0x003a5380` with an allocation-tag string, optional `0xDEADC0ED` pre-fill →
> `Codex_Decompress` `0x002c4168` → free `0x002ce198`); speech in-RAM scan
> calls `Big_FindEntry` from `0x002284d4`. map:"BIG archives and RefPack in
> the executable".

## RefPack compression

RefPack is a byte-oriented LZ77 family codec. The compressed stream is a
header followed by a command stream; commands interleave literal copies (from
the stream) with back-reference copies (from already-written output). [observed]

### Header

The two-byte header is a general EA multi-codec header, of which RefPack is
one codec. Byte 1 is the signature `0xFB`. In byte 0, bit 0x80 ("long size")
widens the size fields from 24-bit to 32-bit; bit 0x01 is masked off before
codec identification and means one extra size-width field is present; and
the remaining bits (0x7E) are the **codec identifier** — 0x10 identifies
RefPack, so the everyday header `10 FB` is "RefPack, 24-bit size, one size
field". The engine's dispatcher also recognises three other codec families
(identifiers 0x18/0x1A/0x1C, 0x30/0x32/0x34 and 0x46, each also in a 0x80
variant, plus an optional externally registered 0x1E); anything else is
treated as not compressed. None of those occur on the disc. Bit 0x01 is
never set on the baseline disc either (every compressed member starts
`10 FB`); the engine's own two readers disagree on which of the two fields is
then the decompressed size (the core decoder skips a *preceding* field, the
size helper takes the *first*), so its field order is unsettled and a writer
must not set it. After flags + signature comes the decompressed size,
big-endian. [measured] [[200-refpack-header]]()

> [[200-refpack-header]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/Refpack.cs
> `Decompress` head; verified on gari.ssh: its RefPack header (flags 0x10,
> magic 0xFB, 24-bit size) decodes to 1,883,168 = the extracted size exactly. Engine: `Codex_DecompressDispatch`
> `0x002c3fb8` (`lbu 1(a0)` == 0xFB; `andi a2,v0,0xFE`; 0x10/0x90 →
> `RefPack_Decode` `0x002c4388`; 0x18/1A/1C/98/9A/9C → `0x002c3ef0`; 0x1E/9E →
> gp-relative plugin pointer; 0x30/32/34/B0/B2/B4 → `0x002c4908`; 0x46/C6 →
> `0x002c4718`); `Codex_GetDecompressedSize` `0x002c4188` (same switch, 3/4 BE
> bytes after the header, ignores 0x01); core header parse
> `0x002c4394–0x002c4430` (`andi 0x8000` = bit 0x80 → 4-byte fields; `andi
> 0x0100` = bit 0x01 → `movn` skips 4/3 bytes before the size read). Callers:
> `AsyncBigFile_Unpack`, GS upload paths `0x001c42f0/0x001c4460/0x001c45b4`,
> shape-chunk preparer `0x002c34f0`. map:"BIG archives and RefPack in the
> executable".

### Command stream

Let `b0` be the first byte of a command, `b1`–`b3` the following bytes. In
commands 1–3, the literal bytes (if any) are copied from the input first,
then the back-reference is copied. Back-reference distance counts back from
the current end of output; because copies are byte-sequential, a distance
shorter than the length is legal and repeats recent output (run-length
behavior). Decompression ends at a stop command. The engine's decoder
terminates **only** on a stop command — never on reaching the declared size
— and has no bounds checks, so a writer must always emit one (the community
decoder additionally stops at the declared size, which is why a stream
without a stop still round-trips offline). [measured] [[200-refpack-commands]]()

| # | `b0` range | Form | Literal count | Match distance | Match length |
|---:|---|---|---|---|---|
| 1 | 0x00–0x7F | 2 bytes | `b0 AND 3` (0–3) | `((b0 AND 0x60) << 3) + b1 + 1` (1–1024) | `((b0 AND 0x1C) >> 2) + 3` (3–10) |
| 2 | 0x80–0xBF | 3 bytes | `b1 >> 6` (0–3) | `((b1 AND 0x3F) << 8) + b2 + 1` (1–16384) | `(b0 AND 0x3F) + 4` (4–67) |
| 3 | 0xC0–0xDF | 4 bytes | `b0 AND 3` (0–3) | `((b0 AND 0x10) << 12) + (b1 << 8) + b2 + 1` (1–131072) | `((b0 AND 0x0C) << 6) + b3 + 5` (5–1028) |
| 4 | 0xE0–0xFB | 1 byte | `(b0 AND 0x1F) × 4 + 4` (4–112, multiples of 4) | — | — |
| 5 | 0xFC–0xFF | 1 byte (stop) | `b0 AND 3` (0–3) | — | — |

> [[200-refpack-commands]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/Refpack.cs `Decompress` /
> `CopyLiteralAndMatch`; the compressor emits the smallest form that fits
> (2-byte for length ≤ 10 and distance ≤ 1023, 3-byte for length ≤ 67 and
> distance ≤ 16383, else 4-byte) and appends a 0xFC stop when needed. Engine
> `RefPack_Decode` `0x002c4388` matches the table exactly: `andi 0x80` at
> `0x002c4444`; 2-byte `0x002c4450–0x002c44d4` (`andi 3`, `andi 0x1c`, `andi
> 0x60` << 3, `nor`); 3-byte `0x002c44dc–0x002c456c` (`srl 6`, `andi 0x3f` +
> 4, `(b1 & 0x3f) << 8`); 4-byte `0x002c4574–0x002c461c` (`andi 0x10` << 16,
> `andi 0x0c` << 6, + b3 + 5); literal run `0x002c4624` (`(b0 & 0x1f)·4 + 4 <
> 113`); stop `0x002c466c`; no declared-size exit.

A writer note: inputs shorter than 16 bytes are conventionally stored
uncompressed (no RefPack wrapper) rather than compressed. [observed]
[[200-refpack-writer]]()

> [[200-refpack-writer]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/Refpack.cs `Compress` (size guard; `10 FB` + u24
> for inputs ≤ 16,777,215 bytes, `90 FB` + u32 above).

## Later-title container variants (not on this disc)

Two further formats exist in the same family and appear in later titles but
nowhere on the baseline disc: a third BIG variant with a 2-byte `EB` magic
(hash-indexed entry table), and a chunked-DEFLATE member compression scheme
with an 8-byte ASCII `chunkzip` magic (fixed-size blocks, each a raw DEFLATE
stream). A baseline loader does not need either; they matter only to tools
that aim to cover sequels. [observed] [[200-later-variants]]()

> [[200-later-variants]]() doc:../../Snowknife/SSX-Library/SSX-Library/Internal/BIG/NewBig.cs,
> doc:../../Snowknife/SSX-Library/SSX-Library/Internal/BIG/ChunkZip.cs; full-disc sweep
> found neither magic.

<!-- DIRTY
Open questions (derivations: elf-map "BIG archives and RefPack in the
executable"):
- RefPack 0x01 field order: the core decoder (0x002c4388) skips a PRECEDING
  field while the size helper (0x002c4188) and the community decoder assume
  decompressed-size-first. Never exercised on disc; decisive = an EA
  title/tool emitting 0x11FB/0x91FB, or the EA codex reference.
- Names/algorithms of codec families 0x18/0x1A/0x1C (0x002c3ef0),
  0x30/0x32/0x34 (0x002c4908), 0x46 (0x002c4718); unused on disc.
- gari.adl role inferred from extension + ADLHandler only (chapter 260 territory).
DIRTY -->
