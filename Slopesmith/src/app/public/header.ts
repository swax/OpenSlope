import { element } from './dom';
import { editorUrlForPublicMap, isoManagementUrl, publicCourseRequest } from './links';
import { brand } from '../ui/components/controls';
import { createAccountMenu } from '../ui/chrome/sign-in';
import type { Account } from '../net/account';
import { MAPS_PATH, EDITOR_PATH, editorAccountUrl } from '../navigation';
import { publicProjectMenu } from './project-menu';
import { publicGlyph } from './presentation';
import { activityCounter, watchChatActivity } from './chat-activity';
import { publicCommunityPanel } from './community-panel';
import { forgetPublicMap, lastPublicMap, rememberPublicMap } from './last-map';

/** Browsing, ISO management and the editor stay available alongside the current map. */
export function publicHeader(active: 'iso' | 'maps', account: Account) {
  const header = element('header', 'public-header');
  const identity = element('a', 'public-brand');
  identity.href = '/';
  identity.append(brand('Slopesmith'));
  const nav = element('nav', 'public-navigation');
  nav.setAttribute('aria-label', 'Primary');
  const iso = element('a', 'public-nav', 'ISO');
  iso.href = isoManagementUrl();
  const maps = element('a', 'public-nav', 'Library');
  maps.href = MAPS_PATH;
  const editor = element('a', 'public-nav', 'Editor');
  const help = element('a', 'public-nav', 'Help');
  help.href = 'https://slopesmith.net/guides/getting-started/';
  const map = element('a', 'public-nav public-map-tab');
  map.hidden = true;
  const mapLabel = element('span', '');
  map.append(mapLabel);
  let lastMap = lastPublicMap();
  const currentUrl = new URL(location.href);
  editor.href =
    active === 'maps' && publicCourseRequest(currentUrl)
      ? editorUrlForPublicMap(currentUrl)
      : (lastMap?.editorHref ?? editorUrlForPublicMap(new URL(lastMap?.href ?? EDITOR_PATH, location.origin)));
  if (lastMap) {
    mapLabel.textContent = lastMap.name;
    map.href = lastMap.href;
    map.title = lastMap.name;
    map.setAttribute('aria-label', lastMap.name);
    map.hidden = false;
  }
  (active === 'iso' ? iso : maps).setAttribute('aria-current', 'page');
  nav.append(maps, map, editor, help);
  header.append(identity, nav, publicProjectMenu());
  const online = activityCounter('server');
  const users = element('button', 'public-users-toggle');
  users.type = 'button';
  users.setAttribute('aria-label', 'Online users');
  users.title = 'Online users and chat';
  users.append(online.el);
  header.append(users);
  const community = publicCommunityPanel(account, users);
  watchChatActivity(activity => {
    online.set(activity?.online ?? null);
    users.setAttribute('aria-label', activity ? 'Online users' : 'Offline — users and chat');
    users.title = activity ? 'Online users and chat' : online.el.title;
  });
  if ('user' in account) {
    header.append(
      createAccountMenu(account.user, {
        openMyProfile: () => {
          location.href = editorAccountUrl('profile');
        },
        openSettings: () => {
          location.href = editorAccountUrl('settings');
        },
        editorAction: {
          label: 'Open editor',
          onClick: () => {
            location.href = editor.href;
          },
        },
      }),
    );
  } else if (account.accounts !== 'open') {
    const label = 'Sign in';
    const signIn = element('a', 'public-sign-in');
    signIn.setAttribute('aria-label', label);
    signIn.title = label;
    signIn.append(publicGlyph('account'), element('span', 'public-sign-in-label', label));
    signIn.href = `${EDITOR_PATH}?signin=1`;
    header.append(signIn);
  }
  return {
    header,
    iso,
    community,
    setEditor(href: string) {
      editor.href = href;
    },
    syncIsoMaps(cached: readonly string[]) {
      if (!lastMap) return;
      const request = publicCourseRequest(new URL(lastMap.href, location.origin));
      const required = lastMap.requiredIsoCourses ?? (request?.source === 'iso' ? [request.name] : []);
      if (!required.some(course => !cached.includes(course))) return;
      lastMap = null;
      forgetPublicMap();
      map.hidden = true;
      map.removeAttribute('href');
      map.removeAttribute('aria-current');
      editor.href = EDITOR_PATH;
    },
    setMap(name: string, href: string, editorHref: string, requiredIsoCourses: string[] = []) {
      mapLabel.textContent = name;
      map.href = href;
      map.title = name;
      map.hidden = false;
      map.setAttribute('aria-label', name);
      map.setAttribute('aria-current', 'page');
      maps.removeAttribute('aria-current');
      iso.removeAttribute('aria-current');
      editor.href = editorHref;
      lastMap = { name, href, editorHref, requiredIsoCourses };
      rememberPublicMap(name, href, editorHref, requiredIsoCourses);
    },
  };
}
