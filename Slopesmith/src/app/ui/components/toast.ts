const toastEl = document.getElementById('toast')!;
let toastTimer = 0;

/** Transient toast (friendly status, e.g. an export result): flash a message in the corner, auto-clearing
 *  after `ms` (pass 0 to keep it up). `kind` tints it ok / warn / err / neutral — `warn` is the
 *  you-clicked-something-that-can't-respond tier, between neutral instructions and hard errors. */
export function toast(msg: string, kind: 'ok' | 'warn' | 'err' | 'info' = 'info', ms = 3200) {
  toastEl.textContent = msg;
  toastEl.className = 'show' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : kind === 'warn' ? ' warn' : '');
  clearTimeout(toastTimer);
  if (ms) toastTimer = window.setTimeout(() => { toastEl.className = ''; }, ms);
}
