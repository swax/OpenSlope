# Effects authoring P0 — write-path and runtime risk gates

Date: 2026-07-14. Target: PAL SSX Tricky (`SLES-50545`).

This pass tests the risks that matter before Slopesmith commits to a generic
effect-graph editor: whether the SSF writer is semantically symmetric, whether a
genuinely new graph can be linked to one instance, whether the authored member
can survive the BIG/ISO path, and whether the timer-emitter runtime/template
model agrees with the static RE.

## Gate status

| Gate | Status | Result |
|---|---|---|
| SSF writer conformance | pass | 12/12 retail SSFs save/reload with complete semantic equality after excluding layout-only offsets/padding; 9,067 nodes and 25,470 instance joins covered |
| Fresh effect graph | pass (binary/archive) | GARI gained a new header, slot and private property record; save/reload and reference validation pass |
| ISO export | pass | authored SSF re-extracted equal from a locally rebuilt image of the tester's own disc; all ten unrelated GARI.BIG members remain byte-identical |
| Type2/Sub0 field typing | pass | found/fixed latent `U9` int-reader bug; non-integral U9/U10/U11 regression test passes |
| P6/P7 selection | pass (static + live) | emitter call at 0x001d91e0 uses virtual `+0x25c` → 0x001e2f58 → id 6/P6; live run recorded 1,785 spawn ticks, 1,739 filtered P6 calls and zero P7 calls |
| Controlled U9/U10/U11 mutation | fixture pass; visual optional | four-emitter GARI axis matrix produced, and the locally rebuilt image boots; a future observation would confirm preview-axis labels, not the write path or field semantics |
| Live template capture | pass with capture limitation | 15 payload-reader calls and 1,785 spawn ticks recorded; retained P6 templates prove local-origin behavior, although the single-slot logger did not retain each rapid axis-canary read separately |

These results remove the major *data-loss* and runtime-selection risks. A Slopesmith graph
model can be built against the current format as long as it preserves unknown
node payloads and uses copy-on-write for shared property records. Directly
watching the controlled displacement would refine semantic axis labels and
preview fidelity, but is not a gate for writing authored graphs back to disc.

The retained P6 snapshots still provide a useful runtime cross-check for the
origin field: prepared template words 40..43 were exactly the world
`(x,y,z,1)` positions of streamed firework-cylinder instances 242, 301 and 312
when their U9..U11 values were zero. That independently agrees with the static
`w=1` matrix transform. The rider was in the later 9,000–10,600 cm course region,
so the four start-area axis canaries were not resident during this capture.

## Tools added

`Snowknife` now exposes three deliberately low-level research commands:

```text
ssf-check <file.ssf|directory>
ssf-canary <in.ssf> <out.ssf> --host N [--source-header N --source-node N]
           [--mode persistent|collision|trigger] [--set U#=value U#=value ...]
ssf-install-iso <source.iso> <LEVEL> <file.ssf> <out.iso>
```

`ssf-check` validates slot/header/function/instance/spline references, performs
the semantic round trip, and prints an emitter-origin census. The current retail
corpus has 978 timer-emitter nodes: U9..U11 are all zero on 937 and any component
is nonzero on 41.

`ssf-canary` clones one Type2/Sub0 node into a fresh one-node effect header,
creates a new slot, clones the host's resolved shared property record, and
redirects only the selected instance. It refuses an already-effectful host
unless `--force-host` is explicit. A single `--set` consumes every following
assignment up to the next option; malformed, duplicate and stray arguments are
fatal. After save/reload, every requested field is compared to the written SSF,
recorded under `requestedOverrides` in the canary manifest, and counted in the
success message so a partially applied experiment cannot report PASS.

`ssf-install-iso` never edits the source ISO. It copies the image, replaces only
the compressed SSF member in the level BIG, permits the BIG to relocate if it
grows, then re-extracts and verifies the output.

`tools/instrumentation/emitter_probe.py` hooks the payload reader, spawn tick and P6/P7 entries.
P6/P7 events are filtered to return address `0x001d91e8`, so board spray cannot
masquerade as an SSF emitter. The probe borrows the existing noclip dead-code
cave only after saving it and all hook words; uninstall restores and verifies the
exact prior live state. Install also rolls back automatically if any write
fails. Executable hook installation and removal are accepted only while PINE
reports the *emulated VM* paused; SSX's own pause menu does not count.

The VM-pause rule was added after the first live run exposed a teardown hazard:
the original probe allowed removal while the game was actively entering the
hooks. Although the saved guest words were restored, PCSX2 2.6.3 then terminated
with a native `0xc0000005` access violation. The exact native fault was not
recoverable from the Windows report, but rewriting the borrowed cave while a
hook could be in flight is the leading cause. The tool now refuses executable
PINE writes while the EE is running: pause the VM before both install and
uninstall, and let the tool verify every restored word before it deletes the
recovery file. This prevents the unsafe condition exposed by that run.

## Concrete canaries

The single-emitter archive canary uses GARI source header 120/node 0 (the
firework particle node) and effectless host instance 215
`Mdl_FireworkCylindar_Red_1000` near the course start. It appends:

- effect slot 78 (persistent column);
- anonymous header 306 containing only the cloned particle node; and
- shared-property record 531, reached only by `InstanceState[215]`.

The controlled origin fixture chains four private canaries around the start:

| Host | Instance | Mutation |
|---:|---|---|
| 129 | `Mdl_FireworkCylindar_Red_1003` | baseline `(U9,U10,U11)=(0,0,0)` |
| 215 | `Mdl_FireworkCylindar_Red_1000` | `U9=+1000` |
| 249 | `Mdl_FireworkCylindar_Red_1001` | `U10=+1000` |
| 182 | `Mdl_FireworkCylindar_Red_1002` | `U11=+1000` |

Generated local fixtures (ignored by git):

```text
temp/p0-effects/gari-emitter-canary.ssf
temp/p0-effects/ssx-tricky-gari-emitter-canary.iso
temp/p0-effects/gari-offset-axis-matrix.ssf
temp/p0-effects/ssx-tricky-gari-offset-axis-matrix.iso
```

The `+1000` value is ten engine meters: large enough to identify an axis without
overflowing the normal course scale. Static RE already proves U9..U11 form a
point (`w=1`) transformed through the host matrix, while U12..U29 are vectors
(`w=0`). The visual run is retained to confirm presentation-axis labels and the
expected ten-metre displacement, not the binary type.

## Reproduction

Writer corpus:

```powershell
dotnet run --no-build --project Snowknife/Snowknife/Snowknife.csproj -c Debug -- ssf-check temp/patch-trailer-retail
```

Single canary and ISO:

```powershell
dotnet run --no-build --project Snowknife/Snowknife/Snowknife.csproj -c Debug -- ssf-canary temp/patch-trailer-retail/GARI/data/models/gari.ssf temp/p0-effects/gari-emitter-canary.ssf --host 215 --source-header 120 --source-node 0 --mode persistent
dotnet run --no-build --project Snowknife/Snowknife/Snowknife.csproj -c Debug -- ssf-install-iso discs/ssx-tricky.iso GARI temp/p0-effects/gari-emitter-canary.ssf temp/p0-effects/ssx-tricky-gari-emitter-canary.iso
```

Live capture after booting the canary into GARI. "Pause VM" means PCSX2's
emulation pause control, not the SSX pause screen:

```powershell
# Pause VM.
python tools/instrumentation/emitter_probe.py install
# Resume VM and unpause SSX.
python tools/instrumentation/emitter_probe.py capture --seconds 15 --out temp/p0-effects/emitter-capture-gari.json
# Pause VM again.
python tools/instrumentation/emitter_probe.py uninstall
python tools/instrumentation/pine_hooks.py status
```

Always run `uninstall` even if capture is interrupted. A remaining
`temp/p0-effects/emitter-probe-state.json` is intentional recovery state; do not
delete it before uninstall restores the saved cave.

## Editor constraints bought down by this pass

- Treat `ObjectProperties` as a shared table and use copy-on-write when changing
  an individual instance's effect slot.
- Give every graph index space a stable internal ID; assign compact binary
  indices only during export and validate all references before writing.
- Preserve unknown node payload bytes/subtypes. Semantic controls can sit on top
  of raw fields, but must not make unrecognized data unround-trippable.
- Store `U9..U11` as floats and present them as a local origin with the raw U
  labels available.
- Model ISO export as a verified build artifact from an immutable source image,
  including archive relocation; never patch the user's source ISO in place.
- Use the same neutral authored graph for Unity and ISO exporters. Unity can
  approximate runtime appearance, but ISO export must preserve SSF topology and
  raw values exactly.
