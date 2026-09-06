# 022 — Rider stance & avatar fit (why a sideways snowboard stance can't be posed in a station)

> **Status: ABANDONED (the stance) / SHIPPED (the avatar fit).** Tested in‑world on desktop. The plan was to
> pose the standing rider into a sideways snowboard stance via the board `VRCStation`'s Animator Controller. It
> **does not work**, for a hard VRChat reason confirmed by the test (below): a station **ignores the clip's root
> rotation**, so it can't yaw the body without also yawing the view, and in standing mode VRChat's own IK owns
> the legs. The board is reverted to **natural standing** (`seated = false`, no controller) — the rider just
> stands, and the VR‑verified pinned‑seat steering ([017](017-rideable-board.md)) is preserved. The
> **avatar‑fit board scaling** built alongside this (scale the deck/collider to the rider) *does* work and is
> kept. This doc stays as the record of the VRChat limit and the working fit.
>
> Keeping it because the limit is reusable knowledge: **you cannot pose a player's lower body to a different
> facing than their view through a station.** If you only need limb poses (arms, a crouch) and don't mind the
> seated free‑look feel, the muscle‑curve recipe below still works in `seated = true`.

## Outcome (the live test that settled it)

Two diagnostic rides with an obvious test pose (arms thrown up + deep squat + wide legs + an 85° root yaw):

| Config | Arms (upper body) | Legs (squat/splay) | Body yaw (sideways) | What it proved |
|---|---|---|---|---|
| `seated = false` | ✅ posed | ❌ not posed | ❌ | Standing IK owns the **legs + root**; the animation only reaches the free **upper body**. |
| `seated = true`  | ✅ posed | ✅ posed | ❌ | Seated mode hands the animation the **whole body** — *except* the root rotation, which the station still pins to its own forward. |

So the muscle poses apply (fully, in seated mode), but the **root yaw never does** — and `RootQ` is the only
lever an animation has to turn the body. Muscles can't splay a leg 90°. Therefore a station pose **cannot**
produce sideways legs with a forward view. The body's facing comes from the station transform, which is also
the player's view, and the two can't be decoupled. **Full‑body‑tracking riders are the sole exception** — they
stand sideways physically; nothing in the world drives or blocks that.

## The problem

The first standing pass set `station.seated = false` so the rider stands rather than plays VRChat's default
sitting proxy. But "standing" alone faces the rider **down the length of the deck** (feet pointing at the
nose, like a surfboard or skis) — not the **sideways** stance a snowboard actually has (feet bolted *across*
the board, body twisted to look down the hill).

The obvious idea — rotate the rider so their legs sit across the board — runs into a wall: **a `VRCStation`
rotates the player's entire tracking space as one rigid piece.** Yaw the station and the legs *and* the camera
turn together by the same amount. So "feet sideways while the view still faces down the hill" looked
impossible from world code — there's no avatar-bone *write* access in Udon, and the station is the only lever
on player orientation.

## The key insight

A station has a second, independent lever: the **Animator Controller** field (`VRCStation.animatorController`,
a `RuntimeAnimatorController`). When a player uses the station, VRChat plays that controller **on their avatar**
— the same mechanism behind every "pose seat" / cuddle spot / lying-down prop in VRChat.

The crucial difference from station *rotation*:

> **A station's rotation moves the playspace (legs + view together). A station's animation poses the avatar
> _bones_ — not the playspace.**

So a pose animation can turn the **lower body** sideways **without rotating the view at all**. That is exactly
the decoupling that station rotation can't give, and it's why the "impossible" stance is in fact achievable.

Because VRChat avatars are all Humanoid rigs, a Humanoid clip **retargets through muscle space to any avatar's
proportions** — one pose clip fits everyone, regardless of model.

## What overrides what (the part that makes it useful)

A station pose only *wins* on the bones the player isn't actively tracking. Tracking always beats the
animation:

| Bones | VR 3‑point (head + 2 hands) | Full‑body tracking | Desktop |
|---|---|---|---|
| Head / hands / arms | **player** (IK) | player | animation |
| Hips / legs / feet | **animation** ← posed sideways | player's real legs | animation |

So for the common cases — **desktop and 3‑point VR** — the animation plants the legs in the stance while, in
VR, the head and arms stay the player's own tracking. You get *legs locked to the board, upper body yours.*
**Full‑body‑tracking** players are the exception: their real legs drive the avatar, so the clip won't force
them sideways — but they can simply stand sideways themselves (which already worked).

### A consequence: the posed legs are frozen (physical crouch folds the spine, not the knees)

Because the animation pins the hips and legs, a 3‑point / desktop rider who **physically crouches** does *not*
get a knee‑bend squat. Lowering your head only moves the **head IK target**; VRChat then bends and compresses
the **spine** to keep the avatar's head at your real position, while the animated hips/knees hold their posed
height. So a deep physical crouch folds the upper body down over fixed legs rather than sinking into a squat —
exactly the behaviour you see if you physically stand up while sitting in a normal chair station (the avatar
stretches up out of the seated leg pose instead of standing). The fix levers are limited: world Udon can't
feed the avatar's station animator a "crouch amount" parameter per frame, so you can't drive a tall/crouched
blend from head height. Practical mitigations: bake a moderate ready‑bend into the stance (we do — a slight
knee bend) so it reads as athletic, and accept the spine‑fold for deep crouches. **FBT riders are unaffected**
— their real knees bend, because their legs aren't animation‑driven (see the table).

## Authoring the pose

A Humanoid clip stores its pose as **muscle curves** — float curves bound to `typeof(Animator)` with muscle
names. You can build one entirely in code:

```csharp
var clip = new AnimationClip();
void C(string prop, float v) {                      // constant 2-key channel
    var c = new AnimationCurve(); c.AddKey(0f, v); c.AddKey(0.1f, v);
    clip.SetCurve("", typeof(Animator), prop, c);
}

// Body yaw: turn the hips/legs ACROSS the board. This is the whole trick.
Quaternion q = Quaternion.Euler(0f, 85f, 0f);
C("RootQ.x", q.x); C("RootQ.y", q.y); C("RootQ.z", q.z); C("RootQ.w", q.w);

// Athletic crouch (normalized -1..1 muscle values).
C("Left Upper Leg Front-Back", 0.06f);   C("Right Upper Leg Front-Back", 0.06f);
C("Left Upper Leg In-Out",      0.10f);   C("Right Upper Leg In-Out",      0.10f);  // stance width
C("Left Lower Leg Stretch",    -0.18f);   C("Right Lower Leg Stretch",    -0.18f);  // knees bend
C("Spine Front-Back",           0.06f);                                            // slight lean
```

Two non-obvious points:

- **`RootQ` (the body rotation) is the *only* lever for yawing the legs sideways — and a station discards it.**
  Mecanim's leg muscles (`In-Out`, `Twist`) can't splay a leg anywhere near 90°, so a sideways stance *must*
  come from rotating the body root. But that root rotation is precisely the channel a station strips (see
  [Outcome](#outcome-the-live-test-that-settled-it)) — it pins the avatar to the station's own facing. So this
  bullet is *why the whole approach fails in a station*: the one thing that could turn the legs is the one
  thing the station won't apply. (It only "works" in the out‑of‑station preview below.)
- **Do _not_ bake `RootT` (the root translation).** When sampled, `RootT` sets the body-root position
  *absolutely*: `RootT.y = 0` pegs the hips to the seat point and leaves the **feet dangling below the deck**.
  Omitting `RootT` hands vertical placement back to the station, which floors the feet on the board normally.
  (Omitted curves aren't animated, so the station keeps control of them.)

The clip is looped (`AnimationClipSettings.loopTime = true`) and dropped into a one-state controller via
`AnimatorController.CreateAnimatorControllerAtPathWithClip`.

## Fitting the board to the avatar

The pose retargets *proportionally*, but VRChat avatars are their **literal size** in world space — a 10‑ft
avatar really is 10 ft, and foot separation grows with leg length. So a tall rider's feet splay past the ends
of the fixed ~1.5 m deck (it looks like a toy skateboard under them) and a tiny rider gets a surfboard. The
*pose* is right; the *board size* is wrong.

`RideableBoard` fixes this by scaling the board to the rider on mount (`fitBoardToAvatar`, default on):

```csharp
float eye = player.GetAvatarEyeHeightAsMeters();                 // Udon-callable; ClientSim implements it
float s   = eye / Mathf.Max(0.01f, referenceEyeHeight);         // referenceEyeHeight ~1.6 m -> scale 1.0
_pivot.localScale = new Vector3(s, s, s);                        // the visible "Heading"/Deck child
_box.size         = _baseBoxSize * s;                            // the box collider footprint
```

Deliberately **visual + collider only**: the hand‑integrated physics reads no transform scale (it works in
absolute world metres), so speed and handling are identical for every rider — only the deck mesh and footprint
change. The **station transform itself stays unit‑scale**, so VRChat's player placement isn't disturbed (scale
the station root and you risk displacing where the standing rider is dropped). Scale is reset to 1 on
`OnStationExited` because boards are pooled and recycled to the gate, and `OnAvatarEyeHeightChanged` re‑fits if
the rider rescales mid‑ride (that event passes only the *previous* height — read the new one from the player).
There's **no min/max clamp on the ratio** — VRChat already bounds avatar eye height (there are platform
min/max limits), so the scale stays sane on its own and the deck tracks the avatar 1:1. The only retained
guard is the `Mathf.Max(0.01f, referenceEyeHeight)`, which exists purely to avoid a divide‑by‑zero if that
knob is set to 0.

> Caveat: the board runs sync `None` (not networked yet), so the fit is local — other players see the deck at
> its authored size until board networking lands. Same boundary as the rest of the stubbed netcode.

## The preview that fools you

You can sample a clip in the Editor without Play mode: instantiate a Humanoid rig (the ClientSim
`Avatar_Utility.fbx`), `AnimationMode.SampleAnimationClip(go, clip, 0f)`, and screenshot the Scene view. Here it
showed a *perfect* sideways stance — root yawed 85°, hips facing across the board, feet split along its length.
**That was a false positive.** Out of a station, sampling applies `RootQ` as **root motion** and rotates the
GameObject; *inside* a station the avatar is pinned to the station transform and that root motion is discarded.
Lesson: an out‑of‑station `AnimationMode` preview validates **muscle poses only** — anything touching
`RootT`/`RootQ` has to be tested in an actual station.

## Resolved

- **Does the station apply the pose's `RootQ` yaw at runtime? — No.** The diagnostic rides
  ([Outcome](#outcome-the-live-test-that-settled-it)) showed muscle poses apply but the root yaw never does, in
  either `seated` mode. The lying‑down‑pose‑seat precedent was misleading: those rotate the **station transform**
  (or its enter location), not the animation's root — which is exactly why they also rotate the occupant's view.
- **Off‑centre feet / FBT** — moot, since FBT riders already stand sideways physically regardless of any
  station pose.

## See also

- [017 — Rideable Board](017-rideable-board.md) — the vehicle this poses the rider for.
- [018 — Board Model](../018-board-visual.md) — the deck the stance stands on (and its regular/goofy variants).
