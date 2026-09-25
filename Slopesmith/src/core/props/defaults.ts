import type { NativeCollisionProfile, PropBehaviour } from '../doc/types';
import type { LevelProps, PropInstance } from '../reference/props';
import { collisionProfileFromSourceInstance, defaultPlacedPropCollision } from './contact';
import { ownGeometry } from './kind';
import { PROP_FULL_BRIGHT_RECORD } from '../lighting/prop-lights';

/**
 * Prop defaults (docs/069): what a MODEL hands every new placement of it — how it collides, what riding on it
 * feels like, what it sounds like when hit, whether it is self-lit, which mode layer it lives on.
 *
 * Two sources, one shape (`PropBehaviour`, the placement's own field names):
 *
 *  - A shipped level's model has no behaviour record of its own — every instance points at a shared
 *    ObjectProperties row [Trailmap: 120-objects] — but in practice the row is per model: in GARI 98 of 106
 *    multiply-placed models (ELYSIUM 142 of 152) use one row for every instance. So a reference model's
 *    defaults are DERIVED, read-only: the behaviour its instances most often carry, with the count kept so the
 *    panel can say how representative it is ("313 of 319 placed").
 *  - The author's own models (imported records, tiled models) STORE theirs, edited in the library panel.
 *
 * Defaults are copied onto a placement when it is stamped, never linked: editing a model's defaults changes
 * what the next stamp gets, and "apply to placed" is the explicit way to push them onto existing ones.
 *
 * Ambient ExternalSounds are deliberately never derived: retail hangs them on a few chosen instances (the crowd
 * on particular trees), so a model-wide default would put a crowd on every tree.
 */

/** Every placement field a model's defaults carry. Order is the canonical order for comparisons. */
export const PROP_BEHAVIOUR_FIELDS = [
  'nativeCollision', 'surface', 'modePresence',
  'collisionSound', 'collisionSoundFile',
  'ambientSound', 'ambientSoundFile', 'ambientRadius', 'ambientFalloff', 'ambientHalfExtents',
  'fullBright',
] as const satisfies readonly (keyof PropBehaviour)[];

/** A behaviour with its collision profile always present — what a placement is actually stamped with. */
export type StampBehaviour = PropBehaviour & { nativeCollision: NativeCollisionProfile };

/** A deep copy of just the behaviour fields present on `from` (a placement, a draft, a stored record). */
export function behaviourOf(from: PropBehaviour): PropBehaviour {
  const out: Record<string, unknown> = {};
  for (const field of PROP_BEHAVIOUR_FIELDS) {
    const value = from[field];
    if (value !== undefined) out[field] = structuredClone(value);
  }
  return out as PropBehaviour;
}

/** Replace `to`'s behaviour fields with `behaviour`'s: fields it lacks are removed, not left behind. */
export function applyBehaviour<T extends PropBehaviour>(to: T, behaviour: PropBehaviour): T {
  for (const field of PROP_BEHAVIOUR_FIELDS) delete to[field];
  Object.assign(to, behaviourOf(behaviour));
  return to;
}

/** Key-order-independent serialization, so two behaviours built in different orders compare equal. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Whether two behaviours would stamp identical placements. */
export function sameBehaviour(a: PropBehaviour, b: PropBehaviour): boolean {
  return stable(behaviourOf(a)) === stable(behaviourOf(b));
}

/** The standard starting point when a model has nothing better: borrowed art solid, the author's own decorative. */
export function baselineBehaviour(level: string): StampBehaviour {
  return { nativeCollision: defaultPlacedPropCollision(level) };
}

/** `behaviour` with a collision profile filled in from the baseline when it carries none. */
export function stampBehaviour(level: string, behaviour: PropBehaviour): StampBehaviour {
  const out = behaviourOf(behaviour);
  return { ...out, nativeCollision: out.nativeCollision ?? defaultPlacedPropCollision(level) };
}

const finiteAtLeast = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min;
const intIn = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
const name = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 256;

/**
 * Keep only well-formed behaviour fields from an untrusted record — a request body, a stored file written by an
 * older build. Returns null when nothing usable remains, so "no defaults" has one representation.
 */
export function sanitizePropBehaviour(raw: unknown): PropBehaviour | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: PropBehaviour = {};
  const c = r.nativeCollision as Record<string, unknown> | undefined;
  if (c && typeof c === 'object' && intIn(c.mode, 0, 3) && typeof c.playerCollision === 'boolean'
    && finiteAtLeast(c.responseMass, 0) && typeof c.playerBounce === 'boolean' && finiteAtLeast(c.bounceAmount, 0)) {
    const source = c.physicsSource as Record<string, unknown> | undefined;
    out.nativeCollision = {
      mode: c.mode as 0 | 1 | 2 | 3,
      playerCollision: c.playerCollision,
      responseMass: c.responseMass,
      playerBounce: c.playerBounce,
      bounceAmount: c.bounceAmount,
      ...(source && name(source.level) && intIn(source.body, 0)
        ? { physicsSource: { level: source.level, body: source.body,
            ...(intIn(source.instance, 0) ? { instance: source.instance } : {}) } }
        : {}),
    };
  }
  if (intIn(r.surface, 0)) out.surface = r.surface;
  if (r.modePresence === 'showoff') out.modePresence = 'showoff';
  if (intIn(r.collisionSound, 0)) out.collisionSound = r.collisionSound;
  if (name(r.collisionSoundFile)) out.collisionSoundFile = r.collisionSoundFile;
  if (intIn(r.ambientSound, 0)) out.ambientSound = r.ambientSound;
  if (name(r.ambientSoundFile)) out.ambientSoundFile = r.ambientSoundFile;
  if (finiteAtLeast(r.ambientRadius, 0) && r.ambientRadius > 0) out.ambientRadius = r.ambientRadius;
  if (intIn(r.ambientFalloff, 0, 5)) out.ambientFalloff = r.ambientFalloff;
  const extents = r.ambientHalfExtents;
  if (Array.isArray(extents) && extents.length === 3 && extents.every(e => finiteAtLeast(e, 0) && e > 0))
    out.ambientHalfExtents = [extents[0], extents[1], extents[2]];
  if (r.fullBright === true) out.fullBright = true;
  return Object.keys(out).length ? out : null;
}

/** Retail's self-lit convention: no key light at all and an ambient record of exactly 256 on every channel. */
export function instanceFullBright(inst: Pick<PropInstance, 'lighting'>): boolean {
  const lighting = inst.lighting;
  return !!lighting && lighting.keys.length === 0 && lighting.ambient.every(c => c === PROP_FULL_BRIGHT_RECORD);
}

/** One extracted instance's behaviour, as a placement of the same model would carry it. */
export function instanceBehaviour(level: string, inst: PropInstance): StampBehaviour {
  return {
    nativeCollision: collisionProfileFromSourceInstance(level, inst),
    ...(inst.surface >= 0 ? { surface: inst.surface } : {}),
    ...(inst.ltgState === 2 ? { modePresence: 'showoff' as const } : {}),
    // Event 0 is the native "silent" sentinel, like no record at all — not a sound to copy.
    ...(inst.collisionSound > 0 ? { collisionSound: inst.collisionSound } : {}),
    ...(instanceFullBright(inst) ? { fullBright: true } : {}),
  };
}

/** What makes two instances behave the same. The donor INSTANCE a physics body is borrowed through differs per
 *  instance by construction and is not behaviour; the body itself is. */
function behaviourSignature(behaviour: StampBehaviour): string {
  const { physicsSource, ...collision } = behaviour.nativeCollision;
  return stable({ ...behaviour, nativeCollision: { ...collision, body: physicsSource?.body ?? -1 } });
}

export interface DerivedPropDefaults {
  behaviour: StampBehaviour;
  /** Visible instances carrying exactly this behaviour, out of all the model's visible instances. */
  matching: number;
  total: number;
  /** The first instance with it — the donor a mode-3 body is borrowed through. */
  sourceIndex: number;
}

/** Utility twins that are not the model's art: a breakable's junk replacement, a stand's reset shell. */
const UTILITY_MODEL = /junk|_reset/i;

/**
 * Every model's derived defaults for one extracted level: the behaviour its VISIBLE instances most often carry.
 * A whole-tuple vote rather than a field-by-field one, so the result is always a combination that actually
 * shipped. Ties go to the combination seen first.
 */
export function referencePropDefaults(level: string, props: Pick<LevelProps, 'models' | 'instances'>):
  Map<number, DerivedPropDefaults> {
  const nameOf = new Map(props.models.map(model => [model.id, model.name]));
  const tallies = new Map<number, Map<string, { count: number; first: PropInstance; behaviour: StampBehaviour }>>();
  const totals = new Map<number, number>();
  for (const inst of props.instances) {
    if (!inst.visible || UTILITY_MODEL.test(nameOf.get(inst.model) ?? '')) continue;
    const behaviour = instanceBehaviour(level, inst);
    const key = behaviourSignature(behaviour);
    let byKey = tallies.get(inst.model);
    if (!byKey) tallies.set(inst.model, (byKey = new Map()));
    const tally = byKey.get(key);
    if (tally) tally.count++; else byKey.set(key, { count: 1, first: inst, behaviour });
    totals.set(inst.model, (totals.get(inst.model) ?? 0) + 1);
  }
  const out = new Map<number, DerivedPropDefaults>();
  for (const [model, byKey] of tallies) {
    let best: { count: number; first: PropInstance; behaviour: StampBehaviour } | null = null;
    for (const tally of byKey.values()) if (!best || tally.count > best.count) best = tally;
    if (best) out.set(model, {
      behaviour: best.behaviour, matching: best.count, total: totals.get(model) ?? best.count,
      sourceIndex: best.first.sourceIndex,
    });
  }
  return out;
}

/** Derivation is a pass over every instance of a level; do it once per loaded payload. */
const derivedByPayload = new WeakMap<object, Map<number, DerivedPropDefaults>>();

function derivedFor(level: string, props: LevelProps): Map<number, DerivedPropDefaults> {
  let derived = derivedByPayload.get(props);
  if (!derived) derivedByPayload.set(props, (derived = referencePropDefaults(level, props)));
  return derived;
}

export interface ResolvedPropDefaults {
  /** What a stamp of this model starts with. */
  behaviour: StampBehaviour;
  /** `saved`: the author's own stored defaults · `reference`: derived from a shipped level's placements ·
   *  `baseline`: nothing to go on, the standard starting point. */
  source: 'saved' | 'reference' | 'baseline';
  /** Whether this model's defaults can be saved — true only for the author's own geometry. */
  savable: boolean;
  /** For `reference`: how representative the derived behaviour is, and the instance it was read from. */
  matching?: number;
  total?: number;
  sourceIndex?: number;
}

/** The defaults a new placement of `level`/`model` starts with. `props` is the level's loaded payload, whose
 *  models carry the author's stored defaults and whose instances the reference ones derive from. */
export function resolvePropDefaults(level: string, model: number, props: LevelProps | undefined): ResolvedPropDefaults {
  if (ownGeometry(level)) {
    const saved = props?.models.find(entry => entry.id === model)?.defaults;
    return saved
      ? { behaviour: stampBehaviour(level, saved), source: 'saved', savable: true }
      : { behaviour: baselineBehaviour(level), source: 'baseline', savable: true };
  }
  const derived = props ? derivedFor(level, props).get(model) : undefined;
  if (!derived) return { behaviour: baselineBehaviour(level), source: 'baseline', savable: false };
  return {
    behaviour: stampBehaviour(level, derived.behaviour), source: 'reference', savable: false,
    matching: derived.matching, total: derived.total, sourceIndex: derived.sourceIndex,
  };
}
