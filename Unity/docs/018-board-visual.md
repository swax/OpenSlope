# 018 — Rideable-board visual

How the deck assets exported by Snowknife are placed under the rideable board, oriented, scaled, and
dressed with a skin. ISO extraction, deck/skin formats, and the optional On Tour ski export belong to
[Snowknife 018 — Board assets](../../Snowknife/docs/018-board-assets.md).

Code: `VRC/Editor/RideableBoardSetup.cs` (`BuildBoardVisual`). The vehicle and physics behavior
are documented in [017 — Rideable board](vrchat/017-rideable-board.md).

## Input assets

`snowknife shared` supplies three regular-stance decks—`board_Al.obj`, `board_Bx.obj`, and
`board_Fr.obj`—plus the decoded `BoardTextures/<rider><number>.png` skins. `snowknife unity` stages the
shared folder into `Assets/OpenSlope/Maps/Shared` once per project.

If those assets are absent, setup falls back to a thin box and logs a warning. The board remains rideable;
only its appearance changes.

## Placement and orientation

Unity's normal OBJ importer is sufficient because a deck is one static visual without terrain lightmaps or
placed-instance identity. `BuildBoardVisual` chooses one of the three deck shapes and parents it as `Deck`
beneath the unit-scale ride frame.

The mesh transform stays on that child. Scaling or remapping the physics frame would shear a rotated deck and
would also disturb the board's world-space integration.

SSX authors deck length along local X, width along local Y, thickness along local Z, and the nose toward -X.
The setup maps length to ride-frame -Z and width to -X, a determinant-positive 180-degree yaw. Mapping length
to +Z makes the correctly textured board ride tail-first.

## Scale and collision

`BoardModelScale = 0.01` applies the same 100 source units = 1 Unity metre convention used by imported map
geometry. The native deck lengths are approximately:

| Deck | Length | Width | Character |
|---|---:|---:|---|
| `Al` | 2.60 m | 0.42 m | Long and narrow |
| `Bx` | 2.05 m | 0.49 m | Medium |
| `Fr` | 1.68 m | 0.50 m | Short and wide |

The large source dimensions are retained for visual fidelity. They do not alter ride physics: the frame's
fixed collider and analytic ground probes remain authoritative. Deck size affects only appearance and the
visual carved-wake footprint.

## Skins and materials

Setup chooses from the 144 rider skins and excludes the two non-rider special textures. Materials use
`OpenSlope/UnlitDoubleSided` and are created lazily under `BoardMaterials`, so only skins actually selected by
spawned boards need to ship. The exported OBJ UVs already match the `bord` atlas layout.

The importer falls back to the model's default material when skins are unavailable. Skin decode brightness
correction belongs to Snowknife and is intentionally not repeated in Unity.

## See also

[017 — Rideable board](vrchat/017-rideable-board.md),
[004 — Orientation and world scale](unity/004-orientation-and-scale.md), and
[005 — Materials and alpha](unity/005-materials-and-alpha.md).
