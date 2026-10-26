/**
 * A persistent handle for a bottom-dock library. It sits at the screen edge when collapsed and follows the
 * panel's top edge while expanded, so the same button opens and closes the library.
 *
 * The class is only the handle: WHEN it shows is the host's per-mode rule, which already decides the panel's
 * own visibility (tools-panel's `updatePaintUi` plus the two open-intent setters in main.ts).
 */
import { installStyles } from './styles';
import { tooltip } from './tooltip';

const css = `
.sp-docktab { position: fixed; left: 50%; bottom: 0; transform: translateX(-50%); z-index: 17;
  display: none; align-items: center; gap: 6px; padding: 5px 14px 6px;
  background: #0c141de8; border: 1px solid #2c3e50; border-bottom: 0; border-radius: 8px 8px 0 0;
  color: #9fb3c8; font: 600 12px system-ui, sans-serif; white-space: nowrap; cursor: pointer;
  box-shadow: 0 -2px 10px #0005; }
.sp-docktab.on { display: inline-flex; }
.sp-docktab:hover { background: #12202ef2; border-color: #6ee7a8; color: #eaf6ff; }
.sp-docktab svg { width: 13px; height: 13px; }
/* The caret points toward the next action: up to open, down to collapse. */
.sp-docktab-caret { color: #6ee7a8; font-size: 9px; line-height: 1; }
`;

export interface DockTabOptions {
  /** Element id — what the headset's wrist EDIT palette follows to show the tab upright beside the toolbox
   *  (docs/068). */
  id: string;
  /** Inline SVG for the glyph, left of the label — the same one its Tools-panel toggle wears. */
  icon: string;
  /** What comes up, e.g. 'Texture Library'. */
  label: string;
  panel: HTMLElement;
  tip: string;
  /** The tab was clicked — the host applies and remembers the requested open state. */
  onToggle(open: boolean): void;
}

export class DockTab {
  readonly el = document.createElement('button');
  private expanded = false;

  constructor(private opts: DockTabOptions) {
    installStyles('dock-tab', css);
    this.el.type = 'button';
    this.el.id = opts.id;
    this.el.className = 'sp-docktab';
    this.el.innerHTML = `<span class="sp-docktab-caret">▲</span>${opts.icon}<span></span>`;
    this.el.lastElementChild!.textContent = opts.label;
    this.el.setAttribute('aria-controls', opts.panel.id);
    tooltip(this.el, () => (this.expanded ? `Collapse ${opts.label}.` : opts.tip));
    this.el.onclick = () => opts.onToggle(!this.expanded);
    document.body.appendChild(this.el);
    new ResizeObserver(() => this.syncPanel()).observe(opts.panel);
    window.addEventListener('resize', () => this.syncPanel());
    this.syncPanel();
  }

  private syncPanel() {
    const box = this.opts.panel.getBoundingClientRect();
    this.expanded = box.height > 0;
    this.el.style.bottom = `${this.expanded ? Math.max(0, window.innerHeight - box.top) : 0}px`;
    this.el.style.left = this.expanded ? `${box.left + box.width / 2}px` : '';
    this.el.setAttribute('aria-expanded', String(this.expanded));
    this.el.setAttribute('aria-label', `${this.expanded ? 'Collapse' : 'Open'} ${this.opts.label}`);
    this.el.firstElementChild!.textContent = this.expanded ? '▼' : '▲';
  }

  setVisible(on: boolean) {
    this.el.classList.toggle('on', on);
    this.syncPanel();
  }
}
