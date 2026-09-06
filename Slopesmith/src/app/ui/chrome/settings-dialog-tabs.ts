import { buildLegalPanel } from './legal-panel';

export type SettingsTabName = 'integrations' | 'account' | 'gear' | 'server' | 'legal';

interface SettingsTabs {
  el: HTMLDivElement;
  integrations: HTMLDivElement;
  account: HTMLDivElement;
  gear: HTMLDivElement;
  server: HTMLDivElement | null;
  legal: HTMLDivElement;
  select: (name: SettingsTabName, focus?: boolean) => void;
}

/** Accessible pages inside one save transaction. Administrators get the additional Server page; ordinary
 * members never receive its tab or panel. Tab changes only presentation: every field stays alive, so
 * switching pages never discards an edit or restarts one of the asynchronous server probes.
 * Legal is the odd one out — it holds no settings at all, only the disclaimers and third-party notices
 * (legal-panel.ts), which live here because Settings is where a user looks for "about this program". */
export function buildSettingsTabs(includeServer: boolean): SettingsTabs {
  const el = document.createElement('div');
  el.className = 'settings-tabs';

  const tablist = document.createElement('div');
  tablist.className = 'settings-tablist';
  tablist.setAttribute('role', 'tablist');
  tablist.setAttribute('aria-label', 'Settings categories');

  const panelHost = document.createElement('div');
  panelHost.className = 'settings-tabpanels';
  const specs: { name: SettingsTabName; label: string }[] = [
    { name: 'integrations', label: 'Integrations' },
    { name: 'account', label: 'Account' },
    { name: 'gear', label: 'Gear' },
    { name: 'legal', label: 'Legal' },
  ];
  if (includeServer) specs.splice(3, 0, { name: 'server', label: 'Server' });
  const buttons = new Map<SettingsTabName, HTMLButtonElement>();
  const panels = new Map<SettingsTabName, HTMLDivElement>();

  const select = (name: SettingsTabName, focus = false) => {
    const availableName = panels.has(name) ? name : 'integrations';
    for (const spec of specs) {
      const selected = spec.name === availableName;
      const button = buttons.get(spec.name)!;
      const panel = panels.get(spec.name)!;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      panel.hidden = !selected;
    }
    if (focus) buttons.get(availableName)?.focus();
  };

  specs.forEach((spec, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'settings-tab';
    button.id = `sp-settings-tab-${spec.name}`;
    button.dataset.settingsTab = spec.name;
    button.textContent = spec.label;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', `sp-settings-panel-${spec.name}`);
    button.onclick = () => select(spec.name);
    button.onkeydown = event => {
      let next: number;
      if (event.key === 'ArrowRight') next = (index + 1) % specs.length;
      else if (event.key === 'ArrowLeft') next = (index + specs.length - 1) % specs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = specs.length - 1;
      else return;
      event.preventDefault();
      select(specs[next].name, true);
    };

    const panel = document.createElement('div');
    panel.className = 'settings-tabpanel';
    panel.id = `sp-settings-panel-${spec.name}`;
    panel.dataset.settingsPanel = spec.name;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', button.id);
    panel.tabIndex = 0;
    buttons.set(spec.name, button);
    panels.set(spec.name, panel);
    tablist.appendChild(button);
    panelHost.appendChild(panel);
  });

  el.append(tablist, panelHost);
  select('integrations');
  const legal = panels.get('legal')!;
  buildLegalPanel(legal);   // static content: built once, never re-read from a setting
  return {
    el,
    integrations: panels.get('integrations')!,
    account: panels.get('account')!,
    gear: panels.get('gear')!,
    server: panels.get('server') ?? null,
    legal,
    select,
  };
}
