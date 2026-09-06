/** Map-local collision-sound resolution.
 *
 * Snowknife reads the user's boot ELF and BANKS.INF during extraction and writes
 * `Maps/<level>/Audio/SoundIndex.json`. Slopesmith registers those sidecars as their levels are loaded. This
 * module contains resolver behavior only; it intentionally carries no retail event table or level→bank map.
 */

export type CollisionSoundBank = 'course' | 'crowd';

export interface ResolvedCollisionSound {
  bank: CollisionSoundBank;
  slot: number;
}

export interface CollisionSoundIndexEvent {
  Group: number;
  Slot: number;
  Bank: string;
  /** Map-relative path, normally `Audio/SFX/<bank>/<slot>.wav`. */
  Clip: string;
}

export interface CollisionSoundIndex {
  Schema: 'openslope-sound-index/v1' | string;
  Level: string;
  SourceExecutable?: string;
  Banks: Record<string, string>;
  CollisionEvents: Record<string, CollisionSoundIndexEvent>;
}

const indexes = new Map<string, CollisionSoundIndex>();

/** Mutable-in-place so existing UI imports see newly loaded map sidecars without a second state channel. */
export const COURSE_BANK_LEVELS: string[] = [];

function validIndex(value: CollisionSoundIndex | null | undefined): value is CollisionSoundIndex {
  return !!value && value.Schema === 'openslope-sound-index/v1'
    && !!value.Banks && !!value.CollisionEvents;
}

/** Register one Snowknife-generated map sidecar. Invalid or unsupported documents are ignored. */
export function registerCollisionSoundIndex(value: CollisionSoundIndex | null | undefined): boolean {
  if (!validIndex(value)) return false;
  const level = value.Level.trim().toUpperCase();
  if (!level) return false;
  indexes.set(level, value);
  COURSE_BANK_LEVELS.splice(0, COURSE_BANK_LEVELS.length,
    ...[...indexes.entries()].filter(([, index]) => !!index.Banks['2']).map(([name]) => name).sort());
  return true;
}

export function clearCollisionSoundIndexes(): void {
  indexes.clear();
  COURSE_BANK_LEVELS.splice(0);
}

function indexFor(level?: string): CollisionSoundIndex | undefined {
  const exact = level?.trim().toUpperCase();
  return exact ? indexes.get(exact) : indexes.values().next().value;
}

/** The on-disk group-2 course bank recovered for a level, or null until that level's sidecar is loaded. */
export const courseBankName = (level: string): string | null =>
  indexes.get(level.trim().toUpperCase())?.Banks['2'] ?? null;

/** Event id → bank class + slot, sourced from a registered map sidecar. Pass a level whenever one is known so
 * a document extracted from one executable/region can never silently resolve another level's event. */
export function resolveCollisionSound(eventId: number, level?: string): ResolvedCollisionSound | null {
  const entry = indexFor(level)?.CollisionEvents[String(Math.trunc(eventId))];
  if (!entry || (entry.Group !== 2 && entry.Group !== 3)) return null;
  return { bank: entry.Group === 3 ? 'crowd' : 'course', slot: entry.Slot };
}

/** Compact extracted source path with `Maps/` and `Audio/SFX/` elided. */
export function collisionSoundSource(level: string, eventId: number): string | null {
  const sourceLevel = level.trim().toUpperCase();
  const index = indexes.get(sourceLevel);
  const entry = index?.CollisionEvents[String(Math.trunc(eventId))];
  if (!index || !entry) return null;
  const relative = entry.Clip.replace(/^Audio\/SFX\//i, '').replace(/^\/+/, '');
  return relative ? `${sourceLevel}/${relative}` : null;
}

/** MainType-8 PlaySound nodes store a direct group-2 course-bank slot. */
export function effectSoundSource(level: string, slot: number): string | null {
  const sourceLevel = level.trim().toUpperCase();
  const sourceSlot = Math.trunc(slot);
  const bank = courseBankName(sourceLevel);
  if (!sourceLevel || !bank || !Number.isFinite(slot) || sourceSlot < 0 || sourceSlot > 999) return null;
  return `${sourceLevel}/${bank}/${String(sourceSlot).padStart(3, '0')}.wav`;
}

/** Every mapped event id in the locally extracted resolver, ascending. */
export function collisionSoundEventIds(level?: string): number[] {
  return Object.keys(indexFor(level)?.CollisionEvents ?? {}).map(Number).sort((a, b) => a - b);
}

/**
 * Existing engine event ids reserved by the authoring convention for custom prop clips.
 *
 * These are IDENTITIES, not destinations. An export does not know which disc or which course slot it will be
 * packed into, so it cannot know what a given id costs there — and the cost is the whole question, because a
 * rebuilt course bank must not exceed the size its level shipped with and is wholly silent past that line
 * [Trailmap: 260-bank-budget]. What this list has to be is stable, unique and level-agnostic, so that the
 * editor, the export and the ADL agree on which clip is which. Every id here happens to land on an empty slot,
 * which is the WORST case for the budget; the repack re-points them onto slots the target bank already ships
 * and the built level no longer reaches, because that is the first place both facts are known
 * (Snowknife `CustomSoundRouting`). Reordering this list therefore buys nothing and costs the guarantee that
 * a re-export keeps naming the same clip the same way.
 */
export const CUSTOM_SOUND_EVENT_POOL: readonly number[] = [179, 180, 181, 182, 148, 149, 150, 151];

/** Direct course-bank slots reserved for custom PlaySound clips. This is authoring policy, not extracted data. */
export const CUSTOM_EFFECT_SOUND_SLOTS: readonly number[] =
  [98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111];

/** Display label for an event. Material nicknames were evidence notes, so they do not ship in code. */
export function collisionSoundLabel(eventId: number, level?: string): string {
  const id = Math.trunc(eventId);
  return resolveCollisionSound(id, level) ? `${id}` : `${id} (silent)`;
}
