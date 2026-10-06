/**
 * Folding headers for the lower-corner panels — the colour keys and the controls help (`.ll-panel`). A panel's
 * title is a button that folds the panel down to itself, with a caret that says which way it is; this browser
 * remembers each panel's fold by an id, across reloads and across the re-renders the controls help goes through
 * on every mode and selection change. A per-viewer convenience, so plain localStorage, guarded.
 */

const STORAGE_KEY = 'slopesmith-legends-collapsed-v1';

function loadFolds(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
}

function saveFold(id: string, folded: boolean) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...loadFolds(), [id]: folded })); } catch { /* storage full / disabled */ }
}

/** A panel title as its folding header; `id` names the panel in the remembered folds. */
export function foldHeader(title: string, id: string): string {
  return `<button type="button" class="ll-title" data-fold="${id}" aria-expanded="true">`
    + `<span class="ll-caret" aria-hidden="true">▾</span>${title}</button>`;
}

/** Fold or open `panel` as its header's id was last left (open when it has no folding header). */
export function refold(panel: HTMLElement) {
  const header = panel.querySelector<HTMLElement>('[data-fold]');
  const folded = !!header && !!loadFolds()[header.dataset.fold!];
  panel.classList.toggle('ll-collapsed', folded);
  if (!header) return;
  header.setAttribute('aria-expanded', String(!folded));
  header.title = folded ? 'Show this panel' : 'Fold this panel to its title';
}

/** Let `panel`'s header fold it. One listener on the panel itself, so a header rendered into it later — the
 *  controls help replaces its contents whenever the mode or selection changes — works too. */
export function foldOnClick(panel: HTMLElement) {
  panel.addEventListener('click', event => {
    const header = (event.target as Element | null)?.closest<HTMLElement>('[data-fold]');
    if (!header || !panel.contains(header)) return;
    saveFold(header.dataset.fold!, !panel.classList.contains('ll-collapsed'));
    refold(panel);
  });
}
