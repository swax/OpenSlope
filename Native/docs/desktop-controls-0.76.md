# Desktop controls, build 0.76

A/D strafe on foot without changing the character's facing. W/S walk forward
and back. Left-drag turns the character and its walking direction, including
while standing still; while riding it orbits/looks around the character. Both
first and third person use left-drag. Releasing the button releases the cursor.
RMB retains board pickup/throw and does not move the camera. Mouse look cannot
mount or dismount. Menu clicks remain consumed until the button is released;
Escape releases a held drag before opening the menu on another press.

E dismounts while riding. Off-board it immediately equips at the current feet
using the current facing and full velocity, even when the loose board is far
away or the player is airborne. It does not probe ahead and teleport down to
ground. A short press survives a frame without a physics tick, and holding E
cannot toggle repeatedly. G retains proximity-based boarding. Quest trigger,
grip and on-foot X recall keep their existing controls.

These are independently authored application controls. The shared riding and
camera contract stays separate from on-foot input, using the existing clean
Trailmap 300 and 400 boundaries. No other component's runtime implementation
is used. Existing maps need no re-import. The broader parity goal remains paused.

The frozen Windows build passes all 57 Native suites. Boarding tests cover
short presses, held toggles at 60/72/90/120/144 Hz, distant equipment and airborne
equipping near and far from terrain. Equipment/camera tests cover stationary
turning, straight lateral walking, walking after a turn in both views, and
pointer input that cannot synthesize a board trigger. The existing Quest
control tests also pass.

The production replay test passes 667 Vulkan frames through this same EXE,
covering lateral movement, distant E equip, held mount/dismount and exact
position/velocity preservation when mounting airborne. Reproduce with:

```text
python Native/tests/desktop_board_replay_test.py <path-to-openslope_player.exe>
```

The Native source-boundary audit passes for 440 files. The complete repository
gate ran for 643.8 s: Native, 1,002 synthetic .NET checks,
type check and lint passed. The web suite passed 231/232 files; its lone
failure was a localhost connection timeout in the unrelated API test.
That test passed on an isolated retry without a code change. The production
build and export smoke test then passed separately. The original complete
gate result remains a failure rather than being relabelled green.
Physical desktop mouse/keyboard feel remains
a user playtest. No new headset installation or worn-device result is claimed.
