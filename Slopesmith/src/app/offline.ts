type OfflineState = 'preparing' | 'ready' | 'update' | 'error' | 'offline' | 'development' | 'unsupported';

const messages: Record<OfflineState, string> = {
  preparing: 'Preparing offline access…',
  ready: 'Ready for offline use',
  update: 'Update ready · close all Slopesmith tabs to apply',
  error: 'Offline setup failed · reconnect and reopen to retry',
  offline: 'Reconnect once to prepare offline access',
  development: 'Offline access is disabled in development',
  unsupported: 'Offline access is unavailable in this browser',
};
let state: OfflineState = 'preparing';

function renderStatus(status: HTMLElement): void {
  status.textContent = messages[state];
  status.dataset.state = state;
}
function setStatus(next: OfflineState): void {
  state = next;
  document.querySelectorAll<HTMLElement>('[data-offline-status]').forEach(renderStatus);
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
  if (!import.meta.env.PROD) { setStatus('development'); return; }
  if (!('serviceWorker' in navigator)) { setStatus('unsupported'); return; }
  let ready = false;
  let update = false;
  let failed = false;
  const render = () => setStatus(update ? 'update' : failed ? 'error' : ready ? 'ready'
    : navigator.onLine ? 'preparing' : 'offline');
  window.addEventListener('online', render);
  window.addEventListener('offline', render);
  render();
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
    ready = !!registration.active;
    update = !!registration.waiting;
    const watch = () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed') {
          ready = true;
          update = !!navigator.serviceWorker.controller;
        }
        if (installing.state === 'redundant') failed = true;
        render();
      });
    };
    registration.addEventListener('updatefound', watch);
    watch();
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      ready = true;
      render();
    });
    render();
  } catch (error) {
    failed = true;
    console.warn('Offline setup failed', error);
    render();
  }
}
