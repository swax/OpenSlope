import './offline.css';
import { unsavedWork } from './state/unsaved-work';

type OfflineState = 'preparing' | 'ready' | 'update' | 'error' | 'offline' | 'development' | 'unsupported';

const messages: Record<OfflineState, string> = {
  preparing: 'Preparing offline access…',
  ready: 'Ready for offline use',
  update: 'Update ready · reload to apply',
  error: 'Offline setup failed · reconnect and reopen to retry',
  offline: 'Reconnect once to prepare offline access',
  development: 'Offline access is disabled in development',
  unsupported: 'Offline access is unavailable in this browser',
};
let state: OfflineState = 'preparing';
const preparations = new Set<() => void | Promise<void>>();
let notice: HTMLElement | undefined;
let dismissed = false;

/** Save durable work or explain why this page cannot reload yet. Other tabs keep running. */
export function beforeAppUpdate(prepare: () => void | Promise<void>): () => void {
  preparations.add(prepare);
  return () => {
    preparations.delete(prepare);
  };
}

function showUpdate(): void {
  if (notice || dismissed) return;
  notice = document.createElement('section');
  notice.className = 'app-update';
  notice.setAttribute('role', 'region');
  notice.setAttribute('aria-label', 'App update');
  const message = document.createElement('p');
  message.textContent = 'A new version of Slopesmith is ready.';
  const error = document.createElement('p');
  error.className = 'app-update-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload to update';
  const later = document.createElement('button');
  later.type = 'button';
  later.textContent = 'Later';
  later.onclick = () => {
    dismissed = true;
    notice?.remove();
    notice = undefined;
  };
  reload.onclick = async () => {
    reload.disabled = later.disabled = true;
    error.hidden = true;
    try {
      // A modal may hold settings, an imported file or a draft outside document autosave.
      if (document.querySelector('[aria-modal="true"], .sp-ask, .sp-modal'))
        throw new Error('Finish or close the open dialog before reloading.');
      for (const prepare of preparations) await prepare();
      const held = unsavedWork();
      if (held.length) throw new Error(`Finish or cancel ${held.join(', ')} before reloading.`);
      location.reload();
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : String(cause);
      error.hidden = false;
    } finally {
      reload.disabled = later.disabled = false;
    }
  };
  notice.append(message, error, reload, later);
  document.body.append(notice);
}

function renderStatus(status: HTMLElement): void {
  status.textContent = messages[state];
  status.dataset.state = state;
}
function setStatus(next: OfflineState): void {
  state = next;
  document.querySelectorAll<HTMLElement>('[data-offline-status]').forEach(renderStatus);
  if (next === 'update') showUpdate();
}

/** Render inside an information panel; preparing the app never adds an overlay. */
export function offlineStatus(): HTMLParagraphElement {
  const status = document.createElement('p');
  status.className = 'offline-status';
  status.setAttribute('data-offline-status', '');
  status.setAttribute('role', 'status');
  renderStatus(status);
  return status;
}

/** Production app caching is independent of authentication and never stores API responses. */
export async function prepareOffline(): Promise<void> {
  if (!import.meta.env.PROD) {
    setStatus('development');
    return;
  }
  if (!('serviceWorker' in navigator)) {
    setStatus('unsupported');
    return;
  }
  let ready = false;
  let update = false;
  let failed = false;
  const pageRelease = document.querySelector<HTMLMetaElement>('meta[name="slopesmith-app-cache"]')?.content;
  let registration: ServiceWorkerRegistration | undefined;
  let lastCheck = Date.now();
  const render = () =>
    setStatus(update ? 'update' : failed ? 'error' : ready ? 'ready' : navigator.onLine ? 'preparing' : 'offline');
  const identify = () => {
    if (pageRelease)
      navigator.serviceWorker.controller?.postMessage({ type: 'slopesmith-client-release', cacheName: pageRelease });
  };
  const check = () => {
    if (!registration || !navigator.onLine || document.visibilityState !== 'visible' || Date.now() - lastCheck < 60_000)
      return;
    lastCheck = Date.now();
    void registration.update().catch(() => {
      /* A temporary outage leaves the prepared release usable. */
    });
  };
  window.addEventListener('online', () => {
    render();
    check();
  });
  window.addEventListener('offline', render);
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('pageshow', () => {
    identify();
    check();
  });
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.source !== navigator.serviceWorker.controller || event.data?.type !== 'slopesmith-release-active') return;
    if (pageRelease && event.data.cacheName !== pageRelease) update = true;
    render();
  });
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    ready = true;
    identify();
    render();
  });
  render();
  try {
    registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    ready = !!registration.active;
    const watch = () => {
      const installing = registration?.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed') {
          ready = true;
          failed = false;
        }
        if (installing.state === 'redundant') failed = true;
        render();
      });
    };
    registration.addEventListener('updatefound', watch);
    watch();
    identify();
    const timer = window.setInterval(check, 60_000);
    window.addEventListener('pagehide', () => window.clearInterval(timer), { once: true });
    render();
  } catch (error) {
    failed = true;
    console.warn('Offline setup failed', error);
    render();
  }
}
