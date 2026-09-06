import { installStyles } from './styles';

/**
 * Tiny reusable tooltip lib: an instant, styled hover bubble that replaces the native title="",
 * which lags ~0.7s and renders as an OS-default box. Self-contained — it injects its own CSS and
 * shares one floating node, so any module can `tooltip(el, text)` with no extra markup or styles.
 */

let tipEl: HTMLDivElement | null = null;

const CSS = `
.sp-tip { position: fixed; z-index: 80; left: 0; top: -999px; pointer-events: none;
  max-width: 260px; padding: 6px 9px; border-radius: 6px; white-space: pre-line; /* honour \n for bulleted tips */
  background: #0e1a26; color: #eaf6ff; border: 1px solid #34506b;
  font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 6px 22px #000a;
  opacity: 0; transform: translateY(-3px); transition: opacity .09s ease, transform .09s ease; }
.sp-tip.wide { max-width: 340px; } /* long-form info-badge text reads better in fewer, longer lines */
.sp-tip.show { opacity: 1; transform: none; }
/* lil-gui disables pointer events on both a disabled controller and every child. A tooltip-bearing row keeps
   only its outer hit area alive; the disabled button/input children remain non-interactive. */
.lil-gui .lil-controller.sp-tip-anchor.lil-disabled { pointer-events: auto !important; }
`;

/** Lazily create (and style, once) the single shared bubble node. */
function node(): HTMLDivElement {
  installStyles('tooltip', CSS);
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'sp-tip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

export interface TooltipOptions {
  /** Preferred side of the anchor; flips automatically when there isn't room. Default 'bottom'. */
  placement?: 'top' | 'bottom';
  /** Wider bubble for long-form text (the info badge's explanations). */
  wide?: boolean;
}

function show(anchor: HTMLElement, text: string, opts: TooltipOptions) {
  const t = node();
  t.classList.toggle('wide', !!opts.wide);
  t.textContent = text; // set first so the measurements below reflect the real size
  const r = anchor.getBoundingClientRect();
  const w = t.offsetWidth, h = t.offsetHeight;
  const left = Math.max(6, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 6));
  // honour the preferred side unless it has no room and the other side does
  const prefBottom = (opts.placement ?? 'bottom') !== 'top';
  const roomBottom = r.bottom + h + 6 <= window.innerHeight;
  const roomTop = r.top - h - 6 >= 0;
  let onBottom = prefBottom;
  if (prefBottom && !roomBottom && roomTop) onBottom = false;
  else if (!prefBottom && !roomTop && roomBottom) onBottom = true;
  t.style.left = `${left}px`;
  t.style.top = onBottom ? `${r.bottom + 6}px` : `${r.top - h - 6}px`;
  t.classList.add('show'); // position before fading in so it never flashes at the old spot
}

function hide() {
  tipEl?.classList.remove('show');
}

/** Every attached anchor's show routine, so leaving a nested anchor (an info badge inside a tipped row)
 *  can hand the bubble back to the anchor the pointer is still over instead of leaving it blank. */
const anchors = new WeakMap<HTMLElement, () => void>();

/**
 * Attach an instant, styled hover tooltip to an element. Returns a detach function that removes the
 * listeners (handy when the element outlives the tooltip, e.g. a control that gets relabelled).
 */
export function tooltip(el: HTMLElement, text: string | (() => string), opts: TooltipOptions = {}): () => void {
  if (el.classList.contains('lil-controller')) el.classList.add('sp-tip-anchor');
  const onEnter = () => show(el, typeof text === 'function' ? text() : text, opts);
  anchors.set(el, onEnter);
  const onLeave = (e: MouseEvent) => {
    hide();
    // mouseenter does not refire on an ancestor the pointer never left, so re-show its tip explicitly
    for (let p = e.relatedTarget instanceof HTMLElement ? e.relatedTarget : null; p; p = p.parentElement) {
      const reshow = anchors.get(p);
      if (reshow) { reshow(); return; }
    }
  };
  el.addEventListener('mouseenter', onEnter);
  el.addEventListener('mouseleave', onLeave);
  el.addEventListener('click', hide); // don't let it linger over the control after it acts
  return () => {
    anchors.delete(el);
    el.removeEventListener('mouseenter', onEnter);
    el.removeEventListener('mouseleave', onLeave);
    el.removeEventListener('click', hide);
  };
}
