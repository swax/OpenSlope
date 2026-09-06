# Repacking a Custom Level into a Bootable PS2 ISO

This is the operator guide for replacing a retail course with a Slopesmith export. `snowknife repack` reads a clean, user-provided SSX Tricky ISO, builds a separate output image, and never modifies the source image.

The output still contains retail game data. Keep it private; distribute the authored source or a patch, not the repacked ISO.

For format invariants, texture allocation, authored effects, animation, and other implementation details, see the [repack technical reference](docs/repack-technical-reference.md).

## Before you start

You need:

- a clean PAL or NTSC-U SSX Tricky ISO;
- the imported `Maps/<SLOT>` directory for the retail course being replaced;
- a Slopesmith export directory; and
- enough free space for a second ISO plus temporary build files.

The imported map and source ISO should describe the same course slot. Run `snowknife --help` or `snowknife <command> --help` for the CLI's complete syntax. `snowknife` is the
executable `dotnet build` leaves under `Snowknife/Snowknife/bin/Debug/net10.0/`; the commands below assume
that directory is on `PATH`.

## Choosing a course slot

Snowknife can replace any supported retail course slot, but repacking does not change whether the game's
menus expose that slot. Prefer a course already available in the intended mode and profile, and verify the
route with an empty PCSX2 memory card before treating it as the release default. `GARI` is the concrete slot
used by Slopesmith's generated recipe, not a promise that it is selectable in every mode.

When a chosen slot is locked, the player can use the retail game's built-in course-access cheat, entered at the
title screen; the code is widely published and is not repeated here. The setting lasts for the current run and
may need to be entered again after restarting. This uses behavior already present in the game. Snowknife does
not rewrite progression or create or distribute memory-card saves.

## Quick start

Plan the build first:

```powershell
snowknife repack ssx-tricky.iso <courseSlot> Maps/<SLOT> Exports/MyMountain ssx-custom.iso --dry-run --texture-type2 --bare-slot --no-skycolor
```

Review the findings, texture assignments, page budget, path selection, and sky plan. A dry run creates no output ISO.

Then build it:

```powershell
snowknife repack ssx-tricky.iso <courseSlot> Maps/<SLOT> Exports/MyMountain ssx-custom.iso --texture-type2 --bare-slot --no-skycolor
```

The positional arguments are:

| Argument | Meaning |
|---|---|
| `<iso>` | Clean source image; read only |
| `<courseSlot>` | Retail slot to replace; `snowknife help repack` lists them |
| `<mapDir>` | Imported `Maps/<SLOT>` data for that slot |
| `<customDir>` | Slopesmith export to install |
| `<out.iso>` | New image to create |

`repack` performs the full pipeline: it reads the target archive from the ISO, overlays the authored data, resolves textures, rebuilds the PBD and world grid, regenerates dependent members when required, assembles a replacement BIG, and writes it into the new image.

## Common options

| Option | Effect |
|---|---|
| `--dry-run` | Run the plan without producing the output ISO |
| `--json` | Emit the dry-run record as JSON on stdout |
| `--texture-type2` | Encode authored terrain and prop pages as retail-shaped 8-bit indexed textures; recommended for most builds |
| `--sound-rate [hz]` | Encode every custom prop sound at this rate instead of the target bank's own; bare, 22050 |
| `--bare-slot` | Hide the donor slot's own props and silence their sounds, keeping the StageArea start/finish instance; recommended for most builds |
| `--patches <list>` | Comma-separated executable features: `noclip` and/or `hud-text` |
| `--no-skycolor` | Do not apply the export's `Skybox/Sky.json` `TopColor` |
| `--no-sound-routing` | Keep the export's reserved custom-sound event IDs instead of re-pointing them onto slots the target bank already ships; for isolating a build, not for shipping one |

The quick-start recipe deliberately supplies `--no-skycolor` and selects no `--patches` feature. With those
defaults Snowknife leaves the supplied boot executable byte-for-byte unchanged. Sky colour, noclip, and
authored HUD support remain explicit options for local builds that need them.

Type 2 is usually the right choice for authored pages: it uses one quarter of the pixel storage of the proven type-5 fallback. Native and borrowed retail pages remain byte-verbatim either way.

`--bare-slot` is the other half of that recipe. An authored course replaces the slot's terrain but inherits
the retail course's whole prop population, still standing where that course left it. A prop build delists
those props from the world grid so they neither draw nor collide — but a placed emitter is dispatched from
the `.adl`, not the grid, so without this flag the donor's crowd and birdsong keep playing over your own
emitters, and every event those props hold stays reserved in the course bank instead of being free for your
clips. The instances are hidden rather than deleted, so every index the SSF, LTG, and spline tables reference
stays put, and the StageArea start/finish markers are kept so the rider still spawns on the course. Leave the
flag off when the retail scenery is the point, such as a terrain-only remix of the original course.

Custom prop sounds are re-encoded at **the rate the target bank is played at**, whichever rate they were
authored in — 48 kHz down, 11 kHz up. That is a pitch decision, not a size one: the engine ignores a sound's
own rate tag and plays the slot at the bank's, so a 440 Hz tone encoded at 22,050 into a bank played at
16,000 comes back a fourth flat. The build prints the rate it chose. The conversion is band-limited, so
nothing folds back as aliasing.

`--sound-rate [hz]` overrides that rate for every clip. It is an override rather than a ceiling — it converts
up as well as down, and nothing is "left alone" either way — so the only rate that sounds right is the one
the build already picks. What it buys is bytes: the course bank is uploaded whole and must not outgrow the
one it replaces, and cost is proportional to rate. Naming a lower one is a deliberate trade of pitch for
size on a build that is over budget, not a tidying step to apply by default.

### The bank budget, and where custom sounds land

A rebuilt course bank must not exceed the size the level it replaces shipped with. Past that line the disc
still builds, the sound rows are still right, and **nothing plays** — so the repack refuses the injection and
keeps the retail banks rather than shipping a silent image, naming the overage and what each clip costs.

Most builds never see that, because the repack picks destinations against the target bank first. Slopesmith
allocates each custom clip a reserved event ID, which is the right thing for an export that does not know its
disc; those IDs land on slots the bank leaves empty. So the repack re-points them onto slots this level ships
and the built course no longer reaches — nothing an instance's collision sound or emitter resolves to, and
nothing a `PlaySound` node names directly. Each move is logged with what it reclaimed, and the finished disc
gets a `<iso>.sounds.json` beside it saying where every clip ended up.

**That is a correctness rule, not a saving.** A clip written into a slot the bank leaves empty is injected,
decodes correctly, is dispatched, gets a voice — and is never heard; only slots the target bank already ships
play (Trailmap `260-shipped-slot`). A slot it ships also hands its own bytes back, so the budget improves too,
but that is the side effect. If the repack cannot find a shipped slot for a clip it says so per clip, and that
warning means the clip will be silent on the disc however green the rest of the log looks.

One clip is never moved: a hit-gated loop carries its gating in the ID itself, so 16/28/57 stay put. And no
emitter is ever given slot 64 — a mono loop written there and asked to sustain freezes the level clock
(Trailmap `260-emitter-routing`), which is the one slot rule that survives. `--no-sound-routing` turns the
whole step off for bisecting a build; expect a silent course if you use it.

### Event 63 is the glass smash, and it is free

Every course bank carries the same 2.17-second stereo shatter in slot 64, and event 63 is the only ID that
reaches it — retail hangs it on the LCD screens, the parliament windows, the skylight, Aloha's breakable
shortcut covers (Trailmap `260-slot-64`). Two things follow for a build.

Give an authored prop event 63 and it plays that smash **at no cost to the budget**, because the bytes are
already on the disc. It is the best-value collision sound a breakable can have.

Leave it unused and it becomes the largest reclaim in the bank — 54,688 bytes, a sixth of Garibaldi's whole
budget — so a `--bare-slot` build's biggest custom hit sound usually lands there. Those two uses are mutually
exclusive and the repack works that out for you: any surviving prop or `PlaySound` node on event 63 reserves
the slot, and only a course that reaches it from nowhere puts a clip in it.

## What the build keeps and replaces

The result depends on what the export contains:

| Data | Result |
|---|---|
| Terrain | Replaced from the export; the `.ltg` spatial/collision grid is rebuilt |
| Textures | Target pages are reused, donor pages are copied verbatim, and authored PNGs are encoded |
| Lighting | Authored `Lights.json` and lightmaps replace target lighting; otherwise target lighting remains |
| Paths | Authored AIP/SOP data is normalized and installed; otherwise target paths and StageArea transform remain |
| Props | With no authored props, target scenery remains unless `--bare-slot` is used. With authored props, original static scenery is delisted and the authored population replaces it; `--bare-slot` additionally silences the delisted props' emitters |
| Race markers and gems | Original race markers and pickups remain listed when authored props replace static scenery |
| Effects and collision | Authored attachments, collision profiles, sounds, and dependent SSF/MAP/ADL data are compiled when present |
| Sky | An authored or donor sky replaces the target sky; otherwise the target sky remains |
| Music | `Music/track.wav`, when present, replaces the target course's first playlist song |

The [technical reference](docs/repack-technical-reference.md) documents the exact preservation and regeneration rules.

## Several levels in one ISO

`repack-many` copies the source image once and installs every listed course before publishing the output:

```json
{
  "InputIso": "ssx-tricky.iso",
  "OutputIso": "ssx-custom.iso",
  "TextureType2": true,
  "BareSlot": true,
  "SkyColors": false,
  "Levels": [
    {
      "Slot": "GARI",
      "LevelData": "../Maps/GARI",
      "Export": "../Exports/MyMountain"
    },
    {
      "Slot": "SNOW",
      "LevelData": "../Maps/SNOW",
      "Export": "../Exports/NightRide"
    }
  ]
}
```

Paths are relative to the manifest. Optional root settings include `TextureType2`, `SoundRate`, `Noclip`, `BareSlot`, and `SkyColors: false`. Each slot may appear only once. Donor pages always come from the clean source image, even when that donor slot is also being replaced.

Plan or build the manifest with:

```powershell
snowknife repack-many manifest.json --dry-run
snowknife repack-many manifest.json
```

## Reading the dry run

The dry run executes the same allocation and normalization code as the real build, stopping before output publication. Its report covers:

- protected, reusable, and appended texture slots;
- every page to install and the source reference that requested it;
- measured retained, reused, free, appended, and projected bank bytes;
- custom-page format, dimensions, resampling, and aggregate budget;
- AIP/SOP selection, six-rider start normalization, and StageArea placement;
- kept, borrowed, or regenerated sky data; and
- unresolved references, fallbacks, proven-limit warnings, and other findings.

Use `--json` for automation. Progress stays on stderr and the plan is written to stdout.

For texture resolution without a disc:

```powershell
snowknife texture-plan Exports/MyMountain <courseSlot>
snowknife texture-plan Exports/MyMountain <courseSlot> --slots 121 --json
```

## Manual pipeline and diagnostics

Use `repack` for normal work. The lower-level commands are useful for inspecting a failed step or replacing one member by hand:

| Command | Purpose |
|---|---|
| `iso-extract` | Extract a file from an ISO |
| `big-extract <big> <dir> [--raw]` | Unpack a BIG; `--raw` preserves RefPack-compressed members |
| `big-create <dir> <out.big> [c0fb\|bigf] [--store]` | Rebuild a BIG; `--store` keeps compressed members verbatim |
| `pbd-from-json <mapDir> <out.pbd> ...` | Generate level members from Maps JSON |
| `refpack <in> <out>` | Compress one member |
| `iso-replace <iso> <path> <file>` | Replace one ISO9660 file, relocating it when necessary |
| `ltg-stats <file.ltg>` | Inspect per-cell world-grid totals |
| `ssh-append` / `ssh-encode` | Install a donor page or encode an authored PNG |
| `bank-verify` | Check AUDIO.BIG or BNKl rebuild behavior |

A level normally lives in `DATA/MODELS/<LEVEL>.BIG`, a C0FB archive containing 11 RefPack members:

```text
<level>.ssh       <level>_L.ssh    <level>_sky.ssh
<level>.pbd       <level>_sky.pbd  <level>.ltg
<level>.map       <level>.ssf      <level>.aip
<level>.sop       <level>.adl
```

A manual terrain-only replacement consists of:

1. Extracting the target BIG and its full Maps sidecars.
2. Overlaying the authored terrain, paths, textures, and lighting as appropriate.
3. Regenerating the PBD and `.ltg`, plus AIP/SOP and other dependent members when changed.
4. RefPack-compressing changed members.
5. Rebuilding the BIG with unchanged compressed members stored verbatim.
6. Running `iso-replace` on a copy of the ISO.

This route is diagnostic, not a second supported authoring pipeline; `repack` also performs texture allocation, surgical preservation, SSF sanitation, audio work, and executable-patch safety checks that are easy to miss by hand.

> **PCSX2 grey-terrain check:** If both original and custom terrain render flat grey, set **GS Blending Accuracy** to **Full**. Lower modes can approximate away the terrain's GS ALPHA lightmap blend; that is a renderer setting, not a repack failure.

## Executable options

### Noclip fly mode

Noclip is an optional local course-inspection aid. It does not make a course selectable and is not required
for repacking; keep it off normal release-candidate builds.

```powershell
snowknife noclip <iso>
snowknife noclip <iso> --revert
snowknife repack ... --patches noclip
```

Press **TRIANGLE + CIRCLE** to toggle. The left stick flies camera-relative, **SQUARE** ascends, **X** descends, and **R1** gives 4× speed. Engage it after the race-start camera settles. It affects the local player only.

See [Trailmap spec 440](../Trailmap/specs/440-noclip-fly-mode.md) for the executable contract.

### Sky colour

The stock-executable recipe uses `--no-skycolor`. Omit that option only when a local build deliberately needs
the export's `TopColor` applied to the executable.

```powershell
snowknife skycolor <iso> GARI '#3a7bd5'    # example colours, not retail values
snowknife skycolor <iso> SNOW '#0b1a33'
snowknife skycolor <iso> --revert
```

`repack` applies the export's `TopColor` automatically unless `--no-skycolor` is present. Reapplying the command changes only the selected course entry.

See [Trailmap spec 442](../Trailmap/specs/442-sky-color.md).

### Authored HUD messages

`repack --patches hud-text` keeps Show message effect nodes and installs the dispatcher support that renders them. Without that selection, repack removes these otherwise inert nodes. Combine features in one comma-separated value, for example `--patches noclip,hud-text`.

See [Trailmap spec 443](../Trailmap/specs/443-debug-text.md).

### Supported disc releases

Executable patches are digest-verified per release. PAL Europe and NTSC-U USA are supported; other builds, including NTSC-J, are refused before modification. Level authoring data is not region-specific: the repacker reads the target course members from the supplied ISO.

## Restoring the original bytes

Executable patch files contain replacement bytes and hashes of the expected source regions, but no retail original bytes. On first application Snowknife saves the replaced bytes to:

```text
<iso>.snowknife-restore.json
```

Keep that file beside the image. Multiple patches accumulate in it, and the first saved copy of a region is retained. Revert validates both the current image and the saved data before restoring anything:

```powershell
snowknife noclip <iso> --revert
snowknife skycolor <iso> --revert
```

If the restore file is unavailable, supply an unpatched image of the same release:

```powershell
snowknife noclip <iso> --revert --from <clean.iso>
```

The source regions must match the patch manifest's digests; a wrong-build or already-patched source is rejected.

## Verification (without booting)

After a build:

1. Extract the patched `<LEVEL>.BIG` and compare it with the BIG Snowknife built.
2. Extract its members and compare regenerated members with their build outputs and preserved members with the clean source.
3. Compare `SYSTEM.CNF` and the boot executable with the source image. Without executable options they should match; with options, differences should be confined to declared patch regions.
4. Revert each executable option and confirm those regions return byte-for-byte to the clean image.

Then boot the output in PCSX2 and check spawn placement, collision, paths in each game mode, textures, props, effects, lighting, sky, audio, and resets.
