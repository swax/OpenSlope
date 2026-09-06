import { BRIDGE_RAIL_COLORS } from '../../viewport/constants';
import { installStyles } from './styles';

/** Ordered rail list for Bridge Builder. The host owns the runs; this card only emits list edits. */
const css = `
.br-card { display:none; flex-direction:column; gap:4px; margin:2px 0 8px; padding:8px 10px;
  background:#10202e; border:1px solid #21384c; border-radius:8px; }
.br-card.on { display:flex; }
.br-title { font:600 12px system-ui,sans-serif; color:#cfe3f5; padding-bottom:4px; border-bottom:1px solid #21384c; }
.br-list { display:flex; flex-direction:column; gap:2px; }
.br-row { display:flex; align-items:center; gap:6px; min-height:25px; padding:2px 4px; border-radius:4px;
  background:#142738; cursor:grab; }
.br-row:hover,.br-row.over { background:#1d3a52; }
.br-row.dragging { opacity:.45; }
.br-grip { color:#567089; font:12px system-ui,sans-serif; }
.br-dot { width:9px; height:9px; flex:0 0 9px; border-radius:50%; box-shadow:0 0 5px currentColor; }
.br-name { flex:1 1 auto; min-width:0; font:11px system-ui,sans-serif; color:#b7cbe0; white-space:nowrap; }
.br-card button.br-action { display:inline-block; flex:0 0 auto; width:auto; height:19px; margin:0; padding:0 5px;
  border:0; border-radius:4px; background:#20384c; color:#8fa9bf; font:10px/19px system-ui,sans-serif; cursor:pointer; }
.br-card button.br-action:hover { background:#2a4a63; color:#e4f2ff; }
.br-card button.br-remove { width:19px; padding:0; color:#718ba2; }
.br-card button.br-remove:hover { color:#ff8d8d; }
.br-hint { font:10px system-ui,sans-serif; color:#567089; letter-spacing:.01em; }
`;

export class BridgeRailList {
  readonly el = document.createElement('div');
  private titleEl = document.createElement('div');
  private listEl = document.createElement('div');

  constructor(private cb: { onReverse(index: number): void; onRemove(index: number): void; onMove(from: number, to: number): void }) {
    installStyles('bridge-rail-list', css);
    this.el.className = 'br-card';
    this.titleEl.className = 'br-title';
    this.listEl.className = 'br-list';
    const hint = document.createElement('div');
    hint.className = 'br-hint';
    hint.textContent = 'drag to reorder · arrow shows direction';
    this.el.append(this.titleEl, this.listEl, hint);
  }

  show(rails: readonly (readonly number[])[]) {
    this.el.classList.add('on');
    this.titleEl.textContent = `Rails · ${rails.length}`;
    this.listEl.replaceChildren();
    rails.forEach((rail, index) => {
      const row = document.createElement('div');
      row.className = 'br-row';
      row.draggable = true;
      row.dataset.index = String(index);
      row.ondragstart = ev => {
        row.classList.add('dragging');
        ev.dataTransfer?.setData('text/plain', String(index));
        if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
      };
      row.ondragend = () => row.classList.remove('dragging');
      row.ondragover = ev => { ev.preventDefault(); row.classList.add('over'); };
      row.ondragleave = () => row.classList.remove('over');
      row.ondrop = ev => {
        ev.preventDefault(); row.classList.remove('over');
        const from = Number(ev.dataTransfer?.getData('text/plain'));
        if (Number.isInteger(from) && from !== index) this.cb.onMove(from, index);
      };

      const grip = document.createElement('span');
      grip.className = 'br-grip'; grip.textContent = '⋮⋮';
      const dot = document.createElement('span');
      dot.className = 'br-dot';
      const color = BRIDGE_RAIL_COLORS[index % BRIDGE_RAIL_COLORS.length].toString(16).padStart(6, '0');
      dot.style.color = dot.style.background = `#${color}`;
      const name = document.createElement('span');
      name.className = 'br-name';
      name.textContent = `${index + 1}  ${rail.length} vertices  →`;
      const reverse = document.createElement('button');
      reverse.className = 'br-action'; reverse.textContent = 'reverse'; reverse.title = 'Reverse this rail direction';
      reverse.onclick = () => this.cb.onReverse(index);
      const remove = document.createElement('button');
      remove.className = 'br-action br-remove'; remove.textContent = '✕'; remove.title = 'Remove this rail from the bridge';
      remove.onclick = () => this.cb.onRemove(index);
      row.append(grip, dot, name, reverse, remove);
      this.listEl.appendChild(row);
    });
  }

  hide() { this.el.classList.remove('on'); }
}
