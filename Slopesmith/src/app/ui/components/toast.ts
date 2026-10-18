import { installStyles } from './styles';
let toastTimer = 0;

/** Transient toast (friendly status, e.g. an export result): flash a message in the corner, auto-clearing
 *  after `ms` (pass 0 to keep it up). `kind` tints it ok / warn / err / neutral — `warn` is the
 *  you-clicked-something-that-can't-respond tier, between neutral instructions and hard errors. */
export function toast(msg: string, kind: 'ok' | 'warn' | 'err' | 'info' = 'info', ms = 3200) {
  let toastEl = document.getElementById('toast');
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.id = 'toast';
    toastEl.setAttribute('role', 'status');
    document.body.appendChild(toastEl);
    installStyles(
      'public-toast',
      '#toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);z-index:100;padding:10px 14px;max-width:80vw;border-radius:6px;background:#203b50;color:#e9f4ff;font:13px system-ui;pointer-events:none;opacity:0}#toast.show{opacity:1}#toast.err{background:#652e30}',
    );
  }
  toastEl.textContent = msg;
  toastEl.className = 'show' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '');
  clearTimeout(toastTimer);
  if (ms)
    toastTimer = window.setTimeout(() => {
      toastEl.className = '';
    }, ms);
}
