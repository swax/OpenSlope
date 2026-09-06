namespace Snowknife.Engine;

// Named opcodes for the SSX SSF effect graph (the shared SsfLogic model, sourced from Effects.json at
// bundle time; SSFLogic.json is the repack-side dialect), used in place of bare integer literals the
// bundlers would otherwise compare against. Names and values are the RE's established vocabulary: the node dispatch
// table in [Trailmap: 150-logic] (main types) and the sub-type catalogue in [Trailmap: 230-level-ssf]
// (the type-0 and type-2 sub-type families; the type-0 names are the engine's own registry strings).
// Each enum is int-backed and compared against the JSON DTOs'
// `int MainType` / `int SubType` fields via a `(int)` cast, so deserialization is unchanged. The enums are
// scoped by family on purpose: sub-type 13/17/18 mean different things under type-0 than the same numbers do
// as a main type, so they must not share one flat enum.

/// <summary>SSF node main type: the opcode the effect-thread dispatcher jumps on (bounds-checked &lt; 27).</summary>
public enum SsfMainType
{
    Property        = 0,   // property-effect family, sub-typed by SsfType0Sub
    Emitter         = 2,   // particle-emitter family, sub-typed by SsfType2Sub
    AddDelta        = 3,   // OpenSlope name: animation-node op on the bound instance (grant clip budget / hold / seek)
    Wait            = 4,   // chain delay in seconds before the next node runs
    ConditionalGate = 5,   // continue-or-kill-chain test: speed / random roll / human rider / node liveness
    ActOnInstance   = 7,   // show / hide / play a sub-effect on another instance by index
    PlaySound       = 8,   // play a course-bank sound (value = raw slot)
    AddDelta9       = 9,   // OpenSlope name: as AddDelta, minus its missing-node guard
    HudText         = 12,  // OpenSlope name: show a message on the in-race HUD; payload is inline UTF-16LE text.
                           // Not a retail opcode: retail sends 12 to the inert default, so a node carrying one
                           // is a no-op unless the disc was built with the debug-text executable patch.
    ResetZone       = 13,  // course-reset trigger: re-place the rider on the race line (the manual-reset path)
    ScoreMultiplier = 14,  // trick-multiplier gem pickup
    SpeedBoost      = 17,  // raise the rider's boost amount (the gold pad)
    TrickBoost      = 18,  // trick-window boost (the red/green pad)
    CallFunction    = 21,  // run a named function (the LCD BreakLogo* dispatch)
    Teleport        = 24,  // warp the rider near a named instance
    ToggleRail      = 25,  // toggle a spline's rail-riding candidacy
}

/// <summary>Property-effect sub-type (main type 0). Original engine names ([Trailmap: 150-logic]); only the
/// sub-types SSFHandler parses appear here — the engine also names/constructs Timer 8, Rail 9, RandomBoost 16,
/// UVScrollTexFlip 19, TrickTrigger 21, Particle 22 and AnimTexFlip 259, but those cannot occur in SSFLogic.json.
/// DeadNode is a community name (the one sub-type with no engine string).</summary>
public enum SsfType0Sub
{
    Roller       = 0,    // knock-and-tumble physics body [Trailmap: 370-world-interaction]
    Debounce     = 2,    // re-fire interval in seconds
    DeadNode     = 5,    // one-shot kill / hide-source (behaviour selected by DeadNodeMode)
    Counter      = 6,
    Boost        = 7,    // directional boost volume [Trailmap: 360-speed-and-boost]
    UvScroll     = 10,   // scrolling texture UVs (water, ad boards, boost-pad chevrons)
    TextureFlip  = 11,   // flipbook / LCD-screen flip
    Fence        = 12,   // chain-link fence flex
    Flag         = 13,   // waving flag (soft-body wind)
    Cracked      = 14,
    LapBoost     = 15,
    CrowdBox     = 17,   // grandstand spectator grid
    ZBoost       = 18,
    MeshAnim     = 20,   // breakable mesh throw / reveal [Trailmap: 370-world-interaction]
    Movie        = 23,
    TubeEndBoost = 24,
    AnimObject   = 256,  // world-prop model animation (the swinging bridge)
    AnimDelta    = 257,  // delta-gated model animation (the kicker)
    AnimCombo    = 258,
}

/// <summary>Particle-emitter sub-type (main type 2).</summary>
public enum SsfType2Sub
{
    Emitter          = 0,   // timer particle emitter (the 51-field Type2Sub0 block)
    SplineMover      = 1,   // spline-path animation (the subway train)
    CollisionEmitter = 2,   // contact-fired particle emitter (the same 51-field law, stored as raw words)
}
