# 442 — Per-course sky colour

SSX Tricky stores one flat zenith colour for each course in the boot executable. The renderer uses it behind
the open top of the textured sky ring. `snowknife skycolor` and the ISO repack pipeline override those values
per course while retaining the stock load and render path.

## Retail data and load path

The executable carries a table of **13 per-course world-configuration records**, one per course slot, built
from code immediates rather than loaded from any level file. Each record holds that course's sky colour as
three **integer channels — red, green, blue, each 0…255** — in three consecutive 32-bit fields. [[442-load]]()

The load path is: the current course index (clamped to 0…12) selects a record; the loader converts the three
integers to floats, divides them by 255, and keeps the result as the course runtime's sky-colour vector; on
load completion that vector is handed to the graphics manager through a virtual call, which rounds the
channels back to bytes, packs them into a single `R | G<<8 | B<<16` word, and stores it as the frame clear
colour. Nothing per-level ever overrides it. [[442-load]]()

The renderer rebuilds a **full-screen, untextured sprite** from that word every frame, drawn with the depth
test forced to always pass, so the colour fills everything the world does not cover — in particular the open
top of the sky ring (`400-rendering.md`). [[442-load]]()

> [[442-load]]() @0x002582f0 (record table init, stride 0x94); @0x0017e680
> (`CourseRuntime_InitAndLoad`, course index at 0x0032F088); RGB integer fields
> `WorldConf+0x48`/`+0x4C`/`+0x50`; normalization 0x0017E6C4..0x0017E70C → runtime floats
> `courseRuntime+0x5C`/`+0x60`/`+0x64`; load completion @0x00180dc0 → graphics virtual, PAL target
> @0x001e9318 → packed word at `cPS2GraphicsMan+0x1724` = `graphics+0x2064` from the outer singleton.

## Course slots and local recovery

The 13 slot identifiers, in index order, are `GARI`, `SNOW`, `ELYSIUM`, `MESA`,
`MERQUER`, `ALOHA`, `PIPE`, `UNTRACK`, `MEGAPLE`, `BIGAIR`, `TRICK`, `ALASKA`
and `UNKNOWN12`. The identifiers and order are part of the interface; the retail
RGB choices are not. This specification therefore does not reproduce the colour
selection as a table. A tool that needs the original values can recover all 13
records from the user's executable with the initializer recipe under
**Executable override** and reject the result unless its manifest digest matches.
An authored course can instead supply its own colour explicitly or derive a
seam-matching default from the top edge of its sky panorama. [[442-load]]()

## The rest of the record

The sky colour is **three of the record's 148 bytes**. The other 145 are per-course
configuration nobody has needed yet, and reading all 13 records out of a live session shows
their shape: roughly three dozen 4-byte fields, of which two more are **integer triples in the
same 0…255 range and the same three-consecutive-fields layout as the sky** — so two further
colours, unidentified [inferred] — plus a handful of floats in the tens of thousands of engine
units, i.e. **hundreds of metres**, which is the scale of a draw or fade distance [inferred].
A few fields are identical across all 13 courses and so carry no per-course meaning at all.
Only the sky triple is normalized by the loader; the others are read where they are used.
[[442-record-map]]()

**Nine of those fields belong to the course's sun and its glare** (`400-rendering.md`, the
celestial-glare section): an enable flag, both of the previously unidentified integer triples —
a **fan/core** colour and a **corona/rim** colour — each triple's adjacent **intensity** float,
the sun's **radius** and its **placement distance** (two of the hundreds-of-metres floats), and
its **azimuth** and **elevation** in degrees. [[442-sun-fields]]()

**Several courses share a record.** ALASKA's is largely a copy of MEGAPLE's — four of the
distinctive fields are bit-identical — while keeping its own sky; and BIGAIR, TRICK and the
unnamed twelfth slot copy GARI's. So a field that looks authored per course may simply be
inherited, and any future use of this record should check whether a course's value is its own
before trusting it. [measured] [[442-record-map]]()

> [[442-record-map]]() db:race @0x0017e6a8 @0x002582f0 — record selection and the ×148 stride in
> `CourseRuntime_InitAndLoad`; table base at courseRuntime+0x28, selected record at +0x2c, and
> courseRuntime itself at GlobalGameStatePtr(0x00338e58)+0x730. Read live from an EE dump of a
> MEGAPLE session: the course index reads 8 and the selected record is exactly base + 8×148;
> its colour fields also match the record recovered independently from the initializer, giving
> three confirmations of the chain without publishing the retail channel selection. The
> initializer sub_002582f0 is ~1180 instructions
> with **zero calls**, caching field pointers fp+0x04…fp+0x90 and advancing each by 148 per
> course, which is what makes the table code immediates rather than file data. Unidentified
> triples at +0x04 and +0x18; flag at +0x54; distance-scale floats at +0x14, +0x30, +0x5c,
> +0x60, +0x64, +0x6c, +0x74; constant across all courses at +0x58, +0x68, +0x70.

> [[442-sun-fields]]() db:light-flares; doc:../research/sun-godrays.md — the
> celestial-glare build/draw path reads exactly `+0x00` (enable), `+0x04`/`+0x08`/`+0x0c`
> (fan/core RGB), `+0x14` (corona radius), `+0x18`/`+0x1c`/`+0x20` (corona/rim RGB), `+0x28`
> (azimuth°), `+0x2c` (elevation°) and `+0x30` (distance) off this record, so the
> two "unidentified triples at +0x04 and +0x18" above are the glare's two
> colours and two of the "distance-scale floats" are its size and distance.
> The final light-manager path copies `+0x10` as the fan intensity and `+0x24`
> as the corona intensity @0x001cc4d0–0x001cc4dc, then consumes them at
> @0x001eb5a0–0x001eba44. Values recovered by
> emulating the initializer @0x002582f0 with `swc1`/`mtc1` tracking added to the
> `ExtractMipsWorldConfigTable` constant-store pass; validated by that pass
> reproducing all 13 retail sky colours exactly (the values themselves are
> recovered from the user's executable and are not published here).

## Executable override

The patch adds a **13 × 3-byte RGB table** to the executable, placed in a loaded alignment gap between two
sections. On first application Snowknife reconstructs its initial entries from constant stores in the user's
supported executable's `WorldConf` initializer and verifies the complete result against a manifest digest;
the public patch definition contains no retail channel values. It hooks the loader **immediately after the course's
configuration record has been selected**: the hook jumps to a verified code cave, indexes the RGB table by the
already-clamped course index, writes the selected entry into that record's three colour fields, executes the
instruction the hook displaced, and returns. The stock normalization, runtime vector, graphics setter and
renderer are all left untouched — the patch changes the *data* the retail path reads, not the path.
[[442-patch]]()

The patch is parameterized by the table's first 39 bytes, so applying another colour rewrites only that
course's three-byte entry and leaves every other locally derived or authored slot as packed. All code bytes and table padding are verified
before any write, and `--revert` restores the original hook, cave and alignment bytes exactly. The sky-colour
regions do not overlap the noclip (`440-noclip-fly-mode.md`) or authored HUD-text (`443-debug-text.md`) patches.
[[442-patch]]()

```text
snowknife skycolor game.iso GARI #3a7bd5     # example colours, not retail values
snowknife skycolor game.iso SNOW #0b1a33
snowknife skycolor game.iso --revert
```

> [[442-patch]]() @0x0017e6c0 (hook, replacing 0x0017E6C0..0x0017E6C4, returning at 0x0017E6C8);
> @0x003075c4 (60-byte cave); @0x003608d0 (RGB table, the 48-byte gap between `.data` and `.rodata`);
> file offsets: hook 0x7F6C0, cave 0x2085C4, table 0x2618D0. Supersedes the earlier frame-loop
> cave that rewrote the packed graphics word every frame.

## Per-build targets

The patch is authored against two builds, PAL and NTSC-U, by
`tools/patches/sky_color_patch.py`. The record's three colour field offsets and the
hook's register roles (the clamped course index, and the pointer to the selected record)
are the same in both; the hook, cave and table addresses differ. [[442-targets]]()

The PAL cave is inter-function code padding. The NTSC-U build has no padding run long
enough, so its cave sits in the tail of the same dead library-function blob
`440-noclip-fly-mode.md` vets as dead — placed well clear of the noclip fragments, so
the two patches stay byte-disjoint and each reverts independently. [[442-targets]]()

**The locally recovered colour table is the same in both builds.** Their world-configuration
initializers are instruction-identical across all 1178 instructions apart from absolute
references, so every immediate — the RGB channels among them — matches. The records are
built from code immediates rather than a static table, which is why this is settled by
comparing the initializers rather than by reading bytes. [[442-targets]]()

> [[442-targets]]() db:elf; map:"Sky-colour hook, cave, table and initializer per build";
> PAL SLES_505.45 vs NTSC-U SLUS_203.26 — hook 0x0017E6C0 / 0x0017E608;
> 60-byte cave 0x003075C4 (code padding) / 0x002B3EA0 (tail of the 440 dead blob,
> which ends 0x002B3EE8; noclip's fragments end 0x002B3CE8); 13x3 RGB table
> 0x003608D0 / 0x0035F6D0; WorldConf initializer 0x002582F0 / 0x00257DC0
> (stride 0x94, colour fields +0x48 / +0x4C / +0x50).

## Authored data

A course's sky colour is authored alongside its skybox and travels with the course export; the repack pipeline
applies it to the target slot as it packs, and packing several courses into one ISO preserves the entries
written for slots already packed.
