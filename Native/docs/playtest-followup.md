# Desktop and Quest playtest follow-up

The 0.35 desktop playtest supplies the following acceptance work for the active
Slopesmith gameplay-parity goal. This list supplements desktop-parity.md; it does
not replace its broader audio, world, performance and multiplayer requirements.

- [ ] Body/head motion while playing: animate the first-party avatar and aim its
  head coherently with movement/look, including walking, riding and switch.
- [x] Desktop 0.36 test launchers start in third person.
- [ ] Glass barriers render transparently and smash, disappear and play their
  configured break sound when crossed with an admitted impact.
  Build 0.37 fixes GARI's opaque scanline sheet and implements its fragmented
  break/reveal path for walking and riding. Automatic collision-sound resolver
  extraction remains required; see shatter.md.
- [x] Desktop E spawns/recalls a board ahead without mounting it automatically.
- [ ] Quest behind-head draw reaches the hand correctly through real input.
  The implementation and production gesture replays are present; worn reach
  still needs confirmation.
- [x] Collision bags and other supported movable bodies respond to a rider hit.
  Build 0.38 connects Roller bodies to walking/riding impact, moved collision,
  gravity and settling. Actual GARI has desktop evidence; worn Quest validation
  remains separate. See rigid-props.md for tuning and solver limits.
- [x] Desktop menus and HUD leave more of the course visible, with an actual
  16:9 renderer check guarding menu text separation.
- [ ] Authored fireworks produce visible particles at their live graph locations.
- [x] W flips forward relative to travel, including switch stance.
- [x] Desktop click mounts/re-equips and dismounts, with held-click protection.
- [x] Superman flight matches the public Slopesmith controls, with gravity,
  terrain/prop collision, unlimited aimed boost, boost audio and sole afterimages.
- [ ] God rays follow the supported world light/occlusion controls.
- [ ] Rail rotation matches Slopesmith's public rate and presentation behavior.
- [ ] Aloha water moves in the correct world direction.
- [x] The first-party Slopesmith snowboard replaces the diagnostic quad, with
  consistent targeting, carry attachment and visible geometry.

Implementation and validation are recorded as work lands. A compiled APK does
not establish physical reach, controller alignment or headset comfort; desktop
progress continues without waiting for a worn-headset test. Existing imported
course data remains private and is never copied into a distributable package.
