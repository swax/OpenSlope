import type { PublicCourse } from '../../core/session/public-courses';
import { localIsoCourses } from './course-list';
import { isDiscCourse } from '../../core/reference/disc-courses';
import { ISOS_PATH, mapNameAtPath, mapPath, pageInPath } from '../navigation';

export type PublicCourseRequest = { kind: 'project' | 'reference'; name: string; source?: 'iso'; localProjectId?: string };

/** Every authored map has a named public-player route, independent of the editor's address. */
export function publicProjectUrl(name: string, origin = location.origin): string {
  return new URL(mapPath('play', name), origin).href;
}

export function publicCourseUrl(course: PublicCourse, origin = location.origin): string {
  if (course.kind === 'project') {
    const url = new URL(publicProjectUrl(course.name, origin));
    if (course.localProjectId) url.searchParams.set('local', course.localProjectId);
    return url.href;
  }
  const url = new URL(mapPath('play', course.name), origin);
  // Reference names can overlap authored mountains; retain the ISO/library name to disambiguate them.
  url.searchParams.set('reference', course.id);
  if (course.source === 'iso') url.searchParams.set('source', 'iso');
  return url.href;
}

/** Authored maps open for editing; ISO maps occupy only the editor's reference slot. */
export function courseEditorUrl(course: PublicCourse, origin = location.origin): string {
  const url = new URL(mapPath('editor', course.kind === 'project' ? course.name : ''), origin);
  if (course.kind === 'reference') url.searchParams.set('reference', course.id);
  if (course.localProjectId) url.searchParams.set('local', course.localProjectId);
  if (course.private) url.searchParams.set('project', course.id);
  return url.href;
}

export function isoManagementUrl(course?: PublicCourse, origin = location.origin): string {
  const url = new URL(ISOS_PATH, origin);
  if (course) url.searchParams.set(course.kind === 'project' ? 'map' : 'reference', course.kind === 'project' ? course.name : course.id);
  if (course?.source === 'iso') url.searchParams.set('source', 'iso');
  return url.href;
}

export function publicCourseRequest(url: URL): PublicCourseRequest | null {
  const page = pageInPath(url.pathname);
  if (page !== 'play' && page !== 'isos') return null;
  const map = page === 'play' ? mapNameAtPath(url.pathname, 'play') : url.searchParams.get('map');
  if (page === 'play' && !map) return null;
  const reference = url.searchParams.get('reference');
  if (reference) return { kind: 'reference', name: reference, ...(url.searchParams.get('source') === 'iso' ? { source: 'iso' } : {}) };
  return map ? { kind: 'project', name: map, ...(url.searchParams.get('local') ? { localProjectId: url.searchParams.get('local')! } : {}) } : null;
}

/** Resolve against the supplied accessible catalogue and this device's saved maps and ISO cache. */
export function resolvePublicCourse(request: PublicCourseRequest | null, published: readonly PublicCourse[],
  cached: readonly string[], local: readonly PublicCourse[] = []): PublicCourse | null {
  if (!request) return null;
  const name = request.name.toLowerCase();
  if (request.localProjectId) return local.find(course => course.localProjectId === request.localProjectId) ?? null;
  if (request.kind === 'project') return published.find(course => course.kind === 'project'
    && course.name.toLowerCase() === name) ?? null;
  const iso = () => localIsoCourses(isDiscCourse(request.name) ? [...cached, request.name] : cached)
    .find(course => course.id.toLowerCase() === name) ?? null;
  if (request.source === 'iso') return iso();
  return published.find(course => course.kind === 'reference' && course.id.toLowerCase() === name) ?? iso();
}
