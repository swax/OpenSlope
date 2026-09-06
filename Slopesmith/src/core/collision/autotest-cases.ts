import type { NativeCollisionProfile } from '../doc/types';
import type { EffectLatchCircumstance, EffectNodeTemplateId } from '../effects/authoring';
import type { RgbaColor } from '../effects/emitter-colors';
import {
  COLLISION_LAB_CASES, COLLISION_LAB_MODE1_BOUNCE_OFF_CASE,
} from './lab';

/**
 * Fixture courses whose only job is to be ridden by a machine.
 *
 * The split is what keeps any of them readable. `AUTOTEST1` is the CATALOGUE: every cell is a fact hardware
 * has demonstrated, so a run comes back all-green or something changed — and because it is also published as
 * an editable Slopesmith project, it doubles as the working demo of every effect known to run on a PS2.
 * `GOLD` is the REGRESSION course selected out of it, one cell per mechanism and short enough to ride alone.
 * `AUTOTEST2` is the BENCH: open questions only, where a cell asserts nothing until a batch has answered it,
 * and graduates by being rewritten as a graded cell in the catalogue. Mixing proven and open cells would cost
 * the graded ones their meaning — a report with graded and ungraded rows interleaved teaches the reader to
 * skim ungraded rows, and the one row that mattered gets skimmed with them.
 *
 * Most fixtures ask the collision lab's other question — "does an authored contact DISPATCH ITS EFFECT
 * GRAPH at all" — and are authored so a run needs no steering and never ends early:
 *
 *  - one single-file column down the fall line, so holding accelerate crosses every case in order;
 *  - every case spans the rideable corridor, so lateral drift cannot miss one;
 *  - every case is pass-through (`responseMass: 0`), which leaves contact and effect dispatch fully intact
 *    ([Trailmap: 130-collision-data] — dispatch runs before and regardless of the response-mass branch) while
 *    letting the rider sail through and reach the next case.
 *
 * `AUTOTEST7` is the deliberate exception: it migrates the original hand-ridden response matrix itself. It
 * keeps every exact scale-1 crash-bag profile, observes one second of the resulting rider response, then
 * relays the rider back onto the fall line for the next solid case.
 *
 * Each dispatch case changes ONE field against the case above it, and every case carries the collision lab's
 * proven particle burst, so "this cell dispatched" is answered by the same signal everywhere rather than by
 * whatever the cell was authored to do. What a cell is actually asking is recorded in its `question`, and
 * the plan this returns is the machine-readable half — the harness joins it to the exported instance names.
 *
 * Dispatch is not the only thing a cell can be graded on, and for anything that acts on the player it is the
 * least interesting: a node that builds correctly and pushes nobody is a failure the dispatch slot reports as
 * a success. `expectPaint` grades the flip node's own applied frame, and `expectRider` grades what happened
 * to the RIDER — velocity, the two pad-request fields, or a position discontinuity — over the samples where
 * this cell was the nearest one to them.
 */

export const AUTO_TEST_TARGET = 'GARI';
export const AUTO_TEST_GOLD_NAME = 'GOLD';
export const AUTO_TEST_NAME = 'AUTOTEST1';
/** The catalogue's second half. Its own course because one race pass cannot reach the whole of it. */
export const AUTO_TEST_NAME_B = 'AUTOTEST1B';
export const AUTO_TEST_LAB_NAME = 'AUTOTEST2';
export const AUTO_TEST_FIELD_NAME = 'AUTOTEST3';
export const AUTO_TEST_SIGNALS_NAME = 'AUTOTEST4';
export const AUTO_TEST_RELAY_NAME = 'AUTOTEST5';
export const AUTO_TEST_CALL_NAME = 'AUTOTEST6';
/** The original hand-ridden collision matrix, linearized for the machine driver. */
export const AUTO_TEST_COLLISION_NAME = 'AUTOTEST7';
/** Placed ambient emitters, graded on whether a voice actually started. */
export const AUTO_TEST_AUDIO_NAME = 'AUTOTEST8';

/** The lab's crash bag: a retail model whose mode-1 proxy is already proven to dispatch live. */
export const CRASH_BAG_MODEL = 19;

/** GARI's trick-multiplier gem, and the fixture's only prop shape proven to take rider CONTACT while being
 *  something other than an authored panel. Retail attaches a persistent sub-256 AnimObject to it for the
 *  spin, so its donor record declares a clip; that clip does not survive the borrow, which is why the cells
 *  asking about animation use `CLIP_PROP_MODEL` and the ones asking about contact use this. */
export const TRICK_GEM_MODEL = 269;
/**
 * `SnowGun_9` from the Custom catalogue — a prop with a REAL clip, and the model every cell asking whether a
 * clip PLAYS is built on.
 *
 * The imported catalogue is the only one of the fixture's three model paths that carries keyframes to the
 * disc. A borrowed retail model does not, whatever its donor declares: `TRICK_GEM_MODEL` says `AnimTime 60`
 * in GARI and arrives with a play window of ZERO, measured as a clock of exactly 0.0 in every play-once pass
 * ever recorded on it. The import path packs `clipFrames` verbatim — `TEST_MTN_6`/`TEST_MTN_7` pack
 * `AnimTime` 40, 90, 144 and 300 unchanged, and this model reads back a 1.3333 s window on hardware.
 *
 * 40 frames is 1.33 s, chosen so a WRAP lands inside the few seconds a node lives: a looping clip on a model
 * with keyframes returns to its window start, and one on a model without keyframes counts past it forever.
 * That is a categorical read rather than a number to judge, which is the standard the canaries in
 * `tools/re-canaries` set for exactly this kind of question. An ordinary prop rather than a canary on
 * purpose — `tools/re-canaries/make.ts` rewrites canaries IN PLACE keeping their model number, so a fixture
 * built on one would silently change what it measures the next time a canary was cut.
 */
export const CLIP_PROP_MODEL = 24;
export const CRASH_BAG_BASE_OFFSET_M = -1.3501688;

/** How far off the fall line a hop's companion sits. Far enough that the rider never contacts it — which is
 *  the whole point, since its only way to acquire a node is the hop. */
export const COMPANION_OFFSET_M = 130;

/** Wide enough that drift cannot miss it, tall enough to stand in the rider's horizontal sweep. */
export const GATE_WIDTH_M = 120;
export const GATE_HEIGHT_M = 8;

/** Which observable a cell offers beyond the universal live-node observation
 *  [Trailmap: 150-dispatch-runtime]. */
export type AutoTestSignal = 'entity-node' | 'particle' | 'texture-flip' | 'sound';

/** A measurement taken off the RIDER rather than off the host, for cells whose node acts on the player. */
export type AutoTestRiderSignal = 'rise' | 'climb' | 'speed' | 'boost-request' | 'trick-window' | 'jump'
  | 'gem-multiplier' | 'impact';

export interface AutoTestCase {
  id: string;
  /** What this cell is asking, in one line — the reason it exists rather than what it contains. */
  question: string;
  /** Announce this case from a separate hidden, pass-through trigger just uphill of the measured prop. This
   *  is independent of the case's own collision graph, so a no-contact expectation still names itself on
   *  screen instead of turning the absence of a banner into an ambiguous gap. */
  stageMessage?: string;
  /** The shape the case presents to the rider. `gate` is an upright full-width panel across the fall line,
   *  `pad` is the same panel lying flat on the snow, `bag` borrows the retail crash-bag model, `volume` is
   *  an invisible effect-trigger box, `gem` borrows the retail trick-multiplier gem, and `clip` places an
   *  imported prop that carries real KEYFRAMES — which is what any question about model animation needs,
   *  since every authored panel this fixture makes is four flat vertices with no animation data in it and a
   *  borrowed model's clip does not survive the borrow. */
  shape: 'gate' | 'pad' | 'bag' | 'volume' | 'gem' | 'clip';
  /** Which Custom-catalogue prop a `clip` cell places. Defaults to `CLIP_PROP_MODEL`. */
  importedModel?: number;
  profile: NativeCollisionProfile;
  color: RgbaColor;
  scale?: number;
  /** Metres of clearance under the shape; a raised gate separates "the proxy never reported" from "the
   *  ground stab resolved the terrain instead of the coincident proxy". */
  liftM?: number;
  /** Depth of a `pad` along the fall line, in metres (default 8). This is the knob for a cell that needs the
   *  rider to stay ON the panel rather than cross it — `scale` cannot do that job, because it is uniform and
   *  a pad long enough to ride is then hundreds of metres WIDE. Measured: a scale-8 pad (960 x 64 m) lifted
   *  0.3 m launched the rider (jump 6.05) and left every cell below it unreached. Keep it under the course
   *  spacing, which is 90 m. */
  padDepthM?: number;
  /** Tilt a `pad` to lie IN the terrain rather than horizontally across it, so the rider is CARRIED by the
   *  panel instead of meeting its edge. This is the difference between the two damage regimes a Cracked
   *  surface sees — a carried contact is worth about 1, a crossing about 87 — and without it no authored
   *  panel on a fall-line course can stage the first one. */
  followsSlope?: boolean;
  /** An effect recipe attached INSTEAD of a bare collision graph. The marker is appended to whatever graph
   *  the recipe lays down, so the cell reports dispatch even when the recipe itself is inert.
   *
   *  `button-no-debounce` is the shipped button minus its leading Debounce, which live probing showed to be
   *  destroyed by the flip node that follows it (the factory drops a live node of a different sub-type
   *  before building the new one). If the two behave identically, the Debounce is decoration. */
  recipe?: 'ride-over-button' | 'button-no-debounce';
  /** A node appended to the cell's collision graph after the marker. */
  extraNode?: EffectNodeTemplateId;
  /** Further nodes appended after that, in order. Separate from `extraNode` because these are the cells whose
   *  question IS the order: a Wait between a flag set and its clear, or a node-lifetime command sitting one
   *  second behind the node it acts on. A single hook could not express either, and the delay is what makes
   *  them readable — a chain that sets and clears in the same tick is invisible to any host-side sampler. */
  tailNodes?: readonly EffectNodeTemplateId[];
  /** A node attached to the prop's PERSISTENT circumstance, on the same slot as its collision chain — the
   *  native multi-circumstance shape [Trailmap: 150-logic].
   *
   *  Nothing in either fixture has ever exercised that column, so these cells ask a question no collision
    *  cell can: does an authored persistent effect install at all? A persistent node is built at level load,
    *  so the cell's semantic live-node observation is occupied from the first sample — dispatch comes back `pre-occupied`
   *  and grades `unobservable`, which is correct and beside the point. The claim moves to the probe: the
   *  slot's sub-type word at baseline is the authored node or it is not. */
  persistentNode?: EffectNodeTemplateId;
  /** Further nodes appended to the SAME persistent graph, after `persistentNode`.
   *
   *  A persistent chain of more than one node is ordinary in retail and was unreachable here, and the gap
    *  matters for one family in particular: a node that installs nothing in the instance's live-node slot —
    *  such as a particle emitter — leaves a persistent graph with no observable at all, so
   *  "the emitter installed" and "the graph never ran" are the same reading. Putting a node that DOES take
   *  the slot behind it makes the graph legible: the slot filling proves execution reached past the node
   *  that cannot be seen. Order is the whole mechanism, so these append rather than merge. */
  persistentTailNodes?: readonly EffectNodeTemplateId[];
  /** Waive the export's across-the-fall-line span check for this cell.
   *
   *  That check exists because a cell the rider streams PAST reports a truthful `crossed-without-firing`
   *  about a contact that was never offered, which is the fixture's premise and worth asserting. It can only
   *  be applied to a shape the fixture SIZED: an authored panel is built the width of the corridor on
   *  purpose, while a borrowed or imported model arrives with whatever bounding box it came with and would
   *  fail the check for a reason that says nothing about the cell.
   *
   *  So this marks "the export cannot check my span", not "contact does not matter here". Most cells that
   *  set it read a PERSISTENT node and need no contact at all; the ones that DO ask about contact
   *  (`clip-on-contact` and its control, `clip-contact-keyframes`) still carry the whole risk the check
   *  would otherwise cover, and a miss on those reports as `crossed-without-firing` — which is why they are
   *  written to be informative when it happens rather than merely failing.
   */
  contactOptional?: true;
  /** Rewrite the persistent node's payload once the template has laid it down — the same job `tuneExtra`
   *  does for the collision chain. Separate because a cell can carry both columns and one shared hook could
   *  not tell which node it was being handed. */
  tunePersistent?: (payload: Record<string, unknown>) => void;
  /** Nodes attached to the prop's TRIGGER circumstance — the one column with no event of its own. Nothing
   *  external fires it: it is the continuation a runtime node another column installed schedules when its
   *  own condition elapses, and the authorable installer is a Counter reaching zero [Trailmap: 150-logic].
   *
   *  Placed by column rather than by the template's own circumstance, unlike `persistentNode`: what belongs
   *  in a trigger chain is whatever the author wants to happen LATER, and refusing every template that
   *  declares itself collision would rule out most of the vocabulary for no engine reason. */
  triggerNodes?: readonly EffectNodeTemplateId[];
  /** A node placed at the HEAD of the chain, ahead of the debounce and the marker. A gate only tests
   *  anything from the front: it ends the chain when it rejects, so behind the marker it would gate nothing
   *  and every cell would report dispatch. */
  leadNode?: EffectNodeTemplateId;
  /** Rewrite the lead node's payload once the template has laid it down. The gate templates each ship one
   *  default, and the open questions are about the OTHER settings of the same three words — a threshold no
   *  rider reaches, a probability of exactly 0 or 1. */
  tuneLead?: (payload: Record<string, unknown>) => void;
  /** The same, for `extraNode`. Separate from `tuneLead` on purpose: a cell that carries both would
   *  otherwise have to guess which node one shared hook meant, and the two are edited for opposite reasons.
   *
   *  `groundM` is the terrain height under this cell, for the one payload family that cannot be written
   *  without it: the vertical lift's target is an ABSOLUTE world altitude, so a cell asking it to raise the
   *  rider has to know where the rider starts. Every other cell ignores the argument. */
  tuneExtra?: (payload: Record<string, unknown>, groundM: number) => void;
  /** The same again for the tail, keyed by POSITION rather than by template id, because the cells that need
   *  it carry the same template twice: two counter marks a Wait apart are two different inputs, and two clip
   *  grants are the reading that shows a budget accumulating rather than being set. */
  tuneTail?: (payload: Record<string, unknown>, id: EffectNodeTemplateId, index: number) => void;
  /** Nodes placed in a shared FUNCTION rather than in this cell's own chain, with a `call-function` node
   *  appended to the chain to run them.
   *
   *  The whole question is the indirection, so the body has to hold something the CHAIN could not have done.
   *  Nothing installed on this instance would do: the chain's own debounce and marker already occupy the
   *  slot, and a second node landing there proves only that something ran, not which table it came from. The
   *  two bodies below therefore reach outward — a hop onto a companion the rider never touches, and an opcode
   *  that acts on the rider — and each is the same node a graded cell already proves works from a chain. */
  functionNodes?: readonly EffectNodeTemplateId[];
  /** Latch columns to populate on this cell's slot, each as an empty sentinel graph — which is the whole of
   *  what the engine asks for. Both columns are tested for POPULATED-NESS and the named chain runs *instead
   *  of* the default teardown, so a zero-node graph is the cheapest possible "yes" and is what all 29 retail
   *  references are [Trailmap: 150-logic §slot-columns]. */
  latches?: readonly EffectLatchCircumstance[];
  /** Extra `liveNode` offsets this cell reads, on top of the flip-node set every cell carries.
   *
   *  A bound-node control message writes its state on the RECEIVER, so the word to watch depends on which
   *  node the chain installed: a counter's remaining count and a UV scroll's V phase are different offsets on
   *  different structures, and only the cell knows which one it built. */
  nodeWatch?: { label: string; offsets: readonly number[] };
  /** For an object the instance cannot reach: found in the heap AFTER the window, by the pointer it holds
   *  back to this cell's instance, then watched for a moment. `backPointer` is the offset that holds the
   *  instance address; `offsets` are the words to read once a candidate is found. */
  lateWatch?: { label: string; backPointer: number; offsets: readonly number[]; seconds?: number };
  /** Box extent for a `volume` cell, in metres. A default trigger box is a thin curtain, which is right for
   *  asking whether contact dispatches and wrong for anything that acts on the rider PER TICK while they are
   *  inside: a boost's rider selection is an intersect test re-run every frame, so a zero-depth host offers
   *  one or two ticks of push and a cell measuring the push would read a near-miss as a dead node. */
  sizeM?: [number, number, number];
  /** Lay down a SECOND panel beside this one, off the rider's line, carrying no chain of its own — and hop
   *  to it with a MainType-7 node at the head of this cell's chain, running the named template there.
   *
    *  It is the companion's own live-node observation that answers the question. The rider never touches it and it
   *  has nothing attached, so a node appearing on it can only have come from the hop. A hop that fails to
   *  resolve is a silent no-op in the engine — the resolver bounds-checks and returns — so a test that
   *  watched only the host would report a perfect pass for a hop that went nowhere. */
  companion?: EffectNodeTemplateId;
  /** The companion's model. A hop target is a flat panel by default, which is right for proving the hop
   *  landed and useless for anything that needs KEYFRAMES to play — the panel has none, so a clip installed
   *  on it would be indistinguishable from one that never ran. `clip` places the imported model that carries
   *  a real one; `gem` places the retail donor, which does NOT (see `CLIP_PROP_MODEL`) and is kept only for
   *  a companion that needs a retail bounding box rather than a clip. */
  companionShape?: 'gem' | 'clip';
  /** Tune the node the hop installs on the companion, the way `tuneLead` tunes the hop itself. */
  tuneCompanion?: (payload: Record<string, unknown>) => void;
  /** What the COMPANION must do, when that differs from what the host must do. Defaults to the host's
   *  `expect`, which is right for a hop — the same contact drives both.
   *
   *  It is wrong, and unstateable without this, for the shape a negative control takes. `cracked-tough` is
   *  the twin of `cracked-shatters` at a strength no pass can spend: the HOST still dispatches, because the
   *  Cracked node is built by ordinary contact either way, while the companion must stay empty because the
   *  trigger column is never reached. One `expect` cannot say both, and inheriting it would grade the
   *  control's companion as a failure precisely when the control is working. */
  companionExpect?: 'dispatch' | 'no-dispatch';
  /** Extra words to read on the COMPANION rather than on this cell — the hop's whole point is that the
   *  interesting thing happens over there. */
  companionWatch?: { label: string; offsets: readonly number[] };
  /**
   * Lay down a bare DESTINATION prop off the fall line and aim this cell's MainType-24 node at it.
   *
   * It is deliberately not a plan entry, and that is the whole design of this cell rather than an omission.
   * Rider signals are attributed to whichever cell is NEAREST, so a destination that graded would become the
   * nearest cell on the very sample the rider lands beside it — taking ownership of the displacement that is
   * this cell's only evidence, and reporting it against a row that claims nothing. A bare prop keeps the
   * landing attributed to the cell that caused it.
   *
   * The prop carries no chain for the same reason the hop's companion does not: the only thing that can put
   * the rider there is the teleport.
   *
   * A CELL THAT CARRIES ONE HAS TO RUN LAST on its course. The destination sits a half-corridor off the fall
   * line, so a rider who arrives there rides the rest of the mountain 130 m wide of every cell below —
   * which reports as a contiguous block of `not-reached` that looks exactly like a course that was too long.
   */
  teleportTarget?: boolean;
  /** Re-centre the rider on the fall line between this cell and the next one after an explicit Wait has left
   *  the collision response observable. Used by the migrated collision matrix: a solid crash bag correctly
   *  deflects an unsteered rider far enough to miss the next small bag, so each proven solid case hands the
   *  stopped rider to clear downhill snow before the next specimen. Debounce keeps the dispatch slot
   *  observable but does not itself pause later nodes, so the Wait is load-bearing. The destination is
   *  deliberately not a graded entry; otherwise the landing sample would be attributed away from the
   *  collision whose response it follows. */
  teleportNext?: boolean;
  /** Read the instance status flags alongside the node words. This is the only entity-owned observation for
   *  a control message that the bound node does not record [Trailmap: 150-control-state]. */
  watchEntityFlags?: boolean;
  /** Read the instance's world translation. This distinguishes a node that runs from one that also moves its
   *  host, which otherwise look identical from node state alone [Trailmap: 150-control-state]. */
  watchEntityPos?: boolean;
  /** Trace the live-node slot as an ordinary probe, so it gets the same ordered transition
   *  record every other watched word does. The verdict already reports WHEN the slot first filled; this adds
   *  when it emptied, which is what lets another word's trace be read against the node's lifetime rather than
   *  against the clock. */
  watchLiveNode?: boolean;
  /** Read the null-base pad-request destinations. This operational probe distinguishes a null effect owner
   *  from a real non-local rider [Trailmap: 360-pads-ownership]. */
  watchLowMemory?: boolean;
  /** Needs a model whose tile carries a two-entry flipbook state list. */
  needsFlipbook?: boolean;
  /**
   * A placed ambient EMITTER on this cell's prop — the continuing-sound channel, which no other cell in any
   * fixture exercises and which nothing outside the console can confirm.
   *
   * Every other audio cell here grades DISPATCH: a chain carrying a Play-sound node built a node. That says
   * nothing about whether a sound came out, and the two came apart badly once — a custom emitter whose bank
   * slot was encoded as a one-shot released its voice at the end of the sample, so a build that was correct
   * in the export, in the ADL and in the bank was silent on hardware [Trailmap: 260-audio-files]. The engine
   * keeps a fixed pool of external voices and refuses to start one twice for the same event, which makes the
   * pool an authoritative read of what is sounding; `tools/autotest/audio_voices.py` grades against it.
   *
   * `event` names a retail global id and needs nothing injected — a control for the whole placed-emitter path.
   * `tone` takes one of the fixture's own generated WAVs instead, which routes through the reserved event
   * pool and the repacker's bank injection, and is the half that can regress.
   */
  ambient?: {
    /** A retail global event id. Mutually exclusive with `tone`. */
    event?: number;
    /** One of the fixture's generated clips. Mutually exclusive with `event`. */
    tone?: 'loop' | 'gated';
    /** Silent until the rider hits this prop, then permanent — engine-fixed for three ids, so this asks the
     *  export to claim one of them for the clip [Trailmap: 420-audio-runtime]. Needs `tone`. */
    hitGated?: boolean;
    /** Audible radius in metres. Default 80. */
    radiusM?: number;
    /** What a ride must observe in the external-voice pool. `sounds` = a voice started; `gated` = resident
     *  while the rider is in range but silent until contact, then sounding; `open` measures without judging,
     *  for a cell whose answer is predicted rather than established. */
    expect: 'sounds' | 'gated' | 'open';
  };
  /** A custom collision one-shot on this cell's prop, taken from the fixture's generated clips.
   *
   *  Deliberately NOT graded by the voice probe: a one-shot is a transient voice rather than a pool entry, so
   *  the pool cannot see it. It is here because the same injection carries it, and because its bank slot must
   *  come out with the one-shot encoding while its neighbours come out looped — which `snowknife bank-verify`
   *  and the build log can both check without riding anything. */
  collisionTone?: 'loop' | 'gated' | 'hit';
  /**
   * What a live pass has already DEMONSTRATED for this cell, which every later pass must keep reproducing.
   *
   * This is what turns the fixture from a probe into a catalogue: a cell with an expectation is a fact the
   * engine has been shown to hold, and a run that stops reproducing it is a regression rather than a new
   * measurement. Cells still under investigation carry no expectation and assert nothing, so an open
   * question can never masquerade as a passing test.
   */
  expect?: 'dispatch' | 'no-dispatch';
  /** Demand that the cell's flip actually PAINTED: a texture-flip node was built and its applied-frame word
   *  took more than one value. Dispatch alone is node construction and says nothing about pixels. */
  expectPaint?: boolean;
  /**
   * What this cell's node must do to the RIDER, measured over the samples where this cell is the nearest one
   * to them. Each entry names a signal and bounds it.
   *
   * The dispatch slot proves a node was constructed, which for anything acting on the player is the least
   * interesting half — a node that builds with the right words and then does nothing to anybody is the exact
   * failure the roller cell caught. These are the other half:
   *
   *   `rise`           peak upward velocity in m/s. A boost pushing, or a gated one not.
   *   `climb`          metres of altitude gained after the cell fired — the THROW. `rise` is the push's own
   *                    output; this is what a player feels, and everything between the two belongs to
   *                    somebody else (gravity, the airborne integrator, whether the cap clamps on the way).
   *                    A port can match `rise` exactly and still throw a rider twice as high.
   *   `speed`          peak carried speed in m/s, the whole vector. Where the shared cap shows up: a
   *                    scripted boost node raises nothing, so a grounded rider stays bounded at ~27.9
   *                    however hard the push, and only an airborne one can pass it.
    *   `boost-request`  speed-cap request countdown. A speed pad raises the cap rather than writing velocity.
    *   `trick-window`   trick-window countdown, in seconds.
   *   `jump`           largest single-sample displacement in m — the observable for every opcode that MOVES
   *                    a rider rather than pushing one, which is the course reset (13) and the teleport (24).
   *                    Neither writes a boarder field saying it happened, so the position discontinuity is
   *                    all there is; it is also the one signal read ACROSS a relocation rather than up to it.
   *   `impact`         largest one-sample velocity change across contact, in m/s. This is the collision
   *                    lab's physical-response signal: contact-only cases retain their approach velocity,
   *                    while a solid response can reverse, stop, or redirect it depending on hit normal.
    *   `gem-multiplier` active trick-score multiplier. It rests at exactly 1.0, so unlike every other signal
    *                    here its BASELINE is a
   *                    claim too: a course where non-gem cells read anything else has a bad offset rather
   *                    than a failing cell.
   */
  expectRider?: readonly { signal: AutoTestRiderSignal; atLeast?: number; atMost?: number }[];
  /**
   * How many times this instance may let go of a node it built — the suppression latches' whole observable.
   *
   * They are the only thing either fixture grades whose claim is that something does NOT happen: a populated
   * latch column runs no chain, it skips the engine's default teardown. So a latched cell asserts a missing
   * teardown and means nothing on its own — grade it without grading its control and an engine that stopped
   * tearing anything down at all would come back green, which is precisely the change these cells exist to
   * notice.
   *
   * A count rather than a flag, because "keeps its node forever" is not what both latches buy. Column 4
   * suppresses a node's own end and nothing else, so a latched pulse still goes when its region unloads: it
   * builds ONE node where its control builds three, and asserting zero there would fail every run. Bounds
   * rather than exact numbers for the same reason — how often a region cycles belongs to the course and the
   * window, not to the latch. Needs `watchLiveNode`; it reads that trace, not the dispatch verdict.
   */
  expectSlot?: { atLeast?: number; atMost?: number };
  /** Which run demonstrated the expectation — the provenance of the claim. */
  demonstrated?: string;
}

export const profile = (mode: 0 | 1 | 2 | 3, over: Partial<NativeCollisionProfile> = {}): NativeCollisionProfile => ({
  mode, playerCollision: true, responseMass: 0, playerBounce: true, bounceAmount: 0, ...over,
});

/**
 * The gate threshold word as the INT it is declared to be, carrying the bit pattern of the float it means.
 *
 * `Type5.U2` is an `int` in the native record while the value it holds is a float, so writing a readable `10`
 * stores the bit pattern 0x0000000A — a denormal near 1.4e-44, which is zero for any comparison the engine
 * makes. Every value here is chosen to read the same way under either interpretation, so a cell can never be
 * answering a question about the encoding while appearing to answer one about the gate: 0 is 0.0 and 0 as an
 * integer, and 1e6 is out of reach as a speed either way.
 */
const f32 = (value: number): number => {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, value);
  return buffer.getInt32(0);
};

/** Two consecutive live passes, cells firing in exact course order in both. */
const FIRST_LIVE_PASS = 'runs 20260806-002051 and 20260806-002503';

/** The three-pass batch that graded the gate, boost, roller and hop cells. */
const GATE_BATCH = 'runs 20260806-072247, -072612 and -072938';

/** The first bench batch: settled the speed gate's selector and measured both boost nodes on the rider. */
const SPEED_SWEEP = 'runs 20260806-081511, -081741 and -082007 (AUTOTEST2)';

/** The bench batch that measured the reset and both pad opcodes. */
const RESET_BATCH = 'runs 20260806-101357, -101611 and -101822 (AUTOTEST2)';

/** The bench batch that traced the breakable kill against the node's own lifetime. */
const PAD_BATCH = 'runs 20260806-100330, -100532 and -100734 (AUTOTEST2)';

/** The bench batch that settled node lifetime, chain sequencing, the two instance-flag commands and the
 *  persistent circumstance — thirteen templates in one ride, all of them read off a traced word. */
const LIFETIME_BATCH = 'runs 20260806-113339, -113606 and -113832 (AUTOTEST2)';

/** The bench batch that settled both suppression latches and three bound-node receivers at once — the first
 *  batch whose headline claim is a transition that DOESN'T happen, which is why every cell in it graduated
 *  as a pair. */
const LATCH_BATCH = 'runs 20260806-125111, -125326 and -125541 (AUTOTEST2)';

/** The bench batch that proved the TRIGGER circumstance — the last authorable column with no demonstration —
 *  and, in the two batches before it, established what may not go in one. */
const TRIGGER_BATCH = 'runs 20260806-141550, -141750 and -141948 (AUTOTEST2)';

/** The bench batch that separated a flip's own clock from a command addressed to it, timed the dwell screen,
 *  and packed the fixture's first spline mover. */
const FLIP_BATCH = 'runs 20260806-151423, -151624 and -151824 (AUTOTEST2)';

/** The bench batch that read a model clip's own clock and its finished flag, and settled the effect-end latch
 *  on the authored case it exists for. Its clip cells all rode the trick gem, whose play window reaches the
 *  runtime at zero, so what it settled is the LATCH and the node's lifetime rather than anything about a clip
 *  playing; `KEYFRAME_BATCH` is where a real window was first read. */
const CLIP_BATCH = 'runs 20260806-161020, -161222 and -161421 (AUTOTEST2)';


/** The second bench batch: the speed gate's threshold word, and the units it is compared in. */
const THRESHOLD_BATCH = 'runs 20260806-083132, -083333 and -083533 (AUTOTEST2)';

/** The third bench batch: the at-least selector has to be bit-exact, and then it gates properly. */
const SELECTOR_BATCH = 'runs 20260806-090633, -090834 and -091034 (AUTOTEST2)';

/** The bench batch that answered the Cracked surface: both payload words, and the deferred fire read off a
 *  companion the rider never touched, against a strength-1000 twin as the negative control. */
const CRACKED_BATCH = 'runs 20260807-081545, -081921 and -082206 (AUTOTEST2)';
/** The bench batch that put a node BEHIND a particle emitter for the first time, in both columns, and asked
 *  the scoring family's question in the mode its gate demands. Showoff, one rider, `gameMode 3`. */
const EMITTER_BATCH = 'runs 20260807-145921, -150106 and -150250 (AUTOTEST2, showoff)';
/** The batch that asked whether an authored teleport moves the rider, on a mountain with nobody else on it. */
const TELEPORT_BATCH = 'runs 20260807-165202, -165433 and -165613 (AUTOTEST5, showoff)';
/** The audio bench ridden against a bank that could actually PLAY — every pass before 2026-08-11 was against
 *  one 46 KB past the size garibaldi1 ships, which is silent whatever the pool reports. This batch is also
 *  the first with a custom clip in slot 64, the shared stereo glass smash [Trailmap: 260-slot-64]. Dispatch
 *  half only; the emitter and bank halves are recorded on the fixture below. */
const AUDIO_BATCH = 'runs 20260811-150418, -150615 and -150905 (AUTOTEST8, showoff)';
/** The same opcode with five opponents, behind a human-rider gate: the warp lands on the PLAYER, and the
 *  lane it lands them in is rideable for ~1 km before a stopped rider is reclaimed to the race line. */
const FIELD_BATCH = 'runs 20260807-183720, -183922 and -184123 (AUTOTEST3, race, roster trace); '
  + 'corroborated on earlier layouts by -181113 / -181203 / -181253 and -175233 / -175325 / -175414';
/** The call batch: the first authored function ever packed, and both halves of what a MainType-21 node does
 *  with one. */
const CALL_BATCH = 'runs 20260807-230446, -230633 and -230815 (AUTOTEST6, showoff)';

/**
 * The at-least selector, spelled the way the runtime matches it.
 *
 * The word is declared a float and read as an int, so this is the float whose BIT PATTERN is 1 — the same
 * thing retail writes, where it prints as 1e-45. Authoring a readable `1` instead reaches the engine as
 * 1065353216, matches no branch, and falls through to a path that passes unconditionally: measured as three
 * cells that fired at every threshold including 1e6, which looked for two batches like a branch that ignores
 * its own parameter.
 */
const SELECTOR_AT_LEAST = 1.401298464324817e-45;

/** The original collision lab predates the machine driver. Its complete 4x4 matrix and the seventeenth
 * mode-1 PlayerBounce-off follow-up are reproduced here as one fall-line course, ordered with every
 * pass-through case first so a failed response cannot hide a later gate result by ending the ride early.
 *
 * `expect` retains the marker half of the old observation. `impact` retains the other half: the three
 * exact-zero cells and both PlayerBounce-off cells must dispatch without changing the rider's velocity,
 * while every shaped, enabled, nonzero case must produce a measurable discontinuity. Mode 0 and
 * PlayerCollision-off have
 * no rider grade because their stronger claim is that contact itself never occurs. */
const COLLISION_LAB_PROOF = 'hand-ridden collision lab, Trailmap 130-collision-data § controlled matrix';
const collisionAutoCase = (
  id: string,
  test: (typeof COLLISION_LAB_CASES)[number][number] | typeof COLLISION_LAB_MODE1_BOUNCE_OFF_CASE,
  dispatch: boolean,
  response: boolean | null,
  continueAfterResponse = false,
): AutoTestCase => ({
  id,
  question: `${test.label}: ${dispatch ? 'contact graph dispatches' : 'no contact graph dispatches'}; `
    + (response === null ? 'no contact means no physical response.'
      : response ? 'the rider receives the solid bounce response.'
        : 'the rider remains pass-through despite contact.'),
  shape: 'bag', profile: structuredClone(test.profile), color: test.color,
  stageMessage: test.label,
  expect: dispatch ? 'dispatch' : 'no-dispatch',
  ...(response === null ? {} : {
    // The migrated run establishes a categorical gap, not a feel threshold: contact-only controls read
    // 0.00-0.02 m/s while the softest admitted response reads 1.17 m/s. One metre per second sits cleanly
    // between them and still catches a response branch that silently becomes contact-only.
    expectRider: [{ signal: 'impact' as const, ...(response ? { atLeast: 1 } : { atMost: 0.1 }) }],
  }),
  ...(continueAfterResponse ? {
    tailNodes: ['wait' as const, 'rider-teleport' as const], teleportNext: true,
  } : {}),
  demonstrated: COLLISION_LAB_PROOF,
});

const matrix = COLLISION_LAB_CASES;

/** AUTOTEST7: the historical live collision matrix, now machine-ridden and machine-graded. */
export const AUTO_TEST_COLLISION_CASES: readonly AutoTestCase[] = [
  // Pass-through and no-contact cases first: all seven remain reachable even if a solid-response regression
  // below turns a later bag into an obstacle the unsteered rider cannot clear.
  collisionAutoCase('m1-mass-0', matrix[0][0], true, false),
  collisionAutoCase('m2-mass-0', matrix[1][0], true, false),
  collisionAutoCase('m3-mass-0', matrix[2][0], true, false),
  collisionAutoCase('mode-0', matrix[3][0], false, null),
  collisionAutoCase('player-collision-off', matrix[3][1], false, null),
  collisionAutoCase('m2-player-bounce-off', matrix[3][2], true, false),
  collisionAutoCase('m1-player-bounce-off', COLLISION_LAB_MODE1_BOUNCE_OFF_CASE, true, false),

  collisionAutoCase('m1-mass-glass', matrix[0][1], true, true, true),
  collisionAutoCase('m1-mass-5', matrix[0][2], true, true, true),
  collisionAutoCase('m1-mass-huge', matrix[0][3], true, true, true),
  collisionAutoCase('m2-mass-point-2', matrix[1][1], true, true, true),
  collisionAutoCase('m2-mass-5', matrix[1][2], true, true, true),
  collisionAutoCase('m2-mass-huge', matrix[1][3], true, true, true),
  collisionAutoCase('m3-mass-5', matrix[2][1], true, true, true),
  collisionAutoCase('m3-mass-20', matrix[2][2], true, true, true),
  collisionAutoCase('m3-mass-huge', matrix[2][3], true, true, true),
  collisionAutoCase('m2-bounce-point-6', matrix[3][3], true, true),
] as const;

/** A volume deep enough that a rider crossing at course speed stays inside it for ~a second and a half.
 *  Every boost node re-tests containment per tick, so this is the difference between measuring a push and
 *  measuring whether one or two ticks of it happened to land. */
const BOOST_BOX_M: [number, number, number] = [GATE_WIDTH_M, 40, 40];

/**
 * Megaplex's exhaust-vent host, at its own size — the box a boost node actually ships inside.
 *
 * `Mdl_Exaust_BOOST_Volume_0` measures 3.60 × 3.12 × 3.29 m (model X × Y × Z, Z being world up), read off
 * the extracted mesh. That is an order of magnitude smaller than `BOOST_BOX_M`, and for this family the
 * difference is the whole measurement rather than a detail: rider selection is a containment test re-run
 * every tick, so DWELL sets the push and dwell is set by the box. A vent tuned rate 3 toward 100 m/s adds
 * 5 m/s on its first tick and compounds; ten ticks and thirty are completely different rides.
 *
 * Only two of the three extents govern dwell — the vertical one (how fast the rider rises out of the top)
 * and the along-travel one (how fast they pass through). The third is across the corridor, where retail can
 * rely on a rider aiming at the vent and a fixture with no steering cannot, so it takes the fixture's full
 * width. Widening that axis cannot lengthen a crossing; it only stops the pass being a miss.
 */
const VENT_BOX_M: [number, number, number] = [GATE_WIDTH_M, 3.29, 3.6];

/**
 * Tall enough to catch a rider who arrives STILL IN THE AIR, which is the one thing the cell below it needs
 * and no panel can offer.
 *
 * `pad-gate` has to run last because it carries a reset, and the cell above it is the launcher — so its rider
 * does not arrive on the ground. The vent throws them 11-21 m up and the course gives 90 m to come down in,
 * which the recorded passes cross in about 2.9 s against a flight nearer 3.8; an 8 m gate panel is simply not
 * where that rider is. Forty metres clears every throw ever measured here, and the depth is for certainty
 * rather than dwell: the three opcodes in this chain are immediate and fire once, so nothing about the
 * reading improves by holding the rider inside longer — it only has to happen at all.
 */
const PAD_GATE_BOX_M: [number, number, number] = [GATE_WIDTH_M, 40, 16];

/**
 * Long enough to hold a rider on a Cracked surface for about three seconds, because for this family DWELL IS
 * THE MEASUREMENT and the two candidate rates are three seconds apart.
 *
 * A Cracked node accepts a hit at most once every 30 frames — half a second — and the chain that built it
 * leads with this fixture's 3 s debounce. So a surface either wears down in six steps while the rider is on
 * it, or in one, and which of those happens is the whole question about how a glass pane gives way. A box
 * sized like `BOOST_BOX_M` would show at most a single step under either rule and could not tell them apart.
 *
 * Eighty metres is ~3 s at course pace and stops there rather than going further: cells sit 90 m apart, so
 * this is the deepest volume that still leaves each cell its own stretch of course to be measured in.
 */
const CRACKED_BOX_M: [number, number, number] = [GATE_WIDTH_M, 40, 80];

/**
 * How far down a RACE course the first cell goes, and it is a measurement rather than a margin.
 *
 * At the default 140 m the crash bag reported `not-reached` or `pre-occupied` on six straight passes with the
 * rider 69-118 m wide of it; at 230 m the same bag fired three times out of three with the rider 1.7-2.1 m
 * away. Six riders leave the gate abreast and the pack decides where the player is until it has sorted
 * itself out, which takes about 200 m — so this is the distance at which a cell on the fall line is a cell
 * the player rides over.
 */
const FIELD_LEAD_IN_M = 230;

/**
 * The node-local words a bound-node control message writes, recovered from the receiver's own control method
 * rather than guessed [Trailmap: 150-logic §control].
 *
 * Until these existed the whole MainType-3 family except the two instance-flag commands was ungradeable: the
 * message leaves no mark on the entity, so a cell could report that the receiver was BUILT and nothing more.
 * Each receiver keeps its state at fixed offsets off the node, and those are what turn "the command was
 * authored" into "the command landed and this is the value it wrote".
 */
const COUNTER_STATE_WATCH = {
  // One 32-bit read covers both halves of the counter's state, which is the whole reading: the remaining
  // count is a halfword at +0x34 and the marked-input bitmask the halfword above it, so little-endian this
  // word reads `mask<<16 | count`. A successful mark sets its bit AND steps the count down; a mark of an
  // input already marked does neither, which is why the pair has to be read together.
  label: 'counter', offsets: [0x34],
};
/**
 * The Cracked node's whole state, read off the three words its constructor writes
 * [Trailmap: 230-level-ssf type 0 sub 14].
 *
 *   +0x34  the crack's remaining LIFETIME in frames — the authored `U0` seconds times 60. Retail's panes
 *          author −1, so this reads −60 and the node never expires; a positive value counts down and the
 *          node retires when it lands on zero, taking its accumulated damage with it.
 *   +0x38  the 30-frame gate. Reset to 30 by every accepted hit and stepped down once per tick, so a
 *          surface takes damage at most twice a second however continuously it is ridden. This is the word
 *          that says whether a wear-down is happening at all: it sawtooths while the rider is on the
 *          surface and runs flat to zero once they leave.
 *   +0x3c  the remaining STRENGTH, as a float bit pattern rather than a number — the authored `U1` less
 *          every hit taken so far. Crossing zero is what fires the slot's trigger column, so this is the
 *          only word that predicts the shatter rather than reporting it.
 */
const CRACKED_STATE_WATCH = { label: 'cracked', offsets: [0x34, 0x38, 0x3c] };
const UV_SCROLL_STATE_WATCH = {
  // +0x3c/+0x40 are the live U/V phase (commands 5 and 6), +0x54/+0x58 the two scroll rates (commands 1
  // and 2). The template scrolls in U only, so V holds still and a written phase stays legible; U drifting
  // on its own is the corroboration that the node is running rather than merely present.
  label: 'uvScroll', offsets: [0x3c, 0x40, 0x54, 0x58],
};
const ANIM_DELTA_STATE_WATCH = {
  // Accumulated clip budget in seconds. The adjusted operational location follows
  // [Trailmap: 150-control-state].
  label: 'animDelta', offsets: [0x38],
};

/**
 * A model clip's clock, its finished state, and the words that say whether there is a clip to PLAY.
 *
 * `liveNode-0x0c` is the playback cursor in seconds and `-0x10` the seconds added per tick; `-0x08`/`-0x04`
 * are the play window, `-0x20` the clip-finished flag, and `+0x2c` how many animated ModelObject records the
 * model carries. The adjusted operational locations follow [Trailmap: 150-control-state].
 *
 * The window is the part that has to be read FIRST, because a clip node on a model with no keyframes is not
 * inert in any way the clock can show: with `start == end == 0` the wrap arithmetic degenerates to the
 * identity, so a LOOPING clip free-runs at one second per second forever and a PLAY-ONCE clip clamps to zero
 * on its first tick. Both look exactly like an ordinary reading. So `-0x04` or `+0x2c` at zero means the
 * model is inert and every number beside it is void — a check, not data.
 *
 * Every clip cell carries the whole set rather than a subset, because the subset is what hid this: the four
 * words cost nothing (the live-node packet is sent anyway, and PINE bills round trips rather than words) and
 * a cell that reports its own window can never again be read as though it had one.
 */
const ANIM_CLIP_WATCH = {
  label: 'animClip', offsets: [-0x0c, -0x10, -0x08, -0x04, -0x20, 0x2c],
};

/** Effect-thread host and owner observations. Comparing the owner with the measured rider explains whether a
 *  rider-acting opcode targets this rider [Trailmap: 360-pads-ownership]. */
const PAD_OWNER_WATCH = {
  label: 'thread', offsets: [0xe4, 0xe8],
};

/** Heap-located effect-thread watch. It includes the ticking delay and host identity needed to reject false
 *  candidates, then reports the owner [Trailmap: 150-dispatch-runtime, 360-pads-ownership]. */
const PAD_THREAD_LATE_WATCH = {
  label: 'thread', backPointer: 0xe4, offsets: [0x40, 0xe8, 0xe4, 0xe0], seconds: 4,
};

/** Historical negative-control mappings for the spline mover. They remain executable so a future engine or
 *  fixture change can expose a host-reachable mover [Trailmap: 230-splinemover]. */
const SPLINE_TRAVEL_WATCH = {
  label: 'spline', offsets: [0x4c, 0x50, 0x74, 0x78, 0x1c, 0x20, 0x44, 0x48],
};

/** Heap-located spline-mover state. Changing travel confirms a working mover even though its host translation
 *  remains static. The search needs a window that ends before the level restarts [Trailmap: 230-splinemover]. */
const SPLINE_MOVER_LATE_WATCH = {
  label: 'mover', backPointer: 0x78, offsets: [0x40, 0x4c, 0x50, 0x74], seconds: 4,
};

/**
 * The catalogue. Every cell asks one question, and once hardware has answered it the answer is recorded as
 * an `expect` so later runs have to keep reproducing it.
 *
 * Cell 1 is the control. It is the collision lab's own crash bag, whose live pass already emitted its marker,
 * so a run where cell 1 stays dark indicts the harness or the pipeline rather than any cell below it.
 */
export const AUTO_TEST_CASES: readonly AutoTestCase[] = [
  {
    id: 'ctl-retail-bag',
    question: 'Control: a retail model with a mode-1 proxy dispatches — proven live in the collision lab.',
    shape: 'bag', profile: profile(1), color: [1, 1, 1, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  {
    id: 'auth-gate-m1',
    question: 'Does an AUTHORED model\'s mode-1 triangle proxy dispatch at all? Yes.',
    shape: 'gate', profile: profile(1), color: [0.05, 1, 0.2, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  {
    id: 'auth-gate-m2',
    question: 'Does mode-2 instance bounds dispatch from an authored host? Yes — the mode every retail trigger volume uses.',
    shape: 'gate', profile: profile(2), color: [0.05, 0.55, 1, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  {
    id: 'auth-pad-m1',
    question: 'Does a flat proxy lying ON the snow dispatch? Yes — coincidence with the ride surface does not suppress it.',
    shape: 'pad', profile: profile(1), color: [1, 0.8, 0.05, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  {
    id: 'auth-gate-m1-lifted',
    question: 'A mode-1 gate lifted 2 m clear of the snow does NOT dispatch — the rider passes beneath it. '
      + 'Consistent with the ground stab reaching only ~2 m above the board, but the mechanism is unconfirmed: '
      + 'this pins the fixture\'s behaviour, not an engine rule.',
    shape: 'gate', profile: profile(1), color: [1, 0.45, 0.05, 1], liftM: 2,
    expect: 'no-dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  {
    id: 'auth-gate-m1-solid',
    question: 'Does response mass change dispatch? No — nonzero mass (which also routes the bake through ModelSolid_) still dispatches.',
    shape: 'gate', profile: profile(1, { responseMass: 1e30 }), color: [1, 0.05, 0.55, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  {
    id: 'trigger-volume',
    question: 'Does an invisible effect-trigger volume dispatch? Yes — the editor\'s purpose-built contact host works.',
    shape: 'volume', profile: profile(1), color: [0.05, 1, 1, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  {
    id: 'auth-gate-sound',
    question: 'Does a collision chain carrying a Play-sound node dispatch from an authored host? Yes. '
      + 'Whether the sound is AUDIBLE is a separate question this cell cannot answer.',
    shape: 'gate', profile: profile(1), color: [0.9, 0.9, 0.3, 1], extraNode: 'sound',
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  // ---- gates (MainType 5) --------------------------------------------------------------------------
  // Four gate modes, 453 bindings across the retail corpus, and not one of them had been behaviorally observed
  // before this fixture. Their provisional meanings therefore require explicit positive/negative pairs.
  //
  // A gate is the one node kind this fixture can grade WITHOUT reading anything new: it either lets the
  // chain reach the marker or it does not, which is exactly the dispatch signal already in place. The pairs
  // below are deliberate — a gate that passes proves only that a gate does not break a chain, so each
  // tunable mode is asked in both directions and the pair together pins the word's sense.
  {
    id: 'gate-human',
    question: 'A human-rider gate passes for the player, so a gate node does not break the chain it leads. '
      + 'Whether it REJECTS an AI rider is a different question this fixture cannot ask — it has one board.',
    shape: 'gate', profile: profile(1), color: [0.2, 0.9, 0.6, 1], leadNode: 'gate-human',
    expect: 'dispatch', demonstrated: GATE_BATCH,
  },
  {
    id: 'gate-random-always',
    question: 'A random gate at p=1 always passes, and its p=0 partner below never does. The pair pins the '
      + 'probability word: the value IS the chance of passing, read the way the template writes it.',
    shape: 'gate', profile: profile(1), color: [0.4, 0.8, 0.95, 1], leadNode: 'gate-random',
    tuneLead: payload => { (payload.type5 as Record<string, unknown>).U2 = f32(1); },
    expect: 'dispatch', demonstrated: GATE_BATCH,
  },
  {
    id: 'gate-random-never',
    question: 'The same random gate at p=0 never passes — three passes, nothing constructed, not once. This '
      + 'is the half of the pair that carries the weight: it proves the gate can STOP a chain, which is the '
      + 'only thing that makes the other four gate modes worth authoring.',
    shape: 'gate', profile: profile(1), color: [0.95, 0.5, 0.2, 1], leadNode: 'gate-random',
    tuneLead: payload => { (payload.type5 as Record<string, unknown>).U2 = f32(0); },
    expect: 'no-dispatch', demonstrated: GATE_BATCH,
  },
  // The speed gate, on the selector-0 side, which is the side that is settled end to end. Three cells: the
  // selector against a fixed threshold, and the threshold against a fixed selector. Together they are a
  // working, tunable gate — the one authored control the node has.
  {
    id: 'gate-speed-shut',
    question: 'The first speed gate ever seen to STOP a chain. Selector 0 — at most — against a threshold of '
      + 'zero, which no moving rider is under: nothing was constructed in any pass. Read with the two cells '
      + 'below, which move one word each, this is a gate whose sense AND threshold are both demonstrated.',
    shape: 'gate', profile: profile(1), color: [0.9, 0.3, 0.3, 1], leadNode: 'gate-speed',
    tuneLead: payload => { Object.assign(payload.type5 as object, { U0: 0, U1: 0, U2: f32(0) }); },
    expect: 'no-dispatch', demonstrated: SPEED_SWEEP,
  },
  {
    id: 'gate-speed-atleast-pass',
    question: 'The other sense, and it only works when the selector is spelled exactly. The word is declared '
      + 'a float and read as an int, so retail\'s at-least selector is the float whose BITS are 1 — it prints '
      + 'as 1e-45. This cell carries that, against a threshold of 30, and fires every pass. Authoring 1.0 '
      + 'instead reaches the runtime as 1065353216, matches nothing, and falls through to a path that simply '
      + 'passes: a gate that looks tuned and gates nothing.',
    shape: 'gate', profile: profile(1), color: [0.3, 0.85, 0.4, 1], leadNode: 'gate-speed',
    tuneLead: payload => { Object.assign(payload.type5 as object, { U0: 0, U1: SELECTOR_AT_LEAST, U2: f32(30) }); },
    expect: 'dispatch', demonstrated: SELECTOR_BATCH,
  },
  {
    id: 'gate-speed-atleast-block',
    question: 'The same bit-exact at-least selector against 1e6, a speed nothing reaches — and it BLOCKS, '
      + 'every pass. This is the cell that closes the node out: both senses work, both read the threshold, '
      + 'and the earlier "at-least never blocks anything" result was a wrong selector spelling rather than a '
      + 'branch that ignores its word. A speed gate is fully tunable in either direction.',
    shape: 'gate', profile: profile(1), color: [0.85, 0.45, 0.75, 1], leadNode: 'gate-speed',
    tuneLead: payload => { Object.assign(payload.type5 as object, { U0: 0, U1: SELECTOR_AT_LEAST, U2: f32(1e6) }); },
    expect: 'no-dispatch', demonstrated: SELECTOR_BATCH,
  },
  {
    id: 'gate-speed-threshold',
    question: 'The THRESHOLD is read, and it is read in raw engine units. Same at-most selector as the shut '
      + 'cell, threshold moved from 0.0 to 1e6: this one fires, where 0.0 and 30.0 both block. Since the '
      + 'rider crosses at about 25 m/s, a threshold of 30 blocking places the compared speed above 30 and '
      + 'below 1e6 — i.e. centimetres per second, ~2500, not metres. That also makes retail\'s one authored '
      + 'speed gate legible at last: Merqury City writes 30.0, which on this reading is a gate almost nothing '
      + 'gets under.',
    shape: 'gate', profile: profile(1), color: [0.4, 0.8, 0.95, 1], leadNode: 'gate-speed',
    tuneLead: payload => { Object.assign(payload.type5 as object, { U0: 0, U1: 0, U2: f32(1e6) }); },
    expect: 'dispatch', demonstrated: THRESHOLD_BATCH,
  },
  {
    id: 'gate-speed-retail-30',
    question: 'Merqury City\'s own speed gate, authored value and all: at most 30.0. It blocks, every pass. '
      + 'That is the cell that pins the UNITS — a rider crossing at ~25 m/s would be under a 30 m/s ceiling '
      + 'and would pass, so the compared speed is not in metres. It is above 30 and below 1e6, which is the '
      + 'engine\'s centimetres: ~2500. Retail\'s gate is therefore a near-closed one, not a mid-range filter.',
    shape: 'gate', profile: profile(1), color: [0.35, 0.7, 0.9, 1], leadNode: 'gate-speed',
    tuneLead: payload => { Object.assign(payload.type5 as object, { U0: 0, U1: 0, U2: f32(30) }); },
    expect: 'no-dispatch', demonstrated: THRESHOLD_BATCH,
  },
  {
    id: 'gate-no-live-node',
    question: 'The fourth gate mode passes on an instance that is running nothing. Its rejecting half is out '
      + 'of this fixture\'s reach: an instance already holding a node reports its slot as spoken for, so the '
      + 'dispatch signal cannot say whether the gate rejected or the reading was simply unavailable.',
    shape: 'gate', profile: profile(1), color: [0.5, 0.9, 0.4, 1], leadNode: 'gate-no-live-node',
    expect: 'dispatch', demonstrated: SPEED_SWEEP,
  },
  // ---- nodes that report more than their own construction ------------------------------------------
  {
    id: 'boost-directional',
    question: 'A directional boost node builds on an authored prop and carries the mode it was authored with '
      + '(+0x14 sub-type 7, +0x60 mode 1). Its +0x5c countdown read 0 at every sample, so this cell says the '
      + 'node is CONSTRUCTED and correctly configured. That it also PUSHES is the separate cell below, which '
      + 'needed a host with depth rather than this thin panel.\n\n'
      + 'This cell is the suite\'s least reliably OBSERVED, and the node is not the reason. Across eleven '
      + 'runs its live-node slot read empty in five, including one of three on a control ISO carrying '
      + 'neither the message nodes nor the executable patch — so the miss pre-dates them. Every run built '
      + 'with --patches hud-text posted its banner, all seven of seven, including all four the slot missed: the '
      + 'chain ran every time and the host-side sampler did not always catch the node. That is what the '
      + 'banner grade in verdict.py is for, and this is the cell that established the need for it.',
    shape: 'gate', profile: profile(1), color: [1, 0.75, 0.1, 1], extraNode: 'directional-boost',
    expect: 'dispatch', demonstrated: GATE_BATCH,
  },
  {
    id: 'lap-boost',
    question: 'A lap boost builds and lifts NOBODY, and the pair with the cell above is what makes that a '
      + 'finding rather than a broken node: identical box, identical lift tuning (retail\'s own finish-tube '
      + 'rate 5 / target 25 / axis 0,0,1), and one launches the rider every pass while this one never does. '
      + 'Its node is real — the slot reads sub-type 15 — and the run reports laps_remaining 0 for its whole '
      + 'length, which is the gate: the node snapshots each rider\'s lap counter as it is built and drops '
      + 'anyone whose snapshot goes negative on the first tick. The counter is seeded from the COURSE, 4 on '
      + 'Megaplex and 0 everywhere else, so a lap boost anywhere but that one slot is inert by construction.',
    shape: 'volume', profile: profile(1), color: [0.4, 0.35, 1, 1], sizeM: BOOST_BOX_M,
    extraNode: 'lap-boost',
    expect: 'dispatch', expectRider: [{ signal: 'rise', atMost: 2 }], demonstrated: SPEED_SWEEP,
  },
  {
    id: 'prop-roller',
    question: 'A roller on a CUSTOM prop builds, runs, and moves NOTHING — which is the answer Slopesmith\'s '
      + 'validator predicts and the reason to keep its warning. The instance status changes exactly as the '
      + 'spec describes, but its world translation holds one value for the whole run. A built node and a '
      + 'working roller look identical from the effect slot; an authored ISO prop has no native body for the '
      + 'roller to drive [Trailmap: 150-control-state].',
    shape: 'gate', profile: profile(1), color: [0.75, 0.4, 0.15, 1], extraNode: 'roller',
    watchEntityFlags: true, watchEntityPos: true, expect: 'dispatch', demonstrated: GATE_BATCH,
  },
  {
    id: 'flip-suppressed-by-kill',
    question: 'A breakable-kill (SubType 5) leading a flip chain does NOT suppress it: the slot reads '
      + 'sub-type 11 and the flip paints normally, frame 0 -> 1 over one material and two frames. The kill '
      + 'node is destroyed by the flip exactly as a Debounce is — the factory drops a live node of a '
      + 'different sub-type before building — so within ONE chain a sub-5 node gates nothing. This does not '
      + 'touch the separate claim that a sub-5 node left live by an EARLIER dispatch blocks a later one. '
      + 'the instance status also caught the draw gate opening and closing: while the flip '
      + 'runs, the low bits leave the drawn state, which is the disappearance a failed flip leaves behind.',
    shape: 'gate', profile: profile(1), color: [0.55, 0.55, 0.6, 1], recipe: 'button-no-debounce',
    leadNode: 'breakable-kill', needsFlipbook: true, watchEntityFlags: true,
    expect: 'dispatch', expectPaint: true, demonstrated: GATE_BATCH,
  },
  {
    id: 'breakable-kill-hides',
    question: 'A breakable kill DOES hide its prop, and the hide lasts exactly as long as its node. Read as '
      + 'two ordered traces against each other: the instance flag word leaves the drawn state '
      + '(0x…01a3 -> 0x…0105) on the same sample the node appears in the effect slot, and returns to it '
      + '(-> 0x…00a3) on the same sample the node disappears — identical timestamps, three passes of three. '
      + 'That is what separates "the kill does not apply to authored props" from "the node was torn down and '
      + 'restored the draw", and it is the second. A set of observed values could never have told them apart. '
      + 'What the kill leaves installed is its OWN kind of tombstone, sub-type 1006 rather than the plain 5 '
      + 'that DeadNodeMode 2 leaves further up the course — the distinct tag that stops a kill being '
      + 'reapplied. One lasting mark remains: bit 0x0100 clears at teardown and stays clear, meaning '
      + 'unrecovered. Holding a prop hidden past that end is what the latch columns exist for — untested here.',
    shape: 'gate', profile: profile(1), color: [0.55, 0.55, 0.6, 1], extraNode: 'breakable-kill',
    watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: PAD_BATCH,
  },
  // ---- how long a node lives, and what ends it -----------------------------------------------------
  // Read as slot HISTORIES rather than as values: sub-type 5 acts on whatever node the instance currently has
  // installed [Trailmap: 230-deadnode-modes]. So the only thing that separates its modes is what becomes of
  // the slot, and the only way to see that is to hold the two events apart in time — which is what the Wait
  // is doing in each of these chains. Without it the whole chain runs inside one tick and every mode looks
  // identical to a 20 Hz sampler.
  {
    id: 'debounce-baseline',
    question: 'An untouched 3 s Debounce holds the live-node slot for 2.98-3.05 s, three passes of three. '
      + 'This is the control the three cells below are read against: each of them puts a Wait and one '
      + 'node-lifetime command behind the same Debounce, and what they change is this number.',
    shape: 'gate', profile: profile(1), color: [0.6, 0.6, 0.6, 1],
    watchLiveNode: true, expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  {
    id: 'dead-destroy',
    question: 'DeadNodeMode 0 TEARS THE LIVE NODE DOWN. The same Debounce, one second of Wait, then the '
      + 'destroy: the slot empties at 0.98-1.07 s instead of the cell above\'s three seconds, in nine '
      + 'crossings across three passes. A node lifetime is therefore something an authored chain can end early.',
    shape: 'gate', profile: profile(1), color: [0.9, 0.25, 0.25, 1],
    tailNodes: ['wait', 'node-destroy'], watchLiveNode: true,
    expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  {
    id: 'dead-pause',
    question: 'DeadNodeMode 1 ends the node\'s hold on the instance too, at the same 1.00-1.03 s — and the '
      + 'slot cannot tell it apart from mode 0. The disassembly says they differ (mode 1 calls a stop virtual '
      + 'where mode 0 calls the destructor), the measurement says both release the slot, and reporting only '
      + 'what was seen is the difference between a catalogue and a wish list. What is proven is that the mode '
      + 'ACTS; which of the two things it does is not observable from here.',
    shape: 'gate', profile: profile(1), color: [0.95, 0.65, 0.2, 1],
    tailNodes: ['wait', 'node-pause'], watchLiveNode: true,
    expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  {
    id: 'dead-tombstone',
    question: 'DeadNodeMode 2 is the one mode that leaves something behind, and it is the only one this '
      + 'fixture can name outright: the sub-type word moves 2 -> 5 one Wait after contact and the slot NEVER '
      + 'empties again for the rest of the run, where both cells above release it. The Debounce is destroyed '
      + 'and a fresh sub-type-5 tombstone takes its place, which is also why this cell fires once and the '
      + 'others re-fire on every crossing — the mode bails on a node that is already tagged 5.',
    shape: 'gate', profile: profile(1), color: [0.6, 0.45, 0.95, 1],
    tailNodes: ['wait', 'node-tombstone'], watchLiveNode: true,
    expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  {
    id: 'wait-delays-kill',
    question: 'A Wait node HOLDS ITS CHAIN, proven against an effect already known to leave a mark. The '
      + 'breakable kill takes the instance out of the drawn state on the same sample its node appears — that '
      + 'is what `breakable-kill-hides` above shows. Put a Wait in front and the two come apart by '
      + '1.017 s every time: the slot fills with the Debounce on contact, and only a second later does the '
      + 'sub-type become 1006 and the draw bits move. Nothing but a working delay produces that gap.',
    shape: 'gate', profile: profile(1), color: [0.3, 0.8, 0.85, 1],
    tailNodes: ['wait', 'breakable-kill'], watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  // ---- bound-node control messages, seen arriving --------------------------------------------------
  // The first authored MainType-3 nodes ever caught leaving a mark. They only reach anything because the
  // Debounce ahead of them is holding the slot: the dispatcher resolves the firing thread's bound instance,
  // loads the node installed there, and calls its control method [Trailmap: 150-logic §control]. That the
  // Debounce implements commands 7 and 8 is not luck — it inherits the base handler, which is where they
  // live — and the pair below is what turns "the node was built" into "the command arrived".
  {
    id: 'flag-set',
    question: 'A Set-instance-flag command ARRIVES: the instance status word gains bit 0x0800 on the same '
      + 'sample the contact fills the slot, three passes of three, and — the part worth authoring around — '
      + 'it KEEPS it after the Debounce that received the command has expired and released the slot. The '
      + 'mark outlives the node, where the breakable kill\'s draw bits are restored at teardown.',
    shape: 'gate', profile: profile(1), color: [0.35, 0.9, 0.45, 1],
    tailNodes: ['instance-flag-set'], watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  {
    id: 'flag-set-clear',
    question: 'And the other command takes it back. Set on contact, Wait, clear: the word steps up to 0x0800 '
      + 'and returns exactly 1.00-1.02 s later, on every crossing of every pass. The pair pins both opcodes '
      + 'and the Wait between them at once, and it is the same word read three ways — set-and-hold above, '
      + 'set-and-release here.',
    shape: 'gate', profile: profile(1), color: [0.2, 0.7, 0.55, 1],
    tailNodes: ['instance-flag-set', 'wait', 'instance-flag-clear'],
    watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  // ---- the node builds, and that is the whole claim ------------------------------------------------
  // A factory branch existing in the ELF is not evidence that an AUTHORED payload survives the exporter, the
  // repack compiler and the constructor. The slot's sub-type word settles it end to end. What these do not
  // say is what any of them LOOKS like: a fence flex and a crowd grid are pixels, and this harness reads
  // memory. Saying so is the difference between a catalogue and a demo reel.
  {
    id: 'fence-builds',
    question: 'An authored fence flex reaches the disc and builds: the live slot reads sub-type 12 on every '
      + 'crossing of every pass. Whether the prop visibly springs is not readable from here.',
    shape: 'gate', profile: profile(1), color: [0.5, 0.75, 0.9, 1], extraNode: 'fence',
    watchEntityFlags: true, expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  {
    id: 'mesh-throw-builds',
    question: 'The breakable shatter builds too — sub-type 20, three passes of three. Its host does not move '
      + 'while it runs: the instance translation holds one value for the whole run, which is what a node that '
      + 'throws the model\'s PIECES rather than the model should do, and is worth having on the record beside '
      + 'the roller cell, where the same reading means the opposite.',
    shape: 'gate', profile: profile(1), color: [0.8, 0.55, 0.3, 1], extraNode: 'mesh-animation',
    watchEntityFlags: true, watchEntityPos: true,
    expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  {
    id: 'counter-builds',
    question: 'The multi-switch gate builds, sub-type 6. Construction only, and deliberately: driving a '
      + 'counter takes the two MainType-3 commands that mark and decrement it, and neither has a recovered '
      + 'word to read its remaining count from, so a cell that claimed more would be claiming it blind.',
    shape: 'gate', profile: profile(1), color: [0.75, 0.7, 0.35, 1], extraNode: 'counter',
    expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  // ---- the persistent circumstance ------------------------------------------------------------------
  // Everything above, and every cell before it, is a COLLISION effect. These four are the other column: a
  // graph that runs with no contact at all, which is how a level does anything on its own — flowing water,
  // a cycling sign, a grandstand, cloth in the wind.
  //
  // They are read backwards from the rest. The node installs BEFORE the rider arrives, so the transition the
  // verdict calls "fired" is the INSTALL rather than a contact, and the evidence is the sub-type word that
  // appears with it. Two of them then hand the slot over to the collision chain's own Debounce as the rider
  // crosses, which is corroboration rather than a nuisance: a sub-type that reads right on the way in and
  // then gives way on contact is a node that was really there.
  //
  // The install is NOT at level load. The slot is empty for the first 40-odd seconds of every run and fills
  // 4-8 s ahead of the rider, cell by cell down the course. A persistent effect is scoped to its part of the
  // mountain, not to the level, and an author who needs one running before it is approached should know that.
  {
    id: 'persist-uv-scroll',
    question: 'An authored PERSISTENT effect installs on hardware. A UV scroll — the river\'s own flow node — '
      + 'takes the live-node slot with sub-type 10 while the rider is still 7 s up the course, three passes '
      + 'of three, and hands it to the collision chain\'s Debounce (sub-type 2) on contact. Nothing in the '
      + 'collision chain could have put a 10 there, so this is the persistent column running.',
    shape: 'gate', profile: profile(1), color: [0.25, 0.6, 1, 1], persistentNode: 'uv-scroll',
    watchLiveNode: true, expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  {
    id: 'persist-flag-wave',
    question: 'The wind-waved banner in the same column, sub-type 13, every pass. This one keeps the slot '
      + 'until its part of the course goes away rather than yielding it on contact. Whether the cloth moves '
      + 'is not readable from here; that the node is installed and running is.',
    shape: 'gate', profile: profile(1), color: [0.9, 0.4, 0.6, 1], persistentNode: 'flag',
    watchLiveNode: true, expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  {
    id: 'persist-crowd-box',
    question: 'The grandstand descriptor, sub-type 17 — and the one persistent node that leaves a mark on '
      + 'the instance as well as the slot: the status word moves to 0x…01a5 as the node installs and back '
      + 'when it goes, setting the same 0x04 the other draw-affecting nodes set. Consistent with a node that '
      + 'takes over how the prop is drawn, which is exactly what a crowd box is for.',
    shape: 'gate', profile: profile(1), color: [0.95, 0.85, 0.4, 1], persistentNode: 'crowd-box',
    watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
] as const;

/**
 * The catalogue's second half, and the reason there is one is a measurement rather than a preference.
 *
 * Cells sit 90 m apart and a race pass reaches about 5,900 m, so one course holds roughly 64 rows. The
 * catalogue passed that: at 70 cases its last row sat at 6,350 m and the bottom SIX — `cracked-tough` and its
 * companion, both button cells, the vent and the course reset — could never report, whatever the engine did.
 * They graded `inconclusive` on every pass, which is the failure mode that looks like a harness problem and
 * is not.
 *
 * A LANE-BASED COURSE WOULD NOT HAVE FIXED THIS, which is worth writing down because the teleport makes it
 * look like it should. The budget is TIME, not ground: a race pass is 240 s and the reach follows from the
 * pace. A teleport does not buy pace, it spends it — the placement zeroes the rider's velocity, so they
 * arrive stopped and take about five seconds to rebuild to 21.4 m/s, which is slower than the ~33 they were
 * carrying. Against 2.7 s of riding per cell, one warp costs more than the cell it would save. Splitting the
 * course is the only thing that buys rows, because the only thing that buys rows is another run.
 *
 * The cut is at a group boundary rather than at the midpoint, so no pair is separated from the control that
 * makes it readable. Both halves now end around 3,300 m with roughly 2.6 km of headroom, which is room for
 * years of graduations rather than a reprieve.
 */
export const AUTO_TEST_CASES_B: readonly AutoTestCase[] = [
  {
    id: 'ctl-retail-bag',
    question: 'Control: the retail crash bag every course here leads with. A run where this stays dark '
      + 'indicts the harness or the menu prelude, so nothing below it is worth reading.',
    shape: 'bag', profile: profile(1), color: [1, 1, 1, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  // ---- a chain runs THROUGH a particle emitter, in both columns ------------------------------------
  // Worth starting from what was already true, because it is what made the real question invisible: the
  // marker every cell in every fixture carries IS a timer emitter, laid down from the same template with the
  // same 51-word payload (`addCollisionMarkerNode`). The record packs and has ridden sixty-odd chains, and
  // none of that was ever in doubt.
  //
  // But the marker is always LAST. No run had ever needed execution to continue past a MainType-2 node — and
  // type 2 is exactly the main type that could end a chain unnoticed, because it builds no property node and
  // never occupies the live-node slot. That same absence is why an emitter has no observable of its own, and the
  // fix for both halves is one arrangement: emitter first, a node that DOES take the slot second. The second
  // one appearing is execution having run through the first.
  {
    id: 'emitter-burst',
    question: 'A chain RUNS ON past a particle emitter. The emitter leads and the ordinary Debounce sits '
      + 'behind it: the slot took sub-type 2 on contact and held it 3.00 s — the Debounce\'s own full life — '
      + 'in three passes of three. That is the collision column\'s answer to the one thing sixty passes of '
      + 'marker emitters could not show, since a marker is always the last node in its chain. Nothing here '
      + 'reads a particle; the harness reads memory, and what it read is that a MainType-2 node hands its '
      + 'chain on rather than ending it.',
    shape: 'gate', profile: profile(1), color: [0.35, 0.95, 0.75, 1], leadNode: 'timer-emitter',
    watchLiveNode: true, expect: 'dispatch', demonstrated: EMITTER_BATCH,
  },
  {
    id: 'emitter-persistent',
    question: 'The same, in the column an emitter is actually authored in — and the first persistent graph '
      + 'here of more than one node. Emitter, then a Flag wave: the slot came up holding sub-type 13, the '
      + 'Flag, and kept it 18 s rather than a Debounce\'s 3, while the instance status word moved '
      + '0x00a100a3 -> 0x00a101a5 and back, which is the same draw bit every persistent draw-affecting node '
      + 'sets. Three passes of three. The pairing is the whole design: an emitter alone in a persistent '
      + 'graph installs nothing, so "it ran" and "the graph never started" would be one reading — the node '
      + 'behind it is what makes the column legible.',
    shape: 'gate', profile: profile(1), color: [0.2, 0.8, 0.55, 1],
    persistentNode: 'timer-emitter', persistentTailNodes: ['flag'],
    watchLiveNode: true, watchEntityFlags: true, expect: 'dispatch', demonstrated: EMITTER_BATCH,
  },
  {
    id: 'persist-anim-object',
    question: 'A model clip installs even on a model that HAS no clip: sub-type 256 every pass, on an '
      + 'authored panel with no keyframes anywhere in it. The constructor does not refuse, and the prop never '
      + 'translates — so an author who attaches this to the wrong model gets a node that builds, runs and '
      + 'animates nothing, with no error anywhere to tell them.',
    shape: 'gate', profile: profile(1), color: [0.55, 0.85, 0.65, 1], persistentNode: 'anim-object',
    watchEntityPos: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: LIFETIME_BATCH,
  },
  // ---- the two suppression latches -----------------------------------------------------------------
  // Every cell above this point measures something the engine DOES. These seven measure something it stops
  // doing, which is the only shape a latch claim can take: columns 3 and 4 name no chain worth running —
  // the engine tests the column for populated-ness and skips the default teardown when it finds one
  // [Trailmap: 150-logic §slot-columns]. So there is no value to read and no timestamp to catch, and each
  // cell only means anything beside its control: same chain, one field uphill, column empty.
  //
  // The pairing is also what carried the finding. WHICH latch an effect needs is decided by how its node
  // ends rather than by what the effect does, and a batch that had tried only the obvious-sounding column
  // would have concluded the opposite of the truth.
  {
    id: 'latch-persist-control',
    question: 'CONTROL for the cell below. A persistent flag-wave with both latch columns empty: the node '
      + 'installs ahead of the rider and the slot EMPTIES 17.6-17.9 s later when that stretch of mountain '
      + 'deactivates behind them, putting the instance flag word back to its rest value. That teardown is '
      + 'the thing the next cell suppresses.',
    shape: 'gate', profile: profile(1), color: [0.9, 0.4, 0.6, 1], persistentNode: 'flag',
    watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', expectSlot: { atLeast: 1 }, demonstrated: LATCH_BATCH,
  },
  {
    id: 'latch-persist-region',
    question: 'The region-exit latch WORKS, and one empty graph in column 3 is the whole of it. Identical '
      + 'flag-wave, identical everything else: this slot never empties for the rest of the run, where the '
      + 'control\'s lets go at 17.6 s, three passes of three. The flag word settles one bit away from the '
      + 'control\'s too — the node keeps the draw bit it set and only the region-active bit clears — which '
      + 'is the spec\'s "keeps its node and its current pose" read off the instance.',
    shape: 'gate', profile: profile(1), color: [0.95, 0.55, 0.75, 1], persistentNode: 'flag',
    latches: ['slot3'], watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', expectSlot: { atMost: 0 }, demonstrated: LATCH_BATCH,
  },
  {
    id: 'latch-kill-control',
    question: 'CONTROL for the two kill cells below, and a restatement of what a bare breakable does: the '
      + 'prop leaves the drawn state when the node is built and is put BACK when the node goes, 8.8-9.0 s '
      + 'later. A breakable that unbreaks itself is the problem the next two cells are shopping for a fix to.',
    shape: 'gate', profile: profile(1), color: [0.55, 0.55, 0.6, 1], extraNode: 'breakable-kill',
    watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', expectSlot: { atLeast: 1 }, demonstrated: LATCH_BATCH,
  },
  {
    id: 'latch-kill-end',
    question: 'The effect-end latch does NOTHING for a breakable kill, and that negative is half the finding. '
      + 'Column 4 populated, and the cell behaves exactly like the control above: node built, prop hidden, '
      + 'node torn down, prop drawn again, three passes of three. Column 4 is consulted when a node reaches '
      + 'its OWN end and asks to retire, and a kill\'s tombstone never does — so the column is never read. '
      + 'The obvious-sounding latch is the wrong one here.',
    shape: 'gate', profile: profile(1), color: [0.45, 0.45, 0.5, 1], extraNode: 'breakable-kill',
    latches: ['slot4'], watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', expectSlot: { atLeast: 1 }, demonstrated: LATCH_BATCH,
  },
  {
    id: 'latch-kill-region',
    question: 'And this is the one that keeps a prop broken. Same kill, column 3 instead: the slot never '
      + 'empties and the instance is still in the undrawn state at the end of the run, where both cells '
      + 'above are drawn again — three passes, byte-identical. What ends a kill is its region unloading '
      + 'rather than the node retiring, so suppressing THAT teardown is what makes the break permanent. '
      + 'This pairing is the `breakable-permanent` recipe.',
    shape: 'gate', profile: profile(1), color: [0.65, 0.6, 0.55, 1], extraNode: 'breakable-kill',
    latches: ['slot3'], watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', expectSlot: { atMost: 0 }, demonstrated: LATCH_BATCH,
  },
  {
    id: 'latch-flip-control',
    question: 'CONTROL for the cell below, and the fixture\'s only node that reliably ends ITSELF: the '
      + 'proven ride-over button, whose flip is a pulse because of its authored Length. Three separate nodes '
      + 'are built and released over 2.6 s, each living 0.47-0.50 s — the authored half second, measured.',
    shape: 'gate', profile: profile(1), color: [1, 0.08, 0.08, 1], recipe: 'ride-over-button',
    needsFlipbook: true, watchLiveNode: true,
    expect: 'dispatch', expectSlot: { atLeast: 2 }, expectPaint: true, demonstrated: LATCH_BATCH,
  },
  {
    id: 'latch-flip-end',
    question: 'The effect-end latch WORKS, on the node that actually takes that path. Same button, column 4 '
      + 'populated: ONE node per crossing instead of three, holding the slot for 10.6-11.0 s instead of half '
      + 'a second — kept alive at its end instead of destructing, which is what the column is documented to '
      + 'do. Read against `latch-kill-end` above, the pair says the column is real and only reaches effects '
      + 'that finish on their own. This cell deliberately claims nothing about the slot COUNT, and that is a '
      + 'correction: the claim is per crossing, the harness counts per run, and a region that reactivates '
      + 'long after the rider has gone adds a whole second cycle. It did exactly that in one gold pass of '
      + 'three — same node, same 10.2 s life, two cycles instead of one — and a bar tight enough to be worth '
      + 'setting was a bar fitted to how long the bench course happened to be. The control above keeps its '
      + 'bar because cycling can only ADD pulses to it, never take them away.',
    shape: 'gate', profile: profile(1), color: [1, 0.35, 0.15, 1], recipe: 'ride-over-button',
    needsFlipbook: true, latches: ['slot4'], watchLiveNode: true,
    expect: 'dispatch', expectPaint: true, demonstrated: LATCH_BATCH,
  },
  // ---- bound-node control, read off the receiver's own state -----------------------------------------
  // These four commands were authorable and ungradeable for the whole life of the fixture: a MainType-3
  // message writes nothing on the entity, so a cell could report the receiver was BUILT and stop there. The
  // receivers' control methods were read out of the ELF and each keeps its state at a fixed offset on the
  // node [Trailmap: 150-logic §control-state], which is what these watch.
  //
  // Each is the shape the proven button already uses: RECEIVER immediately ahead of the command in one
  // chain. The factory drops a live node of a different sub-type before building, so the receiver seizes
  // the slot from the leading debounce, and the command then resolves to whatever is installed — which is
  // now the receiver. Anything between them that takes the slot redirects the message, silently.
  {
    id: 'ctl-uv-phase',
    question: 'Set UV phase reaches a UV-scroll receiver, and the receiver is genuinely SCROLLING while it '
      + 'does. The node builds from this collision chain (sub-type 10, which retail only ever authors '
      + 'persistently), its rate word reads back the authored -0.02 exactly, its U phase advances every '
      + 'sample — and its V phase holds both values the chain writes, 2.5 and then -3.0 a Wait later, three '
      + 'passes of three. Two arbitrary numbers turning up where the chain asked for them is not something '
      + 'drift or a default produces.',
    shape: 'gate', profile: profile(1), color: [0.25, 0.6, 1, 1],
    extraNode: 'uv-scroll', tailNodes: ['material-uv-offset', 'wait', 'material-uv-offset'],
    tuneTail: (payload, id, index) => {
      if (id === 'material-uv-offset') (payload.type3 as Record<string, unknown>).U1 = index === 0 ? 2.5 : -3;
    },
    nodeWatch: UV_SCROLL_STATE_WATCH, watchLiveNode: true,
    expect: 'dispatch', demonstrated: LATCH_BATCH,
  },
  {
    id: 'ctl-counter-mark',
    question: 'A counter COUNTS, and one 32-bit read carries both halves of its state. A two-input counter '
      + 'goes to "input 1 marked, one to go" on contact and "inputs 1 and 2 marked, none to go" a Wait later '
      + '— so a mark sets its own bit AND steps the count down, which the disassembly says is one operation '
      + 'and this walks end to end. The node then lives exactly 1.02-1.08 s, which is that Wait: a counter '
      + 'reaching zero fires its slot\'s trigger column and retires, so its own lifetime IS the elapse.',
    shape: 'gate', profile: profile(1), color: [0.75, 0.7, 0.35, 1],
    extraNode: 'counter', tailNodes: ['counter-mark', 'wait', 'counter-mark'],
    tuneTail: (payload, id, index) => {
      if (id === 'counter-mark') (payload.type3 as Record<string, unknown>).U1 = index === 0 ? 1 : 2;
    },
    nodeWatch: COUNTER_STATE_WATCH, watchLiveNode: true,
    expect: 'dispatch', demonstrated: LATCH_BATCH,
  },
  {
    id: 'ctl-counter-decrement',
    question: 'The other counter command, on the same word, and the contrast is the point: this one reads '
      + '"one to go, NOTHING marked" where the cell above reads "input 1 marked, one to go". A decrement '
      + 'steps the count without bookkeeping about which input arrived, which is what separates counting '
      + 'occurrences from collecting distinct switches.',
    shape: 'gate', profile: profile(1), color: [0.85, 0.6, 0.25, 1],
    extraNode: 'counter', tailNodes: ['counter-decrement', 'wait', 'counter-decrement'],
    nodeWatch: COUNTER_STATE_WATCH, watchLiveNode: true,
    expect: 'dispatch', demonstrated: LATCH_BATCH,
  },
  {
    id: 'ctl-anim-budget',
    question: 'Grant clip budget lands AND is spent. The receiver stores seconds and the command divides the '
      + 'authored frame count by the engine\'s 30 fps timebase, so 30 frames arrives as exactly 1.000 s — '
      + 'and that second then drains smoothly to zero over the following second before the chain grants it '
      + 'again, every pass. A budget being consumed in real time is the gate this node exists to be, which '
      + 'no reading of the command alone could have shown.',
    shape: 'gate', profile: profile(1), color: [0.55, 0.85, 0.65, 1],
    extraNode: 'anim-delta', tailNodes: ['anim-delta-grant', 'wait', 'anim-delta-grant'],
    nodeWatch: ANIM_DELTA_STATE_WATCH, watchLiveNode: true,
    expect: 'dispatch', demonstrated: LATCH_BATCH,
  },
  // ---- the deferred column, and the one payload that is safe in it ---------------------------------
  // The trigger column is the odd circumstance out: nothing outside the effects runtime can reach it. It is
  // a continuation, scheduled by a runtime node another column installed when that node's own condition
  // elapses [Trailmap: 150-logic §deferred-trigger], and the one installer an author can lay down is a
  // Counter — whose update, on reaching zero, resolves the trigger column of its OWN slot and runs it.
  //
  // Two payloads were tried here first and both HUNG THE EMULATOR within a second, reproducibly: a breakable
  // kill and then an ordinary flipbook. The second is what named the mechanism, because it rules out the
  // DeadNode opcode — what the two share is that they INSTALL A NODE ON THIS INSTANCE, and the column runs
  // while the counter is inside the update that is firing it. The chain drops the thing running it.
  //
  // Retail is the corroboration, and it is unusually clean: MERQUER slot 345 is the ONLY counter-fired
  // trigger column in the twelve-level corpus and it carries exactly one node, a MainType-7 hop. Megaplex's
  // twenty column-5 chains do carry a DeadNode and every one is fired by a Cracked node instead.
  {
    id: 'trig-counter-control',
    question: 'CONTROL for the two below: a one-input Counter, a Wait, and the mark that empties it, with '
      + 'the trigger column left EMPTY. The counter builds, counts, and releases the instance about a second '
      + 'later, and nothing else happens — no draw change, no flag. Without it the cells below would only '
      + 'show that something happened near a counter, which the collision chain is also standing next to.',
    shape: 'gate', profile: profile(1), color: [0.5, 0.5, 0.5, 1],
    extraNode: 'counter', tuneExtra: payload => {
      (payload.type0 as { Counter: Record<string, unknown> }).Counter.Count = 1;
    },
    tailNodes: ['wait', 'counter-mark'],
    nodeWatch: COUNTER_STATE_WATCH, watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: TRIGGER_BATCH,
  },
  {
    id: 'trig-counter-flag',
    question: 'A bound-node command in the trigger column reaches NOBODY, and the negative is worth as much '
      + 'as the cell below. Same schedule, a Set-instance-flag in the column: bit 0x0800 never appears, on '
      + 'any pass — while the identical command in a COLLISION chain sets it every time (`flag-set`). The '
      + 'column did run; the message had nothing to address. A deferred chain runs a beat after the counter '
      + 'that scheduled it has retired and let the instance go, so put the effect itself here rather than a '
      + 'message aimed at one.',
    shape: 'gate', profile: profile(1), color: [0.35, 0.9, 0.45, 1],
    extraNode: 'counter', tuneExtra: payload => {
      (payload.type0 as { Counter: Record<string, unknown> }).Counter.Count = 1;
    },
    tailNodes: ['wait', 'counter-mark'], triggerNodes: ['instance-flag-set'],
    nodeWatch: COUNTER_STATE_WATCH, watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: TRIGGER_BATCH,
  },
  {
    id: 'trig-counter-hop',
    question: 'THE TRIGGER CIRCUMSTANCE RUNS — the last authorable column that had never been demonstrated. '
      + 'Contact builds a one-input Counter, a Wait holds a second, the mark empties it, and that counter\'s '
      + 'own update fires column 5. What the column carries is retail\'s own answer: a MainType-7 hop, the '
      + 'only payload that does not install on the counter it would be pulling out from under. The claim is '
      + 'read off the COMPANION beside this cell, not off this one.',
    shape: 'gate', profile: profile(1), color: [0.6, 0.45, 0.95, 1],
    extraNode: 'counter', tuneExtra: payload => {
      (payload.type0 as { Counter: Record<string, unknown> }).Counter.Count = 1;
    },
    tailNodes: ['wait', 'counter-mark'], triggerNodes: ['act-on-instance'], companion: 'debounce',
    nodeWatch: COUNTER_STATE_WATCH, watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: TRIGGER_BATCH,
  },
  // ---- the flip, asked so the answer can only be the command ---------------------------------------
  // A pair, and the pair is the whole proof. `material-texture-frame` sat unbadged through four batches for
  // a reason that is easy to miss: the only cell carrying it was the ride-over button, whose flip has a
  // Speed of its own, so an applied frame moving 0 -> 1 there is explained just as well by the node cycling
  // as by any message. Authoring the receiver at SPEED 0 removes the alternative — a flip that cannot cycle
  // has nothing to move its frame except a command — and the control below is what turns that from an
  // argument into a reading.
  {
    id: 'flip-frame-command',
    question: 'Set texture frame SELECTS a frame. The receiver is a flipbook authored at Speed 0, a node '
      + 'with no clock of its own, and it sits on frame 1 — the frame this chain names — for the whole of '
      + 'its life, three passes of three. Read against the control below, which is the identical node '
      + 'without the command and rests at frame 0.',
    shape: 'gate', profile: profile(1), color: [1, 0.5, 0.1, 1],
    extraNode: 'texture-flip', tuneExtra: payload => {
      const flip = (payload.type0 as { TextureFlip: Record<string, unknown> }).TextureFlip;
      Object.assign(flip, { Speed: 0, Length: 0 });
    },
    tailNodes: ['material-texture-frame'], needsFlipbook: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: FLIP_BATCH,
  },
  {
    id: 'flip-frame-control',
    question: 'CONTROL for the cell above, and the reason that cell is a proof rather than a coincidence. '
      + 'The same Speed-0 flipbook with nothing addressing it rests at frame 0 in every pass. A commanded '
      + 'cell reading frame 1 means nothing until this one has been read: a resting frame of 1 would have '
      + 'looked identical, and no amount of repetition would have separated them.',
    shape: 'gate', profile: profile(1), color: [0.7, 0.4, 0.2, 1],
    extraNode: 'texture-flip', tuneExtra: payload => {
      const flip = (payload.type0 as { TextureFlip: Record<string, unknown> }).TextureFlip;
      Object.assign(flip, { Speed: 0, Length: 0 });
    },
    needsFlipbook: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: FLIP_BATCH,
  },
  {
    id: 'flip-dwell',
    question: 'The dwell screen is a flipbook with a different CLOCK, and the clock is the whole evidence — '
      + 'there is no value here a plain flip does not also hold. Frame 1 is flashed for 0.084-0.116 s, a '
      + 'fixed tenth of a second, and frame 0 held between flashes for 1.22-3.23 s, differing run to run, '
      + 'which is the randomization the node is named for. A plain flipbook at Speed 3.5 changes about every '
      + '0.3 s and spends equal time on each frame.',
    shape: 'gate', profile: profile(1), color: [0.95, 0.85, 0.4, 1],
    persistentNode: 'texture-flip-dwell', needsFlipbook: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: FLIP_BATCH,
  },
  // ---- the first authored spline mover, and the proof that it runs ---------------------------------
  // The HOST cannot show motion and never could: a mover keeps one pose per copy in a separate buffer rebuilt
  // each tick from the spline, and the class touches its instance's translation only in the constructor
  // [Trailmap: 230-level-ssf §splinemover]. The word that caught the roller doing nothing reports a working
  // mover as dead. The NODE shows it — its update advances a distance-along-route word every tick — but the
  // node is not reachable from the instance either, so the first cell finds it in the heap by the pointer it
  // holds back to its host and watches that word. It advances at the authored rate and wraps at the route's
  // end, which is the whole mover class proven on one cell.
  {
    id: 'spline-mover',
    question: 'An authored spline mover SURVIVES, which was the open question — without the packer\'s '
      + 'preamble the payload reaches RAM and no mover allocation lives past the frame. Its host holds the '
      + 'shape every retail mover runs inside: the slot fills a few seconds ahead of the rider and never '
      + 'lets go. The host itself never moves, and that is correct rather than a failure — the copies are '
      + 'drawn elsewhere. And it MOVES: the mover is not reachable from its host at all — its distance word '
      + 'is at neither offset off the slot pointer, because the object in the slot is not the mover — so it '
      + 'is found in the heap by the pointer it holds back to this instance. One candidate of four advances, '
      + 'at 2000.3 units a second against the 2000.0 its authored 33.3333 a tick implies at 60 Hz, wrapping '
      + 'to near zero on reaching the route\'s 12715.7 end. Needs a window bounded short of the finish; a '
      + 'full-length pass reports SEARCH SKIPPED, which is correct rather than a regression.',
    shape: 'gate', profile: profile(1), color: [0.4, 0.7, 1, 1],
    persistentNode: 'spline-animation',
    nodeWatch: SPLINE_TRAVEL_WATCH, lateWatch: SPLINE_MOVER_LATE_WATCH,
    watchEntityFlags: true, watchEntityPos: true, watchLiveNode: true,
    expect: 'dispatch', expectSlot: { atMost: 0 }, demonstrated: FLIP_BATCH,
  },
  {
    id: 'spline-mover-halt',
    question: 'A mover\'s own prop CANNOT ALSO BE A TRIGGER, and this cell is how that was found. It carries '
      + 'the identical Wait-then-set-instance-flag chain as `flag-set-plain` below, and the bit never '
      + 'appears — not once in three passes — where the plain prop gets it every time. The mover\'s packed '
      + 'source reads undrawn from the first sample: the engine draws copies and hides the original, so '
      + 'there is nothing there to hit. Put the contact on a second placement and reach the mover with '
      + 'Run-on-another-instance.',
    shape: 'gate', profile: profile(1), color: [0.3, 0.5, 0.95, 1],
    persistentNode: 'spline-animation',
    tailNodes: ['wait', 'instance-flag-set'],
    watchEntityFlags: true, watchEntityPos: true, watchLiveNode: true,
    expect: 'dispatch', expectSlot: { atMost: 0 }, demonstrated: FLIP_BATCH,
  },
  {
    id: 'flag-set-plain',
    question: 'CONTROL for the cell above: the same chain on an ordinary prop, where bit 0x0800 appears in '
      + 'every pass. Without it, a mover host that never gains the bit would read as a broken command '
      + 'rather than as a prop nothing can touch — and the bit matters more than it used to, because a '
      + 'spline mover destroys itself the frame it finds this set on its host.',
    shape: 'gate', profile: profile(1), color: [0.45, 0.85, 0.55, 1],
    tailNodes: ['wait', 'instance-flag-set'],
    watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: FLIP_BATCH,
  },
  // ---- does a model clip actually PLAY -------------------------------------------------------------
  // Every cell above that touches a model clip is built on an authored panel: four flat vertices with no
  // animation data anywhere in it. `persist-anim-object` showed the node installs and runs quite happily on
  // one, moving nothing and reporting nothing — a finding, but the opposite of a demonstration. These carry
  // a model with a REAL clip and read the node's own clock rather than the host: a mover's position lives
  // elsewhere, but a clip's TIME is on the node.
  //
  // The model is an imported `SnowGun_9` rather than a retail donor, and that is the whole correction these
  // cells embody. They rode GARI's trick gem for a long time on the strength of it being the one model in
  // the level with keyframes — which it is, in the DONOR. What reaches the runtime through the borrow path
  // has a play window of zero, and a zero window is invisible from the clock alone: the wrap arithmetic
  // degenerates to the identity, so a looping clip free-runs forever and a play-once clip clamps to nothing
  // on tick one. Only the imported catalogue carries `clipFrames` to the disc verbatim [see CLIP_PROP_MODEL].
  //
  // So the claim is no longer "a word advances" — a word advances either way. It is the WINDOW, which every
  // clip cell now reads on its first sample, and the clock RETURNING to the start of it.
  //
  // `demonstrated` on these three still points at CLIP_BATCH, which is honest and worth being exact about:
  // what that batch settled is the dispatch and slot behaviour each one asserts, and neither depends on the
  // model. The clip readings in it were all taken on the gem. Only `clip-real-keyframes` has ridden this
  // model (run 20260807-200722, one pass), so nothing here claims a keyframed demonstration yet.
  //
  // All four are PERSISTENT, which removes contact from the question entirely — they install ahead of the
  // rider and are judged on what the clock does, not on whether the prop can be hit.
  {
    id: 'clip-flat-control',
    question: 'CONTROL, and the one that makes the others mean something: the same model-clip node on the '
      + 'fixture\'s own flat panel, which has no keyframes at all. It should report a play window of 0 and '
      + 'zero animated records — and its clock should advance anyway, because a wrapping clip with nothing '
      + 'to wrap around free-runs at one second per second. That pairing IS the lesson: a clip cell judged '
      + 'on an advancing clock would call this one a success.',
    shape: 'gate', profile: profile(1), color: [0.55, 0.85, 0.65, 1],
    persistentNode: 'anim-object', nodeWatch: ANIM_CLIP_WATCH, watchLiveNode: true,
    expect: 'dispatch', demonstrated: CLIP_BATCH,
  },
  {
    id: 'clip-model-loops',
    question: 'Does a model clip PLAY? A wrapping model-clip node on an imported model carrying 40 authored '
      + 'frames. The claim is categorical rather than a number to judge: the window reads 1.3333 s where the '
      + 'flat-panel control reads 0, and the clock RETURNS to the window start instead of counting past it. '
      + 'A free-running clock proves nothing on its own — the control free-runs too.',
    shape: 'clip', profile: profile(1), color: [1, 1, 1, 1], liftM: 2, contactOptional: true,
    persistentNode: 'anim-object', nodeWatch: ANIM_CLIP_WATCH,
    watchEntityPos: true, watchLiveNode: true,
    expect: 'dispatch', demonstrated: CLIP_BATCH,
  },
  {
    id: 'clip-once-plain',
    question: 'A PLAY-ONCE clip on the same imported model, with no latch. The engine clamps a loop-mode-0 '
      + 'clip at its window end, sets the node\'s finished flag, and asks the node to retire — so the clock '
      + 'should advance, stop AT 1.3333, and the slot let go. On the trick gem this cell used to ride, the '
      + 'window ended at 0 and the clock read exactly 0.0 in every pass ever recorded: the node still ended '
      + 'and the slot still released, so the latch below stayed readable, but nothing about a clip PLAYING '
      + 'was ever in the reading.',
    shape: 'clip', profile: profile(1), color: [0.9, 0.7, 0.2, 1], liftM: 2, contactOptional: true,
    persistentNode: 'anim-object',
    tunePersistent: payload => {
      (payload.type0 as { type0Sub256: Record<string, unknown> }).type0Sub256.U0 = 0;
    },
    nodeWatch: ANIM_CLIP_WATCH, watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', expectSlot: { atLeast: 1 }, demonstrated: CLIP_BATCH,
  },
  {
    id: 'clip-once-latched',
    question: 'The iris door, which is the spec\'s own worked example: the identical play-once clip plus '
      + 'both latch columns. If column 4 does what it is documented to do the node is kept alive at its end '
      + 'instead of destructing — same clock, stopped at the same final value, but a slot that never lets go '
      + 'where the cell above releases it. The latch half of this was settled on a zero-length clip, where '
      + 'the end arrives on tick one; on a model with a real 1.3333 s window it is the same assertion about '
      + 'a clip that took time to get there.',
    shape: 'clip', profile: profile(1), color: [0.95, 0.55, 0.75, 1], liftM: 2, contactOptional: true,
    persistentNode: 'anim-object',
    tunePersistent: payload => {
      (payload.type0 as { type0Sub256: Record<string, unknown> }).type0Sub256.U0 = 0;
    },
    latches: ['slot3', 'slot4'],
    nodeWatch: ANIM_CLIP_WATCH, watchEntityFlags: true, watchLiveNode: true,
    expect: 'dispatch', expectSlot: { atMost: 0 }, demonstrated: CLIP_BATCH,
  },
  {
    id: 'hop-remote',
    question: 'Can an authored chain act on a DIFFERENT object? This is retail\'s own button shape — the '
      + 'thing you ride over and the thing that reacts are two instances joined by a MainType-7 hop — and '
      + 'until now the repack compiler refused any graph that named the instance table, so no authored level '
      + 'could express it. The companion beside this gate carries no chain and is never touched; a node on '
      + 'ITS slot can only have arrived through the hop.',
    shape: 'gate', profile: profile(1), color: [0.1, 0.95, 0.85, 1],
    leadNode: 'act-on-instance', companion: 'debounce',
    expect: 'dispatch', demonstrated: GATE_BATCH,
  },
  {
    id: 'cracked-pad',
    question: 'A Cracked surface FIRES its slot\'s deferred-trigger column when its strength runs out — the '
      + 'first authored use of that column by anything other than a Counter, and the half of the two-stage '
      + 'break that is not the crack. Retail\'s own pane payload (lifetime -1, strength 5) on a flat panel '
      + 'ridden over, and the claim is read off the COMPANION: a prop with no chain of its own that the '
      + 'rider never approaches, whose slot a node can only have reached through the crack giving way.',
    shape: 'pad', profile: profile(1), color: [0.85, 0.95, 1, 1],
    extraNode: 'cracked', triggerNodes: ['act-on-instance'], companion: 'debounce',
    nodeWatch: CRACKED_STATE_WATCH, watchLiveNode: true, watchEntityFlags: true,
    expect: 'dispatch', demonstrated: CRACKED_BATCH,
  },
  // The pair that says the STRENGTH is the gate, and the reason they graduated together: each is the other's
  // control, and either alone is worth nothing. A cracked surface that fires its column proves the mechanism
  // exists; a byte-identical one that never fires because its pool cannot be spent is what proves the pool
  // is what decides. Both grade their COMPANION rather than themselves — the host dispatches either way,
  // since ordinary contact builds the Cracked node whatever its strength — which is exactly the shape
  // `companionExpect` exists for.
  //
  // THEY LAND NEAR THE END OF A COURSE THAT IS ALREADY TOO LONG, and that is the cost of graduating them: at
  // 5.90 and 5.99 km they sit right at the ~5.9 km a race pass reaches, so expect them to report
  // `inconclusive` about as often as they report a pass. The catalogue was over its budget before this pair
  // arrived (its last cell was already at 6.17 km) and they add 180 m to that. Graduate sparingly until the
  // budget is dealt with — every cell added here costs reach at the bottom, where the cells are just as
  // graded as the ones being added.
  {
    id: 'cracked-shatters',
    question: 'A Cracked surface FIRES its slot\'s trigger column when its pool runs out. Strength 0.1, low '
      + 'enough that any contact exhausts it, hopping onto a companion 130 m off the line that carries no '
      + 'chain and that the rider never approaches — so a node in that slot has exactly one possible sender. '
      + 'It arrived in every pass of three. A bound-node command was the obvious payload and would have been '
      + 'unreadable: the Cracked node is what a column-5 chain addresses, and its control method answers to '
      + 'the lifetime and the strength only, so every other command is dropped without a trace and a column '
      + 'that fired perfectly would read as one that never ran.',
    shape: 'volume', profile: profile(1), color: [0.95, 0.35, 0.45, 1], sizeM: CRACKED_BOX_M,
    extraNode: 'cracked', tuneExtra: payload => {
      (payload.type0 as { type0Sub14: Record<string, unknown> }).type0Sub14.U1 = 0.1;
    },
    triggerNodes: ['act-on-instance'], companion: 'debounce',
    nodeWatch: CRACKED_STATE_WATCH, watchLiveNode: true, watchEntityFlags: true,
    expect: 'dispatch', demonstrated: CRACKED_BATCH,
  },
  {
    id: 'cracked-tough',
    question: 'The same chain, the same trigger column and the same companion at strength 1000, which a '
      + 'crossing cannot spend — and the companion stayed EMPTY in every pass of three where its twin above '
      + 'picked up a node in every one. That is what makes the pair a reading rather than an observation: '
      + 'the column is fired by the surface giving way and by nothing else, so the strength is the gate. '
      + 'This cell grades its companion at no-dispatch while grading itself at dispatch, because ordinary '
      + 'contact still builds the Cracked node here; only the deferred half is suppressed.',
    shape: 'volume', profile: profile(1), color: [0.35, 0.45, 0.6, 1], sizeM: CRACKED_BOX_M,
    extraNode: 'cracked', tuneExtra: payload => {
      (payload.type0 as { type0Sub14: Record<string, unknown> }).type0Sub14.U1 = 1000;
    },
    triggerNodes: ['act-on-instance'], companion: 'debounce', companionExpect: 'no-dispatch',
    nodeWatch: CRACKED_STATE_WATCH, watchLiveNode: true, watchEntityFlags: true,
    expect: 'dispatch', demonstrated: CRACKED_BATCH,
  },
  {
    id: 'button-no-debounce',
    question: 'The button\'s leading Debounce does NOTHING in a directly-attached chain: without it the cell '
      + 'behaves identically to the full recipe — sub-type 11 node, applied frame moving 0 to 1. The flip '
      + 'destroys the debounce one dispatch later, so the flip\'s own Length is the real gate.',
    shape: 'gate', profile: profile(1), color: [1, 0.5, 0.1, 1], recipe: 'button-no-debounce',
    needsFlipbook: true, expect: 'dispatch', expectPaint: true, demonstrated: 'run 20260806-062643',
  },
  {
    id: 'button-flip',
    question: 'A ride-over button WORKS end to end on hardware: the chain dispatches, a texture-flip node is '
      + 'built (sub-type 11) and its applied frame moves between 0 and 1 with one material and two frames '
      + 'captured. This is the cell that proves authored buttons are supported.',
    shape: 'gate', profile: profile(1), color: [1, 0.08, 0.08, 1], recipe: 'ride-over-button', needsFlipbook: true,
    expect: 'dispatch', expectPaint: true, demonstrated: 'run 20260806-061609',
  },
  // LAST, and it has to be. This is the only cell that throws the rider into the air, and a launched rider
  // arrives at whatever follows both airborne and climbing — which cost the lap-boost cell above three false
  // REGRESSIONs when it sat one field downstream of this one and was credited with this node's lift. The
  // measurement now bounds itself by proximity as well as time, so the mis-attribution cannot recur; putting
  // the launcher at the bottom of the course means it never has to be relied on.
  {
    id: 'boost-up-lifts',
    question: 'A directional boost really MOVES the rider, which no dispatch reading could have shown. Retail '
      + 'exhaust-vent tuning — straight up, rate 5, target 25 m/s — in a box deep enough to hold the rider '
      + 'for around 90 ticks, because rider selection is a containment test re-run every frame and a thin '
      + 'panel offers one or two ticks of push. The rider goes from descending at 7.5 m/s to climbing, and '
      + 'the climb is the fastest it rises anywhere on the course in every pass.',
    shape: 'volume', profile: profile(1), color: [1, 0.75, 0.1, 1], sizeM: BOOST_BOX_M,
    extraNode: 'directional-boost',
    tuneExtra: payload => {
      const boost = (payload.type0 as { Boost: Record<string, unknown> }).Boost;
      Object.assign(boost, { Mode: 1, U1: 0, U2: 5, BoostAmount: 25, BoostDir: { X: 0, Y: 0, Z: 1 } });
    },
    // The threshold grades "a push happened", not a magnitude, and the difference matters. Across six passes
    // the attributed rise ran 2.4 to 13.7 m/s — the node pushes every time, but how hard depends on how
    // squarely the rider crosses a 40 m box, and a bar set near the top of that range failed a pass that was
    // not a failure. The course's own noise floor is the answer to where the bar goes: every cell without a
    // boost reports a rise around -7.5, and the largest positive reading anywhere else on the course is 0.8,
    // from a landing. 1.5 clears that and sits under every push ever measured here.
    expect: 'dispatch', expectRider: [{ signal: 'rise', atLeast: 1.5 }], demonstrated: SPEED_SWEEP,
  },
  {
    id: 'rider-reset',
    question: 'A reset zone dispatches, every pass — and this cell deliberately claims NOTHING about the '
      + 'rider, which is a correction rather than a gap. The node carries whoever it catches back onto the '
      + 'course line, so the distance it moves them is how far OFF that line they already were: 2975-2983 m '
      + 'on the short bench course where the run had sailed past the end into nothing, and 22-25 m here. That '
      + 'second number was never this cell\'s to claim. It was the rider still being airborne from the boost '
      + 'launcher one field above, and when the course grew from 2690 m to 3950 m they began landing first — '
      + 'so the same node, unchanged, moved them 22.3 m in one pass of three and about 2 m in the other two. '
      + 'A magnitude that belongs to the cell UPHILL is not a property of this node, and the honest move is to '
      + 'stop asserting it here rather than to lower the bar until it passes. The node\'s own proof is the '
      + 'bench batch, where the rider was thousands of metres off the line and it brought them back. LAST on '
      + 'the course of necessity: it is the one node that sends the rider somewhere else.',
    shape: 'gate', profile: profile(1), color: [1, 0.3, 0.5, 1], extraNode: 'rider-reset',
    expect: 'dispatch', demonstrated: RESET_BATCH,
  },
] as const;

/** One cell of the GOLD course: a catalogue cell, plus what a red row against it actually means. */
interface AutoTestGoldCell {
  /** The `AUTO_TEST_CASES` id this selects. Validated at build time, so a rename cannot silently drop a cell. */
  id: string;
  /** Replaces the catalogue's `question` on this course. The catalogue asks what was being ESTABLISHED, often
   *  against the cell above or below it; GOLD is read after the fact by someone who wants to know what broke,
   *  and half its neighbours are not here. One line, in those terms. */
  regression: string;
}

/**
 * GOLD: the tight regression course, and the one to ride by default.
 *
 * The catalogue above holds every fact hardware has demonstrated, and it has grown past what a regression run
 * should be — 65 cells, 6.1 km, four minutes of riding, and it does not fit in the solo mountain at all (see
 * `AUTO_TEST_FIXTURES`). Most of that length is A/B pairs and controls: machinery for ESTABLISHING a fact,
 * which is not the same machinery as noticing it broke. Once a mechanism is proven, one cell per mechanism
 * detects a regression in it, and the sibling that pinned down its sense is answering a question nobody is
 * asking any more.
 *
 * So this is one cell per mechanism, chosen by two rules:
 *
 *   1. Prefer the cell with the STRONGEST grade in its cluster. A cell graded on the rider or on a painted
 *      frame proves the effect happened; a cell graded on dispatch only proves a node got built. Where a
 *      cluster has both, the stronger one is here and the weaker one is not.
 *   2. Keep both directions of anything that can fail open. A course of nothing but should-fire cells grades
 *      green when the harness has lost the ability to report silence, so the two `no-dispatch` cells are here
 *      to fail if everything starts firing.
 *
 * Nothing is deleted by being left out — the catalogue is still `AUTOTEST1` and still rideable in full. This
 * is a selection over it, so widening or narrowing the regression suite is editing this list.
 */
const AUTO_TEST_GOLD_CELLS: readonly AutoTestGoldCell[] = [
  { id: 'ctl-retail-bag',
    regression: 'The harness control: a retail model whose mode-1 proxy dispatches. A dark row here indicts '
      + 'the ride, the menu prelude or the packer, and nothing below it is worth reading.' },
  { id: 'auth-gate-m1',
    regression: 'An AUTHORED model\'s mode-1 triangle proxy still dispatches — the baseline every authored '
      + 'collision shape in Slopesmith depends on.' },
  { id: 'auth-gate-m2',
    regression: 'Mode-2 instance bounds still dispatch from an authored host. This is the mode every retail '
      + 'trigger volume uses, so a red row here breaks trigger volumes generally.' },
  { id: 'auth-gate-m1-lifted',
    regression: 'NEGATIVE control: a gate lifted clear of the snow must NOT dispatch. This is the row that '
      + 'fails when the harness has stopped being able to report silence — without it, a bug that fires '
      + 'everything reads as a clean sweep.' },
  { id: 'gate-speed-atleast-pass',
    regression: 'The circumstance-gate evaluator still lets a satisfied condition through.' },
  { id: 'gate-speed-atleast-block',
    regression: 'NEGATIVE control, and the other half of the evaluator: an unsatisfied condition still '
      + 'blocks. Paired with the cell above, a gate stuck open or stuck shut shows up as one red row.' },
  { id: 'boost-directional',
    regression: 'A directional boost node still builds on an authored prop carrying the mode it was authored '
      + 'with.' },
  { id: 'lap-boost',
    regression: 'RIDER-GRADED: a speed pad still moves the player. Graded on the boarder\'s own request '
      + 'field rather than on dispatch, so a node that builds correctly and pushes nobody fails here.' },
  { id: 'flip-suppressed-by-kill',
    regression: 'PAINT-GRADED: a texture flip still paints its applied frame when a breakable-kill leads the '
      + 'chain. Grades the frame the engine actually applied, not the node that was built.' },
  { id: 'debounce-baseline',
    regression: 'The debounce node still builds and re-arms — the timing primitive most authored chains are '
      + 'wired through.' },
  { id: 'dead-tombstone',
    regression: 'DeadNodeMode 2 still leaves its tombstone: the sub-type word moves 2 -> 5 one Wait after '
      + 'contact and the slot never empties again. The one dead-node mode with an observable aftermath.' },
  { id: 'wait-delays-kill',
    regression: 'A Wait still holds a chain across ticks, which is what makes every multi-stage chain in the '
      + 'catalogue mean anything.' },
  { id: 'counter-builds',
    regression: 'A counter node still builds from authored payload.' },
  { id: 'mesh-throw-builds',
    regression: 'A mesh-throw node still builds — the breakable-props path.' },
  { id: 'persist-uv-scroll',
    regression: 'A persistent UV-scroll node still installs. Scrolling materials are authored per level, so '
      + 'this covers the whole texture-animation path.' },
  { id: 'persist-anim-object',
    regression: 'A model clip still installs (sub-type 256) from an authored chain.' },
  { id: 'latch-persist-control',
    regression: 'SLOT-GRADED, and the only row here that proves TEARDOWN: a persistent node fills its slot '
      + 'and the slot empties again when that stretch of mountain deactivates. Everything else on this '
      + 'course that fills a slot is expected to hold it, so a leak would hide without this row.' },
  { id: 'spline-mover',
    regression: 'SLOT-GRADED: an authored spline mover survives past the frame it was built in. This is the '
      + 'cell that fails if the packer\'s mover preamble regresses.' },
  { id: 'clip-once-latched',
    regression: 'SLOT-GRADED: the latch columns still keep a play-once clip alive at its end frame instead '
      + 'of letting it destruct. The spec\'s own iris-door example.' },
  { id: 'hop-remote',
    regression: 'An authored chain still acts on a DIFFERENT instance through a MainType-7 hop. This is the '
      + 'row that fails if the repack compiler goes back to refusing graphs that name the instance table, '
      + 'which would take every authored button with it.' },
  { id: 'button-flip',
    regression: 'PAINT-GRADED, end to end: a ride-over button dispatches, builds a flip node and its applied '
      + 'frame moves. The single row that most closely matches what an author actually builds.' },
  { id: 'cracked-pad',
    regression: 'The deferred-trigger column still fires from something other than a Counter: a Cracked '
      + 'surface carrying retail\'s own payload spends its strength on contact and hops a node onto a '
      + 'companion the rider never touches. Graded on the COMPANION, so the row means the column resolved '
      + 'and ran, not merely that the crack was built. The negative control that gives it its meaning — '
      + 'the same chain at a strength no pass can spend — rides the catalogue as `cracked-tough` rather '
      + 'than this course, because it needs a volume deeper than GOLD spaces its cells.' },
  { id: 'boost-up-lifts',
    regression: 'RIDER-GRADED: a launcher still moves the player, graded on a position discontinuity. The '
      + 'strongest evidence on the course that an effect reached the rider at all.' },
  // LAST, and it has to be: the reset teleports, so anything below it would be graded on a rider who never
  // rode past it.
  { id: 'rider-reset',
    regression: 'The rider-reset still fires. It runs last because it teleports the player, which is also '
      + 'why nothing can be appended below it.' },
];

/** GOLD's cases: the selection above, resolved against the catalogue and carrying its regression text.
 *
 *  Resolved rather than copied, so the two can never describe different props: a cell edited in the catalogue
 *  is edited here. An id that no longer exists throws at build time rather than quietly shortening the course,
 *  which is the failure mode worth being loud about — a regression suite that silently stops testing something
 *  is worse than one that stops building. */
export const AUTO_TEST_GOLD_CASES: readonly AutoTestCase[] = AUTO_TEST_GOLD_CELLS.map(pick => {
  // Both halves, because GOLD selects from the CATALOGUE and the catalogue is two courses now. Resolving
  // against one of them would silently stop finding whatever moved across the seam.
  const found = [...AUTO_TEST_CASES, ...AUTO_TEST_CASES_B].find(test => test.id === pick.id);
  if (!found) {
    throw new Error(`GOLD selects "${pick.id}", which is not in AUTO_TEST_CASES. Either it was renamed — `
      + 'update the id here — or it was removed, and GOLD needs a different cell for that mechanism.');
  }
  return { ...found, question: pick.regression };
});

/**
 * The bench: cells whose question hardware has NOT yet answered.
 *
 * They are a separate course, and separate on purpose. The catalogue above is the demo — every cell in it is
 * a fact the engine has been shown to hold, so a single REGRESSION there means something changed. Mixing open
 * questions into it costs exactly that: a run comes back with rows that assert nothing, the reader learns to
 * skim past ungraded rows, and the one row that mattered gets skimmed with them. Two courses keep "this is
 * proven" and "this is being measured" from having to be told apart line by line.
 *
 * A cell graduates by being answered here and then rewritten as a graded cell in the gold map.
 */
export const AUTO_TEST_LAB_CASES: readonly AutoTestCase[] = [
  {
    id: 'ctl-retail-bag',
    question: 'Control: the same retail crash bag the gold map leads with. A bench run where this stays dark '
      + 'indicts the harness, so nothing below it is worth reading.',
    shape: 'bag', profile: profile(1), color: [1, 1, 1, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  // ---- the two pad opcodes --------------------------------------------------------------------------
  // Both pads request five-second rider countdowns rather than directly changing velocity. In race-mode
  // measurements they always agreed: three passes wrote and thirty-nine did not. The effect-thread owner
  // observation explains the split; showoff's single rider makes the requests deterministic. The paired
  // semantic watches and null-owner control remain here as executable regression coverage
  // [Trailmap: 360-pads-duration, 360-pads-ownership].
  {
    id: 'speed-pad',
    question: 'A MainType-17 speed pad raises the speed-cap request rather than pushing velocity, and it works. '
      + 'Observed values 5.000, 4.967 and 5.000 show the specified countdown. The request targets the effect '
      + 'thread\'s owner: race passes may select another rider, while single-rider SHOWOFF makes all pad cells '
      + 'write in one pass [Trailmap: 360-pads-duration, 360-pads-ownership].',
    shape: 'gate', profile: profile(1), color: [0.2, 0.75, 1, 1], leadNode: 'speed-boost',
    nodeWatch: PAD_OWNER_WATCH, watchLiveNode: true, watchLowMemory: true,
  },
  {
    id: 'trick-pad',
    question: 'The same for MainType 18 and the trick-window countdown. Across 42 passes this cell and the one above it '
      + 'never once disagreed, which was the clue that broke the question open: whatever gates them is not '
      + 'on either prop. It is the one owner word a prop\'s contact thread hands every opcode in its chain, '
      + 'read directly by `pad-gate` below — so two opcodes on ONE prop cannot split, and two props can. The '
      + 'passes that work carry the arithmetic that makes them unarguable: this cell reads its own 5.000 of '
      + 'trick window while the speed request from the pad above reads 2.100, which is 5.0 less the 2.90 s '
      + 'between the two slots filling, to three figures. Unlike the speed request, a motion-state transition '
      + 'can clear the trick window between frames, which is why the harness oversamples the pair '
      + '[Trailmap: 360-pads-duration, 360-pads-ownership].',
    shape: 'gate', profile: profile(1), color: [0.95, 0.8, 0.2, 1], leadNode: 'trick-boost',
    nodeWatch: PAD_OWNER_WATCH, watchLiveNode: true,
  },
  // ---- the half of the iris door that the persistent cells cannot reach ----------------------------
  // `one-shot-clip` is a COLLISION recipe — ride into the prop, its clip plays once, the latches hold the
  // finished pose. This pair is the recipe's own arrangement rather than an approximation of it: a play-once
  // clip in the collision column with both latch columns populated, and a control one field different.
  //
  // They carry NO persistent chain, and that is the point: the live-node slot filling can then only mean
  // contact. Every gem in this fixture had been read through a persistent install, so whether a gem can be
  // hit at all was genuinely open — and it is the half this cell settled.
  //
  // A GEM TAKES CONTACT, three passes of three, and the node the contact leaves in the slot is sub-type
  // 0x100 — the AnimObject this chain authored, not the Debounce ahead of it. That is rule 1 (the last
  // property node in a chain wins the slot) demonstrated in the collision column rather than inferred from
  // the retail corpus, and it is the first contact any gem in this fixture has ever registered.
  //
  // Unlatched, the same clip built by the same contact fills the slot and lets go again two to four times in
  // the few seconds the rider is on it — build, end, destruct, rebuild. Latched, it fills once and holds. So
  // the node reaches an end and the latch is what keeps it, which is the recipe's claim and the reason the
  // pair exists. The finished flag says the same thing from the other side: it is legible only on the
  // latched cell, because on the other one the node is gone before anything can read it.
  //
  // What the pair does NOT show is a clip of any length, and the clock is why. It reads 0 at every sample,
  // and for a while that looked like a clip refusing to run from a collision chain — the persistent gem
  // beside it advances by 1/60 a tick, so the difference seemed to be the column. It is not the column: it
  // is the model. The borrowed gem's play window reaches the runtime at ZERO however many frames the donor
  // declares, and a play-once clip with an empty window clamps to 0 and ends on its first tick. So 0 is not
  // a misread word, it is the whole clip; and the ~half-second rebuild cadence is the rider re-triggering
  // contact rather than a clip taking half a second to play [see CLIP_PROP_MODEL].
  //
  // These two stay on the gem deliberately. Their question is CONTACT and the latch, both settled here three
  // passes of three, and the gem's hittability is the hard-won part of that — repointing them at an untried
  // model would put a proven reading at risk to answer a question a bench cell can take instead
  // [cell `clip-contact-keyframes`].
  {
    id: 'clip-on-contact',
    question: 'A GEM TAKES CONTACT — settled here, three passes of three, and the first time anything in '
      + 'this fixture asked: every other gem is read through a persistent install that needs no contact at '
      + 'all. The slot fills on the rider arriving and holds sub-type 0x100, the play-once clip this chain '
      + 'authored rather than the Debounce ahead of it, which is the last-property-node-wins rule shown in '
      + 'the collision column instead of inferred from retail. The node also reaches an END and the latch '
      + 'keeps it: the control below, this cell minus its latches, releases and rebuilds two to four times '
      + 'in the seconds the rider is on it where this one fills once and holds. That end is instant rather '
      + 'than the finish of a clip — the borrowed gem\'s play window arrives at 0, which its clock reading '
      + '0.0 throughout is reporting honestly — so what this pair proves is contact, slot ownership and the '
      + 'latch, on a clip with no frames to play.',
    shape: 'gem', profile: profile(2), color: [0.3, 0.9, 0.45, 1], liftM: 2, contactOptional: true,
    tailNodes: ['anim-object'],
    tuneTail: payload => {
      (payload.type0 as { type0Sub256: Record<string, unknown> }).type0Sub256.U0 = 0;
    },
    latches: ['slot3', 'slot4'],
    nodeWatch: ANIM_CLIP_WATCH, watchEntityFlags: true, watchLiveNode: true,
  },
  // The control the cell above needs, and it is one field different: the same play-once clip installed by
  // the same contact on the same model, WITHOUT the latches. A slot that releases here while the latched one
  // holds means the node reached an end and the latch is what kept it, which no single cell can say alone.
  //
  // The clock cannot contribute to that comparison and is not asked to: both cells read 0 throughout because
  // the model's play window is 0, so the end they are splitting on arrives on the first tick.
  {
    id: 'clip-on-contact-plain',
    question: 'CONTROL for the cell above, differing in one field: the same play-once clip, same contact, '
      + 'same model, NO latches. The pair is what makes either readable. A slot that releases here while '
      + 'the latched cell holds means the node reached an end — only a latch keeps a finished node — which '
      + 'is the recipe\'s own claim demonstrated in the column it ships in. Both clocks read 0 throughout '
      + 'and neither is being misread: the borrowed model\'s play window is 0, so there is no clip to time, '
      + 'and the end being compared arrives on the node\'s first tick.',
    shape: 'gem', profile: profile(2), color: [0.2, 0.6, 0.9, 1], liftM: 2, contactOptional: true,
    tailNodes: ['anim-object'],
    tuneTail: payload => {
      (payload.type0 as { type0Sub256: Record<string, unknown> }).type0Sub256.U0 = 0;
    },
    nodeWatch: ANIM_CLIP_WATCH, watchEntityFlags: true, watchLiveNode: true,
  },
  // ---- the iris door reached the way retail reaches its buttons ------------------------------------
  // The recipe's own arrangement puts the clip on the prop you ride into. Retail's buttons do not: the thing
  // you touch and the thing that reacts are two instances joined by a hop, which is what lets a door open
  // when you cross a threshold somewhere else. This cell is that shape carrying a clip — a gate the rider
  // must cross, hopping a play-once clip onto a gem 116 m off the course that nothing else can reach.
  //
  // It is also the cleanest possible read of the clip itself. The companion has no chain of its own and the
  // rider never approaches it, so its slot filling can only be the hop; and unlike the contact cells there
  // is no Debounce ahead of the clip competing for the slot, because the hop's target graph carries exactly
  // one node. Its model is the imported one with real frames, so the clock has a window to be read against.
  {
    id: 'clip-hop',
    question: 'Retail\'s button shape carrying a CLIP: a gate the rider must cross, hopping a play-once '
      + 'model clip onto a prop 116 m off the course that carries 40 authored frames. The companion has no '
      + 'chain of its own and is never touched, so a node on its slot can only have arrived through the hop '
      + '— and its target graph holds exactly one node, so unlike a contact chain there is no Debounce ahead '
      + 'of the clip to take the slot first. That makes it the cleanest reading of a clip anywhere in this '
      + 'fixture: whatever its clock does here, it does without anything else in the way, and the window '
      + 'beside the clock says the clip is real. This is also the arrangement an author needs for a door, '
      + 'since a door is rarely the thing you ride into.',
    shape: 'gate', profile: profile(1), color: [0.85, 0.35, 0.9, 1],
    leadNode: 'act-on-instance', companion: 'anim-object', companionShape: 'clip',
    tuneCompanion: payload => {
      (payload.type0 as { type0Sub256: Record<string, unknown> }).type0Sub256.U0 = 0;
    },
    companionWatch: ANIM_CLIP_WATCH,
    watchLiveNode: true,
  },
  // ---- the scoring family, which was declared untestable and no longer is ---------------------------
  // Four opcodes — main types 6 and 15 (boost-meter fill), 14 (the gem multiplier) and 16 (the time bonus) —
  // open with the same two compares against `GameModeGlobal` and return early unless it holds 3 or 5
  // [Trailmap: 390-pickups-and-race §gem-mode-gate]. For as long as this harness mashed CROSS through the
  // front end it took the default, which is RACE (mode 2), so all four were gated out however cleanly their
  // chains dispatched, and both the fixture and the Slopesmith template said so in as many words.
  //
  // That is no longer the situation and the standing text was simply stale. The menu prelude steers to
  // SHOWOFF, `--mode` refuses to measure a pass that landed anywhere else, and the bench declares
  // `mode: 'showoff'` — so `GameModeGlobal` is 3 on every pass of this course and the gate is open.
  //
  // Only ONE of the four can be authored, and that is worth stating rather than leaving as a puzzle. Main
  // types 6, 15 and 16 have no branch in the SSF reader OR the writer (`SSFHandler.LoadEffectData` returns
  // null on an unknown main type), so a document carrying one cannot round-trip, let alone pack. Main 14 is
  // fully supported — one float, `MultiplierScore` — which makes it the whole of the family's reachable half
  // and the cell below the whole of what a run can say about the mode gate.
  //
  // The observable is the active score multiplier, which takes the greater of its current and authored values
  // [Trailmap: 390-gems]. Do NOT read the pickup chime instead: the chime sits
  // AFTER the two paths rejoin, outside the gate, so a gem in the wrong mode is fully audible and completely
  // inert — the exact reading this cell exists to replace.
  {
    id: 'gem-multiplier',
    question: 'THE MODE GATE IS NOT THE ANSWER, and that is what this cell has settled. A MainType-14 node '
      + 'at retail\'s top tier (5.0) dispatched in three passes of three — the Debounce behind it took the '
      + 'slot for its full 3 s, so the chain unarguably ran — and the score multiplier stayed at exactly '
      + '1.0 every sample of every pass, at 0.46-0.84 m of approach. The run says `gameMode 3` and '
      + '`riderCount 1`: showoff, alone, which is the mode the handler tests for and the mountain that '
      + 'removes the owner lottery.\n\n'
      + 'Four explanations die with it, which is why the negative is worth as much as a write would have '
      + 'been. NOT the mode gate: the run read 3. NOT the sampler: the field is read every sample and rests '
      + 'at exactly 1.0 rather than at noise, so the offset is right. NOT the owner word: the speed pad and '
      + 'the trick pad on THIS course in THESE passes wrote 4.9-5.0 into their own fields, so a '
      + 'rider-acting opcode did reach this rider. NOT chain position: all three are the leading node.\n\n'
      + 'What is left is narrower and worth a batch: either the handler carries a condition beyond the mode '
      + 'compare, or the multiplier is set and reset inside a frame. `TrickScore_ResetCombo` puts the field '
      + 'back to 1.0 on the next land or bail, and a rider crossing a full-corridor panel is landing '
      + 'constantly — so the next cell to build is this one on a host the rider cannot land on, or with the '
      + 'field read from a code cave at the store rather than at 20 Hz.',
    shape: 'gate', profile: profile(1), color: [0.55, 0.3, 0.95, 1], leadNode: 'score-multiplier',
    tuneLead: payload => { payload.MultiplierScore = 5; },
    watchLiveNode: true,
  },
  // ---- withdrawn from the gold map, kept here -------------------------------------------------------
  {
    id: 'auth-gate-scaled',
    question: 'Scale does not GATE dispatch, but it does cost reliability, and the two findings are '
      + 'different. A x2/x4/x6/x8 ladder ran six passes against a suspected ceiling above x4 and found none: '
      + 'the misses moved between scales run to run, and in run 20260806-065749 the x4 gate went dark at '
      + '9.21 m while x2 at 9.17 m and x8 at 9.24 m both fired. So the ladder collapsed to this one cell at '
      + 'the extreme — which then fired 5 passes of 7 while every UNSCALED gate beside it fired every time. '
      + 'It lives here rather than in the gold map because an expectation set on it produced a REGRESSION in '
      + 'run 20260806-072247, and a cell that cries wolf once a batch costs the whole suite its credibility. '
      + 'What it is worth is the warning that a heavily scaled instance is a less certain contact.',
    shape: 'gate', profile: profile(1), color: [0.6, 0.05, 1, 1], scale: 8,
  },
  // ---- the two-stage break: a surface that cracks now and gives way later ---------------------------
  // The Cracked node (type-0 sub 14) is the corpus's rarest property — twenty instances, all of them Megaplex
  // glass panes, all authored identically — and the only breakable whose collision chain breaks NOTHING. The
  // ELF says what it does [Trailmap: 150-logic §deferred-trigger]: it holds a strength pool, subtracts the
  // force of each accepted hit from it, and when the pool crosses zero its Update resolves effect-slot field
  // 4 — the trigger column — and runs that chain. The break is over there, not here.
  //
  // Reading gives the shape and cannot give the SCALE, and the scale is the entire authoring question. A
  // strength of 5 means nothing until something says what one hit costs, and the two candidate rates for
  // "one hit" are six times apart: the node's own 30-frame gate (twice a second) or this fixture's 3 s chain
  // debounce. An author choosing a number needs to know whether 5 is one contact or a dozen.
  //
  // So all four cells sit inside an 80 m volume rather than on a panel. Dwell is the instrument here, the
  // same way it is for the vent below, and for the same reason: what is being measured happens per tick
  // while the rider is inside, so the box IS the experiment.
  {
    id: 'cracked-retail',
    question: 'Retail\'s own glass pane, payload for payload — the U0 = -1 / U1 = 5 that all twenty Megaplex '
      + 'panes carry. Three words say whether the ELF reading holds up: the lifetime should read -60 frames '
      + '(the authored -1 s times 60) and never move, the 30-frame gate should SAWTOOTH while the rider is '
      + 'inside and run flat once they leave, and the strength should start at 5.0 and fall in steps. How '
      + 'many steps, and how big, is the number an author needs and nothing on paper can supply. No trigger '
      + 'column here on purpose: the Update retires the node instead when field 4 is absent, so this cell '
      + 'also asks what an unfinished crack does.',
    shape: 'volume', profile: profile(1), color: [0.55, 0.8, 0.95, 1], sizeM: CRACKED_BOX_M,
    extraNode: 'cracked',
    nodeWatch: CRACKED_STATE_WATCH, watchLiveNode: true, watchEntityFlags: true,
  },
  // `cracked-pad` was here and has GRADUATED: retail's own payload firing the trigger column, which is the
  // fact worth regressing, so it is a graded cell in the catalogue and a row on GOLD. It does NOT reproduce
  // retail's SHAPE — it is pass-through, and the rider crosses into it — which is what the two ride-on cells
  // below exist to fix.
  //
  // THE GAP THOSE TWO CLOSE, because it invalidates the reading every cell above shares: all of them stage
  // the rider CROSSING INTO the host, and none has the rider supported by it. A Megaplex pane is a glass
  // FLOOR ridden along for seconds — in game it cracks on arrival and breaks a few seconds later on an
  // authored 5 — so a supported contact has to cost of the order of 1 where a crossing costs 87. The
  // constancy of that 87 across a box, a panel and a wall is then one event staged three ways rather than a
  // node that ignores geometry, and the 30-frame gate is the pacing knob rather than a ceiling nothing
  // reaches.
  {
    id: 'cracked-ride',
    question: 'Retail\'s pane with retail\'s own OBJECT PROPERTY, which is the variable every earlier cell '
      + 'got wrong by inventing one. MEGAPLE property 120 is mode 1, response mass 0, BitFlags 4129 — '
      + 'visible and player-collision set, and PLAYER BOUNCE CLEAR — against the bounce-on profile every '
      + 'cell above uses. Bounce-off preserves contact and effect dispatch while suppressing the physical '
      + 'response, which is exactly a floor that carries a rider without shoving them, and it is why the '
      + 'two solid cells fought the rider instead of being ridden (one launched them, one stopped them '
      + 'dead at 3 m/s). Same payload, same profile, flush with the snow and 64 m long: if the strength '
      + 'now drains over several gate periods instead of vanishing in one contact, the deferral is '
      + 'reproduced and the authored recipe matches the game.',
    shape: 'pad', profile: profile(1, { responseMass: 0, playerBounce: false }), color: [0.6, 0.85, 1, 1],
    padDepthM: 64, followsSlope: true, liftM: 0.15,
    extraNode: 'cracked', triggerNodes: ['act-on-instance'], companion: 'debounce',
    nodeWatch: CRACKED_STATE_WATCH, watchLiveNode: true, watchEntityFlags: true,
  },
  {
    id: 'cracked-ride-cost',
    question: 'The instrument beside it, and the cell that carries the number an author needs. The same solid '
      + 'ridden panel at strength 1000, which a traversal cannot spend — so instead of giving way it records '
      + 'the whole decrement trace, one step per 30-frame gate period, for as long as the rider is on it. '
      + 'The step size IS the cost of a supported contact, which is the quantity every cell so far has '
      + 'measured the wrong version of. If the steps come back near 87 the ride-on distinction is wrong and '
      + 'the retail delay is somewhere else again; if they come back near 1, retail\'s authored 5 is about '
      + 'five gate periods of riding and the whole mechanism is explained. Carries retail\'s property too, '
      + 'so it differs from the cell above in the payload alone.',
    shape: 'pad', profile: profile(1, { responseMass: 0, playerBounce: false }), color: [0.4, 0.6, 0.9, 1],
    padDepthM: 64, followsSlope: true, liftM: 0.15,
    extraNode: 'cracked', tuneExtra: payload => {
      (payload.type0 as { type0Sub14: Record<string, unknown> }).type0Sub14.U1 = 1000;
    },
    triggerNodes: ['act-on-instance'], companion: 'debounce',
    nodeWatch: CRACKED_STATE_WATCH, watchLiveNode: true, watchEntityFlags: true,
  },
  {
    id: 'cracked-solid',
    question: 'The last variable, and the one that came back NEGATIVE — kept because a negative is only worth '
      + 'anything while it keeps reproducing. A hit costs 80-88 whether the rider flies through an 80 m '
      + 'pass-through box or rides over a flat panel, so the cost is not the approach angle and not the '
      + 'speed. The one thing every one of those cells shared is the one thing a retail glass pane is not: '
      + 'PASS-THROUGH, response mass 0. This is the solid twin — a host that really stops the rider — and it '
      + 'cost 87.55 a hit, the same as everything else, entering at 24 m/s and leaving at 17. So the collision '
      + 'response is ruled out with the shapes, retail\'s authored 5 is spent by its first contact on '
      + 'anything measurable here, and whatever makes a Megaplex pane look like a TWO-stage break is '
      + 'somewhere none of these cells has looked.',
    shape: 'gate', profile: profile(1, { responseMass: 1e30 }), color: [1, 0.4, 0.75, 1],
    extraNode: 'cracked', tuneExtra: payload => {
      (payload.type0 as { type0Sub14: Record<string, unknown> }).type0Sub14.U1 = 1000;
    },
    triggerNodes: ['act-on-instance'], companion: 'debounce',
    nodeWatch: CRACKED_STATE_WATCH, watchLiveNode: true, watchEntityFlags: true,
  },
  // `cracked-shatters` and `cracked-tough` were here and have GRADUATED as a pair — the trigger column
  // firing when a strength pool runs out, with the strong twin beside it that says the strength is the gate
  // rather than decoration. A pair is the smallest thing either of them could graduate as.
  {
    id: 'cracked-heals',
    question: 'The other payload word. U0 = 2 with a strength no ride can spend, so the only thing that can '
      + 'happen is the lifetime running out — and the claim is read off the LIVE-NODE SLOT emptying about '
      + 'two seconds after it filled, not off any offset that could be wrong. That would make U0 seconds of '
      + 'crack rather than seconds of anything else, and would mean an authored crack can heal: the node '
      + 'retires and takes the damage it had accumulated with it, which is exactly why retail authors -1 on '
      + 'every pane it ships.',
    shape: 'volume', profile: profile(1), color: [0.6, 0.9, 0.5, 1], sizeM: CRACKED_BOX_M,
    extraNode: 'cracked', tuneExtra: payload => {
      const cracked = (payload.type0 as { type0Sub14: Record<string, unknown> }).type0Sub14;
      cracked.U0 = 2;
      cracked.U1 = 1000;
    },
    nodeWatch: CRACKED_STATE_WATCH, watchLiveNode: true, watchEntityFlags: true,
  },
  // The launcher, and the only cell on the bench that puts the rider in the air: a launched rider arrives at
  // whatever follows both airborne and climbing. Unlike `boost-up-lifts` on the gold map it is tuned to THROW
  // rather than merely to push, so it cannot share a course with a second launcher — the flight is longer
  // than the cell spacing, and the rider would sail clean over one and report a miss that was really a hit on
  // the cell above.
  //
  // It is second-to-last rather than last because `pad-gate` below carries a reset and has the stronger claim
  // on the end of the course. That is only safe because of how that cell is SHAPED: the recorded passes cross
  // the 90 m to it in about 2.9 s against a flight nearer 3.8, so the rider really is still up there, and it
  // takes a 40 m volume rather than an 8 m panel for exactly this reason. A gate there would report a miss
  // that belonged to this cell.
  {
    id: 'vent-throw',
    question: 'HOW FAR does a boost node actually throw a rider, at the tuning and the SIZE Megaplex ships? '
      + 'Retail\'s exhaust vent, verbatim: mode 1, window 0, rate 3.0, target 100 m/s, axis straight up — '
      + 'inside a box carrying that host model\'s own 3.29 m of height and 3.60 m of depth rather than the '
      + '40 m one the existing boost cell uses. The pair is the point. `boost-up-lifts` proves a boost '
      + 'PUSHES and says nothing about magnitude, because it was sized to guarantee contact rather than to '
      + 'reproduce one; every port reading it has had to guess how long a real vent holds a rider. This cell '
      + 'reads the three numbers that answer it — peak rise, metres climbed, and peak carried speed — so a '
      + 'port can be checked against a throw instead of against a direction. Peak speed is the half most '
      + 'likely to be got wrong: the node writes neither pad-request field, so it raises no cap, and a '
      + 'grounded rider stays bounded at ~27.9 m/s however violent the push while an airborne one is not '
      + 'bounded at all.',
    shape: 'volume', profile: profile(1), color: [1, 0.55, 0.05, 1], sizeM: VENT_BOX_M,
    extraNode: 'directional-boost',
    tuneExtra: payload => {
      const boost = (payload.type0 as { Boost: Record<string, unknown> }).Boost;
      Object.assign(boost, { Mode: 1, U1: 0, U2: 3, BoostAmount: 100, BoostDir: { X: 0, Y: 0, Z: 1 } });
    },
    watchLiveNode: true,
  },
  // ---- the pad gate: both opcodes and their control, on one prop, in one chain ----------------------
  // Reset, speed pad, and trick pad share one effect-thread owner. The reset displacement is the control;
  // the pad countdowns are the paired observations. A trailing Wait keeps the thread alive long enough for
  // the heap-located owner watch. Run this fixture with `--frames 3700`: shorter windows miss the cell, while
  // longer windows can cross the course restart and invalidate both the heap search and displacement signal.
  // Re-measure that window after adding or removing earlier cells [Trailmap: 360-pads-ownership].
  {
    id: 'pad-gate',
    question: 'THE EFFECT-THREAD OWNER IS THE GATE. A speed pad, a trick pad and a course reset share one '
      + 'chain and owner, with the thread found by its host relationship. Three '
      + 'passes, and the correlation is exact: the two that wrote 4.983 and 4.950 into the boost request AND '
      + 'moved the rider 17.2 m and 32.1 m both read an owner equal to `rider.boarder` to the bit, and the '
      + 'one that wrote nothing and moved the rider 2.24 m (under the noise floor) carried two different '
      + 'boarder-shaped pointers, neither of them this rider. The pads and the reset never split, which is '
      + 'what one shared word predicts. Still open, and smaller: WHAT DECIDES which boarder a contact is '
      + 'handed. Note the negative half is the weaker one — the harness reports only heap candidates whose '
      + 'words changed, so the failing pass shows the blocks it reported were not this rider rather than '
      + 'that none was.',
    shape: 'volume', profile: profile(1), color: [0.1, 0.95, 0.85, 1], sizeM: PAD_GATE_BOX_M,
    extraNode: 'speed-boost', tailNodes: ['trick-boost', 'rider-reset', 'wait'],
    // Ten minutes, which is longer than any window this fixture rides. The number is not a duration anybody
    // waits for — it is "never", expressed in the only units the node has.
    tuneTail: (payload, id) => { if (id === 'wait') payload.WaitTime = 600; },
    // Both probes remain on purpose: the live-node-relative control rejects itself, while the heap-located
    // thread returns the semantic owner observation.
    // Keeping the failing one is what shows the search was necessary rather than ornamental.
    nodeWatch: PAD_OWNER_WATCH, lateWatch: PAD_THREAD_LATE_WATCH, watchLiveNode: true,
  },
  // ---- a clip on a model that actually HAS one ----------------------------------------------------------
  // The first cell in this fixture to place a prop from the imported catalogue rather than a retail donor
  // index or a generated panel, and the reason is that neither of the other two paths can carry keyframes:
  // `AuthoredModel` has no animation field at all, and a borrowed retail model reaches the runtime with a
  // play window of zero however many frames the donor declares. That last part is measured, not suspected —
  // every play-once cell that rode the trick gem read a clock of exactly 0.0 in every pass ever recorded
  // (48 of them across four cells), which is what a window ending at zero does on the first tick.
  //
  // This is the cell that established it, and the catalogue's persistent clip family moved onto the same
  // imported model behind it. The gem cells that remain are the contact pair, whose question is contact
  // rather than the clip.
  {
    id: 'clip-real-keyframes',
    question: 'Does a model clip PLAY, asked with a model that HAS one? `SnowGun_9` from the imported '
      + 'catalogue carries 40 authored frames, and that path is known to reach the disc verbatim — '
      + 'TEST_MTN_6 and TEST_MTN_7 pack AnimTime 40, 90, 144 and 300, the authored clipFrames unchanged. '
      + 'The read is categorical rather than a number to judge: at 40 frames the window is 1.33 s, and a '
      + 'looping clip on a real model RETURNS to its window start well inside the few seconds a node lives, '
      + 'where the same node on a keyframeless model counts past it forever. A wrap is the answer. The '
      + 'window words beside the clock say which case this is before the clock is worth reading at all.',
    shape: 'clip', profile: profile(1), color: [0.55, 0.85, 1, 1], liftM: 2, contactOptional: true,
    persistentNode: 'anim-object', nodeWatch: ANIM_CLIP_WATCH,
    watchLiveNode: true, watchEntityFlags: true,
  },
  // The `one-shot-clip` recipe with the one thing its badge claims and its cells have never had: a model
  // whose clip has frames. `clip-on-contact` settled contact, slot ownership and the latch on the borrowed
  // gem, and none of that is in question here — what is open is the part a zero-length clip cannot show,
  // that the latch holds a pose the clip took TIME to reach.
  //
  // It is a bench cell rather than a catalogue one for a specific reason: whether the rider can hit this
  // model is unknown. The gem's hittability took work to establish and no imported prop has ever been ridden
  // into, so a `crossed-without-firing` here is a real possible outcome and an informative one. Asserting
  // nothing is what lets it report that instead of failing the course.
  {
    id: 'clip-contact-keyframes',
    question: 'The iris door with a clip that has frames: ride into the imported model and its 1.3333 s '
      + 'play-once clip runs, both latch columns holding the finished node. Two things are being asked at '
      + 'once and they separate cleanly. Can the rider contact an IMPORTED prop at all — nothing in this '
      + 'fixture has tried, and a crossing with an empty slot answers it in the negative without ambiguity. '
      + 'And if contact lands: does the clock stop AT the window end rather than at 0, which is the reading '
      + 'the borrowed gem could never produce and the only thing standing between this recipe\'s badge and '
      + 'the claim it actually makes.',
    // Everything but the model is `clip-on-contact`'s proven arrangement: mode 2, so the tested shape is the
    // bounding box the gem is hit through rather than a 190-triangle proxy. No lift, because this model's
    // origin is at its BASE (raw Z runs 0 to 432) where the gem's is centred — and scaled up, because at its
    // authored 2.72 x 2.55 m it is a narrower target than anything the rider has ever been asked to hit. At
    // 6x that is a 16 x 15 m footprint standing 26 m tall, still well inside the 90 m cell spacing.
    shape: 'clip', profile: profile(2), color: [1, 0.45, 0.35, 1], scale: 6, contactOptional: true,
    tailNodes: ['anim-object'],
    tuneTail: payload => {
      (payload.type0 as { type0Sub256: Record<string, unknown> }).type0Sub256.U0 = 0;
    },
    latches: ['slot3', 'slot4'],
    nodeWatch: ANIM_CLIP_WATCH, watchEntityFlags: true, watchLiveNode: true,
  },
  // ---- the vertical lift, newly authorable and not yet ridden -------------------------------------------
  // The directional boost's own rate/target/axis triple plus the two fields that make it an elevator: a
  // target ALTITUDE it carries riders up to and a snap tolerance [Trailmap: 360-zboost]. It goes in the same
  // box shape `boost-up-lifts` established is the way to hold a rider long enough for a boost to act on them.
  //
  // Retail's only authoring is Megaplex's air shafts, whose target is an absolute -120 m and means nothing
  // anywhere else — so the target here is written from the cell's own ground rather than copied, which is
  // also exactly what the editor's `bindZBoostToPlacement` does for an author.
  {
    id: 'lift-raises',
    question: 'Does the vertical lift LIFT? It shares rate, target speed and axis with the directional boost '
      + 'already proven on the catalogue, and the fields that differ are the question: a target altitude, set '
      + 'here to 25 m above this cell\'s own ground, that the node carries riders up to and releases them at. '
      + 'The reading is the same attributed rider rise the directional boost is graded on, so the two are '
      + 'directly comparable — the course floor is about -7.5 and the largest positive anywhere no node is '
      + 'pushing is 0.8. This node also zeroes horizontal velocity every tick, so a rider it catches should '
      + 'STOP as well as climb, which nothing else on the course does and which the speed signal beside the '
      + 'rise should show. Asserting nothing until a batch answers it.',
    shape: 'volume', profile: profile(1), color: [0.4, 0.55, 1, 1], sizeM: BOOST_BOX_M,
    extraNode: 'z-boost',
    tuneExtra: (payload, groundM) => {
      const sub = (payload.type0 as { type0Sub18: Record<string, number> }).type0Sub18;
      // Raw centimetres, the frame the exporter writes altitudes in.
      Object.assign(sub, { U0: 4, U1: 20, U2: 0, U3: 0, U4: 1, U5: 100 * (groundM + 25), U6: 0 });
    },
    watchLiveNode: true,
  },
] as const;

/**
 * Which game mode a fixture is ridden in, and it is part of the fixture rather than a flag on the run.
 *
 * `showoff` puts ONE rider on the mountain; `race` puts six. That is not a detail of convenience — every
 * rider-acting opcode acts on the boarder its effect thread was handed rather than on whoever touched the
 * prop, so the size of the field decides whether a cell measuring the player is measuring the player. In a
 * race the same pad landed on the local human 3 passes in 42; alone, every pad on the course lands in one
 * [Trailmap: 360-speed-and-boost §pads-solo].
 *
 * So the baseline is the SOLO mountain, and a fixture that wants a field says so. Naming the mode on the
 * fixture rather than passing it per run is what stops the two from ever drifting apart: a course whose
 * cells assume company cannot be ridden alone by forgetting a flag.
 *
 * FREERIDE is not an option here, for two independent reasons. It is not reachable: the top-level menu is a
 * three-entry ring — measured, one DOWN lands on showoff, two on race mode 7, three back at the start, and UP
 * from the default does not move — while both freeride entries sit on menu screens that ring never visits.
 * And it would cost coverage if it were: main types 6, 14, 15 and 16 test the mode word for {3, 5} and return
 * early otherwise [Trailmap: 390-pickups-and-race §gem-mode-gate], so boost-meter fill, the gem multiplier
 * and the time bonus are all dead outside showoff. Showoff is both the solo mountain AND the one where the
 * most opcodes are live, which is why it is the baseline rather than a compromise.
 */
export type AutoTestMode = 'showoff' | 'race';

/**
 * The field: the only course ridden with company, and it is deliberately small.
 *
 * Riding with five opponents was the default for this harness's whole life, and it cost more than anyone
 * noticed. Every rider-acting opcode is handed the boarder its effect thread owns rather than the rider who
 * touched the prop, so a crowded mountain turns a deterministic node into a lottery — the pads read as dead
 * for days on a 3-in-42 rate that was never about the pads. A solo baseline removes that variable from every
 * cell at once, which is why it IS the baseline now.
 *
 * What lands here is the residue: cells whose question cannot be asked without a field. Two kinds so far.
 *
 *   WHO gets the effect. The owner word holds a real boarder and, alone, it can only be you. What picks it
 *     when there are six candidates is the open half of the pad question, and it needs six candidates.
 *   Anything reading the RESET's placement. `Boarder_CourseResetEntry` averages the OTHER riders' distance
 *     to finish over `count - 1` and feeds that into where it puts you, so alone that average has no terms.
 *     The one showoff pass carrying a reset moved the rider 0.0 m where two race passes moved 17.2 and
 *     32.1 m — one pass, so a hypothesis with a mechanism rather than a result, and exactly what this course
 *     exists to settle.
 *
 * It leads with the same retail control as the others, so a dark run indicts the harness rather than the
 * mode.
 */
export const AUTO_TEST_FIELD_CASES: readonly AutoTestCase[] = [
  // THE CONTROL'S PROBLEM ON THIS COURSE WAS ITS DISTANCE, NOT ITS SIZE, and that was worth one wrong fix to
  // find out. The bag reported `not-reached` or `pre-occupied` on six straight race passes at 140 m, with the
  // rider 69-118 m wide of it, so the obvious reading was that a prop a couple of metres across is too small
  // to catch a scattered field. It is not. Moved to 230 m by an unrelated edit, the same bag fired in three
  // passes of three with the rider 1.7-2.1 m away. The pack takes about 200 m to sort itself out; before that
  // the player's position across the corridor belongs to five other boards, and after it they are on the
  // racing line like anybody else. `leadInM` on the fixture is the fix, and it is measured rather than
  // guessed.
  //
  // WIDENING IT WAS THE WRONG FIX TWICE OVER, which is the part worth writing down because the idea is
  // tempting and both failures are silent. A 300 m corridor-spanning volume in the first slot came back
  // `pre-occupied` twice and `not-reached` once:
  //
  //   the reach test is ORIGIN-based    `crossed` and the attribution window use a 25 m ball around the
  //                                     prop's own origin, so a rider 83 m wide of a 300 m box has physically
  //                                     crossed it and still reports `not-reached`. Box extent does not enter
  //                                     into it. A wider cell is not an easier cell to reach.
  //   wide + early is WORSE             six riders leave the gate abreast, so the first of them to touch a
  //                                     corridor-spanning trigger fills its slot before the harness starts
  //                                     sampling. Widening the control made an opponent more likely to claim
  //                                     it, not less.
  {
    id: 'ctl-retail-bag',
    question: 'Control: the retail crash bag every course here leads with. A run where this stays dark '
      + 'indicts the harness or the menu prelude, so nothing below it is worth reading. On this course it '
      + 'sits further down the hill than on the solo ones — a control has to be somewhere the rider reliably '
      + 'IS, and for the first couple of hundred metres of a race that is not the fall line.',
    shape: 'bag', profile: profile(1), color: [1, 1, 1, 1],
    expect: 'dispatch', demonstrated: FIELD_BATCH,
  },
  {
    id: 'pad-gate',
    question: 'The same chain as the bench\'s `pad-gate`, ridden with five opponents instead of alone — '
      + 'which is the whole experiment. Solo, the effect thread\'s owner can only be this rider and every '
      + 'pad on the course writes in one pass. Here it is one of six, and the open question is what picks '
      + 'it: the roster is now read per run, so an owner that is not this rider can be matched against the '
      + 'field by address rather than reported as a bare pointer. The reset rides along for the second '
      + 'question — its placement averages the OTHER riders\' distance to finish, so this is the only course '
      + 'where the distance it moves you means anything.',
    shape: 'volume', profile: profile(1), color: [0.1, 0.95, 0.85, 1], sizeM: PAD_GATE_BOX_M,
    extraNode: 'speed-boost', tailNodes: ['trick-boost', 'rider-reset', 'wait'],
    tuneTail: (payload, id) => { if (id === 'wait') payload.WaitTime = 600; },
    nodeWatch: PAD_OWNER_WATCH, lateWatch: PAD_THREAD_LATE_WATCH, watchLiveNode: true,
  },
  // The negative half of the mode gate, and the reason it is HERE rather than beside its twin: this course
  // is the one that rides RACE, so the two cells differ in the game mode and in nothing else — same node,
  // same tier, same shape, same chain position. A gate is a claim about two outcomes and a single course can
  // only ever produce one of them.
  //
  // It also inherits this course's own hazard, and the hazard does not touch the claim. Every rider-acting
  // opcode services the boarder its effect thread was handed, so with six on the mountain a pass can dispatch
  // and land on somebody else — which is why the bench cells read as they do. Here that makes a 1.0 the
  // weaker direction of the reading on its own; what makes the pair decisive is the showoff twin reading 5.0
  // in a mode where a null result cannot be blamed on the field.
  {
    id: 'gem-multiplier-race',
    question: 'The mode gate\'s other side. The identical MainType-14 node the bench rides in showoff, here '
      + 'in RACE — mode 2, outside the {3, 5} the handler tests — where `TrickScore_ApplyGemMultiplier` is '
      + 'branched past entirely and the multiplier must stay at its 1.0 rest. The chain around it still has '
      + 'to run: the marker behind the node reports whether a gated-out opcode is inert or fatal, and a '
      + 'scoring node that quietly ends its chain in three of the game\'s modes is worth knowing about '
      + 'before anyone authors one into a race course. Read `gem-multiplier` beside the bench twin; a 5.0 '
      + 'here would retire the gate outright.',
    shape: 'gate', profile: profile(1), color: [0.55, 0.3, 0.95, 1], leadNode: 'score-multiplier',
    tuneLead: payload => { payload.MultiplierScore = 5; },
    watchLiveNode: true,
  },
  // CAN THE RIDER BE TAKEN OFF THE RACE LINE AND LEFT THERE — the question a lane-based course rests on, and
  // the reason it is worth asking is arithmetic. A showoff pass is a timed run that ends at ~128.6 s with the
  // rider 2,660 m in; a race pass gets 240 s and ~5,900 m. The harness rides showoff anyway, and pays that
  // 2x, for one reason only: race puts five opponents on the mountain and every rider-acting opcode services
  // the boarder its effect thread was handed, so a crowded mountain turns a deterministic cell into a
  // lottery. A rider warped into a lane nobody else visits would be solo IN RACE — the window without the
  // company — which is the only way `AUTOTEST1` stops paying for its own length.
  //
  // A BARE TELEPORT AT THE START WOULD DO THE OPPOSITE, and that is the trap worth naming. A full-corridor
  // gate is crossed by the whole field, so every contact runs the chain and the best case is that some
  // arbitrary subset of six riders lands in one spot. The gate in front of it is what makes the separation
  // selective rather than general.
  //
  // Which is why this cell is worth riding even if the teleport turns out to be dead. `gate-human` has sat in
  // the catalogue with half its claim untested since it was added — it passes for the player, and whether it
  // REJECTS an AI has never been askable on a course with one board. Here it is asked directly, and the
  // answer arrives as a distance rather than a slot word.
  //
  // IT HAS TO RUN LAST for the same reason as its solo twin: whoever ends up at the destination rides the
  // rest of the mountain 130 m wide of everything.
  //
  // BOTH HALVES READ THROUGH THE WARP, and that is only worth anything because the warp is now proven: its
  // solo twin `teleport-warp` moved the rider 132.9 m in three passes of three. A displacement that reliable
  // is a rare thing to be able to hang a second question on — whoever the gate lets through is whoever ends
  // up 130 m off the line, and that is legible in one column of the report.
  //
  // WHAT THE LANE ITSELF DOES, which this cell measured incidentally and is the more useful half for anyone
  // building on it. After the warp the rider descended the half-corridor at 21.4 m/s for ~45 s and roughly a
  // kilometre, undisturbed — the terrain out there is ordinary rideable snow, not a shelf. The engine then
  // put them back on the race line, but only AFTER they had come to a stop (0 m/s at 52.5 s, reclaimed at
  // 53.9 s). So being off the line is not itself on a leash; being stationary is. A lane whose cells keep a
  // rider moving is not fighting the engine, and one that dead-ends is.
  //
  // That reclaim is also why `jump` truncates at the FIRST relocation. This cell is last on its course and
  // therefore owns every sample to the end of the run, so before the fix its own 132.03 m warp was reported
  // as the 139.12 m reclaim that happened three quarters of a minute later.
  {
    id: 'human-gate-warp',
    question: 'A HUMAN-RIDER GATE REJECTS AN AI, AND A TELEPORT BEHIND IT TAKES THE PLAYER OFF THE RACE LINE '
      + 'ALONE. Two facts and one cell, both read off the roster trace rather than the local rider. Three '
      + 'passes of three, six riders: exactly ONE body was relocated each time and it was the player — '
      + '125.9, 115.1 and 126.0 m on the frame the cell fired. Not one opponent moved, and they were not '
      + 'merely absent: FIFTEEN AI contacts within 0.2-1.6 m of the panel\'s origin against three human '
      + 'ones, and the tally is 0 warps to 3. In two of the three passes all five opponents crossed BEFORE '
      + 'the human with the slot still empty and nothing was built, which is the half a debounce cannot '
      + 'explain away. That is `gate-human`\'s rejecting half — the one no solo course can ask, because it '
      + 'needs a second board on the mountain and a way to see what that board did.',
    shape: 'gate', profile: profile(1), color: [0.95, 0.55, 0.15, 1],
    leadNode: 'gate-human', tailNodes: ['rider-teleport'], teleportTarget: true,
    watchLiveNode: true,
    expect: 'dispatch', expectRider: [{ signal: 'jump', atLeast: 100 }], demonstrated: FIELD_BATCH,
  },
] as const;

/**
 * AUTOTEST5, the relay: two cells, and the second one asks whether a course has to be a single line at all.
 *
 * Every fixture here is one fall line with its cells strung down it, and that shape sets the ceiling on what a
 * pass can cover. A showoff event is a TIMED run — measured, the level restarts at ~128.6 s with the rider
 * 2,660 m in — so a solo course holds about 29 cells at the proven 90 m spacing and no amount of mountain buys
 * a thirtieth. AUTOTEST1 rides a race purely to get 240 s instead, and pays for it with five opponents that
 * turn every rider-acting cell into a lottery.
 *
 * MainType 24 is the only opcode that puts a rider somewhere the course did not lead them, which makes it the
 * only candidate for a course that is not a line: lanes side by side, each one ridden and then handed to the
 * next. Whether that is worth building depends entirely on the primitive, and the primitive has never run from
 * an authored level — retail authors exactly one teleport in the whole extracted corpus (MERQUER's
 * `Mdl_TeleportStart_0`) [Trailmap: 390-pickups-and-race].
 *
 * So this course asks the primitive and nothing else. It is SOLO, because a teleport is rider-acting and the
 * effect thread services the boarder it was handed rather than whoever touched the prop — with six on the
 * mountain a warp that landed on an opponent and a warp that never happened are the same reading, and a
 * negative would mean nothing. It is SHORT, because two cells answer it. And its second cell is last by
 * construction: the destination is a half-corridor off the fall line, so the rider finishes the run out there.
 *
 * THE ANSWER IS YES, and it is exact rather than merely positive (`TELEPORT_BATCH`). Three passes of three,
 * the rider moved 132.9 m between two adjacent samples and arrived 3.00 m from the destination panel with
 * their velocity zeroed from 23.9 m/s. Those results reproduce the specified target-relative placement and
 * zero-speed arrival [Trailmap: 390-teleport]. An authored teleport is a working opcode, and a lane-based
 * course has its primitive.
 *
 * THE FIRST READING OF THIS BATCH SAID THE OPPOSITE, and the reason is worth keeping, because the fault was
 * in the instrument and it was completely silent. Rider signals are attributed from the moment a cell FIRED,
 * and every one of them but `jump` is a peak over single samples, so a window that opens at dispatch contains
 * what it needs. `jump` is a DIFFERENCE between two adjacent samples, and this opcode acts AT dispatch — so
 * the "after" sample was inside the window and the "before" sample was one index outside it, and the reading
 * collapsed to the 1.43 m of ordinary riding that followed. It reported as a node that did nothing, three
 * times, consistently, with every corroborating signal agreeing. `verdict.py` now gives `jump` one sample of
 * lead-in; replayed against these three saved runs it returns 132.9 m and leaves the control cell unmoved.
 */
export const AUTO_TEST_RELAY_CASES: readonly AutoTestCase[] = [
  {
    id: 'ctl-retail-bag',
    question: 'Control: the retail crash bag every course here leads with. A run where this stays dark '
      + 'indicts the harness or the menu prelude, so nothing below it is worth reading.',
    shape: 'bag', profile: profile(1), color: [1, 1, 1, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  {
    id: 'teleport-warp',
    question: 'AN AUTHORED TELEPORT MOVES THE RIDER, and lands them where the handler says it will. A '
      + 'MainType-24 node leading the chain, aimed at a bare panel 130 m off the fall line that carries no '
      + 'chain and that the rider has no way to reach — so arriving there has exactly one possible cause. '
      + 'Three passes of three: 132.9 m between two adjacent samples, arriving 3.00 m from the panel with '
      + 'speed cut from 23.9 m/s to nothing. This reproduces the specified arrival offset and zero-speed '
      + 'placement to three figures rather than reporting a bare displacement [Trailmap: 390-teleport].',
    shape: 'gate', profile: profile(1), color: [0.95, 0.75, 0.2, 1],
    leadNode: 'rider-teleport', teleportTarget: true, watchLiveNode: true,
    expect: 'dispatch', expectRider: [{ signal: 'jump', atLeast: 100 }], demonstrated: TELEPORT_BATCH,
  },
] as const;

/**
 * AUTOTEST6, the call: a control and the two cells that ask what a MainType-21 node does.
 *
 * It is a course of its own for the reason `AUTOTEST5` is — the bench had no room. A showoff pass of the
 * bench reaches about 1,450 m and its last cell already sits past that, so anything added there is stranded
 * whatever it asks. Rather than take reach from somebody else's open question, the newest one gets the
 * shortest mountain that can hold it: three cells, 320 m, ridden alone.
 *
 * NEITHER CELL READS THE CALLER FOR ITS EVIDENCE, and that is the design rather than a convenience. The
 * chain's own debounce already occupies this instance's live-node slot, so a node the called body installed
 * HERE would be a second node in an occupied slot — a reading that says something ran without saying which
 * table it came from. Both bodies therefore reach outward, and each carries a node a graded catalogue cell
 * already proves works from an ordinary chain. That is what makes a red row mean "the call is broken" rather
 * than "the node is".
 */
export const AUTO_TEST_CALL_CASES: readonly AutoTestCase[] = [
  {
    id: 'ctl-retail-bag',
    question: 'Control: the retail crash bag every course here leads with. A run where this stays dark '
      + 'indicts the harness or the menu prelude, so nothing below it is worth reading.',
    shape: 'bag', profile: profile(1), color: [1, 1, 1, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  // The rider cell rides SECOND, ahead of the hop cell, and the order is load-bearing on a course this
  // short. The export derives the fall line from the first two plan entries, and a companion's entry is
  // pushed ahead of the host it belongs to — so a hop cell in slot two would hand the check a line running
  // 130 m off to the side, and every cell would then read as lying along it. A cell with no companion has to
  // be the second one.
  {
    id: 'call-function-rider',
    question: 'A CALLED BODY IS HANDED THE RIDER WHO TOUCHED THE CALLER. The chain carries no rider-acting '
      + 'node at all — only debounce, marker and a MainType-21 call — and the speed pad sits inside the '
      + 'called function, yet the rider\'s boost request reads 4.933, 5.000 and 5.000 against the authored '
      + '5.0. That is the handler passing its own thread\'s owner down [Trailmap: 150-logic], and it is what '
      + 'separates this opcode from the detached call (MainType 26), whose whole difference is that it does '
      + 'not. The arithmetic corroborates it rather than resting on one word: the cell below reads the same '
      + 'request three seconds later at 1.95 / 1.983 / 1.933, which is this 5.0 less the gap between the two '
      + 'contacts — a countdown that is running, not a value that was written once and read stale.',
    shape: 'gate', profile: profile(1), color: [0.95, 0.55, 0.3, 1],
    functionNodes: ['speed-boost'],
    nodeWatch: PAD_OWNER_WATCH, watchLiveNode: true,
    expect: 'dispatch', expectRider: [{ signal: 'boost-request', atLeast: 4.5 }], demonstrated: CALL_BATCH,
  },
  {
    id: 'call-function-hop',
    question: 'A MainType-21 CALL RUNS AN AUTHORED FUNCTION. The chain is debounce, marker and a call; the '
      + 'called body is a single MainType-7 hop onto a companion 130 m off the fall line that carries no '
      + 'chain and that the rider never approaches. The companion took a node in all three passes, on the '
      + 'same sample the caller fired, with the rider measured 129.8 m away — so the call resolved its index '
      + 'into the appended function table, the engine spun a thread up on that function, and the body ran. '
      + '`hop-remote-target` on the catalogue is the control: the same hop reached directly from a chain, so '
      + 'a run where that lands and this does not means the indirection failed rather than the hop.',
    shape: 'gate', profile: profile(1), color: [0.85, 0.4, 0.95, 1],
    functionNodes: ['act-on-instance'], companion: 'debounce',
    watchLiveNode: true,
    expect: 'dispatch', demonstrated: CALL_BATCH,
  },
] as const;

/** One full-width painted terrain band of the instrument course, laid down the fall line. */
export interface AutoTestSurfaceStrip {
  /** How the analyzer names this band's rows. */
  label: string;
  /** The painted SurfaceType [Trailmap: 110-terrain] — the whole variable under test. */
  surface: number;
  lengthM: number;
}

/**
 * AUTOTEST4, the instrument run: not a catalogue of cells but a course whose TERRAIN is the experiment.
 * Retail's board-audio interface exposes the Slip, Dig, and Lean signals [Trailmap: 420-audio-runtime]. This
 * course is long painted strips of the families in question, ridden straight, while the harness samples the
 * boarder's signal words every tick. The analyzer (`tools/autotest/audio_signals.py`) reports their measured
 * distributions only; those operating ranges can tune OpenSlope's original response without carrying the
 * retail expression sequence or an expected-output table.
 *
 * The two cells are anchors, not questions: the control proves the pipeline as everywhere else, and the
 * second gives the analyzer a second raw-space location to derive the fall line from. Both are pass-through,
 * so the descent they anchor is undisturbed.
 */
export const AUTO_TEST_SIGNALS_CASES: readonly AutoTestCase[] = [
  {
    id: 'ctl-retail-bag',
    question: 'Control: the retail crash bag every course here leads with. A run where this stays dark '
      + 'indicts the harness or the menu prelude, so nothing below it is worth reading.',
    shape: 'bag', profile: profile(1), color: [1, 1, 1, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  {
    id: 'fall-line-anchor',
    question: 'The second raw-space anchor: with the control above it, the signal analyzer derives the fall '
      + 'line it projects every rider sample onto. An invisible pass-through volume, so the descent it '
      + 'anchors is exactly the descent being measured.',
    shape: 'volume', profile: profile(1), color: [0.05, 1, 1, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
];

/**
 * The strips themselves. PACK leads as the in-course control — same instrument, same bucketing, the family
 * every ear already knows — then the ice row and the three hard rows the megaplex question is about.
 *
 * 150 m each, and the length is a showoff-timer budget rather than a sampling one: a showoff event restarts
 * the level at ~128 s, and a STEERED pass (`run.py --weave`) descends at well under course speed because a
 * held edge scrubs. The first steered ride, on 250 m strips at a 2 s full-lock duty cycle, covered one strip
 * in the whole window. 150 m at the gentler weave still yields several full carve cycles per strip.
 */
export const AUTO_TEST_SIGNAL_STRIPS: readonly AutoTestSurfaceStrip[] = [
  { label: 'pack', surface: 1, lengthM: 150 },
  { label: 'ice', surface: 5, lengthM: 150 },
  { label: 'metal', surface: 13, lengthM: 150 },
  { label: 'chute', surface: 18, lengthM: 150 },
  { label: 'rock', surface: 9, lengthM: 150 },
];

/**
 * The audio bench: does a PLACED EMITTER actually sound?
 *
 * Every other fixture grades a node getting built. That is the wrong question for ambience, and the gap is
 * not theoretical — a custom emitter shipped silent for as long as the feature existed, with a correct
 * export, a correct ADL row and the right clip in the right bank slot, because the slot was encoded with the
 * one-shot end marker and the SPU releases a voice when its samples run out. Nothing short of the console
 * could have caught it, and nothing here graded it.
 *
 * So these four cells are graded off the engine's own external-voice pool rather than off dispatch, by
 * `tools/autotest/audio_voices.py`. The order is the argument:
 *
 *   - a RETAIL global id first, which needs nothing injected, so a red row below a green one separates "our
 *     injection is broken" from "placed emitters are broken". It is NOT a like-for-like control and saying
 *     so matters: an id in the special range loads a whole named bank of its own, which is a different
 *     branch from the course-bank slot every custom clip lands in, so this cell would stay green if that
 *     branch broke;
 *   - hence the second retail cell, on the branch the custom ones use. It has no like-for-like partner
 *     available: GARI ships 23 course-bank sounds and NOT ONE carries a loop region, and the only bank in
 *     the game that has any is merqurycity1, whose looping slots are exactly the three interactive-ambient
 *     ones. So this cell is predicted rather than known, and it is worth riding for that reason — if a
 *     retail slot with no loop region also stays silent, the loop region is confirmed from the retail side,
 *     independently of anything this toolchain encodes;
 *   - the custom clip, which is the whole injection path — reserved event, encoded bank slot, loop region;
 *   - the hit-gated custom clip, which is also this course's silence control: the engine holds it quiet
 *     until contact, so a run where everything sounds fails here rather than reading as a clean sweep;
 *   - the one-shot, which the pool cannot see and which therefore asserts nothing at ride time — it is graded
 *     off the SHIPPED BANK instead by `tools/autotest/audio_tone.py`, where its slot must come out UNlooped
 *     beside the two that must loop.
 *
 * Each emitter takes a distinct event id on purpose: the runtime refuses to start a second voice for an id
 * already sounding, so two cells sharing one would make the second unreadable through no fault of its own.
 *
 * THE FIRST BATCH OF 2026-08-11 IS VOID. It reported two clean passes, and the passes were real, but the
 * disc could not have played a note: its rebuilt course bank came to 371,280 bytes against garibaldi1's own
 * 324,992, and a bank past the size its level shipped with is wholly silent [Trailmap: 260-bank-budget].
 * Every number in it was the pool answering "was a voice allocated", which is a question a mute disc answers
 * yes to. It is recorded rather than deleted because that is the failure this course exists to make visible,
 * and it went on reading green through it.
 *
 * MEASURED 2026-08-11, on builds inside the budget, across three batches that differ only in where the
 * one-shot landed. Every emitter pass agrees on the SHAPE: Wind1 and the custom loop sound for essentially
 * their whole residency, the retail course slot does too, and the gated clip stays resident and SILENT for
 * 48-58 samples before sounding — that last figure is the one to compare across batches, because it is
 * counted against the rider reaching the prop. The absolute "sounded" counts are NOT comparable: they are
 * samples of the pool, and doubling `--seconds` from 20 to 40 moved them 127 -> 128 rather than doubling
 * them, so they measure the probe's sampling as much as the engine's. The disc's own bank decodes to 220 Hz
 * looping, 330 Hz looping and 660 Hz one-shot at full level, which is the half no memory read covers. The
 * dispatch half is a batch of three with every cell firing 0.2-1.4 m out, so the cells below carry
 * `expect: 'dispatch'` — worth saying what that is worth: all six fired on the silent build too.
 *
 * The current batch puts the one-shot in SLOT 64, which is the shared 2.17 s stereo glass smash every course
 * bank carries and the largest reclaim any of them offers [Trailmap: 260-slot-64]. That is a claim about the
 * engine as much as about bytes: a mono LOOP written there and sustained freezes the level clock, so this
 * course is now the standing evidence that a mono ONE-SHOT there does not. The bank came to 290,912 of
 * 324,992 — 34,080 spare, against 1,696 when the same clip sat in slot 83.
 *
 * The clips are short because a bed that only sounds right for never wrapping would hide the defect these
 * cells exist to catch. Note what the roomier margin costs: at 1,696 bytes this fixture was also a live test
 * of the budget REFUSAL, and it is not any more — one careless clip length used to trip the refusal loudly,
 * and now there is 34 KB of slack to absorb it. That path is covered by `260-bank-budget`'s own builds
 * rather than here.
 *
 * `amb-retail-course-slot` did NOT come back silent, and that is the batch's real finding. It started a
 * voice on all three passes and held it for essentially the whole time it was resident (250/246/259), on a
 * retail slot carrying no loop region whatever. So the pool grades ALLOCATION, not audibility: the engine
 * will happily hand a voice to a sample that stops. That is precisely why the cell was predicted rather than
 * asserted, and why the bank reader now exists beside the probe — between them, "a voice started" and "the
 * bytes it was pointed at sustain" are separate claims that can each fail alone.
 */
export const AUTO_TEST_AUDIO_CASES: readonly AutoTestCase[] = [
  {
    id: 'ctl-retail-bag',
    question: 'Control: the retail crash bag every course here leads with. A run where this stays dark '
      + 'indicts the harness or the menu prelude, so nothing below it is worth reading.',
    shape: 'bag', profile: profile(1), color: [1, 1, 1, 1],
    expect: 'dispatch', demonstrated: FIRST_LIVE_PASS,
  },
  {
    id: 'amb-retail-bank',
    question: 'Does a placed emitter carrying a RETAIL global event sound? It loads a whole named bank of '
      + 'its own and needs nothing injected, so it is the control that separates the placed-emitter path '
      + 'from anything this toolchain does to a course bank.',
    shape: 'gate', profile: profile(1), color: [0.3, 0.6, 1, 1],
    expect: 'dispatch', demonstrated: AUDIO_BATCH,
    ambient: { event: 116, expect: 'sounds' },
  },
  {
    id: 'amb-retail-course-slot',
    question: 'A RETAIL event resolving to a course-bank SLOT, used as a continuing emitter — the branch the '
      + 'custom cells take, which the bank control above does not. Predicted silent, and it is NOT: it holds '
      + 'a voice for its whole residency on a slot with no loop region, which is what makes the pool a '
      + 'measure of allocation rather than of sound.',
    shape: 'gate', profile: profile(1), color: [0.6, 0.6, 0.6, 1],
    expect: 'dispatch', demonstrated: AUDIO_BATCH,
    ambient: { event: 31, expect: 'open' },
  },
  {
    id: 'amb-custom-loop',
    question: 'Does a CUSTOM continuing emitter sound? This is the whole injection path — a reserved event '
      + 'id, the clip encoded into the target course bank, and a loop region on the slot. It shipped silent '
      + 'for want of the last of those.',
    shape: 'gate', profile: profile(1), color: [0.3, 1, 0.5, 1],
    expect: 'dispatch', demonstrated: AUDIO_BATCH,
    ambient: { tone: 'loop', expect: 'sounds' },
  },
  {
    id: 'amb-custom-gated',
    question: 'Is a hit-gated custom emitter silent until its prop is hit, and sounding afterwards? Both '
      + 'halves matter: the second is the feature, and the FIRST is this course\'s silence control — a pass '
      + 'where everything sounds has to fail somewhere.',
    shape: 'gate', profile: profile(1), color: [1, 0.8, 0.2, 1],
    expect: 'dispatch', demonstrated: AUDIO_BATCH,
    ambient: { tone: 'gated', hitGated: true, expect: 'gated' },
  },
  {
    id: 'amb-custom-hit',
    question: 'A custom collision one-shot, carried by the same injection. Ungraded here on purpose: a '
      + 'one-shot is a transient voice rather than a pool entry, so the probe cannot see it — what it '
      + 'proves is that its bank slot comes out UNlooped while its neighbours come out looped. It is also '
      + 'the course\'s standing evidence that a one-shot may overwrite slot 64, the shared stereo glass '
      + 'smash, which a sustaining clip may not.',
    shape: 'gate', profile: profile(1), color: [0.9, 0.4, 0.9, 1],
    expect: 'dispatch', demonstrated: AUDIO_BATCH,
    collisionTone: 'hit',
  },
];

export interface AutoTestFixture {
  name: string;
  /** One line on what this course is for — the difference between the demo and the bench. */
  purpose: string;
  cases: readonly AutoTestCase[];
  /** The instrument strips, when this course carries them: full-width painted SurfaceType bands laid down
   *  the fall line BELOW the cells, so the cells ride identical approach paint on every fixture. */
  strips?: readonly AutoTestSurfaceStrip[];
  /** The mountain this course expects. Solo unless its questions are ABOUT having company. */
  mode: AutoTestMode;
  /**
   * Metres from the start gate to the first cell, when this course needs more than the default 140.
   *
   * A course ridden ALONE needs no lead-in to speak of: the rider leaves the gate on the fall line and stays
   * there. A course ridden with a field is a different problem, and it is a distance rather than a size —
   * measured, the pack takes about 200 m to sort itself out, and until it has, where the player is across the
   * corridor is decided by five other boards rather than by the course.
   */
  leadInM?: number;
  /** A fixture-owned sampling bound when course length alone cannot predict the run. AUTOTEST7 spends a
   *  deliberate second observing each solid response before relaying, so its clock belongs with the course. */
  windowFrames?: number;
}

/**
 * The courses the harness can build, and there are two kinds.
 *
 * GOLD is the regression test: the short, tight course of facts that must not break. It is named because its
 * job never changes — a gold test is a gold test whatever is in it.
 *
 * The AUTOTEST courses are the extensive ones, where the work happens: open questions, exceptional setups,
 * an instrument whose terrain is the experiment. They are NUMBERED rather than named after their contents
 * because that is exactly what does change — cells graduate off the bench and a course called AUTOTEST_GATES
 * would be a lie one batch later. The number is also what a spec citation pins a measurement to, so it is
 * stable in the one direction that matters.
 */
export const AUTO_TEST_FIXTURES: readonly AutoTestFixture[] = [
  {
    name: AUTO_TEST_GOLD_NAME,
    purpose: 'The regression test, and the one to ride by default. One cell per mechanism, short enough to '
      + 'fit the solo mountain — so a red row is news rather than weather.',
    cases: AUTO_TEST_GOLD_CASES, mode: 'showoff',
  },
  {
    // RACE, and not by preference — the full catalogue does not FIT in a showoff run. Measured: a showoff
    // pass ended (level restarted) at 128.6 s with the rider 2,660 m into 6,110 m, leaving 38 of 67 cells
    // unreached in one contiguous block from 2,750 m down; three race passes ran their full 240 s window and
    // reached ~5,900 m with 3-4 unreached. A showoff event is a timed run of about two minutes, and this
    // course needs four.
    //
    // That is what GOLD exists for, and why the two are not the same course. Riding this one costs the rider
    // lottery — every rider-acting opcode is handed the boarder its effect thread owns rather than whoever
    // touched the prop, so with five opponents a cell reading the PLAYER is reading a coin flip. It is
    // tolerable here because almost every cell in the catalogue grades dispatch, which does not care whose
    // contact built the node; the rider-graded cells are on GOLD, the bench and the field, which all ride
    // alone.
    name: AUTO_TEST_NAME,
    purpose: 'The catalogue, first half. Every cell is a fact hardware has demonstrated — ride this and '
      + 'AUTOTEST1B for the full sweep, or GOLD for the regression subset.',
    cases: AUTO_TEST_CASES, mode: 'race',
  },
  {
    // The catalogue outgrew one course. At 70 cases its last row sat at 6,350 m against the ~5,900 m a race
    // pass reaches, so six rows could never report — and the cost of that was not only the six: it taxed
    // every future graduation, because anything added to the bottom pushed something else out of reach.
    name: AUTO_TEST_NAME_B,
    purpose: 'The catalogue, second half. Same job as AUTOTEST1 and the same standard of evidence; it is a '
      + 'separate course only because one race pass cannot reach 70 cells.',
    cases: AUTO_TEST_CASES_B, mode: 'race',
  },
  {
    name: AUTO_TEST_LAB_NAME,
    purpose: 'The bench. Open questions only — cells here assert nothing until a batch has answered them.',
    cases: AUTO_TEST_LAB_CASES, mode: 'showoff',
  },
  {
    name: AUTO_TEST_FIELD_NAME,
    purpose: 'The field. The only course ridden with company, for the questions that are ABOUT company.',
    cases: AUTO_TEST_FIELD_CASES, mode: 'race', leadInM: FIELD_LEAD_IN_M,
  },
  {
    name: AUTO_TEST_SIGNALS_NAME,
    purpose: 'The instrument. The terrain is the experiment: painted surface strips ridden straight while '
      + 'the harness samples the board-audio interface signals (Slip / Dig / Lean).',
    cases: AUTO_TEST_SIGNALS_CASES, mode: 'showoff',
    strips: AUTO_TEST_SIGNAL_STRIPS,
  },
  {
    name: AUTO_TEST_RELAY_NAME,
    purpose: 'The relay. Asks whether a teleport moves the rider — the one opcode that could make a course '
      + 'something other than a single line, and the thing a lane-based fixture would rest on.',
    cases: AUTO_TEST_RELAY_CASES, mode: 'showoff',
  },
  {
    name: AUTO_TEST_CALL_NAME,
    purpose: 'The call. Asks what a MainType-21 node does with an authored function — whether the body runs '
      + 'at all, and whether it is handed the rider who touched the caller.',
    cases: AUTO_TEST_CALL_CASES, mode: 'showoff',
  },
  {
    name: AUTO_TEST_COLLISION_NAME,
    purpose: 'The migrated collision lab. The original sixteen-cell live matrix plus its mode-1 bounce-off '
      + 'follow-up, linearized and graded on both contact dispatch and the rider\'s contact impulse.',
    cases: AUTO_TEST_COLLISION_CASES, mode: 'showoff', windowFrames: 4800,
  },
  {
    name: AUTO_TEST_AUDIO_NAME,
    purpose: 'The audio bench. Placed ambient emitters, graded on whether the engine actually started a '
      + 'voice for them rather than on whether a node got built — which is the only question ambience has.',
    cases: AUTO_TEST_AUDIO_CASES, mode: 'showoff',
  },
];

export function autoTestFixture(name: string): AutoTestFixture {
  const found = AUTO_TEST_FIXTURES.find(fixture => fixture.name.toUpperCase() === name.toUpperCase());
  if (!found) {
    throw new Error(`No auto-test fixture named ${name}. Known: `
      + AUTO_TEST_FIXTURES.map(fixture => fixture.name).join(', '));
  }
  return found;
}
