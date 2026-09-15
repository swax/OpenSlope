# 016 — Test ride

A **playtest inside the editor**: drop a board at the course start and ride the mountain to feel how it plays.
It answers the questions a static top-down can't — does the line flow, are the grades too steep or too dead,
does the terrain read at speed, is that ice patch a trap — without leaving Slopesmith or exporting anything.

The board physics implement the **SSX functional specification**. Slopesmith consumes a generated view
of the same versioned profile prepared for the main Unity board, `Trailmap/specs/data/ride-v1.json`, backed by
[Trailmap: 130-collision-data / 310-surface-response / 320-ground-contact / 330-carving /
360-speed-and-boost / 370-world-interaction]. Those chapters are normative for the port and carry the
reverse-engineering provenance for each rule. The relative per-surface values and the carve math are the specified ones; the model is
hand-integrated in world metres. What's dropped is only the platform saga — the seat/network rig. Native
authored/reference rail grinding and the local run scorer are part of the ride model.

- [The Test mode](#the-test-mode)
- [Prop collision in Test](#prop-collision-in-test)
- [Performance](#performance)
- [Gravity](#gravity)
- [The tick](#the-tick)
- [How the board rides](#how-the-board-rides-appridesessionts)
- [Grinding rails](#grinding-rails-appridegrindts)
- [The drawn board and its rider](#the-drawn-board-and-its-rider-appridegearts-apprideriderts)
- [Board sound](#board-sound-apprideboard-audiots)
- [The AI field](#the-ai-field-apprideaits)
- [What the spec has that this ride doesn't](#what-the-spec-has-that-this-ride-doesnt)
- [Verified](#verified)
- [Next](#next)

## The Test mode

Riding is its own editor **mode** (the lab-flask icon in the mode segment, alongside Scene / Edit / Sculpt /
Paint / Props / Effects). Entering it leaves both mountains' current editor visibility unchanged and shows a green
**start flag** (put away for the length of a run, on screen or in the headset, and back when the run ends); the
Tools panel is the ride's staging area:

- **`<mountain name>` / Reference** — side-by-side buttons choose the mountain you're building or the
  loaded **reference** world (the
  other mountain is hidden for the run; the option is disabled until a reference is loaded in Scene ▸ Reference).
  What a reference ride **draws** follows the top bar's **Props / Tricks** view filters. Those are visual
  filters only: collidable props remain in the run even when their render layer is hidden.
- **click the slope** — **drop an AI rider there** and it sets off (below). A click belongs to the **selected**
  mountain: clicking the other one (both stay visible during setup, so a reference in front of your terrain
  catches the click) says which mountain you hit and how to reconcile it, and does nothing else — an armed
  **⊕ Set custom start** stays armed until a click actually lands. The ridden mountain's **props count as part
  of it**, so the point clicked on a roof, a ramp or a container is an ordinary play point; the board seats there
  because the ride's contact probe reads rideable prop faces exactly as it reads terrain. A prop the probe will
  not stand on — ghost contact, obstacle-only (no `SurfaceType`), or shoveable — takes the flag but drops the
  board through to the terrain below, and the point is fixed in world space, so an animated prop rides out from
  under it.
- **Free ride / Race / Showoff** — which **event** the run is, in the same shape as the target buttons above it:
  where you ride, then what you're riding. All three are the game's own modes ([Trailmap: 230-level-ssf,
  395-ai-riders]). They select the clock and invoke the level's matching named effect entry point
  (`FreerideMode`, `RaceMode`, or `ShowoffMode`), including any nested `HideShowOff` / `HideRace` prop and rail
  configuration. The native LTG `GemIndex` is an additional engine-side Showoff-only object set: it contains
  multiplier gems and their solid `Gem_RailSupport_*` props, none enumerated by `HideShowOff`. This is a live
  setup preview: changing the selection before launch immediately resets and
  reapplies the complete course's mode-specific props. Once a ride/watch starts the selector locks because its
  clock, rail set and effect world are one latched run. The engine keeps one clock field and only showoff reverses
  it ([Trailmap: 390-showoff-clock]):
  - **Free ride** — the mountain with no event on it, and **no clock at all**. Most of what the
    bench is for is not a run against one, and a countdown expiring mid-inspection is in the way.
  - **Race** — counts **up** from zero, the way a race times a descent.
  - **Showoff** (the default) — counts **down** from the mountain's own **showoff clock** (Scene ▸ `<mountain name>`, or a loaded
    reference's own number off retail's per-course table: Garibaldi 120 s, most courses 90, Alaska 135), and the
    run is over at zero.

  A Showoff checkpoint is authored on a **course knot** with Scene ▸ Course ▸ Selected knot ▸
  **checkpoint bonus (s)**. Crossing that race-line progress station forward adds its seconds to the live
  countdown and announces `TIME BONUS`; reversing across it does nothing. It is deliberately independent of
  props: a flashing checkpoint sign may sit beside the course for presentation, but touching/passing through
  that model is not the trigger. Loaded references recover their positive SOP type-11 events and draw each
  route location + value; alternate race-line copies at the same DTF form one logical award, with the route
  nearest the rider supplying its value.

  Retail Race uses the same forward checkpoint station for a different result: it announces **CHECKPOINT**
  and advances a discrete per-rider checkpoint/standing counter, but awards no time or points. Test Ride does
  **not currently model** either of those race-side effects; its checkpoint simulation is Showoff-only. The
  authored bonus remains the Showoff time payload even though export also places the race progress station in AIP.

  A clock reads top-centre in `m:ss.cc`, the precision the engine stores a race result in; a countdown goes
  amber under ten seconds and red at **TIME UP**. Expiry **does not eject you** — this is a bench, and a ride
  that ends itself mid-slope is a worse one — so the clock lands on zero and the run carries on. A mountain
  authored with a zero showoff clock shows no chip either, which is how retail's two non-event slots read.

  A timed run also carries the Unity scorer at the physics tick rate: air spins and flips share the decoded
  rotation-style term, rail time adds linear grind style, and holding the deck off-board earns the grab begin /
  hold style plus its half-second flat-point ladder. Showoff's wrist and desktop clock show banked points plus
  Unity's itemized live trick: `+points` over the four-factor rotation equation, or the live grind/grab timer;
  landed and bailed results hold green/red for three seconds. Race deliberately shows time and lap standing only,
  though its internal trick score still fills boost. A clean landing banks the open trick; an unfinished 90°
  landing or reset wipes only that trick; a Showoff gem is max-not-stack and is consumed by the next real landing
  or bail. Big air begins at four seconds. Reaching zero in Showoff freezes its score beside the final time. The same
  run starts with one quarter of Unity's boost meter: a landed trick fills it from BASE style points at 0.0001
  per point (never from a gem, big-air add, or flat grab tier), held boost spends 0.045/s in every mounted motion
  state, and a reset/bail costs 0.1. At empty the held boost does nothing; course speed pads remain free. Off-board
  Superman boost never reads or spends that meter. Outside a live timed/scored run—including a grounded dismount
  followed by a remount—board boost is unlimited too. Desktop/mobile show the fifteen whole dots along the bottom
  edge; WebXR shows the same bar on the wrist only while mounted, never as a false fuel gauge for free flight.

  Retail also fields six riders in a race and one in the other two; here the **AI riders** count below owns that,
  so any event can be ridden with any field size, or alone when it is zero.
- **Snowboard / Skis** — what the player **and the whole AI field** ride on ([the gear](#the-gear-snowboard-or-skis)
  below). Applied **live**: the same rider, on the same line, at the same speed, standing a different way on
  different kit is the comparison worth having, and it is one click away rather than a restart. The physics is
  identical on either — the deck is drawn, not simulated — so this changes how a run *looks* and never how it
  rides.
- **Standard / Goofy** — shown directly below the gear row only for a snowboard. **Standard** puts the left foot
  forward and faces the body right; **Goofy** puts the right foot forward and preserves Slopesmith's original
  left-facing body. It mirrors the foot angles, anatomical feet, carve stance, and body live, but never the ridden
  direction the head follows. The choice is retained while skis are selected and restored with the snowboard.
- **Rider model** — the character the player and every AI rider wear ([030](030-character-models.md)),
  hot-swapped live. **Riding style** — how they stand ([the stance model](#the-stance-model) below), also live;
  the four styles mean the same thing on either gear, so a swap keeps the one you chose.
- **Snow** — how much weather the run is ridden through ([050](050-snowfall.md)), **0 to 10**: `0` is a clear
  day, **`3` is the game's own ambient snowfall and the default**, and `10` is a whiteout blizzard. Below 3
  the fall simply thins, the way the engine's own amount parameter thinned it; above it the weather changes —
  many more flakes packed into a tighter box and driven nearly sideways by the wind. The flakes never change
  size: a blizzard here is more snow, not bigger snow. They are world-fixed at every setting, so you ride
  *through* them with full parallax rather than towing them along. It defaults to on because the engine
  decides its own snowfall with a per-course weather roll the level data does not carry, so there is nothing
  to read off a mountain, and a snowboarding course is the case the effect was built for. It is one vertex
  shader over one instanced quad, in a single draw call, so only the top of the dial costs a run anything and
  what it costs is fill. Only while riding — the editor view stays clear — and applied live: the field is
  stateless, so moving the dial mid-run thickens the weather exactly where it already is.
- **AI riders** — the opponent count and field ceiling, from **0–16**. Zero disables the field; a click past a
  positive ceiling recycles the oldest rider.
- **Tuning** (the final panel) — performance and diagnostic controls kept together at the bottom: **MSAA + smooth
  cutouts**, **Board FX**, **Draw distance**, **Show AI paths**, **Show colliders**, and **Collect telemetry**.
  The first setting affects the editor as well as Test and reloads the renderer when changed; the other live
  display controls apply immediately, while telemetry arms the next run.
  **Board FX** is the retail boost afterimage, carved wake, and five snow-spray buffers, each rebuilt from the
  live-verified engine model ([Trailmap: boost-trail; 380-carve-effects]). Boost is a separate seven-pose board
  geometry ring sampled at 20 Hz: two additive edge sheets follow the actual drawn deck through bank, flips, and
  airtime, step yellow → orange → red with the boost-meter thirds, and contract one oldest sample at a time on
  release. Ground boost, pad boost, board-pointed air boost, and the held-board WebXR jetpack feed this same
  contact-independent renderer. The snow
  path carries the surface ring's small per-surface chunks,
  alpha-blended and *thrown* out of the turn (sideways at a light lean, straight up at a full one) with a random
  share of the board's speed, decelerating as they fade; the four-rail `spry` spray sheet whose rails launch
  up-and-out at 1×/2×/3× a carve-ramped throw and curl down under drag and gravity; the 1.6 m → 8 m carve
  plume; the 0.3–0.44 m powder cloud that rides with the board; the landing cloud of 2.4 m → 5 m soft squares
  that burst on touchdown and rise up the contact normal; the takeoff puffs the ring throws while airborne; and
  on rails and rock/metal the ring's spark gate — orange-yellow comet-trailed dots about one a frame, with a
  17-spark flare roughly once a second, arcing up-and-back off the contact under gravity. Every sprite is an
  instanced world-space quad, not a WebGL point, so browser point-size limits cannot collapse the big puffs.
- **▶ Play `<mountain name>` / ▶ Play `<reference name>`** — drop the board at the flag and ride the selected target. It
  becomes **■ Stop** while riding.
- **👁 Watch the AI** — race the field with **no board of your own** (below).
- **Position** (its own section) — **⟲ Reset start** puts the flag back at the default (a few metres down the
  selected mountain's course; a reference without a recovered course falls back to its centre-of-surface), and
  **⊕ Set custom start** arms the flag for **one** click: the next click on the ridden mountain — terrain or prop
  — moves it, and clicks go back to dropping riders afterwards. When another player's live avatar is on this map,
  **Go to player** appears beneath those start controls. In setup or **Watch** it places the editor camera well
  ahead and above that player, looking back toward them and the mountain so their continuing run stays in view.
  During desktop **Play**, the same selection teleports the local rider about 3 m behind them, facing the same way.

While a ride runs it **owns the camera and the input** and hides the non-target mountain. On a desktop,
**first person captures and hides the cursor** until **Esc** releases it; clicking the viewport captures it again.
In **third person** the cursor remains visible until **RMB** is held for unrestricted relative mouse-look, then
returns immediately when RMB is released. Esc also breaks an active capture, or ends the ride when the cursor is
already visible. Stop likewise ends the board, restores the other
mountain's prior visibility, and returns to setup. You stay in Test mode to tweak the start and go again, and
leaving Test restores the exact editor camera. Controls:

Desktop first person hides the complete local rider and draws a small centre dot. WebXR deliberately differs:
it hides only the head, leaving the tracked body, hands, legs and board visible beneath the player. The desktop
walking camera enforces a long-range terrain floor. The riding chase camera instead uses its rider-to-eye sight
line and closest-surface volume guards: a topmost vertical floor query would mistake a tunnel roof for ground.
Tracked WebXR wrists are hard IK landmarks: riding animation may move the shoulder girdle toward an unreachable
controller, but it never clamps a glove away from the physical hand to preserve an authored shoulder pose. The
tracked shoulder line is built across where the WEARER faces — headset yaw, pulled toward held-out hands — never
across the deck: the pinned VR seat lets the board swing most of a carve under a wearer who has not turned, and
deck-welded shoulders swept away from the controllers and, past 90°, handed the two controllers to the wrong
arms. A controller→arm pairing is held with hysteresis so hands brought together do not flap between arms, a
tracked arm's elbow is poled in the wearer's frame (down, a little back, a little out), and an imported character
re-solves each tracked arm from its own shoulder and bone lengths so the glove lands on the controller.

- **A / D** — carve left / right (leans the board; the edge bites and bends the line, carving across the fall
  line scrubs speed, like a real turn). **In the air the same key spins the board** at 270°/s — hold it about
  two-thirds of a second for a half turn, and land it to ride **switch** (below).
- **W** — tuck (rider pose; no traced grounded motion term). **In the air, hold it to flip forward** over the
  nose (below).
- **S** — brake, and **in the air, hold it to flip backward** over the tail. Scrubs the forward component toward a standstill and stops there; it never runs it negative,
  so holding it cannot drive the rider backwards. Slopesmith's own control — [Trailmap: 360] traces no brake or
  tuck input reaching the motion code at all.
- **Shift** — hold boost (a lean-gated forward shove on snow; in the air it thrusts where the **board's visible
  nose** points, including its current flip; raises the speed cap in either state). In WebXR **B** is the same
  board-axis boost. Off-board and empty-handed, B retains the right-controller air aim; with the board held, the
  deck becomes the aimable thruster itself.
- **Space** — ollie. **Hold to charge** (a meter fills beside the speed read-out), release to launch. A tap is
  already a real pop (the engine floors the launch at 6.31 m/s); the charge pays **quadratically** on top, and a
  faster approach jumps higher.
- **R** — reset. The carry-back returns to the course *where you are*, not to the top of the run. During an active
  Race/Showoff score run the floor, reset volumes, and wedge integrator can invoke it automatically; in free ride
  they do not, so only this manual button moves the player. Restarting a run is Stop and ▶ Play.
- **E** — get off the board, and get back on it. The touch **upload / download** chip and gamepad **Y / North**
  use the same action; outside a headset, getting on recalls the deck directly under you without moving you back
  to the course. On foot you walk the mountain (W/A/S/D or the left stick, **Space** jump,
  **Ctrl** crouch). Jump once to take off and press jump again in the air to enter Superman flight; once flying,
  W/A/S/D or the left stick thrust forward/left/back/right, jump thrusts up, and crouch thrusts down. Flight uses
  half of the authored acceleration and speed caps until **Shift / X (gamepad) / B (WebXR)** is held; its boost
  roar plays only while that modifier is actually multiplying directional thrust. The deck is left riding out its own coast below — see
  [Getting off the board](#getting-off-the-board).
- **V** — toggle first/third person, both while riding and while walking with the board parked. The touch **FPV/3P**
  chip performs the same toggle. Riding switches between the solved rider eye bridge and the retail chase boom;
  walking switches between the eye-height view and its three-metre follow view.
- **Mouse wheel / pinch** — in desktop third person, move the riding or walking camera in and out along its
  existing line to the avatar. The chosen boom scale survives getting on or off the board; first person ignores it.
- **M** — place a telemetry marker. The first marker automatically begins a capture with the preceding three
  seconds included, so it is safe to press just after a bad jump or collision.
- **F8** — begin a telemetry capture manually, or save the active capture immediately.
- **LMB / RMB on foot** — a loose board or pair of skis under the pointer and within 4 m lights up. LMB gets on
  it where it lies; hold RMB to pick it up and carry it on the pointer ray, then release to drop or throw it.
- **Mouse look** — first person keeps the cursor captured; after Esc, click empty viewport space to recapture it.
  In third person, hold RMB away from a highlighted target to capture and look, then release RMB to return the
  cursor.
- **Esc** — release an active first-person or RMB capture, or end the ride when the cursor is already visible
  (back to setup).

### Getting off the board

**E** on a desktop, **Y / North** on a gamepad, the **upload** chip on touch, and **A** in the headset take the
rider off the deck, and the moment they do there are two
objects on the mountain where there was one. Both keep going.

**The rider** keeps the board's velocity *and* the point in the air they left it from. A seated passenger has no
velocity of their own — the deck was carrying them by moving — so without the carry, stepping off mid-flight
strands you: all the speed you built vanishes and you drop out of your own jump. Bailing out of a big air
therefore flies on exactly as it was going. This is the shipped VRChat board's `CarryTrajectoryOnExit`
(Unity docs/vrchat/017); a **grounded** dismount carries nothing, because handing a walking avatar 25 m/s would
fire them across the mountain.

Carrying an arc means **keeping** it, which takes one rule in the walker: above its own run speed, the airborne
ease toward stick intent may *steer* the arc but never *brake* it. Without that, a centred stick reads as a
request to stop — the ease is a symmetric pull toward what the thumb is asking for, and what a resting thumb
asks for is zero — so a 25 m/s bail bled itself dry inside a second and the trick ended in a hover. The stick
can still bend the flight, and it costs nothing to do so; below run speed an ordinary hop keeps exactly the air
control it always had. A frictionless airborne walker is also the faithful one: it is what VRChat hands a player
it has just set a velocity on, and the whole reason the board exists as a vehicle. (The **vertical** is still a
walker's 9.81 m/s² rather than the board's two-stage 19/8.5, so a rider and the deck they let go of do not fall
at the same rate — deliberate, and the same split the shipped world has.)

**The board** keeps it too. It is nobody's from that instant: it falls, lands, slides on down the hill and settles
flat wherever friction runs out, laid on the slope it stopped on. Freezing it in mid-air where the rider let go —
which is what simply not stepping the ride model any more would do — is the one outcome that reads as a bug. The
model for it is `app/ride/board-coast.ts`, and it is deliberately not the ride model: a ridden board is a
hand-integrated deck on a per-surface contact law with a rider driving it, and a loose one has none of that, so
the coast is gravity, a fixed 25 cm stick band, a linear friction plus the board's quadratic drag, and a settle at
1.5 m/s. Its five constants are `no spec constant` — the engine has no dismount at all — and are taken from the
shipped VRChat board rather than invented, for the same reason the VR head-steer constants are.

Two consequences worth knowing. Seated on a slope, the coast integrates only the **downhill** part of gravity:
with no rider and no contact spring, keeping the into-surface part would drive the deck into the snow instead of
along it. And a deck that goes over a cliff with you is put back at the run's start rather than tracked down past
the out-of-bounds floor, because there is exactly one board in a session and nobody can walk to one parked under
the world.

The loose deck is also part of the disposable multiplayer pose. Other people on the mountain see the selected
board or skis mounted, coasting, settled on the snow, held by a desktop or VR player, and thrown. It has its own world
transform, velocity and teleport epoch rather than following the owner's body root, so walking away does not
drag parked equipment along and an explicit recall, reset or mount snaps only the equipment. This is transient
presence state, not mountain data: a late joiner receives the latest pose, and no board position is saved.

Desktop now has both forms of getting back on. LMB on a highlighted loose deck is **spatial**: the rider steps
onto that deck where it lies, with its facing and any airborne arc. **E**, gamepad Y, and the touch chip retain
the convenient **in-place recall**: the loose deck stops wherever it was coasting and appears under the rider at
their current walking position, facing the walking view. A grounded recall is seated at that local surface's
exact rest depth; one during a jump keeps the rider's position and carried velocity. Neither path invokes the
course-reset path, so a board that fell out of the world cannot pull the rider back to the run. In the headset
the deck is the same physical target: point at it and pull a trigger, or pick it up and put it back down (below).
A coasting board is
silent and lays no wake — the Unity board does keep carving its trail while it slides, and matching that would
mean handing this path a surface table it otherwise has no use for.

Getting on or off changes locomotion without changing the desktop view: a third-person rider remains in third
person while walking and after remounting, and the same continuity applies to first person.

### The board in your hand (desktop and WebXR)

A board is a thing you hold, not a mode you are in. Two different buttons, and the split runs all the way
through: the **trigger RIDES** and the **grip CARRIES**, in every state. That is the same split the VRChat board
makes — there, VRChat itself routes use and grab apart — and it is why one deck can be both a thing you ride and
a thing you pick up with no separate handle to aim at.

Desktop maps the same verbs onto the mouse. The live cursor direction supplies a target for the outstretched arm:
LMB interacts/rides, holding RMB carries the highlighted equipment, and releasing RMB sends it into the existing
coast with the measured movement and tumble. A distant but in-range deck eases into the hand instead of cutting
there. The attachment follows the avatar solver's reachable right wrist, so the glove remains joined to the deck;
in first person the head-hidden local body is revealed during the hold so that arm and glove are visible. While no
target is highlighted, RMB remains third-person look rather than becoming a failed grab.

**Trigger — get on:**

- **Point at a loose deck** with either controller. It lights up; pull the trigger and you are riding it. The
  mount is a *ray*, not a proximity, which is exactly what makes standing in one spot able to mean two things:
  point at the board to get ON it, put a hand on the board to pick it UP. `Interact` on the shipped board is
  VRChat's own use-ray for the same reason. Range is 4 m against the deck's own outline, padded 10 cm so a
  14 mm-thick board is something a person can aim at.
- **Pull the trigger while holding it** and it goes back under your feet and you ride away.

**Grip — carry:**

- **Squeeze near a loose deck** and it is in your hand — off the snow, out of a coast still sliding, or out of a
  throw still in the air.
- **Squeeze the free hand's grip** while carrying and it changes hands. The old grip can then open without
  throwing it.
- **Open the holding hand** and it goes, with the arc *and* the tumble you were swinging it through. Set it down
  gently and it lands; flick it and it sails.
- **Hold B while carrying it** and the deck is a jetpack. Thrust and the retail-style trail both follow its
  actual +Z nose, whichever hand holds it, so rotating the wrist aims the player. It can lift directly from the
  ground and remains unlimited like every other off-board boost.
- **Squeeze while riding, in the air**, and the deck comes off your feet into your hand. Your own arc is
  untouched, so you fly on — which is what makes putting it back on before you land a trick rather than a
  recovery. Grounded that grip does nothing: it would rip the board out from under a carve every time a hand
  strayed.
- **Reach behind your head and squeeze** and your board comes to you from wherever it lies on the mountain —
  see below.

Every pickup uses the same deliberate **edge carry**. The right hand takes the visible right edge and the left
hand the visible left edge; the long edge follows controller up/down, the topsheet faces the wearer, and the rest
of the board or ski pair extends inward. A nearby ground or airborne pickup keeps where the fist — or desktop
pointer — met the deck **along its length**, so grabbing near the nose still holds near the nose. A behind-head
summon uses the waist because it has no physical contact point. In either case the selected edge point is seated
**2 in toward the controller and 1.5 in toward the wearer** from the palm, then becomes one rigid attachment
(`app/ride/board-grab.ts`).

A deck that is **answering you right now lights up** — either verb counts, and the wrist panel says which button
it is. Taking one off the snow is deliberately forgiving: the shipped board's own 1.5 m pickup proximity,
measured from the fist to the deck's outline rather than its centre, because in a headset the board is lying at
your feet and your real floor is somewhere else. Passing it between hands asks for 0.35 m — that hand has to be
*on* the deck, or every stray squeeze while carrying would flip the board from one hand to the other.

#### The over-the-shoulder summon

Reach behind your head and squeeze, and your board snaps to your hand from wherever it lies (`BoardSummon`,
Unity docs/vrchat/017). It is the sword-draw pose, and it is the one thing that makes a board you threw off a
cliff — or left at the gate three runs ago — not a walk back.

The gesture is three authored bounds, all measured in a **yaw-only** head frame: at least 10 cm behind the head,
within 55 cm of it, and no lower than 25 cm below it. Flattening the facing is what stops looking down at your
own board from turning "behind me" into "below me", which would let a dropped hand summon. (Slopesmith reads a
viewer's −Z where the shipped board reads VRChat's tracking +Z; the gesture is the same one sign apart, and
getting that backwards fires the summon whenever a hand is out in front.)

That gesture has priority over proximity: if the board happens to be lying on the ground close enough for an
ordinary pickup, a hand behind the head still selects the waist rather than a ground contact point.

A recall places the **outer waist edge** 2 in toward the controller and 1.5 in toward the player from the palm:
the deck nose/long edge runs along the controller's physical up/down edge and the topsheet faces the wearer.
Left and right use mirrored local frames, so either hand gets that physical result and the gear hangs inward from
the caught edge rather than out past the wrist. It **snaps directly to the hand on the closing grip** instead of
flying across the view, and that cross-map discontinuity is not sampled as a throw.

A **throw** is its own kind of flight. The hand's motion is measured off the deck rather than the wrist (so a
flick that whips a long nose round throws it that fast), low-passed so one dropped tracking frame cannot become
the throw, and capped at 12 m/s and 720°/s so a spike cannot fire the board across the level. It then flies its
**full ballistic arc, tumbling** — no air scrub at all — until the first thing it touches, at which point it is
an ordinary loose board again and slides and settles like any other. That is the whole difference between a
board you threw and a board you stepped off: the second one loses its throw in the air and drops.

Putting it back on **in the air** resumes the arc you are flying rather than starting a fresh ride at a
standstill, and raises the board's speed cap to whatever you arrived at — a rider who caught the deck out of a
Superman flight is travelling faster than the board's own tier, and the tier is a cliff where the air drag is a
slope (`RideModel.mountAirborne`).

#### One board per session, not one per mount

A headset session mounts and dismounts constantly, and **starting a ride is expensive**: the obstacle triangles
are de-indexed into world space and a BVH built over them, which measures 37 ms over a light prop load, 115 ms
over 288 000 triangles and 413 ms over 900 000. With an AI field out, every opponent the rebuild re-mounted paid
that again. Catching the deck mid-jump and putting it back therefore froze the frame for a tenth of a second or
more, in a headset, mid-air — which is the one place a frame budget cannot absorb it.

So a WebXR session builds **one** board, on its first mount, and every mount after it **re-seats that same
board** — a warp and a contact re-seed, measured at 0.04–0.11 ms and flat in the prop count. Between rides the
board is *parked* rather than torn down (`TestRide.park` / `seatAt`): everything stays built and in the scene,
and only the drawing, the sound and the stepping stop. The AI field survives a dismount for the same reason,
which also means the opponents keep racing while you are on foot instead of vanishing every time you pick your
board up. `ride.ts` keeps the distinction explicit: what *configures* a board — its character, stance, gear, FX,
and which colliders it knows about — reaches it wherever it is, while what *acts on a rider* only reaches a
board that has one.

The desktop ride already worked this way (**E** has always toggled one live `TestRide` rather than rebuilding
it); this is the headset catching up.

### WebXR headset controls

WebXR carries the same seated steering behavior as the shipped OpenSlope Unity board. Riding left-stick X is first
dead-zoned and re-normalized, then mapped through **`sign(x) · x²`**: partial deflections have more range near
centre, while hard left/right still outputs exactly 100%. The curve stays active on snow, in air, and on rails;
head steering is unchanged, and centring the stick hands steering back to the head.

The tracked-controller preview is a low-poly **Meta Quest Touch Plus**, measured off Meta's own
`oculus-controller-art` reference mesh rather than eyeballed: the 6.6 cm plate, its **32° forward lean** away from
the handle, the handle's oval taper, and each control's spot on the deck all come from that file. Meta authors it
in a device frame whose origin sits up inside the faceplate, so it was first re-anchored onto what the WebXR
input-profiles asset contract means by grip space — handle centre at the origin, handle running down −Z — which
is the frame `getControllerGrip` actually hands us. None of Meta's geometry or textures ship; this is ~650 of our
own triangles wearing their proportions. A left controller is the right one **mirrored through X**, which is what
the hardware is, and that also seats the single **inward grip pad** correctly without a second outside paddle.

Its wrist menu has a **CONTROLS** button instead of surrounding the moving hands with labels. That alternate page
diagrams both controllers with the live riding/on-foot bindings, plus the board gestures: grip behind the head to
summon it, grip while airborne to take it off your feet, and trigger while holding it to put it back under you.
There is no pointed-trigger or wrist-button flight: **double-tap A / Jump** or hold **Jump + Boost** to enter
directional flight and steer it with the stick. **A / Jump** jumps both on foot and on the board, while **B holds
Boost** in either state.
Either trigger is the state-aware board verb: mount or re-equip while on foot, dismount while riding. Respawn is
on **left X** while riding, using the nearest-course/breadcrumb recovery. On foot, **left X spawns the board**
on the snow ahead without moving the player. **RESTART** in the wrist menu is the full gate reset: it abandons
the current result, puts the rider at the top with the board ahead, resets the opponent field, and starts a
fresh Race/Showoff run when the board is next mounted. **Left Y shows or hides the complete wrist menu** in either
locomotion state; the menu starts visible on each headset session. Fixed foveation is requested at **1 (full)**
when every XR layer is created rather than occupying a controller button.

**V** at the desk, **right-stick click**, and the wrist menu's **3RD PERSON ON/OFF** button toggle first/third
person in either WebXR state. The third-person boom moves the rendered eyes **2 m behind and 1 m above** the
complete character; controller previews, the pointer, wrist menu, and performance panel move with that presented
headset. Avatar IK rebases the same physical hand poses onto the unshifted body, so its hands mirror the player
without pulling the controller models or wrist UI back onto it.

The upright headset rig receives **25%** of grounded stick yaw, applied after the retail 6°/tick clamp. The board's
carve physics still receives the complete shaped stick input. At takeoff the view carry returns to **100%**, and a
rail likewise carries stick yaw into the view at 100% of its 90°/s presentation rate. On a rail, releasing the stick
lets the head aim the freely rotating deck while leaving the headset seat pinned. These comfort rules are gated by
the presence of the WebXR gaze source, so desktop, phone, gamepad, keyboard, and AI rides keep their existing input
and the retail rail's ±80° target pose.

The left-wrist menu is available throughout the session: press **left Y** to show or hide it, then aim the right
controller at it and pull the trigger. Alongside calibration, restart, view, controls, and exit, **VR STATS
ON/OFF** attaches or removes the forward performance readout, console samples, and asynchronous GPU timing
without leaving VR. The changed stats state is remembered as the Test toolbox's starting choice for the next
session; off retains only the compact speed/control watch.

Test's launch-time **VR render scale** defaults to **1.5×**, spans **0.5×–3×** in 0.1× increments, and is passed to
`setFramebufferScaleFactor`. Because each dimension scales, 3× requests nine times the nominal eye-buffer
pixels. WebXR does not reveal the headset's recommended 1× viewport until an immersive frame has rendered, so
the toolbox retains that real per-eye measurement after the first launch and shows it beneath the slider. A
runtime may round or clamp any request—especially an extreme one—so projected sizes are labelled as requests
and the wrist profiler remains the live check on the eye buffer actually allocated and whether it fits the
headset's frame budget. The slider always retains its full 0.5×–3× range: a runtime's native factor is only an
advisory hint because supersampling above native can still work. When the selected value exceeds the best
observed bound, the projected resolution turns red but remains selectable. The runtime-native factor is shown
separately and explicitly labelled as **not a cap**, so a native 1× report does not warn against a known-good 2×
request; a 3× request actually allocated at 2× records that observed cap.

**Tuning ▸ MSAA + smooth cutouts** is one global, default-on setting for the editor, browser Play, and the next VR
session. It smooths polygon edges with multiple coverage samples and lets depth-writing cutouts turn continuous
alpha into smooth sample coverage. In VR this happens at the selected eye-buffer resolution: generally cheaper
than doubling render scale, but still additional raster, depth, memory, and resolve work. Three r170 exposes no
honest shared 2×/4×/8× selector here—`XRWebGLLayer` takes an antialias boolean and leaves the count to the runtime,
while the projection path maps that boolean to four samples—so the toolbox offers only Off/On rather than labels
it cannot enforce. The wrist profiler reports the effective layer AA state and sample count where the runtime
exposes one.

### Quest browser panel versus WebXR

A Quest has two different browser input worlds. In the ordinary floating browser panel its Touch controllers are
ray pointers for page interaction; they are **not** standard browser gamepads and do not appear in
`navigator.getGamepads()`. Their sticks, face buttons, triggers, and grips belong to the immersive session's
`XRInputSource.gamepad` objects, which is the input path under **Play in VR**.

An XR-capable browser with a coarse primary pointer therefore leads with **Play in VR**. **Play on screen** remains
available for a physical keyboard or a separately connected Bluetooth standard gamepad, but explicitly declines
the direct-touch diagram: pointer accuracy is not proof of a touchscreen. Flat headset-panel Play retains the
ordinary toolbox/Stop action, and every coarse-pointer flat ride also gets a small independent **Stop** button.
That button is not a child of the touch diagram, so hiding the diagram for a gamepad cannot remove the way out.

### Standard game controller

Any Web Gamepad API device with the standard mapping works, including Backbone/MFi controllers exposed by
iOS Safari: **left stick** or D-pad X steers (and spins the board in the air, as A/D do), while stick Y tucks/brakes
on snow or rails and flips forward/back in the air; **A / South** holds and releases ollie;
**X / West** boosts (following the board nose in air, like desktop Shift); **Y / North** gets off or back on the
board; **B / East** respawns; **R2 zooms in**, **L2 zooms out**, and **Menu** pauses or resumes the run.
On foot, the **left stick** (or D-pad) walks/strafe-moves relative to the view and the **right stick** looks around
at the same 120°/s full-deflection rate as WebXR smooth turn. **A / South** jumps, a second airborne press enters
Superman flight and then thrusts up. The left stick becomes view-relative flight thrust after takeoff, and
**X / West** restores full flight speed.
**L3** toggles telemetry and **R3** marks it. Live
pad input mirrors on the touch controls as a diagnostic, then hides the thumb overlay after the screen has been
idle for three seconds. Keyboard, touch, and pad holds are source-aggregated: releasing or unplugging one device
cannot cancel another device's hold, and a vanished pad releases its own buttons, analog steer, and ollie charge.

Test setup's **Collect telemetry** checkbox begins recording at the first physics tick of the next ride; use it
for full-run comparisons. An active telemetry capture is saved when the ride ends. Slopesmith downloads a JSONL tick stream plus a
small summary JSON. The stream is sampled at the physics model's fixed 60 Hz boundary and records the opening and
closing position/velocity, visible deck basis, which end of the deck is leading and how far through a flip it is
(`lead` / `flip`, below), derived trajectory/board pitch, contact probe (including signed
speed along its fresh normal) and ground decision, ground redirect, launch impulse, contact transitions,
resolved barriers, and rideable floor crossings that were deferred to the following contact probe. Interleaved
`camera` records capture every rendered frame: the interpolated rider subject, uncorrected candidate eye, final
eye and view basis, trajectory-pitch response, FOV/near plane, and the clearance branch that moved the camera.
Schema v4 also records every attempted unbury/sight-line/ground/lateral segment and iterative terrain-volume
query, including misses and each hit's point, normal, terrain-vs-obstacle source, native obstacle key, iteration,
and total correction distance. This is the
directly comparable counterpart to Trailmap's frame-fenced retail camera trace. The HUD's
top-left `TELEM` line shows pre-roll, recording, marker, and saved state.

### On a phone

Touch controls appear when the pointer that launched the ride was actually a **touch**, or on the first later
touch of a hybrid machine. A coarse-pointer query only sizes touch-friendly editor chrome; it no longer enables
the ride diagram by itself, because headset controller rays can be coarse too. The keyboard legend hides itself
once the thumb controls are up.

- **Left thumb — floating steer / walk stick.** The ring rests in the bottom-left corner, but the whole left zone is
  live: press anywhere in it and the ring **re-centres under your thumb**. A blind grab mid-run steers from
  wherever it lands, so you never have to look down to find the stick. The knob's X steers; while riding, pushing
  Y up/forward holds **TUCK**, pulling it down/back holds **BRAKE**, and returning through the dead zone releases
  both. On foot those same two axes become movement: X strafes and Y walks forward/back relative to the view.
  Ground/rail steering runs through a **response curve** (`y = 0.25x + 0.75x³`): a quarter as sensitive at centre, where you
  live holding a line, converging on full lock at the rim so a hard carve is still there. A ring this small can't
  be linear, gentle *and* reach full lock — 47px of thumb won't hold all three — so the curve is what gives. In
  the air X uses the **linear post-dead-zone throw** instead: half a deliberate swipe produces half the 270°/s
  spin rate rather than being softened again. Vertical tuck/flip intent engages once Y reaches its threshold and
  owns at least as much of the direction as X, so a nearly horizontal spin does not pick up an accidental flip;
  a deliberate diagonal still combines both. A held XR stick also owns air heading over head-follow until centred,
  so looking straight ahead cannot cancel a thumb-commanded spin.
- **Right thumb — OLLIE and BOOST**, with **FPV/3P** and upload/download in the freed pill row above. OLLIE **fills
  with its own charge** under the thumb that's holding it, where the eye already is. Sliding off a held button
  still releases it, exactly as lifting a key would. Off the board OLLIE becomes held **JUMP** while **BOOST**
  remains the full-speed flight modifier; view and board controls stay in place. Tap JUMP once to leave the ground
  and again in the air to fly; in flight JUMP thrusts up and the left stick thrusts horizontally.
- **Drag the open viewport to look or orbit.** There is no second virtual stick: press anywhere not occupied by a
  control and drag to turn or look up/down. On the board in third person this rotates the camera around the rider;
  on foot it aims the walking view. The mobile gesture runs at 1.35× the desktop mouse delta so a phone-width
  sweep turns without needing a second grab. The movement stick and action buttons remain independently usable
  under other fingers while looking.
- **Pinch the open viewport to zoom** in third person. It scales the same avatar-centred boom as the desktop
  wheel, so it does not introduce a separate height control or change the current orbit angle.
- **Top-right — fullscreen, camera view, and independent Stop**, out of the thumbs' arc. Stop is a normal DOM
  button above the complete touch diagram rather than one of its captured gestures, so a finger, accessibility
  activation, mouse, or browser controller ray can all use it—and a connected gamepad hiding the thumb diagram
  cannot hide Stop with it. Without that independent action the ride is a trap on a phone: there is no Esc key.

The ride goes **full screen** only after direct touch actually owns it: `TestRide` stamps `body.os-riding`, the
touch HUD adds `body.os-touch-riding`, and the responsive stylesheet hides the top bar and toolbox for that pair.
A coarse non-touch browser keeps the ordinary chrome. The page scale is pinned there too — see below.

The overlay **scales off the display's short edge**, which is orientation-invariant, so rotating the phone never
resizes the pads under a rider's hands. The big controls scale freely (OLLIE and BOOST stay past the ~44px a thumb
wants at every size); the small ones carry floors, because scaling a 38px pill linearly walks it straight off the
bottom of usable. On a 393px handset the right cluster takes ~31% of the screen's short edge, against 42% unscaled.
The stick's dead radius does **not** scale — a thumb's precision is a physical fact — and it stays at 5–7% of the
knob travel across every device, well inside the boost-and-steer band the response curve opens up.

The stick is the only input that gives the engine what it actually asks for: a **stick axis**, not a button
([Trailmap: 330]). A key slews `lean` to its ±0.905 clamp in about a tenth of a second, and the held boost's lean
window is ±0.08 — so on a keyboard *any* steering input kills the boost thrust outright. Only a thumb reaches that
band, and the response curve is what makes it wide enough to sit in: a linear stick puts the whole boost-and-steer
window inside the first **6.9px** of thumb travel, the curve gives it the first **15.5px**.

### Pinning the page scale (`index.html`)

A zoomed page is close to unescapable here, so the scale is pinned rather than recovered:

- **Pinch.** Safari has ignored `user-scalable=no` since iOS 10. `touch-action: pan-x pan-y` on `html, body`
  disallows the pinch while still letting the toolbox scroll (Chrome honours this; Safari does not), and a
  `gesturestart` / `gesturechange` / `gestureend` handler refuses WebKit's page-zoom gestures outright. Ordinary
  touch events are untouched, so the canvas's own orbit/dolly pinch is unaffected.
- **Font boosting.** Android Chrome inflates text in some layouts; `text-size-adjust: 100%` turns it off.

Refusing that gesture is also refusing the **only way out** of a zoom, whatever caused it — iOS still auto-zooms a
focused field whose computed font-size is under 16px, and the toolbox runs 10px fields. So the handler is guarded:
once `visualViewport.scale` is above 1 the pinch is let back through, where it is the escape hatch rather than the
hazard. Inflating every field to 16px would prevent that auto-zoom, and was tried — it makes the toolbox unusably
chunky for a defect that `maximum-scale=1` appears to hold on its own.

Why you couldn't zoom back out before: `OrbitControls` sets `touch-action: none` on the canvas for its camera
gestures, and the canvas covers the screen — so the browser never sees the pinch you'd undo it with.

The `(pointer: coarse)` query gives the top bar the compact pass it never had (the width/height query above only
ever reached the dock). It sets **no field metrics** — those have one owner, the mobile block.

Separately, the mobile layout query is `(max-width: 760px), (max-height: 500px)`. The `max-height` arm is what
catches a phone in **landscape** — a modern handset is 852–932px *wide* on its side, so a `max-width` query alone
handed you the full desktop dock and desktop type in the one orientation you actually ride in.

The bottom HUD reads **speed (km/h)** and the **grade** (terrain steepness) under the board, plus an **✈ air**
/ **» boost** flag and the ollie **charge meter** while the ollie is held; a top-left chip (tucked under the top
bar) shows which mountain you're on and a live **FPS** counter — so a designer gets a number on "that pitch is
37° and you hit 110 here", not just a vibe.

The persisted Test option **Race countdown** runs a reference course's recovered SSF `StartCountDown` sequence,
putting **READY · 3 · 2 · 1 · GO** at centre screen. Its authored Wait chain holds both the player and an enabled
AI field at the gate for 2.5 seconds; effects collision/trigger entry scanning begins only after GO. The option is
off by default so repeated editor test runs launch immediately. Authored mountains and references without that
proven frame sequence also start immediately.

**Laps.** A course raced over more than one pass counts them down (`app/ride/laps.ts`): the HUD shows the
passes still to run beside the speed — `N laps left`, then `final lap` — a crossing flashes the
count at centre screen the way the game's announcer calls it ("3 LAPS LEFT" at MEGAPLEX's first crossing), and
the run reads **finished** at the plane. The count comes from the mountain (Scene ▸ `<mountain name>` ▸ **laps**) or,
riding a reference, from the level, which is how MEGAPLEX arrives at four — ridden top to bottom four times,
of which the announcer counts down the last three — and every other retail course at one
([Trailmap: 390-lap-counter, 390-lap-rate]). A single-pass course shows no lap read-out at all.

A crossing counts at whichever of **two stations** the pass actually ends at: the finish plane below, or the
**lap-gated volume's own mouth**. The second is MEGAPLEX's load-bearing one — its finish plane sits ~25 m
down-course of the tube, so a mid-race rider is lifted before ever reaching it, and only the pass the tube
declines to lift rides through to the plane and finishes there. The stations debounce against each other, so a
course carrying both in sequence counts one crossing once ([Trailmap: 390-lap-field]).

The finish is the **anchor the mountain itself carries**, taken as a flat plane a rider must actually pass
through: the authored course's finish flag (`core/doc/course.finishFrame`), or a reference level's DTF-zero
crossing with the racing direction through it (`core/reference/terrain.dtfZeroFrame`). Only a course with no
anchor at all falls back to the tail of its own line. On a **lap** course that distinction is the whole feature
and not a nicety — the recovered line is not the run. MEGAPLEX's stops 320 m above its own finish, so a
countdown taken off that tail counts a plane in the middle of the mountain, and the finish tube then throws the
rider permanently past it: the count reaches its last pass and no rider can ever cross again.

The counter exists because something reads it: the **lap-gated boost volume** is skipped outright once it reads
zero, so MEGAPLEX's finish tube throws a rider back up the mountain three times and lets them through on the fourth. That
is the whole of what a lap does here — counting one does not put the rider back at the top, because the engine
doesn't either. A mountain authored with laps and no such volume counts them honestly and leaves the rider at the
bottom, exactly as the same course would on the disc.

## Prop collision in Test

Test captures the selected mountain's colliders at **▶ Play**. Authored reference-library props use their baked
solid render proxy; authored models obey their per-placement solid/ride-through setting. Reference instances keep
their recovered contact class, bounce, SurfaceType, and stable identity for collision sounds/effect graphs:

- mode 1 uses the dedicated `Collision/*.obj` triangle proxy, not the visible render mesh;
- mode 2 uses the model's own local bounding box, oriented with the placement — **not** the instance's world
  AABB, which is the cull box and is much larger for anything rotated;
- mode 3 tests the decoded physics-body leaf spheres analytically, including affine/non-uniform placement scale;
- visibility is not a collision gate, so hidden utility/collision twins remain active when `PlayerCollision` is set.

Triangle sources are flattened into one world-space BVH. Sphere bodies and bounding boxes stay analytic with a
conservative broad phase. Ride-through contact reports the exact crossing without changing motion; solids
collide-and-slide or bounce, and non-negative SurfaceTypes contribute rideable upward contact.

### What the rider is, per mode

The engine does not meet every prop with the same rider. It carries a collision volume — one body sphere plus
eighteen limb spheres posed from the skeleton — and each collision mode consumes a different part of it
([Trailmap: 370-probe-volume, 370-probe-modes]). Three of those rules are reproduced here:

- **A mode-2 box is met by the BODY SPHERE and nothing else** (`RIDER_BODY_Y`, `RIDER_BODY_R`), resolved once
  per tick rather than once per body sample. The deck, shoulders and head have no say in a box contact at all.
- **That box is ORIENTED** ([Trailmap: 130-mode2-oriented]): it is the model's own local bounding box, held per
  model object, shared by every instance of that model, and tested in the placement's local frame. It is not
  the instance's world AABB. The difference is large, not marginal — ALOHA's jumbotron screen is a 14.6 m
  zero-thickness panel yawed 31°, whose world AABB is a 12.5 x 7.6 m slab in plan with corners standing ~6.5 m
  off any surface, while its actual collider is the panel. Read live off a paused PCSX2 session: a rider
  several metres inside that world AABB is neither stopped nor pushed out by it.
- **The box law itself is face-only** (`core/collision/native-box.ts`): a face registers only when the sphere's
  CENTRE is inside the two perpendicular slabs, so the admitted region is the box grown by one radius across
  each face and left **square at the edges and corners**. A sphere overlapping only a vertex reports nothing.
  Contact normals are therefore always one of the six axis directions.
- **A mode-3 body is gated on the body sphere reaching it** before any limb is tested. A low member the deck
  passes through but the torso clears produces no contact — the native rule that makes gateway bodies hollow to
  the torso rather than to the board.

A box also **resolves differently from everything else**. The engine does not clip a rider's movement against a
mode-2 box: it completes the move, tests statically at the new pose, and pushes the rider back out along the
contact normal by `NATIVE_DEPENETRATION` × the reported penetration before touching velocity
([Trailmap: 370-depenetrate]). So boxes are resolved *after* the collide-and-slide loop rather than inside it.
Clipping instead is what makes a grazing corner read as catching on something, and what leaves a rider embedded
in a shape they are already inside — the case collide-and-slide handles worst, because a sweep that starts
overlapping has nowhere to advance to.

`RIDER_BODY_R` is **measured, not guessed**: 0.85 m, read live off a paused session two ways — the constructor
argument the engine scales by 100, and the world-unit radius stored on the sphere set. That makes the body
sphere a coarse ball around the whole rider rather than a small chest sphere: centred at 0.92 it spans roughly
0.07 m to 1.77 m, so nothing rides under it and nothing clears it overhead. Where it and a deck-sized volume
genuinely differ is horizontal reach AT deck height, which is only `sqrt(r² − 0.78²) ≈ 0.34 m` — well short of
the board's 0.78 m half-length, so nose and tail still lead the ball for proxies and bodies. Whether the radius
varies per character is unsettled; see [Trailmap: 370-probe-volume].

One deviation is deliberate. The engine tests boxes and bodies **statically**, once per 60 Hz tick, and lets a
fast enough rider tunnel a thin one; detection is swept here, which changes *when* a contact is found and never
*which* contacts exist, and a box crossed clean through inside one tick is resolved from its entry pose.

Not reproduced: the engine's mode-1 test sweeps the whole sphere volume against proxy triangles, where the ride
still sweeps zero-thickness segments — so a proxy mesh is slightly thinner here than on the original. The
per-motion-state limb mask is likewise only approximated; see the grind note below.

### Seeing it — Test ▸ Show colliders

None of the above is visible from the art, which is why it has a toggle
(`viewport/scene/ride-collider-overlay.ts`). It draws both halves of a contact:

- **the world**, in blue for props that can stop you and violet for the contact-only ones that report and
  dispatch but never change your motion — each as its real shape, so a mode-1 placement shows its `Collision/*.obj`
  proxy rather than its render mesh, a mode-2 one shows the bounding box, and a mode-3 one shows its leaf spheres;
- **the rider**, in orange: the board footprint outline and a mark at each torso/shoulder/head sample, plus the
  **body sphere** in red, because that sphere is the entire answer to a bounding box and sits about a metre above
  the deck.

The rider half is built from `ride/rider-volume.ts` — the module the contact solver itself reads — so what is
drawn cannot drift from what collides. The world half is gathered within ~70 m of the rider and re-gathered when
they have moved 20 m, because a reference level's full collider set is neither readable nor affordable as
wireframe. Both halves draw with depth testing off, so a collider inside a prop is still visible.

Prop triangles are a two-sided collider — the plane is faced against travel, so mirrored source winding cannot
make a fence one-way — but floor-vs-ceiling is decided by the side the winding says is solid, not by the faced
normal. A rideable near-horizontal face belongs to the contact probe from either side: a swept body sample that
starts inside a shell leaves through the top, and treating that exit as a ceiling would drive the rider deeper in
rather than keeping them out. Near-vertical faces keep the two-sided treatment. The barrier sweep's roof clause
also never forces the air state against the body the deck is currently seated on, since that latch clears only
once the deck rises clear of its contact.

**Wedged on the level.** During an active scored run, a rider that a prop has stopped is not left there. A **wedge integrator**
([Trailmap: 395-reset-arm]) decays every tick and is fed on every frame a prop contact actually pushes the rider
back, by `1 − dot(boardUp, normal)` — so about five consecutive frames of a square-on shove carry it over the
threshold and the rider goes out of play, which is **the carry-back** below and, for an AI rider, the field's own
course reset. Both halves of that feed matter. Terrain never counts, or every carve on the mountain would accumulate;
and a rider *riding* a prop has its board up along the contact normal and feeds **zero**, so a rideable prop
surface is contact without wedging however long you stay on it. This is why the engine needs no stuck timer, and
it has none: being lost, slow, or making no progress never resets anybody — only impacts, the floor, an authored
volume, or the button. Outside a live Race/Showoff score run, all world-driven recovery is disabled: a crash,
wedge, reset surface/volume, or fall remains wherever physics takes it until the player presses the manual reset.

**The carry-back.** During a live scored run, the four automatic ways out of play — the wedge integrator, the
out-of-bounds floor, an authored Reset (`Surf_0`) surface, and a MainType-13 reset volume — plus the rider's own
**R** take one exit. Outside one, only **R** invokes it. The destination is the
**course near where the rider left it**, never the top of the run. Three tiers, best first, the same three the
Unity board runs (`RideableBoard.OutOfBounds`, Unity/docs/031):

1. **The nearest point on the authored course line.** Nearest *horizontally*: how far a rider fell is not a
   measure of how far off the course they are, and the out-of-bounds floor sits a hundred metres under the
   terrain by construction, so a 3D radius tight enough to mean anything would reject the course for every
   rider who left the world through it. The line's own height is never used — a course is a race line and not
   a surface, floating over the jumps it crosses and dipping under the terrain elsewhere — so the ground under
   it is cast for separately, passing over any Reset patch, which is how a reset avoids setting the rider back
   down in the skirt they just left. They face down-course, and down the landing's fall line where the line is
   too steep to read a bearing off, never uphill.
2. **A breadcrumb a few metres back up the trail**, for a mountain carrying no authored course. The trail is a
   ring of recent positions taken only on frames the rider was on real terrain — never a prop, which may be
   shoved or retired by the time the reset needs it — and a teleport clears it, since it now leads back to
   where the rider isn't.
3. **The run's start gate**, which is also where a rider goes who has been reset three times inside four
   seconds: past that the reset target is itself the trap, and only leaving it entirely breaks the loop. The
   gate meant is the *run's*, not the respawn point the last carry-back saved over it.

Every tier sets the rider down at the engine's fixed 8.33 m/s down-course push rather than the speed they
arrived with: a rider is wedged and stopped as often as they are falling and fast, and neither number has
anything to do with how a reset should let go of them. **AI riders opt out** (`carryBack: false`) — the field
runs its own rubber-banded reset onto a *respawnable* AIP line, placed with the pack rather than where the
rider fell, and that reset is armed by exactly the plain respawn this replaces.

The flagged static-prop velocity response follows [Trailmap: 370-world-interaction]: incoming normal speed `s`
leaves as `max(b·s, 0.55556 m/s)`, with tangential velocity unchanged. Thus the soft 0.03 tier still pushes the
rider out at a universal 2 km/h on a slow hit. Native PlayerBounce-off props remain contact-only and are not added
to the solid obstacle set; generic/manual solid fallbacks collide-and-slide without receiving that floor. The
retail game also enters wipeout when the full normal delta
`max(s·(1+b),s+0.55556)` exceeds `19.44444+8.33333·dot(boardUp,normal)` m/s.
Test currently reproduces the rebound but does not yet implement that wipeout state/animation.

Per [Trailmap: 370-impulse], **Roller-activated**
instances (crash bags) are shoved through the specified rigid-body impulse
rather than the bounce path:

```
impulse = 1.3 · closingSpeed / (propInverseMass + riderMassTerm + rotationalEffectiveMass)
```

The barrier sweep declines to collide-and-slide on them, and the impulse is applied along the contact normal **at
the contact offset**, so the body picks up angular velocity as well as linear. The authored rider restitution is
deliberately not read here. Movement activation and scalar mass come from the collision Roller's payload,
independently of instance collision response mass.

`rotationalEffectiveMass` is `n·((I⁻¹(r × n))×r)` over the instance's **authored physics-body inverse inertia**,
now extracted from `Effects.json` alongside the sphere tree (`UFloat15-23`, with `UFloat0-2` the centre of mass).
That tensor is what separates one body from another on this path: a chunky near-isotropic crash bag
(inertia ≈ 17569/18104/16997) divides the impulse mostly into travel, while a thin path marker (1960/1960/**122**
about its flag axis) spends it spinning. `propInverseMass` is **1/RollerMass**, independently of the instance's
static response mass. A crash bag happens to author 5 in both fields [Trailmap: 370-impulse, 370-roller].

There is **no vertical bias and no hard-coded upward kick** [Trailmap: 370-impulse-vals]; loft comes from the body
spinning over its own ground contact, which the scene's moved-body sim resolves. That sim follows
[Trailmap: 370-bodysim]:
gravity 9.8 m/s², the fixed tick, terrain contact, and an **activity accumulator** decayed ≈0.95 per tick that puts
the body to sleep below a threshold. The decay is the sleep detector, not velocity damping — what slows a knocked
prop is its own ground friction. A shoveable body is never rideable ground, and a graze below 0.75 m/s leaves it
standing. `riderMassTerm` is the reciprocal of the specified rider-stat product, and sits near **0.01** for an
ordinary rider; that is why riders plough through bags nearly unslowed. The moved-body simulation uses 0.5
terrain restitution, retains 0.9648 of linear and angular motion per contact, and sleeps below 1.0 m²/s²
[Trailmap: 370-impulse, 370-bodysim].

A Roller-activated instance's collision slot authors the **Roller** node against the same host — the GARI crash
bags are slot 47 → effect 107, a lone Roller (mass 5, direction 0/0/0) — so one hit runs the shove and, a frame
later, the authored Roller. Retail runs BOTH, and the Roller's contribution is experientially load-bearing: the
impulse alone throws the bag along the rider's own travel at close to the rider's own speed (a captured hit: bag
13.5 m/s vs rider 12.9), so it paces the run and gets ridden through. The Roller launch **merges into the flying
body** — its up-kick (mass 5 → 6 m/s along the instance transform) vaults the bag out of the rider's corridor,
which is the retail "kicked away" read. Replacing the body instead re-seats the bag at its authored transform and
hops it in place (in a capture: a `shovedBodies` digest of `samples: 1, settled: false` — one launch sample, then
silence as the tensor-less replacement goes unsampled); suppressing the Roller keeps the bag underfoot. An asleep
body is left settled, and a standalone Roller (fire-hydrant lids) with nothing in flight behaves as authored.

Roller bodies are also **transparent to the chase camera**, the same rule ride-through foliage already follows:
the rider passes clean through them, so the view must too. A capture of the camera clearance pass fighting a
struck bag's collider for ~25 frames per hit — corrections up to 3.5 m, `origin-unbury` firing inside it — is
what identified that camera shove, rather than the bag itself, as most of the "tangled with the bag" feel.

The obstacle set is **baked once at launch and refitted each frame**. Building it is a single BVH over
world-space triangles, so a source that moves during the run declares a `liveMatrix`: the ride re-reads those
poses once per rendered frame, rewrites just their vertices, and refits the tree — bounds widen in place, the
bake's topology survives the whole run. That covers a model clip (a deploying ramp, a retracting pillar), an
effect matrix override (a spline mover, a shoved body in flight), and a piece throw, on both reference and
authored placements; sources without a provider are never touched, which is nearly all of them. Model clips
advance before the ride in the frame loop, so a clip-driven collider is exact; the Play effects runtime steps
*after* the ride, so an effect-moved body's collider trails its render by one frame.

One limitation remains intentional and explicit: a shoved body's ground contact is a **single support sphere under its centre of
mass**, sized by the CoM's ground clearance at launch (the body was resting when struck, so that clearance IS its
underside depth — the render bounding sphere is not that measure and once stood a bag on a 2.78 m stilt). It rolls
and tumbles but never pivots over an edge: the leaf spheres that would let it tip and loft are extracted and
available, but the contact solve does not yet use them as its support set. A mild in-contact scrub stands in for
the rolling resistance a sphere contact cannot produce — the one solver coefficient set by feel rather than
measurement — so a rolling body coasts, slows, and hands itself to the sleep test.

## Performance

**Reference profile.** On a standalone Quest 3, the defaults — a **1.5×** VR render scale with **MSAA + smooth
cutouts** on — hold a measured 60 fps while keeping a polished image. That is the profile the controls below are
tuned against; the in-headset performance panel reports the live figure on any device, and draw distance and
render scale are the two settings an author trades against it on an unusually large or detailed mountain.

**Tuning ▸ MSAA + smooth cutouts** defaults on. It creates an MSAA default framebuffer and maps continuous cutout
alpha into sample coverage: smoother, still depth-correct, and not an alpha-blended whole-model draw. The same
preference requests antialiasing on the next WebXR layer, so editor, browser Play, and VR cannot contradict one
another. Turning it off restores the faster stable alpha hash; partial panes then have a visible grain. Changing
the setting reloads Slopesmith because WebGL fixes default-framebuffer samples when the context is created. Compare
the same camera/run with the dashboard below to measure the MSAA fill/depth cost on a particular device.

The top-left chip defaults to the mountain name and live FPS; expand **Performance details** for a selectable,
copyable dashboard matching the VR profiler's visual hierarchy. A frame-time headline and bar are coloured against
an explicitly labelled 60 fps reference (desktop browsers do not expose their compositor refresh budget), followed
by CPU, asynchronous GPU, pacing, grouped timing, workload, and resource cards. The largest CPU phase is highlighted
so the long pole reads at a glance. The expanded dashboard repaints at 5 Hz, while the compact FPS line remains live,
so updating the profiler does not become part of every measured frame. Starting telemetry recording expands it
automatically so the recording state remains visible. Its broad, mutually exclusive CPU
phases are **world FX · ride · play FX · scene · render CPU**. They add up to **CPU**; **wait/GPU** is the
unobserved remainder of the real frame interval, including asynchronous GPU execution, vsync/idle, and browser
or OS scheduling. `render CPU` is Three.js traversal and WebGL command submission, not a GPU timer.

The ride row drills into that broad `ride` phase without adding those values to CPU a second time: player
**physics** (with **cast** as its terrain/prop query subset), **AI**, rider **pose**, chase **camera**, telemetry,
and HUD DOM work. `ride` also includes small session/input overhead around those named parts. The final count is
terrain plus triangle-proxy collision size; analytic sphere leaves are not triangles. Samples use a 90/10 moving
average and the HUD displays the previous completed frame, so measuring its DOM update cannot recursively inflate
the frame it claims to describe.

The two render-work rows are exact counters from Three.js after that same main-scene submission: **draw** is the
number of WebGL draw calls; **render tris/lines/points** are submitted primitives after instancing; and **geo ·
tex · programs** are the renderer's currently resident geometry, texture, and compiled shader-program resources.
They are snapshots rather than smoothed durations, so hiding Props / Tricks immediately shows whether it removed
draw calls or only changed pixel cost. These counters require no second scene traversal and therefore do not make
the profiler duplicate the render bottleneck it is measuring.

The rays are answered through a **BVH** (`three-mesh-bvh`), built on the first **▶ Play** over a groupless
twin sharing the terrain's vertex + index buffers — groupless because the textured meshes carry one render
group per texture run (hundreds on a big reference) and `MeshBVH` plants a separate root per group, which a
single-root twin sidesteps; built `indirect` so the shared index is never reordered and `faceIndex` keeps
mapping face → cell / patch for the surface lookup. The tree is cached on the geometry (terrain rebuilds
replace the geometry object and the tree with it) and queried directly in terrain-local space with an
explicit `DoubleSide`, so the hits match what `THREE.Raycaster` returns against the render mesh. Same rays,
same hits, same physics inputs — it's the accelerated query PhysX answers for the Unity board's
`RaycastNonAlloc` — so **cast** stays sub-ms even on a six-figure-triangle reference mesh, and a slow ride
reads as **rest**-bound (rendering a lot).

The reference case is commonly **rest-bound**: a prop-heavy reference level renders hundreds of scenery instances
every frame, which a bare custom mountain does not. The top-bar **Props / Tricks** filters can remove that render
cost, but they do not remove collision. Prop triangle tests use the combined obstacle BVH; mode-3 bodies use their
analytic leaves only after a conservative body bound says the rider is near. A mode-3 segment pass first collects
and orders the cheap quadratic leaf intersections, then evaluates the full union-smoothed normal only for the
earliest incoming boundary it needs. Starting inside one leaf still skips that outgoing root and advances to the
next incoming leaf; a rideable up-face can likewise defer to the ground probe without hiding a later wall hit.

### Culling and batching the reference world

A shipped level is the hard rendering case, and it arrives in the shape a 2000-era console wanted: one
map-spanning terrain quilt and a few thousand small props, each material naming exactly one texture page. Three
things now sit between that and the draw call count, ported from what the Unity/VRChat build learned
(`Unity/docs/vrchat/025-performance.md`).

**The quilt is split into cells** (`viewport/mesh/reference-batching.ts`). Drawn as one mesh with map-spanning
bounds it could never be frustum-culled: the whole course went out from every viewpoint. It is reordered into a
200 m XZ grid of chunks that share one index buffer and one set of vertex attributes — so it is still a single
upload — but each chunk carries its own tight bounds, and the renderer rejects the off-screen ones for free. That
is the same `StaticChunker` fix, and it applies equally to the editor viewport, flat Play, and a headset (WebXR
culls once against a frustum enclosing both eyes, so a rejected chunk is rejected for both).

**Texture pages are packed into a WebGL2 array texture** (`viewport/mesh/texture-array.ts`). This is the floor the
other two hit: geometry already merges — the quilt into cells, static props into `BatchedMesh` — but one draw
carries one sampler, so a cell holding eight tiles still cost eight draws and the prop batches bottomed out at one
per page. Every page becomes a slice of one `sampler2DArray`, the slice index rides a per-vertex attribute (Unity
puts the same number in `UV0.z`), and a cell or a prop batch becomes one draw whatever mix of pages it spans. An
atlas cannot do this job: SSX UVs deliberately run past [0,1] to tile a page, and array slices are the only
packing where each member keeps its own wrap. GARI packs 52 terrain pages and 55 of 56 prop pages into one
128×128 array each. What stays out and keeps its own material: a page larger than the bank's canonical size, a
page that never loaded, and any material whose texture *moves* — a UV scroller or a multi-frame flipbook owns its
own `Texture` offset and source, neither of which means anything for one slice of a shared array.

**A range gate** (`viewport/scene/range-cull.ts`) drops terrain cells and prop slots past the **Draw distance**
chosen in Test (Near 300 m · Medium 600 m · Far 1200 m), and drives the fog to match so the boundary reads as
weather rather than as a hole. It arms only while riding, re-checks on a 25 m movement gate, and restores exactly
what it hid. On a desktop frustum Medium and Far usually remove nothing the frustum had not already removed; Near
bites, and the tier exists because the constraint that matters is a headset's CPU.

Measured together on GARI, three seconds down from the start gate:

| Draw distance | before (400 m cells, a material per page) | after (200 m cells, one array) |
| --- | --- | --- |
| Near · 300 m | 116 draws · 99,612 tris | **40 draws · 72,176 tris** |
| Medium · 600 m | 140 draws · 146,986 tris | **42 draws · 91,767 tris** |
| Far · 1200 m | 140 draws · 146,986 tris | **42 draws · 91,042 tris** |

Static prop batches over the same level fall from 63 draws to 14 in the editor (74 to 36 in Play, which forks
more materials for effect hosts). The two halves are load-bearing together and worth little apart: without the
array, 200 m cells would submit hundreds of draws; without the tighter cells, the array would leave ~40% more
triangles on screen.

## Gravity

Airborne, the port matches the shipped **two-stage gravity** ([Trailmap: 340]): weak while rising (≈ 8.5 m/s²)
and strong while falling (≈ 19 m/s²) — the floaty, managed SSX arc (slow up, fast down).

Grounded load uses the active surface's `A/100` as world-down acceleration
([Trailmap: 320, 330]). The banked contact response preserves its normal residual,
and separate forward and lateral resistance shape the resulting travel. The earlier
4.73 m/s² Snowdream value measured net course-energy gain; applying it as reduced
gravity alongside the recovered resistance would count those losses twice.

At zero lean the deck settles near `bog * cos(slope)`. Banking reduces the normal
component of a given scalar contact response, so a held carve can settle deeper.
See [061 — Carving response](061-carving-response.md) for the formulas, neutral
caller inputs and remaining differences from the original controller.

The **sink budget** is not the resting sink depth; it is the depth past which the capped pushout intervenes
[Trailmap: 310-fields, 320-pushout].

## The tick

The physics runs a **fixed 60 Hz tick**, matching [Trailmap: 300, 320-spring-accel]. The simulation step may be
scaled by the game's bounded time-dilation dial; it is not derived from render-frame duration. Contact constants
are therefore per-tick: the pushout is a per-tick correction
and the contact fields slew a flat 1.6667 units a tick. `step(dt)` banks real time and spends it in whole ticks;
the pose, camera and HUD are frame things and run once, after. The fixed tick also collapses the carve's
frame-rate compensations — the 6°/tick yaw clamp *is* 6°/tick, and the heading closure is the engine's raw
fraction with no exponential rewrite.

The integration is the engine's own order: **position first, with the tick's opening velocity, then velocity,
with an acceleration frozen at the tick's opening state.** That is plain explicit Euler, and it is kept, because
it is not an artefact — it is what the contact feels like. See [The grounded redirect](#the-grounded-redirect--why-the-stiff-contact-stays-quiet).

## How the board rides (`app/ride/session.ts`)

In **world space** (post-chirality): the board parents under the top scene, so gravity is world −Y and the
terrain raycasts read straight.

Every constant is either the engine's — cited in the source to the [Trailmap] chapter that traces it — or this
ride's own, labelled `no spec constant` next to the gap it stands in for. The spec is the single source of truth
shared with the main Unity board; where it carries a number, that number wins, and the handful it does not
carry are called out rather than filled in from a sibling implementation. The SSX shape of the model:

- **Contact probe** — one **segment along the cached contact normal**, from 2 m above the deck reference to 1 m
  below it ([Trailmap: 320]). Aiming the next probe along the last normal is how contact stays continuous around
  a curve with no temporal filtering, and the segment's reach below the deck **is** the ordinary grounded
  ground/air band — a miss means airborne, with no generic lip or speed test. Air→ground entry also requires the
  fresh normal speed to be approaching or within a 0.25 m/s noise tolerance; a far-side hit that the deck is
  already leaving is not a touchdown. (Off the ground the aim reverts to world up: `contactN` is a memory of
  the last surface touched, and after a steep lip a segment along it sweeps past the ground the rider is falling
  toward.) The hit gives the face + surface type; on both the **authored** and loaded **reference** mountain it is
  then refined onto the **exact Bézier surface**: `faceIndex` decodes back to its cell and sub-quad, and the
  triangle barycentric weights seed a Newton solve of `patch(u,v) = probeRay(t)`. The solved
  `patchPoint`/`patchNormal` is both on the surface and on the actual probe. This matters more than it sounds. The
  broad-phase collision mesh is each patch tessellated 8×8 (`PREVIEW_RES`),
  and **a facet is a chord under the arc** — reading contact off it drops the deck into the sag mid-facet and pops
  it back at every vertex. Measured across the default mountain: **6.1 cm mean, 1.62 m worst**, arriving 4–8 times
  a second, against a 0.11 m deck, on terrain that is perfectly smooth. The engine never rode facets (it
  Newton-refines onto the patch), which is why nothing in the real game shudders on smooth ground. The analytic
  path is also **cheaper**: the exact normal falls out of the same eval, so the four extra rays a
  central-difference normal needs are gone — five rays per probe become one. Authored cells rebuild their sixteen
  controls from the editable net; a reference uses the sixteen original controls retained from its extracted
  `Patches.json`. The earlier seed-only implementation returned points **0.86–1.30 m sideways from the probe** on
  the second and third marked Snowdream lips; those unrelated far-side points kept contact until the trajectory
  reached −73.5°/−64.9°. After the solve, 525 analytic probes measured 11 nm median, 9.1 µm p99 and 9.7 µm maximum
  off-ray error; the same two takeoffs moved to −34.0°/−33.6° with no barrier resolution. The solved reference
  ride now studies the original smooth contact surface instead.
- **The carve** ([Trailmap: 330]) — banked contact and lateral resistance bend the path.
  The bank contributes `min(response,2*A)*tan(tilt*lean)` laterally and preserves
  the corresponding normal residual. After velocity integration, lean requests a
  physical heading correction using the original bounded asin slip projection,
  mode curve, backward-travel sign and downhill alignment reference. The quadratic
  speed gate reaches half authority near 12.24 m/s and full authority near 17.31 m/s.
  Its 6°/tick cap limits heading correction, not sustained travel turning rate.
  The visible deck bank consumes lean separately.
- **Shaped speed** ([Trailmap: 360]) — there is no g·sinθ runaway: a per-surface **cruise drive**
  re-accelerates toward that surface's **speed target** (snow ≈ 14.4 m/s, ice ≈ 17.8, rock ≈ 5.4), gated by
  how square the board is to its travel — nothing beyond 60° off, so a sideways skid does not re-accelerate.
  That gate is a **heading delta measured in the contact plane**, so the normal channel never votes: a deck
  settling out of a landing carries normal velocity and little else, and reading the angle off the full 3D
  velocity would score it 90° across its own travel and cut the drive on the tick a rider most needs it. Below a
  readable travel speed the board's **own heading stands in** and the delta is zero, so the drive pulls a rider
  up to the target from a standstill. That fallback is what makes level ground rideable at all: at zero slope
  the cruise drive is the only force along the contact plane, so refusing to drive under the floor would instead
  make low speed absorbing — a rider who dropped under it could never climb back over.
  A **decaying speed cap** bounds it: ≈ 27.9 m/s, rising to ≈ 33.5 while boosting or airborne, snapping up and
  easing down at ≈ 2.08 m/s per second. Surface gravity accelerates travel downhill,
  while the recovered forward-resistance polynomial opposes forward motion. The
  cruise target is a drive reference, so flat-ground equilibrium falls below it
  where positive drive balances resistance. Coasting above it still loses speed.
- **Held boost** ([Trailmap: 360]) — a flat 23.5 m/s² forward thrust that fires **only while the board is ridden
  nearly flat**: the lean window is ±0.08 against a lean clamp of 0.905, so edging while boosting throws the
  thrust away. Boost is a hold-your-line tool, and it is not surface-scaled. The shipped Unity ride's deliberate
  air embellishment keeps the recovered force law but puts its direction on the visible deck: below the shared
  cap, held boost adds **8 m/s²** along its nose, including the current pitch/flip. Across the final 2 m/s below
  the cap that thrust cross-fades to a magnitude-preserving sideways bend at up to **40°/s**, while pointing the
  deck against travel still brakes for a landing; this keeps the cap from silently eating directional control.
  Air spin and flip also take Unity's **×1.6** trick-boost multiplier. A speed pad shares the raised-cap/spin state
  but never invents held board thrust.
- **Per-surface feel** — the raycast's face → cell → **SurfaceType** (`preview.cellSurf`) indexes the engine's
  response table, **all twenty measured rows**, every type its own — so ice skates, powder bogs and steers slow,
  rock and off-track drag, and a **reset (OOB)** tile requests automatic recovery only during an active scored
  run. Carve drag comes straight off the table
  rather than through a hand-fit grip: it spans three orders of magnitude from ice (0.0025) to slow powder (3.50),
  and *that ratio is the ice skid*. Folding types onto the family their name suggests — 7 and 11 onto ice, 8 and
  16 onto snow, 13 and 14 onto wall — is wrong in every case ([Trailmap: 310]): type 7 sinks 30 cm on a dead
  contact, nothing like ice's springy 2.25 cm, and type 14 carries the fastest speed target in the game.
- **Contact is a free error, not a snap** ([Trailmap: 320]) — the deck reference carries a signed clearance along
  the contact normal (negative = penetrating). Nothing re-seats it at a hover height; position integrates freely,
  and the deck's height above or below the snow is an outcome. Each grounded tick evaluates the surface's
  **three-zone response** on that error — a soft `A/30` pull above the surface (damped only while separating), a
  stiff ramp from 0 to `A` across the `bog` give, then a phase ramp climbing to `3A` at the budget — against the
  measured load above. The equilibrium is approximately the bog depth: 5 mm in snow and ice,
  15.1 cm in powder and 25.2 cm in slow powder. The powder ≫ hard ordering falls out of the table; there is no
  `if powder` anywhere. Budget and bog are rate-limited copies easing in at 1 m/s **on every motion state**, so a fall toward
  powder has its give already easing in before the deck arrives.
- **The pushout is a backstop, and it does three things at once.** Once penetration passes the surface's budget
  it shoves the deck out along the normal by the overshoot (at most 10 cm a tick), bleeds that much out of the
  stored error, and **zeroes the normal velocity** — `vel -= vn·n`, the normal *speed*, not the overshoot. The
  **acceleration clamp** lives inside that same branch and only inside it: with the deck already past its budget,
  residual into-surface acceleration is removed before integration. Clamping that unconditionally — as the older
  Unity/Basis paths did — deletes gravity from every ordinary tick, which is the bug that floats a deck off convex
  ground.
- **The above-surface pull is integrated, and the band is what tames it.** `−(A/30)·error` reaches 21 m/s² of
  downward pull half a metre up, and the grounded update is the engine's *only* caller of the response helper —
  there is no airborne caller anywhere. It does not weld the board because the grounded state extends only
  the surface's **ground threshold** above the surface: 2.7 cm on snow, where the pull is 1.2 m/s². An ollie
  crosses the band in two ticks, and the launch **forces the air state** besides ([Trailmap: 300], no contact
  check at the launch instant). Air is a separate integrator with no contact term at all
  [Trailmap: 310-fields, 320-redirect].
- **Visual lift** — the drawn deck rides `smoothedUp · lift` above the physics position ([Trailmap: 320]
  `renderPos`), on the same 1 m/s slew, easing to zero off the ground.
- **Air + lips** — the surface holds the deck only while **gravity can supply the turn the surface demands**.
  While the deck penetrates, the response pushes strictly *outward* and gravity is the only inward force, so on a
  convex roll the clearance climbs past `ground_threshold` and the next tick is an air tick. The crossover is
  therefore **`R = v² / (g·n̂)`** — about 31 m at 20 m/s on snow — and **no code tests for it**: there is no
  generic liftoff predicate, no lip-speed threshold, and no lip-shape check anywhere in the tick. Gentle rolls
  stay glued, sharp lips throw, and flight is ballistic until it meets an approaching contact. The port has one
  narrow departure guard for the non-riding bounce/wall rows (SurfaceTypes 6/10): their broad 20 cm response band
  cannot retain or redirect a rider already separating from the face.
- **Touchdown** ([Trailmap: 340]) — a clean landing enters the grounded state directly. There is **no** velocity
  projection: the full contact-plane projection belongs to the wipeout state, not to an ordinary landing, and the
  arriving normal speed is taken out by the pushout's `vel -= vn·n` the moment the deck passes its budget. What
  does apply are two orientation error bands — deck-vs-surface tilt free below 15°, clamped 50° → ×0.85;
  facing-vs-travel yaw free below 25°, clamped 80° → ×0.75. They need no "was that a real landing" gate: after a
  bump-skip both errors are ≈ 0 and they multiply by 1. A cartwheel pays. The **plunge** is not scripted either —
  it is the response's own transient. An 8 m/s landing reaches 3.6 cm into snow, 21 cm into powder.
- **Takeoff pose lags the lip like the final game quaternion.** PCSX2's visible board basis does not snap to the
  fresh contact normal: across the first marked Snowdream lip its angular step grows from ≈ 0.10°/tick at 6°
  error to ≈ 0.79°/tick at 12° error, a cubic response capped only for teleports. The old renderer calculated a
  smoothed `boardUp` and then bypassed it with the raw normal whenever grounded. It now draws the advanced basis
  on both sides of takeoff. A downhill departure may have negative world-Y velocity while
  still moving outward from its cached contact normal. Either positive world-up launch speed or more than the
  0.25 m/s outward tolerance marks a real launch, skips the 0.15 s bump-orientation grace, and lets the deck retain
  its takeoff pitch while levelling at the measured neutral-air ≈ 9°/s. This prevents the visual board from
  snapping toward the far side of a downhill lip even though the trajectory is already airborne.
- **Pre-landing alignment** ([Trailmap: 340]) — the falling half of the air update probes the world along the
  predicted travel: bounded ballistic chords (`PREALIGN_STEP` out to `PREALIGN_HORIZON`, six casts at most, first
  crossing wins, skipped while an ollie is still climbing out of its own launch surface) find the upcoming
  landing, and its exact analytic contact aims `airUp` while `landEta` says how long the deck has. The spec's
  basis rebuild is geometric with no fixed rate; this ride keeps its eased basis and closes the remaining error
  over the remaining time instead — square `PREALIGN_LEAD` before arrival, never slower than the 9°/s neutral
  level, capped at the ground chase's 270°/s. A rider thrown sideways off a wall therefore turns base-down to the
  slope on the way in instead of slapping crooked and paying the full touchdown bands. The same march refreshes
  the contact fields for the surface it is about to hit ([Trailmap: 310] — a fall toward powder has its sink
  budget easing in before arrival), and the same clock drives the rider's legs: inside `LAND_REACH_ETA` the air
  tuck extends to `CROUCH_REACH` — the coached "extend just before impact" — so contact folds them again with
  full absorption travel.

### The grounded redirect — why the stiff contact stays quiet

`error = −groundRestDepth(row, normal.y)` is an **exact fixed point**, but on the hard rows the spring alone
repels it: snow's bog zone is 5 mm
wide, so its stiffness is `A/(100·bog) = 2602 s⁻²`, and against `P = 5.01` a 1/60 s explicit step amplifies the
ringing 28% a tick. On the spring and the pushout alone the deck cannot rest — it buzzes a limit cycle on
perfectly smooth ground (8.6 cm at ~4 Hz on snow, 10.6 cm off-track, 8.4 cm on ice; ridden, that is a constant
small jerking the shipped game visibly does not have).

What keeps it quiet is the specified grounded redirect [Trailmap: 320-redirect]. After integrating, the model
**re-probes at the new position** and then, on every surface but the two powders, removes **40% of the velocity's
normal component** along the fresh normal — both signs, every grounded tick, no gate — and **scales the velocity
back to its previous magnitude**. No energy is dissipated: the velocity is *rotated* into the contact plane.
Measured on the ported tick, flat ground, tail 5 s of a 15 s run:

| | spring alone | with the redirect |
|---|---:|---:|
| snow | 8.63 cm buzz @ 4 Hz, forever | **0.000 cm** |
| off-track | 10.58 cm | 0.000 cm |
| ice | 8.39 cm | 0.000 cm |
| rock | 2.65 cm | 0.000 cm |
| powder / slow powder (exempt) | 0.10 / 0.01 cm | unchanged |

One term, three behaviours. The buzz dies because the redirect contracts exactly the channel the stiff spring
amplifies. A landing converts impact into carried speed instead of bleeding it — a 6 m/s touchdown at 18 m/s
forward is seated at rest depth in **0.73 s and exits at 18.07 m/s**, faster than it arrived. And the powders
stay mushy because they are exempt — their 15–25 cm bogs are soft springs, stable on their own, and the wallow
is the point. Standing dead still it does nothing at all: with the velocity all normal, the rescale undoes the
kill exactly, so the redirect only acts when there is travel to rotate into. The spring, the explicit step, the
pushout and the redirect are **one mechanism split across the tick** — port any subset and the contact is a
different game.

That last property is exact only for an exactly normal velocity, so the restore is **skipped below a tangential
floor** rather than trusted to cancel itself. Its gain on the tangential channel is `spd0/spd1`, which tends to
`1/(1 − 0.4) = 1.667` per tick as that channel tends to zero — unbounded amplification, which makes a standstill
a repeller. There is a supply to amplify because a deck pinned at its pushout budget manufactures normal
velocity for free: the pushout zeroes `vn`, position integrates with that zeroed velocity so the deck does not
move, and the response — saturated at its `2A/100` clamp — refills the channel by `accel·dt` before the next
tick. Level ground has no other tangential input, so float noise in the contact normal picks the heading and the
redirect banks 1.667× of the refill as travel along it: **3 mm/s of seed becomes 1.4 m/s in about twelve ticks**,
and if it lands behind the board the cruise drive's alignment gate stays shut for the rest of the run. The floor
is an absolute speed rather than a ratio because a hard landing legitimately has normal velocity dwarfing
tangential, and that is the case the restore exists to serve. `test/flat-ground-ride.test.ts` covers both
sides: a level standstill stays at rest, and a square landing still exits carrying what it arrived with.

The air→ground transition starts that mechanism at **zero contact error**; it does not feed the discovery probe's
already-negative clearance directly into deep pushout. This is visible in the Snowdream gold capture: ordinary
landings carrying 15–20 m/s into the surface enter ground at 100–102% of their prior speed, then build penetration
and rotate/absorb the impact over the following grounded ticks. Starting from the raw 9–23 cm penetration seen by
a 60 Hz discovery probe collapses that sequence into one harsh projection and is observably not the original.
- **Charged ollie** ([Trailmap: 340]) — an impulse **added** to the carried velocity, never replacing it. Space
  builds charge while held and launches on release along the **cached contact normal** — a release the instant the
  board skips off a bump still pops off the slope it just left (a ~0.12 s coyote window standing in for the
  engine's control/motion decoupling; past it a pending charge cancels, so there's no mid-air jump). Ordinary
  flat-to-gentle ground takes the fixed **fallback blend** `normalize(n + 0.2·tangent)`, leaning the pop slightly
  down-course (≈ 6.19 m/s vertical at the minimum launch); only past **50°** with the travel tangent pointing up
  does the weighted normal↔tangent blend take over, so a wall run launches along the run. Magnitude is
  `charge² · riderCurve · speedFactor`, floored at **6.309 m/s** — a tap is already a real pop, the charge pays
  quadratically, and a faster approach jumps higher until it saturates around 10 m/s of approach speed.
- **Camera** — a chase cam trailing the board's **travel**, never its facing, clamped to stay **clear of the
  terrain and solid native collision geometry** so a steep downhill doesn't bury the cam in the rising slope
  behind and a reference prop wall cannot be invisible to the camera while still stopping the rider. The
  distinction is the
  whole point in the air: `fwd` is yawed by the spin at up to 270°/s, so a camera bolted to it rides the rider
  around the circle. Horizontal velocity is *invariant* through a jump — gravity only touches the vertical, air
  drag scales x/z uniformly, and the speed cap scales the whole vector — so trailing it freezes the camera on the
  bearing you took off along, which is the bearing you will land along. Spin all you like; the landing stays framed.
  While airborne the look ray also **dips with the descent** (capped, eased), so a long drop shows the ground it
  ends on rather than the horizon. At a standstill there is no travel to read: grounded it falls back to the facing
  (within a slip angle of travel anyway), airborne it holds the bearing it left with — a vertical pop with a spin
  on it is exactly the case this avoids. The `chase near` candidate uses the authored **1.8 m full boom**
  (**2.1 m** at full boost), aimed **1.0 m above the rider root**. Its neutral pitch combines the local
  `35/180` vector angle with the associated **−0.16 rad** bias; trajectory pitch rides on top. A separate
  retained-eye response produces the larger, speed-dependent final separation seen in play. Ride mode also
  owns the retail projection lens: the live renderer's **0.825 rad horizontal half-angle** converts through its
  4:3 projection to **78.15° vertical FOV** (94.54° horizontal at 4:3), rather than the editor's zoomed-in 55°
  vertical lens. Its adjacent **15-unit near clip is 0.15 m**, small enough that the projection plane remains on
  the eye side of a wall while the 0.4 m clearance pass is active. Ending the ride restores the editor FOV and
  near plane with the rest of its camera state.
- **Rendered-volume guard** — the traced retail axis casts remain the primary response, then Slopesmith filters
  their corrected target and rechecks that filtered sight line before testing the final eye against the closest
  triangle on the terrain render BVH. A wall pull-in is therefore immediate and safe; ordinary movement and
  release back to the full boom remain damped. If the final eye is inside a **0.45 m** radius,
  the eye is padded toward the rider side and queried again, up to four faces. This editor-side safety pass is
  necessary because three point segments can miss a diagonal face, and one normal correction in a curved or
  concave bank can remain inside the neighbouring face. The Garibaldi marker study found **372 / 4,041** camera
  frames inside 0.4 m, including **126** with the eye itself less than the 0.15 m near distance from terrain;
  several ray-corrected frames remained only 5–8 cm from an adjacent triangle. The extra 5 cm beyond the retail
  point-eye clearance is a render safety margin: a follow-up marker held the eye correctly at exactly 0.400 m
  along a faceted side wall but still produced one projection-edge scrape at the active ~2:1 browser aspect.
- **Angular and eye dampers** — heading and trajectory pitch close **one sixteenth of their remaining error per
  60 Hz update**. After the rider-relative seat and retail clearance pass, the final eye retains **80%** of its
  prior position and admits **20%** of the corrected candidate. Slopesmith expresses both as frame-rate-independent
  exponentials; the eye uses `1 - 0.8^(60·dt)`. Respawns, warps and view changes invalidate that history. This
  positional response explains why retail's moving output can sit near 3 m back even though the authored input is
  1.8 m: its ramp delay is four 60 Hz ticks, adding about 1.33 m at 20 m/s.
- **Any mountain** — the same model rides the authored terrain (surface feel from the painted `cellSurf`) or a
  loaded reference world (surface feel from the level's own per-patch `SurfaceType`, `patchSurf`); the
  non-target mountain is hidden for the run.

### Flips — W and S, held in the air

**Hold W in the air and the deck goes over the nose; hold S and it goes over the tail.** Release and the rotation
stops: a flip is held, not thrown. Neither key costs anything to overload, because neither has ever reached the
air update — the brake reaches motion solely through `groundTick`, and the tuck was only ever the rider's legs.
It still folds them, so a held W is a *tucked* front flip for free.

The rate is **not** this ride's own. [Trailmap: 340] rotates yaw, pitch and roll at one rate, so a flip turns at
exactly the spin's `AIR_TURN_RATE` — 270°/s, the low-stat end of the traced 271–670°/s band. The consequence is
worth stating rather than tuning away: a whole rotation takes 1.33 s and a flat ollie buys about 1.2 s, so **a
flip wants a real lip under it**. (Raising it is one constant, if the bench would rather have the trick than the
provenance.)

It is a rotation of the **drawn deck and the rider bolted to it**, not a rotational degree of freedom in the
contact model. `st.boardUp` stays the contact-chased basis that pre-landing alignment is steering and that the
touchdown bands are read against, and the flip rides on top of it in `pose.ts`, about the deck's own lateral
axis. So a rider can go all the way over without the model losing track of where the snow is, and the landing
prediction, the contact probe and the barrier sweep are all untouched. The figure comes along for free: a rider
stands against *apparent* gravity, which in free fall is ≈ 0, so `rider.ts` already builds the body square to the
deck it is strapped to and the whole rider turns over with it. Signed in the ridden frame like the bank, so a
switch rider's W still throws them forward down the hill they are on.

The flip reaches the physics in exactly one place: **the touchdown tilt band**. An unfinished rotation *is* deck
tilt — the rider is that many degrees off their own base — so the band already prices it, and the landing takes
the worse of the two angles rather than their sum (one rider cannot be 40° off the surface and 90° through a
rotation and pay for both). A completed flip reads zero and costs nothing at all, however many whole turns it
took. Whatever is left rocks back onto the **nearest whole rotation** at `FLIP_RECOVER_RATE` (720°/s, no spec
constant): nearest rather than zero, so 350° carries *forward* to 360 instead of unwinding the long way, and the
accumulated value stays continuous for the render lerp. Riding on visibly inverted would be a second, cosmetic
punishment for a landing already paid for.

The HUD reads the rotation live beside the ✈ flag (`↻ 340°`), which is the number that tells you whether this
one is going to land. Telemetry records the accumulated `flip` on every tick, never folded, so a run's whole
rotation count reads straight off the stream.

Two known edges, both in the air and both cosmetic: the swept rider body used for barrier collision still samples
along the *unflipped* up, so a mid-flip rider's head is not where the sweep looks for it; and there is no wipeout
state, so a rotation landed 90° short costs speed and rights itself rather than throwing the rider.

### Riding switch — the deck is an axis, not an arrow

A/D **spins the board in the air** (270°/s, [Trailmap: 340] — the low-stat end of the traced 271–670°/s band),
which is 0.67 s to a half turn. Land that half turn and you are **riding switch**: the deck points back up the
mountain and you carry on down it. This is the ride's own, not the port's — the traced heading fields are
single-signed and carry no switch bit ([open]) — and it is one state field, `st.lead`: **which end of the deck is
leading the travel**, `+1` the nose, `−1` the tail. `st.fwd` is the nose either way, and only the *drawn* deck
reads it.

Everything that means "forwards" reads `rideForward(st)` = `fwd · lead` instead: the carve frame and its
lateral, the heading auto-centre, the cruise drive's alignment gate, the brake, the boost thrust, the touchdown
yaw band, a rail's spin datum, an AI rider's bearing, and the chase camera's standstill fallback. That split is
the whole feature. Landing backwards changes what the rider *looks* like and nothing about how the board rides:
A still carves left, boost still pushes you down the hill, and the surface still drives you to its cruise target.

The lead is latched by the **travel**, never by a key — no input rotates the board on the snow:

- **A landing commits it** to whichever end is already leading, and the yaw band is then measured to *that* end.
  A clean 180 lands square at ≈ 0° and keeps every metre per second it came in with. Sideways is untouched: the
  nearer end of a 90° slap is still 90° off and still pays the full 0.75. A rail catch commits it the same way,
  so a switch grind stays switch instead of being read as a 180° boardslide and snapped straight by the ±80° clamp.
- **On the ground it hands over past `SWITCH_LATCH_ANGLE` (110°)** of swing off the ridden end. This is what
  "rights yourself" means for the other half of the circle: the auto-centre already closed a crooked landing onto
  the travel, and past 110° it now closes onto the *near* end rather than whipping the board 180° round to face
  the way it started. The 110 leaves a 40° dead band on both sides, so the latch cannot chatter on a hard skid.
- **Under `SWITCH_LATCH_SPEED` (2 m/s) it cannot move at all.** There is no leading end to read from a rider
  who is not travelling, and flat ground's contact buzz can manufacture about 1.4 m/s of backwards creep out of
  float noise (the failure `test/flat-ground-ride.test.ts` exists for). Handing that the switch lead would hand
  it the cruise drive too and ride the rider away backwards from a standstill they never left.

The handover carries the carve with it. `lean`, `bank` and `carveSlide` are all signed in the *ridden* frame, so
they turn over with the lead: the rider keeps the same edge on the same side of the world, and the drawn roll
(`bank · lead`) and the probe's lateral offset stay continuous. Flipping the lead on its own snaps the deck to
its own mirror pose — 90° of visible roll in one frame, in the middle of the skid that caused it.

The way back to regular is the way out: another half turn in the air. The HUD flags the state as **⇄ switch**
beside the air/boost/grind flag, and the telemetry stream records `lead` on every tick — which is the only field
that separates a landed 180 from a rider who is simply skidding backwards.

The face follows that same ridden end, independently of standard/goofy footing and the deck's drawn nose. A
switch landing therefore leaves the board pointing uphill but the rider's eyes downhill; changing stance turns
the body to the other side of the deck without turning the head back up the course.

There is no wipeout state here yet, so a landing this model cannot make sense of costs speed and nothing else.

## Grinding rails (`app/ride/grind.ts`)

The authored rails (014) are ridable ([Trailmap: 350]). Grinding is its own motion state — its integrator
replaces the terrain probe, response and redirect wholesale — and the curve it rides is the SAME cubic-Bézier
chain the export writes to `Splines.json`, pushed through the world root's chirality flip at launch, so the
line the board grinds is the line the ISO and Unity get.

- **The rail is ridden as a true curve.** Every tick — acquiring, staying on, and chaining alike — runs one
  query: an AABB broad phase with ±3 m slack picks candidate segments, a coarse five-sample / four-chord pass
  only *brackets* the nearest span, and a golden-section search (1/φ split, ≤24 iterations, tol ≈ 5e-4)
  refines the closest point on the real cubic, whose exact derivative is the travel tangent. The chords are
  never ridden, so heading varies continuously along a bend — no per-segment steps.
- **Attaching** — acquisition runs from both the air and the ground states, accepted when the rider sits
  inside the rail-local snap windows scaled 0.9 (entry is slightly stricter than staying on): |along| < 0.72,
  |vert| < 0.648, |lat| < 0.27 m. There is no speed or alignment gate — a rail lying near the line vacuums the
  board on, which is the engine's own behaviour. Entry preserves the carried velocity (re-aimed, not reset)
  and clears the carve lean.
- **Traveling** — exactly three speed-affecting terms and no drag: a **magnitude-preserving slew** of the
  velocity onto the curve tangent at 30/s (entry speed becomes grind speed; a crooked catch is rotated, not
  bled), a dedicated **rail slope gravity** of 9.8 m/s² dotted onto the tangent (about half the falling air
  gravity — downhill rails accelerate, uphill rails bleed), and the held boost's **24.508 m/s²** along the
  travel direction, so boost pushes along the rail even uphill. The shared speed cap still applies. A separate
  lateral attachment correction seats the **position** radially onto the curve each tick (the spec's ±2.9 m
  clamp is a full re-seat inside the windows); it never changes speed.
- **Spin, not balance** — rail input yaws the deck about the rail, clamped to the spec's **±80°**; it never
  steers the travel, and there is no balance meter or lean-too-far ejection anywhere. The yaw eases to the held
  direction at a plain 240°/s (the traced 75/s² spin-rate slew feeds a trick-animation selector this ride
  doesn't run — `no spec constant` on the rate). Landing a held boardslide pays the ordinary touchdown yaw band.
- **Leaving** — the grind continues only while each tick's query re-accepts contact: the windows widen to their
  fullest (|along| < 1.50, |lat| < 0.72) for the first **0.6 s** as an attach grace, then tighten. Ways off: the
  rail ended (the along window gives ~0.8 m of overshoot past the last endpoint, then air with carried
  velocity), a window failure (drifted or sank off the line), or the **shared jump launch** — the ollie pops
  off the rail-local vertical with no rail-specific exit. Chaining onto a following rail is the same query
  accepting a different candidate; a 0.5 m junction gap chains seamlessly. What feeds the window blend after
  the grace is untraced (`[open]`, held at the tightest), and the engine's explicit input-exit bit has no key.
- **This ride's own, labelled:** seat height is carried per rail. A Slopesmith-generated pipe seats the deck
  one tube radius (0.2 m) above its centreline; a bare rail and an extracted retail spline use zero because
  their authored curve already is the rider/contact line. This is WYSIWYG rather than an engine constant. A
  **0.35 s re-lock lockout** after a jump off a rail (`RAIL_RELOCK_TIME`,
  no spec constant) — the acceptance windows are purely positional and a fresh pop's first ticks are still
  inside them, so without it the ollie re-locks on the next tick and a jump could never leave.
- **While grinding** the rail's surface type (normally 13 metal / 12 wood, plus named retail exceptions such as
  Alaska's style-5 IceRails) **replaces** the terrain's in the rider's
  contact fields, so the row the fields slew back from at touchdown is the rail's.
- **A grind collides with less, and with the top half.** The engine drops all but **two** of the rider's
  collision spheres before the object pass on a rail, and those two are the **torso and the head** — read off
  the live sphere set, they are the only limbs posed above the pelvis ([Trailmap: 350-probe]). Legs, feet and
  all four board spheres are masked off, which is the sensible reading: the board is locked to the spline, so
  the only thing that still has to meet world props is the rider standing on it. This ride matches that — **on
  a rail the board footprint does not participate in prop collision and the upper-body samples do**. (An
  earlier pass had this exactly inverted, on the guess that the surviving pair would be down at the deck.)
  Mode-2 boxes are unaffected either way, because they were never anything but the body sphere.
- **A reference world grinds its ORIGINAL rails.** `/api/level` serves every well-formed entry from the level's
  `Splines.json` with its original index intact (`readLevelSplines`), the loader hands it to the viewport
  (`setReferenceSplines`), and the ride applies Snowknife's same candidacy rule — styles 12/13 or a `SplineName`
  containing `Rail` — before mapping the raw cubics
  through `editorFromRaw` + the reference mesh's own world matrix — the same transform
  chain as every other reference dataset — preserving the spline's authored clearance over the rail props.
  GARI is 169 splines / 542 segments; a whole-network query costs ~7 µs, so no spatial grid is needed
  (the engine's own broad phase is the AABB gate).

Measured headless (`tools/ride-study/rail-trace.ts`, the real model over a −10° line with two rails): the board vacuums
on at cruise (13.9 m/s, magnitude preserved through the catch), gains 1.67 m/s over the first grind second
against the 1.70 slope gravity predicts, chains 0 → 1 across the junction, runs ~0.9 m past the last end
before going airborne with carried speed, and an ollie at 0.8 s pops off, stays off through the lockout, and
re-lands the same rail ~1 s later. A held spin pins ±80° with travel unaffected, and the sideways landing pays
the yaw band (14.4 m/s kept vs 20.8 square). The GARI spline set was checked the same way: all sampled
on-curve queries land within 2 cm and inside the entry windows.

## The drawn board and its rider (`app/ride/gear.ts`, `app/ride/rider.ts`)

The contact reference is still a point and the mannequin is still presentation, not another physics body. Its
proportions are anthropometric, its stances are authored here, and its continuous response to this port's
contact, carve and landing signals is procedural.

### The gear: snowboard or skis

Both are built to real numbers in `app/ride/gear.ts` and **neither is simulated**. The physics knows about one
deck frame — a position, a normal and a nose axis — and never asks what is drawn in it, so **skis ride exactly
as a snowboard rides**. That is the same bargain the VRChat world already struck with the same pair of skis
(Unity `docs/vrchat/017`), where a ski spawn is purely the visible model.

Three things change with the kit, and only three:

- **The model.** The snowboard is a 186 cm wide-body deck — a sidecut plan, a base flat between the contact
  points and kicking up beyond them. A ski is that craft twice and asymmetric fore and aft: 204 cm, 129 mm
  underfoot, a long turned-up shovel, a shorter squarer tail, and the foot seat 8.4 cm behind centre, which is why
  a ski seen from the chase camera is mostly shovel. The rendered gear deliberately contains no binding or
  proxy-boot meshes: the avatar supplies the visible feet and the complete topsheet remains readable. Both kits
  retain the same ankle height above the snow, so switching mid-run cannot leave a body hovering or sunk and
  every generated and imported character keeps its exact fit.
- **How the carve roll reaches the snow.** A snowboard is one rigid deck and takes the roll whole; its foot seats
  ride round with it. A pair of skis may not: rolled about the pair's centre, a 50° carve lifts the outside ski
  a hand's width clear of the snow and buries the inside one. Each ski edges about its **own centreline**
  instead, so both stay planted and edge in parallel. The two bodies' ankles split the same way — a lift that
  rides the rolled frame, because a boot goes over with the edge under it, and a span that rides the flat one.
  Over the network a snowboard's published deck pose is already rolled and a pair of skis' carries facing only,
  with `animation.bank` re-edging each ski on the receiving side — again, what the VRChat world does.
- **Where the two feet are**, which is the whole of the next section.

### The stance model

How the rider *stands* is a **stance**: a couple of dozen named riding quantities, blended between and then
evaluated into a body. Nothing is captured and nothing is imported — the figure is generated from what a
snowboarder does, so the vocabulary is a rider's rather than a rig's:

| | |
|---|---|
| `hipHeight` | hip-socket height above the ankle line. The knee bend is whatever this implies. |
| `hipCross`, `hipFore` | the hips across the deck and along the board. Fore/aft, through the leg IK, *is* which knee folds deeper. |
| `inclination` | degrees the leg axis leans past the deck's own normal |
| `angulation` | degrees the spine folds back off that axis, against the inclination: the waist fold that trims the upper body back out of the turn |
| `crossFold` | the same joint on the **other** axis. A snowboarder needs none — see [gear turns the body](#gear-turns-the-body-and-nothing-else) — and a skier's is the hip angulation a carve is made of. |
| `chestCross`, `chestFore` | where the chest is carried off the spine's line. The trunk curls into it progressively, so the fold is a back and not a hinge. |
| `counterRotation`, `shoulderSlope` | the shoulder line turned about the spine out of square with the board |
| `chestBalance` | how much of the apparent-gravity stack the torso still takes. Pure balance points the trunk a long way into a hard carve and takes the head with it; a trained rider overrides that, so the realistic end takes nearly all of it and the arcade end little. |
| `kneeTrackFront`, `kneeTrackRear` | how far each knee's bend direction is canted along the board from straight over the toes |
| `headYaw` | the head turned into the turn, underneath the wandering glance |
| four `Drop`/`Swing` pairs | where the hands are kept: each arm bone as a direction in the torso's own frame — `Drop` off hanging straight down, `Swing` around from noseward |

Four stances make a **riding style**: the neutral cruise, the two committed edges (faded in by `|lean| / 0.85`,
and only while grounded), and the coil, which is **additive** — laid on top of whichever edge is under him, so a
crouched carve needs no fifth stance of its own. Physics may reverse its requested edge in a single tick; the
stance crosses on a 140 ms half-life, reaching 90% in 0.47 s.

Four styles ship, in `app/ride/stances.ts`, and **Test → Riding style** picks between them. They are one axis:
**how far the body lays into the turn, past the board's own roll.**

The thing that makes that axis possible is that the rider **never inherits the deck's visual bank**. The board
rolls to `lean · 50°`; the body leans by `inclination` off the *surface*, and the gap between the two is the
carve's whole posture. The feet are still seated over the rolled deck, so the legs span from a banked board up
to a body leaning by its own amount. That span bends the knee out over the edge and closes the hip into the
sitting shape a carving snowboarder holds, without any of it being dialled in by hand.

`inclination` runs **past** the deck's roll on every style, and that sign is the thing the whole posture turns
on. A carving rider's hips are *inside* the turn: measured across the board from the ankle line they sit toward
the edge that is engaged. Fall short of the deck's angle instead and the hips come out over the *outside* of the
turn, which on screen is the body being thrown around by its own board.

| | |
|---|---|
| **Realistic** | the smallest lay-in of the four and the largest waist fold, so the upper body stays tall and the head is markedly quieter than the hips — a trained rider stabilises their head and lets the lower body swing beneath it. |
| **Balanced** | the default, halfway along. |
| **Arcade** | the game's read, set against measured retail geometry: the body lays well over, the hips come down near the bindings and inside the turn, and the waist barely folds. |
| **Extreme** | past it — hips and trailing knee round to within a hand's width of the snow. |

### Gear turns the body, and nothing else

There is one set of four styles **per gear**, but no second solver and no second vocabulary. The keys above do
not change with the kit; the frame they are read in turns with the feet, and every axis the solver derives is
derived from the line through the two boots:

- On a snowboard that line is the **deck's nose axis**, so the hips and shoulders span the board and the chest
  faces the toe edge.
- On skis it is the **rider's own lateral**, so the hips and shoulders span the body and the chest faces down
  the fall line. `ankleFront` becomes the anatomical left, exactly as it already does on foot.

The same two cross products produce `toe` and `along` either way and come out right, because the whole triad
turns with the feet. `hipCross` is "across the deck" for one rider and "fore and aft" for the other, and both
are the same joint doing the same thing. What does *not* fall out is which way a lay-in tips: a snowboarder
inclines toward an edge, about the deck's long axis, while a skier inclines left or right, about the direction
of travel. That single axis is the difference in the solver.

It has one consequence worth stating, because it is the whole reason `crossFold` exists. A snowboarder stands
*across* the deck, so a toe-side carve leans them forward over their own toes: their lay-in and their waist
fold are in the **same plane**, which is why `angulation` counters `inclination` for them. A skier's are
perpendicular — `angulation` folds them forward over the boot tongues and `crossFold` is the lateral hip
angulation that brings the upper body back out over the outside ski. Without it a skier at a committed edge
angle simply lies down on the snow, because the physics that says a balanced body must incline as far as its
edge is edged applies to the **centre of mass** and not to the head.

Two more differences follow from the body rather than from the solver:

- **A skier's two turns are exact mirrors.** A snowboarder's two edges are not — a toe edge is held by
  extending the ankle into the boot tongue and a heel edge by sitting back — so the snowboard tables write both
  out. The ski table authors one turn and reflects it, which makes the symmetry a property of the code.
- **The ski ladder is shorter, and its committed end less committed.** A snowboarder can put a whole body on
  the snow: one wide deck under both feet is still under both feet at any angle. A skier cannot, so the arcade
  end of the dial is a skier riding a video game rather than a snowboarder's arcade end drawn with skis on.

`test/ski-pose.test.ts` defends the directions — that the chest faces travel, the shoulder line is square to
it, the hips are not crossed, both turns mirror to within 2 mm, and no joint is buried in the snow at any of
the four styles.

### Measured against retail

Rider geometry is compared in the **board's own frame** — metres from the ankle midpoint, across the deck — and
never in world axes. Under a 44° deck a lateral world distance is mostly the deck's own roll, so a body that
barely moves on the board and one being flung around by it measure almost the same.

`npx tsx tools/ride-study/retail-pose-compare.ts` prints the table below; hand it a `rig-study --json-out` document from
[Trailmap: 240-models-mpf] telemetry and it adds retail's own drawn pose as a row. Retail's frame is oriented
from the knees, which bend toeward in every pose, because which lateral direction is "toe" depends on the
rider's stance and guessing it mirrors every conclusion.

Settled carves at the capture's own bins, −35.6° heel and +36.0° toe:

| | hips, heel / toe | head travel | head ÷ hips | hips height | hip angle, heel / toe |
|---|---:|---:|---:|---:|---:|
| retail | −20.5 / +25.9 | 55.3 | 1.19× | 61.3 | — |
| Realistic | −14.9 / +14.7 | 17.7 | 0.60× | 73.4 | 131° / 149° |
| Balanced | −19.6 / +19.6 | 34.1 | 0.87× | 68.6 | 127° / 147° |
| **Arcade** | **−23.3 / +23.5** | **54.7** | **1.17×** | **62.7** | 127° / 143° |
| Extreme | −28.0 / +27.2 | 78.2 | 1.42× | 59.8 | 129° / 141° |

Negative is heelward, so the hips column reads as "inside the turn on both edges" throughout. Arcade sits on
retail across all four measures; the other three step either side of it.

How much the head inherits is the axis's other half. Retail's head travels a little *further* than its hips, not
less — what makes its rider read as steady is that both travel far less than a body thrown out of the turn does.
So the realistic end holds the head quieter than the hips and the arcade end lets it ride along, and the test
checks that ordering rather than a fixed ratio.

The hip angle is the other thing a viewer reads at a glance — knee to hip to neck, where 180° is a straight plank
and a bend is the sitting posture a carve is recognised by. A body laid over could still be a straight plank; it
is the hip fold that stops it being one, and the test bounds it for every style.

Within a style the two edges are still authored independently, because a snowboarder's are not each other
reflected: a toe edge is held by extending the ankle into the boot tongue and carries the torso well into the
turn, while a heel edge is held by sitting back with the torso close to upright. Mirror a settled heel pose
across the board's long axis and its joints miss that style's own toe pose by up to **56 cm**.

Neutral cruising barely moves along the axis; standing on a flat base is standing on a flat base. Almost all of
a style is its two carves.

A committed edge also spends most of the **coil**: the legs are already extended out to the side holding the
board over, so `CARVE_COIL_LIMIT` takes 55% of the crouch away at full lean and a rider has to come off the edge
before they can really load up. That is both true and load-bearing — without it a coiled carve puts its trailing
knee straight through the snow.

Whatever a style asks for, it still has to produce a body. `test/rider-pose.test.ts` runs every style through
every check below, so a retuned or newly added style cannot ship a rider whose bones stretch, whose knee locks or
bends backwards, or who leans out of their own turn. The bound on how far a body may commit is **the snow**: a
knee or a hip may graze it at full commitment — that is what the arcade end is for — but nothing may be buried
in it. Its carve fixtures roll the *ankle seats* with the deck, the way `pose.ts` does; a bank angle over flat
ankles describes a board that rolled without taking its rider along, and that is exactly the case where a
knee looks fine on paper and goes through the snow on screen.

Its carve fixtures also carry the **centripetal load a carve at that angle actually has** (`pull · tan(bank)`,
into the turn). That is not decoration: the rider reads which way is up from apparent gravity, and in a real
carve gravity plus the turn's own load points down the deck's normal. Carving at 44° with zero acceleration
describes a rider being flung sideways off a tilted board, and measuring the pose that way misreads it badly.

The axis itself is an invariant. Each style must leave more of the turn to the board than the one before it, on
both edges; the realistic end must lean the body through most of the turn itself and the arcade end must leave
the board doing more than half of it. Every style must also hold a real hip bend rather than a straight plank.
Break the ordering and the dropdown stops meaning anything. The test also proves each style crosses to where
being created in it would have put it, and that no two carve alike.

A committed edge also spends most of the **coil**: the legs are already extended out to the side holding the
board over, so `CARVE_COIL_LIMIT` takes 55% of the crouch away at full lean and a rider has to come off the edge
before they can really load up. That is both true and load-bearing — without it a coiled arcade carve puts its
trailing knee straight through the snow.

`test/rider-pose.test.ts` holds that gap open in every style, so a future simplification cannot quietly
collapse the two edges into one signed lean.

### The Slopesmith stand-in

The **board** is a swept solid at real numbers — a 186 cm deck, 35.0 cm at the waist, 41.72 cm at the contact
points, 1.44 m of effective edge, 7.2 cm of tip kick, 444 flat-shaded triangles. Its plan is a sidecut and its
base is flat underfoot, so the edge line under a bank reads as a curve and the tips catch the light. Its base
plane passes through the deck reference, which is where the physics has always put it. Two invisible foot seats
(front +15°, rear −3°, 54 cm stance) carry the avatar's own feet and ankles without covering the topsheet.

The **rider** is a figure in winter kit — jacket, snow pants, helmet, gloves, all *worn* rather than modelled, so
they exist only as dimensions. A jacket tapering from a 21 cm waist to a 30 cm upper chest, a 20 cm leg that does
not taper (snow pants are the same shell as the jacket), a 27 cm helmet, a 50 cm shoulder span, a 13 cm mitt. He
measures **1.70 m** from the snow to the top of his helmet as he rides, which is what the board under him
is sized for. Fourteen visible shell/limb links and eleven visible joints are seated on hips, upper-back,
clavicle-root, head-bone and limb landmarks.

His **segments are anthropometric** — each one a standard fraction of a 1.70 m stature (Winter): thigh 0.245,
shank 0.246, upper arm 0.186, forearm 0.146, giving 41.7 / 41.8 / 31.6 / 24.8 cm. Femur and tibia come out the
same length, which is what a human is and is the most visible consequence of proportioning him this way: a leg
is not two unequal sticks, and equal ones keep the knee reading as a knee through a deep coil. The trunk is
walked as the chain it is rather than one cylinder — `hips` is the sacral pivot, 8.7 cm above the femur sockets
and the animation root; from there the spine runs 19.4 cm of lumbar and 24.4 cm of thoracic to the clavicle root
at the base of the neck, the shoulder line hangs 7.5 cm below that, and 7.5 cm of neck carries on to the skull
base. Standing, hip pivot to neck base is 49 cm on these fractions and the riding chain spends 88% of it, which
is the forward fold of a rider. The helmet swallows all but **4.5 cm** of visible neck.

Those two facts do not describe the same 1.70 m: bent knees give away about 11 cm, the board, binding and boot
under the ankle hand back 14, and the stylised 27 cm helmet covers the difference.

The ankles are the only thing it shares with the board. It is a *sibling* of the deck in the scene, not a child,
and it is posed in world space — which is what lets it decline to inherit the deck's roll and the deck's bob:

- **The upper body stacks against APPARENT gravity; the legs stay strapped to the board.** The reference the
  body argues with is the pull minus the board's own measured acceleration (smoothed over `BALANCE_LEAD`, a
  quarter second, and read against the *state's own* pull — grounded effective tangent vs the two air gravities, since
  the wrong one would point apparent weight upward in a fall). But the whole figure cannot follow it: the feet
  are bound, ankles-knees-hips are a triangle built on the deck, and legs cannot pivot fore/aft on strapped
  feet. So the argument is split at the waist. The hips take only `RIDER_UPRIGHT_HIPS` (0.2) of the apparent
  tilt — the leg triangle rides the terrain and stays quiet through carve flurries — while the torso rights
  itself across **the residual the board has not already closed**, `RIDER_UPRIGHT_CHEST` (0.65) of the gap
  between the neutral hip axis and the apparent pull, stopped at anatomy's `BALANCE_TILT_MAX` (45°). The
  cases fall out: a steady 30° traverse stands the spine within ~20° of vertical while the hips stay centred
  over the deck; an accelerating fall-line descent measures square to the deck (already falling, nothing to
  right); free fall has no apparent weight and stays compactly square to the deck. Fore/aft the lean arrives
  the only way anatomy has — `HIP_SHIFT` slides the hips along the board with the tilt, which through the leg
  IK *is* the knee fold. This runs underneath every stance; the stance's own `angulation` folds the spine on top
  of it, so a carve's authored shape and the body's balance argument compose rather than one overriding the other.
- **A carve is inclination and angulation, not a signed rigid-spine rotation.** The leg axis leaves the deck's
  normal by `inclination` and the spine leaves the leg axis by `angulation`, in the deck's fully banked frame —
  so the legs lay *past* the deck and carry the hips inside the turn over the engaged edge, while the spine trims
  the shoulders back out of it, and the two edges do it by different amounts. `angulation` is what sets how far
  the head travels; it barely moves the hips. Legs and arms still solve through two-bone IK, so no stance can
  stretch a limb.
- **The hips are on an absorber, and it is the point of the figure.** They carry the deck's velocity *along the
  surface* exactly, so 27 m/s of travel costs them no lag at all. What they do not carry, while grounded, is its
  motion *along the spine* — that is the whole budget of a rider's legs. The offset decays at 0.20 s, which puts
  a real terrain roll (a rad/s) straight through and drops the contact's few-Hz transients to a fifth. Driven
  with an 8.6 cm, 4.3 Hz deck bob: it **arrives at the head as 1.58 cm**, 82% absorbed, with zero travel lag and
  no leg stretch. That is the "quiet upper body" a snowboarder is coached into.
- **Airborne there is nothing to absorb.** No contact force, so the rider falls on the board's own parabola and
  the hips carry the whole velocity: measured float off the deck through a 1 s fall is **0.00 cm**.
- **Touchdown is the rider's momentum.** The pushout stops the deck in one tick; the hips go on carrying the
  speed they arrived with for `ABSORB_LAND` (15 ms, integrated analytically so the frame rate is not part of the
  landing). The knees bend **2 cm on a 2 m/s bump-skip, 7 cm at the 6.309 m/s ollie floor**, and bottom out on
  the 12 cm leash past ~11 m/s. A hip is never pulled past its ankle's reach — the knee straightens instead, so
  no bone ever stretches.
- **The ollie is a coil and a spring, and both are the charge.** The crouch is applied outside the absorber
  (a pop has to be instant), and its target *is* the charge meter — `CHARGE_RATE` is slower than `CROUCH_FOLD`,
  so the duck never lags the bar. The launch then spends it: for `POP_TIME` the target goes **negative** and the
  legs drive out past standing, as hard as the charge that fed them. A full charge drops the root **22.0 cm**,
  and the full pop target drives it **9.7 cm** above standing, at which point the legs are 99.8% extended and
  still not locked. The drive reads the
  charge, not the launch speed — the spec's 6.309 m/s floor means a tap and a full charge leave the lip within
  1.7 m/s of each other, so the *speed* would show a watcher nothing. What shows is how deep he was and how hard
  he stood up. The legs never lock: a hip pulled past its reach straightens the knee instead.
- **The arms carry no load, so they simply obey the board.** A mass hanging in the deck's accelerating frame feels
  the pseudo-force `−a`, and that one term is every case at once — nothing below tests for a jump or a landing.
  Standing, `a` is zero and the arms hang. Airborne, `a` **is** gravity, so `−a` points a full g upward and the
  hands float **7.1 cm** up (3.2 cm on the weaker rising gravity, so they rise further as he falls). A carve
  accelerates into the turn and throws them **4.5 cm** out of it at 12 m/s², 7.1 cm at 20. A held boost trails
  them 8.8 cm back, a brake swings them 5.5 cm forward, and a 38° slope holds them 2.3 cm back the whole way down.
  A landing spikes `a` upward and drives them down, graded by how hard it was: **1.7 cm off a 1.5 m/s bump-skip,
  5.3 cm at the ollie floor, 9.0 cm at 12 m/s**, peaking a fifth of a second after touchdown and back inside a
  centimetre in about half a second. Because the pop floats the hands up first, a real ollie-to-landing swings
  them through **11.5 cm**.
- **What bounds the arms is anatomy, not a clamp.** The board's acceleration is *measured* (Δv across the ticks
  that ran, so the pushout's `vel -= vn·n`, the launch impulse, a crooked touchdown's velocity scaling and the
  speed cap all reach the rider — none of them pass through `groundTick`'s acceleration vector). That makes it
  spiky by nature: a 6 m/s landing is 360 m/s² for one tick. `ARM_LEAD` is the shoulder declining to be a rigid
  link, which is also what drops a ±31 m/s² few-Hz shake at the deck to a **0.92 cm** shimmer at the gloves. Past
  that, the hand is held on its own reach sphere, so a downward throw on a near-straight arm *swings* it rather
  than extending it, and `ARM_TRAVEL` backstops the rest: a 25 m/s and a 40 m/s crash-grade Δv both stop at the
  same 9.6 cm. The elbows are then **solved** to the hands with the same two-bone IK the knees use, poled at the
  arm's own resting elbow — the arm bends to follow its glove, and no bone stretches to do it (0.0000 mm, every
  case above). Free fall settles to 7.13 cm at 30, 60, 120 and 240 fps alike.

Legs are two-bone IK poled over the toes, canted along the board by `kneeTrackFront/Rear`. The femur sockets sit
±11 cm along the board from the pelvis centre and are skewed **1.15 cm** across it — derived, not chosen, from
the feet's own 6° mean open stance over that 22 cm span. Neutral cruises with the hip sockets 72 cm up, which
is **56° of knee flexion**; the shoulder line sits 10° out of square with the front shoulder 5.9 cm heelward and
1.4 cm lower than the rear.

The head sits 10.5 cm above the skull base along a separately stabilised up axis, because carrying the deck's
full roll out to a lever that long would sweep the head sideways through a carve; it rejects 80% of the roll
while grounded and 65% in the air, and orients +Z down-course. Eyes, pupils, a mouth and orange headphones make
that gaze and any unwanted roll visible in the stand-in itself.

The gaze also lives a little. During calm grounded travel — outside a committed edge, a
tuck or a pop, and only above 4 m/s, so a parked rider and every zero-velocity fixture hold perfectly still —
the head occasionally yaws to check the mountain about its own stabilised up axis, then eases back down-course;
anything that reclaims the eyes interrupts the look at roughly double speed. Every property of a glance is a
fresh draw: the wait between them is memoryless (an exponential with a 6 s mean, capped at 20 s so the quiet
spells stay bounded — sometimes a quick double-take, sometimes nothing for a while, never a metronome), the
side is a coin flip, the size is 15–65°, and the hold is 0.35–1.4 s. Each rider draws its own, so a field
checks the mountain out of step. The same glanced forward drives a skinned character's `Head` bone.
`test/rider-pose.test.ts` cruises one rider long enough that a glance must fire and return, and parks another
long enough to prove it cannot.

The jacket follows the back chain rather than one cylinder: two tapered shells cover the lumbar and thoracic
links, front and rear clavicle links run from the neck base to each shoulder, and one neck link covers what is
left. With the chain anatomical there is nothing between the neck base and the skull to bridge, so there is no
trapezius link — the collar *is* the clavicle root.

Positive `crouch` is a fold, not an elevator. The hips drop **22.0 cm** while the shoulders travel **30.1 cm**,
because the waist closes 30° on top of whatever the edge already asked for and carries the chest **21 cm**
toeward on the way down. A snowboarder stands across the board with their chest over the toe edge, so folding
forward *is* `angulation` — a racing tuck and a carve's angulation are the same joint doing the same thing,
which is why they simply add. Negative `crouch` is the pop drive and deliberately keeps the neutral torso.

A turn-input reversal remains presentation-only: the stance and its banked frame cross on a 140 ms half-life,
reaching 90% in about 0.47 s, while the board and physics remain immediate. Carve stances apply only while
grounded; apparent gravity, the coil, the absorber and inertial arm sway remain the neutral, airborne and
transient machinery. `test/rider-pose.test.ts` checks that ten stances — both edges, coiled and crouched
carves, a pop, a landing, a hard carve under acceleration and free flight — each hold eight exact limb lengths,
keep every hip inside its leg's reach with the knee bent over the toes, and keep the jacket on the skeleton.
The pose still allocates nothing.

The authored `chase near` candidate is a **1.8 m full boom** (2.1 m under boost) and aims one metre above the
rider root. The retained-eye filter turns that into a speed- and slope-dependent live seat; on Garibaldi the
moving output commonly approaches 3 m back and about 3 m above the root, close enough that all of this reads:
the knees working, the deck's edge angle, and which way the rider is looking.

## Board sound (`app/ride/board-audio.ts`)

The ride has a **bed**: the glide hiss and carve grind under the board, the scrape of a rail, the ollie pop
and landing thud, and the roar while boost is held — performed from the game's own shared `zboard` bank, with
the surface under the board picking the family row [Trailmap: 420-audio-runtime]. So a painted ice patch is
audible before it is a surprise, and "does that bridge read as wood" is a question the ride can answer.

The layers are performed by the physics, from the tick state: glide rides speed, carve rides lean plus
sideways slip, both fade out in the air and hand over to the rail loop on a grind.

The ride also plays the **game-event cues** — the gem chime by tier, the speed and trick pad hits. Those are
not sounds in the effect graph: the graph node carries the multiplier or the boost, and engine code on that
apply path plays a fixed MAIN-bank slot [Trailmap: 390-pickups-and-race], so `applyEffect` fires them where
the gameplay lands. What the mountain carries is the **mix** — Scene ▸ `<mountain name>` ▸ Sound ▸ Board sound. See
[034 — Board sound](034-board-sound.md) for the family matrix, the cue slots, the bank routes, and what is
ported from the retail programs.

## The AI field (`app/ride/ai.ts`)

Set **AI riders** above zero in the Test panel and the mountain's AI lines get ridden. The opponents are not markers
sliding along a polyline — they are *riders*: each one owns a `createRideModel` on the same terrain, with the
same contact, carve, gravity, rails and out-of-bounds floor the player gets, and is drawn by the same `pose.ts`
the player is drawn by. The AI supplies exactly one thing: **the steering stick**.

That is not a convenience, it is the port. An SSX AI racer is an ordinary boarder whose input source fills the
same packed pad word the human's stick fills ([Trailmap: 395]) — so it cannot steer outside the physics, cannot
cheat the terrain, and washes out on ice for the same reasons you do. Everything the field does emotionally
right (carving wide when it comes in hot, chattering over a rip, getting air it did not ask for) is free,
because it is the same board.

### An opponent rides the LEVEL, not just its lines

"The same model the player gets" has to mean the whole model, and everything the mountain does to a rider is
part of it. Each opponent is therefore handed the same four things the ridden board is, built once at launch and
shared by the field (read-only geometry; the latch state over them is per rider, because the engine's is):

- **Prop collision** — the level's colliders. Without them a field rides through the architecture, which on an
  urban course is most of the course.
- **The MainType-0 boost volumes** ([Trailmap: 360-node]) — conveyors, exhaust vents, air shafts, the finish
  tube. The engine runs these off the boarder's carried velocity, not off the player's. On MEGAPLEX this is the
  difference between a lap course and a one-way run: its finish tube *is* how a rider gets back to the top, so a
  field that cannot be lifted by it can never start a second lap.
- **The MainType-13 reset volumes** ([Trailmap: 390-pickups-and-race]) — the boundary the author drew around the
  run, which MEGAPLEX lines with 137 m walls and MERQUER floors its subway with. The player takes these through
  the SSF graph runtime, which dispatches from its own board and cannot see an opponent, so the field is handed
  the host keys instead and each rider matches them against its own prop contacts. Same event, same collider.
  A rider that leaves the run is put back on a respawnable line, exactly as the floor and the wedge integrator
  put it back.
- **Its own lap countdown.** The engine keeps one counter per rider and the lap-gated volume reads *that* one,
  which is what makes lifted-thrice-then-through a per-rider fact rather than a race-wide one.

And each opponent's prop contacts run the level's **collision-circumstance SSF graphs**, carrying the rider that
made them: `ai.ts onPropCollision(slot, hit)` → `referenceEffects.propCollision(…, subject)`, and every
rider-directed command the graph then issues comes back through `applyRideEffect(action, subject)` to that slot.
MEGAPLEX's ride-over buttons are the case that needs both halves at once — a two-frame green/red material and a
Speed 3.5 — and they split cleanly: the material flip is a **world** effect and happens for whoever is watching,
the boost is a **rider** effect and lands on the opponent that rode over it. Route the subject wrong and you get
the visible bug, which is that an opponent's button boosts *your* board. The two scoring commands (trick-boost
window, gem multiplier) go nowhere for an AI rider, because they are consumed by a scoreboard it does not have —
and the pad cue and gem chime stay with the player, since those are the engine's sounds of *your* pickup rather
than a noise every rider on the mountain makes.

**The steer is pure pursuit into a proportional heading controller.** Project the rider onto its path, take the
point **8 m further along** as the target, and press the stick in proportion to the *bearing error* to that
target: dead below ≈1.8° of error, saturated by ≈8.8°. There is no path-tangent term, no velocity feedforward
and no PID — the smoothness comes from the lean slew the stick feeds, not from the controller. Four details are
load-bearing, and all four are the engine's rather than anything you would invent:

- **"8 m further along" means 8 m across the GROUND.** A path's arc-length ruler is plan-view distance: the
  on-disc step stores a unit *ground-plane* direction and its *horizontal* length, and the arc sums those lengths
  ([Trailmap: 250]). The climb is not arc. Rule it in 3-D — as this port did at first — and every steep stretch of
  line quietly collapses the lookahead: Garibaldi's big drop is one authored step that falls **162 m across 31 m
  of ground**, so 8 m of 3-D arc buys 1.5 m of ground, the target lands almost on top of the rider, the bearing to
  it is noise, and the rider carves at a point beside itself. It is the single most expensive line in this file.
- **The projection is horizontal.** The closest point, the perpendicular distance and the path heading all drop
  the vertical component. So a rider sailing over a jump — or one that *missed* the jump and is twenty metres
  below the line that arcs over it — is, as far as the tracker is concerned, still **on** its path: small perp,
  arc still advancing, lookahead still pulling it down-course. Measure that perp in 3-D (again, the obvious way)
  and the rider decides it is hopelessly off-line, re-chooses its path every second, and **orbits under the jump
  forever**. Only the path *chooser* measures in 3-D, which is what stops a rider picking a line overhead.
- **The arc is forward-only.** The search resumes at a cached segment and runs forward at most 30 m, stopping at
  the first segment whose foot is interior. The projection cannot rewind onto an earlier part of the line, so a
  rider that doubles back can't re-latch behind itself and loop. The cache is dropped whenever the path changes.
- **"Right" is defined as the way a +1 stick actually turns the board** (`fwd × up` — the physics negates the
  stick and yaws about the contact normal), not as a basis picked by eye. The other choice type-checks perfectly
  and steers every rider off the mountain.

**And one thing the engine gets away with that we cannot.** The bearing is taken in the rider's **board plane** —
the board's own tilted up is projected out of the rider→target vector before the angle is formed. For a target
*below* the rider that is harmless. For a target *above* it is not: the forward component of the projection goes
as `f·cos θ − h·sin θ` for a target `h` up and `f` ahead on a board tilted `θ`, so once `h/f` exceeds `cot θ` it
flips **negative** and the rider turns to chase a point behind itself — and the turn sustains itself, because
circling holds the rider's own projection still. With the 8 m lookahead that is a target ~38 m up on a 12° slope.
The engine ships **no guard** against this (there is no vertical term in the tracker, the perp, or the re-select
trigger) and it does not need one, because its riders *take* the jump — the marker telling them to is authored
and fires where the data says. Ours do too. But 51 of Garibaldi's 90 AI paths fly more than 15 m over snow
you can stand on, one of them by 101 m, so a rider knocked off a lip by a rival ends up in exactly that state and
still has to get down the mountain. So `lostUnderLine` is **ours**: if the target a rider is steering at lies
*behind* it in the plane it steers in, no stick input can ever reach it, that line is not its line any more, and
it re-chooses — on the engine's own once-a-second cadence, through the engine's own 3-D chooser, which hands it
the ground-level line running under the one that flew away. Only the trigger is new.

**A rider follows a chain of paths, not a path.** This is the part it is easy to get wrong, and getting it wrong
looks like a bug: a level's AI paths are *short overlapping segments* — Garibaldi ships 90 of them, and the six
`StartPosList` gate lines the riders spawn on are ~350 m stubs. Field the riders on their gate lines alone and
they all sail off the end of the gold path a few seconds in. So the hand-off is ported too: when a rider's
projection comes within **2 m of the end** of its current path it chooses the next one, and when it is shoved
more than **5 m off** its line it re-chooses (at most once a second, grounded only). Candidates are the **six
nearest** paths; any already within 2 m of its own end is no use and is dropped. The winner is the lowest score:

```
score = |pos − closestPoint|² + |lookaheadTarget − pos|² − (100 − |rating − mood|) · 2.319
```

`rating` is the path's **line rating** — the AIP record's `U3`, 0–100, how *daring* that line is
([Trailmap: 395]) — and the match term is worth up to ~15 m of geometric error, which is enough to pull a rider
onto a line it is not currently nearest to. That is what the ninety paths are *for*: a level offers a safe line,
a fast line and a trick line over the same stretch of mountain, and which one a rider takes is a runtime
decision about temperament. On Garibaldi the census is 82 lines at the default 50, plus 100/100/100, 80, 25, 25,
20 and 0 — those outliers are the choices.

**Catch-up is time dilation, not a force** ([Trailmap: 395]). Each rider scales its own timestep by a factor
banded on its *along-course* gap: inside ±5.17 m time runs normally; further behind it ramps to **1.50×**,
further ahead it collapses to **0.70×**, slewed at 0.008444/tick so a full swing takes ~1.6 s. A rider that is
behind gets *more physics per frame* — it accelerates harder and carves faster with the same board, rather than
being teleported or given a speed bonus. Lateral distance never counts, only progress.

**And it is a ladder, not a star.** The standings pass sorts every competitor — the player included — by progress
along the course spine, and hands each rider the competitor *immediately ahead of it in the placings* as its
reference; the leader gets the runner-up, which is what slows a runaway. Each rider therefore paces the one in
front of it. Band the whole field against the player instead and you have built a magnet: six riders all dilating
toward one point in space, which converges them onto the player and onto each other. That is a bug that looks
like a feature until you watch the field ride, and it is what the standings ladder exists to prevent.

**The AI jumps because the level told it to.** This is the part that is easiest to get backwards: an AI rider's
ollie is not emergent, it is **authored**. Each tick the rider range-queries its own path for a **jump marker** in
the arc window `[last frame's arc, arc + 3 m]`, and presses the button if the marker is still ahead, it is within
**1.53 m** of its line, and it is going roughly straight (a rider does not jump mid-carve). It holds the charge
while a marker stays inside a tighter 0.5 m window — so the charge builds over the last half-metre and fires as it
crosses the lip — and boosts during the run-in if it is more than 5 km/h under the marker's **target speed**.

Those markers are the AIP's `EventType` **100** records (Garibaldi ships
104, target speeds 46–117 km/h), and the field reads them off the reference level. **The authored mountain has
none** — there is no equivalent to author yet — so a field on your own course still never ollies. That is the next
gap, not a bug.

A marker's arc is only as good as the ruler it is measured on, and ours was wrong twice over. Besides the 3-D arc
above, the reader **dropped the path's seed point**: SSX stores a path as a seed plus steps, and the seed is the
line's *first vertex* — the engine's own walk starts there ([Trailmap: 250], an open question this closed). Start
at the first accumulated point instead and you lose the whole first segment, sliding every marker back by its
length: a **median of 4.3 m** on Garibaldi, up to 49 m, against a 3 m approach window. Which is to say the riders
were missing the jumps *because* the markers were firing in the wrong place — and missing the jump is how they
got under the flight path they were then doing donuts beneath. The two bugs were one bug.

**Riders react to each other, and that is what stops a field riding in single file.** Each one keeps a rival: the
nearest competitor within 7 m, scored so the one straight ahead beats a nearer one off to the side, re-picked five
times a second and dropped past 10.5 m.

- **Avoid.** A rival is "in the way" if it falls inside a cone of `atan(1.5 m / distance)` — a cone that *widens
  as you close*, ≈12° at 7 m and 45° at 1.5 m. The rider then **rotates its whole pursuit vector** around the
  rival and carves toward that displaced aim, rather than nudging the stick. And it only swerves if it is
  **faster** than the rival: a slower rider holds its line and eats the block, which is why real SSX traffic
  bunches and shoves instead of politely parting.
- **Bodies collide.** Two overlapping riders are pushed apart, 0.55 of the separation each.

The engine has a fourth behaviour — **attack**, which abandons the line to pursue an intercept 3 m ahead of a
rival — but it is selected by a game-mode enum the RE could not resolve, so it is documented and deliberately
not fielded here rather than guessed into a branch that never fires.

**What makes the riders differ** is four things, in this order:

- **The lines they take.** The rating × mood choice above. Riders fan out across the mountain instead of sharing
  a groove.
- **Each other.** The rival machinery above. Take it away and there is nothing left in the code that can push two
  riders apart — which is exactly what a single-file field is telling you. (There is **no per-rider lane offset**
  in the engine: every rider aims dead at the centreline. That is the obvious fix and it is not the real one.)
- **The skill scalars.** Two per rider, switched on placement, scaling both how hard they turn and how far they
  stray from the safe line. A sloppy rider drifts off its line, gets re-chosen back onto it, and scrubs speed
  carving; a sharp one holds it.
- **The speed statistic** — and here the RE corrects an intuition. The traced statistic gates the cruise
  *drive* (the pull toward the surface's speed target, [Trailmap: 360], factor 0.738–1.015 across characters). It
  does **not** raise the target, and the drive is strong enough that everyone pins to it — so **no character has a
  higher top speed than any other**. What the stat buys is *recovery*: how fast a rider gets back up to pace off
  the gate and out of every carve. Measured end-to-end here: 5.8 m over 20 s between the weakest and strongest
  rider on shallow ground after removing the non-engine drag and applying the Snowdream grounded-pull
  calibration: 5.6 m over 20 s, ending at the same ≈20 m/s pace. It is a real difference, and a
  small one — a field of six does not string out because of it.

Which means the *big* speed variation in the real game — the opponent who rockets past you, the one who eats a
tree — is the **behavior machine**: boost presses, tricks feeding the meter, and crashes. That is the untraced
part, and its absence is why our field rides more evenly than a real one.

**A fallen rider is put back on the course, not sent home.** When a rider drops out of the world the field runs the
engine's **course reset**: take a point as far down the course as the rest of the field has got, find the nearest
**respawnable** path to it — the AIP flags which lines are safe to be put back on, and that flag gates the reset
and *nothing else*, so a rider may freely ride a line it could never be respawned onto — and set it down there
facing down-course at 8.33 m/s. (The engine has **no stuck timer**: nothing resets a rider merely for making no
progress. It doesn't need one, because the horizontal tracker above means a rider that misses a jump keeps riding.)

Still not ported, and named rather than hidden: the AI's **tricks** (the engine picks one at the jump press; we
have no trick system to fire it with), its **cruise boost** (gated on the boost meter, which this ride has no
equivalent of — so our riders only boost where the engine boosts for a traced reason, the run-in to a jump
marker), and the **throttle axis** (this model's cruise drive is automatic, so the tuck stands in for it). The
**mood's inputs** are partial the same way: the engine reads placement, the boost meter and a skill-weighted dice
roll, and we have the placement and the roll but no meter.

**The authored mountain has no network to chain through** — our six derived lines each run the *whole* course, so
a rider never hands off. What they do have is a **rating each**, read off the line's own wander (`aiLineRatings`,
and the same values the AIP export ships): the line that hugs the fall line *is* the safe fast one, the line that
swings wide into the shoulders *is* the risky one, so the rating means something you can see. A leading rider
drifts onto the straight line and a trailing one onto the wide line, which is what stops six riders sharing one
groove. The default mountain exports 80 / 0 / 100 / 50 / 50 / 0 across its six lines.

Cost: the field is six more full physics riders (BVH probes and all), so it is opt-in and off by default.

### Watching the field (👁 Watch the AI)

The same field also runs **without a board of your own**. Watch fields the riders and then stands back: no
`TestRide`, so no chase camera, no HUD, no keyboard capture, and the editor keeps everything of its own — your
camera, orbit / pan / zoom, the gizmo, the overlays. The render loop just steps the field. Orbit around while
they run and you can watch six riders work the course from above like ants, which is exactly the view a chase
camera welded to one board cannot give you: whether they *fan out across the rated lines* or grind down one
groove is a property of the whole field, and it is only visible from outside it.

It needs no start point (each rider fields on its own gate), and the standings ladder simply closes on itself
with no human rung in it. Esc or **■ Stop watching** puts it away; switching the ride target or leaving Test
does too. A mountain with no AI network to ride says so instead of starting.

### Running the field offline (`scripts/ai-course-run.ts`)

Watching answers "does that look right"; it cannot answer "did anyone finish". A race on MEGAPLEX is four passes
and about three minutes, most of it out of frame, and the questions worth asking about a field — does it take the
finish tube, does it count its laps, does it chain through the network or strand itself, where does it stop making
progress — are counting questions.

So the same field runs with nothing rendered:

```
npx tsx scripts/ai-course-run.ts MEGAPLE 360 --assert   # MEGAPLE, 360 s, with assertions
npm run run:course -- <LEVEL> 120 --trace           # any extracted level, periodic field summary
npm run run:course -- MEGAPLE 300 --watch 1 --from 120 --ticks 300
```

It builds the world the way Test builds it — same `createAiRiders`, same `buildBoostVolumes`, same
`referencePatchContact`, same chirality flip — loads the level's terrain, AI network, prop collision, boost and
reset volumes and lap count, steps it at the ride's own 60 Hz, and reports per rider: laps and finishing time,
distance ridden, altitude range, how many paths it chained through, how many resets it took, and every boost
volume it entered with a tick count. `--watch N` drops to one rider tick by tick with its altitude, vertical
speed, grounded flag, path arc, perpendicular error, stick, and the volumes and colliders around it — which is
what tells a rider bouncing in an air shaft apart from one wedged on a wall. Two simplifications are named in the
file rather than hidden: a mode-2 collider's box comes from the model's own geometry rather than the rendered
instance tree, and nothing animates, so a prop that moves during a run stands still.

### Running the field on a mountain you are building (`scripts/ai-mountain-run.ts`)

The same instrument, pointed at a workspace project instead of a disc:

```
npm run run:mountain -- MY_PROJECT 400 --zones      # the run, plus what the field does at each stretch of it
npm run run:mountain -- MY_PROJECT 400 --assert     # finishes / stalls / resets / spread, as pass-fail
npm run run:mountain -- MY_PROJECT 400 --watch 2 --from 60 --ticks 300
```

It opens the named project, tessellates its quilt with `buildMountainPreview`, derives the six gate lines the
export would ship (`aiPathLines` over the document's own seed), rides them with `authoredPatchContact`, and
**collides them with the mountain's own placed props** — the same world Play assembles. `--no-props` rides the
bare surface, which is the comparison to make when the question is whether the FURNITURE changed how the
course plays.

What it answers that watching cannot is *where*. `--zones` bins the whole field by arc position along the run
and prints, per bin, how many riders got there, their mean speed, how much of it they spent in the air, and
the run's own grade — so a pitch too flat to carry shows up as a column of collapsed speeds against a knot
number you can go and select. The per-rider table adds finishing time, distance, average and top speed, resets
**taken during the race**, and the worst stall with the percentage of the run it happened at.

Two things about it are worth knowing before reading its output:

- **A single-pass course reports its own finish here.** The ride model builds no lap counter below two laps
  (`laps.ts`), which is right for the game — the run just ends — and useless for a report whose headline is
  "did the field get home". So the crossing is tested in the runner on `laps.ts`'s own terms: the plan-view
  plane through the finish anchor, entered from behind, within ±60 m. That half-width is also a design
  constraint on the course, and the runner is where you find out you have broken it: a finish apron wider than
  ±60 m is one an AI rider can ride straight past.
- **Everything is measured during the race.** A rider that has taken the flag keeps going, off the end of the
  runout, resetting the whole way; counting that would put its drift into the course's average speed and its
  post-race falls into the course's reset tally.
- **Prop contacts are a per-rider column, and an assertion.** A placement renders through
  `compose(pos, rotation, scale) · RAW_TO_EDITOR` under `worldRoot`, so an obstacle's world matrix here is that
  product with the runner's own Z flip in front of it — the identical frame the terrain is in. Group
  placements expand to their members, as the export writes them; a mode-3 sphere-body placement is skipped and
  counted, because its shape lives in the donor level's physics table rather than in the mesh. The `hits`
  column is what separates *the arrays gate the field* from *the arrays are scenery*: a stray brush is racing,
  and a rider grinding along a row every run is a placement standing inside a corridor nobody can steer out
  of. `--assert` fails past ten contacts on any one rider.

### Dropping a rider on the slope (a click in Test)

**Ours, and it has no engine counterpart** — the game seeds a field at the gates and never needed anything else.
An author does: the question you actually have is "what does the game do *here*", about the pitch you are shaping
or the line you have just moved, and riding the whole mountain down to it to find out is a poor way to ask.

So in Test a click on the slope **drops one AI rider there and lets it go** (`ai.ts spawnAt` ← `viewport.dropAiRider`
← `play.clickSlope`). What lands is an ordinary member of the field from its first frame — it takes the best line
from where it was put down, through the same 3-D chooser a shoved rider re-chooses with (at a neutral mood: a rider
that has not raced yet has no placement to have an opinion from), and rides it. That is the point: what you are
watching is the real controller reading the real terrain, not a preview of it. It needs no Play and no Watch — the
field exists the moment you click, and the render loop steps it like any other.

Repeat clicks are cheap and riders are not — each is a whole physics board on the same terrain yours is on — so
the field has a single **AI riders** count/cap from 0–16. Zero turns the field off; six is the game's own gate-count.
Past a positive cap, a click **recycles the rider that has been out longest** into the new spot rather than growing
the field, which is what keeps a click a probe instead of a pile-up. Lowering the cap retires the oldest riders on
the spot.

The riders belong to the mountain they were dropped on and to the mode: switching the ride target, leaving Test,
or starting a ride or a watch (which field afresh) puts them away.

So does what they *did*. An opponent runs the level's collision graphs exactly as you do — it knocks props over,
lights buttons, opens doors, breaks glass — and none of that is document state, so leaving Test resets the whole
Play runtime: moved bodies, thrown pieces, hidden kills, material frames and phases, counters, movers. Ambient
world motion is reinstalled behind it, so the editor is left with the mountain as authored rather than as ridden.
This is the same reset that already ran when a player's ride ended; it takes an explicit leave-Test call because a
dropped or spectated field disturbs the world with nobody riding at all.

### Shared live world interactions

Two people riding the same project now see the same **transient world interactions**. A human rider's accepted
collision, proximity-trigger entry, first crack/heal, or cracked-surface break runs immediately on their own client,
then sends one small `ride-event` over the existing session channel. The server derives the project and sender from
the authenticated socket, validates and rate-limits the payload, and relays it to the other sockets on that project;
it never echoes the event to the sender.

The replay identity is deliberately small and stable: authored/reference Play target (plus the exact reference level),
race mode, event kind, object or trigger-binding key, a sender-session-monotonic event id, rider speed, and sender time.
Recipients deduplicate by sender + id, discard stale events after a suspended tab wakes, and apply one only while the
same target is active. Sender mode is retained as event provenance, but it is not a room partition: common doors,
fireworks and breakables replay across Race, Showoff and Freeride. A recipient still rejects the root and any nested
instance call when its own selected mode does not instantiate that target (for example, Showoff-only gems in Race).
Rider speed and an event-seeded probability sample make graph conditions take the same branch on every client.

Remote replay runs the graph's **world side**—particles, sounds, animation, property controls, thrown pieces, doors,
pickup pop/regrow, visibility and breakage—but has no local rider. Reset, HUD, teleport, score/trick multipliers and
speed boosts are therefore suppressed on receipt; those remain private to the rider who actually earned them. AI
riders still alter their own tab's throwaway Play world but never publish events, avoiding several browsers competing
to author the same simulated field.

These are deliberately self-healing states, not permanent world edits. An ordinary triggered door or animated prop
runs to its far pose, holds for Unity's **8 seconds**, then reverses to rest; another trigger while it is open extends
that hold, and one during the return turns it around from its current pose. A breakable cluster or glass pane restores
all of its touched hosts after Unity's **12 seconds**—visibility, thrown pieces, material/animation state and Play
colliders—and a fragile pane gets its full crack strength and contact gate back. Knocked Roller bodies also return
home on that 12-second cycle in Slopesmith. That last rule intentionally goes beyond Unity's generic Roller (Unity only
teleports its paired hydrant lids home): it prevents a missed event or a late join from leaving one browser with a
permanently moved prop. Gems and pad pickups retain their existing snap-away, **0.5-second hold + 1.2-second grow-back**.
Particles and fence flex already expire on their own. Consequently, once interactions stop, every connected client
converges on the authored world even if one transient message was missed; mode-exclusive objects remain absent.

This channel is intentionally **live-only**. Events are not document edits, room history, or late-join state, and are
never replayed after reconnect. A participant who joins after a latching door opened or a pane broke starts from their
own freshly authored Play world; synchronizing durable per-run world state would be a separate protocol.

This is why moving the ride **start** is a deliberate one-shot (**Position ▸ ⊕ Set custom start**) rather than the
default meaning of a click. Placing the start is the rarer of the two jobs by a wide margin, and only one of them
can own the plain click.

**Show AI paths** is Scene's overlay on Test's own toggle — separate preference, drawn only in Test, and only for
the mountain being ridden (the other one is hidden the moment a ride starts, and its lines hanging in the air
would be a lie). Riders and the lines they are supposed to be on, in one view, is how you tell a bad line from a
bad rider — which is exactly the distinction the donut bug turned on.

`test/ai-rider.test.ts` drives the real field over a synthetic slope and holds the
controller to its numbers. On a straight fall line the deadband never presses the stick at all and the rider holds
the line to **1 cm**; on an S-bend it has to carve for, it tracks to **0.20 m mean / 0.41 m worst** and gets down
the course rather than spiralling (a flipped steering sign diverges to 60 m mean, which is how the sign above got
settled); the catch-up reaches 1.45× behind and 0.70× ahead; a rider whose gate line stops at 60 m **hands off and
rides on to 232 m** instead of stranding; given two equally-near continuations rated 0 and 100 a trailing rider
takes the 100 — and swaps lines when the ratings are swapped over, which proves the *rating* and not the geometry
is choosing; three riders chasing a leader each band to a **different** competitor, the one directly ahead of them
(a chain, not a star); and the speed statistic is worth 5.8 m over 20 s while leaving both riders at the same
final pace.

The rest guard what the two RE passes fixed, and each fails loudly against the code as it stood before:

- **the airborne line** — a path is lifted 20 m off the snow across the middle of the run and the rider passes
  underneath it. It must ride **through to z = 383 m** and stay on that path. Against a 3-D perpendicular it
  circles under the arc instead, which is the bug as reported.
- **the plan-view arc** — a line tents **80 m into the air across 16 m of ground** and back down (Garibaldi's own
  5:1) while the rider passes under it on the snow. Two claims: the path's length is its **ground** length (388 m,
  not the 523 m it measures in 3-D — a hard pin on the metric, and the assertion that fails the instant anyone
  rules the arc in 3-D again), and the rider **gets down the mountain** (z = 383) rather than doing donuts under
  the tent, re-choosing onto the ground-level line when its own flies away.
- **forward-only projection** — on a path it is already on, a rider's projection is asserted never to re-latch onto
  an *earlier segment*, across every run. (Not the arc *value*: that is `cum[segment] + s`, and `s` legitimately
  shrinks when a rider drifts back within the segment it is on. Asserting arc monotonicity is a bad test and it
  fired falsely.)
- **the jump marker** — the same rider on the same line has **zero air** with no marker on it and **0.9 s of air**
  with one, through the approach behaviour.
- **rivals** — three riders fielded on *one* line must never come within 0.5 m of each other and must **fan out
  2.1 m across** the line to get past. Without the rival machinery they ride nose-to-tail down the middle.
- **the course reset** — a rider that follows its gate line off the edge of the world is put back on the
  **respawnable** line at x = −40 rather than the nearer forbidden one, and **where it fell** (z = 285) rather
  than at the top of its gate.
- **the hand-placed rider** — dropped 28 m across the hill between two lines it takes the **nearer** one, then
  rides it (z = 40 → 123 m, 0.22 m off the line): the drop is the real controller, not a preview. And the cap
  holds — a third click on a field of two leaves **two** riders, with the one that had been out longest recycled
  into the new spot.

## What the spec has that this ride doesn't

Named so a reader can tell a *simplification* from a *bug*, and so the next pass has a work list:

- **Response caller state** ([Trailmap: 330]) — the forward and lateral helpers are
  implemented, but complete load-ratio/skid-control scheduling and the mapping of
  rider attributes remain open. The default normalized statistics are project choices.
- **The response's above-surface zone still has no caller.** Pre-landing alignment is implemented (see the
  contact model above), but as a bounded ballistic march over `castSeg`/`probe`, not through the engine's route
  of re-running the ground response above the surface — that branch of the response remains unread.
- **Air rotation about a stick-selected axis** ([Trailmap: 340]) — the engine spins yaw, pitch and roll at one
  rate (271–670°/s by rider stat), all three as one rotational state. This ride has yaw (the spin) and pitch (the
  flip) as two independent channels at the low-stat 270°/s, and no roll at all — so a corked rotation, which is
  the one that needs all three composing, is not expressible here. The rate does not yet vary by rider stat.
- **Boost's Tricky/uber tier** ([Trailmap: 360]) — the decoded fill, drain, crash penalty and empty gate are
  implemented, but full is simply full. The engine's higher Tricky state / infinite tier is not modeled.
- **Braking and tuck** are this ride's own; no brake or crouch input is traced in the engine at all, and neither
  is any grounded drag term (`SPEED_DRAG`). They are the controls a keyboard playtest wants, not the game's.
- **The second contact integrator** ([Trailmap: 395-reset-arm]) — the reset has two, over the same feed: the
  wedge one above (decay 0.95614, fires at 4.4920) and a slower one (0.97836, 12.0021). On any rider the first
  has not already reset, the second can only ever fire later, so only the first is fielded.
- **AI riders fire no PROXIMITY (trigger-circumstance) graphs.** Their exact prop *collisions* dispatch, which
  is where the buttons, doors, pads and reset volumes live; the proximity scan (`scanPlayTriggers`) still walks
  one rider position with one shared entered/left latch, so an opponent crossing a trigger volume fires nothing.
  Extending it means a latch set per rider, and no retail case has yet needed it.

Nothing here touches the doc, the export, or any file — it reads the live terrain + surface paint and drives a
throwaway board. Ending the ride restores the other mountain, editor camera, controls, and gizmo exactly.

## Verified

Browser-driven (the Slopesmith verify skill): **Test** is a mode with a setup panel (mountain · start ·
▶ Play). On the default mountain the board rides at a sane, bounded pace (cruise ≈ 45 km/h, ≈ 80–120 on the
pitches, not a runaway); **D** carves right and **A** left (confirmed by measuring the heading rotation), the
deck **banks** and the line bends while carving scrubs speed; **Shift** boost lifts speed (44 → 88 km/h with
the `» boost` flag); the **charged ollie** meter fills on hold (≈ 54 % at 0.2 s, 100 % by 0.6 s) and a
full-charge launch out-airs a tap from the same run-up (≈ 1.45 s vs ≈ 1.18 s airborne), a mid-air press banks
nothing (no meter, no landing pop — the coyote cancel); **R** takes the carry-back (above; covered by
`test/course-reset.test.ts` rather than by this browser pass); clicking the slope moves the
green start flag; the chase cam frames the ride; the **reference world** rides with its own surface
feel, hides the authored mountain, and draws its scenery per the top-bar **Props** pill (toggled live: hundreds of
reference instances hide / show mid-Play); the FPS chip sits clear below the top bar; **▶ Play** ↔ **■ Stop**, and
**Esc** (with no active first-person or RMB capture) or Stop restores the other mountain and returns to setup with the HUD
cleared; leaving Test restores the editor camera.
`tsc` + `vite build` clean, no ride console errors.

**Flips** are covered headlessly (`test/flip-ride.test.ts`): W and S turn the deck forward and backward at the
spin's rate and stop on release, while on the snow the same two keys still only tuck and brake; a completed
rotation lands for exactly what a straight air costs and three of them do too, while a quarter short pays the
whole tilt band; the residual rocks back to the nearest whole turn, carrying 350° forward to 360 rather than
unwinding it; and the drawn deck genuinely goes over — a quarter forward puts the nose straight down and the
deck's up out along the travel, a half turn is fully inverted, and a switch rider's W takes them over forwards
down the hill they are actually riding.

**Riding switch** is covered headlessly rather than in the browser (`test/switch-ride.test.ts`): a held steer
turns the deck 180° in the air at the traced rate; landing that turn commits the tail as the leading end and
costs exactly what landing straight costs, while a 90° slap still pays the yaw band in full; the same key carves
the same way round with the same authority on both leads; backwards creep under the latch speed changes nothing;
and an ollie + half turn + landing rides on at the surface's cruise target for three seconds without the deck
being whipped back to face front. What those checks cannot see is the *drawn* half — the deck's bank and carve
slide cross into the board's own frame through `lead`, and the chase camera falls back to the ridden direction —
so a browser run is still owed on the visual side.

**Re-seating instead of rebuilding** is asserted as a ratio measured in the same process
(`test/prop-collision.test.ts`), so it holds under a loaded parallel run: building a board over 300 props is
real work, re-seating one is at least ten times cheaper and a frame-budget operation outright, and a re-seated
board starts at rest wherever it was warped from. That pins the model-level property the fix rests on; the
`TestRide` park/seat wiring above it needs a real scene and a DOM container, so it is not covered by a check —
what to watch for in a headset is a board that comes back invisible, silent, or still wearing the gear from
two rides ago.

**The board in your hand** is covered headlessly (`test/board-grab.test.ts`): the two verbs are two buttons and
they target differently — a pointed ray finds the deck anywhere along its length and misses beside or over it,
finds a board propped on its tail at chest height where the same ray finds nothing if it is lying flat, and
carries the 10 cm of give that makes a 14 mm board aimable; the sword-draw reach fires behind the shoulder and
not in front, not at the hips, not on an arm trailing a metre back, and not when a hand drops while the wearer
is looking at their own feet. Beyond that: both gears describe an outline the
size of the thing they draw, and it turns with the deck, so a board stood on its tail is reached for end-on; a
hand out past the nose is nearest the nose and one out to the side is nearest the edge beside it; every grab
enters the mirrored upright edge carry, puts the right edge in the right palm or the left edge in the left palm,
and retains the fist's or pointer's tail-to-nose contact location however the wrist then turns; a pass applies
that same rule to the new hand and asks for a closer hand than a pick-up does;
a throw leaves at the speed the hand was moving with the tumble the wrist was turning through, while a 2 900 m/s
tracking spike leaves at the 12 m/s cap; a recall seats the outer waist edge at its 2-in controller / 1.5-in player
offset from sixty metres away and is in the mirrored controller-relative up/down carry on its first held frame, while
the cross-map snap contributes no throw velocity; that sword-draw also wins over the ordinary contact grab when
the deck is nearby on the ground; a mount takes the deck out of the hand with nothing thrown; and the
released deck then flies its whole arc turning over, ends that flight on the first touch of ground, lands up
whichever way the tumble left it, and settles — where an identical deck that was *stepped off* rather than
thrown loses its carry in the air and drops short. What no check can see is the headset half: the reach and the
pointing range in practice, whether the highlight reads at a glance, and whether a deck taken off your feet
mid-flight — or recalled over the shoulder — arrives in the hand where you expected it to.

**Getting off the board** is covered headlessly (`test/board-coast.test.ts`): a deck jumped off in mid-air falls,
lands well down-course from the bail and slides on past its touchdown before friction parks it lying on the
surface; a seated deck stays welded to a slope it is running across rather than sinking through it or flying off
it; a dismount at walking pace parks on the spot; a deck that goes off the world reports itself lost exactly once
instead of being tracked forever; a mount takes it back; and on the rider's side a carried placement keeps the
height it was given — the pair leave the bail together and stay within a metre of each other through the first
tenth of a second, which is the visible claim. The **carried arc survives** too: two seconds after a 25 m/s bail
the rider is still doing exactly 25 m/s and has covered the ground that implies, a stick pushed sideways bends
that flight for free, and an ordinary walking hop still bleeds to a stop the way it always did. The multiplayer
motion check additionally proves that a loose board/skis transform publishes while its owner stands still,
dead-reckons from its own velocity, and snaps on its independent lifecycle epoch without snapping the person.
What no headless check can see is the final drawn result, so a two-browser run is still owed on whether a remote
coasting board reads right sliding away from its owner, whether settled skis lie as flat as they should, and
whether held/thrown equipment tracks a headset session cleanly.

The ride-feel observations above (cruise pace, boost delta, air times) are stale until a run re-measures them
against the contact model described above; the mode, input and camera claims are unaffected and remain valid. The
contact model is checked numerically instead: driving the shipped
`contactResponse` through the grounded tick's own arithmetic reproduces the gravity/response equilibrium on
every surface, the with/without-redirect table above, and an 8 m/s landing reaching 3.6 cm
into snow against its 2.5 cm budget.

## Next

- **Ride the redirect.** The pre-redirect contact was ridden and the limit cycle showed as a constant small
  jerking on smooth ground; the redirect kills it to 0.000 cm in the numeric harness. A ride pass should confirm
  the deck sits quiet at speed and that landings read as "kept the speed" rather than "stopped and
  recovered".
- **A numeric harness** ([022](022-ride-model-rework.md) Phase 2) — the ride checks under `test/`
  (`ride-contract.test.ts` for the constants contract, `ride-telemetry.test.ts` and the per-manoeuvre checks for
  the rest), asserting the emergent properties above (the measured rest-depth ratio per surface, the
  `R = v²/(g·n̂)` crossover, speed carried across a concave transition) rather than the implementation. It is the contract the main Unity board now targets; the
  Basis board remains a separate migration.
- **Ride the rails.** The grind is headless-verified against [Trailmap: 350] but not yet ridden in the
  browser — a pass should confirm the catch feel, the boardslide read, and the ollie-off arc on an authored
  course. **Gems** still need their retail pop/regrow presentation; their Showoff multiplier already feeds the
  run scorer.
- **Aim the start** — the start flag sets position; heading is steepest-descent. Dragging it to aim (or a
  heading handle) would let a designer point the drop-in down a specific line.
- **Persist the start** — the start point is per-session (transient); storing the authored one on the doc
  would keep it across reloads.
