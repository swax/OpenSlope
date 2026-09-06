# Analysis Tooling — `ssx_analyze.py` Command Cookbook

How to extract files from the disc and drive the ELF/SQLite analysis helper.
This is the reference companion to [`../README.md`](../README.md); the findings
those commands produced live in `elf-map.md` and
[`extracted-data.md`](extracted-data.md).

Commands below run from the repository root and assume `python` and, optionally,
`sqlite3` are on `PATH`.

`snowknife`, the extractor under `../../Snowknife/`, performs the extraction step
below. Only that step needs it: any other tool that can pull a named file out of
a PS2 disc image and out of the game's `BIG` archives will do as well, as long as
the boot ELF and configs land under `extracted/` with the names used here.
Everything after that step is self-contained.

## Extract the PAL boot ELF and config files

```powershell
snowknife iso-extract ssx-tricky.iso SLES_505.45 extracted\SLES_505.45
snowknife iso-extract ssx-tricky.iso DATA\CONFIG\SNOW.INF extracted\SNOW.INF
snowknife iso-extract ssx-tricky.iso DATA\CONFIG\BANKS.INF extracted\BANKS.INF
snowknife iso-extract ssx-tricky.iso DATA\CONFIG\BTNMAP0.DAT extracted\BTNMAP0.DAT
snowknife iso-extract ssx-tricky.iso DATA\CONFIG\BTNMAP1.DAT extracted\BTNMAP1.DAT
```

The repository records only the interoperability conclusions needed by the
specification, not complete copies of these retail configuration sections. To
inspect the full control and bank mappings locally after extraction:

```powershell
Get-Content extracted\BTNMAP0.DAT, extracted\BTNMAP1.DAT
Get-Content extracted\BANKS.INF
```

## Inspect the ELF

```powershell
python -B tools\analysis\ssx_analyze.py elf
python -B tools\analysis\ssx_analyze.py strings cGroundMotion cAirMotion cBoarder data/config/snow.inf
python -B tools\analysis\ssx_analyze.py scan-ptrs --near cGroundMotion cAirMotion BoardSpray
python -B tools\analysis\ssx_analyze.py disasm 0x00132650 --count 120 --labels
```

## Disassemble VU1 microcode — `vu_disasm.py`

`ssx_analyze.py` decodes EE MIPS only. The PS2 **VU1 microprograms** (the
`.vutext` section) need the companion disassembler. It parses the DVP overlay
table into 9 VU programs and decodes the paired upper(FMAC)/lower(LSU/int/branch)
instructions (lower-word-first; VU1 ISA encodings under Sony's mnemonics; resolved
branch targets + I-bit floats).

```powershell
python tools\analysis\vu_disasm.py overlays                 # 9 programs / 42 overlays inventory
python tools\analysis\vu_disasm.py disasm 5 --count 900     # e.g. program 5 = the object-mesh transform/clip/raster
```

The object-mesh draw runs VU program **5** (selected by render-descriptor `+0x10`
via `VuRender_UploadProgram` `0x1c6180`); the terrain Bézier tessellator and
particle/transform programs are the others.

## Use the sidecar SQLite database

```powershell
python -B tools\analysis\ssx_analyze.py init-db
python -B tools\analysis\ssx_analyze.py seed-known
python -B tools\analysis\ssx_analyze.py import-strings
python -B tools\analysis\ssx_analyze.py import-functions
python -B tools\analysis\ssx_analyze.py import-xrefs
python -B tools\analysis\ssx_analyze.py label 0x00132650 BoardSpray_SurfaceTypeDispatch --kind function --confidence high --note "SurfaceType switch for BoardSpray; not core physics."
python -B tools\analysis\ssx_analyze.py note 0x00132650 "Cases use SurfaceType from the boarder/cache state."
python -B tools\analysis\ssx_analyze.py labels board
python -B tools\analysis\ssx_analyze.py func BoarderHandler_RegisterTypeInfo --limit 80
python -B tools\analysis\ssx_analyze.py refs EffectName_Boost --limit 20
python -B tools\analysis\ssx_analyze.py disasm BoostNode_ConstructFromEffectPayload --count 72 --labels
python -B tools\analysis\ssx_analyze.py cfg Boarder_UpdateGroundContactFromWorld --max-blocks 40
python -B tools\analysis\ssx_analyze.py field-refs 0x290 0x2a0 0x2d0 --base s1 s2 --op lw sw ldc2 sdc2 --limit 80
python -B tools\analysis\ssx_analyze.py surface-table --format csv
python -B tools\analysis\ssx_analyze.py surface-table --all --format csv
python -B tools\analysis\ssx_analyze.py surface-record-refs --tail --limit 120
python -B tools\analysis\ssx_analyze.py labels Jump
python -B tools\analysis\ssx_analyze.py labels Antic
python -B tools\analysis\ssx_analyze.py func JumpLaunch_ChargeScalarAndVelocity
python -B tools\analysis\ssx_analyze.py labels SnowAudio
```

`disasm`, `words`, `cfg`, `xrefs`, `refs`, and `func` can resolve DB labels, so
labels work as bookmarks. `cfg` prints basic blocks, branch successors, call
sites, and MIPS delay-slot-aware terminators. `field-refs` scans memory
instructions by object offset, which is useful for chasing boarder/cache fields
such as `+0x290` SurfaceType and likely contact vectors at `+0x2a0`/`+0x2d0`.
`surface-table` emulates the code-authored SnowCache initializer and dumps the
real 20-record per-`SurfaceType` material table as Markdown, CSV, or JSON.
`surface-record-refs` follows the `SurfaceType * 100` material-record pattern
through imported function ranges, which is useful for distinguishing motion
fields from BoardSpray/trail feedback fields.

## Fix-ups and maintenance

If the prologue scan starts a function a few bytes late, add a manual boundary
and optionally fold the nearby auto row:

```powershell
python -B tools\analysis\ssx_analyze.py mark-function 0x00211130 SnowAudio_LoadConfig --note "Manual boundary: function starts with setup before the stack prologue scanner hit."
```

Remove stale exact comments or observations with `forget`:

```powershell
python -B tools\analysis\ssx_analyze.py forget comments "old exact comment text"
```

The helper uses `PRAGMA journal_mode=OFF` because this Windows workspace allows
the database file but can reject SQLite rollback-journal cleanup. Use the helper
for DB writes and schema inspection:

```powershell
python -B tools\analysis\ssx_analyze.py schema --init
```

Use `sqlite3.exe` for read-only ad hoc queries when needed.

```powershell
sqlite3 analysis.sqlite ".tables"
```

## Record played rider telemetry over PINE

`tools/instrumentation/rider_telemetry.py` records the local human once per SSX game frame,
including exact raw motion/contact/state words, decoded fields, controller
input, and user markers. It is intended for ordinary full-course play rather
than scripted test execution. See [`rider-telemetry.md`](rider-telemetry.md)
for the safe prepare/capture/restore workflow and trace schema.

## Inspect board assets

```powershell
snowknife iso-extract ssx-tricky.iso DATA\CHAR\BRDPS2.BIG extracted\BRDPS2.BIG
snowknife big-ls extracted\BRDPS2.BIG
snowknife big-extract extracted\BRDPS2.BIG extracted\BRDPS2
```
