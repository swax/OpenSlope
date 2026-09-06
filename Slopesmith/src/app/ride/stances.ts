import type { RideGear } from './gear';

/**
 * How a rider stands, and the styles that answer it differently.
 *
 * A **stance** is a couple of dozen named riding quantities. `rider.ts` blends between them and evaluates the
 * result into a body — there is no captured pose and no clip anywhere, so a carve is generated from what a
 * carving snowboarder does rather than replayed. That makes the numbers below the whole tuning surface for the
 * figure: this file is the one to open when the rider does not look right.
 *
 * A **style** is a complete set of four: the neutral cruise, the two committed edges, and the coil that is laid
 * on top of whichever edge is under him. The four styles are a single axis, realistic to arcade — how far the
 * body lays into the turn, past the deck's own roll — and a rider can be handed any of them at any moment,
 * live, without the figure being rebuilt.
 *
 * There is one set of four per **gear**, because a snowboarder and a skier are two different bodies. The KEYS
 * below do not change with the gear and neither does a single line of the solver that reads them: the frame
 * they are written in turns with the feet. `along` spans the hips and shoulders — the board's nose axis under
 * a snowboarder standing across it, the rider's own lateral under a skier standing along their skis — and
 * `toe` is square to it, the toe edge in one case and the fall line in the other. So the same `angulation` is
 * a fold toward the toes for one and a fold forward for the other, which is the same joint doing the same
 * thing; see `SKIING` below for how the rest of them read once the body has turned.
 *
 * Angles are degrees, lengths metres, and `toe` is positive throughout.
 */

export const STANCE_KEYS = [
  /** Hip-socket height above the ankle line, along the leg axis. The knee bend is whatever this implies. */
  'hipHeight',
  /** Hips across the deck: negative sits them back over the heel edge, positive drives them over the toes. */
  'hipCross',
  /** Hips along the board, positive noseward. Through the leg IK this *is* which knee folds deeper. */
  'hipFore',
  /** Degrees the leg axis leans off the **surface** the rider is on, positive toeward: a carve's inclination.
   *  Not off the deck — the body never inherits the board's visual bank. The board rolls to `lean · 50°`, and the
   *  gap between the two is what a carve looks like.
   *
   *  This runs **past** the deck's own roll on every style, which is what puts the hips inside the turn where a
   *  carving rider's hips are: measured from the ankle line, the hips sit toward the edge that is engaged. Fall
   *  short of the deck's angle instead and the hips come out over the *outside* of the turn, which reads on
   *  screen as the body being thrown around by its own board. */
  'inclination',
  /** Degrees the spine folds back off the leg axis, positive toeward — the angulation that trims the upper body
   *  back out of the turn once `inclination` has laid the legs into it. A snowboarder stands across the board
   *  with their chest over the toe edge, so folding *forward* is this, toeward: a tuck and a carve's angulation
   *  are the same joint doing the same thing, which is why they simply add.
   *
   *  It is signed against `inclination` on each edge, so it counterbalances rather than piles on, and it is the
   *  lever that sets how far the head travels — the hips barely move with it. */
  'angulation',
  /**
   * The OTHER waist fold: degrees the spine folds about the axis the chest faces along, signed like
   * `inclination` so an opposite sign counters a lay-in and the same sign adds to it.
   *
   * The two folds are one joint on two axes, and which of them is a rider's forward and which their sideways
   * is the same ninety degrees the gear turns everything else through. A snowboarder stands across the deck,
   * so `angulation` IS their forward fold and it already counters their lay-in — this one would lean them over
   * the nose or the tail instead, which no snowboard stance asks for, so theirs is zero throughout.
   *
   * A skier's two are separate joints doing separate work. `angulation` folds them forward over the boot
   * tongues, which is permanent, and this one is the hip angulation that a carve is actually made of: the legs
   * lay right into the turn while the upper body comes back out over the outside ski. Without it a skier at a
   * committed edge angle simply lies down on the snow, because the physics that says a balanced body must
   * incline as far as its edge is edged applies to the CENTRE OF MASS and not to the head.
   */
  'crossFold',
  /** Where the chest is carried off the spine's own line: across the deck, and along the board. The trunk curls
   *  into it progressively, so the fold is a back and not a hinge. */
  'chestCross', 'chestFore',
  /** Degrees the shoulder line turns about the spine from square with the board, positive opening the front
   *  shoulder toeward. */
  'counterRotation',
  /** How much lower the front shoulder rides than the rear, along the spine. */
  'shoulderSlope',
  /** How much of the apparent-gravity stack the torso still takes, 0..1, scaling `RIDER_UPRIGHT_CHEST`.
   *
   *  Pure balance says the torso should align with apparent gravity, and in a hard carve that points a long way
   *  into the turn — which throws the head out with it. A trained snowboarder does not do that: they hold the
   *  head steady and let the lower body swing beneath it, which is a learned motor habit overriding the naive
   *  stack. So the realistic end takes nearly all of it and the arcade end very little; together with
   *  `angulation` this sets how much of the turn the head inherits. */
  'chestBalance',
  /** The knee bends over its toes; this cants that direction noseward (+) or tailward, per leg. */
  'kneeTrackFront', 'kneeTrackRear',
  /** Degrees the head turns into the turn, underneath the wandering glance. */
  'headYaw',
  /** Where the rider keeps his hands. Each arm bone is a direction in the torso's own frame: `Drop` is how far
   *  it swings off hanging straight down, `Swing` is which way that points — 0 noseward, 90 over the toe edge,
   *  180 tailward, 270 over the heel edge. Four bones, so both arms are placed without a single joint target. */
  'leadUpperDrop', 'leadUpperSwing', 'leadForeDrop', 'leadForeSwing',
  'trailUpperDrop', 'trailUpperSwing', 'trailForeDrop', 'trailForeSwing',
] as const;

export type Stance = { -readonly [K in typeof STANCE_KEYS[number]]: number };

export interface RidingStyle {
  label: string;
  /** Cruising a flat base. */
  neutral: Stance;
  /** The two committed edges, faded in by `|lean|` and only while grounded. */
  heel: Stance; toe: Stance;
  /** The coil, **additive** on top of whichever edge is under him, so a crouched carve needs no fifth stance. */
  crouch: Stance;
}

/** The live stance: `a` crossed toward `b` by `t`, then `add` laid on top by `s`. Never allocates. */
export function blendStance(out: Stance, a: Stance, b: Stance, t: number, add: Stance, s: number) {
  for (const k of STANCE_KEYS) out[k] = a[k] + (b[k] - a[k]) * t + add[k] * s;
  return out;
}

/** Cross one whole evaluated stance toward another — how a change of style reaches the body. Never allocates. */
export function crossStance(out: Stance, from: Stance, to: Stance, t: number) {
  for (const k of STANCE_KEYS) out[k] = from[k] + (to[k] - from[k]) * t;
  return out;
}

/**
 * The four styles are one axis: **how far the body lays into the turn, past the board's own roll.**
 *
 * Slopesmith rolls the deck by `lean · 50°` about its own nose axis, so a negative lean puts the deck normal
 * over the heel edge and a positive one over the toes; both carves are authored in that frame. Every style
 * inclines further than that, which is what carries the hips to the inside of the turn. What separates them is
 * how much further, how low the hips ride, and how much of the motion the head is allowed to inherit.
 *
 * At the **realistic** end the lay-in is modest and the waist fold is proportionally the largest, so the upper
 * body stays tall and the head is markedly quieter than the hips — a trained rider stabilises their head and
 * lets the lower body swing beneath it.
 *
 * At the **arcade** end the body lays much further over, the hips drop toward the height of the bindings, the
 * knees come round near the snow, and the waist stops arguing with the board, so the head simply rides along
 * with the body. This end is set against measured retail geometry ([Trailmap: 240-models-mpf]); `Extreme` runs
 * past it.
 *
 * Neutral cruising barely moves along the axis; standing on a flat base is standing on a flat base. Almost
 * everything below is the two carves, which is where the difference lives.
 *
 * Within every style the two edges are still written independently, because a snowboarder's are not each other
 * reflected: a toe edge is held by extending the ankle into the boot tongue, so it rides taller and drives the
 * knees forward down the board, and a heel edge is held by sitting back, so it rides lower and closes harder.
 *
 * `tools/ride-study/retail-pose-compare.ts` measures what these produce, in the board frame retail was measured in.
 */

/** A real carver: the smallest lay-in of the four, the largest waist fold, and the quietest head. */
const REALISTIC: RidingStyle = {
  label: 'Realistic',
  neutral: {
    hipHeight: 0.720, hipCross: -0.020, hipFore: 0.010,
    inclination: 0, angulation: 6, crossFold: 0,
    chestCross: 0.030, chestFore: 0.010,
    counterRotation: -10, shoulderSlope: -0.060, chestBalance: 1.0,
    kneeTrackFront: 0.040, kneeTrackRear: 0.040,
    headYaw: 0,
    leadUpperDrop: 30, leadUpperSwing: 0, leadForeDrop: 50, leadForeSwing: 60,
    trailUpperDrop: 30, trailUpperSwing: 195, trailForeDrop: 40, trailForeSwing: 120,
  },
  heel: {
    hipHeight: 0.640, hipCross: -0.050, hipFore: -0.030,
    inclination: -44, angulation: 4, crossFold: 0,
    chestCross: 0.030, chestFore: 0.020,
    counterRotation: 22, shoulderSlope: -0.100, chestBalance: 1.0,
    kneeTrackFront: 0.020, kneeTrackRear: 0.020,
    headYaw: 8,
    leadUpperDrop: 42, leadUpperSwing: 300, leadForeDrop: 62, leadForeSwing: 330,
    trailUpperDrop: 34, trailUpperSwing: 205, trailForeDrop: 48, trailForeSwing: 150,
  },
  toe: {
    hipHeight: 0.660, hipCross: 0.050, hipFore: 0.020,
    inclination: 44, angulation: -4, crossFold: 0,
    chestCross: 0.020, chestFore: 0.010,
    counterRotation: -18, shoulderSlope: -0.020, chestBalance: 1.0,
    kneeTrackFront: 0.080, kneeTrackRear: 0.070,
    headYaw: -8,
    leadUpperDrop: 38, leadUpperSwing: 40, leadForeDrop: 58, leadForeSwing: 75,
    trailUpperDrop: 28, trailUpperSwing: 190, trailForeDrop: 36, trailForeSwing: 105,
  },
  crouch: {
    hipHeight: -0.220, hipCross: -0.030, hipFore: 0.020,
    inclination: 0, angulation: 30, crossFold: 0,
    chestCross: 0.030, chestFore: -0.020,
    counterRotation: 0, shoulderSlope: 0, chestBalance: 0,
    // The knees come *in* under a coil, not further out over the toes. Driving them further would put the
    // trailing knee through the snow on a deep toe edge, which is exactly where a coiled carve puts it.
    kneeTrackFront: -0.030, kneeTrackRear: -0.030,
    headYaw: 0,
    leadUpperDrop: 12, leadUpperSwing: 10, leadForeDrop: 10, leadForeSwing: -15,
    trailUpperDrop: 8, trailUpperSwing: -10, trailForeDrop: 8, trailForeSwing: -15,
  },
};

/** Halfway, and the default: the body takes most of the deck's roll but still folds at the waist. */
const BALANCED: RidingStyle = {
  label: 'Balanced',
  neutral: { ...REALISTIC.neutral, chestBalance: 0.7, hipHeight: 0.710 },
  heel: {
    ...REALISTIC.heel,
    chestBalance: 0.7,
    hipHeight: 0.600, hipCross: -0.040,
    inclination: -50, angulation: 5,
    chestCross: 0.025, counterRotation: 24,
    headYaw: 9,
    leadUpperDrop: 44, leadForeDrop: 64,
  },
  toe: {
    ...REALISTIC.toe,
    chestBalance: 0.7,
    hipHeight: 0.620, hipCross: 0.040,
    inclination: 50, angulation: -5,
    chestCross: 0.020, counterRotation: -20,
    kneeTrackFront: 0.085, kneeTrackRear: 0.075,
    headYaw: -9,
    leadUpperDrop: 40, leadForeDrop: 60,
  },
  crouch: { ...REALISTIC.crouch },
};

/** The game read, and the one set against measured retail geometry: the body lays well past the deck's own roll,
 *  the hips come down near the bindings and inside the turn, and the waist barely folds. */
const ARCADE: RidingStyle = {
  label: 'Arcade',
  neutral: { ...REALISTIC.neutral, chestBalance: 0.4, hipHeight: 0.700, angulation: 5 },
  heel: {
    ...REALISTIC.heel,
    chestBalance: 0.4,
    hipHeight: 0.550, hipCross: -0.030,
    inclination: -56, angulation: 4,
    chestCross: 0.020, counterRotation: 26,
    kneeTrackFront: 0.015, kneeTrackRear: 0.015,
    headYaw: 11,
    leadUpperDrop: 46, leadForeDrop: 66, trailUpperDrop: 38, trailForeDrop: 52,
  },
  toe: {
    ...REALISTIC.toe,
    chestBalance: 0.4,
    hipHeight: 0.570, hipCross: 0.030,
    inclination: 56, angulation: -4,
    chestCross: 0.015, counterRotation: -22,
    kneeTrackFront: 0.085, kneeTrackRear: 0.075,
    headYaw: -11,
    leadUpperDrop: 42, leadForeDrop: 62, trailUpperDrop: 32, trailForeDrop: 40,
  },
  crouch: { ...REALISTIC.crouch, hipHeight: -0.210 },
};

/** Past the game: the body lays further still and the waist all but stops folding, so a tight turn brings the
 *  hips and the trailing knee round to within a hand's width of the snow. */
const EXTREME: RidingStyle = {
  label: 'Extreme',
  neutral: { ...REALISTIC.neutral, chestBalance: 0.2, hipHeight: 0.690, angulation: 4 },
  heel: {
    ...ARCADE.heel,
    chestBalance: 0.2,
    hipHeight: 0.530, hipCross: -0.020,
    inclination: -63, angulation: 2,
    chestCross: 0.015, counterRotation: 28,
    headYaw: 13,
    leadUpperDrop: 48, leadForeDrop: 68, trailUpperDrop: 42, trailForeDrop: 56,
  },
  toe: {
    ...ARCADE.toe,
    chestBalance: 0.2,
    hipHeight: 0.570, hipCross: 0.020,
    inclination: 61, angulation: -2,
    chestCross: 0.010, counterRotation: -24,
    headYaw: -13,
    leadUpperDrop: 44, leadForeDrop: 64, trailUpperDrop: 36, trailForeDrop: 44,
  },
  crouch: { ...REALISTIC.crouch, hipHeight: -0.200 },
};
/** Ordered along the axis, realistic first — the dropdown reads as the dial it is. */
const SNOWBOARD_STYLES = {
  realistic: REALISTIC,
  balanced: BALANCED,
  arcade: ARCADE,
  extreme: EXTREME,
} satisfies Record<string, RidingStyle>;

export type RidingStyleId = keyof typeof SNOWBOARD_STYLES;
export const DEFAULT_RIDING_STYLE: RidingStyleId = 'balanced';

/**
 * A stance reflected left to right: the same body, turning the other way.
 *
 * The snowboard tables above write both edges out because a snowboarder's two are genuinely not each other
 * reflected — a toe edge is held by extending the ankle into the boot tongue, a heel edge by sitting back. A
 * skier's two turns are. The body is symmetric about its own midline and nothing about a left turn is held
 * differently from a right one, so the ski table authors one and reflects it: half the numbers, and the
 * symmetry becomes a property of the code rather than of somebody's arithmetic.
 *
 * The mirror plane is spanned by `toe` and the body's up, so `toe` and the spine are fixed and `along` flips.
 * Taking the keys in turn: heights, folds, arm drops and the `toe`-ward carries are all symmetric and copy;
 * anything measured ALONG the hip line (`hipFore`, `chestFore`, `shoulderSlope`) flips; anything signed as a
 * turn about a fixed axis (`inclination` about `toe`, `counterRotation` and `headYaw` about the spine) flips;
 * `angulation` does NOT, because its axis flips with its sense and the two cancel; the knee tracks flip and
 * swap legs, since a left turn's inside knee is a right turn's outside one; and an arm swing measured from
 * `along` toward `toe` reflects to `180 − swing`, with the two arms swapping shoulders. `crossFold` flips with
 * the `inclination` it counters, since the two are signed on the same axis.
 *
 * Only meaningful on an ABSOLUTE stance. The crouch is an additive delta, where a mirrored swing would be
 * `−swing` rather than `180 − swing`, so the ski coil below is authored symmetric instead of reflected.
 */
function mirrorStance(s: Stance): Stance {
  return {
    hipHeight: s.hipHeight, hipCross: s.hipCross, hipFore: -s.hipFore,
    inclination: -s.inclination, angulation: s.angulation, crossFold: -s.crossFold,
    chestCross: s.chestCross, chestFore: -s.chestFore,
    counterRotation: -s.counterRotation, shoulderSlope: -s.shoulderSlope, chestBalance: s.chestBalance,
    kneeTrackFront: -s.kneeTrackRear, kneeTrackRear: -s.kneeTrackFront,
    headYaw: -s.headYaw,
    leadUpperDrop: s.trailUpperDrop, leadUpperSwing: 180 - s.trailUpperSwing,
    leadForeDrop: s.trailForeDrop, leadForeSwing: 180 - s.trailForeSwing,
    trailUpperDrop: s.leadUpperDrop, trailUpperSwing: 180 - s.leadUpperSwing,
    trailForeDrop: s.leadForeDrop, trailForeSwing: 180 - s.leadForeSwing,
  };
}

/**
 * SKIING.
 *
 * Every key means what it meant above; what has turned is the frame it is read in, because the feet have.
 * `along` now runs to the rider's LEFT (`front` is the left ski, `rear` the right — the same left/right the
 * on-foot stance uses) and `toe` runs down the fall line. So:
 *
 * - `hipCross` and `chestCross` are FORE and AFT — a skier drives the shins into the boot tongues and carries
 *   the chest out over them, which is nearly all of what an athletic ski stance is.
 * - `hipFore` and `chestFore` are LATERAL — and they pull opposite ways in a turn. The hips go inside it and
 *   the chest stays outside, which is the separation a carve is made of.
 * - `angulation` is the forward fold at the waist, not the toe-ward one. It is larger than a snowboarder's at
 *   every commitment, because a skier's is a permanent feature of the stance rather than a carve's trim.
 * - `inclination` lays the body left or right rather than onto an edge, and `heel` / `toe` are simply the
 *   negative-lean and positive-lean stances, which for a skier are the left-hand and right-hand turn.
 *
 * The four styles are the same one axis the snowboard's are — how far the body lays into the turn past the
 * skis' own roll — so they are generated from one authored turn rather than written out four times. That is
 * not a shortcut standing in for four hand-tuned tables: a skier's styles genuinely differ in commitment and
 * not in technique, and the numbers that do move with commitment are the four `commit` scales below.
 */
const SKI_LAY_IN = 44;   // degrees of lay-in at commitment 1, past the skis' own edge angle

const SKI_NEUTRAL: Stance = {
  hipHeight: 0.745, hipCross: 0.020, hipFore: 0,
  inclination: 0, angulation: 10, crossFold: 0,
  chestCross: 0.045, chestFore: 0,
  counterRotation: 0, shoulderSlope: 0, chestBalance: 1.0,
  kneeTrackFront: 0, kneeTrackRear: 0,
  headYaw: 0,
  leadUpperDrop: 26, leadUpperSwing: 52, leadForeDrop: 70, leadForeSwing: 62,
  trailUpperDrop: 26, trailUpperSwing: 128, trailForeDrop: 70, trailForeSwing: 118,
};

/** The tuck, additive like the snowboard's: down, folded hard at the waist, both hands driven out in front
 *  with the pole tips swept back under the arms. Symmetric, because a tuck is. */
const SKI_CROUCH: Stance = {
  hipHeight: -0.235, hipCross: -0.030, hipFore: 0,
  inclination: 0, angulation: 34, crossFold: 0,
  chestCross: 0.060, chestFore: 0,
  counterRotation: 0, shoulderSlope: 0, chestBalance: 0,
  kneeTrackFront: 0, kneeTrackRear: 0,
  headYaw: 0,
  // The hands come FORWARD, not down: the spine has already folded 34° over the thighs and carried the whole
  // shoulder line with it, so any drop added on top of that is a hand reaching for the snow — which on a
  // committed edge is exactly where the snow is.
  leadUpperDrop: 6, leadUpperSwing: 26, leadForeDrop: -6, leadForeSwing: 18,
  trailUpperDrop: 6, trailUpperSwing: -26, trailForeDrop: -6, trailForeSwing: -18,
};

/**
 * One ski style. `commit` is the axis — the lay-in and everything that grows with it — while `cruise` and
 * `stand` are the hip heights standing and in the turn, `angulate` the share of the lay-in the waist takes
 * back out of the turn, and `balance` how much of the apparent-gravity stack the torso still takes.
 *
 * The realistic end angulates hardest: legs deep into the turn under an upper body that stays nearly upright,
 * which is what a trained skier looks like and is why they can still see where they are going. The arcade end
 * gives that up and throws the whole rider in, exactly as the snowboard axis does.
 */
function skiStyle(label: string, commit: number, cruise: number, stand: number,
                  angulate: number, balance: number): RidingStyle {
  const layIn = SKI_LAY_IN * commit;
  // The LEFT-hand turn: lean left, hips inside it, chest and outside ski holding the other way.
  const left: Stance = {
    hipHeight: stand, hipCross: 0.030, hipFore: 0.055 * commit,
    inclination: -layIn, angulation: 12, crossFold: layIn * angulate,
    chestCross: 0.050, chestFore: -0.035,
    counterRotation: 16 * commit, shoulderSlope: -0.045, chestBalance: balance,
    // Both knees drive into the turn, the inside one hardest — a skier steers with the legs under a quiet
    // upper body, which is the opposite of the snowboard case where only the edge under them moves.
    kneeTrackFront: 0.070, kneeTrackRear: 0.060,
    headYaw: 11 * commit,
    // Both hands come UP off the spine and out in FRONT — a bigger drop is a bigger angle off the spine, and
    // with the body laid into the turn the spine is the direction the snow is in. The inside one (the lead, on
    // the low side of a left turn) comes up hardest, where the next pole plant is; a skier who lets the
    // downhill hand hang at a committed edge angle is dragging it through the hill.
    leadUpperDrop: 48, leadUpperSwing: 60, leadForeDrop: 88, leadForeSwing: 76,
    trailUpperDrop: 34, trailUpperSwing: 120, trailForeDrop: 78, trailForeSwing: 100,
  };
  return {
    label,
    neutral: { ...SKI_NEUTRAL, hipHeight: cruise, chestBalance: balance },
    heel: left, toe: mirrorStance(left),
    crouch: { ...SKI_CROUCH },
  };
}

/**
 * The ladder is deliberately shorter than the snowboard's, and its committed end is not as committed.
 *
 * A snowboarder can put a whole body on the snow, because one wide deck under both feet is still under both
 * feet at any angle. A skier cannot: the two skis are narrow, independent, and the moment the inside one is
 * unweighted past its edge it is gone. So the arcade end of this dial is a skier riding a video game, not a
 * snowboarder's arcade end drawn with skis on.
 */
const SKI_STYLES: Record<RidingStyleId, RidingStyle> = {
  //                                commit  cruise  stand  angulate  balance
  realistic: skiStyle('Realistic', 1.00, 0.745, 0.700, 0.55, 1.0),
  balanced: skiStyle('Balanced', 1.09, 0.735, 0.680, 0.51, 0.7),
  arcade: skiStyle('Arcade', 1.18, 0.725, 0.660, 0.47, 0.4),
  extreme: skiStyle('Extreme', 1.22, 0.715, 0.640, 0.46, 0.2),
};

/** One set of four per gear, under the same four ids — the dial means the same thing on either kit, so
 *  switching gear mid-run keeps the style the author chose. */
export const RIDING_STYLES: Record<RideGear, Record<RidingStyleId, RidingStyle>> = {
  snowboard: SNOWBOARD_STYLES,
  skis: SKI_STYLES,
};

/** The catalogue the Test panel offers. Fixed and built in — unlike characters, nothing here comes off disk. */
export function ridingStyleOptions(): ReadonlyArray<{ id: RidingStyleId; label: string }> {
  return (Object.keys(SNOWBOARD_STYLES) as RidingStyleId[])
    .map(id => ({ id, label: SNOWBOARD_STYLES[id].label }));
}

export function ridingStyle(id: string | undefined, gear: RideGear = 'snowboard'): RidingStyle {
  const styles = RIDING_STYLES[gear] ?? RIDING_STYLES.snowboard;
  return styles[id as RidingStyleId] ?? styles[DEFAULT_RIDING_STYLE];
}
