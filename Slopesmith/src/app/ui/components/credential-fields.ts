import type { Controller } from 'lil-gui';

/**
 * The pieces a username-and-password form is made of (docs/038).
 *
 * Shared by the login page, which is the whole document before anybody is signed in, and by the account
 * dialog inside the editor, which changes a password. Both are the same form in different frames, and a
 * password field that is a password field in one of them and a plain text box in the other is exactly the
 * kind of difference that survives review.
 */

/** A short explanation above a form, in the shape the file-menu dialogs use. */
export function banner(host: HTMLElement, text: string, tone: 'info' | 'warn' = 'info'): HTMLElement {
  const el = document.createElement('div');
  el.className = 'sp-modal-note';
  el.style.cssText = 'padding:8px 10px;margin-bottom:6px;font-size:12px;line-height:1.45;border-radius:4px;'
    + (tone === 'warn' ? 'color:#f0d9cf;background:#3a2a26;border-left:3px solid #c2543a;'
      : 'color:#cdd6e3;background:#2a2f3a;border-left:3px solid #3a6ea5;');
  el.textContent = text;
  host.insertBefore(el, host.firstChild);
  return el;
}

/** Why the last attempt was refused, in the server's own words — the part of a refusal an author can act on.
 *  A live region, because on the login page the refusal is the only thing that changes on the screen. */
export function errorLine(host: HTMLElement): (message: string) => void {
  const el = document.createElement('div');
  el.setAttribute('role', 'alert');
  el.style.cssText = 'padding:0 2px;margin:6px 0 0;color:#f0a89c;font-size:11px;line-height:1.45;min-height:15px;';
  host.appendChild(el);
  // A refusal describes the values that were submitted, not the form after somebody starts correcting it.
  host.addEventListener('input', () => { el.textContent = ''; });
  return message => { el.textContent = message; };
}

/** lil-gui renders a string field as a text input; a password is the same field the browser must not show,
 *  autofill into the wrong box, or offer as a suggestion from another site. */
export function secret(controller: Controller, autocomplete: string): Controller {
  const input = controller.domElement.querySelector<HTMLInputElement>('input');
  if (input) { input.type = 'password'; input.setAttribute('autocomplete', autocomplete); }
  return controller;
}

export function named(controller: Controller, autocomplete: string): Controller {
  controller.domElement.querySelector<HTMLInputElement>('input')?.setAttribute('autocomplete', autocomplete);
  return controller;
}

/** Put the caret in a form's first field. On the login page there is nothing else on the screen to click, so
 *  a page that opens with nothing focused asks for a mouse before it can be typed into. */
export function focusField(controller: Controller): Controller {
  controller.domElement.querySelector<HTMLInputElement>('input')?.focus();
  return controller;
}

/** Enter submits, because a two-field form that only responds to a mouse is a form people fight.
 *  lil-gui stops keyboard events at its own root, so this must listen on the capture phase above it. */
export function submitOnEnter(host: HTMLElement, submit: () => void): void {
  host.addEventListener('keydown', event => {
    const input = event.target as HTMLInputElement | null;
    if (event.key !== 'Enter' || event.isComposing || input?.tagName !== 'INPUT') return;
    event.preventDefault();
    input.blur();
    submit();
  }, true);
}
