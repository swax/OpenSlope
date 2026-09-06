/**
 * How a course is RACED: the lap count and the showoff clock, and what the game itself does with each.
 *
 * The lap count and initial showoff clock belong to the disc SLOT rather than to any level file, which is why
 * they live here rather than being read out of a mountain — but for opposite reasons. Laps have no data behind
 * them anywhere; the showoff clock is a real per-course table in the game's executable, transcribed below.
 * In-run checkpoint bonuses are different: they are type-11 events on the SOP race lines and are authored on
 * course knots in Slopesmith.
 *
 * A lap count is the number of PASSES from the start gate to the finish. One is the classic single run — the
 * first crossing of the finish ends it — and above one a crossing counts the rider round again on the same
 * clock until the last. Nothing else in the document decides this; a mountain's shape says nothing about how
 * many times you ride it.
 *
 * Retail holds no lap table. The engine's shared-state reset seeds a rider counter to 4 when the course index is
 * MEGAPLE's and to 0 for every other course, so the count is a property of the disc SLOT, decided in code
 * ([Trailmap: 390-lap-counter]). That seed IS the pass count: the counter descends once per finish crossing and
 * the race is over when it reaches zero, so Megaplex is ridden top to bottom four times. The announcer counts
 * down the value as it falls — "3 laps to go" at the first crossing — which is why the race reads as "three
 * laps" at the rail: three is the announced count, one short of the passes ridden ([Trailmap: 390-lap-rate]).
 *
 * The count is also what the LAP-GATED boost volume reads: the engine skips that volume outright once the
 * counter is zero ([Trailmap: 360-lapboost-gate]), which is what makes MEGAPLEX's finish tube throw a rider
 * back up the mountain three times and let them through on the fourth. Counting laps and honouring that gate
 * are therefore one feature, not two — see `app/ride/laps.ts` for the test ride's side of it.
 */

/**
 * Which event a run IS. All three are the game's own — its mode enum maps ten values onto `RaceMode`,
 * `ShowoffMode` and `FreerideMode`, and every level's SSF names a function for each ([Trailmap: 230-level-ssf,
 * 395-ai-riders]) — and they differ in more than a label:
 *
 * - **race** counts a clock UP from zero and fields a full six riders;
 * - **showoff** seeds the course's own number and counts DOWN, ends the run at zero, rides SOLO, and is the
 *   only mode in which the four scoring opcodes do anything at all — boost-meter fill, the gem multiplier and
 *   the time bonus each test the mode word for {3,5} and return early otherwise ([Trailmap: 150-logic]);
 * - **freeride** is the mountain with no event on it: solo, and with those same four opcodes dead.
 *
 * One field on the engine's race manager is the clock for all three, and only showoff reverses it
 * ([Trailmap: 390-showoff-clock]) — a freeride ticks the same field up as a race does. Nothing surfaces it
 * there, which is what a free ride IS, so the editor shows no clock rather than inventing a result for a run
 * that has none.
 */
export type RaceMode = 'race' | 'showoff' | 'freeride';

/** The two events that HAVE a clock. A free ride is the third mode and shows none, so anything drawing a
 *  reading is handed one of these rather than being left to decide what a timeless run reads as. */
export type TimedRaceMode = Exclude<RaceMode, 'freeride'>;

/** Does this event run a clock at all? */
export function raceModeIsTimed(mode: RaceMode): mode is TimedRaceMode {
  return mode !== 'freeride';
}

/**
 * Does a run accept the scoring opcodes that retail gates on GameModeGlobal {3,5}? Showoff is the only
 * editor mode mapped to those values. In particular, a gem may still chime and run its collision graph in
 * Race/Freeride, but its MainType-14 multiplier changes no score state there ([Trailmap: 390-gem-mode-gate]).
 */
export function scoringEffectsApplyInMode(mode: RaceMode): boolean {
  return mode === 'showoff';
}

/** What a new test bench opens on. Showoff exposes the retail trick layer — including native multiplier gems and
 *  showoff-only rails/props — so the authored course is visible without another mode change. */
export const DEFAULT_RACE_MODE: RaceMode = 'showoff';

/** A stored/loaded mode; anything unrecognized reads as the default. */
export function normalizeRaceMode(value: unknown): RaceMode {
  return value === 'race' || value === 'showoff' || value === 'freeride' ? value : DEFAULT_RACE_MODE;
}

/** Laps a mountain without an authored count is raced over: one pass, start gate to finish. */
export const DEFAULT_LAPS = 1;

/** The most passes a course may be authored for. Well past retail's four, and short of a count no one could
 *  finish — a bound the editor can present as a slider rather than a free number. */
export const MAX_LAPS = 20;

/** Retail's own lap counts, by extracted level name. Every course is a single pass except the one the engine
 *  seeds a countdown for ([Trailmap: 390-lap-counter, 390-lap-rate]). Mirrors snowknife's `RaceBundle.RetailLaps`,
 *  which supplies the same number to the Unity bundle. */
const REFERENCE_LAPS: Record<string, number> = {
  MEGAPLE: 4,
};

/** Laps an extracted level is raced over — what a loaded reference reports, and 1 for any level we ship no
 *  knowledge of (including every mountain built here, which carries its own count instead). */
export function referenceLaps(level: string): number {
  return REFERENCE_LAPS[level.toUpperCase()] ?? DEFAULT_LAPS;
}

/** An authored count clamped into what the editor can express; anything unusable reads as the default. */
export function normalizeLaps(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const laps = Math.round(value);
  return laps === DEFAULT_LAPS ? undefined : Math.max(1, Math.min(MAX_LAPS, laps));
}

/**
 * THE SHOWOFF CLOCK. A trick run is a COUNTDOWN, not a stopwatch: the engine seeds one field with this many
 * seconds and subtracts a tick's worth per frame, and the run ends for everybody when it reaches zero. Every
 * other mode zeroes that same field and counts it UP instead, which is the race clock ([Trailmap:
 * 390-showoff-clock]). Checkpoints add to it while a showoff run is going, so this is the STARTING budget
 * rather than the whole of one.
 *
 * Retail keeps the number in a per-course record in its executable — the course catalogue the front end lists
 * levels from, seconds held as hundredths — so like laps it is a property of the disc SLOT and nothing in a
 * level file. Unlike laps it is real data, and the table below is that table read out.
 */

/** Seconds a mountain gets on the showoff clock when its author has not said. Garibaldi's number — the first
 *  course, and the most generous of the three retail uses. */
export const DEFAULT_SHOWOFF_SECONDS = 120;

/** The longest showoff clock the editor will author. Well past retail's 135, and short of a countdown nobody
 *  would see the end of — a bound that can be presented as a slider. Zero is the other end and means it: a
 *  mountain with no showoff clock at all, which is what retail's two non-event slots carry. */
export const MAX_SHOWOFF_SECONDS = 300;

/** Largest single checkpoint award the editor accepts. Retail uses 30–150 seconds, but custom mountains get
 *  enough headroom for longer stages without accepting accidental unbounded/invalid document values. */
export const MAX_CHECKPOINT_BONUS_SECONDS = 600;

/** A course-knot checkpoint payload in whole seconds. Zero/invalid means the knot is not a checkpoint. */
export function normalizeCheckpointBonus(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const seconds = Math.max(0, Math.min(MAX_CHECKPOINT_BONUS_SECONDS, Math.round(value)));
  return seconds > 0 ? seconds : undefined;
}

/** Retail's showoff clock per course, in seconds — its own table read out and divided by 100 ([Trailmap:
 *  390-showoff-clock]). Mirrors snowknife's `RaceBundle.RetailShowoffSeconds`, which supplies the same number to
 *  the Unity bundle. UNTRACKED and the trick tutorial are zero because those slots host no showoff event. */
const REFERENCE_SHOWOFF_SECONDS: Record<string, number> = {
  GARI: 120, SNOW: 90, ELYSIUM: 90, MESA: 90, MERQUER: 90, ALOHA: 90,
  PIPE: 90, UNTRACK: 0, MEGAPLE: 90, BIGAIR: 90, TRICK: 0, ALASKA: 135,
};

/** Showoff seconds an extracted level runs — what a loaded reference reports. A level we ship no knowledge of
 *  (including every mountain built here, which carries its own number instead) reads as the default. */
export function referenceShowoffSeconds(level: string): number {
  return REFERENCE_SHOWOFF_SECONDS[level.toUpperCase()] ?? DEFAULT_SHOWOFF_SECONDS;
}

/** An authored clock clamped into what the editor can express. Unlike laps this keeps the default rather than
 *  dropping it, so a mountain that has been given a number carries that number onto whatever slot it is packed
 *  onto — what the slider says is what the bundle gets, instead of silently inheriting the slot's own. */
export function normalizeShowoffSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(MAX_SHOWOFF_SECONDS, Math.round(value)));
}

/** A run clock as the game's own HUD writes one: `m:ss.cc`, centiseconds and all, since that is the precision
 *  the engine stores a race result in ([Trailmap: 390-race-score]). Negative input reads as zero — a countdown
 *  that has expired shows 0:00.00 rather than counting into the red. */
export function formatRunClock(seconds: number): string {
  const total = Math.max(0, seconds);
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;
  const whole = Math.floor(rest);
  const centis = Math.floor((rest - whole) * 100);
  return `${minutes}:${String(whole).padStart(2, '0')}.${String(centis).padStart(2, '0')}`;
}
