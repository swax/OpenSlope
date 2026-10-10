# 513 — SSX 3: Props and Collision

A detail chapter of the SSX 3 addendum (`510-series-ssx-3.md`): how placed
models, their bounds and their collision proxies relate, which placements are
solid, how helper geometry is recognized, and how each placement is lit. Read it against
`120-objects.md` and `130-collision-data.md`. Chapter 510 establishes that the
instance carries no behavior and no reference except to its model. This chapter
shows how collision still reaches it. [measured] [[513-role]]()

> [[513-role]]() doc:../research/ssx3-world-data.md — method and every
> figure below.

## Models and placements

Each location carries its own copy of every model it places: an instance's
model is always in the instance's own location, and every model record on the
mountain is placed at least once. Models are identified per location, unlike
texture and lightmap pages, which are mountain-wide. [measured] [[513-models]]()

Model names are taken from a placement, not given independently. A model is
named after one of the instances that place it, so about a fifth of all
instances share their model's name exactly. [measured] [[513-models]]()

Besides its transform, the instance stores its **world-space bounds** twice: a
box (minimum and maximum corners, ordered on every instance) and a bounding
sphere centred on that box. [measured] [[513-bounds]]()

> [[513-models]]() doc:../research/ssx3-world-data.md "Models, instances
> and collision": 10,644 model records, all placed; 41,113 / 41,113
> instances' models in their own location; 9,105 instance names equal
> their model's name.

> [[513-bounds]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSB3Data/WorldInstance.cs
> `V0` (sphere centre + radius), `V1`/`V2` (box); sphere centre = box
> centre on 40,773 / 41,113.

## Collision proxies

A collision proxy is its own resource, named after an instance with a suffix
that gives its kind. [measured] [[513-proxy-kinds]]()

| Kind | Proxies | Form |
|---|---:|---|
| progressive mesh | 3,415 | triangle mesh |
| convex hull | 1,104 | triangle mesh |
| sphere tree | 97 | a different layout, not decoded |

A triangle proxy is a list of **sub-meshes**. Each has its own vertex list,
indexed by single bytes (so at most 256 vertices per sub-mesh), a triangle
list, one normal per triangle, and a list of bounding boxes. Most proxies have
one sub-mesh; larger ones split into up to thirteen. [measured]
[[513-proxy-layout]]()

Proxy vertices are in the **model's own space**. Placed with the transform of
the instance it is named after, a proxy's bounds coincide with that instance's
world box on three-quarters of the mountain's proxies. The rest are proxies
drawn deliberately larger or smaller than the art. [measured]
[[513-model-space]]()

> [[513-proxy-kinds]]() doc:../research/ssx3-world-data.md "Models,
> instances and collision" (proxy kinds): name suffixes `ProgMesh`,
> `ConvexHull`, `SphereTree`; header kind 1 on the first two, 3 on the
> third; spec:510-name-scheme for the census.

> [[513-proxy-layout]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSB3Data/WorldCollision.cs;
> doc:../research/ssx3-world-data.md (layout): 4,154 single sub-mesh;
> most vertices in one sub-mesh 253, most triangles 456.

> [[513-model-space]]() doc:../research/ssx3-world-data.md (space): box
> difference median and 75th percentile 0, 90th percentile 5.5 m.

## Collision belongs to the model, per location

A proxy is **not** private to the instance it is named after. Each location
stores **one proxy for every collidable model it places**, named after the
first instance of that model there, and **every placement of that model in the
location uses it**. The data shows no exception. Every location that places a
model with a proxy carries the proxy for it. A few models have a second proxy
in the same location, but no placement of a collidable model lacks one.
[measured] [[513-binding]]()

The difference is large. Read by name, 4,616 placements would be solid. Read by
model, 21,268 are — over half the mountain. One boulder model is placed 439
times with a single proxy. Of the rock placements outside the helper set, 1,457
collide by name and 4,489 by model. [measured] [[513-coverage]]()

A model with no proxy anywhere is not solid. The rocks in that group are the
summit rock formations, a wall named for having no collision, cave rock
dressing, and falling and impact rocks, which move. [measured]
[[513-no-proxy]]()

**Sphere-tree proxies** belong to objects that break or move: crash bags,
breakable collectables, rock slides and avalanche boulders, ad boards, timers
and spray fixtures. The baseline stores the same kind of shape for its physics
bodies (`130-collision-data.md`), and SSX 3 evidently keeps it for the same
class of object. Its layout here is not decoded. [inferred]
[[513-sphere-trees]]()

> [[513-binding]]() doc:../research/ssx3-world-data.md "Models, instances
> and collision" (binding): 4,616 / 4,616 proxy base names are instances
> of the same location; 4,598 (location, model) pairs, 18 with a second
> proxy; 4,598 / 4,598 placements of a proxied model carry it. This
> corrects the per-instance reading of spec:510-name-scheme.

> [[513-coverage]]() doc:../research/ssx3-world-data.md (binding): 4,616
> by name, 21,268 by (location, model) of 41,113; rocks 1,457 / 4,489 of
> 4,641; boulder model `rock_de_bolder_d`.

> [[513-no-proxy]]() doc:../research/ssx3-world-data.md (no proxy
> anywhere): `4peakrocka`, `peakrock`, `noColliderockwall`,
> `cavePolyrock`, `fallingrock*`, `*RockImpact`, rocket cores.

> [[513-sphere-trees]]() doc:../research/ssx3-world-data.md (sphere trees);
> spec:130-spheretree for the baseline shape.

## Helper geometry

Helper geometry is drawn with the orange debug page alone
(`512-ssx3-textures-and-materials.md`) and is recognizable by that: 3,174
placements. Their authored names sort them into kinds. [measured]
[[513-helpers]]()

| Kind | Placements | With a proxy |
|---|---:|---:|
| reset planes and panels, including challenge start and finish planes | 1,679 | 1,455 |
| invisible course fences and fence proxies | 555 | 555 |
| reset volumes | 286 | 286 |
| backcountry volumes | 229 | 220 |
| impact, raven and other triggers | 189 | 5 |
| start- and end-of-event fences | 77 | 77 |
| backcountry teleports | 42 | 0 |
| streaming load and unload boxes | 37 | 37 |
| one-way volumes | 23 | 1 |
| ride-state boxes | 17 | 17 |
| other volumes, planes, emitters and timers | 40 | 24 |

Most helpers have proxies: 2,677 of the 3,174. The proxy is how a helper
detects the rider, so it does not by itself make a wall. From the names, only
the course fences and fence proxies are plain walls. Reset planes and volumes
act when entered. Start and end fences are mode gates that close only during an
event. Load, unload and ride-state boxes switch streaming and riding mode.
[inferred] [[513-helper-proxies]]()

Another 205 placements are named as triggers but drawn with a real page —
tree-top, speaker, sequence, dragon, pop, flash and lantern triggers — and are
recognizable as helpers only by name. [measured] [[513-helpers]]()

> [[513-helpers]]() doc:../research/ssx3-world-data.md "The debug page",
> "Models, instances and collision" (helpers with proxies): family census
> with per-family proxy counts.

> [[513-helper-proxies]]() doc:../research/ssx3-world-data.md (helpers
> with proxies): 2,677 / 3,174. Behaviour readings come from the names
> only, since no trigger record is decoded (spec:510-logic).

## Baked lighting

A placement carries no light record. Its lighting is **baked per vertex** into
the instance's tail (`510-series-ssx-3.md`): one 16-bit colour for every vertex
of its model, five bits each of red, green and blue and a top bit of alpha.
[measured] [[513-vertex-light]]()

The colours run in the order the model's vertex records stream: object by
object, part by part, record by record. A record that draws no triangles still
holds its place, and a record with no vertices holds none. [measured]
[[513-vertex-light]]()

The lighting belongs to the **placement**, not the model. Most later
placements of a model carry different colours from its first, so a model
cannot be lit once for all of its copies. [measured]
[[513-vertex-light-placement]]()

A channel value of **16 draws the texture as stored**. The hardware widens
each five-bit channel to eight bits by shifting it three places left, which
puts 16 at the 128 where a vertex colour multiplies a texel by one. Every
sky-dome vertex carries exactly 16 in all three channels, and the lit signs
carry 18 to 25. Most of the mountain sits below 16, darker and bluer than the
texture, as its shaded snow is. [inferred] [[513-vertex-light-scale]]()

The **alpha bit is coverage**. It is set on nearly every vertex and clear only
on the fading edges of light beams, glows, god rays and snow and water sheets.
[measured] [[513-vertex-alpha]]()

> [[513-vertex-light]]() doc:../research/ssx3-world-data.md "Baked prop
> lighting": colour count equals the model's streamed vertex count on 41,112 /
> 41,113 instances, record by record on 39,855; the unpacks are 16-bit colour
> unpacks in the tail; channel layout bits 0–4, 5–9, 10–14, alpha bit 15.

> [[513-vertex-light-placement]]() doc:../research/ssx3-world-data.md "Baked
> prop lighting" (per placement): of 30,469 later placements of 2,758 models
> placed more than once, 26,052 differ from the first.

> [[513-vertex-light-scale]]() doc:../research/ssx3-world-data.md "Baked prop
> lighting" (scale, per location): the five sky domes at (16, 16, 16) on every
> vertex; neon constants (21, 22, 25), (18, 18, 19), (20, 20, 21); a channel
> above 16 on 11.2% of all colours. The three-place widening is the console's
> 16-bit colour unpack.

> [[513-vertex-alpha]]() doc:../research/ssx3-world-data.md "Baked prop
> lighting" (alpha): bit clear on some vertices of 1,003 placements, on all
> vertices of none.

## Not established

- The sphere-tree proxy layout. [open]
- Which proxy applies where a model has two in one location. Some pairs set
  an event-build variant of a prop (crash bags, flag poles, a tent) beside
  the ordinary one; some give the same placement two kinds, such as a hull
  and a mesh, or a sphere tree and a hull. [open]
- Whether the local lights of `515-ssx3-lights-halos-and-fog.md` reach props
  at run time as well, or only through the baked colours. [open]
