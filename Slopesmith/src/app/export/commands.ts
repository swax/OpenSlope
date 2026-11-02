import './commands.css';
import { snowknifeBuildCommands } from '../../core/export/disc';

type SnowknifeTarget = 'iso' | 'mod-manager';

export function snowknifeTarget(purpose: string): SnowknifeTarget | null {
  if (purpose === 'snowknife-iso') return 'iso';
  if (purpose === 'snowknife-mod-manager') return 'mod-manager';
  return null;
}

/** Build instructions stay available before download in both editor and library exports. */
export function createSnowknifeCommands(folderName: string) {
  const commands = snowknifeBuildCommands(folderName, {
    exportDir: folderName,
    archive: `${folderName}.snowknife.zip`,
    levelData: 'Maps/TRICKY_GARI',
  });
  const section = document.createElement('section');
  section.className = 'sp-snowknife-commands';
  section.setAttribute('aria-label', 'Snowknife commands');
  const title = document.createElement('h4');
  title.textContent = 'Build with Snowknife';
  const tools = document.createElement('p');
  tools.className = 'sp-command-tools';
  const toolLink = (label: string, href: string) => {
    const link = document.createElement('a');
    link.textContent = label;
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  };
  const modManagerLink = toolLink('Get SSX Mod Manager', 'https://github.com/GlitcherOG/SSXModManager');
  tools.append(toolLink('Get Snowknife', 'https://github.com/swax/OpenSlope/tree/main/Snowknife'), modManagerLink);
  const hint = document.createElement('p');
  hint.textContent =
    'Run beside the downloaded ZIP. Replace ssx-tricky.iso with your PS2 Tricky ISO path. These commands replace Garibaldi.';
  const feedback = document.createElement('div');
  feedback.className = 'sp-command-feedback';
  feedback.setAttribute('role', 'status');
  const row = (label: string, command: string, copyLabel: string) => {
    const item = document.createElement('div');
    item.className = 'sp-command';
    const head = document.createElement('div');
    head.className = 'sp-command-head';
    const name = document.createElement('span');
    name.textContent = label;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copy';
    copy.setAttribute('aria-label', `Copy ${copyLabel} command`);
    const pre = document.createElement('pre');
    pre.tabIndex = 0;
    pre.setAttribute('aria-label', `${copyLabel} command`);
    const code = document.createElement('code');
    code.textContent = command;
    pre.append(code);
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(command);
        feedback.textContent = `Copied ${copyLabel} command.`;
      } catch {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        feedback.textContent = 'Command selected. Copy the selected text to continue.';
      }
    };
    head.append(name, copy);
    item.append(head, pre);
    return item;
  };
  const setup = row('Import Garibaldi (only needed once)', commands.prepare, 'setup');
  const iso = row('Build a custom PS2 ISO', commands.iso, 'ISO');
  const modManager = row('Build an SSX Mod Manager ZIP', commands.modManager, 'mod manager');
  section.append(title, tools, hint, setup, iso, modManager, feedback);
  return {
    element: section,
    setTarget(target: SnowknifeTarget | null) {
      section.hidden = target === null;
      iso.hidden = target !== 'iso';
      modManager.hidden = target !== 'mod-manager';
      modManagerLink.hidden = target !== 'mod-manager';
      feedback.textContent = '';
    },
  };
}
