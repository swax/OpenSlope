"""
slopesmith_bridge — the Blender end of Slopesmith's escape hatch (docs/046-blender-bridge.md).

Install this file as an add-on (Edit -> Preferences -> Add-ons -> Install...), point it at the running
Slopesmith service, and a "Slopesmith" tab appears in the 3D view's N-panel: refresh the list, PULL a model
out of the open mountain, do the thing that was hard to do with the mesh tools, PUSH it back. The model keeps
its number and its name, so every placement of it on the mountain follows the new geometry and any effects
attached to those placements stay attached.

Two libraries come through, and they behave differently on purpose:

  * an AUTHORED MODEL (docs/028) is a quad cage. It arrives as real quads and goes back as real quads, so a
    round trip through Blender does not cost you the cage — and its UVs are DERIVED from the quad corners
    (one tile, full 0-1 per quad). A copy of that mapping is built here so the tile is visible and paintable,
    but it is never read back: the document derives it again at bake time.
  * an IMPORTED PROP (docs/032) is a triangle mesh with a material table. Geometry and UVs round-trip, and the
    material table is matched back by SLOT.

Textures
--------
Each slot's tile arrives as a real image on a Principled BSDF, so Texture Paint works on it directly. A tile
you EDIT here rides home with the mesh; a tile you leave alone is never re-uploaded, which is why an ordinary
geometry push cannot disturb art that other props share. "Edited" is decided by comparing the image against
a signature stamped when it was pulled — both sides through Blender's own PNG encoder, so a re-save is not
mistaken for a change.

Where it lands is Slopesmith's call, and it follows the same line the rest of the editor draws: one of your
own Custom tiles is REPLACED (everything wearing it follows), while an extracted level's tile is FORKED into
your Custom bank so the reference is never written.

Nothing but `bpy` and the standard library is imported: an add-on that needs `pip install` is an add-on that
does not get installed.

Space
-----
Slopesmith speaks glTF's convention on the wire: metres, Y-up, right-handed. Blender is Z-up. The conversion
is a proper rotation (`(x, y, z) -> (x, -z, y)`), so it preserves winding and no index has to be reversed —
which is worth stating because the OTHER frame change in this pipeline, editor to raw SSX space, is a MIRROR
and does reverse it (docs/032). The server owns that one. This file owns only Y-up <-> Z-up.
"""

bl_info = {
    "name": "Slopesmith Bridge",
    "author": "OpenSlope",
    "version": (1, 1, 0),
    "blender": (3, 6, 0),
    "location": "View3D > Sidebar (N) > Slopesmith",
    "description": "Pull a Slopesmith prop into Blender, edit its mesh and its tiles, push it back.",
    "doc_url": "https://github.com/swax/OpenSlope/blob/main/Slopesmith/docs/046-blender-bridge.md",
    "category": "Import-Export",
}

import base64
import hashlib
import json
import os
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

import bpy
from bpy.props import BoolProperty, CollectionProperty, EnumProperty, IntProperty, StringProperty
from bpy.types import AddonPreferences, Operator, Panel, PropertyGroup, UIList

# The portal version this add-on speaks. The server refuses a payload from a newer one rather than guessing
# at a field it does not know, and says so in its error.
#
# Art was added to the format WITHOUT bumping this, because the change is additive in both directions: an
# older add-on simply sends no `png` and an older service drops the field. A version gate should refuse only
# what it must, and refusing every geometry pull over a texture feature nobody used would be exactly wrong.
# The one case it leaves — a new add-on pushing tiles at an old service — is caught after the fact, by
# noticing the answer reports none taken.
PORTAL_VERSION = 1

# Object custom properties. `OpenSlope_slopesmith` is also what the GLB export path writes into glTF `extras`, so a
# model that came in through File -> Import glTF carries the same stamp and can be pushed from here too.
STAMP_KEY = "OpenSlope_slopesmith"
ANCHOR_KEY = "OpenSlope_anchor"
CAGE_KEY = "OpenSlope_cage_model"
#: Written by the GLB route beside the stamp — the welded quad cage, for a model that arrived through
#: Blender's own glTF importer rather than through Pull.
CAGE_JSON_KEY = "OpenSlope_cage"
#: On a MATERIAL: the tile ref its slot wears ("Custom/lamp.png"), so a push can tell the service which tile
#: new art is new art FOR.
TEX_KEY = "OpenSlope_tex"
#: On an IMAGE: what it looked like when it arrived, so an untouched tile is never pushed back.
SIG_KEY = "OpenSlope_sig"

#: Pre-rename spellings of the keys above. A .blend saved — or a GLB exported — before the OpenSlope
#: rename still carries them, and losing the stamp would turn a pulled model into one that cannot be
#: pushed back. Reads accept either spelling; only the current key is ever written, so the next push
#: quietly migrates the file.
_LEGACY_KEYS = {
    STAMP_KEY: "SWX_slopesmith",
    ANCHOR_KEY: "SWX_anchor",
    CAGE_KEY: "SWX_cage_model",
    CAGE_JSON_KEY: "SWX_cage",
    TEX_KEY: "SWX_tex",
    SIG_KEY: "SWX_sig",
}

_MISSING = object()


def _prop(id_block, key, default=None):
    """One custom property off an object/material/image, accepting its pre-rename spelling."""
    if id_block is None:
        return default
    keys = id_block.keys()
    if key in keys:
        return id_block[key]
    legacy = _LEGACY_KEYS.get(key)
    if legacy is not None and legacy in keys:
        return id_block[legacy]
    return default


def _has_prop(id_block, key):
    """True when the property is present under either spelling."""
    return _prop(id_block, key, _MISSING) is not _MISSING

#: The name of the UV layer a cage gets so its tile is visible and paintable. Said in the name, because a
#: layer that looks authored but is thrown away on push would otherwise be a trap.
CAGE_UV_LAYER = "OpenSlope derived (not pushed)"

TIMEOUT = 30


# ---- transport ---------------------------------------------------------------------------------------

#: Where the service lives when this file is run as a script rather than installed as an add-on (Blender's
#: Text Editor -> Run Script), which has no preferences entry to read. `SLOPESMITH_URL` overrides both.
DEFAULT_SERVER = "http://127.0.0.1:5180"


def _base(context):
    override = os.environ.get("SLOPESMITH_URL")
    if override:
        return override.rstrip("/")
    entry = context.preferences.addons.get(__name__)
    server = getattr(entry.preferences, "server", "") if entry else ""
    return (server or DEFAULT_SERVER).rstrip("/")


def _key(context):
    """The personal access key for a hosted server, or "" for a loopback one that needs none."""
    override = os.environ.get("SLOPESMITH_KEY")
    if override:
        return override.strip()
    entry = context.preferences.addons.get(__name__)
    return (getattr(entry.preferences, "key", "") if entry else "").strip()


def _request(url, method="GET", body=None, key=""):
    """One HTTP round trip, with the service's `{"error": ...}` refusals raised as their own message.

    The service answers a refusal with a 400 and a reason meant to be shown verbatim — "that model was pulled
    from a different mountain", "51,000 triangles exceeds the 50,000 limit". Surfacing the reason instead of
    "HTTP Error 400: Bad Request" is the difference between an add-on you can use and one you have to read
    the server log to use.

    401 and 403 are the two that need translating rather than repeating, because the server's wording is
    written for a browser that can offer a sign-in form and this add-on cannot: what a person needs told here
    is which field to paste a key into (docs/046).
    """
    request = urllib.request.Request(url, data=body, method=method)
    if body is not None:
        request.add_header("Content-Type", "application/json")
    if key:
        request.add_header("Authorization", "Bearer %s" % key)
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as answer:
            return answer.read()
    except urllib.error.HTTPError as error:
        detail = ""
        try:
            detail = json.loads(error.read().decode("utf-8")).get("error", "")
        except Exception:
            pass
        if error.code == 401:
            raise RuntimeError(
                "this server wants an access key" if not key else
                "that access key is not valid any more — it may have been revoked; make a new one in "
                "Slopesmith under File > Settings > Access keys and paste it into this add-on's "
                "preferences")
        if error.code == 403:
            raise RuntimeError(detail or "your account is not allowed to do that on this server")
        raise RuntimeError(detail or "%s %s" % (error.code, error.reason))
    except urllib.error.URLError as error:
        raise RuntimeError(
            "cannot reach Slopesmith at %s (%s) — is the server running?" % (url, error.reason))


def _get_json(context, path):
    return json.loads(_request(_base(context) + path, key=_key(context)).decode("utf-8"))


def _post_json(context, path, payload):
    body = json.dumps(payload).encode("utf-8")
    return json.loads(_request(_base(context) + path, method="POST", body=body,
                               key=_key(context)).decode("utf-8"))


# ---- space -------------------------------------------------------------------------------------------

def _to_blender(x, y, z):
    """Portal (glTF: metres, Y-up) -> Blender (metres, Z-up). A proper rotation; winding is preserved."""
    return (x, -z, y)


def _from_blender(x, y, z):
    """Blender -> portal. The exact inverse of `_to_blender`."""
    return (x, z, -y)


# ---- the catalogue the panel lists -------------------------------------------------------------------

class SlopesmithModel(PropertyGroup):
    kind: StringProperty(name="Kind")
    model_id: IntProperty(name="Number")
    label: StringProperty(name="Name")
    level: StringProperty(name="Level")
    faces: IntProperty(name="Faces")
    verts: IntProperty(name="Vertices")
    cage: BoolProperty(name="Quad cage")


#: The mountain dropdown's items, held at module level on purpose. Blender does not own the strings an
#: `EnumProperty` items-callback returns, so a list built inside the callback can be collected while the UI is
#: still drawing it — the classic symptom is a menu of garbled labels.
_MAP_ITEMS = [("", "— refresh to list mountains —", "")]

#: Set while `_load_catalogue` assigns `map_id` itself, so writing the resolved mountain back into the
#: dropdown does not re-enter the update callback that loaded it.
_LOADING = False


def _map_items(_self, _context):
    return _MAP_ITEMS


def _map_changed(self, context):
    if _LOADING:
        return
    try:
        self.status = _load_catalogue(context, self)
    except RuntimeError as error:
        self.status = str(error)


class SlopesmithState(PropertyGroup):
    models: CollectionProperty(type=SlopesmithModel)
    index: IntProperty(name="Selected", default=0)
    map_id: EnumProperty(
        name="Mountain",
        description="Which mountain on the server to pull from. Every map the service holds is listed, not "
                    "only the one a browser tab has open",
        items=_map_items,
        update=_map_changed,
    )
    push_textures: BoolProperty(
        name="Push edited tiles",
        description="Send a slot's tile back when its image was painted on here. A tile you did not touch is "
                    "never re-uploaded; one of your Custom tiles is replaced and everything wearing it "
                    "follows, while an extracted level's tile forks into your Custom bank instead",
        default=True,
    )
    project: StringProperty(name="Mountain")
    #: The id behind `project`, which is what every later request carries — read off the server's answer
    #: rather than off the dropdown, so it is right even before anything has been picked.
    project_id: StringProperty(name="Mountain id")
    status: StringProperty(name="Status")


class SLOPESMITH_UL_models(UIList):
    # Blender has passed `draw_item` eight, nine and ten positional arguments across releases (index and
    # flt_flag came and went), so the tail is absorbed rather than named.
    def draw_item(self, _context, layout, _data, item, _icon, _active_data, _active_prop, *_rest):
        row = layout.row(align=True)
        # MESH_GRID / MESH_DATA stand in for the editor's own ▦ / ▽: a tiled prop wears one tile with its
        # mapping computed per quad, a textured one carries its own UV layout. Same two words either side.
        row.label(text=item.label, icon="MESH_GRID" if item.cage else "MESH_DATA")
        counts = row.row(align=True)
        counts.alignment = "RIGHT"
        counts.label(text="%s %s" % (f"{item.faces:,}", "quads" if item.cage else "tris"))


# ---- pull --------------------------------------------------------------------------------------------

def _digest(data):
    return hashlib.sha1(data).hexdigest()


def _image_png(image):
    """This image's pixels as PNG bytes, through Blender's OWN save path.

    Not `image.pixels`: that buffer is float, and whether its values are display-referred or scene-linear
    depends on whether the image ever acquired a float rect — which texture painting can cause. Reading it
    directly is therefore a fine way to send back art that is subtly darker than what the artist saw. `save`
    is the same code the Image editor's Save As runs, so the bank gets what was on screen.

    The datablock's own format and filepath are put back afterwards. This is an export, not a Save As, and an
    add-on that quietly re-pointed an artist's image at a file in the temp folder would be a bug found much
    later and blamed on something else.
    """
    path = os.path.join(tempfile.gettempdir(), "slopesmith_push_%s.png" % (abs(hash(image.name)) % 10**8))
    fmt, raw = image.file_format, image.filepath_raw
    try:
        image.file_format = "PNG"
        try:
            image.save(filepath=path)
        except TypeError:                                # an older API whose save() takes no arguments
            image.filepath_raw = path
            image.save()
    finally:
        image.file_format = fmt
        image.filepath_raw = raw
    with open(path, "rb") as file:
        return file.read()


def _stamp_signature(image):
    """Record what this image looks like as Slopesmith would store it, so a push can tell edited from
    untouched.

    Hashing the DOWNLOADED bytes would not do the job: Blender re-encodes on the way out, so a tile nobody
    touched would come back with a different digest and every geometry push would quietly replace the
    artist's textures with re-compressed copies of themselves. Both sides of the comparison go through the
    same encoder, so only real strokes register.
    """
    try:
        image[SIG_KEY] = _digest(_image_png(image))
    except Exception:
        pass                                             # no baseline; the push side treats that as changed


def _load_image(material, base):
    """Fetch a slot's tile and hang it off a Principled BSDF, so the model wears its art in the viewport —
    and so Texture Paint has something real to paint on.

    A tile that will not load is not fatal. Grey clay is exactly what an untextured model looks like in
    Slopesmith too, and refusing the whole pull over one missing page would be the wrong trade.
    """
    url = material.get("texUrl")
    if not url:
        return None
    try:
        raw = _request(base + url if url.startswith("/") else url)
    except RuntimeError:
        return None
    name = os.path.basename(urllib.parse.urlparse(url).path) or "tile"
    path = os.path.join(tempfile.gettempdir(), "slopesmith_%s_%s.png" % (
        abs(hash(material.get("tex") or name)) % 10**8, name.replace("?", "_")))
    try:
        with open(path, "wb") as file:
            file.write(raw)
        image = bpy.data.images.load(path, check_existing=True)
    except Exception:
        return None
    # `check_existing` hands back the datablock an earlier pull loaded from this same path, which has not
    # noticed the bytes just written to it. Re-read it so a second pull shows the tile as it is NOW — unless
    # there is unsaved paint on it, in which case the artist's work outranks a refresh they did not ask for.
    if not image.is_dirty:
        try:
            image.reload()
        except RuntimeError:
            pass
        _stamp_signature(image)
    elif not _has_prop(image, SIG_KEY):
        _stamp_signature(image)
    return image


def _short_ref(ref):
    """A tile ref as the artist should read it.

    "Custom" is Slopesmith's fixed word for THIS MOUNTAIN'S OWN tiles — `Custom/lamp.png` resolves to that
    mountain's `assets/textures/lamp.png` and nothing is shared between maps — so spelling it out on every
    material says nothing and reads like a folder somebody else can reach into. Its own tiles are therefore
    shown by file name alone. A tile borrowed from an extracted level KEEPS its bank, because that part is
    worth knowing: it is read-only, and painting on it forks a copy rather than changing it.

    The same rule the editor's own prop material rows follow (`ui/components/prop-materials.ts`).
    """
    level, _, name = (ref or "").partition("/")
    return name if level.lower() == "custom" and name else ref


def _attach_image(material, image):
    """Hang a tile off the material's Principled BSDF. Alpha is wired through because prop art is cut out far
    more often than it is solid — a fence with its alpha unconnected is a grey rectangle."""
    tree = material.node_tree
    principled = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    texture = tree.nodes.new("ShaderNodeTexImage")
    texture.image = image
    texture.location = (-320, 260)
    if principled is not None:
        tree.links.new(principled.inputs["Base Color"], texture.outputs["Color"])
        if "Alpha" in principled.inputs:
            tree.links.new(principled.inputs["Alpha"], texture.outputs["Alpha"])


def _material_for(spec, base, problems=None):
    """One Blender material per portal slot, named for the tile it wears so the slot list reads like the
    Texture Library does.

    Caching on the tile REF is safe rather than merely convenient: a stored name in Slopesmith addresses one
    set of bytes for good (docs/038), so art that changes gets a new ref and therefore a new material here.
    A reused label can never be showing a tile that has since become something else.
    """
    ref = spec.get("tex") or ""
    label = "OpenSlope %s" % (_short_ref(ref) or spec.get("name") or "clay")
    material = bpy.data.materials.get(label)
    # Reuse only when it is the SAME tile. Two mountains can each hold a `lamp.png` — each bank is that
    # mountain's own — and the label no longer spells them apart, so the REF decides. A stale match would
    # dress this prop in the other map's art, and `materials.new` suffixes the name for us.
    if material is not None and (_prop(material, TEX_KEY) or "") != ref:
        material = None
    if material is None:
        material = bpy.data.materials.new(label)
        material[TEX_KEY] = ref
        material.use_nodes = True
        # 4.2's EEVEE Next dropped "CLIP" from the blend-method enum. Cut-out art is the common case for a
        # prop sheet, so ask for it and fall back rather than deciding by version number.
        for method in ("CLIP", "BLEND"):
            try:
                material.blend_method = method
                break
            except (TypeError, AttributeError):
                continue

    # Fetch the art if this material has none yet — checked on EVERY pull, not only when the material is
    # first made. A tile that failed to fetch once (the service unreachable, an older service that did not
    # name the mountain in its tile URLs) would otherwise leave a grey material cached under this label for
    # the rest of the session, and every later pull would reuse it and reproduce the bug that was fixed.
    if spec.get("texUrl") and _material_image(material) is None:
        image = _load_image(spec, base)
        if image is None:
            # Named rather than swallowed. Grey clay is what an untextured prop looks like in Slopesmith too,
            # so a silently missing tile is indistinguishable from a prop that has none — which leaves the
            # artist with no way to tell "this has no art" from "your service could not hand me its art".
            if problems is not None:
                problems.append(_short_ref(ref) or label)
        else:
            _attach_image(material, image)
    return material


#: Where a quad cage's corners sit on its tile, in Blender's bottom-up V. The portal emits each quad as the
#: loop A, B, D, C with tile corners A(0,0) B(1,0) C(0,1) D(1,1) — the full 0-1 tile with no inset, so a UV
#: scroll flows unbroken across quads (docs/028). A wedge's third corner takes the tile's top centre, the
#: same place `authoredModelLevelProps` puts it.
CAGE_QUAD_UV = ((0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0))
CAGE_WEDGE_UV = ((0.0, 0.0), (1.0, 0.0), (0.5, 1.0))


def _build_cage_uvs(mesh):
    """Give a cage the mapping Slopesmith will derive for it anyway.

    It is not sent back — the document computes it from the corner positions at bake time, and a layer
    round-tripping alongside would be a second, divergent source of truth. It exists so the model WEARS its
    tile in the viewport and so Texture Paint has a surface to work on, which is most of what makes editing
    a tiled prop's art here possible at all.
    """
    layer = mesh.uv_layers.new(name=CAGE_UV_LAYER)
    for polygon in mesh.polygons:
        corners = CAGE_QUAD_UV if len(polygon.loop_indices) >= 4 else CAGE_WEDGE_UV
        for corner, loop_index in enumerate(polygon.loop_indices):
            layer.data[loop_index].uv = corners[min(corner, len(corners) - 1)]


def _build_object(context, portal):
    """Turn a portal payload into a Blender object: real polygons, real material slots, the stamp attached.

    Answers `(object, problems)` — `problems` naming any tile that could not be fetched, so the operator can
    say so rather than handing back a model that looks untextured for a reason nobody can see.
    """
    stamp = portal["stamp"]
    flat = portal["verts"]
    verts = [_to_blender(flat[i], flat[i + 1], flat[i + 2]) for i in range(0, len(flat), 3)]
    faces = [tuple(face) for face in portal["faces"] if len(face) >= 3]

    mesh = bpy.data.meshes.new(stamp["name"])
    mesh.from_pydata(verts, [], faces)
    mesh.update()

    base = _base(context)
    materials = portal.get("materials") or []
    problems = []
    for spec in materials:
        mesh.materials.append(_material_for(spec, base, problems))
    slots = portal.get("faceMaterial")
    if slots and len(materials) > 1:
        for index, polygon in enumerate(mesh.polygons):
            if index < len(slots):
                polygon.material_index = min(len(materials) - 1, max(0, int(slots[index])))

    # UVs travel per VERTEX on the wire and are per LOOP here, so a corner simply reads its vertex's pair.
    # A cage sends none at all: its UVs are derived from the quad corners at bake time, and a layer carried
    # back and forth would be a second answer to a question the document already answers.
    uvs = portal.get("uvs")
    if uvs:
        layer = mesh.uv_layers.new(name="UVMap")
        for loop in mesh.loops:
            at = loop.vertex_index * 2
            if at + 1 < len(uvs):
                layer.data[loop.index].uv = (uvs[at], 1.0 - uvs[at + 1])
    elif portal.get("cage"):
        _build_cage_uvs(mesh)

    obj = bpy.data.objects.new(stamp["name"], mesh)
    obj[STAMP_KEY] = json.dumps(stamp)
    obj[ANCHOR_KEY] = json.dumps(portal.get("anchor") or [0, 0, 0])
    obj[CAGE_KEY] = bool(portal.get("cage"))
    context.collection.objects.link(obj)
    return obj, problems


def _load_catalogue(context, state):
    """Ask the server what it holds, and fill both the mountain dropdown and the model list from one answer.

    Shared by the Refresh button and the dropdown's own update callback, so picking a mountain reloads its
    models without a second click. Asking with no `project` is what the add-on does before anything is
    picked, and the service answers about the mountain the editor has open — which stays the sensible
    default, now that it is a default rather than the only possibility.

    Raises `RuntimeError` with the reason; the callers put it in the status line.
    """
    global _MAP_ITEMS, _LOADING
    wanted = state.map_id
    answer = _get_json(context, "/api/blender" + ("?project=%s" % urllib.parse.quote(wanted) if wanted else ""))

    # "The server sent no list" and "the list is empty" are different problems with the same shape, and only
    # one of them is the author's to fix. A service started before the picker existed answers without the key
    # at all — and because `npm run dev` starts the API service ONCE (only Vite hot-reloads), that is what an
    # editor updated mid-session looks like from here. Saying so beats reporting a server full of mountains
    # as empty.
    stale = "maps" not in answer
    maps = [row for row in (answer.get("maps") or []) if row.get("id")]
    if maps:
        _MAP_ITEMS = [(row["id"], row.get("name") or row["id"], "") for row in maps]
    elif stale:
        _MAP_ITEMS = [("", "— server predates the picker · restart it —", "")]
    else:
        _MAP_ITEMS = [("", "— no mountains on this server —", "")]

    project = answer.get("project") or {}
    state.project = project.get("name", "")
    state.project_id = project.get("id", "")
    # Show which mountain actually answered. Guarded, because assigning the dropdown re-enters `_map_changed`
    # and would fetch the catalogue a second time for every refresh.
    if state.project_id and any(item[0] == state.project_id for item in _MAP_ITEMS):
        _LOADING = True
        try:
            state.map_id = state.project_id
        finally:
            _LOADING = False

    state.models.clear()
    for row in answer.get("models", []):
        item = state.models.add()
        item.kind = row.get("kind", "")
        item.model_id = int(row.get("id", 0))
        item.label = row.get("name", "")
        item.level = row.get("level", "")
        item.faces = int(row.get("faces", 0))
        item.verts = int(row.get("verts", 0))
        item.cage = bool(row.get("cage"))
    state.index = min(state.index, max(0, len(state.models) - 1))
    found = ("no models in %s — it holds terrain only" % state.project if not len(state.models)
             else "%d model%s in %s" % (
                 len(state.models), "" if len(state.models) == 1 else "s",
                 state.project or "the open mountain"))
    if stale:
        return found + " · this service was started before the mountain picker; restart `npm run dev` to list"\
                       " the server's other maps"
    return found + " · %d mountain%s on this server" % (len(maps), "" if len(maps) == 1 else "s")


class SLOPESMITH_OT_refresh(Operator):
    bl_idname = "slopesmith.refresh"
    bl_label = "Refresh"
    bl_description = "List this server's mountains, and the models the selected one can hand to Blender"

    def execute(self, context):
        state = context.scene.slopesmith
        try:
            state.status = _load_catalogue(context, state)
        except RuntimeError as error:
            state.status = str(error)
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        return {"FINISHED"}


class SLOPESMITH_OT_pull(Operator):
    bl_idname = "slopesmith.pull"
    bl_label = "Pull"
    bl_description = "Bring the selected model into this scene, ready to edit"

    def execute(self, context):
        state = context.scene.slopesmith
        if not (0 <= state.index < len(state.models)):
            self.report({"ERROR"}, "pick a model first")
            return {"CANCELLED"}
        wanted = state.models[state.index]
        # Named explicitly rather than left to the server's default: the list on screen belongs to the
        # selected mountain, and a browser tab switching maps between Refresh and Pull must not silently
        # fetch a different model under the same number.
        where = "&project=%s" % urllib.parse.quote(state.project_id) if state.project_id else ""
        try:
            portal = _get_json(context, "/api/blender/mesh?kind=%s&id=%d%s"
                               % (wanted.kind, wanted.model_id, where))
            if int(portal.get("stamp", {}).get("v", 0)) > PORTAL_VERSION:
                raise RuntimeError("that mountain speaks a newer bridge — update this add-on")
            obj, problems = _build_object(context, portal)
        except RuntimeError as error:
            state.status = str(error)
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}
        except Exception as error:                                  # a malformed payload, not a refusal
            state.status = "could not build that mesh: %s" % error
            self.report({"ERROR"}, state.status)
            return {"CANCELLED"}
        for other in context.selected_objects:
            other.select_set(False)
        obj.select_set(True)
        context.view_layer.objects.active = obj
        state.status = "pulled %s (%d faces)" % (obj.name, len(obj.data.polygons))
        if problems:
            # A tile the service would not hand over is reported as a WARNING, not swallowed. The prop is
            # still usable — grey clay is a legible stand-in and the geometry is the point — but "no texture"
            # with no explanation is the one outcome an artist cannot act on.
            state.status += (" · could not load %s — if this is your own art, restart the Slopesmith"
                             " service: one older than this add-on leaves the mountain out of its tile"
                             " URLs, and a Custom tile belongs to ONE mountain") % ", ".join(problems)
            self.report({"WARNING"}, state.status)
            return {"FINISHED"}
        self.report({"INFO"}, state.status)
        return {"FINISHED"}


# ---- push --------------------------------------------------------------------------------------------

def _material_ref(material):
    """The tile ref a slot wears, or "" when it wears none.

    Normally read off `OpenSlope_tex`, stamped at pull. A model that arrived through File -> Import glTF has no such
    property — but the GLB names each material for the tile it wears, so a ref-shaped name is taken at face
    value rather than losing the join and forking a needless copy of art the prop already had.
    """
    if material is None:
        return ""
    ref = _prop(material, TEX_KEY)
    if isinstance(ref, str) and ref:
        return ref
    name = material.name or ""
    # Never read one of OUR OWN labels back as a ref. `OpenSlope SMOKEMTN/0106.png` is ref-shaped by accident, and
    # a material this add-on made always carries `OpenSlope_tex` — so a label reaching here means the property was
    # lost, and inventing a ref out of display text would aim the push at a tile of that name.
    if name.startswith("OpenSlope "):
        return ""
    return name if "/" in name and name.lower().endswith(".png") else ""


def _material_image(material):
    """The image a slot's Base Color reads — the one Texture Paint puts strokes on."""
    if material is None or not material.use_nodes or material.node_tree is None:
        return None
    tree = material.node_tree
    principled = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if principled is not None:
        for link in tree.links:
            if link.to_node is principled and link.to_socket.name == "Base Color":
                image = getattr(link.from_node, "image", None)
                if image is not None:
                    return image
    # Nothing wired into a Principled, or no Principled at all. One image node is unambiguous and is what a
    # material assembled by hand usually looks like; several are a guess, and guessing which one the artist
    # meant is how the wrong texture ends up in somebody's bank.
    images = [n.image for n in tree.nodes if n.type == "TEX_IMAGE" and n.image is not None]
    return images[0] if len(images) == 1 else None


def _slot_table(obj):
    """The material table a push carries: one row per Blender slot, saying what it believes it wears.

    Geometry only — the art is attached separately by `_stage_textures`, so the payload this returns is the
    one every push sends and the tiles are the part that is opt-in.
    """
    rows = []
    for slot, material in enumerate(obj.data.materials):
        rows.append({
            "id": slot,
            "name": (material.name if material is not None else "slot %d" % slot),
            "tex": _material_ref(material) or None,
        })
    return rows


def _stage_textures(obj, payload):
    """Attach the art of every slot the artist actually edited, and report what to stamp once it lands.

    The comparison is against `SIG_KEY`, not against Blender's dirty flag: saving an image clears that flag,
    and an add-on that cleared it before knowing the push succeeded would drop the artist's texture work on
    the floor the first time the network hiccupped. A digest survives a failed push, so the next one retries.

    Signatures are returned rather than written here for the same reason — the caller stamps them only after
    the service has answered.
    """
    staged = []
    for row in payload.get("materials", []):
        slot = row.get("id", 0)
        if slot >= len(obj.data.materials):
            continue
        image = _material_image(obj.data.materials[slot])
        if image is None:
            continue
        try:
            png = _image_png(image)
        except Exception:
            continue                                     # an image Blender cannot write is not a push failure
        digest = _digest(png)
        if digest == _prop(image, SIG_KEY):
            continue                                     # untouched: never re-upload art that did not change
        row["png"] = base64.b64encode(png).decode("ascii")
        staged.append((image, digest))
    return staged


def _portal_from_object(obj):
    """Serialise an object back into a portal mesh.

    Two details carry the weight. The object's WORLD matrix is baked into the vertices, so moving or rotating
    the model here moves it on the mountain — an artist who dragged it two metres left meant that, and
    leaving the transform behind in Blender would silently discard it. And a textured push splits vertices by
    (vertex, uv): Blender's UVs live per face corner, the wire format carries them per vertex, and a corner
    that wanted two different tile positions has to become two vertices to keep both.
    """
    raw_stamp = _prop(obj, STAMP_KEY)
    stamp = json.loads(raw_stamp) if raw_stamp else None
    if not stamp:
        raise RuntimeError("%s did not come from Slopesmith — pull a model before pushing" % obj.name)

    # A model pulled through this panel carries `OpenSlope_anchor` and `OpenSlope_cage_model`. One that came in through
    # File -> Import glTF carries neither — but the GLB's node extras put `OpenSlope_cage` on the object, and its
    # presence is what says "this is a cage" while its `anchor` is the frame the vertices belong to. Reading
    # both shapes is what makes the download route in docs/046 a real path rather than a one-way trip.
    carried = {}
    raw_cage = _prop(obj, CAGE_JSON_KEY)
    if raw_cage:
        try:
            carried = json.loads(raw_cage) or {}
        except (TypeError, ValueError):
            carried = {}
    raw_anchor = _prop(obj, ANCHOR_KEY)
    anchor = json.loads(raw_anchor) if raw_anchor else carried.get("anchor") or [0, 0, 0]
    cage = bool(_prop(obj, CAGE_KEY, bool(carried)))

    mesh = obj.data
    matrix = obj.matrix_world
    uv_layer = None if cage else mesh.uv_layers.active

    verts = []
    uvs = [] if uv_layer else None
    faces = []
    slots = []
    seen = {}

    for polygon in mesh.polygons:
        loop = []
        for loop_index in polygon.loop_indices:
            vertex_index = mesh.loops[loop_index].vertex_index
            if uv_layer:
                uv = uv_layer.data[loop_index].uv
                key = (vertex_index, round(uv[0], 6), round(uv[1], 6))
            else:
                key = (vertex_index,)
            mapped = seen.get(key)
            if mapped is None:
                world = matrix @ mesh.vertices[vertex_index].co
                mapped = len(verts) // 3
                seen[key] = mapped
                verts.extend(_from_blender(world.x, world.y, world.z))
                if uvs is not None:
                    uv = uv_layer.data[loop_index].uv
                    uvs.extend((uv[0], 1.0 - uv[1]))
            loop.append(mapped)
        if len(loop) >= 3:
            faces.append(loop)
            slots.append(int(polygon.material_index))

    if not faces:
        raise RuntimeError("%s has no faces to push" % obj.name)

    payload = {
        "stamp": stamp,
        "anchor": anchor,
        "verts": verts,
        "faces": faces,
        "faceMaterial": slots,
        # What each slot BELIEVES it wears. The service keeps its own table (a record's materials are its
        # own), and reads this only to decide which tile a slot's new art is new art for.
        "materials": _slot_table(obj),
        "cage": cage,
    }
    if uvs is not None:
        payload["uvs"] = uvs
    return payload


class SLOPESMITH_OT_push(Operator):
    bl_idname = "slopesmith.push"
    bl_label = "Push"
    bl_description = "Send the active object's geometry back onto its Slopesmith model and every placement of it"

    def execute(self, context):
        state = context.scene.slopesmith
        obj = context.view_layer.objects.active
        if obj is None or obj.type != "MESH":
            self.report({"ERROR"}, "select the mesh you want to push")
            return {"CANCELLED"}
        # Mesh data is only trustworthy out of edit mode: Blender keeps live edits in a BMesh that has not
        # been written back to `obj.data` yet, so pushing from edit mode would send the mesh as it was.
        if obj.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        staged = []
        try:
            payload = _portal_from_object(obj)
            if state.push_textures:
                staged = _stage_textures(obj, payload)
            # Addressed by the STAMP's mountain, not by whatever the dropdown shows. A model pushes back to
            # where it came from even if the panel has since been pointed somewhere else — and the service
            # still checks the two agree, so this makes the honest case work without weakening that check.
            answer = _post_json(context, "/api/blender/mesh?project=%s"
                                % urllib.parse.quote(payload["stamp"].get("project", "")), payload)
        except RuntimeError as error:
            state.status = str(error)
            self.report({"ERROR"}, str(error))
            return {"CANCELLED"}

        # Only now, with the service's answer in hand: a signature written before this point would make a
        # failed push look like an unchanged tile, and the artist's paint would never be sent again.
        for image, digest in staged:
            image[SIG_KEY] = digest

        note = "pushed %s — %s face%s" % (
            answer.get("name", obj.name), f"{answer.get('faces', 0):,}",
            "" if answer.get("faces") == 1 else "s")
        if answer.get("pending"):
            note += "; waiting for the Slopesmith tab to apply it"
        if answer.get("fanned"):
            note += "; %d n-gon(s) split into quads" % answer["fanned"]
        if answer.get("dropped"):
            note += "; %d degenerate face(s) dropped" % answer["dropped"]
        if answer.get("addedMaterials"):
            note += "; %d new material slot(s)" % answer["addedMaterials"]
        if answer.get("textures"):
            note += "; %d tile(s) repainted" % answer["textures"]
            if answer.get("forkedTextures"):
                note += " (%d forked into Custom, the reference untouched)" % answer["forkedTextures"]
        elif staged:
            # Tiles went out and none came back accounted for. The likeliest cause by far is a service
            # started before texture push existed — `npm run dev` boots the API once, so an editor updated
            # mid-session looks exactly like this — and silence would read as success.
            note += "; the service took no tiles, so it may predate texture push — restart it"
        state.status = note
        self.report({"INFO"}, note)
        return {"FINISHED"}


class SLOPESMITH_OT_open_editor(Operator):
    bl_idname = "slopesmith.open_editor"
    bl_label = "Open Slopesmith"
    bl_description = "Open the Slopesmith editor in a browser"

    def execute(self, context):
        webbrowser.open(_base(context))
        return {"FINISHED"}


# ---- panel and preferences ---------------------------------------------------------------------------

class SlopesmithPreferences(AddonPreferences):
    bl_idname = __name__

    server: StringProperty(
        name="Slopesmith service",
        description="Where the Slopesmith API service is listening. `npm run dev` binds 5180 and serves the "
                    "editor from 5179; `npm start` serves both from 5180",
        default="http://127.0.0.1:5180",
    )

    key: StringProperty(
        name="Access key",
        description="Only for a server with accounts. Make one in Slopesmith under File > Settings > "
                    "Access keys and paste it here. A loopback server needs none — it already "
                    "serves you as its owner",
        default="",
        # `subtype="PASSWORD"` masks it in the preferences panel. It is still stored as plain text in
        # `userpref.blend`, which is exactly why the server refuses a key the admin role (docs/046) — the
        # masking stops a shoulder and a screen-share, not a reader of the file.
        subtype="PASSWORD",
    )

    def draw(self, _context):
        layout = self.layout
        layout.prop(self, "server")
        layout.prop(self, "key")
        note = layout.column()
        note.scale_y = 0.8
        note.label(text="A key is only needed for a server with accounts.")
        note.label(text="It authors as you; it cannot administer the server.")


class VIEW3D_PT_slopesmith(Panel):
    bl_label = "Slopesmith"
    bl_space_type = "VIEW_3D"
    bl_region_type = "UI"
    bl_category = "Slopesmith"

    def draw(self, context):
        layout = self.layout
        state = context.scene.slopesmith

        header = layout.row(align=True)
        header.operator("slopesmith.refresh", icon="FILE_REFRESH")
        header.operator("slopesmith.open_editor", text="", icon="URL")

        # Every mountain the service holds, not only the one a browser tab has open. Picking one reloads its
        # models through the property's own update callback, so there is no second button to press.
        picker = layout.row(align=True)
        picker.prop(state, "map_id", text="", icon="WORLD")

        layout.template_list("SLOPESMITH_UL_models", "", state, "models", state, "index", rows=6)

        # An empty list is a legitimate answer — a terrain-only mountain has nothing in either Custom library
        # — and an empty list with no explanation reads as a broken panel. Say which two things are missing
        # and what this bridge does not carry, so the answer is legible instead of merely correct.
        if state.project and not len(state.models):
            empty = layout.box()
            empty.scale_y = 0.8
            for line in _wrap("%s has no authored models and no imported props. The bridge carries props; "
                              "the mountain net is not in it." % state.project, 40):
                empty.label(text=line)

        actions = layout.row(align=True)
        actions.scale_y = 1.3
        actions.operator("slopesmith.pull", icon="IMPORT")
        actions.operator("slopesmith.push", icon="EXPORT")
        layout.prop(state, "push_textures")

        obj = context.view_layer.objects.active
        if obj is not None and _has_prop(obj, STAMP_KEY):
            stamp = json.loads(_prop(obj, STAMP_KEY))
            box = layout.box()
            box.label(text=stamp.get("name", ""), icon="CHECKMARK")
            box.label(text="%s prop #%s%s" % (
                "Tiled" if _prop(obj, CAGE_KEY) else "Textured", stamp.get("id"),
                " · quads round-trip" if _prop(obj, CAGE_KEY) else " · UVs round-trip"))
            # Which tiles are about to travel, named. Push is not undoable on the far side, so what it will
            # write belongs on screen before it is pressed rather than in the status line afterwards.
            #
            # The mark is Blender's dirty flag rather than the digest the push itself compares: a panel
            # redraws constantly and encoding every tile to PNG to label it would be absurd. The two differ
            # only after a FAILED push (saving cleared the flag, the digest still differs), and they differ
            # in the safe direction — the panel under-claims, and the retry still carries the art.
            for material in getattr(obj.data, "materials", ()):
                image = _material_image(material)
                if image is None:
                    continue
                edited = state.push_textures and image.is_dirty
                box.label(text="%s%s" % (_short_ref(_material_ref(material)) or image.name,
                                         " · edited" if edited else ""),
                          icon="BRUSH_DATA" if edited else "TEXTURE")
        elif obj is not None and obj.type == "MESH":
            layout.label(text="%s has no Slopesmith stamp" % obj.name, icon="ERROR")

        if state.status:
            column = layout.column()
            column.scale_y = 0.8
            for line in _wrap(state.status, 44):
                column.label(text=line)


def _wrap(text, width):
    """Blender labels do not wrap, and a refusal is the one string in this panel worth reading in full."""
    lines, line = [], ""
    for word in text.split():
        if line and len(line) + 1 + len(word) > width:
            lines.append(line)
            line = word
        else:
            line = "%s %s" % (line, word) if line else word
    if line:
        lines.append(line)
    return lines


CLASSES = (
    SlopesmithModel, SlopesmithState, SLOPESMITH_UL_models,
    SLOPESMITH_OT_refresh, SLOPESMITH_OT_pull, SLOPESMITH_OT_push, SLOPESMITH_OT_open_editor,
    SlopesmithPreferences, VIEW3D_PT_slopesmith,
)


def register():
    for cls in CLASSES:
        bpy.utils.register_class(cls)
    bpy.types.Scene.slopesmith = bpy.props.PointerProperty(type=SlopesmithState)


def unregister():
    del bpy.types.Scene.slopesmith
    for cls in reversed(CLASSES):
        bpy.utils.unregister_class(cls)


if __name__ == "__main__":
    register()
