import './game-actions.css';
import { element } from './dom';

/** Library action dropdown with shared keyboard handling and viewport-bounded placement. */
export function createActionMenu(
  buttons: HTMLButtonElement[],
  options: { label: string; name: string; className: string; iconOnly?: boolean },
) {
  const el = element('details', `library-actions-menu ${options.className}`);
  const trigger = element('summary', '');
  trigger.setAttribute('role', 'button');
  trigger.setAttribute('aria-expanded', 'false');
  const text = element('span', '', options.label);
  if (options.iconOnly) text.setAttribute('aria-hidden', 'true');
  trigger.append(text);
  if (!options.iconOnly) {
    const arrow = element('span', '', '▾');
    arrow.setAttribute('aria-hidden', 'true');
    trigger.append(arrow);
  }
  const panel = element('div', 'library-actions-menu-panel');
  panel.setAttribute('role', 'group');
  panel.append(...buttons);
  el.append(trigger, panel);
  function setName(name: string, title = name) {
    trigger.setAttribute('aria-label', name);
    trigger.title = title;
    panel.setAttribute('aria-label', name);
  }
  setName(options.name);
  let listening = false;
  function listen(active: boolean) {
    if (listening === active) return;
    listening = active;
    if (active) {
      document.addEventListener('pointerdown', dismissOutside);
      document.addEventListener('focusin', dismissOutside);
      window.addEventListener('scroll', dismissScroll, true);
      window.addEventListener('resize', dismissResize);
    } else {
      document.removeEventListener('pointerdown', dismissOutside);
      document.removeEventListener('focusin', dismissOutside);
      window.removeEventListener('scroll', dismissScroll, true);
      window.removeEventListener('resize', dismissResize);
    }
  }
  function close(focus = false) {
    el.open = false;
    trigger.setAttribute('aria-expanded', 'false');
    listen(false);
    if (focus) trigger.focus({ preventScroll: true });
  }
  function position() {
    const rect = trigger.getBoundingClientRect();
    panel.style.left = `${Math.max(8, Math.min(rect.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - panel.offsetHeight - 8))}px`;
  }
  trigger.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    el.open = !el.open;
    trigger.setAttribute('aria-expanded', String(el.open));
    listen(el.open);
    if (el.open) position();
  });
  el.addEventListener('toggle', () => {
    trigger.setAttribute('aria-expanded', String(el.open));
    listen(el.open);
    if (el.open) position();
  });
  el.addEventListener('keydown', event => {
    if (event.key === 'Escape' && el.open) {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === 'ArrowDown' && event.target === trigger) {
      event.preventDefault();
      el.open = true;
      trigger.setAttribute('aria-expanded', 'true');
      listen(true);
      position();
      panel.querySelector<HTMLButtonElement>('button:not([hidden]):not(:disabled)')?.focus({ preventScroll: true });
    }
  });
  panel.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('button')) {
      event.stopPropagation();
      // A synchronous action may already have focused a confirmation dialog. Keep that focus;
      // otherwise return to the trigger before hiding the menu's focused button.
      close(panel.contains(document.activeElement));
    }
  });
  const dismissOutside = (event: Event) => {
    if (el.open && event.target instanceof Node && !el.contains(event.target)) close();
  };
  const dismissScroll = (event: Event) => {
    if (!(event.target instanceof Node) || !panel.contains(event.target)) close();
  };
  const dismissResize = () => close();
  return {
    el,
    panel,
    close,
    setName,
    dispose() {
      close();
    },
  };
}

/** Selected-game disc actions, kept beside its heading. */
export function createGameActionsMenu(buttons: HTMLButtonElement[]) {
  const menu = createActionMenu(buttons, {
    label: '⋯',
    name: 'Game actions',
    className: 'library-game-actions',
    iconOnly: true,
  });
  return {
    ...menu,
    setGameName(name: string) {
      menu.setName(`Game actions for ${name}`, `${name} actions`);
    },
  };
}
