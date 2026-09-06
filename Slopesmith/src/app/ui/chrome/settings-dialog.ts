import { administersServer } from '../../net/account';
import { saveServerWorkspaceConfig, type ServerWorkspacePatch } from '../../state/server-config';
import { loadSettings, saveSettings, type VideoBridgePrefs } from '../../state/settings';
import { infoBadge } from '../components/info';
import { modal } from '../components/modal';
import { installStyles } from '../components/styles';
import { toast } from '../components/toast';
import {
  buildAccountSecuritySection,
  buildDeviceSection,
  buildProfileSection,
  type ProfileSaveResult,
} from './settings-dialog-account';
import {
  buildEquipmentSection,
  type EquipmentSaveResult,
} from './settings-dialog-equipment';
import {
  buildAgentApiSection,
  buildKeysSection,
  buildVideoBridgeSection,
} from './settings-dialog-integrations';
import {
  buildServerConfigSection,
  buildVersionSection,
  buildVoiceServerSection,
  type ServerConfigSection,
} from './settings-dialog-server';
import { settingsDialogCss } from './settings-dialog-styles';
import { buildSettingsTabs, type SettingsTabName } from './settings-dialog-tabs';

/**
 * Settings coordinates browser-local preferences, account edits, equipment, and administrator-owned server
 * configuration. Each section owns its UI and persistence details; this module owns the modal transaction.
 */

const KEY_HELP = 'Your own key, and it stays yours: generation is billed to whoever pasted it, so on a server '
  + 'with several members everybody sets their own here. Unlocks Generate texture in the Texture Library, '
  + 'Generate prop in the Prop Library, and ✨ generate on the Skybox panel. Create a key at '
  + 'fal.ai/dashboard/keys.\n\n'
  + 'Stored in this browser’s localStorage and sent with your own generate requests to the Slopesmith server, '
  + 'which forwards it to fal.ai for that one call and never writes it to disk or shows it to another member. '
  + 'Anyone with access to this browser profile can read it — treat it like a key in a local .env, and revoke '
  + 'it at fal.ai if that changes.';

/** The Settings modal. Nothing is written until Save; only its explicit Close button discards staged edits. */
export function openSettingsDialog(initialTab: SettingsTabName = 'integrations'): void {
  // The boot-time account probe has already settled before the editor loads, so this normally resolves in
  // the next microtask. Resolve the role before creating any DOM: an ordinary member never briefly receives
  // a Server tab, nor starts one of its version/capability probes before the tab is removed.
  void administersServer().then(
    mayAdminister => renderSettingsDialog(initialTab, mayAdminister),
    () => renderSettingsDialog(initialTab, false),
  );
}

function renderSettingsDialog(initialTab: SettingsTabName, mayAdminister: boolean): void {
  installStyles('settings-dialog', settingsDialogCss);
  const settings = loadSettings();
  const { host, close } = modal({ sticky: true });
  host.classList.add('sp-settings');
  host.setAttribute('role', 'dialog');
  host.setAttribute('aria-modal', 'true');
  host.setAttribute('aria-labelledby', 'sp-settings-title');

  const title = document.createElement('h2');
  title.id = 'sp-settings-title';
  title.className = 'settings-title';
  title.textContent = 'Settings';
  const tabs = buildSettingsTabs(mayAdminister);
  tabs.select(initialTab);

  const sec = document.createElement('div');
  sec.className = 'sec';
  const secTitle = document.createElement('h3');
  secTitle.textContent = 'fal.ai API key';
  secTitle.appendChild(infoBadge(KEY_HELP));

  const row = document.createElement('div');
  row.className = 'keyrow';
  const input = document.createElement('input');
  input.type = 'password';
  input.placeholder = 'key id:key secret';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.value = settings.falKey;
  const reveal = document.createElement('button');
  reveal.type = 'button';
  reveal.className = 'sp-btn';
  reveal.textContent = 'Show';
  reveal.onclick = () => {
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    reveal.textContent = hidden ? 'Hide' : 'Show';
  };
  row.append(input, reveal);

  const state = document.createElement('div');
  state.className = 'state';
  const showState = () => {
    const has = !!input.value.trim();
    state.classList.toggle('set', has);
    state.textContent = has ? 'Key set — the generators are available.' : 'No key — the generators stay disabled.';
  };
  input.oninput = showState;
  showState();

  sec.append(secTitle, row, state);
  const videoBridge = buildVideoBridgeSection(settings.videoBridge);
  const profile = buildProfileSection();
  const device = buildDeviceSection();
  const security = buildAccountSecuritySection();
  const equipment = buildEquipmentSection();
  // Keep decoded source-image cleanup tied to the dialog DOM as a backstop for application teardown too.
  const equipmentCloseObserver = new MutationObserver(() => {
    if (host.isConnected) return;
    equipment.dispose();
    equipmentCloseObserver.disconnect();
  });
  equipmentCloseObserver.observe(document.body, { childList: true });
  let reloadOnClose = false;
  const closeSettings = () => {
    equipment.dispose();
    close();
    if (reloadOnClose) setTimeout(() => location.reload(), 100);
  };
  // Access keys sit beside the Agent API pointer they unlock: mint a key here, hand the root URL beneath it
  // to an agent, and it discovers the rest itself. Both moved out of Account because a key is an
  // integration credential, not a fact about the account.
  tabs.integrations.append(sec, buildKeysSection(), buildAgentApiSection(), videoBridge.el);
  tabs.account.append(profile.el, device.el, security);
  tabs.gear.append(equipment.el);

  /** Present only for an administrator; null is an ordinary member, who has no folders to save. */
  let serverConfig: ServerConfigSection | null = null;
  if (mayAdminister && tabs.server) {
    const version = buildVersionSection();
    serverConfig = buildServerConfigSection();
    tabs.server.append(serverConfig.el, buildVoiceServerSection(), version);
  }

  const actions = document.createElement('div');
  actions.className = 'sp-modal-actions';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'sp-btn';
  closeButton.textContent = 'Close';
  closeButton.onclick = closeSettings;
  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'sp-btn accent';
  save.textContent = 'Save';
  save.onclick = async () => {
    const key = input.value.trim();
    let bridgePrefs: VideoBridgePrefs;
    try { bridgePrefs = videoBridge.value(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      videoBridge.fail(message);
      tabs.select('integrations');
      toast(`Could not save video bridge: ${message}`, 'err', 7000);
      return;
    }
    save.disabled = true;
    closeButton.disabled = true;
    let profileChange: ProfileSaveResult;
    let equipmentChange: EquipmentSaveResult;
    try {
      profileChange = await profile.save();
    } catch (error) {
      save.disabled = false;
      closeButton.disabled = false;
      const message = `Could not save account profile: ${error instanceof Error ? error.message : error}`;
      tabs.select('account');
      toast(message, 'err', 7000);
      return;
    }
    try {
      equipmentChange = await equipment.save();
    } catch (error) {
      save.disabled = false;
      closeButton.disabled = false;
      const message = `Could not save gear: ${error instanceof Error ? error.message : error}`;
      tabs.select('gear');
      toast(message, 'err', 7000);
      return;
    }
    saveSettings({ falKey: key, videoBridge: bridgePrefs });
    try {
      const patch: ServerWorkspacePatch = serverConfig?.patch() ?? {};
      const result = Object.keys(patch).length ? await saveServerWorkspaceConfig(patch) : null;
      const deviceName = device.save();
      if (deviceName) reloadOnClose = true;
      if (result) serverConfig?.accept(result.config);
      save.disabled = false;
      closeButton.disabled = false;
      const keyMessage = key ? 'fal.ai key saved.' : 'fal.ai key cleared.';
      const bridgeMessage = ' Video bridge settings saved.';
      const usernameMessage = profileChange.username ? ' Username saved.' : '';
      const bioMessage = profileChange.bio ? ' Bio saved.' : '';
      const profileMessage = profileChange.picture === 'saved' ? ' Profile picture saved.'
        : profileChange.picture === 'removed' ? ' Profile picture removed.' : '';
      const deviceMessage = deviceName ? ` Device renamed to “${deviceName}”; it will appear after Settings closes.` : '';
      const equipmentMessage = equipmentChange === 'saved' ? ' Equipment artwork saved.' : '';
      const savedMessage = `${keyMessage}${bridgeMessage}${usernameMessage}${bioMessage}${profileMessage}${deviceMessage}${equipmentMessage}`;
      toast(!result ? savedMessage : result.restartRequired
        ? `${savedMessage} Storage paths saved — restart Slopesmith to use them.`
        : `${savedMessage} Server settings saved.`, 'ok', result?.restartRequired ? 7000 : 3500);
    } catch (error) {
      save.disabled = false;
      closeButton.disabled = false;
      const message = `Could not save server settings: ${error instanceof Error ? error.message : error}`;
      serverConfig?.fail(message);
      tabs.select('server');
      toast(message, 'err', 7000);
    }
  };
  actions.append(closeButton, save);

  host.append(title, tabs.el, actions);

  if (initialTab === 'integrations') input.focus();
  // Enter saves from the key field; Close is deliberately the only dismissal control.
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } };
}
