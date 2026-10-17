import type { PublicCourse } from '../../core/session/public-courses';
import { localIsoCourses } from './course-list';
import { isDiscCourse } from '../../core/reference/disc-courses';
import { ISOS_PATH, mapNameAtPath, mapPath, pageInPath } from '../navigation';

export type PublicCourseRequest = { kind: 'project' | 'reference'; name: string };

/** Every authored map has a named public-player route, independent of the editor's address. */
export function publicProjectUrl(name: string, origin = location.origin): string {
  return new URL(mapPath('play', name), origin).href;
}

export function publicCourseUrl(course: PublicCourse, origin = location.origin): string {
  if (course.kind === 'project') return publicProjectUrl(course.name, origin);
  const url = new URL(mapPath('play', course.name), origin);
  // Reference names can overlap authored mountains; retain the ISO/library name to disambiguate them.
  url.searchParams.set('reference', course.id);
  return url.href;
}

/** Authored maps open for editing; ISO maps occupy only the editor's reference slot. */
export function courseEditorUrl(course: PublicCourse, origin = location.origin): string {
  const url = new URL(mapPath('editor', course.kind === 'project' ? course.name : ''), origin);
  if (course.kind === 'reference') url.searchParams.set('reference', course.id);
  return url.href;
}

export function isoManagementUrl(course?: PublicCourse, origin = location.origin): string {
  const url = new URL(ISOS_PATH, origin);
  if (course) url.searchParams.set(course.kind === 'project' ? 'map' : 'reference', course.kind === 'project' ? course.name : course.id);
  return url.href;
}

export function publicCourseRequest(url: URL): PublicCourseRequest | null {
  const page = pageInPath(url.pathname);
  if (page !== 'play' && page !== 'isos') return null;
  const map = page === 'play' ? mapNameAtPath(url.pathname, 'play') : url.searchParams.get('map');
  if (page === 'play' && !map) return null;
  const reference = url.searchParams.get('reference');
  if (reference) return { kind: 'reference', name: reference };
  return map ? { kind: 'project', name: map } : null;
}

/** Resolve only against the public catalogue and this device's ISO cache. */
export function resolvePublicCourse(request: PublicCourseRequest | null, published: readonly PublicCourse[],
  cached: readonly string[]): PublicCourse | null {
  if (!request) return null;
  const name = request.name.toLowerCase();
  if (request.kind === 'project') return published.find(course => course.kind === 'project'
    && course.name.toLowerCase() === name) ?? null;
  return published.find(course => course.kind === 'reference' && course.id.toLowerCase() === name)
    ?? localIsoCourses(isDiscCourse(request.name) ? [...cached, request.name] : cached)
      .find(course => course.id.toLowerCase() === name) ?? null;
}
