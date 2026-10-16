import type { PublicCourse } from '../../core/session/public-courses';
import { discCourseName } from '../../core/reference/disc-courses';

/** A published reference takes precedence over its matching local slot, so each course has one card. */
export function coursesWithIso(published: PublicCourse[], available: string[]): PublicCourse[] {
  const courses = [...published];
  const slots = new Set(published.filter(course => course.kind === 'reference' && course.retailData)
    .flatMap(course => course.isoCourses.map(slot => slot.toUpperCase())));
  for (const course of available) {
    const slot = course.toUpperCase();
    if (slots.has(slot)) continue;
    slots.add(slot);
    courses.push({ kind: 'reference', id: slot, name: discCourseName(slot), retailData: true, isoCourses: [slot] });
  }
  return courses.sort((a, b) => a.name.localeCompare(b.name));
}
