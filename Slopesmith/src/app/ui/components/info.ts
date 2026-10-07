import { installStyles } from './styles';
import { tooltip } from './tooltip';

/**
 * The shared "i" info chip: a small hover badge that carries a control's explanation, so help appears
 * only when asked for instead of springing up as the pointer crosses a panel. A row's chip leads with
 * the one-liner (what it does), then the detail — defaults, costs, when it applies. One look everywhere:
 * lil-gui rows, panel notes, dialog headings.
 */

const CSS = `
.sp-info { flex: 0 0 auto; cursor: help; width: 15px; height: 15px; border-radius: 50%;
  border: 1px solid #34506b; background: #15202c; color: #9fb3c8; font: 600 10px/1 system-ui, sans-serif;
  display: inline-flex; align-items: center; justify-content: center; vertical-align: middle;
  margin-left: 6px; user-select: none; }
.sp-info:hover { color: #cfe3f5; border-color: #4a6b8c; }
/* Nearly every panel row carries a chip, so it rests faint — a column of them should not read as noise —
   and comes up while the pointer is on its row, where the help is wanted. */
.lil-gui .lil-controller .sp-info { opacity: .45; transition: opacity .1s ease; }
.lil-gui .lil-controller:hover .sp-info { opacity: 1; }
/* lil-gui turns pointer events off on a disabled controller's children with !important; the chip's help
   still applies, and the higher-specificity selector wins whichever stylesheet lands second */
.lil-gui .lil-controller.lil-disabled .sp-info { pointer-events: auto !important; }
`;

/** A hoverable "i" chip explaining the control it sits beside. Append it wherever the layout wants it. */
export function infoBadge(text: string | (() => string)): HTMLSpanElement {
  installStyles('info-badge', CSS);
  const badge = document.createElement('span');
  badge.className = 'sp-info';
  badge.textContent = 'i';
  badge.setAttribute('role', 'note');
  badge.setAttribute('aria-label', typeof text === 'function' ? text() : text);
  tooltip(badge, text, { wide: true });
  return badge;
}
