# Trailmap tools

Run commands from the repository root unless a document says otherwise.

Install the shared Python dependencies before running the tools or repository hygiene gate:

```bash
python -m pip install --requirement Trailmap/tools/requirements.txt
```

- `analysis/` — offline ELF and VU inspection:
  - `ssx_analyze.py` manages the analysis database and provides ELF queries.
  - `ssx_seed_data.py` (locally generated, not committed) contains the durable labels
    and observations `ssx_analyze.py seed-known` writes into the database.
  - `vu_disasm.py` inventories and disassembles VU programs.
  - `afl_pose.py` decodes named rider-animation curves and combines 60-channel body tracks with an MPF skeleton.
- [`autotest/`](autotest/README.md) — closed-loop Slopesmith fixture, repack, PCSX2 ride, and verdict workflows.
- `instrumentation/` — live PCSX2/PINE workflows:
  - `pine_hooks.py` controls the shared live hooks and savestates, and holds the digest-checked
    stock-site helpers every probe here uses: a site is named by the SHA-256 of its two stock words,
    the words are read from the emulator at install, and a detoured site is restored from the
    extracted executable `SSX_STOCK_ELF` names (default `Trailmap/extracted/SLES_505.45`).
  - `pine_install.py` installs or reverts the noclip patch in a running game.
  - `rider_telemetry.py` captures and annotates frame-fenced rider traces,
    including the final blended 19-bone retail body pose and surface/render
    offsets; `rig-study` derives two-sided turn-pose and angular-speed reports.
  - `emitter_probe.py` captures effect-emitter payloads.
  - `test_rider_telemetry.py` tests the telemetry decoder and annotation helpers.
- [`pine/`](pine/README.md) — read-only Node tools for snapshotting and inspecting a running PCSX2 session.
- `patches/` — offline ELF patch builders:
  - `noclip_patch.py` builds the noclip/fly-mode ELF, and hosts the shared assembler.
  - `sky_color_patch.py` builds the per-course sky-colour ELF.
  - `debug_text_patch.py` builds the HUD debug-text ELF.
  - `verify_manifests.py` regenerates every shipped manifest from your own executable and
    requires it to match — the disc-backed half of the guarantee below. It runs from
    `tools/hygiene.py`, so every gate gets it; without a disc it skips loudly.
- `specs/` — clean-spec maintenance:
  - `spec_trace.py` checks clean/dirty separation and spec↔RE traceability.
  - `patch_hygiene.py` checks the shipped patch manifests declare every displaced word.
  - `test_tools_import.py` imports every module here, so a refactor cannot leave a consumer
    raising ImportError with the gate still green.

## Writing a patch

Two rules keep an emitted manifest publishable, and both are enforced rather than remembered.

**Identify a build without writing its words down.** A `Target` carries `site_digests`, not the
instructions at each site. To add a build, find its hook sites and ask
for the block:

```bash
python tools/patches/noclip_patch.py --elf NEW_ELF \
    --print-digests 0x0017b104,0x001171f4,0x00117b7c,0x0011d838,0x002b4c40:4
```

That prints a paste-ready `site_digests=(...)`, with the words each digest covers beside it as a
comment so you can check them against your disassembler. `:4` narrows a window to one word, which
is what a signature like the cave head needs. The words in that output are diagnostics read from
your own executable; the table you paste is digests only.

**Declare every word you did not write.** A trampoline has to re-execute the instruction its
branch displaced, and that instruction is the game's. Wrap the run:

```python
a.retail(t.site_a, 2)          # the next two words came from site A
a.sh("v1", 0x18, "s2")
a.sw("a3", 0x24, "s2")
```

`--out` still writes those words, because the executable has to run. `--emit-patch` replaces the
window with `break` and a `graft` directive naming where to copy them from at apply time. Forget
the call and the build fails: the generator has your executable in hand, so it compares every
emitted word against the sites being patched and refuses to write an undeclared one. That check
cannot run in CI, which has no disc — `specs/patch_hygiene.py` covers the half that can.

A patch that re-implements what it displaced instead of replaying it needs none of this;
`debug_text_patch.py` is the worked example.
