"""
Check `slopesmith_bridge.py`'s conversion logic without Blender.

The TypeScript suite (`test/blender-bridge.test.ts`, `test/blender-routes.test.ts`) pins down everything on
the Slopesmith side of the round trip. It cannot reach the add-on, and the add-on owns the two things most
likely to be silently wrong: the Y-up <-> Z-up conversion, and turning a Blender mesh back into a portal
payload. Both fail PLAUSIBLY — a mirrored conversion still produces a model, one that lights inside out.

So `bpy` is stubbed to whatever the module touches at import, a fake mesh is built in the shape of Blender's
real data model, and the add-on's own functions are run against it. Nothing here mocks the code under test.

    python blender/check_bridge.py        # exits non-zero on failure

Not in `npm test`: the gate is `test/*.test.ts` and does not depend on a Python interpreter (docs/024). Run
it when the add-on changes — it takes a fraction of a second.
"""
import json
import sys
import types
from pathlib import Path

# ---- the smallest bpy that lets the module import --------------------------------------------------------
bpy = types.ModuleType("bpy")
props = types.ModuleType("bpy.props")
for _name in ("BoolProperty", "CollectionProperty", "IntProperty", "StringProperty", "PointerProperty",
              "FloatProperty", "EnumProperty"):
    setattr(props, _name, lambda **_kw: None)
bpy.props = props

bpy_types = types.ModuleType("bpy.types")
for _name in ("AddonPreferences", "Operator", "Panel", "PropertyGroup", "UIList"):
    setattr(bpy_types, _name, type(_name, (), {}))
bpy.types = bpy_types
bpy.utils = types.SimpleNamespace(register_class=lambda _c: None, unregister_class=lambda _c: None)
bpy.data = types.SimpleNamespace(materials={}, images={}, meshes={}, objects={})
bpy.ops = types.SimpleNamespace()
sys.modules["bpy"] = bpy
sys.modules["bpy.props"] = props
sys.modules["bpy.types"] = bpy_types

BRIDGE = Path(__file__).with_name("slopesmith_bridge.py")
bridge = types.ModuleType("slopesmith_bridge")
bridge.__file__ = str(BRIDGE)
exec(compile(BRIDGE.read_text(encoding="utf-8"), str(BRIDGE), "exec"), bridge.__dict__)

failures = []


def check(ok, label):
    try:
        print(("ok   " if ok else "FAIL ") + label)
    except UnicodeEncodeError:                                   # a console that is not UTF-8
        print(("ok   " if ok else "FAIL ") + label.encode("ascii", "replace").decode())
    if not ok:
        failures.append(label)


# ---- 1. the space conversion -------------------------------------------------------------------------------
to_b, from_b = bridge._to_blender, bridge._from_blender
check(from_b(*to_b(1, 2, 3)) == (1, 2, 3), "portal -> Blender -> portal is the identity")
check(to_b(0, 1, 0) == (0, 0, 1), "portal +Y (up) becomes Blender +Z (up)")

# The determinant of the matrix whose COLUMNS are the images of the basis vectors. It must be +1: a proper
# rotation preserves winding, and a mirror here would invert every normal the artist works against while
# leaving the model looking perfectly fine in Blender's viewport.
c1, c2, c3 = to_b(1, 0, 0), to_b(0, 1, 0), to_b(0, 0, 1)
det = (c1[0] * (c2[1] * c3[2] - c2[2] * c3[1])
       - c2[0] * (c1[1] * c3[2] - c1[2] * c3[1])
       + c3[0] * (c1[1] * c2[2] - c1[2] * c2[1]))
check(abs(det - 1.0) < 1e-12, f"the conversion is a PROPER rotation (det = {det:+.0f}) — winding is preserved")


# ---- 2. a fake mesh, shaped like Blender's real data model ---------------------------------------------------
class Co(tuple):
    x = property(lambda self: self[0])
    y = property(lambda self: self[1])
    z = property(lambda self: self[2])


class Identity:
    """`obj.matrix_world @ v.co` with no transform."""
    def __matmul__(self, co): return Co(co)


class Shift:
    """A moved object, so "the world matrix is baked in" is exercised rather than assumed."""
    def __init__(self, *d): self.d = d

    def __matmul__(self, co): return Co(tuple(co[i] + self.d[i] for i in range(3)))


class UvLayer:
    def __init__(self, loops):
        self.data = [types.SimpleNamespace(uv=(0.0, 0.0)) for _ in loops]


class UvLayers:
    """`mesh.uv_layers`: an active layer plus a `new()` that returns a fresh per-LOOP one."""
    def __init__(self, mesh):
        self.mesh, self.active, self.made = mesh, None, []

    def new(self, name=""):
        layer = UvLayer(self.mesh.loops)
        layer.name = name
        self.made.append(layer)
        if self.active is None:
            self.active = layer
        return layer


class Mesh:
    def __init__(self, verts, faces, uvs=None, materials=()):
        self.vertices = [types.SimpleNamespace(co=Co(v)) for v in verts]
        self.loops, self.polygons = [], []
        for face in faces:
            start = len(self.loops)
            self.loops.extend(types.SimpleNamespace(vertex_index=i) for i in face)
            self.polygons.append(types.SimpleNamespace(
                loop_indices=list(range(start, len(self.loops))), material_index=0))
        self.materials = list(materials)
        self.uv_layers = UvLayers(self)
        if uvs is not None:
            self.uv_layers.active = types.SimpleNamespace(
                data=[types.SimpleNamespace(uv=uvs[loop.vertex_index]) for loop in self.loops])


class Material(dict):
    """A Blender material is a dict of custom properties with a name and a node tree hanging off it."""
    def __init__(self, name, image=None):
        super().__init__()
        self.name = name
        self.use_nodes = image is not None
        self.node_tree = None
        if image is not None:
            node = types.SimpleNamespace(type="TEX_IMAGE", image=image)
            principled = types.SimpleNamespace(type="BSDF_PRINCIPLED")
            link = types.SimpleNamespace(to_node=principled, from_node=node,
                                         to_socket=types.SimpleNamespace(name="Base Color"))
            self.node_tree = types.SimpleNamespace(nodes=[principled, node], links=[link])


class Obj(dict):
    def __init__(self, name, mesh, matrix):
        super().__init__()
        self.name, self.data, self.matrix_world = name, mesh, matrix


STAMP = {"v": 1, "kind": "model", "id": 3, "name": "Test cube", "project": "p", "unit": "m"}
# The same cube the TypeScript suite measures, in PORTAL space.
PORTAL_VERTS = [0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1, 0, 1, 0, 1, 1, 0, 0, 1, 1, 1, 1, 1]
PORTAL_FACES = [[0, 1, 3, 2], [4, 6, 7, 5], [2, 3, 7, 6], [0, 4, 5, 1], [1, 5, 7, 3], [0, 2, 6, 4]]
blender_verts = [to_b(*PORTAL_VERTS[i:i + 3]) for i in range(0, len(PORTAL_VERTS), 3)]


def stamped(mesh, matrix=None, cage=True, stamp=None, anchor=None):
    obj = Obj("Test cube", mesh, matrix or Identity())
    obj[bridge.STAMP_KEY] = json.dumps(stamp or STAMP)
    obj[bridge.CAGE_KEY] = cage
    if anchor is not None:
        obj[bridge.ANCHOR_KEY] = json.dumps(anchor)
    return obj


def face_positions(verts, faces):
    """Faces as tuples of POSITIONS. The add-on renumbers vertices in first-encountered order — correctly, and
    consistently across faces — so what must hold is the solid, not the index."""
    return [tuple(tuple(verts[i * 3:i * 3 + 3]) for i in face) for face in faces]


payload = bridge._portal_from_object(stamped(Mesh(blender_verts, PORTAL_FACES), anchor=[12, 3, -4]))
check(len(payload["verts"]) == len(PORTAL_VERTS),
      "a cage serialises back with the same WELDED vertex count — no corner is split")
check(face_positions(payload["verts"], payload["faces"]) == face_positions(PORTAL_VERTS, PORTAL_FACES),
      "and every quad comes back at the same corners, in the same order (the derived tile UVs read off it)")
check("uvs" not in payload, "with no UV layer — a cage's UVs are derived, not carried")
check(payload["anchor"] == [12, 3, -4] and payload["cage"] is True,
      "the anchor and the cage flag ride back with it")
check(payload["stamp"]["id"] == 3, "and so does the stamp that says which model it lands on")

# ---- 3. the object transform is baked in -----------------------------------------------------------------------
lifted = bridge._portal_from_object(stamped(Mesh(blender_verts, PORTAL_FACES), Shift(0, 0, 2.5)))
check(all(abs(lifted["verts"][i + 1] - (PORTAL_VERTS[i + 1] + 2.5)) < 1e-9
          for i in range(0, len(PORTAL_VERTS), 3)),
      "moving the OBJECT in Blender moves the model — Blender +Z lands as portal +Y, two and a half metres up")

# ---- 4. a textured push splits corners by (vertex, uv) ------------------------------------------------------------
tri = Mesh([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [[0, 1, 2]], {0: (0.0, 0.0), 1: (1.0, 0.0), 2: (0.0, 1.0)})
packed = bridge._portal_from_object(stamped(tri, cage=False, stamp={**STAMP, "kind": "import", "id": 7}))
check(len(packed["uvs"]) == len(packed["verts"]) // 3 * 2,
      "a textured push carries exactly one UV per vertex, which is what the wire format holds")
check(abs(packed["uvs"][1] - 1.0) < 1e-9 and abs(packed["uvs"][3] - 1.0) < 1e-9,
      "V flips back to glTF's top-down convention on the way out")
check(packed["faceMaterial"] == [0], "and every face reports the slot it wears")

# ---- 5. an object that never came from Slopesmith is refused ---------------------------------------------------------
try:
    bridge._portal_from_object(Obj("Cube.001", Mesh(blender_verts, PORTAL_FACES), Identity()))
    check(False, "an unstamped object is refused")
except RuntimeError as error:
    check("did not come from Slopesmith" in str(error),
          "an unstamped object is refused by name rather than pushed at model 0")


# ---- 6. the slot table, which is how a texture push is addressed ---------------------------------------------
# The service does not trust this table for geometry — a record's materials are its own — but it reads `tex`
# to decide whether new art REPLACES the tile a slot wears or FORKS a copy of it. A slot that reported the
# wrong ref would either overwrite somebody's reference art or scatter needless copies through Custom.
class Image(dict):
    def __init__(self, name):
        super().__init__()
        self.name = name


tile = Image("lamp.png")
stamped_material = Material("OpenSlope Custom/lamp.png", tile)
stamped_material[bridge.TEX_KEY] = "Custom/lamp.png"
glb_material = Material("GARI/0012.png", Image("0012.png"))          # arrived through File -> Import glTF
bare_material = Material("Material.001", Image("scratch"))           # made by hand in Blender

textured = Mesh([(0, 0, 0), (1, 0, 0), (0, 1, 0)], [[0, 1, 2]], {0: (0, 0), 1: (1, 0), 2: (0, 1)},
                materials=[stamped_material, glb_material, bare_material])
table = bridge._slot_table(Obj("Lamp", textured, Identity()))
check([row["tex"] for row in table] == ["Custom/lamp.png", "GARI/0012.png", None],
      "each slot reports the tile it wears — from OpenSlope_tex, or from a ref-shaped material name off a GLB")

# "Custom" is Slopesmith's fixed word for THIS mountain's own bank (its refs resolve to that mountain's
# assets/textures, shared with nothing), so the artist reads its tiles by file name while a borrowed one keeps
# the level it is borrowed from. The full ref still travels — display and identity are not the same string.
check((bridge._short_ref("Custom/lamp.png"), bridge._short_ref("GARI/0012.png"))
      == ("lamp.png", "GARI/0012.png"),
      "the mountain's own tiles read as bare file names; a borrowed one keeps the bank that owns it")
check(bridge._material_ref(Material("OpenSlope SMOKEMTN/0106.png")) == "",
      "and one of our OWN labels is never read back as a ref — it is ref-shaped by accident")
check([row["id"] for row in table] == [0, 1, 2],
      "keyed by SLOT index, which is what `faceMaterial` names and what the service matches back on")
check(bridge._material_image(stamped_material) is tile,
      "and the image a slot's Base Color reads is the one Texture Paint puts strokes on")
check(bridge._material_image(Material("clay")) is None,
      "an untextured slot offers no image, so an ordinary geometry push carries no art")

# The staging RULE: an image whose signature still matches is not re-uploaded. The encoder itself is Blender's
# `Image.save` and cannot be exercised without Blender, so it is stood in for here — what is under test is the
# decision, which is the part that can silently replace every one of an artist's textures with a recompressed
# copy of itself if it gets "unchanged" wrong.
bridge._image_png = lambda image: b"PNG:" + image.name.encode()
tile[bridge.SIG_KEY] = bridge._digest(bridge._image_png(tile))
payload = {"materials": table}
staged = bridge._stage_textures(Obj("Lamp", textured, Identity()), payload)
check("png" not in payload["materials"][0],
      "a tile whose signature still matches is not sent — an unedited texture is never re-uploaded")
check(all(row.get("png") for row in payload["materials"][1:]) and len(staged) == 2,
      "while a tile with no signature, or a changed one, rides along with the mesh")
check(all(bridge.SIG_KEY not in image for image, _ in staged),
      "and its new signature is only RETURNED — stamping before the service answers would lose a failed push")


# ---- 7. a cage gets the mapping Slopesmith derives, so its tile is paintable ------------------------------------
cage_mesh = Mesh(blender_verts, PORTAL_FACES)
bridge._build_cage_uvs(cage_mesh)
made = cage_mesh.uv_layers.made[0]
check(made.name == bridge.CAGE_UV_LAYER, "a cage's derived UV layer says in its name that it is not pushed")
check([tuple(made.data[i].uv) for i in range(4)] == list(bridge.CAGE_QUAD_UV),
      "every quad spans the full 0-1 tile with no inset (docs/028 — so a UV scroll flows unbroken)")
check("uvs" not in bridge._portal_from_object(stamped(cage_mesh)),
      "and it is still never read back: the document derives it again at bake time")

print()
if failures:
    print(f"{len(failures)} failure(s)")
    sys.exit(1)
print("check_bridge: all checks passed")
