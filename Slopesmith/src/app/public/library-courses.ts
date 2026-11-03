import type { PublicCourse } from '../../core/session/public-courses';
import { canonicalDiscCourse, discContainsCourse, discCourseName } from '../../core/reference/disc-courses';
import { mapGame, type MapSourceChoice } from '../../core/reference/map-game';
import type { ServerReference } from '../../shared/reference-transfer';
import { isoGameForCourse, type IsoGame } from './iso-discs';

export type LibraryVisibility = 'all' | 'public' | 'private';
export type LibraryReferenceGroup = IsoGame | 'other';
export type LibraryCounts = Record<LibraryVisibility | 'other', number>;

const referenceGames: Partial<Record<string, IsoGame>> = {
  'ssx-tricky': 'tricky', 'ssx-tricky-gba': 'tricky-gba', ssx: 'ssx', 'ssx-3': 'ssx3', 'ssx-3-beta': 'ssx3-beta',
  'ssx-on-tour': 'ontour', '1080-avalanche': 'avalanche', 'jonny-moseley-mad-trix': 'madtrix',
};

export interface LibraryGameCourse {
  key: string;
  course: string;
  name: string;
  loaded: boolean;
  disc: boolean;
  server: boolean;
  game: LibraryReferenceGroup;
  reference?: ServerReference;
  publication?: PublicCourse;
}

/** Private is reserved for custom maps; game maps stay in All, Public and game views. */
export function libraryGameSources(entry: LibraryGameCourse, visibility: LibraryVisibility) {
  return {
    device: visibility === 'all' && (entry.loaded || entry.disc),
    server: entry.server && (visibility === 'all' || (visibility === 'public' && !!entry.publication)),
  };
}

/** One course per canonical slot, retaining the actual cache key for loading and unloading old imports. */
export function libraryGameCourses(
  cached: readonly string[],
  disc: readonly string[],
  references: readonly ServerReference[],
  published: readonly PublicCourse[],
  required: readonly string[] = [],
): LibraryGameCourse[] {
  const courses = new Map<string, LibraryGameCourse>();
  const isoSlots = [...cached, ...disc, ...required,
    ...published.filter(map => map.kind === 'reference' && map.retailData).flatMap(map => map.isoCourses)];
  const get = (course: string, cacheKey = false, source: MapSourceChoice = { name: course }) => {
    const sourceGame = mapGame(source);
    const legacySlot = sourceGame === 'unknown' && isoSlots.find(slot => discContainsCourse([slot], course));
    const game: LibraryReferenceGroup = referenceGames[sourceGame] ?? (legacySlot ? isoGameForCourse(legacySlot) : 'other');
    const physical = game === 'tricky' ? canonicalDiscCourse(course.toUpperCase()) : course;
    const id = `${game}:${physical.toUpperCase()}`;
    let entry = courses.get(id);
    if (!entry) {
      entry = {
        key: id,
        course: cacheKey ? course : physical,
        name: game === 'other' ? source.name : discCourseName(course),
        loaded: false,
        disc: false,
        server: false,
        game,
      };
      courses.set(id, entry);
    }
    return entry;
  };
  for (const course of cached) get(course, true).loaded = true;
  for (const course of disc) get(course).disc = true;
  for (const reference of references) {
    const entry = get(mapGame(reference) === 'slopesmith' ? reference.name : reference.course, false, reference);
    entry.server = true;
    entry.reference = reference;
    entry.name = reference.displayName ?? entry.name;
  }
  for (const publication of published) {
    if (publication.kind !== 'reference') continue;
    const reference = references.find(reference => reference.name === publication.id);
    const entry = reference
      ? get(mapGame(reference) === 'slopesmith' ? reference.name : reference.course, false, reference)
      : get(publication.id, false, { name: publication.id, ...(publication.retailData ? {} : { origin: 'slopesmith' }) });
    entry.server = true;
    entry.publication = publication;
    entry.name = publication.name;
  }
  for (const course of required) get(course);
  for (const entry of courses.values()) if (entry.loaded || entry.disc) entry.name = discCourseName(entry.course);
  return [...courses.values()];
}
