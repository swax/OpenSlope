import { MODE_ICON, svg } from '../ui/components/icons';
import { element } from './dom';

const GLYPHS = {
  mountain: MODE_ICON.info,
  new: svg('<path d="M12 5v14M5 12h14"/>'),
  disc: svg('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/><path d="m15 5 4 4M5 15l4 4"/>'),
  play: svg('<path d="m9 5 10 7-10 7Z" fill="currentColor" stroke="none"/>'),
  stop: svg('<rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none"/>'),
  vr: svg('<rect x="3" y="6" width="18" height="12" rx="3"/><circle cx="8" cy="12" r="2"/><circle cx="16" cy="12" r="2"/>'),
  view: svg('<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
  load: svg('<path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/>'),
  github: svg('<path d="M8 21v-4c-3-1-5-3-5-6 0-2 1-3 2-4V3l4 2a13 13 0 0 1 6 0l4-2v4c1 1 2 2 2 4 0 3-2 5-5 6v4M8 19c-4 1-4-3-6-3"/>'),
  discord: svg('<path d="m8 4-4 2c-2 4-3 7-3 11l5 3 2-3m8-13 4 2c2 4 3 7 3 11l-5 3-2-3M7 6c3-1 7-1 10 0M6 16c4 2 8 2 12 0"/><circle cx="8" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1.5" fill="currentColor" stroke="none"/>'),
  about: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.01"/>'),
  account: svg('<circle cx="12" cy="8" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/>'),
  rider: svg('<circle cx="14" cy="4.5" r="2"/><path d="m13 8-2 5m-3-3 8 1m-5 2-2 4m2-4 3 3M4 20l16-5"/>'),
  editor: MODE_ICON.edit,
  chat: svg('<path d="M21 11a8 8 0 0 1-8 8H8l-5 3v-6a8 8 0 1 1 18-5Z"/>'),
  leaveChat: svg('<path d="M21 11a8 8 0 0 1-8 8H8l-5 3v-6a8 8 0 1 1 18-5Z"/><path d="m9 8 6 6m0-6-6 6"/>'),
} as const;

/** Static glyphs use the editor's existing SVG family and stay out of accessible names. */
export function publicGlyph(kind: keyof typeof GLYPHS) {
  const icon = element('span', 'public-icon'); icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = GLYPHS[kind];
  return icon;
}

export function mapHeading(name: string, kind: 'mountain' | 'disc' | 'new') {
  const heading = element('div', 'public-map-heading');
  const symbol = element('span', `public-map-symbol public-map-symbol-${kind}`); symbol.append(publicGlyph(kind));
  heading.append(symbol, element('h3', '', name));
  return heading;
}
