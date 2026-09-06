import { installStyles } from './styles';
import { modal } from './modal';

/**
 * Two small promise-returning modals: `askName` (a single validated text field) and `confirmAction` (a
 * yes/no with room to say what the yes costs). Both resolve to null / false when dismissed, so a caller
 * reads as a straight line — `const name = await askName(...); if (!name) return;`
 *
 * These exist instead of `window.prompt` / `window.confirm` for two reasons: the native dialogs cannot show
 * validation as you type (so "that name is taken" arrives only after you commit), and they block the whole
 * page, which stalls the viewport's render loop behind a modal the app cannot style or dismiss.
 */

const css = `
.sp-ask { width: 380px; box-sizing: border-box; padding: 12px 14px 10px; color: #d7e3f0;
  background: #0c141d; border: 1px solid #2c3e50; border-radius: 7px;
  font: 12px/1.45 system-ui, sans-serif; box-shadow: 0 12px 40px #0009; }
.sp-ask h3 { margin: 0 0 6px; color: #cfe3f5; font: 600 13px system-ui, sans-serif; }
.sp-ask label { display: block; margin: 8px 0 3px; color: #9fb3c8; font-size: 11px; font-weight: 600; }
.sp-ask input { width: 100%; box-sizing: border-box; background: #0e1822; color: #d7e3f0;
  border: 1px solid #2c3e50; border-radius: 4px; padding: 6px 8px; font: 12px/1.3 system-ui, sans-serif; }
.sp-ask input:focus { outline: 0; border-color: #3a6ea5; }
.sp-ask .hint { margin: 6px 0 0; color: #8aa0b4; font-size: 11px; line-height: 1.5; }
.sp-ask .err { margin: 5px 0 0; color: #f0a89c; font-size: 11px; min-height: 15px; }
.sp-ask .body { margin: 0; color: #cdd6e3; font-size: 12px; line-height: 1.5; }
.sp-ask .sp-btn.danger { background: #6b2020; border-color: #a13b3b; color: #ffe9e6; font-weight: 600; }
.sp-ask .sp-btn.danger:hover { background: #8a2a2a; }
`;

/** Shell shared by both dialogs: panel, Escape-to-cancel, and a settle-once resolve. */
function promptShell<T>(cancelValue: T): {
  host: HTMLDivElement; done: Promise<T>; settle: (value: T) => void;
} {
  installStyles('prompts', css);
  const { host, close } = modal();
  host.classList.add('sp-ask');
  let settle!: (value: T) => void;
  let settled = false;
  const done = new Promise<T>(resolve => {
    settle = (value: T) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      close();
      resolve(value);
    };
  });
  // the shared backdrop click removes the DOM but cannot know our resolve value, so watch for it too
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') settle(cancelValue); };
  document.addEventListener('keydown', onKey, true);
  const backdrop = host.parentElement!;
  backdrop.addEventListener('click', e => { if (e.target === backdrop) settle(cancelValue); });
  return { host, done, settle };
}

export interface AskNameOptions {
  title: string;
  label: string;
  value?: string;
  placeholder?: string;
  hint?: string;
  confirmLabel?: string;
  /** Return an error to block confirming, or null when the value is acceptable. Runs on every keystroke. */
  validate?: (value: string) => string | null;
}

/** Ask for a single name. Resolves to the trimmed value, or null if cancelled. */
export function askName(opts: AskNameOptions): Promise<string | null> {
  const { host, done, settle } = promptShell<string | null>(null);

  const title = document.createElement('h3');
  title.textContent = opts.title;
  const label = document.createElement('label');
  label.textContent = opts.label;
  const input = document.createElement('input');
  input.type = 'text';
  input.spellcheck = false;
  input.value = opts.value ?? '';
  if (opts.placeholder) input.placeholder = opts.placeholder;
  const err = document.createElement('p');
  err.className = 'err';

  host.append(title, label, input, err);
  if (opts.hint) {
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = opts.hint;
    host.appendChild(hint);
  }

  const actions = document.createElement('div');
  actions.className = 'sp-modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sp-btn';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => settle(null);
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = 'sp-btn accent';
  ok.textContent = opts.confirmLabel ?? 'OK';
  actions.append(cancel, ok);
  host.appendChild(actions);

  const check = () => {
    const value = input.value.trim();
    const problem = !value ? '' : opts.validate?.(value) ?? null;
    err.textContent = problem ?? '';
    ok.disabled = !value || !!problem;
    return ok.disabled ? null : value;
  };
  const commit = () => { const value = check(); if (value) settle(value); };
  input.oninput = check;
  input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
  ok.onclick = commit;

  check();
  input.focus();
  input.select();
  return done;
}

export interface ConfirmOptions {
  title: string;
  body: string;
  confirmLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

/** Ask a yes/no. Resolves true only on the confirm button — every dismissal path is false. */
export function confirmAction(opts: ConfirmOptions): Promise<boolean> {
  const { host, done, settle } = promptShell<boolean>(false);

  const title = document.createElement('h3');
  title.textContent = opts.title;
  const body = document.createElement('p');
  body.className = 'body';
  body.textContent = opts.body;

  const actions = document.createElement('div');
  actions.className = 'sp-modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'sp-btn';
  cancel.textContent = 'Cancel';
  cancel.onclick = () => settle(false);
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.className = `sp-btn ${opts.danger ? 'danger' : 'accent'}`;
  ok.textContent = opts.confirmLabel ?? 'OK';
  ok.onclick = () => settle(true);
  actions.append(cancel, ok);

  host.append(title, body, actions);
  cancel.focus();  // destructive default is Cancel, so Enter cannot delete anything
  return done;
}
