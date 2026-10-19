import type { PublicCourse } from '../../core/session/public-courses';
import { requiredIsoState } from './course-list';
import { element } from './dom';
import { isoManagementUrl } from './links';
import { tooltip } from '../ui/components/tooltip';

/** Colour and text both identify availability; these badges never rely on colour alone. */
export function isoStatusBadges(slots: readonly string[], cached: readonly string[]): HTMLUListElement {
  const badges = element('ul', 'public-iso-badges');
  badges.setAttribute('aria-label', 'ISO map status');
  const states = requiredIsoState(slots, cached);
  const descriptions = states.map(state =>
    `${state.name}${state.name !== state.slot ? ` (${state.slot})` : ''} · ${state.loaded ? 'Loaded' : 'Not loaded'}`);
  if (states.length > 1) {
    const missing = states.filter(state => !state.loaded).length;
    const text = missing ? `Requirements unfulfilled (${missing})` : 'Requirements fulfilled';
    const details = descriptions.join('\n');
    const badge = element('li', `public-iso-badge public-iso-summary ${missing ? 'missing' : 'loaded'}`, text);
    badge.setAttribute('aria-label', `${text}: ${details}`);
    tooltip(badge, details, { wide: true });
    badges.append(badge);
    return badges;
  }
  for (const [index, state] of states.entries()) {
    const text = descriptions[index];
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
