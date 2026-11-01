import type { PublicCourse } from '../../core/session/public-courses';
import { canonicalDiscCourse, discCourseName } from '../../core/reference/disc-courses';
import type { ServerReference } from '../../shared/reference-transfer';

export type LibraryVisibility = 'all' | 'public' | 'private';

export interface LibraryGameCourse {
  course: string;
  name: string;
  loaded: boolean;
  disc: boolean;
  server: boolean;
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
  const get = (course: string, cacheKey = false) => {
    const id = canonicalDiscCourse(course.toUpperCase());
    let entry = courses.get(id);
    if (!entry) {
      entry = {
        course: cacheKey ? course : id,
        name: discCourseName(course),
        loaded: false,
        disc: false,
        server: false,
      };
      courses.set(id, entry);
    }
    return entry;
  };
  for (const course of cached) get(course, true).loaded = true;
  for (const course of disc) get(course).disc = true;
  for (const reference of references) {
    const entry = get(reference.course);
    entry.server = true;
    entry.name = reference.displayName ?? entry.name;
  }
  for (const publication of published) {
    if (publication.kind !== 'reference') continue;
    const reference = references.find(reference => reference.name === publication.id);
    const entry = get(reference?.course ?? publication.id);
    entry.server = true;
    entry.publication = publication;
    entry.name = publication.name;
  }
  for (const course of required) get(course);
  for (const entry of courses.values()) if (entry.loaded || entry.disc) entry.name = discCourseName(entry.course);
  return [...courses.values()];
}
