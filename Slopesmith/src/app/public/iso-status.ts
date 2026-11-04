import type { PublicCourse } from '../../core/session/public-courses';
import { requiredIsoState, requiredSourceMapState } from './course-list';
import { element } from './dom';
import { isoManagementUrl } from './links';
import { tooltip } from '../ui/components/tooltip';
import { mapLabelWithGame } from '../../core/reference/map-game';

/** Colour and text both identify availability; these badges never rely on colour alone. */
export function isoStatusBadges(slots: readonly string[], cached: readonly string[], compact = true): HTMLUListElement {
  const badges = element('ul', 'public-iso-badges');
  badges.setAttribute('aria-label', 'ISO map status');
  const states = requiredIsoState(slots, cached);
  const descriptions = states.map(state =>
    `${mapLabelWithGame({ name: state.slot }, state.name)} · ${state.loaded ? 'Loaded' : 'Not loaded'}`);
  if (compact && states.length > 1) {
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
  section.hidden = !(course.isoCourses.length || course.referenceMaps?.length);
  const title = element('h2', '', 'ISO assets');
  const text = element('p', '', course.kind === 'project'
    ? 'Required for this map’s referenced assets. You can still ride its custom terrain.' : 'Required to play.');
  const manage = element('a', 'public-manage-iso', 'Load ISO maps'); manage.href = isoManagementUrl(course);
  section.append(title, text, isoStatusBadges(course.isoCourses, cached, false), manage);
  title.hidden = text.hidden = manage.hidden = !course.isoCourses.length;
  if (course.referenceMaps?.length) {
    const sources = element('ul', 'public-iso-badges');
    for (const source of requiredSourceMapState(course, cached))
      sources.append(element('li', `public-iso-badge ${source.loaded ? 'loaded' : 'missing'}`,
        `${source.name} · ${source.loaded ? 'Loaded' : 'Source map assets needed'}`));
    section.append(element('h2', '', 'Custom source maps'),
      element('p', '', 'These references need the matching custom map assets in addition to any game ISO assets.'), sources);
  }
  return section;
}

export interface RequirementSnapshot {
  course: PublicCourse;
  available: readonly string[];
  note?: string;
  manageUrl?: string;
}

/** Cards keep long requirement lists behind a summary; server documents are read only when requested. */
export function mapRequirementsDetails(
  course: PublicCourse,
  cached: readonly string[],
  load?: () => Promise<RequirementSnapshot>,
): HTMLDetailsElement | null {
  if (!load && !course.isoCourses.length && !course.referenceMaps?.length) return null;
  const details = element('details', 'public-map-requirements');
  const summary = element('summary', '', load ? 'Check requirements' : 'Requirements');
  const body = element('div', '');
  details.append(summary, body);
  const render = ({ course, available, note, manageUrl }: RequirementSnapshot) => {
    const states = [...requiredIsoState(course.isoCourses, available), ...requiredSourceMapState(course, available)];
    const missing = states.filter(state => !state.loaded).length;
    summary.textContent = missing ? `Missing requirements (${missing})` : 'Requirements met';
    summary.dataset.complete = String(missing === 0);
    const section = isoRequirements(course, available);
    const manage = section.querySelector<HTMLAnchorElement>('.public-manage-iso');
    if (manage && manageUrl) manage.href = manageUrl;
    body.replaceChildren(section);
    if (note) body.prepend(element('p', 'public-requirements', note));
    if (!states.length) body.append(element('p', 'public-requirements', 'No external map assets required.'));
  };
  if (!load) render({ course, available: cached });
  else {
    let state: 'idle' | 'loading' | 'ready' = 'idle';
    details.addEventListener('toggle', () => {
      if (!details.open || state !== 'idle') return;
      state = 'loading';
      summary.textContent = 'Checking requirements…';
      summary.setAttribute('aria-busy', 'true');
      void load().then(snapshot => {
        state = 'ready';
        render(snapshot);
      }).catch(error => {
        state = 'idle';
        summary.textContent = 'Could not check requirements';
        body.replaceChildren(element('p', 'public-requirements',
          `${error instanceof Error ? error.message : String(error)} Close and reopen to retry.`));
      }).finally(() => summary.removeAttribute('aria-busy'));
    });
  }
  return details;
}
