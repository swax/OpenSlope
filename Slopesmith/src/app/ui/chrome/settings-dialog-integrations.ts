import { fetchJson, postJson } from '../../net/fetch-json';
import { normalizeVideoBridgeServer, testVideoBridge, VIDEO_BRIDGE_REPOSITORY_URL } from '../../net/video-bridge';
import { loadSettings, type VideoBridgePrefs } from '../../state/settings';
import { infoBadge } from '../components/info';
import { toast } from '../components/toast';

const VIDEO_BRIDGE_HELP = 'An optional viewer-managed Yattee Server turns public video-page URLs into browser-playable '
  + 'relay streams for the course’s WebGL screens. If Yattee is unavailable, the Jukebox automatically uses '
  + 'YouTube’s embedded player in its panel instead. Slopesmith talks to Yattee directly from this browser; '
  + 'its own project server never sees the video request or these credentials.\n\n'
  + 'A browser on the Yattee computer uses http://127.0.0.1:8085. A standalone Quest, phone, or tablet needs '
  + 'a separate HTTPS endpoint, such as an ngrok tunnel to that workstation’s port 8085.\n\n'
  + 'The URL, username, and password are stored in this browser’s localStorage, like the fal.ai key above. '
  + 'Anyone with access to this browser profile can read them. Use a dedicated local Yattee account rather '
  + 'than reusing an important password.';

interface VideoBridgeSection {
  el: HTMLDivElement;
  value: () => VideoBridgePrefs;
  fail: (message: string) => void;
}

/** Browser-local Yattee connection and the complete setup path for a hosted or self-hosted Slopesmith origin. */
export function buildVideoBridgeSection(initial: VideoBridgePrefs): VideoBridgeSection {
  const sec = document.createElement('div');
  sec.className = 'sec';
  const title = document.createElement('h3');
  title.textContent = 'Local video bridge';
  title.appendChild(infoBadge(VIDEO_BRIDGE_HELP));

  const grid = document.createElement('div');
  grid.className = 'bridge-grid';
  const field = (labelText: string, kind: 'text' | 'password' | 'url', value: string, wide = false) => {
    const wrap = document.createElement('div');
    wrap.className = `pathrow${wide ? ' wide' : ''}`;
    const head = document.createElement('div');
    head.className = 'rowhead';
    const label = document.createElement('label');
    label.textContent = labelText;
    const input = document.createElement('input');
    input.type = kind;
    input.value = value;
    input.autocomplete = kind === 'password' ? 'current-password' : kind === 'text' ? 'username' : 'off';
    input.spellcheck = false;
    head.appendChild(label);
    wrap.append(head, input);
    grid.appendChild(wrap);
    return input;
  };
  const serverUrl = field('Yattee server URL', 'url', initial.serverUrl, true);
  serverUrl.placeholder = 'http://127.0.0.1:8085';
  const username = field('Username', 'text', initial.username);
  const password = field('Password', 'password', initial.password);

  const actions = document.createElement('div');
  actions.className = 'bridge-actions';
  const test = document.createElement('button');
  test.type = 'button';
  test.className = 'sp-btn';
  test.textContent = 'Test connection';
  const show = document.createElement('button');
  show.type = 'button';
  show.className = 'sp-btn';
  show.textContent = 'Show password';
  show.onclick = () => {
    const hidden = password.type === 'password';
    password.type = hidden ? 'text' : 'password';
    show.textContent = hidden ? 'Hide password' : 'Show password';
  };
  const state = document.createElement('div');
  state.className = 'state';
  state.textContent = 'Connection settings are saved here; playback is turned on or off in Users → Jukebox.';
  actions.append(test, show);

  const value = (): VideoBridgePrefs => ({
    // Playback is owned by the prominent Jukebox switch. Saving connection fields must not silently undo it.
    enabled: loadSettings().videoBridge.enabled,
    serverUrl: normalizeVideoBridgeServer(serverUrl.value),
    username: username.value,
    password: password.value,
  });
  const fail = (message: string) => {
    state.classList.remove('set');
    state.textContent = message;
  };
  test.onclick = async () => {
    test.disabled = true;
    state.classList.remove('set');
    state.textContent = 'Contacting Yattee…';
    try {
      const result = await testVideoBridge(value());
      serverUrl.value = result.serverUrl;
      state.classList.add('set');
      state.textContent = `Connected to ${result.name}${result.version ? ` ${result.version}` : ''}. Save to keep it.`;
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    } finally {
      test.disabled = false;
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
  const repository = document.createElement('a');
  repository.href = VIDEO_BRIDGE_REPOSITORY_URL;
  repository.target = '_blank';
  repository.rel = 'noopener noreferrer';
  repository.textContent = 'Install a compatible self-hosted media server';
  addStep(repository, ' (the linked project is the one these steps were tested against; it is separate software '
    + 'that Slopesmith neither ships nor runs), then start it by following its own instructions.');
  addStep('Open Yattee at ', Object.assign(document.createElement('code'), { textContent: initial.serverUrl }),
    ' and finish its first-run administrator setup.');
  addStep('For Quest or mobile, expose Yattee port 8085 through its own HTTPS tunnel and use that public '
    + 'origin above; 127.0.0.1 would point to the headset or phone.');
  const origin = document.createElement('code');
  origin.textContent = window.location.origin;
  addStep('In Yattee Admin → Settings → Browser Access, add this exact Slopesmith origin: ', origin, '.');
  addStep('Enter that Yattee URL and account above, then choose Test connection. Approve the browser’s local-network prompt if it appears.');
  addStep('Save these connection settings. Open Users → Jukebox, turn playback on, then add a YouTube URL.');
  guide.append(summary, steps);

  sec.append(title, grid, actions, state, guide);
  return { el: sec, value, fail };
}

const KEYS_HELP = 'A personal key lets a program reach this server as you — an AI agent speaking the API, '
  + 'the Blender add-on (blender/slopesmith_bridge.py), or any script. Send it as an Authorization: Bearer '
  + 'header.\n\n'
  + 'A key AUTHORS as you and inherits your role at the moment of each request — a change to your role '
  + 'binds immediately — but it can never do what only an admin can, because it lives as plain text in '
  + 'whatever config file you paste it into.\n\n'
  + 'The secret is shown once, here, and never again: the server keeps only a digest of it. Lose it and you '
  + 'make another. Revoking one takes effect on the very next request.\n\n'
  + 'A Slopesmith running on your own machine needs no key at all — it already serves you as its owner.';

/** One key as the list shows it. Mirrors `PublicAccessToken`; the secret is never among these fields. */
interface StoredKey { id: string; name: string; createdAt: string; lastUsedAt?: string }

const whenText = (key: StoredKey): string =>
  key.lastUsedAt ? `used ${new Date(key.lastUsedAt).toLocaleDateString()}` : 'never used';

/**
 * Access keys (docs/046) — the one section here that is neither browser-local nor deferred to Save.
 *
 * Named for what it IS rather than for its first caller. The Blender add-on is what these were built for, but
 * a key is an ordinary bearer credential for the whole API, so labelling the section "Blender" would send
 * anyone writing a script somewhere else to look for a mechanism that is already right here.
 *
 * A key is minted and revoked on the SERVER, so those are their own actions taking effect immediately; there
 * is nothing coherent for Cancel to undo about a credential that already exists. That is a deliberate
 * departure from the rest of the dialog and the reason the buttons live on each row rather than at the
 * bottom.
 *
 * The section builds itself from whatever the server answers. A loopback install refuses the route with a
 * reason, and that reason IS the content — "you do not need one of these" is worth saying once, in the place
 * somebody would come looking.
 */
export function buildKeysSection(): HTMLDivElement {
  const sec = document.createElement('div');
  sec.className = 'sec';
  const title = document.createElement('h3');
  title.textContent = 'Access keys';
  title.appendChild(infoBadge(KEYS_HELP));

  const list = document.createElement('div');
  list.className = 'keys';
  const state = document.createElement('div');
  state.className = 'state';

  const row = document.createElement('div');
  row.className = 'keyrow';
  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'What is it for? (e.g. Blender on the studio PC)';
  name.title = 'A label for you — which machine or program holds this key.';
  name.autocomplete = 'off';
  name.spellcheck = false;
  const create = document.createElement('button');
  create.type = 'button';
  create.className = 'sp-btn';
  create.textContent = 'Create';
  row.append(name, create);

  /** The one-time reveal. Replaced, not appended to, so two keys minted in a row cannot both sit on screen
   *  looking equally current. */
  let minted: HTMLDivElement | null = null;
  const reveal = (secret: string) => {
    minted?.remove();
    minted = document.createElement('div');
    minted.className = 'minted';
    const warn = document.createElement('div');
    warn.className = 'warn';
    warn.textContent = 'Copy this now — it is not shown again.';
    const holder = document.createElement('div');
    holder.className = 'keyrow';
    const field = document.createElement('input');
    field.type = 'text';
    field.readOnly = true;
    field.value = secret;
    field.onfocus = () => field.select();
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'sp-btn';
    copy.textContent = 'Copy';
    copy.onclick = () => {
      field.select();
      void navigator.clipboard?.writeText(secret)
        .then(() => { copy.textContent = 'Copied'; })
        // A clipboard the browser refuses is not a failure worth a toast: the field is selected, so Ctrl+C
        // is right there.
        .catch(() => { copy.textContent = 'Press Ctrl+C'; });
    };
    holder.append(field, copy);
    minted.append(warn, holder);
    sec.append(minted);
    field.focus();
  };

  const render = (keys: StoredKey[]) => {
    list.textContent = '';
    for (const key of keys) {
      const item = document.createElement('div');
      item.className = 'keyitem';
      const label = document.createElement('span');
      label.className = 'nm';
      label.textContent = key.name;
      const when = document.createElement('span');
      when.className = 'when';
      when.textContent = whenText(key);
      const revoke = document.createElement('button');
      revoke.type = 'button';
      revoke.className = 'sp-btn';
      revoke.textContent = 'Revoke';
      revoke.onclick = async () => {
        revoke.disabled = true;
        try {
          await postJson('/api/auth/keys/revoke', JSON.stringify({ id: key.id }));
          await load();
          toast(`Revoked ${key.name}. Whatever held it will need a new key.`, 'ok', 5000);
        } catch (error) {
          revoke.disabled = false;
          toast(`Could not revoke that key — ${error instanceof Error ? error.message : error}`, 'err', 6000);
        }
      };
      item.append(label, when, revoke);
      list.append(item);
    }
    state.classList.toggle('set', keys.length > 0);
    state.textContent = keys.length
      ? `${keys.length} key${keys.length === 1 ? '' : 's'} — send one as an Authorization: Bearer header.`
      : 'No keys yet. Make one per machine or program — an agent or Blender’s add-on wants its own.';
  };

  async function load(): Promise<void> {
    const answer = await fetchJson<{ tokens?: StoredKey[] }>('/api/auth/keys');
    render(answer.tokens ?? []);
  }

  create.onclick = async () => {
    create.disabled = true;
    try {
      const answer = await postJson<{ key: string }>('/api/auth/keys',
        JSON.stringify({ name: name.value.trim() || 'Blender' }));
      name.value = '';
      reveal(answer.key);
      await load();
    } catch (error) {
      toast(`Could not make a key — ${error instanceof Error ? error.message : error}`, 'err', 6000);
    } finally {
      create.disabled = false;
    }
  };

  sec.append(title, list, row, state);
  void load().catch(() => {
    // The route refuses a server with no accounts, and that refusal is the whole content of this section
    // there: nothing to list, nothing to make, and a sentence saying why is more use than an empty box.
    row.remove();
    list.remove();
    state.textContent = 'This Slopesmith has no accounts, so nothing needs a key — anything that reaches '
      + 'the server is already you.';
  });
  return sec;
}

const AGENT_API_HELP = 'The whole authoring surface — maps, registers, uploads, effects, avatars — is a '
  + 'self-describing REST API (docs/052). GET on the root answers with who the caller is and links to '
  + 'everything else; each response carries the actions it accepts, so nothing has to be taught up front. '
  + 'The manual an agent should read first is served at /api/guide.\n\n'
  + 'On this server an agent authenticates with an access key from the section above; a Slopesmith on your '
  + 'own machine serves any local program as you, no key needed.';

/**
 * Where to point an agent (docs/052). The root URL is shown absolute — it is the one thing that must leave
 * this browser and land in an agent's configuration — while the explorer opens relative, through whatever
 * origin is serving the editor, because it is for the person sitting here.
 */
export function buildAgentApiSection(): HTMLDivElement {
  const sec = document.createElement('div');
  sec.className = 'sec';
  const title = document.createElement('h3');
  title.textContent = 'Agent API';
  title.appendChild(infoBadge(AGENT_API_HELP));

  const state = document.createElement('div');
  state.className = 'state set';
  state.textContent = 'Direct an agent at this root with an access key — it can discover every API it '
    + 'needs from there, one response at a time.';

  const row = document.createElement('div');
  row.className = 'keyrow';
  const rootUrl = `${window.location.origin}/api`;
  const field = document.createElement('input');
  field.type = 'text';
  field.readOnly = true;
  field.value = rootUrl;
  field.onfocus = () => field.select();
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'sp-btn';
  copy.textContent = 'Copy';
  copy.onclick = () => {
    field.select();
    void navigator.clipboard?.writeText(rootUrl)
      .then(() => { copy.textContent = 'Copied'; })
      .catch(() => { copy.textContent = 'Press Ctrl+C'; });
  };
  const explore = document.createElement('a');
  explore.className = 'sp-btn';
  explore.href = '/api/explorer';
  explore.target = '_blank';
  explore.rel = 'noopener noreferrer';
  explore.textContent = 'Open API explorer';
  explore.title = 'Browse the same surface an agent sees: links, actions, and schemas, live.';
  row.append(field, copy, explore);

  sec.append(title, state, row);
  return sec;
}
