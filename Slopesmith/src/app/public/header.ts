import { element } from './dom';
import { isoManagementUrl } from './links';
import { brand } from '../ui/components/controls';
import { createAccountMenu } from '../ui/chrome/sign-in';
import type { Account } from '../net/account';
import { MAPS_PATH, EDITOR_PATH, editorAccountUrl } from '../navigation';
import { publicProjectMenu } from './project-menu';
import { publicGlyph } from './presentation';
import { activityCounter, watchChatActivity } from './chat-activity';
import { publicCommunityPanel } from './community-panel';
import { lastPublicMap, rememberPublicMap } from './last-map';

/** The same two destinations stay available while browsing, managing a disc or riding. */
export function publicHeader(active: 'iso' | 'maps', account: Account) {
  const header = element('header', 'public-header');
  const identity = element('a', 'public-brand'); identity.href = MAPS_PATH;
  identity.append(brand('Slopesmith'));
  const nav = element('nav', 'public-navigation'); nav.setAttribute('aria-label', 'Primary');
  const iso = element('a', 'public-nav', 'ISO'); iso.href = isoManagementUrl();
  const maps = element('a', 'public-nav', 'Maps'); maps.href = MAPS_PATH;
  const map = element('a', 'public-nav public-map-tab'); map.hidden = true;
  const mapLabel = element('span', ''); map.append(mapLabel);
  const lastMap = lastPublicMap();
  if (lastMap) {
    mapLabel.textContent = lastMap.name; map.href = lastMap.href; map.title = lastMap.name;
    map.setAttribute('aria-label', lastMap.name); map.hidden = false;
  }
  (active === 'iso' ? iso : maps).setAttribute('aria-current', 'page');
  nav.append(iso, maps, map);
  header.append(identity, nav, publicProjectMenu());
  const online = activityCounter('server');
  const users = element('button', 'public-users-toggle'); users.type = 'button';
  users.setAttribute('aria-label', 'Online users'); users.title = 'Online users and chat';
  users.append(online.el); header.append(users);
  const community = publicCommunityPanel(account, users);
  watchChatActivity(activity => online.set(activity?.online ?? null));
  if ('user' in account) {
    header.append(createAccountMenu(account.user, {
      openMyProfile: () => { location.href = editorAccountUrl('profile'); },
      openSettings: () => { location.href = editorAccountUrl('settings'); },
      editorAction: { label: 'Open editor', onClick: () => { location.href = EDITOR_PATH; } },
    }));
  } else {
    const label = account.accounts === 'open' ? 'Editor' : 'Sign in';
    const signIn = element('a', 'public-sign-in'); signIn.setAttribute('aria-label', label); signIn.title = label;
    signIn.append(publicGlyph(account.accounts === 'open' ? 'editor' : 'account'), element('span', 'public-sign-in-label', label));
    signIn.href = account.accounts === 'open' ? EDITOR_PATH : `${EDITOR_PATH}?signin=1`;
    header.append(signIn);
  }
  return {
    header, iso, community,
    setMap(name: string, href: string) {
      mapLabel.textContent = name; map.href = href; map.title = name; map.hidden = false;
      map.setAttribute('aria-label', name); map.setAttribute('aria-current', 'page');
      maps.removeAttribute('aria-current'); iso.removeAttribute('aria-current');
      rememberPublicMap(name, href);
    },
  };
}
