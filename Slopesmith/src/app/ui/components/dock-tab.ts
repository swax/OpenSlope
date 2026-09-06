/**
 * The pull-up tab for a hidden bottom-dock library — a small handle centred on the bottom edge that names the
 * panel folded away below it and brings it back on a click.
 *
 * Both bottom libraries (Texture in Paint, Prop in Props) are hidden by default and close on their own ✕, and
 * the only way back up was a toggle in the right-hand Tools panel: findable once you know it, invisible until
 * then. The tab is that same intent stated where the panel actually lives, so the ✕ stops being a near
 * one-way door. It is deliberately the size of a handle rather than a bar — while it is up, the mode's whole
 * bottom edge is free for the viewport, which is the reason the panel was closed in the first place.
 *
 * The class is only the handle: WHEN it shows is the host's per-mode rule, which already decides the panel's
 * own visibility (tools-panel's `updatePaintUi` plus the two open-intent setters in main.ts).
 */
import { installStyles } from './styles';
import { tooltip } from './tooltip';

const css = `
.sp-docktab { position: fixed; left: 50%; bottom: 0; transform: translateX(-50%); z-index: 15;
  display: none; align-items: center; gap: 6px; padding: 5px 14px 6px;
  background: #0c141de8; border: 1px solid #2c3e50; border-bottom: 0; border-radius: 8px 8px 0 0;
  color: #9fb3c8; font: 600 12px system-ui, sans-serif; white-space: nowrap; cursor: pointer;
  box-shadow: 0 -2px 10px #0005; }
.sp-docktab.on { display: inline-flex; }
.sp-docktab:hover { background: #12202ef2; border-color: #6ee7a8; color: #eaf6ff; }
.sp-docktab svg { width: 13px; height: 13px; }
/* the caret is what says "this pulls up"; it keeps the accent colour whether or not the tab is hovered */
.sp-docktab-caret { color: #6ee7a8; font-size: 9px; line-height: 1; }
`;

export interface DockTabOptions {
  /** Inline SVG for the glyph, left of the label — the same one its Tools-panel toggle wears. */
  icon: string;
  /** What comes up, e.g. 'Texture Library'. */
  label: string;
  tip: string;
  /** The tab was clicked — the host opens the panel (and remembers it as open). */
  onOpen(): void;
}

export class DockTab {
  readonly el = document.createElement('button');

  constructor(opts: DockTabOptions) {
    installStyles('dock-tab', css);
    this.el.type = 'button';
    this.el.className = 'sp-docktab';
    this.el.innerHTML = `<span class="sp-docktab-caret">▲</span>${opts.icon}<span></span>`;
    this.el.lastElementChild!.textContent = opts.label;
    tooltip(this.el, opts.tip);
    this.el.onclick = () => opts.onOpen();
    document.body.appendChild(this.el);
  }

  setVisible(on: boolean) { this.el.classList.toggle('on', on); }
}
