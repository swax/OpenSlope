import type { EffectGraph, EffectNode, JsonObject } from './document';
import { nativeArgbFieldsFromRgbaColorStops, type RgbaColor } from './emitter-colors';
import {
  effectCircumstanceLabel,
  type AuthoredEffectCircumstance,
  type EffectCircumstance,
  type EffectLatchCircumstance,
} from './authoring-contract';

export interface EffectType {
  circumstance: AuthoredEffectCircumstance;
  label: string;
  /** One line: what makes this effect run. Always visible. */
  summary: string;
  /** Usage guidance for authors who need it, shown on demand. Omit when the summary is the whole story. */
  detail?: string;
}

/** The three moments Slopesmith can author an effect for. */
export const EFFECT_TYPES: readonly EffectType[] = [
  { circumstance: 'persistent', label: 'Persistent effect',
    summary: 'Runs by itself, the whole time this part of the mountain is loaded.' },
  { circumstance: 'collision', label: 'Collision effect',
    summary: 'Runs when the rider touches this prop or its trigger box.' },
  { circumstance: 'trigger', label: 'Trigger effect',
    summary: 'Runs later, when a Counter on this prop finishes counting or a Cracked surface gives way.',
    detail: 'Nothing else can start a Trigger effect — riding into the prop will not — so one with neither a '
      + 'Counter nor a Cracked surface feeding it never runs.\n\n'
      + 'What can go in it depends on which of the two fires it. After a COUNTER, use Run on another prop and '
      + 'nothing else: the counter is still mid-update when this runs, so a node that installs on THIS prop '
      + 'pulls the counter out from under itself and freezes the console. After a CRACKED SURFACE there is no '
      + 'such limit, which is why the whole break goes here — the shatter sound, the kill, and whatever the '
      + 'broken surface should reveal.' },
] as const;

/** Compact graph identity for prop-centric trees. Prefer the native provenance index; authored graphs fall
 * back to the numeric portion of their stable graph ID. */
export const effectGraphDisplayName = (graph: EffectGraph, circumstance: EffectCircumstance): string => {
  const stableNumber = /^graph:(\d+)$/.exec(graph.id)?.[1];
  const identity = graph.originalIndex ?? (stableNumber === undefined ? graph.id : Number(stableNumber));
  return `${effectCircumstanceLabel(circumstance)} Effect ${identity}`;
};

/**
 * Slopesmith's portable join from an effect slot to an authored level object. The join deliberately lives in
 * Effects.json extensions: Unity can consume it with the graph, while P4 can compile the stable prop id to the
 * final Instances.json index/EffectSlotIndex after authored props have been packed.
 */
export interface EffectAttachment {
  id: string;
  target: { kind: 'prop'; id: string };
  slot: string;
  circumstance: EffectCircumstance;
  enabled: boolean;
}

export interface EffectAuthoringIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export type EffectTemplateId = 'empty' | 'collision-trigger' | 'timer-emitter' | 'collision-emitter' | 'uv-scroll' | 'wait' | 'sound' | 'speed-boost' | 'trick-boost' | 'rider-reset'
  | 'roller' | 'anim-object' | 'one-shot-clip' | 'spline-animation' | 'breakable-kill' | 'mesh-animation'
  | 'texture-flip' | 'texture-flip-dwell' | 'ride-over-button'
  | 'material-texture-frame' | 'material-uv-offset' | 'anim-delta-grant' | 'counter-mark' | 'counter-decrement'
  | 'anim-combo-trigger' | 'instance-flag-set' | 'instance-flag-clear' | 'breakable-permanent' | 'cracked'
  | 'act-on-instance' | 'rider-teleport' | 'spline-toggle' | 'z-boost' | 'call-function'
  | 'debounce' | 'counter' | 'directional-boost' | 'lap-boost' | 'fence' | 'flag' | 'crowd-box' | 'score-multiplier'
  | 'anim-delta' | 'anim-combo'
  | 'gate-speed' | 'gate-random' | 'gate-human' | 'gate-no-live-node'
  | 'node-destroy' | 'node-pause' | 'node-tombstone'
  | 'show-message';
export type EffectNodeTemplateId = Exclude<EffectTemplateId, 'empty' | 'collision-trigger'>;
/**
 * What a template IS, which is what the picker groups by.
 *
 * `container` lays down an empty graph to build in. `node` is one native node the author composes with
 * others — the vocabulary itself. `recipe` is several nodes laid down together because they are inert apart:
 * a flip with no frame select paints nothing, a play-once clip with no latch reverts the moment it ends.
 * Stating it beats inferring it from `nodes.length`, which would call any future two-node node a recipe.
 */
export type EffectTemplateKind = 'container' | 'node' | 'recipe';

/**
 * What a live PS2 run has demonstrated about a template, and where to go and check.
 *
 * The bar is deliberately narrow, because a badge that means "probably fine" is worse than no badge: an
 * authored document carrying this template was packed into a real ISO, ridden by the auto-test harness, and
 * the node was seen DOING ITS JOB — not merely being constructed. `observed` states exactly what was read,
 * and it is what the claim amounts to.
 *
 * A node demonstrated to do NOTHING does not belong here even though the evidence is just as good. The lap
 * boost builds perfectly and lifts nobody on any course but Megaplex; the roller builds and never moves its
 * host. Those findings live in the template's own description and in the authoring validator, where they read
 * as the warnings they are, instead of under a heading an author scans for "these work".
 *
 * The evidence lives in `Trailmap/tools/autotest`; `cell` names the fixture cell that carries it, so any claim
 * here can be re-run rather than taken on trust.
 */
export interface EffectTemplateProof {
  cell: string;
  run: string;
  observed: string;
}

/**
 * Copy for a template, in two tiers, because two different questions get asked at two different moments.
 *
 * `summary` answers "what will this do?" — the question at the moment of choosing, and the one an author
 * re-asks every time they reopen the effect. It is always visible, in the picker and on the node itself, and
 * it is one or two plain sentences: what the node does, and the one thing needed to use it properly.
 *
 * `detail` is for the author who has chosen it and hit something. It carries usage guidance that genuinely
 * changes what someone builds — that a Cracked surface needs a Trigger effect, that a Spline mover hides its
 * own prop — and nothing else. It is NOT where the reverse-engineering record goes: what a PS2 was seen to do
 * belongs in `proven`, which renders as its own tier, and the evidence behind a claim belongs in Trailmap.
 * A caveat that a validator can test belongs in `validateEffectsAuthoring` instead of either field, where it
 * fires on the prop that has the problem rather than being read hopefully in advance.
 */
export interface EffectTemplate {
  id: EffectTemplateId;
  label: string;
  summary: string;
  detail?: string;
  kind: EffectTemplateKind;
  circumstance: EffectCircumstance;
  /** Present when hardware has run this template and the harness read back what it did. The picker sorts
   *  these first: what an author most wants to know at the moment of choosing is which of these actually
   *  works on a PS2, and that answer is worth more than alphabetical order. */
  proven?: EffectTemplateProof;
  /** The chain this template lays down, in dispatch order. Most templates are one node the author then
   *  composes with others; a few are recipes whose nodes are meaningless apart (a flip node with no frame
   *  select paints nothing) and are therefore laid down together. */
  nodes?: readonly Omit<EffectNode, 'id'>[];
  /** Latch columns this template populates on the host slot (each as an empty sentinel graph). */
  latches?: readonly EffectLatchCircumstance[];
}

const DEFAULT_TIMER_COLORS_RGBA: readonly RgbaColor[] = [
  [1, 1, 1, 1],
  [1, 1, 1, 0.75],
  [1, 1, 1, 0.35],
  [1, 1, 1, 0],
];

const timerPayload = (): JsonObject => ({
  type2: {
    SubType: 0,
    type2Sub0: {
      U0: 40, U1: 1, U2: 0.3, U3: 1,
      U4: 100, U5: 0, U6: 100, U7: 0, U8: 0,
      U9: 0, U10: 0, U11: 0,
      U12: 0, U13: 0, U14: 0, U15: 0, U16: 0, U17: 0,
      U18: 0, U19: 0, U20: 1000, U21: 0, U22: 0, U23: 0,
      U24: 0, U25: 0, U26: 1000, U27: 0, U28: 0, U29: 0,
      U30: 0, U31: 0, U32: -300,
      ...nativeArgbFieldsFromRgbaColorStops(DEFAULT_TIMER_COLORS_RGBA),
      U49: 0, U50: 1,
    },
  },
});

const COLLISION_EMITTER_WORD = new DataView(new ArrayBuffer(4));
const collisionEmitterRawFloat = (value: number): number => {
  COLLISION_EMITTER_WORD.setFloat32(0, Math.fround(value));
  return COLLISION_EMITTER_WORD.getInt32(0);
};

/** UNTRACK Effect 10's recovered SnowGhost burst. SubType 2 stores its P6 floats as raw integer words. */
const collisionEmitterPayload = (): JsonObject => {
  const raw: JsonObject = { U0: 50, U1: 0 };
  const values = [
    0.01, 1, 200, 2, 100, 1, 0.03,
    33.3, 1243, -44,
    0, 0, 500, 500, 0, 0,
    0, 0, 800,
    0, 0, 150, 800, 0, 0, 0, -800, 0,
    0, 0, 300,
    0.04, 0.74, 0.84, 0.97,
    0, 0, 0, 0.4,
    0.1, 0.1, 0.1, 0.1,
    0, 0, 0, 0,
  ];
  values.forEach((value, index) => { raw[`U${index + 2}`] = collisionEmitterRawFloat(value); });
  raw.U49 = 2; // clod: the snow-burst sprite
  raw.U50 = 0; // additive
  return { type2: { SubType: 2, type2Sub2: raw } };
};

/** A Play sound node's authored WAV, when one is assigned instead of a retail bank slot.
 *
 * The native payload a MainType-8 node compiles to is only ever `SoundPlay`: a number naming a course-bank
 * slot. The file name therefore rides the node's own extensions rather than the payload — export stages the
 * WAV into a reserved slot and writes that slot into `SoundPlay`, so the compiled SSF stays exactly the shape
 * the engine reads while the editor keeps the authored intent. `references` is not the home for this: those
 * are stable ids Snowknife compacts back to native table indices. */
export const effectNodeSoundFile = (node: EffectNode): string | null => {
  if (node.mainType !== 8) return null;
  const file = (node.extensions?.slopesmith as JsonObject | undefined)?.soundFile;
  return typeof file === 'string' && file ? file : null;
};

export function setEffectNodeSoundFile(node: EffectNode, file: string | null): void {
  const slopesmith = ((node.extensions ??= {}).slopesmith ??= {}) as JsonObject;
  if (file) slopesmith.soundFile = file;
  else delete slopesmith.soundFile;
  if (!Object.keys(slopesmith).length) delete node.extensions!.slopesmith;
  if (node.extensions && !Object.keys(node.extensions).length) delete node.extensions;
}

/** The batches the gold map's cells were graded from. Named once so a template's provenance cannot drift
 *  from the fixture's. */
const FIRST_PASS = 'runs 20260806-002051 / -002503';
const GATE_BATCH = 'runs 20260806-072247 / -072612 / -072938';
const BUTTON_RUN = 'run 20260806-061609';
/** The bench batch that settled the speed gate's selector and measured the two boost nodes. */
const SPEED_SWEEP = 'runs 20260806-081511 / -081741 / -082007 (AUTOTEST2)';
// The bench batch that settled the speed gate's threshold word and the units it is compared in:
// runs 20260806-083132 / -083333 / -083533 (AUTOTEST2). No entry below cites it by name.
/** The bench batch that showed the at-least selector has to be bit-exact before it gates at all. */
const SELECTOR_BATCH = 'runs 20260806-090633 / -090834 / -091034 (AUTOTEST2)';
/** The bench batch that measured the reset and both pad opcodes. */
const RESET_BATCH = 'runs 20260806-101357 / -101611 / -101822 (AUTOTEST2)';
/** The bench batch that traced the breakable kill and measured the rider-facing nodes. */
const PAD_BATCH = 'runs 20260806-100330 / -100532 / -100734 (AUTOTEST2)';
/** The bench batch that settled node lifetime, chain sequencing, the two instance-flag commands and the
 *  persistent circumstance. */
const LIFETIME_BATCH = 'runs 20260806-113339 / -113606 / -113832 (AUTOTEST2)';
/** The bench batch that settled both suppression latches and the three bound-node receivers whose state
 *  words had just been recovered. */
const LATCH_BATCH = 'runs 20260806-125111 / -125326 / -125541 (AUTOTEST2)';
/** The batch that first read the clip BUDGET word at a live address. `LATCH_BATCH` watched it one node over
 *  at `+0x68` and got the allocator's `0xdeadc0ed` poison in all three passes — a null shaped like a real
 *  reading — so the budget claim rests on these and on the thirty-odd later catalogue runs that repeat them,
 *  never on the batch that recovered the rest of that cell. */
const BUDGET_BATCH = 'runs 20260806-130226 / -130441 / -130654 (AUTOTEST2), repeated in 30 later runs';
// The bench batch that proved the trigger circumstance, and the two before it that established what may not
// go in one: runs 20260806-141550 / -141750 / -141948 (AUTOTEST2). No entry below cites it by name.
/** The bench batch that separated a flip's own clock from a command addressed to it, timed the dwell screen,
 *  and packed the first authored spline mover. */
const FLIP_BATCH = 'runs 20260806-151423 / -151624 / -151824 (AUTOTEST2)';
// The bench batch that caught both pad opcodes writing their fields, two passes of three:
// runs 20260806-172756 / -172947 / -173137 (AUTOTEST2). No entry below cites it by name.
/** The bench batch that settled the two-stage break: both payload fields, the damage arithmetic, the heal,
 *  and the deferred fire read off a companion the rider never touched — with a strength-1000 twin beside it
 *  as the negative control. */
const CRACKED_BATCH = 'runs 20260807-075619 / -075854 / -080130 and -081545 / -081921 / -082206 (AUTOTEST2)';
/** The relay batch: an authored teleport, ridden alone against a destination nothing else could reach. */
const TELEPORT_BATCH = 'runs 20260807-165202 / -165433 / -165613 (AUTOTEST5, showoff)';
/** The field batch: the same teleport behind a human-rider gate, with five opponents and every rider's
 *  position sampled — so "which of six moved" is a reading rather than an inference. */
const FIELD_WARP_BATCH = 'runs 20260807-183720 / -183922 / -184123 (AUTOTEST3, race, roster trace)';
/** The bench pass ridden in SHOWOFF — one rider on the mountain instead of six — where every pad on the
 *  course wrote in a single run. It is the one that explains the other batch's misses. */
const PAD_SOLO_BATCH = 'run 20260806-225818 (AUTOTEST2, showoff)';
/** The gold-map batch that read a spline mover's own travel out of the heap. Short windows (`--frames
 *  14400`), because the search needs the measured level to still exist and finishing the race replaces it. */
const MOVER_BATCH = 'runs 20260806-185405 / -185914 / -190525 (AUTOTEST1, --frames 14400)';
/** The bench batch that rode into a play-once clip and watched the latch keep the finished node. */
const CONTACT_CLIP_BATCH = 'runs 20260806-193236 / -193432 / -193633 (AUTOTEST2)';
/** The bench batch that measured how far a boost node THROWS, at retail's own tuning and retail's own box
 *  size — the number every port of this family needs and no earlier batch had. */
const THROW_BATCH = 'runs 20260806-203550 / -203635 / -203900 (AUTOTEST2, --turbo 3)';
/** The batch that rode the first authored FUNCTION ever packed, and answered both halves of what a call does
 *  with one: that the body runs, and that it is handed the caller's rider. */
const CALL_BATCH = 'runs 20260807-230446 / -230633 / -230815 (AUTOTEST6, showoff)';

export const EFFECT_TEMPLATES: readonly EffectTemplate[] = [
  { id: 'empty', kind: 'container', label: 'Empty effect', summary: 'Create an effect with no nodes, so you can build it up yourself.', circumstance: 'persistent' },
  { id: 'collision-trigger', kind: 'container', label: 'Collision trigger', summary: 'Create an empty effect that runs when the rider touches this prop or its trigger box.', circumstance: 'collision',
    proven: { cell: 'auth-gate-m1', run: FIRST_PASS, observed: 'A collision graph attached to an authored model dispatches on contact: the live-node slot on that instance went from empty to occupied as the rider crossed. This is the fact every other cell is built on.' } },
  // The most-ridden node in the whole vocabulary, by an accident worth knowing: the auto-test fixtures mark
  // every cell with one of these, so the 51-word record has packed and reached a PS2 in sixty-odd chains.
  // It carries no badge and the bar is the reason — a run reads memory, and what an emitter does is pixels.
  //
  // What the marker could never show is what happens BEHIND one, since it is always the last node in its
  // chain, and a MainType-2 node is exactly the kind that could end a chain unnoticed: it builds no property
  // node, so it leaves no trace of its own either way. Both columns now answer it (cells `emitter-burst`,
  // `emitter-persistent`), which is what the description below records.
  { id: 'timer-emitter', kind: 'node', label: 'Particle emitter', summary: 'Emit particles from the prop\'s origin while this effect runs. Drag the purple handle to move where they come from.', circumstance: 'persistent',
    detail: 'It can sit anywhere in an effect — the nodes after it still run.',
    nodes: [{ mainType: 2, semanticType: 'particle.timer', payload: timerPayload(), references: {} }] },
  { id: 'collision-emitter', kind: 'node', label: 'Snow collision burst',
    summary: 'Burst snow from the exact point the rider touches, launched away from that surface.',
    circumstance: 'collision',
    detail: 'This is the dedicated contact emitter recovered from UNTRACK’s SnowGhost trees, including their '
      + '50-particle clod-sprite law, 800 cm/s normal launch and half-second native re-fire gate. Its origin and '
      + 'direction come from each live contact; the authored velocity vector supplies only the speed. Add it to a Collision effect; putting '
      + 'it in a Persistent effect would construct it without the contact event it is meant to answer.',
    nodes: [{ mainType: 2, semanticType: 'particle.collision', payload: collisionEmitterPayload(), references: {} }] },
  // The cell that demonstrated the PERSISTENT circumstance runs at all on an authored level: a graph with no
  // contact behind it, installed and holding its instance while the rider was still 7 s up the course. That
  // is a fact about the column rather than about this node, so it rides on every persistent template's
  // description — including the timing, which is the part that changes how one is placed: a persistent effect
  // comes up 4-8 s ahead of the rider, cell by cell, NOT when the level opens. It is scoped to its stretch of
  // mountain. What none of these cells reads is the effect itself; pixels are not in this harness's reach.
  { id: 'uv-scroll', kind: 'node', label: 'UV scroll', summary: 'Slide a material\'s texture continuously, for flowing water or a moving conveyor. Runs on its own — nothing to ride over.', circumstance: 'persistent',
    proven: { cell: 'ctl-uv-phase / persist-uv-scroll', run: LATCH_BATCH,
      observed: 'It SCROLLS. The node\'s own U phase advances every sample for as long as it lives, and its rate word reads back the exact authored -0.02 — a coordinate moving over time is what this node is, so this is the effect rather than the allocation. It also installs and runs with no contact of any kind, seven seconds ahead of the rider, which is what demonstrated the persistent column. The pixels are still not read: the harness reads memory.' },
    nodes: [{ mainType: 0, semanticType: 'property.uv-scroll',
      payload: { type0: { SubType: 10, UVScroll: { U0: 0, U1: -0.02, U2: 0, U3: 1, U4: 0, U5: 0 } } }, references: {} }] },
  { id: 'wait', kind: 'node', label: 'Wait', summary: 'Pause for a number of seconds before running the nodes below it. This is what spaces two actions apart instead of firing them at once.', circumstance: 'trigger',
    proven: { cell: 'wait-delays-kill / dead-destroy / flag-set-clear', run: LIFETIME_BATCH,
      observed: 'It holds its chain for the second it was authored with, measured three separate ways in three passes: the gap between a node being built and a breakable kill hiding the prop behind it (1.017 s, against zero when they share a chain position), the shortening of a Cooldown\'s life by a lifetime command behind a Wait (0.98-1.07 s), and an instance flag set and then cleared a Wait apart (1.00-1.02 s).' },
    nodes: [{ mainType: 4, semanticType: 'wait', payload: { WaitTime: 1 }, references: {} }] },
  { id: 'sound', kind: 'node', label: 'Play sound', summary: 'Play an uploaded WAV file, or one of the sounds already in the course sound bank.', circumstance: 'trigger',
    nodes: [{ mainType: 8, semanticType: 'audio.play', payload: { SoundPlay: 0 }, references: {} }] },
  // Not a retail opcode. Retail sends main type 12 to its dispatcher's inert default, so a level carrying
  // one of these runs unchanged on a normal disc — the node only does anything on an image built with
  // `--patches hud-text`, which is also the only build that keeps it (the repack strips it otherwise). The message
  // rides inline in the node's own payload rather than in a string table, because effect nodes are variable
  // length and the engine's chain walker advances by each node's own size [Trailmap: 443-debug-text].
  { id: 'show-message', kind: 'node', label: 'Show message', summary: 'Put a line of text on screen while riding. A build-time debugging aid: it is left out of ordinary discs, so it shows nothing unless the image was built for it.', circumstance: 'collision',
    detail: 'Shows where the banner the lap counter and CHECKPOINT use appears, for as long as those do.\n\n'
      + 'The colour is per message, as three 0-1 channels, so several messages on one course can be told '
      + 'apart at a glance rather than by reading them.\n\n'
      + 'Meant for answering "did this effect actually run, and when" on a real console without a debugger '
      + 'attached — not for anything a player should read.',
    nodes: [{ mainType: 12, semanticType: 'hud.message',
      payload: { HudText: '', HudRed: 1, HudGreen: 1, HudBlue: 1 }, references: {} }] },
  // The two pads write what they claim, and the number they write is a COUNTDOWN IN SECONDS rather than an
  // amount: the shared motion update subtracts 1/60 from each field every tick and clamps it at zero, so an
  // authored 5 buys five seconds of raised speed cap or trick window. Nothing else in the ELF writes +0x134;
  // +0x138 is additionally zeroed outright, with its +0x13c flag, when the rider enters the air state.
  //
  // WHO the pad services is not the rider who touched it. Both opcodes act on the boarder the effect thread
  // was built with, so in a race the local human is one candidate among six and a pass can report the chain
  // firing while the field never moves — which is what made these look dead for so long
  // (Trailmap/tools/autotest, cells `speed-pad`/`trick-pad`).
  //
  // That is a property of the MOUNTAIN rather than of the pad, and the measurement that settles it is riding
  // the same fixture with one rider on it: every pad on the course then writes in a single pass, against 3
  // passes in 42 in a six-rider race. So there is nothing an author can do about it and nothing that needs
  // doing — it is what the retail node does, and a player in a crowded race genuinely gets some of them.
  // Placement does not change it: proximity was eliminated directly (0.08 m from a pad wrote nothing on one
  // pass; 1.15 m wrote on the next).
  { id: 'speed-boost', kind: 'node', label: 'Speed boost', summary: 'Raise the rider\'s speed limit for a few seconds after they touch it. The number is SECONDS, not an amount of speed.', circumstance: 'collision',
    detail: 'There is no push in it, so it cannot get a stopped rider moving — it only lets a moving one go faster.\n\n'
      + 'In a race the boost goes to one rider at a time rather than to whoever touched the pad, so expect a '
      + 'field to share these out. Riding alone, every pad fires. Nothing about placement changes it.',
    proven: { cell: 'speed-pad', run: PAD_SOLO_BATCH,
      observed: 'It writes the authored 5.0 into the rider\'s boost request, and the rider moved 2.23 m between samples across the pad against a 1.62 m baseline everywhere else — the raised cap, visible on its own. Whether YOU get it depends on how busy the mountain is rather than on where the pad sits: it services the boarder its effect thread was handed, so alone on the course every pad fires, while in a six-rider race it landed on the local human 3 passes in 42. Nothing about placement changes that — a pass came within 0.08 m and got nothing while the next got it from 1.15 m — so place these for the line you want ridden and expect a race to share them out.' },
    nodes: [{ mainType: 17, semanticType: 'rider.boost', payload: { type17: 5 }, references: {} }] },
  { id: 'trick-boost', kind: 'node', label: 'Trick boost', summary: 'Speed up the rider\'s spins for a few seconds after they touch it. The number is SECONDS.', circumstance: 'collision',
    detail: 'The window also ends the moment the rider leaves the ground, so a pad right on a lip spends most '
      + 'of its time before the trick it was meant for. Put it far enough back that the rider is still on the '
      + 'snow.\n\nLike Speed boost, a race shares these out across the field rather than giving one to whoever '
      + 'touched the pad.',
    proven: { cell: 'trick-pad', run: PAD_SOLO_BATCH,
      observed: 'It writes the authored 5.0 into the trick window, alongside the speed pad above reading exactly its own 5.0 less the elapsed time between the two contacts — two opcodes, two fields, one arithmetic. Alone on the mountain both pads land every pass; in a six-rider race they are shared out with the field, which is the node behaving as it ships rather than anything to author around.' },
    nodes: [{ mainType: 18, semanticType: 'trick.boost', payload: { type18: 5 }, references: {} }] },
  { id: 'rider-reset', kind: 'node', label: 'Reset zone', summary: 'Put the rider back on the course when they touch this. Use it for water and for the edges of the map.', circumstance: 'collision',
    detail: 'It moves the rider by however far off the line they already were, so one placed where a rider is '
      + 'already fine barely moves them. Put these where someone actually gets lost.',
    proven: { cell: 'rider-reset', run: RESET_BATCH,
      observed: 'It carries the rider back onto the course, in a single sample, three passes of three — 2975-2983 m of it, on a run that had left a short course entirely. The distance is how far off the line they already were rather than a fixed destination, so a rider who is ON the line is moved barely at all: place one where somebody is actually lost, not where they are already fine. Ordinary motion is under 2.5 m a sample, which is what makes the move unmistakable when there is one to make.' },
    nodes: [{ mainType: 13, semanticType: 'rider.reset', payload: { type13: 0 }, references: {} }] },
  { id: 'roller', kind: 'node', label: 'Roller / knockable prop', summary: 'Turn this prop into something the rider can knock out of the way. Mass starts at the crash-bag weight.', circumstance: 'collision',
    nodes: [{ mainType: 0, semanticType: 'property.roller',
      payload: { type0: { SubType: 0, type0Sub0: { U0: 5, U1: 0.002, U2: 1.5, U3: 0, U4: 0, U5: 0 } } }, references: {} }] },
  // The breakable vocabulary (the retail hide-source / mesh-throw / model-clip nodes; Unity docs/036).
  // A ROLL-AWAY breakable (the city globe: hit -> the prop plays its own clip down the street -> crash) is the
  // chain [model clip (loop 0)] [wait] [sound] [breakable kill] [mesh throw], composed with the graph "+ Node"
  // append; defaults below are the retail globe's authored values.
  { id: 'anim-object', kind: 'node', label: 'Model clip', summary: 'Play the animation built into the model — a swinging bridge, a roll-away. The model must actually contain an animation clip.', circumstance: 'persistent',
    detail: 'Loops by default; a Trigger effect can use Play once instead.\n\n'
      + 'CHECK THE MODEL HAS A CLIP. On a model with no animation this still installs and runs, moving nothing, '
      + 'and nothing anywhere says so. The Play window shown below is how you tell: a real clip has a window '
      + 'longer than zero.\n\n'
      + 'Only an imported model brings its animation through to the disc. A model borrowed from an extracted '
      + 'level arrives with an empty window however many frames it claims.',
    nodes: [{ mainType: 0, semanticType: 'property.anim-object',
      payload: { type0: { SubType: 256, type0Sub256: { U0: 1, U1: -1, U2: -1, U3: 30, U4: 0, U5: 1, U6: 0, U7: 3 } } }, references: {} }] },
  // The Elysium iris door's recipe, self-contained on one prop: contact plays the model's own clip ONCE
  // (retail effect 100's exact payload), and the two latch columns keep the finished pose — open — through
  // the node's self-end and the region unload [Trailmap: 150-logic §slot-columns].
  { id: 'one-shot-clip', kind: 'recipe', label: 'One-shot clip (door / gate)', summary: 'Riding into the prop plays its animation once and it stays in its final pose — a door that opens and stays open.', circumstance: 'collision',
    detail: 'The pose is kept through the area unloading too, so a rider who comes back finds the door still open.\n\n'
      + 'Give it a model whose animation actually has frames. A model with an empty clip reaches its end '
      + 'instantly and holds the pose it started in.',
    proven: { cell: 'clip-on-contact', run: CONTACT_CLIP_BATCH,
      observed: 'Ridden into in the recipe\'s own arrangement: the contact installs the clip — the slot holds the clip node itself, not the cooldown ahead of it — the node reaches its end, and the latch keeps it there where the same cell without it does not. The control released and rebuilt its node two to four times in the seconds the rider was on it, three passes of three, while the latched one filled once and held; and the clip-finished flag is readable only on the latched cell, because on the other one the node is gone before anything can read it. What that does NOT cover is a clip of any length: the model was a borrowed trick gem, whose play window reaches the runtime at zero, so the end being latched arrived on the node\'s first tick. The hold is the recipe\'s job and it does it; give it a model whose clip actually has frames (an imported one) and the same arrangement holds a pose that took time to reach.' },
    nodes: [{ mainType: 0, semanticType: 'property.anim-object',
      payload: { type0: { SubType: 256, type0Sub256: { U0: 0, U1: -1, U2: -1, U3: 30, U4: 0, U5: 1, U6: 0, U7: 3 } } }, references: {} }],
    latches: ['slot3', 'slot4'] },
  // The first authored mover ever packed and ridden. What a run can see is the host, and the host is the one
  // part of a mover that does NOT move: the copies keep their poses in a separate buffer rebuilt each tick
  // from the spline, and the class touches the instance's translation only in its constructor
  // [Trailmap: 230-level-ssf §splinemover]. So no badge — the same bar that keeps the roller out, arrived at
  // from the other side. Two things a run DID settle, and both change how one is placed:
  //   - the allocation survives, which was the open question. The packer prepends a no-live-node gate and a
  //     never-expiring debounce, and that debounce is what the harness sees holding the slot for the rest of
  //     the run — the shape every retail mover enters through.
  //   - the packed source prop is HIDDEN and takes no contact. An identical collision chain set an instance
  //     flag on an ordinary prop in every pass and never once on a mover's host, whose draw bits read
  //     undrawn from the first sample. A mover's own prop cannot also be a trigger; put the contact on a
  //     second placement and reach the mover with `act-on-instance`.
  { id: 'spline-animation', kind: 'node', label: 'Spline mover', summary: 'Send copies of this prop travelling along one of your motion paths, like the subway trains. The route loops by default.', circumstance: 'persistent',
    detail: 'The prop you attach it to becomes an invisible SOURCE: the moving copies are drawn elsewhere and '
      + 'the original is hidden. So do not expect to see it where you put it, and do not also give it a '
      + 'collision effect — nothing can touch it. Put the contact on a second prop and reach the mover from '
      + 'there with Run on another prop.',
    proven: { cell: 'spline-mover', run: MOVER_BATCH,
      observed: 'It runs, at the speed it was authored and around a route that loops. The mover\'s own distance-along-route word advances 2000 units a second against an authored 33.3333 a tick — 2000.0 is what that rate gives at 60 Hz — in three passes of three, and in the two whose window happened to span one, it wraps to near zero on reaching the route\'s end distance of 12715.7 and climbs again. Its host prop never moves an inch the whole time, which is the class working as designed rather than a fault: the engine draws copies elsewhere and hides the original.' },
    nodes: [{ mainType: 2, semanticType: 'spline.animation',
      payload: { type2: { SubType: 1, SplineAnimation: {
        U1: 1, U2: 0, InstanceCount: 1, AnimationSpeed: 20, U5: 0, U6: 0, U7: 1, R: 1, G: 1, B: 1,
      } } }, references: { spline: null } }] },
  // The hide is real and it is BOUNDED BY THE NODE. An ordered trace of the instance flag word against the
  // live-node slot puts both transitions on the same sample: the draw bit clears when the node is built and
  // returns when it is destroyed, three passes of three (Trailmap/tools/autotest, cell `breakable-kill-hides`).
  // The lasting mark is elsewhere — bit 0x0100 clears at teardown and stays clear, and what that bit means is
  // not recovered.
  //
  // Keeping a prop hidden past the node's own end is what the latch columns are for [Trailmap: 150-logic
  // §slot-columns], and WHICH latch is now measured rather than guessed: it is Region exit, not Effect end.
  // The kill's tombstone never reaches a self-end, so the Effect-end column is never consulted and a cell
  // carrying it behaved identically to one carrying nothing. What ends the tombstone is its region
  // unloading, and suppressing that keeps the prop hidden for good — the `breakable-permanent` recipe below.
  { id: 'breakable-kill', kind: 'node', label: 'Breakable kill', summary: 'Hide the prop while this node is running. It comes BACK when the node ends — use Breakable (permanent) if it should stay broken.', circumstance: 'collision',
    proven: { cell: 'breakable-kill-hides', run: PAD_BATCH,
      observed: 'It hides the prop. The instance flag word leaves the drawn state on the same sample the node appears in the effect slot, and returns to it on the same sample the node disappears — three passes of three, timestamps identical. The disappearance is therefore real and is bounded by the node\'s lifetime, not permanent. What ends up installed is a tombstone of its own kind, tagged sub-type 1006 rather than the plain 5 the other lifetime modes leave, which is the marker that stops a kill being reapplied.' },
    nodes: [{ mainType: 0, semanticType: 'property.breakable-kill',
      payload: { type0: { SubType: 5, DeadNodeMode: 4 } }, references: {} }] },
  // The kill plus the one latch that reaches it. Not a variant of the node — a different outcome — and it is
  // a recipe rather than a checkbox on the kill because the pairing is the whole content: the column is on
  // the SLOT while the node is in the chain, so an author who checks the wrong one of the two latch boxes
  // gets a prop that unbreaks itself and nothing anywhere to say why.
  { id: 'breakable-permanent', kind: 'recipe', label: 'Breakable (permanent)', summary: 'Riding into the prop hides it and it stays hidden, even after the rider leaves the area and comes back.', circumstance: 'collision',
    detail: 'This is the one to use for a break the player should not be able to undo. Plain Breakable kill '
      + 'reappears as soon as its node ends.',
    proven: { cell: 'latch-kill-region', run: LATCH_BATCH,
      observed: 'The prop goes and does not come back. Against an identical kill one field uphill with the column empty, three passes of three, byte-identical each time: both leave the drawn state on contact, the unlatched one is put back when its node is torn down, and this one is still undrawn at the end of the run with its slot still occupied. The Effect-end column was tried too and does nothing here — a kill\'s tombstone never self-ends, so only Region exit reaches it.' },
    nodes: [{ mainType: 0, semanticType: 'property.breakable-kill',
      payload: { type0: { SubType: 5, DeadNodeMode: 4 } }, references: {} }],
    latches: ['slot3'] },
  // The two-stage break, and the only breakable whose collision chain breaks NOTHING. It is here rather than
  // among the trigger nodes because the author lays it on the thing they ride: the shatter is a separate
  // Trigger effect on the same slot, and the description is what says so, since no validator can see that a
  // slot's trigger column is the other half of this node rather than an unrelated chain.
  { id: 'cracked', kind: 'node', label: 'Cracked surface', summary: 'Two-stage breakable glass: riding over it cracks it, and when its Strength runs out it runs THIS PROP\'S TRIGGER EFFECT — which is where you put the actual break.', circumstance: 'collision',
    detail: 'This node breaks nothing by itself. Put the shatter sound, the Breakable kill, and anything the '
      + 'broken surface should reveal in the prop\'s Trigger effect; with an empty one the surface cracks and '
      + 'then stands there forever.\n\n'
      + 'For the cracked look, author the model\'s material with frame 0 = intact and frame 1 = cracked. The '
      + 'engine picks the frame itself — no Flipbook node needed.\n\n'
      + 'Tuning Strength: how much a hit costs depends on how the rider meets the surface, over a range of '
      + 'about a hundred to one. Riding ALONG it costs roughly 1, charged twice a second while contact lasts, '
      + 'so a Strength of 5 is about three seconds of riding. CRASHING into it costs 70-96 in one hit, which '
      + 'is why dropping onto a pane from height goes straight through. A surface the rider crosses gets one '
      + 'hard contact, not many soft ones — tune against how yours will actually be met.\n\n'
      + 'Leave Lifetime at -1. A positive one lets the crack expire and the surface HEALS back to full strength.',
    proven: { cell: 'cracked-pad / cracked-tough / cracked-shatters / cracked-heals / cracked-solid', run: CRACKED_BATCH,
      observed: 'Both stages, three passes of three, byte-identical each time. The pool is real arithmetic: an authored 1000 stepped 912.43 → 824.88 → 737.30 → 649.75, four hits of 87.55 apiece, and a surface whose pool had gone negative refused every later hit. The break is real too, and the negative control is what makes it a reading — a companion prop with no chain of its own, which the rider never approached, held a node in EVERY pass beside the cell whose strength ran out and in NO pass beside the identical cell authored strong enough to survive one. The other field is a lifetime in seconds: authored 2, the node counted 119 frames down at 60 Hz, let the instance go 1.98 s after taking it, and the replacement started again at full strength — so an expiring crack HEALS, which is why every retail pane authors -1 and the countdown reads a flat -60 there. What a hit COSTS came back the same across three shapes — 80-88 inside an 80 m pass-through box, on a flat panel lying on the snow, and against a solid host that actually stopped the rider (87.55, speed 24 -> 17) — but every one of those staged the rider CROSSING into the host, which is not how retail uses this node. A glass floor supports the rider for seconds, and in game a Megaplex pane cracks on arrival and breaks a few seconds later on an authored 5, so a supported contact must cost of the order of 1. That number is unmeasured, and the constancy of the 80-88 reads as one event staged three ways rather than as a cost that ignores geometry.' },
    nodes: [{ mainType: 0, semanticType: 'property.cracked',
      payload: { type0: { SubType: 14, type0Sub14: { U0: -1, U1: 5 } } }, references: {} }] },
  { id: 'mesh-animation', kind: 'node', label: 'Mesh throw', summary: 'Throw the model\'s own pieces outward to make it shatter. The direction comes from where the rider hit it.', circumstance: 'collision',
    nodes: [{ mainType: 0, semanticType: 'property.mesh-animation',
      payload: { type0: { SubType: 20, type0Sub20: { U0: 1, U1: 0.05, U2: 2, U3: 0, U4: 0, U5: 0, U6: 400, U7: 400, U8: 400, U9: 1 } } }, references: {} }] },
  // ---- bound-node control messages (MainType 3) -------------------------------------------------------
  // One opcode dispatched to whichever property the bound instance has installed, so the SAME command number
  // means different things on different receivers — command 2 selects a texture frame on a flip node and
  // grants clip budget on an animation one. The semantic type is the author's declaration of which receiver
  // they mean; the payload is identical, and the inspector offers every compatible reading.
  // This one went unbadged through four batches for a reason worth keeping, because it is the shape of
  // mistake the whole fixture exists to avoid: the only cell carrying it was the ride-over button, whose
  // flip has a Speed of its own, so an applied frame moving 0 -> 1 there is explained just as well by the
  // node cycling as by any message. The fix was to author the receiver at Speed 0 — a flip with no clock has
  // nothing to move its frame but a command — and then to build the control that says what such a flip rests
  // at. Neither cell means anything alone; together they are decisive.
  { id: 'material-texture-frame', kind: 'node', label: 'Set texture frame', summary: 'Switch the target prop\'s material to a specific frame — how start lights count down.', circumstance: 'trigger',
    detail: 'It works on a still material too. A Flipbook set to Speed 0 has no clock of its own, so it holds '
      + 'whatever frame it is given — which is how a sign becomes a set of states rather than an animation.',
    proven: { cell: 'flip-frame-command / flip-frame-control', run: FLIP_BATCH,
      observed: 'It selects the frame, and a matched pair is what says so. The receiver is a flipbook authored at SPEED 0 — a node with no clock of its own — and it holds the frame this command names for its whole life, while an identical Speed-0 flip one field uphill with nothing addressing it rests at frame 0. Three passes of three, the same two numbers every time. The button cells further up the course paint the same 0 -> 1 and cannot make this claim, because their flip could have done it unaided.' },
    nodes: [{ mainType: 3, semanticType: 'material.texture-frame',
      payload: { type3: { U0: 2, U1: 1 } }, references: {} }] },
  { id: 'material-uv-offset', kind: 'node', label: 'Set UV phase', summary: 'Jump the target prop\'s scrolling material to a particular position — how the Merqury City strike sign shows its state.', circumstance: 'trigger',
    detail: 'This SETS the position rather than holding it: give the target a UV scroll with no rate of its own '
      + 'if you want it to stay put. Values outside -4 to 4 are ignored.',
    proven: { cell: 'ctl-uv-phase', run: LATCH_BATCH,
      observed: 'The command lands. A UV-scroll receiver was built by the chain ahead of it and its V phase word then held both authored values — 2.5 and -3.0, a Wait apart, three passes of three. Two arbitrary numbers appearing where the chain asked for them is not something drift or a default could produce. Values outside -4..4 are dropped by the receiver, unremarked.' },
    nodes: [{ mainType: 3, semanticType: 'material.uv-offset-v',
      payload: { type3: { U0: 6, U1: 0 } }, references: {} }] },
  { id: 'anim-delta-grant', kind: 'node', label: 'Grant clip budget', summary: 'Give a budgeted Model clip some frames to play. 30 frames is one second.', circumstance: 'trigger',
    detail: 'The budget is spent as it plays, so this is a throttle rather than a switch — a clip that should '
      + 'keep moving needs granting again and again.',
    proven: { cell: 'ctl-anim-budget', run: BUDGET_BATCH,
      observed: 'The grant arrives and is then spent in real time. A budgeted-clip receiver built by the chain ahead of it took the authored 30 frames as exactly 1.000 s of budget, and that second drained smoothly to zero over the following second before the chain granted it again — read the same way in 33 runs. The frames-to-seconds conversion is the receiver\'s, not this node\'s: 30 authored is one second because the timebase is 30 fps.' },
    nodes: [{ mainType: 3, semanticType: 'animation.delta-grant',
      payload: { type3: { U0: 2, U1: 30 } }, references: {} }] },
  { id: 'counter-mark', kind: 'node', label: 'Mark counter input', summary: 'Tick off one numbered input on the target prop\'s Counter. The same input only ever counts once, so a switch cannot be pressed twice.', circumstance: 'trigger',
    detail: 'Give each switch its own input number. This is how a set of distinct switches opens one door.',
    proven: { cell: 'ctl-counter-mark', run: LATCH_BATCH,
      observed: 'It counts. A two-input counter built by the chain ahead of it went to "input 1 marked, one to go" on contact, three passes of three, read off the single word that carries both halves of the counter\'s state. The second mark a Wait later took it to zero — which ends the node, because a counter reaching zero fires its trigger column and retires.' },
    nodes: [{ mainType: 3, semanticType: 'counter.mark',
      payload: { type3: { U0: 1, U1: 1 } }, references: {} }] },
  { id: 'counter-decrement', kind: 'node', label: 'Decrement counter', summary: 'Count the target prop\'s Counter down by one, with no input number. Use this to count how many times something happened.', circumstance: 'trigger',
    proven: { cell: 'ctl-counter-decrement', run: LATCH_BATCH,
      observed: 'It steps the count and leaves the input mask alone, which is exactly what separates it from Mark counter input: the same word that read "input 1 marked, one to go" on the mark cell reads "one to go, nothing marked" here, on every pass of three.' },
    nodes: [{ mainType: 3, semanticType: 'counter.decrement',
      payload: { type3: { U0: 3, U1: 0 } }, references: {} }] },
  // No fixture cell, and deliberately none: this node packs to the SAME BYTES as Decrement counter — command
  // 3, value 0 — which three passes have already demonstrated arriving. The two differ only in which
  // receiver the author means, and the engine settles that at the receiver rather than in the message. A
  // cell here would re-measure a proven node and report it under a second name.
  { id: 'anim-combo-trigger', kind: 'node', label: 'Trigger anim combo', summary: 'Play the reaction half of a Model clip (combo) on the target prop — how a barrier gets knocked flat.', circumstance: 'trigger',
    detail: 'Point it at a prop carrying a Model clip (combo). The reaction runs once from wherever the idle '
      + 'animation had got to, and the receiver refuses a second trigger while the first is still playing — so '
      + 'this is safe to fire from a collision chain with no debounce of its own.',
    nodes: [{ mainType: 3, semanticType: 'animation.combo-trigger',
      payload: { type3: { U0: 3, U1: 0 } }, references: {} }] },
  // These two are the pair that demonstrated bound-node control works at all, and they are the only commands
  // in the family whose effect the harness can read directly on the entity. The bit they move was recorded
  // here as having no reader anywhere in the engine; it has exactly one, in the spline mover's own update,
  // which destroys the node the frame it finds the bit set on its host [Trailmap: 150-logic §control]. So
  // Set is a mover STOP rather than merely a mark, and Clear cannot undo it — a destroyed node stays gone.
  // What these still prove, and what the four commands above depend on, is that the message ARRIVES.
  { id: 'instance-flag-set', kind: 'node', label: 'Set prop marker', summary: 'Put a lasting marker on the target prop. On a Spline mover this permanently STOPS it; anywhere else it is just a mark you can set and clear.', circumstance: 'trigger',
    detail: 'The stop cannot be undone — clearing the marker afterwards does not start the mover again.\n\n'
      + 'The marker outlives the effect that set it, which is what makes it useful for remembering that '
      + 'something has already happened. In Raw it is status flag 0x0800.',
    proven: { cell: 'flag-set', run: LIFETIME_BATCH,
      observed: 'The command arrives. The instance status word gains bit 0x0800 on the same sample the contact builds the node that receives it, three passes of three — and keeps it after that node has expired and let the instance go. The mark outlives its sender, where a breakable kill\'s draw bits are put back at teardown.' },
    nodes: [{ mainType: 3, semanticType: 'instance.flag-0x800.set',
      payload: { type3: { U0: 8, U1: 0 } }, references: {} }] },
  { id: 'instance-flag-clear', kind: 'node', label: 'Clear prop marker', summary: 'Take back a marker that Set prop marker put on the target prop.', circumstance: 'trigger',
    proven: { cell: 'flag-set-clear', run: LIFETIME_BATCH,
      observed: 'It takes the bit back, 1.00-1.02 s after a Set on the same chain put it there, on every crossing of three passes. Set and clear are therefore both live and both addressed to the node the chain has installed, which is what makes the rest of the bound-node vocabulary worth authoring.' },
    nodes: [{ mainType: 3, semanticType: 'instance.flag-0x800.clear',
      payload: { type3: { U0: 7, U1: 0 } }, references: {} }] },

  // ---- properties whose complete record is recoverable from shipped data --------------------------------
  // Every default below is a MODAL authored value rather than a guess, and every payload carries the whole
  // native record — including the words whose meaning is not established, at the value retail ships them at.
  // A short record would be written back as one, and the fields left out are exactly the ones nobody could
  // check by eye.
  { id: 'debounce', kind: 'node', label: 'Cooldown', summary: 'Stop this effect running again until a number of seconds have passed. Without one it re-runs every frame the rider is touching the prop.', circumstance: 'collision',
    proven: { cell: 'every gold-map cell', run: FIRST_PASS, observed: 'On every cell whose chain carries no flip, the Cooldown IS the node holding that instance live-node slot, and it holds it for the 3 s it was authored with. The fixture is readable because of that: a chain with no cooldown builds and completes inside a frame or two, where no host-side sampler can see it.' },
    nodes: [{ mainType: 0, semanticType: 'property.debounce',
      payload: { type0: { SubType: 2, Debounce: 3 } }, references: {} }] },
  { id: 'counter', kind: 'node', label: 'Counter', summary: 'Wait for a number of inputs to arrive, then run this prop\'s Trigger effect — the multi-switch gate.', circumstance: 'persistent',
    detail: 'Feed it from each switch\'s own collision effect, using Run on another prop to reach this one and '
      + 'Mark counter input to tick off that switch\'s number.\n\n'
      + 'This and Cracked surface are the only two things that can start a Trigger effect.',
    proven: { cell: 'ctl-counter-mark / ctl-counter-decrement / counter-builds', run: LATCH_BATCH,
      observed: 'It counts, and the count is real rather than inferred: a two-input counter read "one to go" after one mark and "one to go, nothing marked" after one decrement, three passes of each. Reaching zero ends the node — which is the counter firing its slot\'s trigger column and then retiring, the whole of how a deferred chain is scheduled.' },
    nodes: [{ mainType: 0, semanticType: 'property.counter',
      payload: { type0: { SubType: 6, Counter: { Count: 2, U1: -1 } } }, references: {} }] },
  { id: 'directional-boost', kind: 'node', label: 'Directional boost', summary: 'Push the rider toward a target speed along a fixed direction — exhaust vents, conveyors, updraughts.', circumstance: 'collision',
    detail: 'The direction is a world direction and does not follow the prop if you rotate it.\n\n'
      + 'THE TRIGGER BOX IS THE TUNING. This pushes for as long as the rider is inside the box, so how big and '
      + 'how deep you make it decides how far they get thrown, as much as the rate does.\n\n'
      + 'It raises no speed limit of its own, so a vent can throw a rider high without making them fast.',
    proven: { cell: 'boost-up-lifts / vent-throw', run: `${SPEED_SWEEP}; ${THROW_BATCH}`, observed: 'It PUSHES, and the second batch says how hard. Retail exhaust-vent tuning — straight up, rate 5, target 25 m/s — inside a box deep enough to hold the rider: the rider went from descending at 7.5 m/s to climbing at 7.2–13.7 m/s, the fastest it rose anywhere on the course in every pass. The node also builds with the mode it was authored with (sub-type 7, mode word 1). Then the throw, at Megaplex\'s own vent slot (rate 3, target 100 m/s) inside a box carrying that host model\'s own 3.29 m of height and 3.60 m of depth: 13.5–21.3 m/s of climb, 11–21 m of altitude gained. THE BOX IS THE TUNING — rider selection is a containment test re-run every tick, so dwell decides the throw and a volume of your own choosing is a different node however exactly the lag is reproduced. Peak carried speed was 33.47 m/s in all three passes, the top cap tier: this node raises no cap of its own, so a vent throws a rider high without making them fast.' },
    nodes: [{ mainType: 0, semanticType: 'property.boost',
      payload: { type0: { SubType: 7, Boost: { Mode: 1, U1: 0, U2: 3, BoostAmount: 45, BoostDir: { X: 0, Y: 0, Z: 1 } } } }, references: {} }] },
  // The lap boost lays out the same rate/target/axis triple as the directional boost at the same payload
  // offsets, and it is a separate template rather than a mode of that one because it is a different machine:
  // it never runs the shared push, it writes the rider's POSITION as well as velocity, and it is gated on a
  // counter that is seeded from the COURSE rather than authored ([Trailmap: 360-lapboost-gate]).
  //
  // Measured on PS2, against a directional boost in an identical box with identical lift tuning: the lap
  // boost's node was built and held the slot (sub-type 15) in every pass, and the rider was never lifted —
  // the run reported `laps_remaining` 0 throughout, and the boost beside it launched the rider every time.
  // That observed gate is the whole character of the node, so
  // it leads the description rather than sitting in a footnote. Defaults are the retail finish tube's.
  { id: 'lap-boost', kind: 'node', label: 'Lap-gated lift', summary: 'Lift riders who still have a lap to go and let anyone on their last lap ride straight through — the finish tube\'s shaft.', circumstance: 'collision',
    detail: 'The lap count comes from the course, not from this node, and only the Megaplex course slot has one. '
      + 'Anywhere else this builds normally and lifts nobody. Use a Directional boost unless your level packs '
      + 'into that slot.',
    nodes: [{ mainType: 0, semanticType: 'property.lap-boost',
      payload: { type0: { SubType: 15, type0Sub15: { U0: 5, U1: 25, U2: 0, U3: 0, U4: 1 } } }, references: {} }] },
  { id: 'fence', kind: 'node', label: 'Fence flex', summary: 'Make the prop flex like a chain-link fence when the rider hits it.', circumstance: 'collision',
    nodes: [{ mainType: 0, semanticType: 'property.fence',
      payload: { type0: { SubType: 12, Fence: { U0: 0, FlexAmmount: 0.5 } } }, references: {} }] },
  { id: 'flag', kind: 'node', label: 'Flag wave', summary: 'Make the prop behave like a soft banner waving in the wind.', circumstance: 'persistent',
    nodes: [{ mainType: 0, semanticType: 'property.flag',
      payload: { type0: { SubType: 13, type0Sub13: { U0: 1, U1: 1.5, U2: 25, U3: 0 } } }, references: {} }] },
  { id: 'crowd-box', kind: 'node', label: 'Crowd box', summary: 'Draw the prop as a grandstand full of spectators, using the course\'s shared crowd textures instead of the prop\'s own.', circumstance: 'persistent',
    nodes: [{ mainType: 0, semanticType: 'property.crowd-box',
      payload: { type0: { SubType: 17, CrowdEffect: { U0: 0, U1: 2, U2: 8 } } }, references: {} }] },
  // The one authorable member of the scoring family. Main types 6 and 15 (boost-meter fill) and 16 (time
  // bonus) share its mode gate and are unreachable for a different reason: the SSF reader and writer have no
  // branch for any of the three, so a document carrying one cannot round-trip, let alone pack.
  //
  // Retail's tiers are 2 / 3 / 5, and they do not STACK — the handler writes `max(current, authored)` and the
  // next banked trick consumes the result, putting it back to 1. So a second gem is only worth anything if
  // it is worth MORE than the one still active.
  { id: 'score-multiplier', kind: 'node', label: 'Score multiplier', summary: 'Multiply the rider\'s banked trick score, like a floating gem. Showoff modes only — it does nothing in Race or Freeride. Usual values are 2, 3 and 5.', circumstance: 'collision',
    detail: 'NOT YET SEEN TO WORK, even in Showoff. Ridden on hardware the effect fires but the multiplier never '
      + 'moves, while boost pads on the same course write their values normally. Treat it as unfinished rather '
      + 'than as something you have mis-authored.\n\n'
      + 'The pickup chime is not a sign that it landed — the chime plays either way.\n\n'
      + 'Multipliers do not stack. A gem sets the multiplier to whichever is larger, its own value or the one '
      + 'already running, and the next banked trick spends it. So a second gem is only worth placing if it is '
      + 'worth more than the first.',
    nodes: [{ mainType: 14, semanticType: 'score.multiplier',
      payload: { MultiplierScore: 2 }, references: {} }] },
  { id: 'anim-delta', kind: 'node', label: 'Model clip (budgeted)', summary: 'The model\'s animation, frozen until something grants it frames to play — how a kicker follows the rider instead of looping.', circumstance: 'persistent',
    detail: 'Drive it with Grant clip budget from another effect.\n\n'
      + 'CHECK THE MODEL HAS A CLIP, as with Model clip. The budget counter below is this node\'s own and ticks '
      + 'along whether or not there are any frames for it to spend.',
    proven: { cell: 'ctl-anim-budget', run: BUDGET_BATCH,
      observed: 'The budget is real and it is this node holding it. The receiver\'s own accumulated-budget word takes the granted 30 frames as exactly 1.000 s, counts down to 0.000 in one second of real time, and refills to 1.0 when the chain grants again — the full spend-and-refill cycle read in 33 separate runs. That is the node doing the one thing that distinguishes it from an ordinary Model clip: gating playback on a budget rather than free-running. What it does NOT establish is that anything moved — the cell rides a model with no keyframes, and the budget clock is node state that runs regardless.' },
    nodes: [{ mainType: 0, semanticType: 'property.anim-delta',
      payload: { type0: { SubType: 257, type0Sub257: { U0: 1, U1: -1, U2: -1, U3: 30, U4: 0, U5: 1, U6: 0, U7: 3 } } }, references: {} }] },

  // Two windows of one clip, and the defaults are the retail barrier's: ping-pong the first half, react over
  // the second, come back. The idle window is spelled out rather than left at -1 because a combo node with a
  // full-clip idle window has nowhere for its reaction to live — the loop would play the reaction as part of
  // the idle. That is the one way to author this node so it can never look right, so the preset avoids it.
  { id: 'anim-combo', kind: 'node', label: 'Model clip (combo)', summary: 'The model\'s animation split in two: an idle loop, and a reaction another effect triggers — how a barrier slides side to side until a rider knocks it flat.', circumstance: 'persistent',
    detail: 'Trigger the reaction with Trigger anim combo from a collision effect — usually the prop\'s own.\n\n'
      + 'CHECK THE MODEL HAS A CLIP, and that it is long enough for both windows: the idle window is the first '
      + 'stretch of frames and the combo window a later one, out of the SAME animation.\n\n'
      + 'The reaction plays ON TOP of the idle pose rather than replacing it, so author its frames as movement '
      + 'away from rest and leave the idle motion out of them. The original barrier does exactly this — the '
      + 'sliding is authored only in frames 0-60, and the knock-down in 61-100 rotates about a translation of '
      + 'zero — which is what lets it fall over wherever it happens to be standing.\n\n'
      + 'Random start is on by default so several copies of the prop do not slide in lockstep.',
    nodes: [{ mainType: 0, semanticType: 'property.anim-combo',
      payload: { type0: { SubType: 258, type0Sub258: {
        U0: 2, U1: 0, U2: 60, U3: 30, U4: 0, U5: 1, U6: 1, U7: 3, U8: 61, U9: 100, U10: 30, U11: 0,
      } } }, references: {} }] },

  // ---- acting on another object (MainType 7) ------------------------------------------------------------
  // The one node that reaches off its own host: it names a second placement and a graph, and runs that graph
  // bound to that placement. Retail's buttons are built this way — a flat decal you ride over, a volume
  // overhead, and the decal's chain hopping to the sign that lights up.
  //
  // It lays down UNBOUND, because the two things it needs are picked, not defaulted: use `bindInstanceHop`
  // to name the target placement and the graph to run on it. Unbound, the repack compiler skips the slot and
  // says so — which is the right outcome, since a hop with a wrong target is invisible on hardware rather
  // than wrong in a way anyone would notice.
  { id: 'act-on-instance', kind: 'node', label: 'Run on another prop', summary: 'Run one of your effects on a DIFFERENT prop — a button you ride over lighting up a sign somewhere else.', circumstance: 'collision',
    detail: 'Pick the prop and the effect to run on it below. Until both are set the node does nothing and the '
      + 'level will not export.',
    proven: { cell: 'hop-remote-target', run: GATE_BATCH, observed: 'The hop LANDS. A second prop with no chain of its own, that the rider never came within 105 m of, held the target graph node in every pass. Nothing else could have put it there.' },
    nodes: [{ mainType: 7, semanticType: 'instance.state',
      payload: { Instance: {} }, references: { instance: null, effectGraph: null } }] },

  // ---- moving the RIDER to another object (MainType 24) -------------------------------------------------
  // The same resolver as the hop above, pointed at the player instead of at a graph: it reads the named
  // placement, steps ~3 m off it along one of five authored quadrant directions, derives a heading, and puts
  // the rider there [Trailmap: 390-pickups-and-race]. It is the one opcode that moves a rider somewhere the
  // course did not lead them.
  //
  // It lays down UNBOUND for the same reason the hop does — the destination is picked, not defaulted — but
  // the failure it is guarding against is the opposite one. An unresolved HOP is invisible: the resolver
  // bounds-checks and the chain runs on. An unresolved TELEPORT that got past the bounds check would drop the
  // rider at whatever instance the index happened to name. So the compiler refuses the slot outright rather
  // than shipping -1 and trusting the runtime, and `bindRiderTeleport` is the only way to fill it in.
  { id: 'rider-teleport', kind: 'node', label: 'Teleport rider', summary: 'Move the rider to another prop. They arrive about 3 m away from it, facing whichever way that prop faces, and STOPPED.', circumstance: 'collision',
    detail: 'Because they arrive stopped, give the destination clear ground and a slope to pick up speed on — a '
      + 'landing on the flat leaves the rider standing still.\n\n'
      + 'Pick the destination below. One with no destination is refused at export rather than shipped, since a '
      + 'wrong guess would drop the rider anywhere.',
    proven: { cell: 'teleport-warp', run: TELEPORT_BATCH, observed: 'The rider MOVES. 132.9 m between two adjacent samples in all three passes, arriving 3.00 m from a bare panel they had no way to reach, with speed cut from 23.9 m/s to nothing. The 3 m and the stop are the handler\'s own constants, so this is the documented behaviour reproduced rather than a bare displacement.' },
    nodes: [{ mainType: 24, semanticType: 'rider.teleport',
      payload: {}, references: { instance: null } }] },

  // ---- switching a rail on and off (MainType 25) --------------------------------------------------------
  // The most heavily authored node in the shipped levels after the function call: 396 uses across the seven
  // extracted ones. It names a spline and pushes a flag onto that spline's rail-candidacy bit, which is what
  // the rail query is allowed to find [Trailmap: 140-rail-toggle]. Retail authors it exactly two ways, and
  // both are worth an author knowing: MESA switches a fallen tree's trunk splines ON at the end of its break
  // sequence (`Effect: 1`, on splines authored off), and every level's `HideShowOff` function switches its
  // trick-line rails OFF for race and free-ride (`Effect: 0`, paired with a model hide).
  //
  // It needs no new machinery. The spline reference resolves to a native table index through the same
  // round trip the spline mover already uses, and a grind rail's index in that table is the index it already
  // exports at.
  { id: 'spline-toggle', kind: 'node', label: 'Rail on / off', summary: 'Turn one of your grind rails on or off as something the rider can catch — a fallen trunk becoming grindable.', circumstance: 'collision',
    detail: 'This changes only whether the rail can be CAUGHT, not whether it is drawn. A rail switched off with '
      + 'its model still showing looks solid and cannot be grinded, which reads as a bug — hide the model too, '
      + 'with a separate node.\n\nTo switch a rail ON, tick "starts off" on the rail itself: an authored rail is '
      + 'in the network from the moment the level loads, so otherwise there is nothing here to switch.\n\n'
      + 'Pick the rail below. One with no rail is refused at export rather than shipped.',
    nodes: [{ mainType: 25, semanticType: 'spline.toggle',
      payload: { Spline: { Effect: 1 } }, references: { spline: null } }] },

  // ---- the vertical lift (MainType 0 / SubType 18) ------------------------------------------------------
  // Megaplex's two air shafts, and the one boost specialisation whose fields are fully recovered
  // [Trailmap: 360-zboost]. It shares the rate/target/axis triple with the directional boost at the same
  // offsets and adds the two that make it an elevator rather than a push: a target altitude it carries
  // riders UP to, and a snap tolerance.
  //
  // The altitude is an absolute world Z, which is why this went unauthorable for a while — there is no
  // default that means anything away from the shaft it was authored for. `bindZBoostToPlacement` is the
  // answer: it writes the target from the prop's own position, so a lift dropped on the mountain lifts to
  // somewhere above ITSELF rather than to Megaplex's ceiling.
  { id: 'z-boost', kind: 'node', label: 'Vertical lift', summary: 'Carry the rider straight up to a set height and let go — an air shaft. They stop travelling forwards while it lifts them.', circumstance: 'collision',
    detail: 'A rider already at or above the target height passes through untouched.\n\n'
      + 'The height is an absolute world height, taken from the prop when you add the node. If you MOVE the '
      + 'prop afterwards the target does not follow it — re-add the node or edit the height by hand.',
    nodes: [{ mainType: 0, semanticType: 'property.z-boost',
      // Retail's own shaft tuning (rate 4, target speed 20, straight up, never snap). U5 is the world Z and
      // is rewritten from the placement — 0 here is a value nobody should ever ride.
      payload: { type0: { SubType: 18, type0Sub18: { U0: 4, U1: 20, U2: 0, U3: 0, U4: 1, U5: 0, U6: 0 } } },
      references: {} }] },

  // ---- calling a shared chain (MainType 21) -------------------------------------------------------------
  // The most authored node in the shipped levels: 77 uses, and every one of the seven extracted courses has
  // some. It is how retail composes — one `BreakLogo<uid>` body per screen, called from that screen's own
  // collision chain, and one `HideShowOff` called from the race and free-ride mode chains alike.
  //
  // The engine does not run the body inline. The handler allocates a fresh 240-byte effect thread, hands it
  // the calling thread's owner, and points it at the named function [Trailmap: 150-logic §dispatch]; the
  // calling chain carries straight on. So a called body runs BESIDE its caller rather than inside it, and a
  // Wait in the body delays the body alone.
  //
  // A function is a named node list with no attachment of its own — the same thing a graph is, minus the
  // slot. `bindEffectFunctionCall` makes one on the way in rather than leaving the reference empty, because
  // an unbound call is a slot the repack compiler refuses outright and there is no existing function on an
  // authored mountain to fall back to.
  //
  // Its NAME reaches the disc as a 15-character field, because the engine also finds a function by name
  // [Trailmap: 150-logic §by-name] — but that is not a hook an authored level can take today. A repacked
  // level keeps the donor course's functions, the authored ones are APPENDED after them, and the lookup
  // returns the first match, so the donor's `RaceMode` is still the one the mode switch finds. The name is
  // therefore a label here, and the reason it is preserved verbatim rather than normalized is that it stops
  // being one the moment a level owns its whole function table.
  { id: 'call-function', kind: 'node', label: 'Call shared effect', summary: 'Run a shared effect that lives on its own instead of on a prop, so several props can run the same one without each carrying a copy.', circumstance: 'collision',
    detail: 'Adding this creates an empty shared effect to fill in; point it at a different one below if you '
      + 'already have the one you want.\n\n'
      + 'The shared effect runs ALONGSIDE the one that called it rather than inside it, so the caller does not '
      + 'wait for it to finish and a Wait inside it delays only itself.\n\n'
      + 'Keep the name to 15 characters — that is all the disc format stores.',
    proven: { cell: 'call-function-hop / call-function-rider', run: CALL_BATCH,
      observed: 'Both halves, three passes of three. The body RUNS: a call whose function holds one hop put a node on a companion 130 m off the fall line that carries no chain and that the rider was measured 129.8 m away from, on the same sample the caller fired. And the body is handed the CALLER\'S RIDER: a second cell whose own chain carries nothing rider-acting — the speed pad is inside the called function — wrote 4.933, 5.000 and 5.000 into the rider\'s boost request against the authored 5.0, and the cell three seconds downhill read that same request decayed to 1.95, so the countdown was running rather than a word read stale.' },
    nodes: [{ mainType: 21, semanticType: 'function.call',
      payload: {}, references: { function: null } }] },

  // ---- gates (MainType 5) ------------------------------------------------------------------------------
  // A gate stops the rest of its chain when it fails, and that is demonstrated rather than inferred: a random
  // gate at 0 built nothing in three passes while the same gate at 1 ran every one.
  //
  // The record is mode, selector and one parameter, and BOTH parameter words are typed against the engine
  // rather than with it ([Trailmap: 150-gate]). The selector is declared a float and read as an int, so any
  // non-zero float picks the at-least sense. The parameter is the reverse — declared an int, read as an f32 —
  // so it has to carry the target float's BIT PATTERN. That is why the numbers below look the way they do,
  // and writing the readable value instead is worse than wrong in one of the two cases: `0.5` is not an
  // integer at all, so the gate that shipped with it could never have packed.
  { id: 'gate-speed', kind: 'node', label: 'Only if: rider speed', summary: 'Run the rest of this effect only when the rider is going slower (or faster) than a threshold.', circumstance: 'collision',
    detail: 'Speed is compared in centimetres per second, so a rider at normal course pace is around 2500 — a '
      + 'threshold of 30 is a gate that is effectively shut.\n\n'
      + 'It starts wide open at 1000000, which lets everything through. Set Threshold to a real value or the '
      + 'node does nothing.',
    proven: { cell: 'gate-speed-shut / gate-speed-threshold / gate-speed-retail-30 / gate-speed-atleast-pass / gate-speed-atleast-block', run: SELECTOR_BATCH,
      observed: 'Fully tunable, in both directions, three passes on every cell. At most: 0.0 blocks, 30.0 blocks, 1e6 passes. At least: 30.0 passes, 1e6 blocks. Since a rider at course pace clears a ceiling of 30, the compared speed is in engine CENTIMETRES — around 2500 — not metres. The catch is the selector spelling: it must be the float whose BITS are 1, and a readable 1.0 matches nothing and falls through to a path that passes at any threshold.' },
    // At most 1e6 (1232348160 is the bit pattern): a working gate that happens to be open, since no rider
    // approaches that speed. It ships this way rather than at a real threshold because the useful setting
    // depends entirely on the course, and it ships on the at-most SELECTOR because that one is spelled with a
    // plain 0 — the at-least side needs the float whose bits are 1, which no author would guess.
    nodes: [{ mainType: 5, semanticType: 'condition.speed',
      payload: { type5: { U0: 0, U1: 0, U2: 1232348160 } }, references: {} }] },
  { id: 'gate-random', kind: 'node', label: 'Only if: random chance', summary: 'Run the rest of this effect on a chance — the way an ambient effect fires irregularly instead of like clockwork. Starts at even odds.', circumstance: 'trigger',
    proven: { cell: 'gate-random-always / gate-random-never', run: GATE_BATCH, observed: 'Both directions, three passes each. At 1 the chain behind the gate ran every pass; at 0 nothing was ever constructed. The word is therefore the chance of PASSING, spelled the way this template writes it — and a gate really can stop a chain, which is what makes the other three modes worth authoring.' },
    // 1056964608 is the bit pattern of 0.5f — even odds, which is what the label promises.
    nodes: [{ mainType: 5, semanticType: 'condition.random',
      payload: { type5: { U0: 1, U1: 0, U2: 1056964608 } }, references: {} }] },
  { id: 'gate-human', kind: 'node', label: 'Only if: human rider', summary: 'Run the rest of this effect only for the player, not for AI riders. Use it when something should happen once rather than six times in a race.', circumstance: 'collision',
    detail: 'In a test ride the only rider is the player, so this always passes and you will not see it filter '
      + 'anything until there is a field on the mountain.',
    proven: { cell: 'human-gate-warp', run: FIELD_WARP_BATCH, observed: 'It passes for the player AND rejects an AI, which took a course with a field on it to ask. Fifteen AI contacts with a gated panel within 0.2-1.6 m of its origin across three passes against three human ones, and the teleport behind the gate fired 0 times for the AI and 3 for the player. In two passes all five opponents crossed BEFORE the human with the slot still empty, which is the half a debounce cannot explain. Read on the roster trace, which samples every rider rather than the local one.' },
    nodes: [{ mainType: 5, semanticType: 'condition.human-rider',
      payload: { type5: { U0: 2, U1: 0, U2: 0 } }, references: {} }] },
  { id: 'gate-no-live-node', kind: 'node', label: 'Only if: prop is idle', summary: 'Run the rest of this effect only while this prop is not already running something, so it never stacks two at once.', circumstance: 'persistent',
    proven: { cell: 'gate-no-live-node', run: SPEED_SWEEP,
      observed: 'Passes on an idle instance, three passes of three. Its rejecting half is unreachable from the fixture: an instance that already holds a node reports its slot as spoken for, so the dispatch signal cannot answer that direction.' },
    nodes: [{ mainType: 5, semanticType: 'condition.no-live-node',
      payload: { type5: { U0: 3, U1: 0, U2: 0 } }, references: {} }] },

  // ---- node lifetime (SubType 5) -----------------------------------------------------------------------
  // The same record as Breakable kill at its other authored modes. What each does to a LIVE node is recovered
  // ([Trailmap: 150-logic]); the mode word is the whole payload.
  // All three act on whatever node the instance is running RIGHT NOW, so none of them does anything on its
  // own — the shape to author is two objects: the effect you want to stop lives on one prop, and a chain on
  // another reaches it with `act-on-instance`. Putting one behind the node it means to end in the SAME chain
  // does not work the way it reads: the factory drops a live node of a different sub-type before building
  // the next one, so the command arrives at a slot the chain has already changed hands on.
  // One placement to avoid outright, and it is the one the column names invite: a lifetime command in a
  // TRIGGER chain. That column is fired by a Counter elapsing, and the node installed at that instant is the
  // counter itself, mid-update, running this chain — so the command tells the engine to destroy what is
  // executing it. Measured on PS2 as a reproducible hang rather than a misfire (Trailmap/tools/autotest).
  { id: 'node-destroy', kind: 'node', label: 'Stop what the prop is running', summary: 'Stop whatever node the target prop is running right now.', circumstance: 'trigger',
    detail: 'It acts on the OTHER prop, so put it in an effect that reaches across with Run on another prop. '
      + 'Putting it below the node it means to stop, in the same effect, does not work.\n\n'
      + 'Never put one in a Trigger effect fired by a Counter: the thing it would stop is that Counter, '
      + 'mid-update, and the console freezes.',
    proven: { cell: 'dead-destroy', run: LIFETIME_BATCH,
      observed: 'It ends the node. A 3 s Cooldown holding the instance released it at 0.98-1.07 s instead, on nine crossings across three passes, with the only difference being this command a Wait behind it. A node\'s lifetime is something an authored chain can cut short.' },
    nodes: [{ mainType: 0, semanticType: 'property.node-destroy',
      payload: { type0: { SubType: 5, DeadNodeMode: 0 } }, references: {} }] },
  { id: 'node-pause', kind: 'node', label: 'Pause what the prop is running', summary: 'Stop whatever the target prop is running, through its own stop path. In practice the result is the same as Stop what the prop is running.', circumstance: 'trigger',
    detail: 'Pick this one over Stop when you want the intent on record; nothing observable separates them.\n\n'
      + 'The same placement rules apply: reach the prop with Run on another prop, and never from a Trigger '
      + 'effect fired by a Counter.',
    proven: { cell: 'dead-pause', run: LIFETIME_BATCH,
      observed: 'It acts, at the same 1.00-1.03 s as Stop what the prop is running and with the same result at the instance: the node stops holding it. That the two differ inside the engine is on the record (this one calls a stop method where Stop calls the destructor) but no reading here separates them, so pick this one for intent rather than for a different outcome.' },
    nodes: [{ mainType: 0, semanticType: 'property.node-pause',
      payload: { type0: { SubType: 5, DeadNodeMode: 1 } }, references: {} }] },
  { id: 'node-tombstone', kind: 'node', label: 'Stop the prop for good', summary: 'Stop what the target prop is running and block it from ever running anything again. Use this when something should stop permanently.', circumstance: 'trigger',
    detail: 'This is the one that differs from the other two: Stop and Pause both let the prop go free a moment '
      + 'later, and this one never does. It also only works once.\n\n'
      + 'The same placement rules apply: reach the prop with Run on another prop, and never from a Trigger '
      + 'effect fired by a Counter.',
    proven: { cell: 'dead-tombstone', run: LIFETIME_BATCH,
      observed: 'It leaves something behind, and that is what separates it from the other two: the slot\'s sub-type moved 2 -> 5 one Wait after contact and the instance NEVER came free again for the rest of the run, where Stop and Pause both released it after a second. It also fires exactly once — the mode bails on a node already tagged 5 — so it is the mode to reach for when a thing should stop for good.' },
    nodes: [{ mainType: 0, semanticType: 'property.node-tombstone',
      payload: { type0: { SubType: 5, DeadNodeMode: 2 } }, references: {} }] },

  // The two ways a material's frame list is played on its own, both persistent and both heavily authored.
  // They are separate templates rather than one with a flag because they are separate machines: the pause
  // path re-times itself at every change and `Speed` stops meaning frames per second
  // ([Trailmap: 410-texture-animation]). Defaults are the modal shipped values.
  { id: 'texture-flip', kind: 'node', label: 'Flipbook', summary: 'Cycle a material through its frames at a steady rate — direction signs, boost chevrons. The material needs at least two frames.', circumstance: 'persistent',
    detail: 'Set Speed to 0 to stop it cycling on its own. It then holds whichever frame Set texture frame gives '
      + 'it, which turns a sign into a set of states.',
    proven: { cell: 'button-flip', run: BUTTON_RUN, observed: 'A flip node was built (sub-type 11) and PAINTED: its applied-frame word moved between 0 and 1, over one captured material and two captured frames.' },
    nodes: [{ mainType: 0, semanticType: 'property.texture-flip',
      payload: { type0: { SubType: 11, TextureFlip: { U0: 0, Direction: 0, Speed: 3.5, Length: 0, U4: 0 } } }, references: {} }] },
  { id: 'texture-flip-dwell', kind: 'node', label: 'Dwell screen', summary: 'Hold frame 0, flash frame 1 for a tenth of a second, then hold again for a random while — a blinking warning screen. Wants a two-frame material.', circumstance: 'persistent',
    proven: { cell: 'flip-dwell', run: FLIP_BATCH,
      observed: 'It dwells, and the timing is the proof rather than any value: the flash lands at 0.084-0.116 s every time — a fixed tenth of a second — while the hold between flashes runs 1.22-3.23 s and differs run to run, which is the randomization the label promises. A plain flipbook at Speed 3.5 changes frame about every 0.3 s and spends equal time on each. Two different machines, told apart on the clock alone.' },
    nodes: [{ mainType: 0, semanticType: 'property.texture-flip',
      payload: { type0: { SubType: 11, TextureFlip: { U0: 0, Direction: 0, Speed: 1, Length: 0, U4: 1 } } }, references: {} }] },
  // Tokyo Megaplex's ride-over buttons, self-contained on one prop. Retail splits this across two objects — an
  // invisible trigger volume whose collision header hops onto the flat button with MainType-7 — and this is
  // the one-prop form of the same chain: the same three nodes in the same order, with the engine building the
  // flip node on contact exactly as the hop does [Trailmap: 410-texture-animation]. The split form is
  // authorable too, through `act-on-instance`; this recipe stays because most buttons do not need a second
  // object, and one prop is the simpler thing to reach for.
  { id: 'ride-over-button', kind: 'recipe', label: 'Ride-over button', summary: 'Riding across the prop flashes its material to a second frame and back — the Megaplex buttons. Needs a model whose material has at least two frames.', circumstance: 'collision',
    proven: { cell: 'button-flip', run: BUTTON_RUN, observed: 'The whole recipe works end to end on hardware: the chain dispatches on contact and the flip paints, frame 0 to 1. The leading Cooldown is inert in this attachment — a cell without it behaved identically.' },
    nodes: [
      // Retail debounces every button chain by 3 s, and this carries that shape — but in THIS attachment it
      // gates nothing, so do not reason about button timing from it. The node factory destroys a live node
      // of a different sub-type before building the new one, so the flip below deletes this debounce one
      // dispatch later, in the same tick; the real re-fire gate is the flip's own `Length`. Retail never
      // meets this because its debounce sits alone on a trigger volume and the flip lives on the button, one
      // MainType-7 hop away. Kept rather than dropped: it is the shipped shape, it costs one inert node, and
      // it becomes load-bearing the moment the recipe can split across two instances.
      // Measured: a button with this node and one without behave identically on PS2 (both build a sub-type
      // 11 node whose applied frame moves 0 -> 1) — Trailmap/tools/autotest, run 20260806-062643.
      { mainType: 0, semanticType: 'property.debounce',
        payload: { type0: { SubType: 2, Debounce: 3 } }, references: {} },
      { mainType: 0, semanticType: 'property.texture-flip',
        payload: { type0: { SubType: 11, TextureFlip: { U0: 0, Direction: 0, Speed: 3.5, Length: 0.5, U4: 0 } } }, references: {} },
      { mainType: 3, semanticType: 'material.texture-frame',
        payload: { type3: { U0: 2, U1: 1 } }, references: {} },
    ] },
] as const;

/**
 * The rest of the canonical vocabulary: every node the document model can READ but the editor will not lay
 * down, and why. The picker shows these greyed, so it is the map of the whole SSF vocabulary rather than of
 * the subset we happen to author — "this node exists and here is what stands in the way" beats a silent
 * absence, which reads as "SSX has no such thing".
 *
 * One thing stands in the way of nearly all of them: payload words with no recovered meaning. Defaulting
 * those would be inventing data — the node would author, export, and do something nobody could predict.
 *
 * The two exceptions are the ones whose obstacle is the OPCODE rather than its payload. A detached call
 * (MainType 26) is understood and cannot be written: the level writer has no case for it, so it would pack
 * as a bare 8-byte frame and the engine would read whatever followed as the function index. A tombstone's
 * flag bit is the reverse — it packs perfectly and nothing is known about what the bit adds.
 *
 * Reading a level that uses any of them is unaffected; the inspector shows every field in Raw.
 */
export interface UnauthorableEffectNode {
  semanticType: string;
  label: string;
  reason: string;
}

export const UNAUTHORABLE_EFFECT_NODES: readonly UnauthorableEffectNode[] = [
  { semanticType: 'function.call-detached', label: 'Call shared effect (detached)',
    reason: 'Slopesmith cannot write this one to disc. Use Call shared effect — the same call, with a rider attached.' },
  { semanticType: 'camera.operation', label: 'Camera operation',
    reason: 'What its settings mean is not worked out, and a wrong guess would move the camera with nothing in the editor to show it.' },
  { semanticType: 'time.bonus', label: 'Time bonus',
    reason: 'How much time it awards, and in what units, is not worked out.' },
  { semanticType: 'property.timer', label: 'Timer',
    reason: 'The original game never uses it, so there is nothing to copy its settings from. This is an engine timer, not a particle emitter.' },
  { semanticType: 'property.movie', label: 'Movie',
    reason: 'Plays the level\'s video stream, which your level does not have.' },
  { semanticType: 'property.rail', label: 'Rail property',
    reason: 'Grind rails are authored as rails in Rails mode instead. Its settings are not worked out.' },
  { semanticType: 'property.particle', label: 'Particle property',
    reason: 'Its settings are not worked out. Particle emitter is the one you can author.' },
  { semanticType: 'property.trick-trigger', label: 'Trick trigger',
    reason: 'What it scores, and what the rider has to do to set it off, is not worked out.' },
  { semanticType: 'property.dead-node', label: 'Stop a node (other mode)',
    reason: 'A stop mode beyond the three that are worked out. Those three are listed separately above.' },
  { semanticType: 'property.node-tombstone-flagged', label: 'Stop for good (flagged)',
    reason: 'What its extra flag adds over plain Stop the prop for good is not worked out.' },
  { semanticType: 'property.anim-texture-flip', label: 'Anim texture flip',
    reason: 'Its settings are not worked out. Flipbook and Dwell screen are the two flip behaviours you can author.' },
  { semanticType: 'property.uv-scroll-texture-flip', label: 'UV scroll + flipbook',
    reason: 'This packs both behaviours into one node and its layout is not worked out. Add UV scroll and Flipbook separately instead.' },
  { semanticType: 'property.tube-end-boost', label: 'Tube-end launch',
    reason: 'It has three directions and which one gets used when is not worked out.' },
  { semanticType: 'property.random-boost', label: 'Random boost',
    reason: 'How hard it pushes, and which way, is not worked out. Directional boost is the one you can author.' },
  { semanticType: 'condition.gate', label: 'Only if… (other test)',
    reason: 'A test beyond the four that are worked out. Those four are listed separately above.' },
] as const;
