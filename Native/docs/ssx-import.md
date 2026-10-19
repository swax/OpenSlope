# SSX (2000) PS2 import

The shared C++ importer supports the original NTSC-U SSX disc alongside SSX Tricky.
Slopesmith's `/isos` page runs that same importer in its local browser worker.
Select a plain `.iso` or the `.bin` from a Mode 2 Form 1 BIN/CUE dump. The CUE is
not needed for this single-track data disc. Desktop discovery accepts `.iso` and
`.bin` beside the executable; Quest's existing document picker accepts either.
The importer reads logical sectors on demand without making an ISO copy.

SSX maps use separate identifiers (`SSX_SNOW`, `SSX_MERQUERY`, and so on), so they
can coexist with Tricky maps. Browser maps remain in IndexedDB. Native imports
publish the ordinary `Maps/<identifier>` folder and retain existing folders.

```powershell
./temp/native-core/Release/openslope_import.exe list "discs/SSX (USA).bin"
./temp/native-core/Release/openslope_import.exe extract "discs/SSX (USA).bin" SSX_SNOW Maps
```

The reader was written for this change using the existing native helpers,
portable map contracts, the local Trailmap 500 format summary, and measurements
from the supplied disc. It flattens the spatial cells into portable documents,
resolves terrain materials to their texture slots, and preserves the shared
centimetre coordinate frame.
[Trailmap: 500-disc, 500-members, 500-cells, 500-patch, 500-instance, 500-wfx, 500-aip, 500-ssh]

The exported map contains:

- `Patches.json`, diffuse PNGs and lightmap PNGs.
- `Models.json`, `Meshes/*.obj`, `Materials.json` and `Instances.json`, including
  placement transforms, visibility, material flipbooks and instance lighting.
- `Collision/*.obj` and `Physics.json`, with placement collision bindings.
- `Lights.json`, `AIP.json` with all eight start slots, and `Splines.json`.
- `Skybox/` using the same mesh and material contracts as other maps.
- `Effects.json` with effect slots, graph identities, instance bindings and pool
  references. Original packed nodes live in each graph's
  `extensions.ssxUnresolvedNodes`; they are preserved without executing them as
  Tricky nodes. SSX effect payload semantics remain unresolved.
- Retail provenance in `Origin.json`, capability/deferred information in
  `Import.json`, and lossless local archive members in `Source/`.

`Import.json` deliberately reports `Complete: false`. Effect playback, animated
model behavior, automatic rail candidacy, executable-derived world settings and
audio are not implemented for SSX. The spline curves and effect source records
are retained for those later stages. A non-finite source instance lighting block
uses neutral lighting and adds an explicit import warning; geometry and transform
numbers still fail validation. No retail content is committed or packaged.

Validation covers synthetic plain/raw sector parity, portable outputs, bad
versions/counts/references, non-finite lighting, atomic failure and existing-map
protection. Desktop library tests exercise BIN discovery and installation. All
nine courses on the supplied NTSC-U disc were exported and loaded through the
native map readers. This does not establish effect playback or headset fidelity.

```text
python Native/tests/ssx_import_test.py <openslope_import executable>
```
