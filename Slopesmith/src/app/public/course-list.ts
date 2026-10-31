import type { PublicCourse } from '../../core/session/public-courses';
import { discCourseName } from '../../core/reference/disc-courses';

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

/** Server publications and locally loaded disc maps are separate shelves, even for the same course slot. */
export function publicCourseGroups(published: readonly PublicCourse[], cached: readonly string[]) {
  return { server: [...published], local: localIsoCourses(cached) };
}

export function requiredIsoState(slots: readonly string[], cached: readonly string[]) {
  const loaded = new Set(cached.map(slot => slot.toUpperCase()));
  return [...new Set(slots.map(slot => slot.toUpperCase()))].map(slot => ({
    slot,
    name: discCourseName(slot),
    loaded: loaded.has(slot),
  }));
}
