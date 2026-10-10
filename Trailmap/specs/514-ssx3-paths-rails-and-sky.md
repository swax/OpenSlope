# 514 — SSX 3: Paths, Rails and Sky

A detail chapter of the SSX 3 addendum (`510-series-ssx-3.md`): which path
resources a location carries and what they hold, how the race line's progress
value is measured, how grind rails share a list with animation paths, and how
the sky is built. Read it against `140-paths.md` and `250-paths-aip-sop.md`,
whose path record chapter 510 shows survives intact. [measured] [[514-role]]()

> [[514-role]]() doc:../research/ssx3-world-data.md — method and every
> figure below.

## Three path slots per location

Every location has **three path resources**, numbered 0, 1 and 2, but only
some of them are filled. [measured] [[514-path-slots]]()

| Slot | Filled in | Holds |
|---:|---|---|
| 0 | all 43 locations with terrain | the location's own paths: an event's race lines, AI paths and start grid, or a hub's or connector's local paths |
| 1 | the five hubs | the hub's **peak race**: the race lines and AI paths of the race down the whole peak |
| 2 | hubs A and D | the hub's **peak showoff** route |

A peak race resource on a hub appears to cover only the hub's own ground. Its
lines were not seen to continue through the event runs between hubs, so a race
line for a whole peak cannot be assembled from the slot-1 resources alone.
[observed] [[514-peak-coverage]]()

> [[514-path-slots]]() doc:../research/ssx3-world-data.md "Paths, rails and
> sky": 147 bin-14 records, 50 non-empty — slot 0 in 43 locations (1,168
> AI paths, 143 race lines), slot 1 in A–E (32 / 17), slot 2 in A and D
> (14 / 6); slot names after the decoder's extractor
> (doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSBHandler.cs).

## The race line's progress value

The track paths of **type 1** are the **race lines**. Each line stores a
**distance to the finish** at its start, in centimetres of **horizontal**
travel: a line's value equals the next line's value plus the line's own summed
horizontal step length. This is exactly the baseline's metric
(`250-paths-aip-sop.md`). Measured along the slope instead, the same
differences come out about a fifth short. The values reach about four and a
half kilometres on the longest event. Lines at the finish hold under ten
metres, and the value −1 also occurs. [measured] [[514-race-distance]]()

The **start grid** is a list of positions, not of path indices. A slot-0
resource lists from one to fourteen start slots. [measured] [[514-start-slots]]()
Because the grid names no path, the AI path leaving each slot can only be
matched by position. [inferred] [[514-start-slots]]()

> [[514-peak-coverage]]() doc:../research/ssx3-world-data.md "Paths, rails
> and sky" (peak race coverage): seen on the imported peaks in a viewer, not
> measured against the event lines.

> [[514-race-distance]]() doc:../research/ssx3-world-data.md "Paths, rails
> and sky" (type-1 float): of 64 end-to-start linked line pairs, the value
> drop / horizontal length is 1.000 from the 25th to the 90th percentile
> (0.82 median against 3D length); 7 pairs increase at junctions; maximum
> 452,413; spec:250-dtf.

> [[514-start-slots]]()
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSB3Data/WorldAIP.cs
> start records (a position each); counts per resource in
> doc:../research/ssx3-world-data.md.

## Rails and animation paths share one list

The spline segment is the baseline's (chapter 510), but SSX 3 keeps **grind
rails and animation paths in the same list**: 2,659 splines, among them rails
and slides, tree and bench rails, teetering and breaking logs, fences and
boxcars, but also the flight paths of ospreys, eagles, ravens, rockets and a
dragon, handplant spots and the gondola's line. No field was found that
separates the two kinds, so only the authored names distinguish them, and
imperfectly: the osprey flight paths and the gondola line are themselves named
as rails. [measured] [[514-splines]]()

> [[514-splines]]() doc:../research/ssx3-world-data.md "Paths, rails and
> sky" (splines): name-word census over 2,659 records — `rail` 751,
> `railslides` 346, `handplant` 100, `dragonpath` 37, …;
> doc:../../Snowknife/SSX-Library/SSX-Library/FileHandlers/LevelFiles/SSX3PS2/SSB3Data/WorldSpline.cs;

## The sky

Each hub letter's sky location places **one model**, a camera-centred dome of
**eighteen parts**: a cap and a floor, which both cross the dome's vertical
axis, and a ring of **sixteen wall panels**, eight in an upper band and eight
in a lower one. Each panel spans an arc of the ring between its band's top and
bottom heights. The five skies share this layout. [measured] [[514-sky]]()

> [[514-sky]]() doc:../research/ssx3-world-data.md "Paths, rails and sky"
> (sky): one instance per sky location, 18 parts per model on all five;
> parts classified by whether their vertices reach the axis and by their
> top heights.

## Not established

- Path events in SSX 3's records: whether the baseline's event kinds
  (`250-paths-aip-sop.md`) keep their meanings. [open]
- What the showoff route drives in play. [open]
