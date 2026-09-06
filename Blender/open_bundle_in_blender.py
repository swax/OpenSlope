"""
Open an extracted SSX *bundle* (snowknife glTF .glb + manifest + textures) in the
Blender GUI, fully textured, ready to look at or edit.

Run via the Blender executable (NOT --background) so the window stays open:
  blender --python open_bundle_in_blender.py -- <bundleDir>

<bundleDir> is the gltf/ folder snowknife's `gltf` step wrote - either the
Maps intermediate (e.g. Maps/MYLEVEL/gltf) or a project copy from
`snowknife unity` (e.g. .../Assets/OpenSlope/Maps/MYLEVEL/gltf); both lay out the same. It
contains terrain.glb / props.glb / collision.glb, manifest.json, and
LightmapAtlas.png; the texture PNGs live one level up in the level's finished
Textures/ - the single set Unity and Blender share. The companion
open-bundle.ps1 locates blender.exe and calls this.

Why a dedicated script (vs the OBJ open_in_blender.py): the .glb files are
written in STANDARD glTF space (Y-up, right-handed, metres - see
GltfMeshWriter.cs), so the glTF importer tips them upright and to true scale with
NO axis fiddling. But the textures are NOT embedded - each glb material is named
after its PNG ("0012.png") and authored white/unlit, with the actual images
sitting in Textures/ and their alpha mode (opaque/cutout/blend) in manifest.json.
This script reconnects them by name and applies the alpha mode, then optionally
multiplies the baked LightmapAtlas (sampled through the 2nd UV set, TEXCOORD_1)
over the base colour to recover the baked lighting.
"""
import bpy
import sys
import os
import re
import json

# ---- config (override the bundle dir on the command line: -- <bundleDir>) ----
GLB_FILES = ["terrain.glb", "props.glb"]   # add "collision.glb" to see the collision proxies
HOOK_LIGHTMAP = True                       # True = multiply baked LightmapAtlas.png (UV1) over the base texture
                                            #        (start False so flat base textures are clearly visible)
UNLIT = False                               # False = Principled (relightable); True = Emission (game-faithful flat)
POINT_FILTER = True                         # True = nearest-neighbour, matching the importer's Point sampling

# ---- args ----------------------------------------------------------------
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
bundle_dir = os.path.abspath(argv[0]) if argv else os.getcwd()
# The PNGs live in the level's Textures/, one level up from gltf/ - `gltf` writes no copy of its own, so
# Unity and Blender read the same finished set. A Textures/ sitting beside the .glb (a bundle built
# before that layout) still wins if present.
tex_dir = os.path.join(bundle_dir, "Textures")
if not os.path.isdir(tex_dir):
    tex_dir = os.path.join(os.path.dirname(bundle_dir), "Textures")
manifest_path = os.path.join(bundle_dir, "manifest.json")

manifest = {}
if os.path.exists(manifest_path):
    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)
else:
    print(f"WARN no manifest.json in {bundle_dir} - textures' alpha modes unknown")

# filename -> "opaque" | "cutout" | "blend" | "glow" (light-halo sheet; blends)
alpha_map = {t["File"]: t.get("Alpha", "opaque") for t in (manifest.get("Textures") or [])}

# material-slot name -> snowknife's authoritative resolution {Texture, Alpha, Flipbook, FlipFps, Scroll}.
# This is the primary texture source (covers terrain + props); the .mtl below is only a legacy fallback.
mat_records = {x["Name"]: x for x in (manifest.get("Materials") or [])}


def load_mtl_map(level_dir):
    """Map material name -> texture filename by parsing any *.mtl beside the bundle.

    Terrain glb materials are named after their PNG ("0012.png") so they self-resolve, but PROP
    glb materials are named by OBJ slot ("mat_103", "mat_108_scr0", "mat_crowd") with no texture
    hint in the bundle - the level's Props.mtl carries 'newmtl <name> ... map_Kd Textures/<file>',
    so parse it. Lives one dir up from the bundle (e.g. .../gari/Props.mtl)."""
    m = {}
    if not os.path.isdir(level_dir):
        return m
    for fn in os.listdir(level_dir):
        if not fn.lower().endswith(".mtl"):
            continue
        cur = None
        with open(os.path.join(level_dir, fn), "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if line.startswith("newmtl "):
                    cur = line[7:].strip()
                elif line.startswith("map_Kd") and cur:
                    m[cur] = os.path.basename(line.split()[-1].replace("\\", "/"))
    return m


level_dir = os.path.dirname(bundle_dir)
mtl_map = load_mtl_map(level_dir) if not mat_records else {}   # only needed as a fallback
print(f"INFO  {len(mat_records)} manifest material records"
      + (f" (primary)" if mat_records else f"; falling back to {len(mtl_map)} .mtl entries from {level_dir}"))

# baked lightmap atlas (optional)
lightmap_img = None
if HOOK_LIGHTMAP and manifest.get("Lightmap"):
    lm_path = os.path.join(bundle_dir, manifest["Lightmap"].get("Atlas", "LightmapAtlas.png"))
    if os.path.exists(lm_path):
        lightmap_img = bpy.data.images.load(lm_path, check_existing=True)
    else:
        print(f"WARN lightmap atlas not found: {lm_path}")


# ---- clean default scene (cube/camera/light) ------------------------------
for o in list(bpy.data.objects):
    bpy.data.objects.remove(o, do_unlink=True)


def import_glb(name, collection_name):
    """Import one .glb and move its new objects into a named collection."""
    path = os.path.join(bundle_dir, name)
    if not os.path.exists(path):
        print(f"WARN missing {path}")
        return []
    before = set(bpy.data.objects)
    # glTF importer default converts the file's +Y-up to Blender's +Z-up and keeps metres.
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]

    coll = bpy.data.collections.new(collection_name)
    bpy.context.scene.collection.children.link(coll)
    for o in new:
        for c in list(o.users_collection):
            c.objects.unlink(o)
        coll.objects.link(o)
    print(f"RESULT imported {len(new)} objects into '{collection_name}'")
    return new


imported = []
for glb in GLB_FILES:
    kind = os.path.splitext(glb)[0].capitalize()   # "terrain.glb" -> "Terrain"
    imported += import_glb(glb, kind)


# ---- texture reconnection -------------------------------------------------
def strip_dup(name):
    """Drop Blender's '.001' duplicate-datablock suffix so '0012.png.001'/'mat_10.001' resolve."""
    return re.sub(r"\.\d{3}$", "", name)


def resolve_material(mat_name):
    """Material name -> (texture PNG, alpha mode) or None.

    PRIMARY source is the manifest 'Materials' section: snowknife's authoritative resolution (the same
    MaterialFactory.Resolve the Unity importer uses), covering both terrain ('0012.png') and prop
    ('mat_103') slots, with the correct per-material alpha. The .mtl/heuristic paths below are only a
    fallback for an older bundle that predates the Materials section - note they get ~10 prop textures
    WRONG (the .mtl is a naive mat_N->00NN.png guess; MaterialID is not the texture index)."""
    key = strip_dup(mat_name)
    rec = mat_records.get(key)
    if rec and rec.get("Texture"):
        return rec["Texture"], rec.get("Alpha", "opaque")
    # ---- fallbacks (bundle without a Materials section) ----
    if key.lower().endswith(".png") and os.path.exists(os.path.join(tex_dir, key)):
        return key, alpha_map.get(key, "opaque")           # terrain: name is the file
    if key in mtl_map:                                     # props via .mtl (approximate)
        f = mtl_map[key]
        return f, alpha_map.get(f, "opaque")
    mm = re.match(r"^mat_(\d+)", key)                      # last resort: mat_<N> -> 00NN.png
    if mm:
        cand = f"{int(mm.group(1)):04d}.png"
        if os.path.exists(os.path.join(tex_dir, cand)):
            return cand, alpha_map.get(cand, "opaque")
    return None


def detect_uv(objs, idx):
    """Name of UV layer `idx` (0 = base TEXCOORD_0, 1 = lightmap TEXCOORD_1) on the imported meshes."""
    for o in objs:
        if o.type == "MESH" and len(o.data.uv_layers) > idx:
            return o.data.uv_layers[idx].name
    return None


def make_multiply(nt):
    """A MULTIPLY colour-mix node (unified Mix node, Blender 3.4+; legacy MixRGB is gone in 5.x).
    The Mix node carries Float/Vector/Color variants of every socket, so pick by (type, name)
    rather than index - the index order has shifted between versions. Returns (node, inA, inB, out)."""
    n = nt.nodes.new("ShaderNodeMix")
    n.data_type = "RGBA"
    n.blend_type = "MULTIPLY"

    def pick(sockets, typ, name):
        return next(s for s in sockets if s.type == typ and s.name == name)

    pick(n.inputs, "VALUE", "Factor").default_value = 1.0
    return (n,
            pick(n.inputs, "RGBA", "A"),
            pick(n.inputs, "RGBA", "B"),
            pick(n.outputs, "RGBA", "Result"))


def apply_blend(mat, alpha):
    """Set EEVEE transparency from the manifest alpha mode, across the 4.2 EEVEE-Next switch.
    5.x only has surface_render_method; <=4.1 only has blend_method - set whichever exists."""
    if alpha == "opaque":
        return
    if hasattr(mat, "surface_render_method"):              # Blender 4.2+ / 5.x (EEVEE Next)
        try:
            mat.surface_render_method = "BLENDED" if alpha in ("blend", "glow") else "DITHERED"
        except TypeError:
            pass
    if hasattr(mat, "blend_method"):                       # Blender <= 4.1 (legacy EEVEE)
        try:
            mat.blend_method = "CLIP" if alpha == "cutout" else "BLEND"
            if alpha == "cutout" and hasattr(mat, "alpha_threshold"):
                mat.alpha_threshold = 0.5
        except TypeError:
            pass
    if hasattr(mat, "show_transparent_back"):
        try:
            mat.show_transparent_back = False
        except (AttributeError, TypeError):
            pass


def setup_material(mat, uv0_name, uv1_name):
    res = resolve_material(mat.name)
    if not res:                                            # e.g. "__untextured", "collision", COLOR_0
        return "skip"
    fname, alpha = res
    img_path = os.path.join(tex_dir, fname)
    if not os.path.exists(img_path):
        print(f"WARN material '{mat.name}' -> '{fname}': not in {tex_dir}")
        return "missing"

    img = bpy.data.images.load(img_path, check_existing=True)

    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial"); out.location = (600, 0)
    tex = nt.nodes.new("ShaderNodeTexImage"); tex.location = (-500, 100)
    tex.image = img
    if POINT_FILTER:
        tex.interpolation = "Closest"
    if uv0_name:                                           # pin the base texture to TEXCOORD_0 explicitly
        uv0n = nt.nodes.new("ShaderNodeUVMap"); uv0n.location = (-900, 100); uv0n.uv_map = uv0_name
        nt.links.new(tex.inputs["Vector"], uv0n.outputs["UV"])

    if UNLIT:
        shader = nt.nodes.new("ShaderNodeEmission"); shader.location = (250, 0)
        base_in = "Color"
    else:
        shader = nt.nodes.new("ShaderNodeBsdfPrincipled"); shader.location = (250, 0)
        base_in = "Base Color"
        shader.inputs["Roughness"].default_value = 1.0
        for spec in ("Specular IOR Level", "Specular"):    # name changed across 3.x/4.x
            if spec in shader.inputs:
                shader.inputs[spec].default_value = 0.0
                break

    color_socket = tex.outputs["Color"]

    if lightmap_img is not None:
        lm_uv = nt.nodes.new("ShaderNodeUVMap"); lm_uv.location = (-900, -300)
        if uv1_name:
            lm_uv.uv_map = uv1_name
        lm = nt.nodes.new("ShaderNodeTexImage"); lm.location = (-500, -300)
        lm.image = lightmap_img
        nt.links.new(lm.inputs["Vector"], lm_uv.outputs["UV"])
        mul, in_a, in_b, mul_out = make_multiply(nt); mul.location = (-100, 0)
        nt.links.new(in_a, tex.outputs["Color"])
        nt.links.new(in_b, lm.outputs["Color"])
        color_socket = mul_out

    nt.links.new(shader.inputs[base_in], color_socket)
    nt.links.new(out.inputs["Surface"], shader.outputs[0])

    if alpha in ("cutout", "blend", "glow") and not UNLIT:
        nt.links.new(shader.inputs["Alpha"], tex.outputs["Alpha"])
    apply_blend(mat, alpha)
    return "ok"


uv0_name = detect_uv(imported, 0)
uv1_name = detect_uv(imported, 1)

# unique materials actually used by the imported objects
mats = []
seen = set()
for o in imported:
    if o.type != "MESH":
        continue
    for slot in o.material_slots:
        if slot.material and slot.material.name not in seen:
            seen.add(slot.material.name)
            mats.append(slot.material)

tally = {"ok": 0, "missing": 0, "skip": 0}
resolved_mats = set()
for mat in mats:
    r = setup_material(mat, uv0_name, uv1_name)
    tally[r] += 1
    if r == "ok":
        resolved_mats.add(mat.name)
print(f"RESULT textured {tally['ok']} materials "
      f"({tally['missing']} missing texture, {tally['skip']} non-texture mats); "
      f"lightmap={'on' if lightmap_img else 'off'}, uv0='{uv0_name}', uv1='{uv1_name}'")

# Hide collision-proxy meshes (e.g. terrain.glb's TerrainCol_* shells): a mesh whose every material
# failed to resolve to a texture is a collider, not something to look at - tuck it away in the viewport.
hidden = 0
for o in imported:
    if o.type != "MESH":
        continue
    if not any(s.material and s.material.name in resolved_mats for s in o.material_slots):
        o.hide_set(True)
        hidden += 1
if hidden:
    print(f"RESULT hid {hidden} untextured (collision-proxy) objects")


# ---- viewport: clip planes, shading, framing ------------------------------
for screen in bpy.data.screens:
    for area in screen.areas:
        if area.type != "VIEW_3D":
            continue
        for space in area.spaces:
            if space.type == "VIEW_3D":
                space.clip_start = 0.1            # metres now (scale baked in), so modest planes
                space.clip_end = 100_000.0
                space.shading.type = "MATERIAL"   # show the reconnected textures
                space.shading.show_cavity = True

for window in bpy.context.window_manager.windows:
    done = False
    for area in window.screen.areas:
        if area.type != "VIEW_3D":
            continue
        region = next((r for r in area.regions if r.type == "WINDOW"), None)
        if region is None:
            continue
        with bpy.context.temp_override(window=window, area=area, region=region):
            bpy.ops.object.select_all(action="SELECT")
            bpy.ops.view3d.view_all(center=False)
        done = True
        break
    if done:
        break

print(f"RESULT ready: {len(imported)} objects from {bundle_dir}")
