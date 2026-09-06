import { legalPanelCss } from './legal-panel';

export const settingsDialogCss = `
.sp-settings { width: 500px; height: min(620px, calc(100vh - 24px)); overflow: hidden; box-sizing: border-box;
  display: flex; flex-direction: column;
  padding: 12px 14px 10px; color: #d7e3f0;
  background: #0c141d; border: 1px solid #2c3e50; border-radius: 7px;
  font: 12px/1.45 system-ui, sans-serif; box-shadow: 0 12px 40px #0009; }
.sp-settings .settings-title { flex: 0 0 auto; margin: 0 0 9px; color: #e7f2fc;
  font: 650 16px/1.25 system-ui, sans-serif; }
.sp-settings .settings-tabs { display: flex; flex: 1 1 auto; min-height: 0; flex-direction: column; }
.sp-settings .settings-tablist { display: flex; flex: 0 0 auto; gap: 4px; padding: 0 0 9px;
  border-bottom: 1px solid #23364a; }
.sp-settings .settings-tab { flex: 1 1 0; min-width: 0; padding: 7px 8px; color: #8fa8bd;
  background: transparent; border: 1px solid transparent; border-radius: 5px;
  font: 600 11.5px/1.2 system-ui, sans-serif; cursor: pointer; }
.sp-settings .settings-tab:hover { color: #d7e3f0; background: #111f2c; }
.sp-settings .settings-tab[aria-selected=true] { color: #e9f5ff; background: #173047;
  border-color: #315574; }
.sp-settings .settings-tab:focus-visible { outline: 2px solid #4b85b5; outline-offset: 2px; }
.sp-settings .settings-tabpanels { flex: 1 1 auto; min-height: 0; }
.sp-settings .settings-tabpanel { height: 100%; overflow-y: auto; box-sizing: border-box; padding: 2px 4px 0 1px; }
.sp-settings .settings-tabpanel[hidden] { display: none; }
.sp-settings > .sp-modal-actions { flex: 0 0 auto; margin-top: 8px; padding-top: 10px;
  border-top: 1px solid #23364a; background: #0c141d; }
.sp-settings h3 { margin: 0 0 2px; color: #cfe3f5; font: 600 13px system-ui, sans-serif; }
.sp-settings .sec { padding: 10px 0 12px; border-bottom: 1px solid #23364a; }
.sp-settings .sec:last-of-type { border-bottom: 0; }
.sp-settings .keyrow { display: flex; gap: 6px; margin: 8px 0 6px; }
.sp-settings .keyrow input { width: auto; }
.sp-settings .pathrow { margin: 8px 0; }
.sp-settings .rowhead { display: flex; align-items: center; gap: 5px; margin-bottom: 3px; }
.sp-settings .rowhead label { color: #a9bdd0; font-size: 11px; }
.sp-settings input[type=text], .sp-settings input[type=password], .sp-settings input[type=url],
.sp-settings input[type=number], .sp-settings select {
  width: 100%; box-sizing: border-box; flex: 1 1 auto; min-width: 0; background: #0e1822; color: #d7e3f0; border: 1px solid #2c3e50;
  border-radius: 4px; padding: 6px 8px; font: 12px/1.3 ui-monospace, Consolas, monospace; }
.sp-settings input:focus, .sp-settings select:focus { outline: 0; border-color: #3a6ea5; }
.sp-settings input:disabled, .sp-settings select:disabled { color: #8aa0b4; }
.sp-settings .keyrow .sp-btn { flex: 0 0 auto; min-width: 56px; }
/* The Agent API section's explorer link wears the button style; an anchor keeps its underline unless told. */
.sp-settings a.sp-btn { display: inline-flex; align-items: center; text-decoration: none; box-sizing: border-box; }
.sp-settings .state { color: #7f97ac; font-size: 11px; }
.sp-settings .state.set { color: #6ee7a8; }
.sp-settings .profile-username { margin: 8px 0 2px; }
.sp-settings .profile-bio { margin: 8px 0 2px; }
.sp-settings .profile-bio .rowhead { justify-content: space-between; }
.sp-settings .profile-bio-count { color: #71899e; font-size: 10px; }
.sp-settings .profile-bio textarea { width: 100%; min-height: 76px; box-sizing: border-box; resize: vertical;
  padding: 7px 8px; color: #d7e3f0; background: #0e1822; border: 1px solid #2c3e50;
  border-radius: 4px; font: 12px/1.4 system-ui, sans-serif; }
.sp-settings .profile-bio textarea:focus { outline: 0; border-color: #3a6ea5; }
.sp-settings .profile-bio textarea:disabled { color: #8aa0b4; }
.sp-settings .profile-picture-row { display: flex; align-items: center; gap: 12px; margin: 9px 0 7px; }
.sp-settings .profile-picture-preview { position: relative; display: grid; place-items: center; flex: 0 0 auto;
  width: 64px; height: 64px; overflow: hidden; box-sizing: border-box; border: 1px solid #35516a;
  border-radius: 50%; color: #dcecf9; background: linear-gradient(145deg, #294b67, #172d40);
  font: 700 18px/1 system-ui, sans-serif; letter-spacing: .04em; }
.sp-settings .profile-picture-preview img { position: absolute; inset: 0; width: 100%; height: 100%;
  border-radius: inherit; object-fit: cover; background: #172d40; }
.sp-settings .profile-picture-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sp-settings .profile-picture-actions input { display: none; }
.sp-settings .profile-picture .state.warn { color: #efa29c; }
.sp-settings .account-device input { font-family: system-ui, sans-serif; }
.sp-settings .account-password-grid { display: grid; gap: 7px; margin: 8px 0; }
.sp-settings .account-password-grid label { display: grid; gap: 3px; color: #a9bdd0; font-size: 11px; }
.sp-settings .account-password-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.sp-settings .account-password-actions .danger { margin-left: auto; color: #efaaa5;
  border-color: #70423f !important; }
.sp-settings .account-password-actions .danger:hover { color: #ffd2ce; background: #3b211f !important;
  border-color: #9a5651 !important; }
.sp-settings .account-security .state { margin-top: 7px; }
.sp-settings .account-security .state.warn { color: #efa29c; }
.sp-settings .equipment-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 3px; margin: 9px 0 7px;
  padding: 3px; border: 1px solid #2c3e50; border-radius: 6px; background: #09121a; }
.sp-settings .equipment-switch button { padding: 6px; border: 0; border-radius: 4px; color: #89a2b8;
  background: transparent; font: 600 11.5px/1.2 system-ui, sans-serif; cursor: pointer; }
.sp-settings .equipment-switch button[aria-pressed=true] { color: #eff8ff; background: #1b3b54; }
.sp-settings .equipment-library { display: grid; grid-template-columns: auto minmax(0,1fr) auto auto auto;
  align-items: center; gap: 6px; margin: 7px 0; color: #a9bdd0; font-size: 11px; }
.sp-settings .equipment-library select, .sp-settings .equipment-name input { min-width: 0; box-sizing: border-box;
  border: 1px solid #35516a; border-radius: 4px; color: #d7e3f0; background: #0e1822;
  font: 12px system-ui, sans-serif; }
.sp-settings .equipment-library select { width: 100%; padding: 5px 6px; }
.sp-settings .equipment-name { display: grid; grid-template-columns: auto 1fr; align-items: center;
  gap: 8px; margin: 7px 0; color: #a9bdd0; }
.sp-settings .equipment-name input { width: 100%; padding: 5px 7px; }
.sp-settings .equipment-preview { position: relative; width: min(100%, 330px); aspect-ratio: 1; overflow: hidden;
  margin: 0 auto 8px; box-sizing: border-box; border: 1px solid #35516a; border-radius: 5px;
  background-color: #132230; background-image: linear-gradient(45deg,#172b3b 25%,transparent 25%),
    linear-gradient(-45deg,#172b3b 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#172b3b 75%),
    linear-gradient(-45deg,transparent 75%,#172b3b 75%); background-size: 20px 20px;
  background-position: 0 0,0 10px,10px -10px,-10px 0; touch-action: none; user-select: none; }
.sp-settings .equipment-preview.editable { cursor: grab; }
.sp-settings .equipment-preview.dragging { cursor: grabbing; }
.sp-settings .equipment-preview img, .sp-settings .equipment-preview canvas,
.sp-settings .equipment-preview svg { position: absolute; inset: 0;
  width: 100%; height: 100%; }
.sp-settings .equipment-preview img { object-fit: fill; }
.sp-settings .equipment-preview canvas { display: none; }
.sp-settings .equipment-preview svg { pointer-events: none; }
.sp-settings .equipment-region-loads { display: grid; gap: 4px; margin: 5px 0 7px; }
.sp-settings .equipment-region-loads button { min-width: 0; padding: 3px 2px; border: 0; color: #78b9e5;
  background: transparent; font: 600 10px/1.2 system-ui, sans-serif; text-decoration: underline; cursor: pointer; }
.sp-settings .equipment-region-loads button:hover { color: #b9e3ff; }
.sp-settings .equipment-region-loads button[aria-pressed=true] { color: #ffc16f; }
.sp-settings .equipment-region-loads button.loaded::after { content: ' ✓'; color: #8ed1a8; text-decoration: none; }
.sp-settings .equipment-file { display: none; }
.sp-settings .equipment-zoom { display: flex; align-items: center; gap: 7px; margin: 7px 0; color: #a9bdd0;
  font-size: 11px; }
.sp-settings .equipment-zoom input[type=range] { flex: 1 1 auto; min-width: 0; accent-color: #4b85b5; }
.sp-settings .equipment-zoom output { width: 38px; text-align: right; color: #cfe3f5;
  font: 11px/1.2 ui-monospace, Consolas, monospace; }
.sp-settings .equipment-zoom .sp-btn { padding: 3px 7px; font-size: 11px; }
.sp-settings .edge-color { display: flex; align-items: center; gap: 8px; margin: 8px 0 6px; color: #a9bdd0; }
.sp-settings .edge-color input[type=color] { width: 42px; height: 28px; padding: 2px; border: 1px solid #35516a;
  border-radius: 4px; background: #0e1822; cursor: pointer; }
.sp-settings .equipment .state.warn { color: #efa29c; }
/* Access keys: a list of what exists, and the one-time reveal of a key just minted. */
.sp-settings .keys { margin: 8px 0 0; display: flex; flex-direction: column; gap: 4px; }
.sp-settings .keyitem { display: flex; align-items: baseline; gap: 6px; padding: 5px 7px;
  background: #0e1822; border: 1px solid #23364a; border-radius: 4px; }
.sp-settings .keyitem .nm { color: #cfe3f5; flex: 1 1 auto; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.sp-settings .keyitem .when { color: #7f97ac; font-size: 11px; flex: 0 0 auto; }
.sp-settings .keyitem .sp-btn { flex: 0 0 auto; padding: 2px 7px; font-size: 11px; }
.sp-settings .minted { margin: 8px 0 0; padding: 8px; border-radius: 4px;
  background: #12261c; border: 1px solid #2f6b46; }
.sp-settings .minted .warn { color: #6ee7a8; font-size: 11px; margin-bottom: 5px; }
.sp-settings .version-grid { display: grid; grid-template-columns: 48px minmax(0, 1fr); gap: 5px 8px;
  margin: 8px 0; align-items: baseline; }
.sp-settings .version-grid .label { color: #7f97ac; font-size: 11px; }
.sp-settings .version-grid code { min-width: 0; overflow: hidden; color: #cfe3f5;
  font: 12px/1.3 ui-monospace, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
.sp-settings .version-actions { display: flex; align-items: center; gap: 8px; }
.sp-settings .version-actions .state { flex: 1 1 auto; }
.sp-settings .version-actions .state.warn { color: #e4b96d; }
.sp-settings .version-actions .sp-btn { flex: 0 0 auto; }
.sp-settings .update-box { margin-top: 10px; padding-top: 9px; border-top: 1px solid #23364a; }
.sp-settings .update-box .rowhead { margin-bottom: 6px; }
.sp-settings .update-row { display: flex; gap: 6px; margin-top: 6px; }
.sp-settings .update-row input { flex: 1 1 auto; }
.sp-settings .update-row .sp-btn { flex: 0 0 auto; }
.sp-settings .update-box > .state { margin-top: 7px; }
.sp-settings .update-box > .state.warn { color: #e4b96d; }
/* A labelled checkbox row (the video bridge's enable switch). */
.sp-settings .tickrow { display: flex; align-items: flex-start; gap: 7px; margin: 8px 0 6px; }
.sp-settings .tickrow input[type=checkbox] { flex: 0 0 auto; margin: 2px 0 0; accent-color: #3a6ea5;
  width: 14px; height: 14px; }
.sp-settings .tickrow label { color: #cfe3f5; cursor: pointer; }
.sp-settings .tickrow input:disabled + label { color: #7f97ac; cursor: default; }
.sp-settings .bridge-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 8px; }
.sp-settings .bridge-grid .wide { grid-column: 1 / -1; }
.sp-settings .bridge-actions { display: flex; align-items: center; gap: 6px; margin: 8px 0 6px; }
.sp-settings .bridge-actions .state { flex: 1 1 auto; }
.sp-settings .voice-actions { display: flex; align-items: center; gap: 8px; margin: 8px 0 6px; }
.sp-settings .voice-actions .state { flex: 1 1 auto; }
.sp-settings .voice-actions .state.warn { color: #e4b96d; }
.sp-settings .voice-actions .state.err { color: #efa29c; }
.sp-settings .setup-guide { margin-top: 8px; padding: 7px 8px; border: 1px solid #23364a;
  border-radius: 4px; background: #0e1822; color: #9fb3c8; }
.sp-settings .setup-guide summary { cursor: pointer; color: #cfe3f5; font-weight: 600; }
.sp-settings .setup-guide ol { margin: 7px 0 2px; padding-left: 20px; }
.sp-settings .setup-guide li { margin: 5px 0; }
.sp-settings .setup-guide code { color: #d7e3f0; user-select: all; }
.sp-settings .setup-guide a { color: #7db7e8; }
${legalPanelCss}`;
