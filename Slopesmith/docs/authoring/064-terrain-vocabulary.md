# 064 — Terrain vocabulary for original courses

Use this vocabulary to describe what a feature does before choosing its patch layout. It is a design
tool, not a target set of dimensions or a reconstruction of a particular mountain. The
[course-building guide](065-course-building.md) explains construction; the
[scored build loop](066-scored-build-loop.md) explains how to check the result.

## Give each surface a role

| Surface group | Purpose | Where to spend control |
| --- | --- | --- |
| Track strip | Readable fast line through the feature | Turns, grade changes, margins and takeoffs |
| Snow bank | Carving support, containment or optional high line | Entry transition, apex and return to the floor |
| Shoulder and apron | Recovery space and support around the trail | Contacts with the track, rock toes and branch entrances |
| Rock face or buttress | Obstruction, separation, exposure and landform mass | Projection, recess, fracture, ledge and contact line |
| Snow cap or pocket | Accumulation on and around a landform | Curled lip, local drift and connection to surrounding snow |
| Gully or river quilt | A channel with its own direction and depth | Banks, crossings, falls and transitions into other terrain |
| Trick feature | Optional airtime or a grind alongside the race | Approach, lip or rail entry, landing and rejoin |

Patch density follows the work the surface must do. Trail edges and a takeoff may need narrow patches;
a distant apron can use much larger ones. Increasing the number of patches without changing their
directions or the surface shape does not add a new landform.

## Cross-sections describe a moment, not the entire mountain

**Bench:** a rideable ledge cut across a hillside, with an uphill face and a lower fall-away. Vary its
width, tilt and edge shape. Give the ledge a supporting face wherever that face is exposed to the rider.

**Wall-bank:** a turn whose outside rises into a carveable surface. The transition from floor to wall,
the approach speed and the exit matter together. A bank is more than a tilted road cross-section.

**Gully:** a channel bounded by rising terrain. Use it to funnel the line or separate two landforms.
Let the gully turn or narrow for a reason; an identical trench alongside the whole course reads as
an extruded border.

**Shelf and pocket:** a local flattening or recessed snow area that interrupts a larger face. It can
hold an optional line, a recovery area, a stand of trees or a viewing terrace. Give it a supported
footprint and a believable connection to the surrounding terrain.

**Cliff lip:** an abrupt drop from an upper surface. A snow cap may curl over it before exposing rock.
The lower terrain determines whether the drop is a route choice, a trick opportunity or an obstacle.

**Plateau and runout:** relatively calm ground for staging, recovering or finishing. Keep enough
space to read the next action. A short flat area does not have to become a broad rectangular platform.

Use these forms in changing combinations. A bench can narrow against a spur, bank through a corner,
open into a pocket and then cross a gully. Give each change its own boundaries rather than lofting
one fixed profile through the whole sequence.

## Design rhythm at more than one scale

The long profile establishes sustained pitches, recovery benches and major drops. Smaller rollovers,
compressions and terrace lips add texture within those sections. A repeated short pitch-and-bench
cycle can look active while still feeling uniform over a longer stretch.

Measure grade and curvature at more than one window length, chosen for the course's scale. Grade
as a percentage is vertical change divided by horizontal travel, times 100; it is not an angle in
degrees. Record whether a length is horizontal distance or three-dimensional path length.

Choose width together with speed and grade. A tightening turn after a fast drop needs a readable
approach, useful bank and recovery space. An open slope can invite a wider line choice. Do not copy
fixed spacing, average grade or turn radii from another course as universal requirements.

## Make optional routes part of the terrain

A second line can occupy an upper shelf, descend through a narrow chute, climb a bank or follow the
far side of a rock rib. Vertical separation and partial occlusion can make a compact section feel
layered without adding a large expanse of unused ground.

For each branch, identify:

- The visible entry and the decision the rider makes there.
- Its distinct surface, speed, clearance or trick opportunity.
- Its landing or rejoin, including the approach angle to the main route.
- Its recovery and respawn behaviour in the intended runtime.

Build and test those connections, not just the middle of the branch. A path drawn across a surface
does not make it rideable. Evaluate route points on the intended patch when vertically stacked
terrain makes a top-surface height query ambiguous.

## Use material boundaries to explain shape and response

Snow may form a rounded lip, a drift against a wall, or a broad rideable bank. Rock may appear at a
fracture, cliff face or obstructing rib. A small snow fillet can soften a contact visually; a larger
one can become part of the riding line. Choose the scale for the feature.

Keep texture appearance and surface response separate. Paint snow, powder, ice or rock according to
the intended ride, then make the visual material legible. A change to slower terrain can guide a
rider without requiring a fence, but a true hazard still needs a clear shape and readable approach.

Markings should follow travel through each patch's UV frame. Use track margins, grooves and approach
warnings to clarify choices. Review them in tight turns and after topology changes, where patch
orientation and texture scale can change.

## Distinguish continuous rollovers from explicit gaps

A convex crest can produce airtime at speed while remaining continuous terrain. A true gap separates
takeoff and landing surfaces. They need different coverage checks: missing ground is intentional
only in the authored gap, and the landing must still catch the expected range of trajectories.

Judge the whole sequence: speed-building approach, lip, flight, touchdown slope and recovery. A
fast rider may pass beyond the near landing and arrive where the track is already turning. A slow
rider may need a continuous route or another deliberate recovery option.

Rails and truck jumps are similarly complete features. The model supplies only part of the
experience; approach geometry, entry height, clearances and exit terrain complete it.

## Let a watercourse connect features

A channel can pass below a bridge, run beside a snow bench, drop over a ledge or separate takeoff
from landing. Different lines can cross above it or follow its bank. Each relationship should have
clear geometry and an intentional physical response.

Build the bed, banks and depth before the water material. A blue texture on uninterrupted snow is
only a visual stripe. Check terrain beneath falls and bridges in three dimensions; a heightfield
cannot describe every layered surface or open passage.

## Match topology to the feature

Use narrow strips where a boundary needs precision, broader patches over quiet areas, and local
3/5-pole transitions where rows turn or terminate. Explicit T-junctions can connect different
resolutions, provided their curves and cross-boundary shape are reconciled.

Smooth snow calls for matching tangent planes across seams. Rock fractures can keep intentional
creases. Independent quilts may intersect for snow against rock or an embedded fracture; their
visible edges need overlap checks along the full curved boundary.

The outer edge of a course is an intentional open boundary. Add encountered cliffs and repair
unexplained interior gaps; do not enclose the map with a bottom and perimeter walls merely to make
it a closed object.

## A feature brief

Before adding a patch group, record a short brief with its section label, entry and exit, riding
purpose, principal landform, material response, boundary types and required checks. For example:

> A banked bend wraps around a projecting rock spur. The fast lane stays low; a narrow snow shelf
> offers a higher line and rejoins after the exit opens. A recessed pocket supports a small grove.
> Snow joins remain smooth, the spur keeps a fracture crease, and the upper route must clear the
> grove through its full approach and rejoin.

That brief gives topology, materials, scenery and validation a shared purpose without prescribing a
single patch stamp or copying a particular mountain.
