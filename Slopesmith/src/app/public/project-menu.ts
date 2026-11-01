import { PROJECT_LINKS, SERVER_SETUP_URL } from '../project-links';
import { element } from './dom';
import { publicGlyph } from './presentation';
import { offlineStatus } from '../offline';
import type { LastPublicMap } from './last-map';

export const PUBLIC_HELP_URL = 'https://slopesmith.net/guides/getting-started/';

/** Source/community destinations and a short explanation of what this server provides. */
export function publicProjectMenu() {
  const links = element('nav', 'public-project-links'); links.setAttribute('aria-label', 'Project links');
  const external = (label: string, href: string) => {
    const link = element('a', '', label); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer';
    return link;
  };
  for (const { label, href, note, icon } of PROJECT_LINKS) {
    const link = external('', href); link.className = 'public-header-icon public-external-link';
    link.setAttribute('aria-label', label); link.title = `${label} · ${note}`; link.append(publicGlyph(icon));
    links.append(link);
  }
  const about = element('details', 'public-about');
  const summary = element('summary', 'public-header-icon'); summary.setAttribute('aria-label', 'About Slopesmith');
  summary.setAttribute('role', 'button'); summary.setAttribute('aria-expanded', 'false');
  summary.title = 'About Slopesmith · Play and edit with your own assets, or run your own server';
  const aboutIcon = publicGlyph('about'); aboutIcon.classList.add('public-about-icon');
  const moreIcon = publicGlyph('more'); moreIcon.classList.add('public-more-icon');
  summary.append(aboutIcon, moreIcon);
  const panel = element('section', 'public-about-panel');
  panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'About Slopesmith');
  const navigation = element('nav', 'public-mobile-links'); navigation.setAttribute('aria-label', 'More links');
  const returnMap = element('a', 'public-return-map'); returnMap.hidden = true;
  const help = element('a', '', 'Help'); help.href = PUBLIC_HELP_URL;
  navigation.append(returnMap, help); panel.append(navigation);
  panel.append(element('h2', '', 'About Slopesmith'),
    element('p', '', 'This server lets you play and edit maps using your own assets. Load your own ISO to use its maps, textures and props.'),
    element('p', '', 'You can also set up your own server using the OpenSlope source.'));
  const destinations = element('div', 'public-about-links');
  for (const { label, href } of PROJECT_LINKS) destinations.append(external(label, href));
  destinations.append(external('Server setup', SERVER_SETUP_URL));
  panel.append(offlineStatus(), destinations); about.append(summary, panel); links.append(about);
  const mobile = matchMedia('(max-width: 640px)');
  function responsive() {
    summary.setAttribute('aria-label', mobile.matches ? 'More' : 'About Slopesmith');
    summary.title = mobile.matches ? 'More — help, about and project links'
      : 'About Slopesmith · Play and edit with your own assets, or run your own server';
    panel.setAttribute('aria-label', mobile.matches ? 'More links' : 'About Slopesmith');
  }
  responsive();
  mobile.addEventListener('change', () => {
    if (about.open) { about.open = false; summary.focus({ preventScroll: true }); }
    responsive();
  });
  about.addEventListener('toggle', () => summary.setAttribute('aria-expanded', String(about.open)));
  panel.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('a')) about.open = false;
  });
  document.addEventListener('pointerdown', event => {
    if (!about.contains(event.target as Node)) about.open = false;
  });
  about.addEventListener('keydown', event => {
    if (event.key === 'Escape' && about.open) {
      event.preventDefault(); event.stopPropagation(); about.open = false; summary.focus();
      return;
    }
    // Closed help must not retain riding shortcuts when focus returns to its trigger.
    if (about.open || (event.target === summary && ['Enter', ' '].includes(event.key))) event.stopPropagation();
    if (event.target === summary && event.key === ' ') {
      // Toggle before the ride's keyup handler releases Space; that handler owns an earlier held ollie too.
      event.preventDefault();
      if (!event.repeat) about.open = !about.open;
    }
  });
  return {
    el: links,
    setMap(map: Pick<LastPublicMap, 'name' | 'href'> | null) {
      returnMap.hidden = !map;
      if (map) {
        returnMap.textContent = `Return to ${map.name}`;
        returnMap.href = map.href;
      } else {
        returnMap.textContent = '';
        returnMap.removeAttribute('href');
      }
    },
  };
}
