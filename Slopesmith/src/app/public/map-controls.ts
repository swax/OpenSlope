import { element } from './dom';
import { publicGlyph } from './presentation';
import type { RideControlHelp } from '../ride/control-help';
import type { PublicCourseKind } from '../../core/session/public-courses';

/** Keep launch choices on the mountain, with movement help only after choosing to look around. */
export function publicMapControls(deps: { play: () => void; vr: () => void; view: () => void; inspect: () => void; resetStart: () => void }) {
  const el = element('div', 'public-map-overlays'); el.hidden = true;
  let customStart = false, playing = false;
  const legend = element('section', 'public-view-controls'); legend.hidden = true;
  legend.setAttribute('aria-label', 'Mouse controls');
  const title = element('h2', '', 'Move around');
  const controls = element('dl', '');
  for (const [gesture, action] of [['Click map', 'Set start'], ['Right drag', 'Orbit'], ['Middle drag', 'Pan'], ['Scroll', 'Zoom'],
    ['Hold Alt + WASD', 'Move']]) {
    const pair = element('div', ''); pair.append(element('dt', '', gesture), element('dd', '', action)); controls.append(pair);
  }
  const touch = element('p', 'public-touch-controls', 'Tap to set start · Two fingers to pan or zoom');
  legend.append(title, controls, touch);
  const choices = element('div', 'public-map-choices');
  const launch = element('div', 'public-launch-controls');
  choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', 'Play options');
  const error = element('p', 'public-player-error'); error.hidden = true; error.setAttribute('role', 'alert');
  const reset = element('button', 'public-reset-start', 'Reset start'); reset.type = 'button'; reset.hidden = true;
  reset.title = 'Restore the map’s default start point'; reset.onclick = deps.resetStart;
  const rideLegend = element('details', 'public-ride-controls'); rideLegend.hidden = true;
  rideLegend.setAttribute('role', 'region'); rideLegend.setAttribute('aria-label', 'Ride controls');
  const rideSummary = element('summary', '', 'Ride controls');
  const rideContent = element('div', 'public-ride-controls-content');
  const rideTitle = element('h2', '');
  const rideKeys = element('dl', '');
  rideContent.append(rideTitle, rideKeys); rideLegend.append(rideSummary, rideContent);
  const roomy = matchMedia('(min-width: 1100px)');
  rideLegend.open = roomy.matches;
  roomy.addEventListener('change', () => { rideLegend.open = roomy.matches; });
  const play = element('button', 'public-primary', 'Play'); play.type = 'button'; play.prepend(publicGlyph('play'));
  const vr = element('button', '', 'Play in VR'); vr.type = 'button'; vr.prepend(publicGlyph('vr'));
  const view = element('button', '', 'View map'); view.type = 'button'; view.prepend(publicGlyph('view'));
  const inspect = element('button', '', 'Inspect map'); inspect.type = 'button'; inspect.prepend(publicGlyph('editor'));
  inspect.onclick = deps.inspect;
  view.setAttribute('aria-expanded', 'false');
  legend.id = 'public-mouse-controls'; view.setAttribute('aria-controls', legend.id);
  play.onclick = () => { error.hidden = true; deps.play(); };
  vr.onclick = () => { error.hidden = true; deps.vr(); };
  view.onclick = () => {
    error.hidden = true;
    legend.hidden = !legend.hidden;
    view.setAttribute('aria-expanded', String(!legend.hidden));
    if (!legend.hidden) deps.view();
  };
  choices.append(play, vr, view, inspect); launch.append(reset, choices, error); el.append(legend, launch, rideLegend);
  return {
    el,
    setMapType(kind: PublicCourseKind) {
      inspect.replaceChildren(publicGlyph(kind === 'project' ? 'editor' : 'view'),
        document.createTextNode(kind === 'project' ? 'Edit map' : 'Inspect map'));
    },
    setPlaying(active: boolean) {
      playing = active;
      el.hidden = false; choices.hidden = playing; reset.hidden = playing || !customStart;
      legend.hidden = error.hidden = rideLegend.hidden = true; view.setAttribute('aria-expanded', 'false');
    },
    setCustomStart(custom: boolean) {
      customStart = custom; reset.hidden = playing || !custom;
    },
    setRideControls(help: RideControlHelp | null) {
      rideLegend.hidden = !help;
      if (!help) return;
      rideTitle.textContent = help.title.replace('Test Mode — ', '');
      rideKeys.replaceChildren();
      // Pause and editor UI shortcuts belong to the editor shell; this player uses the ride's own bindings.
      for (const [key, description] of help.groups.flat().filter(([key]) => !['P', 'Alt+Enter', 'M / F8'].includes(key))) {
        const pair = element('div', ''); pair.append(element('dt', '', key), element('dd', '', description)); rideKeys.append(pair);
      }
    },
    error(message: string) { error.textContent = message; error.hidden = false; },
  };
}
