# CrowdBox runtime

Reverse-engineering derivation for SSF `MainType 0 / SubType 17`, named
`CrowdBox` by the retail executable. Behavioral conclusions are absorbed by
`spec:410-crowd`; this note keeps the joins, addresses, and implementation
details out of the clean specification.

## Authored GARI join

GARI model 28 is `mdl_4x4_people_1000`. Its 34 placed instances all reference
effect slot 50, whose persistent column points to effect header 111. Header 111
contains one property node:

```text
MainType = 0
SubType  = 17 (CrowdBox)
U0       = 0
U1       = 4
U2       = 4
```

The model already contains 16 mesh/material groups. Their positions form four
rows by four columns; the effect does not create the billboard geometry. Other
retail data confirms the dimensions: MERQUER has a `2 x 8` CrowdBox, while the
other surveyed crowd models use `4 x 4`; both describe 16 cells.

Slot 50's collision header 112 is a separate rider-reset command. It is not
part of the persistent CrowdBox behavior and the GARI people instances have no
collision mesh.

## Factory and node layout

`EffectRegistry_BuildEffectNode` dispatches SubType 17 through jump-table entry
`0x0036ca24` to `0x0013cda8`. That arm allocates `0x104` bytes, tags the object
with the retail string `CrowdBox` (`0x0036c978`), and calls the constructor at
`0x00145b30`.

The constructor reads only payload offsets `+0x10` and `+0x14` into node fields
`+0x34` and `+0x38`: these are `U1` rows and `U2` columns. Payload `U0` at
`+0x0c` is not read on this path. The relevant node tail is:

| Node offset | Meaning |
|---|---|
| `+0x34` | row count (`U1`) |
| `+0x38` | column count (`U2`) |
| `+0x3c` | current crowd/activity code |
| `+0x40` | material-override count, fixed to 16 |
| `+0x44` | 16 texture-record pointers supplied to the renderer |
| `+0x84` | 16 signed phase counters |
| `+0xc4` | 16 playback-pattern selectors |

The arrays exactly fill the `0x104`-byte object. The row/column render loop has
no bounds check, so retail content keeps `rows * columns == 16`.

## Shared texture bank

The initializer at `0x001458e8` opens `data/textures/crowd.ssh`, resolves
`crowd%02d` for indices 0 through 15, and builds sixteen 72-byte texture
records at `0x0031e6b8`. These are the shared images exported by `snowknife` as
`cd00` through `cd15`; the level's authored materials are placeholders.

## Per-cell playback

Initialization at `0x00145c08` gives each of the 16 cells a random starting
phase (`random & 15`) and one of four playback patterns (`random & 3`). The
four hard-coded 16-step frame maps at `0x0031e578` are:

```text
0: 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
1: 0 1 2 3 2 1 0 7 8 9 10 11 12 13 14 15
2: 0 1 2 3 4 5 6 7 6 5 4 3 2 1 0 0
3: 0 0 0 0 0 1 2 3 4 5 6 5 4 3 2 1
```

The update method at `0x00145c90` runs only when the shared engine counter is
divisible by five. A zero activity code freezes the phases. Otherwise, each
cell advances independently; completing a cycle rerolls its playback pattern
and can insert a random 0-to-63-step rest on frame zero. Codes 1 through 6 use
rest thresholds `0, 50, 100, 200, 100, 50` out of 256; code 7 never inserts a
rest. The code-zero threshold is 256 but is unreachable because zero freezes
before the phase loop.

The activity code is not authored in the CrowdBox payload. The update checks
active players within 20,000 engine units of the crowd instance and reads a
per-player value from the shared SFX/effect manager (`0x002218f0`), mapping it
through `(value + 4) & 7`. A global mode can force code 7. This establishes the
visual controller's connection to shared crowd/SFX activity, although the
upstream meaning of every manager value remains unnamed.

For cell `i`, a non-resting phase selects
`pattern[(phase + i) & 15]`; a resting phase selects frame zero. The nested
`rows x columns` loop writes the resulting sixteen texture-record pointers to
the node's override array. The draw method at `0x00145fc8` passes that array to
the existing model renderer, giving every pre-authored grid cell its own
current `CROWD.SSH` frame.

No sound-play call occurs in the node. Crowd beds and chants are separate audio
systems; CrowdBox is a visual material controller.

## Port consequence

Treating CrowdBox as one uniform `cd00..cd15` flipbook preserves the asset but
loses the retail effect's defining behavior: spatial cells no longer start at
different phases, choose different motion envelopes, pause independently, or
react to the shared activity code. A literal CPU/material-slot port would be
expensive, but the visible part can instead be expressed as a texture-array
shader indexed by a baked cell id and stable seed.
