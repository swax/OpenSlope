import type { PublicCourse } from '../../core/session/public-courses';
import { canonicalDiscCourse, discContainsCourse, discCourseName } from '../../core/reference/disc-courses';

export const publicCourseLabel = (course: PublicCourse): string =>
  course.kind === 'reference' && course.name !== course.id ? course.name : course.name.replace(/[_-]/g, ' ');

export function localIsoCourses(cached: readonly string[]): PublicCourse[] {
  return [...new Set(cached.map(slot => slot.toUpperCase()))]
    .map(slot => ({
      kind: 'reference' as const,
      id: slot,
      name: discCourseName(slot),
      source: 'iso' as const,
      retailData: true,
      isoCourses: [slot],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Source records for player navigation; the Library merges game-course availability into one row. */
export function publicCourseGroups(published: readonly PublicCourse[], cached: readonly string[]) {
  return { server: [...published], local: localIsoCourses(cached) };
}

export function requiredIsoState(slots: readonly string[], cached: readonly string[]) {
  const unique = new Map<string, string>();
  for (const slot of slots) {
    const key = canonicalDiscCourse(slot.toUpperCase());
    if (!unique.has(key)) unique.set(key, slot.toUpperCase());
  }
  return [...unique.values()].map(slot => ({
    slot,
    name: discCourseName(slot),
    loaded: discContainsCourse(cached, slot),
  }));
}
