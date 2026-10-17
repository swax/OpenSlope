import type { PublicCourse } from '../../core/session/public-courses';
import { requiredIsoState } from './course-list';
import { element } from './dom';
import { isoManagementUrl } from './links';

/** Colour and text both identify availability; these badges never rely on colour alone. */
export function isoStatusBadges(slots: readonly string[], cached: readonly string[]): HTMLUListElement {
  const badges = element('ul', 'public-iso-badges');
  badges.setAttribute('aria-label', 'ISO map status');
  for (const state of requiredIsoState(slots, cached)) {
    const text = `${state.name}${state.name !== state.slot ? ` (${state.slot})` : ''} · ${state.loaded ? 'Loaded' : 'Not loaded'}`;
    const badge = element('li', `public-iso-badge ${state.loaded ? 'loaded' : 'missing'}`, text);
    badge.dataset.course = state.slot;
    badge.setAttribute('aria-label', text);
    badges.append(badge);
  }
  return badges;
}

export function isoRequirements(course: PublicCourse, cached: readonly string[]): HTMLElement {
  const section = element('section', 'public-iso-requirements');
  section.setAttribute('aria-label', 'Required ISO maps');
  section.hidden = !course.isoCourses.length;
  const title = element('h2', '', 'ISO assets');
  const text = element('p', '', course.kind === 'project'
    ? 'Optional: textures and props.' : 'Required to play.');
  const manage = element('a', 'public-manage-iso', 'Load ISO maps'); manage.href = isoManagementUrl(course);
  section.append(title, text, isoStatusBadges(course.isoCourses, cached), manage);
  return section;
}
