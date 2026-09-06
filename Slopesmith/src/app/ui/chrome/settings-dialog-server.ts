import { fetchJson } from '../../net/fetch-json';
import {
  loadServerWorkspaceConfig,
  type PathField,
  type ServerWorkspaceConfig,
  type ServerWorkspacePatch,
} from '../../state/server-config';
import { checkAppVersion, loadAppVersion, type AppVersionInfo } from '../../state/version';
import { loadUpdateStatus, requestUpdate, type UpdateStatus } from '../../state/update';
import { loadServerRestartStatus, requestServerRestart } from '../../state/restart';
import { infoBadge } from '../components/info';

const STORAGE_HELP = 'Where this server keeps its files, for everybody connected to it — so these are the '
  + 'administrator’s to set. The Slopesmith service owns these paths; no absolute path ever enters a mountain '
  + 'document.';

const WORKSPACE_HELP = 'Projects, autosaves, caches and logs. Created if it does not exist yet. Changing it '
  + 'needs a Slopesmith restart.';

const MAPS_HELP = 'The map library the server reads extracted reference maps from. Must already exist. '
  + 'Changing it needs a Slopesmith restart.\n\n'
  + 'Export is separate: the browser writes the map folder itself, into a folder you pick from the Export '
  + 'dialog. Point that at this same library and your own courses land beside the retail ones.';

const CAPACITY_HELP = 'How many accounts may be connected at once. An account counts once even when it has '
  + 'several tabs or devices open. The default is 16; enter any whole number from 1 upward.\n\n'
  + 'When full, an editor can replace a viewer account; a moderator can replace a viewer or editor; and an '
  + 'administrator can replace any lower role. Replacement disconnects every tab/device belonging to the '
  + 'weakest eligible account that connected first. Administrators are never refused and may take the server '
  + 'temporarily above this limit; other roles need a free seat or a lower-role account to replace.';

const VOICE_SERVER_HELP = 'Optional server-wide voice chat is carried by a separate LiveKit process. '
  + 'Slopesmith authenticates each member and issues a short-lived token; the LiveKit API key and secret stay '
  + 'in the server environment and are never sent to this settings page.\n\n'
  + 'The self-test joins with a temporary participant and checks signaling, WebRTC, and TURN reachability. It '
  + 'does not turn on, listen to, or ask permission for your microphone.';

const VERSION_HELP = 'The commit loaded when this Slopesmith server started. “Check for updates” fetches the '
  + 'configured update repository’s main branch and compares its commit history with the running commit. It '
  + 'only refreshes Git metadata: it does not pull, merge, switch branches, rebuild, restart, or change any '
  + 'working files. A production host chooses the repository in /etc/slopesmith-update.env; a developer '
  + 'checkout otherwise uses its Git origin.';

const UPDATE_HELP = 'Administrators can install the configured update repository’s latest main revision or a '
  + 'specific full commit from its history. The server builds and tests an immutable release before switching '
  + 'to it, then restarts Slopesmith. A failed activation switches back automatically. Everyone connected will '
  + 'be briefly disconnected, so use a maintenance window.';

const RESTART_HELP = 'Stops and starts the shared Slopesmith service without changing its installed version. '
  + 'Startup re-reads the server storage settings, rescans the maps folder, and reconstructs server caches and '
  + 'file watchers. Everyone connected will be briefly disconnected, so use a maintenance window.';

const shortHash = (hash: string): string => hash.slice(0, 10);

const revisionTitle = (revision: AppVersionInfo['current']): string => revision
  ? [revision.hash, revision.subject, revision.committedAt
    ? new Date(revision.committedAt).toLocaleString() : undefined].filter(Boolean).join('\n')
  : '';

const sleep = (milliseconds: number): Promise<void> =>
  new Promise(resolveSleep => setTimeout(resolveSleep, milliseconds));

/** Admin-only controls. The containing Server tab is built only after the account role resolves; the route
 * repeats the role check, because hiding UI is presentation rather than security. */
function buildUpdateControls(
  version: () => AppVersionInfo | null,
  showRepository: (repository?: string) => void,
): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'update-box';
  const head = document.createElement('div');
  head.className = 'rowhead';
  const label = document.createElement('label');
  label.textContent = 'Install a release';
  head.append(label, infoBadge(UPDATE_HELP));

  const latest = document.createElement('button');
  latest.type = 'button';
  latest.className = 'sp-btn';
  latest.textContent = 'Update to latest';
  latest.disabled = true;

  const row = document.createElement('div');
  row.className = 'update-row';
  const commit = document.createElement('input');
  commit.type = 'text';
  commit.placeholder = '40-character commit';
  commit.autocomplete = 'off';
  commit.spellcheck = false;
  commit.disabled = true;
  const install = document.createElement('button');
  install.type = 'button';
  install.className = 'sp-btn';
  install.textContent = 'Install commit';
  install.disabled = true;
  row.append(commit, install);

  const state = document.createElement('div');
  state.className = 'state';
  state.textContent = 'Checking whether automatic updates are installed…';
  box.append(head, latest, row, state);

  let available = false;
  let monitoring = false;
  const sourceBranch = () => version()?.latestBranch ?? 'configured repository/main';
  const enable = (enabled: boolean) => {
    latest.disabled = !enabled;
    commit.disabled = !enabled;
    install.disabled = !enabled;
  };

  const showStatus = (status: UpdateStatus) => {
    state.classList.toggle('warn', !status.available || status.state === 'failed');
    if (!status.available) state.textContent = status.reason ?? 'Automatic updates are unavailable.';
    else if (status.state === 'queued') state.textContent = `Queued ${shortHash(status.revision ?? '')}…`;
    else if (status.state === 'installing') {
      state.textContent = `Building and testing ${shortHash(status.revision ?? '')}… this can take several minutes.`;
    } else if (status.state === 'failed') {
      state.textContent = `Could not install ${shortHash(status.revision ?? '')}`
        + (status.exitCode === undefined ? '.' : ` (deploy exited ${status.exitCode}).`);
    } else if (status.state === 'succeeded') {
      state.textContent = `Installed ${shortHash(status.revision ?? '')}.`;
    } else state.textContent = 'Ready to install a tested immutable release.';
  };

  /** Follow the root-owned runner across the service restart. A downgrade to an older build legitimately
   * removes `/api/update`; once that server answers again, reload into the version it installed. */
  const monitor = async (revision: string) => {
    if (monitoring) return;
    monitoring = true;
    enable(false);
    for (let attempt = 0; attempt < 1_350; attempt++) { // 45 minutes, matching the systemd unit timeout
      await sleep(2_000);
      try {
        const update = await loadUpdateStatus();
        showStatus(update);
        if (update.revision === revision && update.state === 'succeeded') {
          state.textContent = `Installed ${shortHash(revision)} — reloading Slopesmith…`;
          setTimeout(() => location.reload(), 600);
          return;
        }
        if (update.revision === revision && update.state === 'failed') {
          monitoring = false;
          enable(available);
          return;
        }
      } catch (error) {
        state.textContent = 'Slopesmith is restarting…';
        // A successfully installed older release may not have the status route yet. Its authenticated session
        // endpoint proves the service is back; a reload then hands control to that release's own browser app.
        if (/404/.test(String(error))) {
          const session = await fetch('/api/auth/session', { cache: 'no-store' }).catch(() => null);
          if (session && (session.ok || session.status === 401)) {
            location.reload();
            return;
          }
        }
      }
    }
    monitoring = false;
    state.textContent = 'The update is still not finished. Check the server deployment log.';
    state.classList.add('warn');
    enable(available);
  };

  const queue = async (target: 'latest' | string) => {
    const named = target === 'latest' ? `the latest ${sourceBranch()} release` : target;
    if (!confirm(`Install ${named}?\n\nSlopesmith will build and test it, then restart the shared server. Everyone connected will be briefly disconnected.`)) return;
    enable(false);
    state.classList.remove('warn');
    state.textContent = `Queuing ${target === 'latest' ? sourceBranch() : shortHash(target)}…`;
    try {
      const queued = await requestUpdate(target);
      state.textContent = `Queued ${shortHash(queued.revision)}. The current server stays available while it builds.`;
      void monitor(queued.revision);
    } catch (error) {
      state.textContent = `Could not queue the update: ${error instanceof Error ? error.message : error}`;
      state.classList.add('warn');
      enable(available);
    }
  };

  latest.onclick = () => { void queue('latest'); };
  install.onclick = () => {
    const revision = commit.value.trim();
    if (!/^[0-9a-f]{40}$/.test(revision)) {
      state.textContent = 'Enter the full 40-character lowercase commit.';
      state.classList.add('warn');
      return;
    }
    const running = version()?.current?.hash;
    if (running === revision) {
      state.textContent = 'That commit is already running.';
      return;
    }
    void queue(revision);
  };
  commit.onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); install.click(); }
  };

  void loadUpdateStatus().then(update => {
    showRepository(update.repository);
    available = update.available;
    showStatus(update);
    enable(available && update.state !== 'queued' && update.state !== 'installing');
    if (update.revision && (update.state === 'queued' || update.state === 'installing')) {
      void monitor(update.revision);
    }
  }).catch(error => {
    showRepository();
    state.textContent = `Update status unavailable: ${error instanceof Error ? error.message : error}`;
    state.classList.add('warn');
  });
  return box;
}
/** A complete service restart, separate from release installation so it remains useful when already current. */
function buildRestartControls(): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'update-box';
  const head = document.createElement('div');
  head.className = 'rowhead';
  const label = document.createElement('label');
  label.textContent = 'Server lifecycle';
  head.append(label, infoBadge(RESTART_HELP));

  const restart = document.createElement('button');
  restart.type = 'button';
  restart.className = 'sp-btn';
  restart.textContent = 'Restart server';
  restart.disabled = true;
  const state = document.createElement('div');
  state.className = 'state';
  state.textContent = 'Checking whether this server can restart itself…';
  box.append(head, restart, state);

  const monitor = async (previousInstance: string) => {
    for (let attempt = 0; attempt < 150; attempt++) { // five minutes, far wider than a normal service restart
      await sleep(2_000);
      try {
        const status = await loadServerRestartStatus();
        if (status.instance && status.instance !== previousInstance) {
          state.textContent = 'Slopesmith is back — reloading…';
          setTimeout(() => location.reload(), 400);
          return;
        }
        state.textContent = 'Waiting for the restarted service…';
      } catch {
        state.textContent = 'Slopesmith is restarting…';
      }
    }
    state.textContent = 'Slopesmith has not returned. Check the server service log.';
    state.classList.add('warn');
  };

  restart.onclick = async () => {
    if (!confirm('Restart the shared Slopesmith server?\n\nEveryone connected will be briefly disconnected.')) return;
    restart.disabled = true;
    state.classList.remove('warn');
    state.textContent = 'Requesting a graceful server restart…';
    try {
      const accepted = await requestServerRestart();
      state.textContent = 'Restart requested…';
      void monitor(accepted.instance);
    } catch (error) {
      state.textContent = `Could not restart Slopesmith: ${error instanceof Error ? error.message : error}`;
      state.classList.add('warn');
      restart.disabled = false;
    }
  };

  void loadServerRestartStatus().then(status => {
    if (status.available && status.instance) {
      state.textContent = 'Ready to restart the shared service.';
      restart.disabled = false;
    } else {
      state.textContent = status.reason ?? 'This server cannot restart itself.';
      state.classList.add('warn');
    }
  }).catch(error => {
    state.textContent = `Restart status unavailable: ${error instanceof Error ? error.message : error}`;
    state.classList.add('warn');
  });
  return box;
}

/** The running checkout and an explicit, non-updating comparison against the configured main branch. */
export function buildVersionSection(): HTMLDivElement {
  const sec = document.createElement('div');
  sec.className = 'sec';
  const title = document.createElement('h3');
  title.textContent = 'Slopesmith version';
  title.appendChild(infoBadge(VERSION_HELP));

  const grid = document.createElement('div');
  grid.className = 'version-grid';
  const currentLabel = document.createElement('span'); currentLabel.className = 'label'; currentLabel.textContent = 'Running';
  const current = document.createElement('code'); current.textContent = 'Reading…';
  const repositoryLabel = document.createElement('span'); repositoryLabel.className = 'label'; repositoryLabel.textContent = 'Repo';
  const repository = document.createElement('code'); repository.textContent = 'Reading…';
  const latestLabel = document.createElement('span'); latestLabel.className = 'label'; latestLabel.textContent = 'Latest';
  const latest = document.createElement('code'); latest.textContent = 'Not checked';
  grid.append(currentLabel, current, repositoryLabel, repository, latestLabel, latest);

  const actions = document.createElement('div');
  actions.className = 'version-actions';
  const state = document.createElement('div');
  state.className = 'state';
  state.textContent = 'Reading the running commit…';
  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'sp-btn';
  check.textContent = 'Check for updates';
  check.disabled = true;
  actions.append(state, check);

  let shown: AppVersionInfo | null = null;
  const showRepository = (value?: string) => {
    repository.textContent = value ?? 'Unavailable';
    repository.title = value ?? 'The installed updater has not published its configured repository yet.';
  };

  const render = (info: AppVersionInfo) => {
    shown = info;
    state.classList.remove('set', 'warn');
    if (!info.available || !info.current) {
      current.textContent = 'Unavailable';
      current.title = info.reason ?? '';
      latest.textContent = 'Unavailable';
      state.textContent = info.reason ?? 'This server has no Git version information.';
      state.classList.add('warn');
      check.disabled = true;
      return;
    }

    current.textContent = `${shortHash(info.current.hash)} · ${info.branch ?? 'detached HEAD'}`;
    current.title = revisionTitle(info.current);
    check.disabled = false;
    check.textContent = info.checkedAt ? 'Check again' : 'Check for updates';
    const sourceBranch = info.latestBranch ?? 'configured repository/main';
    if (info.latest) {
      latest.textContent = `${shortHash(info.latest.hash)} · ${sourceBranch}`;
      latest.title = revisionTitle(info.latest);
    } else latest.textContent = 'Not checked';

    const dirty = info.dirty ? ' This Slopesmith folder also has uncommitted changes.' : '';
    if (info.checkError) {
      state.textContent = `${info.checkError}${dirty}`;
      state.classList.add('warn');
    } else if (!info.latest || !info.relation) {
      state.textContent = `Check ${sourceBranch} when you want to compare.${dirty}`;
      if (info.dirty) state.classList.add('warn');
    } else if (info.relation === 'current') {
      state.textContent = `Up to date with ${sourceBranch}.${dirty}`;
      state.classList.add(info.dirty ? 'warn' : 'set');
    } else if (info.relation === 'behind') {
      state.textContent = `${info.behind} commit${info.behind === 1 ? '' : 's'} behind ${sourceBranch}.${dirty}`;
      state.classList.add('warn');
    } else if (info.relation === 'ahead') {
      state.textContent = `${info.ahead} local commit${info.ahead === 1 ? '' : 's'} ahead of ${sourceBranch}.${dirty}`;
      state.classList.add('warn');
    } else if (info.relation === 'diverged') {
      state.textContent = `Local history and ${sourceBranch} have diverged `
        + `(${info.ahead} ahead, ${info.behind} behind).${dirty}`;
      state.classList.add('warn');
    } else {
      state.textContent = `The commits differ, but this checkout does not contain enough history to compare them.${dirty}`;
      state.classList.add('warn');
    }
  };

  check.onclick = async () => {
    check.disabled = true;
    check.textContent = 'Checking…';
    state.classList.remove('set', 'warn');
    state.textContent = `Fetching ${shown?.latestBranch ?? 'configured repository/main'} metadata…`;
    try {
      render(await checkAppVersion());
      // A production version check also makes the root runner refresh its published source record.
      void loadUpdateStatus().then(update => showRepository(update.repository)).catch(() => {});
    }
    catch (error) {
      state.textContent = `Could not check for updates: ${error instanceof Error ? error.message : error}`;
      state.classList.add('warn');
      check.disabled = false;
      check.textContent = 'Try again';
    }
  };

  sec.append(title, grid, actions);
  sec.append(buildUpdateControls(() => shown, showRepository), buildRestartControls());
  void loadAppVersion().then(render).catch(error => {
    current.textContent = 'Unavailable';
    state.textContent = `Version information unavailable: ${error instanceof Error ? error.message : error}`;
    state.classList.add('warn');
  });
  return sec;
}

/** How the administrator's server configuration presents itself to the dialog around it. */
export interface ServerConfigSection {
  el: HTMLElement;
  /** The fields this server's config actually owns, ready to PUT — empty when the environment owns them all. */
  patch: () => ServerWorkspacePatch;
  /** Adopt the server's saved values so another in-place Save sends only subsequent changes. */
  accept: (config: ServerWorkspaceConfig) => void;
  /** Explain a refused save beside the fields that failed to write. */
  fail: (message: string) => void;
}

/** Player capacity plus the workspace and map-library folders. Built only for whoever administers the server — see
 *  `openSettingsDialog`; `/api/config` refuses everybody else regardless. */
export function buildServerConfigSection(): ServerConfigSection {
  const sectionHost = document.createElement('div');

  const capacitySec = document.createElement('div');
  capacitySec.className = 'sec';
  const capacityTitle = document.createElement('h3');
  capacityTitle.textContent = 'Player capacity';
  capacityTitle.appendChild(infoBadge(CAPACITY_HELP));
  const capacityWrap = document.createElement('div');
  capacityWrap.className = 'pathrow';
  const capacityHead = document.createElement('div');
  capacityHead.className = 'rowhead';
  const capacityLabel = document.createElement('label');
  capacityLabel.textContent = 'Max players';
  capacityLabel.htmlFor = 'sp-max-players';
  const maxPlayers = document.createElement('input');
  maxPlayers.id = 'sp-max-players';
  maxPlayers.type = 'number';
  maxPlayers.min = '1';
  maxPlayers.step = '1';
  maxPlayers.placeholder = '16';
  maxPlayers.disabled = true;
  capacityHead.appendChild(capacityLabel);
  capacityWrap.append(capacityHead, maxPlayers);
  const capacityState = document.createElement('div');
  capacityState.className = 'state';
  capacityState.textContent = 'Reading player capacity from the Slopesmith server…';
  capacitySec.append(capacityTitle, capacityWrap, capacityState);

  const pathsSec = document.createElement('div');
  pathsSec.className = 'sec';
  const pathsTitle = document.createElement('h3');
  pathsTitle.textContent = 'Local storage';
  pathsTitle.appendChild(infoBadge(STORAGE_HELP));
  pathsSec.appendChild(pathsTitle);
  const pathInput = (label: string, help: string): HTMLInputElement => {
    const wrap = document.createElement('div'); wrap.className = 'pathrow';
    const head = document.createElement('div'); head.className = 'rowhead';
    const caption = document.createElement('label'); caption.textContent = label;
    head.append(caption, infoBadge(help));
    const field = document.createElement('input');
    field.type = 'text'; field.placeholder = 'Loading local server configuration…';
    field.autocomplete = 'off'; field.spellcheck = false; field.disabled = true;
    wrap.append(head, field); pathsSec.appendChild(wrap);
    return field;
  };
  const workspaceRoot = pathInput('Workspace folder', WORKSPACE_HELP);
  const mapsRoot = pathInput('Maps folder', MAPS_HELP);
  /** Every editable path, paired with the config field it saves to. */
  const rows: [PathField, HTMLInputElement][] = [['workspaceRoot', workspaceRoot], ['mapsRoot', mapsRoot]];
  const pathState = document.createElement('div');
  pathState.className = 'state';
  pathState.style.marginTop = '8px';
  pathState.textContent = 'Reading paths from the local Slopesmith server…';
  pathsSec.appendChild(pathState);
  sectionHost.append(capacitySec, pathsSec);

  let loaded: ServerWorkspaceConfig | null = null;
  const showConfig = (config: ServerWorkspaceConfig) => {
    loaded = config;
    workspaceRoot.value = config.workspaceRoot;
    mapsRoot.value = config.mapsRoot;
    maxPlayers.value = String(config.maxPlayers);
    maxPlayers.disabled = config.overrides.maxPlayers;
    capacityState.classList.add('set');
    capacityState.textContent = config.overrides.maxPlayers
      ? `Overridden by SLOPESMITH_MAX_PLAYERS (${config.maxPlayers}).`
      : `${config.maxPlayers} concurrent account${config.maxPlayers === 1 ? '' : 's'}; changes apply immediately.`;
    for (const [key, el] of rows) el.disabled = config.overrides[key];
    const pathOverrideVars = rows.filter(([key]) => config.overrides[key]).map(([key]) =>
      key === 'workspaceRoot' ? 'SLOPESMITH_WORKSPACE_ROOT' : 'SLOPESMITH_MAPS_ROOT');
    pathState.classList.add('set');
    pathState.textContent = rows.every(([key]) => config.overrides[key])
      ? `Every path is overridden by ${pathOverrideVars.join(', ')}.`
      : (config.configured ? `Machine-local config: ${config.configFile}`
                           : `Using defaults — changing and saving a value will create ${config.configFile}`)
        + (pathOverrideVars.length ? ` — ${pathOverrideVars.join(', ')} owns the rest.` : '');
  };
  void loadServerWorkspaceConfig().then(({ config }) => showConfig(config)).catch(error => {
    capacityState.textContent = `Player capacity unavailable: ${error instanceof Error ? error.message : error}`;
    pathState.textContent = `Local server configuration unavailable: ${error instanceof Error ? error.message : error}`;
  });

  return {
    el: sectionHost,
    // Only changed fields this machine actually owns are sent; environment overrides stay untouched.
    patch: () => {
      const patch = Object.fromEntries(
        rows.filter(([key, el]) => loaded && !loaded.overrides[key] && el.value.trim() !== loaded[key])
          .map(([key, el]) => [key, el.value.trim()]),
      ) as ServerWorkspacePatch;
      if (loaded && !loaded.overrides.maxPlayers) {
        const capacity = Number(maxPlayers.value);
        if (!Number.isSafeInteger(capacity) || capacity < 1) {
          throw new Error('Max players must be a whole number of at least 1');
        }
        if (capacity !== loaded.maxPlayers) patch.maxPlayers = capacity;
      }
      return patch;
    },
    accept: showConfig,
    fail: message => {
      capacityState.classList.remove('set'); capacityState.textContent = message;
      pathState.classList.remove('set'); pathState.textContent = message;
    },
  };
}

interface VoiceTestCredentials {
  serverUrl: string;
  participantToken: string;
  roomName: string;
}

interface VoiceCheckResult {
  status: number;
  logs: { level: 'info' | 'warning' | 'error'; message: string }[];
}

/** Mint a disposable participant instead of reusing this tab's voice identity. A settings check must never
 * replace an already-connected Users voice session for the administrator running it. */
async function requestVoiceTestCredentials(): Promise<VoiceTestCredentials> {
  const testClient = `voice-test-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const response = await fetch('/api/voice', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-slopesmith-client': testClient },
    body: '{}',
  });
  const text = await response.text();
  let decoded: unknown;
  try { decoded = JSON.parse(text); } catch { /* status line below is more useful than malformed response text */ }
  if (!response.ok) {
    const message = (decoded as { error?: unknown } | undefined)?.error;
    throw new Error(typeof message === 'string' ? message : `${response.status} ${response.statusText}`.trim());
  }
  const credentials = decoded as Partial<VoiceTestCredentials> | undefined;
  if (!credentials?.serverUrl || !credentials.participantToken || !credentials.roomName) {
    throw new Error('Slopesmith returned incomplete voice test credentials.');
  }
  return credentials as VoiceTestCredentials;
}

const voiceCheckFailure = (label: string, result: VoiceCheckResult): Error => {
  const detail = [...result.logs].reverse().find(log => log.level === 'error')?.message;
  return new Error(`${label} failed${detail ? `: ${detail}` : '.'}`);
};

/** Admin-only LiveKit setup and an end-to-end network check that deliberately never opens a media device. */
export function buildVoiceServerSection(): HTMLDivElement {
  const sec = document.createElement('div');
  sec.className = 'sec';
  const title = document.createElement('h3');
  title.textContent = 'Voice server (LiveKit)';
  title.appendChild(infoBadge(VOICE_SERVER_HELP));

  const actions = document.createElement('div');
  actions.className = 'voice-actions';
  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'sp-btn';
  test.textContent = 'Run self-test';
  const state = document.createElement('div');
  state.className = 'state';
  state.textContent = 'Checking whether this Slopesmith server has voice configured…';
  actions.append(test, state);

  let testing = false;
  const show = (message: string, kind?: 'set' | 'warn' | 'err') => {
    state.classList.remove('set', 'warn', 'err');
    if (kind) state.classList.add(kind);
    state.textContent = message;
  };
  void fetchJson<{ enabled: boolean }>('/api/voice').then(status => {
    if (testing) return;
    show(status.enabled
      ? 'Voice is configured. Run the self-test to verify its public network paths.'
      : 'Voice is not configured on this server.', status.enabled ? 'set' : 'warn');
  }).catch(error => {
    if (!testing) show(`Voice status unavailable: ${error instanceof Error ? error.message : error}`, 'err');
  });

  test.onclick = async () => {
    testing = true;
    test.disabled = true;
    test.textContent = 'Testing…';
    try {
      show('Requesting a temporary voice participant…');
      const credentials = await requestVoiceTestCredentials();
      const { ConnectionCheck, CheckStatus } = await import('livekit-client');
      const checker = new ConnectionCheck(credentials.serverUrl, credentials.participantToken, {
        roomOptions: { adaptiveStream: false, dynacast: false },
        connectOptions: { autoSubscribe: false, maxRetries: 0, websocketTimeout: 10_000 },
      });

      show('Testing LiveKit signaling…');
      const signaling = await checker.checkWebsocket() as VoiceCheckResult;
      if (signaling.status === CheckStatus.FAILED) throw voiceCheckFailure('Voice signaling', signaling);

      show('Testing WebRTC and firewall reachability…');
      const webRtc = await checker.checkWebRTC() as VoiceCheckResult;
      if (webRtc.status === CheckStatus.FAILED) throw voiceCheckFailure('WebRTC', webRtc);

      show('Testing the TURN relay…');
      const turn = await checker.checkTURN() as VoiceCheckResult;
      if (turn.status === CheckStatus.FAILED) {
        show('Signaling and WebRTC passed, but TURN failed. Check UDP 3478 and the LiveKit firewall rules.', 'warn');
      } else if (turn.status === CheckStatus.SKIPPED) {
        show('Signaling and WebRTC passed. This LiveKit server does not advertise a TURN relay.', 'warn');
      } else {
        show('Voice self-test passed: signaling, WebRTC, and TURN are reachable. No microphone was used.', 'set');
      }
    } catch (error) {
      show(`Voice self-test failed: ${error instanceof Error ? error.message : error}`, 'err');
    } finally {
      testing = false;
      test.disabled = false;
      test.textContent = 'Run self-test';
    }
  };

  const guide = document.createElement('details');
  guide.className = 'setup-guide';
  const summary = document.createElement('summary');
  summary.textContent = 'Setup guide';
  const steps = document.createElement('ol');
  const addStep = (...content: (string | Node)[]) => {
    const item = document.createElement('li');
    item.append(...content);
    steps.appendChild(item);
  };
  const signalUrl = location.protocol === 'https:'
    ? `wss://${location.host}/api/livekit`
    : 'wss://your-slopesmith-host/api/livekit';
  const command = document.createElement('code');
  command.textContent = `sudo bash deploy/install-livekit.sh ${signalUrl} slopesmith-prod`;
  addStep('On the same systemd Linux host, open the Slopesmith release directory and run ', command, '.');
  addStep('Allow inbound TCP 7881, UDP 3478, and UDP 50000–50199 in both the host and provider/cloud '
    + 'firewalls. Keep LiveKit TCP 7880 private.');
  addStep('The installer creates the LiveKit service and private credentials, connects them to the Slopesmith '
    + 'service, and restarts Slopesmith. Return here and choose Run self-test.');
  const urlVariable = document.createElement('code');
  urlVariable.textContent = 'SLOPESMITH_LIVEKIT_URL';
  const keyVariable = document.createElement('code');
  keyVariable.textContent = 'SLOPESMITH_LIVEKIT_API_KEY';
  const secretVariable = document.createElement('code');
  secretVariable.textContent = 'SLOPESMITH_LIVEKIT_API_SECRET';
  const roomVariable = document.createElement('code');
  roomVariable.textContent = 'SLOPESMITH_LIVEKIT_ROOM';
  const upstreamVariable = document.createElement('code');
  upstreamVariable.textContent = 'SLOPESMITH_LIVEKIT_UPSTREAM';
  addStep('For a non-systemd deployment, configure LiveKit separately, give Slopesmith its matching ',
    keyVariable, ' and ', secretVariable, ', set ', urlVariable, ' to the public WSS URL, choose a unique ',
    roomVariable, ' for each Slopesmith deployment, and optionally point ', upstreamVariable,
    ' at its loopback HTTP listener. Then restart Slopesmith.');
  guide.append(summary, steps);

  sec.append(title, actions, guide);
  return sec;
}
