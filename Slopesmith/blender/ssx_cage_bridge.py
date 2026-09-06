"""
ssx_cage_bridge — round-trip a Slopesmith-authored level folder's Patches.json through
Blender as an editable quad CONTROL CAGE, and emit it straight back.

This is the "power-user path" doc 001 anticipates: Blender never sees the SSX bicubic-Bezier
SURFACE (no native primitive reproduces it — see docs/009). It edits the CAGE — the patch
CORNER control points, which are exactly a rectangular quad mesh — and an export step re-runs
the SAME Bessel-tangent derivation Slopesmith uses (a port of src/core/bezier.ts) to turn the
edited cage back into Patches.json `Points`.

What maps to Blender natively:
  - cage geometry  -> mesh vertices (grid topology; valence-4 interior).   [edit with any Blender tool]
  - SurfaceType    -> per-face INT attribute "ssx_surface".               [editable as face data]
  - TexturePath    -> one material slot per tile, face.material_index.     [assign like materials]
What is carried losslessly but is NOT Blender-native (the addon stores it on the object):
  - tangent-handle overrides (creases/overhangs)  -> obj["ssx_handles"]   (sparse, Bessel default).
  - UVPoints / LightMapPoint / LightmapID / TrickOnlyPatch -> obj["ssx_meta"] per patch.
    (On a real geometry edit, UVPoints would be recomputed chord-length, the same as
     src/core/mountain.ts deriveMountain; this prototype carries them to prove losslessness.)

Spaces:
  raw SSX  (cm, Z-up, X-mirrored)  <- Patches.json on disk
  editor   (m,  Y-up, RH)          <- Slopesmith's internal space (level.ts / reflevel.ts)
  blender  (m,  Z-up, RH)          <- swap editor Y<->Z so "up" is Blender's Z

Run inside Blender:
  exec(open(r"...\\Slopesmith\\blender\\ssx_cage_bridge.py").read())
  obj = import_level(r"...\\Maps\\MOUNTAIN01\\Patches.json")
  export_level(obj, r"...\\out\\Patches.json")
  print(round_trip_test(r"...\\Maps\\MOUNTAIN01\\Patches.json"))
"""

import bpy, json, re
from mathutils import Vector

# ---- vec (port of src/core/vec.ts) ----
def _sub(a, b): return (a[0]-b[0], a[1]-b[1], a[2]-b[2])
def _add(a, b): return (a[0]+b[0], a[1]+b[1], a[2]+b[2])
def _mul(a, s): return (a[0]*s, a[1]*s, a[2]*s)
def _len(a): return (a[0]*a[0]+a[1]*a[1]+a[2]*a[2])**0.5

# ---- spaces (exact inverses of level.ts toRaw / reflevel.ts editorFromRaw) ----
def to_raw(p):           return (-100.0*p[0], -100.0*p[2], 100.0*p[1])     # editor -> raw
def editor_from_raw(p):  return (-p[0]/100.0, p[2]/100.0, -p[1]/100.0)     # raw -> editor
def blender_from_editor(e): return (e[0], e[2], e[1])                      # editor -> blender (Y<->Z)
def editor_from_blender(b): return (b[0], b[2], b[1])                      # blender -> editor (self-inverse)

# ---- bezier derivation (port of src/core/bezier.ts) ----
def bessel_tangent(a, b, c):
    if a is not None and c is not None:
        d0 = _sub(b, a); d1 = _sub(c, b)
        h0 = max(1e-9, _len(d0)); h1 = max(1e-9, _len(d1))
        return _add(_mul(d1, h0/(h0+h1)), _mul(d0, h1/(h0+h1)))
    if c is not None: return _sub(c, b)
    if a is not None: return _sub(b, a)
    return (0.0, 0.0, 0.0)

def _grid_get(P, R, C, r, c):
    return P[r][c] if (0 <= r < R and 0 <= c < C) else None

def grid_tangents(P, R, C, overrides):
    """Per-corner directional handles (hUp/hUm/hVp/hVm), Bessel by default, overridden per (r,c,dir)."""
    hUp = [[None]*C for _ in range(R)]; hUm = [[None]*C for _ in range(R)]
    hVp = [[None]*C for _ in range(R)]; hVm = [[None]*C for _ in range(R)]
    for r in range(R):
        for c in range(C):
            tu = bessel_tangent(_grid_get(P, R, C, r-1, c), P[r][c], _grid_get(P, R, C, r+1, c))
            tv = bessel_tangent(_grid_get(P, R, C, r, c-1), P[r][c], _grid_get(P, R, C, r, c+1))
            hUp[r][c] = _mul(tu, 1/3);  hUm[r][c] = _mul(tu, -1/3)
            hVp[r][c] = _mul(tv, 1/3);  hVm[r][c] = _mul(tv, -1/3)
    lane = {'u-': hUm, 'u+': hUp, 'v-': hVm, 'v+': hVp}
    for key, off in (overrides or {}).items():
        m = re.match(r'^(\d+),(\d+):(u[-+]|v[-+])$', key)
        if not m: continue
        r, c, d = int(m.group(1)), int(m.group(2)), m.group(3)
        if r < R and c < C: lane[d][r][c] = tuple(off)
    return hUp, hUm, hVp, hVm

def cell_control_points(P, hUp, hUm, hVp, hVm, row, col):
    A = P[row][col]; B = P[row][col+1]; Cc = P[row+1][col]; D = P[row+1][col+1]
    cp = [None]*16
    cp[0]  = A
    cp[1]  = _add(A, hVp[row][col])
    cp[2]  = _add(B, hVm[row][col+1])
    cp[3]  = B
    cp[4]  = _add(A, hUp[row][col])
    cp[5]  = _add(_add(A, hUp[row][col]), hVp[row][col])
    cp[6]  = _add(_add(B, hVm[row][col+1]), hUp[row][col+1])
    cp[7]  = _add(B, hUp[row][col+1])
    cp[8]  = _add(Cc, hUm[row+1][col])
    cp[9]  = _add(_add(Cc, hUm[row+1][col]), hVp[row+1][col])
    cp[10] = _add(_add(D, hUm[row+1][col+1]), hVm[row+1][col+1])
    cp[11] = _add(D, hUm[row+1][col+1])
    cp[12] = Cc
    cp[13] = _add(Cc, hVp[row+1][col])
    cp[14] = _add(D, hVm[row+1][col+1])
    cp[15] = D
    return cp

# ---- parse: Patches.json (grid-named) -> corner grid + per-patch metadata ----
def _patch_index(patches):
    """Map (r,c) -> patch record for a grid-named (Cell_r{r}_c{c}) Patches.json."""
    idx = {}; maxr = maxc = -1
    for p in patches:
        m = re.match(r'^Cell_r(\d+)_c(\d+)$', p.get('PatchName', ''))
        if not m:
            raise ValueError("not a grid-topology level (patch '%s'); original import is out of scope (docs/006 Non-goals)" % p.get('PatchName'))
        r, c = int(m.group(1)), int(m.group(2))
        idx[(r, c)] = p; maxr = max(maxr, r); maxc = max(maxc, c)
    return idx, maxr, maxc

def _corner_grid(idx, maxr, maxc):
    """Rebuild the (R x C) corner control net in EDITOR space. Corners are cp 0/3/12/15."""
    R, C = maxr+2, maxc+2
    P = [[None]*C for _ in range(R)]
    for (r, c), p in idx.items():
        cp = [editor_from_raw(q) for q in p['Points']]
        P[r][c]       = cp[0]                       # A
        P[r][c+1]     = cp[3]                        # B (fills last column)
        P[r+1][c]     = cp[12]                       # C (fills last row)
        P[r+1][c+1]   = cp[15]                       # D (fills far corner)
    return P, R, C

def _capture_handles(idx, P, R, C):
    """Recover every corner's four directional handles from the stored edge CPs, then keep only the
    ones that deviate from the Bessel default — the sparse override set (matches Slopesmith's model)."""
    hUp = [[None]*C for _ in range(R)]; hUm = [[None]*C for _ in range(R)]
    hVp = [[None]*C for _ in range(R)]; hVm = [[None]*C for _ in range(R)]
    for (r, c), p in idx.items():
        cp = [editor_from_raw(q) for q in p['Points']]
        A, B, Cc, D = cp[0], cp[3], cp[12], cp[15]
        hVp[r][c]       = _sub(cp[1], A)
        hUp[r][c]       = _sub(cp[4], A)
        hVm[r][c+1]     = _sub(cp[2], B)
        hUp[r][c+1]     = _sub(cp[7], B)
        hUm[r+1][c]     = _sub(cp[8], Cc)
        hVp[r+1][c]     = _sub(cp[13], Cc)
        hUm[r+1][c+1]   = _sub(cp[11], D)
        hVm[r+1][c+1]   = _sub(cp[14], D)
    bUp, bUm, bVp, bVm = grid_tangents(P, R, C, None)   # Bessel reference
    overrides = {}
    eps = 1e-6
    for lane, bl, dirname in ((hUp, bUp, 'u+'), (hUm, bUm, 'u-'), (hVp, bVp, 'v+'), (hVm, bVm, 'v-')):
        for r in range(R):
            for c in range(C):
                got, ref = lane[r][c], bl[r][c]
                if got is None: continue
                if _len(_sub(got, ref)) > eps:
                    overrides["%d,%d:%s" % (r, c, dirname)] = list(got)
    return overrides

# ---- import: build the editable cage object ----
def import_level(json_path, name=None):
    with open(json_path, 'r') as f:
        patches = json.load(f)['Patches']
    idx, maxr, maxc = _patch_index(patches)
    P, R, C = _corner_grid(idx, maxr, maxc)
    overrides = _capture_handles(idx, P, R, C)

    # vertices = corners (blender space), faces = patches in (r,c) order
    verts = [Vector(blender_from_editor(P[r][c])) for r in range(R) for c in range(C)]
    faces, meta, surf, tex_of = [], {}, [], []
    tex_slots = {}                                   # TexturePath -> material slot index
    for r in range(maxr+1):
        for c in range(maxc+1):
            p = idx[(r, c)]
            faces.append((r*C+c, r*C+c+1, (r+1)*C+c+1, (r+1)*C+c))
            surf.append(int(p['SurfaceType']))
            t = p.get('TexturePath', '')
            if t not in tex_slots: tex_slots[t] = len(tex_slots)
            tex_of.append(tex_slots[t])
            meta["%d,%d" % (r, c)] = {
                'UVPoints': p.get('UVPoints'), 'LightMapPoint': p.get('LightMapPoint'),
                'LightmapID': p.get('LightmapID', 0), 'TrickOnlyPatch': p.get('TrickOnlyPatch', False),
            }

    nm = name or re.sub(r'[\\/]', '_', json_path).split('Maps_')[-1].split('_Patches')[0]
    mesh = bpy.data.meshes.new(nm); mesh.from_pydata(verts, [], faces); mesh.update()
    # SurfaceType as a native face attribute
    a = mesh.attributes.new('ssx_surface', 'INT', 'FACE')
    for i, s in enumerate(surf): a.data[i].value = s
    # TexturePath as material slots
    slot_paths = [None]*len(tex_slots)
    for path, slot in tex_slots.items(): slot_paths[slot] = path
    for path in slot_paths:
        mat = bpy.data.materials.get('ssx:'+path) or bpy.data.materials.new('ssx:'+path)
        mesh.materials.append(mat)
    for i, slot in enumerate(tex_of): mesh.polygons[i].material_index = slot

    obj = bpy.data.objects.new(nm, mesh); bpy.context.collection.objects.link(obj)
    obj['ssx_rows'] = R; obj['ssx_cols'] = C
    obj['ssx_handles'] = json.dumps(overrides)
    obj['ssx_meta'] = json.dumps(meta)
    obj['ssx_tex_slots'] = json.dumps(slot_paths)
    return obj

# ---- export: edited cage -> Patches.json ----
def export_level(obj, json_path):
    R, C = int(obj['ssx_rows']), int(obj['ssx_cols'])
    overrides = json.loads(obj['ssx_handles'])
    meta = json.loads(obj['ssx_meta'])
    slot_paths = json.loads(obj['ssx_tex_slots'])
    mesh = obj.data

    # corner grid back from the (possibly edited) mesh verts
    P = [[None]*C for _ in range(R)]
    for r in range(R):
        for c in range(C):
            P[r][c] = editor_from_blender(tuple(mesh.vertices[r*C+c].co))
    hUp, hUm, hVp, hVm = grid_tangents(P, R, C, overrides)
    surf_attr = mesh.attributes['ssx_surface'].data

    patches = []
    fi = 0
    for r in range(R-1):
        for c in range(C-1):
            cp = cell_control_points(P, hUp, hUm, hVp, hVm, r, c)
            md = meta["%d,%d" % (r, c)]
            patches.append({
                'PatchName': "Cell_r%d_c%d" % (r, c),
                'LightMapPoint': md['LightMapPoint'],
                'UVPoints': md['UVPoints'],
                'Points': [list(to_raw(q)) for q in cp],
                'SurfaceType': int(surf_attr[fi].value),
                'TrickOnlyPatch': md['TrickOnlyPatch'],
                'TexturePath': slot_paths[mesh.polygons[fi].material_index],
                'LightmapID': md['LightmapID'],
            })
            fi += 1
    with open(json_path, 'w') as f:
        json.dump({'Patches': patches}, f, separators=(',', ':'))
    return len(patches)

# ---- verification: import -> export -> diff the geometry ----
def round_trip_test(json_path, out_path=None):
    import tempfile, os
    out_path = out_path or os.path.join(tempfile.gettempdir(), 'ssx_roundtrip.json')
    obj = import_level(json_path)
    n = export_level(obj, out_path)
    with open(json_path) as f: a = {p['PatchName']: p for p in json.load(f)['Patches']}
    with open(out_path) as f: b = {p['PatchName']: p for p in json.load(f)['Patches']}
    max_pt = 0.0; max_field = None; nfield = 0
    for name, pa in a.items():
        pb = b[name]
        for i in range(16):
            for k in range(3):
                d = abs(pa['Points'][i][k] - pb['Points'][i][k])
                if d > max_pt: max_pt = d
        for key in ('SurfaceType', 'TexturePath', 'TrickOnlyPatch', 'LightmapID', 'UVPoints', 'LightMapPoint'):
            if pa.get(key) != pb.get(key): nfield += 1; max_field = key
    return {
        'patches': n,
        'corner_grid': [obj['ssx_rows'], obj['ssx_cols']],
        'handle_overrides_captured': len(json.loads(obj['ssx_handles'])),
        'max_control_point_error_cm': round(max_pt, 9),     # raw space is cm
        'nongeo_field_mismatches': nfield,
        'last_mismatch_field': max_field,
    }
