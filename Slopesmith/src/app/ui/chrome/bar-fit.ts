import { closeMenu, group, panelMenu } from '../components/controls';
import { tooltip } from '../components/tooltip';

/**
 * Fits the top dock to the window instead of letting it scroll sideways. The bar starts whole every time it
 * is measured, then gives things up in the order its owner lists them — cheapest loss first — until the row
 * fits: a caption, a word traded for its glyph, then whole groups folded behind a trigger that lists them as
 * labelled rows. Measured rather than set at breakpoints, so a long username or the accountless Settings
 * button costs exactly its own width. The bar's sideways scroll remains only below the narrowest fold.
 *
 * Folding moves the real controls, so their highlights, enabled states and tooltips keep working wherever
 * they sit, and the host's repaints reach them unchanged.
 */

export type BarFitStep =
  /** A class for the bar; the stylesheet owns what it trades away (a caption, a word for its glyph). */
  | { compact: string }
  /** Move a bar group into a fold's panel. */
  | { fold: HTMLElement; into: BarFold };

export interface BarFold {
  /** The group holding the trigger. It sits in the bar where the folded groups' row ends, hidden while empty. */
  el: HTMLElement;
  trigger: HTMLButtonElement;
  /** The folded groups, in bar order. */
  list: HTMLElement;
}

/** A fold-away trigger and its panel. `heading` titles the panel — the caption its groups lose in the bar. */
export function barFold(opts: { label: string; icon: string; heading: string; title?: () => string; closeOnPick?: boolean }): BarFold {
  const trigger = document.createElement('button');
  trigger.className = 'sp-btn sp-menu-btn sp-bar-fold';
  trigger.innerHTML = opts.icon;
  trigger.setAttribute('aria-label', opts.label);
  tooltip(trigger, opts.title ?? opts.label);
  const heading = document.createElement('div');
  heading.className = 'sp-menu-group';
  heading.textContent = opts.heading;
  const list = document.createElement('div');
  const content = document.createElement('div');
  content.className = 'sp-fold-panel';
  content.append(heading, list);
  panelMenu(trigger, content, { closeOnPick: opts.closeOnPick });
  const el = group(trigger);
  el.hidden = true;
  return { el, trigger, list };
}

/**
 * Keep `bar` fitted from now on: on every resize, on content the bar gains or relabels (the account menu
 * arrives after the bar is built), and once its images and fonts have loaded.
 *
 * While the headset's wrist palette shows the bar (docs/068) nothing folds: the palette mirrors the bar's own
 * strips, and a panel opened from a folded trigger is not part of any of them.
 */
export function fitBar(bar: HTMLElement, steps: readonly BarFitStep[]): void {
  const homes = new Map<HTMLElement, Comment>();
  for (const step of steps) {
    if (!('fold' in step)) continue;
    const home = document.createComment('');
    step.fold.before(home);
    homes.set(step.fold, home);
  }
  const barOrder = [...homes.keys()].sort((a, b) =>
    homes.get(a)!.compareDocumentPosition(homes.get(b)!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  const folds = [...new Set(steps.flatMap(step => 'fold' in step ? [step.into] : []))];
  const xrEditing = () => document.body.classList.contains('os-xr-editing');
  const overflows = () => bar.scrollWidth > bar.clientWidth;

  const mutations = new MutationObserver(schedule);
  let queued = 0, given = -1, givenInXr = false;
  function schedule() {
    if (!queued) queued = requestAnimationFrame(() => { queued = 0; fit(); });
  }
  function fit() {
    // Whole again, in bar order...
    for (const step of steps) {
      if ('compact' in step) bar.classList.remove(step.compact);
      else homes.get(step.fold)!.after(step.fold);
    }
    for (const fold of folds) fold.el.hidden = true;
    // ...then the cheapest losses first, until the row fits.
    const inXr = xrEditing();
    let count = 0;
    for (const step of steps) {
      if (!overflows()) break;
      if ('compact' in step) bar.classList.add(step.compact);
      else if (inXr) continue;
      else { step.into.el.hidden = false; step.into.list.append(step.fold); }
      count++;
    }
    for (const fold of folds) {
      fold.list.replaceChildren(...barOrder.filter(el => el.parentElement === fold.list));
    }
    // An open menu was placed against the old row; one listing groups that just moved is stale too.
    if (count !== given || inXr !== givenInXr) closeMenu();
    given = count; givenInXr = inXr;
    mutations.takeRecords(); // our own moves are not new content
  }

  mutations.observe(bar, { childList: true, subtree: true, characterData: true });
  new ResizeObserver(fit).observe(bar);
  new MutationObserver(() => { if (xrEditing() !== givenInXr) schedule(); })
    .observe(document.body, { attributes: true, attributeFilter: ['class'] });
  bar.addEventListener('load', schedule, true); // the brand mark has no width until its image arrives
  void document.fonts?.ready.then(schedule);
  fit();
}
