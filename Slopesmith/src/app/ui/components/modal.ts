/** Standard modal shell: a click-catching backdrop hosting the dialog body, closed on backdrop click.
 *  Shared by the file-menu dialogs (dialogs.ts), Settings, and Generate texture. `sticky` makes the
 *  backdrop inert — for dialogs holding unsaved work (a paid generation, a typed prompt), where a stray
 *  click outside must not discard it; a sticky dialog owns its explicit ways out (button / Esc) itself. */
export function modal(opts: { sticky?: boolean } = {}): { host: HTMLDivElement; close: () => void } {
  const back = document.createElement('div');
  back.className = 'sp-modal-back';
  const host = document.createElement('div');
  host.className = 'sp-modal';
  back.appendChild(host);
  document.body.appendChild(back);
  const close = () => back.remove();
  back.onclick = e => { if (!opts.sticky && e.target === back) close(); };
  return { host, close };
}
