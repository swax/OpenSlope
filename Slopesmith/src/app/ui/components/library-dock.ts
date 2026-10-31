import { installStyles } from './styles';
import { tooltip } from './tooltip';

const css = `
.sp-library-dock { position: fixed; left: 0; right: calc(var(--side-w, 300px) + 8px); bottom: 0;
  height: min(250px, 75dvh); max-height: calc(100dvh - var(--bar-h, 46px) - 28px);
  box-sizing: border-box; overflow: hidden; z-index: 16; flex-direction: column; }
.sp-library-dock.sp-library-expanded { height: 75dvh; }
.sp-library-size { display: inline-flex; align-items: center; gap: 4px;
  background: #15202c; border: 1px solid #34506b; border-radius: 4px; color: #cfe3f5;
  padding: 3px 7px; font: inherit; font-size: 11px; white-space: nowrap; cursor: pointer; }
.sp-library-size:hover { background: #25425c; border-color: #6ee7a8; }
.sp-library-size:focus-visible { outline: 2px solid #6ee7a8; outline-offset: 2px; }
/* Match the compact toolbox layout: the library takes the full width and sits above the tools. */
@media (max-width: 760px), (max-height: 500px) {
  .sp-library-dock { right: 0; z-index: 21; }
}
`;

/** Both asset libraries share their screen footprint and remember their size while hidden or changing modes. */
export function librarySizeButton(panel: HTMLElement, label: string, onHeightChange?: () => void): HTMLButtonElement {
  installStyles('library-dock', css);
  panel.classList.add('sp-library-dock');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sp-library-size';
  button.setAttribute('aria-controls', panel.id);
  let expanded = false;
  const sync = () => {
    button.textContent = expanded ? '↧ Shrink' : '↥ Expand';
    button.setAttribute('aria-label', `${expanded ? 'Shrink' : 'Expand'} ${label}`);
    button.setAttribute('aria-expanded', String(expanded));
  };
  tooltip(button, () =>
    expanded ? 'Return to the compact library.' : 'Expand the library to three quarters of the screen.',
  );
  button.onclick = () => {
    expanded = !expanded;
    panel.classList.toggle('sp-library-expanded', expanded);
    sync();
  };
  // Viewport changes also resize the tall view; keep the help overlays and collapse handle above its edge.
  new ResizeObserver(() => {
    if (panel.offsetHeight > 0) onHeightChange?.();
  }).observe(panel);
  sync();
  return button;
}
