import { installStyles } from '../ui/components/styles';

/**
 * The Props-mode multi-selection list: one row per box-selected prop, mounted in the Tools panel under the
 * preview card. Clicking a row IDENTIFIES its prop (a white flash box in 3D + the preview card), double-clicking
 * frames it, and the row's ✕ drops the prop from the selection (the prop itself stays placed). The host owns the
 * index set — this is just the list view; the delete-all / clear buttons live with the host's other Tools controls.
 */

const css = `
.ms-card { display: none; flex-direction: column; gap: 4px; margin: 2px 0 10px; padding: 8px 10px;
  background: #10202e; border: 1px solid #21384c; border-radius: 8px; }
.ms-card.on { display: flex; }
.ms-title { font: 600 12px system-ui, sans-serif; color: #cfe3f5; padding-bottom: 4px;
  border-bottom: 1px solid #21384c; }
.ms-list { display: flex; flex-direction: column; gap: 1px; max-height: 38vh; overflow-y: auto; }
.ms-row { display: flex; align-items: center; gap: 6px; padding: 3px 4px; border-radius: 4px; cursor: pointer; }
.ms-row:hover { background: #182c3d; }
.ms-row.active { background: #1d3a52; }
.ms-name { flex: 1 1 auto; min-width: 0; font: 11px system-ui, sans-serif; color: #9fb3c8;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ms-row.active .ms-name { color: #cfe3f5; }
/* the card lives inside lil-gui's children container, whose own "button" rules (display:block,
   width:100%, widget background) would swallow the ✕ — out-specific them */
.ms-card .ms-x { display: inline-block; flex: 0 0 16px; width: 16px; height: 16px; margin: 0; padding: 0;
  border: 0; border-radius: 4px; background: transparent; color: #567089;
  font: 11px/16px system-ui, sans-serif; text-align: center; cursor: pointer; }
.ms-card .ms-x:hover { background: #2a4258; color: #ff8d8d; }
.ms-hint { font: 10px system-ui, sans-serif; color: #567089; letter-spacing: .02em; }
`;

export class MultiSelectList {
  readonly el = document.createElement('div');
  private titleEl = document.createElement('div');
  private listEl = document.createElement('div');
  private activeIdx: number | null = null; // the last-identified prop's doc index (row highlight)

  constructor(private cb: { onIdentify(index: number): void; onFocus(index: number): void; onRemove(index: number): void }) {
    installStyles('prop-multi-select', css);
    this.el.className = 'ms-card';
    this.titleEl.className = 'ms-title';
    this.listEl.className = 'ms-list';
    const hint = document.createElement('div');
    hint.className = 'ms-hint';
    hint.textContent = 'click to find · double-click to frame · ✕ drops from set';
    this.el.append(this.titleEl, this.listEl, hint);
  }

  /** (Re)build the rows from the host's selection. Each item carries its DOC index (stable while the set
   *  lives — placements only re-index on delete, which rebuilds the whole selection). */
  show(items: { index: number; label: string }[]) {
    this.el.classList.add('on');
    this.titleEl.textContent = `${items.length} prop${items.length === 1 ? '' : 's'} selected`;
    if (this.activeIdx !== null && !items.some(it => it.index === this.activeIdx)) this.activeIdx = null;
    this.listEl.replaceChildren();
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'ms-row' + (it.index === this.activeIdx ? ' active' : '');
      const name = document.createElement('span');
      name.className = 'ms-name';
      name.textContent = it.label;
      name.title = it.label;
      const x = document.createElement('button');
      x.className = 'ms-x';
      x.textContent = '✕';
      x.title = 'remove from selection (keeps the prop)';
      x.onclick = ev => { ev.stopPropagation(); this.cb.onRemove(it.index); };
      row.onclick = event => {
        this.activeIdx = it.index;
        for (const r of this.listEl.children) r.classList.toggle('active', r === row);
        this.cb.onIdentify(it.index);
        if (event.detail > 1) this.cb.onFocus(it.index);
      };
      row.append(name, x);
      this.listEl.appendChild(row);
    }
  }

  hide() {
    this.el.classList.remove('on');
    this.activeIdx = null;
  }
}
