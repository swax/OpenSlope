import type { EffectNode, JsonObject, JsonValue } from './document';
import { SPLINE_END_MODE_OPTIONS, SPLINE_ORIENTATION_MODE_OPTIONS } from './play-runtime';

export interface EffectSemanticNumberOption {
  value: number;
  label: string;
}

export interface EffectSemanticNumberField {
  label: string;
  /** Path relative to node.payload. */
  path: readonly string[];
  title: string;
  step?: string;
  /** Named integer values render as a select in the authored editor and as labels in reference inspection. */
  options?: readonly EffectSemanticNumberOption[];
  /**
   * How the stored word relates to the number this control shows.
   *
   * `f32-bits` is the gate threshold's storage and the reason that word had no control at all until now: the
   * native record declares an `int` while the engine loads the same four bytes as an `f32`, so the value a
   * gate compares against is the BIT PATTERN of the float it means. Typing 30 into a plain control stores
   * 0x0000000A-style garbage — a denormal every comparison reads as zero — which is a gate that looks tuned
   * and gates nothing. Nothing in the editor could see that, so the standing advice was "set it in Raw",
   * which is an instruction to hand-assemble a float. The conversion belongs here instead: the control takes
   * and shows the readable number, and the document keeps the exact int the packer writes.
   */
  codec?: 'f32-bits';
}

export interface EffectSemanticInspector {
  fields: readonly EffectSemanticNumberField[];
  note?: string;
}

const field = (label: string, path: readonly string[], title: string, step?: string,
  options?: readonly EffectSemanticNumberOption[]): EffectSemanticNumberField =>
  ({ label, path, title, step, options });

/** A word stored as the int bit pattern of the float the engine reads out of it. */
const bitsField = (label: string, path: readonly string[], title: string, step?: string)
  : EffectSemanticNumberField => ({ label, path, title, step, codec: 'f32-bits' });

const BITS = new DataView(new ArrayBuffer(4));

/**
 * The stored int as the float the engine sees, shown at the shortest precision that still names that exact
 * f32. Retail's 0.05 is 0.05000000074505806 as an f64 and reading it back at full width makes a control look
 * like it has drifted when nothing has changed; shortening only ever picks a decimal that re-encodes to the
 * same four bytes, so what the control shows and what the packer writes cannot come apart.
 */
const floatFromBits = (stored: number): number => {
  BITS.setInt32(0, Math.trunc(stored) | 0);
  const exact = BITS.getFloat32(0);
  if (!Number.isFinite(exact)) return exact;
  for (let digits = 1; digits <= 8; digits++) {
    const short = Number(exact.toPrecision(digits));
    if (Math.fround(short) === exact) return short;
  }
  return exact;
};

/** The int to store so the engine's f32 load yields this number. Rounded to f32 first, so what a control
 *  shows after a write is what the engine will actually compare against rather than the f64 that was typed. */
const bitsFromFloat = (value: number): number => {
  BITS.setFloat32(0, Math.fround(value));
  return BITS.getInt32(0);
};

const particleVector = (label: string, first: number, title: string): readonly EffectSemanticNumberField[] =>
  ['X', 'Y', 'Z'].map((axis, offset) => field(`${label} ${axis}`,
    ['type2', 'type2Sub0', `U${first + offset}`], `${title} ${axis}, measured from the emitter.`));

/** Present colours as RGBA even though lossless native payloads store each quartet as A,R,G,B. */
const particleColorStop = (stop: number, first: number): readonly EffectSemanticNumberField[] => [
  field(`Colour stop ${stop} R`, ['type2', 'type2Sub0', `U${first + 1}`], `Red channel of colour stop ${stop}.`),
  field(`Colour stop ${stop} G`, ['type2', 'type2Sub0', `U${first + 2}`], `Green channel of colour stop ${stop}.`),
  field(`Colour stop ${stop} B`, ['type2', 'type2Sub0', `U${first + 3}`], `Blue channel of colour stop ${stop}.`),
  field(`Colour stop ${stop} A`, ['type2', 'type2Sub0', `U${first}`], `Alpha channel of colour stop ${stop}.`),
];

const PARTICLE_TIMER_FIELDS: readonly EffectSemanticNumberField[] = [
  field('Particles', ['type2', 'type2Sub0', 'U0'], 'Particle count per burst.', '1'),
  field('Trail copies', ['type2', 'type2Sub0', 'U1'], 'How many extra copies trail behind each particle. Usual values are 0–10.', '1'),
  field('Emission window', ['type2', 'type2Sub0', 'U2'], 'Seconds over which the particle starts are staggered; negative keeps the stream alive.'),
  field('Time scale', ['type2', 'type2Sub0', 'U3'], 'Speeds up or slows down the whole burst.'),
  field('Size center', ['type2', 'type2Sub0', 'U4'], 'Middle of the particle size range.'),
  field('Particle life center', ['type2', 'type2Sub0', 'U5'], 'Center of the per-particle lifetime range in seconds.'),
  field('Size span', ['type2', 'type2Sub0', 'U6'], 'How much the particle size varies either side of the middle.'),
  field('Particle life span', ['type2', 'type2Sub0', 'U7'], 'Full span of the per-particle lifetime range in seconds.'),
  field('Trail spacing', ['type2', 'type2Sub0', 'U8'], 'Time offset in seconds between adjacent trail copies.'),
  field('Origin X (cm)', ['type2', 'type2Sub0', 'U9'], 'Where particles come from, measured from the prop. Use the purple handle in the viewport instead of typing this.'),
  field('Origin Y (cm)', ['type2', 'type2Sub0', 'U10'], 'Where particles come from, measured from the prop. Use the purple handle in the viewport instead of typing this.'),
  field('Origin Z (cm)', ['type2', 'type2Sub0', 'U11'], 'Height particles come from, measured from the prop. Use the purple handle in the viewport instead of typing this.'),
  ...particleVector('Spawn axis A', 12, 'First centered spawn-area axis'),
  ...particleVector('Spawn axis B', 15, 'Second centered spawn-area axis'),
  ...particleVector('Base velocity', 18, 'Base launch velocity'),
  ...particleVector('Velocity variation A', 21, 'First centered half-range velocity axis'),
  ...particleVector('Velocity variation B', 24, 'Second centered half-range velocity axis'),
  ...particleVector('Velocity variation C', 27, 'Third centered half-range velocity axis'),
  field('Gravity X', ['type2', 'type2Sub0', 'U30'], 'How strongly particles are pulled sideways as they fly.'),
  field('Gravity Y', ['type2', 'type2Sub0', 'U31'], 'How strongly particles are pulled sideways as they fly.'),
  field('Gravity Z', ['type2', 'type2Sub0', 'U32'], 'How strongly particles are pulled up or down as they fly.'),
  ...particleColorStop(1, 33),
  ...particleColorStop(2, 37),
  ...particleColorStop(3, 41),
  ...particleColorStop(4, 45),
  field('Sprite index', ['type2', 'type2Sub0', 'U49'], 'Which sprite from the shared particle set to draw.', '1'),
  field('Blend mode', ['type2', 'type2Sub0', 'U50'], 'How the particles blend with what is behind them.', '1'),
];

/** SubType 2 carries the same P6 law, but U2..U48 are retained in the lossless document as raw f32 words. */
const PARTICLE_COLLISION_FIELDS: readonly EffectSemanticNumberField[] = PARTICLE_TIMER_FIELDS.map(spec => {
  const key = spec.path[spec.path.length - 1];
  const match = /^U(\d+)$/.exec(key);
  const index = match ? Number(match[1]) : -1;
  const contactMeaning = index >= 9 && index <= 11 ? {
    label: `Stored origin ${['X', 'Y', 'Z'][index - 9]} (runtime replaced)`,
    title: 'Preserved for lossless export, but a real collision replaces this component with the exact contact point.',
  } : index >= 18 && index <= 20 ? {
    label: `Normal-speed seed ${['X', 'Y', 'Z'][index - 18]}`,
    title: 'Only the length of U18-U20 survives. At runtime the collision normal replaces this authored direction.',
  } : {};
  return {
    ...spec,
    ...contactMeaning,
    path: ['type2', 'type2Sub2', key],
    ...(index >= 2 && index <= 48 ? { codec: 'f32-bits' as const } : {}),
  };
});

const EMPTY: EffectSemanticInspector = { fields: [] };

const ANIM_LOOP_MODE_OPTIONS: readonly EffectSemanticNumberOption[] = [
  { value: 0, label: 'Play once' },
  { value: 1, label: 'Wrap' },
  { value: 2, label: 'Ping-pong' },
];

const ANIM_DIRECTION_MODE_OPTIONS: readonly EffectSemanticNumberOption[] = [
  { value: 3, label: 'Forward' },
  { value: 4, label: 'Reverse' },
];

/** AnimCombo's last word is read for its SIGN, not its magnitude, so the three named choices are the three
 *  behaviours and any other value the author leaves in Raw still falls into one of them. */
const ANIM_COMBO_END_OPTIONS: readonly EffectSemanticNumberOption[] = [
  { value: 0, label: 'Back to the idle loop' },
  { value: 1, label: 'Stop, back to the idle pose' },
  { value: -1, label: 'Stop, hold the combo pose' },
];

const VISIBILITY_OPTIONS: readonly EffectSemanticNumberOption[] = [
  { value: 0, label: 'Hidden' },
  { value: 1, label: 'Shown' },
];

/**
 * The directional-boost node's lifetime rule ([Trailmap: 360-node-mode]). The same countdown means opposite
 * things across the two: under Timed it is the window the node lives for, under Continuous it is a cooldown
 * that suppresses the push while it runs. Every retail placement authors Timed, so Continuous is reachable
 * but unattested — the label says what the lifetime logic does, not what any shipped course does.
 */
export const BOOST_MODE_OPTIONS: readonly EffectSemanticNumberOption[] = [
  { value: 0, label: 'Continuous (window acts as cooldown)' },
  { value: 1, label: 'Timed window' },
];

/**
 * A rail toggle's flag ([Trailmap: 140-rail-toggle]).
 *
 * The dispatcher hands this straight to `RailMan_RegisterRailEffectCandidate(splineIndex, flag)`, which sets
 * the spline's candidacy bit when the flag is non-zero and clears it when it is zero. Retail authors exactly
 * these two values, so the selector is the whole field rather than a sample of a wider range.
 */
export const SPLINE_TOGGLE_OPTIONS: readonly EffectSemanticNumberOption[] = [
  { value: 0, label: 'Off — cannot be grinded' },
  { value: 1, label: 'On — can be grinded' },
];

/**
 * A gate's selector word ([Trailmap: 150-gate]).
 *
 * Confirmed by a four-cell hardware sweep that held the threshold at zero and
 * moved this word alone, and selector 0 blocked every pass while a non-zero selector passed every pass. Zero
 * is therefore the at-most side — a rider moving at all fails "at most zero" — and anything else is at-least.
 */
export const GATE_SPEED_COMPARE: readonly EffectSemanticNumberOption[] = [
  { value: 0, label: 'At most the threshold' },
  // Not 1. The word is declared a float and read as an int, so at-least is the float whose BIT PATTERN is 1
  // — what retail writes, and what the runtime matches against. A readable 1.0 arrives as 1065353216, matches
  // no branch, and falls through to a path that passes at any threshold: a gate that looks tuned and gates
  // nothing. Measured across two batches before the spelling was the suspect.
  { value: 1.401298464324817e-45, label: 'At least the threshold' },
];

/**
 * Both of a gate's parameter words are typed the wrong way round in the record, and the two mistakes point in
 * opposite directions — so a value that reads correctly is stored incorrectly and vice versa. It is the same
 * hazard twice and it is silent both times, which is why it is spelled out on every gate rather than once.
 */
const THIRD_WORD_NOTE = 'When this test fails it ends the effect: none of the nodes below it run.'
  + '\n\nBoth controls above store their value in an encoded form, and both hide that from you. Edit them '
  + 'here, not in Raw — a number typed straight into Raw is read as something else entirely and produces a '
  + 'test that looks tuned and tests nothing.';

/** Boost push-axis components share one caveat worth repeating on each field, since getting it wrong is silent. */
const PUSH_AXIS_TITLE = (axis: string) => `Push direction ${axis}. This is a world direction: rotating the `
  + 'prop does NOT turn it, so two copies of one model facing different ways still push the same way.';

/** Every node in the boost family reads its rate the same way ([Trailmap: 360-node-apply]). */
const LIFT_RATE_TITLE = 'How hard the volume grabs the rider: speed along the axis approaches the target '
  + 'gradually rather than instantly, so a higher rate reaches it sooner.';

/** The rate/target/axis triple sits at the same payload offsets across the whole boost family, so its three
 *  axis components are always three consecutive U-words starting from the given one. */
const axisFields = (base: readonly string[], firstAxisWord: string, label: string)
  : readonly EffectSemanticNumberField[] => {
  const first = Number(firstAxisWord.slice(1));
  return ['X', 'Y', 'Z'].map((axis, offset) =>
    field(`${label} ${axis}`, [...base, `U${first + offset}`], PUSH_AXIS_TITLE(axis)));
};

/** One tube-end launch stage: a unit direction and the speed authored against it. */
const stageFields = (stage: number, firstAxisWord: string, speedWord: string)
  : readonly EffectSemanticNumberField[] => {
  const first = Number(firstAxisWord.slice(1));
  return [
    ...['X', 'Y', 'Z'].map((axis, offset) => field(`Stage ${stage} direction ${axis}`,
      ['type0', 'type0Sub24', `U${first + offset}`],
      `Stage ${stage} launch direction ${axis}. A world direction, not one that follows the prop.`)),
    field(`Stage ${stage} speed (m/s)`, ['type0', 'type0Sub24', speedWord],
      `How fast stage ${stage} launches the rider.`),
  ];
};

export const UV_SCROLL_MODE_OPTIONS: readonly EffectSemanticNumberOption[] = [
  { value: 0, label: 'Linear (same direction)' },
  { value: 1, label: 'Eased ping-pong' },
  { value: 2, label: 'Constant-speed ping-pong' },
];

/**
 * Human-facing controls backed by fields whose runtime meaning is established. Unknown or weakly understood
 * payload words deliberately stay in Raw so a friendly label never implies more certainty than the spec has.
 */
export function semanticInspectorForNode(node: EffectNode): EffectSemanticInspector {
  if (node.mainType === 2 && node.semanticType === 'particle.timer') return {
    fields: PARTICLE_TIMER_FIELDS,
    note: 'Colours are shown as RGBA here. Raw stores them in the order the game expects, which is not the same order — edit them above rather than in Raw.',
  };
  if (node.mainType === 2 && node.semanticType === 'particle.collision') return {
    fields: PARTICLE_COLLISION_FIELDS,
    note: 'This is the dedicated contact-fired emitter used by UNTRACK’s snow trees. A hit replaces U9–U11 with its exact contact point and replaces the U18–U20 direction with the outward contact normal while retaining only that vector’s speed. U2–U48 are shown as readable particle values; Raw keeps their exact IEEE-754 integer words for lossless PS2 export.',
  };

  const control = node.mainType === 3 ? 'type3' : node.mainType === 9 ? 'type9' : null;
  if (control) {
    const value = (label: string, title: string, step?: string): EffectSemanticInspector => ({
      fields: [field(label, [control, 'U1'], title, step)],
    });
    switch (node.semanticType) {
      case 'material.texture-frame': return value('Frame', 'Which frame of the target prop\'s material to show.', '1');
      case 'material.uv-offset-v': return value('V offset', 'Where to jump the target prop\'s scrolling material to.');
      case 'animation.delta-grant': return value('Grant (frames)', 'How many frames of animation to hand over. 30 frames is one second.');
      case 'counter.mark': return value('Input number', 'Which of the Counter\'s inputs this ticks off. Give each switch its own number.', '1');
      case 'counter.decrement': return { fields: [], note: 'Counts the target prop\'s Counter down by one. Nothing to set.' };
      case 'animation.combo-trigger': return { fields: [], note: 'Starts the Anim combo on the target prop. Nothing to set.' };
      case 'instance.flag-0x800.clear': return { fields: [], note: 'Takes the marker off the target prop. Nothing to set.' };
      case 'instance.flag-0x800.set': return { fields: [], note: 'Puts the marker on the target prop. Nothing to set.' };
    }
  }

  switch (node.semanticType) {
    case 'rider.reset': return { fields: [], note: 'Puts the rider back on the course, the way water and the edges of the map do. Nothing to set.' };
    // MainType 7 carries no numbers at all: its whole payload is the two REFERENCES shown below the fields,
    // and the inspector's generic "nothing is mapped yet" fallback reads as a gap where there is none.
    case 'instance.state': return { fields: [], note: 'Nothing to set here — this node is entirely the two '
      + 'choices below: which prop to act on, and which of its effects to run. The target prop is where the '
      + 'effect happens, which is how the thing you ride over and the thing that reacts become two '
      + 'separate objects. Leave either one empty and the node does nothing, with no sign of it in game.' };
    // ---- gates with no parameter (MainType 5 modes 2 and 3) ------------------------------------------
    // Both are whole gates with an empty parameter list, which is a real answer rather than a missing one.
    case 'condition.human-rider': return { fields: [], note: 'Runs the nodes below only for the player, not '
      + 'for AI riders. Nothing to set. When it fails it ends the effect, so none of the nodes below run.' };
    case 'condition.no-live-node': return { fields: [], note: 'Runs the nodes below only while this prop is '
      + 'not already running something, so it never stacks two at once. Nothing to set.' };
    // ---- gates (MainType 5) -------------------------------------------------------------------------
    // Three words: mode, selector, and a threshold the engine reads as an f32 ([Trailmap: 150-gate]). The
    // threshold is the trap — the record declares it an `int` while the engine loads it as a float, so a
    // plainly typed `10` is the bit pattern 0x0000000A, a denormal that every comparison sees as zero. The
    // mode word is not offered as a field on purpose: changing it turns the node into a different gate whose
    // other two words mean different things, and the picker already has one template per mode.
    case 'condition.speed': return { fields: [
      field('Compare', ['type5', 'U1'],
        'Whether the rider has to be slower or faster than the threshold for the effect to continue.',
        '1', GATE_SPEED_COMPARE),
      bitsField('Threshold (cm/s)', ['type5', 'U2'],
        'The speed to compare against, in centimetres per second. A rider at normal course pace is around '
        + '2500, so 30 is a test that is effectively shut rather than a mid-range filter.'),
    ], note: THIRD_WORD_NOTE };
    case 'condition.random': return { fields: [
      field('Compare', ['type5', 'U1'], 'Flips the roll around, so the chance becomes a chance of stopping.', '1', GATE_SPEED_COMPARE),
      bitsField('Chance of continuing', ['type5', 'U2'],
        'The chance, from 0 to 1, that the nodes below run. 1 always runs them and 0 never does. Fireworks '
        + 'and ambient one-shots usually sit between 0.05 and 0.8.', '0.05'),
    ], note: THIRD_WORD_NOTE };

    case 'wait': return { fields: [field('Delay (seconds)', ['WaitTime'], 'Seconds to wait before the nodes below run.')] };
    // The message itself is text, so it is not one of these numeric fields — only its colour is. The note
    // is where the node's one real trap goes: it draws nothing at all on an ordinary disc.
    case 'hud.message': return {
      fields: [
        field('Red', ['HudRed'], 'Message colour, 0 to 1.', '0.05'),
        field('Green', ['HudGreen'], 'Message colour, 0 to 1.', '0.05'),
        field('Blue', ['HudBlue'], 'Message colour, 0 to 1.', '0.05'),
      ],
      note: 'The text is in `HudText` in Raw. Shows nothing unless the disc was built with `--patches hud-text`: '
        + 'a stock executable sends this opcode to its do-nothing case, and the repack leaves the node out '
        + 'of ordinary builds entirely.',
    };
    case 'audio.play': return { fields: [field('Sound slot', ['SoundPlay'], 'Which sound from the course sound bank to play.', '1')] };
    case 'score.multiplier': return { fields: [field('Multiplier', ['MultiplierScore'], 'What to multiply the rider\'s banked trick score by.')] };
    case 'rider.boost': return { fields: [field('Boost amount', ['type17'], 'How many SECONDS the rider\'s speed limit stays raised. This is a duration, not an amount of speed.')] };
    case 'trick.boost': return { fields: [field('Window (seconds)', ['type18'], 'Trick-boost window duration.')] };

    case 'property.roller': return { fields: [
      field('Mass', ['type0', 'type0Sub0', 'U0'], 'How heavy the prop is when knocked. Must be greater than zero, or it will not move at all.'),
      field('Launch direction X', ['type0', 'type0Sub0', 'U3'], 'Which way the prop is knocked. Leave all three at zero to use the way the prop faces.'),
      field('Launch direction Y', ['type0', 'type0Sub0', 'U4'], 'Which way the prop is knocked. Leave all three at zero to use the way the prop faces.'),
      field('Launch direction Z', ['type0', 'type0Sub0', 'U5'], 'Which way the prop is knocked. Leave all three at zero to use the way the prop faces.'),
    ], note: 'Two additional Roller floats are preserved in Raw because their runtime meaning is not established.' };
    case 'property.debounce': return { fields: [field('Debounce (seconds)', ['type0', 'Debounce'], 'How long before this prop can be set off again.')] };
    case 'property.counter': return { fields: [field('Count', ['type0', 'Counter', 'Count'], 'Number of counter inputs required before the target trigger fires.', '1')], note: 'The Counter\'s other setting is in Raw.' };
    case 'property.boost': return { fields: [
      field('Mode', ['type0', 'Boost', 'Mode'],
        'Lifetime rule. Timed retires the node once its window expires and no rider is inside; Continuous never '
        + 'retires itself and instead reads the window as a cooldown that suppresses the push while it runs. '
        + 'The original game always uses Timed.', '1', BOOST_MODE_OPTIONS),
      field('Window (seconds)', ['type0', 'Boost', 'U1'],
        'How long the node stays ready after it fires. Only riders actually inside the box get pushed, so this '
        + 'mainly keeps it ready between contacts. Zero — the usual choice — keeps it alive exactly as long as '
        + 'the rider is touching it.'),
      field('Approach rate (per second)', ['type0', 'Boost', 'U2'],
        'How hard it grabs the rider — the real tuning knob. Around 0.1 is a gentle air shaft, 3–4 is an '
        + 'exhaust vent or a gust of wind, and 10 slams the rider up to speed like a conveyor.'),
      field('Target speed (m/s)', ['type0', 'Boost', 'BoostAmount'],
        'The speed to drive the rider up to. It only ever adds speed — a rider already going faster that way '
        + 'is left alone, so this never brakes anyone. Usual values are 45–200; near the top the target is '
        + 'out of reach and only the rate matters.'),
      field('Direction X', ['type0', 'Boost', 'BoostDir', 'X'], PUSH_AXIS_TITLE('X')),
      field('Direction Y', ['type0', 'Boost', 'BoostDir', 'Y'], PUSH_AXIS_TITLE('Y')),
      field('Direction Z', ['type0', 'Boost', 'BoostDir', 'Z'], PUSH_AXIS_TITLE('Z')),
    ] };
    // The three specialisations below share sub-7's rate/target/axis triple at the same payload offsets
    // ([Trailmap: 360-zboost, 360-lapboost, 360-tubeend]). Each names them identically so the shared
    // mechanism reads as shared in the inspector.
    case 'property.z-boost': return { fields: [
      field('Approach rate (per second)', ['type0', 'type0Sub18', 'U0'], LIFT_RATE_TITLE),
      field('Target speed (m/s)', ['type0', 'type0Sub18', 'U1'],
        'How fast the lift rises. The target height below is what really matters here. Usual values are 19–25.'),
      ...axisFields(['type0', 'type0Sub18'], 'U2', 'Lift axis'),
      field('Target altitude (world Z)', ['type0', 'type0Sub18', 'U5'],
        'The height the lift carries riders up to. Only riders BELOW it are taken; anyone at or above passes '
        + 'straight through. This is an absolute world height and does not move when you move the prop.'),
      field('Snap tolerance', ['type0', 'type0Sub18', 'U6'],
        'How close to the target height counts as arrived. Zero — the usual choice for an air shaft — eases '
        + 'the rider all the way in. A value bigger than the whole climb teleports them there on the first '
        + 'tick instead.'),
    ], note: 'It also stops the rider travelling forwards while it lifts them — they only rise.' };
    case 'property.lap-boost': return { fields: [
      field('Approach rate (per second)', ['type0', 'type0Sub15', 'U0'], LIFT_RATE_TITLE),
      field('Target speed (m/s)', ['type0', 'type0Sub15', 'U1'],
        'Stored here, but this node does not use it the way a Directional boost would — see the note below.'),
      ...axisFields(['type0', 'type0Sub15'], 'U2', 'Push axis'),
    ], note: 'This lifts only riders who still have a lap to go. It takes each rider\'s lap count when it is '
      + 'created and lets anyone past that point ride straight through, so a rider who loiters is locked '
      + 'out. It carries them on a fixed path rather than pushing them, so the settings above do not '
      + 'describe the whole behaviour.'
      + '\n\nThe lap count comes from the COURSE, not from this node, and only the Megaplex course slot has '
      + 'one. Anywhere else this builds normally and lifts nobody — use a Directional boost instead.' };
    case 'property.tube-end-boost': return { fields: [
      field('Mode', ['type0', 'type0Sub24', 'U0'],
        'When the node gives up, the same as on a Directional boost.', '1', BOOST_MODE_OPTIONS),
      field('Window (seconds)', ['type0', 'type0Sub24', 'U1'],
        'How long the node stays armed after activation, quantised to 60 Hz ticks.'),
      field('Approach rate (per second)', ['type0', 'type0Sub24', 'U2'], LIFT_RATE_TITLE),
      field('Target speed (m/s)', ['type0', 'type0Sub24', 'U3'], 'Inherited target speed for the base push.'),
      ...axisFields(['type0', 'type0Sub24'], 'U4', 'Base push axis'),
      ...stageFields(1, 'U7', 'U16'),
      ...stageFields(2, 'U10', 'U17'),
      ...stageFields(3, 'U13', 'U18'),
    ], note: 'This node is a specialisation of the directional boost: it inherits that node\'s payload, lifetime '
      + 'and rider selection wholesale and replaces only what the push does. The retail placement authors the '
      + 'inherited base axis as all-zero, which makes the inherited push contribute nothing and leaves the three '
      + 'stage pairs carrying the behaviour. Which stage is selected when is not yet established.' };
    case 'property.uv-scroll': return { fields: [
      field('Mode', ['type0', 'UVScroll', 'U0'],
        'Scroll one way, or back and forth with or without easing. Anything else scrolls one way.',
        '1', UV_SCROLL_MODE_OPTIONS),
      field('Horizontal speed (UV/tick)', ['type0', 'UVScroll', 'U1'],
        'Horizontal texture-coordinate advance per 60 Hz simulation tick.'),
      field('Vertical speed (UV/tick)', ['type0', 'UVScroll', 'U2'],
        'Vertical texture-coordinate advance per 60 Hz simulation tick.'),
      field('Active duration (seconds)', ['type0', 'UVScroll', 'U3'],
        'Time spent moving before the cycle restarts or enters its pause interval.'),
      field('Pause duration (seconds)', ['type0', 'UVScroll', 'U4'],
        'Stopped time between active intervals; zero repeats immediately.'),
      field('Lifetime (seconds)', ['type0', 'UVScroll', 'U5'],
        'How long it runs for. Zero keeps it scrolling until the area unloads.'),
    ], note: 'The two back-and-forth modes turn around after each pass. One eases into the turn; the other keeps a constant speed.' };
    case 'property.texture-flip': return { fields: [
      field('Direction', ['type0', 'TextureFlip', 'Direction'], 'Frame direction; zero is forward.', '1'),
      field('Speed', ['type0', 'TextureFlip', 'Speed'], 'How fast the frames cycle, in frames per second. Zero holds one frame.'),
      field('Length', ['type0', 'TextureFlip', 'Length'], 'How long it runs before stopping. Zero runs forever.'),
      field('Pause/dwell', ['type0', 'TextureFlip', 'U4'], 'Turn on to hold frame 0 and flash frame 1 instead of cycling evenly.', '1'),
    ], note: 'One more setting is in Raw.' };
    case 'property.fence': return { fields: [field('Flex amount', ['type0', 'Fence', 'FlexAmmount'], 'How far the fence springs when the rider hits it.')] };
    case 'property.flag': return { fields: [
      field('Variant', ['type0', 'type0Sub13', 'U0'], 'Which of the built-in flag shapes to use.', '1'),
      field('Amplitude', ['type0', 'type0Sub13', 'U1'], 'How far the flag swings.'),
      field('Wavelength', ['type0', 'type0Sub13', 'U2'], 'How long the ripples running through the flag are.'),
    ], note: 'One more setting is in Raw.' };
    case 'property.cracked': return { fields: [
      field('Crack lifetime (seconds)', ['type0', 'type0Sub14', 'U0'],
        'How long the CRACK lasts, not the surface. When it runs out the damage taken so far is thrown away '
        + 'and the surface HEALS instead of breaking. Leave it at -1 so it never expires, which is what you '
        + 'almost always want: once cracked, cracked until it gives way.'),
      field('Strength', ['type0', 'type0Sub14', 'U1'],
        'How much damage the surface takes before it gives way and runs this prop\'s Trigger effect. This is '
        + 'a budget of IMPACT, not a count of hits, and what a hit costs depends entirely on how the rider '
        + 'meets the surface — over a range of about a hundred to one.'
        + '\n\nRiding ALONG it costs about 1, charged twice a second while contact lasts, so 5 is roughly '
        + 'three seconds of riding. CRASHING into it — dropping from height, or hitting it like a wall — '
        + 'costs 70-96 in a single hit, which is why falling onto a pane goes straight through.'
        + '\n\nSo 5 means "about three seconds of riding, or one hard landing". A surface meant to survive '
        + 'being crashed into wants 100 or more. Once spent it ignores every later hit, so it gives way '
        + 'exactly once.'),
    ], note: 'This node breaks nothing itself — it runs this prop\'s Trigger effect when the strength runs '
      + 'out, and that is where the break goes. With no Trigger effect the surface cracks and then stands '
      + 'there for the rest of the level.'
      + '\n\nA worked example: the collision effect is this node plus a crack sound, and the Trigger effect '
      + 'is a shatter sound, a Breakable kill of the intact pane, and reveals of the broken glass and its '
      + 'debris. The pane cracks as the rider arrives, stays solid and rideable while cracked, and gives '
      + 'way a few seconds later — at which point the rider falls through, because the kill removes the '
      + 'floor and nothing puts one back.'
      + '\n\nThe cracked LOOK comes from the model, not from here: give its material frame 0 = intact and '
      + 'frame 1 = cracked, and the game switches frames for you. No Flipbook node needed.' };
    case 'property.crowd-box': return { fields: [
      field('Rows', ['type0', 'CrowdEffect', 'U1'], 'How many rows of spectators to draw.', '1'),
      field('Columns', ['type0', 'CrowdEffect', 'U2'], 'How many spectators per row.', '1'),
    ], note: 'One more setting is in Raw.' };
    case 'property.mesh-animation': return { fields: [
      field('Frame step (seconds)', ['type0', 'type0Sub20', 'U1'], 'How long each step of the throw lasts.'),
      field('Duration (seconds)', ['type0', 'type0Sub20', 'U2'], 'How long the pieces keep flying.'),
      field('Velocity scale X', ['type0', 'type0Sub20', 'U6'], 'How far the pieces are thrown sideways.'),
      field('Velocity scale Y', ['type0', 'type0Sub20', 'U7'], 'How far the pieces are thrown sideways.'),
      field('Velocity scale Z', ['type0', 'type0Sub20', 'U8'], 'How far the pieces are thrown up.'),
      field('Direction scale', ['type0', 'type0Sub20', 'U9'], 'How hard the pieces are thrown.'),
    ], note: 'The rest of its settings are in Raw.' };
    case 'property.anim-object': return { fields: [
      field('Loop mode', ['type0', 'type0Sub256', 'U0'], 'Play once, wrap to the beginning, or ping-pong between the ends.', '1', ANIM_LOOP_MODE_OPTIONS),
      field('Window start (frame)', ['type0', 'type0Sub256', 'U1'], 'Which frame to start on. Leave negative to play the whole animation.'),
      field('Window end (frame)', ['type0', 'type0Sub256', 'U2'], 'Which frame to end on. Leave negative to play the whole animation.'),
      field('Rate (frames/second)', ['type0', 'type0Sub256', 'U3'], 'How fast to play, in frames per second. 30 is normal speed.'),
      field('Random-rate upper', ['type0', 'type0Sub256', 'U4'], 'Fastest random rate. Zero turns the randomness off.'),
      field('Random start', ['type0', 'type0Sub256', 'U6'], 'Non-zero randomizes the starting phase.', '1'),
      field('Direction mode', ['type0', 'type0Sub256', 'U7'], 'Play the model clip forward or in reverse.', '1', ANIM_DIRECTION_MODE_OPTIONS),
    ], note: 'One more setting is in Raw.' };
    case 'spline.animation': return { fields: [
      field('End mode', ['type2', 'SplineAnimation', 'U1'],
        'What happens at the forward end: finish the mover, wrap, reverse, or remain active while holding the end pose.',
        '1', SPLINE_END_MODE_OPTIONS),
      field('Orientation mode', ['type2', 'SplineAnimation', 'U2'],
        'Chooses whether the spline tangent drives yaw, pitch, both, or neither.',
        '1', SPLINE_ORIENTATION_MODE_OPTIONS),
      field('Instance count', ['type2', 'SplineAnimation', 'InstanceCount'], 'Number of copies distributed by the native spline mover.', '1'),
      field('Speed (m/s)', ['type2', 'SplineAnimation', 'AnimationSpeed'],
        'How fast the copies travel. Movers start at the beginning of the route, so a negative speed leaves them stuck there unless the route goes back and forth.'),
      field('Yaw offset (radians)', ['type2', 'SplineAnimation', 'U5'], 'Model-facing correction subtracted from the route tangent.'),
      field('Show route line', ['type2', 'SplineAnimation', 'U6'],
        'Draw the referenced spline as an untextured one-pixel line. A chairlift cable is one use of this generic route visual.',
        '1', VISIBILITY_OPTIONS),
      field('Route line red', ['type2', 'SplineAnimation', 'R'], 'Red channel of the route line, from 0 to 1.', '0.01'),
      field('Route line green', ['type2', 'SplineAnimation', 'G'], 'Green channel of the route line, from 0 to 1.', '0.01'),
      field('Route line blue', ['type2', 'SplineAnimation', 'B'], 'Blue channel of the route line, from 0 to 1.', '0.01'),
      field('Route line opacity', ['type2', 'SplineAnimation', 'U7'], 'Alpha of the route line, from 0 to 1.', '0.01'),
    ], note: 'Choose the route below. A few more settings are in Raw.' };
    case 'property.movie': return { fields: [], note: 'Nothing to set — it plays the level’s video stream, which your level does not have.' };
    case 'property.timer': return { fields: [], note: 'An engine timer, not a particle emitter. The original game never uses it, so none of its settings are named yet.' };
    case 'property.anim-delta': return { fields: [
      field('Loop mode', ['type0', 'type0Sub257', 'U0'], 'Play once, wrap to the beginning, or ping-pong between the ends.', '1', ANIM_LOOP_MODE_OPTIONS),
      field('Window start (frame)', ['type0', 'type0Sub257', 'U1'], 'Animation start frame.'),
      field('Window end (frame)', ['type0', 'type0Sub257', 'U2'], 'Animation end frame.'),
      field('Rate (frames/second)', ['type0', 'type0Sub257', 'U3'], 'How fast to play, in frames per second. 30 is normal speed.'),
      field('Random-rate upper', ['type0', 'type0Sub257', 'U4'], 'Fastest random rate. Zero turns the randomness off.'),
      field('Random start', ['type0', 'type0Sub257', 'U6'], 'Non-zero randomizes the starting phase.', '1'),
      field('Direction mode', ['type0', 'type0Sub257', 'U7'], 'Play the model clip forward or in reverse.', '1', ANIM_DIRECTION_MODE_OPTIONS),
    ], note: 'Same settings as Model clip, but it starts frozen and only moves while Grant clip budget feeds it. One more setting is in Raw.' };
    case 'property.anim-combo': return { fields: [
      field('Loop mode', ['type0', 'type0Sub258', 'U0'], 'Play once, wrap to the beginning, or ping-pong between the ends. This is the IDLE animation, the one that runs before anything triggers the combo.', '1', ANIM_LOOP_MODE_OPTIONS),
      field('Idle window start (frame)', ['type0', 'type0Sub258', 'U1'], 'Which frame the idle animation starts on. Leave negative to start at the beginning of the clip.'),
      field('Idle window end (frame)', ['type0', 'type0Sub258', 'U2'], 'Which frame the idle animation ends on. Leave negative to run to the end of the clip.'),
      field('Idle rate (frames/second)', ['type0', 'type0Sub258', 'U3'], 'How fast the idle animation plays, in frames per second. 30 is normal speed.'),
      field('Random-rate upper', ['type0', 'type0Sub258', 'U4'], 'Fastest random idle rate. Zero turns the randomness off.'),
      field('Random start', ['type0', 'type0Sub258', 'U6'], 'Non-zero randomizes the idle starting phase, so copies of the same prop are out of step with each other.', '1'),
      field('Direction mode', ['type0', 'type0Sub258', 'U7'], 'Play the idle animation forward or in reverse.', '1', ANIM_DIRECTION_MODE_OPTIONS),
      field('Combo window start (frame)', ['type0', 'type0Sub258', 'U8'], 'First frame of the reaction the trigger plays. Leave negative to carry straight on from the idle window\'s end.'),
      field('Combo window end (frame)', ['type0', 'type0Sub258', 'U9'], 'Last frame of the reaction. Leave negative to run to the end of the clip.'),
      field('Combo rate (frames/second)', ['type0', 'type0Sub258', 'U10'], 'How fast the reaction plays, in frames per second. 30 is normal speed.'),
      field('When the combo ends', ['type0', 'type0Sub258', 'U11'], 'Whether the prop goes back to its idle loop and can be triggered again, or stops for good — and if it stops, in which pose.', '1', ANIM_COMBO_END_OPTIONS),
    ], note: 'Two windows of ONE model clip: an idle loop, and a reaction that Trigger anim combo plays over the '
      + 'top of it. The reaction is applied RELATIVE to wherever the idle animation had got to, so author its '
      + 'frames as a movement away from rest — a barrier that slides side to side and gets knocked flat keeps '
      + 'its slide while it falls. CHECK THE MODEL HAS A CLIP long enough for both windows. One more setting is in Raw.' };

    // ---- nodes only a REFERENCE level contains ------------------------------------------------------
    // No control is offered for any of these and none is coming, but a reader working out what a shipped
    // course does still needs to know what the record HOLDS. Naming the payload words is most of that, and
    // it is the difference between "look in Raw" and knowing which number to look at.
    //
    // The values themselves stay in Raw rather than becoming fields, and the reason is in the data: these
    // payloads are written with their zero-valued words omitted, so a field pointing at one would resolve on
    // some placements and silently vanish on the rest — a control that comes and goes reads as a bug in the
    // inspector rather than as a default.
    case 'spline.toggle': return { fields: [
      field('Rail', ['Spline', 'Effect'],
        'Whether the rail this node names can be caught and ridden. It pushes the flag straight onto the '
        + 'spline\'s rail-candidacy bit, which is the set the rail query searches — so switching a rail off '
        + 'takes it out of that search and nothing else. The rail\'s MODEL is drawn either way; retail pairs '
        + 'the off case with a separate model hide, and a rail switched off with its geometry still showing '
        + 'reads to the player as a rail that refuses to grind.', '1', SPLINE_TOGGLE_OPTIONS),
    ], note: 'Which spline it acts on is the node\'s `spline` reference, a row of the native spline table. '
      + 'This is one of the most heavily authored nodes in the shipped levels — 396 uses across the seven '
      + 'extracted ones — and retail reaches for it two ways: switching a spline ON once an event has made it '
      + 'real (a fallen trunk becoming grindable), and switching trick-line rails OFF for race and free-ride '
      + 'in the HideShowOff function every level carries.' };
    case 'function.call': return { fields: [], note: 'Runs a named function — an entry of the level\'s '
      + 'FUNCTION table — on the rider that triggered the chain. The node\'s `function` reference names it; '
      + 'open that function to see what it does. The body runs on a THREAD OF ITS OWN rather than inline: '
      + 'the calling chain continues immediately, and a Wait inside the function delays only the function. '
      + 'This is the most authored node in the shipped levels (77 uses across the seven extracted ones) '
      + 'because it is how retail shares one body between chains — a break sequence per screen, and the '
      + 'HideShowOff every level calls from both its race and its free-ride chain. The function\'s NAME '
      + 'reaches the disc as a 15-character field, and the engine can find a function by name — that is how '
      + 'the game-mode switch runs `RaceMode`, `ShowoffMode` and `FreerideMode` with no rider at all. An '
      + 'authored level cannot take those hooks yet: it is appended to the donor course\'s function table and '
      + 'the lookup returns the first match, so the donor\'s own entry is still the one found.' };
    case 'function.call-detached': return { fields: [], note: 'The same as Call shared effect with no owning '
      + 'rider, so nothing rider-acting inside the called function has anybody to act on. `FunctionRunIndex` '
      + 'in Raw names the entry. No shipped level authors one, and the level writer has no case for MainType '
      + '26, so this reads but cannot be written back.' };
    case 'rider.teleport': return { fields: [], note: 'Moves the rider to a placed instance. '
      + '`TeleportInstanceIndex` in Raw is a row of the native instance table, not a position — so where a '
      + 'rider lands is wherever that placement is, and reading the node means looking the instance up. The '
      + 'landing is NEAR the target rather than on it: the engine steps about 3 m off along one of five '
      + 'directions and derives a facing angle from the target\'s own orientation, and the rider arrives '
      + 'STOPPED — the placement zeroes their velocity, measured as 23.9 m/s to nothing. Which of the five '
      + 'directions is used is chosen by the rider\'s slot index, so up to five riders arriving at one '
      + 'destination land 3 m apart instead of on top of each other. An authored node names a '
      + 'placement instead of an index and the export back-patches the packed row; one with no destination '
      + 'is refused at export rather than shipped, because an index that resolves to the wrong prop puts the '
      + 'rider somewhere nothing in the editor would show. As with Run on another instance, the destination '
      + 'is bound through the document API rather than picked here.' };
    case 'time.bonus': return { fields: [], note: 'Adds seconds to the run clock. SHOWOFF ONLY: it carries '
      + 'the same game-mode gate as the score multiplier and returns without awarding anything in Race or '
      + 'Freeride. The award and its units are not established, and the SSF reader has no branch for this '
      + 'main type, so a document carrying one cannot round-trip.' };
    case 'camera.operation': return { fields: [], note: 'A two-float operation on the triggering player\'s '
      + 'viewport. Which operation each value selects is not established, and a wrong one moves the camera '
      + 'in a way nothing in the editor would show.' };
  }

  if (node.semanticType?.startsWith('property.node-') || node.semanticType === 'property.breakable-kill')
    return { fields: [], note: 'This subtype-5 action has no parameters beyond the action encoded in its semantic type; the native mode remains visible in Raw.' };
  return EMPTY;
}

function objectValue(value: JsonValue | undefined): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : null;
}

export function semanticNumberValue(node: EffectNode, spec: EffectSemanticNumberField): number | null {
  let current: JsonObject = node.payload;
  for (let i = 0; i < spec.path.length - 1; i++) {
    const next = objectValue(current[spec.path[i]]);
    if (!next) return null;
    current = next;
  }
  const value = current[spec.path[spec.path.length - 1]];
  if (typeof value !== 'number') return null;
  return spec.codec === 'f32-bits' ? floatFromBits(value) : value;
}

export function setSemanticNumberValue(node: EffectNode, spec: EffectSemanticNumberField, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  let current: JsonObject = node.payload;
  for (let i = 0; i < spec.path.length - 1; i++) {
    const next = objectValue(current[spec.path[i]]);
    if (!next) return false;
    current = next;
  }
  const key = spec.path[spec.path.length - 1];
  if (typeof current[key] !== 'number') return false;
  current[key] = spec.codec === 'f32-bits' ? bitsFromFloat(value) : value;
  return true;
}
