# Authored collision foundation

Commit `d6e29ee` established independent collision extraction and portable
queries. The player, desktop chase camera and Quest Maps-folder cache now consume
this foundation; see [playable world contact](world-contacts.md) for integration,
validation and remaining effects, dynamic-body and recovery work.

The clean Trailmap bodies of chapters 120, 130, 220, 230 and 370 supply format and
behavior requirements. Implementation uses standard affine transforms, triangle
distance/intersection, slab tests, quadratic roots, BVHs and ellipsoid distance.
Raw provenance annotations and other decoder implementations are outside this
boundary. Synthetic byte layouts and geometry fixtures are independently authored.

The importer preserves every consecutive payload named by an SSF pool entry's
count, rather than treating its byte-size field as a traversal bound. Triangle
proxies become raw-centimetre `Collision/*.obj` files with authored normals. An
additive `Physics.json` contract, identified by `openslope-physics/v1`, carries
`PhysicsHeaders` and their existing portable payload fields. It preserves the
shape centre, separate centre of mass, inertia, inverse inertia, level records,
encoding and encoded mask bytes. The runtime also accepts those fields from an
existing `SSFLogic.json` when `Physics.json` is absent. It does not fabricate an
effect graph. `Instances.json` retains response flags, mass, bounce, surface,
mode, proxy paths, physics index and effect slot using established contract keys.

Model mesh headers supply exact local `CollisionBounds` in raw centimetres.
Older Maps files without that extension use local OBJ vertex bounds for box mode
only. Triangle collision always uses its collision proxy. Placement and parent
transforms use the same `(x,z,-y)/100` rotation/scale as the renderer. Meshless
hierarchy parents are excluded when matching payloads to geometry objects;
all-object payload sets are also accepted, while ambiguous counts are rejected.
Animation remains a time-zero snapshot.

| Query | Behavior / limit |
|---|---|
| Box | Body sphere only. Six face prisms expand only the face-normal axis; perpendicular centre slabs retain square edges. Uses object-local bounds under the composed affine placement. |
| Triangle proxy | Swept spheres test face, edge and vertex regions against actual world triangles. Proxies are provisionally double-sided with geometric contact normals; the specification does not establish full one-sided response for every open proxy. Authored normals remain in output. |
| Occupancy body | Raw and signed-control RLE masks retain occupied octants and hollow gaps. Body sphere gates the root; supplied limb spheres perform the narrow query when present. Affine sphere placement uses ellipsoids, preserving nonuniform scale and shear. General swept ellipsoid contact uses bounded conservative advancement and is not proven exact at every grazing trajectory. |
| Segment ray | Returns a surface point on the segment, including exit intersections when starting inside a box/body. Rideable filtering excludes negative surface types and type 17. |
| Response | Visibility does not gate contact. Exactly zero mass or a disabled bounce flag retains contact but disables response. Solid bounce preserves tangent velocity, uses ten-percent depenetration and the specified minimum normal impulse. Rideable response removes incoming normal velocity. Hard-impact classification is returned to callers, without inventing an animation recovery state. |

World and proxy BVHs accelerate candidate selection; shared proxy/body records
are reused across placements. Queries return the earliest contact per instance
with effect and response metadata. They do not dispatch effects, simulate mass
sharing, choose a character's limb pose or replace terrain contact automatically.
The public rider-volume input supports at most nineteen spheres. Its broad-phase
box uses enabled limbs when present, otherwise the body. Callers select the
grounded, airborne or rail volume. Legacy local-box vertex reads are restricted
to models actually used by enabled mode-2 placements.

File/array bounds cover JSON/OBJ size, source sections, pool/payload counts,
indices, hierarchy cycles, mask size/depth and root-confined asset references.
The fixture suite covers multi-payload traversal with irrelevant pool byte sizes,
raw/RLE bodies, source bounds, property joins, rollback, fast triangle/box sweeps,
square corners, hidden/pass-through placements, hollow octants, affine bodies,
inside-origin rays and ambiguous/malicious references. This evidence establishes
the foundation's supported cases, not complete gameplay collision parity.
